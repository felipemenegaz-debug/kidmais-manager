import type { NextRequest } from "next/server";
import type { DbExecutor } from "../db/contracts.ts";
import type { SessaoAdmin } from "../autenticacao/service.ts";
import { exigirRecursoPlano } from "../assinatura/recursos-plano.ts";
import { apiErrorResponse, jsonNoStore } from "../http/api-response.ts";
import { withTenantTransaction, type TenantComprovado } from "../saas/provar-tenant.ts";
import { capacidadesDoTenant, exigirCapacidadeMarketing, type CapacidadeMarketing } from "./capacidades.ts";
import { MarketingError } from "./erros.ts";

/**
 * Molde das APIs administrativas de Marketing. Ordem fixa, igual às demais APIs:
 *   1. guarda administrativa recebida da rota (exigirApiAdminCrmDisponivel: sessão, CSRF, origem, paywall);
 *   2. transação de tenant (empresa SEMPRE da sessão comprovada; nada do navegador escolhe empresa);
 *   3. plano (MARKETING), exceto origem manual do CRM (`plano: false`);
 *   4. capacidade de Marketing (Gestão tem todas; Equipe precisa de concessão), exceto origem manual.
 */
export type ContextoMarketing = { tx: DbExecutor; tenant: TenantComprovado; sessao: SessaoAdmin; capacidades: CapacidadeMarketing[] };
export type Guarda = (request: NextRequest) => Promise<SessaoAdmin>;

export async function rotaMarketing<T>(
  request: NextRequest,
  guarda: Guarda,
  opcoes: { capacidade: CapacidadeMarketing | null; plano?: boolean },
  work: (ctx: ContextoMarketing) => Promise<T>,
) {
  try {
    const sessao = await guarda(request);
    const data = await withTenantTransaction(sessao, null, async (tx, tenant) => {
      if (opcoes.plano !== false) await exigirRecursoPlano(tx, tenant.empresaComprovada, "MARKETING");
      const capacidades = opcoes.capacidade ? await exigirCapacidadeMarketing(tx, tenant, opcoes.capacidade) : await capacidadesDoTenant(tx, tenant).catch(() => []);
      return work({ tx, tenant, sessao, capacidades });
    });
    return jsonNoStore({ ok: true, data });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** Corpo JSON com limite (64 KB por padrão; o rascunho do site usa 256 KB). */
export async function lerCorpo(request: NextRequest, limite = 64_000): Promise<unknown> {
  const texto = await request.text();
  if (texto.length > limite) throw new MarketingError("MARKETING_CORPO_GRANDE", "Conteúdo grande demais.", 413);
  try { return texto ? JSON.parse(texto) : {}; } catch { throw new SyntaxError("JSON inválido"); }
}

export function parametroUuid(valor: string | null) {
  return valor && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor) ? valor : null;
}

export function parametroData(valor: string | null) {
  return valor && /^\d{4}-\d{2}-\d{2}$/.test(valor) ? valor : null;
}
