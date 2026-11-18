import { createHash } from 'node:crypto';

/**
 * Termos de uso, aviso de privacidade e Acordo de Tratamento de Dados com VERSÃO registrada (E6/E10). O aceite grava
 * documento, versão e o SHA-256 do texto exato exibido (aceites_documentos_legais, 069): trocar uma vírgula muda o hash
 * e exige nova versão.
 *
 * ATENÇÃO: os textos abaixo são MINUTAS para homologação (rodada v2, parecer da Astra de 21/10/2026 e decisões de Felipe).
 * Não são textos legais definitivos. Tudo o que ainda depende de dado, decisão, evidência externa ou controle não
 * implementado está entre colchetes e é listado por `marcadoresPendentes` (ver MARCADORES). A versão definitiva só sai
 * com `minuta: false`, sem marcadores e com nova versão.
 *
 * DPA: o Acordo de Tratamento de Dados é um documento versionado próprio, publicado em /acordo-de-tratamento, mas NÃO
 * tem linha própria de aceite: a tabela 069 só aceita TERMOS_USO e PRIVACIDADE (CHECK aceites_documento_check). Ele é
 * incorporado por referência aos Termos, que citam a versão e o SHA-256 completo do DPA; assim o hash do aceite dos
 * Termos (gravado com a empresa no cadastro da empresa) identifica exatamente qual DPA foi aceito. Mudar o DPA muda o
 * texto dos Termos e exige nova versão dos dois (o teste confere).
 */
export type DocumentoLegal = 'TERMOS_USO' | 'PRIVACIDADE';
/** Documentos publicados. Só os de `DocumentoLegal` têm linha própria em aceites_documentos_legais. */
export type DocumentoPublicado = DocumentoLegal | 'DPA';
type Tabela = { colunas: string[]; linhas: string[][] };
/** `id` é só a âncora da página (fora do hash); a tabela entra no hash, linha a linha, depois dos parágrafos. */
type Secao = { titulo: string; id?: string; paragrafos: string[]; tabela?: Tabela };
export type TextoLegal = { documento: DocumentoPublicado; titulo: string; versao: string; minuta: boolean; rota: string; secoes: Secao[] };

/** Tipos de marcador usados nas minutas (o texto entre colchetes começa por um destes prefixos). */
export const MARCADORES = {
    IDENTIFICACAO: ['[RAZÃO SOCIAL DO NOVO CNPJ]', '[CNPJ]', '[ENDEREÇO]'],
    DECISAO: '[DECISÃO PENDENTE:',
    CONSENTIMENTO: '[DEPENDE DA IMPLEMENTAÇÃO DO CONSENTIMENTO]',
    CONTROLE: '[CONTROLE AINDA NÃO IMPLEMENTADO:',
    EVIDENCIA: '[EVIDÊNCIA PENDENTE:',
    AVALIACAO: '[AVALIAÇÃO JURÍDICA PENDENTE:',
} as const;

const CANAL = 'contato@demerzellabs.com.br';
/** Identificação da prestadora (Kidmais) — marcador até o novo CNPJ (decisão de Felipe, 22/10: manter marcador). */
export const IDENTIFICACAO_KIDMAIS = '[RAZÃO SOCIAL DO NOVO CNPJ], CNPJ [CNPJ], com sede em [ENDEREÇO]';
const RESPONSAVEL = IDENTIFICACAO_KIDMAIS;

const DPA: TextoLegal = {
    documento: 'DPA', titulo: 'Acordo de Tratamento de Dados do Kidmais Manager', versao: '2026-10-22-minuta2', minuta: true, rota: '/acordo-de-tratamento',
    secoes: [
        { titulo: 'Minuta', paragrafos: [
            'Este acordo é uma minuta para homologação. Os trechos entre colchetes indicam dados, decisões, evidências ou controles ainda pendentes; a versão definitiva só será publicada depois de concluí-los e da revisão jurídica.',
        ] },
        { titulo: 'Partes e objeto', id: 'partes', paragrafos: [
            'Este Acordo de Tratamento de Dados integra os Termos de uso do Kidmais Manager e é aceito junto com eles, pelo contratante identificado no cadastro (“Contratante”): a pessoa física que contrata em nome próprio, com seu nome civil e CPF, ou a pessoa jurídica, por quem a represente.',
            `Para os dados pessoais que o Contratante insere ou recebe no sistema, o Contratante é o controlador e ${RESPONSAVEL} (“Kidmais”) atua como operadora, na medida em que executa as instruções documentadas do Contratante. Quando a Kidmais decide finalidades próprias, como administração da assinatura, cobrança, segurança da plataforma e cumprimento de obrigações legais, responde como controladora por essas operações, conforme o Aviso de privacidade.`,
            'Na contratação por pessoa física, o titular atua como controlador dos dados de seus clientes no exercício da atividade do buffet; as instruções são dadas por ele ou por usuário por ele autorizado. O nome comercial do buffet não substitui a identificação do Contratante.',
            'Em caso de conflito entre os Termos de uso e este Acordo sobre dados pessoais tratados por conta do Contratante, prevalece este Acordo.',
        ] },
        { titulo: 'Instruções e duração', id: 'instrucoes', paragrafos: [
            'O Contratante instrui a Kidmais a tratar os dados pessoais somente para prestar as funções contratadas e habilitadas pelo Contratante, como cadastro de clientes, agenda, festas, orçamentos, contratos, pagamentos, atendimento pelo WhatsApp, convites e sites públicos. A configuração e o uso desses recursos pelo Contratante constituem instruções documentadas; instruções adicionais devem ser enviadas por escrito ao canal oficial.',
            'A Kidmais avisará o Contratante se considerar que uma instrução contraria a legislação de proteção de dados.',
            'O tratamento dura enquanto houver assinatura ou teste e, depois, pelos prazos de encerramento previstos nos Termos de uso e na seção “Término: devolução, exclusão e cópias de segurança” deste Acordo.',
        ] },
        { titulo: 'Titulares e dados tratados', id: 'categorias', paragrafos: [
            'O Contratante é responsável por ter base legal para cada tratamento, inclusive o consentimento específico do responsável quando exigido para dados de crianças, dados de saúde e convites com inteligência artificial e fotografia, por informar os titulares e por inserir no sistema apenas os dados necessários.',
        ], tabela: { colunas: ['Titulares', 'Dados', 'Observação'], linhas: [
            ['Clientes do Contratante (contratantes e responsáveis)', 'Nome, telefone, e-mail, CPF e endereço quando necessários ao contrato, festas, propostas, contratos e pagamentos', 'CPF e endereço só quando necessários.'],
            ['Crianças aniversariantes', 'Nome, data de nascimento ou idade, tema, observações e, quando enviada, fotografia', 'Exige avaliação do melhor interesse da criança.'],
            ['Convidados', 'Nome da família, número de adultos e crianças e resposta de presença', 'Informados na página pública do convite.'],
            ['Contatos e interessados', 'Nome, telefone, e-mail, mensagens, mídias e autorização de contato', 'Sites públicos e atendimento pelo WhatsApp.'],
            ['Pessoas com alergias ou restrições de saúde', 'Observações de saúde registradas em campos livres', 'Dado sensível: registrar só quando necessário à festa.'],
            ['Equipe do Contratante', 'Nome, e-mail, papel e registros de uso', 'Usuários do sistema.'],
        ] } },
        { titulo: 'Uso próprio e confidencialidade', id: 'confidencialidade', paragrafos: [
            'A Kidmais não usará os dados do Contratante para finalidades próprias incompatíveis, publicidade própria, treinamento de modelos de inteligência artificial por iniciativa própria, prospecção comercial ou comparação comercial que identifique o Contratante ou seus clientes.',
            'Pessoas e empresas ligadas à Kidmais também atuam no mercado de buffets infantis. Os dados do Contratante não serão disponibilizados a esse buffet nem acessados por seu pessoal, salvo quando a mesma pessoa prestar suporte técnico solicitado e apenas na medida necessária para isso.',
            'Quem acessa os dados em nome da Kidmais está sujeito a dever de confidencialidade. [EVIDÊNCIA PENDENTE: identificar quem acessa o suporte e o banco de dados e formalizar o dever de confidencialidade de cada pessoa]',
        ] },
        { titulo: 'Segurança e acesso de suporte', id: 'seguranca', paragrafos: [
            'A Kidmais mantém medidas técnicas e administrativas compatíveis com os dados tratados, entre elas: separação dos dados por empresa, perfis e papéis de acesso, senhas armazenadas como hash, sessões com prazo máximo e encerramento por inatividade, comunicação criptografada, credenciais de integração cifradas e registros de auditoria das ações relevantes.',
            'O acesso de pessoal da Kidmais aos dados do Contratante limita-se ao necessário para atender suporte solicitado, garantir a segurança do serviço ou cumprir obrigação legal. [CONTROLE AINDA NÃO IMPLEMENTADO: registro próprio e revisável dos acessos de suporte e de banco de dados aos dados das empresas clientes]',
        ] },
        { titulo: 'Suboperadores', id: 'suboperadores', paragrafos: [
            'O Contratante autoriza a Kidmais a utilizar os suboperadores da relação abaixo, cada um somente para a função indicada. A Kidmais exigirá deles obrigações de proteção de dados equivalentes às deste Acordo, na medida aplicável a cada serviço, e responde perante o Contratante pelo cumprimento dessas obrigações nos termos da lei. [EVIDÊNCIA PENDENTE: contrato ou DPA vigente de cada suboperador, com entidade contratada, países, subprocessadores e retenção]',
            'A inclusão ou substituição de suboperador será comunicada ao Contratante com pelo menos 30 dias de antecedência. Nesse prazo, o Contratante pode apresentar objeção fundamentada; não havendo solução contratual, poderá encerrar a assinatura com devolução proporcional do período pago e não utilizado.',
            'Asaas (cobrança) e Meta/WhatsApp também tratam dados para finalidades próprias, sob suas políticas; nessas operações não atuam como suboperadores da Kidmais. A cobrança da assinatura do Contratante é tratamento da Kidmais como controladora.',
        ], tabela: { colunas: ['Suboperador', 'Função', 'Dados', 'Situação'], linhas: [
            ['Render', 'Hospedagem da aplicação, do banco de dados e dos arquivos', 'Todos os dados do sistema', 'Ativo; região Virginia, Estados Unidos'],
            ['Resend', 'E-mails transacionais da conta e da equipe', 'E-mail, nome, nome da empresa e links de acesso', 'Ativo'],
            ['Meta/WhatsApp', 'Mensagens do atendimento e códigos de verificação, conforme a integração', 'Telefone, mensagens, mídias e códigos', 'Ativo quando o Contratante usa o WhatsApp'],
            ['Gupshup', 'Mensagens do atendimento e códigos de verificação, conforme a integração', 'Telefone, mensagens, mídias e códigos', 'Conforme a integração configurada'],
            ['OpenAI', 'Recursos de inteligência artificial, como geração de convites', 'Dados selecionados da festa e, com confirmação a cada geração, fotografia e imagens da galeria', 'Ativo para convites com IA'],
            ['Google (Gemini)', 'Geração de artes de convite com IA', 'Pedido visual e, com confirmação a cada geração, imagens da galeria', 'Condicional: somente quando habilitado'],
            ['ViaCEP', 'Consulta de endereço a partir do CEP', 'Somente o CEP', 'Ativo'],
            ['DeepSeek', 'Inteligência artificial de texto', 'Nenhum enquanto não habilitado', 'Não habilitado; exige avaliação e aviso prévio'],
        ] } },
        { titulo: 'Transferências internacionais', id: 'transferencias', paragrafos: [
            'A aplicação, o banco e os arquivos hospedados no Render ficam na região Virginia, Estados Unidos, e outros suboperadores podem tratar dados em outros países. Para cada destinatário, a Kidmais adotará mecanismo válido de transferência internacional previsto na LGPD e na Resolução CD/ANPD nº 19/2024, preferencialmente as cláusulas-padrão contratuais da ANPD, e informará ao Contratante, a pedido, as salvaguardas aplicáveis. [EVIDÊNCIA PENDENTE: mecanismo de transferência por destinatário, inclusive para as transferências subsequentes]',
        ] },
        { titulo: 'Direitos dos titulares e assistência', id: 'assistencia', paragrafos: [
            'Pedidos de titulares recebidos pela Kidmais sobre dados do Contratante serão encaminhados ao Contratante sem demora injustificada, salvo quando a Kidmais puder atendê-los diretamente por instrução do Contratante.',
            'A Kidmais auxiliará o Contratante, na medida das funções do sistema e das informações de que dispuser, a atender pedidos de confirmação, acesso, correção, portabilidade e exclusão, a exportar dados e a elaborar avaliações de risco e relatórios de impacto.',
        ] },
        { titulo: 'Incidentes de segurança', id: 'incidentes', paragrafos: [
            'A Kidmais avisará o Contratante sobre incidente de segurança que envolva os dados do Contratante sem demora injustificada, com meta contratual de até 24 horas a partir da ciência, e complementará as informações à medida que forem apuradas: natureza do incidente, dados e titulares afetados, medidas adotadas e medidas recomendadas. [CONTROLE AINDA NÃO IMPLEMENTADO: procedimento documentado de resposta a incidentes, com registro]',
            'O prazo contratual de 24 horas não é o prazo legal de comunicação à ANPD e aos titulares. Cabe ao Contratante, como controlador, avaliar e realizar a comunicação de incidente relevante, em regra em três dias úteis, conforme o regulamento da ANPD.',
        ] },
        { titulo: 'Término: devolução, exclusão e cópias de segurança', id: 'termino', paragrafos: [
            'Ao fim do teste ou da assinatura, aplicam-se os prazos dos Termos de uso: somente leitura por 60 dias, depois suspensão do acesso e conservação dos dados operacionais por até 12 meses contados da suspensão, permitindo sua exportação, com aviso ao responsável cadastrado pelo menos 30 dias antes da exclusão programada. Encerrado esse prazo, os dados serão eliminados ou anonimizados, ressalvados os registros mínimos cuja conservação seja necessária e legalmente justificada. O Contratante pode pedir a devolução e a exclusão antes disso.',
            'As cópias de segurança ficam isoladas do uso corrente e são eliminadas no ciclo máximo de 90 dias, incluindo cópias locais, ou em prazo menor onde disponível; se houver restauração, as exclusões já determinadas serão reaplicadas.',
            '[CONTROLE AINDA NÃO IMPLEMENTADO: aviso de 30 dias, exclusão ou anonimização programada após os 12 meses e eliminação das cópias de segurança no ciclo máximo, inclusive cópias locais; hoje nenhum dado é apagado depois da suspensão]',
        ] },
        { titulo: 'Demonstração de cumprimento', id: 'demonstracao', paragrafos: [
            'A Kidmais fornecerá ao Contratante, mediante pedido razoável, as informações necessárias para demonstrar o cumprimento deste Acordo, preservados segredos comerciais, a segurança do serviço e os dados de outras empresas clientes.',
        ] },
        { titulo: 'Vigência e alterações', id: 'alteracoes', paragrafos: [
            'Este Acordo vigora enquanto a Kidmais tratar dados pessoais por conta do Contratante. Alterações recebem nova versão e impressão digital e geram nova versão dos Termos de uso, com comunicação ao Contratante e novo aceite pelo Contratante ou por quem o represente.',
        ] },
        { titulo: 'Contato', id: 'contato', paragrafos: [`Canal oficial para instruções, pedidos e avisos relativos a este Acordo: ${CANAL}.`] },
    ],
};

const TERMOS: TextoLegal = {
    documento: 'TERMOS_USO', titulo: 'Termos de uso do Kidmais Manager', versao: '2026-10-23-minuta4', minuta: true, rota: '/termos',
    secoes: [
        { titulo: 'Minuta', paragrafos: [
            'Este texto é uma minuta para homologação. Os trechos entre colchetes indicam dados, decisões, evidências ou controles ainda pendentes; a versão definitiva só será publicada depois de concluí-los e da revisão jurídica.',
        ] },
        { titulo: 'Quem presta o serviço', id: 'responsavel', paragrafos: [
            `O Kidmais Manager é prestado por ${RESPONSAVEL} (“Kidmais”).`,
            `O endereço ${CANAL} é o canal oficial de atendimento, operado em nome da Kidmais. [EVIDÊNCIA PENDENTE: formalizar por contrato quem opera a caixa ${CANAL} em nome da Kidmais]`,
        ] },
        { titulo: 'O serviço', paragrafos: [
            'O Kidmais Manager é um sistema de gestão para buffets infantis, contratado por pessoa física (CPF) ou jurídica (CNPJ). Nestes Termos, “contratante” ou “empresa” designa quem está identificado no cadastro como contratante, seja pessoa física ou jurídica. Os recursos de cada plano são os informados na página de planos; recursos marcados como “Em breve” não fazem parte da contratação até serem disponibilizados.',
        ] },
        { titulo: 'Contratante, conta e responsável', id: 'contratante', paragrafos: [
            'Contratante é a pessoa física ou jurídica identificada no cadastro. A pessoa física contrata em nome próprio, com seu nome civil e CPF, podendo informar o nome comercial do buffet. A pessoa jurídica contrata por representante autorizado: quem cria a conta declara agir em nome dela. O nome comercial não substitui a identificação do contratante. A conferência dos dígitos do documento não comprova titularidade, existência da empresa ou poderes de representação.',
            'Contratar por CPF não dispensa registro empresarial, licenças ou obrigações fiscais da atividade do buffet, quando exigíveis.',
            'O responsável pelo uso pode ser diferente dos sócios. Ações com terceiros podem depender de aprovação da representação pela Kidmais.',
        ] },
        { titulo: 'Teste grátis', paragrafos: [
            'O contratante recebe 15 dias de teste grátis, sem cartão e sem cobrança automática. Cada contratante, identificado por CPF ou CNPJ, tem um único teste; a formalização da mesma operação de CPF para CNPJ, feita pelo atendimento, não gera novo teste. Ao fim do teste, só há cobrança se o contratante contratar um plano.',
        ] },
        { titulo: 'Planos, preços e renovação', paragrafos: [
            'Antes de confirmar a contratação, a tela apresenta uma síntese com a identificação da Kidmais e do contratante, o plano, o ciclo (mensal ou anual), o valor e, no anual, o total do ano, a condição Fundador com o prazo de pagamento, a renovação, o cancelamento e a devolução, com links para as versões integrais destes Termos, do Acordo de Tratamento de Dados e do Aviso de privacidade. Você pode voltar e corrigir a escolha antes de confirmar. A assinatura renova ao fim de cada ciclo, no mesmo plano e ciclo, com nova cobrança pelo meio de pagamento escolhido, até ser cancelada.',
            'Condição Fundador: ao confirmar o plano e o valor, a condição fica reservada para o contratante e o comprovante indica a data-limite de pagamento, que é o fim do 7º dia seguinte à confirmação, às 23h59 do horário de Brasília. O prazo é contado em dias de calendário, não em 168 horas, e não se confunde com o direito de arrependimento. O pagamento feito dentro desse prazo preserva a condição mesmo depois do fim da campanha, e os 12 meses do desconto começam com a confirmação do primeiro pagamento. Pagamento feito depois do prazo é analisado pelo atendimento, sem cobrança complementar automática; se a contratação não puder ser efetivada, ofereceremos uma solução, inclusive a devolução quando cabível.',
            'A formalização da mesma operação de CPF para CNPJ, ou a correção de documento informado com erro, é conduzida pelo atendimento, mediante conferência do vínculo e instrumento de continuidade. São preservados o preço contratado, o benefício e sua data original de término, sem concessão de novo período. Essa alteração não é feita por autoatendimento.',
            'A condição Fundador vale pelo prazo informado na oferta. Ao fim desse prazo, a assinatura segue pelo preço vigente do plano, com aviso de pelo menos 30 dias. O desconto Fundador não é cobrado de volta em nenhuma hipótese, inclusive em cancelamento. [CONTROLE AINDA NÃO IMPLEMENTADO: envio automático do aviso de renovação Fundador; hoje ele existe só como script manual]',
            'Os preços podem ser reajustados no máximo uma vez a cada 12 meses, pela variação acumulada do IPCA (IBGE) no período desde o último reajuste ou a contratação, com aviso de pelo menos 30 dias antes da primeira cobrança reajustada. O reajuste não altera o valor de período já pago.',
        ] },
        { titulo: 'Comprovante da contratação', id: 'comprovante', paragrafos: [
            'Ao confirmar a contratação, registramos a data e a hora (horário de Brasília), o contratante, o plano, o ciclo, o valor, a condição Fundador e sua data-limite de pagamento, além das versões e impressões digitais destes Termos, do Acordo de Tratamento de Dados e do Aviso de privacidade vigentes. O comprovante fica disponível na área Assinatura do sistema para salvar ou imprimir, e as versões integrais dos documentos aceitos continuam disponíveis para consulta, inclusive depois de novas versões.',
            'Também enviamos uma cópia do comprovante para o e-mail de quem contratou; uma falha nesse envio não invalida o comprovante. [CONTROLE AINDA NÃO IMPLEMENTADO: envio da cópia do comprovante por e-mail ligado no ambiente de produção]',
        ] },
        { titulo: 'Pagamento em atraso', paragrafos: [
            'Sem pagamento, a empresa tem 7 dias para regularizar, com acesso completo; depois, passa a somente leitura por 60 dias e, em seguida, tem o acesso suspenso.',
        ] },
        { titulo: 'Cancelamento e devolução', id: 'cancelamento', paragrafos: [
            'Você pode cancelar a renovação a qualquer momento, sem multa. Nos primeiros 7 dias da primeira ativação paga, devolveremos integralmente o valor pago, inclusive para contratações por CPF ou CNPJ, sem prejuízo dos direitos previstos em lei. Depois desse período, no plano mensal o acesso permanece até o fim do ciclo pago, sem devolução pelo período disponibilizado. No anual, você pode manter o acesso até o fim do período ou pedir encerramento antecipado com devolução proporcional aos dias não utilizados, calculada sobre o valor efetivamente pago. Não recalculamos os meses utilizados pelo preço mensal nem cobramos de volta o desconto Fundador. Em devoluções ordinárias, iniciaremos o processamento em até 5 dias úteis; o crédito depende do meio de pagamento e será acompanhado por nós. No arrependimento legal, a restituição e a comunicação ao intermediador serão imediatas. Falha do serviço, cobrança indevida e outros direitos legais serão tratados separadamente.',
            `O cancelamento da renovação e os pedidos de devolução são feitos na área Assinatura do sistema, seção “Cancelamento e devolução”, com protocolo exibido na tela no momento do registro e cópia enviada por e-mail (se o e-mail não chegar, o protocolo da tela continua valendo). No plano anual, o encerramento antecipado é pedido na mesma área: o valor proporcional é calculado na hora e o período correspondente é encerrado no registro do pedido.`,
            `O arrependimento também pode ser registrado na área Assinatura, em “Desistir da contratação”, mesmo quando a devolução automática não estiver disponível — por exemplo, fora da garantia de 7 dias da primeira ativação ou com o provedor de pagamento indisponível —, e vale a partir do registro, com protocolo. Se não for possível acessar o sistema, use o canal oficial ${CANAL}. O registro é confirmado na hora, com protocolo na tela e cópia por e-mail. Em seguida, a equipe Kidmais analisa o pedido: tratando-se de arrependimento legal, comunica o intermediador de pagamento e providencia a restituição de imediato, acompanhando o crédito conforme o meio de pagamento; nos demais casos, informa o resultado pelo canal oficial.`,
        ] },
        { titulo: 'Depois do teste ou da assinatura', id: 'encerramento', paragrafos: [
            'Ao fim do teste sem assinatura, ao fim do período já pago de uma assinatura cancelada ou depois dos 7 dias para regularizar um pagamento, a empresa passa a somente leitura por 60 dias e, depois, tem o acesso suspenso.',
            'O fim do teste, o atraso ou o cancelamento não provocam exclusão imediata. Depois dos prazos de acesso previstos nestes Termos, manteremos os dados operacionais por até 12 meses contados da suspensão posterior aos 60 dias de somente leitura, permitindo sua exportação. Avisaremos o responsável cadastrado com pelo menos 30 dias de antecedência da exclusão programada. Encerrado esse prazo, eliminaremos ou anonimizaremos os dados, ressalvados os registros mínimos cuja conservação seja necessária e legalmente justificada. A empresa pode solicitar devolução e exclusão antes disso, observados os direitos dos titulares e as obrigações aplicáveis.',
            '[CONTROLE AINDA NÃO IMPLEMENTADO: aviso de 30 dias e exclusão ou anonimização programada após os 12 meses; hoje nenhum dado é apagado depois da suspensão]',
        ] },
        { titulo: 'Seus dados e a exportação', id: 'exportacao', paragrafos: [
            'Os dados e conteúdos inseridos pela empresa continuam sendo dela. A Kidmais recebe apenas a licença necessária para hospedar, processar e exibir esse conteúdo na prestação do serviço, inclusive por meio dos prestadores indicados no Acordo de Tratamento de Dados.',
            'A exportação fica disponível para a Gestão da empresa, inclusive durante a somente leitura e depois da suspensão comercial. Hoje ela gera arquivos CSV de clientes e de contas a receber; os contratos podem ser baixados em PDF enquanto houver acesso de consulta. [CONTROLE AINDA NÃO IMPLEMENTADO: exportação completa e verificável, com festas, aniversariantes, contratos, financeiro e conversas, e conferência de integridade dos arquivos]',
        ] },
        { titulo: 'Proteção de dados e Acordo de Tratamento de Dados', id: 'acordo-de-tratamento', paragrafos: [
            `O Acordo de Tratamento de Dados, versão ${DPA.versao}, impressão digital ${hashDocumento(DPA)}, publicado em ${DPA.rota}, integra estes Termos e é aceito junto com eles, pelo contratante. Qualquer mudança no Acordo gera nova versão destes Termos.`,
            'Para os dados pessoais inseridos pelo contratante, pessoa física ou jurídica, ele atua como controlador e a Kidmais como operadora, na medida em que executa suas instruções documentadas. O Acordo de Tratamento de Dados integra os Termos e disciplina finalidades, categorias de dados, segurança, prestadores, transferências internacionais, atendimento a direitos, incidentes e devolução ou exclusão. A Kidmais não utilizará esses dados para publicidade própria nem treinamento de modelos por iniciativa própria. Quando decidir finalidades próprias, como administração da assinatura e segurança da plataforma, responderá como controladora por essas operações.',
            'Pessoas e empresas ligadas à Kidmais também atuam no mercado de buffets infantis. Por isso, é vedado usar dados das empresas clientes para prospecção própria, comparação comercial que identifique a empresa ou seus clientes, ou acesso por pessoal do buffet sem necessidade de suporte. [CONTROLE AINDA NÃO IMPLEMENTADO: registro próprio dos acessos de suporte aos dados das empresas clientes]',
            'O tratamento de dados pessoais pela Kidmais está descrito no Aviso de privacidade.',
        ] },
        { titulo: 'Disponibilidade e suporte', paragrafos: [
            `O suporte é prestado por e-mail, pelo canal oficial ${CANAL}. Manutenções programadas que afetem o acesso serão informadas com antecedência sempre que possível. Em falhas, a Kidmais atuará para restabelecer o serviço e, quando necessário, recuperar dados a partir das cópias de segurança disponíveis.`,
            'O serviço depende de infraestrutura de terceiros e pode ter interrupções. Nada nestes Termos exclui ou limita responsabilidade que a lei não permita excluir ou limitar, nem afasta direitos garantidos por normas obrigatórias; cada parte responde pelos danos a que der causa, nos termos da lei.',
        ] },
        { titulo: 'Uso adequado e suspensão', paragrafos: [
            'A empresa deve usar o serviço conforme a lei e estes Termos. Não é permitido usá-lo para fraude, envio de mensagens não solicitadas, violação de direitos de terceiros, tentativa de acesso indevido ou sobrecarga intencional do sistema.',
            'Diante de violação, a Kidmais avisará a empresa, indicando o motivo e, quando possível, um prazo para correção, antes de suspender o acesso. A suspensão imediata ocorre apenas quando necessária para proteger a segurança do serviço, dos titulares ou de terceiros, ou para cumprir a lei ou ordem de autoridade, com comunicação do motivo logo em seguida. A suspensão não impede a exportação dos dados da empresa, salvo ordem legal em contrário. [CONTROLE AINDA NÃO IMPLEMENTADO: exportação por empresa suspensa administrativamente; hoje só a suspensão por falta de pagamento mantém a exportação liberada]',
        ] },
        { titulo: 'Links e páginas públicas', paragrafos: [
            'Links de arquivos, convites e páginas públicas permitem acesso a quem os tiver e representam risco de exposição. A empresa deve compartilhá-los somente com quem precisa. A Kidmais mantém medidas para reduzir esse risco: as páginas de convite não são indexadas por buscadores, o link de edição do convite pelo cliente expira em 180 dias e pode ser revogado, e o convite deixa de ficar disponível quando é despublicado ou quando a festa ou o contrato são cancelados. O link público do convite não expira automaticamente.',
            'As páginas públicas de convite podem ser acessadas por crianças e adolescentes convidados. [AVALIAÇÃO JURÍDICA PENDENTE: enquadramento das páginas públicas de convite no ECA Digital (Lei nº 15.211/2025), distinto do sistema administrativo contratado por empresas]',
        ] },
        { titulo: 'Alterações destes Termos', paragrafos: [
            'Mudanças nestes Termos ou no Acordo de Tratamento de Dados recebem nova versão e impressão digital. Mudanças relevantes serão comunicadas à empresa com antecedência e exigirão novo aceite por quem a represente; o aceite anterior não é regravado. Novas restrições não se aplicam retroativamente, e a falta do novo aceite não bloqueia a exportação dos dados.',
            '[CONTROLE AINDA NÃO IMPLEMENTADO: fluxo de novo aceite para empresas já cadastradas; até lá, o novo aceite é formalizado por documento eletrônico que identifique as versões e impressões digitais]',
        ] },
        { titulo: 'Contato', id: 'contato', paragrafos: [`Canal oficial de atendimento, inclusive para cancelamento e devolução: ${CANAL}.`] },
    ],
};

const PRIVACIDADE: TextoLegal = {
    documento: 'PRIVACIDADE', titulo: 'Aviso de privacidade do Kidmais Manager', versao: '2026-10-22-minuta7', minuta: true, rota: '/privacidade',
    secoes: [
        { titulo: 'Sobre este aviso', paragrafos: [
            'Este aviso descreve o tratamento de dados pessoais no Kidmais Manager, sistema de gestão para buffets infantis: cadastro e assinatura, gestão de festas, atendimento pelo WhatsApp, convites e recursos de inteligência artificial. Esta é uma minuta: os trechos entre colchetes indicam dados, decisões, evidências ou controles ainda pendentes, que precisam ser concluídos antes da versão definitiva.',
        ] },
        { titulo: 'Quem é responsável', id: 'responsavel', paragrafos: [
            `O canal para exercer direitos e esclarecer dúvidas sobre proteção de dados é ${CANAL}. A responsável pelo tratamento é ${RESPONSAVEL} (“Kidmais”). O canal é operado em nome da Kidmais. O encarregado pelo tratamento de dados pessoais é Felipe Menegaz, que atende pelo mesmo canal, ${CANAL}. [EVIDÊNCIA PENDENTE: ato formal de indicação do encarregado pelo novo CNPJ]`,
            'A Kidmais é controladora dos dados de conta, assinatura, cobrança, suporte e segurança da plataforma. Para os dados pessoais que um contratante insere no sistema para atender seus próprios clientes, o contratante, pessoa física ou jurídica, é o controlador e a Kidmais atua como operadora, conforme o Acordo de Tratamento de Dados, que integra os Termos de uso e está publicado em /acordo-de-tratamento.',
        ] },
        { titulo: 'Dados da conta', paragrafos: [
            'O cadastro solicita nome, e-mail e senha de quem cria a conta e, conforme o tipo de contratante, nome civil e CPF (pessoa física, que contrata em nome próprio) ou CNPJ, razão social e representantes e sócios declarados (pessoa jurídica), além do nome comercial do buffet e do telefone. A senha é armazenada como hash.',
            'Também são tratados informações da assinatura e da cobrança, registros de acesso e segurança e evidências do aceite dos documentos, incluindo versão, impressão digital do texto, horário, endereço IP e navegador utilizado.',
        ] },
        { titulo: 'CPF do contratante pessoa física', id: 'cpf', paragrafos: [
            'Usamos o nome civil e o CPF do contratante pessoa física para identificá-lo, executar a assinatura, faturar e conferir a elegibilidade e a continuidade do benefício Fundador, inclusive na formalização da mesma operação de CPF para CNPJ. Compartilhamos com o provedor de cobrança os dados necessários à cobrança. O CPF não é dado sensível, mas é protegido com acesso restrito: fica completo apenas nos registros de contratação, cobrança e elegibilidade que precisam dele, e os registros de auditoria do cadastro e da assinatura guardam o documento mascarado. O mascaramento não é anonimização.',
            'O CPF não é pedido no Perfil do buffet nem exibido em páginas públicas. Os prazos de conservação estão na tabela de retenção.',
        ] },
        { titulo: 'Cookies e armazenamento no navegador', id: 'cookies', paragrafos: [
            'Utilizamos cookies necessários à autenticação e à segurança: __Host-kidmais_admin, com validade máxima de 8 horas e encerramento da sessão após 30 minutos sem atividade, e __Host-kidmais_admin_csrf, para proteção das operações, vinculado à sessão ou com duração de 10 minutos antes do login. Também usamos armazenamento do navegador para sincronizar a troca de empresa, apresentar avisos e evitar pedidos duplicados de geração de convite ou confirmação de presença. Algumas chaves permanecem até serem substituídas ou apagadas pelo usuário. Não utilizamos cookies próprios de publicidade ou medição de audiência. Ao iniciar a conexão do WhatsApp, é carregado o SDK da Meta, sujeito também às informações de privacidade apresentadas nesse fluxo.',
            'Como esses cookies são estritamente necessários, não pedimos consentimento para eles; o bloqueio pelo navegador pode impedir o acesso às áreas autenticadas.',
        ], tabela: { colunas: ['Nome', 'Tipo', 'Finalidade', 'Duração'], linhas: [
            ['__Host-kidmais_admin', 'Cookie', 'Sessão autenticada', 'Até 8 horas; encerrada após 30 minutos sem atividade ou ao sair'],
            ['__Host-kidmais_admin_csrf', 'Cookie', 'Proteção das operações (CSRF)', 'Vinculado à sessão; 10 minutos antes do login'],
            ['kidmais-contexto-alterado', 'Armazenamento local', 'Avisar outras abas sobre a troca de empresa', 'Até ser substituído ou apagado pelo usuário'],
            ['kidmais-aviso-contexto', 'Armazenamento da sessão', 'Exibir aviso após navegação forçada', 'Até ser lido ou a aba ser fechada'],
            ['convite-pedido:<convite>', 'Armazenamento da sessão', 'Evitar geração duplicada de convite', 'Até concluir a geração ou fechar a aba'],
            ['convite-rsvp:<convite>', 'Armazenamento local', 'Evitar confirmação de presença duplicada', 'Até ser apagado pelo usuário'],
        ] } },
        { titulo: 'Dados dos clientes do buffet', id: 'tratamento-de-dados', paragrafos: [
            'Conforme os recursos utilizados, a empresa cliente cadastra informações de contato, responsáveis e participantes dos eventos, datas, propostas, contratos e pagamentos, além de arquivos e informações fornecidos durante o atendimento.',
            'Dados de crianças e adolescentes, assim como informações sensíveis, por exemplo sobre saúde ou alergias, exigem avaliação específica pela empresa responsável. Sua inclusão deve se limitar ao necessário, com a base legal e as medidas de proteção adequadas. O aceite deste aviso não constitui autorização genérica para esses tratamentos.',
            'Alergias e observações de saúde devem ser registradas somente quando necessárias à festa e, preferencialmente, eliminadas 30 dias após o evento, salvo necessidade concreta de conservação, como incidente ou disputa. [CONTROLE AINDA NÃO IMPLEMENTADO: eliminação de observações de saúde 30 dias após a festa; hoje esses dados ficam em campos de texto livre, sem rotina de eliminação]',
            'Os formulários públicos dos sites das empresas devem identificar o buffet responsável, explicar a finalidade e oferecer link a este aviso antes da coleta. [EVIDÊNCIA PENDENTE: conferir se os formulários públicos identificam o buffet responsável, a finalidade e o link para este aviso antes do envio]',
            'As instruções, responsabilidades, prestadores, incidentes e a devolução ou exclusão desses dados estão no Acordo de Tratamento de Dados.',
        ] },
        { titulo: 'Atendimento pelo WhatsApp', paragrafos: [
            'Quando o canal está habilitado, são tratados o número de telefone, o nome de perfil disponibilizado pelo WhatsApp, mensagens, referências a mídias, identificadores e horários das mensagens e estados de envio ou entrega. Esses dados permitem organizar o histórico, responder solicitações, enviar informações sobre eventos e transferir o atendimento à equipe.',
            'A integração utiliza serviços do WhatsApp/Meta e, conforme a configuração, da Gupshup. Esses serviços também tratam dados de acordo com suas próprias políticas. O atendimento pode usar respostas automáticas por regras; a pessoa pode solicitar atendimento humano e pedir para não ser mais contatada, por exemplo respondendo “PARAR”.',
            'O atendimento pelo WhatsApp é utilizado com dados de clientes reais. O uso de inteligência artificial nesse atendimento está descrito na seção seguinte.',
        ] },
        { titulo: 'Recursos de inteligência artificial', id: 'inteligencia-artificial', paragrafos: [
            'Os recursos de IA podem auxiliar no atendimento, na preparação de respostas, na leitura de documentos e na geração de imagens e convites. Conforme o recurso e o provedor habilitado, podem ser enviados textos, documentos, imagens e dados da festa. A geração de imagens e convites utiliza a OpenAI e, somente quando habilitado, o Google Gemini; o provedor utilizado é informado no momento da geração. Os filtros reduzem a exposição, mas não garantem anonimização. Os resultados podem conter erros e devem ser revisados antes do uso. Provedores, finalidades e condições de armazenamento constam da relação de prestadores. A ativação de cada recurso depende da verificação de suas condições contratuais e das salvaguardas aplicáveis.',
            'A geração de convites com IA pode envolver nome e idade da criança, data, local e endereço do evento e fotografia opcional, mediante as autorizações aplicáveis. Antes de gerar, a tela informa o provedor configurado e os dados que podem ser enviados, e a geração só ocorre depois de registrada a autorização específica do responsável legal pela criança, com o nome e o vínculo informados, para aquele provedor e para a versão atual do texto. Quando a equipe do buffet opera o editor, ela registra a autorização declarada pelo responsável e o meio pelo qual a recebeu. A fotografia e as imagens da galeria só são enviadas com uma confirmação própria, desmarcada, a cada geração. É possível criar o convite sem IA, com arte própria ou o visual padrão, e a autorização pode ser revogada para usos futuros no editor do convite ou pelo canal de privacidade deste aviso.',
            'O pedido de geração e a fotografia do convite não são guardados pelo Kidmais; das imagens enviadas fica registrado apenas um código de verificação (hash). A imagem gerada é armazenada no Kidmais e pode conter os dados da festa e continuar identificando a criança. Não há troca automática de provedor: se a configuração mudar, a geração é recusada até nova autorização.',
            'O Google Gemini só é usado para gerar artes de convite quando habilitado, depois da verificação da modalidade contratada e das restrições do serviço a aplicações acessadas por menores. [EVIDÊNCIA PENDENTE: modalidade contratada do Gemini e compatibilidade dos termos do serviço com o público do produto]',
            'No atendimento pelo WhatsApp, quando a função de IA é autorizada para a empresa, a mensagem atual e mensagens recentes do cliente podem ser enviadas à OpenAI com dados pessoais ocultados por filtros; mensagens com termos de saúde não são enviadas ao modelo. [DECISÃO PENDENTE: ponto urgente 4 da Astra — manter atendimento humano ou por regras até a comprovação das condições da IA, apurar e registrar o uso com dados reais de 15/10/2026 e solicitar ao provedor a exclusão cabível]',
            'Documentos importados podem ser enviados integralmente ao provedor de IA indicado para extração das informações. Antes do envio, a empresa deve remover dados desnecessários. O original e os resultados seguem os prazos da categoria correspondente e podem ser eliminados ou anonimizados quando não houver fundamento para sua conservação. [CONTROLE AINDA NÃO IMPLEMENTADO: eliminação ou anonimização controlada de originais, extrações e trechos de documentos importados; hoje o banco recusa essa exclusão, e a função não deve ser habilitada com documentos reais antes da correção]',
            'O assistente da área administrativa e a importação de documentos por IA não fazem parte da oferta atual. [EVIDÊNCIA PENDENTE: confirmar que o assistente e a importação de documentos por IA estão desligados em produção]',
        ] },
        { titulo: 'Finalidades e fundamentos do tratamento', id: 'finalidades', paragrafos: [
            'Tratamos dados de conta, assinatura, suporte e segurança para administrar o serviço, cumprir obrigações e proteger direitos, conforme a finalidade de cada operação. Nos cadastros e atendimentos das empresas clientes, seguimos suas instruções e as bases legais por elas documentadas. Dados de crianças exigem avaliação de seu melhor interesse; dados de saúde exigem hipótese legal específica para dados sensíveis. O aceite destes documentos não substitui consentimentos específicos nem autoriza tratamentos incompatíveis com a finalidade informada. A matriz abaixo detalha as operações.',
        ], tabela: { colunas: ['Finalidade', 'Papel e base', 'Limite importante'], linhas: [
            ['Conta, assinatura e suporte', 'Kidmais controladora: execução contratual quando o titular for parte; legítimo interesse documentado para contatos e representantes da pessoa jurídica', 'O contrato entre empresas não fundamenta automaticamente todo dado de seus empregados ou representantes.'],
            ['Cobrança, tributos e defesa', 'Kidmais controladora: obrigação legal e exercício regular de direitos, conforme o registro', 'Conservar os comprovantes necessários, não o banco inteiro.'],
            ['Identificação do contratante pessoa física (nome civil e CPF)', 'Kidmais controladora: execução do contrato de que o titular é parte; obrigação legal fiscal, quando houver; exercício regular de direitos para provar o benefício Fundador já concedido e a continuidade CPF → CNPJ', 'CPF completo só nos registros restritos de contratação, cobrança e elegibilidade; auditoria com o documento mascarado.'],
            ['Autenticação e segurança', 'Kidmais controladora: legítimo interesse; obrigação legal para registros exigidos', 'Minimização, acesso restrito e prazos separados.'],
            ['Orçamento e festa', 'Buffet controlador; Kidmais operadora: contrato ou procedimentos solicitados pelo titular adulto', 'Não coletar CPF ou endereço antes de serem necessários.'],
            ['Cadastro de criança', 'Buffet controlador: consentimento específico como opção recomendada; outra base apenas com avaliação concreta do melhor interesse', 'Idade e nome são dados pessoais; não são sensíveis apenas por pertencerem a criança.'],
            ['Alergias e saúde', 'Buffet controlador: consentimento específico e destacado do responsável, quando necessário ao serviço', 'Legítimo interesse não fundamenta dados sensíveis. Proteção da vida serve a situações próprias, não como justificativa genérica de cadastro.'],
            ['Convite com IA e fotografia', 'Buffet controlador; Kidmais operadora: consentimento específico para essa finalidade opcional', 'Separar geração por IA, uso da fotografia e eventual divulgação pública.'],
            ['Resposta a contato e marketing', 'Resposta solicitada: procedimentos preliminares ou outra base pertinente. Promoções: consentimento como padrão recomendado', 'Autorização promocional separada, desmarcada e revogável. “PARAR” deve interromper envios.'],
        ] } },
        { titulo: 'Compartilhamento e prestadores', id: 'prestadores', paragrafos: [
            'Utilizamos Render para hospedagem e banco; Asaas para cobrança e pagamentos; Resend para e-mails transacionais; Meta/WhatsApp e, conforme a integração, Gupshup para mensageria e verificação de identidade; OpenAI para recursos de IA, inclusive a geração de convites; Google Gemini quando habilitado para geração de imagens e convites; e ViaCEP para consulta de endereço a partir do CEP. Cada serviço recebe somente os dados necessários à sua função. O Asaas também coleta diretamente dados fornecidos pelo pagador em sua página. DeepSeek é uma integração opcional, atualmente sem uso confirmado, que não será ativada sem avaliação prévia e atualização das informações pertinentes.',
            'Dados também podem ser fornecidos para atender obrigações legais ou ordens de autoridades competentes. Provedores, finalidades e condições de armazenamento dos recursos de IA, inclusive dos convites com IA, constam da relação abaixo, versionada com este aviso, que separa os prestadores em uso dos condicionais e das integrações apenas disponíveis. Na geração de convites, o provedor efetivamente usado é informado na tela antes do envio. [EVIDÊNCIA PENDENTE: razão social contratada, subprocessadores, países, contrato ou DPA e retenção de cada prestador ativo]',
        ], tabela: { colunas: ['Prestador', 'Função', 'Dados enviados', 'Situação'], linhas: [
            ['Render', 'Hospedagem da aplicação, do banco e dos arquivos', 'Todos os dados do sistema', 'Em uso'],
            ['Asaas', 'Cobrança da assinatura e pagamentos', 'Nome civil e CPF (pessoa física) ou razão social e CNPJ (pessoa jurídica), identificador interno, plano e valores; o pagador informa seus dados diretamente ao Asaas', 'Em uso [EVIDÊNCIA PENDENTE: confirmar a operação real de cobrança em produção]'],
            ['Resend', 'E-mails transacionais', 'E-mail, nome, nome da empresa e links de acesso', 'Em uso desde 20/10/2026'],
            ['Meta/WhatsApp', 'Mensageria, conexão do número da empresa e códigos de verificação', 'Telefone, mensagens, mídias e códigos', 'Em uso conforme a integração'],
            ['Gupshup', 'Mensageria e códigos de verificação', 'Telefone, mensagens, mídias e códigos', 'Conforme a integração configurada'],
            ['OpenAI', 'Recursos de IA, inclusive geração de convites', 'Convites: dados selecionados da festa e pedido visual e, com confirmação a cada geração, fotografia e imagens da galeria; atendimento: mensagens com dados ocultados, conforme o recurso', 'Em uso nos convites com IA, com autorização registrada do responsável. A OpenAI informa que dados enviados à API não são usados para treinar modelos por padrão, salvo opção de compartilhamento, e que conteúdos podem ser mantidos temporariamente para monitoramento de abuso, conforme a função; não prometemos retenção zero'],
            ['Google Gemini', 'Geração de artes de convite com IA', 'Pedido visual e, com confirmação a cada geração, imagens da galeria', 'Condicional: somente quando habilitado, com autorização registrada para esse provedor'],
            ['ViaCEP', 'Consulta de endereço', 'Somente o CEP', 'Em uso'],
            ['DeepSeek', 'IA de texto', 'Nenhum', 'Integração disponível, não habilitada'],
        ] } },
        { titulo: 'Transferência internacional', paragrafos: [
            'A aplicação, o banco e os arquivos hospedados no Render são mantidos na região Virginia, Estados Unidos. Outros prestadores podem tratar dados em países indicados na relação de transferências internacionais. Essa relação identifica o destinatário, a finalidade, os dados, os países e o mecanismo legal utilizado. Você pode solicitar informações sobre as salvaguardas pelo nosso canal de privacidade.',
            '[EVIDÊNCIA PENDENTE: relação de transferências internacionais preenchida por destinatário (países, dados, finalidade e mecanismo da Resolução CD/ANPD nº 19/2024, preferencialmente as cláusulas-padrão da ANPD), inclusive transferências subsequentes]',
        ] },
        { titulo: 'Armazenamento, segurança e retenção', id: 'retencao', paragrafos: [
            'A plataforma possui controles de autenticação e de acesso por empresa e perfil. Esses controles reduzem riscos, mas não representam garantia absoluta de segurança. Links de arquivos e de convites permitem acesso a quem os tiver; eles representam risco de exposição e devem ser compartilhados somente com quem precisa.',
            'Os prazos variam conforme a finalidade e constam da tabela de retenção abaixo. Encerrada a finalidade, os dados serão eliminados ou anonimizados, salvo conservação necessária por obrigação legal ou exercício de direitos. Restrições de exclusão serão individualizadas, justificadas e revistas. As cópias de segurança ficam isoladas do uso corrente e serão eliminadas no ciclo máximo informado. Se houver restauração, reaplicaremos as exclusões já determinadas.',
            'Os prazos da tabela distinguem a obrigação legal da política adotada pela Kidmais; nenhum deles autoriza guardar todos os dados pelo maior prazo. [CONTROLE AINDA NÃO IMPLEMENTADO: rotinas de eliminação nos prazos da tabela, inclusive registros de acesso, auditoria, cópias de segurança e cópias locais]',
        ], tabela: { colunas: ['Categoria', 'Prazo'], linhas: [
            ['Dados operacionais do buffet', 'Regra dos Termos: até 12 meses contados da suspensão posterior aos 60 dias de somente leitura; pedido anterior de exclusão pode antecipar o término.'],
            ['Contratos e evidências essenciais de contratação e aceite', 'Até 10 anos após o término da relação ou cumprimento, como política de defesa contratual, mediante necessidade documentada.'],
            ['Identificação do contratante (nome civil e CPF ou razão social e CNPJ) e registros de continuidade CPF → CNPJ', 'Durante o contrato e, depois, pelo prazo das evidências essenciais de contratação ou dos documentos fiscais, o que for aplicável; após a relação, apenas o necessário para provar o benefício já concedido e impedir sua repetição.'],
            ['Documentos fiscais da assinatura', 'Pelo prazo tributário aplicável, em regra cinco anos, com extensão quando houver procedimento ou crédito ainda não prescrito. [EVIDÊNCIA PENDENTE: confirmação do contador sobre os documentos fiscais e o marco de contagem]'],
            ['Registros de acesso à aplicação', 'Seis meses; preservações adicionais individualizadas quando legalmente cabíveis. Isso não significa guardar conteúdo de mensagens por seis meses.'],
            ['Auditoria operacional e segurança adicional', '12 meses, salvo necessidade específica documentada.'],
            ['Conversas e mídias do WhatsApp', 'Conforme a seção “Conversas do WhatsApp”.'],
            ['Alergias e observações de saúde', 'Preferencialmente eliminar 30 dias após a festa, salvo necessidade concreta de conservação, como incidente ou disputa.'],
            ['Cópias de segurança e exportações do banco', 'Ciclo máximo de 90 dias, incluindo cópias locais; prazo menor onde disponível.'],
        ] } },
        { titulo: 'Conversas do WhatsApp', id: 'conversas', paragrafos: [
            'Como configuração padrão, as conversas e suas mídias serão eliminadas após 12 meses sem atividade. Cada empresa controladora pode escolher um prazo menor. Pedidos de exclusão serão avaliados antes desse prazo. Após excluir o conteúdo, conservamos por 30 dias os identificadores técnicos protegidos necessários para impedir a recriação por reentrega. O registro mínimo de “não contatar” é mantido para respeitar a oposição, sem conservar a conversa. A exclusão não alcança automaticamente cópias de terceiros; quando cabível, encaminharemos a solicitação aos destinatários.',
            '[CONTROLE AINDA NÃO IMPLEMENTADO: prazo padrão de 12 meses, limite máximo de 12 meses na configuração por empresa (hoje sem padrão e de 1 a 3650 dias) e execução periódica da retenção em produção; enquanto não funcionarem, a exclusão é feita mediante solicitação e o prazo é cumprido por procedimento operacional]',
        ] },
        { titulo: 'Direitos e pedidos de exclusão', id: 'exclusao-de-dados', paragrafos: [
            'Você pode solicitar confirmação do tratamento, acesso, correção, informações sobre compartilhamento, portabilidade quando aplicável, revogação do consentimento e anonimização, bloqueio ou exclusão nas hipóteses previstas na legislação. Também pode apresentar petição à Autoridade Nacional de Proteção de Dados (ANPD).',
            `Envie o pedido para ${CANAL}, com o assunto “Privacidade — Kidmais Manager” ou “Exclusão de dados — Kidmais Manager”. Informe qual é o pedido e o e-mail ou telefone utilizado no serviço. Se o atendimento foi feito por um buffet, indique o nome dele para localizarmos a empresa responsável. Não envie senhas nem códigos de verificação.`,
            'A confirmação da existência de tratamento e o acesso aos dados em formato simplificado são fornecidos imediatamente; a declaração clara e completa, em até 15 dias contados do pedido, conforme a LGPD. Os demais pedidos são respondidos nos prazos legais aplicáveis ou, na falta deles, em prazo razoável informado ao solicitante. [CONTROLE AINDA NÃO IMPLEMENTADO: procedimento registrado de atendimento de direitos, com protocolo e controle de prazos]',
            'Podemos solicitar informações proporcionais para confirmar sua identidade e evitar acesso ou exclusão indevidos. Quando a decisão couber à empresa cliente, o pedido será encaminhado ou será indicado o canal responsável. Esse contato por e-mail também pode ser utilizado por quem não tem mais acesso à conta.',
            'A exclusão pode ter limites decorrentes de obrigações legais e da preservação de direitos; eventuais restrições devem ser explicadas ao solicitante. A exclusão na plataforma não remove automaticamente mensagens do aparelho de destinatários, cópias já baixadas ou dados mantidos por serviços externos. O atendimento do pedido deve considerar esses destinatários e as cópias de segurança aplicáveis.',
        ] },
        { titulo: 'Atualizações deste aviso', paragrafos: [
            'A versão e a impressão digital exibidas nesta página identificam o texto atual. Mudanças neste aviso recebem uma nova versão; os registros de aceites anteriores não são substituídos por este texto. Mudanças relevantes serão comunicadas com destaque às empresas clientes, com registro da ciência, que não equivale a consentimento para tratamentos específicos: esses são pedidos separadamente. A versão definitiva será disponibilizada após a conclusão das pendências e da revisão jurídica.',
        ] },
    ],
};

export const DOCUMENTOS: Record<DocumentoPublicado, TextoLegal> = { TERMOS_USO: TERMOS, PRIVACIDADE, DPA };
/** Documentos com linha própria de aceite (CHECK da 069). O DPA é aceito por incorporação aos Termos. */
export const DOCUMENTOS_COM_ACEITE: readonly DocumentoLegal[] = ['TERMOS_USO', 'PRIVACIDADE'];

/** Texto canônico (o que o hash cobre): título, versão e seções, sem formatação de tela. Tabelas: uma linha por linha. */
export function textoCanonico(d: TextoLegal) {
    return [d.titulo, `Versão ${d.versao}`, ...d.secoes.flatMap((s) => [
        s.titulo, ...s.paragrafos, ...(s.tabela ? [s.tabela.colunas, ...s.tabela.linhas].map((l) => l.join(' | ')) : []),
    ])].join('\n');
}
export function hashDocumento(d: TextoLegal) {
    return createHash('sha256').update(textoCanonico(d), 'utf8').digest('hex');
}
export function versaoVigente(documento: DocumentoPublicado) {
    const d = DOCUMENTOS[documento];
    return { documento, versao: d.versao, hash: hashDocumento(d) };
}
/** Marcadores entre colchetes ainda presentes no texto, na ordem da primeira ocorrência e sem repetição. */
export function marcadoresPendentes(d: TextoLegal) {
    return [...new Set(textoCanonico(d).match(/\[[^\]\n]+\]/g) ?? [])];
}
