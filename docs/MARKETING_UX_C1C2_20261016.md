# Marketing — correções C1/C2 da revisão de e452e39 (16/10/2026, somente local)

**Goal:** nota `Goal Correcoes UX Marketing C1 C2` no vault.
**Base:** `e452e39` (correções U1–U5), reprovada por C1/C2 em `revisao-marketing-ux-u1u5-e452e39-parecer-20261016/PARECER.md`.
**Branch:** `codex/marketing-ux-c1-c2-20261016`, worktree `kidmais-manager-marketing-ux-c1c2-20261016`. Só local, sem push.
**Revisão independente:** pendente. **Aceite humano:** pendente.

## C1 — "Salvar endereço" descartava a edição não salva

**Causa.**
- `alterarEndereco` (serviço) troca o slug e incrementa `rascunhoVersao`, mantendo o conteúdo salvo.
- No editor, a edição local fica amarrada a `site:versão`. Só `salvar` reconciliava a edição com a versão nova.
- Por isso, endereço, publicar e despublicar trocavam a chave, e a edição local sumia da tela com o selo "Rascunho salvo".

**Política escolhida: reconciliar.**
- Em `acao` (`MarketingSite.tsx`), toda resposta de operação que não envia o conteúdo (endereço, publicar, despublicar) e que volta com versão nova **do mesmo site** passa a edição local para a versão nova.
- Isso inclui o que foi digitado **durante** a requisição: a edição é lida pela atualização funcional na hora da resposta.
- A edição continua "Alterações não salvas" e o aviso diz: "As alterações de conteúdo continuam NÃO salvas: use “Salvar rascunho”".
- Se a operação falhar, o slug digitado e o conteúdo ficam, e o aviso informa o erro e que o conteúdo não foi salvo.
- Junto do botão, um texto explica que o endereço é salvo à parte.
- A nova tentativa usa a versão vigente. Depois do sucesso, "Salvar rascunho" envia o conteúdo na versão nova, sem conflito.
- O bloqueio do endereço após a 1ª publicação, a versão otimista, empresa/unidade e rascunho × publicado continuam no servidor, sem mudança.

## C2 — Cancelar não invalidava a troca/saída que aguardava o salvamento

**Causa.**
- `salvarEContinuar` guardava `trocaPedida`, e o `protecao` da renderização do clique, numa continuação assíncrona.
- "Continuar editando" ou Esc fechavam o diálogo, mas a continuação trocava de unidade ou saía ao receber o sucesso.

**Correção.**
- **Intenção numerada** (`intencao` em `MarketingSite.tsx`):
  - cada "Salvar e …" recebe um número;
  - "Continuar editando", Esc (`onCancel` do `<dialog>`), "… sem salvar" e uma intenção nova trocam o número;
  - a continuação só age se ainda for a vigente e se a tela estiver montada. Se não for, não troca, não navega e não fecha o diálogo de outra intenção;
  - clique repetido em "Salvar e …" não abre uma segunda continuação.
- **Hook** (`protecao-saida.ts`):
  - o pedido pendente agora vive numa `ref`; `permanecer()` e `sair()` leem a ref, não a cópia da renderização em que foram criados;
  - uma continuação antiga não sai com pedido cancelado e não sai duas vezes;
  - a ref é zerada ao desmontar.
- **Mantido sem mudança:** erro ao salvar ou edição durante o envio deixam a pessoa no editor com o conteúdo; descartar continua explícito.

## Achado lateral (documentado, sem mudança de comportamento)

Medido em Chrome 155 (`teste-ordem-popstate.mjs` no pacote): no `window`, um ouvinte de `popstate` registrado com captura **não** roda antes de um ouvinte sem captura registrado antes. Vale a ordem de registro.

Consequências:
- O roteador do Next (`app-router.js`, sem captura, registrado antes) também recebe o `popstate` da entrada-guarda.
- Como a guarda tem a mesma URL e o mesmo estado do roteador, ele fica na mesma página e o editor não é desmontado. O harness confere isso pela aba ativa, que sobrevive.
- O comentário anterior do hook dizia o contrário e foi corrigido.
- O Next 16 oferece `onNavigate` por `<Link>`. Não foi usado porque a proteção precisa cobrir links fora do editor (menu do shell) sem alterar cada link.

## Testes

Resultados no pacote de revisão:
- **Prova em memória:** código real do editor e do `useMarketing`, base × candidata.
  - os 12 cenários U2/U3 anteriores;
  - 10 novos C1/C2 com expectativas de comportamento correto.
- **Harness de navegador:** Chrome real, editor e hook `useProtecaoDeSaida` **reais**, empacotados com o webpack que vem compilado no Next.
  - O roteador sintético imita o do Next: Link pelo `onClick`, `popstate` sem captura.
  - A API sintética roda na página, com respostas seguradas. Sem Next, sem banco, sem rede.
  - Cobre: links internos, Voltar, Esc, intenção nova, erro, edição durante o envio e caminhos sem cancelamento.
- Testes de `lib/marketing`, teste do Pix, TypeScript, ESLint e `check:v1:static`.

**Limites.**
- O harness não é o produto completo: não exercita o App Router real nem o banco.
- A mudança visual é uma linha de texto junto de "Salvar endereço". Não houve captura estilizada, porque o ambiente com banco não foi autorizado para esta rodada.
- O E2E com o Next real e o banco é da rodada U1–U5.
