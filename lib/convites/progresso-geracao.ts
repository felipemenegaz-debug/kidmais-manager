// Progresso honesto da geração de arte: sem porcentagem. O único prazo conhecido é o do provedor
// (AbortSignal.timeout(120_000) em lib/convites/imagem.ts); depois dele o servidor confere o resultado.
export const LIMITE_PROVEDOR_SEGUNDOS = 120;

export type FaseGeracao = 'criando' | 'conferindo' | 'acompanhando';

/** segundos = null quando o início não é conhecido nesta tela (recarga, outra aba): só acompanha. */
export function faseGeracao(segundos: number | null): FaseGeracao {
  if (segundos === null) return 'acompanhando';
  return segundos >= LIMITE_PROVEDOR_SEGUNDOS ? 'conferindo' : 'criando';
}

export function formatarDuracao(segundos: number) {
  const s = Math.max(0, Math.floor(segundos));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const TEXTO_FASE: Record<FaseGeracao, string> = {
  criando: 'Criando a arte. O provedor tem até 2 minutos para responder; não é preciso clicar de novo.',
  conferindo: 'Passaram os 2 minutos do provedor. Estamos conferindo o resultado; não é preciso clicar de novo.',
  acompanhando: 'Acompanhando a geração em andamento; não é preciso clicar de novo.',
};
