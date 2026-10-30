import type { DbExecutor } from "../db/contracts.ts";

/**
 * Supressão adiantada das pesquisas (plano rev. 4, M3). É só OTIMIZAÇÃO: todo despacho revalida descadastro, saída das
 * pesquisas e consentimento do canal, então nenhuma chamada esquecida libera um envio.
 *
 * Alcance:
 *   TODOS    — descadastro geral do Marketing e saída das pesquisas: execuções PESQUISA_SATISFACAO AGENDADA e todas as
 *              entregas PENDENTE do cliente, nos dois canais (não toca na Mensagem simples: suprimirAgendadasDoCliente
 *              mantém o alcance do Marketing);
 *   WHATSAPP — revogação de um número ou PARAR: só as entregas WHATSAPP PENDENTE. Com `aindaElegivel`, só quando o
 *              cliente ficou sem destino de WhatsApp elegível (outro número autorizado continua valendo no despacho);
 *   EMAIL    — e-mail removido ou inválido: só as entregas EMAIL PENDENTE.
 */
export type AlcancePesquisa = { canal: "TODOS" | "WHATSAPP" | "EMAIL"; motivo: string; aindaElegivel?: () => Promise<boolean> };

export async function pesquisaInstalada(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.satisfacao_entregas') IS NOT NULL AS ok`);
  return r.rows[0]?.ok === true;
}

export async function suprimirPesquisas(tx: DbExecutor, empresaId: string, clienteId: string, alcance: AlcancePesquisa) {
  if (!(await pesquisaInstalada(tx))) return { execucoes: 0, entregas: 0 };
  if (alcance.canal === "WHATSAPP" && alcance.aindaElegivel && (await alcance.aindaElegivel())) return { execucoes: 0, entregas: 0 };
  const motivo = alcance.motivo.slice(0, 300);
  let execucoes = 0;
  if (alcance.canal === "TODOS") {
    const r = await tx.query<{ id: string }>(
      `UPDATE marketing_automacao_execucoes SET estado = 'SUPRIMIDA', motivo = $3, concluida_em = clock_timestamp(), atualizado_em = clock_timestamp()
        WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid AND estado = 'AGENDADA' AND acao = 'PESQUISA_SATISFACAO' RETURNING id::text`,
      [empresaId, clienteId, motivo]);
    for (const { id } of r.rows) {
      await tx.query(`INSERT INTO marketing_automacao_eventos (empresa_id, execucao_id, estado_anterior, estado_novo, detalhe) VALUES ($1::uuid, $2::uuid, 'AGENDADA', 'SUPRIMIDA', $3::jsonb)`,
        [empresaId, id, JSON.stringify({ motivo })]);
    }
    execucoes = r.rows.length;
  }
  const entregas = await tx.query(
    `UPDATE satisfacao_entregas d SET estado = 'SUPRIMIDA', motivo = $4, concluida_em = clock_timestamp()
       FROM satisfacao_envios e
      WHERE d.envio_id = e.id AND e.empresa_id = $1::uuid AND e.cliente_id = $2::uuid AND d.estado = 'PENDENTE'
        AND ($3 = 'TODOS' OR d.canal = $3)`,
    [empresaId, clienteId, alcance.canal, motivo]);
  return { execucoes, entregas: entregas.rowCount ?? 0 };
}

/** PARAR numa conversa: os clientes da empresa com esse número no cadastro (com ou sem DDI). Só WhatsApp. */
export async function clientesDoNumero(tx: DbExecutor, empresaId: string, contato: string) {
  const digitos = contato.replace(/\D/g, "");
  const nacional = digitos.startsWith("55") && digitos.length >= 12 ? digitos.slice(2) : digitos;
  const r = await tx.query<{ id: string }>(
    `SELECT id::text FROM clientes WHERE empresa_id = $1::uuid
        AND (regexp_replace(coalesce(whatsapp, ''), '\\D', '', 'g') IN ($2, $3) OR regexp_replace(coalesce(telefone, ''), '\\D', '', 'g') IN ($2, $3))`,
    [empresaId, `55${nacional}`, nacional]);
  return r.rows.map((x) => x.id);
}
