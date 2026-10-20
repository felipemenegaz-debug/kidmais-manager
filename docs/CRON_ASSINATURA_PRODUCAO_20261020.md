# Cron de conferência de pagamentos em produção — 20/10/2026 (V8 da abertura da venda)

**Status: DEFINIÇÃO PREPARADA, NADA CRIADO NO RENDER.** Nenhum metadado do Render foi lido nesta preparação; o estado abaixo
é o informado em 20/10. Criar o serviço, gravar variáveis ou disparar execução exige autorização explícita de Felipe
([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)). Definição revisável: [infra/render-assinatura-cron-production.yaml](../infra/render-assinatura-cron-production.yaml).

Estado informado: só existe o cron de staging `kidmais-assinatura-reconciliar-staging` (`crn-db493i142hec73ahmoe0`, branch
`staging`, `*/5 * * * *`); não há cron de produção. Production live `dc157a7`, mesma árvore de staging `aa442b7`.

## 1. O que roda

`node scripts/assinatura-cron.cjs` → `planejar()`:

- **Produção** (`KIDMAIS_DEPLOY_ENV=production`) aceita só dois modos:
  - `aguardando`: sai 0 sem conectar;
  - `conferir`: chama `scripts/assinatura-reconciliar.cjs` **sem** `--aplicar`, em simulação.
- **Na simulação:**
  - cada item roda em `BEGIN … ROLLBACK`;
  - mutações no Asaas são proibidas (remover só é contado);
  - lê eventos Asaas `PENDENTE/FALHOU` e as empresas com assinatura vinculada ao Asaas, consultando o provedor só por
    leitura;
  - confere a gratuidade da Kidmais: uma `kidmais` ATIVA, sem assinatura, contratação nem vaga Fundador (B17).
- **Saídas:**
  - 0 = sem divergência;
  - **2** = evento não concluído, empresa cujo estado mudaria, item falho ou Kidmais violada (o cron falha e o Render
    notifica);
  - 1 = configuração recusada ou interrupção.
- **Correção de divergência:** nunca pelo cron. Reenvio do webhook no painel do Asaas ou pacote autorizado.

**O código já está na branch `production` (`dc157a7`): criar o cron não exige PR, merge nem deploy do web.**

## 2. Definição do serviço

| Campo | Valor | Observação |
|---|---|---|
| Nome | `kidmais-assinatura-reconciliar-production` | |
| Tipo | Cron Job, runtime Node | |
| Repositório / branch | `felipemenegaz-debug/kidmais-manager` / **`production`** | auto-deploy **off** |
| Região | `virginia` | a mesma do banco `kidmais-production`; a URL interna só resolve nela |
| Plano | o mesmo do cron de staging (`0.5c-512mb` no YAML de staging) | confirmar nome e custo no painel (D-C2) |
| Agenda | `0 9 * * *` (09:00 UTC = 06:00 BRT, diário) | a do roteiro de 13/10 (D-C1) |
| Build | `npm ci --include=dev && node --test scripts/assinatura-cron.test.cjs scripts/assinatura-reconciliar.test.cjs` | idêntico ao de staging; os testes rodam no build |
| Start | `node scripts/assinatura-cron.cjs` | |
| Notificação | falha de cron por e-mail ligada (Settings → Notifications) | no staging foi comprovado o aviso em 09/10 |

## 3. Variáveis — lista exata

| # | Variável | Valor / origem | Copiar do web de produção? | Diferente do cron de staging? |
|---|---|---|---|---|
| 1 | `NODE_VERSION` | `22.23.2` | igual ao web | igual |
| 2 | `NODE_ENV` | `production` | igual ao web | igual |
| 3 | `KIDMAIS_DEPLOY_ENV` | `production` | igual ao web | **sim** (staging) |
| 4 | `KIDMAIS_RECONCILIAR_MODO` | `aguardando` → depois `conferir` | só do cron | **sim** (staging usa `aguardando/simular/aplicar`; produção só `aguardando/conferir`) |
| 5 | `KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO` | `074-075` (074a/075 aplicadas em 20/10) | só do cron | igual |
| 6 | `KIDMAIS_RECONCILIAR_ALVO` | `kidmais_production@dpg-dak750gae00c73fudmg0-a:5432` | só do cron | **sim** |
| 7 | `KIDMAIS_RECONCILIAR_DATABASE_URL` | **secreta**: o MESMO valor da `DATABASE_URL` do web de produção (URL interna, host sem domínio, sem `?`) | **sim (valor)** | **sim** |
| 8 | `DATABASE_SSL` | `true` | **sim** (o web usa `true`) | **sim** (o cron de staging não usa; tem `KIDMAIS_RECONCILIAR_TLS`) |
| 9 | `DATABASE_SSL_REJECT_UNAUTHORIZED` | `false` | **sim** (registrado em 17/10: produção usa `false`; conferir no web) | **sim** |
| 10 | `ASAAS_AMBIENTE` | `producao` | **sim** (quando o web tiver) | **sim** (`sandbox`) |
| 11 | `ASAAS_API_KEY` | **secreta**: `$aact_prod_…` | **sim (valor)** | **sim** (nunca a de sandbox) |
| 12 | `ASAAS_WEBHOOK_TOKEN` | **secreta** (32–255 caracteres; a reconciliação exige o formato mesmo sem receber webhook) | **sim (valor)** | **sim** |

`RENDER` e `RENDER_SERVICE_ID` são do próprio Render.

**Não definir:**
- `DATABASE_URL`: a reconciliação recusa quando é igual à 7;
- `KIDMAIS_RECONCILIAR_TLS`: recusada em produção, só existe para o cron de staging;
- `KIDMAIS_RECONCILIAR_CA_PEM`: não usada em produção;
- interruptores de abertura (`CADASTRO_*`, `ASSINATURA_PLANOS_ATIVOS`, `SITE_*`), e-mail e `ASSINATURA_*_DIAS`: o caminho
  da reconciliação não os lê.

Copiar do web, digitado por Felipe no painel, nunca pelo chat: 7, 8, 9, 10, 11 e 12. Não reutilizar nada do cron de staging.

## 4. Travas que impedem rodar contra staging ou sandbox

Todas no código já publicado e cobertas por [scripts/assinatura-cron-producao-20261020.test.cjs](../scripts/assinatura-cron-producao-20261020.test.cjs),
[scripts/assinatura-cron.test.cjs](../scripts/assinatura-cron.test.cjs) e [scripts/assinatura-reconciliar.test.cjs](../scripts/assinatura-reconciliar.test.cjs).

- **Modo:** `KIDMAIS_DEPLOY_ENV=production` só aceita `aguardando` ou `conferir`; `aplicar`/`simular` → `MODO_INVALIDO`.
  Na reconciliação, `--aplicar` com alvo de produção é recusado antes de conectar.
- **Alvo literal:** `KIDMAIS_RECONCILIAR_ALVO` precisa bater com a URL (`<banco>@<host>:<porta>`).
  - Produção só com o banco `kidmais_production`, o host interno exato e a porta 5432, mais `RENDER=true`,
    `KIDMAIS_DEPLOY_ENV=production` e `ASAAS_AMBIENTE=producao`.
  - Banco de staging no cron de produção → `ALVO_PRODUCAO_RECUSADO`.
  - Host externo (com domínio) → recusa.
  - O cron de staging recusa qualquer alvo fora de `kidmais_staging_1z91` e Asaas fora de `sandbox`.
- **Pareamento B1 (`lib/assinatura/asaas.ts`):**
  - `producao` só com `KIDMAIS_DEPLOY_ENV=production`;
  - a chave precisa do prefixo `$aact_prod_` (chave de sandbox → "não é uma chave de produção");
  - a URL do provedor é fixa (`api.asaas.com`).
- **Conexão própria:** `DATABASE_URL` igual à URL da reconciliação → recusa.
- **TLS como o web:** `DATABASE_SSL=true` obrigatório (`TLS_PRODUCAO_RECUSADO`); `KIDMAIS_RECONCILIAR_TLS` proibida;
  `sslmode` fraco na URL recusado.
- **Depois de conectar:** `current_database()` e TLS ativo conferidos.
- **Lacuna aceita:** o caminho de produção não confere `RENDER_SERVICE_ID`. Outro serviço Render com as mesmas variáveis
  também conseguiria rodar a conferência, que só simula.

## 5. Quando o Asaas de produção ainda NÃO está configurado

| Modo | Comportamento (código + teste) | Seguro? |
|---|---|---|
| `aguardando` | `planejarProducao` devolve `null` **antes** de validar alvo: imprime `{"estado":"AGUARDANDO_HABILITACAO","conectou":false}` e sai **0**. Não precisa de URL do banco nem de chave. | **no-op seguro** |
| `conferir` sem chave/token (ou chave de sandbox) | a reconciliação para em `configuracaoAsaas` ("…cobrança desligada") **antes** de importar o `pg` e de conectar; sai **1** | seguro (nada conecta, nada grava), mas **não é no-op**: o Render marca falha e notifica todo dia |
| `conferir` sem `ASAAS_AMBIENTE=producao` | o plano do cron recusa o alvo de produção ("Cron recusado"); sai **1** | idem |
| `conferir` com Asaas configurado e nenhuma assinatura | conecta (transações desfeitas); 0 eventos e 0 empresas, **nenhuma chamada ao Asaas**; confere a Kidmais; sai **0** | sim |

Conclusão: o cron deve nascer em **`aguardando`** e só passar para `conferir` depois que o web de produção tiver o Asaas de
produção (P6 etapa 4 do [roteiro de 13/10](RODADA_FINAL_LANCAMENTO_20261013.md)).

## 6. Roteiro proposto (cada passo com autorização própria)

1. **C1 — criar o cron em `aguardando`** (independe do Asaas):
   - campos da seção 2;
   - variáveis 1–6, 8 e 10 (`ASAAS_AMBIENTE=producao` sozinho não liga nada) e 9, conferida no web;
   - sem segredos;
   - notificação ligada; "Trigger run" uma vez → saída 0 e `AGUARDANDO_HABILITACAO`.
   - Custo do plano a confirmar.
2. **C2 — depois que o web de produção tiver `ASAAS_AMBIENTE=producao`, a chave e o token** (e o webhook registrado):
   - copiar para o cron a 7 (valor da `DATABASE_URL` do web), a 11 e a 12;
   - trocar a 4 para `conferir` (gera build; acompanhar sem deploy duplicado);
   - "Trigger run" → saída 0, `kidmais.violada: false`, `eventos {}` e `empresas {}`.
3. **C3 — antes de `CADASTRO_PUBLICO_ATIVO=true`:** C2 PASS. Depois da primeira venda assistida (P8), a conferência do dia
   seguinte precisa sair 0.
4. **Recuperação:** voltar a 4 para `aguardando` (no-op), ou suspender o cron. Nenhuma ação grava no banco ou no Asaas.

## 7. Riscos e decisões pendentes de Felipe

- **D-C1 — agenda:** diário às 06:00 BRT (roteiro de 13/10) ou mais frequente nos primeiros dias de venda. O webhook
  continua sendo o caminho principal; a conferência só detecta.
- **D-C2 — plano e custo** do novo cron: o mesmo do staging, a confirmar no painel.
- **D-C3 — credencial:** o cron usa a mesma credencial do web (dono do banco). A simulação escreve e desfaz, então um papel
  somente leitura não serve; um papel dedicado não foi preparado.
- **Rotação:** se a credencial do banco de produção for rotacionada, a cópia no cron precisa ser atualizada junto. Se não
  for, o cron falha (código 1/2) e notifica. Alternativa a avaliar: `fromDatabase` num Blueprint ou um grupo de ambiente
  (mudaria a configuração do web; fora deste escopo).
- **Falso alarme:** um evento que chega durante a conferência, ou um webhook atrasado, dá saída 2; a próxima conferência
  normaliza. Ler o relatório antes de agir.
- **Ordem:** com `conferir` ligado e a chave de produção ausente ou rotacionada, o cron falha diariamente (seguro, mas
  ruidoso). Manter `aguardando` até C2.
