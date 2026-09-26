import { PacoteAdminError } from "./pacotes-admin.ts";

/**
 * A sessão administrativa não carrega empresa.
 * consultarSessao não preenche empresaComprovada e um campo injetado
 * também não prova autorização. A prova é provarTenant, dentro da transação.
 */
export function empresaComprovadaDaSessao(sessao: {
  usuario_id: string;
  papel: string;
  empresaComprovada?: string | null;
}): null {
  void sessao.empresaComprovada;
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

export function recusarTenantNaoComprovado(
  sessao: { usuario_id: string; papel: string; empresaComprovada?: string | null },
  empresaSolicitada?: string | null,
): never {
  void empresaSolicitada;
  empresaComprovadaDaSessao(sessao);
  throw new PacoteAdminError(
    "TENANT_NAO_COMPROVADO",
    "A sessão administrativa não comprova a empresa autorizada.",
    403,
  );
}
