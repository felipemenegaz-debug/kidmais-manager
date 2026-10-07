# Candidata de integração LOCAL com a r35 — Atendimento WhatsApp + Wall-e (07/10/2026, tarde)

Tudo é local. Não houve push, merge remoto, deploy, migration remota nem SQL em banco persistente.

**Preservados:**
- a entrega anterior (`whatsapp/entrega-walle-20261007`, `e095888`) e a candidata anterior;
- as branches por rodada (r7–r35) e a branch de evidências;
- a PR #80 (`a9e2d55`) e a fase B (`1f938d2`).

O estado dos bancos de staging e de produção é **"estado não verificado"**: nada foi lido nem aplicado neles.

## 1. Branch e base

| Branch | Worktree | O que é |
|---|---|---|
| `whatsapp/candidata-walle-r35-20261007` | `kidmais-candidata-r35` | `origin/staging` `9dd7d89` + 1 commit de produto (squash da r35) + este documento; depois, o lacre de um holdout novo |

**Base reconfirmada** por `git fetch` (só leitura) em 07/10 à tarde:
- `origin/staging` `9dd7d89`: avançou 22 commits desde `755e5fe` (PR #126–#134: venda, cadastro público, fluxo do cliente, contraste do calendário, adicionais do buffet). Não houve mudança de dependências (`package.json` e `package-lock.json` iguais);
- `origin/production` `c7a3a73`;
- `origin/main` `9765965`.

**Como a candidata foi feita:** squash da `whatsapp/wall-e-correcoes-r35` (`2c7d38e`) sobre `origin/staging`.
- A r35 descende da entrega anterior (`b31125e`) e das rodadas r28–r35.
- O squash traz o produto da entrega mais as correções do Wall-e, e nenhum histórico de medição.
- `scripts/walle-avaliacao/resultados/` continua ignorado (0 arquivos rastreados), assim como `.local-ux` (0).

## 2. Migrations: nova renumeração (staging tomou a 070)

**Levantamento em todas as branches remotas:**
- staging usa 058, 059, 061–064 e 066–**070** (a 070 é nova: `20261007_070_adicionais_do_buffet`);
- a 071 está em uso na branch `codex/importacao-tabela-precos-20261007`, de outra sessão e não mesclada;
- 060 e 065 só aparecem na PR #80, isto é, são nossas.

**Resultado:** 060 e 065 mantidas; **070 → 073, 071 → 074, 072 → 075**, na mesma ordem de dependência (prontas →
mídia das prontas → Wall-e).

| Migration | PR #80 / fase B / r27 | Entrega anterior | Esta candidata |
|---|---|---|---|
| Atendimento (base) | 060 | 060 | 060 |
| Nome de perfil | 065 | 065 | 065 |
| Mensagens prontas | 064 | 070 | **073** |
| Fotos e vídeos das prontas | 066 | 071 | **074** |
| Wall-e | 067 | 072 | **075** |

**Conferência automática** contra a r35, desfazendo 073→070, 074→071, 075→072 no caminho e no conteúdo, nos 209 arquivos do diff:
- **154 idênticos** à r35;
- **50 iguais só pela renumeração**: migrations, rollbacks, postchecks, testes, serviço, worker, telas, simulador do
  avaliador e outros;
- **17 renomeados**: 11 de `database` e 6 suítes;
- **5 diferentes além da renumeração**, todos deliberados:
  - `check-migrations.mjs`, `production.test.mjs` e `regressao-v1-selecao.cjs`: união da 070 de staging com
    073–075;
  - `coexistencia-staging.postgres.test.ts`: passa a incluir a 070 de staging;
  - `components/admin/AdminShell.tsx`: staging mudou o arquivo por conta própria; a fusão automática manteve os dois
    lados.

**Identificadores renumerados:**
- `kidmais.rollback_073_descartar_prontas`;
- `kidmais.rollback_074_descartar_midias` e `_descartar_prontas_midia`;
- `kidmais.rollback_075_descartar`;
- `ATENDIMENTO_RECURSO_075_INDISPONIVEL`;
- campos `recursos074` e `r075`;
- `kidmais075_arquivo_imutavel()`;
- `ATALHOS_074` e `TIPOS_074`.

A detecção de schema na tela continua pelo catálogo, não pelo número.

**Não tocados:**
- documentos históricos (`docs/WALL_E_ATENDIMENTO.md` cita 070–072 como eram na época), corpora e dados;
- a 070 de staging e o `lib/comercial/migration-070.ts` (iguais a `origin/staging`).

**Inventário** (`check-migrations.mjs`):
- `approvedFiles`: … 069, 070 (staging), 073, 074, 075;
- `requiresExplicitAuthorization`: 055a … 070, 073, 074, 075;
- postchecks de 060, 065 e 073–075;
- pendências de cada uma.

**Ordem de rollback:** 075 → 074 → 065/073 → 060.
- O down da 073 falha fechado com a 074 presente.
- O down da 074 é **destrutivo**: pede `kidmais.rollback_074_descartar_midias` e `_descartar_prontas_midia`.
- O down da 075 pede `kidmais.rollback_075_descartar` quando há dados do Wall-e.

**Conflitos do squash:** quatro, todos resolvidos pela regra acima.
- `database/checks/20261007_070_postcheck.sql` (adição dos dois lados): fica o de staging; o nosso virou `_073_`.
- `check-migrations.mjs`, `production.test.mjs` e `regressao-v1-selecao.cjs`: união dos dois lados. A lista dobrada
  que a união criou no teste de produção foi corrigida à mão, assim como o "073 não aplicada" que se fundira com o
  "070" idêntico de staging.

## 3. Diff final × `origin/staging` `9dd7d89`

209 arquivos: 197 novos e 12 alterados. +47.650 / −7.

| Grupo | Arquivos | Linhas |
|---|---|---|
| `lib` (atendimento, Wall-e, Gupshup, navegação) | 57 | +12.211 / −1 |
| `components` (telas do atendimento) | 13 | +1.363 / −1 |
| `app` (páginas e rotas) | 10 | +239 / −1 |
| `database` (5 migrations, rollbacks, checks) | 20 | +1.034 |
| **Produto** | **100** | **+14.847 / −3** |
| Worker e scripts de produção e regressão | 4 | +123 / −4 |
| Avaliador e régua (código) | 23 | +3.657 |
| Holdouts 1–35, estresse, rótulos e interpretações gravadas (dados) | 63 | +23.459 |
| `docs` | 18 + este | +5.561 |
| `.gitignore` | 1 | +3 |

**Arquivos de staging alterados:** os mesmos 12 da entrega anterior.

**Canal desligado por padrão:**
- o webhook só grava a entrada com `WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED=true`, receptor e empresa piloto configurados;
- o atendimento só responde com `WHATSAPP_ATENDIMENTO_ENABLED=true`.

## 4. Gates no SHA integrado (antes do lacre)

| Gate | Resultado |
|---|---|
| Suítes do atendimento, Wall-e, avaliador (regressão h1–h35 e interpretações gravadas), telas, inventário de produção e arquitetura | **518/518** |
| `check:v1:static` (testes, lint, TypeScript, build de produção, PDF no asset) | **PASS** — 2.514/2.514 + harness de staging 103/103 |
| PostgreSQL descartável, **todas** as suítes do repositório (staging incluídas, com a `adicionais-070` de staging) | **PASS — 58 arquivos**, cada um no estado declarado; porta 55616; limpeza comprovada |

**Coexistência e rollback cruzado** (`coexistencia-staging`, X1–X7):
- passa a incluir a 070 de staging na sequência (precheck, aplicação, postcheck e rollback);
- os filtros de função seguem a numeração nova: 073–075 do atendimento e 064/066–070 de staging;
- resultado: PASS.

**Interrupção registrada:** a primeira execução do PostgreSQL foi interrompida por mim, para incluir a 070 na
coexistência.
- O cluster que ficou de pé era o da própria execução: o token do marcador confere com o nome do diretório.
- Ele foi parado com `pg_ctl` e o diretório foi removido pelo mesmo procedimento seguro (marcador, sem links, parada
  comprovada).
- A execução válida é a segunda.

## 5. Medição em holdout novo e avaliação em IA real

Feitas depois do congelamento, no SHA do lacre. O registro fica na branch de ferramentas
(`whatsapp/walle-avaliacao-ia-20261007`, §4.45) e na branch de evidências: um documento novo neste branch mudaria o SHA
medido.

O resultado da r35 no h35 é **desenvolvimento**, não medição: o h35 virou regressão. A medição original da r34 no h35
(`r34-ecf1f57-holdout35-regras.json`) e o falso positivo documentado (h35 aa54, em `falsos-positivos-regua.json`)
continuam como foram gravados.

## 6. Bloqueadores (antes da medição; a versão final fica na §4.45 da branch de ferramentas)

### A. Publicação com o canal DESLIGADO (código em staging, sem WhatsApp real e sem respostas automáticas)

1. **Reserva dos números 073, 074 e 075** com as outras sessões: a 070 foi tomada por staging hoje e a 071 está numa
   branch de outra sessão. Se alguém usar 073–075 antes, é preciso renumerar de novo e repetir os gates.
2. **Caminho da PR:**
   - aprovar a PR nova (base `staging`, head desta candidata);
   - push autorizado;
   - a #80 fica aberta como registro;
   - reconfirmar com a sessão Painel a ordem combinada (S11 encerrado antes do merge).
3. **Revisão humana** do produto (~14,8 mil linhas) e **CI verde no SHA exato**. Leitura do Render (branch e
   auto-deploy) antes de qualquer merge.
4. **Migrations 060, 065, 073, 074 e 075:**
   - não aplicadas em nenhum banco persistente;
   - aplicar exige E2a datada **para os nomes novos**, backup com restauração comprovada e autorização explícita;
   - o down da 074 é destrutivo;
   - conferir que staging sem as migrations mostra a tela do atendimento indisponível, sem erro.
5. **Evidências fora da PR:** decidir se a branch de evidências é publicada (push separado, autorizado) ou mantida
   local.

### B. Ativação do WhatsApp real (receber e responder clientes)

1. **Gupshup:** autenticação real e Partner API pendentes (chamado #277630).
2. **Receptor único (E0) e OTP preservado (E3)** comprovados no ambiente-alvo.
3. **Migrations aplicadas** (A.4) e postchecks passando no banco-alvo.
4. **Wall-e sem falha crítica** num holdout novo e lacrado, medido **neste SHA**, com todas as respostas lidas (§5).
5. **IA real medida neste SHA**, com o comando da §5. Até lá, só modo regras
   (`WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO=regras`).
6. **Ambiente:** `WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM` em https, orçamento de IA (`AI_BUDGET_JSON`), lista de contatos
   permitidos e autorização material por material.
7. **Dados reais da Kidmais** cadastrados e conferidos. Hoje só há dados sintéticos.
8. **Autorização explícita** do Felipe para ligar `WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED` e
   `WHATSAPP_ATENDIMENTO_ENABLED`.
