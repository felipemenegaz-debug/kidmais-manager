# B-6 e B-10 do plano de promoção — CI e comentários do inventário (27/10/2026)

LOCAL, sem commit. Clone `kidmais-manager-ci-inventario-b6-b10-20261027`, branch `codex/ci-inventario-b6-b10-20261027` sobre staging `9ea280ae7cc847c0502c29f65e8bbb18791da798`. Itens B-6 e B-10 do backlog de `docs/PLANO_PROMOCAO_PRODUCTION_20261025.md` (clone do plano, não rastreado).

## B-6 — CI

`.github/workflows/ci.yml` passa a rodar, sem banco e sem rede (cliente simulado e bash num diretório temporário), os testes dos aplicadores e blocos de Shell da 090, 091, 096 e 097, que existiam na árvore e nenhum passo chamava:

| Migration | Aplicadores (staging e produção) | Blocos de Shell |
| --- | --- | --- |
| 090 campanha Fundador | `scripts/migration-090.test.cjs` (13) | `scripts/bloco-shell-090.test.cjs` (10) |
| 091 documento fiscal CPF/CNPJ | `scripts/migration-091.test.cjs` (13) | `scripts/bloco-shell-091.test.cjs` (10) |
| 096 comprovante da contratação | `scripts/migration-096.test.cjs` (13) | `scripts/bloco-shell-096.test.cjs` (10) |
| 097 direito de arrependimento | `scripts/migration-097.test.cjs` (13) | `scripts/bloco-shell-097.test.cjs` (10) |

Os passos ficam na ordem numérica, depois da 089 (090/091) e da 095 (096/097), com nome e forma dos passos vizinhos. As execuções reais em PostgreSQL (`lib/assinatura/*.postgres.test.ts`) continuam fora do CI, como as das outras migrations.

**Os aplicadores novos de production entram no CI com a própria entrega**, nos clones de cada item (sem commit):

| Item | Clone | Passo acrescentado |
| --- | --- | --- |
| B-1 (092–094) | `kidmais-manager-aplicador-092-094-production-20261025` | `migration-092-094-production.test.cjs` |
| B-2 (099) | `kidmais-manager-aplicador-099-production-20261025` | `migration-099.test.cjs` + `bloco-shell-099.test.cjs` |
| B-3 (100) | `kidmais-manager-aplicador-100-production-20261026` | `migration-100-production.test.cjs` |
| B-5 (conferência) | `kidmais-manager-conferencia-b5-production-20261026` | os três acima + `conferencia-b5-producao.test.cjs` + `bloco-shell-conferencia-b5-producao.test.cjs` |
| B-4 (entrega do grupo A, outra sessão) | `kidmais-manager-entrega-grupo-a-production-20261026` | 099, 092–094 e `bloco-shell-entrega-grupo-a-producao.test.cjs` (sem o passo da 100 na leitura de 27/10) |

Na composição desses itens com este, o `ci.yml` recebe passos em pontos diferentes (o B-6 depois da 089/095; os outros no fim); a composição precisa conferir que cada passo aparece uma vez.

**Observação, fora do escopo do B-6 (contagem corrigida na revisão de 27/10):** a árvore `9ea280ae` tem 100 arquivos `*.test.cjs`/`*.test.mjs` rastreados. Depois deste pacote, 47 são chamados e **53 ficam fora** (61 na base, antes dos oito do B-6): homologações e ensaios de staging, ferramentas de lançamento, avaliação do Wall-e, entre outros. Vários dependem de banco ou de ambiente; incluí-los pede triagem própria (ex.: `scripts/conexao-staging.test.cjs`, que cobre uma dependência compartilhada). Entre os 47, cinco são chamados **indiretamente**: `npm run production:test` roda `scripts/production/production.test.mjs`, e o `check:v1:static` roda `scripts/regressao-v1-estatica.test.cjs`, `scripts/walle-avaliacao/regressao-holdouts.test.mjs` e `scripts/walle-avaliacao/livro-uso-ia.test.mjs` (pela seleção de `scripts/regressao-v1-selecao.cjs`, que também cobre os `*.test.ts` de `app/`, `components/` e `lib/`), além de `scripts/staging-smoke/smoke.test.mjs` (chamado à parte pelo `regressao-v1-estatica.cjs`).

## B-10 — comentários do inventário

`scripts/production/check-migrations.mjs`: **só comentários** (o script de edição recusa qualquer mudança fora das linhas `//`; a lista de arquivos, os prechecks e as regras de autorização não mudam).

- Bloco novo antes da 089, no estilo do bloco 076–079: o inventário só reconhece arquivos; aplicação de 089–097 em staging registrada fora dele (089 CONFERIR 23/10 `JA_APLICADA_POSTCHECK_PASS`; 090, 091, 096 e 097 em 23/10; 092–094 pela #215; 095 em 23/10, CONFERIR final PASS em 24/10), não confirmada aqui; produção sem aplicação registrada (a #209 saiu sem a 089); estado só por leitura própria e datada (B-5); produção exige autorização própria.
- 089–097: "Validada só em PostgreSQL descartável local; nunca aplicada fora dele" → "Validada primeiro em PostgreSQL descartável local"; saem as notas de disputa de número, vencidas.
- 091: "Só alarga CHECKs e acrescenta DV para linhas novas (NOT VALID)" → troca os CHECKs de formato por CHECKs **validados** que aceitam 11 dígitos (sem NOT VALID) e exige o DV só no INSERT, por gatilho, em `empresa_assinaturas` e `assinatura_fundadores`; cria `empresa_documento_continuidades`; não atualiza linhas (conferido no SQL da 091, linhas 5–8, 68–96 e 130–162).
- Mesma frase vencida também na 085/086 e na 088 (além do pedido do B-10): 085/086 com aplicação registrada em staging (19/10, H1 PASS) e na promoção de produção de 20/10; 088 com aplicação em staging registrada pela #200 e registros divergentes para produção. Tudo "não confirmado aqui".
- A 098 mantém "nunca aplicada fora dele" (pausada por Felipe; continua verdadeiro).
- Os cabeçalhos dos próprios SQL (ex.: a 091 diz "NÃO aplicada em staging/produção") **não** foram tocados: mudar o SQL mudaria o sha que os aplicadores e o plano conferem.

## Validação

Sem banco (variáveis `DATABASE_URL`/`PG*` removidas): todos os passos `run:` do `ci.yml` (menos o `npm ci`), inclusive `check:v1:static` (testes, lint, tsc, build) e `production:test` (que exercita o `check-migrations`). Resultado em [Validação local](#validação-local).

## Validação local

27/10/2026, Windows (Git Bash), Node 24, sem `DATABASE_URL`/`PG*`, depois de `npm ci` e com a árvore em LF: **34/34 passos `run:` do `ci.yml` PASS, 0 falha** (`check:v1:static` 3761 testes + lint + tsc + build em 249 s; `production:test` 37; os oito passos novos: migration-090/091/096/097 13 cada e bloco-shell-090/091/096/097 10 cada). Nenhum banco, serviço ou variável de ambiente remota foi usado. O CI usa Node 22.23.2 (`.node-version`) em ubuntu-latest; a execução local foi em Node 24.

Revisão do Astra (27/10/2026): **APROVADO COM RESSALVAS**, um P3 documental (a contagem de testes fora do CI, corrigida acima: 53 depois do pacote, 61 na base). Reproduzido pelo revisor: as oito suítes 92/92, `production:test` 37/37, hashes, diff byte a byte e `git diff --check`.
