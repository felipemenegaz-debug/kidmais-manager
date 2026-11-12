import type { HorarioBase, PacoteId } from "../../components/fechamento/types.ts";

export type StatusCalendario =
  | "disponivel"
  | "consulta"
  | "excecao"
  | "indisponivel";

export type AgendaSlot = {
  data: string;
  horario: HorarioBase;
  status: "ocupado" | "bloqueado";
  motivo?: string;
};

export type PacoteOverride = {
  data: string;
  horario: HorarioBase;
  pacote: PacoteId;
  status: "liberado" | "consulta" | "excecao" | "bloqueado";
  motivo?: string;
};

export type DescontoData = {
  data: string;
  horario: HorarioBase;
  pacote: PacoteId;
  percentual: number;
  titulo?: string;
};

export type DisponibilidadeConfig = {
  agenda: AgendaSlot[];
  pacoteOverrides: PacoteOverride[];
  descontos: DescontoData[];
};

export const CONFIG_VAZIA: DisponibilidadeConfig = {
  agenda: [],
  pacoteOverrides: [],
  descontos: [],
};

export function diaSemanaUTC(dataIso: string) {
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
}

export function hojeIsoLocal() {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = String(agora.getMonth() + 1).padStart(2, "0");
  const dia = String(agora.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

export function regraPadraoPacote(
  pacote: PacoteId,
  dataIso: string,
  horario: HorarioBase | ""
): StatusCalendario {
  const dia = diaSemanaUTC(dataIso); // 0 dom, 1 seg ... 6 sáb

  // Pacotes tradicionais: elegíveis quando a agenda operacional estiver livre.
  if (
    pacote === "essencial" ||
    pacote === "completa" ||
    pacote === "premium"
  ) {
    return "disponivel";
  }

  // Pizza Party depende de confirmação operacional da Kidmais/Scienza.
  // Agenda livre, sozinha, nunca transforma o pacote em disponibilidade automática.
  if (pacote === "pizza_party_scienza") {
    return "consulta";
  }

  // Pocket: segunda a quinta nos dois períodos e sexta no primeiro período.
  if (pacote === "pocket") {
    if (dia >= 1 && dia <= 4) return "disponivel";
    if (dia === 5 && horario === "almoco") return "disponivel";
    return "indisponivel";
  }

  // Mini: segunda a quinta nos dois períodos e sexta no primeiro período.
  if (pacote === "mini") {
    if (dia >= 1 && dia <= 4) return "disponivel";
    if (dia === 5 && horario === "almoco") return "disponivel";
    return "indisponivel";
  }

  // Compacta: disponível conforme agenda, exceto sábado no segundo período.
  if (pacote === "compacta") {
    if (dia === 6 && horario === "noite") return "indisponivel";
    return "disponivel";
  }

  return "indisponivel";
}

/**
 * Regra semanal configurada pela PRÓPRIA empresa para o pacote (regras_disponibilidade_pacote):
 * dia ISO (1 = segunda … 7 = domingo), período e vigência. Mesma fonte que o servidor usa na cotação.
 * `configuracaoId` identifica o horário configurado (qualquer quantidade); `horario` é o legado almoco/noite,
 * "" para horários que não são TURNO_1/TURNO_2.
 */
export type RegraPacoteEmpresa = {
  dia: number;
  horario: HorarioBase | "";
  configuracaoId?: string;
  estado: "DISPONIVEL" | "INDISPONIVEL" | "SOB_CONSULTA";
  vigenciaInicio: string;
  vigenciaFim: string | null;
};

/**
 * Status pela configuração da empresa, com a mesma escolha do servidor: a regra ativa de maior início de
 * vigência na data. Sem regra = indisponível (o servidor também recusa sem elegibilidade configurada).
 */
export function regraDaEmpresa(
  regras: readonly RegraPacoteEmpresa[],
  dataIso: string,
  horario: HorarioBase | "",
  configuracaoId?: string
): StatusCalendario {
  const dia = diaSemanaUTC(dataIso) || 7;
  // Com o horário configurado, casa pelo id; regra sem id (legado) só casa pelo almoco/noite.
  const mesmoHorario = (regra: RegraPacoteEmpresa) =>
    configuracaoId && regra.configuracaoId
      ? regra.configuracaoId === configuracaoId
      : !!horario && regra.horario === horario;
  const vigente = regras
    .filter(
      (regra) =>
        regra.dia === dia &&
        mesmoHorario(regra) &&
        regra.vigenciaInicio <= dataIso &&
        (regra.vigenciaFim === null || regra.vigenciaFim >= dataIso)
    )
    .sort((a, b) => b.vigenciaInicio.localeCompare(a.vigenciaInicio))[0];
  if (!vigente) return "indisponivel";
  if (vigente.estado === "DISPONIVEL") return "disponivel";
  return vigente.estado === "SOB_CONSULTA" ? "consulta" : "indisponivel";
}

/**
 * `regrasDaEmpresa`: no endereço da empresa (/b/<código>), as regras dela para o pacote — nenhuma regra fixa
 * da Kidmais (Pocket, Mini, Compacta, Pizza Party) se aplica pelo código. Ausente (null/undefined) = endereço
 * atual da Kidmais, com o comportamento legado inalterado.
 */
export function statusDataPacote(
  config: DisponibilidadeConfig,
  pacote: PacoteId,
  dataIso: string,
  horario: HorarioBase | "",
  regrasDaEmpresa?: readonly RegraPacoteEmpresa[] | null,
  /** Horário configurado (configuracao_agenda.id): quando presente, as regras da empresa casam por ele. */
  configuracaoId?: string
): {
  status: StatusCalendario;
  origem: "agenda" | "override" | "regra";
  motivo?: string;
} {
  // 1º prioridade: ocupação física do salão.
  const agenda = config.agenda.find(
    (item) => item.data === dataIso && item.horario === horario
  );

  if (agenda) {
    return {
      status: "indisponivel",
      origem: "agenda",
      motivo:
        agenda.motivo ||
        (agenda.status === "ocupado"
          ? "Este horário já está ocupado."
          : "Este horário foi bloqueado pela Kidmais."),
    };
  }

  // 2º prioridade: decisão manual da Kidmais para pacote/data/horário.
  const override = config.pacoteOverrides.find(
    (item) =>
      item.data === dataIso &&
      item.horario === horario &&
      item.pacote === pacote
  );

  if (override) {
    return {
      status:
        override.status === "liberado"
          ? "disponivel"
          : override.status === "consulta"
            ? "consulta"
            : override.status === "excecao"
              ? "excecao"
              : "indisponivel",
      origem: "override",
      motivo: override.motivo,
    };
  }

  // 3º prioridade (empresa): a configuração dela para o pacote.
  if (regrasDaEmpresa) {
    const daEmpresa = regraDaEmpresa(regrasDaEmpresa, dataIso, horario, configuracaoId);
    if (daEmpresa === "indisponivel")
      return { status: daEmpresa, origem: "regra", motivo: "Este pacote não está disponível neste dia e período, conforme a configuração do buffet." };
    if (daEmpresa === "consulta")
      return { status: daEmpresa, origem: "regra", motivo: "Este pacote precisa ser confirmado pelo buffet para este dia e período." };
    return { status: daEmpresa, origem: "regra" };
  }

  // 3º prioridade (Kidmais, endereço atual): regra padrão do pacote.
  const status = regraPadraoPacote(pacote, dataIso, horario);

  if (pacote === "compacta" && status === "indisponivel") {
    return {
      status,
      origem: "regra",
      motivo: "A Festa Compacta não está disponível aos sábados no segundo período.",
    };
  }

  if (pacote === "pizza_party_scienza" && status === "consulta") {
    return {
      status,
      origem: "regra",
      motivo: "O Pizza Party precisa ser confirmado pela equipe Kidmais/Scienza.",
    };
  }

  return { status, origem: "regra" };
}

/** `kidmais` falso (/b/<código>): “consultar” aponta para o buffet do endereço, não para a Kidmais. */
export function statusLabel(status: StatusCalendario, kidmais = true) {
  if (status === "disponivel") return "Disponível";
  if (status === "consulta") return kidmais ? "Consultar Kidmais" : "Consultar o buffet";
  if (status === "excecao") return "Exceção";
  return "Indisponível";
}

export function horarioAlternativo(horario: HorarioBase): HorarioBase {
  return horario === "almoco" ? "noite" : "almoco";
}
