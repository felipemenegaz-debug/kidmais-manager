import type { DbExecutor } from "../../db/contracts.ts";
import type { SessaoParaTenant, TenantComprovado } from "../../saas/provar-tenant.ts";
import { PacoteAdminError } from "../../comercial/pacotes-admin.ts";

/**
 * Núcleo atômico do Tenant Context das rotas administrativas de contrato (módulo folha, sem ciclo de import).
 *
 * Autorização e aquisição de dados na MESMA transação: provarTenant (usuário, empresa, membership e papel
 * ATUAL travados até o commit) → papel atual conferido → posse do recurso com a empresa comprovada no WHERE →
 * `trabalho` recebe o MESMO `tx` para ler/travar/gravar → revalidarTenant → commit. Depois do commit só resta
 * processamento em memória (ex.: renderizar PDF) — nenhuma consulta sensível.
 * Ordem de travas: usuário → empresas → membership → recurso.
 */
export class ResumoTenantError extends Error {
  readonly code = "NAO_ENCONTRADO";
  readonly httpStatus = 404;
  constructor() {
    super("Contrato não encontrado.");
    this.name = "ResumoTenantError";
  }
}

export type ComTenant = <T>(sessao: SessaoParaTenant, empresaSolicitada: string | null | undefined, work: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>) => Promise<T>;
export type ProvaDePosse = (tx: DbExecutor, empresaId: string, id: string) => Promise<boolean>;

/** Papéis administrativos conhecidos. As rotas financeiras aceitam os dois; restrições finas ficam no serviço. */
export const PAPEIS_ADMINISTRATIVOS: readonly string[] = ["ADMINISTRATIVO", "REPRESENTANTE_AUTORIZADO"];

/**
 * C2/D1 — autorização e leitura/escrita na MESMA transação. Revogar membership, suspender a empresa,
 * desativar o usuário ou trocar o papel concorrentemente espera o commit — nunca intercala. Sem posse: 404
 * igual para outra empresa, legado e inexistente (`ResumoTenantError`).
 */
export async function executarComPosseNoTenant<T>(
  sessao: SessaoParaTenant,
  empresaSolicitada: string | null,
  id: string,
  posse: ProvaDePosse,
  deps: { withTenantTransaction: ComTenant },
  trabalho: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>,
  papeis: readonly string[] = PAPEIS_ADMINISTRATIVOS,
): Promise<T> {
  return deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
    if (!papeis.includes(tenant.papelAtual)) throw new PacoteAdminError("PAPEL_NAO_AUTORIZADO", "Seu acesso atual não permite esta operação.", 403);
    if (!await posse(tx, tenant.empresaComprovada, id)) throw new ResumoTenantError();
    return trabalho(tx, tenant);
  });
}
