# E8 — Cobrança da assinatura pelo Asaas (SANDBOX) (07/10/2026)

Oitava entrega do plano de venda por assinatura ([PROPOSTA_VENDA_ASSINATURA_20261006.md](PROPOSTA_VENDA_ASSINATURA_20261006.md),
§5 e §8 E8). Depende da 067 (#110), da 068 (#116) e da E4 (paywall). **Sem migration nova.** **Somente sandbox**:
nenhum pagamento real, nenhuma chave de produção aceita pelo código. Nenhuma chamada ao Asaas foi feita durante o
desenvolvimento: todos os testes usam provedor falso.

## Configuração (somente nomes; valores no ambiente do serviço, nunca no repositório)

| Variável | Regra |
|---|---|
| `ASAAS_AMBIENTE` | Só `sandbox` é aceito. Ausente ou qualquer outro valor (inclusive `producao`) → cobrança **desligada** com motivo explícito (`AMBIENTE_NAO_SUPORTADO`) |
| `ASAAS_API_KEY` | Chave da conta sandbox; precisa começar com `$aact_hmlg_`. Nunca é registrada em log, auditoria ou mensagem de erro |
| `ASAAS_WEBHOOK_TOKEN` | 32–255 caracteres visíveis; conferido no cabeçalho `asaas-access-token` em tempo constante |
| `ASSINATURA_PRECO_MENSAL_CENTAVOS` / `ASSINATURA_PRECO_ANUAL_CENTAVOS` | Já existentes (068). Sem preço, aquele ciclo não aparece nem é aceito |
| `ADMIN_AUTH_SECRET` | Já existente; usado pelo limite por IP do webhook (`limites_autenticacao`) |

URL base fixa no código: `https://api-sandbox.asaas.com/v3`. Cabeçalhos: `access_token`, `Content-Type: application/json`,
`User-Agent: kidmais-manager`. Tempo-limite de 10 s por chamada. Endpoints usados (fontes oficiais citadas em
`lib/assinatura/asaas.ts`): `GET/POST /customers`, `GET/POST /subscriptions`, `GET/DELETE /subscriptions/{id}`,
`GET /subscriptions/{id}/payments`.

## Fluxos

| Fluxo | Onde | O que faz | O que NÃO faz |
|---|---|---|---|
| Assinar (Gestão) | `POST /api/admin/assinatura/checkout` `{ ciclo }` → `lib/assinatura/cobranca.ts` | Busca/cria o cliente no Asaas pela referência externa (= id da empresa), com `notificationDisabled: true` e **sem e-mail/telefone**; cria a assinatura (`billingType: UNDEFINED`, a fatura hospedada oferece Pix, boleto e cartão; valor de `precoDoCiclo`; `MONTHLY`/`YEARLY`; 1º vencimento hoje em Brasília); grava `provedor`, `provedor_cliente_id`, `provedor_assinatura_id`; devolve o `invoiceUrl` da cobrança em aberto | Não muda situação nem acesso. Idempotente: com assinatura ativa no provedor devolve a cobrança em aberto dela ("Continuar pagamento") |
| Voltar do pagamento | `/admin/assinatura/retorno` | "Processando: o acesso é liberado quando o pagamento for confirmado"; consulta `GET /api/admin/assinatura` a cada 5 s por ~3 min | Não envia nada ao servidor; não concede nada |
| Webhook | `POST /api/integracoes/asaas/webhook` (público, fora de `/api/admin`) | Ver abaixo | — |
| Cancelar (Gestão) | `POST /api/admin/assinatura/cancelamento` `{ confirmar: true, motivo? }` | Exige senha confirmada há ≤ 5 min (mesma regra do painel do desenvolvedor); `DELETE` da assinatura no provedor (pendentes saem, pagas ficam); reconsulta → `CANCELADA_FIM_PERIODO` com `cancelada_em`; acesso completo até `periodo_atual_fim` | Não apaga dados |
| Sincronizar (desenvolvedor) | Ficha da empresa → "Sincronizar com o provedor" (`POST /api/desenvolvedor/empresas/{id}/cobranca`) | Concessão de desenvolvedor travada, senha recente, auditoria `COBRANCA_SINCRONIZADA` | Não concede papel, vínculo nem acesso de plataforma |
| Equipe | Tela Assinatura | Só a situação | Não vê botões de contratar/cancelar |

As rotas `/api/admin/assinatura/*` já são sempre permitidas pelo paywall (E4); a página `/admin/assinatura/retorno` foi
incluída nas telas abertas quando o acesso está bloqueado.

### Webhook

1. Cobrança desligada → **503** sem gravar nada.
2. Limite por IP (300/min, namespace próprio em `limites_autenticacao`) → **429**.
3. Token ausente ou errado → **401**. Só a recusa é auditada (`COBRANCA_WEBHOOK_RECUSADO`, motivo e IP; nunca corpo
   nem token), e essa auditoria é limitada a 10 por IP a cada 10 min.
4. Corpo > 64 KB → **413**; JSON sem `id`/`event` válidos → **400**.
5. `INSERT INTO cobranca_eventos … ON CONFLICT (provedor, evento_id) DO NOTHING` com **só identificadores** (evento,
   tipo, `dateCreated`, `payment.id`, `payment.subscription`/`subscription.id`, `checkout.id`, referência externa
   quando é um UUID). Responde **200** na hora.
6. Depois da resposta (`after` do Next 16, `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`):
   resolve a empresa pelo id da assinatura **gravado no nosso banco** (ou pela referência externa, só para escolher
   quem reconsultar), trava a linha (`FOR UPDATE`), **reconsulta o provedor** e aplica `estadoDoProvedor`. Evento
   `PROCESSADO`, `IGNORADO` (tipo não tratado, empresa não encontrada, assinatura de outra referência) ou `FALHOU`
   (provedor fora; `tentativas` e `ultimo_erro` sem dados pessoais).

O conteúdo do evento nunca vira estado: um "pago" que chega depois de um "cancelado" não reverte nada, porque vale o
que o provedor diz no momento da reconsulta. Entrega repetida não grava segundo registro nem segundo efeito.

### Mapeamento (`lib/assinatura/provedor-estado.ts`, função pura)

- Pago = `CONFIRMED` | `RECEIVED` | `RECEIVED_IN_CASH`. Estorno, chargeback, pendente → não pago.
- `periodo_atual_fim` = vencimento da última cobrança paga + 1 mês/1 ano, à meia-noite de Brasília; nunca encolhe por
  aqui (revogar período já liberado depois de estorno é decisão manual da plataforma — lacuna conhecida).
- `OVERDUE` vencida, sem paga posterior, com o período pago terminado → `EM_ATRASO` desde o vencimento mais antigo.
- Assinatura `INACTIVE`/`EXPIRED`/removida (404) → `CANCELADA_FIM_PERIODO` no período pago, senão `ENCERRADA`
  (`encerrada_em` = fim do período quando vem de cancelada). Quem nunca pagou e está em `TESTE` continua em `TESTE`.
- Só transições da tabela da 068; `TESTE` com pagamento e cobrança seguinte já vencida passa a `ATIVA` (período vencido,
  regularização do E4) e a `EM_ATRASO` na sincronização seguinte. Nova assinatura de quem cancelou/encerrou só reativa
  com cobrança paga.

## Configuração do webhook no sandbox (manual, por Felipe — não executado)

1. Criar conta sandbox em `https://sandbox.asaas.com` com dados de teste da Kidmais (não usar contato de terceiros: o
   sandbox pode enviar e-mail/SMS reais).
2. Gerar a chave de API (`$aact_hmlg_…`) e um token aleatório de 32–255 caracteres para o webhook.
3. Integrações → Webhooks → novo webhook: URL `https://<serviço de staging>/api/integracoes/asaas/webhook`, token de
   autenticação = `ASAAS_WEBHOOK_TOKEN`, eventos de cobrança e de assinatura, envio sequencial (opcional: a
   implementação não depende da ordem).
4. Definir no serviço de staging (alteração de env = autorização explícita, pode disparar deploy): `ASAAS_AMBIENTE=sandbox`,
   `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` e os preços. Aplicar 067 e 068 no banco de staging (autorização própria).
5. Testar: Assinar → pagar a cobrança no sandbox (Pix simulado, ou `POST /v3/sandbox/payment/{id}/confirm` pelo painel
   sandbox, ou cartão de teste `4444 4444 4444 4444`) → conferir `ATIVA` na tela e o evento `PROCESSADO`.

## Falhas e recuperação

| Falha | Efeito | Recuperação |
|---|---|---|
| Provedor fora no checkout | 502 `COBRANCA_FALHOU`, nada gravado | Tentar de novo |
| Duas contratações simultâneas da mesma empresa | Trava exclusiva por empresa (`pg_try_advisory_xact_lock`, conexão própria, solta sozinha se o processo cair) | A segunda recebe 409 `CONTRATACAO_EM_ANDAMENTO`; o provedor recebe **uma** criação |
| Criação no provedor sem resposta (tempo esgotado, rede, 5xx, 408/409/429, resposta ilegível) | Pode ter sido criada | Reconsulta pela referência externa: exatamente uma ativa do mesmo cliente → vincula; não deu para saber (inclusive **listagem vazia**) → a intenção fica aberta como `CRIACAO_SEM_RESPOSTA` + 503 `COBRANCA_RESULTADO_INCERTO`. **Nenhum outro POST** enquanto ela estiver aberta |
| Processo cai durante o POST | Intenção prévia `CRIACAO_EM_CURSO` fica aberta | Bloqueia novos POSTs; a reconciliação vincula quando a assinatura aparecer |
| Erro depois do COMMIT da gravação (resposta perdida) | O vínculo pode estar gravado | Releitura por transação nova: vínculo desta assinatura → **sucesso**, nada desfeito |
| Falha antes do COMMIT ou releitura impossível | Vínculo não confirmado | **Nada é excluído**; pendência `COMMIT_INCERTO`/`VINCULO_DUVIDOSO` + 503 incerto; a retomada vincula a mesma assinatura (sem duplicar) |
| Retomada encontra várias ativas (ou uma de outro cliente) | Ambíguo | **Não escolhe a primeira**, não cria, não exclui: pendência `ASSINATURAS_AMBIGUAS` + 503 incerto |
| Banco mostra outro vínculo depois da criação | Talvez duplicata | **Decisão central** (`compensacao.ts`, abaixo). Exclui só com justificativa segura; falha ao excluir → pendência `COMPENSACAO_FALHOU`. Preservada → pendência `COMPENSACAO_PRESERVADA: <motivo>` (ou `COMMIT_INCERTO` quando o vínculo é o mesmo que a contratação viu — ex.: recontratação após cancelamento) |
| Provedor fora no cancelamento | `DELETE` não confirmado → 502, nada muda | Tentar de novo |
| `DELETE` feito e confirmação local falhou | Provedor removido, banco ainda `ATIVA` | Webhook `SUBSCRIPTION_DELETED`, sincronização do painel ou reconciliação aplicam |
| Provedor fora no processamento do webhook | Evento `FALHOU` (o 200 já saiu) | Reentrega do mesmo evento, novo evento da mesma assinatura, painel ou reconciliação |
| Banco fora no webhook | 500 → o Asaas reentrega (mesmo id); após 15 falhas seguidas a fila do Asaas é pausada (doc oficial) | Reativar a fila no painel do Asaas |
| Token trocado/errado | 401 em toda entrega | Corrigir o token no painel e no ambiente |

A sincronização consulta o provedor **com a linha da empresa travada** (até 2 chamadas de 10 s): duas sincronizações da
mesma empresa nunca aplicam uma leitura antiga depois de uma nova. Checkout e cancelamento chamam o provedor **fora**
de transação (fases A/B/C em `cobranca.ts`).

## Registro prévio da criação e bloqueio de POST

- Antes de **cada** POST de criação, a contratação grava a intenção (`cobranca_eventos`, `evento_id` `kidmais:criacao:<empresa>:<uuid>`,
  `CRIACAO_EM_CURSO`). Sem conseguir gravá-la, não cria (503).
- Resposta recebida (ou criação confirmada pela listagem) → o **id confirmado** é gravado num registro durável
  (`kidmais:vinculo:<empresa>:<intenção>`, `CRIACAO_CONFIRMADA_SEM_VINCULO`) e a intenção **continua aberta**. Intenção e
  registro do id só são encerrados na **mesma transação que grava o vínculo** (fase C): ou os dois, ou nenhum.
- Recusa definitiva 4xx → intenção `PROCESSADO` (`CRIACAO_RECUSADA`); qualquer outro erro → relista; não confirmada →
  continua aberta (`CRIACAO_SEM_RESPOSTA`).
- Processo que cai entre a resposta e a fase C: a próxima tentativa (mesmo com a listagem vazia) reaproveita pelo id
  durável, sem POST; a reconciliação desse registro também vincula. Falha tratada na fase C: a pendência do caso, com o
  id, é registrada **antes** de encerrar os registros da operação.
- Antes de criar, com a listagem vazia, a contratação lê as **pendências abertas** da empresa (qualquer motivo): com id
  conhecido, consulta pelo id e reaproveita se estiver ativa; havendo qualquer pendência aberta, **não faz POST** (503).
- Reconciliação de uma intenção sem id e listagem vazia → `FALHOU` `AGUARDANDO_CONFIRMACAO: CRIACAO_NAO_CONFIRMADA` (continua
  aberta). Fecha só quando a assinatura aparece (vincula) ou quando a empresa já está vinculada.
- **Sem liberação automática por tempo.** Se o POST realmente não criou nada, a liberação é **manual e auditada**
  (painel do desenvolvedor → ficha da empresa → "Pendências de cobrança"; `lib/assinatura/liberacao-intencao.ts`). Só
  libera se, na mesma transação (concessão de desenvolvedor travada, trava da contratação da empresa, senha confirmada
  há ≤ 5 min): é intenção de criação desta empresa, aberta e sem id; não há outra pendência aberta com id de assinatura;
  o provedor, consultado na hora, não mostra assinatura não removida da empresa; a pessoa declara que conferiu no
  painel do provedor (`CONFERI_NO_PROVEDOR_QUE_NAO_FOI_CRIADA`) e dá o motivo (10–500). Grava auditoria
  `COBRANCA_INTENCAO_LIBERADA` com o motivo; recusas não mudam nada. Depois disso a empresa pode contratar de novo.

## Decisão central de compensação (`lib/assinatura/compensacao.ts`)

Único ponto que autoriza excluir uma assinatura no provedor como duplicata; usado pela compensação imediata e pela
reconciliação. Exclui **somente** se, conferido agora:

1. o banco mostra vínculo confirmado (lido de fato), diferente da candidata;
2. o vínculo **mudou** desde o que a contratação viu (na compensação imediata) — senão `VINCULO_NAO_MUDOU`;
3. a assinatura vinculada está **vigente** no provedor (ativa, não removida) e é da mesma empresa — senão
   `VINCULADA_NAO_VIGENTE`/`VINCULADA_DE_OUTRA_EMPRESA`: uma referência antiga cancelada nunca justifica excluir;
4. a candidata existe, é da mesma empresa e **todas** as cobranças estão em aberto (`PENDING`/`OVERDUE`) — pagamento →
   `CANDIDATA_COM_PAGAMENTO`; estorno, análise ou status desconhecido → `CANDIDATA_COM_COBRANCA_INDEFINIDA`.

Falha do provedor durante a decisão → preserva (pendência `VINCULO_DUVIDOSO` na contratação; FALHOU reprocessável na
reconciliação).

## Pendências de reconciliação da contratação

Sem migration nova: linhas em `cobranca_eventos` (068) com tipo `KIDMAIS_RECONCILIAR_CONTRATACAO`, `evento_id`
`kidmais:contratacao:<empresa>:<uuid>`, `empresa_id` e motivo em `ultimo_erro`. O webhook recusa esse tipo e esse
prefixo (não podem vir de fora). Processamento (`lib/assinatura/reconciliacao-contratacao.ts`, pela reentrega, painel
ou script), com a linha da empresa travada:

| Banco | Provedor (mesma referência externa) | Ação |
|---|---|---|
| sem vínculo | nenhuma ativa | nada (PROCESSADO) |
| sem vínculo | exatamente uma ativa | vincula e sincroniza |
| sem vínculo **ou** vínculo a assinatura não ativa (antiga, cancelada) | várias ativas | FALHOU `REVISAO_HUMANA: VARIAS_ASSINATURAS_SEM_VINCULO` (não escolhe, não exclui) |
| vínculo antigo não ativo | exatamente uma ativa | vincula se a 068 permite a troca (TESTE, CANCELADA_FIM_PERIODO, ENCERRADA); senão `REVISAO_HUMANA: VINCULO_INATIVO_COM_ACESSO` |
| vinculada a S **ativa** | outras ativas | cada uma pela decisão central: aprovada → removida; todas preservadas por pagamento → `REVISAO_HUMANA: DUPLICATA_COM_PAGAMENTO`; outro motivo → `REVISAO_HUMANA: DUPLICATA_PRESERVADA` |

Provedor fora → FALHOU com o motivo, reprocessável. Nenhuma pendência vira IGNORADO.

## Reconciliação

`scripts/assinatura-reconciliar.cjs`: reprocessa eventos `PENDENTE`/`FALHOU` e ressincroniza todas as empresas com
assinatura vinculada. **Simulação por padrão** (cada item em `BEGIN … ROLLBACK`; a remoção no provedor é só contada em
`removeriaNoProvedor`, **nunca executada**, porque o ROLLBACK não desfaz o provedor); `--aplicar` grava (COMMIT por item).
Alvo sempre explícito: `KIDMAIS_RECONCILIAR_DATABASE_URL` + confirmação literal `KIDMAIS_RECONCILIAR_ALVO="<banco>@<host>:<porta>"`,
conferida também com `current_database()` depois de conectar. Recusa `DATABASE_URL`, `kidmais_manager` e bancos de
produção. Rodar em staging exige autorização (grava em `empresa_assinaturas`, `cobranca_eventos` e `auditoria`).

**Tarefa agendada (Render cron) para rodar a reconciliação periodicamente é custo novo e NÃO foi criada.**

## Custos (asaas.com/precos-e-taxas, lido em 06/10/2026; podem mudar)

Sem mensalidade; Pix R$ 1,99 (promoção R$ 0,99 nos 3 primeiros meses); boleto R$ 1,99; cartão à vista R$ 0,49 + 2,99%;
NFS-e R$ 0,49/nota; notificações SMS/e-mail R$ 0,99 e WhatsApp R$ 0,55 (desligadas aqui com `notificationDisabled`).
Render cron: não criado (custo do plano não levantado).

## O que falta para produção (cada item com autorização própria)

- Autorização explícita de Felipe para ativar produção; trocar o código para aceitar `ASAAS_AMBIENTE=producao` com a
  URL `https://api.asaas.com/v3` e a chave `$aact_prod_` (hoje recusadas de propósito).
- Chave e token de webhook **novos** em produção (nunca reutilizar os do sandbox); rotação do token documentada.
- Decisão de NFS-e (D2: entidade vendedora, regime, ISS) e se a NFS-e automática por assinatura do Asaas será usada.
- Pix Automático exige CNPJ recebedor com ≥ 6 meses (não implementado; a fatura hospedada cobra Pix avulso).
- Revisão jurídica (D11) e política de estorno/chargeback (hoje não revoga período já liberado).
- Decidir a tarefa agendada de reconciliação (custo novo) ou rotina manual.
- Considerar restringir o webhook aos IPs publicados do Asaas.

## Validação (07/10/2026)

- Unitários: `asaas.test.ts` 5/5, `provedor-estado.test.ts` 9/9, `webhook-asaas.test.ts` 7/7, `reconciliacao.test.ts` 2/2,
  `contratacao.test.ts` 4/4 (classificação de resultado incerto, tipo reservado recusado no webhook, toda exclusão automática
  passa pela decisão central, tabela da decisão com 15 casos).
- `contratacao-e8.postgres.test.ts` 16/16, com **várias conexões reais** (trava de verdade) e provedor **falso**: duas contratações
  simultâneas; COMMIT confirmado + erro de comunicação; resposta perdida reencontrada; resposta perdida sem confirmação
  (pendência + retomada sem duplicar); queda antes do COMMIT (nada excluído); releitura impossível; falha na compensação
  (pendência e resolução posterior); duplicata paga (revisão humana); **compensação imediata com pagamento**, **recontratação
  após cancelamento com resposta perdida** e **retomada com várias ativas** (nenhuma exclusão; os três falham no código
  anterior `d043485`: excluía a paga, excluía a recontratação, escolhia a primeira); **POST com resposta perdida e listagem
  vazia** (nova tentativa não faz POST; o provedor recebe uma criação) e **processo que cai depois do POST** (intenção
  prévia bloqueia) — os dois falham no código anterior `845ce4d`, que fazia um segundo POST; **POST com sucesso e queda
  antes da fase C com a listagem vazia** (uma criação; no código anterior `9d82e79` eram duas), a mesma queda resolvida
  pela reconciliação, e a **liberação manual** (recusas e auditoria).
- PostgreSQL 18 descartável (cluster próprio, porta 55532, modelo `atual` + 067 + 068): `cobranca-e8.postgres.test.ts` 6/6 e
  `cobranca-068.postgres.test.ts` 7/7.
- `npx tsc --noEmit`, ESLint dos arquivos alterados, `npm run check:v1:static` (2031 testes, lint, TypeScript, build) e
  `npm run production:test` (37/37) aprovados.

## Evidências: simuladas × reais

| Item | Evidência |
|---|---|
| Cliente HTTP (cabeçalhos, URL, prefixo, tempo-limite, `notificationDisabled`, nada em log) | **Simulada** (fetch falso) — `lib/assinatura/asaas.test.ts` |
| Mapeamento de estados | **Simulada** (função pura) — `lib/assinatura/provedor-estado.test.ts` |
| Webhook (401/413/503/429, duplicado, fora de ordem, tipo desconhecido, provedor fora, checkout sem webhook) | **Simulada** (banco em memória + provedor falso) — `lib/assinatura/webhook-asaas.test.ts` |
| SQL real, guarda da 068, savepoint, limite por IP real, paywall após cada passo, isolamento entre empresas | **Real no PostgreSQL 18 descartável**, provedor **falso** — `lib/assinatura/cobranca-e8.postgres.test.ts` |
| Concorrência, resultados incertos, compensação e pendências | **Real no PostgreSQL 18 descartável (várias conexões)**, provedor **falso** — `lib/assinatura/contratacao-e8.postgres.test.ts` |
| Guarda de alvo da reconciliação | **Simulada** (sem conexão) — `lib/assinatura/reconciliacao.test.ts` |
| Comunicação com o Asaas sandbox, formato real das respostas, entrega real do webhook, página de pagamento | **Não verificada** (sem credenciais; proibido nesta tarefa) |
| Execução do script de reconciliação contra um banco | **Não verificada** |
| Telas (assinar, continuar pagamento, cancelar, retorno, sincronizar no painel) | Build e tipos; **sem teste de navegador** nesta entrega |
