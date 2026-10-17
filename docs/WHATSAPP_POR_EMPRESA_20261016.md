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
