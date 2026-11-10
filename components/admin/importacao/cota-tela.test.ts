import test from 'node:test';
import assert from 'node:assert/strict';
import { agirNaImportacao, ENDPOINT_DOCUMENTOS, enviarContrato, lerCota, textoCota } from './cliente-importacao.ts';

/** L2: linha da cota na revisão. A tela só exibe; a recusa é sempre do servidor. */

test('migração com saldo e janela iniciada: usados, extra e data dd/mm', () => {
  const c = lerCota({ plano: 'profissional', franquia: { periodo: '2026-11', usados: 0, limite: 10 }, migracao: { usados: 37, extra: 100, ate: '2026-11-30' } });
  assert.equal(textoCota(c!), 'Cota de migração: 37 de 100 leituras usadas, até 30/11.');
});

test('migração antes da primeira leitura com dados: sem data e com o evento certo', () => {
  const c = lerCota({ franquia: { periodo: '2026-11', usados: 0, limite: 30 }, migracao: { usados: 1, extra: 200, ate: null } });
  assert.equal(textoCota(c!), 'Cota de migração: 1 de 200 leituras usadas (30 dias a partir da primeira leitura com dados).');
});

test('extra esgotado ou janela fechada: franquia do mês ou da implantação', () => {
  assert.equal(textoCota(lerCota({ franquia: { periodo: '2026-11', usados: 3, limite: 10 }, migracao: { usados: 100, extra: 100, ate: '2026-11-30' } })!), 'Leituras do mês: 3 de 10.');
  assert.equal(textoCota(lerCota({ franquia: { periodo: '2026-12', usados: 0, limite: 30 }, migracao: null })!), 'Leituras do mês: 0 de 30.');
  assert.equal(textoCota(lerCota({ franquia: { periodo: 'IMPLANTACAO', usados: 4, limite: 5 }, migracao: null })!), 'Leituras da implantação: 4 de 5.');
});

test('sem plano confirmado (sem limite): nenhuma linha', () => {
  assert.equal(textoCota(lerCota({ plano: null, franquia: { periodo: '2026-11', usados: 12, limite: null }, migracao: null })!), null);
});

test('forma inválida vira null, sem quebrar a tela', () => {
  for (const d of [undefined, null, 1, {}, { franquia: { periodo: 1, usados: 0, limite: 5 } }, { franquia: { periodo: 'x', usados: -1, limite: 5 } },
    { franquia: { periodo: 'x', usados: 1.5, limite: 5 } }, { franquia: { periodo: 'x', usados: 0, limite: '5' } },
    { franquia: { periodo: 'x', usados: 0, limite: 5 }, migracao: { usados: 0, extra: 50, ate: '30/11' } },
    { franquia: { periodo: 'x', usados: 0, limite: 5 }, migracao: { usados: '0', extra: 50, ate: null } }]) {
    assert.equal(lerCota(d), null, JSON.stringify(d));
  }
});

const COTA = { franquia: { periodo: '2026-11', usados: 2, limite: 10 }, migracao: { usados: 2, extra: 100, ate: '2026-12-05' } };
const IMPORTACAO = { id: 'i', versao: 1, status: 'EM_REVISAO', extracao: { secoes: [] }, revisados: [] };

test('envio: a cota da resposta é a da abertura (depois da conclusão), nunca um campo do upload', async () => {
  const r = await enviarContrato(async (url) => Response.json({ ok: true, data: url === ENDPOINT_DOCUMENTOS
    ? { documentoId: 'd', avisos: ['X'], cota: { franquia: { periodo: 'velho', usados: 0, limite: 10 }, migracao: null } }
    : { importacao: IMPORTACAO, plano: null, cota: COTA } }), new File(['x'], 'a.pdf'));
  assert.ok(r.ok);
  assert.deepEqual(r.dados.cota, COTA);
  assert.deepEqual(r.dados.avisos, ['X']);
});

test('ler: a cota chega à tela pelo mesmo caminho do Revisar do lote', async () => {
  const r = await agirNaImportacao(async () => Response.json({ ok: true, data: { importacao: IMPORTACAO, plano: null, cota: COTA } }), { id: 'i', versao: 1 }, { acao: 'ler' });
  assert.ok(r.ok);
  assert.equal(textoCota(lerCota(r.dados.cota)!), 'Cota de migração: 2 de 100 leituras usadas, até 05/12.');
});
