import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as utils from "../disponibilidade/services/horario.utils.ts";
import * as erros from "../disponibilidade/services/errors.ts";
import * as conjuntos from "./saloes-conjuntos.ts";
import { transpilar } from "../disponibilidade/services/duracao-pacote-livre.test-apoio.ts";
import { mensagemLacuna } from "../comercial/pacote-precos.ts";

/**
 * Validação no navegador de 22/10/2026 — correções:
 * - P2-N1: festa num horário fixo que o modo livre não oferece mais cai no horário histórico preservado; a ocupação ali
 *   segue a regra da 094 (salão/capacidade), não a exclusiva antiga — outra festa em outro salão não impede a revisão;
 * - P3: a recusa por lacuna diz o pacote e o motivo.
 */
const FESTA = "00000000-0000-4000-8000-0000000000f1";
const CFG = "00000000-0000-4000-8000-0000000000c1";
const outraFesta = { fechamentoId: "outra", data: "2026-12-02", horarioInicio: "11:00:00", horarioFim: "15:00:00", configuracaoAgendaId: CFG, salaoId: "S1" };

function servico(o: { com094: boolean; conflito?: boolean; bloqueios?: unknown[] }) {
  const consultas: unknown[][] = [];
  const tx = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("to_regprocedure('public.kidmais094_conflito_ocupacao")) return { rows: [{ ok: o.com094 }] };
      if (sql.includes("kidmais094_conflito_ocupacao(f.id, $2::date")) { consultas.push(params); return { rows: [{ conflito: o.conflito ?? false }] }; }
      return { rows: [] };
    },
  };
  const m = transpilar("lib/disponibilidade/services/availability.service.ts", {
    "../../db/postgres.ts": { db: () => tx },
    "../escopo.ts": { escopoDoFechamento: async () => ({ empresaId: "e", estabelecimentoId: null }) },
    "../repositories/disponibilidade.repository.ts": {
      listarConfiguracoesAgendaAtivas: async () => [],
      listarBloqueiosAtivosPorPeriodo: async () => o.bloqueios ?? [],
      listarFechamentosConfirmadosPorPeriodo: async () => [outraFesta],
      lerRegraCapacidadeAgenda: async () => null,
    },
    "./errors.ts": erros,
    "./horario.utils.ts": utils,
    "../../agenda/saloes-conjuntos.ts": conjuntos,
  }) as unknown as { intervaloSemConflito: (d: string, i: string, f: string, tx: unknown, fid: string, cfg?: string | null) => Promise<boolean> };
  return { m, tx, consultas };
}

test("P2-N1: horário histórico com a 094 usa a regra do banco — outra festa sobreposta em outro salão não impede", async () => {
  const livre = servico({ com094: true, conflito: false });
  assert.equal(await livre.m.intervaloSemConflito("2026-12-02", "10:00", "14:00", livre.tx, FESTA, CFG), true);
  assert.deepEqual(livre.consultas[0], [FESTA, "2026-12-02", "10:00", "14:00", CFG]);
  const cheio = servico({ com094: true, conflito: true });
  assert.equal(await cheio.m.intervaloSemConflito("2026-12-02", "10:00", "14:00", cheio.tx, FESTA, CFG), false);
});

test("P2-N1: sem a 094 (ou sem o horário configurado) continua a regra exclusiva de antes; bloqueio sempre impede", async () => {
  const sem094 = servico({ com094: false });
  assert.equal(await sem094.m.intervaloSemConflito("2026-12-02", "10:00", "14:00", sem094.tx, FESTA, CFG), false, "sobreposição exclusiva");
  const semCfg = servico({ com094: true, conflito: false });
  assert.equal(await semCfg.m.intervaloSemConflito("2026-12-02", "10:00", "14:00", semCfg.tx, FESTA), false);
  assert.equal(semCfg.consultas.length, 0);
  const bloqueado = servico({ com094: true, conflito: false, bloqueios: [{ id: "b", data: "2026-12-02", diaInteiro: true, horarioInicio: null, horarioFim: null, motivo: "x", observacoes: null, criadoPorUsuarioId: null, ativo: true, criadoEm: "x" }] });
  assert.equal(await bloqueado.m.intervaloSemConflito("2026-12-02", "10:00", "14:00", bloqueado.tx, FESTA, CFG), false);
  assert.equal(bloqueado.consultas.length, 0, "o bloqueio decide antes da ocupação");
});

test("P2-N1: a revisão passa o horário configurado; com salão por festa ainda sem salão, a escolha do salão decide", () => {
  assert.match(readFileSync("lib/fechamentos/services/revisao-operacional.service.ts", "utf8"),
    /intervaloSemConflito\(op\.dataEvento, op\.horarioInicio, op\.horarioFim, tx, r\.fechamento_id, op\.configuracaoAgendaId\)/);
  const fonte = readFileSync("lib/disponibilidade/services/availability.service.ts", "utf8");
  assert.match(fonte, /WHEN f\.salao_id IS NULL AND EXISTS \(SELECT 1 FROM agenda_escopo_config c[\s\S]*?capacidade_tipo = 'POR_SALAO'\)\s*THEN false/);
});

test("P3: recusa por lacuna diz o pacote e o motivo; código desconhecido mantém a genérica", () => {
  assert.equal(mensagemLacuna("FAIXA_FORA_DO_LIMITE", "Festa Completa"),
    "Não foi possível guardar os preços: no pacote Festa Completa, há preço fora do mínimo e do máximo de convidados do pacote. Corrija esse pacote e tente de novo. Nada foi salvo.");
  assert.equal(mensagemLacuna("OUTRO", "Festa Completa"), "Não foi possível guardar os preços. Nada foi salvo.");
  assert.equal(mensagemLacuna("FAIXA_FORA_DO_LIMITE", null), "Não foi possível guardar os preços. Nada foi salvo.");
});
