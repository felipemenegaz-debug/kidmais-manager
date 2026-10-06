# Painel do desenvolvedor — conclusão da implantação (05/10/2026)

Branch `feat/painel-desenvolvedor-conclusao-20261005`, base `origin/staging` em `8e32c7e548f215f42f61bed2a40280752e4ff9a5`
(já inclui a migration 064 da reimportação; o SHA `d6a7cf6` informado como último deploy foi substituído por `73e44e4`,
deploy `dep-db23qp3tqb8s73buu7m0`, live desde 06/10/2026 00:19:34Z, e depois pela 064 ainda não implantada). Nenhuma
migration nova nesta entrega: tudo roda sobre o schema da 063 (aplicada em staging em 05/10/2026, conforme
`homologacao-painel-063/leituras/estado-pos-063-ff095cf-*.txt`) e sobre a estrutura do Perfil (026–028).

Esta entrega **não** faz merge, deploy, migration, escrita em staging, alteração de env/secret nem envio de e-mail. Tudo
foi validado localmente com dados sintéticos; o que depende de staging ou de configuração está listado como pendente.

## 1. Estado encontrado (reconfirmado em 05/10/2026, não a partir dos relatos)

| Área | Situação em `73e44e4` |
|---|---|
| Interessadas, provisionamento, convites, vínculos, suspensão/reativação, seleção de empresa, senha e reautenticação | Implementados e cobertos por `lib/desenvolvedor/painel-063.postgres.test.ts` (20 casos) e testes estáticos; já em staging |
| Perfil da empresa de uma contratante nova | **Defeito de implantação**: a tela respondia 409 "ainda não está disponível" e ninguém criava o perfil pela aplicação |
| Associação Perfil ↔ empresa com várias empresas | **Risco confirmado no código**: o perfil legado (código `EMP-*`) só se associava à instalação de UMA empresa; a primeira contratante provisionada pelo painel desfazia a associação da Kidmais (409 no Perfil e na logo) |
| Pendências de implantação | Não existiam: a etapa "Implantação concluída" era marcada sem nenhum requisito |
| Auditoria consultável | Só os últimos 15/30 registros, sem filtro nem paginação |
| `Retry-After` nos 429 | Ausente em todos os limites |
| Usuário sem empresa ativa no Admin | Ficava numa seleção vazia com menu de negócio inútil; "Ir para o Admin" aparecia mesmo sem acesso; 404 padrão sem saídas |
| Logout em estado de erro | Falha silenciosa quando a confirmação da sessão não respondia |
| E-mail | Adaptador completo (`desativado`/`arquivo`/`resend`); provedor real não configurado (D1) — "não enviado" é mostrado |
| Recuperação pública | Exige `RECUPERACAO_SENHA_ATIVA=true` + envio configurado; senão 503 sem revelar conta |

## 2. Matriz de requisitos

Estado: **I** implementado nesta entrega · **J** já existia (revalidado) · **V** validado localmente · **P** pendente (fora do escopo autorizado).

| Req. | Item | Estado | Solução | Teste / evidência |
|---|---|---|---|---|
| A | Interessada não cria usuário/acesso | J V | — | PG "interessada: cadastro não cria…" |
| A | Provisionamento transacional, idempotente e concorrente | J V | advisory lock + conflitos (código/documento/interessada) | PG "provisionamento…" |
| A | Gestão configura empresa nova sem Perfil | **I V** | `lib/perfil/criacao.ts` + ação `criar-perfil` da API + tela | unit `lib/perfil/criacao.test.ts` (4), PG "perfil da empresa nova…", UI cenário 3 |
| A | Só registros mínimos, validados, idempotentes, sem copiar a Kidmais | **I V** | perfil com o código da empresa, 1 unidade, 4 capacidades; pré-preenche só nome/razão social/CNPJ válidos | unit + PG + `PerfilEmpresa.test.ts` ("nada é copiado da Kidmais") |
| A | Pendências reais com ações claras | **I V** | `lib/desenvolvedor/implantacao.ts`; ficha lista ✓/✗ com ação | unit `implantacao.test.ts` (3), PG "implantação…", UI cenário 4 |
| A | Requisitos para CONCLUÍDA validados no servidor | **I V** | Gestão ativa + perfil criado + cadastro aplicado; 409 `IMPLANTACAO_PENDENTE` auditado | PG + UI (409 via API e botão bloqueado) |
| B | Busca, filtros, paginação | J V | 25/página, contagens | código revisado; PG |
| B | Validação e-mail/telefone/CPF-CNPJ | J V | `lib/acessos/validacao.ts` | `acessos.test.ts` |
| B | Duplicidade no servidor, inclusive concorrência | J V | advisory lock + índices únicos parciais | PG |
| B | Histórico por interessada/empresa com quem/quando/ação/motivo/resultado | J + **I** V | detalhe da interessada já existia; nova Atividade com filtros (empresa/ação/período) e paginação | PG "auditoria consultável…", unit em `painel.test.ts`, UI |
| B | Edição, descarte, reabertura; conversão sem duplicar | J V | — | PG |
| B | Estados vazios/carregando/erro | J V | — | componentes |
| B | Não expor dados operacionais no resumo | J V (reforçado) | Atividade só com origens administrativas | unit (origens operacionais excluídas) |
| C | Ciclo do convite completo | J V | — | PG |
| C | Conta existente aceita convite sem duplicar | J V | — | PG |
| C | Senha errada não consome convite | J V | — | PG |
| C | Tokens por hash, nunca em logs/relatórios | J V | sanitização central + consulta sanitizada | PG varredura; unit |
| C | Adaptador de e-mail, modelos e falhas | J V | `lib/acessos/email.ts` | `acessos.test.ts` |
| C | "Não enviado" com provedor desligado | J V | — | PG "envio indisponível…" |
| C | Recuperação pública só com configuração, sem revelar conta | J V | `disponibilidade.ts` (503) | `recuperacao-route.test.ts` |
| C | Limites e `Retry-After` nos 429 | **I V** | `prazoDoLimite` + `details.retryAfterSegundos` + cabeçalho em `falhar()` e no login | unit `retry-after.test.ts` (3), PG "Retry-After…" |
| C | Entrega real de e-mail | **P** | exige D1 (Resend) e autorização | ver §7 |
| D | Mesmo contexto no menu, páginas e APIs; seleção validada no servidor | J V | D7 | PG D7/múltiplas empresas; UI anterior |
| D | Gestão em Alfa ≠ Equipe em Beta; troca invalida; suspensão/revogação imediatas | J V | — | PG; `scripts/painel-multi-ui.cjs` |
| D | Concessão de desenvolvedor não dá acesso operacional | J V (reforçado) | — | PG "perfil da empresa nova…" (dev → TENANT_NAO_COMPROVADO) |
| D | Última Gestão/administradora protegidas | J V | — | PG |
| D | Duas abas, troca durante requisição, respostas atrasadas | J V | `admin-fetch.ts` | `contexto-empresa.test.ts` (16), `scripts/painel-reauth-ui.cjs` |
| E | Sem empresa ativa: sair, perfil, voltar ao painel | **I V** | estado "Sem empresa ativa" no Admin; menu sem itens de negócio | `navegacao-saida.test.ts`, UI cenário 1 |
| E | Não ficar preso em 404/seleção vazia/"Verificando sessão…" | **I V** | `app/not-found.tsx` com saídas; prazo de 8 s na verificação | UI cenários 1–2; unit |
| E | Ocultação de rotas + navegação segura | **I V** | 404 neutro (mesma página para rota inexistente e área oculta) | UI cenário 2 |
| E | "Ir para o Admin" reflete acessos | **I V** | só com empresa ativa | UI cenário 1 |
| E | Logout do painel, perfil, seleção e erro | **I V** | `components/admin/sair.ts` (navegação completa mesmo sem confirmação) | UI cenários 1, 3, 5 |
| E | Desktop e celular, foco, teclado, labels | **I** parcial V | menu do painel com Escape; checklist com `aria-label`; botões com `title` | UI cenário 5 (390×844) |
| F | Troca de senha, revogação de sessões | J V | — | PG |
| F | Reautenticação 5 min, mesmo relógio, limites exatos e futuro | J V (estendido à criação do perfil) | `exigirReautenticacaoPerfil` com `consultado_em` | `painel.test.ts`; PG; UI cenário 3 |
| F | Renovação não interrompe "confirmar e continuar" | J V | — | `contexto-empresa.test.ts` |
| F | Ações sensíveis exigem reautenticação no servidor | J + **I** V | criação do perfil incluída | unit/PG/UI |
| F | Limites antes de hashes custosos | J V | — | `acessos.test.ts` |
| G | Resumo com contagens corretas | J V | — | código revisado; PG D7 |
| G | Auditoria por empresa e ação, com filtros e paginação | **I V** | `GET /api/desenvolvedor/auditoria`, página `/desenvolvedor/atividade` | PG; unit; UI |
| G | Motivo obrigatório | J V | — | PG |
| G | Dupla submissão e concorrência | J + **I** V | criação do perfil sob advisory lock + `FOR UPDATE`; botões desabilitados | unit; PG |
| G | Erros visíveis no relatório e na interface | J + **I** V | recusa de conclusão auditada e mostrada | PG; UI |
| G | Sanitização centralizada | J V (reforçado) | `sanitizarAuditoria` também na leitura | unit |

## 3. Mudanças de comportamento

1. **Perfil da empresa nova.** `GET /api/admin/configuracoes/perfil-empresa` deixa de responder 409 quando a empresa não tem perfil: devolve `perfilAusente: true` e `podeCriar` (Gestão). `POST { acao: 'criar-perfil', confirmar: true }` cria `perfil_empresas` (código = código da empresa; nome comercial da empresa; razão social e CNPJ do cadastro administrativo só quando válidos), uma `perfil_unidades` (`<codigo>-principal`, herda a sede) e as quatro capacidades do perfil para quem criou. Exige Gestão nesta empresa (Tenant Context) e senha confirmada há no máximo 5 min (mesmo relógio do banco). Idempotente; se o perfil já existe sem administrador elegível, concede as capacidades iniciais (auditado como `PERFIL_CONCESSAO_INICIAL`); se já há administrador, 409 pedindo concessão. Auditoria `PERFIL_ESTRUTURA_CRIADA`.
2. **Associação Perfil ↔ empresa** (`lib/perfil/autorizacao.ts`): além de UUID igual, código igual e instalação única, o único perfil órfão (sem empresa por UUID/código) pertence à empresa legada `kidmais`. Dois órfãos continuam fechando o acesso (nenhum é escolhido). Isso preserva o Perfil da Kidmais quando o painel provisiona outras empresas.
3. **Pendências de implantação** na ficha da contratante (ativa, com cadastro): Gestão ativa, perfil criado, cadastro aplicado (obrigatórias) e convites pendentes com problema (informativa). "Implantação concluída" só é aceita pelo servidor com as obrigatórias atendidas; recusa 409 `IMPLANTACAO_PENDENTE` com a lista, auditada como `EMPRESA_IMPLANTACAO_RECUSADA` (fora da transação recusada). A aceitação registra os requisitos conferidos.
4. **Atividade administrativa** (`/desenvolvedor/atividade`, `GET /api/desenvolvedor/auditoria`): filtros por empresa, ação e período, 25 por página; só origens administrativas (painel, convites, recuperação, senha, ciclo de empresa/vínculo, Usuários e acessos, CLI, Perfil da empresa); cada linha sai pela mesma sanitização da escrita. Link "Ver toda a atividade desta empresa" na ficha.
5. **`Retry-After`** em todas as respostas 429 com prazo calculável: reenvio de convite (intervalo de 60 s), recuperação pelo painel (120 s), limites de tentativas de convite/aceite/redefinição/troca de senha/login (fim do bloqueio pelo relógio do banco).
6. **Navegação e saída.** Admin sem empresa ativa mostra "Sem empresa ativa" com perfil, painel (se concedido) e sair, sem itens de negócio no menu; "Verificando sessão…" oferece tentar de novo/ir ao login após 8 s; 404 único e neutro com saídas seguras; "Ir para o Admin" só com empresa ativa; "Sair" único (`components/admin/sair.ts`) leva ao login com navegação completa mesmo quando o servidor não confirma, deixando o aviso real; menu do painel fecha com Escape; item "Atividade".

## 4. Validação executada (05–06/10/2026, dados sintéticos)

| Verificação | Resultado |
|---|---|
| `npx tsc --noEmit` | sem erros |
| ESLint (áreas alteradas e arquivo inteiro na regressão) | sem erros |
| Unitários novos: `lib/perfil/criacao.test.ts`, `lib/perfil/associacao.test.ts`, `lib/desenvolvedor/implantacao.test.ts`, `lib/acessos/retry-after.test.ts`, `components/admin/navegacao-saida.test.ts` + extensões em `painel.test.ts` e `PerfilEmpresa.test.ts` | ver §4.1 |
| PostgreSQL descartável (modelo 063 recriado do schema vazio) — `lib/desenvolvedor/painel-063.postgres.test.ts` | 26/26 (20 anteriores + 6 novos) |
| Interface (Playwright + Chrome, Next local, banco sintético) — `scripts/painel-implantacao-ui.cjs` | ver §4.1 |
| `npm run check:v1:static` (testes, lint, TypeScript, build), `production:test`, `otp-staging` | ver §4.1 |

### 4.1 Evidências

| Execução | Resultado |
|---|---|
| `npm run check:v1:static` (tree pré-merge `73e44e4` + esta entrega; repetido sobre o commit final, ver PR) | PASS: testes unitários 1935/1935 (inclui os novos), harness 103/103, ESLint 0 erros (1 aviso pré-existente `FinalidadeSkill`), TypeScript, `next build`, leitura do PDF |
| `npm run production:test` (após integrar a 064) · `node --test scripts/otp-staging.test.cjs` | 37/37 · 3/3 |
| PostgreSQL descartável `lib/desenvolvedor/painel-063.postgres.test.ts` (modelo 063 recriado do schema vazio; 55511) | 26/26 — inclui: perfil da empresa nova (Equipe 403, dev sem vínculo recusado, reautenticação vencida 403, criação, idempotência, capacidades), perfil legado órfão da kidmais com várias empresas (dois órfãos → 409), implantação (409 `IMPLANTACAO_PENDENTE` auditado → aplicação do cadastro → CONCLUÍDA), `Retry-After` (reenvio 1–60 s, recuperação ≤ 120 s), auditoria consultável (empresa, ação, período, paginação, sem segredos, sem concessão → 404) |
| Interface `scripts/painel-implantacao-ui.cjs` (Playwright 1.62 + Chrome, `next dev` 3139, banco sintético) | 5/5 cenários: dev sem empresa (Admin "Sem empresa ativa", painel sem "Ir para o Admin", Atividade, sair do perfil); 404 neutro para `/desenvolvedor` sem concessão e rota inexistente; criação do perfil pela Gestão com reautenticação (senha errada recusada sem criar; depois perfil + unidade + 4 capacidades; formulário com o código da empresa); ficha com pendências, CONCLUÍDA bloqueada na tela e 409 pelo servidor, liberada após o cadastro aplicado, Atividade filtrada; celular 390 px (menu, Escape, sair da ficha). Capturas em `.local-painel-implantacao-ui/` (não versionadas) |

**Cluster.** PostgreSQL 18 sintético exclusivo em `127.0.0.1:55511`, `cluster_name=kidmais_descartavel`, diretório
`ambientes-locais/pg-descartavel-painel-conclusao-20261005` (criado vazio, identidade provada antes de qualquer
conexão, sem o banco real `kidmais_manager`); relatórios em `ambientes-locais/pg-descartavel-painel-conclusao-20261005-relatorios`.
Nenhum banco real, nenhum e-mail real, nenhum `.env` carregado.

**Falhas encontradas e corrigidas durante a validação.** (a) A auditoria da recusa de conclusão era gravada dentro da
transação recusada e se perdia no rollback → passou a ser registrada fora dela. (b) A consulta de auditoria sem filtro de
empresa não referenciava o parâmetro `$1` e o PostgreSQL recusava inferir o tipo → referência com tipo explícito.
(c) O erro `PacoteAdminError` tem `details: unknown` → leitura tipada do `retryAfterSegundos` na rota de autenticação.

**Limites da evidência.** Mock de e-mail em todos os testes (nenhuma entrega real verificada). A interface foi exercida
em Chrome headless; outros navegadores não. O estado real de staging (inclusive se o perfil legado da Kidmais está
órfão) não foi lido nesta tarefa — a leitura SQL em staging não está autorizada aqui.

## 5. Migrations

Nenhuma. A entrega usa `perfil_empresas`/`perfil_unidades`/`perfil_empresa_concessoes` (026/027) e as tabelas da 063.
Precheck/postcheck/rollback da 063 permanecem os já homologados. Não há script SQL operacional a executar; a regra de
associação do perfil legado é só código (reversível com o código).

## 6. Plano de homologação em staging (após revisão do Astra e autorizações)

Pré-condições: PR aprovada, CI verde no SHA final, merge em `staging` (merge commit, não squash), auto-deploy OFF
revalidado por leitura, deploy manual do SHA do merge, health 200. Congelamento: avisar as sessões que usam
`homologacao-painel-063` antes do deploy.

| # | Passo | Comando / ação | Efeito | Parar se |
|---|---|---|---|---|
| H0 | Leitura READ ONLY da associação do perfil legado (Felipe, PowerShell, credencial própria) | `SELECT p.id, p.codigo FROM perfil_empresas p WHERE NOT EXISTS (SELECT 1 FROM empresas e WHERE e.id = p.id OR e.codigo = lower(p.codigo));` e `SELECT count(*) FROM empresas;` | Nada | Mais de um órfão (a regra não escolhe; decidir antes) |
| H1 | Login com a conta sintética de desenvolvedor (sem empresa) | navegador | Nada | Admin não mostra "Sem empresa ativa" ou "Ir para o Admin" aparece |
| H2 | `/desenvolvedor/atividade` com filtros por empresa/ação/período | navegador | Nada | 5xx ou registro com token/senha |
| H3 | Login com a Gestão da contratante sintética (Alfa/Beta do S11) → Configurações → Perfil da empresa | navegador | Cria perfil, unidade e 4 concessões (dados sintéticos) | 409 inesperado; perfil criado para outra empresa; sem pedido de senha após 5 min |
| H4 | Login com a Gestão da Kidmais → Perfil da empresa e logo do menu | navegador | Nada | 409 "ainda não está disponível" (associação legada quebrada) |
| H5 | Ficha da contratante no painel: pendências; tentar "Implantação concluída" antes de aplicar o cadastro | navegador | Recusa auditada | Botão habilitado com pendência ou 200 indevido |
| H6 | Aplicar o cadastro do perfil (Gestão) e concluir a implantação (dev) | navegador | Perfil versão 1; implantação CONCLUÍDA | Conclusão sem o cadastro aplicado |
| H7 | Reenvio de convite imediato → 429 com `Retry-After` | navegador/DevTools | Nada | Sem cabeçalho |
| H8 | Sair a partir do painel, do perfil, da seleção vazia e de uma tela com erro de rede simulado | navegador | Sessões encerradas | Tela sem saída |
| H9 | Celular (390 px): menu, Escape, sair | navegador | Nada | Menu sem fechar; foco perdido |
| E | Encerramento: revogar concessão sintética, suspender empresas sintéticas (A9 do roteiro 063) | `scripts/admin-provision.cjs desenvolvedor` + painel | Estado final sintético | — |

Com `EMAIL_PROVIDER` desligado, convites e recuperações continuam "não enviados": H7 valida só o limite.

## 7. Configuração necessária para e-mail (sem valores)

| Variável | Valor esperado | Quem define |
|---|---|---|
| `EMAIL_PROVIDER` | `resend` (hoje ausente/`desativado`) | Felipe, aba Environment do Render, por ambiente |
| `EMAIL_REMETENTE` | remetente verificado no Resend (`Nome <endereco@dominio>`) | Felipe |
| `RESEND_API_KEY` | segredo do Resend; nunca em chat, repositório ou log | Felipe (injeção segura) |
| `RECUPERACAO_SENHA_ATIVA` | `true` só depois de homologar a entrega de e-mail | Felipe |
| `ADMIN_AUTH_ORIGIN` | já configurada (`https://kidmais-manager-staging.onrender.com`) | — |

Sem essas variáveis o sistema mostra "não enviado" e a recuperação pública responde 503 — comportamento desejado.

## 8. Pendências que dependem de configuração ou operação autorizada

- Entrega real de convites e de recuperação (D1): configuração acima + homologação da entrega com conta sintética.
- Merge, deploy e homologação em staging (§6); promoção para production é tarefa separada.
- Leitura H0 em staging para confirmar o estado do perfil legado (a regra de código cobre o caso de um único órfão).
- S11 e E1–E6 da homologação 063 devem ser reconferidos contra o SHA que for implantado (os scripts conferem o alvo).

## 9. Roteiro de revisão para o Astra

1. **Permissões.** `lib/perfil/criacao.ts`: Gestão pelo Tenant Context, reautenticação no servidor, bootstrap de capacidades só sem administrador elegível. `lib/desenvolvedor/http.ts` continua a única guarda das rotas (`painel.test.ts` cobre a rota nova).
2. **Isolamento.** `EMPRESA_SAAS_DO_PERFIL` (regra do órfão único + `candidatos`); `lib/desenvolvedor/auditoria-consulta.ts` (filtro por empresa inclui vínculos e perfil associados; origens fechadas).
3. **Concorrência.** Criação do perfil sob `travarProvisionamentoInicial` + `FOR UPDATE` da empresa; conclusão da implantação sob `FOR UPDATE` do cadastro e revisão.
4. **Sessões.** `components/admin/sair.ts` e os dois shells; `DEMORA_VERIFICACAO_MS`; nenhuma mudança em `admin-fetch.ts`.
5. **Auditoria.** `EMPRESA_IMPLANTACAO_RECUSADA` fora da transação; `PERFIL_ESTRUTURA_CRIADA`/`PERFIL_CONCESSAO_INICIAL`; leitura sanitizada.
6. **Recuperação.** `Retry-After` em `lib/acessos/http.ts`, `lib/autenticacao/service.ts` (`prazoDoLimite`) e rota de autenticação; nada muda nos limites em si.
7. **Testes.** Rodar `check:v1:static`; para o PostgreSQL, criar um cluster sintético e `KIDMAIS_POSTGRES_SOMENTE=lib/desenvolvedor/painel-063.postgres.test.ts`; para a interface, `node --experimental-strip-types scripts/painel-implantacao-ui.cjs` com `KIDMAIS_PLAYWRIGHT_MODULE` e Chrome.
