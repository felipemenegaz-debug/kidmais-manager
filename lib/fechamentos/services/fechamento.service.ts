import { valorParaGravar } from "./valor-para-gravar";
import { buscarClientePorId } from "../../clientes/repositories";
import { calcularResumoComercial } from "../../comercial/services";
import { observacoesDasEscolhas } from "../../comercial/adicionais-escolhas";
import { centavosComerciais, validarPretensaoPix, type CondicaoPagamento } from "../../comercial/condicao-pagamento";
import { regraConferidaNaCriacao, RegrasPagamentoMudaramError } from "../../comercial/regras-pagamento";

import type { DbExecutor } from "../../db/contracts";
import { withTransaction } from "../../db/postgres";
import {
  criarAprovacaoNegociacao,
  criarFechamento,
  criarFechamentoAdicional,
  type FechamentoAdicionalRecord,
} from "../repositories";
import { FechamentoServiceError } from "./errors";
import { gravarFotografiaPacoteFechamento } from "./pacote-snapshot";
import { vincularContatoAutomaticamente } from "../../marketing/conversao";
import type {
  CriarFechamentoComercialInput,
  CriarFechamentoComercialResult,
} from "./models";

function arredondarDinheiro(valor: number) {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function textoOuNull(valor: string | null | undefined) {
  const normalizado = valor?.trim();
  return normalizado ? normalizado : null;
}

function validarInput(input: CriarFechamentoComercialInput) {
  if (!input.dataEvento || !input.horarioInicio || !input.horarioFim) {
    throw new FechamentoServiceError(
      "DADOS_INVALIDOS",
      "Data e horário do Fechamento são obrigatórios.",
    );
  }

  if (!input.configuracaoAgendaId || !input.pacoteId) {
    throw new FechamentoServiceError(
      "DADOS_INVALIDOS",
      "Configuração de agenda e pacote são obrigatórios.",
    );
  }

  if (!Number.isInteger(input.convidados) || input.convidados <= 0) {
    throw new FechamentoServiceError(
      "DADOS_INVALIDOS",
      "A quantidade de convidados é inválida.",
    );
  }

  if (
    input.idadeAniversarianteEvento !== null &&
    input.idadeAniversarianteEvento !== undefined &&
    (!Number.isInteger(input.idadeAniversarianteEvento) ||
      input.idadeAniversarianteEvento < 0 ||
      input.idadeAniversarianteEvento > 120)
  ) {
    throw new FechamentoServiceError(
      "DADOS_INVALIDOS",
      "A idade do Aniversariante no evento é inválida.",
    );
  }
}

async function criarFechamentoComercialNaTransacao(
  input: CriarFechamentoComercialInput,
  tx: DbExecutor,
): Promise<CriarFechamentoComercialResult> {
  const resumoComercial = await calcularResumoComercial(
    {
      data: input.dataEvento,
      configuracaoAgendaId: input.configuracaoAgendaId,
      pacoteId: input.pacoteId,
      convidados: input.convidados,
      adicionais: input.adicionais ?? [],
    },
    tx,
  );

  // Nova associação cliente↔fechamento: as duas empresas comprovadas e iguais. A empresa do
  // fechamento é a do pacote gravado; a do cliente é imutável. A 054 repete no banco.
  if (input.clienteId) {
    const empresaDoPacote = resumoComercial.pacote.pacote.empresaId ?? null;
    const cliente = await buscarClientePorId(input.clienteId, tx);
    if (!cliente || !empresaDoPacote || cliente.empresaId === null || cliente.empresaId !== empresaDoPacote) {
      throw new FechamentoServiceError(
        "EMPRESA_INCOMPATIVEL",
        "Cliente e pacote não pertencem à mesma empresa.",
        409,
      );
    }
  }

  const valorTabela = arredondarDinheiro(resumoComercial.valorTotalTabela);
  const valorProposto = valorParaGravar(input.origemFechamento, valorTabela, input.valorProposto, input.totalExibidoCentavos);
  const negociacaoNecessaria = centavosComerciais(valorProposto) !== centavosComerciais(valorTabela);
  const pretendida = validarPretensaoPix(input.condicaoPixPretendida);
  if (pretendida && input.formaPagamentoPretendida !== "PIX_PARCELADO") {
    throw new FechamentoServiceError("DADOS_INVALIDOS", "A condição de PIX parcelado exige essa forma de pagamento.");
  }
  const revisaoNecessaria = negociacaoNecessaria || input.formaPagamentoPretendida === "PIX_PARCELADO";
  const regraDaCondicao = input.formaPagamentoPretendida
    ? await regraConferidaNaCriacao(tx, resumoComercial.pacote.pacote.empresaId ?? null, input.formaPagamentoPretendida,
      input.descontoFormaPagamentoExibido).catch((erro: unknown) => {
      if (!(erro instanceof RegrasPagamentoMudaramError)) throw erro;
      throw new FechamentoServiceError("REGRAS_PAGAMENTO_MUDARAM", erro.message, 409, {
        pagamento: erro.regras, exibido: erro.exibido, vigente: erro.vigente,
      });
    })
    : {};
  const condicaoPagamento: CondicaoPagamento | null = input.formaPagamentoPretendida ? {
    schemaVersao: 1, forma: input.formaPagamentoPretendida, pretendida, aprovada: null,
    // Regra da empresa do pacote (077), conferida contra o percentual exibido na tela (Astra r1, P2); sem a 077, nada novo.
    ...regraDaCondicao,
    revisaoStatus: revisaoNecessaria ? "PENDENTE" : "DISPENSADA",
  } : null;

  const fechamento = await criarFechamento(
    {
      clienteId: input.clienteId ?? null,
      aniversarianteId: input.aniversarianteId ?? null,
      dataEvento: input.dataEvento,
      horarioInicio: input.horarioInicio,
      horarioFim: input.horarioFim,
      configuracaoAgendaId: input.configuracaoAgendaId,
      estabelecimentoId: input.estabelecimentoId ?? null,
      pacoteId: resumoComercial.pacote.pacote.id,
      tabelaPrecoId: resumoComercial.pacote.tabelaPreco.id,
      precoPacoteId: resumoComercial.pacote.precoRegra.id,
      regraDescontoPacoteId: resumoComercial.pacote.desconto.regraId,
      categoriaHorario: resumoComercial.pacote.categoriaHorario,
      categoriaPrecoAplicada: resumoComercial.pacote.precoRegra.categoriaHorario,
      convidados: resumoComercial.pacote.convidadosInformados,
      convidadosFaturados: resumoComercial.pacote.convidadosFaturados,
      valorPacoteBase: resumoComercial.valorTabelaPacoteBase,
      descontoPercentual: resumoComercial.pacote.desconto.percentual,
      valorDescontoPacote: resumoComercial.valorDescontoPacote,
      valorPacoteAplicado: resumoComercial.valorTabelaPacoteAplicado,
      valorAdicionais: resumoComercial.valorAdicionais,
      valorTabela,
      valorNegociado: negociacaoNecessaria ? valorProposto : null,
      valorAprovado: null,
      motivoNegociacao: negociacaoNecessaria
        ? textoOuNull(input.motivoNegociacao)
        : null,
      observacoesNegociacao: negociacaoNecessaria
        ? textoOuNull(input.observacoesNegociacao)
        : null,
      status: revisaoNecessaria
        ? "AGUARDANDO_APROVACAO"
        : "AGUARDANDO_CONTRATO",
      origemFechamento: input.origemFechamento,
      iniciadoPorUsuarioId: input.iniciadoPorUsuarioId ?? null,
      usuarioResponsavelId: input.usuarioResponsavelId ?? null,
      responsavelAdicionalId: input.responsavelAdicionalId ?? null,
      idadeAniversarianteEvento: input.idadeAniversarianteEvento ?? null,
      temaFesta: textoOuNull(input.temaFesta),
      formaPagamentoPretendida: input.formaPagamentoPretendida ?? null,
      condicaoPagamento,
      alteracoesPacote: textoOuNull(input.alteracoesPacote),
      observacoesCliente: textoOuNull(input.observacoesCliente),
      observacoesEquipe: textoOuNull(input.observacoesEquipe),
      buffetStatus: input.buffetStatus ?? "PENDENTE",
      buffetSalgados: textoOuNull(input.buffetSalgados),
      buffetBebidas: textoOuNull(input.buffetBebidas),
      buffetDoces: textoOuNull(input.buffetDoces),
      buffetBolo: textoOuNull(input.buffetBolo),
      buffetOutros: textoOuNull(input.buffetOutros),
      buffetLembrancinha: textoOuNull(input.buffetLembrancinha),
      buffetEmpratado: textoOuNull(input.buffetEmpratado),
      buffetBombom: textoOuNull(input.buffetBombom),
    },
    tx,
  );

  // Vínculo do pedido, herança e próxima ação do Funil num SAVEPOINT: falha do Marketing não derruba a venda.
  await vincularContatoAutomaticamente(tx, fechamento.id);

  const adicionais: FechamentoAdicionalRecord[] = [];
  const escolhas = await observacoesDasEscolhas(tx, resumoComercial.adicionais.itens, input.adicionais ?? []);

  for (const item of resumoComercial.adicionais.itens) {
    adicionais.push(
      await criarFechamentoAdicional(
        {
          fechamentoId: fechamento.id,
          adicionalId: item.adicionalId,
          precoAdicionalId: item.precoRegraId,
          nomeAplicado: item.nome,
          unidadeCobrancaAplicada: item.unidadeCobranca,
          quantidade: item.quantidade,
          valorUnitarioAplicado: item.valorUnitarioAplicado,
          valorTotal: item.valorTotal,
          observacoes: escolhas.get(item.adicionalId) ?? null,
        },
        tx,
      ),
    );
  }

  await gravarFotografiaPacoteFechamento(tx, fechamento, resumoComercial);

  const aprovacaoNegociacao = revisaoNecessaria
    ? await criarAprovacaoNegociacao(
        {
          fechamentoId: fechamento.id,
          condicaoPagamento,
          valorInformado: valorProposto,
          valorAprovado: null,
          status: "PENDENTE",
          motivo: textoOuNull(input.motivoNegociacao),
          observacoes: textoOuNull(input.observacoesNegociacao),
        },
        tx,
      )
    : null;

  return {
    fechamento,
    adicionais,
    aprovacaoNegociacao,
    resumoComercial,
    negociacaoNecessaria,
  };
}

/**
 * Cria o núcleo persistente do Fechamento.
 *
 * Sem customDb, abre sua própria transação (comportamento legado preservado).
 * Com customDb, participa da transação externa — necessário para vincular
 * Identidade/CRM e consumir a prova de identidade de forma atômica.
 */
export async function criarFechamentoComercial(
  input: CriarFechamentoComercialInput,
  customDb?: DbExecutor,
): Promise<CriarFechamentoComercialResult> {
  validarInput(input);

  if (customDb) {
    return criarFechamentoComercialNaTransacao(input, customDb);
  }

  return withTransaction((tx) => criarFechamentoComercialNaTransacao(input, tx));
}
