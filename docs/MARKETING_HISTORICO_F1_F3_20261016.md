# Marketing — correções F1–F3 do guardião do histórico (16/10/2026, somente local)

**Goal:** nota `Goal Correcoes Historico Marketing F1 F3` no vault.
**Base:** `a757fa2` (R-H1-F), reprovada em `revisao-marketing-ux-rh1f-a757fa2-parecer-20261016/PARECER.md`. Bloqueante: F1. Médios: F2 e F3. Herdado: F4.
**Branch:** `codex/marketing-historico-f1-f3-20261016`, worktree `kidmais-manager-marketing-historico-f1f3-20261016`. Só local, sem push.
**Revisão independente:** pendente. **Aceite humano:** pendente.

## Causas (reproduzidas na base com o arquivo real: M-1, M-2 e M-3 FALHA)

- **F1.** Uma âncora da prévia (`<a href="#…">`) cria uma entrada **nova com estado nulo** e dispara `popstate`. Uma edição começada ali ativava a proteção com `indice = null`, e o guardião ignorava tudo. O segundo Voltar chegava ao App Router.
  - **Premissa falsa da rodada anterior:** "entradas sem índice ficam necessariamente atrás". Elas podem estar atrás, à frente ou ser a própria entrada onde a edição começou.
- **F2.** O popstate de saída era barrado. Se o salvamento terminasse dentro da espera de 40 ms, a proteção caía e o temporizador desistia, sem voltar nem entregar a travessia. Resultado: URL de outra página com o editor montado.
- **F3.** O retorno presumia "sem índice = atrás" e fazia `history.go(1)` sem entrada à frente (no-op, sem popstate). O estado da correção ficava preso: diálogo indevido no Voltar seguinte e destino calculado (−2 em vez de −1).

## Solução

**Proteção por página do editor** (caminho + busca; o fragmento não muda a página nem a árvore do roteador).
- Com edição, uma travessia para uma entrada da **própria página** (fragmentos da prévia, a entrada do editor) é **livre**: barrada só para o roteador, que já está nessa página, e sem diálogo.
- Uma travessia para **outra página** é barrada antes do roteador. A página volta ao editor e o pedido é apresentado.
- Com um pedido aberto (diálogo), sair da entrada do editor conta como nova tentativa.

**Representação do histórico sem Navigation API.**
- Continua o índice `__kidmaisIdx` em entradas criadas por `pushState`. Agora só em **objetos simples**, copiados, com os campos do Next preservados. Nulo continua nulo; arrays e instâncias ficam como estão (O1).
- O índice dá **ordem** e um **limite inferior** de distância, não posição: entre duas entradas indexadas pode haver entradas sem índice.
- Um mapa índice → página orienta a direção quando a entrada atual não tem índice.
  - Uma entrada sem índice de outra página é um fragmento depois de uma entrada daquela página ou a **entrada inicial do documento**, quando ela começou sem estado. A inicial fica atrás de todas as indexadas e é registrada na instalação; se ganhar índice depois (hidratação do Next), o registro cai.
  - Sem esse dado, a primeira tentativa ia na direção errada (no-op) e a volta esperava o vigia. No roteador sintético sem API, isso fazia o H-9 falhar (diálogo atrasado e correção viva quando a pessoa salvou e voltou). Encontrado na regressão desta rodada e coberto por teste.
- A proteção que começa numa entrada sem estado usa a **entrada indexada da mesma página** que a precede (a do editor). Ela nunca fica desativada em silêncio, e nenhum campo do Next é fabricado.

**Retorno e destino medidos.**
- A volta à entrada indexada do editor usa:
  - **saltos** `history.go(k − j)`, que nunca a ultrapassam;
  - **passos** onde não há índice;
  - um **vigia** (800 ms sem popstate depois de um `go`): inverte uma vez; depois, encerra sem deixar estado preso.
- O **destino** é o deslocamento **real**, a soma dos próprios movimentos confirmados por popstate. Não é deduzido de índices.
- Uma travessia da pessoa durante a volta redefine o destino para onde ela chegou.

**Término garantido e política depois de salvar (F2).**
- Toda travessia interceptada termina na entrada do editor, com URL e página coerentes.
- Se a proteção **cair durante a volta** (o salvamento terminou), a volta **se completa e o pedido é apresentado**: a decisão mais recente, o Voltar, é preservada, e a pessoa escolhe.
- Se a proteção for **reativada** durante a volta (salvou e digitou de novo):
  - ela herda a página e a entrada do editor (a URL mostra a página de saída só por um instante);
  - o pedido vai à proteção vigente; o callback antigo não é chamado.
- Só uma **saída explícita** (liberado: descartar, salvar e sair, link) abandona a correção. A navegação escolhida vence, sem navegação dupla.

**Com Navigation API:** volta pela chave, como antes, com o mesmo critério de página. Âncora da própria página é livre.

**Efeito em F4 (herdado).** Clicar numa âncora da prévia com edição **deixou de abrir "Sair do editor?" nos dois modos**. Isso é consequência da regra de página, não redesenho; está coberto por testes (RV-2, F3) e é coerente com a documentação do hook ("âncora da própria página não é interceptada").

**Instalação.** O guardião continua no layout raiz. O estado do guardião é único por janela (`__kidmaisGuardiaoHistorico`): Strict Mode e Fast Refresh não registram um segundo guardião (O3).

## Testes

Resultados e logs no pacote de revisão.

- **`protecao-saida.test.ts` (25 cenários).** Código real, janela e histórico falsos com relógio controlado (intercalação determinística). Cobre:
  - F1 antes e depois de salvar;
  - F2 em 5/15/25/35 ms, com controles de 60/120 ms;
  - saída explícita durante a espera; reativação durante a volta;
  - F3;
  - entradas sem índice à frente e de página com entradas dos dois lados, com no-op e inversão;
  - entrada inicial do documento sem estado, de uma página que também está à frente (H-9);
  - preservação do estado;
  - os dois modos.

  Na base, o mesmo arquivo falha 16 de 25. Dois desses (F1 com API) refletem a mudança deliberada em F4. O H-9 falha na base só pela representação do destino (`voltar` em vez de `relativo`); o comportamento dele passa na base no roteador sintético.
- **Critérios da revisora já corrigidos por ela.** RV-5b nos dois modos e RV-5 com API falham igual na base e na candidata, pelo critério inicial que o parecer declara errado. Os cenários objetivos que o substituem (RV-0, RV-5b2, RV-6b) são os que contam.
- **Provas da revisora** (cópias): mínima M-1..3, RV e RV-2 no Next real com o AdminShell real, nos dois modos.
- **Regressões:** memória 22, roteador sintético 21 por modo, AdminShell real 9 por modo.

## Limites

- **Ausência da Navigation API simulada no Chrome 155.** Não é Firefox ou Safari nativo.
- **Interleaving no milissegundo.** Se uma travessia da pessoa e um movimento da correção se intercalarem no mesmo milissegundo, o destino pode refletir a ordem do navegador. O fim é sempre na entrada do editor.
- **Entrada sem índice com a página dos dois lados.** A direção é tentada e corrigida pelo vigia, o que pode custar até 800 ms numa situação rara. Durante esse tempo a URL mostra a página de saída e o editor continua montado; a volta sempre termina.
- **Outro documento:** `beforeunload`.
- **Escopo:** sem mudança em API, serviço, banco, migrations, regras ou motor.
