# Marketing — preparação da integração para staging (18/10/2026, somente local)

**Goal:** nota do vault `Goal Preparacao Integracao Marketing Staging`.

**O que esta preparação é:** candidata local integrada, plano de banco e plano de staging para revisão e autorização posteriores. **Não houve** fetch, push, PR, merge remoto, deploy, acesso a banco, SQL, migration aplicada, alteração de variáveis nem mensagem real.

## Linhagem

| Papel | Commit | Observação |
|---|---|---|
| Base (staging) | `271c4ce` | `origin/staging` no fetch local mais recente (18/10/2026 04:10); atualidade remota não confirmada |
| Marketing aprovado | `815314b` (pai `7d299a2`) | revisões independentes locais aprovadas; F-1 latente pendente |
| Renumeração | `25f55f4` (sobre `815314b`) | migrations do Marketing 083→**084** e 084→**085** |
| Integração | `9052db0` (merge `271c4ce` + `25f55f4`) | 3 conflitos de inventário resolvidos por união; modelo 083 para o teste das migrations do Marketing |
| Documentação | commit seguinte | este documento e a correção O-1 |

## Renumeração das migrations do Marketing

A **083** é `20261016_083_whatsapp_conexao_empresa.sql`: aplicada em staging em 16/10/2026, segundo registro documental (não confirmado aqui). Por isso o número dela não muda, e o Marketing passa a:

| Antes (histórico) | Agora |
|---|---|
| `database/migrations/20261014_083_marketing_base.sql` | `database/migrations/20261018_084_marketing_base.sql` |
| `database/migrations/20261014_084_marketing_automacoes.sql` | `database/migrations/20261018_085_marketing_automacoes.sql` |
| `database/checks/20261014_08{3,4}_{precheck,postcheck}.sql` | `database/checks/20261018_08{4,5}_{precheck,postcheck}.sql` |
| `database/rollback/20261014_08{3,4}_*_down.sql` | `database/rollback/20261018_08{4,5}_*_down.sql` |
| funções `kidmais083_*` / `kidmais084_*` | `kidmais084_*` / `kidmais085_*` |
| `lib/marketing/migration-083-084.postgres.test.ts` | `lib/marketing/migration-084-085.postgres.test.ts` |

- **Ordem no alvo:** 083 → 084 → 085. A 084 exige 031/043/054/062; a 085 exige a 084.
- **Fora dos identificadores:** regras, restrições e gatilhos não mudaram.
- **Docs anteriores:** os documentos de 14–17/10 citam os números antigos, como registro histórico.

## Validação local (sem banco)

| Prova | Árvore | Resultado |
|---|---|---|
| `check:v1:static` (testes V1, harness de staging, lint, TypeScript, build de produção, PDF) | cópia LF de `9052db0` | **PASS** (3188/3188 testes V1; 103/103 harness) |
| Testes sem banco pertinentes (Marketing, guardião, diálogo, Pix, navegação, inventário, aplicador 083, webhook Meta, autenticação, arquitetura, pop-up WhatsApp) | idem | **212/212** |
| Inventário de migrations / `production.test.mjs` | idem | sem bloqueadores / 37/37 |
| Navegador em `next start` (build de produção), APIs sintéticas na página | idem | 6/7 PASS (telas desktop e celular, plano sem Marketing, proteção da edição com/sem Navigation API, unidade); rotas públicas: 3 controladas + 2 **não verificáveis sem banco** |
| Testes PostgreSQL | — | **NÃO EXECUTADOS** (exigem autorização própria) |

## Pendências

- **Decisões de produto:** F-1, O3, O4; plano/preço do recurso `MARKETING` (provisório em `profissional`/`premium`).
- **Worker:** só aceita localhost (não implantar em staging sem decisão própria).
- **Aplicador de staging da 084/085:** ainda a preparar.
- **Revisão independente** da árvore integrada.
- **Gates PostgreSQL:** pendentes.

O mapa, a matriz e os planos completos estão no pacote de revisão desta preparação:
- `MAPA-INTEGRACAO.md`;
- `MATRIZ-MIGRATIONS.md`;
- `PLANO-STAGING.md`;
- `PLANO-TESTES-POSTGRES.md`.
