# Validação PostgreSQL — 063 (mensagens prontas) e concorrência do Encerrar

**Situação:** PREPARADA em 04/10/2026, **não executada**. Precisa de autorização explícita do Felipe para O1, O2 e O4 neste alvo (docs/OPERACAO_AGENTES.md). Nenhuma operação em staging, produção ou no banco local real `kidmais_manager`.

## Objetivo

Provar no PostgreSQL descartável, com o código da candidata:

- a 063 aplica, passa no postcheck e falha fechada (sem a 060, ou já aplicada);
- cadastro, favoritas, conflitos, isolamento e rascunho funcionam com o serviço real e o repositório real de clientes;
- o rollback da 063 recusa descartar dados sem decisão explícita, remove só a 063 e deixa a 060 intacta;
- o Encerrar cancela as pendentes na mesma transação, não entra em deadlock com o worker e as linhas puladas por `SKIP LOCKED` são canceladas depois pelo próprio worker.

## Encerrar e `SKIP LOCKED` (comportamento documentado)

`controlarAtendimento('encerrar')` trava a conversa (`FOR UPDATE`), recusa se houver mensagem `ENVIANDO` e, na mesma transação, marca `CANCELADA` as mensagens `PENDENTE`/`PROCESSANDO` da conversa com `FOR UPDATE SKIP LOCKED`. O contador devolvido separa **saídas** (respostas na fila) de **entradas** (mensagens do cliente ainda sem resposta automática).

Por que `SKIP LOCKED`:

- o worker trava a **mensagem** antes da **conversa** (reserva da fila);
- o Encerrar trava a **conversa** antes das **mensagens**;
- sem `SKIP LOCKED`, essa ordem inversa gera deadlock (40P01). A suíte de concorrência reproduz o deadlock como controle.

O que acontece com a linha pulada:

- ela não entra no contador e continua `PENDENTE` por um instante;
- o worker que a segura espera o Encerrar terminar, revalida sob a trava da conversa, vê `ENCERRADA` e grava `CANCELADA`;
- isso vale para a reserva, para a volta do modelo e para a marcação de envio (`worker.ts`). Nada é enviado.

Envio já iniciado (`ENVIANDO`) não é cancelado: o Encerrar é recusado até o resultado do provedor.

## Suítes

| Suíte | O que prova |
| --- | --- |
| `lib/whatsapp/atendimento/migration-063.postgres.test.ts` | Ordem (sem 060 → recusa), aplicação + postcheck, reaplicação recusada; cadastro só do representante; atalhos primeiro; conflitos de atalho e título ativos, versão desatualizada, regras do banco (link por tipo, https, limite de 4000); remover libera atalho/título (remoção lógica); favoritas por usuário e idempotentes; isolamento (usuário de outra empresa recusado, linha de outra empresa/ambiente invisível, favorita cruzada recusada pela chave composta); rascunho de texto, link fixo e link individual com o repositório real (sem cliente; cliente de outra empresa não conta; telefone sem 55 achado pela variante; dois clientes = ambíguo; nada gravado; telefone não volta); rollback recusado com dados, com descarte remove só a 063, pós-rollback, 060 intacta, biblioteca "indisponível" e atendimento funcionando; reaplicável depois |
| `lib/whatsapp/atendimento/encerrar-concorrencia.postgres.test.ts` | Controle: sem `SKIP LOCKED` a ordem inversa de travas dá deadlock real; com a mensagem travada pelo "worker", o Encerrar termina no prazo, cancela a saída livre e pula a travada; o worker real cancela a pulada depois, sem modelo nem envio; Encerrar durante a interpretação cancela a entrada e o worker não cria resposta; `ENVIANDO` recusa e nada é cancelado; histórico preservado e auditado |
| `lib/whatsapp/atendimento/migration-060.postgres.test.ts` | Regressão da 060 com o Encerrar novo (mesma suíte já validada em `af14865`) |

O link individual **preenchido** (contrato aguardando a assinatura do cliente, origem https) é coberto pelos testes unitários; a fixture de contrato completo fica fora desta rodada.

**Limitação conhecida:** a unicidade de título usa `lower(titulo)`, que segue o `LC_CTYPE` do banco. No cluster descartável (locale C) letras acentuadas não são convertidas ("ENDEREÇO" e "Endereço" não colidem); em banco com locale UTF-8 colidem. A suíte usa título ASCII para não depender do locale.

## Alvo

| Item | Valor |
| --- | --- |
| Binários | `C:\Program Files\PostgreSQL\18\bin` |
| Diretório de dados | `C:\Users\Glass\AppData\Local\Temp\kidmais-pg-063\data` — exclusivo desta validação; precisa **não existir** antes de O1 |
| Endereço e porta | `127.0.0.1:55498`, só loopback |
| Identidade exigida | `cluster_name = kidmais_descartavel`, superusuário `kidmais_descartavel`, locale C, 60 conexões, nenhum banco `kidmais_manager` |
| Código | worktree `C:\Users\Glass\.codex\worktrees\0997\kidmais-candidata-whatsapp`, HEAD anotado em O0, árvore limpa |
| Dados | Exclusivamente sintéticos, criados e removidos pelas suítes |

**Conflito de porta:** a demonstração local usa a mesma porta 55498 (cluster `...\kidmais-demo-atendimento-20261004-4b6271`). Encerre a demonstração antes (`demo.ps1 -Acao encerrar`) ou aguarde; O0 e O1 param se a porta estiver ocupada. Os diretórios `kidmais-pg-demo-atendimento` (preservado) e `kidmais-pg-060` não são tocados.

## Operações

Scripts em `.local-ux/pg-063/` (fora do Git), com SHA-256 em `MANIFESTO.txt`. Nenhum foi executado, exceto O0, que só lê.

| # | Comando | Efeito | Verificação | Parada |
| --- | --- | --- | --- | --- |
| O0 | `bash .local-ux/pg-063/o0.sh` | Nenhum (só leitura) | Porta livre, diretório ausente, árvore limpa, sem `PG*`/`DATABASE_URL` | Qualquer divergência |
| O1 | `bash .local-ux/pg-063/o1.sh` | `initdb` (locale C, UTF8, trust só em 127.0.0.1), configuração e `pg_ctl start` | `identidade-o1.txt` igual à identidade exigida | Diretório existente, porta ocupada ou identidade divergente |
| O2a | `bash .local-ux/pg-063/o2.sh alvo` | Receita monta os modelos; roda 060, 063 e concorrência | `PASS` sem falhas no log `check-v1-postgres-alvo-<HEAD>.log` | Falha: registrar e seguir para O4 |
| O2b | `bash .local-ux/pg-063/o2.sh completa` (opcional, recomendado) | Todas as suítes PostgreSQL | `PASS` no log `check-v1-postgres-completa-<HEAD>.log` | Idem |
| O4 | `bash .local-ux/pg-063/o4.sh` | Confere identidade e diretório, `pg_ctl stop`, remove **somente** `...\kidmais-pg-063\data` | Porta livre; diretório ausente | Identidade divergente, porta ocupada ou `postmaster.pid`: não remover |

**Recuperação:** se O2 falhar no meio, O4 continua seguro (confere identidade antes de parar e só remove o diretório desta validação). Se o servidor não parar, não remover nada e investigar.

**Evidência:** logs de O1, O2 e O4 em `.local-ux/pg-063/`, com o HEAD no nome; o resultado é registrado aqui, ligado ao HEAD validado.
