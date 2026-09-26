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

## Próximos passos

O que depende de decisão humana permanece parado. O fechamento público continua na tabela legada `ativa` e sem empresa. A simulação administrativa é que lê a tabela publicada da empresa. HG-6 segue aberto: os sete pacotes não foram associados. Não houve merge nem migration em staging ou produção.

## Human Gates pendentes

- HG-6: não associar os sete pacotes atuais sem identidade comprovável.
- HG-8 decidido: `empresas` vazia no Marco 5; a 020 será reajustada depois. Não executar a 020.
- HG-1, HG-2, HG-3, HG-4, HG-5 e HG-7: não acionados.

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
