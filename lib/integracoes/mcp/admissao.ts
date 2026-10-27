/**
 * Admissão EM PROCESSO antes de recursos compartilhados (rodada 4 da revisão): quantos trabalhos do canal podem estar ao
 * mesmo tempo no banco, em busca CIMD ou lendo corpo. Recusa imediata quando cheio (nunca fila): quem chama responde
 * indisponível. A vaga só volta quando o trabalho REAL termina (não quando quem esperava desistiu), para que trabalho
 * abandonado também conte.
 */
export class Vagas {
  private emCurso = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  iniciar() {
    if (this.emCurso >= this.max) return false;
    this.emCurso += 1;
    return true;
  }

  terminar() {
    this.emCurso = Math.max(0, this.emCurso - 1);
  }

  quantas() {
    return this.emCurso;
  }

  /** Executa `trabalho` numa vaga; sem vaga, lança CanalOcupado sem começar. A vaga volta quando o trabalho termina. */
  async com<T>(trabalho: () => Promise<T>): Promise<T> {
    if (!this.iniciar()) throw new CanalOcupado();
    try {
      return await trabalho();
    } finally {
      this.terminar();
    }
  }
}

export class CanalOcupado extends Error {
  constructor() {
    super("Canal de assistentes ocupado; tente de novo em instantes.");
    this.name = "CanalOcupado";
  }
}

/** Prazo total de um pedido, propagado às etapas: nenhuma etapa COMEÇA sem tempo para terminar dentro dele. */
export class PrazoDoPedidoVencido extends Error {
  constructor() {
    super("Prazo total do pedido vencido; etapa não iniciada.");
    this.name = "PrazoDoPedidoVencido";
  }
}
