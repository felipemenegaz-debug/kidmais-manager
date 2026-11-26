import { ENTRADA_SENSIVEL_OMITIDA, REGISTRO_SENSIVEL, apresentacaoComNome, dadoSensivel, normalizarParaPrivacidade, ocultarDadosPessoais, perguntaComDadoPessoal } from './core.ts';

export { perguntaComDadoPessoal };

/**
 * Fatia 7 (Wall-e): pergunta que nenhuma fonte respondeu vira sugestão de resposta aprovada. Funções puras, sem banco.
 *
 * Origem do texto: `passagem.ultimaMensagem` (082), que já é `trechoParaRegistro` (máscara aplicada, ou o marcador de
 * dado sensível). Aqui a máscara é aplicada DE NOVO (nunca se confia no que está gravado) e a mensagem sensível ou com
 * apresentação de nome (em qualquer caixa) é descartada inteira: não vira sugestão nem aparece na lista, só entra na
 * contagem `omitidasSensiveis`. Texto vazio, curto ou sem letras é só descartado (não é dado sensível).
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

/** Corte em até `limite` caracteres sem partir um marcador ("[telefone omitido]"): se cair dentro de um, recua até antes do colchete. */
function cortar(texto: string, limite: number) {
  if (texto.length <= limite) return texto;
  let fim = limite;
  const abre = texto.lastIndexOf('[', fim - 1);
  if (abre >= 0 && texto.indexOf(']', abre) >= fim) fim = abre;
  const corte = texto.slice(0, fim + 1);
  const espaco = corte.lastIndexOf(' ');
  return (espaco > limite / 2 && espaco <= fim ? corte.slice(0, espaco) : texto.slice(0, fim)).trim();
}

type Sugestao = { texto: string } | { omitida: 'sensivel' | 'descartada' };
function classificar(trecho: unknown): Sugestao {
  const bruto = typeof trecho === 'string' ? trecho : '';
  if (!bruto.trim()) return { omitida: 'descartada' };
  if (bruto.includes(REGISTRO_SENSIVEL) || bruto.includes(ENTRADA_SENSIVEL_OMITIDA) || dadoSensivel(bruto) || apresentacaoComNome(bruto)) return { omitida: 'sensivel' };
  // Máscara, uma linha, corte e máscara de novo (o corte não pode deixar à mostra parte de um dado que a máscara pegaria inteiro).
  const texto = cortar(ocultarDadosPessoais(cortar(ocultarDadosPessoais(bruto).replace(/\s+/gu, ' ').trim(), LIMITE_PERGUNTA)), LIMITE_PERGUNTA);
  return texto.length >= 3 && chaveDoGrupo(texto) ? { texto } : { omitida: 'descartada' };
}

/** Texto para pré-preencher a pergunta: mascarado, uma linha, até 250 caracteres; null quando não pode virar sugestão. */
export function perguntaSugerida(trecho: string | null | undefined): string | null {
  const s = classificar(trecho);
  return 'texto' in s ? s.texto : null;
}

/** Chave de agrupamento: minúsculas, sem acento, sem pontuação, espaços únicos. */
export function chaveDoGrupo(texto: string) {
  return normalizarParaPrivacidade(texto).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export type PassagemSemFonte = { ultimaMensagem: unknown; em: unknown };
export type GrupoSemFonte = { id: string; texto: string; ocorrencias: number; ultimaEm: string; jaPublicada: boolean; precisaRevisar: boolean };
export type AgrupamentoSemFonte = { grupos: GrupoSemFonte[]; omitidasSensiveis: number };

/**
 * Agrupador incremental: recebe as passagens em lotes (mais recentes primeiro) e só no fim ordena e aplica o limite de
 * grupos mostrados, para a frequência e a contagem de omitidas valerem para a janela inteira (Astra r1, P2).
 */
export function agrupadorSemFonte(perguntasPublicadas: string[], maximo = 20) {
  const publicadas = new Set(perguntasPublicadas.map(chaveDoGrupo));
  const grupos = new Map<string, GrupoSemFonte>();
  let omitidasSensiveis = 0;
  return {
    adicionar(passagens: PassagemSemFonte[]) {
      for (const p of passagens) {
        const s = classificar(p.ultimaMensagem);
        if (!('texto' in s)) { if (s.omitida === 'sensivel') omitidasSensiveis++; continue; }
        const { texto } = s;
        const chave = chaveDoGrupo(texto);
        const em = typeof p.em === 'string' ? p.em : '';
        const atual = grupos.get(chave);
        if (atual) { atual.ocorrencias++; if (em > atual.ultimaEm) { atual.ultimaEm = em; atual.texto = texto; atual.precisaRevisar = perguntaComDadoPessoal(texto); } continue; }
        grupos.set(chave, { id: idDoGrupo(chave), texto, ocorrencias: 1, ultimaEm: em, jaPublicada: publicadas.has(chave), precisaRevisar: perguntaComDadoPessoal(texto) });
      }
    },
    resultado(): AgrupamentoSemFonte {
      const ordenados = [...grupos.values()].sort((a, b) => Number(a.jaPublicada) - Number(b.jaPublicada) || b.ocorrencias - a.ocorrencias || b.ultimaEm.localeCompare(a.ultimaEm));
      return { grupos: ordenados.slice(0, maximo), omitidasSensiveis };
    },
  };
}

/** Agrupa as passagens (mais recentes primeiro) pela chave do texto mascarado; o texto mostrado é o da mais recente. */
export function agruparSemFonte(passagens: PassagemSemFonte[], perguntasPublicadas: string[], maximo = 20): AgrupamentoSemFonte {
  const a = agrupadorSemFonte(perguntasPublicadas, maximo);
  a.adicionar(passagens);
  return a.resultado();
}

/**
 * Estado de um grupo na tela (Astra r1, P3): "publicada" só quando a pergunta está na configuração SALVA mais recente e
 * continua no formulário; só no formulário é rascunho (falta escrever a resposta e salvar); fora dos dois, "criar".
 */
export function estadoDoGrupo(texto: string, perguntasPublicadas: string[], perguntasNoFormulario: string[]): 'publicada' | 'rascunho' | 'criar' {
  const chave = chaveDoGrupo(texto);
  const noFormulario = perguntasNoFormulario.some((p) => chaveDoGrupo(p) === chave);
  if (!noFormulario) return 'criar';
  return perguntasPublicadas.some((p) => chaveDoGrupo(p) === chave) ? 'publicada' : 'rascunho';
}
