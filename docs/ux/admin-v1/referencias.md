# Referências visuais

UX Pilot é referência visual. A documentação funcional do Kidmais é a regra de produto. Código, APIs e migrations existentes são a implementação técnica. Nenhuma funcionalidade inexistente deve ser criada só porque aparece no mockup.

## Onde está o desenho

- Share: [https://uxpilot.ai/s/9ee1d98314d8ec21f6820641038dfc7f](https://uxpilot.ai/s/9ee1d98314d8ec21f6820641038dfc7f).
- Documento: “Kidmais Manager - Perfil da Empresa (Admin)”.
- Página: File 2, ID `JHqdH8xAqY8SrhhWrISA`.

Não há folha de estilo compartilhada. `jsonStyleUrl` é nulo. Cada artboard duplica o próprio `<style>`.

## Referência a usar

| Papel | Nome | Versão | ID | Artboard |
| --- | --- | --- | --- | --- |
| Desktop aprovado | Kidmais - AdminPerfilEmpresa | 3/3 | `NyzMuM4gcmrvcqH7WxGB` | 1440×1658 |
| Base visual mobile | Kidmais - AdminPerfilEmpresa | 2/2 | `pJtifCp4ezXtllds7P9o` | 375×2465 |

A versão mobile 2/2 é base visual. Não a chame de aprovada. O desktop 3/3 é o único artboard aprovado.

O botão de menu do protótipo mobile é só um ícone. Ele não tem `onclick` nem script. Isso não é especificação funcional de navegação. O comportamento funcional continua o do commit `45f639a641071039e9a15efeff613b3ffdec13d3`, descrito em [navegacao.md](navegacao.md), nos arquivos `components/admin/AdminShell.tsx` e `components/admin/admin.module.css`.

## Não usar

Estas versões existem no mesmo documento e não são referência. Não copie o conteúdo delas como regra de produto.

- Desktop 1/3, ID `fgZ1WyhAvg1JX4GeYPIj`, 1440×1658. Histórico inventado, sem unidade e sem selo.
- Desktop 2/3, ID `LP6S63ru9u7fFMebFOIc`, 1440×1635. Selo “Publicado” e “Sem número” usado como placeholder.
- Mobile 1/2, ID `x6CeYJ6P57Wuq5j5kThH`, 375×2465. Só Identificação, Endereços e Marca, com selo “Publicado”.

O selo “Publicado” dessas versões descartadas não é estado do produto. O histórico inventado da 1/3 não é dado da API. “Sem número” no produto é um checkbox que já existe na tela, não um placeholder de input.

## O que o HTML entrega

- Tokens e regras escritas no `<style>` de cada artboard, registrados em [tokens.md](tokens.md).
- Valores arbitrários escritos na própria classe, como `text-[10px]` e `max-w-[1200px]`, também registrados como literais seguros.
- Composição de duas pranchetas separadas: uma desktop e uma mobile. Não há `@media` no `<style>` do protótipo. Desktop e mobile não são um único layout responsivo.

## O que o HTML não entrega

- Regra de negócio, RBAC, rascunho, publicação, conflito, auditoria ou contrato de API.
- Pixel oficial para utilitários de escala do Tailwind que não foram compilados (`w-64`, `p-8`, `md:`, `lg:` e os demais listados em [tokens.md](tokens.md)).
- Hover ou focus de classes Tailwind que não tenham regra correspondente no `<style>`.
- Navegação mobile funcional. O ícone de menu do protótipo não abre gaveta.
- Autorização para criar módulo, rota, upload ou campo só porque o artboard os desenha.

A implementação técnica do que já existe está no código citado em [navegacao.md](navegacao.md) e [perfil-empresa.md](perfil-empresa.md).
