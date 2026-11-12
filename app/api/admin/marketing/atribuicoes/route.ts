import type { NextRequest } from "next/server";
import { exigirApiAdminCrmDisponivel } from "@/lib/http/admin-crm-api";
import { MarketingError } from "@/lib/marketing/erros";
import { lerCorpo, parametroUuid, rotaMarketing } from "@/lib/marketing/http";
import { ALVOS, esquemaOrigemManual, exigirAlvoDaEmpresa, historicoAtribuicao, origemHerdadaDoCliente, registrarOrigemManual, type AlvoAtribuicao } from "@/lib/marketing/atribuicao";
import { lerOrigens } from "@/lib/marketing/origens";
import { exigirCapacidadeMarketing } from "@/lib/marketing/capacidades";
import { exigirRecursoPlano } from "@/lib/assinatura/recursos-plano";
import type { DbExecutor } from "@/lib/db/contracts";
import type { TenantComprovado } from "@/lib/saas/provar-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Origem manual de cliente, negociação ou contato — recurso BÁSICO do CRM: qualquer membership ativa da empresa, sem
 * exigir o plano de Marketing nem capacidade de Marketing. Empresa sempre da sessão; alvo de outra empresa = 404.
 * Exceção: CONTATO captado é dado do Marketing (plano + capacidade, como a tela de contatos).
 */
async function exigirMarketingSeContato(tx: DbExecutor, tenant: TenantComprovado, alvoTipo: string, escrita: boolean) {
  if (alvoTipo !== "CONTATO") return;
  await exigirRecursoPlano(tx, tenant.empresaComprovada, "MARKETING");
  await exigirCapacidadeMarketing(tx, tenant, escrita ? "MARKETING_CAMPANHAS_EDITAR" : "MARKETING_VISUALIZAR");
}
export async function GET(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: null, plano: false }, async ({ tx, tenant }) => {
    const q = request.nextUrl.searchParams;
    const alvoTipo = q.get("alvoTipo");
    const alvoId = parametroUuid(q.get("alvoId"));
    if (!alvoId || !(ALVOS as readonly string[]).includes(alvoTipo ?? "")) throw new MarketingError("DADOS_INVALIDOS", "Dados inválidos.", 400);
    const empresaId = tenant.empresaComprovada;
    await exigirMarketingSeContato(tx, tenant, alvoTipo!, false);
    await exigirAlvoDaEmpresa(tx, empresaId, alvoTipo as AlvoAtribuicao, alvoId);
    const historico = await historicoAtribuicao(tx, empresaId, alvoTipo as AlvoAtribuicao, alvoId);
    const campanhas = (await tx.query<{ id: string; nome: string }>(
      "SELECT id::text, nome FROM marketing_campanhas WHERE empresa_id = $1::uuid AND status <> 'ARQUIVADA' ORDER BY nome", [empresaId])).rows;
    const vigente = historico.find((a) => a.vigente) ?? null;
    // Sem origem própria, a primeira negociação do cliente conta no painel pela origem do cliente: a tela mostra isso.
    const herdadaDoCliente = alvoTipo === "FECHAMENTO" && !vigente ? await origemHerdadaDoCliente(tx, empresaId, alvoId) : null;
    return { vigente, herdadaDoCliente, historico, origens: await lerOrigens(tx, empresaId), campanhas };
  });
}

export async function POST(request: NextRequest) {
  return rotaMarketing(request, exigirApiAdminCrmDisponivel, { capacidade: null, plano: false }, async ({ tx, tenant }) => {
    const input = esquemaOrigemManual.parse(await lerCorpo(request));
    await exigirMarketingSeContato(tx, tenant, input.alvoTipo, true);
    return registrarOrigemManual(tx, tenant.empresaComprovada, tenant.usuarioId, input);
  });
}
