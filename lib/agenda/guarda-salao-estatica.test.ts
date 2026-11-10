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
    // merge com staging 03/11: callback do map por identificador ligado a função local (forma de colunasCliente)
    "lib/map-identificador.ts": `function colunas() { const par = (c: string) => c + " = NULL"; return ["salao_id"].map(par).join(", "); }
      export async function limpar(tx: { query(s: string, p: unknown[]): Promise<unknown> }) { await tx.query("UPDATE fechamentos SET " + colunas() + " WHERE id = $1", [1]); }`,
    // P2-1 do Astra (delta do merge): flatMap com const também resolve e é escrita
    "lib/flatmap-identificador.ts": `const par = (c: string) => [c + " = NULL"];
      export async function limparFlat(tx: { query(s: string, p: unknown[]): Promise<unknown> }) { await tx.query("UPDATE fechamentos SET " + ["salao_id"].flatMap(par).join(", "), [1]); }`,
    // P2-1 do Astra: vínculo mutável ou indireto → não resolvido (nunca a função do inicializador)
    "lib/map-reatribuido.ts": `export async function reatribuido(tx: { query(s: string): Promise<unknown> }) {
        let cb = (c: string) => "status = NULL";
        cb = (c: string) => "salao_id = NULL";
        await tx.query("UPDATE fechamentos SET " + ["salao_id"].map(cb).join(", "));
      }`,
    "lib/map-alias-reatribuido.ts": `const par = (c: string) => "status = NULL";
      export async function aliasReatribuido(tx: { query(s: string): Promise<unknown> }) {
        let alias = par;
        alias = (c: string) => "salao_id = NULL";
        await tx.query("UPDATE fechamentos SET " + ["x"].flatMap(alias).join(", "));
      }`,
    "lib/map-alias-const.ts": `const par = (c: string) => "status = NULL";
      const alias = par;
      export async function aliasConst(tx: { query(s: string): Promise<unknown> }) { await tx.query("UPDATE fechamentos SET " + ["x"].map(alias).join(", ")); }`,
    "lib/map-var.ts": `var cb = (c: string) => "status = NULL";
      export function trocar() { cb = (c: string) => "salao_id = NULL"; }
      export async function comVar(tx: { query(s: string): Promise<unknown> }) { await tx.query("UPDATE fechamentos SET " + ["x"].map(cb).join(", ")); }`,
    "lib/map-parametro.ts": `export async function comParametro(tx: { query(s: string): Promise<unknown> }, cb: (c: string) => string) { await tx.query("UPDATE fechamentos SET " + ["x"].map(cb).join(", ")); }
      export async function chamarParametro(tx: never) { await comParametro(tx, (c: string) => "salao_id = NULL"); }`,
    // P2-1 do Astra, mesma classe nas chamadas diretas (preexistente ao merge): o callee reatribuído não resolve
    "lib/chamada-let.ts": `export async function chamadaLet(tx: { query(s: string): Promise<unknown> }) {
        let f = () => "UPDATE fechamentos SET status = NULL";
        f = () => "UPDATE fechamentos SET salao_id = NULL";
        await tx.query(f());
      }`,
    "lib/chamada-decl.ts": `function g() { return "UPDATE fechamentos SET status = NULL"; }
      export function trocarG() { (g as unknown) = () => "UPDATE fechamentos SET salao_id = NULL"; }
      export async function chamadaDecl(tx: { query(s: string): Promise<unknown> }) { await tx.query(g()); }`,
    "lib/chamada-prop.ts": `const o = { h: () => "UPDATE fechamentos SET status = NULL" };
      export function trocarH() { o.h = () => "UPDATE fechamentos SET salao_id = NULL"; }
      export async function chamadaProp(tx: { query(s: string): Promise<unknown> }) { await tx.query(o.h()); }`,
    "lib/chamada-assign.ts": `const p = { h: () => "UPDATE fechamentos SET status = NULL" };
      export function trocarAssign() { Object.assign(p, { h: () => "UPDATE fechamentos SET salao_id = NULL" }); }
      export async function chamadaAssign(tx: { query(s: string): Promise<unknown> }) { await tx.query(p.h()); }`,
    "lib/chamada-indice.ts": `const q: Record<string, () => string> = { h: () => "UPDATE fechamentos SET status = NULL" };
      export function trocarIndice(k: string) { q[k] = () => "UPDATE fechamentos SET salao_id = NULL"; }
      export async function chamadaIndice(tx: { query(s: string): Promise<unknown> }) { await tx.query(q.h()); }`,
    // controle: const nunca reatribuído segue resolvido (e é escrita)
    "lib/chamada-const.ts": `const k = () => "UPDATE fechamentos SET salao_id = NULL";
      export async function chamadaConst(tx: { query(s: string): Promise<unknown> }) { await tx.query(k()); }`,
    "lib/map-declaracao.ts": `function cb(c: string) { return "status = NULL"; }
      export function trocarDecl() { (cb as unknown) = () => "salao_id = NULL"; }
      export async function comDeclaracao(tx: { query(s: string): Promise<unknown> }) { await tx.query("UPDATE fechamentos SET " + ["x"].map(cb).join(", ")); }`,
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
  assert.ok(escritas.some((e) => e.startsWith("lib/map-identificador.ts#limpar")), "map com callback por identificador");
  assert.ok(escritas.some((e) => e.startsWith("lib/flatmap-identificador.ts#limparFlat")), "flatMap com callback const");
  // P2-1 do Astra: vínculo não imutável fica não resolvido (fora de teste) — a guarda reprova em vez de calar
  for (const arquivo of ["lib/map-reatribuido.ts", "lib/map-alias-reatribuido.ts", "lib/map-alias-const.ts", "lib/map-var.ts", "lib/map-declaracao.ts"]) {
    assert.ok(r.naoResolvidos.some((x) => x.arquivoOrigem === arquivo && !x.teste && /map sem função literal/.test(x.motivo)), `não resolvido: ${arquivo}`);
  }
  for (const arquivo of ["lib/chamada-let.ts", "lib/chamada-decl.ts", "lib/chamada-prop.ts", "lib/chamada-assign.ts", "lib/chamada-indice.ts"]) {
    assert.ok(r.naoResolvidos.some((x) => x.arquivoOrigem === arquivo && !x.teste), `callee reatribuído não resolvido: ${arquivo}`);
    assert.equal(escritas.some((e) => e.startsWith(arquivo)), false, `sem palpite pelo inicializador: ${arquivo}`);
  }
  assert.ok(escritas.some((e) => e.startsWith("lib/chamada-const.ts#chamadaConst")), "const nunca reatribuído segue resolvido");
  assert.ok(escritas.some((e) => e.startsWith("lib/map-parametro.ts")) ||
    r.naoResolvidos.some((x) => x.arquivoOrigem === "lib/map-parametro.ts" && !x.teste), "callback por parâmetro: escrita ou não resolvido");
  assert.ok(r.naoResolvidos.some((x) => x.arquivoOrigem === "lib/orfao.ts" && /sem chamador/.test(x.motivo)), "sink sem chamador = não resolvido");
  assert.ok(r.naoResolvidos.some((x) => x.arquivoOrigem === "lib/nao-pura.ts" && !x.teste), "retorno não puro = SQL_NAO_RESOLVIDO");
  assert.equal(escritas.some((e) => e.startsWith("lib/leitura.ts")), false, "leitura não é escrita");
  assert.deepEqual(r.sql.map((x) => x.arquivo), ["database/migrations/999_mutante.sql"], "NEW.salao_id em migration nova");
  for (const e of r.escritas) assert.notEqual(e.via, "escreverSalao", "nenhum mutante passa pelo escritor");
});

/**
 * Rodada r3 (P2-R2-1/P2-R2-2 do Astra, 04/11): o vínculo do callee só é provado sem escrita por desestruturação abreviada
 * e sem alias do objeto. Cada caso, executado, monta `UPDATE fechamentos SET salao_id = NULL`; a guarda tem de dar não
 * resolvido (fora de teste) e nenhuma escrita pelo inicializador. Os controles ficam num mini-repositório à parte: a
 * escrita por nome é global (conservadora) e contaminaria um controle com o mesmo nome de propriedade.
 */
test("rodada r3 (P2-R2 do Astra): desestruturação abreviada, alias e vazamento do objeto não resolvem o callee", () => {
  const T = "tx: { query(s: string): Promise<unknown> }";
  const Q = 'await tx.query("UPDATE fechamentos SET " + ';
  const escapes: Record<string, string> = {
    // P2-R2-1 (reprodução do Astra): abreviado marca o símbolo do valor
    "lib/r3-abreviado-map.ts": `let h1 = () => "status = NULL";\n({h1} = {h1: () => "salao_id = NULL"});\nconst cb1 = () => h1();\nexport async function a(${T}) { ${Q}["x"].map(cb1).join(", ")); }`,
    "lib/r3-abreviado-direto.ts": `let h2 = () => "status = NULL";\n({h2} = {h2: () => "salao_id = NULL"});\nexport async function b(${T}) { ${Q}h2()); }`,
    "lib/r3-abreviado-padrao.ts": `let h3 = () => "status = NULL";\n({h3 = () => "x"} = {h3: () => "salao_id = NULL"});\nexport async function c(${T}) { ${Q}h3()); }`,
    // P2-R2-2 (reprodução do Astra): mutação por alias do objeto
    "lib/r3-alias-assign-map.ts": `const o1 = {f: () => "status = NULL"};\nconst a1 = o1;\nObject.assign(a1, {f: () => "salao_id = NULL"});\nconst cb2 = () => o1.f();\nexport async function d(${T}) { ${Q}["x"].map(cb2).join(", ")); }`,
    "lib/r3-alias-indice.ts": `const o2 = {g: () => "status = NULL"};\nconst a2: any = o2; const k2 = ["g"][0];\na2[k2] = () => "salao_id = NULL";\nexport async function e(${T}) { ${Q}o2.g()); }`,
    "lib/r3-argumento.ts": `const o3 = {i: () => "status = NULL"};\nfunction troca3(x: any) { x["i"] = () => "salao_id = NULL"; }\ntroca3(o3);\nexport async function f(${T}) { ${Q}o3.i()); }`,
    "lib/r3-defineProperty.ts": `const o4 = {j: () => "status = NULL"};\nconst a4 = o4;\nObject.defineProperty(a4, "j", {value: () => "salao_id = NULL"});\nexport async function g(${T}) { ${Q}o4.j()); }`,
    "lib/r3-elo-intermediario.ts": `const o5 = {p5: {l: () => "status = NULL"}};\nconst q5 = o5.p5;\nObject.assign(q5, {l: () => "salao_id = NULL"});\nexport async function h(${T}) { ${Q}o5.p5.l()); }`,
    "lib/r3-this.ts": `const o6 = {m6: () => "status = NULL", t6(k: string) { (this as any)[k] = () => "salao_id = NULL"; }};\no6.t6(["m6"][0]);\nexport async function i(${T}) { ${Q}o6.m6()); }`,
    // P2-R3-1 (r4): membro herdado chamado com a raiz/elo como receptor implícito
    "lib/r4-define-getter.ts": `const o10 = {q10: () => "status = NULL"};\no10.__defineGetter__("q10", () => () => "salao_id = NULL");\nconst cb10 = () => o10.q10();\nexport async function m(${T}) { ${Q}["x"].map(cb10).join(", ")); }`,
    "lib/r4-define-getter-chave.ts": `const o11 = {q11: () => "status = NULL"};\no11["__defineGetter__"]("q11", () => () => "salao_id = NULL");\nexport async function n(${T}) { ${Q}o11.q11()); }`,
    "lib/r4-elo-define-getter.ts": `const o12 = {p12: {q12: () => "status = NULL"}};\no12.p12.__defineGetter__("q12", () => () => "salao_id = NULL");\nexport async function o(${T}) { ${Q}o12.p12.q12()); }`,
    "lib/r4-callee-dinamico.ts": `const o13: Record<string, any> = {q13: () => "status = NULL"};\nconst k13 = ["__define", "Getter__"].join("");\no13[k13]("q13", () => () => "salao_id = NULL");\nexport async function p(${T}) { ${Q}o13.q13()); }`,
    // sem anotação de tipo: o literal resolve q16 pelo símbolo, e só a marcação do callee dinâmico o derruba
    "lib/r4-callee-dinamico-sem-tipo.ts": `const o16 = {q16: () => "status = NULL"};\nconst k16 = ["__define", "Getter__"].join("");\no16[k16]("q16", () => () => "salao_id = NULL");\nexport async function q(${T}) { ${Q}o16.q16()); }`,
    "lib/r3-indice-raiz.ts": `const o9 = {n9: () => "status = NULL"};\nconst k9 = ["n9"][0];\no9[k9 as "n9"] = () => "salao_id = NULL";\nexport async function l(${T}) { ${Q}o9.n9()); }`,
    // Sink derivado alcançado por vínculo não provado: a chamada vira não resolvida (não some em silêncio).
    "lib/r3-sink-derivado.ts": `function exec7(tx: { query(s: string): Promise<unknown> }, s: string) { return tx.query(s); }\nexport async function ler7(${T}) { await exec7(tx, "SELECT 1"); }\nconst o7 = {run7: exec7};\nconst a7 = o7;\nexport async function j(${T}) { await o7.run7(tx, "UPDATE fechamentos SET salao_id = NULL"); }\nexport const usar7 = a7;`,
    // Valor de let reatribuído por desestruturação abreviada (mesma classe do P2-R2-1, no resolvedor de valores).
    "lib/r3-let-abreviado.ts": `let s8 = "UPDATE fechamentos SET status = NULL";\n({s8} = {s8: "UPDATE fechamentos SET salao_id = NULL"});\nexport async function k(${T}) { await tx.query(s8); }`,
  };
  const r = miniRepositorio(escapes);
  const escritas = producao(r);
  for (const arquivo of Object.keys(escapes)) {
    assert.ok(r.naoResolvidos.some((x) => x.arquivoOrigem === arquivo && !x.teste), `não resolvido: ${arquivo}`);
    assert.equal(escritas.some((e) => e.startsWith(arquivo)), false, `sem palpite pelo inicializador: ${arquivo}`);
  }
  const controles = miniRepositorio({
    "lib/ns-alvo.ts": `export function nsH() { return "salao_id = NULL"; }`,
    "lib/r3-objeto-const.ts": `const c1 = {f: () => "salao_id = NULL"};\nexport async function a(${T}) { ${Q}c1.f()); }`,
    "lib/r3-objeto-aninhado.ts": `const c2 = {p: {f: () => "salao_id = NULL"}};\nexport async function b(${T}) { ${Q}c2.p.f()); }`,
    "lib/r3-namespace.ts": `import * as ns from "./ns-alvo.ts";\nexport async function c(${T}) { ${Q}ns.nsH()); }`,
    "lib/r3-callback-funcao.ts": `function hc() { return "salao_id = NULL"; }\nconst cbc = () => hc();\nexport async function d(${T}) { ${Q}["x"].map(cbc).join(", ")); }`,
    // r4: `eval` só como nome de propriedade (opção de Worker) não é referência a eval
    "lib/r4-opcao-eval.ts": `const opcoes = {eval: true};\nconst c3 = {f: () => "salao_id = NULL"};\nexport async function e(${T}) { void opcoes; ${Q}c3.f()); }`,
  });
  const ok = producao(controles);
  for (const arquivo of ["lib/r3-objeto-const.ts", "lib/r3-objeto-aninhado.ts", "lib/r3-namespace.ts", "lib/r3-callback-funcao.ts", "lib/r4-opcao-eval.ts"]) {
    assert.ok(ok.some((e) => e.startsWith(arquivo)), `controle segue resolvido: ${arquivo}`);
  }
  // P2-R3-2 (r4): eval em qualquer forma derruba a resolução do repositório inteiro — mini-repositório próprio, senão
  // mascararia os demais casos.
  const comEval = miniRepositorio({
    "lib/r4-eval-parenteses.ts": `let h14 = () => "status = NULL";\n(eval)("h14 = () => 'salao_id = NULL'");\nconst cb14 = () => h14();\nexport async function a(${T}) { ${Q}["x"].map(cb14).join(", ")); }`,
    "lib/r4-eval-as.ts": `let h15 = () => "status = NULL";\n(eval as any)("h15 = () => 'salao_id = NULL'");\nexport async function b(${T}) { ${Q}h15()); }`,
  });
  for (const arquivo of ["lib/r4-eval-parenteses.ts", "lib/r4-eval-as.ts"]) {
    assert.ok(comEval.naoResolvidos.some((x) => x.arquivoOrigem === arquivo && !x.teste), `não resolvido com eval: ${arquivo}`);
    assert.equal(producao(comEval).some((e) => e.startsWith(arquivo)), false, `sem palpite pelo inicializador: ${arquivo}`);
  }
  // P2-R4-1 (r5): membro herdado alcançado por `this`/`super` dentro de um método da raiz ou do elo. Um mini-repositório
  // por caso: os acessos por this são globais (conservadores) e um caso mascararia o outro.
  const G = '("q", () => () => "salao_id = NULL")';
  const porThis: Record<string, Record<string, string>> = {
    "lib/r5-this-ponto.ts": { "lib/r5-this-ponto.ts": `const o = {\n  q: () => "status = NULL",\n  mudar() {\n    this.__defineGetter__${G};\n  },\n};\no.mudar();\nexport async function a(${T}) { ${Q}o.q()); }` },
    "lib/r5-this-chave.ts": { "lib/r5-this-chave.ts": `const o = {\n  q: () => "status = NULL",\n  mudar() {\n    this["__defineGetter__"]${G};\n  },\n};\no.mudar();\nexport async function a(${T}) { ${Q}o.q()); }` },
    "lib/r5-super.ts": { "lib/r5-super.ts": `const o = {\n  q: () => "status = NULL",\n  mudar() {\n    super.__defineGetter__${G};\n  },\n};\no.mudar();\nexport async function a(${T}) { ${Q}o.q()); }` },
    // elo alcançado pelo namespace: a raiz não é literal, só a regra do elo derruba
    "lib/r5-elo-namespace.ts": {
      "lib/r5-cfg.ts": `export const cfg = {\n  q: () => "status = NULL",\n  mudar() {\n    this.__defineGetter__${G};\n  },\n};\ncfg.mudar();`,
      "lib/r5-elo-namespace.ts": `import * as ns from "./r5-cfg.ts";\nexport async function a(${T}) { ${Q}ns.cfg.q()); }`,
    },
    // P2-R5-1 (r6): partes de classe/método interno avaliadas no contexto do método externo enxergam o this/super dele
    "lib/r6-extends.ts": { "lib/r6-extends.ts": `const o = {\n  q: () => "status = NULL",\n  mudar() {\n    class C extends ((this as any).__defineGetter__${G}, Object) {}\n    void C;\n  },\n};\no.mudar();\nexport async function a(${T}) { ${Q}o.q()); }` },
    "lib/r6-membro-computado.ts": { "lib/r6-membro-computado.ts": `const o = {\n  q: () => "status = NULL",\n  mudar() {\n    class C { [super.__defineGetter__${G}]() {} }\n    void C;\n  },\n};\no.mudar();\nexport async function a(${T}) { ${Q}o.q()); }` },
    "lib/r6-literal-computado.ts": { "lib/r6-literal-computado.ts": `const o = {\n  q: () => "status = NULL",\n  mudar() {\n    const p = { [this.__defineGetter__${G}]() {} };\n    void p;\n  },\n};\no.mudar();\nexport async function a(${T}) { ${Q}o.q()); }` },
    "lib/r6-decorador.ts": { "lib/r6-decorador.ts": `const o = {\n  q: () => "status = NULL",\n  mudar() {\n    @((this as any).__defineGetter__${G}, (c: any) => c) class C {}\n    void C;\n  },\n};\no.mudar();\nexport async function a(${T}) { ${Q}o.q()); }` },
    // r7 (P2-R6-1): decorador de parâmetro de construtor e de método da classe interna.
    "lib/r7-param-construtor.ts": { "lib/r7-param-construtor.ts": `const o = {\n  q: () => "status = NULL",\n  mudar() {\n    class C { constructor(@((this as any).__defineGetter__${G}, (...a: any[]) => {}) x: any) { void x; } }\n    void C;\n  },\n};\no.mudar();\nexport async function a(${T}) { ${Q}o.q()); }` },
    "lib/r7-param-metodo.ts": { "lib/r7-param-metodo.ts": `const o = {\n  q: () => "status = NULL",\n  mudar() {\n    class C { m(@((this as any).__defineGetter__${G}, (...a: any[]) => {}) x: any) { return x; } }\n    void C;\n  },\n};\no.mudar();\nexport async function a(${T}) { ${Q}o.q()); }` },
  };
  for (const [arquivo, arquivos] of Object.entries(porThis)) {
    const rt = miniRepositorio(arquivos);
    assert.ok(rt.naoResolvidos.some((x) => x.arquivoOrigem === arquivo && !x.teste), `não resolvido por this/super: ${arquivo}`);
    assert.equal(producao(rt).some((e) => e.startsWith(arquivo)), false, `sem palpite pelo inicializador: ${arquivo}`);
  }
  // Controles da r5: método que lê por this só membros próprios segue resolvido, na raiz e no elo pelo namespace.
  const thisProprio = miniRepositorio({
    "lib/r5-cfg-ok.ts": `export const cfgOk = {\n  q: () => "salao_id = NULL",\n  dobro() { return this.q() + this.q(); },\n};`,
    "lib/r5-this-proprio.ts": `const o = {\n  q: () => "salao_id = NULL",\n  dobro() { return this.q() + this.q(); },\n};\nvoid o.dobro;\nexport async function a(${T}) { ${Q}o.q()); }`,
    "lib/r5-elo-namespace-ok.ts": `import * as ns from "./r5-cfg-ok.ts";\nexport async function b(${T}) { ${Q}ns.cfgOk.q()); }`,
  });
  for (const arquivo of ["lib/r5-this-proprio.ts", "lib/r5-elo-namespace-ok.ts"]) {
    assert.ok(producao(thisProprio).some((e) => e.startsWith(arquivo)), `controle r5 segue resolvido: ${arquivo}`);
  }
  // Controle da r6: classe interna cujo this é o próprio (corpo de método, campo, bloco estático) não torna o literal impuro.
  const classeInterna = miniRepositorio({
    "lib/r6-classe-interna.ts": `const o = {\n  q: () => "salao_id = NULL",\n  fabrica() { class C { x = 1; m() { return this.x; } static { void this.name; } } return C; },\n};\nvoid o.fabrica;\nexport async function a(${T}) { ${Q}o.q()); }`,
  });
  assert.ok(producao(classeInterna).some((e) => e.startsWith("lib/r6-classe-interna.ts")), "controle r6 segue resolvido");
  // Controle da r7: o default de parâmetro usa o receptor da invocação interna e não torna o literal impuro.
  const defaultInterno = miniRepositorio({
    "lib/r7-default-interno.ts": `const o = {\n  q: () => "salao_id = NULL",\n  fabrica() { class C { y = 1; m(x = this.y) { return x; } } return C; },\n};\nvoid o.fabrica;\nexport async function a(${T}) { ${Q}o.q()); }`,
  });
  assert.ok(producao(defaultInterno).some((e) => e.startsWith("lib/r7-default-interno.ts")), "controle r7 segue resolvido");
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
/**
 * `.query` usado como valor fora de arquivo de teste: a própria instrumentação da guarda dinâmica e o harness PG do
 * atendimento multiempresa (lê a coluna `query` de pg_stat_activity; importado só pelos `.postgres.test.ts`).
 */
const COMO_VALOR_DECLARADO = ["scripts/guarda-salao-preload.cjs", "lib/whatsapp/atendimento/harness-multiempresa.ts"];

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
