/**
 * Modelo da revisão de um contrato histórico importado.
 *
 * Não há percentual de confiança: cada campo tem só um estado verificável pelo operador.
 * O contrato histórico é preservado como está (pacote, itens, valores e condições originais);
 * nada aqui recalcula com catálogo ou preço atual.
 */
export type EstadoCampo = "ENCONTRADO" | "PRECISA_REVISAO" | "NAO_ENCONTRADO";

export type CampoExtraido = {
  id: string;
  rotulo: string;
  /** Texto como aparece no contrato. `null` quando não encontrado. */
  valor: string | null;
  estado: EstadoCampo;
  /** Onde o dado foi encontrado no documento (página/cláusula). */
  origem?: string;
  /** Por que precisa de revisão ou o que fazer quando não foi encontrado. */
  motivo?: string;
  /** Extração real: página e trecho curto, conferidos contra o texto do documento. */
  evidencia?: { pagina: number | null; trecho: string; conferida: boolean; inicio?: number; fim?: number };
  /** Importação real: texto como lido (ou digitado), nunca reescrito. */
  bruto?: string | null;
  /** Importação real: valor normalizado pelo validador. Só existe quando `validacao` não é falha. */
  normalizado?: string | null;
  validacao?: EstadoValidacao;
  /** Conflito com outro campo (soma, parcelas, horário × duração, convidados × pacote). */
  conflito?: string;
  confirmacao?: ConfirmacaoCampo;
  /** Leitura independente pelo modelo ATIVO da empresa. Divergente do valor atual ⇒ conflito "Precisa revisão". */
  alternativa?: { valor: string; pagina: number | null; trecho: string };
  /** Valor sugerido a partir de outro campo (ex.: WhatsApp = celular único): sempre pede confirmação humana. */
  inferido?: string;
  /** Valor lido que não pode ser usado neste papel (ex.: CNPJ da contratada no lugar do cliente): corrigir ou remover. */
  bloqueio?: string;
  /** Bloqueio por ambiguidade (ex.: mais de um CPF na qualificação): validação AMBIGUO, o operador digita o certo. */
  ambiguo?: true;
};

/**
 * Validação do valor (importação real). Nunca há normalização silenciosa: o bruto fica ao lado do
 * normalizado, e só um valor aceito pelo validador tem normalizado utilizável.
 * - VALIDO: o validador aceitou o texto inteiro.
 * - INVALIDO / AMBIGUO / NAO_REPRESENTAVEL: recusado; bloqueia a importação até o operador corrigir ou remover.
 * - PRECISA_REVISAO: valor aceito, mas em conflito com outro campo ou sem trecho conferido no documento.
 */
export type EstadoValidacao = "VALIDO" | "INVALIDO" | "AMBIGUO" | "NAO_REPRESENTAVEL" | "PRECISA_REVISAO";

/**
 * Confirmação humana amarrada ao que foi visto. LEITURA: "o documento diz isto" (sem trecho conferido).
 * DIVERGENCIA: "confirmo que o contrato histórico contém este valor divergente". Mudou o valor ou o
 * conflito ⇒ a assinatura muda e a confirmação deixa de valer.
 */
export type ConfirmacaoCampo = { tipo: "LEITURA" | "DIVERGENCIA"; assinatura: string };

export type IdSecao = "contratante" | "endereco" | "evento" | "pacote" | "buffet" | "valores" | "pagamentos" | "observacoes";

export type SecaoRevisao = {
  id: IdSecao;
  titulo: string;
  nota?: string;
  campos: CampoExtraido[];
};

export type ArquivoSelecionado = { nome: string; tipo: string; tamanhoBytes: number };

/**
 * `DEMONSTRACAO`: dados fixos de exemplo, sem leitura do arquivo.
 * `DOCUMENTO`: leitura real do arquivo enviado (texto nativo, visão ou regras), com evidência por campo.
 */
export type FonteExtracao = "DEMONSTRACAO" | "DOCUMENTO";

export type ExtracaoContrato = {
  /** Leitura de recebimentos explícitos no texto original, sem baixa automática. */
  recebimentosDocumento?: import('./recebimentos.ts').LeituraRecebimentos;
  fonte: FonteExtracao;
  arquivo: ArquivoSelecionado;
  secoes: SecaoRevisao[];
  /**
   * Versão da leitura que montou esta revisão. Ausente = v1 (gravada antes de 31/10/2026): nunca leu CNPJ, então o
   * contratante é pessoa física como sempre foi. A partir da v2 o tipo de pessoa precisa estar resolvido (R21-1).
   */
  versaoLeitura?: number;
  /** Modelo ATIVO da empresa usado como referência (id e versão lidos na transação da empresa). */
  modeloReferencia?: { id: string; versao: number } | null;
};

export type Extrator = (arquivo: ArquivoSelecionado) => ExtracaoContrato;
