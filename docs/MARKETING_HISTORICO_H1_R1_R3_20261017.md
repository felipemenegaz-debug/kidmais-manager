# Marketing — H1-R1/R2/R3 do guardião do histórico (17/10/2026, somente local)

**Goal:** nota `Goal Correcao Historico Marketing H1 R1 R3` no vault.
**Base:** `f37a965` (árvore `5b1787b`), reprovada em `revisao-marketing-historico-h1o1-f37a965-parecer-20261016/PARECER.md`: H1 parcial (R1, R2, R3); O1 corrigido.
**Branch:** `codex/marketing-historico-h1-r1-r3-20261017`, worktree `kidmais-manager-marketing-historico-h1r1r3-20261017`. Só local, sem push.
**Revisão independente:** pendente. **Aceite humano:** pendente.

Escopo: só o caminho **sem** Navigation API (fallback) do guardião, em `components/admin/marketing/protecao-saida.ts`, e o `sair()` do hook. O1 (`dialogo-alteracoes.ts`, `MarketingSite.tsx`), o caminho com Navigation API, o layout raiz e a ordem dos ouvintes não mudaram.

## O que a revisão mostrou e como foi reproduzido na base f37a965

O navegador atende as travessias em **fila**, e o alvo de cada `history.go(d)` é resolvido no atendimento. Uma travessia da pessoa pedida nos milissegundos antes de um movimento já pedido pela correção é atendida **antes** dele, e o movimento da correção passa a valer a partir de onde ela chegou.

Histórico da prova real: `[0 Dashboard, 1 Campanhas, 2 editor, 3 Campanhas, 4 Campanhas#fim (nulo)]`. A pessoa vai a `#fim`; a correção pede `go(−1)` cerca de 40 ms depois.

| Achado | Gesto na janela (pessoa antes) | Causa em f37a965 | Base, Chrome real |
|---|---|---|---|
| **H1-R1** destino errado | `go(−3)` → Campanhas idx 1 | `protecao-saida.ts:186/253–256`: a chegada era conferida só pela página. Campanhas idx 1 passou como se fosse a chegada do passo −1 (que só poderia ser Campanhas idx 3), e o deslocamento contou errado | DESTINO_ERRADO 6/6 (pessoa antes); "Sair" → Dashboard |
| **H1-R2** volta abandonada | `go(−4)` (chegada) ou `go(−3)` (depois do 1º movimento) → Dashboard | Chegada humana zerava a direção (`:258`), o movimento pendente virava no-op (início do histórico); `avancar` não reprogramava (`:170`) e a salvaguarda chamava `encerrar` (`:206–207`) | INCOERENTE 4/4 + 4/4: URL `/admin/dashboard`, editor montado, sem diálogo |
| **H1-R3** pedido engolido | Voltar → Campanhas idx 3 | Popstates iguais nas duas ordens (`[null, 3, 2]`); a escolha era "não perguntar" (`:149`, teste "ambiguidade") | ENGOLIDO 7/7 (pessoa antes) |

Reproduções desta rodada (logs no pacote):
- **Relógio controlado, varredura própria:** 0–130 ms, 7 ações, 5 históricos, atendimento de 1/3/5 ms. Na base: ENGOLIDO 27, DESTINO_ERRADO 45, INCOERENTE 27.
- **Chrome real:** roteiro da revisora com 2 repetições e cópia adaptada com 3 repetições.

## Solução

**1. O que se sabe de cada entrada (sem gravar nada no estado; nulo continua nulo).** O guardião mantém em memória:
- **índice e âncora:** para entradas indexadas, o índice; para fragmentos, a entrada indexada que os originou;
- **anterior:** para um fragmento **criado neste documento**, a entrada imediatamente anterior (`{ idx }` ou `{ url }`). Detecta-se a criação pela mudança de `history.length`.

Uma travessia até um fragmento com URL conhecida recupera esses dados. Com a âncora conhecida:
- o `pushState` seguinte recebe índice contíguo, em vez de "posição incerta";
- a direção é certa: âncora antes do editor → +1; senão → −1.

**2. Atribuição pela posição (H1-R1).** `possivel(de, mov, chegada)` confere se a chegada é alcançável pelo **nosso** movimento a partir de onde ele será resolvido:
- **salto contíguo:** índice entre a origem e o alvo, ou fragmento de âncora nesse intervalo;
- **passo −1 a partir de fragmento:** exatamente a anterior registrada (idx 3, e não idx 1);
- **passo +1:** a próxima indexada (âncora + 1) ou outro fragmento da mesma âncora; da entrada inicial, a primeira indexada.

O que não é possível é da pessoa. O nosso movimento continua pendente e é resolvido a partir de onde ela chegou; a próxima chegada é conferida a partir dessa nova origem.

**3. Nunca abandonar a volta (H1-R2).** Movimento sem destino (no-op) **não** conta deslocamento e **não** encerra a volta: ela é replanejada a partir de onde a página está.
- Um salto sem destino passa a passos.
- Um passo sem destino a partir da posição atual inverte a direção.
- Depois de inverter, o índice daquela origem não é usado para conferir chegadas, porque se mostrou falso.
- Quando é certo que o movimento não terá destino (passo −1 a partir da primeira entrada da aba, sem nada antes), a volta é replanejada na hora. Senão, a salvaguarda de 800 ms detecta o no-op.
- A conclusão exige índice **e** página do editor.

**4. Ordem indistinguível: perguntar, nunca engolir (H1-R3).** Seja um movimento nosso confirmado (chegada `e1`) seguido, **antes** do nosso próximo pedido e a menos de um quadro (`RAJADA_MS` = 16 ms), de uma chegada `e2` que seria exatamente o nosso movimento aplicado a partir de `e1`. As duas ordens geram o mesmo par.
- O par é interpretado como "a pessoa chegou a `e1` e o nosso movimento seguiu dali": destino `e1`, pergunta.
- Nenhuma reação humana a uma tela nova cabe em 16 ms. Quem pressiona nesse intervalo decidiu sobre a tela **anterior** ao nosso movimento, cuja continuação é `e1`.
- Fora desse intervalo, `e2` é da pessoa (destino `e2`).
- Não há navegação automática: "Continuar editando" mantém o editor, e o destino perguntado é uma chegada que a pessoa teria em uma das ordens, não um destino inventado.

> **Nota posterior (17/10/2026, rodada da rajada):** a regra do item 4 foi REPROVADA na revisão independente de `4a5dac4` (N1/P2): a premissa "nenhuma reação cabe em 16 ms" confunde tempo de reação com gestos independentes, e a ordem "pessoa primeiro" só existe dentro do tempo de atendimento. `RAJADA_MS` foi removida; o par passou a valer sem tempo e só quando a 2ª chegada é o editor, e a volta deixou de usar passos de 1 onde há salto seguro. Ver `MARKETING_HISTORICO_RAJADA_20261017.md`. O texto acima fica como registro do que foi entregue em `4a5dac4`.

**5. Saída explícita durante a volta (O-2).**
- O `sair()` do hook usa `executarSaida`: com uma volta em curso (sem Navigation API), a saída espera a volta chegar ao editor (de onde o destino relativo foi medido) e então segue. Nenhum movimento da correção acontece depois dela.
- Uma saída **direta** (fora do hook, `pushState` síncrono) com um movimento antigo já na fila é compensada: o movimento antigo é desfeito e a URL termina na saída escolhida.

## Comportamento observado (evidência desta rodada)

**Chrome real**, cópia adaptada do roteiro da revisora, 3 repetições, oráculo pela reprodução das chamadas conferida contra URL e índice:

| Gesto (ordem real) | Candidata | Base |
|---|---|---|
| R1 `go(−3)`, pessoa antes | OK 7/7 (Campanhas idx 1) | DESTINO_ERRADO 6/6 |
| R2 `go(−4)` (N1), pessoa antes | OK 5/5 | INCOERENTE 4/4 |
| R2 `go(−3)` (N2), pessoa antes | OK 3/3 | INCOERENTE 4/4 |
| R3 Voltar (N1), pessoa antes | OK 3/3 (pergunta por Campanhas idx 3) | ENGOLIDO 7/7 |
| R3 Voltar (N1), pessoa depois, no mesmo atendimento | CONSERVADOR 9/9 | OK 9/9 |
| Fora da janela e demais gestos | OK | OK |

- **CONSERVADOR:** a pessoa terminou no editor nesta ordem, mas a outra ordem realizável (a pessoa a menos de 16 ms do atendimento do movimento vizinho), com a **mesma** sequência de URL e índice, a deixa em outra página; a candidata pergunta por essa página. A classe aparece também em N2 Voltar (candidata 5, base 9). Nunca há ENGOLIDO, DESTINO_ERRADO nem INCOERENTE na candidata.
- **Roteiro original da revisora (2 repetições, oráculo sem a verificação de ordem):** candidata sem DESTINO_ERRADO, INCOERENTE e ENGOLIDO; PEDIDO_INDEVIDO apenas nos casos que a cópia adaptada classifica como CONSERVADOR.

**Relógio controlado (varredura própria, modelo da revisora):** candidata OK 11658 e CONSERVADOR 147, zero ENGOLIDO, DESTINO_ERRADO, INCOERENTE ou SAIR_ERRADO. A varredura original da revisora dá na candidata só PEDIDO_INDEVIDO, nos mesmos instantes.

**O-2:**
- **Chrome real:** Voltar e Avançar com o diálogo aberto e "Sair sem salvar" a 30–48 ms; base e candidata OK em todas as 50 execuções por raiz.
  - Na base o clique atingiu o movimento já na fila 8 vezes, e mesmo assim terminou coerente. A saída do app é assíncrona (`router.push`) ou enfileirada (`history.go`), e o movimento antigo é atendido antes dela.
  - Na candidata a saída esperou a volta em 6 casos com movimento na fila.
- **Modelo, saída síncrona por `pushState` direto:**
  - base: a URL termina no fragmento;
  - candidata: a URL termina na saída escolhida, com um movimento de compensação;
  - saída pelo caminho do app (`executarSaida`): 131/131 em todos os históricos e tempos.

## Política depois de salvar (inalterada)

Se o salvamento termina durante a volta, a volta se completa e o pedido mais recente é apresentado. O diálogo segue o estado real (O1), e nada sai sozinho.

## Correções das afirmações anteriores

A doc `MARKETING_HISTORICO_H1_O1_20261016.md` dizia que uma travessia da pessoa já na fila "gera os mesmos popstates nas duas ordens", que o guardião "termina coerente" e que usa "o destino de uma ordem válida". **Era inexato:**
- em H1-R1 a chegada tinha índice impossível para o movimento da correção, ou seja, era distinguível;
- em H1-R2 o fim era incoerente;
- em H1-R3 o resultado era o silêncio.

Esta versão:
- distingue pela posição o que é distinguível;
- nunca encerra a volta fora do editor;
- no par realmente igual, pergunta.

## Limites

- **Movimento antigo que sai do documento.** Quando a pessoa chega à **primeira entrada deste documento** na janela antes de um passo −1 já pedido, e há entradas de outro documento antes, o passo pedido tenta sair do documento. O navegador mostra o aviso de saída (`beforeunload`) da proteção.
  - Medido no harness, onde há `about:blank` antes: 8 avisos na candidata (R2, pessoa antes), também presentes na base.
  - Cancelado o aviso, a volta termina coerente pela salvaguarda (cerca de 800 ms com a URL da outra página).
  - Uma travessia já na fila não pode ser cancelada pela página.
- **CONSERVADOR.** No par indistinguível dentro de um quadro, a candidata pergunta mesmo quando, na ordem real, a pessoa terminou no editor ("Continuar editando" resolve).
- **Entradas sem estado que não sejam fragmentos** (fora do Next) e fragmentos com a mesma URL em âncoras diferentes caem na conferência por página. A salvaguarda termina a volta.
- **Navegação simulada:** a ausência da Navigation API é simulada no Chrome (não é Firefox ou Safari). O Next real é `next dev` com sessão e API sintéticas, sem banco e sem build de produção no navegador.
