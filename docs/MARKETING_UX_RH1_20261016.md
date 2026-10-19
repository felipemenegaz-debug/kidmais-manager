# Marketing — correção R-H1: Voltar repetido perdia edição (16/10/2026, somente local)

**Goal:** nota `Goal Correcao UX Marketing R H1` no vault.
**Base:** `4bd066b` (C1/C2 corrigidos), reprovada para encerramento por R-H1 em `revisao-marketing-ux-c1c2-4bd066b-parecer-20261016/PARECER.md`. Defeito herdado das rodadas anteriores, não regressão de 4bd066b.
**Branch:** `codex/marketing-ux-rh1-20261016`, worktree `kidmais-manager-marketing-ux-rh1-20261016`. Só local, sem push.
**Revisão independente:** pendente. **Aceite humano:** pendente.

## Causa (verificada)

A proteção do Voltar usava uma **entrada-guarda** (mesma URL) e um ouvinte de `popstate` registrado pelo editor:

1. O primeiro Voltar saía da guarda para a mesma URL, e o diálogo abria.
2. O segundo Voltar, com o diálogo aberto, chegava à página anterior.
3. O ouvinte do App Router (`node_modules/next/dist/client/components/app-router.js`, `onPopState` → `dispatchTraverseAction`) é registrado num efeito do AppRouter **antes** do ouvinte do editor.
4. No `window`, `popstate` segue a **ordem de registro**: a captura não passa na frente (medido em Chrome 155).
5. Resultado: o Next navegava e desmontava o editor. `stopImmediatePropagation` no ouvinte do editor não desfaz o que o ouvinte anterior já fez.

`history.go(-2)` e Avançar também escapavam. A guarda só cobria um passo para trás.

Reproduzido nesta rodada no **App Router real** (cópia isolada da base, `next dev`, sem banco): R-1 da base termina no dashboard, com o editor desmontado.

## Estratégia

**Guardião registrado antes do roteador** (`instalarGuardiaoDeHistorico`, em `protecao-saida.ts`):
- É chamado no **topo do módulo** `components/admin/AdminShell.tsx`. Esse módulo é avaliado na hidratação de qualquer página do painel, antes do efeito do AppRouter, então o ouvinte do guardião vem primeiro.
- Um teste (`protecao-saida.test.ts`) garante essa amarração.

**Proteção ativa**, enquanto o editor tem alterações não salvas, inclusive durante um salvamento:
- O editor registra a **chave** da entrada atual do histórico (`navigation.currentEntry.key`, Navigation API).
- Qualquer travessia que saia dessa entrada — Voltar, Avançar ou `history.go(±n)`, uma ou várias, rápidas ou com o diálogo aberto — é tratada assim:
  1. é **barrada antes do roteador** (`stopImmediatePropagation`): o Next não navega e o editor não desmonta;
  2. **volta à entrada protegida pela chave** (`navigation.traverseTo`), um movimento absoluto que não acumula deslocamentos;
  3. vira um pedido no diálogo, com o **destino escolhido** (a chave da entrada pedida).
- O `popstate` de volta à entrada protegida também é barrado (o Next nunca saiu dela).
- **Sem entradas-guarda:** o histórico não cresce, não fica entrada presa, e um Voltar basta depois de salvar ou cancelar.

**Decisões no diálogo:**
- **Continuar editando / Esc:** fica, com o mesmo conteúdo, unidade e aba (sem remontar).
- **Sair sem salvar:** só depois da confirmação; vai ao destino pedido (para trás, à frente ou n passos), uma vez.
- **Salvar e sair:** só navega depois do sucesso e se a intenção ainda for a vigente (C2). Erro ou cancelamento mantêm o editor. Um Voltar/Avançar durante o salvamento é **pedido novo** (`pedidoAtual()`): a continuação antiga não o executa nem o apaga.

**Sem alterações**, nada é interceptado: Voltar e Avançar funcionam direto.

## Limites (com evidência)

- **Navigation API.** É necessária para `currentEntry` e `traverseTo`. Testado só em Chrome 155. Sem ela, o hook usa o modo antigo de entrada-guarda, que protege só o primeiro Voltar; recarregar e fechar seguem com o aviso nativo. Não há promessa de proteção universal em outros navegadores sem teste.
- **Ordem dos ouvintes.** O guardião depende de ser registrado antes do ouvinte do App Router, o que vale enquanto ele for instalado na avaliação do AdminShell. O editor também chama `instalarGuardiaoDeHistorico`, mas isso só cobre uso fora do AdminShell, sem a garantia de ordem.
- **Outro documento.** Travessia para outro documento (fora da SPA) cai no `beforeunload` nativo.
- **Vários Voltar sem pausa.** Vários `history.back()` no mesmo instante passam por entradas intermediárias, cada uma barrada antes do roteador. O destino guardado é a última entrada alcançada (no harness, até a primeira entrada do documento).
- **Next.** Não foi usado `onNavigate` do `<Link>`, porque é por link e não cobre o histórico. Next 16.3.4 não usa a Navigation API no roteador.
- **Escopo do delta:** sem mudança em API, serviço, banco, migrations, regras ou motor. No layout, só a chamada de instalação no AdminShell.

## Provas

Resultados no pacote de revisão.

| Camada | O que roda | Cenários |
|---|---|---|
| Memória | Código real do editor e do `useMarketing`; hook substituído | 22 (U2/U3, C1/C2) |
| Roteador sintético | Chrome real; editor e hook reais; StrictMode; API na página | 11 C1/C2 + 10 R-H1 |
| **App Router real** | Next 16.3.4 em `next dev`, em **cópias isoladas** da candidata e da base, com rotas `/harness-rh1/*` só nas cópias; editor e hook reais; API sintética na página; sem banco; requisições externas bloqueadas | 12 R-H1/C2 |

Também: testes de `lib/marketing`, Pix, o teste novo, TypeScript, ESLint e `check:v1:static`.
