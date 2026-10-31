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
