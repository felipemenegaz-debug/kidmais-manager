import type { AdicionalSelecionadoInput, ResumoComercial } from "../../comercial/services";
import type { PretensaoPixInput } from "../../comercial/condicao-pagamento";
import type {
  AprovacaoNegociacaoRecord,
  BuffetStatus,
  FechamentoAdicionalRecord,
  FechamentoRecord,
  FormaPagamentoPretendida,
  OrigemFechamento,
} from "../repositories";

export type CriarFechamentoComercialInput = {
  dataEvento: string;
  horarioInicio: string;
  horarioFim: string;
  configuracaoAgendaId: string;
  pacoteId: string;
  convidados: number;
  adicionais?: AdicionalSelecionadoInput[];

  /** Valor efetivamente proposto pelo cliente/atendimento. */
  valorProposto: number;

  origemFechamento: OrigemFechamento;
  clienteId?: string | null;
  aniversarianteId?: string | null;
  iniciadoPorUsuarioId?: string | null;
  usuarioResponsavelId?: string | null;
  responsavelAdicionalId?: string | null;
  idadeAniversarianteEvento?: number | null;
  temaFesta?: string | null;
  formaPagamentoPretendida?: FormaPagamentoPretendida | null;
  condicaoPixPretendida?: PretensaoPixInput | null;
  alteracoesPacote?: string | null;
  observacoesCliente?: string | null;
  buffetSalgados?: string | null;
  buffetBebidas?: string | null;
  buffetDoces?: string | null;
  buffetBolo?: string | null;
  buffetOutros?: string | null;
  buffetLembrancinha?: string | null;
  buffetEmpratado?: string | null;
  buffetBombom?: string | null;

  motivoNegociacao?: string | null;
  observacoesNegociacao?: string | null;
  observacoesEquipe?: string | null;
  buffetStatus?: BuffetStatus;
};

export type CriarFechamentoComercialResult = {
  fechamento: FechamentoRecord;
  adicionais: FechamentoAdicionalRecord[];
  aprovacaoNegociacao: AprovacaoNegociacaoRecord | null;
  resumoComercial: ResumoComercial;
  negociacaoNecessaria: boolean;
};
