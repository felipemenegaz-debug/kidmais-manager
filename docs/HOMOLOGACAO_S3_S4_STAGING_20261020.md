# Homologação S3 + S4 em staging — nova janela (roteiro de 20/10/2026)

**Estado: PREPARADO LOCALMENTE, NÃO EXECUTADO.** Nada foi enviado ao GitHub, ao Render, ao Asaas ou ao banco. Cada passo
remoto depende do "pode ir" de Felipe ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)); preparar este roteiro não autoriza nada.
Exclusivamente staging (`srv-daif418ae00c73e8k2gg`, banco `kidmais_staging_1z91`) e Asaas **sandbox**. Produção não é tocada.

Quem faz: **F** = Felipe (painel do Render, Web Shell, navegador, painel do Asaas sandbox); **A** = agente (leitura Render,
git, conferência das saídas). Blocos e LEIA-ME: pacote `pacote-s3s4-staging-20261020/` (fora do repositório, com manifesto).

## 1. Onde estamos (conferido em 20/10, só por leitura local do repositório e do vault)

| Item | Situação |
|---|---|
| **S3 — cadastro real** | **APROVADO em 20/10** (~10:05–10:28Z, deploy `73618a2`): contas `felipemenegaz+s3a@gmail.com` e `+s3b`, empresa `TESTE S3`, CNPJ `82.654.321/0001-74`, CNPJ duplicado com mensagem neutra, `S3_PASS`. Registro: [JANELA_S3_S4_STAGING_20261020.md](JANELA_S3_S4_STAGING_20261020.md). Essas contas e esse CNPJ **não podem ser reusados**. |
| **S4 — pagamentos sandbox** | **NÃO EXECUTADO.** A rodada 3 parou no PRECHECK com **Asaas sandbox HTTP 401** (chave do staging recusada); nada foi criado; campanha Fundador ficou 2 confirmadas / 3 ocupadas. O arquivo de estado (`pagamento-renovacao-rodada-3.json`) ficou no disco e faz o executor recusar uma nova rodada (`RODADA_EXISTENTE_S1`). |
| Deploy no ar | Pelo registro da janela, `73618a2` (`dep-dbbk68jrjlhs73ehousg`, live 10:42Z). O pedido desta tarefa diz `cf34c08` (estado do início do dia). **A confere no W0**; o bloco PRE também imprime o commit no ar. Os arquivos que o S4 usa são idênticos em `cf34c08`, `73618a2` e `321c9d5`. |
| Ponta de `staging` | `321c9d5`. De `73618a2` para ela: #194 (scripts de e-mail de produção) e #196 (alarme D-C4 da conferência de produção). **Só `scripts/`, `docs/`, CI e `infra/` de produção: o runtime do web é idêntico.** A #191 (site) já está no ar no staging desde 20/10 10:42Z. |
| PR #195 | Aberta, sem merge (`40f5327`: candidata do S3 = `73618a2`, exceções do teste S4, roteiro executado). Esta branch a contém (merge `0eedbb2`). |
| Ferramentas novas | Não precisam ir ao deploy: os blocos levam o script da janela e conferem por sha256 os arquivos do deploy que a rodada 3 usa. |

## 2. O que mudou desde 13/10 e afeta S3/S4

| Mudança | Efeito na janela | Tratamento |
|---|---|---|
| SHA fixado no S3 (`e819772`, depois `73618a2` na #195) | Toda candidata nova exigia editar o script | Script novo recebe `--candidata=<sha>` e compara com `RENDER_GIT_COMMIT`; os blocos são gerados para a candidata |
| Preços (#189, tabela `2026-10-20`): 197/397/697, anual = 10×, Fundador 40% por 12 meses, 20 vagas | Valores esperados do S4 | O executor já usava 19700→11820, 397000→238200, 69700→41820; a tabela do doc do S4 foi corrigida (estava 347/597). S4-N espera Essencial mensal R$ 118,20 (regular R$ 197), amarrado ao catálogo por teste |
| Textos legais `2026-10-20-minuta` / `2026-10-20-minuta5` (#192) | O cadastro exige aceite da versão vigente | Nada a mudar: o S3 de 20/10 já aceitou essas versões; o S3-R usa a tela atual |
| Migrations 080–086 (WhatsApp prontas/mídia, Wall-e, conexão WhatsApp por empresa 083, pendências de convite 084, Marketing 085/086), todas no banco de staging | Não tocam cadastro, assinatura, Fundador, renovação nem regras de pagamento | Nada a mudar; o S4 confere o schema 074–077. A 083 é `whatsapp_conexao_empresa` (não há migration de onboarding nesse número) |
| Recurso `MARKETING` (Profissional/Premium) em `recursos-plano.ts` | Não entra na matriz do S4 (financeiro e orçamento online continuam iguais) | Nada a mudar |
| Regras de pagamento (077) e CPF por empresa (076) | Já cobertas pelo S4 (F2 0%, F4 5%, F5 8%; CPF por empresa) | Nada a mudar |
| `SITE_PRECOS_PUBLICADOS` | Só exibe preços em `/conheca`; não interfere em cadastro nem cobrança | Não mexer |
| D-C4 (#196) | Só a conferência de **produção**; o cron de staging não muda | Nada a fazer |
| Chave do Asaas sandbox recusada (401) | Bloqueou o S4 em 20/10 | **PRE confere a chave por um GET que só devolve o status HTTP**, antes de qualquer env/deploy |
| Webhook do Asaas | O executor reutiliza o webhook do staging se houver um só e usável; não consegue ler o token dele | PRE/JANELA mostram quantos há, se a fila está interrompida e se o executor vai reutilizar ou criar um |

## 3. Decisões para Felipe

| # | Decisão | Recomendação |
|---|---|---|
| D1 | Qual código vai ao ar no deploy de W3 (toda gravação de env com "Save, rebuild and deploy" faz deploy da **ponta** de `staging`) | **Aceitar `321c9d5`** (ponta atual). O runtime do web é idêntico ao de `73618a2`, a #191 já está no ar e não há deploy extra. Alternativa: "Save only" + Manual Deploy → *Deploy a specific commit* `73618a2`, regenerando os blocos com essa candidata (ver §7). Se a ponta tiver mudado no W0: parar, revisar o diff e regenerar. |
| D2 | Chave nova do Asaas **sandbox** | Só se o PRE der `ASAAS_CHAVE_RECUSADA`. Felipe gera no painel do sandbox e grava `ASAAS_API_KEY` direto no Render (nunca no chat), **na mesma gravação de W3**. **Não trocar `ASAAS_WEBHOOK_TOKEN`** se já houver webhook do staging no Asaas. Gravar a mesma chave no cron `crn-db493i142hec73ahmoe0` (env própria; não faz deploy do web) **só em W8, depois do S4**: um cron em modo aplicar que volta a funcionar no meio da rodada pode sincronizar empresas de terceiros de uma vez e mudar os hashes de preservação (parada S3 com vagas já consumidas). |
| D3 | S3-R: repetir o cadastro real | **Não repetir** (o S3 passou hoje e o código do cadastro não mudou). Se quiser repetir: contas `felipemenegaz+s3c@gmail.com` / `+s3d` e CNPJ sintético novo **`71.394.825/0001-86`** (dígitos válidos, inédito no repositório e no vault). |
| D4 | S4-N: uma contratação pelo navegador (página de pagamento hospedada do Asaas + webhook real) na `TESTE S3` | **Sim, se houver tempo** depois do PASS: é a parte que a rodada 3 não cobre. Custo: uma 4ª vaga Fundador confirmada para sempre em staging. |
| D5 | Horário | Iniciar o S4 até **18:00 BRT** (limite duro do executor: 20h; rodada de 15–30 min; depois S4-N e restauração). Sem outros testes em staging durante o S4. |
| D6 | PR | Esta branch contém a #195. Abrir PR desta branch para `staging` e fechar a #195 como substituída (ou mergear a #195 antes e esta depois, sem conflito). Nenhum deploy é necessário para a janela. |

## 4. Variáveis de ambiente do web de staging (nomes e valores não secretos)

| Chave | W3 (abrir) | W8 (restaurar) |
|---|---|---|
| `ASSINATURA_PLANOS_ATIVOS` | adicionar `true` | remover |
| `COTACAO_PUBLICA_POR_EMPRESA` | adicionar `true` | remover |
| `CADASTRO_PUBLICO_ATIVO` | adicionar `true` **só com S3-R** | remover |
| `USUARIOS_CRIACAO_DIRETA` | adicionar `desativada` **só com S3-R** | remover |
| `ASAAS_API_KEY` | trocar pela chave nova do sandbox (`$aact_hmlg_…`) **só com D2**, digitada por Felipe | manter a nova (a antiga está recusada) |

Não mexer: `ASAAS_AMBIENTE=sandbox`, `ASAAS_WEBHOOK_TOKEN`, `EMAIL_*`, `RESEND_*`, `SITE_*`, `DATABASE_*`, `KIDMAIS_DEPLOY_ENV`.
**Deploys: 2** (W3 e W8), cada um com uma única gravação. Antes de cada um, A confere a ponta de `staging` e que não há deploy em andamento.

## 5. Roteiro

Cada bloco: abrir `blocos/<arquivo>` do pacote, conferir sha256 e bytes do manifesto, copiar inteiro para a área de
transferência (`Get-Content -Raw … | Set-Clipboard`), colar **uma vez** no Web Shell do staging e Enter. Fim esperado:
`CODIGO_SAIDA_BLOCO=0`. `2` = divergente (parar e mandar a saída), `1` = recusado, `4` = o próprio bloco recusou antes do
passo principal (nada gravado no banco, no Asaas nem no disco persistente). Prompt `>` depois de colar = colagem
incompleta: Ctrl-C e colar o **mesmo** bloco. Outro código ou sem essa linha (inclusive Ctrl-C ou queda da sessão no meio):
**resultado desconhecido** — preservar a saída, conferir com um bloco de leitura (PRE, S4-ACOMPANHAR ou POS) e não repetir
um bloco que grava sem essa conferência.

| # | Quem | Passo | Esperado | Parar se |
|---|---|---|---|---|
| W0 | A | Leitura Render: web `srv-daif418ae00c73e8k2gg` (branch `staging`, auto-deploy OFF, sem deploy em andamento, commit no ar); `git ls-remote origin staging` = `321c9d5…`; cron de staging (últimas execuções). F decide D1–D5 e dá o "pode ir" | ponta `321c9d5`, nada em andamento | ponta diferente (revisar diff e regenerar blocos) ou deploy em andamento |
| W1 | F (Shell) | Bloco **PRE** | `PRE_OK_ARQUIVAR`, `arquivavel: true`, `registro: RESTAURADA`, `chavesPresentes: []`, `disco: true`; `asaas.resultado`: `ASAAS_CHAVE_RECUSADA` (→ D2) ou `ASAAS_PRONTO` (→ sem troca de chave) | `PRE_PARAR` (qualquer motivo); `ASAAS_BLOQUEIA_S4` (ex.: `WEBHOOK_INTERROMPIDO`: reativar a fila no painel do sandbox é decisão de Felipe) |
| W2 | F (Shell) | Bloco **ARQUIVAR** (disco persistente; sobrevive ao deploy) | `ARQUIVADO`: log e estado renomeados para `….precheck-20261020T…Z.*`, com sha256; `estadoAgora: AUSENTE` | qualquer outro resultado |
| W3 | F (painel → Environment) + A | Uma gravação (§4) → **Save, rebuild and deploy**. A acompanha até LIVE | LIVE em `321c9d5` (D1), `/api/health` 200 | build/health com falha → W8 |
| W4 | F (Shell, sessão nova) | Bloco **JANELA** | `PRONTO_PARA_S4`: `asaas: ASAAS_PRONTO` (com `webhookDaRodada`), `banco.campanha {2,3}`, `cabe`, `fixturesLivres`, `horaBrasil` < 20 | `JANELA_PARAR` → W8 |
| W5 | F (Shell) | Com o "pode ir" do S4: bloco **S4-INICIAR** (executor em sessão própria, `setsid nohup`: fechar o Shell não o interrompe); depois **S4-ACOMPANHAR** a cada ~5 min | `S4_INICIADO PID=…` → `EM_EXECUCAO` → **`PASS`** (Essencial mensal, Profissional anual, Premium mensal, renovação R0–R6; `campanhaDepois` = antes + 3; `falhasEncerramento` 0) | `INCOMPLETO` ou `INTERROMPIDA_SEM_CONCLUSAO` → ler `falha`; bloco **S4-ENCERRAR** se houver recurso pendente; depois W8. Nunca redeployar durante o S4 |
| W6 | F (navegador) — **opcional S4-N** | Depois do PASS. `https://kidmais-manager-staging.onrender.com` com a conta `+s3a` (empresa `TESTE S3`) → Assinatura → **Essencial mensal** (Fundador **R$ 118,20**; regular R$ 197) → Assinar → página do Asaas sandbox → pagar com **Pix simulado** (no painel `sandbox.asaas.com`, na cobrança, a ação de confirmar pagamento; equivale ao `POST /v3/sandbox/payment/{id}/confirm`, "Apenas Sandbox") **ou cartão fictício de aprovação** (número válido gerado para teste, validade futura, CCV `123`; nunca cartão real). Aguardar até 3 min → bloco **S4N-DEPOIS** → cancelar pela tela (reautenticação) → **S4N-DEPOIS** de novo | tela `ATIVA`; `S4N_PASS` (contratação Essencial mensal 11820 com Fundador `CONFIRMADA`, evento `PROCESSADO`); depois do cancelamento `CANCELADA_FIM_PERIODO` e `S4N_PASS` | cobrança fora de R$ 118,20, webhook não processado em 3 min, `S4N_DIVERGENTE` |
| W7 | F — **opcional S3-R** (só com as 4 chaves em W3; nunca durante o S4) | Bloco **S3-ANTES** → `/cadastro` com `+s3c`, confirmar o e-mail, empresa CNPJ `71.394.825/0001-86`, razão social `TESTE S3R Homologação Ltda`, fantasia `TESTE S3R` → aba anônima: `+s3d` tenta o mesmo CNPJ → bloco **S3-DEPOIS** | `PRONTO_PARA_CADASTRO`; e-mail chega; teste de 15 dias; mensagem neutra para o duplicado; `S3_PASS` | `CADASTRO_RECUSARIA_503`, `CNPJ_JA_USADO`, `S3_DIVERGENTE` |
| W8 | F (painel) + A | Remover as chaves da janela (§4) → **Save, rebuild and deploy**. A acompanha até LIVE. Com D2: gravar agora a chave nova também no cron de staging | LIVE no mesmo commit, health 200; próxima execução do cron sem 401 | — |
| W9 | F (Shell, sessão nova) | Bloco **POS** | `RESTAURADO` (`chavesPresentes: []`, `registro: RESTAURADA`, resumo da rodada, arquivos arquivados listados) | `NAO_RESTAURADO` → corrigir as chaves no painel e repetir W8–W9 |

Depois: A registra a evidência sanitizada (`docs/evidencias/`), atualiza este roteiro e o vault.

## 6. Efeitos permanentes em staging (não têm rollback)

- **S4:** 3 vagas Fundador `CONFIRMADA` (campanha 2/3 → 5/6), 3 contratações confirmadas, 3 registros de renovação (F1 `REVISAO`, F2 e F5 `CANCELADA`), 5 empresas/usuários sintéticos desativados (domínio `example.invalid`), no Asaas sandbox 3 clientes e 3 cobranças fictícias pagas (assinaturas removidas). Nenhum e-mail (SINK).
- **S4-N:** 4ª vaga (6/7), contratação Essencial da `TESTE S3`, cliente e cobrança paga no sandbox.
- **S3-R:** empresa `TESTE S3R`, contas `+s3c`/`+s3d` e o pedido de acesso da `+s3d`.
- Disco: estado/log arquivados da tentativa de 20/10, estado e log da rodada nova, log do encerramento (se usado).

## 7. Recuperação e contingências

- **Ponta de `staging` mudou antes de W3 ou W8:** parar. Revisar o diff; se o runtime do web continuar adequado, regenerar os blocos para a nova candidata: `node scripts/bloco-shell-s3s4-staging-20261020.cjs TODOS <rotulo> <sha-40> <pasta-nova>` e refazer o manifesto. O mesmo vale para a alternativa de D1 (`73618a298673b837ef52b0380b74d22b3cab9edc`).
- **S4 interrompido** (deploy externo, queda do Shell): `S4-ACOMPANHAR` → `INTERROMPIDA_SEM_CONCLUSAO` → **S4-ENCERRAR** (recuperação do próprio executor, idempotente; recusa se a rodada ainda estiver viva) → W8–W9.
- **Vaga `RESERVADA` sem liberação** (parada entre checkout e pagamento): o encerramento termina `INCOMPLETO`; liberação é decisão própria, fora desta janela.
- **Chave nova também recusada:** parar no W4 (`ASAAS_CHAVE_RECUSADA`), W8–W9; nada foi criado.
- Configuração: W8 restaura; o registro de 10/10 (`configuracao-anterior.json`, chaves ausentes) é a referência do POS.

## 8. Ferramentas e validação local

| Arquivo | O que faz | Testes |
|---|---|---|
| `scripts/s3s4-staging-20261020.cjs` | PRE, ARQUIVAR, JANELA, S4-ACOMPANHAR, S3-R, S4-N, POS. Somente leitura, exceto o arquivamento (link sem sobrescrever + unlink, só com prova de "nada criado": concluída, PRECHECK, sem etapas, sem intenção de fixture/checkout/webhook). Fixtures, marca e estado vêm do executor. Asaas: só GET, imprime status e contagens | `s3s4-staging-20261020.test.cjs` 14/14 |
| `scripts/bloco-shell-s3s4-staging-20261020.cjs` | Dez blocos ≤ 32 KB, ASCII; bind antes da guarda do staging; subshell; `CODIGO_SAIDA_BLOCO`; sha256 dos 6 arquivos do deploy conferido antes de qualquer node; S4-INICIAR só com `PRONTO_PARA_S4`, `setsid nohup` e log com `noclobber` | `bloco-shell-s3s4-staging-20261020.test.cjs` (bash real, colagem interativa e truncada, pacote fixado byte a byte) |
| `scripts/homologacao-pagamento-renovacao-staging.test.cjs` | Exceção do roteiro novo na varredura "nada reaproveitado" (o executor não mudou) | 20/20 |

A seção 9 registra os resultados da validação do commit final.

## 9. Blocos do pacote (árvore `81d9ddb`, candidata `321c9d5`; Windows, Node 24.20.0, zlib 1.3.2.1-motley)

| Bloco | sha256 | bytes | Grava? |
|---|---|---|---|
| `BLOCO-SHELL-S3S4-STAGING-20261020-PRE.sh` | `d790bb5dbe2d3eb9ac140dfd9dbe2ee8b03afacfa2a93294f7cce007fa843a62` | 20806 | não (GET no Asaas) |
| `BLOCO-SHELL-S3S4-STAGING-20261020-ARQUIVAR.sh` | `69863faee9d88e04453893f12bd892d56b19556ba864bac4aab6ce63d84aebfa` | 20809 | renomeia 2 arquivos no disco |
| `BLOCO-SHELL-S3S4-STAGING-20261020-JANELA.sh` | `792cb53202186f8d870546f0f111f5c2f15f1bc5b9cb37f099fb180030d462fb` | 20831 | não (banco READ ONLY) |
| `BLOCO-SHELL-S3S4-STAGING-20261020-S4-INICIAR.sh` | `76d6415c8b16a47f57fe7436ca01109ca01a89177f0907a44d8bdbd711e28a71` | 21965 | **sim: rodada 3** |
| `BLOCO-SHELL-S3S4-STAGING-20261020-S4-ACOMPANHAR.sh` | `09e08aaa30e18a10b7ba59ebc31f48761a8fb75dc99624a0de108096c5dfd31e` | 20684 | não |
| `BLOCO-SHELL-S3S4-STAGING-20261020-S4-ENCERRAR.sh` | `f163b9cfbf0a72e585e49dfaab8685b96e93f1edc5723142cb7d22fdcdef8494` | 21144 | sim: recuperação |
| `BLOCO-SHELL-S3S4-STAGING-20261020-S3-ANTES.sh` | `4a3b13a47f7db3e8d7cbc5b8cad7a14fed3561bd94ab8e4679822b26a3f4ae61` | 20784 | não |
| `BLOCO-SHELL-S3S4-STAGING-20261020-S3-DEPOIS.sh` | `d1fc461f50530539d6ea8c1607d5af447b4c61c2204dcfecc7d243b018d2fb2f` | 20777 | não |
| `BLOCO-SHELL-S3S4-STAGING-20261020-S4N-DEPOIS.sh` | `44b5d3da92c6c98af3b40618fa6b6d72f41536906fc94b1e4636b321a15e0b7b` | 20814 | não |
| `BLOCO-SHELL-S3S4-STAGING-20261020-POS.sh` | `325144604c42e7999fcbbee136f5a22945bf0dd9412232aa8e3373e3877228e2` | 20757 | não |

Fixados byte a byte pelo teste do gerador (só nessa combinação de SO/zlib). Arquivos do deploy conferidos pelos blocos
(sha256 LF, iguais em `cf34c08`, `73618a2` e `321c9d5`): o executor da rodada 3 e suas dependências
(`assinatura-staging-ensaio`, `conexao-staging`, `homologacao-planos-cotacao-staging`, `assinatura-preservacao`) e
`configuracao-homologacao-staging.cjs`.

## 10. Validação local (20/10/2026)

| Validação | Resultado |
|---|---|
| `node --experimental-strip-types --test` (um arquivo por vez): `s3s4-staging-20261020.test.cjs`, `bloco-shell-s3s4-staging-20261020.test.cjs`, `homologacao-pagamento-renovacao-staging.test.cjs`, `s3-cadastro-staging.test.cjs`, `configuracao-homologacao-staging.test.cjs` | 14/14, 9/9 (inclui colagem `bash -i`, colagem truncada e pacote byte a byte), 20/20, 4/4, 5/5; 0 pulados |
| `npx tsc --noEmit` | 0 erros |
| ESLint dos arquivos alterados (`--max-warnings 0`) | 0 erros, 0 avisos |
| `npm run check:v1:static` | PASS: testes unitários 3226/3226, harness de staging 103/103, lint 0 erros (1 aviso preexistente em `lib/inteligencia/skills/catalogo.ts`), TypeScript, build e leitura de PDF. Rodado sobre a árvore de `6f8ae0f`; os commits seguintes mudam só o gerador de blocos, seus testes e documentos (cobertos pelos testes e pelo ESLint acima) |

Nada foi executado contra Render, banco, Asaas ou e-mail.
