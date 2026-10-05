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
