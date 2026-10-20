# Evidência — Frente L do pacote de atualização de staging (11/10/2026)

| Execução | Candidata (pacote / código) | Resultado |
|---|---|---|
| 1 | `44ce38f` / `6099692` | FALHA em L2: 5/6; `disponibilidade-empresa` 1/4 (fixture com vigências sobrepostas, recusado pelo banco) — §Execução 1 |
| **2** | `7b937d892653830dfe02c6dc6e85fa8ecc18d40a` / `53307b2` | **PASS: 6/6 suítes; `disponibilidade-empresa` 5/5** — §Execução 2 |

## Execução 2 — `7b937d8` (PASS)

Autorização de Felipe: L1–L3 para `7b937d8`, cluster local novo, dados sintéticos; preservar todos os clusters; encerrar processos; parar
se houver falha; sem operações remotas, push, deploy ou passos S.

| Passo | Resultado |
|---|---|
| Pré-condições | HEAD `7b937d8`; só `docs/` após `53307b2`; árvore limpa; sem `.env*`/`DATABASE_URL`/`PG*`; 55498 livre; `KIDMAIS_HOMOLOGACAO_DATABASE_URL` fora do ambiente dos comandos |
| L1 | cluster novo `.local-descartavel-pg-f38c8cc59c334208ae2df077eafc1be6`: `CRIADO`, `INICIADO` (127.0.0.1:55498), `CONFERE`, bancos `[]` |
| L2 | **PASS — 6 arquivos, cada um no estado declarado** ([log](atualizacao-staging-l2-7b937d8-20261011.txt)) |
| L3 | `PARADO`; pasta preservada; 55498 livre; 19 pastas `.local-*` (inclusive a da execução 1, parada) |

| Suíte | Modelo | Resultado |
|---|---|---|
| `adicionais-070` | 063 | 9/9 |
| `catalogo-buffet-078` | 063 | 10/10 |
| `catalogo-ux` | 063 | 1/1 |
| **`disponibilidade-empresa`** | 063 | **5/5** |
| `round4-remediacao` | atual | 8/8 |
| `hg8-catalogo` | atual | 6/6 |

`disponibilidade-empresa` comprovou no PostgreSQL: vigências contíguas aceitas pelo banco (B: quarta no almoço aberta → fechada por
duas quartas → reaberta); isolamento (A 14 regras, B 13, C sem POCKET; administração = cotação pública); tela = servidor em 35 dias ×
2 períodos para A, B e B-Mini; **fronteiras** — último dia aberto `disponivel`, primeiro e último dia fechado `indisponivel`, primeiro
dia reaberto `disponivel`, iguais em administração, cotação pública e servidor, com a noite da mesma quarta inalterada; legado da
Kidmais = matriz 006/017.

Sem chamadas externas, banco remoto, push ou deploy. Passos S não executados.

## Execução 1 — `44ce38f` (FALHA)

Pacote: [ATUALIZACAO_STAGING_20261011.md](../ATUALIZACAO_STAGING_20261011.md) §3. Candidata autorizada:
`44ce38f69d2302ae85e0454790afb062046f980d` (código `6099692`). Autorização de Felipe: L1–L3 (seis suítes PostgreSQL em cluster local
novo, dados sintéticos); parar e reportar se alguma falhar. Não inclui S0–S9, operações remotas, push ou deploy.

**Resultado: FALHA em L2 — 5/6 suítes OK; `disponibilidade-empresa` 1/4 (defeito do fixture do teste). S0–S9 não executados.**

### Passos
| Passo | Resultado |
|---|---|
| Pré-condições | HEAD `44ce38f`; só `docs/` após `6099692`; árvore limpa; sem `.env*`/`DATABASE_URL`/`PG*`; 55498 livre; `KIDMAIS_HOMOLOGACAO_DATABASE_URL` fora do ambiente dos comandos |
| L1 | `.local-descartavel-pg-351931ddefa24d86968d7e50c445dd5e`: `CRIADO`, `INICIADO` (127.0.0.1:55498), `CONFERE`, PostgreSQL 18.0006, bancos `[]` |
| L2 | 5/6 OK — log: [atualizacao-staging-l2-20261011.txt](atualizacao-staging-l2-20261011.txt) |
| L3 | `PARADO`; pasta preservada; 55498 livre; 18 pastas `.local-*` |

| Suíte | Modelo | Resultado |
|---|---|---|
| `adicionais-070` | 063 | OK 9/9 |
| `catalogo-buffet-078` | 063 | OK 10/10 |
| `catalogo-ux` | 063 | OK 1/1 |
| **`disponibilidade-empresa`** (nova) | 063 | **FALHA 1/4** |
| `round4-remediacao` | atual | OK 8/8 |
| `hg8-catalogo` | atual | OK 6/6 |

### Falha
- Teste “cenário”: `error: Vigência de regra de pacote sobreposta para pacote …, dia 3 e configuração …` — o banco tem gatilho de
  integridade que **proíbe vigências sobrepostas** do mesmo pacote/dia/período. O fixture inseria a “janela da quarta” (INDISPONIVEL,
  14 dias) sobre a regra aberta DISPONIVEL do mesmo dia/período; o banco recusou. **Defeito do teste**, não do produto.
- Consequências em cascata: “isolamento” esperava 12 regras de B e encontrou 11 (a janela não existe); “coerência” falhou na asserção
  específica da janela (`quartaNaJanela`: esperado `indisponivel`, obtido `disponivel` — correto, pois a regra não foi gravada).
- **Comprovado mesmo assim (asserções anteriores às que falharam, no mesmo teste):** na grade de 35 dias × 2 períodos, a decisão da
  tela com as regras lidas para a administração e para a cotação pública foi **igual à do servidor** (`buscarElegibilidadePacoteAplicavel`)
  para A (POCKET todos os dias), B (POCKET dias úteis + sábado almoço SOB_CONSULTA) e B-Mini (sem regra) — `divergencias = []`; e os
  casos sábado A disponível / B consulta / B noite indisponível. O teste do **legado da Kidmais passou**: regra fixa da tela = matriz do
  servidor (006/017) para todos os pacotes da Kidmais na grade.
- Não comprovado nesta execução: o caso de troca de vigência (regra anterior encerrada e nova a partir de uma data) e as asserções de
  isolamento que dependiam da contagem de 12.

### Correção proposta (não feita — exige nova candidata e nova autorização de L)
Modelar a janela como no produto: encerrar a regra DISPONIVEL da quarta/almoço de B na véspera da janela, inserir INDISPONIVEL na
janela e uma nova DISPONIVEL depois (vigências contíguas, sem sobreposição); ajustar a contagem esperada; manter o restante. A lógica
da tela (`regraDaEmpresa`) continua válida para vigências contíguas. Sem efeito em código de produto.

Efeitos: só a pasta local do cluster (git-ignorada), preservada. Sem chamadas externas, banco remoto, push ou deploy.
