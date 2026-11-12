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

/**
 * O3 (opção A, 24/10/2026): com as vagas Fundador ocupadas e em confirmação a venda não trava. A tela avisa e oferece o preço
 * regular; a síntese repete que esta contratação não tem a condição, para a confirmação do preço ser explícita.
 */
export const AVISO_VAGAS_EM_CONFIRMACAO = 'As vagas Fundador estão em confirmação. Você pode assinar agora pelo preço normal ou aguardar: '
    + 'se uma vaga for liberada, a condição Fundador volta a aparecer aqui.';
export const SINTESE_SEM_FUNDADOR = 'Sem condição Fundador nesta contratação: as vagas estão em confirmação. O valor acima é o preço normal do plano.';

export const POS_PAGAMENTO_TARDIO = 'Se pagar depois, o pagamento será analisado pelo atendimento, sem cobrança complementar automática. '
    + 'A confirmação do benefício depende dessa análise e, se a contratação não puder ser efetivada, oferecemos uma solução, inclusive a devolução quando cabível.';

export const textoPagueAte = (dia: string) => `Condição Fundador reservada: pague até ${dataBr(dia)}, fim do dia (23h59, horário de Brasília). ${POS_PAGAMENTO_TARDIO}`;

export const textoReservaVencida = (dia: string) => `A condição Fundador reservada venceu em ${dataBr(dia)}, fim do dia (23h59, horário de Brasília), sem pagamento. `
    + 'Fale com o atendimento antes de pagar: um pagamento feito no prazo e ainda não confirmado é conferido, e nada é cobrado a mais automaticamente.';

export const PAGAMENTO_TARDIO = 'Pagamento recebido depois da validade da condição Fundador: a contratação fica em análise pelo atendimento, '
    + 'sem cobrança complementar automática. Se ela não puder ser efetivada, oferecemos uma solução, inclusive a devolução quando cabível.';

/**
 * Situação atual do benefício (diagnóstico de 25/10/2026), separada do comprovante do aceite. As datas são as persistidas
 * (fim calculado em UTC pelo banco); aqui só se apresenta em horário de Brasília, sem recalcular. Reserva nunca é
 * apresentada como benefício confirmado.
 */
export const NOTA_COMPROVANTE_BENEFICIO = 'O comprovante registra as condições aceitas na contratação; esta é a situação atual do benefício.';
export function dataHoraBrasilia(iso: string) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const p = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23', timeZone: 'America/Sao_Paulo' }).formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.day}/${p.month}/${p.year} às ${p.hour}:${p.minute}`;
}
export type BeneficioTexto = { situacao: 'RESERVADA' | 'CONFIRMADA_VIGENTE' | 'ENCERRADA'; confirmadaEm: string | null; beneficioFim: string | null };
export function textoBeneficioFundador(b: BeneficioTexto): string | null {
    if (b.situacao === 'RESERVADA')
        return 'Condição Fundador reservada, ainda não confirmada: o benefício de 12 meses começa com a confirmação do primeiro pagamento.';
    const inicio = b.confirmadaEm ? dataHoraBrasilia(b.confirmadaEm) : null, fim = b.beneficioFim ? dataHoraBrasilia(b.beneficioFim) : null;
    if (!inicio || !fim) return null;
    return b.situacao === 'CONFIRMADA_VIGENTE'
        ? `Condição Fundador confirmada em ${inicio}. Benefício de 12 meses vigente até ${fim} (horário de Brasília).`
        : `Condição Fundador encerrada: o benefício de 12 meses, confirmado em ${inicio}, terminou em ${fim} (horário de Brasília).`;
}
