# Marketing — R-H1-F: fallback sem Navigation API e integração real da proteção de navegação (16/10/2026, somente local)

**Goal:** nota `Goal Correcao UX Marketing R H1 F` no vault.
**Base:** `8e539b5` (R-H1 com Navigation API), reprovada em `revisao-marketing-ux-rh1-8e539b5-parecer-20261016/PARECER.md`. O fallback perdia edição no segundo Voltar (R-H1-F), e a ordem de instalação no AdminShell estava sem validação.
**Branch:** `codex/marketing-ux-rh1f-20261016`, worktree `kidmais-manager-marketing-ux-rh1f-20261016`. Só local, sem push.
**Revisão independente:** pendente. **Aceite humano:** pendente.

## A — Fallback sem Navigation API

**Causa.** Sem `navigation.currentEntry` e `traverseTo`, a base voltava à entrada-guarda antiga:
1. Uma entrada a mais com a mesma URL; o primeiro Voltar só a consumia.
2. O segundo Voltar chegava à página anterior.
3. O ouvinte do App Router navegava e desmontava o editor.

**Estratégia: índice próprio do histórico.** Só sem a Navigation API.
- **Marcação das entradas:** ao instalar, o guardião envolve `history.pushState` e `history.replaceState`. Cada `pushState` recebe `__kidmaisIdx`, a posição relativa no documento; `replaceState` mantém a posição.
- **Estado preservado:** o objeto de estado é copiado com um campo a mais, sem mexer nos campos do Next (`__NA`, árvore). Estado nulo continua nulo, porque o Next trata nulo e "objeto sem `__NA`" de formas diferentes. Ao recarregar, a posição é lida do próprio estado.
- **Com proteção ativa:**
  - toda travessia que saia da entrada do editor (Voltar, Avançar, `history.go(±n)`, várias seguidas) é barrada **antes do roteador** (`stopImmediatePropagation`);
  - depois de as travessias assentarem (40 ms), o retorno é **único**, `history.go(protegida − atual)`, sem acumular deslocamentos;
  - o pedido vai ao editor **só depois de voltar**, com URL e página coerentes;
  - o destino guardado é o da **tentativa** (relativo à entrada protegida), não o das paradas intermediárias da correção.
- **Entradas sem índice** (criadas antes da instalação; no Next, a hidratação as marca): ficam necessariamente atrás. O retorno avança um passo por vez, e o destino é calculado pelos passos dados.
- **Sair:** `history.go(delta)` até o destino pedido, uma vez.

**Com Navigation API:** inalterado. Volta pela chave (`traverseTo`).

## B — Integração real

**Caminhos de entrada no painel** (código):
- **Entrada direta:** qualquer `/admin/*` ou `/clientes/*` carregado do zero. O módulo do AdminShell é avaliado na hidratação.
- **Navegação cliente vinda de outro layout,** com o App Router já montado: `not-found` (`Ir para o início` → `/admin/dashboard`), `/acesso/*` e `/cadastro/*` (→ `/admin/login`), `/desenvolvedor` (→ `/admin/dashboard` e `/admin/perfil`). Nesses casos o AdminShell só é avaliado **depois** de o Next registrar o ouvinte dele.

**Medido no Next real com o AdminShell real** (ordem instrumentada sem alterar a ordem):
- Na base, a entrada tardia registra `["next-app-router","next-app-router","guardiao-kidmais"]` (Next duas vezes por causa do StrictMode do dev).
- Ali, já o **primeiro** Voltar sai do editor, **mesmo com a Navigation API** (B-2 da base).

**Correção.**
- O guardião é instalado no **layout raiz**: `components/InstalarGuardiaoHistorico.tsx`, componente cliente com a chamada no topo do módulo, renderizado em `app/layout.tsx`. Ele é avaliado na hidratação de **qualquer** documento.
- O AdminShell volta a ser idêntico ao de `4bd066b`.
- Sem proteção ativa, o guardião não intercepta nada.
- Sem Navigation API, o índice também passa a valer em páginas públicas (um campo a mais no estado, sem efeito para elas).

## Provas

Resultados no pacote de revisão.

| Camada | O que roda | Modos |
|---|---|---|
| Testes comportamentais (`protecao-saida.test.ts`) | Janela e histórico falsos, ouvintes na ordem de registro, roteador registrado depois; guardião e `protegerHistorico` reais | com e sem API; preservação do estado do Next; risco da instalação tardia |
| Memória | 22 cenários (U2/U3, C1/C2) | — |
| Roteador sintético | 21 cenários (C1/C2 + R-H1), Chrome real, StrictMode | com e sem API |
| Next real com HarnessShell | 12 da rodada anterior | com e sem API |
| **Next real com AdminShell REAL** | 9 cenários, entrada direta e tardia, ordem instrumentada; sessão e API sintéticas injetadas no navegador; sem banco | com e sem API |

## Limites honestos

- **Ausência da API simulada.** No Chrome 155, `window.navigation` foi forçado a `undefined`. Não havia outro navegador instalado (Firefox, WebKit), então isso **não** é teste nativo de Firefox ou Safari.
- **Ordem dos ouvintes.** A proteção do histórico depende de o guardião ser registrado antes do ouvinte do App Router. Isso vale com a instalação no layout raiz (medido nas entradas direta e tardia). Uma mudança futura que registre um ouvinte de `popstate` do Next antes dos módulos do layout raiz precisaria de nova validação.
- **Outro documento.** Travessia para outro documento cai no aviso nativo (`beforeunload`).
- **Assentamento.** A espera de 40 ms faz a URL mostrar por um instante a entrada intermediária, enquanto a página continua no editor.
- **Escopo:** sem mudança em API, serviço, banco, migrations, regras ou motor.
