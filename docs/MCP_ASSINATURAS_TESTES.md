# Canal MCP por assinatura — testes, evidências e roteiros pendentes

> **ESTADO ATUAL (28/10/2026, vale sobre os blocos datados abaixo, que são histórico):**
> - **Staging:** código do canal LIVE (até a #261, `a18677cb`); migration **105 APLICADA** (integridade PASS); canal
>   ligado só para a empresa de teste (`MCP_TENANT_ALLOWLIST`).
> - **Conexão real:** ChatGPT e Claude conectados de verdade por CIMD; 4 perguntas-roteiro, Desconectar e renovação depois
>   de 1 h aprovados (MCP_ASSINATURAS_V1.md §20). Ressalvas da revisão do Astra de 28/10: isolamento e "zero dados pessoais" só com a base vazia;
>   a recusa da empresa fora do piloto foi vista na tela, mas o POST 403 real não foi feito.
> - **Revisão do Astra de 28/10:** "resultado de staging aprovado; produção pode ser planejada". **Não é GO para
>   produção.**
> - **Produção:** nada aplicado nem ligado. Pede aplicador 105 próprio + PITR, candidata validada no Node 22.23.2, env
>   própria, monitoramento/desligamento e as decisões D3/RET-1/D-EXP (lista em MCP_ASSINATURAS_V1.md §21).

> **P4 EXECUTADA (27/10/2026):** suíte PostgreSQL em cluster descartável autorizado (porta 55691, removido): estado 105
> **10/10**, estado 103 schema ausente aprovado (9 pulados por desenho), 3 execuções verdes. A 105 entrou no inventário de
> migrations (production:test 37/37). CI local completo: **28/28 passos** verdes. Detalhes em `MCP_ASSINATURAS_V1.md` §19.
>
> **5ª revisão (27/10/2026): PRONTA PARA P4** (só PostgreSQL isolado, com autorização). P3 residuais corrigidos: novas
> 90/90, static 3749 + 103, build OK. Detalhes em `MCP_ASSINATURAS_V1.md` §18.
>
> **Rodada 5 (27/10/2026):** correções da 4ª revisão do Astra (5 P2 + 1 P3); novas 89/89 (3 execuções seguidas);
> PG com 10 casos (não executada); detalhes em `MCP_ASSINATURAS_V1.md` §17.
>
> **Rodada 4 (27/10/2026):** correções da 3ª revisão do Astra (4 P2 + 1 P3); novas 81/81; PG com 10 casos (não
> executada); detalhes em `MCP_ASSINATURAS_V1.md` §16.
>
> **Rodada 3 (27/10/2026):** correções da 2ª revisão do Astra (8 achados); novas suítes 77/77; PG com 8 casos (não
> executada); detalhes em `MCP_ASSINATURAS_V1.md` §15.
>
> **Rodada 2 (27/10/2026):** correções dos 10 achados do Astra; números atualizados em §2 e §6; detalhes em
> `MCP_ASSINATURAS_V1.md` §14.
>
> Execução de 27/10/2026 no checkout `kidmais-manager-mcp-assinaturas-20261027` (base `eb1af426`), sem `.env` real
> (`env -u DATABASE_URL -u HOMOLOGACAO_DATABASE_URL`; nenhum `.env*` no checkout), sem chave de modelo, sem rede externa
> (CIMD simulado), sem banco. **Não houve teste PostgreSQL, conexão real com fabricante nem publicação.**

## 1. Tipos de prova — uma não substitui a outra

| Tipo | O que prova | Estado |
|---|---|---|
| Offline (núcleo, mocks) | regras, DTO, política, recusas, RAG, CIMD/SSRF | **APROVADO** (local) |
| Protocolo local (loopback) | SDK MCP oficial cliente↔servidor + OAuth completo + transporte, com persistência de MEMÓRIA (só teste) | **APROVADO** (local) |
| Persistência PostgreSQL | atomicidade, multi-conexão, gatilho, FOR SHARE, schema ausente, travas, expurgo | **APROVADO** (cluster descartável local, 27/10; 3 execuções) |
| Conexão real | ChatGPT/Claude reais, por plano/região | **APROVADO em staging** (28/10, TESTE S3, base vazia; POST 403 fora do piloto não exercitado) |
| Publicação | — | **Staging: LIVE** (105 aplicada, canal ligado só na empresa de teste). **Produção: NÃO** |

## 2. Suítes e resultados

| Arquivo | Testes | Resultado |
|---|---|---|
| `lib/conhecimento/conhecimento.test.ts` | 10 | 10/10 (r2: +sem cache) |
| `lib/integracoes/mcp/ferramentas-mcp.test.ts` | 27 (17 casos de recusa × 2 ferramentas) | 27/27 (r2: +transação presa; r3: +volume de recebíveis, DTO numa passada, itens auditados) |
| `lib/integracoes/mcp/protocolo.test.ts` | 19 | 19/19 (r5: corpo pendurado ocupa só a própria concessão, +admissão antes do banco por taxa e por vagas; r4: corpo pendurado; r3: +refresh girado vencido ainda é reuso, +limite de renovação e retenção; r2: +escopo reduzido no refresh, +canal desligado lista/revoga; servidor de teste usa as bordas reais) |
| `lib/integracoes/mcp/mcp-arquitetura.test.ts` | 7 | 7/7 (r2: AST + controles positivos; r4: rotas OAuth exportam todos os métodos; r5: nenhuma rota lê corpo sem limite) |
| `lib/integracoes/mcp/detector-rede.test.ts` | 2 | 2/2 (r2: controles positivos net/http/https/tls/fetch) |
| `lib/integracoes/oauth/rotas.test.ts` | 18 | 18/18 (P3 da 5ª revisão: CIMD transitório e falha interna do token ⇒ 503; r5: prazo propagado sem escrita após o 503, prazo do token desde a chegada, retenção do pedido consumido na memória, JSON administrativo limitado; r4: método e erro do fluxo contados, prazo total, expurgo fora da resposta; r2: bordas públicas; r3: limites não reiniciáveis, teto atômico, prazo/concorrência do corpo, cobertura A10) |
| `lib/integracoes/oauth/cimd.test.ts` | 7 | 7/7 (r2: IPv6 por bytes; r5: prazo absoluto, soquete destruído, buscas em curso limitadas) |
| **Novas — total** | **90** | **90/90** (r5: 89/89; r4: 81/81; r3: 77/77; r2: 67/67; r1: 54/54) |
| `npm run test:inteligencia` (regressão do copiloto) | 474 | **474/474** (antes do registro da camada MCP: 472/474, ver §5) |
| `lib/inteligencia/arquitetura.test.ts` + `lib/assinatura/paywall.test.ts` | 15 | 15/15 |
| `lib/exportacao/exportacao.test.ts` | 16 | 16/16 (após classificar as tabelas 105) |
| `lib/integracoes/oauth/oauth.postgres.test.ts` | 10 | **105: 10/10; 103: 1/1 + 9 pulados** (P4, 27/10, 3×; r4: +ordem de travas sem deadlock, +SKIP LOCKED no expurgo; r2: +lock_timeout; r3: +admissão serializada entre conexões, +retenção/teto duro/girado vencido, +dreno do expurgo) |
| `npx tsc --noEmit` | projeto | sem erros |
| `npm run lint` | projeto | exit 0 |
| `npm run check:v1:static` | projeto | ver §6 |
| `npm run build` | projeto | ver §6 |

Comando das novas: `env -u DATABASE_URL -u HOMOLOGACAO_DATABASE_URL node --experimental-strip-types --test <arquivos>`.

## 3. Critérios A1–A11

| Critério | Evidência | Situação |
|---|---|---|
| A1 descoberta e chamada por cliente MCP real local | `protocolo.test.ts` "A1": `Client` + `StreamableHTTPClientTransport` do SDK oficial; `initialize`/versão do servidor; `tools/list` = 4 nomes exatos; esquemas estritos (`additionalProperties: false`) e de saída; chamada das 4; argumento fora do enum recusado; GET/DELETE 405; sem `Mcp-Session-Id` | **APROVADO local** |
| A2 zero inferência + controle positivo | Detector (`detector-rede-teste.ts`) intercepta `fetch` e `net.Socket.connect`: 0 destinos fora do loopback no fluxo completo, sem `OPENAI_API_KEY` nem flag de modelo. Controle positivo: chamada a `api.openai.com` injetada na ferramenta é registrada e bloqueada, e a ferramenta falha fechada. Estático: grafo de imports de valor do canal não alcança modelos, roteador, conversa, JEV, planejador, copiloto, agentes, Demerzel, Luna nem SDK de provedor | **APROVADO local** (controle positivo estático desde a rodada 2: `mcp-arquitetura.test.ts`) |
| A3 isolamento A/B | Núcleo: `empresaId` nos argumentos recusado (schema), principal adulterado recusado pelo Tenant Context, nenhuma leitura em B; conhecimento de B invisível; referência de A não abre em B. Protocolo: A e B no mesmo servidor só veem a própria empresa. Sem cache de resposta (`no-store`, sem cache no servidor) | **APROVADO local**; unidade: fonte só tem escopo de empresa (declarado) |
| A4 recusas sem dado parcial | 16 casos × agenda/recebíveis (flags, allowlists, escopo, papel global/membership, membership inativa, usuário inativo, empresa bloqueada, concessão revogada, assinatura, prazo, saída fora do schema) sem leitura da fonte e com auditoria; protocolo: token inválido/expirado/revogado, audience errada, senha trocada, usuário inativo ⇒ 401 sem corpo de dados | **APROVADO local** |
| A5 OAuth | authorize: cliente fora da lista (nem buscado), redirect divergente (sem redirecionar), sem PKCE, `plain`, `resource` ausente/errado, escopo desconhecido, `response_type`, parâmetro duplicado; consentimento: escopo não pedido, vazio, empresa sem membership, fora do piloto, NEGAR, pedido de uso único; token: verifier errado (queima o código), redirect divergente, resource errado, verifier fora do formato, replay (revoga a concessão e os tokens emitidos); refresh rotativo, não amplia escopo, reuso revoga a família. CSRF/origem do consentimento: guard administrativo existente (não retestado aqui) | **APROVADO local (memória)**; persistência/concorrência real **PENDENTE** (suíte PG) |
| A6 sem PII; valores canônicos | Fixtures com nome, telefone, CPF, pacote, ids; saída sem nenhum. Paridade com `montarAgenda` e `montarAnaliseRecebiveis` sobre a mesma fonte | **APROVADO local** |
| A7 RAG | Perguntas em PT (acentos, plural, verbo) acham a fonte; sem correspondência ⇒ vazio; suspenso/vencido/futuro/revogado fora; versão substituída; conteúdo malicioso volta como dado, sem efeito em ACL; corpus real íntegro e todo `PENDENTE_APROVACAO` | **APROVADO local** |
| A8 sem escrita/SQL/shell | Lista fechada de 4; `kidmais_executar_sql`, `sql`, `shell`, `kidmais_enviar_whatsapp`, `kidmais_criar_cobranca` ⇒ "not found" | **APROVADO local** |
| A9 testes, tsc, lint, build, UI | §2 e §6; UI: §7 | ver §6/§7 |
| A10 auditoria sanitizada | Evento de ferramenta só com ids, capacidade, resultado, código, itens (limitado a 10 000), duração; consulta com nome/token não vaza; CHECKs de forma na `mcp_auditoria`. Recusas ANÔNIMAS das bordas: sem linha no banco, por política (r3, `rotas.ts`): toda recusa conta 1 num agregado sanitizado e limitado, emitido por minuto mesmo sem tráfego; perda máxima de 1 min se o processo morrer | **APROVADO local** (CHECKs só na suíte PG); política anônima aguarda revisão |
| A11 matriz | este documento | — |

## 4. Matriz de conexão real (nada executado)

| Fabricante / plano / superfície | Região | Conexão | Observação |
|---|---|---|---|
| Claude Pro — web | BR | PENDENTE | Custom connector; CIMD anunciado |
| Claude Desktop | BR | PENDENTE | mesma identidade do web |
| Claude Code | — | FORA DO PILOTO | redirect loopback não aceito |
| ChatGPT Pro — custom MCP (leitura) | BR | PENDENTE | developer mode depende de plano/workspace |
| ChatGPT Business | BR | PENDENTE | |
| ChatGPT Plus | BR | NÃO VERIFICADO | não prometer |
| Gemini app | BR | INDISPONÍVEL (requisitos do Google) | não orientar VPN/troca de país |
| Gemini CLI | — | FORA DO PILOTO | laboratório técnico futuro |

## 5. Falhas encontradas e tratadas durante a implementação

1. `arquitetura.test.ts` (IA) recusou import de `lib/inteligencia` fora das camadas de IA e nomes de flag em comentários
   do canal: canal MCP registrado como camada da IA (com a restrição própria em `mcp-arquitetura.test.ts`); comentários
   sem nomes de flag; fixture renomeada para `apoio-mcp.test.ts`. Não houve afrouxamento do verificador de flags.
2. `exportacao.test.ts` exigiu classificar as 6 tabelas da 105: `FORA_DO_ESCOPO` (decisão D-EXP revisável).
3. Teste estático do canal achou `operacional/consumo.ts` no grafo (cálculo puro do registro fechado): liberado
   explicitamente e documentado.
4. A biblioteca OAuth consome o código antes do PKCE: o teste passou a provar esse comportamento (mais estrito).
5. Relógio: a biblioteca calcula vencimentos pelo relógio da aplicação; o PostgreSQL compara com `clock_timestamp()`.
   Divergência de relógio entre app e banco encurta/alonga vidas em segundos (aceitável; anotado para a revisão).

## 6. Gates do projeto (27/10/2026)

| Gate | Resultado | Observação |
|---|---|---|
| `npm run lint` | exit 0 | 2 avisos preexistentes em arquivos não tocados (`skills/catalogo.ts`, `scripts/migration-096-comum.cjs`) |
| `npm run check:v1:static` | exit 0 — após a 5ª revisão: 3749 + 103 aprovados, 0 falhas (r5: 3748 + 103; r4: 3740 + 103; r3: 3736 + 103; r2: 3726 + 103; r1: 3713 + 103) | na 1ª execução da r1 falhou só o inventário da exportação (tabelas 105), corrigido |
| `npm run build` | exit 0 (r1 a r5) |
| CI local completo (`ambientes-locais/ci-local-mcp-20261027.cjs`) | **28/28 passos** exit 0 | inclui `production:test` 37/37 após a 105 entrar no inventário | rotas `/api/mcp`, `/api/mcp/oauth/{authorize,token}`, `/.well-known/*`, `/admin/conexoes-ia[/autorizar]` geradas; repetido após o ajuste visual |
| `npx tsc --noEmit` | sem erros | |

Logs locais: `ambientes-locais/mcp-gates-r3-static.log` e `mcp-gates-r3-build.log` (rodada 3), `mcp-gates-r2.log` (rodada 2), `mcp-gates.log`, `mcp-build2.log`, `mcp-check-static.log` (fora do repositório).

## 7. UI (desktop/mobile, dados sintéticos)

Vitrine temporária `app/preview-ux/conexoes-ia` (só com `KIDMAIS_PREVIEW_UX=1`, sem banco), navegador interno, **removida
após a validação** (com `.next`). Desktop (~800 px) e mobile (375 px): padrão escuro do Admin, sem rolagem horizontal
(`scrollWidth = clientWidth = 375`), console sem erros. Defeitos achados e corrigidos: botão "Permitir" sem estilo
(passou a usar `AdminPrimaryButton`) e caixas de seleção encolhendo no mobile (18 px fixos). Não validado: tela real com
sessão, troca de empresa e fluxo de login (dependem de banco).

**Rodada 2:** nova vitrine temporária (removida) com canal desligado e duas conexões ChatGPT em empresas diferentes: nomes das empresas visíveis, aviso de canal desligado, Desconectar disponível, 375 px sem rolagem horizontal; console só com o WebSocket de recarga do `next dev`.

## 8. Roteiro PostgreSQL (PENDENTE — exige autorização específica)

Alvo: cluster descartável próprio (porta livre > 55500, `cluster_name`/usuário `kidmais_descartavel`), nunca 5432/5433,
nunca staging/produção. Passos (não executados):

```bash
env -u DATABASE_URL -u HOMOLOGACAO_DATABASE_URL KIDMAIS_POSTGRES_DESCARTAVEL=1 KIDMAIS_DESCARTAVEL_PORTA=<porta> KIDMAIS_DESCARTAVEL_AUTORIZACAO=127.0.0.1:<porta>/kidmais_pacotes_v1_descartavel KIDMAIS_POSTGRES_SOMENTE=lib/integracoes/oauth/oauth.postgres.test.ts node scripts/regressao-v1-postgres.cjs
```

Estados: `105` (modelo novo `kidmais_v1_modelo_105`, sem 098) e `103` (schema ausente). Casos: postcheck; gatilho de
revogação/identidade; um vencedor para código, pedido e refresh entre duas conexões; revogação vista por outra conexão;
troca de senha; uma concessão ativa por tripla; revogação espera a transação da ferramenta (FOR SHARE, `pg_blocking_pids`);
schema ausente ⇒ `SchemaMcpAusente` sem DDL; espera por trava ⇒ `lock_timeout` (r2); admissão de pedido serializada
entre conexões e teto respeitado; poda na gravação (20 girados), teto duro de 60/h, girado vencido ainda detectável; expurgo
que drena 1 200 pedidos e preserva o código usado de concessão ativa (r3). Depois: regressão PG das suítes que dependem do modelo 103.

## 9. Roteiro de conexão real (PENDENTE)

Pré-requisitos: revisão independente, 105 aplicada em staging (autorizada), staging com `MCP_ENABLED=true`,
`MCP_TENANT_ALLOWLIST=<empresa de teste>`, `MCP_PUBLIC_URL=https://<staging>/api/mcp`, `MCP_REF_SECRET` próprio, sem
túnel público ad hoc. Por linha da matriz §4: adicionar o conector → 401 + descoberta → CIMD buscado (conferir host no
log) → consentimento → 4 ferramentas → perguntas-roteiro (agenda hoje/amanhã, quanto está vencido, "como desconecto?") →
esperar > 1 h e repetir (refresh) → Desconectar no KidMais → nova pergunta falha. Registrar plano, região, superfície,
data e resultado. Sem dados reais de cliente.

## 10. Experiência de conexão — roteiro de homologação em staging (PENDENTE, nada executado)

Pré-requisitos TÉCNICOS desta homologação: revisão independente, autorização específica de cada operação remota, deploy em
staging, empresa de teste na allowlist e dados sintéticos. Registrar plano, superfície, data e resultado por linha.
A nova versão aprovada do artigo `conhecimento/assistentes-externos.md` NÃO é pré-requisito desta homologação técnica (o
artigo não entra na PR): é pré-requisito editorial da publicação da tela em production, decidido por Felipe à parte
(12º parecer). Na homologação, as respostas da ajuda ainda podem citar os rótulos antigos.

1. **Tela.** Configurações → IA e créditos → Assistentes conectados, desktop e celular: usuário, empresa, cartões, passos.
2. **Sem conexão.** Cartão em "Aguardando autorização"; conexão de outra empresa não conta como conectada nesta.
3. **Autorizar.** Adicionar o conector pelas instruções oficiais; conferir usuário e empresa; só ajuda vem marcada.
4. **Pós-autorização.** Antes de perguntar: "aguardando primeira consulta", mesmo com o assistente já listando ferramentas.
5. **Primeira consulta.** Pergunta pronta → resposta documental → voltar à tela → data e horário da última consulta.
6. **Sem permissão.** Pedir agenda só com ajuda: erro de falta de permissão, sem dados; tela explica; conexão segue saudável.
7. **Ampliar.** Reconectar marcando agenda; histórico mostra "substituída", sem alerta; perguntas sintéticas de agenda.
8. **Vazio × negado.** Dia sem festas (sintético): resposta informa data e ausência de registros, não falta de permissão.
9. **Troca de conta.** No consentimento, "Entrar com outra conta": volta ao mesmo pedido; a concessão fica só com a segunda
   pessoa; a primeira segue sem conexão. Troca de EMPRESA no menu da conta com o pedido aberto: NÃO se espera voltar ao
   mesmo pedido. O painel descarta a página, o pedido antigo continua pendente e não é consumido, e o assistente precisa
   iniciar outro pedido (roteiro da rodada 18, item 1).
10. **Inatividade.** Esperar mais de 1 h e perguntar de novo (renovação): sem reconectar, sem alerta na tela.
11. **Revogar.** Desconectar no iA.Fest: "Desconectado"; a próxima pergunta falha; o assistente reconecta com outra concessão.
12. **Senha.** Em usuário de teste, trocar a senha: "Precisa reconectar" com a causa.
13. **Funil.** Conferir, em staging e com autorização, a consulta agregada de `MCP_ASSINATURAS_V1.md` §22.

Validação real por assistente (sem prova local possível):

| Assistente | O que falta comprovar |
| --- | --- |
| ChatGPT | conta com titularidade correta (a anterior falhou em repetição); plugin atualiza ferramentas e descrições; aceita subconjunto de permissões; recuperação no chat regular após revogar; agenda e recebíveis sintéticos |
| Claude | aceita subconjunto de permissões; conversa antiga depois da renovação; descrições novas; agenda e recebíveis sintéticos |

### Resultado local da experiência de conexão (06/11/2026)

Node 22.23.2, sem `DATABASE_URL`. Suítes MCP, OAuth, telas e conhecimento, sem as PostgreSQL: 152/152. `tsc`, `next build`: OK. ESLint nos arquivos alterados: sem erros. Mutantes rápidos: 6/6 mortos. `check:v1:static`: 3 falhas em arquivos fora do diff (`renovacao-schema`, `documento/fonte`, `convites/acervo`); a de `renovacao-schema` é CRLF do checkout Windows, as outras duas não foram conferidas em base limpa. Visual: desktop e 375 px com dados sintéticos em página temporária (removida), sem rolagem horizontal. **Não executado:** `oauth.postgres.test.ts`, inclusive o teste novo de evidências, e nenhum cliente real.

Rodada 2 (mesmo ambiente): 159/159 sem PostgreSQL; `tsc`, `next build`, ESLint e `git diff --check` OK; 13/13 mutantes mortos. As 3 falhas do `check:v1:static` são de CRLF do checkout Windows, fora do diff: regex com `\n` literal e SHA-256 sobre bytes. **Segue não executado:** `oauth.postgres.test.ts`, o SQL novo com CTE, `EXPLAIN ANALYZE` e clientes reais.

Rodada 3 (mesmo ambiente): 165/165 sem PostgreSQL; `tsc`, `next build`, ESLint e `git diff --check` OK; 20/20 mutantes mortos; `check:v1:static` 4451/4454, com as mesmas 3 falhas de CRLF. **Segue não executado:** `oauth.postgres.test.ts`, os SQLs novos, `EXPLAIN ANALYZE` e clientes reais.

P3 da rodada 3 (mesmo ambiente): 171 testes sem PostgreSQL, mais 1 acrescentado depois; `tsc`, `next build`, ESLint e `git diff --check` OK; 25 mutantes, 24 mortos na passagem completa e 1 sobrevivente ("foco sobrepõe leitura"), morto depois do teste novo, com reexecução só desse mutante e dessa suíte. `check:v1:static` 4457/4460, com as mesmas 3 falhas de CRLF, antes do teste novo. **Segue não executado:** `oauth.postgres.test.ts`, os SQLs novos, `EXPLAIN ANALYZE`, clientes reais e tela real logada.

### PostgreSQL descartável da experiência de conexão (06–07/11/2026)

Cluster próprio em 127.0.0.1:55841 (PostgreSQL 18, `shared_buffers` 128 MB, `work_mem` 4 MB), autorizado por Felipe só para este fim, já encerrado e removido. Só dados sintéticos; nenhum banco real foi consultado. Relatórios em `ambientes-locais/pg-descartavel-mcp-experiencia-20261106-relatorios/`, fora do repositório.

**Suíte.** `oauth.postgres.test.ts`: estado 105 com 11/11, incluindo o teste novo da experiência (primeira execução real de `listarConcessoes` e `lerUltimasFalhas`), sem nenhum ajuste; estado 104 com 1 aprovado e 10 pulados ("estado sem 105"), como esperado.

**Medição.** SQLs extraídos do `postgres.ts`, com `statement_timeout` de 1200 ms. Eventos na tabela: quase todos de uma empresa, 1% de falhas, em 30 dias. Cada linha é um ponto medido, não uma faixa de desempenho. Medianas e máximos consideram **só as execuções concluídas**; os cancelamentos contam sobre o total de tentativas. O estado do cache **não foi controlado** em nenhuma linha.

| Ponto medido, consulta de falhas | Sem o índice parcial | Com o índice parcial |
| --- | --- | --- |
| 500 mil eventos, pior caso | mediana 102 ms, máximo 269 ms, 0/7 canceladas | não medido |
| 500 mil eventos, sucesso há 1 hora | mediana 1,1 ms, 0/7 | não medido |
| 2 milhões, pior caso (plano não capturado) | 7/7 canceladas | não medido |
| 2 milhões, sucesso há 1 hora (plano não capturado) | mediana 2,9 ms, máximo 591 ms, 3/7 canceladas | não medido |
| 5 milhões, pior caso, logo após a carga: 7 tentativas com prazo e, em seguida, um EXPLAIN ANALYZE sem prazo | 7/7 canceladas; EXPLAIN em 39,7 s, com 70 798 leituras fora dos buffers compartilhados | não medido |
| 5 milhões, empresa grande, depois de ler a tabela inteira | medianas de 146 a 181 ms; até 6/15 canceladas | medianas abaixo de 1 ms, 0/9 |
| 5 milhões, empresa pequena (5 mil eventos), logo após a carga dela | 15/15 canceladas | não medido nesse momento |
| 5 milhões, empresa pequena, depois de ler a tabela inteira | mediana 706 ms, 3/9 canceladas | mediana 0,9 ms, 0/9 |

As leituras fora dos buffers compartilhados não distinguem disco físico do cache do sistema operacional.

`listarConcessoes`, com 50 concessões e 30 tokens em cada: mediana de 1,5 a 2,5 ms em todos os pontos. Esse número é do SQL isolado, sem tocar em `mcp_auditoria`, e não é a latência da tela: o GET espera o diagnóstico de falhas antes de responder, até o prazo de 1,5 s da aplicação.

**O que o plano mostra.** Em 5 milhões, o plano observado foi `Parallel Seq Scan` em `mcp_auditoria` nos perfis testados, inclusive na empresa pequena. O planejador não conhece a empresa nem o piso de horário, que vêm de CTE. Isso comprova o risco de uma empresa pagar pelo volume das outras nesse plano. Não identifica um ponto de virada universal: não houve plano capturado em 500 mil nem em 2 milhões.

**Índice parcial proposto, criado só no cluster.** `(empresa_id, concessao_id, ocorrido_em DESC, id DESC) WHERE evento = 'FERRAMENTA' AND resultado NOT IN ('OK', 'SEM_DADOS')`: 3,3 MB para 50 mil falhas, criado em 1 s, contra 194 MB do índice por empresa. Com ele, empresa, concessão e horário entraram como condições de índice. Essa mudança de plano é o que sustenta a recomendação, mesmo sem comparação de tempos com cache controlado.

**Variante LATERAL sem migration: não adotada.** Empresa pequena em 0,4 ms, mas empresa grande com 9/9 canceladas e EXPLAIN acima de 60 s, portanto sem plano completo obtido. A variante testada compara com `clock_timestamp()` volátil dentro da subconsulta. Nenhuma variante demonstrou resolver a empresa pequena sem regredir a grande.

**Candidatas ainda não testadas (Astra, 07/11).** Calcular o piso uma vez fora da `LATERAL`, em CTE materializada ou parâmetro, e conferir empresa e horário em `Index Cond` no índice existente; mesmo assim, 30 dias sem falha podem percorrer muitos eventos. Depois, busca em lote por empresa com sondagem limitada, usando o caminho atual para faixas densas. Comparar com a ordem alternada, incluindo ausência de falha, janelas curta e longa e 50 concessões. Exigem nova autorização de cluster descartável.

**Limites.** Máquina compartilhada e carregada por outras sessões, e não o Render. A ordem das execuções afeta os números. Tabela com um só tenant dominante e sem eventos de 30 a 180 dias. O volume real de `mcp_auditoria` não foi lido. Efeito sobre listar e revogar sob concorrência não medido.

**Conclusão.** Em volume alto, o caminho degradado funcionou como projetado nos pontos medidos: falhas ficam "indisponíveis" e a causa deixa de aparecer. Índice parcial é a solução medida, mas exige migration e autorização.

### Rodada 4 da experiência: parecer do Astra sobre o delta (07/11/2026)

Parecer: APROVADO COM RESSALVAS, 1 P2 e 2 P3, sem P1. Tratados localmente, sem nova revisão.

- **P2, aviso de Desconectar apagado pela releitura.** `erroLeitura` e `erroRevogacao` agora são separados em `criarControladorDeConexoes` (`components/admin/conexoes-leitura.ts`). Leitura bem-sucedida limpa só o próprio erro; o aviso de Desconectar sai só na próxima tentativa. Teste: POST 500 seguido de GET 200 com a conexão ainda ativa.
- **P3, leitura sem resposta prendia a fila.** Prazo de 15 s sobre a leitura completa e cancelamento ao sair da tela. `adminFetch` passa `init.signal` às duas confirmações de sessão; sem sinal, nada muda. Leitura cancelada não descarta a página nem guarda aviso. Resposta atrasada de quem ignora o sinal não grava nada. O prazo de 15 s é uma escolha, não uma medição.
- **P3, documentação.** Volumes como pontos medidos, medianas "entre as execuções concluídas", cache "não controlado".

Fora do tratamento nesta rodada: o POST de Desconectar sem saída para o usuário (tratado na rodada 5).

Verificação local: 268/268 testes sem PostgreSQL nas suítes alteradas, `lib/http` e `lib/integracoes/mcp`; `tsc`, `next build` e ESLint sem erros; 17/17 mutantes novos mortos. A ligação do controlador no componente tem cobertura só de tipos e build: a tela montada com essas falhas não foi exercida em navegador. A suíte PostgreSQL não foi repetida, pois o SQL não mudou.

### Rodada 5 da experiência: segundo parecer do Astra sobre o delta (07/11/2026)

Parecer: APROVADO COM RESSALVAS, 1 P2 e 3 P3, sem P1; o P2 original ficou fechado. Tratados localmente, sem nova revisão.

- **P2, aborto suprimia descarte de sessão.** Em `adminFetch`, a evidência já obtida (outra empresa, sessão encerrada, sessão obsoleta) segue a regra normal mesmo com o sinal abortado, nas duas confirmações. O motivo do cancelamento só sai quando a confirmação foi interrompida sem evidência, ou quando a sessão foi confirmada igual. Substitui o que a rodada 4 descreve sobre esse ponto.
- **P3, primeiro timeout sem botão.** Sem lista recebida, o erro vem com **Tentar de novo**, ligado ao mesmo controlador.
- **P3, POST pendente.** Depois de 15 s (`ESPERA_REVOGACAO_MS`, escolha, não medição), a tela diz que o resultado não foi confirmado, relê a lista e solta os outros botões. O pedido não é cancelado nem repetido, e o botão daquela conexão fica em "Aguardando confirmação" até a resposta. Resposta posterior retira a espera; erro real substitui o aviso.
- **P3, documentação.** A linha de 5 milhões registra a sequência real: 7 tentativas canceladas e depois o EXPLAIN sem prazo.

Verificação local: 283/283 testes sem PostgreSQL nas suítes alteradas, `lib/http` e `lib/integracoes/mcp`; `tsc`, `next build` e ESLint sem erros; 21/21 mutantes desta rodada mortos. Tela montada não exercida em navegador, e suíte PostgreSQL não repetida, pois o SQL não mudou. No roteiro de staging, conferir na tela real: Tentar de novo depois de uma primeira leitura interrompida; aviso de Desconectar depois de uma falha seguida de releitura.

### Rodada 6 da experiência: terceiro parecer do Astra sobre o delta (07/11/2026)

Parecer: APROVADO COM RESSALVAS, 1 P2 e 3 P3, sem P1. Tratados localmente, sem nova revisão. Revogar de novo depois de recarregar foi conferido por ele como seguro no servidor, então não recebeu bloqueio.

- **P2, navegação antecipada na troca de empresa.** Com a troca desta página em curso, `adminFetch` não navega mais: descarta os dados, devolve o erro e deixa a troca conduzir, depois da resposta do POST. **Muda comportamento compartilhado, com ou sem sinal**, e por isso o teste `troca-sessao.test.ts` que esperava `/admin/dashboard` foi ajustado. A regra (`descartarPagina`) cobre também o que o parecer não citou e tem a mesma causa: confirmação que falha, contexto divergente e recusa 409 durante a troca. Destino de login e troca já encerrada seguem como antes.
- **P3, aviso de saída.** Escrita impedida ou respondida durante a troca não sobrescreve o aviso de saída.
- **P3, Desconectar concorrente.** O aviso de espera agora é derivado de `emEspera`, com plural, e coexiste com erros.
- **P3, exceção das escritas.** A regra da rodada 5 sobre o motivo do cancelamento na confirmação posterior vale para leituras. Escrita já respondida: com a mesma sessão confirmada, devolve a resposta; com a confirmação interrompida sem evidência, descarta a tela e preserva o resultado pelo status (200 concluída, 404 recusada, 503 incerta). Escrita abortada antes do envio sem evidência de mudança não sai. Testes de POST com sinal cobrem os ramos.

Verificação local: suítes alteradas, `lib/http` e `lib/integracoes/mcp` sem PostgreSQL; `tsc`, `next build` e ESLint sem erros; 18 de 19 mutantes mortos. O sobrevivente, "login adiado pela troca", foi considerado equivalente, e o Astra mostrou que não era (rodada 7). Tela montada e fluxo real da troca não exercidos em navegador; incluir no roteiro de staging uma troca de empresa com leitura em curso.

Ressalva: se a troca falhar depois disso, a página não é descartada por este caminho; os dados daquela leitura não foram entregues, e o resultado de escrita fica guardado para a próxima tela. Quem responde pela troca falha é o `AdminShell`, que não mudou.

### Rodada 7 da experiência: quarto parecer do Astra sobre o delta (07/11/2026)

Parecer: APROVADO COM RESSALVAS, 2 P2 e 1 P3, sem P1. Tratados localmente, sem nova revisão.

- **P2, login com o POST da troca pendente.** A troca podia começar entre a classificação "encerrada" e o retorno do `await` em `adminFetch`. `revalidarEncerrada` confere a marca logo antes de agir, nos dois ramos. Teste com varredura de ordens de resposta.
- **P2, troca que falha sem reconciliar.** `concluirTrocaFalha`, usada por `AdminShell` e `ConsentimentoAssistente`: sem descarte adiado, comportamento de antes; com descarte adiado, carga completa, que revalida a sessão, e a tela só volta depois da espera. Se a pessoa escolher "Ficar", o resultado guardado aparece na própria tela. O consentimento volta ao mesmo pedido. **Decisão minha:** carga completa em vez de revalidar por leitura, por ser o mecanismo de descarte que o sistema já usa.
- **P3, mensagem.** O aviso de operação concluída sem confirmação não afirma mais recarregamento.

Verificação local: suítes alteradas, `lib/http` e `lib/integracoes/mcp` sem PostgreSQL; `tsc`, `next build` e ESLint sem erros; 15/15 mutantes mortos, um deles só depois de corrigir o teste, que não via a navegação por `replace`. Tela montada e fluxo real da troca não exercidos em navegador.

Alcance: `adminFetch` é compartilhado, e `AdminShell` agora também mostra, em quem fica depois de trocar com sucesso, o aviso guardado. A troca falhar sem descarte adiado continua como antes, e nesse caso a recuperação segue dependendo de foco, consulta periódica ou próxima requisição.

### Rodada 8 da experiência: quinto parecer do Astra sobre o delta (07/11/2026)

Parecer: **REPROVADO**, sem P1, com 4 P2 e 1 P3, todos no fluxo compartilhado de troca de empresa. O P2 do login e o P3 da mensagem da rodada 7 foram dados como resolvidos. Tratados localmente, sem nova revisão. A abordagem da rodada 7 (carga completa e prazo que libera a tela) foi **substituída**.

- **P2, rascunho perdido na troca recusada.** O `AdminShell` trocava a página pelo indicador de espera, desmontando editores. Agora `.conteudo` fica montado e `inert` durante a troca; o estado da troca aparece num aviso fixo fora dele.
- **P2, prazo liberava a tela antiga e tirava o aviso da página nova.** Depois de pedir a navegação, o prazo só oferece "Continuar": não libera e lê o aviso sem removê-lo (`espiarAvisoDeContexto`). Componente fora da tela não consome o aviso.
- **P2, falha ambígua liberava a tela.** Toda falha depois do envio passa por uma leitura da sessão, com prazo de 10 s. Mesma sessão e empresa: a tela volta intacta. Mudou: destino seguro. Encerrada: login. Sem conseguir conferir: segue bloqueada, com "Conferir de novo". `descarteAdiado` saiu.
- **P2, duas navegações.** `trocarEmpresaAtiva` só classifica (`ErroTrocaEmpresa`), e `conduzirTrocaDeEmpresa` é o único ponto que decide. Durante a condução, `reiniciarContextoEmpresa` não navega e o shell ignora sua própria leitura. O consentimento tinha `reiniciar` seguido de `reload`: saiu.
- **P3, mensagem perdida na carga.** Origem `troca`: soma-se ao resultado de uma escrita, sem apagá-lo.

Mudanças de comportamento além do parecer: o sinal entre abas agora também sai da troca feita no consentimento; depois de "Ficar", o seletor continua bloqueado até "Continuar".

Verificação local:

- 349 testes sem PostgreSQL (`lib/http`, `lib/integracoes/mcp` e suítes alteradas), `tsc` e ESLint sem erros.
- `next build` sem erros, antes de uma última remoção de import sem uso e de ajustes só em teste.
- Chrome real com o build de produção e **API simulada**, 20/20: troca em andamento com o nó da página preservado, recusa, resposta truncada com e sem troca efetivada, "Ficar" com `beforeunload` real, navegação lenta de 6 s, 401, conferência sem resposta, celular 375 px e consentimento. Roteiro: `ambientes-locais/prova-troca-empresa-20261107/prova.cjs`. Editor real de rascunho e banco real **não** foram exercidos: o estado preservado foi inferido do nó que continua montado.
- 21/21 mutantes mortos em cópia isolada, com a base verde conferida antes; 2 só depois de reforçar os testes. A primeira execução deu 21/21 **inválido**: um teste meu entrava em recursão e a base já falhava. Foi descartada.

Correção de processo: nas rodadas 4 a 7 desta tarefa, os mutantes rodaram no clone de trabalho, com restauração a cada um, contra a regra de usar cópia isolada. Os números dessas rodadas seguem como foram medidos, mas o método estava errado.

Limite conhecido: leituras feitas durante a troca recebem erro, e a tela liberada pode manter a mensagem de erro de um componente até a próxima leitura.

### Rodada 9 da experiência: sexto parecer do Astra sobre o delta (08/11/2026)

Parecer: **REPROVADO**, sem P1, com 5 P2 e 1 P3, todos na troca de empresa compartilhada. Tratados localmente, sem nova revisão.

- **P2, tela liberada sem prova.** Só uma leitura válida com sessão e empresa **iguais** às da página libera a tela (`contextoConfirmado`). Falha na leitura inicial, renovação de sessão em curso ou saída em andamento mantêm a tela bloqueada. Um descarte pedido durante a conferência (outra aba) obriga a conferir de novo. "Conferir de novo" faz uma conferência por vez, e só uma condução roda por vez.
- **P2, duas navegações.** O portão vale do início da troca até o documento sair: `adminFetch` não vai ao login durante a condução, e outra aba, a leitura periódica e a saída não navegam por cima dela. A navegação é repetida só pelo botão "Continuar" (`navegarPelaConducao`). A leitura periódica do shell também é descartada durante a saída.
- **P2, portão preso.** A leitura inicial e o POST, com o corpo, têm prazo de 6 s, menor que os 8 s da saída. Esgotado o prazo, a conferência decide, e sem resposta a tela oferece conferir de novo, sempre bloqueada.
- **P2, ações acessíveis.** O estado da troca é um só (`publicarEstadoDaTroca`), mostrado pelo shell para qualquer tela que a inicie, inclusive o consentimento. Durante a troca ficam inertes a navegação lateral, a marca e a gaveta do assistente; o botão do assistente e os links da conta somem; Sair continua.
- **P2, trabalho de fundo.** Durante a condução, escrita não sai (aviso "Nada foi enviado"); leitura espera a tela ser liberada, sem erro nem tentativa gasta, respeitando o sinal de quem pediu; leitura já respondida confere depois da liberação. Escrita já enviada continua com o resultado real.
- **P3, rascunho.** Antes do POST, a condução consulta as proteções de saída já registradas (`beforeunload` simulado e cancelável). Com alterações, pergunta com a tela livre: "Trocar mesmo assim" ou "Voltar".

Decisões minhas para o Astra contestar: prazo de 6 s por etapa (um servidor mais lento que isso vira resultado incerto e passa pela conferência); leitura de componentes fica pendente se a pessoa escolher "Ficar".

Verificação local:

- 360 testes sem PostgreSQL, `tsc` sem erros.
- `next build` sem erros.
- Chrome real com build de produção e **API simulada**, 32/32, incluindo o **editor real do site de Marketing** (proteção de saída real, rascunho preservado na recusa, "Ficar" com a pergunta real do navegador), "Continuar" até o painel, leitura periódica sem nova pergunta, consentimento bloqueando o shell e celular 375 px.
- 22/22 mutantes mortos em cópia isolada, com a base verde conferida antes; 6 só depois de reforçar os testes.

Limites: banco real e sessão real não exercidos; componentes que usam `fetch` direto, sem `adminFetch`, não são pausados.

### Sétimo parecer do Astra sobre o delta (08/11/2026): parado para decisão

Parecer: **REPROVADO**, 3 P2 e 2 P3, sem P1. **Não tratado.**

- P2: o prazo de 6 s pode liberar a tela antes de uma troca que o servidor ainda vai concluir. Fechar exige desfecho verificável da troca no servidor e recuperação da sessão, o que muda autenticação.
- P2: respostas já em curso (consentimento, assistente) ainda podem navegar durante a troca.
- P2: o diálogo nativo do editor de Marketing escapa do `inert` e pode tomar a tela bloqueada.
- P3: leitura parada depois de "Ficar" fura o prazo do acompanhamento de Convites.
- P3: a oferta de "Trocar mesmo assim" pode sobreviver ao editor consultado.

O Astra recomenda PR próprio para a troca de empresa, com o consentimento MCP como consumidor. Como a correção passa a exigir mudança no servidor de autenticação, fora do escopo autorizado desta tarefa, o trabalho parou à espera da decisão de Felipe.

### Separação da troca de empresa (08/11/2026)

Decisão de Felipe depois do sétimo parecer: a troca de empresa sai deste PR e vira tarefa própria. **Substitui o que as rodadas 6 a 9 descrevem sobre a troca:** aquele código não está mais neste branch.

O que voltou à base `308dba9b`: `lib/http/contexto-empresa-cliente.ts`, `components/admin/AdminShell.tsx`, `components/admin/shell.module.css`, `components/admin/inteligencia/PerguntarKidmais.tsx` e os testes `troca-sessao`, `inteligencia-ui` e `central`.

O que ficou em `lib/http/admin-fetch.ts`: só o sinal de cancelamento das rodadas 4 e 5, que a lista de Assistentes conectados usa. O sinal chega às duas confirmações de sessão. Evidência já obtida segue a regra normal. Leitura cancelada sem evidência não descarta a página. Escrita já respondida continua com o aviso do resultado real.

O consentimento não tem mais seletor de empresa próprio. Com mais de uma empresa, a tela orienta a trocar no menu da conta e voltar ao pedido, que continua aberto. A troca do menu é a da base e leva ao painel. "Entrar com outra conta" continua.

O código completo da troca até a rodada 9, com testes, está guardado fora do repositório em `ambientes-locais/troca-empresa-separada-20261108/troca-completa-r9-sobre-308dba9b.patch` e em cópias dos arquivos na mesma pasta, como ponto de partida do PR próprio. Os sete pareceres do Astra ficam como requisitos dele.

Verificação local depois da separação: 541/541 testes sem PostgreSQL (`lib/http`, `lib/integracoes/mcp`, OAuth sem banco, `components/admin`, assistente e suporte), `tsc`, ESLint e `next build` sem erros. Não refeitos: prova em Chrome e mutantes.

### Rodada 11 da experiência: oitavo parecer do Astra (08/11/2026)

Parecer: **REPROVADO**, sem P1, com 1 P2 e 3 P3. A separação da troca de empresa foi dada como correta. Tratados localmente, sem nova revisão.

- **P2, o Voltar não recupera o pedido.** A troca da base usa `location.replace('/admin/dashboard')` e substitui a entrada do consentimento no histórico. A orientação agora diz o que acontece: a troca leva ao painel e não volta para a página. Depois, a pessoa volta ao assistente e inicia a conexão de novo. Se ainda tiver o link, ele pode ser reaberto até o fim do prazo do pedido. O texto não cita mais o botão Voltar.
- **P3, cartão sem identidade confirmada.** Sem usuário e empresa confirmados, os cartões e o guia mostram "Situação não confirmada" (`SITUACAO_NAO_CONFIRMADA`, `cartaoDaTela`). Eles não afirmam "Aguardando autorização" nem atribuem conexão. A lista e o Desconectar continuam disponíveis.
- **P3, código consumido sem credencial.** A causa passou a ser: "Não há credencial vigente nesta conexão: a conexão não foi concluída pelo assistente ou a renovação automática terminou."
- **P3, reconectar substitui a autorização.** A mensagem da ferramenta, a explicação da falha, a tela, o guia e o rascunho do artigo v3 dizem a mesma coisa: marque as permissões que deseja manter e as que deseja adicionar, porque a nova autorização substitui a anterior.
- `next-env.d.ts` foi restaurado depois de cada build, e não entra no diff.

Verificação local:

- 542 testes sem PostgreSQL nas mesmas suítes, `tsc` e ESLint sem erros, `next build` sem erros.
- Chrome real com build de produção e **API simulada**, 9/9 (`ambientes-locais/prova-troca-empresa-20261107/prova-r11-consentimento.cjs`): orientação visível, sem seletor próprio, troca pelo menu vai ao painel, o Voltar volta para a página anterior e não para o pedido, reabrir o link abre o pedido na empresa nova, celular 375 px sem rolagem horizontal.
- 10/10 mutantes mortos em cópia isolada, com a base verde conferida antes. Um deles só morreu depois de apontar o teste para o parágrafo da tela, porque o guia repete a frase.

Não exercidos: banco real, sessão real e clientes reais. O cartão sem identidade foi coberto por renderização, não pelo navegador.

### Rodada 12 da experiência: nono parecer do Astra (08/11/2026)

Parecer: **REPROVADO**, sem P1, com 2 P2 e 3 P3. Os outros dois P3 do 8º parecer foram dados como resolvidos. Tratados localmente, sem nova revisão.

- **P2, cancelar uma pergunta descartava a página.** A gaveta do assistente envia POST com sinal. Se a pessoa cancelava depois do 200, o aborto interrompia a confirmação posterior e o `adminFetch` navegava. Agora a escrita já enviada conclui a confirmação posterior **sem o sinal**, como na base. A confirmação prévia, o envio e a confirmação posterior da leitura continuam canceláveis. Testes: aborto durante a confirmação posterior de POST devolve a resposta (200, 503 e 404) sem navegar nem guardar aviso; falha real da confirmação continua descartando com o aviso pelo status; a gaveta (`conversar` com o `adminFetch` real) cancelada depois do 200 não descarta a página.
- **P2, identidades presas impediam Desconectar.** A leitura opcional da identidade usava as duas vagas de listar e revogar. Agora ela tem vaga própria (`VAGAS_BANCO_IDENTIDADE = new Vagas(1)`, `transacaoDaIdentidade`, prazo 1,5 s) e a rota usa essa transação. Sem vaga, a tela sai com identidade nula. Teste novo `lib/integracoes/oauth/vagas-da-pessoa.test.ts` com a composição real (`dependencias.ts`, `Vagas`, `transacaoComPrazo` e o repositório PostgreSQL) sobre um pool falso: com duas identidades presas a revogação conclui, e listar e revogar seguem livres com uma identidade presa.
- **P3, promessa de reabertura ampla demais.** Os dois parágrafos do consentimento agora dizem que o link anterior só abre o pedido enquanto ele estiver sem resposta e dentro do prazo, e que Permitir ou Não permitir encerra o pedido.
- **P3, o guia liberava a primeira consulta com conexão a refazer.** O passo 4 libera "Continuar" pela situação calculada (`podeIrParaPrimeiraConsulta`: só "Autorizado, aguardando primeira consulta" e "Última consulta bem-sucedida"). Concessão não revogada sem credencial vigente fica em "Precisa reconectar", com o botão desligado e a orientação para refazer a conexão.
- **P3, especificação contradizia a tela.** `docs/MCP_ASSINATURAS_V1.md` agora diz que a reconexão substitui a concessão anterior com os escopos do novo consentimento, e que a troca pelo menu leva ao painel.

Verificação local:

- 575 testes sem PostgreSQL (`lib/http`, `lib/integracoes/mcp`, OAuth sem banco, `components/admin`, assistente e suporte): 574 na rodada completa e 1 falha por prazo em `cimd.test.ts` sob carga, arquivo não alterado; sozinho, 10/10 duas vezes. `tsc` e ESLint sem erros, `next build` sem erros, `next-env.d.ts` restaurado.
- Chrome real com build de produção e **API simulada que consome o pedido como o servidor**, 15/15 (`ambientes-locais/prova-troca-empresa-20261107/prova-r12-consentimento.cjs`): orientação e prazo; troca pelo menu vai ao painel; Voltar não devolve o pedido; reabrir com pedido **pendente** abre na empresa nova; depois de **Não permitir** e de **Permitir**, reabrir mostra o pedido encerrado sem Permitir; pedido **expirado** idem; com **identidade indisponível**, cartões em "Situação não confirmada" e Desconectar envia um POST da conexão certa; celular 375 px sem rolagem horizontal nas duas telas.
- 17/17 mutantes mortos em cópia isolada (10 da rodada 11 como regressão e 7 novos), com a base verde conferida antes.

Não exercidos: banco real, sessão real e clientes reais. A disputa de vagas foi provada com pool falso, não com PostgreSQL.

### Rodada 13 da experiência: décimo parecer do Astra (08/11/2026)

Parecer: **REPROVADO**, sem P1, com 1 P2 novo, 1 P2 preexistente na base e 1 P3 novo. Dos cinco achados do 9º parecer, quatro foram dados como corrigidos e o do guia como parcial. Tratados localmente, sem nova revisão.

- **P2 novo, o guia liberava uma primeira consulta que a conexão não podia fazer.** Nova regra `bloqueioDaPrimeiraConsulta(cartao, canalAtivo, nome)`, usada ao avançar do passo 4 e ao mostrar o passo 5. Ela exige situação utilizável, canal ligado e `conhecimento:read` entre as permissões escolhidas, porque a pergunta pronta usa a ajuda e documentação. Bloqueado, o passo 4 desliga "Continuar" e explica o motivo. O passo 5 não mostra a pergunta nem "Copiar pergunta": mostra o motivo, a situação, Voltar e Atualizar. Isso cobre a credencial que vence com o passo 5 já aberto.
- **P2 preexistente, confirmação válida atrasada liberava o POST antigo.** `confirmarSessao` passou a tratar leitura válida que saiu antes ou durante uma troca de empresa desta página como possivelmente da sessão anterior. Ela espera a troca terminar (`fimDaTrocaEmCurso`) e lê a sessão de novo, uma vez. Troca concluída aparece como outra empresa ou sessão e descarta a página com o aviso do resultado real. Troca recusada relê a mesma sessão e entrega a resposta. Nova troca durante a releitura → obsoleta. Testes determinísticos em `admin-fetch-tipo.test.ts`: POST com A atrasada depois da troca para B → `CONTEXTO_MUDOU`, 3 leituras de sessão, 1 navegação, aviso "concluída antes da mudança"; leitura → descartada; troca recusada → resposta entregue, sem navegação.
- **P3 novo, consentimento podia misturar sessões.** O GET do pedido passou a devolver `sessao: { usuarioId, empresaId }`, os ids da própria sessão usada para montar usuário, empresas e piloto. `carregarPedido` só monta a tela quando esse usuário é o mesmo da leitura da sessão e a empresa é a mesma empresa ativa. Divergência ou ausência → "A conta ou a empresa mudou enquanto o pedido abria. Tente de novo.", recuperável, sem Permitir.
- **Roteiro de staging, taxa de identidade nula.** `identidadeOuNulo` agora registra só a categoria fechada (`[Kidmais MCP] identidade indisponível: VAGA_OCUPADA | PRAZO_DA_APLICACAO | ...`), sem mensagem, SQL ou dado. No staging, essa linha separa vaga ocupada de prazo vencido. A vaga única da identidade continua: duas leituras simultâneas na mesma instância dão uma identidade nula, e a frequência real ainda não foi medida.

Verificação local na candidata final, Node 22.23.2:

- 582/582 testes sem PostgreSQL (`lib/http`, `lib/integracoes/mcp`, OAuth sem banco, `components/admin`, assistente e suporte), **com o CIMD-LOOKUP verde na suíte completa**. `tsc`, ESLint (arquivos alterados) e `next build` sem erros; `next-env.d.ts` restaurado.
- Chrome real com build de produção e API simulada, 20/20 (`ambientes-locais/prova-troca-empresa-20261107/prova-r13-consentimento.cjs`): os 15 cenários da r12 e mais estes:
  - pedido montado com a sessão A e leitura da sessão B: nada para decidir, oferece tentar de novo;
  - guia só com agenda: passo 5 sem a pergunta pronta, "Continuar" do passo 4 desligado;
  - guia com ajuda e documentação: pergunta oferecida, "Continuar" ligado.
- 24/24 mutantes mortos em cópia isolada (`mutantes-mcp-exp-r13.cjs`), com a base verde antes. Os mutantes cobrem passos 4 e 5, permissão, canal, releitura da confirmação, composição do consentimento e a rota do pedido. O registro da categoria entrou depois da rodada de mutantes e é coberto pelo teste dele.

Não exercidos: banco real, sessão real, ChatGPT e Claude reais. A corrida foi reproduzida com respostas sintéticas.

Roteiro de staging, acréscimos do 10º parecer: consentimento durante troca de empresa e com sessão expirada; concessão parcial (só agenda), com o guia bloqueando a pergunta pronta; revogação com leituras de identidade concorrentes; contagem das linhas "identidade indisponível" por categoria.

### Rodada 14 da experiência: 11º parecer do Astra (08/11/2026)

Parecer: **REPROVADO**, sem P1, com 2 P2 e 4 P3. Todos foram tratados localmente, sem nova revisão.

**P2: espera da troca sem cancelamento nem prazo, e envio durante a saída da sessão.**

- `confirmarSessao` agora espera pela troca com `esperarFimDaTroca(signal)`.
- A espera tem prazo próprio, `ESPERA_DA_TROCA.prazoMs` (8 s).
- A espera termina quando o sinal é cancelado, e nem começa se ele já chegou cancelado.
- Prazo vencido ou cancelamento dão `falha`, nunca releitura.
- Uma segunda leitura ainda obsoleta também dá `falha`.
- Entre a confirmação prévia e o envio, `saidaDaSessaoEmAndamento()` interrompe com `SESSAO_ENCERRADA` ("Saindo da sessão. Nada foi enviado."), e nada vai ao servidor.

Testes determinísticos novos em `admin-fetch-tipo.test.ts`:

- leitura cancelada no meio da espera: AbortError rápido;
- POST com a troca pendente além do prazo: `SESSAO_NAO_CONFIRMADA`, com o aviso de escrita confirmada sem contexto e sem releitura;
- troca pendente na confirmação prévia: nenhum POST;
- saída começando durante a confirmação prévia, com a troca recusada: `SESSAO_ENCERRADA`, nada enviado, 2 leituras.
- sinal cancelado antes de a espera começar: AbortError na hora, sem esperar o prazo;
- prazo vencido não conta como troca terminada: nenhuma releitura (2 leituras).

**P2: guia oferecia a pergunta pronta a empresa fora do piloto ou com as leituras desligadas.**

- O servidor devolve, por conexão, `consultaDaAjudaLiberada = consultaLiberadaNoAmbiente(env, "kidmais_buscar_conhecimento", empresaId)`.
- Essa função aplica as mesmas portas da execução:
  - canal MCP;
  - INTELIGENCIA_ENABLED e AI_READ_ENABLED;
  - MCP_TENANT_ALLOWLIST;
  - AI_TENANT_ALLOWLIST, quando existe.
- `bloqueioDaPrimeiraConsulta` agora checa, nesta ordem: canal, situação, piloto, portas de ambiente e permissão.
- Cada bloqueio tem uma explicação própria e nenhum pede reconexão.

Testes:

- a função, contra todos os casos de recusa de ambiente da matriz CASOS de `ferramentas-mcp.test.ts`;
- o mapeamento da lista, em `identidade-sessao.test.ts`;
- os passos 4 e 5 da tela.

**P3: duas trocas recusadas geravam aviso de "mudança".** Um teste cobre o caso: com duas trocas recusadas, o aviso não diz "antes da mudança".

**P3: o bloqueio escondia "Funcionou" com CONSULTA_OK.** O passo 5 bloqueado agora mostra `data-consulta-confirmada` "Funcionou…" quando a conexão já registrou consulta. Exemplo: concessão só com agenda e uma consulta à agenda feita.

**P3: o consentimento confundia falha de sessão com falta de empresa.** `carregarPedido` agora verifica nesta ordem:

1. Resposta da sessão com erro (401, 5xx ou corpo inválido): "Não foi possível confirmar a sua sessão. Tente de novo.", recuperável.
2. Sessão sem usuário: "A sua sessão terminou. Entre de novo para responder ao pedido.".
3. Usuário ou empresa diferentes entre o pedido e a sessão, inclusive quando só um dos lados não tem empresa: "A conta ou a empresa mudou…".
4. Só quando os dois lados concordam que não há empresa: semEmpresa.

Quando o adminFetch do pedido lança `ErroContextoAdmin` por sessão não confirmada, isso também vira falha de sessão. O tipo `REDE` continua como falha de conexão.

**P3: a métrica "primeira consulta" contava a última.** Em `docs/MCP_ASSINATURAS_V1.md`, a primeira consulta bem-sucedida agora sai de `mcp_auditoria`: o menor FERRAMENTA OK/SEM_DADOS por concessão, com o limite da retenção de 180 dias declarado. `ultima_ferramenta_em` fica só como "última consulta bem-sucedida".

Verificação local na candidata final, Node 22.23.2:

- 594/594 testes sem PostgreSQL, com o CIMD-LOOKUP verde na suíte completa.
- `tsc`, ESLint nos arquivos alterados, `next build` e `git diff --check` (rastreados e novos): sem erros. `next-env.d.ts` restaurado.
- Chrome real com build de produção e API simulada: 24/24 (`ambientes-locais/prova-troca-empresa-20261107/prova-r14-consentimento.cjs`). Além dos 20 cenários da r13:
  - guia fora do piloto: sem a pergunta pronta, com o motivo;
  - guia com as consultas desligadas: sem a pergunta pronta, com o motivo;
  - guia só com agenda e com consulta registrada: "Funcionou" aparece, sem a pergunta pronta;
  - consentimento com a leitura da sessão do pedido em 503: "Não foi possível confirmar a sua sessão", nunca "sem empresa".
- 41/41 mutantes mortos em cópia isolada (`mutantes-mcp-exp-r14.cjs`, com a base verde antes): os 24 da r13 e 17 novos. Na primeira passada sobreviveram 2 mutantes da espera (sinal já cancelado antes de esperar, e prazo tratado como troca terminada). Eles foram fechados pelos dois testes determinísticos acima, e a segunda passada matou todos.

Não exercidos: banco real, sessão real, ChatGPT e Claude reais. As corridas foram reproduzidas com respostas sintéticas.

**Roteiro de staging, acréscimos do 11º parecer.** Somente com dados sintéticos e somente com autorização própria da janela.

1. **Consentimento durante troca e com sessão expirada.**
   - Substituído pelo item 1 do roteiro da rodada 15 (12º parecer), que separa a troca durante a carga da troca depois de o formulário abrir.
   - Repetir com a sessão expirada. Esperado: "A sua sessão terminou" ou "Não foi possível confirmar a sua sessão", nunca "sem empresa".
2. **Concessão só com agenda e com consulta registrada.** Fazer uma consulta de agenda pelo assistente e abrir o guia. Esperado: "Funcionou" no passo 5, sem a pergunta pronta.
3. **Fora do piloto e leituras desligadas.**
   - Tirar a empresa sintética de MCP_TENANT_ALLOWLIST. O env de staging só pode ser alterado na janela autorizada. Esperado: o guia explica o motivo e não oferece a pergunta.
   - Repetir com AI_READ_ENABLED=false.
4. **Revogação sob concorrência.** Desconectar enquanto a lista e a identidade são lidas em outra aba. Esperado: uma revogação só, e a lista atualizada.
5. **Identidade e diagnóstico.**
   - Latência p50 e p95 das leituras de identidade e de falhas.
   - Linhas `identidade indisponível` contadas por categoria, sobre o total de leituras da tela no mesmo período.
6. **Schema 105.**
   - Confirmar a 105 aplicada em staging antes do roteiro, pelo postcheck da própria 105.
   - Sem a 105, a tela deve mostrar o canal indisponível, sem DDL.

**Arquivos selecionados para a PR (contra staging), 29 no total.**

- Rotas:
  - `app/api/admin/mcp/conexoes/route.ts`
  - `app/api/admin/mcp/consentimento/route.ts`
  - `app/api/mcp/dependencias.ts`
- Tela:
  - `components/admin/ConexoesAssistentes.tsx`
  - `components/admin/ConsentimentoAssistente.tsx`
  - `components/admin/conexoes-assistentes-guia.ts`
  - `components/admin/conexoes-assistentes.module.css`
  - `components/admin/conexoes-leitura.ts`
- Domínio:
  - `lib/http/admin-fetch.ts`
  - `lib/integracoes/mcp/ferramentas.ts`
  - `lib/integracoes/mcp/servidor.ts`
  - `lib/integracoes/oauth/conexoes.ts`
  - `lib/integracoes/oauth/identidade-sessao.ts`
  - `lib/integracoes/oauth/situacao-conexao.ts`
  - `lib/integracoes/oauth/postgres.ts`
  - `lib/integracoes/oauth/repositorio.ts`
  - `lib/integracoes/oauth/memoria-teste.ts`
- Testes:
  - `components/admin/consentimento-mcp-ui.test.ts`
  - `components/admin/conexoes-assistentes-ui.test.ts`
  - `components/admin/conexoes-leitura.test.ts`
  - `lib/http/admin-fetch-tipo.test.ts`
  - `lib/integracoes/mcp/ferramentas-mcp.test.ts`
  - `lib/integracoes/mcp/protocolo.test.ts`
  - `lib/integracoes/oauth/identidade-sessao.test.ts`
  - `lib/integracoes/oauth/situacao-conexao.test.ts`
  - `lib/integracoes/oauth/vagas-da-pessoa.test.ts`
  - `lib/integracoes/oauth/oauth.postgres.test.ts`
- Documentos:
  - `docs/MCP_ASSINATURAS_V1.md`
  - `docs/MCP_ASSINATURAS_TESTES.md`

**Fora da PR:**

- `docs/MCP_ARTIGO_ASSISTENTES_V3_RASCUNHO.md`, até Felipe aprovar o texto.
- `next-env.d.ts` e os artefatos gerados pelo build.

### Rodada 15 da experiência: 12º parecer do Astra (08/11/2026)

Parecer: **REPROVADO**, com 2 P2 parciais e 2 P3 parciais. Os outros 2 P3 foram dados como corrigidos. Todos foram tratados localmente, sem nova revisão.

**P2: janela entre a validação da sessão e o envio.**

- `confirmarSessao` agora devolve a marca que validou.
- `adminFetch` confere essa marca de novo, sem nenhum `await` até o `fetch`. Se uma troca de empresa começou depois da validação, inclusive entre a validação e a retomada de `adminFetch`, nada é enviado. O erro é `SESSAO_NAO_CONFIRMADA`, com a mensagem "A empresa ativa pode estar mudando. Nada foi enviado".
- Toda releitura que também cruzou uma troca vira `falha`, com ou sem usuário. Ela nunca gera "mudou" nem "encerrada".
- A saída da sessão é conferida logo depois da confirmação prévia, antes de registrar o contexto. Uma troca concluída durante a saída resulta em `SESSAO_ENCERRADA`, sem aviso de mudança.
- A conferência da saída que ficava logo antes do envio foi removida porque repetia a anterior: entre as duas não há `await`.

Testes novos em `admin-fetch-tipo.test.ts`:

- **Corrida real.** Os fluxos `adminFetch` e `trocarEmpresaAtiva` partem juntos.
  - A resposta da leitura de sessão do POST de negócio atrasa de 0 a 40 microtarefas, e a troca fica pendente por 5 ms.
  - Em nenhum atraso o POST de negócio sai com a troca pendente.
  - Controle: a varredura alcança tanto "enviado antes da troca" quanto o cruzamento barrado.
  - Sem a nova conferência, o teste falha. Isso foi verificado à mão e também é um mutante da rodada.
- Releitura obsoleta sem usuário: `SESSAO_NAO_CONFIRMADA`, com o aviso de resultado conhecido.
- Troca concluída durante a saída: `SESSAO_ENCERRADA`, nada enviado e sem aviso de mudança.

**P2: a pergunta pronta não considerava o segredo nem o corpus da ajuda.**

- `consultaLiberadaNoAmbiente` passou a exigir `MCP_REF_SECRET` válido nas ferramentas de conhecimento, a mesma porta da execução.
- A rota de conexões devolve `ajudaDisponivel`, calculado por `ajudaDisponivel()` em `app/api/mcp/dependencias.ts`. Ela usa o mesmo leitor do corpus da execução (`carregarCorpusAprovado`).
- O guia bloqueia a pergunta com uma mensagem própria ("A ajuda e documentação do iA.Fest está indisponível agora…"). Campo ausente conta como indisponível.

Testes:

- Função e execução concordam sem segredo e com segredo curto: as duas fecham, e a agenda não é afetada. Controle positivo com o segredo.
- Passos 4 e 5 com a ajuda indisponível e com o campo ausente.
- A rota usa o mesmo leitor da execução.

**P3: estrutura da sessão no consentimento.**

- `sessaoLida` confere a resposta da sessão em runtime:
  - `ok: true`;
  - `usuarioId` como string não vazia (`null` significa sessão encerrada);
  - `contexto.empresaAtual` como `null` explícito ou `{ id, nome }`.
- Qualquer desvio é "Não foi possível confirmar a sua sessão", inclusive `200 {ok:true,data:{usuarioId}}` sem contexto.
- `sessaoDoPedido` exige `empresaId` presente, como string ou `null` explícito.
- "Sem empresa" só aparece quando os dois lados trazem `null` explícito.

**P3: métrica.** O nome mudou para "primeiro sucesso observado por conexão". O SQL aplica a coorte: só entram as conexões cuja `AUTORIZACAO_CONCEDIDA` continua retida na auditoria. Com o expurgo por idade, todo FERRAMENTA posterior dessas conexões também continua retido.

- A coorte vem da auditoria, não de `mcp_oauth_concessoes`, porque concessões revogadas há mais de 90 dias são apagadas.
- O texto descreve o expurgo como oportunista: em lotes, com orçamento por execução, e só quando é chamado.
- O texto registra que a gravação assíncrona da auditoria pode falhar. A métrica então subconta, e a perda pode ser medida pelo log `auditoria não gravada`.
- O SQL não foi executado em nenhum banco.

**Roteiro.**

- Os pré-requisitos técnicos da homologação ficam separados da aprovação editorial do artigo. O artigo não entra na PR e só é pré-requisito da publicação em production.
- O item 1 do roteiro da rodada 14 foi substituído pelo item 1 abaixo.

Verificação local na candidata final, Node 22.23.2:

- 601/601 testes sem PostgreSQL. Na primeira passada completa, 600/601: oscilou `Desconectar durante leitura pendurada` (`components/admin/conexoes-leitura.test.ts`, prazo de 20 ms sob carga). O arquivo não foi alterado nesta rodada. Sozinho passou 5/5, e a segunda passada completa deu 601/601.
- `tsc`, ESLint nos arquivos alterados, `next build` e `git diff --check` (rastreados e novos): sem erros. `next-env.d.ts` restaurado.
- Chrome real com build de produção e API simulada: 27/27 (`ambientes-locais/prova-troca-empresa-20261107/prova-r15-consentimento.cjs`). Os cenários novos em relação à r14:
  - guia com a ajuda indisponível;
  - guia com o campo da ajuda ausente;
  - consentimento com a leitura direta da sessão em `200 {ok:true,data:{usuarioId}}`, sem contexto. É a 3ª leitura pela ordem de chamada: a 1ª é do painel, e a 2ª e a 4ª são do adminFetch do pedido. Resultado: "Não foi possível confirmar a sua sessão", nunca "sem empresa".
  - Uma primeira tentativa deformava todas as leituras depois da 1ª. O próprio painel passou a mostrar "A verificação da sessão está demorando". Esse é outro cenário, não o do parecer, e o simulador foi corrigido.
- 51/51 mutantes mortos em cópia isolada (`mutantes-mcp-exp-r15.cjs`), com a base verde antes.
  - Mutantes novos: marca não conferida antes do envio, releitura obsoleta sem usuário, segredo ignorado, ajuda indisponível ignorada, campo ausente tratado como disponível, rota sem o campo, ajuda sempre disponível, `empresaAtual` ausente tratada como nula, usuário de outro tipo, empresa sem id.
  - Equivalentes descartados, com o motivo:
    - "sessão 401 lida pelo corpo": um 401 traz `ok:false`, que já é inválido;
    - remover a conferência de saída antes do envio: ela era redundante e foi retirada do código.
  - Na primeira passada, 5 mutantes antigos não aplicaram, porque o código deles foi reescrito: as âncoras foram atualizadas. Também sobreviveu "empresaAtual ausente vale como nula". O teste com `in` barrava o caso, e cada uma das duas proteções sozinha era equivalente à outra. O teste com `in` foi retirado, e a comparação exata com `null` ficou como a única proteção. A segunda passada deu 51/51.

Não exercidos: banco real, sessão real, ChatGPT e Claude reais, e o SQL da métrica. As corridas foram reproduzidas com respostas sintéticas.

**Roteiro de staging, acréscimos do 12º parecer.** Somente com dados sintéticos e somente com autorização própria da janela.

1. **Consentimento e troca de empresa: dois casos distintos.**
   - Troca durante a carga do pedido: trocar no menu de outra aba enquanto o pedido abre. Esperado: "A conta ou a empresa mudou enquanto o pedido abria", sem Permitir.
   - Troca em outra aba depois de o formulário abrir. Esperado: o painel descarta a página e vai ao Dashboard. O critério é que o pedido antigo não seja consumido e nenhuma concessão seja criada. Conferir na lista de conexões e na auditoria: nenhuma `AUTORIZACAO_CONCEDIDA` desse pedido.
2. **Corridas.** Disparar uma escrita do painel e a troca de empresa ao mesmo tempo, em duas abas e em várias tentativas. Esperado: nenhuma escrita registrada no servidor com a sessão anterior à troca, e avisos coerentes com o resultado real.
3. **Segredo ausente.** Somente na janela autorizada, sem `MCP_REF_SECRET`. Esperado: o guia não oferece a pergunta pronta, e a busca pelo assistente responde indisponível.
4. **Corpus indisponível.** Com o manifesto da ajuda ilegível numa cópia de staging autorizada. Esperado: a mensagem "ajuda e documentação indisponível" no guia e a busca indisponível. A agenda não é afetada.
5. **Métrica.** Rodar o SQL do primeiro sucesso observado no staging, com autorização de leitura, e comparar com as consultas feitas no roteiro.

### Rodada 16 da experiência: 13º parecer do Astra (08/11/2026)

Parecer: **REPROVADO**, com 1 P2 e 3 P3, sem P1. O Astra deu como corrigidos o P2 da confirmação prévia, o P2 do segredo e do corpus no guia, as duas trocas recusadas e "Funcionou". Todos os pontos foram tratados localmente, sem nova revisão.

**P2: a confirmação posterior não reconferia a marca ao retomar.**

- Depois de `await confirmarSessao(...)` na confirmação posterior, `adminFetch` confere de novo a marca que validou, sem nenhum `await` no meio. Se uma troca de empresa começou depois da validação, inclusive na volta do `await`, o resultado vira `falha`, ou seja, contexto indeterminado.
- Leitura: a resposta é descartada, com `AVISO_LEITURA_NAO_CONFIRMADA`.
- Escrita já respondida: o resultado conhecido é preservado. Sucesso vira `AVISO_ESCRITA_CONFIRMADA_SEM_CONTEXTO` (`enviado: true`), 5xx continua incerto e recusa continua recusa.

Testes novos em `admin-fetch-tipo.test.ts`:

- **Corrida real na leitura.** `adminFetch` (GET) e `trocarEmpresaAtiva` reais. A troca é lançada de 0 a 60 microtarefas depois de a leitura de sessão posterior sair, e fica pendente por 5 ms.
  - O sinal da leitura registra, no último ponto síncrono antes do `return` (`throwIfAborted`), se há troca em curso.
  - Em nenhuma posição a resposta é entregue com a troca já começada. Quando é descartada, o aviso é o da leitura não confirmada.
  - Controle: a varredura alcança a leitura entregue e a descartada.
  - Sem a reconferência, o teste falha já em k = 0. Isso foi verificado à mão e também é um mutante da rodada.
- **Corrida real na escrita.** A mesma varredura com POST. Todo resultado barrado é `SESSAO_NAO_CONFIRMADA` com `enviado: true` e o aviso de escrita concluída sem contexto. Controle: a varredura alcança o entregue e o barrado.

**P3: pedido malformado aparecia como "a conta ou a empresa mudou".** Um pedido fora do contrato não prova troca. Isso inclui pedido sem `sessao`, sem `usuarioId`, sem `empresaId`, com `empresaId` vazio ou de outro tipo. Agora ele resulta em "Não foi possível confirmar a sua sessão", recuperável. "Mudou" fica reservado a duas identidades válidas que divergem.

Testes: cada forma malformada, com a sessão lida com e sem empresa. Controle: pedido válido de outra empresa continua "mudou". O teste do 10º parecer que esperava "mudou" para o pedido sem sessão passou a esperar "não confirmada".

**P3: a coorte da métrica podia contar um sucesso antigo como primeiro.**

- O expurgo apaga em lotes, sem `ORDER BY` e com `SKIP LOCKED`. Por isso, além dos 180 dias, uma autorização antiga pode continuar retida enquanto o primeiro sucesso dela já foi apagado.
- A coorte agora se limita às autorizações dentro da janela garantida de 179 dias, medida a partir de um instante de referência fixo `$3`. Eventos posteriores a `$3` também ficam fora.
- O texto do log foi corrigido: o `catch` que gera `auditoria não gravada` também cobre falhas de `marcarUso`. A contagem desse log é um limite superior da perda, não a perda exata.
- `AUTORIZACAO_CONCEDIDA` é gravada separadamente, com `await`, em `servico.ts`. Se essa gravação falha, a autorização termina em erro, sem esse log.
- O SQL continua não executado.

**P3: o roteiro não definia a ordem das corridas.** O passo 9 do §10 dizia para voltar ao pedido depois de trocar a empresa pelo menu. Isso foi corrigido: depois da troca, o painel descarta a página e o assistente precisa iniciar outro pedido. Os itens 1 e 2 do roteiro da rodada 15 foram substituídos pelos itens 1 e 2 abaixo.

Verificação local na candidata final, Node 22.23.2:

- 603/603 testes sem PostgreSQL, na primeira passada completa.
- `tsc`, ESLint nos arquivos alterados, `next build` e `git diff --check` (rastreados e novos): sem erros. `next-env.d.ts` restaurado.
- Chrome real com build de produção e API simulada: 28/28 (`ambientes-locais/prova-troca-empresa-20261107/prova-r16-consentimento.cjs`). O cenário novo em relação à r15 é o pedido sem `empresaId`, que resulta em "Não foi possível confirmar a sua sessão", nunca "mudou" nem "sem empresa", e sem Permitir.
- 54/54 mutantes mortos em cópia isolada (`mutantes-mcp-exp-r16.cjs`), com a base verde antes.
  - Mutantes novos: confirmação posterior sem reconferir a marca, pedido malformado mostrado como mudança, pedido malformado não tratado.
  - Na primeira passada, 1 mutante antigo ("POST cancelável na confirmação posterior") não aplicou, porque a variável foi renomeada. A âncora foi atualizada, e a segunda passada deu 54/54.

Não exercidos: banco real, sessão real, ChatGPT e Claude reais, e o SQL da métrica. As corridas foram reproduzidas com respostas sintéticas.

**Roteiro de staging, substitui os itens 1 e 2 da rodada 15.** Somente com dados sintéticos e somente com autorização própria da janela. Antes de começar, anote o instante T0 e o usuário e a empresa sintéticos.

1. **Consentimento e troca de empresa, separando a mesma aba de duas abas.**
   - **Mesma aba, durante a carga do pedido.** Trocar a empresa pelo menu da própria aba enquanto o pedido abre.
     - Esperado: um destes, conforme quem termina primeiro. Ou o painel descarta a página e vai ao Dashboard, ou aparece "A conta ou a empresa mudou enquanto o pedido abria". As duas saídas estão corretas.
     - Em nenhum caso deve aparecer o botão Permitir.
   - **Duas abas, durante a carga.** Abrir o pedido na aba A e, na aba B, trocar a empresa antes de a aba A terminar de carregar.
     - Esperado: "A conta ou a empresa mudou enquanto o pedido abria", ou o descarte da página. Sem Permitir.
   - **Duas abas, com o formulário já aberto.** Com o formulário aberto na aba A, trocar a empresa na aba B e só depois clicar Permitir na aba A.
     - Esperado: a aba A descarta a página, ou o servidor recusa por contexto ("Nada foi alterado").
   - **Conferência direta, em cada caso.** Não basta a mensagem na tela:
     - Voltar à empresa original e reabrir a mesma URL do pedido dentro do prazo dele. O formulário deve abrir de novo, o que prova que o pedido continua pendente e não foi consumido.
     - Na lista de conexões, nenhuma conexão nova depois de T0.
     - Com autorização de leitura do banco de staging: nenhuma linha em `mcp_oauth_concessoes` do usuário sintético criada depois de T0, e nenhuma `AUTORIZACAO_CONCEDIDA` desse usuário depois de T0 em `mcp_auditoria`.
2. **Escrita × troca de empresa, com a ordem controlada.** Usar uma escrita sintética do painel que deixe rastro conferível.
   - **Escrita antes da troca, na mesma aba.** Enviar a escrita, esperar a resposta e só então trocar a empresa.
     - Esperado: a escrita fica registrada na empresa original, e isso está CORRETO.
     - A troca segue normalmente, sem aviso de incerteza sobre a escrita.
   - **Troca antes da escrita, em duas abas.** Iniciar a troca na aba B e, com ela ainda pendente, enviar a escrita na aba A.
     - Esperado: nada é enviado, com a mensagem "A empresa ativa pode estar mudando. Nada foi enviado". Ou o servidor recusa por contexto.
     - Nenhum registro novo em nenhuma das duas empresas.
   - **Simultâneas, em duas abas, em várias tentativas.** Para cada tentativa, anotar a ordem observada pelos horários dos registros.
     - Esperado: toda escrita registrada tem a empresa da sessão vigente no instante em que foi recebida.
     - O aviso mostrado bate com o resultado real: "concluída" quando houve registro, "nada foi enviado" quando não houve, e "incerto" só com 5xx.

### Rodada 17 da experiência: 14º parecer do Astra (09/11/2026)

Parecer: **REPROVADO**, com 0 P1, 1 P2 e 3 P3. O Astra deu o pedido malformado como fechado. A confirmação posterior, a métrica e o roteiro ficaram parciais. Tudo foi tratado localmente, sem nova revisão.

**P2: o descarte navegava com a troca de empresa pendente.**

- Na confirmação posterior, uma troca desta página que começou depois da validação, ou uma leitura sem usuário que ficou obsoleta, não é mais decidida na hora.
  - O `adminFetch` espera a troca terminar. A espera tem o prazo de `ESPERA_DA_TROCA` e, na leitura, termina se o sinal for cancelado.
  - Depois, lê a sessão uma única vez. Na volta dessa releitura, confere a marca de novo, sem outro `await`.
- Troca aceita aparece como outra sessão ou empresa. A navegação acontece só depois da resposta da troca.
- Troca recusada (por exemplo, 403) deixa a sessão original confirmada. A leitura é entregue, sem navegação e sem aviso.
- Prazo vencido, cancelamento ou nova troca durante a releitura resultam em `falha`.
- Enquanto a troca desta página estiver pendente, a `falha` não navega.
  - Os dados não são entregues.
  - O resultado da escrita fica guardado no aviso (concluída sem contexto, incerto ou recusada) e no erro, com `enviado: true`.
  - A navegação é decidida pelo fluxo da troca.
- Testes antigos ajustados para a nova regra:
  - Troca pendurada com POST 200: sem navegação, com o aviso preservado.
  - Leitura cancelada na confirmação posterior com troca em curso: `AbortError`, sem navegação.
  - Em `lib/http/troca-sessao.test.ts`, as três escritas com troca durante a resposta passam a aceitar a troca logo em seguida, como no fluxo real. Elas continuam com "concluída antes da mudança", painel e um envio. Com isso, esse arquivo entra na seleção da PR.

**P3: o teste de corrida reentrava no próprio mock.**

- O disparo da troca agora é marcado antes de chamar `trocarEmpresaAtiva`.
- Cada posição exige exatamente um POST de troca, concluído com sucesso.
- As duas varreduras, leitura e escrita com k de 0 a 60, agora:
  - aceitam a troca no servidor;
  - registram cada navegação com o estado da troca;
  - exigem que nenhuma navegação aconteça com a troca pendente.
- Controle das varreduras: elas alcançam tanto "entregue" quanto `CONTEXTO_MUDOU`. Na escrita, o resultado barrado é "concluída antes da mudança", com `enviado: true`.
- Teste novo, com a resposta da troca retida:
  - nada navega antes de a troca responder;
  - se a troca é aceita (200), o resultado é `CONTEXTO_MUDOU`;
  - se é recusada (403), a leitura é entregue, sem navegação e sem aviso.

**P3: a janela da métrica podia incluir linhas expurgáveis.**

- O início da coorte agora vem do relógio do banco: `clock_timestamp() - interval '4272 hours'`, ou seja, 178 dias de 24 h.
- Horas absolutas não dependem do fuso. A margem de 2 dias cobre a hora do horário de verão no `interval '180 days'` do expurgo e um expurgo concorrente com a leitura.
- A leitura fixa `TimeZone = 'UTC'` e devolve `lido_em`.
- `$3` passou a ser só um limite superior e não promete reprodutibilidade: gravações atrasadas e expurgos podem mudar o resultado.
- O texto da autorização foi corrigido. Uma falha na gravação de `AUTORIZACAO_CONCEDIDA` acontece depois de o pedido ser consumido e de a concessão e o código serem gravados, e antes de devolver o redirecionamento.
- O SQL não foi executado.

**P3: a ordem das corridas entre abas.** Os itens 1 e 2 do roteiro da rodada 16 foram substituídos pelos itens abaixo.

- A ordem passa a ser definida pelo servidor: quando a sessão foi validada e quando a troca foi efetivada.
- Na carga, o descarte por contexto indeterminado é aceito.
- Na escrita, os resultados são separados em recusa, bloqueio antes do envio, resultado incerto e concluída.

Verificação local na candidata final, Node 22.23.2:

- 607/607 testes sem PostgreSQL.
- `tsc`, ESLint nos arquivos alterados, `next build` e `git diff --check` (rastreados e novos): sem erros. `next-env.d.ts` restaurado.
- Chrome real com build de produção e API simulada: 28/28 (`ambientes-locais/prova-troca-empresa-20261107/prova-r17-consentimento.cjs`), com os mesmos cenários da r16. O build e a prova foram feitos antes dos dois últimos testes, que só mexem em arquivo de teste.
- 60/60 mutantes mortos em cópia isolada (`mutantes-mcp-exp-r17.cjs`), com a base verde antes.
  - Mutantes novos:
    - confirmação posterior sem a releitura limitada;
    - releitura vira falha imediata;
    - releitura sem esperar a troca;
    - releitura obsoleta entregue;
    - obsoleta sem usuário não espera a troca;
    - falha navega com a troca pendente;
    - falha com troca pendente perde o aviso da escrita.
  - O mutante "confirmação posterior sem reconferir a marca" da r16 foi trocado por esses. A âncora do mutante da r12 foi atualizada.
  - A primeira passada deu 58/60. Sobreviveram:
    - "releitura obsoleta entregue". Nenhum teste fazia uma segunda troca começar na volta da releitura limitada.
    - "releitura obsoleta sem usuário vira mudança" (r15). Na confirmação posterior, o `adminFetch` agora trata `obsoleta` e `falha` com a mesma espera, então o teste antigo não distinguia mais os dois.
  - Testes novos para fechar os dois sobreviventes:
    - corrida com a segunda troca, k de 0 a 40, com controle;
    - releitura da confirmação PRÉVIA que cruzou outra troca sem usuário: "não confirmada", nada enviado, nunca "mudou".
  - Cada teste novo matou o seu mutante. A segunda passada completa deu 60/60.

Não exercidos: banco real, sessão real, ChatGPT e Claude reais e o SQL da métrica. As corridas foram reproduzidas com respostas sintéticas.

**Roteiro de staging: substitui os itens 1 e 2 da rodada 16.** Use somente dados sintéticos e somente com autorização própria da janela.

Antes de começar, anote:

- o instante T0;
- o usuário e as empresas sintéticas, A e B;
- em cada aba, as requisições pelo DevTools (Rede): `GET /api/admin/autenticacao`, o `POST` de troca e o `POST` de negócio, com o horário e o status de cada uma.

A ordem de cada tentativa é dada por dois instantes: quando a sessão da aba que escreve foi validada (resposta do `GET`) e quando a troca foi efetivada no servidor (resposta 200 do `POST` de troca). O momento do clique não define a ordem.

1. **Consentimento e troca de empresa.**
   - **Mesma aba, durante a carga do pedido.** Trocar a empresa pelo menu da própria aba enquanto o pedido abre.
     - Saídas corretas, conforme quem termina primeiro:
       - o painel descarta a página;
       - "A conta ou a empresa mudou enquanto o pedido abria";
       - "Não foi possível confirmar a sua sessão" (contexto indeterminado).
     - Em nenhum caso deve aparecer Permitir.
   - **Duas abas, durante a carga.** Abrir o pedido na aba A e trocar a empresa na aba B.
     - Se a troca foi efetivada antes de a aba A validar a sessão: "mudou", contexto indeterminado ou descarte da página.
     - Se foi efetivada depois: o formulário pode abrir para a empresa original, e isso está correto. Siga para o caso seguinte.
   - **Formulário aberto e troca efetivada na aba B; depois, Permitir na aba A.**
     - Esperado: o servidor recusa por contexto ("Nada foi alterado"), ou a aba A é descartada antes.
   - **Conferência direta, em cada caso.**
     - Voltar à empresa original e reabrir a mesma URL do pedido dentro do prazo. O formulário abre de novo, ou seja, o pedido continua pendente.
     - Nenhuma conexão nova depois de T0 na lista de conexões.
     - Com autorização de leitura do banco de staging, nada depois de T0 para o usuário sintético:
       - nenhuma linha em `mcp_oauth_concessoes`;
       - nenhuma `AUTORIZACAO_CONCEDIDA` em `mcp_auditoria`.
2. **Escrita e troca de empresa, classificando cada tentativa.** Use uma escrita sintética do painel que deixe um registro conferível.
   - **Mesma aba, escrita antes da troca.** Esperar a resposta da escrita e só então trocar.
     - O registro na empresa original está correto.
     - Nenhum aviso de incerteza.
   - **Mesma aba, troca pendente.** Com a rede lenta no DevTools, trocar e, com o `POST` de troca ainda pendente, disparar a escrita.
     - **Bloqueio antes do envio:** "Nada foi enviado". Nenhum `POST` de negócio na Rede e nenhum registro.
     - Se a escrita já tinha saído antes da troca, a página só navega depois da resposta da troca, e o aviso traz o resultado conhecido dela.
   - **Duas abas.** Disparar a escrita na aba A e a troca na aba B, em várias tentativas.
     - Escrita recebida pelo servidor **antes** da efetivação da troca: o registro na empresa original é VÁLIDO, porque a aba A não sabe da troca pendente na aba B.
     - Escrita recebida **depois** da efetivação:
       - **recusa** pelo contexto, "Nada foi alterado", sem registro;
       - ou **bloqueio antes do envio**, se a aba A já soube da troca.
     - **Resultado incerto** só com falha de transporte ou 5xx: conferir o registro antes de repetir. Nada é reenviado sozinho.
   - **Critério.** Em toda tentativa, o aviso mostrado bate com o registro real:
     - concluída: o registro existe;
     - recusa ou bloqueio: o registro não existe;
     - incerto: confere-se o registro.

### Rodada 18 da experiência: 15º parecer do Astra (09/11/2026)

Parecer: **REPROVADO**, com 0 P1, 1 P2 e 2 P3. O Astra deu como fechados a reentrada do teste e a métrica (esta por leitura; o SQL não foi executado). Ficaram parciais o descarte durante a troca e o roteiro. Tudo foi tratado localmente, sem nova revisão.

**P2: ainda havia ramos que navegavam com a troca desta página pendente.**

- **Um só ponto de descarte.** Todo descarte com navegação do `adminFetch` passa por `descartarPagina`. Com a troca desta página pendente:
  - nada navega;
  - a escrita guarda o aviso do resultado conhecido;
  - a navegação fica com o fluxo da troca.
- **Ramos cobertos:**
  - recusa 409 `AUTENTICACAO_ADMINISTRATIVA`;
  - `falha` da confirmação posterior;
  - "mudou" e "encerrada" da confirmação posterior;
  - ida ao login na confirmação prévia, por `assign`.
- O helper global de contexto (`lib/http/contexto-empresa-cliente.ts`) não mudou.
- **"Encerrada" agora leva a marca.** A confirmação sem usuário devolve a marca que a classificou, e quem retoma o `await` confere essa marca de novo.
  - **Na prévia:** se a marca deixou de valer, a resposta é tratada como da sessão anterior. Nada é enviado e nada vai ao login.
  - **Na posterior:** `cruzouTroca` trata `obsoleta`, `valida` e `encerrada` da mesma forma. O `adminFetch` espera a troca terminar, relê uma vez e confere de novo na volta.

Testes novos em `admin-fetch-tipo.test.ts`, a partir das reproduções do revisor e com as asserções do comportamento desejado. `replace` e `assign` registram se havia troca pendente.

- **409 com a troca retida, em POST e em GET:**
  - `RECUSADA_PELO_CONTEXTO`, com `enviado: true`;
  - nenhuma navegação;
  - o POST guarda "Nada foi alterado"; o GET não guarda aviso.
- **"Encerrada" na volta do `await`, na prévia e na posterior, com k de 0 a 12:**
  - nunca vai ao login com a troca pendente;
  - controle: a varredura alcança tanto o fim real da sessão (vai ao login sem troca pendente) quanto o cruzamento (nada navega).
- **Cruzamento com `trocarEmpresaAtiva` real e o POST da troca retido:**
  - nada navega;
  - quando a troca termina, a releitura confirma a mesma sessão e a leitura é entregue.

Os 5 testes falham na candidata da rodada 17 e passam na da rodada 18.

**P3: o teste de prazo dependia de chegar à asserção em menos de 20 ms.** "Desconectar durante leitura pendurada" (`components/admin/conexoes-leitura.test.ts`) agora usa o relógio controlado do `node:test`, só com `setTimeout`. A fila é conferida em três pontos:

- antes do prazo: `GET` e `POST`;
- aos 19 ms: a leitura ainda não foi abortada;
- aos 20 ms: a leitura foi abortada e a releitura aconteceu.

**P3: o roteiro equiparava a resposta HTTP ao instante interno de validação ou de commit.** Os itens 1 e 2 do roteiro da rodada 17 foram substituídos pelos itens abaixo.

- Os cenários sequenciais esperam a resposta da troca antes da operação seguinte.
- Requisições sobrepostas têm a ordem classificada como INDETERMINADA pelo DevTools. O que se confere é a coerência entre o aviso, o registro e o contexto.
- Provar a ordem interna exige instrumentação sintética com IDs e marcos de validação e commit. Isso fica como proposta para uma janela autorizada à parte.

Verificação local na candidata final, Node 22.23.2:

- Testes sem PostgreSQL (60 arquivos): 612/612 com `--test-concurrency=1` e 612/612 em paralelo. O teste de prazo não depende mais da carga.
- `tsc`, ESLint nos arquivos alterados, `next build` e `git diff --check` (rastreados e novos): sem erros. `next-env.d.ts` restaurado.
- Chrome com o build de produção (`prova-r18-consentimento.cjs`, fora do repositório): 28/28.
- Mutantes na cópia isolada (`mutantes-mcp-exp-r18.cjs`): 64/64 na 2ª passada.
  - A 1ª passada deu 62/67.
    - A âncora de "sinal fora da confirmação prévia" estava velha (`lidaPrevia`) e foi corrigida.
    - "Prévia encerrada cruzada não vira obsoleta" sobreviveu: o teste aceitava `SESSAO_ENCERRADA` sem login como saída cruzada. Agora ele exige exatamente o login no fim real da sessão e `CONTEXTO_MUDOU` (prévia) ou `SESSAO_NAO_CONFIRMADA` (posterior) no cruzamento.
  - 3 mutantes equivalentes foram retirados:
    - a guarda do login da prévia;
    - o descarte de "mudou"/"encerrada" da posterior;
    - a marca da "encerrada" relida no mesmo tique.
  - Os dois primeiros são equivalentes porque troca pendente implica marca obsoleta (`sessaoObsoletaDesde` = `durante || geracao`). Por isso, esses ramos só são alcançados sem troca pendente; as guardas ficam como defesa em profundidade. No terceiro, a marca relida é idêntica.

Não exercidos: banco real, sessão real, ChatGPT e Claude reais, SQL da métrica e homologação. As corridas foram reproduzidas com respostas sintéticas.

**Roteiro de staging: substitui os itens 1 e 2 da rodada 17.** Somente com dados sintéticos e com autorização própria da janela.

Antes de começar, anote o instante T0, o usuário e as empresas sintéticas A e B. Abra o DevTools (Rede) em cada aba.

- O DevTools mostra o percurso das requisições, não o instante em que o servidor validou a sessão ou fez o commit da troca.
- Uma resposta pode chegar depois de outra que foi decidida depois dela.
- Por isso, a ordem só é afirmada nos cenários sequenciais. Nos sobrepostos, ela é indeterminada.

1. **Consentimento e troca de empresa.**
   - **Sequencial, troca antes do pedido.** Trocar a empresa no menu, esperar a resposta da troca e a navegação ao painel, e só então abrir o pedido.
     - Esperado: o pedido abre para a empresa nova.
   - **Sequencial, pedido antes da troca.** Abrir o pedido, esperar o formulário completo e então trocar a empresa no menu, na mesma aba ou em outra. Esperar a resposta da troca e só depois clicar Permitir na aba do pedido.
     - Esperado: a aba do pedido é descartada, ou o servidor recusa por contexto ("Nada foi alterado").
     - Nunca há uma concessão criada para a empresa antiga.
   - **Sobreposto: troca durante a carga do pedido**, na mesma aba ou em duas.
     - A ordem é INDETERMINADA.
     - Saídas aceitas:
       - descarte da página;
       - "A conta ou a empresa mudou enquanto o pedido abria";
       - "Não foi possível confirmar a sua sessão", que é contexto indeterminado;
       - o formulário aberto para a empresa original, se o servidor validou antes da troca. Nesse caso, siga o cenário sequencial anterior a partir do Permitir.
     - Em nenhum caso o Permitir pode criar uma concessão depois de a troca ter sido respondida.
   - **Conferência direta, em cada caso.**
     - Voltar à empresa original e reabrir a mesma URL do pedido dentro do prazo. O formulário abre de novo, o que mostra que o pedido continua pendente.
     - Na lista de conexões, nenhuma conexão nova depois de T0.
     - Com autorização de leitura do banco de staging:
       - nenhuma linha em `mcp_oauth_concessoes` do usuário sintético depois de T0;
       - nenhuma `AUTORIZACAO_CONCEDIDA` desse usuário depois de T0.
2. **Escrita e troca de empresa.** Usar uma escrita sintética do painel que deixe um registro conferível.
   - **Sequencial, escrita antes da troca.** Esperar a resposta da escrita e só então trocar.
     - Esperado: o registro na empresa original existe e está correto.
     - Nenhum aviso de incerteza.
   - **Sequencial, troca antes da escrita.** Esperar a resposta da troca e a navegação, e só então escrever.
     - Esperado: o registro fica na empresa nova.
   - **Sobreposto, mesma aba.** Com a rede lenta no DevTools, trocar a empresa e, com o POST de troca ainda pendente, disparar a escrita.
     - Esperado: bloqueio antes do envio ("Nada foi enviado"), sem POST de negócio na Rede e sem registro.
     - Se a escrita já tinha saído, a página não navega antes da resposta da troca, e o aviso traz o resultado conhecido da escrita.
   - **Sobreposto, duas abas, em várias tentativas.** A ordem é INDETERMINADA pelo DevTools. Uma escrita pode chegar antes da troca e ainda esperar uma trava, e ser recusada depois.
     - Classifique cada tentativa pelo resultado e confira contra o registro:
       - **concluída:** o registro existe, na empresa da sessão que o servidor aceitou;
       - **recusa pelo contexto:** "Nada foi alterado", e o registro não existe;
       - **bloqueio antes do envio:** "Nada foi enviado", sem POST de negócio na Rede e sem registro;
       - **incerto:** só com falha de transporte ou 5xx. Confira o registro antes de repetir; nada é reenviado sozinho.
     - Uma divergência entre o aviso e o registro é falha. Uma ordem inesperada, sozinha, não é.
3. **Ordem interna, só se for preciso prová-la (PROPOSTA, não executada).** Preparar instrumentação sintética para uma janela autorizada à parte:
   - um ID por requisição;
   - marcos no servidor para "sessão validada", "troca confirmada (commit)" e "escrita confirmada", com o relógio do servidor;
   - comparar as tentativas sobrepostas por esses marcos, não pelo DevTools.

### Rodada 19 da experiência: 16º parecer do Astra (09/11/2026)

Parecer: **REPROVADO**, com 0 P1, 2 P2 e 0 P3. O Astra fechou dois pontos do 15º parecer: o teste de prazo e o roteiro (este por leitura). Concordou com a equivalência dos três mutantes da rodada 18. Tudo foi tratado localmente, sem nova revisão.

**P2-1: o registro do contexto navegava antes da guarda da marca.**

Cenário:
- uma renovação de sessão em outra aba faz a confirmação prévia ler s2, enquanto a página ainda tem s1;
- uma troca desta página começa entre a validação dessa confirmação e a retomada do `adminFetch`;
- `registrarContextoEmpresa(s2)` então descartava a página com a troca pendente.

Correção (`lib/http/admin-fetch.ts`):
- A marca da confirmação prévia agora é conferida antes do registro, com `cruzouTroca(previa)`. Com a marca vencida, nada é enviado e nada navega, e a troca decide.
- A conferência imediatamente anterior ao envio continua como defesa. As duas usam o mesmo erro, `erroDaTrocaAntesDoEnvio`.
- O helper global de contexto não mudou.

Testes novos em `admin-fetch-tipo.test.ts`, a partir das reproduções do revisor:
- **Sessão renovada mais troca entre a validação e a retomada (k de 0 a 12):**
  - nenhuma navegação com a troca pendente e nenhum POST de negócio;
  - controle: as duas saídas são exercidas. Sem a correção, os 3 testes falham.
    - Recusa antes do envio, sem navegar.
    - Descarte pelo registro, sem troca pendente.
- **Mesma janela com `trocarEmpresaAtiva` real retida, aceita (200) e recusada (403):** nada navega com a troca pendente, nem durante a retenção nem depois de liberá-la.

**P2-2: o consentimento voltava ao assistente durante a troca.**

Depois do `adminFetch`, a tela ainda lia o corpo e navegava sem conferir a troca.

Correção (`components/admin/ConsentimentoAssistente.tsx`, nova função `enviarDecisao`):
- A marca da sessão é tirada na retomada do `adminFetch`, sem `await` no meio, e conferida de novo depois da leitura do corpo, imediatamente antes da navegação.
- Se uma troca desta página começou nesse intervalo:
  - a página não navega;
  - o resultado conhecido fica guardado (`AVISO_AUTORIZACAO_NA_TROCA`, origem escrita: a autorização foi concluída e a pessoa deve conferir a conexão no assistente);
  - a tela mostra "A autorização foi concluída…" (`RetornoNaTroca`) e espera a troca terminar.
- Se a troca for aceita, quem navega ao painel é o menu da conta.
- Se for recusada, a tela oferece "Voltar ao assistente" por clique. Nunca há volta automática depois de cruzar a troca.
- O POST do consentimento é feito uma única vez e nunca é repetido.

Testes novos em `consentimento-mcp-ui.test.ts`, com o `adminFetch`, o `trocarEmpresaAtiva` e o contexto reais:
- **Corpo retido mais troca real retida, aceita e recusada:**
  - não navega com a troca pendente, nem depois dela;
  - a tela recebe a promessa do fim da troca em curso;
  - um único POST de consentimento;
  - o aviso guardado é o da autorização concluída.
- **Controle sem troca:** volta ao assistente uma vez e não guarda aviso.
- **Troca já em curso na retomada do `adminFetch`:** também segura a volta.
- **Tela:** o link "Voltar ao assistente" só aparece depois da troca.

Sem a guarda, os 3 testes de cruzamento falham.

**Executor de mutantes.** Cada MORTO agora lista os testes que falharam, o que mostra qual oráculo matou o mutante. Isso responde à observação do revisor de que qualquer saída diferente de zero contava como morte.

**Roteiro de staging: complementa o item 1 da rodada 18.** Somente com dados sintéticos e com autorização própria da janela.

- **Permitir e troca sobrepostos**, com o menu da conta usado logo depois de clicar Permitir e a rede lenta no DevTools. A ordem é INDETERMINADA. Saídas aceitas:
  - a volta ao assistente, se a troca começou depois dela;
  - a tela "A autorização foi concluída…", sem voltar sozinha.
    - Troca aceita: o painel abre com o aviso da autorização concluída.
    - Troca recusada: a tela oferece "Voltar ao assistente".
- **Em todos os casos:**
  - um único POST de consentimento na Rede;
  - no máximo uma concessão nova depois de T0, na empresa da sessão que o servidor aceitou no Permitir;
  - a conexão aparece no assistente ou pode ser iniciada de novo.

Verificação local na candidata final, Node 22.23.2:

- Testes sem PostgreSQL (60 arquivos): 620/620 com `--test-concurrency=1` e 620/620 em paralelo.
- `tsc`, ESLint nos arquivos alterados, `next build` e `git diff --check` (rastreados e novos): sem erros. `next-env.d.ts` restaurado.
- Chrome com o build de produção (`prova-r19-consentimento.cjs`, fora do repositório): 28/28.
- Mutantes na cópia isolada (`mutantes-mcp-exp-r19.cjs`): 70/70. Cada morte traz o nome do teste que falhou; nenhuma veio só do código de saída.
  - A 1ª passada deu 70/71. O sobrevivente, o r15 "envio sem conferir a marca", virou equivalente: a guarda nova antes do registro recusa a mesma marca, e não há `await` entre ela e o envio. Ele foi retirado, e a conferência continua como defesa.
  - Mutantes novos da r19:
    - registro sem conferir a marca;
    - registro conferindo só a "encerrada";
    - consentimento sem a guarda;
    - sem o aviso guardado;
    - tela sem a espera da troca;
    - "Voltar ao assistente" oferecido antes do fim da troca;
    - consentimento sem troca que não navega.

Não exercidos: banco real, sessão real, ChatGPT e Claude reais, SQL da métrica e homologação. As corridas foram reproduzidas com respostas sintéticas. A seleção da PR continua com 30 arquivos.

### Rodada 20 da experiência: 17º parecer do Astra (09/11/2026)

Parecer: **APROVADO COM RESSALVAS**, com 0 P1, 0 P2 e 3 P3. Os dois P2 do 16º parecer foram dados como fechados. As 3 ressalvas foram tratadas localmente, sem nova revisão.

**P3-1: "Não permitir" recebia a mensagem de autorização concluída.**

Correção (`components/admin/ConsentimentoAssistente.tsx`):
- `enviarDecisao` recebe a decisão (`PERMITIR` ou `NEGAR`) e a devolve no resultado `troca`.
- Com troca no meio, a recusa guarda `AVISO_RECUSA_NA_TROCA`: o pedido foi recusado, nenhuma conexão foi criada e, para conectar depois, basta iniciar uma conexão nova pelo assistente. O aviso de autorização concluída fica só para `PERMITIR`.
- `RetornoNaTroca` recebe a decisão e diz "O pedido foi recusado e nenhuma conexão foi criada…" para a recusa.

**P3-2: o retorno retido podia expirar sem orientação na tela.**

O código de autorização vale 60 s (`lib/integracoes/mcp/config.ts`). Nada disso mudou: o prazo não foi ampliado, o POST não é repetido e a tela não cita prazo numérico.
- `RetornoNaTroca` ganhou uma linha fixa (`data-retorno-expirado`), visível antes e depois do fim da troca:
  - Permitir: o retorno vale por pouco tempo; se falhar ou a conexão não aparecer, iniciar uma conexão nova pelo assistente, porque este pedido já foi respondido.
  - Não permitir: se o retorno falhar, basta fechar a página, nada foi conectado.

Testes em `consentimento-mcp-ui.test.ts`:
- o cruzamento com troca real retida roda para as 4 combinações (Permitir e Não permitir; troca aceita e recusada), conferindo a decisão transportada e o aviso de cada uma; a recusa não pode conter "autorização do assistente foi concluída" nem "confira a conexão";
- teste novo da tela: "recusado" para Não permitir, orientação do retorno que falhar nas duas decisões e nos dois estados da espera, e nenhum prazo em segundos ou minutos.

**P3-3: o executor contava timeout como mutante morto.**

Novo executor (`mutantes-mcp-exp-r20.cjs`, fora do repositório, gerado por `gerar-mutantes-r20.cjs`), com classificação estrita:
- **MORTO** só com término normal (status numérico, sem sinal, timeout ou erro de spawn), ao menos um teste nomeado falhando (não só o arquivo) e, quando o mutante declara o oráculo esperado, um teste com esse nome entre as falhas;
- **SOBREVIVEU**: término normal com código 0 e nenhum "not ok";
- **INCONCLUSIVO**: todo o resto (timeout, sinal, spawn, falha só de arquivo, falha fora do oráculo esperado);
- saída integral (stdout e stderr) de cada mutante em `mutantes-mcp-exp-r20-logs/NN.txt`;
- código de saída diferente de zero se algum mutante não for MORTO;
- `--autoteste` do classificador com casos sintéticos (timeout, sinal, status nulo, falha só de arquivo, oráculo ausente, nome de teste com "/"): 11/11.

Na 1ª passada, 4 mutantes saíram INCONCLUSIVO por erro do próprio classificador: ele tratava como arquivo qualquer nome com "/", e os testes "16º/17º parecer: …" têm a barra. Os logs mostravam que os 4 falharam pelos testes esperados. A detecção passou a aceitar só caminho absoluto ou nome terminado em `.test.ts`, com caso novo no autoteste, e a corrida foi refeita inteira.

**Roteiro de staging: complementa o item da rodada 19.** Somente com dados sintéticos e com autorização própria da janela.
- **Não permitir e troca sobrepostos**, mesma montagem do Permitir. Saídas aceitas:
  - a volta ao assistente com a recusa, se a troca começou depois dela;
  - a tela "O pedido foi recusado e nenhuma conexão foi criada…", sem voltar sozinha; troca aceita: o painel abre com o aviso da recusa; troca recusada: "Voltar ao assistente" por clique.
- **Em todos os casos:** um único POST de consentimento e nenhuma concessão nova depois de T0.
- **Retorno expirado (Permitir):** esperar mais de um minuto na tela retida antes de clicar "Voltar ao assistente". O assistente deve recusar o código vencido; a pessoa segue a orientação da tela e inicia uma conexão nova, sem erro no painel.

Verificação local na candidata final, Node 22.23.2:

- Testes sem PostgreSQL (60 arquivos): 623/623 com `--test-concurrency=1` e 623/623 em paralelo.
- `tsc`, ESLint nos arquivos alterados, `next build` e `git diff --check` (rastreados e novos): sem erros. `next-env.d.ts` restaurado.
- Chrome com o build de produção (`prova-r20-consentimento.cjs`, fora do repositório): 28/28.
- Mutantes na cópia isolada (`mutantes-mcp-exp-r20.cjs`): 75/75, todos MORTOS por teste nomeado; 12 deles com o oráculo esperado declarado, e os 12 morreram por ele. 0 inconclusivos e 0 não aplicados.
  - Mutantes novos da r20:
    - Não permitir guardando o aviso de autorização concluída;
    - decisão não transportada para a tela;
    - tela ignorando a decisão;
    - tela sem a orientação do retorno expirado;
    - recusa sem a orientação de retorno.

Não exercidos: banco real, sessão real, ChatGPT e Claude reais, código expirado de verdade, SQL da métrica e homologação. A seleção da PR continua com 30 arquivos.

### Rodada 21 da experiência: 18º parecer do Astra (10/11/2026)

Parecer: **APROVADO COM RESSALVAS**, com 0 P1, 0 P2 e 1 P3. As duas ressalvas de interface da rodada 20 foram fechadas. A ressalva restante, no executor de mutantes, foi tratada localmente, sem nova revisão.

**P3: timeout interno e cancelamento de teste ainda contavam como MORTO.**

O executor da r20 lia só a linha "not ok". O Node marca com "not ok" também o teste que estoura o próprio timeout (`testTimeoutFailure`) e os cancelados quando o laço de eventos esvazia (`cancelledByParent`). O revisor achou um caso real: o mutante r14 "espera da troca sem prazo" saía com 0 falhas e 22 cancelamentos, e mesmo assim contava como MORTO.

Correção do executor (`mutantes-mcp-exp-r21.cjs`, fora do repositório, gerado por `gerar-mutantes-r21.cjs`; os arquivos da r20 ficaram intactos como evidência):
- cada "not ok" é lido com o seu bloco de diagnóstico TAP, no mesmo recuo;
- só `failureType: 'testCodeFailure'` é falha efetiva. Timeout interno, cancelamento, falha de hook, "not ok" sem diagnóstico e falha só de arquivo dão INCONCLUSIVO;
- MORTO exige ainda o resumo `# fail` positivo e, quando o mutante declara o oráculo, uma falha efetiva nele. Cancelamento com o nome do oráculo não basta;
- autoteste com 19 casos (timeout interno, cancelamento em cascata, oráculo só cancelado, hook, subteste recuado, diagnóstico do subteste que não vale para o pai, resumo sem falha, CRLF): 19/19;
- controles com saídas reais do Node 22.23.2 (`ambientes-locais/controles-classificador-r21`): timeout interno e cancelamento saem INCONCLUSIVO, e a falha por asserção sai MORTO. Resultado: 3/3.

Correção dos testes (`lib/http/admin-fetch-tipo.test.ts`): sem o prazo da espera, os dois testes do prazo ficavam pendurados e o Node os cancelava. Isso não provava nada. Agora eles correm contra um relógio de guarda (`dentroDe`, 2 s), que mantém o laço vivo e transforma a espera interminável numa asserção que falha. O mutante r14 ganhou o oráculo desses dois testes.

Verificação local na candidata final, Node 22.23.2:

- Testes sem PostgreSQL (60 arquivos): 623/623 com `--test-concurrency=1` e 623/623 em paralelo, 0 cancelados.
- `tsc`, ESLint nos arquivos alterados e `git diff --check` (rastreados e novos): sem erros. Só mudou um arquivo de teste, então `next build` e a prova no Chrome não foram refeitos (28/28 na r20).
- Mutantes na cópia isolada (`mutantes-mcp-exp-r21.cjs`): 75/75 MORTOS, todos por falha efetiva; 0 inconclusivos e 0 não aplicados. Os 13 com oráculo declarado morreram por ele. O r14 agora morre pelos dois testes do prazo; os 5 cancelamentos que sobram ficam registrados como não efetivos.

Não exercidos: banco real, sessão real, ChatGPT e Claude reais, código expirado de verdade, SQL da métrica e homologação. A seleção da PR continua com 30 arquivos.
