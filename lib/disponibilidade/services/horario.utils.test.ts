import test from "node:test";
import assert from "node:assert/strict";
import {
  bloqueioConflitaComCandidato,
  gerarHorariosCandidatos,
  intervalosSobrepoem,
  ocupacaoConflitaComCandidato,
} from "./horario.utils.ts";
import type {
  BloqueioAgendaRecord,
  ConfiguracaoAgendaRecord,
  OcupacaoConfirmadaRecord,
} from "../repositories/models.ts";

const turno1: ConfiguracaoAgendaRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  codigo: "TURNO_1",
  nome: "Primeiro horário",
  horarioInicioPadrao: "11:00:00",
  horarioFimPadrao: "15:00:00",
  toleranciaInicioMinutos: 30,
  passoInicioMinutos: 30,
  ordemExibicao: 1,
  ativo: true,
};

function bloqueio(partial: Partial<BloqueioAgendaRecord>): BloqueioAgendaRecord {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    data: "2026-09-19",
    diaInteiro: false,
    horarioInicio: "15:00:00",
    horarioFim: "16:00:00",
    motivo: "Teste",
    observacoes: null,
    criadoPorUsuarioId: null,
    ativo: true,
    criadoEm: "2026-09-07T12:00:00.000Z",
    atualizadoEm: "2026-09-07T12:00:00.000Z",
    ...partial,
  };
}

test("gera os três horários candidatos preservando quatro horas", () => {
  const candidatos = gerarHorariosCandidatos(turno1);

  assert.deepEqual(
    candidatos.map(({ inicio, fim, ajusteMinutos }) => ({
      inicio,
      fim,
      ajusteMinutos,
    })),
    [
      { inicio: "10:30", fim: "14:30", ajusteMinutos: -30 },
      { inicio: "11:00", fim: "15:00", ajusteMinutos: 0 },
      { inicio: "11:30", fim: "15:30", ajusteMinutos: 30 },
    ],
  );
});

test("intervalos que apenas encostam na borda não conflitam", () => {
  assert.equal(intervalosSobrepoem(11 * 60, 15 * 60, 15 * 60, 16 * 60), false);
  assert.equal(intervalosSobrepoem(15 * 60, 16 * 60, 11 * 60, 15 * 60), false);
});

test("bloqueio 15h-16h afeta somente o candidato 11h30-15h30", () => {
  const candidatos = gerarHorariosCandidatos(turno1);
  const b = bloqueio({});

  assert.deepEqual(
    candidatos.map((candidato) => bloqueioConflitaComCandidato(b, candidato)),
    [false, false, true],
  );
});

test("bloqueio de dia inteiro afeta todos os candidatos", () => {
  const candidatos = gerarHorariosCandidatos(turno1);
  const b = bloqueio({
    diaInteiro: true,
    horarioInicio: null,
    horarioFim: null,
  });

  assert.deepEqual(
    candidatos.map((candidato) => bloqueioConflitaComCandidato(b, candidato)),
    [true, true, true],
  );
});


test("fechamento confirmado torna candidatos sobrepostos indisponíveis", () => {
  const candidatos = gerarHorariosCandidatos(turno1);
  const ocupacao: OcupacaoConfirmadaRecord = {
    fechamentoId: "00000000-0000-4000-8000-000000000020",
    data: "2026-09-19",
    horarioInicio: "11:00:00",
    horarioFim: "15:00:00",
  };

  assert.deepEqual(
    candidatos.map((candidato) => ocupacaoConflitaComCandidato(ocupacao, candidato)),
    [true, true, true],
  );
});
