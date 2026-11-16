# Recorte mínimo de production para cobrar — e-mails de cobrança (087) sobre production — 02/11/2026 (rodada 2 em 03/11)

> **Bloqueio em production (B-27, 07/11/2026).** Este recorte não libera cobrança em production. Os crons citados aqui, avisos (`crn-dbkt25m7bikc73fqhlh0`) e reconciliação (`crn-dbbjbt0u01pc73e0a3m0`), entram na D-VZ-6: no ramo G-VAZIO, ela exige suspender os dois no início da barreira, antes do P1, com a autorização A-VZ-2 e prova de término da execução ativa.
>
> Vale enquanto a dívida D-COBRANCA-LIVE estiver aberta, com qualquer dado no ambiente, chamado de "teste" ou não; a reabertura técnica da promoção não libera este caminho. Para sair do bloqueio é preciso o fechamento formal da dívida, a entrega própria de abertura da L2, R3 PASS imediatamente antes e autorização própria de Felipe para cada ativação. Com a dívida aberta, cada deploy, env, E9, E10 ou promoção seletiva ordinários em production exige R3 PASS antes da mudança; a única exceção é a recuperação contida (RC, §9.2.5).
>
> As garantias não são iguais em toda entrada. L1 (configuração) só recusa nos pontos que leem a variável. L2 é a trava em código da B-25: onde o artefato a contiver, recusa nas entradas guardadas e fica fechada em production até a entrega própria de abertura. Shell, SQL, painel do provedor e gestão de serviço ou variável são controle operacional (C2), sem recusa técnica. Caminhos C3 dependem do estado do domínio e, conforme a entrada, são sustentados pela matriz da promoção e pela L1. Flag desligada não prova recusa onde ela não é lida.
>
> Referência: [plano de promoção, rodada 34, §9.2.6](PLANO_PROMOCAO_PRODUCTION_20261025.md#926-d-cobranca-live-gate-de-ativação); o plano é local e ainda não está versionado neste repositório. Esta nota não autoriza nada, não afirma estado atual de serviço ou variável e, nos passos de production sujeitos à dívida, prevalece sobre o texto abaixo. Não trata de staging nem de sandbox.

**Status: IMPLEMENTADO SÓ LOCALMENTE, SEM COMMIT.** Rodada 1 REPROVADA pelo Astra em 02/11 (2 P2 + 2 P3, sem P1); rodada 2 trata os quatro achados (seção "Rodada 2" abaixo). Nada publicado: sem push, PR, deploy, env, migration ou envio de e-mail.

Clone `kidmais-manager-recorte-cobranca-production-20261102`, branch `codex/recorte-cobranca-production-20261102`,
base **`production` `7329cbfe`** (não staging). Plano completo no vault: "Recorte minimo de production para cobrar 20261102".

## O que este recorte leva a production

| Peça do plano | Conteúdo nesta branch |
|---|---|
| R-3 e-mails de cobrança + 087 | Código de 20/10 (`docs/AVISOS_ASSINATURA_EMAIL_20261020.md`, aprovado com ressalvas em revisão independente) reaplicado sobre production: 18 arquivos novos iguais aos do clone de origem e 4 arquivos alterados (`lib/assinatura/cobranca-padrao.ts`, `renovacao-entrega.ts`, `sincronizacao.ts`, `scripts/regressao-v1-selecao.cjs`). Dois conflitos de merge resolvidos mantendo as duas lados: o import da devolução (089) e o do gancho dos avisos em `sincronizacao.ts`; as entradas das suítes PG em `regressao-v1-selecao.cjs`. |
| Aplicador manual da 087 | `scripts/migration-087-comum.cjs`, `-staging.cjs`, `-production.cjs`, `bloco-shell-087.cjs` e os testes (`migration-087.test.cjs`, `bloco-shell-087.test.cjs`, `lib/assinatura/aplicador-087.postgres.test.ts`), derivados dos da 089 pelo gerador `recorte-gerar-aplicador-087.cjs` (fora do repositório, na pasta-mãe), como a 089 foi derivada da 088. Objetos conferidos: tabela, função da guarda, UNIQUE por evento, índices da fila e do id externo, gatilhos de linha e de TRUNCATE. Dependência exigida: 068 (`empresa_assinaturas`, `memberships`, `empresas`) e `usuarios_administrativos`; REFERENCES em `empresas` e `usuarios_administrativos`. Registro no disco: `data/assinatura-avisos-087-producao`. |
| Inventário de production | `scripts/production/check-migrations.mjs` e `production.test.mjs` passam a conhecer `20261019_087_assinatura_avisos.sql` (pendente, autorização explícita), entre a 086 e a 088. |
| CI | Dois passos novos em `.github/workflows/ci.yml`, antes dos da 089: aplicadores da 087 e blocos de Shell da 087. |
| Exportação verificável | `lib/exportacao/entidades.ts` classifica `assinatura_avisos` (grupo Empresa, como `assinatura_renovacoes`, sem exclusões: a chave de idempotência é derivada do id) e `colunas-esperadas.json` ganha as 13 colunas. Sem isso o teste "inventário × migrations" do `check:v1:static` falha (foi o único vermelho da 1ª rodada). |
| SQL da 087 | `precheck` e `postcheck` ganharam `RAISE NOTICE '087 precheck OK' / '087 postcheck OK'`, como os da 089 (ajudam o operador a ler o log do Shell; o núcleo do aplicador não interpreta o NOTICE, ele espera a consulta concluir). O corpo da migration não mudou. Hashes fixados no aplicador: precheck `15f466c3…`, migration `9e3b8d47…`, postcheck `ce92f1e0…`. |

### O que o plano previa e NÃO precisou de código

> **Bloqueio em production (B-27, 07/11/2026).** O R-4 abaixo não é pendência a executar em production: instalar as secretas no cron `kidmais-assinatura-reconciliar-production` e o primeiro "Trigger run" estão bloqueados. Pela D-VZ-6, este cron fica suspenso no ramo G-VAZIO. Vale enquanto a dívida D-COBRANCA-LIVE estiver aberta, com qualquer dado no ambiente. As condições de saída e a regra do R3 para mudanças ordinárias estão na nota completa da B-27 neste documento. Esta nota não autoriza nada, prevalece sobre o trecho abaixo em production e não trata de staging nem de sandbox.

- **R-4 (alarme D-C4 do cron):** já está em production (PR #196, mergeada antes da promoção 2 de 20/10). Falta só a operação: secretas no cron `kidmais-assinatura-reconciliar-production` e o primeiro "Trigger run" (C2).
- **Suporte mínimo (#187) e site honesto (#188):** já em production desde 20/10.

### Sobre a 089 (diagnóstico da rodada 1 RETIRADO)

A rodada 1 afirmava que a tela Assinatura quebraria em production (42P01) porque `lib/assinatura/devolucao.ts:80` consulta
`assinatura_encerramentos` sem guarda. O Astra refutou e a contraprova confere: `consultarEncerramento` (linha 148) e
`solicitarEncerramento` (linha 186) verificam `encerramentosInstalados` antes de chamar `lerLocal`, e a UI oculta a seção
quando `instalado:false`. **A 089 não é dependência da 087 nem precisa de janela por causa deste recorte**; aplicá-la em
production é decisão funcional própria (disponibilizar cancelamento com protocolo e devolução), com planejamento e
autorização separados. A D-REC-7 foi retirada do plano.

## Ordem de publicação (cada passo com autorização própria)

> **Bloqueio em production (B-27, 07/11/2026).** Os passos 1 a 3 são publicação técnica e não ativam cobrança; seguem com autorização própria e sob o roteiro vigente da promoção. Os passos 4 e 5 são ativação e estão bloqueados em production: não ligar `ASSINATURA_AVISOS_EMAIL`, não criar cron de avisos substituto, não mudar `KIDMAIS_AVISOS_MODO` e não rodar o cron. Registrar e preservar o estado da flag na barreira não permite nada disso. O manifesto `infra/render-assinatura-avisos-cron-production.yaml` está sob esta mesma nota. Vale enquanto a dívida D-COBRANCA-LIVE estiver aberta, com qualquer dado no ambiente. As condições de saída e a regra do R3 para mudanças ordinárias estão na nota completa da B-27 neste documento. Esta nota não autoriza nada, prevalece sobre o trecho abaixo em production e não trata de staging nem de sandbox.

1. CI completo local → revisão independente (Astra) → PR para `production` **e** PR gêmea para `staging`.
2. Deploy do código em production (janela de indisponibilidade pelo disco persistente). Sem a 087 e com
   `ASSINATURA_AVISOS_EMAIL` ausente: nenhum aviso é gravado nem enviado e nenhum estado da cobrança muda de propósito.
   Não é literalmente "idêntico": um bounce de id não encontrado na renovação faz um `to_regclass` a mais da 087
   (`renovacao-entrega.ts`, `avisos-repositorio.ts`), e o inventário e os metadados da exportação mudam.
3. Blocos da 087 gerados da árvore implantada (`node scripts/bloco-shell-087.cjs production CONFERIR <sha>` e `APLICAR`):
   CONFERIR → backup (export + PITR) → APLICAR uma vez → CONFERIR.
4. Env `ASSINATURA_AVISOS_EMAIL=ligado` no web (dispara deploy): liga o gancho da transição e o envio após o webhook.
5. Cron próprio `kidmais-assinatura-avisos-production` (`infra/render-assinatura-avisos-cron-production.yaml`, criação
   manual, autorização própria), **a cada 12 h** (06:00 e 18:00 BRT): começa em `KIDMAIS_AVISOS_MODO=aguardando` (sai 0 sem
   conectar) → `simular` (só leitura, relatório) → `aplicar`, com `KIDMAIS_AVISOS_SCHEMA_VALIDADO=087` só depois do CONFERIR
   da 087. Sem o cron, os avisos por tempo (fim do teste, pagamento pendente, leitura, suspensão) NÃO saem: o web só envia
   os de transição da empresa do evento. 12 h porque uma tentativa falha só é repetida dentro de 23 h (chave idempotente
   do Resend); com job diário ela viraria INCERTO (P3 do Astra).

## Rodada 2 (03/11/2026) — achados do Astra de 02/11

**Decisão de Felipe (03/11/2026, D-REC-8):** regra de produto aprovada — o aviso de pagamento pendente só sai a partir do dia seguinte ao vencimento (Brasília). Fecha o P2-1 de 20/10 e o P2 #1 de 02/11 por decisão expressa, além do código.

| Achado | Tratamento |
|---|---|
| **P2 #1** — `PAGAMENTO_PENDENTE` saía na manhã do próprio vencimento (P2-1 de 20/10, nunca fechado) | `lib/assinatura/avisos.ts`: elegível só a partir do **dia seguinte ao vencimento em Brasília** (`inicioDoDiaSeguinteBrasil`, UTC−3 fixo); o marco continua o início da regularização e a janela de 2 dias desloca junto; `motivoObsoleto` revalida pela mesma regra (um aviso gravado no dia D é descartado como obsoleto; no D+1 vale). Texto (`avisos-mensagens.ts`): nomeia o vencimento, manda **não pagar de novo** e dá o prazo do boleto (até 3 dias úteis). Testes: D 08:00 BRT, D 23:59 BRT, D+1 00:00 e 08:00 BRT, vencimento no meio do dia, EM_ATRASO, revalidação, texto. |
| **P2 #2** — o job entregue recusava envio fora do banco local | `scripts/assinatura-avisos.cjs`: modos `APLICAR_STAGING` / `APLICAR_PRODUCAO` só com `RENDER=true`, `KIDMAIS_DEPLOY_ENV` do ambiente, alvo exato (production pela mesma trava do cron de reconciliação; staging pelo banco fixo), `EMAIL_PROVIDER=resend` configurado, `ASSINATURA_AVISOS_EMAIL=ligado`, `KIDMAIS_AVISOS_MODO=aplicar` e `KIDMAIS_AVISOS_SCHEMA_VALIDADO=087`; `aguardando` sai 0 sem conectar; TLS por `opcoesConexao` (production exige `DATABASE_SSL=true`) e conexão remota sem TLS recusada após conectar; relatório sem dados pessoais; limite de 500 envios por execução (já existia). Testes de configuração: cada condição ausente recusa antes de conectar; simulação em production segue aceita. YAML revisável do cron em `infra/`. |
| **P3 #3** — diagnóstico da 089 incorreto | Retirado (seção acima); D-REC-7 removida do plano. |
| **P3 #4** — job diário × retentativa de 23 h | Cron a cada 12 h no YAML e na ordem de publicação; janela de retentativa não foi ampliada. |
| Precisão de texto | "o aplicador procura essa marca" e "comportamento idêntico" reescritos (acima). |

## Rodada 3 (03/11/2026) — parecer r2 do Astra: #1, #3 e #4 FECHADOS; #2 aberto por um desvio novo; 1 P3 novo

| Achado | Tratamento |
|---|---|
| **P2 #5** — parâmetros da URL (`?host=`, `?port=`) substituem o servidor depois da validação do alvo (o driver pg dá precedência a eles; a trava compartilhada só olha hostname/porta/caminho) | `scripts/assinatura-avisos.cjs`: `recusarParametrosDeDestino` roda logo depois de `validarAlvo`, em qualquer modo que conecte (simulação inclusive): recusa fragmento e qualquer parâmetro fora da lista de TLS que `opcoesConexao` trata (`ssl`, `sslmode`, `sslcert`, `sslkey`, `sslrootcert`, `uselibpqcompat`), inclusive duplicados e em caixa alta; a mensagem só traz nomes de parâmetro saneados, nunca a URL. O helper compartilhado da reconciliação **não** foi alterado (sem regressão lá; o endurecimento equivalente da reconciliação fica como recomendação à parte). Testes: 13 sufixos × production/staging/local, TLS aceitos, `aguardando` não valida URL. |
| **P3 #6** — o `startCommand` fixo do cron (`--aplicar`) recusava `KIDMAIS_AVISOS_MODO=simular` | `simular` passa a ser simulação só leitura mesmo com `--aplicar`; `aplicar` continua exigindo `--aplicar` + todas as guardas; valores fora de `aguardando`/`simular`/`aplicar`/vazio são recusados. YAML e roteiro atualizados. Teste da matriz com o comando exato do cron. |

O que não mudou: regra do dia seguinte, textos, aplicador/blocos/SQL da 087, inventário, CI, exportação, ganchos.

Validação da rodada 3 (árvore final): job + reconciliação 32/32; `check:v1:static` 3333/3333 + 103/103, código 0; `next build` código 0; mutantes 24/24 (20 + 4 novos); tsc, ESLint e diff-check limpos.

## Rodada 4 (03/11/2026) — parecer r3 do Astra: #5 e #6 FECHADOS; novo P2 #7

| Achado | Tratamento |
|---|---|
| **P2 #7** — URL sem porta passa pela validação como 5432, mas o driver completa a porta com `PGPORT` do ambiente (e o usuário com `PGUSER`), então o endpoint efetivo pode divergir do validado | `scripts/assinatura-avisos.cjs`: (1) `recusarParametrosDeDestino` exige porta e usuário explícitos na URL; (2) nova `parametrosDeConexao(alvo, env)`: o Pool recebe **host, porta e banco do alvo validado** (nunca a `connectionString`), credenciais lidas pelo parser do próprio driver (`pg-connection-string`) e conferidas contra o alvo (divergência recusa), TLS por `opcoesConexao`. Com campos explícitos o driver ignora `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`. Testes: a reprodução do Astra (URL sem porta + `PGPORT=6543`) recusa em aplicar/simular/staging/local; URL sem usuário recusa; `new Client(parametros)` com `PGPORT=6543` e `PGHOST=outro` no processo mantém 5432 e o host do alvo; sem `connectionString`; TLS exigido em production; alvo adulterado após a validação recusado. YAML: a URL do cron tem de trazer porta e usuário. |

O helper compartilhado da reconciliação continua intacto (recomendação à parte: aplicar lá a mesma montagem explícita).

Validação da rodada 4 (árvore final): job + reconciliação 33/33; mutantes 27/27 (24 + 3 novos); tsc, ESLint e diff-check limpos; `check:v1:static` 3333/3333 + 103/103, código 0; build código 0.

## Rodada 4.1 (03/11/2026) — parecer r4 do Astra: APROVADO COM RESSALVAS (#7 e #2 FECHADOS); 2 P3 fechados aqui

| Achado | Tratamento |
|---|---|
| **P3 #8** — porta `0` explícita passa pela validação, mas o driver a trata como ausente e cai em `PGPORT` (local/simulação) | `recusarParametrosDeDestino` exige porta inteira em 1..65535 (portas acima disso nem passam pelo parser de URL do Node); `parametrosDeConexao` confere a faixa de novo no alvo (defesa em profundidade). Testes: porta `0`/`00` recusada em local, simulação remota e alvo adulterado. |
| **P3 #9** — o parser do driver recebia a URL bruta e lia `sslcert`/`sslkey`/`sslrootcert` do disco ou exigia CA em `verify-ca`+`uselibpqcompat`, parâmetros que a política já descarta | `parametrosDeConexao` passa ao parser só a URL sanitizada devolvida por `opcoesConexao` (sem parâmetros TLS); o `ssl` continua vindo da política. Nomes TLS só em minúsculas (coerência com `opcoesConexao`); caixa alta é recusada como parâmetro desconhecido. Testes: caminhos inexistentes em `sslcert`/`sslkey`/`sslrootcert` e `verify-ca+uselibpqcompat` não lançam, devolvem os mesmos parâmetros e o `ssl` da política; local idem. |

Validação da rodada 4.1 (árvore final): job + reconciliação 34/34; mutantes 30/30 (27 + 3 novos); tsc, ESLint e diff-check limpos; `check:v1:static` 3333/3333 + 103/103, código 0; build código 0.

## Validação da rodada 2 (03/11/2026, árvore final)

| Prova | Resultado |
|---|---|
| avisos (regra, envio, mensagens, repositório, migration-087, renovação) | 38/38 |
| `assinatura-avisos.test.cjs` + `assinatura-reconciliar.test.cjs` | 30/30 |
| `check:v1:static` (árvore final, após o último teste) | 3333/3333 + 103/103, código 0 |
| `next build` | código 0 |
| Mutantes em cópia isolada (13 da rodada 1 + 7 novos) | 20/20 derrubados |
| `tsc --noEmit`, ESLint, `git diff --check` | limpos |
| SQL/aplicador/inventário/exportação (inalterados): 21/21, 37/37, PG 5/5 | valem da rodada 1 |

## Validação local (02/11/2026)

| Prova | Resultado |
|---|---|
| Unitários dos avisos (`avisos*.test.ts`, `migration-087.test.ts`, `assinatura-avisos.test.cjs`) | 35/35 |
| Aplicador e blocos da 087 (`migration-087.test.cjs`, `bloco-shell-087.test.cjs`) | 21/21 |
| `production:test` (inventário com a 087) | 37/37 |
| PostgreSQL descartável 18.6 (porta 55777; modelos 086 e 089 recriados do inventário, que agora inclui a 087; cluster criado, usado, encerrado e removido nas duas rodadas): `avisos-087`, `aplicador-087`, `devolucao-089`, `exportacao` e `exportacao-adversarial` (`.postgres.test.ts`) | 5/5 PASS (relatórios em `ambientes-locais/pg-descartavel-recorte-cobranca-20261102-relatorios`) |
| `tsc --noEmit`, ESLint nos arquivos alterados, `git diff --check` | limpos |
| `check:v1:static` e `next build` | ver registro abaixo |

`next build`: código 0 (1ª rodada, antes da classificação da exportação; a mudança posterior é só em `lib/exportacao`, coberta por tsc/ESLint e pelas suítes). `check:v1:static`: 1ª rodada 3332/3333 (só o inventário da exportação); 2ª rodada, com a classificação: código 0 (3333/3333 + 103/103).

## Fora desta branch

- Textos legais (R-5): levantamento dos 40 marcadores com proposta por item no vault ("Marcadores textos legais para decisao 20261102"); depende das decisões de Felipe.
- Catálogo do site (R-6): o recurso `convite` continua `em_breve` porque a vitrine e o teste `site.test.ts` o fixam como futuro e o menu Convites não está em production (diagnóstico de 31/10). Mudar é decisão de produto.
- Mutantes em cópia isolada e revisão independente: pendentes para a rodada do Astra.
- Blocos de Shell com sha da árvore final: só depois do commit.
