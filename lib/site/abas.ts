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
        "texto": "Datas, horários e salões num só calendário. Bloqueie dias e mostre a disponibilidade sem abrir planilha.",
        "itens": [
            "Vários salões ou espaços na mesma agenda",
            "Bloqueio e liberação de datas",
            "Aniversariantes e histórico de cada cliente"
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
        "titulo": "Cada parcela no Pix ou no cartão.",
        "texto": "As parcelas do contrato viram contas a receber. O cliente paga por Pix copia e cola ou cartão, e o dinheiro vai direto para a conta da sua empresa.",
        "itens": [
            "Contas a receber e a pagar",
            "Pix copia e cola e cartão em cada parcela",
            "Fechamento financeiro por festa"
        ],
        "nome": "Financeiro",
        "recursos": [
            "financeiro",
            "pix",
            "cartao"
        ]
    },
    "ia": {
        "titulo": "Mande o PDF. A IA monta os pacotes.",
        "texto": "Envie a sua tabela de preços e os seus contratos antigos em PDF. A IA encontra pacotes, grades de horário e adicionais e deixa tudo pronto para você revisar antes de publicar.",
        "itens": [
            "Leitura da tabela de preços em PDF",
            "Importação de contratos antigos",
            "Nada é publicado sem a sua revisão"
        ],
        "nome": "Importação por IA",
        "recursos": [
            "importacao_precos",
            "importacao_contratos"
        ]
    },
    "copiloto": {
        "titulo": "Pergunte ao Kidmais. Ele mostra o que precisa de você.",
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
