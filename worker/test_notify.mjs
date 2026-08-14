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
