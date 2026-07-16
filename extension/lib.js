// lib.js — logica compartilhada entre o popup (popup.js) e o service worker
// (background.js). Nao depende de DOM: tudo aqui funciona em MV3 service
// worker (importScripts) e na pagina do popup (<script src="lib.js">).

const LAB_BASE = 'https://lab.idealtrends.io';
const LAB_DAILY = `${LAB_BASE}/saude-entrega/daily`;

// --- Feriados (federais + SP + moveis) ---------------------------------------

function calculateEaster(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1; // 0-indexed in JS Date
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
}

function getHolidays(year) {
  const holidays = new Set();

  const staticDates = [
    `${year}-01-01`, // Confraternizacao Universal
    `${year}-01-25`, // Aniversario de Sao Paulo
    `${year}-04-21`, // Tiradentes
    `${year}-05-01`, // Dia do Trabalho
    `${year}-07-09`, // Revolucao Constitucionalista
    `${year}-09-07`, // Independencia do Brasil
    `${year}-10-12`, // Nossa Senhora Aparecida
    `${year}-11-02`, // Finados
    `${year}-11-15`, // Proclamacao da Republica
    `${year}-11-20`, // Consciencia Negra
    `${year}-12-25`  // Natal
  ];
  staticDates.forEach(d => holidays.add(d));

  const easter = calculateEaster(year);
  const getFormatted = (offset) => {
    const d = new Date(easter);
    d.setDate(d.getDate() + offset);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };
  holidays.add(getFormatted(-47)); // Carnaval
  holidays.add(getFormatted(-2));  // Sexta Santa
  holidays.add(getFormatted(60));  // Corpus Christi

  return holidays;
}

function isHoliday(dateObj) {
  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getDate()).padStart(2, '0');
  return getHolidays(yyyy).has(`${yyyy}-${mm}-${dd}`);
}

function getLastBusinessDay() {
  const today = new Date();
  let offset = 1;
  if (today.getDay() === 1) offset = 3;      // segunda -> sexta
  else if (today.getDay() === 0) offset = 2; // domingo -> sexta
  const result = new Date();
  result.setDate(today.getDate() - offset);
  return result;
}

function localIsoDate(dateObj = new Date()) {
  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// --- Config (chrome.storage.local) --------------------------------------------

async function loadConfigData() {
  const data = await chrome.storage.local.get(['config']);
  return data.config || {};
}

// Gera o conteudo do config.json no formato do config.json.example — a ponte
// entre a extensao e o trilho CLI/cron (Fase 3: "Exportar config.json").
function buildConfigJson(cfg) {
  const allRepos = new Set();
  if (cfg.bbRepos) {
    cfg.bbRepos.split(',').map(r => r.trim()).filter(Boolean).forEach(r => allRepos.add(r));
  }
  const initRepos = cfg.initiativeConfig?.repos || cfg.initiativeRepos || {};
  Object.values(initRepos).forEach(v => {
    v.split(',').map(r => r.trim()).filter(Boolean).forEach(r => allRepos.add(r));
  });

  return {
    jira: {
      url: cfg.jiraUrl || '',
      email: cfg.jiraEmail || '',
      api_token: cfg.jiraToken || ''
    },
    bitbucket: {
      api_token: cfg.bbToken || '',
      username: cfg.bbUsername || '',
      app_password: '',
      workspace: cfg.bbWorkspace || '',
      repositories: [...allRepos]
    },
    llm_provider: cfg.llmProvider || 'gemini',
    gemini: { api_key: cfg.geminiKey || '' },
    anthropic: { api_key: cfg.anthropicKey || '' },
    telegram: {
      bot_token: cfg.tgBotToken || '',
      chat_id: cfg.tgChatId || '',
      webhook_secret: ''
    },
    initiative_config: cfg.initiativeConfig || {}
  };
}

// --- Sessao / pagina do Lab -----------------------------------------------------

async function getRememberCookie() {
  const cookies = await chrome.cookies.getAll({ domain: 'lab.idealtrends.io' });
  return cookies.find(c => c.name.startsWith('remember_web_')) || null;
}

function htmlUnescape(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Baixa a pagina do daily e devolve o JSON do Inertia (props com os cards).
async function fetchPageProps() {
  const res = await fetch(LAB_DAILY, { credentials: 'include', headers: { accept: 'text/html' } });
  if (!res.ok) throw new Error('Falha ao comunicar com o Ideal Lab (HTTP ' + res.status + ')');
  const htmlText = await res.text();
  const m = htmlText.match(/data-page="([^"]*)"/);
  if (!m) throw new Error('Sessao do Lab expirada — faca login em lab.idealtrends.io');
  return JSON.parse(htmlUnescape(m[1]));
}

async function isSubmittedToday(initiativeId) {
  const page = await fetchPageProps();
  const cards = page.props?.cards || [];
  return cards.some(c => c.initiativeId === Number(initiativeId) && c.existing);
}

async function fetchInitiatives() {
  const page = await fetchPageProps();
  const cards = page.props?.cards || [];
  return cards.map(c => ({ id: c.initiativeId, name: c.initiativeName }));
}

// --- Coleta: Jira + Bitbucket ----------------------------------------------------

async function fetchJira(cfg, sinceStr, projectKeys) {
  const url = `${cfg.jiraUrl.replace(/\/$/, '')}/rest/api/3/search/jql`;
  let jql = `assignee = currentUser() AND updated >= "${sinceStr}"`;
  if (projectKeys) jql += ` AND project IN (${projectKeys})`;

  const headers = {
    'Authorization': 'Basic ' + btoa(`${cfg.jiraEmail}:${cfg.jiraToken}`),
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jql,
      fields: ['summary', 'status', 'updated', 'key']
    })
  });

  if (!response.ok) {
    throw new Error('Jira API error: ' + response.statusText);
  }

  const data = await response.json();
  return (data.issues || []).map(issue => ({
    key: issue.key,
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    updated: issue.fields.updated
  }));
}

async function fetchBitbucket(cfg, sinceStr, reposOverride) {
  if (!cfg.bbWorkspace || (!cfg.bbToken && (!cfg.bbUsername || !cfg.bbPassword))) {
    return [];
  }

  const headers = bbHeaders(cfg);

  let repos = reposOverride;
  if (!repos) {
    if (cfg.bbRepos) {
      repos = cfg.bbRepos.split(',').map(r => r.trim());
    } else {
      const reposUrl = `https://api.bitbucket.org/2.0/repositories/${cfg.bbWorkspace}?pagelen=100`;
      const res = await fetch(reposUrl, { headers });
      if (res.ok) {
        const data = await res.json();
        repos = (data.values || []).map(r => r.slug).filter(Boolean);
      }
    }
  }

  let username = cfg.bbUsername;
  if (!username && cfg.bbToken) {
    const userRes = await fetch('https://api.bitbucket.org/2.0/user', { headers });
    if (userRes.ok) {
      const userData = await userRes.json();
      username = userData.username || userData.nickname || userData.display_name;
    }
  }

  const commits = [];
  const sinceIso = sinceStr + 'T00:00:00Z';

  for (const repo of repos) {
    const commitsUrl = `https://api.bitbucket.org/2.0/repositories/${cfg.bbWorkspace}/${repo}/commits?pagelen=30`;
    const res = await fetch(commitsUrl, { headers });
    if (res.ok) {
      const data = await res.json();
      const values = data.values || [];
      for (const c of values) {
        if (c.date && c.date >= sinceIso) {
          const authorRaw = (c.author && c.author.raw) || '';
          if (!username || authorRaw.toLowerCase().includes(username.toLowerCase())) {
            commits.push({
              repo,
              hash: c.hash ? c.hash.substring(0, 7) : '',
              message: (c.message || '').split('\n')[0]
            });
          }
        }
      }
    }
  }
  return commits;
}

function bbHeaders(cfg) {
  const headers = { 'Accept': 'application/json' };
  if (cfg.bbToken) {
    if (cfg.bbToken.startsWith('ATATT')) {
      headers['Authorization'] = 'Basic ' + btoa(`${cfg.jiraEmail}:${cfg.bbToken}`);
    } else {
      headers['Authorization'] = `Bearer ${cfg.bbToken}`;
    }
  }
  return headers;
}

async function fetchJiraProjects(cfg) {
  const url = `${cfg.jiraUrl.replace(/\/$/, '')}/rest/api/3/project`;
  const headers = {
    'Authorization': 'Basic ' + btoa(`${cfg.jiraEmail}:${cfg.jiraToken}`),
    'Accept': 'application/json'
  };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('Jira API error: ' + res.statusText);
  return await res.json();
}

async function fetchBitbucketRepos(cfg) {
  const url = `https://api.bitbucket.org/2.0/repositories/${cfg.bbWorkspace}?pagelen=100`;
  const headers = bbHeaders(cfg);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('Bitbucket API error: ' + res.statusText);
  const data = await res.json();
  return (data.values || []).map(r => r.slug).filter(Boolean);
}

function normalizeStr(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function suggestInitiativeConfig(cfg, initiatives) {
  const [jiraProjects, bbRepos] = await Promise.all([
    fetchJiraProjects(cfg).catch(() => []),
    fetchBitbucketRepos(cfg).catch(() => [])
  ]);

  const repos = {};
  const projects = {};

  for (const init of initiatives) {
    const norm = normalizeStr(init.name);

    const matchedProject = jiraProjects.find(p =>
      normalizeStr(p.name).includes(norm) || normalizeStr(p.key).includes(norm)
    );
    if (matchedProject) projects[init.id] = matchedProject.key;

    const keywords = norm.split(/\s+/);
    const matchedRepos = bbRepos.filter(r => {
      const rNorm = normalizeStr(r);
      return keywords.some(k => rNorm.includes(k));
    });
    if (matchedRepos.length) repos[init.id] = matchedRepos.join(', ');
  }

  return { repos, projects };
}

// --- Geracao de texto: motor plugavel (Fase 4: Gemini ou Claude) ------------------

function buildDraftPrompt(jiraAct, bbAct, initiativeName, { withJsonInstruction }) {
  const context = { jira_issues_updated: jiraAct, bitbucket_commits: bbAct };
  let prompt = `
Você é um desenvolvedor preenchendo o check-in diário de atividades para a iniciativa "${initiativeName}".
Com base nas seguintes informações de atividades brutas coletadas do Jira e Bitbucket, gere dois blocos de texto em português (um para "yesterday" e outro para "today") relacionados a esta iniciativa.

Regras importantes:
1. Escreva em português, de forma profissional, direta e natural, no estilo de atualização diária (daily).
2. Não cite os códigos das tasks do Jira (ex: evite escrever "PROJ-123" ou "Ideal-456"). Fale apenas do assunto de forma natural.
3. Sintetize as informações. Não liste apenas commits de forma literal, agrupe-os em realizações lógicas.
4. Para a parte "today", deduza o que deve ser feito com base nas tarefas que ainda não estão concluídas (ex: status "In Progress" ou pendentes), ou indique continuação/refinamento das tarefas recentes.
`;
  if (withJsonInstruction) {
    prompt += `5. Retorne a resposta estritamente no formato JSON abaixo, sem blocos de código markdown adicionais:
{
  "yesterday": "texto sintetizado do que foi feito ontem",
  "today": "texto sintetizado do que será feito hoje"
}
`;
  }
  prompt += `
Dados de atividade:
${JSON.stringify(context, null, 2)}
`;
  return prompt;
}

async function fetchGemini(apiKey, jiraAct, bbAct, initiativeName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: buildDraftPrompt(jiraAct, bbAct, initiativeName, { withJsonInstruction: true }) }] }],
    generationConfig: { responseMimeType: 'application/json' }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  try {
    const text = data.candidates[0].content.parts[0].text.trim();
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

// Claude via Messages API direto do browser — exige a API key do proprio dev e
// o header de opt-in anthropic-dangerous-direct-browser-access (a key vive so
// no storage local do navegador, nunca num backend compartilhado).
async function fetchClaude(apiKey, jiraAct, bbAct, initiativeName) {
  const payload = {
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            yesterday: { type: 'string' },
            today: { type: 'string' }
          },
          required: ['yesterday', 'today'],
          additionalProperties: false
        }
      }
    },
    messages: [
      { role: 'user', content: buildDraftPrompt(jiraAct, bbAct, initiativeName, { withJsonInstruction: false }) }
    ]
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  try {
    if (data.stop_reason === 'refusal') return null;
    const text = data.content.find(b => b.type === 'text').text.trim();
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

// Ponto unico de geracao: escolhe o provider configurado e cai no template
// deterministico se o LLM falhar/nao estiver configurado.
async function generateDraft(cfg, jiraAct, bbAct, initiativeName) {
  const provider = cfg.llmProvider || 'gemini';
  let result = null;
  if (provider === 'claude' && cfg.anthropicKey) {
    result = await fetchClaude(cfg.anthropicKey, jiraAct, bbAct, initiativeName);
  } else if (cfg.geminiKey) {
    result = await fetchGemini(cfg.geminiKey, jiraAct, bbAct, initiativeName);
  }
  if (result && result.yesterday && result.today) return result;
  return generateTemplate(jiraAct, bbAct, initiativeName);
}

function generateTemplate(jiraAct, bbAct, initiativeName) {
  let yesterday = '';
  if (jiraAct.length > 0) {
    yesterday += 'Tasks atualizadas:\n' + jiraAct.map(i => `  - [${i.key}] ${i.summary} (${i.status})`).join('\n') + '\n';
  }
  if (bbAct.length > 0) {
    yesterday += 'Commits realizados:\n' + bbAct.map(c => `  - [${c.repo}] ${c.message}`).join('\n');
  }
  if (!yesterday) {
    yesterday = 'Sem atividades registradas no Jira/Bitbucket para esta iniciativa.';
  }

  const inProgress = jiraAct.filter(i => ['in progress', 'em andamento', 'doing'].includes(i.status.toLowerCase()));
  let today = '';
  if (inProgress.length > 0) {
    today = 'Continuar trabalhando em:\n' + inProgress.map(i => `  - [${i.key}] ${i.summary}`).join('\n');
  } else {
    today = `Continuar as atividades pendentes da iniciativa "${initiativeName}" e atuar em novas demandas do board.`;
  }
  return { yesterday, today };
}

// --- Envio do check-in ------------------------------------------------------------

async function submitCheckin({ initiative, yesterday, today, confidence = 5, blockers = 'Nenhum', artifact = '' }) {
  // 1. GET renova a sessao e o XSRF-TOKEN
  const pageRes = await fetch(LAB_DAILY, { credentials: 'include', headers: { accept: 'text/html' } });
  if (!pageRes.ok) {
    throw new Error('Falha ao comunicar com Ideal Lab (Sessão expirou?)');
  }

  const cookies = await chrome.cookies.getAll({ domain: 'lab.idealtrends.io' });
  const xsrfCookie = cookies.find(c => c.name === 'XSRF-TOKEN');
  if (!xsrfCookie) {
    throw new Error('CSRF Token não encontrado nos cookies.');
  }
  const token = decodeURIComponent(xsrfCookie.value);

  let blockersText = blockers;
  if (blockers.trim().toLowerCase() === 'nenhum') {
    blockersText = '';
  }

  const payload = {
    initiative_id: parseInt(initiative),
    checkin_date: localIsoDate(),
    yesterday_text: yesterday,
    yesterday_artifact_url: artifact,
    today_text: today,
    confidence_score: parseInt(confidence),
    blockers_text: blockersText
  };

  const postRes = await fetch(LAB_DAILY, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'accept': 'text/html, application/xhtml+xml',
      'origin': LAB_BASE,
      'referer': LAB_DAILY,
      'x-inertia': 'true',
      'x-inertia-version': '1',
      'x-requested-with': 'XMLHttpRequest',
      'x-xsrf-token': token
    },
    body: JSON.stringify(payload)
  });

  if (postRes.status !== 200 && postRes.status !== 302 && postRes.status !== 303) {
    throw new Error('POST retornou status HTTP ' + postRes.status);
  }
}

// --- Telegram (notificacoes + /pular) ----------------------------------------------

async function telegramNotify(cfg, text) {
  if (!cfg.tgBotToken || !cfg.tgChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.tgBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(cfg.tgChatId), text })
    });
  } catch (err) {
    // Notificacao nunca bloqueia o fluxo.
  }
}

// Le a mensagem fixada do chat com o bot ("SKIP: YYYY-MM-DD, ...") — o mesmo
// estado que as rotinas cloud e o checkin.sh consultam.
async function telegramIsSkippedToday(cfg) {
  if (!cfg.tgBotToken || !cfg.tgChatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.tgBotToken}/getChat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(cfg.tgChatId) })
    });
    const data = await res.json();
    const text = data.result?.pinned_message?.text || '';
    return text.includes('SKIP:') && text.includes(localIsoDate());
  } catch (err) {
    return false; // falha na checagem nao bloqueia o check-in
  }
}

// --- Modo automatico (Fase 5) --------------------------------------------------------

// Fluxo completo do alarme diario: mesmas guardas do cmd_auto do checkin.sh.
// Retorna { status, detail } e notifica via Telegram quando configurado.
async function runAutoCheckin() {
  const cfg = await loadConfigData();
  const initiative = Number(cfg.defaultInitiative) || 6;
  const now = new Date();

  // 1. Fim de semana
  if (now.getDay() === 0 || now.getDay() === 6) {
    return { status: 'skipped', detail: 'fim de semana' };
  }

  // 2. Feriado
  if (isHoliday(now)) {
    return { status: 'skipped', detail: 'feriado' };
  }

  // 3. /pular (mensagem fixada no Telegram)
  if (await telegramIsSkippedToday(cfg)) {
    await telegramNotify(cfg, '🚫 lab-checkin (extensão): check-in de hoje NAO enviado — cancelado via /pular. Para desfazer: /retomar hoje');
    return { status: 'skipped', detail: 'cancelado via /pular' };
  }

  // 4. Sessao viva no navegador?
  const remember = await getRememberCookie();
  if (!remember) {
    await telegramNotify(cfg, '❌ lab-checkin (extensão): sessão do Lab expirada — faça login em lab.idealtrends.io para o check-in automático voltar a funcionar.');
    return { status: 'error', detail: 'sessao expirada' };
  }

  // 5. Ja preenchido?
  let submitted;
  try {
    submitted = await isSubmittedToday(initiative);
  } catch (err) {
    await telegramNotify(cfg, '❌ lab-checkin (extensão): ' + err.message);
    return { status: 'error', detail: err.message };
  }
  if (submitted) {
    return { status: 'skipped', detail: 'ja preenchido hoje' };
  }

  try {
    // 6. Coleta + geracao
    const sinceDate = getLastBusinessDay();
    const sinceStr = localIsoDate(sinceDate);
    const initiativeCfg = cfg.initiativeConfig || {};
    const oldRepos = cfg.initiativeRepos || {};
    const projectKeys = (initiativeCfg.projects || {})[String(initiative)];
    const jiraAct = cfg.jiraUrl && cfg.jiraEmail && cfg.jiraToken ? await fetchJira(cfg, sinceStr, projectKeys) : [];
    const repos = (initiativeCfg.repos || oldRepos)[String(initiative)];
    const bbRepos = repos ? repos.split(',').map(r => r.trim()) : undefined;
    const bbAct = await fetchBitbucket(cfg, sinceStr, bbRepos);
    const allInitiatives = await fetchInitiatives();
    const initiativeName = (allInitiatives.find(i => i.id === initiative)?.name) || String(initiative);
    const draft = await generateDraft(cfg, jiraAct, bbAct, initiativeName);
    let yesterdayTxt = draft.yesterday;
    const todayTxt = draft.today;
    if (isHoliday(sinceDate)) yesterdayTxt = '';

    // 7. Envio
    await submitCheckin({ initiative, yesterday: yesterdayTxt, today: todayTxt });

    await telegramNotify(cfg, `✅ Check-in enviado (extensão) — iniciativa ${initiative} (${localIsoDate()})\n\nOntem:\n${yesterdayTxt || '(vazio)'}\n\nHoje:\n${todayTxt}`);
    return { status: 'sent', detail: `iniciativa ${initiative}` };
  } catch (err) {
    await telegramNotify(cfg, '❌ lab-checkin (extensão): falha no check-in automático — ' + err.message);
    return { status: 'error', detail: err.message };
  }
}
