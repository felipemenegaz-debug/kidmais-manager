import type { ClassificadorAuxiliar, SugestaoRota } from "../extensoes.ts";
import { jevClassificacaoSchema, type JevClassification, type JevClassificador, type PedidoJev } from "./contrato.ts";
import { classificarLocal } from "./motor.ts";

/**
 * Proteção do JEV: qualquer motor (o local de hoje ou um modelo JEV futuro) passa por aqui.
 * - prazo: acima de `timeoutMs` a resposta é descartada (null) e quem chama segue sem JEV;
 * - schema fechado: saída fora do contrato (intent desconhecido, campo extra como id de empresa ou "executar")
 *   é descartada;
 * - erro/indisponível ⇒ null (fail-safe);
 * - trace mínimo: só tarefa, intent, prioridade, revisão humana, motivos, origem e duração — nunca o texto.
 */
export type MotorJev = (pedido: PedidoJev, sinal: AbortSignal) => unknown | Promise<unknown>;

export type RastroJev = {
  evento: "jev.classificacao";
  tarefa: PedidoJev["tarefa"];
  resultado: "OK" | "SCHEMA_INVALIDO" | "PRAZO" | "INDISPONIVEL";
  intent: string | null;
  priority: JevClassification["priority"] | null;
  needsHumanReview: boolean | null;
  reasonCodes: readonly string[];
  duracaoMs: number;
};

export type OpcoesJev = {
  motor?: MotorJev;
  timeoutMs?: number;
  registrar?: (rastro: RastroJev) => void;
  relogio?: () => number;
};

export const PRAZO_JEV_MS = 500;
const PRAZO = Symbol("prazo");

export function criarJev(opcoes: OpcoesJev = {}): JevClassificador {
  const motor: MotorJev = opcoes.motor ?? ((pedido) => classificarLocal(pedido));
  const prazo = opcoes.timeoutMs ?? PRAZO_JEV_MS;
  const relogio = opcoes.relogio ?? (() => performance.now());
  return {
    async classificar(pedido, sinalExterno) {
      const inicio = relogio();
      const controle = new AbortController();
      const repassar = () => controle.abort();
      sinalExterno?.addEventListener("abort", repassar, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let resultado: RastroJev["resultado"] = "OK";
      let classificacao: JevClassification | null = null;
      try {
        const esgotou = new Promise<typeof PRAZO>((ok) => { timer = setTimeout(() => { controle.abort(); ok(PRAZO); }, prazo); });
        const bruto = await Promise.race([Promise.resolve().then(() => motor(pedido, controle.signal)), esgotou]);
        if (bruto === PRAZO || controle.signal.aborted) {
          resultado = "PRAZO";
        } else {
          const lido = jevClassificacaoSchema.safeParse(bruto);
          if (lido.success && lido.data.tarefa === pedido.tarefa) classificacao = lido.data;
          else resultado = "SCHEMA_INVALIDO";
        }
      } catch {
        resultado = "INDISPONIVEL";
      } finally {
        clearTimeout(timer);
        sinalExterno?.removeEventListener("abort", repassar);
      }
      try {
        opcoes.registrar?.({
          evento: "jev.classificacao", tarefa: pedido.tarefa, resultado,
          intent: classificacao?.intent ?? null, priority: classificacao?.priority ?? null,
          needsHumanReview: classificacao?.needsHumanReview ?? null, reasonCodes: classificacao?.reasonCodes ?? [],
          duracaoMs: Math.max(0, Math.round(relogio() - inicio)),
        });
      } catch {
        // O trace nunca derruba a classificação.
      }
      return classificacao;
    },
  };
}

/**
 * Adaptador para o ponto de extensão do CORE: o JEV só SUGERE a rota. Capacidade sugerida sai do
 * resultado do JEV, mas a conversa ainda confere contra o catálogo permitido e a política.
 */
export function criarClassificadorAuxiliarJev(jev: JevClassificador): ClassificadorAuxiliar {
  return {
    async sugerirRota(texto, catalogo, sinal) {
      const c = await jev.classificar({ tarefa: "ROTEAMENTO", texto, catalogo }, sinal);
      if (!c) return null;
      const sugestao: SugestaoRota = c.intent === "HUMANO" ? { tipo: "HUMANO" }
        : c.intent === "LEITURA" && c.capacidade ? { tipo: "LEITURA", capacidade: c.capacidade }
          : c.intent === "LLM_ECONOMY" || c.intent === "LLM_STANDARD" ? { tipo: "LLM" }
            : { tipo: "NENHUMA" };
      return { sugestao, motivos: c.reasonCodes };
    },
  };
}
