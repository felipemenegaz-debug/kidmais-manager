# Evidência — atualização de staging (11/10/2026)

Pacote: [ATUALIZACAO_STAGING_20261011.md](../ATUALIZACAO_STAGING_20261011.md). Candidata autorizada:
`e1c38778cc6eac1590218186baa47c0e56ee6938` (código `53307b2`). Autorização de Felipe: S0–S4 e S5a; se staging tiver avançado, parar e
reapresentar a candidata; sem aplicar a 078 nem executar OTP; ao parar, S8 e S9; nenhuma alteração em produção.

**Resultado: PARADO em S0 — `origin/staging` avançou. Nenhuma escrita em staging (sem push, sem variável, sem deploy, sem Shell).**

## S0 (somente leitura)
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

## Passos
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
