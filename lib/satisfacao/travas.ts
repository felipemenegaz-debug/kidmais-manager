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
 *
 * Protocolo da 114 (lib/agenda/trava-configuracao.ts): antes dos pais, "pais NOWAIT" toma a linha da empresa da festa em
 * FOR KEY SHARE NOWAIT e a configuração da agenda compartilhada por tentativa (pg_try_advisory_xact_lock_shared), nessa
 * ordem. A pesquisa chega a esse ponto já segurando a execução/cliente/envio, então também aqui ela NÃO espera: empresa
 * ocupada (a entrada administrativa a segura FOR UPDATE) ou configuração em mudança (exclusiva) = 55P03, e a transação
 * inteira volta como nos pais. Nada na pesquisa toma a empresa num modo mais forte nem a configuração exclusiva.
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

/** Erro com o código do PostgreSQL para "trava indisponível": comRepeticao e o motor o tratam como um 55P03 do banco. */
export class ConfiguracaoOcupada extends Error {
  readonly code = "55P03";
  constructor() {
    super("Configuração da agenda da empresa em mudança (55P03).");
    this.name = "ConfiguracaoOcupada";
  }
}

/**
 * Protocolo da 114 sem espera: empresa FOR KEY SHARE NOWAIT → configuração compartilhada por tentativa → variável da
 * transação. Devolve false quando a festa não existe (nada a travar).
 */
export async function travarConfiguracaoSemEspera(tx: DbExecutor, fechamentoId: string): Promise<boolean> {
  const empresa = (await tx.query<{ e: string }>(
    `/* satisfacao:empresa-da-festa */ SELECT empresa_id::text AS e FROM fechamentos WHERE id = $1::uuid`, [fechamentoId])).rows[0]?.e;
  if (!empresa) return false;
  await tx.query(`/* satisfacao:travar-empresa */ SELECT 1 FROM empresas WHERE id = $1::uuid FOR KEY SHARE NOWAIT`, [empresa]);
  const ok = (await tx.query<{ ok: boolean }>(
    `/* satisfacao:travar-configuracao */ SELECT pg_try_advisory_xact_lock_shared(hashtextextended('kidmais:agenda-config:' || $1::text, 0)) AS ok`,
    [empresa])).rows[0]?.ok === true;
  if (!ok) throw new ConfiguracaoOcupada();
  await tx.query(`SELECT set_config('kidmais.agenda_config_empresa', $1::text, true)`, [empresa]);
  return true;
}

/**
 * Configuração da agenda (protocolo da 114, sem espera), depois contratos do fechamento (ORDER BY id) e o fechamento,
 * FOR SHARE NOWAIT. Devolve se a festa ainda vale a pesquisa.
 */
export async function travarPais(tx: DbExecutor, fechamentoId: string): Promise<SituacaoFesta> {
  if (!(await travarConfiguracaoSemEspera(tx, fechamentoId))) return { valida: false, motivo: "FESTA_CANCELADA" };
  const contratos = await tx.query<{ status: string }>(
    `/* satisfacao:travar-pais */ SELECT status FROM contratos WHERE fechamento_id = $1::uuid ORDER BY id FOR SHARE NOWAIT`, [fechamentoId]);
  const festa = await tx.query<{ status: string }>(
    `/* satisfacao:travar-pais */ SELECT status FROM fechamentos WHERE id = $1::uuid FOR SHARE NOWAIT`, [fechamentoId]);
  if (!festa.rows[0] || festa.rows[0].status === "CANCELADO") return { valida: false, motivo: "FESTA_CANCELADA" };
  if (!contratos.rows.some((c) => c.status === "ASSINADO")) return { valida: false, motivo: "CONTRATO_NAO_ASSINADO" };
  return { valida: true, motivo: null };
}
