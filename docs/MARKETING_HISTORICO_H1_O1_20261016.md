# Marketing — H1 (destino durante a volta) e O1 (mensagem depois de salvar) do guardião do histórico (16/10/2026, somente local)

**Goal:** nota `Goal Correcao Historico Marketing H1 O1` no vault.
**Base:** `30b93fb` (árvore `f253bea`), reprovada em `revisao-marketing-historico-f1f3-30b93fb-parecer-20261016/PARECER.md`. P2: H1. P3 (não bloqueante): O1.
**Branch:** `codex/marketing-historico-h1-o1-20261016`, worktree `kidmais-manager-marketing-historico-h1o1-20261016`. Só local, sem push.
**Revisão independente:** pendente. **Aceite humano:** pendente.

## H1 — causa (reproduzida na base)

Sem Navigation API, ao chegar a uma entrada sem índice de uma página que tem entradas dos dois lados do editor, a volta tentava `history.go(+1)`. No fim do histórico esse movimento **não tem destino**: o navegador não faz nada e não dispara popstate. O guardião esperava o vigia de 800 ms.

Nesse intervalo, o popstate de uma travessia da pessoa era tratado como a chegada do `+1` (`t.emVoo`). O `+1` fictício era somado ao deslocamento:
- **RV-I1 / I-4:** um `go(-3)` da pessoa virava `delta −2` em vez de `−1`, e "Sair" ia ao Dashboard em vez de Campanhas;
- **I-1:** um Voltar cancelava o retorno aritmeticamente e o pedido era engolido.

Reproduzido na base desta rodada:
- relógio controlado: I-1 e I-4 FALHA, 4/6;
- Next real sem API: RV-I1 → Dashboard; H1-a150/a300 → Dashboard; H1-v150/v500 → sem diálogo, pedido engolido.

## H1 — solução

**1. Todo movimento da correção tem destino.**
- **Salto** a partir de uma entrada indexada: `go(k − j)`, que nunca passa da entrada do editor `k`. Se os índices tiverem lacuna, passos de ±1 (abaixo).
- **Passo** a partir de uma entrada sem índice alcançada pela pessoa (posição desconhecida):
  - **−1** sempre existe: uma entrada sem índice nasceu de uma entrada anterior deste documento (fragmento, `location.hash`). Mesmo que se afaste do editor, chega à entrada que a originou, e dali a volta segue por índice.
  - **+1** só onde é certo que o editor está à frente: na entrada inicial do documento (registrada com a URL na instalação) ou quando todas as entradas indexadas dessa página estão atrás do editor.
- Depois de um salto, a direção do editor fica conhecida. Uma chegada sem índice segue nessa direção (a que leva ao editor), sem loop.

**2. Atribuição por ordem, sem presumir.**
- As travessias são atendidas em fila. Como o nosso movimento tem destino, o popstate seguinte é dele.
- **Exceção:** a chegada é impossível para ele. Isso vale quando:
  - o índice está fora da faixa do salto (`j < idx ≤ k`, ou o espelho);
  - depois de um passo −1 a partir de um fragmento, a página é diferente da que o originou.
- Nesse caso o popstate é de uma travessia da pessoa que já estava na fila: o destino passa a ser onde ela chegou. O nosso movimento continua pendente e será aplicado a partir dali.
- Um evento da pessoa zera o deslocamento e torna a direção desconhecida de novo.

**3. Salvaguarda.**
- O vigia (800 ms) só age se uma premissa falhar, como índices duplicados herdados.
- O movimento sem popstate **nunca** entra no deslocamento: um salto vira passos, um passo inverte uma vez, e depois a volta encerra sem estado preso.

**4. Representação (sem fabricar campos do Next; nulo continua nulo).**
- `maior`, `incerto`, `contiguo` e `comprimento` (history.length) distinguem fragmento novo de travessia.
- Uma entrada criada a partir de uma entrada sem índice de posição incerta recebe `maior + 1`: índice único, ordem preservada.
  - Antes, recebia o índice da última entrada indexada visitada, que podia ser de outra página. O resultado era índice duplicado, com risco de considerar como editor uma entrada de outra página.
  - A partir daí os saltos dão lugar a passos.
- `replaceState` numa entrada sem índice de posição incerta não inventa índice.

**Comportamento observado (Next real, Chrome headless, sem API).** Na RV-I2, de Campanhas#fim a volta faz −1 (Campanhas seguinte) e depois o salto −1 (editor). Os popstates chegam 42–46 ms um depois do outro (espera de 40 ms mais 2–6 ms de atendimento), e o retorno completo leva cerca de 87–91 ms. Não há mais espera de 800 ms nesse caminho.

## O1 — causa e política depois de salvar

**Política mantida.** Se o salvamento termina enquanto uma travessia é corrigida, a volta se completa e o pedido mais recente é apresentado (F2). Nada sai sozinho.

**Causa.** O diálogo (`MarketingSite.tsx`) afirmava sempre "ainda não foram salvas… elas se perdem" e oferecia "Salvar e sair", mesmo com `data-estado="salvo"` (RV-I5, nos dois modos).

**Solução.** `components/admin/marketing/dialogo-alteracoes.ts` (`conteudoDialogoAlteracoes`) define texto e ações pelo estado real (`salvo/sujo/salvando/erro`):

| Estado | Texto | Ações |
|---|---|---|
| salvo | "…já foram salvas. Você pode sair do editor sem perder nada." | Continuar editando · Sair (ou Trocar) |
| sujo (inclusive o que foi digitado durante o envio) / salvando | inalterado: "…ainda não foram salvas. Se sair agora sem salvar, elas se perdem." | Continuar editando · Salvar e sair · Sair sem salvar |
| erro | "O salvamento… falhou: as alterações ainda não foram salvas…" | as mesmas de sujo |

O `<dialog>` nativo, o foco inicial em "Continuar editando", o Esc para permanecer e `aria-labelledby`/`aria-describedby` não mudaram.

## Testes

Logs e contagens estão no pacote de revisão desta rodada.

**`protecao-saida.test.ts` (48).** Os 25 anteriores, mais:
- matriz H1 em dois históricos (o da RV-I1 e o da I-1/I-4): sem ação e com Voltar, Avançar, go(−3), go(−4) e go(+2) da pessoa em 12 instantes, de 5 a 900 ms, durante e depois da volta;
  - oráculo: posição onde a última travessia da pessoa chegou, registrada pelo histórico falso;
- réplicas de I-1/I-4/I-5/I-6 com a ação aos 20 e 60 ms, quando a correção ainda está fora do editor;
- o caso de ambiguidade (abaixo);
- a representação (entrada criada de posição incerta);
- a salvaguarda (índices duplicados herdados).

**`dialogo-alteracoes.test.ts` (4).** Estados salvo, sujo, salvando e erro, para sair e para trocar.

**Next real (roteiro próprio, oráculo do modelo de histórico).**
- H1 sem API em 12 cenários: gesto no instante da chegada, no meio da volta, depois dela, e a +150/+300/+500 ms.
- O1 nos dois modos:
  - salvo sem nova edição;
  - nova edição durante o envio;
  - falha ao salvar;
  - cancelamento ("Continuar editando" durante o salvamento);
  - pedido novo durante o salvamento.

**Regressões:**
- M-1..3;
- roteiro da revisora (19 por modo);
- AdminShell (9 por modo);
- roteador sintético (21 por modo);
- memória (22).
  - A memória troca `useProtecaoDeSaida` por um stub (`prova-editor-rh1f.cjs:58`): valida o estado do editor, **não** a proteção do histórico.

**Provas da revisora que dependem do defeito.** I-1/I-4/I-5/I-6 originais e RV-I1 agem 100–150 ms depois da chegada, exigindo que o guardião ainda espere o vigia de um `go(+1)` sem destino (I-1 linha 98; RV-I1 `emVoo === 1`). Esse movimento deixou de existir: a volta termina em cerca de 90 ms. Elas falham pela pré-condição, e os resultados seguem o oráculo:
- na I-4, o `go(−3)` parte do editor e não tem destino, então a última chegada da pessoa é `#x`;
- nas I-5/I-6, o pedido foi entregue antes da reativação ou da saída, e a saída explícita não teve retorno tardio.

**Interface.** O H-5 (sintético) e o B-7 (AdminShell) clicavam "Salvar e sair" depois de a resposta salvar. Com O1, o botão é "Sair". As variantes com essa única troca, mais a conferência do texto, estão no pacote.

## Limites

- **Ambiguidade irredutível.** Uma travessia da pessoa já na fila quando a correção pede um movimento (até cerca de 2–6 ms antes, no Chrome medido) gera os mesmos popstates nas duas ordens possíveis, quando a chegada é compatível com o nosso movimento.
  - O guardião termina coerente (editor, nada ao roteador, nada perdido) e usa uma ordem válida. O destino pode ser a entrada vizinha daquela que a ordem real daria.
  - Teste "ambiguidade" no `protecao-saida.test.ts`.
- **Entradas sem índice que não são fragmentos.** Por exemplo, `pushState(null)` fora do Next, que embrulha o estado. A premissa "a anterior é da mesma página" pode falhar. Se o vigia for necessário, a salvaguarda termina a volta.
- **Proteção iniciada numa entrada sem índice alcançada por travessia de vários passos:** ela usa a entrada indexada mais recente da mesma página. O fim é coerente; a posição no histórico pode ser outra entrada da mesma página.
- **Navigation API:** a ausência é simulada no Chrome; não é Firefox ou Safari nativos. O Next real é `next dev` com sessão e API sintéticas, sem banco nem E2E de produção.
- **Escopo:** sem mudança em API, serviço, banco, migrations, regras ou motor.
