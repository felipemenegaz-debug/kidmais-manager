import { createHash } from "node:crypto";

/**
 * Acesso público automatizado do cliente (Fase 29) — PREPARADO, ainda sem rota nem envio real.
 *
 * Fluxo transacional, separado do agente conversacional (nenhum LLM participa):
 *   Admin "Abrir acesso público do cliente" → libera o acesso → WhatsApp transacional com o LINK
 *   → cliente informa o CPF na página → recebe o OTP (fluxo de identidade existente) → valida → acessa.
 *
 * Regras:
 * - A primeira mensagem nunca contém OTP, CPF, token ou valor: só saudação, nome da empresa e o link.
 * - Falha no WhatsApp não revoga a liberação: o acesso continua liberado e o admin pode reenviar.
 * - Cada envio tem chave de idempotência: clique duplo ou retry não gera mensagem duplicada.
 * - Reenvio tem limite (intervalo mínimo e teto diário) para não virar spam.
 *
 * Depende, para ligar: tabela própria (migration), template transacional aprovado no provedor e
 * autorização explícita para envio real (docs/ACESSO_PUBLICO_AUTOMATIZADO.md).
 */
export type StatusEnvio = "PENDENTE" | "ENVIADO" | "FALHOU";

export type EnvioAcesso = {
  chaveIdempotencia: string;
  tentativa: number;
  status: StatusEnvio;
  em: string;
};

export type LiberacaoAcesso = {
  contratoId: string;
  versaoId: string;
  empresaId: string;
  liberadoPor: string;
  liberadoEm: string;
  revogadoEm: string | null;
  envios: EnvioAcesso[];
};

export const INTERVALO_MINIMO_REENVIO_MS = 60_000;
export const MAXIMO_ENVIOS_DIA = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Mesma liberação + mesma tentativa ⇒ mesma chave. Retry reaproveita; reenvio novo usa tentativa + 1. */
export function chaveIdempotencia(contratoId: string, versaoId: string, tentativa: number) {
  return createHash("sha256").update(`kidmais-acesso-publico-v1|${contratoId}|${versaoId}|${tentativa}`).digest("hex");
}

/**
 * Link da página pública do contrato. Só HTTPS, só o caminho /contrato/<uuid>, sem query nem fragmento:
 * nenhum token de acesso vai na mensagem (o acesso nasce da prova de identidade por CPF + OTP).
 */
export function linkAcesso(origemPublica: string, contratoId: string): string {
  const origem = new URL(origemPublica);
  if (origem.protocol !== "https:" || origem.pathname !== "/" || origem.search || origem.hash) throw new Error("Origem pública inválida.");
  if (!UUID.test(contratoId)) throw new Error("Contrato inválido.");
  return `${origem.origin}/contrato/${contratoId.toLowerCase()}`;
}

/** Parâmetros do template transacional. Nunca OTP, CPF, valores ou dados do contrato. */
export function parametrosMensagem(entrada: { primeiroNome: string; empresa: string; link: string }) {
  const limpar = (s: string, max: number) => s.replace(/[\u0000-\u001f<>{}]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  const primeiroNome = limpar(entrada.primeiroNome.split(" ")[0] ?? "", 40) || "Olá";
  if (!/^https:\/\/[^/]+\/contrato\/[0-9a-f-]{36}$/.test(entrada.link)) throw new Error("Link fora do formato permitido.");
  return [primeiroNome, limpar(entrada.empresa, 60), entrada.link] as const;
}

export type DecisaoEnvio =
  | { acao: "ENVIAR"; tentativa: number; chaveIdempotencia: string }
  | { acao: "REPETIR_RESULTADO"; envio: EnvioAcesso }
  | { acao: "RECUSAR"; motivo: string };

/**
 * Decide o que fazer num clique de "Abrir acesso" ou "Reenviar acesso".
 * `chaveCliente` é a chave do clique (retry do mesmo clique devolve o resultado já registrado).
 */
export function decidirEnvio(liberacao: LiberacaoAcesso, pedido: { reenviar: boolean; chaveCliente?: string }, agora: Date): DecisaoEnvio {
  if (liberacao.revogadoEm) return { acao: "RECUSAR", motivo: "O acesso público deste contrato foi revogado." };
  const repetido = pedido.chaveCliente ? liberacao.envios.find((e) => e.chaveIdempotencia === pedido.chaveCliente) : undefined;
  if (repetido) return { acao: "REPETIR_RESULTADO", envio: repetido };
  const ultimo = liberacao.envios.at(-1);
  if (ultimo && !pedido.reenviar) return { acao: "REPETIR_RESULTADO", envio: ultimo };
  if (ultimo?.status === "PENDENTE") return { acao: "RECUSAR", motivo: "Ainda estamos aguardando o envio anterior." };
  if (ultimo && agora.getTime() - Date.parse(ultimo.em) < INTERVALO_MINIMO_REENVIO_MS) return { acao: "RECUSAR", motivo: "Aguarde um minuto antes de reenviar." };
  const inicioDia = agora.getTime() - 24 * 60 * 60 * 1000;
  if (liberacao.envios.filter((e) => Date.parse(e.em) >= inicioDia).length >= MAXIMO_ENVIOS_DIA) return { acao: "RECUSAR", motivo: "Limite de reenvios de hoje atingido." };
  const tentativa = (ultimo?.tentativa ?? 0) + 1;
  return { acao: "ENVIAR", tentativa, chaveIdempotencia: chaveIdempotencia(liberacao.contratoId, liberacao.versaoId, tentativa) };
}

/** Resultado do provedor. Falha registra o envio, mas a liberação continua valendo. */
export function registrarEnvio(liberacao: LiberacaoAcesso, envio: { tentativa: number; chaveIdempotencia: string; ok: boolean }, agora: Date): LiberacaoAcesso {
  const semEsta = liberacao.envios.filter((e) => e.chaveIdempotencia !== envio.chaveIdempotencia);
  return { ...liberacao, envios: [...semEsta, { chaveIdempotencia: envio.chaveIdempotencia, tentativa: envio.tentativa, status: envio.ok ? "ENVIADO" : "FALHOU", em: agora.toISOString() }] };
}

/** Porta do envio transacional (template aprovado). Implementação real depende de gate humano. */
export interface EnviadorAcessoWhatsapp {
  enviar(entrada: { destino: string; parametros: readonly [string, string, string]; chaveIdempotencia: string }): Promise<{ ok: boolean }>;
}

/** Porta de persistência (tabela própria, migration futura). Sempre escopada pela empresa comprovada. */
export interface RepositorioLiberacoes {
  buscar(empresaId: string, contratoId: string, versaoId: string, travar: boolean): Promise<LiberacaoAcesso | null>;
  salvar(liberacao: LiberacaoAcesso): Promise<void>;
}
