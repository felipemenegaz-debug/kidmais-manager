import type { PedidoParar } from '../opt-out.ts';

/**
 * Wall-e — tipos do atendimento inteligente do WhatsApp.
 *
 * Divisão de responsabilidades (o modelo NUNCA escreve fato):
 *   1. entender  — o modelo (ou as regras locais) identifica intenções e dados citados; tudo é revalidado sem modelo
 *                  contra o texto do cliente e os catálogos da empresa (entendimento.ts);
 *   2. lembrar   — a memória da conversa junta o que já foi dito e aceita correções (contexto.ts);
 *   3. resolver  — cada intenção é respondida por fonte oficial do sistema, lida na hora (fontes-postgres.ts):
 *                  agenda real, preço calculado, pacotes, buffet, biblioteca PUBLICADA e autorizada, modelo de
 *                  contrato vigente com versão (resolver.ts);
 *   4. compor    — texto em linguagem simples + anexos autorizados, com a fonte de cada parte; decide responder,
 *                  perguntar o que falta ou passar para a equipe (o mais restritivo vence).
 */
export const INTENCOES = [
  'PRECOS', 'LOCALIZACAO', 'DISPONIBILIDADE', 'PACOTES', 'CARDAPIO', 'DECORACAO', 'CONTRATO', 'CONTRATO_PROPRIO',
  'CONTRATAR', 'CONFIRMACAO', 'DUVIDA', 'HUMANO', 'NEGOCIACAO', 'SAUDACAO', 'OUTRO', 'PARAR', 'EXTERNO',
] as const;
export type TipoIntencao = (typeof INTENCOES)[number];
/** Temas do modelo de contrato (condições gerais). SINAL não existe no modelo vigente: é dito claramente. */
export const TEMAS_CONTRATO = ['CANCELAMENTO', 'REMARCACAO', 'PAGAMENTO', 'SINAL', 'INADIMPLENCIA', 'CONVIDADOS', 'CORTESIA', 'HORARIOS', 'DANOS', 'BEBIDAS', 'LIMPEZA', 'BALOES', 'LEMBRANCINHAS', 'GERAL'] as const;
export type TemaContrato = (typeof TEMAS_CONTRATO)[number];

/** `continuacao`: mensagem só com dado ("e no segundo?", "e se for dia 06/02?") que segue o último assunto da conversa. */
/**
 * `soModelo` (rodada 31): assunto que só a interpretação do modelo viu (as regras não confirmam). Pode ACRESCENTAR
 * proteção (passar à equipe), mas não define sozinho o motivo quando há um motivo mais específico confirmado (instrução).
 */
/**
 * Rodada 32: consulta comum reconhecida por critério POSITIVO e restrito no texto do cliente, que afasta um cuidado visto
 * SÓ pelo modelo (política de combinação regras × modelo, docs §4.37): orçamento informado (não é proposta de desconto),
 * visita marcada (não é festa contratada) e disponibilidade contada pela equipe (não é pedido para manter ou alterar
 * condição). O resolvedor só afasta o cuidado com todos os sinais finais conferidos.
 */
export type CriterioConsultaComum = 'ORCAMENTO_INFORMADO' | 'VISITA_MARCADA' | 'DISPONIBILIDADE_ATRIBUIDA' | 'RESERVA_FINANCEIRA' | 'PRORROGACAO' | 'PERGUNTA_RESERVA';
export type Intencao = { tipo: TipoIntencao; trecho: string; perguntaId?: string | null; tema?: TemaContrato | null; continuacao?: boolean; soModelo?: boolean; consultaComum?: CriterioConsultaComum | null };
/** Dados citados pelo cliente NESTA mensagem (o que já foi dito antes fica na memória). */
export type Entidades = {
  data: string | null;            // AAAA-MM-DD
  turno: string | null;           // código do turno da agenda (configuracao_agenda)
  convidados: number | null;
  pacotes: string[];              // códigos de pacotes vigentes da empresa
  unidade: string | null;         // id do estabelecimento da empresa
  tema: string | null;            // tema da festa (texto livre curto, citado pelo cliente)
};
export type Entendimento = {
  intencoes: Intencao[];
  entidades: Entidades;
  /** Pedido para mandar de novo um material já enviado ("manda de novo"). */
  reenviar: boolean;
  /** Restrição alimentar/alergia: nunca respondida sem a equipe. */
  alergia: boolean;
  origem: 'MODELO' | 'REGRAS';
  /** Sinais determinísticos da triagem (JEV V1, sem modelo), entregues pela composição: reclamação, pagamento de uma
   *  festa e instrução embutida na mensagem. Sem eles (ausentes), o Wall-e segue só com o próprio entendimento. */
  sinais?: SinaisMensagem;
  /** Perguntas da mensagem que nenhuma fonte cobre ("tem wi-fi?"): respondido o resto, a conversa vai para a equipe. */
  semFonte?: string[];
  /** Pedido de parar (regras ou modelo com o trecho validado): INEQUIVOCO bloqueia; AMBIGUO vai para a equipe em silêncio. */
  parar?: PedidoParar | null;
  /** Pratos do buffet CADASTRADO citados ("tem coxinha?"), pelo catálogo da empresa. */
  itens?: string[];
  /** Comparação de pacotes ("a diferença dele pro Completa"): o pacote citado não troca o escolhido. */
  comparar?: boolean;
  /** "Não manda o PDF de novo": responde sem reenviar material. */
  semMaterial?: boolean;
  /** "Fica mais barato se mudar pra 06/02?": comparação de preço por condição (recalcula), não pedido de desconto. */
  comparaPreco?: boolean;
  /** "E num dia de semana sai mais barato?": comparação por OUTRA data sem dizer qual (o valor é por data). */
  outraData?: boolean;
  /** Rodada 42: o cliente escolheu um pacote sem pedir a contratação ("vamos de Completa"): o código do pacote. */
  escolhaPacote?: string;
  /** Rodada 43: o cliente pediu o link público (de novo). */
  pedeLink?: boolean;
  /** Rodada 43: o cliente pergunta se a data já ficou reservada (sem festa contratada ou pagamento na mensagem). */
  perguntaReserva?: boolean;
  /** Prato pedido pelo nome que não está no catálogo da empresa ("tem cachorro-quente no cardápio?"). */
  pratoSemCadastro?: string | null;
  /** "À tarde", "de tarde" (rodada 18): a tarde cobre o fim do primeiro horário e o começo do segundo — o período é
   *  confirmado com o cliente, nunca escolhido pelo Wall-e. */
  periodoAmbiguo?: boolean;
  /** Tema citado de forma ambígua ("princesa ou sereia", nome longo): não é anotado; o tema é confirmado (rodada 21). */
  temaAmbiguo?: boolean;
  /** Rodada 25: mês citado sem dia ("tem data livre em dezembro?"), guardado para completar um "dia 19" seguinte. */
  mesCitado?: number | null;
  /** Rodada 25: o dia citado não define a data (dois meses diferentes na mensagem): a data é confirmada, nada é calculado. */
  dataAmbigua?: boolean;
  /** Rodada 26: o ano está escrito na data ("14/11/2026"): a data não é só a proposta da próxima ocorrência. */
  anoCitado?: boolean;
  /** Rodada 26: concordância curta com o que foi proposto ("sim, pode seguir", "é essa mesmo"). */
  concorda?: boolean;
};

/** `pagamentoAcao`: pedido de pagar ou aviso de pagamento (chave pix, comprovante, "paguei"): sempre vai para a equipe. */
export type SinaisMensagem = { reclamacao: boolean; pagamento: boolean; instrucao: boolean; pagamentoAcao?: boolean };

export type TurnoAgenda = { codigo: string; nome: string; inicio: string; fim: string };
/** Catálogos da empresa usados para entender e revalidar (enumerações fechadas: nada fora deles é aceito). */
export type Catalogos = {
  pacotes: { codigo: string; nome: string }[];
  unidades: { id: string; nome: string }[];
  /** Unidades com agenda própria (062). Vazio: a agenda é da empresa inteira e a unidade não muda a disponibilidade. */
  unidadesAgenda?: string[];
  turnos: TurnoAgenda[];
  perguntas: { id: string; pergunta: string; resposta?: string }[];
  /** Nomes dos itens do buffet cadastrado nos pacotes vigentes (para reconhecer "tem coxinha?"). */
  itensBuffet?: string[];
  hoje: string;                   // AAAA-MM-DD na operação (America/Sao_Paulo)
};

export type CampoPendente = 'data' | 'turno' | 'convidados' | 'pacote' | 'unidade' | 'tema';
/** Memória do Wall-e na conversa (078: whatsapp_atendimento_conversas.contexto). */
export type ContextoWallE = {
  data?: string | null; turno?: string | null; convidados?: number | null; pacote?: string | null; unidade?: string | null; tema?: string | null;
  /** Rodada 25: mês citado sem dia, para o "dia N" seguinte. */
  mes?: number | null;
  /** Rodada 26: data confirmada pelo cliente para a contratação (ano escrito, ou "sim" à data completa proposta). */
  dataConfirmada?: string | null;
  referencias?: string[];
  /** Assuntos tratados na conversa (para o resumo da equipe), sem saudação/confirmação; os mais recentes. */
  assuntos?: TipoIntencao[];
  /** Temas das cláusulas citadas na ÚLTIMA mensagem (só os códigos, nenhum texto do cliente): o complemento seguinte
   * ("e se for só uns 15 min a mais?") é respondido pela mesma cláusula. */
  clausulas?: TemaContrato[];
  enviados?: { prontaId: string; versao: number; finalidade: string; em: string }[];
  /** `opcional`: convite depois de uma resposta completa ("se quiser, me conte o tema"), não uma pergunta que falta. */
  pendente?: { campos: CampoPendente[]; para: TipoIntencao; reperguntas?: number; opcional?: boolean; confirmarData?: string } | null;
  correcoes?: { campo: string; de: unknown; para: unknown; em: string }[];
  ultimoEntendimento?: Entendimento | null;
  /** Rodada 40: o Wall-e já se apresentou nesta conversa (a apresentação sai só na primeira resposta). */
  apresentado?: boolean;
  /** Rodada 40: o link público de disponibilidade já foi enviado (não volta a cada consulta de agenda). */
  linkDisponibilidade?: boolean;
  /** Rodada 40: quando o Wall-e fechou a última dúvida com "Posso ajudar com mais alguma coisa?" (não repete logo em seguida). */
  fechamentoEm?: string | null;
  /** Rodada 43: o aviso "a data só fica reservada com a contratação" já foi dado nesta conversa. */
  avisoReserva?: boolean;
};

/**
 * Escopo REAL da agenda consultada (062): a unidade só quando ela tem agenda própria (habilitada); EMPRESA = todas as
 * unidades da empresa (sem agenda separada por unidade); GERAL = agenda única da instalação (sem a 062).
 */
export type EscopoAgendaConsultado = { tipo: 'UNIDADE'; unidadeId: string } | { tipo: 'EMPRESA' } | { tipo: 'GERAL' };

/** Origem de cada fato da resposta (gravada em mensagens.fonte; interno). */
export type Fonte =
  | { tipo: 'PRONTA'; id: string; versao: number; finalidade: string }
  | { tipo: 'AGENDA'; data: string; escopo: EscopoAgendaConsultado['tipo']; unidade: string | null; consultadoEm: string }
  | { tipo: 'PACOTE'; codigo: string; id: string }
  | { tipo: 'TABELA_PRECO'; id: string; codigo: string }
  | { tipo: 'CONTRATO_MODELO'; modelo: string; versao: number; clausula: number; sha256: string }
  | { tipo: 'CATALOGO_BUFFET'; pacote: string }
  | { tipo: 'CONFIGURACAO'; perguntaId: string }
  /** Rodada 34: os períodos cadastrados na configuração da agenda (início e fim de cada horário). */
  | { tipo: 'PERIODOS_AGENDA' }
  | { tipo: 'LINK_CONTRATO' }
  /** Rodada 40: link público da página de disponibilidade/fechamento (o mesmo para todos; não reserva nada). */
  | { tipo: 'LINK_DISPONIBILIDADE' };

export type Anexo = { prontaId: string; versao: number; finalidade: string; tipo: 'IMAGEM' | 'VIDEO' | 'DOCUMENTO'; titulo: string; legenda: string | null; midiaUrl: string | null; arquivoId: string | null; nome: string | null };
/** Uma mensagem a enviar: texto, ou anexo com legenda. */
export type Saida = { texto: string | null; anexo: Anexo | null; fontes: Fonte[] };

export const MOTIVOS_PASSAGEM = ['PEDIDO_CLIENTE', 'NEGOCIACAO', 'INFORMACAO_INDISPONIVEL', 'CONTRATACAO', 'CONTRATO_PROPRIO', 'RESTRICAO_ALIMENTAR', 'RECLAMACAO', 'PAGAMENTO', 'INSTRUCAO_SUSPEITA', 'FALHA', 'PARAR_A_CONFIRMAR', 'BLOQUEADO_A_PEDIDO', 'SEM_RESPOSTA_AUTOMATICA', 'LIMITE_DIARIO'] as const;
export type MotivoPassagem = (typeof MOTIVOS_PASSAGEM)[number];
export const NOME_MOTIVO: Record<MotivoPassagem, string> = {
  PEDIDO_CLIENTE: 'Cliente pediu para falar com a equipe',
  NEGOCIACAO: 'Negociação ou exceção comercial',
  INFORMACAO_INDISPONIVEL: 'Informação não cadastrada no sistema',
  CONTRATACAO: 'Pronto para a equipe confirmar a contratação',
  CONTRATO_PROPRIO: 'Pedido sobre contrato particular',
  RESTRICAO_ALIMENTAR: 'Restrição alimentar ou alergia',
  RECLAMACAO: 'Reclamação ou insatisfação',
  PAGAMENTO: 'Pagamento ou cobrança de uma festa',
  INSTRUCAO_SUSPEITA: 'Mensagem com instruções ao sistema',
  FALHA: 'Falha ao consultar uma informação',
  PARAR_A_CONFIRMAR: 'Pedido para parar as mensagens, sem bloqueio definitivo (nada foi enviado; o Wall-e não responde mais esta conversa)',
  BLOQUEADO_A_PEDIDO: 'Contato pediu para não receber mensagens: bloqueado, nada será enviado',
  SEM_RESPOSTA_AUTOMATICA: 'Mensagem não respondida automaticamente (fila atrasada ou automação desligada): nada foi enviado ao cliente',
  LIMITE_DIARIO: 'Limite diário de respostas automáticas atingido: nada foi enviado ao cliente e o pedido não foi classificado',
};
/**
 * Frase de passagem ao CLIENTE (rodada 18): linguagem simples, sem motivo técnico ("instruções ao sistema",
 * "informação não cadastrada"). O motivo exato fica só no resumo da equipe (NOME_MOTIVO).
 */
export const PASSAGEM_AO_CLIENTE: Record<MotivoPassagem, string> = {
  PEDIDO_CLIENTE: 'Vou passar sua conversa para a equipe, como você pediu.',
  NEGOCIACAO: 'Vou passar sua conversa para a equipe avaliar com você.',
  INFORMACAO_INDISPONIVEL: 'Vou passar sua conversa para a equipe, que responde essa parte.',
  CONTRATACAO: 'Vou passar para a equipe confirmar disponibilidade, pacote e valores e seguir com a contratação. A data ainda não está reservada.',
  CONTRATO_PROPRIO: 'Vou passar sua conversa para a equipe, que cuida das festas já contratadas.',
  RESTRICAO_ALIMENTAR: 'Vou passar sua conversa para a equipe, que confirma os ingredientes com segurança.',
  RECLAMACAO: 'Sinto muito pelo ocorrido. Vou passar sua conversa para a equipe, que vai cuidar disso com você.',
  PAGAMENTO: 'Vou passar sua conversa para a equipe, que confere pagamentos e cobranças.',
  INSTRUCAO_SUSPEITA: 'Vou passar sua conversa para a equipe.',
  FALHA: 'Vou passar sua conversa para a equipe.',
  PARAR_A_CONFIRMAR: 'Vou passar sua conversa para a equipe.',
  BLOQUEADO_A_PEDIDO: 'Vou passar sua conversa para a equipe.',
  SEM_RESPOSTA_AUTOMATICA: 'Vou passar sua conversa para a equipe.',
  LIMITE_DIARIO: 'Vou passar sua conversa para a equipe.',
};
/** Resumo para a equipe na passagem (078: whatsapp_atendimento_conversas.passagem). */
export type Passagem = {
  motivo: MotivoPassagem; motivos: MotivoPassagem[]; em: string;
  coletado: { data: string | null; turno: string | null; convidados: number | null; pacote: string | null; unidade: string | null; tema: string | null };
  enviados: { titulo: string; finalidade: string }[];
  pendentes: string[];
  ultimaMensagem: string;
};

/**
 * `parar`: pedido inequívoco de parar — o worker bloqueia a conversa (definitivo), cancela as saídas na fila e não envia
 * nada. `silencio`: pedido ambíguo — nada é enviado e a conversa vai para a equipe (`passagem`), sem bloqueio.
 */
export type ResultadoWallE = { saidas: Saida[]; contexto: ContextoWallE; passagem: Passagem | null; parar?: boolean; silencio?: boolean; cuidadosAfastados?: Array<{ tipo: TipoIntencao; criterio: CriterioConsultaComum }> };
