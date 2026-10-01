import type { DbExecutor } from "../../db/contracts.ts";
import type { TenantComprovado } from "../../saas/provar-tenant.ts";
import type { CampoRascunho, EstadoOperacao, GrupoFlag, HumanGateDraft } from "../contratos.ts";

/**
 * Persistência do Human Gate. Implementação PostgreSQL em `lib/ia-persistencia/operacoes.ts`
 * (tabela `ia_operacoes`, migration 055, NÃO aplicada). Sem a tabela, `disponivel` é false e
 * nenhuma ação CONFIRM é oferecida (fail closed).
 *
 * Toda leitura é filtrada por empresa comprovada E usuário: um rascunho nunca é visto por outro tenant
 * nem confirmado por outra pessoa.
 */
export interface RepositorioOperacoes {
  disponivel(tx: DbExecutor): Promise<boolean>;
  criar(tx: DbExecutor, rascunho: HumanGateDraft): Promise<void>;
  buscar(tx: DbExecutor, filtro: { operacaoId: string; empresaId: string; usuarioId: string }, travar: boolean): Promise<HumanGateDraft | null>;
  /** Compare-and-set: só grava se a linha ainda está na versão e no estado esperados. */
  atualizar(tx: DbExecutor, rascunho: HumanGateDraft, esperado: { versao: number; estado: EstadoOperacao }): Promise<boolean>;
}

export type DefinicaoCampo = {
  id: string;
  rotulo: string;
  /** Obrigatório no domínio real. Nunca é preenchido por suposição. */
  obrigatorio: boolean;
  /** Perguntado mesmo não sendo obrigatório (ex.: preço), aceitando "sem ..." como resposta explícita. */
  perguntar: boolean;
  pergunta: string;
};

/** Portas de domínio não passam por aqui: cada ação recebe a sua na fábrica (injeção de dependência). */
export type ContextoAcao = {
  usuarioId: string;
  operacaoId: string;
  correlationId: string;
};

export type Verificacao<P> = { payload: P; avisos: string[]; campos?: CampoRascunho[] };

/**
 * Ferramenta CONFIRM (ou DENY). O modelo nunca a executa: só o endpoint de confirmação, depois do clique
 * humano, chama `executar`, dentro da mesma transação que revalida tenant, RBAC, flag, versão e payload.
 */
export type FerramentaAcao<P extends Record<string, unknown> = Record<string, unknown>> = {
  nome: string;
  capacidade: string;
  classe: "CONFIRM" | "DENY";
  grupo: GrupoFlag;
  papeis: readonly string[];
  descricao: string;
  titulo: string;
  /** DENY: explicação humana de por que a IA não faz isso. */
  mensagemNegada?: string;
  /**
   * DENY por INDISPONIBILIDADE (o assistente ainda não faz; ex.: catálogo global, envio de WhatsApp), e não por
   * proibição (exclusão, SQL). Só muda a explicação e o estado de entendimento: continua DENY e nunca executa.
   */
  indisponivel?: boolean;
  /** "TELA": só começa por uma tela própria (ex.: importação); a conversa nunca a abre. */
  origem?: "CONVERSA" | "TELA";
  campos: readonly DefinicaoCampo[];
  /**
   * IA operacional: a aprovação acontece no FORMULÁRIO OFICIAL (revisão preenchida), nunca pelo "Confirmar" do chat.
   * A prévia vira navegação para `destino` (só a referência opaca da operação); o Human Gate recusa confirmar por aqui.
   */
  revisao?: { rotulo: string; destino(payload: Record<string, unknown>, operacaoId: string): string | null; ttlSegundos?: number };
  /** Extração determinística de texto livre. `perguntado` é o campo da última pergunta, se houver. */
  extrair(texto: string, perguntado: string | null): Record<string, unknown>;
  /** Campos que ainda faltam, na ordem em que serão perguntados. */
  faltando(payload: Record<string, unknown>): string[];
  /** Normaliza e valida o payload completo. Lança InteligenciaError com mensagem humana se inválido. */
  validar(payload: Record<string, unknown>): P;
  /**
   * Pré-condições lidas no domínio (existência no tenant, duplicidade, estado atual).
   * Roda antes do preview E de novo depois da confirmação. Pode enriquecer o payload (ex.: id resolvido).
   */
  verificar(tx: DbExecutor, tenant: TenantComprovado, payload: P, contexto: ContextoAcao): Promise<Verificacao<P>>;
  /** Linhas do preview. Só formatação; nenhum valor novo nasce aqui. */
  apresentar(payload: Record<string, unknown>): CampoRascunho[];
  executar(tx: DbExecutor, tenant: TenantComprovado, payload: P, contexto: ContextoAcao): Promise<{ mensagem: string; entidadeId: string; destino?: string }>;
};
