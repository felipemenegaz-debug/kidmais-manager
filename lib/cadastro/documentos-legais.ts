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
    documento: 'TERMOS_USO', titulo: 'Termos de uso do Kidmais Manager', versao: '2026-10-20-minuta', minuta: true,
    secoes: [
        { titulo: 'Minuta', paragrafos: ['Este texto é uma minuta para homologação e será substituído pela versão revisada juridicamente antes da publicação.'] },
        { titulo: 'O serviço', paragrafos: ['O Kidmais Manager é um sistema de gestão para buffets infantis, contratado por empresa (CNPJ).'] },
        { titulo: 'Conta e responsável', paragrafos: [
            'Quem cria a conta declara agir em nome da empresa cadastrada. A validação dos dígitos do CNPJ não comprova a existência da empresa nem a autoridade de quem a cadastra.',
            'O responsável pelo uso pode ser diferente dos sócios. Ações com terceiros podem depender de aprovação da representação pela Kidmais.',
        ] },
        { titulo: 'Teste grátis e assinatura', paragrafos: [
            'A empresa recebe um período de teste sem cartão e sem cobrança automática, com duração informada no cadastro. Cada CNPJ tem um único teste.',
            'Os planos, preços e ciclos (mensal ou anual) são os exibidos na página de planos no momento da contratação. A assinatura renova ao fim de cada ciclo pelo meio de pagamento escolhido.',
            'Sem pagamento, a empresa tem 7 dias para regularizar, com acesso completo; depois, passa a somente leitura por 60 dias e, em seguida, tem o acesso suspenso.',
            'O cancelamento pode ser pedido a qualquer momento pelo canal de atendimento: a renovação é interrompida e o acesso continua até o fim do período já pago. Devolução de valores: [A DEFINIR].',
        ] },
        { titulo: 'Depois do teste ou da assinatura', paragrafos: [
            'Ao fim do teste sem assinatura, ao fim do período já pago de uma assinatura cancelada ou depois dos 7 dias para regularizar um pagamento, a empresa passa a somente leitura por 60 dias e, depois, tem o acesso suspenso. Os dados não são apagados por vencimento e podem ser exportados.',
            'Prazo de retenção após o encerramento: [A DEFINIR].',
        ] },
        { titulo: 'Contato', paragrafos: ['Canal de atendimento, inclusive para cancelamento: contato@demerzellabs.com.br.'] },
    ],
};

const PRIVACIDADE: TextoLegal = {
    documento: 'PRIVACIDADE', titulo: 'Aviso de privacidade do Kidmais Manager', versao: '2026-10-21-minuta5a', minuta: true,
    secoes: [
        { titulo: 'Sobre este aviso', paragrafos: [
            'Esta minuta descreve o tratamento de dados no Kidmais Manager, sistema de gestão de buffets e eventos, incluindo cadastro, assinatura e recursos de atendimento pelo WhatsApp. As definições pendentes estão identificadas no texto e precisam ser concluídas antes da publicação da política definitiva.',
        ] },
        { titulo: 'Quem é responsável', paragrafos: [
            'A responsável pelo Kidmais Manager é Mary Marra Menegaz – EPP, nome fantasia KidMais Festas, CNPJ 20.119.900/0001-60. Contato para assuntos de privacidade: contato@demerzellabs.com.br.',
            'A KidMais Festas decide sobre o tratamento dos dados de cadastro, relacionamento e administração da plataforma. Quando uma empresa cliente utiliza o sistema para atender seus próprios clientes, essa empresa decide as finalidades desse atendimento, e a plataforma trata os dados conforme suas instruções e os serviços contratados.',
        ] },
        { titulo: 'Dados da conta', paragrafos: [
            'O cadastro solicita nome, e-mail e senha de quem cria a conta, além de CNPJ, razão social, nome fantasia e telefone da empresa. A senha é armazenada como hash. Podem ser informados representantes e sócios declarados.',
            'Também são tratados informações da assinatura e da cobrança, registros de acesso e segurança e evidências do aceite dos documentos, incluindo versão, impressão digital do texto, horário e endereço IP.',
        ] },
        { titulo: 'Cookies de acesso e segurança', paragrafos: [
            'O sistema utiliza cookies para manter a sessão autenticada e proteger ações realizadas na conta. O bloqueio desses cookies pelo navegador pode impedir o acesso a áreas autenticadas. O inventário de outras tecnologias de armazenamento e de eventuais cookies opcionais está [A DEFINIR] para a versão definitiva.',
        ] },
        { titulo: 'Dados dos clientes do buffet', paragrafos: [
            'Conforme os recursos utilizados, a empresa cliente cadastra informações de contato, responsáveis e participantes dos eventos, datas, propostas, contratos e pagamentos, além de arquivos e informações fornecidos durante o atendimento.',
            'Dados de crianças e adolescentes, assim como informações sensíveis, por exemplo sobre saúde ou alergias, exigem avaliação específica pela empresa responsável. Sua inclusão deve se limitar ao necessário, com a base legal e as medidas de proteção adequadas. O aceite deste aviso não constitui autorização genérica para esses tratamentos.',
            'Acordo de tratamento de dados entre a plataforma e as empresas clientes, incluindo responsabilidades e instruções: [A DEFINIR].',
        ] },
        { titulo: 'Atendimento pelo WhatsApp', paragrafos: [
            'Quando o canal está habilitado, são tratados o número de telefone, o nome de perfil disponibilizado pelo WhatsApp, mensagens, referências a mídias, identificadores e horários das mensagens e estados de envio ou entrega. Esses dados permitem organizar o histórico, responder solicitações, enviar informações sobre eventos e transferir o atendimento à equipe.',
            'A integração utiliza serviços do WhatsApp/Meta e, conforme a configuração, da Gupshup. Esses serviços também tratam dados de acordo com suas próprias políticas. O atendimento pode usar respostas automáticas por regras; a pessoa pode solicitar atendimento humano.',
            'O Atendimento WhatsApp é utilizado com dados de clientes reais. As pendências indicadas nesta minuta precisam ser concluídas para que o aviso descreva integralmente as condições desse tratamento.',
        ] },
        { titulo: 'Recursos de inteligência artificial', paragrafos: [
            'O atendimento utiliza a OpenAI como provedora de inteligência artificial, inclusive no atendimento a clientes reais. Conforme a função habilitada, texto da conversa e trechos do histórico podem ser enviados à OpenAI para interpretar a solicitação ou auxiliar na resposta. Os filtros de dados pessoais não garantem anonimização completa.',
            'Os recursos de IA podem auxiliar no atendimento, na preparação de respostas, na leitura de documentos e na geração de imagens e convites. Conforme o recurso e o provedor habilitado, podem ser enviados textos, documentos, imagens e dados da festa. A geração de imagens e convites utiliza a OpenAI e, somente quando habilitado, o Google Gemini; o provedor utilizado é informado no momento da geração.',
            'A geração de convites com IA pode envolver nome e idade da criança, data, local e endereço do evento e fotografia opcional, mediante as autorizações aplicáveis: a autorização específica do responsável legal é registrada antes da geração, e a fotografia e as imagens da galeria só são enviadas com confirmação própria a cada geração. A imagem gerada é armazenada no Kidmais e pode continuar identificando a criança. Os filtros reduzem a exposição, mas não garantem anonimização. Os resultados podem conter erros e devem ser revisados antes do uso. É possível criar o convite sem IA, e a autorização pode ser revogada para usos futuros no editor do convite ou pelo canal de privacidade deste aviso.',
            'A ativação de cada recurso depende da verificação de suas condições contratuais e das salvaguardas aplicáveis. As condições contratuais aplicáveis, os prazos de retenção pelo provedor e as configurações efetivas de tratamento precisam ser confirmados: [A DEFINIR]. Esta minuta não presume anonimização integral nem ausência de armazenamento pelo provedor.',
        ] },
        { titulo: 'Finalidades e fundamentos do tratamento', paragrafos: [
            'Os dados são utilizados para criar e proteger contas, disponibilizar a gestão de eventos, prestar suporte, administrar assinaturas e cobranças, executar os atendimentos solicitados e manter registros necessários à segurança e ao cumprimento de obrigações aplicáveis.',
            'Conforme cada operação, podem ser aplicáveis a execução de contrato ou procedimentos preliminares, o cumprimento de obrigação legal, o exercício regular de direitos, o legítimo interesse após avaliação ou o consentimento quando necessário. A matriz de finalidades, bases legais e prazos, inclusive para dados sensíveis e de menores, está [A DEFINIR] para a política definitiva.',
        ] },
        { titulo: 'Compartilhamento e serviços externos', paragrafos: [
            'A plataforma utiliza Render para hospedagem, Meta/WhatsApp e Gupshup para mensageria e OpenAI para recursos de inteligência artificial. Os dados enviados dependem do serviço e da função utilizada, como conteúdo e metadados de mensagens para a mensageria e texto da conversa para a inteligência artificial.',
            'Dados também podem ser fornecidos para atender obrigações legais ou ordens de autoridades competentes. O inventário completo dos prestadores ativos, inclusive eventuais serviços de e-mail e cobrança, os dados compartilhados e as condições contratuais de proteção estão [A DEFINIR].',
            'Os serviços externos podem envolver tratamento fora do Brasil. Países, destinatários e mecanismos aplicáveis às transferências internacionais estão [A DEFINIR] e precisam ser confirmados para concluir este aviso.',
        ] },
        { titulo: 'Armazenamento, segurança e retenção', paragrafos: [
            'A plataforma possui controles de autenticação e de acesso por empresa e perfil. Esses controles reduzem riscos, mas não representam garantia absoluta de segurança. Arquivos disponibilizados por link devem ser compartilhados com cuidado: quem possui um link válido pode conseguir acessar seu conteúdo.',
            'A suspensão ou o encerramento de uma assinatura não apaga automaticamente os dados. Prazos de guarda de cadastros, contratos, registros de segurança e cópias de segurança: [A DEFINIR].',
            'Atualmente, não há exclusão automática das conversas do WhatsApp. Pedidos de exclusão podem ser feitos pelo canal indicado neste aviso. Os critérios e prazos de retenção dessas conversas estão [A DEFINIR]. Mesmo após excluir uma conversa, podem permanecer registros mínimos de auditoria, prevenção de reentrega e preferências de não contato; os prazos e fundamentos dessa guarda também precisam ser concluídos na política definitiva.',
        ] },
        { titulo: 'Direitos e pedidos de exclusão', paragrafos: [
            'Você pode solicitar confirmação do tratamento, acesso, correção, informações sobre compartilhamento, portabilidade quando aplicável, revogação do consentimento e anonimização, bloqueio ou exclusão nas hipóteses previstas na legislação. Também pode apresentar petição à Autoridade Nacional de Proteção de Dados (ANPD).',
            'Envie o pedido para contato@demerzellabs.com.br, com o assunto “Privacidade — Kidmais Manager” ou “Exclusão de dados — Kidmais Manager”. Informe qual é o pedido e o e-mail ou telefone utilizado no serviço. Se o atendimento foi feito por um buffet, indique o nome dele para localizarmos a empresa responsável. Não envie senhas nem códigos de verificação.',
            'Podemos solicitar informações proporcionais para confirmar sua identidade e evitar acesso ou exclusão indevidos. Quando a decisão couber à empresa cliente, o pedido será encaminhado ou será indicado o canal responsável. Esse contato por e-mail também pode ser utilizado por quem não tem mais acesso à conta.',
            'A exclusão pode ter limites decorrentes de obrigações legais e da preservação de direitos; eventuais restrições devem ser explicadas ao solicitante. A exclusão na plataforma não remove automaticamente mensagens do aparelho de destinatários, cópias já baixadas ou dados mantidos por serviços externos. O atendimento do pedido deve considerar esses destinatários e as cópias de segurança aplicáveis.',
            'Definição sobre encarregado e divulgação de seus dados de contato, quando aplicável: [A DEFINIR]. O canal de privacidade acima permanece disponível para solicitações.',
        ] },
        { titulo: 'Atualizações deste aviso', paragrafos: [
            'A versão e a impressão digital exibidas nesta página identificam o texto atual. Mudanças neste aviso recebem uma nova versão; os registros de aceites anteriores não são substituídos por este texto. A versão definitiva será disponibilizada após a conclusão das pendências e da revisão jurídica.',
        ] },
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
