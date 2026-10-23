/**
 * Texto do comprovante da contratação (grupo B, 096): sem dependências de servidor, usado na tela, na impressão e no
 * e-mail. Só dados do próprio contratante (documento mascarado) e da oferta.
 */
export type DocumentoComprovante = 'TERMOS_USO' | 'PRIVACIDADE' | 'DPA';
export type Contratante = { tipo: 'PF' | 'PJ'; nome: string | null; nomeComercial: string | null; documento: string | null };
export type Comprovante = {
    contratacaoId: string; registradoEm: string; contratante: Contratante;
    condicoes: { ofertaId: string; plano: string; ciclo: string; catalogoVersao: string; valorRegularCentavos: number; descontoPercentual: number; valorFinalCentavos: number;
        fundador: { reservada: boolean; pagueAte: string | null } | null };
    documentos: { documento: DocumentoComprovante; versao: string; hash: string }[];
    fornecedora: string; emailEnviadoEm: string | null; emailFalhouEm: string | null;
};

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataHoraBrasilia = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
export const TITULO_DOCUMENTO: Record<DocumentoComprovante, string> = { TERMOS_USO: 'Termos de uso', PRIVACIDADE: 'Aviso de privacidade', DPA: 'Acordo de Tratamento de Dados' };
/** Página pública com o texto integral arquivado de uma versão (096). */
export const linkVersao = (d: { documento: DocumentoComprovante; versao: string }) => `/documentos/${d.documento.toLowerCase()}/${d.versao}`;

export function linhaContratante(c: Contratante) {
    const doc = c.documento ? `, ${c.tipo === 'PF' ? 'CPF' : 'CNPJ'} ${c.documento}` : '';
    const buffet = c.nomeComercial && c.nomeComercial !== c.nome ? ` (buffet ${c.nomeComercial})` : '';
    return `${c.nome ?? '—'}${doc}${buffet}${c.tipo === 'PF' ? ', pessoa física em nome próprio' : ''}`;
}

export function linhasComprovante(c: Comprovante) {
    const k = c.condicoes;
    const linhas = [
        `Recebemos sua confirmação em ${dataHoraBrasilia(c.registradoEm)} (horário de Brasília).`,
        `Prestadora: ${c.fornecedora}.`,
        `Contratante: ${linhaContratante(c.contratante)}.`,
        `Oferta ${k.ofertaId}: plano ${k.plano.toLowerCase()}, ${k.ciclo === 'ANUAL' ? 'anual' : 'mensal'}, ${reais(k.valorFinalCentavos)}${k.ciclo === 'ANUAL' ? ' por ano' : ' por mês'}${k.descontoPercentual ? ` (${k.descontoPercentual}% de desconto Fundador sobre ${reais(k.valorRegularCentavos)})` : ''}. A assinatura renova ao fim de cada ciclo até ser cancelada.`,
    ];
    if (k.fundador?.reservada)
        linhas.push(k.fundador.pagueAte
            ? `A condição Fundador está reservada: pague até ${k.fundador.pagueAte.split('-').reverse().join('/')}, fim do dia (23h59, horário de Brasília). O benefício começa com a confirmação do pagamento.`
            : 'A condição Fundador está reservada; o benefício começa com a confirmação do pagamento.');
    for (const d of c.documentos)
        linhas.push(`${TITULO_DOCUMENTO[d.documento]}: versão ${d.versao}, impressão digital ${d.hash} (texto integral em ${linkVersao(d)}).`);
    linhas.push('Cancelamento, devolução e seus direitos legais: Termos de uso, seção “Cancelamento e devolução”.');
    return linhas;
}
