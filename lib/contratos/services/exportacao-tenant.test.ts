import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { DbExecutor } from "../../db/contracts.ts";
import { executarNoTenant, type SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { exportarContratoDoTenant, lerDocumentoDoTenant } from "./exportacao-tenant.ts";
import { ResumoTenantError } from "./resumo-tenant.ts";

/** A1/D1: exportações administrativas de contrato (PDF, Resumo, documento) só com Tenant Context. */
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const membershipA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", empresa_id: A };
const FECH_A = "f0000000-0000-4000-8000-00000000000a";
const FECH_B = "f0000000-0000-4000-8000-00000000000b";
const FECH_LEGADO = "f0000000-0000-4000-8000-00000000000c";
const INEXISTENTE = "f0000000-0000-4000-8000-00000000000d";
const DOC_A = "d0000000-0000-4000-8000-00000000000a";
const DOC_B = "d0000000-0000-4000-8000-00000000000b";
const DOC_LEGADO = "d0000000-0000-4000-8000-00000000000c";

/** Fechamento/documento → empresa do pacote. Legado: pacote sem empresa. */
const EMPRESA: Record<string, string | null> = { [FECH_A]: A, [FECH_B]: B, [FECH_LEGADO]: null, [DOC_A]: A, [DOC_B]: B, [DOC_LEGADO]: null };

function ambiente(opcoes: { membership?: boolean; empresaSuspensa?: boolean; papel?: string } = {}) {
  const consultas: string[] = [];
  const gerados: string[] = [];
  /** Ciclo da transação simulada: aberta durante a prova/aquisição; qualquer consulta depois do commit falha. */
  const estado = { aberta: false, commitada: false, revogadaDuranteLeitura: false, ordem: [] as string[] };
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      if (!estado.aberta) throw new Error(`consulta fora da transação do tenant: ${sql.slice(0, 60)}`);
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      const comMembership = (opcoes.membership ?? true) && !opcoes.empresaSuspensa;
      if (sql.includes("m.status AS membership")) return r(comMembership && !estado.revogadaDuranteLeitura && values[0] === membershipA.id ? [{ membership: "ATIVA" }] : []);
      if (sql.includes("SELECT DISTINCT m.empresa_id")) return r(opcoes.membership ?? true ? [{ id: A }] : []);
      if (sql.includes("FROM memberships m") && sql.includes("JOIN empresas")) return r(comMembership ? [{ ...membershipA, papel: opcoes.papel ?? "ADMINISTRATIVO" }] : []);
      if (sql.includes("SELECT status FROM empresas")) return r([{ status: opcoes.empresaSuspensa ? "SUSPENSA" : "ATIVA" }]);
      if (sql.includes("FROM empresas")) return r([{ id: values[0] }]);
      if (sql.includes("SELECT ativo")) return r([{ ativo: true }]);
      if (sql.includes("FROM usuarios_administrativos")) return r([{ id: values[0] }]);
      if (sql.includes("FROM contratos contrato") || sql.includes("FROM contrato_documentos doc")) {
        consultas.push(sql);
        // A empresa está NA consulta (escopo no servidor), não num filtro depois dela.
        assert.match(sql, /JOIN pacotes pac ON pac\.id = fech\.pacote_id AND pac\.empresa_id = \$2::uuid/);
        const empresa = EMPRESA[String(values[0])];
        return r(empresa !== undefined && empresa !== null && empresa === values[1] ? [{ id: `contrato-de-${values[0]}` }] : []);
      }
      if (sql.includes("FROM contrato_versoes")) return r([{ id: `versao-de-${values[0]}`, snapshot: { sensivel: true } }]);
      throw new Error(`consulta inesperada: ${sql.slice(0, 60)}`);
    },
  };
  const deps = {
    withTenantTransaction: async <T>(s: SessaoParaTenant, empresa: string | null | undefined, work: Parameters<typeof executarNoTenant<T>>[3]) => {
      estado.aberta = true;
      try {
        const r = await executarNoTenant(tx, s, empresa, work);
        estado.commitada = true;
        estado.ordem.push("commit");
        return r;
      } finally {
        estado.aberta = false;
      }
    },
    /** Aquisição: TODAS as consultas no tx da prova, antes do commit. */
    adquirir: async (fechamentoId: string, txAquisicao: DbExecutor) => {
      assert.equal(txAquisicao, tx, "aquisição na mesma transação da prova");
      assert.equal(estado.aberta, true);
      estado.ordem.push("adquirir");
      const versao = (await txAquisicao.query<{ id: string }>("SELECT * FROM contrato_versoes WHERE contrato_id=$1", [fechamentoId])).rows[0];
      return { fechamentoId, versao };
    },
    /** Renderização: depois do commit, só memória (qualquer consulta aqui lançaria). */
    renderizar: (dados: { fechamentoId: string; versao: { id: string } }) => {
      assert.equal(estado.commitada, true, "renderiza só depois do commit");
      assert.equal(estado.aberta, false, "transação não fica aberta durante a renderização");
      estado.ordem.push("renderizar");
      gerados.push(dados.fechamentoId);
      return { pdf: `pdf-${dados.fechamentoId}`, versao: dados.versao.id };
    },
    ler: async (documentoId: string, txLeitura: DbExecutor) => { assert.equal(txLeitura, tx, "leitura na mesma transação da prova"); gerados.push(documentoId); return { id: documentoId }; },
  };
  const sessao = { usuario_id: "aaaaaaaa-0000-4000-8000-000000000001", papel: "ADMINISTRATIVO" } as SessaoParaTenant;
  return { deps, gerados, consultas, sessao, estado, tx };
}

const recusa404 = (e: unknown) => e instanceof ResumoTenantError && e.httpStatus === 404;
const naoComprovado = (e: unknown) => (e as { code?: string }).code === "TENANT_NAO_COMPROVADO";

test("A1/D1: PDF/Resumo do fechamento da empresa comprovada: prova → aquisição (mesmo tx) → commit → renderização em memória", async () => {
  const a = ambiente();
  assert.deepEqual(await exportarContratoDoTenant(a.sessao, null, FECH_A, a.deps), { pdf: `pdf-${FECH_A}`, versao: `versao-de-${FECH_A}` });
  assert.deepEqual(a.gerados, [FECH_A]);
  assert.deepEqual(a.estado.ordem, ["adquirir", "commit", "renderizar"]);
});

test("D1: a renderização não pode consultar depois do commit (o tx fechado recusa qualquer consulta)", async () => {
  const a = ambiente();
  const deps = { ...a.deps, renderizar: () => a.tx.query("SELECT * FROM contrato_versoes WHERE contrato_id=$1", [FECH_A]) };
  await assert.rejects(exportarContratoDoTenant(a.sessao, null, FECH_A, deps), /consulta fora da transação do tenant/);
});

test("A1 cross-tenant: fechamento de outra empresa, legado ou inexistente ⇒ mesma recusa 404, nada adquirido nem renderizado", async () => {
  for (const id of [FECH_B, FECH_LEGADO, INEXISTENTE]) {
    const a = ambiente();
    await assert.rejects(exportarContratoDoTenant(a.sessao, null, id, a.deps), recusa404, id);
    assert.deepEqual(a.gerados, [], id);
    assert.deepEqual(a.estado.ordem, [], id);
  }
});

test("D1: membership revogada antes, empresa suspensa antes ou papel atual não administrativo ⇒ recusa sem consulta de contrato", async () => {
  for (const [opcoes, recusa] of [[{ membership: false }, naoComprovado], [{ empresaSuspensa: true }, naoComprovado], [{ papel: "VISITANTE" }, (e: unknown) => (e as { httpStatus?: number }).httpStatus === 403]] as const) {
    const a = ambiente(opcoes);
    await assert.rejects(exportarContratoDoTenant(a.sessao, null, FECH_A, a.deps), recusa, JSON.stringify(opcoes));
    assert.deepEqual(a.consultas, [], JSON.stringify(opcoes));
    assert.deepEqual(a.estado.ordem, [], JSON.stringify(opcoes));
  }
});

test("D1: revogação concorrente vista na revalidação (antes do commit) ⇒ recusa e nenhum PDF renderizado", async () => {
  const a = ambiente();
  const deps = { ...a.deps, adquirir: async (f: string, tx: DbExecutor) => { const d = await a.deps.adquirir(f, tx); a.estado.revogadaDuranteLeitura = true; return d; } };
  await assert.rejects(exportarContratoDoTenant(a.sessao, null, FECH_A, deps), naoComprovado);
  assert.deepEqual(a.gerados, []);
  assert.deepEqual(a.estado.ordem, ["adquirir"]);
});

test("A1 cross-tenant: documento/comprovante de outra empresa ou legado ⇒ 404 e nenhum byte lido", async () => {
  const a = ambiente();
  assert.deepEqual(await lerDocumentoDoTenant(a.sessao, null, DOC_A, a.deps), { id: DOC_A });
  for (const id of [DOC_B, DOC_LEGADO, INEXISTENTE]) {
    const b = ambiente();
    await assert.rejects(lerDocumentoDoTenant(b.sessao, null, id, b.deps), recusa404, id);
    assert.deepEqual(b.gerados, [], id);
  }
});

test("A1: empresa no pedido não prova nada; sem membership ativa nada é consultado (fail-closed)", async () => {
  const pedindoB = ambiente();
  await assert.rejects(exportarContratoDoTenant(pedindoB.sessao, B, FECH_B, pedindoB.deps), naoComprovado);
  await assert.rejects(lerDocumentoDoTenant(pedindoB.sessao, B, DOC_B, pedindoB.deps), naoComprovado);
  const semMembership = ambiente({ membership: false });
  await assert.rejects(exportarContratoDoTenant(semMembership.sessao, null, FECH_A, semMembership.deps), naoComprovado);
  for (const x of [pedindoB, semMembership]) {
    assert.deepEqual(x.gerados, []);
    assert.deepEqual(x.consultas, [], "nenhuma consulta de contrato antes da prova do tenant");
  }
});

test("A1/D1 rotas: /pdf e /resumo adquirem no tx da prova e renderizam depois; /documentos lê no tx da prova", () => {
  for (const [arquivo, chamada] of [
    ["app/api/admin/contratos/pdf/route.ts", /exportarContratoDoTenant\(sessao, request\.nextUrl\.searchParams\.get\("empresaId"\), parsed\.data, \{\s+withTenantTransaction,\s+adquirir: adquirirPdfContratoAdmin,\s+renderizar: renderizarPdfContratoAdmin,/],
    ["app/api/admin/contratos/resumo/route.ts", /exportarContratoDoTenant\(sessao, request\.nextUrl\.searchParams\.get\("empresaId"\), parsed\.data, \{\s+withTenantTransaction,\s+adquirir: adquirirResumoContratoAdmin,\s+renderizar: renderizarResumoContratoAdmin,/],
    ["app/api/admin/contratos/documentos/[documentoId]/route.ts", /lerDocumentoDoTenant\(sessao, request\.nextUrl\.searchParams\.get\('empresaId'\), id, \{ withTenantTransaction, ler: lerDocumento \}\)/],
  ] as const) {
    const rota = readFileSync(arquivo, "utf8");
    assert.match(rota, /const sessao = await exigirApiAdminCrmDisponivel\(request\)/, arquivo);
    assert.match(rota, chamada, arquivo);
    assert.doesNotMatch(rota, /gerar(Pdf|Resumo)ContratoAdmin|await lerDocumento\(|db\(\)/, `${arquivo}: nenhum caminho sem Tenant Context`);
    assert.doesNotMatch(rota, /export async function (POST|PUT|PATCH|DELETE)/, arquivo);
  }
});

test("D1 serviço: aquisição do PDF/Resumo usa o tx em TODAS as consultas; a renderização não consulta", () => {
  const fonte = readFileSync("lib/contratos/services/contrato-publico.service.ts", "utf8").replace(/\r\n/g, "\n");
  const corpo = (nome: string) => {
    const ini = fonte.indexOf(nome);
    assert.ok(ini >= 0, nome);
    return fonte.slice(ini, fonte.indexOf("\n}\n", ini));
  };
  const base = corpo("async function contratoComVersaoDoFechamento(");
  assert.match(base, /buscarContratoPorFechamentoId\(fechamentoId, tx\)/);
  assert.match(base, /buscarVersaoCorrente\(contrato\.id, tx\)/);
  assert.match(corpo("export async function adquirirPdfContratoAdmin("), /adquirirDocumentoParaLeitura\(versao, tx\)/);
  for (const nome of ["export function renderizarPdfContratoAdmin(", "export function renderizarResumoContratoAdmin("]) {
    assert.doesNotMatch(corpo(nome), /\bawait\b|\btx\b|db\(\)|query\(/, `${nome}: só memória`);
  }
  assert.doesNotMatch(fonte, /export async function gerar(Pdf|Resumo)ContratoAdmin\(/, "nenhuma variante que consulta fora do tx");
  const fluxo = readFileSync("lib/contratos/services/fluxo-publico.ts", "utf8").replace(/\r\n/g, "\n");
  const materializar = fluxo.slice(fluxo.indexOf("export function materializarDocumento("), fluxo.indexOf("\n}\n", fluxo.indexOf("export function materializarDocumento(")));
  assert.doesNotMatch(materializar, /\bawait\b|\btx\b|db\(\)|query\(/, "materializarDocumento: só memória");
});
