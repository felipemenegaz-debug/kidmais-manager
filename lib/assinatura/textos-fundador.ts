/**
 * Textos da reserva Fundador (D1/D3 de 22/10/2026), com a redação proposta no parecer jurídico de apoio (§6, 22/10/2026):
 * a condição fica RESERVADA ao confirmar plano e valor e é CONFIRMADA com o primeiro pagamento; o prazo vai até o fim do
 * 7º dia (23h59, horário de Brasília), contado em dias de calendário, não em 168 horas; pagamento tardio vai para análise
 * do atendimento, sem cobrança complementar automática. O prazo de pagamento não é o prazo de arrependimento.
 * Um único lugar para site, tela de assinatura e mensagens de domínio: nada aqui decide data, estoque ou prazo de retorno.
 */
import { condicoesComerciais } from './planos-comerciais.ts';
import { REGRA_APROVADA } from './campanha.ts';

const DIAS = REGRA_APROVADA.validadeDias;
const { meses } = condicoesComerciais.fundador;

/** AAAA-MM-DD → DD/MM/AAAA. */
export const dataBr = (iso: string) => iso.split('-').reverse().join('/');

export const REGRA_RESERVA = `Assinar é confirmar, na sua conta, o plano e o valor com a condição Fundador: a condição fica reservada para você. `
    + `Pague até o fim do ${DIAS}º dia seguinte à confirmação, às 23h59 (horário de Brasília), na data indicada na tela. `
    + `O prazo conta dias de calendário, não ${DIAS * 24} horas. O pagamento dentro desse prazo preserva a condição mesmo depois do fim da campanha, `
    + `e os ${meses} meses começam com a confirmação do primeiro pagamento. Esse prazo de pagamento não se confunde com o direito de arrependimento.`;

/**
 * Regra anterior à campanha (LEGADO, 20 primeiros): a concessão não tem validade (`oferta_valida_ate` nula por CHECK da
 * 090; D4) e confirma pelo valor contratado. Sem prazo de pagamento nem campanha a citar (O1 do diagnóstico de 24/10/2026).
 */
export const REGRA_RESERVA_LEGADO = `Assinar é confirmar, na sua conta, o plano e o valor com a condição Fundador: a condição fica reservada para você `
    + `e é confirmada com o primeiro pagamento, quando começam os ${meses} meses. Esse pagamento não se confunde com o direito de arrependimento.`;

/** Só a campanha (JANELA e lote posterior) tem a validade de 7 dias; qualquer outra fase usa a regra sem prazo. */
export const regraReservaDaFase = (fase: string | null | undefined) =>
    fase === 'JANELA' || fase === 'POS_JANELA' ? REGRA_RESERVA : REGRA_RESERVA_LEGADO;

export const POS_PAGAMENTO_TARDIO = 'Se pagar depois, o pagamento será analisado pelo atendimento, sem cobrança complementar automática. '
    + 'A confirmação do benefício depende dessa análise e, se a contratação não puder ser efetivada, oferecemos uma solução, inclusive a devolução quando cabível.';

export const textoPagueAte = (dia: string) => `Condição Fundador reservada: pague até ${dataBr(dia)}, fim do dia (23h59, horário de Brasília). ${POS_PAGAMENTO_TARDIO}`;

export const textoReservaVencida = (dia: string) => `A condição Fundador reservada venceu em ${dataBr(dia)}, fim do dia (23h59, horário de Brasília), sem pagamento. `
    + 'Fale com o atendimento antes de pagar: um pagamento feito no prazo e ainda não confirmado é conferido, e nada é cobrado a mais automaticamente.';

export const PAGAMENTO_TARDIO = 'Pagamento recebido depois da validade da condição Fundador: a contratação fica em análise pelo atendimento, '
    + 'sem cobrança complementar automática. Se ela não puder ser efetivada, oferecemos uma solução, inclusive a devolução quando cabível.';
