# Webhook Gupshup — staging

## Escopo

Rota preparada: `POST /api/integracoes/gupshup/webhook`.
URL prevista após implantação autorizada:
`https://kidmais-manager-staging.onrender.com/api/integracoes/gupshup/webhook`.

Esta etapa somente recebe, valida e confirma eventos. Não configura callback, não envia
mensagens, não ativa Gupshup/OTP, não importa repositórios de banco e não grava dados.
Não exige migration. Nenhuma configuração do Render foi feita nesta tarefa.

## Configuração necessária posteriormente

- `GUPSHUP_WEBHOOK_SECRET`: segredo exclusivo do webhook, aleatório, pelo menos 32 caracteres
  ASCII sem espaços/vírgulas (máximo 1024). Recomenda-se 32 bytes aleatórios em hexadecimal.
  Não reutilizar credenciais de banco, API, OTP ou sessão.
- `KIDMAIS_DEPLOY_ENV=staging`: obrigatório; em production ou ambiente desconhecido retorna 503.
- No Render, `RENDER=true`: exige `x-forwarded-proto` exatamente `https`.
  Fora do Render, só aceita URL HTTPS direta, ignorando forwarded headers.
- O remetente deverá enviar `X-Kidmais-Webhook-Secret` com o mesmo segredo.
  Confirmar o suporte a esse header no callback Gupshup antes de configurá-lo.
  Nunca enviar o segredo na URL/query string ou registrá-lo em logs.

O header é comparado com SHA-256 + `timingSafeEqual`, sem comparação direta do segredo.
Sem configuração válida o endpoint permanece fechado. Não usa cookie, sessão ou Origin
administrativo: a autenticação deste callback servidor-a-servidor é o segredo dedicado.

## Payload e respostas

Formato oficial v2: envelope `app`, `timestamp`, `version`, `type`, `payload`.
`app` deve ser exatamente `KidmaisManager`, `version` o número 2 e timestamp um inteiro
não negativo. Eventos conhecidos exigem `payload.id` e `payload.type` não vazios.

- `type=message-event`: `payload.type=enqueued|failed|sent|delivered|read`.
- `type=message`: inbound, qualquer subtipo de conteúdo; o conteúdo é descartado.
- Tipos/status desconhecidos em envelope válido: 204, metadado `ignored`, sem eco do tipo arbitrário.
- JSON: `application/json`.
- Form: `application/x-www-form-urlencoded`, com campos do envelope e `payload` como JSON,
  ou um único campo `message` contendo o envelope JSON completo. Não aceita campos duplicados.
  Essa é compatibilidade do receptor; não pressupõe que o painel Gupshup envie form.
- Multipart e conteúdo comprimido não são suportados nesta etapa.

| HTTP | Significado |
| --- | --- |
| 204 vazio | Autenticado, envelope válido; recebido ou ignorado |
| 400 | JSON/form/envelope inválido, app ou versão incorreta |
| 401 | Segredo ausente/incorreto/múltiplo |
| 403 | Transporte HTTPS não comprovado |
| 405 | Método diferente de POST (Next.js pode responder OPTIONS automaticamente) |
| 408 | Leitura do corpo excedeu 3 segundos |
| 413 | Corpo maior que 64 KiB ou Content-Length inválido |
| 415 | Content-Type/Content-Encoding não suportado |
| 503 | Ambiente desabilitado ou segredo ausente/fraco |

O limite conta os bytes efetivamente lidos, inclusive sem Content-Length ou com tamanho
declarado incorreto. A autenticação precede a leitura. Não há processamento de negócio.
O log é agendado com `after()` do Next.js, após a resposta, recebendo apenas uma projeção
sanitizada. Não há fila durável: 204 significa recepção/validação, não persistência.

## Logs e limites

Campos permitidos: `eventType`, `status`, `timestamp`, hash SHA-256 do ID truncado em 16
hexadecimais e, quando presente e válido, `destinationMasked` contendo apenas os dois
últimos dígitos. Inbound não registra source/sender. Não registra corpo, nomes, texto,
mídia, URL, telefone completo, motivo de falha ou headers. Erros não imprimem payloads.

Retries podem repetir logs, sem efeitos de negócio. Não há ordenação/reconciliação de status.
O rate limit existente usa banco; não foi reutilizado nem criado limitador distribuído.
Proteções locais: autenticação antes da leitura, 64 KiB e timeout de 3 segundos. Proteção
volumétrica de infraestrutura e entrega real pelo fornecedor ainda não foram homologadas.

## Exemplos sanitizados — não executados

Bash, com `GUPSHUP_WEBHOOK_SECRET` já carregado de forma segura no processo; não usar `set -x`.
O segredo é enviado por stdin ao curl, evitando incluí-lo literalmente nos argumentos:

```bash
printf 'X-Kidmais-Webhook-Secret: %s\n' "$GUPSHUP_WEBHOOK_SECRET" | curl --silent --show-error --include \
  --request POST 'https://kidmais-manager-staging.onrender.com/api/integracoes/gupshup/webhook' \
  --header @- --header 'Content-Type: application/json' \
  --data '{"app":"KidmaisManager","timestamp":1789550000000,"version":2,"type":"message-event","payload":{"id":"synthetic-example-id","type":"delivered","destination":"5511999990000","payload":{}}}'
```

```bash
printf 'X-Kidmais-Webhook-Secret: %s\n' "$GUPSHUP_WEBHOOK_SECRET" | curl --silent --show-error --include \
  --request POST 'https://kidmais-manager-staging.onrender.com/api/integracoes/gupshup/webhook' \
  --header @- \
  --data-urlencode 'app=KidmaisManager' --data-urlencode 'version=2' \
  --data-urlencode 'timestamp=1789550000000' --data-urlencode 'type=message' \
  --data-urlencode 'payload={"id":"synthetic-inbound-id","type":"text","source":"5511999990000","payload":{"text":"Teste sintetico"}}'
```

Esperado: 204 sem corpo. Não executar estes exemplos antes da autorização para implantação
e configuração do segredo. Sem segredo configurado, esperado 503.

## Testes locais

`node --experimental-strip-types --test lib/integracoes/gupshup/webhook.test.ts`

Cobertura: segredo, fail-closed, cinco status, inbound, desconhecidos, validação, sanitização,
form, limites, timeout, HTTPS/proxy, retries e ACK rápido. A suíte está incluída automaticamente
em `npm run check:v1:static`. Teste de tempo local não garante latência da rede/Render.

### Resultado desta implementação (16/09/2026)

- Testes do webhook: 22/22 PASS.
- Production readiness: 30/30 PASS.
- `check:v1:static`: 347/347 PASS, lint, TypeScript e build aprovados.
- Smoke HTTP do build Next.js em `127.0.0.1:3137`: 9 verificações PASS
  (cinco status, segredo inválido, JSON inválido, GET recusado e inbound via form).
  ACKs locais dos cinco status: 48, 4, 8, 16 e 17 ms. Proxy HTTPS foi simulado
  exclusivamente no servidor loopback. Logs observados continham somente a projeção sanitizada.
- Servidor local encerrado após o smoke. Build/smoke usaram DATABASE_URL inválida de loopback,
  sem carregar banco real. Nenhum acesso ao `kidmais_manager`, Render ou produção.
- Sem alteração de OTP, banco, migrations, secrets reais, callback, commit, push ou deploy.

## Fontes de formato e ACK

- [Gupshup — V2 message events](https://docs.gupshup.io/docs/message-events)
- [Gupshup — inbound text](https://docs.gupshup.io/docs/text)
- [Gupshup — webhook key points](https://docs.gupshup.io/docs/what-is-a-webhook)

A documentação recomenda ACK 2xx vazio e processamento posterior; a implementação usa 204
e apenas log sanitizado posterior. Callback, header no painel e entrega fim a fim permanecem
pendentes de configuração autorizada.
