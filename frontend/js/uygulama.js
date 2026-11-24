let aktifKullanici = null;
let metaVeri = { yemekhaneler: [], ogunler: [], alerjenler: [] };
let sonMenuler = [];

const bugunStr = () => new Date().toISOString().slice(0, 10);

function bildirimGoster(mesaj, tur = 'basari') {
  const kutu = document.getElementById('genel-bildirim');
  kutu.textContent = mesaj;
  kutu.className = `bildirim ${tur === 'hata' ? 'bildirim-hata' : 'bildirim-basari'}`;
  kutu.classList.remove('gizli');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bildirimGizle() {
  document.getElementById('genel-bildirim').classList.add('gizli');
}

async function apiIstek(url, secenekler = {}) {
  const ayar = {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    ...secenekler
  };
  const yanit = await fetch(url, ayar);
  const veri = await yanit.json().catch(() => ({}));
  if (!yanit.ok) {
    throw new Error(veri.hata || `Sunucu hatası (${yanit.status})`);
  }
  return veri;
}

function bakiyeGuncelle(yeniBakiye) {
  if (aktifKullanici) {
    aktifKullanici.bakiye = Number(yeniBakiye);
    document.getElementById('kullanici-bakiye').textContent = `${aktifKullanici.bakiye.toFixed(2)} TL`;
  }
}

async function oturumKontrolEt() {
  try {
    const veri = await apiIstek('/api/ben');
    girisSonrasiHazirla(veri.kullanici);
  } catch {
    document.getElementById('ekran-giris').classList.remove('gizli');
    document.getElementById('ust-cubuk').classList.add('gizli');
    document.getElementById('uygulama-alani').classList.add('gizli');
  }
}

async function girisSonrasiHazirla(kullanici) {
  aktifKullanici = kullanici;
  if (!Array.isArray(aktifKullanici.alerjen_idler)) {
    const alVeri = await apiIstek('/api/profil/alerjenler').catch(() => ({ alerjen_idler: [] }));
    aktifKullanici.alerjen_idler = alVeri.alerjen_idler || [];
  }

  document.getElementById('ekran-giris').classList.add('gizli');
  document.getElementById('ust-cubuk').classList.remove('gizli');
  document.getElementById('uygulama-alani').classList.remove('gizli');

  document.getElementById('kullanici-ad').textContent = `${kullanici.ad} ${kullanici.soyad}`;
  document.getElementById('kullanici-rol').textContent = kullanici.rol;
  bakiyeGuncelle(kullanici.bakiye);

  const yonetimBtn = document.getElementById('yonetim-sekme-btn');
  const turnikeYonetici = document.getElementById('turnike-yonetici-alan');
  if (kullanici.rol === 'yonetici') {
    yonetimBtn.classList.remove('gizli');
    turnikeYonetici.classList.remove('gizli');
  } else {
    yonetimBtn.classList.add('gizli');
    turnikeYonetici.classList.add('gizli');
  }

  metaVeri = await apiIstek('/api/meta');
  metaSecenekleriDoldur();
  profilAlerjenleriniCiz();

  document.getElementById('filtre-tarih').value = bugunStr();
  document.getElementById('yonetim-tarih').value = bugunStr();
  document.getElementById('ym-tarih').value = bugunStr();

  await menuleriYukle();
}

function metaSecenekleriDoldur() {
  const fYh = document.getElementById('filtre-yemekhane');
  const tYh = document.getElementById('turnike-yemekhane');
  const ymYh = document.getElementById('ym-yemekhane');

  fYh.innerHTML = '<option value="hepsi">Tüm Yemekhaneler</option>';
  tYh.innerHTML = '';
  ymYh.innerHTML = '';

  for (const yh of metaVeri.yemekhaneler) {
    const opt = `<option value="${yh.id}">${yh.ad} (Kapasite: ${yh.kapasite})</option>`;
    fYh.insertAdjacentHTML('beforeend', opt);
    tYh.insertAdjacentHTML('beforeend', opt);
    ymYh.insertAdjacentHTML('beforeend', opt);
  }

  const fAl = document.getElementById('filtre-alerjen');
  fAl.innerHTML = '<option value="">Alerjen Filtresi Yok</option>';
  for (const al of metaVeri.alerjenler) {
    fAl.insertAdjacentHTML('beforeend', `<option value="${al.id}">${al.ad} İçermeyenler</option>`);
  }

  const ymOg = document.getElementById('ym-ogun');
  ymOg.innerHTML = '';
  for (const og of metaVeri.ogunler) {
    ymOg.insertAdjacentHTML('beforeend', `<option value="${og.id}">${og.ad}</option>`);
  }
}

function profilAlerjenleriniCiz() {
  const ozet = document.getElementById('profil-ozet');
  if (ozet && aktifKullanici) {
    ozet.textContent = `${aktifKullanici.ad} ${aktifKullanici.soyad} · ${aktifKullanici.eposta} (${aktifKullanici.rol})`;
  }
  const kutu = document.getElementById('profil-alerjen-listesi');
  if (!kutu) return;
  const seciliSet = new Set((aktifKullanici?.alerjen_idler || []).map(Number));
  kutu.innerHTML = metaVeri.alerjenler.map((al) => `
    <label class="onay-kutu" style="padding: 0.45rem 0.6rem; border: 1px solid var(--cizgi); border-radius: 6px;">
      <input type="checkbox" name="profil_alerjen" value="${al.id}" ${seciliSet.has(Number(al.id)) ? 'checked' : ''}>
      <span>${al.ad}</span>
    </label>
  `).join('');
}

async function menuleriYukle() {
  const tarih = document.getElementById('filtre-tarih').value || bugunStr();
  const yhId = document.getElementById('filtre-yemekhane').value;
  try {
    const veri = await apiIstek(`/api/menuler?tarih=${encodeURIComponent(tarih)}&yemekhane_id=${encodeURIComponent(yhId)}`);
    sonMenuler = veri.menuler;
    document.getElementById('veri-kaynagi-bilgi').textContent = `Veri kaynağı: ${veri.kaynak}`;
    menuleriCiz();
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
}

window.porsiyonFiyatGuncelle = function(menuId, tamFiyat) {
  const secim = document.getElementById(`porsiyon-${menuId}`);
  const btn = document.getElementById(`rez-btn-${menuId}`);
  if (!secim || !btn) return;
  const tutar = secim.value === 'yarim' ? Number((tamFiyat * 0.60).toFixed(2)) : Number(tamFiyat);
  btn.textContent = `Rezervasyon Yap (${tutar.toFixed(2)} TL)`;
};

function menuleriCiz() {
  const kapsayici = document.getElementById('menu-listesi');
  const haricAlerjen = Number(document.getElementById('filtre-alerjen').value || 0);
  const sadeceVej = document.getElementById('filtre-vejetaryen').checked;
  const kullaniciAlerjenSet = new Set((aktifKullanici?.alerjen_idler || []).map(Number));
  const alerjenAdMap = new Map(metaVeri.alerjenler.map((a) => [Number(a.id), a.ad]));

  kapsayici.innerHTML = '';
  if (!sonMenuler.length) {
    kapsayici.innerHTML = '<div class="kart"><p>Seçilen tarih ve yemekhane için kayıtlı menü bulunamadı.</p></div>';
    return;
  }

  for (const m of sonMenuler) {
    const tamFiyat = Number(aktifKullanici.rol === 'ogrenci' ? m.ogrenci_fiyati : m.personel_fiyati);
    const yarimFiyat = Number((tamFiyat * 0.60).toFixed(2));
    const yarimUygun = Number(m.ogun_id) !== 1;
    const sonZaman = new Date(m.rezervasyon_son);
    const sureDoldu = new Date() >= sonZaman;
    const rez = m.kullanici_rezervasyon;

    let butonHtml = '';
    if (rez && rez.durum === 'aktif') {
      const porsiyonMetin = rez.porsiyon === 'yarim' ? 'Yarım Porsiyon' : 'Tam Porsiyon';
      butonHtml = `<span class="etiket etiket-durum">Rezervasyonunuz Aktif (${porsiyonMetin})</span>`;
    } else if (rez && rez.durum === 'kullanildi') {
      butonHtml = `<span class="etiket etiket-vej">Öğün Kullanıldı</span>`;
    } else if (sureDoldu) {
      butonHtml = `<button type="button" class="dugme" disabled>Rezervasyon Süresi Doldu</button>`;
    } else if (m.bos_yer <= 0) {
      butonHtml = `<button type="button" class="dugme" disabled>Kapasite Dolu</button>`;
    } else {
      const porsiyonSeciciHtml = yarimUygun
        ? `<div style="margin-bottom: 0.5rem;">
             <select id="porsiyon-${m.menu_id}" onchange="porsiyonFiyatGuncelle(${m.menu_id}, ${tamFiyat})" style="width: 100%; padding: 0.35rem;">
               <option value="tam">Tam Porsiyon (${tamFiyat.toFixed(2)} TL)</option>
               <option value="yarim">Yarım Porsiyon - %60 (${yarimFiyat.toFixed(2)} TL)</option>
             </select>
           </div>`
        : `<div style="margin-bottom: 0.5rem; font-size: var(--boyut-kucuk); color: var(--metin-soluk);">
             Kahvaltıda yalnızca tam porsiyon sunulur.
             <input type="hidden" id="porsiyon-${m.menu_id}" value="tam">
           </div>`;

      butonHtml = `
        ${porsiyonSeciciHtml}
        <button type="button" id="rez-btn-${m.menu_id}" class="dugme" onclick="rezervasyonYap(${m.menu_id})">Rezervasyon Yap (${tamFiyat.toFixed(2)} TL)</button>
      `;
    }

    const yemeklerHtml = m.yemekler.map((y) => {
      const alerjenVar = haricAlerjen && y.alerjen_idler.includes(haricAlerjen);
      const vejGizle = sadeceVej && !y.vejetaryen;
      if (alerjenVar || vejGizle) return '';

      const eslesenAlerjenler = (y.alerjen_idler || [])
        .filter((id) => kullaniciAlerjenSet.has(Number(id)))
        .map((id) => alerjenAdMap.get(Number(id)))
        .filter(Boolean);

      const uyariRozet = eslesenAlerjenler.length > 0
        ? `<span class="etiket" style="background:#fee2e2; color:#991b1b; border:1px solid #ef4444; font-weight:600;">⚠️ Alerjen Uyarısı: ${eslesenAlerjenler.join(', ')}</span>`
        : '';

      return `
        <li class="yemek-satir" ${eslesenAlerjenler.length > 0 ? 'style="background:#fff5f5; border-left:3px solid #dc2626; padding-left:0.5rem;"' : ''}>
          <div class="yemek-ust">
            <span><strong>${y.yemek}</strong> <small style="color:var(--metin-soluk)">(${y.kategori})</small></span>
            <span>${y.kalori} kcal</span>
          </div>
          <div>
            ${uyariRozet}
            ${y.vejetaryen ? '<span class="etiket etiket-vej">Vejetaryen</span>' : ''}
            ${y.alerjenler ? `<span class="etiket etiket-alerjen">Alerjen: ${y.alerjenler}</span>` : ''}
          </div>
        </li>
      `;
    }).join('');

    const kartHtml = `
      <article class="kart">
        <div class="menu-baslik">
          <div>
            <h3>${m.ogun}</h3>
            <small style="color:var(--metin-soluk)">${m.yemekhane} · Son: ${String(m.rezervasyon_son).slice(11, 16)}</small>
          </div>
          <span class="fiyat-etiket">${tamFiyat.toFixed(2)} TL</span>
        </div>

        <ul class="yemek-listesi">
          ${yemeklerHtml || '<li class="yemek-satir">Seçilen filtrelere uygun yemek yok.</li>'}
        </ul>

        <div class="doluluk-kutu">
          <div style="display:flex; justify-content:space-between;">
            <span>Toplam: <strong>${m.toplam_kalori} kcal</strong> · Puan: <strong>${m.ortalama_puan ? m.ortalama_puan + '/5' : 'Yok'}</strong></span>
            <span>Boş Yer: <strong>${m.bos_yer} / ${m.kapasite}</strong></span>
          </div>
          <div class="doluluk-cubuk">
            <div class="doluluk-dolu" style="width:${Math.min(100, m.doluluk_yuzde)}%"></div>
          </div>
        </div>

        <div>${butonHtml}</div>
      </article>
    `;
    kapsayici.insertAdjacentHTML('beforeend', kartHtml);
  }
}

window.rezervasyonYap = async function(menuId) {
  bildirimGizle();
  const porsiyonEl = document.getElementById(`porsiyon-${menuId}`);
  const porsiyon = porsiyonEl ? porsiyonEl.value : 'tam';
  try {
    const veri = await apiIstek('/api/rezervasyonlar', {
      method: 'POST',
      body: JSON.stringify({ menu_id: menuId, porsiyon })
    });
    bakiyeGuncelle(veri.bakiye);
    bildirimGoster(veri.mesaj, 'basari');
    await menuleriYukle();
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
};

async function rezervasyonlariYukle() {
  const tbody = document.getElementById('rezervasyon-tablo');
  try {
    const veri = await apiIstek('/api/rezervasyonlar');
    tbody.innerHTML = '';
    if (!veri.rezervasyonlar.length) {
      tbody.innerHTML = '<tr><td colspan="6">Henüz rezervasyonunuz bulunmuyor.</td></tr>';
      return;
    }

    for (const r of veri.rezervasyonlar) {
      const tarihKisa = String(r.tarih).slice(0, 10);
      const sonZaman = new Date(r.rezervasyon_son);
      const iptalEdilebilir = r.durum === 'aktif' && new Date() < sonZaman;
      const porsiyonLabel = r.porsiyon === 'yarim' ? 'Yarım (%60)' : 'Tam';

      let islemHtml = '-';
      if (iptalEdilebilir) {
        islemHtml = `<button type="button" class="dugme dugme-kucuk dugme-tehlike" onclick="rezervasyonIptal(${r.id})">İptal Et</button>`;
      } else if (r.durum === 'kullanildi') {
        const mevcutPuan = r.kullanici_puan ? `Puanınız: ${r.kullanici_puan}/5 · ` : '';
        islemHtml = `${mevcutPuan}<button type="button" class="dugme dugme-kucuk" onclick="degerlendirmeAc(${r.menu_id}, '${tarihKisa} ${r.ogun}', ${r.kullanici_puan || 5}, '${(r.kullanici_yorum || '').replace(/'/g, "\\'")}')">Değerlendir</button>`;
      }

      tbody.insertAdjacentHTML('beforeend', `
        <tr>
          <td><strong>${tarihKisa}</strong> · ${r.ogun}</td>
          <td>${r.yemekhane}</td>
          <td>${porsiyonLabel}</td>
          <td>${Number(r.ucret).toFixed(2)} TL</td>
          <td><span class="etiket etiket-durum">${r.durum}</span></td>
          <td>${islemHtml}</td>
        </tr>
      `);
    }
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
}

window.rezervasyonIptal = async function(rezId) {
  bildirimGizle();
  try {
    const veri = await apiIstek(`/api/rezervasyonlar/${rezId}/iptal`, { method: 'POST' });
    bakiyeGuncelle(veri.bakiye);
    bildirimGoster(veri.mesaj, 'basari');
    await rezervasyonlariYukle();
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
};

window.degerlendirmeAc = function(menuId, baslik, puan, yorum) {
  document.getElementById('deg-menu-id').value = menuId;
  document.getElementById('deg-baslik').textContent = `Değerlendir: ${baslik}`;
  document.getElementById('deg-puan').value = puan;
  document.getElementById('deg-yorum').value = yorum;
  document.getElementById('degerlendirme-kutu').classList.remove('gizli');
};

async function bakiyeHareketleriniYukle() {
  const tbody = document.getElementById('hareket-tablo');
  try {
    const veri = await apiIstek('/api/bakiye');
    bakiyeGuncelle(veri.bakiye);
    tbody.innerHTML = '';
    for (const h of veri.hareketler) {
      const tutar = Number(h.tutar);
      const sinif = tutar >= 0 ? 'tutar-arti' : 'tutar-eksi';
      tbody.insertAdjacentHTML('beforeend', `
        <tr>
          <td>${String(h.olusturma).replace('T', ' ').slice(0, 16)}</td>
          <td>${h.tur}</td>
          <td>${h.aciklama || '-'}</td>
          <td class="${sinif}">${tutar >= 0 ? '+' : ''}${tutar.toFixed(2)} TL</td>
        </tr>
      `);
    }
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
}

async function yonetimYukle() {
  if (aktifKullanici?.rol !== 'yonetici') return;
  const tarih = document.getElementById('yonetim-tarih').value || bugunStr();
  try {
    const veri = await apiIstek(`/api/yonetim/ozet?tarih=${encodeURIComponent(tarih)}`);

    const dTablo = document.getElementById('yonetim-doluluk-tablo');
    dTablo.innerHTML = veri.doluluk.map((d) => `
      <tr>
        <td>${d.yemekhane}</td>
        <td>${d.ogun}</td>
        <td>${d.kapasite}</td>
        <td>${d.rezerve}</td>
        <td>${d.bos_yer}</td>
        <td>%${d.doluluk_yuzde}</td>
      </tr>
    `).join('') || '<tr><td colspan="6">Kayıt yok.</td></tr>';

    const ymSelect = document.getElementById('ym-yemekler');
    if (!ymSelect.options.length) {
      ymSelect.innerHTML = veri.yemekler.map((y) =>
        `<option value="${y.id}">[${y.kategori}] ${y.ad} (${y.kalori} kcal)</option>`
      ).join('');
    }

    const kTablo = document.getElementById('yonetim-kullanici-tablo');
    kTablo.innerHTML = veri.kullanicilar.map((k) => `
      <tr>
        <td>${k.id}</td>
        <td>${k.ad} ${k.soyad}</td>
        <td>${k.eposta}</td>
        <td>${k.rol}</td>
        <td>${Number(k.bakiye).toFixed(2)} TL</td>
        <td>
          <button type="button" class="dugme dugme-kucuk ${k.aktif ? '' : 'dugme-tehlike'}"
            onclick="kullaniciDurumDegistir(${k.id}, ${k.aktif ? 0 : 1})">
            ${k.aktif ? 'Aktif' : 'Pasif'}
          </button>
        </td>
      </tr>
    `).join('');

    const yTablo = document.getElementById('yonetim-yorum-tablo');
    yTablo.innerHTML = veri.yorumlar.map((y) => `
      <tr>
        <td>${String(y.tarih).slice(0, 10)} · ${y.ogun}</td>
        <td>${y.yemekhane}</td>
        <td>${y.ad} ${y.soyad}</td>
        <td><strong>${y.puan}/5</strong></td>
        <td>${y.yorum || '-'}</td>
      </tr>
    `).join('') || '<tr><td colspan="5">Henüz yorum yok.</td></tr>';
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
}

window.kullaniciDurumDegistir = async function(id, aktif) {
  try {
    const veri = await apiIstek(`/api/yonetim/kullanicilar/${id}/aktif`, {
      method: 'PATCH',
      body: JSON.stringify({ aktif })
    });
    bildirimGoster(veri.mesaj, 'basari');
    await yonetimYukle();
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
};

document.getElementById('giris-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  bildirimGizle();
  try {
    const veri = await apiIstek('/api/giris', {
      method: 'POST',
      body: JSON.stringify({
        eposta: document.getElementById('giris-eposta').value,
        sifre: document.getElementById('giris-sifre').value
      })
    });
    await girisSonrasiHazirla(veri.kullanici);
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
});

document.querySelectorAll('[data-hizli]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById('giris-eposta').value = btn.dataset.hizli;
    document.getElementById('giris-sifre').value = 'Yemek2026!';
  });
});

document.getElementById('cikis-btn').addEventListener('click', async () => {
  await apiIstek('/api/cikis', { method: 'POST' }).catch(() => {});
  aktifKullanici = null;
  bildirimGizle();
  oturumKontrolEt();
});

document.querySelectorAll('.sekme-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    bildirimGizle();
    document.querySelectorAll('.sekme-btn').forEach((b) => b.classList.remove('aktif'));
    btn.classList.add('aktif');

    document.querySelectorAll('.sekme-icerik').forEach((s) => s.classList.add('gizli'));
    const hedef = btn.dataset.sekme;
    document.getElementById(`sekme-${hedef}`).classList.remove('gizli');

    if (hedef === 'menuler') await menuleriYukle();
    if (hedef === 'rezervasyonlar') await rezervasyonlariYukle();
    if (hedef === 'bakiye') await bakiyeHareketleriniYukle();
    if (hedef === 'profil') profilAlerjenleriniCiz();
    if (hedef === 'yonetim') await yonetimYukle();
  });
});

document.getElementById('filtre-tarih').addEventListener('change', menuleriYukle);
document.getElementById('filtre-yemekhane').addEventListener('change', menuleriYukle);
document.getElementById('filtre-alerjen').addEventListener('change', menuleriCiz);
document.getElementById('filtre-vejetaryen').addEventListener('change', menuleriCiz);

document.getElementById('profil-alerjen-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  bildirimGizle();
  const secili = Array.from(document.querySelectorAll('input[name="profil_alerjen"]:checked')).map((el) => Number(el.value));
  try {
    const veri = await apiIstek('/api/profil/alerjenler', {
      method: 'PUT',
      body: JSON.stringify({ alerjen_idler: secili })
    });
    aktifKullanici.alerjen_idler = veri.alerjen_idler;
    bildirimGoster(veri.mesaj, 'basari');
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
});

document.getElementById('bakiye-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  bildirimGizle();
  try {
    const veri = await apiIstek('/api/bakiye/yukle', {
      method: 'POST',
      body: JSON.stringify({ tutar: Number(document.getElementById('yukleme-tutar').value) })
    });
    bakiyeGuncelle(veri.bakiye);
    bildirimGoster(veri.mesaj, 'basari');
    await bakiyeHareketleriniYukle();
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
});

document.getElementById('degerlendirme-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  bildirimGizle();
  try {
    const veri = await apiIstek('/api/degerlendirmeler', {
      method: 'POST',
      body: JSON.stringify({
        menu_id: Number(document.getElementById('deg-menu-id').value),
        puan: Number(document.getElementById('deg-puan').value),
        yorum: document.getElementById('deg-yorum').value
      })
    });
    document.getElementById('degerlendirme-kutu').classList.add('gizli');
    bildirimGoster(veri.mesaj, 'basari');
    await rezervasyonlariYukle();
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
});

document.getElementById('deg-iptal-btn').addEventListener('click', () => {
  document.getElementById('degerlendirme-kutu').classList.add('gizli');
});

document.getElementById('turnike-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  bildirimGizle();
  try {
    const veri = await apiIstek('/api/turnike', {
      method: 'POST',
      body: JSON.stringify({
        yemekhane_id: Number(document.getElementById('turnike-yemekhane').value),
        zaman: document.getElementById('turnike-zaman').value || null,
        kullanici_id: document.getElementById('turnike-kullanici-id').value || null
      })
    });
    bildirimGoster(veri.mesaj, 'basari');
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
});

document.getElementById('yonetim-tarih').addEventListener('change', yonetimYukle);

document.getElementById('yonetim-menu-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  bildirimGizle();
  const seciliYemekler = Array.from(document.getElementById('ym-yemekler').selectedOptions).map((o) => Number(o.value));
  try {
    const veri = await apiIstek('/api/yonetim/menuler', {
      method: 'POST',
      body: JSON.stringify({
        yemekhane_id: Number(document.getElementById('ym-yemekhane').value),
        tarih: document.getElementById('ym-tarih').value,
        ogun_id: Number(document.getElementById('ym-ogun').value),
        ogrenci_fiyati: Number(document.getElementById('ym-ogr-fiyat').value),
        personel_fiyati: Number(document.getElementById('ym-per-fiyat').value),
        yemek_idler: seciliYemekler
      })
    });
    bildirimGoster(veri.mesaj, 'basari');
    await yonetimYukle();
  } catch (err) {
    bildirimGoster(err.message, 'hata');
  }
});

oturumKontrolEt();
