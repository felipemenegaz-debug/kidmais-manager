/**
 * Gerações de leitura das telas da Satisfação (PS-4 R3; correção PS4-C1). Cada transição de consulta — trocar filtro,
 * unidade, período ou estado, VOLTAR a um filtro anterior, "Tentar novamente" ou recarregar depois de concluir — abre
 * uma geração NOVA com número estritamente maior (A → B → A são três gerações). Toda resposta (página 1, "Ver mais",
 * erro ou recusa) carrega o número da geração que a pediu e só é aplicada se ela ainda é a vigente; o resto é descartado.
 * Funções puras (sem React), para a prova determinística da corrida.
 */
export type FalhaLeitura = { status: number; codigo: string | null; mensagem: string };
export type RespostaLeitura<T> = { ok: true; data: T } | { ok: false; falha: FalhaLeitura };
export type Geracao<T> = { n: number; base: string; paginas: T[]; falha: FalhaLeitura | null; carregada: boolean; anexando: boolean };

export const inicial = <T>(base: string): Geracao<T> => ({ n: 0, base, paginas: [], falha: null, carregada: false, anexando: false });

/** Nova geração para `base` (pode ser a mesma URL: "Tentar novamente"/recarregar). Nada da anterior é levado. */
export const nova = <T>(atual: Geracao<T>, base: string): Geracao<T> => ({ ...inicial<T>(base), n: atual.n + 1 });

/** Resultado da página 1 da geração `n`. */
export function primeira<T>(atual: Geracao<T>, n: number, r: RespostaLeitura<T>): Geracao<T> {
  if (atual.n !== n) return atual;
  return r.ok ? { ...atual, paginas: [r.data], falha: null, carregada: true } : { ...atual, paginas: [], falha: r.falha, carregada: true };
}

/** Início de um "Ver mais" da geração `n` (só na vigente e já carregada sem falha). */
export function anexar<T>(atual: Geracao<T>, n: number): Geracao<T> {
  return atual.n === n && atual.carregada && !atual.falha ? { ...atual, anexando: true } : atual;
}

/** Resultado de um "Ver mais" da geração `n`: anexa a página, ou — recusa/erro — SUBSTITUI tudo (nenhum dado anterior fica). */
export function anexada<T>(atual: Geracao<T>, n: number, r: RespostaLeitura<T>): Geracao<T> {
  if (atual.n !== n) return atual;
  return r.ok ? { ...atual, paginas: [...atual.paginas, r.data], anexando: false } : { ...atual, paginas: [], falha: r.falha, anexando: false };
}

/** Falha recuperável (rede, 5xx exceto indisponível): a tela oferece "Tentar novamente". Recusas (400/403/404) e 503 não. */
export const podeRepetir = (f: FalhaLeitura) => f.status === 0 || (f.status >= 500 && f.status !== 503);
