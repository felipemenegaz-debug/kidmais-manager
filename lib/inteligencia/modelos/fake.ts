import type { IdProvedor, TierModelo } from "../contratos.ts";
import { ErroModelo, type AdaptadorProvedor, type PedidoModelo, type RespostaBruta } from "./tipos.ts";

/**
 * Provedor determinístico para testes. Nunca é montado a partir do ambiente (`criarAdaptadores`),
 * então não pode ser ligado por engano em staging ou produção.
 */
export type RoteiroFake = (pedido: PedidoModelo<unknown>, chamada: number) => RespostaBruta | ErroModelo | Promise<RespostaBruta | ErroModelo>;

export function criarProvedorFake(opcoes: {
  id?: IdProvedor;
  modelos?: Partial<Record<TierModelo, string>>;
  roteiro: RoteiroFake;
  disponivel?: boolean;
  imagens?: boolean;
}): AdaptadorProvedor & { chamadas: Array<PedidoModelo<unknown>> } {
  const chamadas: Array<PedidoModelo<unknown>> = [];
  const modelos = opcoes.modelos ?? { ECONOMY: "fake-economy", STANDARD: "fake-standard", ADVANCED: "fake-advanced" };
  return {
    id: opcoes.id ?? "FAKE",
    chamadas,
    modeloPara: (tier) => modelos[tier] ?? null,
    disponivel: () => opcoes.disponivel ?? true,
    aceitaImagens: () => opcoes.imagens ?? false,
    async gerar(pedido, modelo, sinal) {
      chamadas.push(pedido);
      const resultado = await opcoes.roteiro(pedido, chamadas.length);
      if (sinal.aborted) throw new ErroModelo("TIMEOUT", true);
      if (resultado instanceof ErroModelo) throw resultado;
      return { ...resultado, modelo: resultado.modelo || modelo };
    },
  };
}

export function respostaFake(texto: string, tokens: { entrada: number | null; saida: number | null } = { entrada: 100, saida: 20 }): RespostaBruta {
  return { texto, modelo: "", tokensEntrada: tokens.entrada, tokensSaida: tokens.saida, tokensCache: null };
}
