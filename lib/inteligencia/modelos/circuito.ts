import type { IdProvedor } from "../contratos.ts";

/**
 * Circuit breaker simples, por provedor e por processo.
 * Fechado → (N falhas seguidas) → aberto por `janelaMs` → meio-aberto (uma tentativa) → fechado ou aberto.
 */
export class Circuito {
  private readonly limite: number;
  private readonly janelaMs: number;
  private readonly estado = new Map<IdProvedor, { falhas: number; abertoAte: number; testando: boolean }>();

  constructor(limite = 3, janelaMs = 30_000) {
    this.limite = limite;
    this.janelaMs = janelaMs;
  }

  permite(provedor: IdProvedor, agora: number) {
    const atual = this.estado.get(provedor);
    if (!atual || atual.falhas < this.limite) return true;
    if (agora < atual.abertoAte) return false;
    if (atual.testando) return false;
    atual.testando = true;
    return true;
  }

  sucesso(provedor: IdProvedor) {
    this.estado.delete(provedor);
  }

  falha(provedor: IdProvedor, agora: number) {
    const atual = this.estado.get(provedor) ?? { falhas: 0, abertoAte: 0, testando: false };
    atual.falhas += 1;
    atual.testando = false;
    if (atual.falhas >= this.limite) atual.abertoAte = agora + this.janelaMs;
    this.estado.set(provedor, atual);
  }
}
