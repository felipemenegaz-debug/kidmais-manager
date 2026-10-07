import type { DbExecutor } from "../db/contracts.ts";
import { escopoPublico, type AmbienteAgendaPublica } from "../disponibilidade/escopo.ts";
import { recusarCatalogoPublicoSemTenant } from "./autorizacao-tenant.ts";

/** O catálogo e a contratação usam a mesma empresa/unidade da agenda pública.
 * Nenhum identificador da URL ou da sessão administrativa escolhe esta empresa.
 * O fallback global anterior à migration 062 NÃO autoriza catálogo público.
 */
export async function escopoCatalogoPublico(
  conexao: () => DbExecutor,
  env: AmbienteAgendaPublica = process.env as AmbienteAgendaPublica,
) {
  if (!env.AGENDA_PUBLICA_EMPRESA_ID?.trim()) recusarCatalogoPublicoSemTenant();
  const escopo = await escopoPublico(conexao, env);
  if (!escopo.empresaId) recusarCatalogoPublicoSemTenant();
  return { empresaId: escopo.empresaId, estabelecimentoId: escopo.estabelecimentoId };
}
