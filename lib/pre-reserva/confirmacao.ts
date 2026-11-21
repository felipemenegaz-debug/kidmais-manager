import { z } from 'zod';
import { travarConfiguracaoAgenda } from '../agenda/trava-configuracao.ts';
import { escopoPorSalao, salaoServeNoDestino } from '../agenda/salao-festa.ts';
import { adquirirLockConfirmacaoAgenda, verificarConflitoAgendaParaConfirmacao } from '../disponibilidade/repositories/disponibilidade.repository.ts';
import type { DbExecutor } from '../db/contracts.ts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { exigirGestaoNoTenant, type TenantComprovado } from '../saas/provar-tenant.ts';
import { garantiaAte as limitePadrao, vencimentoDaGarantia, referenciaTransferencia } from './politica.ts';
import { auditarMovimentoPreReserva } from './auditoria.ts';

const entrada = z.object({
  acao: z.enum(['CONFIRMAR', 'REGISTRAR_DIVERGENTE_A_DEVOLVER']).default('CONFIRMAR'),
  referencia: z.string().trim().regex(/^E[0-9]{20}[A-Za-z0-9]{11}$/),
  valorCentavos: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  aceiteSequencia: z.number().int().positive(),
}).strict();

type Alvo = { data: string; inicio: string; fim: string; configuracaoId: string; pacoteId: string;
  unidade: string | null; salaoEscolhido: string | null; convidados: number; status: string };
type Aceite = { sequencia: number; sinal: number; salao: string | null; corresponde: boolean; limite: string };
type Movimento = { motivo: string | null; pedido: string; valor: string; sequencia: number; garantiaAte: Date | null };

export async function confirmarSinal(tx: DbExecutor, tenant: TenantComprovado, pedido: string, raw: unknown) {
  exigirGestaoNoTenant(tenant,'Somente a Gestão confirma o sinal.');
  const dados = entrada.parse(raw);
  const referencia = referenciaTransferencia(dados.referencia);
  const empresa = tenant.empresaComprovada;
  const schema = await tx.query<{ instalada: boolean }>(
    "SELECT to_regprocedure('public.pre_reserva_exigir_configuracao()') IS NOT NULL AS instalada",
  );
  if (!schema.rows[0]?.instalada) {
    throw new PacoteAdminError('PRE_RESERVA_INDISPONIVEL', 'A confirmação de sinal ainda não está disponível.', 503);
  }
  // withTenantTransaction já travou a empresa. A 130 volta a travar o pedido no INSERT.
  await travarConfiguracaoAgenda(tx,empresa,{modo:'COMPARTILHADA',linha:'JA_TRAVADA'});
  const f = (await tx.query<Alvo>(`SELECT data_evento::text AS data, horario_inicio::text AS inicio, horario_fim::text AS fim,
    configuracao_agenda_id AS "configuracaoId", pacote_id AS "pacoteId", estabelecimento_id AS unidade,
    coalesce(salao_id,salao_preferido_id) AS "salaoEscolhido", convidados,status
    FROM fechamentos WHERE empresa_id=$1 AND id=$2 FOR UPDATE`,[empresa,pedido])).rows[0];
  if (!f) throw new PacoteAdminError('PEDIDO_INEXISTENTE','Pedido não encontrado.',404);
  const existente = (await tx.query<Movimento>(`SELECT motivo_sem_garantia AS motivo,fechamento_id AS pedido,valor_centavos::text AS valor,
    aceite_sequencia AS sequencia,garantia_ate AS "garantiaAte" FROM pre_reserva_recebimentos
    WHERE empresa_id=$1 AND end_to_end_id=$2`,[empresa,referencia])).rows[0];
  if (existente) {
    if (existente.pedido !== pedido || Number(existente.valor) !== dados.valorCentavos || existente.sequencia !== dados.aceiteSequencia)
      throw new PacoteAdminError('PIX_JA_LANCADO','Transferência já vinculada a outro lançamento. Confira o extrato.',409);
    return { garantiaAte: existente.garantiaAte, motivo: existente.motivo ?? (existente.garantiaAte ? null : 'SEM_GARANTIA_ANTERIOR') };
  }
  const a = (await tx.query<Aceite>(`SELECT sequencia,sinal_centavos AS sinal,salao_id AS salao,inicio_evento::text AS limite,
    estabelecimento_id IS NOT DISTINCT FROM $3::uuid AND
    inicio_evento=(($4::date+$5::time) AT TIME ZONE 'America/Sao_Paulo') AND
    fim_evento=(($4::date+$6::time) AT TIME ZONE 'America/Sao_Paulo') AS corresponde
    FROM pre_reserva_aceites WHERE empresa_id=$1 AND fechamento_id=$2 ORDER BY sequencia DESC LIMIT 1`,
    [empresa,pedido,f.unidade,f.data,f.inicio,f.fim])).rows[0];
  if (!a || a.sequencia !== dados.aceiteSequencia) throw new PacoteAdminError('ACEITE_MUDOU','Atualize o pedido e confira o aceite antes de confirmar.',409);
  const divergente = dados.valorCentavos !== a.sinal;
  if (!divergente && dados.acao === 'REGISTRAR_DIVERGENTE_A_DEVOLVER') {
    throw new PacoteAdminError('PIX_SEM_DIVERGENCIA', 'O valor coincide com o sinal. Confira o lançamento.', 409);
  }
  if (divergente && dados.acao !== 'REGISTRAR_DIVERGENTE_A_DEVOLVER') {
    throw new PacoteAdminError('PIX_VALOR_DIVERGENTE', 'Confira o valor recebido no extrato antes de confirmar o sinal. Se o crédito divergente estiver correto, confirme o registro para devolução.', 409, { sinalCentavos: a.sinal, recebidoCentavos: dados.valorCentavos });
  }
  await adquirirLockConfirmacaoAgenda(f.data,tx);
  if (f.unidade) {
    await tx.query('SELECT kidmais062_travar_habilitacao($1::uuid)', [f.unidade]);
  }
  const destino = { ...f, fechamentoId:pedido, empresaId:empresa, estabelecimentoId:f.unidade };
  const salaOk = await escopoPorSalao(tx,empresa,f.unidade)
    ? a.salao !== null && (!f.salaoEscolhido || f.salaoEscolhido === a.salao) && await salaoServeNoDestino(tx,destino,a.salao)
    : a.salao === null;
  const conflito = await verificarConflitoAgendaParaConfirmacao({
    fechamentoId: pedido, data: f.data, horarioInicio: f.inicio, horarioFim: f.fim, salaoDoAceite: a.salao,
  }, tx);
  const { rows: [agenda] } = await tx.query<{ livre: boolean; agora: Date }>(`SELECT clock_timestamp() AS agora,
    NOT EXISTS (SELECT FROM pre_reserva_recebimentos WHERE empresa_id=$1 AND fechamento_id=$2 AND garantia_ate IS NOT NULL)
    AND ($3::uuid IS NULL OR kidmais062_unidade_agendavel($1,$3)) AND NOT kidmais019_ocupa($2) AS livre`,
    [empresa, pedido, f.unidade]);
  const vencimento = vencimentoDaGarantia(agenda.agora, new Date(a.limite));
  let motivo: string | null = null;
  if (divergente) motivo = 'VALOR_DIVERGENTE';
  else if (!vencimento) motivo = 'MENOS_DE_24_HORAS';
  else if (f.status !== 'AGUARDANDO_CONTRATO') motivo = 'PEDIDO_INELEGIVEL';
  else if (!a.corresponde) motivo = 'DESTINO_MUDOU';
  else if (!salaOk || !agenda.livre || conflito.bloqueioAgenda || conflito.fechamentoConfirmado) motivo = 'HORARIO_INDISPONIVEL';
  // O horário do aceite pode ter microssegundos. O mínimo exato é calculado pelo PostgreSQL.
  const teto = motivo ? null : limitePadrao(agenda.agora);
  const insercao = await tx.query<{ garantiaAte: Date | null }>(`INSERT INTO pre_reserva_recebimentos
    (empresa_id,fechamento_id,end_to_end_id,valor_centavos,confirmado_por,confirmado_em,sinal_garantido_centavos,garantia_ate,motivo_sem_garantia)
    VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8::timestamptz IS NOT NULL THEN least($8::timestamptz,$10::timestamptz) END,$9)
    ON CONFLICT (empresa_id,end_to_end_id) DO NOTHING RETURNING garantia_ate AS "garantiaAte"`,
    [empresa,pedido,referencia,dados.valorCentavos,tenant.usuarioId,agenda.agora,teto ? a.sinal : null,teto,motivo,a.limite]);
  if (!insercao.rows.length) {
    throw new PacoteAdminError('PIX_JA_LANCADO', 'Transferência já lançada. Confira o extrato.', 409);
  }
  await auditarMovimentoPreReserva(tx, tenant, 'PRE_RESERVA_SINAL_CONFIRMADO', empresa, pedido, referencia, agenda.agora);
  return { garantiaAte: insercao.rows[0].garantiaAte, motivo };
}
