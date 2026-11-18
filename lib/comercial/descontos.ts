import { PacoteId } from "@/components/fechamento/types";
import {
  DescontoData,
  DisponibilidadeConfig,
} from "@/lib/agenda/disponibilidade";
import { aindaPodeValer, avisoEconomize, regraDoDia } from "@/lib/comercial/descontos-dia";

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

/**
 * `automatico = false`: empresa sem a regra de -15% de segunda a quinta (só descontos manuais da data).
 * D4: com `config.descontosEmpresa` (endereço /b/<código> de buffet que não é a Kidmais), o desconto vem das regras da
 * empresa, escolhidas como no servidor (horário específico antes do genérico; `configuracaoId` do horário).
 */
export function descontoEfetivo(
  config: DisponibilidadeConfig,
  pacote: PacoteId | "",
  dataIso: string,
  horario: "almoco" | "noite" | "",
  automatico = true,
  configuracaoId?: string | null,
) {
  if (config.descontosEmpresa) {
    const regra = pacote && dataIso ? regraDoDia(config.descontosEmpresa[pacote] ?? [], dataIso, configuracaoId) : null;
    const pontos = regra ? Math.max(0, Math.min(100, regra.percentual)) : 0;
    return {
      ativo: pontos > 0,
      percentual: pontos / 100,
      origem: pontos > 0 ? ("empresa" as const) : ("nenhum" as const),
      titulo: pontos > 0 ? regra!.titulo || `${pontos}% de desconto nesta data` : "",
    };
  }

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

  const diaUtil =
    automatico &&
    pacoteTemDescontoDiaUtil(pacote) &&
    ehSegundaAQuinta(dataIso);

  return {
    ativo: diaUtil,
    percentual: diaUtil ? DESCONTO_DIA_UTIL : 0,
    origem: diaUtil ? ("dia_util" as const) : ("nenhum" as const),
    titulo: diaUtil
      ? "15% de desconto de segunda a quinta"
      : "",
  };
}

/**
 * Aviso "Economize" do pacote. Com regras da empresa: frase delas (ou null, sem desconto). Sem regras da empresa: o
 * aviso de sempre (15% de segunda a quinta) quando a regra automática vale para o pacote.
 */
export function avisoDescontoDoPacote(
  config: DisponibilidadeConfig,
  pacote: PacoteId | "",
  automatico: boolean,
  hojeIso: string,
): { titulo: string; selo: string } | null {
  if (config.descontosEmpresa) {
    const regras = pacote ? config.descontosEmpresa[pacote] ?? [] : [];
    const titulo = avisoEconomize(regras, hojeIso);
    if (!titulo) return null;
    const pcts = [...new Set(regras.filter((r) => r.percentual > 0 && aindaPodeValer(r, hojeIso)).map((r) => r.percentual))];
    return { titulo, selo: pcts.length === 1 ? `-${pcts[0]}%` : "o percentual do dia" };
  }
  return automatico && pacoteTemDescontoDiaUtil(pacote)
    ? { titulo: "Economize 15% escolhendo de segunda a quinta.", selo: "-15%" }
    : null;
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
