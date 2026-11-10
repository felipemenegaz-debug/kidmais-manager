import assert from 'node:assert/strict';
import test from 'node:test';
import { transpilar } from '../../disponibilidade/services/duracao-pacote-livre.test-apoio.ts';
import { ContratoServiceError } from './errors.ts';

const conexaoDescartavelDoPool = async () => { throw new Error('não deve abrir conexão real'); };

/**
 * Serviço real de contexto público com repositórios simulados: a marca só é consultada depois de a prova ser aceita.
 * Sem banco. Cada recusa da prova tem de terminar sem nenhuma consulta de marca nem de comprovantes.
 */
const CONTRATO = '11111111-1111-4111-8111-111111111111';
const VALIDACAO = { id: 'val', finalidade: 'CONTRATO_ACEITE', status: 'CONFIRMADA', clienteId: 'cli', provaExpiraEm: new Date(Date.now() + 60_000).toISOString(), consumidoPorContratoVersaoId: null };
const versao = {
  id: 'v1', contratoId: CONTRATO, numeroVersao: 1, status: 'ATIVA', snapshotHash: 'h', assinadoEm: null,
  snapshot: { contratante: { clienteId: 'cli' }, evento: { data: '2026-12-12', horarioInicio: '10:30:00', horarioFim: '14:30:00', pacote: { nome: 'P', codigo: 'P' } }, aniversariante: { nome: 'A' }, comercial: { valorFinalContrato: 1 } },
};

type Opcoes = { validacao?: unknown; clienteProva?: unknown; acessoFalha?: boolean; acessoValidacaoId?: string; acessoVersaoId?: string; versaoContratoId?: string; vinculo?: boolean };

function montar(opcoes: Opcoes = {}) {
  const marcas: string[] = [];
  const prazos: unknown[] = [];
  const consultas: string[] = [];
  const validacao = 'validacao' in opcoes ? opcoes.validacao : VALIDACAO;
  const clienteProva = 'clienteProva' in opcoes ? opcoes.clienteProva : { id: 'cli' };
  let chamadasCliente = 0;
  const lidos: string[] = [];
  const versaoDaVez = { ...versao, contratoId: opcoes.versaoContratoId ?? CONTRATO };
  const servico = transpilar('lib/contratos/services/contrato-publico.service.ts', {
    './errors': { ContratoServiceError },
    '../marca-contrato': {
      MARCA_CONTRATO_NEUTRA: { kidmais: false, nome: null },
      // A versão que engole o erro não pode rodar dentro da transação com prazo (tentaria COMMIT depois de falha de SQL).
      marcaDoContratoPublico: async (_tx: unknown, id: string) => { marcas.push(id); throw new Error('marcaDoContratoPublico dentro da transação'); },
      // Dentro da transação descartável a falha precisa subir (ROLLBACK em lerMarcaComPrazo), sem COMMIT após erro de SQL.
      marcaDoContratoNaTransacao: async (_tx: unknown, id: string) => { marcas.push(id); return { kidmais: false, nome: 'Buffet X' }; },
    },
    // Orçamento curto da marca: aqui só confere que a leitura passa pela conexão descartável.
    '../marca-com-prazo': { lerMarcaComPrazo: async (abrir: unknown, ler: (tx: unknown) => Promise<unknown>) => { assert.equal(abrir, conexaoDescartavelDoPool); prazos.push(abrir); return ler({}); } },
    '../storage/postgres': { lerDocumento: async (id: string) => { lidos.push(id); return { id }; } },
    '../assinatura-papel': { TEXTO_ASSINADO_EM_PAPEL: 'papel', versaoAssinadaEmPapel: () => false },
    '../../db/postgres': { conexaoDescartavelDoPool, db: () => ({ query: async (sql: string) => { consultas.push(sql); return /contrato_assinaturas/.test(sql) && opcoes.vinculo ? { rows: [{ id: 's' }], rowCount: 1 } : { rows: [], rowCount: 0 }; } }), withTransaction: async () => { throw new Error('sem transação aqui'); } },
    './administrativo.service': { edicaoDaVersao: async () => null },
    './fluxo-publico': { documentoParaLeitura: async () => null, adquirirDocumentoParaLeitura: async () => null, materializarDocumento: async () => null, versaoPublicaId: async () => 'v1', concluirFluxoCliente: async () => null },
    '../repositories': { buscarContratoPorId: async () => ({ id: CONTRATO, status: 'ATIVO', assinadoEm: null, versaoAtual: 1, fechamentoId: 'f' }), buscarVersaoPorId: async () => versaoDaVez, buscarVersaoCorrente: async () => versaoDaVez, salaoDoSnapshot: () => null },
    // Como o real: o token é de um contrato e de uma versão; a versão só é conferida quando quem chama a informa.
    './acesso-token': { criarContratoAcessoToken: () => 'a', validarContratoAcessoToken: (_t: string, esperado: { contratoId?: string; versaoId?: string }) => {
      const doToken = { contratoId: CONTRATO, versaoId: opcoes.acessoVersaoId ?? 'v1', validacaoId: opcoes.acessoValidacaoId ?? 'val' };
      if (opcoes.acessoFalha || esperado.contratoId !== doToken.contratoId || (esperado.versaoId !== undefined && esperado.versaoId !== doToken.versaoId)) {
        throw new ContratoServiceError('CONTRATO_ACESSO_NAO_AUTORIZADO', 'negado', 404);
      }
      return doToken;
    } },
    '../../identidade/repositories': { buscarValidacaoPorTokenHash: async () => validacao },
    '../../identidade/services': { hashProvaIdentidadeToken: () => 'hash' },
    '../../clientes/repositories': { buscarClienteCanonicoPorId: async () => { chamadasCliente += 1; return chamadasCliente === 1 ? clienteProva : { id: 'cli', cpf: '1', cnpj: null }; } },
    './documento.service': { gerarResumoContratacaoPdfDaVersao: () => ({ templateVersao: 1, pdfHash: 'r' }), contratoOficialDisponivelParaVersao: () => ({ disponivel: false, modeloCodigo: null, templateVersao: null, homologadoParaProducao: false }), aceiteDoTemplatePermitido: () => false },
  }, false) as { obterContextoContratoPublico(input: object): Promise<{ marca: unknown }>; lerComprovantePublico(input: object): Promise<unknown>; gerarResumoContratoPublico(input: object): Promise<{ marca: unknown }>; gerarPdfContratoPublico(input: object): Promise<{ marca: unknown }> };
  const obter = (provaToken = 'p'.repeat(32)) => servico.obterContextoContratoPublico({ contratoId: CONTRATO, provaToken, acessoToken: 'a'.repeat(32) });
  const comprovante = () => servico.lerComprovantePublico({ contratoId: CONTRATO, provaToken: 'p'.repeat(32), acessoToken: 'a'.repeat(32), documentoId: 'doc' });
  const entrada = { contratoId: CONTRATO, provaToken: 'p'.repeat(32), acessoToken: 'a'.repeat(32) };
  const resumo = () => servico.gerarResumoContratoPublico(entrada);
  const pdf = () => servico.gerarPdfContratoPublico(entrada);
  return { obter, comprovante, resumo, pdf, marcas, consultas, lidos, prazos };
}

test('prova aceita: a marca vem uma vez, no contexto', async () => {
  const m = montar();
  const contexto = await m.obter();
  assert.deepEqual(contexto.marca, { kidmais: false, nome: 'Buffet X' });
  assert.deepEqual(m.marcas, [CONTRATO]);
  assert.equal(m.prazos.length, 1, 'marca lida com orçamento curto');
});

const RECUSAS: Array<[string, Parameters<typeof montar>[0], string?]> = [
  ['prova curta', {}, 'curta'],
  ['acesso inválido ou expirado', { acessoFalha: true }],
  ['validação inexistente', { validacao: null }],
  ['outra finalidade', { validacao: { ...VALIDACAO, finalidade: 'OUTRA' } }],
  ['prova expirada', { validacao: { ...VALIDACAO, provaExpiraEm: new Date(Date.now() - 1000).toISOString() } }],
  ['validação pendente', { validacao: { ...VALIDACAO, status: 'PENDENTE' } }],
  ['consumida em outra versão', { validacao: { ...VALIDACAO, status: 'CONSUMIDA', consumidoPorContratoVersaoId: 'v9' } }],
  ['prova de outro cliente', { clienteProva: { id: 'outro' } }],
  ['acesso emitido para outra validação', { acessoValidacaoId: 'outra' }],
  ['acesso emitido para outra versão', { acessoVersaoId: 'v9' }],
  ['versão de outro contrato', { versaoContratoId: '22222222-2222-4222-8222-222222222222' }],
];
for (const [nome, opcoes, prova] of RECUSAS) {
  test('prova recusada, ' + nome + ': nenhuma consulta de marca nem de comprovantes', async () => {
    const m = montar(opcoes);
    await assert.rejects(m.obter(prova), (e: ContratoServiceError) => e.code === 'CONTRATO_ACESSO_NAO_AUTORIZADO');
    assert.deepEqual(m.marcas, []);
    assert.deepEqual(m.consultas, []);
  });
}

test('comprovante sem vínculo com a versão: código próprio, sem ler o documento', async () => {
  const m = montar();
  await assert.rejects(m.comprovante(), (e: ContratoServiceError) => e.code === 'COMPROVANTE_NAO_ENCONTRADO' && e.httpStatus === 404);
  assert.deepEqual(m.lidos, []);
});

test('comprovante vinculado: lê o documento', async () => {
  const m = montar({ vinculo: true });
  await m.comprovante();
  assert.deepEqual(m.lidos, ['doc']);
});

test('comprovante com prova recusada: acesso negado antes de qualquer consulta', async () => {
  const m = montar({ acessoValidacaoId: 'outra' });
  await assert.rejects(m.comprovante(), (e: ContratoServiceError) => e.code === 'CONTRATO_ACESSO_NAO_AUTORIZADO');
  assert.deepEqual(m.consultas, []);
});

test('Resumo e PDF públicos: a marca opcional passa pelo orçamento curto, nunca pelo pool sem prazo', async () => {
  for (const chamar of ["resumo", "pdf"] as const) {
    const m = montar();
    const dados = await m[chamar]();
    assert.deepEqual(dados.marca, { kidmais: false, nome: 'Buffet X' }, chamar);
    assert.equal(m.prazos.length, 1, chamar);
    assert.deepEqual(m.marcas, [CONTRATO], chamar);
  }
});
