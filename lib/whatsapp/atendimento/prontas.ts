import { z } from 'zod';

/**
 * Mensagens prontas do atendimento (063). Biblioteca da EQUIPE: o atendente escolhe, revisa e envia.
 * Não são fontes da IA (as respostas publicadas ficam na configuração) nem automações: nada aqui sai sozinho.
 *
 * Tipos da fase A: TEXTO, LINK fixo (https) e LINK individual de fechamento. O link individual nunca é digitado:
 * é resolvido na hora do rascunho pelo fluxo autorizado do sistema (contratação aguardando a assinatura do cliente),
 * e só quando empresa, cliente e conversa formam um vínculo inequívoco (prontas-link.ts, só no servidor).
 * Este módulo é usado também no navegador: nada de Node aqui.
 */
export const ATALHOS = ['TABELA_PRECOS', 'DISPONIBILIDADE_FECHAMENTO'] as const;
export type Atalho = (typeof ATALHOS)[number];
export const NOME_ATALHO: Record<Atalho, string> = { TABELA_PRECOS: 'Tabela de preços', DISPONIBILIDADE_FECHAMENTO: 'Disponibilidade / fechamento' };
export const TIPOS = ['TEXTO', 'LINK', 'LINK_FECHAMENTO_INDIVIDUAL'] as const;
export type TipoPronta = (typeof TIPOS)[number];
export const NOME_TIPO: Record<TipoPronta, string> = { TEXTO: 'Texto', LINK: 'Link', LINK_FECHAMENTO_INDIVIDUAL: 'Link individual de fechamento' };
/** Mesmo teto do campo de resposta do atendente (texto + link). */
export const LIMITE_RASCUNHO = 4000;
const LIMITE_LINK = 2048;

/** Link fixo: só https, sem usuário/senha, sem espaços. Devolve a URL normalizada ou null. */
export function linkSeguro(valor: string) {
  if (/\s/.test(valor) || valor.length > LIMITE_LINK) return null;
  try {
    const u = new URL(valor);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch { return null; }
}

export const prontaEntradaSchema = z.object({
  id: z.uuid().optional(),
  versao: z.number().int().nonnegative().optional(),
  titulo: z.string().trim().min(2).max(80),
  categoria: z.string().trim().min(2).max(40),
  tipo: z.enum(TIPOS),
  texto: z.string().trim().min(1).max(LIMITE_RASCUNHO),
  link: z.string().trim().max(LIMITE_LINK).nullable(),
  atalho: z.enum(ATALHOS).nullable(),
}).strict().superRefine((v, ctx) => {
  if (v.tipo === 'LINK') {
    const link = v.link ? linkSeguro(v.link) : null;
    if (!link) ctx.addIssue({ code: 'custom', path: ['link'], message: 'Informe um link https completo.' });
    else if (v.texto.length + 2 + link.length > LIMITE_RASCUNHO) ctx.addIssue({ code: 'custom', path: ['texto'], message: 'Texto e link passam do limite da resposta.' });
  } else if (v.link) ctx.addIssue({ code: 'custom', path: ['link'], message: v.tipo === 'TEXTO' ? 'Mensagem de texto não leva link.' : 'O link individual vem do sistema; não digite o link.' });
});
export type ProntaEntrada = z.infer<typeof prontaEntradaSchema>;

export type Pronta = { id: string; titulo: string; categoria: string; tipo: TipoPronta; texto: string; link: string | null; atalho: Atalho | null; versao: number; atualizada_em: string };

/** Busca da biblioteca (no navegador): título, categoria e texto, sem acento e sem caixa. */
export function normalizarBusca(valor: string) { return valor.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim(); }
export function filtrarProntas(prontas: readonly Pronta[], filtro: { busca: string; categoria: string | null; favoritas: ReadonlySet<string> | null }) {
  const termos = normalizarBusca(filtro.busca).split(/\s+/).filter(Boolean);
  return prontas.filter(p => (!filtro.categoria || p.categoria === filtro.categoria) && (!filtro.favoritas || filtro.favoritas.has(p.id))
    && termos.every(t => normalizarBusca(`${p.titulo} ${p.categoria} ${p.texto}`).includes(t)));
}
export function categorias(prontas: readonly Pronta[]) { return [...new Set(prontas.map(p => p.categoria))].sort((a, b) => a.localeCompare(b, 'pt-BR')); }

/** Rascunho = texto revisável; o link (fixo ou resolvido) vai numa linha própria. Nunca é enviado aqui. */
export function comporRascunho(texto: string, link: string | null) { return link ? `${texto}\n\n${link}` : texto; }
