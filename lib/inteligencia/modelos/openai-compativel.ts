import type { DetalheErroProvedor, IdProvedor, TierModelo } from "../contratos.ts";
import type { Ambiente } from "../flags.ts";
import { ErroModelo, type AdaptadorProvedor, type Buscador, type PedidoModelo, type RespostaBruta } from "./tipos.ts";

/**
 * Adaptador para APIs no formato Chat Completions (OpenAI e DeepSeek).
 *
 * - A chave vem só do ambiente, nunca do código, e nunca é registrada nem devolvida.
 * - Sem chave, ou sem modelo configurado para o tier, o provedor fica indisponível.
 * - Nenhuma ferramenta (function calling) é enviada: o modelo só devolve JSON, validado pelo chamador.
 * - Esforço de raciocínio (`reasoning_effort`), quando o perfil o suporta, é CONFIGURADO por tier
 *   (`AI_OPENAI_REASONING_EFFORT_<TIER>`); ausente ou fora da lista oficial ⇒ não é enviado (vale o padrão do modelo).
 * - Recusa HTTP (H3): só status + `error.type`/`error.code`/`error.param` saneados; nunca mensagem ou corpo.
 * - Resposta 200 sem conteúdo aproveitável (H4): o `usage` informado é lido ANTES de recusar; uso real nunca vira 0.
 */
type Perfil = {
  id: IdProvedor;
  variavelChave: string;
  variavelBase: string;
  baseUrlPadrao: string;
  prefixoModelo: string;
  /** Prefixo da variável de esforço de raciocínio por tier; null quando o provedor não tem o parâmetro. */
  prefixoEsforco: string | null;
  /** OpenAI aceita json_schema estrito; DeepSeek só json_object. */
  formato: "json_schema" | "json_object";
  campoMaxTokens: "max_completion_tokens" | "max_tokens";
  imagens: boolean;
};

export const PERFIL_OPENAI: Perfil = {
  id: "OPENAI",
  variavelChave: "OPENAI_API_KEY",
  variavelBase: "AI_OPENAI_BASE_URL",
  baseUrlPadrao: "https://api.openai.com/v1",
  prefixoModelo: "AI_OPENAI_MODEL_",
  prefixoEsforco: "AI_OPENAI_REASONING_EFFORT_",
  formato: "json_schema",
  campoMaxTokens: "max_completion_tokens",
  imagens: true,
};

export const PERFIL_DEEPSEEK: Perfil = {
  id: "DEEPSEEK",
  variavelChave: "DEEPSEEK_API_KEY",
  variavelBase: "AI_DEEPSEEK_BASE_URL",
  baseUrlPadrao: "https://api.deepseek.com",
  prefixoModelo: "AI_DEEPSEEK_MODEL_",
  prefixoEsforco: null,
  formato: "json_object",
  campoMaxTokens: "max_tokens",
  imagens: false,
};

const MODELO_VALIDO = /^[A-Za-z0-9._:\-/]{1,120}$/;

/**
 * Valores de `reasoning_effort` documentados pela OpenAI (Chat Completions). O suporte é por modelo (ex.: gpt-6-luna:
 * none, low, medium, high, xhigh, max); valor não suportado pelo modelo configurado ⇒ o provedor recusa (HTTP 400,
 * visível pelo detalhe saneado), nunca uma chamada silenciosamente diferente.
 */
export const ESFORCOS_RACIOCINIO = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EsforcoRaciocinio = (typeof ESFORCOS_RACIOCINIO)[number];

/** Alfabeto dos identificadores de erro aceitos no trace: curto, sem espaço (não cabe frase, e-mail, URL ou chave). */
const IDENTIFICADOR_ERRO = /^[A-Za-z0-9_.\-[\]]{1,64}$/;
/** Recusas 429 que NÃO se resolvem repetindo (conta sem crédito/cota): sem retry. */
const COTA_ESGOTADA = new Set(["insufficient_quota", "credit_balance_exhausted"]);
/** Limite de leitura do corpo de erro (evita ler corpo arbitrariamente grande). */
const MAX_CORPO_ERRO = 8_192;

function baseSegura(valor: string | undefined, padrao: string) {
  const bruto = valor?.trim() || padrao;
  try {
    const url = new URL(bruto);
    // Só HTTPS: a chave nunca trafega em claro.
    if (url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Contagem informada pelo provedor. Ausente ou inválida ⇒ null (uso desconhecido), nunca zero. */
function numero(valor: unknown) {
  return typeof valor === "number" && Number.isFinite(valor) && valor >= 0 ? Math.round(valor) : null;
}

function tokensCache(usage: Record<string, unknown>): number | null {
  const detalhes = usage.prompt_tokens_details;
  if (detalhes && typeof detalhes === "object" && "cached_tokens" in detalhes) return numero((detalhes as { cached_tokens: unknown }).cached_tokens);
  if ("prompt_cache_hit_tokens" in usage) return numero(usage.prompt_cache_hit_tokens);
  return null;
}

function identificador(valor: unknown): string | null {
  return typeof valor === "string" && IDENTIFICADOR_ERRO.test(valor) ? valor : null;
}

/**
 * Detalhe SANEADO de uma recusa HTTP: status + `error.type`/`code`/`param` que passem no alfabeto seguro.
 * A mensagem do provedor (que pode ecoar o pedido) e o restante do corpo nunca saem daqui.
 */
export async function detalheDoErro(resposta: Response): Promise<DetalheErroProvedor> {
  const detalhe: DetalheErroProvedor = { status: resposta.status, tipo: null, codigo: null, parametro: null };
  try {
    const bruto = (await resposta.text()).slice(0, MAX_CORPO_ERRO);
    const erro = (JSON.parse(bruto) as { error?: unknown })?.error;
    if (erro && typeof erro === "object") {
      const e = erro as Record<string, unknown>;
      detalhe.tipo = identificador(e.type);
      detalhe.codigo = identificador(e.code);
      detalhe.parametro = identificador(e.param);
    }
  } catch {
    // Corpo ausente, grande demais, abortado ou não-JSON: fica só o status.
  }
  return detalhe;
}

export function criarAdaptadorOpenAICompativel(perfil: Perfil, env: Ambiente, buscar: Buscador): AdaptadorProvedor {
  const chave = env[perfil.variavelChave]?.trim() ?? "";
  const base = baseSegura(env[perfil.variavelBase], perfil.baseUrlPadrao);

  function modeloPara(tier: TierModelo) {
    const modelo = env[`${perfil.prefixoModelo}${tier}`]?.trim() ?? "";
    return MODELO_VALIDO.test(modelo) ? modelo : null;
  }

  function esforcoPara(tier: TierModelo | undefined): EsforcoRaciocinio | null {
    if (!perfil.prefixoEsforco || !tier) return null;
    const valor = env[`${perfil.prefixoEsforco}${tier}`]?.trim().toLowerCase() ?? "";
    return (ESFORCOS_RACIOCINIO as readonly string[]).includes(valor) ? (valor as EsforcoRaciocinio) : null;
  }

  return {
    id: perfil.id,
    modeloPara,
    disponivel: () => chave.length >= 20 && base !== null,
    aceitaImagens: () => perfil.imagens,
    async gerar(pedido: PedidoModelo<unknown>, modelo: string, sinal: AbortSignal, opcoes?: { tier?: TierModelo }): Promise<RespostaBruta> {
      if (!chave || !base) throw new ErroModelo("SEM_CHAVE", false);
      const mensagens = pedido.mensagens.map((mensagem, indice) => {
        const ultimaDoUsuario = mensagem.papel === "user" && indice === pedido.mensagens.length - 1;
        if (!ultimaDoUsuario || !pedido.imagens?.length) return { role: mensagem.papel, content: mensagem.conteudo };
        if (!perfil.imagens) throw new ErroModelo("SEM_MODELO", false);
        return {
          role: mensagem.papel,
          content: [
            { type: "text", text: mensagem.conteudo },
            ...pedido.imagens.map((imagem) => ({ type: "image_url", image_url: { url: `data:${imagem.mime};base64,${imagem.base64}` } })),
          ],
        };
      });
      const corpo: Record<string, unknown> = {
        model: modelo,
        messages: mensagens,
        [perfil.campoMaxTokens]: pedido.maxTokensSaida,
        response_format: perfil.formato === "json_schema"
          ? { type: "json_schema", json_schema: { name: pedido.esquema.nome, schema: pedido.esquema.schema, strict: true } }
          : { type: "json_object" },
      };
      const esforco = esforcoPara(opcoes?.tier);
      if (esforco) corpo.reasoning_effort = esforco;
      let resposta: Response;
      try {
        resposta = await buscar(`${base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${chave}` },
          body: JSON.stringify(corpo),
          signal: sinal,
        });
      } catch (erro) {
        if (sinal.aborted) throw new ErroModelo("TIMEOUT", true);
        void erro;
        throw new ErroModelo("REDE", true);
      }
      if (!resposta.ok) {
        const detalhe = await detalheDoErro(resposta);
        const cotaEsgotada = resposta.status === 429 && (COTA_ESGOTADA.has(detalhe.codigo ?? "") || COTA_ESGOTADA.has(detalhe.tipo ?? ""));
        const tentavel = !cotaEsgotada && (resposta.status === 408 || resposta.status === 429 || resposta.status >= 500);
        throw new ErroModelo(resposta.status >= 500 ? "HTTP_5XX" : "HTTP_4XX", tentavel, { detalhe });
      }
      let json: unknown;
      try {
        json = await resposta.json();
      } catch {
        // Corpo ilegível: não dá para saber o que foi consumido ⇒ uso DESCONHECIDO (sem `uso`).
        throw new ErroModelo("RESPOSTA_INVALIDA", false);
      }
      const dados = json as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }>; usage?: Record<string, unknown> };
      const usoBruto = dados.usage && typeof dados.usage === "object" ? dados.usage : {};
      const medida = {
        modelo: typeof dados.model === "string" && MODELO_VALIDO.test(dados.model) ? dados.model : modelo,
        tokensEntrada: numero(usoBruto.prompt_tokens),
        tokensSaida: numero(usoBruto.completion_tokens),
        tokensCache: tokensCache(usoBruto),
      };
      const texto = dados.choices?.[0]?.message?.content;
      // H4: o provedor processou (ex.: raciocínio consumiu o teto e não sobrou texto). O uso informado é real.
      if (typeof texto !== "string" || texto.length === 0) throw new ErroModelo("RESPOSTA_INVALIDA", false, { uso: medida });
      return { texto, ...medida };
    },
  };
}
