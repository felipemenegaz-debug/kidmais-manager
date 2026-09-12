import type { BloqueioAgendaRecord, ConfiguracaoAgendaRecord, OcupacaoConfirmadaRecord } from "../repositories";

const DATA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dataIsoValida(data: string) {
  if (!DATA_ISO_RE.test(data)) return false;
  const [ano, mes, dia] = data.split("-").map(Number);
  const parsed = new Date(Date.UTC(ano, mes - 1, dia));
  return (
    parsed.getUTCFullYear() === ano &&
    parsed.getUTCMonth() === mes - 1 &&
    parsed.getUTCDate() === dia
  );
}

export function adicionarDiasIso(data: string, dias: number) {
  const [ano, mes, dia] = data.split("-").map(Number);
  const value = new Date(Date.UTC(ano, mes - 1, dia + dias));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

export function diferencaDiasIso(inicio: string, fim: string) {
  const [ai, mi, di] = inicio.split("-").map(Number);
  const [af, mf, df] = fim.split("-").map(Number);
  const a = Date.UTC(ai, mi - 1, di);
  const b = Date.UTC(af, mf - 1, df);
  return Math.floor((b - a) / 86_400_000);
}

export function horaParaMinutos(hora: string) {
  const [h, m] = hora.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`Horário inválido: ${hora}`);
  }
  return h * 60 + m;
}

export function minutosParaHora(total: number) {
  if (!Number.isInteger(total) || total < 0 || total >= 24 * 60) {
    throw new Error(`Minutos fora do mesmo dia: ${total}`);
  }
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function intervalosSobrepoem(
  inicioA: number,
  fimA: number,
  inicioB: number,
  fimB: number,
) {
  return inicioA < fimB && fimA > inicioB;
}

export type HorarioCandidatoCalculado = {
  inicio: string;
  fim: string;
  inicioMinutos: number;
  fimMinutos: number;
  ajusteMinutos: number;
};

export function gerarHorariosCandidatos(
  config: ConfiguracaoAgendaRecord,
): HorarioCandidatoCalculado[] {
  const inicioBase = horaParaMinutos(config.horarioInicioPadrao);
  const fimBase = horaParaMinutos(config.horarioFimPadrao);
  const duracao = fimBase - inicioBase;
  const tolerancia = config.toleranciaInicioMinutos;
  const passo = config.passoInicioMinutos;
  const candidatos: HorarioCandidatoCalculado[] = [];

  for (let ajuste = -tolerancia; ajuste <= tolerancia; ajuste += passo) {
    const inicio = inicioBase + ajuste;
    const fim = inicio + duracao;

    if (inicio < 0 || fim >= 24 * 60) continue;

    candidatos.push({
      inicio: minutosParaHora(inicio),
      fim: minutosParaHora(fim),
      inicioMinutos: inicio,
      fimMinutos: fim,
      ajusteMinutos: ajuste,
    });
  }

  return candidatos;
}

export function bloqueioConflitaComCandidato(
  bloqueio: BloqueioAgendaRecord,
  candidato: Pick<HorarioCandidatoCalculado, "inicioMinutos" | "fimMinutos">,
) {
  if (bloqueio.diaInteiro) return true;
  if (!bloqueio.horarioInicio || !bloqueio.horarioFim) return true;

  return intervalosSobrepoem(
    candidato.inicioMinutos,
    candidato.fimMinutos,
    horaParaMinutos(bloqueio.horarioInicio),
    horaParaMinutos(bloqueio.horarioFim),
  );
}


export function ocupacaoConflitaComCandidato(
  ocupacao: OcupacaoConfirmadaRecord,
  candidato: Pick<HorarioCandidatoCalculado, "inicioMinutos" | "fimMinutos">,
) {
  return intervalosSobrepoem(
    candidato.inicioMinutos,
    candidato.fimMinutos,
    horaParaMinutos(ocupacao.horarioInicio),
    horaParaMinutos(ocupacao.horarioFim),
  );
}
