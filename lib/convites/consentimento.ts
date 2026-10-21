import { createHash } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { exigir } from './domain.ts';
import { conteudoCanonicoIA, ehProvedorIA, textosAutorizacaoIA, VERSAO_TEXTOS_IA, type MeioAutorizacao, type OperadorIA, type ProvedorIA, type VinculoResponsavel } from './consentimento-textos.ts';

// Autorização específica do responsável legal para Convites com IA (migration 088, tabela convite_ia_autorizacoes).
// Regra do servidor: sem autorização vigente para o convite (festa/criança), o provedor atual e a versão atual dos
// textos, a geração é recusada antes de qualquer reserva ou envio. Foto e imagens de referência exigem foto_autorizada.
// Nenhuma função aqui registra em log o nome do responsável, o prompt ou imagens.

export type ConviteRef = { id: string; empresa_id: string; festa_id: string; cliente_id: string };
export type OperadorRef = { tipo: 'BUFFET'; usuarioId: string } | { tipo: 'CLIENTE'; clienteId: string };
export type AutorizacaoLinha = { id: string; provedor: string; texto_versao: string; texto_hash: string; operador_tipo: OperadorIA;
  foto_autorizada: boolean; responsavel_vinculo: VinculoResponsavel; meio: MeioAutorizacao; criado_em: Date | string };
export type NovaAutorizacao = { versao: string; provedor: string; textoHash: string; responsavelNome: string; vinculo: VinculoResponsavel;
  meio?: MeioAutorizacao; declaracao: true; foto: boolean };

export const hashTextoIA = (provedor: ProvedorIA, operador: OperadorIA, foto: boolean) =>
  createHash('sha256').update(conteudoCanonicoIA(textosAutorizacaoIA(provedor, operador), foto)).digest('hex');

/** Textos e hashes do texto atual para quem está na tela; o navegador devolve o hash do texto que exibiu. */
export function textosParaTela(provedor: ProvedorIA, operador: OperadorIA) {
  return { ...textosAutorizacaoIA(provedor, operador), hashes: { semFoto: hashTextoIA(provedor, operador, false), comFoto: hashTextoIA(provedor, operador, true) } };
}

// A autorização só vale com o provedor que será chamado e com o texto exatamente na versão atual.
function valida(a: AutorizacaoLinha, provedor: ProvedorIA) {
  return a.provedor === provedor && a.texto_versao === VERSAO_TEXTOS_IA && ehProvedorIA(a.provedor)
    && a.texto_hash === hashTextoIA(a.provedor, a.operador_tipo, a.foto_autorizada);
}

const COLUNAS = 'id,provedor,texto_versao,texto_hash,operador_tipo,foto_autorizada,responsavel_vinculo,meio,criado_em';

/** Autorização não revogada do convite (qualquer versão), sempre filtrada pela empresa comprovada. */
async function naoRevogada(tx: DbExecutor, c: Pick<ConviteRef, 'id' | 'empresa_id'>, travar = false) {
  return (await tx.query<AutorizacaoLinha>(`SELECT ${COLUNAS} FROM convite_ia_autorizacoes
    WHERE convite_id=$1 AND empresa_id=$2 AND revogada_em IS NULL${travar ? ' FOR UPDATE' : ''}`, [c.id, c.empresa_id])).rows[0] ?? null;
}

/** Autorização vigente e válida para o provedor que será chamado, ou null. */
export async function autorizacaoVigente(tx: DbExecutor, c: Pick<ConviteRef, 'id' | 'empresa_id'>, provedor: ProvedorIA) {
  const a = await naoRevogada(tx, c, true);
  return a && valida(a, provedor) ? a : null;
}

/** Resumo para a tela, sem o nome do responsável. precisaRenovar: há autorização antiga (outro provedor ou texto). */
export async function resumoAutorizacao(tx: DbExecutor, c: Pick<ConviteRef, 'id' | 'empresa_id'>, provedor: ProvedorIA) {
  const a = await naoRevogada(tx, c);
  if (!a) return { vigente: null, precisaRenovar: false };
  if (!valida(a, provedor)) return { vigente: null, precisaRenovar: true };
  return { vigente: { id: a.id, provedor: a.provedor, foto: a.foto_autorizada, operador: a.operador_tipo, vinculo: a.responsavel_vinculo,
    meio: a.meio, registradaEm: new Date(a.criado_em).toISOString() }, precisaRenovar: false };
}

/**
 * Registra a autorização exibida para o provedor ATUAL. O texto aceito precisa ser o da versão atual, com o hash
 * calculado aqui; a anterior não revogada é encerrada como SUBSTITUIDA na mesma transação.
 */
export async function registrarAutorizacao(tx: DbExecutor, c: ConviteRef, operador: OperadorRef, ator: string, provedorAtual: ProvedorIA, i: NovaAutorizacao) {
  exigir(i.declaracao === true, 'Confirme a declaração do responsável legal.', 400);
  exigir(i.provedor === provedorAtual, 'O provedor de IA mudou. Leia o novo aviso e autorize novamente.', 409);
  exigir(i.versao === VERSAO_TEXTOS_IA, 'O texto da autorização foi atualizado. Leia o novo texto e autorize novamente.', 409);
  exigir(i.textoHash === hashTextoIA(provedorAtual, operador.tipo, i.foto), 'O texto exibido não corresponde ao texto atual. Recarregue a página.', 409);
  const nome = i.responsavelNome.trim().replace(/\s+/g, ' ');
  exigir(nome.length >= 2 && nome.length <= 120, 'Informe o nome do responsável legal.', 400);
  // O responsável no link autoriza por si; o buffet informa como recebeu a autorização (sem padrão implícito).
  exigir(operador.tipo === 'BUFFET' || i.meio === undefined, 'O meio da autorização é informado somente pelo buffet.', 400);
  exigir(operador.tipo === 'CLIENTE' || (i.meio !== undefined && i.meio !== 'PROPRIO_RESPONSAVEL'), 'Informe como o responsável deu a autorização.', 400);
  const meio: MeioAutorizacao = operador.tipo === 'CLIENTE' ? 'PROPRIO_RESPONSAVEL' : i.meio!;
  const anterior = await naoRevogada(tx, c, true);
  if (anterior) await tx.query(`UPDATE convite_ia_autorizacoes SET revogada_em=clock_timestamp(),revogada_por=$3,revogacao_motivo='SUBSTITUIDA'
    WHERE id=$1 AND empresa_id=$2 AND revogada_em IS NULL`, [anterior.id, c.empresa_id, ator]);
  const r = await tx.query<{ id: string; criado_em: Date }>(`INSERT INTO convite_ia_autorizacoes(empresa_id,convite_id,festa_id,provedor,texto_versao,texto_hash,
      operador_tipo,operador_usuario_id,operador_cliente_id,responsavel_nome,responsavel_vinculo,meio,declaracao_responsavel,foto_autorizada)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13) RETURNING id,criado_em`,
  [c.empresa_id, c.id, c.festa_id, provedorAtual, VERSAO_TEXTOS_IA, i.textoHash, operador.tipo,
    operador.tipo === 'BUFFET' ? operador.usuarioId : null, operador.tipo === 'CLIENTE' ? operador.clienteId : null, nome, i.vinculo, meio, i.foto]);
  return { id: r.rows[0].id, substituiu: anterior?.id ?? null };
}

/** Revoga para usos futuros. Artes já geradas continuam na galeria até serem excluídas. */
export async function revogarAutorizacao(tx: DbExecutor, c: Pick<ConviteRef, 'id' | 'empresa_id'>, ator: string) {
  const r = await tx.query<{ id: string }>(`UPDATE convite_ia_autorizacoes SET revogada_em=clock_timestamp(),revogada_por=$3,revogacao_motivo='REVOGADA'
    WHERE convite_id=$1 AND empresa_id=$2 AND revogada_em IS NULL RETURNING id`, [c.id, c.empresa_id, ator]);
  return r.rows[0]?.id ?? null;
}

// Condição SQL usada no instante do envio: a autorização da reserva continua não revogada.
export const AUTORIZACAO_AINDA_VIGENTE = `EXISTS (SELECT 1 FROM convite_ia_autorizacoes a WHERE a.id=$2 AND a.convite_id=convite_geracoes.convite_id
  AND a.empresa_id=convite_geracoes.empresa_id AND a.revogada_em IS NULL)`;
