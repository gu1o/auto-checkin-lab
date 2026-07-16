/**
 * Cloudflare Worker: bot do Telegram (@CheckInLabBot) para o lab-checkin.
 *
 * Multi-usuario (Fase 1 do plano de compartilhamento): qualquer dev manda
 * /start, o admin aprova por botao inline e o registro vive no Workers KV
 * (binding USERS, chave user:<chat_id>). O estado dos skips continua sendo a
 * MENSAGEM FIXADA do chat privado de cada dev ("SKIP: 2026-07-20, ..."),
 * lida pelas rotinas/CLI via getChat — o isolamento por usuario vem de graca
 * porque cada pessoa tem o proprio chat com o bot.
 *
 * Credenciais (Fase 1B): /config gera um codigo one-time (TTL 10 min,
 * setup:<codigo> no KV) e responde com um link para o formulario servido
 * pelo proprio worker em GET /setup; o POST /setup criptografa o JSON com
 * AES-GCM (chave no secret KV_ENC_KEY) e salva em secrets:<chat_id>.
 * Credencial nenhuma passa pelo chat do Telegram.
 *
 * Comandos: /start, /pular [data], /retomar [data], /pulos, /config,
 * /testar, /cancelar. Onboarding de preferencias (iniciativa, notificacoes, horario)
 * acontece no chat apos a aprovacao, via ForceReply + botoes inline; a
 * pergunta pendente fica em prefs._pending no KV.
 *
 * Env: BOT_TOKEN (secret), WEBHOOK_SECRET (secret), KV_ENC_KEY (secret,
 * 32 bytes em base64), ADMIN_CHAT_ID (var), USERS (KV namespace).
 */

const SP_TZ = 'America/Sao_Paulo';
const SKIP_MARKER = 'SKIP:';
const ASK_TEXT = 'Qual data? Responda esta mensagem com DD/MM';
const ASK_INITIATIVE = 'Qual a iniciativa padrao? Responda esta mensagem com o ID numerico (ex: 6)';
const ASK_TIME = 'Qual horario do check-in automatico? Responda esta mensagem com HH:MM (ex: 09:30)';
const SETUP_TTL_S = 600; // 10 minutos
const WD_PT = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
const HELP =
  'Comandos:\n' +
  '/pular — cancela o check-in automatico de um dia (pergunto a data)\n' +
  '/pular DD/MM — cancela direto para a data\n' +
  '/retomar DD/MM — desfaz um cancelamento\n' +
  '/pulos — lista os cancelamentos agendados\n' +
  '/config — link seguro para configurar suas credenciais (Jira, Bitbucket, Lab)\n' +
  '/testar — valida as credenciais salvas (Jira, Bitbucket, Lab, IA) sem enviar nada';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Rotas /setup sao do usuario (nao do Telegram): protegidas pelo codigo
    // one-time + TTL, nao pelo header do webhook.
    if (url.pathname === '/setup') {
      try {
        return await handleSetup(request, url, env);
      } catch (e) {
        console.error('erro no /setup', e);
        return html('Erro interno. Tente pedir /config de novo no bot.', 500);
      }
    }

    if (request.method !== 'POST') return new Response('ok');
    if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('bad request', { status: 400 });
    }
    try {
      await handle(update, env, url.origin);
    } catch (e) {
      console.error('erro no update', update.update_id, e);
    }
    return new Response('ok'); // sempre 200 pro Telegram nao reenfileirar
  },
};

// --- Telegram API ------------------------------------------------------------

async function api(env, method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = await r.json().catch(() => ({ ok: false }));
  if (!body.ok) console.error(`API ${method}:`, JSON.stringify(body).slice(0, 200));
  return body;
}

function send(env, chatId, text, replyMarkup) {
  const params = { chat_id: Number(chatId), text };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return api(env, 'sendMessage', params);
}

// --- usuarios (Workers KV) ----------------------------------------------------

function adminId(env) {
  return Number(env.ADMIN_CHAT_ID);
}

async function getUser(env, chatId) {
  const raw = await env.USERS.get(`user:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}

function putUser(env, chatId, user) {
  return env.USERS.put(`user:${chatId}`, JSON.stringify(user));
}

async function ensureAdminUser(env) {
  // O admin nao precisa de aprovacao propria: bootstrap como active.
  const id = adminId(env);
  let user = await getUser(env, id);
  if (!user) {
    user = { name: 'Admin', username: '', status: 'active', prefs: {} };
    await putUser(env, id, user);
  }
  return user;
}

// --- datas (strings ISO, fuso de Sao Paulo) ----------------------------------

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SP_TZ }).format(new Date());
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function validIso(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

function weekday(iso) {
  return new Date(iso + 'T12:00:00Z').getUTCDay(); // 0 = domingo
}

function fmt(iso) {
  const [, m, d] = iso.split('-');
  return `${d}/${m} (${WD_PT[weekday(iso)]})`;
}

/** Aceita: hoje, amanha, DD/MM, DD/MM/AAAA, AAAA-MM-DD. Retorna ISO ou null. */
function parseDate(raw) {
  const s = raw.trim().toLowerCase().replace('amanhã', 'amanha');
  const today = todayIso();
  if (s === 'hoje') return today;
  if (s === 'amanha') return addDays(today, 1);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validIso(s);
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const mon = m[2].padStart(2, '0');
  const year = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : today.slice(0, 4);
  let iso = validIso(`${year}-${mon}-${day}`);
  if (iso && !m[3] && iso < today) iso = validIso(`${Number(year) + 1}-${mon}-${day}`);
  return iso;
}

// --- mensagem fixada com as datas de skip (sempre no chat de origem) ----------

async function getSkips(env, chatId) {
  const r = await api(env, 'getChat', { chat_id: Number(chatId) });
  const pm = r.result?.pinned_message;
  if (!pm || !(pm.text || '').includes(SKIP_MARKER)) return { pm: null, dates: [] };
  const dates = [...new Set(pm.text.match(/\d{4}-\d{2}-\d{2}/g) || [])].sort();
  return { pm, dates };
}

async function writeSkips(env, chatId, pm, dates) {
  const today = todayIso();
  const keep = [...new Set(dates)].filter((d) => d >= today).sort();
  if (!keep.length) {
    if (pm) {
      await api(env, 'unpinChatMessage', { chat_id: Number(chatId), message_id: pm.message_id });
      await api(env, 'deleteMessage', { chat_id: Number(chatId), message_id: pm.message_id });
    }
    return;
  }
  const text =
    `${SKIP_MARKER} ${keep.join(', ')} — o check-in automatico NAO sera ` +
    'enviado nessas datas (agendado via /pular; desfaca com /retomar)';
  if (pm) {
    await api(env, 'editMessageText', { chat_id: Number(chatId), message_id: pm.message_id, text });
  } else {
    const r = await send(env, chatId, text);
    if (r.ok) {
      await api(env, 'pinChatMessage', {
        chat_id: Number(chatId),
        message_id: r.result.message_id,
        disable_notification: true,
      });
    }
  }
}

// --- comandos de skip ----------------------------------------------------------

async function doPular(env, chatId, iso) {
  if (!iso) {
    await send(env, chatId, 'Nao entendi a data. Manda DD/MM (ex: 21/07), "hoje" ou "amanha".');
    return;
  }
  if (iso < todayIso()) {
    await send(env, chatId, `${fmt(iso)} ja passou — nada a cancelar.`);
    return;
  }
  if (weekday(iso) === 0 || weekday(iso) === 6) {
    await send(env, chatId, `${fmt(iso)} e fim de semana — o check-in nem roda nesse dia, nada a cancelar.`);
    return;
  }
  const { pm, dates } = await getSkips(env, chatId);
  if (dates.includes(iso)) {
    await send(env, chatId, `O check-in de ${fmt(iso)} ja estava cancelado.`);
    return;
  }
  await writeSkips(env, chatId, pm, [...dates, iso]);
  const [, m, d] = iso.split('-');
  await send(env, chatId, `🚫 Fechado! Vou pular o check-in de ${fmt(iso)}. Pra desfazer: /retomar ${d}/${m}`);
}

async function doRetomar(env, chatId, arg) {
  const { pm, dates } = await getSkips(env, chatId);
  if (!dates.length) {
    await send(env, chatId, 'Nao ha nenhum cancelamento agendado.');
    return;
  }
  let iso;
  if (arg) {
    iso = parseDate(arg);
    if (!iso) {
      await send(env, chatId, 'Nao entendi a data. Ex: /retomar 21/07');
      return;
    }
  } else if (dates.length === 1) {
    iso = dates[0];
  } else {
    await send(env, chatId, 'Ha mais de um cancelamento agendado: ' + dates.map(fmt).join(', ') + '. Especifique: /retomar DD/MM');
    return;
  }
  if (!dates.includes(iso)) {
    await send(env, chatId, `${fmt(iso)} nao estava cancelado. Agendados: ` + dates.map(fmt).join(', '));
    return;
  }
  await writeSkips(env, chatId, pm, dates.filter((d) => d !== iso));
  await send(env, chatId, `✅ Cancelamento desfeito — o check-in de ${fmt(iso)} volta a ser enviado normalmente.`);
}

async function doPulos(env, chatId) {
  const { pm, dates } = await getSkips(env, chatId);
  const future = dates.filter((d) => d >= todayIso());
  if (future.length !== dates.length) await writeSkips(env, chatId, pm, future); // limpeza oportunista
  if (!future.length) await send(env, chatId, 'Nenhum cancelamento agendado — check-ins seguem normais.');
  else await send(env, chatId, 'Check-ins cancelados: ' + future.map(fmt).join(', '));
}

function askDate(env, chatId) {
  return send(env, chatId, 'Pular o check-in de quando?', {
    inline_keyboard: [
      [
        { text: 'Hoje', callback_data: 'pular:hoje' },
        { text: 'Amanha', callback_data: 'pular:amanha' },
        { text: 'Outra data', callback_data: 'pular:outra' },
      ],
    ],
  });
}

// --- /start + aprovacao ---------------------------------------------------------

async function doStart(env, msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  if (chatId === adminId(env)) {
    await ensureAdminUser(env);
    await send(env, chatId, 'Voce e o admin — tudo liberado.\n\n' + HELP);
    return;
  }
  const user = await getUser(env, chatId);
  if (user?.status === 'active') {
    await send(env, chatId, 'Voce ja esta registrado!\n\n' + HELP);
    return;
  }
  if (user?.status === 'pending') {
    await send(env, chatId, 'Seu cadastro ja foi recebido — aguardando aprovacao do admin.');
    return;
  }
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Sem nome';
  const username = from.username || '';
  await putUser(env, chatId, { name, username, status: 'pending', prefs: {} });
  await send(env, chatId, 'Cadastro recebido! Aguardando aprovacao do admin — te aviso assim que liberar.');
  await send(
    env,
    adminId(env),
    `${name}${username ? ` (@${username})` : ''} quer se registrar no bot (chat_id ${chatId}).`,
    {
      inline_keyboard: [
        [
          { text: 'Aprovar', callback_data: `adm:ok:${chatId}` },
          { text: 'Recusar', callback_data: `adm:no:${chatId}` },
        ],
      ],
    }
  );
}

async function approveUser(env, targetId) {
  const user = await getUser(env, targetId);
  if (!user) return `Registro de ${targetId} nao encontrado (ja processado?).`;
  if (user.status === 'active') return `${user.name} ja estava aprovado.`;
  user.status = 'active';
  user.prefs = user.prefs || {};
  user.prefs._pending = 'initiative';
  await putUser(env, targetId, user);
  await send(env, targetId, '✅ Cadastro aprovado! Vamos configurar suas preferencias.');
  await send(env, targetId, ASK_INITIATIVE, { force_reply: true });
  return `Aprovado: ${user.name}${user.username ? ` (@${user.username})` : ''}.`;
}

async function denyUser(env, targetId) {
  const user = await getUser(env, targetId);
  if (!user) return `Registro de ${targetId} nao encontrado (ja processado?).`;
  await env.USERS.delete(`user:${targetId}`);
  await send(env, targetId, 'Seu cadastro nao foi aprovado. Fale com o admin se acha que foi engano.');
  return `Recusado: ${user.name}${user.username ? ` (@${user.username})` : ''}.`;
}

// --- preferencias (onboarding pos-aprovacao) ------------------------------------

async function handlePrefReply(env, chatId, user, msg) {
  const question = msg.reply_to_message?.text || '';
  const answer = msg.text.trim();
  if (question.startsWith(ASK_INITIATIVE.slice(0, 30)) && user.prefs._pending === 'initiative') {
    const id = Number(answer);
    if (!Number.isInteger(id) || id <= 0) {
      await send(env, chatId, 'Nao entendi — manda so o ID numerico.');
      await send(env, chatId, ASK_INITIATIVE, { force_reply: true });
      return true;
    }
    user.prefs.initiative = id;
    user.prefs._pending = 'notifications';
    await putUser(env, chatId, user);
    await send(env, chatId, 'Quer receber notificacoes do check-in automatico por aqui?', {
      inline_keyboard: [
        [
          { text: 'Sim', callback_data: 'pref:notif:on' },
          { text: 'Nao', callback_data: 'pref:notif:off' },
        ],
      ],
    });
    return true;
  }
  if (question.startsWith(ASK_TIME.slice(0, 30)) && user.prefs._pending === 'time') {
    const m = answer.match(/^(\d{1,2}):(\d{2})$/);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
      await send(env, chatId, 'Nao entendi — formato HH:MM (ex: 09:30).');
      await send(env, chatId, ASK_TIME, { force_reply: true });
      return true;
    }
    user.prefs.time = `${m[1].padStart(2, '0')}:${m[2]}`;
    delete user.prefs._pending;
    await putUser(env, chatId, user);
    await send(
      env,
      chatId,
      `Pronto! Preferencias salvas: iniciativa ${user.prefs.initiative}, notificacoes ${user.prefs.notifications ? 'on' : 'off'}, horario ${user.prefs.time}.\n\n` +
        'Para configurar suas credenciais (Jira, Bitbucket, Lab) use /config — voce recebe um link seguro de uso unico.\n\n' +
        HELP
    );
    return true;
  }
  return false;
}

async function handlePrefCallback(env, chatId, user, arg) {
  if (user.prefs._pending !== 'notifications') return;
  user.prefs.notifications = arg === 'on';
  user.prefs._pending = 'time';
  await putUser(env, chatId, user);
  await send(env, chatId, ASK_TIME, { force_reply: true });
}

// --- /testar: valida as credenciais salvas (Jira, Bitbucket, Lab, IA) --------------
// So leitura — GET em cada servico com a credencial salva via /config. Nada e
// enviado/escrito no Lab; e o teste de "configurei certo?" sem efeito colateral.

const CHECK_TIMEOUT_MS = 8000;

function fetchT(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
}

async function checkJira(s) {
  const { url, email, api_token } = s.jira || {};
  if (!url || !email || !api_token) return '⚠️ Jira — nao configurado';
  try {
    const r = await fetchT(`${url.replace(/\/$/, '')}/rest/api/3/myself`, {
      headers: { authorization: 'Basic ' + btoa(`${email}:${api_token}`), accept: 'application/json' },
    });
    if (!r.ok) return `❌ Jira — HTTP ${r.status} (e-mail/token invalidos?)`;
    const me = await r.json().catch(() => ({}));
    return `✅ Jira — autenticado como ${me.displayName || email}`;
  } catch {
    return '❌ Jira — sem resposta (URL correta?)';
  }
}

async function checkBitbucket(s) {
  const bb = s.bitbucket || {};
  if (!bb.api_token) return '⚠️ Bitbucket — nao configurado';
  const headers = { accept: 'application/json' };
  if (bb.api_token.startsWith('ATATT')) {
    headers.authorization = 'Basic ' + btoa(`${bb.username || (s.jira || {}).email || ''}:${bb.api_token}`);
  } else {
    headers.authorization = `Bearer ${bb.api_token}`;
  }
  // Nao usa /2.0/user (fora do escopo de tokens so-repositorio): o que o
  // check-in precisa e ler repositorios do workspace, entao testamos isso.
  const ws = bb.workspace || 'idealtrends';
  try {
    const r = await fetchT(`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(ws)}?pagelen=1`, { headers });
    return r.ok ? `✅ Bitbucket — acesso ao workspace ${ws} OK` : `❌ Bitbucket — HTTP ${r.status} (token/permissao Repositories:Read?)`;
  } catch {
    return '❌ Bitbucket — sem resposta';
  }
}

async function checkLab(s) {
  const lab = s.lab || {};
  if (!lab.cookie_name || !lab.cookie_value) return '⚠️ Ideal Lab — cookie nao configurado';
  try {
    const r = await fetchT('https://lab.idealtrends.io/saude-entrega/daily', {
      redirect: 'manual',
      headers: { cookie: `${lab.cookie_name}=${lab.cookie_value}`, accept: 'text/html' },
    });
    if (r.status === 200) return '✅ Ideal Lab — sessao ativa (cookie valido)';
    if (r.status >= 300 && r.status < 400) return '❌ Ideal Lab — redirecionado pro login (cookie remember_web expirado?)';
    return `❌ Ideal Lab — HTTP ${r.status}`;
  } catch {
    return '❌ Ideal Lab — sem resposta';
  }
}

async function checkLlm(s) {
  const lines = [];
  if (s.gemini?.api_key) {
    try {
      const r = await fetchT(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(s.gemini.api_key)}`
      );
      lines.push(r.ok ? '✅ Gemini — API key valida' : `❌ Gemini — HTTP ${r.status} (API key invalida?)`);
    } catch {
      lines.push('❌ Gemini — sem resposta');
    }
  }
  if (s.anthropic?.api_key) {
    try {
      const r = await fetchT('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': s.anthropic.api_key, 'anthropic-version': '2023-06-01' },
      });
      lines.push(r.ok ? '✅ Claude — API key valida' : `❌ Claude — HTTP ${r.status} (API key invalida?)`);
    } catch {
      lines.push('❌ Claude — sem resposta');
    }
  }
  if (!lines.length) lines.push(`⚠️ IA (${s.llm_provider || 'gemini'}) — nenhuma API key configurada`);
  return lines;
}

/** Roda todos os checks em paralelo. Retorna null se nao ha credenciais salvas. */
async function credentialReport(env, chatId) {
  const blob = await env.USERS.get(`secrets:${chatId}`);
  if (!blob) return null;
  let s;
  try {
    s = await decryptJson(env, blob);
  } catch {
    return ['❌ Falha ao ler as credenciais salvas — refaca o /config.'];
  }
  const [jira, bb, lab, llm] = await Promise.all([checkJira(s), checkBitbucket(s), checkLab(s), checkLlm(s)]);
  return [jira, bb, lab, ...llm];
}

async function doTestar(env, chatId) {
  const lines = await credentialReport(env, chatId);
  if (!lines) {
    await send(env, chatId, 'Nenhuma credencial salva ainda — mande /config para configurar. (Se esta mensagem chegou, o canal do Telegram esta OK 😉)');
    return;
  }
  await send(env, chatId, '🧪 Teste das credenciais salvas — nada foi enviado ao Lab:\n\n' + lines.join('\n'));
}

// --- /config + formulario one-time-link (Fase 1B) --------------------------------

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function doConfig(env, chatId, origin) {
  const code = randomCode();
  await env.USERS.put(`setup:${code}`, String(chatId), { expirationTtl: SETUP_TTL_S });
  await send(
    env,
    chatId,
    'Link seguro para configurar suas credenciais (uso unico, expira em 10 minutos):\n' +
      `${origin}/setup?t=${code}\n\n` +
      'Nunca mande credenciais pelo chat — sempre por esse formulario.'
  );
}

// AES-GCM com chave de 32 bytes (base64) no secret KV_ENC_KEY.
async function encKey(env, usages) {
  const raw = Uint8Array.from(atob(env.KV_ENC_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages);
}

async function encryptJson(env, obj) {
  const key = await encKey(env, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

async function decryptJson(env, blob) {
  const [v, ivB64, ctB64] = blob.split(':');
  if (v !== 'v1') throw new Error('formato desconhecido');
  const u8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await encKey(env, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8(ivB64) }, key, u8(ctB64));
  return JSON.parse(new TextDecoder().decode(pt));
}

function html(body, status = 200) {
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>lab-checkin</title><style>
        body{font-family:system-ui,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#222}
        label{display:block;margin:.8rem 0 .2rem;font-weight:600;font-size:.9rem}
        input,select{width:100%;padding:.5rem;border:1px solid #bbb;border-radius:6px;box-sizing:border-box}
        button{margin-top:1.2rem;padding:.6rem 1.4rem;border:0;border-radius:6px;background:#2563eb;color:#fff;font-size:1rem;cursor:pointer}
        h1{font-size:1.3rem} h2{font-size:1rem;margin-top:1.5rem;border-bottom:1px solid #eee;padding-bottom:.3rem}
        .hint{color:#666;font-size:.8rem;margin-top:.2rem}
      </style></head><body>${body}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

function setupForm(code) {
  return html(`
    <h1>lab-checkin — configurar credenciais</h1>
    <p>Os dados vao direto por HTTPS para o worker e ficam criptografados (AES-GCM) no armazenamento. Nada passa pelo Telegram.</p>
    <form method="post" action="/setup">
      <input type="hidden" name="t" value="${code}">
      <h2>Jira</h2>
      <label>URL</label><input name="jira_url" placeholder="https://idealtrends.atlassian.net">
      <label>E-mail Atlassian</label><input name="jira_email" type="email" placeholder="voce@empresa.com.br">
      <label>API token</label><input name="jira_token" type="password" placeholder="ATATT...">
      <h2>Bitbucket</h2>
      <label>API token (ou app password)</label><input name="bb_token" type="password">
      <label>Username</label><input name="bb_username">
      <label>Workspace</label><input name="bb_workspace" placeholder="idealtrends">
      <label>Repositorios (separados por virgula; vazio = todos)</label><input name="bb_repos">
      <h2>LLM</h2>
      <label>Provider padrao</label>
      <select name="llm_provider"><option value="gemini">Gemini</option><option value="claude">Claude</option></select>
      <label>Gemini API key</label><input name="gemini_key" type="password">
      <label>Anthropic API key</label><input name="anthropic_key" type="password" placeholder="sk-ant-...">
      <h2>Ideal Lab</h2>
      <label>Nome do cookie remember_web</label><input name="lab_cookie_name" placeholder="remember_web_xxxxxxxx">
      <div class="hint">DevTools (F12) &rarr; Application &rarr; Cookies &rarr; lab.idealtrends.io</div>
      <label>Valor do cookie</label><input name="lab_cookie_value" type="password">
      <button type="submit">Salvar credenciais</button>
    </form>`);
}

async function handleSetup(request, url, env) {
  if (request.method === 'GET') {
    const code = url.searchParams.get('t') || '';
    const chatId = code && (await env.USERS.get(`setup:${code}`));
    if (!chatId) return html('<h1>Link invalido ou expirado</h1><p>Peca /config de novo no @CheckInLabBot.</p>', 403);
    return setupForm(code);
  }
  if (request.method === 'POST') {
    const form = await request.formData();

    // Botao "testar credenciais" da pagina de sucesso: codigo proprio
    // (test:<codigo>), gerado no salvamento. Nao e consumido no clique — vale
    // ate o TTL, para poder rodar de novo; os checks sao somente-leitura.
    const testCode = form.get('test');
    if (testCode) {
      const testChatId = await env.USERS.get(`test:${testCode}`);
      if (!testChatId) return html('<h1>Link invalido ou expirado</h1><p>Peca /config de novo no @CheckInLabBot.</p>', 403);
      const lines = (await credentialReport(env, testChatId)) || ['⚠️ Nenhuma credencial salva.'];
      const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return html(
        '<h1>🧪 Resultado do teste</h1>' +
          '<p>Validacao somente-leitura — nada foi enviado ao Lab.</p>' +
          '<ul>' + lines.map((l) => `<li>${esc(l)}</li>`).join('') + '</ul>' +
          `<form method="post" action="/setup"><input type="hidden" name="test" value="${testCode}">` +
          '<button type="submit">Testar de novo</button></form>' +
          '<p class="hint">Depois, teste a qualquer momento mandando /testar no chat do @CheckInLabBot.</p>'
      );
    }

    const code = form.get('t') || '';
    const chatId = code && (await env.USERS.get(`setup:${code}`));
    if (!chatId) return html('<h1>Link invalido ou expirado</h1><p>Peca /config de novo no @CheckInLabBot.</p>', 403);
    const f = (name) => (form.get(name) || '').toString().trim();
    const secrets = {
      jira: { url: f('jira_url'), email: f('jira_email'), api_token: f('jira_token') },
      bitbucket: {
        api_token: f('bb_token'),
        username: f('bb_username'),
        app_password: '',
        workspace: f('bb_workspace'),
        repositories: f('bb_repos') ? f('bb_repos').split(',').map((r) => r.trim()).filter(Boolean) : [],
      },
      llm_provider: f('llm_provider') || 'gemini',
      gemini: { api_key: f('gemini_key') },
      anthropic: { api_key: f('anthropic_key') },
      lab: { cookie_name: f('lab_cookie_name'), cookie_value: f('lab_cookie_value') },
      updated_at: new Date().toISOString(),
    };
    await env.USERS.put(`secrets:${chatId}`, await encryptJson(env, secrets));
    await env.USERS.delete(`setup:${code}`); // consome o codigo
    const newTestCode = randomCode();
    await env.USERS.put(`test:${newTestCode}`, String(chatId), { expirationTtl: SETUP_TTL_S });
    await send(env, chatId, '✅ Credenciais configuradas com sucesso. Para atualizar, mande /config de novo.');
    return html(
      '<h1>✅ Credenciais salvas</h1><p>O bot confirmou no chat — pode fechar esta aba.</p>' +
        '<p>Quer conferir se esta tudo certo? Valide as credenciais agora (somente leitura, nada e enviado ao Lab):</p>' +
        `<form method="post" action="/setup"><input type="hidden" name="test" value="${newTestCode}">` +
        '<button type="submit">🧪 Testar credenciais</button></form>' +
        '<p class="hint">Tambem da pra testar a qualquer momento mandando /testar no chat do bot.</p>'
    );
  }
  return new Response('method not allowed', { status: 405 });
}

// exporta para uso futuro (ex.: Fase 6, cron trigger no worker)
export { decryptJson };

// --- roteamento -----------------------------------------------------------------

async function handle(update, env, origin) {
  if (update.callback_query) {
    const cq = update.callback_query;
    await api(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    const chatId = cq.message?.chat?.id ?? cq.from.id;
    if (cq.message) {
      await api(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id });
    }
    const [cmd, arg, extra] = (cq.data || '').split(':');

    // Aprovacao/recusa: so o admin, no chat do admin.
    if (cmd === 'adm') {
      if (cq.from.id !== adminId(env)) return;
      const result = arg === 'ok' ? await approveUser(env, Number(extra)) : await denyUser(env, Number(extra));
      await send(env, adminId(env), result);
      return;
    }

    const user = chatId === adminId(env) ? await ensureAdminUser(env) : await getUser(env, chatId);
    if (!user || user.status !== 'active') return;

    if (cmd === 'pref' && arg === 'notif') {
      await handlePrefCallback(env, chatId, user, extra);
      return;
    }
    if (cmd === 'pular') {
      if (arg === 'outra') await send(env, chatId, ASK_TEXT, { force_reply: true });
      else await doPular(env, chatId, parseDate(arg));
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const low = text.toLowerCase();

  if (low.startsWith('/start')) {
    await doStart(env, msg);
    return;
  }

  const user = chatId === adminId(env) ? await ensureAdminUser(env) : await getUser(env, chatId);
  if (!user || user.status !== 'active') {
    if (user?.status === 'pending') {
      await send(env, chatId, 'Seu cadastro ainda esta aguardando aprovacao do admin — te aviso assim que liberar.');
    } else {
      await send(env, chatId, 'Voce ainda nao esta registrado. Manda /start para se cadastrar.');
    }
    return;
  }

  if (low.startsWith('/pular')) {
    const arg = text.slice('/pular'.length).trim();
    if (arg) await doPular(env, chatId, parseDate(arg));
    else await askDate(env, chatId);
  } else if (low.startsWith('/retomar')) {
    await doRetomar(env, chatId, text.slice('/retomar'.length).trim());
  } else if (low.startsWith('/pulos')) {
    await doPulos(env, chatId);
  } else if (low.startsWith('/config')) {
    await doConfig(env, chatId, origin);
  } else if (low.startsWith('/testar')) {
    await doTestar(env, chatId);
  } else if (low.startsWith('/cancelar')) {
    await send(env, chatId, 'Ok, deixa pra la.');
  } else if (msg.reply_to_message?.text?.startsWith('Qual data?')) {
    await doPular(env, chatId, parseDate(text)); // resposta ao ForceReply de "Outra data"
  } else if (msg.reply_to_message && (await handlePrefReply(env, chatId, user, msg))) {
    // resposta a uma pergunta de preferencia — ja tratada
  } else {
    await send(env, chatId, HELP);
  }
}
