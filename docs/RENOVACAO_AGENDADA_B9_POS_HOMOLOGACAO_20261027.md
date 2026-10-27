# B-9: ajustes depois da homologação em staging (27/10/2026)

**Estado: APROVADO pela revisão independente (27/10/2026), sem achados nos dois escopos.** PR para staging; sem merge, deploy, credenciais no cron ou `simular`.

**Origem:**
- A homologação do B-9 em staging foi concluída em 27/10/2026 (roteiro rev. 2.6, B0a–B11).
- Felipe autorizou os passos seguintes:
  - criar o cron da renovação em `aguardando`;
  - incluir esse cron na lista TLS;
  - corrigir o defeito da redefinição de senha visto durante a homologação.

## 1. Cron da renovação de staging na lista TLS

- **O cron:** `kidmais-assinatura-renovacao-staging` (`crn-dbg512hsrm7s73chk57g`), criado em 27/10/2026:
  - branch `staging`, `0 * * * *`, região `virginia`, deploy automático desligado;
  - `KIDMAIS_DEPLOY_ENV=staging` e `KIDMAIS_RENOVACAO_MODO=aguardando`, sem nenhuma credencial;
  - em `aguardando`, a entrada sai com `AGUARDANDO_HABILITACAO` **antes** de validar o alvo ou conectar.
- **`scripts/assinatura-renovacao-cron.cjs`:** `CRON_RENOVACAO_STAGING = 'crn-dbg512hsrm7s73chk57g'`. Com isso, `SERVICOS_TLS_RENOVACAO` passa a ser o web de staging mais esse cron.
- **O que não muda:**
  - a reconciliação continua só com o cron dela;
  - a lista da T2 (credencial do serviço) continua só com o web, porque o cron não tem `DATABASE_URL`.
- **Fora desta mudança:** pôr as credenciais no cron e passar para `simular` (passo 4 do plano). Isso exige autorização própria e o deploy desta mudança no cron.

## 2. Redefinição de senha pelo painel com a recuperação pública desligada

- **Defeito:** o painel do desenvolvedor envia o link de redefinição sem depender de `RECUPERACAO_SENHA_ATIVA` (`solicitarRecuperacaoPeloPainel`). Mas `POST /api/acesso/redefinir` exigia a flag (`exigirRecuperacaoPublicaAtiva`), então o link chegava e a troca respondia 503. Visto em staging em 27/10, ao tentar entrar como a Gestão da empresa de homologação.
- **Correção:**
  - **`lib/acessos/disponibilidade.ts`:** `recuperacaoPublicaAtiva()`, com a flag `true` literal **e** o e-mail configurado. `exigirRecuperacaoPublicaAtiva()` continua igual por fora e é usada pelo pedido público.
  - **`lib/acessos/recuperacao.ts`:** `redefinirSenhaComToken(raw, ctx, deps, { aceitarOrigemPublica = false })`, fail-closed:
    - o pedido de origem `PAINEL` vale sempre;
    - qualquer outra origem só vale com `aceitarOrigemPublica`; senão, `EMAIL_NAO_CONFIGURADO` 503.
    - A conferência é **depois** do limite por IP e do token, **antes** do scrypt, da troca de senha e do consumo do link.
  - **`app/api/acesso/redefinir/route.ts`:** sem `exigirRecuperacaoPublicaAtiva`; repassa `aceitarOrigemPublica: recuperacaoPublicaAtiva()`.
- **Preservado:**
  - o pedido público (`POST /api/acesso/recuperacao`) continua recusado com a flag desligada;
  - um link de pedido público continua sem valer com a flag desligada;
  - expiração, uso único, limite por IP, encerramento das sessões e auditoria não mudam.

## Validação local

- **Testes:**
  - `lib/acessos/acessos.test.ts`: redefinição com o painel e a flag desligada; com pedido público ou origem desconhecida, 503 sem scrypt, sem troca e sem consumir o link; padrão fail-closed.
  - `lib/acessos/recuperacao-route.test.ts`: a rota repassa `aceitarOrigemPublica` para cada combinação de flag e e-mail; o pedido público continua 503.
  - `scripts/assinatura-renovacao-cron.test.cjs`: a lista TLS tem o web e o cron da renovação; a reconciliação recusa esse cron; a lista da T2 não tem o cron.
- **Mutantes** em cópia isolada, com o manifesto da entrega.
- **CI local completo e PostgreSQL descartável** (painel 063 e renovação agendada), com o manifesto da entrega.

## Limites

- A primeira execução real do cron só prova o `aguardando`. A conexão do cron só é provada no `simular`, depois do deploy desta mudança no cron e das credenciais.
- Não houve teste no navegador da redefinição pelo painel com a flag desligada. Isso exige deploy e um link real.
