# B-9: credencial do serviço por exceção explícita, T2 (27/10/2026)

**Estado: APROVADA pela revisão independente (rodada 2, 27/10/2026), sem achados.** PR para staging; sem merge, deploy, cron ou variável de ambiente.

**Rodada 2 (27/10):** a primeira revisão REPROVOU (P2-T2-1): a exceção TLS revalidava o alvo com a política padrão e recusava a credencial do serviço, embora o planejamento a aceitasse. Agora `opcoesConexao` recebe a política (padrão `recusar` para todas as entradas), e `conexaoDaRenovacao` repassa a mesma política do planejamento, recalculada do ambiente. Há teste integrado `planejar → conexaoDaRenovacao` com as duas exceções ligadas.

**Origem:**
- na homologação do B-9 em staging (passo 2 do plano), o B0c foi recusado antes de conectar com `Alvo recusado`;
- a credencial do cron de reconciliação (`KIDMAIS_RECONCILIAR_DATABASE_URL`) é a **mesma** `DATABASE_URL` do web de staging, e `validarAlvo` recusa essa igualdade. No cron passa, porque lá não existe `DATABASE_URL`; no Shell do web, não;
- a rev. 2.4 do roteiro tirava a variável do processo (`env -u DATABASE_URL`). A revisão independente a **reprovou** (P2-E2): isso esconde a condição em vez de criar uma exceção explícita;
- Felipe aprovou a **T2** em 27/10.

## O que muda

- **`scripts/assinatura-reconciliar.cjs`:** `validarAlvo(env, { credencialDoServico = 'recusar' } = {})`.
  - **O padrão não muda:** todos os chamadores continuam recusando a URL igual à `DATABASE_URL` do serviço.
  - `'aceitar'` só pode ser pedido por quem decidiu uma exceção explícita. Outro valor dá `CREDENCIAL_DO_SERVICO_POLITICA_INVALIDA`.
  - O alvo devolvido declara `credencialDoServico` (`true` só quando as duas URLs são iguais).
  - `opcoesConexao(alvo, env, servicos, { credencialDoServico = 'recusar' } = {})`: a revalidação do alvo na exceção TLS usa a política recebida; só a renovação passa uma.
- **`scripts/assinatura-renovacao-cron.cjs`:** `politicaCredencialDoServico(env, ambiente)` e `CREDENCIAL_DO_SERVICO`, congelada.
  - **Sem o opt-in:** `'recusar'`, como antes.
  - **Com o opt-in literal `KIDMAIS_RENOVACAO_CREDENCIAL_DO_SERVICO=web-staging-homologacao`**, exige **todas** as condições, senão `CREDENCIAL_DO_SERVICO_RECUSADA`:
    - `KIDMAIS_DEPLOY_ENV=staging`;
    - `RENDER=true`;
    - `RENDER_SERVICE_ID` na lista fechada: só o web de staging `srv-daif418ae00c73e8k2gg` (nenhum cron);
    - `ASAAS_AMBIENTE=sandbox`.
  - O alvo literal de staging continua conferido depois, como sempre. O opt-in não relaxa nada além da igualdade.
  - **Modo:** `simular` livre. `aplicar` com a credencial do serviço só com `--empresas` (`CREDENCIAL_DO_SERVICO_EXIGE_EMPRESAS`, no planejamento e de novo na execução) e só para fixtures de homologação, com ou sem `--agora` (`CREDENCIAL_DO_SERVICO_SO_FIXTURES`, depois de conectar e antes de qualquer trava ou processamento).
  - **Relatório:** o JSON do `main` declara `credencialDoServico`.
- **Fora do alcance:** a reconciliação, o vigia de arrependimento, os créditos, o diagnóstico, o preflight e a ferramenta restrita continuam recusando a igualdade. O cron da renovação (passo 3) não tem `DATABASE_URL` e não usa a T2. Production recusa o opt-in.

## Validação local

- **Testes** (`scripts/assinatura-renovacao-cron.test.cjs`, 7 novos):
  - sem opt-in, a igualdade continua recusada (simular e aplicar);
  - com o opt-in e as condições: aceita e declara; `aplicar` exige `--empresas`; URL própria ou sem `DATABASE_URL` dá `credencialDoServico: false`;
  - opt-in fora das condições: valor diferente, `RENDER` ausente ou falso, cron da reconciliação, serviço qualquer ou ausente, Asaas de produção ou ausente, staging trocado por production e production completo; alvo errado continua recusado;
  - `validarAlvo` recusa por padrão; política inválida recusada; **só a renovação passa uma política** (verificação estática dos scripts);
  - execução com banco simulado: `aplicar` com a credencial do serviço recusa empresa real e lista ausente antes de qualquer trava; a fixture passa; `simular` não exige fixture;
  - integrado: `planejar → conexaoDaRenovacao` com a credencial do serviço e o TLS interno; sem opt-in ou fora das condições, a revalidação recusa; a política padrão de `opcoesConexao` continua recusando para as outras entradas;
  - o `main` declara `credencialDoServico`.
  - Arquivos relacionados (`assinatura-renovacao-cron`, `assinatura-reconciliar`, `assinatura-cron`, `arrependimento-vigia`): 46/46.
- **Mutantes**, em cópia isolada `mutacao-renovacao-credencial-20261027` (clone LF, `npm ci`, commit de base local), controles antes e depois com 0 falhas. **19/19 detectados** (C1–C19): padrão aceitar, política inválida aceita, igualdade não declarada, qualquer opt-in, fora de staging, sem `RENDER`, qualquer serviço, sem sandbox, cron da reconciliação na lista, `aplicar` global, `aplicar` em empresa real, sem a segunda guarda, relatório sem a declaração, outra entrada pedindo `aceitar`, ausência de opt-in aceitando, TLS revalidando com a política padrão, renovação sem repassar a política, `opcoesConexao` aceitando por padrão e TLS aceitando sem conferir o opt-in. O controle inofensivo C0 sobreviveu.
- **CI local:** todos os passos de `.github/workflows/ci.yml` (ver o manifesto da entrega).

## Limites

- **Conexão real:** não testada aqui. A prova é o **B0c** do roteiro de homologação (rev. 2.5), depois do deploy.
- **Mesmo usuário do web:** na homologação, a entrada usa a credencial do web, com os mesmos privilégios. Isso é declarado, não escondido. Um usuário próprio fica para o cron da renovação.
