/**
 * Janela de horário das automações, no fuso da regra (padrão America/Sao_Paulo). Puro e testável.
 * Envio/tarefa só acontece dentro de [início, fim) em dia permitido; fora disso, vai para o próximo início permitido.
 */
export type Janela = { inicio: string; fim: string; fuso: string; fimDeSemana: boolean };

type Partes = { ano: number; mes: number; dia: number; hora: number; minuto: number; diaSemana: number };

function partes(instante: Date, fuso: string): Partes {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(instante).map((x) => [x.type, x.value]));
  const dias: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { ano: Number(p.year), mes: Number(p.month), dia: Number(p.day), hora: Number(p.hour), minuto: Number(p.minute), diaSemana: dias[p.weekday] ?? 0 };
}

function minutos(hhmm: string) {
  const [h, m] = hhmm.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

/** Diferença (ms) entre o relógio local do fuso e UTC naquele instante. */
function deslocamento(instante: Date, fuso: string) {
  const p = partes(instante, fuso);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto);
  return comoUtc - Math.floor(instante.getTime() / 60_000) * 60_000;
}

/** Instante UTC do horário local (ano, mês, dia, hh:mm) no fuso. */
function instanteLocal(ano: number, mes: number, dia: number, hhmm: string, fuso: string) {
  const m = minutos(hhmm);
  const palpite = new Date(Date.UTC(ano, mes - 1, dia, Math.floor(m / 60), m % 60));
  return new Date(palpite.getTime() - deslocamento(palpite, fuso));
}

export function dentroDaJanela(instante: Date, j: Janela) {
  const p = partes(instante, j.fuso);
  if (!j.fimDeSemana && (p.diaSemana === 0 || p.diaSemana === 6)) return false;
  const agora = p.hora * 60 + p.minuto;
  return agora >= minutos(j.inicio) && agora < minutos(j.fim);
}

/** O próprio instante, se permitido; senão o próximo início de janela em dia permitido (até 8 dias à frente). */
export function proximoHorarioPermitido(instante: Date, j: Janela): Date {
  if (dentroDaJanela(instante, j)) return instante;
  const p = partes(instante, j.fuso);
  for (let d = 0; d <= 8; d++) {
    const base = new Date(Date.UTC(p.ano, p.mes - 1, p.dia + d, 12));
    const candidato = instanteLocal(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), j.inicio, j.fuso);
    if (candidato.getTime() > instante.getTime() && dentroDaJanela(candidato, j)) return candidato;
  }
  throw new Error("Janela de horário sem dia permitido.");
}

export function dataLocal(instante: Date, fuso = "America/Sao_Paulo") {
  const p = partes(instante, fuso);
  return `${p.ano}-${String(p.mes).padStart(2, "0")}-${String(p.dia).padStart(2, "0")}`;
}

export function fusoValido(fuso: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: fuso }); return /^[A-Za-z]+(\/[A-Za-z_]+){1,2}$/.test(fuso); } catch { return false; }
}
