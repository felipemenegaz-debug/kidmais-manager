import { ENTRADA_SENSIVEL_OMITIDA, REGISTRO_SENSIVEL, dadoSensivel, normalizarParaPrivacidade, ocultarDadosPessoais, perguntaComDadoPessoal } from './core.ts';

export { perguntaComDadoPessoal };

/**
 * Fatia 7 (Wall-e): pergunta que nenhuma fonte respondeu vira sugestão de resposta aprovada. Funções puras, sem banco.
 *
 * Origem do texto: `passagem.ultimaMensagem` (082), que já é `trechoParaRegistro` (máscara aplicada, ou o marcador de
 * dado sensível). Aqui a máscara é aplicada DE NOVO (nunca se confia no que está gravado) e a mensagem sensível é
 * descartada inteira: ela não vira sugestão nem aparece na lista, só entra na contagem `omitidasSensiveis`.
 * Nada desta fatia grava texto do cliente: a pergunta só é guardada quando a pessoa responsável salva a configuração
 * pelo caminho que já existia, depois de revisar o texto (e o servidor recusa marcador ou dado pessoal: `perguntaComDadoPessoal`).
 */
export const LIMITE_PERGUNTA = 250;
/** Identificador estável do grupo (não é segredo nem proteção): FNV-1a de 32 bits, sem node:crypto (a tela também usa este módulo). */
function idDoGrupo(chave: string) {
  let h = 0x811c9dc5;
  for (const c of chave) { h ^= c.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** Texto para pré-preencher a pergunta: mascarado, uma linha, até 250 caracteres; null quando não pode virar sugestão. */
export function perguntaSugerida(trecho: string | null | undefined): string | null {
  const bruto = String(trecho ?? '');
  if (!bruto.trim() || bruto.includes(REGISTRO_SENSIVEL) || bruto.includes(ENTRADA_SENSIVEL_OMITIDA) || dadoSensivel(bruto)) return null;
  let texto = ocultarDadosPessoais(bruto).replace(/\s+/gu, ' ').trim();
  if (texto.length > LIMITE_PERGUNTA) {
    const corte = texto.slice(0, LIMITE_PERGUNTA + 1);
    const espaco = corte.lastIndexOf(' ');
    texto = (espaco > LIMITE_PERGUNTA / 2 ? corte.slice(0, espaco) : corte.slice(0, LIMITE_PERGUNTA)).trim();
  }
  // A máscara de novo depois do corte: o corte não pode deixar à mostra parte de um dado que a máscara pegaria inteiro.
  texto = ocultarDadosPessoais(texto).slice(0, LIMITE_PERGUNTA).trim();
  return texto.length >= 3 ? texto : null;
}

/** Chave de agrupamento: minúsculas, sem acento, sem pontuação, espaços únicos. */
export function chaveDoGrupo(texto: string) {
  return normalizarParaPrivacidade(texto).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export type PassagemSemFonte = { ultimaMensagem: unknown; em: unknown };
export type GrupoSemFonte = { id: string; texto: string; ocorrencias: number; ultimaEm: string; jaPublicada: boolean; precisaRevisar: boolean };
export type AgrupamentoSemFonte = { grupos: GrupoSemFonte[]; omitidasSensiveis: number };

/** Agrupa as passagens (mais recentes primeiro) pela chave do texto mascarado; o texto mostrado é o da mais recente. */
export function agruparSemFonte(passagens: PassagemSemFonte[], perguntasPublicadas: string[], maximo = 20): AgrupamentoSemFonte {
  const publicadas = new Set(perguntasPublicadas.map(chaveDoGrupo));
  const grupos = new Map<string, GrupoSemFonte>();
  let omitidasSensiveis = 0;
  for (const p of passagens) {
    const texto = perguntaSugerida(typeof p.ultimaMensagem === 'string' ? p.ultimaMensagem : null);
    if (!texto) { omitidasSensiveis++; continue; }
    const chave = chaveDoGrupo(texto);
    if (!chave) { omitidasSensiveis++; continue; }
    const em = typeof p.em === 'string' ? p.em : '';
    const atual = grupos.get(chave);
    if (atual) { atual.ocorrencias++; if (em > atual.ultimaEm) { atual.ultimaEm = em; atual.texto = texto; atual.precisaRevisar = perguntaComDadoPessoal(texto); } continue; }
    grupos.set(chave, {
      id: idDoGrupo(chave), texto, ocorrencias: 1, ultimaEm: em,
      jaPublicada: publicadas.has(chave), precisaRevisar: perguntaComDadoPessoal(texto),
    });
  }
  const ordenados = [...grupos.values()].sort((a, b) => Number(a.jaPublicada) - Number(b.jaPublicada) || b.ocorrencias - a.ocorrencias || b.ultimaEm.localeCompare(a.ultimaEm));
  return { grupos: ordenados.slice(0, maximo), omitidasSensiveis };
}
