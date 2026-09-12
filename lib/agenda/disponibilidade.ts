import { HorarioBase, PacoteId } from "@/components/fechamento/types";

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
  horario: HorarioBase
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

  // Pocket: somente segunda a quinta.
  if (pacote === "pocket") {
    return dia >= 1 && dia <= 4 ? "disponivel" : "indisponivel";
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

export function statusDataPacote(
  config: DisponibilidadeConfig,
  pacote: PacoteId,
  dataIso: string,
  horario: HorarioBase
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

  // 3º prioridade: regra padrão do pacote.
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

export function statusLabel(status: StatusCalendario) {
  if (status === "disponivel") return "Disponível";
  if (status === "consulta") return "Consultar Kidmais";
  if (status === "excecao") return "Exceção";
  return "Indisponível";
}

export function horarioAlternativo(horario: HorarioBase): HorarioBase {
  return horario === "almoco" ? "noite" : "almoco";
}
