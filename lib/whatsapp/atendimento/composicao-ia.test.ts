import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';

/**
 * Proteções finais nas composition roots REAIS da IA (sem banco nem rede; '@/…' resolvido pelos hooks da avaliação):
 *  - modo regras com ORÇAMENTO VÁLIDO: nenhuma porta de modelo é montada (nem Wall-e nem fase B);
 *  - recepção: o estado da chave global da IA chega ao Core pela composition root da IA; o webhook sempre o informa.
 */
register('../../../scripts/walle-avaliacao/alias-hooks.mjs', import.meta.url);
globalThis.fetch = async () => { throw new Error('rede proibida no teste'); };
const raiz = (rel: string) => new URL(`../../../${rel}`, import.meta.url).href;
const ORCAMENTO_VALIDO = JSON.stringify({ porEmpresa: { tokensDiario: 1_000_000 }, porCapacidade: { whatsapp_atendimento: { tokensDiario: 100_000 } } });

test('modo regras com orçamento válido: a composition root não monta modelo para o Wall-e nem para a fase B', async () => {
  const modelo = await import(raiz('app/api/admin/inteligencia/whatsapp/modelo.ts')) as typeof import('../../../app/api/admin/inteligencia/whatsapp/modelo.ts');
  const { orcamentoDoAmbiente, planejarReserva } = await import(raiz('lib/inteligencia/modelos/orcamento.ts')) as typeof import('../../inteligencia/modelos/orcamento.ts');
  const env = { AI_BUDGET_JSON: ORCAMENTO_VALIDO, INTELIGENCIA_ENABLED: 'true' } as NodeJS.ProcessEnv;
  const orcamento = orcamentoDoAmbiente(env);
  assert.ok(typeof orcamento !== 'string', 'orçamento válido');
  assert.equal(planejarReserva(orcamento as never, { capacidade: 'whatsapp_atendimento', hoje: '2026-10-09', moedaPreco: null, precoConhecido: true }).tipo, 'RESERVAR', 'o orçamento permitiria chamar o modelo');
  assert.deepEqual(modelo.portasDeModeloAtendimento({ ...env, WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO: 'regras' }), { interpretar: null, entender: null }, 'regras: nenhuma porta de modelo');
  const comModelo = modelo.portasDeModeloAtendimento(env);
  assert.equal(typeof comModelo.interpretar, 'function'); assert.equal(typeof comModelo.entender, 'function');
});

test('recepção: a chave global chega pela composition root da IA; o webhook sempre informa; o Core não lê a chave', async () => {
  const { opcoesRecepcaoAtendimento } = await import(raiz('app/api/admin/inteligencia/whatsapp/automacao.ts')) as typeof import('../../../app/api/admin/inteligencia/whatsapp/automacao.ts');
  assert.deepEqual(opcoesRecepcaoAtendimento({ INTELIGENCIA_ENABLED: 'true' } as never), { automacaoGlobal: true });
  assert.deepEqual(opcoesRecepcaoAtendimento({} as never), { automacaoGlobal: false }, 'ausente = desligada (fail-closed)');
  assert.deepEqual(opcoesRecepcaoAtendimento({ INTELIGENCIA_ENABLED: 'false' } as never), { automacaoGlobal: false });
  const webhook = readFileSync('app/api/integracoes/gupshup/webhook/route.ts', 'utf8');
  assert.match(webhook, /await receberEntrada\(entrada, opcoesRecepcaoAtendimento\(\)\)/);
  assert.doesNotMatch(webhook, /receberEntrada\(entrada\)/);
  for (const arquivo of ['lib/whatsapp/atendimento/service.ts', 'lib/whatsapp/atendimento/worker.ts', 'app/api/integracoes/gupshup/webhook/route.ts'])
    assert.doesNotMatch(readFileSync(arquivo, 'utf8'), /INTELIGENCIA_ENABLED|lib\/inteligencia/, arquivo);
});
