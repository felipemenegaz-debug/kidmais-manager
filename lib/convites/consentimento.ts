import { createHash } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { ConviteError, exigir } from './domain.ts';
import { conteudoCanonicoIA, conteudoCanonicoImagensIA, ehProvedorIA, textosAutorizacaoIA, VERSAO_TEXTOS_IA, type MeioAutorizacao, type OperadorIA, type ProvedorIA, type VinculoResponsavel } from './consentimento-textos.ts';

// Autorização específica do responsável legal para Convites com IA (migration 088, tabela convite_ia_autorizacoes).
// Regra do servidor: sem autorização vigente para o convite (festa/criança), o provedor atual e a versão atual dos
// textos, a geração é recusada antes de qualquer reserva ou envio. Fotografia e imagens da galeria exigem, além disso,
// a confirmação da geração (uso único), conferida em conferirImagens e registrada no evento IA_RESERVADA.
// Nenhuma função aqui registra em log o nome do responsável, o prompt ou imagens.

export type ConviteRef = { id: string; empresa_id: string; festa_id: string | null; cliente_id: string | null };
export type OperadorRef = { tipo: 'BUFFET'; usuarioId: string } | { tipo: 'CLIENTE'; clienteId: string };
export type AutorizacaoLinha = { id: string; provedor: string; texto_versao: string; texto_hash: string; operador_tipo: OperadorIA;
  responsavel_vinculo: VinculoResponsavel; meio: MeioAutorizacao; criado_em: Date | string };
export type NovaAutorizacao = { versao: string; provedor: string; textoHash: string; responsavelNome: string; vinculo: VinculoResponsavel;
  meio?: MeioAutorizacao; declaracao: true };
export type ConfirmacaoImagens = { versao: string; textoHash: string };

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const hashTextoIA = (provedor: ProvedorIA, operador: OperadorIA) => sha256(conteudoCanonicoIA(textosAutorizacaoIA(provedor, operador)));
export const hashImagensIA = (provedor: ProvedorIA, operador: OperadorIA) => sha256(conteudoCanonicoImagensIA(textosAutorizacaoIA(provedor, operador)));

/** Textos e hashes do texto atual para quem está na tela; o navegador devolve o hash do texto que exibiu. */
export function textosParaTela(provedor: ProvedorIA, operador: OperadorIA) {
  return { ...textosAutorizacaoIA(provedor, operador), hashes: { autorizacao: hashTextoIA(provedor, operador), imagens: hashImagensIA(provedor, operador) } };
}

// Sem a 088 (código publicado antes da migration): erro tratado, nunca 500 genérico (P3-1 da revisão de 15aa937).
export const MENSAGEM_088_AUSENTE = 'A geração com IA está indisponível até a atualização do banco. Você pode seguir sem IA.';
export function tabelaAusente(e: unknown) { return (e as { code?: unknown } | null)?.code === '42P01'; }
async function consulta<R extends object>(tx: DbExecutor, sql: string, v: unknown[]) {
  try { return await tx.query<R>(sql, v); }
  catch (e) { if (tabelaAusente(e)) throw new ConviteError(MENSAGEM_088_AUSENTE, 503); throw e; }
}

// A autorização só vale com o provedor que será chamado e com o texto exatamente na versão atual.
function valida(a: AutorizacaoLinha, provedor: ProvedorIA) {
  return a.provedor === provedor && a.texto_versao === VERSAO_TEXTOS_IA && ehProvedorIA(a.provedor)
    && a.texto_hash === hashTextoIA(a.provedor, a.operador_tipo);
}

const COLUNAS = 'id,provedor,texto_versao,texto_hash,operador_tipo,responsavel_vinculo,meio,criado_em';

/** Autorização não revogada do convite (qualquer versão), sempre filtrada pela empresa comprovada. */
async function naoRevogada(tx: DbExecutor, c: Pick<ConviteRef, 'id' | 'empresa_id'>, travar = false) {
  return (await consulta<AutorizacaoLinha>(tx, `SELECT ${COLUNAS} FROM convite_ia_autorizacoes
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
  return { vigente: { id: a.id, provedor: a.provedor, operador: a.operador_tipo, vinculo: a.responsavel_vinculo,
    meio: a.meio, registradaEm: new Date(a.criado_em).toISOString() }, precisaRenovar: false };
}

/**
 * Confirmação da fotografia e das imagens da galeria para UMA geração: texto da versão atual, do provedor atual e de
 * quem opera. Devolve o que entra no evento IA_RESERVADA (versão, hash do texto e sha-256 de cada imagem enviada).
 */
export function conferirImagens(provedor: ProvedorIA, operador: OperadorIA, confirmacao: ConfirmacaoImagens | undefined, imagens: Buffer[]) {
  if (!imagens.length) { exigir(confirmacao === undefined, 'A confirmação de imagens só vale quando há foto ou imagem da galeria selecionada.', 400); return null; }
  exigir(confirmacao, 'Confirme a autorização da fotografia e das imagens da galeria selecionadas para esta geração.', 403);
  exigir(confirmacao.versao === VERSAO_TEXTOS_IA && confirmacao.textoHash === hashImagensIA(provedor, operador),
    'O texto da autorização da fotografia mudou. Recarregue a página e confirme novamente.', 409);
  return { versao: VERSAO_TEXTOS_IA, textoHash: confirmacao.textoHash, sha256: imagens.map(b => sha256(b)) };
}

/**
 * Registra a autorização exibida para o provedor ATUAL. O texto aceito precisa ser o da versão atual, com o hash
 * calculado aqui; a anterior não revogada é encerrada como SUBSTITUIDA na mesma transação. As duas datas saem do mesmo
 * relógio (clock_timestamp), na ordem: revogação da anterior, depois criação da nova (P3-3 da revisão de 15aa937).
 */
export async function registrarAutorizacao(tx: DbExecutor, c: ConviteRef, operador: OperadorRef, ator: string, provedorAtual: ProvedorIA, i: NovaAutorizacao) {
  exigir(i.declaracao === true, 'Confirme a declaração do responsável legal.', 400);
  exigir(i.provedor === provedorAtual, 'O provedor de IA mudou. Leia o novo aviso e autorize novamente.', 409);
  exigir(i.versao === VERSAO_TEXTOS_IA, 'O texto da autorização foi atualizado. Leia o novo texto e autorize novamente.', 409);
  exigir(i.textoHash === hashTextoIA(provedorAtual, operador.tipo), 'O texto exibido não corresponde ao texto atual. Recarregue a página.', 409);
  const nome = i.responsavelNome.trim().replace(/\s+/g, ' ');
  exigir(nome.length >= 2 && nome.length <= 120, 'Informe o nome do responsável legal.', 400);
  // O responsável no link autoriza por si; o buffet informa como recebeu a autorização (sem padrão implícito).
  exigir(operador.tipo === 'BUFFET' || i.meio === undefined, 'O meio da autorização é informado somente pelo buffet.', 400);
  exigir(operador.tipo === 'CLIENTE' || (i.meio !== undefined && i.meio !== 'PROPRIO_RESPONSAVEL'), 'Informe como o responsável deu a autorização.', 400);
  const meio: MeioAutorizacao = operador.tipo === 'CLIENTE' ? 'PROPRIO_RESPONSAVEL' : i.meio!;
  const anterior = await naoRevogada(tx, c, true);
  if (anterior) await consulta(tx, `UPDATE convite_ia_autorizacoes SET revogada_em=clock_timestamp(),revogada_por=$3,revogacao_motivo='SUBSTITUIDA'
    WHERE id=$1 AND empresa_id=$2 AND revogada_em IS NULL`, [anterior.id, c.empresa_id, ator]);
  const r = await consulta<{ id: string; criado_em: Date }>(tx, `INSERT INTO convite_ia_autorizacoes(empresa_id,convite_id,festa_id,provedor,texto_versao,texto_hash,
      operador_tipo,operador_usuario_id,operador_cliente_id,responsavel_nome,responsavel_vinculo,meio,declaracao_responsavel,criado_em)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,clock_timestamp()) RETURNING id,criado_em`,
  [c.empresa_id, c.id, c.festa_id, provedorAtual, VERSAO_TEXTOS_IA, i.textoHash, operador.tipo,
    operador.tipo === 'BUFFET' ? operador.usuarioId : null, operador.tipo === 'CLIENTE' ? operador.clienteId : null, nome, i.vinculo, meio]);
  return { id: r.rows[0].id, substituiu: anterior?.id ?? null };
}

/** Revoga para usos futuros. Artes já geradas continuam na galeria até serem excluídas. */
export async function revogarAutorizacao(tx: DbExecutor, c: Pick<ConviteRef, 'id' | 'empresa_id'>, ator: string) {
  const r = await consulta<{ id: string }>(tx, `UPDATE convite_ia_autorizacoes SET revogada_em=clock_timestamp(),revogada_por=$3,revogacao_motivo='REVOGADA'
    WHERE convite_id=$1 AND empresa_id=$2 AND revogada_em IS NULL RETURNING id`, [c.id, c.empresa_id, ator]);
  return r.rows[0]?.id ?? null;
}

// Condição SQL usada no instante do envio: a autorização da reserva continua não revogada. Lida sem trava: uma revogação
// ainda não confirmada não interrompe um envio já em curso (P3-2, documentado como "usos futuros").
export const AUTORIZACAO_AINDA_VIGENTE = `EXISTS (SELECT 1 FROM convite_ia_autorizacoes a WHERE a.id=$2 AND a.convite_id=convite_geracoes.convite_id
  AND a.empresa_id=convite_geracoes.empresa_id AND a.revogada_em IS NULL)`;
