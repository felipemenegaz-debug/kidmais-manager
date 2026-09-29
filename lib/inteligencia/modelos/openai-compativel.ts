import type { IdProvedor, TierModelo } from "../contratos.ts";
import type { Ambiente } from "../flags.ts";
import { ErroModelo, type AdaptadorProvedor, type Buscador, type PedidoModelo, type RespostaBruta } from "./tipos.ts";

/**
 * Adaptador para APIs no formato Chat Completions (OpenAI e DeepSeek).
 *
 * - A chave vem só do ambiente, nunca do código, e nunca é registrada nem devolvida.
 * - Sem chave, ou sem modelo configurado para o tier, o provedor fica indisponível.
 * - Nenhuma ferramenta (function calling) é enviada: o modelo só devolve JSON, validado pelo chamador.
 */
type Perfil = {
  id: IdProvedor;
  variavelChave: string;
  variavelBase: string;
  baseUrlPadrao: string;
  prefixoModelo: string;
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
  formato: "json_object",
  campoMaxTokens: "max_tokens",
  imagens: false,
};

const MODELO_VALIDO = /^[A-Za-z0-9._:\-/]{1,120}$/;

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

export function criarAdaptadorOpenAICompativel(perfil: Perfil, env: Ambiente, buscar: Buscador): AdaptadorProvedor {
  const chave = env[perfil.variavelChave]?.trim() ?? "";
  const base = baseSegura(env[perfil.variavelBase], perfil.baseUrlPadrao);

  function modeloPara(tier: TierModelo) {
    const modelo = env[`${perfil.prefixoModelo}${tier}`]?.trim() ?? "";
    return MODELO_VALIDO.test(modelo) ? modelo : null;
  }

  return {
    id: perfil.id,
    modeloPara,
    disponivel: () => chave.length >= 20 && base !== null,
    aceitaImagens: () => perfil.imagens,
    async gerar(pedido: PedidoModelo<unknown>, modelo: string, sinal: AbortSignal): Promise<RespostaBruta> {
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
        const tentavel = resposta.status === 408 || resposta.status === 429 || resposta.status >= 500;
        throw new ErroModelo(resposta.status >= 500 ? "HTTP_5XX" : "HTTP_4XX", tentavel);
      }
      let json: unknown;
      try {
        json = await resposta.json();
      } catch {
        throw new ErroModelo("RESPOSTA_INVALIDA", false);
      }
      const dados = json as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }>; usage?: Record<string, unknown> };
      const texto = dados.choices?.[0]?.message?.content;
      if (typeof texto !== "string" || texto.length === 0) throw new ErroModelo("RESPOSTA_INVALIDA", false);
      const uso = dados.usage ?? {};
      return {
        texto,
        modelo: typeof dados.model === "string" && MODELO_VALIDO.test(dados.model) ? dados.model : modelo,
        tokensEntrada: numero(uso.prompt_tokens),
        tokensSaida: numero(uso.completion_tokens),
        tokensCache: tokensCache(uso),
      };
    },
  };
}
