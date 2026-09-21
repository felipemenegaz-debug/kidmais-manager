import { PagamentoServiceError } from './errors.ts';

export const erroCondicaoComercial = 'A forma de pagamento do plano deve respeitar a condição comercial da versão contratual vigente. Para alterá-la, crie uma revisão contratual.';

export function condicaoDoPlano(forma: unknown) {
  switch (forma) {
    case 'PIX_AVISTA': return { meio: 'PIX' as const, modalidades: ['AVISTA'] as const };
    case 'PIX_PARCELADO': return { meio: 'PIX' as const, modalidades: ['PARCELADO'] as const };
    case 'CARTAO_CIELO': return { meio: 'CARTAO' as const, modalidades: ['AVISTA', 'PARCELADO'] as const };
    default: return null;
  }
}

export function validarCondicaoContratual(forma: unknown, meio: string, modalidade: string) {
  const condicao = condicaoDoPlano(forma);
  if (!condicao || meio !== condicao.meio || !condicao.modalidades.some(item => item === modalidade)) {
    throw new PagamentoServiceError('PLANO_INCOMPATIVEL_COM_CONTRATO', erroCondicaoComercial, 409);
  }
}
