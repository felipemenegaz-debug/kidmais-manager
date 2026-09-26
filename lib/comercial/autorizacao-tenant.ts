import { PacoteAdminError } from "./pacotes-admin.ts";

/**
 * A sessão administrativa não carrega empresa.
 * Membership da Foundation não está nesta branch e não é inventada aqui.
 * Sem empresa comprovada no servidor, operação de tenant falha fechada.
 */
export function empresaComprovadaDaSessao(sessao: { usuario_id: string; papel: string }): null {
  void sessao;
  return null;
}

export const catalogoPublicoIndeterminado = {
  codigo: "CATALOGO_PUBLICO_INDETERMINADO" as const,
  erro: "O catálogo público não comprova a empresa, a revisão vigente nem a data do evento.",
  httpStatus: 403 as const,
};

/** Código repetido em duas empresas não pode ser escolhido por ativo nem por ordem da consulta. */
export function recusarCatalogoPublicoSemTenant(): never {
  throw new PacoteAdminError(
    catalogoPublicoIndeterminado.codigo,
    catalogoPublicoIndeterminado.erro,
    catalogoPublicoIndeterminado.httpStatus,
  );
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
