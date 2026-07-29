// Служебный воркер: значения по умолчанию при установке и счётчик на иконке.

importScripts('/src/shared/settings.js');

const { loadSettings, saveSettings, loadStats, STATS_KEY } = self.LAC;

async function updateBadge() {
  const [settings, stats] = await Promise.all([loadSettings(), loadStats()]);
  await chrome.action.setBadgeText({ text: stats.daySent ? String(stats.daySent) : '' });
  await chrome.action.setBadgeBackgroundColor({
    color: stats.daySent >= settings.dailyLimit ? '#c0392b' : '#0a66c2',
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  // saveSettings мержит с дефолтами, так что достаточно пустого патча.
  await saveSettings({});
  await updateBadge();
});

chrome.runtime.onStartup.addListener(updateBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STATS_KEY]) updateBadge();
});

updateBadge();
