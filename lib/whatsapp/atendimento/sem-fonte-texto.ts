import { ENTRADA_SENSIVEL_OMITIDA, REGISTRO_SENSIVEL, apresentacaoComNome, normalizarParaPrivacidade, ocultarDadosPessoais, perguntaComDadoPessoal, sensivelParaPublicar } from './core.ts';

export { perguntaComDadoPessoal };

/**
 * Fatia 7 (Wall-e): perguntas que nenhuma fonte respondeu, agrupadas para a pessoa responsável criar a resposta aprovada.
 * Funções puras, sem banco. Desenho novo (Felipe, depois do Astra r3): o texto do cliente é só para LEITURA na lista e
 * nunca é copiado para o formulário; a pessoa escreve a pergunta com as próprias palavras.
 *
 * Origem do texto: `passagem.ultimaMensagem` (082), que já é `trechoParaRegistro` (máscara aplicada, ou o marcador de
 * dado sensível). Aqui a máscara é aplicada DE NOVO (nunca se confia no que está gravado) e a mensagem sensível ou com
 * apresentação de nome (em qualquer caixa) é descartada inteira: não vira sugestão nem aparece na lista, só entra na
 * contagem `omitidasSensiveis`. Texto vazio, curto ou sem letras é só descartado (não é dado sensível).
 * A lista só aparece para REPRESENTANTE_AUTORIZADO da própria empresa, que já recebe a passagem com esse trecho; a
 * máscara aqui reduz o que fica à mostra, não é a barreira da publicação. Nada desta fatia grava texto do cliente: a
 * pergunta publicada é a que a pessoa escreveu, e o servidor ainda recusa marcador ou dado pessoal reconhecido
 * (`perguntaComDadoPessoal`, defesa adicional, não exaustiva).
 */
export const LIMITE_PERGUNTA = 250;
/** Identificador estável do grupo (não é segredo nem proteção): FNV-1a de 32 bits, sem node:crypto (a tela também usa este módulo). */
function idDoGrupo(chave: string) {
  let h = 0x811c9dc5;
  for (const c of chave) { h ^= c.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** Colchete aberto sem fechar no fim (marcador partido aqui ou já no limite de 500 do registro): corta antes dele (Astra r3, P3). */
function semMarcadorAberto(texto: string) {
  const abre = texto.lastIndexOf('[');
  return (abre >= 0 && texto.indexOf(']', abre) < 0 ? texto.slice(0, abre) : texto).trim();
}
/** Corte em até `limite` caracteres, recuando até o último espaço, sem partir um marcador ("[telefone omitido]"). */
function cortar(texto: string, limite: number) {
  if (texto.length <= limite) return semMarcadorAberto(texto);
  const espaco = texto.slice(0, limite + 1).lastIndexOf(' ');
  return semMarcadorAberto(espaco > limite / 2 ? texto.slice(0, espaco) : texto.slice(0, limite));
}

type Sugestao = { texto: string } | { omitida: 'sensivel' | 'descartada' };
function classificar(trecho: unknown): Sugestao {
  const bruto = typeof trecho === 'string' ? trecho : '';
  if (!bruto.trim()) return { omitida: 'descartada' };
  if (bruto.includes(REGISTRO_SENSIVEL) || bruto.includes(ENTRADA_SENSIVEL_OMITIDA) || sensivelParaPublicar(bruto) || apresentacaoComNome(bruto)) return { omitida: 'sensivel' };
  // Máscara, uma linha, corte e máscara de novo (o corte não pode deixar à mostra parte de um dado que a máscara pegaria inteiro).
  const texto = cortar(ocultarDadosPessoais(cortar(ocultarDadosPessoais(bruto).replace(/\s+/gu, ' ').trim(), LIMITE_PERGUNTA)), LIMITE_PERGUNTA);
  return texto.length >= 3 && chaveDoGrupo(texto) ? { texto } : { omitida: 'descartada' };
}

/** Texto mostrado na lista (só leitura): mascarado, uma linha, até 250 caracteres; null quando a mensagem fica de fora. */
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
      // Id único mesmo quando o hash de 32 bits coincide (Astra r4, P3): na colisão, sufixo pela ordem das chaves, que
      // não depende da frequência (o mesmo grupo mantém o id entre recargas com o mesmo conjunto).
      const porId = new Map<string, string[]>();
      for (const chave of grupos.keys()) porId.set(idDoGrupo(chave), [...(porId.get(idDoGrupo(chave)) ?? []), chave]);
      for (const [id, chaves] of porId) if (chaves.length > 1) chaves.sort().forEach((c, i) => { grupos.get(c)!.id = `${id}-${i + 1}`; });
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

export type PerguntaAprovada = { id: string; pergunta: string };
/** Mesma resposta salva: mesmo id e mesmo texto depois de tirar os espaços das pontas, como o schema do salvar (Astra r4, P3). */
export function mesmaPergunta(salva: PerguntaAprovada | undefined, formulario: PerguntaAprovada) {
  return !!salva && salva.id === formulario.id && salva.pergunta.trim() === formulario.pergunta.trim();
}
/**
 * Estado de um grupo na tela. Desenho novo (decisão de Felipe depois do Astra r3): "Criar resposta" NÃO copia o texto do
 * cliente; abre uma pergunta vazia ligada ao grupo (`vinculos`: id da resposta → id do grupo, só na memória da tela) e a
 * pessoa escreve a pergunta com as próprias palavras. Ligada e ainda não salva (ou salva com outro texto) → rascunho;
 * salva com o mesmo id e o mesmo texto e ainda no formulário → publicada. Sem vínculo (tela recarregada), vale a pergunta
 * salva com o mesmo texto do grupo, como antes. Removida do formulário → volta o botão.
 */
export function estadoDoGrupo(grupo: { id: string; texto: string }, salvas: PerguntaAprovada[], formulario: PerguntaAprovada[], vinculos: Record<string, string> = {}): 'publicada' | 'rascunho' | 'criar' {
  const ligadas = formulario.filter((p) => vinculos[p.id] === grupo.id);
  if (ligadas.length) return ligadas.some((p) => p.pergunta.trim() && salvas.some((s) => mesmaPergunta(s, p))) ? 'publicada' : 'rascunho';
  const chave = chaveDoGrupo(grupo.texto);
  const noFormulario = formulario.filter((p) => chaveDoGrupo(p.pergunta) === chave);
  if (!noFormulario.length) return 'criar';
  return noFormulario.some((p) => salvas.some((s) => s.id === p.id && chaveDoGrupo(s.pergunta) === chave)) ? 'publicada' : 'rascunho';
}
