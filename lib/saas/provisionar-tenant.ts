import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { provarTenant, type TenantComprovado } from "./provar-tenant.ts";

export type PedidoProvisionamento = {
  codigo: string;
  nome: string;
  usuarioId: string;
  atorUsuarioId: string;
};

function recusar(code: string, message: string, status = 409): never {
  throw new PacoteAdminError(code, message, status);
}

/** Recusa a marca Kidmais antes de qualquer escrita. HG-6 continua aberto. */
export function recusarMarcaKidmais(codigo: string, nome: string): void {
  const texto = `${codigo}\n${nome}`.toLocaleLowerCase("pt-BR");
  if (texto.includes("kidmais")) {
    recusar("MARCA_RECUSADA", "Esta via não provisiona a marca Kidmais.");
  }
}

/**
 * Empresa em provisionamento, membership pendente, ativações explícitas e prova.
 * Repetir o mesmo par não cria outra membership e não reabre uma revogada.
 * Quem chama controla a transação: o rollback desfaz empresa, membership e auditoria.
 */
export async function provisionarTenant(tx: DbExecutor, pedido: PedidoProvisionamento): Promise<TenantComprovado> {
  const codigo = pedido.codigo.trim();
  const nome = pedido.nome.trim();
  recusarMarcaKidmais(codigo, nome);
  if (!/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/.test(codigo)) {
    recusar("DADOS_INVALIDOS", "O código da empresa não cabe no formato canônico.", 400);
  }
  await tx.query(`SELECT set_config('kidmais.ator_usuario_id', $1, true)`, [pedido.atorUsuarioId]);

  const existente = await tx.query<{ id: string; status: string }>(
    `SELECT id::text AS id, status FROM empresas WHERE codigo = $1`,
    [codigo],
  );
  let empresaId = existente.rows[0]?.id ?? null;
  let statusEmpresa = existente.rows[0]?.status ?? null;
  if (!empresaId) {
    const criada = await tx.query<{ id: string }>(
      `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`,
      [codigo, nome],
    );
    empresaId = criada.rows[0].id;
    statusEmpresa = "PROVISIONAMENTO";
  }

  const vinculo = await tx.query<{ id: string; status: string }>(
    `SELECT id::text AS id, status
       FROM memberships
      WHERE empresa_id = $1::uuid AND usuario_id = $2::uuid`,
    [empresaId, pedido.usuarioId],
  );
  if (vinculo.rows[0]?.status === "REVOGADA") {
    recusar("MEMBERSHIP_REVOGADA", "Membership revogada não é reutilizada.");
  }
  let membershipId = vinculo.rows[0]?.id ?? null;
  let statusMembership = vinculo.rows[0]?.status ?? null;
  if (!membershipId) {
    const criada = await tx.query<{ id: string }>(
      `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
       VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp())
       RETURNING id::text AS id`,
      [empresaId, pedido.usuarioId],
    );
    membershipId = criada.rows[0].id;
    statusMembership = "PENDENTE";
  }

  if (statusEmpresa === "PROVISIONAMENTO") {
    await tx.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [empresaId]);
  } else if (statusEmpresa !== "ATIVA") {
    recusar("EMPRESA_INOPERANTE", "A empresa não está em provisionamento nem ativa.");
  }
  if (statusMembership === "PENDENTE") {
    await tx.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [membershipId]);
  } else if (statusMembership !== "ATIVA") {
    recusar("MEMBERSHIP_INOPERANTE", "A membership não está pendente nem ativa.");
  }
  return provarTenant(tx, { usuario_id: pedido.usuarioId, papel: "REPRESENTANTE_AUTORIZADO" }, empresaId);
}
