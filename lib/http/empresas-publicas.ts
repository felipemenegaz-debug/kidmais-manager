/**
 * Códigos de empresa pública já RESOLVIDOS (lib/comercial/cotacao-publica.ts → escopoCotacaoPublica), para o limite
 * público em memória contar pela empresa canônica e não pelo texto bruto de `?empresa=` (revisão de 22/10, P2-R3-1).
 *
 * Só entra aqui o código que o resolvedor aceitou (empresa ATIVA, com orçamento online), associado ao id da empresa.
 * Códigos inexistentes, inválidos ou ainda não vistos nunca criam entrada: o limitador os põe num balde comum próprio.
 * Capacidade fixa; ao encher, sai o menos recente (a entrada só escolhe o balde do limite, nunca libera acesso).
 */
const CAPACIDADE = 5_000;
const confirmadas = new Map<string, string>();

export function confirmarEmpresaPublica(codigo: string, empresaId: string) {
  confirmadas.delete(codigo);
  confirmadas.set(codigo, empresaId);
  if (confirmadas.size > CAPACIDADE) confirmadas.delete(confirmadas.keys().next().value as string);
}

/** Id da empresa quando o código já foi resolvido neste processo; senão null. */
export function empresaPublicaConfirmada(codigo: string | null): string | null {
  return codigo ? confirmadas.get(codigo) ?? null : null;
}

export const CAPACIDADE_EMPRESAS_CONFIRMADAS = CAPACIDADE;
