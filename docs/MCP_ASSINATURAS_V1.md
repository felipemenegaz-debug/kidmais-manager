# Canal MCP por assinatura — v1 (implementação LOCAL)

> **ESTADO ATUAL (28/10/2026, vale sobre os blocos datados abaixo, que são histórico):**
> - **Staging:** código do canal LIVE (até a #261, `a18677cb`); migration **105 APLICADA** (integridade PASS); canal
>   ligado só para a empresa de teste (`MCP_TENANT_ALLOWLIST`).
> - **Conexão real:** ChatGPT e Claude conectados de verdade por CIMD; 4 perguntas-roteiro, Desconectar e renovação depois
>   de 1 h aprovados (§20). Ressalvas da revisão do Astra de 28/10: isolamento e "zero dados pessoais" só com a base vazia;
>   a recusa da empresa fora do piloto foi vista na tela, mas o POST 403 real não foi feito.
> - **Revisão do Astra de 28/10:** "resultado de staging aprovado; produção pode ser planejada". **Não é GO para
>   produção.**
> - **Produção:** nada aplicado nem ligado. Pede aplicador 105 próprio + PITR, candidata validada no Node 22.23.2, env
>   própria, monitoramento/desligamento e as decisões D3/RET-1/D-EXP (lista em §21).

> **Estado em 27/10/2026 (rodada 2):** P0–P3 implementadas **localmente**, sem commit nem push. 1ª revisão independente
> (Astra) **REPROVOU** para exposição externa (2 P1, 6 P2, 2 P3); todos os 10 achados foram corrigidos localmente na rodada 2
> (§14) e **aguardam nova revisão**.
> Testes offline e de protocolo em loopback aprovados (ver [MCP_ASSINATURAS_TESTES.md](MCP_ASSINATURAS_TESTES.md)).
> Migration 105 **preparada e NÃO aplicada**; suíte PostgreSQL **preparada e NÃO executada**; nenhuma conexão real com
> ChatGPT/Claude/Gemini; nada publicado. **Não está pronto para produção.**
> Plano de referência: [MCP_ASSINATURAS_PLANO_V1.txt](MCP_ASSINATURAS_PLANO_V1.txt) (cópia com hash do original).

## 1. Base e isolamento

| Item | Valor |
|---|---|
| Checkout | `D:/glass/KidMais Manager/kidmais-manager-mcp-assinaturas-20261027` (clone LF próprio, `core.autocrlf=false`) |
| Branch | `codex/mcp-assinaturas-v1` (local, sem commit) |
| Base adotada | `origin/staging` = `eb1af4262b8c18261626354541107f112d5e5e73` (igual à referência do plano; fetch de 27/10) |
| Diferença para a referência | nenhuma no commit; o checkout B14 de referência tem alterações locais alheias, não usadas nem tocadas |
| Migration | `105` — 098–103 tomadas (101 em clone local). Conferido em todos os clones e nas 251 branches remotas. **Número local não é reserva.** |

## 2. Inventário e mapa de reuso (P0)

| Necessidade | Reuso (sem cópia) | Observação |
|---|---|---|
| Agenda hoje/amanhã | `agendaDoTenant` (fonte de `agenda_do_dia`) + mesmas regras de `montarAgenda` | Fonte só tem escopo de EMPRESA ⇒ saída declara `escopo: "EMPRESA"`; sem filtro de unidade |
| Recebíveis | `listarRecebiveis` (fonte de `analisar_recebiveis`) + mesmas faixas | Paridade provada por teste contra `montarAnaliseRecebiveis` |
| Política | `decidirPolitica` (Policy V1) com o **manifesto canônico** de `agenda_do_dia`/`analisar_recebiveis` | Papel global antes; papel da MEMBERSHIP dentro do tenant |
| Flags | `grupoAtivo` / `grupoAtivoParaEmpresa` (`lib/inteligencia/flags.ts`) | Chave-mestra + READ + allowlist da IA continuam obrigatórias |
| Tenant | `withTenantTransaction` → `provarTenant` + `revalidarTenant` | Principal OAuth vira `SessaoParaTenant` **sem** `id` de sessão (não fabrica sessão UI) |
| Prazo | `comPrazo` do gateway, limitado ao manifesto (≤ 5 s) | |
| Minimização | `chaveProibida` do Tool Registry (exportada) + schema zod estrito por DTO | Lista positiva, não remoção de campos |
| Plano/assinatura | `lerEstadoComercial` + `decidirPaywall(…, "GET", …)` | BLOQUEADO recusa; SOMENTE_LEITURA lê |
| Canais | `lib/inteligencia/canais.ts` **não** alterado | O canal MCP não passa pela orquestração conversacional |

**Não usados de propósito:** `atenderConversa`, `executarLeitura` (rastreio fixa origem UI e passa pelo texto com nomes),
Model Router, JEV, planejador, Demerzel, Luna, skills, copiloto, agentes. Provado estaticamente em
`lib/integracoes/mcp/mcp-arquitetura.test.ts` (grafo de imports de valor).

## 3. Arquitetura

```
ChatGPT / Claude ─► POST /api/mcp (Streamable HTTP, stateless, SDK oficial v2)
                     │ 1. MCP_ENABLED (antes de autenticar/abrir banco) · POST só · Origin · 64 KiB · JSON
                     │ 2. Bearer kma_… → SHA-256 → mcp_oauth_tokens ⋈ concessão ativa ⋈ usuário ativo (senha não trocada)
                     │ 3. audience: concessão.recurso = MCP_PUBLIC_URL atual
                     │ 4. limite por concessão/empresa (em processo)
                     ▼
            executarFerramentaMcp(nome, args, principal)
              canal → escopo → flags IA → Policy(papel global) → provarTenant(empresa da concessão)
              → allowlist MCP → allowlist IA → Policy(papel da membership) → concessão FOR SHARE → paywall leitura
              → serviço de domínio (prazo) → DTO lista positiva → schema estrito + chaves proibidas → auditoria
```

- **Stateless:** um `McpServer` por pedido (`createMcpHandler`, `legacy: "stateless"`, `responseMode: "json"`). Não há
  `Mcp-Session-Id`; GET/DELETE ⇒ 405. Sessão MCP nunca é identidade.
- **Servidor só declara `tools`.** Nunca pede `sampling`/`elicitation` ao cliente (nenhuma inferência sai do KidMais).
- **Erros de ferramenta** voltam como `isError: true` sem `structuredContent`; escopo insuficiente traz
  `_meta["mcp/www_authenticate"]` (formato documentado pela OpenAI).

## 4. Ferramentas (contrato externo v1)

| Nome | Escopo | Entrada (estrita) | Saída (`structuredContent`) |
|---|---|---|---|
| `kidmais_consultar_agenda` | `agenda:read` | `{ dia?: "hoje" \| "amanha" }` | `kidmais.mcp.agenda.v1`: horários, situação (assinado/pendente), totais, `truncado`, `limiteFonte: 50`, `escopo: "EMPRESA"` |
| `kidmais_consultar_recebiveis_resumo` | `financeiro:read` | `{}` | `kidmais.mcp.recebiveis.v1`: em aberto, vencidos (3 faixas), a vencer, 7 dias — centavos BRL, `posicao: "ATUAL"` |
| `kidmais_buscar_conhecimento` | `conhecimento:read` | `{ consulta: 2..500, limite?: 1..10 (5) }` | `kidmais.mcp.conhecimento.busca.v1`: referência opaca, título, seção, trecho ≤ 300, versão, vigência, `semEvidencia` |
| `kidmais_obter_trecho` | `conhecimento:read` | `{ referencia }` | `kidmais.mcp.conhecimento.trecho.v1`: `encontrado`, trecho ≤ 1200 ou nulo |

Sem nomes, contatos, aniversariantes, ids de festa/cliente, parcelas individuais, dados de crianças. Anotações
`readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`. Não há ferramenta de escrita, SQL ou shell;
nome adivinhado ⇒ erro de protocolo `-32602` ("not found").

## 5. OAuth 2.1 (P2)

| Ponto | Decisão |
|---|---|
| Biblioteca | `@node-oauth/oauth2-server@5.3.0` (MIT, fixada; 5.3.1 tinha 14 dias) — authorization_code + PKCE S256 + refresh rotativo; o modelo é nosso (PostgreSQL) |
| Registro do cliente | **CIMD** (`client_id` = URL HTTPS do documento). ChatGPT: preferido. Claude: usado quando o AS anuncia `client_id_metadata_document_supported: true` **e** `none` em `token_endpoint_auth_methods_supported` — ambos anunciados. **DCR não oferecido** (sem `registration_endpoint`): cliente sem CIMD recebe erro claro, nunca fallback. Credenciais pré-registradas/Anthropic-held: não implementadas |
| Hosts CIMD | `MCP_CIMD_HOSTS` (padrão `chatgpt.com,claude.ai`). Outro host nem é buscado |
| SSRF | só HTTPS, porta padrão, sem query/fragmento/credencial; DNS resolvido e TODOS os endereços conferidos (privado, loopback, link-local, CGNAT, multicast, reservado, mapeado); conexão fixada no IP conferido; sem redirect; 5 s; 32 KiB |
| Redirect | igualdade EXATA com o documento CIMD; só HTTPS. Loopback (Claude Code) fora do piloto |
| PKCE | `code_challenge` + `S256` obrigatórios no authorize; verifier 43–128 no token; `plain` recusado |
| `resource` (RFC 8707) | obrigatório no authorize e igual a `MCP_PUBLIC_URL`; no token, se presente, igual. Gravado na concessão = audience |
| `iss` (RFC 9207) | em toda resposta de autorização (sucesso e erro); `authorization_response_iss_parameter_supported: true` |
| Escopos | `agenda:read`, `financeiro:read`, `conhecimento:read`. Ausente ⇒ todos pedidos (a pessoa desmarca). Refresh não amplia |
| Tokens | opacos de 256 bits (`kma_`, `kmr_`, `kmc_`, `kmp_`), só SHA-256 no banco. Acesso 1 h, refresh 30 dias, código 60 s, pedido 10 min. **Escopo efetivo gravado POR TOKEN** (refresh pode reduzir; a autenticação usa o escopo do token, nunca o da concessão; ampliar é recusado na gravação) |
| Código | uso único atômico; a biblioteca **consome antes do PKCE** (verifier errado queima o código); reapresentação ⇒ revoga a concessão inteira |
| Refresh | rotação atômica; token girado reapresentado ⇒ reuso ⇒ revoga a concessão |
| Revogação | persistida (`revogada_em` imutável por gatilho); verificação a cada pedido no banco ⇒ vale em todas as instâncias. Troca de senha posterior à concessão invalida |
| Consentimento | `/admin/conexoes-ia/autorizar?pedido=…` na sessão do KidMais (guard: origem + CSRF + paywall). Mostra aplicativo, host de retorno, empresa ATIVA da sessão, dados que saem, prazo e revogação. Só escopos pedidos; empresa provada por `provarTenant`; allowlist do piloto; papel da membership |
| Metadados | `/.well-known/oauth-protected-resource[/api/mcp]` (RFC 9728) e `/.well-known/oauth-authorization-server` (RFC 8414). Canal desligado ⇒ 404 |

## 6. Persistência (migration 105 — NÃO aplicada)

`mcp_oauth_clientes`, `mcp_oauth_pedidos`, `mcp_oauth_concessoes` (índice único parcial: uma ativa por
usuário+empresa+cliente; gatilho de revogação/identidade imutável), `mcp_oauth_codigos`, `mcp_oauth_tokens`
(CHECK de vida máxima), `mcp_auditoria` (CHECKs de forma: só códigos, ids e contagens). Pre/postcheck em
`database/checks/20261027_105_*`; rollback em `database/rollback/20261027_105_mcp_assinaturas_down.sql` (recusa se houver
concessão ou auditoria). Sem schema: `SchemaMcpAusente` ⇒ 503; **nunca DDL em request**. Memória
(`memoria-teste.ts`) é só de teste; teste estático garante que nada operacional a importa.

Exportação verificável: as 6 tabelas foram classificadas em `FORA_DO_ESCOPO` (mesmo critério de
`sessoes_administrativas`). **Decisão revisável** — ver pendências.

## 7. Controles de canal

| Variável | Padrão | Efeito |
|---|---|---|
| `MCP_ENABLED` | ausente = desligado | Só `"true"` liga. Desligado: `/api/mcp` 503 antes de autenticar; authorize/token 503; metadados 404 |
| `MCP_TENANT_ALLOWLIST` | ausente = ninguém | Obrigatória para o piloto (uuid por vírgula; inválida ⇒ ninguém) |
| `MCP_PUBLIC_URL` | ausente = desligado | URL do recurso (HTTPS; http só loopback fora de produção) |
| `MCP_CIMD_HOSTS` | `chatgpt.com,claude.ai` | Hosts aceitos de documento CIMD |
| `MCP_REF_SECRET` | ausente = busca indisponível | ≥ 32 caracteres; assina referências de conhecimento |
| Canônicas da IA | — | chave-mestra, grupo READ e allowlist da IA continuam exigidas. **Não** exige chave de modelo nem a flag de modelo do copiloto |

Limites (por instância, em processo — documentado): 30 chamadas/min por concessão, 120/min por empresa,
2 simultâneas por concessão, corpo 64 KiB, prazo 5 s, mapas limitados (10 mil chaves). Com N instâncias o teto é N×.
Paywall: ver e **desconectar** (`/api/admin/mcp/conexoes`) nunca é bloqueado pela assinatura (entrada em
`PERMITIDAS_POR_METODO`). Criar conexão é POST no guard administrativo ⇒ só com acesso COMPLETO. Consultar pelo canal
segue a regra de leitura (COMPLETO e SOMENTE_LEITURA leem; BLOQUEADO não).

## 8. RAG textual

`conhecimento/manifesto.json` (fora de `data/`, que no Render é um disco persistente montado por cima do repositório) lista cada documento com id, versão, vigência, situação, ACL explícita
(PLATAFORMA/EMPRESA/UNIDADE) e SHA-256; arquivo divergente invalida o corpus inteiro (busca indisponível, nunca vazia
silenciosa). Fragmentos por seção `##`; normalização de acentos, stopwords e radical simples; BM25 com cobertura mínima de
termos. ACL + situação + vigência filtram **antes** do ranking; referência opaca HMAC com empresa e validade (24 h); fetch
revalida tudo. **Sem cache**: cada chamada relê o manifesto e confere os hashes (alteração, suspensão, remoção e recuperação de falha valem na chamada seguinte). Conteúdo é marcado `CONTEUDO_DOCUMENTAL_NAO_INSTRUCAO`.

**Corpus versionado (3 documentos) está `PENDENTE_APROVACAO`:** foi redigido por quem implementou e só aparece depois
de aprovado (Felipe). Até lá, a busca responde `semEvidencia`. Unidade: o MVP não prova unidade ⇒ documentos UNIDADE nunca
aparecem.

## 9. Interface

- `/admin/conexoes-ia` (atalho em Meu perfil quando o canal está ligado): conexões da própria pessoa, situação
  persistida ("Autorizada · nenhuma consulta recebida ainda" × "consulta recebida"), escopos, datas, Desconectar,
  instruções por fabricante. Nunca "conectado por clique".
- `/admin/conexoes-ia/autorizar`: consentimento.
- UX-1 resolvida em 28/10/2026 (§20): sem sessão, o login guarda o pedido e volta ao consentimento (formato exato).

## 10. Fabricantes (pacotes locais; nada submetido)

| Fabricante | Como o piloto conecta | Verificado em 27/10/2026 | Não verificado / pendente |
|---|---|---|---|
| ChatGPT | Conector MCP personalizado com a URL `MCP_PUBLIC_URL`; OAuth com CIMD (`https://chatgpt.com/oauth/client.json`), redirect `https://chatgpt.com/connector_platform_oauth_redirect` (com `iss`) | Requisitos de descoberta, CIMD preferido, S256, `resource`, `securitySchemes`, `_meta["mcp/www_authenticate"]` (developers.openai.com/plugins/build/auth) | Plano exato do piloto (Pro leitura × Business); Plus; comportamento real de refresh; manifesto de plugin publicado (não preparado: formato não verificado) |
| Claude | Conector personalizado com a URL (menu em 28/10/2026: Personalização › Conectores); Claude usa CIMD (anunciado) ou cai para DCR (não oferecido ⇒ falha clara) | Free/Pro/Max/Team/Enterprise com conectores remotos; 401 obrigatório; `authorization_servers[0]`; callback hospedado `https://claude.ai/api/mcp/auth_callback`; refresh rotativo; egress `160.79.104.0/21` (claude.com/docs/connectors/building/authentication) | URL do documento CIMD hospedado pela Anthropic para claude.ai (só o de Claude Code é público) — conferir no 1º teste real; Claude Code (loopback) fora do piloto |
| Gemini | Sem conexão no piloto | Custom apps exigem 18+, EUA, conta pessoal, inglês e Keep Activity (pesquisa do vault) | Nada a testar no Brasil; não orientar VPN/troca de país. CLI só como laboratório técnico futuro |

## 11. Roteiro de homologação (PENDENTE, nada executado)

1. Revisão independente (Codex/Astra) deste diff.
2. Autorização específica: cluster descartável para `oauth.postgres.test.ts` (estados 105 e 103).
3. Autorização específica: aplicar 105 em **staging** (precheck → migration → postcheck), deploy de staging com
   `MCP_ENABLED` ainda **desligado**; depois ligar com `MCP_TENANT_ALLOWLIST` = empresa de teste, `MCP_PUBLIC_URL`,
   `MCP_REF_SECRET` (novo, só staging).
4. Conexão real por fabricante/plano, uma linha por resultado: Claude Pro (web), Claude Desktop, ChatGPT Pro (custom MCP
   leitura), ChatGPT Business. Registrar: descoberta, CIMD, consentimento, 4 ferramentas, refresh após 1 h, revogação.
5. Aprovação do corpus por Felipe (mudar `situacao` para `APROVADO`, recalcular hash).
6. Só depois: decisão de piloto em produção (Human Gate).

## 12. Desligamento e rollback (não destrutivos)

1. **Desligar:** `MCP_ENABLED=false` (ou remover a empresa da allowlist). Efeito imediato no próximo pedido; nada apagado.
2. **Revogar uma conexão:** Assistentes conectados › Desconectar (ou `revogarConcessao` com motivo `USUARIO`).
3. **Código:** reverter o deploy para o anterior; as tabelas 105 podem ficar (não são lidas por mais ninguém).
4. **Não** há rollback destrutivo automático de concessões/auditoria. O down da 105 só serve antes de qualquer uso real.
5. Desligar não apaga o que o assistente já recebeu: fica no histórico do fabricante, conforme as regras dele.

## 13. Pendências e decisões abertas

| Id | Pendência | Dono |
|---|---|---|
| P-REV | Revisão independente do diff | Astra/Codex |
| P-PG | Executar `oauth.postgres.test.ts` (atomicidade, multi-conexão, FOR SHARE, gatilho, schema ausente) | Autorização de banco descartável |
| P-105 | Reconferir número 105 imediatamente antes de congelar e de aplicar | Implementador |
| P-REAL | Conexões reais por fabricante/plano | Autorização + contas |
| P-CORPUS | Aprovar o corpus (hoje `PENDENTE_APROVACAO`) | Felipe |
| D-EXP | 105 fora da exportação verificável (como sessões). Alternativa: exportar as concessões da empresa | Felipe/revisão |
| UX-1 | Login não volta ao consentimento | Resolvida LOCAL em 28/10/2026 (§20) |
| UX-2 | Atalho só em Meu perfil (menu não alterado) | Futuro |
| LIM-1 | Limites em processo (N instâncias ⇒ N×) | Aceito no piloto |
| LIM-3 | Sem IP confiável da borda, os limites anônimos são por cliente e globais; como o client_id do ChatGPT/Claude é compartilhado, um atacante pode esgotar a janela por minuto e atrasar conexões legítimas (DoS, não vazamento). Mitigação real: borda confirmada (ORIGEM_CLIENTE_BORDA) e/ou WAF | Aceito no piloto; reavaliar antes de público amplo |
| LIM-2 | Corrigido nas rodadas 2 e 3 (§14, §15): limites em processo por origem confiável, cliente e global; teto PERSISTENTE de pedidos pendentes por cliente; expurgo limitado; nenhuma auditoria anônima no banco; corpo do token com teto durante a leitura. Resta: limites em processo valem por instância (LIM-1) | Aguarda nova revisão |
| RET-1 | Expurgo OPORTUNISTA em lotes desde a rodada 3 (§15, §16): roda em segundo plano com tráfego no authorize/token; 90/180 dias são critérios de elegibilidade, não prazo garantido. Valores propostos | Felipe confirma os prazos |
| RET-2 | Job agendado de expurgo, para garantir os prazos do RET-1 sem depender de tráfego | Futuro (antes de produção ampla) |

## 14. Rodada 2 — correções da revisão independente (Astra, 27/10/2026)

| Achado | Correção (local, sem commit) | Prova |
|---|---|---|
| P1-1 refresh reduzido mantinha escopo amplo | Coluna `escopos` em `mcp_oauth_tokens` (105); `saveToken` grava o escopo validado; `verificarAcesso`/`lerAtualizacao` usam o do token; gravação recusa escopo fora da concessão | protocolo "refresh com escopo reduzido": acesso só agenda, renovação seguinte continua reduzida, reampliar ⇒ `invalid_scope` |
| P1-2 crescimento ilimitado pelas rotas públicas | `lib/integracoes/oauth/rotas.ts`: canal antes de tudo; limites por origem (só IP da borda confirmada), cliente e global; teto persistente de pedidos pendentes por cliente (5 000; atômico desde a rodada 3, §15); expurgo em lotes (na rodada 2 só pedidos/códigos/tokens; drenagem e retenção completas na rodada 3, §15); recusas anônimas só em contador + 1 linha de log/min | `rotas.test.ts` (5) |
| P2-3 IPv6 em grafias alternativas | Classificação por BYTES (`bytesIpv6`): mapeado/compatível/NAT64/6to4/Teredo/::/80, só 2000::/3 fora de blocos especiais; regras IPv4 estreitadas aos /24 corretos | `cimd.test.ts` (25 grafias recusadas + controles positivos) |
| P2-4 cache do corpus | Sem cache: releitura e hash a cada chamada | `conhecimento.test.ts` (suspensão, ACL, falha e recuperação) |
| P2-5 detector deixava passar `net.connect` | `destinoDoConnect` entende argumentos normalizados; forma desconhecida é bloqueada | `detector-rede.test.ts`: net.connect, net.connect(porta, host), https, http, tls e fetch registrados; loopback passa |
| P2-6 prazo não limitava a transação | Prazo envolve a transação inteira; composição usa `transacaoComPrazo` (descarta a conexão) + `statement_timeout` 4,5 s e `lock_timeout` 2 s | núcleo: transação presa antes da leitura ⇒ recusa no prazo; PG (preparado): espera por trava termina em 55P03 |
| P2-7 canal desligado escondia conexões | `conexoesDaPessoa` lista SEMPRE; tela avisa que o canal está desligado e mantém Desconectar | protocolo: desligado lista, revoga; religar não ressuscita; não revoga de outra pessoa |
| P2-8 corpo do token lido inteiro | Canal e limite antes do corpo; `lerCorpoLimitado` cancela acima de 8 KiB (com ou sem content-length) | `rotas.test.ts` (corpo não lido com canal desligado; cancelamento) |
| P3-9 exceção ampla e analisador por regex | Exceção restrita a `lib/integracoes/{mcp,oauth}`; analisador por AST (efeito colateral, require, import(), import = require), não literal/não resolvido reprovado | controles positivos para cada forma |
| P3-10 empresa ausente na tela | `empresaNome` na listagem (join com empresas) e nos cartões | protocolo P2-7/P3-10 |

Pendências da rodada 2: ver o fim do §15.

## 15. Rodada 3 — correções da 2ª revisão (Astra, 27/10/2026)

Veredito recebido: "ainda não pronta para P4" (1 P1, 6 P2, 1 P3). Correções locais, sem commit:

| Achado | Correção | Prova |
|---|---|---|
| 1 (P1) recusas reiniciavam os limites (novas chaves desalojavam janelas vigentes) | `lib/integracoes/mcp/janelas.ts` (`JanelasFixas`), usado pelas bordas OAuth e pelo `LimitadorMcp`: decisão sem mutar o mapa (recusa não cria nem zera janela); admite em todas as chaves ou em nenhuma; só janelas VENCIDAS são varridas; sem espaço ⇒ recusa (fail-closed), nunca esquece um contador ativo. Global conferido primeiro ⇒ no máximo ~3 × (300 + 600) chaves novas por minuto, abaixo de `maxChaves` (10 000) | `rotas.test.ts`: 10 050 `client_id` distintos com global 5 e `maxChaves` 8 ⇒ só 5 vagas usadas e o global continua barrando; unidade: mapa cheio de janelas vigentes recusa sem mexer nas existentes; 1 000 recusas seguidas não reiniciam a janela |
| 2 (P2) teto de pendentes não atômico | `criarPedidoNoTeto` substitui contar + inserir: numa transação, `FOR NO KEY UPDATE` na linha do cliente (serializa as admissões entre conexões/instâncias sem bloquear as FKs `KEY SHARE`), contagem limitada (`LIMIT teto`) e INSERT | memória: 12 pedidos concorrentes com teto 3 ⇒ exatamente 3; PG (preparado): segunda admissão ESPERA a primeira (`pg_blocking_pids`) e depois vê o teto |
| 3 (P2) armazenamento não limitado | Limites NA GRAVAÇÃO por concessão (`RETENCAO_OAUTH`): renovação recusada com 429 `temporarily_unavailable` a partir de 30 acessos/hora, conferido ANTES de girar (o refresh não é consumido); teto duro de 60/hora na gravação (sob `FOR NO KEY UPDATE` da concessão); só os últimos 20 refresh girados ficam; acessos e refresh não girados vencidos saem na mesma transação. Expurgo DRENA em lotes de 500 até esgotar (até 40 lotes/2 s por execução): pedidos, códigos não usados, tokens, tudo de concessões revogadas há > 1 dia, concessões revogadas há > 90 dias e auditoria > 180 dias (RET-1) | protocolo: 30 emissões ⇒ 429 sem revogar; o mesmo refresh vale depois de 1 h; ≤ 20 girados e ≤ 51 linhas por concessão; PG (preparado): poda na gravação, teto duro, dreno de 1 200 pedidos |
| 4 (P2) reuso após vencimento não revogava | `lerAtualizacao` devolve refresh GIRADO mesmo vencido (evidência); expurgo não apaga código USADO nem refresh girados guardados de concessão ATIVA. Janela de detecção declarada: o código USADO enquanto a concessão estiver ATIVA (revogada: o código sai após 1 dia, ver §16); os últimos 20 giros do refresh | protocolo: R1 girado, vencido há 1 dia, reapresentado ⇒ família revogada (`REUSO`); controle: vencido nunca girado ⇒ só inválido; girado fora da janela ⇒ só inválido (limitação declarada); PG (preparado) idem |
| 5 (P2) corpo sem prazo/concorrência | `lerCorpoLimitado(request, max, prazoMs)`: prazo TOTAL (5 s) e cancelamento sem esperar; no máximo 32 leituras simultâneas por instância (503 antes de ler) | corpo pendurado ⇒ `PRAZO`/408 em ~80–150 ms; segunda leitura com limite 1 ⇒ 503 sem ler o corpo; vaga devolvida |
| 6 (P2) A10 incompleto para recusas | Política explícita (cabeçalho de `rotas.ts`): TODA recusa das bordas soma 1 num agregado (código × rótulo do cliente: host da allowlist CIMD ou hash curto, nunca o texto enviado); no máximo `dimensoesLog` (200) dimensões + `OUTROS`; 1 linha por minuto e temporizador de 60 s independente do tráfego (`setInterval(...).unref()` na composição); perda máxima: o último minuto se o processo morrer. Recusas antes não contadas (parâmetro duplicado, `state`, 405, 415, `grant_type`, `resource`, PKCE do token, canal desligado, falhas 503) passaram a ser contadas | tabela de 16 recusas: cada uma soma exatamente 1, nenhuma linha no banco, rótulos sem `evil`/URL/token; temporizador descarrega sem tráfego; dimensões limitadas |
| 7 (P2) resumo financeiro sem limite de memória | `contarRecebiveis` (financeiro/servico.ts: mesmos JOINs da fonte, parando em teto + 1) ANTES de `listarRecebiveis`; acima de `LIMITES_MCP.recebiveisMax` (5 000) ⇒ `VOLUME_ACIMA_DO_LIMITE` sem materializar; DTO numa passada só (sem listas intermediárias nem `Math.max(...lista)`); itens auditados limitados ao CHECK (≤ 10 000) | volume 5 001 ⇒ recusa sem carregar a lista; 5 000 ainda responde; DTO de 200 000 itens igual à versão por listas; itens auditados = 10 000 |
| 8 (P3) relato desalinhado | §13/§14 corrigidos (teto 5 000; RET-1 com expurgo automático; A2 com controle positivo estático) | este documento |

Limitações que permanecem (declaradas, não corrigidas aqui):
- **LIM-1:** limites, leituras simultâneas e agregado de log são por instância.
- **LIM-3:** o `client_id` do ChatGPT/Claude é compartilhado. Sem IP confiável da borda, um atacante pode consumir a cota por minuto do fabricante e atrasar usuários legítimos; subir o teto não resolve. Mitigação recomendada, não feita: limitação na borda/WAF por origem comprovada e proteção contra tráfego distribuído. `ORIGEM_CLIENTE_BORDA` só conta como mitigação depois de comprovada a sobrescrita dos cabeçalhos e a ausência de entrada alternativa.
- **VOL-1:** empresas com mais de 5 000 recebíveis não têm o resumo por este canal; o copiloto interno e o Financeiro usam a mesma fonte sem esse teto. Um agregado SQL no domínio é trabalho futuro.
- O teto duro de 60/hora só é atingido por corrida acima do limite brando. Nesse caso o refresh já foi girado e o cliente precisa reconectar (falha fechada).

Continuam pendentes: P-PG (8 casos, nenhum executado), LIM-1, LIM-3, VOL-1, UX-1, D-EXP, RET-1 (confirmar 90/180 dias), P-REAL, P-CORPUS.

## 16. Rodada 4 — correções da 3ª revisão (Astra, 27/10/2026)

Veredito recebido: "ainda não pronta para P4". O P1 das janelas foi confirmado como corrigido; restavam 4 P2 e 1 P3. Correções locais, sem commit:

| Achado | Correção | Prova |
|---|---|---|
| 1 (P2) OAuth e expurgo podiam esperar indefinidamente no banco | Na composição (`dependencias.ts`), TODA operação do repositório OAuth, consulta avulsa ou transação, roda em `transacaoComPrazo` (3 s, conexão descartada ao vencer) com `statement_timeout` 2,5 s e `lock_timeout` 1 s. Prazo total por pedido OAuth (`prazoTotalMs`, 10 s ⇒ 503 contado). Expurgo FORA do caminho da resposta (sem await), no máximo um em curso por instância, e cada lote com `FOR UPDATE … SKIP LOCKED` (nunca espera linha travada) | `rotas.test.ts`: banco preso ⇒ 503 pelo prazo e contado; expurgo preso não atrasa o authorize e não dispara um segundo. PG (preparado): expurgo pula a linha travada em < 1,5 s |
| 2 (P2) ordem inversa de travas (deadlock renovação × reconexão) | Ordem única cliente → concessão → tokens/códigos. `criarConcessaoComCodigo` agora trava as concessões ativas da tripla (`ORDER BY id FOR NO KEY UPDATE`) ANTES de revogar tokens, como `salvarTokens` e `revogarConcessao`; comandos só de tokens são de uma instrução. Regra documentada no cabeçalho de `postgres.ts` | PG (preparado): com a concessão travada pela renovação, a reconexão espera NA CONCESSÃO sem nenhuma trava em `mcp_oauth_tokens`; a poda da renovação não espera; a reconexão termina sem 40P01 |
| 3 (P2) A10 não cobria as rotas reais | As rotas `authorize` e `token` exportam TODOS os métodos (GET/POST/PUT/PATCH/DELETE/OPTIONS; HEAD pelo GET), e os não atendidos vão para `atenderMetodoNaoPermitido` (405 contado). `lerCorpoLimitado` (agora em `lib/integracoes/mcp/corpo.ts`) devolve `ERRO` para falha/aborto do fluxo: 400 sanitizado e contado, com a vaga de leitura devolvida | `rotas.test.ts`: POST no authorize, GET no token e fluxo com erro somam 3, sem detalhe na resposta; `mcp-arquitetura.test.ts`: as duas rotas exportam os 6 métodos, e os não principais apontam para o contador |
| 4 (P2) corpo pendurado em /api/mcp segurava vagas | Depois de autenticar e ANTES de ocupar a vaga da concessão, o transporte lê o corpo inteiro com teto de 64 KiB, prazo total de 5 s e no máximo 32 leituras simultâneas por instância (503 acima disso); o SDK recebe um `Request` já completo. Pedido não autenticado não tem o corpo lido | protocolo: dois corpos pendurados da mesma concessão não impedem uma chamada normal (concorrência 2); ambos terminam em 408; as leituras são devolvidas. Os outros métodos de `/api/mcp` também passam pelo transporte (405 próprio) |
| 5 (P3) relato exagerava a retenção | RET-1 requalificado (§13). A implementação de memória passou a ter os mesmos critérios de concessões e auditoria | este documento |

**Retenção, com precisão (resposta ao achado 5):**
- O expurgo é **oportunista**: roda em segundo plano quando há tráfego no authorize/token, no máximo um por instância por minuto. Sem tráfego elegível, ou com o canal desligado, não roda. Os 90/180 dias são **critérios de elegibilidade**, não prazo garantido de remoção. Garantir o prazo exige um job agendado (RET-2, pendente).
- Janela de detecção de reuso: o código USADO fica enquanto a concessão estiver ATIVA; depois que ela é revogada, o código sai após 1 dia, e a concessão continua até 90 dias sem esse código. Refresh: os últimos 20 giros de concessão ativa.
- O teste PG de dreno cobre pedidos e a preservação do código; concessões e auditoria só têm prova em memória. Não comprova integralmente o RET-1.

**Avaliações da 3ª revisão registradas:**
- A contagem financeira corresponde à listagem até o teto. Acima dele, a contagem é truncada por origem: basta para recusar, mas não é um total.
- VOL-1 conta também recebíveis pagos e cancelados. Uma empresa com pouco saldo em aberto pode ultrapassar o teto pelo histórico.
- `FOR NO KEY UPDATE` conflita com o `FOR SHARE` das ferramentas e com o UPDATE de `guardarCliente`: há espera na mesma concessão e serialização no cliente compartilhado, agora limitadas pelo `lock_timeout` de 1 s do OAuth.
- As 30 emissões por hora incluem a emissão inicial. O comportamento real dos fabricantes diante do 429 depende da conexão real (P-REAL).
- A perda de até 1 min do agregado anônimo é telemetria de melhor esforço, aceitável no piloto **se Felipe aceitar explicitamente**; não equivale a auditoria durável.

Continuam pendentes: P-PG (10 casos, nenhum executado), RET-2 (job agendado de expurgo), LIM-1, LIM-3, VOL-1, UX-1, D-EXP, RET-1 (confirmar 90/180), aceite da perda de 1 min do agregado anônimo, P-REAL, P-CORPUS.

## 17. Rodada 5 — correções da 4ª revisão (Astra, 27/10/2026)

Veredito recebido: "ainda não pronta para P4" (5 P2, 1 P3, nenhum P1). A revisão confirmou os achados anteriores: ordem de travas, A10 nas rotas reais, corpo antes da vaga e qualificação da retenção. Correções locais, sem commit:

| Achado | Correção | Prova |
|---|---|---|
| 1 (P2) Bearer inventado chegava ao banco sem admissão | Em `/api/mcp`, antes de tocar o banco: taxa de autenticações (1 200/min global e 120/min por origem confiável) e no máximo 8 verificações simultâneas (503 sem fila). Na composição, o canal inteiro (OAuth, verificação, ferramentas, consentimento) disputa no máximo **12** das 30 conexões do pool (`VAGAS_BANCO_CANAL`). A vaga só volta quando a obtenção da conexão termina, então uma `pool.connect()` abandonada pelo prazo continua contando. A tela da própria pessoa (listar/desconectar) tem reserva separada de 2 vagas | protocolo: 1 250 Bearers inventados ⇒ 50 recusados com 429 e exatamente 1 200 consultas; 8 verificações presas ⇒ a 9ª recebe 503 na hora, com 8 consultas |
| 2 (P2) uma concessão monopolizava as 32 leituras globais | A vaga da concessão/empresa (taxa por minuto + concorrência 2 por concessão e **4 por empresa**) é tomada ANTES de ler o corpo; o teto global de leituras vem depois. Cada tentativa consome a taxa | protocolo: 2 corpos pendurados da concessão A ⇒ a 3ª de A recebe 429 sem ocupar leitura; a empresa B segue atendida; os dois terminam em 408; A volta a ser atendida |
| 3 (P2) escritas depois do 503 | Prazo total contado desde a CHEGADA do pedido (no token inclui a leitura do corpo) e PROPAGADO: cada operação do repositório (≤ 3 s) e cada busca CIMD (≤ 5 s) só COMEÇA se couber até o limite (`dependenciasComPrazo`, `PrazoDoPedidoVencido`). Depois do limite nenhuma etapa nova (pedido, código, refresh, tokens) é iniciada; só a que já estava em voo pode concluir (COMMIT incerto, limitação declarada). Falha que não é recusa do CIMD não vira mais "aplicativo não habilitado" (sobe como 503) | rotas: etapas de 60 ms com prazo de 150 ms ⇒ 503, sem pedido criado e sem a etapa mutante iniciada; controle com prazo folgado conclui. Token: corpo pendurado termina pelo prazo total (não pelos 5 s) |
| 4 (P2) CIMD sem prazo absoluto | `buscaHttpsFixada`: prazo ABSOLUTO (5 s) cobrindo DNS, conexão e transferência; ao vencer, o soquete é destruído; no máximo 4 buscas em curso por instância (`OCUPADO`). A vaga só volta quando o trabalho real termina (DNS lento abandonado continua contando) | cimd: DNS que não responde ⇒ `TEMPO` no prazo; a busca seguinte recebe `OCUPADO` até o DNS terminar; resposta em gotas ⇒ `TEMPO` e soquete destruído |
| 5 (P2) consentimento sem prazo e corpo sem teto | `dependenciasConsentimento` usa a transação de tenant COM prazo e vaga (`tenantComPrazo`). As rotas administrativas `consentimento` e `conexoes` leem JSON com `lerJsonLimitado` (4 KiB, 5 s) antes do Zod. Canal ocupado ou prazo vencido ⇒ 503 sanitizado | rotas: 413/400/408 do leitor; teste estático: nenhuma rota do canal usa `request.json/text/arrayBuffer/formData/blob` (com controle positivo) |
| 6 (P3) memória não retinha pedido consumido | A memória guarda `consumidoEm` e só expurga pedido consumido há mais de 1 h, como o PostgreSQL | rotas: consumido há menos de 1 h fica; há mais de 1 h sai |

**Limitações que ficam (declaradas):**
- **ADM-1:** o guard administrativo (`exigirApiAdminCrmDisponivel`) é o mesmo de todo o Admin e usa as consultas comuns. Não foi alterado: muda o app inteiro e exige uma tarefa própria.
- **CAP-1:** os números (12 vagas de banco, 8 verificações simultâneas, 1 200 por minuto) são **por instância** e não têm teste de carga. Calibrar exige ensaio de pool, ainda não feito.
- **COMMIT-1:** uma etapa já em voo quando o prazo vence pode concluir (COMMIT incerto). Se for o consumo do código ou o giro do refresh, a nova tentativa do cliente pode ser lida como reuso e revogar a conexão (falha fechada; a pessoa reconecta).

Continuam pendentes: P-PG (10 casos, nenhum executado), CAP-1, ADM-1, RET-2, LIM-1, LIM-3, VOL-1, UX-1, D-EXP, RET-1, aceite da perda de 1 min do agregado anônimo, P-REAL, P-CORPUS.

## 18. 5ª revisão (Astra, 27/10/2026): pronta para P4 + P3 residuais

**Veredito do Astra:** "implementação local pronta para avançar à P4, restrita aos testes PostgreSQL em ambiente isolado explicitamente autorizado". Nenhum P1 ou P2. **Isto não aprova homologação externa nem publicação.**

P3 corrigidos depois do veredito (local, sem commit):

| P3 | Correção | Prova |
|---|---|---|
| 1. CIMD ocupado ou com tempo esgotado aparecia como culpa do aplicativo (400 / `invalid_client`) | `CimdRecusado.transitorio` (`OCUPADO`, `TEMPO`, `FALHA_REDE`). No authorize, a falha transitória vira 503 ("tente de novo"); no modelo OAuth, sobe como erro (não `invalid_client`). Recusa definitiva continua 400 | `rotas.test.ts`: busca ocupada ⇒ 503; client_id desconhecido ⇒ 400 (controle) |
| 2. Banco indisponível no token devolvia 500 | `server_error` da biblioteca (que embrulha banco indisponível, canal ocupado, prazo ou CIMD transitório) vira 503 `temporarily_unavailable`, contado como `TOKEN_INDISPONIVEL` | `rotas.test.ts`: `CanalOcupado` em `lerAtualizacao` ⇒ 503, uma recusa contada |
| 3. "Cada tentativa consome a taxa" não valia para recusas por concorrência | Texto qualificado (aqui e nos comentários de `limites.ts`/`servidor.ts`): a tentativa ADMITIDA consome a taxa; a recusada por concorrência consome só a admissão global de autenticação; o teto de leituras não é furado (no máximo 2 por concessão) | — |

**Residuais qualificados pelo Astra (aceitos para P4, a resolver antes de exposição externa):**
- **CAP-1:** 12 vagas de banco e 8 verificações simultâneas são contenção inicial, não capacidade validada. A margem nominal é de 16 conexões num pool de 30 (até 14 admissões, contando a reserva), e só vale para esse tamanho de pool. Uma `pool.connect()` abandonada pode ocupar a vaga até o timeout do pool (10 s por padrão); com o banco falhando de forma contínua, o canal pode ficar indisponível por janelas seguidas.
- **ADM-1:** o guard administrativo (`lib/http/admin-crm-api.ts`) consulta e atualiza pelo executor comum, sem os prazos e vagas do canal. As rotas administrativas do canal ainda podem esperar ali. As leituras administrativas têm teto de tamanho e prazo, mas não teto agregado de concorrência. O consentimento fica fora do prazo total do pedido; suas etapas são limitadas uma a uma.
- **COMMIT-1 (ampliado):** além da etapa em voo quando o prazo vence, pode haver um commit confirmado seguido de falha numa etapa posterior. Exemplo: tokens salvos e auditoria recusada por prazo ou vaga. O cliente não recebe o novo par, e uma repetição pode revogar a conexão por reuso (falha fechada; a pessoa reconecta).
- **Expurgo:** fica fora do prazo do pedido, de propósito: execução única, lotes e orçamento limitados. O orçamento de 2 s não interrompe um lote já iniciado.
- **Corpus:** lido inteiro de forma síncrona antes de validar o tamanho. A origem é só arquivo versionado; não é bloqueador.
- **Runtime:** o Astra validou em Node 24.20.0; o projeto fixa 22.23.2, ainda não validado.

**Próximo passo (P4):** executar `lib/integracoes/oauth/oauth.postgres.test.ts` (10 casos, estados 105 e 103) num cluster PostgreSQL descartável LOCAL, **somente com autorização explícita de Felipe**. Depois: regressão PG das suítes que dependem do modelo 103; só então aplicar a 105 em staging, com autorização própria.

## 19. P4 — suíte PostgreSQL executada (27/10/2026)

Autorização de Felipe (27/10/2026): "criar um cluster PostgreSQL descartável local (porta livre > 55500, nunca 5432/5433, nunca staging/produção) só para rodar lib/integracoes/oauth/oauth.postgres.test.ts nos estados 105 e 103, removendo o cluster ao final".

| Item | Resultado |
|---|---|
| Cluster | PostgreSQL 18.6 local, `127.0.0.1:55691`, `cluster_name`/usuário `kidmais_descartavel`, identidade provada antes de cada execução (sem banco `kidmais_manager`); script `ambientes-locais/pg-descartavel-mcp-assinaturas-20261027.cjs` (só a suíte OAuth) |
| Estado **105** (modelo recriado do schema vazio: inventário até a 105, sem a 098) | **10/10** casos aprovados |
| Estado **103** (sem a 105) | schema ausente ⇒ `SchemaMcpAusente` sem DDL **aprovado**; 9 casos pulados por desenho ("estado sem 105") |
| Estabilidade | 3 execuções seguidas, todas verdes (inclusive concorrência entre conexões, `pg_blocking_pids`, `lock_timeout` 55P03, ordem de travas sem 40P01, `SKIP LOCKED`) |
| Limpeza | cluster parado (`pg_ctl status` 3), diretório removido; relatórios preservados em `ambientes-locais/pg-descartavel-mcp-assinaturas-20261027-relatorios` |

**Lacuna encontrada e corrigida na P4:** a 105 não estava no inventário aprovado de migrations (`scripts/production/check-migrations.mjs`). O runner PG recusou ("checkpoint 105 fora do inventário"), e `npm run production:test` falhava em 8 casos (`MIGRATION_BASELINE_REVIEW_REQUIRED`). As rodadas anteriores só rodaram `check:v1:static`, que não inclui esse teste. A 105 entrou em `approvedFiles`, em `requiresExplicitAuthorization` e na lista de pendências "NOT_APPLIED", e o inventário fixo de `scripts/production/production.test.mjs` foi atualizado: `production:test` passou a 37/37. Todos os passos do CI passaram a ser rodados localmente (ver §6 de `MCP_ASSINATURAS_TESTES.md`).

**O que a P4 NÃO cobre:** aplicação da 105 em staging/produção, carga do pool (CAP-1), Node 22.23.2 fixado, conexão real com fabricantes, UI com sessão real. Próximo passo possível: aplicar a 105 em staging (autorização própria, aplicador/blocos ainda a preparar) e depois a conexão real (P-REAL).


## 20. Teste real em staging e correções dos achados (28/10/2026)

**Teste real (staging, TESTE S3):**
- ChatGPT e Claude foram conectados de verdade, os dois por CIMD.
- As 4 perguntas-roteiro passaram em cada um.
- Também passaram a tela de conexões, Desconectar (ChatGPT) e a renovação depois de 1 h (Claude).
- Evidência completa no vault: "Plano ligar canal MCP staging 20261027".

Antes da conexão foram corrigidos dois bloqueios, os dois já LIVE em staging:
- **CIMD-PKJWT (#257):** o documento real do ChatGPT declara `private_key_jwt` e lista `none` entre os métodos suportados.
- **CIMD-LOOKUP (#259):** no Node 20+ o `lookup` é chamado com `all: true`.

Achados do teste, corrigidos LOCAL nesta rodada:

| Achado | Correção | Teste |
|---|---|---|
| Consentimento usa a **empresa ativa** sem deixar claro; a 1ª tentativa caiu numa empresa fora do piloto (conta de revisão da Meta) e o Permitir aparecia | `lerPedidoParaConsentimento` devolve `empresaNoPiloto` da empresa ativa (mesma regra do menu, `contextoDaSessao`). A tela diz que a conexão vale só para essa empresa e como trocá-la. Fora do piloto: aviso e **sem** Permitir (Não permitir continua). A barreira real continua em `concluirConsentimento` | `protocolo.test.ts` (sinal × lista e barreira intacta), `consentimento-mcp-ui.test.ts` (renderização real) |
| **UX-1:** o login não voltava ao consentimento | `retorno-login.ts`: sem sessão no consentimento, o Admin vai a `/admin/login?voltar=…` com o pedido. O login volta só ao formato exato `…/autorizar?pedido=kmp_<43>`; o resto da regra antiga fica intacta (sem query livre nem URL externa) | `retorno-login.test.ts` (formato exato, cargas extras, externo, `//`, regra antiga) |
| Assistente da agenda (093) abriu por cima e capturou cliques na tela de conexões; no consentimento cobriria o Permitir | O `AdminShell` não monta o assistente em `/admin/conexoes-ia/autorizar` | revisão de código (componente do shell sem teste de renderização) |
| Texto "Como conectar" citava menus que os fabricantes já mudaram (ChatGPT: Plugins; Claude: Personalização) | Texto genérico ("nas configurações do assistente") e aviso de conferir a empresa ativa antes de conectar | — |
| Log do SDK `responseMode: 'json' drops mid-call notifications…` a cada chamada (o transporte é criado por requisição) | `semAvisoDeRespostaJson` filtra só essa mensagem, só durante a criação; outros avisos passam | `protocolo.test.ts` (com controle: sem o filtro, o SDK avisa) |

Controle negativo: com `servidor.ts`, `servico.ts` e `ConsentimentoAssistente.tsx` antigos, os 4 testes novos dependentes falham.

**Continuam pendentes:**
- (8) teste negativo real com empresa fora da allowlist (precisa de uma conta de teste adequada);
- CAP-1, ADM-1, RET-2, LIM-1/LIM-3, D-EXP, RET-1;
- aprovação do corpus (D3);
- revisão independente do resultado de staging;
- promoção para produção.


## 21. Revisão do Astra do resultado de staging e rodada de correções (28/10/2026)

**Veredito:** "resultado de staging aprovado; produção pode ser planejada". Sem P1. Não é GO para ligar produção.

**Correções LOCAIS desta rodada:**

| Achado | Correção | Teste |
|---|---|---|
| **P2-1** "Carregando…" sem recuperação | `carregarPedido` (em `ConsentimentoAssistente.tsx`): prazo absoluto de 15 s, também para a leitura dos corpos; `AbortController` aborta as requisições no prazo e ao sair da tela; resultado `recuperavel` (5xx, rede, prazo) mostra **Tentar de novo**. Pedido inválido (404) não é recuperável. Ler o pedido não o consome | `consentimento-mcp-ui.test.ts` (pedido pendurado, corpo pendurado, 404 × 503 × rede, carga normal, saída aborta) |
| **P2-2** UX-1 parcial | `lib/http/retorno-login.ts` (movido de `components/admin`) ganhou `loginDestaPagina()`. Todos os envios ao login por sessão encerrada passam por ele: shell (resposta e falha de rede/JSON), `adminFetch` (antes e depois da requisição) e `trocarEmpresaAtiva`. Sair por vontade própria continua indo ao login simples | `retorno-login-sessao.test.ts` (antes, depois e fora do consentimento) + `troca-sessao.test.ts` atualizado |
| **P3** contrato do CIMD | Método omitido **não** vale `none` (no RFC 7591 o omitido é `client_secret_basic`). Aceita só `none` declarado ou listado em `token_endpoint_auth_methods_supported`. Os documentos reais de 28/10 declaram (Claude: `none`; ChatGPT: `private_key_jwt` + `none` na lista) | `cimd.test.ts` (omitido sem lista, omitido com lista autenticada, omitido com `none` na lista) |
| **P3** filtro do log | Só a mensagem **exata** do SDK, com um único argumento; mesmo prefixo ou argumentos extras passam | `protocolo.test.ts` (com controle de que o SDK emite o texto exato) |
| Risco declarado: pedido na URL | `no-referrer` no consentimento (`metadata`) e no login (novo `app/admin/login/layout.tsx`). Sanitização na borda e na observabilidade fica para o checklist de produção | revisão de código |
| **P3** docs contraditórios | Bloco "ESTADO ATUAL" no topo deste documento, de `MCP_ASSINATURAS_TESTES.md` e de `MCP_ASSINATURAS_APLICADOR_105.md`; matriz de provas atualizada | — |

Controle negativo: com `cimd.ts`, `servidor.ts`, `admin-fetch.ts` e `ConsentimentoAssistente.tsx` anteriores, 8 testes novos falham.

**Mínimo para produção** (classificação do Astra):

| Item | Classe |
|---|---|
| Aplicador 105 **de produção** (identidade fixa do alvo, precheck/postcheck/integridade, PITR comprovado, procedimento para resultado indeterminado) | bloqueante para aplicar |
| Candidata exata validada no **Node 22.23.2** (ou mudança formal do runtime) | bloqueante para o GO técnico |
| Env própria: `MCP_PUBLIC_URL` de produção, segredo novo, allowlist da empresa piloto real, `AI_TENANT_ALLOWLIST` deliberada, flags READ coerentes; não copiar de staging | bloqueante para ligar |
| Monitoramento e desligamento: responsável, alertas 5xx/429, latência/pool, falhas OAuth/refresh, logs sanitizados (incluindo `pedido`/`voltar` na borda), `MCP_ENABLED=false` autorizado | bloqueante para ligar |
| CAP-1 | bloqueante para abertura ampla; no piloto, aceite explícito com envelope de carga |
| ADM-1, carregamento, UX-1 | aceitáveis no piloto acompanhado; validar antes o login real, a sessão expirada, a tela e o POST negativo |
| D3 (corpus) | bloqueante para anunciar respostas documentadas; piloto sem corpus possível (`semEvidencia`) |
| RET-1, D-EXP | decisões explícitas antes do piloto |
| RET-2 | pode esperar se não houver promessa de prazo de exclusão |
| LIM-1/LIM-3 | aceitáveis no piloto com risco declarado |
| Teste real em produção (descoberta, consentimento/login, consultas, refresh, revogação nos dois fabricantes; sem usar a produção como massa) | gate de aceite |

**Para fortalecer a evidência de staging** (Astra):
- base sintética preenchida na TESTE S3, para provar a redução aos DTOs;
- POST 403 real com uma conta só fora do piloto;
- correlação do refresh com o evento `TOKEN_RENOVADO` e com a mesma concessão.
