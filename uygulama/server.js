const express = require('express');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cookieParser());

const ortakDbAyar = {
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_KULLANICI || 'yemekhane_app',
  password: process.env.DB_SIFRE || 'Uyg_2026',
  database: process.env.DB_ADI || 'yemekhane',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  timezone: '+03:00'
};

const yazmaHavuzu = mysql.createPool({
  ...ortakDbAyar,
  host: process.env.DB_YAZMA_HOST || 'mysql-primary'
});

const okumaHavuzu = mysql.createPool({
  ...ortakDbAyar,
  host: process.env.DB_OKUMA_HOST || 'mysql-replica'
});

async function okumaSorgusu(sql, params = []) {
  try {
    const [satirlar] = await okumaHavuzu.execute(sql, params);
    return { satirlar, kaynak: 'mysql-replica' };
  } catch (err) {
    console.warn('Replica okuma hatası, primary üzerinden okunuyor:', err.code);
    const [satirlar] = await yazmaHavuzu.execute(sql, params);
    return { satirlar, kaynak: 'mysql-primary (fallback)' };
  }
}

const redis = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT || 6379)
  }
});
redis.on('error', (err) => console.error('Redis hatası:', err.message));
redis.connect().catch(console.error);

const OTURUM_SURESI = 60 * 30; // 30 dakika (her istekte yenilenir)

function gunSonunaKalanSaniye() {
  const simdi = new Date();
  const gunSonu = new Date(simdi.getFullYear(), simdi.getMonth(), simdi.getDate(), 23, 59, 59);
  const fark = Math.floor((gunSonu.getTime() - simdi.getTime()) / 1000);
  return fark > 60 ? fark : 3600;
}

async function menuCacheTemizle(filtre = 'menu:*') {
  try {
    const anahtarlar = await redis.keys(filtre);
    if (anahtarlar.length > 0) {
      await redis.del(anahtarlar);
      console.log(`[REDIS INVALIDATE] Silinen anahtarlar: ${anahtarlar.join(', ')}`);
    }
  } catch (e) {
    console.warn('Cache temizleme uyarısı:', e.message);
  }
}

function hataMesaji(err) {
  if (err && err.sqlState === '45000' && err.sqlMessage) {
    return err.sqlMessage;
  }
  if (err && err.code === 'ER_DUP_ENTRY') {
    return 'Bu kayıt zaten mevcut.';
  }
  return err.message || 'Beklenmeyen bir sunucu hatası oluştu.';
}

async function oturumKontrol(req, res, next) {
  const token = req.cookies?.oturum_token || req.headers['x-oturum-token'];
  if (!token) {
    return res.status(401).json({ hata: 'Oturum açmanız gerekiyor.' });
  }
  try {
    const anahtar = `oturum:${token}`;
    const veri = await redis.get(anahtar);
    if (!veri) {
      return res.status(401).json({ hata: 'Oturum süreniz dolmuş, lütfen tekrar giriş yapın.' });
    }
    await redis.expire(anahtar, OTURUM_SURESI);
    res.cookie('oturum_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: OTURUM_SURESI * 1000,
      path: '/'
    });
    req.kullanici = JSON.parse(veri);
    req.oturumToken = token;
    next();
  } catch (err) {
    res.status(500).json({ hata: 'Oturum doğrulanamadı.' });
  }
}

function yoneticiKontrol(req, res, next) {
  if (req.kullanici?.rol !== 'yonetici') {
    return res.status(403).json({ hata: 'Bu işlem için yönetici yetkisi gerekiyor.' });
  }
  next();
}

app.get('/api/', async (req, res) => {
  res.json({
    durum: 'calisiyor',
    servis: 'yemekhane-uygulama',
    zaman: new Date().toISOString()
  });
});

app.post('/api/giris', async (req, res) => {
  const { eposta, sifre } = req.body || {};
  if (!eposta || !sifre) {
    return res.status(400).json({ hata: 'E-posta ve şifre zorunludur.' });
  }
  try {
    const [satirlar] = await yazmaHavuzu.execute(
      'SELECT id, ad, soyad, eposta, sifre_hash, rol, ogrenci_no, bakiye, aktif FROM kullanicilar WHERE eposta = ? LIMIT 1',
      [eposta.trim()]
    );
    const k = satirlar[0];
    if (!k) {
      return res.status(401).json({ hata: 'E-posta veya şifre hatalı.' });
    }
    if (!k.aktif) {
      return res.status(403).json({ hata: 'Hesabınız pasif durumdadır.' });
    }

    const gecerli = await bcrypt.compare(sifre, k.sifre_hash);
    if (!gecerli) {
      return res.status(401).json({ hata: 'E-posta veya şifre hatalı.' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const oturumVerisi = {
      id: k.id,
      ad: k.ad,
      soyad: k.soyad,
      eposta: k.eposta,
      rol: k.rol,
      ogrenci_no: k.ogrenci_no
    };

    await redis.setEx(`oturum:${token}`, OTURUM_SURESI, JSON.stringify(oturumVerisi));
    console.log(`[OTURUM OLUSTURULDU] oturum:${token} (TTL: ${OTURUM_SURESI}sn)`);

    res.cookie('oturum_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: OTURUM_SURESI * 1000,
      path: '/'
    });

    res.json({
      mesaj: 'Giriş başarılı.',
      kullanici: { ...oturumVerisi, bakiye: Number(k.bakiye) }
    });
  } catch (err) {
    res.status(500).json({ hata: hataMesaji(err) });
  }
});

app.post('/api/cikis', async (req, res) => {
  const token = req.cookies?.oturum_token;
  if (token) {
    await redis.del(`oturum:${token}`).catch(() => {});
    console.log(`[OTURUM SILINDI] oturum:${token}`);
  }
  res.clearCookie('oturum_token', { path: '/' });
  res.json({ mesaj: 'Çıkış yapıldı.' });
});

app.get('/api/ben', oturumKontrol, async (req, res) => {
  try {
    const [satirlar] = await yazmaHavuzu.execute(
      'SELECT id, ad, soyad, eposta, rol, ogrenci_no, bakiye, aktif FROM kullanicilar WHERE id = ?',
      [req.kullanici.id]
    );
    if (!satirlar[0]) {
      return res.status(404).json({ hata: 'Kullanıcı bulunamadı.' });
    }
    const k = satirlar[0];
    const [alerjenler] = await yazmaHavuzu.execute(
      'SELECT alerjen_id FROM kullanici_alerjenleri WHERE kullanici_id = ? ORDER BY alerjen_id',
      [req.kullanici.id]
    );
    res.json({
      kullanici: {
        ...k,
        bakiye: Number(k.bakiye),
        alerjen_idler: alerjenler.map((a) => Number(a.alerjen_id))
      }
    });
  } catch (err) {
    res.status(500).json({ hata: hataMesaji(err) });
  }
});

app.get('/api/profil/alerjenler', oturumKontrol, async (req, res) => {
  try {
    const [satirlar] = await yazmaHavuzu.execute(
      'SELECT alerjen_id FROM kullanici_alerjenleri WHERE kullanici_id = ? ORDER BY alerjen_id',
      [req.kullanici.id]
    );
    res.json({ alerjen_idler: satirlar.map((s) => Number(s.alerjen_id)) });
  } catch (err) {
    res.status(500).json({ hata: hataMesaji(err) });
  }
});

app.put('/api/profil/alerjenler', oturumKontrol, async (req, res) => {
  const liste = Array.isArray(req.body?.alerjen_idler) ? req.body.alerjen_idler.map(Number) : [];
  const conn = await yazmaHavuzu.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM kullanici_alerjenleri WHERE kullanici_id = ?', [req.kullanici.id]);
    for (const alId of liste) {
      if (Number.isInteger(alId) && alId > 0) {
        await conn.execute(
          'INSERT INTO kullanici_alerjenleri (kullanici_id, alerjen_id) VALUES (?, ?)',
          [req.kullanici.id, alId]
        );
      }
    }
    await conn.commit();
    res.json({ mesaj: 'Alerjen tercihleriniz güncellendi.', alerjen_idler: liste });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ hata: hataMesaji(err) });
  } finally {
    conn.release();
  }
});

app.get('/api/meta', oturumKontrol, async (req, res) => {
  try {
    const yh = await okumaSorgusu('SELECT id, ad, konum, kapasite FROM yemekhaneler ORDER BY id');
    const og = await okumaSorgusu('SELECT id, ad, sira, son_saat, servis_baslangic, servis_bitis FROM ogunler ORDER BY sira');
    const al = await okumaSorgusu('SELECT id, ad FROM alerjenler ORDER BY id');
    res.json({
      yemekhaneler: yh.satirlar,
      ogunler: og.satirlar,
      alerjenler: al.satirlar
    });
  } catch (err) {
    res.status(500).json({ hata: hataMesaji(err) });
  }
});

app.get('/api/menuler', oturumKontrol, async (req, res) => {
  const tarih = req.query.tarih || new Date().toISOString().slice(0, 10);
  const yemekhaneId = req.query.yemekhane_id || 'hepsi';

  try {
    const yhListesi = yemekhaneId === 'hepsi' ? [1, 2] : [Number(yemekhaneId)];
    const ogunListesi = [1, 2, 3];
    const cacheMenuler = [];
    let eksikVar = false;

    for (const yhId of yhListesi) {
      for (const ogId of ogunListesi) {
        const key = `menu:${yhId}:${tarih}:${ogId}`;
        const kayit = await redis.get(key).catch(() => null);
        if (kayit) {
          const parsed = JSON.parse(kayit);
          if (parsed) cacheMenuler.push(parsed);
        } else {
          eksikVar = true;
        }
      }
    }

    let menuler = [];
    let kaynak = 'redis-cache';

    if (!eksikVar) {
      menuler = cacheMenuler;
      console.log(`[MENU CACHE HIT] Redis'ten okundu -> tarih=${tarih}, yemekhane=${yemekhaneId}`);
    } else {
      let sql = 'SELECT * FROM v_menu_detay WHERE tarih = ?';
      const params = [tarih];
      if (yemekhaneId !== 'hepsi') {
        sql += ' AND yemekhane_id = ?';
        params.push(Number(yemekhaneId));
      }
      sql += ' ORDER BY yemekhane_id, ogun_sira, kategori_sira, yemek';

      const sonuc = await okumaSorgusu(sql, params);
      kaynak = sonuc.kaynak;
      console.log(`[MENU DB MISS] Veritabanindan (${kaynak}) okundu -> tarih=${tarih}, yemekhane=${yemekhaneId}`);

      const dolulukSonuc = await okumaSorgusu('SELECT * FROM v_menu_doluluk WHERE tarih = ?', [tarih]);
      const puanSonuc = await okumaSorgusu('SELECT * FROM v_menu_puan');

      const dolulukMap = new Map(dolulukSonuc.satirlar.map((d) => [d.menu_id, d]));
      const puanMap = new Map(puanSonuc.satirlar.map((p) => [p.menu_id, p]));

      const menuMap = new Map();
      for (const s of sonuc.satirlar) {
        if (!menuMap.has(s.menu_id)) {
          const dol = dolulukMap.get(s.menu_id) || {};
          const puan = puanMap.get(s.menu_id) || {};
          menuMap.set(s.menu_id, {
            menu_id: s.menu_id,
            tarih: s.tarih,
            yemekhane_id: s.yemekhane_id,
            yemekhane: s.yemekhane,
            ogun_id: s.ogun_id,
            ogun: s.ogun,
            ogun_sira: s.ogun_sira,
            rezervasyon_son: s.rezervasyon_son,
            ogrenci_fiyati: Number(s.ogrenci_fiyati),
            personel_fiyati: Number(s.personel_fiyati),
            yarim_porsiyon_uygun: Number(s.ogun_id) !== 1,
            kapasite: dol.kapasite ?? 0,
            rezerve: dol.rezerve ?? 0,
            bos_yer: dol.bos_yer ?? 0,
            doluluk_yuzde: Number(dol.doluluk_yuzde ?? 0),
            oy_sayisi: puan.oy_sayisi ?? 0,
            ortalama_puan: puan.ortalama_puan ? Number(puan.ortalama_puan) : null,
            toplam_kalori: 0,
            yemekler: []
          });
        }
        const m = menuMap.get(s.menu_id);
        m.toplam_kalori += Number(s.kalori || 0);
        m.yemekler.push({
          yemek_id: s.yemek_id,
          yemek: s.yemek,
          kategori: s.kategori,
          kalori: s.kalori,
          vejetaryen: Boolean(s.vejetaryen),
          alerjenler: s.alerjenler || '',
          alerjen_idler: s.alerjen_idler ? String(s.alerjen_idler).split(',').map(Number) : []
        });
      }

      menuler = Array.from(menuMap.values());
      const ttl = gunSonunaKalanSaniye();
      for (const yhId of yhListesi) {
        for (const ogId of ogunListesi) {
          const eslesen = menuler.find((x) => x.yemekhane_id === yhId && x.ogun_id === ogId) || null;
          const key = `menu:${yhId}:${tarih}:${ogId}`;
          await redis.setEx(key, ttl, JSON.stringify(eslesen)).catch(() => {});
        }
      }
    }

    const [rezler] = await yazmaHavuzu.execute(
      'SELECT id, menu_id, durum, porsiyon FROM rezervasyonlar WHERE kullanici_id = ?',
      [req.kullanici.id]
    );
    const rezMap = new Map(rezler.map((r) => [r.menu_id, r]));

    const zenginMenuler = menuler.map((m) => ({
      ...m,
      yarim_porsiyon_uygun: Number(m.ogun_id) !== 1,
      kullanici_rezervasyon: rezMap.get(m.menu_id) || null
    }));

    res.set('X-Veri-Kaynagi', kaynak);
    res.json({ tarih, kaynak, menuler: zenginMenuler });
  } catch (err) {
    res.status(500).json({ hata: hataMesaji(err) });
  }
});

app.get('/api/rezervasyonlar', oturumKontrol, async (req, res) => {
  try {
    const [satirlar] = await yazmaHavuzu.execute(
      `SELECT r.id, r.menu_id, r.durum, r.porsiyon, r.ucret, r.olusturma, r.kullanma_zamani, r.iptal_zamani,
              m.tarih, yh.ad AS yemekhane, o.ad AS ogun, o.son_saat,
              TIMESTAMP(m.tarih, o.son_saat) AS rezervasyon_son,
              d.id AS degerlendirme_id, d.puan AS kullanici_puan, d.yorum AS kullanici_yorum
         FROM rezervasyonlar r
         JOIN menuler m ON m.id = r.menu_id
         JOIN yemekhaneler yh ON yh.id = m.yemekhane_id
         JOIN ogunler o ON o.id = m.ogun_id
         LEFT JOIN degerlendirmeler d ON d.menu_id = r.menu_id AND d.kullanici_id = r.kullanici_id
        WHERE r.kullanici_id = ?
        ORDER BY m.tarih DESC, o.sira ASC`,
      [req.kullanici.id]
    );
    res.json({ rezervasyonlar: satirlar });
  } catch (err) {
    res.status(500).json({ hata: hataMesaji(err) });
  }
});

app.post('/api/rezervasyonlar', oturumKontrol, async (req, res) => {
  const { menu_id, porsiyon } = req.body || {};
  if (!menu_id) {
    return res.status(400).json({ hata: 'Menü seçilmedi.' });
  }
  const secilenPorsiyon = porsiyon === 'yarim' ? 'yarim' : 'tam';
  try {
    const [sonuc] = await yazmaHavuzu.execute('CALL sp_rezervasyon_yap(?, ?, ?)', [
      req.kullanici.id,
      Number(menu_id),
      secilenPorsiyon
    ]);
    await menuCacheTemizle();
    const satir = sonuc[0][0];
    res.status(201).json({
      mesaj: `Rezervasyon (${satir.porsiyon === 'yarim' ? 'Yarım Porsiyon' : 'Tam Porsiyon'}) başarıyla oluşturuldu.`,
      rezervasyon_id: satir.rezervasyon_id,
      porsiyon: satir.porsiyon,
      ucret: Number(satir.ucret),
      bakiye: Number(satir.bakiye)
    });
  } catch (err) {
    res.status(400).json({ hata: hataMesaji(err) });
  }
});

app.post('/api/rezervasyonlar/:id/iptal', oturumKontrol, async (req, res) => {
  const rezId = Number(req.params.id);
  try {
    const [sonuc] = await yazmaHavuzu.execute('CALL sp_rezervasyon_iptal(?, ?)', [
      req.kullanici.id,
      rezId
    ]);
    await menuCacheTemizle();
    const satir = sonuc[0][0];
    res.json({
      mesaj: 'Rezervasyon iptal edildi ve ücret iade edildi.',
      rezervasyon_id: satir.rezervasyon_id,
      iade: Number(satir.iade),
      bakiye: Number(satir.bakiye)
    });
  } catch (err) {
    res.status(400).json({ hata: hataMesaji(err) });
  }
});

app.get('/api/bakiye', oturumKontrol, async (req, res) => {
  try {
    const [[k]] = await yazmaHavuzu.execute('SELECT bakiye FROM kullanicilar WHERE id = ?', [req.kullanici.id]);
    const [hareketler] = await yazmaHavuzu.execute(
      'SELECT id, tur, tutar, rezervasyon_id, aciklama, olusturma FROM bakiye_hareketleri WHERE kullanici_id = ? ORDER BY olusturma DESC, id DESC LIMIT 50',
      [req.kullanici.id]
    );
    res.json({ bakiye: Number(k.bakiye), hareketler });
  } catch (err) {
    res.status(500).json({ hata: hataMesaji(err) });
  }
});

app.post('/api/bakiye/yukle', oturumKontrol, async (req, res) => {
  const tutar = Number(req.body?.tutar);
  try {
    const [sonuc] = await yazmaHavuzu.execute('CALL sp_bakiye_yukle(?, ?)', [
      req.kullanici.id,
      tutar
    ]);
    const satir = sonuc[0][0];
    res.json({
      mesaj: `${tutar.toFixed(2)} TL bakiye yüklendi.`,
      hareket_id: satir.hareket_id,
      bakiye: Number(satir.bakiye)
    });
  } catch (err) {
    res.status(400).json({ hata: hataMesaji(err) });
  }
});

app.post('/api/degerlendirmeler', oturumKontrol, async (req, res) => {
  const { menu_id, puan, yorum } = req.body || {};
  const puanSayi = Number(puan);
  if (!menu_id || !Number.isInteger(puanSayi) || puanSayi < 1 || puanSayi > 5) {
    return res.status(400).json({ hata: 'Puan 1 ile 5 arasında tam sayı olmalıdır.' });
  }
  try {
    const [rez] = await yazmaHavuzu.execute(
      "SELECT id FROM rezervasyonlar WHERE kullanici_id = ? AND menu_id = ? AND durum = 'kullanildi' LIMIT 1",
      [req.kullanici.id, Number(menu_id)]
    );
    if (rez.length === 0) {
      return res.status(400).json({ hata: 'Yalnızca kullandığınız öğünleri değerlendirebilirsiniz.' });
    }

    await yazmaHavuzu.execute(
      `INSERT INTO degerlendirmeler (kullanici_id, menu_id, puan, yorum)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE puan = VALUES(puan), yorum = VALUES(yorum)`,
      [req.kullanici.id, Number(menu_id), puanSayi, yorum ? String(yorum).trim().slice(0, 500) : null]
    );
    await menuCacheTemizle();
    res.json({ mesaj: 'Değerlendirmeniz kaydedildi.' });
  } catch (err) {
    res.status(400).json({ hata: hataMesaji(err) });
  }
});

app.post('/api/turnike', oturumKontrol, async (req, res) => {
  const { kullanici_id, yemekhane_id, zaman } = req.body || {};
  const hedefKullaniciId = req.kullanici.rol === 'yonetici' && kullanici_id
    ? Number(kullanici_id)
    : req.kullanici.id;

  if (!yemekhane_id) {
    return res.status(400).json({ hata: 'Yemekhane seçilmelidir.' });
  }

  try {
    const [sonuc] = await yazmaHavuzu.execute('CALL sp_turnike_gecis(?, ?, ?)', [
      hedefKullaniciId,
      Number(yemekhane_id),
      zaman ? String(zaman).replace('T', ' ') : null
    ]);
    await menuCacheTemizle();
    const satir = sonuc[0][0];
    res.json({
      mesaj: `Turnike geçişi onaylandı (${satir.ogun}). Afiyet olsun!`,
      rezervasyon_id: satir.rezervasyon_id,
      menu_id: satir.menu_id,
      ogun: satir.ogun
    });
  } catch (err) {
    res.status(400).json({ hata: hataMesaji(err) });
  }
});

app.get('/api/yonetim/ozet', oturumKontrol, yoneticiKontrol, async (req, res) => {
  const tarih = req.query.tarih || new Date().toISOString().slice(0, 10);
  try {
    const doluluk = await okumaSorgusu('SELECT * FROM v_menu_doluluk WHERE tarih = ? ORDER BY yemekhane_id, ogun_id', [tarih]);
    const yemekler = await okumaSorgusu(
      `SELECT y.id, y.ad, y.kalori, y.vejetaryen, k.ad AS kategori
         FROM yemekler y JOIN yemek_kategorileri k ON k.id = y.kategori_id
        ORDER BY k.sira, y.ad`
    );
    const kullanicilar = await okumaSorgusu(
      'SELECT id, ad, soyad, eposta, rol, ogrenci_no, bakiye, aktif FROM kullanicilar ORDER BY id'
    );
    const yorumlar = await okumaSorgusu(
      `SELECT d.id, d.puan, d.yorum, d.olusturma, u.ad, u.soyad, m.tarih, yh.ad AS yemekhane, o.ad AS ogun
         FROM degerlendirmeler d
         JOIN kullanicilar u ON u.id = d.kullanici_id
         JOIN menuler m ON m.id = d.menu_id
         JOIN yemekhaneler yh ON yh.id = m.yemekhane_id
         JOIN ogunler o ON o.id = m.ogun_id
        ORDER BY d.olusturma DESC LIMIT 30`
    );

    res.json({
      tarih,
      doluluk: doluluk.satirlar,
      yemekler: yemekler.satirlar,
      kullanicilar: kullanicilar.satirlar,
      yorumlar: yorumlar.satirlar
    });
  } catch (err) {
    res.status(500).json({ hata: hataMesaji(err) });
  }
});

app.post('/api/yonetim/menuler', oturumKontrol, yoneticiKontrol, async (req, res) => {
  const { yemekhane_id, tarih, ogun_id, ogrenci_fiyati, personel_fiyati, yemek_idler } = req.body || {};
  if (!yemekhane_id || !tarih || !ogun_id || !Array.isArray(yemek_idler) || yemek_idler.length === 0) {
    return res.status(400).json({ hata: 'Yemekhane, tarih, öğün ve en az bir yemek seçilmelidir.' });
  }

  const conn = await yazmaHavuzu.getConnection();
  try {
    await conn.beginTransaction();
    const [ekle] = await conn.execute(
      `INSERT INTO menuler (yemekhane_id, tarih, ogun_id, ogrenci_fiyati, personel_fiyati)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         ogrenci_fiyati = VALUES(ogrenci_fiyati),
         personel_fiyati = VALUES(personel_fiyati),
         id = LAST_INSERT_ID(id)`,
      [Number(yemekhane_id), tarih, Number(ogun_id), Number(ogrenci_fiyati || 25), Number(personel_fiyati || 50)]
    );
    const menuId = ekle.insertId;

    await conn.execute('DELETE FROM menu_yemekleri WHERE menu_id = ?', [menuId]);
    for (const yId of yemek_idler) {
      await conn.execute('INSERT INTO menu_yemekleri (menu_id, yemek_id) VALUES (?, ?)', [menuId, Number(yId)]);
    }

    await conn.commit();
    await menuCacheTemizle(`menu:${Number(yemekhane_id)}:${tarih}:${Number(ogun_id)}`);
    res.status(201).json({ mesaj: 'Menü kaydedildi ve önbellek güncellendi.', menu_id: menuId });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ hata: hataMesaji(err) });
  } finally {
    conn.release();
  }
});

app.patch('/api/yonetim/kullanicilar/:id/aktif', oturumKontrol, yoneticiKontrol, async (req, res) => {
  const hedefId = Number(req.params.id);
  const aktif = req.body?.aktif ? 1 : 0;
  try {
    await yazmaHavuzu.execute('UPDATE kullanicilar SET aktif = ? WHERE id = ?', [aktif, hedefId]);
    res.json({ mesaj: 'Kullanıcı durumu güncellendi.' });
  } catch (err) {
    res.status(400).json({ hata: hataMesaji(err) });
  }
});

const PORT = Number(process.env.PORT || 8000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Yemekhane uygulama servisi ${PORT} portunda çalışıyor.`);
});
