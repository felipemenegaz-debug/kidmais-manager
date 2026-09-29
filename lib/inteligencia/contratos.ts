/**
 * Contratos estáveis do Kidmais Intelligence (Fase 1 da Production V1).
 *
 * Só tipos. Nenhum destes formatos carrega segredo, token de sessão, OTP, SQL ou empresa escolhida
 * pelo pedido: tenant e papel vêm sempre da sessão e do Tenant Context no servidor.
 *
 * Fluxo de escrita obrigatório:
 *   LLM → intenção estruturada → Policy → Tenant Context → Human Gate → Tool Registry → Domain Service
 * O LLM nunca recebe DbExecutor, nunca confirma a própria ação e nunca escolhe tenant.
 */
import type { AtencaoHoje } from "./atencao-hoje.ts";

/** READ consulta; SUGGEST sugere sem mutação; CONFIRM exige Human Gate; DENY nunca executa. */
export type ClasseAcao = "READ" | "SUGGEST" | "CONFIRM" | "DENY";

/** Grupo de feature flag que libera uma capacidade. Todas falham fechadas. */
export type GrupoFlag = "FUNDACAO" | "READ" | "ADMIN_ACTIONS" | "CONTRACT_IMPORT";

export type TierModelo = "ECONOMY" | "STANDARD" | "ADVANCED";
export type IdProvedor = "OPENAI" | "DEEPSEEK" | "FAKE";

/** Classe de workload: o roteador escolhe o tier por política configurável, nunca "o mais caro sempre". */
export type Workload =
  | "CLASSIFICAR_INTENCAO"
  | "PREENCHER_CAMPOS"
  | "TEXTO_CURTO"
  | "FAQ"
  | "ANALISE_ADMINISTRATIVA"
  | "SUMARIZACAO"
  | "EXTRACAO_CONTRATO"
  | "REVISAO_COMPLEXA";

/** Capacidade exposta ao operador. Uma capacidade aponta para exatamente uma ferramenta registrada. */
export type Capability = {
  id: string;
  ferramenta: string;
  classe: ClasseAcao;
  grupo: GrupoFlag;
  /** Papéis que já fazem a mesma operação nas telas. A IA não amplia esse conjunto. */
  papeis: readonly string[];
  descricao: string;
};

/** Contexto de tela que a UI pode informar. Ids de entidade são revalidados no tenant pelo domínio. */
export type ContextoTela = {
  tela: "dashboard" | "festa" | "cliente" | "contrato" | "financeiro" | "pacotes" | "agenda" | "configuracoes" | "geral";
  entidadeId?: string;
};

export type AIRequest = {
  requestId: string;
  correlationId: string;
  usuarioId: string;
  papel: string;
  /** Só escolhe entre memberships ATIVA do próprio usuário (provarTenant). Nunca vem do corpo. */
  empresaSolicitada: string | null;
  entrada:
    | { tipo: "capacidade"; capacidade: string; parametros: unknown }
    | { tipo: "texto"; texto: string; contexto: ContextoTela | null }
    | { tipo: "resposta_rascunho"; operacaoId: string; texto: string };
};

/** Turno curto, controlado pelo Kidmais. Não existe memória infinita do modelo. */
export type AIConversationTurn = {
  autor: "operador" | "kidmais";
  texto: string;
  em: string;
};

export type OrigemChamada = "UI" | "INTENCAO_DETERMINISTICA" | "INTENCAO_JEV" | "INTENCAO_MODELO" | "HUMAN_GATE";

export type ToolCall = {
  ferramenta: string;
  classe: ClasseAcao;
  origem: OrigemChamada;
  parametros: unknown;
};

export type ToolResult<T = unknown> =
  | { ferramenta: string; ok: true; dados: T }
  | { ferramenta: string; ok: false; codigo: string };

/** Distinção obrigatória nas respostas: fato lido, cálculo determinístico ou ausência de dados. */
export type NaturezaFato = "FATO" | "CALCULO" | "AUSENCIA";

export type Fato = { natureza: NaturezaFato; texto: string; fonte: string };

/** Evidência rastreável até o serviço de domínio. Nunca um valor produzido pelo modelo. */
export type Evidencia = {
  fonte: string;
  rotulo: string;
  valor: string;
  destino?: string;
};

export type ItemResposta = {
  id: string;
  prioridade: "alta" | "media" | "baixa";
  titulo: string;
  detalhe: string;
  destino?: string;
};

export type RespostaLeitura = {
  capacidade: string;
  estado: "atencao" | "em_dia" | "sem_dados" | "informativo";
  resumo: string;
  fatos: Fato[];
  itens: ItemResposta[];
  evidencias: Evidencia[];
  referencia: { hoje: string; geradoEm: string; fontes: string[] };
};

export type EstadoOperacao =
  | "COLETANDO"
  | "AGUARDANDO_CONFIRMACAO"
  | "EXECUTADA"
  | "CANCELADA"
  | "EXPIRADA"
  | "FALHOU";

export type CampoRascunho = {
  id: string;
  rotulo: string;
  valor: string | null;
  obrigatorio: boolean;
};

/**
 * Rascunho sob Human Gate. `payloadHash` cobre o payload normalizado e a versão:
 * qualquer alteração depois do preview invalida a confirmação.
 */
export type HumanGateDraft = {
  operacaoId: string;
  correlationId: string;
  idempotencyKey: string;
  capacidade: string;
  ferramenta: string;
  empresaId: string;
  usuarioId: string;
  estado: EstadoOperacao;
  versao: number;
  payload: Record<string, unknown>;
  payloadHash: string;
  expiraEm: string;
  criadoEm: string;
  atualizadoEm: string;
  resultado: Record<string, unknown> | null;
};

/** O que a UI recebe do rascunho: sem empresa, usuário ou chave de idempotência. */
export type RascunhoPublico = {
  operacaoId: string;
  capacidade: string;
  estado: EstadoOperacao;
  versao: number;
  payloadHash: string;
  expiraEm: string;
  titulo: string;
  campos: CampoRascunho[];
  avisos: string[];
};

export type AIResponse =
  /** `atencao_hoje` (V1) mantém o próprio formato; as demais leituras usam RespostaLeitura. */
  | { tipo: "resposta"; dados: RespostaLeitura | AtencaoHoje; complemento?: ComplementoCopiloto }
  /** Agente (V1): seções de leituras REAIS já autorizadas + rascunho rotulado. Nunca executa. */
  | { tipo: "agente"; agente: { id: string; nome: string }; resumo: string; secoes: SecaoAgente[]; sugestao: SugestaoAgente | null }
  | { tipo: "rascunho"; rascunho: RascunhoPublico; pergunta: string; faltando: string[] }
  | { tipo: "preview"; rascunho: RascunhoPublico }
  | { tipo: "resultado_acao"; rascunho: RascunhoPublico; mensagem: string; destino?: string }
  | { tipo: "nao_suportado"; mensagem: string; sugestoes: string[] }
  | { tipo: "precisa_contexto"; mensagem: string };

export type ResultadoPolitica = "PERMITIDO" | "NEGADO_CLASSE" | "NEGADO_PAPEL" | "NEGADO_FLAG" | "NEGADO_DENY" | "NEGADO_SEM_MANIFESTO" | "NEGADO_ORIGEM";

export type CausaModelo =
  | "SEM_CHAVE"
  | "SEM_MODELO"
  | "TIMEOUT"
  | "HTTP_4XX"
  | "HTTP_5XX"
  | "REDE"
  | "RESPOSTA_INVALIDA"
  | "CIRCUITO_ABERTO"
  | "ORCAMENTO"
  | "INESPERADO";

/** Uma linha por chamada de modelo. Sem prompt, sem resposta, sem PII. */
export type ModelUsage = {
  correlationId: string;
  empresaId: string;
  estabelecimentoId: string | null;
  capacidade: string;
  workload: Workload;
  tier: TierModelo;
  provedor: IdProvedor;
  modelo: string;
  /** null ⇒ USO DESCONHECIDO (provedor sem `usage`, timeout, rede): nunca registrado como zero. */
  tokensEntrada: number | null;
  tokensSaida: number | null;
  tokensCache: number | null;
  duracaoMs: number;
  /** Custo estimado em micro-unidades da moeda configurada. null quando o preço não está configurado. */
  custoEstimadoMicros: number | null;
  moeda: string | null;
  sucesso: boolean;
  erro: CausaModelo | null;
  fallback: boolean;
  em: string;
};

/**
 * AI trace (operacional) ≠ auditoria de negócio. A auditoria de negócio continua nos serviços de domínio
 * (ex.: auditarMutacaoComercial). O trace só carrega identificadores e metadados.
 */
export type AuditTrace = {
  evento: "inteligencia.capacidade" | "inteligencia.conversa" | "inteligencia.operacao" | "inteligencia.documento";
  /** Id de rastreio ponta a ponta: correlationId (ou requestId sem correlação). */
  traceId: string;
  requestId: string;
  correlationId: string | null;
  /** Sempre null na V1: o Tenant Context não tem estabelecimento (gate de produção registrado). */
  estabelecimentoId: string | null;
  /** Skills aplicadas como `id@versao#hash8` (proveniência, nunca conteúdo). */
  skills: string[];
  /** Origem do julgamento JEV (REGRAS, COMBINADO com modelo, FALLBACK_REGRAS); null quando o JEV não rodou. */
  classificadorJev: string | null;
  /** Capacidade CONFIRM proposta ao Human Gate neste pedido (proposta, nunca execução). */
  propostaAcao: string | null;
  /** Versões dos contratos que decidiram o pedido (Tool Registry e Policy). */
  versaoRegistro: string;
  versaoPolitica: string;
  usuarioId: string | null;
  empresaId: string | null;
  capacidade: string | null;
  ferramenta: string | null;
  intencao: OrigemChamada | null;
  politica: ResultadoPolitica | null;
  humanGate: "NAO_SE_APLICA" | "RASCUNHO" | "PREVIEW" | "CONFIRMADO" | "CANCELADO" | "RECUSADO" | null;
  provedor: IdProvedor | null;
  modelo: string | null;
  tokensEntrada: number | null;
  tokensSaida: number | null;
  custoEstimadoMicros: number | null;
  ferramentasSolicitadas: string[];
  ferramentasExecutadas: string[];
  resultado: "sucesso" | "negado" | "invalido" | "desativado" | "fallback";
  codigo: string | null;
  estado: string | null;
  itens: number | null;
  causa: string | null;
  /** Resposta degradada (erro tratado com mensagem segura; o Core segue funcionando). */
  fallback: boolean;
  /** Alguma chamada de modelo caiu para outro provedor (só com AI_FALLBACK_ENABLED=true). */
  fallbackProvedor: boolean;
  /** Chamadas de modelo feitas neste pedido (tentativas e fallback incluídos). */
  chamadasModelo: number;
  duracaoMs: number;
};

/**
 * Complemento do Copiloto a uma resposta READ. É SEMPRE secundário aos dados: a explicação só reformula o que
 * está nos fatos/evidências (números e datas validados contra eles) e a próxima ação é uma SUGESTÃO de
 * procedimento — nunca executa nada, nunca é fonte de fato. A UI mostra cada parte com o seu rótulo.
 */
export type ComplementoCopiloto = {
  explicacao: { frases: string[]; origem: "MODELO"; aviso: string } | null;
  proximaAcao: { titulo: string; passos: string[]; destino: string | null; fonte: string } | null;
};

/** Uma leitura feita por um agente, pelo mesmo caminho do gateway (Policy + Tenant Context). */
export type SecaoAgente = { titulo: string; dados: RespostaLeitura | AtencaoHoje };

/**
 * Rascunho de texto de um agente (template de skill com marcadores preenchidos pelo Core). É SUGESTÃO para a equipe
 * revisar: nada é enviado. `pendentes` lista marcadores que o Core não tinha como preencher.
 */
export type SugestaoAgente = { titulo: string; texto: string; fonte: string; aviso: string; pendentes: string[] };
