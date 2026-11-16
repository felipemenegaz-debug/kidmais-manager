# Pesquisa de satisfação pós-festa — PS-1 e PS-2 locais — 30–31/10/2026

**PS-2 (31/10): implementada LOCAL, sem commit, aguardando o Astra** — ver "PS-2 — criação pelo motor e despacho
simulado" no fim desta nota.

**Estado: PS-1 rodada 2 LOCAL (correção dos 5 P2 do parecer REPROVADO do Astra), APROVADA COM RESSALVAS pelo Astra (30/10; só o P3 documental R2-D1, já corrigido).**
Commit local `a3c54dfd` (rodada 1, sem push); rodada 2 sem commit. Sem push, PR, staging, produção, Render ou envio
real. A migration 110 **não** foi aplicada em nenhum banco real: só no cluster PostgreSQL
descartável da PS-1 (127.0.0.1:55551), autorizado por Felipe ("Autorizar", 30/10).

- Plano: vault `02 - Kidmais Manager SaaS/07 - Roadmap/Plano pesquisa de satisfacao 20261030.md` (rev. 6 APROVADA
  pelo Astra; D-PS1..D-PS8 de Felipe).
- Clone: `kidmais-manager-satisfacao-ps1-20261030`, branch `codex/satisfacao-ps1-20261030`, base `origin/staging`
  `d8943742`.
- Interruptor: `SATISFACAO_PESQUISA_ENABLED` (desligado = 503 genérico antes de ler o corpo). Anel de chaves do link:
  `SATISFACAO_LINK_CHAVES` + `SATISFACAO_LINK_CHAVE_ATUAL` (ausente ou malformado = falha fechada).

## O que a PS-1 entrega

| Parte | Arquivos |
|---|---|
| Migration 110 | `database/migrations/20261030_110_satisfacao_pesquisa.sql`, `database/checks/20261030_110_{precheck,postcheck}.sql`, `database/rollback/20261030_110_satisfacao_pesquisa_down.sql` |
| Módulo | `lib/satisfacao/`: `token.ts` (HMAC, anel, rotação), `fragmento.ts`, `questionario.ts` (v1 e NPS), `envios.ts` (criação e regeneração), `travas.ts` (pais NOWAIT, 5 tentativas), `publico.ts` (abrir, responder, sair), `supressao.ts` (alcance por canal), `http.ts`, `erros.ts` |
| Rotas e página | `app/api/satisfacao/{abrir,responder,sair}/route.ts` (só POST), `app/p/satisfacao/` (página pública), cabeçalhos `/p/:path*` em `next.config.ts` |
| Marketing | `preferencias.ts` (`bloqueioWhatsappDoDestino`: controles OU conversas na mesma instrução; `suprimirPesquisas`), `motor.ts` (`frequenciaExcedida` com reserva viva e `excetoEnvioId`; `PESQUISA_NAO_DISPONIVEL`) |
| WhatsApp | `service.ts`: PARAR suprime só o WhatsApp das pesquisas pendentes dos clientes do número |
| Inventários | `check-migrations.mjs`/`production.test.mjs` (110 na lista, autorização explícita), receita do modelo `110`, seleção das suítes PG, exportação verificável (8 tabelas `satisfacao_*` no pacote com `migracao: '110'`, `satisfacao_email_simulado` fora do escopo; retrato `colunas-esperadas-110.json`) |

## Resultados (todos locais)

| Prova | Resultado |
|---|---|
| Unitários `lib/satisfacao/satisfacao.test.ts` | 7/7 |
| PG `satisfacao.postgres.test.ts` (modelo 110) | 21/21 |
| PG `satisfacao-concorrencia.postgres.test.ts` (três conexões, espera observada em `pg_stat_activity`) | 9/9 |
| Regressão PG Marketing + WhatsApp + pesquisa | 43 arquivos, 150 testes, 0 falhas, 0 skips |
| Exportação verificável nos modelos 098/103/108/109/110 | 29/29; retratos antigos inalterados; o 110 = 109 + tabelas da pesquisa + 3 colunas novas de `marketing_automacao_regras` |
| Mutantes causais (clone LF isolado, `npm ci` próprio) | 28/28 MORTOS (3 pelo postcheck; ver abaixo) |
| CI local (todos os passos de `ci.yml`) | 34/34 |
| E2E Playwright 1366 e 390 px | 28/28 conferências PASS |

### Mutantes

28 mutantes, um por defesa (M01–M28 em `ambientes-locais/satisfacao-ps1-mutantes.cjs`), controle sem mutação PASS antes.
Todos MORTOS. Causa de cada um conferida no relatório:

- M01–M14, M16–M20, M23–M28: morrem na prova específica (ex.: M02 sem `FOR UPDATE` → a segunda resposta deixa de
  esperar no marcador `satisfacao:travar-envio`; M17 sem o prazo de 24 h → o envio a 12 h de expirar passa a aceitar
  ENVIANDO; M28 link num log → a varredura de sigilo acha).
- **M15 (086 sem `PESQUISA_CRIADA`), M21 (sem UNIQUE da festa) e M22 (sem UNIQUE da resposta): morrem no postcheck da
  110** durante a montagem do modelo — gate estrutural, não a prova de comportamento. A prova de comportamento de M21
  existe (INSERT direto com outra execução da mesma festa → 23505), mas não chega a rodar. A de M22 é mascarada pelo
  gatilho "resposta só em envio ATIVO" + invariante + `FOR UPDATE` (defesa em profundidade); fica só o gate estrutural.
- M17 sobreviveu na primeira rodada: a prova usava um envio de 30 dias (já vencido), que o mutante também recusava.
  Corrigido para 29,5 dias (expira em 12 h) e o mutante passou a morrer pela causa certa.

### E2E

`ambientes-locais/satisfacao-ps1-e2e.cjs` (+ semente sintética com as fixtures das suítes) num banco
`kidmais_satisfacao_e2e` do cluster descartável (criado do modelo 110 e apagado no fim). Capturas só da página.

- Produção (`next start`): `Cache-Control: no-store`, `noindex`, `no-referrer` em GET e HEAD; CSP só `'self'`, sem
  `unsafe-eval`.
- Fluxos (`next dev`, convenção dos roteiros `scripts/*-ui.cjs`): GET/HEAD sem gravação; GET nas APIs = 405; nota
  pré-marcada pelo link sem gravar resposta; resposta gravada (1366 e 390, sem rolagem horizontal); nota 3 com aviso e
  tarefa ABERTA; o link sai da barra de endereço; mesmo link = "já respondida"; vencido, adulterado e sem token =
  "Pesquisa indisponível"; saída das pesquisas grava e encerra as entregas; zero requisição a terceiros; o link (nem o
  prefixo) não aparece em URL, Referer nem log do servidor.

**Achados do E2E (corrigidos):**
1. **`Origin: null` recusado:** o `fetch` da página usava `referrerPolicy: "no-referrer"`, e com isso o navegador manda
   `Origin: null`; a conferência de origem recusava o POST (a página caía em "indisponível"). As suítes chamam o
   serviço direto e não pegam isso. Agora `same-origin` (o Referer nunca leva o fragmento; o documento segue
   `no-referrer`).
2. **Pergunta sobre a borda do cartão:** a `<legend>` do fieldset ficava sobre a borda; `legend` flutuante resolve.

### CI local

Todos os passos de `.github/workflows/ci.yml` (menos `npm ci`) com o código de saída de cada um conferido.
Primeira rodada: 33/34; a falha (`production:test`, "latest" ainda 109) foi corrigida (37/37). **Rodada final, sobre a
árvore com as correções do E2E: 34/34 passos com saída 0** (`check:v1:static` inclui lint, TypeScript, build e os
4 077 + 103 testes estáticos; restam 3 avisos de lint antigos, fora desta mudança).

Relatórios (fora do repositório, em `ambientes-locais/pg-descartavel-satisfacao-ps1-relatorios/`): regressão PG
`2026-10-30T11-47-57-355Z-check-v1-postgres.log`, mutantes finais `2026-10-30T13-03-25-302Z-mutantes.txt`, E2E final
`2026-10-30T12-55-26-413Z-e2e/` (resultado e capturas).

## Desvios do plano (para o Astra)

- `satisfacao_envios.estabelecimento_id` é anulável (festa sem unidade); o gatilho exige igualdade com a festa.
- A guarda da 043 torna inutilizáveis, hoje, as concessões por unidade de `satisfacao_capacidades` (só a tabela e o
  gatilho entram na PS-1; o uso é da PS-4).
- A criação trava os pais `FOR SHARE NOWAIT` **antes** do INSERT (o gatilho trava de novo); a troca do cliente da
  festa espera a criação, e a criação recebe 55P03 se a troca chegou antes (provado nas duas ordens).
- Agregados e expurgos: só as tabelas (escritor na PS-6, D-PS7).
- Fixtures: contrato ASSINADO mínimo gravado com `session_replication_role = replica` (precedente
  `lib/agenda/aplicador-100.postgres.test.ts`), numa transação própria; nada da 110 é gravado assim.
- ~~Resposta × cancelamento simulado em SQL~~ → **corrigido na rodada 2 (P2-2)**: ver a seção da rodada 2. A
  simulação em SQL da suíte de concorrência fica como prova complementar.
- ~~PARAR provado só pelas funções~~ → **corrigido na rodada 2 (P2-3)**: recepção e worker reais.
- PARAR depois de uma pesquisa criada **depois** do PARAR: a entrega de WhatsApp nasce PENDENTE; quem bloqueia é a
  revalidação do despacho (`elegivelParaMensagem` → `NAO_CONTATAR_ATENDIMENTO`). O despacho é da PS-2.
- Bug achado pela suíte e corrigido na 110: `CASE` com `NEW.envio_id` no gatilho de invariante falhava em
  `satisfacao_envios` (o PL/pgSQL resolve o campo ao planejar); agora ramos `IF` separados.
- Erro de configuração em produção (ex.: origem administrativa ausente) vira 500 genérico na rota pública, sem
  detalhe — falha fechada.

## Rodada 2 — correção dos P2 da revisão do Astra (REPROVADO sobre `a3c54dfd`)

Sobre o commit local `a3c54dfd` (sem push), alterações ainda sem commit.

| P2 | Correção | Prova |
|---|---|---|
| P2-1 saída nas telas respondida/vencida/revogada | `abrirPesquisa` devolve `ENCERRADA` (com o buffet) quando o envio existe e a identidade confere mas não está ATIVO; a página oferece "Não quero receber mais pesquisas" na tela respondida, no formulário e na indisponível com `podeSair`. Link adulterado/identidade divergente continua 404 genérico, sem saída | PG "saída pelo link respondido, vencido e revogado"; E2E 390 px nas três telas (outra entrega pendente do mesmo cliente encerrada) + "link adulterado: sem saída" |
| P2-2 cancelamento pelas entradas reais | Nova suíte `satisfacao-cancelamento.postgres.test.ts`: contrato formalizado sintético, gestor com `FESTA_CORRIGIR` e sessão; cancela pelo fluxo da Festa (`comandarFesta` → `cancelarContratacaoDaFesta`) e por `operarContrato`, nas duas ordens, com barreira e PIDs (`pg_blocking_pids`) | 5/5. Festa cancelamento primeiro → resposta 55P03 e envio REVOGADO/`CONTRATO_NAO_ASSINADO`; resposta primeiro → o cancelamento espera e a resposta fica gravada. **Achado:** `operarContrato` só cancela contrato `AGUARDANDO_ASSINATURA`; com contrato assinado (o único que tem pesquisa) recusa e manda para o fluxo da Festa — provado nas duas ordens. M01 (pais sem NOWAIT) agora morre pela espera identificada: "a resposta (pid X) esperou pela trava do cancelamento (pid Y) em: /* satisfacao:travar-pais */" |
| P2-3 PARAR pela recepção e pelo worker | **Achado e corrigido:** o PARAR reconhecido pelo worker (Wall-e e modelo) não suprimia as pesquisas. `suprimirPesquisasDoContato` (em `service.ts`) é chamada pela recepção, por `bloquearPorPedido` e pelo caminho do modelo, na mesma transação do bloqueio | Nova suíte `satisfacao-parar.postgres.test.ts` 6/6 no modelo 110: cliente identificado, número sem cliente + cliente vinculado depois + pesquisa criada depois do PARAR, cliente sem pesquisa, worker Wall-e, worker modelo (paráfrase). WhatsApp SUPRIMIDA:PARAR/inelegível, e-mail PENDENTE |
| P2-4 K1/K2 determinístico | Laço de 400 leituras trocado por barreira: a transferência do bloqueio é confirmada noutra conexão logo depois da primeira leitura das tabelas do atendimento, nas duas direções, pelo chamador real `elegivelParaMensagem`. Os casos de bloqueio da suíte principal também comparam `elegivelParaMensagem` | Mutantes M29a/M29b (dois SELECTs) e M30 (filtro de ambiente) MORTOS pela causa |
| P2-5 M15/M21/M22 comportamentais | Variantes M15b/M21b/M22b alteram, na cópia isolada e **antes** de recriar o modelo, a migration **e** a verificação correspondente do postcheck (restauradas no fim), para isolar a defesa comportamental; M15/M21/M22 seguem como controles estruturais separados e o postcheck da candidata não muda (correção do relato, R2-D1). Nova prova de M22: duas respostas na mesma transação com envio ATIVO → 23505 antes do COMMIT (verificado pelo nome da constraint) | M15b, M21b, M22b MORTOS pela prova de comportamento |

**Resultados da rodada 2 (todos locais, 30/10):**

| Prova | Resultado |
|---|---|
| PG `satisfacao.postgres.test.ts` | 23/23 |
| PG `satisfacao-concorrencia.postgres.test.ts` | 10/10 |
| PG `satisfacao-parar.postgres.test.ts` (novo) | 6/6 |
| PG `satisfacao-cancelamento.postgres.test.ts` (novo) | 5/5 |
| Regressão PG Marketing + WhatsApp + pesquisa + exportação | 44 arquivos, 51 execuções por modelo, 201 testes: 200 pass, 0 falhas, 1 skip declarado (salões combinados no modelo 103, sem 098/108) — `2026-10-30T19-20-31-553Z-check-v1-postgres.log` |
| Mutantes causais (clone LF isolado) | **38/38 MORTOS**, controle PASS; os 11 que declaram `causa` (M01, M15b, M21b, M22b, M29a, M29b, M30–M34) só contam com o subteste esperado falhando; os outros 27 contam por qualquer falha da suíte-alvo, com a causa conferida no relatório; M01 pela espera identificada — `2026-10-30T19-17-39-987Z-mutantes.txt` |
| CI local (todos os passos de `ci.yml`) | 34/34 |
| E2E Playwright 1366 e 390 px (depois do build da rodada 2) | 36/36 PASS — `2026-10-30T19-36-54-863Z-e2e/` (capturas `celular-6-saida-*.png`) |

Novos mutantes de PARAR: M31 (recepção sem supressão), M32 (worker Wall-e sem), M33 (worker modelo sem), M34 (PARAR
atinge o e-mail) — todos MORTOS. O script de mutantes passou a aceitar várias edições por mutante e, **para os mutantes que declaram o campo `causa`** (os 11 acima), a exigir
que o subteste esperado falhe para contar como morto.

## Rollback

Código: descartar a branch (só commit local `a3c54dfd`, sem push; a rodada 2 está sem commit). Banco: a 110 não foi aplicada fora do cluster descartável; o down
`database/rollback/20261030_110_satisfacao_pesquisa_down.sql` existe para quando houver aplicação autorizada.

## Próximos passos

1. ~~Revisão do Astra~~ — rodada 2 APROVADA COM RESSALVAS (30/10); R2-D1 (P3 documental) corrigido neste texto.
2. Commit da rodada 2, push e PR só quando Felipe pedir.
3. Herança para a PS-2: provar a revalidação no despacho antes de cada tentativa (cliente vinculado e pesquisa criados depois do PARAR), sem WhatsApp e com e-mail preservado.
4. PS-2 (despacho simulado, lembrete), PS-3, PS-4, PS-5 e PS-6 (expurgo) — a pesquisa não liga em produção sem a PS-6.

## Revisão independente Astra — rodada 2 — 30/10/2026

**Veredito: APROVADO COM RESSALVAS para a PS-1 local.** Zero P1/P2 remanescentes; um P3 documental (R2-D1). Escopo: diff sobre `a3c54dfde7cb7d4968f2bc2fa43c96f6ba6355d9`, incluindo os dois testes não rastreados. Nenhum código de produto ou teste corrigido pelo reviewer.

| Achado anterior | Resultado |
|---|---|
| P2-1 | Fechado. Identidade validada antes de ENCERRADA, saída nas telas reconhecidas e alcance nos dois canais. Serviço reexecutado; relatório E2E e capturas mobile conferidos. |
| P2-2 | Fechado. Entradas reais nas duas ordens, sessão/capacidades e espera observada por PIDs. Festa cancela; operarContrato recusa contrato assinado. M01 falha pela espera identificada no SQL dos pais nos testes reais; os timeouts adicionais da suíte complementar não são usados como essa prova. |
| P2-3 | Fechado no escopo PS-1. Recepção, Wall-e e modelo usam a mesma supressão na transação do bloqueio; e-mail preservado. Pesquisa posterior ao PARAR permanece PENDENTE, mas elegivelParaMensagem recusa. |
| P2-4 | Fechado. Barreira após a primeira leitura, transferência confirmada em outra conexão e chamador real. M29a/M29b liberam indevidamente; M30 perde bloqueio de staging. |
| P2-5 | Fechado na prova comportamental. M15b permite UPDATE terminal; M21b permite segundo envio; M22b permite segunda resposta antes do COMMIT. Logs contêm Missing expected rejection nos comandos pertinentes. Método documental: ressalva R2-D1. |

**R2-D1 — P3: descrição incorreta dos mutantes.** A tabela da rodada 2 diz que M15b/M21b/M22b mutam depois do postcheck. O script `ambientes-locais/satisfacao-ps1-mutantes.cjs:62–71` altera a migration e a verificação correspondente do postcheck na cópia isolada, antes de recriar o modelo; restaura os arquivos ao final. É um isolamento válido da defesa comportamental, mas precisa ser descrito assim. M15/M21/M22 continuam como controles estruturais separados. A exigência de `causa` também vale apenas para os mutantes que declaram esse campo (M01 e os novos desta rodada), não para todos os 38. Corrigir o relato sem alterar o postcheck da candidata. Achado registrado sem correção silenciosa do texto original.

A falta de supressão adiantada no worker era real e foi corrigida. A recusa de operarContrato é o contrato existente da aplicação, não regressão: pesquisas exigem contrato ASSINADO e seu cancelamento efetivo pertence à Festa. A fixture em modo replica prepara a formalização; não prova o fluxo de assinatura e não desliga as guardas da 110 durante as operações testadas.

O desvio de P2-3 é aceitável para a PS-1, que ainda não entrega pesquisas. A PS-2 deverá provar a revalidação no despacho antes de cada tentativa, incluindo cliente vinculado e pesquisa criados depois do PARAR, sem enviar WhatsApp e preservando o e-mail. As variantes sem cliente/sem pesquisa foram exercitadas pela recepção; Wall-e/modelo usam cliente com pesquisa. A função comum e o bloqueio por número sustentam a composição, mas a suíte não é uma matriz de todos os casos por todas as entradas.

Validação independente: unitários de satisfação + service + worker **72/72**; quatro suítes da 110 **23/23 + 10/10 + 6/6 + 5/5**. Log unitário: `ambientes-locais/revisao-astra-ps1-r2-unit.log`. Bateria independente PostgreSQL (satisfação + atendimento/WhatsApp): **35 execuções, 75/75 testes, zero falhas e zero skips**, modelos recriados do schema vazio. Relatório: `ambientes-locais/pg-descartavel-satisfacao-ps1-relatorios/2026-10-30T19-45-01-119Z-check-v1-postgres.log`. Cluster **encerrado e conferido** (pg_ctl status 3, sem postmaster.pid). Nenhuma regressão identificada em service.ts/worker.ts no escopo revisado. Conferidos os logs de M01, M15b/M21b/M22b, M29a/M29b/M30 e M31–M34 e 112 arquivos relevantes iguais entre candidata e clone de mutantes (normalizando apenas CRLF). Mutantes, CI 34/34 e E2E 36/36 auditados por arquivos/logs, não reexecutados nesta revisão.

Somente local, cluster sintético autorizado 127.0.0.1:55551. Sem staging, produção, Render, push, commit ou envio real. A aprovação não libera publicação nem substitui PS-2 a PS-6. Próximos passos: corrigir R2-D1; commit somente quando autorizado; cumprir os gates de despacho da PS-2 e expurgo da PS-6.

## PS-2 — criação pelo motor e despacho simulado — LOCAL, sem commit (30/10/2026)

**Estado (31/10): PS-2 rodada 2 APROVADA COM RESSALVAS pelo Astra; as duas ressalvas P3 fechadas LOCAL, sem commit** (seções
"PS-2 — rodada 2" e "PS-2 — ressalvas P3 da rodada 2 fechadas" no fim). Histórico: PS-2 implementada LOCAL sobre `1c8e68ed`, sem commit. Sem push, PR, staging,
produção, Render ou envio real. Transportes só simulados (WhatsApp → `marketing_transporte_simulado`; e-mail →
`satisfacao_email_simulado`); qualquer outro valor de `MARKETING_TRANSPORTE`/`SATISFACAO_EMAIL_TRANSPORTE` recusa (503
`TRANSPORTE_NAO_CONFIGURADO`), sem fallback.

| Parte | Arquivos |
|---|---|
| Regra | `regras.ts` (ação `PESQUISA_SATISFACAO` só no `POS_FESTA`, canais, texto e modelo do lembrete, textos padrão), `modelo.ts` (`validarModeloPesquisa`: `{{link_pesquisa}}` exatamente uma vez; PARAR só com WhatsApp), `supressao.ts` (`suprimirEntregasDaRegra`: pausa → REGRA_PAUSADA) |
| Motor | `motor.ts` (planeja a pesquisa só com contexto ligado e 110 instalada; `decidirPesquisa` cria o envio → `PESQUISA_CRIADA`; supressões de criação `PESQUISA_JA_EXISTE` → `CONTATO_POS_FESTA_JA_FEITO` → `LIMITE_FREQUENCIA`; Mensagem simples pós-festa suprimida se a festa já tem pesquisa; `comRepeticao` em toda decisão; `PAIS_OCUPADOS` devolve à fila), `alvos.ts` (precedência da regra da unidade), `frequencia.ts` (extraído do motor, sem ciclo de import) |
| Despacho | `lib/satisfacao/despacho.ts` (worker por entrega, duas fases: revalida e confirma ENVIANDO antes da rede; conclui com conferência de posse; lembrete único por canal; posse vencida → INCERTA; retorno do provedor pela porta do Marketing), `lib/satisfacao/transporte.ts` (simulados + seleção do ambiente) |
| Rotas e tela | `processar/route.ts` e `admin/marketing/automacoes/route.ts` passam o contexto da pesquisa ao ciclo; painel com caixa de e-mails simulados; `MarketingAutomacoes.tsx` (ação, passo "Canais", textos do WhatsApp com prévia, revisão dos dois textos) |

**Revalidação herdada do Astra (P2-3/R2):** cada tentativa refaz, na transação que trava cliente → envio → entrega →
pais (NOWAIT): envio ativo/respondido/revogado/vencido, festa e contrato, regra ATIVA com a mesma ação e o canal, empresa
apta, prazos (24 h antes de expirar; 48 h do segundo canal), janela, descadastro, saída das pesquisas, cliente ativo,
consentimento do canal (WhatsApp: `elegivelParaMensagem`, que inclui PARAR/não contatar do número; e-mail válido),
frequência (só INICIAL), modelo revisado e segredo do link. Prova: P6 da suíte PARAR (as entregas de P1–P5, inclusive
pesquisa e cliente criados DEPOIS do PARAR, despachadas pelo worker real: 0 WhatsApp, 5 e-mails) e D2.

### Desvios declarados (PS-2)

- `List-Unsubscribe` fica para o transporte real de e-mail (o simulado não tem cabeçalhos); o e-mail traz a saída pela
  página da pesquisa.
- O texto do e-mail é do sistema (não editável na regra); só o WhatsApp usa os textos revisados.
- `replyTo` vem de `contatoPublicoDaEmpresa`: o e-mail da unidade não está mapeado no estabelecimento.
- `processarReservada` passou a envolver as decisões em `comRepeticao`: um 40P01 (deadlock) é repetido uma vez para
  TODAS as ações do Marketing, não só a pesquisa.
- Lembrete: todos os canais herdam o horário do PRIMEIRO lembrete agendado (`proximoHorarioPermitido(aceite + 3 d)`),
  e só o canal cuja INICIAL foi ACEITA ganha lembrete.

### Resultados da PS-2 (todos locais, cluster descartável 127.0.0.1:55551, 30–31/10)

| Prova | Resultado |
|---|---|
| Unitários `lib/satisfacao/satisfacao.test.ts` | 10/10 (+3: e-mail com 11 notas e versão gravável, transporte só simulado, `validarModeloPesquisa`); unitários do Marketing 48/48 |
| Suíte nova `satisfacao-despacho.postgres.test.ts` | 17/17 (M1–M3, D1–D13; três conexões; `fetch`/`http`/`https` contados: 0 chamadas de rede) |
| Suíte PARAR com P6 | 7/7 (P6: 0 WhatsApp, 5 e-mails depois do PARAR) |
| Regressão PG completa | 237/239 arquivos OK (1627 testes pass, 243 skip). As 2 falhas são `lib/assinatura/kidmais-gratuidade.postgres.test.ts` [079] e [079-sem-atendimento]: herdadas da base `d8943742` (`.test-apoio` chamando `iniciarTeste`), corrigidas pela #277 em staging depois da base; nada da PS-2. Relatório `pg-descartavel-satisfacao-ps1-relatorios/2026-10-31T02-17-35-826Z-check-v1-postgres.log` |
| Mutantes (clone LF isolado) | **46/46 MORTOS** em três rodadas, controle PASS em cada uma: M01–M11 (`mutantes-ps2-parte1.log`), M12–M34 + M28 (`2026-10-31T03-18-16-714Z-mutantes.txt`), M35–M42 (`2026-10-31T03-22-04-298Z-mutantes.txt`). Novos da PS-2, todos com `causa`: M35 sem revalidação do WhatsApp (P6), M36 lembrete conta frequência (D3), M37 sem UNIQUE da entrega (D3), M38 conclusão sem conferir posse (D5), M39 sem prazo de 24 h (D8), M40 sem precedência da unidade (M2), M41 criação sem `PESQUISA_JA_EXISTE` (M3), M42 Mensagem simples com pesquisa (M2) |
| CI local (todos os passos do `ci.yml`) | 34/34 |
| E2E PS-2 (`ambientes-locais/satisfacao-ps2-e2e.cjs`) | 14/14: regra configurada pela tela (texto padrão, canais, recusa sem `{{link_pesquisa}}`, dois modelos, janela), revisão com os dois textos, ativação, "Processar agora" → pesquisa criada e entregue nos dois canais, lembretes agendados, caixa de e-mails simulados com marcador e endereço mascarado, nenhum link real na página/banco/log, 390 px sem rolagem, nenhuma requisição a terceiros. Relatório `2026-10-31T03-48-30-280Z-e2e-ps2` |
| E2E PS-1 (página pública) | 36/36 de novo (`2026-10-31T03-49-06-662Z-e2e`) |

**Achados da própria rodada (corrigidos antes da entrega):** a primeira passada de mutantes deixou M36, M38 e M41
VIVOS e M37 morto só por acaso. Causas: (1) D3 só tinha o contato da própria pesquisa (excluído por `excetoEnvioId`),
então a exceção do lembrete nunca era exercida — agora há uma Mensagem automática recente de outra festa; (2) nenhuma
prova de conclusão tardia — D5 ganhou o envio lento cuja posse é recuperada (INCERTA) durante a chamada e não vira
ACEITA; (3) a ordem `PESQUISA_JA_EXISTE` antes da frequência não era observada — M3 ganhou a festa cuja pesquisa já
saiu; (4) D3 também prova que o banco recusa um segundo lembrete do mesmo canal (23505). E um flake de relógio no M2
(o `ciclo()` usava o relógio do Node, alguns ms atrás do `clock_timestamp()` do banco): agora +1 s, como `despachar`.

A regressão PG completa rodou ANTES desse reforço (que só mexeu em testes); depois dele, a suíte da PS-2 (17/17), o
controle dos mutantes (as cinco suítes da 110 + unitários) e o CI 34/34 rodaram de novo e passaram.

**Cluster:** encerrado e conferido (pg_ctl status 3, sem postmaster.pid). Nenhum commit da PS-2; nada publicado.

### Rollback da PS-2

Código: descartar as alterações sem commit do clone (a PS-1 continua em `1c8e68ed`). Banco: a PS-2 não tem migration.
Operação: `SATISFACAO_PESQUISA_ENABLED` desligado → o ciclo não planeja nem despacha pesquisa (M1).

### Próximos passos

1. Revisão do Astra sobre a árvore sem commit acima de `1c8e68ed`.
2. Commit local da PS-2 só com autorização de Felipe; push/PR depois, também com autorização.
3. PS-3 a PS-6 (a pesquisa não liga em produção sem a PS-6/expurgo). `List-Unsubscribe` e transporte real de e-mail
   ficam para quando houver adaptador real.

## Revisão independente Astra — PS-2 — 31/10/2026

**Veredito: REPROVADO para a PS-2 local.** Três P2, nenhum P1. Revisão dos 18 arquivos sem commit acima de 1c8e68ed, branch codex/satisfacao-ps1-20261030. Código e testes preservados. Os três achados abaixo decorrem da análise do protocolo; as novas intercalações não foram reproduzidas em PG nesta rodada.

1. **PS2-R1 — P2 — O1 pode mudar entre a leitura e ENVIANDO** (lib/satisfacao/despacho.ts:138, 185–194, 234–239). A trava por cliente é advisory; não trava a linha de clientes. Depois de elegivelParaMensagem devolver o destino autorizado, outra transação pode retirar telefone/WhatsApp do cadastro e confirmar a revogação pelo gatilho marketing_aut_numero_saiu da 086, enquanto preparar continua. O worker ainda grava ENVIANDO e chama o transporte com o destino retirado. A edição do cadastro não usa esse advisory e o gatilho não suprime a entrega. Correção: coordenar a leitura decisória com a mesma trava de linha usada pelas alterações do cadastro, mantida até confirmar ENVIANDO; definir a ordem comum para não inverter as travas de revogação/supressão. Provar edição primeiro e despacho primeiro com duas conexões e barreiras; e-mail preservado. P6/D2 provam o bloqueio já confirmado antes da tentativa, não esta corrida.

2. **PS2-R2 — P2 — relógio do ciclo usado como horário da tentativa e do aceite** (lib/satisfacao/despacho.ts:174–175, 260, 332–333; motor.ts:320–323). O mesmo agora recebido no início do ciclo atravessa planejamento, esperas e todas as entregas. Ciclo iniciado às 17:59 pode continuar despachando às 18:01 numa janela que fecha às 18:00, pois dentroDaJanela ainda recebe 17:59. O lembrete também usa início do ciclo + 3 dias, não o instante do primeiro aceite; se o atraso atravessa a abertura da janela, o arredondamento pode adiantar o lembrete materialmente. Correção: relógio injetável consultado novamente depois das esperas, em cada tentativa; calcular a âncora do lembrete no aceite efetivo e preservá-la para os canais seguintes. Provar passagem pelo fim da janela e aceite atrasado. D9 usa o mesmo instante na chamada e na expectativa, por isso não detecta a diferença.

3. **PS2-R3 — P2 — recuperação de posse inverte a ordem da conclusão** (lib/satisfacao/despacho.ts:247–251, 304, 308–312; database/migrations/20261030_110_satisfacao_pesquisa.sql:389–396). A conclusão trava envio e depois entrega. A recuperação faz UPDATE da entrega primeiro; na primeira INICIAL com contato_em nulo, o gatilho tenta atualizar o envio. Se a conclusão já segura o envio e a recuperação segura a entrega, ambas esperam uma pela outra (40P01). Nenhuma dessas duas transações está em comRepeticao. Se a conclusão for abortada, perde-se o aceite recebido, o ciclo falha e a entrega fica INCERTA sem lembrete. Correção: recuperação seguindo a mesma ordem cliente → envio → entrega, com rechecagem da posse; tratar deadlock na transação de conclusão sem repetir a chamada ao transporte. Provar a disputa com barreiras nas duas conexões. D5 conclui a recuperação dentro do transporte antes de iniciar a conclusão, portanto prova posse perdida, mas não esta corrida.

**O que está comprovado:** herança P2-3/R2 fechada para PARAR confirmado antes do despacho, incluindo cliente/pesquisa posteriores (P6: zero WhatsApp, cinco e-mails). D3, D5 e M3 reforçados verificam efeitos reais: lembretes aceitos apesar de outra mensagem recente; resultado tardio mantém INCERTA e não cria lembrete; PESQUISA_JA_EXISTE prevalece sobre frequência. M36/M38/M41 falham precisamente nesses efeitos nos logs finais. M35 falha em P6. UNIQUE, DO NOTHING, transporte simulado sem fallback, marcador no conteúdo, canais e revisão dos dois textos estão presentes.

**Reexecutado pelo reviewer:** satisfação unitária 10/10; todos os unitários de lib/marketing 62/62 (72 testes únicos, zero falhas/skips); PS-2 PG 17/17 e PARAR PG 7/7, modelo 110 recriado do schema vazio pelo driver autorizado. O primeiro comando unitário de automações/explicação também passou 12/12, incluídos nos 62. Diff-check limpo. Log Marketing: ambientes-locais/revisao-astra-ps2-unit-marketing.log. PG: ambientes-locais/pg-descartavel-satisfacao-ps1-relatorios/2026-10-31T09-14-36-304Z-check-v1-postgres.log.

**Auditado, não reexecutado:** mutantes 46/46 pelo conjunto das três rodadas (a intermediária contém os três sobreviventes corrigidos na última); CI com 34 comandos de código 0 e npm ci explicitamente pulado; E2E PS-2 14/14 e PS-1 36/36 pelos relatórios, captura mobile inspecionada com limitação de escala. Comparação candidata × clone LF: 16 dos 17 arquivos de código/teste coincidem normalizando CRLF; a única diferença é a declaração de tipo recuperarPossesEntregas acrescentada na candidata, sem diferença executável.

**Regressão 237/239:** confirmadas as duas falhas de gratuidade nos modelos 079 e 079-sem-atendimento, ambas pela inclusão do apoio renovacao-109 na varredura de iniciarTeste. Os dois arquivos pertinentes são idênticos aos de d8943742. A correção foi conferida no objeto Git LOCAL a9441fb0 (#277), no clone kidmais-manager-gratuidade-apoio-20261030: exclusão de .test-apoio e guarda textual adicional. Nenhum acesso a staging/remoto foi feito; não houve reexecução integral da regressão.

**Desvios:** List-Unsubscribe adiado é aceitável apenas para o transporte simulado, com pendência explícita antes de envio real; texto de e-mail do sistema e replyTo da empresa são aceitáveis no escopo local declarado. Repetição única de 40P01 para todas as decisões do Marketing é aceitável por abranger a transação anterior ao transporte. Compartilhar o horário do primeiro lembrete é coerente com um lembrete por canal, mas não corrige a âncora temporal de PS2-R2.

**Cluster encerrado e confirmado:** pg_ctl status 3, postmaster.pid ausente e nenhuma escuta em 55551, conforme driver. A primeira tentativa dentro do sandbox recebeu EACCES; o driver encerrou o processo que havia iniciado, e a reexecução autorizada fora do sandbox completou normalmente. Sem staging, produção, Render, push, commit ou envio real. Próximo: corrigir PS2-R1/R2/R3 e acrescentar provas determinísticas antes de nova revisão; nenhum código/teste corrigido pelo reviewer.

## PS-2 — rodada 2 (correção de PS2-R1..R3) — LOCAL, sem commit (31/10/2026)

**Estado: rodada 2 LOCAL concluída sobre `1c8e68ed`, sem commit, aguardando o Astra.** Sem push, PR, staging, produção,
Render ou envio real; sem migration nova. Arquivos mexidos nesta rodada: `lib/satisfacao/despacho.ts`,
`lib/satisfacao/travas.ts` (só o cabeçalho) e `lib/satisfacao/satisfacao-despacho.postgres.test.ts`; ferramenta
`ambientes-locais/satisfacao-ps1-mutantes.cjs` (M43–M47).

**Ordem de travas comum às três transações do despacho** (preparo, conclusão, recuperação de posse): trava por cliente
(advisory) → `clientes` FOR SHARE → envio FOR UPDATE → entrega FOR UPDATE (→ pais NOWAIT, só no preparo). Cada uma
tem um marcador SQL (`satisfacao:preparar`, `satisfacao:concluir`, `satisfacao:recuperar-posse`,
`satisfacao:travar-cliente`, `satisfacao:travar-envio`), usado pelas barreiras dos testes.

| Achado | Correção | Prova (barreiras com `pg_blocking_pids` + trecho da consulta) |
|---|---|---|
| PS2-R1 (O1 muda entre leitura e ENVIANDO) | O preparo trava a linha do cliente FOR SHARE logo depois da trava por cliente e a mantém até confirmar ENVIANDO. Edição do cadastro (UPDATE) e revogação/descadastro (`alterarPreferencia`: cliente FOR UPDATE → autorizações → entregas) conflitam com ela: ou esperam o preparo, ou o preparo espera e relê o que confirmaram. Mesma ordem cliente → entregas da revogação: sem inversão. | **R2-1**: (A1) edição do WhatsApp em aberto → o despacho fica preso em `travar-cliente`; depois do COMMIT relê, o gatilho `marketing_aut_numero_saiu` (086) já revogou → SUPRIMIDA `SEM_AUTORIZACAO`, 0 WhatsApp; (A2) revogação em aberto → despacho preso em `travar-cliente` → IGNORADA (a revogação suprimiu), 0 WhatsApp; (B, edição e revogação) o despacho já tem o cliente e está parado no envio (c3) → a mudança fica presa no despacho (`clientes`) → o despacho conclui ACEITA com o número que valia, 1 WhatsApp, e só então o cadastro muda. |
| PS2-R2 (relógio do ciclo) | `ContextoPesquisa.relogio` (padrão: relógio do processo). `despacharEntrega` lê o relógio em cada transação DEPOIS das travas (preparo: "devida" e janela; conclusão: âncora do lembrete = instante do aceite). `executarEntregas` usa o `agora` do ciclo só para escolher o que recuperar/tentar; não o passa às tentativas. O segundo canal continua herdando o horário do primeiro lembrete (COALESCE), agora ancorado no aceite. `despacharEntrega(…, agora)` explícito segue para testes. | **R2-2**: (a) tentativa presa na trava por cliente com o relógio em 17:59; solta às 18:01 → REAGENDADA, 0 e-mail; (b) transporte lento de 1 h → lembrete = aceite (11:00) + 3 dias, não preparo + 3 dias; (c) ciclo com `agora` 17:59 e relógio da tentativa 18:01 → a entrega fica PENDENTE (reagendada), 0 e-mail. |
| PS2-R3 (recuperação × conclusão) | `recuperarPossesEntregas(banco, agora, empresa)` escolhe as vencidas e trata uma por transação na ordem comum, reconferindo `ENVIANDO` e posse vencida sob as travas (nunca entrega → envio). A conclusão roda em `comRepeticao` (40P01 uma vez): só a transação é repetida, o transporte nunca. | **R2-3**, nas duas ordens: c3 segura a trava por cliente; recuperação (c2) e conclusão (c1) observadas esperando por ela; COMMIT → recuperação primeiro: POSSE_PERDIDA + INCERTA `POSSE_VENCIDA_DURANTE_ENVIO`, sem lembrete; conclusão primeiro: ACEITA + 1 lembrete e a recuperação não mexe. Sem 40P01; um e-mail na caixa nos dois casos. |

**Resultados da rodada 2 (cluster 127.0.0.1:55551, 31/10):**

| Prova | Resultado |
|---|---|
| Suíte PS-2 `satisfacao-despacho.postgres.test.ts` | **20/20** (17 + R2-1, R2-2, R2-3) |
| Suítes da 110 afetadas pela ordem | PARAR 7/7, concorrência 10/10, cancelamento 5/5 (`2026-10-31T09-50-08-731Z-check-v1-postgres.log`) |
| Unitários | satisfação 10/10 (+ dentro do controle dos mutantes) |
| Mutantes novos (clone LF) | **5/5 MORTOS, controle PASS** (unitários + as cinco suítes PG da 110), todos com `causa`: M43 sem `clientes FOR SHARE` (R2-1), M44 relógio lido uma vez antes das travas (R2-2), M45 ciclo passa o seu `agora` às tentativas (R2-2c), M46 lembrete com o relógio do processo em vez do da tentativa (R2-2b), M47 recuperação sem a ordem comum (R2-3). `2026-10-31T09-57-46-849Z-mutantes.txt`. Total da PS-2: 46 + 5 = 51/51 |
| Regressão PG completa | 236/239 na passada completa (`2026-10-31T09-57-58-572Z-check-v1-postgres.log`): as 2 falhas herdadas de gratuidade (079 e 079-sem-atendimento, corrigidas pela #277) e `lib/agenda/aplicador-098.postgres.test.ts [097]` ("aplicador esperando o lock da 098; terminou antes"), barreira de tempo que rodou junto com o CI; repetida sozinha: **PASS** (`2026-10-31T10-58-40-939Z-check-v1-postgres.log`). Nenhum arquivo de `lib/agenda` alterado. Resultado efetivo: 237/239 como na rodada 1 |
| CI local (todos os passos do `ci.yml`) | 34/34 |
| E2E PS-2 / PS-1 | 14/14 (`2026-10-31T11-01-26-665Z-e2e-ps2`) / 36/36 (`2026-10-31T11-02-49-035Z-e2e`) |

**Achados da própria rodada:** (1) a 1ª passada do R2-1 esperava `SEM_AUTORIZACAO_DESTINO` na edição do número; o
gatilho 086 revoga a autorização do número que saiu, então o motivo relido é `SEM_AUTORIZACAO` (asserção corrigida, a
prova de espera não mudou); (2) M1 passou a falhar quando o `ciclo()` do teste andava +1 s e as tentativas liam o relógio
real: o contexto do teste leva o mesmo relógio +1 s (só teste); (3) D13 agora devolve a regra à pesquisa ao final; as
barreiras R2 desfazem a transação de c3 em caso de falha para não prender os testes seguintes.

**Não coberto / declarado:** a repetição da conclusão em 40P01 não tem prova determinística (com a ordem comum, o ciclo
com a recuperação deixou de existir; a repetição é defesa contra outros caminhos). Observação fora do escopo: a decisão
da Mensagem simples do Marketing (`MENSAGEM_WHATSAPP`, PS anterior) também lê `clientes`/autorizações sem travar a
linha do cliente; não foi alterada nesta rodada.

**Cluster:** encerrado e conferido (pg_ctl status 3, sem postmaster.pid). Nenhum commit; nada publicado.

**Rollback da rodada 2:** descartar as alterações sem commit (a rodada 1 não foi commitada; a PS-1 continua em
`1c8e68ed`). Sem migration.


## Revisão independente — PS-2 rodada 2 — 31/10/2026

**Veredito: APROVADA COM RESSALVAS para o escopo LOCAL e simulado. PS2-R1, PS2-R2 e PS2-R3 fechados. Nenhum P1/P2 novo identificado; duas ressalvas P3 de cobertura/precisão das evidências.** Não autoriza commit, publicação nem envio real.

Revisão da árvore sem commit sobre `1c8e68ed80ddbef4978acd80129070b236c7df92`, branch `codex/satisfacao-ps1-20261030`, clone `D:/glass/KidMais Manager/kidmais-manager-satisfacao-ps1-20261030`. Nenhum código ou teste da candidata foi alterado pelo reviewer. Este parecer prevalece sobre o estado histórico “aguardando revisão” da rodada 2; a reprovação anterior permanece como histórico.

### Fechamento dos três P2

- **PS2-R1 fechado.** `travarCliente` adquire advisory e `clientes FOR SHARE` antes de envio/entrega. A trava dura até o COMMIT de ENVIANDO e conflita tanto com UPDATE cadastral quanto com FOR UPDATE de `alterarPreferencia`. R2-1 observa o bloqueador e a consulta por `pg_blocking_pids`/`pg_stat_activity`, nas duas ordens, sem depender de sleep para estabelecer a ordem. A1 comprova a releitura e SEM_AUTORIZACAO pelo gatilho 086; A2 comprova a supressão pela revogação. Na ordem B, o preparo já segura o cliente quando a alteração fica bloqueada. A alteração pode confirmar depois do preparo e antes da conclusão do transporte: o ponto de serialização é ENVIANDO, não ACEITA. A edição no teste é SQL direto; o serviço administrativo também começa com cliente FOR UPDATE (`cliente.service.ts:423`), conferido por leitura. No harness independente, acrescentei assert do telefone efetivamente passado ao transporte nas duas variantes B: PASS.
- **PS2-R2 fechado.** O relógio é consultado após adquirir cliente/envio/entrega, dentro de cada tentativa; o ciclo não repassa seu instante ao despacho. R2-2 distingue espera até fora da janela, aceite uma hora depois e instante antigo do ciclo. A conclusão calcula o lembrete a partir da leitura atual, e o segundo canal herda a agenda existente. Pais usam NOWAIT, portanto não acrescentam espera bloqueante após essa leitura. Não se promete atomicidade entre relógio civil e a chamada externa após COMMIT.
- **PS2-R3 fechado.** Recuperação seleciona sem travar e depois processa cada entrega em transação, adquirindo advisory → cliente → envio antes de atualizar a entrega; reconfere estado e vencimento da posse. O antigo ciclo entrega → envio foi removido. R2-3 estabelece quem entrou primeiro na fila do advisory, observa ambos bloqueados por c3 e confere os dois resultados finais, inclusive uma única saída e lembrete somente quando a conclusão vence. Isso comprova a serialização pelo advisory, não observa isoladamente toda a ordem das travas de linha. A ordem restante foi conferida no código. O harness independente recusou qualquer chamada a `aoRepetir` nos dois participantes: ambas as ordens passaram sem retry.

### Repetição da conclusão: prova adicional independente

Harness separado em `D:/glass/KidMais Manager/ambientes-locais/revisao-ps2-r2-extra.test.ts`, derivado da suíte candidata sem editar seus arquivos. Injeção SQL `RAISE EXCEPTION ... ERRCODE = '40P01'` imediatamente depois do UPDATE para ACEITA, dentro da transação real:

- Uma falha: rollback, exatamente uma repetição, ACEITA e um lembrete; uma chamada ao transporte e um e-mail na caixa.
- Duas falhas: exatamente uma repetição, segundo 40P01 propagado, estado ENVIANDO e zero lembretes; posse vencida recuperada como INCERTA, sem nova chamada ao transporte.

PASS. É injeção determinística de SQLSTATE com aborto real da transação, **não** um deadlock provocado entre sessões. Fecha a lacuna declarada de teste da política de repetição. A primeira execução do harness adicional falhou por erro 42601 no SQL gerado pelo reviewer; corrigida a interpolação do gerador, as duas execuções seguintes passaram. Não foi defeito da candidata.

### Inventário de esperas

Não identifiquei novo ciclo introduzido pela ordem comum nos caminhos examinados:

- Resposta: envio → pais NOWAIT → resposta/entregas. Não pede advisory nem cliente FOR UPDATE. Saída: envio → INSERT da saída (FK usa KEY SHARE no cliente, compatível com SHARE do despacho) → supressões. A saída não usa `travarPais`; o cabeçalho de `travas.ts` agrupa resposta/saída de forma simplificada.
- PARAR: travas próprias do atendimento → supressão de entregas PENDENTE. O despacho lê controles/conversas sem pedir suas travas de linha; a supressão de PENDENTE não dispara o gatilho de marco de ACEITA/INCERTA.
- Cancelamento: fechamento → contrato; a pesquisa usa NOWAIT nos pais, desfazendo a tentativa quando ocupados. As duas entradas reais foram reexecutadas.
- Motor: execução → advisory → pais NOWAIT/criação. Despacho não solicita FOR UPDATE da execução; consulta regra/execução sem trava bloqueante. Revogação/descadastro começam pelo cliente e suprimem pendentes; a decisão do motor opera execução já reservada como PROCESSANDO, enquanto a supressão de execuções filtra AGENDADA. Não confundir esse predicado com atualização incondicional de qualquer execução.
- Edição administrativa e preferências: cliente primeiro; despacho não espera autorizações sob FOR UPDATE. Gatilho de saída do número permanece dentro da edição. O retorno do provedor atua em ACEITA e não dispara o marco ENVIANDO → ACEITA/INCERTA.

Conclusão limitada aos caminhos e predicados lidos, apoiada nas suítes e barreiras descritas; não é prova formal da inexistência de deadlocks em toda a aplicação. A leitura cadastral da Mensagem simples continua fora do escopo solicitado.

### Mutantes e ressalvas P3

**PS2-R2-P3-1 — Precisar o alcance de M47.** Auditei o script e os logs completos M43–M47, sem reexecutar os mutantes. Os 31 arquivos `.ts` de `lib/satisfacao` e `lib/marketing/automacoes` coincidem entre candidata e clone de mutantes, normalizando CRLF. Controle PASS consta no relatório `2026-10-31T09-57-46-849Z-mutantes.txt`.

| Mutante | Falha observada | Conclusão |
|---|---|---|
| M43 | ausência do bloqueio em `satisfacao:travar-cliente`, R2-1 A1 | Causal para retirada de FOR SHARE; falha da barreira, não timeout SQL. |
| M44 | ACEITA em vez de REAGENDADA, R2-2(a) | Causal para relógio capturado antes da espera. |
| M45 | ACEITA em vez de PENDENTE, R2-2(c) | Causal para propagação do instante do ciclo. |
| M46 | data do lembrete diferente, R2-2(b) | Causal para ignorar o relógio injetado do aceite; não restaura literalmente o relógio antigo do preparo. |
| M47 | ausência do bloqueio em `satisfacao:recuperar-posse`, R2-3 | Causal para remover advisory/cliente; mantém envio antes da entrega. Não demonstra que um mutante com entrega antes do envio morreria por 40P01. |

Os cinco morrem pelas alterações feitas, mas o regex `causa` só exige o nome do subteste; sozinho não garante o mecanismo. Recomendo descrever M47 como prova do protocolo de serialização e acrescentar separadamente um mutante/barreira específico para a ordem envio/entrega. Isso não reabre o defeito original, cujo código foi corrigido e cuja serialização foi reexecutada.

**PS2-R2-P3-2 — Incorporar as verificações hoje externas.** A suíte candidata R2-1 B conta WhatsApps, mas não compara o destinatário; R2-3 não monitora `aoRepetir`, portanto o rótulo “sem 40P01” não decorre apenas do PASS original. Incorporar o assert de destino, zero retries em R2-3 e os dois casos de injeção 40P01 à suíte permanente. O reviewer confirmou todos no harness independente; são lacunas de regressão, não falhas funcionais observadas. Ajustar também o cabeçalho para distinguir saída de resposta.

### O que foi reexecutado

- Driver autorizado, modelo 110 recriado do schema vazio: PS-2 **20/20**, PARAR **7/7**, concorrência **10/10**, cancelamento **5/5**; zero falhas/skips. Log: `ambientes-locais/pg-descartavel-satisfacao-ps1-relatorios/2026-10-31T11-11-07-386Z-check-v1-postgres.log`.
- Harness independente final: **21/21**, incluindo a suíte candidata, destinatário efetivo, recusa de retry em R2-3 e os dois casos de 40P01. Log: `ambientes-locais/revisao-ps2-r2-extra.log`. Os 20 testes herdados são repetição, não cobertura nova somável à bateria anterior.
- Unitários de satisfação: **10/10**, zero falhas/skips. `git diff --check` limpo antes do registro documental.
- CI, E2E e regressão completa **não reexecutados nesta revisão**. Os totais declarados não foram usados como prova independente de ausência de corridas. Não revalidei nesta rodada a atribuição da falha do aplicador 098 à execução paralela.

Somente PostgreSQL descartável `127.0.0.1:55551`, identidade provada pelo driver; sem 5432/5433, staging, produção, Render, commit, push, PR ou envio real. Encerramento pelo mesmo driver conferido ao fim e registrado junto às evidências locais.

## PS-2 — ressalvas P3 da rodada 2 fechadas — LOCAL, sem commit (31/10/2026)

**Estado: LOCAL, sem commit, sobre `1c8e68ed`; nada publicado.** Só testes, a ferramenta de mutantes, um marcador SQL e
o cabeçalho de `travas.ts`: o comportamento do despacho não mudou.

| Ressalva | Fechamento |
|---|---|
| PS2-R2-P3-1 (M47 prova a serialização, não a ordem envio → entrega) | M47 fica descrito como prova do protocolo de serialização pela trava por cliente. Novo **R2-5**: c3 imita a conclusão (envio FOR UPDATE, depois entrega FOR UPDATE) sobre a primeira INICIAL (contato_em nulo, o gatilho do marco mexeria no envio); a recuperação tem de ficar presa no envio (`/* satisfacao:recuperar-envio */`) sem segurar a entrega, e c3 obtém a entrega na hora; recuperação 1, INCERTA, nenhuma repetição, conclusão tardia POSSE_PERDIDA, um e-mail. Novo **M48** (recuperação sem o envio antes da entrega) **MORTO por 40P01 real**: em ~1 s (deadlock_timeout) a recuperação recebeu 40P01 e a asserção "nenhum 40P01 na recuperação" falhou com `['40P01']` (`ultimo-M48-recuperacao-entrega-antes-do-envio.log`). |
| PS2-R2-P3-2 (verificações externas para a suíte) | R2-1 ordem B confere o número entregue ao transporte (`[b.telefone]`, edição e revogação). R2-3 conta `aoRepetir` na conclusão e na recuperação e exige zero repetições nas duas ordens. Novo **R2-4**: 40P01 injetado (`RAISE … ERRCODE '40P01'`) logo depois do UPDATE para ACEITA, dentro da transação real — 1 falha: uma repetição, ACEITA, 1 lembrete; 2 falhas: uma repetição, 40P01 propagado, ENVIANDO sem lembrete, posse vencida → INCERTA; transporte chamado uma vez em ambos. Injeção de SQLSTATE, não deadlock entre sessões (como no harness do Astra). Cabeçalho de `travas.ts` separa resposta (envio → pais NOWAIT) de saída (envio → INSERT com KEY SHARE no cliente → supressões, sem pais). |

| Prova | Resultado |
|---|---|
| Suíte PS-2 | **22/22** (20 + R2-4, R2-5), três vezes seguidas (R2-3 ~80 ms, R2-4 ~40 ms, R2-5 ~30 ms; a 1ª passada levou 7–10 s em R2-3/R2-4, não repetido) |
| Mutantes M43–M48 (clone LF) | **6/6 MORTOS**, controle PASS (unitários + as cinco suítes PG da 110), `2026-10-31T11-29-18-679Z-mutantes.txt`; total da PS-2 52/52 |
| CI local | 34/34 |
| Não reexecutado | regressão PG completa e E2E: nada fora de `lib/satisfacao` mudou desde a rodada 2 além de testes/ferramenta (o despacho só ganhou um comentário SQL); o controle dos mutantes cobre as cinco suítes da 110 |

**Cluster:** encerrado pelo driver. Nenhum commit; nada publicado.

## PS-3 — links de avaliação, retornos das notas baixas e auditoria (111) — LOCAL, sem commit (31/10/2026)

**Estado: LOCAL, sem commit, sobre o merge local `5dfdff55`; nada publicado.** Implementa o plano PS-3 rev. 2 + rev. 2.1 +
precisões PS3-R21-P3-1/P3-2. A 111 só foi aplicada no cluster descartável (127.0.0.1:55551, já encerrado). Número 111 proposto.

### O que entrega

| Peça | Arquivos |
|---|---|
| Migration 111 (links por empresa/unidade com `UNIQUE NULLS NOT DISTINCT`, CHECK de URL, guarda de identidade; auditoria só de acréscimo com UPDATE/DELETE/TRUNCATE recusados e coerência da conclusão), pré/pós-check e volta com captura confirmada | `database/migrations/20261031_111_satisfacao_links_auditoria.sql`, `database/checks/20261031_111_{precheck,postcheck}.sql`, `database/rollback/20261031_111_satisfacao_links_auditoria_down.sql` |
| Detector da instalação pelo catálogo (gatilho por relação, função, habilitação O/A e tgtype; restrições por tipo e validação; NULLS NOT DISTINCT) — AUSENTE/PARCIAL → 503 antes de qualquer linha | `lib/satisfacao/instalacao.ts` |
| Gramática positiva do link do Google (B') e serviço de links (só Gestão; trava FOR UPDATE; corrida → 409; auditoria) | `lib/satisfacao/links.ts`, `app/api/admin/satisfacao/links/route.ts` |
| Retornos: leitura num snapshot (Gestão × Equipe TRATAR vigente com foto) e conclusão A' (travas concessão → vínculo → tarefa, decisão com UM `clock_timestamp()` materializado, estado e auditoria no mesmo instante) | `lib/satisfacao/tarefas.ts`, `lib/satisfacao/admin-http.ts`, `app/api/admin/satisfacao/tarefas/**` |
| Página pública: o mesmo convite “Avaliar no Google” para as notas 0–10; RESPONDIDA mostra o link só se o envio não venceu e a festa vale | `lib/satisfacao/publico.ts`, `app/p/satisfacao/page.tsx` + CSS |
| Tela da Gestão: cartão “Retornos de notas baixas” e passo do link dentro da regra Pesquisa (Equipe sem tela na PS-3, D-PS3-3) | `components/admin/marketing/SatisfacaoRetornos.tsx`, `MarketingAutomacoes.tsx` |
| Exportação: `satisfacao/links_avaliacao` e `satisfacao/auditoria`, retrato `colunas-esperadas-111.json` | `lib/exportacao/*` |
| Inventário (check-migrations, production.test, receita do modelo 111, seleção das suítes) | `scripts/**` |

### Resultados (todos locais)

| Prova | Resultado |
|---|---|
| Unitários PS-3 (gramática, manifesto = postcheck, contrato temporal estático) | **5/5** |
| Suíte PG PS-3 (modelo 111, três conexões) | **13/13** subtestes — pós-check; links; banco; notas 0–10; RESPONDIDA × validade; leitura; conclusão; bordas exatas de vigência e foto; revogação (a) antes → 404 e (b) depois do FOR SHARE → a revogação espera (bloqueio observado em `pg_blocking_pids`); dupla conclusão → 409 e corrida de link → 409; auditoria; PARCIAL em 6 variantes; ciclo down/111 com captura e restauração idênticas |
| Mutantes M53–M80 (clone LF isolado) | **28/28 MORTOS**, cada um pelo subteste da sua causa; controle PASS (`ambientes-locais/satisfacao-ps3-mutantes.cjs`, `mutantes-ps3-20261031.log`) |
| Exportação | 6/6 estados (098, 103, 108, 109, 110, 111) |
| Regressão PG completa | **254/255** arquivos; a única falha foi a asserção da PS-1 que fixava as chaves de RESPONDIDA (agora com `linkAvaliacao`); corrigida e reexecutada: 23/23 → **255/255 por arquivo** |
| CI local | **49/49** (`next-env.d.ts` restaurado) |
| E2E | PS-3 **15/15** (link pela tela, inválido recusado, notas 7 e 3 com o mesmo convite, conclusão pela tela com auditoria no mesmo instante, 1366/390 px, zero requisições a terceiros); PS-1 36/36 e PS-2 14/14 repetidos depois do ajuste visual |

A primeira E2E PS-3 achou rolagem horizontal a 390 px (493 px) causada pelos exemplos de URL longos e pelo campo do link;
corrigido no componente (`overflow-wrap: anywhere`, campo encolhível) e reexecutado.

### Desvios e limites declarados

- **Restrição da decisão aos ids travados (`c.id = ANY(...)`) sem mutante próprio:** só se distingue com uma concessão
  criada entre o passo 3 e o passo 5, o que exige barreira dentro da conclusão; a revogação (a)/(b) e a foto estão provadas.
- **Rotas HTTP** provadas pela E2E (caminho da Gestão) e pelos serviços nas suítes; não há suíte HTTP própria das três rotas.
- **Exportação A/B com eventos da PS-3** não ganhou cenário novo: o retrato 111 e as seis versões passam; o isolamento A/B
  dos serviços está na suíte PS-3.
- Asserções da PS-1 ajustadas ao novo campo (`linkAvaliacao: null` sem a 111): `satisfacao.postgres.test.ts`,
  `satisfacao-concorrencia.postgres.test.ts`, `satisfacao-cancelamento.postgres.test.ts`.

### Rollback

Código: reverter os arquivos acima (sem commit). Banco: a 111 não foi aplicada fora do cluster descartável; a volta exige
quiescência, captura e `SET kidmais111.captura_confirmada = 'sim'`, e recusa 111 ausente ou parcial.

## Revisão independente Astra — PS-3 código — 31/10/2026

**REPROVADO — 0 P1, 4 P2, 2 P3** (parecer `parecer-ps3-20261031.txt`): exportação sem recusa de PARCIAL (P2-1); down que
só conferia a presença das tabelas (P2-2); provas temporais com instante injetado e mutantes classificados só pelo nome
do subteste, com controle único (P2-3); sem matriz HTTP, atomicidade e estados PARCIAL em todas as superfícies (P2-4);
`trim()` antes da validação bruta (P3-1); RESPONDIDA onde G' pede ENCERRADA (P3-2).

## PS-3 — rodada 2 (correção do parecer) — LOCAL, sem commit (31/10/2026)

**Estado: LOCAL, sem commit, sobre o merge local `5dfdff55`; nada publicado.** Pacote `ambientes-locais/revisao-ps3-r2-20261031.patch`
(32 arquivos, SHA-256 `276dd9c94405a99a333552bafc4c3399b523f6f27cc13c47c7e8788ece655c7f`).

### Correções

| Achado | Correção |
|---|---|
| P2-1 exportação | `lerDados` consulta `estadoInstalacao111` no MESMO snapshot REPEATABLE READ: PARCIAL recusa o pacote inteiro (503 `EXPORTACAO_INSTALACAO_INCOMPLETA`); AUSENTE segue como pacote do schema 110 (tabelas da 111 em `entidadesAusentes`). O SQL do detector passou a começar por `SELECT` (marcador depois) para atender a guarda "só leitura" da exportação. |
| P2-2 down | Função temporária `pg_temp.kidmais111_integridade()` com o MESMO manifesto do detector e do pós-check (tabelas, funções, gatilhos por relação/função/habilitação/tgtype, restrições validadas, NULLS NOT DISTINCT). AUSENTE e PARCIAL (só uma tabela, funções sem tabelas, gatilho ausente/desligado/de outro evento) recusam ANTES de qualquer DROP; conferência repetida depois do LOCK. Teste estático: postcheck = down = `OBJETOS_111`, conferência antes do LOCK e do DROP, sem CASCADE e sem tocar na 110. |
| P2-3 temporal e mutantes | Provas com relógio REAL pelas rotas (abaixo) e campanha de mutantes refeita: linha de base por mutante, morte só com subteste esperado + MENSAGEM causal na seção de falhas, infraestrutura = inconclusivo, categorias declaradas. |
| P2-4 rotas | Nova suíte `lib/satisfacao/satisfacao-ps3-rotas.postgres.test.ts` (rotas reais, guarda real, pool de conexões próprias com BEGIN/COMMIT reais). |
| P3-1 | `salvarLink` valida `entrada.url` bruta; a tela apara o rascunho antes de enviar. |
| P3-2 | Envio RESPONDIDO vencido ou com a festa sem validade abre como **ENCERRADA, sem link**; o estado persistido segue RESPONDIDO. Asserções da PS-1 que fixavam RESPONDIDA depois do cancelamento atualizadas (`satisfacao.postgres`, `satisfacao-concorrencia.postgres`). |

### Suíte de rotas (8 subtestes)

- **Matriz:** Gestão e Equipe TRATAR; só VER lista vazia e 404; Equipe sem links (403); empresa na query ignorada; empresa/ator no corpo → 400; outra unidade/outra empresa/inexistente/malformado → 404; segunda conclusão → 409; link bruto com espaço, newline ou 501 espaços → 400; unidade de outra empresa → 404 — corpo `{ ok:false, erro, codigo }` e **zero efeitos** (retrato de tarefas, links e auditoria) em cada recusa.
- **Sessão e guarda:** sem cookie, token desconhecido/malformado, inativa há 31 min (controle 29 min passa), revogada, senha trocada → 401; sem CSRF, CSRF errado, origem alheia ou ausente → 403; `x-kidmais-sessao` trocado → 409; flag desligada → 503 nas três rotas.
- **Atomicidade:** falha injetada DEPOIS do UPDATE da conclusão, DEPOIS do INSERT da auditoria e DEPOIS do INSERT do link → 500, nenhum campo/evento persiste; a nova tentativa grava uma vez.
- **Relógio real:** vencimento atravessado enquanto a rota espera a empresa (guarda de tenant) e enquanto espera a tarefa → 404 sem efeito; início atravessado na espera da tarefa → autoriza, `concluida_em` ≥ início, retornado = persistido = auditoria. A suíte confere que a rota ficou presa ANTES da borda.
- **Revogação (b) composta:** a conclusão espera a tarefa com o FOR SHARE da concessão já tomado; o revogador fica bloqueado pela conexão da rota e só confirma depois.
- **Revogação (c):** a rota presa no INSERT da auditoria (FK da unidade travada), já depois da decisão; o revogador espera o COMMIT da conclusão (oráculo de anomalia: revogação confirmada antes + conclusão autorizada).
- **Exportação A/B:** links e auditoria reais (inclusão de link nas duas empresas, conclusão em A): CSV só da empresa, contagens = banco, sha256 = manifesto, linhas = manifesto, nenhum arquivo cita a outra empresa, instante exportado = `concluida_em`.
- **Instalação:** AUSENTE e PARCIAL em cinco formas (coerência desligada, sem o gatilho TRUNCATE, só links, só auditoria, funções sem tabelas) em TODAS as superfícies — GET de tarefas normal; conclusão e links 503 com o código certo e nenhuma tarefa alterada; página pública sem link; exportação AUSENTE = pacote 110 e PARCIAL = recusa; down AUSENTE recusa e PARCIAL recusa sem mudar o catálogo; linhas da 110 idênticas no ciclo inteiro; restauração com falha injetada depois do INSERT (nada fica) e repetição idêntica por hash.

**Observação para o revisor:** `revogada_em` é o `clock_timestamp()` do UPDATE, avaliado antes de o revogador esperar;
por isso a linearização provada é a ordem de COMMIT, não a comparação de carimbos.

### Resultados (todos locais, cluster descartável 127.0.0.1:55551, encerrado no fim)

| Prova | Resultado |
|---|---|
| Unitários PS-3 + exportação | **21/21 no total** (5 PS-3 + 16 `exportacao.test.ts`) — *texto corrigido na rodada 3; antes dizia "5/5 e 21/21"* |
| Suíte PG PS-3 | **13/13** subtestes |
| Suíte PG de rotas | **8/8** subtestes |
| Mutantes (clone LF isolado, `ambientes-locais/satisfacao-ps3-mutantes.cjs`) | **45/45 MORTOS** — 40 funcionais, 5 estruturais (M53s, M78, M79, M91, M95), 0 equivalentes, 0 inconclusivos; linha de base verde antes de cada um; consolidado de duas passadas: `mutantes-ps3-r2-20261031.log` (44 mortos, M95 classificado VIVO por não ter subteste) + `mutantes-ps3-r2-M95-20261031.log` (M95 morto no portão) — *texto corrigido na rodada 3; antes dizia "41 funcionais, 4 estruturais"* |
| Regressão PG completa | **256/256** arquivos |
| CI local | **49/49** (`next-env.d.ts` restaurado) |
| E2E | PS-3 **15/15**, PS-1 **36/36**, PS-2 **14/14** |

Mutantes novos ou refeitos: M53 (now(), funcional pelo relógio real) e M53s (estático), M81 instante antes da espera,
M82 decisão antes da trava da tarefa, M56 sem FOR SHARE (revogação c), M57 sem FOR UPDATE (agora funcional: a espera
passa ao UPDATE, depois da decisão), M83 conclusão sem auditoria, M54 conclusão sem conferir a 111 (morre por "nenhuma
tarefa mudou", não por 42P01), M84 PARCIAL como COMPLETA, M85 exportação aceita PARCIAL, M86 down sem integridade,
M87 trim antes de validar, M88 sem igualdade do pathname, M89 placeid repetido aceito, M90 chave desconhecida aceita,
M91 down diverge do manifesto, M92 coerência de unidade removida, M93 nulidade enfraquecida (conclusão coerente com URL),
M94 função aceita TRUNCATE, M95 gatilho TRUNCATE removido (morre no PORTÃO: o pós-check da receita do modelo 111 recusa
antes de a suíte começar — registrado como estrutural) e M96 auditoria fora do pacote 111.

### Limites declarados

- A restrição da decisão aos ids travados (`c.id = ANY(...)`) continua sem mutante próprio (exigiria uma concessão nova
  entre a trava e a decisão).
- Depois da campanha, a única mudança de código foi a posição do marcador no SQL do detector (`SELECT /* … */`); a suíte
  focal (PS-3, rotas, exportação 6 estados, PS-1) e o CI foram repetidos depois dela, os mutantes não.
- Equipe continua sem tela na PS-3 (D-PS3-3): o contrato dela é a API, agora provado pelas rotas.

### Rollback

Inalterado: reverter os arquivos (sem commit). A 111 só existiu no cluster descartável. O down agora recusa AUSENTE e
qualquer PARCIAL antes de remover objetos; com a 111 completa exige quiescência, captura e `SET kidmais111.captura_confirmada = 'sim'`.

## Revisão independente — PS-3 rodada 2 — 31/10/2026

**VEREDITO: REPROVADO no aceite completo da rodada 2 — 0 P1, 1 P2 residual e 2 P3.** P2-1, P2-2, P2-3, P3-1 e P3-2 do parecer anterior fechados no alcance descrito abaixo. P2-4 parcialmente fechado: falta a prova do POST público nos estados PARCIAL exigida por F'. Não foi demonstrado novo defeito funcional no código de produto; a reprovação remanescente é de cobertura de um critério explícito de aceite. Somente local, sem commit/publicação.

### Identidade e alcance

Checkout: D:/glass/KidMais Manager/kidmais-manager-satisfacao-ps1-20261030; branch codex/satisfacao-ps1-20261030; HEAD 5dfdff55da7bfcd4835282bc09e92a3852d047f6; alterações preexistentes não commitadas. Nenhum código/teste da candidata foi alterado pelo reviewer.

SHA-256 do pacote revisao-ps3-r2-20261031.patch confirmado: 276dd9c94405a99a333552bafc4c3399b523f6f27cc13c47c7e8788ece655c7f. A verificação usou índice temporário próprio, carregado de HEAD, com arquivos novos em intent-to-add; o índice original foi preservado. git diff --check passou. O reverse-check integral FALHOU exclusivamente em docs/SATISFACAO_PESQUISA_20261030.md. Excluindo esse documento, os outros 31 arquivos passaram. O documento atual contém exatamente o documento do pacote como prefixo, seguido de 71 linhas adicionais (parecer anterior e registro da rodada 2), antes deste registro. Logo, o código corresponde ao pacote, mas não a árvore documental inteira.

### Fechamento dos seis achados anteriores

| Achado | Parecer |
|---|---|
| P2-1 | FECHADO. lib/exportacao/pacote.ts:313 consulta estadoInstalacao111 dentro de lerDados; lib/exportacao/servico.ts abre REPEATABLE READ READ ONLY para essa chamada. PARCIAL lança 503 EXPORTACAO_INSTALACAO_INCOMPLETA antes de exportar as entidades; AUSENTE mantém as duas tabelas como ausentes. A suíte de rotas confere AUSENTE e cinco PARCIAL, e exportação A/B com eventos, CSVs, contagens, hashes e instante de conclusão. |
| P2-2 | FECHADO. O down usa pg_temp.kidmais111_integridade com tabelas, funções, gatilhos associados/habilitados/tipados, constraints validadas e NULLS NOT DISTINCT; recusa antes do LOCK e reconfere antes dos DROP. Mantém captura, ausência de CASCADE e proteção da 110. Manifesto estático passou; os cenários com catálogo preservado e restauração estão implementados e seus logs aprovados foram auditados. |
| P2-3 | FECHADO quanto às exigências anteriores: relógio real atravessa vencimento na empresa/tarefa e início na tarefa, com bloqueio observado antes da borda; caso (b) composto observa o revogador bloqueado pela rota; instante retornado/persistido/auditoria coincide. O script executa baseline por mutante e separa categorias/infraestrutura. Os 45 logs finais têm a causa no bloco de falha correspondente (M95 no portão). Ressalva P3 abaixo para tornar (c) determinístico. |
| P2-4 | PARCIALMENTE FECHADO. Rotas e guarda reais, transações próprias, matriz HTTP, falhas depois do UPDATE/INSERT, retry, exportação A/B, cinco PARCIAL, catálogo e preservação/restauração foram acrescentados. Falta o POST público nos PARCIAL; ver P2 residual. |
| P3-1 | FECHADO. salvarLink valida entrada.url bruta, e o componente apara o rascunho no cliente. A rota testa espaço inicial, newline e 501 espaços, com 400 e retrato sem efeitos. |
| P3-2 | FECHADO. respondidoValendo condiciona a apresentação: vencido/festa inválida retorna ENCERRADA sem link e preserva RESPONDIDO no banco. Asserções da PS-1 e os casos/M66a/M66b acompanham o contrato. |

### PS3-R2-P2-1 — Falta o POST público na matriz PARCIAL (resíduo de P2-4)

Referências: lib/satisfacao/satisfacao-ps3-rotas.postgres.test.ts:539–568 e 576–588; lib/satisfacao/satisfacao-ps3.postgres.test.ts:389–442; plano, F', tabela “página pública (POST e RESPONDIDA)” e ensaio 110 → 111 → down → 111 restaurado.

superficies() chama abrirPesquisa sobre um envio já RESPONDIDO em cada PARCIAL; não chama responderPesquisa. A suíte de serviços testa linkDoEnvio nos PARCIAL e testa uma resposta nova depois do down (AUSENTE), mas não uma nova resposta nos cinco PARCIAL. Isso não prova que a transação de resposta inteira continua normal quando a instalação está incompleta. Um desvio que exigisse a 111 íntegra somente em responderPesquisa quando o detector retorna PARCIAL escaparia desses cenários, mesmo com reabertura e linkDoEnvio verdes.

Completar a prova com envios ATIVOS preparados antes da alteração do schema, responderPesquisa real em cada PARCIAL, gravada:true/linkAvaliacao:null, resposta persistida, envio RESPONDIDO, entregas encerradas e tarefa de nota baixa criada uma única vez. Reabrir depois deve manter a resposta sem link. Separar essas alterações legítimas da 110 do retrato “nenhum efeito nas recusas”. Não é necessário repetir toda a regressão para fechar esse ponto; executar a matriz focal e um controle negativo dirigido ao POST é suficiente. Não se afirma que o produto atualmente falhe: por inspeção usa o mesmo linkDoEnvio, mas F' exige a prova da entrada transacional.

### PS3-R2-P3-1 — Caso (c) ainda depende de uma janela de 300 ms

Referência: lib/satisfacao/satisfacao-ps3-rotas.postgres.test.ts:451–463.

A rota é observada bloqueada no INSERT da auditoria depois da decisão. Em seguida, o teste dispara a revogação e apenas espera até 30 intervalos de 10 ms; revogouAntes=false pode significar tanto bloqueio correto quanto revogador ainda não executado. Não há observação do PID/SQL do revogador nesse caso, e a mensagem “esperou o COMMIT” é mais forte que essa asserção isolada.

O log final de M56 efetivamente mostra a anomalia funcional “revogação confirmada antes e conclusão autorizada” em (c), além da falha da barreira de (b). A morte funcional é válida para a execução auditada. O caso (b), a inspeção do FOR SHARE até o fim da transação e esse log sustentam o fechamento de P2-3; o problema remanescente é de repetibilidade do teste (c), não defeito demonstrado da autorização.

Trocar a espera fixa por uma barreira com prazo que observe um dos resultados: revogação confirmada enquanto a rota continua presa (anomalia) OU revogador efetivamente bloqueado pela conexão da rota, conferido por pg_blocking_pids e SQL. Só então liberar a auditoria. Não usar apenas o timeout como prova de bloqueio.

### PS3-R2-P3-2 — Precisão do pacote e das contagens

Os 45 mutantes finais são **40 funcionais e 5 estruturais**, não 41/4. Estruturais: M53s, M78, M79, M91 e M95. O log principal registra 44 mortos e M95 classificado VIVO; a execução suplementar reclassifica corretamente M95 como morte no portão do pós-check. O conjunto consolidado sustenta 45/45, não uma única passada originalmente verde.

A reexecução independente de satisfacao-ps3.test.ts + exportacao.test.ts passou **21/21 no total: 5 PS-3 + 16 exportação**, não 5 mais 21. A expressão “5/5 (+exportação 21/21)” precisa esclarecer que 21 é o total combinado.

O pacote não inclui as 71 linhas documentais acrescentadas posteriormente. Publicar um pacote documental complementar ou regenerar o pacote final e informar o novo hash; não declarar reverse-check integral aprovado para o hash atual. Este parecer registra os números corretos e preserva os relatos anteriores como histórico.

### Julgamento dos três pontos pedidos

1. **revogada_em anterior à espera: aceitável para o contrato atual**, desde que esse carimbo não seja apresentado como instante de eficácia/COMMIT. As operações concorrentes se ordenam pelas travas e confirmações; a conclusão decide vigência em clock_timestamp() depois das travas e não promete vigência até COMMIT. A revogação concorrente que espera pode confirmar depois com carimbo anterior à conclusão. Consultas históricas não devem inferir a ordem de eficácia apenas comparando revogada_em e concluida_em. Nenhuma mudança de semântica de produto foi introduzida nesta revisão.
2. **c.id = ANY(ids travados): limite de cobertura aceito, sem novo P2.** O predicado permanece no passo decisório, com os ids obtidos sob SHARE. Não há mutante próprio nem prova de concessão nova entre trava e decisão. Preservar essa limitação; não contar os 45 mutantes como cobertura desse invariante.
3. **Posição do marcador SQL após a campanha: não exige repetir toda a campanha.** SELECT /* ... */ preserva o SQL do PostgreSQL, mas é relevante à guarda textual de consultas só de leitura do exportador. O focal posterior inclui exportação nos seis modelos, rotas, PS-3 e PS-1, e o CI foi repetido. Isso cobre o efeito da alteração. Os mutantes continuam sendo evidência da campanha anterior, sem alegar reexecução pós-alteração. Na comparação atual, os 31 arquivos não documentais do pacote coincidem com o clone de mutantes normalizando CRLF; essa comparação não é um snapshot histórico da campanha.

### Evidência independente e limites

Executados pelo reviewer: identidade Git, hash, reverse-check com índice temporário (31 arquivos aprovados; documento divergente), diff-check, comparação normalizada com clone dos mutantes, unitários combinados 21/21 em Node 24.20.0. Auditoria automática dos 45 logs finais confirmou subteste e mensagem causal no mesmo bloco de falha; M95 confirmado separadamente no portão. O script mostra baseline antes de cada mutação; baselines verdes são registrados no resumo, e não foram reexecutados pelo reviewer.

Lidos os resumos e código das provas declaradas: regressão PG 256/256; focal posterior 9 execuções (exportação 6 estados + rotas + PS-3 + PS-1); CI 49/49; E2E PS-3/PS-1/PS-2 aprovadas. São evidências do implementador auditadas, não novas execuções independentes.

Tentativa de cluster próprio em work/pg-review, porta planejada 55563: initdb falhou ao criar o diretório (“No such file or directory”), antes de iniciar qualquer servidor. Nenhuma migration foi executada por esta revisão, nenhum cluster anterior foi reutilizado. PG, mutantes, CI e E2E não foram reexecutados. Não houve acesso a staging/produção/Render, envio externo, commit ou push.

Próximo: completar o POST público em PARCIAL, reforçar a barreira de (c), corrigir a apresentação dos números/pacote e entregar evidência focal. A reprovação anterior permanece como histórico; este é o parecer vigente da rodada 2.

## PS-3 — rodada 3 (resíduos do parecer da rodada 2) — LOCAL, sem commit (31/10/2026)

**Estado: LOCAL, sem commit, sobre o merge local `5dfdff55`; nada publicado.** Nenhum código de produto mudou nesta
rodada: só a suíte de rotas, o script de mutantes (fora do repositório) e este documento. Pacote final regenerado DEPOIS
desta seção: `ambientes-locais/revisao-ps3-r3-20261031.patch` (hash informado na entrega; o pacote da rodada 2 não
cobre as linhas documentais posteriores a ele).

| Achado | Correção |
|---|---|
| PS3-R2-P2-1 POST público em PARCIAL | Seis envios ATIVOS preparados com a 111 completa, um por estado (AUSENTE + os 5 PARCIAL). Em cada estado, `responderPesquisa` real: `{ gravada: true, linkAvaliacao: null }`; resposta persistida, envio RESPONDIDO, entrega pendente encerrada (CANCELADA/RESPONDIDA), tarefa de nota baixa criada; segundo POST → `JA_RESPONDIDA` e a tarefa continua única; reabertura RESPONDIDA sem link; nenhuma linha da 111 escrita (tabelas presentes comparadas por conteúdo). O retrato "nenhum efeito" da 110 passou a excluir só as linhas desses seis envios, e confere que o POST não mudou mais nada. Controle negativo dirigido: **M97** (só a resposta passa a exigir a 111 íntegra) morre por "POST público recusado (INSTALACAO_INCOMPLETA)". |
| PS3-R2-P3-1 caso (c) por janela fixa | A espera de 300 ms virou a barreira `revogadorPresoOuConfirmado`: com prazo, devolve o primeiro resultado OBSERVADO — revogador bloqueado por uma conexão da rota no UPDATE da concessão (`pg_blocking_pids` + SQL) ou revogação confirmada com a rota ainda presa. O prazo sozinho é erro, nunca prova. A suíte exige PRESO (e, nele, revogação ainda não confirmada); o oráculo de anomalia continua antes. M56 morre agora pelo caminho CONFIRMADO. |
| PS3-R2-P3-2 números e pacote | Mutantes: **40 funcionais + 5 estruturais** (M53s, M78, M79, M91, M95), consolidado de duas passadas. Unitários: **21/21 no total** (5 PS-3 + 16 exportação). Linhas da rodada 2 corrigidas no lugar, com a nota do texto antigo. Pacote regenerado depois de toda a documentação. |

### Resultados da rodada 3 (cluster descartável 127.0.0.1:55551, encerrado no fim)

| Prova | Resultado |
|---|---|
| Suíte PG de rotas | **8/8** subtestes; repetida **5×** sem falha (`rotas-ps3-r3-repeticao-20261031.log`) |
| Focal PG | **10/10** arquivos: exportação nos 6 modelos (098/103/108/109/110/111), rotas, PS-3, PS-1 e concorrência da PS-1 (`regressao-pg-satisfacao-ps3-r3-focal-20261031.log`) |
| Mutantes dirigidos (linha de base por mutante) | **7/7 MORTOS**: M56, M97 (novo) e os da matriz de instalação M54, M84, M85, M86, M76 (`mutantes-ps3-r3-20261031.log`). Campanha total: **46** (41 funcionais + 5 estruturais), sendo 39 da rodada 2 não repetidos nesta |
| Unitários PS-3 + exportação | **21/21 no total** (5 + 16) |
| CI local | **49/49** (`ci-local-satisfacao-ps3-r3-20261031.log`; `next-env.d.ts` restaurado) |

### Limites declarados

- A regressão PG completa e os E2E não foram repetidos: nenhum código de produto mudou desde a rodada 2 (256/256 e 65/65).
- `c.id = ANY(ids travados)` segue sem mutante próprio (limite aceito no parecer).
- `revogada_em` é carimbado antes da espera; a ordem provada é a de COMMIT (aceito no parecer).


## Revisão independente — PS-3 rodada 3 — 31/10/2026

**VEREDITO: APROVADO — 0 P1, 0 P2, 0 P3 no escopo dos resíduos da rodada 2.** PS3-R2-P2-1, PS3-R2-P3-1 e PS3-R2-P3-2 fechados. Este parecer sucede a reprovação da rodada 2; os pareceres anteriores permanecem como histórico. Aprovação local, sem autorização de commit ou publicação.

Checkout: D:/glass/KidMais Manager/kidmais-manager-satisfacao-ps1-20261030; HEAD 5dfdff55da7bfcd4835282bc09e92a3852d047f6. Alterações sem commit. Comparação dos pacotes r2/r3: somente docs/SATISFACAO_PESQUISA_20261030.md e lib/satisfacao/satisfacao-ps3-rotas.postgres.test.ts diferem; código de produto inalterado.

### Integridade do pacote

SHA-256 confirmado: 6bb21d16cd7907a1acbe6cda4bda521a93c2283664f076260630fb5d7cbbc5ab. Reverse-check integral aprovado para os 32 arquivos, inclusive documentação, com índice temporário carregado de HEAD e arquivos novos em intent-to-add. O diff binário regenerado independentemente tem exatamente esse mesmo hash. git diff --check aprovado; next-env.d.ts fora do delta. Índice real preservado.

O pacote foi conferido ANTES de acrescentar este parecer. O registro posterior desta revisão é um adendo documental, não conteúdo do pacote identificado pelo hash acima. O pacote original foi preservado.

### Fechamento dos resíduos

| Achado anterior | Julgamento e referências |
|---|---|
| PS3-R2-P2-1 | FECHADO. lib/satisfacao/satisfacao-ps3-rotas.postgres.test.ts:542 prepara seis envios com ativo(); :563 confere ATIVO/uma entrega pendente; :594 chama responderPesquisa real em AUSENTE e nos cinco PARCIAL; :596–603 confere retorno, resposta, envio, cancelamento da entrega, tarefa ABERTA, duplicação recusada, reabertura e ausência de escrita na 111. :623–637 percorre os seis estados. |
| Separação da 110 | :548–552 exclui somente os seis IDs nas quatro tabelas ligadas ao envio; as outras quatro tabelas permanecem integralmente no retrato. :590 verifica recusas; :603 o restante depois do POST; :652 o ciclo completo. Os efeitos esperados dos envios excluídos são conferidos individualmente em :597 e :599. A comparação global não deve ser descrita como igualdade de toda a 110, nem como isolamento de cada um dos seis envios entre si: seu alcance é o restante da 110 mais as asserções específicas de cada resposta. Isso atende ao resíduo solicitado. |
| Controle M97 | satisfacao-ps3-mutantes.cjs:174–178 injeta exigirInstalacao111 somente em responderPesquisa, condicionado a PARCIAL, depois da criação da tarefa e antes do fim da transação. Não altera abrirPesquisa/linkDoEnvio. O log bruto ultimo-M97-post-publico-exige-111-integra.log contém a falha causal no subteste da instalação, em :595: “coerência desligada: POST público recusado (INSTALACAO_INCOMPLETA)”. É controle dirigido válido da lacuna anterior. A execução interrompe na primeira variante PARCIAL; a cobertura das cinco variantes decorre da matriz positiva, não de cinco mortes independentes de M97. |
| PS3-R2-P3-1 | FECHADO. :223–232 retorna somente por confirmação observada ou bloqueio observado por PID de rota e SQL; esgotar tentativas lança erro. :459 lê o PID antes de enfileirar UPDATE; :468 prende a rota no INSERT da auditoria; :470–475 observa o revogador antes de liberar c3. :479 verifica a anomalia antes de exigir PRESO em :480. Eliminada a inferência de bloqueio por uma janela silenciosa de 300 ms. O teste ainda usa polling/prazo para disponibilidade, nunca como prova de sucesso. |
| Controle M56 | satisfacao-ps3-mutantes.cjs:56–59 remove FOR SHARE da concessão. O log bruto ultimo-M56-concessao-sem-for-share.log:108 registra “anomalia: revogação confirmada antes e conclusão autorizada”, lançada em :479 do teste. Portanto morreu pelo caminho CONFIRMADO + 200 em (c), além da falha de barreira em (b); não apenas por timeout. |
| PS3-R2-P3-2 | FECHADO. docs/SATISFACAO_PESQUISA_20261030.md:477 e :480 corrigem 21/21 combinado e 40 funcionais + 5 estruturais, com texto antigo identificado e duas passadas explicitadas. :589 informa 46 acumulados = 41 funcionais + 5 estruturais, 7 repetidos/novos nesta rodada e 39 herdados. O pacote agora cobre toda a documentação entregue. |

### Evidências e limites

Executado independentemente nesta revisão: identidade Git, hash, reverse-check integral, regeneração do diff com hash idêntico, comparação r2/r3, diff-check e unitários PS-3 + exportação **21/21** (5 + 16), zero falhas/skips.

Auditado por leitura, sem reexecutar PostgreSQL ou mutantes: rotas **8/8 subtestes** (o node:test conta 9 incluindo o teste pai); cinco execuções aprovadas no log de repetição; focal **10/10 execuções arquivo/modelo** (seis exportações e quatro suítes); resumo dos sete mutantes com baseline verde por mutante e logs brutos causais M56/M97; CI **49/49 passos com código 0**. O script executa baseline antes de cada mutação, mas não salva os baselines verdes em arquivos próprios: sua aprovação consta do resumo. Não converter essa auditoria em alegação de reexecução independente.

Regressão PG completa **256/256** e E2E **65/65** continuam evidências herdadas da rodada 2, não repetidas nesta rodada. Permanecem os limites aceitos: c.id = ANY(ids travados) sem mutante específico; revogada_em não representa o instante de COMMIT. Nenhum novo defeito de produto demonstrado no escopo desta revisão.

Somente local. Nenhum cluster iniciado/reutilizado, nenhum banco real consultado, nenhuma migration executada pelo reviewer. Sem commit, push, staging, produção, Render ou envio real. Código e testes da candidata preservados; apenas este parecer e os registros documentais solicitados foram acrescentados.

## PS-G — convite do Google em destaque (só G1) — LOCAL, sem commit (31/10/2026)

**Decisão de Felipe (31/10):** depois de três rodadas do plano reprovadas só na CONTAGEM de cliques (rev. 0–2), fazer
agora apenas o convite (G1, aceito pelo Astra desde a rev. 0). A contagem fica adiada para uma fase própria; nenhuma
migration, tabela, rota ou dado novo nesta entrega. Sobre o commit local `f3e82fb2`.

| Mudança | Onde |
|---|---|
| O convite vira a ação principal da página de obrigado: botão principal (`botaoGoogle`, o mesmo gradiente do "Enviar resposta") e texto neutro "Se quiser, conte como foi sua experiência no Google e ajude outras famílias a escolher." Sem promessa de tempo, sem pedir estrelas/elogio, sem incentivo. | `app/p/satisfacao/page.tsx`, `satisfacao.module.css` |
| Idêntico para qualquer nota (mesmo HTML) e sempre ANTES do aviso de nota baixa. | `page.tsx` |
| Resposta repetida (409): a página reabre pelo `POST /api/satisfacao/abrir` (token no corpo) e mostra o estado devolvido — RESPONDIDA com o convite atual ou sem link, ENCERRADA ("Pesquisa indisponível", com a saída das pesquisas). Falha ou limite na reabertura: "já respondida", sem convite. Antes, o 409 sempre zerava o convite. | `page.tsx` (`reabrirDepoisDoConflito`) |

### Provas (cluster descartável 127.0.0.1:55551, encerrado no fim)

| Prova | Resultado |
|---|---|
| E2E PS-G (`ambientes-locais/satisfacao-psg-e2e.cjs`, 1366 e 390 px) | **34/34 PASS**: notas 0, 6, 7 e 10 com o mesmo bloco (HTML idêntico), botão principal, antes do aviso; tarefa só nas notas ≤ 6; Enter no convite abre o link salvo em nova aba (pedido ao Google interceptado e abortado) e a página continua; reabertura pelo link com o mesmo convite; 409 em outra aba → "já respondida" com o convite, vale só a 1ª resposta; 409 depois do cancelamento → "Pesquisa indisponível" sem convite e com a saída; nenhuma requisição a terceiros; nenhum link da pesquisa no log |
| Controle negativo (o mesmo E2E contra o clone LF com a página da PS-3) | **7 falhas, todas causais**: botão principal nas 4 notas, 409 sem convite, 409 após cancelamento (2) — `satisfacao-e2e-psg-controle-20261031.log` |
| E2E das fases anteriores | PS-1 **36/36**, PS-2 **14/14**, PS-3 **15/15** |
| CI local | **49/49** (a 1ª passada pegou um erro de TypeScript no 409, corrigido; E2E PS-G repetido depois: 34/34) (`ci-local-satisfacao-psg-20261031.log`; `next-env.d.ts` restaurado) |

Sem PG/mutantes novos: nenhum SQL, serviço ou rota mudou (só a página). Política de avaliações do Google: convite igual
para todas as notas, sem incentivo e sem seleção por satisfação (parecer da rev. 0 do plano PS-G).

### Contagem de cliques (adiada)

Fica fora. Os contratos discutidos nas rev. 0–2 do plano (registro do convite em SAVEPOINT, publicação mensal com
barreira, travas por cliente, LGPD) e o último parecer (rev. 2: 4 P2 + 2 P3) ficam no plano do vault como ponto de
partida. Alternativa sem dado nosso: acompanhar as avaliações recebidas pelo próprio Perfil da Empresa no Google.

### Rollback

Reverter `page.tsx` e `satisfacao.module.css` (sem commit). Nada no banco.

## PS-4 — menu Satisfação, Resultados, Retornos e permissões — LOCAL, sem commit (01/11/2026)

Contrato: plano PS-4 rev. 0 + rev. 1 + rev. 1.1 (vault), com as decisões D-PS4-1..6 aprovadas por Felipe em 01/11 como
recomendado. Sobre o commit local `a7ca19e5`. **Nenhuma migration**: só leitura do que a 110 e a 111 já têm.

### O que entrega

| Parte | Onde |
|---|---|
| Grupo **Satisfação** no menu (Resultados, Retornos com contador de abertas). Aparece para quem tem VER e/ou TRATAR vigentes, ou é Gestão; some sem nenhum dos dois. O menu é relido numa instrução só junto com a autenticação (`menuSatisfacao`). | `lib/admin/navegacao.ts`, `AdminShell.tsx`, `shell.module.css`, `app/api/admin/autenticacao/route.ts` |
| Escopos VER/TRATAR por unidade num só lugar (`ctesEscopo`, `concessaoVigente`, `MEMBRO_VIGENTE`), usados por Resultados e Retornos. TRATAR não dá VER (D-PS4-2). | `lib/satisfacao/escopo.ts` |
| **Resultados** (`GET /api/admin/satisfacao/resultados`): população P = envios da empresa cuja **festa** cai no período (D-PS4-1), unidade no escopo VER e no filtro, envio não REVOGADO, festa não CANCELADA e com contrato ASSINADO (D-PS4-6). Cartões (pesquisas criadas, respostas, taxa, ainda no prazo, sem contato, NPS com `round` meio-longe-do-zero, grupos, histograma 0–10, aspectos com `round(avg,1)`), lista de 50 com cursor, filtros só da lista (grupo, nota, com comentário). Retornos abertos e o selo por item só em VER ∩ TRATAR (chaves ausentes fora disso). Aviso com menos de 10 respostas, sem esconder números (D-PS4-4). Sem CSV (D-PS4-5). | `lib/satisfacao/resultados.ts`, `cursor.ts`, rota, `components/admin/satisfacao/*`, `app/admin/satisfacao/page.tsx` |
| **Retornos** em página própria (`/admin/satisfacao/retornos`), abertas e concluídas, filtro de estado no SQL antes do LIMIT, página de 50 com cursor `(ordem, id)`, `totalNoEstado`. A tela abre também para a Equipe só com TRATAR. Automações mantém o link do Google (D-PS4-3) e ganha um atalho para Retornos. | `lib/satisfacao/tarefas.ts`, `app/api/admin/satisfacao/tarefas/route.ts`, `RetornosPagina.tsx`, `app/admin/satisfacao/retornos/page.tsx`, `SatisfacaoRetornos.tsx`, `MarketingAutomacoes.tsx` |
| Cursor: base64url de `"<instante UTC com µs>|<uuid>"`, nunca passa por `Date`; comparação por tupla estrita; cursor inválido → 400. | `lib/satisfacao/cursor.ts` |

**Extensões declaradas do contrato:**
- DTO de Resultados com `unidades` (as do escopo VER, para o seletor) e `semUnidade`;
- oráculos da PS-3 com `totalNoEstado: 0` e `proximo: null` (extensões da R5);
- desempate das tarefas por `x.id::uuid` (antes era texto) para casar com a comparação de tupla do cursor;
- P entra pelas festas da empresa no período (`festas AS MATERIALIZED`, índice 062) e chega aos envios pela chave única `(empresa_id, fechamento_id)`, com `f.empresa_id = $1` explícito. Veio do ensaio de desempenho (abaixo); mesmo resultado, sem índice novo.

**Correção achada pelo E2E:** `satisfacao.module.css` tinha um seletor impuro (`[data-nota-faixa="detrator"]` solto), erro de build do CSS Module que derrubava `/admin/satisfacao/retornos` no `next dev`. Virou `.linhaTopo [data-nota-faixa="detrator"]`.

### Provas (todas locais; cluster descartável 127.0.0.1:55551; nenhum dado real)

| Prova | Resultado |
|---|---|
| Unitários (`navegacao`, `satisfacao-ps4`, `satisfacao-ps3`) | **14/14** |
| Suíte PG `satisfacao-ps4.postgres.test.ts` (9 subtestes) | **9/9 PASS** com o SQL final de P (`2026-11-01T13-01-42-054Z-check-v1-postgres.log`, junto com a PS-3) e depois da prova da 019 (`2026-11-01T13-28-16-978Z-check-v1-postgres.log`) |
| Regressão PG completa | **257/257 arquivos PASS** (`2026-11-01T11-16-45-409Z-check-v1-postgres.log`, antes da correção de CSS e da troca do SQL de P; as suítes PS-3/PS-4 foram repetidas depois) |
| E2E PS-4 (`ambientes-locais/satisfacao-ps4-e2e.cjs`, 1366 e 390 px) | **32/32 PASS** (`2026-11-01T12-34-12-042Z-e2e-ps4`) |
| E2E PS-3 ajustado (atalho de Automações → Retornos) | **16/16 PASS** (`2026-11-01T12-28-55-527Z-e2e-ps3`) |
| E2E PS-1 / PS-2 / PS-G | **36/36**, **14/14**, **34/34** PASS (01/11, depois da troca do SQL de P) |
| Mutantes (`ambientes-locais/satisfacao-ps4-mutantes.cjs`, clone LF) | **26 mortos + 1 equivalente de 27**, 0 vivos, 0 inconclusivos (`2026-11-01T13-57-52-187Z-mutantes-ps4.txt` + P16b repetido em `2026-11-01T13-59-00-043Z-mutantes-ps4.txt`) |
| Desempenho (`ambientes-locais/satisfacao-ps4-desempenho.ts`) | critérios 1, 2, 3 e 5 **PASS** (p95 máximo 38 ms); critério 4 **FALHA em 5 de 20 combinações** (abaixo) |
| CI local | **49/49** (`ambientes-locais/ci-local-satisfacao-ps4-20261101.log`; `next-env.d.ts` restaurado). Antes, as 8 suítes PG da satisfação passaram com o código final (`2026-11-01T14-58-01-535Z-check-v1-postgres.log`) e o cluster foi encerrado |

**O que a suíte PG cobre:**
- oráculos de NPS e aspectos;
- população P (REVOGADO, cancelada, sem contrato, no prazo, sem contato);
- escopos pelas rotas (Gestão, VER, TRATAR, misto);
- vigência (revogação, foto velha, membership futura/expirada);
- chaves exatas do JSON; comentário com XSS guardado como texto;
- flag desligada 503, plano ESSENCIAL 403;
- matriz do menu e janela de troca de papel;
- cursor (empate no mesmo µs, 1 µs, resposta nova entre páginas, inválidos, revogação);
- filtros e período (365/366/367 datas, 29/02, invertido, atalhos);
- retornos com 201 abertas e 5 páginas.

**Fixtures declaradas:**
- envios, respostas, tarefas e vínculos com instantes controlados são inseridos em `session_replication_role = replica` (os gatilhos da 063 não deixam mudar a vigência da membership por UPDATE direto);
- o plano ESSENCIAL é injetado por gancho do harness;
- a janela de troca de papel é atravessada por gancho com sonda que conta as leituras da membership.

### Desempenho (gate da rev. 1.1)

Ambiente: Ryzen 7 9800X3D, 31 GiB, PostgreSQL 18.6 local; `shared_buffers=128MB`, `work_mem=4MB`,
`effective_cache_size=4GB`, `random_page_cost=4`. Massa: A, B e C com 20 mil envios cada.

**Primeira medição (SQL original):**
- o critério 3 **falhou**: `fechamentos` era lido sem condição de empresa. A empresa só era filtrada no envio, então o planner lia as festas de todas as empresas no período;
- com B e C carregados, o planner passava a partir dos 5 mil envios da unidade em todo o histórico e fazia uma busca por pkey em `fechamentos` por envio (15 mil buffers).

**Correção:** `festas AS MATERIALIZED` com `f.empresa_id = $1`, depois os envios pela chave única. Sem índice nem migration.

**Medições finais (SQL corrigido), duas rodadas:**
- `2026-11-01T12-51-02-093Z-desempenho-ps4`: 139 PASS, 6 FALHAS;
- `2026-11-01T12-57-00-252Z-desempenho-ps4`: 140 PASS, 5 FALHAS.

| Critério | Resultado |
|---|---|
| 1. p95 < 300 ms em cada leitura | **PASS** (máximo 38 ms) |
| 2. sem ordenação em disco | **PASS** |
| 3. acesso por empresa observável | **PASS** em todas as 40 medições |
| 4. p95(A+B+C) ≤ 1,5 × p95(só A) | **FALHA em 5 de 20** combinações na 2ª rodada (6 na 1ª), todas no "1 mês" (Gestão sem unidade × 2, Equipe U1 × 2, Equipe todas página 1). Diferenças absolutas de 5 a 15 ms, por exemplo 10 → 25 ms e 9 → 14 ms. |
| 5. buffers (informação) | `fechamentos` 367–770 → 377–494. Leituras por chave de `satisfacao_tarefas`/`respostas` sobem com B e C (até cerca de 3,3 mil buffers), porque o planner troca o Seq Scan das linhas de A por buscas por chave, uma por resposta do período. São só linhas de A, e o critério 3 confirma. |

**Leitura honesta do critério 4:**
- Não há leitura de outra empresa (critério 3).
- A diferença vem da escolha de plano com estatísticas novas, somada à variação de medição perto de 10 ms. Só com A, o mesmo plano já variou entre 8 e 15 ms de uma página para outra.
- O critério foi fixado antes, sem tolerância, por isso fica registrado como **FALHA**.
- Não mexi no critério nem acrescentei índice: um índice novo viraria migration e devolveria a PS-4 ao Astra (rev. 0).
- Decisão para a revisão: aceitar o desvio declarado ou pedir outra medida (por exemplo, critério absoluto em ms, ou mais amostras).

**Ajustes do protocolo de mutantes nesta rodada:**
- **Textos trocados pela nova forma do SQL de P:** P05, P06, P12 e P13.
- **P02:** a asserção do cartão "sem unidade" ganhou mensagem causal.
- **P16/P16b:** o mutante descartava o parâmetro do desempate, e o PostgreSQL acusava erro de tipo (500), um mutante mal formado. Agora mantém o parâmetro e morre na asserção causal. P16b morre na contagem de páginas ("50+50+50+50+1").
- **P06:** equivalente. A 019 (`kidmais019_validar_contrato`) recusa festa CANCELADA com contrato ASSINADO (23514), e a suíte agora prova essa recusa. Portanto, o `EXISTS` do contrato ASSINADO já tira de P toda festa cancelada. O `f.status <> 'CANCELADO'` fica como guarda explícita da D-PS4-6.

### Limites declarados

- Flag desligada e plano sem o recurso são provados no PG (rotas), não no E2E.
- O estado INCERTA/suprimida é coberto como envio ATIVO sem disparo (a PS-4 só lê).
- O ensaio de desempenho mede uma máquina local, não escala de produção.
- A condição `f.empresa_id` é defesa em profundidade: nenhum teste funcional a mata (o join pela chave do envio já filtra a empresa); quem a observa é o critério 3 do ensaio.

### Rollback

Reverter os arquivos listados (sem commit). Nada no banco: sem migration, sem dado novo.

## PS-4 — rodada 2 (parecer do código: 0 P1, 2 P2, 1 P3) — LOCAL, sem commit (02/11/2026)

O parecer aceitou P, os escopos, os cursores SQL, as extensões e os ajustes de mutantes. Esta rodada fecha C1, C2 e C3.
Também corrige uma conclusão da rodada 1: o critério 3 **não tinha passado**, porque o verificador mascarava a varredura das respostas de B e C.

### PS4-C1 — gerações de carregamento

`useLeituraViva` passa a usar transições puras de `components/admin/satisfacao/geracao.ts`:
- **Geração nova a cada transição:** cada transição de consulta abre uma geração com número estritamente maior. Isso vale para trocar filtro, unidade, período ou estado, para **voltar** a uma URL anterior, para "Tentar novamente" e para recarregar depois de concluir. A → B → A são três gerações.
- **Descarte do que é antigo:** página 1, "Ver mais", erro e recusa carregam o número da geração que os pediu. Uma geração encerrada não aplica nada.
- **Abort no fim da geração:** a requisição da página 1 e todo "Ver mais" pendente dela são abortados (antes, o "Ver mais" não recebia o sinal).
- **Recusa vigente:** continua SUBSTITUINDO tudo, sem nenhum dado anterior na tela.

### PS4-C3 — "Tentar novamente"

As duas telas mostram **Tentar novamente** nas falhas recuperáveis: rede e 5xx, exceto 503. O botão abre uma geração nova na mesma URL.
- Recusas (400/403/404) e indisponível (503) não oferecem o botão e não mostram dados anteriores.
- "Ver mais" com falha esvazia a lista e oferece a repetição, que volta à página 1.

### PS4-C2 — acesso por empresa (SQL e verificador)

**SQL** (`lib/satisfacao/resultados.ts`):
- As respostas de P e as tarefas (cartão de retornos e selo por item) passam a ser buscadas **por chave**: `CROSS/LEFT JOIN LATERAL (… WHERE envio_id/resposta_id = … AND empresa_id = $1 LIMIT 1)`.
- O `LIMIT` impede o planner de achatar a subconsulta e trocar as buscas por Seq Scan + hash da tabela inteira. Era o plano que lia 16 mil respostas de B/C e removia por filtro.
- As chaves são únicas (`satisfacao_respostas_envio_uk`, `satisfacao_tarefas_resposta_uk`). Sem índice nem migration.

**Verificador** (`ambientes-locais/satisfacao-ps4-desempenho.ts`):
- O teto fixo de 20.000 saiu.
- Em cada fase, conta as linhas da empresa A em cada relação e o total da relação.
- Um nó que lê `satisfacao_envios`, `satisfacao_respostas`, `satisfacao_tarefas` ou `fechamentos` reprova se as linhas lidas passarem das linhas de A naquela relação. Linhas lidas = devolvidas + removidas por filtro ou recheck, vezes as voltas.
- A condição de empresa passa a ser conferida **pelo valor** (`empresa_id = '<A>'::uuid`), não pela presença do nome da coluna.
- **Controle negativo:** a regra nova, aplicada aos planos preservados da rodada 1 (`2026-11-01T12-57-00-252Z`), reprova exatamente os 10 planos apontados no parecer (Seq Scan de respostas com 24.000 linhas lidas; A tem 8.000).

**Harness:**
- A fase "só A" tinha, em `fechamentos`, a festa-modelo de B e de C (criadas antes da medição). Contrariava "B e C vazios" da rev. 1.1.
- Agora B e C nascem depois da fase "só A". Com isso, a regra estrita apontou um Seq Scan de `fechamentos` na fase "só A" que lia essas 2 linhas.
- Na fase A+B+C, com B e C carregados, nenhum nó lê linha de outra empresa.

### Provas da rodada 2 (cluster descartável 127.0.0.1:55551)

| Prova | Resultado |
|---|---|
| Unitários (`navegacao`, `satisfacao-ps4` com a corrida C1, `satisfacao-ps3`) | **15/15** |
| Suítes PG PS-3 + PS-4 com o SQL novo | **PASS** (`2026-11-02T21-55-44-001Z-check-v1-postgres.log`) |
| Regressão PG completa | **257/257 arquivos PASS** com o código final (`2026-11-02T22-56-01-700Z-check-v1-postgres.log`) |
| E2E PS-4, com o passo 6 novo: A → B → A com o "Ver mais" retido (sucesso real, 500 e 403 tardios) e "Tentar novamente", nas duas telas | **44/44 PASS** (`2026-11-02T22-08-38-080Z-e2e-ps4`) |
| Controle negativo do C1: o mesmo E2E contra o clone LF ainda com o hook da rodada 1 | **FAIL causal:** "página 2 real do 'Ver mais' antigo" com 59 itens (a página antiga foi anexada), seguido de parada (`ambientes-locais/satisfacao-ps4-e2e-controle-c1-20261102.log`) |
| E2E PS-1 / PS-2 / PS-3 / PS-G | **36/36, 14/14, 16/16, 34/34** |
| Mutantes (bateria única, com P26–P31 novos: geração que não avança, "Ver mais" sem geração, hook da rodada 1 no navegador, sem repetição, repetição em recusa, botão ausente na tela) | **32 mortos + 1 equivalente (P06) de 33**, 0 vivos, 0 inconclusivos (`2026-11-02T22-52-33-390Z-mutantes-ps4.txt`) |
| CI local | **49/49** (`ambientes-locais/ci-local-satisfacao-ps4-r2-20261102.log`; `next-env.d.ts` preservado); cluster encerrado no fim |

### Desempenho da rodada 2: matriz original, duas execuções completas

| Execução | Resultado |
|---|---|
| `2026-11-02T22-01-48-900Z-desempenho-ps4` | **145/145 PASS**. Critérios 1–5 todos verdes; p95 máximo 47 ms; maior razão A × (A+B+C) ×1,42. |
| `2026-11-02T22-04-51-349Z-desempenho-ps4` | **144 PASS, 1 FALHA**. Critérios 1, 2, 3 e 5 verdes; p95 máximo 42 ms. Critério 4 falha em 1 de 20 combinações: Equipe (VER U1) × U1 × 366 datas × página 1, 19 → 30 ms (×1,58). |

**Critério 3:** passa em todas as medições das duas execuções, com nenhum nó lendo linha de outra empresa. Na fase A+B+C, as respostas caem de 24.000 linhas lidas (rodada 1) para buscas por chave: 3.600 buffers, iguais nas duas fases.

**Critério 4, registrado sem tolerância:**
- A combinação que falhou na 2ª execução deu ×0,75 na 1ª (24 → 18 ms).
- Nas duas execuções, os buffers dessa combinação são da mesma ordem nas duas fases: respostas 3.600 = 3.600; `fechamentos` 770 → 494 na 1ª e 770 → 787 na 2ª.
- Uma execução saiu verde e a outra teve 1 falha de 20. Fica registrado como está: não repeti até passar e não atribuo a causa sem controle.

### Limites declarados (rodada 2)

- **Retornos:** a fila da semente do E2E não passa de 50, então o `proximo` da página 1 é **injetado pela rota** do Playwright para exercitar o "Ver mais" e a corrida. O hook e as transições são os mesmos de Resultados, onde a prova usa dados e cursor reais.
- **Desempenho:** é a capacidade desta máquina, não de produção. O critério 4 continua sendo medido sem tolerância.

## PS-4 — rodada 3 (parecer da rodada 2: 0 P1, 2 P2) — LOCAL, sem commit (03/11/2026)

O parecer fechou C1 e C3, aceitou o SQL da rodada 2 e a mudança do harness B/C. Esta rodada responde aos dois P2 restantes (o gate de desempenho permanece falho, ver o protocolo abaixo):
- C2 na instrumentação: origem da chave comprovada e teto pela população da combinação.
- Critério 4 de desempenho, com protocolo de confirmação fixado antes de executar.

### Achado da análise dos planos da rodada 2

Achado físico que pode contribuir para o ×1,58; a causalidade do ×1,58 **não foi isolada** (o EXPLAIN separado não isola a razão do p95 do cliente). Nos 20 planos A+B+C da rodada 2, a CTE `festas` fazia dois acessos que mudavam com a carga de B e C (o de contratos lia linhas de todas as empresas; o das festas mudava de plano, sem aumentar a população de A):
- **Contratos:** o `EXISTS` do contrato ASSINADO virava hash semi-join com **Seq Scan de `contratos` inteira**: 60.003 linhas, de A, B e C. Na fase só A eram 20.001.
- **Festas de A:** na fase A+B+C, as festas eram lidas pelo índice só de empresa (`fechamentos_054_empresa_idx`), com todas as 20.001 festas de A lidas e 19.064 removidas no período de 1 mês.

`contratos` não tem `empresa_id` e **não estava entre as relações verificadas**, por isso o verificador da rodada 2 não acusou essa leitura de outras empresas. A frase da rodada 2 "na fase A+B+C nenhum nó lê linha de outra empresa" estava **errada** e fica corrigida aqui. Também fica corrigida a precisão apontada no parecer: o controle da rodada 2 reprovava "exatamente 10 planos" **da fase A+B+C de `2026-11-01T12-57-00-252Z`**. No diretório inteiro, a regra estrita reprova também 10 planos só A de 366 datas, pelas 2 festas-modelo de B/C.

### SQL (`lib/satisfacao/resultados.ts`), sem índice nem migration

- **Festas do período:** `festas` lê uma **faixa do índice 062 `(empresa_id, estabelecimento_id, data_evento)` por unidade da empresa** (`CROSS JOIN LATERAL … OFFSET 0`, que impede o achatamento) e mais a faixa das festas sem unidade (`estabelecimento_id IS NULL`).
  - É equivalente ao filtro anterior: a FK 062 `(empresa_id, estabelecimento_id) → estabelecimentos(empresa_id, id)` garante que toda festa com unidade aponta para uma unidade da mesma empresa.
- **Contrato ASSINADO:** sai de `festas` e entra em P **por chave**: `CROSS JOIN LATERAL (SELECT 1 FROM contratos ct WHERE ct.fechamento_id = e.fechamento_id AND ct.status = 'ASSINADO' LIMIT 1)`.
  - `fechamento_id` é único em `contratos`, então o `LIMIT` não muda o resultado; ele só impede o semi-join com varredura.
  - A busca acontece depois do recorte de unidade e estado: 3.000 buscas em U1/366 datas, em vez de 11.400.
- **Envios:** continuam pelo prefixo `empresa_id` (hash com as festas, como na rodada 2). Nenhum índice de envios tem a data da festa, e buscar envio por festa custaria 11.400 buscas no período de 366 datas (medido na sondagem 1).

### Verificador do critério 3 (`ambientes-locais/satisfacao-ps4-verificador.ts`, função pura)

1. **Condição de A pelo valor:** em Index Cond, Filter ou Recheck Cond, com **nenhuma** comparação de `empresa_id` com outro valor.
2. **Chaves:** a exceção genérica por chave **saiu**. Só vale chave de **origem comprovada**, e só na lista declarada: `contratos.fechamento_id ← fechamentos.id` ou `satisfacao_envios.fechamento_id`, porque `contratos` não tem `empresa_id`.
   - Comprovar = a Index Cond é exatamente `(fechamento_id = alias.coluna)`, com a coluna na lista.
   - Subindo pelos ancestrais, o primeiro Nested Loop que tem o nó no lado **interno** tem, no lado **externo**, ao menos um nó com esse alias. Aliases renomeados pelo EXPLAIN (`f_1`, `f_2`) contam como `f`.
   - **Todos** os nós com esse alias ali leem a relação de origem com a condição de A.
3. **`contratos` passa a ser monitorado,** junto de `satisfacao_envios`, `satisfacao_respostas`, `satisfacao_tarefas` e `fechamentos`.
4. **Teto por relação = população DECLARADA da combinação,** contada por SQL próprio (não pelo serviço) em cada fase e combinação e gravada em `tetos.json`:

| Relação | Teto | Origem declarada |
|---|---|---|
| `fechamentos` | festas de A no período (todas as unidades e estados) | faixas do 062 |
| `contratos` | festas de A não canceladas do período | busca por `fechamento_id` a partir da festa/envio de A |
| `satisfacao_envios` | envios de A | prefixo `empresa_id`; nenhum índice de envios tem a data da festa |
| `satisfacao_respostas` | P da combinação (período, estados, unidades do filtro) | busca por `envio_id` |
| `satisfacao_tarefas` | respostas de P da combinação | busca por `resposta_id` |

   Linhas lidas = (devolvidas + removidas por filtro/recheck) × voltas. Sem teto declarado = falha.

**Limite declarado (do parecer):** contagem de visitas não identifica tenants, e os contadores por volta são arredondados. A regra sustenta que os acessos são condicionados a A ou a chaves de origem A, e que nenhum nó lê além da população declarada. Não sustenta "nenhum nó lê linha de outra empresa".

### Controles do verificador (`ambientes-locais/satisfacao-ps4-verificador-controles.ts`, sem banco)

**14/14 PASS.** Os casos sintéticos são 3 positivos e 11 negativos:
- chave de origem desconhecida com filtro da empresa B;
- origem que lê festas de B;
- alias ausente;
- origem de outra relação;
- contrato por Seq Scan;
- condição com A e B;
- leitura ampla de A (937 + 19.064 removidas) que cabe no teto histórico de 20.001, mas passa do período (989);
- contrato no lado externo;
- envio de B como origem;
- coluna de origem fora da lista;
- alias renomeado com um nó sem A.

A regra da rodada 2, reproduzida no mesmo script, **aceitava 8 dos 11 negativos**.

**Reaplicação aos planos preservados** (com os `tetos.json` da execução 2; a massa é determinística em relação a `current_date`), em `ambientes-locais/satisfacao-ps4-r3-verificador-controles-20261103.log`:

| Planos | Resultado | Motivo principal |
|---|---|---|
| Rodada 1 (`2026-11-01T12-57-00-252Z`) | 0/40 PASS | Seq Scan de contratos (todas as empresas) em 40; respostas, tarefas e festas além da população |
| Rodada 2, 1ª e 2ª execuções | 0/40 PASS em cada | Seq Scan de contratos em 40; festas além do período em 10–30 |
| Rodada 3, execução 1 | 30/40 PASS | 10 planos A+B+C de 366 datas: festas pelo índice só de empresa dentro de cada faixa |
| Rodada 3, execuções 2 e 3 | 40/40 PASS | — |

### Critério 4: protocolo fixado antes de executar

Registrado no vault às 01:05Z, antes de qualquer medição da rodada 3:
- matriz e critérios originais, sem tolerância;
- **três execuções completas consecutivas**, todas preservadas;
- o critério 4 só passa se **as três** tiverem 0 FAIL;
- se falhar, sem quarta execução.

Duas **sondagens de plano** (só EXPLAIN + verificador, sem tempo; `KIDMAIS_PS4_SONDA=1`) vieram antes e também estão registradas:
- `2026-11-03T01-07-13-774Z-sonda-planos-ps4`: 40 FAIL do verificador (alias renomeado; custo das buscas de envio), que levaram aos ajustes acima;
- `2026-11-03T01-15-02-790Z-sonda-planos-ps4`: PASS.

**Resultado do protocolo: critério 4 FALHA.** As três execuções foram preservadas: `2026-11-03T01-19-45-700Z`, `01-23-52-388Z` e `01-29-06-897Z` (`-desempenho-ps4`), com resumo em `ambientes-locais/satisfacao-ps4-r3-protocolo-c4-20261103.log`. Não houve quarta execução.

| Execução | Resultado | Critérios 1/2/5 | Critério 3 | Critério 4 |
|---|---|---|---|---|
| 1 | 15 FALHAS | PASS | **10 FAIL**: A+B+C, 366 datas, todas as combinações | **5 FAIL**: ×2,00, ×2,00, ×1,52, ×3,40, ×2,38 |
| 2 | 2 FALHAS | PASS (p95 máx. 89 ms) | PASS | **2 FAIL**: Equipe todas as autorizadas × 1 mês × página 1, 15 → 24 ms (×1,60); × 366 datas × profunda, 32 → 50 ms (×1,56) |
| 3 | 2 FALHAS | PASS (p95 máx. 131 ms) | PASS | **2 FAIL**: Gestão U1 × 1 mês × página 1, 13 → 20 ms (×1,54); Gestão sem unidade × 366 datas × profunda, 32 → 50 ms (×1,56) |

**Análise (sem converter nada em PASS):**
1. **Instabilidade de plano (execução 1).** O `OFFSET 0` impede o achatamento, mas não obriga o índice.
   - Na fase A+B+C da execução 1, o planner escolheu `fechamentos_054_empresa_idx` dentro de cada faixa, com unidade e data no Filter. Leu as 20.001 festas de A 3 vezes, mais 1 vez no ramo sem unidade.
   - São só linhas de A (Index Cond pelo valor), mas além da população declarada. O verificador novo acusou; o da rodada 2 teria aceitado.
   - Nas execuções 2 e 3, com outra amostra do ANALYZE, o plano usou o 062.
   - O SQL desta rodada não garante a faixa. Um índice novo também só oferece um caminho: a escolha continua com o planner, e a faixa precisa ser conferida nos planos.
2. **Variação de medição (execuções 2 e 3).** Com verificador PASS e o mesmo tempo de servidor no EXPLAIN nas duas fases, a mesma combinação variou mais de 1,5× **dentro da mesma fase** entre execuções:
   - Equipe todas as autorizadas × 1 mês × página 1: só A 15 ms na execução 2 e 28 ms na 3; A+B+C 24 ms e 15 ms. O EXPLAIN deu ~10,7 ms nos quatro casos.
   - O p95 de 20 amostras medido do cliente (clock_timestamp por ida e volta) não discrimina 1,5× nessa escala, nesta máquina.
   - Isso é registrado como observação com controle (mesmo plano, mesmo tempo de servidor), **não** como exceção.

**Decisões pedidas a Felipe** (mudança explícita de contrato, separada, sem efeito retroativo):
- **D-PS4-R3-1, critério 4:** manter como está; ou mudar o método (por exemplo, 100 amostras e comparação do tempo de execução do servidor); ou acrescentar um piso absoluto (por exemplo, a razão só reprova quando a diferença passa de 10 ms).
- **D-PS4-R3-2, plano das festas:** propor uma migration de índice `(empresa_id, data_evento)` (proposta própria, como exige o parecer); ou aceitar a leitura das festas de A pelo prefixo da empresa como população declarada (como os envios).

### Provas da rodada 3 (cluster descartável 127.0.0.1:55551)

| Prova | Resultado |
|---|---|
| Suítes PG PS-3, PS-3 rotas e PS-4, com o SQL final da rodada | **3/3 PASS** (`2026-11-03T01-18-45-501Z-check-v1-postgres.log`) |
| Controles do verificador (sem banco) | **14/14 PASS** + reaplicação acima |
| Mutantes | bateria **não executada** nesta rodada: P06, P12 e P13 foram adaptados ao SQL novo e P32–P34 acrescentados (sem contrato ASSINADO, sem ramo sem unidade, sem ramo por unidade). Os 36 trechos casam exatamente uma vez (conferido sem banco) |
| Regressão PG completa, E2E PS-1..PS-G, CI | **não executados** nesta rodada: o SQL das festas depende de D-PS4-R3-2 e pode mudar de novo. Ficam para depois da decisão, junto da bateria de mutantes |

Unitários e telas não mudaram desde a rodada 2.

## PS-4 — rodada 3.1 (parecer r3: 0 P1, 1 P2, 2 P3) — LOCAL, sem commit (03/11/2026)

O parecer aceitou o achado dos contratos e a errata, o teto "envios de A", o registro do FAIL do protocolo, a P-114 (desenho para implementação local) e o método rev. 1.2. Esta rodada responde ao P2 e aos dois P3. **O gate de desempenho continua falho** até as três execuções da rev. 1.2 com a candidata final.

### PS4-R3-C2-OR — A como restrição obrigatória (verificador)

- **Defeito:** `porEmpresa` aceitava o valor de A em qualquer lugar do texto. Por isso, `(empresa_id = A) OR (status = 'CONFIRMADO')` passava, e também certificava a origem do contrato.
- **Correção:** em `ambientes-locais/satisfacao-ps4-verificador.ts`, A só conta se um **termo da conjunção do nível de fora** de Index Cond, Filter ou Recheck Cond for exatamente `[alias.]empresa_id = '<A>'::uuid`.
  - A separação respeita parênteses e aspas.
  - Com OR no nível de fora, a expressão inteira vira um termo só, porque AND tem precedência maior.
  - A dentro de OR, NOT ou outra estrutura não prova nada.
  - Continua recusada qualquer comparação de `empresa_id` com outro valor.
- **Controles: 20/20 PASS** (`ambientes-locais/satisfacao-ps4-r4-verificador-controles-20261103.log`). São 6 novos:

| Caso | Esperado e obtido |
|---|---|
| A dentro de OR no acesso direto | FAIL |
| A dentro de OR na origem do contrato (a sonda do parecer) | FAIL |
| `A AND x OR y` | FAIL |
| `NOT (A)` | FAIL |
| A obrigatória com OR só nas condições adicionais | PASS |
| A com alias junto de outros termos no Index Cond | PASS |

- **Reaplicação, igual à da rodada 3 nos planos de execução:**
  - rodada 1 e as duas execuções da rodada 2: 0/40 cada;
  - rodada 3, execução 1: 30/40;
  - execuções 2 e 3: 40/40 cada.

  Nenhum plano real foi aceito ou recusado de forma diferente pela regra estrita: todos os nós monitorados das execuções trazem A como termo obrigatório.
- **Sondagens:** a 1 (`01-07-13-774Z`) agora dá 40/40, porque suas falhas vinham do tratamento de aliases da versão anterior do verificador, não de leitura fora de A. A 2 dá 40/40.

### Precisões P3

- **PS4-R3-DOC-CAUSA:** o texto da rodada 3 passa a dizer "achado físico que pode contribuir; causalidade do ×1,58 não isolada". Ler todas as festas de A muda o plano/custo, não a população de A.
- **PS4-R3-DOC-PLANNER:** o comentário do SQL em `lib/satisfacao/resultados.ts` e o texto da rodada 3 deixam claro que:
  - o `OFFSET 0` só impede o achatamento;
  - os envios são lidos pelo prefixo da empresa;
  - um índice (inclusive a futura 114) só **oferece** o caminho; a faixa observada é conferida nos planos.
- **Abertura da rodada 3:** passa a dizer "responde aos dois P2; gate permanece falho". O critério 4 isoladamente falhou **5/2/2** (os totais 15/2/2 incluem os 10 FAIL do critério 3 da execução 1).

### Estado

- Sem mudança de SQL nesta rodada (só comentário).
- **A 114 não foi implementada.** O número continua provisório até a reconferência no GitHub e uma nova busca local de colisões em migrations, checks e down.
- Pendentes para a candidata final: 114 + SQL simples das festas; as 3 execuções rev. 1.2; regressão PG; E2E; bateria de mutantes (P06/P12/P13 adaptados, P32–P34); CI.

## PS-4 — rodada 4 (índice 115, D-PS4-R4-1/2/3) — LOCAL, sem commit (03/11/2026)

A rodada implementa o índice proposto como P-114 e o SQL simples das festas. **Resultado do gate de desempenho: FAIL** (r4.3: PASS / 1 FAIL / PASS). Regressão, E2E, mutantes e CI passam.

### Migration 115 (a 114 foi tomada por "liberar salões")

- `database/migrations/20261103_115_fechamentos_empresa_data.sql`: `fechamentos_115_empresa_data_idx ON fechamentos (empresa_id, data_evento)`, em transação com `lock_timeout` 5 s e `statement_timeout` 60 s; guarda de definição antes de criar (homônimo divergente aborta sem alterar nada).
- **D-PS4-R4-2 (Felipe):** a mesma transação remove `fechamentos_054_empresa_idx` **depois** de criar o 115, com guarda de que o 054 é exatamente o da 054. O down recria o 054 **antes** de remover o 115. Precheck: 115 e 054 ausentes ou conformes; postcheck: 115 conforme e 054 ausente.
- `indkey`/`indoption` são `int2vector` com base 0: as guardas comparam elemento a elemento, nunca `= ARRAY[...]`.
- `lib/satisfacao/migration-115.postgres.test.ts` (modelo 111): ciclo subida/down com o 054, 11 homônimos divergentes do 115 e 7 do 054 recusados, `lock_timeout` real, ordem criar→remover e recriar→remover. Inventário (`check-migrations.mjs`, `production.test.mjs`) e receita (modelo "115", PS-4 roda nele).

### SQL das festas

`festas AS MATERIALIZED` virou um recorte só: `f.empresa_id = $1 AND data_evento BETWEEN $3 AND $4 AND status <> 'CANCELADO'`. O índice só **oferece** a faixa; o plano é conferido pelo verificador.

### Decisões de Felipe nesta rodada

- **D-PS4-R4-1:** o teto de `fechamentos` no critério 3 é o prefixo da empresa (todas as festas de A), como já era o de envios. Motivo: em "só A, 366 datas" A é quase a tabela inteira e o Seq Scan é legítimo.
- **D-PS4-R4-2:** remover o 054. Investigação: o plano alternava 115 × 054 entre execuções por causa da correlação física de `empresa_id` (carga em bloco + UUID aleatório); reproduzido com `CLUSTER` (correlação 1 → Index Scan pelo 054, 13,0 × 9,1 ms). Sem o 054: 10/10 combinações pelo 115.
- **D-PS4-R4-3:** a r4.2 (FAIL 10/7/2) foi **anulada**: medida com a máquina carregada por outras sessões (planos e buffers iguais, nós 3–7× mais lentos). O script de desempenho ganhou a **guarda de máquina livre**: CPU ≤ 12% em 2 s e nenhum processo de teste/CI/mutante/build de outra sessão, antes de cada fase, de cada combinação e no fim; picos tolerados por 60 s, senão a execução é ANULADA (código 2), sem veredito. As três que contam são as três primeiras não anuladas, consecutivas.

### Bateria da candidata (r4.3, 03/11 15:11–17:10Z, sequencial)

- Regressão PG completa: **259/259 arquivos** no estado declarado.
- E2E: PS-1 36, PS-2 14, PS-3 16, PS-4 44, PS-G 34 — todos PASS.
- Mutantes PS-4: **35 mortos + 1 equivalente de 36**. O P34 morria no subteste certo, mas a asserção não tinha mensagem; ganhou "Gestão: respostas de U1, U2 e sem unidade" (só teste/ferramenta), e P33+P34 repetidos: 2/2.
- CI local: 48/49; a falha (`check:v1:static`) foi `.next/dev/types/routes.d.ts` corrompido pelo `next dev` do E2E (arquivo gerado e ignorado). Removido `.next/dev/types`, `check:v1:static` sozinho: PASS.

### Protocolo rev. 1.2 com guarda (r4.3, 03/11 17:10–18:45Z): FAIL

Candidata congelada: `resultados.ts` bdaae3bf…, 115 7054edb5…, down fe62a12e…, desempenho 0cbd9bce…, verificador 255f775f…. Sonda PASS. Tentativa 1 ANULADA (CPU 18,4%). Execuções válidas:

| Execução | Resultado |
|---|---|
| 1 | PASS |
| 2 | 1 FAIL: A × (A+B+C), Equipe (VER U1), todas as autorizadas, 1 mês, profunda — servidor p95 3,04 → 4,84 ms (×1,59) |
| 3 | PASS |

Critérios 1–3 PASS nas três. Pela regra (três válidas, todas 0 FAIL, sem quarta), o gate é **FAIL**. A mesma combinação deu ×1,46 na execução 1.

### Diagnóstico do ×1,59 (só sondas, candidata inalterada)

- **Não é contratos:** 231 buscas por chave nas duas fases; 3 → 4 buffers por busca = um nível a mais no índice depois da carga de B/C (≈0,001 ms por busca).
- **É `satisfacao_envios`:** P junta as festas do período com **todos os envios de A** (≈20 mil, o histórico inteiro) por Hash Join. Em só A é Seq Scan (A é a tabela inteira, 1,17 ms); em A+B+C, Bitmap Heap Scan por `satisfacao_envios_cliente_idx` (1,72 ms) e Hash Join mais lento: 3,3 → 4,1 ms no total.
- **Envio por chave** (`LATERAL … LIMIT 1` por `satisfacao_envios_festa_uk`; `ambientes-locais/satisfacao-ps4-investigar-envios.cjs`, banco mantido A+B+C, máquina livre): resultado idêntico nas 20 combinações. 1 mês: p50 melhor em 9 de 10 (a combinação que falhou 4,61 → 2,55 ms), pior em Gestão todas profunda (5,07 → 6,46 ms). 366 datas: ≈2× pior em todas (p50 12–34 → 23–47 ms; 11.400 buscas).
- Não há remédio único só no SQL. O custo do mês cresce com o histórico de envios da empresa, não com B/C; continua longe do critério 1 (p95 < 300 ms).

### Estado

- Candidata sem commit sobre a7ca19e5; nenhuma migration aplicada fora do cluster descartável (encerrado).
- Decisão de Felipe: levar o FAIL ao Astra com este diagnóstico, sem mudar código. Qualquer ajuste do critério 4 (por exemplo, um limite absoluto junto do 1,5×) seria decidido depois do resultado e depende de aprovação explícita.

## PS-4 — rodada 4.4 (parecer r4: FAIL mantido, 2 P2, 2 P3) — LOCAL, sem commit (03–04/11/2026)

Parecer r4 do Astra: o FAIL da r4.3 permanece; a troca do 054 pelo 115 está aprovada como desenho LOCAL; achados P2-C1, P2-F1, P3-C2, P3-C3. Esta rodada corrige os quatro. **Nenhuma medição nova de desempenho**: o critério 4 só muda com Δ aprovado por Felipe antes de medir.

### P2-C1 — revogação parcial sem saída (Resultados e Retornos)

- `leitura.ts`: `recusada(f)` = 403/404. Com uma unidade escolhida e a leitura recusada, o cartão de falha mostra **"Ver todas as minhas unidades"** (`data-limpar-unidade`), que limpa o filtro e relê o escopo atual sem restaurar o conteúdo recusado. Igual em `SatisfacaoResultados.tsx` e `RetornosPagina.tsx`.
- E2E: misto com VER Centro+Norte escolhe o Centro, o VER do Centro é revogado → "Sem acesso" sem dados, com o botão → clique → só o Norte no seletor, nada do Centro. Retornos: pessoa nova `tratar2` (TRATAR Centro+Norte), mesmo roteiro.

### P3-C2 — personalizado incompleto

- `aguardandoDatas` (personalizado sem as duas datas): nenhuma consulta e aviso "Escolha as duas datas para ver os resultados do período." (`data-aguardando-datas`). `useLeitura` não consulta com base vazia.
- E2E: só o início → aviso, 0 pedidos em 1,5 s, sem cartões nem linha de período.

### P2-F1 — guarda de máquina livre (ferramenta, fora do patch de produto)

- `ambientes-locais/satisfacao-ps4-guarda.mjs` (novo, usado por `satisfacao-ps4-desempenho.ts` e `satisfacao-ps4-carga-agora.mjs`): inventário com erro de spawn, código ≠ 0, saída vazia ou sem o próprio PID = **indisponível = não livre** (a medição é anulada). Exclui só o próprio PID; nenhuma exclusão por nome — outro `satisfacao-ps4-desempenho.ts` independente conta como carga.
- Alcance temporal declarado: a guarda observa **pontos de admissão** (antes de cada fase), não a medição inteira; espera até 12 observações ≈ 84 s (5 s + ≈2 s de inventário cada). A CPU agregada (12%) é só sinal de admissão.
- Controles `satisfacao-ps4-guarda-controles.mjs`: 9 simulados + inventário real = **10/10 PASS** (`ambientes-locais/satisfacao-ps4-r4-4-guarda-controles-20261103.log`).

### P3-C3 — locks documentados

- Comentários da 115 (subida e down): o DROP INDEX pede ACCESS EXCLUSIVE em `fechamentos` e bloqueia também **leituras** até o COMMIT, esperando leitores abertos; `lock_timeout` vale por espera de lock e `statement_timeout` por instrução, não pela migration. Ensaio de bloqueio com leitor aberto é pré-requisito de implantação persistente (não feito aqui). Sem mudança de SQL.

### Bateria (03/11 21:22Z → 04/11 00:30Z, sequencial, nunca CI junto com PG)

- **E2E PS-4 49/49 PASS** na candidata; controle (clone de mutantes ainda sem as correções) com exatamente **5 FAIL** nas checagens novas (`satisfacao-ps4-r4-4-e2e-ps4-20261103.log`, `-controle-`).
- **Mutantes 39** (P35/P36/P37 novos para C1/C2): bateria completa 36 mortos + 1 equivalente + 2 VIVOS por causa de infraestrutura — P24 `statement timeout` na montagem da base (antes de qualquer asserção) e P31 cujo erro de limpeza (`DROP DATABASE … being accessed by other users`) escondeu a falha real. Ferramenta E2E corrigida (registra a causa da interrupção antes da limpeza; repete o DROP FORCE até 6×) e **P24/P31 reexecutados isoladamente: MORTOS** pela causa esperada. Total: 38 mortos + 1 equivalente de 39, composto por duas execuções (não uma bateria única). Relatórios `2026-11-03T23-00-31-514Z-mutantes-ps4.txt` e `2026-11-04T00-29-43-262Z-mutantes-ps4.txt`.
- **PG** migration-115 + PS-4 PASS; **CI local 49 passos, 0 falha** (`satisfacao-ps4-r4-4-ci-20261103.log`).

### Estado

- Candidata sem commit sobre a7ca19e5; 115 só no cluster descartável (encerrado).
- **FAIL da r4.3 mantido.** Próximo passo depende de Felipe: aprovar um Δ para o critério 4 híbrido prospectivo (reprova só se p95_ABC > 1,5 × p95_A **e** p95_ABC − p95_A > Δ; matriz inteira, todas as páginas, 3 execuções válidas novas) ou manter o contrato atual. Nenhum valor de Δ está aprovado.

### Parecer do Astra sobre a r4.4 (04/11/2026)

- P2-C1, P2-F1, P3-C2 e P3-C3 **fechados** no escopo LOCAL (P3-C3 como documentação); nenhum achado novo. Composição de mutantes 38 + 1 equivalente em duas execuções aceita. ≈84 s da guarda é estimativa, não prazo garantido.
- O FAIL da r4.3 permanece. Falta: decisão de Felipe sobre Δ do critério 4 (ou manter 1,5×) e novo protocolo conforme a decisão; antes de implantação persistente, consumidores de `fechamentos` e ensaio de lock com leitor aberto.

### D-PS4-R4-4 (04/11/2026)

Felipe manteve o critério 4 só como razão ≤ 1,5× (sem Δ). O aceite completo depende de novo protocolo rev. 1.2 (3 execuções válidas, 0 FAIL); a SQL das festas é a mesma da r4.3.


### Protocolo r4.4 (04–05/11/2026): SEM VEREDITO

- `ambientes-locais/satisfacao-ps4-r4-4-protocolo.sh`, log `satisfacao-ps4-r4-4-protocolo-20261104.log`. Preparado 04/11 02:17Z; máquina livre só às 09:20Z; sonda PASS; candidata congelada (resultados.ts bdaae3bf…, 115 35e971aa…, down 95445970…, desempenho.ts 6a150b53…, guarda.mjs 147946f6…).
- **0 execuções válidas, 3 ANULADAS** (09:22Z, 09:29Z, 14:06Z): outras sessões carregaram a máquina durante a medição (mutantes-r9, barreira-b16/drenagem, CI liberar-salões, login-production). Depois, 12 h de espera sem janela livre → **parado sem veredito** 05/11 02:53Z (código 3). Cluster 55551 encerrado.
- Não é FAIL nem PASS: nenhuma medição contou. O FAIL da r4.3 segue. Próximo: relançar o mesmo script numa janela em que Felipe pause as outras sessões (≈15–20 min com a máquina livre).

### Protocolo r4.4, 2ª tentativa (05–06/11/2026): FAIL

- Script `ambientes-locais/satisfacao-ps4-r4-4b-protocolo.sh`, log `satisfacao-ps4-r4-4-protocolo-20261105.log`. Mesma candidata congelada (critério 4 só 1,5×, D-PS4-R4-4). Sonda PASS 15:49Z.
- **Execução 1 (06/11 02:00–02:14Z), válida: 1 FAIL em 40 comparações.** Equipe (VER U1) | todas as autorizadas | 1 mês | página 1: servidor 3,36 → 6,99 ms (**×2,08**, +3,63 ms). É a mesma combinação do ×1,59 da r4.3. Mais próximas sem falhar: ×1,49 (Equipe VER U1, U1, 1 mês, página 1, 3,48 → 5,17 ms) e ×1,47 (Gestão, U1, 1 mês, profunda). Demais critérios sem falha.
- **Execução 2 não terminou:** interrompida ≈02:27Z com o encerramento da sessão, sem veredito e sem contar. Execução 3 não rodou.
- **Resultado do protocolo: FAIL** (uma execução válida com FAIL basta; rev. 1.2 exige 0 FAIL nas 3). Relançar a mesma candidata não muda isso.
- Limite da evidência: a guarda só observa pontos de admissão; não prova que o ×2,08 esteja livre de ruído durante a medição. Com base de ≈3 ms, poucos ms movem muito a razão; o critério 1 (p95 < 300 ms) segue folgado.
- Cluster 55551 parado pela interrupção; ficou `postmaster.pid` órfão (PID 6100 inexistente), a tratar antes do próximo `iniciar`. Sem commit, sem publicação.
- Pendente: decisão de Felipe entre investigar o SQL (sondas, sem mudar a candidata) e reabrir o critério 4. Qualquer novo critério é prospectivo; r4.3 e r4.4 continuam FAIL.

### Investigação do critério 4 (06/11/2026): só sondas, candidata inalterada, r4.4 continua FAIL

Script `ambientes-locais/satisfacao-ps4-investigar-cauda.sh` + `.cjs`; log `satisfacao-ps4-investigar-cauda-20261106.log`; amostras `satisfacao-ps4-investigar-cauda-20261106.json`. Banco A+B+C mantido no cluster 55551 (encerrado ao fim). 20 células × 4 variantes × 6 passadas × 100 amostras, blocos intercalados. Resultado das 4 variantes igual ao atual nas 20 células. `resultados.ts` (bdaae3bf…) e harness (6a150b53…) não mudaram; o `postmaster.pid` órfão foi removido depois de confirmar processo morto e porta livre.

**Limite da evidência:** a medição entrou com máquina livre (13:30:50Z), mas terminou com CPU 36,7% e `mutantes-r11` de outra sessão. Não há monitor contínuo. Os números de A/A abaixo valem para máquina compartilhada, **não** para máquina quieta. Não há fase "só A" nesta medição.

**1. Razão no piso × razão no p95 (logs existentes, r4.3 e r4.4 exec. 1):**
- maior razão no mínimo: ×1,15 (três execuções da r4.3) e ×1,22 (r4.4); maior razão no p95: ×1,59 e ×2,08. Mediana da razão no p95: ×0,95–1,15.
- dentro de uma fase, o p95 já chega a ×1,97 do mínimo.

**2. A/A (mesmos dados, plano e SQL):** maior razão de p95 entre blocos ×4,25; 54 de 600 pares acima de 1,5×; 11 de 20 células com algum par acima.

**3. A cauda é bimodal, com o mesmo plano.** Célula do FAIL em 6 blocos: p50 ≈ 4,4–5,2 ms em 5 blocos e 3,16 ms em 1; p10 sempre 3,13–3,25. A execução 1 da r4.4 é compatível com a fase "só A" no modo rápido (p95 3,36) e A+B+C no lento (p95 6,99). **Hipótese, não prova:** a causa do modo lento não foi identificada (outras sessões, estado de energia da CPU ou outra); falta A/A em máquina quieta.

**4. Variantes (mediana dos pares na mesma passada, variante ÷ atual, p50 / p95):**

| Variante | 1 mês | 366 datas | Envios |
|---|---|---|---|
| `random_page_cost = 1.1` (`SET LOCAL`) | ×0,69 / ×0,67 | ×1,15 / ×1,15 | mês: por chave (`festa_uk`, 937 buscas); ano: Index Scan por `cliente_idx` (19.000) |
| envio por chave (`LATERAL`) | ×0,75 / ×0,72 | ×1,80 / ×1,72 | `festa_uk` nos dois (ano: 11.400 buscas) |
| `enable_bitmapscan = off` | ×1,42 / ×1,47 | ×1,64 / ×1,67 | Seq Scan: lê as três empresas; refuta "forçar Seq Scan ajuda" |

- `random_page_cost = 1.1` é o único caminho que melhora o mês sem o ×2 do ano: o planner escolhe por período, sem SQL adaptativo. Custo: ano ≈15% mais lento.
- **Não está provado que passe o critério 4:** sem fase "só A", e o A/A dessa variante também passa de 1,5× (até ×2,23). Mudaria a candidata: exige nova rodada, verificador de planos, revisão do Astra e protocolo. Ajuste só na transação da leitura; não mexe em configuração do banco.

**Próximo passo (decisão de Felipe):** A/A em máquina quieta (outras sessões pausadas), com monitor de CPU contínuo e comparação só A × A+B+C para `atual` e `random_page_cost = 1.1`, para separar ruído de custo real. Critério novo, se houver, continua prospectivo; r4.3 e r4.4 continuam FAIL.

### Investigação por pares intercalados (08–09/11/2026): só sondas, candidata inalterada, r4.3 e r4.4 continuam FAIL

Felipe não consegue pausar todas as sessões. Em vez de exigir máquina quieta, a medição passou a tolerar o ruído: banco **só A** e banco **A+B+C** lado a lado no cluster 55551, medidos em blocos alternados de 100 amostras, na mesma combinação e com segundos de distância. A ordem alterna por passada; a razão é calculada por par. São 6 passadas, 20 combinações, 2 variantes (`atual` e `SET LOCAL random_page_cost = 1.1`).

- Scripts: `ambientes-locais/satisfacao-ps4-pareado.sh`, `satisfacao-ps4-pareado.cjs`, `satisfacao-ps4-pareado-montar.ts` (cópia do harness com `KIDMAIS_PS4_BANCO` e `KIDMAIS_PS4_SO_A`; o harness congelado 6a150b53 não mudou). Log `satisfacao-ps4-pareado-20261108.log`, amostras `satisfacao-ps4-pareado-20261108.json`.
- `rpc-1.1` devolve o mesmo resultado que o atual nas 20 combinações, nos dois bancos. As duas montagens (sonda) deram PASS no verificador de planos. Ao fim, os bancos foram apagados e o cluster encerrado.
- **Limites:** a máquina esteve **muito carregada** (CPU 28–94%, `mutantes-r13` e testes de outras sessões), bem pior que nas execuções do protocolo. Os dados de A vêm do mesmo gerador, mas em montagens separadas. São 6 pares por combinação. Não é execução do protocolo nem muda o veredito.

| | `atual` | `random_page_cost = 1.1` |
|---|---|---|
| Combinações com mediana da razão p95 por par > 1,5× | 2/20 | 0/20 |
| Pares > 1,5× | 18/120 | 7/120 |
| Maior mediana por par | ×2,31 (Gestão, todas, 366 datas, profunda; faixa 0,45–2,87, ruído) | ×1,20 |
| Combinação do FAIL (Equipe, todas, 1 mês, página 1) | p95 ×1,60 (1,08–1,88), p50 ×1,31, piso ×1,13 | p95 ×0,75, p50 ×0,78 |
| Mês, razão do piso | ×1,12–1,15 em todas | ×0,79–0,91 |
| Ano, razão do piso | ×0,87–1,02 | ×0,91–1,01 |

Leitura:
- O ruído explica parte do ×2,08, mas **não todo**: mesmo pareada, a combinação do FAIL segue acima de 1,5× na mediana (×1,60), em todas as rodadas desde a r4.3. O custo real de B/C no mês é pequeno no piso (+12–15%), mas aparece mais nessa combinação.
- Com `random_page_cost = 1.1`, o planner busca os envios por chave no mês; o custo do mês deixa de crescer com o histórico de envios e de depender de B/C. Ano ≈ igual entre os lados. Na sondagem de 06/11 (máquina mais leve), o ano ficou ≈15% mais lento que o atual.
- Critério 1 (p95 < 300 ms): tudo abaixo de 140 ms mesmo com a máquina carregada.

**Próximo passo proposto (decisão de Felipe):** rodada r4.5 com `SET LOCAL random_page_cost = 1.1` só na transação da leitura dos Resultados, sem mudar a configuração do banco. Ela passa por suítes, verificador de planos e revisão do Astra. Ao Astra também iria a proposta de trocar, **daqui para frente**, o método do critério 4 por pares intercalados, mantendo o limite de 1,5×; isso permitiria rodar o protocolo sem pausar as outras sessões. r4.3 e r4.4 continuam FAIL.

## PS-4 — rodada 4.5 (`random_page_cost` só na leitura dos Resultados) — LOCAL, sem commit (09/11/2026)

Decisão de Felipe (09/11): preparar a r4.5 a partir da investigação por pares (seção anterior). **D-PS4-R4-5** (proposta, depende do Astra): `random_page_cost = 1.1` **só na instrução dos Resultados**, dentro da transação da rota, com o valor anterior devolvido logo depois. A configuração do banco não muda. r4.3 e r4.4 continuam FAIL; a r4.5 ainda não tem protocolo.

**Código** (patch delta `ambientes-locais/satisfacao-ps4-r4-5-20261109.patch`, SHA-256 `0a9f9a547df46a3ac9ccd29bb5c9e34fef308b2e91fd89c048207ddfaabc5437`; arquivos r4.4 reconstruídos com hash conferido bdaae3bf/3072984c):
- `lib/satisfacao/resultados.ts` (e1684e00…): `CUSTO_PAGINA_ALEATORIA = "1.1"`; antes da instrução, um único `WITH a AS MATERIALIZED (SELECT current_setting('random_page_cost')) SELECT a.v AS anterior, set_config('random_page_cost', $1, true)`; depois da instrução, sem erro, `set_config('random_page_cost', anterior, true)`. Em erro, a transação já está abortada e termina. Fora de transação o ajuste não vale, e só o plano muda, não o resultado. A rota usa `withTenantTransaction`.
- `lib/satisfacao/satisfacao-ps4.postgres.test.ts` (c7b671e8…): gancho `espiar` no pool da suíte, que observa a mesma conexão da rota; subteste **PS4-R4.5**: 1.1 na instrução dos Resultados, em transação (`now() < statement_timestamp()`), valor anterior devolvido logo depois e nada vaza para a sessão da conexão da rota depois do COMMIT.
- Harness `ambientes-locais/satisfacao-ps4-desempenho.ts` (6a150b53 → 439754a4; cópia da r4.4 em `satisfacao-ps4-desempenho-r4-4-congelado.ts`): a leitura roda em transação desfeita, como na rota; o ajuste é capturado com a instrução e repetido, em transação desfeita, nos EXPLAIN do critério 4 e do verificador; o relatório registra o ajuste por combinação.

**Provas (cluster descartável 55551, encerrado ao fim):**

| Prova | Resultado |
|---|---|
| Suíte PG `satisfacao-ps4.postgres.test.ts` | PASS, incluindo PS4-R4.5 (`2026-11-09T01-45-41-950Z-check-v1-postgres.log`) |
| Mutantes P38 (sem ajuste), P39 (sem devolver), P40 (ajuste na sessão) | **3/3 MORTOS**. P38 e P39 em `2026-11-09T01-53-09-565Z-mutantes-ps4.txt`. P40 deu VIVO "por outra causa" nessa passada: morreu no subteste certo, mas com a mensagem `devolvido:1.1`, porque leituras anteriores da suíte deixaram 1.1 na sessão das conexões reaproveitadas. A causa declarada foi ampliada para as duas manifestações do mesmo vazamento, e a nova passada deu MORTO (`2026-11-09T02-04-38-008Z-mutantes-ps4.txt`). |
| Sonda de planos com o harness r4.5 (verificador, critérios 2 e 3) | **PASS**; 40/40 combinações com `random_page_cost=1.1 (em transação)` (`2026-11-09T01-53-09-839Z-sonda-planos-ps4`) |
| `tsc --noEmit` e ESLint nos arquivos alterados | 0 erros |

**Não feito:** protocolo do critério 4 da r4.5. Depende do parecer do Astra sobre o código e sobre o método. A proposta é medir só A × A+B+C em pares intercalados, mantendo o limite de 1,5×, só daqui para frente, para não depender de pausar as outras sessões.

## Revisão independente da PS-4 r4.5 (08/11/2026)

Data em Brasília. Os identificadores dos artefatos usam UTC. **Ajuste da rota aprovado para validação local. Aceite completo pendente de P38 e do protocolo de desempenho.** Conferidos a branch e a base a7ca19e5, o SHA-256 do patch, os três arquivos finais e a reversão em memória para bdaae3bf, 3072984c e 6a150b53. Nenhuma reexecução em PostgreSQL ou alteração de código.

- O GET executa na conexão exclusiva de withTenantTransaction. Período e guardas vêm antes do ajuste. O CTE materializado captura o valor efetivo, set_config com true aplica 1.1 na transação e a instrução seguinte à consulta restaura o valor antes de revalidar o tenant. Erro propaga para ROLLBACK. COMMIT ou ROLLBACK encerram o ajuste local. Em autocommit o ajuste expira ao fim do comando que o aplica e a consulta de Resultados usa o valor da sessão. O 1.1 é aceitável para este ensaio local e depende do ambiente e da massa.
- O harness captura SQL, parâmetros e ajuste e os reaplica na mesma conexão, em transação desfeita. C2/C3 usam planos dessa consulta. C4 mede apenas Execution Time da instrução, com TIMING OFF. O tempo do serviço no harness inclui os dois comandos de ajuste e a transação, e exclui as guardas e o restante do GET. A sonda confirmou 40/40 configurações capturadas e planos C2/C3 aprovados. Os tempos zero na sonda são marcadores e deixam C1/C4 sem medição.
- A suíte focal PG registrou 11/11. **P2 na prova de P38:** o mutante retira o uso de $1 da SQL e mantém um argumento, causando 08P01 e HTTP 500 antes da asserção do GUC. O regex acerta o título do próprio subteste. O MORTO registrado é inválido. Refazer o controle preservando $1, por exemplo retornando $1::text AS ajustado sem chamar set_config, e exigir HTTP 200 e divergência do valor visto antes da consulta no corpo da asserção. O oráculo deve examinar o corpo do subteste e distinguir falhas de SQL/bind. Evidência em ultimo-ps4-P38-sem-ajuste-do-planner.log.
- **P39 e P40 aceitos, 2/3 causalmente demonstrados.** P39 perde a restauração esperada. Em P40, o false promove o ajuste à sessão após o COMMIT de leituras anteriores. A sessão reaproveitada lê 1.1 como valor anterior e registra devolvido:1.1 em vez de devolvido:4 no subteste certo. A ampliação do matcher foi posterior à primeira passada e a segunda confirmou a manifestação causal. A execução observada parou nessa asserção, antes da checagem pós-COMMIT.

### Protocolo pareado prospectivo do critério 4

**Desenho aprovado com as condições abaixo. Implementação e execução oficiais pendentes.** r4.3 e r4.4 seguem FAIL. A investigação usou a mediana superior (4º de 6). Nas amostras gravadas, a média dos dois centrais daria 1/20 acima de 1,5× no ajuste original e 1,44× na combinação histórica, em vez de 2/20 e 1,60×. Com 1.1, ambas as convenções dão 0/20. Os dados exploratórios ficam fora da decisão oficial.

1. Congelar candidata, scripts, matriz de 20 combinações, datas, ordem e ajustes antes de medir. Gerar A uma vez e clonar a mesma base antes de adicionar B/C a um lado. Conferir massa, schema, índices, configurações, equivalência da saída de A nos dois bancos e SQL/parâmetros da r4.5 capturados em cada lado, incluindo os cursores reais. Rodar ANALYZE após montar as massas e antes das medições. Reaplicar e verificar o 1.1 capturado em ambos os lados. Os scripts exploratórios fixam SET LOCAL manualmente e a montagem usa duas sementes separadas. O executor oficial também deve propagar erros de montagem e de medição e validar matriz, amostras e ajuste.
2. Fazer um controle A/A antes da campanha no mesmo host, com dois bancos da mesma base A, seis pares por combinação e ordem equilibrada. Os dois valores centrais de cada série de razões devem cair em [0,80, 1,25]. Controle fora da faixa indica medição INCONCLUSIVA. A faixa de controle reserva margem em relação ao limite do critério 4.
3. Fazer 12 passadas completas, um par por combinação em cada passada. Em cada par, executar os dois blocos consecutivamente, com três aquecimentos por bloco fora das amostras e 100 tempos de execução por lado. Alternar o primeiro lado por passada, seis A→ABC e seis ABC→A por combinação. Usar a 95ª amostra ordenada em cada lado. Calcular p95(ABC)/p95(A) por par. **PASS se a mediana superior (7ª razão ordenada entre 12) for ≤ 1,5 em cada uma das 20 combinações**, com números sem arredondar. Qualquer combinação acima dá FAIL. A regra exige pelo menos 7 de 12 pares dentro do limite em cada combinação.
4. Preservar todos os tempos, razões, ordem, horários dos blocos, planos e carga, inclusive dispersão e resumo por ordem. Carga alta é contexto, sem descarte por lentidão. Erro técnico ou campanha incompleta dá INCONCLUSIVO e exige nova campanha integral registrada. Sem completar ou substituir pares após conhecer o resultado. C1–C3 mantêm seus critérios e exigem evidência própria.

### r4.5 depois do parecer (09/11/2026): P38 refeito e protocolo pareado INCONCLUSIVO

Parecer do Astra sobre a r4.5 (registrado acima): ajuste aprovado para validação local; P38 com P2 (bind removido → 08P01/HTTP 500; causa casava com o título); P39/P40 aceitos; método pareado aprovado (**D-PS4-R4-6**), com A/A [0,80; 1,25] nas razões centrais, 12 passadas e 7ª menor razão ≤ 1,5×.

**P38 refeito:** o mutante preserva o bind (`$1::text AS ajustado`). O subteste PS4-R4.5 ganhou asserções com o marcador `AJUSTE-R45`, que não está no título, e a rota precisa responder 200 (`ok()`). Resultado: **3/3 MORTOS** pela causa própria (`2026-11-09T02-41-49-368Z-mutantes-ps4.txt`). P38: "a instrução dos Resultados executou com random_page_cost=4 (valor da sessão: 4)", depois de HTTP 200. Suíte PG PASS (`2026-11-09T02-34-39-567Z-check-v1-postgres.log`). A cópia de mutantes foi reinstalada com `npm ci`.

**Protocolo pareado** (`ambientes-locais/satisfacao-ps4-protocolo-pareado.sh` + `.cjs`, montagem `satisfacao-ps4-pareado-montar.ts`; log `satisfacao-ps4-r4-5-protocolo-pareado-20261109T0242Z.log`, amostras `…-20261109T0242Z.json`; hashes da candidata, dos scripts e da matriz no log antes de medir; capturas.json bbd7dfdc…):
- **Montagem:** A montada uma vez; dois clones só A (`soa1`, `soa2`) feitos depois da fase só A; B/C só no banco original. Sonda dos critérios 2 e 3 **PASS**. **C1 PASS** com o serviço completo, 40/40 p95 < 300 ms, mas sob carga muito alta o maior p95 foi **254 ms** (só A, Gestão, todas, 366 datas, profunda; máx. 465 ms) e o segundo 152 ms. Nas medições anteriores, com menos carga, eram 40–60 ms.
- **Conferências:** PASS; parâmetros e cursores iguais nas fases, saída de A idêntica nos três bancos, 1.1 efetivo nos três.
- **Controle A/A (soa2 ÷ soa1): FAIL em 5 de 20 combinações** (Gestão U1 1 mês página 1 e profunda; Gestão sem unidade 1 mês profunda; Gestão U1 366 página 1; Equipe U1 366 página 1). Pares individuais entre bancos idênticos foram de ×0,22 a ×2,92.
- **Resultado: INCONCLUSIVO** (regra 1). A campanha de 12 passadas não rodou, como manda a regra. Carga: CPU 24–94% nas 12 observações, 320–460 processos node, `mutantes-r13`, `mutantes-b26` e testes de outras sessões.
- Defeito do script (sem efeito no veredito): no caminho INCONCLUSIVO, o `.cjs` não fechava as conexões e ficou parado depois de imprimir o resultado (≈03:10Z → 19:58Z). Os três bancos foram apagados à mão às ~19:57Z. As conexões caíram, o processo saiu com código 0, e o shell registrou a carga e encerrou o cluster às 19:58Z. JSON com veredito INCONCLUSIVO, 120 pares A/A e 0 de campanha. Corrigido para fechar as conexões em todas as saídas.

Leitura: o controle A/A funcionou como deveria, porque com essa carga nem dois bancos idênticos ficam dentro da faixa. A r4.5 não tem veredito de desempenho: r4.3/r4.4 FAIL, r4.5 INCONCLUSIVO. A próxima campanha precisa ser integral (montagem, A/A e 12 passadas), numa janela com carga menor. Não precisa ser máquina livre, mas precisa dar para passar no A/A.

### r4.5 — campanha pareada com espera de carga (09/11/2026): **PASS**

Decisão de Felipe (09/11): rodar a campanha integral com **espera de carga**, fixada antes de medir (`ambientes-locais/satisfacao-ps4-espera-carga.mjs` 2af7e620…, `satisfacao-ps4-protocolo-pareado-com-espera.sh` 7f3c9c10…):
- **Quando começa:** sem lote pesado de outra sessão (mutantes, suíte PG, Playwright, vitest, build) e CPU ≤ 30% em 3 observações seguidas, 60 s entre elas. Não é a guarda de máquina livre.
- **Repetição:** campanha INCONCLUSIVA leva a nova campanha integral, no máximo 3; para no primeiro PASS ou FAIL.
- O script do protocolo já fecha as conexões em todas as saídas (f851de29…).

Resultado (log `satisfacao-ps4-r4-5-campanhas-20261109T2004Z.log`; protocolo `satisfacao-ps4-r4-5-protocolo-pareado-20261109T2302Z.log` + `.json`; montagem `satisfacao-ps4-r4-5-montagem-20261109T2302Z.log`):
- Espera de 20:04Z a 23:02Z; admitida com CPU 21,3%, 24,4% e 20,8%. **1ª campanha, sem repetição.**
- Congelados antes de medir: resultados.ts e1684e00…, 115 35e971aa…, down 95445970…, harness 439754a4…, montagem 86f0af63…, protocolo f851de29… + bce2dbba…, verificador 255f775f…, guarda 147946f6…; matriz (capturas.json) ef7c672d….
- **Montagem:** C2/C3 PASS (sonda) e **C1 PASS**, com maior p95 do serviço completo de 49 ms.
- **Conferências:** 121/121 PASS.
- **Controle A/A:** **20/20 PASS**; razões centrais entre ×0,886 e ×1,136.
- **Campanha (12 passadas, 6+6 por ordem):** **PASS em 20 de 20**. A maior 7ª menor razão foi ×1,139 (Gestão, todas, 366 datas, profunda). No mês todas ficaram < 1 (×0,80–0,93), e A+B+C ficou mais rápido que só A, porque com 1.1 o mês busca por chave. A combinação do FAIL histórico (Equipe, todas, 1 mês, página 1) ficou em ×0,834.
- Carga durante a campanha: CPU 14–41%, nenhum mutante alheio nas observações. As 24 observações passaram do limite da guarda antiga (12%), e isso está registrado no JSON.
- Bancos apagados e cluster 55551 encerrado pelo próprio script às 23:26Z.

**Estado:** a r4.5 tem critério 4 PASS pelo método pareado (D-PS4-R4-6) e C1–C3 PASS; r4.3 e r4.4 continuam FAIL. O aceite completo depende do Astra conferir esta campanha e o P38 refeito. Sem commit, sem publicação, migration só no cluster descartável.

### Parecer do Astra sobre a campanha (10/11/2026) e correção do executor — LOCAL, sem PostgreSQL

**Parecer (resumo):** P38 fechado; campanha de 23:02Z conferida pelas amostras brutas e mantida **PASS** (20/20, pior 7ª razão 1,138777612452787; combinação histórica 0,8339658444022771; A/A 20/20; conferências 121/121; C1–C3 PASS). Espera de carga e regra de repetição **aceitas**. Teste PG atual `74bc6c83…` equivale a `c7b671e8…` salvo mensagens/asserções. Aceite integral da r4.5 **retido** por um P2 no executor: `satisfacao-ps4-protocolo-pareado.sh` capturava a saída da montagem sem usá-la (montagem reprovada com `capturas.json` seguia para C4 e podia anunciar PASS) e não propagava a saída do `.cjs`; o shell externo ignorava o retorno e lia o log mais recente da pasta. Lacuna de rastreabilidade: o JSON não tinha horários por bloco nem resumo por ordem. r4.3 e r4.4 continuam FAIL.

**Correção (10/11/2026):**
- `satisfacao-ps4-protocolo-pareado.sh` (bce2dbba… → `440b8e7f…`): ID por tentativa (`KIDMAIS_PS4_ID`), recusa ID já usado (saída 9); montagem saída 1 com `RESULTADO: N FALHA(S)` → **FAIL** sem rodar o protocolo; outra saída ou linha ausente → INCONCLUSIVO técnico; saída do `.cjs` cruzada com a linha RESULTADO (0+PASS, 1+FAIL, 2/3+INCONCLUSIVO; o resto → INCONCLUSIVO técnico); última linha `VEREDITO:` e saída 0/1/2/3, 8 se o encerramento falhar.
- `satisfacao-ps4-protocolo-pareado-com-espera.sh` (7f3c9c10… → `ad7af2e9…`): ID `<início>-c<n>` por campanha, lê o log **dessa** tentativa e cruza saída × VEREDITO; repete só INCONCLUSIVO (2/3); para em PASS (0) e FAIL (1); 8, 9, saída incoerente ou log ausente → erro do executor, para sem nova campanha (5).
- `satisfacao-ps4-protocolo-pareado.cjs` (f851de29… → `9d54aa71…`): início e fim de cada bloco no JSON (`blocos`), resumo por ordem no JSON e no log (`satisfacao-ps4-resumo-por-ordem.cjs` `ae30b3df…`), dublês de pg/guarda só por variável `KIDMAIS_PS4_CONTROLE_*`, com registro marcado `controle`.
- Versões usadas na campanha congeladas: `satisfacao-ps4-protocolo-pareado-20261109T2302Z-congelado.sh` (bce2dbba…), `…-com-espera-20261109T2004Z-congelado.sh` (7f3c9c10…) e `…-20261109T2302Z-congelado.cjs` (reconstruída desfazendo as edições, f851de29… conferido).

**Controles** (`satisfacao-ps4-controles-executor.sh` `11f9c869…`, dublês em `satisfacao-ps4-controles-dubles/`; nenhum PostgreSQL, trava se o cluster 55551 estiver ligado): relatório `satisfacao-ps4-controles-executor-20261110T034559Z.log` — **148 PASS, 0 FAIL**. Cobre 14 caminhos do shell interno (PASS; montagem reprovada **com** capturas → FAIL sem protocolo; anulada; sem linha; quebra; capturas ausentes; protocolo FAIL/A/A/técnico/incoerente/quebra; encerramento falhou → 8; cluster não iniciou; ID usado → 9), 9 do externo (PASS direto; INCONCLUSIVO→PASS; técnico→FAIL; 3 INCONCLUSIVOS → 4; montagem reprovada → FAIL; anulada→PASS; encerramento falhou → 5; sem janela → 3; **isca** PASS mais recente na pasta ignorada) e 5 cenários do `.cjs` com dublê de pg (saídas 0/1/2/2/3, horários de 360 blocos coerentes com a ordem, resumo 20×3+3 e 20×6+6). A 1ª execução (`…-20261110T033740Z.log`, 13 FAIL) foi defeito do dublê (registrava só o último caminho da linha de comando, então não contava a chamada ao `.cjs`); corrigido e repetido. Prova de que o controle pega o defeito: o shell antigo, com montagem reprovada e capturas presentes, rodou o protocolo e saiu 0 com PASS (`satisfacao-ps4-controles-executor-shell-antigo-20261110.log`).

**Rastreabilidade da campanha de 23:02Z:** resumo por ordem recalculado do JSON (`satisfacao-ps4-r4-5-resumo-por-ordem-20261109T2302Z.log`); os horários individuais dos blocos não são recuperáveis e ficam registrados como lacuna dessa campanha.

**Estado:** executor corrigido e controlado LOCAL; campanha de 23:02Z segue PASS; aceite integral da r4.5 aguarda o Astra (inclusive se exige nova campanha com o executor corrigido). Sem commit, sem publicação.

#### Resposta do Astra ao executor — 10/11/2026

**P2 de propagação de erros: FECHADO nos hashes 440b8e7f / ad7af2e9 / 9d54aa71. Aceite integral da r4.5: ainda PENDENTE; exige nova campanha integral com o executor corrigido e a rastreabilidade completa.** A campanha de 23:02Z permanece PASS quanto a C1–C4 e aos cálculos auditáveis. r4.3 e r4.4 continuam FAIL. Este parecer sucede o estado de “aguarda Astra” acima.

- A montagem só prossegue com saída 0 + DESEMPENHO PASS. Saída 1 + N FALHA(S), mesmo com capturas presentes, dá FAIL e zero chamadas ao protocolo; ausência/incoerência/quebra dá INCONCLUSIVO técnico. O protocolo cruza código e RESULTADO; o externo cruza código e VEREDITO do ID exato, para no primeiro PASS/FAIL e só repete INCONCLUSIVO 2/3. Encerramento 8 e ID usado 9 caem na parada 5 do externo. Os ramos de log ausente e código incompatível estão presentes; nem todo ramo externo tem cenário próprio na bateria de 148 asserções. O controle do shell antigo demonstra a sensibilidade ao defeito original. Não se usa a execução inicial com 13 FAIL como validação da candidata.
- Hashes atuais, versões congeladas e dublês conferidos contra os registros. O delta do .cjs preserva SQL, ajuste, aquecimentos, amostras, alternância e regra decisória; acrescenta instrumentação, resumo e injeção explícita dos controles. Os controles simulados comprovam o executor, sem substituir medição em PostgreSQL.
- Releitura independente do JSON histórico: 121/121 conferências, 120 pares A/A e 240 de campanha; 100 amostras finitas positivas por lado, razões recalculadas sem divergência, passadas únicas e ordens equilibradas 3+3 e 6+6. A/A 20/20 e C4 20/20 PASS; pior 7ª razão 1,138777612452787. Resumo por ordem recalculado idêntico ao log após seu cabeçalho. Evidência: ambientes-locais/satisfacao-ps4-revisao-astra-executor-20261110.log.

**Por que não há aceite integral com a campanha antiga:** o item 4 de D-PS4-R4-6, fixado antes de medir, exige preservar os horários dos blocos. O JSON de 23:02Z registra apenas o instante ao fim de cada par: nenhum dos 360 pares contém início/fim dos dois blocos. São **720 blocos**, não 360; “360 blocos” no texto do controle significa 360 pares verificados. O resumo por ordem é recuperável; os intervalos dos blocos não são. Corrigir o executor e provar seus ramos não produz essa evidência retroativa. Esta é uma pendência de completude do protocolo, sem novo defeito funcional demonstrado na candidata e sem reclassificar o PASS numérico como FAIL.

**Próximo passo, fora desta rodada:** quando houver autorização específica para PostgreSQL, congelar novamente candidata, executores e matriz; executar montagem/C1–C3, A/A e as 12 passadas completas com horários de cada bloco, resumo por ordem, amostras e carga preservados. Manter a espera e a regra de repetição já aprovadas; não completar apenas os horários nem reaproveitar pares antigos. Não é necessário refazer as suítes PG/P38 somente por esta correção do executor, se a candidata e as provas aceitas permanecerem idênticas. Nenhuma nova campanha, PostgreSQL, alteração de código, commit ou publicação nesta revisão. Sem servidores, clusters, dependências ou cópias auxiliares criados; evidências preservadas.

**Validação independente concluída:** reexecução integral dos controles com os dublês inspecionados e hashes idênticos: **148 PASS, 0 FAIL, saída 0** (satisfacao-ps4-controles-executor-20261110T035654Z.log). A isca de outra tentativa foi ignorada. Os cinco cenários do .cjs produziram 0/1/2/2/3 e registros marcados como controle. Pasta temporária própria removida pelo executor e ausência de postmaster.pid conferida; nenhum PostgreSQL iniciado ou acessado.

### r4.5 — nova campanha integral com o executor corrigido (10/11/2026): **PASS**

Autorizada por Felipe em 10/11 depois do parecer que exigiu nova campanha (horários por bloco). Executor e protocolo com os hashes aprovados: `satisfacao-ps4-protocolo-pareado.sh` 440b8e7f…, `…-com-espera.sh` ad7af2e9…, `.cjs` 9d54aa71…, resumo ae30b3df…, espera 2af7e620…; candidata `resultados.ts` e1684e00…, harness 439754a4…, montagem 86f0af63…, verificador 255f775f… (congelamento interno e reconferência dos demais hashes discriminados no parecer abaixo).

- **Espera de carga:** de 04:06Z a 11:06Z (CPU até 97,5% com mutantes e regressões de outras sessões); admitida com CPU 20,1%, 16,0% e 13,2% sem lote pesado. 1ª campanha, ID `20261110T0406Z-c1`.
- **Montagem** (`satisfacao-ps4-r4-5-montagem-20261110T0406Z-c1.log`): saída 0, `DESEMPENHO PASS`, 125 PASS e 0 FAIL (C2/C3 pela sonda); C1 maior p95 do cliente 45 ms. Clones soa1/soa2 por TEMPLATE depois da fase só A. Matriz `capturas.json` 0b46a8e6… (o log mostra `\0b46…`: o `sha256sum` prefixa `\` quando o caminho tem barra invertida; o hash é o mesmo).
- **Protocolo** (`satisfacao-ps4-r4-5-protocolo-pareado-20261110T0406Z-c1.log` + `.json` b782f39c…): conferências 121/121; A/A 20/20 (centrais 0,8950–1,0865); **campanha PASS 20/20**, pior 7ª menor razão **0,9982** (Gestão, sem unidade, 366 datas, página 1); 1 mês 0,734–0,944; combinação histórica do FAIL 0,7956. Saída 0 + `RESULTADO: PASS` → `VEREDITO: PASS`; externo leu o próprio log (`-c1`) e saiu 0.
- **Conferência independente** (`satisfacao-ps4-conferir-campanha.cjs` e3c0ab60…, relatório `satisfacao-ps4-r4-5-conferencia-20261110T0406Z-c1.log`): registro sem dublês; 120 + 240 pares; 100 amostras positivas e finitas por bloco; razões recalculadas pela 95ª iguais às gravadas; **720 blocos com início e fim**, coerentes com a ordem do par e sem sobreposição; 6+6 por ordem e 12 passadas por combinação; resumo por ordem no JSON.
- **Carga na campanha:** CPU 11,7–21,6% nas 24 observações (23 acima de 12%; 24 marcadas não livres pela guarda composta antiga, registradas); testes curtos de outras sessões apareceram (`--test`), nenhum lote pesado.
- **Encerramento:** bancos do protocolo apagados e cluster 55551 encerrado pelo script às 11:29Z.

**Estado após revisão do Astra (10/11/2026): ACEITE INTEGRAL LOCAL da r4.5**, C1–C4 PASS, executor corrigido e rastreabilidade completa conferidos. r4.3 e r4.4 seguem FAIL. Sem commit, sem publicação; implantação persistente fora deste aceite.

#### Aceite integral do Astra — r4.5, campanha 20261110T0406Z-c1 (10/11/2026)

**ACEITE INTEGRAL LOCAL da PS-4 r4.5, nos hashes aprovados. Sem achado impeditivo nesta campanha.** A nova campanha integral satisfaz a pendência de completude de D-PS4-R4-6: os 720 blocos têm início/fim preservados, e o resumo por ordem está no JSON e no log. O P2 do executor já estava fechado; esta evidência real encerra a pendência de rastreabilidade. P38 e as demais provas anteriormente aceitas permanecem aceitos; a candidata e os componentes congelados conferem com os hashes aprovados. r4.3 e r4.4 continuam **FAIL**, sem reclassificação retroativa.

- Revisão independente dos artefatos por auditor próprio, sem executar nova campanha ou acessar PostgreSQL: JSON SHA-256 b782f39ccf686df465be3d73b512ebb10b8fb89c5a4831140fbc7ac89d494893 e capturas.json 0b46a8e6f789b9a1e4b7cda8837613ce41d67bc87bbf1e8304cb6c69bea659ac conferidos. O prefixo de escape de caminho do sha256sum não faz parte do hash.
- 121/121 conferências; 120 pares A/A + 240 pares oficiais; 72.000 amostras finitas e positivas. Razões recalculadas pela 95ª amostra ordenada sem divergência. Seis e doze passadas completas na sequência prevista, ordens 3+3 e 6+6 por combinação, sem reposição de pares. Todos os intervalos ISO válidos, coerentes com a ordem, contidos na execução e sem sobreposição. Resumo integral por ordem (contagens, razões, mediana, mínimo e máximo) recalculado idêntico ao JSON e conferido no log.
- A/A **20/20 PASS**, centrais 0,8949579831932774–1,086476372174934. C4 **20/20 PASS**, pior 7ª razão 0,9982045830380345 (Gestão | sem unidade | 366 datas | página 1), abaixo de 1,5 sem arredondamento. Combinação histórica 0,795611125287063; mês 0,7338748208313426–0,9441575209812783.
- C1–C3 **PASS**: montagem 125 PASS / 0 FAIL, C1 40/40 abaixo de 300 ms, máximo 45 ms. Os 40 planos brutos foram reavaliados offline com o verificador 255f775f: acesso por empresa e tetos por relação conformes, nenhuma ordenação externa/em disco. Montagem por TEMPLATE após a fase só A e ANALYZE antes das fases conferidos no executor congelado e nos artefatos.
- Espera de carga e regra de parada aprovadas mantidas: primeira campanha admitida às 11:06Z, sem repetição; saída 0 e RESULTADO/VEREDITO PASS do próprio ID c1, sem leitura de tentativa alheia. Carga não descarta pares neste método. Precisão do registro: CPU 11,7–21,6%; **23/24** acima de 12%, mas **24/24 marcadas não livres pela guarda composta antiga** (CPU e processos alheios). Isso não altera o gate pareado nem a admissão aprovada de 30%.
- Precisão dos hashes: o log interno anterior às medições registra candidata, harness, montagem, protocolo interno, resumo e verificador. O wrapper com-espera ad7af2e9 e a espera 2af7e620 foram reconferidos nos arquivos atuais contra os hashes previamente aprovados; seus hashes não aparecem no log de campanhas nem na lista interna de congelamento. A afirmação anterior de que todos estavam nesse log fica corrigida, sem evidência de mudança desses executores.
- Encerramento às 11:29:43Z com saída 0, bancos apagados e cluster parado segundo o log; postmaster.pid ausente na revisão. Nenhum servidor, cluster, dependência ou cópia auxiliar criado nesta revisão.

Evidência da revisão: ambientes-locais/satisfacao-ps4-r4-5-revisao-astra-20261110T0406Z-c1.log. Validação por leitura e recálculo dos artefatos; não é reexecução de suítes PG/CI. O aceite se limita à candidata local e à massa/método aprovados. Implantação persistente continua fora deste aceite, inclusive inventário dos consumidores de fechamentos e ensaio de lock com leitor aberto antes dessa etapa. **Sem commit, push, publicação ou migration fora do cluster descartável.**
