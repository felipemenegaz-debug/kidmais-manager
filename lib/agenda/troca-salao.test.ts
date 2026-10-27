import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import { lerSalaoDaFesta, trocarSalaoDaFesta } from "./troca-salao.ts";

// 094: a equipe troca o salão da festa por outro livre e permitido (decisão de Felipe em 22/10/2026).
const EMPRESA = "11111111-1111-4111-8111-111111111111";
const FESTA = "22222222-2222-4222-8222-222222222222";
const S1 = "33333333-3333-4333-8333-333333333331";
const S2 = "33333333-3333-4333-8333-333333333332";
const S3 = "33333333-3333-4333-8333-333333333333";
const ctx = { empresaId: EMPRESA, usuarioId: "44444444-4444-4444-8444-444444444444", requestId: "r-1" };

type Cenario = {
  instalada?: boolean;
  porSalao?: boolean;
  existe?: boolean;
  status?: string;
  opcoes?: Array<{ id: string; nome: string; livre: boolean; permitido: boolean }>;
  /** S-E: contrato assinado vigente que fixa o salão e revisão aberta. */
  contrato?: { fixa: { id: string; nome: string } | null; rid: string | null; estado: string | null; sid: string | null; snome: string | null };
  serveNoDestino?: boolean;
};

function banco(c: Cenario = {}) {
  const sqls: Array<{ sql: string; valores: readonly unknown[] }> = [];
  let salaoAtual: string | null = S1;
  const nomes: Record<string, string> = { [S1]: "Kids", [S2]: "Jardim", [S3]: "Teen" };
  const opcoes = c.opcoes ?? [
    { id: S1, nome: "Kids", livre: true, permitido: true },
    { id: S2, nome: "Jardim", livre: true, permitido: true },
    { id: S3, nome: "Teen", livre: false, permitido: true },
  ];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, valores: readonly unknown[] = []) {
      sqls.push({ sql, valores });
      const r = (rows: object[]) => ({ rows, rowCount: rows.length }) as DbQueryResult<Row>;
      if (sql.includes("to_regprocedure")) return r([{ ok: c.instalada ?? true }]);
      if (sql.includes("AS por_salao")) {
        if (c.existe === false || valores[1] !== EMPRESA) return r([]);
        return r([{ id: FESTA, status: c.status ?? "CONFIRMADO", data_evento: "2026-11-21", salao_id: salaoAtual,
          salao_nome: salaoAtual ? nomes[salaoAtual] : null, por_salao: c.porSalao ?? true }]);
      }
      if (sql.includes("AS permitido")) return r(opcoes);
      if (sql.includes("FROM contratos c") && sql.includes("contrato_fluxos")) return r(c.contrato ? [c.contrato] : []);
      if (sql.includes("attname = 'convidados_minimo'")) return r([{ ok: true }]);
      if (sql.includes("kidmais098_salao_elegivel") && sql.includes("to_regprocedure")) return r([{ ok: false }]);
      if (sql.includes("FROM fechamento_revisoes r JOIN fechamentos f")) return r([{ ok: c.serveNoDestino ?? true }]);
      if (sql.startsWith("UPDATE fechamento_revisoes SET salao_id")) return r([{}]);
      if (sql.includes("UPDATE fechamento_revisoes") && sql.includes("kidmais_hash_revisao_operacional")) return r([]);
      if (sql.startsWith("UPDATE fechamentos SET salao_id")) { salaoAtual = String(valores[1]); return r([]); }
      if (sql.includes("kidmais_lock_datas_revisao") || sql.includes("INSERT INTO auditoria")) return r([]);
      throw new Error("consulta inesperada: " + sql);
    },
  };
  return { tx, sqls, escritas: () => sqls.filter((q) => /^\s*(UPDATE|INSERT)/.test(q.sql)) };
}

test("sem a 094 instalada: leitura nula e troca recusada sem escrever", async () => {
  const b = banco({ instalada: false });
  assert.equal(await lerSalaoDaFesta(b.tx, EMPRESA, FESTA), null);
  await assert.rejects(trocarSalaoDaFesta(b.tx, ctx, FESTA, S2), (e: { httpStatus?: number }) => e.httpStatus === 409);
  assert.equal(b.escritas().length, 0);
  assert.ok(b.sqls.every((q) => q.sql.includes("to_regprocedure")));
});

test("escopo que não é por salão: leitura nula", async () => {
  assert.equal(await lerSalaoDaFesta(banco({ porSalao: false }).tx, EMPRESA, FESTA), null);
});

test("festa de outra empresa: 404 sem escrever", async () => {
  const b = banco();
  await assert.rejects(lerSalaoDaFesta(b.tx, "55555555-5555-4555-8555-555555555555", FESTA), (e: { httpStatus?: number }) => e.httpStatus === 404);
  await assert.rejects(trocarSalaoDaFesta(b.tx, { ...ctx, empresaId: "55555555-5555-4555-8555-555555555555" }, FESTA, S2),
    (e: { httpStatus?: number }) => e.httpStatus === 404);
  assert.equal(b.escritas().length, 0);
});

test("leitura: salão atual e opções com livre/permitido", async () => {
  const lido = await lerSalaoDaFesta(banco().tx, EMPRESA, FESTA);
  assert.deepEqual(lido?.salaoAtual, { id: S1, nome: "Kids" });
  assert.equal(lido?.confirmada, true, "festa confirmada (a tela não promete escolha na confirmação)");
  assert.deepEqual(lido?.opcoes.map((o) => [o.nome, o.livre, o.permitido]), [["Kids", true, true], ["Jardim", true, true], ["Teen", false, true]]);
});

test("recusa salão ocupado, não permitido, de fora do escopo e festa cancelada, sem UPDATE", async () => {
  const ocupado = banco();
  await assert.rejects(trocarSalaoDaFesta(ocupado.tx, ctx, FESTA, S3), /(^|: )Teen não está livre nesse horário\.$/);
  assert.equal(ocupado.escritas().length, 0);

  const proibido = banco({ opcoes: [{ id: S2, nome: "Jardim", livre: true, permitido: false }] });
  await assert.rejects(trocarSalaoDaFesta(proibido.tx, ctx, FESTA, S2), /não é permitido/);
  assert.equal(proibido.escritas().length, 0);

  const fora = banco();
  await assert.rejects(trocarSalaoDaFesta(fora.tx, ctx, FESTA, "66666666-6666-4666-8666-666666666666"),
    (e: { httpStatus?: number }) => e.httpStatus === 404);
  assert.equal(fora.escritas().length, 0);

  const cancelada = banco({ status: "CANCELADO" });
  await assert.rejects(trocarSalaoDaFesta(cancelada.tx, ctx, FESTA, S2), /cancelada/);
  assert.equal(cancelada.escritas().length, 0);
});

test("troca: fechamento travado, lock das datas, UPDATE e auditoria, nessa ordem (mesma ordem do pagamento)", async () => {
  const b = banco();
  const depois = await trocarSalaoDaFesta(b.tx, ctx, FESTA, S2);
  assert.deepEqual(depois?.salaoAtual, { id: S2, nome: "Jardim" });
  const i = (pred: (s: string) => boolean) => b.sqls.findIndex((q) => pred(q.sql));
  const lock = i((s) => s.includes("kidmais_lock_datas_revisao"));
  const trava = i((s) => s.includes("FOR UPDATE OF f"));
  const update = i((s) => s.startsWith("UPDATE fechamentos SET salao_id"));
  const auditoria = i((s) => s.includes("INSERT INTO auditoria"));
  // Parecer do Astra (P2): fechamento antes das datas, como pagamento e revisão (sem espera circular).
  assert.ok(trava >= 0 && trava < lock && lock < update && update < auditoria, JSON.stringify({ lock, trava, update, auditoria }));
  assert.deepEqual(b.sqls[lock]?.valores, [FESTA, "2026-11-21"]);
  assert.deepEqual(b.sqls[update]?.valores, [FESTA, S2, EMPRESA]);
  const valores = b.sqls[auditoria]?.valores ?? [];
  assert.equal(valores[2], "FESTA_SALAO_TROCADO");
  assert.equal(valores[3], "FECHAMENTO");
  assert.deepEqual(JSON.parse(String(valores[5])), { salaoId: S1, salaoNome: "Kids", empresaId: EMPRESA });
  assert.deepEqual(JSON.parse(String(valores[6])), { salaoId: S2, salaoNome: "Jardim", empresaId: EMPRESA });
  assert.equal(b.escritas().length, 2);
});

test("escolher o salão atual não escreve nada", async () => {
  const b = banco();
  const lido = await trocarSalaoDaFesta(b.tx, ctx, FESTA, S1);
  assert.equal(lido?.salaoAtual?.id, S1);
  assert.equal(b.escritas().length, 0);
});

// S-E (R-E3/R3-E1): contrato assinado que fixa o salão (V3): a festa não muda de salão aqui.
const FIXA = { fixa: { id: S1, nome: "Kids" }, rid: null, estado: null, sid: null, snome: null };
test("S-E: contrato assinado fixa o salão e não há revisão → recusa pedindo nova versão, sem escrever", async () => {
  const b = banco({ contrato: FIXA });
  await assert.rejects(trocarSalaoDaFesta(b.tx, ctx, FESTA, S2), (e: { code?: string; message?: string }) => e.code === "TROCA_EXIGE_NOVA_VERSAO" && /fixa o salão Kids/.test(String(e.message)));
  assert.equal(b.escritas().length, 0);
  const leitura = await lerSalaoDaFesta(banco({ contrato: FIXA }).tx, EMPRESA, FESTA);
  assert.deepEqual(leitura?.contratoFixa, { id: S1, nome: "Kids" });
  assert.equal(leitura?.trocaEmAndamento, undefined);
});

test("S-E: revisão congelada recusa; revisão em elaboração grava o DESTINO (não a festa) e recalcula o hash", async () => {
  const congelada = banco({ contrato: { ...FIXA, rid: "rev", estado: "CONGELADA", sid: S1, snome: "Kids" } });
  await assert.rejects(trocarSalaoDaFesta(congelada.tx, ctx, FESTA, S2), (e: { code?: string }) => e.code === "REVISAO_CONGELADA");
  assert.equal(congelada.escritas().length, 0);
  const aberta = banco({ contrato: { ...FIXA, rid: "rev", estado: "EM_ELABORACAO", sid: S1, snome: "Kids" } });
  await trocarSalaoDaFesta(aberta.tx, ctx, FESTA, S2);
  const escritas = aberta.escritas().map((q) => q.sql.trim().split("\n")[0]);
  assert.ok(!escritas.some((x) => x.startsWith("UPDATE fechamentos SET salao_id")), "a festa continua no salão do contrato");
  assert.ok(escritas[0].startsWith("UPDATE fechamento_revisoes SET salao_id"));
  assert.ok(escritas[1].startsWith("UPDATE fechamento_revisoes"), "recálculo do hash logo depois");
  // P2 do Astra (27/10): as opções oferecidas são as do DESTINO da revisão (data, horário, configuração, pacote e convidados).
  const opcoesDestino = aberta.sqls.find((q) => q.sql.includes("AS permitido"))!;
  assert.deepEqual(opcoesDestino.valores, [FESTA, "rev"]);
  assert.match(opcoesDestino.sql, /JOIN fechamento_revisoes r ON r\.fechamento_id = f\.id AND r\.id = \$2::uuid/);
  assert.match(opcoesDestino.sql, /kidmais094_conflito_ocupacao\(f\.id, r\.data_evento, r\.horario_inicio, r\.horario_fim, f\.empresa_id,\s+f\.estabelecimento_id, r\.configuracao_agenda_id, s\.id\)/);
  assert.match(opcoesDestino.sql, /h\.configuracao_agenda_id = r\.configuracao_agenda_id/);
  assert.match(opcoesDestino.sql, /p\.pacote_id = r\.pacote_id/);
  assert.match(opcoesDestino.sql, /r\.convidados <= s\.capacidade_convidados/);
  const leituraAberta = banco({ contrato: { ...FIXA, rid: "rev", estado: "EM_ELABORACAO", sid: S1, snome: "Kids" } });
  await lerSalaoDaFesta(leituraAberta.tx, EMPRESA, FESTA);
  assert.deepEqual(leituraAberta.sqls.find((q) => q.sql.includes("AS permitido"))!.valores, [FESTA, "rev"], "a tela também lê as opções do destino");
  // Sem contrato que fixa o salão (troca direta, 094): as opções continuam as da festa.
  const direta = banco();
  await lerSalaoDaFesta(direta.tx, EMPRESA, FESTA);
  const opcoesFesta = direta.sqls.find((q) => q.sql.includes("AS permitido"))!;
  assert.deepEqual(opcoesFesta.valores, [FESTA]);
  assert.match(opcoesFesta.sql, /kidmais094_conflito_ocupacao\(f\.id, f\.data_evento/);
  const naoServe = banco({ contrato: { ...FIXA, rid: "rev", estado: "EM_ELABORACAO", sid: S1, snome: "Kids" }, serveNoDestino: false });
  await assert.rejects(trocarSalaoDaFesta(naoServe.tx, ctx, FESTA, S2), (e: { code?: string }) => e.code === "SALAO_OCUPADO");
  assert.equal(naoServe.escritas().length, 0, "escolha explícita que não serve não vira outro salão");
});
