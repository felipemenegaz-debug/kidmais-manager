/**
 * Contrato histórico integrado (061): a versão 1 é a CONFERÊNCIA do contrato assinado em papel. Não há assinatura
 * eletrônica, OTP, documento gerado nem comprovante digital — a prova é o original importado. Regra única para
 * telas, PDFs e leituras: nunca apresentar essa versão como assinada eletronicamente nem abrir fluxo de assinatura.
 */
export const ACEITE_PAPEL = 'CONFERENCIA_PAPEL';

export function versaoAssinadaEmPapel(v: { aceiteMetodo?: string | null; aceite_metodo?: string | null; snapshot?: unknown } | null | undefined) {
  if (!v) return false;
  if (v.aceiteMetodo === ACEITE_PAPEL || v.aceite_metodo === ACEITE_PAPEL) return true;
  const origem = (v.snapshot as { origem?: { tipo?: unknown } } | null | undefined)?.origem;
  return origem?.tipo === 'IMPORTACAO_HISTORICA';
}

export const TEXTO_ASSINADO_EM_PAPEL = 'Contrato assinado em papel, conferido pela Kidmais na importação. Não há assinatura eletrônica nem comprovante digital: a prova é o documento original.';
