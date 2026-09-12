import { calcularResumoComercial } from "../../comercial/services";
import { centavosComerciais, validarPretensaoPix, type CondicaoPagamento } from "../../comercial/condicao-pagamento";
import type { DbExecutor } from "../../db/contracts";
import { withTransaction } from "../../db/postgres";
import {
  criarAprovacaoNegociacao,
  criarFechamento,
  criarFechamentoAdicional,
  type FechamentoAdicionalRecord,
} from "../repositories";
import { FechamentoServiceError } from "./errors";
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

  if (!Number.isFinite(input.valorProposto) || input.valorProposto <= 0) {
    throw new FechamentoServiceError(
      "VALOR_PROPOSTO_INVALIDO",
      "O valor proposto para o Fechamento é inválido.",
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

  const valorTabela = arredondarDinheiro(resumoComercial.valorTotalTabela);
  const valorProposto = centavosComerciais(input.valorProposto) / 100;
  const negociacaoNecessaria = centavosComerciais(valorProposto) !== centavosComerciais(valorTabela);
  const pretendida = validarPretensaoPix(input.condicaoPixPretendida);
  if (pretendida && input.formaPagamentoPretendida !== "PIX_PARCELADO") {
    throw new FechamentoServiceError("DADOS_INVALIDOS", "A condição de PIX parcelado exige essa forma de pagamento.");
  }
  const revisaoNecessaria = negociacaoNecessaria || input.formaPagamentoPretendida === "PIX_PARCELADO";
  const condicaoPagamento: CondicaoPagamento | null = input.formaPagamentoPretendida ? {
    schemaVersao: 1, forma: input.formaPagamentoPretendida, pretendida, aprovada: null,
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

  const adicionais: FechamentoAdicionalRecord[] = [];

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
        },
        tx,
      ),
    );
  }

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
