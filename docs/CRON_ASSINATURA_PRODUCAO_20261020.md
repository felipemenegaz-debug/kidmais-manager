# Cron de conferência de pagamentos em produção — 20/10/2026 (V8 da abertura da venda)

**Status: DEFINIÇÃO PREPARADA, NADA CRIADO NO RENDER.** Nenhum metadado do Render foi lido nesta preparação; o estado abaixo
é o informado em 20/10.

**Revisão independente de 20/10:**
- **C1 (criar em `aguardando`, sem nenhuma variável secreta): aprovado.**
- **C2 (`conferir`): bloqueado**, até três condições:
  1. Felipe decidir sobre o alarme persistente (§5a, P2-B1);
  2. o cron entrar no roteiro de rotação — feito em [ROTACAO_CREDENCIAIS_20261007.md](ROTACAO_CREDENCIAIS_20261007.md)
     (P2-B2);
  3. o Asaas de produção estar configurado no web. Criar o serviço, gravar variáveis ou disparar execução exige autorização explícita de Felipe
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
- **Correção de divergência:** nunca pelo cron. Ver §5a: a saída 2 pode ser transitória ou persistente, e a persistente só
  some com ação humana.

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
- **Lacuna aceita (P3-B1):** o caminho de produção não confere `RENDER_SERVICE_ID`. Outro serviço Render com as mesmas
  variáveis também conseguiria rodar a conferência, que só simula. Proposta para uma PR futura, depois do C1: fixar o
  `crn-…` real do cron de produção em `planejarProducao`, como o cron de staging faz na exceção de TLS.

## 5. Quando o Asaas de produção ainda NÃO está configurado

| Modo | Comportamento (código + teste) | Seguro? |
|---|---|---|
| `aguardando` | `planejarProducao` devolve `null` **antes** de validar alvo: imprime `{"estado":"AGUARDANDO_HABILITACAO","conectou":false}` e sai **0**. Não precisa de URL do banco nem de chave. | **no-op seguro** |
| `conferir` sem chave/token (ou chave de sandbox) | a reconciliação para em `configuracaoAsaas` ("…cobrança desligada") **antes** de importar o `pg` e de conectar; sai **1** | seguro (nada conecta, nada grava), mas **não é no-op**: o Render marca falha e notifica todo dia |
| `conferir` sem `ASAAS_AMBIENTE=producao` | o plano do cron recusa o alvo de produção ("Cron recusado"); sai **1** | idem |
| `conferir` com Asaas configurado e nenhuma assinatura | conecta (transações desfeitas); 0 eventos e 0 empresas, **nenhuma chamada ao Asaas**; confere a Kidmais; sai **0** | sim |

Conclusão: o cron deve nascer em **`aguardando`** e só passar para `conferir` depois que o web de produção tiver o Asaas de
produção (P6 etapa 4 do [roteiro de 13/10](RODADA_FINAL_LANCAMENTO_20261013.md)) **e** depois da decisão do §5a.

## 5a. O alarme (saída 2): transitório × persistente, triagem e resolução (P2-B1)

### Quando a conferência sai 2 (código publicado)

Base: `scripts/assinatura-reconciliar.cjs`, funções `executarCiclo` e `codigoDeSaida`.

**Eventos — `relatorio.eventos`:** qualquer linha de `cobranca_eventos` com `provedor = 'ASAAS'` e
`situacao IN ('PENDENTE','FALHOU')` (até 500) entra no relatório com o resultado que o processamento simulado teria
(`PROCESSADO`, `IGNORADO`, `FALHOU`, `ERRO_<tipo>`). **Basta uma linha** para `divergente = true`, ou seja, saída 2. Entram
aí:
- eventos de webhook recebidos e não concluídos;
- as **pendências internas** de contratação (`tipo = 'KIDMAIS_RECONCILIAR_CONTRATACAO'`, `evento_id` `kidmais:criacao:…` /
  `kidmais:contratacao:…`), que nascem quando o resultado de uma contratação fica incerto
  (`lib/assinatura/reconciliacao-contratacao.ts`);
- os marcadores de exclusão sem confirmação (`kidmais:remocao:…`).

**Empresas — `relatorio.empresas`:** cada empresa com assinatura vinculada ao Asaas é sincronizada em simulação. Qualquer
chave diferente de `SEM_MUDANCA` também dá saída 2: `MUDOU_<antes>_PARA_<depois>`, `RECUSADA`, `SEM_CONFIRMACAO`,
`ERRO_<tipo>` e os demais resultados (por exemplo, adiada ou revisão humana).

**Kidmais:** `kidmais.violada = true` dá saída 2 em qualquer caso.

### Transitório × persistente

| Tipo | Exemplos | Some sozinho? |
|---|---|---|
| Transitório | webhook que chegou durante a conferência; pagamento confirmado no Asaas minutos antes e webhook ainda a caminho (`MUDOU_…`) | sim, na próxima conferência, se o webhook for processado |
| **Persistente** | evento `FALHOU` (erro que não se resolve repetindo); pendência interna de contratação; marcador `kidmais:remocao:`; empresa `RECUSADA`/`SEM_CONFIRMACAO`/revisão humana | **não**: em staging o cron `aplicar` resolve o que é resolvível; em produção o cron **só simula**, então nada fecha sozinho. Cada um gera saída 2 e notificação **todo dia** até a ação humana |

### Triagem (ler o log do cron no Render; o relatório não tem dado pessoal)

1. `kidmais.violada: true` → **prioridade máxima**: a gratuidade da Kidmais foi violada (assinatura, contratação ou vaga na
   Kidmais). Não mexer; levar para decisão.
2. `incompleto: true` (evento `FALHOU`/`ERRO_*`, empresa `RECUSADA`/`SEM_CONFIRMACAO`/`ERRO_*`) → falha real. Abrir a
   empresa no painel do desenvolvedor.
3. Só `eventos.PROCESSADO`/`IGNORADO` ou `empresas.MUDOU_…` → provável atraso de webhook. Conferir no painel do Asaas se
   o webhook foi entregue; se falhou, reenviar.
4. `removeriaNoProvedor > 0` → há duplicata de assinatura que o modo `aplicar` removeria. Em produção não se remove
   nada automaticamente: decisão humana.

### Resolução em produção (nunca pelo cron)

- **Painel do Asaas:** reenviar o webhook com falha. O processamento normal fecha o evento.
- **Painel do desenvolvedor → empresa → Cobrança** (`lib/desenvolvedor/cobranca.ts`), com senha confirmada há pouco:
  - **Sincronizar:** aplica o estado atual do provedor, com auditoria; resolve `MUDOU_…`.
  - **Pendências:** lista as pendências abertas da empresa.
  - **Liberar intenção:** para `kidmais:criacao:…` comprovadamente não executada no provedor.
- **Pacote autorizado:** o que nenhum dos dois resolve (por exemplo, marcador `kidmais:remocao:` que exige reler e fechar,
  ou `FALHOU` permanente). `assinatura-reconciliar.cjs --aplicar` é **recusado em produção** por desenho, então fechar
  esses itens exige pacote próprio, com autorização. **Esta é uma lacuna real:** hoje não há ferramenta pronta para fechar
  em produção uma pendência que o painel não fecha.

### Proposta (NÃO implementada) para não alarmar todo dia pelo mesmo item — decisão D-C4

O cron não tem disco e a conferência é somente simulação, então não há onde gravar "já avisei". A proposta é uma regra **sem
estado, por idade**, numa PR futura em `assinatura-reconciliar.cjs` (modo de produção):

- **Saída 2:**
  - `kidmais.violada`;
  - item novo: evento com `recebido_em` nas últimas 26 h, ou empresa `MUDOU_…`/`ERRO_…` nesta execução;
  - pendência que acaba de cruzar um marco de idade (1, 3 e 7 dias, depois uma vez por semana, quando a idade em dias é
    múltiplo de 7).
- **Saída 0 com aviso no relatório:** demais pendências antigas, listadas como `pendentesConhecidos` (contagem por tipo e
  idade máxima), para não esconder nada de quem ler o log.
- **Requisitos:**
  - a consulta de pendências passa a devolver `recebido_em`;
  - testes para os marcos;
  - documentar que uma pendência persistente gera **lembretes**, não silêncio.

Alternativas:
- (a) aceitar a saída 2 diária até resolver (simples, mas cansa e faz ignorar alarmes);
- (b) uma tabela de "pendência reconhecida" gravada pelo painel do desenvolvedor (exige migration);
- (c) o cron de produção em `aplicar` (fora de questão sem nova revisão).

**C2 fica bloqueado até Felipe escolher**: proposta, (a), (b) ou outra.

## 6. Roteiro proposto (cada passo com autorização própria)

1. **C1 — criar o cron em `aguardando`** (independe do Asaas):
   - criação **manual** no painel com os campos da seção 2;
   - variáveis 1–6, 8, 9 (conferida no web) e 10 (`ASAAS_AMBIENTE=producao` sozinho não liga nada);
   - **nenhuma das três secretas (7, 11 e 12) é criada em C1** (P3-B3). Por Blueprint, o Render pediria os valores das
     chaves `sync: false`: não usar Blueprint em C1;
   - confirmar no painel o tipo e o custo do plano (P3-B4);
   - notificação ligada; "Trigger run" uma vez → saída 0 e `AGUARDANDO_HABILITACAO`.
2. **C2 — BLOQUEADO** até:
   - a decisão D-C4 (§5a), implementada se for o caso;
   - o web de produção com `ASAAS_AMBIENTE=producao`, chave e token, e o webhook registrado.

   Depois disso:
   - copiar para o cron a 7 (valor da `DATABASE_URL` do web), a 11 e a 12;
   - trocar a 4 para `conferir` (gera build; acompanhar sem deploy duplicado);
   - "Trigger run" → saída 0, `kidmais.violada: false`, `eventos {}` e `empresas {}`.

   A partir daqui o cron entra no roteiro de rotação ([ROTACAO_CREDENCIAIS_20261007.md](ROTACAO_CREDENCIAIS_20261007.md),
   "Consumidores fora do serviço web").
3. **C3 — antes de `CADASTRO_PUBLICO_ATIVO=true`:** C2 PASS. Depois da primeira venda assistida (P8), a conferência do dia
   seguinte precisa sair 0.
4. **Recuperação:** voltar a 4 para `aguardando` (no-op), ou suspender o cron. Nenhuma ação grava no banco ou no Asaas.

## 7. Riscos e decisões pendentes de Felipe

- **D-C1 — agenda:** diário às 06:00 BRT (roteiro de 13/10) ou mais frequente nos primeiros dias de venda. O webhook
  continua sendo o caminho principal; a conferência só detecta.
- **D-C2 — plano e custo** do novo cron: o identificador `0.5c-512mb` foi copiado do YAML de staging e não foi verificado
  como valor de Blueprint (P3-B4); confirmar no painel.
- **D-C3 — credencial:** o cron usa a mesma credencial do web (dono do banco). A simulação escreve e desfaz, então um papel
  somente leitura não serve; um papel dedicado não foi preparado. Em C2, a credencial e a chave Asaas de produção passam a
  existir em um segundo serviço (superfície maior).
- **D-C4 — alarme persistente:** ver §5a. Bloqueia C2.
- **Rotação (P2-B2):** em `conferir`, rotacionar a `DATABASE_URL` ou a chave do Asaas sem atualizar o cron faz o cron
  falhar todo dia (código 1). O passo agora está no roteiro de rotação. Alternativa a avaliar: `fromDatabase` num
  Blueprint ou um grupo de ambiente (mudaria a configuração do web; fora deste escopo).
- **Travas de linha na simulação (P3-B2):** cada item segura travas de linha (empresa/assinatura) enquanto faz leituras no
  Asaas (tempo-limite de 10 s por chamada). Um webhook ou uma tela da mesma empresa espera até o fim daquele item. Às
  06:00 e com pouco volume o risco é baixo.
- **Substituições mortas (P3-B6):** `provedorDaExecucao` substitui `atualizarValorAssinatura`, `atualizarValorCobranca` e
  `suspenderGeracao`, que não existem em `ClienteAsaas`. São inofensivas; a proteção efetiva na simulação é a de
  `removerAssinatura` (só contada) e o ROLLBACK por item. Limpar numa PR futura.
- **Ordem:** com `conferir` ligado e a chave de produção ausente ou rotacionada, o cron falha diariamente (seguro, mas
  ruidoso). Manter `aguardando` até C2.

## 8. Testes e CI

- [scripts/assinatura-cron-producao-20261020.test.cjs](../scripts/assinatura-cron-producao-20261020.test.cjs) lê os dois
  YAML sem dependência externa (P3-B5: `js-yaml` era só dependência transitiva do ESLint). O leitor aceita só o formato fixo
  desses arquivos e falha em qualquer linha fora dele.
- O passo "Testes do reparo de bloqueios e do cron de conferência (produção)" do `.github/workflows/ci.yml` roda os 6
  arquivos `.test.cjs` destas peças (o `check:v1:static` só seleciona `*.test.ts`).
