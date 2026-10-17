# Marketing — A1 (colisão) e A2 (saída do documento) do guardião do histórico (17/10/2026, somente local)

**Goal:** nota `Goal Correcao Marketing Colisao A1 A2` no vault.
**Base:** `7fe6ed8` (árvore `e838790`), REPROVADA em `revisao-marketing-historico-rajada-7fe6ed8-parecer-20261017/PARECER.md` (manifesto 169, `cfdd9b49…`) por **A1/P2** e **A2/P2**.
**Branch:** `codex/marketing-historico-a1a2-20261017`, worktree `kidmais-manager-marketing-historico-a1a2-20261017`. Só local, sem push.

**Estado: GOAL NÃO CONCLUÍDO.** A1 e A2 foram reproduzidos (modelo e Chrome real) e a causa foi demonstrada. Nenhuma correção de código foi entregue: dentro do comportamento atual não existe estratégia que elimine A1 e A2 sem criar outra colisão do mesmo tipo (demonstração e medições abaixo). A única saída medida sem resíduo dessa classe é uma **mudança de comportamento** do caminho sem Navigation API ("decisão primeiro"), que exige decisão de Felipe e **não foi implementada** no produto. O código desta branch é idêntico ao de `7fe6ed8`; o commit traz só esta documentação.

## 1. Reprodução na base 7fe6ed8

### Modelo (relógio controlado; fila FIFO com alvo no atendimento; 0–130 ms × 7 ações × atendimento 1/3/5/10/20/30 ms; 11 históricos)

O modelo da revisora foi derivado só para conhecer **outro documento**: uma entrada fictícia antes do app; a travessia atendida para ela é "saída do documento", com autor e política do aviso (confirmar/cancelar). Fila, alvo no atendimento, no-op e oráculo não mudaram (`DERIVACAO-modelo-documentos.diff`, `DERIVACAO-varredura-v5.diff`).

| Modo | Base 7fe6ed8 |
|---|---|
| Sem documento anterior (as condições da v4 da revisora) | DESTINO_ERRADO **198** (AT 129, B2 69), PEDIDO_INDEVIDO 345, CONSERVADOR 410 (341 da revisora + 69 do histórico A2 acrescentado) — confere com o parecer |
| Documento anterior, aviso confirmado | **SAIU_PELA_CORRECAO 474** (RV-I1, I-1/I-4, fragmentos sucessivos, B, AT, B2 e A2: sempre na largura do atendimento), SAIU_PELA_PESSOA 4910 (gestos da própria pessoa, legítimos) |
| Documento anterior, aviso cancelado | igual ao "sem documento anterior" (a saída não acontece) |

- **A1 no modelo:** AT, `go(−2)` da pessoa já na fila antes do salto −2: DESTINO_ERRADO com largura igual ao atendimento.
- **A2 no modelo (histórico A2 = o A do Chrome, documento anterior, aviso confirmado):** `go(−3)` antes do salto −2: SAIU_PELA_CORRECAO em 1/3/5/10/20/30 instantes por tempo de atendimento.

### Chrome real

Ver a seção 5 (preenchida com as execuções desta rodada).

## 2. Causa comum de A1 e A2

O guardião, sem Navigation API, devolve a página ao editor com `history.go(m)` **relativo**. O navegador atende as travessias em fila e resolve o alvo de cada uma no atendimento. Uma travessia da pessoa pedida um pouco antes da nossa é atendida primeiro, e o nosso movimento — que não pode ser cancelado — é resolvido a partir de onde ela chegou.

- **A2:** o salto −2, resolvido a partir de Campanhas(1), passa do início do documento e tenta sair dele. Um passo −1 só sairia se a pessoa já estivesse na 1ª entrada; um salto −m sai de qualquer uma das m primeiras.
- **A1:** a chegada da pessoa (Dashboard) é exatamente a que o salto −2 teria a partir do `#fim` anterior, e o salto deslocado não tem destino (nenhum popstate). As duas ordens produzem as mesmas observações.

### Por que nenhuma escolha de movimento resolve (dentro do comportamento atual)

Para qualquer movimento relativo m que o guardião peça a partir de P:

1. **Ordem "pessoa primeiro" com o mesmo gesto m:** ela chega a P+m; o nosso, resolvido dali, vai a P+2m.
2. **Ordem "guardião primeiro":** chegamos a P+m; ela, com o mesmo gesto m, vai a P+2m.

Se P+2m existe no documento, as duas ordens dão a mesma sequência de popstates (URL e índice), com intenções diferentes (P+m × P+2m). Se P+2m não existe, a 1ª ordem não emite mais nada (no-op) ou sai do documento, e a 2ª coincide com "ninguém fez nada". A página não vê a ordem dos pedidos nem cancela um movimento já pedido. Logo, **todo** movimento ativo tem um gesto gêmeo da pessoa — a estratégia só escolhe qual gesto colide:

| Rodada | Movimento | Gesto que colide | Consequência medida |
|---|---|---|---|
| f37a965 | passo −1 | Voltar | H1-R3 (engolido) |
| 4a5dac4 | passo −1 + limiar de 16 ms | Voltar, por tempo | N1 (destino de outra página) |
| 7fe6ed8 | salto exato/≥2 | `go(−m)`; e saída do documento | A1, A2 |
| experimento "passos" (esta rodada) | sempre −1 para trás | Voltar; e no-op que deixa a volta perdida | DESTINO_ERRADO 138, INCOERENTE 1908, SAIU_PELA_CORRECAO 2356 |
| experimento "aposta para frente" (esta rodada) | +1 na posição ambígua | o próprio no-op, por até 800 ms | A1 zerado, mas PEDIDO_INDEVIDO 1914 (546 por histórico "à frente") e A2 intacto (345) |

Os dois experimentos estão no pacote (código, diff sobre 7fe6ed8, varreduras). Nenhum deles foi adotado: cada um troca uma colisão por outra, o que o goal proíbe.

**O que diferencia as ordens.** Só a ordem dos pedidos e o instante de atendimento (a página não os vê; usar tempo foi o erro de N1/N3), e o `beforeunload` — que aparece nas duas ordens quando o gesto da pessoa também sai do documento. Nenhum dado de estado ajuda sem fabricar campos em entradas de estado nulo (proibido).

## 3. Proposta para decisão de Felipe: "decisão primeiro" (só sem Navigation API)

**Comportamento proposto.** Quando a pessoa sai da página do editor com alterações não salvas, sem Navigation API:
1. o guardião **não volta sozinho**; o diálogo abre na hora, e o destino é a **entrada atual** — onde a pessoa realmente está (observado, nada inferido);
2. novas travessias dela com o diálogo aberto só atualizam o destino; voltar à entrada do editor fecha o diálogo;
3. **"Sair sem salvar"** não faz travessia: a página já está no destino; o app passa a mostrá-la;
4. **"Continuar editando"** faz a volta ao editor (o mesmo algoritmo de hoje) — só depois de a pessoa decidir.

**Efeitos.**
- Elimina a classe de A1/A2/N1/N3/H1-R3: nenhum movimento nosso concorre com gestos da pessoa enquanto ela navega; o destino é sempre exato; nenhuma saída de documento é causada pela correção (as que restam são gestos da própria pessoa, com o aviso nativo).
- Elimina o CONSERVADOR (N2) dessa classe: não há par a interpretar.
- **Muda o que se vê:** com o diálogo aberto, a barra de endereço mostra a página para onde a pessoa foi (hoje volta ao editor antes do diálogo). Coerência URL × tela passa a valer **depois da decisão**. Recarregar com o diálogo aberto carrega a página de destino (o aviso de saída continua protegendo a edição).
- Só no caminho sem Navigation API (Firefox/Safari sem a API); o caminho com a API (`traverseTo` por chave) não muda.
- Os roteiros de revisão que exigem a URL do editor **antes** de "Sair" precisam do novo critério.

**Prova (protótipo de modelo, não entregue).** `experimentos/decisao-primeiro` (diff sobre 7fe6ed8: diálogo na chegada, `continuarEditando()`), varredura `varredura-decisao-v6.mjs`: 11 históricos × 7 ações × 131 instantes × 6 tempos × 2 decisões × com/sem documento anterior — 207768 cenários: **OK 203052; SAIU_PELA_PESSOA 4716** (só gestos dela para o documento anterior); **zero** movimento antes da decisão, DESTINO_ERRADO, PEDIDO_INDEVIDO, CONSERVADOR, INCOERENTE ou SAIU_PELA_CORRECAO.

**Resíduo da proposta.** Depois de "Continuar editando", um gesto da pessoa nos milissegundos seguintes ao clique cruza com a volta (a mesma ambiguidade, agora só após uma decisão explícita e com dois comandos quase simultâneos dela). A implementação completa precisa reabrir o diálogo nesse caso; o protótipo não cobre isso.

**O que a implementação exigiria (se aprovada).** Guardião (caminho sem API), `DestinoSaida` com o destino "aqui", o hook (`useProtecaoDeSaida`: "Sair" faz o app mostrar a entrada atual, "Continuar" chama a volta) e o diálogo; testes comportamentais, Chrome real (novo critério de coerência), O1 nos dois modos e as regressões de histórico.

## 4. Decisões pendentes (Felipe)

1. **Adotar "decisão primeiro"** (mudança de comportamento descrita acima), ou
2. **aceitar um resíduo** de retorno ativo — escolhendo qual: A1/A2 (7fe6ed8), a colisão com o Voltar (passos) ou a janela do no-op (aposta para frente) —, ou
3. outra direção de produto.

N2 e o aviso `beforeunload` herdado continuam pendentes como antes. Nada aqui é aceite.

## 5. Chrome real (esta rodada)

Next dev em cópias próprias (base 7fe6ed8 conferida por bytes, 2502/2502 antes e depois; experimento "aposta para frente" = a mesma cópia com o arquivo do experimento), AdminShell/editor/hook/guardião reais, sessão e API fictícias, sem banco, tráfego externo abortado (0), Navigation API removida por simulação, documento anterior fictício servido por rota local. Roteiro `janela-r1r3.mjs` da revisora (cópia só com caminhos trocados) e os **mesmos parâmetros** das provas de origem; chamadas a `history.go` (autor) e popstates (índice) registrados antes da página; aviso nativo registrado em cada execução e decidido pela política declarada (cancelar/confirmar).

| Cenário | Base 7fe6ed8 | Experimento "aposta para frente" |
|---|---|---|
| **A1** — AT, `go(−2)` 36–44 ms (2 rep.) | **DESTINO_ERRADO 5/14** (revisora: 4/14) | OK 14/14 |
| AT, Voltar 36–44 ms | OK 14/14 | OK 6, ORACULO_INVALIDO 8 (a volta passa pela salvaguarda de 800 ms — `g+1@846` — e a reprodução FIFO não fecha; descartado, não é aprovação) |
| AT, `go(+2)` | OK 7, ORACULO_INVALIDO 7 (coalescência, como na revisora) | OK 14/14 |
| **A2** — A, documento anterior, aviso **confirmado**, `go(−3)` N1 | **SAIU_DO_DOCUMENTO 6/8** (revisora: 8/8) | SAIU 7/8 (o experimento não trata A2) |
| A, aviso confirmado, `go(−4)` N1 / `go(−3)` N2 | SAIU 7/8 / 8/8 | SAIU 6/8 / 8/8 |
| A, documento anterior, aviso **cancelado** (3 gestos) | OK 24/24, aviso em 20 execuções | OK 24/24, aviso em 20 |
| B2, N2 / N1 Voltar 0–41 ms | OK 17 + CONSERVADOR 3 / OK 20 | OK 16 + CONSERVADOR 4 / OK 18 + ORACULO_INVALIDO 2 |

- A1 e A2 reproduzidos na base, no mesmo gesto e janela do parecer.
- O experimento confirma no navegador o que o modelo mostrou: corrige o `go(−2)` do AT, mas passa a depender da salvaguarda de 800 ms (ORACULO_INVALIDO no Voltar) e não toca em A2.
- O protótipo "decisão primeiro" **não roda no Chrome** sem mudar o hook e o diálogo (o destino "aqui" e "Continuar editando" acionando a volta) — exatamente a mudança que depende de decisão; a prova dele é só de modelo.
- **Aba sem entrada anterior:** não verificável neste harness (a página do Playwright começa com `about:blank` antes); no modelo, o modo "sem documento anterior" (no-op real antes da 1ª entrada) está coberto.

## 6. Verificações desta rodada

- Código da branch idêntico a 7fe6ed8 (só documentação): as regressões de 7fe6ed8 (parecer: não-PG 136/136, tsc/ESLint 0, O1, O-2, B-N1 32/32, A-R1/R2/R3) valem para ela. Reexecutados aqui: não-PG, tsc e ESLint (ver pacote).
- Não executados (nada mudou no código): build/static, roteiros RV/RV-2/independentes/AdminShell-O1/sintético.
