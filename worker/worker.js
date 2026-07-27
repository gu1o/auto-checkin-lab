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
 * Comandos: /start, /pular [data], /retomar [data], /pulos, /painel, /repos,
 * /config, /testar, /cancelar. Onboarding de preferencias (iniciativa, notificacoes, horario)
 * acontece no chat apos a aprovacao, via ForceReply + botoes inline; a
 * pergunta pendente fica em prefs._pending no KV.
 *
 * Deep linking (Fase 1C): a extensao chama POST /devlink (autenticado com o
 * bot token) e recebe um link t.me/<bot>?start=<codigo>; o /start com esse
 * payload conecta o chat sem aprovacao manual e devolve o chat_id via
 * GET /devlink?code=.
 *
 * Notificacao centralizada (Fase 5b): POST /notify { chatId, text } com header
 * x-notify-secret == NOTIFY_SECRET; o worker entrega por Telegram (e por e-mail
 * via Resend se o dev tiver prefs.email e RESEND_API_KEY estiver setado). Tira
 * o bot_token dos configs dos devs — eles so carregam NOTIFY_SECRET + a URL.
 *
 * Env: BOT_TOKEN (secret), WEBHOOK_SECRET (secret), KV_ENC_KEY (secret,
 * 32 bytes em base64), ADMIN_CHAT_ID (var), USERS (KV namespace).
 * Opcionais: NOTIFY_SECRET (secret, habilita /notify), RESEND_API_KEY +
 * NOTIFY_EMAIL_FROM (secret/var, habilitam e-mail no /notify).
 */

const SP_TZ = 'America/Sao_Paulo';
const SKIP_MARKER = 'SKIP:';
const ASK_TEXT = 'Qual data? Responda esta mensagem com DD/MM';
const ASK_INITIATIVE = 'Qual a iniciativa padrao? Responda esta mensagem com o ID numerico (ex: 6)';
const ASK_TIME = 'Qual horario do check-in automatico? Responda esta mensagem com HH:MM (ex: 09:30)';
const SETUP_TTL_S = 600; // 10 minutos
const REPOS_PAGE = 12; // repos por pagina no teclado do /repos
const WD_PT = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
const HELP =
  'Comandos:\n' +
  '/pular — cancela o check-in automatico de um dia (pergunto a data)\n' +
  '/pular DD/MM — cancela direto para a data\n' +
  '/retomar DD/MM — desfaz um cancelamento\n' +
  '/pulos — lista os cancelamentos agendados\n' +
  '/painel — resumo da sua configuracao do check-in automatico\n' +
  '/repos — ver e ajustar os repositorios no escopo da coleta\n' +
  '/config — link seguro para configurar suas credenciais (Jira, Bitbucket, Lab)\n' +
  '/testar — valida as credenciais salvas (Jira, Bitbucket, Lab, IA) sem enviar nada\n' +
  '/dryrun — gera o rascunho do check-in de hoje sem enviar\n' +
  '/agora — roda e envia o check-in agora\n' +
  '/runner on|off — deixa o worker enviar seu check-in automaticamente (opt-in)';

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

    // /notify (Fase 5b) e /devlink (Fase 1C): chamadas dos runners/extensao,
    // nao do Telegram. Autenticacao propria (segredo / bot token), com CORS.
    if (url.pathname === '/notify') {
      try {
        return await handleNotify(request, env);
      } catch (e) {
        console.error('erro no /notify', e);
        return jsonCors({ ok: false, error: 'internal' }, 500);
      }
    }
    if (url.pathname === '/devlink') {
      try {
        return await handleDevlink(request, url, env);
      } catch (e) {
        console.error('erro no /devlink', e);
        return jsonCors({ ok: false, error: 'internal' }, 500);
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

  // Cron Trigger (Fase 6): roda o check-in para cada usuario active que ligou
  // /runner. Inerte enquanto ninguem optou. Ver wrangler.toml [triggers].
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runnerCron(env));
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

  // Deep link da extensao (Fase 1C): /start <codigo>. Se o codigo existe,
  // conecta o chat SEM aprovacao manual do admin e devolve o chat_id para a
  // extensao (via GET /devlink?code=). O codigo prova que veio da extensao.
  const payload = (msg.text || '').split(/\s+/)[1] || '';
  if (payload) {
    const key = `devlink:${payload}`;
    const raw = await env.USERS.get(key);
    if (raw) {
      await env.USERS.put(key, JSON.stringify({ status: 'linked', chatId }), { expirationTtl: SETUP_TTL_S });
      if (chatId === adminId(env)) {
        await ensureAdminUser(env);
        await send(env, chatId, '✅ Telegram conectado pela extensao (admin).');
        return;
      }
      const existing = await getUser(env, chatId);
      if (existing?.status === 'active') {
        await send(env, chatId, '✅ Telegram conectado pela extensao! Voce ja estava registrado.');
        return;
      }
      const nm = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Sem nome';
      await putUser(env, chatId, { name: nm, username: from.username || '', status: 'active', prefs: { _pending: 'initiative' } });
      await send(env, chatId, '✅ Telegram conectado pela extensao! Vamos configurar suas preferencias.');
      await send(env, chatId, ASK_INITIATIVE, { force_reply: true });
      return;
    }
    // codigo invalido/expirado: segue o fluxo normal de /start abaixo
  }

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
      <label>Project key (opcional; filtra repos por project, vazio = todos)</label><input name="bb_project_key" placeholder="IDEALPLUS">
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
        project_key: f('bb_project_key'),
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

// --- /notify (Fase 5b) + /devlink (Fase 1C) -------------------------------------

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-notify-secret, x-bot-token',
};

function jsonCors(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// Envio de e-mail via Resend (opcional): so se RESEND_API_KEY estiver setado.
async function sendEmail(env, to, subject, text) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.NOTIFY_EMAIL_FROM || 'lab-checkin@resend.dev',
        to,
        subject,
        text,
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// POST /notify — o runner manda { chatId, text }; o worker resolve o canal do
// dev (Telegram sempre; e-mail via Resend se o dev tiver prefs.email e o worker
// tiver RESEND_API_KEY). Assim o bot_token sai dos configs dos devs: eles so
// carregam NOTIFY_SECRET + a URL do worker.
async function handleNotify(request, env) {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return jsonCors({ ok: false, error: 'method not allowed' }, 405);
  if (!env.NOTIFY_SECRET || request.headers.get('x-notify-secret') !== env.NOTIFY_SECRET) {
    return jsonCors({ ok: false, error: 'forbidden' }, 403);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonCors({ ok: false, error: 'bad request' }, 400);
  }
  const chatId = Number(body.chatId);
  const text = (body.text || '').toString();
  if (!chatId || !text) return jsonCors({ ok: false, error: 'chatId/text obrigatorios' }, 400);

  let delivered = false;
  const user = await getUser(env, chatId);
  const email = user?.prefs?.email;
  if (email) delivered = await sendEmail(env, email, 'lab-checkin', text);
  if (!delivered) {
    const r = await send(env, chatId, text);
    delivered = !!r.ok;
  }
  return jsonCors({ ok: delivered });
}

// /devlink — deep linking com a extensao (Fase 1C).
//   POST { token } (bot token compartilhado)  -> { code, link } (t.me/...start=code)
//   GET  ?code=...                            -> { status, chatId? }
// O /start com o payload (ver doStart) auto-aprova o chat SEM botao do admin:
// o codigo prova que a pessoa veio da extensao (so quem tem o bot token gera).
async function handleDevlink(request, url, env) {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const token = body.token || request.headers.get('x-bot-token');
    if (!token || token !== env.BOT_TOKEN) return jsonCors({ ok: false, error: 'forbidden' }, 403);
    const code = randomCode();
    await env.USERS.put(`devlink:${code}`, JSON.stringify({ status: 'pending' }), { expirationTtl: SETUP_TTL_S });
    const me = await api(env, 'getMe');
    const uname = me.result?.username;
    const link = uname ? `https://t.me/${uname}?start=${code}` : null;
    return jsonCors({ ok: true, code, link });
  }
  if (request.method === 'GET') {
    const code = url.searchParams.get('code') || '';
    const raw = code && (await env.USERS.get(`devlink:${code}`));
    if (!raw) return jsonCors({ ok: false, status: 'expired' });
    return jsonCors({ ok: true, ...JSON.parse(raw) });
  }
  return jsonCors({ ok: false, error: 'method not allowed' }, 405);
}

// --- credenciais salvas (KV secrets:<chatId>) ----------------------------------

/** Le e descriptografa secrets:<chatId>. Retorna { secrets, error }:
 *  secrets=null + error=null  => nao ha nada salvo (nunca fez /config);
 *  secrets=null + error='decrypt' => blob existe mas nao abriu (refazer /config). */
async function loadSecrets(env, chatId) {
  const blob = await env.USERS.get(`secrets:${chatId}`);
  if (!blob) return { secrets: null, error: null };
  try {
    return { secrets: await decryptJson(env, blob), error: null };
  } catch {
    return { secrets: null, error: 'decrypt' };
  }
}

async function saveSecrets(env, chatId, secrets) {
  secrets.updated_at = new Date().toISOString();
  await env.USERS.put(`secrets:${chatId}`, await encryptJson(env, secrets));
}

// --- /repos: ajustar o escopo de repositorios da coleta -------------------------
// O escopo vive em secrets.bitbucket.repositories (mesmo campo que o /config e o
// auto_activity.py usam). Convencao: LISTA VAZIA = todos os repos do workspace.
// Cada entrada e tratada como padrao (slug exato ou regex/substring), igual ao
// coletor; por isso a marcacao ✅ usa repoMatches para refletir o que de fato
// entra na coleta. Toggle: adiciona o slug exato ou remove as entradas que casam.

function bitbucketHeaders(s) {
  const bb = (s && s.bitbucket) || {};
  const token = bb.api_token;
  const headers = { accept: 'application/json' };
  if (token) {
    if (token.startsWith('ATATT')) {
      const user = bb.username || (s.jira || {}).email || '';
      headers.authorization = 'Basic ' + btoa(`${user}:${token}`);
    } else {
      headers.authorization = `Bearer ${token}`;
    }
  } else if (bb.username && bb.app_password) {
    headers.authorization = 'Basic ' + btoa(`${bb.username}:${bb.app_password}`);
  } else {
    return null;
  }
  return headers;
}

/** Casa `pattern` contra o slug `repo`: exato (case-insensitive) ou regex
 *  (case-insensitive); regex invalida cai para substring. Espelha _repo_matches
 *  do auto_activity.py. */
function repoMatches(pattern, repo) {
  if (!pattern) return false;
  const p = pattern.trim();
  const r = repo.trim();
  if (p.toLowerCase() === r.toLowerCase()) return true;
  try {
    return new RegExp(p, 'i').test(r);
  } catch {
    return r.toLowerCase().includes(p.toLowerCase());
  }
}

function inScope(repo, repositories) {
  return (repositories || []).some((p) => repoMatches(p, repo));
}

/** Lista (paginado) os slugs do workspace, filtrando por project_key se houver.
 *  Retorna null se falta workspace/credencial; senao { repos, listed }: listed
 *  distingue "listou (talvez vazio)" de "nao consegui listar (permissao/erro)". */
async function listWorkspaceRepos(s) {
  const bb = (s && s.bitbucket) || {};
  const workspace = bb.workspace;
  if (!workspace) return null;
  const headers = bitbucketHeaders(s);
  if (!headers) return null;
  const pk = (bb.project_key || '').trim();
  let url = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}?pagelen=100`;
  if (pk) url += `&q=${encodeURIComponent(`project.key="${pk}"`)}`;
  const repos = [];
  let listed = false;
  let page = 0;
  while (url && page < 50) {
    let r;
    try {
      r = await fetchT(url, { headers });
    } catch {
      break;
    }
    if (!r.ok) break;
    listed = true;
    const data = await r.json().catch(() => null);
    if (!data) break;
    for (const v of data.values || []) if (v.slug) repos.push(v.slug);
    url = data.next || null;
    page += 1;
  }
  return { repos: repos.sort(), listed };
}

/** Monta o texto + teclado do /repos para uma pagina. */
function renderRepos(secrets, universe, page) {
  const repositories = (secrets.bitbucket && secrets.bitbucket.repositories) || [];
  const empty = repositories.length === 0;
  const total = universe.length;
  const pages = Math.max(1, Math.ceil(total / REPOS_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const start = page * REPOS_PAGE;
  const slice = universe.slice(start, start + REPOS_PAGE);

  const header = empty
    ? '📦 Escopo atual: todos os repositorios (lista vazia).\n\n' +
      'Toque num repo para incluir no escopo — a partir dai a coleta considera SO os marcados. Salva na hora.'
    : `📦 Escopo atual: ${repositories.length} no escopo (${repositories.join(', ')}).\n\n` +
      'Toque para incluir/remover. Salva na hora.';

  const rows = slice.map((repo, i) => {
    const idx = start + i;
    const on = !empty && inScope(repo, repositories);
    return [{ text: `${on ? '✅' : '⬜'} ${repo}`, callback_data: `rp:t:${idx}` }];
  });
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '⬅️', callback_data: `rp:pg:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: `rp:pg:${page}` });
    if (page < pages - 1) nav.push({ text: '➡️', callback_data: `rp:pg:${page + 1}` });
    rows.push(nav);
  }
  rows.push([
    { text: '🧹 Limpar (= todos)', callback_data: 'rp:clear' },
    { text: '✔️ Fechar', callback_data: 'rp:close' },
  ]);

  const footer = pages > 1 ? `\n\n${total} repos no workspace — pagina ${page + 1}/${pages}.` : '';
  return { text: header + footer, reply_markup: { inline_keyboard: rows } };
}

async function doRepos(env, chatId) {
  const { secrets, error } = await loadSecrets(env, chatId);
  if (error === 'decrypt') {
    await send(env, chatId, 'Nao consegui ler suas credenciais salvas. Refaca o /config e tente de novo.');
    return;
  }
  if (!secrets) {
    await send(env, chatId, 'Voce ainda nao configurou o Bitbucket. Use /config para informar workspace e token.');
    return;
  }
  const res = await listWorkspaceRepos(secrets);
  if (!res) {
    await send(env, chatId, 'Bitbucket sem workspace/credencial no seu /config. Configure com /config e tente de novo.');
    return;
  }
  if (!res.listed) {
    await send(env, chatId, 'Nao consegui listar os repos do workspace (o token tem permissao Repositories:Read? workspace correto?). Cheque com /testar.');
    return;
  }
  if (!res.repos.length) {
    await send(env, chatId, 'O workspace nao retornou repositorios (ou o project_key filtra tudo). Ajuste no /config.');
    return;
  }
  await env.USERS.put(`reposui:${chatId}`, JSON.stringify(res.repos), { expirationTtl: SETUP_TTL_S });
  const { text, reply_markup } = renderRepos(secrets, res.repos, 0);
  await send(env, chatId, text, reply_markup);
}

async function handleReposCallback(env, chatId, messageId, arg, extra) {
  if (!messageId) return;
  const edit = (text, reply_markup) =>
    api(env, 'editMessageText', { chat_id: Number(chatId), message_id: messageId, text, ...(reply_markup ? { reply_markup } : {}) });

  if (arg === 'close') {
    await api(env, 'editMessageReplyMarkup', { chat_id: Number(chatId), message_id: messageId });
    return;
  }

  const cached = await env.USERS.get(`reposui:${chatId}`);
  const universe = cached ? JSON.parse(cached) : null;
  if (!universe) {
    await edit('Essa lista de repos expirou. Mande /repos de novo.');
    return;
  }
  const { secrets, error } = await loadSecrets(env, chatId);
  if (!secrets) {
    await edit(error === 'decrypt' ? 'Nao consegui ler suas credenciais. Refaca o /config.' : 'Credenciais sumiram. Use /config.');
    return;
  }
  secrets.bitbucket = secrets.bitbucket || {};
  let repositories = secrets.bitbucket.repositories || [];
  let page = 0;

  if (arg === 'pg') {
    page = Number(extra) || 0;
  } else if (arg === 'clear') {
    if (repositories.length) {
      secrets.bitbucket.repositories = [];
      await saveSecrets(env, chatId, secrets);
    }
  } else if (arg === 't') {
    const idx = Number(extra);
    const repo = universe[idx];
    if (repo != null) {
      repositories = inScope(repo, repositories)
        ? repositories.filter((p) => !repoMatches(p, repo))
        : [...repositories, repo];
      secrets.bitbucket.repositories = repositories;
      await saveSecrets(env, chatId, secrets);
      page = Math.floor(idx / REPOS_PAGE);
    }
  }

  const { text, reply_markup } = renderRepos(secrets, universe, page);
  await edit(text, reply_markup);
}

// --- /painel: resumo (so leitura) da configuracao do check-in automatico --------

async function doPainel(env, chatId) {
  const { secrets, error } = await loadSecrets(env, chatId);
  const user = chatId === adminId(env) ? await ensureAdminUser(env) : await getUser(env, chatId);
  const prefs = (user && user.prefs) || {};

  const lines = ['📋 Seu setup do check-in automatico', ''];
  lines.push(`• Iniciativa padrao: ${prefs.initiative ?? '(nao definida)'}`);
  lines.push(`• Notificacoes: ${prefs.notifications ? 'on' : 'off'}${prefs.email ? ` (e-mail: ${prefs.email})` : ''}`);
  lines.push(`• Horario preferido: ${prefs.time || '(nao definido)'}`);
  lines.push(`• Runner do worker: ${prefs.runner === 'worker' ? 'ATIVADO (o worker envia seu check-in)' : 'desativado'}`);
  lines.push('');

  if (error === 'decrypt') {
    lines.push('⚠️ Nao consegui ler suas credenciais salvas — refaca o /config.');
  } else if (!secrets) {
    lines.push('Credenciais: nenhuma salva ainda. Use /config para configurar Jira, Bitbucket, LLM e o cookie do Lab.');
  } else {
    const j = secrets.jira || {};
    lines.push(`• Jira: ${j.url && j.email && j.api_token ? `configurado (${j.url})` : 'nao configurado'}`);
    const bb = secrets.bitbucket || {};
    const repos = bb.repositories || [];
    const pk = (bb.project_key || '').trim();
    lines.push(`• Bitbucket: ${bb.workspace ? `workspace ${bb.workspace}` : 'sem workspace'}${pk ? `, project ${pk}` : ''}`);
    lines.push(`    escopo de repos: ${repos.length ? `${repos.length} (${repos.join(', ')})` : 'todos (lista vazia)'}`);
    const provider = secrets.llm_provider || 'gemini';
    const keys = [];
    if (secrets.gemini && secrets.gemini.api_key) keys.push('Gemini');
    if (secrets.anthropic && secrets.anthropic.api_key) keys.push('Claude');
    lines.push(`• LLM: provider ${provider}${keys.length ? `, chaves: ${keys.join(', ')}` : ', nenhuma chave'}`);
    const lab = secrets.lab || {};
    lines.push(`• Ideal Lab: ${lab.cookie_name && lab.cookie_value ? 'cookie configurado' : 'cookie nao configurado'}`);
  }

  lines.push('');
  const { dates } = await getSkips(env, chatId);
  const future = (dates || []).filter((d) => d >= todayIso());
  lines.push(`• Skips agendados: ${future.length ? future.map(fmt).join(', ') : 'nenhum'}`);
  lines.push('');
  lines.push('Ajustar: /repos (escopo) · /config (credenciais) · /testar (validar) · /pular (cancelar um dia)');

  await send(env, chatId, lines.join('\n'));
}

// --- Fase 6: worker como runner do check-in (opt-in por usuario) ---------------
// Cron Trigger diario roda o check-in para cada usuario active com
// prefs.runner === 'worker', usando as credenciais do KV (secrets:<chatId>).
// Porta fiel do checkin.sh + auto_activity.py: guardas (fim de semana, feriado,
// skip fixado, ja-preenchido), coleta Jira/Bitbucket, roteia por iniciativa,
// gera o texto (Claude/Gemini/template) e envia ao Lab pelo fluxo do cookie
// remember_web. OPT-IN e default OFF: quem nao ligou /runner nao e tocado — o
// cron itera o KV e pula todos, entao o deploy e inerte ate alguem optar.

const LAB_BASE = 'https://lab.idealtrends.io';
const LAB_ENDPOINT = `${LAB_BASE}/saude-entrega/daily`;
const LAB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const DEFAULT_INITIATIVE = 6;
const RUNNER_TIMEOUT_MS = 30000;
const PROJECT_KEY_RE = /\b([A-Z][A-Z0-9]+)-\d+\b/;

function rfetch(url, opts = {}, ms = RUNNER_TIMEOUT_MS) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

// --- datas / feriados (porta de auto_activity.py) --------------------------------

function lastBusinessDayIso(iso) {
  const wd = weekday(iso); // 0=domingo ... 6=sabado
  const days = wd === 1 ? 3 : wd === 0 ? 2 : 1; // segunda->sexta, domingo->sexta, senao ontem
  return addDays(iso, -days);
}

function easterIso(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function holidaysForYear(year) {
  const set = new Set();
  const staticMD = ['01-01', '01-25', '04-21', '05-01', '07-09', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];
  for (const md of staticMD) set.add(`${year}-${md}`);
  const easter = easterIso(year);
  set.add(addDays(easter, -47)); // carnaval
  set.add(addDays(easter, -2)); // sexta-feira santa
  set.add(addDays(easter, 60)); // corpus christi
  try {
    const r = await rfetch(`https://brasilapi.com.br/api/feriados/v1/${year}`, { headers: { accept: 'application/json' } }, 6000);
    if (r.ok) {
      const arr = await r.json().catch(() => []);
      for (const hd of arr || []) if (hd.date) set.add(hd.date);
    }
  } catch {
    /* redundancia opcional; feriados estaticos ja cobrem o essencial */
  }
  return set;
}

async function isHolidayIso(iso) {
  const set = await holidaysForYear(Number(iso.slice(0, 4)));
  return set.has(iso);
}

// --- coleta Jira/Bitbucket (porta de auto_activity.py) ---------------------------

async function jiraActivity(secrets, sinceIso) {
  const j = secrets.jira || {};
  if (!(j.url && j.email && j.api_token)) return [];
  const url = j.url.replace(/\/$/, '');
  const jql = `assignee = currentUser() AND updated >= "${sinceIso}"`;
  const auth = 'Basic ' + btoa(`${j.email}:${j.api_token}`);
  let r;
  try {
    r = await rfetch(`${url}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ jql, fields: ['summary', 'status', 'updated', 'key'] }),
    });
  } catch {
    return [];
  }
  if (!r.ok) return [];
  const data = await r.json().catch(() => null);
  if (!data) return [];
  return (data.issues || []).map((i) => ({
    key: i.key,
    summary: i.fields?.summary,
    status: i.fields?.status?.name || 'Unknown',
    updated: i.fields?.updated,
  }));
}

async function bitbucketActivity(secrets, sinceIso) {
  const bb = secrets.bitbucket || {};
  const workspace = bb.workspace;
  if (!workspace) return [];
  const headers = bitbucketHeaders(secrets);
  if (!headers) return [];
  let username = bb.username;
  if (!username) {
    try {
      const r = await rfetch('https://api.bitbucket.org/2.0/user', { headers });
      if (r.ok) {
        const u = await r.json().catch(() => ({}));
        username = u.username || u.nickname || u.display_name || '';
      }
    } catch {
      /* token so-repositorio nao acessa /user; segue sem filtro de autor */
    }
  }
  const patterns = bb.repositories || [];
  const exclude = bb.repositories_exclude || [];
  const res = await listWorkspaceRepos(secrets);
  let repos;
  if (res && res.listed && res.repos.length) {
    repos = patterns.length ? res.repos.filter((r) => patterns.some((p) => repoMatches(p, r))) : res.repos.slice();
    if (exclude.length) repos = repos.filter((r) => !exclude.some((e) => repoMatches(e, r)));
  } else {
    repos = patterns.filter((p) => !exclude.some((e) => repoMatches(e, p)));
  }

  const commits = [];
  for (const repo of repos) {
    let r;
    try {
      r = await rfetch(`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/commits?pagelen=30`, { headers });
    } catch {
      continue;
    }
    if (!r.ok) continue;
    const data = await r.json().catch(() => null);
    if (!data) continue;
    for (const c of data.values || []) {
      const authorRaw = (c.author && c.author.raw) || '';
      const dateStr = c.date;
      if (dateStr && dateStr >= sinceIso && (!username || authorRaw.toLowerCase().includes(username.toLowerCase()))) {
        commits.push({ repo, hash: (c.hash || '').slice(0, 7), message: (c.message || '').trim().split('\n')[0], date: dateStr });
      }
    }
  }
  return commits;
}

// --- roteamento por iniciativa (porta de route_activity) -------------------------

function splitCsv(v) {
  return String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function routeActivity(jira, bb, initiativeConfig, defaultInit) {
  const ic = initiativeConfig || {};
  const projToInit = {};
  const repoToInit = {};
  for (const [id, val] of Object.entries(ic.projects || {})) for (const pk of splitCsv(val)) projToInit[pk.toUpperCase()] = Number(id);
  for (const [id, val] of Object.entries(ic.repos || {})) for (const rp of splitCsv(val)) repoToInit[rp.toLowerCase()] = Number(id);

  const buckets = {};
  const bucket = (id) => (buckets[id] || (buckets[id] = { jira: [], bb: [] }));
  const unJ = [];
  const unB = [];

  for (const it of jira) {
    const key = it.key || '';
    const pk = key.includes('-') ? key.split('-')[0].toUpperCase() : '';
    const id = projToInit[pk];
    if (id != null) bucket(id).jira.push(it);
    else unJ.push(it);
  }
  for (const c of bb) {
    let id = repoToInit[(c.repo || '').toLowerCase()];
    if (id == null) {
      const m = PROJECT_KEY_RE.exec(c.message || '');
      if (m) id = projToInit[m[1].toUpperCase()];
    }
    if (id != null) bucket(id).bb.push(c);
    else unB.push(c);
  }

  const warnings = [];
  if (unJ.length || unB.length) {
    const b = bucket(defaultInit);
    b.jira.push(...unJ);
    b.bb.push(...unB);
    const unkP = [...new Set(unJ.filter((i) => (i.key || '').includes('-')).map((i) => i.key.split('-')[0].toUpperCase()))].sort();
    const unkR = [...new Set(unB.map((c) => c.repo).filter(Boolean))].sort();
    const parts = [];
    if (unkP.length) parts.push('projetos ' + unkP.join(', '));
    if (unkR.length) parts.push('repos ' + unkR.join(', '));
    warnings.push(`Atividade nao mapeada${parts.length ? ` (${parts.join('; ')})` : ''} roteada para a iniciativa padrao ${defaultInit}. Ajuste initiative_config.`);
  }
  return { buckets, warnings };
}

// --- geracao de texto (Claude/Gemini/template) -----------------------------------

function genPrompt(ctx) {
  return (
    'Você é um desenvolvedor preenchendo o check-in diário de atividades.\n' +
    'Com base nas atividades brutas do Jira e Bitbucket abaixo, gere dois blocos de texto em português (um "yesterday", um "today").\n\n' +
    'Regras:\n' +
    '1. Português profissional, direto e natural, estilo daily.\n' +
    '2. Não cite códigos de tasks (ex: evite "PROJ-123"). Fale do assunto de forma natural.\n' +
    '3. Sintetize; agrupe commits em realizações lógicas em vez de listar literalmente.\n' +
    '4. Para "today", deduza o que fazer com base nas tarefas não concluídas (In Progress/pendentes) ou continuação.\n' +
    '5. Responda estritamente no JSON: {"yesterday": "...", "today": "..."}\n\n' +
    'Dados de atividade:\n' +
    JSON.stringify(ctx, null, 2)
  );
}

async function generateClaude(apiKey, jira, bb) {
  const ctx = { jira_issues_updated: jira, bitbucket_commits: bb };
  let r;
  try {
    r = await rfetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 1024,
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: { yesterday: { type: 'string' }, today: { type: 'string' } },
              required: ['yesterday', 'today'],
              additionalProperties: false,
            },
          },
        },
        messages: [{ role: 'user', content: genPrompt(ctx) }],
      }),
    });
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  if (!data || data.stop_reason === 'refusal') return null;
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const p = JSON.parse(text);
    return { yesterday: p.yesterday, today: p.today };
  } catch {
    return null;
  }
}

async function generateGemini(apiKey, jira, bb) {
  const ctx = { jira_issues_updated: jira, bitbucket_commits: bb };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  let r;
  try {
    r = await rfetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: genPrompt(ctx) }] }], generationConfig: { responseMimeType: 'application/json' } }),
    });
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  try {
    const text = data.candidates[0].content.parts[0].text.trim();
    const p = JSON.parse(text);
    return { yesterday: p.yesterday, today: p.today };
  } catch {
    return null;
  }
}

function generateTemplate(jira, bb) {
  const yl = [];
  if (jira.length) {
    yl.push('Tasks atualizadas:');
    for (const it of jira) yl.push(`  - [${it.key}] ${it.summary} (Status: ${it.status})`);
  }
  if (bb.length) {
    yl.push('Commits realizados:');
    for (const it of bb) yl.push(`  - [${it.repo}] ${it.message}`);
  }
  const yesterday = yl.length ? yl.join('\n') : 'Sem atividades registradas no Jira/Bitbucket.';

  const tl = [];
  const inProg = jira.filter((i) => ['in progress', 'em andamento', 'doing'].includes((i.status || '').toLowerCase()));
  if (inProg.length) {
    tl.push('Continuar trabalhando em:');
    for (const it of inProg) tl.push(`  - [${it.key}] ${it.summary}`);
  } else {
    const todo = jira.filter((i) => !['done', 'concluído', 'closed'].includes((i.status || '').toLowerCase()));
    if (todo.length) {
      tl.push('Trabalhar em:');
      for (const it of todo.slice(0, 3)) tl.push(`  - [${it.key}] ${it.summary}`);
    }
  }
  const today = tl.length ? tl.join('\n') : 'Continuar as atividades pendentes e atuar em novas demandas do board.';
  return { yesterday, today };
}

async function buildCheckinText(secrets, jira, bb, yesterdayIsHoliday) {
  let y = null;
  let t = null;
  const provider = secrets.llm_provider || 'gemini';
  if (provider === 'claude' && secrets.anthropic?.api_key) {
    const r = await generateClaude(secrets.anthropic.api_key, jira, bb);
    if (r) ({ yesterday: y, today: t } = r);
  } else if (secrets.gemini?.api_key) {
    const r = await generateGemini(secrets.gemini.api_key, jira, bb);
    if (r) ({ yesterday: y, today: t } = r);
  } else if (secrets.anthropic?.api_key) {
    const r = await generateClaude(secrets.anthropic.api_key, jira, bb);
    if (r) ({ yesterday: y, today: t } = r);
  }
  if (!y || !t) {
    const tpl = generateTemplate(jira, bb);
    if (!y) y = tpl.yesterday;
    if (!t) t = tpl.today;
  }
  if (yesterdayIsHoliday) y = '';
  return { yesterday: y, today: t };
}

// --- sessao + submit no Lab (porta do fluxo cookie/XSRF do checkin.sh) ------------

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function labSession(secrets) {
  const lab = secrets.lab || {};
  if (!lab.cookie_name || !lab.cookie_value) return { ok: false, error: 'cookie' };
  const baseCookie = `${lab.cookie_name}=${lab.cookie_value}`;
  let r;
  try {
    r = await rfetch(LAB_ENDPOINT, { headers: { accept: 'text/html', 'user-agent': LAB_UA, cookie: baseCookie }, redirect: 'manual' });
  } catch {
    return { ok: false, error: 'net' };
  }
  if (r.status >= 300 && r.status < 400) return { ok: false, error: 'redirect' }; // login -> cookie expirado
  if (!r.ok) return { ok: false, error: `http_${r.status}` };

  const jar = { [lab.cookie_name]: lab.cookie_value };
  const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (m) jar[m[1].trim()] = m[2];
  }
  const xsrfRaw = jar['XSRF-TOKEN'];
  const xsrf = xsrfRaw ? decodeURIComponent(xsrfRaw) : '';
  const cookieHeader = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

  const htmlBody = await r.text();
  const m = htmlBody.match(/data-page="([^"]*)"/);
  let props = null;
  if (m) {
    try {
      props = JSON.parse(decodeEntities(m[1]));
    } catch {
      /* props ausente: guardas por-iniciativa ficam permissivas */
    }
  }
  return { ok: true, cookieHeader, xsrf, props };
}

function labIsSubmitted(props, initId) {
  const cards = props?.props?.cards || [];
  return cards.some((c) => Number(c.initiativeId) === Number(initId) && c.existing);
}

async function labSubmit(session, { initiative, date, yesterday, today, confidence = 5, blockers = 'Nenhum', artifact = '' }) {
  const blockersText = blockers.trim().toLowerCase() === 'nenhum' ? '' : blockers;
  const payload = {
    initiative_id: Number(initiative),
    checkin_date: date,
    yesterday_text: yesterday,
    yesterday_artifact_url: artifact,
    today_text: today,
    confidence_score: Number(confidence),
    blockers_text: blockersText,
  };
  let r;
  try {
    r = await rfetch(LAB_ENDPOINT, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        accept: 'text/html, application/xhtml+xml',
        origin: LAB_BASE,
        referer: LAB_ENDPOINT,
        'user-agent': LAB_UA,
        'x-inertia': 'true',
        'x-inertia-version': '1',
        'x-requested-with': 'XMLHttpRequest',
        'x-xsrf-token': session.xsrf,
        cookie: session.cookieHeader,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, status: 0 };
  }
  const ok = r.status === 200 || r.status === 302 || r.status === 303;
  return { ok, status: r.status };
}

// --- orquestracao ----------------------------------------------------------------

async function runCheckin(env, chatId, { dryRun = false, force = false } = {}) {
  const { secrets, error } = await loadSecrets(env, chatId);
  if (error === 'decrypt') return '❌ Nao consegui ler suas credenciais. Refaca o /config.';
  if (!secrets) return 'Sem credenciais salvas. Configure com /config.';

  const user = chatId === adminId(env) ? await ensureAdminUser(env) : await getUser(env, chatId);
  const prefs = (user && user.prefs) || {};
  const defaultInit = Number(prefs.initiative) || DEFAULT_INITIATIVE;
  const t = todayIso();

  if (!force) {
    const wd = weekday(t);
    if (wd === 0 || wd === 6) return 'Fim de semana — o check-in nao roda.';
    if (await isHolidayIso(t)) return 'Feriado — o check-in nao roda.';
    const { dates } = await getSkips(env, chatId);
    if ((dates || []).includes(t)) return '🚫 Hoje esta cancelado via /pular — nada sera enviado.';
  }

  const since = lastBusinessDayIso(t);
  const yHol = weekday(since) === 0 || weekday(since) === 6 || (await isHolidayIso(since));
  const [jira, bb] = await Promise.all([jiraActivity(secrets, since), bitbucketActivity(secrets, since)]);

  const ic = secrets.initiative_config || {};
  const hasMap = (ic.repos && Object.keys(ic.repos).length) || (ic.projects && Object.keys(ic.projects).length);

  const checkins = [];
  let warnings = [];
  if (!hasMap) {
    const { yesterday, today } = await buildCheckinText(secrets, jira, bb, yHol);
    checkins.push({ initiative: defaultInit, yesterday, today });
  } else {
    const routed = routeActivity(jira, bb, ic, defaultInit);
    warnings = routed.warnings;
    for (const id of Object.keys(routed.buckets).map(Number).sort((a, b) => a - b)) {
      const bkt = routed.buckets[id];
      if (!bkt.jira.length && !bkt.bb.length) continue;
      const { yesterday, today } = await buildCheckinText(secrets, bkt.jira, bkt.bb, yHol);
      checkins.push({ initiative: id, yesterday, today });
    }
    if (!checkins.length) {
      const { yesterday, today } = await buildCheckinText(secrets, [], [], yHol);
      checkins.push({ initiative: defaultInit, yesterday, today });
    }
  }

  if (dryRun) {
    const out = ['🧪 DRY RUN — nada foi enviado ao Lab.'];
    if (warnings.length) out.push('⚠️ ' + warnings.join(' | '));
    for (const c of checkins) out.push(`\n=== Iniciativa ${c.initiative} ===\nONTEM:\n${c.yesterday}\n\nHOJE:\n${c.today}`);
    return out.join('\n');
  }

  const session = await labSession(secrets);
  if (!session.ok) {
    const msg =
      session.error === 'redirect'
        ? 'cookie remember_web expirado — relogue no Lab e refaca o /config'
        : session.error === 'cookie'
          ? 'cookie do Lab nao configurado (use /config)'
          : `sessao do Lab falhou (${session.error})`;
    return `❌ ${msg}`;
  }

  const results = [];
  if (warnings.length) results.push('⚠️ ' + warnings.join(' | '));
  for (const c of checkins) {
    if (labIsSubmitted(session.props, c.initiative)) {
      results.push(`ℹ️ Iniciativa ${c.initiative} ja preenchida hoje.`);
      continue;
    }
    const r = await labSubmit(session, { initiative: c.initiative, date: t, yesterday: c.yesterday, today: c.today });
    results.push(r.ok ? `✅ Iniciativa ${c.initiative} enviada (HTTP ${r.status}).` : `❌ Iniciativa ${c.initiative}: HTTP ${r.status}.`);
  }
  return results.join('\n');
}

// --- comandos do runner (opt-in + teste manual) ----------------------------------

async function doRunner(env, chatId, arg) {
  const user = chatId === adminId(env) ? await ensureAdminUser(env) : await getUser(env, chatId);
  if (!user) return;
  user.prefs = user.prefs || {};
  const a = (arg || '').trim().toLowerCase();
  if (a === 'on') {
    user.prefs.runner = 'worker';
    await putUser(env, chatId, user);
    await send(
      env,
      chatId,
      '▶️ Runner do worker ATIVADO. O worker passara a enviar seu check-in nos ticks ' +
        `(horario: ${user.prefs.time || 'assim que o tick rodar'}).\n\n` +
        '⚠️ IMPORTANTE: desative sua rotina cloud/cron para nao enviar em duplicidade. ' +
        'Teste antes com /dryrun e /agora.',
    );
  } else if (a === 'off') {
    delete user.prefs.runner;
    await putUser(env, chatId, user);
    await send(env, chatId, '⏸️ Runner do worker DESATIVADO. Volte a usar sua rotina cloud/cron.');
  } else {
    await send(
      env,
      chatId,
      `Runner do worker: ${user.prefs.runner === 'worker' ? 'ATIVADO' : 'desativado'}.\n` +
        '/runner on — o worker envia seu check-in\n/runner off — desliga\n\n' +
        'Antes de ligar: teste com /dryrun (rascunho) e /agora (envia agora), e desligue a rotina cloud/cron.',
    );
  }
}

async function doDryrun(env, chatId) {
  await send(env, chatId, 'Gerando o rascunho (sem enviar)...');
  await send(env, chatId, await runCheckin(env, chatId, { dryRun: true }));
}

async function doAgora(env, chatId) {
  await send(env, chatId, 'Rodando o check-in agora (ignora o horario; respeita fim de semana/feriado/pular)...');
  await send(env, chatId, await runCheckin(env, chatId, { force: false }));
}

// --- Cron Trigger: roda para cada usuario active que optou pelo runner -----------

function scheduleGate(prefs) {
  const time = (prefs.time || '').trim();
  if (!time) return true;
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: SP_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  return now >= time;
}

async function runnerCron(env) {
  let cursor;
  do {
    const list = await env.USERS.list({ prefix: 'user:', cursor });
    cursor = list.list_complete ? undefined : list.cursor;
    for (const k of list.keys) {
      const chatId = Number(k.name.slice('user:'.length));
      if (!chatId) continue;
      const user = await getUser(env, chatId);
      if (!user || user.status !== 'active') continue;
      if (user.prefs?.runner !== 'worker') continue; // opt-in
      if (!scheduleGate(user.prefs || {})) continue; // modelo tick: so a partir do horario
      try {
        const out = await runCheckin(env, chatId, {});
        // Notifica so quando algo aconteceu de verdade (envio ✅ ou erro ❌);
        // silencia "ja preenchida"/fim de semana/feriado/pular para evitar ruido.
        if (/[✅❌]/.test(out)) await send(env, chatId, out);
      } catch (e) {
        console.error('runnerCron', chatId, e);
        await send(env, chatId, '❌ Erro no check-in automatico do worker: ' + String(e).slice(0, 200));
      }
    }
  } while (cursor);
}

// exporta para uso futuro
export { decryptJson };

// --- roteamento -----------------------------------------------------------------

async function handle(update, env, origin) {
  if (update.callback_query) {
    const cq = update.callback_query;
    await api(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    const chatId = cq.message?.chat?.id ?? cq.from.id;
    const [cmd, arg, extra] = (cq.data || '').split(':');
    // O teclado do /repos e persistente (toggle que salva na hora e re-renderiza);
    // nao removemos seus botoes. Os demais fluxos sao one-shot e limpam o teclado.
    if (cq.message && cmd !== 'rp') {
      await api(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id });
    }

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
    if (cmd === 'rp') {
      await handleReposCallback(env, chatId, cq.message?.message_id, arg, extra);
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
  } else if (low.startsWith('/painel')) {
    await doPainel(env, chatId);
  } else if (low.startsWith('/repos')) {
    await doRepos(env, chatId);
  } else if (low.startsWith('/runner')) {
    await doRunner(env, chatId, text.slice('/runner'.length).trim());
  } else if (low.startsWith('/dryrun')) {
    await doDryrun(env, chatId);
  } else if (low.startsWith('/agora')) {
    await doAgora(env, chatId);
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
