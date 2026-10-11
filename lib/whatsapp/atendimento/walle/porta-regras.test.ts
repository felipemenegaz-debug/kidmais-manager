import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carregarComponente } from '../../../../components/admin/teste-componente.ts';

/**
 * Proteção final: em modo regras (WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO=regras) a porta do Wall-e NUNCA chama o modelo,
 * mesmo que tenha sido montada com ele (a composition root não monta; esta é a segunda barreira, conferida a cada uso).
 * Sem banco nem rede: catálogos, fontes e resolvedor são dublês que só registram de onde veio o entendimento.
 */
function carregarPorta(regras: () => boolean) {
  const registro: { origem: string[] } = { origem: [] };
  const modulo = carregarComponente('lib/whatsapp/atendimento/walle/porta.ts', {
    '../../../db/postgres.ts': { db: () => ({ query: async () => { throw new Error('banco proibido no teste'); } }) },
    '../../../clientes/repositories/cliente.repository': { buscarClientesPorContatoExato: async () => [] },
    '../../../fechamentos/contratacoes.ts': { listarContratacoes: async () => [] },
    '../core.ts': { ocultarDadosPessoais: (t: string) => t, dadoDeSaude: (t: string) => /alergia/.test(t) },
    '../configuracao.ts': { entendimentoSoRegras: regras },
    '../prontas-link.ts': { resolverLinkFechamento: async () => ({ ok: false }) },
    './contexto.ts': { lerContexto: (c: unknown) => (c ?? {}) },
    './entendimento.ts': {
      ESQUEMA_JSON_MODELO: {}, esquemaModelo: { parse: (v: unknown) => v },
      entenderPorRegras: () => ({ origem: 'regras', sinais: {} }),
      revalidarEntendimento: () => ({ origem: 'modelo', sinais: {} }),
      juntarSinais: (a: unknown) => a,
    },
    './fontes-postgres.ts': { catalogosWallE: async () => ({}), fontesPostgres: () => ({}) },
    './link-disponibilidade.ts': { ambienteDoLink: () => 'staging', linkDisponibilidadePublica: () => ({ ok: false }) },
    './resolver.ts': { resolverWallE: async (e: { entendimento: { origem: string } }) => { registro.origem.push(e.entendimento.origem); return { saidas: [], contexto: {}, passagem: null }; } },
  }).modulo as typeof import('./porta.ts');
  return { modulo, registro };
}
const entrada = { empresa: 'e', ambiente: 'staging', contato: '5561900000000', texto: 'quanto custa?', historico: [], contexto: {}, config: { ativo: true, nome: 'Buffet', perguntas: [], limites: { respostasPor24h: 20 } }, hoje: '2026-10-09', agora: '2026-10-09T12:00:00.000Z' } as never;

test('modo regras: a porta do Wall-e ignora o modelo montado; fora do modo regras, o modelo é usado e revalidado', async () => {
  let regras = true, chamadas = 0;
  const { modulo, registro } = carregarPorta(() => regras);
  const entender = async () => { chamadas++; return {} as never; };
  const porta = modulo.criarPortaWallE(entender);
  await porta.responder(entrada);
  assert.equal(chamadas, 0, 'regras: modelo não chamado');
  assert.deepEqual(registro.origem, ['regras']);
  // O modo é conferido a cada uso (não só ao montar a porta).
  regras = false;
  await porta.responder(entrada);
  assert.equal(chamadas, 1, 'modelo: chamado uma vez');
  assert.deepEqual(registro.origem, ['regras', 'modelo']);
  regras = true;
  await porta.responder(entrada);
  assert.equal(chamadas, 1, 'de volta ao modo regras: nenhuma chamada nova');
  assert.deepEqual(registro.origem, ['regras', 'modelo', 'regras']);
  // D1: fora do modo regras, mensagem com dado de saúde também não vai ao modelo (entende pelas regras).
  regras = false;
  await porta.responder({ ...entrada, texto: 'meu filho tem alergia a amendoim, o bolo tem?' });
  assert.equal(chamadas, 1, 'saúde: nenhuma chamada nova');
  assert.deepEqual(registro.origem, ['regras', 'modelo', 'regras', 'regras']);
});
