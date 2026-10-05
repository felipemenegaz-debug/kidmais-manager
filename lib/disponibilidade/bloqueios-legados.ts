import type { DbExecutor } from '../db/contracts.ts';
import type { EscopoAgenda } from './escopo.ts';
import { AvailabilityServiceError } from './services/errors.ts';
import { reautenticacaoPerfilRecente } from '../perfil/reautenticacao.ts';
import { temConcessaoDesenvolvedor } from '../desenvolvedor/autorizacao.ts';

/** Autoridade da plataforma, nunca inferida do papel da empresa. Compatível sem a 063. */
export async function podeResolverBloqueioLegado(tx: DbExecutor, usuarioId: string) {
  const instalada = (await tx.query<{ instalada: boolean }>("SELECT to_regclass('public.plataforma_desenvolvedores') IS NOT NULL AS instalada")).rows[0]?.instalada;
  if (!instalada) return false;
  return temConcessaoDesenvolvedor(tx, usuarioId, true);
}

/** Chamar na mesma transação do tenant comprovado. Resolução individual, com motivo e histórico preservado. */
export async function resolverEDesativarBloqueioLegado(tx: DbExecutor, escopo: EscopoAgenda,
  sessao: { usuario_id: string; autenticado_em: string; consultado_em?: string }, bloqueioId: string, motivo: string) {
  if (!await podeResolverBloqueioLegado(tx, sessao.usuario_id))
    throw new AvailabilityServiceError('SEM_AUTORIDADE', 'A atribuição de bloqueios antigos exige autorização da plataforma.', 403);
  if (!reautenticacaoPerfilRecente(sessao.autenticado_em, Date.parse(sessao.consultado_em ?? '')))
    throw new AvailabilityServiceError('REAUTENTICACAO', 'Entre novamente para confirmar sua senha antes de atribuir este bloqueio.', 403);
  if (!escopo.empresaId || !escopo.estabelecimentoId || motivo.trim().length < 5 || motivo.trim().length > 1000)
    throw new AvailabilityServiceError('RESOLUCAO_INVALIDA', 'Selecione uma unidade e informe o motivo da atribuição (5 a 1000 caracteres).', 400);
  // Mesma ordem do reparo 062: habilitação da unidade antes da data e do bloqueio.
  await tx.query('SELECT kidmais062_travar_habilitacao($1::uuid)', [escopo.estabelecimentoId]);
  const unidade = (await tx.query<{ valida: boolean }>('SELECT kidmais062_unidade_agendavel($1::uuid,$2::uuid) AS valida', [escopo.empresaId, escopo.estabelecimentoId])).rows[0];
  if (!unidade?.valida) throw new AvailabilityServiceError('UNIDADE_INVALIDA', 'Unidade indisponível para agenda.', 409);
  // A data é imutável nesta operação; a atualização condicionada abaixo recusa disputa de resolução.
  const atual = (await tx.query<{ data: string }>('SELECT data::text FROM bloqueios_agenda WHERE id=$1::uuid AND empresa_id IS NULL AND ativo', [bloqueioId])).rows[0];
  if (!atual) throw new AvailabilityServiceError('BLOQUEIO_NAO_ENCONTRADO', 'Bloqueio antigo ativo não encontrado.', 404);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda:' || $1::text, 0))", [atual.data]);
  const resolucao = await tx.query(`INSERT INTO agenda_062_bloqueios_resolucao (bloqueio_id,empresa_id,estabelecimento_id,decidido_por,motivo)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5) ON CONFLICT (bloqueio_id) DO NOTHING RETURNING bloqueio_id`, [bloqueioId, escopo.empresaId, escopo.estabelecimentoId, sessao.usuario_id, motivo.trim()]);
  if (!resolucao.rowCount) throw new AvailabilityServiceError('RESOLUCAO_EXISTENTE', 'Este bloqueio já tem uma atribuição registrada. A plataforma precisa conferir essa atribuição antes de alterá-lo.', 409);
  const alterado = await tx.query(`UPDATE bloqueios_agenda SET empresa_id=$2::uuid, estabelecimento_id=$3::uuid, ativo=false
    WHERE id=$1::uuid AND empresa_id IS NULL AND ativo RETURNING id`, [bloqueioId, escopo.empresaId, escopo.estabelecimentoId]);
  if (!alterado.rowCount) throw new AvailabilityServiceError('BLOQUEIO_ALTERADO', 'O bloqueio foi alterado. Atualize a agenda.', 409);
}

/** Bloqueio ativo e sem empresa (anterior à 062)? Só faz sentido com a 062 instalada. */
export async function bloqueioLegadoSemDono(tx: DbExecutor, bloqueioId: string) {
  const r = await tx.query<{ id: string }>('SELECT id FROM bloqueios_agenda WHERE id=$1::uuid AND empresa_id IS NULL AND ativo', [bloqueioId]);
  return r.rows.length > 0;
}

export const MOTIVO_LIBERACAO_PADRAO = 'Liberado pela empresa no painel da agenda.';

/**
 * Liberação de um bloqueio antigo (sem empresa) pela PRÓPRIA empresa, no painel da agenda, sem autoridade da plataforma.
 * Bloqueio de agenda nunca pertence a contrato (a ocupação de contrato é outra tabela e continua na agenda), então o que
 * se protege aqui é só a propriedade: a empresa precisa ser a dona plausível do bloqueio, isto é,
 *   (a) quem criou o bloqueio tem (ou teve) vínculo com esta empresa, ou
 *   (b) não existe nenhuma outra empresa com agenda (ATIVA ou SUSPENSA) a quem o bloqueio possa pertencer.
 * Fora disso a decisão continua com a plataforma (resolverEDesativarBloqueioLegado). A decisão é gravada em
 * agenda_062_bloqueios_resolucao (empresa, unidade, quem decidiu, motivo) e o registro fica atribuído e inativo.
 */
export async function liberarBloqueioLegadoPelaEmpresa(tx: DbExecutor, escopo: EscopoAgenda, usuarioId: string, bloqueioId: string,
  motivo: string = MOTIVO_LIBERACAO_PADRAO) {
  const justificativa = motivo.trim();
  if (!escopo.empresaId || justificativa.length < 5 || justificativa.length > 1000)
    throw new AvailabilityServiceError('RESOLUCAO_INVALIDA', 'Selecione a empresa e informe o motivo da liberação (5 a 1000 caracteres).', 400);
  // Mesma ordem do reparo 062 e da resolução pela plataforma: habilitação da unidade antes da data e do bloqueio.
  if (escopo.estabelecimentoId) {
    await tx.query('SELECT kidmais062_travar_habilitacao($1::uuid)', [escopo.estabelecimentoId]);
    const unidade = (await tx.query<{ valida: boolean }>('SELECT kidmais062_unidade_agendavel($1::uuid,$2::uuid) AS valida', [escopo.empresaId, escopo.estabelecimentoId])).rows[0];
    if (!unidade?.valida) throw new AvailabilityServiceError('UNIDADE_INVALIDA', 'Unidade indisponível para agenda.', 409);
  }
  const atual = (await tx.query<{ data: string; criado_por_usuario_id: string | null }>(
    'SELECT data::text, criado_por_usuario_id::text FROM bloqueios_agenda WHERE id=$1::uuid AND empresa_id IS NULL AND ativo', [bloqueioId])).rows[0];
  if (!atual) throw new AvailabilityServiceError('BLOQUEIO_NAO_ENCONTRADO', 'Bloqueio antigo ativo não encontrado.', 404);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda:' || $1::text, 0))", [atual.data]);
  const dona = (await tx.query<{ autor_da_empresa: boolean; unica_empresa: boolean }>(
    `SELECT ($2::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM memberships m WHERE m.usuario_id=$2::uuid AND m.empresa_id=$1::uuid)) AS autor_da_empresa,
            NOT EXISTS(SELECT 1 FROM empresas e WHERE e.id<>$1::uuid AND e.status IN ('ATIVA','SUSPENSA')) AS unica_empresa`,
    [escopo.empresaId, atual.criado_por_usuario_id])).rows[0];
  if (!dona?.autor_da_empresa && !dona?.unica_empresa)
    throw new AvailabilityServiceError('BLOQUEIO_SEM_DONO',
      'Este bloqueio é anterior à separação da agenda por empresa e pode pertencer a outra empresa. A liberação precisa ser feita pela plataforma.', 409);
  await tx.query(`INSERT INTO agenda_062_bloqueios_resolucao (bloqueio_id,empresa_id,estabelecimento_id,decidido_por,motivo)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5) ON CONFLICT (bloqueio_id) DO NOTHING`, [bloqueioId, escopo.empresaId, escopo.estabelecimentoId, usuarioId, justificativa]);
  const resolucao = (await tx.query<{ empresa_id: string }>('SELECT empresa_id::text FROM agenda_062_bloqueios_resolucao WHERE bloqueio_id=$1::uuid', [bloqueioId])).rows[0];
  if (resolucao?.empresa_id !== escopo.empresaId)
    throw new AvailabilityServiceError('RESOLUCAO_EXISTENTE', 'Este bloqueio já tem uma atribuição registrada para outra empresa. A plataforma precisa conferir essa atribuição antes de alterá-lo.', 409);
  const alterado = await tx.query(`UPDATE bloqueios_agenda SET empresa_id=$2::uuid, estabelecimento_id=$3::uuid, ativo=false
    WHERE id=$1::uuid AND empresa_id IS NULL AND ativo RETURNING id`, [bloqueioId, escopo.empresaId, escopo.estabelecimentoId]);
  if (!alterado.rowCount) throw new AvailabilityServiceError('BLOQUEIO_ALTERADO', 'O bloqueio foi alterado. Atualize a agenda.', 409);
}
