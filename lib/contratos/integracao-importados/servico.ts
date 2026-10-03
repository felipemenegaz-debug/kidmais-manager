import type { DbExecutor } from '../../db/contracts.ts';
import { FORMAS, type FormaFinanceira } from '../../financeiro/calculos.ts';
import type { TenantComprovado } from '../../saas/provar-tenant.ts';
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

export type ContextoIntegracao = { usuarioId: string; token: string; requestId: string; ip: string | null; userAgent: string | null };

type Auditoria = { clienteId?: string | null; atorTipo: 'USUARIO'; usuarioId: string; acao: string; entidadeTipo: string; entidadeId: string; dadosAntes?: Record<string, unknown> | null; dadosDepois?: Record<string, unknown> | null; justificativa?: string | null; origem: string; requestId?: string | null; ip?: string | null; userAgent?: string | null };
type Historico = { clienteId: string; tipoEvento: string; origem: string; entidadeTipo?: string | null; entidadeId?: string | null; usuarioId?: string | null; detalhe?: string | null; metadata?: Record<string, unknown>; critico?: boolean };

export type Core = {
  criarFechamento(tx: DbExecutor, input: Record<string, unknown>): Promise<{ id: string }>;
  registrarAuditoria(tx: DbExecutor, input: Auditoria): Promise<unknown>;
  registrarEventoHistorico(tx: DbExecutor, input: Historico): Promise<unknown>;
  criarPagamento(tx: DbExecutor, input: { contratoVersaoId: string; valorTotalContratado: number; criadoPorUsuarioId: string }): Promise<{ id: string }>;
  confirmarReserva(tx: DbExecutor, pagamentoId: string): Promise<unknown>;
  criarPlano(tx: DbExecutor, input: { pagamentoId: string; numeroVersao: number; meioPagamento: 'PIX' | 'CARTAO'; modalidade: 'AVISTA' | 'PARCELADO'; quantidadeParcelas: number; observacoes: string; criadoPorUsuarioId: string }): Promise<{ id: string }>;
  criarParcela(tx: DbExecutor, input: { planoId: string; numero: number; valorPrevisto: number; vencimento: string; confirmaReserva: boolean }): Promise<{ id: string }>;
  /** `registrarRecebimentoPagamento` nativo (sessão revalidada, alocação, estados, ledger e auditoria). */
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

async function preparar(tx: DbExecutor, tenant: TenantComprovado, importacaoId: string, decisoes: DecisoesIntegracao, hoje: string, travar: boolean) {
  const empresaId = tenant.empresaComprovada;
  const importacao = await importacaoConfirmada(tx, empresaId, importacaoId, travar);
  const cliente = await repo.clienteDaEmpresa(tx, empresaId, importacao.clienteId, travar);
  if (!cliente) throw new IntegracaoImportadoError('IMPORTACAO_NAO_ENCONTRADA', 'Contrato importado não encontrado.', 404);
  const documento = await repo.documentoOriginal(tx, empresaId, importacao.documentoId);
  if (!documento) throw new IntegracaoImportadoError('DOCUMENTO_ORIGINAL_AUSENTE', 'O documento original desta importação não foi encontrado. Ele é obrigatório para a conferência.', 409);
  const estabelecimentos = await repo.estabelecimentosAtivos(tx, empresaId);
  const pacote = decisoes.pacoteReferenciaId ? await repo.pacoteDaEmpresa(tx, empresaId, decisoes.pacoteReferenciaId) : null;
  const precoReferencia = pacote ? await repo.precoReferencia(tx, empresaId, pacote.id, decisoes.evento.data, decisoes.evento.convidados) : null;
  const configuracaoAgendaId = await repo.configuracaoAgenda(tx, decisoes.evento.horarioInicio, empresaId, decisoes.estabelecimentoId);
  const referencias: Referencias = {
    cliente: { id: cliente.id, nome: cliente.nomeCompleto, status: cliente.status },
    estabelecimentos, pacote, precoReferencia, configuracaoAgendaId,
  };
  const avaliacao = avaliarIntegracao({ snapshot: importacao.snapshot, decisoes, referencias, hoje });
  // Aniversariante do documento: vinculado ao cadastro do cliente (mesmo nome) ou criado nele. As revisões nativas
  // do contrato reconstroem o snapshot a partir do fechamento e exigem aniversariante vinculado.
  const nomeAniversariante = importacao.snapshot.evento?.aniversariante?.trim() || null;
  const aniversarianteExistente = nomeAniversariante && nomeAniversariante.length >= 2 ? await repo.aniversarianteDoCliente(tx, cliente.id, nomeAniversariante) : null;
  avaliacao.resumo.festa.aniversarianteCadastro = !nomeAniversariante || nomeAniversariante.length < 2 ? null : aniversarianteExistente ? 'EXISTENTE' : 'NOVO';
  if (avaliacao.resumo.festa.aniversarianteCadastro === null) avaliacao.avisos.push('O documento não traz o nome do aniversariante: a festa fica sem aniversariante vinculado. Revisões futuras do contrato pedirão esse cadastro.');
  const vinculos = await repo.possiveisVinculos(tx, empresaId, cliente.id, decisoes.evento.data);
  if (vinculos.length && !decisoes.outroContratoConfirmado) {
    avaliacao.bloqueios.push(`${cliente.nomeCompleto} já tem ${vinculos.length === 1 ? 'uma contratação' : `${vinculos.length} contratações`} neste dia. Confira se é o mesmo contrato; se for outro, confirme "É outro contrato".`);
  }
  return { empresaId, importacao, cliente, documento, referencias, avaliacao, vinculos, pacote, precoReferencia, configuracaoAgendaId, nomeAniversariante, aniversarianteExistente };
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
    integracao: vinculo ? { contratoId: vinculo.contratoId, financeiroPendente: vinculo.financeiro === null, valorContratadoCentavos: vinculo.valorContratadoCentavos } : null,
    cliente: cliente ? { id: cliente.id, nome: cliente.nomeCompleto, ativo: cliente.status === 'ATIVO' } : null,
    documento: {
      pacote: importacao.snapshot.pacote?.nome ?? null,
      aniversariante: importacao.snapshot.evento?.aniversariante ?? null,
      tema: importacao.snapshot.evento?.tema ?? null,
    },
    sugestao: sugestaoInicial(importacao.snapshot),
    estabelecimentos: disponivel ? await repo.estabelecimentosAtivos(tx, empresaId) : [],
    pacotes: disponivel ? await repo.pacotesDaEmpresa(tx, empresaId) : [],
    formas: FORMAS,
    declaracao: DECLARACAO_CONFERENCIA,
  };
}

export async function simularIntegracao(tx: DbExecutor, tenant: TenantComprovado, importacaoId: string, bruto: unknown, hoje: string) {
  exigirPapel(tenant);
  await exigirDisponivel(tx);
  const decisoes = decisoesSchema.parse(bruto);
  const vinculo = await repo.vinculoDaImportacao(tx, tenant.empresaComprovada, importacaoId);
  if (vinculo) return { integrada: true as const, contratoId: vinculo.contratoId };
  const p = await preparar(tx, tenant, importacaoId, decisoes, hoje, false);
  const motivoConflito = await conflito(tx, p, decisoes);
  if (motivoConflito) p.avaliacao.bloqueios.push(motivoConflito);
  if (!decisoes.conferenciaDeclarada) p.avaliacao.avisos.push('Para confirmar, declare a conferência do documento original.');
  return {
    integrada: false as const,
    pronto: p.avaliacao.bloqueios.length === 0,
    bloqueios: p.avaliacao.bloqueios,
    avisos: p.avaliacao.avisos,
    resumo: p.avaliacao.resumo,
    resumoHash: hashResumo(importacaoId, decisoes, p.avaliacao.resumo),
    possiveisVinculos: p.vinculos,
  };
}

function meioDoPlano(f: Extract<DecisoesFinanceiras, { parcelas: unknown }>): 'PIX' | 'CARTAO' {
  const formas = f.parcelas.map((p) => p.recebimento?.forma).filter((x): x is FormaFinanceira => !!x);
  return formas.length > 0 && formas.every((x) => x === 'CARTAO_CREDITO' || x === 'CARTAO_DEBITO') ? 'CARTAO' : 'PIX';
}

/** Obrigação, plano, parcelas e recebimentos nos serviços nativos. Chaves determinísticas: repetir não duplica. */
async function integrarFinanceiro(tx: DbExecutor, tenant: TenantComprovado, ctx: ContextoIntegracao, core: Core, e: {
  importacaoId: string; vinculoId: string; versaoId: string; contratoId: string; clienteId: string;
  financeiro: Extract<DecisoesFinanceiras, { parcelas: unknown }>; resumo: Extract<ResumoFinanceiro, { recebidoCentavos: number }>;
  chave: string; payloadHash: string;
}) {
  const empresaId = tenant.empresaComprovada;
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

export async function confirmarIntegracao(tx: DbExecutor, tenant: TenantComprovado, ctx: ContextoIntegracao, importacaoId: string, pedido: PedidoConfirmacao, hoje: string, core: Core) {
  exigirPapel(tenant);
  await exigirDisponivel(tx);
  const decisoes = decisoesSchema.parse(pedido.decisoes);
  const empresaId = tenant.empresaComprovada;
  // Lock da importação primeiro: duas confirmações da mesma importação se enfileiram aqui.
  await importacaoConfirmada(tx, empresaId, importacaoId, true);
  const existente = await repo.vinculoDaImportacao(tx, empresaId, importacaoId);
  if (existente) {
    // Mesma chave (repetição após timeout) ou mesmo conteúdo confirmado: devolve o resultado gravado, sem escrever nada.
    if (existente.chave === pedido.chave || existente.payloadHash === pedido.resumoHash) {
      const gravado = await repo.resultadoGravado(tx, empresaId, existente.id);
      return { reutilizado: true as const, ...gravado!, destino: `/admin/contratos?contratoId=${existente.contratoId}` };
    }
    throw new IntegracaoImportadoError('IMPORTACAO_JA_INTEGRADA', 'Este contrato importado já foi integrado. Abra o contrato integrado.', 409, { contratoId: existente.contratoId });
  }
  if (await repo.chaveUsadaEmOutra(tx, pedido.chave, importacaoId)) throw new IntegracaoImportadoError('IDEMPOTENCIA_CONFLITANTE', 'Esta confirmação já foi usada para outra operação. Recarregue e confirme de novo.', 409);

  const p = await preparar(tx, tenant, importacaoId, decisoes, hoje, true);
  if (!decisoes.conferenciaDeclarada) p.avaliacao.bloqueios.push('Declare a conferência do documento original antes de confirmar.');
  if (p.avaliacao.bloqueios.length) throw new IntegracaoImportadoError('INTEGRACAO_BLOQUEADA', p.avaliacao.bloqueios[0], 422, { bloqueios: p.avaliacao.bloqueios });
  const resumoHash = hashResumo(importacaoId, decisoes, p.avaliacao.resumo);
  if (resumoHash !== pedido.resumoHash) {
    throw new IntegracaoImportadoError('RESUMO_DESATUALIZADO', 'Os dados mudaram desde a revisão. Confira o resumo atualizado e confirme de novo.', 409, { resumo: p.avaliacao.resumo, resumoHash });
  }
  const ocupa = p.avaliacao.resumo.agenda.ocupa;
  if (ocupa) {
    // Lock da data no namespace do Core e revalidação depois dele (READ COMMITTED vê o último vencedor).
    await repo.travarData(tx, decisoes.evento.data);
    const motivo = await conflito(tx, p, decisoes);
    if (motivo) throw new IntegracaoImportadoError('CONFLITO_AGENDA', motivo, 409);
  }

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
    regraDescontoPacoteId: null, categoriaHorario: p.precoReferencia!.categoria, categoriaPrecoAplicada: p.precoReferencia!.categoria,
    convidados: decisoes.evento.convidados, convidadosFaturados: decisoes.evento.convidados,
    // Valores do documento (não do catálogo): a linha de preço é só âncora exigida pelo Core.
    valorPacoteBase: centavosParaReais(totais - adicionais), descontoPercentual: 0, valorDescontoPacote: 0,
    valorPacoteAplicado: centavosParaReais(totais - adicionais), valorAdicionais: centavosParaReais(adicionais), valorTabela: centavosParaReais(totais),
    valorNegociado: null, valorAprovado: null, motivoNegociacao: null, observacoesNegociacao: null,
    status: 'CONFIRMADO', origemFechamento: 'IMPORTACAO_HISTORICA', iniciadoPorUsuarioId: ctx.usuarioId, usuarioResponsavelId: ctx.usuarioId,
    responsavelAdicionalId: null, idadeAniversarianteEvento: typeof idade === 'number' && idade >= 0 && idade <= 120 ? idade : null,
    temaFesta: snapshot.evento?.tema ?? null, formaPagamentoPretendida: null, alteracoesPacote: null, observacoesCliente: null,
    observacoesEquipe: 'Contrato histórico importado (assinado em papel). Itens, valores e condições conforme o documento original.',
    buffetStatus: 'PENDENTE', condicaoPagamento: null,
  });

  const unidade = decisoes.estabelecimentoId ? p.referencias.estabelecimentos.find((x) => x.id === decisoes.estabelecimentoId) ?? null : null;
  const snap = montarSnapshotVersao({
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
  await core.registrarEventoHistorico(tx, { clienteId: p.cliente.id, tipoEvento: 'CONTRATO_HISTORICO_INTEGRADO', origem: ORIGEM_INTEGRACAO, entidadeTipo: 'CONTRATO', entidadeId: contratoId, usuarioId: ctx.usuarioId,
    detalhe: `Contrato importado integrado: festa em ${decisoes.evento.data} ${ocupa ? '(ocupa agenda)' : '(histórico)'}.`, metadata: { importacaoId, festaId }, critico: true });
  await core.registrarEventoHistorico(tx, { clienteId: p.cliente.id, tipoEvento: 'FESTA_CRIADA', origem: ORIGEM_INTEGRACAO, entidadeTipo: 'FESTA', entidadeId: festaId, usuarioId: ctx.usuarioId,
    detalhe: 'Festa criada pela integração do contrato histórico conferido.', metadata: causa });

  const resumoFin = p.avaliacao.resumo.financeiro;
  const financeiro = decisoes.financeiro.situacao === 'NAO_CONFERIDO' || resumoFin.situacao === 'NAO_CONFERIDO'
    ? { situacao: 'NAO_CONFERIDO' as const, pendente: true }
    : { ...await integrarFinanceiro(tx, tenant, ctx, core, {
      importacaoId, vinculoId: vinculo.id, versaoId, contratoId, clienteId: p.cliente.id,
      financeiro: decisoes.financeiro, resumo: resumoFin, chave: pedido.chave, payloadHash: resumoHash,
    }), pendente: false };

  return { reutilizado: false as const, contratoId, fechamentoId: fechamento.id, festaId, agendaOcupada: ocupa, financeiro, destino: `/admin/contratos?contratoId=${contratoId}` };
}

/** Pendência "Conferir pagamentos": mesma regra da integração, com o valor contratado da versão conferida (imutável aqui). */
async function prepararFinanceiro(tx: DbExecutor, tenant: TenantComprovado, importacaoId: string, bruto: unknown, hoje: string, travar: boolean) {
  const financeiro = financeiroSchema.parse(bruto);
  const empresaId = tenant.empresaComprovada;
  await importacaoConfirmada(tx, empresaId, importacaoId, travar);
  const vinculo = await repo.vinculoDaImportacao(tx, empresaId, importacaoId);
  if (!vinculo) throw new IntegracaoImportadoError('IMPORTACAO_NAO_INTEGRADA', 'Integre o contrato antes de conferir os pagamentos.', 409);
  const estado = (await tx.query<{ contrato_status: string; fechamento_status: string; valor: string; cliente_id: string }>(
    `SELECT c.status AS contrato_status, f.status AS fechamento_status, (v.snapshot->'comercial'->>'valorFinalContrato') AS valor, f.cliente_id::text
       FROM contratos c JOIN fechamentos f ON f.id = c.fechamento_id JOIN contrato_versoes v ON v.id = $2::uuid
      WHERE c.id = $1::uuid AND f.empresa_id = $3::uuid${travar ? ' FOR UPDATE OF c, f' : ''}`,
    [vinculo.contratoId, vinculo.versaoId, empresaId],
  )).rows[0];
  if (!estado) throw new IntegracaoImportadoError('IMPORTACAO_NAO_ENCONTRADA', 'Contrato importado não encontrado.', 404);
  const contratado = Math.round(Number(estado.valor) * 100);
  const bloqueios: string[] = [], avisos: string[] = [];
  if (estado.contrato_status !== 'ASSINADO' || estado.fechamento_status !== 'CONFIRMADO') bloqueios.push('O contrato não está vigente: a conferência de pagamentos deve seguir o tratamento financeiro do contrato.');
  if (financeiro.situacao === 'NAO_CONFERIDO') bloqueios.push('Escolha a situação dos pagamentos conferidos.');
  const resumo = avaliarFinanceiro(financeiro, contratado, hoje, bloqueios, avisos);
  return { vinculo, financeiro, resumo, bloqueios, avisos, clienteId: estado.cliente_id, resumoHash: hashCanonico({ importacaoId, financeiro, resumo }) };
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
    if (p.vinculo.financeiro.chave === pedido.chave || p.vinculo.financeiro.payloadHash === pedido.resumoHash) {
      const gravado = await repo.resultadoGravado(tx, tenant.empresaComprovada, p.vinculo.id);
      return { reutilizado: true as const, contratoId: p.vinculo.contratoId, ...gravado!.financeiro };
    }
    throw new IntegracaoImportadoError('FINANCEIRO_JA_CONFERIDO', 'Os pagamentos deste contrato já foram conferidos. Use o financeiro do contrato para ajustes.', 409, { contratoId: p.vinculo.contratoId });
  }
  if (await repo.chaveUsadaEmOutra(tx, pedido.chave, importacaoId) || pedido.chave === p.vinculo.chave) throw new IntegracaoImportadoError('IDEMPOTENCIA_CONFLITANTE', 'Esta confirmação já foi usada para outra operação. Recarregue e confirme de novo.', 409);
  if (p.bloqueios.length) throw new IntegracaoImportadoError('INTEGRACAO_BLOQUEADA', p.bloqueios[0], 422, { bloqueios: p.bloqueios });
  if (p.resumoHash !== pedido.resumoHash) throw new IntegracaoImportadoError('RESUMO_DESATUALIZADO', 'Os dados mudaram desde a revisão. Confira o resumo atualizado e confirme de novo.', 409, { resumo: p.resumo, resumoHash: p.resumoHash });
  if (p.financeiro.situacao === 'NAO_CONFERIDO' || p.resumo.situacao === 'NAO_CONFERIDO') throw new IntegracaoImportadoError('INTEGRACAO_BLOQUEADA', 'Escolha a situação dos pagamentos conferidos.', 422);
  const r = await integrarFinanceiro(tx, tenant, ctx, core, {
    importacaoId, vinculoId: p.vinculo.id, versaoId: p.vinculo.versaoId, contratoId: p.vinculo.contratoId, clienteId: p.clienteId,
    financeiro: p.financeiro, resumo: p.resumo, chave: pedido.chave, payloadHash: p.resumoHash,
  });
  await core.registrarAuditoria(tx, { clienteId: p.clienteId, atorTipo: 'USUARIO', usuarioId: ctx.usuarioId, acao: 'PAGAMENTOS_HISTORICOS_CONFERIDOS', entidadeTipo: 'CONTRATO', entidadeId: p.vinculo.contratoId,
    dadosDepois: { importacaoId, ...r }, origem: ORIGEM_INTEGRACAO, requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent });
  return { reutilizado: false as const, contratoId: p.vinculo.contratoId, ...r };
}
