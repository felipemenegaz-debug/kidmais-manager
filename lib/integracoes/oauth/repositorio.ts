import { createHash, randomBytes } from "node:crypto";
import type { EscopoMcp } from "../mcp/config.ts";
import type { PrincipalMcp } from "../mcp/ferramentas.ts";

/**
 * Persistência das delegações OAuth do canal MCP (migration 105). Metadados de SEGURANÇA, não escrita de negócio.
 *
 * Invariantes de qualquer implementação:
 * - segredos (pedido, código, tokens) só existem em claro na resposta ao cliente; aqui só o SHA-256 (alta entropia);
 * - código de uso único: `consumirCodigo` é atômico; reapresentação revoga a concessão inteira;
 * - refresh rotativo: `revogarAtualizacao` é atômico; token de atualização já girado reapresentado ⇒ reuso ⇒ revoga;
 * - toda leitura de token exige concessão não revogada e usuário ativo com senha não trocada depois da concessão;
 * - revogação persistida vale para todas as instâncias no próximo pedido (nada de cache de autorização em memória);
 * - armazenamento LIMITADO na gravação (rodada 2, achado 3): por concessão no máximo RETENCAO_OAUTH.emissoesPorHoraTeto
 *   acessos na última hora e RETENCAO_OAUTH.refreshGiradosGuardados refresh girados; o expurgo drena o resto em lotes;
 * - evidência de reuso (rodada 2, achado 4): refresh GIRADO e código USADO continuam detectáveis mesmo depois de vencidos,
 *   enquanto a concessão estiver ativa (janela: os últimos refreshGiradosGuardados giros; o único código da concessão).
 *
 * A implementação PostgreSQL (postgres.ts) é a única operacional. A de memória (memoria-teste.ts) existe só para
 * testes offline e nunca é fallback: sem schema, a rota responde indisponível.
 */
/**
 * Retenção e tetos de armazenamento (RET-1: valores PROPOSTOS, a confirmar por Felipe). Contas em docs/MCP_ASSINATURAS_V1.md §15.
 */
export const RETENCAO_OAUTH = Object.freeze({
  /** Renovações por concessão por hora antes de responder 429 (sem girar o refresh: o cliente tenta de novo depois). */
  emissoesPorHora: 30,
  /** Teto duro na gravação (concorrência acima do limite brando): nunca mais linhas que isto por concessão por hora. */
  emissoesPorHoraTeto: 60,
  /** Refresh girados guardados por concessão ativa para detectar reapresentação (inclusive depois de vencidos). */
  refreshGiradosGuardados: 20,
  /** Concessão revogada (e seus tokens/códigos) apagada depois disto. */
  concessaoRevogadaDias: 90,
  /** Auditoria do canal apagada depois disto. */
  auditoriaDias: 180,
  loteExpurgo: 500,
  lotesPorExpurgo: 40,
  orcamentoExpurgoMs: 2000,
});

export type ResultadoExpurgo = { pedidos: number; codigos: number; tokens: number; concessoes: number; auditoria: number; lotes: number; completo: boolean };

export type ClienteOAuth = { clientId: string; nome: string; redirectUris: readonly string[]; validoAte: Date };

export type PedidoAutorizacao = {
  clientId: string;
  clienteNome: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  escopos: readonly EscopoMcp[];
  recurso: string;
  expiraEm: Date;
};

export type NovaConcessao = {
  usuarioId: string;
  empresaId: string;
  clientId: string;
  clienteNome: string;
  redirectUri: string;
  escopos: readonly EscopoMcp[];
  recurso: string;
};

export type CodigoGuardado = {
  concessaoId: string;
  usuarioId: string;
  empresaId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  escopos: readonly EscopoMcp[];
  expiraEm: Date;
  usado: boolean;
};

export type AtualizacaoGuardada = {
  tokenId: string;
  concessaoId: string;
  usuarioId: string;
  empresaId: string;
  clientId: string;
  /** Escopo efetivo DESTE token de renovação (não o da concessão). */
  escopos: readonly EscopoMcp[];
  expiraEm: Date;
  /** Já girado/revogado: reapresentação é reuso. */
  revogado: boolean;
};

export type AcessoVerificado = PrincipalMcp & { recurso: string; expiraEm: Date };

export type ConcessaoResumo = {
  id: string;
  clientId: string;
  clienteNome: string;
  empresaId: string;
  /** Nome da empresa para a pessoa distinguir conexões iguais em empresas diferentes (revisão P3-10). */
  empresaNome: string;
  escopos: readonly EscopoMcp[];
  criadaEm: string;
  ultimoUsoEm: string | null;
  ultimaFerramentaEm: string | null;
  revogadaEm: string | null;
};

export const EVENTOS_SEGURANCA = [
  "PEDIDO_RECEBIDO", "PEDIDO_RECUSADO", "AUTORIZACAO_CONCEDIDA", "AUTORIZACAO_NEGADA", "TOKEN_EMITIDO", "TOKEN_RENOVADO",
  "TOKEN_RECUSADO", "REUSO_DETECTADO", "REVOGACAO", "FERRAMENTA",
] as const;
export type EventoSegurancaTipo = (typeof EVENTOS_SEGURANCA)[number];

/** Linha de auditoria: só identificadores e códigos fechados. Nunca token, consulta, documento, nome ou valor. */
export type EventoSeguranca = {
  evento: EventoSegurancaTipo;
  resultado: string;
  codigo: string;
  concessaoId?: string | null;
  usuarioId?: string | null;
  empresaId?: string | null;
  clientId?: string | null;
  capacidade?: string | null;
  itens?: number | null;
  duracaoMs?: number | null;
};

export interface RepositorioOAuth {
  clienteEmCache(clientId: string): Promise<ClienteOAuth | null>;
  guardarCliente(cliente: ClienteOAuth): Promise<void>;
  /**
   * Cria o pedido pendente só se o cliente tiver menos de `teto` pedidos pendentes. ATÔMICO entre conexões e instâncias
   * (admissão serializada por cliente). false ⇒ teto atingido, nada gravado.
   */
  criarPedidoNoTeto(chaveHash: string, pedido: PedidoAutorizacao, teto: number): Promise<boolean>;
  lerPedido(chaveHash: string): Promise<PedidoAutorizacao | null>;
  /** Atômico: só um consumidor recebe o pedido. */
  consumirPedido(chaveHash: string): Promise<PedidoAutorizacao | null>;
  /** Revoga concessões ativas do mesmo usuário+empresa+cliente, cria a nova e o código, na mesma transação. */
  criarConcessaoComCodigo(concessao: NovaConcessao, codigoHash: string, codigoExpiraEm: Date, codeChallenge: string): Promise<string>;
  lerCodigo(codigoHash: string): Promise<CodigoGuardado | null>;
  /** Atômico: true só para o primeiro consumo de um código não expirado. */
  consumirCodigo(codigoHash: string): Promise<boolean>;
  /** Escopo efetivo do par (⊆ escopos da concessão; a implementação recusa ampliação). */
  salvarTokens(concessaoId: string, escopos: readonly EscopoMcp[], acesso: { hash: string; expiraEm: Date }, atualizacao: { hash: string; expiraEm: Date } | null): Promise<void>;
  /** Refresh vigente, ou GIRADO (revogado=true) mesmo vencido enquanto a evidência existir; concessão inativa ⇒ null. */
  lerAtualizacao(hash: string): Promise<AtualizacaoGuardada | null>;
  /** Acessos emitidos para a concessão na última hora (limite de renovação por concessão). */
  emissoesRecentes(concessaoId: string): Promise<number>;
  /** Atômico: true só para quem girou primeiro um token ainda válido. */
  revogarAtualizacao(tokenId: string): Promise<boolean>;
  revogarConcessao(concessaoId: string, motivo: "USUARIO" | "REUSO" | "SUBSTITUIDA", porUsuarioId: string | null): Promise<boolean>;
  verificarAcesso(hash: string): Promise<AcessoVerificado | null>;
  listarConcessoes(usuarioId: string): Promise<readonly ConcessaoResumo[]>;
  marcarUso(concessaoId: string, ferramentaObservada: boolean): Promise<void>;
  auditar(evento: EventoSeguranca): Promise<void>;
  /**
   * Expurgo em lotes que DRENA até esgotar ou atingir o orçamento (RETENCAO_OAUTH): pedidos vencidos/consumidos há > 1 h;
   * códigos não usados vencidos há > 1 h; acessos vencidos; refresh vencidos nunca girados; tudo de concessões revogadas há
   * > 1 dia; concessões revogadas há > concessaoRevogadaDias; auditoria com mais de auditoriaDias. Nunca apaga a evidência
   * de reuso de uma concessão ativa (código usado, refresh girados guardados).
   */
  expurgarExpirados(): Promise<ResultadoExpurgo>;
}

export function hashSegredo(valor: string) {
  return createHash("sha256").update(valor, "utf8").digest("hex");
}

/** 256 bits de entropia, prefixo legível só para identificar o tipo em incidentes (nunca o valor). */
export function novoSegredo(prefixo: "kmp" | "kmc" | "kma" | "kmr") {
  return `${prefixo}_${randomBytes(32).toString("base64url")}`;
}
