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
};

export type IdSecao = "contratante" | "evento" | "pacote" | "buffet" | "valores" | "pagamentos" | "observacoes";

export type SecaoRevisao = {
  id: IdSecao;
  titulo: string;
  nota?: string;
  campos: CampoExtraido[];
};

export type ArquivoSelecionado = { nome: string; tipo: string; tamanhoBytes: number };

/**
 * `DEMONSTRACAO`: dados fixos de exemplo, sem leitura do arquivo.
 * Um futuro Import Engine deverá declarar a própria fonte; a UI mostra a diferença.
 */
export type FonteExtracao = "DEMONSTRACAO";

export type ExtracaoContrato = {
  fonte: FonteExtracao;
  arquivo: ArquivoSelecionado;
  secoes: SecaoRevisao[];
};

export type Extrator = (arquivo: ArquivoSelecionado) => ExtracaoContrato;
