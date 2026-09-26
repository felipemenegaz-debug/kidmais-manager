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

Marco 1: o commit que inclui este arquivo. Conferir `git log -1` depois do commit.

## Marco atual

Marco 1 concluído no código. Marco 2 ainda não começou.

## Marcos concluídos

- Marco 0 — caracterização, sem corrigir comportamento.
- Marco 1 — fotografia append-only na criação do fechamento.

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

Não executadas. Não há `psql`/`createdb` no PATH e nenhum banco descartável foi criado. Nenhum banco real foi acessado.

## Testes executados

Sem banco:

- `lib/comercial/caracterizacao-comercial-v1.test.ts` — 6 passaram
- `lib/fechamentos/services/pacote-snapshot.test.ts` — 1 passou
- `scripts/production/production.test.mjs` — 35 passaram
- `npx tsc --noEmit` — passou

## Resultados

Fechamento novo chama `gravarFotografiaPacoteFechamento` na mesma transação, depois dos adicionais. UPDATE/DELETE da fotografia são recusados pelo trigger. Fechamentos antigos permanecem sem ponteiro. A edição administrativa pré-assinatura ainda não cria nova fotografia (Marco 3).

## Riscos

- A migration 029 não foi aplicada em PostgreSQL. A primeira aplicação precisa ser num banco local descartável, com precheck e postcheck.
- O inventário de produção passou a aceitar a 029. Continua recusando 020 e arquivos fora da lista.
- Contrato ainda lê o cadastro vivo. PDF v2 ainda sobrescreve o nome.

## Próximos passos

Marco 2: contrato com fotografia usa schema novo; schema 1 e PDF histórico permanecem. Remover só a substituição de nome em `festas-v2.ts` quando o schema novo já tem nome congelado.

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
- `docs/work/PACOTES-V1-STATUS.md`
