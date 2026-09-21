# Patch 019 — Festa automática e ocupação por formalização

## Escopo e arquitetura

A segunda assinatura continua sendo orquestrada por `assinarContratoPublico()`.
Na mesma transação e no mesmo executor: validar instalação, bloquear agenda,
reler conflitos após lock, consumir prova, finalizar versão/fluxo/fechamento,
garantir Festa, registrar evento de sistema, auditoria e histórico CRM, commit.
Não há HTTP interno, transação aninhada ou confirmação financeira artificial.

Só KIDMAIS assinada não cria Festa. O documento exato, ambas as assinaturas,
edição concluída e versão vigente assinada são obrigatórios. A rota traduz
conflitos e falhas de instalação sem imprimir SQL/parâmetros. Falha de criação
ou auditoria propaga até o rollback da segunda assinatura.

## Migration e verificação física

- `database/migrations/20260915_019_festa_formalizacao.sql`
- `database/checks/20260915_019_precheck.sql`
- `database/checks/20260915_019_postcheck.sql`
- `database/rollback/20260915_019_festa_formalizacao_down.sql`

001–018 não foram alteradas. A 019 altera autoria (origem automática/manual
histórica e ator de sistema), funções de ocupação e proteções transacionais.
Não cria uma tabela paralela de reservas, nem faz backfill de Festas.

`kidmais_ocupacoes_operacionais()` inclui contratação formalizada não cancelada
OU fechamento CONFIRMADO ainda válido, sem duplicar a base; preserva holds de
revisão. `bloqueios_agenda` continua independente. A função de ocupação não usa
a existência isolada de Festa como reserva.

O fingerprint 016 é preservado por projeção explícita das mudanças da 019.
No PostgreSQL 18, metadados dos NOT NULL retirados são preservados em comentário
de coluna para reconstruir a assinatura anterior. O delta 019 é verificado por
hash dos corpos das funções, presença/ativação dos triggers e metadados de autoria.
O postcheck verifica ambas as camadas. Ambas foram aprovadas em PostgreSQL 18.6 descartável.
O fingerprint normaliza CRLF dos corpos das funções, mantendo o hash canônico da 016.

`node scripts/festa-019-manifest.mjs` regenera somente os artefatos locais de
verificação a partir do SQL versionado. Não conecta ao banco.

## Idempotência e concorrência

A identidade de negócio é contrato, não versão. Reutiliza a Festa ativa e os
índices existentes de unicidade; não reinicia buffet, tarefas ou eventos.
Replay sem Festa não faz backfill; registro invalidado não é ressuscitado.
Identidade/autoria da criação são imutáveis.

Locks usam o namespace existente `kidmais:agenda:`. A leitura do conflito ocorre
em statement separado após o lock, em READ COMMITTED. Isolamento diferente é
recusado no lock contratual. Triggers e verificações diferidas também protegem
a publicação da vigência, a ocupação e os bloqueios administrativos. Deadlock
ou conflito deve abortar a operação; não existe retry cego de escrita.

Revisões reconhecem ocupação por assinatura antes do pagamento: mantêm base e
hold de destino, trocam vigência atomicamente e preservam versões anteriores.

## Cancelamento e financeiro

Cancelamento continua exigindo sessão/capacidade, versão, motivo e chave da
operação. Bloqueia as datas e encerra preparações abertas antes de cancelar o
contrato. Festa fica no Histórico. Documentos, provas, versões e recebimentos
não são removidos. A ocupação exclui o contrato cancelado mesmo se o fechamento
financeiro continuar CONFIRMADO.

Invalidação técnica não substitui cancelamento de contratação assinada.
Não há estorno automático, quitação fictícia ou mudança para CONFIRMADO na
assinatura. O serviço financeiro não foi alterado. A compatibilidade física com
financeiro 015 foi exercitada em ambiente descartável, incluindo nova versão,
cronograma consolidado, recebimento, retry, estorno e cancelamento.

## Contratos anteriores e ativação

O novo fluxo não repara automaticamente contratos anteriores. A migration
recusa formalizações antigas inconsistentes e conflitos existentes. Assinados
válidos sem Festa aparecem nos relatórios para reconciliação explícita.

Ferramenta: `scripts/festa-019-reconciliar.mjs`.
Não carrega `.env.local` nem usa DATABASE_URL implicitamente. Recebe a conexão
por `FESTA_019_RECONCILIACAO_URL`, com alvo esperado `--database`.
Sem `--apply`, faz apenas inventário READ ONLY. Escrita exige, cumulativamente,
`--apply --authorize-write --contrato <UUID>`; uma contratação por execução.
Aceita apenas production remoto ou banco local descartável `kidmais_019_<número>`.
Revalida formalização, invalidação e conflitos, e registra resultado individual.
Executada somente com fixtures sintéticas em banco descartável nesta validação.

Ordem operacional proposta, dependente de autorização separada:

1. Revisar os resultados da validação descartável registrada abaixo.
2. Bloquear tráfego de escrita durante a transição de versão.
3. Precheck: zero conflitos; inventário revisado. SELECT com linhas não é aprovação.
4. Aplicar 019 e executar postcheck.
5. Reconciliar individualmente os contratos aprovados; nenhum conflito é resolvido automaticamente.
6. Ativar aplicação compatível, validar assinatura/ocupação/cancelamento e somente então liberar tráfego.

O rollback SQL é deliberadamente restrito: recusa se houver contratos assinados
ou cancelados ou registros de autoria automática. Após uso real, preferir correção
forward, sem apagar história. Rollback de aplicação também exige coordenação: a
versão anterior não conhece a nova transição obrigatória.

## Testes

### Executáveis sem banco

- `node --experimental-strip-types --test lib/festas/formalizacao.test.ts lib/festas/ambiente.test.ts lib/festas/domain.test.ts`
- `npm run production:test`
- `npm run check:v1:static` (unitários, lint, TypeScript, build)
- `npm run build`
- `git diff --check`

Os testes com executor simulado comprovam chamadas, condições de recusa e
propagação de falhas; não comprovam rollback físico nem exclusão concorrente.

### Runner físico executado no PostgreSQL descartável

`scripts/festa-019.integration.mjs` exige `--authorize-disposable` e
`FESTA_019_TEST_URL` apontando a localhost/loopback, com nome `kidmais_019_<número>`.
Recusa antes da conexão qualquer outro destino. Requer schema até 019 e catálogo
instalados previamente, sem contratos. Não cria banco, não aplica migrations,
não restaura dumps e não consulta origem externa. Deixa dados sintéticos no banco
descartável. Usa assinatura administrativa e OTP sintético pelos serviços reais.

Cenários executados: assinatura única/documento divergente, falha de auditoria,
retry/clique concorrente, contratos sobrepostos, bloqueio administrativo,
retificação, remarcação e conflito de destino, cancelamento, documentos e ausência
de criação financeira artificial, operação sem FESTA_CRIAR.

Inclui pagamento/recebimento e preservação das tabelas financeiras no cancelamento.
A regressão financeira com estornos e cronogramas 015 passou. Runners antigos
que exigem criação manual não representam a regra nova: o runner 019 cobre a
criação automática, a revisão 014, o cancelamento e a ocupação da Festa 016.
O runner adicional `scripts/festa-019-reconciliacao.integration.mjs` exige
`--database <nome-exato> --authorize-disposable` e uma fixture legada sintética.


## Validação física — 15/09/2026

### Isolamento comprovado

PostgreSQL **18.6**, cluster novo inicializado exclusivamente nesta execução:

- Host: **127.0.0.1**; porta: **55419**; usuário: **patch019_test**.
- Diretório: `C:\Users\Glass\AppData\Local\Temp\kidmais-patch019-20260915`.
- Banco principal: **kidmais_019_20260915**.
- Banco de reconciliação sintética: **kidmais_019_2026091502**.
- Clone financeiro sintético: **kidmais_015_20260915**, na mesma instância isolada;
  esse nome atende à guarda já existente dos testes 015. Após a regressão, foi
  recriado com 001–018 para repetir o rollback comparando schema e todos os dados.

Identidade consultada por current_database(), current_user, inet_server_addr(),
inet_server_port() e data_directory. As criações/recriações foram guardadas por
nome fixo, porta e diretório do cluster. Cada destino foi conferido antes das
escritas; o banco administrativo postgres foi usado somente nessa instância nova
para CREATE/DROP dos bancos descartáveis nomeados acima.

Nenhum serviço PostgreSQL existente foi reutilizado. Nenhum dump real foi lido.
Não houve acesso a production, staging real, kidmais_manager ou Render.
Não houve leitura de arquivos .env, alteração de secrets, deploy, commit ou push.
O processo temporário precisou de execução fora do sandbox para iniciar:
o Windows recusou o token restrito do pg_ctl. A escuta permaneceu em loopback.

### Instalação, catálogo e rollback

| Verificação | Resultado observado |
|---|---|
| Bootstrap | Migrations oficiais 001–018, incluindo 006a, aplicadas em ordem; sem schema_mvp |
| Postcheck 014 | PASS imediatamente após 014, antes da evolução seguinte |
| Precheck 019 | PASS; zero conflitos e zero contratos pendentes no banco inicialmente vazio |
| Aplicação 019 | PASS com psql -X -w -v ON_ERROR_STOP=1 -f e PGCLIENTENCODING=UTF8 |
| Postcheck 019 | PASS após aplicação, reaplicação e uso funcional |
| Fingerprint 016 projetado | d723f81def59be627132230aa6de2e00b0b509d48f20b0e0701afd7eb99650d7 |
| Funções | 7 novas e 3 substituídas; 10 corpos conferidos pelo manifesto |
| Triggers novos | 9 ativos; 4 de integridade DEFERRABLE INITIALLY DEFERRED |
| Autoria | festas.origem_criacao e festa_eventos.ator_tipo NOT NULL; autores humanos nullable sob CHECK restritivo |
| Índices inválidos/não prontos | 0 |
| Constraints não validadas | 0 |
| Triggers desabilitados | 0 |
| Rollback antes do uso | PASS: schema-only pg_dump antes/depois exatamente igual, removendo apenas os marcadores aleatórios restrict/unrestrict do dump |
| Resíduos após rollback | Nenhum objeto adicional no schema comparado |
| Dados após rollback | Conteúdo de todas as 63 tabelas públicas exatamente igual; hash agregado antes/depois idêntico |
| Reaplicação | PASS e novo postcheck PASS |
| Rollback após assinaturas/uso | Recusa esperada; transação desfeita e postcheck seguinte PASS |

SHA-256 do arquivo SQL 019 aplicado:

`ce6c3eab69541105f27c2ec79b1b0f4a9e406e8f5d05ba25c7ea83c3bd3f9456`

A primeira verificação detectou CRLF nos corpos das funções carregados pelo
checkout Windows: até a cadeia limpa 001–018 produzia hash diferente. A projeção
antes/depois da 019 já era igual. Normalizar apenas CR da definição de função
restaurou o hash canônico existente, sem trocar o valor esperado e sem alterar
migrations 001–018. O manifesto/postcheck foi regenerado e validado novamente.

Os quatro índices existentes de festas foram preservados. A unicidade operacional
é garantida por festas_contrato_ativo_uk em contrato_id, quando invalidada_em IS NULL;
a chave de criação também permanece única.

### Cenários A–N

| Caso | Resultado | Evidência física |
|---|---|---|
| A — Apenas KIDMAIS | PASS | Zero Festa e zero ocupação; documento divergente também recusado |
| B — Segunda assinatura | PASS | Contrato ASSINADO, versão ASSINADA, formalização true, exatamente uma Festa e ocupação após COMMIT |
| C — Retry | PASS | Mesma Festa; apenas um evento FESTA_CRIADA |
| D — Cliques/requisições repetidas | PASS | Chamadas repetidas e concorrentes sem duplicação |
| E — Mesmo contrato concorrente | PASS | Barreira de início em dois backends PostgreSQL distintos; ambos retornam sucesso/reuso, uma Festa |
| F — Contratos distintos, mesmo intervalo | PASS | Dois backends simultâneos: uma assinatura conclui e outra retorna conflito explícito; uma ocupação |
| G — Sobreposição parcial | PASS | 17h–21h versus 18h–22h: segunda assinatura recusada; zero Festa no perdedor |
| H — Bloqueio administrativo | PASS | Bloqueio vence a assinatura concorrente; nenhuma Festa parcial. Bloqueio sobre contratação já formalizada também recusado |
| I — Falha após assinatura | PASS | Falha injetada na auditoria antes do COMMIT desfaz assinatura CLIENTE, Festa e ocupação; assinatura KIDMAIS permanece |
| J — Cancelamento | PASS | Festa consultável como CANCELADA; documentos/assinaturas iguais; ocupação liberada; financeiro preservado |
| K — Invalidação técnica | PASS | Comando recusado para contratação assinada ativa |
| L — Retificação/nova versão | PASS | Mesma Festa; documentos e assinaturas da versão anterior preservados |
| M — Remarcação | PASS | Origem protegida e destino reservado por hold; conflito preserva origem; troca válida libera origem somente após conclusão |
| N — Pagamento/retry | PASS | Uma Festa e uma ocupação mesmo com CONFIRMADO; retry não altera o snapshot financeiro; ajuste 015 após nova versão também validado |

O runner principal terminou com **12 grupos PASS**. O catálogo final mostrou
**zero pares de contratações com intervalos sobrepostos** e, para as três
contratações ativas formalizadas consultadas, exatamente uma Festa por contrato.
Isso comprova os cenários exercitados; não constitui teste de carga ilimitada.

A exclusão concorrente foi testada com transações reais, sem mock do PostgreSQL.
Somente o transporte OTP foi substituído por entrega sintética local e a falha de
auditoria foi injetada deliberadamente. Assinatura, serviços, repositories,
constraints, triggers e COMMIT/ROLLBACK usados são reais.

### Fonte única de ocupação

PASS para contratação formalizada sem pagamento; CONFIRMADO legado sem
formalização também ocupou uma vez. Quando formalização e CONFIRMADO coexistem,
a consulta retorna uma única ocupação base. Cancelamento remove a ocupação,
inclusive após pagamento, mas não remove bloqueios independentes. Holds de
remarcação continuam presentes até a conclusão/cancelamento da preparação.

A consulta pública real de Disponibilidade retornou INDISPONIVEL para todos os
candidatos sobrepostos ao intervalo assinado. Também continuou indisponível
quando um bloqueio independente foi criado após cancelamento contratual.

### Reconciliação simulada

O segundo banco foi preparado com o schema pré-019 capturado da cadeia oficial
e dados exclusivamente sintéticos do runner, sem as tabelas de dados Festa.
O restore sintético usou disable-triggers para as FKs circulares, restaurando-os
antes dos testes. A 019 foi aplicada normalmente, com precheck e postcheck;
um contrato ASSINADO sem Festa foi reportado.

| Cenário | Resultado |
|---|---|
| ASSINADO sem Festa e sem conflito | Inventário elegível; leitura não escreve; aplicação explícita cria uma Festa |
| ASSINADO sem Festa com conflito | Inventário aponta conflito; aplicação explícita recusa e mantém zero Festa |
| CANCELADO | Aplicação recusada; zero Festa |
| Festa existente / replay | Mesma Festa e único evento de criação |

Para reproduzir o estado legado conflitante, somente no banco sintético, o
trigger de validação de bloqueios foi suspenso durante uma inserção e reativado
na mesma transação de preparação. O reconciliador foi executado depois com todos
os triggers ativos. Essa preparação deliberada de fixture não é procedimento
operacional autorizado: numa instalação normal, a migration 019 já recusa
conflitos preexistentes. Nenhuma correção silenciosa foi feita pelo reconciliador.

### Regressão final

| Suite/check | Resultado final |
|---|---|
| Formalização + ambiente + domínio Festa | 26/26 PASS |
| production:test | 30/30 PASS |
| check:v1:static | 244/244 PASS; ESLint, TypeScript e build PASS |
| npm run build separado | PASS; sem falha de memória/ambiente |
| pricing-service | PASS, incluindo catálogo/Pocket 017 |
| identidade-repository / identidade-service / identidade-fechamento | PASS; CRM, OTP e persistência do fechamento |
| pagamentos-engenharia | PASS |
| pagamentos-http | PASS, handlers administrativos e proteção de requisições |
| pagamentos-concorrencia | 5 cenários PASS, espera física observada e fingerprint preservado |
| condicao-pagamento | 19 cenários PASS, incluindo fluxo contratual, OTP, entrada pública e revisão concorrente |
| financeiro-http-015 | PASS |
| financeiro-fluxo-015 | PASS |
| credito-devolucao-015 | PASS |
| casos-financeiros-015 | 16 cenários PASS |
| movimentos-015 | PASS; cronograma consolidado, recebimento, retry, estorno, integridade diferida e histórico |
| Runner 019 / revisão 014 / Festa 016 | 12 grupos PASS, conforme A–N e fonte única de ocupação |
| Reconciliação sintética | 4 cenários PASS |
| git diff --check | PASS |

A regressão estática inclui todos os testes .test.ts de app, components e lib,
abrangendo também admin origin/CRM, CSRF, contrato, Festa e regras Pocket.
Os runners antigos que pressupõem a ação manual de criar Festa não foram
usados como prova do comportamento novo; a cobertura correspondente está no
runner físico 019. Não foram executados runners apontados a ambientes reais.

Ajustes necessários durante a validação:

- Normalização de CRLF no fingerprint, mantendo o hash canônico.
- Teste comercial agora exige 409 no horário formalizado e usa outro dia para
  testar entrada pública válida; nenhuma regra da aplicação foi afrouxada.
- Fixtures concorrentes financeiras são preparadas em dias distintos; o caso de
  agenda disputa a data durante a operação, mantendo a espera física verificável.
- Ampliação dos testes 019 para sobreposição parcial, barreira de dois backends,
  legado CONFIRMADO, retry financeiro, ajuste 015 e reconciliação.
- URL malformada dos runners não imprime o conteúdo recebido; teste incluído.

### Riscos remanescentes e decisão

**GO para commit do patch revisável. Não há autorização de commit ou push nesta tarefa.**

**NO-GO para ativação comercial/deploy nesta etapa.** Produção não foi consultada,
a migration não foi aplicada lá, e os contratos anteriores ainda dependem de
inventário, ausência de conflitos e reconciliação operacional autorizada.

A transição exige coordenar aplicação e schema, pausar escrita e revisar cada
contrato anterior. Após uso real, rollback SQL é recusado para preservar história;
a versão anterior da aplicação não deve ser simplesmente recolocada em operação.

Os testes utilizaram usuário administrador em cluster local com autenticação
trust limitada ao loopback. Privilégios/TLS e comportamento sob carga do ambiente
Render não foram atestados. Locks por data podem serializar operações concorrentes;
timeout/deadlock causa recusa e rollback, não continuação parcial.

Busca por DATABASE_URL=, password, token, secret, pepper, access_token e app_secret
nos arquivos alterados/novos revisada: nomes de código e valores sintéticos de
teste, sem inclusão de segredo real. Nenhum secret real foi carregado ou alterado.

Os logs locais estão em .local-festa/patch019 (ignorado pelo Git). Os dumps
sintéticos e o cluster temporário foram mantidos para inspeção local; não fazem
parte do patch. O servidor temporário foi encerrado; a porta 55419 ficou sem listener.

## Git e lista exata do patch

Branch: **staging**. **17 arquivos rastreados modificados e 12 novos**, todos pendentes;
nenhum arquivo staged, commit ou push. A working tree permanece com o patch para revisão.

O status abaixo é a lista exata dos 29 arquivos alterados/novos:

```text
 M app/api/admin/festas/route.ts
 M app/api/contratos/route-utils.ts
 M components/fechamento/FechamentoWizard.tsx
 M components/festas/FestaConsole.tsx
 M lib/contratos/services/cancelamento.service.ts
 M lib/contratos/services/contrato-publico.service.ts
 M lib/fechamentos/services/revisao-operacional.service.ts
 M lib/festas/ambiente.test.ts
 M lib/festas/ambiente.ts
 M lib/festas/estrutura-016.ts
 M lib/festas/service.ts
 M scripts/condicao-pagamento.integration.cjs
 M scripts/pagamentos-concorrencia.integration.cjs
 M scripts/production/README.md
 M scripts/production/check-migrations.mjs
 M scripts/production/go-no-go.mjs
 M scripts/production/production.test.mjs
?? database/checks/20260915_019_postcheck.sql
?? database/checks/20260915_019_precheck.sql
?? database/migrations/20260915_019_festa_formalizacao.sql
?? database/rollback/20260915_019_festa_formalizacao_down.sql
?? docs/PATCH_019_FESTA_FORMALIZACAO.md
?? lib/festas/estrutura-019.ts
?? lib/festas/formalizacao.test.ts
?? lib/festas/formalizacao.ts
?? scripts/festa-019-manifest.mjs
?? scripts/festa-019-reconciliacao.integration.mjs
?? scripts/festa-019-reconciliar.mjs
?? scripts/festa-019.integration.mjs
```

### git diff --stat

O Git lista aqui somente os arquivos rastreados; os 12 novos constam no status acima
e ainda não foram adicionados ao index.

```text
 app/api/admin/festas/route.ts                          |  2 +-
 app/api/contratos/route-utils.ts                       |  7 +++++++
 components/fechamento/FechamentoWizard.tsx             |  4 ++--
 components/festas/FestaConsole.tsx                     |  2 +-
 lib/contratos/services/cancelamento.service.ts         |  5 +++++
 lib/contratos/services/contrato-publico.service.ts     | 11 +++++++++++
 .../services/revisao-operacional.service.ts            |  6 +++---
 lib/festas/ambiente.test.ts                            | 10 +++++++++-
 lib/festas/ambiente.ts                                 |  2 ++
 lib/festas/estrutura-016.ts                            | 15 +++++++++++----
 lib/festas/service.ts                                  | 18 +++++-------------
 scripts/condicao-pagamento.integration.cjs             |  5 +++++
 scripts/pagamentos-concorrencia.integration.cjs        |  8 ++++++--
 scripts/production/README.md                           |  2 +-
 scripts/production/check-migrations.mjs                |  4 ++--
 scripts/production/go-no-go.mjs                        |  2 +-
 scripts/production/production.test.mjs                 |  4 ++--
 17 files changed, 74 insertions(+), 33 deletions(-)
```
