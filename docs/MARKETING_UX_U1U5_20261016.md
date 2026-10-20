# Marketing — correções U1–U5 da revisão da UX (16/10/2026, somente local)

**Goal:** nota `Goal Correcoes UX Marketing U1 U5` no vault.
**Base:** `67240b3` (UX, reprovada no recorte UX pela revisão independente de 16/10). Pai aprovado: `90135b4`.
**Branch:** `codex/marketing-ux-correcoes-u1-u5-20261016`, worktree `kidmais-manager-marketing-ux-u1u5-20261016`. Só local, sem push.
**Parecer de origem:** `revisao-marketing-ux-67240b3-parecer-20261016/PARECER.md`.
**Revisão independente desta candidata:** pendente. **Aceite humano:** pendente.

## U1 — listas suspensas do painel

**Causa:** no Chromium/Windows, a lista ABERTA de um `<select>` nativo é pintada com a cor das opções. Os campos do painel têm fundo translúcido (`rgba`). Com isso, a lista ficava branca com texto quase branco. Algumas telas tinham remendos locais (atendimento, contratos, workspace, perfil, importação); as demais não tinham nada.

**Correção, uma regra só** (`components/admin/tokens.module.css`, escopo `.tema`, que envolve painel, acesso, cadastro e desenvolvedor):
- `color-scheme: dark` no campo;
- opções e grupos com a superfície opaca do tema (`--km-card-2`) e o texto do tema;
- opção marcada em violeta;
- opção desabilitada esmaecida, mas legível (5,05:1);
- campo desabilitado com opacidade reduzida.

Os remendos locais equivalentes foram removidos. O do Perfil (Pix) foi mantido com as mesmas cores, porque um teste existente (`pix-ui.test.ts`) exige o seletor escuro ali. Todas as listas ficam com as mesmas cores. O controle continua nativo: teclado, leitor de tela, zoom e toque não mudam. Os sites públicos claros e a prévia não estão dentro de `.tema` e não têm `<select>`.

**Limite do navegador:** no menu aberto do Windows, a opção sob o cursor ou o teclado usa o realce do sistema (azul claro com texto escuro), não o violeta. Ela continua legível. Em telefone real, o seletor é o do sistema operacional.

## U2 — edição durante o salvamento

**Decisão:** reconciliar, sem bloquear a digitação.
- O que foi **enviado** é o que fica salvo.
- O que foi digitado **durante** o envio passa para a versão nova do rascunho e continua marcado como "Alterações não salvas", com um aviso.
- Erro: nada muda no estado salvo, o conteúdo fica, e a nova tentativa envia o mais recente.
- Clique repetido antes de a tela atualizar não gera segundo envio (trava por `ref`).
- Vale para todos os campos, inclusive SEO.

## U3 — unidade × respostas assíncronas

- `useMarketing` (`comum.tsx`) informa de qual URL vieram os dados (`dadosDe`). O editor só considera acionáveis os dados da unidade **selecionada**. Enquanto a nova unidade carrega, ou se a leitura falhou, nada da anterior aparece. O erro mostra "Tentar novamente".
- Operações em andamento (salvar, publicar, endereço, fotos, remoção, domínios) são contadas. Enquanto houver alguma, o seletor de unidade fica desabilitado e explica o motivo.
- Respostas de mutação conferem o contexto: se a URL mudou, os dados não são aplicados.
- Fotos e domínios aplicam o resultado sobre os dados **atuais** (atualização funcional), e só se for o mesmo site. Antes, a cópia antiga podia desfazer a versão salva. A remoção de foto edita o rascunho mais recente.
- Trocar de unidade com alterações abre um diálogo: "Continuar editando", "Salvar e trocar" ou "Trocar sem salvar".
- APIs não mudaram: empresa, site e versão continuam validados no servidor.

## U4 — saída do editor com alterações

Hook `useProtecaoDeSaida` (`components/admin/marketing/protecao-saida.ts`):
- recarregar/fechar → aviso nativo (`beforeunload`);
- links internos (cabeçalho de Marketing, menu lateral, qualquer `<a>` da mesma origem) → clique interceptado na captura, antes do roteador → diálogo modal (`<dialog>`) com "Continuar editando", "Salvar e sair" (só sai depois do sucesso; com erro, fica com conteúdo e aviso) e "Sair sem salvar";
- voltar do navegador → entrada-guarda no histórico (mesma URL, estado do roteador preservado); voltar sai dela e abre o diálogo sem desmontar o editor. Ao ficar sem alterações, a guarda é retirada.

Não pergunta em: Ctrl/⌘/Shift/botão do meio (nova aba), `target`, download, âncora na mesma página, abas internas do editor e alternância de prévia.

## U5 — retorno real ao salvar regra

`retornoAoSalvarRegra` (`lib/marketing/automacoes/explicacao.ts`, com teste) usa a regra **devolvida pelo servidor**:
- ativa → "continua ativa";
- ativa que o servidor pausou (texto/modelo alterado, ou ação trocada para mensagem sem revisão) → "salva e PAUSADA… agendadas canceladas";
- pausada → "continua pausada", com "Revise o texto…" quando falta revisão;
- rascunho.

Comportamento da tela:
- O selo e o resumo passam a usar a regra devolvida na hora.
- O retorno aparece também no próprio cartão.
- Antes de salvar, um aviso diz quando a alteração vai pausar a regra. A condição espelha `salvarRegra` e não muda o backend.

## Atribuição de campanhas (explicação, sem automação nova)

`AtribuicaoExplicada` aparece em Campanhas, Origens dos contatos e Visão geral. Mostra o fluxo:
1. link (código `kc`);
2. contato;
3. negociação **vinculada pela equipe**, que herda a origem se ainda não tiver uma;
4. contrato **assinado**, que conta conversão e receita contratada. Receita recebida é distinta.

Também explica o que o sistema **não** faz:
- UTM sem código da campanha fica só como informação;
- clique no WhatsApp não identifica a conversa;
- não adivinha campanha por telefone, data ou aniversário.

"Virou negociação" (CONVERTIDO) não é contrato. A correção manual fica no painel "Origem" da negociação. Nenhuma regra de atribuição foi alterada.

## Invariantes

O delta não toca rotas de API, `motor.ts`, `alvos.ts`, `preferencias.ts`, `regras.ts`, `contatos.ts`, `metricas.ts`, `utm.ts`, nem migrations. UX entregue, estilos, conteúdo antigo, rascunho/publicação, imagens privadas, SEO e permissões foram preservados. R1–R4, O1/O2 e F1 seguem sem mudança de código. O3/O4 continuam fora.

## Validação

Resultados e evidências no pacote de revisão (LEIA-ME):
- prova controlada base × candidata (código real do editor e do hook);
- E2E em navegador com respostas seguradas e conferência no banco;
- listas abertas capturadas só da janela da demonstração;
- auditoria de cores das listas;
- testes, lint, TypeScript e build.
