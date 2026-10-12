# "Outra unidade" de um item vendido só como adicional — Wall-e (12/10/2026)

> **Status:** opção **A (conservadora) implementada como escolha técnica**, por pedido da revisão de `1f935f0`.
>
> **Isto não é confirmação de uma regra comercial da Kidmais.**
>
> - A pergunta comercial abaixo continua **em aberto**.
> - A opção A foi escolhida por não presumir nada sobre preço ou disponibilidade de uma unidade extra.
> - Se a Kidmais decidir outra regra, este documento e o código mudam.
>
> A ativação continua sujeita aos demais bloqueadores da PR.

## A pergunta (em aberto, comercial)

O cliente pede outra unidade de um item de decoração: "segunda mesa de vidro", "outra mesa XL", "mais uma mesa com LED".

O pacote não tem item cadastrado como "a mais" desse tipo. O item existe só como adicional (por exemplo, "Mesa temática
de vidro" a R$ 520) ou como unidade inclusa.

**Pode-se cotar a segunda unidade pelo preço da unidade simples?**

## Comportamento implementado: opção A

`lib/whatsapp/atendimento/walle/resolver.ts`, em `selecionarParaPedido`, no ramo do pedido com quantidade ("segunda",
"outra", "mais uma", "a mais", "duas"):

- **Item "a mais" cadastrado:** só responde um item cadastrado **expressamente** como "a mais", com exatamente as
  características pedidas. O marcador está no nome: "Segunda", "Outra", "adicional", "extra".
  - **Adicional com preço vigente:** informa o preço desse item, pela tabela de preços vigente.
  - **Adicional sem preço vigente:** "o valor dele não está cadastrado na tabela de preços: a equipe confirma". Nada é
    inventado.
  - **Incluso no pacote:** diz que vem no pacote, sem preço.
- **Sem esse cadastro:** "Não tenho cadastrado “segunda mesa temática de vidro”; por isso não informo valor por aqui,
  para não usar o de outro item: a equipe confirma essa parte." A parte vai à equipe (`INFORMACAO_INDISPONIVEL`).
- **Unidade simples:** o preço dela (inclusa ou adicional) **nunca** é usado para inferir o da outra unidade.
- **Saiu:** o fallback "sem unidade inclusa do tipo, outra unidade = o próprio adicional", que era a opção B.

**Preservado:**

- decoração inclusa;
- pedido sem quantidade, que é respondido pelo próprio item;
- características exatas (XL ≠ XL2, material, complementos);
- várias referências na mesma mensagem;
- cobertura dos pacotes;
- isolamento por empresa: o preço vem da tabela da própria empresa (`preco-adicional`, PostgreSQL);
- aviso do link.

## Opções consideradas

| | A — conservadora (**implementada**) | B — anterior | C — campo explícito no cadastro |
|---|---|---|---|
| Regra | outra unidade só com item "a mais" cadastrado; senão, equipe | sem unidade inclusa do tipo, outra unidade = o próprio adicional | o adicional diz se pode ser vendido em mais de uma unidade, e por qual preço |
| Exemplo acima | lacuna e equipe, sem preço | R$ 520,00 | depende do cadastro |
| Risco | encaminhamento a mais quando o adicional é mesmo vendido por unidade | preço errado se a 2ª unidade tiver outro valor, montagem extra ou não puder ser vendida | precisa de migration e de tela |
| Situação | em `whatsapp/walle-opcao-a-20261012` | em `1f935f0` e antes | não iniciada (produto e schema) |

## Para a Kidmais decidir (em aberto)

1. Os adicionais de decoração podem ser vendidos em mais de uma unidade? Sempre, nunca ou depende do item?
2. A 2ª unidade tem o mesmo preço da 1ª na tabela? Há custo de montagem, espaço ou limite por festa?
3. **Até haver cadastro explícito**, o Wall-e deve continuar passando à equipe (A, atual)? Ou deve cotar a 2ª unidade
   pelo preço do adicional (B)?

**Enquanto não houver resposta:** a opção A fica. Para cotar uma segunda unidade, a Gestão cadastra o item "a mais" com
preço próprio, por exemplo "Segunda mesa temática de vidro".

**Registro da resposta:** quem decidiu, data e opção escolhida, neste arquivo ou no registro de homologação.
