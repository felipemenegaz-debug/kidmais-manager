import type { IdProvedor, Workload } from "../contratos.ts";

/**
 * Chave do circuito (H2): provedor + modelo + workload. Falhas repetidas de um workload (ex.: CLASSIFICAR_INTENCAO do
 * JEV, tier ECONOMY) não abrem o circuito de outro (ex.: ANALISE_ADMINISTRATIVA do Copiloto, tier STANDARD), mesmo
 * com o mesmo provedor. Um provedor realmente fora do ar abre o circuito de cada workload que ele atende, por si só.
 */
export function chaveCircuito(provedor: IdProvedor, modelo: string, workload: Workload) {
  return `${provedor}:${modelo}:${workload}`;
}

/**
 * Circuit breaker simples, por chave (ver `chaveCircuito`) e por processo.
 * Fechado → (N falhas seguidas) → aberto por `janelaMs` → meio-aberto (uma tentativa) → fechado ou aberto.
 */
export class Circuito {
  private readonly limite: number;
  private readonly janelaMs: number;
  private readonly estado = new Map<string, { falhas: number; abertoAte: number; testando: boolean }>();

  constructor(limite = 3, janelaMs = 30_000) {
    this.limite = limite;
    this.janelaMs = janelaMs;
  }

  permite(chave: string, agora: number) {
    const atual = this.estado.get(chave);
    if (!atual || atual.falhas < this.limite) return true;
    if (agora < atual.abertoAte) return false;
    if (atual.testando) return false;
    atual.testando = true;
    return true;
  }

  sucesso(chave: string) {
    this.estado.delete(chave);
  }

  falha(chave: string, agora: number) {
    const atual = this.estado.get(chave) ?? { falhas: 0, abertoAte: 0, testando: false };
    atual.falhas += 1;
    atual.testando = false;
    if (atual.falhas >= this.limite) atual.abertoAte = agora + this.janelaMs;
    this.estado.set(chave, atual);
  }
}
