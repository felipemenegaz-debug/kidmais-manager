import { PacoteAdminError } from "./pacotes-admin.ts";

/**
 * A sessão administrativa não carrega empresa.
 * Membership da Foundation não está nesta branch e não é inventada aqui.
 * O campo opcional só existe para um teste do ramo futuro: a consulta da
 * sessão não o preenche e a rota não copia o empresaId do cliente para cá.
 */
export function empresaComprovadaDaSessao(sessao: {
  usuario_id: string;
  papel: string;
  empresaComprovada?: string | null;
}): string | null {
  if (typeof sessao.empresaComprovada !== "string" || sessao.empresaComprovada.trim() === "") return null;
  return sessao.empresaComprovada;
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

export function recusarTenantNaoComprovado(
  sessao: { usuario_id: string; papel: string; empresaComprovada?: string | null },
  empresaSolicitada?: string | null,
): string {
  const comprovada = empresaComprovadaDaSessao(sessao);
  if (comprovada == null) {
    throw new PacoteAdminError(
      "TENANT_NAO_COMPROVADO",
      "A sessão administrativa não comprova a empresa autorizada.",
      403,
    );
  }
  if (empresaSolicitada != null && empresaSolicitada !== "" && empresaSolicitada !== comprovada) {
    throw new PacoteAdminError(
      "TENANT_NAO_COMPROVADO",
      "A sessão administrativa não comprova a empresa autorizada.",
      403,
    );
  }
  return comprovada;
}
