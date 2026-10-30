# Aplicador da 092–094 em produção — execuções separadas (B-1, 25/10/2026)

Estado: **implementação LOCAL**, sem commit, branch `codex/aplicador-092-094-production-20261025` sobre staging `54598a921875e7102a689f526f7a6687cf8d2d4f`. Nada foi executado em nenhum banco. Este documento não autoriza aplicação.

Origem: backlog B-1 do plano de promoção (`kidmais-manager-planejamento-production-20261025/docs/PLANO_PROMOCAO_PRODUCTION_20261025.md`, §4.3, §5 e §12). O código atual de produção quebra o manifesto Festa (health 503) se a 094 for aplicada antes do deploy do código novo, e a 092 tem de vir antes do código que grava `PONTO`. Por isso, em produção, a trilha é dividida em duas execuções.

## O que mudou

| Arquivo | Mudança |
| --- | --- |
| `scripts/migration-092-094-comum.cjs` | escopos de execução: `todas` (staging, comportamento inalterado), `092-093` e `094`; flag e marcador próprios por escopo; o 092-093 recusa com a 094 presente (`ESCOPO_092_093_EXIGE_094_AUSENTE`), nunca põe etapa da 094 no plano e confere ao fim que a 094 continua ausente; o 094 exige 092 e 093 completas (`ESCOPO_094_EXIGE_092_093_COMPLETAS`); conferência informa o plano de cada escopo (`planos`) |
| `scripts/migration-092-094-production.cjs` | adaptador novo: alvo fixo de produção (serviço, ambiente, host interno, banco, porta, URL sem query), TLS obrigatório com verificação do certificado conforme o serviço, identidade provada no servidor (banco, TLS 1.2/1.3, rede privada), disco persistente, DIR `agenda-precos-092-094-producao`, escopos `092-093` e `094` (sem `todas`) |
| `scripts/bloco-shell-092-094.cjs` | ambiente `production` com modos `CONFERIR`, `CONFERIR-092-093`, `CONFERIR-094`, `APLICAR-092-093` e `APLICAR-094`; staging inalterado |
| testes | `scripts/migration-092-094-production.test.cjs` (14), `scripts/bloco-shell-092-094.test.cjs` (+4), ajuste de 1 expectativa em `scripts/migration-092-094.test.cjs` |
| `.github/workflows/ci.yml` | passo da suíte de produção |

A integridade da 094 continua escolhendo a variante da #236 só quando o corpo da regra de conflito é exatamente o da 100 (`805cd427…`, `PASS_CORPO_100`); qualquer outro corpo cai na integridade da 094 e recusa.

## Uso (artefato de revisão — não executar sem autorização)

```text
node scripts/migration-092-094-production.cjs                                                  # plano, sem conexão
node scripts/migration-092-094-production.cjs --conferir-092-094                               # diagnóstico global, só leitura
node scripts/migration-092-094-production.cjs --conferir-092-093                               # conferência do E3, só leitura
node scripts/migration-092-094-production.cjs --conferir-094                                   # conferência do E6, só leitura
node scripts/migration-092-094-production.cjs --aplicar-092-093-autorizado --backup "<registro>" # E3, código ANTIGO
node scripts/migration-092-094-production.cjs --aplicar-094-autorizado --backup "<registro>"     # E6, código NOVO
```

Cada etapa usa a conferência do próprio escopo: plano, checks e código só daquele escopo (o E3 não depende de privilégio, dependência ou REFERENCES exclusivos da 094). `--conferir-092-094` é diagnóstico e calcula os planos de cada escopo antes de qualquer retorno.

Marcadores: `migration-092-093.json` (E3) e `migration-094.json` (E6), independentes; repetição do mesmo escopo é recusada antes de conectar. `--aplicar-092-094-autorizado` é recusado em produção.

## Validação local (sem banco)

- `scripts/migration-092-094.test.cjs` 19/19 (staging preservado); `scripts/migration-092-094-production.test.cjs` 12/12; `scripts/bloco-shell-092-094.test.cjs` 13/13; `scripts/migration-100.test.cjs` 12/12; `scripts/bloco-shell-100.test.cjs` 10/10; `npm run production:test` 37/37; ESLint dos arquivos alterados sem erro; `git diff --check` limpo.
- `npm run check:v1:static` com código 0 (3599 + 103 testes, 0 falhas; ESLint 0 erros e 2 avisos preexistentes em `lib/inteligencia/skills/catalogo.ts` e `scripts/migration-096-comum.cjs`; `next build` compilado). Rodou antes de um ajuste de uma linha em `principal` (o escopo da flag passou a vir depois de `deps`); as suítes do aplicador foram repetidas depois do ajuste (19/19, 12/12, 12/12).
- Mutantes em cópia isolada (controle 12/12): escopo 092-093 considerando as três migrations → 5 falhas; sem a recusa da 094 presente → 3 falhas; escopo 094 sem exigir 092/093 → 3 falhas.

## Limites e pendências

- **Nenhum PostgreSQL executado** (nem descartável): a prova real das execuções separadas, inclusive com a 100, exige cluster isolado autorizado (§8.2 item 3 do plano).
- **E3 depende de B-4:** o código hoje publicado em produção (`00d3019a`) não contém este aplicador nem os SQL; o bloco `APLICAR-092-093` confere o sha do que estiver no destino, mas a entrega dos arquivos antes do código é outro item do backlog.
- Privilégio de dono (`pg_has_role` em `current_user`) e identidade reais de produção só se provam na conferência autorizada (E1).
- Revisão independente pendente.

## Revisão independente — rodada 1 (REPROVADO, 1 P2) e correção

P2: a conferência exigia o plano conjunto (todas) antes de montar os planos por escopo; com 092/093 completas e `dono_094=false` (ou dependência/REFERENCES só da 094), `--conferir-092-094` dava código 3 sem `planos`, bloqueando a conferência do E3 por um requisito só do E6. Correção: conferências por escopo (`--conferir-092-093`, `--conferir-094`) com plano, checks e resultado/código do escopo; o diagnóstico global calcula os planos por escopo antes de qualquer retorno; runbook do adaptador e blocos (`CONFERIR-092-093`, `CONFERIR-094`) atualizados. Regressões novas: E3 válido com cada requisito exclusivo da 094 ausente (código 0, nada da 094), E6 e global recusando com os planos presentes, E3 recusando com a 094 presente, escopo fora do ambiente recusado. Mutantes em cópia isolada (controle 14/14): conferência exigindo o plano conjunto, checks de todas as migrations no escopo 092-093 e planos calculados depois do retorno — cada um derrubado pela regressão do P2. Suítes: staging 19/19, production 14/14, blocos 14/14, migration-100 12/12, blocos 100 10/10, production:test 37/37, ESLint e diff-check limpos; `npm run check:v1:static` repetido depois da correção: código 0 (3599 + 103 testes, 0 falhas; mesmos 2 avisos preexistentes; build compilado).
