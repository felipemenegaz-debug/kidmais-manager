import type { Dia, Marcos } from "./marcos.ts";

/**
 * Guarda fase 3 (20/11/2026): plano do lote mensal da anonimização. CÁLCULO PURO, sem banco nem relógio: nada aqui apaga
 * ou altera dados. A simulação (lib/guarda/simulacao.ts) usa este plano para CONTAR o que cada lote alcançaria.
 *
 * Regra do DPA 2026-11-17 ("Fim dos prazos: anonimização") e do teste de calendário da PR #447 (lib/cadastro/cadastro.test.ts):
 *   - a aplicação é mensal, no dia 1º; o aviso à empresa sai no dia 1º do mês M para os prazos que vencem no mês M+2,
 *     eliminados no dia 1º de M+2 (aviso de 59 a 62 dias; antecipação de no máximo 30 dias, nunca depois do vencimento);
 *   - na PRIMEIRA aplicação de cada empresa, o mesmo aviso (dia 1º de M) também alcança os prazos já vencidos e os que
 *     vencem em M e M+1; cada um é eliminado no dia 1º do mês do vencimento ou 30 dias depois do aviso, o que for mais
 *     tarde (só esses podem sair depois do vencimento, exceção escrita no DPA);
 *   - nos dois casos, execução = max(1º dia do mês do vencimento, aviso + 30 dias). Para o mês M+2 o resultado é o dia 1º
 *     de M+2, então a mesma fórmula serve aos dois tipos de lote.
 * O aviso precisa ser num dia 1º: aviso em outro dia deixaria, no fim do mês, prazo de M+2 com execução depois do
 * vencimento (31/01 + 30 dias = 02/03).
 *
 * Medidas (cada prazo vale para a sua finalidade):
 *   - PARAR_CAMPANHA: venceu o contato para campanhas (5 anos sem festa nem contato, ou pedido de saída) e o contrato
 *     ainda está no prazo: os dados ficam só para o contrato;
 *   - ELIMINAR_SO_CONTRATO: venceu o contrato (5 anos) e o contato para campanhas ainda está no prazo: saem contrato,
 *     PDFs e o que só servia a ele; o contato fica para campanhas;
 *   - ANONIMIZAR_TUDO: venceu o último prazo que se aplica ao cliente (inclui o interessado que nunca contratou).
 * Exceções (DPA): valor em aberto ou disputa informada pela empresa preservam o contrato, os pagamentos e os dados de
 * identificação e contato que constam deles até o fim da cobrança ou da disputa; os demais dados seguem os prazos. Elas
 * não mudam PARAR_CAMPANHA (o contrato já fica).
 */

export type TipoLote = "PRIMEIRA" | "NORMAL";
export type Lote = {
  tipo: TipoLote;
  /** Dia do aviso (sempre dia 1º). */
  aviso: Dia;
  /** Primeiro vencimento alcançado (inclusive); null na primeira aplicação (alcança os já vencidos). */
  desde: Dia | null;
  /** Primeiro vencimento NÃO alcançado (exclusivo): dia 1º de M+3. */
  ate: Dia;
};
export type Medida = "PARAR_CAMPANHA" | "ELIMINAR_SO_CONTRATO" | "ANONIMIZAR_TUDO";
export type Excecao = "VALOR_EM_ABERTO" | "DISPUTA";
export type Prazo = "CONTRATO" | "CAMPANHAS" | "INTERESSADO";
export type ItemLote = { medida: Medida; prazo: Prazo; vencimento: Dia; execucao: Dia; excecoes: Excecao[] };
export type SituacaoCliente = { valorEmAberto: boolean; disputa: boolean };

export const MEDIDAS: readonly Medida[] = Object.freeze(["PARAR_CAMPANHA", "ELIMINAR_SO_CONTRATO", "ANONIMIZAR_TUDO"]);
const DIA_MS = 86_400_000;
const FORMATO = /^(\d{4})-(\d{2})-(\d{2})$/;

function partes(d: Dia): [number, number, number] {
  const m = FORMATO.exec(d);
  if (!m) throw new Error(`data inválida: ${d}`);
  const [a, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(a, mes - 1, dia));
  if (t.getUTCFullYear() !== a || t.getUTCMonth() !== mes - 1 || t.getUTCDate() !== dia) throw new Error(`data inválida: ${d}`);
  return [a, mes, dia];
}
const paraDia = (t: number): Dia => new Date(t).toISOString().slice(0, 10);
const tempo = (d: Dia) => { const [a, m, di] = partes(d); return Date.UTC(a, m - 1, di); };

export function somarDias(d: Dia, dias: number): Dia { return paraDia(tempo(d) + dias * DIA_MS); }
export function primeiroDoMes(d: Dia): Dia { const [a, m] = partes(d); return paraDia(Date.UTC(a, m - 1, 1)); }
export function somarMeses(d: Dia, meses: number): Dia { const [a, m] = partes(d); return paraDia(Date.UTC(a, m - 1 + meses, 1)); }
/** Dia 1º do mês seguinte ao dia dado (ou o próprio dia, se já for dia 1º). */
export function proximoDiaPrimeiro(d: Dia): Dia { return partes(d)[2] === 1 ? d : somarMeses(d, 1); }

/** Lote cujo aviso sai em `aviso` (dia 1º do mês M). */
export function montarLote(tipo: TipoLote, aviso: Dia): Lote {
  if (partes(aviso)[2] !== 1) throw new Error(`o aviso do lote é sempre no dia 1º: ${aviso}`);
  return { tipo, aviso, desde: tipo === "PRIMEIRA" ? null : somarMeses(aviso, 2), ate: somarMeses(aviso, 3) };
}

/** Dia da eliminação de um prazo que vence em `vencimento`, para o aviso dado: max(1º do mês do vencimento, aviso + 30). */
export function execucaoDoPrazo(aviso: Dia, vencimento: Dia): Dia {
  const a = primeiroDoMes(vencimento);
  const b = somarDias(aviso, 30);
  return a >= b ? a : b;
}

export function alcanca(lote: Lote, vencimento: Dia): boolean {
  partes(vencimento);
  return vencimento < lote.ate && (lote.desde === null || vencimento >= lote.desde);
}

/**
 * Itens do lote para UM cliente (sem dados pessoais: só prazos, datas e medidas). Um item por prazo alcançado; o prazo
 * que vence por último (todosVencidosEm) vira ANONIMIZAR_TUDO e absorve item parcial com a mesma execução.
 */
export function itensDoCliente(m: Marcos, lote: Lote, situacao: SituacaoCliente): ItemLote[] {
  const excecoes: Excecao[] = [];
  if (situacao.valorEmAberto) excecoes.push("VALOR_EM_ABERTO");
  if (situacao.disputa) excecoes.push("DISPUTA");
  const prazos: { prazo: Prazo; data: Dia }[] = [];
  if (m.contrato) prazos.push({ prazo: "CONTRATO", data: m.contrato.data });
  if (m.campanhas) prazos.push({ prazo: "CAMPANHAS", data: m.campanhas.data });
  if (m.interessado) prazos.push({ prazo: "INTERESSADO", data: m.interessado.data });

  const itens: ItemLote[] = [];
  let tudo: ItemLote | null = null;
  for (const p of prazos) {
    if (!alcanca(lote, p.data)) continue;
    const execucao = execucaoDoPrazo(lote.aviso, p.data);
    if (p.data === m.todosVencidosEm) {
      // Último prazo do cliente: anonimiza tudo (um item só, mesmo que dois prazos vençam no mesmo dia).
      if (!tudo) { tudo = { medida: "ANONIMIZAR_TUDO", prazo: p.prazo, vencimento: p.data, execucao, excecoes: [...excecoes] }; itens.push(tudo); }
      continue;
    }
    const medida: Medida = p.prazo === "CAMPANHAS" ? "PARAR_CAMPANHA" : "ELIMINAR_SO_CONTRATO";
    itens.push({ medida, prazo: p.prazo, vencimento: p.data, execucao, excecoes: medida === "PARAR_CAMPANHA" ? [] : [...excecoes] });
  }
  // Item parcial que sairia no mesmo dia da anonimização completa não acrescenta nada.
  return tudo ? itens.filter((i) => i === tudo || i.execucao < tudo.execucao) : itens;
}
