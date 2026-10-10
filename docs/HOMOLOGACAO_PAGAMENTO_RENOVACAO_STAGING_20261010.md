# Homologação consolidada de pagamento e renovação Fundador em staging — rodada 3 (pacote de 10/10/2026)


> **Candidata fixada em 10/10/2026:** código `6acdb60375d43f50a51d169bfad73bc358954b03`. Este pacote está no commit seguinte, que altera só `docs/`; o SHA desse commit é o apresentado no pedido de aprovação e é o único que pode ser usado (`git diff --name-only 6acdb60375d43f50a51d169bfad73bc358954b03 HEAD` deve listar só `docs/`). Qualquer outra diferença: parar.

**Status: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.** Exclusivamente staging (`srv-daif418ae00c73e8k2gg`, `kidmais_staging_1z91`) e Asaas sandbox. Produção não é tocada. Nenhum comando deste pacote foi executado contra banco, Render, Asaas ou serviço de e-mail; só os testes offline e o ESLint locais. Cada passo P1–P4 depende de aprovação explícita de Felipe para a candidata ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)).

**Coordenação:** Felipe pediu para coordenar mudanças em staging durante a homologação D+2. A execução **espera o "pode ir" dele**, numa janela sem testes manuais em staging (ver S3 e o risco da seção [Riscos](#riscos-declarados)).

## Por que consolidar

Pedido de Felipe: consolidar pagamento e renovação numa rodada com três empresas compartilhadas, incluindo mensal e anual, com e-mail SINK e ajuste de vencimento só no Asaas sandbox e só nas assinaturas da própria rodada. Assim **só 3 vagas Fundador ficam `CONFIRMADA` para sempre em staging, em vez de 6** (3 do pagamento + 3 da renovação nos rascunhos separados).

| Rascunho | Situação |
|---|---|
| `scripts/homologacao-pagamento-staging.cjs` (+ teste), rodada 3 de pagamento, flag `--pagamento-rodada-3-autorizada` | **Substituído** por este pacote. Fica no repositório como histórico; não deve ser executado. |
| `scripts/homologacao-renovacao-staging.cjs` (+ teste) e [HOMOLOGACAO_RENOVACAO_STAGING_20261010.md](HOMOLOGACAO_RENOVACAO_STAGING_20261010.md), flag `--renovacao-rodada-1-autorizada` | **Substituído** por este pacote. Fica como histórico (inventário, lacunas G1–G4 e diferença para os 12 meses reais continuam válidos); não deve ser executado. |

Executor novo: `scripts/homologacao-pagamento-renovacao-staging.cjs`, flag única `--pagamento-renovacao-rodada-3-autorizada`, recuperação `--encerrar-pagamento-renovacao-rodada-3-autorizada`, estado `data/homologacao-planos-cotacao-20261010/pagamento-renovacao-rodada-3.json` (`wx`, modo 600). Testes offline: `scripts/homologacao-pagamento-renovacao-staging.test.cjs`.

## Candidata

- **Código: `6acdb60375d43f50a51d169bfad73bc358954b03`** (executor, teste e este pacote sobre a ponta de `origin/staging` vigente na aprovação). O SHA exato é o apresentado no pedido de aprovação e é o único que P1 envia.
- **Pré-requisito G1 na candidata:** `DepsRenovacao.relogioReal?: () => Date`, usado só na janela de 23 h da retentativa do aviso (`(deps.relogioReal?.() ?? deps.agora())`), com as datas de negócio em `agora`. Está sendo implementado em paralelo em `lib/assinatura/renovacao-fundador.ts` (presente na árvore local de 10/10, ainda não commitado). O executor confere G1 na fonte antes de qualquer conexão (`G1_AUSENTE_S1`).
- Diferença para `origin/staging`: este executor, seu teste, este documento e G1 (mais o que a outra frente entregar na mesma candidata, a revisar no diff completo). Se `origin/staging` avançar antes de P1: **não enviar**; integrar sem force, revisar o diff completo, revalidar e reapresentar o SHA.

## Alvo exato

| Item | Valor |
|---|---|
| Workspace Render | `tea-daidbj95efls73d2bcf0` |
| Web staging | `srv-daif418ae00c73e8k2gg`, branch `staging`, auto-deploy OFF (revalidar antes de P1 e P2) |
| Disco | `dsk-daif418ae00c73e8k340` em `/opt/render/project/src/data` |
| Banco | `dpg-daidko3m8hqs73ce4jt0-a` / `kidmais_staging_1z91`, rede privada (`DATABASE_SSL=false`) |
| Asaas | `sandbox` (guarda `ASAAS_AMBIENTE=sandbox`) |
| E-mail | **SINK** no processo do executor; nenhum envio externo |
| Cron staging | `crn-db493i142hec73ahmoe0` — não alterado |
| Produção | não tocada |

## Fixtures (IDs novos; nenhum reaproveitado de rodada anterior)

IDs gerados com `crypto.randomUUID()`. O teste varre todos os arquivos de `scripts/`, `docs/` e `database/` e confirma que nenhum ID, código, e-mail ou marcador aparece em outra rodada (ensaio 3/4/5, planos 1/2, Fundador 2, sonda, rascunhos de pagamento e de renovação, concorrência).

| Fixture | Empresa | Usuário | `codigo` | Tipo | Plano/ciclo | Regular → Fundador (centavos) |
|---|---|---|---|---|---|---|
| F1 | `1d56ada8-d35e-4afd-a2e0-946b8e1bba05` | `aa17eb45-58a3-486c-b711-8e5106104483` | `hml-pr-essencial` | pagante | Essencial **mensal** | 19700 → 11820 |
| F2 | `d4ca9a48-9c7d-4855-9d2f-de498c413e29` | `2f477463-1b40-4738-88cb-71208e0fc230` | `hml-pr-profissional` | pagante | Profissional **anual** | 347000 → 208200 |
| F3 | `5cf7409e-6f99-4350-a816-c6555285ebae` | `71ce36b7-8732-4355-baaa-929975537cd2` | `hml-pr-isenta` | isenta | — | sem vaga |
| F4 | `111866d0-df82-479e-a39d-79c6927aa42e` | `e90a5e92-b091-4c25-bd19-0c024feeac0a` | `hml-pr-teste` | teste (15 dias) | — | sem vaga |
| F5 | `43e76c7e-b628-4d1c-9953-7aa6b72f3f65` | `aed63f4b-2a32-44df-90ab-c10eb2d9c5be` | `hml-pr-premium` | pagante | Premium **mensal** | 59700 → 35820 |

E-mails `hml-pr-<8 primeiros do usuário>@example.invalid`, senhas só em memória, documento sintético único (≠ CNPJ da Kidmais, ≠ beneficiários e documentos de teste existentes). Pagantes com teste encerrado há 1 h; F4 em teste vigente; F3 com isenção. Regras de pagamento (077) só em F4 (PIX à vista 5%) e F5 (8%); F2 sem regra (0%).

### Por que este mapeamento

- **Mensal e anual cobertos** com 3 vagas: dois mensais (o caminho que exige o salto do vencimento) e um anual (sem ajuste: depois do 1º pagamento o próximo vencimento já é a data regular).
- **F1 Essencial mensal — falha de entrega.** É o plano com financeiro bloqueado (matriz de recursos), e o cenário de falha termina em `REVISAO` e geração suspensa sem aumento, sem precisar de cancelamento pela tela. O mais barato fica com o caminho que nunca chega ao preço regular.
- **F2 Profissional anual — resposta perdida no PUT de preço.** O anual chega à data regular sem tocar no vencimento do sandbox, o que isola a prova do PUT único. F2 também é a empresa sem regra de pagamento (0%) da cotação e do contrato.
- **F5 Premium mensal — caminho mensal completo.** Resposta perdida do envio com retentativa pela mesma chave (G1), envio concorrente, espera da última parcela Fundador, salto do vencimento no sandbox, preço regular e cancelamento. Premium também valida "sem teto de pessoas" e o contrato com regra 8%.
- G1 permite colocar a resposta perdida do e-mail e a falha de entrega nas três empresas compartilhadas, **sem 4ª empresa nem 4ª vaga**.
- Janela de navegador: **removida**. Felipe pediu contas sintéticas, e os testes de navegador são preparados à parte para rodar localmente. Esta rodada não vincula nenhuma conta real e não espera sinal de navegador (o teste confirma a ausência de `HML_NAVEGADOR_EMAIL`, vínculo extra e espera).

## Sequência operacional

| # | Operação exata | Efeito | Duração |
|---|---|---|---|
| P1 | Revalidar branch e auto-deploy (Render MCP, leitura); `git push origin <SHA do commit do pacote, informado no pedido>:staging` (fast-forward, sem force). | só repositório | segundos |
| P2 | Shell: `node scripts/configuracao-homologacao-staging.cjs --conferir-restauracao` → `RESTAURADA` (registro: **as duas chaves ausentes**). Render MCP merge de **exatamente duas** chaves: `ASSINATURA_PLANOS_ATIVOS=true` e `COTACAO_PUBLICA_POR_EMPRESA=true` (uma gravação, que dispara um deploy). Acompanhar esse deploy (sem disparar outro); conferir commit LIVE = `6acdb60375d43f50a51d169bfad73bc358954b03`, `/api/health` 200 e, no Shell, `RENDER_GIT_COMMIT` e as duas chaves `true`. | web com a candidata, planos e cotação pública por empresa ligados | ~6 min |
| P3 | Shell: `cd /opt/render/project/src && nohup node --experimental-strip-types scripts/homologacao-pagamento-renovacao-staging.cjs --pagamento-renovacao-rodada-3-autorizada > data/homologacao-planos-cotacao-20261010/pagamento-renovacao-saida.log 2>&1 < /dev/null &` **antes das 20h BRT** (registrar PID; não redeployar). Depois `cat` do log e registro sanitizado em `docs/evidencias/`. | ver [Efeitos](#efeitos-inclusive-permanentes) | ~15–30 min |
| P4 | Painel: remover **as duas** chaves (`ASSINATURA_PLANOS_ATIVOS` e `COTACAO_PUBLICA_POR_EMPRESA`, "Save only"); `trigger_deploy` (ponta da branch conferida antes); `--conferir-restauracao` → `RESTAURADA` (ambas ausentes, como no registro); fechar o Shell. | configuração registrada restaurada | ~6 min |

Interrupção em P3 (deploy externo, queda do Shell, kill): conferir que o PID não está vivo e rodar `node --experimental-strip-types scripts/homologacao-pagamento-renovacao-staging.cjs --encerrar-pagamento-renovacao-rodada-3-autorizada` (mesma trava de alvo, sem exigir as chaves; mesma prova de autoria; idempotente; recusa se a rodada original ainda estiver viva). Depois P4. Pedido: nenhum deploy externo de staging durante P2–P4 (~45 min).

## Execução do executor (P3)

### S1 — antes de qualquer escrita

Guardas do ensaio (`RENDER`, serviço, `KIDMAIS_DEPLOY_ENV=staging`, `ASAAS_AMBIENTE=sandbox`, `ASSINATURA_PLANOS_ATIVOS=true`, host/banco/porta exatos, TLS conforme `DATABASE_SSL`) + `COTACAO_PUBLICA_POR_EMPRESA=true`; **G1 na fonte**; horário < 20h BRT; disco persistente; estado novo (`wx`); identidade do banco (`conferirIdentidade`); schema 074–077 com as duas guardas da 075 habilitadas; fixtures, códigos e e-mails livres; **campanha: ocupadas + 3 ≤ 20, senão S4**; referências Asaas livres das três pagantes; hashes de terceiros e projeção pública da Kidmais registrados.

### Pagamento (das rodadas 1–3 de planos/pagamento)

| Item | Esperado (divergência = S2) |
|---|---|
| Oferta (`GET /api/admin/assinatura`) | `habilitado`, `fundador` true, `aguardandoVaga` false; regular e Fundador = tabela (mensal: `mensalRegular`/`mensal`; anual: `anualRegular`/`anual`) |
| Checkout (`POST …/assinatura/checkout`, ciclo da fixture, valor Fundador) | 200; vaga `RESERVADA`; assinatura sandbox da referência com valor Fundador e ciclo `MONTHLY`/`YEARLY`; 1 cobrança `PENDING`, valor Fundador, vencimento hoje (BRT) |
| Webhook Asaas | reutiliza o existente se houver um só e válido; senão cria um com nome próprio (`Kidmais staging ensaio hml-pr-r3`), removido no encerramento |
| Pagamento | `intencaoPagamento` gravada **antes** de `POST /sandbox/payment/{id}/confirm`; callback `PAYMENT_RECEIVED/CONFIRMED` `PROCESSADO` para a empresa em até 3 min (senão S4) |
| Benefício (SQL exato) | vaga `CONFIRMADA` com o pagamento; `beneficio_fim = (confirmada_em em UTC + 12 meses)`; vigente > 364 dias; contratação `CONFIRMADA`, atual, ciclo certo, desconto 40, regular e final = tabela, ligada ao pagamento; assinatura `ATIVA` |
| Acesso e limites | acesso `COMPLETO`; plano certo; pessoas 3 / 10 / sem teto |
| Campanha | ocupadas e confirmadas = antes + 3 |
| Financeiro | F1 (Essencial): contas a pagar, criação, fluxo e relatórios 403 `RECURSO_FORA_DO_PLANO`, nada gravado; F2, F5, F3 (isenta), F4 (teste): 200 e 1 conta gravada; contas a receber 200 para todas; menu/visão/painel coerentes; sessão de F1 não lê F2 |
| Cotação pública por empresa | F2 e F5 com páginas e pacotes 200; F4 pacotes 200; Essencial, inexistente, formato inválido e PDF 404 `COTACAO_PUBLICA_INDISPONIVEL`; agenda sem overrides; cotação F2 = 150000 (valor calculado aqui, independente) |
| Contratos gerados pela API da empresa | F2 sem regra **0% → 150000**; F4 **5% → 142500**; F5 **8% → 138000**; legado Kidmais 10% (135000) intacto na regra `kidmais` |
| Identidade/CPF | CPF do cliente de F2: `CLIENTE_EXISTENTE` só em F2; `NOVO_CLIENTE` em F4 e no endereço atual; F4 cadastra o mesmo CPF no próprio escopo; cliente existente com prova inválida recusado sem gravar; página sem logo da Kidmais |

### Renovação nas mesmas três pagantes

Tempo acelerado só no `agora` injetado em `processarRenovacao` (relógio real + N dias inteiros), com `relogioReal` = relógio verdadeiro (G1). O executor chama o processador **só** para F1, F2 e F5: repositório e provedor passam por uma allow-list que recusa qualquer outra empresa (inclusive F3, F4 e a Kidmais) e qualquer assinatura que não seja a criada pelo checkout da fixture, **antes** da rede (S3). Nunca usa `empresasParaRenovacao`, o cron ou `assinatura-renovar*`.

| Rodada | Instante | F1 Essencial mensal | F2 Profissional anual | F5 Premium mensal |
|---|---|---|---|---|
| R0, R0B | real | `AGUARDANDO_AVISO`; registro `PENDENTE` persistido uma vez (repetição idempotente) | idem | idem |
| R1 | véspera do limite | `AGUARDANDO_AVISO`, nada enviado | idem | idem |
| R2 | limite | transporte falha antes de entregar → `ENVIO_INCERTO` (`AVISANDO`) | envio SINK; PUT de preço aplicado e resposta perdida → `ERRO_REPROCESSAVEL` (`APLICANDO`) | SINK entrega e perde a resposta → `ENVIO_INCERTO` (`AVISANDO`) |
| R3 | F1: dia seguinte; demais: limite | `JANELA_AVISO_PERDIDA` (`REVISAO`) | `REGULAR` **sem 2º PUT** | **duas execuções simultâneas**: uma retenta com a mesma chave (dentro das 23 h reais, G1), a outra não envia → `AGUARDANDO_ULTIMA_PARCELA`; valor Fundador |
| salto | — | `nextDueDate` → data regular (sandbox) | — | `nextDueDate` → data regular (sandbox) |
| R4, R5 | limite | geração suspensa (`INACTIVE`), valor Fundador; R5 aceita `REVISAO_NECESSARIA` se o cron sincronizar antes | `REGULAR` | `REGULAR` (1 PUT; parcela já gerada na data regular corrigida) |
| cancelamento | — | não cancelada pela tela (sai no encerramento) | reautenticação + `POST /api/admin/assinatura/cancelamento`; acesso `COMPLETO` (período pago); 1ª cobrança continua paga | idem |
| R6 | real | — | `CANCELADA` | `CANCELADA` |

Também conferidos: registro em `assinatura_renovacoes` depois de R0/R2/R3/R5/R6 (estado, enviado, aplicado, tentado, erro, data regular calculada aqui de forma independente, destinatário = e-mail sintético da fixture, chave `kidmais-renovacao/<id>`, um registro por empresa); **aviso na tela** (`data.renovacao` de `GET /api/admin/assinatura`) depois de R0/R3/R5/R6; sessão de F5 não lê a renovação anual de F2; no Asaas, 1ª cobrança paga com valor Fundador, nada regular antes da data regular e nada Fundador a partir dela (F2, F5); PUT de preço = 1 em F2 e F5 e 0 em F1; uma suspensão só em F1; **e-mails: tentativas F1 1 / F2 1 / F5 2; e-mails distintos entregues ao SINK F1 0 / F2 1 / F5 1**; mesmo dia BRT do início ao fim.

### E-mail: só SINK

`MODO_EMAIL = 'SINK'` sem alternativa no código: o executor não importa o transporte de e-mail do produto, não lê `EMAIL_PROVIDER`/chaves e não tem URL de provedor. O SINK reproduz a idempotência do provedor (mesma chave → mesmo id `sink-…`, sem segunda entrega) e só aceita a mensagem congelada da própria fixture (`@example.invalid`, chave `kidmais-renovacao/<uuid>`). O id sintético fica gravado como `aviso_id_externo`.

### Ajuste de vencimento: só sandbox, só assinaturas da rodada

Só F1 e F5 (mensais). O PUT `/subscriptions/{id}` (`nextDueDate` = primeira data regular, `updatePendingPayments:false`) só sai de uma função que exige: id gravado no estado da rodada e vinculado à empresa no checkout; releitura com mesma referência, cliente, `MONTHLY`, `ACTIVE`, valor Fundador e vencimento ainda anterior à data regular. O estado de antes (`antes`, `alvo`) é gravado **antes** do PUT. A API genérica do executor não alcança `/subscriptions`. Anual nunca é ajustado.

## Encerramento (sempre: sucesso, falha, parada, recuperação)

Nunca lança; o erro original prevalece. Nunca apaga linha. Só atua sobre o que tem prova de autoria (S1 livre + intenção gravada antes da criação).

1. **Assinaturas sandbox** (por pagante com prova): ids do estado ou, se a interrupção ocorreu antes de salvá-los, da linha da fixture (estado e banco divergentes → para); listagem da referência (no máximo 1, mesma referência, cliente e id; colisão → não toca); remove as não removidas; **prova = releitura por id** (404 ou `deleted=true`), porque a listagem omite itens removidos ([sonda de 10/10](evidencias/sonda-cobranca-removida-asaas-20261010.md)). Remover a assinatura **mantém as cobranças pagas** (pagas por definição).
2. **Webhook**: só o criado pela rodada (nome e URL conferidos); o reutilizado nunca é tocado.
3. **Banco** (uma transação): usuários inativos (id + e-mail), vínculos revogados, empresas `DESATIVADA` (id + código + nome).
4. **Vagas e contratações: nunca escritas pelo executor.** Vaga `CONFIRMADA` é permanente (074). Se a rodada parar entre checkout e pagamento, a vaga fica `RESERVADA` e o encerramento termina `INCOMPLETO` com `VAGA_RESERVADA_SEM_LIBERACAO` (assinatura removida, nada pago); a liberação exige decisão própria (por exemplo, a regra comprovada da rodada Fundador 2, em outra autorização).
5. Depois: campanha = antes + 3 (ocupadas e confirmadas) e hash de terceiros idêntico ao de antes; divergência = `INCOMPLETO`.

## Efeitos (inclusive permanentes)

- **3 vagas Fundador de staging `CONFIRMADA` para sempre** (F1, F2, F5; a 074 não as devolve). Pela última evidência ([rodada Fundador 2](evidencias/homologacao-fundador-staging-rodada2-20261010.md)), a campanha passa de **3 ocupadas / 2 confirmadas para 6 / 5**, se nada mudar antes; restam 14 livres. S1 revalida e registra antes/depois.
- **3 contratações `CONFIRMADA`** ligadas às cobranças pagas no sandbox (benefício até confirmação + 12 meses).
- **3 registros em `assinatura_renovacoes`** que a 075 não deixa apagar: F1 `REVISAO` (`JANELA_AVISO_PERDIDA`, sem aviso enviado), F2 e F5 `CANCELADA` (aviso com id sintético `sink-…`, preço aplicado).
- Fixtures desativadas como histórico: 5 empresas `DESATIVADA`, 5 usuários inativos, vínculos revogados; 3 assinaturas locais (pagantes) + 1 em teste, 1 isenção, 2 regras de pagamento (F4, F5), 4 pacotes, 3 fechamentos e 3 contratos (F2, F4, F5), 3 clientes sintéticos, 5 categorias e 4 contas a pagar sintéticas, eventos de cobrança e auditoria das fixtures.
- Asaas sandbox: 3 clientes; 3 assinaturas removidas; **3 cobranças fictícias pagas (permanecem pagas)**; parcelas pendentes geradas saem com a assinatura; webhook criado pela rodada removido (se não havia um reutilizável).
- E-mail: **nenhum enviado**.
- Durante a rodada, o cron de reconciliação (inalterado) também sincroniza as fixtures: comportamento normal do produto.

## Custos

- Dinheiro: nenhum. Cobranças e pagamentos são fictícios no Asaas sandbox; nenhum envio de e-mail.
- Render: 2 deploys de staging (P2 e P4, ~6 min cada) nos minutos de build normais do plano; nenhum recurso novo.
- Tempo: ~45–60 min de janela (P2–P4), com P3 de ~15–30 min (callbacks até 3 min cada no pior caso).
- Campanha de staging: 3 das 20 vagas consumidas para sempre (o custo que a consolidação reduz de 6 para 3).

## Critérios de parada

- **S1**: alvo, conexão, disco, schema 074–077, guardas 075, **G1 ausente**, horário ≥ 20h BRT, fixture/código/e-mail existente, referência Asaas ocupada, estado de rodada presente, chave ausente.
- **S2**: qualquer item da matriz; troca do dia BRT durante a rodada; janela acelerada inválida.
- **S3**: chamada fora das pagantes/assinaturas da rodada, salto recusado, terceiros (empresas, vínculos, assinaturas, contratações, **vagas**, isenções, **renovações**, clientes, fechamentos, pacotes, categorias, contas a pagar, **regras de pagamento**) ou endereço público da Kidmais alterados.
- **S4**: menos de 3 vagas livres; callback do pagamento não processado em 3 min.
- **S5**: build/health com falha em P2/P4; `--conferir-restauracao` divergente.

## Riscos declarados

- **Atividade da homologação D+2 em staging durante P3** muda os hashes de terceiros (empresas, clientes, fechamentos…) ou a campanha e para a rodada em S3 — possivelmente **depois** de vagas já confirmadas, ou seja, vagas consumidas sem a evidência completa. Mitigação: executar só na janela combinada com Felipe, sem testes manuais em staging.
- **Parada entre checkout e pagamento** deixa vaga `RESERVADA` (não liberada por este executor). Mitigação: encerramento reporta; liberação com decisão própria.
- **Asaas sandbox** pode gerar a parcela do mês 2 antes do salto; ela fica com valor Fundador (anterior à data regular) e sai com a assinatura. Parcela já gerada na data regular é corrigida pelo processador.

## Recuperação

- Código: `git revert` em `staging` (só script, teste e documento; G1 é revertido na própria frente).
- Configuração: P4 (as duas chaves removidas; `--conferir-restauracao` → `RESTAURADA`, ambas ausentes como no registro).
- Provedor e fixtures: o encerramento automático ou `--encerrar-pagamento-renovacao-rodada-3-autorizada` repete a remoção comprovada, a remoção do webhook criado e a desativação; pode rodar mais de uma vez.
- **Sem rollback**: vagas `CONFIRMADA`, contratações `CONFIRMADA`, registros de renovação (074/075) e cobranças pagas no sandbox.

## O que esta rodada não comprova

1. Recebimento do e-mail na caixa (SINK) e falhas após aceitação pelo provedor (bounce/reclamação): o webhook do provedor de e-mail (G3) está sendo implementado em outra frente e **não** é exercido aqui.
2. A rotina periódica de renovação (G2, entrada restrita em outra frente) e o painel de revisão (G4): o executor chama o processador diretamente, uma empresa por vez.
3. A geração e a cobrança real da primeira parcela regular na data real; as parcelas mensais 2–12 do Fundador (substituídas pelo salto no sandbox, com a espera comprovada antes).
4. As datas gravadas pelo banco (`aviso_tentado_em`, `aviso_enviado_em`, `preco_aplicado_em`) são reais (~335 dias antes do limite), não a data do limite.
5. A borda UTC do benefício (confirmação após 21h BRT gera o 13º vencimento mensal): só teste offline; a rodada começa antes das 20h.
6. Interface no navegador (testes locais à parte), produção, cancelamento anual no fim real do período, concorrência processador × webhook além da trava por empresa.

## Decisões pedidas a Felipe

- **D1** — aceitar 3 vagas permanentes (em vez de 6) e o mapeamento F1 Essencial mensal / F2 Profissional anual / F5 Premium mensal.
- **D2** — janela de execução fora da atividade D+2 (S3) e "pode ir" explícito para P1–P4 da `6acdb60375d43f50a51d169bfad73bc358954b03`.
- **D3** — salto do vencimento só nas assinaturas sandbox mensais da rodada (F1, F5), como descrito.
- **D4** — F1 fica em `assinatura_renovacoes` como `REVISAO` permanente (empresa desativada, assinatura removida). Pela decisão de Felipe, o alerta do painel do desenvolvedor (G4) continua visível, marcado como INFO “(fixture de homologação, desativada)” e listado depois das empresas reais.

## Validação local (candidata)

| Validação | Resultado |
|---|---|
| `node --experimental-strip-types --test scripts/homologacao-pagamento-renovacao-staging.test.cjs` | **20/20**: flags e processo real (sem flag, fora do Render, recuperação sem disco); guardas com as duas chaves; fixtures inéditas contra todos os scripts/docs/migrations; preços e regras independentes (anual = 10 × mensal, 40%, 0/5/8% ≠ 10%); campanha; detecção de G1 e ordem (antes do estado/banco); calendário = processador do produto; allow-list antes da rede (Kidmais, isenta, teste, outra rodada, outra assinatura); SINK (idempotência, falha, resposta perdida, destino recusado; sem transporte real na fonte); salto restrito (10 recusas sem PUT, prova antes do PUT); **matriz R0–R6 com o `processarRenovacao` do produto** (lib atual com G1 e contrato G1 emulado sobre a lib sem G1); lacuna sem G1; telas/registros; encerramento com fakes (sem prova, após pagamento, antes do pagamento com vaga reservada, colisão, remoção não comprovada, banco divergente/indisponível/falho, webhook reutilizado × criado, idempotência); varredura da fonte (sem DELETE/TRUNCATE, sem escrita em vagas/contratações/renovações, UPDATE só por ID das fixtures, provas antes de cada efeito, sem navegador, 6 saídas). |
| `npx eslint` nos dois arquivos | 0 erros, 0 avisos |

Node local 24.20.0 (`--experimental-strip-types`). TypeScript e build não se aplicam a estes arquivos (nenhum arquivo do produto foi alterado por este pacote).
