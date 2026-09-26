# Pacotes V1 — status de engenharia

Documento temporário de continuidade. Não é fonte funcional. A decisão de produto permanece no Second Brain e no Goal Mestre. O Goal permanece aberto.

## Estado atual — terceira remediação NO-GO

- Branch: `fix/v1-snapshot-comercial`
- Upstream: `origin/fix/v1-snapshot-comercial`
- Base: `origin/staging` = `c54a809169b825e5dde25cac1385602bafa3faf3` (`git merge-base` igual). 0 atrás. 42 commits à frente de `origin/staging` antes deste arquivo; este status é o quadragésimo terceiro. Não fazer push para `staging` nem `main`. Não fazer merge nem deploy.
- Código desta passagem, antes deste status: `bc6b7c3b08e774458380356013780a587ae2e423`
- Revisado e recusado na terceira revisão: `8d0bd00dec3320c412baa2110d4a06ec65c60ca3`
- Este arquivo entra no commit seguinte. O HEAD remoto, depois do push sem force, é esse commit de status.

Commits desta passagem, autor e committer Felipe Menegaz `<324788905+felipemenegaz-debug@users.noreply.github.com>`:

| SHA | Assunto |
| --- | --- |
| `77c0cf16d32dfd72710c59fc499c4ac212594a5b` | fecha a corrida de tenant e de publicação sob trava por empresa |
| `bc6b7c3b08e774458380356013780a587ae2e423` | prova concorrência de tenant e de publicação no PostgreSQL |

### Classificação

- P0-02: fechado na 038, no banco descartável. A 036 continua aplicada. A 038 trava o catálogo antes de validar, recusa empresas diferentes e qualquer outro desencontro, e não abre exceção no gatilho. `empresa_id` do pai segue imutável, inclusive de nulo para empresa.
- P1-03: fechado na 039, no banco descartável. Publicação, INSERT, UPDATE, DELETE, mudança de tabela e desativação do último preço usam a mesma trava por empresa. Empresas diferentes não esperam uma à outra. HG-4 continua aberto.
- P1-01 e a auditoria canônica transacional: fechados na passagem anterior. Não foram reabertos.
- P2-01 e P2-03: não tratados. A UX admin e o preço/data públicos não foram piorados.

### Gates que continuam abertos

- HG-4 aberto. Publicar não exige todos os pacotes nem as duas categorias. Tabela vazia continua recusada. Não houve completude comercial inventada.
- HG-6 aberto. Os sete pacotes legados seguem com `empresa_id` NULL. Não foram associados. Atribuir empresa a esse legado exige uma migration posterior, específica e auditável, que substitua a guarda. Esta passagem não faz isso e não cria parâmetro de sessão.
- HG-8 aberto. A Foundation 020 não foi copiada, alterada nem executada. Membership não foi adicionada.
- O catálogo público permanece fechado.
- Fail-closed: sem empresa comprovada na sessão real, as rotas administrativas de pacote, composição, catálogo e tabela respondem 403 e não consultam o banco.

### Migrations

036 e 037 não foram reescritas. Já estavam aplicadas em `kidmais_pacotes_v1_descartavel` na porta `55498`. O banco `kidmais_pacotes_v1_rollback` não foi alterado. 020 e 026–028 continuam reservadas. A 023 não foi reescrita. O próximo número livre passa a ser 040.

- `20260926_038_integridade_tenant_atomica.sql` — `LOCK TABLE` em `adicionais`, `pacote_adicionais`, `pacotes`, `precos_adicional`, `precos_pacote` e `tabelas_preco` antes da validação. Empresas diferentes, empresa/NULL e NULL/empresa abortam a migration inteira, exceto o `pacote_adicional` já existente de `FESTA_LOCAL` para `SALADA_PREMIUM` com empresa só no pacote. Essa linha não foi reescrita e não recebeu tenant. Não é exceção do gatilho: vínculo novo nesse formato continua recusado. NULL/NULL permanece válido. A mesma empresa nos dois lados permanece válida. O gatilho do pai continua recusando qualquer mudança de `empresa_id`.
- `20260926_039_publicacao_serial_completa.sql` — a mesma `kidmais_037_trava_publicacao` por empresa. O preço recusa no BEFORE o que já está publicado e, no AFTER, espera a trava depois da chave estrangeira, para não ciclar com a publicação. INSERT, UPDATE de cálculo, DELETE, mudança de tabela e desativação que esvaziaria a publicação esperam essa trava e relêem o estado que vai confirmar. `observacoes` não entra na trava. Vigência já sobreposta aborta a migration. Não despublica tabela vazia já existente.

Rollback: os DOWN da 038 e da 039 foram executados dentro de transação desfeita no banco principal. A guarda voltou. Nenhum DOWN foi deixado aplicado.

### Testes no PostgreSQL descartável

Banco `kidmais_pacotes_v1_descartavel`, `127.0.0.1:55498`, usuário `kidmais_descartavel`, sem senha. `current_database()` e `inet_server_port()` conferidos. Duas execuções de `lib/comercial/pacotes-v1-remediacao.postgres.test.ts`: 22 subtestes, 0 falhas, nas duas.

- 038 com preço entre duas empresas, com pacote de empresa ligado a adicional NULL que não é o par histórico, e com pacote NULL ligado a adicional de empresa: a migration abortou e a transação não gravou a guarda.
- Durante a trava da 038, outra sessão não conseguiu mudar `empresa_id` de `COMPACTA`. Depois do commit, a mudança foi recusada. `COMPACTA` segue sem empresa.
- NULL/NULL passou. A mesma empresa passou. A/B, A/NULL e NULL/A foram recusados no vínculo novo. Mudar a empresa do pai, inclusive de nulo para empresa, foi recusado.
- 039 com duas vigências publicadas sobrepostas abortou. Durante a trava da instalação, outra sessão não escreveu preço.
- Com duas conexões: publicação contra INSERT, contra UPDATE de valor, contra DELETE e contra mudança de tabela. A segunda sessão ficou bloqueada e, depois do commit, foi recusada. Duas desativações simultâneas dos últimos preços deixaram um ativo. `observacoes` foi editada enquanto a publicação da mesma empresa segurava a trava. Outra empresa publicou vigência sobreposta sem esperar essa trava.
- O vínculo `FESTA_LOCAL` → `SALADA_PREMIUM` sem empresa no adicional continua 1. Sete pacotes com `empresa_id` NULL. Nenhuma empresa sintética `t036`–`t039` permaneceu. Os gatilhos de preço e de empresa ficaram habilitados.

### Validação desta passagem

- PostgreSQL descartável: 22 subtestes, duas vezes, 0 falhas
- `npx tsc --noEmit`: passou
- `npm run lint`: passou, exit 0
- `npm run build`: passou
- `git diff --check`: passou
- `node --test scripts/production/production.test.mjs`: 35 passaram
- Testes de serviço e rota anteriores, mais `autorizacao-tenant.test.ts`: 47 passaram

P0-02 e P1-03 estão fechados nesta branch. HG-4, HG-6 e HG-8 permanecem abertos. O catálogo público permanece fechado. Os sete pacotes continuam sem empresa. Parado para uma quarta revisão independente. Não é merge nem deploy.

## HISTÓRICO — segunda remediação NO-GO

O texto abaixo é o estado declarado na segunda passagem. A terceira revisão recusou esse fechamento. Não é o estado atual.

## Estado declarado na segunda passagem

- Branch: `fix/v1-snapshot-comercial`
- Upstream: `origin/fix/v1-snapshot-comercial`
- Base: `origin/staging` = `c54a809169b825e5dde25cac1385602bafa3faf3` (`git merge-base` igual). 0 atrás. 39 commits à frente de `origin/staging` antes deste arquivo; este status é o quadragésimo. Não fazer push para `staging` nem `main`. Não fazer merge nem deploy.
- Código desta passagem, antes deste status: `645cb1f91bad2550838f87e4991e939b9c3e8e16`
- Este arquivo entra no commit seguinte. O HEAD remoto, depois do push sem force, é esse commit de status.

Commits desta passagem, autor e committer Felipe Menegaz `<324788905+felipemenegaz-debug@users.noreply.github.com>`:

| SHA | Assunto |
| --- | --- |
| `cf5d0a40932657d75121238d4febd48e8d531d6f` | recusa mudar a empresa de pacote, tabela ou adicional |
| `805343460d7e59114cb21f39869cf757dc2fad3a` | serializa a publicação e protege o preço publicado |
| `d0e79eff8d09d8b59e1d85fbfa190fb1893f8ab9` | clona a disponibilidade e audita a composição real uma vez |
| `b924c7f541577006e159944ff60296182533a567` | grava o carimbo de publicação persistido |
| `5c954b865dcbabe5f002139d67f4055d62d6e49e` | devolve a empresa comprovada em vez de recusar sempre |
| `645cb1f91bad2550838f87e4991e939b9c3e8e16` | prova no PostgreSQL descartável |

### Classificação

- P0-02 residual: CONFIRMADO. A 034 só guardava INSERT/UPDATE das chaves do vínculo. `UPDATE` de `empresa_id` no pai atravessava o tenant. Fechado na 036, no banco.
- P1-01: CONFIRMADO. A revisão clonava adicional, buffet e desconto, e não clonava `regras_disponibilidade_pacote`. Não havia outra relação do significado operacional do pacote sem clone. `precos_pacote` continua fora. Fechado no serviço.
- P1-03: CONFIRMADO. Publicação concorrente, DELETE do preço publicado, saída da tabela publicada, entrada imprópria e `ativo` que esvazia a publicação. Fechado na 037, no banco. HG-4 continua aberto só para completude comercial ainda não definida.
- Auditoria duplicada: CONFIRMADO. O serviço gravava `auditarMutacaoComercial` e ainda chamava o callback. A composição guardava o comando, não a relação. `publicadaEm` guardava o texto `clock_timestamp()`. Fechado: uma trilha na mesma transação.
- `recusarTenantNaoComprovado`: CONFIRMADO. O segundo `throw` disparava mesmo se a sessão depois comprovasse empresa. Hoje, sem prova, continua 403. Com prova injetada no teste, devolve essa empresa e recusa outra. Membership não foi implementada. O catálogo público permanece fechado até HG-8.
- P2-01 e P2-03: não tratados. A UX admin e o preço/data públicos não foram piorados.

### Gates que continuam abertos

- HG-6 aberto. Os sete pacotes legados seguem com `empresa_id` NULL. Não foram associados.
- HG-8 aberto. A Foundation 020 não foi copiada, alterada nem executada.
- HG-4 aberto. Publicar não exige todos os pacotes nem as duas categorias. Tabela vazia continua recusada.
- Fail-closed: sem empresa comprovada na sessão real, as rotas administrativas de pacote, composição, catálogo e tabela respondem 403 e não consultam o banco. O catálogo público permanece indeterminado.

### Migrations

Aplicadas nesta passagem só em `kidmais_pacotes_v1_descartavel` na porta `55498`, depois de `current_database()` e `inet_server_port()`. O banco `kidmais_pacotes_v1_rollback` não foi alterado.

- `20260926_036_empresa_pai_imutavel.sql` — gatilho em `pacotes`, `tabelas_preco` e `adicionais`. Recusa qualquer mudança de `empresa_id`. O precheck está dentro da migration e aborta se as duas empresas do vínculo estão preenchidas e são diferentes. Não reescreve linha. FK composta não foi usada: `empresa_id` nulo no legado, NULL/NULL continua válido, e o `pacote_adicional` histórico de `FESTA_LOCAL` para `SALADA_PREMIUM` sem empresa não pode ser reescrito sem inventar tenant. A 034 continua recusando vínculo novo com um lado nulo.
- `20260926_037_publicacao_concorrencia.sql` — `pg_advisory_xact_lock` por empresa antes de comparar vigências; DELETE de preço publicado recusado; mudança de tabela recusada; `ativo` true→false recusado quando esvazia a publicação; `observacoes` continua editável. O precheck aborta a migration se duas publicações da mesma empresa já se sobrepõem. Não despublica a tabela vazia que já existia (`TABELA_NOVA`).
- 020 e 026–028 continuam reservadas. A 023 não foi reescrita. O próximo número livre passa a ser 038.

Rollback: os DOWN da 036 e da 037 foram executados dentro de transação desfeita no banco principal. A guarda voltou. Nenhum DOWN foi deixado aplicado.

### Testes no PostgreSQL descartável

Banco `kidmais_pacotes_v1_descartavel`, `127.0.0.1:55498`, usuário `kidmais_descartavel`. Migrations 034 e 035 já estavam aplicadas. 036 e 037 foram aplicadas por `lib/comercial/pacotes-v1-remediacao.postgres.test.ts`. Resultado: 11 subtestes, 0 falhas.

- A migration 036, com um preço plantado entre duas empresas, abortou e não gravou a guarda. A aplicação limpa em seguida passou.
- Relação da mesma empresa passou. Pacote, tabela e adicional recusaram mudar de empresa. Insert A/B recusou na 034. NULL/NULL passou e foi desfeito.
- A migration 037 abortou com duas vigências publicadas sobrepostas. A aplicação limpa passou.
- DELETE, mover preço publicado para rascunho, mover rascunho para publicada, `ativo` true→false no único preço, segundo carimbo e tabela vazia foram recusados. `observacoes` passou. O rollback da transação desfez a publicação.
- Duas transações publicando tabelas sobrepostas da mesma empresa: uma confirmou, a outra falhou.
- Revisão de pacote utilizado clonou a disponibilidade exata e não clonou `precos_pacote`. A revisão anterior permaneceu.
- Composição: um evento, antes INCLUSO e depois EXTRA. Rollback sem evento.
- Publicação: `dados_depois.publicadaEm` igual ao `publicada_em` persistido, sem o texto `clock_timestamp()`. Rollback sem evento.
- Depois dos testes: 7 pacotes com `empresa_id` NULL. O vínculo `FESTA_LOCAL` → `SALADA_PREMIUM` sem empresa continua 1. `empresas` passou de 1 para 2 por causa do teste de concorrência, que precisa confirmar uma publicação: empresa `t037d9ecfac41` em `PROVISIONAMENTO`, tabela `u037ddd6ae271` publicada e `u037e1b8b609d` em rascunho. A exclusão física de empresa continua recusada, e o preço publicado não é apagado. Isso não associa os sete pacotes.

### Validação desta passagem

- `npx tsc --noEmit`: passou
- `npm run lint`: passou, exit 0
- `npm run build`: passou
- `git diff --check`: passou
- `node --test scripts/production/production.test.mjs`: 35 passaram
- Testes de serviço e rota da remediação anterior, mais `autorizacao-tenant.test.ts`: 36 passaram
- PostgreSQL descartável: 11 subtestes passaram, como acima

P0-02 residual, P1-01, P1-03 e a auditoria canônica transacional estão fechados nesta branch. HG-6 e HG-8 permanecem abertos. Parado para uma terceira revisão independente. Não é merge nem deploy.

## HISTÓRICO

O texto abaixo registra os marcos e a primeira remediação. Não é o estado atual. O estado atual é a seção anterior.

## Objetivo histórico

Entregar o Módulo Administrativo de Pacotes V1 com proteção histórica append-only, isolamento por empresa e administração de preços, sem comprometer fechamentos, contratos, preços ou documentos históricos.

## Branch histórica

`fix/v1-snapshot-comercial`

## HEAD da primeira remediação

Marco 0: `6801304b01a772a4e2c83a67c7256f74163d1c7d`.

Marco 1: `f076ce8e3aa795c582fc7448f40714c24236ae7f`.

Marco 2: `2b32828c9a99e09b11f731529d40c027e71961fb`.

Marco 3: `8b14e2fd4ec52b6e7dbf584205f0e2b538db443a`.

Marco 4: `7748666e4cf68b4a1e9a5c397ce82267c9a85ec8`.

Marco 5: `1581c31408b0fd8d41a1ba276fa97e7ccf71857f`.

Marco 6: `7c6ee02c637cba57e30bb158061917940b83b0fb`.

Marco 7: `88f0d88fa93be3cf76c2183396c1c5c630ec9527`.

Marco 8: `78e03c0b799c166d13f3874f7e28f26cd393cff7`.

Marco 9: `0659565ee19c393f9fd879882daeb7902e90cca6`.

Marco 10: `9e5d21b7299fcef82eaef1dadd2823914756a624`.

Revisão NO-GO, a partir de `6411a2d32758f5537ce52b3a30214e75e56ec85a`:

- `74891a6` recusa operação administrativa de tenant sem empresa comprovada.
- `49ca25f` recusa vínculo comercial entre empresas.
- `8f7b2ce` fotografa toda mudança comercial persistida do fechamento.
- `7a3da45` clona a composição na revisão de pacote utilizado.
- `8f0d0de` fecha o catálogo público sem empresa comprovada.
- `84ffd1f` valida a tabela antes de publicar.
- `990451e` audita mutação comercial na mesma transação.
- `2e8c300` ajusta o tipo do mock da fotografia.
- `feae45b` remove argumento não usado nas rotas que falham fechadas.

HISTÓRICO: o commit de status da primeira remediação era o HEAD daquela passagem. HG-6 e HG-8 já estavam abertos.

## Marco da primeira aplicação no banco descartável

Os Marcos 0–10 estão no código. Em 2026-09-26 as migrations 001–025 e 029–033 foram aplicadas num cluster PostgreSQL 17 criado só para esta tarefa, em `127.0.0.1:55498`, bancos `kidmais_pacotes_v1_descartavel` e `kidmais_pacotes_v1_rollback`. Não é `kidmais_manager`, nem staging, nem produção, nem o banco do Perfil na porta 55432. Pré e pós-checks de 029–033 passaram. O rollback da 030 rodou no segundo banco e removeu a função e os gatilhos.

O smoke no banco descartável confirmou: sete pacotes sem `empresa_id` e com duração nula; `empresas` vazia antes do uso administrativo; fotografia recusa UPDATE e DELETE; preço referenciado recusa mudança de valor e aceita `observacoes`; preço livre continua editável; exclusão física de empresa é recusada. O fechamento sintético do smoke foi desfeito na mesma transação.

No browser, em `http://localhost:3000` apontando só para esse banco: lista vazia da empresa nova, criação de pacote, composição de incluso e de buffet, recusa ao transformar incluso em extra pago, histórico, simulação `AUSENTE` e `SOB_CONSULTA`, criação de vigência e publicação. A tabela publicada ficou com `ativa = false`. Os sete pacotes legados seguem sem empresa.

Depois disso, `POST /api/fechamentos` no mesmo servidor criou um fechamento Essencial. A fotografia nasceu na mesma transação, com duração nula, quatro categorias de buffet e nenhum extra. O contrato gerado ficou no schema 2, com `pacoteAplicado.nome` igual a “Festa Essencial”. Alterar o nome vivo do pacote não mudou o snapshot gravado, e o `UPDATE` da fotografia foi recusado. O PDF oficial ainda exige revisão documental; essa etapa não foi forçada. O teste de documento schema 2 confere que o texto usa o nome congelado.

A troca administrativa antes da assinatura, no fechamento `6233a052-9b2a-4c86-8d79-651911ca5023`, trocou Essencial por Completa. A fotografia 1 permanece Essencial. A fotografia 2 é Completa, vigente, com motivo e ponteiro para a anterior. A auditoria `ALTERACAO_ADMINISTRATIVA` foi gravada. O contrato já emitido continua com Essencial no schema 2. Uma leitura nova, `carregarSnapshot`, devolve schema 2 com Completa. O texto oficial renderizado do contrato gravado contém “Festa Essencial”; o texto da fotografia vigente contém “Festa Completa”. Os 37 testes de documento passaram, inclusive o schema 2 e os templates históricos. Numa transação depois desfeita, a versão foi marcada como assinada só com os campos que o banco exige para esse estado. A troca de pacote foi recusada com “Após assinatura, prepare a alteração em uma nova versão pelo painel de Contratos.” Depois do rollback, a versão voltou a `ATIVA`, o contrato gravado continuou Essencial e as duas fotografias permaneceram. Nenhuma assinatura foi persistida.

No mesmo banco, a cópia administrativa `FESTA_COPIA` foi duplicada, editada enquanto não utilizada, desativada, reativada e arquivada. A restauração do arquivado foi recusada. Uma segunda empresa, criada e desfeita na mesma transação, não conseguiu editar o pacote da primeira. Os sete pacotes legados continuam sem `empresa_id`. A função e os dois gatilhos da 030 estão no banco principal e ausentes no banco de rollback.

O typecheck passou. `npm run lint` passou depois de o ESLint ignorar pastas locais já cobertas pelo `.gitignore` e builds `.next` aninhados.

## Marcos concluídos

- Marco 0 — caracterização, sem corrigir comportamento.
- Marco 1 — fotografia append-only na criação do fechamento.
- Marco 2 — contrato com fotografia usa schema 2; schema 1 permanece.
- Marco 3 — troca explícita pré-assinatura cria nova fotografia, preserva a anterior e exige motivo.
- Marco 4 — preço utilizado não tem atributos de cálculo reescritos. `ativo`, `observacoes` e `atualizado_em` continuam editáveis.
- Marco 5 — `empresas` vazia no shape da 020, sem o arquivo 020 e sem a Kidmais. `empresa_id` nulo nos pacotes atuais.
- Marco 6 — API admin lista, consulta, cria, duplica, edita revisão livre, cria revisão quando utilizada, ativa, desativa, arquiva e mostra histórico. Sem exclusão física. Restaurar arquivado permanece recusado.
- Marco 7 — vínculo INCLUSO não vira EXTRA. Completa não recebe salada premium inclusa. Premium mantém salada premium inclusa. A 023 não foi reescrita. Pizza usa mínimo e máximo persistidos quando os dois existem; senão permanece 20–100. Compacta sem preço continua sob consulta.
- Marco 8 — página `/admin/configuracoes/pacotes` no admin atual. O PDF permanece “Tabela de pacotes e preços”. Não há ação Excluir. `docs/ux/admin-v1` não foi copiado porque só existe em `review/v1-perfil-empresa`.
- Marco 9 — a prévia pública lê nome, descrição, duração, limites e menor preço vigente em `/api/fechamentos/pacotes`. A lista continua restrita aos sete códigos contratáveis, então criar um pacote não o publica. Inclusos cobrados saem de `pacote_adicionais` com modalidade INCLUSO.
- Marco 10 — rascunho de tabela por empresa, simulação e publicação em `publicada_em`. A simulação da empresa lê a tabela publicada cuja vigência cobre a data da festa. A publicação não dá `UPDATE` em fechamentos, não exige PDF e não liga `ativa`. Quando a coluna `empresa_id` existe, o fechamento público continua só na tabela legada sem empresa.

## Decisões aplicadas

- Base `origin/staging` `c54a809`. Sem `origin/main` e sem `review/v1-perfil-empresa`.
- Migrations novas começam em `20260926_029`. 020 e 026–028 não foram copiadas.
- Fotografia em `fechamento_pacote_snapshots` + `fechamento_pacote_composicao`. Ponteiro `fechamentos.pacote_snapshot_vigente_id`. Sem backfill.
- Duração e descrição gravadas como o fato do cadastro, inclusive `NULL`. Sem 240 inventado.
- Composição congela só INCLUSO e categorias de buffet ativas. Não copia extras pagos nem escolhas do cliente.
- Empresas vazia no shape da 020 continua decisão do Marco 5. Os sete pacotes atuais seguem sem empresa (HG-6).

## Migrations criadas

- `database/migrations/20260926_029_fechamento_pacote_snapshot.sql`
- `database/checks/20260926_029_precheck.sql`
- `database/checks/20260926_029_postcheck.sql`
- `database/migrations/20260926_030_preco_utilizado.sql`
- `database/rollback/20260926_030_preco_utilizado_down.sql`
- `database/checks/20260926_030_precheck.sql`
- `database/checks/20260926_030_postcheck.sql`
- `database/migrations/20260926_031_empresas_comercial.sql`
- `database/checks/20260926_031_precheck.sql`
- `database/checks/20260926_031_postcheck.sql`
- `database/migrations/20260926_032_pacote_revisao.sql`
- `database/checks/20260926_032_precheck.sql`
- `database/checks/20260926_032_postcheck.sql`

Aplicadas em 2026-09-26 somente no cluster descartável `127.0.0.1:55498`. O rollback da 030 foi executado no banco `kidmais_pacotes_v1_rollback`. Nenhum banco real foi acessado.

## Testes executados

Sem banco, no Marco 2:

- `lib/contratos/services/fotografia-pacote.test.ts` — 3 passaram
- `lib/contratos/documento/documento-core.test.ts` — 37 passaram, inclusive o schema 2 e os PDFs históricos
- `lib/contratos/services/snapshot-core.test.ts` — 4 passaram
- `lib/comercial/caracterizacao-comercial-v1.test.ts` — 6 passaram
- `npx tsc --noEmit` — passou

No Marco 3, sem banco:

- `lib/fechamentos/services/pacote-snapshot.test.ts` — criação e correção passaram
- `lib/comercial/caracterizacao-comercial-v1.test.ts` — 6 passaram
- `npx tsc --noEmit` — passou

No Marco 4, sem banco:

- `lib/fechamentos/services/preco-utilizado.test.ts` — 2 passaram
- `scripts/production/production.test.mjs` — 35 passaram

No Marco 5, sem banco:

- `lib/comercial/tenant.test.ts` — 2 passaram
- `scripts/production/production.test.mjs` — 35 passaram

No Marco 6, sem banco:

- `lib/comercial/pacotes-admin.test.ts` — 3 passaram
- `npx tsc --noEmit` — passou
- `scripts/production/production.test.mjs` — 35 passaram

No Marco 7, sem banco:

- `lib/comercial/composicao.test.ts` — 3 passaram
- `lib/comercial/pizza-party.test.ts` — 4 passaram
- `npx tsc --noEmit` — passou

No Marco 8, sem banco e sem browser:

- `components/admin/PacotesAdmin.test.ts` — 1 passou
- `npx tsc --noEmit` — passou

No Marco 9 e no Marco 10, sem banco e sem browser:

- `lib/comercial/composicao.test.ts` — 4 passaram
- `lib/comercial/tabelas-preco-admin.test.ts` — 3 passaram
- `lib/comercial/pizza-party.test.ts` — 4 passaram
- `lib/comercial/caracterizacao-comercial-v1.test.ts` — 6 passaram
- `scripts/production/production.test.mjs` — 35 passaram
- `npx tsc --noEmit` — passou

## Resultados

Fechamento com fotografia vigente gera contrato schema 2 a partir da fotografia, sem JOIN em `pacotes`/`tabelas_preco`. Sem fotografia, ou sem a migration 029, o schema 1 continua. PDF schema 2 usa o nome congelado. Schema 1 ainda substitui o nome pelo modelo oficial. Contratos já gravados não são convertidos.

## Riscos

- As migrations 029 a 033 foram aplicadas só no cluster descartável da porta 55498. O rollback da 030 foi executado no segundo banco desse cluster.
- O inventário de produção passou a aceitar 029–033. Continua recusando 020 e arquivos fora da lista. A sessão administrativa ainda não tem membership; o escopo é o `empresaId` informado e a linha precisa ter a mesma empresa.
- Sem a migration 029 aplicada, `lerFotografiaPacoteVigente` volta ao schema 1. Staging não quebra antes do HG-1.
- Depois da assinatura a edição continua recusada. A troca pré-assinatura só grava nova fotografia quando a tabela 029 existe.
- Não existe adicional `SALADA_TRADICIONAL` no catálogo. A regra da Completa recusa salada premium inclusa e não inventa esse item.
- A tela foi exercida em `localhost:3000` contra o banco descartável. O servidor anterior na porta 3311 recusou o login porque a origem administrativa não batia com o host. O banco de revisão do Perfil não foi usado.

## Relatório de gate — 2026-09-26

O Goal não está concluído. HG-6 e HG-8 permanecem abertos. Este relatório é só leitura. Nenhuma migration nova foi executada neste turno e nenhum banco foi alterado.

### 1. Estado Git

- HEAD: `8c59533294cd3a0cf6d3f701fcdd079ea52391c5`
- Branch: `fix/v1-snapshot-comercial`
- Base: `origin/staging` = `c54a809169b825e5dde25cac1385602bafa3faf3` (`git merge-base` igual a esse SHA)
- Relação com `origin/staging`: 22 commits à frente, 0 atrás
- Upstream: nenhum. A branch não foi enviada ao remoto.
- Working tree antes deste arquivo: limpa

Commits desde a base, do mais antigo ao mais novo:

| Commit | Marco |
| --- | --- |
| `6801304` test: freeze current commercial package behavior before historical snapshots | 0 |
| `f076ce8` feat: freeze the applied package when a fechamento is created | 1 |
| `ac906bc` docs: record the Pacotes V1 snapshot commit | 1, status |
| `2b32828` feat: make new contracts read the frozen package snapshot | 2 |
| `8b14e2f` feat: create a new package snapshot when an unsigned fechamento changes package | 3 |
| `7748666` feat: refuse calculation changes on a price line already used | 4 |
| `1581c31` feat: add an empty company foundation without assigning current packages | 5 |
| `7c6ee02` feat: add the tenant-scoped package admin API without physical delete | 6 |
| `88f0d88` feat: keep included items out of paid extras and honor persisted pizza limits | 7 |
| `78e03c0` feat: add the package admin screen without renaming the price PDF | 8 |
| `7d22104` docs: record the package admin screen commit | 8, status |
| `63831f1` docs: store the full package screen commit | 8, status |
| `0659565` feat: let the public preview read the stored package instead of marketing copy | 9 |
| `8a48753` docs: record package preview and price table commits | 9–10, status |
| `9e5d21b` feat: add price table drafts that publish without rewriting past fechamentos | 10 |
| `1802902` feat: price a published company table by the party date | 10 |
| `19aa1c9` docs: record the disposable database smoke and browser pass | evidência |
| `2570d17` docs: record the disposable fechamento and schema 2 contract | evidência |
| `42ead1f` docs: record the pre-signature package snapshot swap | evidência |
| `009059e` docs: record that a fresh contract read uses the current snapshot | evidência |
| `3a4099e` docs: record the rolled-back post-signature refusal | evidência |
| `8c59533` chore: ignore local scratch in lint and record the admin catalog proof | ver seção 7 |

### 2. Migrations desta branch

Não existe tabela de ledger. A execução abaixo é a sonda somente leitura de `127.0.0.1:55498` neste turno, mais o registro anterior de aplicação. 020, 026–028 e 999 não foram executadas em nenhum dos dois bancos.

| Arquivo | Finalidade | Depende de | DOWN |
| --- | --- | --- | --- |
| `20260926_029_fechamento_pacote_snapshot.sql` | Fotografia append-only e composição; ponteiro vigente. Sem backfill. | `fechamentos`, `pacotes`, `tabelas_preco`, `precos_pacote`, `regras_desconto_pacote`, `adicionais`, `pacote_adicionais`, `buffet_categorias`, `pacote_buffet_categorias`, `usuarios_administrativos` | não |
| `20260926_030_preco_utilizado.sql` | Recusa UPDATE de atributo de cálculo em preço já referenciado. | 029 e tabelas de preço, fechamento, adicionais e revisão | `database/rollback/20260926_030_preco_utilizado_down.sql` |
| `20260926_031_empresas_comercial.sql` | `empresas` vazia e `empresa_id` nulo em pacotes, tabelas e adicionais. Recusa se `empresas` já existir. | catálogo comercial; ausência de `empresas`, `estabelecimentos`, `memberships`, `membership_estabelecimentos` | não |
| `20260926_032_pacote_revisao.sql` | Revisão, vigência e arquivamento do pacote. | 031 e 029, mais `fechamentos` e `fechamento_revisoes` | não |
| `20260926_033_tabela_preco_publicacao.sql` | Coluna `publicada_em`. Não liga `ativa` nem recalcula fechamento. | `tabelas_preco.empresa_id` da 031 | não |
| `20260926_034_integridade_tenant_comercial.sql` | Guarda futura de vínculo cruzado em preço de pacote, composição e preço de adicional. Não reescreve linha. | catálogo com `empresa_id` | `database/rollback/20260926_034_integridade_tenant_comercial_down.sql` só remove função e gatilhos |
| `20260926_035_publicacao_tabela_invariantes.sql` | Guarda de publicação: tabela vazia, empresa, faixa e vigência. Não publica linha. HG-4 não define cobertura além de não vazia. | `publicada_em` e `empresa_id` | `database/rollback/20260926_035_publicacao_tabela_invariantes_down.sql` só remove função e gatilhos |

Checks de pré e pós existem para 029, 030, 031, 032 e 033. Não são rollback.

`kidmais_pacotes_v1_descartavel`: objetos da 029, 030, 031, 032 e 033 presentes. `estabelecimentos` ausente. Sete pacotes com `empresa_id` nulo. Uma empresa sintética. `pacote_buffet_categorias` e `festas` presentes, então o catálogo anterior à 029 também está nesse banco. Não há contagem arquivo a arquivo neste turno.

`kidmais_pacotes_v1_rollback`: fotografia da 029 presente. Função da 030 ausente. `empresas`, `empresa_id`, revisão e `publicada_em` ausentes. A 031, a 032 e a 033 não rodaram aí. O DOWN da 030 rodou nesse banco.

Não executadas em lugar nenhum desta tarefa: 020, 026, 027, 028, 999, e qualquer banco que não seja esses dois nomes na porta 55498.

HISTÓRICO, primeira passagem: o próximo número livre era **036**. Depois da 036 e da 037, o livre é 038.

A 034 foi aplicada em `kidmais_pacotes_v1_descartavel` na porta 55498 depois de confirmar `current_database` e `inet_server_port()`. O precheck recusou porque já existe um `pacote_adicional` cujo pacote tem empresa e cujo adicional tem `empresa_id` nulo. Essa linha não foi reescrita nem atribuída a uma empresa. A migration instalou só a guarda futura. Depois da aplicação, `empresas` continuou 1 e os pacotes sem empresa continuaram 7. O precheck da 034 continua recusando esse cluster até uma pessoa limpar o vínculo; este documento não autoriza essa limpeza.

A 035 passou no precheck e no postcheck do mesmo banco. Numa transação desfeita, a guarda recusou tabela vazia, preço de outra empresa, faixa sobreposta, novo preço em tabela publicada, segundo carimbo e vigência publicada sobreposta. Uma publicação estruturalmente válida passou e foi desfeita. Contagens depois do rollback: `empresas` 1, pacotes sem empresa 7, tabelas com `publicada_em` 1. A 035 não rodou no banco de rollback.

### 3. HG-6

Não há linha de `empresas` que o banco comprove como a Kidmais. Staging não tem a tabela. O nome da marca em comentário, seed de pacote ou `MODELOS_OFICIAIS` não é identidade de tenant. A única empresa no banco descartável foi inserida para o teste administrativo, com código `empresa-local`, e não é a Kidmais. Associar os sete pacotes exigiria inventar essa identidade. Isso permanece bloqueado. Nenhum `INSERT` por nome, marca ou inferência é proposto.

### 4. HG-8

Leitura de `origin/saas/foundation:database/migrations/20260923_020_saas_foundation.sql`. O arquivo não foi copiado nem alterado.

Colunas de `empresas` coincidem: `id`, `codigo`, `nome`, `status`, `criado_em`, `atualizado_em`, `desativado_em`. O check de código e os status textuais também coincidem.

Diferenças que impedem tratar as duas como a mesma migration:

- A 020 também cria `estabelecimentos`, `memberships` e `membership_estabelecimentos`. A 031 não cria essas tabelas.
- Constraints e funções da 020 usam o prefixo `saas020_`. A 031 usa `empresas_*` e `kidmais_031_*`.
- A 020 exige gate de runtime: `saas020.runtime_roles`, `saas020.v1_pre_hash` e exatamente 63 tabelas públicas anteriores, além da ausência das quatro tabelas. A 031 só exige o catálogo comercial e a ausência das mesmas quatro tabelas.
- A 020 recusa fundação com linha. A 031 não tem esse gate no fim do arquivo. O banco descartável principal tem uma empresa sintética.
- O gatilho da 020 não permite `PROVISIONAMENTO` → `ATIVA`. A 031 permite, e zera `desativado_em` quando o status deixa de ser `DESATIVADA`. A 020 trata `desativado_em` como campo imutável fora da transição para `DESATIVADA`.
- A 020 fixa `SECURITY INVOKER`, `search_path` e hash do corpo das funções. A 031 não faz isso.
- A 031 ainda adiciona `empresa_id` e troca o unique global de código em `pacotes`, `tabelas_preco` e `adicionais`. Isso muda o schema V1 que a 020 confere por hash.
- Numeração: a 020 continua `20260923_020`. Esta branch usa `20260926_031` e o inventário de produção marca a 020 como ausente de propósito. Não há dois arquivos com o mesmo nome. O conflito é estrutural: quem criar `empresas` primeiro faz o gate de ausência do outro falhar.
- Risco de integrar: aplicar as duas na mesma base quebra um dos gates; recriar a tabela perde o shape ou os dados; alterar a 020 nesta branch misturaria as linhas. A sessão administrativa desta branch não tem membership.

O conflito não foi resolvido.

### 5. Marcos 0–10

- Concluídos no código e com evidência no banco descartável: 0, 1, 2, 3, 4, 7 e 9, no escopo já testado.
- Parciais: 6 e 8. A API e o serviço cobriram duplicar, editar revisão livre, desativar, reativar, arquivar, recusar restauração e recusar outra empresa. O browser cobriu lista, criação, composição, conflito, histórico, simulação e publicação. Nem todo botão de duplicar, editar e arquivar foi clicado na tela.
- Parcial: 10. A tabela administrativa publica e simula pela data da festa sem recalcular fechamento e sem exigir PDF. O fechamento público continua na tabela legada sem empresa.
- Bloqueado por HG-6: associar os sete pacotes atuais a uma empresa.
- Bloqueado por HG-8: tratar a `empresas` desta branch como a Foundation 020, ou aplicar a 020 aqui.
- Dependente do Admin Shell: o chrome V1 e `docs/ux/admin-v1` não foram trazidos. A tela usa o admin atual. Restauração de arquivado continua recusada.
- Dependente de decisão: vínculo publicação↔PDF, papéis novos, exclusão física, herança por unidade e excedente configurável. Nenhum foi inventado.

### 6. Evidências

- Snapshot: fechamento `7c5e66da-a4da-43f4-93bb-6dba4e3ef850` nasceu com fotografia na mesma transação; duração nula; quatro categorias de buffet; nenhum extra. `UPDATE` da fotografia foi recusado.
- Troca pré-assinatura: fechamento `6233a052-9b2a-4c86-8d79-651911ca5023`. Fotografia 1 Essencial preservada. Fotografia 2 Completa vigente, com motivo e ponteiro anterior. Auditoria gravada. Contrato já emitido permaneceu Essencial.
- Recusa pós-assinatura: na mesma transação depois desfeita, a versão foi marcada assinada só com os campos que o check exige. A troca foi recusada com a mensagem do painel de Contratos. Depois do rollback a versão voltou a `ATIVA`, o contrato continuou Essencial e as duas fotografias permaneceram.
- Schema 2: `carregarSnapshot` depois da troca devolve Completa. O texto oficial do contrato gravado contém “Festa Essencial”; o da fotografia vigente contém “Festa Completa”.
- Schema 1 e documentos históricos: `documento-core.test.ts`, 37 testes, 0 falhas, inclusive schema 2 e templates históricos.
- Preço: smoke anterior recusou valor de linha referenciada e aceitou `observacoes`. Neste turno, somente leitura: a função `kidmais_030_preco_utilizado` e os dois gatilhos estão no banco principal e ausentes no banco de rollback.
- CRUD: no banco descartável, `FESTA_COPIA` foi duplicada, editada, desativada, reativada e arquivada. Restaurar o arquivado foi recusado. Não houve exclusão física.
- Cross-tenant: uma segunda empresa, inserida e desfeita na mesma transação, não editou o pacote da primeira.
- Typecheck: `npx tsc --noEmit` passou depois dos commits de código.
- Testes de serviço por marco, sem banco, registrados acima neste arquivo. Não foram todos reexecutados neste turno.
- Lint: ver a seção 7. O `npm run lint` com exit 0 não é sucesso global independente dessas exclusões.

O PDF em `GET /api/admin/contratos/pdf` não foi emitido. A rota respondeu que o documento ainda não foi revisado. Essa revisão não foi forçada.

### 7. Ignore de lint

O commit `8c59533` já está no HEAD. Ele acrescenta a `eslint.config.mjs` os padrões `**/.next/**`, `.local-*/**`, `.tmp/**` e `.backups/**`.

Antes disso, `npm run lint` falhou só em artefato local desta máquina:

- `.local-catalogo-browser/.next/**`, com `require` e símbolos de build do webpack
- depois de ignorar `.next` aninhado, ainda `.local-catalogo-browser/lib/db/postgres.ts` (`no-explicit-any`) e `.tmp/catalogo025-apply.cjs` (`no-require-imports`)

`npx eslint lib app components scripts --max-warnings 0` passou sem esses padrões. `.local-catalogo-browser` e `.tmp` já estão no `.gitignore`. A mudança não corrige produto; só impede o ESLint de ler pasta local. Ela não deveria ter entrado como regra de produto. Não foi revertida neste turno para não alterar mais nada além deste status. Uma decisão humana pode retirar esse hunk.

### 8. Definition of Done

- Branch a partir de `origin/staging`, commits por marco e status: PASS
- Caracterização do Marco 0 sem correção silenciosa: PASS
- Fechamento novo com fotografia e composição na mesma transação; legado sem backfill: PASS no banco descartável
- Contrato e texto schema 2 usam a fotografia: nesta remediação, `fotografia-caminhos.test.ts` renderizou o texto oficial e o PDF com o nome congelado. Os 37 testes de documento não foram reexecutados neste turno
- PDF HTTP do contrato novo: PARCIAL. O texto oficial foi renderizado; o endpoint não emitiu o arquivo
- Troca pré-assinatura com nova fotografia, auditoria e motivo: PASS
- Pós-assinatura não substitui: PASS, com a marcação de assinatura desfeita na mesma transação
- Preço utilizado protegido e rollback da 030 no banco descartável: PASS
- Isolamento por `empresa_id` e teste negativo: FAIL-CLOSED. A sessão não comprova empresa. As rotas administrativas de pacote, composição, catálogo e tabela respondem 403 e não consultam o banco. O teste de rota cobre usuário A operando a empresa B. Não há membership e isso não foi inventado
- Sete pacotes na empresa Kidmais: BLOQUEADO, HG-6
- API administrativa sem exclusão física: PASS quanto à ausência de DELETE. O CRUD de tenant está bloqueado em 403 até existir empresa comprovada no servidor. A tela ainda envia `empresaId` e recebe essa recusa. Isso não foi reaberto para manter o botão funcionando
- UX de todas as operações no browser: NÃO REEXECUTADA nesta remediação. O admin de pacotes fica atrás do 403. P2-01 permanece aberto
- Hardcodes removidos só onde o domínio sustenta: não reavaliado neste turno
- Admin de tabelas separado, sem recalcular histórico e sem exigir PDF: a rota está em 403. O serviço recusa tabela vazia, pacote de outra empresa, faixa inválida ou sobreposta, vigência publicada sobreposta e publicação concorrente. HG-4 continua aberto: não se exige precificar todos os pacotes nem as duas categorias
- Fechamento público e catálogo por código: FAIL-CLOSED. O mesmo código em duas empresas não é escolhido. `ativo` não publica. Preço e data do fluxo público (P2-03) não foram refeitos
- Typecheck nesta remediação: PASS (`npx tsc --noEmit` e o TypeScript do `next build`)
- Lint nesta remediação: PASS (`npm run lint`, exit 0, sem aviso). Os ignores locais já existentes não foram ampliados
- Build nesta remediação: PASS (`npm run build`)
- Smoke anterior no banco descartável: evidência do turno anterior, não desta remediação. Nesta remediação, a 034 e a 035 foram aplicadas só em `kidmais_pacotes_v1_descartavel` na porta 55498, com a prova da 035 desfeita
- Nenhuma migration em banco real e nenhum merge: PASS
- HISTÓRICO, primeira passagem: o push ainda não tinha sido afirmado. O push desta segunda passagem é o passo depois deste arquivo, sem force
- Admin Shell V1: BLOQUEADO por dependência de integração. Não é HG-6 nem HG-8, e não foi copiado
- Foundation 020 compatível com esta `empresas`: BLOQUEADO, HG-8

### 9. Próxima decisão humana

Nenhuma alternativa abaixo foi escolhida.

1. Manter a 031 como fatia comercial e alterar a 020 só na linha SaaS, para o gate de ausência aceitar uma `empresas` já compatível. Pró: o módulo desta branch continua. Risco: a 020 ainda exige 63 tabelas, hash V1, fundação vazia e proíbe `PROVISIONAMENTO` → `ATIVA`.
2. Retirar o `CREATE TABLE empresas` desta linha e deixar a 020 dona da tabela, conservando apenas `empresa_id` e as FKs. Pró: uma definição de `empresas`. Risco: a 031 atual recusa rodar se a tabela já existe, e a 020 recusa rodar se ela já existe; a ordem e o hash V1 precisam de outra migration.
3. Integrar primeiro a linha SaaS e só então pendurar `empresa_id` na tabela da 020. Pró: memberships e gatilhos ficam na Foundation. Risco: o módulo que ativa empresa em `ATIVA` contraria o gatilho da 020, e as migrations 029–033 já mudam o schema que a 020 congela.
4. Deixar as duas linhas sem merge até uma migration de compatibilidade que não copie a 020 e não crie uma segunda `empresas`. Pró: nenhum conflito é resolvido por acidente. Risco: esta branch não pode ir para uma base que também receberá a 020 enquanto essa decisão não existir. Este é o estado congelado agora.

## HISTÓRICO — primeira remediação NO-GO

Classificação da primeira passagem. A segunda remediação, no topo deste arquivo, fecha o residual de P0-02, o clone da disponibilidade, a publicação concorrente e a auditoria duplicada. Esta lista não é o estado atual.

- P0-01 confirmado e fechado em 403. Teste de rota, não só helper.
- P0-02 confirmado na primeira passagem só para o vínculo. A mudança de `empresa_id` no pai ficou para a 036.
- P0-03 confirmado. Edição administrativa, revisão operacional, revisão inicial e o fluxo público que as chama fotografam o estado persistido. Depois da assinatura a fotografia antiga não é reescrita.
- P1-01 confirmado na primeira passagem só para adicional, buffet e desconto. A disponibilidade ficou para a segunda passagem.
- P1-02 confirmado. Catálogo público e busca por código falham fechados.
- P1-03 confirmado na primeira passagem no serviço e na 035. Concorrência, DELETE e mudança de tabela ficaram para a 037.
- P2-02 feito no serviço de tabela, preço, pacote e composição. A auditoria de fechamento já existente carrega o id da fotografia e a empresa quando a fotografia a devolve. A duplicidade do callback foi removida na segunda passagem.
- P2-01 e P2-03 não foram feitos.
- P3-01: 034 e 035 documentam quando o rollback só remove a guarda, quando ele é recusado como conserto de dado, e que a aplicação anterior convive com o schema aditivo. A 023 não foi reescrita. A 020 e a 026–028 continuam reservadas.

## Human Gates pendentes

- HG-6: aberto. Não associar os sete pacotes.
- HG-8: aberto. A 020 não foi copiada, alterada nem executada. O conflito de `empresas` não foi resolvido.
- HG-4: aberto. Publicar não inventa cobertura de todos os pacotes nem das duas categorias. Tabela vazia continua recusada.
- HG-1, HG-2, HG-3, HG-5 e HG-7: não acionados. Restaurar arquivado continua recusado, sem virar decisão nova.

## Arquivos principais alterados

- `database/migrations/20260926_029_fechamento_pacote_snapshot.sql`
- `database/checks/20260926_029_precheck.sql`
- `database/checks/20260926_029_postcheck.sql`
- `lib/fechamentos/services/pacote-snapshot.ts`
- `lib/fechamentos/services/pacote-snapshot.test.ts`
- `lib/fechamentos/services/fechamento.service.ts`
- `lib/comercial/caracterizacao-comercial-v1.test.ts`
- `scripts/production/check-migrations.mjs`
- `scripts/production/production.test.mjs`
- `lib/contratos/services/fotografia-pacote.ts`
- `lib/contratos/services/contrato.service.ts`
- `lib/contratos/documento/oficial/festas-v2.ts`
- `docs/work/PACOTES-V1-STATUS.md`
