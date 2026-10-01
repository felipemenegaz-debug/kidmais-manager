import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { provarEstabelecimento } from "./provar-estabelecimento.ts";
import type { TenantComprovado } from "./provar-tenant.ts";

/**
 * Establishment Context no PostgreSQL descartável (só pelo `check:v1:postgres`, com opt-in). Uma transação com ROLLBACK.
 *
 * 1. Com os gatilhos REAIS da 043: unidade ATIVA não pode ser criada (o caminho operacional está fechado — D03) ⇒ hoje
 *    nenhuma unidade é comprovável e a IA fica no escopo da empresa, fail-closed.
 * 2. Simulando o caminho aberto (gatilhos da 043 desligados SÓ nesta transação descartável): a prova aceita apenas a
 *    unidade ATIVA da empresa comprovada com vínculo ATIVO e vigente da membership; outra unidade da mesma empresa,
 *    unidade suspensa, vínculo revogado/vencido e unidade de outra empresa respondem o mesmo "Unidade não encontrada".
 */
const cod = (p: string) => `${p}${randomBytes(4).toString("hex")}`;

test("Establishment Context (PostgreSQL): só a unidade ATIVA da empresa com vínculo ATIVO e vigente é comprovada", { timeout: 120_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const db = await conectarDescartavel();
  const id = async (sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
  try {
    await db.query("BEGIN");
    const empresa = async (nome: string) => {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("est"), nome]);
      await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      return e;
    };
    const A = await empresa("Empresa unidades A");
    const B = await empresa("Empresa unidades B");
    const usuario = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness unidade', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
      [`${cod("u")}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
    const membershipA = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [A, usuario]);
    const membershipB = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [B, usuario]);

    // 1. Gatilhos reais: unidade não nasce ATIVA; vínculo não nasce ATIVO.
    await db.query("SAVEPOINT real");
    await assert.rejects(db.query(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, 'Real', 'ATIVO')`, [A, cod("r")]), /estabelecimento novo começa suspenso|ATIVO/);
    await db.query("ROLLBACK TO SAVEPOINT real");
    const suspensa = await id(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, 'Suspensa', 'SUSPENSO') RETURNING id`, [A, cod("s")]);
    await db.query(`INSERT INTO membership_estabelecimentos (empresa_id, estabelecimento_id, membership_id, status, vigente_desde) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUSPENSA', clock_timestamp())`, [A, suspensa, membershipA]);
    const tenantA: TenantComprovado = { empresaComprovada: A, membershipId: membershipA, usuarioId: usuario, papelAtual: "REPRESENTANTE_AUTORIZADO" };
    await assert.rejects(provarEstabelecimento(db, tenantA, suspensa), /Unidade não encontrada/);

    // 2. Caminho aberto simulado (só nesta transação descartável).
    await db.query("ALTER TABLE estabelecimentos DISABLE TRIGGER USER");
    await db.query("ALTER TABLE membership_estabelecimentos DISABLE TRIGGER USER");
    const unidade = (empresaId: string, status: string) => id(
      `INSERT INTO estabelecimentos (empresa_id, codigo, nome, status, desativado_em) VALUES ($1::uuid, $2, 'Unidade', $3, CASE WHEN $3 = 'DESATIVADO' THEN now() END) RETURNING id`, [empresaId, cod("u"), status]);
    const vinculo = (empresaId: string, estab: string, membership: string, status: string, ate: string | null = null) => db.query(
      `INSERT INTO membership_estabelecimentos (empresa_id, estabelecimento_id, membership_id, status, vigente_desde, vigente_ate, revogado_em)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now() - interval '1 day', $5::timestamptz, CASE WHEN $4 = 'REVOGADA' THEN now() END)`, [empresaId, estab, membership, status, ate]);

    const centro = await unidade(A, "ATIVO");
    await vinculo(A, centro, membershipA, "ATIVA");
    const semVinculo = await unidade(A, "ATIVO");
    const revogada = await unidade(A, "ATIVO");
    await vinculo(A, revogada, membershipA, "REVOGADA");
    const vencida = await unidade(A, "ATIVO");
    await vinculo(A, vencida, membershipA, "ATIVA", new Date(Date.now() - 3_600_000).toISOString());
    const desativada = await unidade(A, "DESATIVADO");
    await vinculo(A, desativada, membershipA, "ATIVA");
    const deB = await unidade(B, "ATIVO");
    await vinculo(B, deB, membershipB, "ATIVA");

    assert.deepEqual(await provarEstabelecimento(db, tenantA, centro), { estabelecimentoId: centro, empresaId: A, membershipId: membershipA });
    for (const [nome, alvo] of [["outra unidade da mesma empresa sem vínculo", semVinculo], ["vínculo revogado", revogada], ["vínculo vencido", vencida], ["unidade desativada", desativada], ["unidade de outra empresa", deB], ["id inexistente", "99999999-9999-4999-8999-999999999999"], ["id malformado", "not-a-uuid"]] as const) {
      await db.query("SAVEPOINT tentativa");
      await assert.rejects(provarEstabelecimento(db, tenantA, alvo), (e: Error & { httpStatus?: number }) => e.httpStatus === 404 && e.message === "Unidade não encontrada.", nome);
      await db.query("ROLLBACK TO SAVEPOINT tentativa");
    }
    // A membership de B não comprova a unidade de A, mesmo sendo o mesmo usuário.
    const tenantB: TenantComprovado = { empresaComprovada: B, membershipId: membershipB, usuarioId: usuario, papelAtual: "REPRESENTANTE_AUTORIZADO" };
    await assert.rejects(provarEstabelecimento(db, tenantB, centro), /Unidade não encontrada/);
    assert.equal((await provarEstabelecimento(db, tenantB, deB)).empresaId, B);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    const gatilhos = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_trigger WHERE tgrelid = 'estabelecimentos'::regclass AND NOT tgisinternal AND tgenabled = 'D'`)).rows[0].n;
    await encerrarDescartavel(db);
    assert.equal(gatilhos, "0", "ROLLBACK religou os gatilhos da 043");
  }
});
