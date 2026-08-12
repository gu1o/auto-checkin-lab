// Checagem do fluxo de rascunho/aprovacao do worker: node worker/test_draft.mjs
import assert from 'node:assert';
import { genPrompt, draftText, putDraft, getDraft, todayIso, parseDataPage, labIsSubmitted, submitFailureDetail } from './worker.js';

// estilo do dev entra no prompt e some quando nao ha
const style = 'Ontem: "Fechei o ajuste de permissao." Hoje: "Termino o import."';
assert.ok(genPrompt({ a: 1 }, style).includes(style), 'estilo deve ir para o prompt');
assert.ok(!genPrompt({ a: 1 }, '').includes('Estilo do dev'), 'sem estilo, sem bloco de estilo');

// rascunho renderiza uma secao por iniciativa, com o header pedido
const checkins = [
  { initiative: 6, yesterday: 'fiz A', today: 'faco B' },
  { initiative: 9, yesterday: 'fiz C', today: 'faco D' },
];
const txt = draftText(checkins, ['aviso'], 'HEADER');
assert.ok(txt.startsWith('HEADER'));
assert.ok(txt.includes('⚠️ aviso'));
assert.ok(txt.includes('=== Iniciativa 6 ===') && txt.includes('=== Iniciativa 9 ==='));
assert.ok(txt.includes('fiz A') && txt.includes('faco D'));

// KV: rascunho de hoje volta; o de outro dia e descartado (check-in e do dia)
const kv = new Map();
const env = { USERS: { put: async (k, v) => void kv.set(k, v), get: async (k) => kv.get(k) ?? null } };
await putDraft(env, 42, { date: todayIso(), checkins });
assert.equal((await getDraft(env, 42)).checkins.length, 2);
await putDraft(env, 42, { date: '2000-01-01', checkins });
assert.equal(await getDraft(env, 42), null, 'rascunho de outro dia nao pode ser enviado');
assert.equal(await getDraft(env, 99), null, 'sem rascunho -> null');

// confirmacao pos-POST: so o card com `existing` prova que gravou (302 do Inertia
// tambem e a resposta de validacao reprovada — campo obrigatorio novo no form)
const page = parseDataPage(
  '<div id="app" data-page="{&quot;props&quot;:{&quot;cards&quot;:[{&quot;initiativeId&quot;:6,&quot;existing&quot;:{&quot;submittedAt&quot;:&quot;09:30&quot;}},{&quot;initiativeId&quot;:9,&quot;existing&quot;:null}]}}"></div>'
);
assert.ok(labIsSubmitted(page, 6), 'card com existing = gravado');
assert.ok(!labIsSubmitted(page, 9), 'card sem existing = NAO gravado (302 nao prova nada)');
assert.equal(parseDataPage('<html>sem data-page</html>'), null);

// campo novo obrigatorio: o nome sai de props.errors (flash do Inertia lido no
// GET de confirmacao) e o que nao esta no payload e destacado como campo novo
const payload = { initiative_id: 6, checkin_date: '2026-08-12', today_text: 'b' };
const reproved = { props: { cards: [{ initiativeId: 6, existing: null }], errors: { mood_score: 'O campo mood score e obrigatorio.', today_text: ['Maximo 500 caracteres.'] } } };
const detail = submitFailureDetail(reproved, payload, 302);
assert.ok(detail.includes('mood_score (O campo mood score e obrigatorio.)'), 'cita campo e mensagem');
assert.ok(/campos? novos?.*mood_score/.test(detail), 'mood_score e campo novo (fora do payload)');
assert.ok(!/novos?.*today_text/.test(detail), 'today_text esta no payload, nao e campo novo');
// bag nomeado (props.errors.default) e caso sem erros nenhum
assert.ok(submitFailureDetail({ props: { errors: { default: { mood_score: 'obrigatorio' } } } }, payload, 302).includes('mood_score'));
assert.ok(submitFailureDetail({ props: { cards: [] } }, payload, 302).includes('campo obrigatorio novo'));

console.log('ok');
