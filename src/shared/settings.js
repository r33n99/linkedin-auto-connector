// Общие настройки, счётчики и мелкие утилиты.
// Файл грузится и в content script, и в попап, поэтому без ES-модулей —
// всё складывается в глобальный объект LAC.

(() => {
  const DEFAULTS = {
    // Сколько приглашений максимум за сутки. LinkedIn терпимо относится к ~20-25,
    // выше начинается риск ограничения аккаунта.
    dailyLimit: 20,
    // И потолок на неделю — именно недельный лимит LinkedIn режет чаще всего.
    weeklyLimit: 90,
    // Пауза между приглашениями, секунды (берётся случайное число из диапазона).
    delayMinSec: 8,
    delayMaxSec: 22,
    // Каждые N приглашений — длинный перерыв, чтобы ритм не был машинным.
    longPauseEvery: 8,
    longPauseSec: 120,
    // Фильтры по тексту карточки (должность/компания). Пустой include = берём всех.
    includeKeywords: [],
    excludeKeywords: [],
    // Переходить на следующую страницу выдачи, когда текущая закончилась.
    autoNextPage: true,
    // Последний поисковый запрос — чтобы не набирать его заново.
    searchQuery: '',
    // 'plain' — сразу «Отправить без заметки», 'note' — сначала «Персонализировать».
    noteMode: 'plain',
    noteTemplate: '',
  };

  // LinkedIn обрезает записку к приглашению; держим консервативный потолок,
  // чтобы текст не уехал в середине слова.
  const NOTE_MAX = 200;

  // Шаблон записки: {{firstName}}, {{name}}, {{headline}}.
  // Неизвестные плейсхолдеры вычищаются, иначе человек получит «{{company}}».
  function renderNote(template, person = {}) {
    const name = String(person.name || '').trim();
    const values = {
      firstname: name.split(/\s+/)[0] || '',
      name,
      headline: String(person.headline || '').trim(),
    };

    return String(template || '')
      .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => values[key.toLowerCase()] ?? '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
      .slice(0, NOTE_MAX);
  }

  const STATS_KEY = 'lac_stats';
  const SETTINGS_KEY = 'lac_settings';
  const PENDING_KEY = 'lac_pending_start';

  // Вкладку «Люди» кликать не нужно: этот адрес и есть уже выбранная вкладка
  // «Люди» в выдаче. На один хрупкий шаг по чужому интерфейсу меньше.
  const peopleSearchUrl = (query) =>
    `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
      query
    )}&origin=GLOBAL_SEARCH_HEADER`;

  // Флаг «после перехода сразу стартовать»: попап ставит, страница забирает.
  async function setPendingStart() {
    await chrome.storage.local.set({ [PENDING_KEY]: Date.now() });
  }

  async function takePendingStart() {
    const raw = await chrome.storage.local.get(PENDING_KEY);
    const stamp = raw[PENDING_KEY];
    if (!stamp) return false;
    await chrome.storage.local.remove(PENDING_KEY);
    // Просроченный флаг игнорируем, иначе он выстрелит через сутки на случайной вкладке.
    return Date.now() - stamp < 60_000;
  }

  const pad = (n) => String(n).padStart(2, '0');

  function dayKey(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ISO-неделя: понедельник — начало, чтобы недельный счётчик совпадал с логикой LinkedIn.
  function weekKey(d = new Date()) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dow = t.getUTCDay() || 7; // вс = 7
    t.setUTCDate(t.getUTCDate() + 4 - dow);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
    return `${t.getUTCFullYear()}-W${pad(week)}`;
  }

  const emptyStats = () => ({
    day: dayKey(),
    daySent: 0,
    week: weekKey(),
    weekSent: 0,
    totalSent: 0,
    // Момент, когда LinkedIn показал модалку с лимитом приглашений.
    blockedAt: null,
  });

  async function loadSettings() {
    const raw = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULTS, ...(raw[SETTINGS_KEY] || {}) };
  }

  async function saveSettings(patch) {
    const next = { ...(await loadSettings()), ...patch };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  // Читает счётчики и по пути обнуляет их при смене суток/недели.
  async function loadStats() {
    const raw = await chrome.storage.local.get(STATS_KEY);
    const stats = { ...emptyStats(), ...(raw[STATS_KEY] || {}) };
    let dirty = false;

    if (stats.day !== dayKey()) {
      stats.day = dayKey();
      stats.daySent = 0;
      dirty = true;
    }
    if (stats.week !== weekKey()) {
      stats.week = weekKey();
      stats.weekSent = 0;
      dirty = true;
    }
    if (dirty) await chrome.storage.local.set({ [STATS_KEY]: stats });
    return stats;
  }

  async function bumpSent() {
    const stats = await loadStats();
    stats.daySent += 1;
    stats.weekSent += 1;
    stats.totalSent += 1;
    await chrome.storage.local.set({ [STATS_KEY]: stats });
    return stats;
  }

  async function markBlocked() {
    const stats = await loadStats();
    stats.blockedAt = Date.now();
    await chrome.storage.local.set({ [STATS_KEY]: stats });
    return stats;
  }

  async function resetStats() {
    const stats = emptyStats();
    await chrome.storage.local.set({ [STATS_KEY]: stats });
    return stats;
  }

  const parseKeywords = (str) =>
    String(str || '')
      .split(/[,\n]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

  const formatKeywords = (arr) => (arr || []).join(', ');

  const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Ожидание с возможностью прерваться: shouldContinue() опрашивается каждые 250 мс.
  async function interruptibleSleep(ms, shouldContinue = () => true) {
    const step = 250;
    for (let waited = 0; waited < ms; waited += step) {
      if (!shouldContinue()) return false;
      await sleep(Math.min(step, ms - waited));
    }
    return shouldContinue();
  }

  self.LAC = {
    DEFAULTS,
    STATS_KEY,
    SETTINGS_KEY,
    PENDING_KEY,
    NOTE_MAX,
    renderNote,
    peopleSearchUrl,
    setPendingStart,
    takePendingStart,
    loadSettings,
    saveSettings,
    loadStats,
    bumpSent,
    markBlocked,
    resetStats,
    parseKeywords,
    formatKeywords,
    randInt,
    sleep,
    interruptibleSleep,
    dayKey,
    weekKey,
  };
})();
