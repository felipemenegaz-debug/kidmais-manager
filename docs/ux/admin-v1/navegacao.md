# Navegação administrativa

UX Pilot é referência visual. A documentação funcional do Kidmais é a regra de produto. Código, APIs e migrations existentes são a implementação técnica. O menu pretendido abaixo é arquitetura de produto. Ele não é o menu que o código renderiza hoje, e o desenho não autoriza inventar rota.

Fonte do menu atual: `lib/admin/navegacao.ts`, consumido por `components/admin/AdminShell.tsx`.

Arquivos do shell desde a etapa 2A:

- `components/admin/shell.module.css`: estilos da casca (barra, sidebar, gaveta, conteúdo).
- `components/admin/tokens.module.css`: tokens visuais do administrativo, aplicados na raiz do shell pela classe `.tema`.
- `components/admin/fonte.ts`: Inter via `next/font`, aplicada pelos layouts `app/admin/layout.tsx` e `app/clientes/layout.tsx`. A tipografia está em [tokens.md](tokens.md).
- `components/admin/admin.module.css`: estilo legado das páginas (`.page` e afins). Não contém mais a casca.

## Menu pretendido

Três grupos, nesta ordem e com estes rótulos de arquitetura:

**Principal**

- Dashboard
- Solicitações

**Operação**

- Clientes
- Contratos
- Festas
- Agenda

**Configuração**

- Pacotes
- Tabelas de Preços
- Itens de Buffet
- Perfil da Empresa
- WhatsApp
- Usuários e Acessos
- Segurança

## Regra para a implementação futura do shell

Item sem rota, sem tela e sem API não recebe link e não ganha página “em breve”. O shell novo só pode apontar para destinos que já existem. Agrupar visualmente os destinos reais segundo a arquitetura acima é alinhamento de apresentação. Criar o destino que falta não faz parte desta etapa.

Não apague, nesta etapa, uma rota que já funciona só porque o menu pretendido não a lista. Em particular, o hub `/admin/configuracoes` e a publicação de PDF em `/admin/configuracoes/tabela-pacotes` continuam alcançáveis. Não os rebatize como Pacotes nem como Tabelas de Preços.

Não renomeie, nesta etapa, o item “Buffet e adicionais”. O rótulo de menu que corresponderá a “Itens de Buffet” ainda não foi decidido para a implementação. A correspondência visual está registrada na seção seguinte; a decisão de rótulo fica para uma tarefa posterior.

## O que o código liga hoje

`itensNavegacao` devolve Operação para qualquer sessão administrativa e acrescenta Configuração quando o papel é `REPRESENTANTE_AUTORIZADO`.

`GRUPOS_NAVEGACAO` fixa a ordem Principal, Operação, Configuração. `gruposNavegacao` não devolve grupo vazio, então o shell não renderiza cabeçalho sem item. Principal não tem nenhuma rota e por isso não aparece. O cabeçalho do grupo implementado é “Configuração”. O item do hub continua com o rótulo “Configurações”, em `/admin/configuracoes`.

Operação, com rota:

| Rótulo atual | Rota |
| --- | --- |
| Clientes | `/clientes` |
| Contratos | `/admin/contratos` |
| Festas | `/admin/festas` |
| Agenda | `/admin/disponibilidade` |

Configuração, com rota:

| Rótulo atual | Rota |
| --- | --- |
| Configurações | `/admin/configuracoes` |
| Perfil da empresa | `/admin/configuracoes/perfil-empresa` |
| Usuários e acessos | `/admin/configuracoes/acessos` |
| WhatsApp | `/admin/configuracoes/whatsapp` |
| Tabela de pacotes | `/admin/configuracoes/tabela-pacotes` |
| Buffet e adicionais | `/admin/configuracoes/catalogo` |

O item ativo é o href mais longo que coincide com o caminho ou com um prefixo dele (`itemAtivo` em `lib/admin/navegacao.ts`).

## O que não tem rota, tela nem API

- Dashboard.
- Solicitações. O mais próximo é a aba “Em contratação” na Central de Festas (`components/festas/FestaConsole.tsx`). Não renomeie essa aba para Solicitações.
- Pacotes como CRUD. A tabela `pacotes` só muda por migration. Não há CRUD na aplicação. Não implemente agora.
- Tabelas de Preços. A vigência de `tabelas_preco`, `precos_pacote` e `precos_adicional` muda por migration. Não há tela nem API de edição. Não implemente agora.
- Segurança. O mais próximo é Usuários e acessos. Não funda os dois nomes num item só.

## Não confundir quatro conceitos

**Tabela de pacotes**, rótulo atual do menu, é publicação de PDF. A tela é `components/admin/TabelaPacotesPdf.tsx`. A gravação administrativa é `POST /api/admin/configuracoes/tabela-pacotes`. A leitura pública é `/api/fechamentos/tabela-pacotes`. Isso não é o módulo Pacotes e não é Tabelas de Preços.

**Pacotes**, no menu pretendido, é um CRUD futuro. Hoje não existe. Não implemente agora.

**Tabelas de Preços**, no menu pretendido, é a administração futura das tabelas reais (`tabelas_preco`, `precos_pacote`, `precos_adicional`). Hoje não existe tela nem API de edição. Não implemente agora.

**Itens de Buffet**, no menu pretendido, corresponde visualmente ao catálogo atual “Buffet e adicionais”: `components/admin/CatalogoEditor.tsx` e `PATCH /api/admin/configuracoes/catalogo`. A gravação é direta. Não descreva esse catálogo como se tivesse rascunho ou auditoria de publicação. O rótulo de menu para a implementação ainda não foi decidido; esta documentação não o troca.

## Menu mobile: desenho e comportamento

A base visual mobile é o artboard 2/2, ID `pJtifCp4ezXtllds7P9o`. Ela mostra um botão de menu que é apenas um ícone, sem `onclick` e sem script. Esse ícone não especifica abertura, fechamento, foco nem scroll.

O comportamento funcional de navegação mobile é o do commit `45f639a641071039e9a15efeff613b3ffdec13d3`. Nesse commit a lógica estava em `components/admin/AdminShell.tsx` e o CSS em `components/admin/admin.module.css`. Na etapa 2A as regras de CSS do shell passaram para `components/admin/shell.module.css`, com o mesmo breakpoint e os mesmos seletores de estado. Arquivos vigentes:

- `components/admin/AdminShell.tsx`
- `components/admin/shell.module.css`

No viewport até 800px (`@media (max-width: 800px)`):

- A barra superior (`.barra`) fica visível, sticky, e contém o botão “Abrir menu”.
- A sidebar fica oculta até `data-aberto=true`.
- Aberta, a gaveta ocupa a tela: `position: fixed`, `inset: 0`, largura 100%, altura `100vh` / `100dvh`, com scroll interno (`overflow-y: auto`).
- Fechar ocorre pelo botão “Fechar menu”, pela tecla Escape, ou pelo clique num item do menu (`setAberto(false)` no `Link`).
- Com a gaveta aberta, o scroll da página trava (`document.body.style.overflow = 'hidden'`).
- A barra e o conteúdo recebem `inert` enquanto a gaveta está aberta. A própria gaveta não fica inert.
- Ao abrir, o foco vai para o botão de fechar. Ao fechar, o foco volta ao botão “Abrir menu”.
- Se a largura passa a `min-width: 801px`, a gaveta fecha.

No desktop a sidebar permanece sempre na coluna, expandida, com largura 16rem. Não há botão “Recolher menu”, largura de 4.5rem nem estado recolhido: a sidebar recolhida deixou de fazer parte do UX Admin V1. Os rótulos dos links, os cabeçalhos de grupo e o nome da conta permanecem visíveis. Esse comportamento é o da aplicação, não uma conversão de `w-64` do protótipo. As classes `hidden lg:flex` e prefixos `md:` / `lg:` / `xl:` do artboard são referência estrutural, não o breakpoint funcional. Ver [tokens.md](tokens.md).

A etapa 2A aproximou cores, tipo e composição da referência na casca e preservou este comportamento de gaveta. Mudanças futuras devem preservá-lo, a menos que uma tarefa posterior mude a navegação de propósito. Não ligue o ícone do protótipo a uma navegação nova inventada a partir do HTML.
