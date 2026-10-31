import assert from 'node:assert/strict';
import test from 'node:test';
import { sugerirDatasVagas } from './sugestoes.ts';

// E2b (D-E2b-5): a sugestão de datas vagas acompanha a disponibilidade pública — com combinadosPublicos, o horário que só
// o combinado atende é vaga; desligado, a chamada é a de antes (sem a opção).
async function chamadas(combinados: boolean) {
  const opcoes: unknown[][] = [];
  const r = await sugerirDatasVagas({} as never, 'empresa', null, '2026-11-01', 7, {
    escopoDaEmpresa: (async () => ({ empresaId: 'empresa', estabelecimentoId: null })) as never,
    consultarDisponibilidadePeriodo: (async (...args: unknown[]) => {
      opcoes.push(args.slice(5));
      return [{ data: '2026-11-07', periodos: [{ horarios: [{ status: 'DISPONIVEL' }] }] }];
    }) as never,
    combinadosPublicos: async () => combinados,
  });
  return { r, opcoes };
}

test('Marketing: com combinadosPublicos a agenda é lida com incluirCombinados; desligado, sem a opção', async () => {
  const ligado = await chamadas(true);
  assert.deepEqual(ligado.opcoes, [[{ incluirCombinados: true }]]);
  assert.deepEqual(ligado.r.datas.map((d) => d.data), ['2026-11-07']);
  const desligado = await chamadas(false);
  assert.deepEqual(desligado.opcoes, [[]], 'a chamada da E2a, com 5 argumentos');
});
