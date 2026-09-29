import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { DbExecutor } from "../../db/contracts.ts";
import { executarNoTenant, type SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { ResumoTenantError, resumoContratacaoDoTenant } from "./resumo-tenant.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const membershipA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", empresa_id: A };
const CONTRATO_A = "c0000000-0000-4000-8000-00000000000a";
const CONTRATO_B = "c0000000-0000-4000-8000-00000000000b";
const CONTRATO_LEGADO = "c0000000-0000-4000-8000-00000000000c";
const INEXISTENTE = "c0000000-0000-4000-8000-00000000000d";

/** Contrato → empresa do pacote. Legado: pacote sem empresa. */
const EMPRESA_DO_CONTRATO: Record<string, string | null> = { [CONTRATO_A]: A, [CONTRATO_B]: B, [CONTRATO_LEGADO]: null };

function ambiente(opcoes: { membership?: boolean; empresaSuspensa?: boolean; papel?: string } = {}) {
  const lidos: string[] = [];
  const estado = { aberta: false, revogadaDuranteLeitura: false };
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      if (!estado.aberta) throw new Error("consulta fora da transação do tenant");
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      const comMembership = (opcoes.membership ?? true) && !opcoes.empresaSuspensa;
      if (sql.includes("m.status AS membership")) return r(comMembership && !estado.revogadaDuranteLeitura && values[0] === membershipA.id ? [{ membership: "ATIVA" }] : []);
      if (sql.includes("SELECT DISTINCT m.empresa_id")) return r(opcoes.membership ?? true ? [{ id: A }] : []);
      if (sql.includes("FROM memberships m") && sql.includes("JOIN empresas")) return r(comMembership ? [{ ...membershipA, papel: opcoes.papel ?? "ADMINISTRATIVO" }] : []);
      if (sql.includes("SELECT status FROM empresas")) return r([{ status: opcoes.empresaSuspensa ? "SUSPENSA" : "ATIVA" }]);
      if (sql.includes("FROM empresas")) return r([{ id: values[0] }]);
      if (sql.includes("SELECT ativo")) return r([{ ativo: true }]);
      if (sql.includes("FROM usuarios_administrativos")) return r([{ id: values[0] }]);
      if (sql.includes("FROM contratos contrato")) {
        assert.match(sql, /JOIN pacotes pac ON pac\.id = fech\.pacote_id AND pac\.empresa_id = \$2::uuid/);
        const empresa = EMPRESA_DO_CONTRATO[String(values[0])];
        return r(empresa !== undefined && empresa !== null && empresa === values[1] ? [{ id: values[0] }] : []);
      }
      throw new Error(`consulta inesperada: ${sql.slice(0, 60)}`);
    },
  };
  const deps = {
    withTenantTransaction: async <T>(s: SessaoParaTenant, empresa: string | null | undefined, work: Parameters<typeof executarNoTenant<T>>[3]) => {
      estado.aberta = true;
      try { return await executarNoTenant(tx, s, empresa, work); } finally { estado.aberta = false; }
    },
    // D1: painel e financeiro recebem o tx da prova e só leem com ele aberto.
    painel: async (id: string, txLeitura: DbExecutor) => { assert.equal(txLeitura, tx); assert.equal(estado.aberta, true); lidos.push(`painel:${id}`); return { contrato: { id }, financeiro: [{ id: "p1" }] }; },
    financeiro: async (id: string, txLeitura: DbExecutor) => { assert.equal(txLeitura, tx); assert.equal(estado.aberta, true); lidos.push(`financeiro:${id}`); return { contrato: { id } }; },
  };
  const sessao = { usuario_id: "aaaaaaaa-0000-4000-8000-000000000001", papel: "ADMINISTRATIVO" } as SessaoParaTenant;
  return { deps, lidos, sessao, estado };
}

test("A/A: contrato da empresa comprovada devolve painel e financeiro", async () => {
  const a = ambiente();
  const r = await resumoContratacaoDoTenant(a.sessao, null, CONTRATO_A, a.deps);
  assert.deepEqual(r.painel.contrato, { id: CONTRATO_A });
  assert.deepEqual(a.lidos, [`painel:${CONTRATO_A}`, `financeiro:${CONTRATO_A}`]);
});

test("A/B, legado e inexistente: mesma recusa 404 e nenhuma leitura de painel/financeiro", async () => {
  for (const id of [CONTRATO_B, CONTRATO_LEGADO, INEXISTENTE]) {
    const a = ambiente();
    await assert.rejects(resumoContratacaoDoTenant(a.sessao, null, id, a.deps), (e: unknown) => e instanceof ResumoTenantError && e.httpStatus === 404 && e.message === "Contrato não encontrado.");
    assert.deepEqual(a.lidos, [], id);
  }
});

test("empresa alvo no pedido não prova nada: pedir a empresa B sem membership é recusado pelo Tenant Context", async () => {
  const a = ambiente();
  await assert.rejects(resumoContratacaoDoTenant(a.sessao, B, CONTRATO_B, a.deps));
  assert.deepEqual(a.lidos, []);
});

test("D1: membership revogada antes, empresa suspensa antes e papel não administrativo ⇒ recusa sem leitura", async () => {
  const naoComprovado = (e: unknown) => (e as { code?: string }).code === "TENANT_NAO_COMPROVADO";
  const papelRecusado = (e: unknown) => (e as { httpStatus?: number; code?: string }).httpStatus === 403 && (e as { code?: string }).code === "PAPEL_NAO_AUTORIZADO";
  for (const [opcoes, recusa] of [[{ membership: false }, naoComprovado], [{ empresaSuspensa: true }, naoComprovado], [{ papel: "VISITANTE" }, papelRecusado]] as const) {
    const a = ambiente(opcoes);
    await assert.rejects(resumoContratacaoDoTenant(a.sessao, null, CONTRATO_A, a.deps), recusa, JSON.stringify(opcoes));
    assert.deepEqual(a.lidos, [], JSON.stringify(opcoes));
  }
});

test("D1: revogação concorrente vista na revalidação antes do commit ⇒ os dados lidos não saem", async () => {
  const a = ambiente();
  const deps = { ...a.deps, financeiro: async (id: string, tx: DbExecutor) => { const f = await a.deps.financeiro(id, tx); a.estado.revogadaDuranteLeitura = true; return f; } };
  await assert.rejects(resumoContratacaoDoTenant(a.sessao, null, CONTRATO_A, deps), (e: unknown) => (e as { code?: string }).code === "TENANT_NAO_COMPROVADO");
});

test("rota e tela: o Resumo (e o PDF) só leem pela rota com Tenant Context, nunca por /painel", () => {
  const rota = readFileSync("app/api/admin/contratos/resumo-contratacao/route.ts", "utf8");
  assert.match(rota, /exigirApiAdminCrmDisponivel\(request\)/);
  assert.match(rota, /withTenantTransaction,/);
  assert.match(rota, /painel: detalheAdministrativo,\s+financeiro: consultarPainelFinanceiro,/);
  assert.match(rota, /searchParams\.get\("empresaId"\)/);
  assert.doesNotMatch(rota, /export async function (POST|PUT|PATCH|DELETE)/);
  const tela = readFileSync("components/admin/ResumoContratacao.tsx", "utf8");
  const apoio = readFileSync("components/admin/resumo-contratacao.ts", "utf8");
  assert.doesNotMatch(tela + apoio, /contratos\/painel/);
  assert.match(apoio, /\/api\/admin\/contratos\/resumo-contratacao/);
});
