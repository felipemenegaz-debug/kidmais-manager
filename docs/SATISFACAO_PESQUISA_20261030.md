# Pesquisa de satisfação pós-festa — PS-1 local — 30/10/2026

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
