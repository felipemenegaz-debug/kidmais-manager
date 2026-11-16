import { createHash } from 'node:crypto';

/**
 * Termos de uso, aviso de privacidade e Acordo de Tratamento de Dados com VERSÃO registrada (E6/E10). O aceite grava
 * documento, versão e o SHA-256 do texto exato exibido (aceites_documentos_legais, 069): trocar uma vírgula muda o hash
 * e exige nova versão.
 *
 * Versão definitiva de 03/11/2026 (R-5): parte da v2 (parecer da Astra de 21/10/2026), com as decisões de Felipe de
 * 21/10 e 03/11 e a Demerzel Labs Ltda. como responsável. Sem parecer jurídico, com risco assumido por Felipe. Os
 * controles ainda não automatizados estão descritos como procedimento operacional; `marcadoresPendentes` garante que
 * nenhum marcador entre colchetes volte ao texto publicado.
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
    DECISAO: '[DECISÃO PENDENTE:',
    CONSENTIMENTO: '[DEPENDE DA IMPLEMENTAÇÃO DO CONSENTIMENTO]',
    CONTROLE: '[CONTROLE AINDA NÃO IMPLEMENTADO:',
    EVIDENCIA: '[EVIDÊNCIA PENDENTE:',
    AVALIACAO: '[AVALIAÇÃO JURÍDICA PENDENTE:',
} as const;

const CANAL = 'contato@demerzellabs.com.br';
/** Identificação da prestadora (Demerzel Labs), conforme o comprovante de inscrição no CNPJ (Receita Federal, 03/11/2026). Literais: o hash do aceite cobre o texto. O nome da constante segue o usado pelo comprovante da assinatura. */
export const IDENTIFICACAO_KIDMAIS = 'Demerzel Labs Ltda., CNPJ 69.938.612/0001-26, com sede no SCRN 704/705, Bloco D, Loja 12, Asa Norte, Brasília/DF, CEP 70730-640';
const RESPONSAVEL = IDENTIFICACAO_KIDMAIS;

const DPA: TextoLegal = {
    documento: 'DPA', titulo: 'Acordo de Tratamento de Dados do iA.Fest', versao: '2026-11-15-dpa', minuta: false, rota: '/acordo-de-tratamento',
    secoes: [
        { titulo: 'Partes e objeto', id: 'partes', paragrafos: [
            'Este Acordo de Tratamento de Dados integra os Termos de uso do iA.Fest e é aceito junto com eles, pelo contratante identificado no cadastro (“Contratante”): a pessoa física que contrata em nome próprio, com seu nome civil e CPF, ou a pessoa jurídica, por quem a represente.',
            `Para os dados pessoais que o Contratante insere ou recebe no sistema, o Contratante é o controlador e ${RESPONSAVEL} (“Demerzel Labs”) atua como operadora, na medida em que executa as instruções documentadas do Contratante. Quando a Demerzel Labs decide finalidades próprias, como administração da assinatura, cobrança, segurança da plataforma e cumprimento de obrigações legais, responde como controladora por essas operações, conforme o Aviso de privacidade.`,
            'Na contratação por pessoa física, o titular atua como controlador dos dados de seus clientes no exercício da atividade do buffet; as instruções são dadas por ele ou por usuário por ele autorizado. O nome comercial do buffet não substitui a identificação do Contratante.',
            'Em caso de conflito entre os Termos de uso e este Acordo sobre dados pessoais tratados por conta do Contratante, prevalece este Acordo.',
        ] },
        { titulo: 'Instruções e duração', id: 'instrucoes', paragrafos: [
            'O Contratante instrui a Demerzel Labs a tratar os dados pessoais somente para prestar as funções contratadas e habilitadas pelo Contratante, como cadastro de clientes, agenda, festas, orçamentos, contratos, pagamentos, atendimento pelo WhatsApp, convites e sites públicos. A configuração e o uso desses recursos pelo Contratante constituem instruções documentadas; instruções adicionais devem ser enviadas por escrito ao canal oficial.',
            'A Demerzel Labs avisará o Contratante se considerar que uma instrução contraria a legislação de proteção de dados.',
            'O tratamento dura enquanto houver assinatura ou teste e, depois, pelos prazos de encerramento previstos nos Termos de uso e na seção “Término: devolução, exclusão e cópias de segurança” deste Acordo.',
        ] },
        { titulo: 'Titulares e dados tratados', id: 'categorias', paragrafos: [
            'O Contratante é responsável por ter base legal para cada tratamento, inclusive o consentimento específico do responsável quando exigido para dados de crianças, dados de saúde e convites com inteligência artificial e fotografia, por informar os titulares e por inserir no sistema apenas os dados necessários.',
        ], tabela: { colunas: ['Titulares', 'Dados', 'Observação'], linhas: [
            ['Clientes do Contratante (contratantes e responsáveis)', 'Nome, telefone, e-mail, CPF e endereço quando necessários ao contrato, festas, propostas, contratos e pagamentos', 'CPF e endereço só quando necessários.'],
            ['Crianças aniversariantes', 'Nome, data de nascimento ou idade, tema, observações e, quando enviada, fotografia', 'Exige avaliação do melhor interesse da criança.'],
            ['Convidados', 'Nome da família, número de adultos e crianças e resposta de presença', 'Informados no formulário da página pública do convite, antes da resposta, com identificação do buffet responsável.'],
            ['Contatos e interessados', 'Nome, telefone, e-mail, mensagens, mídias e autorização de contato', 'Sites públicos e atendimento pelo WhatsApp.'],
            ['Pessoas com alergias ou restrições de saúde', 'Observações de saúde registradas em campos livres', 'Dado sensível: registrar só quando necessário à festa.'],
            ['Equipe do Contratante', 'Nome, e-mail, papel e registros de uso', 'Usuários do sistema.'],
        ] } },
        { titulo: 'Uso próprio e confidencialidade', id: 'confidencialidade', paragrafos: [
            'A Demerzel Labs não usará os dados do Contratante para finalidades próprias incompatíveis, publicidade própria, treinamento de modelos de inteligência artificial por iniciativa própria, prospecção comercial ou comparação comercial que identifique o Contratante ou seus clientes.',
            'Pessoas ligadas à Demerzel Labs também atuam no mercado de buffets infantis, no buffet Kidmais Festas, que é empresa cliente da plataforma. Os dados do Contratante não serão disponibilizados a esse buffet nem acessados por seu pessoal, salvo quando a mesma pessoa prestar suporte técnico solicitado e apenas na medida necessária para isso.',
            'Quem acessa os dados em nome da Demerzel Labs (hoje exclusivamente o responsável técnico e encarregado, Felipe Menegaz) está sujeito a dever de confidencialidade formalizado por escrito, extensivo a qualquer pessoa que venha a prestar suporte.',
        ] },
        { titulo: 'Segurança e acesso de suporte', id: 'seguranca', paragrafos: [
            'A Demerzel Labs mantém medidas técnicas e administrativas compatíveis com os dados tratados, entre elas: separação dos dados por empresa, perfis e papéis de acesso, senhas armazenadas como hash, sessões com prazo máximo e encerramento por inatividade, comunicação criptografada, credenciais de integração cifradas e registros de auditoria das ações relevantes.',
            'O acesso de pessoal da Demerzel Labs aos dados do Contratante limita-se ao necessário para atender suporte solicitado, garantir a segurança do serviço ou cumprir obrigação legal. Esses acessos são anotados em registro próprio da Demerzel Labs (data, empresa, motivo e pessoa), fornecido ao Contratante a pedido.',
        ] },
        { titulo: 'Suboperadores', id: 'suboperadores', paragrafos: [
            'O Contratante autoriza a Demerzel Labs a utilizar os suboperadores da relação abaixo, cada um somente para a função indicada. A Demerzel Labs exigirá deles obrigações de proteção de dados equivalentes às deste Acordo, na medida aplicável a cada serviço, e responde perante o Contratante pelo cumprimento dessas obrigações nos termos da lei. As obrigações de proteção de dados de cada suboperador constam dos termos e acordos de tratamento publicados por ele e aceitos pela Demerzel Labs na contratação; a Demerzel Labs mantém cópia e a fornece ao Contratante a pedido.',
            'A inclusão ou substituição de suboperador será comunicada ao Contratante com pelo menos 30 dias de antecedência. Nesse prazo, o Contratante pode apresentar objeção fundamentada; não havendo solução contratual, poderá encerrar a assinatura com devolução proporcional do período pago e não utilizado.',
            'Asaas (cobrança) e Meta/WhatsApp também tratam dados para finalidades próprias, sob suas políticas; nessas operações não atuam como suboperadores da Demerzel Labs. A cobrança da assinatura do Contratante é tratamento da Demerzel Labs como controladora.',
        ], tabela: { colunas: ['Suboperador', 'Entidade e país', 'Função', 'Dados', 'Situação'], linhas: [
            ['Render', 'Render Services, Inc. (Estados Unidos)', 'Hospedagem da aplicação, do banco de dados e dos arquivos', 'Todos os dados do sistema', 'Ativo; região Virginia, Estados Unidos'],
            ['Resend', 'Plus Five Five, Inc., que opera a Resend (Estados Unidos)', 'E-mails transacionais da conta e da equipe', 'E-mail, nome, nome da empresa e links de acesso', 'Ativo'],
            ['Meta/WhatsApp', 'Meta Platforms, Inc. e afiliadas (Estados Unidos e outros países)', 'Mensagens do atendimento e códigos de verificação, conforme a integração', 'Telefone, mensagens, mídias e códigos', 'Ativo quando o Contratante usa o WhatsApp'],
            ['OpenAI', 'OpenAI OpCo, LLC (Estados Unidos)', 'Geração de convites com inteligência artificial e assistente do atendimento pelo WhatsApp', 'Dados selecionados da festa e, com confirmação a cada geração, fotografia e imagens da galeria; mensagens da conversa, com filtros', 'Ativo para convites com IA e para o atendimento quando o Contratante liga o assistente'],
            ['Google (Gemini)', 'Google LLC (Estados Unidos)', 'Geração de artes de convite com IA', 'Nenhum', 'Não habilitado; exige avaliação e aviso prévio'],
            ['ViaCEP', 'Serviço brasileiro de consulta de CEP (Brasil)', 'Consulta de endereço a partir do CEP', 'Somente o CEP', 'Ativo'],
            ['DeepSeek', 'DeepSeek (China)', 'Inteligência artificial de texto', 'Nenhum enquanto não habilitado', 'Não habilitado; exige avaliação e aviso prévio'],
        ] } },
        { titulo: 'Transferências internacionais', id: 'transferencias', paragrafos: [
            'A aplicação, o banco e os arquivos hospedados no Render ficam na região Virginia, Estados Unidos, e outros suboperadores podem tratar dados em outros países. A Meta/WhatsApp incorpora as cláusulas-padrão contratuais da ANPD (Resolução CD/ANPD nº 19/2024) aos seus termos de transferência. Os contratos públicos de tratamento de dados de Render, Resend e OpenAI, consultados pela Demerzel Labs, não incluem essas cláusulas-padrão; as transferências a esses suboperadores ocorrem sob os contratos oferecidos por eles, e o mecanismo de transferência previsto no art. 33 da LGPD ainda não está demonstrado para elas, conforme indicado por destinatário na relação de transferências do Aviso de privacidade, que será atualizada se algum suboperador passar a adotar as cláusulas-padrão. As transferências subsequentes seguem os compromissos assumidos por cada suboperador em seus próprios termos. A Demerzel Labs informa ao Contratante, a pedido, as salvaguardas aplicáveis.',
        ] },
        { titulo: 'Direitos dos titulares e assistência', id: 'assistencia', paragrafos: [
            'Pedidos de titulares recebidos pela Demerzel Labs sobre dados do Contratante serão encaminhados ao Contratante sem demora injustificada, salvo quando a Demerzel Labs puder atendê-los diretamente por instrução do Contratante.',
            'A Demerzel Labs auxiliará o Contratante, na medida das funções do sistema e das informações de que dispuser, a atender pedidos de confirmação, acesso, correção, portabilidade e exclusão, a exportar dados e a elaborar avaliações de risco e relatórios de impacto.',
        ] },
        { titulo: 'Incidentes de segurança', id: 'incidentes', paragrafos: [
            'A Demerzel Labs avisará o Contratante sobre incidente de segurança que envolva os dados do Contratante sem demora injustificada, com meta contratual de até 24 horas a partir da ciência, e complementará as informações à medida que forem apuradas: natureza do incidente, dados e titulares afetados, medidas adotadas e medidas recomendadas. A Demerzel Labs mantém procedimento documentado de resposta a incidentes e registro das ocorrências, disponíveis ao Contratante a pedido.',
            'O prazo contratual de 24 horas não é o prazo legal de comunicação à ANPD e aos titulares. Cabe ao Contratante, como controlador, avaliar e realizar a comunicação de incidente relevante, em regra em três dias úteis, conforme o regulamento da ANPD.',
        ] },
        { titulo: 'Término: devolução, exclusão e cópias de segurança', id: 'termino', paragrafos: [
            'Ao fim do teste ou da assinatura, aplicam-se os prazos dos Termos de uso: somente leitura por 60 dias, depois suspensão do acesso e conservação dos dados operacionais por até 12 meses contados da suspensão, permitindo sua exportação, com aviso ao responsável cadastrado pelo menos 30 dias antes da exclusão programada. Encerrado esse prazo, os dados serão eliminados ou anonimizados, ressalvados os registros mínimos cuja conservação seja necessária e legalmente justificada. O Contratante pode pedir a devolução e a exclusão antes disso.',
            'As cópias de segurança ficam isoladas do uso corrente e são eliminadas no ciclo máximo de 90 dias, incluindo cópias locais, ou em prazo menor onde disponível; se houver restauração, as exclusões já determinadas serão reaplicadas.',
            'Enquanto a exclusão programada não for automatizada, a Demerzel Labs executa o aviso e a exclusão por procedimento operacional, com registro. As cópias de segurança gerenciadas do provedor de hospedagem e as cópias locais seguem o procedimento de cópias da Demerzel Labs, com ciclo máximo de 90 dias e registro das eliminações.',
        ] },
        { titulo: 'Demonstração de cumprimento', id: 'demonstracao', paragrafos: [
            'A Demerzel Labs fornecerá ao Contratante, mediante pedido razoável, as informações necessárias para demonstrar o cumprimento deste Acordo, preservados segredos comerciais, a segurança do serviço e os dados de outras empresas clientes.',
        ] },
        { titulo: 'Vigência e alterações', id: 'alteracoes', paragrafos: [
            'Este Acordo vigora enquanto a Demerzel Labs tratar dados pessoais por conta do Contratante. Alterações recebem nova versão e impressão digital e geram nova versão dos Termos de uso, com comunicação ao Contratante e novo aceite pelo Contratante ou por quem o represente.',
        ] },
        { titulo: 'Contato', id: 'contato', paragrafos: [`Canal oficial para instruções, pedidos e avisos relativos a este Acordo: ${CANAL}.`] },
    ],
};

const TERMOS: TextoLegal = {
    documento: 'TERMOS_USO', titulo: 'Termos de uso do iA.Fest', versao: '2026-11-15-termos', minuta: false, rota: '/termos',
    secoes: [
        { titulo: 'Quem presta o serviço', id: 'responsavel', paragrafos: [
            `O iA.Fest é prestado por ${RESPONSAVEL} (“Demerzel Labs”).`,
            `O endereço ${CANAL} é o canal oficial de atendimento da Demerzel Labs.`,
        ] },
        { titulo: 'O serviço', paragrafos: [
            'O iA.Fest é um sistema de gestão para buffets infantis, contratado por pessoa física (CPF) ou jurídica (CNPJ). Nestes Termos, “contratante” ou “empresa” designa quem está identificado no cadastro como contratante, seja pessoa física ou jurídica. Os recursos de cada plano são os informados na página de planos; recursos marcados como “Em breve” não fazem parte da contratação até serem disponibilizados.',
        ] },
        { titulo: 'Contratante, conta e responsável', id: 'contratante', paragrafos: [
            'Contratante é a pessoa física ou jurídica identificada no cadastro. A pessoa física contrata em nome próprio, com seu nome civil e CPF, podendo informar o nome comercial do buffet. A pessoa jurídica contrata por representante autorizado: quem cria a conta declara agir em nome dela. O nome comercial não substitui a identificação do contratante. A conferência dos dígitos do documento não comprova titularidade, existência da empresa ou poderes de representação.',
            'Contratar por CPF não dispensa registro empresarial, licenças ou obrigações fiscais da atividade do buffet, quando exigíveis.',
            'O responsável pelo uso pode ser diferente dos sócios. Ações com terceiros podem depender de aprovação da representação pela Demerzel Labs.',
        ] },
        { titulo: 'Teste grátis', paragrafos: [
            'O contratante recebe 15 dias de teste grátis, sem cartão e sem cobrança automática. Cada contratante, identificado por CPF ou CNPJ, tem um único teste; a formalização da mesma operação de CPF para CNPJ, feita pelo atendimento, não gera novo teste. Ao fim do teste, só há cobrança se o contratante contratar um plano.',
        ] },
        { titulo: 'Planos, preços e renovação', paragrafos: [
            'Antes de confirmar a contratação, a tela apresenta uma síntese com a identificação da Demerzel Labs e do contratante, o plano, o ciclo (mensal ou anual), o valor e, no anual, o total do ano, a condição Fundador com o prazo de pagamento, a renovação, o cancelamento e a devolução, com links para as versões integrais destes Termos, do Acordo de Tratamento de Dados e do Aviso de privacidade. Você pode voltar e corrigir a escolha antes de confirmar. A assinatura renova ao fim de cada ciclo, no mesmo plano e ciclo, com nova cobrança pelo meio de pagamento escolhido, até ser cancelada.',
            'O atendimento com inteligência artificial pelo WhatsApp, nos planos que o incluem, é oferecido com uso justo, sem número garantido de conversas. Para proteger a qualidade e o custo do serviço, há limites técnicos, como o número de respostas automáticas por conversa e um teto mensal de processamento. Quando um limite é atingido, a conversa passa para a equipe da empresa, sem cobrança adicional. Quaisquer franquias ou pacotes futuros serão informados na página de planos antes da contratação. As tarifas da Meta pelas mensagens do atendimento estão incluídas no plano, dentro do uso justo.',
            'Condição Fundador: ao confirmar o plano e o valor, a condição fica reservada para o contratante e o comprovante indica a data-limite de pagamento, que é o fim do 7º dia seguinte à confirmação, às 23h59 do horário de Brasília. O prazo é contado em dias de calendário, não em 168 horas, e não se confunde com o direito de arrependimento. O pagamento feito dentro desse prazo preserva a condição mesmo depois do fim da campanha, e os 12 meses do desconto começam com a confirmação do primeiro pagamento. Pagamento feito depois do prazo é analisado pelo atendimento, sem cobrança complementar automática; se a contratação não puder ser efetivada, ofereceremos uma solução, inclusive a devolução quando cabível.',
            'A formalização da mesma operação de CPF para CNPJ, ou a correção de documento informado com erro, é conduzida pelo atendimento, mediante conferência do vínculo e instrumento de continuidade. São preservados o preço contratado, o benefício e sua data original de término, sem concessão de novo período. Essa alteração não é feita por autoatendimento.',
            'A condição Fundador vale pelo prazo informado na oferta. Ao fim desse prazo, a assinatura segue pelo preço vigente do plano, com aviso de pelo menos 30 dias enviado ao e-mail do responsável cadastrado. O desconto Fundador não é cobrado de volta em nenhuma hipótese, inclusive em cancelamento.',
            'Os preços podem ser reajustados no máximo uma vez a cada 12 meses, pela variação acumulada do IPCA (IBGE) no período desde o último reajuste ou a contratação, com aviso de pelo menos 30 dias antes da primeira cobrança reajustada. O reajuste não altera o valor de período já pago.',
        ] },
        { titulo: 'Comprovante da contratação', id: 'comprovante', paragrafos: [
            'Ao confirmar a contratação, registramos a data e a hora (horário de Brasília), o contratante, o plano, o ciclo, o valor, a condição Fundador e sua data-limite de pagamento, além das versões e impressões digitais destes Termos, do Acordo de Tratamento de Dados e do Aviso de privacidade vigentes. O comprovante fica disponível na área Assinatura do sistema para salvar ou imprimir, e as versões integrais dos documentos aceitos continuam disponíveis para consulta, inclusive depois de novas versões.',
            'Também enviamos uma cópia do comprovante para o e-mail de quem contratou; uma falha nesse envio não invalida o comprovante.',
        ] },
        { titulo: 'Pagamento em atraso', paragrafos: [
            'Sem pagamento, a empresa tem 7 dias para regularizar, com acesso completo; depois, passa a somente leitura por 60 dias e, em seguida, tem o acesso suspenso.',
        ] },
        { titulo: 'Cancelamento e devolução', id: 'cancelamento', paragrafos: [
            'Você pode cancelar a renovação a qualquer momento, sem multa. Nos primeiros 7 dias da primeira ativação paga, devolveremos integralmente o valor pago, inclusive para contratações por CPF ou CNPJ, sem prejuízo dos direitos previstos em lei. Depois desse período, no plano mensal o acesso permanece até o fim do ciclo pago, sem devolução pelo período disponibilizado. No anual, você pode manter o acesso até o fim do período ou pedir encerramento antecipado com devolução proporcional aos dias não utilizados, calculada sobre o valor efetivamente pago. Não recalculamos os meses utilizados pelo preço mensal nem cobramos de volta o desconto Fundador. Em devoluções ordinárias, iniciaremos o processamento em até 5 dias úteis; o crédito depende do meio de pagamento e será acompanhado por nós. No arrependimento legal, a restituição e a comunicação ao intermediador serão imediatas. Falha do serviço, cobrança indevida e outros direitos legais serão tratados separadamente.',
            `O cancelamento da renovação e os pedidos de devolução são feitos na área Assinatura do sistema, seção “Cancelamento e devolução”, com protocolo exibido na tela no momento do registro e cópia enviada por e-mail (se o e-mail não chegar, o protocolo da tela continua valendo). No plano anual, o encerramento antecipado é pedido na mesma área: o valor proporcional é calculado na hora e o período correspondente é encerrado no registro do pedido, preservadas a somente leitura e a exportação previstas em “Depois do teste ou da assinatura”. As devoluções são processadas pela Demerzel Labs junto ao intermediador de pagamento (Asaas), pelo meio de pagamento original: no cartão de crédito ou no Pix, o valor volta ao cartão ou à conta que fez o pagamento; no boleto, ou se o estorno pelo meio original não for possível, pediremos os dados bancários da empresa.`,
            `O arrependimento também pode ser registrado na área Assinatura, em “Desistir da contratação”, mesmo quando a devolução automática não estiver disponível — por exemplo, fora da garantia de 7 dias da primeira ativação ou com o provedor de pagamento indisponível —, e vale a partir do registro, com protocolo. Se não for possível acessar o sistema, use o canal oficial ${CANAL}. O registro é confirmado na hora, com protocolo na tela e cópia por e-mail. Em seguida, a equipe da Demerzel Labs analisa o pedido: tratando-se de arrependimento legal, comunica o intermediador de pagamento e providencia a restituição de imediato, acompanhando o crédito conforme o meio de pagamento; nos demais casos, informa o resultado pelo canal oficial.`,
        ] },
        { titulo: 'Depois do teste ou da assinatura', id: 'encerramento', paragrafos: [
            'Ao fim do teste sem assinatura, ao fim do período já pago de uma assinatura cancelada ou depois dos 7 dias para regularizar um pagamento, a empresa passa a somente leitura por 60 dias e, depois, tem o acesso suspenso.',
            'O fim do teste, o atraso ou o cancelamento não provocam exclusão imediata. Depois dos prazos de acesso previstos nestes Termos, manteremos os dados operacionais por até 12 meses contados da suspensão posterior aos 60 dias de somente leitura, permitindo sua exportação. Avisaremos o responsável cadastrado com pelo menos 30 dias de antecedência da exclusão programada. Encerrado esse prazo, eliminaremos ou anonimizaremos os dados, ressalvados os registros mínimos cuja conservação seja necessária e legalmente justificada. A empresa pode solicitar devolução e exclusão antes disso, observados os direitos dos titulares e as obrigações aplicáveis.',
            'Enquanto a exclusão programada não for automatizada no sistema, a Demerzel Labs controla os prazos e executa o aviso e a exclusão por procedimento operacional, com registro de cada eliminação.',
        ] },
        { titulo: 'Seus dados e a exportação', id: 'exportacao', paragrafos: [
            'Os dados e conteúdos inseridos pela empresa continuam sendo dela. A Demerzel Labs recebe apenas a licença necessária para hospedar, processar e exibir esse conteúdo na prestação do serviço, inclusive por meio dos prestadores indicados no Acordo de Tratamento de Dados.',
            'A exportação fica disponível para a Gestão da empresa, inclusive durante a somente leitura e depois da suspensão comercial. Hoje ela gera arquivos CSV de clientes e de contas a receber; os contratos podem ser baixados em PDF enquanto houver acesso de consulta. A exportação completa dos demais dados (festas, aniversariantes, financeiro e conversas) pode ser pedida pelo canal oficial e é entregue em até 15 dias.',
        ] },
        { titulo: 'Proteção de dados e Acordo de Tratamento de Dados', id: 'acordo-de-tratamento', paragrafos: [
            `O Acordo de Tratamento de Dados, versão ${DPA.versao}, impressão digital ${hashDocumento(DPA)}, publicado em ${DPA.rota}, integra estes Termos e é aceito junto com eles, pelo contratante. Qualquer mudança no Acordo gera nova versão destes Termos.`,
            'Para os dados pessoais inseridos pelo contratante, pessoa física ou jurídica, ele atua como controlador e a Demerzel Labs como operadora, na medida em que executa suas instruções documentadas. O Acordo de Tratamento de Dados integra os Termos e disciplina finalidades, categorias de dados, segurança, prestadores, transferências internacionais, atendimento a direitos, incidentes e devolução ou exclusão. A Demerzel Labs não utilizará esses dados para publicidade própria nem treinamento de modelos por iniciativa própria. Quando decidir finalidades próprias, como administração da assinatura e segurança da plataforma, responderá como controladora por essas operações.',
            'Pessoas ligadas à Demerzel Labs também atuam no mercado de buffets infantis, no buffet Kidmais Festas, que é empresa cliente da plataforma. Por isso, é vedado usar dados das empresas clientes para prospecção própria, comparação comercial que identifique a empresa ou seus clientes, ou acesso por pessoal do buffet sem necessidade de suporte. Os acessos de suporte aos dados das empresas clientes são anotados em registro próprio da Demerzel Labs (data, empresa, motivo e pessoa), disponível à empresa a pedido.',
            'O tratamento de dados pessoais pela Demerzel Labs está descrito no Aviso de privacidade.',
        ] },
        { titulo: 'Disponibilidade e suporte', paragrafos: [
            `O suporte é prestado por e-mail, pelo canal oficial ${CANAL}. Manutenções programadas que afetem o acesso serão informadas com antecedência sempre que possível. Em falhas, a Demerzel Labs atuará para restabelecer o serviço e, quando necessário, recuperar dados a partir das cópias de segurança disponíveis.`,
            'O serviço depende de infraestrutura de terceiros e pode ter interrupções. Nada nestes Termos exclui ou limita responsabilidade que a lei não permita excluir ou limitar, nem afasta direitos garantidos por normas obrigatórias; cada parte responde pelos danos a que der causa, nos termos da lei.',
        ] },
        { titulo: 'Uso adequado e suspensão', paragrafos: [
            'A empresa deve usar o serviço conforme a lei e estes Termos. Não é permitido usá-lo para fraude, envio de mensagens não solicitadas, violação de direitos de terceiros, tentativa de acesso indevido ou sobrecarga intencional do sistema.',
            'Diante de violação, a Demerzel Labs avisará a empresa, indicando o motivo e, quando possível, um prazo para correção, antes de suspender o acesso. A suspensão imediata ocorre apenas quando necessária para proteger a segurança do serviço, dos titulares ou de terceiros, ou para cumprir a lei ou ordem de autoridade, com comunicação do motivo logo em seguida. A suspensão não impede a exportação dos dados da empresa, salvo ordem legal em contrário; na suspensão por violação destes Termos, a exportação é disponibilizada mediante pedido pelo canal oficial, em até 15 dias.',
        ] },
        { titulo: 'Links e páginas públicas', paragrafos: [
            'Links de arquivos, convites e páginas públicas permitem acesso a quem os tiver e representam risco de exposição. A empresa deve compartilhá-los somente com quem precisa. A Demerzel Labs mantém medidas para reduzir esse risco: as páginas de convite instruem os buscadores a não indexá-las (diretiva noindex), o link de edição do convite pelo cliente expira em 180 dias e pode ser revogado, e o convite deixa de ficar disponível quando é despublicado ou quando a festa ou o contrato são cancelados. O link público do convite não expira automaticamente.',
            'As páginas públicas de convite destinam-se aos responsáveis pelos convidados: não pedem dados da criança convidada além da confirmação de presença feita por um adulto, não exibem publicidade, não fazem perfilamento, não têm conta nem interação entre usuários e instruem os buscadores a não indexá-las. O formulário de confirmação identifica o buffet responsável, informa a finalidade, orienta que a resposta seja dada por um adulto responsável e leva a este Aviso. A empresa cliente, como controladora, decide o que publica no convite.',
        ] },
        { titulo: 'Alterações destes Termos', paragrafos: [
            'Mudanças nestes Termos ou no Acordo de Tratamento de Dados recebem nova versão e impressão digital. Toda alteração do Acordo de Tratamento de Dados e as mudanças relevantes destes Termos serão comunicadas à empresa com antecedência e exigirão novo aceite por quem a represente; o aceite anterior não é regravado. Novas restrições não se aplicam retroativamente, e a falta do novo aceite não bloqueia a exportação dos dados.',
            'Enquanto o sistema não oferecer o novo aceite na própria tela, ele é formalizado por documento eletrônico enviado ao responsável cadastrado, que identifica as versões e as impressões digitais aceitas.',
        ] },
        { titulo: 'Contato', id: 'contato', paragrafos: [`Canal oficial de atendimento, inclusive para cancelamento e devolução: ${CANAL}.`] },
    ],
};

const PRIVACIDADE: TextoLegal = {
    documento: 'PRIVACIDADE', titulo: 'Aviso de privacidade do iA.Fest', versao: '2026-11-15-privacidade', minuta: false, rota: '/privacidade',
    secoes: [
        { titulo: 'Sobre este aviso', paragrafos: [
            'Este aviso descreve o tratamento de dados pessoais no iA.Fest, sistema de gestão para buffets infantis: cadastro e assinatura, gestão de festas, atendimento pelo WhatsApp, convites e recursos de inteligência artificial.',
        ] },
        { titulo: 'Quem é responsável', id: 'responsavel', paragrafos: [
            `O canal para exercer direitos e esclarecer dúvidas sobre proteção de dados é ${CANAL}. A responsável pelo tratamento é ${RESPONSAVEL} (“Demerzel Labs”). O encarregado pelo tratamento de dados pessoais é Felipe Menegaz, que atende pelo mesmo canal, ${CANAL}.`,
            'A Demerzel Labs é controladora dos dados de conta, assinatura, cobrança, suporte e segurança da plataforma. Para os dados pessoais que um contratante insere no sistema para atender seus próprios clientes, o contratante, pessoa física ou jurídica, é o controlador e a Demerzel Labs atua como operadora, conforme o Acordo de Tratamento de Dados, que integra os Termos de uso e está publicado em /acordo-de-tratamento.',
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
            'Alergias e observações de saúde devem ser registradas somente quando necessárias à festa e, preferencialmente, eliminadas 30 dias após o evento, salvo necessidade concreta de conservação, como incidente ou disputa. A eliminação é feita pela empresa cliente, que pode apagar essas observações a qualquer momento no cadastro da festa; a Demerzel Labs não aplica, por ora, eliminação automática e orienta a revisão 30 dias após o evento.',
            'Os formulários públicos dos sites das empresas devem identificar o buffet responsável, explicar a finalidade e oferecer link a este aviso antes da coleta.',
            'As instruções, responsabilidades, prestadores, incidentes e a devolução ou exclusão desses dados estão no Acordo de Tratamento de Dados.',
        ] },
        { titulo: 'Atendimento pelo WhatsApp', paragrafos: [
            'Quando o canal está habilitado, são tratados o número de telefone, o nome de perfil disponibilizado pelo WhatsApp, mensagens, referências a mídias, identificadores e horários das mensagens e estados de envio ou entrega. Esses dados permitem organizar o histórico, responder solicitações, enviar informações sobre eventos e transferir o atendimento à equipe.',
            'A integração utiliza os serviços do WhatsApp/Meta, que também tratam dados de acordo com suas próprias políticas. O atendimento pode usar respostas automáticas por regras e, quando a empresa cliente liga o assistente, respostas preparadas com inteligência artificial, conforme a seção seguinte. A pessoa pode pedir atendimento humano a qualquer momento e pedir para não ser mais contatada, por exemplo respondendo “PARAR”.',
            'O atendimento pelo WhatsApp é utilizado com dados de clientes reais. O uso de inteligência artificial nesse atendimento está descrito na seção seguinte.',
        ] },
        { titulo: 'Recursos de inteligência artificial', id: 'inteligencia-artificial', paragrafos: [
            'Os recursos de IA podem auxiliar no atendimento, na preparação de respostas, na leitura de documentos e na geração de imagens e convites. Conforme o recurso e o provedor habilitado, podem ser enviados textos, documentos, imagens e dados da festa. A geração de imagens e convites utiliza a OpenAI; o provedor utilizado é informado no momento da geração. Os filtros reduzem a exposição, mas não garantem anonimização. Os resultados podem conter erros e devem ser revisados antes do uso. Provedores, finalidades e condições de armazenamento constam da relação de prestadores. A ativação de cada recurso depende da verificação de suas condições contratuais e das salvaguardas aplicáveis.',
            'A geração de convites com IA pode envolver nome e idade da criança, data, local e endereço do evento e fotografia opcional, mediante as autorizações aplicáveis. Antes de gerar, a tela informa o provedor configurado e os dados que podem ser enviados, e a geração só ocorre depois de registrada a autorização específica do responsável legal pela criança, com o nome e o vínculo informados, para aquele provedor e para a versão atual do texto. Quando a equipe do buffet opera o editor, ela registra a autorização declarada pelo responsável e o meio pelo qual a recebeu. A fotografia e as imagens da galeria só são enviadas com uma confirmação própria, desmarcada, a cada geração. É possível criar o convite sem IA, com arte própria ou o visual padrão, e a autorização pode ser revogada para usos futuros no editor do convite ou pelo canal de privacidade deste aviso.',
            'O pedido de geração e a fotografia do convite não são guardados pelo iA.Fest; das imagens enviadas fica registrado apenas um código de verificação (hash). A imagem gerada é armazenada no iA.Fest e pode conter os dados da festa e continuar identificando a criança. Não há troca automática de provedor: se a configuração mudar, a geração é recusada até nova autorização.',
            'O Google Gemini não está habilitado para nenhuma empresa. Se vier a ser usado, este aviso e a relação de prestadores serão atualizados antes, com nova autorização do responsável para esse provedor.',
            'No atendimento pelo WhatsApp, a inteligência artificial só funciona para a empresa cliente cujo plano inclui esse recurso e que liga o assistente no painel. Com o assistente ligado, a mensagem atual e as mensagens recentes do cliente na mesma conversa, junto com as informações cadastradas pela empresa (agenda, pacotes, preços e respostas aprovadas), podem ser enviadas ao provedor de IA indicado na relação de prestadores, com dados pessoais ocultados por filtros. Mensagens com termos de saúde não são enviadas ao modelo: são tratadas pelas regras automáticas ou passam para a equipe da empresa, e o cliente pode pedir atendimento humano a qualquer momento. O número de respostas automáticas por conversa é limitado; atingido esse limite, ou se o provedor de IA estiver indisponível, a conversa passa para a equipe da empresa. As respostas podem conter erros; a empresa cliente é responsável pelas informações que cadastra e pode desligar o assistente a qualquer momento.',
            'A importação de documentos por IA não está disponível para as empresas clientes enquanto a eliminação controlada dos originais e das extrações não estiver implementada; pedidos de eliminação de documentos já importados são atendidos pelo canal oficial.',
            'O assistente da área administrativa e a importação de documentos por IA são anunciados como recursos futuros e não fazem parte da contratação atual; quando disponibilizados, este aviso e a relação de prestadores serão atualizados antes.',
        ] },
        { titulo: 'Finalidades e fundamentos do tratamento', id: 'finalidades', paragrafos: [
            'Tratamos dados de conta, assinatura, suporte e segurança para administrar o serviço, cumprir obrigações e proteger direitos, conforme a finalidade de cada operação. Nos cadastros e atendimentos das empresas clientes, seguimos suas instruções e as bases legais por elas documentadas. Dados de crianças exigem avaliação de seu melhor interesse; dados de saúde exigem hipótese legal específica para dados sensíveis. O aceite destes documentos não substitui consentimentos específicos nem autoriza tratamentos incompatíveis com a finalidade informada. A matriz abaixo detalha as operações.',
        ], tabela: { colunas: ['Finalidade', 'Papel e base', 'Limite importante'], linhas: [
            ['Conta, assinatura e suporte', 'Demerzel Labs controladora: execução contratual quando o titular for parte; legítimo interesse documentado para contatos e representantes da pessoa jurídica', 'O contrato entre empresas não fundamenta automaticamente todo dado de seus empregados ou representantes.'],
            ['Cobrança, tributos e defesa', 'Demerzel Labs controladora: obrigação legal e exercício regular de direitos, conforme o registro', 'Conservar os comprovantes necessários, não o banco inteiro.'],
            ['Identificação do contratante pessoa física (nome civil e CPF)', 'Demerzel Labs controladora: execução do contrato de que o titular é parte; obrigação legal fiscal, quando houver; exercício regular de direitos para provar o benefício Fundador já concedido e a continuidade CPF → CNPJ', 'CPF completo só nos registros restritos de contratação, cobrança e elegibilidade; auditoria com o documento mascarado.'],
            ['Autenticação e segurança', 'Demerzel Labs controladora: legítimo interesse; obrigação legal para registros exigidos', 'Minimização, acesso restrito e prazos separados.'],
            ['Orçamento e festa', 'Buffet controlador; Demerzel Labs operadora: contrato ou procedimentos solicitados pelo titular adulto', 'Não coletar CPF ou endereço antes de serem necessários.'],
            ['Cadastro de criança', 'Buffet controlador: consentimento específico como opção recomendada; outra base apenas com avaliação concreta do melhor interesse', 'Idade e nome são dados pessoais; não são sensíveis apenas por pertencerem a criança.'],
            ['Alergias e saúde', 'Buffet controlador: consentimento específico e destacado do responsável, quando necessário ao serviço', 'Legítimo interesse não fundamenta dados sensíveis. Proteção da vida serve a situações próprias, não como justificativa genérica de cadastro.'],
            ['Convite com IA e fotografia', 'Buffet controlador; Demerzel Labs operadora: consentimento específico para essa finalidade opcional', 'Separar geração por IA, uso da fotografia e eventual divulgação pública.'],
            ['Resposta a contato e marketing', 'Resposta solicitada: procedimentos preliminares ou outra base pertinente. Promoções: consentimento como padrão recomendado', 'Autorização promocional separada, desmarcada e revogável. “PARAR” deve interromper envios.'],
        ] } },
        { titulo: 'Compartilhamento e prestadores', id: 'prestadores', paragrafos: [
            'Utilizamos Render para hospedagem e banco; Asaas para cobrança e pagamentos; Resend para e-mails transacionais; Meta/WhatsApp para mensageria e verificação de identidade; OpenAI para a geração de convites com IA e para o assistente do atendimento pelo WhatsApp; e ViaCEP para consulta de endereço a partir do CEP. Cada serviço recebe somente os dados necessários à sua função. O Asaas também coleta diretamente dados fornecidos pelo pagador em sua página. Google Gemini e DeepSeek são integrações disponíveis no sistema e não habilitadas, que não serão ativadas sem avaliação prévia e atualização das informações pertinentes.',
            'Dados também podem ser fornecidos para atender obrigações legais ou ordens de autoridades competentes. Provedores, finalidades e condições de armazenamento dos recursos de IA, inclusive dos convites com IA, constam da relação abaixo, versionada com este aviso, que separa os prestadores em uso dos condicionais e das integrações apenas disponíveis. Na geração de convites, o provedor efetivamente usado é informado na tela antes do envio. Os termos de proteção de dados de cada prestador são os publicados por ele e aceitos na contratação; cópia é fornecida a pedido.',
        ], tabela: { colunas: ['Prestador', 'Entidade e país', 'Função', 'Dados enviados', 'Situação'], linhas: [
            ['Render', 'Render Services, Inc. (Estados Unidos)', 'Hospedagem da aplicação, do banco e dos arquivos', 'Todos os dados do sistema', 'Em uso'],
            ['Asaas', 'Asaas Gestão Financeira Instituição de Pagamento S.A. (Brasil)', 'Cobrança da assinatura e pagamentos', 'Nome civil e CPF (pessoa física) ou razão social e CNPJ (pessoa jurídica), identificador interno, plano e valores; o pagador informa seus dados diretamente ao Asaas', 'Em uso a partir da abertura comercial'],
            ['Resend', 'Plus Five Five, Inc., que opera a Resend (Estados Unidos)', 'E-mails transacionais', 'E-mail, nome, nome da empresa e links de acesso', 'Em uso desde 20/10/2026'],
            ['Meta/WhatsApp', 'Meta Platforms, Inc. e afiliadas (Estados Unidos e outros países)', 'Mensageria, conexão do número da empresa e códigos de verificação', 'Telefone, mensagens, mídias e códigos', 'Em uso conforme a integração'],
            ['OpenAI', 'OpenAI OpCo, LLC (Estados Unidos)', 'Geração de convites com IA e assistente do atendimento pelo WhatsApp', 'Dados selecionados da festa e pedido visual e, com confirmação a cada geração, fotografia e imagens da galeria; no atendimento, mensagens da conversa e informações cadastradas pela empresa, com filtros', 'Em uso nos convites com IA, com autorização registrada do responsável, e no atendimento quando a empresa liga o assistente. A OpenAI informa que dados enviados à API não são usados para treinar modelos por padrão, salvo opção de compartilhamento, e que conteúdos podem ser mantidos temporariamente para monitoramento de abuso, conforme a função; não prometemos retenção zero'],
            ['Google Gemini', 'Google LLC (Estados Unidos)', 'Geração de artes de convite com IA', 'Nenhum', 'Integração disponível, não habilitada'],
            ['ViaCEP', 'Serviço brasileiro de consulta de CEP (Brasil)', 'Consulta de endereço', 'Somente o CEP', 'Em uso'],
            ['DeepSeek', 'DeepSeek (China)', 'IA de texto', 'Nenhum', 'Integração disponível, não habilitada'],
        ] } },
        { titulo: 'Transferência internacional', id: 'transferencias', paragrafos: [
            'A aplicação, o banco e os arquivos hospedados no Render são mantidos na região Virginia, Estados Unidos. Outros prestadores podem tratar dados em países indicados na relação de transferências internacionais abaixo, que identifica o destinatário, os países, os dados, a finalidade, o instrumento contratual e a situação do mecanismo de transferência. Você pode solicitar informações sobre as salvaguardas pelo nosso canal de privacidade.',
            'A Meta/WhatsApp incorpora as cláusulas-padrão contratuais da ANPD (Resolução CD/ANPD nº 19/2024) aos seus termos de transferência. Os contratos públicos de tratamento de dados de Render, Resend e OpenAI, consultados pela Demerzel Labs, não incluem essas cláusulas-padrão (a Resend informa publicamente que não as adota). As transferências a esses prestadores ocorrem sob os contratos que eles oferecem, e o mecanismo de transferência previsto no art. 33 da LGPD ainda não está demonstrado para elas. A relação abaixo será atualizada se algum prestador passar a adotar as cláusulas-padrão. As transferências subsequentes seguem os compromissos assumidos por cada prestador em seus próprios termos. O Asaas e o ViaCEP tratam os dados no Brasil.',
        ], tabela: { colunas: ['Destinatário', 'Países', 'Dados', 'Finalidade', 'Instrumento contratual e situação do mecanismo de transferência'], linhas: [
            ['Render', 'Estados Unidos', 'Todos os dados do sistema', 'Hospedagem', 'Contrato de tratamento de dados do prestador, sem as cláusulas-padrão da ANPD; mecanismo do art. 33 da LGPD ainda não demonstrado'],
            ['Resend', 'Estados Unidos', 'E-mail, nome, nome da empresa e links de acesso', 'E-mails transacionais', 'Contrato de tratamento de dados do prestador, que informa não adotar as cláusulas-padrão da ANPD; mecanismo do art. 33 da LGPD ainda não demonstrado'],
            ['OpenAI', 'Estados Unidos', 'Dados selecionados da festa e, com confirmação, fotografia e imagens da galeria; mensagens da conversa e informações cadastradas pela empresa, com filtros', 'Geração de convites com IA e assistente do atendimento pelo WhatsApp', 'Contrato de tratamento de dados do prestador, sem as cláusulas-padrão da ANPD; mecanismo do art. 33 da LGPD ainda não demonstrado'],
            ['Meta/WhatsApp', 'Estados Unidos e outros países da Meta', 'Telefone, mensagens, mídias e códigos', 'Mensageria', 'Cláusulas-padrão da ANPD incorporadas aos termos de transferência do prestador'],
        ] } },
        { titulo: 'Armazenamento, segurança e retenção', id: 'retencao', paragrafos: [
            'A plataforma possui controles de autenticação e de acesso por empresa e perfil. Esses controles reduzem riscos, mas não representam garantia absoluta de segurança. Links de arquivos e de convites permitem acesso a quem os tiver; eles representam risco de exposição e devem ser compartilhados somente com quem precisa.',
            'Os prazos variam conforme a finalidade e constam da tabela de retenção abaixo. Encerrada a finalidade, os dados serão eliminados ou anonimizados, salvo conservação necessária por obrigação legal ou exercício de direitos. Restrições de exclusão serão individualizadas, justificadas e revistas. As cópias de segurança ficam isoladas do uso corrente e serão eliminadas no ciclo máximo informado. Se houver restauração, reaplicaremos as exclusões já determinadas.',
            'Os prazos da tabela distinguem a obrigação legal da política adotada pela Demerzel Labs; nenhum deles autoriza guardar todos os dados pelo maior prazo. Enquanto as rotinas automáticas de eliminação não estiverem em operação, os prazos são controlados por procedimento operacional da Demerzel Labs, com registro das eliminações realizadas (inclusive de cópias de segurança e cópias locais), disponível a pedido.',
        ], tabela: { colunas: ['Categoria', 'Prazo'], linhas: [
            ['Dados operacionais do buffet', 'Regra dos Termos: até 12 meses contados da suspensão posterior aos 60 dias de somente leitura; pedido anterior de exclusão pode antecipar o término.'],
            ['Contratos e evidências essenciais de contratação e aceite', 'Até 10 anos após o término da relação ou cumprimento, como política de defesa contratual, mediante necessidade documentada.'],
            ['Identificação do contratante (nome civil e CPF ou razão social e CNPJ) e registros de continuidade CPF → CNPJ', 'Durante o contrato e, depois, pelo prazo das evidências essenciais de contratação ou dos documentos fiscais, o que for aplicável; após a relação, apenas o necessário para provar o benefício já concedido e impedir sua repetição.'],
            ['Documentos fiscais da assinatura', 'Pelo prazo tributário aplicável, em regra cinco anos contados do primeiro dia do exercício seguinte ao da emissão (CTN, art. 173), com extensão enquanto houver procedimento ou crédito ainda não prescrito.'],
            ['Registros de acesso à aplicação', 'Seis meses; preservações adicionais individualizadas quando legalmente cabíveis. Isso não significa guardar conteúdo de mensagens por seis meses.'],
            ['Auditoria operacional e segurança adicional', '12 meses, salvo necessidade específica documentada.'],
            ['Conversas e mídias do WhatsApp', 'Conforme a seção “Conversas do WhatsApp”.'],
            ['Alergias e observações de saúde', 'Preferencialmente eliminar 30 dias após a festa, por ação da empresa cliente, salvo necessidade concreta de conservação, como incidente ou disputa.'],
            ['Cópias de segurança e exportações do banco', 'Ciclo máximo de 90 dias, incluindo cópias locais; prazo menor onde disponível.'],
        ] } },
        { titulo: 'Conversas do WhatsApp', id: 'conversas', paragrafos: [
            'O prazo padrão recomendado é de 12 meses sem atividade para eliminar as conversas e suas mídias; a empresa controladora pode configurar outro prazo, de 1 dia a 10 anos, sob sua responsabilidade. Enquanto a empresa não configurar um prazo, as conversas não são eliminadas automaticamente: a Demerzel Labs orienta a configuração e atende os pedidos de exclusão. Pedidos de exclusão serão avaliados antes desse prazo. Após excluir o conteúdo, conservamos por 30 dias os identificadores técnicos protegidos necessários para impedir a recriação por reentrega. O registro mínimo de “não contatar” é mantido para respeitar a oposição, sem conservar a conversa. A exclusão não alcança automaticamente cópias de terceiros; quando cabível, encaminharemos a solicitação aos destinatários.',
            'Enquanto a eliminação periódica não estiver em operação, a Demerzel Labs aplica o prazo por procedimento operacional, com registro, e atende pedidos de exclusão pelo canal oficial.',
        ] },
        { titulo: 'Direitos e pedidos de exclusão', id: 'exclusao-de-dados', paragrafos: [
            'Você pode solicitar confirmação do tratamento, acesso, correção, informações sobre compartilhamento, portabilidade quando aplicável, revogação do consentimento e anonimização, bloqueio ou exclusão nas hipóteses previstas na legislação. Também pode apresentar petição à Autoridade Nacional de Proteção de Dados (ANPD).',
            `Envie o pedido para ${CANAL}, com o assunto “Privacidade — iA.Fest” ou “Exclusão de dados — iA.Fest”. Informe qual é o pedido e o e-mail ou telefone utilizado no serviço. Se o atendimento foi feito por um buffet, indique o nome dele para localizarmos a empresa responsável. Não envie senhas nem códigos de verificação.`,
            'A confirmação da existência de tratamento e o acesso aos dados em formato simplificado são fornecidos imediatamente; a declaração clara e completa, em até 15 dias contados do pedido, conforme a LGPD. Os demais pedidos são respondidos nos prazos legais aplicáveis ou, na falta deles, em prazo razoável informado ao solicitante. Cada pedido recebe confirmação de recebimento por e-mail, com número de protocolo e data, e é acompanhado em registro próprio da Demerzel Labs até a resposta.',
            'Podemos solicitar informações proporcionais para confirmar sua identidade e evitar acesso ou exclusão indevidos. Quando a decisão couber à empresa cliente, o pedido será encaminhado ou será indicado o canal responsável. Esse contato por e-mail também pode ser utilizado por quem não tem mais acesso à conta.',
            'A exclusão pode ter limites decorrentes de obrigações legais e da preservação de direitos; eventuais restrições devem ser explicadas ao solicitante. A exclusão na plataforma não remove automaticamente mensagens do aparelho de destinatários, cópias já baixadas ou dados mantidos por serviços externos. O atendimento do pedido deve considerar esses destinatários e as cópias de segurança aplicáveis.',
        ] },
        { titulo: 'Atualizações deste aviso', paragrafos: [
            'A versão e a impressão digital exibidas nesta página identificam o texto atual. Mudanças neste aviso recebem uma nova versão; os registros de aceites anteriores não são substituídos por este texto. Mudanças relevantes serão comunicadas com destaque às empresas clientes, com registro da ciência, que não equivale a consentimento para tratamentos específicos: esses são pedidos separadamente.',
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
