import { cadastroContratualSchema, formularioCadastro, type CadastroConferido } from '../../clientes/cadastro-contratual.ts';
import { leituraRecebimentosGuardada } from '../../importacao-contrato/recebimentos.ts';
import type { DbExecutor } from '../../db/contracts.ts';
import { FORMAS, type FormaFinanceira } from '../../financeiro/calculos.ts';
import type { TenantComprovado } from '../../saas/provar-tenant.ts';
import { validarPlanoPagamento } from '../../pagamentos/services/financeiro-core.ts';
import { reautenticacaoPerfilRecente } from '../../perfil/reautenticacao.ts';
import { hashSnapshotContrato } from '../services/snapshot-core.ts';
import {
  avaliarFinanceiro, avaliarIntegracao, centavosParaReais, DECLARACAO_CONFERENCIA, decisoesSchema, financeiroSchema, hashCanonico, hashResumo,
  montarSnapshotVersao, reais, sugestaoInicial, type DecisoesFinanceiras, type DecisoesIntegracao, type Referencias, type ResumoFinanceiro,
} from './modelo.ts';
import * as repo from './repositorio.ts';

/**
 * Integração do contrato importado ao Core, na transação do tenant comprovado (`withTenantTransaction`).
 *
 * Simular: calcula e devolve o resumo + hash (nada é gravado). Confirmar: revalida tudo com locks, exige o MESMO
 * hash do que o operador viu e grava atomicamente fechamento → contrato (versão de conferência em papel, edição
 * concluída, fluxo) → vínculo → festa → financeiro. Qualquer falha desfaz tudo (inclusive os gatilhos diferidos
 * da 019/057/061 no commit). Não há chamada externa nesta transação.
 *
 * As escritas de domínio vêm da porta `Core` (fechamento, auditoria, pagamentos e recebimentos nativos), para
 * reutilizar exatamente os serviços existentes e permitir testes sem banco.
 */
export class IntegracaoImportadoError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, httpStatus = 409, details?: Record<string, unknown>) {
    super(message);
    this.name = 'IntegracaoImportadoError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export const PAPEIS_INTEGRACAO = ['ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO'] as const;
export const ORIGEM_INTEGRACAO = 'IMPORTACAO_HISTORICA';

/** `autenticadoEm`: instante da última autenticação por senha da sessão (`sessoes_administrativas.autenticado_em`). */
export type ContextoIntegracao = { usuarioId: string; token: string; requestId: string; ip: string | null; userAgent: string | null; autenticadoEm: string };

type Auditoria = { clienteId?: string | null; atorTipo: 'USUARIO'; usuarioId: string; acao: string; entidadeTipo: string; entidadeId: string; dadosAntes?: Record<string, unknown> | null; dadosDepois?: Record<string, unknown> | null; justificativa?: string | null; origem: string; requestId?: string | null; ip?: string | null; userAgent?: string | null };
type Historico = { clienteId: string; tipoEvento: string; origem: string; entidadeTipo?: string | null; entidadeId?: string | null; usuarioId?: string | null; detalhe?: string | null; metadata?: Record<string, unknown>; critico?: boolean };

export type Core = {
  snapshotFechamento(tx: DbExecutor, fechamentoId: string): Promise<Record<string, unknown>>;
  /** Patch do CRM: sem a chave `telefone` (a tela não a envia), o telefone já gravado é preservado. */
  atualizarCliente(tx: DbExecutor, clienteId: string, empresaId: string, cadastro: CadastroConferido, ctx: ContextoIntegracao): Promise<void>;
  criarFechamento(tx: DbExecutor, input: Record<string, unknown>): Promise<{ id: string }>;
  registrarAuditoria(tx: DbExecutor, input: Auditoria): Promise<unknown>;
  registrarEventoHistorico(tx: DbExecutor, input: Historico): Promise<unknown>;
  criarPagamento(tx: DbExecutor, input: { contratoVersaoId: string; valorTotalContratado: number; criadoPorUsuarioId: string }): Promise<{ id: string }>;
  confirmarReserva(tx: DbExecutor, pagamentoId: string): Promise<unknown>;
  criarPlano(tx: DbExecutor, input: { pagamentoId: string; numeroVersao: number; meioPagamento: 'PIX' | 'CARTAO'; modalidade: 'AVISTA' | 'PARCELADO'; quantidadeParcelas: number; observacoes: string; criadoPorUsuarioId: string }): Promise<{ id: string }>;
  criarParcela(tx: DbExecutor, input: { planoId: string; numero: number; valorPrevisto: number; vencimento: string; confirmaReserva: boolean }): Promise<{ id: string }>;
  /** `registrarRecebimentoPagamento` nativo (alocação, estados, ledger e auditoria) no executor da transação do tenant. */
  registrarRecebimento(input: {
    pagamentoId: string; meioPagamento: 'PIX' | 'CARTAO' | 'TRANSFERENCIA' | 'DINHEIRO' | 'OUTRO'; valorBruto: number; recebidoEm: string;
    chaveIdempotencia: string; observacoes: string; metadataProvedor: Record<string, unknown>; confirmarAgora: true; alocacoes: Array<{ parcelaId: string; valor: number }>;
  }, ctx: { token: string; usuarioId: string; origem: string; requestId: string; ip: string | null; userAgent: string | null; executor: DbExecutor; aoConfirmar: (tx: DbExecutor) => Promise<void> }): Promise<{ reutilizado: boolean }>;
  /** Aniversariante no CRM do cliente (`cadastrarAniversarianteInterno`: lock por nome, histórico e auditoria). */
  cadastrarAniversariante(tx: DbExecutor, input: { clienteId: string; empresaId: string; nome: string; tema: string | null }, ctx: { usuarioId: string; origem: string; requestId: string; ip: string | null; userAgent: string | null }): Promise<{ id: string }>;
  chaveRecebimento(empresaId: string, chave: string): string;
  meioDoRecebimento(forma: FormaFinanceira): 'PIX' | 'CARTAO' | 'TRANSFERENCIA' | 'DINHEIRO' | 'OUTRO';
  auditarRecebimento(tx: DbExecutor, empresaId: string, atorId: string, parcelaId: string, valorReais: number): Promise<void>;
};

/**
 * Autenticação recente (mesma janela de 5 minutos e mesmo mecanismo nativo da assinatura e do perfil): a conferência
 * histórica grava contrato, festa, agenda e financeiro em nome do operador. A tela pede a senha (`reautenticar`).
 */
export function exigirAutenticacaoRecente(ctx: ContextoIntegracao, agora = Date.now()) {
  if (!reautenticacaoPerfilRecente(ctx.autenticadoEm, agora)) {
    throw new IntegracaoImportadoError('REAUTENTICACAO_NECESSARIA', 'Confirme sua senha novamente antes de integrar o contrato ou conferir pagamentos.', 403);
  }
}

/** Mesma chave = mesmo pedido: devolve o gravado se o conteúdo é o mesmo; chave repetida com outro conteúdo é recusada. */
function repeticao(gravado: { chave: string; payloadHash: string }, pedido: { chave: string; resumoHash: string }) {
  if (gravado.chave === pedido.chave) {
    if (gravado.payloadHash === pedido.resumoHash) return true;
    throw new IntegracaoImportadoError('IDEMPOTENCIA_CONFLITANTE', 'Esta confirmação já foi usada com outro conteúdo. Recarregue e confira de novo.', 409);
  }
  // Outra chave com o MESMO conteúdo (duas abas, reenvio): é o mesmo pedido; nada é gravado de novo.
  return gravado.payloadHash === pedido.resumoHash;
}

function exigirPapel(tenant: TenantComprovado) {
  if (!(PAPEIS_INTEGRACAO as readonly string[]).includes(tenant.papelAtual ?? '')) {
    throw new IntegracaoImportadoError('OPERACAO_NAO_AUTORIZADA', 'Seu acesso nesta empresa não permite integrar contratos importados.', 403);
  }
}

/**
 * Chave de ativação por ambiente (padrão: desligada). Permite publicar código e schema sem liberar a integração e
 * desligá-la para recuperação sem desfazer schema. Não afeta contratos já integrados (seguem no Core).
 */
export const integracaoLigada = (env: Record<string, string | undefined> = process.env) => env.CONTRACT_IMPORT_INTEGRATION_ENABLED === 'true';

async function exigirDisponivel(tx: DbExecutor) {
  if (!integracaoLigada() || !await repo.integracaoDisponivel(tx)) {
    throw new IntegracaoImportadoError('INTEGRACAO_INDISPONIVEL', 'A integração de contratos importados ainda não está disponível neste ambiente.', 503);
  }
}

async function importacaoConfirmada(tx: DbExecutor, empresaId: string, importacaoId: string, travar: boolean) {
  const i = await repo.lerImportacao(tx, empresaId, importacaoId, travar);
  if (!i || i.status !== 'IMPORTADA' || !i.snapshot) throw new IntegracaoImportadoError('IMPORTACAO_NAO_ENCONTRADA', 'Contrato importado não encontrado.', 404);
  return i as typeof i & { snapshot: NonNullable<typeof i.snapshot> };
}

/** Recebimento ao meio-dia UTC da data efetiva: a mesma data em UTC e em Brasília (fluxo de caixa usa `recebido_em::date`). */
export function instanteDoRecebimento(data: string, agora = new Date()) {
  const meioDia = new Date(`${data}T12:00:00.000Z`);
  return (meioDia.getTime() <= agora.getTime() ? meioDia : agora).toISOString();
}

type Preparo = Awaited<ReturnType<typeof preparar>>;

/** Fonte interna para o preview anterior ao cadastro. Nunca é aceita de um corpo HTTP. */
export type FonteIntegracaoRascunho = {
  importacao: repo.ImportacaoParaIntegrar & { snapshot: NonNullable<repo.ImportacaoParaIntegrar['snapshot']> };
  cliente: repo.ClienteIntegracao;
  clienteNovo: boolean;
};

/** Critério da busca de possíveis duplicados: o mesmo na simulação e na reconsulta depois do lock. */
function criterioDuplicidade(e: { cliente: repo.ClienteIntegracao; documento: { sha256: string }; decisoes: DecisoesIntegracao; nomeAniversariante: string | null;
  snapshot: { evento?: { data?: string | null } | null }; valorCentavos: number }) {
  const contato = repo.contatoComparavel(e.cliente);
  return {
    clienteId: e.cliente.id, data: e.decisoes.evento.data, dataDocumento: e.snapshot.evento?.data ?? null, aniversariante: e.nomeAniversariante,
    valorCentavos: e.valorCentavos, documentoSha256: e.documento.sha256, cpf: contato.cpf, telefones: contato.telefones,
  };
}

function mensagemDuplicidade(vinculos: Array<{ alcance: repo.AlcanceDuplicidade }>) {
  const outraData = vinculos.some((v) => v.alcance === 'OUTRA_DATA');
  const quantas = vinculos.length === 1 ? 'uma contratação parecida' : `${vinculos.length} contratações parecidas`;
  return `Há ${quantas} nesta empresa ${outraData ? 'neste dia ou em data próxima (a data do documento pode ter sido lida ou corrigida de outro jeito)' : 'neste dia'}. Confira se é o mesmo contrato; se for outro, confirme "É outro contrato" e explique o motivo.`;
}

async function preparar(tx: DbExecutor, tenant: TenantComprovado, importacaoId: string, decisoes: DecisoesIntegracao, hoje: string, travar: boolean, fonte?: FonteIntegracaoRascunho) {
  const empresaId = tenant.empresaComprovada;
  const importacao = fonte?.importacao ?? await importacaoConfirmada(tx, empresaId, importacaoId, travar);
  const clienteAtual = fonte?.cliente ?? await repo.clienteDaEmpresa(tx, empresaId, importacao.clienteId, travar);
  if (!clienteAtual) throw new IntegracaoImportadoError('IMPORTACAO_NAO_ENCONTRADA', 'Contrato importado não encontrado.', 404);
  const cliente = { ...clienteAtual, ...decisoes.cadastro };
  const cadastro = cadastroContratualSchema.safeParse(formularioCadastro(cliente));
  const documento = await repo.documentoOriginal(tx, empresaId, importacao.documentoId);
  if (!documento) throw new IntegracaoImportadoError('DOCUMENTO_ORIGINAL_AUSENTE', 'O documento original desta importação não foi encontrado. Ele é obrigatório para a conferência.', 409);
  const estabelecimentos = await repo.estabelecimentosAtivos(tx, empresaId);
  const pacote = decisoes.pacoteReferenciaId ? await repo.pacoteDaEmpresa(tx, empresaId, decisoes.pacoteReferenciaId) : null;
  const configuracaoAgendaId = await repo.configuracaoAgenda(tx, decisoes.evento.horarioInicio, empresaId, decisoes.estabelecimentoId);
  // Categoria do HORÁRIO: a regra do fechamento comum para a data e o turno, quando existe. Só a ausência COMPROVADA de
  // regra cai no comportamento anterior (a categoria da linha de preço, se for PADRAO ou NOBRE). GERAL sem regra fica
  // null e bloqueia antes de gravar. A categoria do PREÇO continua a da linha escolhida (pode ser GERAL).
  const regraHorario = await repo.regraCategoriaHorario(tx, decisoes.evento.data, configuracaoAgendaId);
  const precoReferencia = pacote ? await repo.precoReferencia(tx, empresaId, pacote.id, decisoes.evento.data, decisoes.evento.convidados, regraHorario) : null;
  const categoriaDoPreco = precoReferencia?.categoria;
  const categoriaHorario = regraHorario ?? (categoriaDoPreco === 'PADRAO' || categoriaDoPreco === 'NOBRE' ? categoriaDoPreco : null);
  const referencias: Referencias = {
    cliente: { id: cliente.id, nome: cliente.nomeCompleto, status: cliente.status },
    estabelecimentos, pacote, precoReferencia, configuracaoAgendaId, categoriaHorario,
  };
  const avaliacao = avaliarIntegracao({ snapshot: importacao.snapshot, decisoes, referencias, hoje });
  avaliacao.resumo.cadastro = formularioCadastro(cliente);
  // O cadastro lido também integra a revisão: não sobrescrever uma edição concorrente do CRM.
  avaliacao.resumo.cadastroFonteHash = hashCanonico(formularioCadastro(clienteAtual));
  if (!cadastro.success) avaliacao.bloqueios.push('Complete os dados do contratante: nome, CPF válido e WhatsApp (ou telefone já cadastrado) são obrigatórios; e-mail é opcional e o endereço, se informado, precisa estar completo.');
  if (clienteAtual.cpf && decisoes.cadastro && clienteAtual.cpf.replace(/\D/g, '') !== decisoes.cadastro.cpf) avaliacao.bloqueios.push('O CPF do cliente vinculado não pode ser substituído. Confira o vínculo na etapa do cliente.');
  // Aniversariante do documento: vinculado ao cadastro do cliente (mesmo nome) ou criado nele. As revisões nativas
  // do contrato reconstroem o snapshot a partir do fechamento e exigem aniversariante vinculado.
  const nomeAniversariante = decisoes.aniversariante ?? (importacao.snapshot.evento?.aniversariante?.trim() || null);
  avaliacao.resumo.festa.aniversariante = nomeAniversariante;
  const aniversarianteExistente = !fonte?.clienteNovo && nomeAniversariante && nomeAniversariante.length >= 2 ? await repo.aniversarianteDoCliente(tx, cliente.id, nomeAniversariante) : null;
  avaliacao.resumo.festa.aniversarianteCadastro = !nomeAniversariante || nomeAniversariante.length < 2 ? null : aniversarianteExistente ? 'EXISTENTE' : 'NOVO';
  const recusaPlano = recusaDoPlanoNativo(decisoes.financeiro, avaliacao.resumo.financeiro.contratadoCentavos, decisoes.evento.data);
  if (recusaPlano) avaliacao.bloqueios.push(recusaPlano);
  if (avaliacao.resumo.festa.aniversarianteCadastro === null) avaliacao.bloqueios.push('Informe o nome do aniversariante para criar o cadastro e vinculá-lo à festa.');
  // Possível duplicidade (reescaneamento, outro cliente cadastrado para a mesma festa, data lida ou corrigida de forma
  // divergente): nunca unida nem recusada sozinha; exige decisão auditada do operador ("É outro contrato" + motivo).
  const criterio = criterioDuplicidade({ cliente, documento, decisoes, nomeAniversariante, snapshot: importacao.snapshot, valorCentavos: avaliacao.resumo.contrato.valorContratadoCentavos });
  // Cliente ainda não criado não pode coincidir por um UUID virtual. Contatos e demais sinais continuam valendo.
  const criterioEfetivo = fonte?.clienteNovo ? { ...criterio, clienteId: null } : criterio;
  const vinculos = await repo.possiveisVinculos(tx, empresaId, criterioEfetivo);
  if (vinculos.length && !(decisoes.outroContratoConfirmado && decisoes.motivoOutroContrato.length >= 5)) {
    avaliacao.bloqueios.push(mensagemDuplicidade(vinculos));
  }
  return { empresaId, importacao, cliente, documento, referencias, avaliacao, vinculos, criterio, pacote, precoReferencia, configuracaoAgendaId, nomeAniversariante, aniversarianteExistente };
}

async function conflito(tx: DbExecutor, p: Preparo, d: DecisoesIntegracao) {
  if (!p.avaliacao.resumo.agenda.ocupa) return null;
  const c = await repo.conflitoAgenda(tx, d.evento.data, d.evento.horarioInicio, d.evento.horarioFim, p.empresaId, d.estabelecimentoId);
  if (c.bloqueado) return 'O horário está bloqueado na agenda. Escolha outro horário ou libere o bloqueio antes de integrar.';
  if (c.ocupado) return 'O horário já está ocupado por outra festa. Confira data e horário (correção de leitura) antes de integrar.';
  return null;
}

/** Dados para montar o assistente: sugestão do documento (sem presumir recebimento), unidades, pacotes e formas. */
export async function opcoesIntegracao(tx: DbExecutor, tenant: TenantComprovado, importacaoId: string, hoje: string) {
  exigirPapel(tenant);
  const empresaId = tenant.empresaComprovada;
  const disponivel = integracaoLigada() && await repo.integracaoDisponivel(tx);
  const importacao = await importacaoConfirmada(tx, empresaId, importacaoId, false);
  const vinculo = disponivel ? await repo.vinculoDaImportacao(tx, empresaId, importacaoId) : null;
  const cliente = await repo.clienteDaEmpresa(tx, empresaId, importacao.clienteId, false);
  return {
    disponivel,
    hoje,
    integracao: vinculo ? await (async () => {
      // Com obrigação já criada (aqui ou no Financeiro), o caminho é o Financeiro do contrato, nunca "Conferir pagamentos".
      const estado = await repo.estadoFinanceiroDoContrato(tx, vinculo.contratoId, vinculo.versaoId);
      const caminho = repo.caminhoFinanceiro({ conferido: vinculo.financeiro !== null, ...estado });
      return { contratoId: vinculo.contratoId, financeiroPendente: caminho !== 'CONCLUIDO', caminhoFinanceiro: caminho, valorContratadoCentavos: vinculo.valorContratadoCentavos, contratoCancelado: vinculo.contratoCancelado };
    })() : null,
    cliente: cliente ? { id: cliente.id, nome: cliente.nomeCompleto, ativo: cliente.status === 'ATIVO', cadastro: formularioCadastro(cliente) } : null,
    documento: {
      pacote: importacao.snapshot.pacote?.nome ?? null,
      aniversariante: importacao.snapshot.evento?.aniversariante ?? null,
      tema: importacao.snapshot.evento?.tema ?? null,
    },
    sugestao: { ...sugestaoInicial(importacao.snapshot), recebimentosDocumento: leituraRecebimentosGuardada(importacao.recebimentosDocumento) },
    estabelecimentos: disponivel ? await repo.estabelecimentosAtivos(tx, empresaId) : [],
    pacotes: disponivel ? await repo.pacotesDaEmpresa(tx, empresaId) : [],
    formas: FORMAS,
    declaracao: DECLARACAO_CONFERENCIA,
  };
}

export async function simularIntegracao(tx: DbExecutor, tenant: TenantComprovado, importacaoId: string, bruto: unknown, hoje: string, fonte?: FonteIntegracaoRascunho) {
  exigirPapel(tenant);
  await exigirDisponivel(tx);
  const decisoes = decisoesSchema.parse(bruto);
  const vinculo = await repo.vinculoDaImportacao(tx, tenant.empresaComprovada, importacaoId);
  if (vinculo) return { integrada: true as const, contratoId: vinculo.contratoId };
  const p = await preparar(tx, tenant, importacaoId, decisoes, hoje, false, fonte);
  const motivoConflito = await conflito(tx, p, decisoes);
  if (motivoConflito) p.avaliacao.bloqueios.push(motivoConflito);
  if (!decisoes.conferenciaDeclarada) p.avaliacao.avisos.push('Para confirmar, declare a conferência do documento original.');
  return {
    integrada: false as const,
    pronto: p.avaliacao.bloqueios.length === 0,
    bloqueios: p.avaliacao.bloqueios,
    avisos: p.avaliacao.avisos,
    resumo: p.avaliacao.resumo,
    resumoHash: hashDaRevisao(importacaoId, decisoes, p.avaliacao.resumo, p.vinculos),
    possiveisVinculos: p.vinculos,
  };
}

export async function opcoesIntegracaoRascunho(tx: DbExecutor, tenant: TenantComprovado, fonte: FonteIntegracaoRascunho, hoje: string) {
  exigirPapel(tenant);
  await exigirDisponivel(tx);
  const empresaId = tenant.empresaComprovada, snapshot = fonte.importacao.snapshot;
  return {
    disponivel: true, hoje, integracao: null,
    cliente: { id: fonte.clienteNovo ? null : fonte.cliente.id, nome: fonte.cliente.nomeCompleto, ativo: fonte.cliente.status === 'ATIVO', cadastro: formularioCadastro(fonte.cliente) },
    documento: { pacote: snapshot.pacote?.nome ?? null, aniversariante: snapshot.evento?.aniversariante ?? null, tema: snapshot.evento?.tema ?? null },
    sugestao: { ...sugestaoInicial(snapshot), recebimentosDocumento: leituraRecebimentosGuardada(fonte.importacao.recebimentosDocumento) },
    estabelecimentos: await repo.estabelecimentosAtivos(tx, empresaId), pacotes: await repo.pacotesDaEmpresa(tx, empresaId),
    formas: FORMAS, declaracao: DECLARACAO_CONFERENCIA,
  };
}

function meioDoPlano(f: Extract<DecisoesFinanceiras, { parcelas: unknown }>): 'PIX' | 'CARTAO' {
  const formas = f.parcelas.map((p) => p.recebimento?.forma).filter((x): x is FormaFinanceira => !!x);
  return formas.length > 0 && formas.every((x) => x === 'CARTAO_CREDITO' || x === 'CARTAO_DEBITO') ? 'CARTAO' : 'PIX';
}

/** Parcelas que vencem depois da festa (números 1..n), confirmadas ou não pelo operador. */
export function parcelasAposFesta(f: DecisoesFinanceiras, dataFesta: string) {
  if (!('parcelas' in f)) return { confirmadas: [] as number[], pendentes: [] as number[] };
  const apos = f.parcelas.map((p, i) => ({ numero: i + 1, p })).filter(({ p }) => p.vencimento > dataFesta);
  return { confirmadas: apos.filter(({ p }) => p.aposFestaConfirmada).map(({ numero }) => numero), pendentes: apos.filter(({ p }) => !p.aposFestaConfirmada).map(({ numero }) => numero) };
}

/**
 * O plano gravado precisa obedecer às MESMAS regras do plano nativo (`validarPlanoPagamento`: 1 a 60 parcelas, soma
 * exata, primeira parcela confirma a reserva, vencimentos até a data da festa): é o plano que o financeiro do contrato
 * vai editar depois. Única exceção, só do contrato HISTÓRICO: parcela que vence depois da festa conforme o contrato
 * original e confirmada explicitamente pelo operador (`aposFestaConfirmada`); as demais regras continuam valendo e o
 * vencimento nunca é alterado. Fora delas, a conferência fica bloqueada com o motivo (pode ficar "não conferido").
 */
export function recusaDoPlanoNativo(f: DecisoesFinanceiras, contratadoCentavos: number, dataFesta: string): string | null {
  if (!('parcelas' in f) || contratadoCentavos <= 0) return null;
  const n = f.parcelas.length;
  const { pendentes } = parcelasAposFesta(f, dataFesta);
  if (pendentes.length) {
    return `Parcela ${pendentes.join(', ')}: vence depois da festa. Confirme que isso consta do contrato original (exceção histórica) ou corrija o vencimento.`;
  }
  // Exceção confirmada: a data-limite da regra nativa passa a ser o último vencimento confirmado; nada mais muda.
  const limite = f.parcelas.reduce((m, p) => (p.aposFestaConfirmada && p.vencimento > m ? p.vencimento : m), dataFesta);
  try {
    validarPlanoPagamento(centavosParaReais(contratadoCentavos), {
      meioPagamento: meioDoPlano(f), modalidade: n === 1 ? 'AVISTA' : 'PARCELADO',
      parcelas: f.parcelas.map((p, i) => ({ valor: centavosParaReais(p.valorCentavos), vencimento: p.vencimento, confirmaReserva: i === 0 })),
    }, limite);
    return null;
  } catch (e) {
    if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') return `Plano de pagamento fora das regras do financeiro: ${(e as Error).message}`;
    throw e;
  }
}

/** Obrigação, plano, parcelas e recebimentos nos serviços nativos. Chaves determinísticas: repetir não duplica. */
async function integrarFinanceiro(tx: DbExecutor, tenant: TenantComprovado, ctx: ContextoIntegracao, core: Core, e: {
  importacaoId: string; vinculoId: string; versaoId: string; contratoId: string; clienteId: string;
  financeiro: Extract<DecisoesFinanceiras, { parcelas: unknown }>; resumo: Extract<ResumoFinanceiro, { recebidoCentavos: number }>;
  chave: string; payloadHash: string; dataFesta: string;
}) {
  const empresaId = tenant.empresaComprovada;
  const recusaPlano = recusaDoPlanoNativo(e.financeiro, e.resumo.contratadoCentavos, e.dataFesta);
  if (recusaPlano) throw new IntegracaoImportadoError('INTEGRACAO_BLOQUEADA', recusaPlano, 422, { bloqueios: [recusaPlano] });
  const pagamento = await core.criarPagamento(tx, { contratoVersaoId: e.versaoId, valorTotalContratado: centavosParaReais(e.resumo.contratadoCentavos), criadoPorUsuarioId: ctx.usuarioId });
  // Reserva já confirmada pela conferência do contrato vigente: recebimento histórico não decide agenda.
  await core.confirmarReserva(tx, pagamento.id);
  const n = e.financeiro.parcelas.length;
  const plano = await core.criarPlano(tx, {
    pagamentoId: pagamento.id, numeroVersao: 1, meioPagamento: meioDoPlano(e.financeiro), modalidade: n === 1 ? 'AVISTA' : 'PARCELADO', quantidadeParcelas: n,
    observacoes: 'Plano do contrato histórico importado, conferido pelo operador. Formas por recebimento.', criadoPorUsuarioId: ctx.usuarioId,
  });
  const parcelas: string[] = [];
  for (const [i, p] of e.financeiro.parcelas.entries()) {
    parcelas.push((await core.criarParcela(tx, { planoId: plano.id, numero: i + 1, valorPrevisto: centavosParaReais(p.valorCentavos), vencimento: p.vencimento, confirmaReserva: i === 0 })).id);
  }
  await core.registrarEventoHistorico(tx, { clienteId: e.clienteId, tipoEvento: 'PAGAMENTO_CRIADO', origem: ORIGEM_INTEGRACAO, entidadeTipo: 'PAGAMENTO', entidadeId: pagamento.id, usuarioId: ctx.usuarioId, detalhe: `Obrigação do contrato histórico: ${reais(e.resumo.contratadoCentavos)} em ${n} parcela(s).`, metadata: { importacaoId: e.importacaoId, contratoId: e.contratoId } });
  await core.registrarAuditoria(tx, { clienteId: e.clienteId, atorTipo: 'USUARIO', usuarioId: ctx.usuarioId, acao: 'PAGAMENTO_CRIADO', entidadeTipo: 'PAGAMENTO', entidadeId: pagamento.id, dadosDepois: { contratoVersaoId: e.versaoId, valorTotalCentavos: e.resumo.contratadoCentavos, parcelas: n, origem: ORIGEM_INTEGRACAO }, origem: ORIGEM_INTEGRACAO, requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent });
  const excecao = parcelasAposFesta(e.financeiro, e.dataFesta).confirmadas;
  if (excecao.length) {
    await core.registrarAuditoria(tx, { clienteId: e.clienteId, atorTipo: 'USUARIO', usuarioId: ctx.usuarioId, acao: 'EXCECAO_HISTORICA_VENCIMENTO_APOS_FESTA', entidadeTipo: 'PAGAMENTO', entidadeId: pagamento.id,
      dadosDepois: { dataFesta: e.dataFesta, parcelas: excecao.map((numero) => ({ numero, vencimento: e.financeiro.parcelas[numero - 1].vencimento })) },
      justificativa: 'Vencimento posterior à festa conforme o contrato original, confirmado pelo operador.', origem: ORIGEM_INTEGRACAO, requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent });
  }
  for (const [i, p] of e.financeiro.parcelas.entries()) {
    if (!p.recebimento) continue;
    const valor = centavosParaReais(p.valorCentavos);
    await core.registrarRecebimento({
      pagamentoId: pagamento.id, meioPagamento: core.meioDoRecebimento(p.recebimento.forma), valorBruto: valor,
      recebidoEm: instanteDoRecebimento(p.recebimento.data),
      chaveIdempotencia: core.chaveRecebimento(empresaId, `importacao:${e.importacaoId}:parcela:${i + 1}`),
      observacoes: 'Recebimento histórico conferido na integração do contrato importado.',
      metadataProvedor: { forma: p.recebimento.forma, taxaCentavos: 0, origem: ORIGEM_INTEGRACAO, importacaoId: e.importacaoId },
      confirmarAgora: true, alocacoes: [{ parcelaId: parcelas[i], valor }],
    }, {
      token: ctx.token, usuarioId: ctx.usuarioId, origem: ORIGEM_INTEGRACAO, requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent, executor: tx,
      aoConfirmar: (txc) => core.auditarRecebimento(txc, empresaId, ctx.usuarioId, parcelas[i], valor),
    });
  }
  await repo.inserirFinanceiro(tx, {
    empresaId, vinculoId: e.vinculoId, pagamentoId: pagamento.id, situacao: e.financeiro.situacao,
    contratado: e.resumo.contratadoCentavos, recebido: e.resumo.recebidoCentavos, saldo: e.resumo.saldoCentavos,
    decisoes: { financeiro: e.financeiro }, chave: e.chave, payloadHash: e.payloadHash, usuarioId: ctx.usuarioId, papel: tenant.papelAtual!, requestId: ctx.requestId,
  });
  return { pagamentoId: pagamento.id, situacao: e.financeiro.situacao, recebidoCentavos: e.resumo.recebidoCentavos, saldoCentavos: e.resumo.saldoCentavos };
}

export type PedidoConfirmacao = { decisoes: unknown; resumoHash: string; chave: string };

/**
 * Hash do que o operador revisou. Com possíveis duplicados, inclui os candidatos exibidos: a decisão "É outro
 * contrato" vale só para eles; um candidato novo exige nova revisão. Sem candidatos, é o hash do resumo de sempre.
 */
export function hashDaRevisao(importacaoId: string, decisoes: DecisoesIntegracao, resumo: Parameters<typeof hashResumo>[2], vinculos: Array<{ fechamentoId: string }>) {
  const base = hashResumo(importacaoId, decisoes, resumo);
  return vinculos.length ? hashCanonico({ resumo: base, candidatos: vinculos.map((v) => v.fechamentoId).sort() }) : base;
}

export async function confirmarIntegracao(tx: DbExecutor, tenant: TenantComprovado, ctx: ContextoIntegracao, importacaoId: string, pedido: PedidoConfirmacao, hoje: string, core: Core) {
  exigirPapel(tenant);
  await exigirDisponivel(tx);
  const decisoes = decisoesSchema.parse(pedido.decisoes);
  const empresaId = tenant.empresaComprovada;
  // Lock da importação primeiro: duas confirmações da mesma importação se enfileiram aqui.
  await importacaoConfirmada(tx, empresaId, importacaoId, true);
  const existente = await repo.vinculoDaImportacao(tx, empresaId, importacaoId);
  if (existente) {
    // Mesmo conteúdo já confirmado (repetição após timeout, outra aba): devolve o resultado gravado, sem escrever nada.
    if (repeticao(existente, pedido)) {
      const gravado = await repo.resultadoGravado(tx, empresaId, existente.id);
      return { reutilizado: true as const, ...gravado!, destino: `/admin/contratos?contratoId=${existente.contratoId}` };
    }
    throw new IntegracaoImportadoError('IMPORTACAO_JA_INTEGRADA', 'Este contrato importado já foi integrado. Abra o contrato integrado.', 409, { contratoId: existente.contratoId });
  }
  if (await repo.chaveUsadaEmOutra(tx, pedido.chave, importacaoId)) throw new IntegracaoImportadoError('IDEMPOTENCIA_CONFLITANTE', 'Esta confirmação já foi usada para outra operação. Recarregue e confirme de novo.', 409);
  exigirAutenticacaoRecente(ctx);

  const p = await preparar(tx, tenant, importacaoId, decisoes, hoje, true);
  if (!decisoes.conferenciaDeclarada) p.avaliacao.bloqueios.push('Declare a conferência do documento original antes de confirmar.');
  if (p.avaliacao.bloqueios.length) throw new IntegracaoImportadoError('INTEGRACAO_BLOQUEADA', p.avaliacao.bloqueios[0], 422, { bloqueios: p.avaliacao.bloqueios });
  const resumoHash = hashDaRevisao(importacaoId, decisoes, p.avaliacao.resumo, p.vinculos);
  if (resumoHash !== pedido.resumoHash) {
    throw new IntegracaoImportadoError('RESUMO_DESATUALIZADO', 'Os dados mudaram desde a revisão. Confira o resumo atualizado e confirme de novo.', 409, { resumo: p.avaliacao.resumo, resumoHash });
  }
  const ocupa = p.avaliacao.resumo.agenda.ocupa;
  // Ordem única de locks (062 + integração): empresa → unidade → habilitação → duplicidade → data → contratação.
  if (decisoes.estabelecimentoId) await repo.travarUnidade(tx, decisoes.estabelecimentoId);
  // Possíveis duplicados reconsultados DENTRO da serialização por empresa (vale para evento passado, slots diferentes e
  // datas divergentes): a confirmação concorrente da mesma empresa já terminou e é vista aqui.
  await repo.travarDuplicidade(tx, empresaId);
  const vinculosAgora = await repo.possiveisVinculos(tx, empresaId, p.criterio);
  if (hashDaRevisao(importacaoId, decisoes, p.avaliacao.resumo, vinculosAgora) !== resumoHash) {
    throw new IntegracaoImportadoError('RESUMO_DESATUALIZADO', 'Uma contratação parecida acabou de ser registrada nesta empresa. Confira se é o mesmo contrato e decida antes de confirmar.', 409,
      { resumo: p.avaliacao.resumo, possiveisVinculos: vinculosAgora });
  }
  p.vinculos = vinculosAgora;
  if (ocupa) {
    // Lock da data no namespace do Core e revalidação depois dele (READ COMMITTED vê o último vencedor).
    await repo.travarData(tx, decisoes.evento.data);
    const motivo = await conflito(tx, p, decisoes);
    if (motivo) throw new IntegracaoImportadoError('CONFLITO_AGENDA', motivo, 409);
  }

  if (decisoes.cadastro) await core.atualizarCliente(tx, p.cliente.id, empresaId, decisoes.cadastro, ctx);
  const { snapshot } = p.importacao;
  const totais = p.avaliacao.resumo.contrato.valorContratadoCentavos;
  const adicionais = snapshot.valores?.adicionais != null && snapshot.valores.adicionais < totais ? snapshot.valores.adicionais : 0;
  const idade = snapshot.evento?.idade;
  const aniversarianteId = p.avaliacao.resumo.festa.aniversarianteCadastro === 'EXISTENTE' ? p.aniversarianteExistente
    : p.avaliacao.resumo.festa.aniversarianteCadastro === 'NOVO'
      ? (await core.cadastrarAniversariante(tx, { clienteId: p.cliente.id, empresaId, nome: p.nomeAniversariante!, tema: snapshot.evento?.tema ?? null }, { usuarioId: ctx.usuarioId, origem: ORIGEM_INTEGRACAO, requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent })).id
      : null;
  const fechamento = await core.criarFechamento(tx, {
    clienteId: p.cliente.id, aniversarianteId,
    dataEvento: decisoes.evento.data, horarioInicio: decisoes.evento.horarioInicio, horarioFim: decisoes.evento.horarioFim,
    configuracaoAgendaId: p.configuracaoAgendaId, estabelecimentoId: decisoes.estabelecimentoId, pacoteId: p.pacote!.id, tabelaPrecoId: p.precoReferencia!.tabelaPrecoId, precoPacoteId: p.precoReferencia!.precoPacoteId,
    regraDescontoPacoteId: null, categoriaHorario: p.referencias.categoriaHorario!, categoriaPrecoAplicada: p.precoReferencia!.categoria,
    convidados: decisoes.evento.convidados, convidadosFaturados: decisoes.evento.convidados,
    // Valores do documento (não do catálogo): a linha de preço é só âncora exigida pelo Core.
    valorPacoteBase: centavosParaReais(totais - adicionais), descontoPercentual: 0, valorDescontoPacote: 0,
    valorPacoteAplicado: centavosParaReais(totais - adicionais), valorAdicionais: centavosParaReais(adicionais), valorTabela: centavosParaReais(totais),
    valorNegociado: null, valorAprovado: null, motivoNegociacao: null, observacoesNegociacao: null,
    status: 'CONFIRMADO', origemFechamento: 'IMPORTACAO_HISTORICA', iniciadoPorUsuarioId: ctx.usuarioId, usuarioResponsavelId: ctx.usuarioId,
    responsavelAdicionalId: null, idadeAniversarianteEvento: typeof idade === 'number' && idade >= 0 && idade <= 120 ? idade : null,
    temaFesta: snapshot.evento?.tema ?? null, formaPagamentoPretendida: decisoes.formaPagamento ?? null, alteracoesPacote: snapshot.pacote?.itens ?? null, observacoesCliente: snapshot.observacoes ?? null,
    observacoesEquipe: 'Contrato histórico importado (assinado em papel). Itens, valores e condições conforme o documento original.',
    buffetStatus: snapshot.buffet?.itens ? 'DEFINIDO' : 'PENDENTE', buffetOutros: [snapshot.buffet?.itens, snapshot.buffet?.observacoes, snapshot.buffet?.restricoes].filter(Boolean).join('\n') || null,
    // Não aplicar o desconto atual a um preço já contratado no documento. Parcelas históricas seguem no plano nativo.
    condicaoPagamento: null,
  });

  const unidade = decisoes.estabelecimentoId ? p.referencias.estabelecimentos.find((x) => x.id === decisoes.estabelecimentoId) ?? null : null;
  const snap = montarSnapshotVersao({
    nativo: await core.snapshotFechamento(tx, fechamento.id),
    importacaoId, documento: p.documento, fechamentoId: fechamento.id, snapshot, decisoes, resumo: p.avaliacao.resumo,
    cliente: p.cliente, aniversarianteId, pacote: p.pacote!, unidade, conferente: { usuarioId: ctx.usuarioId, papel: tenant.papelAtual! },
  });
  const contratoId = await repo.inserirContrato(tx, { fechamentoId: fechamento.id, usuarioId: ctx.usuarioId });
  const versaoId = await repo.inserirVersaoConferida(tx, { contratoId, snapshot: snap, snapshotHash: hashSnapshotContrato(snap), documentoSha256: p.documento.sha256, usuarioId: ctx.usuarioId });
  const correcoes = p.avaliacao.resumo.campos.filter((c) => c.origem !== 'DOCUMENTO');
  await repo.inserirEdicaoConcluida(tx, { contratoId, versaoId, usuarioId: ctx.usuarioId, dadosFonte: { origem: ORIGEM_INTEGRACAO, importacaoId, documentoSha256: p.documento.sha256 }, alteracoes: { correcoes } });
  await repo.inserirFluxoVigente(tx, contratoId, versaoId);
  const vinculo = await repo.inserirVinculo(tx, {
    empresaId, importacaoId, estabelecimentoId: decisoes.estabelecimentoId, clienteId: p.cliente.id, fechamentoId: fechamento.id, contratoId, versaoId,
    documento: p.documento, financeiroDeclarado: decisoes.financeiro.situacao === 'NAO_CONFERIDO' ? 'NAO_CONFERIDO' : 'CONFERIDO',
    decisoes: { decisoes, resumo: p.avaliacao.resumo, possiveisVinculos: p.vinculos }, declaracao: DECLARACAO_CONFERENCIA,
    chave: pedido.chave, payloadHash: resumoHash, usuarioId: ctx.usuarioId, papel: tenant.papelAtual!, requestId: ctx.requestId,
  });

  // Festa nasce da conferência (autoria do operador). Evento futuro revalida o destino com o lock do contrato.
  await tx.query('SELECT public.kidmais019_bloquear_contrato($1::uuid)', [contratoId]);
  if (ocupa) await tx.query('SELECT public.kidmais019_validar_destino($1::uuid)', [contratoId]);
  const causa = { origem: ORIGEM_INTEGRACAO, ator: 'USUARIO', importacaoId, contratoId, versaoId, requestId: ctx.requestId };
  const festaId = await repo.inserirFesta(tx, {
    contratoId, versaoId, chave: pedido.chave, payloadHash: hashCanonico(causa), usuarioId: ctx.usuarioId, requestId: ctx.requestId, causa,
    identidade: { usuarioId: ctx.usuarioId, papel: tenant.papelAtual, origem: ORIGEM_INTEGRACAO },
  });

  const base = { clienteId: p.cliente.id, atorTipo: 'USUARIO' as const, usuarioId: ctx.usuarioId, origem: ORIGEM_INTEGRACAO, requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent };
  await core.registrarAuditoria(tx, { ...base, acao: 'CONTRATO_HISTORICO_INTEGRADO', entidadeTipo: 'CONTRATO', entidadeId: contratoId,
    dadosDepois: { importacaoId, fechamentoId: fechamento.id, versaoId, festaId, agendaOcupada: ocupa, financeiro: decisoes.financeiro.situacao, correcoes, unidade: unidade?.id ?? null },
    justificativa: DECLARACAO_CONFERENCIA });
  await core.registrarAuditoria(tx, { ...base, acao: 'FESTA_CRIADA', entidadeTipo: 'FESTA', entidadeId: festaId, dadosDepois: causa, justificativa: 'Conferência de contrato histórico assinado em papel' });
  if (p.vinculos.length) {
    await core.registrarAuditoria(tx, { ...base, acao: 'POSSIVEL_DUPLICIDADE_DESCARTADA', entidadeTipo: 'CONTRATO', entidadeId: contratoId,
      dadosDepois: { importacaoId, candidatos: p.vinculos.map((v) => ({ fechamentoId: v.fechamentoId, contratoId: v.contratoId, data: v.data, alcance: v.alcance, sinais: v.sinais })) },
      justificativa: decisoes.motivoOutroContrato });
  }
  await core.registrarEventoHistorico(tx, { clienteId: p.cliente.id, tipoEvento: 'CONTRATO_HISTORICO_INTEGRADO', origem: ORIGEM_INTEGRACAO, entidadeTipo: 'CONTRATO', entidadeId: contratoId, usuarioId: ctx.usuarioId,
    detalhe: `Contrato importado integrado: festa em ${decisoes.evento.data} ${ocupa ? '(ocupa agenda)' : '(histórico)'}.`, metadata: { importacaoId, festaId }, critico: true });
  await core.registrarEventoHistorico(tx, { clienteId: p.cliente.id, tipoEvento: 'FESTA_CRIADA', origem: ORIGEM_INTEGRACAO, entidadeTipo: 'FESTA', entidadeId: festaId, usuarioId: ctx.usuarioId,
    detalhe: 'Festa criada pela integração do contrato histórico conferido.', metadata: causa });

  const resumoFin = p.avaliacao.resumo.financeiro;
  const financeiro = decisoes.financeiro.situacao === 'NAO_CONFERIDO' || resumoFin.situacao === 'NAO_CONFERIDO'
    ? { situacao: 'NAO_CONFERIDO' as const, pendente: true }
    : { ...await integrarFinanceiro(tx, tenant, ctx, core, {
      importacaoId, vinculoId: vinculo.id, versaoId, contratoId, clienteId: p.cliente.id,
      financeiro: decisoes.financeiro, resumo: resumoFin, chave: pedido.chave, payloadHash: resumoHash, dataFesta: decisoes.evento.data,
    }), pendente: false };

  return { reutilizado: false as const, contratoId, fechamentoId: fechamento.id, festaId, agendaOcupada: ocupa, financeiro, destino: `/admin/contratos?contratoId=${contratoId}` };
}

/**
 * Pendência "Conferir pagamentos": mesma regra da integração, com o valor contratado da versão conferida. Só enquanto
 * essa versão é a VIGENTE, sem revisão aberta e sem obrigação nativa já criada: depois de uma revisão do contrato o
 * valor pode ter mudado, e o financeiro segue o contrato (a 061 confere o mesmo no banco).
 */
async function prepararFinanceiro(tx: DbExecutor, tenant: TenantComprovado, importacaoId: string, bruto: unknown, hoje: string, travar: boolean) {
  const financeiro = financeiroSchema.parse(bruto);
  const empresaId = tenant.empresaComprovada;
  await importacaoConfirmada(tx, empresaId, importacaoId, travar);
  const vinculo = await repo.vinculoDaImportacao(tx, empresaId, importacaoId);
  if (!vinculo) throw new IntegracaoImportadoError('IMPORTACAO_NAO_INTEGRADA', 'Integre o contrato antes de conferir os pagamentos.', 409);
  const estado = (await tx.query<{ contrato_status: string; fechamento_status: string; valor: string; cliente_id: string; data_evento: string; vigente: boolean; revisao_aberta: boolean; com_pagamento: boolean }>(
    `SELECT c.status AS contrato_status, f.status AS fechamento_status, (v.snapshot->'comercial'->>'valorFinalContrato') AS valor, f.cliente_id::text,
            f.data_evento::text AS data_evento,
            coalesce(cf.versao_vigente_id = v.id, false) AS vigente,
            EXISTS(SELECT 1 FROM fechamento_revisoes r WHERE r.contrato_id = c.id AND r.estado IN ('EM_ELABORACAO', 'CONGELADA')) AS revisao_aberta,
            EXISTS(SELECT 1 FROM pagamentos p JOIN contrato_versoes pv ON pv.id = p.contrato_versao_id WHERE pv.contrato_id = c.id) AS com_pagamento
       FROM contratos c JOIN fechamentos f ON f.id = c.fechamento_id JOIN contrato_versoes v ON v.id = $2::uuid AND v.contrato_id = c.id
       LEFT JOIN contrato_fluxos cf ON cf.contrato_id = c.id
      WHERE c.id = $1::uuid AND f.empresa_id = $3::uuid${travar ? ' FOR UPDATE OF c, f' : ''}`,
    [vinculo.contratoId, vinculo.versaoId, empresaId],
  )).rows[0];
  if (!estado) throw new IntegracaoImportadoError('IMPORTACAO_NAO_ENCONTRADA', 'Contrato importado não encontrado.', 404);
  const contratado = Math.round(Number(estado.valor) * 100);
  const bloqueios: string[] = [], avisos: string[] = [];
  if (estado.contrato_status !== 'ASSINADO' || estado.fechamento_status !== 'CONFIRMADO') bloqueios.push('O contrato não está vigente: a conferência de pagamentos deve seguir o tratamento financeiro do contrato.');
  else if (estado.revisao_aberta) bloqueios.push('Há uma revisão do contrato em andamento: conclua ou cancele a revisão antes de registrar os pagamentos.');
  else if (!estado.vigente) bloqueios.push('O contrato foi revisado depois da integração: registre os pagamentos no Financeiro do contrato — "Criar plano financeiro" na versão vigente e "Registrar recebimento" com a data real de cada pagamento já feito.');
  else if (estado.com_pagamento) bloqueios.push('O contrato já tem obrigação financeira registrada: use o financeiro do contrato.');
  if (financeiro.situacao === 'NAO_CONFERIDO') bloqueios.push('Escolha a situação dos pagamentos conferidos.');
  const resumo = avaliarFinanceiro(financeiro, contratado, hoje, bloqueios, avisos);
  const recusaPlano = recusaDoPlanoNativo(financeiro, contratado, estado.data_evento);
  if (recusaPlano) bloqueios.push(recusaPlano);
  return { vinculo, financeiro, resumo, bloqueios, avisos, clienteId: estado.cliente_id, dataFesta: estado.data_evento, resumoHash: hashCanonico({ importacaoId, financeiro, resumo }) };
}

export async function simularFinanceiro(tx: DbExecutor, tenant: TenantComprovado, importacaoId: string, bruto: unknown, hoje: string) {
  exigirPapel(tenant);
  await exigirDisponivel(tx);
  const p = await prepararFinanceiro(tx, tenant, importacaoId, bruto, hoje, false);
  if (p.vinculo.financeiro) return { conferido: true as const, contratoId: p.vinculo.contratoId };
  return { conferido: false as const, pronto: p.bloqueios.length === 0, bloqueios: p.bloqueios, avisos: p.avisos, resumo: p.resumo, resumoHash: p.resumoHash };
}

export async function conferirFinanceiro(tx: DbExecutor, tenant: TenantComprovado, ctx: ContextoIntegracao, importacaoId: string, pedido: { financeiro: unknown; resumoHash: string; chave: string }, hoje: string, core: Core) {
  exigirPapel(tenant);
  await exigirDisponivel(tx);
  const p = await prepararFinanceiro(tx, tenant, importacaoId, pedido.financeiro, hoje, true);
  if (p.vinculo.financeiro) {
    if (repeticao(p.vinculo.financeiro, pedido)) {
      const gravado = await repo.resultadoGravado(tx, tenant.empresaComprovada, p.vinculo.id);
      return { reutilizado: true as const, contratoId: p.vinculo.contratoId, ...gravado!.financeiro };
    }
    throw new IntegracaoImportadoError('FINANCEIRO_JA_CONFERIDO', 'Os pagamentos deste contrato já foram conferidos. Use o financeiro do contrato para ajustes.', 409, { contratoId: p.vinculo.contratoId });
  }
  if (await repo.chaveUsadaEmOutra(tx, pedido.chave, importacaoId) || pedido.chave === p.vinculo.chave) throw new IntegracaoImportadoError('IDEMPOTENCIA_CONFLITANTE', 'Esta confirmação já foi usada para outra operação. Recarregue e confirme de novo.', 409);
  exigirAutenticacaoRecente(ctx);
  if (p.bloqueios.length) throw new IntegracaoImportadoError('INTEGRACAO_BLOQUEADA', p.bloqueios[0], 422, { bloqueios: p.bloqueios });
  if (p.resumoHash !== pedido.resumoHash) throw new IntegracaoImportadoError('RESUMO_DESATUALIZADO', 'Os dados mudaram desde a revisão. Confira o resumo atualizado e confirme de novo.', 409, { resumo: p.resumo, resumoHash: p.resumoHash });
  if (p.financeiro.situacao === 'NAO_CONFERIDO' || p.resumo.situacao === 'NAO_CONFERIDO') throw new IntegracaoImportadoError('INTEGRACAO_BLOQUEADA', 'Escolha a situação dos pagamentos conferidos.', 422);
  const r = await integrarFinanceiro(tx, tenant, ctx, core, {
    importacaoId, vinculoId: p.vinculo.id, versaoId: p.vinculo.versaoId, contratoId: p.vinculo.contratoId, clienteId: p.clienteId,
    financeiro: p.financeiro, resumo: p.resumo, chave: pedido.chave, payloadHash: p.resumoHash, dataFesta: p.dataFesta,
  });
  await core.registrarAuditoria(tx, { clienteId: p.clienteId, atorTipo: 'USUARIO', usuarioId: ctx.usuarioId, acao: 'PAGAMENTOS_HISTORICOS_CONFERIDOS', entidadeTipo: 'CONTRATO', entidadeId: p.vinculo.contratoId,
    dadosDepois: { importacaoId, ...r }, origem: ORIGEM_INTEGRACAO, requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent });
  return { reutilizado: false as const, contratoId: p.vinculo.contratoId, ...r };
}
