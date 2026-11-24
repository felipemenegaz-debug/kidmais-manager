import { POLITICA_PRE_RESERVA } from './politica.ts';

export const VERSAO_TERMOS_PRE_RESERVA = '2026-11-21-r1';
export const TEXTO_CONFERENCIA_PIX = 'A equipe confere o Pix no horário de atendimento, e o horário só fica garantido depois da conferência.';

// Rascunho para revisão de Felipe. O valor em centavos é apresentado junto aos termos e gravado no aceite.
export const TERMOS_PRE_RESERVA = [
  'A pré-reserva é opcional. Você pode seguir com o pedido comum sem pagar o sinal. Se escolher a pré-reserva, pague por Pix o valor do sinal mostrado na oferta.',
  TEXTO_CONFERENCIA_PIX,
  'Até a conferência, outras pessoas podem reservar o horário. Se a equipe confirmar a garantia, ela vale por até ' +
    POLITICA_PRE_RESERVA.validadeHoras + ' horas ou até o início da festa, o que acontecer primeiro.',
  'Se faltarem menos de 24 horas para a festa na conferência ou se outro pedido já tiver garantido o horário, não há garantia e o Pix é devolvido por inteiro.',
  'Ao formalizar, o sinal da garantia entra como crédito se couber no valor do contrato. Se o contrato valer menos que o sinal, o Pix é devolvido por inteiro.',
  'Se você desistir da garantia ou se ela vencer antes de formalizar, o horário é liberado e o sinal fica a devolver. Seu pedido pode seguir em negociação. Se a garantia venceu, o sinal ainda pode virar crédito se o contrato for formalizado antes de a equipe assumir a devolução.',
  'O prazo de devolução é ' + POLITICA_PRE_RESERVA.prazoDevolucao + '.',
].join('\n\n');
