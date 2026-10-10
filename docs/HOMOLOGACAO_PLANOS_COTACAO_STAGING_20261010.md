# Homologação em staging — planos, cotação e isolamento por empresa (pacote de 10/10/2026)

**Status: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.** Nada aqui autoriza deploy, mudança de env, migration, SQL ou chamadas ao Asaas. Cada operação O1–O5 precisa de aprovação explícita de Felipe para o alvo indicado ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)).

## Candidata

- **Código: `e9c1bcca368bb4ba489ac0be5807bb9414ba0de3`** (branch `staging`).
- O commit seguinte, que traz este documento, altera somente `docs/`. Em O2, conferir que `origin/staging` é esse commit de documentação ou o próprio `e9c1bcc`, e que `git diff --name-only e9c1bcc origin/staging` lista apenas arquivos em `docs/`. Qualquer outra diferença: parar.
- Inclui: financeiro por plano (`a17e6d6`), cotação por empresa e isolamento (`61519e2`, `cf1b9e7`), identidade/CPF/pagamento/nome/ícone por empresa (`57d0e71`) e o encerramento comprovado, restauração e regras nas telas (`e9c1bcc`), sobre a correção de convites `971f9c1` já presente em `staging`.

| Ponto | Situação na candidata | Kidmais (endereço atual) |
|---|---|---|
| Cliente existente e CPF | Identidade pública só na empresa do endereço (atual = empresa configurada + legado; contrato = o próprio cliente). 076 (preparada): CPF único por empresa. Antes da 076, CPF de outra empresa no endereço por código → cadastro sem CPF, sem revelar. | Mesmo fluxo, sem enxergar clientes de outras empresas. |
| Pagamento | Condição nova grava `descontoPercentual` da regra da empresa (077, preparada); contrato usa o gravado; condições existentes = legado. Tela pública (por código e atual) e prévia administrativa mostram as regras que o servidor devolve para a empresa. | 077 grava 10/3/Cielo/-15% para `codigo='kidmais'`: valores e textos idênticos. |
| Nome e ícone | Nome comercial aplicado do perfil; ícone neutro em `/b/<código>`. | Mesmo `/favicon.ico`. |

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
| O1 | (a) Web Shell do `srv-daif418ae00c73e8k2gg`, no deploy atual, registrar a configuração anterior das duas chaves (só presença e `true`/`false`; recusa sobrescrever): ver **Registro da configuração anterior**. (b) Render MCP `update_environment_variables` no mesmo serviço, modo **merge** (sem `replace`): `COTACAO_PUBLICA_POR_EMPRESA=true`, `ASSINATURA_PLANOS_ATIVOS=true`. Nenhuma outra variável. | grava a configuração; vale no próximo deploy | segundos; Shell por duração |
| O2 | Revalidar branch/auto-deploy; conferir `origin/staging` conforme **Candidata**; Render MCP `trigger_deploy` no `srv-daif418ae00c73e8k2gg`; acompanhar build (`check:v1:static` + build) e `/api/health`. | web reinicia com a candidata e as chaves; o código funciona com e sem 076/077 | ~6 min |
| O3 | Conferir no painel que o backup/recuperação pontual do `dpg-daidko3m8hqs73ce4jt0-a` está disponível (sem restaurar). Web Shell: `cd /opt/render/project/src && node --experimental-strip-types scripts/migrations-076-077-staging.cjs --aplicar-076-077-autorizado` | DDL: índice de CPF por empresa (076); `empresa_regras_pagamento` com a linha legada da Kidmais se `codigo='kidmais'` existir (077). Relatório (leitura) se a empresa do endereço atual de staging ficou com regra. Nenhuma linha alterada/apagada | < 1 min; lock_timeout 5s |
| O4 | Web Shell: `cd /opt/render/project/src && mkdir -p data/homologacao-planos-cotacao-20261010 && nohup node --experimental-strip-types scripts/homologacao-planos-cotacao-staging.cjs --rodada-1-autorizada > data/homologacao-planos-cotacao-20261010/saida.log 2>&1 < /dev/null &` (registrar PID; não redeployar durante). Depois `cat data/homologacao-planos-cotacao-20261010/saida.log` e registro sanitizado em `docs/evidencias/`. | fixtures, catálogo, 2 checkouts/confirmações sandbox, matriz; encerramento sempre executado | ~20–30 min; Shell por duração |
| O5 | Restaurar a configuração registrada em O1 (ver **Restauração**), `trigger_deploy` do mesmo SHA e conferir em runtime: `cd /opt/render/project/src && node scripts/configuracao-homologacao-staging.cjs --conferir-restauracao` → `RESTAURADA`; `/b/hml-planos-profissional/fechamento` = 404. 076/077 permanecem (rollback só com decisão própria). | staging volta à configuração anterior | ~6 min |

### Registro da configuração anterior (O1a)

Comando de uma linha (roda no deploy atual, que ainda não tem os scripts novos; grava `data/homologacao-planos-cotacao-20261010/configuracao-anterior.json` no disco persistente e falha se o arquivo já existir):

```
mkdir -p data/homologacao-planos-cotacao-20261010 && node -e 'const n=["COTACAO_PUBLICA_POR_EMPRESA","ASSINATURA_PLANOS_ATIVOS"];const o={};for(const k of n){const v=process.env[k];o[k]={presente:v!==undefined,valor:v===undefined?null:(["true","false"].includes(v)?v:"OUTRO")}}require("fs").writeFileSync("data/homologacao-planos-cotacao-20261010/configuracao-anterior.json",JSON.stringify(o),{mode:0o600,flag:"wx"});console.log(JSON.stringify(o))'
```

É o mesmo texto de `COMANDO_REGISTRO` em `scripts/configuracao-homologacao-staging.cjs`; o teste executa o comando e confere que grava exatamente o mesmo registro. Valor fora de `true`/`false` é gravado como `OUTRO`, nunca o texto.

### Restauração (O5)

Para cada chave, conforme o registro (`planoRestauracao`):

| Registro | Ação |
|---|---|
| ausente | remover a variável no painel Render (“Save only”; o MCP não remove) |
| `true`/`false` | Render MCP `update_environment_variables` (merge) com o valor registrado |
| `OUTRO` | parar e decidir com Felipe (não há como recompor um valor que não foi copiado) |

Depois: `trigger_deploy` do mesmo SHA e `--conferir-restauracao` (compara presença e valor com o registro; diverge = `DIVERGENTE`, exit 2).

### Recuperação de execução interrompida (O4)

1. Conferir que o processo original não está vivo (`ps -p <PID>`; o executor também recusa: `RODADA_EM_EXECUCAO`).
2. `cd /opt/render/project/src && node --experimental-strip-types scripts/homologacao-planos-cotacao-staging.cjs --encerrar-rodada-1-autorizada`
3. Exige o `rodada.json` da rodada e as mesmas travas de alvo (sem exigir as chaves de O1). Repete só o encerramento, com a mesma regra de autoria. É idempotente e não apaga linhas.
4. A rodada não é repetida sobre o mesmo estado (`RODADA_EXISTENTE_S1`). Nova rodada exige novos IDs e nova aprovação. O5 continua obrigatória.

Interrupção em O3: cada migration roda na própria transação. O aplicador grava `migrations-076-077.json` e recusa nova execução sobre ele; conferir com os postchecks antes de decidir.

## Encerramento: sempre, e só sobre o que a rodada criou

- Roda no `finally` em qualquer resultado (aprovado, falha, parada S1–S5) e no modo de recuperação. Nunca lança.
- O erro original da rodada prevalece (`erroFinal`); falhas de limpeza ficam em `falhasEncerramento` e as etapas seguintes continuam.
- **Prova de autoria**, gravada no estado **antes** de cada criação:

| Recurso | Só é encerrado se | Proteções adicionais |
|---|---|---|
| Fixtures do banco | `precheck.fixturesLivres` (S1 provou IDs, códigos e e-mails inexistentes) **e** `intencaoFixture` | UPDATE só por ID **e** marcador (e-mail; código + nome da empresa); nunca DELETE |
| Assinatura sandbox F1/F2 | `precheck.asaasLivre[F]` (sem cliente nem assinatura com a referência antes) **e** `intencaoCheckout` | referência = empresa da fixture; cliente e id iguais aos registrados, quando já salvos; mais de uma = não remove |
| Webhook | a rodada registrou a intenção de **criá-lo** (nome inédito conferido antes, no ensaio de 09/10) | reutilizado nunca; busca pelo nome só se o id não foi salvo; ambíguo = não apaga |

Sem prova → `NADA_CRIADO_PELA_RODADA` (colisão, precheck incompleto, recurso alheio).

## Executor e fixtures

`scripts/homologacao-planos-cotacao-staging.cjs` — travas do ensaio de 09/10 + `COTACAO_PUBLICA_POR_EMPRESA=true`, banco `kidmais_staging_1z91`, TLS e 076/077 instaladas (S1).

| Fixture | Empresa | Usuário | `codigo` | Estado |
|---|---|---|---|---|
| F1 Essencial | `878a2c39-19e5-4d2a-82a7-223b893352c9` | `11e5006f-68d0-4182-9b12-da048b3f7db8` | `hml-planos-essencial` | contrato Essencial (sandbox) |
| F2 Profissional | `d1787a4c-aaeb-4eb6-99a1-9659feb3902f` | `4aa233ad-6c4f-41bb-ae7f-62996c1b5018` | `hml-planos-profissional` | contrato Profissional (sandbox) |
| F3 Isenta | `6dfd58f1-91fa-4202-9ace-72d705390272` | `7ff5a408-d1da-4813-99a9-0ebd1cf7511e` | `hml-planos-isenta` | `assinatura_isencoes` |
| F4 Teste | `092c5201-91c1-446e-90e8-cea19831e749` | `9029758e-317b-4c4e-95c6-685ac990a956` | `hml-planos-teste` | teste de 15 dias |

Pacote `POCKET` com faixa única fixa 20–30 convidados, R$ 1.500,00 (`FAIXA_POCKET`).

## Matriz de aceite (divergência = S2)

| Financeiro (sessão da fixture) | F1 | F2 | F3 | F4 |
|---|---|---|---|---|
| `GET /api/admin/financeiro/contas-pagar` | 403 | 200 | 200 | 200 |
| `POST …/contas-pagar` (conta sintética) | 403, 0 gravadas | 200, 1 | 200, 1 | 200, 1 |
| `…/fluxo-caixa`, `…/relatorios` | 403 | 200 | 200 | 200 |
| `financeiroCompleto` (visão, dashboard, menu) | `false` | `true` | `true` | `true` |
| `…/contas-receber` | 200 | 200 | 200 | 200 |
| Sessão F1 com `?empresaId=<F2>` | ≠ 200, sem dado de F2 | | | |

| Cotação, preço e isolamento | Esperado |
|---|---|
| `/b/hml-planos-profissional/fechamento`, `/disponibilidade` | 200; HTML sem logo da Kidmais, `<title>Orçamento da festa</title>`, `/icone-orcamento.svg` |
| `pacotes?empresa=` F2 / F4 | 200, catálogo da própria empresa |
| Essencial, inexistente, formato inválido, `/b/hml-planos-essencial/fechamento`, PDF | 404 idêntico |
| **Preço independente** (calculado pelo executor a partir da faixa, sem o código do sistema) | cotação `valorTabela` e `valor` = 150000 centavos; `valor_tabela` do fechamento F2 = 150000; F2 sem regra → `descontoPercentual` 0 → PIX à vista = 150000 |
| Pedido F2 (cadastro novo) | 201; `empresa_id`=F2; sem `crm` |
| `consultar-cpf` do cliente de F2 | F2 `CLIENTE_EXISTENTE`; F4 `NOVO_CLIENTE`; endereço atual `NOVO_CLIENTE` |
| Mesmo CPF em F4 | 201, mesmas chaves; cliente de F4 com o próprio CPF (076) |
| Cliente existente com prova inválida em F2 | recusado (4xx, ou 503 se o OTP estiver desligado em staging); nenhuma festa nova |
| Endereço atual (pacotes e agenda do mês seguinte) | projeção idêntica antes/depois |
| Hash de tabelas de negócio **fora das fixtures** | idêntico (S3) |

## Critérios de parada

- S1 alvo/banco/TLS/schema (076/077) divergente; fixture, e-mail, código, cliente ou assinatura Asaas já existente; estado de rodada presente.
- S2 qualquer item da matriz divergente (inclusive preço).
- S3 dados fora das fixtures ou projeção pública da Kidmais diferente.
- S4 oferta com Fundador ou aguardando vaga, cobrança sandbox divergente, callback não processado em 3 min.
- S5 build/health com falha em O2/O5; pre/postcheck de 076/077 com falha em O3; `--conferir-restauracao` divergente em O5.

## Recuperação

- Código: `git revert` em `staging` + deploy autorizado; funciona com e sem 076/077.
- Configuração: O5 (restaurar o registro de O1).
- 076/077: rollbacks em `database/rollback/20261010_07{6,7}_*_down.sql` (abortam se perderiam informação).
- Dados de homologação: encerramento comprovado; nunca apagados.

## Evidências locais (candidata `e9c1bcc`)

| Validação | Resultado |
|---|---|
| Testes unitários sem banco | 2223/2223 |
| Testes de scripts offline (executor, aplicador, configuração, harness, cron) | 131/131 |
| Executor | 16/16 — falha (erro original preservado, falhas de limpeza registradas, sem banco, disco indisponível), colisão (precheck incompleto, fixture/cliente Asaas preexistente, webhook reutilizado, assinatura de outro cliente/id), interrupção (antes do commit das fixtures, após checkout sem ids, após webhook sem id, antes do precheck, webhook ambíguo), ordem das provas e preço independente |
| Restauração da configuração | 5/5 (comando de uma linha = registro do script; não sobrescreve; plano de O5) |
| Preços | tabela calculada à mão (legado e regras da empresa) + 2000 bases × 3 formas contra a fórmula anterior |
| TypeScript, build, worker de PDF | aprovados |
| ESLint | 0 erros (1 aviso preexistente) |
| Smoke local | ícone raiz `<link rel="icon" href="/favicon.ico" sizes="any">`; endereço por empresa 404 com a chave desligada |
| [Testes de navegador base × candidata](evidencias/testes-navegador-base-vs-candidata-20261010.txt) | mesmos 7 falham igual na base anterior (ambiente) |

## Decisão pendente e itens de produção

- **Regra padrão de pagamento para buffets sem configuração** (depois da 077): hoje “sem desconto automático” (0%). Confirmar ou definir outro padrão antes da liberação comercial; ainda não há tela para cada buffet configurar as próprias regras.
- Produção (fora deste pacote): conferir por nome `AGENDA_PUBLICA_EMPRESA_ID` no web de produção (a identidade do endereço atual depende dela); 076/077 com autorização própria e precheck da 077 com exatamente uma empresa `kidmais`.
- Horário nobre por plano e escolha pública de unidade continuam pendentes.
