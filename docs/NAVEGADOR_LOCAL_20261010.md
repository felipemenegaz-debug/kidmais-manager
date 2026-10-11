# Navegador local com contas sintéticas — 10/10/2026

> **Execução de 10/10/2026 (candidata `23a203a`):** A1 ok; A2 parou em `fixtures` (gerador de documento sintético, `readUIntBE` de 7 bytes); A3/A4 não executados. Ver [evidência](evidencias/pacotes-locais-concorrencia-navegador-20261010.md). Corrigido na nova candidata; os clusters de 10/10 ficam preservados e a nova execução usa pastas novas.


> **Candidata fixada em 10/10/2026:** código `4337aa4510ea0a7ed876e44abdbd1f9df30527e1`. Este pacote está no commit seguinte, que altera só `docs/`; o SHA desse commit é o apresentado no pedido de aprovação e é o único que pode ser usado (`git diff --name-only 4337aa4510ea0a7ed876e44abdbd1f9df30527e1 HEAD` deve listar só `docs/`). Qualquer outra diferença: parar.

**Status: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.** Nenhum cluster, banco, servidor ou navegador foi iniciado na preparação.
Candidata: `4337aa4510ea0a7ed876e44abdbd1f9df30527e1` (preparado sobre `0619755`, branch `claude/kidmais-manager-sales-site-9b9a2d`).

## 1. Objetivo e limite

Felipe quer testes de interface no navegador embutido com **contas sintéticas** (nunca a conta dele). A política do agente só
permite digitar credenciais de teste em página servida por `localhost`/`127.0.0.1` — nunca em staging. Por isso o teste roda
contra um **Next.js local** apontado para um **PostgreSQL local e descartável** (cluster `kidmais_navegador`, porta `55481`),
com contas criadas pelo seed e senhas gravadas só em arquivo ignorado pelo Git.

Fora do escopo: staging, produção, Render, Asaas (sandbox ou real), e-mail real, WhatsApp, IA, o banco real `kidmais_manager`.

## 2. Arquivos

| Arquivo | Papel |
|---|---|
| `scripts/cluster-descartavel-postgres.cjs` | **Outra frente** (referência, não alterado aqui): cria, inicia, confere, para e remove o cluster `kidmais_navegador` (55481, `listen_addresses=127.0.0.1`, `trust`, papel = `cluster_name` = `kidmais_navegador`). |
| `scripts/navegador-local-seed.cjs` | Seed guardado: schema completo + fixtures sintéticas + conferência pelos serviços de domínio. Grava `.local-navegador/credenciais.json`. |
| `scripts/navegador-local-seed.test.cjs` | 12 testes offline das guardas (alvo, conexão herdada, identidade, Git, credenciais, plano). |
| `scripts/navegador-local-servidor.cjs` | Sobe `next dev` em `127.0.0.1:3481` com ambiente explícito e fechado, depois de autoverificação. |
| `scripts/navegador-local-servidor.test.cjs` | 6 testes offline do ambiente, da precedência do `@next/env` e do código real (Asaas desligado). |
| `.claude/launch.json` | Entrada `navegador-local` que só **anexa** o painel do navegador a `http://localhost:3481` já iniciado (não sobe nada sozinha). O arquivo não existia; foi criado. |

## 3. Variáveis de ambiente: precedência do Next e decisão

Fonte: `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md` (“Environment Variable Load Order”) e o código de
`node_modules/@next/env/dist/index.js` (`processEnv`/`loadEnvConfig`) desta instalação (`next@16.3.4`).

- `process.env` é consultado primeiro; depois `.env.$(NODE_ENV).local`, `.env.local` (exceto `NODE_ENV=test`), `.env.$(NODE_ENV)`, `.env`.
- No código: um valor de arquivo só é aplicado se o nome estiver **ausente** do ambiente inicial (`typeof inicial[nome] === "undefined"`).
  Ou seja, o ambiente do processo **vence**, mas qualquer nome que não definirmos seria **acrescentado** pelo arquivo.
- `next dev` recarrega os arquivos quando mudam; nomes novos num `.env.local` criado durante a execução entrariam no servidor.

Consequência: definir só `DATABASE_URL` não basta — um `.env.local` com chave de provedor, `RENDER`, URL de staging etc. seria
injetado. O teste `precedência real do @next/env` prova o comportamento com um `.env.local` sintético em pasta temporária:
`DATABASE_URL` e `ASAAS_API_KEY` explícitas vencem; `OPENAI_API_KEY` (ausente do ambiente) é acrescentada.

Abordagem escolhida (camadas, todas fail-closed):

1. **Ambiente montado do zero** para o filho: lista fechada de variáveis de sistema + lista explícita abaixo. Nada mais é herdado
   (nem `DATABASE_URL`/`PG*`/proxy/`NODE_OPTIONS`/chaves do shell).
2. **Recusa se existir qualquer `.env*` que o Next leria** na raiz (`.env`, `.env.local`, `.env.development[.local]`,
   `.env.production[.local]`, `.env.test[.local]`). Só existência é conferida; o conteúdo nunca é lido. Hoje esta worktree não tem nenhum.
3. **Autoverificação “depois do Next”**: roda o próprio `loadEnvConfig` do `@next/env` (modo dev) num processo separado com o
   ambiente final e exige zero arquivos carregados, zero nomes acrescentados, zero alterados. Só nomes saem desse processo.
4. **Código real da aplicação** (sem banco): `configuracaoAsaas(env).ligado === false` (motivo `CHAVE_FORA_DO_SANDBOX`),
   `novosPlanosLigados(env) === true`, `situacaoEmail(env)` = arquivo configurado, `modoOtpAmbiente(env) === "console"`,
   `cotacaoPorEmpresaHabilitada(env) === true`.
5. Toda URL em qualquer variável aponta para `localhost`/`127.0.0.1`/`::1`; `DATABASE_URL` = exatamente
   `postgresql://kidmais_navegador@127.0.0.1:55481/kidmais_navegador_*` sem senha; segredos sintéticos ≥ 32 caracteres, novos a cada execução.
6. Durante a execução, um vigia verifica os `.env*` a cada 2 s e **derruba o servidor** se algum aparecer.

Alternativa considerada e não adotada: rodar a partir de cópia temporária sem `.env*`. Exigiria copiar ou ligar `node_modules`
(o Turbopack pode recusar `node_modules` simbólico fora da raiz) e duplicar o código-fonte; a recusa + verificação acima dá a mesma garantia
sem cópia. Se Felipe precisar manter um `.env.local` nesta worktree, o servidor recusa — usar outra worktree limpa.

`NODE_ENV=development` (via `next dev`) é obrigatório: o provedor de e-mail `arquivo` é recusado com `NODE_ENV=production`.

### Lista exata do ambiente do servidor (somente nomes)

> **Desde o código do pacote de etapas** ([HOMOLOGACAO_COTACAO_ETAPAS_20261010.md](HOMOLOGACAO_COTACAO_ETAPAS_20261010.md) §2): 45 explícitas — mais `AGENDA_PUBLICA_EMPRESA_ID` (id da `kidmais` da 046, lido em transação somente leitura do banco descartável; habilita o endereço legado) e `CONSULTA_CEP_EXTERNA=desligada` (sem ViaCEP). `AGENDA_PUBLICA_UNIDADE_ID` continua ausente e recusado.

Explícitas (43, até a candidata 121d49c): `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` (caminho absoluto de `scripts/navegador-local-fontes-mock.cjs`; exigido pela autoverificação), `ADMIN_AUTH_ORIGIN`, `ADMIN_AUTH_SECRET`, `AI_ADMIN_ACTIONS_ENABLED`, `AI_CONTRACT_IMPORT_ENABLED`,
`AI_COPILOTO_MODEL_ENABLED`, `AI_DEMERZEL_ENABLED`, `AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED`, `AI_FALLBACK_ENABLED`, `AI_JEV_ENABLED`,
`AI_JEV_MODEL_ENABLED`, `AI_OPERACIONAL_ENABLED`, `AI_READ_ENABLED`, `AI_SKILLS_EMPRESA_ENABLED`, `ASAAS_AMBIENTE`, `ASAAS_API_KEY`,
`ASAAS_WEBHOOK_TOKEN`, `ASSINATURA_PLANOS_ATIVOS`, `CADASTRO_PUBLICO_ATIVO`, `CONTRACT_IMPORT_INTEGRATION_ENABLED`,
`CONTRATO_ACEITE_DEV_ENABLED`, `CONVITES_ENABLED`, `CONVITES_IA_ENABLED`, `CONVITES_PUBLIC_ORIGIN`, `COTACAO_PUBLICA_POR_EMPRESA`,
`DATABASE_CONNECTION_TIMEOUT_MS`, `DATABASE_IDLE_TIMEOUT_MS`, `DATABASE_POOL_MAX`, `DATABASE_SSL`, `DATABASE_SSL_REJECT_UNAUTHORIZED`,
`DATABASE_URL`, `EMAIL_ARQUIVO_DIR`, `EMAIL_PROVIDER`, `EMAIL_REMETENTE`, `FESTA_ENABLED`, `IDENTIDADE_OTP_PEPPER`,
`IDENTIDADE_OTP_PROVIDER`, `INTELIGENCIA_ENABLED`, `KIDMAIS_DEPLOY_ENV`, `NEXT_TELEMETRY_DISABLED`, `NODE_ENV`,
`RECUPERACAO_SENHA_ATIVA`, `SITE_URL`.

Valores não secretos relevantes: `NODE_ENV=development`, `KIDMAIS_DEPLOY_ENV=local`, `DATABASE_SSL=false`,
`ADMIN_AUTH_ORIGIN=SITE_URL=CONVITES_PUBLIC_ORIGIN=http://localhost:3481`, `ASAAS_AMBIENTE=sandbox` com
`ASAAS_API_KEY=local-desligado-sem-prefixo-sandbox` (Asaas **desligado**, mas ofertas visíveis — `novosPlanosLigados` exige
`ASSINATURA_PLANOS_ATIVOS=true` e `ASAAS_AMBIENTE=sandbox`), `EMAIL_PROVIDER=arquivo` em `.local-navegador/emails`,
`IDENTIDADE_OTP_PROVIDER=console`, `COTACAO_PUBLICA_POR_EMPRESA=true`, IA/convites de festa/importação/aceite dev em `false`,
`FESTA_ENABLED=true` (como staging), `NEXT_TELEMETRY_DISABLED=1`.

Herdadas do sistema (lista fechada, sem caixa): `PATH`, `PATHEXT`, `SYSTEMROOT`, `SYSTEMDRIVE`, `WINDIR`, `COMSPEC`, `TEMP`, `TMP`,
`TMPDIR`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `PROGRAMFILES`,
`PROGRAMFILES(X86)`, `PROGRAMW6432`, `COMMONPROGRAMFILES`, `COMMONPROGRAMFILES(X86)`, `NUMBER_OF_PROCESSORS`,
`PROCESSOR_ARCHITECTURE`, `PROCESSOR_IDENTIFIER`, `OS`, `LANG`, `LC_ALL`, `TERM`, `USERNAME`, `USER`, `LOGNAME`, `SHELL`.

Deliberadamente **ausentes** (provedor desligado por falta de credencial): `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`,
`CONVITES_GEMINI_API_KEY`, `RESEND_API_KEY`, `GUPSHUP_*`, `WHATSAPP_*`, `META_*`, `AI_PROVIDER_*`, `AI_*_BASE_URL`, `AGENDA_PUBLICA_*`
(o endereço legado `/fechamento` sem código fica “não configurado”), `RENDER`, `PG*`, `NODE_OPTIONS`, proxies. Inventário feito por
busca de `process.env.X`, `env.X` e nomes entre aspas em `app/`, `lib/`, `components/`, `next.config.ts`, cruzado com
`ENV_PRODUCAO_EXEMPLO.txt` e `render.yaml`.

## 4. Fixtures sintéticas (seed)

Schema: mesma receita de `scripts/assinatura-schema-completo.cjs` (inventário aprovado até a 077 com pré/pós-checks, fixture da 046;
076/077 entraram no inventário em 10/10/2026, após a aplicação em staging) — 79 migrations, 201 arquivos, impressão fixada
`8a9a97477eac3d046dbd891bfd601df6e8f301f469247ef1e5e0f13403e03cfb` (mudou → o seed recusa, revisar e aprovar de novo).

| Código | Estado | Como é montado |
|---|---|---|
| `nav-essencial` | Essencial confirmado, Fundador; **3/3 vagas** (Gestão + Equipe + 1 convite pendente); catálogo | `prepararOferta` → `confirmarOfertaPaga` (provedor falso, sem rede) → ativação; convite por `criarConviteNaTransacao` |
| `nav-profissional` | Profissional confirmado, Fundador; catálogo | idem |
| `nav-premium` | Premium confirmado, Fundador; catálogo; **renovação Fundador PENDENTE** | idem + `repositorioRenovacao().criar` com `primeiraRenovacaoRegular`/`mensagemRenovacao` (gatilho 075 respeitado) |
| `nav-teste` | Teste vigente (15 dias), oferta Fundador visível | linha `TESTE` com documento |
| `nav-isenta` | Isenta, sem linha de assinatura | `assinatura_isencoes` |
| `nav-teste-expirado` | Teste encerrado há 75 dias → **BLOQUEADO** (além dos 60 de somente leitura) | linha `TESTE` com datas passadas (`teste_fim > teste_inicio`) |

Catálogo (Essencial, Profissional, Premium): pacote `POCKET` “Pocket sintético”, 20–30 convidados, R$ 1.500,00, disponível em todos os
dias e horários globais da 005 — por `gravarFaixasPacote` e `definirDisponibilidadePacoteAdmin`.

Contas (todas `@example.invalid`, senhas só no arquivo): `nav-essencial-gestao`, `nav-essencial-equipe`, `nav-profissional-gestao`,
`nav-premium-gestao`, `nav-teste-gestao`, `nav-isenta-gestao`, `nav-expirada-gestao`, `nav-multiempresa-gestao` (Profissional + Teste).

Conferência ao fim do seed (mesmos serviços do servidor; falha = `resultado` ≠ PASS): Essencial 3/3; `FINANCEIRO_COMPLETO` falso só no
Essencial; acesso `COMPLETO` em todas exceto `nav-teste-expirado` (`BLOQUEADO`); `escopoCotacaoPublica` 200 para Profissional/Premium e
404 para Essencial; `consultarOfertas` do teste com `habilitado` e `fundador`; renovação Premium `PENDENTE`.

Guardas do seed: flag única `--seed-navegador-autorizado`; `KIDMAIS_NAVEGADOR_AUTORIZACAO=127.0.0.1:55481/kidmais_navegador_<nome>`;
recusa host ≠ `127.0.0.1`/`localhost`, porta ≠ 55481, banco fora de `kidmais_navegador_[a-z0-9_]{1,40}` ou contendo
`kidmais_manager`/`staging`/`production`/`producao`, `PG*` herdadas, `DATABASE_URL` herdada que não seja exatamente o mesmo alvo,
prazos `ASSINATURA_*_DIAS` herdados, pasta `.local-*` não ignorada pelo Git, arquivo de credenciais já existente; confere identidade
(banco, papel, `127.0.0.1`, porta, `cluster_name`) e cluster novo (nenhum outro banco); nunca apaga nada; `fetch` bloqueado.

Credenciais: `.local-navegador/credenciais.json` (coberto pela regra `.local-*/` do `.gitignore`, conferida pelo script), criado com
`wx` (nunca sobrescreve) e modo `0600`. **No Windows o modo só controla somente-leitura**; valem as ACLs herdadas da pasta do usuário.

## 5. Passos (cada passo de escrita exige aprovação explícita)

PowerShell, na raiz desta worktree. Nenhum passo usa rede além do indicado em §7.

0. **Pré-condições (leitura):** `git diff --name-only 4337aa4510ea0a7ed876e44abdbd1f9df30527e1 HEAD` só com `docs/`; `git status` sem mudanças inesperadas; nenhum `.env*` na raiz;
   portas 55481 e 3481 livres; PostgreSQL 18 no PATH ou `KIDMAIS_PG_BIN`. Offline:
   `node --test scripts/navegador-local-seed.test.cjs scripts/navegador-local-servidor.test.cjs`,
   `node scripts/navegador-local-seed.cjs --plano` (`confere: true`), `node scripts/navegador-local-servidor.cjs --plano` (`resultado: OK`).
1. **Cluster (aprovação A1):**
   `node scripts/cluster-descartavel-postgres.cjs plano --cluster kidmais_navegador`;
   `node scripts/cluster-descartavel-postgres.cjs criar --cluster kidmais_navegador --criar-autorizado` (anotar a pasta `.local-navegador-pg-<guid>`);
   `node scripts/cluster-descartavel-postgres.cjs iniciar --pasta <pasta> --iniciar-autorizado`;
   `node scripts/cluster-descartavel-postgres.cjs conferir --pasta <pasta>` (só bancos de sistema).
2. **Seed (aprovação A2):**
   `$env:KIDMAIS_NAVEGADOR_AUTORIZACAO='127.0.0.1:55481/kidmais_navegador_20261010'; node scripts/navegador-local-seed.cjs --seed-navegador-autorizado`
   Esperado: JSON com `resultado: "PASS"` e a conferência de §4; nenhuma senha no console.
3. **Servidor (aprovação A3), em aba de terminal própria:**
   `$env:KIDMAIS_NAVEGADOR_AUTORIZACAO='127.0.0.1:55481/kidmais_navegador_20261010'; node scripts/navegador-local-servidor.cjs --iniciar-autorizado`
   Esperado: JSON `INICIANDO` (nomes das variáveis, Asaas `DESLIGADO(CHAVE_FORA_DO_SANDBOX)`) e o `next dev` pronto em `127.0.0.1:3481`.
4. **Navegador (aprovação A4):** painel do navegador por `preview_start` com `navegador-local` (anexa) ou navegação para
   `http://localhost:3481` (usar `localhost`, não `127.0.0.1`: a origem precisa bater com `ADMIN_AUTH_ORIGIN`). O agente lê o arquivo
   de credenciais localmente e digita a senha **somente** em `http://localhost:3481`; nunca a repete no chat, em screenshot, log ou relatório.
   Viewports: desktop 1280×800 e mobile 375×812 (voltar ao desktop ao final).

## 6. Checklist (cada item em desktop 1280×800 **e** mobile 375×812)

Mobile: sem rolagem horizontal; menu acessível; botões e textos legíveis. Fazer **no máximo uma** tentativa de senha errada
(limite: 5 por identificador em 15 min, 30 por origem em 5 min).

| # | Conta / endereço | Ação | Esperado |
|---|---|---|---|
| N01 | `nav-profissional-gestao` | Login em `/admin/login` | Entra no painel sem seletor de empresa (uma empresa ativa). |
| N02 | qualquer conta | 1 senha errada | “Credenciais inválidas.”; nenhuma sessão. |
| N03 | `nav-multiempresa-gestao` | Login | “Empresa ativa — Escolha a empresa que deseja acessar.” com Profissional e Teste; escolher Profissional → painel; trocar para Teste pelo seletor → painel do Teste. |
| N04 | `nav-teste-gestao` → `/admin/assinatura` | Ver oferta | Teste vigente; texto “Fundador: 40% de desconto por 12 meses…”; mensal Fundador Essencial R$ 118,20 / Profissional R$ 208,20 / Premium R$ 358,20 (normais R$ 197,00 / 347,00 / 597,00); anual Fundador R$ 1.182,00 / 2.082,00 / 3.582,00 (normais 1.970,00 / 3.470,00 / 5.970,00), conforme a tela exibir. **Não clicar em assinar.** Se clicado: recusa por cobrança desligada antes de qualquer gravação. |
| N05 | `nav-essencial-gestao` → `/admin/assinatura` | Ver plano | Essencial ativo; “2 pessoa(s) com acesso e 1 convite(s) pendente(s). 3 de 3 vagas ocupadas.”; sem oferta de contratação; sem aviso de renovação. |
| N06 | `nav-premium-gestao` → `/admin/assinatura` | Ver aviso | “Após o Fundador, a partir de dd/mm/2027, o valor será R$ 597,00/mês. O aviso será enviado por e-mail 30 dias antes.”; “Sem limite de usuários.” |
| N07 | `nav-isenta-gestao` → `/admin/assinatura` | Ver situação | Sem cobrança/isenta; nenhuma ação de assinar; acesso completo. |
| N08 | `nav-essencial-gestao` | Menu Financeiro | Contas a pagar, Fluxo de caixa e Relatórios **ocultos**; Contas a receber visível; painel sem “A pagar total”. |
| N09 | `nav-essencial-gestao` | Abrir direto `/admin/financeiro/contas-pagar`, `/fluxo-caixa`, `/relatorios` | Recusa “Contas a pagar, fluxo de caixa e relatórios não fazem parte do plano contratado…” (API 403 `RECURSO_FORA_DO_PLANO`); nenhum dado. |
| N10 | `nav-profissional-gestao`, `nav-premium-gestao`, `nav-teste-gestao`, `nav-isenta-gestao` | Menu Financeiro | Os quatro itens visíveis; páginas abrem (vazias). |
| N11 | `nav-essencial-gestao` → `/admin/configuracoes/acessos` | Convidar `nav-essencial-extra@example.invalid` | Recusa por limite do plano (`LIMITE_USUARIOS_PLANO`); nenhum arquivo novo em `.local-navegador/emails`. |
| N12 | `nav-essencial-equipe` | Login e `/admin/assinatura` | Entra como Equipe; sem ações de Gestão (assinar/cancelar, aviso de renovação). |
| N13 | `nav-expirada-gestao` | Login e navegar (Clientes, Financeiro, Festas) | Paywall: “O teste grátis terminou. O acesso aos dados está suspenso até a assinatura…”; dados não exibidos (API 402 `ASSINATURA_NECESSARIA`); `/admin/assinatura` continua acessível com a oferta. |
| N14 | sem sessão: `http://localhost:3481/b/nav-profissional/fechamento` e `/disponibilidade` | Abrir | Título “Orçamento da festa”; ícone neutro `/icone-orcamento.svg`; nome “Buffet Sintético Profissional (TESTE navegador)”; **sem logo/nome Kidmais**; pacote “Pocket sintético” (20–30); calendário com horários disponíveis. Não enviar pedido. |
| N15 | sem sessão: `/b/nav-premium/fechamento` e `/disponibilidade` | Abrir | Igual ao N14 com o nome do Premium. |
| N16 | sem sessão: `/b/nav-essencial/fechamento`, `/b/nav-essencial/disponibilidade`, `/b/nav-inexistente/fechamento` | Abrir | As três respostas idênticas: página 404 (sem revelar plano ou existência). |
| N17 | qualquer conta | Sair | Sessão encerrada; `/admin` volta ao login. |

Registrar por item: PASS/FALHA, viewport, rota, e evidência sem dados sensíveis (sem senha, sem cookie, sem token).

## 7. Efeitos (somente locais)

- Pasta do cluster `.local-navegador-pg-<guid>/` (ferramenta de ciclo de vida); banco `kidmais_navegador_20261010` com as fixtures.
- `.local-navegador/credenciais.json` e `.local-navegador/emails/` (e-mails eventuais gravados em arquivo; nada é enviado).
- `.next/` (cache do `next dev`, ignorado pelo Git). Nenhum arquivo versionado é alterado pela execução.
- Gravações no banco descartável durante o teste (sessões, auditoria de login, limites de tentativa).
- Rede: Asaas, e-mail, OTP, WhatsApp, IA e telemetria desligados. **Fontes sem rede:** o `next/font/google` usa o mock local
  `scripts/navegador-local-fontes-mock.cjs` (5 URLs exatas, CSS sem fonte remota → fonte de reserva); comprovado com `next build` local.
  Única chamada possível restante: a busca de CEP (ViaCEP) se alguém usar o campo de CEP — **não usar** (o checklist não usa).

## 8. Limpeza (aprovação L1)

1. Parar o servidor: Ctrl+C na aba (o lançador encerra a árvore do `next dev`).
2. `node scripts/cluster-descartavel-postgres.cjs parar --pasta <pasta> --parar-autorizado`
3. `node scripts/cluster-descartavel-postgres.cjs remover --pasta <pasta> --remover-autorizado`
4. Apagar `.local-navegador/` (credenciais e e-mails): `Remove-Item -Recurse -Force .local-navegador`
5. Conferir: `git status` igual ao do passo 0; porta 3481 e 55481 livres.

## 9. Recuperação

- Seed com `resultado` ≠ PASS: banco parcial e **nenhuma** credencial válida gravada. Parar e remover o cluster (§8, 2–3), apagar
  `.local-navegador/` se existir e recomeçar do passo 1. O seed nunca reaproveita banco nem sobrescreve credenciais.
- Servidor recusa (`AUTOVERIFICACAO_RECUSOU`): o console lista só nomes (`ARQUIVO_ENV_PRESENTE:.env.local`, `HOST_NAO_LOCAL:X`…).
  Corrigir a causa; nunca contornar a verificação. `PORTA_APP_OCUPADA`: liberar a 3481. `BANCO_NAO_POPULADO`/`SEED_NAO_EXECUTADO`: rodar o passo 2.
- `PARADA ARQUIVO_ENV_APARECEU`: um `.env*` foi criado durante a execução; o servidor caiu de propósito. Remover/mover o arquivo e reiniciar.
- Login bloqueado por tentativas (429): aguardar a janela ou recriar tudo (§8 + passos 1–3). Sessão expira após 30 min ociosa: entrar de novo.
- Interrupção do agente: rodar a limpeza §8; nada fora desta máquina foi tocado.

## 10. O que isto NÃO prova

- Asaas real ou sandbox: checkout, webhook, confirmação de pagamento, reconciliação, aplicação do preço regular na renovação e envio do aviso.
- Infraestrutura de staging/produção: proxy do Render e cabeçalhos `x-forwarded-*` (ramo `RENDER=true` da política de origem), TLS,
  domínio, variáveis reais, migrations aplicadas lá, cron.
- Build de produção (`next build`/`next start`, `NODE_ENV=production`): cookies `Secure`, HSTS, recusa do e-mail em arquivo.
- E-mail real (Resend), OTP por WhatsApp/Gupshup, IA, desempenho e concorrência.
- Versão do Node: `package.json` pede 22.23.2; a máquina de preparação tem 24.20.0 — registrar a versão usada na execução.

## 11. Questões abertas

1. Portas: 55481 (fixa na ferramenta de ciclo de vida) e 3481 (escolhida para não colidir com o `next dev` padrão na 3000). Se outro
   `next dev` rodar **nesta mesma worktree**, o Next 16 pode recusar por trava do `.next/dev`; parar o outro antes.
2. Nesta worktree não há `.env*`. Se Felipe mantiver `.env.local` aqui, o servidor recusa por desenho; executar em worktree limpa.
3. A entrada do `.claude/launch.json` só anexa a um servidor já iniciado; não há suporte confirmado para passar a variável de
   autorização pelo `launch.json`, e iniciar pelo painel pularia a aprovação explícita do passo 3.
4. O `renovacao-fundador.ts` está com alterações locais de outra frente; o seed usa só `primeiraRenovacaoRegular` e
   `mensagemRenovacao` (exportadas hoje). Revalidar com a candidata final.
5. 076/077 agora vêm do próprio inventário aprovado (que termina na 077), na mesma ordem e com os mesmos checks de antes;
   a impressão do schema não mudou. Se o inventário mudar de novo, o seed recusa (`INVENTARIO_MUDOU`) até revisão.

## 12. Validação da preparação (executada)

- `node --test scripts/navegador-local-seed.test.cjs scripts/navegador-local-servidor.test.cjs`: 18 testes, 18 aprovados (sem banco, sem servidor, sem rede).
- `npx eslint` nos quatro arquivos: sem erros.
- `node scripts/navegador-local-seed.cjs --plano`: 79 migrations, 201 arquivos, impressão confere.
- `node scripts/navegador-local-servidor.cjs --plano`: `resultado: OK`, nenhum `.env*` carregado pelo Next, Asaas `DESLIGADO(CHAVE_FORA_DO_SANDBOX)`.
