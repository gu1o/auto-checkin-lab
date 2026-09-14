// Checagem do /pular (parser de datas + Mini App do calendario): node worker/test_pular.mjs
import assert from 'node:assert';
import { parseDates, todayIso, calBlocked, initDataChatId, pickerPage } from './worker.js';

// Datas relativas a hoje: DD/MM sem ano que ja passou rola para o ano seguinte
// (comportamento correto do parser), entao data fixa no teste apodrece sozinha.
const mais = (n) => {
  const d = new Date(todayIso() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
// Janela de 3 dias a frente, inteira dentro do mesmo ano: cruzando 31/12 as
// duas pontas rolariam para anos diferentes e o periodo viraria invalido.
let n = 3;
while (mais(n).slice(0, 4) !== mais(n + 2).slice(0, 4)) n++;
const [d1, d2, d3] = [mais(n), mais(n + 1), mais(n + 2)];

// data unica (todos os formatos que o parseDate ja aceitava)
assert.deepStrictEqual(parseDates(dm(d1)), [d1]);
assert.deepStrictEqual(parseDates(d1), [d1]);
assert.strictEqual(parseDates('hoje').length, 1);

// periodo, nas formas que um humano digita (DD/MM: em ISO o proprio `-` da data
// seria lido como separador do periodo)
for (const sep of ['-', ' a ', ' ate ', ' até ', '..']) {
  assert.deepStrictEqual(parseDates(`${dm(d1)}${sep}${dm(d3)}`), [d1, d2, d3], sep);
}

// lixo e periodos invertidos/absurdos nao viram data
for (const raw of ['ontem', '32/08', '28/08-26/08', '01/01-31/12', '']) {
  assert.deepStrictEqual(parseDates(raw), [], raw);
}

// --- dias sem check-in para pular -------------------------------------------

const hoje = todayIso();
const wd = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();
assert.match(calBlocked('2020-01-02'), /passou/);
for (let i = 0; i < 14; i++) {
  const d = new Date(hoje + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + i);
  const iso = d.toISOString().slice(0, 10);
  const esperado = wd(iso) === 0 || wd(iso) === 6 ? /fim de semana/ : /^$/;
  assert.match(calBlocked(iso), esperado, iso);
}


// --- Mini App do /pular -----------------------------------------------------

// A pagina e uma template string dentro do worker: um `${` que sobrou vira
// JS quebrado no celular, onde ninguem ve o erro.
const pular = await pickerPage(false).text();
const retomar = await pickerPage(true).text();

for (const [nome, page] of [['pular', pular], ['retomar', retomar]]) {
  assert.ok(!page.includes('${'), `interpolacao nao resolvida (${nome})`);
  assert.ok(page.includes('air-datepicker@3.6.0/air-datepicker.js'), 'lib do datepicker');
  assert.ok(page.includes('telegram-web-app.js'), 'SDK do Mini App');
  assert.ok(page.includes('multipleDates:true'), 'selecao dia a dia');
  assert.ok(page.includes('firstDay:0'), 'semana comecando no domingo');
  assert.ok(page.includes('class="legenda"'), 'legenda no quadro');
  // as duas cores que a legenda promete
  assert.ok(page.includes('.agendado{background:var(--cor-agendado)'), 'laranja para o agendado');
  assert.ok(page.includes('.agendado.-selected-{background:var(--tg-theme-button-color'), 'tema para o escolhido');
}

// cada modo abre com nada marcado (nenhum selectedDates) e anda para um lado so
for (const page of [pular, retomar]) assert.ok(!/selectedDates\s*:/.test(page), 'abre sem nada marcado');
assert.ok(pular.includes("MODO = 'pular'") && pular.includes('Confirmar ('), 'modo pular');
assert.ok(pular.includes('Ja agendado') && !pular.includes('Volta a rodar'), 'no /pular nao se retoma');
assert.ok(retomar.includes("MODO = 'retomar'") && retomar.includes('Retomar ('), 'modo retomar');
assert.ok(retomar.includes('Volta a rodar'), 'legenda do retomar');

// initData: sem a validacao do HMAC a rota /picker seria um /pular aberto.
const BOT = '123456:FAKE-TOKEN';
const enc = new TextEncoder();
const hmac = async (key, msg) =>
  new Uint8Array(await crypto.subtle.sign('HMAC',
    await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    enc.encode(msg)));

async function initData(fields) {
  const p = new URLSearchParams(fields);
  const check = [...p].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const sig = await hmac(await hmac(enc.encode('WebAppData'), BOT), check);
  p.set('hash', [...sig].map((b) => b.toString(16).padStart(2, '0')).join(''));
  return p.toString();
}

const env = { BOT_TOKEN: BOT };
const agora = Math.floor(Date.now() / 1000);
const bom = await initData({ auth_date: String(agora), user: JSON.stringify({ id: 140674932 }), query_id: 'AA' });

assert.strictEqual(await initDataChatId(env, bom), 140674932, 'initData valido devolve o chat_id');
assert.strictEqual(await initDataChatId(env, ''), null, 'vazio');
assert.strictEqual(await initDataChatId(env, bom.replace(/hash=./, 'hash=0')), null, 'hash adulterado');
// campo trocado com o hash original: o data_check_string muda, a assinatura nao fecha
assert.strictEqual(await initDataChatId(env, bom.replace('140674932', '999')), null, 'user trocado');
assert.strictEqual(await initDataChatId({ BOT_TOKEN: 'outro' }, bom), null, 'assinado por outro bot');
assert.strictEqual(
  await initDataChatId(env, await initData({ auth_date: String(agora - 90000), user: JSON.stringify({ id: 1 }) })),
  null, 'initData velho (> 24h)');

console.log('ok');

// --- /skips: pular dias sem Telegram (KV skips:<email>) ----------------------
const { handleSkips, skipsKey, readEmailSkips, writeEmailSkips } = await import('./worker.js');

assert.strictEqual(skipsKey('  Dev@Empresa.COM '), 'skips:dev@empresa.com', 'chave normalizada');

function kvEnv() {
  const kv = new Map();
  return {
    NOTIFY_SECRET: 's3cr3t',
    NOTIFY_EMAIL_DOMAINS: 'empresa.com',
    USERS: {
      get: async (k) => kv.get(k) ?? null,
      put: async (k, v) => void kv.set(k, v),
      delete: async (k) => void kv.delete(k),
    },
    _kv: kv,
  };
}

// dia util no futuro (o worker descarta passado e fim de semana)
const proxUtil = (n) => {
  let d = new Date(todayIso() + 'T12:00:00Z');
  while (n > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n--;
  }
  return d.toISOString().slice(0, 10);
};
const sabado = () => {
  let d = new Date(todayIso() + 'T12:00:00Z');
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== 6);
  return d.toISOString().slice(0, 10);
};
const util1 = proxUtil(1);
const util2 = proxUtil(2);

const call = (senv, method, path, body, secret = 's3cr3t') =>
  handleSkips(
    new Request(`https://w.dev${path}`, {
      method,
      headers: secret === null ? {} : { 'x-notify-secret': secret },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    new URL(`https://w.dev${path}`),
    senv,
  );

// auth: o segredo e compartilhado no time, o dominio e o que impede um dev de
// pular o dia do outro
let senv = kvEnv();
assert.strictEqual((await call(senv, 'GET', `/skips?email=dev@empresa.com`, undefined, null)).status, 403, 'sem header');
assert.strictEqual((await call(senv, 'GET', `/skips?email=dev@empresa.com`, undefined, 'errado')).status, 403);
assert.strictEqual((await call(senv, 'GET', '/skips')).status, 403, 'sem email');
assert.strictEqual((await call(senv, 'GET', '/skips?email=dev@gmail.com')).status, 403, 'dominio de fora');
assert.strictEqual((await call({ ...senv, NOTIFY_SECRET: '' }, 'GET', '/skips?email=dev@empresa.com')).status, 403,
  'worker sem NOTIFY_SECRET e fail-closed');
assert.strictEqual((await call(senv, 'DELETE', '/skips?email=dev@empresa.com')).status, 405);

// vazio antes de qualquer escrita
assert.deepStrictEqual((await (await call(senv, 'GET', '/skips?email=dev@empresa.com')).json()).dates, []);

// POST: a lista E o estado final; passado e fim de semana caem fora e o retorno
// mostra o que de fato ficou valendo
let r = await (await call(senv, 'POST', '/skips', {
  email: 'Dev@Empresa.com',
  dates: [util2, util1, util1, sabado(), '2020-01-02', 'nao-e-data', '2026-02-30'],
})).json();
assert.deepStrictEqual(r.dates, [util1, util2], 'ordenado, sem repetido, sem fim de semana/passado/lixo');
assert.deepStrictEqual(await readEmailSkips(senv, 'dev@empresa.com'), [util1, util2]);
assert.ok(senv._kv.get('skips:dev@empresa.com'), 'gravou na chave normalizada');

// GET devolve o mesmo estado, e a selecao substitui (nao soma)
assert.deepStrictEqual((await (await call(senv, 'GET', '/skips?email=dev@empresa.com')).json()).dates, [util1, util2]);
r = await (await call(senv, 'POST', '/skips', { email: 'dev@empresa.com', dates: [util2] })).json();
assert.deepStrictEqual(r.dates, [util2], 'a lista enviada e o estado final');

// lista vazia = retomar tudo: a chave sai do KV em vez de virar lixo eterno
assert.deepStrictEqual(await writeEmailSkips(senv, 'dev@empresa.com', []), []);
assert.strictEqual(senv._kv.has('skips:dev@empresa.com'), false);

// KV corrompido nao pode derrubar a guarda da rotina
senv._kv.set('skips:dev@empresa.com', '{ nao e json');
assert.deepStrictEqual(await readEmailSkips(senv, 'dev@empresa.com'), []);
senv._kv.set('skips:dev@empresa.com', JSON.stringify(['2020-01-02', util1]));
assert.deepStrictEqual(await readEmailSkips(senv, 'dev@empresa.com'), [util1], 'passado nao volta na leitura');

console.log('ok skips');
