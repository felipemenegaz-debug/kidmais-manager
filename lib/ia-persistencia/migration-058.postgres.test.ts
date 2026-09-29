import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";
import { criarCatalogoSkills } from "../inteligencia/skills/catalogo.ts";
import type { Skill } from "../inteligencia/skills/contrato.ts";
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
