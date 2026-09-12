import { revisaoAbertaDoFechamento, bloquearDatasRevisao, revalidarAgendaRevisao } from '../../fechamentos/services/revisao-operacional.service';
import type { DbExecutor } from "../../db/contracts";
import { hashSnapshotContrato } from '../../contratos/services/snapshot-core';
import { db, withTransaction } from "../../db/postgres";
import { posicaoDoPagamento, possuiCronograma, validarCapacidadeConsolidada, eventoMovimento, validarEstornoComDevolucoes, consolidarCronogramaDoEstorno } from './movimentos-consolidados';
import {
  registrarAuditoria,
  registrarEventoHistorico,
} from "../../clientes/repositories";
import {
  buscarContratoPorFechamentoId,
  buscarContratoPorId,
  buscarVersaoCorrente,
  buscarVersaoPorId,
} from "../../contratos/repositories";
import {
  buscarFechamentoPorIdParaAtualizacao,
  marcarFechamentoAguardandoPagamento,
  marcarFechamentoConfirmado,
} from "../../fechamentos/repositories";
import {
  adquirirLockConfirmacaoAgenda,
  verificarConflitoAgendaParaConfirmacao,
} from "../../disponibilidade/repositories";
import {
  atualizarStatusPagamento,
  atualizarStatusParcela,
  buscarPagamentoPorContratoVersaoId,
  buscarPagamentoPorFechamentoId,
  buscarPagamentoPorId,
  buscarParcelaPorId,
  buscarPlanoAtivo,
  buscarRecebimentoPorId,
  buscarRecebimentoPorIdempotencia,
  buscarEstornoPorIdempotencia,
  cancelarParcelasPendentesDoPlano,
  criarComprovantePagamento,
  criarEstorno,
  criarPagamento,
  criarParcelaPagamento,
  criarPlanoPagamento,
  criarRecebimento,
  criarRecebimentoAlocacao,
  existeRecebimentoPagamento,
  buscarRecebimentoPorReferencia,
  buscarEstornoPorReferencia,
  buscarComprovantePorHash,
  valorEstornosComprometidos,
  listarAlocacoesRecebimento,
  listarParcelasPlano,
  marcarEstornoConfirmado,
  marcarRecebimentoStatus,
  marcarReservaPagamento,
  resumoMovimentosPagamento,
  resumoMovimentosParcelas,
  substituirPlanoAtivo,
  valorAlocadoConfirmadoRecebimentoParcela,
  type EstornoRecord,
  type PagamentoRecord,
  type ParcelaPagamentoRecord,
  type RecebimentoRecord,
} from "../repositories";
import {
  centavosParaDinheiro,
  saldoMonetario,
  dinheiroParaCentavos,
  statusPagamentoPorLiquido,
  statusParcelaPorLiquido,
  validarPlanoPagamento,
} from "./financeiro-core";
import { PagamentoServiceError } from "./errors";
import { validarRepeticaoEstorno, validarRepeticaoRecebimento } from "./idempotencia";
import type {
  CriarPagamentoInput,
  PagamentoDetalhe,
  PagamentoServiceContext,
  PlanoPagamentoInput,
  RegistrarEstornoInput,
  RegistrarEstornoResult,
  RegistrarRecebimentoInput,
  RegistrarRecebimentoResult,
} from "./models";

function hojeBrasilia() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function valorContratoDaVersao(snapshot: { comercial?: { valorFinalContrato?: unknown } }) {
  const raw = snapshot.comercial?.valorFinalContrato;
  const valor = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new PagamentoServiceError(
      "VALOR_CONTRATUAL_INVALIDO",
      "A versão contratual assinada não possui um valor financeiro válido.",
      409,
    );
  }
  dinheiroParaCentavos(valor, "valorFinalContrato");
  return valor;
}

async function criarPlanoEParcelas(
  pagamento: PagamentoRecord,
  numeroVersao: number,
  input: PlanoPagamentoInput,
  context: PagamentoServiceContext,
  tx: DbExecutor,
) {
  const validado = validarPlanoPagamento(pagamento.valorTotalContratado, input);
  const plano = await criarPlanoPagamento(
    {
      pagamentoId: pagamento.id,
      numeroVersao,
      meioPagamento: validado.meioPagamento,
      modalidade: validado.modalidade,
      quantidadeParcelas: validado.quantidadeParcelas,
      provedorPreferido: validado.provedorPreferido,
      observacoes: validado.observacoes,
      criadoPorUsuarioId: context.usuarioId ?? null,
    },
    tx,
  );

  const parcelas: ParcelaPagamentoRecord[] = [];
  for (const item of validado.parcelas) {
    parcelas.push(
      await criarParcelaPagamento(
        {
          planoId: plano.id,
          numero: item.numero,
          valorPrevisto: item.valor,
          vencimento: item.vencimento,
          confirmaReserva: item.confirmaReserva,
        },
        tx,
      ),
    );
  }
  return { plano, parcelas };
}

async function detalhePagamento(
  pagamento: PagamentoRecord,
  tx?: DbExecutor,
): Promise<PagamentoDetalhe> {
  const plano = await buscarPlanoAtivo(pagamento.id, tx);
  if (!plano) {
    throw new PagamentoServiceError(
      "PLANO_NAO_ENCONTRADO",
      "Pagamento encontrado sem plano ativo.",
      409,
    );
  }

  // Evita consultas concorrentes no mesmo pg.Client quando detalhePagamento
  // roda dentro de uma transacao. O node-postgres descontinuou esse uso e
  // passara a rejeita-lo no pg 9.
  const parcelas = await listarParcelasPlano(plano.id, tx);
  const movimentosParcelas = await resumoMovimentosParcelas(plano.id, tx);
  const movimentosPagamento = await resumoMovimentosPagamento(pagamento.id, tx);
  const porParcela = new Map(movimentosParcelas.map((item) => [item.parcelaId, item]));
  const hoje = hojeBrasilia();
  const recebidoLiquido = saldoMonetario(movimentosPagamento.recebidoConfirmado, movimentosPagamento.estornadoConfirmado);

  if (await possuiCronograma(tx ?? db(), pagamento.id)) {
    const p = await posicaoDoPagamento(tx ?? db(), pagamento.id);
    const consolidado: PagamentoDetalhe['parcelas'] = [];
    for (const item of p.futuro) {
      const parcela = await buscarParcelaPorId(item.parcelaId, tx);
      if (!parcela) throw new PagamentoServiceError('PARCELA_NAO_ENCONTRADA', 'Item sem parcela.', 409);
      const movimento = p.parcelas.find(pp => pp.id === parcela.id)!;
      const saldo = Number(item.valorCentavos) / 100;
      consolidado.push({ ...parcela, recebidoConfirmado: Number(movimento.recebido), estornadoConfirmado: Number(movimento.estornado), valorLiquidoRecebido: Number(movimento.recebido) - Number(movimento.estornado), saldo, vencida: saldo > 0 && parcela.vencimento < hoje });
    }
    return { pagamento, plano, parcelas: consolidado, cronogramaId: p.cronograma!.id, fonteProgramacao: 'CRONOGRAMA_CONSOLIDADO', creditoCentavos: p.posicao.credito.toString(), totais: { valorContratado: Number(p.posicao.obrigacao) / 100, recebidoConfirmado: Number(p.posicao.recebido) / 100, estornadoConfirmado: Number(p.posicao.estornado) / 100, recebidoLiquido: Number(p.posicao.liquido) / 100, saldo: Number(p.posicao.saldo) / 100 } };
  }

  return {
    pagamento,
    plano,
    parcelas: parcelas.map((parcela) => {
      const movimento = porParcela.get(parcela.id) ?? {
        recebidoConfirmado: 0,
        estornadoConfirmado: 0,
      };
      const liquido = saldoMonetario(movimento.recebidoConfirmado, movimento.estornadoConfirmado);
      return {
        ...parcela,
        recebidoConfirmado: movimento.recebidoConfirmado,
        estornadoConfirmado: movimento.estornadoConfirmado,
        valorLiquidoRecebido: liquido,
        saldo: saldoMonetario(parcela.valorPrevisto, liquido),
        vencida:
          parcela.status !== "PAGA" &&
          parcela.status !== "CANCELADA" &&
          parcela.vencimento < hoje,
      };
    }),
    totais: {
      valorContratado: pagamento.valorTotalContratado,
      recebidoConfirmado: movimentosPagamento.recebidoConfirmado,
      estornadoConfirmado: movimentosPagamento.estornadoConfirmado,
      recebidoLiquido,
      saldo: saldoMonetario(pagamento.valorTotalContratado, recebidoLiquido),
    },
  };
}

function planoEquivale(
  detalhe: PagamentoDetalhe,
  input: PlanoPagamentoInput,
) {
  const validado = validarPlanoPagamento(detalhe.pagamento.valorTotalContratado, input);
  if (
    detalhe.plano.meioPagamento !== validado.meioPagamento ||
    detalhe.plano.modalidade !== validado.modalidade ||
    detalhe.plano.provedorPreferido !== validado.provedorPreferido ||
    detalhe.plano.observacoes !== validado.observacoes ||
    detalhe.plano.quantidadeParcelas !== validado.quantidadeParcelas ||
    detalhe.parcelas.length !== validado.parcelas.length
  ) return false;

  return detalhe.parcelas.every((parcela, index) => {
    const recebido = validado.parcelas[index];
    return recebido != null &&
      parcela.numero === recebido.numero &&
      dinheiroParaCentavos(parcela.valorPrevisto) === dinheiroParaCentavos(recebido.valor) &&
      parcela.vencimento === recebido.vencimento &&
      parcela.confirmaReserva === recebido.confirmaReserva;
  });
}

export async function criarPagamentoDoFechamento(
  input: CriarPagamentoInput,
  context: PagamentoServiceContext,
): Promise<{ detalhe: PagamentoDetalhe; reutilizado: boolean }> {
  return withTransaction(async (tx) => {
    // Assinatura trava Contrato antes de Fechamento. Rejeita o contrato ainda
    // não assinado antes de segurar Fechamento, evitando disputar esses locks
    // em ordem inversa com uma assinatura em andamento. Revalida abaixo.
    const contratoAntesDoLock = await buscarContratoPorFechamentoId(input.fechamentoId, tx);
    if (contratoAntesDoLock && contratoAntesDoLock.status !== "ASSINADO") {
      throw new PagamentoServiceError("CONTRATO_NAO_ASSINADO", "O Pagamento só pode ser criado para Contrato assinado.", 409);
    }
    const fechamento = await buscarFechamentoPorIdParaAtualizacao(input.fechamentoId, tx);
    if (!fechamento) {
      throw new PagamentoServiceError(
        "FECHAMENTO_NAO_ENCONTRADO",
        "Fechamento não encontrado.",
        404,
      );
    }

    const contrato = await buscarContratoPorFechamentoId(fechamento.id, tx, { forUpdate: true });
    if (!contrato) {
      throw new PagamentoServiceError(
        "CONTRATO_NAO_ENCONTRADO",
        "O Fechamento não possui Contrato.",
        409,
      );
    }
    if (contrato.status !== "ASSINADO") {
      throw new PagamentoServiceError(
        "CONTRATO_NAO_ASSINADO",
        "O Pagamento só pode ser criado para Contrato assinado.",
        409,
        { contratoStatus: contrato.status },
      );
    }

    const versao = await buscarVersaoCorrente(contrato.id, tx, { forUpdate: true });
    if (!versao || versao.status !== "ASSINADA" || !versao.assinadoEm || versao.numeroVersao !== contrato.versaoAtual || versao.contratoId !== contrato.id || hashSnapshotContrato(versao.snapshot) !== versao.snapshotHash) {
      throw new PagamentoServiceError(
        "VERSAO_CONTRATUAL_NAO_ASSINADA",
        "A versão contratual corrente não está assinada.",
        409,
      );
    }

    const existente = await buscarPagamentoPorContratoVersaoId(versao.id, tx, { forUpdate: true });
    const obrigacaoAnterior = await buscarPagamentoPorFechamentoId(fechamento.id, tx);
    if (obrigacaoAnterior && obrigacaoAnterior.contratoVersaoId !== versao.id) {
      throw new PagamentoServiceError('PAGAMENTO_JA_EXISTE','Este contrato já possui obrigação financeira em outra versão. Trate a pendência explicitamente.',409,{pagamentoId:obrigacaoAnterior.id});
    }
    if (existente) {
      const detalhe = await detalhePagamento(existente, tx);
      if (!planoEquivale(detalhe, input.plano)) {
        throw new PagamentoServiceError(
          "PAGAMENTO_JA_EXISTE",
          "Já existe Pagamento para esta versão contratual. Use a substituição de plano para alterar a condição financeira.",
          409,
          { pagamentoId: existente.id },
        );
      }
      return { detalhe, reutilizado: true };
    }

    if (fechamento.status !== "CONTRATO_ASSINADO") {
      throw new PagamentoServiceError(
        "STATUS_FECHAMENTO_NAO_PERMITE_PAGAMENTO",
        "O Pagamento só pode ser iniciado quando o Fechamento está com contrato assinado.",
        409,
        { statusAtual: fechamento.status },
      );
    }

    const valorTotal = valorContratoDaVersao(versao.snapshot);
    const pagamento = await criarPagamento(
      {
        contratoVersaoId: versao.id,
        valorTotalContratado: valorTotal,
        criadoPorUsuarioId: context.usuarioId ?? null,
      },
      tx,
    );
    await criarPlanoEParcelas(pagamento, 1, input.plano, context, tx);

    const fechamentoAtualizado = await marcarFechamentoAguardandoPagamento(fechamento.id, tx);
    if (!fechamentoAtualizado) {
      throw new PagamentoServiceError(
        "STATUS_FECHAMENTO_NAO_PERMITE_PAGAMENTO",
        "O Fechamento não pôde avançar para AGUARDANDO_PAGAMENTO.",
        409,
      );
    }

    if (fechamento.clienteId) {
      await registrarEventoHistorico(
        {
          clienteId: fechamento.clienteId,
          tipoEvento: "PAGAMENTO_CRIADO",
          origem: context.origem,
          entidadeTipo: "PAGAMENTO",
          entidadeId: pagamento.id,
          usuarioId: context.usuarioId ?? null,
          detalhe: "Obrigação financeira criada a partir do Contrato assinado.",
          metadata: {
            fechamentoId: fechamento.id,
            contratoId: contrato.id,
            contratoVersaoId: versao.id,
            valorTotalContratado: valorTotal,
          },
          critico: true,
        },
        tx,
      );
    }

    await registrarAuditoria(
      {
        clienteId: fechamento.clienteId,
        atorTipo: context.usuarioId ? "USUARIO" : "SISTEMA",
        usuarioId: context.usuarioId ?? null,
        acao: "PAGAMENTO_CRIADO",
        entidadeTipo: "PAGAMENTO",
        entidadeId: pagamento.id,
        dadosAntes: { fechamentoStatus: fechamento.status },
        dadosDepois: {
          fechamentoStatus: fechamentoAtualizado.status,
          contratoVersaoId: versao.id,
          valorTotalContratado: valorTotal,
        },
        origem: context.origem,
        requestId: context.requestId ?? null,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
      tx,
    );

    return { detalhe: await detalhePagamento(pagamento, tx), reutilizado: false };
  });
}

export async function obterPagamentoPorFechamento(fechamentoId: string) {
  const pagamento = await buscarPagamentoPorFechamentoId(fechamentoId);
  if (!pagamento) {
    throw new PagamentoServiceError(
      "PAGAMENTO_NAO_ENCONTRADO",
      "Pagamento ainda não criado para este Fechamento.",
      404,
    );
  }
  return detalhePagamento(pagamento);
}

async function contextoDoPagamento(pagamento: PagamentoRecord, tx: DbExecutor) {
  const versao = await buscarVersaoPorId(pagamento.contratoVersaoId, tx);
  if (!versao) throw new PagamentoServiceError("VERSAO_CONTRATUAL_NAO_ASSINADA", "Versão contratual não encontrada.", 409);
  const contrato = await buscarContratoPorId(versao.contratoId, tx);
  if (!contrato) throw new PagamentoServiceError("CONTRATO_NAO_ENCONTRADO", "Contrato não encontrado.", 409);
  const fechamento = await buscarFechamentoPorIdParaAtualizacao(contrato.fechamentoId, tx);
  if (!fechamento) throw new PagamentoServiceError("FECHAMENTO_NAO_ENCONTRADO", "Fechamento não encontrado.", 409);
  return { versao, contrato, fechamento };
}

async function bloquearPagamento(pagamentoId: string, tx: DbExecutor) {
  const origem = await buscarPagamentoPorId(pagamentoId, tx);
  if (!origem) throw new PagamentoServiceError("PAGAMENTO_NAO_ENCONTRADO", "Pagamento não encontrado.", 404);
  // Compartilha a ordem usada por criação de pagamento/contrato: Fechamento → Pagamento.
  const contexto=await contextoDoPagamento(origem, tx);
  await revisaoAbertaDoFechamento(contexto.fechamento.id,tx,true);
  const pagamento = await buscarPagamentoPorId(pagamentoId, tx, { forUpdate: true });
  if (!pagamento) throw new PagamentoServiceError("PAGAMENTO_NAO_ENCONTRADO", "Pagamento não encontrado.", 404);
  return pagamento;
}

async function validarContextoRecebimento(pagamento: PagamentoRecord, tx: DbExecutor) {
  const { versao, contrato, fechamento } = await contextoDoPagamento(pagamento, tx);
  if (contrato.status !== "ASSINADO" || versao.status !== "ASSINADA" || !versao.assinadoEm || versao.id !== pagamento.contratoVersaoId || versao.contratoId !== contrato.id || hashSnapshotContrato(versao.snapshot) !== versao.snapshotHash || dinheiroParaCentavos(valorContratoDaVersao(versao.snapshot)) !== dinheiroParaCentavos(pagamento.valorTotalContratado)) {
    throw new PagamentoServiceError("VERSAO_CONTRATUAL_NAO_ASSINADA", "O recebimento exige a obrigação original assinada e íntegra.", 409);
  }
  if (!["AGUARDANDO_PAGAMENTO", "CONFIRMADO"].includes(fechamento.status)) {
    throw new PagamentoServiceError("STATUS_FECHAMENTO_NAO_PERMITE_PAGAMENTO", "O estado do Fechamento não permite novos recebimentos.", 409);
  }
}

async function recalcularEstados(
  pagamento: PagamentoRecord,
  tx: DbExecutor,
) {
  // Estornar um fato financeiro não reabre uma obrigação cancelada.
  if (pagamento.status === "CANCELADO") return pagamento;
  if (await possuiCronograma(tx, pagamento.id)) return pagamento;
  const plano = await buscarPlanoAtivo(pagamento.id, tx);
  if (!plano) throw new PagamentoServiceError("PLANO_NAO_ENCONTRADO", "Pagamento sem plano ativo.", 409);

  const movimentosParcelas = await resumoMovimentosParcelas(plano.id, tx);
  for (const movimento of movimentosParcelas) {
    const status = statusParcelaPorLiquido(movimento);
    await atualizarStatusParcela(movimento.parcelaId, status, tx);
  }

  const movimentosPagamento = await resumoMovimentosPagamento(pagamento.id, tx);
  const statusPagamento = statusPagamentoPorLiquido({
    valorTotalContratado: pagamento.valorTotalContratado,
    ...movimentosPagamento,
  });
  return atualizarStatusPagamento(pagamento.id, statusPagamento, tx);
}

async function tentarConfirmarReserva(
  pagamento: PagamentoRecord,
  recebimento: RecebimentoRecord,
  tx: DbExecutor,
  context: PagamentoServiceContext,
) {
  const atual = await buscarPagamentoPorId(pagamento.id, tx, { forUpdate: true });
  if (!atual || atual.reservaStatus !== "PENDENTE") return atual ?? pagamento;

  const plano = await buscarPlanoAtivo(atual.id, tx);
  if (!plano) return atual;
  const parcelas = await listarParcelasPlano(plano.id, tx);
  const parcelaReserva = parcelas.find((item) => item.confirmaReserva);
  if (await possuiCronograma(tx, atual.id)) {
    const p = await posicaoDoPagamento(tx, atual.id);
    if (!p.futuro.some(i => BigInt(i.valorCentavos) === 0n && p.parcelas.some(pp => pp.id === i.parcelaId && pp.confirma_reserva))) return atual;
  } else if (!parcelaReserva || parcelaReserva.status !== "PAGA") return atual;

  const { fechamento } = await contextoDoPagamento(atual, tx);
  if (fechamento.status === "CONFIRMADO") {
    return marcarReservaPagamento(atual.id, "CONFIRMADA", tx);
  }
  if (fechamento.status !== "AGUARDANDO_PAGAMENTO") return atual;

  const revisaoAberta=await revisaoAbertaDoFechamento(fechamento.id,tx);
  if(revisaoAberta)await bloquearDatasRevisao(tx,revisaoAberta);
  await adquirirLockConfirmacaoAgenda(fechamento.dataEvento, tx);
  const conflito = await verificarConflitoAgendaParaConfirmacao(
    {
      fechamentoId: fechamento.id,
      data: fechamento.dataEvento,
      horarioInicio: fechamento.horarioInicio,
      horarioFim: fechamento.horarioFim,
    },
    tx,
  );

  if (conflito.bloqueioAgenda || conflito.fechamentoConfirmado) {
    const conflitoPagamento = await marcarReservaPagamento(atual.id, "CONFLITO", tx);
    if (fechamento.clienteId) {
      await registrarEventoHistorico({
        clienteId: fechamento.clienteId, tipoEvento: "PAGAMENTO_RECEBIDO_CONFLITO_AGENDA",
        origem: context.origem, entidadeTipo: "PAGAMENTO", entidadeId: atual.id,
        usuarioId: context.usuarioId ?? null, critico: true,
        detalhe: "Recebimento preservado; reserva não confirmada por conflito de agenda.",
        metadata: { recebimentoId: recebimento.id, fechamentoId: fechamento.id, ...conflito },
      }, tx);
    }
    await registrarAuditoria(
      {
        clienteId: fechamento.clienteId,
        atorTipo: context.usuarioId ? "USUARIO" : "SISTEMA",
        usuarioId: context.usuarioId ?? null,
        acao: "PAGAMENTO_RECEBIDO_CONFLITO_AGENDA",
        entidadeTipo: "PAGAMENTO",
        entidadeId: atual.id,
        dadosDepois: {
          recebimentoId: recebimento.id,
          fechamentoId: fechamento.id,
          bloqueioAgenda: conflito.bloqueioAgenda,
          fechamentoConfirmado: conflito.fechamentoConfirmado,
        },
        origem: context.origem,
        requestId: context.requestId ?? null,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
      tx,
    );
    return conflitoPagamento;
  }

  const fechamentoConfirmado = await marcarFechamentoConfirmado(fechamento.id, tx);
  if (!fechamentoConfirmado) return atual;
  if(revisaoAberta)await revalidarAgendaRevisao(tx,revisaoAberta,{...context,usuarioId:context.usuarioId??null},{naoFalharPorConflito:true});
  const confirmado = await marcarReservaPagamento(atual.id, "CONFIRMADA", tx);

  if (fechamento.clienteId) {
    await registrarEventoHistorico(
      {
        clienteId: fechamento.clienteId,
        tipoEvento: "RESERVA_CONFIRMADA_PAGAMENTO",
        origem: context.origem,
        entidadeTipo: "PAGAMENTO",
        entidadeId: atual.id,
        usuarioId: context.usuarioId ?? null,
        detalhe: "Reserva confirmada após quitação da parcela de confirmação.",
        metadata: { recebimentoId: recebimento.id, fechamentoId: fechamento.id },
        critico: true,
      },
      tx,
    );
  }
  return confirmado;
}

async function confirmarRecebimentoInterno(
  recebimento: RecebimentoRecord,
  context: PagamentoServiceContext,
  tx: DbExecutor,
) {
  if (recebimento.status === "CONFIRMADO") return recebimento;
  if (recebimento.status !== "PENDENTE") {
    throw new PagamentoServiceError(
      "RECEBIMENTO_NAO_PODE_SER_CONFIRMADO",
      "Somente recebimento pendente pode ser confirmado.",
      409,
      { statusAtual: recebimento.status },
    );
  }

  const pagamento = await buscarPagamentoPorId(recebimento.pagamentoId, tx, { forUpdate: true });
  if (!pagamento) throw new PagamentoServiceError("PAGAMENTO_NAO_ENCONTRADO", "Pagamento não encontrado.", 404);
  if (pagamento.status === "CANCELADO") throw new PagamentoServiceError("PAGAMENTO_CANCELADO", "Pagamento cancelado não aceita recebimentos.", 409);

  await validarContextoRecebimento(pagamento, tx);

  const plano = await buscarPlanoAtivo(pagamento.id, tx);
  if (!plano) throw new PagamentoServiceError("PLANO_NAO_ENCONTRADO", "Pagamento sem plano ativo.", 409);
  const alocacoes = await listarAlocacoesRecebimento(recebimento.id, tx);
  const posicao = await posicaoDoPagamento(tx, pagamento.id);
  validarCapacidadeConsolidada(posicao, recebimento.valorBruto, alocacoes.map(a => ({ parcelaId: a.parcelaId, valor: a.valorAlocado })));
  if (alocacoes.length === 0) throw new PagamentoServiceError("ALOCACAO_INVALIDA", "Recebimento sem alocações.", 409);
  if (alocacoes.reduce((total, a) => total + dinheiroParaCentavos(a.valorAlocado), 0) !== dinheiroParaCentavos(recebimento.valorBruto)) {
    throw new PagamentoServiceError("ALOCACAO_INVALIDA", "As alocações divergem do valor do recebimento.", 409);
  }

  for (const alocacao of alocacoes) {
    if (posicao.cronograma) continue;
    const parcela = await buscarParcelaPorId(alocacao.parcelaId, tx, { forUpdate: true });
    if (!parcela || parcela.planoId !== plano.id || parcela.status === "CANCELADA") {
      throw new PagamentoServiceError("ALOCACAO_INVALIDA", "A alocação não pertence ao plano ativo.", 409);
    }
    const movimentos = await resumoMovimentosParcelas(plano.id, tx);
    const atual = movimentos.find((item) => item.parcelaId === parcela.id);
    const liquidoAtual = Math.max(0, Math.round((atual?.recebidoConfirmado ?? 0) * 100) - Math.round((atual?.estornadoConfirmado ?? 0) * 100));
    if (
      liquidoAtual + dinheiroParaCentavos(alocacao.valorAlocado) >
      dinheiroParaCentavos(parcela.valorPrevisto)
    ) {
      throw new PagamentoServiceError(
        "VALOR_EXCEDE_SALDO",
        `A confirmação excederia o saldo da parcela ${parcela.numero}.`,
        409,
      );
    }
  }

  const confirmado = await marcarRecebimentoStatus(recebimento.id, "CONFIRMADO", tx);
  const pagamentoAtualizado = await recalcularEstados(pagamento, tx);
  await tentarConfirmarReserva(pagamentoAtualizado, confirmado, tx, context);
  await eventoMovimento(tx, posicao, context, 'RECEBIMENTO_CONFIRMADO', confirmado.id);

  const { fechamento } = await contextoDoPagamento(pagamentoAtualizado, tx);
  if (fechamento.clienteId) {
    await registrarEventoHistorico(
      {
        clienteId: fechamento.clienteId,
        tipoEvento: "RECEBIMENTO_CONFIRMADO",
        origem: context.origem,
        entidadeTipo: "PAGAMENTO_RECEBIMENTO",
        entidadeId: confirmado.id,
        usuarioId: context.usuarioId ?? null,
        detalhe: `Recebimento de R$ ${confirmado.valorBruto.toFixed(2)} confirmado.`,
        metadata: { pagamentoId: pagamento.id, meioPagamento: confirmado.meioPagamento },
        critico: true,
      },
      tx,
    );
  }
  await registrarAuditoria(
    {
      clienteId: fechamento.clienteId,
      atorTipo: context.usuarioId ? "USUARIO" : "SISTEMA",
      usuarioId: context.usuarioId ?? null,
      acao: "RECEBIMENTO_CONFIRMADO",
      entidadeTipo: "PAGAMENTO_RECEBIMENTO",
      entidadeId: confirmado.id,
      dadosAntes: { status: recebimento.status },
      dadosDepois: { status: confirmado.status, valorBruto: confirmado.valorBruto },
      origem: context.origem,
      requestId: context.requestId ?? null,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    },
    tx,
  );
  return confirmado;
}

export async function registrarRecebimentoPagamento(
  input: RegistrarRecebimentoInput,
  context: PagamentoServiceContext,
): Promise<RegistrarRecebimentoResult> {
  if (input.recebidoEm && (Number.isNaN(Date.parse(input.recebidoEm)) || Date.parse(input.recebidoEm) > Date.now())) throw new PagamentoServiceError('RECEBIMENTO_INVALIDO', 'Informe a data real do recebimento, sem data futura.', 400);
  if (input.referenciaExterna?.trim() && !input.provedorCodigo?.trim()) {
    throw new PagamentoServiceError("RECEBIMENTO_INVALIDO", "Informe o provedor da referência externa.", 400);
  }
  return withTransaction(async (tx) => {
    const pagamento = await bloquearPagamento(input.pagamentoId, tx);
    if (!pagamento) throw new PagamentoServiceError("PAGAMENTO_NAO_ENCONTRADO", "Pagamento não encontrado.", 404);
    if (pagamento.status === "CANCELADO") throw new PagamentoServiceError("PAGAMENTO_CANCELADO", "Pagamento cancelado não aceita recebimentos.", 409);

    const chaveIdempotencia = input.chaveIdempotencia?.trim() || null;
    const porChave = chaveIdempotencia ? await buscarRecebimentoPorIdempotencia(chaveIdempotencia, tx) : null;
    const porReferencia = input.provedorCodigo?.trim() && input.referenciaExterna?.trim()
      ? await buscarRecebimentoPorReferencia(input.provedorCodigo.trim(), input.referenciaExterna.trim(), tx) : null;
    if (porChave && porReferencia && porChave.id !== porReferencia.id) {
      throw new PagamentoServiceError("RECEBIMENTO_INVALIDO", "Chave e referência apontam para recebimentos diferentes.", 409);
    }
    {
      const existente = porChave ?? porReferencia;
      if (existente) {
        if (existente.pagamentoId !== pagamento.id) {
          throw new PagamentoServiceError("RECEBIMENTO_INVALIDO", "Chave de idempotência já utilizada em outro Pagamento.", 409);
        }
        const alocacoes = await listarAlocacoesRecebimento(existente.id, tx);
        validarRepeticaoRecebimento(existente, alocacoes, input);
        const atual = input.confirmarAgora !== false
          ? await confirmarRecebimentoInterno(existente, context, tx)
          : existente;
        const atualizado = await buscarPagamentoPorId(pagamento.id, tx) ?? pagamento;
        return {
          recebimento: atual,
          alocacoes,
          detalhe: await detalhePagamento(atualizado, tx),
          reutilizado: true,
          reserva: { status: atualizado.reservaStatus, conflito: atualizado.reservaStatus === "CONFLITO" },
        };
      }
    }

    await validarContextoRecebimento(pagamento, tx);
    const valor = centavosParaDinheiro(dinheiroParaCentavos(input.valorBruto, "valorBruto"));
    if (input.alocacoes.length === 0) {
      throw new PagamentoServiceError("ALOCACAO_INVALIDA", "Informe ao menos uma parcela para o recebimento.", 400);
    }
    const totalAlocado = input.alocacoes.reduce(
      (acc, item) => acc + dinheiroParaCentavos(item.valor, "valor da alocação"),
      0,
    );
    if (totalAlocado !== dinheiroParaCentavos(valor)) {
      throw new PagamentoServiceError("ALOCACAO_INVALIDA", "A soma das alocações deve ser igual ao valor do recebimento.", 400);
    }

    const plano = await buscarPlanoAtivo(pagamento.id, tx);
    if (!plano) throw new PagamentoServiceError("PLANO_NAO_ENCONTRADO", "Pagamento sem plano ativo.", 409);
    const ids = new Set<string>();
    const movimentos = await resumoMovimentosParcelas(plano.id, tx);
    const posicao = await posicaoDoPagamento(tx, pagamento.id);
    validarCapacidadeConsolidada(posicao, valor, input.alocacoes);
    for (const item of input.alocacoes) {
      if (ids.has(item.parcelaId.toLowerCase())) throw new PagamentoServiceError("ALOCACAO_INVALIDA", "Não repita a mesma parcela no recebimento.", 400);
      ids.add(item.parcelaId.toLowerCase());
      if (posicao.cronograma) continue;
      const parcela = await buscarParcelaPorId(item.parcelaId, tx);
      if (!parcela || parcela.planoId !== plano.id || parcela.status === "CANCELADA") {
        throw new PagamentoServiceError("PARCELA_NAO_ENCONTRADA", "Uma das parcelas não pertence ao plano ativo.", 409);
      }
      const movimento = movimentos.find((m) => m.parcelaId === parcela.id);
      const liquido = Math.round(((movimento?.recebidoConfirmado ?? 0) - (movimento?.estornadoConfirmado ?? 0)) * 100);
      if (dinheiroParaCentavos(item.valor) > dinheiroParaCentavos(parcela.valorPrevisto) - liquido) {
        throw new PagamentoServiceError("VALOR_EXCEDE_SALDO", `A alocação excede o saldo da parcela ${parcela.numero}.`, 409);
      }
    }

    const recebimento = await criarRecebimento(
      {
        pagamentoId: pagamento.id,
        meioPagamento: input.meioPagamento,
        valorBruto: valor,
        recebidoEm: input.recebidoEm ?? null,
        provedorCodigo: input.provedorCodigo?.trim() || null,
        referenciaExterna: input.referenciaExterna?.trim() || null,
        chaveIdempotencia: input.chaveIdempotencia?.trim() || null,
        metadataProvedor: input.metadataProvedor ?? {},
        registradoPorUsuarioId: context.usuarioId ?? null,
        observacoes: input.observacoes?.trim() || null,
      },
      tx,
    );
    const alocacoes = [];
    for (const item of input.alocacoes) {
      alocacoes.push(await criarRecebimentoAlocacao({
        recebimentoId: recebimento.id,
        parcelaId: item.parcelaId,
        valorAlocado: centavosParaDinheiro(dinheiroParaCentavos(item.valor)),
      }, tx));
    }

    const final = input.confirmarAgora === false
      ? recebimento
      : await confirmarRecebimentoInterno(recebimento, context, tx);
    if (final.status === "PENDENTE") {
      await eventoMovimento(tx, posicao, context, 'RECEBIMENTO_REGISTRADO', final.id);
      const { fechamento } = await contextoDoPagamento(pagamento, tx);
      if (fechamento.clienteId) await registrarEventoHistorico({
        clienteId: fechamento.clienteId, tipoEvento: "RECEBIMENTO_REGISTRADO", origem: context.origem,
        entidadeTipo: "PAGAMENTO_RECEBIMENTO", entidadeId: final.id, usuarioId: context.usuarioId ?? null,
        detalhe: "Recebimento registrado, aguardando confirmação financeira.", critico: true,
        metadata: { pagamentoId: pagamento.id, valorBruto: final.valorBruto },
      }, tx);
      await registrarAuditoria({
        clienteId: fechamento.clienteId, atorTipo: context.usuarioId ? "USUARIO" : "SISTEMA",
        usuarioId: context.usuarioId ?? null, acao: "RECEBIMENTO_REGISTRADO", entidadeTipo: "PAGAMENTO_RECEBIMENTO",
        entidadeId: final.id, dadosDepois: { status: final.status, valorBruto: final.valorBruto },
        origem: context.origem, requestId: context.requestId ?? null, ip: context.ip ?? null, userAgent: context.userAgent ?? null,
      }, tx);
    }
    const pagamentoAtual = await buscarPagamentoPorId(pagamento.id, tx) ?? pagamento;
    return {
      recebimento: final,
      alocacoes,
      detalhe: await detalhePagamento(pagamentoAtual, tx),
      reutilizado: false,
      reserva: {
        status: pagamentoAtual.reservaStatus,
        conflito: pagamentoAtual.reservaStatus === "CONFLITO",
      },
    };
  });
}

export async function confirmarRecebimentoPagamento(
  recebimentoId: string,
  context: PagamentoServiceContext,
) {
  return withTransaction(async (tx) => {
    const origem = await buscarRecebimentoPorId(recebimentoId, tx);
    if (!origem) throw new PagamentoServiceError("RECEBIMENTO_NAO_ENCONTRADO", "Recebimento não encontrado.", 404);
    // Mesma ordem de locks de registro/estorno: pagamento antes do recebimento.
    // A ordem inversa permite deadlock entre confirmação e estorno simultâneos.
    await bloquearPagamento(origem.pagamentoId, tx);
    const recebimento = await buscarRecebimentoPorId(recebimentoId, tx, { forUpdate: true });
    if (!recebimento) throw new PagamentoServiceError("RECEBIMENTO_NAO_ENCONTRADO", "Recebimento não encontrado.", 404);
    const confirmado = await confirmarRecebimentoInterno(recebimento, context, tx);
    const pagamento = await buscarPagamentoPorId(confirmado.pagamentoId, tx) as PagamentoRecord;
    return { recebimento: confirmado, detalhe: await detalhePagamento(pagamento, tx) };
  });
}

export async function substituirPlanoPagamento(
  pagamentoId: string,
  input: PlanoPagamentoInput,
  motivo: string,
  context: PagamentoServiceContext,
) {
  return withTransaction(async (tx) => {
    const pagamento = await bloquearPagamento(pagamentoId, tx);
    if (!pagamento) throw new PagamentoServiceError("PAGAMENTO_NAO_ENCONTRADO", "Pagamento não encontrado.", 404);
    if (await possuiCronograma(tx, pagamento.id)) throw new PagamentoServiceError('CRONOGRAMA_CONSOLIDADO', 'Use a reprogramação do cronograma consolidado.', 409);
    if (pagamento.status === "CANCELADO" || pagamento.reservaStatus === "CONFIRMADA") {
      throw new PagamentoServiceError("PLANO_NAO_PODE_SER_SUBSTITUIDO", "O plano não pode ser alterado após cancelamento ou confirmação da reserva.", 409);
    }
    if (await existeRecebimentoPagamento(pagamento.id, tx)) {
      throw new PagamentoServiceError("PLANO_NAO_PODE_SER_SUBSTITUIDO", "O plano não pode ser alterado após qualquer registro de recebimento.", 409);
    }
    const atual = await buscarPlanoAtivo(pagamento.id, tx, { forUpdate: true });
    if (!atual) throw new PagamentoServiceError("PLANO_NAO_ENCONTRADO", "Plano ativo não encontrado.", 409);
    const motivoLimpo = motivo.trim();
    if (!motivoLimpo) throw new PagamentoServiceError("PLANO_PAGAMENTO_INVALIDO", "Informe o motivo da alteração do plano.", 400);

    await substituirPlanoAtivo(atual.id, motivoLimpo, tx);
    await cancelarParcelasPendentesDoPlano(atual.id, tx);
    const novo = await criarPlanoEParcelas(pagamento, atual.numeroVersao + 1, input, context, tx);

    const { fechamento } = await contextoDoPagamento(pagamento, tx);
    if (fechamento.clienteId) {
      await registrarEventoHistorico({
        clienteId: fechamento.clienteId, tipoEvento: "PLANO_PAGAMENTO_SUBSTITUIDO",
        origem: context.origem, entidadeTipo: "PAGAMENTO", entidadeId: pagamento.id,
        usuarioId: context.usuarioId ?? null, critico: true,
        detalhe: `Plano V${atual.numeroVersao} substituído por V${novo.plano.numeroVersao}.`,
        metadata: { planoAnteriorId: atual.id, planoNovoId: novo.plano.id, motivo: motivoLimpo },
      }, tx);
    }
    await registrarAuditoria(
      {
        clienteId: fechamento.clienteId,
        atorTipo: context.usuarioId ? "USUARIO" : "SISTEMA",
        usuarioId: context.usuarioId ?? null,
        acao: "PLANO_PAGAMENTO_SUBSTITUIDO",
        entidadeTipo: "PAGAMENTO",
        entidadeId: pagamento.id,
        dadosAntes: { planoId: atual.id, versao: atual.numeroVersao },
        dadosDepois: { planoId: novo.plano.id, versao: novo.plano.numeroVersao },
        justificativa: motivoLimpo,
        origem: context.origem,
        requestId: context.requestId ?? null,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
      tx,
    );
    return detalhePagamento(pagamento, tx);
  });
}

export async function registrarEstornoPagamento(
  input: RegistrarEstornoInput,
  context: PagamentoServiceContext,
): Promise<RegistrarEstornoResult> {
  if (input.referenciaExterna?.trim() && !input.provedorCodigo?.trim()) {
    throw new PagamentoServiceError("ESTORNO_INVALIDO", "Informe o provedor da referência externa.", 400);
  }
  if (input.confirmarAgora === false && !input.chaveIdempotencia?.trim() && !input.referenciaExterna?.trim()) {
    throw new PagamentoServiceError("ESTORNO_INVALIDO", "Estorno solicitado exige chave de idempotência ou referência do provedor para confirmação posterior.", 400);
  }
  return withTransaction(async (tx) => {
    const pagamento = await bloquearPagamento(input.pagamentoId, tx);
    if (!pagamento) throw new PagamentoServiceError("PAGAMENTO_NAO_ENCONTRADO", "Pagamento não encontrado.", 404);

    const chaveIdempotencia = input.chaveIdempotencia?.trim() || null;
    const porChave = chaveIdempotencia ? await buscarEstornoPorIdempotencia(chaveIdempotencia, tx) : null;
    const porReferencia = input.provedorCodigo?.trim() && input.referenciaExterna?.trim()
      ? await buscarEstornoPorReferencia(input.provedorCodigo.trim(), input.referenciaExterna.trim(), tx) : null;
    if (porChave && porReferencia && porChave.id !== porReferencia.id) {
      throw new PagamentoServiceError("ESTORNO_INVALIDO", "Chave e referência apontam para estornos diferentes.", 409);
    }
    const existente: EstornoRecord | null = porChave ?? porReferencia;
    {
      if (existente) {
        const origem = await buscarRecebimentoPorId(existente.recebimentoId, tx);
        if (!origem) throw new PagamentoServiceError("ESTORNO_INVALIDO", "Recebimento do estorno não encontrado.", 409);
        validarRepeticaoEstorno(existente, origem.pagamentoId, input);
        if (existente.status === "CONFIRMADO" || input.confirmarAgora === false) {
          if (existente.status === 'CONFIRMADO') {
            const registro=(await tx.query<{resultado:{reprogramacaoHash?:string|null}}>("SELECT resultado FROM pagamento_eventos WHERE pagamento_id=$1 AND tipo='ESTORNO_CONFIRMADO' AND resultado->>'movimentoId'=$2",[pagamento.id,existente.id])).rows[0];
            if ((registro?.resultado.reprogramacaoHash??null)!==(input.reprogramacao?hashSnapshotContrato(input.reprogramacao):null)) throw new PagamentoServiceError('ESTORNO_INVALIDO','Repetição com reprogramação diferente.',409);
          }
          return { estorno: existente, detalhe: await detalhePagamento(pagamento, tx), reutilizado: true };
        }
        if (existente.status !== "SOLICITADO") {
          throw new PagamentoServiceError("ESTORNO_INVALIDO", "Somente estorno solicitado pode ser confirmado.", 409);
        }
      }
    }

    const recebimento = await buscarRecebimentoPorId(input.recebimentoId, tx, { forUpdate: true });
    if (!recebimento || recebimento.pagamentoId !== pagamento.id || recebimento.status !== "CONFIRMADO") {
      throw new PagamentoServiceError("ESTORNO_INVALIDO", "O estorno exige recebimento confirmado deste Pagamento.", 409);
    }
    const parcela = await buscarParcelaPorId(input.parcelaId, tx);
    if (!parcela) throw new PagamentoServiceError("PARCELA_NAO_ENCONTRADA", "Parcela não encontrada.", 404);

    const valor = centavosParaDinheiro(dinheiroParaCentavos(input.valor, "valor do estorno"));
    // A transacao compartilha um unico pg.Client; mantenha as consultas
    // sequenciais para nao executar client.query em paralelo no mesmo client.
    const alocado = await valorAlocadoConfirmadoRecebimentoParcela(recebimento.id, parcela.id, tx);
    const comprometido = await valorEstornosComprometidos(recebimento.id, parcela.id, existente?.id ?? null, tx);
    const posicao = await posicaoDoPagamento(tx, pagamento.id);
    const devolucoes = await validarEstornoComDevolucoes(tx, posicao, recebimento.id, parcela.id, valor, input.referenciaExterna?.trim(), input.provedorCodigo?.trim(), input.confirmarAgora !== false);
    if (BigInt(dinheiroParaCentavos(valor)) > BigInt(Math.round(alocado * 100) - Math.round(comprometido * 100)) - devolucoes) {
      throw new PagamentoServiceError("ESTORNO_INVALIDO", "O estorno excede o valor líquido alocado deste recebimento na parcela.", 409);
    }

    let estorno = existente ?? await criarEstorno(
      {
        recebimentoId: recebimento.id,
        parcelaId: parcela.id,
        valor,
        motivo: input.motivo?.trim() || null,
        provedorCodigo: input.provedorCodigo?.trim() || null,
        referenciaExterna: input.referenciaExterna?.trim() || null,
        chaveIdempotencia: input.chaveIdempotencia?.trim() || null,
        metadataProvedor: input.metadataProvedor ?? {},
        registradoPorUsuarioId: context.usuarioId ?? null,
      },
      tx,
    );

    if (!existente && input.confirmarAgora === false) {
      await eventoMovimento(tx, posicao, context, 'ESTORNO_SOLICITADO', estorno.id);
      const { fechamento } = await contextoDoPagamento(pagamento, tx);
      if (fechamento.clienteId) await registrarEventoHistorico({
        clienteId: fechamento.clienteId, tipoEvento: "ESTORNO_SOLICITADO", origem: context.origem,
        entidadeTipo: "PAGAMENTO_ESTORNO", entidadeId: estorno.id, usuarioId: context.usuarioId ?? null,
        detalhe: "Estorno solicitado, ainda sem efeito financeiro.", critico: true,
        metadata: { pagamentoId: pagamento.id, valor: estorno.valor },
      }, tx);
      await registrarAuditoria({
        clienteId: fechamento.clienteId, atorTipo: context.usuarioId ? "USUARIO" : "SISTEMA",
        usuarioId: context.usuarioId ?? null, acao: "ESTORNO_SOLICITADO", entidadeTipo: "PAGAMENTO_ESTORNO",
        entidadeId: estorno.id, dadosDepois: { valor: estorno.valor, recebimentoId: recebimento.id, parcelaId: parcela.id },
        origem: context.origem, requestId: context.requestId ?? null, ip: context.ip ?? null, userAgent: context.userAgent ?? null,
      }, tx);
    }

    if (input.confirmarAgora !== false) {
      estorno = (await marcarEstornoConfirmado(estorno.id, tx)) ?? estorno;
      await consolidarCronogramaDoEstorno(tx,posicao,context,estorno.id,input.reprogramacao);
      const pagamentoAtualizado = await recalcularEstados(pagamento, tx);
      await eventoMovimento(tx, posicao, context, 'ESTORNO_CONFIRMADO', estorno.id,{reprogramacaoHash:input.reprogramacao?hashSnapshotContrato(input.reprogramacao):null});
      const { fechamento } = await contextoDoPagamento(pagamentoAtualizado, tx);
      if (fechamento.clienteId) {
        await registrarEventoHistorico(
          {
            clienteId: fechamento.clienteId,
            tipoEvento: "ESTORNO_CONFIRMADO",
            origem: context.origem,
            entidadeTipo: "PAGAMENTO_ESTORNO",
            entidadeId: estorno.id,
            usuarioId: context.usuarioId ?? null,
            detalhe: `Estorno de R$ ${estorno.valor.toFixed(2)} confirmado.`,
            metadata: { pagamentoId: pagamento.id, recebimentoId: recebimento.id, parcelaId: parcela.id },
            critico: true,
          },
          tx,
        );
      }
      await registrarAuditoria(
        {
          clienteId: fechamento.clienteId,
          atorTipo: context.usuarioId ? "USUARIO" : "SISTEMA",
          usuarioId: context.usuarioId ?? null,
          acao: "ESTORNO_CONFIRMADO",
          entidadeTipo: "PAGAMENTO_ESTORNO",
          entidadeId: estorno.id,
          dadosDepois: { valor: estorno.valor, recebimentoId: recebimento.id, parcelaId: parcela.id },
          justificativa: estorno.motivo,
          origem: context.origem,
          requestId: context.requestId ?? null,
          ip: context.ip ?? null,
          userAgent: context.userAgent ?? null,
        },
        tx,
      );
    }

    const atualizado = await buscarPagamentoPorId(pagamento.id, tx) ?? pagamento;
    return { estorno, detalhe: await detalhePagamento(atualizado, tx), reutilizado: existente !== null };
  });
}

export async function registrarComprovantePagamento(input: {
  pagamentoId: string;
  recebimentoId: string;
  nomeArquivo: string;
  mimeType: string;
  tamanhoBytes: number;
  sha256: string;
  localizadorArquivo: string;
}, context: PagamentoServiceContext) {
  return withTransaction(async (tx) => {
    const pagamento = await bloquearPagamento(input.pagamentoId, tx);
    if (!pagamento) throw new PagamentoServiceError("PAGAMENTO_NAO_ENCONTRADO", "Pagamento não encontrado.", 404);
    const recebimento = await buscarRecebimentoPorId(input.recebimentoId, tx);
    if (!recebimento || recebimento.pagamentoId !== pagamento.id) {
      throw new PagamentoServiceError("COMPROVANTE_INVALIDO", "O comprovante não pertence a um recebimento deste Pagamento.", 409);
    }
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
      throw new PagamentoServiceError("COMPROVANTE_INVALIDO", "SHA-256 do comprovante inválido.", 400);
    }
    if (!input.nomeArquivo.trim() || input.nomeArquivo.trim().length > 255 ||
      !input.mimeType.trim() || input.mimeType.trim().length > 120 ||
      !input.localizadorArquivo.trim() || input.localizadorArquivo.trim().length > 2000 ||
      !Number.isSafeInteger(input.tamanhoBytes) || input.tamanhoBytes <= 0) {
      throw new PagamentoServiceError("COMPROVANTE_INVALIDO", "Metadados do comprovante inválidos.", 400);
    }
    const existente = await buscarComprovantePorHash(recebimento.id, input.sha256, tx);
    if (existente) {
      if (existente.tamanhoBytes !== input.tamanhoBytes || existente.mimeType !== input.mimeType.trim()) {
        throw new PagamentoServiceError("COMPROVANTE_INVALIDO", "Hash já registrado com metadados de integridade diferentes.", 409);
      }
      return { ...existente, reutilizado: true };
    }
    const comprovante = await criarComprovantePagamento(
      {
        recebimentoId: recebimento.id,
        nomeArquivo: input.nomeArquivo.trim(),
        mimeType: input.mimeType.trim(),
        tamanhoBytes: input.tamanhoBytes,
        sha256: input.sha256,
        localizadorArquivo: input.localizadorArquivo.trim(),
        registradoPorUsuarioId: context.usuarioId ?? null,
      },
      tx,
    );
    const { fechamento } = await contextoDoPagamento(pagamento, tx);
    await registrarAuditoria(
      {
        clienteId: fechamento.clienteId,
        atorTipo: context.usuarioId ? "USUARIO" : "SISTEMA",
        usuarioId: context.usuarioId ?? null,
        acao: "COMPROVANTE_PAGAMENTO_REGISTRADO",
        entidadeTipo: "PAGAMENTO_COMPROVANTE",
        entidadeId: comprovante.id,
        dadosDepois: { recebimentoId: recebimento.id, sha256: comprovante.sha256 },
        origem: context.origem,
        requestId: context.requestId ?? null,
        ip: context.ip ?? null,
        userAgent: context.userAgent ?? null,
      },
      tx,
    );
    return { ...comprovante, reutilizado: false };
  });
}
