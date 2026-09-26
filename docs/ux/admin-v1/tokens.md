# Tokens visuais

UX Pilot é referência visual. A documentação funcional do Kidmais é a regra de produto. Código, APIs e migrations existentes são a implementação técnica. Estes tokens descrevem o protótipo. O CSS atual da aplicação não os implementa. Alinhar o visual no futuro não altera API, RBAC nem persistência.

Origem dos literais abaixo: CSS autoral do protótipo, extraído do HTML. Os valores do bloco “iguais nas cinco versões” coincidem nas cinco pranchetas, salvo as duas exceções anotadas (tamanho da fonte do input e `padding-bottom` do body mobile). A referência a implementar é o desktop aprovado 3/3 (`NyzMuM4gcmrvcqH7WxGB`) e a base visual mobile 2/2 (`pJtifCp4ezXtllds7P9o`). As outras três versões não são referência de layout; servem aqui só para registrar que o CSS autoral se repete.

Não há folha compartilhada (`jsonStyleUrl` nulo). Cada artboard duplica o `<style>`. Não há `@media` nesse `<style>`. Desktop e mobile são artboards separados, 1440×1658 e 375×2465.

## Tokens oficiais

Variáveis literais do protótipo:

| Token | Valor |
| --- | --- |
| `--main-bg` | `#090D1B` |
| `--card-bg` | `#151B2E` |
| `--primary-violet` | `#7C3AED` |
| `--emerald-accent` | `#5DE3B0` |
| `--lilac-accent` | `#C9B6FF` |
| `--main-text` | `#F5F7FC` |
| `--secondary-text` | `#B8C2D8` |
| `--brand-blue` | `#2563EB` |
| `--border-navy` | `rgba(255,255,255,0.05)` |

Tipografia: Inter.

Input, regra do `<style>`:

- Desktop: fonte 14px.
- Mobile: fonte 16px.
- `padding: 12px 16px`.
- `border-radius: 12px`.
- Borda `rgba(255,255,255,0.08)`.
- Fundo `rgba(255,255,255,0.03)`.
- Foco: borda `primary-violet` (`#7C3AED`) e fundo `rgba(255,255,255,0.06)`.

## Literais seguros do CSS autoral

Iguais nas cinco pranchetas, salvo o `font-size` do input e o `padding-bottom` do body mobile:

- `body` usa `font-family` Inter.
- `.form-input` tem `width: 100%`, `color: white` e `outline: none` no foco.
- No desktop, `:disabled` usa `opacity: 0.5`.
- `.sidebar-active` tem `border-right: 3px solid` `primary-violet` e fundo `rgba(124,58,237,0.1)`.
- `.sidebar-item:hover` usa fundo `rgba(255,255,255,0.03)`.
- `.glass-header` usa fundo `rgba(9,13,27,0.8)`, `blur` de 12px e borda inferior de 1px.
- `.btn-primary` usa gradiente de `brand-blue` para `primary-violet` a 135deg.

Valores arbitrários escritos na classe (o número está no nome da classe; não são escala Tailwind a converter):

- `text-[10px]`, `text-[11px]`, `text-[9px]`.
- `tracking-[0.2em]`.
- `max-w-[1200px]`.
- `rounded-[32px]`, `rounded-[40px]`.
- `bg-[#090D1B]`.
- `z-[100]`.

Só na base visual mobile 2/2: `rounded-[24px]`, `text-[8px]` e `text-[9px]`. O `padding-bottom` do `body` é 120px na mobile 2/2 e 100px na mobile 1/2. A 1/2 não é referência de layout; o valor 100px fica registrado apenas para não ser confundido com os 120px da base visual.

## Referências estruturais, não oficiais em pixel

Estas classes aparecem no HTML do protótipo e descrevem estrutura (largura de sidebar, alturas de barra, grelha, visibilidade). O Tailwind do artboard não está compilado. Não transforme estas classes em pixel oficial e não as trate como especificação de medida.

- `w-64`, `h-20`, `h-16`.
- `p-8`, `gap-8`, `space-y-6`.
- `rounded-xl`, `rounded-2xl`.
- `md:`, `lg:`, `xl:`.
- `hidden lg:flex`.
- `xl:grid-cols-3`, `md:grid-cols-2`, `md:grid-cols-6`.

Hover e focus de classes Tailwind que não tenham regra no `<style>` não são especificação. Só valem as regras nomeadas acima (foco do input, hover de `.sidebar-item`, estado `.sidebar-active`).

O breakpoint funcional da navegação mobile da aplicação não vem destas classes. Ele está no CSS do shell, descrito em [navegacao.md](navegacao.md).
