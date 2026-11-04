import test from 'node:test';
import assert from 'node:assert/strict';
import { codificarCursor, itemParaRevisao, lerCursor, OCULTO, sanitizarTexto } from './lista-revisao.ts';

const DOC = '11111111-1111-4111-8111-111111111111';
const IMP = '22222222-2222-4222-8222-222222222222';
const linha = (o: Record<string, unknown> = {}) => ({ grupo: 'REVISAO' as const, documentoId: DOC, importacaoId: IMP, versao: 3, arquivo: 'contrato.pdf', enviadoEm: '2026-11-03T12:00:00.123456Z', contratante: 'Ana Souza', dataFesta: '2026-12-05', ...o });

test('R1-4 sanitização: CPF, CNPJ, telefone e e-mail viram •••; números curtos ficam; corte em 80', () => {
  assert.equal(sanitizarTexto('Contrato 123.456.789-09 Ana.pdf'), `Contrato ${OCULTO} Ana.pdf`);
  assert.equal(sanitizarTexto('12.345.678/0001-90'), OCULTO);
  assert.equal(sanitizarTexto('(11) 98765-4321 festa'), `(${OCULTO} festa`, 'o parêntese de abertura fica; nenhum dígito sai');
  assert.equal(sanitizarTexto('+55 11 98765 4321'), '+' + OCULTO, 'o + inicial fica; nenhum dígito sai');
  assert.equal(sanitizarTexto('12345678'), OCULTO, 'exatamente 8 dígitos');
  assert.equal(sanitizarTexto('1234567 dígitos'), '1234567 dígitos', '7 dígitos ficam');
  assert.equal(sanitizarTexto('festa 05/12/2026 sala 3'), `festa ${OCULTO} sala 3`, 'data com 8 dígitos também é ocultada (falso positivo aceito)');
  assert.equal(sanitizarTexto('ana.souza+festa@exemplo.com.br contrato'), `${OCULTO} contrato`);
  assert.equal(sanitizarTexto('  a \n\t b  '), 'a b');
  assert.equal(sanitizarTexto('   '), null);
  assert.equal(sanitizarTexto(null), null);
  const longo = sanitizarTexto('x'.repeat(200))!;
  assert.equal(longo.length, 80);
  assert.ok(longo.endsWith('…'));
  assert.equal(sanitizarTexto('y'.repeat(80)), 'y'.repeat(80));
});

test('R1-4 DTO fechado: só as 8 chaves; LIDO sem importação/versão; data inválida vira null', () => {
  const r = itemParaRevisao({ ...linha(), dados: { cpf: '123' }, resultado: 'x', evidencias: [] } as never);
  assert.deepEqual(Object.keys(r).sort(), ['arquivo', 'contratante', 'dataFesta', 'documentoId', 'enviadoEm', 'grupo', 'importacaoId', 'versao']);
  const l = itemParaRevisao(linha({ grupo: 'LIDO', importacaoId: IMP, versao: 9 }));
  assert.deepEqual([l.importacaoId, l.versao], [null, null]);
  for (const d of ['2026-02-30', '2026-13-01', '05/12/2026', '2026-12-5', '', null]) assert.equal(itemParaRevisao(linha({ dataFesta: d })).dataFesta, null, String(d));
  assert.equal(itemParaRevisao(linha({ dataFesta: '2028-02-29' })).dataFesta, '2028-02-29');
  assert.equal(itemParaRevisao(linha({ arquivo: '' })).arquivo, 'arquivo');
  assert.equal(itemParaRevisao(linha({ contratante: 'Ana 987.654.321-00' })).contratante, `Ana ${OCULTO}`);
});

test('cursor: ida e volta; adulterado, com chave extra ou fora do formato ⇒ null', () => {
  const c = { k: '2026-12-05', t: '2026-11-03T12:00:00.123456Z', id: DOC };
  assert.deepEqual(lerCursor(codificarCursor(c)!), c);
  assert.deepEqual(lerCursor(codificarCursor({ ...c, k: '~' })!), { ...c, k: '~' });
  assert.equal(codificarCursor(null), null);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  for (const ruim of [
    b64({ ...c, empresaId: DOC }), b64({ ...c, k: "2026-12-05' OR 1=1" }), b64({ ...c, t: '2026-11-03T12:00:00Z' }), b64({ ...c, id: 'x' }),
    b64({ k: c.k, t: c.t }), b64([c]), 'não-base64!!', Buffer.from('{').toString('base64url'), '',
  ]) assert.equal(lerCursor(ruim), null, ruim);
});
