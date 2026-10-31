import type { DbExecutor } from "../db/contracts.ts";

/**
 * Travas da pesquisa (plano rev. 4 M1, rev. 5 L1/L5). A pesquisa NUNCA espera por contrato ou fechamento: eles são
 * travados FOR SHARE NOWAIT; ocupados (55P03) → a transação inteira volta e é repetida do começo.
 *
 * Ordem no código novo:
 *   criação (motor) : linha da execução → trava por cliente → pais NOWAIT → INSERT do envio (o gatilho relê o fechamento NOWAIT)
 *   despacho (PS-2) : trava por cliente → cliente FOR SHARE → envio FOR UPDATE → entrega FOR UPDATE → pais NOWAIT
 *                     (a conclusão e a recuperação de posse seguem a mesma ordem, sem os pais)
 *   cadastro        : cliente FOR UPDATE / UPDATE → entregas (revogação, descadastro, edição): espera o despacho ou é esperado
 *   resposta        : envio FOR UPDATE → pais NOWAIT → resposta e entregas (sem a trava por cliente)
 *   saída           : envio FOR UPDATE → INSERT da saída (a FK pede KEY SHARE no cliente, compatível com o FOR SHARE do
 *                     despacho) → supressões; sem os pais e sem a trava por cliente
 * As duas entradas de cancelamento (operarContrato e o fluxo da Festa) travam fechamento → contrato com espera; como a
 * pesquisa não espera nos pais, não há ciclo.
 */
export const TENTATIVAS = 5;
export const ESPERAS_MS = [50, 100, 200, 400] as const;

export type Repeticao = { esperar?: (ms: number) => Promise<void>; aleatorio?: () => number; aoRepetir?: (tentativa: number, codigo: string) => void };

const esperarPadrao = (ms: number) => new Promise<void>((fim) => setTimeout(fim, ms));

export class TravaOcupada extends Error {
  readonly tentativas: number;
  constructor(tentativas: number) {
    super("Pais da pesquisa ocupados em todas as tentativas.");
    this.name = "TravaOcupada";
    this.tentativas = tentativas;
  }
}

function codigoPg(error: unknown) {
  const c = (error as { code?: unknown })?.code;
  return typeof c === "string" ? c : null;
}

/**
 * Executa `tentativa` (uma transação INTEIRA a cada chamada) até 5 vezes: 55P03 (pai ocupado) repete após 50/100/200/400 ms
 * com até +50% de variação; 40P01 (deadlock fora do inventário) repete uma única vez. Esgotado: TravaOcupada.
 */
export async function comRepeticao<T>(tentativa: (numero: number) => Promise<T>, opcoes: Repeticao = {}): Promise<T> {
  const esperar = opcoes.esperar ?? esperarPadrao;
  const aleatorio = opcoes.aleatorio ?? Math.random;
  let deadlocks = 0;
  for (let numero = 1; ; numero++) {
    try {
      return await tentativa(numero);
    } catch (error) {
      const codigo = codigoPg(error);
      const repetivel = codigo === "55P03" || (codigo === "40P01" && deadlocks++ === 0);
      if (!repetivel) throw error;
      if (numero >= TENTATIVAS) throw new TravaOcupada(numero);
      opcoes.aoRepetir?.(numero, codigo!);
      await esperar(Math.round(ESPERAS_MS[numero - 1] * (1 + 0.5 * aleatorio())));
    }
  }
}

export type SituacaoFesta = { valida: boolean; motivo: "FESTA_CANCELADA" | "CONTRATO_NAO_ASSINADO" | null };

/** Contratos do fechamento (ORDER BY id) e o fechamento, FOR SHARE NOWAIT. Devolve se a festa ainda vale a pesquisa. */
export async function travarPais(tx: DbExecutor, fechamentoId: string): Promise<SituacaoFesta> {
  const contratos = await tx.query<{ status: string }>(
    `/* satisfacao:travar-pais */ SELECT status FROM contratos WHERE fechamento_id = $1::uuid ORDER BY id FOR SHARE NOWAIT`, [fechamentoId]);
  const festa = await tx.query<{ status: string }>(
    `/* satisfacao:travar-pais */ SELECT status FROM fechamentos WHERE id = $1::uuid FOR SHARE NOWAIT`, [fechamentoId]);
  if (!festa.rows[0] || festa.rows[0].status === "CANCELADO") return { valida: false, motivo: "FESTA_CANCELADA" };
  if (!contratos.rows.some((c) => c.status === "ASSINADO")) return { valida: false, motivo: "CONTRATO_NAO_ASSINADO" };
  return { valida: true, motivo: null };
}
