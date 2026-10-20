# Homologação externa — preparação

**Atualização em 09/10/2026 — webhook externo aprovado:** após autorização de Felipe, o [ensaio isolado](HOMOLOGACAO_WEBHOOK_20261009.md) confirmou checkout real, pagamento simulado, entrega externa Asaas e atualização automática para acesso completo. Corrigida rejeição de IDs de evento com `&`; reentrega externa processada e replay local idempotente. Cancelamento pela aplicação preservou o período pago. Recorrência e webhook temporário encerrados; túnel, aplicação e cluster parados. Os relatos abaixo preservam as etapas anteriores e suas limitações naquele momento.

Felipe confirmou conta sandbox Asaas disponível e indicou seu próprio endereço como destinatário de teste. A execução externa ainda não ocorreu: credenciais indisponíveis no processo. Nenhuma mudança em Render, banco, webhook remoto ou cobrança foi feita nesta preparação.

## Atualização: primeira conexão externa

Após configuração pelo usuário e confirmação para avançar, executado `configurar-sandbox-local.ps1 -TestarConexao`. O processo decifra as credenciais apenas para o filho, sem devolvê-las ao agente. Script `assinatura-sandbox-conexao.cjs` restringe o Asaas a GET de cliente por referência aleatória exclusiva e o e-mail a um POST Resend para o destinatário autorizado, usando `onboarding@resend.dev` como remetente de teste. A configuração salva de remetente não foi sobrescrita.

Resultado: **Asaas sandbox autenticou e respondeu à consulta. Resend recusou o envio com HTTP 401**. Nenhum cliente, cobrança ou assinatura foi criado. Nenhum envio aceito foi confirmado. Registro local `.local-assinatura-sandbox/teste-conexao.json`, sem chaves, preserva identidade/tentativa para retry idempotente; janela de retry limitada a 23 horas. Sucesso de autenticação Asaas não comprova criação de cobrança, pagamento, renovação ou webhook.

Preparado `-AtualizarResend` para substituir somente a chave Resend em entrada oculta, mantendo Asaas/token/remetente; por padrão faz apenas diagnóstico offline. O usuário precisa fornecer uma chave API válida do Resend. Corrigida também a codificação do assistente para UTF-8 com BOM, compatível com Windows PowerShell. Nenhuma mudança em produção ou banco.

Após a atualização informada pelo usuário, o retry permaneceu HTTP 401. Diagnóstico offline comprovou prefixo esperado, ausência de espaços/quebras e de aspas nas extremidades, sem revelar conteúdo. Consulta de erro retornou `validation_error` com indicação explícita de API key inválida (`chaveRecusada: true`); somente classificações permitidas foram salvas/exibidas, nunca a resposta bruta. Asaas continua autenticando. Envio não aceito; novas tentativas suspensas até fornecimento de chave válida. É necessário copiar o segredo completo de uma API key ativa do Resend, não o ID da chave. ESLint e diff check aprovados; nenhuma mudança em aplicação, banco ou produção.

## Configuração local segura

### Ciclo de assinatura no Asaas sandbox — aprovado em 09/10/2026

Após o pedido “próximo passo” em resposta à proposta de criar assinatura, simular pagamento e cancelar, executado `configurar-sandbox-local.ps1 -TestarAssinatura`. O script `assinatura-sandbox-ciclo.cjs` usa o adaptador real da aplicação, base fixa sandbox, referência única e intenções persistidas antes de POST. Credenciais protegidas são injetadas apenas no processo; nunca impressas. Nenhum banco Kidmais foi conectado.

Criado cliente sintético sem contatos e com notificações desativadas, utilizando o documento do exemplo público da referência Asaas (não o CNPJ da Kidmais). Criada assinatura Essencial mensal de **R$ 118,20**. Conferidos ciclo, cliente, referência e valor da cobrança. Pagamento confirmado pelo endpoint exclusivo sandbox; reconsulta retornou **RECEIVED**. Recorrência removida pelo adaptador e reconsulta confirmou encerramento; nova consulta à cobrança comprovou pagamento preservado. **PASS**.

Evidência local: `.local-assinatura-sandbox/ciclo-assinatura.json`, com IDs dos objetos sintéticos, intenções e resultados, sem credenciais. Cliente de teste e cobrança paga simulada permanecem no sandbox para rastreabilidade; assinatura não permanece ativa. Nova execução retorna rodada já concluída e não repete mutações. Nenhum e-mail adicional, webhook configurado, pagamento real ou alteração em produção. ESLint aprovado; PowerShell foi executado com sucesso. Somente scripts/documentação mudaram, sem novo build da aplicação.

Limites: este ensaio validou criação, pagamento e cancelamento pela API externa. Não testou atualização de acesso no banco Kidmais, recebimento de webhook externo, pagamento anual, cartões, nem reajuste após 12 meses. Próxima etapa: preparar endpoint HTTPS isolado para webhook e fixture dedicada de integração, sem reutilizar reservas artificiais da base anterior.

**Entrega confirmada pelo destinatário em 09/10/2026:** Felipe informou que recebeu o e-mail de teste. Ficam comprovados a autenticação Asaas sandbox, a aceitação do envio pelo Resend e o recebimento da mensagem de teste. Não comprova ainda o agendamento do aviso Fundador, renovação automática, cobrança, confirmação de pagamento ou webhook externo. Nenhuma nova mensagem foi enviada ao registrar essa confirmação.

Atualização final em 09/10/2026: após criar uma nova chave Resend, o usuário a salvou pelo assistente. O teste externo retornou **Asaas AUTENTICACAO_APROVADA e e-mail ACEITO_PELO_RESEND**, com ID de envio salvo apenas no registro local. Destinatário autorizado: Felipe; remetente de teste `onboarding@resend.dev`. Nenhuma cobrança criada. Aceitação da API ainda depende de confirmação do usuário para comprovar chegada à caixa de entrada. Corrigida a limpeza dos indicadores de erro antigos no relatório após sucesso, sem repetir o envio.

Executar `scripts/configurar-sandbox-local.ps1` no PowerShell interativo. O assistente pede chave Asaas sandbox e chave Resend em entrada oculta, além do remetente autorizado no Resend. Não colocar chaves em argumentos, chat ou arquivos .env.

O arquivo `.local-assinatura-sandbox/credenciais.clixml` guarda os segredos como SecureString protegido pelo usuário Windows. O caminho está coberto pelo gitignore; não compartilhar nem versionar. O token de webhook é gerado localmente e protegido da mesma forma, mas não é registrado no Asaas por este assistente. O segredo só é disponibilizado no ambiente de um processo filho para diagnóstico e o ambiente anterior é restaurado ao terminar. Não há chamada de rede ou banco. `-Verificar` repete apenas o diagnóstico com o arquivo existente, sem mostrar chaves. Não abrir o arquivo de credenciais em ferramentas de leitura do agente.

O diagnóstico verifica o formato aceito pela aplicação, sem comprovar validade da chave ou titularidade da conta. A preparação foi validada com parser PowerShell, ESLint e execução offline sem credenciais: retornou ambiente Asaas ausente e Resend não configurado, sem rede. Nenhuma credencial foi solicitada via ferramenta ou salva pelo agente.

## Roteiro proposto para execução após configuração

1. Confirmar que a chave autentica apenas na base fixa `https://api-sandbox.asaas.com/v3`. Identificar a conta de teste sem imprimir chave ou dados pessoais. Registrar referência única da rodada e objetos criados em evidência local; nunca usar IDs arbitrários de clientes existentes.
2. Criar cliente sintético com notificações desativadas e sem contatos de terceiros. Criar assinatura Essencial mensal da rodada, R$ 118,20 para o cenário Fundador; listar a cobrança e conferir cliente, assinatura, referência, valor e status pendente. O documento de teste deverá ser apropriado para sandbox, sem utilizar o CNPJ real da Kidmais.
3. Confirmar exclusivamente essa cobrança pelo endpoint de simulação sandbox `POST /sandbox/payment/{id}/confirm`. Reconsultar e validar o estado retornado; não substituir isso por recebimento em dinheiro, que a aplicação deliberadamente recusa para confirmar a oferta.
4. Validar o fluxo local de confirmação e repetição do evento usando banco sintético dedicado à rodada. A base anterior tem 20 reservas de testes e uma assinatura cancelada: não reaproveitar esses IDs nem liberar vagas apenas para fazer o teste passar. Preparar o alvo e as fixtures antes da próxima escrita.
5. Testar atualização do preço regular (R$ 197,00) e cancelamento somente nos objetos da rodada. Separar a prova da API da regra temporal de 12 meses/aviso de 30 dias; não adulterar históricos para fingir que o prazo real transcorreu. Reconsultar antes de repetir POST/PUT com resposta perdida.
6. Preparar mensagem claramente identificada como teste de aviso Fundador, contendo plano, preço regular, data e instrução de cancelamento; enviar somente ao destinatário indicado por Felipe. Usar chave idempotente persistida e o mesmo conteúdo no retry. Registrar ID do envio, sem chave nem conteúdo sensível. Confirmação de aceitação da API não comprova recebimento na caixa: conferir resultado no provedor e com o destinatário.
7. Encerrar recorrências sintéticas criadas e comprovar estado final; preservar cobranças pagas simuladas e evidências. Sem cancelamento/exclusão de objetos de terceiros. Erro em etapa intermediária exige reconsulta, não limpeza indiscriminada.

O worker `assinatura-renovar.cjs --aplicar` continua limitado a e-mail em arquivo. Não relaxar essa trava global para enviar teste: preparar um ensaio separado com destinatário explicitamente limitado. O roteiro ainda não é um executável de mutações externas.

## Webhook e limites

A rota existente é `/api/integracoes/asaas/webhook`. Callback real exige endpoint HTTPS acessível pelo Asaas, token e ambiente isolado. Nenhum túnel, URL pública ou configuração de webhook foi criado. Reconciliar por consulta e chamar um evento local sintético não comprova entrega do webhook externo. Não marcar essa etapa como homologada sem a prova correspondente.

## Fontes oficiais consultadas em 09/10/2026

- [Asaas: confirmar pagamento no sandbox](https://docs.asaas.com/reference/confirmar-pagamento): confirmação simulada, sem movimentação real, indisponível em produção.
- [Asaas: criar assinatura](https://docs.asaas.com/reference/criar-nova-assinatura): criar assinatura não confirma pagamento; cobranças futuras são geradas gradualmente.
- [Resend: endereços de teste](https://resend.com/docs/dashboard/emails/send-test-emails): endereços específicos simulam entrega/bounce; consomem quota e não substituem comprovação de entrega ao destinatário humano.
