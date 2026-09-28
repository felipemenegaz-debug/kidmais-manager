// Harness PostgreSQL da 054, sem banco: executor simulado que registra cada SQL.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EMPRESAS_LEGADAS_054, EMPRESAS_RESERVADAS_054, ORDEM_REMOCAO_054, VINCULOS_INDIRETOS_054,
  empresaReservada054, executarComLimpeza054, exigirSemResiduo054, novoRegistro054, registrar054, removerRegistrados054,
  vinculosDaEmpresa054, type ErroComLimpeza, type Executor054, type Limpeza054,
} from "./harness-054.ts";

const ID = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
type Linha = Record<string, unknown>;
/** Executor simulado: `responder` decide as linhas; todo SQL fica registrado. */
function executor(responder: (sql: string, v: unknown[]) => Linha[] = () => []) {
  const sql: { texto: string; v: unknown[] }[] = [];
  const exec: Executor054 = {
    async query<Row extends object>(texto: string, v: readonly unknown[] = []) {
      sql.push({ texto, v: [...v] });
      return { rows: responder(texto, [...v]) as Row[], rowCount: 0 };
    },
  };
  const deletes = () => sql.filter((s) => /^\s*DELETE\b/i.test(s.texto));
  const inserts = () => sql.filter((s) => /^\s*INSERT\b/i.test(s.texto));
  return { exec, sql, deletes, inserts };
}
const FKS = [
  { esquema: "public", tabela: "memberships", coluna: "empresa_id" },
  { esquema: "public", tabela: "estabelecimentos", coluna: "empresa_id" },
  { esquema: "public", tabela: "pacotes", coluna: "empresa_id" },
  { esquema: "public", tabela: "clientes", coluna: "empresa_id" },
  { esquema: "public", tabela: "fechamentos", coluna: "empresa_id" },
  { esquema: "public", tabela: "financeiro_lancamentos", coluna: "empresa_id" },
];
/** Banco simulado de empresas: linhas por código/nome, contagem de vínculos por origem. */
function empresas(opcoes: { porCodigo?: Linha[]; porNome?: Linha[]; vinculos?: Record<string, number>; fks?: typeof FKS; residuo?: Record<string, number>; conhecidas?: Linha[] } = {}) {
  return executor((sql) => {
    if (sql.includes("WHERE codigo = $1")) return opcoes.porCodigo ?? [];
    if (sql.includes("WHERE nome = $1")) return opcoes.porNome ?? [];
    if (sql.includes("k.confrelid = 'public.empresas'::regclass")) return opcoes.fks ?? FKS;
    if (sql.startsWith("INSERT INTO empresas")) return [{ id: ID(99) }];
    if (sql.includes("AS pacotes,")) return [opcoes.residuo ?? { pacotes: 0, tabelas: 0, clientes: 0, agendas: 0, usuarios: 0, empresas: 0 }];
    if (sql.includes("WHERE codigo = ANY($1::text[])")) return opcoes.conhecidas ?? [];
    if (sql.startsWith("SELECT count(")) {
      const fk = /FROM "public"\."(\w+)" WHERE "(\w+)"/.exec(sql);
      const chave = fk ? `${fk[1]}.${fk[2]}` : VINCULOS_INDIRETOS_054.find(([, q]) => q === sql)?.[0] ?? "?";
      return [{ n: opcoes.vinculos?.[chave] ?? 0 }];
    }
    return [];
  });
}
const valida = (papel: "A" | "B", extra: Linha = {}) => ({ id: ID(papel === "A" ? 1 : 2), codigo: EMPRESAS_RESERVADAS_054[papel].codigo, nome: EMPRESAS_RESERVADAS_054[papel].nome, status: "PROVISIONAMENTO", desativado_em: null, ...extra });

// ---------------------------------------------------------------------------------------------
// 1. Empresas reservadas: identidade inequívoca ou aborto.
// ---------------------------------------------------------------------------------------------
test("empresa reservada: código determinístico válido no formato do schema e distinto dos legados", () => {
  for (const e of Object.values(EMPRESAS_RESERVADAS_054)) assert.match(e.codigo, /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/);
  assert.notEqual(EMPRESAS_RESERVADAS_054.A.codigo, EMPRESAS_RESERVADAS_054.B.codigo);
  for (const l of EMPRESAS_LEGADAS_054) assert(!Object.values(EMPRESAS_RESERVADAS_054).some((e) => e.codigo === l.codigo));
});
test("empresa reservada: ausente é criada com código e nome reservados, em PROVISIONAMENTO", async () => {
  const b = empresas();
  assert.equal(await empresaReservada054(b.exec, "A"), ID(99));
  assert.equal(b.inserts().length, 1);
  assert.deepEqual(b.inserts()[0].v, [EMPRESAS_RESERVADAS_054.A.codigo, EMPRESAS_RESERVADAS_054.A.nome]);
  assert.match(b.inserts()[0].texto, /'PROVISIONAMENTO'/);
});
test("empresa reservada: existente, com atributos esperados e sem vínculo, é reutilizada sem escrita", async () => {
  const b = empresas({ porCodigo: [valida("B")], porNome: [valida("B")] });
  assert.equal(await empresaReservada054(b.exec, "B"), ID(2));
  assert.deepEqual(b.inserts(), []);
  assert.deepEqual(b.deletes(), []);
});
test("empresa reservada: colisão, duplicidade ou atributo inesperado aborta sem escrever", async () => {
  const casos: [string, Parameters<typeof empresas>[0], RegExp][] = [
    ["nome reservado usado por outra empresa", { porNome: [{ ...valida("A"), id: ID(7), codigo: "empresa-real" }] }, /nome reservado usado por outra empresa/],
    ["nome duplicado", { porCodigo: [valida("A")], porNome: [valida("A"), { ...valida("A"), id: ID(8) }] }, /duplicidade/],
    ["código duplicado (catálogo inesperado)", { porCodigo: [valida("A"), valida("A")] }, /duplicidade/],
    ["nome divergente", { porCodigo: [valida("A", { nome: "Empresa Real" })] }, /atributos inesperados/],
    ["status ATIVA", { porCodigo: [valida("A", { status: "ATIVA" })] }, /atributos inesperados/],
    ["desativada", { porCodigo: [valida("A", { status: "DESATIVADA", desativado_em: "2026-01-01" })] }, /atributos inesperados/],
    ["código e nome em empresas diferentes", { porCodigo: [valida("A")], porNome: [{ ...valida("A"), id: ID(9) }] }, /atributos inesperados/],
  ];
  for (const [caso, opcoes, erro] of casos) {
    const b = empresas(opcoes);
    await assert.rejects(empresaReservada054(b.exec, "A"), erro, caso);
    assert.deepEqual(b.inserts(), [], caso);
    assert.deepEqual(b.deletes(), [], caso);
  }
});
test("empresa reservada: qualquer vínculo (FK descoberta ou caminho indireto) impede o uso", async () => {
  const origens = ["memberships.empresa_id", "estabelecimentos.empresa_id", "pacotes.empresa_id", "clientes.empresa_id", "fechamentos.empresa_id",
    "financeiro_lancamentos.empresa_id", ...VINCULOS_INDIRETOS_054.map(([nome]) => nome)];
  for (const origem of origens) {
    const b = empresas({ porCodigo: [valida("A")], porNome: [valida("A")], vinculos: { [origem]: 1 } });
    await assert.rejects(empresaReservada054(b.exec, "A"), new RegExp(`não está limpa.*${origem.replace(/[()]/g, "\\$&")}=1`), origem);
  }
});
test("vínculos: toda FK para empresas vem do catálogo; indiretos cobrem clientes, fechamentos, contratos, revisões e pagamentos", async () => {
  const b = empresas();
  assert.deepEqual(await vinculosDaEmpresa054(b.exec, ID(1)), []);
  for (const fk of FKS) assert(b.sql.some((s) => s.texto.includes(`FROM "public"."${fk.tabela}" WHERE "${fk.coluna}" = $1::uuid`) && s.v[0] === ID(1)), fk.tabela);
  const nomes = VINCULOS_INDIRETOS_054.map(([n]) => n).join(" ");
  for (const alvo of ["clientes", "fechamentos", "contratos", "revisões", "pagamentos"]) assert(nomes.includes(alvo), alvo);
  await assert.rejects(vinculosDaEmpresa054(empresas({ fks: [] }).exec, ID(1)), /nenhuma FK/);
  await assert.rejects(vinculosDaEmpresa054(empresas({ fks: [{ esquema: "public", tabela: 'x"; DROP', coluna: "a" }] }).exec, ID(1)), /identificador inesperado/);
});

// ---------------------------------------------------------------------------------------------
// 2. Resíduo preexistente: erro e ZERO DELETE; limpeza só por IDs registrados nesta execução.
// ---------------------------------------------------------------------------------------------
test("registro: vazio não gera SQL; com IDs, só DELETE por id na ordem das FKs e nunca empresa", async () => {
  const vazio = executor();
  await removerRegistrados054(vazio.exec, novoRegistro054());
  assert.deepEqual(vazio.sql, []);
  const reg = novoRegistro054();
  registrar054(reg, "pacotes", ID(3));
  registrar054(reg, "fechamentos", ID(4));
  registrar054(reg, "clientes", ID(5));
  registrar054(reg, "clientes_mesclados", ID(6));
  const b = executor();
  await removerRegistrados054(b.exec, reg);
  assert.deepEqual(b.sql.map((s) => s.texto), ["BEGIN", "DELETE FROM fechamentos WHERE id = ANY($1::uuid[])", "DELETE FROM clientes WHERE id = ANY($1::uuid[])",
    "DELETE FROM clientes WHERE id = ANY($1::uuid[])", "DELETE FROM pacotes WHERE id = ANY($1::uuid[])", "COMMIT"]);
  assert.deepEqual(b.deletes().map((s) => s.v[0]), [[ID(4)], [ID(6)], [ID(5)], [ID(3)]]);
  assert(!b.sql.some((s) => /LIKE|empresas/i.test(s.texto)));
  assert(!(ORDEM_REMOCAO_054 as readonly string[]).includes("empresas"));
  assert.throws(() => registrar054(reg, "pacotes", "x' OR true"), /id inválido/);
});
test("resíduo preexistente: o ciclo aborta e a limpeza não executa nenhum DELETE", async () => {
  for (const opcoes of [
    { residuo: { pacotes: 2, tabelas: 0, clientes: 5, agendas: 0, usuarios: 0, empresas: 0 } },
    { residuo: { pacotes: 0, tabelas: 0, clientes: 0, agendas: 0, usuarios: 0, empresas: 1 } },
    { conhecidas: [{ id: EMPRESAS_LEGADAS_054[0].id, codigo: EMPRESAS_LEGADAS_054[0].codigo }], vinculos: { "pacotes.empresa_id": 1 } },
  ]) {
    const b = empresas(opcoes);
    const reg = novoRegistro054();
    const chamadas: string[] = [];
    let erro: unknown;
    try {
      await executarComLimpeza054(async () => { await exigirSemResiduo054(b.exec); registrar054(reg, "pacotes", ID(1)); }, { instalou053: false, instalou054: false }, {
        removerRegistrados: () => removerRegistrados054(b.exec, reg),
        instalada054: async () => false, down054: async () => { chamadas.push("down054"); return null; },
        ausencia054: async () => true, down053: async () => { chamadas.push("down053"); return null; },
        verificarFinal: async () => {}, encerrar: async () => {},
      });
    } catch (e) {
      erro = e;
    }
    assert.match(String((erro as Error)?.message), /resíduo preexistente do harness 054.*abortado sem limpeza destrutiva/);
    assert.deepEqual(b.deletes(), [], "nenhum DELETE em dado preexistente");
    assert.deepEqual(chamadas, [], "nada instalado por esta execução, nada desfeito");
  }
});

// ---------------------------------------------------------------------------------------------
// 3/4. Orquestração: 053 preservada enquanto a 054 existir; erro principal sempre preservado.
// ---------------------------------------------------------------------------------------------
function limpeza(sobrescrever: Partial<Limpeza054> = {}) {
  const chamadas: string[] = [];
  const passo = <T>(nome: string, valor: T) => async () => { chamadas.push(nome); return valor; };
  const l: Limpeza054 = {
    removerRegistrados: passo("remover", undefined), instalada054: passo("instalada054", true), down054: passo("down054", null),
    ausencia054: passo("ausencia054", true), down053: passo("down053", null), verificarFinal: passo("verificar", undefined), encerrar: passo("encerrar", undefined),
  };
  for (const [k, fn] of Object.entries(sobrescrever)) (l as Record<string, unknown>)[k] = async () => { chamadas.push(k); return (fn as () => Promise<unknown>)(); };
  return { l, chamadas };
}
const falha = (m: string) => async () => { throw new Error(m); };
async function capturar(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as ErroComLimpeza;
  }
  return null;
}

test("orquestração: sucesso remove a 053 só depois de comprovar a ausência da 054", async () => {
  const { l, chamadas } = limpeza();
  assert.equal(await capturar(executarComLimpeza054(async () => {}, { instalou053: true, instalou054: true }, l)), null);
  assert.deepEqual(chamadas, ["remover", "instalada054", "down054", "ausencia054", "down053", "verificar", "encerrar"]);
});
test("orquestração: down da 054 falha e a 054 continua → 053 preservada e recuperação pendente", async () => {
  const { l, chamadas } = limpeza({ down054: async () => "054 rollback: remover a 054 perderia empresa", ausencia054: async () => false });
  const erro = await capturar(executarComLimpeza054(async () => {}, { instalou053: true, instalou054: true }, l));
  assert(erro instanceof AggregateError);
  assert(!chamadas.includes("down053"), "down 053 não executado");
  assert.match(erro.message, /down 054: 054 rollback.*recuperação pendente.*053 foi preservada/);
});
test("orquestração: consulta da ausência falha → 053 preservada (na dúvida não degrada a dependência)", async () => {
  const { l, chamadas } = limpeza({ ausencia054: falha("conexão perdida") });
  const erro = await capturar(executarComLimpeza054(async () => {}, { instalou053: true, instalou054: false }, l));
  assert(!chamadas.includes("down053"));
  assert.match(String(erro?.message), /comprovar ausência da 054: conexão perdida.*recuperação pendente/);
});
test("erro principal + erro no encerramento: o principal é relançado (mesmo objeto) com o de limpeza anexado", async () => {
  const principal = new Error("falha principal do ciclo");
  const { l } = limpeza({ encerrar: falha("encerrar054 falhou") });
  const erro = await capturar(executarComLimpeza054(async () => { throw principal; }, { instalou053: false, instalou054: false }, l));
  assert.equal(erro, principal);
  assert.deepEqual(erro?.errosDeLimpeza, ["encerrar conexão: encerrar054 falhou"]);
});
test("erro principal + erro na consulta instalada054: principal preservado; down tentado; 053 preservada se a 054 persistir", async () => {
  const principal = new Error("falha principal do ciclo");
  const { l, chamadas } = limpeza({ instalada054: falha("consulta instalada054 falhou"), down054: async () => "down falhou", ausencia054: async () => false });
  const erro = await capturar(executarComLimpeza054(async () => { throw principal; }, { instalou053: true, instalou054: true }, l));
  assert.equal(erro, principal);
  assert(chamadas.includes("down054"), "na dúvida, tenta o down oficial");
  assert(!chamadas.includes("down053"));
  assert.deepEqual(erro?.errosDeLimpeza, ["consultar 054: consulta instalada054 falhou", "down 054: down falhou",
    "recuperação pendente: a 054 não está comprovadamente ausente; a 053 foi preservada."]);
});
test("múltiplos erros de limpeza: todos registrados em ordem, todos os passos seguintes ainda executam", async () => {
  const principal = new Error("falha principal do ciclo");
  const { l, chamadas } = limpeza({ removerRegistrados: falha("remoção falhou"), verificarFinal: falha("verificação falhou"), encerrar: falha("encerrar falhou") });
  const erro = await capturar(executarComLimpeza054(async () => { throw principal; }, { instalou053: true, instalou054: false }, l));
  assert.equal(erro, principal);
  assert.deepEqual(erro?.errosDeLimpeza, ["remover fixtures registradas: remoção falhou", "verificação final: verificação falhou", "encerrar conexão: encerrar falhou"]);
  assert.deepEqual(chamadas, ["removerRegistrados", "ausencia054", "down053", "verificarFinal", "encerrar"]);
});
test("erro principal que não é Error: embrulhado com cause; sem principal, erros de limpeza falham o ciclo", async () => {
  const { l } = limpeza();
  const erro = await capturar(executarComLimpeza054(async () => { throw "texto"; }, { instalou053: false, instalou054: false }, l));
  assert.equal((erro as Error & { cause?: unknown }).cause, "texto");
  const semPrincipal = await capturar(executarComLimpeza054(async () => {}, { instalou053: false, instalou054: false }, limpeza({ encerrar: falha("x") }).l));
  assert(semPrincipal instanceof AggregateError);
});

// ---------------------------------------------------------------------------------------------
// Ligação com o harness PostgreSQL (estrutura; o ciclo real roda só com autorização).
// ---------------------------------------------------------------------------------------------
test("harness PostgreSQL: resíduo antes de escrever, limpeza só por registro, K2 exige o resultado de domínio", () => {
  const h = readFileSync("lib/fechamentos/migration-054.postgres.test.ts", "utf8");
  const ciclo = h.slice(h.indexOf("const ciclo = async"), h.indexOf("await executarComLimpeza054("));
  assert(ciclo.indexOf("exigirSemResiduo054(db)") > 0);
  for (const escrita of ["arquivo(db, SQL.up053)", "abortos(db)", "criarFixtures(db, reg)"]) assert(ciclo.indexOf("exigirSemResiduo054(db)") < ciclo.indexOf(escrita), escrita);
  assert.doesNotMatch(h, /DELETE FROM \w+ WHERE [^"`]*LIKE/);
  assert.doesNotMatch(h, /removerFixtures|empresaReservada\(/);
  assert.match(h, /executarComLimpeza054\(ciclo, estadoCiclo, \{/);
  assert.match(h, /removerRegistrados054\(db, reg\)/);
  assert.match(h, /assert\.equal\(resultado\.split\(":"\)\[0\], "REVISAO_COMERCIAL_INVALIDA"/);
  assert.match(h, /assert\.equal\(atividade\.tipo, "Lock"/, "H3: espera real por lock continua exigida");
  assert.match(h, /FOR UPDATE\/, "espera no lock de domínio"/);
});
