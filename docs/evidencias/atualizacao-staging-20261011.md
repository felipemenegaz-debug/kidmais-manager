# Evidência — atualização de staging (11/10/2026)

| Rodada | Candidata | Resultado |
|---|---|---|
| 1 | `e1c3877` (código `53307b2`) | parada em S0: `origin/staging` tinha avançado para `2abeb58`; nenhuma escrita |
| **2** | `d19f78b4436f2592159ae0c2e8dafaf25f840c94` (código `4d8da7d`) | S0–S2; interrompida antes de S3 (Web Shell sem entrada pelo agente); **continuação:** S3 publicado (LIVE `d19f78b`), S4 só o legado (B3 PASS; `/b/` sem fixture elegível), S8 executado (chaves removidas, LIVE `d19f78b`); pendentes no Shell de Felipe: conferência da restauração e S5a |

## Rodada 2 — `d19f78b`

Autorização de Felipe: S0–S4 e S5a; parar se staging tiver avançado de `2abeb58`; sem aplicar a 078 nem OTP; ao encerrar ou interromper,
S8 se houver configuração a restaurar e S9; nenhuma alteração em produção.

| Passo | Resultado |
|---|---|
| S0 | `git fetch`: `origin/staging` = `2abeb58` (inalterado); candidata fast-forward; Render `srv-daif418ae00c73e8k2gg`: branch `staging`, `autoDeploy: no`, `autoDeployTrigger: off`; LIVE `dep-db54ovo473hc739sm0ig` (`2abeb58`); `/api/health` 200 (database/festa/otp `ready`; otp `gupshup`, `configured`, `enabled`); `/b/hml-planos-profissional/fechamento` 404; `smoke-test.mjs` (só GET): sem bloqueios (`UNKNOWN` só por `LOCAL:KIDMAIS_DEPLOY_ENV_NOT_AVAILABLE`), `HEALTH_DOES_NOT_PROVE_WHATSAPP_DELIVERY` |
| S1 | Painel do `kidmais-staging` → Recovery (leitura): **Point-in-Time Recovery disponível, janela de 3 dias**; última exportação lógica 09/10 03:23. Conferido às 2026-10-11T05:12:47Z. Nenhuma restauração |
| S2 | `git fetch` imediatamente antes (`2abeb58`); `git push origin d19f78b…:refs/heads/staging` → `2abeb58..d19f78b` (fast-forward, sem force). **Sem deploy** (auto-deploy OFF; LIVE continua `2abeb58`) |
| S3 | **Interrompido antes de qualquer mudança.** Web Shell aberto (instância `sclwm`, `~/project/src`), mas o terminal do Render não recebe texto do navegador do agente: `type` e teclas individuais não chegam (só `Enter` produziu nova linha); a conferência `--conferir-restauracao` não pôde ser executada. Sem ela (e sem o Shell para `RENDER_GIT_COMMIT` e S5a), o merge das chaves não foi feito. Aba do Shell fechada |
| S4, S5a | não executados |
| S8 | **não necessário**: nenhuma variável alterada, nenhum deploy disparado (LIVE `2abeb58` conferido por `list_deploys` ao final) |
| S9 | este registro |

### Continuação da rodada 2 (Felipe executa os comandos de Shell)

Autorização de Felipe: a conferência anterior ao S3 passou (executada por ele no Shell); continuar S3–S4 e S5a para `d19f78b`,
revalidando a branch antes do deploy; Felipe executa os comandos de Shell; sem 078 nem OTP; ao encerrar, S8 e S9.

| Passo | Resultado |
|---|---|
| Revalidação | 05:20:55Z: `origin/staging` = `d19f78b`; Render: branch `staging`, auto-deploy OFF; LIVE `2abeb58` |
| S3 | Render MCP, workspace `tea-daidbj95efls73d2bcf0` (dono do serviço): merge de **exatamente** `COTACAO_PUBLICA_POR_EMPRESA=true` e `ASSINATURA_PLANOS_ATIVOS=true` (a 1ª tentativa sem `workspaceId` foi recusada pela ferramenta, sem efeito). Deploy `dep-db5hpkdckfvc73a91jcg`, commit `d19f78b`, início 05:21:21Z, **LIVE 05:28:01Z**; `/api/health` 200 |
| Elegibilidade das fixtures | Com as chaves ativas, `GET /api/fechamentos/pacotes?empresa=…` = **404 `COTACAO_PUBLICA_INDISPONIVEL`** para `hml-planos-profissional`, `-premium`, `-teste`, `-isenta` e `-essencial`. A recusa é igual para empresa não `ATIVA`, plano sem `ORCAMENTO_ONLINE`, acesso bloqueado ou mais de uma unidade (`escopoCotacaoPublica`); a causa exige leitura do banco (não feita) |
| S4 B1, B2, B4 (`/b/`) | **não executáveis**: nenhuma empresa de homologação elegível em `/b/<código>` |
| S4 B3 (legado, desktop) | **PASS** — primeira visita após o deploy: `/disponibilidade` → quarta 18/11, 11:00–15:00 → botão “Continuar para escolher o pacote” → `/fechamento` “Etapa 1 de 8” em ~3,5 s (incluída espera de 3 s), build de produção. Nenhum pedido |
| S5a | **pendente — Shell de Felipe** (`--conferir-078`) |
| S8 | Painel → Environment → Edit: marcadas para remoção **só** as duas chaves (conferido no DOM: 2 marcadas), **“Save only”** (sem deploy; conferido em `list_deploys`); `git ls-remote`: ponta `d19f78b`; `trigger_deploy` → `dep-db5i0b2jnfac73aihub0` (`d19f78b`), **LIVE 05:41:35Z**; `/api/health` 200; `/b/hml-planos-profissional/fechamento` 404; pacotes por empresa 404; `/disponibilidade` 200. `--conferir-restauracao`: **pendente — Shell de Felipe** |
| S9 | este registro |

Valores de variáveis não foram lidos nem exibidos (campos mascarados; só nomes). 078 não aplicada; OTP não executado.

**Estado deixado:** LIVE `d19f78b` (`dep-db5i0b2jnfac73aihub0`), sem as duas chaves; branch `staging` = `d19f78b`; 078 não aplicada.
Pendentes no Shell (Felipe): `echo $RENDER_GIT_COMMIT` + `--conferir-restauracao` (esperado `RESTAURADA`) e `--conferir-078` (S5a).
Pendente de decisão: fixture elegível para `/b/` em staging (diagnóstico somente leitura proposto) para repetir B1/B2/B4.

Sem alteração em produção.

## Rodada 1 — `e1c3877` (parada em S0)

Pacote: [ATUALIZACAO_STAGING_20261011.md](../ATUALIZACAO_STAGING_20261011.md). Candidata autorizada:
`e1c38778cc6eac1590218186baa47c0e56ee6938` (código `53307b2`). Autorização de Felipe: S0–S4 e S5a; se staging tiver avançado, parar e
reapresentar a candidata; sem aplicar a 078 nem executar OTP; ao parar, S8 e S9; nenhuma alteração em produção.

**Resultado: PARADO em S0 — `origin/staging` avançou. Nenhuma escrita em staging (sem push, sem variável, sem deploy, sem Shell).**

### S0 (somente leitura)
| Conferência | Esperado (pacote) | Encontrado |
|---|---|---|
| `git fetch origin staging` | `f88b39e` | **`2abeb586bdc9e229e895b4a75696d4639538f090`** (`f88b39e..2abeb58`) |
| Fast-forward da candidata | sim | **não** — `merge-base(HEAD, origin/staging) = f88b39e`; staging tem 2 commits que a candidata não tem |
| Render `kidmais-manager-staging` | branch `staging`, auto-deploy OFF | branch `staging`, `autoDeploy: no`, `autoDeployTrigger: off` |
| Deploy LIVE | `f88b39e` | **`dep-db54ovo473hc739sm0ig`, commit `2abeb58`**, LIVE 10/10 14:38:38Z (trigger `api`); anterior `dep-db54dep42hec73fmbnf0` (`b606216`, 14:14Z) |
| `/api/health` | 200 | 200 — `database/festa/otp: ready`; otp `provider: gupshup`, `configured: true`, `enabled: true` |
| `/b/hml-planos-profissional/fechamento` | 404 (flags ausentes) | 404 |

Commits em staging depois de `f88b39e` (não presentes na candidata):
- `b606216` — “Corrige leitura da imagem do Gemini em convites (#153)” (inclui “Reconhece migrações 076 e 077 no inventário operacional”).
- `2abeb58` — “Bloqueia nova geração após falha incerta de convite”.

7 arquivos alterados em staging; **sobreposição com a candidata:** `scripts/production/check-migrations.mjs` e
`scripts/production/production.test.mjs` (inventário de migrations — a candidata também altera para 076/077/078). Nenhuma migration
nova em staging. Integração exige merge sem force com resolução dessas duas sobreposições, revalidação e nova candidata.

### Passos
| Passo | Situação |
|---|---|
| S0 | executado (leitura) — divergência → **parada** |
| S1 (backup/PITR) | não executado (parada antes) |
| S2 (push) | **não executado** |
| S3 (flags + deploy) | **não executado** |
| S4 (botão) | não executado |
| S5a (conferência da 078) | não executado |
| S8 | nada a restaurar: nenhuma variável alterada, nenhum deploy disparado; conferido por leitura (`/b/…` 404, LIVE `2abeb58` inalterado) |
| S9 | este registro |

Sem alteração em produção. Sem push, deploy, Shell, variável de ambiente ou SQL em staging.
