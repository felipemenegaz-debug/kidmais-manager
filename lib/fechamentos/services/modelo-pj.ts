import type { DbExecutor } from "../../db/contracts";
import type { ClienteRecord } from "../../clientes/repositories";
import { MENSAGEM_MODELO_INCOMPATIVEL_PJ } from "../../contratos/modelo-empresa/compatibilidade-pj";
import { trechosModeloAtivoIncompativeisPj } from "../../contratos/modelo-empresa/servico";
import { FechamentoServiceError } from "./errors";

/**
 * R2-2 (Entrega B): contratante PJ com o modelo ativo da empresa que o qualifica como pessoa física é recusado já no
 * fechamento (criação e revisão), antes de chegar ao contrato; a geração do contrato confere de novo. PF: nada.
 */
export async function trechosIncompativeisDoContratante(tx: DbExecutor, cliente: Pick<ClienteRecord, "tipoPessoa" | "empresaId">) {
  if (cliente.tipoPessoa !== "PJ" || !cliente.empresaId) return [];
  return trechosModeloAtivoIncompativeisPj(tx, cliente.empresaId);
}

export async function exigirModeloCompativelNoFechamento(tx: DbExecutor, cliente: Pick<ClienteRecord, "tipoPessoa" | "empresaId">) {
  const trechos = await trechosIncompativeisDoContratante(tx, cliente);
  if (trechos.length) throw new FechamentoServiceError("MODELO_INCOMPATIVEL_PJ", MENSAGEM_MODELO_INCOMPATIVEL_PJ, 409, { trechos });
}
