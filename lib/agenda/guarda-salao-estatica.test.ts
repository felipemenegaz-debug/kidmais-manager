import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Plano "liberar agenda com mais de um salão" (rev. 6–7, P2-3): guarda ESTÁTICA dos escritores de salão (CI).
 *
 * 1. O classificador de SQL reconhece escrita de salao_id em fechamentos/fechamento_revisoes e nada mais.
 * 2. Mutantes da guarda, num mini-repositório temporário (arquivos que a regressão PG não exercita, para provar que não é
 *    a guarda dinâmica que está cobrindo): `um(sql)` em .cjs, constante importada, retorno não puro, wrapper de dois
 *    níveis, setters dinâmicos e `NEW.salao_id :=` numa migration.
 * 3. O repositório: escritas de produção = tabela B (só por escreverSalao, escritor literal); fixtures = camada C;
 *    SQL não resolvido em lib/ e app/ só nas exceções declaradas (todas usadas); `.query` como valor só em teste; .sql sem
 *    escrita de salão.
 */
const exigir = createRequire(import.meta.url);
const guarda = exigir("../../scripts/guarda-salao-estatica.cjs") as {
  analisar: (o: { raiz: string; arquivos?: string[]; excecoes?: unknown[] }) => Relatorio;
  escritasDeSalao: (sql: string) => { tabela: string; operacao: string }[];
  escritasEmSql: (sql: string) => { tabela: string; operacao: string }[];
};
const { EXCECOES } = exigir("../../scripts/guarda-salao-excecoes.cjs") as { EXCECOES: { arquivo: string; funcao: string; motivo: string }[] };
type Escrita = { arquivo: string; funcao: string; teste: boolean; via: string; escritor: string | null; tabelas: string[] };
type NaoResolvido = { arquivo: string; funcao: string; teste: boolean; motivo: string; arquivoOrigem: string; funcaoOrigem: string };
type Relatorio = {
  escritas: Escrita[]; naoResolvidos: NaoResolvido[]; sql: { arquivo: string; escritas: string[] }[];
  comoValor: { arquivo: string; teste: boolean }[]; excecoesNaoUsadas: unknown[];
};
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("classificador: escrita de salao_id nas duas tabelas, e só ela", () => {
  const sim = [
    "UPDATE fechamentos SET salao_id = $2 WHERE id = $1",
    "update public.fechamentos f set status='x', (salao_id, convidados) = ($2, 3) where f.id=$1",
    "UPDATE fechamento_revisoes SET salao_id=CASE WHEN x THEN NULL ELSE salao_id END WHERE id=$1",
    "INSERT INTO fechamentos (id, salao_id) VALUES ($1, $2)",
    "INSERT INTO fechamento_revisoes SELECT * FROM x",
    "INSERT INTO fechamentos(id) VALUES($1) ON CONFLICT (id) DO UPDATE SET salao_id = EXCLUDED.salao_id",
    "WITH m AS (UPDATE fechamentos SET salao_id = NULL WHERE id = $1 RETURNING id) SELECT 1",
    // Rodada 2 (P2 do Astra): identificadores delimitados, escapes de aspas, atribuição simples e múltipla, ON CONFLICT.
    `UPDATE fechamentos SET "salao_id" = $1 WHERE id = $2`,
    `UPDATE "public"."fechamentos" SET status = 'x', "salao_id" = $1 WHERE id = $2`,
    `UPDATE fechamento_revisoes SET ("salao_id", convidados) = ($1, 2) WHERE id = $3`,
    `UPDATE "fechamentos" AS f SET "SALAO_ID" = NULL WHERE f.id = $1`,
    `INSERT INTO "fechamentos" ("id", "salao_id") VALUES ($1, $2)`,
    `INSERT INTO fechamentos(id) VALUES($1) ON CONFLICT (id) DO UPDATE SET "salao_id" = EXCLUDED."salao_id"`,
  ];
  for (const sql of sim) assert.notDeepEqual(guarda.escritasDeSalao(sql), [], sql);
  const nao = [
    "UPDATE fechamentos SET status = 'x' WHERE salao_id = $1",
    "SELECT salao_id FROM fechamentos",
    "UPDATE fechamentos SET status = (SELECT max(salao_id) FROM x) WHERE id = $1",
    "UPDATE configuracao_agenda_saloes SET salao_id = $1",
    "INSERT INTO fechamentos (id, status) VALUES ($1, 'x')",
    "-- UPDATE fechamentos SET salao_id = 1\nSELECT 1",
    "SELECT 'UPDATE fechamentos SET salao_id = 1'",
    `UPDATE fechamentos SET "status" = $1 WHERE "salao_id" = $2`,
    `UPDATE fechamentos SET "salao id" = $1 WHERE id = $2`,
    `UPDATE fechamentos SET "x""salao_id" = $1 WHERE id = $2`,
  ];
  for (const sql of nao) assert.deepEqual(guarda.escritasDeSalao(sql), [], sql);
  assert.notDeepEqual(guarda.escritasEmSql("CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN NEW.salao_id := NULL; RETURN NEW; END $$ LANGUAGE plpgsql;"), []);
  assert.notDeepEqual(guarda.escritasEmSql("BEGIN NEW.salao_id = x; END"), []);
  assert.notDeepEqual(guarda.escritasEmSql(`BEGIN NEW."salao_id" := NULL; RETURN NEW; END`), []);
  assert.deepEqual(guarda.escritasEmSql("BEGIN IF NEW.salao_id IS NULL OR NEW.salao_id = OLD.salao_id THEN RETURN NEW; END IF; END"), []);
});

function miniRepositorio(arquivos: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "guarda-salao-"));
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    mkdirSync(dirname(join(dir, nome)), { recursive: true });
    writeFileSync(join(dir, nome), conteudo);
  }
  try { return guarda.analisar({ raiz: dir }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const producao = (r: Relatorio) => r.escritas.filter((e) => !e.teste).map((e) => `${e.arquivo}#${e.funcao}#${e.via}`);

test("mutantes da guarda estática (mini-repositório): cada um reprova", () => {
  const r = miniRepositorio({
    // um(sql) num script .cjs: o executor não contém o nome da tabela e quem tem o literal não chama .query.
    "scripts/um.cjs": `const { Client } = require("pg"); const c = new Client();
      async function um(sql, v) { return c.query(sql, v); }
      async function principal() { await um("UPDATE fechamentos SET salao_id = $1 WHERE id = $2", [1, 2]); }
      module.exports = { principal };`,
    // constante SQL importada de outro módulo
    "lib/sql.ts": `export const TROCA = "UPDATE fechamentos SET salao_id = $2 WHERE id = $1";`,
    "lib/constante.ts": `import { TROCA } from "./sql.ts"; export async function trocar(tx: { query(s: string, p: unknown[]): Promise<unknown> }) { await tx.query(TROCA, [1, 2]); }`,
    // retorno de função não pura → não resolvido
    "lib/nao-pura.ts": `function sqlDoAmbiente() { return process.env.SQL_X ?? ""; }
      export async function rodar(tx: { query(s: string, p: unknown[]): Promise<unknown> }) { await tx.query(sqlDoAmbiente(), [1]); }`,
    // wrapper novo de dois níveis, entre módulos
    "lib/nivel1.ts": `export async function nivel1(tx: { query(s: string, p: unknown[]): Promise<unknown> }, sql: string, p: unknown[]) { return tx.query(sql, p); }`,
    "lib/nivel2.ts": `import { nivel1 } from "./nivel1.ts";
      export async function nivel2(tx: never, texto: string) { return nivel1(tx, texto, [1]); }
      export async function usar(tx: never) { await nivel2(tx, "UPDATE fechamento_revisoes SET salao_id = $1"); }`,
    // setters dinâmicos (array + push + join)
    "lib/setters.ts": `export async function editar(tx: { query(s: string, p: unknown[]): Promise<unknown> }, campos: readonly ("status" | "convidados")[]) {
        const setters = campos.map((k, i) => k + "=$" + (i + 2));
        setters.push("salao_id=NULL");
        await tx.query("UPDATE fechamentos SET " + setters.join(",") + " WHERE id=$1", [1]);
      }
      export async function chamar(tx: never) { await editar(tx, ["status"]); }`,
    // sink derivado sem chamador: o SQL vem de parâmetro que ninguém fornece
    "lib/orfao.ts": `export async function executarQualquer(tx: { query(s: string): Promise<unknown> }, sql: string) { await tx.query(sql); }`,
    // controle: leitura resolvida, sem escrita
    "lib/leitura.ts": `export async function ler(tx: { query(s: string): Promise<unknown> }) { await tx.query("SELECT salao_id FROM fechamentos"); }`,
    // migration nova com atribuição a NEW.salao_id
    "database/migrations/999_mutante.sql": `CREATE FUNCTION m() RETURNS trigger AS $$ BEGIN NEW.salao_id := NULL; RETURN NEW; END $$ LANGUAGE plpgsql;`,
  });
  const escritas = producao(r);
  assert.ok(escritas.some((e) => e.startsWith("scripts/um.cjs#principal#um")), "um(sql) em .cjs");
  assert.ok(escritas.some((e) => e.startsWith("lib/constante.ts#trocar")), "constante importada");
  assert.ok(escritas.some((e) => e.startsWith("lib/nivel2.ts#usar#nivel2")), "wrapper de dois níveis");
  assert.ok(escritas.some((e) => e.startsWith("lib/setters.ts#chamar#editar")), "setters dinâmicos");
  assert.ok(r.naoResolvidos.some((x) => x.arquivoOrigem === "lib/orfao.ts" && /sem chamador/.test(x.motivo)), "sink sem chamador = não resolvido");
  assert.ok(r.naoResolvidos.some((x) => x.arquivoOrigem === "lib/nao-pura.ts" && !x.teste), "retorno não puro = SQL_NAO_RESOLVIDO");
  assert.equal(escritas.some((e) => e.startsWith("lib/leitura.ts")), false, "leitura não é escrita");
  assert.deepEqual(r.sql.map((x) => x.arquivo), ["database/migrations/999_mutante.sql"], "NEW.salao_id em migration nova");
  for (const e of r.escritas) assert.notEqual(e.via, "escreverSalao", "nenhum mutante passa pelo escritor");
});

/** Tabela B (rev. 5–7): escritores de produção, todos por escreverSalao. */
const TABELA_B = [
  "lib/agenda/salao-festa.ts#aplicarSalaoDaRevisao#B3#fechamentos:UPDATE",
  "lib/agenda/salao-festa.ts#definirSalaoDestinoRevisao#B5#fechamento_revisoes:UPDATE",
  "lib/agenda/salao-festa.ts#escolherSalao#B1#fechamentos:UPDATE",
  "lib/agenda/salao-festa.ts#escolherSalao#B2#fechamentos:UPDATE",
  "lib/agenda/salao-festa.ts#escolherSalaoDestinoRevisao#B4#fechamento_revisoes:UPDATE",
  "lib/agenda/troca-salao.ts#trocarSalaoDaFesta#B7#fechamentos:UPDATE",
  "lib/fechamentos/repositories/edicao.repository.ts#persistirEdicaoFechamento#B6#fechamentos:UPDATE",
];
/** Camada C fora do padrão de nome de teste: harness PG com schema sintético próprio (fechamentos de 4 colunas). */
const C_DECLARADA = ["scripts/convites-postgres.cjs"];
/** `.query` usado como valor fora de arquivo de teste: só a própria instrumentação da guarda dinâmica. */
const COMO_VALOR_DECLARADO = ["scripts/guarda-salao-preload.cjs"];

/**
 * A guarda inteira (as mesmas regras dos testes de repositório abaixo), como lista de violações. Rodada 2: os mutantes
 * provam que ela reprova (não só o reconhecedor de SQL).
 */
function violacoes(r: Relatorio, tabelaB = TABELA_B) {
  const v: string[] = [];
  const producaoReal = r.escritas.filter((e) => !e.teste && !C_DECLARADA.includes(e.arquivo));
  for (const e of producaoReal) if (e.via !== "escreverSalao") v.push(`escrita direta: ${e.arquivo}#${e.funcao}`);
  const b = producaoReal.map((e) => `${e.arquivo}#${e.funcao}#${e.escritor}#${e.tabelas.join("+")}`).sort();
  if (JSON.stringify(b) !== JSON.stringify(tabelaB)) v.push(`escritores fora da tabela B: ${b.filter((x) => !tabelaB.includes(x)).join(", ")}`);
  for (const x of r.sql) v.push(`.sql escreve salão: ${x.arquivo}`);
  for (const x of r.naoResolvidos.filter((n) => !n.teste)) v.push(`SQL não resolvido: ${x.arquivo}#${x.funcao}`);
  return v;
}

test("rodada 2 (P2 do Astra): identificador delimitado em produção não exercida e em migration — a guarda inteira reprova", () => {
  const base = {};
  const controle = miniRepositorio({ ...base, "lib/ok.ts": `export async function ler(tx: { query(s: string): Promise<unknown> }) { await tx.query('SELECT "salao_id" FROM "fechamentos"'); }` });
  assert.deepEqual(violacoes(controle, []), [], "controle: leitura com aspas não é escrita");
  const mutantes: Record<string, Record<string, string>> = {
    "UPDATE simples com aspas": { "lib/m.ts": `export async function trocar(tx: { query(s: string, p: unknown[]): Promise<unknown> }) { await tx.query('UPDATE fechamentos SET "salao_id" = $1 WHERE id = $2', [1, 2]); }` },
    "atribuição múltipla com aspas e tabela qualificada": { "lib/m.ts": `export async function trocar(tx: { query(s: string, p: unknown[]): Promise<unknown> }) { await tx.query('UPDATE "public"."fechamento_revisoes" SET status = $3, "salao_id" = $1 WHERE id = $2', [1, 2, 3]); }` },
    "ON CONFLICT DO UPDATE com aspas": { "lib/m.ts": `export async function inserir(tx: { query(s: string, p: unknown[]): Promise<unknown> }) { await tx.query('INSERT INTO fechamentos (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET "salao_id" = EXCLUDED."salao_id"', [1]); }` },
    "UPDATE com aspas numa migration": { "database/migrations/999_aspas.sql": `UPDATE "fechamentos" SET "salao_id" = NULL WHERE id IS NULL;` },
    "NEW.\"salao_id\" numa migration": { "database/migrations/999_aspas.sql": `CREATE FUNCTION m() RETURNS trigger AS $$ BEGIN NEW."salao_id" := NULL; RETURN NEW; END $$ LANGUAGE plpgsql;` },
  };
  for (const [nome, arquivos] of Object.entries(mutantes)) assert.notDeepEqual(violacoes(miniRepositorio({ ...base, ...arquivos }), []), [], nome);
});

let repositorio: Relatorio;
test.before(() => { repositorio = guarda.analisar({ raiz, excecoes: EXCECOES }); });

test("repositório: escritas de produção = tabela B, só por escreverSalao", () => {
  const producaoReal = repositorio.escritas.filter((e) => !e.teste && !C_DECLARADA.includes(e.arquivo));
  for (const e of producaoReal) assert.equal(e.via, "escreverSalao", `escrita direta: ${e.arquivo} ${e.funcao}`);
  assert.deepEqual(producaoReal.map((e) => `${e.arquivo}#${e.funcao}#${e.escritor}#${e.tabelas.join("+")}`).sort(), TABELA_B);
  assert.deepEqual(violacoes(repositorio).filter((x) => !x.startsWith("SQL não resolvido")), [], "a guarda inteira passa no repositório");
});

test("repositório: SQL não resolvido fora de teste só nas exceções declaradas, todas usadas", () => {
  const fora = repositorio.naoResolvidos.filter((x) => !x.teste);
  assert.deepEqual(fora.map((x) => `${x.arquivo}:${x.funcao} ← ${x.arquivoOrigem}#${x.funcaoOrigem}: ${x.motivo}`), []);
  assert.deepEqual(repositorio.excecoesNaoUsadas, []);
  for (const x of EXCECOES) assert.ok(x.motivo.length > 40, `exceção sem motivo: ${x.arquivo}#${x.funcao}`);
  // Exceção por arquivo (decisão de 01/11/2026) só em scripts/; lib/ e app/ só por função.
  for (const x of EXCECOES) if (x.funcao === "*") assert.match(x.arquivo, /^scripts\//);
  assert.throws(() => guarda.analisar({ raiz, arquivos: [], excecoes: [{ arquivo: "lib/x.ts", funcao: "*", motivo: "-" }] }), /fora de scripts/);
});

test("repositório: nenhum .sql escreve salão; .query como valor só em teste", () => {
  assert.deepEqual(repositorio.sql, []);
  assert.deepEqual(repositorio.comoValor.filter((x) => !x.teste && !COMO_VALOR_DECLARADO.includes(x.arquivo)).map((x) => x.arquivo), []);
});
