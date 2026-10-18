# Marketing — preparação da integração para staging (18/10/2026, somente local)

**Goal:** nota do vault `Goal Preparacao Integracao Marketing Staging`.

**O que esta preparação é:** candidata local integrada, plano de banco e plano de staging para revisão e autorização posteriores. **Não houve** fetch remoto, push, PR, merge remoto, deploy, acesso a banco, SQL, migration aplicada, alteração de variáveis nem mensagem real.

## Linhagem

| Papel | Commit | Observação |
|---|---|---|
| Base (staging) | `271c4ce` | `origin/staging` no fetch local mais recente (18/10/2026 04:10); atualidade remota não confirmada |
| Marketing aprovado | `815314b` (pai `7d299a2`) | revisões independentes locais aprovadas; F-1 latente pendente |
| Renumeração 1 | `25f55f4` (sobre `815314b`) | migrations do Marketing 083→084 e 084→085 (a 083 é do WhatsApp) |
| Integração | `9052db0` (merge `271c4ce` + `25f55f4`) | 3 conflitos de inventário resolvidos por união; modelo 083 para o teste das migrations do Marketing |
| Documentação | `fc194dd` | primeira versão deste documento e a correção O-1 |
| Renumeração 2 | `4e80b81` | Marketing 084→**085** e 085→**086**: a 084 passou a ser de Convites (PR #176), descoberta depois de `fc194dd` |
| Composição com staging + PR #176 | `c5e3303` (merge `4e80b81` + `87bedb8`) | `87bedb8` = `origin/staging` no fetch local de 05:50 (merge da PR #176, `e40ca5b`); listas do inventário por união; modelo `084` na receita; teste das migrations do Marketing sobre o modelo 084; suítes do WhatsApp também no 086 |
| Documentação | commit seguinte | esta atualização |

## Renumeração das migrations do Marketing

- **083** é `20261016_083_whatsapp_conexao_empresa.sql`: aplicada em staging em 16/10/2026, segundo registro documental (não confirmado aqui).
- **084** é `20261018_084_convite_geracao_pendencias.sql`, da PR #176 (`e40ca5b`, sobre a mesma base `271c4ce`): aplicada em staging em 18/10/2026 ~08:33Z, segundo registro documental (não confirmado aqui). Os checks dela têm o **mesmo nome de arquivo** dos checks do Marketing na renumeração 1 (`database/checks/20261018_084_{pre,post}check.sql`). Por isso a renumeração 1 deixou de servir.
- Desde `c5e3303`, ela **está nesta linha** (via `87bedb8`). A PR de produção correspondente (`5daff81`, sobre `b1b7f2a`) não é pertinente a staging e não entrou.
- O **Marketing** passa a:

| Antes (histórico) | Renumeração 1 (descartada para staging) | Agora |
|---|---|---|
| `database/migrations/20261014_083_marketing_base.sql` | `20261018_084_marketing_base.sql` | `database/migrations/20261018_085_marketing_base.sql` |
| `database/migrations/20261014_084_marketing_automacoes.sql` | `20261018_085_marketing_automacoes.sql` | `database/migrations/20261018_086_marketing_automacoes.sql` |
| `database/checks/20261014_08{3,4}_{precheck,postcheck}.sql` | `20261018_08{4,5}_…` | `database/checks/20261018_08{5,6}_{precheck,postcheck}.sql` |
| `database/rollback/20261014_08{3,4}_*_down.sql` | `20261018_08{4,5}_…` | `database/rollback/20261018_08{5,6}_*_down.sql` |
| funções `kidmais083_*` / `kidmais084_*` | `kidmais084_*` / `kidmais085_*` | `kidmais085_*` / `kidmais086_*` |
| `lib/marketing/migration-083-084.postgres.test.ts` | `migration-084-085…` | `lib/marketing/migration-085-086.postgres.test.ts` |

- **Ordem no alvo:** 083 → 084 (Convites) → 085 → 086. A 085 exige 031/043/054/062; a 086 exige a 085. A 084 de Convites só altera `convite_geracoes`; o Marketing não a referencia, e ela não referencia o Marketing.
- **Fora dos identificadores:** regras, restrições e gatilhos não mudaram.
- **Docs anteriores:** os documentos de 14–17/10 citam os números antigos, como registro histórico.
- **Integração da PR #176 (`c5e3303`):** conflito textual só nas listas de `check-migrations.mjs` e `production.test.mjs`, resolvido por união (084 antes da 085). Receita com modelo `084`; `migration-085-086` sobre ele; constantes do teste `PRE083`/`PRE084` corrigidas para `PRE085`/`PRE086` (sobras da renumeração; já liam os checks certos).

## Validação local (sem banco)

| Prova | Árvore | Resultado |
|---|---|---|
| `check:v1:static` (testes V1, harness de staging, lint, TypeScript, build de produção, PDF) | cópias LF de `9052db0` e `fc194dd` | **PASS** (3188/3188 testes V1; 103/103 harness) |
| Testes sem banco pertinentes (Marketing, guardião, diálogo, Pix, navegação, inventário, aplicador 083, webhook Meta, autenticação, arquitetura, pop-up WhatsApp) | idem | **212/212** |
| Inventário de migrations / `production.test.mjs` | `9052db0` | sem bloqueadores / 37/37 |
| Navegador em `next start` (build de produção), APIs sintéticas na página | `9052db0` | 6/7 PASS (telas desktop e celular, plano sem Marketing, proteção da edição com/sem Navigation API, unidade); rotas públicas: 3 controladas + 2 **não verificáveis sem banco** |
| Gates sem banco na árvore da renumeração 2 (`4e80b81`) | cópia LF | PASS (ver pacote `revisao-marketing-preparacao-staging-4e80b81-20261018`) |
| Gates sem banco na composição com a PR #176 | commit final | repetidos em cópia LF própria; resultado no pacote de revisão da composição |
| Testes PostgreSQL | — | **NÃO EXECUTADOS** (exigem autorização própria) |

## Pendências

- **Decisões de produto:** F-1, O3, O4; plano/preço do recurso `MARKETING` (provisório em `profissional`/`premium`).
- **Worker:** só aceita localhost (não implantar em staging sem decisão própria).
- **Aplicador de staging da 085/086:** ainda a preparar.
- **Atualidade:** `87bedb8` vem de fetch local de 05:50; se `origin/staging` avançou, refazer o merge e os gates.
- **Revisão independente** da árvore integrada.
- **Gates PostgreSQL:** pendentes.

O mapa, a matriz e os planos completos estão no pacote de revisão desta preparação:
- `MAPA-INTEGRACAO.md`;
- `MATRIZ-MIGRATIONS.md`;
- `PLANO-STAGING.md`;
- `PLANO-TESTES-POSTGRES.md`.
