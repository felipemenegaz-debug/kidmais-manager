# Catálogo do buffet por empresa (078) — correção e homologação local (10/10/2026)

**Status: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.** A 078 não foi aplicada em nenhum banco (nem local); nenhum cluster, servidor
ou navegador foi iniciado na preparação. Nada em staging, produção, Render ou serviços externos. Sem push nem deploy.

- **Código: `b364ece89d05a6d68aa60cb987e8f6fd1398801e`**. Este pacote está no commit seguinte, que altera só `docs/`; o SHA desse commit é o da aprovação.
  `git diff --name-only b364ece89d05a6d68aa60cb987e8f6fd1398801e HEAD` deve listar só `docs/`. Qualquer outra diferença: parar.
- Origem: homologação das etapas (`59b0898`) com **isolamento parcial** — o catálogo do buffet era global
  ([evidência corrigida](evidencias/homologacao-cotacao-etapas-20261010.md)).
- Decisão de Felipe (10/10/2026): outra empresa que já usa o catálogo recebe **cópia só do que usa**.
- **Substitui a candidata `ac55c4c` (pacote `c583ce2`)**, que tinha a 078 em ordem errada: as cópias eram inseridas com a
  unicidade global ainda ativa (021 `UNIQUE(codigo)` das categorias; 050 código dos itens sem categoria) e a 078 falharia em
  qualquer banco com outra empresa usando o catálogo antigo. Achado de Felipe na revisão; corrigido em `b364ece` (ver §1).

## 1. Migração 078 (`database/migrations/20261010_078_catalogo_buffet_por_empresa.sql`)

| Parte | Efeito |
|---|---|
| Coluna | `empresa_id` (FK `empresas`, **imutável** por gatilho) em `buffet_categorias` e `buffet_itens` |
| Cardápio da Kidmais | todo o catálogo atual (021/022 + o que existir) passa a ser da empresa `kidmais` (046). **Nada muda nele**: mesmos ids, códigos, nomes, ordem, situação; composição dos pacotes da Kidmais intacta. Sem `kidmais` no banco, fica sem empresa (fora do alcance de qualquer empresa) |
| Outras empresas que já usam | cópia **só** das categorias que os pacotes/adicionais delas usam (com todos os itens dessas categorias) e dos itens sem categoria que usam; vínculos (`pacote_buffet_categorias`, `pacote_buffet_itens`, `pacote_itens_especificos`, origem dos adicionais 070) passam para as cópias, com os mesmos modos e limites. O precheck lista essas empresas antes de aplicar |
| Novos buffets / empresas sem uso | **nada** — começam sem catálogo e cadastram o próprio |
| Pedidos e fotografias | **intocados**: `fechamentos`, `fechamento_buffet_*`, `fechamento_pacote_snapshots/_composicao/_itens_especificos` continuam apontando para os ids originais (histórico) |
| Unicidade | código da categoria único **por empresa** (duas empresas podem ter `SALGADOS`); item sem categoria idem. **Ordem:** (1) dono = Kidmais; (2) remove `UNIQUE(codigo)` da 021 e o índice `buffet_itens_codigo_sem_categoria_uk` da 050 e cria os índices por empresa (e os equivalentes para catálogo sem empresa); (3) só então as cópias, que repetem os códigos em outra empresa; (4) gatilhos. Tudo numa única transação (`BEGIN` … `COMMIT`): qualquer erro desfaz a 078 inteira |
| Integridade (gatilhos) | recusam (`23514`, “cruza empresas”): item em categoria de outra empresa; categoria/item de outra empresa em pacote; origem de adicional de outra empresa; **escolha nova** de buffet com categoria de outra empresa |
| Precheck / postcheck | somente leitura; postcheck exige catálogo da Kidmais completo (7 categorias da 022), zero vínculo entre empresas, índices e 8 gatilhos |
| Rollback | `database/rollback/20261010_078_catalogo_buffet_por_empresa_down.sql`: automático **só** se o catálogo tiver um único dono (nenhuma cópia, nenhum catálogo próprio); senão ABORTA (correção para frente) |

Inventário: 078 incluída em `scripts/production/check-migrations.mjs` como **pendente de autorização explícita** (como 074–077).
Impressão do schema dos pacotes locais: `a543675ae56524dfc7bae8f7d815a79fac79f70bdabc2a733639c0db1f7c8510` (80 migrations, 204 arquivos).

## 2. Código (compatível com bancos sem a 078)

Detecção `catalogoBuffetPorEmpresa` (coluna instalada?). **Sem a 078**: leituras como antes e escrita no catálogo recusada
(`CATALOGO_GLOBAL_SEM_AUTORIDADE`) — nada muda em produção até a 078 ser autorizada. **Com a 078**:

| Onde | Antes | Agora |
|---|---|---|
| `lib/comercial/catalogo-buffet.ts` | sem empresa | toda função exige a empresa comprovada (UUID); leitura/escrita/exclusão só com `empresa_id` dela; outra empresa = 404 |
| `/api/admin/configuracoes/catalogo` | escrita recusada para todos; leitura global | Gestão da empresa cria/edita/desativa/exclui categorias e itens **dela**; leitura só dela |
| `/api/admin/configuracoes/pacotes` (GET) | catálogo global | só o da empresa |
| `pacotes-admin.ts` (composição, itens específicos) | categoria/item por id, sem empresa; itens específicos sem conferir o dono do pacote | só categoria/item da empresa; pacote precisa ser da empresa |
| `adicionais-admin.ts` (origem do buffet) | qualquer categoria/item | só do catálogo da empresa |
| Público `/api/fechamentos/catalogo` e escolha no pedido | escopo só pelo pacote | também por `empresa_id` (segunda barreira, além do gatilho) |
| IA `buffet.catalogo.buscar` | catálogo global, ignorando o tenant | catálogo da empresa do tenant; escrita continua negada à IA (Fase 1) com mensagem atualizada |

“Opções” do pedido de Felipe = itens do buffet (não há tabela de opções separada); as escolhas do cliente são itens da categoria.

## 3. Testes

| Camada | Arquivo | Cobre |
|---|---|---|
| Unitário (sem banco) | `lib/comercial/catalogo-buffet.test.ts` | **ordem da 078** (uma só transação; troca da unicidade antes dos `INSERT` das cópias; a regra antiga não volta — falha contra a versão de `ac55c4c`); empresa obrigatória; filtros em leitura/escrita; 404 para outra empresa; mesmo código em outra empresa; código repetido na mesma empresa |
| Unitário | `lib/comercial/round4-remediacao.test.ts`, `lib/inteligencia/acoes/human-gate.test.ts` | composição com filtro de empresa; mensagem da IA |
| PostgreSQL descartável (063 + 070 + 078) | `lib/comercial/catalogo-buffet-078.postgres.test.ts` | **dados criados antes da 078** (Kidmais, OUTRA — empresa existente usando o catálogo antigo — com categoria no pacote e itens selecionados, item sem categoria no pacote, item sem categoria e item de categoria como origem de adicionais, pedido com escolha de buffet); precheck lista só OUTRA; Kidmais idêntica; cópia só do usado **com os mesmos códigos** (SALGADOS/DOCES e os dois itens sem categoria passam a existir na Kidmais e em OUTRA); repetir código na mesma empresa continua recusado; NOVA sem catálogo; impressão das tabelas de pedidos/fotografias igual; depois, **duas empresas com a mesma categoria SALGADOS**: leitura, escrita, composição, itens específicos, gatilhos, escolha no pedido, adicional do buffet e **cotação** (`calcularResumoComercial`) sem cruzar empresas |
| PostgreSQL descartável | `lib/comercial/catalogo-ux.postgres.test.ts` (agora 063 + 070 + 078 na transação) | ciclo de vida do catálogo com empresa |
| PostgreSQL descartável (sem 078) | `lib/saas/hg8-catalogo.postgres.test.ts` | comportamento anterior preservado (escrita recusada sem a 078) |
| Ferramentas locais | seed, servidor, pós-conferência (`--catalogo`), concorrência, cluster | catálogo próprio por empresa na seed; impressão 80/204; cluster `kidmais_descartavel:55498` na lista fechada |

Os testes PostgreSQL **ainda não rodaram** (exigem o cluster descartável — passo D abaixo). A suíte da 078 é a que comprova a
ordem em banco real: com a ordem antiga ela falharia no `client.query(M078)` com violação de unicidade.

**Validação local feita (código `b364ece`)**: testes sem banco 2262/2262 (inclui o teste da ordem); testes de `scripts/` em série 278/280 — as 2 falhas são as ferramentas manuais de banco que exigem `--festa-id` (inalteradas; mesmas de `ac55c4c`); smoke 103/103; produção 37/37 (078 pendente de autorização); planos offline `confere: true` (80 migrations, 204 arquivos); TypeScript e worker de PDF aprovados; ESLint 0 erros (1 aviso preexistente); `git diff --check` limpo. `next build` não foi repetido: a correção só altera SQL da 078, testes e constantes das ferramentas locais (último build aprovado em `ac55c4c`, 61 páginas). Nenhum banco foi usado; nenhuma variável de banco no ambiente.

## 4. Passos (cada um exige aprovação; PowerShell na raiz; só `127.0.0.1`)

**Pré-condições (leitura):** `HEAD` = SHA aprovado; só `docs/` depois de `b364ece89d05a6d68aa60cb987e8f6fd1398801e`; árvore limpa; sem `.env*`, `DATABASE_URL`, `PG*`;
portas 55498, 55481 e 3481 livres; `node scripts/navegador-local-seed.cjs --plano` e `concorrencia-vagas-isolado.cjs --plano` com
`confere: true`; testes offline das ferramentas.

**Frente D — suítes PostgreSQL (cluster novo `kidmais_descartavel`, porta 55498):**

| Passo | Comando | Esperado |
|---|---|---|
| D1 | `$env:KIDMAIS_PG_BIN='C:/Program Files/PostgreSQL/18/bin'`; `node scripts/cluster-descartavel-postgres.cjs criar --cluster kidmais_descartavel --criar-autorizado`; `iniciar --pasta <pasta> --iniciar-autorizado`; `conferir --pasta <pasta>` | pasta `.local-descartavel-pg-<guid>`, `INICIADO`, `CONFERE`, bancos `[]` |
| D2 | `$env:KIDMAIS_POSTGRES_DESCARTAVEL='kidmais_pacotes_v1_descartavel'; $env:KIDMAIS_DESCARTAVEL_PORTA='55498'; $env:KIDMAIS_DESCARTAVEL_AUTORIZACAO='127.0.0.1:55498/kidmais_pacotes_v1_descartavel'; $env:KIDMAIS_POSTGRES_SOMENTE='lib/comercial/catalogo-buffet-078.postgres.test.ts,lib/comercial/catalogo-ux.postgres.test.ts,lib/saas/hg8-catalogo.postgres.test.ts,lib/comercial/adicionais-070.postgres.test.ts,lib/comercial/round4-remediacao.postgres.test.ts'; node scripts/regressao-v1-postgres.cjs` | todas as suítes PASS (a receita recria do zero os modelos 063 e atual; nenhuma suíte depende de outra) |
| D3 | `parar --pasta <pasta> --parar-autorizado` | `PARADO`; pasta preservada |

**Frente B — navegador (cluster novo `kidmais_navegador`, banco `kidmais_navegador_catalogo_20261010`):**

| Passo | O quê | Esperado |
|---|---|---|
| B0 | `Rename-Item .local-navegador .local-navegador-execucao-59b0898` | renomeada, intacta |
| B1 | criar/iniciar/conferir cluster `kidmais_navegador` | `CONFERE`, bancos `[]` |
| B2 | seed (`--seed-navegador-autorizado`) — schema com a **078** | `PASS`; conferência: `isolamento` com SALGADOS nas duas empresas e itens próprios (`itensBuffet` 5 e 4), `MESMA_CATEGORIA_NAS_DUAS_EMPRESAS`, legado com `catalogoBuffet` da Kidmais (≥ 7 categorias) |
| B3 | servidor (`--iniciar-autorizado`) | como antes (CEP externo desligado, fontes locais, Asaas desligado) |
| B4 | checklist §5, desktop e celular | — |
| B5 | `node scripts/navegador-local-posconferencia.cjs --catalogo` (só leitura) | `CONFERE`, `vinculosEntreEmpresas: 0` |
| B6 | parar servidor e cluster; restaurar `next-env.d.ts` se regenerado | portas livres; pastas preservadas |

## 5. Checklist do navegador (D = desktop; C = celular 375×812)

| # | Onde | Esperado | D | C |
|---|---|---|---|---|
| K1 | `/b/nav-profissional/fechamento`, Buffet → “Quero informar agora” | Salgados: só Coxinha/Kibe/Esfiha **Profissional sintética(o)**; Doces: Brigadeiro/Beijinho Profissional; **nenhum** item da Kidmais (ex.: “Coxinha com catupiry”, “Bombom de mandioca”) nem do Premium | ✓ | ✓ |
| K2 | `/b/nav-premium/fechamento`, Buffet | **mesma categoria “Salgados”** com Empada/Pastel **Premium**; Massa do bolo Premium; nada do Profissional nem da Kidmais | ✓ | ✓ |
| K3 | `/fechamento` (legado), Buffet do Festa Completa | cardápio original da Kidmais (022) exatamente como antes | ✓ | ✓ |
| K4 | APIs (GET, sem sessão): `/api/fechamentos/catalogo?pacote=POCKET&empresa=nav-profissional` / `nav-premium`; `?pacote=COMPLETA` sem empresa | só os itens de cada empresa / da Kidmais | ✓ | — |
| K5 | Admin, conta sintética Gestão do Profissional: Configurações › Itens do Buffet | lista só o catálogo do Profissional; **criar** categoria “Bolos sintéticos” e item “Bolo de cenoura sintético”; **editar** o nome de um item; desativar e reativar | ✓ | leitura |
| K6 | Admin, Gestão do Premium | não vê nada do Profissional (nem o item criado em K5); `PATCH` com o id do item do Profissional (console, sessão do Premium) → **404**, nada alterado | ✓ | — |
| K7 | Admin, conta Equipe do Essencial | escrita no catálogo recusada (403, só Gestão) | ✓ | — |
| K8 | `/b/nav-profissional/fechamento` depois de K5 | item novo aparece só se a categoria estiver no pacote (não está): **não** aparece; nada do K5 vaza para o Premium | ✓ | — |

Envio de pedido: **nenhum** neste pacote (o isolamento da escolha no pedido é coberto pela suíte D2 e pelo gatilho).
Credenciais sintéticas digitadas só em `localhost:3481`; nunca repetidas no chat.

**Efeitos permanentes:** somente nas pastas locais novas (`.local-descartavel-pg-*`, `.local-navegador-pg-*`, `.local-navegador/`),
ignoradas pelo Git — K5 grava categoria/item no banco descartável. Remoção só com autorização de limpeza (C6).

## 6. Riscos e pendências

- **Staging e produção**: a 078 exige pacote próprio. O precheck mostra quais empresas receberão cópia; em staging, as empresas
  de homologação que usam o catálogo receberão cópia do que usam. Ordem segura: código desta candidata primeiro (compatível sem a
  078), depois a 078 com autorização.
- Itens copiados mantêm os nomes do cardápio da Kidmais nas empresas que já os usavam (decisão “copiar só o usado”); a empresa pode
  renomear/excluir pela tela.
- `adicional_categorias` (categorias de adicionais: MESA, DECORACAO…) continuam globais — são tipos, sem conteúdo da Kidmais; fora
  deste escopo.
- Pacotes **sem empresa** (legado anterior à 046) ligados ao catálogo continuam ligados; qualquer mudança neles passa a ser recusada.
- **Pendente para produção (sem mudança aqui):** fluxo de cliente existente com OTP (validar em staging).
- A IA continua sem escrever no catálogo (Fase 1).
