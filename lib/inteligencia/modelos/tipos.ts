import type { CausaModelo, DetalheErroProvedor, IdProvedor, TierModelo, Workload } from "../contratos.ts";

export type MensagemModelo = { papel: "system" | "user"; conteudo: string };

export type ImagemModelo = { mime: "image/png" | "image/jpeg"; base64: string };

/** PDF inteiro para provedor que lê arquivos (texto e imagem de cada página). `paginas` só estima o custo. */
export type ArquivoModelo = { mime: "application/pdf"; nome: string; base64: string; paginas: number };

/**
 * Pedido ao modelo. Não carrega DbExecutor, tenant, sessão, segredo nem ferramenta executável:
 * o modelo só pode devolver texto (JSON) que o chamador valida contra um schema fechado.
 */
export type PedidoModelo<T> = {
  workload: Workload;
  mensagens: MensagemModelo[];
  imagens?: ImagemModelo[];
  /** Exige provedor que aceita imagens (os mesmos que leem PDF). */
  arquivos?: ArquivoModelo[];
  esquema: { nome: string; schema: Record<string, unknown> };
  maxTokensSaida: number;
  /** Prazo deste pedido (ms), para leituras longas de documento. Sem ele vale AI_MODEL_TIMEOUT_MS. Teto de 180 s. */
  prazoMs?: number;
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
  /** `opcoes.tier`: tier do workload, para configuração por tier (ex.: esforço de raciocínio). Opcional. */
  gerar(pedido: PedidoModelo<unknown>, modelo: string, sinal: AbortSignal, opcoes?: { tier?: TierModelo }): Promise<RespostaBruta>;
}

/** Uso informado pelo provedor numa resposta que chegou mas não pôde ser aproveitada (H4). null ⇒ desconhecido. */
export type UsoInformado = { modelo: string; tokensEntrada: number | null; tokensSaida: number | null; tokensCache: number | null };

/**
 * Erro classificado. A mensagem é fixa e nunca contém corpo da resposta, chave ou prompt.
 * - `detalhe` (H3): status/type/code/param já SANEADOS pelo adaptador; nunca a mensagem do provedor.
 * - `uso` (H4): o provedor processou (tokens consumidos), mas a resposta é inaproveitável; é uso REAL, não zero.
 */
export class ErroModelo extends Error {
  readonly causa: CausaModelo;
  readonly tentavel: boolean;
  readonly detalhe: DetalheErroProvedor | null;
  readonly uso: UsoInformado | null;
  constructor(causa: CausaModelo, tentavel: boolean, extra: { detalhe?: DetalheErroProvedor | null; uso?: UsoInformado | null } = {}) {
    super(`Falha do provedor de IA: ${causa}`);
    this.name = "ErroModelo";
    this.causa = causa;
    this.tentavel = tentavel;
    this.detalhe = extra.detalhe ?? null;
    this.uso = extra.uso ?? null;
  }
}
