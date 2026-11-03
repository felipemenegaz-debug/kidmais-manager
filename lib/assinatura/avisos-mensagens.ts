import type { MensagemEmail } from '../acessos/email.ts';
import { ROTA_AJUDA } from '../suporte/rota.ts';
import type { MotivoAcesso, PrazosAcesso } from './acesso.ts';
import { diaBrasil, ultimoDiaBrasil, type MarcoAviso } from './avisos.ts';

/**
 * Textos dos avisos da assinatura (pt-BR). Só o necessário: nome da empresa, datas e os links de Assinatura e Ajuda.
 * Nunca valores, documento, dados de pagamento nem identificadores do provedor. A mensagem é gravada imutável na 087
 * e reenviada idêntica (mesma chave idempotente) em qualquer retentativa.
 */
export const PREFIXO_IDEMPOTENCIA_AVISO = 'kidmais-aviso-assinatura/';
export const ROTA_ASSINATURA = '/admin/assinatura';

const escapar = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const data = (fim: string | null) => (fim ? ultimoDiaBrasil(fim).split('-').reverse().join('/') : '');
/** Dia (Brasília) do próprio instante — o vencimento é o início da regularização, não um fim exclusivo. */
const vencimento = (instante: string) => diaBrasil(Date.parse(instante)).split('-').reverse().join('/');

/** Origem pública validada (https, ou http só em localhost). */
export function origemDosAvisos(origem: string) {
    const u = new URL(origem);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))
        throw new Error('Origem de aviso inválida.');
    return u.origin;
}

/** Nome da empresa numa linha só, curto o bastante para o assunto. */
export function nomeEmpresaAviso(nome: string) {
    const limpo = nome.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (limpo || 'Sua empresa').slice(0, 80);
}

function depoisDoAcesso(leituraDias: number) {
    return leituraDias > 0
        ? `a empresa fica em modo somente leitura por ${leituraDias} dias: os dados continuam guardados e podem ser consultados e exportados, mas não editados`
        : 'o acesso aos dados fica suspenso até a assinatura; os dados continuam guardados';
}

const CAUSA_LEITURA: Partial<Record<MotivoAcesso, string>> = {
    TESTE_ENCERRADO: 'O teste grátis terminou.',
    PAGAMENTO_PENDENTE: 'O pagamento da assinatura não foi confirmado no prazo.',
    CANCELADA: 'O período pago da assinatura cancelada terminou.',
    ENCERRADA: 'A assinatura foi encerrada.',
};

function conteudo(m: MarcoAviso, empresa: string, prazos: PrazosAcesso): { assunto: string; paragrafos: string[] } {
    const ate = data(m.ate);
    switch (m.tipo) {
        case 'TESTE_FIM_3_DIAS':
            return { assunto: `Seu teste grátis do Kidmais Manager termina em ${ate}`, paragrafos: [
                `O teste grátis de ${empresa} no Kidmais Manager vai até ${ate}.`,
                `Para continuar usando tudo sem interrupção, escolha um plano em Assinatura. Depois do teste, ${depoisDoAcesso(prazos.somenteLeituraDias)}.`,
            ] };
        case 'TESTE_FIM_HOJE':
            return { assunto: 'Hoje é o último dia do seu teste grátis do Kidmais Manager', paragrafos: [
                `Hoje (${ate}) é o último dia do teste grátis de ${empresa} no Kidmais Manager.`,
                `Para continuar usando tudo sem interrupção, escolha um plano em Assinatura. Depois do teste, ${depoisDoAcesso(prazos.somenteLeituraDias)}.`,
            ] };
        case 'PAGAMENTO_PENDENTE':
            return { assunto: 'Pagamento pendente da assinatura do Kidmais Manager', paragrafos: [
                `Ainda não identificamos o pagamento da assinatura de ${empresa} no Kidmais Manager, com vencimento em ${vencimento(m.marco)}.`,
                `O acesso continua completo até ${ate}. Depois disso, ${depoisDoAcesso(prazos.somenteLeituraDias)}. Para regularizar, acesse Assinatura e conclua o pagamento.`,
                'Se o pagamento já foi feito, não pague de novo e desconsidere esta mensagem: Pix e cartão são confirmados em minutos, e o boleto pode levar até 3 dias úteis depois do pagamento.',
            ] };
        case 'SOMENTE_LEITURA':
            return { assunto: `${empresa} está em modo somente leitura no Kidmais Manager`, paragrafos: [
                `${CAUSA_LEITURA[m.motivo] ?? 'A assinatura não está ativa.'} Por isso, ${empresa} está em modo somente leitura no Kidmais Manager.`,
                `Até ${ate} você pode consultar e exportar os dados. Depois, o acesso fica suspenso, mas os dados continuam guardados. Para voltar a editar, assine em Assinatura.`,
            ] };
        case 'SUSPENSAO_EM_7_DIAS':
            return { assunto: `O acesso de ${empresa} ao Kidmais Manager será suspenso depois de ${ate}`, paragrafos: [
                `O modo somente leitura de ${empresa} no Kidmais Manager vai até ${ate}. Depois disso, o acesso aos dados fica suspenso.`,
                'Os dados continuam guardados. Até lá você ainda pode consultar e exportar; para não perder o acesso, assine em Assinatura.',
            ] };
        case 'SUSPENSO':
            return { assunto: `O acesso de ${empresa} ao Kidmais Manager está suspenso`, paragrafos: [
                `O acesso aos dados de ${empresa} no Kidmais Manager está suspenso porque não há assinatura ativa.`,
                'Nada foi apagado: os dados continuam guardados. Para voltar a usar, acesse Assinatura e escolha um plano.',
            ] };
        case 'PAGAMENTO_CONFIRMADO':
            return { assunto: 'Pagamento confirmado: assinatura do Kidmais Manager ativa', paragrafos: [
                `Recebemos a confirmação do pagamento da assinatura de ${empresa} no Kidmais Manager.`,
                `A assinatura está ativa e o período pago vai até ${ate}. Os detalhes ficam em Assinatura.`,
            ] };
        case 'CANCELAMENTO_CONFIRMADO':
            if (m.motivo === 'CANCELADA_NO_PERIODO')
                return { assunto: 'Cancelamento da assinatura do Kidmais Manager confirmado', paragrafos: [
                    `O cancelamento da assinatura de ${empresa} no Kidmais Manager foi confirmado. Nenhuma nova cobrança será gerada.`,
                    `${m.ate ? `O acesso completo continua até ${ate}. Depois, ` : 'Depois do período pago, '}${depoisDoAcesso(prazos.somenteLeituraDias)}. Para voltar, assine de novo em Assinatura quando quiser.`,
                ] };
            return { assunto: 'Assinatura do Kidmais Manager encerrada', paragrafos: [
                `A assinatura de ${empresa} no Kidmais Manager foi encerrada. Nenhuma nova cobrança será gerada.`,
                m.ate
                    ? `A empresa fica em modo somente leitura até ${ate}, para consultar e exportar os dados. Para voltar a editar, assine de novo em Assinatura.`
                    : 'O acesso aos dados fica suspenso; os dados continuam guardados. Para voltar, assine de novo em Assinatura.',
            ] };
    }
}

export function mensagemAviso(input: { id: string; marco: MarcoAviso; empresa: string; para: string; origem: string; prazos: PrazosAcesso }): MensagemEmail {
    const origem = origemDosAvisos(input.origem);
    const empresa = nomeEmpresaAviso(input.empresa);
    const assinatura = `${origem}${ROTA_ASSINATURA}`, ajuda = `${origem}${ROTA_AJUDA}`;
    const { assunto, paragrafos } = conteudo(input.marco, empresa, input.prazos);
    const rodape = `Você recebe este aviso por fazer parte da Gestão de ${empresa} no Kidmais Manager.`;
    const texto = `${paragrafos.join('\n\n')}\n\nAssinatura: ${assinatura}\nAjuda: ${ajuda}\n\n${rodape}`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${paragrafos.map((p) => `<p>${escapar(p)}</p>`).join('')}`
        + `<p><a href="${escapar(assinatura)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#7C3AED;color:#fff;text-decoration:none">Abrir Assinatura</a></p>`
        + `<p>Dúvidas? <a href="${escapar(ajuda)}">Veja a Ajuda do Kidmais Manager</a>.</p>`
        + `<p style="color:#555;font-size:13px">${escapar(rodape)}</p></div>`;
    return { para: input.para, assunto: assunto.slice(0, 200), texto, html, idempotencia: `${PREFIXO_IDEMPOTENCIA_AVISO}${input.id}` };
}
