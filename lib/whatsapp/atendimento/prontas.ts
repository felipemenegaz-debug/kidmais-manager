import { z } from 'zod';

/**
 * Mensagens prontas do atendimento (073). Biblioteca da EQUIPE: o atendente escolhe, revisa e envia.
 *
 * Tipos da fase A: TEXTO, LINK fixo (https) e LINK individual de fechamento. O link individual nunca é digitado:
 * é resolvido na hora do rascunho pelo fluxo autorizado do sistema (contratação aguardando a assinatura do cliente),
 * e só quando empresa, cliente e conversa formam um vínculo inequívoco (prontas-link.ts, só no servidor).
 * Fase B (074): IMAGEM e VIDEO por URL https pública da EMPRESA; o texto é a legenda. A mídia nunca vem da tela de
 * atendimento: no envio vão o id e a versão da mensagem pronta vistos na prévia; o servidor lê a URL do banco e recusa
 * se a pronta mudou depois (a mídia nunca é trocada em silêncio). Atalhos novos: salgados, bolos,
 * endereço e localização (texto/link; não há mensagem de localização nativa nesta entrega).
 * Wall-e (075): PDF; arquivo próprio enviado pela equipe (alternativa à URL externa); estados RASCUNHO / PUBLICADA /
 * ARQUIVADA; finalidade e vínculos opcionais com pacote e unidade; e a autorização EXPLÍCITA para o Wall-e enviar
 * sozinho. O Wall-e só usa conteúdo PUBLICADO com essa autorização; o resto continua sendo só da equipe.
 * Este módulo é usado também no navegador: nada de Node aqui.
 */
export const ATALHOS = ['TABELA_PRECOS', 'DISPONIBILIDADE_FECHAMENTO', 'SALGADOS', 'BOLOS', 'ENDERECO', 'LOCALIZACAO'] as const;
export type Atalho = (typeof ATALHOS)[number];
export const NOME_ATALHO: Record<Atalho, string> = { TABELA_PRECOS: 'Tabela de preços', DISPONIBILIDADE_FECHAMENTO: 'Disponibilidade / fechamento', SALGADOS: 'Salgados', BOLOS: 'Bolos', ENDERECO: 'Endereço', LOCALIZACAO: 'Localização' };
/** Atalhos que só existem com a 074 aplicada (sem ela o banco recusa; a tela os mostra como indisponíveis). */
export const ATALHOS_074: readonly Atalho[] = ['SALGADOS', 'BOLOS', 'ENDERECO', 'LOCALIZACAO'];
export const TIPOS = ['TEXTO', 'LINK', 'LINK_FECHAMENTO_INDIVIDUAL', 'IMAGEM', 'VIDEO', 'DOCUMENTO'] as const;
export type TipoPronta = (typeof TIPOS)[number];
/** Tipos que existiam antes da 075 (o PDF chega com a 075, só por arquivo próprio). */
export const TIPOS_074: readonly TipoPronta[] = TIPOS.filter((t) => t !== 'DOCUMENTO');
export const NOME_TIPO: Record<TipoPronta, string> = { TEXTO: 'Texto', LINK: 'Link', LINK_FECHAMENTO_INDIVIDUAL: 'Link individual de fechamento', IMAGEM: 'Foto', VIDEO: 'Vídeo', DOCUMENTO: 'PDF' };
/** Mídia que aceita URL externa (074). O PDF não: só arquivo próprio (075). */
export const TIPOS_MIDIA = ['IMAGEM', 'VIDEO'] as const;
export type TipoMidia = (typeof TIPOS_MIDIA)[number];
export const ehMidia = (tipo: TipoPronta): tipo is TipoMidia => tipo === 'IMAGEM' || tipo === 'VIDEO';
/** Anexo enviado pelo WhatsApp: foto, vídeo ou PDF. */
export type TipoAnexo = TipoMidia | 'DOCUMENTO';
export const ehAnexo = (tipo: TipoPronta): tipo is TipoAnexo => tipo === 'IMAGEM' || tipo === 'VIDEO' || tipo === 'DOCUMENTO';
export const NOME_ANEXO: Record<TipoAnexo, { nome: string; anexado: string }> = {
  IMAGEM: { nome: 'Foto', anexado: 'anexada' }, VIDEO: { nome: 'Vídeo', anexado: 'anexado' }, DOCUMENTO: { nome: 'PDF', anexado: 'anexado' },
};

/**
 * 075: estado da mensagem pronta. RASCUNHO não aparece para uso nem sai automaticamente; PUBLICADA é a versão vigente;
 * ARQUIVADA impede novos usos (o que já foi enviado continua no histórico). Arquivar é ação própria.
 */
export const ESTADOS_PRONTA = ['RASCUNHO', 'PUBLICADA', 'ARQUIVADA'] as const;
export type EstadoPronta = (typeof ESTADOS_PRONTA)[number];
export const NOME_ESTADO_PRONTA: Record<EstadoPronta, string> = { RASCUNHO: 'Rascunho', PUBLICADA: 'Publicada', ARQUIVADA: 'Arquivada' };
/** Finalidade: diz ao Wall-e para que serve o conteúdo (usado sozinho só com a autorização explícita). */
export const FINALIDADES = ['PRECOS', 'LOCALIZACAO', 'PACOTES', 'CARDAPIO', 'DECORACAO', 'CONTRATO', 'GERAL'] as const;
export type Finalidade = (typeof FINALIDADES)[number];
export const NOME_FINALIDADE: Record<Finalidade, string> = { PRECOS: 'Preços', LOCALIZACAO: 'Localização', PACOTES: 'Pacotes', CARDAPIO: 'Cardápio', DECORACAO: 'Decoração', CONTRATO: 'Contrato', GERAL: 'Geral' };

/**
 * Requisitos oficiais (Gupshup, mensagem de sessão; WhatsApp Cloud API, tipos de mídia), conferidos em 05/10/2026:
 * foto JPEG/PNG até 5 MB (8 bits, RGB/RGBA); vídeo MP4/3GPP, H.264 + AAC, até 16 MB (perfil Main/Baseline). A URL tem
 * de ser pública e https; endereço IP não vale. Tamanho e codec só o provedor confere (não baixamos a mídia).
 */
export const REQUISITO_MIDIA: Record<TipoMidia, string> = {
  IMAGEM: 'Foto JPEG ou PNG, até 5 MB, em link https público (.jpg, .jpeg ou .png).',
  VIDEO: 'Vídeo MP4 ou 3GP (H.264 com áudio AAC), até 16 MB, em link https público (.mp4 ou .3gp).',
};
const EXTENSOES: Record<TipoMidia, RegExp> = { IMAGEM: /\.(jpe?g|png)$/i, VIDEO: /\.(mp4|3gpp?)$/i };
/** Mesmo teto do campo de resposta do atendente (texto + link). */
export const LIMITE_RASCUNHO = 4000;
/** Legenda de foto/vídeo/PDF. Limite conservador (o da legenda não está explícito nas páginas oficiais conferidas). */
export const LIMITE_LEGENDA = 1024;
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

/**
 * URL de foto/vídeo: link seguro (https, sem usuário/senha) cujo host é um nome (não IP, exigência do provedor) e cujo
 * caminho termina na extensão do formato aceito. Devolve a URL normalizada ou null.
 */
export function midiaSegura(tipo: TipoMidia, valor: string) {
  const url = linkSeguro(valor);
  if (!url) return null;
  const u = new URL(url);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.startsWith('[')) return null;
  return EXTENSOES[tipo].test(u.pathname) ? url : null;
}

/**
 * Cadastro. Os campos da 075 têm padrão compatível com a 073/074 (publicada, sem envio automático, sem vínculos, sem
 * arquivo): um cadastro antigo continua válido e com o mesmo efeito.
 */
export const prontaEntradaSchema = z.object({
  id: z.uuid().optional(),
  versao: z.number().int().nonnegative().optional(),
  titulo: z.string().trim().min(2).max(80),
  categoria: z.string().trim().min(2).max(40),
  tipo: z.enum(TIPOS),
  texto: z.string().trim().min(1).max(LIMITE_RASCUNHO),
  link: z.string().trim().max(LIMITE_LINK).nullable(),
  midiaUrl: z.string().trim().max(LIMITE_LINK).nullable().default(null),
  atalho: z.enum(ATALHOS).nullable(),
  estado: z.enum(['RASCUNHO', 'PUBLICADA']).default('PUBLICADA'),
  envioAutomatico: z.boolean().default(false),
  finalidade: z.enum(FINALIDADES).nullable().default(null),
  pacoteCodigo: z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/).nullable().default(null),
  estabelecimentoId: z.uuid().nullable().default(null),
  arquivoId: z.uuid().nullable().default(null),
}).strict().superRefine((v, ctx) => {
  if (v.tipo === 'LINK') {
    const link = v.link ? linkSeguro(v.link) : null;
    if (!link) ctx.addIssue({ code: 'custom', path: ['link'], message: 'Informe um link https completo.' });
    else if (v.texto.length + 2 + link.length > LIMITE_RASCUNHO) ctx.addIssue({ code: 'custom', path: ['texto'], message: 'Texto e link passam do limite da resposta.' });
  } else if (v.link) ctx.addIssue({ code: 'custom', path: ['link'], message: v.tipo === 'TEXTO' ? 'Mensagem de texto não leva link.' : ehAnexo(v.tipo) ? 'Foto, vídeo e PDF não levam link no texto.' : 'O link individual vem do sistema; não digite o link.' });
  if (v.tipo === 'DOCUMENTO') {
    if (!v.arquivoId) ctx.addIssue({ code: 'custom', path: ['arquivoId'], message: 'Envie o arquivo PDF.' });
    if (v.midiaUrl) ctx.addIssue({ code: 'custom', path: ['midiaUrl'], message: 'PDF só por arquivo enviado aqui (não por link).' });
  } else if (ehMidia(v.tipo)) {
    if (v.arquivoId && v.midiaUrl) ctx.addIssue({ code: 'custom', path: ['midiaUrl'], message: 'Use o arquivo enviado ou o link, não os dois.' });
    else if (!v.arquivoId && (!v.midiaUrl || !midiaSegura(v.tipo, v.midiaUrl))) ctx.addIssue({ code: 'custom', path: ['midiaUrl'], message: `${REQUISITO_MIDIA[v.tipo]} Ou envie o arquivo aqui.` });
  } else {
    if (v.midiaUrl) ctx.addIssue({ code: 'custom', path: ['midiaUrl'], message: 'Só foto ou vídeo leva link de mídia.' });
    if (v.arquivoId) ctx.addIssue({ code: 'custom', path: ['arquivoId'], message: 'Só foto, vídeo ou PDF leva arquivo.' });
  }
  if (ehAnexo(v.tipo) && v.texto.length > LIMITE_LEGENDA) ctx.addIssue({ code: 'custom', path: ['texto'], message: `A legenda passa de ${LIMITE_LEGENDA} caracteres.` });
  if (v.envioAutomatico && !v.finalidade) ctx.addIssue({ code: 'custom', path: ['finalidade'], message: 'Escolha a finalidade para o Wall-e poder enviar sozinho.' });
  if (v.envioAutomatico && v.tipo === 'LINK_FECHAMENTO_INDIVIDUAL') ctx.addIssue({ code: 'custom', path: ['envioAutomatico'], message: 'O link individual só é enviado pela equipe.' });
});
export type ProntaEntrada = z.infer<typeof prontaEntradaSchema>;
/** Campos da 075 com valor diferente do padrão (sem a 075 o cadastro com eles é recusado com mensagem clara). */
export function usaRecursos075(p: ProntaEntrada) {
  return p.tipo === 'DOCUMENTO' || p.estado !== 'PUBLICADA' || p.envioAutomatico || p.finalidade !== null || p.pacoteCodigo !== null || p.estabelecimentoId !== null || p.arquivoId !== null;
}

/** Arquivo próprio de uma pronta (075), como a tela o vê: nome, tamanho e o caminho público para conferência. */
export type ArquivoPronta = { id: string; tipo: TipoAnexo; nome: string; tamanho: number; caminho: string };
export type Pronta = {
  id: string; titulo: string; categoria: string; tipo: TipoPronta; texto: string; link: string | null; midia_url: string | null; atalho: Atalho | null; versao: number; atualizada_em: string;
  /** 075; sem a 075 vêm com os padrões (publicada, sem envio automático, sem vínculos, sem arquivo). */
  estado?: EstadoPronta; envio_automatico?: boolean; finalidade?: Finalidade | null; pacote_codigo?: string | null; estabelecimento_id?: string | null; arquivo?: ArquivoPronta | null;
};

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
