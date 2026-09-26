import type { DbExecutor } from "../db/contracts.ts";
import { withTransaction } from "../db/postgres.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";

export type SessaoParaTenant = {
  usuario_id: string;
  papel: string;
};

export type TenantComprovado = {
  empresaComprovada: string;
  membershipId: string;
  usuarioId: string;
};

type LinhaMembership = { id: string; empresa_id: string };

function recusar(): never {
  throw new PacoteAdminError(
    "TENANT_NAO_COMPROVADO",
    "A sessão administrativa não comprova a empresa autorizada.",
    403,
  );
}

function selecao(empresaSolicitada?: string | null) {
  if (empresaSolicitada == null) return null;
  const texto = empresaSolicitada.trim();
  return texto === "" ? null : texto;
}

/**
 * Prova o tenant dentro da transação já aberta.
 * O id pedido só escolhe entre memberships ATIVA de empresa ATIVA.
 * A sessão não carrega essa prova.
 */
export async function provarTenant(
  tx: DbExecutor,
  sessao: SessaoParaTenant,
  empresaSolicitada?: string | null,
): Promise<TenantComprovado> {
  const usuario = await tx.query<{ ativo: boolean }>(
    `SELECT ativo
       FROM usuarios_administrativos
      WHERE id = $1::uuid
      FOR UPDATE`,
    [sessao.usuario_id],
  );
  if (!usuario.rows[0]?.ativo) recusar();

  const memberships = await tx.query<LinhaMembership>(
    `SELECT m.id::text AS id, m.empresa_id::text AS empresa_id
       FROM memberships m
       JOIN empresas e ON e.id = m.empresa_id
      WHERE m.usuario_id = $1::uuid
        AND m.status = 'ATIVA'
        AND e.status = 'ATIVA'
      FOR UPDATE OF m`,
    [sessao.usuario_id],
  );
  const pedida = selecao(empresaSolicitada);
  const linhas = memberships.rows;
  const escolhida = pedida == null
    ? (linhas.length === 1 ? linhas[0] : null)
    : linhas.find((linha) => linha.empresa_id === pedida) ?? null;
  if (!escolhida) recusar();
  return {
    empresaComprovada: escolhida.empresa_id,
    membershipId: escolhida.id,
    usuarioId: sessao.usuario_id,
  };
}

/** Relê a membership travada antes do commit. Revogação já confirmada impede a operação. */
export async function revalidarTenant(tx: DbExecutor, tenant: TenantComprovado): Promise<void> {
  const atual = await tx.query<{ membership: string; empresa: string; ativo: boolean }>(
    `SELECT m.status AS membership, e.status AS empresa, u.ativo
       FROM memberships m
       JOIN empresas e ON e.id = m.empresa_id
       JOIN usuarios_administrativos u ON u.id = m.usuario_id
      WHERE m.id = $1::uuid
        AND m.usuario_id = $2::uuid
        AND m.empresa_id = $3::uuid
      FOR UPDATE OF m`,
    [tenant.membershipId, tenant.usuarioId, tenant.empresaComprovada],
  );
  const linha = atual.rows[0];
  if (!linha || linha.membership !== "ATIVA" || linha.empresa !== "ATIVA" || linha.ativo !== true) recusar();
}

export async function executarNoTenant<T>(
  tx: DbExecutor,
  sessao: SessaoParaTenant,
  empresaSolicitada: string | null | undefined,
  work: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>,
): Promise<T> {
  const tenant = await provarTenant(tx, sessao, empresaSolicitada);
  const resultado = await work(tx, tenant);
  await revalidarTenant(tx, tenant);
  return resultado;
}

/** Transação só de tenant. Não altera o withTransaction global. */
export async function withTenantTransaction<T>(
  sessao: SessaoParaTenant,
  empresaSolicitada: string | null | undefined,
  work: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>,
): Promise<T> {
  return withTransaction((tx) => executarNoTenant(tx, sessao, empresaSolicitada, work));
}
