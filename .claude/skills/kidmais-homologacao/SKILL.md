---
name: kidmais-homologacao
description: Conduz a regressão e a homologação da V1 do Kidmais Manager (check:v1:static, clone de homologação, navegação de UI, leitura protegida de produção) na ordem certa e com as travas de ambiente. Use antes de release, depois de mudança grande ou migration, ou quando o usuário pedir "regressão", "homologação" ou "GO".
---

# Regressão / homologação V1

Fonte: `OPERACAO_V1_PRODUCAO.md` (raiz) e `REGRESSAO-V1-HOMOLOGACAO.md`. Testes mutantes **nunca** rodam no banco real.

## Sequência

1. `npm ci` e `npm audit --omit=dev` (registre o resultado).
2. `npm run check:v1:static` — testes `*.test.ts` de `app`, `components`, `lib`, lint, `tsc` e build.
3. **Clone de homologação** — `npm run check:v1:clone`. O próprio script recusa rodar se:
   - `KIDMAIS_REGRESSAO_HOMOLOGACAO` não for `SIM`;
   - `KIDMAIS_HOMOLOGACAO_DATABASE_URL` não existir, não for PostgreSQL em loopback (`localhost`/`127.0.0.1`/`::1`) ou o banco não se chamar exatamente `kidmais_v1_homologacao`;
   - a URL mencionar `kidmais_manager`.
   `DATABASE_URL` e `.env.local` não servem de origem. Peça ao usuário para preparar o clone (backup anonimizado restaurado) se não existir.
   Suítes: identidade (repository, service, fechamento), jornada fechamento → contrato → OTP → pagamento, pagamentos (engenharia, http) e festa (vigência/remarcação).
4. **UI** — `npm run check:v1:ui`: navegação com respostas simuladas (Playwright, porta 3027), sem login real nem escrita no banco. Use `PLAYWRIGHT_MODULE` se o playwright estiver fora do projeto.
5. **Manual no navegador** (o usuário ou a skill `/run`): Cliente → Disponibilidade → Fechamento → Contrato → assinatura/aceite → Pagamentos → Festa; depois edição pós-assinatura, remarcação, cancelamento, permissões, histórico, sessão expirada, concorrência e repetição de comandos; desktop e celular, sem erro de console.
6. **Leitura protegida de produção** — `npm run check:v1:producao:readonly` **somente** com autorização explícita do usuário, que define `KIDMAIS_AUTORIZAR_LEITURA_BANCO_REAL=SIM`. É `READ ONLY` e só compara a assinatura física da 016. O agente não define essa variável por conta própria.

## Regras

- Não executar rollback da Migration 016 em produção (há dados potenciais; o script recusa).
- Falha crítica reabre o gate: pare, reporte e não siga para as próximas etapas.
- Uma falha não é "flaky" sem evidência: rode de novo uma vez e, se repetir, trate como real.

## Relatório

Tabela etapa → PASS/FAIL/NÃO RODADO (motivo), evidências (contagens, hashes), bloqueios de GO pendentes (ver "Critério final de GO" em `OPERACAO_V1_PRODUCAO.md`).
