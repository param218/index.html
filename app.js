/* ============================================================
   每日營養標示 - 熱量與蛋白質計算機
   資料儲存：localStorage 自動儲存 + 手動匯出/匯入 JSON 檔案
   ============================================================ */

const STORAGE_KEY = 'nutriTrackerData_v1';

const todayStr = () => {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
};

/* ---------------- 預設資料結構 ---------------- */
function defaultData() {
  return {
    profile: {
      age: null,
      gender: 'male',
      height: null,
      weight: null,
      activity: 1.55,
      goal: 'maintain'
    },
    targets: {
      calories: 2000,
      protein: 100,
      manualOverride: false
    },
    logs: {
      // "2026-07-03": [ { meal, name, grams, calories, protein } ]
    }
  };
}

let state = loadState();
let foodDB = [];
let currentDate = todayStr();
let logMode = 'db'; // 'db' | 'manual'

/* ---------------- 儲存 / 讀取 ---------------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    const parsed = JSON.parse(raw);
    // 補齊缺漏欄位，避免舊資料格式造成錯誤
    const base = defaultData();
    return {
      profile: { ...base.profile, ...(parsed.profile || {}) },
      targets: { ...base.targets, ...(parsed.targets || {}) },
      logs: parsed.logs || {}
    };
  } catch (e) {
    console.error('讀取本機紀錄失敗，改用預設值', e);
    return defaultData();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('儲存本機紀錄失敗', e);
    showToast('儲存失敗，瀏覽器儲存空間可能已滿');
  }
}

/* ---------------- 載入食物資料庫 ---------------- */
async function loadFoodDB() {
  try {
    const res = await fetch('foods.json');
    const data = await res.json();
    foodDB = data.items || [];
  } catch (e) {
    console.error('無法載入 foods.json，請確認是以 Live Server 開啟頁面', e);
    foodDB = [];
    showToast('食物資料庫載入失敗，仍可使用手動輸入');
  }
  populateFoodSelect();
}

function populateFoodSelect() {
  const select = document.getElementById('food-select');
  select.innerHTML = '';
  const categories = [...new Set(foodDB.map(f => f.category))];
  categories.forEach(cat => {
    const group = document.createElement('optgroup');
    group.label = cat;
    foodDB.filter(f => f.category === cat).forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name;
      group.appendChild(opt);
    });
    select.appendChild(group);
  });
  updateDbPreview();
}

/* ---------------- BMR / TDEE / 建議值計算 ---------------- */
function calcSuggestions(profile) {
  const { age, gender, height, weight, activity, goal } = profile;
  if (!age || !height || !weight) return null;

  const bmr = gender === 'male'
    ? 10 * weight + 6.25 * height - 5 * age + 5
    : 10 * weight + 6.25 * height - 5 * age - 161;

  const tdee = bmr * Number(activity);

  let calorieAdjust = 0;
  let proteinFactor = 1.4; // 公克/公斤體重
  if (goal === 'cut') { calorieAdjust = -500; proteinFactor = 2.0; }
  else if (goal === 'bulk') { calorieAdjust = 350; proteinFactor = 1.8; }

  const suggestedCalories = Math.max(1200, Math.round(tdee + calorieAdjust));
  const suggestedProtein = Math.round(weight * proteinFactor);

  return { bmr: Math.round(bmr), tdee: Math.round(tdee), suggestedCalories, suggestedProtein };
}

function applySuggestions(force) {
  const p = state.profile;
  const result = calcSuggestions(p);
  const hintEl = document.getElementById('bmr-hint');

  if (!result) {
    hintEl.textContent = '填入年齡、身高、體重後，會自動估算基礎代謝率與建議目標值。';
    return;
  }

  hintEl.textContent =
    `估算基礎代謝率 BMR ${result.bmr} 大卡／每日總消耗 TDEE ${result.tdee} 大卡 → 建議熱量 ${result.suggestedCalories} 大卡、建議蛋白質 ${result.suggestedProtein} 公克。`;

  if (force || !state.targets.manualOverride) {
    state.targets.calories = result.suggestedCalories;
    state.targets.protein = result.suggestedProtein;
    state.targets.manualOverride = false;
    document.getElementById('target-calories').value = result.suggestedCalories;
    document.getElementById('target-protein').value = result.suggestedProtein;
    saveState();
  }
}

/* ---------------- 飲食紀錄操作 ---------------- */
function getTodayLogs() {
  return state.logs[currentDate] || [];
}

function addLogEntry(entry) {
  if (!state.logs[currentDate]) state.logs[currentDate] = [];
  state.logs[currentDate].push(entry);
  saveState();
  renderLogTable();
  renderFactsPanel();
  renderHistory();
}

function removeLogEntry(index) {
  if (!state.logs[currentDate]) return;
  state.logs[currentDate].splice(index, 1);
  if (state.logs[currentDate].length === 0) delete state.logs[currentDate];
  saveState();
  renderLogTable();
  renderFactsPanel();
  renderHistory();
}

function dayTotals(dateKey) {
  const entries = state.logs[dateKey] || [];
  return entries.reduce((acc, e) => {
    acc.calories += Number(e.calories) || 0;
    acc.protein += Number(e.protein) || 0;
    return acc;
  }, { calories: 0, protein: 0 });
}

/* ---------------- 渲染：營養標示牌 ---------------- */
function renderFactsPanel() {
  const totals = dayTotals(currentDate);
  const targetCal = Number(state.targets.calories) || 0;
  const targetPro = Number(state.targets.protein) || 0;

  document.getElementById('fact-calories').textContent = Math.round(totals.calories);
  document.getElementById('fact-protein').textContent = `${round1(totals.protein)} g`;
  document.getElementById('fact-calories-target').textContent = `目標 ${targetCal}`;

  const calPct = targetCal > 0 ? Math.round((totals.calories / targetCal) * 100) : 0;
  const proPct = targetPro > 0 ? Math.round((totals.protein / targetPro) * 100) : 0;

  document.getElementById('calorie-pct').textContent = `${calPct}%`;
  document.getElementById('protein-pct').textContent = `${proPct}%`;

  setBar('calorie-bar', calPct);
  setBar('protein-bar', proPct);

  const remainCal = Math.round(targetCal - totals.calories);
  const remainPro = round1(targetPro - totals.protein);
  document.getElementById('remaining-calories').textContent =
    remainCal >= 0 ? `熱量剩餘 ${remainCal} 大卡` : `熱量超出 ${Math.abs(remainCal)} 大卡`;
  document.getElementById('remaining-protein').textContent =
    remainPro >= 0 ? `蛋白質剩餘 ${remainPro} 公克` : `蛋白質超出 ${Math.abs(remainPro)} 公克`;
}

function setBar(id, pct) {
  const el = document.getElementById(id);
  const clamped = Math.min(pct, 130);
  el.style.width = `${Math.min(clamped, 100)}%`;
  el.classList.remove('near', 'over');
  if (pct > 100) el.classList.add('over');
  else if (pct >= 85) el.classList.add('near');
}

/* ---------------- 渲染：今日紀錄表格 ---------------- */
function renderLogTable() {
  const tbody = document.getElementById('log-tbody');
  const empty = document.getElementById('log-empty');
  const entries = getTodayLogs();
  tbody.innerHTML = '';

  if (entries.length === 0) {
    empty.style.display = 'block';
    document.getElementById('log-table').style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  document.getElementById('log-table').style.display = 'table';

  entries.forEach((entry, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="meal-tag">${entry.meal}</span></td>
      <td>${escapeHtml(entry.name)}</td>
      <td>${entry.grams ? entry.grams + ' g' : '—'}</td>
      <td class="num-cell">${Math.round(entry.calories)}</td>
      <td class="num-cell">${round1(entry.protein)} g</td>
      <td><button class="icon-btn" title="刪除這筆紀錄" data-idx="${idx}">✕</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.icon-btn').forEach(btn => {
    btn.addEventListener('click', () => removeLogEntry(Number(btn.dataset.idx)));
  });
}

/* ---------------- 渲染：歷史紀錄 ---------------- */
function renderHistory() {
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const dates = Object.keys(state.logs).sort((a, b) => b.localeCompare(a));

  list.innerHTML = '';
  if (dates.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  dates.forEach(dateKey => {
    const totals = dayTotals(dateKey);
    const targetCal = Number(state.targets.calories) || 1;
    const pct = Math.min(Math.round((totals.calories / targetCal) * 100), 130);
    const over = totals.calories > targetCal;

    const row = document.createElement('div');
    row.className = 'history-row' + (dateKey === currentDate ? ' current' : '');
    row.innerHTML = `
      <span class="hdate">${dateKey}</span>
      <span class="hbar"><div class="${over ? 'over' : ''}" style="width:${Math.min(pct, 100)}%"></div></span>
      <span class="hnum">${Math.round(totals.calories)} 大卡</span>
      <span class="hnum">${round1(totals.protein)} g 蛋白質</span>
    `;
    row.addEventListener('click', () => {
      currentDate = dateKey;
      document.getElementById('log-date').value = dateKey;
      renderAllForCurrentDate();
    });
    list.appendChild(row);
  });
}

function renderAllForCurrentDate() {
  renderLogTable();
  renderFactsPanel();
  renderHistory();
}

/* ---------------- 表單：從資料庫加入 ---------------- */
function updateDbPreview() {
  const select = document.getElementById('food-select');
  const grams = Number(document.getElementById('food-grams').value) || 0;
  const item = foodDB.find(f => f.id === select.value);
  const preview = document.getElementById('db-preview');
  if (!item) { preview.textContent = '— 大卡 ／ — 公克蛋白質'; return; }
  const cal = (item.calories * grams) / 100;
  const pro = (item.protein * grams) / 100;
  preview.textContent = `${Math.round(cal)} 大卡 ／ ${round1(pro)} 公克蛋白質`;
}

/* ---------------- 工具函式 ---------------- */
function round1(n) { return Math.round(Number(n) * 10) / 10; }

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------------- 匯出 / 匯入 JSON ---------------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = todayStr().replace(/-/g, '');
  a.href = url;
  a.download = `nutrition-data-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('已匯出 JSON 檔案');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || typeof parsed !== 'object') throw new Error('格式不正確');
      const base = defaultData();
      state = {
        profile: { ...base.profile, ...(parsed.profile || {}) },
        targets: { ...base.targets, ...(parsed.targets || {}) },
        logs: parsed.logs || {}
      };
      saveState();
      fillProfileForm();
      renderAllForCurrentDate();
      showToast('已匯入紀錄');
    } catch (e) {
      console.error(e);
      showToast('匯入失敗：檔案格式不正確');
    }
  };
  reader.readAsText(file);
}

/* ---------------- 表單初始化與事件綁定 ---------------- */
function fillProfileForm() {
  const p = state.profile;
  document.getElementById('age').value = p.age ?? '';
  document.getElementById('gender').value = p.gender ?? 'male';
  document.getElementById('height').value = p.height ?? '';
  document.getElementById('weight').value = p.weight ?? '';
  document.getElementById('activity').value = p.activity ?? 1.55;
  document.getElementById('goal').value = p.goal ?? 'maintain';
  document.getElementById('target-calories').value = state.targets.calories ?? '';
  document.getElementById('target-protein').value = state.targets.protein ?? '';
}

function bindEvents() {
  // 個人資料欄位變動 -> 更新 profile 並重新估算（除非已手動覆蓋目標）
  ['age', 'gender', 'height', 'weight', 'activity', 'goal'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      state.profile.age = Number(document.getElementById('age').value) || null;
      state.profile.gender = document.getElementById('gender').value;
      state.profile.height = Number(document.getElementById('height').value) || null;
      state.profile.weight = Number(document.getElementById('weight').value) || null;
      state.profile.activity = Number(document.getElementById('activity').value);
      state.profile.goal = document.getElementById('goal').value;
      saveState();
      applySuggestions(false);
    });
  });

  document.getElementById('btn-recalc').addEventListener('click', () => applySuggestions(true));

  // 目標欄位手動修改 -> 標記為手動覆蓋
  document.getElementById('target-calories').addEventListener('input', (e) => {
    state.targets.calories = Number(e.target.value) || 0;
    state.targets.manualOverride = true;
    saveState();
    renderFactsPanel();
  });
  document.getElementById('target-protein').addEventListener('input', (e) => {
    state.targets.protein = Number(e.target.value) || 0;
    state.targets.manualOverride = true;
    saveState();
    renderFactsPanel();
  });

  // 日期切換
  document.getElementById('log-date').addEventListener('change', (e) => {
    currentDate = e.target.value || todayStr();
    renderAllForCurrentDate();
  });

  // 模式切換
  document.getElementById('mode-db').addEventListener('click', () => setLogMode('db'));
  document.getElementById('mode-manual').addEventListener('click', () => setLogMode('manual'));

  // 食物選擇預覽
  document.getElementById('food-select').addEventListener('change', updateDbPreview);
  document.getElementById('food-grams').addEventListener('input', updateDbPreview);

  // 表單送出：資料庫模式
  document.getElementById('form-db').addEventListener('submit', (e) => {
    e.preventDefault();
    const select = document.getElementById('food-select');
    const grams = Number(document.getElementById('food-grams').value);
    const item = foodDB.find(f => f.id === select.value);
    if (!item || !grams || grams <= 0) {
      showToast('請選擇食物並輸入有效的份量');
      return;
    }
    addLogEntry({
      meal: document.getElementById('meal-type-db').value,
      name: item.name,
      grams,
      calories: (item.calories * grams) / 100,
      protein: (item.protein * grams) / 100
    });
    document.getElementById('food-grams').value = 100;
    updateDbPreview();
  });

  // 表單送出：手動模式
  document.getElementById('form-manual').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('manual-name').value.trim();
    const calories = Number(document.getElementById('manual-calories').value);
    const protein = Number(document.getElementById('manual-protein').value);
    if (!name || isNaN(calories) || isNaN(protein)) {
      showToast('請完整填寫食物名稱、熱量與蛋白質');
      return;
    }
    addLogEntry({
      meal: document.getElementById('meal-type-manual').value,
      name,
      grams: null,
      calories,
      protein
    });
    document.getElementById('manual-name').value = '';
    document.getElementById('manual-calories').value = '';
    document.getElementById('manual-protein').value = '';
  });

  // 匯出 / 匯入
  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importData(file);
    e.target.value = '';
  });
}

function setLogMode(mode) {
  logMode = mode;
  document.getElementById('mode-db').classList.toggle('active', mode === 'db');
  document.getElementById('mode-manual').classList.toggle('active', mode === 'manual');
  document.getElementById('form-db').style.display = mode === 'db' ? 'grid' : 'none';
  document.getElementById('form-manual').style.display = mode === 'manual' ? 'grid' : 'none';
}

/* ---------------- 啟動 ---------------- */
async function init() {
  document.getElementById('log-date').value = currentDate;
  fillProfileForm();
  bindEvents();
  await loadFoodDB();
  applySuggestions(false);
  renderAllForCurrentDate();
}

init();
