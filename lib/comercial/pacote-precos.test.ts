import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import { copiarPrecosPacote, gravarFaixasPacote } from "./pacote-precos.ts";
import { duplicarPacoteComercial } from "./pacote-comercial.ts";

const empresa = "11111111-1111-4111-8111-111111111111";
const pacote = "22222222-2222-4222-8222-222222222222";
const ctx = { empresaId: empresa, usuarioId: "usuario-1", requestId: "req-1", motivo: "PACOTE_EDITADO" };
const faixa = { convidadosMin: 20, convidadosMax: 30, valor: "6490.00" };
const nova = { convidadosMin: 20, convidadosMax: 30, valor: "7390.00" };
const fonte = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "pacote-precos.ts"), "utf8");

function linhaPacote(id = pacote) {
  return {
    id, empresa_id: empresa, codigo: "P_TESTE", nome: "Festa", descricao: "Com bolo",
    duracao_minutos: 180, convidados_minimos: 20, convidados_maximos: 40,
    ativo: true, vigente: true, arquivado_em: null, revisao_anterior_id: null, utilizado: false,
  };
}

function linhaPreco(valor = "6490.00") {
  return {
    tabela_id: "tabela-corrente",
    publicada: true,
    convidados_min: 20,
    convidados_max: 30,
    tipo_calculo: "FIXO",
    valor,
    categoria_horario: "GERAL",
  };
}

function vazio<Row extends object>(): DbQueryResult<Row> {
  return { rows: [], rowCount: 0 };
}

function um<Row extends object>(row: Row): DbQueryResult<Row> {
  return { rows: [row], rowCount: 1 };
}

test("o save não encurta vigência para trocar o preço no mesmo dia", () => {
  assert.equal(fonte.includes("CURRENT_DATE - 1"), false);
  assert.equal(fonte.includes("CURRENT_DATE + 1"), false);
  assert.equal(fonte.includes("vigencia_fim ="), false);
  assert.match(fonte, /substituida_em = clock_timestamp\(\)/);
  assert.match(fonte, /SET publicada_em = clock_timestamp\(\)/);
  const ligar = fonte.indexOf("substituida_em = clock_timestamp()");
  const publicar = fonte.indexOf("SET publicada_em = clock_timestamp()");
  assert.equal(ligar < publicar, true);
});

test("preço novo nasce numa sucessora e o preço usado não é reescrito", async () => {
  const sqls: string[] = [];
  const tx: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    sqls.push(text);
    if (text.includes("UPDATE precos_pacote") || text.includes("UPDATE fechamento") || text.includes("SET vigencia_fim")) {
      throw new Error(`escrita proibida: ${text}`);
    }
    if (text.includes("kidmais_037_trava_publicacao") || text.includes("kidmais_047_lacunas_escopo") || text.includes("pg_advisory_xact_lock")) return vazio();
    if (text.includes("FROM precos_pacote pp")) return um(linhaPreco() as Row);
    if (text.includes("FOR UPDATE")) return um({ id: "tabela-corrente" } as Row);
    if (text.includes("AS publicada")) return um({ id: "tabela-corrente", publicada: true } as Row);
    if (text.startsWith("INSERT INTO tabelas_preco")) {
      assert.match(text, /vigencia_inicio, vigencia_fim, false/);
      assert.equal(text.includes("CURRENT_DATE"), false);
      return um({ id: "tabela-nova" } as Row);
    }
    if (text.includes("substituida_em = clock_timestamp()")) return um({ id: "tabela-corrente" } as Row);
    if (text.includes("SET publicada_em = clock_timestamp()")) return um({ id: "tabela-nova" } as Row);
    if (text.includes("count(*)::int AS n")) return um({ n: 1 } as Row);
    if (text.startsWith("INSERT") || text.startsWith("DELETE") || text.startsWith("WITH")) return um({ id: "escopo-1" } as Row);
    throw new Error(text);
  } };
  const resultado = await gravarFaixasPacote(tx, empresa, pacote, [nova], { minimo: 20, maximo: 40 }, ctx);
  assert.equal(resultado.aplicado, true);
  assert.equal(sqls.some((sql) => sql.startsWith("UPDATE precos_pacote")), false);
  assert.equal(sqls.some((sql) => sql.includes("fechamento_pacote_snapshots") && sql.startsWith("UPDATE")), false);
  const substituida = sqls.findIndex((sql) => sql.includes("substituida_em = clock_timestamp()"));
  const publicada = sqls.findIndex((sql) => sql.includes("SET publicada_em = clock_timestamp()"));
  assert.equal(substituida >= 0 && substituida < publicada, true);
});

test("a primeira tabela da empresa nasce sem publicação e só então é publicada", async () => {
  const sqls: string[] = [];
  const tx: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    sqls.push(text);
    if (text.includes("UPDATE precos_pacote") || text.includes("substituida_em =") || text.includes("SET vigencia_fim")) {
      throw new Error(`escrita proibida: ${text}`);
    }
    if (text.includes("kidmais_037_trava_publicacao") || text.includes("kidmais_047_lacunas_escopo") || text.includes("pg_advisory_xact_lock")) return vazio();
    if (text.includes("FOR UPDATE") || text.includes("AS publicada")) return vazio();
    if (text.startsWith("INSERT INTO tabelas_preco")) {
      assert.match(text, /CURRENT_DATE, NULL, false/);
      return um({ id: "tabela-nova" } as Row);
    }
    if (text.includes("SET publicada_em = clock_timestamp()")) return um({ id: "tabela-nova" } as Row);
    if (text.includes("count(*)::int AS n")) return um({ n: 1 } as Row);
    if (text.startsWith("INSERT") || text.startsWith("DELETE") || text.startsWith("WITH")) return um({ id: "escopo-1" } as Row);
    throw new Error(text);
  } };
  const resultado = await gravarFaixasPacote(tx, empresa, pacote, [faixa], { minimo: 20, maximo: 40 }, ctx);
  assert.equal(resultado.aplicado, true);
  assert.equal(sqls.some((sql) => sql.includes("SET publicada_em = clock_timestamp()")), true);
  assert.equal(sqls.some((sql) => sql.startsWith("UPDATE precos_pacote")), false);
});

test("duplicação copia o preço pela sucessora e a falha da cópia não deixa pacote persistido", async () => {
  const copiados: unknown[][] = [];
  async function transacao(falharPreco: boolean) {
    const confirmadas: string[] = [];
    const tx: DbExecutor = { async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
      if (falharPreco && text.startsWith("INSERT INTO precos_pacote")) throw new Error("preço não copiado");
      confirmadas.push(text);
      if (text.includes("AS utilizado")) return um(linhaPacote(String(values?.[0] ?? pacote)) as Row);
      if (text.startsWith("SELECT id FROM empresas")) return um({ id: empresa } as Row);
      if (text.startsWith("INSERT INTO pacotes")) return um({ id: "33333333-3333-4333-8333-333333333333" } as Row);
      if (text.includes("kidmais_037_trava_publicacao") || text.includes("kidmais_047_lacunas_escopo") || text.includes("pg_advisory_xact_lock")) return vazio();
      if (text.includes("FROM precos_pacote pp")) return um(linhaPreco() as Row);
      if (text.includes("FOR UPDATE")) return um({ id: "tabela-corrente" } as Row);
      if (text.includes("AS publicada")) return um({ id: "tabela-corrente", publicada: true } as Row);
      if (text.startsWith("INSERT INTO tabelas_preco")) return um({ id: "tabela-nova" } as Row);
      if (text.includes("substituida_em = clock_timestamp()") || text.includes("SET publicada_em = clock_timestamp()")) {
        return um({ id: "tabela-nova" } as Row);
      }
      if (text.includes("count(*)::int AS n")) return um({ n: 1 } as Row);
      if (text.startsWith("INSERT INTO precos_pacote")) {
        copiados.push([...(values ?? [])]);
        return vazio();
      }
      if (
        text.startsWith("INSERT INTO auditoria")
        || text.startsWith("INSERT INTO pacote_")
        || text.startsWith("INSERT INTO regras_")
        || text.startsWith("INSERT")
        || text.startsWith("WITH")
        || text.startsWith("DELETE")
      ) return um({ id: "escopo-1" } as Row);
      throw new Error(text);
    } };
    try {
      await duplicarPacoteComercial(tx, pacote, { ...ctx, motivo: "PACOTE_DUPLICADO" });
      return confirmadas;
    } catch (error) {
      if (!falharPreco) throw error;
      return [];
    }
  }
  const ok = await transacao(false);
  assert.equal(ok.some((sql) => sql.startsWith("INSERT INTO pacotes")), true);
  assert.equal(ok.some((sql) => sql.includes("substituida_em = clock_timestamp()")), true);
  assert.equal(copiados.some((valores) => valores[1] === "33333333-3333-4333-8333-333333333333"), true);
  const vazia = await transacao(true);
  assert.deepEqual(vazia, []);
  await copiarPrecosPacote({
    async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
      if (text.includes("AS publicada")) return vazio();
      throw new Error(text);
    },
  }, empresa, pacote, "33333333-3333-4333-8333-333333333333", ctx);
});
