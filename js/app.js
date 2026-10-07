/* ============================================================
   SOLAR FORECASTING & MICROGRID MANAGEMENT
   Единый файл приложения
   ============================================================ */

/* ============================================================
   1. КОНФИГУРАЦИЯ
   ============================================================ */
const CONFIG = {
  MIN_DATE: new Date(2023, 8, 30), // 30.09.2023
  MAX_DATE: new Date(2026, 8, 30), // 30.09.2026

  PANELS_COUNT: 24,

  THRESHOLD_WARN: 0.65,
  THRESHOLD_BAD: 0.90,

  POWER_BASE_MIN: 300,
  POWER_BASE_MAX: 330,

  STATE_FACTORS: {
    ok:   { min: 0.90, max: 1.00 },
    warn: { min: 0.60, max: 0.85 },
    bad:  { min: 0.20, max: 0.50 }
  },

  CLOUD_MIN: 5,        CLOUD_MAX: 90,
  TEMP_MIN: -15,       TEMP_MAX: 35,
  WIND_MIN: 0,         WIND_MAX: 9,
  INSOLATION_MIN: 1,   INSOLATION_MAX: 7.5,
  HUMIDITY_MIN: 30,    HUMIDITY_MAX: 90,
  VISIBILITY_MIN: 4,   VISIBILITY_MAX: 20,

  SUN_HOURS_BASE: 6.5,

  HOUR_LABELS: ['00','03','06','09','12','15','18','21'],
  HOUR_PROFILE: [0, 0, 0.1, 0.4, 0.8, 1.0, 0.7, 0.2]
};

/* ============================================================
   2. СОСТОЯНИЕ ПРИЛОЖЕНИЯ
   ============================================================ */
const STATE = {
  currentDate: new Date(),
  panelData: [],
  dayWeather: null,
  selectedPanelId: null,
  panelChart: null
};

/* ============================================================
   3. ГЕНЕРАЦИЯ ДАННЫХ (детерминированная)
   ============================================================ */
function seedFromDate(dateStr){
  const [y,m,d] = dateStr.split('-').map(Number);
  return y*10000 + m*100 + d;
}

function rand(seed, i){
  const x = Math.sin(seed*9301 + i*49297) * 233280;
  return x - Math.floor(x);
}

function randRange(seed, i, min, max){
  return min + rand(seed, i) * (max - min);
}

function getDayWeather(dateStr){
  const s = seedFromDate(dateStr);
  const c = CONFIG;

  const cloud = Math.round(randRange(s, 1, c.CLOUD_MIN, c.CLOUD_MAX));
  const temp  = Math.round(randRange(s, 2, c.TEMP_MIN,  c.TEMP_MAX));
  const wind  = +(randRange(s, 3, c.WIND_MIN, c.WIND_MAX)).toFixed(1);
  const ins   = +(randRange(s, 4, c.INSOLATION_MIN, c.INSOLATION_MAX)).toFixed(1);
  const hum   = Math.round(randRange(s, 5, c.HUMIDITY_MIN, c.HUMIDITY_MAX));
  const vis   = Math.round(randRange(s, 6, c.VISIBILITY_MIN, c.VISIBILITY_MAX));

  const weatherFactor = 1 - (cloud / 100) * 0.75;

  return { cloud, temp, wind, ins, hum, vis, weatherFactor };
}

function getPanelsForDate(dateStr){
  const s = seedFromDate(dateStr);
  const w = getDayWeather(dateStr);
  const c = CONFIG;
  const arr = [];

  for(let i=1; i<=c.PANELS_COUNT; i++){
    const r = rand(s, 100 + i);
    let state = 'ok';
    if(r > c.THRESHOLD_BAD) state = 'bad';
    else if(r > c.THRESHOLD_WARN) state = 'warn';

    const base = c.POWER_BASE_MIN + rand(s, 200+i) * (c.POWER_BASE_MAX - c.POWER_BASE_MIN);
    const sf = c.STATE_FACTORS[state];

    const kw = base * w.weatherFactor * randRange(s, 300+i, sf.min, sf.max);
    const sunHours = c.SUN_HOURS_BASE * (1 - w.cloud / 150);

    arr.push({
      id: i,
      state,
      kw: Math.round(kw),
      day: +(kw * sunHours / 1000).toFixed(2),
      kpd: +(18 + rand(s, 400+i) * 2 - (w.temp > 30 ? 0.8 : 0)).toFixed(1),
      temp: Math.round(w.temp + randRange(s, 500+i, 5, 20)),
      hours: 4000 + Math.round(rand(s, 600+i) * 500),
      degr: +(0.5 + rand(s, 700+i) * 0.3).toFixed(1)
    });
  }
  return arr;
}

/* ============================================================
   4. УТИЛИТЫ ДАТЫ
   ============================================================ */
function toISO(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function fromISO(s){
  const [y,m,d] = s.split('-').map(Number);
  return new Date(y, m-1, d);
}

function prettyDate(d){
  return d.toLocaleDateString('ru-RU', { day:'2-digit', month:'long', year:'numeric' });
}

function prettyShort(d){
  return d.toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric' });
}

function clampDate(d){
  if(d < CONFIG.MIN_DATE) return new Date(CONFIG.MIN_DATE);
  if(d > CONFIG.MAX_DATE) return new Date(CONFIG.MAX_DATE);
  return d;
}

/* ============================================================
   5. БЛОК ПАНЕЛЕЙ
   ============================================================ */
function renderPanels(){
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
   6. БЛОК АНАЛИТИКИ
   ============================================================ */
function computeAnalytics(){
  const data = STATE.panelData;
  const N = data.length;

  if(STATE.selectedPanelId === null){
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
      title: 'Профиль выработки: все панели'
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
    hint: 'Повторный клик по панели — сброс к данным по всем.',
    k1: p.day + ' кВт·ч',
    k2: p.kw + ' Вт',
    k3: p.kpd + '%',
    k4: '+' + p.temp + '°C',
    k5: p.hours + ' ч',
    k6: p.degr + '%/год',
    base: p.kw / 1000,
    title: 'Профиль выработки: панель №' + p.id
  };
}

function updateAnalytics(){
  const a = computeAnalytics();

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

  if(STATE.panelChart) STATE.panelChart.destroy();
  STATE.panelChart = new Chart(document.getElementById('panelChart'), {
    type: 'line',
    data: {
      labels: CONFIG.HOUR_LABELS,
      datasets: [{
        data: prof,
        borderColor: '#ffb84d',
        backgroundColor: 'rgba(255,184,77,.15)',
        fill: true,
        tension: .35,
        pointRadius: 0,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
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
   7. БЛОК ПОГОДЫ
   ============================================================ */
function renderWeather(){
  const w = STATE.dayWeather;
  if(!w) return;

  const items = [
    { ic:'☀️', v: w.ins + ' кВт/м²',                        l:'Инсоляция' },
    { ic:'🌡️', v: (w.temp > 0 ? '+' : '') + w.temp + '°C',   l:'Воздух' },
    { ic:'💨', v: w.wind + ' м/с',                           l:'Ветер' },
    { ic:'☁️', v: w.cloud + '%',                             l:'Облачность' },
    { ic:'💧', v: w.hum + '%',                               l:'Влажность' },
    { ic:'🌫️', v: w.vis + ' км',                             l:'Видимость' }
  ];

  const box = document.getElementById('weather');
  box.innerHTML = '';
  items.forEach(it => {
    box.insertAdjacentHTML('beforeend',
      `<div class="wbox">
         <div class="ic">${it.ic}</div>
         <div class="v">${it.v}</div>
         <div class="l">${it.l}</div>
       </div>`);
  });

  const note = document.getElementById('weatherNote');
  if(w.cloud < 25){
    note.innerHTML = `☀️ Ясно. Ожидается <b style="color:#3ddc97">максимальная выработка</b> за день.`;
  } else if(w.cloud < 60){
    note.innerHTML = `⛅ Переменная облачность. Снижение генерации к 16:00 до <b style="color:#ffb84d">−${Math.round(w.cloud/2)}%</b>.`;
  } else {
    note.innerHTML = `☁️ Пасмурно. Ожидаемое снижение генерации <b style="color:#ff5c7a">−${Math.round(w.cloud*0.75)}%</b>.`;
  }
}

/* ============================================================
   8. УПРАВЛЕНИЕ ДАТОЙ
   ============================================================ */
function setDate(d){
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
  document.getElementById('dateFoot').innerHTML =
    `Текущий день: <b style="color:#e6edf7">${pShort}</b>`;

  document.getElementById('prevDay').disabled = (toISO(cd) === toISO(CONFIG.MIN_DATE));
  document.getElementById('nextDay').disabled = (toISO(cd) === toISO(CONFIG.MAX_DATE));

  // Перегенерация данных
  STATE.panelData    = getPanelsForDate(toISO(cd));
  STATE.dayWeather   = getDayWeather(toISO(cd));
  STATE.selectedPanelId = null;

  // Обновить блоки
  renderPanels();
  renderWeather();
  updateAnalytics();
}

function initDateControls(){
  const dateInput = document.getElementById('dateInput');
  const prevBtn   = document.getElementById('prevDay');
  const nextBtn   = document.getElementById('nextDay');

  document.getElementById('dateRangeLabel').textContent =
    `${prettyShort(CONFIG.MIN_DATE)} — ${prettyShort(CONFIG.MAX_DATE)}`;

  dateInput.addEventListener('change', e => {
    if(e.target.value) setDate(fromISO(e.target.value));
  });

  prevBtn.addEventListener('click', () => {
    const d = new Date(STATE.currentDate);
    d.setDate(d.getDate() - 1);
    setDate(d);
  });

  nextBtn.addEventListener('click', () => {
    const d = new Date(STATE.currentDate);
    d.setDate(d.getDate() + 1);
    setDate(d);
  });
}

/* ============================================================
   9. ТОЧКА ВХОДА
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initDateControls();
  setDate(clampDate(new Date()));

  const now = new Date();
  document.getElementById('lastUpdate').textContent =
    'Обновлено ' + now.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });
});