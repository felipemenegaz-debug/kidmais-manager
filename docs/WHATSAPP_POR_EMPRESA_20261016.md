# WhatsApp por empresa (migration 083), 16/10/2026

Cada empresa (tenant) conecta o próprio WhatsApp Business ao Kidmais pelo Embedded Signup da Meta.

**Escopo desta entrega: só a conexão.** Conectar, ver o estado e desconectar. O envio e o recebimento de mensagens, o webhook e o OTP **não** mudam: o atendimento e o OTP continuam na Gupshup, com o número da Kidmais.

## Regras

- **Quem pode:** só a **Gestão da empresa** (`memberships.papel = REPRESENTANTE_AUTORIZADO` na empresa comprovada por `provarTenant`) consulta, conecta e desconecta. Conectar e desconectar exigem a senha reconfirmada há menos de 5 minutos. O papel global (`usuarios_administrativos.papel`) não decide.
- **Unicidade:** uma conexão CONFIGURADA por (ambiente, empresa), e o mesmo `phone_number_id` em no máximo uma conexão CONFIGURADA por ambiente. A violação é recusada com 409 `WHATSAPP_NUMERO_EM_USO`, sem dizer qual empresa usa o número.
- **Vínculo com a empresa:** tentativa, lock e credencial são presos à empresa. A AAD do AES-256-GCM inclui o `empresaId`. Se a empresa ativa muda no meio do fluxo, a conclusão é recusada (`WHATSAPP_TENTATIVA_INVALIDA`).
- **Desconectar:** CONFIGURADA → DESCONECTADA (transição da 018), com motivo e auditoria `WHATSAPP_CONEXAO_DESCONECTADA`. Depois disso o número fica livre.
- **Navegação:** o menu e o hub de Configurações mostram o WhatsApp para a Gestão da empresa. O painel do desenvolvedor só acompanha, na ficha da empresa.
- **Conexão antiga da plataforma** (sem empresa, criada antes da 083), se existir: fica preservada e inerte, e não aparece para nenhuma empresa.

## Migration 083 (`database/migrations/20261016_083_whatsapp_conexao_empresa.sql`)

Aditiva. Nenhuma linha existente é alterada.

- `empresa_id` em `whatsapp_conexoes` e `whatsapp_onboarding_tentativas`.
- CHECKs `NOT VALID`: conexão CONFIGURADA nova e tentativa em andamento nova exigem empresa.
- Índices novos:
  - por empresa;
  - da plataforma (sem empresa);
  - por número;
  - tentativa ativa por empresa.
- O índice antigo, de uma conexão por ambiente, sai.
- Os gatilhos da 018 são recriados com `empresa_id` na identidade imutável.
- Pré e pós-checagem em `database/checks/20261016_083_*`.
- **O pós-check confere as definições pelo catálogo, não só os nomes** (R2 do parecer independente de 16/10):
  - colunas `empresa_id` do tipo `uuid`, com FK validada para `empresas(id)`;
  - CHECKs com a expressão exata (`pg_get_expr`), na tabela certa;
  - índices únicos, válidos, btree, com as colunas e o predicado exatos;
  - gatilhos ligados às tabelas: habilitados, `BEFORE UPDATE OR DELETE FOR EACH ROW` (tgtype 27), sem WHEN nem lista de colunas, na função certa;
  - corpo das funções, por md5 do `prosrc` com CR ignorado.

  Um objeto de mesmo nome com definição diferente reprova. Os controles negativos estão em `lib/whatsapp/conexao-empresa.postgres.test.ts`.
- O rollback (`database/rollback/20261016_083_whatsapp_conexao_empresa_down.sql`) se recusa a rodar quando já existe conexão ou tentativa de empresa (veja a recuperação abaixo).

## Recuperação depois que a 083 tiver dados

Depois do primeiro onboarding de qualquer empresa, mesmo um que falhou, o rollback SQL **se recusa** a rodar: tentativas e conexões de empresa são histórico preservado (os gatilhos da 018 impedem DELETE). **Não há reversão automática do banco a partir desse ponto.** O plano distingue dois casos:

- **Retorno de código (deploy anterior do web):** possível, com a 083 mantida, porque ela é aditiva. Efeitos conhecidos do código anterior sobre um banco com a 083:
  - a tela antiga do WhatsApp só abre para a conta da plataforma;
  - ela consulta a conexão CONFIGURADA do ambiente sem filtrar empresa, e pode mostrar a conexão de uma contratante como se fosse a da plataforma;
  - o "conectar" antigo é recusado (o CHECK exige empresa; o índice por número também se aplica).

  O caminho preferido é corrigir para a frente, sem voltar o código do WhatsApp.
- **Recuperação do schema (desfazer a 083 com dados):** não há procedimento pronto. Exigiria um plano próprio, revisado e autorizado. Por exemplo:
  1. desconectar as conexões pela tela, com auditoria;
  2. preservar as linhas num arquivo ou tabela de histórico;
  3. só então remover as colunas e os índices.

  Esse plano nunca apaga auditoria nem tentativas por SQL avulso.

## Observações registradas (sem mudança de código nesta etapa)

- **Conexão legada da plataforma (sem empresa):** se existir no ambiente, continua CONFIGURADA, inerte e participando do índice único por número.
  - O número dela **não pode** ser adotado por uma empresa enquanto essa linha estiver CONFIGURADA.
  - As telas novas não a mostram nem a desconectam.
  - Transferir esse número exige um procedimento próprio e autorizado. A linha nunca é alterada automaticamente.
- **Filtro de ambiente na ficha do painel:** `whatsappDaEmpresa` (`lib/desenvolvedor/empresas.ts`) lê a conexão da empresa sem filtrar `ambiente`.
  - Com bancos separados por ambiente, o resultado não muda.
  - Num banco com registros dos dois ambientes, poderia mostrar o número do outro ambiente; não há exposição entre empresas.
  - Ajuste recomendado (filtrar pelo ambiente do deploy), não feito nesta entrega.

## Ordem de publicação em staging (cada passo com autorização própria)

1. **Commit e deploy do web.** O código tolera a 083 ausente: o WhatsApp responde 503 `WHATSAPP_ATUALIZACAO_PENDENTE`, e a ficha do painel omite o bloco. O cron não muda.
2. **Conferência, somente leitura, no Shell do web de staging:**
   ```
   node scripts/migration-083-staging.cjs --conferir-083
   ```
   O resultado precisa trazer `CONFERIDO`, `schema.m083 = false` e `schema.pode_alterar = true` (o login do serviço é membro do papel dono das tabelas da 018). Com `pode_alterar = false`, a aplicação para antes de escrever (`SEM_PRIVILEGIO_DDL`).
3. **Aplicação:**
   ```
   node scripts/migration-083-staging.cjs --aplicar-083-autorizado
   ```
   - Roda o precheck (somente leitura), a 083 e o postcheck, a partir dos hashes revisados.
   - Grava a evidência em `/opt/render/project/src/data/atualizacao-staging-20261016`.
   - Uma tentativa anterior bloqueia uma nova até ser revisada.
4. **Validação funcional** com uma empresa real de homologação, como Gestão:
   - Configurações › WhatsApp abre com o nome da empresa;
   - "Preparar conexão" e "Continuar na Meta" abrem a janela da Meta.

**Do lado da Meta:** para empresas de terceiros conectarem, o app precisa do acesso avançado (`whatsapp_business_management` e `whatsapp_business_messaging`) ou de provedor de tecnologia, aprovado na revisão do app. Sem isso, só números ligados às contas de teste do app conectam.

## Testes

- `lib/whatsapp/conexao-empresa.postgres.test.ts`, modelo `083` do PostgreSQL descartável, com a Meta dublada. Cobre:
  - rollback e reaplicação com a conexão antiga preservada;
  - Gestão conecta;
  - isolamento A/B;
  - número único;
  - Equipe e senha antiga recusadas;
  - troca de empresa no meio do fluxo;
  - desconexão;
  - 503 antes da 083;
  - credencial presa à empresa.
- Unitários:
  - `lib/whatsapp/onboarding.test.ts`;
  - `lib/autenticacao/plataforma.test.ts` (o WhatsApp deixou de ser da plataforma; o PDF de Pacotes continua);
  - `lib/autenticacao/contexto.test.ts`;
  - `lib/admin/navegacao.test.ts`;
  - `components/admin/WhatsappConfiguracao.popup.test.mjs`;
  - `scripts/migration-083-staging.test.cjs` (na CI).

## Validação da WABA (R1) e evento da coexistência (R2): 16/10/2026

### R1: o que mudou

**Antes:** a WABA era conferida em `GET /{business_id}/client_whatsapp_business_accounts`, usando o `business_id` **do cliente** vindo do evento. A documentação descreve essa aresta como a lista das WABAs atribuídas ou compartilhadas **com o portfólio do parceiro** depois do Embedded Signup. Com o portfólio do cliente, a WABA dele não aparece ali, e a conexão legítima seria recusada (`META_WABA_DIVERGENTE`).

**Agora** (`lib/whatsapp/meta-client.ts`): **autorização** e **pertencimento** são provas diferentes.

**Mantido:**
- a troca do código;
- o `debug_token` (válido, mesmo `app_id`, escopos `whatsapp_business_management` e `whatsapp_business_messaging`);
- `GET /{waba_id}/phone_numbers` com o token do cliente: número na WABA, `is_on_biz_app = true`, número de exibição e nome verificado.

**1. Autorização** (o token recebeu acesso a cada ativo), em `debug_token.data.granular_scopes`:
- `whatsapp_business_management.target_ids` contém o `waba_id`. Senão: `META_WABA_DIVERGENTE`.
- `business_management.target_ids` contém o `business_id`. Senão: `META_NEGOCIO_DIVERGENTE`.
- Sem `granular_scopes`: `META_AUTORIZACAO_INCOMPLETA`. Escopo sem `target_ids` explícitos: recusa.
- **Isto não prova a relação entre os dois.** As listas são independentes: um token autorizado em dois negócios aceitaria a WABA de um com o negócio do outro (achado B1 da revisão de `8d25432`).

**2. Pertencimento WABA ↔ negócio** (o negócio informado POSSUI a WABA informada):
- **Consulta:** `GET /{business_id}/owned_whatsapp_business_accounts?fields=id&limit=100` com o token do cliente.
- **Comprovado:** a WABA está na lista.
- **`META_WABA_DIVERGENTE`:** a lista está completa (sem `paging.next`) e não tem a WABA.
- **`META_RELACAO_NAO_CONFIRMADA`** (409, nunca aceito):
  - Meta recusa (4xx);
  - corpo com `error`, sem lista, com item sem id ou inválido;
  - lista paginada sem a WABA.
- **Falha do provedor (5xx):** `META_API_RECUSOU`, como nas outras etapas.
- **Ordem:** a posse é conferida **antes** da consulta de números. Não há presunção pela presença nas listas, pela ordem ou pelo primeiro elemento.

| Item | Fonte | Situação |
|---|---|---|
| `debug_token.granular_scopes` (`whatsapp_business_management`, `target_ids`) traz as WABAs que concederam acesso ao app | [Manage accounts](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-accounts) | **Comprovado**, como **autorização**, não como relação |
| `client_whatsapp_business_accounts` é consultado no portfólio **do parceiro** | mesma página | **Interpretação forte.** Não serve com o negócio do cliente |
| `owned_whatsapp_business_accounts`: "a collection of WhatsApp Business Accounts owned by a business" | [owned_whatsapp_business_accounts](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/business/owned_whatsapp_business_accounts) | **Comprovado:** é a relação de posse documentada |
| A mesma referência pede `business_management` e "ADMIN SYSTEM USER ACCESS TOKEN for the business" | mesma página | **Comprovado.** A compatibilidade com o token do Embedded Signup ("Business Integration System User", ver [access tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens)) **não** é documentada: **hipótese H-B1**. Se a Meta recusar, a conexão para em `META_RELACAO_NAO_CONFIRMADA` (decisão de contrato C-B1) |
| O nó da WABA (`GET /{waba_id}`) não tem campo com o negócio dono: só `ownership_type` (CLIENT_OWNED, ON_BEHALF_OF, SELF) | [WhatsApp Business Account API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/whatsapp-business-account-api) | **Comprovado:** não há caminho pela WABA |
| Sem `target_ids`, a permissão vale para todos os objetos | [debug_token](https://developers.facebook.com/docs/graph-api/reference/debug_token/) | **Comprovado** |
| O token da configuração em uso traz `business_management` com o negócio do cliente em `target_ids` (D1) | Vault: a configuração `2195372597859430` inclui `business_management` | **Hipótese**. Se falhar: `META_NEGOCIO_DIVERGENTE` |
| Modelo de contas de 2026: o `waba_id` do evento passa a ser uma Messaging Account criada por parceiro | [Account model evolution](https://developers.facebook.com/documentation/business-messaging/whatsapp/account-model-evolution/onboarding/) | **Comprovado** que muda. Se ela aparece em `owned_whatsapp_business_accounts` do cliente: **hipótese** (coberta por H-B1) |

**Decisão de contrato C-B1** (só se H-B1 falhar; nada muda sem nova autorização):
1. **(a) Bloquear (estado atual do código):** sem prova de posse não há conexão.
2. **(b) Mudar o contrato:** o negócio deixa de compor a identidade comprovada. Gravar `business_id` como "informado, não comprovado" exige migration ou novo campo e revisão de credencial e auditoria.
3. **(c) Prova pelo lado do parceiro:** `client_whatsapp_business_accounts` do portfólio do parceiro comprova o compartilhamento da WABA com o Kidmais, **não** a relação com o negócio do cliente. Exige uma variável nova e continua sem provar o negócio.

**Não fazer:** gravar como comprovado o negócio vindo do navegador.

### R2: evento da coexistência

| Item | Fonte | Situação |
|---|---|---|
| O fluxo do WhatsApp Business App termina com `type: "WA_EMBEDDED_SIGNUP"`, `event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"` | [Onboarding de usuários do Business App](https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users) | **Comprovado** |
| O exemplo desse evento traz em `data` **só** `waba_id` | mesma página | **Comprovado** (é o exemplo oficial) |
| `phone_number_id`, `waba_id` e `business_id` vêm sempre em `data` | [Implementação](https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation) (página geral) | **Comprovado para o fluxo geral.** Conflita com o exemplo da coexistência |
| A coexistência devolve os três ids | — | **Hipótese não comprovada** |
| Só Solution Partner ou Tech Provider usa o fluxo; Business App 2.24.17+; webhook do app preparado; 24 h para sincronizar contatos e histórico | página do Business App | **Comprovado** |
| Opções do `FB.login` (`extras.featureType` etc.) para abrir a coexistência | nenhuma página oficial consultada mostra isso | **Hipótese.** Conferir na configuração do Embedded Signup do painel Meta |

**Efeito no Kidmais (sem mudança nesta entrega):**
- **Nome do evento:** a tela só aceita o evento cujo nome é igual a `META_EMBEDDED_SIGNUP_EVENT_NAME`, e exige os três ids numéricos. Se o evento vier com outro nome, a tela continua aguardando até a tentativa expirar.
- **Ids faltando:** se o evento da coexistência vier só com `waba_id`, a tela mostra "formato diferente do configurado" e não conclui.
- **Antes da homologação:**
  1. a leitura M1 confere o nome do evento;
  2. se a Meta confirmar que o evento traz só `waba_id`, é preciso decidir outra entrega (D2): descobrir o número em `/{waba}/phone_numbers` (`is_on_biz_app`) e o negócio em `granular_scopes`, sem confiar no navegador.

## Evento do WhatsApp Business App só com `waba_id` (D2): 17/10/2026

**Problema:**
- **O exemplo oficial** do evento final do fluxo do WhatsApp Business App ([Onboard WhatsApp Business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/)) traz `type: "WA_EMBEDDED_SIGNUP"`, `event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"`, `version: 3` e, em `data`, **só** `waba_id`.
- **A página geral** de implementação diz que `phone_number_id`, `waba_id` e `business_id` vêm sempre.
- **O código até `6fc90b9`** exigia os três ids no navegador e no servidor: com o payload do exemplo oficial, a tela mostrava "formato diferente do configurado" e a tentativa ficava INICIADA até expirar.

**Correção:** a conclusão aceita o evento só com `waba_id`; `business_id` e `phone_number_id` passam a ser opcionais. O que faltar é resolvido e **comprovado** no servidor, sem confiar no navegador.

**Negócio** (`meta-client.ts`, `negocioDonoDaWaba`):
- **Candidatos:** os negócios autorizados neste token (`business_management.target_ids`).
- **Dono:** o candidato cuja aresta `owned_whatsapp_business_accounts` contém a WABA.
- **Aceite:** exatamente um dono. A posse de **todos** os candidatos é conferida, e a ordem e o primeiro elemento não decidem nada.
- **Recusas:**
  - sem candidatos: `META_NEGOCIO_DIVERGENTE`;
  - nenhum dono: `META_WABA_DIVERGENTE`;
  - mais de um dono, mais de 10 candidatos ou posse não confirmada em qualquer candidato: `META_RELACAO_NAO_CONFIRMADA`.

**Número** (`numeroDaConexao`):
- **Aceite:** o único número da WABA com `is_on_biz_app = true`.
- **Recusas:**
  - nenhum: `META_COEXISTENCIA_NAO_CONFIRMADA`;
  - mais de um, ou lista paginada: `META_NUMERO_AMBIGUO`.

**Quando o evento traz os ids:** continuam conferidos como antes (autorização, posse e número na WABA).

**Gravação:** o serviço grava na conexão, na tentativa, na credencial (AAD) e na auditoria os ids **devolvidos pela validação**. Esses ids estão sempre comprovados, nunca vêm do evento sem prova.

**Continua hipótese, só confirmável numa homologação autorizada:**
- os campos reais do evento (D2);
- se o token real lê a aresta de posse (H-B1);
- se `business_management.target_ids` vem explícito (D1).

## Alinhamento da configuração de coexistência (proposta, 17/10/2026)

**Como o código combina as opções:**
- `configuracao.ts` (`opcoesPublicas`) lê `META_EMBEDDED_SIGNUP_OPTIONS_JSON`.
- Exige `response_type: "code"` e `override_default_response_type: true`, e recusa chaves com nome sensível.
- Fixa `config_id` a partir de `META_EMBEDDED_SIGNUP_CONFIG_ID`.
- A tela passa o objeto **tal como está** ao `FB.login` e só aceita a mensagem cujo `event` seja **igual** a `META_EMBEDDED_SIGNUP_EVENT_NAME` (um único nome).

| Variável | Valor lido em 17/10 (M1) | Proposta | Base |
|---|---|---|---|
| `META_EMBEDDED_SIGNUP_EVENT_NAME` | `FINISH` | `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` | **Documentado:** é o evento do fluxo com número do WhatsApp Business App. Com `FINISH`, a tela ignora esse evento e a tentativa expira |
| `META_EMBEDDED_SIGNUP_OPTIONS_JSON` | `response_type=code`, `override_default_response_type=true`, `extras.feature=whatsapp_embedded_signup`, `extras.session_info_version=2`, `extras.setup.coexistence=true` | `{"response_type":"code","override_default_response_type":true,"extras":{"setup":{},"featureType":"whatsapp_business_app_onboarding","sessionInfoVersion":"3"}}`, mais `version` se o código de lançamento gerado pela Meta para a mesma configuração o incluir | **Documentado** ([changelog](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog), 29/05/2025): `coexistence` não é mais `featureType` válido; usar `whatsapp_business_app_onboarding` em `extras.featureType`. As chaves atuais `feature`, `session_info_version` e `setup.coexistence` não aparecem na documentação atual. **Hipótese H-V4:** se `extras.version` é necessário com a configuração v4 (o link hospedado da Meta mostra `version=v4`, `sessionInfoVersion=3` e `featureType=whatsapp_business_app_onboarding`) |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | `2195372597859430` | manter, **se** a Meta confirmar que é a configuração v4 com onboarding do WhatsApp Business App | O configurador mostra v4 e "Tipo de recurso: Nenhum"; o link com `featureType` pode ser de outra superfície |
| `META_GRAPH_API_VERSION` | `v25.0` | manter | Versão usada nos exemplos atuais |
| `META_EMBEDDED_SIGNUP_MESSAGE_ORIGINS` | `https://www.facebook.com,https://web.facebook.com` | manter | — |
| `META_OAUTH_REDIRECT_URI` | página do WhatsApp em staging | manter | Precisa constar na configuração de login da Meta |
| `META_WEBHOOK_VERIFY_TOKEN` | — (não usado pelo código publicado) | só junto do webhook da PR #168 | O código publicado não tem webhook da Meta |

**Webhook:**
- **Código publicado (`6fc90b9`):** não tem rota de webhook da Meta. **Não configurar callback** no painel antes de existir a rota.
- **PR #168** (aberta, base `0f621cd`): traz `GET/POST /api/integracoes/meta/webhook` (verificação por `META_WEBHOOK_VERIFY_TOKEN`; HMAC `X-Hub-Signature-256` com `META_APP_SECRET`). Trata só o campo `messages`; os demais campos respondem 200 e são ignorados. Inclui `subscribed_apps` na conclusão.
- **Requisito documentado do fluxo do WhatsApp Business App:** webhook capaz de receber eventos e assinatura de `history`, `smb_app_state_sync` e `smb_message_echoes`.
- **Fora do escopo "só conectar":** a sincronização de contatos e histórico em até 24 h não está implementada.

## Integração com a #168: inscrição do app na WABA e recuperação (17/10/2026)

**O que a integração mantém:**
- a B1 (posse comprovada);
- a D2 (negócio e número resolvidos e comprovados);
- os ids gravados vindos só da validação.

**O que a integração acrescenta:** a inscrição da #168, `POST /{waba_id}/subscribed_apps` com o token do cliente, como **última** etapa de `trocarCodigoEValidarAtivos`, só para a WABA já comprovada.

### R-168a: a inscrição é uma escrita externa

**Idempotência não significa ausência de efeito.** Depois de confirmada, a Meta passa a entregar ao webhook do app os eventos assinados dessa WABA, mesmo que a conexão local não seja gravada.

**O que mitiga esse efeito:**
- **O webhook da #168** só grava eventos de número com conexão CONFIGURADA da empresa piloto; os demais são confirmados sem gravar.
- **O conteúdo** não é guardado, mas o tráfego chega.

| Situação | Código | Tentativa | Auditoria `WHATSAPP_ONBOARDING_FALHOU` |
|---|---|---|---|
| Validação recusou antes da inscrição (posse, número, coexistência, provedor) | o da recusa | FALHOU | sem `inscricaoWebhook` (nenhuma escrita na Meta) |
| Inscrição recusada **explicitamente**: 2xx com objeto e `success === false`, ou 4xx com objeto JSON contendo `error` objeto | `META_WEBHOOK_NAO_INSCRITO` | FALHOU | sem `inscricaoWebhook` |
| Inscrição com resultado **desconhecido**: rede, prazo próprio de 10 s esgotado, 5xx, corpo ilegível, 2xx com `{}`, `null`, array ou `success` de outro tipo, 4xx sem `error` objeto | `META_WEBHOOK_INSCRICAO_INCERTA` | FALHOU, `waba_id` gravado | `inscricaoWebhook: "INCERTA"`, `wabaId` |
| Inscrição confirmada e gravação falhou (número em uso, corrida, cifra, banco) | o da gravação | FALHOU, `waba_id` gravado | `inscricaoWebhook: "CONFIRMADA"`, `wabaId` |
| Sucesso | — | CONCLUIDA | `WHATSAPP_CONEXAO_CONFIGURADA` com `inscricaoWebhook: "CONFIRMADA"` |

- **JSON legível não comprova o resultado:** só `success === true` (booleano) num 2xx confirma; só as duas formas acima comprovam recusa. Qualquer outra resposta preserva a possibilidade de a escrita ter ocorrido (correção F1 do parecer da `b99e205`).
- **Cifragem da credencial:** passou para dentro do bloco da gravação. Antes, uma falha ali deixava a tentativa em VALIDANDO, sem registro da inscrição.

**Recuperação (manual; nada é desinscrito automaticamente):**
1. **Localizar:** tentativa FALHOU com `waba_id` e auditoria com `inscricaoWebhook`.
2. **Antes de desinscrever:** conferir se há conexão CONFIGURADA (em qualquer empresa e **em qualquer ambiente que use o mesmo app**) com essa WABA. A inscrição é por app + WABA: desinscrever corta a entrega também para essas conexões.
3. **Sem conexão que dependa dela:** a desinscrição (`DELETE /{waba_id}/subscribed_apps`) exige um token com acesso à WABA. O Kidmais **não** guarda o token quando a gravação falha. O caminho é o cliente remover o app em Configurações do negócio (Meta Business Suite) ou refazer a conexão com sucesso.
4. **Registrar** a ação e o resultado na auditoria operacional.

### R-168d: envio de mensagens depois de conectar

**Na #168, a porta `enviar` do worker** (`enviarPelaEmpresa` em `lib/whatsapp/atendimento/meta.ts`) envia pela Cloud API sempre que a **empresa piloto** (`WHATSAPP_ATENDIMENTO_EMPRESA_ID`) tem conexão Meta CONFIGURADA. Sem conexão, envia pelo Gupshup.

**Não há chave própria:** conectar o número da empresa piloto **troca o canal de envio** automaticamente, desde que o atendimento esteja ligado (`WHATSAPP_ATENDIMENTO_ENABLED` e receptor).

**Escopo aceito por Felipe: só a conexão.**
- O envio pela Meta **não** está autorizado por essa escolha.
- **Antes de qualquer homologação:**
  - conferir que a empresa conectada **não** é a piloto;
  - ou que o atendimento está desligado;
  - ou decidir uma chave explícita de canal.
- **Esta integração não muda o envio da #168.**

## Chaves explícitas de canal e de recepção (17/10/2026)

**Objetivo:** separar **conexão** (Embedded Signup), **envio** e **recepção**. Conectar um número Meta, inclusive o da empresa piloto, não muda o canal de envio nem passa a gravar mensagens recebidas.

| Chave | Valor | Efeito |
|---|---|---|
| `WHATSAPP_ATENDIMENTO_CANAL_ENVIO` | ausente ou `gupshup` | Envio pelo Gupshup, como antes da Cloud API, **mesmo com conexão Meta da piloto**. A conexão Meta nem é lida |
| | `meta` | Envio só pela conexão Meta CONFIGURADA e válida da piloto. Sem conexão, token vencido, chave de outra versão ou credencial que não abre: `ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO` antes da rede (o worker marca FALHOU), **sem cair no Gupshup** |
| | qualquer outro (inclusive vazio, maiúsculas ou espaços) | Nada é enviado: `ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO` antes de qualquer leitura ou rede |
| `WHATSAPP_ATENDIMENTO_RECEPCAO_META` | `true` | Junto com a recepção do atendimento (`WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED=true`, receptor deste ambiente, piloto válida), o webhook da Meta processa mensagens e status: só da piloto, só contatos permitidos (staging) |
| | ausente ou qualquer outro valor | O webhook **continua conferindo a assinatura** (`X-Hub-Signature-256`; inválida = 401) e responde **200 sem processar**: mensagens e status são **descartados**. Nada é gravado, enfileirado nem enviado à IA, e as saídas não mudam de status |

### Consequência do 200 sem processamento

A Meta considera o evento entregue e **não o reenvia**. O Kidmais não guarda o conteúdo nem tem como recuperar esses eventos depois. Ligar a recepção mais tarde **não** traz mensagens nem status anteriores.

Isso vale também para os status de entrega de mensagens enviadas pela Meta. Com a recepção desligada, a saída fica no último estado conhecido (ex.: SUBMETIDA).

### Onde está

| Item | Arquivo |
|---|---|
| Leitura das chaves | `lib/whatsapp/atendimento/configuracao.ts` (`canalEnvio`, `recepcaoMetaAtiva`) |
| Envio | `lib/whatsapp/atendimento/meta.ts` (`enviarPelaEmpresa`) |
| Recepção | `lib/whatsapp/atendimento/meta.ts` (`persistenciaWebhookMeta`), usado por `app/api/integracoes/meta/webhook/route.ts` |
| Testes | `lib/whatsapp/atendimento/meta.test.ts`, `lib/whatsapp/atendimento/meta-recepcao.postgres.test.ts` (R8) |

**Variáveis reais:** nenhuma é criada por esta mudança. Ausentes, as chaves mantêm envio pelo Gupshup e recepção Meta desligada.
