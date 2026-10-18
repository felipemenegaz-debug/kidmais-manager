# Marketing — "Continuar editando" sem Navigation API: C1/C2 (volta ativa), O-a (tentativa órfã) e a proposta α — 17/10/2026, somente local

**Goal:** nota `Goal Correcao Marketing Continuar C1 C2 Oa` (e `Continuacao Marketing Prototipo Alfa`) no vault.
**Base:** `cda9464` (árvore `ae4cff5`), REPROVADA em `revisao-marketing-historico-a1a2-cda9464-parecer-20261017/PARECER.md` (manifesto 181, `7a03ceea…`) por C1/P2, C2/P2 e O-a/P3.
**Branch:** `codex/marketing-continuar-c1c2oa-20261017`. Commits: `3851e3f` com a correção de O-a, e o seguinte com a **integração do α2**, aprovada por Felipe (seção 0). Só local, sem push.

## L. Limpeza da volta ativa inalcançável (18/10/2026, sobre 7d299a2)

**Autorização:** Felipe aprovou a remoção **como proposta**, depois do parecer independente de `7d299a2`: APROVADO, com F-1 P3 latente na contingência, em `revisao-marketing-historico-continuar-7d299a2-parecer-20261017/PARECER.md`. Proposta e provas: `ambientes-locais/marketing-limpeza-volta-20261017/PROPOSTA-LIMPEZA-VOLTA-ATIVA.md`.

**O que saiu de `protecao-saida.ts` (821 → 466 linhas):**
- **Volta ativa:** modo `voltando`, `avancar`, `armarVigia`, `semMovimento`, `concluirRetorno`, `noEditor`, `direcaoProvavel`, `semDestinoCerto`, `primeiraDaAba`.
- **Saltos e conferência:** `saltoSemIndice`, `saltoAmbiguo`, `possivel`, `chegadaDe`, `casa`, `possivelAPartirDe`, `semFragmentosEntre`, `cadeia`.
- **Compensação** (`desfazendo`/`compensando`), **abandono em voo** (`abandonada`), a espera de `saida` e `executarSaida` (O-2 com volta).
- **Estado sem leitor:** `contiguo`, `instalacao`, `Pos.candidatos`, `ASSENTAR_MS`, `VIGIA_MS`.
- A tentativa ficou `{ a }`.

**O que ficou igual:**
- o caminho com Navigation API;
- "decisão primeiro";
- "Sair" sem travessia;
- O-a (`abandonarTentativa`, agora só encerra);
- o pushState do α2 e a sua contingência (inclusive o F-1, fora deste escopo);
- o registro de índices e fragmentos que a proteção usa.

**Por que era inalcançável (leitura):**
- A tentativa nasce sem movimento, e nada além de `voltando` cria movimento.
- `voltando` só era alcançado sem estado do editor **e** sem o pushState próprio.
- Isso exige uma Navigation API presente na instalação e ausente depois, o que não ocorre num documento.

**Única mudança de comportamento:** nesse caso inalcançável, "Continuar" agora encerra a tentativa sem travessia.

**Suíte do guardião:**
- o teste O-2 chama a saída direto: sem volta, o hook navega direto, e não há `executarSaida` para esperar. A intenção se mantém e continua asserida: a saída parte da entrada do editor e nada se move depois;
- 5 títulos/comentários que descreviam a volta foram corrigidos;
- nenhuma asserção mudou, e a contagem é a mesma.

**Provas:**

| Prova | Resultado |
|---|---|
| Instrumentação de 7d299a2 (36 marcadores nas regiões removidas, 11 controles em caminhos vivos) — suíte do guardião | 52/52; **0** marcas removidas; 11/11 controles |
| — controle por injeção (sem pushState próprio e sem estado) | as marcas removidas aparecem (o canal detecta) |
| — bateria Chrome completa (48 execuções, roteiros e parâmetros da integrada + B-5) | **0** marcas removidas; 9/11 controles; 48/48 vereditos iguais aos da integrada |
| Cópia limpa: guardião / não-PG (15 arquivos) / `tsc` / ESLint / `check:v1:static` com build | **52/52** / **127/127** (0 skip/todo) / 0 / 0 / **PASS** |
| Cópia limpa: bateria principal (48 execuções, mesmos roteiros/parâmetros da integrada + B-5) | **48/48** status 0; vereditos **48/48 iguais** a 7d299a2 (resumo e classe por linha; custo por classes, histórico com IDs CDP relativos e sondas) |
| Cópia limpa: fase extra (15 roteiros da revisão de 7d299a2: custo A/AT/B/B2/B5/A2T, contingências, 2º Continuar normal, erro de save, órfã pós-Continuar, telas do F-1) | **15/15** status 0; **14/15 iguais** às linhas "candidata" da revisora, na linha inteira; em `orfa-pos-continuar` diferem só `tentativa.modo`/`abandonada`, campos removidos |
| A/B dirigido de `fila` (3 roteiros × 2 rodadas × base 7d299a2/limpa, alternados) | 12/12 status 0; classes idênticas em todas (OK 35 + 2 GESTO_DESCARTADO_PELO_PUSH) |

**Comparação estrita (linha inteira, só tempos removidos):**
- **Ruído de execução:** instantes `@t`, `timeOrigin` e IDs CDP absolutos.
- **Por construção:** `tentativa.modo`/`passos[].modo` (campo removido).
- **Ordem de atendimento:** quatro linhas de `fila` com `off=1`.
  - Na bateria limpa, a chegada do gesto da pessoa veio **depois** do clique em "Continuar". Resultado: pedido aberto no destino, e "Sair" vai a ele. Em 7d299a2 a chegada veio **antes**: editor sem pedido. As duas ordens são OK pelo oráculo e estão dentro do contrato α2.
  - O A/B com as duas raízes nas mesmas condições deu "depois do clique" em 1/10 e 1/10 na base e em 1/10 e 0/10 na limpa. É corrida de atendimento de 1 ms, não efeito do código. O 4/10 da bateria limpa coincidiu com o incidente abaixo.

**F-1 (fora desta limpeza, pendente para decisão de Felipe):**
- O 2º "Continuar" depois da contingência injetada se reproduz **igual** a 7d299a2: `contingencia-continuar2`, `extra-f1-tela` e `extra-f1-tela-B5` são idênticos às linhas da revisora.
- A limpeza não mudou nem o comportamento nem a alcançabilidade dele.

**Incidentes de execução (registro):**
- **Concorrência (04:50–04:58Z):**
  - O que houve: depois de uma interrupção da sessão, a bateria original e duas retomadas rodaram em paralelo.
  - Tratamento: foram encerradas; os resultados desse intervalo estão em quarentena, preservados (`testes/limpa/quarentena-concorrencia-20261018T0450Z/`).
  - Substituição: os casos afetados foram refeitos numa cadeia única com trava. Só os 16 resultados anteriores (04:37–04:49Z, sem sobreposição) foram mantidos.
- **Servidor parou durante o custo-alfa:**
  - O que houve: o `next dev` saiu duas vezes, sem erro e sem ação desta sessão. A causa não foi determinada, e o timeout de C6 foi consequência. Detalhes em `testes/limpa/diagnostico-custo-alfa-20261018/`.
  - Resolução: na 3ª execução, com um vigia de processos, o servidor ficou no ar e o custo-alfa passou 11/11.
- **Guarda da fase extra:** recusou corretamente nas duas falhas.

**Limites:**
- Navigation API ausente só simulada no Chrome headless (não é Firefox/Safari).
- `next dev` com sessão/API sintéticas, sem banco.
- Aba sem entrada anterior não verificada.
- A ausência de marcas é prova da bateria executada, não prova universal: a inalcançabilidade vem do invariante lido no código.

**Estado:** implementação e validação da implementadora. **Revisão independente do delta pendente.**

## 0. Integração α2 — decisão de Felipe (17/10/2026)

Felipe aprovou, nesta conversa, **α2 ("Continuar" sem travessia) com os custos medidos**:
- ramo à frente descartado;
- Avançar simultâneo pode ser ignorado;
- recarga na contingência.

O commit seguinte a `3851e3f` integra o α2:
- **código:** idêntico ao protótipo medido, só com os comentários reescritos;
- **suíte do guardião:** reescrita para o contrato aprovado.

O teste de cruzamento pós-"Continuar" **deixou de ser TODO e passa**.

**Bateria completa na cópia integrada** (árvore do commit, `components/` idêntico; servidor :3598):

| Prova | Resultado |
|---|---|
| C1/C2, focais do parecer (captura, CDP simultâneo e posterior, fronteiras AT/B2, fila, depois) | **OK 123** + 2 GESTO_DESCARTADO_PELO_PUSH (Avançar pedido antes do clique); 0 saída pela correção; 0 destino trocado |
| C1/C2 com o fallback injetado (estado apagado antes do clique) | **OK 68/68** |
| O-a: pedido aberto + login; Continuar + login (`orfa-volta` 4, `orfa-volta-2` 10) | coerente 2/2 e 14/14; 0 `history.go` do guardião |
| Antes da decisão + Sair/Continuar (revisora) | **127/127** |
| 16 substitutos do contrato novo | **16/16** |
| B-2 entrada tardia | PASS |
| B-1 derivado | falha de roteiro (`about:blank`), como nas outras raízes; coberto por D-B1/D-B7 |
| O1 real com/sem, roteiro da revisora com/sem | **cenário a cenário iguais à candidata** (8/8, 4/8, 7/9, 5/9) |
| AdminShell-O1 com | 9/9 |
| AdminShell-O1 sem | 1/9; a candidata e a base tinham 2/9 |
| O-2 (critério antigo) | INCOERENTE 4/4, como na base; a intenção é coberta pelo D-O2 |
| Custo (CDP, por ID) | igual ao do α2 (seção 4): recriação da entrada; ramo à frente removido; Avançar na fila descartado; recarga na contingência (`timeOrigin` novo) |
| Modelo (291 720 por semântica, normal e fallback injetado) | 0 saída/aviso/destino trocado pela correção; 4 680 gestos descartados (semântica Chrome) |
| Não-PG (15 arquivos) / `tsc` / ESLint / `check:v1:static` com build | **127/127** / 0 / 0 / **PASS** |

**AdminShell-O1 sem API, B-5:**
- **A diferença:** é a única de cenário em relação à candidata, e é **custo aprovado**, não defeito.
- **O cenário:** a pessoa vai para a frente do editor, abre o pedido e aperta Esc.
- **O que acontece:** a entrada nova do editor nasce depois da página tentada. O 2º Avançar do roteiro original não tem mais destino; essa página agora está atrás.
- **Substituto no contrato aprovado** (`roteiro-adminshell-alfa2-b5.mjs`): **PASS**. Esc mantém o editor e a edição; o Avançar fica sem destino (medido); Voltar abre o pedido no Dashboard; "Sair sem salvar" vai a ele.

**Revisão independente de `7d299a2`:** APROVADO para encerrar o goal local, com F-1 (P3, latente: 2º "Continuar" depois da contingência; só por injeção). Parecer em `revisao-marketing-historico-continuar-7d299a2-parecer-20261017/PARECER.md`.

## Estado antes da decisão (registro de 3851e3f; sem autoaprovação)

| Achado | Neste commit (candidata O-a) | Protótipo α (isolado, **não integrado**) |
|---|---|---|
| **O-a** | **corrigido** e provado (Chrome, redirecionamento com pedido aberto) | igual |
| **C1** (saída do documento pela volta) | **presente** (mesma volta de cda9464) | ausente no caminho normal; no fallback: α1 **presente**, α2 ausente |
| **C2** (destino trocado) | **presente** | igual a C1 |

- **Custo de α:** α muda o histórico, e isso exige **decisão de Felipe**. A aprovação de "decisão primeiro" não cobre esse efeito.
- **Revisão independente:** pendente.

## 1. Causa de C1/C2 (resumo)

A volta de "Continuar" é um `history.go` relativo: não pode ser cancelada e é resolvida no atendimento. Um gesto da pessoa já na fila muda o ponto de partida dela. Por isso:
- **C1:** a volta pode sair do documento;
- **C2:** o mesmo gesto do tamanho do movimento produz as mesmas observações da outra ordem (gêmeo).

**Nenhum movimento relativo** satisfaz as invariantes, qualquer que seja o tamanho ou o instante:
- **Saída:** para qualquer movimento m, há uma chegada da pessoa a partir da qual m sai do documento, e a compensação vem depois.
- **Atribuição:** o gesto de tamanho m da pessoa é indistinguível da outra ordem.
- **Esperar ou mudar o tamanho** só move a janela.

Só "Continuar" **sem travessia** elimina a classe.

## 2. O-a — o que mudou no produto (`components/admin/marketing/protecao-saida.ts`)

- **Dono da tentativa:** a tentativa tem dono (`Ativa.dono`, um objeto por instância do hook; a reativação por `ativo` tem o mesmo dono).
- **Desmontagem do editor:** um efeito de desmontagem separado chama `abandonarTentativa(dono)`.
  - **Sem movimento nosso na fila:** a tentativa termina e os popstates seguintes vão ao roteador.
  - **Com movimento na fila:** a tentativa fica `abandonada`; o movimento é barrado e desfeito ao chegar, e as chegadas da pessoa vão ao roteador.
- **Herança:** uma proteção nova não herda uma tentativa abandonada.
- **Fora do escopo:** a autenticação e o redirecionamento do AdminShell não foram tocados.
- **Testes novos (4, comportamentais):**
  - pedido aberto + desmontagem (login);
  - desmontagem com movimento na fila;
  - pessoa atravessa antes do movimento;
  - reativação no mesmo editor, outro dono e a desmontagem simulada do Strict Mode.

## 3. A proposta α — "Continuar sem travessia" (protótipos isolados)

- **α1:** "Continuar" cria uma **entrada nova do editor na posição atual**. É um `pushState` com o estado do Next da entrada indexada do editor, registrado quando ela era a atual; as **entradas à frente são descartadas**, como em toda navegação nova.
  - **Fallback:** se não houver estado registrado, α1 **ainda volta pelo `history.go`** antigo (`continuarEditando`, linha `t.modo = 'voltando'`).
- **α2:** igual ao α1, mas o fallback também não faz travessia. É uma entrada nova só com o índice próprio (`{ __kidmaisIdx }`), empilhada pelo `pushState` próprio do guardião, sem o do Next (que copiaria a árvore da entrada atual, de outra página). Nenhum campo do Next é fabricado.
  - **Medido no Chrome:** o estado final tem só `__kidmaisIdx`. Ao Avançar até essa entrada sem proteção, o Next **recarrega o documento** nela.
  - **`history.go` restante:** α2 ainda tem a linha da volta antiga, alcançável só com um movimento nosso pendente, que α/α2 nunca criam.

**Semântica medida no Chrome** (documento fictício): uma travessia já pedida quando o `pushState` acontece na mesma tarefa é resolvida a partir da posição anterior ao push.
- **Alvo atrás:** ela acontece.
- **Alvo à frente:** a entrada é descartada pelo push e a travessia **não acontece** (sem popstate).

**Alcançabilidade natural do fallback:** o registro cobre toda entrada indexada que foi a atual neste documento:
- na instalação;
- no `pushState`/`replaceState` do índice;
- no popstate.

O editor só é protegido numa entrada que foi a atual, ou numa âncora dela, então nenhum fluxo medido chegou ao fallback: 0 `history.go` do guardião depois de "Continuar" em 153 execuções focais do α1 no Chrome e em 291 720 cenários do modelo. O fallback só foi exercitado por **injeção do lado do teste**, que apaga o registro. Isso é prova de contingência, não de alcance natural.

## 4. Resultados por raiz

Raízes (cópias próprias, conferidas por bytes):
- **base:** `cda9464` (árvore `ae4cff5`);
- **candidata:** este commit; código idêntico à cópia testada (ver pacote);
- **α1:** candidata + `protecao-saida.ts` derivado (sha256 `0e5755cd…`);
- **α2:** α1 + contingência (sha256 `c5635ef5…`).

### C1/C2 no Chrome (cenários do parecer, mesmos parâmetros)

| Cenário | Base | Candidata | α1 normal | α1 fallback injetado | α2 fallback injetado |
|---|---|---|---|---|---|
| A, gesto na fila, aviso confirmado (12) | SAIU_PELA_CORRECAO 2 | **1** | 0 (12 OK) | **1** | 0 (12 OK) |
| A, aviso cancelado (6) | aviso pela correção 2 | **2** | 0 (6 OK) | **2** | 0 (6 OK) |
| A, gesto do navegador (CDP) simultâneo (16) | SAIU_PELA_CORRECAO 1 | **2** | 0 (16 OK) | **1** | 0 (16 OK) |
| B, gesto na fila (6) | SAIU_PELA_CORRECAO 1 | **1** | 0 (6 OK) | **1** | 0 (6 OK) |
| B2, gesto na fila (4) | DESTINO_TROCADO 4 | **3** | 0 (4 OK) | **4** | 0 (4 OK) |
| B2, fronteira do 2º passo (10) | DESTINO_TROCADO 4 | **5** | 0 (10 OK) | **4** | 0 (10 OK) |
| AT, fronteira do 2º passo (14) | DESTINO_TROCADO 5 | **4** | 0 (14 OK) | **5** | 0 (14 OK) |

- **Oráculos:**
  - a coluna α1 normal usa a reprodução FIFO com a **inserção no instante do clique**, ordem conferida pelas chamadas na mesma tarefa: um gesto conta como "depois" só se é estritamente posterior ao clique;
  - as colunas base, candidata e α1 fallback usam o oráculo original.
- **ORACULO_INVALIDO:** a 1ª execução do α1 com o oráculo original deu 28 casos (a inserção não estava modelada); a 2ª, com empate e gesto descartado, deu 4. Ambas estão preservadas e **não** contam como aprovação.
- **α2 normal, focais:** 37 OK + 2 GESTO_DESCARTADO_PELO_PUSH.
- **α1, focais adicionais:**
  - fila (gesto ANTES do clique): A 16/16; B2 12/12;
  - Avançar pendente: 5 OK + **4 GESTO_DESCARTADO_PELO_PUSH**;
  - depois do clique: 12/12.

### Modelo da revisora (fila FIFO, atendimento 1/3/5/10 ms, documento anterior; ±1…±5; −12…+130 ms; 291 720 cenários por semântica de push)

| Raiz | Saída pela correção | Aviso pela correção (cancelado) | Destino trocado | Pedido novo | Engolido / engolido antes | Gesto descartado pelo push | Movimento do guardião depois de Continuar |
|---|---|---|---|---|---|---|---|
| base = candidata | 304 | 304 | 204 | 621 | 57 / 90 | — | sim |
| α1 normal | 0 | 0 | 0 | 0 | 0 | 4 680 (semântica Chrome) | **nunca** |
| α1 fallback injetado | 304 | 304 | 204 | 621 | 57 / 90 | — | sim |
| α2 normal e fallback injetado | 0 | 0 | 0 | 0 | 0 | 4 680 (semântica Chrome) | **nunca** |

Correções do modelo preservadas e documentadas no pacote (`DERIVACAO-modelo-push.diff`):
- URL absoluta guardada como caminho, como o navegador; a 1ª execução tinha PRESO artificial;
- nenhum clique depois de o documento ter sido descarregado; a 1ª execução do α2 tinha erro de URL inválida;
- classe própria para o gesto descartado.

### O-a no Chrome

| Caso | Base | Candidata | α1 |
|---|---|---|---|
| Redirecionamento para o login com o pedido aberto; depois Voltar/Avançar | **incoerente 2/2** (URL Dashboard com tela de login; tentativa viva) | coerente 2/2 | coerente 2/2 |
| "Continuar" + redirecionamento na mesma tarefa (5 ordens × 2) | coerente | coerente | coerente |

**O redirecionamento durante a volta** foi medido em 42 execuções (`orfa-volta`, `orfa-volta-2`), e em **todas** a volta terminou antes da desmontagem.
- **"Desmontagem com movimento nosso na fila" ficou NÃO VERIFICADA no Chrome:** a intercalação não ocorreu.
- **Coberta só pelo teste comportamental**, com relógio controlado.

### Antes da decisão, "Sair" e regressões

| Prova | Base | Candidata | α1 |
|---|---|---|---|
| Bateria "antes da decisão" + Sair/Continuar (revisora) | — | **127/127** | **127/127** |
| 16 substitutos do contrato novo | — | 16/16 | 16/16 |
| B-2 entrada tardia (contrato novo; ordem guardião → App Router) | PASS | PASS | PASS |
| B-1 derivado | falha de roteiro | falha de roteiro | falha de roteiro |
| O1 real com / sem API | 8/8 / 4/8 | 8/8 / 4/8 | — |
| AdminShell-O1 com / sem | 9/9 / 2/9 | 9/9 / 2/9 | — |
| Roteiro da revisora com / sem | 7/9 / 5/9 | 7/9 / 5/9 | — |
| O-2 (critério antigo) | INCOERENTE 4/4 | INCOERENTE 4/4 | — |

- **B-1 derivado:** a falha de roteiro é a mesma nas três raízes. O 2º `page.goBack` a partir da 1ª entrada do app vai a `about:blank`, o aviso é dispensado e o Playwright espera para sempre. A intenção está coberta pelo D-B1 (o 1º Voltar abre o pedido no Dashboard; o 2º tenta sair, aviso cancelado; fica sem remontar) e pelo D-B7. A ordem dos ouvintes foi registrada no próprio estado da falha.
- **Divergências sem API:** são as mesmas da base; o critério antigo é a URL do editor com o diálogo aberto. Os substitutos cobrem a intenção. O-2 pela intenção: D-O2.
- **α2:** focais do caminho normal (37 OK + 2 descartados), fallback injetado (68/68 OK), custo e modelo. A bateria de 127 e os substitutos **não** foram reexecutados no α2: o caminho normal dele é idêntico ao α1, e só a contingência e um campo da instalação mudam.

### Custo de α no histórico (Chrome, histórico real pelo CDP, por ID de entrada)

| Cenário | Antes (com o pedido) | Depois de Continuar — candidata | Depois — α1/α2 | Efeito em α |
|---|---|---|---|---|
| Voltar 1 | `dashboard *campanhas* site` | `dashboard campanhas *site*` (mesma entrada) | `dashboard campanhas *site'*` | entrada do editor **recriada** (1 removida, 1 adicionada); nada visível muda |
| Voltar 2 (com páginas e fragmento à frente) | `*dashboard* campanhas site automacoes #fim` | inalterado; Avançar alcança Automações | `dashboard *site'*` | **4 entradas removidas** (Campanhas, editor, Automações, #fim); Avançar não alcança nada |
| Avançar até o pedido | `dashboard site *campanhas* automacoes` | inalterado | `dashboard site campanhas *site'*` | Automações removida; editor **duas vezes**; Voltar leva a Campanhas (pedido) |
| Avançar **na fila** no clique | idem | pedido em Automações (onde ela chegou) | `… campanhas *site'*`, **sem popstate** | **GESTO_DESCARTADO_PELO_PUSH** + Automações removida |
| Voltar **na fila** no clique | `dashboard *campanhas* site` | pedido no Dashboard | pedido no Dashboard (chegada exata); o próximo Continuar descarta Campanhas e o editor | pedido novo legítimo |
| Link / troca de unidade logo depois | — | pedido de link / de troca | idem | entrada recriada; nada mais |
| 3 ciclos Voltar → Continuar; Sair | — | histórico estável | estável (o editor recriado a cada ciclo, sem crescer) | — |
| Documento anterior, go(−3) da pessoa | — | saída **pela pessoa**, aviso (confirmado: sai; cancelado: fica) | idem | — |
| α2 fallback injetado → Sair → Avançar | — | — | entrada `{__kidmaisIdx}`; Avançar: **recarga do documento** (`timeOrigin` novo), editor novo com o conteúdo salvo, sem login nem erro | **recarga** |

- **Conteúdo e montagem:** o mesmo editor (marca no `<main>`) e a edição foram preservados em todos os "Continuar", nas quatro raízes.
- **Estado do Next da entrada nova:** mesmas chaves (`__NA`, `__PRIVATE_NEXTJS_INTERNALS_TREE`, `__kidmaisIdx`) e mesma árvore; só o índice próprio muda. A exceção é a contingência do α2 (só o índice).
- **Requisições à API sintética:** iguais entre as raízes.

### Checks (ambiente fechado, sem banco)

- **Candidata:**
  - não-PG (15 arquivos): **124 pass + 1 todo**. O todo é o cruzamento pós-Continuar, que **falha** na candidata: C1/C2;
  - `tsc --noEmit --incremental false`: 0;
  - ESLint dos alterados: 0;
  - `check:v1:static` com build de produção: **PASS**.
- **α1/α2:** `tsc` 0; ESLint 0. Suíte do guardião:
  - 20/50 com o ambiente falso (o `pushState` falso guardava URL absoluta);
  - 33/50 com a URL normalizada;
  - **43/50** com o critério do contrato α (página do editor numa entrada nova). As 7 restantes:
    - 4 são custo de histórico (Voltar/Avançar alcançam outras entradas);
    - 2 não se aplicam (testes de O-a com movimento na fila: α não move);
    - 1 todo: o cruzamento, que no α **passa** (5 925 OK + 75 saídas pela própria pessoa).

## 5. Limites

- **Navigation API:** a ausência é simulada no Chrome headless (não é Firefox/Safari).
- **Ambiente:** `next dev` com sessão/API sintéticas; sem banco.
- **"Gesto da pessoa":** `history.go` marcado só para o oráculo, ou CDP; o produto não lê a marca.
- **Aba sem entrada anterior:** não verificada.
- **Desmontagem com movimento na fila:** não verificada no Chrome (seção 4).
- **α2:** bateria de 127 e substitutos não reexecutados (ver acima).
- **Fallback:** alcance natural não demonstrado. Medido só por injeção.
- **Correção da entrega anterior:** a afirmação "2 em 1572, pedido novo, nunca saída" (cda9464) está corrigida em `docs/MARKETING_HISTORICO_A1_A2_20261017.md`.

## 6. Decisão (registro): pendente em 3851e3f, **tomada em 17/10/2026** — α2 aprovado (seção 0)

Adotar ou não "Continuar editando" **sem travessia** (α2). Isso significa:
- "Continuar" cria uma entrada nova do editor na posição atual e **descarta as entradas à frente**. Exemplo medido: 4 entradas no "Voltar 2".
- O editor pode ficar **duas vezes** no histórico, quando a pessoa tinha ido para a frente.
- Um **Avançar pendente** no instante do clique pode **não acontecer**.
- Na contingência sem estado registrado (não alcançada nos fluxos medidos), voltar a essa entrada **recarrega o documento**.

Em troca, nenhuma saída do documento nem destino trocado causados pela correção.

**Alternativa:** manter a volta ativa (candidata) e aceitar C1/C2 nas janelas da largura do atendimento. Sem decisão, o produto fica com a candidata O-a.
