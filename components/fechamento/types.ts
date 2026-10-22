/** Ids dos sete pacotes do catálogo da Kidmais (endereço atual, dona da agenda pública). */
export type PacoteIdV1 =
  | "pocket"
  | "mini"
  | "compacta"
  | "essencial"
  | "completa"
  | "premium"
  | "pizza_party_scienza";

/**
 * Id do pacote na tela: na dona da agenda pública, um id V1; nas demais empresas (/b/<código> e agenda delas), o
 * código do pacote no banco (POCKET, P_9F…), inclusive os criados por "Novo pacote".
 */
export type PacoteId = PacoteIdV1 | (string & {});

export type FormaPagamento =
  | "pix_avista"
  | "pix_parcelado"
  | "cartao_cielo";

export type HorarioBase = "almoco" | "noite";
export type AjusteHorario = "-30" | "0" | "30";
export type StatusDisponibilidade = "disponivel" | "consulta" | "excecao" | "";
export type MomentoDefinicaoBuffet = "agora" | "depois";

export type FechamentoForm = {
  dataFesta: string;
  horarioBase: HorarioBase | "";
  ajusteHorario: AjusteHorario;
  statusDisponibilidade: StatusDisponibilidade;

  pacote: PacoteId | "";
  convidadosPagantes: number | "";

  buffetDefinicao: MomentoDefinicaoBuffet;
  buffetSalgados: string;
  buffetBebidas: string;
  buffetDoces: string;
  buffetBolo: string;
  buffetOutros: string;
  buffetLembrancinha: string;
  buffetEmpratado: string;
  buffetBombom: string;

  adicionaisSelecionados: string[];
  adicionaisQuantidades: Record<string, number>;
  /** Itens do buffet escolhidos em cada adicional de categoria (id do adicional → ids dos itens). */
  adicionaisEscolhas: Record<string, string[]>;
  alteracoesPacote: string;
  observacoesCliente: string;

  valorCombinado: string;

  nomeCliente: string;
  cpf: string;
  rg: string;
  email: string;
  telefone: string;
  whatsapp: string;

  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;

  outroResponsavel: string;

  nomeAniversariante: string;
  idadeAniversariante: number | "";
  temaFesta: string;

  formaPagamento: FormaPagamento | "";
  pixEntrada: string;
  pixParcela: string;
  pixQuantidade: string;
};
