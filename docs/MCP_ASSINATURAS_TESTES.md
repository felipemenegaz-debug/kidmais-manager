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
