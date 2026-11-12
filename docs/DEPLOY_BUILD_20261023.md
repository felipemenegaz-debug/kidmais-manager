# Deploy mais rápido: medição e plano (23/10/2026)

Estado: **LOCAL**, branch `codex/deploy-build-sem-duplicado-20261023` sobre `origin/staging` `6108655`. Nada foi enviado nem alterado no Render. Mudar o `render.yaml` muda a configuração do serviço de staging: a sincronização do Blueprint aplica o arquivo inteiro. Por isso o merge exige autorização de Felipe (docs/OPERACAO_AGENTES.md).

## Medição: deploy de staging da #210 (`dep-dbde6p1srm7s73bek2e0`, 23/10, 10 min 25 s)

Os tempos foram lidos nos logs de build do Render, só leitura.

| Fase | Início (UTC) | Duração |
|---|---|---|
| Fila, clone e cache (1,6 GiB em 17 s) | 04:32:36 | 22 s |
| `npm ci --include=dev` | 04:32:58 | 11 s |
| **Testes unitários V1 (3.329)** | 04:33:10 | **5 min 31 s** |
| Harness de mocks (103) | 04:38:41 | 3 s |
| Lint | 04:38:44 | 49 s |
| TypeScript (`tsc --noEmit`) | 04:39:33 | 29 s |
| Build 1 (`next build`, dentro do check) | 04:40:02 | 39 s |
| Leitura de PDF no asset | 04:40:41 | < 1 s |
| **Build 2 (`npm run build`, repetido)** | 04:40:41 | **30 s** |
| Upload do build | 04:41:11 | 35 s |
| Início do serviço e health check | 04:41:46 | 1 min 15 s |

Evolução do total: cerca de 8 min em 17–18/10 e cerca de 10,5 min de 19/10 a 23/10 (lista de deploys do serviço). O crescimento acompanha o número de testes.

## Opção 1 — tirar o build repetido (FEITA LOCALMENTE)

- O `buildCommand` passa de `npm ci --include=dev && npm run check:v1:static && npm run build` para `npm ci --include=dev && npm run check:v1:static`.
- **Por que não tem risco:** o `npm run build` é só `next build` (package.json, sem pre/post), idêntico ao último passo de `scripts/regressao-v1-estatica.cjs`. O `npm start` usa a mesma pasta `.next`. O check para com erro em qualquer etapa (`process.exit`), então nada segue depois de uma falha. Testes, lint, TypeScript, build e PDF continuam rodando no Render.
- **Ganho medido:** cerca de 30 s por deploy (≈ 5%).
- **Produção** (`srv-dak77m2d0e5s73b8rkkg`): usa o mesmo comando, mas é configurada no painel do Render e não pelo `render.yaml`. A mesma troca lá exige mudança no painel, com autorização própria.

## Opção 3 — cache de build: JÁ ESTÁ ATIVO

- O deploy de 23/10 baixou 1,6 GiB de cache em 17 s. O `npm ci` levou 11 s, e o `next build` compilou em 4,2 s (0,6 s no segundo build), o que só acontece com `.next/cache` reaproveitado.
- O campo `cache.profile: no-cache` que a API mostra não corresponde ao que o build faz. Não há o que ligar. Se algum dia um build sair estranho por cache velho, usar "Clear build cache & deploy".

## Onde está o tempo de verdade: os testes unitários (53% do deploy)

- **Na máquina local** (16 núcleos), os mesmos testes levam cerca de 76 s. **No Render**, 5 min 31 s.
- **Hipótese (não medida):** o Next relata 47 workers no Render, ou seja, o build enxerga cerca de 48 CPUs, mas o plano de build starter não entrega isso. O `node --test` abre um processo por núcleo visto, e dezenas de processos disputam pouca CPU real (e memória).
- **Como confirmar sem risco:** num deploy autorizado, registrar `nproc` e `os.availableParallelism()` no log do build. Se a hipótese se confirmar, limitar a concorrência dos testes só no Render (por exemplo, `--test-concurrency` pela quantidade real de CPUs) e comparar os tempos.
- **Opção 2** (Render só com `npm ci` + `next build`, contando com o CI verde do commit exato): tiraria cerca de 6 min 50 s (testes, mocks, lint e TypeScript), e o deploy ficaria por volta de 3,5 min.
  - Risco: implantar um commit cujo CI foi cancelado (o CI cancela execuções antigas da `staging` quando chega um push novo).
  - Exige que a conferência do CI do SHA exato vire regra do deploy manual.
- **Opção 4** (plano de build maior): mais CPU real, com custo mensal. Útil sobretudo se a hipótese da concorrência se confirmar e não houver outro ajuste.

## Ordem recomendada

1. Opção 1 (esta branch): merge autorizado; o ganho aparece no próximo deploy de staging.
2. No mesmo deploy, ou no seguinte, medir `nproc`/`availableParallelism` e testar a concorrência dos testes: potencialmente o maior ganho sem perder verificação.
3. Opção 2 só com a conferência do CI do SHA exato registrada no procedimento de deploy.
4. Produção: aplicar a opção 1 no painel quando autorizado.
