# Homologação em staging — planos, cotação e isolamento por empresa (pacote de 10/10/2026)

**Status: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.** Nada aqui autoriza deploy, mudança de env, migration, SQL ou chamadas ao Asaas. Cada operação O1–O5 precisa de aprovação explícita de Felipe para o alvo indicado ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)).

## Candidata

Branch `staging`, commit que contém este documento (SHA exato informado no pedido de aprovação; é o `HEAD` de `origin/staging` em O2). Inclui `a17e6d6` (financeiro por plano), `61519e2`/`cf1b9e7` (cotação por empresa e isolamento) e esta etapa:

| Ponto | Correção | Kidmais (endereço atual) |
|---|---|---|
| Cliente existente e CPF por empresa | Identidade pública (`/api/identidade/*`) procura o CPF só na empresa do endereço (servidor); endereço atual = empresa configurada + legado sem empresa; aceite de contrato = só o cliente do próprio contrato. Migration **076** troca o índice global de CPF por (empresa, CPF). Antes da 076, CPF de outra empresa no endereço por código gera cadastro sem CPF (nota interna neutra); depois, grava normalmente. Cliente existente liberado no endereço por empresa. | Mesmo fluxo; só deixa de enxergar clientes de outras empresas. |
| Condições de pagamento | Condição nova grava `descontoPercentual` da regra da empresa (migration **077**, `empresa_regras_pagamento`); contrato usa o gravado; condição sem o campo (todas as existentes) = legado 10%/3%/0%. Tela por empresa mostra as regras dela, sem “Cielo” nem selo -15% seg–qui. | 077 grava a linha da Kidmais com 10/3/Cielo/-15%: números e textos idênticos (2000 bases × 3 formas conferidas contra a fórmula anterior). |
| Nome | Nome comercial **aplicado** do perfil (nunca rascunho); sem perfil/ambíguo → `empresas.nome`. | — |
| Ícone | `favicon.ico` movido para `public/` e declarado no layout raiz (mesmo `<link rel="icon" href="/favicon.ico" sizes="any">`); `/b/<código>` usa ícone neutro `/icone-orcamento.svg`. | Mesmo arquivo de ícone. |

Também: limite `IDENTIDADE` (20/h por origem) nas rotas de identidade; executor com recuperação de execução interrompida; aplicador de 076/077 com hash fixado.

## Alvo exato

| Item | Valor |
|---|---|
| Workspace Render | `tea-daidbj95efls73d2bcf0` |
| Web staging | `kidmais-manager-staging` `srv-daif418ae00c73e8k2gg`, branch `staging`, auto-deploy OFF (revalidar antes de O2) |
| Cron staging | `crn-db493i142hec73ahmoe0` — não alterado nem reimplantado |
| Banco | `dpg-daidko3m8hqs73ce4jt0-a` / `kidmais_staging_1z91`, TLS |
| Asaas | `sandbox` |
| Produção | não tocada |

## Operações para aprovação (O1–O5)

| # | Operação exata | Efeito | Duração/custo |
|---|---|---|---|
| O1 | Render MCP `update_environment_variables` no `srv-daif418ae00c73e8k2gg`, modo **merge** (sem `replace`): `COTACAO_PUBLICA_POR_EMPRESA=true`, `ASSINATURA_PLANOS_ATIVOS=true`. Nenhuma outra variável. | grava configuração; vale no próximo deploy | segundos |
| O2 | Revalidar branch/auto-deploy; conferir `origin/staging` = SHA aprovado; Render MCP `trigger_deploy` no `srv-daif418ae00c73e8k2gg`; acompanhar build (`check:v1:static` + build) e `/api/health`. | web reinicia com a candidata e as chaves; o código funciona com e sem 076/077 | ~6 min |
| O3 | Conferir no painel Render que o backup/recuperação pontual do `dpg-daidko3m8hqs73ce4jt0-a` está disponível (sem restaurar). Web Shell: `cd /opt/render/project/src && node --experimental-strip-types scripts/migrations-076-077-staging.cjs --aplicar-076-077-autorizado` | DDL: troca o índice de CPF (076) e cria `empresa_regras_pagamento` com a linha da Kidmais se `empresas.codigo='kidmais'` existir em staging (077). Nenhuma linha alterada ou apagada | < 1 min; lock_timeout 5s |
| O4 | Web Shell: `cd /opt/render/project/src && mkdir -p data/homologacao-planos-cotacao-20261010 && nohup node --experimental-strip-types scripts/homologacao-planos-cotacao-staging.cjs --rodada-1-autorizada > data/homologacao-planos-cotacao-20261010/saida.log 2>&1 < /dev/null &` (registrar PID; não redeployar durante a execução). Depois: `cat data/homologacao-planos-cotacao-20261010/saida.log` e registro sanitizado em `docs/evidencias/`. | fixtures, catálogo, 2 checkouts e confirmações sandbox, matriz, encerramento no `finally` | ~20–30 min; Shell cobrado por duração |
| O5 | Render MCP `update_environment_variables` (merge) `COTACAO_PUBLICA_POR_EMPRESA=false`, `ASSINATURA_PLANOS_ATIVOS=false` (ou remoção pelo painel), seguido de `trigger_deploy` do mesmo SHA; conferir `/b/hml-planos-profissional/fechamento` = 404 e checkout desabilitado. 076/077 permanecem (rollback só com decisão própria). | staging volta ao comportamento sem as chaves | ~6 min |

### Recuperação de execução interrompida (O4)

Se o Shell cair, houver restart/deploy ou o processo for encerrado no meio:

1. Conferir que o processo original não está vivo (`ps -p <PID>`; o executor também recusa se estiver).
2. `cd /opt/render/project/src && node --experimental-strip-types scripts/homologacao-planos-cotacao-staging.cjs --encerrar-rodada-1-autorizada`
3. O modo de encerramento exige o `rodada.json` da rodada, usa as mesmas travas de alvo (sem exigir as chaves de O1), recusa `RODADA_EM_EXECUCAO` e repete só o encerramento: remove assinaturas sandbox com referência às empresas F1/F2, remove o webhook apenas se a rodada registrou a intenção de criá-lo (procura pelo nome se o id não foi salvo) e desativa usuários/memberships/empresas das quatro fixtures. É idempotente (pode rodar mais de uma vez) e nunca apaga linha.
4. A rodada não é repetida sobre o mesmo estado (`RODADA_EXISTENTE_S1`); nova rodada exige novos IDs e nova aprovação. O5 continua obrigatória.

Interrupção em O3: cada migration roda na própria transação (falha = rollback da própria migration). O aplicador grava `migrations-076-077.json` e recusa nova execução sobre ele; conferir com os postchecks e decidir antes de repetir.

## Executor (`scripts/homologacao-planos-cotacao-staging.cjs`)

- Travas do ensaio de 09/10 + `COTACAO_PUBLICA_POR_EMPRESA=true`, `current_database()='kidmais_staging_1z91'`, `pg_stat_ssl.ssl=true` e **076/077 instaladas** (S1).
- Fixtures (IDs reservados; nunca reutilizar):

| Fixture | Empresa | Usuário | `codigo` | Estado |
|---|---|---|---|---|
| F1 Essencial | `878a2c39-19e5-4d2a-82a7-223b893352c9` | `11e5006f-68d0-4182-9b12-da048b3f7db8` | `hml-planos-essencial` | contrato Essencial confirmado (sandbox) |
| F2 Profissional | `d1787a4c-aaeb-4eb6-99a1-9659feb3902f` | `4aa233ad-6c4f-41bb-ae7f-62996c1b5018` | `hml-planos-profissional` | contrato Profissional confirmado (sandbox) |
| F3 Isenta | `6dfd58f1-91fa-4202-9ace-72d705390272` | `7ff5a408-d1da-4813-99a9-0ebd1cf7511e` | `hml-planos-isenta` | `assinatura_isencoes` (CNPJ sintético ≠ Kidmais) |
| F4 Teste | `092c5201-91c1-446e-90e8-cea19831e749` | `9029758e-317b-4c4e-95c6-685ac990a956` | `hml-planos-teste` | teste de 15 dias |

- Escreve só nas fixtures (empresas, usuários, memberships, categoria de despesa, assinatura/isenção, pacote `POCKET` pelos serviços), contratos sandbox de F1/F2 pelo checkout real, contas a pagar e fechamentos sintéticos pelas APIs da fixture. Nunca `DELETE`/`TRUNCATE`/`DROP`/`ALTER`.
- Saída e estado sem linhas de banco, CPF, e-mail, token ou senha.

## Matriz de aceite (verificada pelo executor; divergência = S2)

| Financeiro (sessão da fixture) | F1 | F2 | F3 | F4 |
|---|---|---|---|---|
| `GET /api/admin/financeiro/contas-pagar` | 403 | 200 | 200 | 200 |
| `POST …/contas-pagar` (conta sintética) | 403, 0 gravadas | 200, 1 | 200, 1 | 200, 1 |
| `…/fluxo-caixa`, `…/relatorios` | 403 | 200 | 200 | 200 |
| `financeiroCompleto` (visão, dashboard, menu) | `false` | `true` | `true` | `true` |
| `…/contas-receber` | 200 | 200 | 200 | 200 |
| Sessão F1 pedindo `?empresaId=<F2>` | ≠ 200, sem dado de F2 | | | |

| Cotação e isolamento | Esperado |
|---|---|
| `/b/hml-planos-profissional/fechamento`, `/disponibilidade` | 200; HTML sem logo da Kidmais, `<title>Orçamento da festa</title>`, ícone `/icone-orcamento.svg` |
| `pacotes?empresa=hml-planos-profissional` / `hml-planos-teste` | 200, catálogo da própria empresa |
| Essencial, inexistente, formato inválido, `/b/hml-planos-essencial/fechamento`, PDF | 404 idêntico |
| Agenda por empresa | `comercial` vazio |
| Pedido F2 (cadastro novo, PIX à vista) | 201; `empresa_id`=F2; sem `crm`; condição com `descontoPercentual`=0 (F2 sem regra = sem desconto automático) |
| `consultar-cpf` com o CPF do cliente de F2 | F2: `CLIENTE_EXISTENTE`; F4: `NOVO_CLIENTE`; endereço atual: `NOVO_CLIENTE` |
| Mesmo CPF em F4 | 201, mesmas chaves de resposta; cliente de F4 com o próprio CPF (076) |
| Cliente existente com prova inválida em F2 | recusado (4xx, ou 503 se o OTP estiver desligado em staging); nenhuma festa nova |
| Endereço atual (pacotes e agenda do mês seguinte) | projeção idêntica antes/depois |
| Hash de `empresas`, `memberships`, `empresa_assinaturas` (sem colunas do cron), `assinatura_*`, `clientes`, `fechamentos`, `pacotes`, `financeiro_*` **fora das fixtures** | idêntico (S3) |

## Critérios de parada

- S1 alvo/banco/TLS/schema (076/077) divergente; fixture, e-mail, código ou cliente Asaas já existente; estado de rodada presente.
- S2 qualquer item da matriz divergente.
- S3 dados fora das fixtures ou projeção pública da Kidmais diferente.
- S4 oferta com Fundador ou aguardando vaga (nunca consumir vaga), cobrança sandbox divergente, callback não processado em 3 min.
- S5 build/health com falha em O2/O5; precheck/postcheck de 076/077 com falha em O3.

Risco conhecido de S3 falso: uso simultâneo do staging ou mudança natural da situação comercial de outra empresa. Resultado inconclusivo; não repetir sem nova aprovação.

## Recuperação

- Código: `git revert` dos commits em `staging` + deploy autorizado. O código funciona com e sem 076/077.
- Configuração: O5.
- 076: `database/rollback/20261010_076_cpf_por_empresa_down.sql` (aborta se o mesmo CPF já existir em empresas diferentes; nunca apaga ou mescla).
- 077: `database/rollback/20261010_077_regras_pagamento_empresa_down.sql` (aborta se houver regra além da legada da Kidmais; condições já gravadas continuam válidas pelo percentual gravado).
- Dados de homologação: fixtures desativadas, nunca apagadas; assinaturas sandbox removidas.

## Evidências locais

- Testes sem banco: 2221/2221 (263 arquivos); scripts offline (executor, aplicador, harness, cron): 119/119; TypeScript, ESLint (0 erros; 1 aviso preexistente), build e worker de PDF aprovados.
- Novos: regras de pagamento/contratos legados idênticos/migrations 7/7; CPF e identidade por empresa 7/7; executor (incl. recuperação) 9/9; aplicador 076/077 2/2.
- Smoke HTTP local (sem banco, chave desligada): página atual com `<link rel="icon" href="/favicon.ico" sizes="any">`; `/favicon.ico` e `/icone-orcamento.svg` 200; endereço por empresa e identidade por código 404; limite de identidade 429 após 20/h.
- [Testes de navegador base × candidata](evidencias/testes-navegador-base-vs-candidata-20261010.txt): mesmos 7 testes falham igual na base anterior (ambiente).

## Antes de produção (fora deste pacote)

- Conferir por nome que `AGENDA_PUBLICA_EMPRESA_ID` está definida no web de produção: a identidade do endereço atual passa a depender dela (sem ela, 403, como o catálogo público já faz).
- 076/077 em produção exigem autorização própria; o precheck da 077 deve mostrar exatamente uma empresa `kidmais`.
- Pendências comerciais: tela para cada buffet configurar as próprias regras de pagamento (hoje só por migration/operador); prévia administrativa usa o percentual gravado na condição, e o legado ao escolher outra forma até a aprovação; horário nobre por plano; escolha pública de unidade (empresas com mais de uma unidade ficam fora).
