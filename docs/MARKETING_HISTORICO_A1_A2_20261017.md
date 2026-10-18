# Marketing — A1 (colisão) e A2 (saída do documento): "decisão primeiro" no guardião do histórico (17/10/2026, somente local)

**Goal:** nota `Goal Correcao Marketing Colisao A1 A2` no vault.
**Base:** `7fe6ed8` (árvore `e838790`), REPROVADA em `revisao-marketing-historico-rajada-7fe6ed8-parecer-20261017/PARECER.md` (manifesto 169, `cfdd9b49…`) por **A1/P2** e **A2/P2**.
**Branch:** `codex/marketing-historico-a1a2-20261017`, worktree `kidmais-manager-marketing-historico-a1a2-20261017`. Só local, sem push.
**Decisão de produto:** Felipe aprovou em 17/10/2026, nesta conversa, a proposta "decisão primeiro" sem Navigation API, com três regras:
- o diálogo abre na chegada, com destino igual à entrada atual;
- "Sair" não faz travessia;
- a volta só acontece em "Continuar editando".

A análise anterior (commit `f0b5355`, só documentação) mostrou que nenhuma volta ativa elimina a classe; esta entrega implementa a decisão.
**Revisão independente:** pendente. N2 e o aviso `beforeunload` herdado continuam sem aceite próprio (ver Limites).

## 1. Causa comum (resumo da análise)

Sem Navigation API, o guardião devolvia a página ao editor com `history.go(m)` **relativo**. O navegador atende as travessias em fila e resolve o alvo no atendimento, e um movimento já pedido não pode ser cancelado. Uma travessia da pessoa pedida pouco antes muda o ponto de partida do nosso movimento. O mesmo gesto dela (`m`) produz as mesmas chegadas que a outra ordem; a página não vê a ordem dos pedidos. Por isso:
- **A1:** o salto −2 na posição ambígua colide com o `go(−2)` dela, e o destino sai trocado;
- **A2:** o salto, resolvido a partir de onde ela chegou, sai do documento.

As rodadas anteriores só mudaram qual gesto colide:

| Estratégia | Gesto que colide |
|---|---|
| passo −1 | Voltar |
| limiar de 16 ms | janela de tempo |
| salto | `go(−m)` e saída do documento |

Dois experimentos desta rodada, medidos e **não adotados**, confirmam isso: passos de 1 para trás e aposta para frente na posição ambígua.

## 2. Comportamento implementado (só SEM Navigation API)

1. **Barrar e perguntar, sem mover.** Uma travessia da pessoa para outra página é barrada antes do App Router, como antes. Agora o pedido abre **na hora**, com `{ tipo: 'aqui', url }` = a entrada onde ela está — observada, sem inferência. O guardião **não pede nenhum `history.go`** até a decisão.
2. **Pedido aberto.** Novas travessias dela só atualizam o destino (nova intenção substitui a antiga; a continuação de um "Salvar e sair" antigo não executa um pedido já trocado — C2). Voltar à página do editor fecha o pedido (`aoTentarSair(null)`).
3. **"Sair sem salvar" / "Salvar e sair" (com sucesso).** Nenhuma travessia: a página já está no destino.
   - `sairNaEntradaAtual` encerra a tentativa;
   - `mostrarEntradaAtual` entrega ao App Router o mesmo popstate que o navegador entregaria, com o estado do Next intacto;
   - numa entrada sem estado do Next (nula, de âncora nativa), que o App Router ignora, o documento é recarregado nela. Nada é escrito no estado.
4. **"Continuar editando" / Esc.** `continuarEditando` faz só agora a volta à entrada do editor, com o algoritmo de 7fe6ed8: saltos exatos e salvaguarda; a chegada é conferida pela posição; não há pedido no fim.
   - Se a pessoa atravessar durante essa volta, o pedido reabre com o destino onde ela chegou.
   - Um movimento nosso que ainda estava na fila e chega depois é **desfeito**: a compensação é conferida da mesma forma.
   - "Sair" pedido com um movimento nosso na fila espera ele assentar.
5. **Enquanto o pedido está aberto,** a barra de endereço mostra a página de destino e o editor continua montado com o conteúdo. A coerência URL × tela passa a valer **depois da decisão**. Se a proteção cair (salvamento concluído), o pedido continua e a pessoa decide.
6. **Inalterados:**
   - o caminho com Navigation API (volta pela chave e pergunta);
   - o layout raiz e a ordem dos ouvintes;
   - os links (`executarSaida` espera a volta pedida, O-2);
   - o aviso `beforeunload`;
   - o índice próprio (`__kidmaisIdx`: campos do Next preservados; nulo continua nulo);
   - o registro e a poda de fragmentos.

Código: `components/admin/marketing/protecao-saida.ts` (guardião e hook). O diálogo (`MarketingSite.tsx`, `dialogo-alteracoes.ts`) não mudou: "Continuar editando"/Esc já chamam `protecao.permanecer()` e as saídas, `protecao.sair()`.

Retirados, por não terem mais função no caminho sem API:
- o par "nosso movimento → editor" e o CONSERVADOR que ele gerava;
- o deslocamento medido;
- o destino `{ tipo: 'relativo' }`.

## 3. Resultados (árvore de código `36763df`, cópias conferidas por bytes; base `7fe6ed8`)

Ambiente: cópias próprias por `git archive`, `node_modules` copiado, ambiente fechado (sem `.env`, banco, proxy ou segredos), sessão e API fictícias, Chrome headless com a Navigation API removida por simulação, tráfego externo abortado (0 em todas as execuções), documento anterior fictício servido por rota local.

### Modelo (relógio controlado, fila FIFO com alvo no atendimento; 11 históricos × 7 ações × 0–130 ms × atendimento 1/3/5/10/20/30)

| Medição | Base 7fe6ed8 (oráculo antigo, v5) | Candidata (oráculo do contrato novo, v6b) |
|---|---|---|
| Sem documento anterior | DESTINO_ERRADO 198 (AT 129, B2 69), PEDIDO_INDEVIDO 345, CONSERVADOR 410 | **OK 103884/103884** ("continuar" e "sair") |
| Documento anterior, aviso confirmado | SAIU_PELA_CORRECAO **474** | **OK 99168 + SAIU_PELA_PESSOA 4716** (só gestos da própria pessoa); SAIU_PELA_CORRECAO 0 |
| Movimento do guardião antes da decisão | (é o comportamento da base) | 0 |

O modelo da revisora foi derivado só para conhecer outro documento (`DERIVACAO-modelo-documentos.diff`). A v6b tem o mesmo modelo e gestos, mais o critério novo. Uma 1ª execução da v6b registrava `null` como `{em}` e foi refeita com o registro corrigido; ela está preservada no pacote.

### Testes comportamentais (`protecao-saida.test.ts`, 46 testes)

- **Contrato novo:**
  - varreduras de 8 históricos (RV-I1, I-1/I-4, B, fragmentos sucessivos, âncora ambígua à frente, AT, B2, A) × 6 gestos × 0–130 ms × "continuar"/"sair": **1572/1572 OK cada**;
  - A2 com documento anterior (aviso confirmado e cancelado): nenhuma saída pela correção;
  - A1 (`go(−2)` no AT) e A2 (`go(−3)` no A) explícitos.
- **Cruzamento depois de "Continuar"** (4 históricos × 3 gestos × 0–130 ms): OK 1570, resíduo 2 (gesto de mesmo tamanho no mesmo instante, que gera pedido novo; ver Limites).
  - **Correção (17/10/2026, revisão independente de cda9464):** este teste classificava de antemão o gesto de mesmo tamanho como resíduo e não punha o gesto na fila antes do 1º movimento nem tinha documento anterior. A revisão reproduziu, depois de "Continuar", **saída do documento pela correção (C1)** e **destino trocado (C2)**. Ver `docs/MARKETING_HISTORICO_CONTINUAR_20261017.md`.
- **Também cobertos:**
  - F1/F2/F3/H-9, a proteção reativada e a saída explícita direta;
  - O-2 por link durante a volta pedida, e "Sair" com um movimento em voo;
  - o índice que preserva o Next e o nulo, e as salvaguardas;
  - `mostrarEntradaAtual` (estado do Next → popstate intacto; nulo → recarrega, sem escrever no estado);
  - com Navigation API, inalterados.
- **Os 61 testes de 7fe6ed8** descreviam o contrato antigo ("volta ao editor, pede com delta") e foram reescritos.

### Chrome real (roteiro da revisora; critério novo em `janela-decisao.mjs`)

| Cenário | Base 7fe6ed8 (critério antigo) | Candidata |
|---|---|---|
| **A1** — AT, `go(−2)`/Voltar/`go(+2)`, 36–120 ms | `go(−2)` DESTINO_ERRADO **5/14**; `+2` ORACULO_INVALIDO 7 | **OK 54/54** ("sair") e **54/54** ("continuar") |
| **A2** — A, documento anterior, aviso confirmado, `go(−3)`/`go(−4)` | `go(−3)` SAIU_DO_DOCUMENTO **6/8**; `go(−4)` 7/8 | **OK 16/16, nenhum aviso** |
| A, documento anterior, aviso cancelado | OK 24/24 com 20 avisos | **OK 16/16, nenhum aviso** |
| A (`go(−3)`, `go(−4)`, Voltar, `go(−2)`; 38–60 ms) | — | OK 40/40 ("sair") e 40/40 ("continuar") |
| B (N1), Voltar/`go(−2)` 0–120 ms | (rodada anterior: N1 corrigido) | OK 28/28 e 28/28 |
| B2, Voltar/`go(−2)` 0–120 ms | OK 17 + CONSERVADOR 3 (N2), N1 OK 20 | OK 28/28 e 28/28 (nenhum CONSERVADOR) |
| Carga de 25 ms: A / B2 | — | OK 18/18 / 20/20 |

**Medido em cada execução:**
- antes da decisão: nenhum `history.go` do guardião, a URL exata da chegada da pessoa (oráculo FIFO), o diálogo aberto, o mesmo editor (marca no `<main>`) e o conteúdo;
- depois de "Sair": a URL de destino, com o editor desmontado;
- depois de "Continuar": a URL do editor, sem diálogo, mesmo editor e conteúdo;
- em seguida, um Voltar novo abre o diálogo com a URL nova, e o Esc volta ao editor.

Os gestos N2 da revisora (disparados após o 2º popstate) não existem no contrato novo, porque a candidata não se move. Foram substituídos por N1 em instantes de 0 a 120 ms, que cobrem antes, durante e depois de quando a base se moveria.

### Regressões

- **Com Navigation API:** todos os roteiros da revisora empatam com a base.
  - O1 real: 8/8;
  - RV: 7/9 (RV-4b repetido após tempo esgotado no carregamento);
  - RV-2: 10/10;
  - independentes-2: 4/5;
  - AdminShell-O1: 9/9.
- **Sem Navigation API:** os roteiros originais exigem a URL do editor com o diálogo aberto (o contrato antigo) e divergem.
  - Cada divergência foi lida e verificada com o critério novo em `regressoes-decisao.mjs`: **16/16**. São O1 (salvando/sujo/erro, continuação antiga, Continuar durante o envio), âncora antes de editar, Voltar durante o salvamento, inversão rápida, três Voltar, `go(−2)`, `Voltar,Voltar,Avançar`, erro em "Salvar e sair" e pedido de link substituído (O-2).
  - Mapa completo no pacote (`REGRESSOES-ANALISE.md`).
- **Sintético-O1 (21):** 21/21 com e sem API.
- **M-1:** PASS. **M-2/M-3 e I-1..I-6:** falham só pela expectativa antiga (URL do editor e delta relativo); a intenção está coberta pelos testes novos.
- **Não-PG:** 121/121 (diálogo, guardião 46, 11 de Marketing, 2 de Pix). **`tsc --noEmit --incremental false` e ESLint:** 0. **`check:v1:static` com build:** aprovado.

## 4. Limites

- **Resíduo depois da decisão — afirmação CORRIGIDA em 17/10/2026.** O texto original dizia "pedido novo, nunca saída do documento nem volta presa; 2 em 1572". Está **refutado** pela revisão independente de cda9464: com o gesto da pessoa na fila no 1º movimento da volta ou na fronteira de um passo, a volta ativa **sai do documento** (aviso nativo; confirmado, perde a edição — C1) e o pedido reabre num **destino que a pessoa não escolheu**, inclusive outra página (C2). No modelo da revisora: 304 saídas e 204 destinos trocados. Os 2 casos do teste eram pedidos novos legítimos; o teste não alcançava as janelas. Estado e proposta: `docs/MARKETING_HISTORICO_CONTINUAR_20261017.md`.
- **Aviso `beforeunload` herdado:**
  - continua para gestos da própria pessoa que saem do documento (por exemplo, `go(−4)` no histórico A);
  - nenhuma saída é causada pela correção antes da decisão;
  - decisão de Felipe ainda pendente, como antes.
- **N2 / CONSERVADOR:** a regra deixou de existir no caminho sem API; nada a aceitar nele. Com Navigation API, inalterado.
- **Aba sem entrada anterior:** não verificável no harness (o Playwright começa com `about:blank`); no modelo, o modo sem documento anterior cobre o no-op real.
- **Ambiente:** a ausência da Navigation API é simulada no Chrome headless (não é Firefox/Safari nativo); `next dev` com sessão e API fictícias; sem banco.
- **Recarregar com o pedido aberto** carrega a página de destino (o aviso de saída continua protegendo a edição).
