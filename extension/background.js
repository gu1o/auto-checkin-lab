// background.js — service worker MV3 do modo automatico (Fase 5).
//
// Um alarme diario (chrome.alarms) roda o check-in no horario configurado na
// aba Configuracoes, usando a sessao viva do navegador (cookies via
// host_permissions) — sem cookie manual e sem cron. So precisa do Chrome
// aberto e do login valido no Lab.

importScripts('lib.js');

const ALARM_NAME = 'auto-checkin';

// Proximo timestamp (ms) do horario HH:MM local; se ja passou hoje, amanha.
function nextAlarmTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const next = new Date();
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

async function reschedule() {
  const cfg = await loadConfigData();
  await chrome.alarms.clear(ALARM_NAME);
  if (cfg.autoEnabled && cfg.autoTime && /^\d{1,2}:\d{2}$/.test(cfg.autoTime)) {
    chrome.alarms.create(ALARM_NAME, {
      when: nextAlarmTime(cfg.autoTime),
      periodInMinutes: 24 * 60
    });
  }
}

chrome.runtime.onInstalled.addListener(reschedule);
chrome.runtime.onStartup.addListener(reschedule);

// Salvou config no popup? Reagenda (cobre toggle, mudanca de horario, etc.).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.config) reschedule();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const result = await runAutoCheckin();
  console.log('[lab-checkin] auto:', result.status, '-', result.detail);
});
