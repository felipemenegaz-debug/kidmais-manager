import { createHash } from 'node:crypto';

/**
 * Termos de uso e aviso de privacidade com VERSÃO registrada (E6/E10). O aceite grava documento, versão e o SHA-256 do
 * texto exato exibido (aceites_documentos_legais, 069): trocar uma vírgula muda o hash e exige nova versão.
 *
 * ATENÇÃO: os textos abaixo são MINUTAS técnicas para homologação. Não são textos legais definitivos e não podem ir a
 * produção sem revisão jurídica (decisão D11 da proposta). Lacunas que dependem de decisão estão marcadas [A DEFINIR].
 */
export type DocumentoLegal = 'TERMOS_USO' | 'PRIVACIDADE';
type Secao = { titulo: string; paragrafos: string[] };
export type TextoLegal = { documento: DocumentoLegal; titulo: string; versao: string; minuta: boolean; secoes: Secao[] };

const TERMOS: TextoLegal = {
    documento: 'TERMOS_USO', titulo: 'Termos de uso do Kidmais Manager', versao: '2026-10-07-minuta', minuta: true,
    secoes: [
        { titulo: 'Minuta', paragrafos: ['Este texto é uma minuta para homologação e será substituído pela versão revisada juridicamente antes da publicação.'] },
        { titulo: 'O serviço', paragrafos: ['O Kidmais Manager é um sistema de gestão para buffets infantis, contratado por empresa (CNPJ).'] },
        { titulo: 'Conta e responsável', paragrafos: [
            'Quem cria a conta declara agir em nome da empresa cadastrada. A validação dos dígitos do CNPJ não comprova a existência da empresa nem a autoridade de quem a cadastra.',
            'O responsável pelo uso pode ser diferente dos sócios. Ações com terceiros podem depender de aprovação da representação pela Kidmais.',
        ] },
        { titulo: 'Teste grátis e assinatura', paragrafos: [
            'A empresa recebe um período de teste sem cartão e sem cobrança automática, com duração informada no cadastro. Cada CNPJ tem um único teste.',
            'Preços, ciclos, renovação, inadimplência e cancelamento: [A DEFINIR].',
        ] },
        { titulo: 'Depois do teste ou da assinatura', paragrafos: [
            'Sem assinatura ativa, a empresa passa a somente leitura por um período e, depois, tem o acesso suspenso. Os dados não são apagados por vencimento e podem ser exportados.',
            'Prazo de retenção após o encerramento: [A DEFINIR].',
        ] },
        { titulo: 'Contato', paragrafos: ['Canal de atendimento, inclusive para cancelamento: [A DEFINIR].'] },
    ],
};

const PRIVACIDADE: TextoLegal = {
    documento: 'PRIVACIDADE', titulo: 'Aviso de privacidade do Kidmais Manager', versao: '2026-10-07-minuta', minuta: true,
    secoes: [
        { titulo: 'Minuta', paragrafos: ['Este texto é uma minuta para homologação e será substituído pela versão revisada juridicamente antes da publicação.'] },
        { titulo: 'Dados da conta', paragrafos: [
            'Coletamos nome, e-mail e senha (guardada só como hash) de quem cria a conta, e CNPJ, razão social, nome fantasia, telefone e sócios declarados da empresa.',
            'Registramos a versão destes documentos aceita, o horário e o endereço IP do aceite.',
        ] },
        { titulo: 'Dados dos clientes do buffet', paragrafos: ['Os dados que a empresa cadastra sobre os próprios clientes são tratados em nome dela. Acordo de tratamento de dados e lista de suboperadores: [A DEFINIR].'] },
        { titulo: 'Compartilhamento', paragrafos: ['Provedores de hospedagem, e-mail e cobrança recebem só o necessário para prestar o serviço. Lista de suboperadores: [A DEFINIR].'] },
        { titulo: 'Direitos e contato', paragrafos: ['Pedidos de acesso, correção, portabilidade e exclusão: canal [A DEFINIR]. Encarregado (DPO): [A DEFINIR].'] },
    ],
};

export const DOCUMENTOS: Record<DocumentoLegal, TextoLegal> = { TERMOS_USO: TERMOS, PRIVACIDADE };

/** Texto canônico (o que o hash cobre): título, versão e seções, sem formatação de tela. */
export function textoCanonico(d: TextoLegal) {
    return [d.titulo, `Versão ${d.versao}`, ...d.secoes.flatMap((s) => [s.titulo, ...s.paragrafos])].join('\n');
}
export function hashDocumento(d: TextoLegal) {
    return createHash('sha256').update(textoCanonico(d), 'utf8').digest('hex');
}
export function versaoVigente(documento: DocumentoLegal) {
    const d = DOCUMENTOS[documento];
    return { documento, versao: d.versao, hash: hashDocumento(d) };
}
