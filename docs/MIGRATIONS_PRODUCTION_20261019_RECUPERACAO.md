# Migrations de produção 19/10/2026: gate, pausas, janela e recuperação por cenário

**Status: PREPARADO, NÃO EXECUTADO.** Este documento completa o pacote `docs/MIGRATIONS_PRODUCTION_20261019.md`. Ele
responde aos achados P2-3 e P2-4 da revisão independente de 19/10/2026 (parecer em
`revisao-migrations-producao-20261019/PARECER.md`).

Nenhum passo aqui está autorizado por este documento. Cada um pede autorização própria de Felipe
(`docs/OPERACAO_AGENTES.md`).

## 1. Gate de prontidão do deploy: tudo VERDE antes do APLICAR

O APLICAR só começa com o deploy do código novo pronto para sair logo em seguida. O motivo está na seção 6: o código
atual de produção (`cf3de338`) é incompatível com o schema novo em pontos concretos. Itens do gate, todos conferidos por
leitura, **sem mudança de variável de ambiente**:

| # | Item | Verde quando |
|---|---|---|
| G1 | PR para `production` com o SHA candidato (o que contém `bd9bd674…` e este pacote) | aberta, revisada, aprovada; CI verde **nesse SHA exato**; SHA anotado |
| G2 | Build conhecido | `next build` do mesmo SHA já passou (CI ou deploy de staging LIVE do mesmo SHA); nada no SHA exige migration além da 086 |
| G3 | Render produção (leitura) | auto-deploy OFF lido no dia, nenhum deploy em andamento, id do deploy LIVE atual anotado (é o alvo de rollback de código) |
| G4 | Variáveis | lista do que o código novo lê decidida ANTES (nomes e valores aprovados); nenhuma troca na janela; os interruptores de abertura, atendimento e Marketing seguem desligados (o aplicador recusa se algum estiver `true`) |
| G5 | Backup | P1 com menos de 24 h (comando existente `docs/evidencias/backup-production-comando-codex-20261011.txt`), PITR conferido no painel e caminho do registro anotado |
| G6 | Conferência | PARTES 1..N coladas e CONFERIR com `CODIGO_SAIDA_BLOCO=0` (CONFERIDO) no mesmo dia; md5 do schema e contagens de risco registrados |
| G7 | Pessoas | operador disponível pela janela inteira (cerca de 1 h), com quem decide a retomada ao alcance |

Se algum item não estiver verde, **não colar o APLICAR**. O CONFERIR pode ser repetido livremente: é somente leitura.

## 2. Pausas da janela

As pausas começam **antes** do APLICAR e só terminam com o **deploy do código novo LIVE** e o smoke aprovado:

| Pausa | Por quê |
|---|---|
| (a) Catálogo do buffet, **pacotes e adicionais** (criar/editar/excluir/vincular) | 078: o código antigo cria categoria órfã (`empresa_id` NULL, e aí o postcheck da 078 passa a falhar), tem a criação de item recusada (`034: item do buffet cruza empresas`) e o vínculo de categoria órfã a pacote recusado |
| (b) **Cadastro e edição de clientes** e o **fechamento público** | 076: trava de 5 s em `clientes` derruba a migration se houver transação aberta; depois da 076, a corrida de CPF repetido no código antigo vira **500** em vez de 409. 085/086 também travam por FK `clientes`/`fechamentos` |
| (c) **Onboarding de WhatsApp** | 083: o onboarding antigo (sem empresa) passa a ser recusado (`whatsapp_conexoes_empresa_obrigatoria_check`) |
| (d) **Nenhum deploy, rollback, restart ou troca de variável** durante o APLICAR e até o CONFERIR pós-aplicação | um restart encerra o Web Shell no meio da sequência; o deploy só depois do CONFERIR pós |

A agenda **não precisa de pausa**: nenhuma das 13 migrations toca a agenda, e o reparo dos bloqueios está fora do
pacote. A pausa (a) **não pode ser liberada antes do deploy**, mesmo que o APLICAR termine bem.

## 3. Janela (ordem)

1. P1 (backup do dia) → anotar o registro.
2. Iniciar as pausas (a)–(d).
3. Colar as PARTES 1..N (só transporte, sem banco). Se alguma já estiver presente, a saída diz JA_PRESENTE.
4. Colar CONFERIR → `CODIGO_SAIDA_BLOCO=0`.
5. `export KIDMAIS_REGISTRO_BACKUP=<registro>` → colar APLICAR **uma vez** → `CODIGO_SAIDA_BLOCO=0`.
6. Colar CONFERIR de novo, **antes do deploy** (o deploy encerra o Web Shell). Esperado:
   - 15 postchecks PASS, nenhuma ausente;
   - md5 do schema igual ao do ensaio (`c24d84c7…`, resultado = referência de staging), salvo drift prévio de produção. O md5 lido no CONFERIR antes do APLICAR, comparado com o da base do ensaio (`3cc3c743…`), mostra se havia drift.
7. Disparar o deploy do SHA do gate → LIVE, health 200 e smoke (catálogo, pacotes, cliente, fechamento público,
   onboarding se aplicável).
8. Encerrar as pausas.
9. LIMPEZA: opcional, porque a pasta própria é efêmera e some no deploy.

## 4. Códigos de saída e o que fazer

| Saída | Significado | Ação |
|---|---|---|
| 0 | PLANO / CONFERIDO / PASS (ou parte transportada) | seguir |
| 1 | recusa antes de conectar (alvo, flag, backup, disco, uso) | nenhuma escrita; ler a mensagem |
| 2 | FALHA | ler `confirmadasNestaExecucao` e `nenhumaEscrita`. Falha de conexão, identidade ou trava não escreve; falha numa etapa deixa as anteriores confirmadas e a atual desfeita (atômica) |
| 3 | conferência RECUSARIA | nenhuma escrita; ler `planoRecusado` e `verificacoes[].falha` |
| 4 | recusa ou falha do próprio bloco (registro de backup, parte ausente, conteúdo divergente, colisão) | nenhuma escrita no banco; ler a mensagem nomeada |
| outro (127 = linha perdida na colagem, 130 = Ctrl-C, 143 = sinal) ou **sem** `CODIGO_SAIDA_BLOCO` | colagem quebrada ou interrompida | **parar e ler**. Se apareceu o prompt `>`: Ctrl-C, nunca colar por cima, e colar o MESMO bloco de novo |

Na CONFERIR, qualquer saída diferente de 0/3 é parar e ler. No APLICAR e no RETOMAR, qualquer saída diferente de 0 é
parar e ler: não repetir.

## 5. Recuperação por cenário

Regras comuns a todos os cenários:
- Cada migration é uma transação. A que falhou fica AUSENTE e as anteriores ficam COMPLETAS (`confirmadasNestaExecucao`).
- **Nunca** usar os `database/rollback/*_down.sql`: não foram ensaiados neste pacote.
- **Nunca** repetir o APLICAR por cima: ele recusa (`MARCADOR_ANTERIOR`) antes de escrever.
- A retomada usa o bloco **RETOMAR**, com `export KIDMAIS_RETOMAR_ID=<id que parou>` e o mesmo
  `KIDMAIS_REGISTRO_BACKUP` (com menos de 24 h). Antes dele:
  1. CONFERIR (vai dizer RECUSARIA, com `MARCADOR_ANTERIOR <id>`);
  2. causa entendida e removida;
  3. decisão explícita de Felipe.
- Na retomada de 074a–078, o aplicador renomeia o marcador do lançamento (`migration-<id>.json` →
  `.tentativa-<n>`), registra isso no marcador deste pacote antes de renomear e chama o filho de novo. Isso foi ensaiado: lock_timeout na 076 seguido de retomada, PASS.

| Cenário | Estado | Código antigo `cf3de338` no ar | Ação |
|---|---|---|---|
| **A. Parada em 074a, 075, 076 ou 077** (lock_timeout, conexão, backup que passou de 24 h entre filhos) | anteriores COMPLETAS, a que falhou AUSENTE | íntegro, exceto depois da 076: corrida de CPF repetido vira 500 (pausa (b) mantida) | CONFERIR → decidir → (novo P1 se o backup venceu) → RETOMAR `<id>` |
| **B. Parada na 078** | 074a–077 COMPLETAS, 078 AUSENTE | íntegro (catálogo ainda global) | Os dados que fariam a 078 falhar (as 7 categorias originais, `kidmais` única) são antecipados pelo CONFERIR e pela verificação prévia do APLICAR. Se mesmo assim parar: corrigir o dado com autorização própria → RETOMAR 078 |
| **C. Parada em 060–082** | 074a–078 COMPLETAS (catálogo por empresa) e parte do atendimento | incompatível no catálogo (seção 6); tabelas do atendimento inertes para ele | manter pausas (a)(b); RETOMAR `<id>`; **não** fazer o deploy antes do APLICAR/RETOMAR dar PASS (o código novo exige 083/085/086) |
| **D. Parada na 083** | até 082 COMPLETAS, 083 AUSENTE | como em C | RETOMAR 083 (o precheck da 083, número CONFIGURADO duplicado, já roda no CONFERIR) |
| **E. Parada na 085/086** | até 083 COMPLETAS | como em C; depois da 083, onboarding antigo recusado (pausa (c)) | RETOMAR 085 ou 086; o gatilho novo em `clientes` (086) aceita as escritas antigas |
| **F. Deploy falho** depois do APLICAR PASS (build_failed, health vermelho) | schema completo | segue no ar sobre o schema novo, com as incompatibilidades da seção 6 | manter as pausas (a)(b)(c) e corrigir **para frente**: novo build do mesmo SHA ou correção mínima com CI verde, e deploy. Não voltar o schema. Rollback do código para o deploy anterior também é `cf3de338`, então não resolve as incompatibilidades |
| **G. Deploy atrasado** (operador indisponível, gate que deixou de estar verde) | schema completo | idem F | pausas mantidas até o LIVE. Se alguém criou categoria pelo painel antigo (órfã, `empresa_id` NULL), o CONFERIR pós-deploy dá RECUSARIA no postcheck da 078 e a categoria precisa de decisão de dono (corrigir com autorização própria) |
| **H. Último recurso** (dado corrompido, nada à frente resolve) | — | — | PITR ou dump do P1 restaurado em **instância nova**, com perda desde o instante T e troca de `DATABASE_URL`. Hoje **não há procedimento escrito nem restauração comprovada** (o P1 tem `restauracaoRealComprovada:false`): exige plano e autorização próprios |

## 6. Incompatibilidades do código antigo `cf3de338` com o schema novo

Provadas pela revisão independente (SQL literal das escritas antigas sobre o schema novo, prova B) e conferidas nas linhas
de `cf3de338`:

| Escrita do código antigo | Efeito no schema novo | Migration |
|---|---|---|
| `lib/comercial/catalogo-buffet.ts:24`: criar categoria (sem `empresa_id`) | aceita com `empresa_id` NULL: categoria órfã, invisível ao código novo; o postcheck da 078 passa a falhar (`catálogo sem empresa havendo kidmais`) | 078 |
| `lib/comercial/catalogo-buffet.ts:58`: criar item em categoria da Kidmais | recusada `23514` `034: item do buffet cruza empresas`; item sem categoria é aceito, mas órfão | 078 |
| `lib/comercial/pacotes-admin.ts:383/502/700`: vincular categoria a pacote | recusada se a categoria for órfã (`034: categoria do buffet no pacote cruza empresas`) | 078 |
| `lib/clientes/services/cliente.service.ts:214` e `lib/fechamentos/services/fechamento-publico.service.ts:270`: tratam só `clientes_cpf_canonico_uk` | a violação de CPF vem de `clientes_cpf_empresa_canonico_uk`: a corrida que dava **409** vira **500**. O código novo trata os dois (`INDICES_CPF_CANONICO`) | 076 |
| `lib/whatsapp/onboarding.service.ts:132`: conexão CONFIGURADA sem empresa | recusada (`whatsapp_conexoes_empresa_obrigatoria_check`) | 083 |
| `UPDATE clientes SET whatsapp…` | aceito, inclusive em cliente legado sem empresa (gatilho novo da 086) | 086 |

O CONFERIR mostra as contagens de risco dessas áreas:
- `pacotes_sem_empresa` e `fechamentos_sem_empresa`: novas escolhas de buffet em fechamento sem empresa passam a ser recusadas pelo gatilho da 078;
- `whatsapp_configuradas_sem_empresa`: ficam inertes depois da 083, então é preciso confirmar que produção não depende delas;
- `onboarding_em_andamento`;
- `categorias_originais_ausentes`.

## 7. Diferenças assumidas

- Os postchecks de 074a–078 rodam na transação de escrita do aplicador do lançamento, sem `SET TRANSACTION READ ONLY`.
  Alterar esse aplicador invalidaria a revisão dele e os hashes dos comandos P1 e P2. A mitigação tem duas partes: a análise estática do `corpo()` e um segundo postcheck, agora em READ ONLY, feito por este pacote depois de cada filho.
- O marcador do filho (`lancamento-venda-20261011/migration-<id>.json`) continua `ANTES_DA_TRANSACAO` depois de um
  ROLLBACK, porque o aplicador do lançamento não foi alterado. A situação verdadeira fica no marcador deste pacote: `migracoes-producao-20261019/lancamento-<id>.json`, com `FALHA_SCHEMA_AUSENTE` ou `COMMIT_CONFIRMADO`.
