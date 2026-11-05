/**
 * Janelas fixas de 60 s com memória limitada, usadas pelos limitadores do canal MCP e das bordas OAuth.
 *
 * Revisão da rodada 2 (achado 1): o limite não pode ser reiniciado por quem é recusado.
 * - a decisão é tomada SEM alterar o mapa: um pedido recusado não cria nem zera janela;
 * - admite em TODAS as chaves ou em nenhuma;
 * - uma janela VIGENTE nunca é desalojada para abrir espaço; só janelas vencidas são varridas. Se mesmo assim não houver
 *   espaço, a decisão é RECUSAR (fail-closed), nunca esquecer um contador ativo (inclusive o global).
 */
export type Janela = { inicio: number; usados: number };

export const JANELA_MS = 60_000;

export class JanelasFixas {
  private readonly janelas = new Map<string, Janela>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  private vigente(chave: string, agora: number) {
    const j = this.janelas.get(chave);
    return j && agora - j.inicio < JANELA_MS ? j : null;
  }

  /** Remove só janelas vencidas; devolve o início da janela vigente mais antiga (para o Retry-After). */
  private varrer(agora: number) {
    let maisAntiga = agora;
    for (const [k, j] of this.janelas) {
      if (agora - j.inicio >= JANELA_MS) this.janelas.delete(k);
      else if (j.inicio < maisAntiga) maisAntiga = j.inicio;
    }
    return maisAntiga;
  }

  /** null ⇒ admitido (uma vaga consumida em cada chave). Número ⇒ recusado; segundos até poder tentar de novo. */
  admitir(chaves: ReadonlyArray<readonly [string, number]>, agora: number): number | null {
    const espera = (inicio: number) => Math.max(1, Math.ceil((inicio + JANELA_MS - agora) / 1000));
    for (const [chave, limite] of chaves) {
      const j = this.vigente(chave, agora);
      if (limite <= 0 || (j && j.usados >= limite)) return espera(j?.inicio ?? agora);
    }
    const novas = chaves.filter(([chave]) => !this.vigente(chave, agora)).length;
    if (this.janelas.size + novas > this.max) {
      const maisAntiga = this.varrer(agora);
      if (this.janelas.size + novas > this.max) return espera(maisAntiga);
    }
    for (const [chave] of chaves) {
      let j = this.vigente(chave, agora);
      if (!j) {
        j = { inicio: agora, usados: 0 };
        this.janelas.set(chave, j);
      }
      j.usados += 1;
    }
    return null;
  }

  /** Uso atual da chave (0 se não houver janela vigente). Só leitura. */
  usados(chave: string, agora: number) {
    return this.vigente(chave, agora)?.usados ?? 0;
  }

  tamanho() {
    return this.janelas.size;
  }
}
