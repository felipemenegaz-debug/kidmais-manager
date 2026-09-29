import type { CausaModelo, IdProvedor, TierModelo, Workload } from "../contratos.ts";

export type MensagemModelo = { papel: "system" | "user"; conteudo: string };

export type ImagemModelo = { mime: "image/png" | "image/jpeg"; base64: string };

/**
 * Pedido ao modelo. Não carrega DbExecutor, tenant, sessão, segredo nem ferramenta executável:
 * o modelo só pode devolver texto (JSON) que o chamador valida contra um schema fechado.
 */
export type PedidoModelo<T> = {
  workload: Workload;
  mensagens: MensagemModelo[];
  imagens?: ImagemModelo[];
  esquema: { nome: string; schema: Record<string, unknown> };
  maxTokensSaida: number;
  /** Validação determinística da saída. Lança se inválida; o roteador trata como RESPOSTA_INVALIDA. */
  validar(texto: string): T;
};

export type RespostaBruta = {
  texto: string;
  modelo: string;
  /** null quando o provedor não informou `usage`: uso desconhecido, nunca zero. */
  tokensEntrada: number | null;
  tokensSaida: number | null;
  tokensCache: number | null;
};

export type Buscador = (url: string, init: RequestInit) => Promise<Response>;

export interface AdaptadorProvedor {
  readonly id: IdProvedor;
  /** Modelo configurado para o tier, ou null. Nenhum nome de modelo é inventado no código. */
  modeloPara(tier: TierModelo): string | null;
  /** Sem chave ⇒ indisponível de forma segura. */
  disponivel(): boolean;
  aceitaImagens(): boolean;
  gerar(pedido: PedidoModelo<unknown>, modelo: string, sinal: AbortSignal): Promise<RespostaBruta>;
}

/** Erro classificado. A mensagem é fixa e nunca contém corpo da resposta, chave ou prompt. */
export class ErroModelo extends Error {
  readonly causa: CausaModelo;
  readonly tentavel: boolean;
  constructor(causa: CausaModelo, tentavel: boolean) {
    super(`Falha do provedor de IA: ${causa}`);
    this.name = "ErroModelo";
    this.causa = causa;
    this.tentavel = tentavel;
  }
}
