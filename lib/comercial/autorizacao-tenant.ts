import { PacoteAdminError } from "./pacotes-admin.ts";

/**
 * A sessão administrativa não carrega empresa.
 * Membership da Foundation não está nesta branch e não é inventada aqui.
 * Sem empresa comprovada no servidor, operação de tenant falha fechada.
 */
export function empresaComprovadaDaSessao(_sessao: { usuario_id: string; papel: string }): null {
  return null;
}

export function recusarTenantNaoComprovado(sessao: { usuario_id: string; papel: string }): never {
  if (empresaComprovadaDaSessao(sessao) == null) {
    throw new PacoteAdminError(
      "TENANT_NAO_COMPROVADO",
      "A sessão administrativa não comprova a empresa autorizada.",
      403,
    );
  }
  throw new PacoteAdminError(
    "TENANT_NAO_COMPROVADO",
    "A sessão administrativa não comprova a empresa autorizada.",
    403,
  );
}
