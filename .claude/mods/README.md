# Mods do Claude Code para o Kidmais Manager

## kidmais-guard
Aplica as regras permanentes (docs/08, docs/05) direto no agente:
- bloqueia `Edit`/`Write` em `.env*` (menos `.env.example`);
- bloqueia comandos que carregam ou leem o env de produção (`--env-file`, `source`, `cat`…);
  a execução (`node …`) de `migration-*.apply` e do script de provisionamento de admin;
  `prisma migrate deploy/reset`; `DROP`/`TRUNCATE` via `psql`; push direto ou force-push na `main`.
- Ler, buscar, citar e versionar esses arquivos continua liberado.

O agente recebe o motivo e precisa pedir autorização ao usuário.

## kidmais-gate
- Faixa acima do prompt com os arquivos alterados na sessão, as áreas
  (pagamentos, contratos, comercial, disponibilidade, banco, segurança) e alertas,
  inclusive "código mudou sem docs/".
- `/kidmais-gate` (ou o botão **Rodar gate**): roda `lint`, `tsc --noEmit`,
  `check:v1:static` (o mesmo do CI) e os testes de cada área alterada, num painel.
  As falhas voltam para o agente como contexto.

## kidmais-docs
Na primeira vez que o agente lê ou edita um arquivo de cada módulo (pagamentos, contratos,
festas…), acrescenta ao contexto qual documento oficial de `docs/` rege aquele módulo.
Um lembrete por módulo por sessão.

## Como carregar
```bash
claude --plugin-dir .claude/mods/kidmais-guard \
       --plugin-dir .claude/mods/kidmais-gate \
       --plugin-dir .claude/mods/kidmais-docs
```
Validar e testar: `claude plugin validate <pasta>` e `claude plugin test <pasta>`.

As skills ficam em `.claude/skills/` e o Claude Code as carrega sozinho neste repositório.
