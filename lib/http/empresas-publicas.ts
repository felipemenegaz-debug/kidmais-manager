/**
 * Códigos de empresa pública → id da empresa, para o limite público em memória contar pela empresa canônica e não pelo
 * texto bruto de `?empresa=` (revisões de 22–23/10: P2-R3-1 e P2-R4-1).
 *
 * Duas fontes, as duas do servidor:
 *   - o resolvedor (lib/comercial/cotacao-publica.ts → escopoCotacaoPublica) confirma cada código que aceitar;
 *   - uma CARGA de todos os códigos de empresas ATIVAS numa consulta só, feita no primeiro uso e sempre que aparece um
 *     código ainda desconhecido — no máximo uma carga a cada INTERVALO_CARGA_MS, com uma carga em curso compartilhada.
 * Assim, depois de reinício ou de saída do registro, uma empresa legítima é reconhecida antes de ser cobrada como
 * desconhecida, e uma enxurrada de códigos inventados custa no máximo uma consulta por intervalo (nenhuma por código).
 * Capacidade fixa; nada aqui libera acesso: a entrada só escolhe o balde do limite.
 */
export const CODIGO_EMPRESA_PUBLICA = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

const CAPACIDADE = 20_000;
export const INTERVALO_CARGA_MS = 30_000;
const confirmadas = new Map<string, string>();
let ultimaCarga = Number.NEGATIVE_INFINITY;
let cargaEmCurso: Promise<void> | null = null;

export type CarregarEmpresasAtivas = (limite: number) => Promise<Array<{ codigo: string; id: string }>>;

export function confirmarEmpresaPublica(codigo: string, empresaId: string) {
  confirmadas.delete(codigo);
  confirmadas.set(codigo, empresaId);
  if (confirmadas.size > CAPACIDADE) confirmadas.delete(confirmadas.keys().next().value as string);
}

/** Id da empresa quando o código já está no registro deste processo; senão null (sem consultar nada). */
export function empresaPublicaConfirmada(codigo: string | null): string | null {
  return codigo ? confirmadas.get(codigo) ?? null : null;
}

function carregar(carregarAtivas: CarregarEmpresasAtivas, agora: number) {
  if (!cargaEmCurso && agora - ultimaCarga >= INTERVALO_CARGA_MS) {
    ultimaCarga = agora;
    cargaEmCurso = carregarAtivas(CAPACIDADE)
      .then((linhas) => { for (const { codigo, id } of linhas) if (CODIGO_EMPRESA_PUBLICA.test(codigo)) confirmarEmpresaPublica(codigo, id); })
      .catch(() => undefined) // banco indisponível: o código segue desconhecido; a rota recusa do mesmo jeito
      .finally(() => { cargaEmCurso = null; });
  }
  return cargaEmCurso;
}

/**
 * Id da empresa ATIVA dona do código, ou null. Formato inválido: null sem consulta. Fora do registro: espera a carga
 * em curso ou dispara uma, se o intervalo permitir; senão, null (o código conta como desconhecido até a próxima carga).
 */
export async function idDaEmpresaPublica(codigo: string, carregarAtivas: CarregarEmpresasAtivas, agora = Date.now()): Promise<string | null> {
  if (!CODIGO_EMPRESA_PUBLICA.test(codigo)) return null;
  const conhecido = confirmadas.get(codigo);
  if (conhecido) return conhecido;
  await carregar(carregarAtivas, agora);
  return confirmadas.get(codigo) ?? null;
}

export const CAPACIDADE_EMPRESAS_CONFIRMADAS = CAPACIDADE;
