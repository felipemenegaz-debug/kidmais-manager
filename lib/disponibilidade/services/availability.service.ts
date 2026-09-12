import type { DbExecutor } from "../../db/contracts";
import {
  listarBloqueiosAtivosPorPeriodo,
  listarConfiguracoesAgendaAtivas,
  listarFechamentosConfirmadosPorPeriodo,
  type BloqueioAgendaRecord,
  type OcupacaoConfirmadaRecord,
} from "../repositories";
import { AvailabilityServiceError } from "./errors";
import {
  adicionarDiasIso,
  bloqueioConflitaComCandidato,
  dataIsoValida,
  diferencaDiasIso,
  gerarHorariosCandidatos,
  ocupacaoConflitaComCandidato,
} from "./horario.utils";
import type {
  DisponibilidadeDataPublica,
  PeriodoDisponibilidadePublica,
} from "./models";

const MAX_DIAS_CONSULTA = 62;

export async function consultarDisponibilidadeData(
  data: string,
  customDb?: DbExecutor,
  excluirFechamentoId?: string,
): Promise<DisponibilidadeDataPublica> {
  const [resultado] = await consultarDisponibilidadePeriodo(data, data, customDb, excluirFechamentoId);
  return resultado;
}


export type RevalidarHorarioSelecionadoInput = {
  data: string;
  codigoPeriodo: string;
  inicio: string;
  fim: string;
  ajusteMinutos: number;
};

export async function revalidarHorarioSelecionado(
  input: RevalidarHorarioSelecionadoInput,
  customDb?: DbExecutor,
) {
  const disponibilidade = await consultarDisponibilidadeData(input.data, customDb);
  const periodo = disponibilidade.periodos.find(
    (item) => item.codigo === input.codigoPeriodo,
  );

  if (!periodo) {
    throw new AvailabilityServiceError(
      "TURNO_NAO_CONFIGURADO",
      "O período selecionado não possui configuração ativa.",
      409,
    );
  }

  const candidato = periodo.horarios.find(
    (item) =>
      item.inicio === input.inicio &&
      item.fim === input.fim &&
      item.ajusteMinutos === input.ajusteMinutos,
  );

  if (!candidato || candidato.status !== "DISPONIVEL") {
    throw new AvailabilityServiceError(
      "HORARIO_NAO_DISPONIVEL",
      "Este horário não está mais disponível. Escolha uma nova data ou horário para continuar.",
      409,
    );
  }

  return { periodo, candidato };
}

export async function consultarDisponibilidadePeriodo(
  inicio: string,
  fim: string,
  customDb?: DbExecutor,
  excluirFechamentoId?: string,
): Promise<DisponibilidadeDataPublica[]> {
  validarPeriodo(inicio, fim);

  const [configuracoes, bloqueios, ocupacoesConfirmadas] = customDb
    ? [
        await listarConfiguracoesAgendaAtivas(customDb),
        await listarBloqueiosAtivosPorPeriodo(inicio, fim, customDb),
        await listarFechamentosConfirmadosPorPeriodo(inicio, fim, customDb),
      ]
    : await Promise.all([
        listarConfiguracoesAgendaAtivas(),
        listarBloqueiosAtivosPorPeriodo(inicio, fim),
        listarFechamentosConfirmadosPorPeriodo(inicio, fim),
      ]);

  if (configuracoes.length === 0) {
    throw new AvailabilityServiceError(
      "AGENDA_NAO_CONFIGURADA",
      "A agenda ainda não possui horários ativos configurados.",
      503,
    );
  }

  const porData = new Map<string, BloqueioAgendaRecord[]>();
  for (const bloqueio of bloqueios) {
    const lista = porData.get(bloqueio.data) ?? [];
    lista.push(bloqueio);
    porData.set(bloqueio.data, lista);
  }

  const ocupacoesPorData = new Map<string, OcupacaoConfirmadaRecord[]>();
  for (const ocupacao of ocupacoesConfirmadas) {
    if (ocupacao.fechamentoId === excluirFechamentoId) continue;
    const lista = ocupacoesPorData.get(ocupacao.data) ?? [];
    lista.push(ocupacao);
    ocupacoesPorData.set(ocupacao.data, lista);
  }

  const dias = diferencaDiasIso(inicio, fim);
  return Array.from({ length: dias + 1 }, (_, index) => {
    const data = adicionarDiasIso(inicio, index);
    const bloqueiosDoDia = porData.get(data) ?? [];
    const ocupacoesDoDia = ocupacoesPorData.get(data) ?? [];

    return {
      data,
      periodos: configuracoes.map((config) =>
        calcularPeriodoPublico(config, bloqueiosDoDia, ocupacoesDoDia),
      ),
    };
  });
}

function calcularPeriodoPublico(
  config: Awaited<ReturnType<typeof listarConfiguracoesAgendaAtivas>>[number],
  bloqueios: BloqueioAgendaRecord[],
  ocupacoesConfirmadas: OcupacaoConfirmadaRecord[],
): PeriodoDisponibilidadePublica {
  const horarios = gerarHorariosCandidatos(config).map((candidato) => {
    const indisponivel =
      bloqueios.some((bloqueio) =>
        bloqueioConflitaComCandidato(bloqueio, candidato),
      ) ||
      ocupacoesConfirmadas.some((ocupacao) =>
        ocupacaoConflitaComCandidato(ocupacao, candidato),
      );

    return {
      inicio: candidato.inicio,
      fim: candidato.fim,
      ajusteMinutos: candidato.ajusteMinutos,
      status: indisponivel ? ("INDISPONIVEL" as const) : ("DISPONIVEL" as const),
    };
  });

  return {
    configuracaoId: config.id,
    codigo: config.codigo,
    nome: config.nome,
    horarioInicioPadrao: config.horarioInicioPadrao.slice(0, 5),
    horarioFimPadrao: config.horarioFimPadrao.slice(0, 5),
    status: horarios.some((item) => item.status === "DISPONIVEL")
      ? "DISPONIVEL"
      : "INDISPONIVEL",
    horarios,
  };
}

function validarPeriodo(inicio: string, fim: string) {
  if (!dataIsoValida(inicio) || !dataIsoValida(fim)) {
    throw new AvailabilityServiceError(
      "DATA_INVALIDA",
      "Informe datas válidas no formato YYYY-MM-DD.",
      400,
    );
  }

  const dias = diferencaDiasIso(inicio, fim);
  if (dias < 0) {
    throw new AvailabilityServiceError(
      "PERIODO_INVALIDO",
      "A data final deve ser igual ou posterior à data inicial.",
      400,
    );
  }

  if (dias + 1 > MAX_DIAS_CONSULTA) {
    throw new AvailabilityServiceError(
      "PERIODO_MUITO_LONGO",
      `Consulte no máximo ${MAX_DIAS_CONSULTA} dias por requisição.`,
      400,
    );
  }
}
