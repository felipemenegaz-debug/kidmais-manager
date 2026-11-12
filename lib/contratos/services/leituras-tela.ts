import type { DbExecutor } from '../../db/contracts.ts';
import { estadoDerivado, type Estado } from '../../festas/domain.ts';
import { versaoDeReferencia, type FluxoBase, type VersaoBase } from '../versao-referencia.ts';
import { salaoDoSnapshot, type ContratoSnapshot } from '../repositories/models.ts';

/**
 * Leituras da tela de contrato simplificada (plano rev. 4, fase 1). Somente SELECT, no `tx` da posse provada, presas à
 * empresa comprovada. Não chamam os seletores de salão (`escolher*`/`aplicar*` gravam) nem alteram nada.
 */

/** Colunas/tabelas de salão (093/094) presentes: sem elas, a leitura devolve null sem citar a coluna no SQL. */
async function esquemaSalao(tx: DbExecutor) {
  const r = await tx.query<{ tabela: boolean; festa: boolean; revisao: boolean; unidade: boolean }>(
    `SELECT to_regclass('public.agenda_saloes') IS NOT NULL AS tabela,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fechamentos' AND column_name='salao_id') AS festa,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fechamento_revisoes' AND column_name='salao_id') AS revisao,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fechamentos' AND column_name='estabelecimento_id') AS unidade`);
  return r.rows[0] ?? { tabela: false, festa: false, revisao: false, unidade: false };
}

/**
 * Leituras da tela no `tx` da posse provada: salão e estado da festa. Lê o mínimo do contrato (status, fluxo e versões)
 * para não alterar o formato do detalhe administrativo, que a guarda de tenant confere.
 */
export async function leiturasDaTela(tx: DbExecutor, contratoId: string, empresaId: string, agora = new Date()) {
  const contrato = (await tx.query<{ status: string }>(
    `SELECT c.status FROM contratos c JOIN fechamentos fe ON fe.id = c.fechamento_id AND fe.empresa_id = $2::uuid WHERE c.id = $1::uuid`,
    [contratoId, empresaId])).rows[0];
  if (!contrato) return { salao: null, salaoAlteracao: null, estadoFesta: null, salaoContrato: null, estadoVersao: null };
  const fluxo = (await tx.query<{ versao_vigente_id: string | null; versao_em_preparacao_id: string | null }>(
    'SELECT versao_vigente_id, versao_em_preparacao_id FROM contrato_fluxos WHERE contrato_id = $1::uuid', [contratoId])).rows[0] ?? null;
  const versoes = (await tx.query<VersaoBase & { snapshot: unknown }>(
    'SELECT id, numero_versao, status, snapshot FROM contrato_versoes WHERE contrato_id = $1::uuid', [contratoId])).rows;
  return {
    ...await salaoDoContrato(tx, contratoId, empresaId),
    ...await salaoDaVersao(tx, contratoId, empresaId, fluxo, versoes),
    estadoFesta: await estadoFestaDoContrato(tx, contratoId, empresaId, { contrato, fluxo, versoes }, agora),
  };
}

/** Nome do salão da festa e, se houver revisão aberta com salão, o da alteração. */
export async function salaoDoContrato(tx: DbExecutor, contratoId: string, empresaId: string): Promise<{ salao: string | null; salaoAlteracao: string | null }> {
  const e = await esquemaSalao(tx);
  if (!e.tabela || !e.unidade) return { salao: null, salaoAlteracao: null };
  const salao = e.festa ? (await tx.query<{ nome: string }>(
    `SELECT s.nome FROM contratos c
       JOIN fechamentos f ON f.id = c.fechamento_id AND f.empresa_id = $2::uuid
       JOIN agenda_saloes s ON s.id = f.salao_id AND s.empresa_id = $2::uuid AND s.estabelecimento_id IS NOT DISTINCT FROM f.estabelecimento_id
      WHERE c.id = $1::uuid`, [contratoId, empresaId])).rows[0]?.nome ?? null : null;
  const salaoAlteracao = e.revisao ? (await tx.query<{ nome: string }>(
    `SELECT s.nome FROM fechamento_revisoes r
       JOIN contratos c ON c.id = r.contrato_id AND c.fechamento_id = r.fechamento_id
       JOIN fechamentos f ON f.id = r.fechamento_id AND f.empresa_id = $2::uuid
       JOIN agenda_saloes s ON s.id = r.salao_id AND s.empresa_id = $2::uuid AND s.estabelecimento_id IS NOT DISTINCT FROM f.estabelecimento_id
      WHERE r.contrato_id = $1::uuid AND r.estado IN ('EM_ELABORACAO','CONGELADA')
      LIMIT 1`, [contratoId, empresaId])).rows[0]?.nome ?? null : null;
  return { salao, salaoAlteracao };
}

export type EstadoVersaoSalao = { estado: 'atual' } | { estado: 'desatualizada'; motivo: 'salao' | 'data' } | { estado: 'troca_em_andamento' };

/**
 * S-E (R3-E3): comparação EXPLÍCITA do salão do documento (versão em preparação, ou a vigente) com o estado operacional,
 * para os avisos do contrato e do salão. Só versões V3 com salão; V1/V2 → null. Em revisão operacional aberta, o
 * documento traz o destino e a festa continua no salão vigente: troca em andamento quando os dois diferem. Fora disso,
 * festa em outro salão = desatualizada (salão); data, horário ou configuração diferentes = desatualizada (data).
 */
export async function salaoDaVersao(tx: DbExecutor, contratoId: string, empresaId: string, fluxo: FluxoBase | null,
  versoes: Array<VersaoBase & { snapshot: unknown }>): Promise<{ salaoContrato: string | null; estadoVersao: EstadoVersaoSalao | null }> {
  const id = fluxo?.versao_em_preparacao_id ?? fluxo?.versao_vigente_id ?? null;
  const v = versoes.find((x) => x.id === id);
  const snapshot = v?.snapshot as ContratoSnapshot | undefined;
  const salao = snapshot ? salaoDoSnapshot(snapshot) : null;
  if (!snapshot || snapshot.schemaVersao !== 3 || !salao) return { salaoContrato: null, estadoVersao: null };
  const f = (await tx.query<{ salao: string | null; data: string; inicio: string; fim: string; cfg: string; revisao: boolean }>(
    `SELECT f.salao_id::text AS salao, f.data_evento::text AS data, f.horario_inicio::text AS inicio, f.horario_fim::text AS fim,
            f.configuracao_agenda_id::text AS cfg,
            EXISTS (SELECT 1 FROM fechamento_revisoes r WHERE r.contrato_versao_id = $3::uuid AND r.estado IN ('EM_ELABORACAO','CONGELADA')) AS revisao
       FROM contratos c JOIN fechamentos f ON f.id = c.fechamento_id AND f.empresa_id = $2::uuid WHERE c.id = $1::uuid`,
    [contratoId, empresaId, v!.id])).rows[0];
  if (!f) return { salaoContrato: salao.nome, estadoVersao: null };
  if (f.revisao) return { salaoContrato: salao.nome, estadoVersao: f.salao === salao.id ? { estado: 'atual' } : { estado: 'troca_em_andamento' } };
  const e = snapshot.evento;
  if (f.data !== e.data || f.inicio.slice(0, 5) !== e.horarioInicio.slice(0, 5) || f.fim.slice(0, 5) !== e.horarioFim.slice(0, 5) || f.cfg !== e.configuracaoAgendaId)
    return { salaoContrato: salao.nome, estadoVersao: { estado: 'desatualizada', motivo: 'data' } };
  if (f.salao && f.salao !== salao.id) return { salaoContrato: salao.nome, estadoVersao: { estado: 'desatualizada', motivo: 'salao' } };
  return { salaoContrato: salao.nome, estadoVersao: { estado: 'atual' } };
}

/**
 * Estado da festa para a etapa "Festa realizada" (rev. 4, R3-5 + P3-1): `estadoDerivado` com o snapshot da versão de
 * referência, `cancelada` = contrato CANCELADO e `invalidada` = festa com `invalidada_em` (mesma composição de
 * lib/festas/service.ts). Leitura própria: alcança a festa invalidada, que o `festaId` das ações exclui. Sem festa: null.
 */
export async function estadoFestaDoContrato(tx: DbExecutor, contratoId: string, empresaId: string, detalhe: {
  contrato: { status: string }; fluxo: FluxoBase; versoes: Array<VersaoBase & { snapshot: unknown }>;
}, agora = new Date()): Promise<Estado | null> {
  const festa = (await tx.query<{ invalidada: boolean }>(
    `SELECT f.invalidada_em IS NOT NULL AS invalidada FROM festas f
       JOIN contratos c ON c.id = f.contrato_id
       JOIN fechamentos fe ON fe.id = c.fechamento_id AND fe.empresa_id = $2::uuid
      WHERE f.contrato_id = $1::uuid
      ORDER BY (f.invalidada_em IS NULL) DESC
      LIMIT 1`, [contratoId, empresaId])).rows[0];
  if (!festa) return null;
  const referencia = versaoDeReferencia(detalhe.versoes, detalhe.fluxo);
  if (!referencia) return null;
  return estadoDerivado(referencia.versao.snapshot, detalhe.contrato.status === 'CANCELADO', festa.invalidada, agora);
}
