import { createHash } from "node:crypto";
import { somarDias } from "./calculos.ts";

/**
 * Abertura de saldo (P2, plano rev. 3.2 C.2, C.2.1, C.2.2, D-FIN-9/10). Funções puras: o serviço lê o banco e chama estas.
 * Saldo absoluto só existe com abertura confirmada. Sem ela, ou antes de D0, o saldo é `null` com motivo, nunca zero.
 */

export type MotivoSemSaldo = "SEM_ABERTURA" | "ANTERIOR_A_ABERTURA" | "ATRAVESSA_ABERTURA";

export type AberturaVigente = {
  id: string;
  versao: number;
  /** D0: o saldo informado é o de imediatamente antes dos movimentos deste dia. */
  dataBase: string;
  saldoCentavos: number;
  /** Data de Brasília da confirmação desta revisão. A janela conferida vai de D0 até a véspera dela. */
  confirmadaEm: string;
};

export type TipoOrigemMovimento =
  | "RECEBIMENTO"
  | "ENTRADA_MANUAL"
  | "LIQUIDACAO_MANUAL"
  | "SAIDA"
  | "REVERSAO_SAIDA"
  | "ESTORNO"
  | "DEVOLUCAO";

/** Movimento efetivo de caixa, com origem tipada. `centavos` é positivo para entrada e negativo para saída. */
export type MovimentoCaixa = {
  tipo: TipoOrigemMovimento;
  origemId: string;
  data: string;
  centavos: number;
  taxaCentavos: number;
  estado: string;
  descricao: string;
  festaId: string | null;
  forma: string;
};

/**
 * Atributos que a conferência vê de cada movimento. Mudar qualquer um deles depois da conferência gera pendência de novo.
 * A mesma função é usada na confirmação (escritor) e na leitura: o texto é a definição, não mudar sem versionar.
 */
export function atributosMovimento(m: Pick<MovimentoCaixa, "tipo" | "origemId" | "data" | "centavos" | "taxaCentavos" | "estado">) {
  return createHash("sha256").update(`v1|${m.tipo}|${m.origemId}|${m.data}|${m.centavos}|${m.taxaCentavos}|${m.estado}`).digest("hex");
}

/** Resumo do conjunto conferido: ordem estável por tipo e origem, para que a prévia e a confirmação comparem igual. */
export function hashConjunto(movimentos: readonly MovimentoCaixa[]) {
  const linhas = movimentos.map((m) => `${m.tipo}:${m.origemId}:${atributosMovimento(m)}`).sort();
  return createHash("sha256").update(`v1\n${linhas.join("\n")}`).digest("hex");
}

export function chaveOrigem(m: Pick<MovimentoCaixa, "tipo" | "origemId">) {
  return `${m.tipo}:${m.origemId}`;
}

export type SaldoDoPeriodo = {
  saldoInicialCentavos: number | null;
  saldoFinalCentavos: number | null;
  motivoSaldo: MotivoSemSaldo | null;
  dataBase: string | null;
};

/**
 * Tabela de C.2.1. `somaEntre(de, ate)` soma os movimentos efetivos de `de` a `ate`, inclusive; com `de` > `ate` é zero.
 * | Sem abertura | null | null | SEM_ABERTURA |
 * | b < D0       | null | null | ANTERIOR_A_ABERTURA |
 * | a < D0 ≤ b   | null | abertura + [D0, b] | ATRAVESSA_ABERTURA |
 * | a = D0       | abertura | abertura + [D0, b] | — |
 * | a > D0       | abertura + [D0, a − 1] | inicial + [a, b] | — |
 */
export function saldoDoPeriodo(
  abertura: AberturaVigente | null,
  inicio: string,
  fim: string,
  somaEntre: (de: string, ate: string) => number,
): SaldoDoPeriodo {
  if (!abertura) return { saldoInicialCentavos: null, saldoFinalCentavos: null, motivoSaldo: "SEM_ABERTURA", dataBase: null };
  const d0 = abertura.dataBase;
  if (fim < d0) return { saldoInicialCentavos: null, saldoFinalCentavos: null, motivoSaldo: "ANTERIOR_A_ABERTURA", dataBase: d0 };
  if (inicio < d0) {
    return { saldoInicialCentavos: null, saldoFinalCentavos: abertura.saldoCentavos + somaEntre(d0, fim), motivoSaldo: "ATRAVESSA_ABERTURA", dataBase: d0 };
  }
  const inicial = abertura.saldoCentavos + (inicio > d0 ? somaEntre(d0, somarDias(inicio, -1)) : 0);
  return { saldoInicialCentavos: inicial, saldoFinalCentavos: inicial + somaEntre(inicio, fim), motivoSaldo: null, dataBase: d0 };
}

export type Pendencias = { quantidade: number; centavos: number; itens: MovimentoCaixa[] };

/**
 * C.2.2: movimento efetivo com data de D0 até a véspera da confirmação, cuja origem não está conferida na revisão vigente
 * ou cujos atributos mudaram desde a conferência. Com D0 = dia da confirmação, a janela é vazia.
 * `centavos` do aviso é a soma em módulo, porque o aviso diz quanto dinheiro está a conferir, não o efeito no saldo.
 */
export function pendenciasDaAbertura(
  abertura: AberturaVigente | null,
  movimentos: readonly MovimentoCaixa[],
  conferidos: ReadonlyMap<string, string>,
): Pendencias {
  if (!abertura) return { quantidade: 0, centavos: 0, itens: [] };
  const vespera = somarDias(abertura.confirmadaEm, -1);
  const itens = movimentos.filter((m) => m.data >= abertura.dataBase && m.data <= vespera
    && conferidos.get(chaveOrigem(m)) !== atributosMovimento(m));
  return { quantidade: itens.length, centavos: itens.reduce((total, m) => total + Math.abs(m.centavos), 0), itens };
}

export type LinhaConferencia = { origemTipo: string; origemId: string; atributosHash: string; sequencia: number };

/**
 * Histórico de conferências → chave `TIPO:id` → hash da conferência de maior sequência da origem. Não depende da ordem
 * das linhas: reconferir depois de H1 → H2 acrescenta a sequência seguinte, e é ela que vale.
 */
export function ultimaConferencia(linhas: readonly LinhaConferencia[]): Map<string, string> {
  const ultima = new Map<string, LinhaConferencia>();
  for (const linha of linhas) {
    const chave = `${linha.origemTipo}:${linha.origemId}`;
    const atual = ultima.get(chave);
    if (!atual || linha.sequencia > atual.sequencia) ultima.set(chave, linha);
  }
  return new Map([...ultima].map(([chave, linha]) => [chave, linha.atributosHash]));
}

/** Saldo de uma lista de movimentos entre duas datas, inclusive. */
export function somaMovimentos(movimentos: readonly MovimentoCaixa[], de: string, ate: string) {
  if (de > ate) return 0;
  return movimentos.reduce((total, m) => (m.data >= de && m.data <= ate ? total + m.centavos : total), 0);
}
