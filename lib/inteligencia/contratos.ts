import type { FocoConversa } from "./foco.ts";
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
  | "REVISAO_COMPLEXA"
  /** AI V1.1 (PR 6): plano estruturado curto (Planner por modelo), saída fechada e revalidada. */
  | "PLANEJAR";

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
  /**
   * AI V1.1 (PR 4): entidades devolvidas pelo Core, reutilizáveis por passos seguintes (referência e navegação) sem
   * pedir id ao operador. Ids e relações vêm SÓ do serviço de domínio, nunca do texto nem do modelo.
   */
  entidades?: EntidadeRef[];
};

export type TipoEntidade = "FESTA" | "CLIENTE" | "CONTRATO" | "ITEM" | "CATEGORIA";

/** Referência fechada de entidade. `tela` (lista de rotas-navegacao) permite navegar depois; `relacoes` vêm do Core. */
export type EntidadeRef = {
  tipo: TipoEntidade;
  id: string;
  rotulo: string;
  tela?: "cliente" | "contrato" | "festa" | "catalogo";
  relacoes?: { cliente?: string; contrato?: string; festa?: string; categoria?: string };
};

/** Resumo de uma leitura no trace (PR 4): só códigos e contagens — nunca rótulo, nome ou id. */
/** Resolução de referência no trace (PR 5): só códigos e contagens — nunca rótulo, nome, id ou texto. */
export type ReferenciaRastreio = {
  tipo: "TEMPORAL" | "DEITICO" | "PRONOME" | "NOME" | "IMPLICITA";
  alvo: TipoEntidade | null;
  origem: "TELA" | "FOCO" | "TEMPORAL" | "RELACAO_CORE" | "BUSCA" | null;
  resultado: "RESOLVIDA" | "AMBIGUA" | "NAO_ENCONTRADA" | "NEGADA";
  tipos: TipoEntidade[];
  candidatos: number;
};

/** Plano (PR 6) no trace: só códigos, contagens e durações — nunca id, nome, valor, parâmetro ou texto. */
export type OrigemPlano = "REGRAS" | "MODELO";
export type OrigemEntrada = "PARAMETROS" | "PASSO" | "CONTEXTO";
export type ResultadoPasso = "SUCESSO" | "SEM_DADOS" | "AMBIGUO" | "NEGADO" | "ERRO" | "PRECISA_CONFIRMACAO" | "NAO_EXECUTADO";
export type PlanoRastreio = {
  versao: string;
  origem: OrigemPlano;
  /** Por que o Planner foi chamado (código fechado). */
  motivo: "REFERENCIA" | "ULTIMO_CONTRATO" | "COMPOSICAO";
  objetivo: string | null;
  quantidadePassos: number;
  /** `fonte` (PR 6.4.2): de onde veio a entrada — id do passo (p1..p5), CONTEXTO ou null (parâmetros). Nunca um id do Core. */
  passos: Array<{ capacidade: string; origemEntrada: OrigemEntrada; fonte: string | null; resultado: ResultadoPasso; duracaoMs: number }>;
  resultadoFinal: ResultadoPasso;
  /** Onde parou: id do passo (p1..p5), FIM ou REJEITADO:<motivo>. */
  parada: string | null;
  /**
   * PR 6.2: por que parou (código fechado): null no FIM; estado do passo (SEM_DADOS, AMBIGUO, NEGADO, ERRO);
   * CONTEXTO_<resultado> quando a âncora de tela/foco falha antes da primeira leitura; ou o motivo da rejeição.
   */
  motivoParada: string | null;
  /**
   * PR 6.4: composição da resposta de leitura — quantas leituras entraram, fatos pedidos no texto (códigos) e os que
   * não foram obtidos do Core. null fora de resposta de leitura (navegação, proposta, parada).
   */
  composicao: { leituras: number; solicitados: string[]; faltando: string[] } | null;
  /**
   * PR 6.4.3: complemento determinístico ANTES da execução — capacidades acrescentadas para cobrir os fatos pedidos,
   * ou o motivo de não ter sido possível completar com segurança (códigos). null quando nada faltava.
   */
  complemento: { adicionados: string[]; marcados: string[]; impossivel: string | null } | null;
  /**
   * IA operacional: complementos DEPOIS da execução — fatos pedidos que os resultados não cobriram, buscados com a âncora
   * devolvida pelo Core (capacidades lidas, rodadas e por que parou; só códigos). Ausente fora da IA operacional.
   */
  aposExecucao?: { leituras: string[]; rodadas: number; parada: string | null };
  duracaoMs: number;
  usoModelo: boolean;
};

export type LeituraRastreio = {
  capacidade: string;
  tipos: TipoEntidade[];
  total: number;
  cardinalidade: "ZERO" | "UM" | "MULTIPLOS";
  relacoes: string[];
  duracaoMs: number;
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

/** O que aconteceu com o pedido (AI V1.1). Ver `entendimento.ts`. */
export type EstadoEntendimento =
  | "EXECUTADO"
  | "PRECISA_CONFIRMACAO"
  | "PRECISA_DADO"
  | "CAPACIDADE_INDISPONIVEL"
  | "NEGADO_POLITICA"
  | "AMBIGUO"
  | "NAO_ENTENDIDO";

/** Objetivo do pedido (ação × recurso), de listas fechadas. Descreve o pedido; nunca autoriza nem escolhe ferramenta. */
export type AcaoObjetivo = "CONSULTAR" | "LOCALIZAR" | "ABRIR" | "CRIAR" | "EDITAR" | "EXCLUIR" | "ENVIAR" | "REGISTRAR" | "CANCELAR";
export type RecursoObjetivo = "DASHBOARD" | "FESTA" | "CLIENTE" | "CONTRATO" | "PAGAMENTO" | "FINANCEIRO" | "AGENDA" | "CATEGORIA" | "ITEM" | "PACOTE" | "MENSAGEM" | "CONFIGURACAO" | "FECHAMENTO";
export type ObjetivoIA = `${AcaoObjetivo}:${RecursoObjetivo}`;

/** Resultado da navegação no trace (só códigos). */
export type NavegacaoRastreio = {
  recurso: RecursoObjetivo | null;
  tela: string | null;
  resultado: "NAVEGADO" | "AMBIGUO" | "SEM_DESTINO" | "NEGADO" | "DESTINO_INVALIDO";
  motivo: string | null;
};

export type AIResponse = (
  /** `atencao_hoje` (V1) mantém o próprio formato; as demais leituras usam RespostaLeitura. */
  | { tipo: "resposta"; dados: RespostaLeitura | AtencaoHoje; complemento?: ComplementoCopiloto }
  /** Agente (V1): seções de leituras REAIS já autorizadas + rascunho rotulado. Nunca executa. */
  | { tipo: "agente"; agente: { id: string; nome: string }; resumo: string; secoes: SecaoAgente[]; sugestao: SugestaoAgente | null }
  | { tipo: "rascunho"; rascunho: RascunhoPublico; pergunta: string; faltando: string[] }
  | { tipo: "preview"; rascunho: RascunhoPublico }
  | { tipo: "resultado_acao"; rascunho: RascunhoPublico; mensagem: string; destino?: string }
  | { tipo: "nao_suportado"; mensagem: string; sugestoes: string[] }
  | { tipo: "precisa_contexto"; mensagem: string }
  /**
   * Navegação interna (AI V1.1, PR 3): destino SÓ da lista fechada de rotas (rotas-navegacao.ts), revalidado aqui e
   * na UI antes de navegar. Não altera estado; a UI navega sozinha porque o pedido foi um comando explícito.
   */
  | { tipo: "navegacao"; tela: string; recurso: RecursoObjetivo; destino: string; rotulo: string; proposta?: RascunhoPublico }
) & {
  /** Fixado pela conversa em toda resposta (quem decide explicitamente, como um agente, pode antecipar). */
  entendimento?: EstadoEntendimento;
  objetivo?: ObjetivoIA | null;
  /** AI V1.1 (PR 5): foco da conversa (entidades recentes, com rótulo só para a UI). A UI reenvia tipo + id como dica. */
  foco?: FocoConversa;
  /**
   * IA operacional: pergunta de parâmetro pendente (ex.: docinhos por convidado). A UI reenvia com a próxima mensagem
   * como DICA (categoria fechada + números já informados); o servidor relê a festa e recalcula tudo.
   */
  continuacao?: ContinuacaoConsumo;
  /** IA operacional: rascunho preservado enquanto esta consulta foi respondida (retomável respondendo à pergunta dele). */
  rascunhoPausado?: { operacaoId: string; titulo: string; pergunta: string | null };
};

export type ContinuacaoConsumo = {
  tipo: "PARAMETRO_CONSUMO";
  categoria: "DOCES" | "REFRIGERANTES";
  perguntado: "POR_CONVIDADO" | "ML_POR_CONVIDADO" | "EMBALAGEM";
  parametros?: { porConvidado?: number; mlPorConvidado?: number; embalagemMl?: number; margemPercentual?: number };
};

export type ResultadoPolitica = "PERMITIDO" | "NEGADO_CLASSE" | "NEGADO_PAPEL" | "NEGADO_FLAG" | "NEGADO_DENY" | "NEGADO_SEM_MANIFESTO" | "NEGADO_ORIGEM" | "NEGADO_ESTABELECIMENTO";

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

/**
 * Metadado SANEADO de uma recusa/erro do provedor (H3). Só status HTTP e os identificadores estruturados do corpo de
 * erro (`error.type`, `error.code`, `error.param`), cada um restrito a um alfabeto seguro e curto. Nunca mensagem,
 * corpo, prompt, cabeçalho ou chave. Campo ausente/fora do alfabeto ⇒ null.
 */
export type DetalheErroProvedor = {
  status: number | null;
  tipo: string | null;
  codigo: string | null;
  parametro: string | null;
};

/** Erro de modelo no trace: causa classificada + workload + detalhe saneado (nulls quando o provedor não informou). */
export type ErroModeloRastreio = { causa: CausaModelo; workload: Workload } & DetalheErroProvedor;

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
  /** H3: detalhe saneado do erro do provedor, só para o trace; a 055a persiste apenas a causa em `erro`. */
  detalheErro?: DetalheErroProvedor | null;
  fallback: boolean;
  em: string;
};

/**
 * AI trace (operacional) ≠ auditoria de negócio. A auditoria de negócio continua nos serviços de domínio
 * (ex.: auditarMutacaoComercial). O trace só carrega identificadores e metadados.
 */
export type AuditTrace = {
  evento: "inteligencia.capacidade" | "inteligencia.conversa" | "inteligencia.operacao" | "inteligencia.documento" | "inteligencia.custos";
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
  /**
   * Uso de modelo ACUMULADO no pedido (todas as chamadas: intenção, JEV, explicação, retries e fallback).
   * `custoEstimadoMicros` só é conhecido se TODAS as chamadas tiverem custo conhecido na mesma moeda; senão fica
   * null e `chamadasCustoDesconhecido` conta as desconhecidas, preservando o subtotal conhecido.
   */
  tokensTotal: number | null;
  custoConhecidoMicros: number;
  moedaCusto: string | null;
  chamadasCustoDesconhecido: number;
  chamadasTokensDesconhecidos: number;
  /** Soma das latências das chamadas de modelo (a duração total do pedido é `duracaoMs`). */
  duracaoModeloMs: number;
  /** H3: erros das chamadas de modelo deste pedido (causa + workload + status/type/code/param saneados), no máximo 5. */
  errosModelo: ErroModeloRastreio[];
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
  /** AI V1.1: estado de entendimento e objetivo (enums fechados), também em pedidos de contexto, recusas e erros. */
  entendimento: EstadoEntendimento | null;
  objetivo: ObjetivoIA | null;
  /** AI V1.1 (PR 3): navegação pedida neste pedido (tela da lista fechada, nunca a URL); null quando não houve. */
  navegacao: NavegacaoRastreio | null;
  /** AI V1.1 (PR 4): leituras executadas neste pedido (entidades, cardinalidade, relações, duração), até 10. */
  leituras: LeituraRastreio[];
  /** AI V1.1 (PR 5): referências resolvidas neste pedido (tipo, alvo, origem, resultado, tipos e nº de candidatos). */
  referencias: ReferenciaRastreio[];
  /** AI V1.1 (PR 6): plano executado neste pedido (origem, objetivo, passos com resultado e duração); null sem plano. */
  plano: PlanoRastreio | null;
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
