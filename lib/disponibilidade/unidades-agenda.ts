import type { DbExecutor } from "../db/contracts.ts";
import { agendaPorEscopoInstalada } from "./escopo.ts";
import { AvailabilityServiceError } from "./services/errors.ts";

/**
 * Habilitação de unidade para agenda (062, D6 = opção A). A regra de elegibilidade é única e fica no banco
 * (kidmais062_unidade_agendavel); este serviço só faz a decisão humana explícita e auditada:
 *   - habilitar/revogar: Representante autorizado (Gestão, 056) NESTA empresa, com motivo; o banco confere de novo
 *     (membership ATIVA, papel gravado, unidade da empresa não desativada, empresa ATIVA) e guarda o histórico imutável;
 *   - nenhuma unidade é habilitada automaticamente;
 *   - revogar = suspensão administrativa: reservas gravadas na unidade ficam e continuam ocupando; nova contratação,
 *     alteração de data/horário, novo destino de remarcação, bloqueio e turno na unidade passam a ser recusados.
 */
export const PAPEL_OPERADOR_AGENDA = "REPRESENTANTE_AUTORIZADO";

export type OperadorAgenda = { empresaComprovada: string; usuarioId: string; papelAtual: string };
export type ContextoAgenda = { requestId: string | null; ip: string | null; userAgent: string | null };
export type AuditoriaAgenda = {
  atorTipo: "USUARIO";
  usuarioId: string;
  acao: "AGENDA_UNIDADE_HABILITADA" | "AGENDA_UNIDADE_REVOGADA";
  entidadeTipo: "ESTABELECIMENTO";
  entidadeId: string;
  dadosAntes?: Record<string, unknown> | null;
  dadosDepois: Record<string, unknown>;
  justificativa: string;
  origem: "AGENDA_ADMIN";
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
};
/** Porta de auditoria (composição real: registrarAuditoria na mesma transação). */
export type Auditar = (tx: DbExecutor, registro: AuditoriaAgenda) => Promise<unknown>;

export type UnidadeAgendaGestao = {
  id: string;
  codigo: string;
  nome: string;
  habilitada: boolean;
  habilitadaEm: string | null;
  motivoHabilitacao: string | null;
  reservasFuturas: number;
};

async function exigirInstalada(tx: DbExecutor) {
  if (!(await agendaPorEscopoInstalada(tx))) {
    throw new AvailabilityServiceError("AGENDA_POR_UNIDADE_INDISPONIVEL", "A agenda por unidade ainda não está disponível neste ambiente.", 503);
  }
}

function exigirOperador(operador: OperadorAgenda) {
  if (operador.papelAtual !== PAPEL_OPERADOR_AGENDA) {
    throw new AvailabilityServiceError("PAPEL_NAO_AUTORIZADO", "Somente o representante autorizado da empresa habilita ou revoga unidades da agenda.", 403);
  }
}

export function motivoAgenda(bruto: unknown): string {
  const motivo = typeof bruto === "string" ? bruto.trim() : "";
  if (motivo.length < 5 || motivo.length > 1000) {
    throw new AvailabilityServiceError("MOTIVO_OBRIGATORIO", "Informe o motivo (de 5 a 1000 caracteres).", 400);
  }
  return motivo;
}

/** Reservas futuras que ocupam a unidade (preservadas numa revogação). */
async function reservasFuturas(tx: DbExecutor, empresaId: string, unidadeId: string) {
  const r = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.fechamentos f
      WHERE f.empresa_id = $1::uuid AND f.estabelecimento_id = $2::uuid AND f.data_evento >= current_date AND public.kidmais019_ocupa(f.id)`,
    [empresaId, unidadeId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Unidades da empresa comprovada (exceto desativadas) com a situação da habilitação. Leitura do tenant. */
export async function listarUnidadesAgenda(tx: DbExecutor, empresaId: string): Promise<UnidadeAgendaGestao[]> {
  await exigirInstalada(tx);
  const r = await tx.query<{ id: string; codigo: string; nome: string; habilitada_em: string | null; motivo_habilitacao: string | null; reservas: number }>(
    `SELECT u.id::text, u.codigo, u.nome, h.habilitada_em::text, h.motivo_habilitacao,
            (SELECT count(*)::int FROM public.fechamentos f WHERE f.empresa_id = u.empresa_id AND f.estabelecimento_id = u.id
              AND f.data_evento >= current_date AND public.kidmais019_ocupa(f.id)) AS reservas
       FROM public.estabelecimentos u
       LEFT JOIN public.agenda_062_unidades_habilitacao h ON h.estabelecimento_id = u.id AND h.revogada_em IS NULL
      WHERE u.empresa_id = $1::uuid AND u.status <> 'DESATIVADO'
      ORDER BY u.nome, u.id`,
    [empresaId],
  );
  return r.rows.map((l) => ({
    id: l.id, codigo: l.codigo, nome: l.nome, habilitada: l.habilitada_em !== null, habilitadaEm: l.habilitada_em,
    motivoHabilitacao: l.motivo_habilitacao, reservasFuturas: Number(l.reservas),
  }));
}

/** Trava a unidade da empresa comprovada (serializa habilitar/revogar da mesma unidade). Outra empresa = não encontrada. */
async function travarUnidade(tx: DbExecutor, empresaId: string, unidadeId: string) {
  const r = await tx.query<{ status: string }>(
    `SELECT status FROM public.estabelecimentos WHERE empresa_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
    [empresaId, unidadeId],
  );
  const unidade = r.rows[0];
  if (!unidade) throw new AvailabilityServiceError("UNIDADE_NAO_ENCONTRADA", "Unidade não encontrada nesta empresa.", 404);
  if (unidade.status === "DESATIVADO") throw new AvailabilityServiceError("UNIDADE_DESATIVADA", "Unidade desativada não pode receber agenda.", 409);
}

export async function habilitarUnidadeAgenda(
  tx: DbExecutor, operador: OperadorAgenda, unidadeId: string, motivoBruto: unknown, ctx: ContextoAgenda, auditar: Auditar,
) {
  exigirOperador(operador);
  const motivo = motivoAgenda(motivoBruto);
  await exigirInstalada(tx);
  const empresaId = operador.empresaComprovada;
  await travarUnidade(tx, empresaId, unidadeId);
  const vigente = await tx.query(
    `SELECT 1 FROM public.agenda_062_unidades_habilitacao WHERE estabelecimento_id = $1::uuid AND revogada_em IS NULL`,
    [unidadeId],
  );
  if (vigente.rows.length) throw new AvailabilityServiceError("UNIDADE_JA_HABILITADA", "Esta unidade já está habilitada para a agenda.", 409);
  const h = (await tx.query<{ id: string; habilitada_em: string }>(
    `INSERT INTO public.agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5) RETURNING id::text, habilitada_em::text`,
    [empresaId, unidadeId, operador.usuarioId, operador.papelAtual, motivo],
  )).rows[0];
  await auditar(tx, {
    atorTipo: "USUARIO", usuarioId: operador.usuarioId, acao: "AGENDA_UNIDADE_HABILITADA", entidadeTipo: "ESTABELECIMENTO", entidadeId: unidadeId,
    dadosAntes: null, dadosDepois: { empresaId, habilitacaoId: h.id, habilitadaEm: h.habilitada_em }, justificativa: motivo,
    origem: "AGENDA_ADMIN", requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
  });
  return { unidadeId, habilitacaoId: h.id, habilitadaEm: h.habilitada_em };
}

export async function revogarUnidadeAgenda(
  tx: DbExecutor, operador: OperadorAgenda, unidadeId: string, motivoBruto: unknown, ctx: ContextoAgenda, auditar: Auditar,
) {
  exigirOperador(operador);
  const motivo = motivoAgenda(motivoBruto);
  await exigirInstalada(tx);
  const empresaId = operador.empresaComprovada;
  await travarUnidade(tx, empresaId, unidadeId);
  // A revogação espera quem está gravando na unidade (FOR SHARE dos gatilhos) e vale para tudo que vier depois.
  const h = (await tx.query<{ id: string; habilitada_em: string; revogada_em: string }>(
    `UPDATE public.agenda_062_unidades_habilitacao
        SET revogada_por = $3::uuid, revogada_papel = $4, motivo_revogacao = $5
      WHERE empresa_id = $1::uuid AND estabelecimento_id = $2::uuid AND revogada_em IS NULL
      RETURNING id::text, habilitada_em::text, revogada_em::text`,
    [empresaId, unidadeId, operador.usuarioId, operador.papelAtual, motivo],
  )).rows[0];
  if (!h) throw new AvailabilityServiceError("UNIDADE_NAO_HABILITADA", "Esta unidade não está habilitada para a agenda.", 409);
  const preservadas = await reservasFuturas(tx, empresaId, unidadeId);
  await auditar(tx, {
    atorTipo: "USUARIO", usuarioId: operador.usuarioId, acao: "AGENDA_UNIDADE_REVOGADA", entidadeTipo: "ESTABELECIMENTO", entidadeId: unidadeId,
    dadosAntes: { habilitacaoId: h.id, habilitadaEm: h.habilitada_em },
    dadosDepois: { empresaId, revogadaEm: h.revogada_em, reservasFuturasPreservadas: preservadas }, justificativa: motivo,
    origem: "AGENDA_ADMIN", requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
  });
  return { unidadeId, habilitacaoId: h.id, revogadaEm: h.revogada_em, reservasFuturasPreservadas: preservadas };
}
