# Marketing — regra de rajada (N1) do guardião do histórico (17/10/2026, somente local)

**Goal:** nota `Goal Correcao Marketing Rajada 16ms` no vault.
**Base:** `4a5dac4` (árvore `7d621ff`), REPROVADA em `revisao-marketing-historico-h1r1r3-4a5dac4-parecer-20261017/PARECER.md` (manifesto da revisão: 132 arquivos, `eaf90dae…`) por **N1/P2**: regressão de destino da regra `RAJADA_MS = 16`.
**Branch:** `codex/marketing-historico-rajada-20261017`, worktree `kidmais-manager-marketing-historico-rajada-20261017`. Só local, sem push.
**Revisão independente:** pendente. **Aceite humano:** pendente (N2, N3 e o aviso `beforeunload` continuam decisões de Felipe).

Escopo: só o caminho **sem** Navigation API do guardião (`components/admin/marketing/protecao-saida.ts`) e os testes dele. O1, o hook (`executarSaida`, `sair()`), o caminho com Navigation API, o layout raiz e a ordem dos ouvintes não mudaram.

## Correspondência com o parecer de 4a5dac4

| Item do parecer | Natureza (do parecer) | Esta entrega |
|---|---|---|
| **N1** (P2) destino de outra página pela regra de 16 ms | regressão | causa removida; reproduzido antes e corrigido (abaixo) |
| **N2** (P3) CONSERVADOR quando a pessoa volta ao editor | decisão de Felipe | a regra de perguntar continua, sem tempo; frequência e casos medidos abaixo. **Sem aceite** |
| **N3** (P3) R3 volta a engolir com atendimento > 16 ms | risco só no modelo | dependência de < 16 ms removida; modelo de 1 a 30 ms sem ENGOLIDO. No Chrome, o efeito não tinha sido reproduzido e continua sem reprodução |
| Aviso `beforeunload` herdado | decisão de Felipe | não redesenhado; medido de novo com documento anterior fictício |
| H1-R1/R2/R3 de origem, O-2 no app, O1 | corrigidos/preservados | regressões reexecutadas (abaixo) |

## Causa demonstrada

`4a5dac4` interpretava **qualquer** par "movimento nosso confirmado → chegada seguinte possível como o mesmo movimento", dentro de 16 ms e antes do próximo pedido, como "a pessoa foi atendida primeiro", e tomava a 1ª chegada como destino (`protecao-saida.ts:109–113, 376–379` de 4a5dac4).
- "Pessoa primeiro" só ocorre quando a travessia dela **já estava na fila** antes do nosso pedido: no máximo um tempo de atendimento. No resto dos 16 ms a ordem real é a da fila (o nosso primeiro), e a escolha leva a outra página.
- O tempo era usado no lugar da causalidade: duas chegadas próximas não provam que as ordens se confundem; o que as confunde é o tamanho do nosso movimento ser igual ao do gesto da pessoa (passo −1 = Voltar).
- O mesmo limiar fazia R3 depender de atendimento < 16 ms (N3).

Reproduzido antes da correção, na cópia própria de `4a5dac4` (árvore conferida por bytes, 2501/2501):
- **Chrome real, histórico B** `[Dashboard 0, editor 1, Campanhas 2, Automações 3, Automações#fim]`, roteiro da revisora (só caminhos trocados), gesto N2 Voltar de 0 a 22 ms depois do 1º movimento: ordem registrada antes da página `g−1@42, p−1@48`; a pessoa chega a **Campanhas(2)**; "Sair sem salvar" leva a **Automações**. DESTINO_ERRADO **8/8** em off 0/4/8/12; OK em 16/22/38/40.
- **Modelo da revisora** (fila FIFO, alvo no atendimento, relógio controlado), histórico B: DESTINO_ERRADO em 17 instantes por tempo de atendimento de 1 a 10 ms, 40 em 20 ms e 51 em 30 ms.

> **Nota posterior (17/10/2026, rodada A1/A2):** a revisão independente de `7fe6ed8` reprovou por A1 (o salto −2 na posição ambígua colide com `go(−2)` da pessoa) e A2 (o salto resolvido a partir de onde a pessoa chegou sai do documento). A premissa "salto, sem passos de 1 que colidam" só trocou o gesto que colide. Ver `MARKETING_HISTORICO_A1_A2_20261017.md`: nenhum movimento ativo elimina a classe, e há uma proposta ("decisão primeiro") pendente de decisão. O texto abaixo fica como registro do que foi entregue em `7fe6ed8`.

## Correção

1. **Sem limiar de tempo.** `RAJADA_MS` e a leitura de relógio do guardião foram removidas.
2. **Movimento que não se confunde com um gesto.** A colisão vem de passos de 1, do tamanho de um Voltar.
   - De um fragmento de cadeia conhecida (o guardião registra, para cada fragmento criado neste documento, a anterior e a âncora), a volta é **um salto exato** até o editor (no histórico B, `go(−3)`), em vez de `−1` seguido de salto.
   - De um fragmento **ambíguo** (mesma URL nascida de entradas diferentes), um salto ≥ 2 que, em todas as posições possíveis, não passa do editor nem sai do que se conhece do documento (`saltoAmbiguo`); a chegada (índice) revela a posição. Sem salto seguro, continua o passo de 1.
3. **Chegada exata pelo caminho conhecido** (`chegadaDe`). O guardião percorre as entradas indexadas (contíguas) e, depois de cada uma, a cadeia de fragmentos registrada que nasceu dela, e obtém a entrada **exata** que o movimento alcança. Só quando algo no caminho é desconhecido (lacuna de índices, posição incerta, cadeia ambígua) volta a conferência por faixa. Para isso o registro de fragmentos passou a ser podado a cada entrada nova (`podarDepois`): um `pushState` ou um fragmento novo descarta o que estava à frente, inclusive os fragmentos da própria âncora depois da posição atual.
   - Posição ambígua: a chegada é possível se for a partir de **alguma** das posições registradas, nunca "mesma página".
4. **Par sem tempo, só contra o silêncio.** Depois de um movimento nosso confirmado e antes do próximo pedido, a pessoa pode chegar ao **editor** por uma chegada que seria **exatamente** o nosso movimento aplicado à 1ª chegada (`exatamente`). A leitura pela fila diria que ela voltou e engoliria a outra leitura possível: que ela saiu e o nosso movimento a trouxe. Só nesse caso o guardião pergunta pela 1ª chegada (H1-R3 preservado, nunca o silêncio).
   - **Entre duas saídas, vale a fila**: uma saída observada nunca é trocada por outra presumida, e é isso que elimina N1.
   - Sem exatidão (com um fragmento no caminho que o salto atravessa), não há outra ordem com aquele destino, e o guardião não pergunta.

Inalterados: a semântica da fila no modelo, o deslocamento medido pelos próprios popstates, o no-op que não conta, a volta nunca abandonada fora do editor, `executarSaida`, a compensação da saída direta, o estado do Next (campos preservados, nulo continua nulo).

### Como a correção chegou à forma final (iterações medidas nesta rodada)

Três árvores de código foram congeladas e testadas; a evidência intermediária fica no pacote, separada:

| Árvore | O que tinha | O que a prova mostrou |
|---|---|---|
| `1d3fcc1` | sem `RAJADA_MS`; salto exato de cadeia conhecida; par sem tempo só para o editor; candidatos | B real OK. B2 real (dois `#fim` de mesma URL, volta em passos): Voltar da pessoa no mesmo atendimento do passo −1 → DESTINO_ERRADO 5/6 (colisão do passo com o Voltar) |
| `09ed434` | + salto ≥ 2 em posição ambígua; atribuição para frente a partir de fragmento | B2 real: Voltar logo depois do 1º salto → pergunta por Automações(5), entrada que nenhuma ordem alcança (par aceito por faixa de índices) |
| `dc43069` (final de código) | + chegada exata pelo caminho conhecido; poda do registro de fragmentos; par exige chegada exata | resultados abaixo |

## Resultados (árvore de código `dc43069`, cópias conferidas por bytes; base `4a5dac4`)

Ambiente: cópias próprias por `git archive`, `node_modules` copiado, ambiente fechado (lista explícita do sistema; recusa `.env*`, banco, proxy e segredos), sessão e API fictícias, Chrome headless com a Navigation API removida por simulação, tráfego externo abortado (0 em todas as execuções).

### Modelo (relógio controlado; fila FIFO com alvo no atendimento; 0–130 ms × 7 ações; atendimento 1/3/5/10/20/30 ms)

| Varredura | Base `4a5dac4` | Candidata |
|---|---|---|
| Revisora, original (5 históricos, oráculo dela) | DESTINO_ERRADO 168, ENGOLIDO 141 (20/30 ms), PEDIDO_INDEVIDO 263, CONSERVADOR 204 | **OK 23265, CONSERVADOR 138, PEDIDO_INDEVIDO 207**; 0 DESTINO_ERRADO, ENGOLIDO, INCOERENTE |
| Variante desta rodada (+ B, âncora ambígua à frente e atrás; troca só se realizável na fila) | DESTINO_ERRADO 749, ENGOLIDO 350 | **OK 37090, CONSERVADOR 488, PEDIDO_INDEVIDO 69, DESTINO_ERRADO 129**; 0 ENGOLIDO, INCOERENTE |
| Reativar / cair / sair pelo hook (4 históricos × 1/3/5/20 ms) | 1572 · 1572 · 1572 | **1572 · 1572 · 1572** |
| Saída direta por `pushState` (fora do hook; critério estrito conta a compensação) | 1456/1572 | 1514/1572 (termina na saída escolhida, com 1 movimento de compensação: O-1) |

- **Histórico B no modelo:** base DESTINO_ERRADO 17 por tempo de 1 a 10 ms (40/51 em 20/30); candidata só OK/CONSERVADOR.
- **PEDIDO_INDEVIDO da candidata (oráculo da revisora):** só "indexado +1/+2" e "fragmentos sucessivos −3", com largura igual ao atendimento — um gesto da pessoa do **mesmo tamanho** do salto da correção, já na fila antes dele, chega ao editor e o salto a tira dali. "indexado +1/+2" é herdado (o parecer de 4a5dac4 o descreve). "fragmentos sucessivos −3" é novo nessa forma (antes o 1º movimento era −1); na variante, que usa a última chegada efetiva da pessoa quando o gesto dela vira no-op, esses casos são CONSERVADOR.
- **Resíduos da variante (só no histórico "âncora ambígua, #fim atrás"):** a correção aposta numa direção e a posição real é a outra. DESTINO_ERRADO −2 (69) e +2 (60) e PEDIDO_INDEVIDO +1 (69), **todos com largura igual ao tempo de atendimento** (1+3+5+10+20+30 = 69): a travessia da pessoa já estava na fila antes do nosso pedido. No teste comportamental, cada DESTINO_ERRADO tem um cenário gêmeo realizável com **as mesmas observações** (URL + índice de cada popstate) e os mesmos pedidos em que a resposta dada é a correta — nenhum algoritmo que só veja popstates acerta os dois. Não foram reclassificados.
- **N3:** nenhuma classe da candidata depende de atendimento abaixo de 16 ms; as larguras crescem com o atendimento só onde a ambiguidade é real (a pessoa já na fila).

### Chrome real (Next dev, AdminShell, editor, hook e guardião reais) — `testes/next-real/RESUMO-classes.txt`

Oráculo da revisora: reprodução FIFO das chamadas a `history.go` registradas antes da página (autor, origem, horário) conferida contra URL e `__kidmaisIdx` de cada popstate; nenhuma execução ORACULO_INVALIDO.

| Cenário | Base `4a5dac4` | Candidata |
|---|---|---|
| **B N2 Voltar 0–22 ms depois do 1º movimento (N1)** | **DESTINO_ERRADO 8/8** em 0/4/8/12 (ordem `g−1@42 p−1@48`, a pessoa em Campanhas, "Sair" em Automações); OK em 16/22/38/40 | **OK 16/16** (salto `g−3` ao editor; o Voltar dela parte do editor e o destino é o Dashboard, onde chegou) |
| B N1 Voltar 0–40 ms (antes/no pedido) | OK 16/16 | OK 16/16 |
| **B2** (dois `#fim`, volta em passos) N2 Voltar | DESTINO_ERRADO 8/20 | **OK 15, CONSERVADOR 5** (off 38–40: Voltar dela e passo nosso no mesmo milissegundo, dela primeiro — troca realizável, mesmas observações) |
| B2 N1 Voltar | DESTINO_ERRADO 2/20 (off 41) | OK 20/20 |
| A R1 `go(−3)` / R2 `go(−4)`, `go(−3)` N2 / R3 Voltar (38–41 ms, 2 rep.) | OK 30, CONSERVADOR 2 | **OK 32/32** |
| A rajada N2 Voltar 0–22 ms (N2 do parecer) | CONSERVADOR 8/12 | **OK 12/12** |
| Carga 25 ms: A (R1/R3), B, B2 | A OK 18/18; B e B2 DESTINO_ERRADO 2/10 cada | A OK 18/18; B OK 20/20; B2 OK 16, CONSERVADOR 4 |
| Documento anterior fictício, aviso cancelado / confirmado | OK 12/12 / SAIU_DO_DOCUMENTO 8, OK 4 | OK 12/12 / SAIU_DO_DOCUMENTO 11, OK 1 |
| "Continuar editando" com diálogo aberto (fecha, mantém conteúdo e montagem; novo Voltar → um diálogo; Esc; nada recorrente em 2 s) | 6/6 | 6/6 |
| O-2 (roteiro do implementador), Voltar / Avançar | 10/10 · 10/10 | 10/10 · 10/10 |
| O1 real, com / sem Navigation API | 8/8 · 8/8 | 8/8 · 8/8 |
| RV (9), com / sem | 7/9 · 8/9 (RV-5/RV-5b, critérios históricos) | 7/9 · 8/9 (idem) |
| RV-2 (10), independentes-2 (5), AdminShell-O1 (9), por modo | 10/10 · 4/5 (RV-I1 acoplado) · 9/9 | 10/10 · 4/5 · 9/9 |

Medidos em cada execução da janela: URL final, conteúdo do campo, montagem (marca no `main`), diálogo, destino depois de "Sair sem salvar" e avisos nativos. Unidade/aba e estado de salvamento: cobertos pelo O1 real e pelo AdminShell-O1.

### Testes e checks

| Check | Resultado |
|---|---|
| Não-PG (guardião 61, diálogo 4, 11 de Marketing, 2 de Pix) | **136/136** (base anterior 131; +5 regressões novas) |
| `tsc --noEmit --incremental false` / ESLint dos 2 arquivos alterados | 0 / 0 |
| `check:v1:static` com build (ambiente fechado, cópia conferida) | aprovado |
| Sintético-O1 (21), com / sem | 21/21 · 21/21; nenhuma falha na base |
| M-1..M-3 (prova mínima da revisora anterior) | 3/3 nas duas raízes |
| I-1..I-6 (tempos antigos) | 2/6 nas duas raízes (critérios do tempo antigo; não exigidos) |

Regressões novas no guardião: N1 no histórico B (Voltar de 40 a 53 ms depois da chegada a #fim; o salto é pedido aos 41), varreduras de 786 cenários em B, fragmentos sucessivos, âncora ambígua (à frente e atrás), B' e B2 do Chrome, com a prova de gêmeo para cada DESTINO_ERRADO, o par só com chegada exata (CONSERVADOR com troca realizável; sem pedido quando o salto não podia levar ao editor), O-2 e os R1/R3 reescritos para o salto.

## Limites e decisões humanas pendentes

- **N2 / CONSERVADOR (decisão de Felipe, sem aceite).** A regra de perguntar continua, agora sem tempo e só com chegada exata. Medido: no histórico A desapareceu (o salto não deixa entrada intermediária); no B2 aparece quando o Voltar e o passo da correção são pedidos no mesmo milissegundo (5/20; 4/10 com carga). "Sair" leva ao destino da outra ordem, entrada legítima; "Continuar editando" mantém tudo.
- **Ambiguidade irredutível na largura do atendimento.** Quando a travessia da pessoa já está na fila antes do nosso pedido e tem o mesmo tamanho (ou leva à mesma sequência de observações) que o nosso movimento, as duas ordens são indistinguíveis; a correção adota a fila. Resíduos medidos: o PEDIDO_INDEVIDO herdado ("indexado +1/+2"), o novo "fragmentos sucessivos −3" e os DESTINO_ERRADO com gêmeo do histórico "âncora ambígua, #fim atrás". A largura é a da ambiguidade real, nunca 16 ms nem a janela de assentamento.
- **Aviso `beforeunload` herdado (decisão de Felipe), alterado na forma.** Um movimento já na fila, resolvido a partir de onde a pessoa chegou antes dele, pode tentar sair do documento. Com o salto, isso passa a ocorrer também com `go(−3)` no histórico A (antes, com `go(−4)`): candidata 15 avisos em A-r1r2r3 (base 14, em gestos diferentes), 9 com carga (base 0), 3 no roteiro "continuar". Cancelado, termina coerente e com o destino certo (OK em todas). Confirmado, sai do app — como na base. Não foi redesenhado.
- **Aba sem entrada anterior** (`history.length === 1`): não testada no navegador (o Playwright começa com `about:blank`); o caminho `primeiraDaAba` segue validado só no modelo. Errata do parecer mantida: o "no-op" de H1-R2 no harness anterior era saída do documento cancelada.
- **Salto ambíguo** só para trás; para frente, e com cadeia desconhecida, continua o passo de 1.
- **Registro de fragmentos** em memória por documento: recarregar a página o perde (a conferência volta à faixa, como antes).
- **Ambiente:** Chrome headless com Navigation API removida (não é Firefox/Safari nativos); `next dev`; sem banco, sem build de produção no navegador, sem celular. A memória 22 tem stub do hook e não valida histórico.

**Estado:** candidata local entregue; **revisão independente pendente**; aceite humano pendente. Nada publicado.
