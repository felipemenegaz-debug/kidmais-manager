# Homologação da renovação Fundador em staging — Etapa 5 (pacote de 10/10/2026)

**Status: SUBSTITUÍDO — não executar.** Consolidado em [HOMOLOGACAO_PAGAMENTO_RENOVACAO_STAGING_20261010.md](HOMOLOGACAO_PAGAMENTO_RENOVACAO_STAGING_20261010.md) (três empresas compartilhadas; o script deste rascunho recusa qualquer flag com `RASCUNHO_SUBSTITUIDO`). Mantido como histórico do diagnóstico.

~~Status anterior: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.~~ Exclusivamente staging (`srv-daif418ae00c73e8k2gg`, `kidmais_staging_1z91`) e Asaas sandbox. Produção não é tocada. Nenhum comando deste pacote foi executado contra banco, Render, Asaas ou Resend; só os testes offline e o ESLint locais. Cada passo P1–P4 depende de aprovação explícita de Felipe para a candidata ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)).

Decisão vigente: Fundador = 40% por 12 meses; depois, preço regular, com aviso **30 dias antes por e-mail e no sistema**.

## O que já existe (inventário conferido no código)

| Peça | Arquivo | Comportamento relevante |
|---|---|---|
| Processador | `lib/assinatura/renovacao-fundador.ts` → `processarRenovacao(empresaId, deps)` | Uma empresa por chamada, sob `deps.travar` (trava por empresa da contratação). `deps.agora` é injetável; `deps.simular` desliga escritas. |
| Persistência | `lib/assinatura/renovacao-repositorio.ts` | `ler` só acha contratação **e vaga Fundador `CONFIRMADA`**; `criar` com `ON CONFLICT (contratacao_id) DO NOTHING`; `marcar` grava `aviso_tentado_em`, `aviso_enviado_em` e `preco_aplicado_em` com `clock_timestamp()` (relógio do banco). `consultarRenovacao` é o DTO da tela (`estado`, `dataRegular`, `valorRegular`, `avisoEnviado`, `ciclo`), servido em `GET /api/admin/assinatura` → `data.renovacao`. `empresasParaRenovacao` lista **todas** as empresas com Fundador confirmado. |
| Schema | `database/migrations/20261009_075_renovacao_fundador.sql` | Um registro por contratação; mensagem, destinatário e datas imutáveis; estados `PENDENTE → AVISANDO → AVISADA → APLICANDO → REGULAR`, `REVISAO`, `CANCELADA`; sem DELETE/TRUNCATE; CHECK: dia de `aviso_enviado_em` (America/Sao_Paulo) ≤ primeira data regular − 30. |
| Vigência | `database/migrations/20261009_074a_planos_comerciais.sql` | O gatilho fixa `beneficio_fim = confirmada_em + 12 meses` na confirmação; vaga confirmada nunca muda nem volta a `LIBERADA`. A confirmação do produto (`confirmarOfertaPaga`, `lib/assinatura/ofertas.ts`) usa `clock_timestamp()`. |
| Executável | `scripts/assinatura-renovar.cjs` | Percorre `empresasParaRenovacao` com relógio real; `--aplicar` só em banco local e e-mail em arquivo. **Não serve para staging.** |
| Cron | `scripts/assinatura-cron.cjs` | Executa só a reconciliação de cobrança. **Não executa a renovação.** |

### Aviso: persistência, chave e envio único

1. Primeira execução após a confirmação: lê a 1ª cobrança no Asaas (paga, valor Fundador), calcula a primeira data regular (mensal: 1º vencimento mensal ≥ fim do benefício; anual: 1º vencimento + 12 meses), monta a mensagem e grava o registro `PENDENTE` **antes** de qualquer envio. Chave de idempotência: `kidmais-renovacao/<id do registro>` (CHECK da 075).
2. Antes do limite (primeira data regular − 30 dias): `AGUARDANDO_AVISO`, sem consultar o provedor.
3. No dia do limite: grava `AVISANDO` com `aviso_tentado_em`, envia a mensagem congelada com `Idempotency-Key`, e só com identificador externo grava `AVISADA`. Falha → `ENVIO_INCERTO` (continua `AVISANDO`). Retentativa só com menos de 23 h desde a tentativa (retenção de 24 h do Resend); depois disso, ou após o dia do limite, vai para `REVISAO` sem retry cego.
4. Repetição/concorrência: a trava por empresa serializa; com `aviso_enviado_em` gravado não há segundo envio.

### Troca para o preço regular

Depois do aviso, o processador espera o próximo vencimento do Asaas alcançar a primeira data regular (`AGUARDANDO_ULTIMA_PARCELA` enquanto não alcança e o valor ainda é o Fundador). Então grava `APLICANDO`, faz `atualizarValorAssinatura` (PUT `value`, `updatePendingPayments:false`), corrige com `atualizarValorCobranca` só as parcelas já geradas a partir da data regular e ainda pendentes, relê assinatura e parcelas e grava `REGULAR`. Resposta perdida: a releitura do valor evita PUT repetido. Sem aviso válido (`REVISAO`), quando a próxima parcela já seria regular, suspende a geração (`INACTIVE`) em vez de aumentar.

## Desenho do ensaio acelerado

**Por que não retrodatar.** `beneficio_fim` vem do gatilho a partir de `confirmada_em`, que o produto grava com o relógio do banco; depois da confirmação a 074 proíbe alterar a vaga. Retrodatar exigiria o executor confirmar contrato e vaga por SQL próprio, fora do fluxo do produto. Recusado: nenhuma linha comercial é confirmada fora do fluxo do produto, e nenhum relógio é alterado.

**Como o tempo é acelerado.** Só dentro do processo do executor: `processarRenovacao` recebe `agora = relógio real + N dias inteiros`, e o executor só o chama para as três fixtures (wrappers recusam qualquer outra empresa ou assinatura antes da rede, parada S3). Banco, sistema e contratos existentes ficam no tempo real. O CHECK da 075 continua valendo: o aviso é gravado na data real, que é anterior ao limite.

**Mensal.** No tempo real, o próximo vencimento do Asaas só chega à data regular depois de 11 parcelas. O executor primeiro comprova `AGUARDANDO_ULTIMA_PARCELA` (nenhum aumento antecipado). Depois ajusta **só nas assinaturas sandbox das fixtures RM e RF** o `nextDueDate` para a primeira data regular (PUT no sandbox, referência conferida). **Anual:** sem ajuste; depois do 1º pagamento, o próximo vencimento já é a data regular.

## Fixtures (IDs novos, nenhum reaproveitado)

| Fixture | Empresa | Usuário | `codigo` | Plano/ciclo | Regular → Fundador (centavos) | Cenário |
|---|---|---|---|---|---|---|
| RM | `69faef84-c063-4fb5-8f33-21e49ae673c5` | `0547c356-9f39-4168-9baa-249c65c963e2` | `hml-renovacao-mensal` | Essencial mensal | 19700 → 11820 | mensal completo, envio concorrente, preço regular |
| RA | `ff87dacc-0447-448e-a38e-152a9d9e98ff` | `f9934bf9-1f44-4222-9075-defb77c598af` | `hml-renovacao-anual` | Essencial anual | 197000 → 118200 | anual, resposta perdida no PUT de preço |
| RF | `5fd21aee-fbd6-45d3-8dc9-c169f93728cf` | `eaaf6c32-0eff-4c45-a145-52540632387a` | `hml-renovacao-falha` | Profissional mensal | 34700 → 20820 | falha de entrega → revisão → geração suspensa sem aumento |

As empresas têm teste de 15 dias encerrado há 1 h, documento sintético único (diferente do CNPJ da Kidmais e dos documentos já usados), e-mail `hml-renovacao-<id>@example.invalid` e senha só em memória. Estado da rodada em `data/homologacao-renovacao-20261010/renovacao-rodada-1.json` (`wx`, modo 600).

## Execução do executor (P3)

1. **S1**: confere alvo (`alvoEnsaio` + `conferirIdentidade` + `exigirDisco`), schema 074/075 e as duas guardas 075, horário anterior às 22h BRT (sem virada de dia), fixtures, códigos e e-mails livres, referências Asaas livres e ao menos 3 vagas livres (S4). Também registra os hashes de terceiros e do endereço público da Kidmais.
2. **Fixtures** numa transação.
3. **Contratação pelo produto**, por fixture: login, oferta (`fundador` true; preços da tabela), `intencaoCheckout` gravada antes do checkout, checkout pela API, uma assinatura e uma cobrança `PENDING` com valor Fundador e vencimento hoje. Depois grava `intencaoPagamento`, confirma no sandbox (`POST /sandbox/payment/{id}/confirm`, como na rodada 5) e entrega `PAYMENT_CONFIRMED` à rota `/api/integracoes/asaas/webhook` com o token configurado; o produto relê o Asaas. Exige contratação, vaga `CONFIRMADA` e assinatura `ATIVA`. Campanha: confirmadas +3, ocupadas +3.
4. **Processador, só fixtures** (resultado divergente = S2):

| Rodada | Instante (por fixture) | RM | RA | RF |
|---|---|---|---|---|
| R0, R0B | real | `AGUARDANDO_AVISO` (registro `PENDENTE` persistido; repetição não duplica) | idem | idem |
| R1 | véspera do limite | `AGUARDANDO_AVISO`, nada enviado | idem | idem |
| R2 | limite | 2 execuções simultâneas → 1 envio; `AGUARDANDO_ULTIMA_PARCELA` | envio; PUT aplicado e resposta perdida → `ERRO_REPROCESSAVEL` (`APLICANDO`) | transporte falha antes da rede → `ENVIO_INCERTO` |
| R3 | limite (RF: dia seguinte) | `AGUARDANDO_ULTIMA_PARCELA`, valor Fundador | `REGULAR` sem 2º PUT | `JANELA_AVISO_PERDIDA` (`REVISAO`) |
| salto | — | `nextDueDate` = data regular | — | `nextDueDate` = data regular |
| R4, R5 | limite | `REGULAR` (1 PUT; parcelas da data regular corrigidas) | `REGULAR` | geração `INACTIVE`, valor Fundador (R5 aceita `REVISAO_NECESSARIA` se o cron sincronizar antes) |
| cancelamento | — | reautenticação + `POST /api/admin/assinatura/cancelamento`; acesso `COMPLETO` (período pago) | idem | não cancelada pela tela (sai no encerramento) |
| R6 | real | `CANCELADA` | `CANCELADA` | — |

Também conferidos: registro persistido depois de R0/R2/R3/R5/R6 (estado, enviado, aplicado, erro, data regular calculada de forma independente, destinatário e chave); DTO da tela depois de R0/R3/R5/R6; sessão de RM não lê a renovação de RA; no Asaas, 1ª cobrança paga com valor Fundador, nada regular antes da data regular e nada Fundador a partir dela; PUT de preço = 1 em RM e RA e 0 em RF; uma suspensão em RF; envios por fixture = 1 (RF: uma tentativa sem rede); escopo restrito às 3 empresas; terceiros (empresas, vínculos, assinaturas, contratações, vagas, isenções, **renovações**, clientes, fechamentos, pacotes) e Kidmais idênticos.

5. **Encerramento** (sempre: sucesso, falha, recuperação; nunca lança; nunca apaga linha). Só atua sobre o que tem prova de autoria (S1 livre + intenção gravada antes da criação). Por fixture: lista a assinatura da referência (no máximo 1, mesma referência, cliente e id) e a remove no sandbox.
   - **Sem `intencaoPagamento`**: regra da rodada Fundador. Pagamento conhecido bloqueia; exige prova de cobrança removida e não paga; então cancela a contratação aberta e libera a vaga `RESERVADA`.
   - **Com `intencaoPagamento`**: a vaga nunca é tocada; prova = assinatura relida removida.

   Depois, numa transação: usuários desativados com o e-mail trocado por `…-encerrado@example.invalid` (por id + e-mail), vínculos revogados, empresas `DESATIVADA` (por id + código + nome).

## Sequência operacional (mesma estrutura da rodada Fundador)

| # | Operação exata | Efeito | Duração |
|---|---|---|---|
| P1 | Revalidar branch e auto-deploy; `git push origin <candidata>:staging` (fast-forward, sem force). Se `origin/staging` avançar: não enviar, integrar, revisar e reapresentar o SHA. | só repositório | segundos |
| P2 | Shell: `node scripts/configuracao-homologacao-staging.cjs --conferir-restauracao` → `RESTAURADA`. Render MCP merge **só** `ASSINATURA_PLANOS_ATIVOS=true`; acompanhar o deploy disparado (sem disparar outro); conferir commit LIVE, `/api/health` 200, `RENDER_GIT_COMMIT`. | web com a candidata e planos ligados | ~6 min |
| P3 | Shell: `cd /opt/render/project/src && nohup node --experimental-strip-types scripts/homologacao-renovacao-staging.cjs --renovacao-rodada-1-autorizada > data/homologacao-renovacao-20261010/renovacao-saida.log 2>&1 < /dev/null &` (registrar PID; não redeployar). Depois `cat` do log e registro sanitizado em `docs/evidencias/`. | ver Efeitos | ~10–20 min |
| P4 | Remover `ASSINATURA_PLANOS_ATIVOS` (“Save only”); `trigger_deploy` (ponta conferida); `--conferir-restauracao` → `RESTAURADA`; fechar o Shell. | configuração registrada | ~6 min |

Interrupção em P3: conferir que o PID não está vivo e rodar `node --experimental-strip-types scripts/homologacao-renovacao-staging.cjs --encerrar-renovacao-rodada-1-autorizada` (mesma trava e mesma prova, idempotente). Depois P4. Pedido: nenhum deploy externo de staging durante P2–P4.

## Efeitos (inclusive permanentes)

- **Três vagas Fundador de staging ficam `CONFIRMADA` para sempre** (a 074 não as devolve). Pela última evidência (10/10), a campanha passa de 3 ocupadas/2 confirmadas para 6/5; restam 14 livres. S1 revalida. Outras rodadas pagas preparadas em paralelo devem caber no mesmo orçamento de vagas.
- Permanecem como histórico: 3 contratações `CONFIRMADA`; 3 registros em `assinatura_renovacoes` (RM e RA `CANCELADA`; RF `REVISAO`), que a 075 não deixa apagar; 3 empresas desativadas; 3 usuários inativos com e-mail-marcador; eventos e auditoria de cobrança das fixtures.
- Asaas sandbox: 3 clientes (`notificationDisabled`); 3 assinaturas removidas; 3 cobranças fictícias pagas no sandbox (permanecem pagas por definição); 1 parcela regular pendente gerada pode existir até a remoção.
- E-mail: com `MODO_EMAIL='SINK'` (padrão da candidata), **nenhum e-mail é enviado**: o transporte devolve id sintético `sink-…`, gravado como `aviso_id_externo`. Ver D2.
- Durante ~20 min, o cron de reconciliação (inalterado) também sincroniza as fixtures; isso é comportamento normal do produto.

## Decisões pedidas a Felipe antes da aprovação

- **D1 — vagas.** Aceitar consumir **3** vagas de staging de forma permanente. Alternativas: retirar RF (2 vagas; falha de entrega e suspensão ficam só nos testes offline), ou aplicar antes a mudança G1 (abaixo), o que permitiria testar a falha e a retentativa numa mesma fixture. Sem vaga confirmada o processador não roda (`ler` exige `CONFIRMADA`).
- **D2 — e-mail.** `SINK` (recomendado para esta rodada): o fluxo persistido é homologado com transporte sintético; o transporte Resend real com o mesmo modelo e a mesma chave já está comprovado ([envio de 10/10](AVISO_EMAIL_SHELL_STAGING_20261009.md), replay com o mesmo id, recebimento confirmado por Felipe). `RESEND` (nova candidata trocando a constante): só RM envia, só para `felipemenegaz@gmail.com`, uma requisição no máximo, remetente de teste. Exige: (a) esse endereço livre entre os usuários de staging (senão S1 para); (b) `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` e `EMAIL_REMETENTE` de teste **no web** staging, sem alterar env nesta autorização (o envio de 10/10 usou o cron); (c) aceitar que a mensagem é o modelo real, sem o marcador “[TESTE]”, porque o payload congelado não pode ser alterado; (d) o e-mail da fixture é trocado pelo marcador no encerramento, liberando o endereço.
- **D3 — salto do vencimento** nas assinaturas sandbox mensais das fixtures (RM, RF), descrito acima.

## Critérios de parada

- **S1**: alvo, conexão, disco, schema 074/075, guardas 075, horário, fixture/código/e-mail existente, referência Asaas ocupada, estado de rodada presente, configuração de e-mail (no modo RESEND).
- **S2**: qualquer item da matriz, troca do dia BRT durante a rodada, janela acelerada inválida (limite não futuro).
- **S3**: chamada fora das fixtures, terceiros ou Kidmais alterados.
- **S4**: menos de 3 vagas livres.
- **S5**: build/health com falha em P2/P4; `--conferir-restauracao` divergente.

## Recuperação

- Código: `git revert` em `staging` (só script, teste e documento).
- Configuração: P4.
- Provedor e fixtures: o encerramento automático ou `--encerrar-renovacao-rodada-1-autorizada` repete a remoção comprovada e a desativação.
- Vagas confirmadas e registros de renovação **não têm rollback** (074/075). Vaga reservada sem prova de remoção fica reservada e é reportada; liberação só com decisão própria.

## Diferença declarada para os 12 meses reais

1. O tempo é acelerado só no `agora` do processador. As datas gravadas pelo banco (`aviso_tentado_em`, `aviso_enviado_em`, `preco_aplicado_em`) são reais (~335 dias antes do limite), não a data do limite.
2. Mensal: as parcelas 2–12 do Fundador não são geradas; o próximo vencimento é ajustado no sandbox. A espera por elas (`AGUARDANDO_ULTIMA_PARCELA`) é comprovada antes do ajuste.
3. Não se observa a geração nem o pagamento da primeira cobrança regular na data real. Comprova-se a assinatura com valor regular e próximo vencimento na data regular, além das parcelas já geradas corrigidas.
4. O evento de pagamento é entregue pelo executor à rota do webhook; o produto relê o Asaas, como na rodada 5; o ensaio não depende de webhook configurado no Asaas.
5. A rotina periódica não é exercida: o executor chama o processador diretamente, uma fixture por vez. O cron de reconciliação saudável não comprova a renovação.
6. A borda UTC do benefício (confirmação após 21h BRT gera o 13º vencimento mensal) é coberta só por teste offline; a rodada roda antes das 22h.
7. Asaas sandbox, não produção. E-mail sintético no modo `SINK`.

## Lacunas no código do produto

- **G1 (bloqueia parte do ensaio acelerado, não a produção).** A regra das 23 h compara `deps.agora()` com `aviso_tentado_em` gravado pelo relógio do banco. Com o relógio deslocado, toda retentativa de envio cai em `ENVIO_INCERTO_FORA_JANELA`; por isso “resposta perdida/retentativa” do e-mail não é homologável no fluxo persistido acelerado (teste offline “lacuna G1”). Mudança mínima: `DepsRenovacao` ganha um `relogioReal?: () => Date` (padrão `deps.agora`), usado só no cálculo das 23 h, ou `repositorio.ler` devolve `clock_timestamp()` do banco. Com ela, RF pode ser fundida em RA (D1: 2 vagas).
- **G2 (bloqueia ativar rotina geral).** `assinatura-renovar.cjs --aplicar` só aceita banco local e e-mail em arquivo, e processa todas as empresas de `empresasParaRenovacao`, sem lista de empresas permitidas, sem modo staging/sandbox com Resend e sem saída de observabilidade além dos contadores. O cron não chama a renovação. Antes de ativar: entrada própria do cron (sandbox/staging) com allowlist opcional, contadores por resultado, alerta para `REVISAO`/`ERRO`/`INCERTO` e homologação dessa entrada. Fora do escopo desta rodada; regra mantida: a rotina geral só é ativada depois de homologar processador, idempotência, observabilidade e recuperação.
- **G3 (falhas de entrega após aceitação).** O produto só sabe que o Resend aceitou o envio. Bounce ou reclamação não são registrados, e o aviso fica `AVISADA`. “Falha de entrega” homologável = falha no envio → `ENVIO_INCERTO` → `REVISAO` → nenhum aumento. Mudança mínima: rota de webhook do Resend (assinatura verificada) que move `AVISADA → REVISAO` com `ultimo_erro='ENTREGA_RECUSADA'` (transição já permitida pela 075) antes do PUT de preço.
- **G4 (observabilidade).** Nenhum painel operacional lista renovações em `REVISAO`; a tela só mostra o estado à Gestão da empresa. Necessário antes da rotina geral.

## O que esta rodada não comprova

Recebimento do e-mail na caixa (modo SINK), bounce, a geração e cobrança real da primeira parcela regular, a rotina periódica, produção e concorrência entre processador e webhook sobre a mesma empresa além da trava (coberta pela trava por empresa e pela homologação PostgreSQL de 09/10).

## Evidências anteriores reutilizadas

| Evidência | Reaproveitada para |
|---|---|
| [Renovação Fundador 09/10](RENOVACAO_FUNDADOR_20261009.md): PostgreSQL sintético com a 075 real, repositório real, intenção antes da rede, duas execuções concorrentes, simulação sem escrita | regras da 075 e concorrência no banco |
| [Preflight remoto 09/10](RENOVACAO_PREFLIGHT_STAGING_20261009.md): tabelas 074/075 e duas guardas habilitadas em staging | schema instalado (S1 revalida) |
| [Envio pelo Shell 09–10/10](AVISO_EMAIL_SHELL_STAGING_20261009.md): Resend aceitou, replay com o mesmo id, um e-mail recebido por Felipe | transporte real e idempotência do Resend (D2) |
| Rodada 5 (09/10) e [rodada Fundador 10/10](evidencias/homologacao-fundador-staging-rodada2-20261010.md) | checkout, confirmação sandbox + webhook, cancelamento com período pago, prova de autoria e preservação de terceiros |
| Testes de apresentação do aviso (6, componente real) | renderização da tela; esta rodada valida o DTO servido |

## Validação local (candidata)

| Validação | Resultado |
|---|---|
| `node --experimental-strip-types --test scripts/homologacao-renovacao-staging.test.cjs` | **21/21**: guardas e flags (inclusive processo real sem flag, fora do Render e sem disco); fixtures inéditas; preços; calendário próprio = processador do produto; tempo acelerado; escopo antes da rede; transporte SINK/falha/Resend restrito; evento aceito pelo parser real; **matriz completa R0–R6 com o `processarRenovacao` real** sobre repositório que impõe as regras da 075 e Asaas em memória; corrida R5; lacuna G1; repetição e concorrência (1 registro, 1 mensagem); telas/registros/preço; encerramento (sem prova, com pagamento, antes do pagamento, pago sem intenção, colisão, disco/banco indisponíveis); varredura da fonte. |
| Mesmo comando + `homologacao-fundador-staging.test.cjs` | 38/38 |
| `npx eslint` nos dois scripts | 0 erros, 0 avisos |

Node local 24.20.0 (declarado: 22.23.2; a flag `--experimental-strip-types` cobre os dois). TypeScript e build não foram repetidos: nenhum arquivo do produto foi alterado.
