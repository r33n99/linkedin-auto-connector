// Попап: настройки, счётчики и кнопки старт/стоп для активной вкладки.

const {
  loadSettings,
  saveSettings,
  loadStats,
  resetStats,
  parseKeywords,
  formatKeywords,
  peopleSearchUrl,
  setPendingStart,
  renderNote,
  NOTE_MAX,
  STATS_KEY,
} = self.LAC;

const NUMBER_FIELDS = [
  'dailyLimit',
  'weeklyLimit',
  'delayMinSec',
  'delayMaxSec',
  'longPauseEvery',
  'longPauseSec',
];

const $ = (id) => document.getElementById(id);
const pageState = $('page-state');
const savedBadge = $('saved');

let activeTabId = null;

// --- Настройки ---------------------------------------------------------------

async function fillForm() {
  const settings = await loadSettings();
  for (const key of NUMBER_FIELDS) $(key).value = settings[key];
  $('searchQuery').value = settings.searchQuery;
  $('noteMode').value = settings.noteMode;
  $('noteTemplate').value = settings.noteTemplate;
  $('includeKeywords').value = formatKeywords(settings.includeKeywords);
  $('excludeKeywords').value = formatKeywords(settings.excludeKeywords);
  $('autoNextPage').checked = settings.autoNextPage;
  syncNoteUi();
  return settings;
}

// Счётчик считает длину уже после подстановки: в поле «{{firstName}}» занимает
// 13 символов, а в отправленной записке — длину имени.
function syncNoteUi() {
  const template = $('noteTemplate').value;
  const preview = renderNote(template, { name: 'Иван Петров', headline: 'Frontend Developer' });
  const withNote = $('noteMode').value === 'note';

  $('noteCount').textContent = `${preview.length} / ${NOTE_MAX}`;
  $('noteCount').classList.toggle('maxed', preview.length >= NOTE_MAX);
  $('noteTemplate').disabled = !withNote;
  $('noteTemplate').closest('.field').style.opacity = withNote ? '1' : '0.5';
}

function readForm() {
  const patch = {};
  for (const key of NUMBER_FIELDS) {
    const input = $(key);
    const value = Number(input.value);
    const min = Number(input.min);
    const max = Number(input.max);
    const valid = Number.isFinite(value) && value >= min && value <= max;
    input.classList.toggle('invalid', !valid);
    if (valid) patch[key] = value;
  }
  // Диапазон паузы не должен схлопываться наоборот.
  if (patch.delayMinSec != null && patch.delayMaxSec != null && patch.delayMinSec > patch.delayMaxSec) {
    patch.delayMaxSec = patch.delayMinSec;
    $('delayMaxSec').value = patch.delayMaxSec;
  }
  patch.includeKeywords = parseKeywords($('includeKeywords').value);
  patch.excludeKeywords = parseKeywords($('excludeKeywords').value);
  patch.autoNextPage = $('autoNextPage').checked;
  patch.noteMode = $('noteMode').value;
  patch.noteTemplate = $('noteTemplate').value;
  return patch;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings(readForm());
    await renderStats();
    flashSaved();
  }, 350);
}

function flashSaved() {
  savedBadge.classList.add('show');
  setTimeout(() => savedBadge.classList.remove('show'), 1200);
}

// --- Счётчики ----------------------------------------------------------------

async function renderStats() {
  const [settings, stats] = await Promise.all([loadSettings(), loadStats()]);
  $('stat-day').textContent = `${stats.daySent} / ${settings.dailyLimit}`;
  $('stat-week').textContent = `${stats.weekSent} / ${settings.weeklyLimit}`;
  $('stat-total').textContent = String(stats.totalSent);
  $('stat-day').classList.toggle('maxed', stats.daySent >= settings.dailyLimit);
  $('stat-week').classList.toggle('maxed', stats.weekSent >= settings.weeklyLimit);
}

// --- Связь с вкладкой --------------------------------------------------------

function setPageState(message, kind = '') {
  pageState.textContent = message;
  pageState.className = `page-state ${kind}`.trim();
}

async function syncTabState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  if (!tab?.url?.includes('linkedin.com')) {
    setPageState('Откройте поиск людей в LinkedIn', 'warn');
    $('start').disabled = true;
    $('stop').disabled = true;
    return;
  }

  let state = null;
  try {
    state = await chrome.tabs.sendMessage(tab.id, { type: 'LAC_STATE' });
  } catch {
    // Content script ещё не внедрён — например, вкладка открыта до установки.
    setPageState('Обновите вкладку LinkedIn (F5)', 'warn');
    $('start').disabled = true;
    $('stop').disabled = true;
    return;
  }

  if (!state?.onSearchPage) {
    setPageState('Нужна страница «Поиск → Люди»', 'warn');
    $('start').disabled = true;
    $('stop').disabled = true;
    return;
  }

  setPageState(state.running ? `Работает: ${state.status}` : 'Вкладка готова', state.running ? '' : 'ready');
  $('start').disabled = state.running;
  $('stop').disabled = !state.running;
}

// Открывает выдачу «Люди» по запросу и просит страницу стартовать сразу после
// загрузки. Прямой переход по адресу вместо ввода в строку поиска и клика по
// вкладке «Люди»: результат тот же, а ломаться нечему.
async function searchAndStart() {
  const query = $('searchQuery').value.trim();
  if (!query) {
    setPageState('Впиши, кого искать', 'warn');
    $('searchQuery').focus();
    return;
  }

  await saveSettings({ searchQuery: query });
  await setPendingStart();

  const url = peopleSearchUrl(query);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.includes('linkedin.com')) {
    await chrome.tabs.create({ url });
  } else if (tab.url === url) {
    // Тот же адрес — навигации не будет, а значит и content script не перезапустится.
    await chrome.tabs.reload(tab.id);
  } else {
    await chrome.tabs.update(tab.id, { url });
  }

  window.close();
}

async function send(type) {
  if (activeTabId == null) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, { type });
  } catch {
    setPageState('Вкладка не отвечает, обновите страницу', 'warn');
  }
  setTimeout(syncTabState, 300);
}

// --- Инициализация -----------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  await fillForm();
  await renderStats();
  await syncTabState();

  $('settings').addEventListener('input', () => {
    syncNoteUi();
    scheduleSave();
  });
  $('noteMode').addEventListener('change', () => {
    syncNoteUi();
    scheduleSave();
  });
  $('searchStart').addEventListener('click', searchAndStart);
  $('searchQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchAndStart();
  });
  $('start').addEventListener('click', () => send('LAC_START'));
  $('stop').addEventListener('click', () => send('LAC_STOP'));
  $('reset').addEventListener('click', async () => {
    await resetStats();
    await renderStats();
    flashSaved();
  });

  // Счётчики растут прямо во время работы — обновляем попап без перезагрузки.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATS_KEY]) renderStats();
  });

  setInterval(syncTabState, 2000);
});
