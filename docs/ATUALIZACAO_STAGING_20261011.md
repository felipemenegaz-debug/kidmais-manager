# Atualização de staging — candidata consolidada, 078, botão na primeira visita e cliente existente com OTP (11/10/2026)

**Status (11/10/2026): EM EXECUÇÃO PARCIAL** — staging LIVE `d19f78b` (flags restauradas), **078 aplicada (PASS)**, B3 legado PASS; pendentes: B1/B2/B4 e C2/C4 (nenhuma fixture elegível em `/b/`), S7 (OTP) — [evidência](evidencias/atualizacao-staging-20261011.md). Texto original do pacote abaixo.

~~PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.~~ Nada foi feito em staging, produção, Render ou bancos remotos na preparação; sem push
nem deploy. Cada frente abaixo exige autorização própria de Felipe (OPERACAO_AGENTES.md: migrations e escritas sempre com autorização
explícita; variáveis de ambiente e deploys também). Coordenação: execução só depois do “pode ir” de Felipe, numa janela sem testes
manuais nem deploys externos em staging.

## 1. Candidata

- **Código: `4d8da7d5519f7f7fad3ba9871799059e293cf12e`** — merge de `origin/staging` (`2abeb58`) na candidata anterior. Este pacote
  está no commit seguinte (só `docs/`); o SHA desse commit é o que vai para `staging`. `git diff --name-only 4d8da7d5519f7f7fad3ba9871799059e293cf12e HEAD`
  deve listar só `docs/`.
- **Base:** `origin/staging` = `2abeb586bdc9e229e895b4a75696d4639538f090` (LIVE em staging, `dep-db54ovo473hc739sm0ig`, lido em S0 de 11/10 —
  [evidência](evidencias/atualizacao-staging-20261011.md)). A candidata **contém** `2abeb58` (fast-forward). Se `origin/staging` avançar de
  novo antes de S2: **não enviar**; integrar sem force, revisar, revalidar e reapresentar.
- **Histórico:** `6099692` (pacote `44ce38f`) — frente L falhou por fixture de teste; `53307b2` (pacote `7b937d8`/`e1c3877`) — L PASS 6/6;
  rodada S de 11/10 parada em S0 porque `origin/staging` tinha avançado para `2abeb58`; `4d8da7d` — integração.
- **Integração (`4d8da7d`):** entram, sem alteração, as duas correções de convites de staging — `b606216` (leitura da imagem do Gemini
  em `output_image`, diagnósticos seguros) e `2abeb58` (bloqueio de nova geração após falha incerta). `components/convites` e
  `lib/convites` ficam idênticos a `origin/staging`. Conflitos só no inventário (`scripts/production/check-migrations.mjs`,
  `production.test.mjs`): staging listava 076/077; a candidata, 076/077/078 — resolvido com a versão da candidata (cada migration uma
  vez; `latest` = 078; 074–078 pendentes de autorização explícita em produção). Nenhum outro arquivo divergiu.
- **Migrations novas em relação a staging:** somente `20261010_078_catalogo_buffet_por_empresa.sql` (074/074a/075/076/077 já
  aplicadas em staging em 09–10/10).

### O que a candidata leva a staging (além de `2abeb58`)

| Item | Commits | Efeito em runtime em staging |
|---|---|---|
| G1–G4 (pacote consolidado de 10/10) | `4337aa4` e anteriores | G3 desligado sem `RESEND_WEBHOOK_SECRET`; G4 só leitura (desenvolvedor); G1/G2 manuais |
| Cotação por empresa: pacotes/preços/contatos, etapas Buffet→Conclusão, guests cap, CEP externo configurável | `412654a`, `72b8659` | só em `/b/<código>` com `COTACAO_PUBLICA_POR_EMPRESA=true`; legado inalterado |
| Catálogo do buffet por empresa — código | `ac55c4c`, `b364ece`, `b73653b` | **compatível sem a 078** (detecta a coluna); sem a 078, escrita no catálogo continua recusada |
| 078 — migration | `b73653b` | só quando aplicada (S5) |
| Disponibilidade do pacote por empresa (cotação pública) | `5ba3534` | só em `/b/<código>` |
| **Disponibilidade no painel (AdminDisponibilidade)** | `708c77d` | empresas que não são donas da agenda pública passam a ver o status pelos dias/períodos configurados nos pacotes delas; a dona mantém o legado |
| Aplicador da 078 em staging + conferência somente leitura | `708c77d`, `6099692` | nenhum (execução manual autorizada pelo Shell) |

### Correção do painel (nesta candidata)

- `GET/POST /api/admin/disponibilidade` devolve `regrasPacotes`: `null` para a empresa dona da agenda pública (`ehDonaDaConfigLegada`,
  mesmo critério do endereço `/fechamento`) e, para as demais, as regras de cada pacote **da empresa comprovada pela sessão**, pela
  mesma leitura da cotação pública (`regrasDosPacotesDaEmpresa` → `lerRegrasDisponibilidadePacote`).
- `AdminDisponibilidade` passa essas regras às duas decisões de status (calendário e data selecionada); rótulos “Dias e períodos
  configurados no pacote” / “Consultar o buffet” fora da dona.
- Fora do escopo (inalterado): o seletor de pacotes do painel ainda lista o catálogo de nomes da Kidmais para qualquer empresa (pacote
  que a empresa não oferece aparece indisponível) — pendência de UX.

## 2. Validação local (offline)

**Integração `4d8da7d` (11/10/2026):** testes sem banco 2281/2281; inventário/produção 37/37 (`check-migrations --json`: `PASS`,
`latest` 078, sem duplicatas, 074–078 pendentes para produção); convites `imagem.test.ts` 4/4 e `service.test.cjs` 22/22; smoke
(mocks) 103/103; TypeScript; ESLint 0 erros (1 aviso preexistente); planos `confere: true`; `next build` com fontes locais (61
páginas) e worker de PDF PASS; `git diff --check` limpo. Frente L (PostgreSQL) **não repetida**: a integração só acrescenta arquivos
de convites, fora das seis suítes; o resultado de `53307b2` (6/6) continua válido para o código delas.

Anteriores (código de produto de `6099692` = `53307b2`):

| Verificação | Resultado |
|---|---|
| Testes sem banco | 2281/2281 (em `708c77d`; `6099692` só acrescenta o modo de conferência do aplicador, 10/10) |
| `scripts/` em série | 287/289 em `708c77d` (as 2 falhas de sempre: ferramentas manuais que exigem `--festa-id`); aplicador 078: 10/10 |
| Smoke (mocks) / produção | 103/103 / 37/37 (078 pendente de autorização) |
| Planos offline | `confere: true` (impressão `ba47d7bf…22c1`, sem mudança de schema) |
| TypeScript, ESLint | aprovados (0 erros, 1 aviso preexistente) |
| `next build` (fontes locais) + worker de PDF | 61 páginas; PASS |
| Testes novos | isolamento do painel por empresa; coerência painel = cotação pública (5 semanas × 2 períodos × 7 pacotes); dona = legado; ligação de rota e tela; mesma regra de escolha de vigência no servidor e na leitura pública |
| Correção do teste (`53307b2`) | TypeScript e ESLint do arquivo; testes de seleção das suítes (`scripts/regressao-v1-*.test.cjs`) 39/39; simulação offline do fixture em 14 datas-base: vigências contíguas sem sobreposição, fronteiras na grade e às quartas, status esperado nas quatro datas |
| **Não executado** | suíte PostgreSQL `lib/comercial/disponibilidade-empresa.postgres.test.ts` — frente L abaixo. Tentativa em `44ce38f`: 5/6 suítes OK; a nova 1/4 por fixture recusado pelo banco; mesmo assim tela = servidor em toda a grade e legado = matriz 006/017 passaram |

## 3. Frente L — suítes PostgreSQL locais (antes de staging; cluster descartável novo)

| Passo | Comando | Esperado |
|---|---|---|
| L1 | `$env:KIDMAIS_PG_BIN='C:/Program Files/PostgreSQL/18/bin'`; `cluster-descartavel-postgres.cjs criar --cluster kidmais_descartavel --criar-autorizado`; `iniciar`; `conferir` | pasta nova, `CONFERE`, bancos `[]` |
| L2 | (cluster **novo**; a pasta da tentativa de `44ce38f` fica parada e preservada) variáveis da suíte (porta 55498, `kidmais_pacotes_v1_descartavel`) e `KIDMAIS_POSTGRES_SOMENTE='lib/comercial/disponibilidade-empresa.postgres.test.ts,lib/comercial/catalogo-buffet-078.postgres.test.ts,lib/comercial/catalogo-ux.postgres.test.ts,lib/saas/hg8-catalogo.postgres.test.ts,lib/comercial/adicionais-070.postgres.test.ts,lib/comercial/round4-remediacao.postgres.test.ts'`; `node scripts/regressao-v1-postgres.cjs` | 6/6 PASS. Falha da nova suíte no teste “legado” = divergência **preexistente** entre a regra fixa e a matriz do banco: parar e reportar |
| L3 | `parar --parar-autorizado` | `PARADO`; pasta preservada |

Pré-requisito de S: L PASS. **L executada em 11/10/2026 para `7b937d8` (código `53307b2`, o mesmo das suítes em `4d8da7d`): PASS, 6/6 suítes (`disponibilidade-empresa` 5/5)** —
[evidência](evidencias/atualizacao-staging-frente-l-20261011.md). S0–S9 continuam pendentes de autorização própria.

A suíte `disponibilidade-empresa` (5 testes) cobre: cenário com vigências contíguas (B: quarta no almoço aberta até a véspera do
fechamento, fechada por duas quartas, reaberta no dia seguinte — o banco recusa sobreposição); isolamento (A 14 regras, B 13, C sem
POCKET, administração = cotação pública); tela = servidor em 35 dias × 2 períodos; **fronteiras** — último dia aberto, primeiro e
último dia fechado e primeiro dia reaberto, com administração (`regrasDosPacotesDaEmpresa`), cotação pública
(`lerRegrasDisponibilidadePacote`) e servidor (`buscarElegibilidadePacoteAplicavel`) iguais e a noite da mesma quarta inalterada;
legado da Kidmais = matriz 006/017.

## 4. Alvo exato (staging)

| Recurso | Identificação |
|---|---|
| Web | `kidmais-manager-staging` `srv-daif418ae00c73e8k2gg`, `https://kidmais-manager-staging.onrender.com`, branch `staging`, auto-deploy **OFF** |
| Banco | `kidmais-staging` `dpg-daidko3m8hqs73ce4jt0-a` / `kidmais_staging_1z91`, rede privada, `DATABASE_SSL=false` |
| Disco | `/opt/render/project/src/data` |
| Fixtures (empresas de homologação) | `hml-planos-profissional`, `hml-planos-premium` (planos de 10/10); legado `/fechamento` = empresa `kidmais` |

## 5. Sequência operacional (staging)

| Passo | O quê | Esperado / parada |
|---|---|---|
| S0 | Leitura: `git fetch` só de `origin/staging` → `2abeb58`; Render MCP: branch `staging`, auto-deploy OFF, LIVE `2abeb58`; `/api/health` 200; `node scripts/production/smoke-test.mjs --base-url=https://kidmais-manager-staging.onrender.com --json` (só GET) | divergência → parar (§7) |
| S1 | Felipe confere no painel o backup/PITR do `kidmais-staging` (sem restaurar) e registra o horário | registro do horário |
| S2 | `git push origin <SHA do pacote>:staging` (fast-forward, sem force). **Não dispara deploy** (auto-deploy OFF) | `origin/staging` = SHA |
| S3 | Shell (antes da mudança): `node scripts/configuracao-homologacao-staging.cjs --conferir-restauracao` → `RESTAURADA` (registro de 10/10: as duas chaves ausentes). Render MCP (merge) **exatamente** `COTACAO_PUBLICA_POR_EMPRESA=true` e `ASSINATURA_PLANOS_ATIVOS=true` — a gravação dispara **um** deploy do SHA. Acompanhar até LIVE; `/api/health` 200; Shell `RENDER_GIT_COMMIT` = SHA | deploy LIVE do SHA; **nenhuma visita a `/b/…` antes de S4** |
| S4 | **Botão na primeira visita (build de produção)** — §6.1 | PASS ou falha registrada |
| S5 | **078** — §6.2: S5a conferência somente leitura; **parada para Felipe aprovar a lista**; S5b aplicação | `CONFERIDO`; depois `PASS` |
| S6 | Pós-078 (só leitura + navegador) — §6.3 | catálogo por empresa em staging |
| S7 | **Cliente existente com OTP** — §6.4 (só se a pré-condição do provedor for satisfeita e D3 decidida) | 1 envio, 1 pedido, prova consumida |
| S8 | Restaurar: Felipe remove as duas chaves no painel (“Save only”); `trigger_deploy` do mesmo SHA (ponta do branch conferida); Shell `--conferir-restauracao` → `RESTAURADA`; `/b/hml-planos-profissional/fechamento` = 404; fechar o Shell. **A 078 permanece** | staging como antes, com a candidata e a 078 |
| S9 | Evidência sanitizada em `docs/evidencias/atualizacao-staging-20261011.md` (sem CPF, telefone, código OTP, segredos) | commit local de docs |

## 6. Verificações

### 6.1 Botão “Continuar para escolher o pacote” na primeira visita (S4)

Objetivo: verificar em **build de produção** (staging) a falha intermitente vista só em `next dev` (evidência de 11/10). Navegador
embutido, somente cliques; nenhum endereço de `/fechamento?…` digitado; nenhuma navegação por script; nenhum pedido.

| # | Caminho (primeira visita após o deploy de S3) | Esperado |
|---|---|---|
| B1 | `/b/hml-planos-profissional/disponibilidade` (desktop) → próxima data disponível em dia útil → período → horário → botão | etapa “Pacote” em ≤ 10 s; registrar o tempo |
| B2 | o mesmo em `/b/hml-planos-premium/disponibilidade` (primeira visita desta empresa) | idem |
| B3 | `/disponibilidade` (legado), mesma sequência | idem |
| B4 | B1 no celular (375×812), em aba nova | idem |

Falha: registrar (tempo, requisição RSC no servidor/navegador, console), **não contornar**, seguir para os demais itens. Se falhar em
build de produção, vira defeito a corrigir antes da produção.

### 6.2 078 em staging (S5)

- **S5a (somente leitura):** Shell `cd /opt/render/project/src && node scripts/migration-078-staging.cjs --conferir-078` →
  `CONFERIDO`, `conexao.redePrivada: true`, `schema.m078: false` e o precheck: dono atual (`empresas_kidmais` = 1), tamanho do catálogo
  e **lista de empresas que receberão cópia** (`empresa_que_recebe_copia`). Grava `data/atualizacao-staging-20261011/conferencia-078-N.json`.
- **Parada:** apresentar a lista a Felipe. Empresas que não sejam fixtures de homologação (`hml-…`) ou Kidmais na lista → decisão D2
  antes de aplicar.
- **S5b (aplicação, só com aprovação da lista):** `cd /opt/render/project/src && node scripts/migration-078-staging.cjs --aplicar-078-autorizado`
  → `PASS`; etapas `precheck 078`, `migration 078`, `postcheck 078`; `catalogoDepois.sem_dono = 0` (havendo `kidmais`). Arquivos
  revisados por hash (`ARQUIVO_DIVERGENTE` → parar). Falha → `ROLLBACK` da transação da 078 (atômica), arquivo de tentativa preservado,
  **sem repetir**; reavaliar.
- **Rollback:** `database/rollback/20261010_078_catalogo_buffet_por_empresa_down.sql` só funciona com um único dono; depois de cópias,
  aborta → correção para frente. Rollback não faz parte deste pacote.

### 6.3 Pós-078 (S6)

| # | Onde | Esperado |
|---|---|---|
| C1 | `/fechamento` (legado) → Festa Completa → Buffet “Quero informar agora” | cardápio original da Kidmais |
| C2 | `/b/hml-planos-profissional` → Pocket → Buffet | só categorias/itens da empresa (cópias do que ela usava, ou nada) — nenhum item de outra empresa que ela não usasse |
| C3 | APIs públicas `GET /api/fechamentos/catalogo?pacote=POCKET&empresa=hml-planos-profissional` / `premium`; `?pacote=COMPLETA` | cada uma só o próprio catálogo |
| C4 | `GET /api/fechamentos/pacotes?empresa=hml-planos-profissional` | `disponibilidade` presente (regras do POCKET da empresa); sem empresa: sem o campo |

### 6.4 Cliente existente com OTP (S7)

**Pré-condição (leitura, Shell, sem segredos):**
`node -e 'const v=k=>process.env[k];console.log(JSON.stringify({provedor:v("IDENTIDADE_OTP_PROVIDER")??null,gupshupHabilitado:v("GUPSHUP_OTP_ENABLED")??null,otpDesligadoStaging:v("KIDMAIS_STAGING_OTP_DISABLED")??null,deploy:v("KIDMAIS_DEPLOY_ENV")??null,segredos:["GUPSHUP_API_KEY","GUPSHUP_SOURCE","GUPSHUP_OTP_TEMPLATE_ID","IDENTIDADE_OTP_PEPPER"].map(k=>[k,v(k)!==undefined])}))'`
e `/api/health` (otp). Só segue se: provedor `gupshup` (ou `whatsapp_cloud`), habilitado `true`, `KIDMAIS_STAGING_OTP_DISABLED` ausente,
segredos presentes. **Não existe modo sandbox de OTP**: o código é enviado de verdade por WhatsApp. Se a pré-condição não for satisfeita,
S7 **não é executado** — mudar o provedor/variáveis exige decisão D4 e dispara deploy.

**Cliente de teste (D3):** cliente já cadastrado na empresa `hml-planos-profissional` com CPF sintético válido e **WhatsApp controlado
por Felipe**. Criado/ajustado por Felipe no painel (CRM) da empresa de homologação; o agente não digita nem registra telefone.

| # | Quem | Passo | Esperado |
|---|---|---|---|
| O1 | agente | `/b/hml-planos-profissional/disponibilidade` → data/horário → Pocket → convidados → buffet “definir depois” → Valor → Dados | etapas avançam pelos botões |
| O2 | Felipe | digita o CPF do cliente de teste | “cliente existente”: WhatsApp **mascarado** da própria empresa; nenhum dado de outra empresa |
| O3 | Felipe | solicita o código; recebe no WhatsApp; **digita o código** (o agente nunca vê nem digita o código) | código confirmado; prova emitida |
| O4 | agente | Resumo → envio do **único** pedido sintético | `201`, protocolo, `AGUARDANDO_CONTRATO` (ou estado configurado da empresa) |
| O5 | agente (Shell, só leitura) | em transação `BEGIN READ ONLY … ROLLBACK`: `SELECT count(*) AS deste_pedido, bool_and(consumido_em IS NOT NULL) AS consumida FROM validacoes_identidade_cliente WHERE consumido_por_fechamento_id = '<id do pedido do O4>'::uuid` (id lido da resposta do envio; só contagens na saída) | `deste_pedido = 1`, `consumida = true` |
| O6 | agente | reenvio com a mesma prova (se a tela permitir voltar e enviar de novo) | recusado; senão, registrado como não testável pela tela (coberto pelos testes automatizados de uso único) |

Limites: no máximo 3 envios de código (regra do produto); código inválido 1× opcional (Felipe) para ver a recusa; nenhum contrato
assinado; nenhuma cobrança.

## 7. Critérios de parada

S0 divergente (branch, auto-deploy, LIVE, `origin/staging` avançado, health ≠ 200); deploy externo durante a janela; `RENDER_GIT_COMMIT`
≠ SHA; conferência da 078 com empresas inesperadas sem decisão; qualquer `FALHA` do aplicador; `ARQUIVO_DIVERGENTE`; pré-condição de OTP
não satisfeita (S7 não executa); qualquer dado de outra empresa visível; qualquer ambiguidade de alvo (OPERACAO_AGENTES, regra de parada).

## 8. Efeitos

| Efeito | Permanente? |
|---|---|
| `staging` = SHA do pacote (2 deploys: merge de S3 e `trigger_deploy` de S8) | sim (reversível por `git revert` + deploy autorizado) |
| **078 aplicada** em `kidmais_staging_1z91`; catálogo atual → `kidmais`; cópias para as empresas listadas em S5a | **sim** (rollback só sem cópias; senão correção para frente) |
| Arquivos `data/atualizacao-staging-20261011/*.json` (conferência, tentativa) | sim (disco de staging) |
| S7: 1 mensagem WhatsApp (custo Gupshup), registros em `validacoes_identidade_cliente`, **1 pedido sintético** na `hml-planos-profissional` | sim |
| Chaves `COTACAO_PUBLICA_POR_EMPRESA`/`ASSINATURA_PLANOS_ATIVOS` | não (restauradas em S8) |

## 9. Recuperação

Código: `git revert` em `staging` + deploy autorizado (a candidata funciona com ou sem a 078). Configuração: S8 / `--conferir-restauracao`.
078: sem rollback automático após cópias (correção para frente). Pedido sintético: permanece (fixture de homologação).

## 10. O que não comprova

Produção (pacote próprio; 074–078 continuam pendentes lá); entrega de WhatsApp para números que não sejam o de teste; assinatura de
contrato com o cliente existente; o seletor de pacotes do painel para empresas com catálogo próprio de nomes.

## 11. Decisões para Felipe

- **D1** — autorizar L1–L3 (local) e, com L PASS, S0–S9 (ou por frente: S2–S4 código e botão; S5 078; S7 OTP).
- **D2** — lista de empresas que recebem cópia em S5a (aprovar antes de S5b).
- **D3** — cliente de teste do OTP (CPF sintético e WhatsApp controlado por Felipe) na `hml-planos-profissional`; quem o cadastra.
- **D4** — se a pré-condição do OTP não estiver satisfeita: manter S7 fora desta rodada ou autorizar a mudança de provedor/variáveis
  (deploy adicional).
