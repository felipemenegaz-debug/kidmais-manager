# Homologação em staging — planos, cotação e isolamento por empresa (pacote de 10/10/2026)

**Status: TENTATIVA 2 PRONTA PARA APROVAÇÃO, NÃO EXECUTADA.** Nada aqui autoriza deploy, mudança de env, migration, SQL ou chamadas ao Asaas. Cada operação precisa de aprovação explícita de Felipe para o alvo e a candidata indicados ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)). A aprovação da tentativa 1 (candidata `12ac74f`) **não** cobre a candidata nova; dela só se reutiliza a restauração (O5) da própria tentativa 1.

## Tentativa 1 (candidata `12ac74f`) — interrompida em O3, sem efeito no banco

Fatos verificados em 10/10/2026 (UTC), staging `srv-daif418ae00c73e8k2gg`:

| Etapa | Resultado |
|---|---|
| O1a | Registro gravado em `data/homologacao-planos-cotacao-20261010/configuracao-anterior.json`: as duas chaves **ausentes**. |
| O1b | Render MCP (merge): `COTACAO_PUBLICA_POR_EMPRESA=true`, `ASSINATURA_PLANOS_ATIVOS=true`. A gravação disparou o deploy `dep-db50835ckfvc738gaf9g` (commit `235b082`, só docs sobre `12ac74f`), que substituiu O2: LIVE às 09:29:57Z, `/api/health` 200, auto-deploy OFF, branch `staging`. Shell: `RENDER_GIT_COMMIT=235b082…`, `KIDMAIS_DEPLOY_ENV=staging`. |
| O3 | Recuperação pontual conferida no painel (janela de 3 dias; último export 09/10). O aplicador parou na conferência da conexão: `{"etapa":"CONEXAO","mensagem":"TLS … false !== true"}`. **Nenhuma etapa (precheck, migration, postcheck) foi enviada**; 076/077 não aplicadas. Estado: `migrations-076-077.json` com `etapas: []`, `concluido: false`. |
| O4 | Não executada (nenhuma fixture, assinatura sandbox ou webhook criado). |
| O5 | Pendente: as duas chaves continuam `true` em staging. |

Causa: os executores exigiam TLS incondicionalmente; o web staging usa `DATABASE_SSL=false` (rede privada do Render, host interno sem domínio), configuração que a própria trava de alvo já aceitava. TLS, rede e credenciais **não** foram alterados.

## Candidata da tentativa 2

- **Código: `8cd598f14f0254437c3a8d0088b77afc9727c645`** (sobre `235b082`).
- O commit seguinte, que traz este documento, altera somente `docs/`. Antes de N2, conferir que `origin/staging` é esse commit de documentação e que `git diff --name-only 8cd598f origin/staging` lista apenas arquivos em `docs/`. Qualquer outra diferença: parar.
- Diferença para `12ac74f`: só `scripts/` (executores e testes). Aplicação web inalterada.

| Correção | Comportamento |
|---|---|
| Conexão (`scripts/conexao-staging.cjs`) | TLS esperado = configuração da aplicação (`lib/db/postgres.ts`). `DATABASE_SSL=true` → exige TLS e recusa certificado sem verificação. `DATABASE_SSL=false` → sem TLS **somente** com servidor em faixa privada (10/8, 172.16/12, 192.168/16). Banco exato `kidmais_staging_1z91`. A trava global (serviço, ambiente, host interno, porta 5432, banco, sandbox, `sslmode` proibido na URL) não muda. |
| Disco | Estado só no disco persistente montado (`/opt/render/project/src/data` em dispositivo distinto do pai); sem ele, os executores param antes de criar diretório, conectar ou limpar. |
| Retomada do O3 | Aplica só o que falta: migration ausente → precheck, migration, postcheck; já aplicada → só o postcheck (leitura). Nova tentativa somente se **todas** as anteriores têm `concluido:false`, `etapas:[]` e falha em `CONEXAO`. Concluída, em andamento, interrompida após iniciar etapa ou ilegível → `TENTATIVA_ANTERIOR_REVISAR`. A tentativa 1 é preservada byte a byte; a nova grava `migrations-076-077.tentativa-2.json` (`wx`: execução simultânea para). |
| Matriz ampliada | F5 Premium (contrato sandbox, financeiro completo, endereço público 200, sem teto de pessoas); limite de pessoas por plano (3/10/sem teto); regra não zero de outra empresa (F4, PIX à vista 5%) gravada no pedido e aplicada no contrato gerado; regra legada da Kidmais e `empresa_regras_pagamento` fora das fixtures preservadas. |

## Alvo exato

| Item | Valor |
|---|---|
| Workspace Render | `tea-daidbj95efls73d2bcf0` |
| Web staging | `kidmais-manager-staging` `srv-daif418ae00c73e8k2gg`, branch `staging`, auto-deploy OFF (revalidar antes de N1 e N2) |
| Disco | `dsk-daif418ae00c73e8k340`, montado em `/opt/render/project/src/data` |
| Cron staging | `crn-db493i142hec73ahmoe0` — não alterado nem reimplantado |
| Banco | `dpg-daidko3m8hqs73ce4jt0-a` / `kidmais_staging_1z91`, rede privada (`DATABASE_SSL=false`) |
| Asaas | `sandbox` |
| Produção | não tocada |

## Sequência

Ordem pensada para não gerar deploy a mais: o deploy que a gravação das chaves dispara (N2) já é o da candidata.

| # | Operação exata | Efeito | Duração/custo |
|---|---|---|---|
| N0 | **Restauração da tentativa 1** (autorização de O5 da tentativa 1): remover as duas chaves no painel (“Save only”); Render MCP `trigger_deploy` (branch ainda em `235b082`, conferir antes); no Shell `node scripts/configuracao-homologacao-staging.cjs --conferir-restauracao` → `RESTAURADA`. | staging volta à configuração registrada; mesmo código | ~6 min de build |
| N1 | Revalidar branch/auto-deploy; `git push origin <candidata+docs>:staging` (fast-forward, sem force). | só o repositório; auto-deploy OFF não implanta | segundos |
| N2 | (a) Shell: `--conferir-restauracao` → `RESTAURADA` (o registro de O1a continua válido: ausentes). (b) Render MCP `update_environment_variables` (merge) com as duas chaves `true`; acompanhar o deploy que ele dispara (não disparar outro); conferir commit LIVE = commit de docs, `/api/health` 200 e no Shell `RENDER_GIT_COMMIT`. | web com a candidata e as chaves | ~6 min |
| N3 | Conferir no painel a recuperação pontual do `dpg-daidko3m8hqs73ce4jt0-a` (sem restaurar). Shell: `cd /opt/render/project/src && node --experimental-strip-types scripts/migrations-076-077-staging.cjs --aplicar-076-077-autorizado` → `PASS`, `tentativa: 2`, `conexao.redePrivada: true`, `schemaAntes` ausentes, 6 etapas. | DDL: índice de CPF por empresa (076); `empresa_regras_pagamento` com a linha legada da Kidmais se `codigo='kidmais'` existir (077). Nenhuma linha alterada/apagada | < 1 min; lock_timeout 5s |
| N4 | Shell: `cd /opt/render/project/src && nohup node --experimental-strip-types scripts/homologacao-planos-cotacao-staging.cjs --rodada-1-autorizada > data/homologacao-planos-cotacao-20261010/saida.log 2>&1 < /dev/null &` (registrar PID; não redeployar durante). Depois `cat …/saida.log` e registro sanitizado em `docs/evidencias/`. | 5 fixtures, catálogo, 3 contratos/confirmações sandbox (Essencial R$ 197, Profissional R$ 347, Premium R$ 597, sem Fundador), pedidos públicos, 2 contratos em elaboração (F2 e F4), matriz; encerramento sempre executado | ~25–35 min; Shell por duração |
| N5 | Restaurar a configuração registrada (remover as duas chaves no painel, “Save only”); `trigger_deploy` do mesmo SHA; `--conferir-restauracao` → `RESTAURADA`; `/b/hml-planos-profissional/fechamento` = 404; fechar o Shell. 076/077 permanecem (rollback só com decisão própria). | staging volta à configuração anterior | ~6 min |

Pedido de aprovação da tentativa 2: **N1–N5 para a candidata `8cd598f`**. N0 é a conclusão da tentativa 1 e usa a autorização dela.

### Registro da configuração anterior

Gravado na tentativa 1 (ambas ausentes) e não sobrescrito (`wx`). Comando original, idêntico a `COMANDO_REGISTRO` em `scripts/configuracao-homologacao-staging.cjs`:

```
mkdir -p data/homologacao-planos-cotacao-20261010 && node -e 'const n=["COTACAO_PUBLICA_POR_EMPRESA","ASSINATURA_PLANOS_ATIVOS"];const o={};for(const k of n){const v=process.env[k];o[k]={presente:v!==undefined,valor:v===undefined?null:(["true","false"].includes(v)?v:"OUTRO")}}require("fs").writeFileSync("data/homologacao-planos-cotacao-20261010/configuracao-anterior.json",JSON.stringify(o),{mode:0o600,flag:"wx"});console.log(JSON.stringify(o))'
```

### Restauração (N0 e N5)

| Registro | Ação |
|---|---|
| ausente | remover a variável no painel Render (“Save only”; o MCP não remove) |
| `true`/`false` | Render MCP `update_environment_variables` (merge) com o valor registrado |
| `OUTRO` | parar e decidir com Felipe |

Depois: `trigger_deploy` do mesmo SHA e `--conferir-restauracao` (diverge = `DIVERGENTE`, exit 2).

### Recuperação de execução interrompida

- N4: conferir que o PID não está vivo; `cd /opt/render/project/src && node --experimental-strip-types scripts/homologacao-planos-cotacao-staging.cjs --encerrar-rodada-1-autorizada`. Exige disco, `rodada.json` e a mesma trava de alvo; repete só o encerramento comprovado; idempotente. A rodada não se repete sobre o mesmo estado (`RODADA_EXISTENTE_S1`).
- N3: cada migration roda na própria transação. Uma tentativa que iniciou qualquer etapa bloqueia novas tentativas (`TENTATIVA_ANTERIOR_REVISAR`); decidir com os postchecks e nova aprovação. Arquivo de estado nunca é apagado.

## Encerramento: sempre, e só sobre o que a rodada criou

- Roda no `finally` em qualquer resultado e no modo de recuperação. Nunca lança. O erro original prevalece (`erroFinal`); falhas de limpeza ficam em `falhasEncerramento`.
- **Prova de autoria**, gravada antes de cada criação:

| Recurso | Só é encerrado se | Proteções adicionais |
|---|---|---|
| Fixtures do banco (F1–F5) | `precheck.fixturesLivres` **e** `intencaoFixture` | UPDATE só por ID **e** marcador; nunca DELETE. A regra de F4 fica com a fixture desativada |
| Assinatura sandbox F1/F2/F5 | `precheck.asaasLivre[F]` **e** `intencaoCheckout` | referência = empresa da fixture; cliente e id iguais aos registrados; mais de uma = não remove |
| Webhook | intenção de **criá-lo** (nome inédito conferido antes) | reutilizado nunca; ambíguo = não apaga |

## Executor e fixtures

`scripts/homologacao-planos-cotacao-staging.cjs` — trava do ensaio de 09/10 + `COTACAO_PUBLICA_POR_EMPRESA=true`, banco e TLS conforme a configuração, disco persistente e 076/077 instaladas (S1).

| Fixture | Empresa | Usuário | `codigo` | Estado |
|---|---|---|---|---|
| F1 Essencial | `878a2c39-19e5-4d2a-82a7-223b893352c9` | `11e5006f-68d0-4182-9b12-da048b3f7db8` | `hml-planos-essencial` | contrato Essencial (sandbox) |
| F2 Profissional | `d1787a4c-aaeb-4eb6-99a1-9659feb3902f` | `4aa233ad-6c4f-41bb-ae7f-62996c1b5018` | `hml-planos-profissional` | contrato Profissional (sandbox) |
| F3 Isenta | `6dfd58f1-91fa-4202-9ace-72d705390272` | `7ff5a408-d1da-4813-99a9-0ebd1cf7511e` | `hml-planos-isenta` | `assinatura_isencoes` |
| F4 Teste | `092c5201-91c1-446e-90e8-cea19831e749` | `9029758e-317b-4c4e-95c6-685ac990a956` | `hml-planos-teste` | teste de 15 dias; regra PIX à vista 5%, parcelado 2%, sem selo dia útil |
| F5 Premium | `05c494a8-85be-42a0-b3a6-1b22d6a8ae39` | `0129beea-bd5f-4df8-92e1-6f9bfad56045` | `hml-planos-premium` | contrato Premium (sandbox) |

Pacote `POCKET` com faixa única fixa 20–30 convidados, R$ 1.500,00 (`FAIXA_POCKET`). Esperados de preço calculados pelo executor, em centavos e sem o código do sistema: 0% → 150000; 5% → 142500; legado 10% → 135000.

## Matriz de aceite (divergência = S2)

| Financeiro (sessão da fixture) | F1 | F2 | F3 | F4 | F5 |
|---|---|---|---|---|---|
| `GET /api/admin/financeiro/contas-pagar` | 403 | 200 | 200 | 200 | 200 |
| `POST …/contas-pagar` (conta sintética) | 403, 0 gravadas | 200, 1 | 200, 1 | 200, 1 | 200, 1 |
| `…/fluxo-caixa`, `…/relatorios` | 403 | 200 | 200 | 200 | 200 |
| `financeiroCompleto` (visão, dashboard, menu) | `false` | `true` | `true` | `true` | `true` |
| `…/contas-receber` | 200 | 200 | 200 | 200 | 200 |
| Após pagamento sandbox: acesso, plano, limite de pessoas | `COMPLETO`, essencial, 3 | `COMPLETO`, profissional, 10 | | | `COMPLETO`, premium, sem teto |
| Sessão F1 com `?empresaId=<F2>` | ≠ 200, sem dado de F2 | | | | |

| Cotação, preço e isolamento | Esperado |
|---|---|
| `/b/hml-planos-profissional/fechamento`, `/disponibilidade`; `/b/hml-planos-premium/fechamento` | 200; HTML sem logo da Kidmais, `<title>Orçamento da festa</title>`, `/icone-orcamento.svg` |
| `pacotes?empresa=` F2 / F4 / F5 | 200, catálogo da própria empresa |
| Essencial, inexistente, formato inválido, `/b/hml-planos-essencial/fechamento`, PDF | 404 idêntico |
| Preço F2 (sem regra) | cotação `valorTabela`/`valor` = 150000; `valor_tabela` do fechamento = 150000; `descontoPercentual` 0 |
| **Contrato F2 gerado pela API** | 201; `snapshot.comercial.valorFinalContrato` = 150000 (≠ 135000 do legado); desconto da forma 0 |
| Pedido F2 (cadastro novo) | 201; `empresa_id`=F2; sem `crm` |
| `consultar-cpf` do cliente de F2 | F2 `CLIENTE_EXISTENTE`; F4 `NOVO_CLIENTE`; endereço atual `NOVO_CLIENTE` |
| Mesmo CPF em F4 | 201, mesmas chaves; cliente de F4 com o próprio CPF (076) |
| **Regra não zero (F4, PIX à vista)** | condição gravada com `descontoPercentual` 5; contrato F4 gerado 201 com `valorFinalContrato` = 142500 e desconto da forma 5 |
| Regra da Kidmais | linha `codigo='kidmais'` (se existir) = 10/3/Cielo/selo; `empresa_regras_pagamento` fora das fixtures idêntica antes/depois |
| Cliente existente com prova inválida em F2 | recusado (4xx, ou 503 se o OTP estiver desligado em staging); nenhuma festa nova |
| Endereço atual (pacotes e agenda do mês seguinte) | projeção idêntica antes/depois |
| Hash de tabelas de negócio **fora das fixtures** | idêntico (S3) |

### Cobertura que este ensaio não comprova

- **Festa e IA**: a barreira de financeiro da festa (`/api/admin/festas/<id>/financeiro`) e as ações de IA (`inteligencia/operacoes`) usam a mesma `FINANCEIRO_COMPLETO`, mas exigem festa (contrato assinado) e proposta gerada pelo modelo. Cobertas por testes unitários (`recursos-plano`, `recursos-plano-ia`); sem prova em staging nesta rodada.
- **Navegador (desktop e celular)**: cadastro/teste, login, seleção de empresa, assinatura e navegação bloqueada. As senhas das fixtures existem só na memória do executor e o agente não cria contas fora de `localhost`. Exige rodada própria com Felipe operando o navegador, ou ensaio local em banco descartável.
- **Limite de requisições e unidade única**: cobertos por testes unitários; não exercitados em staging.

## Critérios de parada

- S1 alvo/banco/TLS conforme configuração/rede privada/disco/schema (076/077) divergente; fixture, e-mail, código, cliente ou assinatura Asaas já existente; estado de rodada presente.
- S2 qualquer item da matriz divergente (inclusive preço e contratos).
- S3 dados fora das fixtures ou projeção pública da Kidmais diferente.
- S4 oferta com Fundador ou aguardando vaga, cobrança sandbox divergente, callback não processado em 3 min. Não alterar o teto Fundador nem consumir vagas reais.
- S5 build/health com falha em N0/N2/N5; tentativa anterior com efeito, pre/postcheck com falha em N3; `--conferir-restauracao` divergente.

## Recuperação

- Código: `git revert` em `staging` + deploy autorizado; a aplicação é a mesma da `12ac74f` e funciona com e sem 076/077.
- Configuração: restauração do registro (N0/N5).
- 076/077: rollbacks em `database/rollback/20261010_07{6,7}_*_down.sql` (abortam se perderiam informação).
- Dados de homologação (inclusive os contratos de F2 e F4, em elaboração, nunca enviados nem assinados): encerramento comprovado; nunca apagados.

## Evidências locais (candidata `8cd598f`)

| Validação | Resultado |
|---|---|
| Testes unitários sem banco (`check:v1:static`, conjunto completo) | 2224/2224 |
| Executor | 19/19 — inclui conexão pela configuração (S1 e recuperação), disco obrigatório antes de ler/gravar estado (limpeza sem disco para sem tocar nada), regra não zero/Premium com esperados independentes, falha, colisão e interrupção do encerramento |
| Aplicador 076/077 | 10/10 — retomada da tentativa real de staging (preservada byte a byte), só migrations ausentes, tentativa anterior com efeito/concluída/em andamento/ilegível bloqueia, colisão simultânea, falha com ROLLBACK e erro original, identidade divergente sem etapa, sem disco |
| Conexão | 5/5 — rede privada só sem TLS e em faixa privada; TLS com certificado verificado; banco/configuração divergentes; alvos indevidos (host externo, produção, porta, banco local, `sslmode`, ambiente ausente) |
| Restauração da configuração | 5/5 |
| Harness staging (mocks) | 103/103 |
| TypeScript, build de produção, worker de PDF | aprovados |
| ESLint | 0 erros (1 aviso preexistente) |
| Demais testes de `scripts/` | 6 dependem de navegador/clone/servidor (Playwright ausente, `--festa-id`, servidor local); não referenciam os arquivos alterados |

## Decisão pendente e itens de produção

- **Regra padrão de pagamento para buffets sem configuração** (depois da 077): hoje “sem desconto automático” (0%). Confirmar ou definir outro padrão; ainda não há tela para cada buffet configurar as próprias regras.
- Produção (fora deste pacote): conferir por nome `AGENDA_PUBLICA_EMPRESA_ID` no web de produção; inventário do schema e de todas as migrations exigidas; 076/077 com autorização própria e precheck da 077 com exatamente uma empresa `kidmais`.
- Horário nobre por plano e escolha pública de unidade continuam pendentes.
