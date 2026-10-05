import type { DbExecutor } from "../db/contracts.ts";
import { withTransaction } from "../db/postgres.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";

export type SessaoParaTenant = {
  usuario_id: string;
  papel: string;
  id?: string;
  empresa_ativa_id?: string | null;
};

export type TenantComprovado = {
  empresaComprovada: string;
  membershipId: string;
  usuarioId: string;
  /**
   * Papel PERSISTIDO do usuário NESTA empresa (memberships.papel, 056), lido com a membership travada
   * (FOR UPDATE) nesta transação — não o papel da identidade global nem o da sessão. A trava vale até o
   * commit: mudança concorrente de papel espera. Papel em outra empresa não conta.
   */
  papelAtual: string;
};

type LinhaMembership = { id: string; empresa_id: string; papel?: string };

/**
 * Ordem única dos fluxos de tenant, para não cruzar com suspensão nem revogação:
 * usuário → empresa → membership.
 * A empresa comprovada permanece travada até o commit da transação chamadora.
 */
function recusar(): never {
  throw new PacoteAdminError(
    "TENANT_NAO_COMPROVADO",
    "A sessão administrativa não comprova a empresa autorizada.",
    403,
  );
}

export async function travarUsuariosNaOrdem(tx: DbExecutor, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await tx.query(
      `SELECT id
         FROM usuarios_administrativos
        WHERE id = $1::uuid
        FOR UPDATE`,
      [id],
    );
  }
}

async function travarEmpresasDoUsuario(tx: DbExecutor, usuarioId: string): Promise<string[]> {
  const empresas = await tx.query<{ id: string }>(
    `SELECT DISTINCT m.empresa_id::text AS id
       FROM memberships m
      WHERE m.usuario_id = $1::uuid
      ORDER BY id`,
    [usuarioId],
  );
  for (const empresa of empresas.rows) {
    await tx.query(
      `SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE`,
      [empresa.id],
    );
  }
  return empresas.rows.map((empresa) => empresa.id);
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
  await travarUsuariosNaOrdem(tx, [sessao.usuario_id]);
  const usuario = await tx.query<{ ativo: boolean }>(
    `SELECT ativo
       FROM usuarios_administrativos
      WHERE id = $1::uuid`,
    [sessao.usuario_id],
  );
  if (!usuario.rows[0]?.ativo) recusar();

  // Uma troca revoga a sessão antiga. Revalidar depois da trava do usuário impede que uma
  // requisição já autenticada opere com o contexto anterior após o commit da troca.
  if (sessao.id && sessao.empresa_ativa_id !== undefined) {
    const atual = await tx.query<{ empresa_ativa_id: string | null }>(
      `SELECT to_jsonb(s)->>'empresa_ativa_id' AS empresa_ativa_id FROM sessoes_administrativas s
        WHERE s.id=$1::uuid AND s.usuario_id=$2::uuid AND s.revogado_em IS NULL AND s.expira_em>clock_timestamp()`,
      [sessao.id, sessao.usuario_id],
    );
    if (!atual.rows[0] || atual.rows[0].empresa_ativa_id !== sessao.empresa_ativa_id) recusar();
  }

  const empresasTravadas = await travarEmpresasDoUsuario(tx, sessao.usuario_id);
  if (empresasTravadas.length === 0) recusar();
  const memberships = await tx.query<LinhaMembership>(
    `SELECT m.id::text AS id, m.empresa_id::text AS empresa_id, m.papel
       FROM memberships m
       JOIN empresas e ON e.id = m.empresa_id
      WHERE m.usuario_id = $1::uuid
        AND m.empresa_id = ANY($2::uuid[])
        AND m.status = 'ATIVA'
        AND e.status = 'ATIVA'
      ORDER BY m.id
      FOR UPDATE OF m`,
    [sessao.usuario_id, empresasTravadas],
  );
  const explicita = selecao(empresaSolicitada);
  const selecionada = sessao.empresa_ativa_id ?? null;
  // Parâmetros de uma página antiga não podem mudar a empresa da sessão.
  if (selecionada && explicita && selecionada !== explicita) recusar();
  const pedida = selecionada ?? explicita;
  const linhas = memberships.rows;
  if (sessao.id && sessao.empresa_ativa_id === null && explicita &&
      (linhas.length !== 1 || linhas[0].empresa_id !== explicita)) recusar();
  const escolhida = pedida == null
    ? (linhas.length === 1 ? linhas[0] : null)
    : linhas.find((linha) => linha.empresa_id === pedida) ?? null;
  if (!escolhida) recusar();
  // 056: o papel é o DESTA membership (empresa comprovada), travada até o commit; nunca o da identidade global.
  const papelAtual = escolhida.papel;
  if (typeof papelAtual !== "string" || papelAtual === "") recusar();
  return {
    empresaComprovada: escolhida.empresa_id,
    membershipId: escolhida.id,
    usuarioId: sessao.usuario_id,
    papelAtual,
  };
}

/**
 * 056 — autoridade de Gestão NESTA empresa: o papel da membership comprovada (`papelAtual`), nunca o papel
 * da identidade global nem o da sessão. Chamar dentro da transação do tenant.
 */
export function exigirGestaoNoTenant(tenant: TenantComprovado, mensagem: string): void {
  if (tenant.papelAtual !== "REPRESENTANTE_AUTORIZADO") throw new PacoteAdminError("PAPEL_NAO_AUTORIZADO", mensagem, 403);
}

/** Relê a membership travada antes do commit. Revogação já confirmada impede a operação. */
export async function revalidarTenant(tx: DbExecutor, tenant: TenantComprovado): Promise<void> {
  await travarUsuariosNaOrdem(tx, [tenant.usuarioId]);
  const usuario = await tx.query<{ ativo: boolean }>(
    `SELECT ativo FROM usuarios_administrativos WHERE id = $1::uuid`,
    [tenant.usuarioId],
  );
  if (usuario.rows[0]?.ativo !== true) recusar();

  const empresa = await tx.query<{ status: string }>(
    `SELECT status FROM empresas WHERE id = $1::uuid FOR UPDATE`,
    [tenant.empresaComprovada],
  );
  if (empresa.rows[0]?.status !== "ATIVA") recusar();

  const atual = await tx.query<{ membership: string }>(
    `SELECT m.status AS membership
       FROM memberships m
      WHERE m.id = $1::uuid
        AND m.usuario_id = $2::uuid
        AND m.empresa_id = $3::uuid
      FOR UPDATE`,
    [tenant.membershipId, tenant.usuarioId, tenant.empresaComprovada],
  );
  if (atual.rows[0]?.membership !== "ATIVA") recusar();
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
