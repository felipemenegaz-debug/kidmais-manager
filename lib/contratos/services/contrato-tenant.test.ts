import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { DbExecutor } from "../../db/contracts.ts";
import { executarNoTenant, type SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { contratoNoTenant, executarComPosseNoTenant, fechamentoNoTenant, listarContratosDoTenant, type ProvaDePosse } from "./contrato-tenant.ts";
import { ResumoTenantError } from "./resumo-tenant.ts";

/** B2: rotas administrativas de contrato (painel, detalhe, financeiro, contrato por fechamento). */
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const membershipA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", empresa_id: A };
const DE_A = "c0000000-0000-4000-8000-00000000000a";
const DE_B = "c0000000-0000-4000-8000-00000000000b";
const LEGADO = "c0000000-0000-4000-8000-00000000000c";
const INEXISTENTE = "c0000000-0000-4000-8000-00000000000d";
/** Recurso → empresa do fechamento/pacote. Legado: sem empresa. */
const EMPRESA: Record<string, string | null> = { [DE_A]: A, [DE_B]: B, [LEGADO]: null };
const LINHAS = [{ id: DE_A, empresa: A }, { id: DE_B, empresa: B }];

function ambiente(opcoes: { membership?: boolean; empresaSuspensa?: boolean; papel?: string } = {}) {
  const posse: Array<{ sql: string; values: readonly unknown[] }> = [];
  /** `revogadaDuranteLeitura`: a revogação concorrente que a revalidação (antes do commit) enxerga. */
  const estado = { revogadaDuranteLeitura: false };
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      const comMembership = (opcoes.membership ?? true) && !opcoes.empresaSuspensa;
      if (sql.includes("m.status AS membership")) return r(comMembership && !estado.revogadaDuranteLeitura && values[0] === membershipA.id ? [{ membership: "ATIVA" }] : []);
      if (sql.includes("SELECT DISTINCT m.empresa_id")) return r(opcoes.membership ?? true ? [{ id: A }] : []);
      if (sql.includes("FROM memberships m") && sql.includes("JOIN empresas")) return r(comMembership ? [{ ...membershipA, papel: opcoes.papel ?? "ADMINISTRATIVO" }] : []);
      if (sql.includes("SELECT status FROM empresas")) return r([{ status: opcoes.empresaSuspensa ? "SUSPENSA" : "ATIVA" }]);
      if (sql.includes("FROM empresas")) return r([{ id: values[0] }]);
      if (sql.includes("SELECT ativo")) return r([{ ativo: true }]);
      if (sql.includes("FROM usuarios_administrativos")) return r([{ id: values[0] }]);
      if (sql.includes("FROM contratos c\n")) {
        posse.push({ sql, values });
        // Lista: a empresa está no JOIN (servidor), nunca filtrada depois.
        assert.match(sql, /JOIN fechamentos fech ON fech\.id = c\.fechamento_id AND fech\.empresa_id = \$2::uuid/);
        assert.match(sql, /JOIN pacotes pac ON pac\.id = fech\.pacote_id AND pac\.empresa_id = \$2::uuid/);
        return r(LINHAS.filter((l) => l.empresa === values[1]).map((l) => ({ id: l.id })));
      }
      if (sql.includes("FROM contratos contrato") || sql.includes("FROM fechamentos fech")) {
        posse.push({ sql, values });
        // Posse: empresa do fechamento E do pacote na própria consulta.
        assert.match(sql, /fech\.empresa_id = \$2::uuid/);
        assert.match(sql, /JOIN pacotes pac ON pac\.id = fech\.pacote_id AND pac\.empresa_id = \$2::uuid/);
        const empresa = EMPRESA[String(values[0])];
        return r(empresa !== undefined && empresa !== null && empresa === values[1] ? [{ id: values[0] }] : []);
      }
      throw new Error(`consulta inesperada: ${sql.slice(0, 60)}`);
    },
  };
  const deps = { withTenantTransaction: <T>(s: SessaoParaTenant, empresa: string | null | undefined, work: Parameters<typeof executarNoTenant<T>>[3]) => executarNoTenant(tx, s, empresa, work) };
  const sessao = { usuario_id: "aaaaaaaa-0000-4000-8000-000000000001", papel: "ADMINISTRATIVO" } as SessaoParaTenant;
  return { deps, posse, sessao, tx, estado };
}

/** Prova de posse + trabalho na mesma transação; o trabalho devolve a empresa comprovada e o tx recebido. */
const provar = (a: ReturnType<typeof ambiente>, empresa: string | null, id: string, prova: ProvaDePosse) =>
  executarComPosseNoTenant(a.sessao, empresa, id, prova, a.deps, async (tx, t) => ({ empresa: t.empresaComprovada, mesmoTx: tx === a.tx }));

const recusa404 = (e: unknown) => e instanceof ResumoTenantError && e.httpStatus === 404 && e.message === "Contrato não encontrado.";
const naoComprovado = (e: unknown) => (e as { code?: string }).code === "TENANT_NAO_COMPROVADO";

test("B2: contrato e fechamento da empresa comprovada passam; outra empresa, legado e inexistente ⇒ o mesmo 404", async () => {
  for (const prova of [contratoNoTenant, fechamentoNoTenant]) {
    const a = ambiente();
    assert.deepEqual(await provar(a, null, DE_A, prova), { empresa: A, mesmoTx: true });
    for (const id of [DE_B, LEGADO, INEXISTENTE]) await assert.rejects(provar(a, null, id, prova), recusa404, id);
  }
});

test("B2/D1: empresa pedida sem membership, membership revogada antes e empresa suspensa antes ⇒ 403 sem nenhuma consulta de posse", async () => {
  for (const [opcoes, empresa] of [[{}, B], [{ membership: false }, null], [{ empresaSuspensa: true }, null]] as const) {
    const a = ambiente(opcoes);
    await assert.rejects(provar(a, empresa, DE_A, contratoNoTenant), naoComprovado);
    assert.equal(a.posse.length, 0);
  }
});

test("D1: papel atual fora dos administrativos ⇒ 403 antes da posse e sem leitura", async () => {
  const a = ambiente({ papel: "VISITANTE" });
  let leu = false;
  await assert.rejects(executarComPosseNoTenant(a.sessao, null, DE_A, contratoNoTenant, a.deps, async () => { leu = true; }), (e: unknown) => (e as { httpStatus?: number }).httpStatus === 403);
  assert.equal(leu, false);
  assert.equal(a.posse.length, 0);
});

test("D1: revogação observada pela revalidação ANTES do commit descarta os dados já lidos (nada sai da transação)", async () => {
  const a = ambiente();
  await assert.rejects(executarComPosseNoTenant(a.sessao, null, DE_A, contratoNoTenant, a.deps, async () => {
    a.estado.revogadaDuranteLeitura = true;
    return { dadoSensivel: "snapshot" };
  }), naoComprovado);
});

test("B2: lista do painel já vem filtrada pela empresa comprovada no SQL", async () => {
  const a = ambiente();
  const linhas = await a.deps.withTenantTransaction(a.sessao, null, (tx, t) => listarContratosDoTenant(tx, t.empresaComprovada, false));
  assert.deepEqual(linhas.map((l) => l.id), [DE_A]);
  assert.deepEqual(a.posse.at(-1)!.values, [false, A]);
});

test("B2 rotas: painel, detalhe, financeiro (GET/POST/comprovantes) e contrato por fechamento provam o tenant antes do serviço", () => {
  const painel = readFileSync("app/api/admin/contratos/painel/route.ts", "utf8");
  // D1: detalhe lido com o tx da prova (nenhuma leitura depois do commit).
  assert.match(painel, /data = await executarComPosseNoTenant\(sessao, empresaSolicitada, id, contratoNoTenant, \{ withTenantTransaction \}, \(tx\) => detalheAdministrativo\(id, tx\)\);/);
  assert.doesNotMatch(painel, /exigirPosseNoTenant|detalheAdministrativo\(id\)/);
  assert.match(painel, /withTenantTransaction\(sessao, empresaSolicitada, \(tx, tenant\) => listarContratosDoTenant\(tx, tenant\.empresaComprovada/);
  assert.doesNotMatch(painel, /db\(\)/, "sem consulta global no painel");

  const fin = readFileSync("app/api/admin/contratos/[contratoId]/financeiro/[[...acao]]/route.ts", "utf8");
  const get = fin.slice(fin.indexOf("export async function GET"), fin.indexOf("export async function POST"));
  const post = fin.slice(fin.indexOf("export async function POST"));
  // C2: prova e leitura/escrita na MESMA transação (noTenant → executarComPosseNoTenant, executor).
  assert.match(fin, /executarComPosseNoTenant\(sessao,request\.nextUrl\.searchParams\.get\('empresaId'\),id,contratoNoTenant,\{withTenantTransaction\},trabalho\)/);
  assert.ok(get.indexOf("return await noTenant(request,sessao,id,async tx=>{") < get.indexOf("pagamento_devolucao_comprovantes"), "GET: comprovante lido dentro da transação da prova");
  assert.match(get, /noTenant\(request,sessao,id,async \(tx,tenant\)=>\(\{painel:await consultarPainelFinanceiro\(id,tx\),papel:tenant\.papelAtual\}\)/);
  assert.ok(post.indexOf("return await noTenant(request,sessao,id,async (tx,tenant)=>{") >= 0 && post.indexOf("return await noTenant(request,sessao,id,async (tx,tenant)=>{") < post.indexOf("anexarComprovanteDevolucao("), "POST: ações dentro da transação da prova");
  assert.match(post, /executor:tx,papelNoTenant:tenant\.papelAtual\}/,"056: papel da membership comprovada vai para o serviço financeiro");
  assert.doesNotMatch(fin, /\bdb\(\)|withTransaction\(/, "nenhuma leitura/escrita fora da transação do tenant");

  const contratos = readFileSync("app/api/admin/contratos/route.ts", "utf8");
  const getC = contratos.slice(contratos.indexOf("export async function GET"), contratos.indexOf("export async function POST"));
  const postC = contratos.slice(contratos.indexOf("export async function POST"));
  assert.ok(getC.indexOf("fechamentoNoTenant") > 0 && getC.indexOf("fechamentoNoTenant") < getC.indexOf("obterContratoPorFechamento("));
  assert.match(getC, /executarComPosseNoTenant\(sessao, request\.nextUrl\.searchParams\.get\("empresaId"\), parsed\.data, fechamentoNoTenant, \{ withTenantTransaction \}, \(tx\) => obterContratoPorFechamento\(parsed\.data, tx\)\)/, "D1: contrato lido no tx da prova");
  assert.doesNotMatch(contratos, /exigirPosseNoTenant/);
  assert.ok(postC.indexOf("fechamentoNoTenant") > 0 && postC.indexOf("fechamentoNoTenant") < postC.indexOf("gerarContrato("));
  assert.match(postC, /executarComPosseNoTenant\([\s\S]*gerarContrato\(parsed\.data, \{[\s\S]*executor: tx,/, "C2: geração do contrato na transação da prova");
});

test("B2 auditoria: /versoes/[id] (POST) e /versoes/[id]/edicao já provavam o tenant (contratoDoTenant / versaoDoTenant)", () => {
  const operar = readFileSync("lib/contratos/services/administrativo.service.ts", "utf8");
  assert.match(operar, /const \{ contrato: c, empresaAutorizada, tenant \} = await contratoDoTenant\(tx, s, versaoId, empresaSolicitada\);/);
  // 056: assinar exige representante NESTA empresa; cancelar exige FESTA_CORRIGIR da membership comprovada.
  assert.match(operar, /if \(tenant\.papelAtual !== 'REPRESENTANTE_AUTORIZADO'\)\s+throw authError\('Somente representante autorizado pode assinar\.', 403\);/);
  // 057: assinar pela empresa = Gestão NESTA empresa + capability CONTRATO_ASSINAR_EMPRESA da membership comprovada;
  // nunca o papel global (reservado à plataforma).
  assert.match(operar, /throw authError\('Somente representante autorizado pode assinar\.', 403\);[\s\S]{0,500}FROM empresa_membership_capacidades WHERE membership_id=\$1::uuid AND empresa_id=\$2::uuid AND capacidade='CONTRATO_ASSINAR_EMPRESA' AND revogado_em IS NULL",\s*\[tenant\.membershipId, tenant\.empresaComprovada\]\);\s*if \(!podeAssinar\.rows\.length\)\s*throw authError\('Esta conta não tem permissão para assinar contratos por esta empresa\.', 403\);/);
  assert.doesNotMatch(operar, /temAutoridadeDePlataforma|autenticacao\/plataforma/, "assinatura empresarial não depende de autoridade de plataforma");
  assert.match(operar, /FROM festa_membership_capacidades WHERE membership_id=\$1 AND empresa_id=\$2 AND capacidade='FESTA_CORRIGIR'/);
  assert.doesNotMatch(operar, /festa_usuario_capacidades|s\.papel !==/);
  assert.match(readFileSync("app/api/admin/contratos/versoes/[versaoId]/route.ts", "utf8"), /operarContrato\(id, parsed\.data, tokenAdmin\(request\), .*searchParams\.get\('empresaId'\)\)/);
  assert.match(readFileSync("app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts", "utf8"), /await versaoDoTenant\(tx, versaoId, tenant\.empresaComprovada\)/);
});

test("D1 serviços: detalhe do painel e contrato por fechamento consultam só pelo tx recebido", () => {
  const corpo = (arquivo: string, nome: string) => {
    const fonte = readFileSync(arquivo, "utf8").replace(/\r\n/g, "\n");
    const ini = fonte.indexOf(nome);
    assert.ok(ini >= 0, nome);
    return fonte.slice(ini, fonte.indexOf("\n}\n", ini));
  };
  const detalhe = corpo("lib/contratos/services/administrativo.service.ts", "export async function detalheAdministrativo(contratoId: string, tx: DbExecutor = db())");
  assert.doesNotMatch(detalhe, /db\(\)\.query/);
  assert.equal(detalhe.match(/tx\.query/g)?.length, 8);
  const obter = corpo("lib/contratos/services/contrato.service.ts", "export async function obterContratoPorFechamento(fechamentoId: string, tx?: DbExecutor)");
  assert.match(obter, /buscarContratoPorFechamentoId\(fechamentoId, tx\)/);
  assert.match(obter, /buscarVersaoCorrente\(contrato\.id, tx\)/);
});
