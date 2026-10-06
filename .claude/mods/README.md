# Mods do Claude Code para o Kidmais Manager

## kidmais-guard
Aplica as regras permanentes (docs/08, docs/05) direto no agente:
- bloqueia `Edit`/`Write` em `.env*` (menos `.env.example`);
- bloqueia comandos com `.env.production`, `migration-*.apply`, `prisma migrate deploy/reset`,
  `admin-provision`, `DROP TABLE`/`TRUNCATE`, push direto ou force-push na `main`.

O agente recebe o motivo e precisa pedir autorização ao usuário.

## kidmais-gate
- Faixa acima do prompt com os arquivos alterados na sessão, as áreas
  (pagamentos, contratos, comercial, disponibilidade, banco, segurança) e alertas.
- `/kidmais-gate` (ou o botão **Rodar gate**): roda `lint`, `tsc --noEmit`,
  `check:v1:static` (o mesmo do CI) e os testes de cada área alterada, num painel.
  As falhas voltam para o agente como contexto.

## Como carregar
```bash
claude --plugin-dir .claude/mods/kidmais-guard --plugin-dir .claude/mods/kidmais-gate
```
Validar e testar: `claude plugin validate <pasta>` e `claude plugin test <pasta>`.
