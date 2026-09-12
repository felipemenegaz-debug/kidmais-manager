import type {
  PagamentoStatus,
  ParcelaPagamentoStatus,
} from "../repositories";
import type { PlanoPagamentoInput } from "./models";
import { PagamentoServiceError } from "./errors.ts";

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dinheiroParaCentavos(valor: number, campo = "valor") {
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new PagamentoServiceError(
      "PLANO_PAGAMENTO_INVALIDO",
      `${campo} deve ser maior que zero.`,
      400,
    );
  }

  const centavos = Math.round(valor * 100);
  if (centavos < 1 || centavos > 999999999999 || !Number.isSafeInteger(centavos) || valor !== centavos / 100) {
    throw new PagamentoServiceError(
      "PLANO_PAGAMENTO_INVALIDO",
      `${campo} deve estar entre 0,01 e 9.999.999.999,99, com no máximo duas casas decimais.`,
      400,
    );
  }
  return centavos;
}

export function centavosParaDinheiro(centavos: number) {
  return Math.round(centavos) / 100;
}

export function saldoMonetario(valor: number, abatimento: number) {
  return Math.max(0, Math.round(valor * 100) - Math.round(abatimento * 100)) / 100;
}

export function validarPlanoPagamento(
  valorTotalContratado: number,
  plano: PlanoPagamentoInput,
) {
  const total = dinheiroParaCentavos(valorTotalContratado, "valorTotalContratado");
  const quantidade = plano.parcelas.length;

  if (quantidade < 1 || quantidade > 60) {
    throw new PagamentoServiceError(
      "PLANO_PAGAMENTO_INVALIDO",
      "O plano deve possuir entre 1 e 60 parcelas.",
      400,
    );
  }

  if (plano.modalidade === "AVISTA" && quantidade !== 1) {
    throw new PagamentoServiceError(
      "PLANO_PAGAMENTO_INVALIDO",
      "Pagamento à vista deve possuir exatamente uma parcela.",
      400,
    );
  }

  if (plano.modalidade === "PARCELADO" && quantidade < 2) {
    throw new PagamentoServiceError(
      "PLANO_PAGAMENTO_INVALIDO",
      "Pagamento parcelado deve possuir pelo menos duas parcelas.",
      400,
    );
  }

  const confirmaReserva = plano.parcelas.filter((item) => item.confirmaReserva === true);
  if (confirmaReserva.length !== 1) {
    throw new PagamentoServiceError(
      "PLANO_PAGAMENTO_INVALIDO",
      "O plano deve possuir exatamente uma parcela que confirma a reserva.",
      400,
    );
  }

  if (plano.parcelas[0]?.confirmaReserva !== true) {
    throw new PagamentoServiceError(
      "PLANO_PAGAMENTO_INVALIDO",
      "A primeira parcela deve ser a parcela que confirma a reserva.",
      400,
    );
  }

  const parcelas = plano.parcelas.map((item, index) => {
    if (!DATA_RE.test(item.vencimento) || item.vencimento.startsWith("0000-")) {
      throw new PagamentoServiceError(
        "PLANO_PAGAMENTO_INVALIDO",
        `O vencimento da parcela ${index + 1} deve usar YYYY-MM-DD.`,
        400,
      );
    }

    const data = new Date(`${item.vencimento}T00:00:00.000Z`);
    if (Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== item.vencimento) {
      throw new PagamentoServiceError(
        "PLANO_PAGAMENTO_INVALIDO",
        `O vencimento da parcela ${index + 1} é inválido.`,
        400,
      );
    }

    return {
      numero: index + 1,
      valor: centavosParaDinheiro(dinheiroParaCentavos(item.valor, `parcela ${index + 1}`)),
      vencimento: item.vencimento,
      confirmaReserva: item.confirmaReserva === true,
    };
  });

  const soma = parcelas.reduce((acc, item) => acc + dinheiroParaCentavos(item.valor), 0);
  if (soma !== total) {
    throw new PagamentoServiceError(
      "PLANO_PAGAMENTO_INVALIDO",
      "A soma das parcelas deve ser exatamente igual ao valor total contratado.",
      400,
      {
        valorTotalContratado: centavosParaDinheiro(total),
        somaParcelas: centavosParaDinheiro(soma),
      },
    );
  }

  return {
    meioPagamento: plano.meioPagamento,
    modalidade: plano.modalidade,
    provedorPreferido: plano.provedorPreferido?.trim() || null,
    observacoes: plano.observacoes?.trim() || null,
    quantidadeParcelas: quantidade,
    parcelas,
  };
}

export function statusParcelaPorLiquido(input: {
  valorPrevisto: number;
  recebidoConfirmado: number;
  estornadoConfirmado: number;
}): ParcelaPagamentoStatus {
  const previsto = dinheiroParaCentavos(input.valorPrevisto);
  const recebido = Math.max(0, Math.round(input.recebidoConfirmado * 100));
  const estornado = Math.max(0, Math.round(input.estornadoConfirmado * 100));
  const liquido = Math.max(0, recebido - estornado);

  if (liquido === 0 && estornado > 0) return "ESTORNADA";
  if (liquido === 0) return "PENDENTE";
  if (liquido < previsto) return "PARCIALMENTE_PAGA";
  return "PAGA";
}

export function statusPagamentoPorLiquido(input: {
  valorTotalContratado: number;
  recebidoConfirmado: number;
  estornadoConfirmado: number;
}): PagamentoStatus {
  const total = dinheiroParaCentavos(input.valorTotalContratado);
  const recebido = Math.max(0, Math.round(input.recebidoConfirmado * 100));
  const estornado = Math.max(0, Math.round(input.estornadoConfirmado * 100));
  const liquido = Math.max(0, recebido - estornado);

  if (liquido === 0 && estornado > 0) return "ESTORNADO";
  if (liquido === 0) return "AGUARDANDO_PAGAMENTO";
  if (liquido < total) return "PARCIALMENTE_PAGO";
  return "QUITADO";
}
