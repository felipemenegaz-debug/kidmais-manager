import type { RecursoId } from './catalogo';
export type AbaId = 'orcamento' | 'agenda' | 'contratos' | 'financeiro' | 'ia' | 'copiloto';
export type ConteudoAba = {nome:string; titulo:string; texto:string; itens:string[]; recursos:RecursoId[]};
export const abas: Record<AbaId, ConteudoAba> = {
    "orcamento": {
        "titulo": "Uma página do seu buffet que vende sozinha.",
        "texto": "O cliente consulta a data, escolhe pacote, horário e adicionais e vê o total na hora. Quando confirma, o contrato já sai preenchido.",
        "itens": [
            "Só aparecem datas e horários livres",
            "Preços de horário nobre e promocional",
            "Adicionais somados no orçamento"
        ],
        "nome": "Orçamento online",
        "recursos": [
            "orcamento"
        ]
    },
    "agenda": {
        "titulo": "Saiba na hora se a data está livre.",
        "texto": "Organize mais de um salão na mesma unidade. Acompanhe datas, horários, intervalos e ocupação de cada espaço conforme a configuração da agenda.",
        "itens": [
            "Vários salões da mesma unidade, com ocupação por espaço",
            "Bloqueio e liberação de datas",
            "Horários e intervalo mínimo entre festas"
        ],
        "nome": "Agenda",
        "recursos": [
            "agenda"
        ]
    },
    "contratos": {
        "titulo": "Contrato assinado sem ir até a loja.",
        "texto": "O contrato sai com o seu modelo, preenchido com pacote, adicionais e parcelas. O cliente confere e assina pelo celular, e você vê em que etapa cada um está.",
        "itens": [
            "Modelo de contrato da sua empresa",
            "Assinatura com código de confirmação",
            "Importação de contratos antigos em PDF"
        ],
        "nome": "Contratos",
        "recursos": [
            "contratos",
            "assinatura_whatsapp",
            "importacao_contratos"
        ]
    },
    "financeiro": {
        "titulo": "Recebimentos, despesas e caixa no mesmo lugar.",
        "texto": "Acompanhe parcelas, vencimentos e atrasos. Nos planos com financeiro completo, organize também despesas, fluxo de caixa e relatórios. O dinheiro das festas vai direto para a conta do buffet.",
        "itens": [
            "Contas a receber; contas a pagar no financeiro completo",
            "Pix copia e cola, recebimentos e saldos",
            "Fechamento financeiro por festa"
        ],
        "nome": "Financeiro",
        "recursos": [
            "financeiro",
            "pix"
        ]
    },
    "ia": {
        "titulo": "Seus documentos, prontos para revisão.",
        "texto": "Importe o modelo jurídico de contrato, os documentos das festas já fechadas e a tabela de preços em PDF. Confira os dados extraídos antes de aplicar ao sistema.",
        "itens": [
            "Modelo jurídico com cláusulas e campos automáticos",
            "Festas já fechadas: revisão de agenda e pagamentos",
            "Tabela de preços: pacotes, horários e adicionais"
        ],
        "nome": "Importação por IA",
        "recursos": [
            "importacao_precos",
            "importacao_contratos"
        ]
    },
    "copiloto": {
        "titulo": "Pergunte ao iA.Fest. Ele mostra o que precisa de você.",
        "texto": "O copiloto lê os dados que você já tem permissão para ver e aponta o que pede atenção, com o link para resolver. Quando você pede um cadastro, ele prepara o rascunho e abre o formulário preenchido. Nada é gravado sem a sua confirmação.",
        "itens": [
            "Contratos parados, festas com pendência e parcelas atrasadas",
            "Números sempre conferidos com os dados do sistema",
            "Prepara o cadastro, você revisa e confirma"
        ],
        "nome": "Copiloto",
        "recursos": [
            "copiloto"
        ]
    }
};
