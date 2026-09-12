import { PacoteId } from "@/components/fechamento/types";
import {
  DescontoData,
  DisponibilidadeConfig,
} from "@/lib/agenda/disponibilidade";

export const DESCONTO_DIA_UTIL = 0.15;

export const PACOTES_COM_DESCONTO_DIA_UTIL: PacoteId[] = [
  "essencial",
  "completa",
  "premium",
  "pizza_party_scienza",
];

export function pacoteTemDescontoDiaUtil(pacote: PacoteId | "") {
  return !!pacote && PACOTES_COM_DESCONTO_DIA_UTIL.includes(pacote);
}

export function ehSegundaAQuinta(dataIso: string) {
  if (!dataIso) return false;
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  const diaSemana = new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
  return diaSemana >= 1 && diaSemana <= 4;
}

export function descontoPersonalizadoDaData(
  config: DisponibilidadeConfig,
  pacote: PacoteId | "",
  dataIso: string,
  horario: "almoco" | "noite" | ""
): DescontoData | null {
  if (!pacote || !dataIso || !horario) return null;

  return (
    config.descontos?.find(
      (item) =>
        item.pacote === pacote &&
        item.data === dataIso &&
        item.horario === horario
    ) ?? null
  );
}

export function descontoEfetivo(
  config: DisponibilidadeConfig,
  pacote: PacoteId | "",
  dataIso: string,
  horario: "almoco" | "noite" | ""
) {
  const personalizado = descontoPersonalizadoDaData(
    config,
    pacote,
    dataIso,
    horario
  );

  // Desconto manual tem prioridade sobre a regra automática de 15%.
  if (personalizado) {
    const percentual = Math.max(
      0,
      Math.min(100, personalizado.percentual)
    ) / 100;

    return {
      ativo: percentual > 0,
      percentual,
      origem: "personalizado" as const,
      titulo:
        personalizado.titulo ||
        `${personalizado.percentual}% de desconto nesta data`,
    };
  }

  const automatico =
    pacoteTemDescontoDiaUtil(pacote) &&
    ehSegundaAQuinta(dataIso);

  return {
    ativo: automatico,
    percentual: automatico ? DESCONTO_DIA_UTIL : 0,
    origem: automatico ? ("dia_util" as const) : ("nenhum" as const),
    titulo: automatico
      ? "15% de desconto de segunda a quinta"
      : "",
  };
}

export function aplicarDesconto(
  valorPacote: number,
  percentual: number
) {
  const percentualSeguro = Math.max(0, Math.min(1, percentual));
  const valorDesconto = valorPacote * percentualSeguro;

  return {
    percentual: percentualSeguro,
    valorDesconto,
    valorPacoteComDesconto: valorPacote - valorDesconto,
  };
}
