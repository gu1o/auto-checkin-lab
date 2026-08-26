// Checagem do /pular (parser de datas + Mini App do calendario): node worker/test_pular.mjs
import assert from 'node:assert';
import { parseDates, todayIso, calBlocked, initDataChatId, pickerPage } from './worker.js';

const y = todayIso().slice(0, 4);
const iso = (d, m) => `${y}-${m}-${d}`;

// data unica (todos os formatos que o parseDate ja aceitava)
assert.deepStrictEqual(parseDates('26/08'), [iso('26', '08')]);
assert.deepStrictEqual(parseDates(`${y}-08-26`), [iso('26', '08')]);
assert.strictEqual(parseDates('hoje').length, 1);

// periodo, nas formas que um humano digita
for (const raw of ['26/08-28/08', '26/08 a 28/08', '26/08 ate 28/08', '26/08 até 28/08', '26/08..28/08']) {
  assert.deepStrictEqual(parseDates(raw), [iso('26', '08'), iso('27', '08'), iso('28', '08')], raw);
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
