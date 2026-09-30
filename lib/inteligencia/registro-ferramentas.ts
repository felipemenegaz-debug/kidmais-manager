import { z } from "zod";
import type { ClasseAcao, GrupoFlag } from "./contratos.ts";
import type { DescricaoAcao } from "./extensoes.ts";
import { ferramentas, type Ferramenta } from "./ferramentas.ts";

/**
 * Tool Registry V1: manifesto declarativo e VERIFICÁVEL de tudo o que a IA pode ler, sugerir, propor ou recusar.
 *
 * Cada entrada declara nome, domínio, classe (READ / SUGGEST / CONFIRM / FORBIDDEN), papéis exigidos, capacidade e
 * grupo de flag exigidos, escopo de tenant e de estabelecimento, schema de entrada, schema de saída, prazo,
 * idempotência e auditoria. O gateway aplica entrada, prazo e saída a cada leitura; a Policy usa a classe e os papéis.
 *
 * Invariantes (conferidas por `validarRegistro` e pelos testes):
 * - não existe ferramenta de SQL, shell ou execução arbitrária (a entrada `sql` existe só como FORBIDDEN);
 * - tenant é sempre a empresa COMPROVADA pelo Tenant Context; nenhuma entrada aceita empresa/tenant/usuário/papel;
 * - CONFIRM só executa pelo Human Gate (operação única, versão + hash) e audita no domínio;
 * - FORBIDDEN nunca executa e não tem papel;
 * - toda ação registrada no módulo precisa de manifesto; sem manifesto ⇒ não é oferecida (fail-closed).
 */
export const VERSAO_REGISTRO = "tool-registry-v1.0.0";

export const CLASSES_V1 = ["READ", "SUGGEST", "CONFIRM", "FORBIDDEN"] as const;
export type ClasseV1 = (typeof CLASSES_V1)[number];

export const DOMINIOS = ["FINANCEIRO", "CONTRATOS", "FESTAS", "CLIENTES", "COMERCIAL", "NAVEGACAO", "ATENDIMENTO", "OPERACAO", "PLATAFORMA"] as const;
export type Dominio = (typeof DOMINIOS)[number];

export type SaidaDeclarada = "RESPOSTA_LEITURA" | "ATENCAO_HOJE" | "RASCUNHO_HUMAN_GATE" | "SUGESTAO" | "RECUSA";

export type Manifesto = {
  nome: string;
  capacidade: string;
  dominio: Dominio;
  classe: ClasseV1;
  /** requiredRole: papéis que já fazem o mesmo na tela. Vazio ⇒ ninguém (FORBIDDEN). */
  papeisExigidos: readonly string[];
  /** requiredCapability: grupo de flag (ambiente + allowlist por empresa) que precisa estar ativo. */
  grupoExigido: GrupoFlag | "NENHUM";
  /** Empresa sempre comprovada pelo Tenant Context (sessão + membership), nunca vinda do pedido ou do modelo. */
  escopoTenant: "EMPRESA_COMPROVADA";
  /**
   * Establishment scope. COMPANY: capacidade empresarial (dados da empresa comprovada; unidade comprovada, se houver,
   * só entra no trace/contexto). ESTABLISHMENT: capacidade operacional por unidade — exige unidade COMPROVADA
   * (provarEstabelecimento) e a ferramenta filtra por ela; sem unidade ⇒ Policy nega (NEGADO_ESTABELECIMENTO).
   * A unidade nunca vem do modelo: só do pedido da tela, provada no Tenant Context.
   */
  escopoEstabelecimento: EscopoEstabelecimento;
  entidade: "festa" | "cliente" | "contrato" | null;
  /** inputSchema (zod estrito) ou null quando a entrada é o fluxo conversacional do Human Gate / texto do operador. */
  entrada: z.ZodType | null;
  saida: SaidaDeclarada;
  /** Prazo máximo; READ excedido ⇒ fallback seguro. CONFIRM: prazo informativo, a transação do domínio decide. */
  prazoMs: number;
  idempotencia: "LEITURA_SEM_EFEITO" | "SEM_EFEITO" | "OPERACAO_UNICA_HUMAN_GATE" | "NUNCA_EXECUTA";
  auditoria: "TRACE_IA" | "TRACE_IA_E_AUDITORIA_NEGOCIO";
  executor: "GATEWAY" | "HUMAN_GATE" | "AGENTE" | "COPILOTO" | "NENHUM";
};

// ---------------------------------------------------------------- schemas de saída (outputSchema)

const texto = z.string().max(2000);
const evidenciaSchema = z.object({ fonte: z.string().max(80), rotulo: z.string().max(200), valor: z.string().max(200), destino: z.string().max(300).optional() }).strict();
const itemSchema = z.object({ id: z.string().max(80), prioridade: z.enum(["alta", "media", "baixa"]), titulo: texto, detalhe: texto, destino: z.string().max(300).optional() }).strict();

export const saidaLeituraSchema = z.object({
  capacidade: z.string().max(64),
  estado: z.enum(["atencao", "em_dia", "sem_dados", "informativo"]),
  resumo: texto,
  fatos: z.array(z.object({ natureza: z.enum(["FATO", "CALCULO", "AUSENCIA"]), texto, fonte: z.string().max(80) }).strict()).max(60),
  itens: z.array(itemSchema).max(100),
  evidencias: z.array(evidenciaSchema).max(40),
  referencia: z.object({ hoje: z.string().max(10), geradoEm: z.string().max(40), fontes: z.array(z.string().max(80)).max(20) }).strict(),
}).strict();

const evidenciaAgregadaSchema = z.object({ fonte: z.string().max(80) }).passthrough();
export const saidaAtencaoSchema = z.object({
  capacidade: z.literal("atencao_hoje"),
  estado: z.enum(["atencao", "em_dia", "sem_dados"]),
  resumo: texto,
  referencia: z.object({ hoje: z.string().max(10), geradoEm: z.string().max(40), fonte: z.string().max(80) }).strict(),
  itens: z.array(z.object({
    tipo: z.enum(["RECEBIVEIS_VENCIDOS", "RECEBIVEIS_VENCEM_HOJE", "A_RECEBER_EM_ABERTO"]),
    prioridade: z.enum(["alta", "media", "baixa"]),
    titulo: texto,
    detalhe: texto,
    destino: z.string().max(300),
    evidencia: evidenciaAgregadaSchema,
  }).strict()).max(10),
}).strict();

/** Chaves que nunca podem aparecer numa saída de ferramenta (minimização; defesa em profundidade). */
const CHAVES_PROIBIDAS = /^(cpf|cnpj|rg|documento|senha|password|hash|senha_hash|password_hash|token|session|sessao|otp|api_?key|secret|segredo|database_url|connection_?string|telefone|email|endereco)$/i;

function chaveProibida(valor: unknown, profundidade = 0): string | null {
  if (profundidade > 8 || valor === null || typeof valor !== "object") return null;
  if (Array.isArray(valor)) {
    for (const v of valor) {
      const k = chaveProibida(v, profundidade + 1);
      if (k) return k;
    }
    return null;
  }
  for (const [chave, v] of Object.entries(valor)) {
    if (CHAVES_PROIBIDAS.test(chave)) return chave;
    const k = chaveProibida(v, profundidade + 1);
    if (k) return k;
  }
  return null;
}

/** outputSchema aplicado pelo gateway. Falha ⇒ a resposta NÃO é entregue (fallback seguro). */
export function saidaValida(saida: SaidaDeclarada, dados: unknown): boolean {
  if (chaveProibida(dados)) return false;
  if (saida === "RESPOSTA_LEITURA") return saidaLeituraSchema.safeParse(dados).success;
  if (saida === "ATENCAO_HOJE") return saidaAtencaoSchema.safeParse(dados).success;
  return false;
}

// ---------------------------------------------------------------- metadados por capacidade

export type EscopoEstabelecimento = "COMPANY" | "ESTABLISHMENT";

type Meta = { dominio: Dominio; prazoMs: number; saida?: SaidaDeclarada; escopo?: EscopoEstabelecimento };

/**
 * Escopo padrão das leituras V1: COMPANY. Os dados do Core que elas leem (recebíveis, contratos, festas, agenda,
 * clientes, pacotes) são da EMPRESA — nenhuma dessas tabelas tem unidade (só festa_areas tem estabelecimento
 * opcional, 056), e a 043 mantém o caminho operacional da unidade fechado (D03). Quando o Core ganhar unidade nesses
 * dados, a leitura passa a ESTABLISHMENT aqui e filtra por `contexto.estabelecimento`.
 */
const ESCOPO_PADRAO: EscopoEstabelecimento = "COMPANY";

/** Leituras (READ). Toda ferramenta do registro fechado precisa estar aqui (teste). */
const LEITURAS: Readonly<Record<string, Meta>> = Object.freeze({
  atencao_hoje: { dominio: "FINANCEIRO", prazoMs: 5000, saida: "ATENCAO_HOJE" },
  analisar_recebiveis: { dominio: "FINANCEIRO", prazoMs: 5000 },
  analisar_pagamentos: { dominio: "FINANCEIRO", prazoMs: 5000 },
  contratos_pendentes: { dominio: "CONTRATOS", prazoMs: 5000 },
  agenda_do_dia: { dominio: "FESTAS", prazoMs: 5000 },
  resumir_cliente: { dominio: "CLIENTES", prazoMs: 4000 },
  resumir_contrato: { dominio: "CONTRATOS", prazoMs: 4000 },
  resumir_festa: { dominio: "FESTAS", prazoMs: 6000 },
  pendencias_da_festa: { dominio: "FESTAS", prazoMs: 6000 },
  festa_em_risco: { dominio: "FESTAS", prazoMs: 6000 },
  onde_encontrar: { dominio: "NAVEGACAO", prazoMs: 1000 },
  pacotes_disponiveis: { dominio: "COMERCIAL", prazoMs: 4000 },
  comparar_versoes_contrato: { dominio: "CONTRATOS", prazoMs: 4000 },
});

/** Ações (CONFIRM/DENY) conhecidas. Ação sem entrada aqui não é oferecida. */
const ACOES: Readonly<Record<string, Meta>> = Object.freeze({
  criar_pacote: { dominio: "COMERCIAL", prazoMs: 8000 },
  editar_pacote: { dominio: "COMERCIAL", prazoMs: 8000 },
  ativar_pacote: { dominio: "COMERCIAL", prazoMs: 8000 },
  desativar_pacote: { dominio: "COMERCIAL", prazoMs: 8000 },
  importar_contrato: { dominio: "CONTRATOS", prazoMs: 15000 },
  criar_categoria_buffet: { dominio: "COMERCIAL", prazoMs: 0 },
  criar_item_buffet: { dominio: "COMERCIAL", prazoMs: 0 },
  editar_categoria_buffet: { dominio: "COMERCIAL", prazoMs: 0 },
  editar_item_buffet: { dominio: "COMERCIAL", prazoMs: 0 },
  excluir: { dominio: "PLATAFORMA", prazoMs: 0 },
  mutacao_nao_suportada: { dominio: "PLATAFORMA", prazoMs: 0 },
  sql: { dominio: "PLATAFORMA", prazoMs: 0 },
});

/** Sugestões (SUGGEST): produzidas por agentes/Copiloto sem efeito; nunca enviadas nem gravadas. */
export const SUGESTOES: readonly Manifesto[] = Object.freeze([
  sugestao("atendimento.rascunho_mensagem", "redigir_mensagem", "ATENDIMENTO", "AGENTE"),
  sugestao("atendimento.orientar_objecao", "orientar_objecao", "ATENDIMENTO", "AGENTE"),
  sugestao("copiloto.proxima_acao", "proxima_acao", "OPERACAO", "COPILOTO"),
  sugestao("copiloto.explicar_dados", "explicar_dados", "OPERACAO", "COPILOTO"),
]);

/** Finalidade de skill que produz SUGESTÃO ⇒ capacidade SUGGEST do registro (Policy decide antes de resolver). */
export const SUGESTAO_POR_FINALIDADE: Readonly<Record<string, string>> = Object.freeze({
  SUGESTAO_TEXTO: "redigir_mensagem",
  OBJECAO: "orientar_objecao",
  PROCEDIMENTO: "proxima_acao",
});

export function manifestoSugestao(capacidade: string): Manifesto | null {
  return SUGESTOES.find((m) => m.capacidade === capacidade) ?? null;
}

function sugestao(nome: string, capacidade: string, dominio: Dominio, executor: "AGENTE" | "COPILOTO"): Manifesto {
  return {
    nome, capacidade, dominio, classe: "SUGGEST", papeisExigidos: ["ADMINISTRATIVO", "REPRESENTANTE_AUTORIZADO"], grupoExigido: "READ",
    escopoTenant: "EMPRESA_COMPROVADA", escopoEstabelecimento: "COMPANY", entidade: null, entrada: null, saida: "SUGESTAO",
    prazoMs: 8000, idempotencia: "SEM_EFEITO", auditoria: "TRACE_IA", executor,
  };
}

export function classeV1(classe: ClasseAcao): ClasseV1 {
  if (classe === "READ") return "READ";
  if (classe === "CONFIRM") return "CONFIRM";
  return "FORBIDDEN";
}

/** Manifesto de uma leitura do registro fechado. null ⇒ ferramenta sem manifesto (não executa). */
export function manifestoLeitura(f: Ferramenta): Manifesto | null {
  const meta = Object.hasOwn(LEITURAS, f.capacidade) ? LEITURAS[f.capacidade] : null;
  if (!meta) return null;
  return {
    nome: f.nome, capacidade: f.capacidade, dominio: meta.dominio, classe: classeV1(f.classe), papeisExigidos: f.papeis, grupoExigido: f.grupo,
    escopoTenant: "EMPRESA_COMPROVADA", escopoEstabelecimento: meta.escopo ?? ESCOPO_PADRAO, entidade: f.entidade ?? null, entrada: f.entrada,
    saida: meta.saida ?? "RESPOSTA_LEITURA", prazoMs: meta.prazoMs, idempotencia: "LEITURA_SEM_EFEITO", auditoria: "TRACE_IA", executor: "GATEWAY",
  };
}

/** Forma mínima de uma ação: a descrição do módulo (CORE), sem importar a feature ACTIONS. */
export type AcaoDescrita = Pick<DescricaoAcao, "ferramenta" | "capacidade" | "classe" | "grupo" | "papeis">;

export function manifestoAcao(a: AcaoDescrita): Manifesto | null {
  const meta = Object.hasOwn(ACOES, a.capacidade) ? ACOES[a.capacidade] : null;
  if (!meta) return null;
  const classe = classeV1(a.classe);
  const confirma = classe === "CONFIRM";
  return {
    nome: a.ferramenta, capacidade: a.capacidade, dominio: meta.dominio, classe, papeisExigidos: confirma ? a.papeis : [], grupoExigido: confirma ? a.grupo : "NENHUM",
    escopoTenant: "EMPRESA_COMPROVADA", escopoEstabelecimento: "COMPANY", entidade: null, entrada: null,
    saida: confirma ? "RASCUNHO_HUMAN_GATE" : "RECUSA", prazoMs: meta.prazoMs,
    idempotencia: confirma ? "OPERACAO_UNICA_HUMAN_GATE" : "NUNCA_EXECUTA",
    auditoria: confirma ? "TRACE_IA_E_AUDITORIA_NEGOCIO" : "TRACE_IA", executor: confirma ? "HUMAN_GATE" : "NENHUM",
  };
}

/** Registro completo: leituras + sugestões + ações informadas pela composição. */
export function registroCompleto(acoes: readonly AcaoDescrita[]): { manifestos: readonly Manifesto[]; problemas: string[] } {
  const problemas: string[] = [];
  const manifestos: Manifesto[] = [];
  for (const f of Object.values(ferramentas)) {
    const m = manifestoLeitura(f);
    if (m) manifestos.push(m);
    else problemas.push(`leitura sem manifesto: ${f.capacidade}`);
  }
  manifestos.push(...SUGESTOES);
  for (const a of acoes) {
    const m = manifestoAcao(a);
    if (m) manifestos.push(m);
    else problemas.push(`ação sem manifesto: ${a.capacidade}`);
  }
  problemas.push(...validarRegistro(manifestos));
  return { manifestos, problemas };
}

const EXECUCAO_ARBITRARIA = /(^|[._])(sql|shell|exec|eval|query|comando|script|bash|cmd|consulta_livre)($|[._])/i;
const UUID_TESTE = "00000000-0000-4000-8000-000000000000";
const CHAVES_DE_AUTORIDADE = ["empresaId", "empresa_id", "tenantId", "tenant", "usuarioId", "papel", "membershipId", "estabelecimentoId", "role"];

/** Invariantes do registro. Lista vazia ⇒ registro válido. */
export function validarRegistro(manifestos: readonly Manifesto[]): string[] {
  const problemas: string[] = [];
  const vistos = new Set<string>();
  for (const m of manifestos) {
    const id = `${m.classe}:${m.capacidade}`;
    if (vistos.has(m.capacidade)) problemas.push(`capacidade duplicada: ${m.capacidade}`);
    vistos.add(m.capacidade);
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(m.capacidade)) problemas.push(`${id}: capacidade fora do padrão`);
    if (!/^[a-z][a-z0-9_.]{1,79}$/.test(m.nome)) problemas.push(`${id}: nome fora do padrão`);
    if (!(CLASSES_V1 as readonly string[]).includes(m.classe)) problemas.push(`${id}: classe inválida`);
    if (!(DOMINIOS as readonly string[]).includes(m.dominio)) problemas.push(`${id}: domínio inválido`);
    if (m.escopoTenant !== "EMPRESA_COMPROVADA") problemas.push(`${id}: tenant não comprovado`);
    if (m.escopoEstabelecimento !== "COMPANY" && m.escopoEstabelecimento !== "ESTABLISHMENT") problemas.push(`${id}: escopo de estabelecimento inválido`);
    if (m.classe !== "FORBIDDEN" && (EXECUCAO_ARBITRARIA.test(m.nome) || EXECUCAO_ARBITRARIA.test(m.capacidade))) problemas.push(`${id}: execução arbitrária`);
    if (m.classe === "FORBIDDEN") {
      if (m.papeisExigidos.length) problemas.push(`${id}: FORBIDDEN com papel`);
      if (m.idempotencia !== "NUNCA_EXECUTA" || m.executor !== "NENHUM") problemas.push(`${id}: FORBIDDEN executável`);
      continue;
    }
    if (!m.papeisExigidos.length) problemas.push(`${id}: sem papel exigido`);
    if (m.grupoExigido === "NENHUM") problemas.push(`${id}: sem grupo de flag`);
    if (m.classe === "READ") {
      if (m.executor !== "GATEWAY" || m.idempotencia !== "LEITURA_SEM_EFEITO") problemas.push(`${id}: READ fora do gateway`);
      if (!m.entrada) problemas.push(`${id}: READ sem schema de entrada`);
      else {
        const entrada = m.entrada;
        for (const chave of CHAVES_DE_AUTORIDADE) {
          const tentativas = [{}, { id: UUID_TESTE }, { dia: "hoje" }].map((base) => ({ ...base, [chave]: UUID_TESTE }));
          if (tentativas.some((t) => entrada.safeParse(t).success)) problemas.push(`${id}: entrada aceita ${chave}`);
        }
      }
      if (m.prazoMs < 100 || m.prazoMs > 15000) problemas.push(`${id}: prazo fora de 100..15000`);
    }
    if (m.classe === "CONFIRM") {
      if (m.executor !== "HUMAN_GATE" || m.idempotencia !== "OPERACAO_UNICA_HUMAN_GATE") problemas.push(`${id}: CONFIRM fora do Human Gate`);
      if (m.auditoria !== "TRACE_IA_E_AUDITORIA_NEGOCIO") problemas.push(`${id}: CONFIRM sem auditoria de negócio`);
    }
    if (m.classe === "SUGGEST" && (m.idempotencia !== "SEM_EFEITO" || m.saida !== "SUGESTAO")) problemas.push(`${id}: SUGGEST com efeito`);
  }
  return problemas;
}
