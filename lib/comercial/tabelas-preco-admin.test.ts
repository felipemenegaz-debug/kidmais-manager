import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";
import { criarTabelaPrecoAdmin, incluirPrecoPacoteAdmin, publicarTabelaPrecoAdmin, simularPrecoPacote, simularTabelaPublicada } from "./tabelas-preco-admin.ts";

test("simulação distingue preço, vazio e sob consulta", () => {
  assert.deepEqual(simularPrecoPacote({ valor: "10.50", sobConsulta: false }), { tipo: "PRECO", centavos: 1050 });
  assert.deepEqual(simularPrecoPacote({ valor: "", sobConsulta: false }), { tipo: "AUSENTE" });
  assert.deepEqual(simularPrecoPacote({ valor: null, sobConsulta: false }), { tipo: "AUSENTE" });
  assert.deepEqual(simularPrecoPacote({ valor: "10.00", sobConsulta: true }), { tipo: "SOB_CONSULTA" });
  assert.throws(() => simularPrecoPacote({ valor: "0", sobConsulta: false }));
});

test("criar tabela e incluir preço gravam auditoria da mesma empresa", async () => {
  const empresaId = "11111111-1111-4111-8111-111111111111";
  const tabelaId = "22222222-2222-4222-8222-222222222222";
  const pacoteId = "33333333-3333-4333-8333-333333333333";
  const auditorias: unknown[][] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
      if (text.includes("INSERT INTO auditoria")) {
        auditorias.push([...(values ?? [])]);
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("AS esquerda")) return { rows: [{ esquerda: empresaId, direita: empresaId } as Row], rowCount: 1 };
      if (text.includes("FOR UPDATE")) return { rows: [{ publicada_em: null } as Row], rowCount: 1 };
      if (text.startsWith("INSERT INTO tabelas_preco")) return { rows: [{ id: tabelaId } as Row], rowCount: 1 };
      if (text.startsWith("INSERT INTO precos_pacote")) return { rows: [], rowCount: 1 };
      throw new Error(text);
    },
  };
  assert.equal(await criarTabelaPrecoAdmin(tx, {
    empresaId, codigo: "TABELA_A", nome: "Tabela A", vigenciaInicio: "2026-10-01", vigenciaFim: null,
  }, { usuarioId: "usuario-1", requestId: "req-1", motivo: "Abrir a tabela" }), tabelaId);
  await incluirPrecoPacoteAdmin(tx, {
    empresaId, tabelaId, pacoteId, convidadosMin: 40, convidadosMax: 80, tipoCalculo: "FIXO", valor: "10.00", categoriaHorario: "PADRAO",
    usuarioId: "usuario-1", requestId: "req-1", motivo: "Incluir a faixa",
  });
  assert.equal(auditorias[0]?.[2], "TABELA_PRECO_CRIADA");
  assert.equal(auditorias[0]?.[4], tabelaId);
  assert.match(String(auditorias[0]?.[6]), new RegExp(empresaId));
  assert.equal(auditorias[0]?.[7], "Abrir a tabela");
  assert.equal(auditorias[1]?.[2], "PRECO_PACOTE_INCLUIDO");
  assert.match(String(auditorias[1]?.[6]), new RegExp(pacoteId));
  assert.equal(auditorias[1]?.[7], "Incluir a faixa");
});

test("a simulação da empresa usa a tabela publicada na data da festa", async () => {
  const empresa = "11111111-1111-4111-8111-111111111111";
  const tx: DbExecutor = {
    async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
      assert.match(text, /t\.empresa_id = \$1::uuid/);
      assert.match(text, /t\.publicada_em IS NOT NULL/);
      assert.match(text, /t\.vigencia_inicio <= \$2::date/);
      assert.equal(text.includes("fechamentos"), false);
      assert.equal(values?.[0], empresa);
      return { rows: [{ valor: "64.90" } as Row], rowCount: 1 };
    },
  };
  assert.deepEqual(await simularTabelaPublicada(tx, {
    empresaId: empresa,
    data: "2026-10-10",
    pacoteId: "22222222-2222-4222-8222-222222222222",
    convidados: 40,
    categoriaHorario: "PADRAO",
    sobConsulta: false,
  }), { tipo: "PRECO", centavos: 6490 });
  const vazio: DbExecutor = { async query() { return { rows: [], rowCount: 0 }; } };
  assert.deepEqual(await simularTabelaPublicada(vazio, {
    empresaId: empresa, data: "2026-10-10", pacoteId: "22222222-2222-4222-8222-222222222222", convidados: 40, categoriaHorario: "PADRAO", sobConsulta: false,
  }), { tipo: "AUSENTE" });
});

const empresa = "11111111-1111-4111-8111-111111111111";
const tabela = "22222222-2222-4222-8222-222222222222";

function publicar(responder: (text: string) => { rows: object[]; rowCount: number }) {
  const chamadas: string[] = [];
  const valores: unknown[][] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
      chamadas.push(text);
      valores.push([...(values ?? [])]);
      return responder(text) as DbQueryResult<Row>;
    },
  };
  return { tx, chamadas, valores };
}

function respostaValida(text: string, updateRowCount = 1) {
  if (text.includes("FOR UPDATE")) {
    return { rows: [{ id: tabela, publicada_em: null, ativa: false, vigencia_inicio: "2026-10-01", vigencia_fim: "2026-12-31" }], rowCount: 1 };
  }
  if (text.includes("AS n")) return { rows: [{ n: 1 }], rowCount: 1 };
  if (text.startsWith("UPDATE tabelas_preco")) {
    return { rows: updateRowCount === 1 ? [{ publicada_em: "2026-09-26T18:00:00.000Z" }] : [], rowCount: updateRowCount };
  }
  return { rows: [], rowCount: 0 };
}

test("publicar não recalcula fechamento nem ativa a tabela no fechamento público", async () => {
  const { tx, chamadas, valores } = publicar(respostaValida);
  await publicarTabelaPrecoAdmin(tx, { empresaId: empresa, tabelaId: tabela, usuarioId: "usuario-1", requestId: "req-1", motivo: "Publicar a faixa conferida" });
  const update = chamadas.find((sql) => sql.startsWith("UPDATE tabelas_preco")) ?? "";
  const auditoria = chamadas.findIndex((sql) => sql.includes("INSERT INTO auditoria"));
  assert.equal(valores[auditoria]?.[0], "USUARIO");
  assert.equal(valores[auditoria]?.[1], "usuario-1");
  assert.equal(valores[auditoria]?.[4], tabela);
  assert.equal(chamadas.filter((sql) => sql.includes("INSERT INTO auditoria")).length, 1);
  assert.match(String(valores[auditoria]?.[6]), new RegExp(empresa));
  assert.match(String(valores[auditoria]?.[6]), /2026-09-26T18:00:00.000Z/);
  assert.equal(String(valores[auditoria]?.[6]).includes("clock_timestamp()"), false);
  assert.equal(valores[auditoria]?.[7], "Publicar a faixa conferida");
  assert.match(update, /ativa = false/);
  assert.match(update, /publicada_em IS NULL/);
  assert.equal(chamadas.some((sql) => sql.includes("fechamentos")), false);
});

test("publicação recusa escopo ausente, faixa inválida, sobreposição e vigência cruzada", async () => {
  const casos: Array<{ trecho: string; corpo: { rows: object[]; rowCount: number }; codigo: string }> = [
    { trecho: "kidmais_047_lacunas_escopo", corpo: { rows: [{ codigo: "ESCOPO_AUSENTE", detalhe: "sem escopo" }], rowCount: 1 }, codigo: "ESCOPO_AUSENTE" },
    { trecho: "convidados_min < 1", corpo: { rows: [{ "?column?": 1 }], rowCount: 1 }, codigo: "FAIXA_INVALIDA" },
    { trecho: "int4range", corpo: { rows: [{ "?column?": 1 }], rowCount: 1 }, codigo: "FAIXA_SOBREPOSTA" },
    { trecho: "daterange", corpo: { rows: [{ "?column?": 1 }], rowCount: 1 }, codigo: "VIGENCIA_SOBREPOSTA" },
  ];
  for (const caso of casos) {
    const { tx, chamadas } = publicar((text) => text.includes(caso.trecho) ? caso.corpo : respostaValida(text));
    await assert.rejects(
      () => publicarTabelaPrecoAdmin(tx, { empresaId: empresa, tabelaId: tabela }),
      (error: unknown) => error instanceof PacoteAdminError && error.code === caso.codigo,
    );
    assert.equal(chamadas.some((sql) => sql.startsWith("UPDATE") || sql.includes("INSERT INTO auditoria")), false, caso.codigo);
  }
});

test("publicação recusa pacote de outra empresa e publicação concorrente", async () => {
  const cruzada = publicar((text) => text.includes("IS DISTINCT FROM") && text.includes("pacotes")
    ? { rows: [{ "?column?": 1 }], rowCount: 1 }
    : respostaValida(text));
  await assert.rejects(
    () => publicarTabelaPrecoAdmin(cruzada.tx, { empresaId: empresa, tabelaId: tabela }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "EMPRESA_DIVERGENTE" && error.httpStatus === 403,
  );
  assert.equal(cruzada.chamadas.some((sql) => sql.startsWith("UPDATE")), false);

  const concorrente = publicar((text) => respostaValida(text, 0));
  await assert.rejects(
    () => publicarTabelaPrecoAdmin(concorrente.tx, { empresaId: empresa, tabelaId: tabela }),
    (error: unknown) => error instanceof PacoteAdminError && error.code === "CONFLITO",
  );
});

test("tabela já publicada entra em conflito e o PDF não é exigido", async () => {
  const tx: DbExecutor = {
    async query<Row extends object>(): Promise<DbQueryResult<Row>> {
      return { rows: [{ id: "tabela-1", publicada_em: "2026-09-26" } as Row], rowCount: 1 };
    },
  };
  await assert.rejects(
    () => publicarTabelaPrecoAdmin(tx, { empresaId: "11111111-1111-4111-8111-111111111111", tabelaId: "22222222-2222-4222-8222-222222222222" }),
    (error: unknown) => error instanceof PacoteAdminError && error.httpStatus === 409,
  );
  const migration = readFileSync("database/migrations/20260926_033_tabela_preco_publicacao.sql", "utf8");
  assert.equal(/UPDATE fechamentos|documentos_publicos|TABELA_PACOTES/.test(migration), false);
  const guarda = readFileSync("database/migrations/20260926_035_publicacao_tabela_invariantes.sql", "utf8");
  assert.match(guarda, /HG-4/);
  const escopo = readFileSync("database/migrations/20260926_047_escopo_comercial_tabela.sql", "utf8");
  assert.equal(/INSERT INTO tabela_preco_escopos|UPDATE precos_pacote|UPDATE tabelas_preco SET|ESSENCIAL|COMPLETA|PREMIUM|PIZZA_PARTY/.test(escopo), false);
  assert.match(escopo, /ESCOPO_AUSENTE/);
  assert.match(escopo, /kidmais_047_lacunas_escopo/);
  assert.match(guarda, /daterange/);
  assert.match(guarda, /Rollback possível/);
  assert.equal(/DELETE FROM|UPDATE precos_pacote SET|UPDATE tabelas_preco SET/.test(guarda), false);
});
