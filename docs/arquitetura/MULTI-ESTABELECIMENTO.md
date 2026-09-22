# Multiestabelecimento

## Decisão
Uma Empresa pode possuir múltiplos Estabelecimentos.

## Relação
```
Empresa 1:N Estabelecimentos
```

## Regras
- cada estabelecimento pertence a uma única empresa;
- cada estabelecimento possui código próprio no contexto da empresa;
- configurações podem variar por unidade;
- dados operacionais devem carregar ou resolver de forma inequívoca o estabelecimento;
- usuários podem ter acesso a uma, várias ou todas as unidades da empresa;
- empresa pode consolidar relatórios entre suas unidades;
- nenhuma consolidação pode atravessar tenants.
