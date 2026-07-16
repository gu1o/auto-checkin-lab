// popup.js — UI da extensao. A logica de coleta/geracao/envio vive em lib.js
// (compartilhada com o background.js do modo automatico).

// Navigation Tabs
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    const tabId = btn.getAttribute('data-tab');
    document.getElementById(tabId).classList.add('active');
  });
});

// Toast Helper
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.innerText = message;
  toast.className = `toast ${type}`;

  setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

// Session Check
async function checkSession() {
  const banner = document.getElementById('session-status');
  const bannerText = document.getElementById('session-status-text');
  const submitBtn = document.getElementById('btn-submit');

  try {
    const match = await getRememberCookie();
    if (match) {
      banner.className = 'status-banner success';
      bannerText.innerText = `Sessão Ativa (Laravel Remember Cookie detectado)`;
      submitBtn.disabled = false;
    } else {
      banner.className = 'status-banner error';
      bannerText.innerText = 'Sessão Expirada. Faça login em lab.idealtrends.io primeiro.';
      submitBtn.disabled = true;
    }
  } catch (err) {
    banner.className = 'status-banner error';
    bannerText.innerText = 'Erro ao ler cookies. Verifique as permissões.';
    submitBtn.disabled = true;
  }
}

// Save Settings
document.getElementById('config-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const config = {
    jiraUrl: document.getElementById('jira-url').value.trim(),
    jiraEmail: document.getElementById('jira-email').value.trim(),
    jiraToken: document.getElementById('jira-token').value.trim(),
    bbToken: document.getElementById('bb-token').value.trim(),
    bbUsername: document.getElementById('bb-username').value.trim(),
    bbWorkspace: document.getElementById('bb-workspace').value.trim(),
    bbRepos: document.getElementById('bb-repos').value.trim(),
    llmProvider: document.getElementById('llm-provider').value,
    geminiKey: document.getElementById('gemini-key').value.trim(),
    anthropicKey: document.getElementById('anthropic-key').value.trim(),
    tgBotToken: document.getElementById('tg-bot-token').value.trim(),
    tgChatId: document.getElementById('tg-chat-id').value.trim(),
    defaultInitiative: document.getElementById('default-initiative').value,
    autoEnabled: document.getElementById('auto-enabled').checked,
    autoTime: document.getElementById('auto-time').value
  };

  if (config.llmProvider === 'claude' && !config.anthropicKey) {
    showToast('Provider Claude selecionado sem Anthropic API Key — cairá no template.', 'error');
  }

  chrome.storage.local.set({ config }, () => {
    showToast('Configurações salvas com sucesso!');
    applyDefaultInitiative(config);
    // Switch to check-in tab
    document.querySelector('[data-tab="checkin-tab"]').click();
  });
});

// Exportar config.json (Fase 3): ponte para quem tambem roda CLI/cron —
// configura uma vez na UI, exporta, coloca na pasta do repo.
document.getElementById('btn-export').addEventListener('click', async () => {
  const cfg = await loadConfigData();
  const json = JSON.stringify(buildConfigJson(cfg), null, 2) + '\n';
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'config.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('config.json exportado — coloque na pasta do lab-checkin (chmod 600).');
});

// Teste do Telegram: valida token + chat_id como estao digitados no form (nao
// precisa salvar antes) enviando um 🧪 pelo bot. Diferente do telegramNotify
// (lib.js), aqui o erro da API e mostrado ao usuario — e o ponto do teste.
document.getElementById('btn-tg-test').addEventListener('click', async () => {
  const btn = document.getElementById('btn-tg-test');
  const spinner = document.getElementById('tg-test-spinner');
  const token = document.getElementById('tg-bot-token').value.trim();
  const chatId = document.getElementById('tg-chat-id').value.trim();

  if (!token || !chatId) {
    showToast('Preencha o Bot Token e o chat_id antes de testar.', 'error');
    return;
  }

  btn.disabled = true;
  spinner.classList.remove('hidden');
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: Number(chatId),
        text: '🧪 Teste do lab-checkin (extensão) — Telegram configurado! As notificações do check-in automático vão chegar neste chat.'
      })
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
    showToast('Mensagem de teste enviada — confira o Telegram!');
  } catch (err) {
    showToast('Falha no teste: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    spinner.classList.add('hidden');
  }
});

function applyDefaultInitiative(cfg) {
  if (cfg.defaultInitiative) {
    const select = document.getElementById('checkin-initiative');
    if ([...select.options].some(o => o.value === String(cfg.defaultInitiative))) {
      select.value = String(cfg.defaultInitiative);
    }
  }
}

// Load Settings
function loadConfig() {
  chrome.storage.local.get(['config'], (result) => {
    if (result.config) {
      const cfg = result.config;
      document.getElementById('jira-url').value = cfg.jiraUrl || '';
      document.getElementById('jira-email').value = cfg.jiraEmail || '';
      document.getElementById('jira-token').value = cfg.jiraToken || '';
      document.getElementById('bb-token').value = cfg.bbToken || '';
      document.getElementById('bb-username').value = cfg.bbUsername || '';
      document.getElementById('bb-workspace').value = cfg.bbWorkspace || '';
      document.getElementById('bb-repos').value = cfg.bbRepos || '';
      document.getElementById('llm-provider').value = cfg.llmProvider || 'gemini';
      document.getElementById('gemini-key').value = cfg.geminiKey || '';
      document.getElementById('anthropic-key').value = cfg.anthropicKey || '';
      document.getElementById('tg-bot-token').value = cfg.tgBotToken || '';
      document.getElementById('tg-chat-id').value = cfg.tgChatId || '';
      document.getElementById('default-initiative').value = String(cfg.defaultInitiative || '6');
      document.getElementById('auto-enabled').checked = !!cfg.autoEnabled;
      document.getElementById('auto-time').value = cfg.autoTime || '09:30';
      applyDefaultInitiative(cfg);
    }
  });
}

// Generate Activity
document.getElementById('btn-generate').addEventListener('click', async () => {
  const spinner = document.getElementById('generate-spinner');
  const btn = document.getElementById('btn-generate');

  spinner.classList.remove('hidden');
  btn.disabled = true;

  try {
    const cfg = await loadConfigData();
    if (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.jiraToken) {
      showToast('Por favor, configure as credenciais do Jira primeiro.', 'error');
      return;
    }

    const sinceDate = getLastBusinessDay();
    const sinceStr = localIsoDate(sinceDate);

    // 1. Coleta Jira + Bitbucket
    const jiraActivity = await fetchJira(cfg, sinceStr);
    const bbActivity = await fetchBitbucket(cfg, sinceStr);

    // 2. Sintetiza via provider configurado (Gemini/Claude) com fallback template
    const draft = await generateDraft(cfg, jiraActivity, bbActivity);
    let yesterdayTxt = draft.yesterday;
    let todayTxt = draft.today;

    // 3. Limpa o ONTEM se o ultimo dia util foi feriado
    if (isHoliday(sinceDate)) {
      yesterdayTxt = '';
      showToast('Ontem foi feriado/fim de semana: campo ONTEM limpo automaticamente.', 'success');
    }

    document.getElementById('checkin-yesterday').value = yesterdayTxt;
    document.getElementById('checkin-today').value = todayTxt;

    showToast('Rascunho gerado com sucesso!');
  } catch (err) {
    showToast('Erro ao gerar rascunho: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    spinner.classList.add('hidden');
  }
});

// Submit Check-in to Lab
document.getElementById('btn-submit').addEventListener('click', async () => {
  const btn = document.getElementById('btn-submit');
  btn.disabled = true;

  const yesterdayText = document.getElementById('checkin-yesterday').value.trim();
  const todayText = document.getElementById('checkin-today').value.trim();

  if (!yesterdayText && !todayText) {
    showToast('Por favor, preencha os campos Yesterday ou Today.', 'error');
    btn.disabled = false;
    return;
  }

  try {
    showToast('Enviando check-in...');
    await submitCheckin({
      initiative: document.getElementById('checkin-initiative').value,
      yesterday: yesterdayText,
      today: todayText,
      confidence: document.getElementById('checkin-confidence').value,
      blockers: document.getElementById('checkin-blockers').value.trim(),
      artifact: document.getElementById('checkin-artifact').value.trim()
    });
    showToast('Check-in enviado com sucesso!');
    checkSession(); // refresh
  } catch (err) {
    showToast('Erro ao enviar check-in: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// Init
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  checkSession();
});
