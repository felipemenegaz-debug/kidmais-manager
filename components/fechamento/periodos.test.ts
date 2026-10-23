import assert from "node:assert/strict";
import test from "node:test";
import { periodoDoTurno } from "./periodos.ts";

// 2c-2: almoço/noite da conversa (IA, links antigos) nos horários configurados da empresa.
test("almoço/noite: TURNO_1/TURNO_2 quando existem; senão o mais cedo ou o mais tarde; horário único vale para os dois", () => {
  const p = (codigo: string, inicio: string) => ({ codigo, horarioInicioPadrao: inicio });
  const turnos = [p("TURNO_2", "17:00"), p("TURNO_1", "11:00")];
  assert.equal(periodoDoTurno(turnos, "almoco")?.codigo, "TURNO_1");
  assert.equal(periodoDoTurno(turnos, "noite")?.codigo, "TURNO_2");
  const proprios = [p("HORARIO_2", "15:00"), p("HORARIO_1", "10:00"), p("HORARIO_3", "20:00")];
  assert.equal(periodoDoTurno(proprios, "almoco")?.codigo, "HORARIO_1");
  assert.equal(periodoDoTurno(proprios, "noite")?.codigo, "HORARIO_3");
  assert.equal(periodoDoTurno([p("HORARIO_LIVRE", "00:00")], "noite")?.codigo, "HORARIO_LIVRE");
  assert.equal(periodoDoTurno(proprios, "tarde"), undefined);
  assert.equal(periodoDoTurno([], "almoco"), undefined);
});

// Navegador de 22/10 (P3): o horário técnico do modo livre aparece pelo nome, sem a faixa 00:00–23:59.
test("rótulo do horário livre sem a faixa técnica; horários fixos com a faixa", async () => {
  const { rotuloPeriodo } = await import("./periodos.ts");
  assert.equal(rotuloPeriodo({ codigo: "HORARIO_LIVRE", nome: "Horário livre", horarioInicioPadrao: "00:00", horarioFimPadrao: "23:59" }), "Horário livre");
  assert.equal(rotuloPeriodo({ codigo: "HORARIO_LIVRE", nome: "", horarioInicioPadrao: "00:00", horarioFimPadrao: "23:59" }), "Horário livre");
  assert.equal(rotuloPeriodo({ codigo: "TURNO_1", nome: "Almoço", horarioInicioPadrao: "11:00", horarioFimPadrao: "15:00" }), "Almoço · 11:00–15:00");
});
