/**
 * Cloudflare Worker: bot do Telegram (@CheckInLabBot) para o lab-checkin.
 *
 * Substitui o poller local (telegram_poller.py) por um webhook sempre no ar —
 * sem depender do WSL ligado. 100% stateless: o unico estado (datas de skip)
 * vive na MENSAGEM FIXADA do chat, no formato "SKIP: 2026-07-20, ...", que as
 * rotinas cloud leem via getChat.
 *
 * Comandos: /pular [data], /retomar [data], /pulos, /cancelar.
 * "/pular" sem data pergunta com botoes (Hoje/Amanha/Outra data); "Outra data"
 * usa ForceReply, e a resposta do usuario e reconhecida via reply_to_message.
 *
 * Env: BOT_TOKEN (secret), WEBHOOK_SECRET (secret), CHAT_ID (var).
 */

const SP_TZ = 'America/Sao_Paulo';
const SKIP_MARKER = 'SKIP:';
const ASK_TEXT = 'Qual data? Responda esta mensagem com DD/MM';
const WD_PT = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
const HELP =
  'Comandos:\n' +
  '/pular — cancela o check-in automatico de um dia (pergunto a data)\n' +
  '/pular DD/MM — cancela direto para a data\n' +
  '/retomar DD/MM — desfaz um cancelamento\n' +
  '/pulos — lista os cancelamentos agendados';

export default {
  async fetch(request, env) {
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
      await handle(update, env);
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

function send(env, text, replyMarkup) {
  const params = { chat_id: Number(env.CHAT_ID), text };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return api(env, 'sendMessage', params);
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

// --- mensagem fixada com as datas de skip ------------------------------------

async function getSkips(env) {
  const r = await api(env, 'getChat', { chat_id: Number(env.CHAT_ID) });
  const pm = r.result?.pinned_message;
  if (!pm || !(pm.text || '').includes(SKIP_MARKER)) return { pm: null, dates: [] };
  const dates = [...new Set(pm.text.match(/\d{4}-\d{2}-\d{2}/g) || [])].sort();
  return { pm, dates };
}

async function writeSkips(env, pm, dates) {
  const today = todayIso();
  const keep = [...new Set(dates)].filter((d) => d >= today).sort();
  if (!keep.length) {
    if (pm) {
      await api(env, 'unpinChatMessage', { chat_id: Number(env.CHAT_ID), message_id: pm.message_id });
      await api(env, 'deleteMessage', { chat_id: Number(env.CHAT_ID), message_id: pm.message_id });
    }
    return;
  }
  const text =
    `${SKIP_MARKER} ${keep.join(', ')} — o check-in automatico NAO sera ` +
    'enviado nessas datas (agendado via /pular; desfaca com /retomar)';
  if (pm) {
    await api(env, 'editMessageText', { chat_id: Number(env.CHAT_ID), message_id: pm.message_id, text });
  } else {
    const r = await send(env, text);
    if (r.ok) {
      await api(env, 'pinChatMessage', {
        chat_id: Number(env.CHAT_ID),
        message_id: r.result.message_id,
        disable_notification: true,
      });
    }
  }
}

// --- comandos -----------------------------------------------------------------

async function doPular(env, iso) {
  if (!iso) {
    await send(env, 'Nao entendi a data. Manda DD/MM (ex: 21/07), "hoje" ou "amanha".');
    return;
  }
  if (iso < todayIso()) {
    await send(env, `${fmt(iso)} ja passou — nada a cancelar.`);
    return;
  }
  if (weekday(iso) === 0 || weekday(iso) === 6) {
    await send(env, `${fmt(iso)} e fim de semana — o check-in nem roda nesse dia, nada a cancelar.`);
    return;
  }
  const { pm, dates } = await getSkips(env);
  if (dates.includes(iso)) {
    await send(env, `O check-in de ${fmt(iso)} ja estava cancelado.`);
    return;
  }
  await writeSkips(env, pm, [...dates, iso]);
  const [, m, d] = iso.split('-');
  await send(env, `🚫 Fechado! Vou pular o check-in de ${fmt(iso)}. Pra desfazer: /retomar ${d}/${m}`);
}

async function doRetomar(env, arg) {
  const { pm, dates } = await getSkips(env);
  if (!dates.length) {
    await send(env, 'Nao ha nenhum cancelamento agendado.');
    return;
  }
  let iso;
  if (arg) {
    iso = parseDate(arg);
    if (!iso) {
      await send(env, 'Nao entendi a data. Ex: /retomar 21/07');
      return;
    }
  } else if (dates.length === 1) {
    iso = dates[0];
  } else {
    await send(env, 'Ha mais de um cancelamento agendado: ' + dates.map(fmt).join(', ') + '. Especifique: /retomar DD/MM');
    return;
  }
  if (!dates.includes(iso)) {
    await send(env, `${fmt(iso)} nao estava cancelado. Agendados: ` + dates.map(fmt).join(', '));
    return;
  }
  await writeSkips(env, pm, dates.filter((d) => d !== iso));
  await send(env, `✅ Cancelamento desfeito — o check-in de ${fmt(iso)} volta a ser enviado normalmente.`);
}

async function doPulos(env) {
  const { pm, dates } = await getSkips(env);
  const future = dates.filter((d) => d >= todayIso());
  if (future.length !== dates.length) await writeSkips(env, pm, future); // limpeza oportunista
  if (!future.length) await send(env, 'Nenhum cancelamento agendado — check-ins seguem normais.');
  else await send(env, 'Check-ins cancelados: ' + future.map(fmt).join(', '));
}

function askDate(env) {
  return send(env, 'Pular o check-in de quando?', {
    inline_keyboard: [
      [
        { text: 'Hoje', callback_data: 'pular:hoje' },
        { text: 'Amanha', callback_data: 'pular:amanha' },
        { text: 'Outra data', callback_data: 'pular:outra' },
      ],
    ],
  });
}

// --- roteamento ----------------------------------------------------------------

async function handle(update, env) {
  const chatId = Number(env.CHAT_ID);

  if (update.callback_query) {
    const cq = update.callback_query;
    await api(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    if (cq.from.id !== chatId) return;
    if (cq.message) {
      await api(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id });
    }
    const [cmd, arg] = (cq.data || '').split(':');
    if (cmd === 'pular') {
      if (arg === 'outra') await send(env, ASK_TEXT, { force_reply: true });
      else await doPular(env, parseDate(arg));
    }
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat.id !== chatId || !msg.text) return;
  const text = msg.text.trim();
  const low = text.toLowerCase();

  if (low.startsWith('/pular')) {
    const arg = text.slice('/pular'.length).trim();
    if (arg) await doPular(env, parseDate(arg));
    else await askDate(env);
  } else if (low.startsWith('/retomar')) {
    await doRetomar(env, text.slice('/retomar'.length).trim());
  } else if (low.startsWith('/pulos')) {
    await doPulos(env);
  } else if (low.startsWith('/cancelar')) {
    await send(env, 'Ok, deixa pra la.');
  } else if (msg.reply_to_message?.text?.startsWith('Qual data?')) {
    await doPular(env, parseDate(text)); // resposta ao ForceReply de "Outra data"
  } else {
    await send(env, HELP);
  }
}
