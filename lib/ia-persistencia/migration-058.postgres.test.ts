import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";
import { criarCatalogoSkills } from "../inteligencia/skills/catalogo.ts";
import { conteudoSchema, skillSchema, type Skill } from "../inteligencia/skills/contrato.ts";
import { SKILLS_PLATAFORMA } from "../inteligencia/skills/plataforma.ts";
import { hashSkill } from "../inteligencia/skills/validacao.ts";
import { criarRepositorioSkillsPostgres } from "./skills.ts";

/**
 * Migration 058 (skills de empresa/unidade) no PostgreSQL descartável — só pelo `check:v1:postgres`, com opt-in.
 * Tudo numa transação que termina em ROLLBACK, com os scripts REAIS (up, postcheck, rollback precheck, down,
 * verificação pós-rollback): escopo, coerência da definição, unicidade da versão ATIVA, imutabilidade, transições,
 * DELETE/TRUNCATE recusados, leitura pelo repositório real e resolução Plataforma → Empresa → Unidade pelo catálogo real.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP = ler("database/migrations/20260929_058_inteligencia_skills.sql");
const POST = ler("database/checks/20260929_058_postcheck.sql");
const DOWN = ler("database/rollback/20260929_058_inteligencia_skills_down.sql");
const PRE_DOWN = ler("database/checks/20260929_058_rollback_precheck.sql");
const POS_DOWN = ler("database/checks/20260929_058_rollback_postcheck.sql");
const cod = (p: string) => `${p}${randomBytes(4).toString("hex")}`;

function override(empresaId: string, estabelecimentoId: string | null, versao: string, tom: string): Skill {
  const base: Omit<Skill, "hash"> = {
    id: "atendimento_familias", nivel: estabelecimentoId ? "ESTABELECIMENTO" : "EMPRESA", escopo: { empresaId, estabelecimentoId },
    finalidades: ["SUGESTAO_TEXTO", "ATENDIMENTO"], capacidades: [], versao,
    proveniencia: { origem: "EMPRESA", autor: "Harness 058", referencia: "cadastro-harness" },
    revisao: { estado: "APROVADA", revisor: "Harness", revisadoEm: "2026-09-29", hashRevisado: null },
    permissoes: { classes: ["READ", "SUGGEST"] }, restricoes: ["Só textos para a equipe revisar."],
    conteudo: { tom, instrucoes: [], procedimentos: [], objecoes: [], templates: [], formatacao: { maxParagrafos: null, usarListas: null } },
  };
  const hash = hashSkill(base);
  return { ...base, hash, revisao: { ...base.revisao, hashRevisado: hash } };
}

async function recusa(db: Client, sql: string, valores: unknown[], motivo: RegExp) {
  await db.query("SAVEPOINT recusa");
  await assert.rejects(db.query(sql, valores), motivo);
  await db.query("ROLLBACK TO SAVEPOINT recusa");
}

test("058: skills de empresa/unidade — escopo, imutabilidade, uma ATIVA, leitura real e rollback, com Core intacto", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const db = await conectarDescartavel();
  const id = async (sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
  try {
    await db.query("BEGIN");
    assert.equal((await db.query<{ ok: boolean }>(`SELECT to_regclass('public.ia_skills') IS NULL AS ok`)).rows[0].ok, true, "descartável começa sem a 058");
    await db.query(semTransacaoExplicita(UP));
    await db.query(POST);
    await recusa(db, semTransacaoExplicita(UP), [], /058 já aplicada/);

    const empresa = async (nome: string) => {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("sk"), nome]);
      await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      return e;
    };
    const A = await empresa("Empresa skills A");
    const B = await empresa("Empresa skills B");
    const autor = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness 058', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
      [`${cod("u")}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
    const unidadeA = await id(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, 'Unidade A', 'SUSPENSO') RETURNING id`, [A, cod("ua")]);
    const unidadeB = await id(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, 'Unidade B', 'SUSPENSO') RETURNING id`, [B, cod("ub")]);

    const inserir = `INSERT INTO ia_skills (empresa_id, estabelecimento_id, nivel, skill_id, versao, hash, status, definicao, criado_por)
                     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid) RETURNING id`;
    const valores = (s: Skill, status: string) => [s.escopo.empresaId, s.escopo.estabelecimentoId, s.nivel, s.id, s.versao, s.hash, status, JSON.stringify(s), autor];

    const empresaV1 = override(A, null, "1.1.0", "Tom da empresa A.");
    const linhaEmpresa = await id(inserir, valores(empresaV1, "ATIVA"));
    const unidadeV1 = override(A, unidadeA, "1.2.0", "Tom da unidade A.");
    await id(inserir, valores(unidadeV1, "ATIVA"));
    await id(inserir, valores(override(B, null, "1.1.0", "Tom da empresa B."), "ATIVA"));
    const rascunho = override(A, null, "1.3.0", "Tom ainda em rascunho.");
    const linhaRascunho = await id(inserir, valores(rascunho, "RASCUNHO"));

    // Garantias do banco.
    await recusa(db, inserir, valores(override(A, unidadeB, "1.4.0", "Unidade de outra empresa."), "RASCUNHO"), /ia_skills_058_estabelecimento_fk|foreign key/);
    const incoerente = override(A, null, "1.5.0", "Definição de outra empresa.");
    await recusa(db, inserir, [A, null, "EMPRESA", incoerente.id, incoerente.versao, incoerente.hash, "RASCUNHO", JSON.stringify({ ...incoerente, escopo: { empresaId: B, estabelecimentoId: null } }), autor], /ia_skills_058_definicao_check/);
    await recusa(db, inserir, [A, unidadeA, "EMPRESA", empresaV1.id, "1.6.0", empresaV1.hash, "RASCUNHO", JSON.stringify(empresaV1), autor], /ia_skills_058_escopo_check|ia_skills_058_definicao_check/);
    await recusa(db, inserir, valores(override(A, null, "1.7.0", "Segunda ATIVA."), "ATIVA"), /ia_skills_058_uma_ativa_uk|duplicate key/);
    await recusa(db, inserir, valores(empresaV1, "RASCUNHO"), /ia_skills_058_versao_uk|duplicate key/);
    await recusa(db, `UPDATE ia_skills SET definicao = definicao || '{"restricoes":[]}'::jsonb WHERE id = $1::uuid`, [linhaEmpresa], /imutável/);
    await recusa(db, `UPDATE ia_skills SET status = 'RASCUNHO' WHERE id = $1::uuid`, [linhaEmpresa], /transição de status/);
    await recusa(db, `DELETE FROM ia_skills WHERE id = $1::uuid`, [linhaEmpresa], /exclusão de skill recusada/);
    await recusa(db, `TRUNCATE ia_skills`, [], /TRUNCATE de ia_skills recusado/);

    // Leitura real (somente ATIVAS da empresa pedida) e resolução pelo catálogo real.
    const repositorio = criarRepositorioSkillsPostgres({ executor: () => db });
    const lidas = await repositorio.listar(A) as Skill[];
    assert.deepEqual(lidas.map((s) => `${s.nivel}:${s.versao}`).sort(), ["EMPRESA:1.1.0", "ESTABELECIMENTO:1.2.0"]);
    assert.ok(lidas.every((s) => s.escopo.empresaId === A), "nada da empresa B");
    const catalogo = criarCatalogoSkills({ plataforma: SKILLS_PLATAFORMA, repositorio });
    const naUnidade = (await catalogo.resolver({ empresaId: A, estabelecimentoId: unidadeA, finalidade: "SUGESTAO_TEXTO", capacidade: null }))!;
    assert.deepEqual(naUnidade.cadeia.map((c) => c.nivel), ["PLATAFORMA", "EMPRESA", "ESTABELECIMENTO"]);
    assert.equal(naUnidade.conteudo.tom, "Tom da unidade A.");
    const soPlataforma = (await catalogo.resolver({ empresaId: A, estabelecimentoId: unidadeA, finalidade: "SUGESTAO_TEXTO", capacidade: null, niveis: ["PLATAFORMA"] }))!;
    assert.deepEqual(soPlataforma.cadeia.map((c) => c.nivel), ["PLATAFORMA"], "Policy nega as camadas do banco");

    // Transições válidas: ativar o rascunho exige suspender/arquivar a atual antes (uma ATIVA).
    await db.query(`UPDATE ia_skills SET status = 'SUSPENSA' WHERE id = $1::uuid`, [linhaEmpresa]);
    await db.query(`UPDATE ia_skills SET status = 'ATIVA' WHERE id = $1::uuid`, [linhaRascunho]);
    await db.query(`UPDATE ia_skills SET status = 'ARQUIVADA' WHERE id = $1::uuid`, [linhaEmpresa]);
    await recusa(db, `UPDATE ia_skills SET status = 'ATIVA' WHERE id = $1::uuid`, [linhaEmpresa], /transição de status/);
    assert.equal(((await catalogo.resolver({ empresaId: A, estabelecimentoId: null, finalidade: "SUGESTAO_TEXTO", capacidade: null }))!).conteudo.tom, "Tom ainda em rascunho.");

    // Rollback com os scripts reais: com cadastro, exige descarte explícito.
    await db.query(PRE_DOWN);
    await recusa(db, semTransacaoExplicita(DOWN), [], /há skills cadastradas/);
    await db.query("SET LOCAL kidmais.rollback_058_descartar_skills = 'sim'");
    await db.query(semTransacaoExplicita(DOWN));
    await db.query(POS_DOWN);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    const sobrou = (await db.query<{ ok: boolean }>(`SELECT to_regclass('public.ia_skills') IS NOT NULL AS ok`)).rows[0].ok;
    await encerrarDescartavel(db);
    assert.equal(sobrou, false, "ROLLBACK desfez a 058 no descartável");
  }
});

// ---------------------------------------------------------------- A4 (auditoria): contrato da definição no banco

test("058 A4: definição incompleta, com tipo errado, array vazio ou valor fora do contrato é recusada pelo BANCO; a completa passa", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const db = await conectarDescartavel();
  const id = async (sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
  try {
    await db.query("BEGIN");
    await db.query(semTransacaoExplicita(UP));
    const A = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa A4', 'PROVISIONAMENTO') RETURNING id`, [cod("a4")]);
    const autor = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness A4', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
      [`${cod("u")}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
    const inserir = `INSERT INTO ia_skills (empresa_id, estabelecimento_id, nivel, skill_id, versao, hash, status, definicao, criado_por)
                     VALUES ($1::uuid, NULL, 'EMPRESA', 'atendimento_familias', '1.1.0', $2, 'RASCUNHO', $3::jsonb, $4::uuid)`;
    const valida = override(A, null, "1.1.0", "Tom A4.");
    const tentar = (definicao: unknown, hash = valida.hash) => recusa(db, inserir, [A, hash, JSON.stringify(definicao), autor], /ia_skills_058_definicao_(chaves|tipos|valores|limites)?_?check|ia_skills_058_definicao_check|ia_skills_058_conteudo_check/);

    await tentar({});
    for (const chave of ["id", "nivel", "escopo", "finalidades", "capacidades", "versao", "proveniencia", "revisao", "permissoes", "restricoes", "conteudo", "hash"]) {
      const semChave: Record<string, unknown> = { ...valida };
      delete semChave[chave];
      await tentar(semChave);
    }
    const variantes: Array<Record<string, unknown>> = [
      { finalidades: "SUGESTAO_TEXTO" }, { escopo: "empresa" }, { permissoes: { classes: "READ" } }, { restricoes: {} }, { conteudo: [] },
      { finalidades: [] }, { permissoes: { classes: [] } },
      { permissoes: { classes: ["CONFIRM"] } }, { finalidades: ["PAGAR"] },
      { revisao: { ...valida.revisao, estado: "OK" } }, { proveniencia: { origem: "X", autor: "a", referencia: "r" } },
      { proveniencia: { autor: "a", referencia: "r" } }, { revisao: { estado: "APROVADA" } }, { escopo: { empresaId: A } },
      { id: "outra_skill" }, { versao: "9.9.9" }, { escopo: { empresaId: "22222222-2222-4222-8222-222222222222", estabelecimentoId: null } },
    ];
    for (const v of variantes) await tentar({ ...valida, ...v });
    await tentar(valida, "f".repeat(64));

    // Controle: a definição completa e coerente passa.
    await db.query(inserir, [A, valida.hash, JSON.stringify(valida), autor]);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(db);
  }
});

test("058 A4 controle negativo: o CHECK original (sem COALESCE) aceitava {} — reprodução do achado", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const db = await conectarDescartavel();
  try {
    await db.query("BEGIN");
    await db.query(`CREATE TEMP TABLE a4_original (skill_id text, versao text, hash text, nivel text, empresa_id uuid, estabelecimento_id uuid, definicao jsonb,
      CHECK (definicao->>'id' = skill_id AND definicao->>'versao' = versao AND definicao->>'hash' = hash AND definicao->>'nivel' = nivel
             AND definicao->'escopo'->>'empresaId' = empresa_id::text
             AND (definicao->'escopo'->>'estabelecimentoId') IS NOT DISTINCT FROM estabelecimento_id::text))`);
    await db.query(`INSERT INTO a4_original VALUES ('atendimento_familias', '1.1.0', $1, 'EMPRESA', gen_random_uuid(), NULL, '{}'::jsonb)`, ["a".repeat(64)]);
    assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM a4_original`)).rows[0].n, 1, "o CHECK original deixava passar {} (NULL não falha)");
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(db);
  }
});

// ---------------------------------------------------------------- A4 (reauditoria): estrutura interna de `conteudo`

/** Casos derivados do conteudoSchema do runtime (lib/inteligencia/skills/contrato.ts). */
function casosConteudo(valido: Skill["conteudo"]): Array<[string, unknown]> {
  const sem = (chave: keyof Skill["conteudo"]) => { const c: Record<string, unknown> = { ...valido }; delete c[chave]; return c; };
  const procedimento = { titulo: "Contrato aguardando assinatura", passos: ["Reenviar o link."] };
  const objecao = { objecao: "Está caro", resposta: "Mostre o que está incluído." };
  const template = { id: "confirmacao", titulo: "Confirmar", texto: "Olá, {{nome_cliente}}!", marcadores: ["nome_cliente"] };
  return [
    ["conteudo {}", {}],
    ...(["tom", "instrucoes", "procedimentos", "objecoes", "templates", "formatacao"] as const).map((k): [string, unknown] => [`sem ${k}`, sem(k)]),
    ["chave extra", { ...valido, script: "x" }],
    ["tom número", { ...valido, tom: 1 }], ["tom vazio", { ...valido, tom: "  " }],
    ["instrucoes objeto", { ...valido, instrucoes: {} }], ["instrucao número", { ...valido, instrucoes: [1] }],
    ["procedimentos objeto", { ...valido, procedimentos: {} }], ["procedimento sem passos", { ...valido, procedimentos: [{ titulo: "x" }] }],
    ["procedimento passos vazio", { ...valido, procedimentos: [{ ...procedimento, passos: [] }] }], ["procedimento sem titulo", { ...valido, procedimentos: [{ passos: ["a"] }] }],
    ["procedimento passo número", { ...valido, procedimentos: [{ ...procedimento, passos: [1] }] }], ["procedimento chave extra", { ...valido, procedimentos: [{ ...procedimento, autoridade: true }] }],
    ["objecoes string", { ...valido, objecoes: "x" }], ["objecao sem resposta", { ...valido, objecoes: [{ objecao: "Está caro" }] }],
    ["objecao chave extra", { ...valido, objecoes: [{ ...objecao, desconto: 10 }] }],
    ["templates objeto", { ...valido, templates: {} }], ["template sem marcadores", { ...valido, templates: [{ id: "x1", titulo: "t", texto: "t" }] }],
    ["template marcador fora da lista", { ...valido, templates: [{ ...template, marcadores: ["senha_cliente"] }] }],
    ["template id inválido", { ...valido, templates: [{ ...template, id: "Confirmação!" }] }], ["template sem texto", { ...valido, templates: [{ ...template, texto: "" }] }],
    ["template chave extra", { ...valido, templates: [{ ...template, acao: "enviar" }] }],
    ["formatacao vazia", { ...valido, formatacao: {} }], ["formatacao sem usarListas", { ...valido, formatacao: { maxParagrafos: null } }],
    ["maxParagrafos 0", { ...valido, formatacao: { maxParagrafos: 0, usarListas: null } }], ["maxParagrafos 11", { ...valido, formatacao: { maxParagrafos: 11, usarListas: null } }],
    ["maxParagrafos 2.5", { ...valido, formatacao: { maxParagrafos: 2.5, usarListas: null } }], ["maxParagrafos texto", { ...valido, formatacao: { maxParagrafos: "3", usarListas: null } }],
    ["usarListas texto", { ...valido, formatacao: { maxParagrafos: null, usarListas: "sim" } }], ["formatacao chave extra", { ...valido, formatacao: { maxParagrafos: null, usarListas: null, cor: "x" } }],
  ];
}

test("058 A4 reauditoria: conteudo {} e cada campo interno ausente/errado são recusados pelo BANCO; conteúdo runtime completo passa", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const db = await conectarDescartavel();
  const id = async (sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
  try {
    await db.query("BEGIN");
    await db.query(semTransacaoExplicita(UP));
    const A = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa A4b', 'PROVISIONAMENTO') RETURNING id`, [cod("a4b")]);
    const autor = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness A4b', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
      [`${cod("u")}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
    const inserir = `INSERT INTO ia_skills (empresa_id, estabelecimento_id, nivel, skill_id, versao, hash, status, definicao, criado_por)
                     VALUES ($1::uuid, NULL, 'EMPRESA', 'atendimento_familias', '1.1.0', $2, 'RASCUNHO', $3::jsonb, $4::uuid)`;
    const base = override(A, null, "1.1.0", "Tom A4b.");
    const valido: Skill["conteudo"] = {
      ...base.conteudo,
      instrucoes: ["Use o nome do cliente."],
      procedimentos: [{ titulo: "Contrato aguardando assinatura", passos: ["Reenviar o link."] }],
      objecoes: [{ objecao: "Está caro", resposta: "Mostre o que está incluído." }],
      templates: [{ id: "confirmacao", titulo: "Confirmar", texto: "Olá, {{nome_cliente}}!", marcadores: ["nome_cliente"] }],
      formatacao: { maxParagrafos: 3, usarListas: true },
    };
    // Paridade com o runtime: o banco não é mais frouxo nem mais estrito que o conteudoSchema.
    assert.equal(conteudoSchema.safeParse(valido).success, true, "runtime aceita o válido");
    for (const [nome, conteudo] of casosConteudo(valido)) assert.equal(conteudoSchema.safeParse(conteudo).success, false, `runtime também recusa: ${nome}`);
    for (const [nome, conteudo] of casosConteudo(valido)) {
      await db.query("SAVEPOINT caso");
      await assert.rejects(db.query(inserir, [A, base.hash, JSON.stringify({ ...base, conteudo }), autor]), /ia_skills_058_conteudo_check/, nome);
      await db.query("ROLLBACK TO SAVEPOINT caso");
    }
    // Controle: conteúdo runtime completo (e o mínimo com listas vazias e nulos) passa.
    await db.query(inserir, [A, base.hash, JSON.stringify({ ...base, conteudo: valido }), autor]);
    await db.query(inserir.replace("'1.1.0'", "'1.1.1'"), [A, base.hash, JSON.stringify({ ...base, versao: "1.1.1", conteudo: base.conteudo }), autor]);
    // O conteúdo real das skills da plataforma (templates, objeções, procedimentos) também é aceito pelo banco.
    let v = 2;
    for (const s of SKILLS_PLATAFORMA) {
      const versao = `1.1.${v++}`;
      await db.query(inserir.replace("'1.1.0'", `'${versao}'`), [A, base.hash, JSON.stringify({ ...base, versao, conteudo: s.conteudo }), autor]);
    }
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(db);
  }
});

// ---------------------------------------------------------------- A4 (paridade): runtime aceita ⇔ banco aceita

type Mut = (d: Record<string, unknown> & { conteudo: Record<string, unknown> }) => void;
const x = (n: number) => "x".repeat(n);
const ch = (c: number) => String.fromCharCode(c);
const EMOJI = String.fromCodePoint(0x1f600); // 1 code point (zod conta code points), 2 unidades UTF-16
const lista = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));
const proc = (passos = 1, titulo = "Titulo") => ({ titulo, passos: lista(passos, (i) => `passo ${i}`) });
const tpl = (i: number, extra: Record<string, unknown> = {}) => ({ id: `t${i}`, titulo: "T", texto: "Texto", marcadores: ["nome_cliente"], ...extra });
const com = (base: unknown, extra: Record<string, unknown>) => ({ ...(base as Record<string, unknown>), ...extra });

/** Matriz de fronteira: cada caso muda a definição válida; a expectativa vem do RUNTIME (skillSchema), não de um palpite. */
const MATRIZ: Array<[string, Mut]> = [
  ["tom tab+LF", (d) => { d.conteudo.tom = "\t\n"; }], ["tom espacos", (d) => { d.conteudo.tom = "   "; }],
  ["tom NBSP", (d) => { d.conteudo.tom = ch(160) + ch(160); }], ["tom U+2028", (d) => { d.conteudo.tom = ch(0x2028); }],
  ["tom BOM", (d) => { d.conteudo.tom = ch(0xfeff); }], ["tom U+3000", (d) => { d.conteudo.tom = ch(0x3000); }],
  ["tom NEL (JS nao apara)", (d) => { d.conteudo.tom = ch(0x85); }],
  ["tom 400", (d) => { d.conteudo.tom = x(400); }], ["tom 401", (d) => { d.conteudo.tom = x(401); }],
  ["tom 400 com bordas", (d) => { d.conteudo.tom = `\t ${x(400)} \n`; }], ["tom null", (d) => { d.conteudo.tom = null; }],
  ["tom 400 emoji (400 code points)", (d) => { d.conteudo.tom = EMOJI.repeat(400); }], ["tom 401 emoji (401 code points)", (d) => { d.conteudo.tom = EMOJI.repeat(401); }],
  ["instrucoes 20", (d) => { d.conteudo.instrucoes = lista(20, (i) => `i${i}`); }], ["instrucoes 21", (d) => { d.conteudo.instrucoes = lista(21, (i) => `i${i}`); }],
  ["instrucao 300", (d) => { d.conteudo.instrucoes = [x(300)]; }], ["instrucao 301", (d) => { d.conteudo.instrucoes = [x(301)]; }],
  ["instrucao tab", (d) => { d.conteudo.instrucoes = ["\t"]; }],
  ["procedimentos 20", (d) => { d.conteudo.procedimentos = lista(20, () => proc()); }], ["procedimentos 21", (d) => { d.conteudo.procedimentos = lista(21, () => proc()); }],
  ["passos 15", (d) => { d.conteudo.procedimentos = [proc(15)]; }], ["passos 16", (d) => { d.conteudo.procedimentos = [proc(16)]; }],
  ["passos 0", (d) => { d.conteudo.procedimentos = [proc(0)]; }], ["passo 301", (d) => { d.conteudo.procedimentos = [{ titulo: "T", passos: [x(301)] }]; }],
  ["titulo proc 120", (d) => { d.conteudo.procedimentos = [proc(1, x(120))]; }], ["titulo proc 121", (d) => { d.conteudo.procedimentos = [proc(1, x(121))]; }],
  ["objecoes 20", (d) => { d.conteudo.objecoes = lista(20, (i) => ({ objecao: `o${i}`, resposta: "r" })); }],
  ["objecoes 21", (d) => { d.conteudo.objecoes = lista(21, (i) => ({ objecao: `o${i}`, resposta: "r" })); }],
  ["objecao 200", (d) => { d.conteudo.objecoes = [{ objecao: x(200), resposta: "r" }]; }], ["objecao 201", (d) => { d.conteudo.objecoes = [{ objecao: x(201), resposta: "r" }]; }],
  ["resposta 600", (d) => { d.conteudo.objecoes = [{ objecao: "o", resposta: x(600) }]; }], ["resposta 601", (d) => { d.conteudo.objecoes = [{ objecao: "o", resposta: x(601) }]; }],
  ["templates 20", (d) => { d.conteudo.templates = lista(20, (i) => tpl(i)); }], ["templates 21", (d) => { d.conteudo.templates = lista(21, (i) => tpl(i)); }],
  ["template texto 1200", (d) => { d.conteudo.templates = [tpl(0, { texto: x(1200) })]; }], ["template texto 1201", (d) => { d.conteudo.templates = [tpl(0, { texto: x(1201) })]; }],
  ["template titulo 121", (d) => { d.conteudo.templates = [tpl(0, { titulo: x(121) })]; }],
  ["marcadores 10", (d) => { d.conteudo.templates = [tpl(0, { marcadores: lista(10, () => "nome_cliente") })]; }],
  ["marcadores 11", (d) => { d.conteudo.templates = [tpl(0, { marcadores: lista(11, () => "nome_cliente") })]; }],
  ["template id 49", (d) => { d.conteudo.templates = [tpl(0, { id: `a${x(48)}` })]; }], ["template id 50", (d) => { d.conteudo.templates = [tpl(0, { id: `a${x(49)}` })]; }],
  ["maxParagrafos 1", (d) => { d.conteudo.formatacao = { maxParagrafos: 1, usarListas: null }; }], ["maxParagrafos 10", (d) => { d.conteudo.formatacao = { maxParagrafos: 10, usarListas: false }; }],
  ["maxParagrafos 0", (d) => { d.conteudo.formatacao = { maxParagrafos: 0, usarListas: null }; }], ["maxParagrafos 11", (d) => { d.conteudo.formatacao = { maxParagrafos: 11, usarListas: null }; }],
  ["maxParagrafos 2.5", (d) => { d.conteudo.formatacao = { maxParagrafos: 2.5, usarListas: null }; }],
  ["finalidades 6", (d) => { d.finalidades = ["TOM", "ATENDIMENTO", "SUGESTAO_TEXTO", "PROCEDIMENTO", "OBJECAO", "FORMATACAO"]; }],
  ["finalidades 7 (repetida)", (d) => { d.finalidades = ["TOM", "ATENDIMENTO", "SUGESTAO_TEXTO", "PROCEDIMENTO", "OBJECAO", "FORMATACAO", "TOM"]; }],
  ["capacidades 20", (d) => { d.capacidades = lista(20, (i) => `cap_${String.fromCharCode(97 + i)}`); }],
  ["capacidades 21", (d) => { d.capacidades = lista(21, (i) => `cap_${String.fromCharCode(97 + i)}`); }],
  ["capacidade maiuscula", (d) => { d.capacidades = ["Agenda"]; }], ["capacidade 65", (d) => { d.capacidades = [x(65)]; }],
  ["restricoes 20", (d) => { d.restricoes = lista(20, (i) => `r${i}`); }], ["restricoes 21", (d) => { d.restricoes = lista(21, (i) => `r${i}`); }],
  ["restricao 200", (d) => { d.restricoes = [x(200)]; }], ["restricao 201", (d) => { d.restricoes = [x(201)]; }],
  ["autor 120", (d) => { d.proveniencia = com(d.proveniencia, { autor: x(120) }); }], ["autor 121", (d) => { d.proveniencia = com(d.proveniencia, { autor: x(121) }); }],
  ["referencia so LF", (d) => { d.proveniencia = com(d.proveniencia, { referencia: "\n" }); }],
  ["revisor 121", (d) => { d.revisao = com(d.revisao, { revisor: x(121) }); }], ["revisor null", (d) => { d.revisao = com(d.revisao, { revisor: null }); }],
  ["revisadoEm fora do formato", (d) => { d.revisao = com(d.revisao, { revisadoEm: "2026-9-1" }); }],
  ["hashRevisado invalido", (d) => { d.revisao = com(d.revisao, { hashRevisado: "x" }); }],
  ["classes 2", (d) => { d.permissoes = { classes: ["READ", "SUGGEST"] }; }], ["classes 3", (d) => { d.permissoes = { classes: ["READ", "SUGGEST", "READ"] }; }],
  ["chave extra no topo", (d) => { d.extra = 1; }], ["chave extra no escopo", (d) => { d.escopo = com(d.escopo, { unidade: null }); }],
  ["chave extra em permissoes", (d) => { d.permissoes = { classes: ["READ"], acesso: "total" }; }],
  ["chave extra na proveniencia", (d) => { d.proveniencia = com(d.proveniencia, { url: "x" }); }],
];

const casosDaMatriz = (empresa: string) => MATRIZ.map(([nome, mutar], i) => {
  const versao = `2.0.${i + 1}`;
  const d = JSON.parse(JSON.stringify(override(empresa, null, versao, "Tom base."))) as Parameters<Mut>[0];
  mutar(d);
  return { nome, versao, d, runtime: skillSchema.safeParse(d).success };
});

test("058 A4 paridade: para cada caso de fronteira, runtime (skillSchema) aceita se e somente se o banco aceita", { timeout: 180_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const db = await conectarDescartavel();
  const id = async (sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
  const divergencias: string[] = [];
  let casos: ReturnType<typeof casosDaMatriz> = [];
  try {
    await db.query("BEGIN");
    await db.query(semTransacaoExplicita(UP));
    const A = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa paridade', 'PROVISIONAMENTO') RETURNING id`, [cod("par")]);
    const autor = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness paridade', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
      [`${cod("u")}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
    casos = casosDaMatriz(A);
    for (const c of casos) {
      await db.query("SAVEPOINT caso");
      let banco = true;
      try {
        await db.query(`INSERT INTO ia_skills (empresa_id, estabelecimento_id, nivel, skill_id, versao, hash, status, definicao, criado_por)
                        VALUES ($1::uuid, NULL, 'EMPRESA', 'atendimento_familias', $2, $3, 'RASCUNHO', $4::jsonb, $5::uuid)`, [A, c.versao, c.d.hash, JSON.stringify(c.d), autor]);
        await db.query("RELEASE SAVEPOINT caso");
      } catch (erro) {
        if ((erro as { code?: string }).code !== "23514") throw erro;
        banco = false;
        await db.query("ROLLBACK TO SAVEPOINT caso");
      }
      if (c.runtime !== banco) divergencias.push(`${c.nome}: runtime ${c.runtime ? "aceita" : "recusa"}, banco ${banco ? "aceita" : "recusa"}`);
    }
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(db);
  }
  assert.deepEqual(divergencias, [], `divergências runtime x banco:\n${divergencias.join("\n")}`);
  // A matriz não é trivial: os casos da reauditoria são recusados pelo runtime e as bordas válidas aceitas.
  const runtime = new Map(casos.map((c) => [c.nome, c.runtime]));
  for (const nome of ["tom tab+LF", "tom 401", "tom 401 emoji (401 code points)", "instrucoes 21", "procedimentos 21", "passos 16"]) assert.equal(runtime.get(nome), false, nome);
  for (const nome of ["tom 400", "tom 400 com bordas", "instrucoes 20", "procedimentos 20", "passos 15", "tom NEL (JS nao apara)", "tom 400 emoji (400 code points)"]) assert.equal(runtime.get(nome), true, nome);
});
