# Validação PostgreSQL — 063 (mensagens prontas) e concorrência do Encerrar

**Situação:** PREPARADA em 04/10/2026, **não executada**. Precisa de autorização explícita do Felipe para O1, O2 e O4 neste alvo (docs/OPERACAO_AGENTES.md). Nenhuma operação em staging, produção ou no banco local real `kidmais_manager`. A demonstração em andamento não é encerrada nem tocada.

## Objetivo

Provar no PostgreSQL descartável, com o código da candidata:

- a 063 aplica, passa no postcheck e falha fechada (sem a 060, ou já aplicada);
- cadastro, favoritas, conflitos, isolamento e rascunho funcionam com o serviço real e o repositório real de clientes, inclusive o link individual **preenchido** a partir de uma contratação completa;
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
| `lib/whatsapp/atendimento/migration-063.postgres.test.ts` | Ordem (sem 060 → recusa), aplicação + postcheck, reaplicação recusada; cadastro só do representante; atalhos primeiro; conflitos de atalho e título ativos, versão desatualizada, regras do banco (link por tipo, https, limite de 4000); remover libera atalho/título (remoção lógica); favoritas por usuário e idempotentes; isolamento (usuário de outra empresa recusado, linha de outra empresa/ambiente invisível, favorita cruzada recusada pela chave composta); rascunho de texto e link fixo; link individual com o repositório real (sem cliente; cliente de outra empresa não conta; telefone sem 55 achado pela variante; dois clientes = ambíguo); **contratação sintética completa** (ver abaixo); nada gravado nem enviado; telefone não volta; rollback recusado com dados, com descarte remove só a 063, pós-rollback, 060 intacta, biblioteca "indisponível" e atendimento funcionando; reaplicável depois |
| `lib/whatsapp/atendimento/encerrar-concorrencia.postgres.test.ts` | Controle: sem `SKIP LOCKED` a ordem inversa de travas dá deadlock real; com a mensagem travada pelo "worker", o Encerrar termina no prazo, cancela a saída livre e pula a travada; o worker real cancela a pulada depois, sem modelo nem envio; Encerrar durante a interpretação cancela a entrada e o worker não cria resposta; `ENVIANDO` recusa e nada é cancelado; histórico preservado e auditado |
| `lib/whatsapp/atendimento/migration-060.postgres.test.ts` | Regressão da 060 com o Encerrar novo (mesma suíte já validada em `af14865`) |

**Contratação sintética completa (passo 6b da suíte 063).** Montada pelas regras do banco, sem contorná-las:

1. fechamento do cliente (`AGUARDANDO_PAGAMENTO`) → contrato → versão `ATIVA` → documento revisado e comprovante;
2. edição com aprovação comercial gravada **antes** da assinatura (depois dela a edição fica congelada);
3. assinatura da empresa (`KIDMAIS`) por representante com a capability `CONTRATO_ASSINAR_EMPRESA` e sessão recente;
4. `EM_ELABORACAO → ASSINADA_KIDMAIS → AGUARDANDO_CLIENTE`, com liberação registrada.

Casos cobertos:

- contrato liberado → link individual **preenchido** com o contrato DESTE cliente pela origem https;
- contrato ainda em elaboração → não conta;
- contratação liberada de outra empresa com o mesmo telefone → não conta;
- origem http → não preenche;
- dois contratos aguardando o mesmo cliente → ambíguo, sem link.

A fixture segue as validações diferidas da 013/054/057; só a execução autorizada comprova que o banco a aceita. Se o banco recusar a fixture, a suíte falha naquele passo (não há falso positivo).

**Limitação conhecida:** a unicidade de título usa `lower(titulo)`, que segue o `LC_CTYPE` do banco. No cluster descartável (locale C) letras acentuadas não são convertidas ("ENDEREÇO" e "Endereço" não colidem); em banco com locale UTF-8 colidem. A suíte usa título ASCII para não depender do locale.

## Alvo

| Item | Valor |
| --- | --- |
| Binários | `C:\Program Files\PostgreSQL\18\bin` |
| Diretório de dados | `C:\Users\Glass\AppData\Local\Temp\kidmais-pg-063\data` — exclusivo desta validação; precisa **não existir** antes de O1 |
| Endereço e porta | `127.0.0.1:55500`, só loopback — porta própria, diferente da demonstração |
| Autorização da porta | `KIDMAIS_DESCARTAVEL_PORTA=55500` e `KIDMAIS_DESCARTAVEL_AUTORIZACAO=127.0.0.1:55500/kidmais_pacotes_v1_descartavel` (regra literal de `lib/comercial/alvo-descartavel.ts`; sem mudança de código) |
| Identidade exigida | `cluster_name = kidmais_descartavel`, superusuário `kidmais_descartavel`, locale C, 60 conexões, nenhum banco `kidmais_manager`, porta 55500 |
| Código | worktree `C:\Users\Glass\.codex\worktrees\0997\kidmais-candidata-whatsapp`, HEAD anotado em O0, árvore limpa |
| Dados | Exclusivamente sintéticos, criados e removidos pelas suítes |

**Demonstração preservada:** a demonstração usa 55498 (cluster `...\kidmais-demo-atendimento-20261004-4b6271`) e **continua rodando**. Esta validação usa 55500 e outro diretório. O0 só informa o uso de 55498; O4 recusa o diretório da demonstração e o preservado (`kidmais-pg-demo-atendimento`) mesmo se configurado por engano. `kidmais-pg-060` também não é tocado.

## Operações

Scripts em `.local-ux/pg-063/` (fora do Git), com SHA-256 em `MANIFESTO.txt`. Nenhum foi executado contra banco: só O0 (leitura) e o teste offline do O4 (cópias redirecionadas para uma pasta temporária, sem PostgreSQL).

| # | Comando | Efeito | Verificação | Parada |
| --- | --- | --- | --- | --- |
| O0 | `bash .local-ux/pg-063/o0.sh` | Nenhum (só leitura) | Porta 55500 livre, diretório ausente, árvore limpa, sem `PG*`/`DATABASE_URL`; 55498 só informado | Qualquer divergência |
| O1 | `bash .local-ux/pg-063/o1.sh` | `initdb` (locale C, UTF8, trust só em 127.0.0.1), configuração (porta 55500, marca "Validação 063") e `pg_ctl start` | `identidade-o1.txt` igual à identidade exigida | Diretório existente, porta ocupada ou identidade divergente |
| O2a | `bash .local-ux/pg-063/o2.sh alvo` | Receita monta os modelos; roda 060, 063 e concorrência | `PASS` sem falhas em `check-v1-postgres-alvo-<HEAD>.log` | Falha: registrar e seguir para O4 |
| O2b | `bash .local-ux/pg-063/o2.sh completa` (opcional, recomendado) | Todas as suítes PostgreSQL | `PASS` em `check-v1-postgres-completa-<HEAD>.log` | Idem |
| O4 | `powershell -NoProfile -ExecutionPolicy Bypass -File .local-ux\pg-063\o4.ps1` | Ver abaixo | Porta 55500 livre; diretório ausente; pasta-mãe e protegidos intactos | Qualquer divergência: para sem remover |

**O4 (PowerShell), em ordem, parando sem remover diante de qualquer divergência:**

1. o caminho absoluto **resolvido** precisa ser exatamente `C:\Users\Glass\AppData\Local\Temp\kidmais-pg-063\data` (constante; não vem de parâmetro nem de ambiente);
2. o alvo não pode coincidir com a demonstração nem com o diretório preservado, não pode ser link/junção nem conter link/junção;
3. o `postgresql.conf` precisa ter a marca "Validação 063", `port = 55500` e `cluster_name = 'kidmais_descartavel'`;
4. se a porta responde, o servidor precisa devolver o mesmo `data_directory`, `cluster_name` e porta (`psql` com `connect_timeout=5`: algo que aceita a conexão e não responde não prende o O4);
5. `pg_ctl -D <alvo> stop` sem pipe, conferindo o código de saída;
6. espera porta livre e ausência de `postmaster.pid`;
7. remove **somente** o alvo com `Remove-Item -LiteralPath`; a pasta-mãe fica.

**Teste offline do O4** (`teste-o4.ps1`, log `teste-o4.log`): 10/10 — alvo ausente; caminho com `..`; alvo protegido; alvo junção (destino intacto); junção dentro do alvo; sem a marca; `postmaster.pid`; porta ocupada por algo que não é o cluster; remoção só do alvo (vizinho e pasta-mãe intactos); alvo real não criado.

**Recuperação:** se O2 falhar no meio, O4 continua seguro. Se o servidor não parar, não remover nada e investigar.

**Evidência:** logs de O1, O2 e O4 em `.local-ux/pg-063/`, com o HEAD no nome; o resultado é registrado aqui, ligado ao HEAD validado.
