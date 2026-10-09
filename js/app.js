/* ============================================================
   КОНФИГ
   ============================================================ */
const CONFIG = {
  MIN_DATE: new Date(2023, 8, 30),
  MAX_DATE: new Date(2026, 8, 30),
  PANELS_COUNT: 24,
  HOUR_LABELS: ['00','03','06','09','12','15','18','21'],
  HOUR_PROFILE: [0, 0, 0.1, 0.4, 0.8, 1.0, 0.7, 0.2]
};

const STATE = {
  currentDate: new Date(),
  panelData: [],
  dayWeather: null,
  selectedPanelId: null,
  panelChart: null
};

const WEATHER = { rows: [], byDate: {}, loaded: false };

/* ============================================================
   CSV ПАРСЕР
   ============================================================ */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim());
  const expected = headers.length;
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length < expected) continue;

    if (cells.length > expected) {
      const diff = cells.length - expected;
      const merged = cells.slice(0, 3);
      merged.push(cells.slice(3, 3 + diff + 1).join(', '));
      const rest = cells.slice(3 + diff + 1);
      for (let k = 0; k < rest.length; k++) merged.push(rest[k]);

      const row = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = (merged[j] || '').trim();
      }
      rows.push(row);
      continue;
    }

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cells[j] || '').trim();
    }
    rows.push(row);
  }
  return rows;
}

/* ============================================================
   ПРИЗНАКИ ИЗ СТРОКИ CSV
   ============================================================ */
function rowToFeatures(row) {
  const num = v => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s || s === 'н/о') return null;
    const n = parseFloat(s.replace('+', '').replace(',', '.'));
    return isNaN(n) ? null : n;
  };

  const T  = num(row.T)  ?? 0;
  const Td = num(row.Td) ?? 0;
  const dewDeficit = Math.max(0, T - Td);

  let cloudScore = num(row.cloudiness);
  let cloudEstimated = false;
  if (cloudScore === null) {
    cloudEstimated = true;
    if      (dewDeficit >= 15) cloudScore = 1;
    else if (dewDeficit >= 10) cloudScore = 3;
    else if (dewDeficit >= 5)  cloudScore = 5;
    else if (dewDeficit >= 2)  cloudScore = 7;
    else                       cloudScore = 9;
  }
  const cloudFrac = cloudScore / 10;

  const wind = num(row.wind_speed_ms) ?? 0;

  let S = num(row.S);
  let sunEstimated = false;
  if (S === null) {
    sunEstimated = true;
    S = +Math.max(0, 8 * (1 - cloudFrac)).toFixed(1);
  }

  return {
    datetime: row.datetime_local,
    hour: parseInt(row.datetime_local.split(' ')[1].split(':')[0], 10),
    cloudiness: cloudScore,
    cloudEstimated,
    temperature: T,
    dewPoint: Td,
    humidity: num(row.f),
    windSpeed: wind,
    windDir: row.wind_dir,
    pressure: num(row.P),
    rain: num(row.R),
    sunHours: S,
    sunEstimated,
    visibility: (row.visibility && row.visibility !== 'н/о') ? row.visibility : null,
    phenomena: (row.phenomena && row.phenomena.trim()) ? row.phenomena.trim() : null,
    clearnessIndex: +(1 - cloudFrac).toFixed(3),
    dewPointDeficit: +dewDeficit.toFixed(2),
    tempEfficiency: +(Math.max(0.7, 1 - 0.004 * Math.max(0, T - 25))).toFixed(3),
    windCooling: +(1 + Math.min(wind, 5) * 0.006).toFixed(3)
  };
}

/* ============================================================
   СИНТЕЗ PV ИЗ ПОГОДЫ
   ============================================================ */
function pvFromRow(row, peakKW = 10) {
  const f = rowToFeatures(row);
  const month = parseInt(row.datetime_local.split('-')[1], 10);
  const dayLength = 12 + 4 * Math.sin((month - 3) * Math.PI / 6);
  const sunrise = 12 - dayLength / 2;
  const h = (f.hour - sunrise) / dayLength;
  const clearSky = (h < 0 || h > 1) ? 0 : peakKW * Math.sin(Math.PI * h);

  const cloudFactor = f.clearnessIndex;
  const tempPenalty = f.tempEfficiency;
  const windBonus   = f.windCooling;
  const sunBonus    = f.sunHours > 0 ? 1 + Math.min(f.sunHours, 3) * 0.03 : 1;
  const phenomenaPenalty =
    /туман|дымка|мгла/.test(row.phenomena || '') ? 0.5 :
    /дождь|ливень|снег|гроза/.test(row.phenomena || '') ? 0.7 : 1;

  const pv = clearSky * cloudFactor * tempPenalty * windBonus * sunBonus * phenomenaPenalty;
  return {
    pv: +Math.max(0, pv).toFixed(3),
    clearSky: +clearSky.toFixed(3),
    attenuation: +(cloudFactor * tempPenalty * windBonus * sunBonus * phenomenaPenalty).toFixed(3),
    hour: f.hour
  };
}

/* ============================================================
   СВОДКА ЗА ДЕНЬ (средние + макс)
   ============================================================ */
function getDayWeather(dateStr) {
  const rows = WEATHER.byDate[dateStr] || [];
  if (!rows.length) return null;

  const feats = rows.map(rowToFeatures);

  const avg = (arr, digits = 1) => {
    const clean = arr.filter(v => v !== null && v !== undefined && !isNaN(v));
    if (!clean.length) return null;
    return +(clean.reduce((a,b) => a+b, 0) / clean.length).toFixed(digits);
  };

  const cloudArr = feats.map(f => f.cloudiness);
  const tempArr  = feats.map(f => f.temperature);
  const windArr  = feats.map(f => f.windSpeed);
  const sunArr   = feats.map(f => f.sunHours);
  const humArr   = feats.map(f => f.humidity);

  const avgCloud = avg(cloudArr, 1) ?? 5;
  const maxSun   = sunArr.filter(v => v !== null).reduce((a,b) => Math.max(a,b), 0);

  return {
    rowsCount: rows.length,
    cloud: avgCloud,                       // 0..10, среднее
    cloudPct: Math.round(avgCloud * 10),   // 0..100
    temp: avg(tempArr, 1),
    wind: avg(windArr, 1),
    ins: maxSun,
    hum: avg(humArr, 0),
    cloudEstimated: feats.some(f => f.cloudEstimated),
    sunEstimated:   feats.some(f => f.sunEstimated),
    weatherFactor: +(1 - (avgCloud / 10) * 0.75).toFixed(3)
  };
}

/* ============================================================
   ПАНЕЛИ
   ============================================================ */
function getPanelsForDate(dateStr) {
  const rows = WEATHER.byDate[dateStr] || [];
  const w = getDayWeather(dateStr);
  if (!w || !rows.length) return [];

  const panels = [];
  for (let i = 1; i <= CONFIG.PANELS_COUNT; i++) {
    const rowIdx = Math.floor((i / CONFIG.PANELS_COUNT) * rows.length);
    const row = rows[Math.min(rowIdx, rows.length - 1)];
    const pvResult = pvFromRow(row, 10);

    const seed = parseInt(dateStr.replace(/-/g, ''), 10) + i;
    const r = Math.abs(Math.sin(seed * 9301)) % 1;

    let state = 'ok';
    if (r > 0.9) state = 'bad';
    else if (r > 0.65) state = 'warn';

    const base = 300 + r * 30;
    const kw = base * pvResult.attenuation;
    const sunHours = Math.max(0, 6.5 * (1 - w.cloudPct / 150));

    panels.push({
      id: i,
      state,
      kw: Math.round(kw),
      day: +(kw * sunHours / 1000).toFixed(2),
      kpd: +(18 + r * 2 - (w.temp > 30 ? 0.8 : 0)).toFixed(1),
      temp: Math.round(w.temp + r * 15),
      hours: 4000 + Math.round(r * 500),
      degr: +(0.5 + r * 0.3).toFixed(1)
    });
  }
  return panels;
}

function renderPanels() {
  const box = document.getElementById('panels');
  box.innerHTML = '';
  STATE.panelData.forEach(p => {
    const el = document.createElement('div');
    el.className = 'pv ' + p.state + (p.id === STATE.selectedPanelId ? ' active' : '');
    el.innerHTML = `
      <div class="dot"></div>
      <div class="num">№${p.id}</div>
      <div class="kw">${p.kw} Вт</div>
    `;
    el.addEventListener('click', () => {
      STATE.selectedPanelId = (STATE.selectedPanelId === p.id) ? null : p.id;
      renderPanels();
      updateAnalytics();
    });
    box.appendChild(el);
  });
}

/* ============================================================
   АНАЛИТИКА
   ============================================================ */
function computeAnalytics() {
  const data = STATE.panelData;
  const N = data.length;
  if (!N) return null;

  if (STATE.selectedPanelId === null) {
    const okCount  = data.filter(p => p.state === 'ok').length;
    const totalKW  = data.reduce((s,p) => s + p.kw, 0);
    const totalDay = data.reduce((s,p) => s + p.day, 0);
    const avgKPD   = data.reduce((s,p) => s + p.kpd, 0) / N;
    const avgT     = data.reduce((s,p) => s + p.temp, 0) / N;
    const avgH     = data.reduce((s,p) => s + p.hours, 0) / N;
    const avgD     = data.reduce((s,p) => s + p.degr, 0) / N;

    return {
      name: 'Все панели',
      status: `● ${okCount} из ${N} работают`,
      statusColor: okCount === N ? '#3ddc97' : '#ffb84d',
      hint: 'Кликните на панель — данные по ней. Повторный клик — сброс.',
      k1: totalDay.toFixed(1) + ' кВт·ч',
      k2: (totalKW / N).toFixed(0) + ' Вт',
      k3: avgKPD.toFixed(1) + '%',
      k4: '+' + avgT.toFixed(0) + '°C',
      k5: Math.round(avgH) + ' ч',
      k6: avgD.toFixed(1) + '%/год',
      base: totalKW / 1000,

    };
  }

  const p = data.find(x => x.id === STATE.selectedPanelId);
  const map = {
    ok:   ['● штатно',        '#3ddc97'],
    warn: ['● снижена',       '#ffb84d'],
    bad:  ['● неисправность', '#ff5c7a']
  };
  return {
    name: 'Панель №' + p.id,
    status: map[p.state][0],
    statusColor: map[p.state][1],
    hint: 'Повторный клик — сброс к данным по всем панелям.',
    k1: p.day + ' кВт·ч',
    k2: p.kw + ' Вт',
    k3: p.kpd + '%',
    k4: '+' + p.temp + '°C',
    k5: p.hours + ' ч',
    k6: p.degr + '%/год',
    base: p.kw / 1000,

  };
}

function updateAnalytics() {
  const a = computeAnalytics();
  if (!a) return;

  document.getElementById('selName').textContent = a.name;
  const st = document.getElementById('selStatus');
  st.textContent = a.status;
  st.style.color = a.statusColor;
  document.getElementById('selHint').textContent = a.hint;

  document.getElementById('k1').textContent = a.k1;
  document.getElementById('k2').textContent = a.k2;
  document.getElementById('k3').textContent = a.k3;
  document.getElementById('k4').textContent = a.k4;
  document.getElementById('k5').textContent = a.k5;
  document.getElementById('k6').textContent = a.k6;
  document.getElementById('chartLabel').textContent = a.title;

  const prof = CONFIG.HOUR_PROFILE.map(v => +(v * a.base * 6).toFixed(2));

  if (STATE.panelChart) STATE.panelChart.destroy();
  STATE.panelChart = new Chart(document.getElementById('panelChart'), {
    type: 'line',
    data: {
      labels: CONFIG.HOUR_LABELS,
      datasets: [{
        data: prof,
        borderColor: '#ffb84d',
        backgroundColor: 'rgba(255,184,77,.15)',
        fill: true, tension: .35, pointRadius: 0, borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8ea2c0', font: { size: 10 } }, grid: { display: false } },
        y: {
          ticks: { color: '#8ea2c0', font: { size: 10 } },
          grid: { color: '#1b2740' },
          title: { display: true, text: 'кВт', color: '#8ea2c0', font: { size: 10 } }
        }
      }
    }
  });
}

/* ============================================================
   ПОГОДА — СРЕДНИЕ ЗА ДЕНЬ
   ============================================================ */
function renderWeather() {
  const dateStr = toISO(STATE.currentDate);
  const rows = WEATHER.byDate[dateStr] || [];

  const box  = document.getElementById('weather');
  const note = document.getElementById('weatherNote');

  if (!rows.length) {
    box.innerHTML = '<div style="grid-column:1/-1;color:#8ea2c0;text-align:center;padding:12px">Нет данных о погоде</div>';
    note.textContent = '—';
    return;
  }

  const w = STATE.dayWeather;
  if (!w) { note.textContent = '—'; return; }

  const fmt = (v, suffix = '', digits = 1) => {
    if (v === null || v === undefined || v === '' || v === 'н/о') return 'н/о';
    const n = (typeof v === 'number') ? +v.toFixed(digits) : v;
    return n + suffix;
  };

  const tempStr = w.temp === null ? 'н/о'
                : (w.temp > 0 ? '+' : '') + w.temp.toFixed(1) + '°C';

  const items = [
    { ic:'☁️', v: fmt(w.cloud, ' балл') + (w.cloudEstimated ? ' ≈' : ''), l:'Облачность (ср.)' },
    { ic:'🌡️', v: tempStr,                                                 l:'Воздух (ср.)' },
    { ic:'💨', v: fmt(w.wind, ' м/с'),                                     l:'Ветер (ср.)' },
    { ic:'☀️', v: fmt(w.ins, ' ч') + (w.sunEstimated ? ' ≈' : ''),         l:'Солнце (макс.)' },
    { ic:'💧', v: fmt(w.hum, '%', 0),                                      l:'Влажность (ср.)' },
    { ic:'🌫️', v: 'н/о',                                                    l:'Видимость' }
  ];

  box.innerHTML = '';
  items.forEach(it => {
    box.insertAdjacentHTML('beforeend',
      `<div class="wbox"><div class="ic">${it.ic}</div><div class="v">${it.v}</div><div class="l">${it.l}</div></div>`);
  });

  const estimatedNote = (w.cloudEstimated || w.sunEstimated)
    ? ' <span style="color:#8ea2c0">(облачность/солнце восстановлены по T−Td)</span>'
    : '';

  if (w.cloudPct < 25)      note.innerHTML = `☀️ Ясно. Максимальная выработка.${estimatedNote}`;
  else if (w.cloudPct < 60) note.innerHTML = `⛅ Переменная облачность. Снижение генерации до <b style="color:#ffb84d">−${Math.round(w.cloudPct/2)}%</b>.${estimatedNote}`;
  else                      note.innerHTML = `☁️ Пасмурно. Снижение генерации <b style="color:#ff5c7a">−${Math.round(w.cloudPct*0.75)}%</b>.${estimatedNote}`;
}

/* ============================================================
   ДАТА
   ============================================================ */
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function fromISO(s) {
  const [y,m,d] = s.split('-').map(Number);
  return new Date(y, m-1, d);
}
function prettyDate(d) {
  return d.toLocaleDateString('ru-RU', { day:'2-digit', month:'long', year:'numeric' });
}
function prettyShort(d) {
  return d.toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric' });
}
function clampDate(d) {
  if (d < CONFIG.MIN_DATE) return new Date(CONFIG.MIN_DATE);
  if (d > CONFIG.MAX_DATE) return new Date(CONFIG.MAX_DATE);
  return d;
}

function setDate(d) {
  const cd = clampDate(d);
  STATE.currentDate = cd;

  const dateInput = document.getElementById('dateInput');
  dateInput.value = toISO(cd);
  dateInput.min   = toISO(CONFIG.MIN_DATE);
  dateInput.max   = toISO(CONFIG.MAX_DATE);

  const pLong  = prettyDate(cd);
  const pShort = prettyShort(cd);

  document.getElementById('panelDateLabel').textContent     = pLong;
  document.getElementById('analyticsDateLabel').textContent = pLong;
  document.getElementById('weatherDateLabel').textContent   = pLong;
  document.getElementById('dateFoot').innerHTML = `Текущий день: <b style="color:#e6edf7">${pShort}</b>`;

  document.getElementById('prevDay').disabled = (toISO(cd) === toISO(CONFIG.MIN_DATE));
  document.getElementById('nextDay').disabled = (toISO(cd) === toISO(CONFIG.MAX_DATE));

  STATE.dayWeather = getDayWeather(toISO(cd));
  STATE.panelData  = getPanelsForDate(toISO(cd));
  STATE.selectedPanelId = null;

  renderPanels();
  renderWeather();
  updateAnalytics();
}

function initDateControls() {
  const dateInput = document.getElementById('dateInput');
  const prevBtn = document.getElementById('prevDay');
  const nextBtn = document.getElementById('nextDay');

  document.getElementById('dateRangeLabel').textContent =
    `${prettyShort(CONFIG.MIN_DATE)} — ${prettyShort(CONFIG.MAX_DATE)}`;

  dateInput.addEventListener('change', e => {
    if (e.target.value) setDate(fromISO(e.target.value));
  });
  prevBtn.addEventListener('click', () => {
    const d = new Date(STATE.currentDate); d.setDate(d.getDate()-1); setDate(d);
  });
  nextBtn.addEventListener('click', () => {
    const d = new Date(STATE.currentDate); d.setDate(d.getDate()+1); setDate(d);
  });
}

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  const loading = document.getElementById('loading');

  try {
    const res = await fetch('data/weather.csv');
    if (!res.ok) throw new Error(`HTTP ${res.status}: файл не найден по пути data/weather.csv`);

    const text = await res.text();
    if (text.length < 100) throw new Error('CSV пустой или повреждён');

    const rows = parseCSV(text);
    if (!rows[0] || !rows[0].datetime_local) {
      throw new Error('В CSV нет колонки datetime_local');
    }

    // Группировка по ЛОКАЛЬНОЙ дате
    const byDate = {};
    rows.forEach(r => {
      const dt = r.datetime_local;
      if (!dt) return;
      const key = dt.split(' ')[0];
      if (!byDate[key]) byDate[key] = [];
      byDate[key].push(r);
    });

    WEATHER.rows = rows;
    WEATHER.byDate = byDate;
    WEATHER.loaded = true;

    const allDates = Object.keys(byDate).sort();

    if (loading) loading.remove();

    initDateControls();

    const lastDate = allDates[allDates.length - 1] || toISO(new Date());
    setDate(fromISO(lastDate));

    const now = new Date();
    document.getElementById('lastUpdate').textContent =
      'Обновлено ' + now.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });

  } catch (err) {
    console.error('Ошибка загрузки:', err);
    if (loading) {
      loading.innerHTML = `
        <div style="text-align:center;max-width:600px;padding:24px">
          <div style="font-size:32px;margin-bottom:12px">❌</div>
          <div style="font-size:16px;color:#ff5c7a;margin-bottom:12px">Не удалось загрузить данные</div>
          <div style="font-size:13px;color:#e6edf7;margin-bottom:16px">${err.message}</div>
          <div style="font-size:12px;color:#8ea2c0;text-align:left;background:#0f1830;padding:14px;border-radius:8px;line-height:1.6">
            <b style="color:#ffb84d">Как починить:</b><br>
            1. Файл должен лежать в <b>data/weather.csv</b><br>
            2. Открывать через <b>http://localhost:8000</b> (не file://)
          </div>
        </div>
      `;
    }
  }
});