/**
 * S-C: `convidados` das leituras públicas (disponibilidade e pacotes). Ausente = resposta de antes (undefined); presente
 * precisa ser inteiro de 1 a 1000, o mesmo limite da cotação (`cotacao/route.ts`); qualquer outra coisa = null (400).
 */
export const CONVIDADOS_CONSULTA_MAXIMO = 1000;

export function convidadosDaConsulta(valor: string | null): number | null | undefined {
  if (valor === null) return undefined;
  const texto = valor.trim();
  if (!/^\d{1,4}$/.test(texto)) return null;
  const n = Number(texto);
  return n >= 1 && n <= CONVIDADOS_CONSULTA_MAXIMO ? n : null;
}

/** S-C: o pacote comporta N quando mínimo ≤ N ≤ máximo; limite não cadastrado (null) fica aberto. */
export function pacoteComporta(pacote: { convidadosMinimos: number | null; convidadosMaximos: number | null }, convidados: number) {
  return (pacote.convidadosMinimos == null || convidados >= pacote.convidadosMinimos)
    && (pacote.convidadosMaximos == null || convidados <= pacote.convidadosMaximos);
}
