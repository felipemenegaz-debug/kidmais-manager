// Entrada e saída em strings de centavos, como no painel serializado pela API.
export type EscolhaCredito = 'NAO_SE_APLICA' | 'MANTER' | 'SOLICITAR_DEVOLUCAO' | 'APROVEITAR';
export function projetarTratamento(obrigacaoReconhecida: string, recebidoLiquido: string, obrigacaoProjetada: string, reservado = '0') {
  const atual = BigInt(obrigacaoReconhecida), liquido = BigInt(recebidoLiquido), alvo = BigInt(obrigacaoProjetada);
  const saldo = alvo > liquido ? alvo - liquido : 0n;
  const credito = liquido > alvo ? liquido - alvo : 0n;
  const disponivel = credito > BigInt(reservado) ? credito - BigInt(reservado) : 0n;
  const aproveitamento = alvo > atual && liquido > atual;
  const opcoes: EscolhaCredito[] = credito === 0n ? ['NAO_SE_APLICA'] : aproveitamento ? ['APROVEITAR'] : credito > 0n
    ? ['MANTER', ...(disponivel > 0n ? ['SOLICITAR_DEVOLUCAO' as const] : [])] : ['NAO_SE_APLICA'];
  return { delta: (alvo - atual).toString(), saldo: saldo.toString(), credito: credito.toString(), disponivel: disponivel.toString(), opcoes };
}
export function serializarEscolhaCredito(escolha: EscolhaCredito | '', projecao: ReturnType<typeof projetarTratamento>) {
  if (!escolha || !projecao.opcoes.includes(escolha)) throw Error('Escolha como tratar o crédito projetado antes de continuar.');
  // A regularização reconhece o crédito. Solicitar/reservar a devolução é um ato posterior explícito.
  return escolha === 'SOLICITAR_DEVOLUCAO' ? 'MANTER' : escolha;
}
