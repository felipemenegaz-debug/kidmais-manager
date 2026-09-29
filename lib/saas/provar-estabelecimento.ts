import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import type { TenantComprovado } from "./provar-tenant.ts";

/**
 * Establishment Context: prova que a unidade pedida pertence à empresa JÁ comprovada e que a membership comprovada
 * tem vínculo ATIVO e vigente com ela. Só leitura, dentro da transação do Tenant Context, depois da trava da
 * membership (ordem usuário → empresa → membership → unidade; FOR SHARE, sem bloquear leituras concorrentes).
 *
 * Unidade de outra empresa, inexistente, não ATIVA (043: nasce SUSPENSO; o caminho ATIVO está fechado enquanto a
 * decisão D03 do Core estiver adiada) ou sem vínculo ATIVO/vigente da membership: o MESMO "Unidade não encontrada",
 * sem revelar qual condição falhou. O id nunca vem do modelo: só do pedido da tela (query string), como a empresa.
 */
export type EstabelecimentoComprovado = { estabelecimentoId: string; empresaId: string; membershipId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function naoEncontrada(): never {
  throw new PacoteAdminError("ESTABELECIMENTO_NAO_COMPROVADO", "Unidade não encontrada.", 404);
}

export async function provarEstabelecimento(tx: DbExecutor, tenant: TenantComprovado, estabelecimentoId: string): Promise<EstabelecimentoComprovado> {
  if (!UUID.test(estabelecimentoId)) naoEncontrada();
  const r = await tx.query<{ id: string }>(
    `SELECT e.id::text AS id
       FROM estabelecimentos e
       JOIN membership_estabelecimentos me
         ON me.empresa_id = e.empresa_id AND me.estabelecimento_id = e.id
      WHERE e.id = $1::uuid
        AND e.empresa_id = $2::uuid
        AND e.status = 'ATIVO'
        AND me.membership_id = $3::uuid
        AND me.status = 'ATIVA'
        AND me.vigente_desde <= clock_timestamp()
        AND (me.vigente_ate IS NULL OR me.vigente_ate > clock_timestamp())
      FOR SHARE OF e, me`,
    [estabelecimentoId, tenant.empresaComprovada, tenant.membershipId],
  );
  if (r.rows.length !== 1) naoEncontrada();
  return { estabelecimentoId: r.rows[0].id, empresaId: tenant.empresaComprovada, membershipId: tenant.membershipId };
}
