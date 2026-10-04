import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmarRascunho } from './cliente-integracao.ts';
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const gate = { operacaoId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', versao: 1, payloadHash: 'a'.repeat(64), expiraEm: '2026-12-01T00:00:00Z', titulo: 'Importar', estado: 'AGUARDANDO_CONFIRMACAO', capacidade: 'importar_contrato', campos: [], avisos: [] };
test('um clique conclui pela decisão do Human Gate e navega ao Core', async () => {
  const chamadas: Array<{ url: string; corpo: Record<string, unknown> }> = [];
  const buscar = async (url: string, init: RequestInit) => {
    chamadas.push({ url, corpo: JSON.parse(init.body as string) });
    return Response.json(chamadas.length === 1 ? { ok: true, data: { gate: { tipo: 'preview', rascunho: gate } } } : { ok: true, data: { tipo: 'resultado_acao', rascunho: { ...gate, estado: 'EXECUTADA', versao: 2 }, mensagem: 'Concluído', destino: '/admin/contratos?contratoId=' + id } });
  };
  const r = await confirmarRascunho(buscar, id, 7, { financeiro: { situacao: 'NAO_CONFERIDO' } }, 'c'.repeat(64), 'd'.repeat(64));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(chamadas[0].url, '/api/admin/inteligencia/importacoes');
  assert.equal(chamadas[0].corpo.integracaoHash, 'c'.repeat(64));
  assert.equal(chamadas[0].corpo.planoHash, 'd'.repeat(64));
  assert.match(chamadas[1].url, /operacoes/);
  assert.equal(chamadas[1].corpo.decisao, 'confirmar');
  assert.equal(chamadas.length, 2);
});
test('preparação recusada nunca confirma outra operação', async () => {
  let chamadas = 0;
  const r = await confirmarRascunho(async () => { chamadas++; return Response.json({ ok: false, erro: 'A agenda mudou', codigo: 'RESUMO_DESATUALIZADO' }, { status: 409 }); }, id, 7, {}, 'c'.repeat(64), 'd'.repeat(64));
  assert.equal(r.ok, false); assert.equal(chamadas, 1);
});
