import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carregarComponente } from '../../../../components/admin/teste-componente.ts';
import { motivoSeguro } from '../motivo-falha.ts';

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
    '../core.ts': { ocultarDadosPessoais: (t: string) => t, dadoSensivel: (t: string) => /alergia/.test(t) },
    '../configuracao.ts': { entendimentoSoRegras: regras },
    '../multiempresa.ts': { direitoAtendimentoWhatsApp: async () => { throw new Error('banco proibido no teste'); } },
    '../motivo-falha.ts': { motivoSeguro },
    '../prontas-link.ts': { resolverLinkFechamento: async () => ({ ok: false }) },
    './contexto.ts': { lerContexto: (c: unknown) => (c ?? {}) },
    './entendimento.ts': {
      ESQUEMA_JSON_MODELO: {}, esquemaModelo: { parse: (v: unknown) => v },
      entenderPorRegras: () => ({ origem: 'regras', sinais: {} }),
      revalidarEntendimento: () => ({ origem: 'modelo', sinais: {} }),
      juntarSinais: (a: unknown) => a,
    },
    './fontes-postgres.ts': { catalogosWallE: async () => ({}), fontesPostgres: () => ({}) },
    './link-disponibilidade.ts': { ambienteDoLink: () => ({}), linkDisponibilidadeDaEmpresa: async () => ({ ok: false }) },
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
  await porta.responder({ ...(entrada as object), texto: 'meu filho tem alergia a amendoim, o bolo tem?' } as never);
  assert.equal(chamadas, 1, 'saúde: nenhuma chamada nova');
  assert.deepEqual(registro.origem, ['regras', 'modelo', 'regras', 'regras']);
});

test('Astra r3 (R-5, P2-2): sem direito comercial (inclusive a piloto) a porta não chama o modelo; com direito, chama', async () => {
  const { modulo, registro } = carregarPorta(() => false);
  let chamadas = 0; const consultados: string[] = []; let direito = false;
  const entender = async () => { chamadas++; return {} as never; };
  const porta = modulo.criarPortaWallE(entender, { direitoModelo: async (empresa) => { consultados.push(empresa); return direito; } });
  await porta.responder(entrada);
  assert.equal(chamadas, 0, 'sem direito: modelo não chamado');
  assert.deepEqual(registro.origem, ['regras']);
  direito = true;
  await porta.responder(entrada);
  assert.equal(chamadas, 1, 'com direito: modelo chamado');
  assert.deepEqual(registro.origem, ['regras', 'modelo']);
  assert.deepEqual(consultados, ['e', 'e'], 'o direito é conferido a cada mensagem, da empresa dona');
  // Saúde continua fora do modelo antes de qualquer consulta ao direito.
  await porta.responder({ ...(entrada as object), texto: 'tem alergia a amendoim?' } as never);
  assert.equal(chamadas, 1);
  assert.deepEqual(consultados, ['e', 'e']);
});

test('Astra r3 (R-5, P2-2): direitoModeloAtendimento nega o modelo quando a leitura comercial falha', async () => {
  const { modulo } = carregarPorta(() => false);
  assert.equal(await modulo.direitoModeloAtendimento('e'), false);
});

test('20/11: falha do modelo não derruba o Wall-e: registra só o código do motivo e segue pelas regras', async () => {
  const { modulo, registro } = carregarPorta(() => false);
  const avisos: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { avisos.push(args); };
  try {
    const porta = modulo.criarPortaWallE(async () => { throw new Error('ATENDIMENTO_MODELO_INDISPONIVEL:SEM_CHAVE'); });
    await porta.responder(entrada);
    // Erro com texto livre (poderia trazer trecho do cliente): só o tipo do erro vai ao log.
    const porta2 = modulo.criarPortaWallE(async () => { throw new TypeError('falhou ao ler quanto custa? 61 99999-0000'); });
    await porta2.responder(entrada);
  } finally { console.warn = original; }
  assert.deepEqual(registro.origem, ['regras', 'regras'], 'as duas mensagens seguiram pelas regras');
  assert.equal(avisos.length, 2);
  assert.equal(avisos[0][1], 'ATENDIMENTO_MODELO_INDISPONIVEL:SEM_CHAVE');
  assert.equal(avisos[1][1], 'ERRO_TypeError');
  assert.ok(!JSON.stringify(avisos).includes('quanto custa'), 'o texto do cliente nunca vai ao log');
});

test('motivoSeguro: códigos passam; texto livre vira o tipo do erro', () => {
  assert.equal(motivoSeguro(new Error('ATENDIMENTO_ORCAMENTO_SEM_TETO_EMPRESA')), 'ATENDIMENTO_ORCAMENTO_SEM_TETO_EMPRESA');
  assert.equal(motivoSeguro(new Error('ATENDIMENTO_MODELO_INDISPONIVEL:USO_NAO_REGISTRADO')), 'ATENDIMENTO_MODELO_INDISPONIVEL:USO_NAO_REGISTRADO');
  assert.equal(motivoSeguro(new SyntaxError('Unexpected token q in JSON: quero festa')), 'ERRO_SyntaxError');
  assert.equal(motivoSeguro('texto solto'), 'ERRO_string');
  assert.equal(motivoSeguro(undefined), 'ERRO_undefined');
});
