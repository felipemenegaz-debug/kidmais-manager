# OTP Gupshup — integração da V1 em staging

Patch preparado na branch `staging`, sem commit, push, deploy, envio real,
alteração de variáveis remotas, acesso a produção ou alteração de banco/migrations.
O display name segue pendente na Meta, conforme validação operacional informada:
`submitted → enqueued → failed (131037)`.

## Inspeção anterior à implementação

O `IdentityOtpSender` é injetado em `criarIdentityService`. O emissor de ambiente
original escolhia `console`, `whatsapp_cloud` ou `disabled`.
`lib/identidade/configuracao-otp.ts` centraliza a autorização de staging;
`lib/identidade/delivery/otp.sender.ts` seleciona e valida o transporte.
O serviço cria o desafio antes do transporte e registra um envio apenas após
sucesso do emissor. O webhook Gupshup v2 é independente e não altera a identidade.

Regras preservadas, sem editar serviço/repositório:

- OTP de seis dígitos, gerado por `crypto.randomInt`, inclusive zeros iniciais.
- Validade do OTP de 10 minutos; até 5 tentativas inválidas; limite modelado de
  3 envios por desafio.
- Somente HMAC SHA-256 de cliente, canal, expiração e código é persistido, usando
  `IDENTIDADE_OTP_PEPPER` de pelo menos 16 caracteres; comparação em tempo constante.
- Confirmação atômica exige desafio pendente, não expirado e abaixo do limite;
  apaga o hash do OTP. Prova aleatória de 32 bytes, validade de 15 minutos,
  persistida como SHA-256 e consumida uma única vez na finalidade apropriada.
- Canal público exclusivamente WhatsApp e destino público mascarado.

Endpoints atuais (todos POST):

| Endpoint | Uso |
| --- | --- |
| `/api/identidade/consultar-cpf` | Cliente canônico e canais mascarados |
| `/api/identidade/iniciar-desafio` | Geração e submissão de OTP |
| `/api/identidade/confirmar-codigo` | Validação e emissão da prova |
| `/api/identidade/contexto` | Cadastro após apresentação da prova |
| `/api/identidade/solicitar-recuperacao` | Recuperação pendente |
| `/api/contratos/[contratoId]/identidade/iniciar` | OTP vinculado ao aceite |
| `/api/contratos/[contratoId]/aceite` | Consumo da prova no contrato |

O bloqueio do factory existente também se aplica a Gupshup, antes de gerar,
persistir ou enviar OTP. A rota contratual pode realizar leituras de acesso antes
desse factory. Seus fluxos válidos e contratos de sucesso permanecem iguais.
`FechamentoWizard` e `ContratoPublico` mantêm suas chamadas explícitas, sem retry
automático. A prova também protege o fechamento e os endpoints de contexto,
resumo, PDF e comprovante do contrato.

Correção P2 da revisão: a rota `/api/contratos/[contratoId]/identidade/iniciar`
trata falhas de `request.json()` antes de chamar o serviço. Responde 400 com
`JSON_INVALIDO` e mensagem fixa, sem registrar corpo ou exceção. A regressão em
`app/api/contratos/identidade-iniciar.test.ts` executa a rota e o helper de resposta
com serviços isolados: exige zero logs/chamadas ao serviço ou provider para JSON
inválido e falhas de leitura, preservando 400 de schema e 201 do fluxo válido.

## Configuração exclusiva do servidor

Não usar prefixo `NEXT_PUBLIC_`, versionar valores reais ou copiar segredos para logs.

| Variável | Valor/contrato |
| --- | --- |
| `IDENTIDADE_OTP_PROVIDER` | `gupshup` |
| `KIDMAIS_DEPLOY_ENV` | `staging`; este patch recusa Gupshup em outros ambientes |
| `NODE_ENV` | `production` no runtime compilado de staging |
| `GUPSHUP_OTP_ENABLED` | **`false` enquanto aguarda Meta**; ausência também bloqueia; só aceita `true`/`false` exatos |
| `KIDMAIS_STAGING_OTP_DISABLED` | Manter `SIM` durante a espera; trava legada prevalece inclusive sobre `GUPSHUP_OTP_ENABLED=true` |
| `GUPSHUP_API_KEY` | API key `sk_...`, injetada como segredo |
| `GUPSHUP_SOURCE` | Número remetente E.164 com DDI; transporte usa somente dígitos |
| `GUPSHUP_APP_NAME` | `KidmaisManager`, obrigatório e compatível com o parser webhook v2 atual |
| `GUPSHUP_OTP_TEMPLATE_ID` | ID do template de autenticação confirmado |
| `GUPSHUP_DEFAULT_COUNTRY_CODE` | Opcional, padrão `55`, para destinatário sem DDI |
| `GUPSHUP_TIMEOUT_MS` | Opcional, padrão `10000`, entre `1000` e `30000` ms |
| `IDENTIDADE_OTP_PEPPER` | Segredo atual do HMAC, pelo menos 16 caracteres; preservar valor |
| `GUPSHUP_WEBHOOK_SECRET` | Segredo atual separado do webhook, sem mudança neste patch |

Configuração Gupshup é validada ao construir o provider, ao selecionar o emissor e
no health, inclusive quando o transporte está bloqueado. Não há consulta externa
para validar configuração. O health verifica configuração estrutural, não validade
remota da API key, existência do template ou aprovação da Meta. A validação do
pepper permanece no serviço de identidade. Não foi adicionado hook global de startup.

O modo legado `IDENTIDADE_OTP_PROVIDER=disabled` continua disponível com as mesmas
travas. Para exibir Gupshup como configurado no health, as credenciais completas
precisam estar instaladas e o provider selecionado, mantendo o envio bloqueado.

## Transporte

Novo módulo `lib/identidade/delivery/gupshup.sender.ts`: um único POST para
`https://api.gupshup.io/wa/api/v1/template/msg`, header `apikey`, conteúdo
`application/x-www-form-urlencoded` e campos `channel=whatsapp`, `source`,
`destination`, `src.name`, `template={"id":"…","params":["OTP","OTP"]}`.
O destinatário é normalizado para E.164 sem `+`; entradas inválidas são recusadas
antes de rede. Redirects não são seguidos e não há retry automático.

Somente HTTP **202**, `status: submitted` e `messageId` válido constituem sucesso
do transporte, conforme contrato confirmado. O timeout cobre conexão e leitura
da resposta. Corpo inválido ou excessivo é recusado. Erros são classificados como
autenticação, timeout, indisponibilidade, resposta inválida ou rejeição, além de
configuração/canal/destino inválidos. Exceções externas e payloads não são propagados.

O recibo `{provider, status, messageId}` é somente interno e transitório. O serviço
atual ignora o valor de retorno; não existe correlação persistida entre desafio e
mensagem. Não foi acrescentada escrita de auditoria ou migration para isso.
O webhook mantém seus próprios eventos sanitizados e hash do messageId.

Nenhum OTP, telefone completo, API key, segredo webhook ou corpo bruto é registrado
pelo provider. O antigo modo `console` agora é uma simulação silenciosa de
desenvolvimento; testes que precisam conhecer o OTP usam o emissor injetado.

O contrato de transporte segue os dados confirmados e a
[referência de template de autenticação](https://docs.gupshup.io/reference/sending-authentication-template).
Submissão e entrega são etapas distintas, como explica a
[documentação de mensagens de template](https://docs.gupshup.io/docs/template-messages).

## Health durante a espera

Com banco/Festa prontos e configuração Gupshup válida, o GET `/api/health` retorna
HTTP **200**, `Cache-Control: no-store`, mesmo com o envio bloqueado:

```json
{
  "ok": true,
  "status": "degraded",
  "components": { "database": "ready", "festa": "ready", "otp": "unavailable" },
  "otp": {
    "provider": "gupshup",
    "configured": true,
    "enabled": false,
    "reason": "staging_disabled"
  }
}
```

O motivo descreve a trava local; não consulta nem infere o estado Meta. Após
liberação explícita, status/OTP passam a `ready`, `enabled: true` e o motivo some.
Isso ainda não prova entrega. Configuração inválida, banco ou Festa falhos continuam
produzindo 503. A rota existente usa `lib/saude/status.ts` e não precisou ser editada.

O avaliador de smoke em `scripts/production/smoke-test.mjs` recebeu somente a
compatibilidade de staging com os novos metadados; a política de production foi
preservada e testada com dados sintéticos. Nenhum smoke remoto foi executado.
`check-env.mjs` isoladamente não valida as variáveis Gupshup; provider/health fazem
essa validação.

## Limites e ativação posterior

- A aprovação do display name pela Meta ainda é necessária para o envio chegar
  ao destinatário. Não é necessário aguardar para testar o código com mocks.
- Depois da aprovação e revisão/deploy deste patch em staging, liberar
  `GUPSHUP_OTP_ENABLED=true` e remover `KIDMAIS_STAGING_OTP_DISABLED=SIM` somente
  para teste controlado. Confirmar recebimento real e todo o fluxo OTP/aceite antes
  de declarar a integração homologada. Não modificar production.
- Timeout é ambíguo: a submissão pode ter ocorrido remotamente. Sem retry cego.
- Já existia intervalo entre submissão e registro no banco; falha no registro
  pode ocorrer depois do envio. Sem transação distribuída ou deduplicação nova.
- O limite de 3 envios é por desafio. O fluxo atual não implementa rate limit
  global/cooldown nem reenvio no mesmo desafio; iniciar novamente cria outro.
- Sem persistência do messageId, eventos assíncronos não atualizam desafio OTP.
- O cadastro legado remove `+` e armazena somente dígitos; números de 10/11 dígitos
  sem marcador internacional usam o país padrão. DDI `1` de número NANP completo
  é preservado quando o país padrão é `1`. Uma base com países misturados pode
  continuar ambígua sem informação de país; o patch não altera cadastro/banco.
- Este patch seleciona Gupshup apenas em staging. Uma futura promoção de provider
  para production exige revisão específica; não foi autorizada nesta tarefa.

## Validação local

Arquivos previstos após inspeção e efetivamente alterados/criados:

- `lib/identidade/configuracao-otp.ts` e `.test.ts`: seleção e travas de staging.
- `lib/identidade/delivery/gupshup.sender.ts` e `.test.ts`: novo transporte.
- `lib/identidade/delivery/otp.sender.ts` e `.test.ts`: integração ao seletor e
  remoção do log de OTP no modo de desenvolvimento.
- `lib/identidade/services/models.ts`: recibo interno opcional.
- `lib/saude/status.ts` e `.test.ts`: apresentação segura do provider no health.
- `scripts/otp-staging.test.cjs`: regressão do bloqueio anterior à geração.
- `scripts/production/smoke-test.mjs` e `production.test.mjs`: reconhecimento da
  degradação esperada de staging; testes locais, sem execução operacional.
- `docs/GUPSHUP_OTP_STAGING.md`: arquitetura, configuração, limites e evidências.

Resultados em 19/09/2026:

| Verificação | Resultado |
| --- | --- |
| Provider Gupshup com fetch/streams mockados | 25/25 passaram |
| OTP, configuração, health, factory e smoke sintético | 82/82 passaram na execução final; inclui os 25 do provider |
| Suíte V1 completa, antes da última regressão de DDI | 396/396 passaram; normalização alterada depois foi retestada nos 82 focados |
| ESLint de todo o repositório | Passou novamente após a correção final |
| TypeScript `--noEmit` | Passou novamente após a correção final |
| `npm.cmd run build` | Passou após a correção final |
| `git diff --check` | Passou |

Cobertura do provider: formulário e `202 submitted`, 401/403, timeout na conexão
e no corpo, 429/5xx, erro de rede, rejeição HTTP, ausência/status/messageId/JSON
inválidos, resposta excessiva/UTF-8 inválido, cancelamento de streams, logs e erros
sanitizados, telefone/canal/configuração inválidos, ausência de retry, preservação
de DDI e seleção com bloqueio do ambiente. O health também é testado com falhas de
banco/Festa/configuração substituídas por mocks.

O build inicial no sandbox falhou exclusivamente ao buscar fontes Geist/Geist
Mono. Após autorização para rede, o build passou usando
`DATABASE_URL=postgresql://invalid:invalid@127.0.0.1:1/nao_usar` e telemetria
desabilitada. Nenhum banco real foi utilizado. Logs locais ignorados pelo Git:
`.tmp-gupshup-module.log`, `.tmp-gupshup-static.log` e `.tmp-gupshup-build.log`.

O runtime local disponível é Node **24.20.0**; o projeto fixa **22.23.2**. Esta
execução não comprova validação no Node 22 do deploy. Testes de banco, fluxo real
com destinatário e deploy não foram executados. Branch permaneceu `staging`.
