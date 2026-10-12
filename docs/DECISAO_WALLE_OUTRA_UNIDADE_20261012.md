# Decisão pendente — "outra unidade" de um item vendido só como adicional (Wall-e, 12/10/2026)

> **Status: NÃO DECIDIDA.** A ativação do Wall-e (modo regras ou IA, em qualquer ambiente) fica **bloqueada** até uma
> decisão comercial registrada. Este documento prepara a decisão; ele não autoriza nada e não muda o comportamento.

## A pergunta

O cliente pede outra unidade de um item de decoração: "segunda mesa de vidro", "outra mesa XL", "mais uma mesa com LED".

No pacote:

- o item existe **só como adicional (EXTRA)**, por exemplo "Mesa temática de vidro" a R$ 520;
- **não** há uma unidade inclusa desse mesmo tipo;
- **não** há item cadastrado como "a mais" desse tipo, por exemplo "Segunda mesa temática de vidro".

**O Wall-e deve tratar o pedido como "mais uma unidade do próprio adicional" e informar o preço desse adicional?**

## Comportamento atual (código revisado)

`lib/whatsapp/atendimento/walle/resolver.ts`, em `selecionarParaPedido`, no ramo do pedido com quantidade:

```ts
// Outra unidade do próprio adicional só quando o cadastro sustenta: o tipo existe como adicional e o pacote NÃO tem
// uma unidade dele inclusa (com a principal inclusa, a outra unidade precisa estar cadastrada como "a mais").
if (!opcoes.length && !inc.some(unidade)) opcoes = ext.filter(unidade);
```

- **Hoje:** "segunda mesa temática de vidro", nesse cadastro, recebe "“Mesa temática de vidro” é adicional: R$ 520,00
  pela tabela de preços vigente…". A resposta diz o nome do item cotado.
- **Com a principal desse tipo inclusa:** "Mesa temática de vidro" INCLUSO e nenhuma "Segunda … de vidro". O pedido
  **não** casa e vai à equipe sem preço; esse é o achado da revisão de `d590845`, já corrigido.
- **Pedido sem quantidade** ("quanto custa a mesa de vidro?"): não é afetado por esta decisão.

## Opções

| | A — conservadora | B — manter o atual | C — campo explícito no cadastro |
|---|---|---|---|
| Regra | "outra/segunda/mais uma X" só casa com um item **cadastrado como "a mais"** com essas características; sem ele, lacuna e equipe | sem unidade inclusa do tipo, outra unidade = o próprio adicional, pelo preço dele | o adicional diz se pode ser vendido em mais de uma unidade (e com qual preço), e o Wall-e só usa isso |
| Exemplo acima | "Não tenho cadastrado “segunda mesa temática de vidro”…": equipe, sem preço | R$ 520,00, com o nome do item | depende do cadastro do item |
| Risco | encaminhamento a mais quando o adicional é mesmo vendido por unidade | preço errado se a 2ª unidade tiver outro valor, montagem extra ou não puder ser vendida | precisa de migration e de tela; fora desta PR |
| Mudança | 1 linha no resolver (remover o fallback); ajustar 1 teste de `walle.test.ts`, a regra correspondente da matriz (`satisfazem` em `correspondencia-matriz.test.ts`) e o NC61, no mesmo commit | nenhuma | schema (nova migration), tela da Gestão, resolver, testes |
| Efeito nos corpora r47 | esperado nenhum: na fixture com decoração os únicos adicionais são a mesa e o painel inclusos e a segunda mesa "a mais", então o fallback nunca é acionado (a confirmar quando A for implementada) | — | — |

## Recomendação técnica (não é decisão comercial)

- **Antes da confirmação comercial, usar A.** É o único comportamento que não presume nada sobre preço ou
  disponibilidade de uma unidade extra. O custo dele é um encaminhamento a mais, e o cliente não recebe um valor errado.
- **Se a Kidmais confirmar por escrito** que todo adicional de decoração é vendido por unidade, sempre pelo mesmo preço
  da tabela e sem limite, **B** pode ficar.
- **C** resolve de forma definitiva, mas é trabalho de produto: schema e tela.

## Para decidir (Felipe ou o comercial da Kidmais)

1. Os adicionais de decoração podem ser vendidos em mais de uma unidade? Sempre, nunca ou depende do item?
2. A 2ª unidade tem o mesmo preço da 1ª na tabela? Há custo de montagem, espaço ou limite por festa?
3. Até haver cadastro explícito, o Wall-e deve cotar a 2ª unidade (B) ou passar à equipe (A)?

**Registro da resposta:** quem decidiu, data e opção escolhida, neste arquivo ou no registro de homologação. Sem esse
registro, a ativação continua bloqueada.
