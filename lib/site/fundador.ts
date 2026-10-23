/**
 * Textos da condição Fundador no site e na assinatura, a partir do resumo INDICATIVO da campanha (lib/assinatura/campanha).
 * Nunca inventa data nem estoque: sem campanha ativada vale a regra anterior (20 primeiros); com a campanha desligada,
 * antes da abertura ou sem leitura do banco, o texto não promete prazo nem vagas. A contratação sempre recalcula.
 * Reserva × confirmação e prazo de pagamento (D1/D3): textos únicos em lib/assinatura/textos-fundador.ts, com a redação
 * proposta pelo parecer jurídico de apoio de 22/10/2026 (ainda sem revisão profissional assinada).
 */
import { condicoesComerciais } from '../assinatura/planos-comerciais.ts';
import type { ResumoCampanha } from '../assinatura/campanha.ts';
import { REGRA_RESERVA } from '../assinatura/textos-fundador.ts';

const { descontoPercentual: pct, meses, vagas } = condicoesComerciais.fundador;
export type TextoFundador = { barra: string; titulo: string; descricao: string; faq: string; cta: string | null };

export function textoFundador(resumo: ResumoCampanha | null): TextoFundador {
    const base = `${pct}% de desconto por ${meses} meses em qualquer plano`;
    const opiniao = 'Também vamos pedir a sua opinião sobre o sistema e um depoimento depois de usar.';
    switch (resumo?.fase) {
        case 'LEGADO':
            return { barra: `${pct}% de desconto por ${meses} meses para os ${vagas} primeiros buffets.`,
                titulo: `Plano Fundador: ${vagas} vagas para os primeiros buffets que assinarem.`,
                descricao: `Desconto travado por ${meses} meses em qualquer plano, aplicado automaticamente enquanto houver vagas. ${opiniao}`,
                faq: `Uma condição para os ${vagas} primeiros buffets que assinarem: ${pct}% de desconto travado por ${meses} meses, aplicado automaticamente enquanto houver vagas. ${opiniao}`,
                cta: 'Quero uma vaga →' };
        case 'JANELA':
            return { barra: `${base} para quem assinar ${resumo.prazo.texto}.`,
                titulo: `Plano Fundador para quem assinar ${resumo.prazo.texto}.`,
                descricao: `${base}, sem limite de vagas até o prazo. ${REGRA_RESERVA} Depois do prazo, a condição segue para mais ${condicoesComerciais.fundador.vagas} buffets, por ordem de contratação. ${opiniao}`,
                faq: `Quem assinar ${resumo.prazo.texto} tem ${pct}% de desconto por ${meses} meses em qualquer plano, sem limite de vagas. Ao assinar, a condição fica reservada; ela é confirmada com o primeiro pagamento, feito até o fim do 7º dia seguinte (23h59, horário de Brasília). Depois do prazo, a condição segue para mais ${condicoesComerciais.fundador.vagas} buffets, por ordem de contratação.`,
                cta: 'Quero ser Fundador →' };
        case 'POS_JANELA':
            if (resumo.vagasRestantes > 0) return {
                barra: `${base}: restam ${resumo.vagasRestantes} de ${resumo.limite} vagas.`,
                titulo: `Plano Fundador: restam ${resumo.vagasRestantes} vagas.`,
                descricao: `${base}, por ordem de contratação. A vaga fica reservada ao assinar e o benefício é confirmado com o primeiro pagamento, feito até o fim do 7º dia seguinte (23h59, horário de Brasília). ${opiniao}`,
                faq: `As últimas ${resumo.limite} vagas Fundador vão por ordem de contratação: ${pct}% de desconto por ${meses} meses. Restam ${resumo.vagasRestantes}; a vaga é reservada na hora de assinar e confirmada com o pagamento.`,
                cta: 'Quero uma vaga →' };
            if (resumo.emConfirmacao > 0) return {
                barra: `Plano Fundador: vagas em confirmação.`, titulo: 'Plano Fundador: vagas em confirmação.',
                descricao: 'Todas as vagas estão reservadas e algumas aguardam pagamento. Se alguma for liberada, ela volta a ficar disponível na assinatura.',
                faq: 'As vagas Fundador estão reservadas e algumas aguardam confirmação de pagamento. A disponibilidade é conferida na hora de assinar.', cta: null };
            return encerrada();
        case 'ENCERRADA':
            return encerrada();
        default:
            // DESLIGADA, ANTES, sem banco ou erro: nada de prazo ou estoque.
            return { barra: `Plano Fundador: ${base}.`, titulo: `Plano Fundador: ${base}.`,
                descricao: `As condições, o prazo e as vagas são informados e confirmados na hora de assinar. ${opiniao}`,
                faq: `É uma condição de ${pct}% de desconto por ${meses} meses em qualquer plano. O prazo e as vagas são confirmados na hora de assinar.`, cta: 'Quero saber mais →' };
    }
}
function encerrada(): TextoFundador {
    return { barra: 'Plano Fundador encerrado. Obrigado a quem participou!', titulo: 'Plano Fundador encerrado.',
        descricao: 'As vagas Fundador foram preenchidas. Os planos seguem com os valores regulares.',
        faq: 'A campanha Fundador foi encerrada. Quem já é Fundador mantém o desconto até o fim dos 12 meses.', cta: null };
}
