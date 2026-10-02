# Atendimento automático por IA no WhatsApp

Especificação proposta em 01/10/2026 para a próxima entrega, junto das correções de UX. Objetivo: atender interessados, responder com dados aprovados da empresa, consultar datas e encaminhar a contratação ou o atendimento humano. Escopo comercial inicial recomendado; a inclusão de clientes já contratados ainda depende de decisão de produto e identificação específica.

## Base existente e lacunas

| Componente | Encontrado | Trabalho necessário |
| --- | --- | --- |
| Canal da IA | [Política WHATSAPP](../lib/inteligencia/canais.ts) permite READ e SUGGEST; confirmação somente no Admin | Adaptador do canal, contexto externo restrito e ferramentas comerciais próprias |
| Webhook Gupshup | [Rota](../app/api/integracoes/gupshup/webhook/route.ts) e [receptor documentado](GUPSHUP_WEBHOOK_STAGING.md) validam eventos e registram projeção sanitizada | Persistência durável, tratamento de mensagens e correlação de status |
| Conteúdo recebido | O receptor atual descarta o conteúdo; ACK não significa persistência | Normalização mínima, retenção e fila de processamento |
| Envio | [Gupshup OTP](GUPSHUP_OTP_STAGING.md) transporta autenticação | Transporte específico de atendimento; não reutilizar template ou fluxo OTP |
| Conexões | [Onboarding Meta](../lib/whatsapp/onboarding.service.ts) permite conexão por ambiente, com autoridade global | Definir provedor piloto e associação explícita conexão, empresa e unidades |
| Conversas | IA administrativa e suas políticas existem | Caixa de atendimento, responsável humano, pausa da IA e histórico externo segregado |

O código atual não comprova um bot operacional. Os registros antigos sobre aprovação Meta não comprovam a situação atual do número; revalidar ativos, entrega e autenticação antes do piloto. Não conectar o contexto externo à sessão ou ferramentas de um administrador.

## Escopo recomendado da primeira versão

- Responder dúvidas sobre endereço, horários, estrutura e regras aprovadas da empresa.
- Apresentar pacotes e itens do catálogo comercial publicado.
- Consultar data, horário, unidade e capacidade pelas APIs oficiais, sem expor detalhes de outras festas.
- Coletar nome do responsável, data e horário desejados, unidade, convidados e pacote de interesse. Perguntar o ano quando necessário e rejeitar datas inválidas.
- Preparar resumo de interesse ou solicitação comercial e encaminhar para revisão no painel ou fluxo oficial de fechamento.
- Transferir para humano quando solicitado, quando faltarem dados confiáveis, em negociação excepcional, reclamação ou falha.

Não entram inicialmente: campanhas ou disparos proativos, áudio/OCR, leitura de contratos privados, alterações financeiras, aceite contratual pela IA, confirmação de pagamento, reserva automática ou criação de festa confirmada. A coleta de interesse e a caixa de atendimento podem persistir dados mínimos; não confundem isso com autorização para operações comerciais CONFIRM.

## Jornada de atendimento

1. Uma mensagem chega ao número comercial conectado. O servidor comprova origem e resolve a empresa pela configuração do provedor, antes de gravar ou consultar dados.
2. A conversa usa empresa, conexão e remetente; não apenas telefone. Se o número atende múltiplas unidades, perguntar qual unidade antes de consultar disponibilidade ou preço específico.
3. O assistente se apresenta como atendimento virtual da empresa e oferece acesso a uma pessoa.
4. Consulta fontes aprovadas e ferramentas restritas. Não inventa preço, cardápio, desconto, disponibilidade ou cláusula.
5. Faz perguntas curtas e preserva o contexto já informado. Em ambiguidade, pede esclarecimento.
6. Ao receber intenção de fechar, prepara o resumo e encaminha para conferência no Admin ou link seguro do fluxo oficial. Informar claramente que consulta de disponibilidade não garante reserva.
7. Quando um humano assume, a IA pausa nessa conversa. Retomada exige ação explícita do atendente e nova checagem do estado.

Exemplo de resposta proposta: “Sou o atendimento virtual da Kidmais. Posso ajudar com pacotes e datas. Qual data e quantidade de convidados você tem em mente? Se preferir, posso chamar um atendente.”

## Telas necessárias

**Atendimento → Conversas:** lista por empresa e unidade, não lidas, responsável e situação; histórico no centro; resumo do interesse ao lado. No celular, navegar entre lista, conversa e resumo.

Ações visíveis: Assumir atendimento, Pausar IA, Retomar IA, Encaminhar para contratação e Encerrar. Estados propostos: Em atendimento pela IA, Aguardando humano, Em atendimento humano e Encerrada. Mensagens têm status de envio separado do estado da conversa.

**Configurações → WhatsApp e IA:** conexão e número, unidade padrão ou seleção, fontes publicadas, horários dos atendentes, mensagem de ausência, limites de consumo e modo Desligado, Simulação ou Piloto ativo. “Conectado” e “IA atendendo” devem aparecer separadamente.

**Plataforma → Integrações e consumo:** situação técnica e limites por empresa. Conteúdo de conversas continua sujeito ao acesso de suporte definido no [plano da plataforma](ADMINISTRACAO_PLATAFORMA_PLANO.md).

## Arquitetura proposta

Fluxo: provedor → receptor autenticado → evento durável → fila → resolução de contexto e política → ferramentas e modelo → caixa de saída → transporte → eventos de entrega.

- Validar autenticação real suportada pelo provedor e formato antes de aceitar eventos. O header próprio atual precisa de compatibilidade comprovada; se o fornecedor não o suporta, escolher um mecanismo oficial verificável. Não tornar mensagens normais públicas por conveniência.
- Confirmar recepção somente após registro durável. Persistência indisponível deve produzir resposta que permita retry do provedor, e não ACK de processamento fictício. Não usar apenas after() para a tarefa durável.
- Deduplicar eventos e operações por ambiente, conexão e identificador externo; serializar o processamento por conversa e descartar tarefas incompatíveis com pausa, suspensão ou mudança de responsável.
- Fila com tentativas limitadas, atraso, estado de falha e recuperação administrativa. Escolha do mecanismo de fila e worker é decisão técnica pendente.
- Caixa de saída com estados Pendente, Submetida, Entregue, Falhou e Resultado incerto. Timeout após envio não pode causar reenvio cego. Verificar idempotência e reconciliação oferecidas pelo transporte; não prometer entrega exatamente uma vez.
- Revalidar pausa, acesso, janela de atendimento e orçamento imediatamente antes do envio, inclusive para respostas geradas antes de um humano assumir.
- Ferramentas do canal externo usam contexto de empresa comprovado e acesso comercial mínimo. Um contato conhecido não equivale a usuário administrativo nem comprova direito a qualquer contrato.
- Modelos recebem somente os dados necessários e fontes aprovadas. Texto de cliente ou de documento não concede privilégios nem altera regras.
- Separar autenticação e OTP do agente. Identificação para dados privados, se aprovada posteriormente, deve usar fluxo próprio verificado; o modelo não recebe códigos ou credenciais.

## Regras do canal verificadas

Segundo a [política oficial do WhatsApp Business](https://business.whatsapp.com/policy?lang=pt_BR), consultada em 01/10/2026, respostas sem template ficam restritas à janela de atendimento de 24 horas, reiniciada por mensagem do usuário. Fora dela, o envio exige template aprovado. Automação precisa oferecer encaminhamento claro e direto para suporte. Respeitar pedidos para interromper comunicações e registrar as permissões necessárias para mensagens posteriores.

O MVP responde a conversas iniciadas pelo interessado. Não inicia campanhas, follow ups ou notificações proativas. Janela e elegibilidade são regras de servidor, não decisões do modelo. Tarifas de Meta, Gupshup e IA devem ser verificadas no momento da contratação; este documento não fixa preço nem presume gratuidade.

Referências técnicas: [mensagens de sessão Gupshup](https://docs.gupshup.io/docs/session-messages-1) e [webhooks Gupshup](https://docs.gupshup.io/docs/what-is-a-webhook). Formato, suporte a autenticação, limites e entrega real precisam de homologação para o provedor escolhido.

## Dados e custos

Proposta de entidades a compatibilizar com o schema existente: conexão por empresa, conversa, evento recebido, mensagem, encaminhamento, interesse comercial e registro de consumo. Identificadores de conexão, empresa e unidade são definidos pelo servidor.

Não versionar mensagens reais, telefones completos ou credenciais. Definir retenção, acesso a histórico e descarte antes do piloto. Não solicitar documentos, números de cartão ou informações sensíveis pelo chat; contratação e identificação seguem as telas adequadas. Dados de crianças não são necessários para a qualificação inicial.

Orçamento por empresa e conversa, limite de mensagens/tamanho, limite de chamadas de ferramentas e contenção de abuso. Ao atingir limite ou falhar uma dependência, oferecer encaminhamento humano sem inventar uma resposta. Política de cobrança da plataforma permanece pendente.

## Critérios de aceite

| Cenário | Resultado exigido |
| --- | --- |
| Evento sem origem comprovada ou conexão desconhecida | Não consulta tenant, não responde e não grava conteúdo de negócio |
| Mesmo evento repetido | Não duplica conversa, interesse ou tentativa de resposta |
| Mensagens em sequência | Mantém ordem lógica e não responde com estado antigo |
| Data inválida ou ano ausente | Pergunta ou aponta o problema, sem alterar silenciosamente |
| Pacote ou informação inexistente | Não inventa; oferece alternativa publicada ou humano |
| Consulta de agenda | Informa disponibilidade sem divulgar identidade de outras festas nem reservar |
| Pedido de desconto, confirmação de festa ou pagamento | Encaminha à decisão humana e não executa operação protegida |
| Pedido de atendente ou humano assume durante geração | Pausa IA, encaminha e impede resposta concorrente |
| Janela expirada antes de enviar | Não envia resposta livre |
| Timeout de transporte ou status fora de ordem | Mantém correlação e resultado incerto sem retry cego |
| Limite de consumo, falha de modelo ou suspensão | Interrompe automação de forma controlada e conserva encaminhamento |
| Contato pede informações de outro cliente | Não divulga conteúdo privado |
| Duas empresas e texto tentando mudar empresa ou privilégios | Isolamento mantido |
| Piloto desligado | Nenhuma nova resposta automática; mensagens pendentes tratadas conforme política de pausa |

## Decisões e pendências de ativação

O usuário confirmou Gupshup e o número atual da Kidmais. A candidata local do piloto está descrita em [HANDOFF_CLAUDE_UX_WHATSAPP.md](HANDOFF_CLAUDE_UX_WHATSAPP.md); este plano é a referência de evolução e critérios, incluindo funções ainda não ligadas, como consulta de agenda. A confirmação do canal não atesta credenciais, worker, migration ou envio homologados.

1. Escopo inicial: interessados somente ou também clientes contratados. Recomendação atual: interessados.
2. Provedor: seguir Gupshup no piloto ou Meta Cloud diretamente. Recomendação condicionada: aproveitar Gupshup se autenticação, número e envio estiverem homologados. Não conectar os dois ao mesmo fluxo sem um desenho explícito.
3. Número piloto e responsável por credenciais e custos. Uso do número atual exige verificar cadastro, titularidade e eventual coexistência antes de mudar a conexão.
4. Unidade padrão e comportamento quando o contato não informa a unidade.
5. Quem atende a fila humana, horários e mensagem de ausência; não prometer atendimento imediato fora desses horários.
6. Fontes comerciais publicadas, regras de preço e o ponto exato de encaminhamento para o fechamento.
7. Orçamento, retenção e armazenamento mínimo; mecanismo de fila e critérios de retorno ao humano.

Decisões ainda abertas não constituem autorização para envio real. Implementação e piloto seguem [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md), com dados sintéticos primeiro e contatos de teste autorizados depois.
