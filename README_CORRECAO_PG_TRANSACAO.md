# Correção de compatibilidade PostgreSQL / pg

Corrige execução paralela de queries quando um `DbExecutor` transacional
baseado em `PoolClient` é fornecido.

- Fora de transação: consultas independentes continuam podendo usar Promise.all.
- Dentro de transação: consultas são executadas sequencialmente no mesmo client.

Objetivo: remover o warning:
`Calling client.query() when the client is already executing a query is deprecated`
e manter compatibilidade futura com pg@9.

Validação:
```powershell
npx.cmd tsc -p tsconfig.json --noEmit
npx.cmd --yes tsx scripts/identidade-fechamento.integration.ts
```
