const DAILY_URL = 'https://lab.idealtrends.io/saude-entrega/daily';

chrome.runtime.onInstalled.addListener(() => {
  createDailyAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  createDailyAlarm();
});

function createDailyAlarm() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(11, 0, 0, 0);

  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  chrome.alarms.create('checkin-reminder', {
    delayInMinutes: (target - now) / 60000,
    periodInMinutes: 1440
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkin-reminder') {
    const today = new Date();
    if (today.getDay() === 0 || today.getDay() === 6) {
      return;
    }
    await checkAndNotify();
    await updateBadge();
  }
});

async function sendTelegram(msg) {
  const cfg = await chrome.storage.local.get(['config']);
  const token = cfg.config?.tgToken;
  const chatId = cfg.config?.tgChatId;
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' })
    });
  } catch (err) {
    console.log('sendTelegram error:', err.message);
  }
}

async function checkAndNotify() {
  try {
    const response = await fetch(DAILY_URL, { credentials: 'include' });
    if (!response.ok) return;

    const html = await response.text();
    const match = html.match(/data-page="([^"]*)"/);
    if (!match) return;

    const decoded = match[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');

    const pageData = JSON.parse(decoded);
    const cards = pageData.props?.cards || [];
    const hasCheckin = cards.some(card => card.existing);

    if (!hasCheckin) {
      const dateStr = new Date().toLocaleDateString('pt-BR');
      await sendTelegram(
        `⚠️ *Check-in pendente!*\n\nO check-in de *${dateStr}* ainda não foi preenchido no Ideal Lab.\n\nAcesse a extensão para preencher.`
      );
    }
  } catch (err) {
    console.log('checkAndNotify error:', err.message);
  }
}

async function updateBadge() {
  try {
    const response = await fetch(DAILY_URL, { credentials: 'include' });
    if (!response.ok) {
      chrome.action.setBadgeText({ text: '?' });
      chrome.action.setBadgeBackgroundColor({ color: '#888' });
      return;
    }

    const html = await response.text();
    const match = html.match(/data-page="([^"]*)"/);
    if (!match) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }

    const decoded = match[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');

    const pageData = JSON.parse(decoded);
    const cards = pageData.props?.cards || [];
    const hasCheckin = cards.some(card => card.existing);

    if (hasCheckin) {
      chrome.action.setBadgeText({ text: '' });
    } else {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#e53935' });
    }
  } catch (err) {
    console.log('updateBadge error:', err.message);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'refreshBadge') {
    updateBadge().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'triggerNotify') {
    checkAndNotify().then(() => sendResponse({ ok: true }));
    return true;
  }
});
