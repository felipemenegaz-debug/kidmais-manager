# Validação da migration 060 e homologação do Gupshup

Preparado em 01/10/2026. Registro histórico das rodadas de 02/10/2026; o estado consolidado e as evidências por commit estão em [HANDOFF_CLAUDE_UX_WHATSAPP.md](HANDOFF_CLAUDE_UX_WHATSAPP.md). A **Parte 1 foi executada em 02/10/2026** no cluster descartável autorizado (resultado abaixo). As Partes 2 e 3 não incluem nenhuma operação remota executada. Cada passo remoto aguarda a aprovação explícita do Felipe para o destino e a ação, conforme [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md). Estado da candidata: [HANDOFF_CLAUDE_UX_WHATSAPP.md](HANDOFF_CLAUDE_UX_WHATSAPP.md).

## Resultado da Parte 1 (02/10/2026)

Autorização do Felipe: O1–O4 somente em 127.0.0.1:55498, `cluster_name = kidmais_descartavel`, diretório `C:\Users\Glass\AppData\Local\Temp\kidmais-pg-060\data`, bancos sintéticos da receita. Relatórios em `.local-ux/pg-060/` (fora do Git).

| Etapa | Resultado |
| --- | --- |
| Pré-condições | Diretório inexistente, porta 55498 livre, nenhuma variável `PG*` ou `DATABASE_URL` no ambiente |
| O1 | PostgreSQL 18.6, a mesma versão principal de staging. Identidade conferida: `kidmais_descartavel\|127.0.0.1\|55498\|kidmais_descartavel\|postgres\|0`, collate C, 60 conexões (`identidade-o1.txt`) |
| O2 `check:v1:postgres` (Node 22.23.2) | **29 de 30 suítes OK, incluindo a nova `migration-060.postgres.test.ts`**, que passou com todos os passos. A falha intermitente foi em `lib/financeiro/financeiro.postgres.test.ts`, investigada e corrigida na segunda rodada (`check-v1-postgres.log`) |
| O3 ensaio | **OK.** Exportação, down sem descarte recusado, down com descarte, pós-rollback, restauração no mesmo banco e em `kidmais_pacotes_v1_rollback`. As assinaturas (contagem e md5 por tabela) ficaram idênticas nas três leituras (`ensaio-restauracao.log`, `assinatura-*.txt`) |
| O4 | Diretório confirmado pelo `data_directory` e pelo `cluster_name` antes de parar; servidor parado; **somente** `...\kidmais-pg-060\data` removido (a pasta-mãe, vazia, ficou). A porta 5432 local nunca foi acessada |

**Achado da primeira rodada:** `whatsapp_atendimento_mensagens` tem chave estrangeira para si mesma (`origem_id`). Por isso, a restauração *somente de dados* precisa de `pg_restore --disable-triggers`, que exige superusuário. A variante sem superusuário foi validada na segunda rodada (abaixo).

### Segunda rodada (02/10/2026): financeiro e recuperação sem superusuário

Autorização do Felipe: repetir O1–O4 no mesmo destino e criar um usuário restrito só nesse cluster. Mesmas verificações de identidade, comandos com destino explícito e dados sintéticos. Scripts `o1.sh` e `o4.sh` em `.local-ux/pg-060/`.

**1. `financeiro.postgres.test.ts`: causa e um defeito real encontrado**

*Causa da falha intermitente.* No bloco de concorrência original:
- conta e primeiro pagamento eram criados na transação **não confirmada** de `db`;
- a segunda conexão não via a conta e recebia `NAO_ENCONTRADO` na hora;
- essa rejeição chegava às vezes antes de `db` concluir o COMMIT, ainda sem tratamento, e saía como `unhandledRejection`;
- o teste ainda aceitava qualquer `PacoteAdminError`.

O teste nunca exercitava concorrência.

Comparação com a base `4a0c966`, com a árvore exportada por `git archive` e o teste original:
- `check:v1:postgres` com 29/29 OK;
- teste original 10/10 OK (`financeiro-base-original-10x.txt`).

A falha não é determinística, e o código e o teste são idênticos aos da base. Portanto não foi introduzida pela candidata: é uma corrida do próprio teste.

*Teste corrigido.* A versão corrigida:
- confirma a conta antes e prova que ela é visível às duas conexões;
- registra o tratamento da rejeição no instante em que a operação concorrente começa;
- prova a espera real pela trava (`pg_locks` com `granted = false` para o pid da segunda conexão);
- exige o erro específico (`VALOR_EXCEDE_SALDO`, 409; e `EM_USO` para cancelar e editar);
- confere que só a primeira baixa ficou.

*Defeito real no código, já presente na base.* Com o teste corrigido, o código atual **aceitou** a segunda baixa: R$ 60 + R$ 50 numa conta de R$ 100, em 5 de 5 rodadas (`financeiro-teste-corrigido-codigo-atual-5x.txt`).
- Causa: `pagarConta`, `cancelarConta` e `editarContaPagar` calculavam o total pago num `SUM` dentro do mesmo `SELECT ... FOR UPDATE`. Em READ COMMITTED, esse `SUM` usa o retrato tirado antes de esperar a trava.
- Consequências: pagamento além do valor da conta, cancelamento de conta paga e edição de conta paga.
- O mesmo padrão não aparece em `lib/pagamentos`.
- Correção mínima: o helper `travarConta` trava a conta e soma os pagamentos em outro comando, usado pelas três funções.
- Provas de que a regressão pega o defeito, numa cópia da base:
  - só `cancelarConta` antiga: falha 3/3 (`financeiro-prova-cancelar-editar-antigos-3x.txt`);
  - só `editarContaPagar` antiga: falha 3/3 (`financeiro-prova-editar-antigo-3x.txt`).
- Com a correção: 10/10 (`financeiro-corrigido-10x.txt`).
- **Este defeito está no código de staging (e de produção, se a 052 foi publicada)** e deve entrar numa entrega própria do financeiro.

**2. Recuperação da 060 com usuário restrito, estrutura + dados, sem `--disable-triggers`** (`ensaio-recuperacao-restrito.sh`, `.log`)

- **Usuário:** `kidmais_060_app`, sintético, com LOGIN, sem superusuário, CREATEDB, CREATEROLE ou BYPASSRLS. Senha nenhuma: o acesso `trust` vale só em 127.0.0.1 e só para os dois bancos de trabalho.
- **Concessões mínimas,** dadas pelo superusuário descartável:
  - CONNECT;
  - USAGE e CREATE no schema;
  - REFERENCES em `empresas` e `usuarios_administrativos`. Sem SELECT em usuários e sem escrita no Core.
- **Roteiro, todo executado pelo usuário restrito:**
  1. Aplicar a 060 e o postcheck e gravar o atendimento sintético.
  2. `pg_dump -h 127.0.0.1 -p 55498 -U kidmais_060_app -d kidmais_pacotes_v1_descartavel -Fc -t 'whatsapp_atendimento_*'`, sem o aviso de chave circular.
  3. Precheck, down sem descarte (recusado), down com descarte e pós-rollback.
  4. `pg_restore -h 127.0.0.1 -p 55498 -U kidmais_060_app -d <banco> --single-transaction --exit-on-error`, sem `--disable-triggers`, no mesmo banco e em `kidmais_pacotes_v1_rollback`. Em ambos, a 060 **não** foi reaplicada antes: a estrutura vem da exportação.
- **Depois de cada restauração** (`verificar-recuperacao.sql`, `esquema-060.sql`):
  - postcheck OK;
  - dados idênticos (contagem e md5 por tabela);
  - estrutura idêntica: dono, ACL, restrições e índices;
  - 10 chaves estrangeiras validadas e zero órfãos por consulta;
  - mensagem e auditoria cruzadas entre empresas recusadas pela chave composta;
  - segunda resposta à mesma entrada recusada;
  - usuário sem privilégio elevado, dono só das tabelas da 060, sem escrita no Core nem leitura de usuários.
- **Para staging e produção:** o usuário que restaura precisa ser dono das tabelas da 060 e ter REFERENCES nas tabelas do Core referenciadas, como o usuário da aplicação que aplica as migrations.

**Gates finais nesta árvore:**
- `check:v1:postgres` **30/30** (`check-v1-postgres-final.log`);
- `check:v1:static` com 1.700 testes unitários e 103 do harness, lint (só o warning preexistente), TypeScript e build;
- `production:test` 37/37;
- `git diff --check` limpo.

**Encerramento:** O4 com identidade conferida; servidor parado; somente o diretório `data` removido; porta 55498 livre. A cópia temporária da base foi removida depois de desfazer a junção de `node_modules`, sem seguir o link, e o `node_modules` do checkout ficou intacto.

## Parte 1 — PostgreSQL novo e descartável

### Destino exato (proposto, ainda não criado)

| Item | Valor |
| --- | --- |
| Binários | `C:\Program Files\PostgreSQL\18\bin` (`initdb`, `pg_ctl`, `pg_dump`, `pg_restore`, `psql`): a mesma versão principal do PostgreSQL de staging (18, conforme os metadados do Render) |
| Diretório de dados | `C:\Users\Glass\AppData\Local\Temp\kidmais-pg-060\data` (novo e vazio; criado só por esta validação) |
| Endereço | `127.0.0.1` apenas (`listen_addresses = '127.0.0.1'`) |
| Porta | `55498` (padrão do harness; hoje livre). **A porta 5432 desta máquina já tem um PostgreSQL em execução e está excluída**: pode conter o banco real `kidmais_manager`. |
| Identidade | `cluster_name = 'kidmais_descartavel'`, superusuário `kidmais_descartavel`, `pg_hba.conf` só `host all kidmais_descartavel 127.0.0.1/32 trust` |
| Parâmetros | `initdb --locale=C --encoding=UTF8`, `max_connections = 60`, `datestyle = 'ISO, MDY'` (com locale do Windows, quatro suítes de concorrência dão timeout sem defeito real) |
| Bancos | Só os gerenciados pela receita: modelos `kidmais_v1_modelo_*` e bancos de trabalho `kidmais_pacotes_v1_descartavel` e `kidmais_pacotes_v1_rollback` |
| Dados | Exclusivamente sintéticos, criados pelas suítes (`@example.test`, números `55619…`). Nenhum dump, backup ou clone de banco real. |

Salvaguardas que já existem no código e são verificadas antes de qualquer escrita (`scripts/regressao-v1-postgres-receita.cjs`):
- o servidor precisa responder `cluster_name = kidmais_descartavel`, no endereço e porta esperados;
- o cluster não pode conter `kidmais_manager`;
- `DATABASE_URL` e `PG*` são removidos do ambiente das suítes;
- só os bancos da lista são criados ou removidos.

Staging e production nunca são destino.

### Operações que pedem aprovação

| # | Operação | Efeito | Recuperação |
| --- | --- | --- | --- |
| O1 | `initdb` + configuração + `pg_ctl start` no diretório acima | Cria um cluster local vazio; nenhum banco existente é tocado | `pg_ctl stop` e apagar o diretório |
| O2 | `KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel npm run check:v1:postgres` (Node 22.23.2) | A receita aplica 001→057 nos modelos e roda todas as suítes `*.postgres.test.ts`, incluindo a nova da 060, com rollback de cada uma | Bancos recriados do modelo a cada suíte |
| O3 | Ensaio de exportação e restauração (abaixo) em `kidmais_pacotes_v1_descartavel` e `kidmais_pacotes_v1_rollback` | Aplica a 060, grava dados sintéticos, exporta, executa o down e restaura | Recriar os bancos pela receita |
| O4 | `pg_ctl stop` e remoção do diretório de dados | Encerra o ensaio | — |

### Cobertura da suíte `lib/whatsapp/atendimento/migration-060.postgres.test.ts`

A suíte roda no `check:v1:postgres` (execuções e commits em [HANDOFF_CLAUDE_UX_WHATSAPP.md](HANDOFF_CLAUDE_UX_WHATSAPP.md); a última, em `a55aed8`, cobre também os passos 8b–8f: modelo indisponível, ordem, limite, entrada atrasada e resposta publicada revogada). Ela usa o serviço e o worker reais, com uma conexão por transação para que a concorrência seja real. O modelo e o Gupshup são simulados.

| Pedido | Passo da suíte |
| --- | --- |
| Criação e aplicação | Começa sem a 060; up + postcheck; reaplicação recusada pela pré-condição inline |
| Isolamento entre empresas | Usuário só da empresa B recusado pelo tenant (`provarTenant`); mensagem e auditoria com empresa ou ambiente trocados recusadas pela chave composta; listagem só da empresa piloto |
| Deduplicação | O mesmo evento entregue três vezes em paralelo grava uma entrada |
| Concorrência entre workers | Dois lotes em paralelo sobre seis conversas: cada conversa recebe uma resposta, nenhuma duplicada, nenhuma tarefa ativa sobrando; rajada na mesma conversa gera uma única resposta |
| Tomada humana | Atendente assume enquanto o modelo interpreta: a resposta automática é cancelada e nada é enviado |
| PARAR | Conversa encerrada com bloqueio; assumir é recusado; nova mensagem não reabre |
| Janela de atendimento | Envio humano recusado depois de 24 h; mensagem humana já na fila é cancelada sem chamar o provedor |
| Status antes do retorno do envio | O status "entregue" chega durante o envio; a mensagem termina ENTREGUE e a linha de status é apagada |
| Retenção de status | Status sem correspondência de 25 h é apagado; o recente fica |
| Interrupção | PROCESSANDO/ENVIANDO com mais de 10 min viram FALHOU/INCERTO, a conversa vai para a equipe, nada é reenviado |
| Rollback | Precheck; down recusado com envio em andamento mesmo com descarte; down recusado com dados sem descarte; down com descarte; pós-rollback; Core fora da fixture intacto |

### Comandos (todos com destino explícito)

Nenhum comando depende de configuração herdada:
- toda chamada de `psql`, `pg_dump` e `pg_restore` passa `-h 127.0.0.1 -p 55498 -U kidmais_descartavel -d <banco>`;
- `initdb` e `pg_ctl` recebem `-D <diretório>`;
- tudo roda sob `env -u PGHOST -u PGHOSTADDR -u PGPORT -u PGUSER -u PGDATABASE -u PGPASSWORD -u PGPASSFILE -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS -u PGSSLMODE -u DATABASE_URL`;
- os binários ficam em `C:\Program Files\PostgreSQL\18\bin`. O PostgreSQL de staging é 18, conforme os metadados lidos no Render em 02/10/2026.

**Antes de O1, parar sem sobrescrever** se o diretório `C:\Users\Glass\AppData\Local\Temp\kidmais-pg-060\data` existir ou se a porta 55498 estiver ocupada.

**O1:**
1. `initdb -D C:\Users\Glass\AppData\Local\Temp\kidmais-pg-060\data -U kidmais_descartavel --auth=trust --locale=C --encoding=UTF8`.
2. Em `postgresql.conf`: `listen_addresses = '127.0.0.1'`, `port = 55498`, `cluster_name = 'kidmais_descartavel'`, `max_connections = 60` e `datestyle = 'iso, mdy'`.
3. `pg_hba.conf` só com `host all kidmais_descartavel 127.0.0.1/32 trust`.
4. `pg_ctl -D C:\Users\Glass\AppData\Local\Temp\kidmais-pg-060\data -l .local-ux\pg-060\server.log -w start`.

**Identidade antes de cada escrita:** `psql -h 127.0.0.1 -p 55498 -U kidmais_descartavel -d <banco> -X -At -c "SELECT current_setting('cluster_name')||'|'||host(inet_server_addr())||'|'||inet_server_port()||'|'||current_user||'|'||current_database()||'|'||(SELECT count(*) FROM pg_database WHERE lower(datname)='kidmais_manager')"` deve devolver exatamente `kidmais_descartavel|127.0.0.1|55498|kidmais_descartavel|<banco>|0`. Qualquer divergência interrompe.

**O2:** `KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel node scripts/regressao-v1-postgres.cjs`, com Node 22.23.2. A receita repete a prova de identidade antes de criar os modelos.

### Ensaio de restauração (O3)

O rollback de código e de flags não apaga dados, e o down só roda depois de exportar as tabelas. O ensaio prova que a exportação basta para voltar.

- **Script:** `.local-ux/pg-060/ensaio-restauracao.sh`.
- **Fixtures sintéticas:** `fixture-core.sql` e `fixture-atendimento.sql`.
- **Assinatura:** `assinatura.sql`, com contagem e `md5` ordenado por tabela.

1. **S0 — Identidade.** No banco de administração `postgres`. O modelo `kidmais_v1_modelo_atual` precisa existir (criado em O2).
2. **S1 — Bancos de trabalho.** Recriar `kidmais_pacotes_v1_descartavel` e `kidmais_pacotes_v1_rollback` a partir do modelo:
   - `psql -h 127.0.0.1 -p 55498 -U kidmais_descartavel -d postgres -c "DROP DATABASE IF EXISTS <banco>"`;
   - `psql -h 127.0.0.1 -p 55498 -U kidmais_descartavel -d postgres -c "CREATE DATABASE <banco> TEMPLATE kidmais_v1_modelo_atual"`.
3. **S2 — Origem.** Em `-d kidmais_pacotes_v1_descartavel`: fixture de Core, 060, postcheck, fixture de atendimento e assinatura "antes".
4. **S3 — Exportação.** `pg_dump -h 127.0.0.1 -p 55498 -U kidmais_descartavel -d kidmais_pacotes_v1_descartavel -Fc --data-only -t 'whatsapp_atendimento_*' -f .local-ux/pg-060/060-dados.dump`.
5. **S4 — Rollback.**
   1. Rollback precheck.
   2. Down sem descarte, que **precisa ser recusado**.
   3. Down com `SET LOCAL kidmais.rollback_060_descartar_atendimento = 'sim'` na mesma transação.
   4. Pós-rollback.
6. **S5 — Restauração na origem.**
   1. Reaplicar a 060 com o postcheck.
   2. `pg_restore -h 127.0.0.1 -p 55498 -U kidmais_descartavel -d kidmais_pacotes_v1_descartavel --data-only --disable-triggers --single-transaction --exit-on-error .local-ux/pg-060/060-dados.dump`.
   3. Postcheck e assinatura idêntica à de S2.
7. **S6 — Restauração no outro banco.**
   1. Fixture de Core e 060.
   2. `pg_restore -h 127.0.0.1 -p 55498 -U kidmais_descartavel -d kidmais_pacotes_v1_rollback --data-only --disable-triggers --single-transaction --exit-on-error .local-ux/pg-060/060-dados.dump`.
   3. Postcheck e assinatura idêntica à de S2.

**O4:** `pg_ctl -D C:\Users\Glass\AppData\Local\Temp\kidmais-pg-060\data -m fast -w stop`. Em seguida, remover **somente** esse diretório, depois de confirmar o caminho exato. Os relatórios ficam em `.local-ux/pg-060/`.

### Critérios de aceite

- `check:v1:postgres` verde, com as suítes existentes e a nova.
- O ensaio de restauração tem contagens e `md5` idênticos.
- Nenhuma conexão foi aberta fora de 127.0.0.1:55498, e o diretório foi removido no fim (O4).

## Parte 2 — Status sem correspondência e vazão

### Retenção (resolvida no código)

- O webhook grava todo status `delivered`, `read` ou `failed` do app, porque ele pode chegar antes do retorno do envio.
- Se já existe mensagem com o mesmo identificador, o estado é aplicado e a linha é apagada na mesma transação (`correlacionarStatus`). O worker faz a mesma coisa logo depois de receber o identificador do envio.
- O que sobra não tem correspondência: OTP e outros fluxos do mesmo app, ou um envio que terminou INCERTO e nunca recebeu identificador. Essas linhas expiram em 24 h (`RETENCAO_STATUS_HORAS`).
- O worker apaga em lotes de 1.000 a cada chamada (`limparStatusExpirados`), filtrando pela empresa e pelo ambiente do piloto.
- A linha só guarda identificador do provedor, estado e horário. Não guarda telefone nem conteúdo.
- O prazo cobre com folga a corrida entre status e retorno do envio (segundos) e mantém a tabela pequena mesmo com OTP no mesmo app.

### Vazão: chamadas não são respostas

- Uma resposta automática custa duas tarefas: interpretar a entrada (modelo, até 15 s) e enviar a saída (Gupshup, até 10 s).
- Antes, o processador fazia uma tarefa por chamada, com 3 s entre chamadas. Eram 20 chamadas por minuto, mas **no máximo 10 respostas por minuto, e menos com a latência do modelo**.
- Agora cada chamada processa um lote (`processarLote`) de até 20 tarefas ou 30 s. O prazo fica abaixo do timeout de 60 s do worker, mesmo com a pior tarefa.
- O lote continua depois de cancelar uma mensagem obsoleta. O worker chama de novo sem esperar quando o lote termina por limite.
- Com um worker, a vazão passa a depender da latência real. Com cerca de 2 s de modelo e 0,5 s de envio, são aproximadamente 2,5 s por resposta, ou cerca de 20 respostas por minuto.
- Esse número é estimativa e precisa ser medido na homologação (passo H8).
- Para mais vazão, rodar mais de um worker: a reserva com `SKIP LOCKED` e a regra de uma tarefa ativa por conversa mantêm a ordem por conversa. A suíte da 060 cobre dois workers em paralelo.

## Parte 3 — Homologação do Gupshup em staging

**Objetivo:** provar o fluxo real com o número comercial da Kidmais. Só destinatários de teste explicitamente autorizados participam. Nenhuma mensagem pode ir a cliente real.

> **Atualizado em 02/10/2026:** o plano concreto de ativação (etapas E0–E8 com alvo, efeito, validação e recuperação), o que a documentação oficial do Gupshup confirma e o receptor único (`WHATSAPP_ATENDIMENTO_RECEPTOR`) estão em [WHATSAPP_ATIVACAO_STAGING.md](WHATSAPP_ATIVACAO_STAGING.md). A tabela A1–A6 abaixo continua valendo; A4 ganha `WHATSAPP_ATENDIMENTO_RECEPTOR=staging` e A5 passa a ser **acrescentar** uma assinatura com cabeçalho pela Partner API, sem trocar as existentes.

### Proteção contra clientes reais (implementada)

`WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS` recebe números com DDI, só dígitos, separados por vírgula.

- **Em staging a lista é obrigatória.** Sem ela, nenhuma entrada é gravada e nenhum envio sai (fail-closed).
- Mensagem de contato fora da lista é confirmada ao Gupshup sem gravar nada. O dado do cliente real não entra no banco de homologação.
- O worker cancela antes do provedor qualquer envio para fora da lista.
- Em produção a lista é opcional e serve para ativação gradual.
- Testes: `core.test.ts`, `service.test.ts`, `worker.test.ts`.

### Autorizações necessárias, cada uma explícita

| # | Ação | Alvo |
| --- | --- | --- |
| A1 | Destinatário de teste: número e titular que consentiram em receber mensagens | Felipe informa no chat |
| A2 | Backup do banco de staging e aplicação da 060 (precheck inline, postcheck), depois de a Parte 1 passar | Banco do `kidmais-manager-staging` |
| A3 | Commit, PR, CI e merge em `staging`; deploy manual | `srv-daif418ae00c73e8k2gg` |
| A4 | Variáveis de staging. Conferir só presença e formato, sem imprimir valores: `KIDMAIS_DEPLOY_ENV=staging`, `WHATSAPP_ATENDIMENTO_EMPRESA_ID`, `WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS` (só A1), `WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED`, `WHATSAPP_ATENDIMENTO_ENABLED`, `WHATSAPP_ATENDIMENTO_WORKER_SECRET` (exclusivo de staging), `WHATSAPP_ATENDIMENTO_WORKER_URL`, e orçamento da capacidade `whatsapp_atendimento` | Serviço de staging; a alteração de env provoca deploy |
| A5 | Receptor único: confirmar no painel do Gupshup qual URL de callback o app `KidmaisManager` usa hoje e decidir se staging recebe durante a janela de teste. Produção não pode automatizar o mesmo número ao mesmo tempo | Painel Gupshup (Felipe) |
| A6 | Worker: onde roda (processo temporário apontando para staging, ou serviço no Render) e por quanto tempo | Infraestrutura de staging |

### Roteiro

Cada passo usa só o número de teste (A1) e registra trace e estado, sem conteúdo nem telefone em log.

- **H1 — Configuração desligada.** Flags desligadas: o webhook só registra metadados e a tela mostra o piloto desligado.
- **H2 — Recepção.** Com `RECEIVE_ENABLED`:
  - uma mensagem do número de teste cria conversa "Aguardando atendente";
  - uma mensagem de um segundo número **não autorizado**, do próprio Felipe, não grava nada;
  - um evento reenviado (retry do Gupshup) não duplica.
- **H3 — Resposta automática.** Com `ENABLED` e a configuração da empresa ligada, responder a uma pergunta publicada. Conferir o status `SUBMETIDA → ENTREGUE` e a correlação mesmo com o status chegando antes do retorno.
- **H4 — Qualificação.** Data completa, data passada, data inexistente e convidados. A resposta final diz "a data ainda não está reservada". Nenhuma festa, reserva, contrato ou pagamento é criado.
- **H5 — Tomada humana.** Assumir durante a geração (sem resposta automática) e responder pela tela. Retomar a IA e encerrar; nova mensagem reabre.
- **H6 — PARAR.** Nada mais é enviado e a tela bloqueia as ações.
- **H7 — Mídia.** Uma imagem vai para a equipe sem chamar o modelo.
- **H8 — Vazão.** Rajada de 10 mensagens do número de teste. Medir o tempo até cada resposta e confirmar uma resposta por rajada por conversa.
- **H9 — Falhas, sem forçar por configuração de produção:**
  - teto de orçamento da capacidade em staging (valor baixo autorizado) encaminha para a equipe;
  - worker parado por mais de 10 min leva a conversa para a equipe, sem reenvio;
  - timeout de transporte só por teste local; não forçar no Gupshup real.
- **H10 — Janela de 24 h.** Pelo teste PostgreSQL; ao vivo, só se houver tempo para esperar a expiração real.
- **H11 — Encerramento.** Desligar `ENABLED` e `RECEIVE_ENABLED`, parar o worker e esvaziar a lista de permitidos. Devolver o callback ao receptor anterior, se mudou (A5). O histórico fica.

**Critério de interrupção imediata:** qualquer envio a um número fora da lista, mensagem de cliente real gravada, resposta com preço ou condição que não esteja nas respostas publicadas, ou erro de isolamento. Nesse caso, desligar as flags, parar o worker e registrar.

## Parte 4 — Validação PostgreSQL integrada (060 com 061/062) — preparada, NÃO executada

Preparada em 04/10/2026, depois da integração local de `origin/staging` (`35a2bd9`, 061/062) na branch. **Precisa de autorização explícita do Felipe para O1–O4 neste alvo** antes de qualquer comando. As execuções anteriores (rodadas de 02/10, até `a55aed8`) foram feitas na base antiga, sem 061/062.

**Objetivo:** provar no PostgreSQL que a candidata integrada passa a suíte inteira.
- A 060 continua íntegra no estado `atual`: aplicação, isolamento, fila, revogação e rollback.
- Os modelos `061` e `062` são montados com o inventário inteiro, que agora inclui a 060, e as suítes que também rodam nesses estados passam com a 060 presente.

### Alvo (o mesmo das rodadas anteriores)

| Item | Valor |
| --- | --- |
| Binários | `C:\Program Files\PostgreSQL\18\bin` |
| Diretório de dados | `C:\Users\Glass\AppData\Local\Temp\kidmais-pg-060\data`. Precisa **não existir** antes de O1 |
| Endereço e porta | `127.0.0.1:55498`, só loopback. A porta 5432 local (pode ter o banco real `kidmais_manager`) nunca é usada |
| Identidade exigida | `cluster_name = kidmais_descartavel`, superusuário `kidmais_descartavel`, locale C, 60 conexões, nenhum banco `kidmais_manager` |
| Bancos criados pela receita | Modelos `kidmais_v1_modelo_{atual,053,052,039,042_sem_040,045_sem_040,061,062}` e de trabalho `kidmais_pacotes_v1_descartavel` e `kidmais_pacotes_v1_rollback` |
| Dados | Exclusivamente sintéticos, criados pelas suítes |

**Conflito de porta a evitar:** `staging` trouxe `scripts/pg-descartavel-061.cjs`, que usa a **mesma porta 55498** com outro diretório (`D:\glass\KidMais Manager\ambientes-locais\pg-descartavel-061`). Antes de O1:
- confirmar que a porta 55498 está livre;
- confirmar que nenhum cluster daquele diretório está em execução.

Se a porta estiver ocupada, **parar** sem tocar no outro cluster. Este procedimento não usa aquele script nem aquele diretório.

### Mudança de contrato vinda de staging

O conector descartável não tem mais porta padrão. Cada suíte exige, além do opt-in:

```text
KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel
KIDMAIS_DESCARTAVEL_PORTA=55498
KIDMAIS_DESCARTAVEL_AUTORIZACAO=127.0.0.1:55498/kidmais_pacotes_v1_descartavel
```

Nenhuma variável `PG*` ou `DATABASE_URL` pode existir no processo: o runner e o conector recusam.

### Operações

Os scripts `o1.sh` e `o4.sh` ficam em `.local-ux/pg-060/`, fora do Git, e já foram usados nas rodadas anteriores.

| # | Comando | Efeito | Verificação | Parada |
| --- | --- | --- | --- | --- |
| O0 | Leituras: `netstat` na porta 55498; existência do diretório de dados; `git rev-parse HEAD` e `git status` limpo | Nenhum | Porta livre, diretório ausente, HEAD anotado | Qualquer divergência |
| O1 | `bash .local-ux/pg-060/o1.sh r8-integrada` | `initdb` (locale C, UTF8, trust só em 127.0.0.1), configuração e `pg_ctl start` | Identidade gravada em `identidade-o1-r8-integrada.txt` igual a `kidmais_descartavel\|127.0.0.1\|55498\|kidmais_descartavel\|postgres\|0\|C\|60\|<diretório>` | Identidade divergente: o script para |
| O2 | Com Node 22.23.2 e as três variáveis acima, sem `PG*` nem `DATABASE_URL`: `node scripts/regressao-v1-postgres.cjs`. Saída em `.local-ux/pg-060/check-v1-postgres-r8-integrada-<HEAD>.log` | A receita monta os modelos com o inventário oficial (agora 060, 061 e 062) e roda **32 suítes em 36 execuções** (`tenant-festa` e `estorno-completo` também nos estados 061 e 062), cada uma em banco restaurado do modelo | `PASS suíte PostgreSQL descartável: 36 arquivos`; `migration-060` OK; `tenant-festa` e `estorno-completo` OK em `[061]` e `[062]` | Qualquer falha: registrar e investigar antes de repetir. Não repetir em outro alvo |
| O3 | (Opcional, só se o Felipe pedir) repetir o ensaio de exportação/restauração da 060 com o usuário restrito (`ensaio-recuperacao-restrito.sh`) | Aplica a 060 num banco de trabalho, exporta, faz o down e restaura | Dados e estrutura idênticos, como em 02/10 | Divergência |
| O4 | `bash .local-ux/pg-060/o4.sh` | Confere identidade e diretório, faz `pg_ctl stop` e remove **somente** `...\kidmais-pg-060\data` | Porta 55498 livre; diretório ausente; a pasta-mãe fica | Identidade divergente: não remove nada |

**Duração estimada:** alguns minutos (as rodadas de 02/10 levaram cerca de 5 a 8 min para 30 execuções).

**Evidência:** o log de O2 com o HEAD no nome, a identidade de O1 e a saída de O4, todos em `.local-ux/pg-060/` (fora do Git). O registro do resultado entra no handoff, ligado ao HEAD validado.

**Recuperação:** se O2 falhar no meio, O4 ainda é seguro, porque confere a identidade antes de parar e só remove o diretório descartável. Se o servidor não parar, não remover nada e investigar. Nada fora do diretório descartável e da porta 55498 é tocado.

## Pendências mantidas fora deste ciclo

- **Nova festa:** atalho administrativo mais curto, pelos serviços oficiais de contratação, sem inserção direta.
- **Disponibilidade automática:** o canal não informa data disponível. O serviço precisa de revisão do isolamento por empresa e unidade antes de ser exposto ao canal público.
- **Etapas comerciais do quadro:** hoje o quadro mostra estados de atendimento; etapas de CRM e paginação além de 100 itens ficam para depois.
