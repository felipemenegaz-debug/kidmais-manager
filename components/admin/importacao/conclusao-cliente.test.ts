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

/**
 * S-E restante (P2-5, CA-4): matriz da confirmação final do Gate. Só uma resposta 4xx com código de domínio conhecido é
 * recusa comprovada que a tela re-simula; outra 4xx é CONFIRMACAO_RECUSADA; sem resultado confiável é RESULTADO_INCERTO.
 */
function gateCom(final: () => Promise<Response>) {
  const chamadas: string[] = [];
  const buscar = async (url: string) => {
    chamadas.push(url);
    return chamadas.length === 1 ? Response.json({ ok: true, data: { gate: { tipo: 'preview', rascunho: gate } } }) : final();
  };
  return { buscar, chamadas };
}
const confirmarCom = (buscar: (url: string, init: RequestInit) => Promise<Response>) => confirmarRascunho(buscar, id, 7, {}, 'c'.repeat(64), 'd'.repeat(64));

test('antes do Gate: a verificação recusa com INTEGRACAO_BLOQUEADA e o código chega à tela; nada é confirmado', async () => {
  let chamadas = 0;
  const r = await confirmarCom(async () => { chamadas++; return Response.json({ ok: false, erro: 'Escolha o salão da festa.', codigo: 'INTEGRACAO_BLOQUEADA' }, { status: 409 }); });
  assert.deepEqual([r.ok, !r.ok && r.codigo, chamadas], [false, 'INTEGRACAO_BLOQUEADA', 1]);
});

test('corrida na confirmação final: SALAO_INDISPONIVEL (409) chega como recusa comprovada do domínio', async () => {
  for (const codigo of ['SALAO_INDISPONIVEL', 'RESUMO_DESATUALIZADO', 'CONFLITO_AGENDA', 'INTEGRACAO_BLOQUEADA']) {
    const { buscar, chamadas } = gateCom(async () => Response.json({ ok: false, erro: 'O salão escolhido não está mais disponível.', codigo }, { status: 409 }));
    const r = await confirmarCom(buscar);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.codigo, codigo);
    assert.equal(r.mensagem, 'O salão escolhido não está mais disponível.');
    assert.equal(chamadas.length, 2);
  }
});

test('outra recusa comprovada (4xx com outro código, ou IA desativada) => CONFIRMACAO_RECUSADA', async () => {
  for (const resposta of [
    () => Response.json({ ok: false, erro: 'Sessão divergente.', codigo: 'OPERACAO_NAO_AUTORIZADA' }, { status: 403 }),
    () => Response.json({ ok: false, erro: 'Desativada.', codigo: 'INTELIGENCIA_DESATIVADA' }, { status: 503 }),
  ]) {
    const r = await confirmarCom(gateCom(async () => resposta()).buscar);
    assert.equal(!r.ok && r.codigo, 'CONFIRMACAO_RECUSADA');
  }
});

test('resultado incerto (rede, JSON inválido, código nulo, 5xx ou código de domínio sem status 4xx) => RESULTADO_INCERTO', async () => {
  for (const [nome, final] of [
    ['fetch rejeitado', async () => { throw new TypeError('rede'); }],
    ['JSON inválido', async () => new Response('<html>erro</html>', { status: 502 })],
    ['código nulo', async () => Response.json({ ok: false, erro: 'Falhou.' }, { status: 409 })],
    ['5xx com código de domínio', async () => Response.json({ ok: false, erro: 'Falhou.', codigo: 'SALAO_INDISPONIVEL' }, { status: 500 })],
    ['2xx sem ok', async () => Response.json({ ok: false, erro: 'Falhou.', codigo: 'SALAO_INDISPONIVEL' }, { status: 200 })],
  ] as const) {
    const r = await confirmarCom(gateCom(final as () => Promise<Response>).buscar);
    assert.equal(!r.ok && r.codigo, 'RESULTADO_INCERTO', nome);
    assert.match(!r.ok ? r.mensagem : '', /Confira o contrato na lista de Contratos antes de tentar de novo/, nome);
  }
});
