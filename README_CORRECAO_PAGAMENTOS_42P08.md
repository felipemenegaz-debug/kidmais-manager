# Kidmais Manager — correção Pagamentos 42P08

Correção de aplicação. **Não exige nova migration** e não altera `schema_mvp_kidmais.sql`.

## Problema corrigido

O PostgreSQL retornava `42P08: tipos inconsistentes deduzidos do parâmetro $2` (`text versus character varying`) ao confirmar um recebimento. O mesmo padrão existia em outras transições de status do domínio Pagamentos.

## Ajustes

- casts explícitos dos parâmetros de status para os `varchar` definidos pela migration 011;
- correção preventiva em status de Pagamento, Reserva, Parcela e Recebimento;
- remoção de `Promise.all` sobre o mesmo `pg.Client` dentro de transações, evitando o warning/depreciação do `node-postgres` e incompatibilidade futura com pg 9.

## Validação realizada

- `npm run test:disponibilidade`: 5/5;
- `npm run test:contrato`: 12/12;
- `npm run test:pagamentos`: 4/4;
- `npx tsc -p tsconfig.json --noEmit`: sem erros.

## Aplicação

Extraia o conteúdo sobre a raiz `Kidmais-manager`, permitindo substituir os dois arquivos em `lib/pagamentos`.
