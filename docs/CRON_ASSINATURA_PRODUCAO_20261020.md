# Cron de conferência de pagamentos em produção — 20/10/2026 (V8 da abertura da venda)

**Status: DEFINIÇÃO PREPARADA, NADA CRIADO NO RENDER.** Nenhum metadado do Render foi lido nesta preparação; o estado abaixo
é o informado em 20/10.

**Revisão independente de 20/10:**
- **C1 (criar em `aguardando`, sem nenhuma variável secreta): aprovado.**
- **C2 (`conferir`): bloqueado**, até três condições:
  1. ~~Felipe decidir sobre o alarme persistente (§5a, P2-B1)~~ — **D-C4 decidida por Felipe em 20/10/2026 e implementada
     LOCALMENTE** (alarme por idade, §5a; branch `codex/dc4-alarme-cron-20261020`, sem push). **Deixa de bloquear C2 como
     decisão**, mas o código precisa chegar à branch `production` (PR → staging → promoção → `production`) antes de C2: o
     cron de produção roda essa branch e, sem a regra, `conferir` volta a alarmar todo dia;
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
- **Saídas (código publicado em `dc157a7`):**
  - 0 = sem divergência;
  - **2** = evento não concluído, empresa cujo estado mudaria, item falho ou Kidmais violada (o cron falha e o Render
    notifica);
  - 1 = configuração recusada ou interrupção.
- **Saídas com a D-C4 (implementação LOCAL, §5a):** 2 só com Kidmais violada ou com algum item em **alarme** (novo, em dia
  de aviso, empresa divergente, sem idade ou erro desta execução); pendências antigas fora dos dias de aviso saem 0 e ficam
  listadas em `pendentesConhecidos`. O código 1 não muda.
- **Correção de divergência:** nunca pelo cron. Ver §5a: a saída 2 pode ser transitória ou persistente, e a persistente só
  some com ação humana.

**O código já está na branch `production` (`dc157a7`): criar o cron (C1) não exige PR, merge nem deploy do web.** A regra
D-C4 ainda não está: para C2 ela precisa chegar à `production` (§6).

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
produção (P6 etapa 4 do [roteiro de 13/10](RODADA_FINAL_LANCAMENTO_20261013.md)) **e** depois que a regra D-C4 (§5a,
decidida em 20/10) estiver na branch `production`.

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
| **Persistente** | evento `FALHOU` (erro que não se resolve repetindo); pendência interna de contratação; marcador `kidmais:remocao:`; empresa `RECUSADA`/`SEM_CONFIRMACAO`/revisão humana | **não**: em staging o cron `aplicar` resolve o que é resolvível; em produção o cron **só simula**, então nada fecha sozinho. No código publicado, cada um gera saída 2 e notificação **todo dia** até a ação humana; com a D-C4, eventos e pendências passam a gerar **lembretes** (dias 1, 3, 7 e semanais) e ficam listados nos outros dias; empresa divergente continua alarmando todo dia (sem idade confiável) |

### Triagem (ler o log do cron no Render; o relatório não tem dado pessoal)

0. Com a D-C4: `alarme.itens` diz **por que** a execução saiu 2 (`aviso`: `NOVO`, `DIA_n`, `EMPRESA_SEM_IDADE`,
   `SEM_IDADE`, `ERRO_NESTA_EXECUCAO`); `pendentesConhecidos` lista o que continua aberto sem alarmar hoje (idade, motivo e
   próximo dia de aviso). Saída 0 **não** quer dizer "nada pendente": olhar sempre `pendentesConhecidos`.
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

### D-C4 — alarme por idade: DECIDIDA por Felipe (20/10/2026) e IMPLEMENTADA LOCALMENTE

**Estado:** implementação **local** na branch `codex/dc4-alarme-cron-20261020` (base `staging` `73618a2`). Sem push, PR,
merge ou deploy; o cron de produção ainda não existe e a branch `production` ainda não tem a regra. Vale **só na conferência
de produção** (`conferir`).

Foi escolhida a regra **sem estado, por idade** (a proposta de 19–20/10, precisada abaixo). O cron não tem disco e só simula,
então nada é gravado: a idade de cada item é recalculada a cada execução a partir do próprio banco. Alternativas descartadas:
(a) saída 2 diária até resolver (cansa e faz ignorar alarmes); (b) tabela de "pendência reconhecida" (exige migration);
(c) o cron de produção em `aplicar` (fora de questão sem nova revisão).

**Regra exata** (`scripts/assinatura-reconciliar.cjs`: `referenciaDoDia`, `diaDoItem`, `diaDeAviso`,
`classificarConferencia`, `lerIdadesDosEventos`, `codigoDeSaida`):

1. **Referência do dia (R):** as 09:00:00 UTC do dia da execução, a hora da agenda `0 9 * * *` (`HORA_CRON_UTC`; um teste
   amarra a constante ao YAML). Toda execução entre 08:00 UTC de um dia e 08:00 UTC do dia seguinte usa a mesma R: tolera
   até 1 h de antecipação e até 23 h de atraso. O "agora" é o `clock_timestamp()` do banco, o mesmo relógio de
   `recebido_em`.
2. **Dia do item:** `dia = floor((R − recebido_em) / 24 h)`, com mínimo 0.
3. **Dias de aviso:** 0 (novo), 1, 3, 7 e depois a cada 7 (14, 21, 28…). Item em dia de aviso → saída 2; nos outros dias,
   o item sai em `pendentesConhecidos`.

| dia | 0 | 1 | 2 | 3 | 4–6 | 7 | 8–13 | 14 | 15–20 | 21 | 22–27 | 28 … |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| resultado | **2** `NOVO` | **2** `DIA_1` | 0, próximo 3 | **2** `DIA_3` | 0, próximo 7 | **2** `DIA_7` | 0, próximo 14 | **2** `DIA_14` | 0, próximo 21 | **2** `DIA_21` | 0, próximo 28 | **2** a cada 7 dias |

**Janelas em idade real:** numa execução às R + δ (δ = atraso real), `dia = N` ⇔ idade real ∈ [N·24 h + δ, (N+1)·24 h + δ).
Cada janela tem 24 h; a de "novo" é idade real < 24 h + δ (≤ 26 h com até 2 h de atraso). Como a janela acompanha o atraso
de cada execução, execuções diárias consecutivas caem em dias consecutivos: **cada marco é avisado exatamente uma vez**,
qualquer que seja o atraso (teste com atrasos de 0 s a 22 h e uma antecipação de 50 min, por 70 dias).

**Idade de cada tipo de item** (`item` no relatório):

| Item | Fonte | Timestamp da idade | Se faltar |
|---|---|---|---|
| `EVENTO_ASAAS` | `cobranca_eventos` de webhook em `PENDENTE`/`FALHOU` | `recebido_em` | alarma (`SEM_IDADE`) |
| `PENDENCIA_CRIACAO` (`kidmais:criacao:`), `PENDENCIA_CONTRATACAO` (`kidmais:contratacao:`), `PENDENCIA_VINCULO` (`kidmais:vinculo:`), `MARCADOR_REMOCAO` (`kidmais:remocao:`), `PENDENCIA_INTERNA` (outro `kidmais:`) | `cobranca_eventos` com `tipo = 'KIDMAIS_RECONCILIAR_CONTRATACAO'` | `recebido_em` | alarma (`SEM_IDADE`) |
| `EMPRESA` (resultado ≠ `SEM_MUDANCA`: `MUDOU_…`, `RECUSADA`, `SEM_CONFIRMACAO`…) | sincronização simulada | **nenhum confiável** | alarma **sempre** (`EMPRESA_SEM_IDADE`) |

- **Por que `recebido_em` é confiável:**
  - é `NOT NULL DEFAULT clock_timestamp()`, gravado pelo banco na inserção;
  - a guarda da 068 recusa qualquer `UPDATE` que o altere e recusa reabrir evento concluído;
  - a reentrega do mesmo evento pelo Asaas não cria linha nova (`ON CONFLICT DO NOTHING`);
  - cada pendência interna é uma linha nova (`evento_id` com UUID aleatório).

  A idade nunca é reiniciada, e um problema que reaparece é uma linha nova, com aviso de novo.
- **Por que a empresa não tem idade:** `sincronizado_em` marca a última sincronização, não o início da divergência. Usá-lo
  faria uma divergência de hoje parecer antiga e ficar sem alarme (falha aberta). Sem estado gravado não existe
  "divergente desde", então a regra é falha fechada: alarma toda execução. `RECUSADA` (referência divergente) é trava de
  isolamento e alarmaria de qualquer forma.
- **Sem idade = alarme:** linha não encontrada na leitura de idades, `recebido_em` nulo ou ilegível, ou relógio do banco
  ausente → `SEM_IDADE`.

**Continua como hoje (fora da regra):**
- `kidmais.violada: true` → saída 2 sempre;
- **erro desta execução** → saída 2 sempre (`ERRO_NESTA_EXECUCAO`): item que lançou exceção (`ERRO_*`) ou cujo
  processamento simulado falhou com `PROVEDOR_INDISPONIVEL`/`ERRO_INTERNO`. A conferência não conseguiu verificar o item
  hoje, então não é "pendência conhecida";
- configuração recusada, alvo/TLS recusado, conexão ou interrupção → saída 1, sem relatório;
- relatório cuja contagem (`eventos` + empresas ≠ `SEM_MUDANCA`) não fecha com `alarme.itens` + `pendentesConhecidos` →
  saída 2.

**Saída no log** (sem id, `evento_id`, empresa, nome ou texto livre; o `motivo` é reduzido ao código em maiúsculas, por
exemplo `REVISAO_HUMANA: ASSINATURAS_AMBIGUAS`):

```json
"alarme": {"regra": "D-C4", "referencia": "2026-11-20T09:00:00.000Z",
  "itens": [{"item": "PENDENCIA_VINCULO", "resultado": "FALHOU", "motivo": "AGUARDANDO_CONFIRMACAO: CRIACAO_NAO_CONFIRMADA", "idadeDias": 3, "aviso": "DIA_3"},
            {"item": "EMPRESA", "resultado": "MUDOU_ATIVA_PARA_EM_ATRASO", "motivo": null, "aviso": "EMPRESA_SEM_IDADE"}]},
"pendentesConhecidos": [{"item": "MARCADOR_REMOCAO", "resultado": "FALHOU", "motivo": "REVISAO_HUMANA: REMOCAO_SEM_CONFIRMACAO", "idadeDias": 2, "proximoAvisoDia": 3}]
```

Os contadores `eventos`, `empresas`, `incompleto` e `divergente` continuam no relatório. Para localizar o item: painel do
desenvolvedor → empresa → Cobrança → Pendências, ou o painel do Asaas.

**Staging inalterado (decisão de implementação):**
- O cron de staging (`simular`/`aplicar`, a cada 5 min) não recebe a leitura de idades: o CLI só a passa quando o alvo é
  de produção, e `codigoDeSaida` com `producao = false` ignora a classificação.
- Lá a saída 2 continua significando "item falho/recusado neste ciclo ou Kidmais violada".
- Motivos para não aplicar a regra em staging:
  - em staging o `aplicar` resolve o que é resolvível;
  - a agenda não é diária, e a regra ancorada às 09:00 não faria sentido;
  - é ambiente de homologação, onde o alarme imediato é o desejado.

**Limites conhecidos:**
- **Recebido entre 09:00 UTC e a consulta:** um item recebido entre as 09:00 UTC e o momento da consulta (segundos ou
  minutos de atraso) é avisado como `NOVO` nessa execução **e** na seguinte. É um aviso a mais, nunca a menos.
- **Execução manual:**
  - antes das 08:00 UTC, usa a referência do dia anterior e repete o veredito de ontem (mais os itens novos);
  - no mesmo dia, repete o veredito do dia.
- **Execução agendada que não acontece** (falha do Render):
  - os avisos daquele dia se perdem;
  - o item continua listado e volta a alarmar no próximo marco;
  - um item que seria `NOVO` alarma no dia seguinte como `DIA_1`.
- **Mudança de agenda (D-C1):** se a agenda mudar (por exemplo, mais frequente), todas as execuções do mesmo dia repetem
  o veredito. Mudar `HORA_CRON_UTC` junto com o YAML; o teste falha se só um mudar.
- **Pendência persistente gera lembretes, não silêncio:** fica em `pendentesConhecidos` todos os dias e alarma nos dias 1,
  3, 7 e depois semanalmente até a ação humana.
- **Empresa divergente persistente** (`SEM_CONFIRMACAO`, `RECUSADA`, `MUDOU_…` sem "Sincronizar") continua alarmando
  **todo dia** até ser resolvida (risco aceito pela falha fechada).

## 6. Roteiro proposto (cada passo com autorização própria)

1. **C1 — criar o cron em `aguardando`** (independe do Asaas):
   - criação **manual** no painel com os campos da seção 2;
   - variáveis 1–6, 8, 9 (conferida no web) e 10 (`ASAAS_AMBIENTE=producao` sozinho não liga nada);
   - **nenhuma das três secretas (7, 11 e 12) é criada em C1** (P3-B3). Por Blueprint, o Render pediria os valores das
     chaves `sync: false`: não usar Blueprint em C1;
   - confirmar no painel o tipo e o custo do plano (P3-B4);
   - notificação ligada; "Trigger run" uma vez → saída 0 e `AGUARDANDO_HABILITACAO`.
2. **C2 — BLOQUEADO** até:
   - ~~a decisão D-C4 (§5a)~~ — **decidida (20/10) e implementada localmente**; falta levar o código à branch `production`
     (PR para `staging`, revisão, promoção para `production`, cada etapa com autorização) e o cron fazer o build dessa
     versão. O build do cron já roda `scripts/assinatura-reconciliar.test.cjs`, onde estão os testes da regra;
   - o web de produção com `ASAAS_AMBIENTE=producao`, chave e token, e o webhook registrado.

   Depois disso:
   - copiar para o cron a 7 (valor da `DATABASE_URL` do web), a 11 e a 12;
   - trocar a 4 para `conferir` (gera build; acompanhar sem deploy duplicado);
   - "Trigger run" → saída 0, `kidmais.violada: false`, `eventos {}`, `empresas {}`, `alarme.itens []` e
     `pendentesConhecidos []`. A presença de `alarme` no log confirma que o build tem a regra D-C4.

   A partir daqui o cron entra no roteiro de rotação ([ROTACAO_CREDENCIAIS_20261007.md](ROTACAO_CREDENCIAIS_20261007.md),
   "Consumidores fora do serviço web").
3. **C3 — antes de `CADASTRO_PUBLICO_ATIVO=true`:** C2 PASS. Depois da primeira venda assistida (P8), a conferência do dia
   seguinte precisa sair 0 **com `pendentesConhecidos` vazio** (com a D-C4, saída 0 sozinha não prova que nada ficou
   pendente).
4. **Recuperação:** voltar a 4 para `aguardando` (no-op), ou suspender o cron. Nenhuma ação grava no banco ou no Asaas.

## 7. Riscos e decisões pendentes de Felipe

- **D-C1 — agenda:** diário às 06:00 BRT (roteiro de 13/10) ou mais frequente nos primeiros dias de venda. O webhook
  continua sendo o caminho principal; a conferência só detecta.
- **D-C2 — plano e custo** do novo cron: o identificador `0.5c-512mb` foi copiado do YAML de staging e não foi verificado
  como valor de Blueprint (P3-B4); confirmar no painel.
- **D-C3 — credencial:** o cron usa a mesma credencial do web (dono do banco). A simulação escreve e desfaz, então um papel
  somente leitura não serve; um papel dedicado não foi preparado. Em C2, a credencial e a chave Asaas de produção passam a
  existir em um segundo serviço (superfície maior).
- **D-C4 — alarme persistente: DECIDIDA por Felipe em 20/10/2026** (alarme por idade, sem estado; §5a) e **implementada
  localmente** (branch `codex/dc4-alarme-cron-20261020`, sem push). Não bloqueia mais C2 como decisão; C2 continua
  dependendo da regra chegar à `production`, do Asaas de produção no web e do roteiro de rotação (P2-B2, já documentado).
  Riscos residuais: empresa divergente persistente alarma todo dia; saída 0 pode conviver com `pendentesConhecidos`.
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
- **D-C4:**
  - Os testes da regra estão em [scripts/assinatura-reconciliar.test.cjs](../scripts/assinatura-reconciliar.test.cjs) e
    rodam no CI (passo acima) e no `buildCommand` dos dois crons, sem mudar nenhum dos dois.
  - Casos cobertos:
    - referência do dia;
    - item novo;
    - dias 1/3/7/14/21 e fora da janela (2, 4, 8, 15);
    - 70 dias de execuções com atrasos variados (cada marco uma vez);
    - idade ausente (alarma);
    - mistura;
    - empresa e erro desta execução;
    - Kidmais violada;
    - staging inalterado;
    - saída sem dados sensíveis;
    - leitura das idades com as mesmas constantes de `lib/assinatura/reconciliacao-contratacao.ts`.
  - [scripts/assinatura-cron-producao-20261020.test.cjs](../scripts/assinatura-cron-producao-20261020.test.cjs) amarra a
    agenda do YAML a `HORA_CRON_UTC`.
  - A consulta `SQL_IDADES_EVENTOS` (somente leitura) não foi executada contra PostgreSQL nesta entrega: só com cliente
    simulado.
