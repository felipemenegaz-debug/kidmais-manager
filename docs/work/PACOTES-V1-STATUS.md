# Pacotes V1 — status de engenharia

Documento temporário de continuidade. Não é fonte funcional. A decisão de produto permanece no Second Brain e no Goal Mestre.

## Objetivo

Entregar o Módulo Administrativo de Pacotes V1 com proteção histórica append-only, isolamento por empresa e administração de preços, sem comprometer fechamentos, contratos, preços ou documentos históricos.

## Branch

`fix/v1-snapshot-comercial`

Sem upstream. Não fazer push para `staging` nem `main`.

## Base SHA

`c54a809169b825e5dde25cac1385602bafa3faf3`

Confirmado após `git fetch origin` em 2026-09-26. `origin/staging` não avançou.

## HEAD atual

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

## Marco atual

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

Checks de pré e pós existem para 029, 030, 031, 032 e 033. Não são rollback.

`kidmais_pacotes_v1_descartavel`: objetos da 029, 030, 031, 032 e 033 presentes. `estabelecimentos` ausente. Sete pacotes com `empresa_id` nulo. Uma empresa sintética. `pacote_buffet_categorias` e `festas` presentes, então o catálogo anterior à 029 também está nesse banco. Não há contagem arquivo a arquivo neste turno.

`kidmais_pacotes_v1_rollback`: fotografia da 029 presente. Função da 030 ausente. `empresas`, `empresa_id`, revisão e `publicada_em` ausentes. A 031, a 032 e a 033 não rodaram aí. O DOWN da 030 rodou nesse banco.

Não executadas em lugar nenhum desta tarefa: 020, 026, 027, 028, 999, e qualquer banco que não seja esses dois nomes na porta 55498.

Próximo número livre, respeitando a reserva da 020 e da 026–028: **034**.

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
- Contrato e texto schema 2 usam a fotografia; schema 1 e documentos históricos intactos: PASS
- PDF HTTP do contrato novo: PARCIAL. O texto oficial foi renderizado; o endpoint não emitiu o arquivo
- Troca pré-assinatura com nova fotografia, auditoria e motivo: PASS
- Pós-assinatura não substitui: PASS, com a marcação de assinatura desfeita na mesma transação
- Preço utilizado protegido e rollback da 030 no banco descartável: PASS
- Isolamento por `empresa_id` e teste negativo: PASS
- Sete pacotes na empresa Kidmais: BLOQUEADO, HG-6
- API administrativa sem exclusão física: PASS
- UX de todas as operações no browser: PARCIAL
- Hardcodes removidos só onde o domínio sustenta: PASS
- Admin de tabelas separado, sem recalcular histórico e sem exigir PDF: PASS
- Fechamento público consumindo a tabela publicada da empresa: NÃO EXECUTADO. Continua na tabela legada sem empresa, de propósito, até decisão
- Typecheck: PASS
- Lint do código da branch: PASS
- `npm run lint` no repositório inteiro: PARCIAL. Passou só depois de excluir artefato local; ver seção 7
- Smoke no banco descartável: PASS
- Nenhuma migration em banco real e nenhum merge: PASS
- Push da branch: NÃO EXECUTADO. Sem upstream; o push anterior foi recusado por GH007 e não foi repetido
- Admin Shell V1: BLOQUEADO por dependência de integração. Não é HG-6 nem HG-8, e não foi copiado
- Foundation 020 compatível com esta `empresas`: BLOQUEADO, HG-8

### 9. Próxima decisão humana

Nenhuma alternativa abaixo foi escolhida.

1. Manter a 031 como fatia comercial e alterar a 020 só na linha SaaS, para o gate de ausência aceitar uma `empresas` já compatível. Pró: o módulo desta branch continua. Risco: a 020 ainda exige 63 tabelas, hash V1, fundação vazia e proíbe `PROVISIONAMENTO` → `ATIVA`.
2. Retirar o `CREATE TABLE empresas` desta linha e deixar a 020 dona da tabela, conservando apenas `empresa_id` e as FKs. Pró: uma definição de `empresas`. Risco: a 031 atual recusa rodar se a tabela já existe, e a 020 recusa rodar se ela já existe; a ordem e o hash V1 precisam de outra migration.
3. Integrar primeiro a linha SaaS e só então pendurar `empresa_id` na tabela da 020. Pró: memberships e gatilhos ficam na Foundation. Risco: o módulo que ativa empresa em `ATIVA` contraria o gatilho da 020, e as migrations 029–033 já mudam o schema que a 020 congela.
4. Deixar as duas linhas sem merge até uma migration de compatibilidade que não copie a 020 e não crie uma segunda `empresas`. Pró: nenhum conflito é resolvido por acidente. Risco: esta branch não pode ir para uma base que também receberá a 020 enquanto essa decisão não existir. Este é o estado congelado agora.

## Próximos passos

Parado no Human Gate. Não resolver HG-6 nem HG-8. Não fazer merge, deploy, push, nem migration adicional. O fechamento público continua na tabela legada sem empresa.

## Human Gates pendentes

- HG-6: aberto. Não associar os sete pacotes.
- HG-8: aberto. A 020 não foi copiada, alterada nem executada. O conflito de `empresas` não foi resolvido.
- HG-1, HG-2, HG-3, HG-4, HG-5 e HG-7: não acionados. Restaurar arquivado continua recusado, sem virar decisão nova.

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
