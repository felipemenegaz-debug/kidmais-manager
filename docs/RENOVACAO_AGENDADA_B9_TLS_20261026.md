# B-9: TLS interno da renovação por lista fechada, T1 (26/10/2026)

**Estado: LOCAL, aguardando revisão independente.** Sem push, PR, deploy ou variável de ambiente.

**Origem:**
- a revisão do roteiro de homologação do B-9 (P2-H1, 26/10) apontou que a entrada `scripts/assinatura-renovacao-cron.cjs` não conecta ao Postgres interno de staging;
- a exceção TLS `render-interno-criptografado` (`docs/TLS_CRON_STAGING_20261009.md`) só aceitava o cron da reconciliação `crn-db493i142hec73ahmoe0`;
- isso bloqueava o Shell do web (homologação, passo 2) e também o cron novo da renovação (passo 3);
- Felipe aprovou a **T1** em 26/10.

## O que muda

- **`scripts/assinatura-reconciliar.cjs`:** `opcoesConexao(alvo, env, servicosTlsInterno = SERVICOS_TLS_RECONCILIACAO)`, com `SERVICOS_TLS_RECONCILIACAO = ['crn-db493i142hec73ahmoe0']` congelada. **O padrão não muda:** a reconciliação continua aceitando só o cron dela.
- **`scripts/assinatura-renovacao-cron.cjs`:**
  - `SERVICOS_TLS_RENOVACAO` congelada, **lista fechada**:
    - `srv-daif418ae00c73e8k2gg` (web de staging), só para o Shell da homologação, já que a aplicação web não chama esta entrada;
    - `CRON_RENOVACAO_STAGING`, hoje **`null`**: nenhum cron é aceito até Felipe criar o cron `kidmais-assinatura-renovacao-staging` em `aguardando` (que sai sem conectar). O `crn-…` real entra numa mudança própria, de uma linha.
  - `conexaoDaRenovacao(alvo, env)` aplica a política da reconciliação com essa lista;
  - o `main` usa `conexaoDaRenovacao`, calculada **antes** de conectar: uma recusa sai com código 1 sem abrir socket.
- **Condições mantidas para a exceção:** `RENDER=true`, serviço na lista, `KIDMAIS_DEPLOY_ENV=staging`, `ASAAS_AMBIENTE=sandbox`, alvo literal `kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432`, a URL igual à confirmada e TLS 1.2 mínimo.
- **Postura:** sem verificação de certificado, a mesma aceita para o cron da reconciliação em 09/10. Sem a variável de opt-in, o certificado é verificado.
- **As listas são disjuntas:** a renovação recusa o cron da reconciliação, e a reconciliação recusa o web.
- **Production não muda:** o caminho dela é `DATABASE_SSL=true` (`TLS_PRODUCAO_RECUSADO` com a exceção).

## Validação local

- **Testes:**
  - `scripts/assinatura-renovacao-cron.test.cjs`: 2 novos;
    - listas fechadas, congeladas e disjuntas;
    - web aceito com TLS 1.2 e sem verificação;
    - sem opt-in, verificação ativa;
    - recusa do cron da reconciliação, de serviço qualquer ou ausente, de `RENDER` ausente, de production, de Asaas de produção, de alvo alterado e de política inválida;
    - reconciliação inalterada;
    - o `main` usa `conexaoDaRenovacao`.
  - Arquivos relacionados (`assinatura-renovacao-cron`, `assinatura-reconciliar`, `assinatura-cron`): 35/35.
- **Mutantes**, em cópia isolada `mutacao-renovacao-tls-20261026` (clone LF, `npm ci` e commit de base local), com controles positivos antes e depois em 0. **7/7 detectados:**
  - T1: renovação aceita o cron da reconciliação;
  - T2: reconciliação ampliada para o web;
  - T3: `main` volta a `opcoesConexao`;
  - T4: renovação ignora a própria lista;
  - T5: qualquer serviço aceito;
  - T6: cron inventado na lista;
  - T7: exceção sem TLS 1.2 mínimo.
  - O controle inofensivo T0 sobreviveu.
- **CI local:** os 24 passos com saída 0 (check estático 3654/3654; o passo do cron, com o teste novo, 63/63).
- **PostgreSQL** (cluster descartável, base `58c54518`): as suítes que carregam a reconciliação passaram: `contratacao-e8` (atual e 075), `transacao-com-prazo` (atual e 075), `kidmais-gratuidade` (079 e 079-sem-atendimento), `devolucao-089`, `arrependimento-097`, `creditos-095`, `campanha-090` e `renovacao-agendada` (11/11 execuções).
- **Outros chamadores de `opcoesConexao`** (vigia de arrependimento, créditos, diagnóstico, preflight, ferramenta restrita G2): usam a lista padrão, sem mudança. **A ferramenta restrita (G2) continua sem acesso TLS pelo Shell do web**, como antes; ela fica fora desta T1.

## Limites

- **Conexão real:** não foi testada aqui (local, sem staging). A prova é o bloco **B0c** do roteiro de homologação, depois do deploy.
- **Cron da renovação:** fica sem acesso até que a mudança com o `crn-…` seja revisada.
