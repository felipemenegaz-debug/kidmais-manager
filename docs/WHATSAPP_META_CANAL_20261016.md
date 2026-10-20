# WhatsApp pela Meta (Cloud API) como canal do atendimento, 16/10/2026

Decisão do Felipe em 16/10: **um WhatsApp só**. O número que a empresa conecta em **Configurações > WhatsApp** (Embedded Signup, migrations 018/083) passa a ser o número do **Atendimento WhatsApp**: recebe as mensagens dos clientes e envia as respostas. O Gupshup fica só como transição (OTP e empresas sem conexão Meta) até a migração do número comercial; a remoção dele é uma PR própria.

**Sem migration.** Nada nesta entrega liga recepção ou envio sozinho: valem as mesmas chaves do canal de hoje.

## O que muda

| Parte | Antes | Agora |
|---|---|---|
| Recepção | só `POST /api/integracoes/gupshup/webhook` | também `GET`/`POST /api/integracoes/meta/webhook` |
| Origem do evento | segredo no cabeçalho (Gupshup) | `X-Hub-Signature-256`: HMAC-SHA256 do corpo **bruto** com `META_APP_SECRET` |
| De qual empresa é | `WHATSAPP_ATENDIMENTO_EMPRESA_ID` | a dona da conexão **CONFIGURADA** do número (`phone_number_id` + `waba_id` do evento, mesmo ambiente) |
| Envio | Gupshup (`GUPSHUP_SOURCE`/`API_KEY`) | Cloud API `POST /{phone-number-id}/messages`, com a credencial **cifrada da conexão da empresa**; sem conexão Meta, o Gupshup de antes |
| Conexão (Embedded Signup) | só valida e guarda a credencial | também inscreve o app nos webhooks da conta WhatsApp da empresa (`POST /{waba-id}/subscribed_apps`); sem a confirmação da Meta, a conexão é recusada |

Arquivos:

- `lib/integracoes/meta/webhook.ts`: verificação (GET), assinatura, leitura limitada (256 KiB, 3 s) e parser dos eventos `messages` (mensagens e status). Não acessa banco nem rede.
- `app/api/integracoes/meta/webhook/route.ts`: rota fina, como a do Gupshup.
- `lib/whatsapp/atendimento/meta.ts`: número → empresa, credencial de envio, corpo e envio da Cloud API, e a porta `enviarPelaEmpresa` do worker.
- `lib/whatsapp/atendimento/service.ts`: `receberEntrada` aceita a empresa do número; `registrarStatus` serve aos dois provedores.
- `lib/whatsapp/meta-client.ts`: inscrição do app na WABA no fim da validação do Embedded Signup.

## Regras de segurança

- **Assinatura antes de tudo.** Sem `X-Hub-Signature-256` válida: 401 e nada é lido além do corpo. Sem `META_APP_SECRET` (16+ caracteres) ou fora de staging/produção: 503. Fora de https: 403 (atrás do Render, vale `x-forwarded-proto` só com `RENDER=true`).
- **Verificação do painel da Meta (GET).** Só devolve o `hub.challenge` com `hub.mode=subscribe` e o token exato de `META_WEBHOOK_VERIFY_TOKEN` (16+ caracteres; comparação em tempo constante). Nada é gravado.
- **Retry da Meta.** Ela repete por até 7 dias o que não recebe 200. Só falha que um retry corrige (banco) devolve 503. Item malformado, número sem conexão, número de outra empresa e contato fora da lista recebem 200 sem gravar.
- **Isolamento.** O evento só grava na empresa dona do número conectado. Enquanto o atendimento atende uma empresa só (a piloto, que a tela e o worker leem de `WHATSAPP_ATENDIMENTO_EMPRESA_ID`), evento do número de **outra** empresa é confirmado sem gravar. Conexão DESCONECTADA ou `waba_id` divergente: nada gravado.
- **Credencial presa à empresa.** O token é decifrado com a identidade completa da cifragem (ambiente, app, negócio, WABA, número e empresa). Credencial de outra empresa não abre. Chave de outra versão ou token vencido: nada sai, a mensagem termina FALHOU e vai para a equipe.
- **Mesmas chaves do canal.** `WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED`, `WHATSAPP_ATENDIMENTO_ENABLED`, `WHATSAPP_ATENDIMENTO_RECEPTOR` e, fora de produção, `WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS` valem igual para a Meta. Em staging, sem a lista, nada é gravado nem enviado (D2/D3).
- **Log.** Depois da resposta, só a contagem `{entradas, status}`: nenhum número, texto, nome ou id.
- **Envio.** `redirect: 'error'`, timeout de 10 s, resposta limitada a 8 KiB. 400/401/403/404/413/415/422/429 = recusa (FALHOU); qualquer outra resposta = INCERTO (nunca reenviado), como no Gupshup.

## Variáveis (staging; nada configurado por esta entrega)

| Variável | Para quê | Já existe? |
|---|---|---|
| `META_APP_SECRET` | assinatura do webhook (e o Embedded Signup) | sim, se o Embedded Signup já está configurado |
| `META_WEBHOOK_VERIFY_TOKEN` | **nova**: token da verificação no painel da Meta (gerar um valor aleatório, 32+ caracteres) | não |
| `META_GRAPH_API_VERSION` | versão da Graph API do envio (a mesma do Embedded Signup, ex.: `v23.0`) | sim, se o Embedded Signup já está configurado |
| `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` / `_KEY_VERSION` | decifrar a credencial da conexão | sim, se o Embedded Signup já está configurado |
| `WHATSAPP_ATENDIMENTO_*` | as mesmas chaves do canal de hoje | — |

O `WHATSAPP_ATENDIMENTO_RECEPTOR` existia por causa do Gupshup (um app, várias assinaturas, staging e produção recebendo cópias). Com a Meta cada ambiente tem o próprio app e a própria URL de webhook; a variável continua valendo nesta entrega (falha fechada) e pode sair numa limpeza posterior.

## Ativação em staging (cada passo com autorização própria)

1. Merge e deploy desta PR em staging (a verificação GET responde 503 até `META_WEBHOOK_VERIFY_TOKEN` existir; o POST exige `META_APP_SECRET` e não grava nada com a recepção desligada; a Meta só chama a URL depois do passo 3).
2. Felipe cria `META_WEBHOOK_VERIFY_TOKEN` no Render (Save and deploy).
3. No painel da Meta (app *Kidmais Manager Staging*): WhatsApp > Configuração > Webhook: URL `https://kidmais-manager-staging.onrender.com/api/integracoes/meta/webhook`, token = o do passo 2; assinar o campo **messages**.
4. Conectar o número da empresa piloto em Configurações > WhatsApp (Gestão da empresa). A conexão já inscreve o app na WABA.
5. Recepção e envio com as chaves de sempre (`RECEPTOR=staging`, lista de contatos com o número de teste do Felipe, `RECEIVE_ENABLED`, `ENABLED`, `INTELIGENCIA_ENABLED`), na ordem do roteiro de homologação.

## Limites conhecidos

- **Coexistência obrigatória.** A conexão exige um número que esteja no **WhatsApp Business App** (`is_on_biz_app`, CHECK `coexistencia_confirmada` da 018). O número de teste da Meta (+1 555…) não entra pelo Embedded Signup. Para o teste real é preciso um número de celular com o app WhatsApp Business. Relaxar isso em staging é decisão própria (e mexe na 018).
- **Uma empresa por vez** no atendimento (a piloto). O roteamento por número já existe; abrir para várias empresas exige trocar `empresaPiloto()` na tela e no worker (PR própria).
- **Deduplicação de evento excluído.** A 082 só aceita o rótulo `GUPSHUP` em `whatsapp_atendimento_eventos_excluidos`; as entradas da Meta usam o mesmo rótulo (o hash é do id do evento e o `wamid.…` nunca coincide com o id do Gupshup). Funciona sem migration; renomear o rótulo fica para a limpeza do Gupshup.
- **Um provedor de envio por empresa.** Com a conexão Meta, todo envio da empresa sai pela Meta, inclusive a resposta a uma conversa que chegou pelo Gupshup (o cliente receberia de outro número). Ao conectar o número na Meta, desligar a assinatura de mensagens do Gupshup para essa empresa.
- **Só mensagens de sessão** (dentro da janela de 24 h), como hoje. Template fica de fora.

## Testes

- `lib/integracoes/meta/webhook.test.ts` (5): GET, assinatura, guardas do POST, persistência e log, parser.
- `lib/whatsapp/atendimento/meta.test.ts` (6): corpo da Cloud API, envio e classificação das respostas, credencial, porta do worker, entrada.
- `lib/whatsapp/meta-client.test.ts` (+1): inscrição na WABA e recusa sem confirmação.
- `lib/whatsapp/atendimento/meta-recepcao.postgres.test.ts` (modelo 083): webhook assinado → empresa dona do número → banco (R1–R7). Controle negativo feito à mão: sem a checagem do `waba_id`, a suíte falha em "R2–R4".

## Rollback

Reverter o commit (sem migration, sem dado novo além das conversas do teste). Sem `META_WEBHOOK_VERIFY_TOKEN` a rota fica em 503; desligar `WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED` para de gravar. O envio volta ao Gupshup sozinho quando a empresa não tem conexão Meta (desconectar em Configurações > WhatsApp).
