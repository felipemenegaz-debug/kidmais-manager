import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { provarTenant, travarUsuariosNaOrdem, type TenantComprovado } from "./provar-tenant.ts";

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
 * Cria empresa em provisionamento e membership pendente, ativa as duas e prova.
 * Empresa já persistida não é reutilizada: o modelo não tem marcador sintético.
 * Quem chama controla a transação: o rollback desfaz empresa, membership e auditoria.
 */
export async function provisionarTenant(tx: DbExecutor, pedido: PedidoProvisionamento): Promise<TenantComprovado> {
  const codigo = pedido.codigo.trim();
  const nome = pedido.nome.trim();
  recusarMarcaKidmais(codigo, nome);
  if (!/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/.test(codigo)) {
    recusar("DADOS_INVALIDOS", "O código da empresa não cabe no formato canônico.", 400);
  }
  await travarUsuariosNaOrdem(tx, [pedido.usuarioId, pedido.atorUsuarioId]);
  await tx.query(`SELECT set_config('kidmais.ator_usuario_id', $1, true)`, [pedido.atorUsuarioId]);

  const existente = await tx.query<{ id: string; codigo: string; nome: string; status: string }>(
    `SELECT id::text AS id, codigo, nome, status
       FROM empresas
      WHERE codigo = $1
      FOR UPDATE`,
    [codigo],
  );
  const persistida = existente.rows[0];
  if (persistida) {
    recusarMarcaKidmais(persistida.codigo, persistida.nome);
    recusar(
      "FORA_DO_ESCOPO_SINTETICO",
      "Empresa já persistida não é reutilizada: o modelo não tem marcador sintético.",
    );
  }
  const criada = await tx.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`,
    [codigo, nome],
  );
  const empresaId = criada.rows[0].id;
  const membership = await tx.query<{ id: string }>(
    `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde)
     VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp())
     RETURNING id::text AS id`,
    [empresaId, pedido.usuarioId],
  );
  await tx.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [empresaId]);
  await tx.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [membership.rows[0].id]);
  return provarTenant(tx, { usuario_id: pedido.usuarioId, papel: "REPRESENTANTE_AUTORIZADO" }, empresaId);
}
