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

// Load existing check-in for today (pre-fill form if already submitted)
async function loadExistingCheckin() {
  try {
    const response = await fetch('https://lab.idealtrends.io/saude-entrega/daily');
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

    for (const card of cards) {
      const existing = card.existing;
      if (existing && card.initiativeId) {
        document.getElementById('checkin-initiative').value = String(card.initiativeId);
        if (existing.confidenceScore) {
          document.getElementById('checkin-confidence').value = String(existing.confidenceScore);
        }
        if (existing.yesterdayText) {
          document.getElementById('checkin-yesterday').value = existing.yesterdayText;
        }
        if (existing.todayText) {
          document.getElementById('checkin-today').value = existing.todayText;
        }
        if (existing.blockersText) {
          document.getElementById('checkin-blockers').value = existing.blockersText;
        }
        if (existing.yesterdayArtifactUrl) {
          document.getElementById('checkin-artifact').value = existing.yesterdayArtifactUrl;
        }
        showToast('Check-in de hoje já existe. Campos preenchidos com os dados atuais.', 'success');
        return;
      }
    }
  } catch (err) {
    console.log('Could not load existing check-in:', err.message);
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
    geminiKey: document.getElementById('gemini-key').value.trim(),
    tgToken: document.getElementById('tg-token').value.trim(),
    tgChatId: document.getElementById('tg-chat-id').value.trim()
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

// Test Telegram
document.getElementById('btn-test-telegram').addEventListener('click', async () => {
  const token = document.getElementById('tg-token').value.trim();
  const chatId = document.getElementById('tg-chat-id').value.trim();
  const statusEl = document.getElementById('tg-test-status');

  if (!token || !chatId) {
    statusEl.textContent = 'Preencha token e chat ID primeiro.';
    statusEl.className = 'test-status error';
    return;
  }

  statusEl.textContent = 'Enviando...';
  statusEl.className = 'test-status';

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ Teste de notificação do Ideal Lab Check-in funcionando!',
        parse_mode: 'Markdown'
      })
    });

    const data = await res.json();
    if (data.ok) {
      statusEl.textContent = 'OK! Mensagem enviada.';
      statusEl.className = 'test-status success';
    } else {
      statusEl.textContent = 'Erro: ' + (data.description || 'resposta inválida');
      statusEl.className = 'test-status error';
    }
  } catch (err) {
    statusEl.textContent = 'Erro: ' + err.message;
    statusEl.className = 'test-status error';
  }
});

// Simulate pending check-in notification
document.getElementById('btn-test-notify').addEventListener('click', async () => {
  const btn = document.getElementById('btn-test-notify');
  btn.disabled = true;
  showToast('Simulando verificação do check-in...');
  try {
    const cfg = (await chrome.storage.local.get(['config'])).config;
    if (!cfg?.tgToken || !cfg?.tgChatId) {
      showToast('Configure o Telegram primeiro.', 'error');
      btn.disabled = false;
      return;
    }

    const response = await fetch('https://lab.idealtrends.io/saude-entrega/daily', { credentials: 'include' });
    if (!response.ok) {
      showToast('Falha ao acessar Ideal Lab (sessão expirada?).', 'error');
      btn.disabled = false;
      return;
    }

    const html = await response.text();
    const match = html.match(/data-page="([^"]*)"/);
    if (!match) {
      showToast('Não foi possível ler os dados da página.', 'error');
      btn.disabled = false;
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
    const dateStr = new Date().toLocaleDateString('pt-BR');

    if (hasCheckin) {
      showToast('Check-in já preenchido hoje. Enviando simulação mesmo assim...');
    }

    const msg = hasCheckin
      ? `⚠️ *SIMULAÇÃO - Check-in já preenchido*\n\nO check-in de *${dateStr}* foi simulado como pendente para teste.\n\n(Notificação real só é enviada se estiver pendente às 11h.)`
      : `⚠️ *Check-in pendente!*\n\nO check-in de *${dateStr}* ainda não foi preenchido no Ideal Lab.\n\nAcesse a extensão para preencher.`;

    const res = await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.tgChatId, text: msg, parse_mode: 'Markdown' })
    });

    const data = await res.json();
    if (data.ok) {
      showToast('Notificação de pendência enviada via Telegram!');
    } else {
      showToast('Erro Telegram: ' + (data.description || 'desconhecido'), 'error');
    }
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  }
  btn.disabled = false;
});

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
      document.getElementById('bb-project-key').value = cfg.bbProjectKey || '';
      document.getElementById('llm-provider').value = cfg.llmProvider || 'gemini';
      document.getElementById('gemini-key').value = cfg.geminiKey || '';
      document.getElementById('tg-token').value = cfg.tgToken || '';
      document.getElementById('tg-chat-id').value = cfg.tgChatId || '';
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

    const checkinSelect = document.getElementById('checkin-initiative');
    const initId = checkinSelect.value;
    const initName = checkinSelect.options[checkinSelect.selectedIndex]?.text || '';

    const initiativeCfg = cfg.initiativeConfig || {};
    const oldRepos = cfg.initiativeRepos || {};
    const repos = (initiativeCfg.repos || oldRepos)[initId];
    const projectKeys = (initiativeCfg.projects || {})[initId];
    const jiraActivity = await fetchJira(cfg, sinceStr, projectKeys);
    const bbRepos = repos ? repos.split(',').map(r => r.trim()) : undefined;
    const bbActivity = await fetchBitbucket(cfg, sinceStr, bbRepos);

    const draft = await generateDraft(cfg, jiraActivity, bbActivity, initName);
    let yesterdayTxt = draft.yesterday;
    let todayTxt = draft.today;
    if (isHoliday(sinceDate)) yesterdayTxt = '';

    document.getElementById('checkin-yesterday').value = yesterdayTxt;
    document.getElementById('checkin-today').value = todayTxt;
    await saveDraft();

    showToast('Rascunho gerado para a iniciativa selecionada!');
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
    const submittedInitiative = document.getElementById('checkin-initiative').value;
    const result = await chrome.storage.local.get(['drafts']);
    const drafts = result.drafts || {};
    delete drafts[submittedInitiative];
    await chrome.storage.local.set({ drafts });
    checkSession(); // refresh
  } catch (err) {
    showToast('Erro ao enviar check-in: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// --- Skip local (Fase 5a) ------------------------------------------------------

async function refreshLocalSkips() {
  const el = document.getElementById('local-skips');
  if (!el) return;
  const skips = await getLocalSkips();
  el.textContent = skips.length ? 'Pulos locais agendados: ' + skips.join(', ') : '';
}

document.getElementById('btn-skip-tomorrow').addEventListener('click', async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const iso = localIsoDate(tomorrow);
  await addLocalSkip(iso);
  await refreshLocalSkips();
  showToast(`Check-in automático de ${iso} será pulado.`);
});

async function loadInitiatives() {
  const checkinSelect = document.getElementById('checkin-initiative');
  const defaultSelect = document.getElementById('default-initiative');

  try {
    const initiatives = await fetchInitiatives();
    if (!initiatives.length) throw new Error('Nenhuma iniciativa disponível');

    const fragment1 = document.createDocumentFragment();
    const fragment2 = document.createDocumentFragment();
    initiatives.forEach(init => {
      const opt1 = document.createElement('option');
      opt1.value = init.id;
      opt1.textContent = `${init.id} - ${init.name}`;
      fragment1.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = init.id;
      opt2.textContent = `${init.id} - ${init.name}`;
      fragment2.appendChild(opt2);
    });

    checkinSelect.innerHTML = '';
    checkinSelect.appendChild(fragment1);

    defaultSelect.innerHTML = '';
    defaultSelect.appendChild(fragment2);

    renderInitiativeConfigInputs();
  } catch (err) {
    showToast('Não foi possível carregar iniciativas do Lab: ' + err.message, 'error');
  }
}

document.getElementById('checkin-yesterday').addEventListener('input', scheduleSaveDraft);
document.getElementById('checkin-today').addEventListener('input', scheduleSaveDraft);

document.getElementById('checkin-initiative').addEventListener('change', async () => {
  const prevInitiative = currentInitiative;
  currentInitiative = document.getElementById('checkin-initiative').value;
  try { await saveDraft(prevInitiative); } catch {}
  await loadDraftForInitiative(currentInitiative);
});

document.getElementById('btn-suggest').addEventListener('click', async () => {
  const spinner = document.getElementById('suggest-spinner');
  const btn = document.getElementById('btn-suggest');
  spinner.classList.remove('hidden');
  btn.disabled = true;

  try {
    const cfg = await loadConfigData();
    if (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.jiraToken || !cfg.bbWorkspace) {
      showToast('Configure Jira e Bitbucket primeiro.', 'error');
      return;
    }

    const initiatives = await fetchInitiatives();
    const suggestion = await suggestInitiativeConfig(cfg, initiatives);
    cfg.initiativeConfig = suggestion;
    await new Promise(resolve => chrome.storage.local.set({ config: cfg }, resolve));
    renderInitiativeConfigInputs(suggestion);
    showToast('Sugestão automática aplicada! Revise e salve.');
  } catch (err) {
    showToast('Erro ao sugerir: ' + err.message, 'error');
  } finally {
    spinner.classList.add('hidden');
    btn.disabled = false;
  }
});

// --- Fase 4b: detectar projetos/repos novos e mapear com um toque ------------

function bestInitiativeMatch(key, initiatives) {
  const k = normalizeStr(key);
  for (const init of initiatives) {
    const n = normalizeStr(init.name);
    if (n && (n.includes(k) || k.includes(n))) return init.id;
  }
  return initiatives[0]?.id ?? '';
}

function appendToInput(inputId, value) {
  const el = document.getElementById(inputId);
  if (!el) return false;
  const parts = el.value.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.some(p => p.toLowerCase() === value.toLowerCase())) parts.push(value);
  el.value = parts.join(', ');
  return true;
}

async function persistInitiativeConfig() {
  const cfg = await loadConfigData();
  cfg.initiativeConfig = readInitiativeConfig();
  await new Promise(r => chrome.storage.local.set({ config: cfg }, r));
}

function renderUnmappedSuggestions(unmapped, initiatives) {
  const container = document.getElementById('unmapped-container');
  container.innerHTML = '';
  const items = [
    ...unmapped.projects.map(k => ({ type: 'project', key: k })),
    ...unmapped.repos.map(k => ({ type: 'repo', key: k }))
  ];
  if (!items.length) {
    container.innerHTML = '<p class="text-muted" style="font-size: 12px; opacity: 0.6;">Nenhum projeto/repo novo detectado na atividade recente 🎉</p>';
    return;
  }
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'form-group row';
    row.style.cssText = 'margin-bottom: 8px; align-items: flex-end; gap: 6px;';

    const label = document.createElement('div');
    label.style.cssText = 'font-size: 12px; flex: 1;';
    label.textContent = (item.type === 'project' ? 'Projeto ' : 'Repo ') + item.key;

    const select = document.createElement('select');
    select.className = 'form-control';
    select.style.cssText = 'flex: 1; font-size: 12px;';
    initiatives.forEach(init => {
      const o = document.createElement('option');
      o.value = String(init.id);
      o.textContent = init.name;
      select.appendChild(o);
    });
    
    if (postRes.status === 200 || postRes.status === 302 || postRes.status === 303) {
      showToast('Check-in enviado com sucesso!');
      checkSession();
      loadExistingCheckin();
      chrome.runtime.sendMessage({ type: 'refreshBadge' });
    } else {
      throw new Error('POST retornou status HTTP ' + postRes.status);
    }
    const sinceStr = localIsoDate(getLastBusinessDay());
    const jiraAct = await fetchJira(cfg, sinceStr).catch(() => []);
    const bbAct = await fetchBitbucket(cfg, sinceStr).catch(() => []);
    const defaultInitiative = Number(cfg.defaultInitiative) || 6;
    const { unmapped } = routeActivity(jiraAct, bbAct, cfg.initiativeConfig || {}, defaultInitiative);
    const initiatives = await fetchInitiatives();
    renderUnmappedSuggestions(unmapped, initiatives);
  } catch (err) {
    showToast('Erro ao detectar: ' + err.message, 'error');
  } finally {
    spinner.classList.add('hidden');
    btn.disabled = false;
  }
});

// Init
document.addEventListener('DOMContentLoaded', async () => {
  await loadInitiatives();
  currentInitiative = document.getElementById('checkin-initiative').value;
  loadConfig();
  checkSession().then(() => loadExistingCheckin());
  chrome.runtime.sendMessage({ type: 'refreshBadge' });
});
