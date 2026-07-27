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

function readInitiativeConfig() {
  const repos = {};
  const projects = {};
  document.querySelectorAll('[id^="repo-input-"]').forEach(input => {
    const id = input.id.replace('repo-input-', '');
    const value = input.value.trim();
    if (value) repos[id] = value;
  });
  document.querySelectorAll('[id^="jira-project-"]').forEach(input => {
    const id = input.id.replace('jira-project-', '');
    const value = input.value.trim();
    if (value) projects[id] = value;
  });
  return { repos, projects };
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
    bbProjectKey: document.getElementById('bb-project-key').value.trim(),
    initiativeConfig: readInitiativeConfig(),
    llmProvider: document.getElementById('llm-provider').value,
    geminiKey: document.getElementById('gemini-key').value.trim(),
    anthropicKey: document.getElementById('anthropic-key').value.trim(),
    tgBotToken: document.getElementById('tg-bot-token').value.trim(),
    tgChatId: document.getElementById('tg-chat-id').value.trim(),
    notifyUrl: document.getElementById('tg-worker-url').value.trim(),
    notifySecret: document.getElementById('tg-notify-secret').value.trim(),
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
  // Captura o cookie remember_web da sessao viva do navegador: o export sai
  // pronto para a rotina/CLI sem o dev abrir o DevTools.
  const labCookie = await getRememberCookie().catch(() => null);
  const json = JSON.stringify(buildConfigJson(cfg, labCookie), null, 2) + '\n';
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'config.json';
  a.click();
  URL.revokeObjectURL(url);
  if (labCookie) {
    showToast('config.json exportado (cookie do Lab incluído).');
  } else {
    showToast('config.json exportado SEM o cookie do Lab — faça login em lab.idealtrends.io e exporte de novo.', 'error');
  }
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const imported = JSON.parse(text);

    const config = {
      jiraUrl: imported.jira?.url || '',
      jiraEmail: imported.jira?.email || '',
      jiraToken: imported.jira?.api_token || '',
      bbToken: imported.bitbucket?.api_token || '',
      bbUsername: imported.bitbucket?.username || '',
      bbWorkspace: imported.bitbucket?.workspace || '',
      bbProjectKey: imported.bitbucket?.project_key || '',
      llmProvider: imported.llm_provider || 'gemini',
      geminiKey: imported.gemini?.api_key || '',
      anthropicKey: imported.anthropic?.api_key || '',
      tgBotToken: imported.telegram?.bot_token || '',
      tgChatId: imported.telegram?.chat_id || '',
      notifyUrl: imported.notify?.url || '',
      notifySecret: imported.notify?.secret || '',
      defaultInitiative: imported.defaultInitiative || '',
      autoEnabled: false,
      autoTime: '09:30',
      initiativeConfig: imported.initiative_config || {}
    };

    await new Promise(resolve => chrome.storage.local.set({ config }, resolve));
    loadConfig();
    showToast('Configurações importadas com sucesso!');
  } catch (err) {
    showToast('Erro ao importar: ' + err.message, 'error');
  }

  e.target.value = '';
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

// Conectar Telegram por deep link (Fase 1C): gera o link no worker, abre o
// chat, e faz polling ate o worker devolver o chat_id — sem digitar nada.
document.getElementById('btn-tg-connect').addEventListener('click', async () => {
  const btn = document.getElementById('btn-tg-connect');
  const spinner = document.getElementById('tg-connect-spinner');
  const workerUrl = document.getElementById('tg-worker-url').value.trim().replace(/\/$/, '');
  const botToken = document.getElementById('tg-bot-token').value.trim();
  if (!workerUrl || !botToken) {
    showToast('Preencha a URL do worker e o Bot Token primeiro.', 'error');
    return;
  }
  btn.disabled = true;
  spinner.classList.remove('hidden');
  try {
    const res = await fetch(`${workerUrl}/devlink`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: botToken })
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok || !data.link) throw new Error(data.error || `HTTP ${res.status}`);
    window.open(data.link, '_blank');
    showToast('Abra o Telegram e toque em Iniciar — aguardando conexão...');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await fetch(`${workerUrl}/devlink?code=${encodeURIComponent(data.code)}`)
        .then(r => r.json()).catch(() => ({}));
      if (s.status === 'linked' && s.chatId) {
        document.getElementById('tg-chat-id').value = String(s.chatId);
        const cfg = await loadConfigData();
        cfg.tgChatId = String(s.chatId);
        cfg.notifyUrl = workerUrl;
        await new Promise(r => chrome.storage.local.set({ config: cfg }, r));
        showToast(`✅ Telegram conectado! chat_id ${s.chatId} salvo.`);
        return;
      }
    }
    showToast('Não detectei a conexão. Toque em Iniciar no bot e tente de novo.', 'error');
  } catch (err) {
    showToast('Erro ao conectar: ' + err.message, 'error');
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

function renderInitiativeConfigInputs(saved) {
  const container = document.getElementById('initiative-config-container');
  const options = [...document.getElementById('default-initiative').options].filter(o => o.value);
  if (!options.length) {
    container.innerHTML = '<p class="text-muted" style="font-size: 12px; opacity: 0.6;">Nenhuma iniciativa carregada</p>';
    return;
  }
  const savedRepos = (saved && saved.repos) || {};
  const savedProjects = (saved && saved.projects) || {};
  container.innerHTML = '';
  options.forEach(opt => {
    const card = document.createElement('div');
    card.className = 'form-group';
    card.style.marginBottom = '16px';
    card.innerHTML = `
      <label style="font-weight: 600;">${opt.text}</label>
      <div class="form-group row" style="margin-top: 6px;">
        <div class="col">
          <label for="jira-project-${opt.value}" style="font-size: 11px;">Projeto Jira</label>
          <input type="text" id="jira-project-${opt.value}" class="form-control" placeholder="Ex: AUDIT" value="${savedProjects[opt.value] || ''}">
        </div>
        <div class="col">
          <label for="repo-input-${opt.value}" style="font-size: 11px;">Repositórios</label>
          <input type="text" id="repo-input-${opt.value}" class="form-control" placeholder="Repositórios separados por vírgula" value="${savedRepos[opt.value] || ''}">
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

let currentInitiative = '';

async function saveDraft(initiativeId) {
  const initiative = initiativeId || document.getElementById('checkin-initiative').value;
  if (!initiative) return;
  const yesterday = document.getElementById('checkin-yesterday').value;
  const today = document.getElementById('checkin-today').value;
  const result = await chrome.storage.local.get(['drafts']);
  const drafts = result.drafts || {};
  drafts[initiative] = { yesterday, today };
  await chrome.storage.local.set({ drafts });
}

async function loadDraftForInitiative(initiativeId) {
  if (!initiativeId) return;
  const result = await chrome.storage.local.get(['drafts']);
  const draft = (result.drafts || {})[initiativeId];
  document.getElementById('checkin-yesterday').value = draft?.yesterday || '';
  document.getElementById('checkin-today').value = draft?.today || '';
}

let saveDraftTimer;
function scheduleSaveDraft() {
  clearTimeout(saveDraftTimer);
  saveDraftTimer = setTimeout(saveDraft, 500);
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
      document.getElementById('bb-project-key').value = cfg.bbProjectKey || '';
      document.getElementById('llm-provider').value = cfg.llmProvider || 'gemini';
      document.getElementById('gemini-key').value = cfg.geminiKey || '';
      document.getElementById('anthropic-key').value = cfg.anthropicKey || '';
      document.getElementById('tg-bot-token').value = cfg.tgBotToken || '';
      document.getElementById('tg-chat-id').value = cfg.tgChatId || '';
      document.getElementById('tg-worker-url').value = cfg.notifyUrl || '';
      document.getElementById('tg-notify-secret').value = cfg.notifySecret || '';
      document.getElementById('default-initiative').value = String(cfg.defaultInitiative || '6');
      document.getElementById('auto-enabled').checked = !!cfg.autoEnabled;
      document.getElementById('auto-time').value = cfg.autoTime || '09:30';
      renderInitiativeConfigInputs(cfg.initiativeConfig);
      applyDefaultInitiative(cfg);
      currentInitiative = document.getElementById('checkin-initiative').value;
      loadDraftForInitiative(currentInitiative);
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
    select.value = String(bestInitiativeMatch(item.key, initiatives));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = 'Vincular';
    btn.addEventListener('click', async () => {
      const initId = select.value;
      const inputId = item.type === 'project' ? `jira-project-${initId}` : `repo-input-${initId}`;
      if (!appendToInput(inputId, item.key)) {
        showToast('Salve as configurações uma vez para carregar as iniciativas e tente de novo.', 'error');
        return;
      }
      await persistInitiativeConfig();
      row.remove();
      showToast(`${item.key} vinculado — mapeamento salvo.`);
    });

    row.appendChild(label);
    row.appendChild(select);
    row.appendChild(btn);
    container.appendChild(row);
  });
}

document.getElementById('btn-detect-unmapped').addEventListener('click', async () => {
  const btn = document.getElementById('btn-detect-unmapped');
  const spinner = document.getElementById('detect-spinner');
  spinner.classList.remove('hidden');
  btn.disabled = true;
  try {
    const cfg = await loadConfigData();
    if (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.jiraToken) {
      showToast('Configure o Jira primeiro.', 'error');
      return;
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
  loadDraftForInitiative(currentInitiative);
  checkSession();
  refreshLocalSkips();
});
