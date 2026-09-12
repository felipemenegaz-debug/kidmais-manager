import {
  PACOTES,
  PRECOS_PIZZA_PARTY_SCIENZA,
  PRECOS_TRADICIONAIS_NOBRE,
  PRECOS_TRADICIONAIS_PADRAO,
} from "./data";
import { FormaPagamento, PacoteId } from "./types";
import { calcularCondicaoComercial } from "../../lib/comercial/condicao-pagamento";

export function moedaParaNumero(valor: string): number {
  const limpo = valor.replace(/\D/g, "");
  return Number(limpo || 0) / 100;
}

export function numeroParaMoeda(valor: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(valor);
}

export function formatarMoedaDigitada(valor: string): string {
  return numeroParaMoeda(moedaParaNumero(valor));
}

export function descontoPagamento(forma: FormaPagamento | ""): number {
  if (forma === "pix_avista") return 0.1;
  if (forma === "pix_parcelado") return 0.03;
  return 0;
}

export function calcularTotalPagamento(
  valorAprovado: number,
  forma: FormaPagamento | ""
) {
  const desconto = descontoPagamento(forma);
  const valores = calcularCondicaoComercial(valorAprovado,
    forma === "pix_avista" ? "PIX_AVISTA" : forma === "pix_parcelado" ? "PIX_PARCELADO" : "CARTAO_CIELO");
  return {
    desconto,
    valorDesconto: valores.valorDescontoFormaPagamento,
    total: valores.valorFinalContrato,
  };
}

export function intervaloHorario(
  base: "almoco" | "noite" | "",
  ajuste: "-30" | "0" | "30"
) {
  if (!base) return null;

  const inicioBase = base === "almoco" ? 11 * 60 : 17 * 60;
  const ajusteMin = Number(ajuste);
  const inicio = inicioBase + ajusteMin;
  const fim = inicio + 4 * 60;

  const fmt = (minutos: number) => {
    const h = Math.floor(minutos / 60);
    const m = minutos % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };

  return { inicio: fmt(inicio), fim: fmt(fim) };
}

export function horarioExibicao(
  base: "almoco" | "noite" | "",
  ajuste: "-30" | "0" | "30"
) {
  const intervalo = intervaloHorario(base, ajuste);
  if (!intervalo) return "";
  return `${intervalo.inicio} às ${intervalo.fim}`;
}

export function proximaFaixaTradicional(convidados: number) {
  const faixas = [50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];
  return faixas.find((faixa) => convidados <= faixa) ?? 150;
}

export type CategoriaHorarioReferencia = "PADRAO" | "NOBRE";

export function categoriaHorarioReferencia(
  dataFesta?: string,
  horarioBase?: "almoco" | "noite" | "",
): CategoriaHorarioReferencia {
  if (!dataFesta || !horarioBase) return "PADRAO";

  const partes = dataFesta.split("-").map(Number);
  if (partes.length !== 3 || partes.some((parte) => !Number.isFinite(parte))) {
    return "PADRAO";
  }

  const [ano, mes, dia] = partes;
  const diaSemana = new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();

  // Mesma regra da migration 006:
  // NOBRE = sábado TURNO_2 ou domingo TURNO_1.
  if (diaSemana === 6 && horarioBase === "noite") return "NOBRE";
  if (diaSemana === 0 && horarioBase === "almoco") return "NOBRE";
  return "PADRAO";
}

export function precoReferenciaPacote(
  pacoteId: PacoteId | "",
  convidados: number,
  dataFesta?: string,
  horarioBase?: "almoco" | "noite" | "",
): number | null {
  if (!pacoteId || convidados < 1) return null;

  const pacote = PACOTES.find((item) => item.id === pacoteId);
  if (!pacote) return null;

  if (pacoteId === "pocket") {
    return Math.max(convidados, 20) * 190;
  }

  if (pacoteId === "mini") {
    return Math.max(convidados, 30) * 170;
  }

  if (pacoteId === "compacta") {
    return 6490;
  }

  if (pacoteId === "pizza_party_scienza") {
    const faixa = PRECOS_PIZZA_PARTY_SCIENZA.find(
      (item) => convidados <= item.ate
    );
    return faixa?.valor ?? null;
  }

  if (
    pacoteId === "essencial" ||
    pacoteId === "completa" ||
    pacoteId === "premium"
  ) {
    const faixa = proximaFaixaTradicional(convidados);
    const categoria = categoriaHorarioReferencia(dataFesta, horarioBase);
    const matriz =
      categoria === "NOBRE"
        ? PRECOS_TRADICIONAIS_NOBRE
        : PRECOS_TRADICIONAIS_PADRAO;
    return matriz[faixa][pacoteId];
  }

  return pacote.precoInicial;
}
