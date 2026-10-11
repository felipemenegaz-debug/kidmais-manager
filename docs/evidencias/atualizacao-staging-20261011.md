# Evidência — atualização de staging (11/10/2026)

| Rodada | Candidata | Resultado |
|---|---|---|
| 1 | `e1c3877` (código `53307b2`) | parada em S0: `origin/staging` tinha avançado para `2abeb58`; nenhuma escrita |
| **2** | `d19f78b4436f2592159ae0c2e8dafaf25f840c94` (código `4d8da7d`) | **S0–S2 executados; interrompida antes de S3** — o Web Shell do Render não aceita texto digitado pelo navegador do agente; nenhuma configuração alterada |

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

**Estado deixado:** branch `staging` = `d19f78b` (à frente do LIVE); LIVE = `2abeb58`; chaves `COTACAO_PUBLICA_POR_EMPRESA`/`ASSINATURA_PLANOS_ATIVOS`
inalteradas; 078 não aplicada. **Atenção:** qualquer deploy manual de staging a partir de agora publica `d19f78b`.

Para retomar S3–S4/S5a, os passos de Shell precisam de outro executor (Felipe no Web Shell, colando a saída) ou de acesso por SSH
autorizado; as partes por Render MCP (merge das chaves, acompanhamento do deploy, `trigger_deploy`) e navegador (S4) seguem possíveis.

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
