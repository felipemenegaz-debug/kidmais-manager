import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbExecutor, DbQueryResult } from "../db/contracts.ts";
import { definirCategoriasPacoteAdmin, definirDisponibilidadePacoteAdmin, criarRevisaoPacoteAdmin } from "./pacotes-admin.ts";
import { precificarAdicionais } from "./services/pricing.service.ts";
import { PricingServiceError } from "./services/errors.ts";

const empresa = "11111111-1111-4111-8111-111111111111";
const pacote = "22222222-2222-4222-8222-222222222222";
const manha = "33333333-3333-4333-8333-333333333333";
const noite = "44444444-4444-4444-8444-444444444444";
const ctx = { empresaId: empresa, usuarioId: "usuario-1", requestId: "99999999-9999-4999-8999-999999999999", motivo: "PACOTE_EDITADO" };
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function pacoteLinha(id = pacote) {
  return {
    id, empresa_id: empresa, codigo: "P_TESTE", nome: "Festa", descricao: null,
    duracao_minutos: 180, convidados_minimos: 20, convidados_maximos: 30,
    ativo: true, vigente: true, arquivado_em: null, revisao_anterior_id: null, utilizado: true,
  };
}

function tabela(id = "tabela-corrente") {
  return {
    id, codigo: "PCOM", nome: "Preços", vigencia_inicio: "2026-09-27", vigencia_fim: null, ativa: false, publicada: true,
  };
}

test("pacote e adicionais vazios usam a mesma tabela corrente e não caem no legado", async () => {
  const sqls: string[] = [];
  const tx: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    sqls.push(text);
    if (text.includes("ativa = true")) throw new Error("legado");
    if (text.includes("substituida_em IS NULL")) return { rows: [tabela() as Row], rowCount: 1 };
    throw new Error(text);
  } };
  const resultado = await precificarAdicionais({
    data: "2026-09-27", convidados: 20, itens: [], empresaId: empresa,
  }, tx);
  assert.equal(resultado.tabelaPreco.id, "tabela-corrente");
  assert.deepEqual(resultado.itens, []);
  assert.equal(resultado.valorTotal, 0);
  assert.equal(sqls.some((sql) => sql.includes("ativa = true")), false);
});

test("zero ou duas tabelas correntes recusam o cálculo", async () => {
  async function consultar(quantidade: number) {
    const tx: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
      if (text.includes("ativa = true")) throw new Error("legado");
      if (text.includes("substituida_em IS NULL")) {
        return { rows: Array.from({ length: quantidade }, (_, indice) => tabela(`tabela-${indice}`)) as Row[], rowCount: quantidade };
      }
      throw new Error(text);
    } };
    return precificarAdicionais({ data: "2026-09-27", convidados: 20, itens: [], empresaId: empresa }, tx);
  }
  await assert.rejects(() => consultar(0), (error: unknown) => error instanceof PricingServiceError && error.code === "TABELA_PRECO_NAO_CONFIGURADA");
  await assert.rejects(() => consultar(2), (error: unknown) => error instanceof PricingServiceError && error.code === "PRECO_AMBIGUO");
});

test("disponibilidade grava o par dia e horário, sem produto cartesiano", async () => {
  const gravados: unknown[][] = [];
  const tx: DbExecutor = { async query<Row extends object>(text: string, values?: readonly unknown[]): Promise<DbQueryResult<Row>> {
    if (text.includes("AS utilizado")) return { rows: [pacoteLinha() as Row], rowCount: 1 };
    if (text.includes("FROM configuracao_agenda")) return { rows: [{ id: manha } as Row, { id: noite } as Row], rowCount: 2 };
    if (text.includes("unnest")) gravados.push([...(values ?? [])]);
    if (text.startsWith("INSERT INTO auditoria") || text.startsWith("UPDATE") || text.startsWith("INSERT INTO regras_disponibilidade_pacote")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(text);
  } };
  await definirDisponibilidadePacoteAdmin(tx, pacote, {
    disponibilidade: [
      { dia: 1, horarioId: manha },
      { dia: 6, horarioId: noite },
    ],
  }, ctx);
  assert.deepEqual(gravados[0]?.[1], [1, 6]);
  assert.deepEqual(gravados[0]?.[2], [manha, noite]);
  assert.equal((gravados[0]?.[1] as number[]).length, 2);
});

test("revisão só de nome não promove a nova linha se a cópia do preço falha", async () => {
  const sqls: string[] = [];
  const tx: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    sqls.push(text);
    if (text.includes("AS utilizado")) return { rows: [pacoteLinha() as Row], rowCount: 1 };
    if (text.startsWith("INSERT INTO pacotes")) return { rows: [{ id: "55555555-5555-4555-8555-555555555555" } as Row], rowCount: 1 };
    if (text.includes("to_regclass")) return { rows: [{ ok: false } as Row], rowCount: 1 };
    if (text.startsWith("INSERT INTO pacote_") || text.startsWith("INSERT INTO regras_")) return { rows: [], rowCount: 1 };
    if (text.includes("count(*)::int AS n")) return { rows: [{ n: 1 } as Row], rowCount: 1 };
    if (text.includes("FROM tabelas_preco")) throw new Error("cópia falhou");
    throw new Error(text);
  } };
  await assert.rejects(() => criarRevisaoPacoteAdmin(tx, pacote, { nome: "Festa nova", descricao: null, duracaoMinutos: 180 }, ctx));
  assert.equal(sqls.some((sql) => sql.startsWith("UPDATE pacotes SET vigente = true")), false);
  assert.equal(sqls.some((sql) => sql.startsWith("UPDATE pacotes SET vigente = false")), false);
});

test("categoria nova sem itens usa todos os itens ativos", async () => {
  const categoria = "66666666-6666-4666-8666-666666666666";
  const sqls: string[] = [];
  const livre = { ...pacoteLinha(), utilizado: false };
  const tx: DbExecutor = { async query<Row extends object>(text: string): Promise<DbQueryResult<Row>> {
    sqls.push(text);
    if (text.includes("AS utilizado")) return { rows: [livre as Row], rowCount: 1 };
    if (text.includes("FROM buffet_categorias")) return { rows: [{ id: categoria } as Row], rowCount: 1 };
    if (text.includes("FROM pacote_adicionais") || text.includes("FROM pacote_buffet_categorias") || text.includes("FROM pacote_buffet_itens")) {
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("UPDATE") || text.startsWith("INSERT")) return { rows: [], rowCount: 1 };
    throw new Error(text);
  } };
  await definirCategoriasPacoteAdmin(tx, pacote, [{ categoriaId: categoria, escolhas: 2 }], ctx);
  const gravacao = sqls.find((sql) => sql.includes("INSERT INTO pacote_buffet_categorias"));
  assert.match(gravacao ?? "", /TODOS_ATIVOS/);
  assert.match(gravacao ?? "", /pacote_buffet_itens/);
});

test("o down da 048 trava antes de apagar a supersessão", () => {
  const down = readFileSync(resolve(root, "database/rollback/20260927_048_supersessao_tabela_publicada_down.sql"), "utf8");
  const trava = down.indexOf("pg_advisory_xact_lock(hashtext('kidmais-048-down'))");
  const tabela = down.indexOf("LOCK TABLE public.tabelas_preco IN SHARE ROW EXCLUSIVE MODE");
  const queda = down.indexOf("DROP TRIGGER");
  assert.equal(trava >= 0 && tabela > trava && tabela < queda, true);
  assert.match(down, /kidmais_037_trava_publicacao\(empresa_id\)/);
});
