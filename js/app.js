/* ============================================================
   飲食紀錄本 · app.js
   ============================================================

   【跨裝置同步設定方式】
   1. 前往 https://console.firebase.google.com 建立專案
   2. 啟用 Firestore Database（選 production mode）
   3. 啟用 Authentication → Google 登入
   4. 點「專案設定」→「您的應用程式」→ 複製設定貼入下方
   5. 前往 Firestore → 規則，貼入 firebase-setup.md 中的安全規則
   詳細步驟請閱讀 firebase-setup.md

   若 FIREBASE_CONFIG.apiKey 為空字串，
   應用程式會自動切換到本機 localStorage 模式（所有功能仍可使用）。
   ============================================================ */

(function () {
  'use strict';

  // ──────────────────────────────────────────────
  // ① Firebase 設定（填入你的設定值，或保持空白使用本機模式）
  // ──────────────────────────────────────────────
  const FIREBASE_CONFIG = {
    apiKey:            '',   // 例：'AIzaSyXXXXXXXXXXXXXXXX'
    authDomain:        '',   // 例：'my-meal-app.firebaseapp.com'
    projectId:         '',   // 例：'my-meal-app'
    storageBucket:     '',   // 例：'my-meal-app.appspot.com'
    messagingSenderId: '',   // 例：'123456789012'
    appId:             ''    // 例：'1:123456789012:web:xxxxxxxxxxxxxxxx'
  };

  // ──────────────────────────────────────────────
  // ② 常數 & 全域狀態
  // ──────────────────────────────────────────────
  const USE_FIREBASE  = !!FIREBASE_CONFIG.apiKey;
  const LS_PREFIX     = 'mealLog:';
  const DEFAULT_GOAL  = 2000;
  const WEEKDAY_ZH    = ['日','一','二','三','四','五','六'];
  const MEAL_CONFIG   = [
    { key: 'breakfast', label: '早餐', accent: 'var(--gold)'  },
    { key: 'lunch',     label: '午餐', accent: 'var(--green)' },
    { key: 'dinner',    label: '晚餐', accent: 'var(--blue)'  }
  ];

  let currentDate = todayStr();
  let dayData     = emptyDay();
  let goal        = DEFAULT_GOAL;
  let profile     = { gender:'', age:'', height:'', weight:'' };
  let historyLoaded = false;

  // Firebase 執行期物件
  let db          = null;
  let currentUser = null;

  // ──────────────────────────────────────────────
  // ③ 通用工具
  // ──────────────────────────────────────────────
  function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function emptyDay() { return { breakfast: [], lunch: [], dinner: [] }; }
  function uid() {
    return (window.crypto?.randomUUID?.()) ||
      ('id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g,
      c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function round1(n) { return Math.round(n * 10) / 10; }

  function showStatus(msg) {
    const el = document.getElementById('statusMessage');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function parseLocalDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function dateWeekday(dateStr) {
    return WEEKDAY_ZH[parseLocalDate(dateStr).getDay()];
  }
  function weekMondayStr(dateStr) {
    const dt = parseLocalDate(dateStr);
    const dow = dt.getDay(); // 0=Sun
    const diff = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(dt);
    mon.setDate(dt.getDate() + diff);
    return `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;
  }

  // ──────────────────────────────────────────────
  // ④ Firebase 初始化 & 認證
  // ──────────────────────────────────────────────
  function initFirebase() {
    if (!USE_FIREBASE) return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      firebase.auth().onAuthStateChanged(async (user) => {
        currentUser = user;
        renderAuthUI();
        historyLoaded = false;
        await loadAll();
        renderAll();
        renderProfileForm();
      });
    } catch (e) {
      console.warn('Firebase 初始化失敗：', e);
    }
  }

  async function googleSignIn() {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      await firebase.auth().signInWithPopup(provider);
      // onAuthStateChanged 會自動觸發 loadAll + renderAll
    } catch (e) {
      showStatus('登入失敗：' + (e.message || '請稍後再試'));
    }
  }

  async function googleSignOut() {
    try {
      await firebase.auth().signOut();
      currentUser = null;
      renderAuthUI();
      showStatus('已登出，目前使用本機儲存');
      await loadAll();
      renderAll();
      renderProfileForm();
    } catch (e) {
      showStatus('登出失敗');
    }
  }

  // ──────────────────────────────────────────────
  // ⑤ 儲存層（Firestore ↔ localStorage 自動切換）
  // ──────────────────────────────────────────────

  /* ---- localStorage 底層 ---- */
  function lsGet(key) {
    try { return localStorage.getItem(LS_PREFIX + key); } catch { return null; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(LS_PREFIX + key, value); return true; } catch { return false; }
  }
  function lsListKeys(prefix) {
    try {
      const full = LS_PREFIX + prefix;
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(full)) keys.push(k.slice(LS_PREFIX.length));
      }
      return keys;
    } catch { return []; }
  }

  /* ---- 高層 API ---- */
  async function loadGoal() {
    if (currentUser && db) {
      try {
        const doc = await db.doc(`users/${currentUser.uid}/data/settings`).get();
        const n = doc.exists && doc.data().goal;
        return (n && n > 0) ? Number(n) : DEFAULT_GOAL;
      } catch {}
    }
    const raw = lsGet('goal');
    const n = Number(raw);
    return (raw && !isNaN(n) && n > 0) ? n : DEFAULT_GOAL;
  }

  async function saveGoal(value) {
    let ok = false;
    if (currentUser && db) {
      try {
        await db.doc(`users/${currentUser.uid}/data/settings`)
          .set({ goal: value }, { merge: true });
        ok = true;
      } catch {}
    } else {
      ok = lsSet('goal', String(value));
    }
    showStatus(ok ? '✅ 已儲存目標' : '❌ 儲存失敗');
  }

  async function loadDay(date) {
    if (currentUser && db) {
      try {
        const doc = await db.doc(`users/${currentUser.uid}/meals/${date}`).get();
        if (doc.exists) {
          const d = doc.data();
          return {
            breakfast: Array.isArray(d.breakfast) ? d.breakfast : [],
            lunch:     Array.isArray(d.lunch)     ? d.lunch     : [],
            dinner:    Array.isArray(d.dinner)     ? d.dinner    : []
          };
        }
        return emptyDay();
      } catch { return emptyDay(); }
    }
    const raw = lsGet(`meals:${date}`);
    if (!raw) return emptyDay();
    try {
      const p = JSON.parse(raw);
      return {
        breakfast: p.breakfast || [],
        lunch:     p.lunch     || [],
        dinner:    p.dinner    || []
      };
    } catch { return emptyDay(); }
  }

  async function saveDay(date, data) {
    let ok = false;
    if (currentUser && db) {
      try {
        await db.doc(`users/${currentUser.uid}/meals/${date}`).set(data);
        ok = true;
      } catch {}
    } else {
      ok = lsSet(`meals:${date}`, JSON.stringify(data));
    }
    showStatus(ok ? '✅ 已儲存' : '❌ 儲存失敗');
  }

  async function loadProfile() {
    const fb = { gender:'', age:'', height:'', weight:'' };
    if (currentUser && db) {
      try {
        const doc = await db.doc(`users/${currentUser.uid}/data/profile`).get();
        return doc.exists ? { ...fb, ...doc.data() } : fb;
      } catch {}
    }
    const raw = lsGet('profile');
    if (!raw) return fb;
    try { return { ...fb, ...JSON.parse(raw) }; } catch { return fb; }
  }

  async function saveProfile(p) {
    let ok = false;
    if (currentUser && db) {
      try { await db.doc(`users/${currentUser.uid}/data/profile`).set(p); ok = true; } catch {}
    } else {
      ok = lsSet('profile', JSON.stringify(p));
    }
    showStatus(ok ? '✅ 已儲存個人資料' : '❌ 儲存失敗');
  }

  /** 傳回 { [date]: dayData } 的完整歷史字典 */
  async function listAllDays() {
    const result = {};
    if (currentUser && db) {
      try {
        const snap = await db.collection(`users/${currentUser.uid}/meals`).get();
        snap.forEach(doc => { result[doc.id] = doc.data(); });
        return result;
      } catch { return result; }
    }
    lsListKeys('meals:').forEach(key => {
      const date = key.slice(6);
      const raw  = lsGet(key);
      if (raw) { try { result[date] = JSON.parse(raw); } catch {} }
    });
    return result;
  }

  // ──────────────────────────────────────────────
  // ⑥ 計算
  // ──────────────────────────────────────────────
  function mealTotal(items) {
    return items.reduce(
      (a, it) => ({ cal: a.cal + (Number(it.cal) || 0), protein: a.protein + (Number(it.protein) || 0) }),
      { cal: 0, protein: 0 }
    );
  }
  function dayTotal(data) {
    return MEAL_CONFIG.reduce((a, m) => {
      const t = mealTotal(data[m.key] || []);
      return { cal: a.cal + t.cal, protein: a.protein + t.protein };
    }, { cal: 0, protein: 0 });
  }
  function bmiCategory(bmi) {
    if (bmi < 18.5) return '過輕';
    if (bmi < 24)   return '健康體重';
    if (bmi < 27)   return '過重';
    if (bmi < 30)   return '輕度肥胖';
    if (bmi < 35)   return '中度肥胖';
    return '重度肥胖';
  }

  // ──────────────────────────────────────────────
  // ⑦ Auth UI 渲染
  // ──────────────────────────────────────────────
  function renderAuthUI() {
    const banner = document.getElementById('authBanner');
    if (!USE_FIREBASE) { banner.hidden = true; return; }
    banner.hidden = false;

    const dot   = document.getElementById('authDot');
    const label = document.getElementById('authLabel');
    const btn   = document.getElementById('authBtn');

    if (currentUser) {
      const name = currentUser.displayName || currentUser.email || '使用者';
      dot.className   = 'auth-dot signed-in';
      label.textContent = `${name} · 跨裝置同步已開啟`;
      btn.textContent = '登出';
      btn.className   = 'auth-btn signed-in';
      btn.onclick     = googleSignOut;
    } else {
      dot.className   = 'auth-dot signed-out';
      label.textContent = '未登入・資料僅存於本裝置';
      btn.textContent = '用 Google 登入以跨裝置同步';
      btn.className   = 'auth-btn';
      btn.onclick     = googleSignIn;
    }
  }

  // ──────────────────────────────────────────────
  // ⑧ 主介面渲染
  // ──────────────────────────────────────────────
  function renderMeals() {
    const container = document.getElementById('mealsContainer');
    container.innerHTML = MEAL_CONFIG.map(meal => {
      const items  = dayData[meal.key] || [];
      const totals = mealTotal(items);
      const itemsHtml = items.length === 0
        ? `<p class="empty-state">還沒有紀錄，新增第一筆吧</p>`
        : `<ul class="item-list">${items.map(it => `
            <li class="item-row">
              <span class="item-name">${esc(it.name)}</span>
              <span class="item-cal">${Math.round(it.cal)} kcal</span>
              <span class="item-protein">${round1(it.protein)} g</span>
              <button class="delete-btn"
                data-meal="${meal.key}" data-id="${it.id}"
                aria-label="刪除 ${esc(it.name)}">×</button>
            </li>`).join('')}</ul>`;

      return `
        <div class="meal-card" style="--accent:${meal.accent}">
          <div class="meal-header">
            <h2>${meal.label}</h2>
            <span class="meal-subtotal">
              ${Math.round(totals.cal)} kcal · ${round1(totals.protein)} g 蛋白質
            </span>
          </div>
          ${itemsHtml}
          <form class="add-form" data-meal="${meal.key}" novalidate>
            <input type="text"   name="name"    placeholder="餐點名稱"     maxlength="60" required autocomplete="off">
            <input type="number" name="cal"     placeholder="熱量 (kcal)" min="0" step="1"   required inputmode="decimal">
            <input type="number" name="protein" placeholder="蛋白質 (g)"  min="0" step="0.1"          inputmode="decimal">
            <button type="submit">＋ 新增</button>
            <div class="form-error" hidden></div>
          </form>
        </div>`;
    }).join('');
  }

  function renderSummary() {
    const totals  = dayTotal(dayData);
    const pctRaw  = goal > 0 ? (totals.cal / goal) * 100 : 0;
    const pct     = Math.min(100, Math.max(0, pctRaw));
    const over    = totals.cal > goal;
    const color   = over ? 'var(--red)' : pctRaw >= 80 ? 'var(--gold)' : 'var(--green)';
    const status  = over
      ? `已超出目標 ${Math.round(totals.cal - goal)} kcal`
      : `還剩 ${Math.round(goal - totals.cal)} kcal`;

    document.getElementById('summaryContainer').innerHTML = `
      <div class="nutrition-label">
        <p class="label-eyebrow">NUTRITION FACTS</p>
        <h2 class="label-title">本日營養成分</h2>
        <div class="label-rule thick"></div>
        <div class="label-row">
          <span>熱量合計</span>
          <span class="value">${Math.round(totals.cal)} <small>kcal</small></span>
        </div>
        <div class="label-rule"></div>
        <div class="label-row">
          <span>每日目標</span>
          <span class="value">${Math.round(goal)} <small>kcal</small></span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <div class="label-status">${status}</div>
        <div class="label-rule"></div>
        <div class="label-row">
          <span>蛋白質合計</span>
          <span class="value">${round1(totals.protein)} <small>g</small></span>
        </div>
      </div>`;
  }

  function renderAll() {
    document.getElementById('dateInput').value = currentDate;
    document.getElementById('goalInput').value = goal;
    renderMeals();
    renderSummary();
  }

  // ──────────────────────────────────────────────
  // ⑨ 個人資料 & BMI
  // ──────────────────────────────────────────────
  function renderProfileForm() {
    document.getElementById('profileContainer').innerHTML = `
      <div class="profile-card">
        <p class="label-eyebrow">PERSONAL PROFILE</p>
        <h2 class="label-title">個人資料</h2>
        <div class="label-rule thick"></div>
        <div class="profile-grid">
          <label>性別
            <select id="genderInput">
              <option value="">未填寫</option>
              <option value="male">男</option>
              <option value="female">女</option>
              <option value="other">不透露</option>
            </select>
          </label>
          <label>年齡
            <input type="number" id="ageInput" min="1" max="120"
              placeholder="歲" inputmode="decimal">
          </label>
          <label>身高 (cm)
            <input type="number" id="heightInput" min="50" max="250" step="0.1"
              placeholder="165" inputmode="decimal">
          </label>
          <label>體重 (kg)
            <input type="number" id="weightInput" min="20" max="300" step="0.1"
              placeholder="60" inputmode="decimal">
          </label>
        </div>
        <div class="label-rule"></div>
        <div class="label-row">
          <span>BMI</span>
          <span class="value" id="bmiValue">--</span>
        </div>
        <div class="label-status" id="bmiCategory">請輸入身高與體重</div>
        <div class="label-rule"></div>
        <div class="label-row">
          <span>減重建議蛋白質</span>
          <span class="value" id="proteinSuggestion">--</span>
        </div>
        <p class="profile-note">蛋白質建議採每公斤體重 1.2–1.6 g 估算；BMI 分類依衛福部國健署標準。僅供一般參考，特殊健康狀況請諮詢醫師或營養師。</p>
      </div>`;

    // 填入已儲存數值
    document.getElementById('genderInput').value = profile.gender || '';
    document.getElementById('ageInput').value    = profile.age    || '';
    document.getElementById('heightInput').value = profile.height || '';
    document.getElementById('weightInput').value = profile.weight || '';

    ['genderInput','ageInput','heightInput','weightInput'].forEach(id =>
      document.getElementById(id).addEventListener('change', onProfileChange)
    );
    updateBMI();
  }

  async function onProfileChange() {
    profile = {
      gender: document.getElementById('genderInput').value,
      age:    document.getElementById('ageInput').value,
      height: document.getElementById('heightInput').value,
      weight: document.getElementById('weightInput').value
    };
    updateBMI();
    await saveProfile(profile);
  }

  function updateBMI() {
    const h = Number(profile.height);
    const w = Number(profile.weight);
    const bmiEl  = document.getElementById('bmiValue');
    const catEl  = document.getElementById('bmiCategory');
    const protEl = document.getElementById('proteinSuggestion');
    if (!bmiEl) return;
    if (!h || !w || h <= 0 || w <= 0) {
      bmiEl.innerHTML = '--';
      catEl.textContent = '請輸入身高與體重';
      protEl.innerHTML = '--';
      return;
    }
    const bmi = w / ((h / 100) ** 2);
    bmiEl.innerHTML = bmi.toFixed(1);
    catEl.textContent = bmiCategory(bmi);
    protEl.innerHTML = `${(w * 1.2).toFixed(0)}–${(w * 1.6).toFixed(0)} <small>g/天</small>`;
  }

  // ──────────────────────────────────────────────
  // ⑩ 歷史圖表 & 列表
  // ──────────────────────────────────────────────
  function buildChartSVG(history, goalVal) {
    if (!history.length) return `<p class="loading-text">還沒有任何歷史資料。</p>`;
    const W = Math.max(320, history.length * 46);
    const H = 180, PT = 14, PB = 28;
    const maxVal = Math.max(goalVal, ...history.map(d => d.cal)) * 1.12 || 1;
    const bW = (W / history.length) * 0.55;
    const sy = v => PT + (H - PT - PB) * (1 - v / maxVal);

    const bars = history.map((d, i) => {
      const x  = (W / history.length) * i + (W / history.length - bW) / 2;
      const y  = sy(d.cal);
      const bH = Math.max(0, H - PB - y);
      const fill = d.cal > goalVal ? 'var(--red)' : 'var(--green)';
      const lbl  = d.date.slice(5).replace('-', '/');
      return `
        <rect x="${x}" y="${y}" width="${bW}" height="${bH}" fill="${fill}" rx="2"/>
        <text x="${x + bW/2}" y="${H-8}" font-size="10"
          font-family="var(--font-mono)" fill="var(--ink-soft)"
          text-anchor="middle">${lbl}</text>`;
    }).join('');

    const gy = sy(goalVal);
    return `
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}"
           role="img" aria-label="近期每日熱量趨勢圖">
        <line x1="0" y1="${gy}" x2="${W}" y2="${gy}"
          stroke="var(--blue)" stroke-width="1.5" stroke-dasharray="4 4"/>
        <text x="4" y="${gy - 4}" font-size="10"
          font-family="var(--font-mono)" fill="var(--blue)">
          目標 ${Math.round(goalVal)}
        </text>
        ${bars}
      </svg>`;
  }

  function buildHistoryTable(allDays) {
    const dates = Object.keys(allDays).sort().reverse();
    if (!dates.length) return `<p class="loading-text">還沒有任何歷史資料。</p>`;
    const rows = dates.map(date => {
      const totals = dayTotal(allDays[date]);
      const diff   = totals.cal - goal;
      const diffTxt = diff <= 0 ? `剩 ${Math.round(-diff)}` : `超出 ${Math.round(diff)}`;
      return `
        <tr class="clickable" data-date="${date}" tabindex="0">
          <td>${date}（${dateWeekday(date)}）</td>
          <td>${Math.round(totals.cal)}</td>
          <td>${round1(totals.protein)}</td>
          <td>${diffTxt}</td>
        </tr>`;
    }).join('');
    return `
      <table class="history-table">
        <thead>
          <tr><th>日期</th><th>熱量 kcal</th><th>蛋白質 g</th><th>與目標差</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  async function loadHistory() {
    document.getElementById('chartContainer').innerHTML       = `<p class="loading-text">載入中…</p>`;
    document.getElementById('historyTableContainer').innerHTML = `<p class="loading-text">載入中…</p>`;
    const allDays = await listAllDays();
    const sorted  = Object.keys(allDays).sort();
    const chartData = sorted.slice(-14).map(d => ({ date: d, ...dayTotal(allDays[d]) }));
    document.getElementById('chartContainer').innerHTML       = buildChartSVG(chartData, goal);
    document.getElementById('historyTableContainer').innerHTML = buildHistoryTable(allDays);
    historyLoaded = true;
  }

  // ──────────────────────────────────────────────
  // ⑪ 匯出
  // ──────────────────────────────────────────────

  /**
   * 匯出本週摘要文字（複製到剪貼簿，可直接貼給 AI）
   */
  async function exportWeeklySummary() {
    showStatus('正在產生週報…');
    const allDays = await listAllDays();
    const monStr  = weekMondayStr(currentDate);
    const monDate = parseLocalDate(monStr);

    // 本週七天
    const weekDates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monDate);
      d.setDate(monDate.getDate() + i);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    });

    const lines = [];
    const endStr = weekDates[6].slice(5).replace('-', '/');
    lines.push(`=== 飲食週報 ${monStr.slice(5).replace('-','/')}（一）～ ${endStr}（日）===`);
    lines.push('');

    // 個人基本資料
    if (profile.height && profile.weight) {
      const bmi = Number(profile.weight) / ((Number(profile.height) / 100) ** 2);
      lines.push(`身高 ${profile.height} cm｜體重 ${profile.weight} kg｜BMI ${bmi.toFixed(1)}（${bmiCategory(bmi)}）`);
    }
    const genderMap = { male:'男', female:'女', other:'不透露' };
    if (profile.gender) lines.push(`性別：${genderMap[profile.gender] || ''}　年齡：${profile.age || '--'} 歲`);
    lines.push(`每日卡路里目標：${Math.round(goal)} kcal`);
    lines.push('');

    let totalCal = 0, totalProtein = 0, recordedDays = 0;

    weekDates.forEach(date => {
      const data = allDays[date];
      const wd   = dateWeekday(date);
      const mmdd = date.slice(5).replace('-', '/');

      if (!data || MEAL_CONFIG.every(m => !(data[m.key] || []).length)) {
        lines.push(`📅 ${mmdd}（${wd}） — 無紀錄`);
        lines.push('');
        return;
      }

      recordedDays++;
      const dt = dayTotal(data);
      totalCal     += dt.cal;
      totalProtein += dt.protein;

      lines.push(`📅 ${mmdd}（${wd}）`);
      MEAL_CONFIG.forEach(m => {
        const items = data[m.key] || [];
        if (!items.length) return;
        const mt = mealTotal(items);
        const itemList = items
          .map(it => `${it.name} ${Math.round(it.cal)} kcal ／ 蛋白質 ${round1(it.protein)} g`)
          .join('　');
        lines.push(`  ${m.label}：${itemList}`);
        lines.push(`    ▸ 小計：${Math.round(mt.cal)} kcal ／ 蛋白質 ${round1(mt.protein)} g`);
      });
      const pct = Math.round((dt.cal / goal) * 100);
      lines.push(`  ── 當日合計：${Math.round(dt.cal)} kcal｜蛋白質 ${round1(dt.protein)} g｜達成率 ${pct}%`);
      lines.push('');
    });

    lines.push('── 本週統計 ──');
    lines.push(`有紀錄天數：${recordedDays} / 7 天`);
    if (recordedDays > 0) {
      lines.push(`平均每日熱量：${Math.round(totalCal / recordedDays)} kcal`);
      lines.push(`平均每日蛋白質：${round1(totalProtein / recordedDays)} g`);
      const achieved = weekDates.filter(d => allDays[d] && dayTotal(allDays[d]).cal <= goal).length;
      lines.push(`目標達成天數（未超標）：${achieved} / ${recordedDays} 天`);
    }
    lines.push('');
    lines.push('（此摘要由飲食紀錄本自動生成，可直接貼給 AI 詢問飲食建議或分析）');

    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showStatus('✅ 週報已複製！貼給 AI 即可詢問建議');
    } catch {
      // 降級：建立隱藏 textarea
      const ta = document.createElement('textarea');
      ta.value = text;
      Object.assign(ta.style, { position:'fixed', opacity:'0', top:'0', left:'0' });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showStatus('✅ 週報已複製！貼給 AI 即可詢問建議');
    }
  }

  /**
   * 匯出全部歷史紀錄為 CSV（帶 BOM，Excel 可直接開啟）
   */
  async function exportCSV() {
    showStatus('正在整理資料…');
    const allDays = await listAllDays();
    const dates = Object.keys(allDays).sort();

    const rows = [['日期', '星期', '餐別', '餐點名稱', '熱量(kcal)', '蛋白質(g)']];
    dates.forEach(date => {
      const data = allDays[date];
      MEAL_CONFIG.forEach(m => {
        (data[m.key] || []).forEach(it => {
          rows.push([
            date,
            dateWeekday(date),
            m.label,
            it.name,
            Math.round(it.cal),
            round1(it.protein)
          ]);
        });
      });
    });

    const csv  = rows.map(r =>
      r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')
    ).join('\r\n');

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `飲食紀錄_${todayStr()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showStatus('✅ CSV 已下載');
  }

  // ──────────────────────────────────────────────
  // ⑫ 事件監聽
  // ──────────────────────────────────────────────
  document.getElementById('dateInput').addEventListener('change', async e => {
    currentDate = e.target.value || todayStr();
    dayData = await loadDay(currentDate);
    renderAll();
  });

  document.getElementById('todayBtn').addEventListener('click', async () => {
    currentDate = todayStr();
    dayData = await loadDay(currentDate);
    renderAll();
  });

  document.getElementById('goalInput').addEventListener('change', async e => {
    const n = Number(e.target.value);
    if (isNaN(n) || n <= 0) { e.target.value = goal; showStatus('請輸入大於 0 的目標'); return; }
    goal = n;
    await saveGoal(goal);
    renderSummary();
    historyLoaded = false;
  });

  document.getElementById('historyToggle').addEventListener('click', async () => {
    const panel = document.getElementById('historyPanel');
    const btn   = document.getElementById('historyToggle');
    const show  = panel.hidden;
    panel.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    btn.textContent = show ? '收合歷史紀錄 & 匯出' : '查看歷史紀錄 & 匯出';
    if (show && !historyLoaded) await loadHistory();
  });

  document.getElementById('historyTableContainer').addEventListener('click', async e => {
    const row = e.target.closest('tr.clickable');
    if (!row) return;
    currentDate = row.dataset.date;
    dayData = await loadDay(currentDate);
    renderAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  document.getElementById('mealsContainer').addEventListener('submit', async e => {
    if (!e.target.classList.contains('add-form')) return;
    e.preventDefault();
    const form    = e.target;
    const meal    = form.dataset.meal;
    const errEl   = form.querySelector('.form-error');
    const name    = form.elements.name.value.trim();
    const calRaw  = form.elements.cal.value;
    const protRaw = form.elements.protein.value;
    const cal     = Number(calRaw);
    const protein = protRaw === '' ? 0 : Number(protRaw);

    if (!name)                          { errEl.textContent = '請輸入餐點名稱';  errEl.hidden = false; return; }
    if (calRaw==='' || isNaN(cal) || cal<0) { errEl.textContent = '請輸入有效熱量';  errEl.hidden = false; return; }
    if (isNaN(protein) || protein < 0)  { errEl.textContent = '請輸入有效蛋白質'; errEl.hidden = false; return; }
    errEl.hidden = true;

    dayData[meal].push({ id: uid(), name, cal, protein });
    await saveDay(currentDate, dayData);
    renderAll();
    historyLoaded = false;

    // 清空表單並重新聚焦（手機體驗更流暢）
    form.elements.name.value    = '';
    form.elements.cal.value     = '';
    form.elements.protein.value = '';
    form.elements.name.focus();
  });

  document.getElementById('mealsContainer').addEventListener('click', async e => {
    const btn = e.target.closest('.delete-btn');
    if (!btn) return;
    const { meal, id } = btn.dataset;
    dayData[meal] = dayData[meal].filter(it => it.id !== id);
    await saveDay(currentDate, dayData);
    renderAll();
    historyLoaded = false;
  });

  document.getElementById('exportWeekBtn').addEventListener('click', exportWeeklySummary);
  document.getElementById('exportCSVBtn').addEventListener('click', exportCSV);

  // ──────────────────────────────────────────────
  // ⑬ 初始化
  // ──────────────────────────────────────────────
  function hasLocalStorage() {
    try {
      const k = LS_PREFIX + '__test__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch { return false; }
  }

  async function loadAll() {
    goal    = await loadGoal();
    dayData = await loadDay(currentDate);
    profile = await loadProfile();
  }

  async function init() {
    if (!hasLocalStorage()) {
      document.getElementById('storageWarning').hidden = false;
    }

    if (USE_FIREBASE) {
      // Firebase onAuthStateChanged 會處理後續的 loadAll + render
      initFirebase();
    } else {
      renderAuthUI(); // 隱藏 auth banner
      await loadAll();
      renderAll();
      renderProfileForm();
    }
  }

  init();
})();
