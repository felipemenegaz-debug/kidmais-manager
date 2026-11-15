/**
 * Dois casos de papel, com regras DIFERENTES (124, plano r3 PAP-3):
 *
 * 1. Contrato histórico integrado (061): a versão 1 é a CONFERÊNCIA do contrato assinado em papel. Não há assinatura
 *    eletrônica, OTP, documento gerado nem comprovante digital — a prova é o original importado. Regra única para
 *    telas, PDFs e leituras: nunca apresentar essa versão como assinada eletronicamente nem abrir fluxo de assinatura.
 *    Predicado: `versaoConferenciaImportada`.
 *
 * 2. Contrato nativo em que o CLIENTE assinou o papel (124, PAPEL_CLIENTE): o buffet assinou eletronicamente, o
 *    documento revisado e o comprovante do buffet continuam valendo, e a Gestão registrou a data em que o cliente
 *    assinou o papel. Predicado: `versaoClienteAssinouEmPapel`. Nunca tratar como importação (não remove documentos).
 */
export const ACEITE_PAPEL = 'CONFERENCIA_PAPEL';
export const ACEITE_PAPEL_CLIENTE = 'PAPEL_CLIENTE';

type VersaoComMetodo = { aceiteMetodo?: string | null; aceite_metodo?: string | null; snapshot?: unknown } | null | undefined;

export function versaoConferenciaImportada(v: VersaoComMetodo) {
  if (!v) return false;
  if (v.aceiteMetodo === ACEITE_PAPEL || v.aceite_metodo === ACEITE_PAPEL) return true;
  const origem = (v.snapshot as { origem?: { tipo?: unknown } } | null | undefined)?.origem;
  return origem?.tipo === 'IMPORTACAO_HISTORICA';
}

export function versaoClienteAssinouEmPapel(v: VersaoComMetodo) {
  if (!v) return false;
  return v.aceiteMetodo === ACEITE_PAPEL_CLIENTE || v.aceite_metodo === ACEITE_PAPEL_CLIENTE;
}

/** 'YYYY-MM-DD' → 'dd/mm/aaaa', sem Date (a data civil nunca passa por fuso). */
export function dataCivilBr(data: string | null | undefined) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(data ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

export const TEXTO_ASSINADO_EM_PAPEL = 'Contrato assinado em papel, conferido pelo buffet na importação. Não há assinatura eletrônica nem comprovante digital: a prova é o documento original.';

export const textoClienteAssinouEmPapel = (data: string | null | undefined) =>
  `Assinado pelo cliente em papel em ${dataCivilBr(data)}.`;
