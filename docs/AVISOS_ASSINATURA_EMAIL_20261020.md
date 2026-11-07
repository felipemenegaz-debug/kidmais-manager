# Avisos por e-mail da assinatura — 20/10/2026

> **Bloqueio em production (B-27, 07/11/2026).** No ramo G-VAZIO, a D-VZ-6 exige suspender os avisos de production (`crn-dbkt25m7bikc73fqhlh0`) no início da barreira, antes do P1, com a autorização A-VZ-2 e prova de que a execução ativa terminou; a retomada exige a dívida fechada e autorização. `AVISADA` e `aviso_enviado_em` não provam notificação: antes de retomar processador que os use, concilia-se a entrega e verifica-se o endpoint do Resend e o que ainda é recuperável. `ASSINATURA_AVISOS_EMAIL` tem o estado registrado e não precisa ser desligada para o G-VAZIO; registrar e preservar esse estado não permite ligá-la, criar substituto ou rodar o cron.
>
> Vale enquanto a dívida D-COBRANCA-LIVE estiver aberta, com qualquer dado no ambiente, chamado de "teste" ou não; a reabertura técnica da promoção não libera este caminho. Para sair do bloqueio é preciso o fechamento formal da dívida, a entrega própria de abertura da L2, R3 PASS imediatamente antes e autorização própria de Felipe para cada ativação. Com a dívida aberta, cada deploy, env, E9, E10 ou promoção seletiva ordinários em production exige R3 PASS antes da mudança; a única exceção é a recuperação contida (RC, §9.2.5).
>
> As garantias não são iguais em toda entrada. L1 (configuração) só recusa nos pontos que leem a variável. L2 é a trava em código da B-25: onde o artefato a contiver, recusa nas entradas guardadas e fica fechada em production até a entrega própria de abertura. Shell, SQL, painel do provedor e gestão de serviço ou variável são controle operacional (C2), sem recusa técnica. Caminhos C3 dependem do estado do domínio e, conforme a entrada, são sustentados pela matriz da promoção e pela L1. Flag desligada não prova recusa onde ela não é lida.
>
> Referência: [plano de promoção, rodada 34, §9.2.6](PLANO_PROMOCAO_PRODUCTION_20261025.md#926-d-cobranca-live-gate-de-ativação); o plano é local e ainda não está versionado neste repositório. Esta nota não autoriza nada, não afirma estado atual de serviço ou variável e, nos passos de production sujeitos à dívida, prevalece sobre o texto abaixo. Não trata de staging nem de sandbox.

**Status: IMPLEMENTADO SÓ LOCALMENTE. Nada publicado.** Sem commit, push, PR ou deploy. A migration 087 está preparada e
não foi aplicada em staging nem em produção. Só a suíte PG a aplicou e desfez num cluster descartável, já removido. Nenhuma variável de ambiente foi alterada. Nenhum e-mail real
foi enviado.

Clone `kidmais-manager-emails-cobranca-20261019`, branch `codex/emails-cobranca-20261019`, base `staging` `73618a2`.

**02/11/2026 — reaplicado sobre `production` `7329cbfe`** no clone `kidmais-manager-recorte-cobranca-production-20261102` (recorte mínimo para cobrar), com aplicador manual e blocos de Shell da 087 derivados dos da 089. Ver `docs/RECORTE_COBRANCA_PRODUCTION_20261102.md`. Continua sem commit e sem publicação. **Rodada 2 (03/11/2026):** o P2-1 da revisão de 20/10 foi fechado — `PAGAMENTO_PENDENTE` só vale a partir do dia seguinte ao vencimento (Brasília) e o texto manda não pagar de novo; o job ganhou os modos `APLICAR_STAGING`/`APLICAR_PRODUCAO` (só no Render, alvo exato, Resend, trava, `KIDMAIS_AVISOS_MODO=aplicar`, `KIDMAIS_AVISOS_SCHEMA_VALIDADO=087`) e um YAML revisável de cron a cada 12 h (`infra/render-assinatura-avisos-cron-production.yaml`), o que fecha o P3-1 (retentativa dentro das 23 h). As tabelas de avisos abaixo continuam válidas, exceto a linha de `PAGAMENTO_PENDENTE`: "entrada na regularização" passa a "a partir do dia seguinte à entrada na regularização (Brasília)".

## Problema

O cliente Asaas é criado com `notificationDisabled: true` e sem e-mail ou telefone (`lib/assinatura/asaas.ts`). O
Kidmais também não mandava nenhum e-mail de cobrança. Assim, fim do teste, pagamento pendente, somente leitura,
suspensão e cancelamento só eram vistos por quem entrasse no Admin (`components/admin/AvisoComercial.tsx`). O resultado
era churn silencioso.

**Decisão D1 de Felipe (19/10): e-mails próprios em vez de religar o Asaas.** Religar o Asaas exigiria enviar o e-mail
da Gestão ao provedor e custaria R$ 0,99 por notificação. Mesmo assim, ele só cobre eventos de cobrança, e não o teste,
a leitura, a suspensão nem o cancelamento.

## Avisos

| Tipo | Quando | Origem |
|---|---|---|
| `TESTE_FIM_3_DIAS` | TESTE, faltam 1–3 dias (Brasília) para o último dia | job diário |
| `TESTE_FIM_HOJE` | último dia do teste | job diário |
| `PAGAMENTO_PENDENTE` | entrada na regularização (período vencido sem renovação ou EM_ATRASO) | job diário |
| `SOMENTE_LEITURA` | entrada em somente leitura (texto por motivo: teste, pagamento, cancelada, encerrada) | job diário |
| `SUSPENSAO_EM_7_DIAS` | faltam ≤ 7 dias para o bloqueio (só se a leitura dura > 7 dias) — D2 | job diário |
| `SUSPENSO` | entrada em BLOQUEADO | job diário |
| `PAGAMENTO_CONFIRMADO` | transição gravada para ATIVA com período pago maior | `sincronizarEmpresa` |
| `CANCELAMENTO_CONFIRMADO` | transição gravada para CANCELADA_FIM_PERIODO ou ENCERRADA | `sincronizarEmpresa` |

Regras gerais:

- **Destinatários (D4):** todas as pessoas ativas da Gestão (`REPRESENTANTE_AUTORIZADO`, membership ATIVA, usuário ativo),
  no máximo 5. Cada pessoa recebe um e-mail próprio.
- **Sem aviso:** empresa sem assinatura, isenta (Kidmais), empresa não ATIVA ou com exceção comercial vigente.
- **Janela dos avisos por tempo:** só valem se o marco começou há no máximo 2 dias. Assim, o primeiro deploy não manda
  e-mail para quem já está há semanas em leitura, e um dia sem job ainda fica coberto.
- **Textos:** pt-BR, com links para `/admin/assinatura` e `/admin/ajuda` (`ROTA_AJUDA`). Não incluem valores, documento
  nem dados do provedor.

## Idempotência (um e-mail por evento por pessoa)

- O marco é o instante que define o evento: fim do teste, início da regularização ou da leitura, fim da leitura, novo fim
  do período ou cancelamento.
- A 087 tem `UNIQUE (empresa_id, tipo, marco, destinatario_id)` e o INSERT usa `ON CONFLICT DO NOTHING`. Isso cobre:
  - reentrega do webhook;
  - reconciliação repetida;
  - job rodando duas vezes.
- A transição só é gravada uma vez (`mudou`), então reprocessar não gera nova intenção.
- O envio segue o padrão do aviso Fundador:
  - a mensagem é imutável e a chave `kidmais-aviso-assinatura/<id>` é sempre a mesma;
  - `ENVIANDO` é gravado antes da rede, e o envio só é repetido dentro de 23 h (retenção da chave no Resend);
  - depois disso o aviso fica `INCERTO`, sem nova tentativa;
  - antes do 1º envio o aviso é revalidado: se já pagou, saiu da Gestão ou o teste foi estendido, fica `DESCARTADO`.
- Bounce, reclamação ou falha informada pelo Resend: `ENVIADO → DEVOLVIDO` (`renovacao-entrega.ts`; a renovação tem
  prioridade).

## Isolamento da cobrança

- `registrarAvisosDaTransicao` roda dentro de `SAVEPOINT` na transação de `sincronizarEmpresa` e engole qualquer erro.
  **Falha de aviso nunca desfaz nem bloqueia a sincronização.** Ali só se grava a intenção, sem chamada de rede.
- O envio acontece depois do commit:
  - `processarEventoAgendado` (`after` do webhook) envia os pendentes da empresa do evento;
  - o job diário é a rede de segurança.
- **Trava de ativação:** `ASSINATURA_AVISOS_EMAIL=ligado`. Sem ela não há nenhuma consulta nem gravação, e o
  comportamento fica idêntico ao de hoje. O web também exige e-mail configurado (`situacaoEmail`).

## Arquivos

- `database/migrations/20261019_087_assinatura_avisos.sql`, mais o precheck e o postcheck em `database/checks` e o
  rollback em `database/rollback`. O número 087 foi conferido livre em todos os branches remotos e nos 143 clones irmãos
  em 20/10.
- `lib/assinatura/avisos.ts`: regras puras (marcos, transições, obsolescência).
- `lib/assinatura/avisos-mensagens.ts`: textos.
- `lib/assinatura/avisos-envio.ts`: enfileirar, revalidar e enviar.
- `lib/assinatura/avisos-repositorio.ts`: SQL, gancho da transição e devolução.
- `lib/assinatura/avisos-padrao.ts`: dependências reais no web.
- Ganchos em `sincronizacao.ts`, `cobranca-padrao.ts` e `renovacao-entrega.ts`.
- `scripts/assinatura-avisos.cjs`, o job:
  - roda em simulação por padrão;
  - `--aplicar` exige, nesta entrega, banco local, `EMAIL_PROVIDER=arquivo` e a trava ligada;
  - o alvo é explícito, como na reconciliação.

## Testes

- Unitários com fakes: `avisos.test.ts`, `avisos-mensagens.test.ts`, `avisos-envio.test.ts`,
  `avisos-repositorio.test.ts`, `migration-087.test.ts` e `scripts/assinatura-avisos.test.cjs`.
- `lib/assinatura/avisos-087.postgres.test.ts`, declarada no modelo 086: EXECUTADA em 20/10/2026, com autorização de Felipe, num cluster descartável novo (`127.0.0.1:55611`, modelo 086 recriado do schema vazio): **PASS 1/1** em 13 s, nada pulado. A suíte passou por precheck, aplicação, postcheck, reaplicação recusada, fila idempotente, guarda, gancho isolado, devolução e rollback. O cluster foi parado (o checkpoint final levou 142 s) e removido. Os relatórios ficaram em `ambientes-locais/pg-descartavel-emails-cobranca-20261020-relatorios`. A 087 continua sem aplicação em staging e em produção.

## Limitações conhecidas

- O fim de uma exceção comercial não é gravado. Quem sai da exceção direto para uma leitura antiga só recebe
  `SUSPENSAO_EM_7_DIAS`.
- Agendar o job, ligar a trava, configurar o Resend no ambiente e aplicar a 087 são passos futuros, cada um com
  autorização própria.
- O painel do desenvolvedor ainda não mostra avisos `INCERTO` ou `DEVOLVIDO`. Por ora, aparecem só no relatório do job
  (saída 2).

## Ativação (futura, cada passo com autorização de Felipe)

1. Revisão independente (a suíte PG já passou em 20/10).
2. PR para staging.
3. Aplicar a 087 em staging, com precheck, postcheck e backup.
4. Fazer deploy.
5. Ligar `ASSINATURA_AVISOS_EMAIL` e configurar o e-mail em staging.
6. Criar o cron do job: primeiro em simulação, depois com envio. Antes, liberar o `--aplicar` remoto no script, que hoje
   o recusa.
7. Homologar e só então promover para produção.

> **Bloqueio em production (B-27, 07/11/2026).** Promover o código não ativa os avisos: em production, ligar a flag, criar substituto ou rodar o cron seguem bloqueados. Vale enquanto a dívida D-COBRANCA-LIVE estiver aberta, com qualquer dado no ambiente. As condições de saída e a regra do R3 para mudanças ordinárias estão na nota completa da B-27 neste documento. Esta nota não autoriza nada, prevalece sobre o trecho abaixo em production e não trata de staging nem de sandbox.

**Rollback:**

- Desligar `ASSINATURA_AVISOS_EMAIL`. Isso basta: o código volta a não fazer nada.
- O down da 087 só funciona sem histórico.
