import { z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import { MarketingError } from "../erros.ts";

/**
 * Preferências de contato do Marketing (084). Mensagem automática só para cliente com autorização registrada
 * (formulário do site com a caixa marcada, ou registro da equipe) e SEM descadastro. Descadastro vale na hora e cancela
 * o que estava agendado para o cliente. O controle "não contatar" do atendimento WhatsApp (082), quando existe, também
 * bloqueia. Tudo é revalidado imediatamente antes do envio.
 */
export type Preferencia = { clienteId: string; whatsappAutorizado: boolean; autorizadoEm: string | null; autorizacaoOrigem: string | null; descadastradoEm: string | null; descadastroOrigem: string | null };

export async function automacoesInstaladas(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.marketing_contato_preferencias') IS NOT NULL AS ok`);
  return r.rows[0]?.ok === true;
}

export async function lerPreferencia(tx: DbExecutor, empresaId: string, clienteId: string): Promise<Preferencia | null> {
  const r = await tx.query<{ cliente_id: string; whatsapp_autorizado: boolean; autorizado_em: string | null; autorizacao_origem: string | null; descadastrado_em: string | null; descadastro_origem: string | null }>(
    `SELECT cliente_id::text, whatsapp_autorizado, autorizado_em::text, autorizacao_origem, descadastrado_em::text, descadastro_origem
       FROM marketing_contato_preferencias WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid`, [empresaId, clienteId]);
  const l = r.rows[0];
  return l ? { clienteId: l.cliente_id, whatsappAutorizado: l.whatsapp_autorizado, autorizadoEm: l.autorizado_em, autorizacaoOrigem: l.autorizacao_origem,
    descadastradoEm: l.descadastrado_em, descadastroOrigem: l.descadastro_origem } : null;
}

/** Autorização a partir do formulário do site: só se ainda não houver descadastro (descadastro nunca é desfeito por formulário). */
export async function autorizarPeloFormulario(tx: DbExecutor, empresaId: string, clienteId: string) {
  if (!(await automacoesInstaladas(tx))) return false;
  const r = await tx.query(
    `INSERT INTO marketing_contato_preferencias (empresa_id, cliente_id, whatsapp_autorizado, autorizado_em, autorizacao_origem)
     VALUES ($1::uuid, $2::uuid, true, clock_timestamp(), 'FORMULARIO_SITE')
     ON CONFLICT (empresa_id, cliente_id) DO UPDATE SET whatsapp_autorizado = true, autorizado_em = clock_timestamp(), autorizacao_origem = 'FORMULARIO_SITE',
       atualizado_em = clock_timestamp()
     WHERE marketing_contato_preferencias.descadastrado_em IS NULL AND NOT marketing_contato_preferencias.whatsapp_autorizado`,
    [empresaId, clienteId]);
  return (r.rowCount ?? 0) > 0;
}

export const esquemaPreferencia = z.object({
  acao: z.literal("preferencia"),
  clienteId: z.string().uuid(),
  operacao: z.enum(["autorizar", "descadastrar", "reativar"]),
  confirmacao: z.string().trim().min(3).max(300),
}).strict();

/**
 * Pela equipe: autorizar (com a confirmação de como a pessoa autorizou), descadastrar (cancela agendadas) ou reativar
 * após descadastro — este último exige registro explícito do novo pedido da própria pessoa.
 */
export async function alterarPreferencia(tx: DbExecutor, empresaId: string, usuarioId: string, input: z.infer<typeof esquemaPreferencia>) {
  const cliente = await tx.query<{ ok: boolean }>(`SELECT true AS ok FROM clientes WHERE id = $1::uuid AND empresa_id = $2::uuid`, [input.clienteId, empresaId]);
  if (cliente.rows.length !== 1) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Cliente não encontrado nesta empresa.", 404);
  const atual = await lerPreferencia(tx, empresaId, input.clienteId);
  if (input.operacao === "autorizar" && atual?.descadastradoEm) {
    throw new MarketingError("MARKETING_DESCADASTRADO", "Cliente descadastrado. Use “Reativar” somente com novo pedido da própria pessoa.", 409);
  }
  if (input.operacao === "descadastrar") {
    await tx.query(
      `INSERT INTO marketing_contato_preferencias (empresa_id, cliente_id, whatsapp_autorizado, descadastrado_em, descadastro_origem, observacao, atualizado_por)
       VALUES ($1::uuid, $2::uuid, false, clock_timestamp(), 'EQUIPE', $4, $3::uuid)
       ON CONFLICT (empresa_id, cliente_id) DO UPDATE SET whatsapp_autorizado = false, descadastrado_em = clock_timestamp(), descadastro_origem = 'EQUIPE',
         observacao = $4, atualizado_por = $3::uuid, atualizado_em = clock_timestamp()`, [empresaId, input.clienteId, usuarioId, input.confirmacao]);
    const canceladas = await suprimirAgendadasDoCliente(tx, empresaId, input.clienteId, "DESCADASTRADO");
    return { preferencia: await lerPreferencia(tx, empresaId, input.clienteId), canceladas };
  }
  await tx.query(
    `INSERT INTO marketing_contato_preferencias (empresa_id, cliente_id, whatsapp_autorizado, autorizado_em, autorizacao_origem, observacao, atualizado_por)
     VALUES ($1::uuid, $2::uuid, true, clock_timestamp(), 'EQUIPE', $4, $3::uuid)
     ON CONFLICT (empresa_id, cliente_id) DO UPDATE SET whatsapp_autorizado = true, autorizado_em = clock_timestamp(), autorizacao_origem = 'EQUIPE',
       descadastrado_em = NULL, descadastro_origem = NULL, observacao = $4, atualizado_por = $3::uuid, atualizado_em = clock_timestamp()`, [empresaId, input.clienteId, usuarioId, input.confirmacao]);
  return { preferencia: await lerPreferencia(tx, empresaId, input.clienteId), canceladas: 0 };
}

/** Descadastro: mensagens ainda agendadas para o cliente viram SUPRIMIDA (tarefas internas continuam). */
export async function suprimirAgendadasDoCliente(tx: DbExecutor, empresaId: string, clienteId: string, motivo: string) {
  const r = await tx.query<{ id: string }>(
    `UPDATE marketing_automacao_execucoes SET estado = 'SUPRIMIDA', motivo = $3, concluida_em = clock_timestamp(), atualizado_em = clock_timestamp()
      WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid AND estado = 'AGENDADA' AND acao = 'MENSAGEM_WHATSAPP' RETURNING id::text`,
    [empresaId, clienteId, motivo]);
  for (const { id } of r.rows) {
    await tx.query(`INSERT INTO marketing_automacao_eventos (empresa_id, execucao_id, estado_anterior, estado_novo, detalhe) VALUES ($1::uuid, $2::uuid, 'AGENDADA', 'SUPRIMIDA', $3::jsonb)`,
      [empresaId, id, JSON.stringify({ motivo })]);
  }
  return r.rows.length;
}

export type Elegibilidade = { ok: true; telefone: string } | { ok: false; motivo: "SEM_AUTORIZACAO" | "DESCADASTRADO" | "SEM_TELEFONE" | "NAO_CONTATAR_ATENDIMENTO" | "CLIENTE_INATIVO" };

/** Revalidação da mensagem para o cliente, no momento do envio. */
export async function elegivelParaMensagem(tx: DbExecutor, empresaId: string, clienteId: string): Promise<Elegibilidade> {
  const c = await tx.query<{ status: string; whatsapp: string | null; telefone: string | null }>(
    `SELECT status, whatsapp, telefone FROM clientes WHERE id = $1::uuid AND empresa_id = $2::uuid`, [clienteId, empresaId]);
  const cliente = c.rows[0];
  if (!cliente || cliente.status !== "ATIVO") return { ok: false, motivo: "CLIENTE_INATIVO" };
  const pref = await lerPreferencia(tx, empresaId, clienteId);
  if (pref?.descadastradoEm) return { ok: false, motivo: "DESCADASTRADO" };
  if (!pref?.whatsappAutorizado) return { ok: false, motivo: "SEM_AUTORIZACAO" };
  const telefone = cliente.whatsapp ?? cliente.telefone;
  if (!telefone) return { ok: false, motivo: "SEM_TELEFONE" };
  const controle = await tx.query<{ existe: string | null }>(`SELECT to_regclass('public.whatsapp_atendimento_controles_contato')::text AS existe`);
  if (controle.rows[0]?.existe) {
    const bloqueio = await tx.query<{ ok: boolean }>(
      `SELECT true AS ok FROM whatsapp_atendimento_controles_contato WHERE empresa_id = $1::uuid AND nao_contatar AND (contato = $2 OR contato = '55' || $2) LIMIT 1`,
      [empresaId, telefone]);
    if (bloqueio.rows.length > 0) return { ok: false, motivo: "NAO_CONTATAR_ATENDIMENTO" };
  }
  return { ok: true, telefone };
}
