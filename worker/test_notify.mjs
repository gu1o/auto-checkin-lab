// Checagem do destino de e-mail do /notify: node worker/test_notify.mjs
import assert from 'node:assert';
import { emailAllowed } from './worker.js';

const DOMAINS = 'solucoesindustriais.com.br, IdealTrends.io';

// dominio da lista passa, com espaco e caixa diferentes
assert.ok(emailAllowed('dev@solucoesindustriais.com.br', DOMAINS));
assert.ok(emailAllowed('  Dev@IDEALTRENDS.IO ', DOMAINS), 'caixa/espaco nao podem barrar');

// dominio de fora nao passa — o NOTIFY_SECRET e compartilhado no time e nao
// pode virar relay aberto na conta Resend
assert.ok(!emailAllowed('alguem@gmail.com', DOMAINS));
assert.ok(!emailAllowed('dev@sub.solucoesindustriais.com.br', DOMAINS), 'subdominio nao e o dominio');
assert.ok(!emailAllowed('dev@solucoesindustriais.com.br.evil.com', DOMAINS), 'sufixo nao conta como match');

// sem lista configurada, nada passa (fail-closed)
assert.ok(!emailAllowed('dev@solucoesindustriais.com.br', ''));
assert.ok(!emailAllowed('dev@solucoesindustriais.com.br', undefined));

// entrada invalida
assert.ok(!emailAllowed('', DOMAINS));
assert.ok(!emailAllowed('sem-arroba', DOMAINS));
assert.ok(!emailAllowed('dev@localhost', DOMAINS), 'dominio sem ponto nao e endereco valido aqui');

console.log('ok');

// --- watchdog (dead-man's switch do modo nuvem) ------------------------------
const { watchKey, watchTtl, watchdogCron, WATCH_TTL_DAYS } = await import('./worker.js');

assert.equal(watchKey('  Dev@Empresa.COM '), 'watch:dev@empresa.com');

// TTL conta do ultimo sinal de vida: cobrar todo dia nao pode renovar a validade
assert.equal(watchTtl('2026-08-27', '2026-08-27'), WATCH_TTL_DAYS * 86400);
assert.equal(watchTtl('2026-08-20', '2026-08-27'), (WATCH_TTL_DAYS - 7) * 86400);
assert.equal(watchTtl('2026-01-01', '2026-08-27'), 3600, 'registro vencido nao pode dar TTL negativo');

function fakeEnv(entries) {
  const kv = new Map(entries);
  return {
    RESEND_API_KEY: 'x',
    NOTIFY_EMAIL_FROM: 'a@b.c',
    USERS: {
      get: async (k) => kv.get(k) ?? null,
      put: async (k, v) => void kv.set(k, v),
      list: async ({ prefix }) => ({
        keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
    },
    _kv: kv,
  };
}

let sent = [];
globalThis.fetch = async (_url, opts) => {
  sent.push(JSON.parse(opts.body));
  return { ok: true, status: 200, text: async () => '' };
};

const HOJE = '2026-08-27';
const silencioso = () => fakeEnv([['watch:dev@x.com', JSON.stringify({ email: 'dev@x.com', last: '2026-08-26' })]]);

// antes do horario nao cobra: quem roda de tarde ainda nao rodou
let env = silencioso();
await watchdogCron(env, 10, HOJE);
assert.equal(sent.length, 0, 'cobranca antes do WATCHDOG_HOUR e falso alarme');

// no fim do dia, sem sinal de vida hoje -> cobra e marca
sent = [];
await watchdogCron(env, 18, HOJE);
assert.equal(sent.length, 1, 'rotina muda tem que virar e-mail');
assert.match(sent[0].text, /nao deu sinal de vida hoje/);
const marcado = JSON.parse(env._kv.get('watch:dev@x.com'));
assert.equal(marcado.alerted, HOJE);
assert.equal(marcado.last, '2026-08-26', 'cobrar nao pode virar sinal de vida');

// mesmo dia, outro tick: um e-mail por dia, nao um a cada 15 min
sent = [];
await watchdogCron(env, 18, HOJE);
assert.equal(sent.length, 0);

// pingou hoje -> silencio
sent = [];
env = fakeEnv([['watch:dev@x.com', JSON.stringify({ email: 'dev@x.com', last: HOJE })]]);
await watchdogCron(env, 18, HOJE);
assert.equal(sent.length, 0);

// e-mail que nao saiu nao pode ser marcado como cobrado
sent = [];
globalThis.fetch = async () => ({ ok: false, status: 422, text: async () => 'nope' });
env = silencioso();
await watchdogCron(env, 18, HOJE);
assert.equal(JSON.parse(env._kv.get('watch:dev@x.com')).alerted, undefined, 'falha na entrega tem que tentar de novo');

console.log('ok watchdog');

// --- deliver(): quem escolheu e-mail nao pode receber pelo Telegram ----------
const { deliver } = await import('./worker.js');

function canais() {
  const hits = [];
  globalThis.fetch = async (url, opts) => {
    const via = String(url).includes('resend') ? 'email' : 'telegram';
    hits.push({ via, body: opts.body });
    return { ok: true, status: 200, text: async () => '', json: async () => ({ ok: true }) };
  };
  return hits;
}

const comEmail = fakeEnv([['user:7', JSON.stringify({ status: 'active', prefs: { email: 'dev@x.com' } })]]);
comEmail.BOT_TOKEN = 't';
let hits = canais();
let r = await deliver(comEmail, 7, '❌ falhou');
assert.deepEqual(hits.map((h) => h.via), ['email'], 'prefs.email manda no canal — era o furo do runnerCron');
assert.ok(r.delivered && r.email === 'dev@x.com');
assert.ok(comEmail._kv.get('watch:dev@x.com'), 'notificacao entregue arma o watchdog');

const semEmail = fakeEnv([['user:8', JSON.stringify({ status: 'active', prefs: {} })]]);
semEmail.BOT_TOKEN = 't';
hits = canais();
await deliver(semEmail, 8, '❌ falhou');
assert.deepEqual(hits.map((h) => h.via), ['telegram'], 'sem e-mail, Telegram como sempre');

// e-mail recusado nao pode sumir com o aviso: cai para o Telegram
const so500 = fakeEnv([['user:9', JSON.stringify({ status: 'active', prefs: { email: 'dev@x.com' } })]]);
so500.BOT_TOKEN = 't';
hits = [];
globalThis.fetch = async (url, opts) => {
  const via = String(url).includes('resend') ? 'email' : 'telegram';
  hits.push({ via });
  return via === 'email'
    ? { ok: false, status: 500, text: async () => 'erro' }
    : { ok: true, json: async () => ({ ok: true }) };
};
assert.ok((await deliver(so500, 9, '❌ falhou')).delivered);
assert.deepEqual(hits.map((h) => h.via), ['email', 'telegram']);
assert.ok(!so500._kv.get('watch:dev@x.com'), 'e-mail que nao saiu nao e sinal de vida');

console.log('ok deliver');
