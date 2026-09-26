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

## Marco atual

Marco 8 está na UI do admin atual. A verificação no browser ainda não foi feita. Marcos 9 e 10 não começaram.

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

Não executadas. Não há `psql`/`createdb` no PATH e nenhum banco descartável foi criado. Nenhum banco real foi acessado.

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

## Resultados

Fechamento com fotografia vigente gera contrato schema 2 a partir da fotografia, sem JOIN em `pacotes`/`tabelas_preco`. Sem fotografia, ou sem a migration 029, o schema 1 continua. PDF schema 2 usa o nome congelado. Schema 1 ainda substitui o nome pelo modelo oficial. Contratos já gravados não são convertidos.

## Riscos

- As migrations 029 a 032 não foram aplicadas em PostgreSQL. Não há `psql`, `createdb` nem Docker. O rollback da 030 foi conferido pelo arquivo, sem execução. A primeira aplicação precisa ser num banco local descartável.
- O inventário de produção passou a aceitar 029–032. Continua recusando 020 e arquivos fora da lista. A sessão administrativa ainda não tem membership; o escopo é o `empresaId` informado e a linha precisa ter a mesma empresa.
- Sem a migration 029 aplicada, `lerFotografiaPacoteVigente` volta ao schema 1. Staging não quebra antes do HG-1.
- Depois da assinatura a edição continua recusada. A troca pré-assinatura só grava nova fotografia quando a tabela 029 existe.
- Não existe adicional `SALADA_TRADICIONAL` no catálogo. A regra da Completa recusa salada premium inclusa e não inventa esse item.
- O fluxo da tela de Pacotes não foi exercido no browser. O único servidor local visto aponta para o banco de revisão do Perfil e não foi usado.

## Próximos passos

Verificar no browser a tela de Pacotes num banco descartável. Depois, Marco 9: tirar só os hardcodes que o domínio novo já sustenta. Marco 10: admin de tabelas de preços, sem exigir PDF e sem recalcular fechamentos antigos.

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
