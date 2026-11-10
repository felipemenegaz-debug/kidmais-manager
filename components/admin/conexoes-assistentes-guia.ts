import type { AssistenteId } from '@/lib/integracoes/oauth/situacao-conexao';

/**
 * Textos do guia de conexão. Passos e links conferidos na documentação oficial em 06/11/2026; os fabricantes mudam menus,
 * por isso a tela sempre aponta a ajuda oficial e avisa que os nomes podem variar. Só links publicados por eles: nada de
 * link direto inventado nem promessa de conexão em um clique.
 */
export const GUIA_CONFERIDO_EM = '06/11/2026';

export type GuiaAssistente = {
    id: AssistenteId;
    nome: string;
    resumo: string;
    configurar: readonly string[];
    avisos: readonly string[];
    links: ReadonlyArray<{ rotulo: string; url: string }>;
    habilitarNaConversa: string;
};

export const GUIAS: Readonly<Record<AssistenteId, GuiaAssistente>> = {
    chatgpt: {
        id: 'chatgpt',
        nome: 'ChatGPT',
        resumo: 'Adicionado como servidor MCP personalizado, na versão web.',
        configurar: [
            'Na versão web do ChatGPT, abra a página de plugins (botão abaixo).',
            'Clique em + e escolha “Add custom MCP server”.',
            'Dê o nome iA.Fest e cole o endereço em “Server URL”.',
            'Escolha OAuth na autenticação. Se aparecer a escolha de como registrar o cliente, use Client ID Metadata Document (CIMD) e não informe client ID nem secret próprios.',
            'Leia o aviso de risco e confirme.',
            'Clique em “Create as a plugin” e instale o plugin criado.',
        ],
        avisos: [
            'Depende do seu plano e das permissões do espaço de trabalho, que podem bloquear conectores personalizados.',
        ],
        links: [
            { rotulo: 'Abrir plugins do ChatGPT', url: 'https://chatgpt.com/plugins' },
            { rotulo: 'Ver instruções da OpenAI', url: 'https://developers.openai.com/api/docs/guides/custom-mcp-server' },
        ],
        habilitarNaConversa: 'Na conversa, digite @ no campo de mensagem e selecione o plugin iA.Fest.',
    },
    claude: {
        id: 'claude',
        nome: 'Claude',
        resumo: 'Adicionado como conector personalizado.',
        configurar: [
            'No Claude, abra Customize → Connectors.',
            'Clique em + Add e escolha “Add custom connector”.',
            'Dê o nome iA.Fest, cole o endereço e clique em Continue.',
            'Revise a autenticação detectada e clique em Continue.',
            'Em Authentication, escolha “Sign in now” ou “Sign in when needed”; não use “No sign in”.',
            'Em OAuth client, escolha “Use Claude’s published identity”. O iA.Fest não aceita “Register automatically” nem cliente próprio.',
            'Deixe Request headers em branco e conclua em Add.',
        ],
        avisos: [
            'No plano Free, o limite é de um conector personalizado.',
            'Em Team e Enterprise, quem adiciona é o responsável pela organização, em Organization settings → Connectors, com as mesmas escolhas; depois cada pessoa abre Customize → Connectors e clica em Connect.',
        ],
        links: [
            { rotulo: 'Ver instruções da Anthropic', url: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp' },
        ],
        habilitarNaConversa: 'Na conversa, clique em + no canto inferior esquerdo, abra Connectors e ligue o iA.Fest.',
    },
};

export const LISTA_ASSISTENTES: readonly AssistenteId[] = ['chatgpt', 'claude'];

/** Só leitura. A ordem coloca a ajuda primeiro; financeiro nunca começa marcado (ESCOPOS_INICIAIS). */
export const ROTULO_ESCOPO: Readonly<Record<string, string>> = {
    'conhecimento:read': 'Consultar ajuda e documentação',
    'agenda:read': 'Consultar resumo da agenda',
    'financeiro:read': 'Consultar resumo dos recebíveis',
};

export const ORDEM_ESCOPOS: readonly string[] = ['conhecimento:read', 'agenda:read', 'financeiro:read'];

/** Começa só com a ajuda: agenda e financeiro exigem marcação da própria pessoa, mesmo que o assistente peça tudo. */
export const ESCOPOS_INICIAIS: readonly string[] = ['conhecimento:read'];

/** Primeira consulta: documental, sem dado da empresa. Confirmação só pela chamada real registrada no iA.Fest. */
export const PERGUNTA_PRIMEIRA_CONSULTA = 'Use o iA.Fest para buscar na documentação “como desconectar assistentes”, com limite 1, e informe o título, a seção e a versão. Não consulte agenda nem financeiro.';

/** Exemplos por permissão: a tela mostra só os das permissões concedidas. */
export const EXEMPLOS_POR_ESCOPO: Readonly<Record<string, readonly string[]>> = {
    'conhecimento:read': [
        'Pela ajuda do iA.Fest, como conecto o WhatsApp da empresa? Cite o título e a versão.',
        'Pela ajuda do iA.Fest, como desconecto um assistente?',
    ],
    'agenda:read': [
        'Quantas festas tenho hoje no iA.Fest e em quais horários? Diga a data consultada.',
        'Quantos contratos estão pendentes nas festas de amanhã?',
    ],
    'financeiro:read': [
        'Qual o resumo de contas a receber no iA.Fest: em aberto, vencido e vencendo em 7 dias? Diga a data de referência.',
    ],
};

export type Orientacao = {
    id: string;
    sintoma: string;
    comoConfirmar: string;
    oQueFazer: string;
};

/**
 * Sugestões de diagnóstico: partem do que a pessoa vê no assistente, que o iA.Fest não enxerga. Por isso ficam separadas
 * das causas comprovadas de cada conexão. A ordem vai do passo mais simples ao mais invasivo; recriar tudo não é o começo.
 */
export const ORIENTACOES: readonly Orientacao[] = [
    {
        id: 'nao-habilitado',
        sintoma: 'O assistente diz que não tem a ferramenta ou nem tenta consultar',
        comoConfirmar: 'Veja se há nova consulta registrada em Suas conexões depois da pergunta. Se não houver, o assistente pode não ter usado o iA.Fest, mas isso não prova a causa: uma tentativa pode ter sido recusada antes de virar consulta.',
        oQueFazer: 'Habilite o iA.Fest nesta conversa. Se a conversa for antiga, tente uma conversa nova antes de mexer no conector.',
    },
    {
        id: 'cliente-oauth',
        sintoma: 'O assistente mostra erro de cliente ou de registro OAuth ao conectar',
        comoConfirmar: 'A tela de autorização do iA.Fest não chega a abrir, e nenhuma conexão nova aparece em Suas conexões.',
        oQueFazer: 'Revise a escolha do cliente OAuth: no Claude, “Use Claude’s published identity”; no ChatGPT, CIMD, sem client ID nem secret próprios. Se o assistente não deixar editar, adicione o conector de novo só com essa troca.',
    },
    {
        id: 'conta-empresa',
        sintoma: 'A conexão não aparece aqui, ou os dados são de outra empresa',
        comoConfirmar: 'A lista mostra só as conexões do usuário em uso. Uma autorização dada com outro usuário não aparece nesta sessão.',
        oQueFazer: 'Entre com o usuário que autorizou para conferir e desconectar. Depois autorize de novo com o usuário e a empresa corretos.',
    },
    {
        id: 'permissao',
        sintoma: 'O assistente diz que não tem permissão',
        comoConfirmar: 'Confira as permissões da conexão em Suas conexões. Falta de permissão não significa que não haja dados.',
        oQueFazer: 'Se quiser liberar, reconecte pelo assistente e marque as permissões que deseja manter e as que deseja adicionar: a nova autorização substitui a anterior.',
    },
    {
        id: 'reconectar',
        sintoma: 'O assistente pede para reconectar ou diz que a autorização expirou',
        comoConfirmar: 'Veja se a conexão aparece como Precisa reconectar ou Desconectada. Se ainda aparecer ativa, tente uma conversa nova primeiro.',
        oQueFazer: 'Use a opção de reconectar do próprio assistente, nas configurações do conector. Não é preciso apagar o conector nem criar outro.',
    },
    {
        id: 'indisponivel',
        sintoma: 'A consulta falha com erro temporário',
        comoConfirmar: 'A conexão continua autorizada aqui. Pode ser o iA.Fest ou o próprio assistente, por isso uma falha isolada não diz qual dos dois.',
        oQueFazer: 'Tente de novo em alguns minutos, sem reconectar. Se continuar, fale com o suporte e informe o horário da tentativa.',
    },
];
