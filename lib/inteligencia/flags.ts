import type { GrupoFlag } from "./contratos.ts";

/**
 * Feature flags do Kidmais Intelligence. Único lugar que lê as flags da IA.
 *
 * Todas falham fechadas: só o texto exato "true" liga. Ausente, vazio, "1", "TRUE" ⇒ desligado.
 *
 * - INTELIGENCIA_ENABLED: chave-mestra. Desligada, nenhuma rota da IA abre sessão ou banco.
 * - AI_READ_ENABLED: novas capacidades READ e perguntas em texto livre.
 * - AI_ADMIN_ACTIONS_ENABLED: capacidades CONFIRM (Human Gate) de cadastros administrativos.
 * - AI_CONTRACT_IMPORT_ENABLED: upload, extração e importação de contratos históricos.
 * - AI_TENANT_ALLOWLIST: opcional. Lista de empresas (uuid, separadas por vírgula) liberadas para os
 *   grupos READ, ADMIN_ACTIONS e CONTRACT_IMPORT. Definida e inválida ⇒ nenhuma empresa liberada.
 *
 * - AI_JEV_ENABLED: classificador auxiliar (JEV). Só sugere rota; desligado, o roteamento segue normal.
 *
 * `atencao_hoje` (grupo FUNDACAO) continua dependendo só de INTELIGENCIA_ENABLED, como na V1.
 */
export type Ambiente = Readonly<Record<string, string | undefined>>;

const VARIAVEL: Readonly<Record<Exclude<GrupoFlag, "FUNDACAO">, string>> = {
  READ: "AI_READ_ENABLED",
  ADMIN_ACTIONS: "AI_ADMIN_ACTIONS_ENABLED",
  CONTRACT_IMPORT: "AI_CONTRACT_IMPORT_ENABLED",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function inteligenciaAtiva(env: Ambiente) {
  return env.INTELIGENCIA_ENABLED === "true";
}

/** Checagem global, antes de sessão e banco. */
export function grupoAtivo(env: Ambiente, grupo: GrupoFlag) {
  if (!inteligenciaAtiva(env)) return false;
  if (grupo === "FUNDACAO") return true;
  return env[VARIAVEL[grupo]] === "true";
}

/**
 * Checagem por empresa, depois do Tenant Context. Sem allowlist, vale a flag global.
 * Com allowlist, só as empresas listadas; qualquer entrada inválida invalida a lista inteira.
 */
export function grupoAtivoParaEmpresa(env: Ambiente, grupo: GrupoFlag, empresaId: string) {
  if (!grupoAtivo(env, grupo)) return false;
  if (grupo === "FUNDACAO") return true;
  const bruto = env.AI_TENANT_ALLOWLIST;
  if (bruto === undefined || bruto.trim() === "") return true;
  const lista = bruto.split(",").map((valor) => valor.trim().toLowerCase());
  if (lista.some((valor) => !UUID.test(valor))) return false;
  return lista.includes(empresaId.toLowerCase());
}

/** Documento real só vai a provedor externo com autorização explícita do ambiente (Human Gate operacional). */
export function envioDocumentoExternoAutorizado(env: Ambiente) {
  return env.AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED === "true";
}

/** Classificador auxiliar (JEV): só com a chave-mestra ligada. Fail-safe: desligado não muda nada. */
export function jevAtivo(env: Ambiente) {
  return inteligenciaAtiva(env) && env.AI_JEV_ENABLED === "true";
}

/**
 * JEV V1 pode consultar um modelo ECONOMY quando as regras não têm confiança (AI_JEV_MODEL_ENABLED). Exige o JEV
 * ligado. Mesmo ligado, sem provedor, orçamento aplicável ou pricing, o JEV segue só com regras (fail-closed).
 */
export function jevModeloAtivo(env: Ambiente) {
  return jevAtivo(env) && env.AI_JEV_MODEL_ENABLED === "true";
}

/**
 * Orquestradora (Demerzel) no lugar do roteamento direto da conversa (AI_DEMERZEL_ENABLED). Exige a chave-mestra e
 * AI_READ_ENABLED (a conversa já exige). Desligada, a conversa segue o caminho da Foundation, sem mudança.
 */
export function demerzelAtivo(env: Ambiente) {
  return inteligenciaAtiva(env) && env.AI_DEMERZEL_ENABLED === "true";
}

/**
 * Copiloto pode pedir a um modelo uma explicação dos dados já lidos (AI_COPILOTO_MODEL_ENABLED). O modelo só vê o
 * contexto minimizado do Context Builder e a saída é validada contra os dados; sem a flag, sem provedor ou sem
 * orçamento aplicável, o Copiloto responde só com os dados e a próxima ação sugerida.
 */
export function copilotoModeloAtivo(env: Ambiente) {
  return inteligenciaAtiva(env) && env.AI_COPILOTO_MODEL_ENABLED === "true";
}

/**
 * Camadas de skill da EMPRESA e do ESTABELECIMENTO (AI_SKILLS_EMPRESA_ENABLED) sobre a base da plataforma. Desligada:
 * só a plataforma (a Policy nega as outras camadas). Ligada: ainda respeita a allowlist por empresa do grupo READ e,
 * para a camada da unidade, exige unidade COMPROVADA no Tenant Context.
 */
export function skillsEmpresaAtivas(env: Ambiente) {
  return inteligenciaAtiva(env) && env.AI_SKILLS_EMPRESA_ENABLED === "true";
}

/**
 * IA operacional (AI_OPERACIONAL_ENABLED): coordenação de rascunhos (consultar/corrigir/retomar sem perder o rascunho),
 * contexto operacional da festa e cálculo de consumo, preparação da contratação e proposta de parâmetro de consumo.
 * Exige a chave-mestra. Desligada, a conversa segue exatamente como antes (rollback por flag, sem apagar dados).
 */
export function operacionalAtivo(env: Ambiente) {
  return inteligenciaAtiva(env) && env.AI_OPERACIONAL_ENABLED === "true";
}
