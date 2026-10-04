# Plano de integração — Atendimento WhatsApp × painel do desenvolvedor × staging

**Situação:** plano. Nada foi executado fora desta máquina: sem push, merge, deploy, migration ou leitura de banco remoto. Cada passo remoto precisa de autorização própria do Felipe ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)).

## 1. Refs (leitura de 04/10/2026, `git fetch` às 19:00; reconfirmados às 19:35, sem mudança)

| Ref | Commit | Arquivos de migration 06x |
| --- | --- | --- |
| `origin/staging` | `904b451` | até a 062 |
| `origin/production` | `650e268` | até a 062 |
| `origin/feat/painel-desenvolvedor-20261004` (outra sessão) | `ad6b1b9`, de 18:51. Passou por `2b6702a` → `660c216` → `ad6b1b9` só nesta tarde | 063 `painel_desenvolvedor` |
| `codex/painel-multi-20261004` (local, outra sessão) | `c0158d4` | 063 |
| `feat/painel-desenvolvedor-20261004` (local, worktree da outra sessão) | `ad6b1b9` (igual ao remoto) | 063 |
| Candidata `whatsapp/atendimento-ia-v1` (local) | código `9145e1d` + docs; remoto `bdb1e75` | 060, 064, 065 |

**Branches não são bancos.** A tabela descreve os arquivos de cada branch. Ela não demonstra o que está aplicado em banco algum. O inventário não tem tabela de controle (`appliedState: unknown`).

| Banco | Estado |
| --- | --- |
| Staging | **Estado não verificado.** Não há leitura datada; a etapa E2a ([WHATSAPP_ATIVACAO_STAGING.md](WHATSAPP_ATIVACAO_STAGING.md)), só leitura, nunca foi executada |
| Produção | **Estado não verificado** |

O painel se move rápido: **refazer o `git fetch` e o `merge-tree` imediatamente antes de qualquer mescla.**

## 2. O que muda ao juntar

`git merge-tree` (só leitura) e simulação numa worktree temporária, já removida:

| Mescla | Resultado |
| --- | --- |
| Candidata × `origin/staging` | **Sem conflito** |
| Candidata × painel `ad6b1b9` | Conflito em 3 arquivos, todos resolvidos pela regra da seção 3 |

Resultado da simulação com o painel `ad6b1b9` (`.local-ux/coordenacao-painel/simulacao-ad6b1b9.txt`; script `sim-mescla.sh`; diff da resolução `simulacao-resolucao.diff`):

| Verificação na árvore mesclada | Resultado |
| --- | --- |
| Testes unitários do check estático | **1982/1982** |
| `tsc --noEmit` | sem erros |
| `production.test` | 37/37 |
| `check-migrations` | ok |
| Build e lint | **não rodados** (ficam para o gate pós-mescla) |

## 3. Regras de resolução (o conteúdo final, seja quem entrar primeiro)

1. **`app/admin/login/page.tsx` — manter as duas mudanças, que são independentes:**
   - do atendimento, o **Mostrar/Ocultar senha**:
     - `const [mostrarSenha, setMostrarSenha] = useState(false)`;
     - `setMostrarSenha(false)` no envio;
     - `<input id="senha-admin" type={mostrarSenha ? 'text' : 'password'} …>`;
     - o botão `type="button"` com `aria-controls="senha-admin"`;
   - do painel, o **`<AvisoContexto />`** logo depois de `<h2>Acesso administrativo</h2>`, com o seu `import`.

   Conferência: `mostrarSenha` aparece 3 vezes, `AvisoContexto` 2 vezes e não sobra nenhum marcador de conflito.
2. **`scripts/production/check-migrations.mjs` — união das listas, em ordem numérica:**
   - `approvedFiles`: … 062, **063** (painel), **064**, **065**; a 060 entra entre 059 e 061;
   - `checkFiles`: a 063 com o `precheck` e o `postcheck` do painel; 060, 064 e 065 com os `postcheck` do atendimento;
   - `requiresExplicitAuthorization`: `'055a'` … `'065'`, incluindo 060, 063, 064 e 065;
   - `pending`: `060`, `063`, `064` e `065` como `_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION`. É um texto do inventário; não afirma nada sobre o banco.
3. **`scripts/production/production.test.mjs` — as mesmas uniões:**
   - `latest` = `20261004_065_whatsapp_nome_perfil.sql`;
   - as listas aprovadas e de autorização com as quatro migrations;
   - as asserções de pendência das quatro.

   O resolvedor `.local-ux/coordenacao-painel/resolver-inventario.mjs` aplica as regras 2 e 3 quando o painel já está na base. Se o atendimento entrar primeiro, o resultado tem de ser o mesmo, conferido pelo `production.test`.
4. **Nunca resolver com "ours/theirs" de arquivo inteiro.** Não renumerar de novo, a menos que o painel mude o número dele; nesse caso, refazer a leitura.

**Mesclados automaticamente, mas que interagem (conferir depois da mescla):**

| Ponto | O que conferir |
| --- | --- |
| `AdminShell.tsx` e `navegacao.ts` | O item "Atendimento WhatsApp" fica em Operação, sem filtro de permissão. As configurações passam a seguir as permissões do painel. Conferir o menu com os dois papéis |
| `adminFetch` (`lib/http/admin-fetch.ts`, mudado em `ad6b1b9`) | A tela de Atendimento e as mensagens prontas o usam. Passa a mandar o contexto da sessão, e uma resposta cujo contexto não for confirmado não é entregue. Os testes unitários passam na árvore mesclada; falta conferir no navegador |
| **Empresa ativa × empresa piloto** (`provarTenant` do painel) | Com o painel, a sessão tem `empresa_ativa_id`, e um pedido explícito de outra empresa é **recusado**. O Atendimento pede sempre `WHATSAPP_ATENDIMENTO_EMPRESA_ID`. Portanto, depois da mescla, ele só abre quando a **empresa ativa da sessão for a piloto**; com outra empresa ativa, recusa (falha fechada, como deve ser). **Nenhum teste cobre isso ainda.** Antes de publicar, acrescentar à suíte PostgreSQL da tela: empresa ativa = piloto → ok; outra empresa ativa → recusa sem dados; e uma mensagem clara na tela |

## 4. Sequência proposta

A ordem entre painel e atendimento é indiferente para o código: tabelas independentes, ids únicos e as regras acima. Recomendação: **o painel primeiro**. Ele é menor, está publicado e tem dono ativo. O atendimento continua bloqueado na homologação do Gupshup e pode absorver a resolução.

| # | Passo | Onde | Autorização |
| --- | --- | --- | --- |
| I0 | `git fetch`, `merge-tree` e esta simulação contra os refs do momento | local, leitura | não precisa |
| I1 | Mescla de verificação numa branch local **descartável** (seção 6.1); a branch da PR #80 só recebe `origin/staging`, e só depois que o painel estiver nele | local | Felipe (é a mescla) |
| I2 | Gate estático completo (unitários, lint, `tsc`, build) + `production.test` + `check-migrations` | local | não precisa |
| I3 | **PostgreSQL descartável**: 060, painel-063, 064, 065, concorrência + completa. **Justificado aqui**: é a primeira vez que 063, 064 e 065 coexistem, e entram os testes novos de empresa ativa × piloto | local | Felipe (banco) |
| I4 | Navegador curto: login (Mostrar senha + AvisoContexto), troca de empresa ativa, Atendimento (identificação, "Voltar", mensagens prontas) e painel; zero saídas | local | Felipe (banco) |
| I5 | Push da candidata e atualização da descrição da PR #80 (desatualizada); CI | GitHub | Felipe |
| I6 | Merge em `staging` com revalidação de HEAD, base, CI e Render (branch e auto-deploy) | GitHub/Render | Felipe |
| I7 | **E2a** — leitura do estado das migrations no banco de staging (`-SomenteEstado`), datada | banco de staging, só leitura | Felipe |
| I8 | E2b — backup e migrations 060/064/065 (a 063 segue o plano do painel), cada uma com postcheck | banco de staging | Felipe |
| I9 | Gupshup (E0, E3…) só depois das três condições: autenticação do webhook (chamado #277630), receptor exclusivo e OTP preservado | Gupshup/Render | Felipe |

Produção: etapa e autorização próprias, depois da homologação em staging. Estado não verificado.

## 5. Lacunas que esta integração não resolve

- **HTTPS visual:** o link individual preenchido nunca foi visto na tela; só pela rota em HTTPS e pela suíte PostgreSQL.
- **Gupshup:** a homologação não foi feita. Nenhuma mensagem real foi enviada nem recebida. O nome de perfil (`payload.sender.name`) nunca foi visto num evento real.

## 6. Escopo concreto da integração (preparado em 04/10/2026, 19:35; nada executado)

### 6.1 Onde a mescla acontece

O painel **ainda não está em `staging`**. Mesclar o painel na branch da PR #80 faria a PR carregar todos os commits do painel. Por isso:

- **Verificação:** uma branch local nova, `integracao/atendimento-x-painel`, criada a partir da candidata, recebe `origin/feat/painel-desenvolvedor-20261004` com as regras da seção 3.
  - Commit só local; **nunca publicada**.
  - Os testes novos (6.2 e 6.3) nascem nela, porque dependem do código das duas.
- **Entrega:**
  - se o painel entrar primeiro em `staging`, a PR #80 recebe `origin/staging` (já com o painel) e os testes novos vêm da branch de verificação;
  - se o atendimento entrar primeiro, os testes vão para a PR do painel, ou para uma PR curta depois das duas.

### 6.2 Empresa ativa × empresa piloto (testes novos)

**Por que importa:** com a 063 aplicada, a sessão passa a ter `id` e `empresa_ativa_id` (`consultarSessao` do painel), e o `provarTenant` do painel recusa um pedido explícito de outra empresa (`TENANT_NAO_COMPROVADO`, "A sessão administrativa não comprova a empresa autorizada."). O Atendimento sempre pede `WHATSAPP_ATENDIMENTO_EMPRESA_ID`. **Sem a 063** a sessão não tem o campo e nada muda.

Suíte PostgreSQL nova `lib/whatsapp/atendimento/empresa-ativa.postgres.test.ts` (seleção: `descartavel: "063"`; aplica a 064 sobre o modelo):

| # | Cenário | Esperado |
| --- | --- | --- |
| E1 | Sem a 063 (modelo `atual` + 060), sessão sem `empresa_ativa_id` | Abre na piloto, como hoje |
| E2 | Com a 063, empresa ativa = piloto | Lista e mensagens prontas ok |
| E3 | Com a 063, usuário com vínculo ATIVO na piloto **e** em B, empresa ativa = B | GET recusado (`TENANT_NAO_COMPROVADO`), nenhum dado da piloto. POST `assumir` recusado: versão da conversa inalterada, nenhuma saída, nenhum evento |
| E4 | Com a 063, empresa ativa = nula (seleção pendente) | **Decisão do Felipe.** Pelo contrato atual do painel, abre na piloto se o vínculo for ativo; a tela do painel já bloqueia com "Escolha a empresa". O teste fixa o que for decidido |
| E5 | Troca de empresa depois do carregamento | Sessão antiga revogada → recusa. Cabeçalho `x-kidmais-sessao` divergente → 409 "A empresa ou a sessão mudou" |
| E6 | Rotas de mensagens prontas (`/api/admin/atendimento/prontas`) | O mesmo que E2/E3 |
| E7 | Recepção (`receberEntrada`) e worker com a 063 aplicada | Seguem gravando na piloto. Não usam sessão, então não há regressão |

**Unitários:**
- a rota do Atendimento devolve 403 com a mensagem do tenant;
- a tela mostra uma mensagem clara em vez do erro técnico. Texto proposto, **para aprovação**: "O Atendimento WhatsApp pertence a outra empresa. Troque a empresa ativa no menu para usá-lo."

É a única mudança de código de tela prevista.

### 6.3 Coexistência das migrations 060/063/064/065

Hoje nenhuma suíte aplica as quatro juntas:
- as do atendimento rodam sobre `atual` e aplicam 060, 064 e 065 por conta própria;
- a do painel roda sobre o modelo `063`, que na árvore mesclada passa a conter a 060, porque o modelo segue o inventário.

Suíte nova `lib/whatsapp/atendimento/coexistencia-060-065.postgres.test.ts`:

| # | Cenário | Esperado |
| --- | --- | --- |
| K1 | Painel primeiro: modelo `063` (055…063, com a 060) → 064 → 065 | Os quatro postchecks oficiais (060, 063, 064, 065) passam no fim |
| K2 | Atendimento primeiro: modelo `062` (com a 060) → 064 → 065 → precheck + 063 + postcheck | Precheck da 063 ok com 064/065 presentes; os quatro postchecks passam |
| K3 | Rollback cruzado: 065 down → 064 down (com as variáveis de descarte quando houver dados) | O postcheck da 063 continua ok |
| K3b | Rollback cruzado: 063 down | 060/064/065 intactas (postchecks); depois tudo reaplica |
| K4 | Dados | Gravações nas tabelas de cada lado não interferem: um convite do painel e uma conversa do atendimento na mesma empresa |

**Execução PostgreSQL completa na árvore mesclada (equivalente à O2b), também justificada:**
- `painel-063` roda pela primeira vez sobre um modelo com a 060;
- `hg8-tenant` e `tenant-festa` rodam no estado `063`;
- as suítes do atendimento (060, 064, 065, concorrência);
- as duas suítes novas.

### 6.4 Gate completo na branch de verificação

1. `scripts/regressao-v1-estatica.cjs` (worker de PDF, unitários, harness, lint, `tsc`, build, PDF no asset), com log que registra HEAD e árvore limpa.
2. `production.test.mjs` (37/37 ou mais com os testes novos) e `check-migrations.mjs`.
3. PostgreSQL descartável (6.2, 6.3 e completa): cluster próprio, porta livre, nunca o `kidmais_manager`. **Precisa de autorização.**
4. Navegador curto. **Precisa de autorização.**
   - Login: Mostrar senha e `AvisoContexto`.
   - Troca de empresa ativa: piloto ↔ B.
   - Atendimento: identificação, "Voltar" e mensagens prontas.
   - Painel: entrada.
   - Zero saídas.
   - Os roteiros de UI do painel (`scripts/painel-multi-ui.cjs`, `painel-reauth-ui.cjs`) exigem app e banco, e ficam dentro desta etapa se o Felipe quiser.

### 6.5 Decisões pendentes do Felipe

1. **E4:** empresa ativa nula abre na piloto (contrato atual do painel) ou exige seleção explícita?
2. **Texto da recusa na tela** (6.2).
3. **Ordem de entrada em `staging`**: recomendação, o painel primeiro (seção 4).
4. **Autorizações:** a mescla de verificação (I1) e as rodadas de banco/navegador (I3/I4).
