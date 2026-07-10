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

// Holiday Logic in JS
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
  
  // Static dates (YYYY-MM-DD)
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
  
  // Movable dates
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
  const dateStr = `${yyyy}-${mm}-${dd}`;
  return getHolidays(yyyy).has(dateStr);
}

function getLastBusinessDay() {
  const today = new Date();
  let offset = 1;
  // If today is Monday (1), look back to Friday (3 days)
  if (today.getDay() === 1) {
    offset = 3;
  } else if (today.getDay() === 0) {
    offset = 2; // Sunday -> Friday
  }
  const result = new Date();
  result.setDate(today.getDate() - offset);
  return result;
}

// Session Check
let rememberWebCookie = null;

async function checkSession() {
  const banner = document.getElementById('session-status');
  const bannerText = document.getElementById('session-status-text');
  const submitBtn = document.getElementById('btn-submit');
  
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'lab.idealtrends.io' });
    const match = cookies.find(c => c.name.startsWith('remember_web_'));
    
    if (match) {
      rememberWebCookie = match;
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
    geminiKey: document.getElementById('gemini-key').value.trim()
  };
  
  chrome.storage.local.set({ config }, () => {
    showToast('Configurações salvas com sucesso!');
    // Switch to check-in tab
    document.querySelector('[data-tab="checkin-tab"]').click();
  });
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
      document.getElementById('bb-repos').value = cfg.bbRepos || '';
      document.getElementById('gemini-key').value = cfg.geminiKey || '';
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
    const data = await chrome.storage.local.get(['config']);
    const cfg = data.config;
    if (!cfg || !cfg.jiraUrl || !cfg.jiraEmail || !cfg.jiraToken) {
      showToast('Por favor, configure as credenciais do Jira primeiro.', 'error');
      btn.disabled = false;
      spinner.classList.add('hidden');
      return;
    }
    
    const sinceDate = getLastBusinessDay();
    const sinceStr = sinceDate.toISOString().split('T')[0];
    
    // 1. Fetch Jira
    const jiraActivity = await fetchJira(cfg, sinceStr);
    
    // 2. Fetch Bitbucket
    const bbActivity = await fetchBitbucket(cfg, sinceStr);
    
    // 3. Synthesize via Gemini or Template
    let yesterdayTxt = '';
    let todayTxt = '';
    
    if (cfg.geminiKey) {
      const result = await fetchGemini(cfg.geminiKey, jiraActivity, bbActivity);
      if (result) {
        yesterdayTxt = result.yesterday;
        todayTxt = result.today;
      }
    }
    
    if (!yesterdayTxt || !todayTxt) {
      const result = generateTemplate(jiraActivity, bbActivity);
      yesterdayTxt = result.yesterday;
      todayTxt = result.today;
    }
    
    // 4. Overwrite Yesterday if it was holiday/weekend
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

async function fetchJira(cfg, sinceStr) {
  const url = `${cfg.jiraUrl.replace(/\/$/, '')}/rest/api/3/search/jql`;
  const jql = `assignee = currentUser() AND updated >= "${sinceStr}"`;
  
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

async function fetchBitbucket(cfg, sinceStr) {
  if (!cfg.bbWorkspace || (!cfg.bbToken && (!cfg.bbUsername || !cfg.bbPassword))) {
    return [];
  }
  
  const headers = { 'Accept': 'application/json' };
  if (cfg.bbToken) {
    if (cfg.bbToken.startsWith('ATATT')) {
      const email = cfg.bbUsername || cfg.jiraEmail;
      headers['Authorization'] = 'Basic ' + btoa(`${email}:${cfg.bbToken}`);
    } else {
      headers['Authorization'] = `Bearer ${cfg.bbToken}`;
    }
  }
  
  let repos = [];
  if (cfg.bbRepos) {
    repos = cfg.bbRepos.split(',').map(r => r.trim());
  } else {
    // Auto-discover repositories
    const reposUrl = `https://api.bitbucket.org/2.0/repositories/${cfg.bbWorkspace}?pagelen=100`;
    const res = await fetch(reposUrl, { headers });
    if (res.ok) {
      const data = await res.json();
      repos = (data.values || []).map(r => r.slug).filter(Boolean);
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

async function fetchGemini(apiKey, jiraAct, bbAct) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const context = { jira_issues_updated: jiraAct, bitbucket_commits: bbAct };
  
  const prompt = `
Você é um desenvolvedor preenchendo o check-in diário de atividades.
Com base nas seguintes informações de atividades brutas coletadas do Jira e Bitbucket, gere dois blocos de texto em português (um para "yesterday" e outro para "today").

Regras importantes:
1. Escreva em português, de forma profissional, direta e natural, no estilo de atualização diária (daily).
2. Não cite os códigos das tasks do Jira (ex: evite escrever "PROJ-123" ou "Ideal-456"). Fale apenas do assunto de forma natural.
3. Sintetize as informações. Não liste apenas commits de forma literal, agrupe-os em realizações lógicas.
4. Para a parte "today", deduza o que deve ser feito com base nas tarefas que ainda não estão concluídas (ex: status "In Progress" ou pendentes), ou indique continuação/refinamento das tarefas recentes.
5. Retorne a resposta estritamente no formato JSON abaixo, sem blocos de código markdown adicionais:
{
  "yesterday": "texto sintetizado do que foi feito ontem",
  "today": "texto sintetizado do que será feito hoje"
}

Dados de atividade:
${JSON.stringify(context, null, 2)}
`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
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

function generateTemplate(jiraAct, bbAct) {
  let yesterday = '';
  if (jiraAct.length > 0) {
    yesterday += 'Tasks atualizadas:\n' + jiraAct.map(i => `  - [${i.key}] ${i.summary} (${i.status})`).join('\n') + '\n';
  }
  if (bbAct.length > 0) {
    yesterday += 'Commits realizados:\n' + bbAct.map(c => `  - [${c.repo}] ${c.message}`).join('\n');
  }
  if (!yesterday) {
    yesterday = 'Sem atividades registradas no Jira/Bitbucket.';
  }
  
  const inProgress = jiraAct.filter(i => ['in progress', 'em andamento', 'doing'].includes(i.status.toLowerCase()));
  let today = '';
  if (inProgress.length > 0) {
    today = 'Continuar trabalhando em:\n' + inProgress.map(i => `  - [${i.key}] ${i.summary}`).join('\n');
  } else {
    today = 'Continuar as atividades pendentes e atuar em novas demandas do board.';
  }
  return { yesterday, today };
}

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
    const initiative = document.getElementById('checkin-initiative').value;
    const confidence = document.getElementById('checkin-confidence').value;
    const blockers = document.getElementById('checkin-blockers').value.trim();
    const artifact = document.getElementById('checkin-artifact').value.trim();
    
    // 1. Get XSRF Token by loading the daily page
    showToast('Obtendo token da sessão...');
    const pageRes = await fetch('https://lab.idealtrends.io/saude-entrega/daily');
    if (!pageRes.ok) {
      throw new Error('Falha ao comunicar com Ideal Lab (Sessão expirou?)');
    }
    
    // Get cookies for token
    const cookies = await chrome.cookies.getAll({ domain: 'lab.idealtrends.io' });
    const xsrfCookie = cookies.find(c => c.name === 'XSRF-TOKEN');
    if (!xsrfCookie) {
      throw new Error('CSRF Token não encontrado nos cookies.');
    }
    const token = decodeURIComponent(xsrfCookie.value);
    
    // 2. Submit Check-in POST
    showToast('Enviando check-in...');
    const todayStr = new Date().toISOString().split('T')[0];
    
    let blockersText = blockers;
    if (blockers.toLowerCase() === 'nenhum') {
      blockersText = '';
    }
    
    const payload = {
      initiative_id: parseInt(initiative),
      checkin_date: todayStr,
      yesterday_text: yesterdayText,
      yesterday_artifact_url: artifact,
      today_text: todayText,
      confidence_score: parseInt(confidence),
      blockers_text: blockersText
    };
    
    const postHeaders = {
      'content-type': 'application/json',
      'accept': 'text/html, application/xhtml+xml',
      'origin': 'https://lab.idealtrends.io',
      'referer': 'https://lab.idealtrends.io/saude-entrega/daily',
      'x-inertia': 'true',
      'x-inertia-version': '1',
      'x-requested-with': 'XMLHttpRequest',
      'x-xsrf-token': token
    };
    
    const postRes = await fetch('https://lab.idealtrends.io/saude-entrega/daily', {
      method: 'POST',
      headers: postHeaders,
      body: JSON.stringify(payload)
    });
    
    if (postRes.status === 200 || postRes.status === 302 || postRes.status === 303) {
      showToast('Check-in enviado com sucesso!');
      checkSession(); // refresh
    } else {
      throw new Error('POST retornou status HTTP ' + postRes.status);
    }
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
