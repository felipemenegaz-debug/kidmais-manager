# Plano de integração — Atendimento WhatsApp × painel do desenvolvedor × staging

**Situação:** plano. Nada foi executado fora desta máquina: sem push, merge, deploy, migration ou leitura de banco remoto. Cada passo remoto precisa de autorização própria do Felipe ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)).

## 1. Refs (leitura de 04/10/2026, `git fetch` às 19:00)

| Ref | Commit | Arquivos de migration 06x |
| --- | --- | --- |
| `origin/staging` | `904b451` | até a 062 |
| `origin/production` | `650e268` | até a 062 |
| `origin/feat/painel-desenvolvedor-20261004` (outra sessão) | `ad6b1b9`, de 18:51. Passou por `2b6702a` → `660c216` → `ad6b1b9` só nesta tarde | 063 `painel_desenvolvedor` |
| `codex/painel-multi-20261004` (local, outra sessão) | `c0158d4` | 063 |
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
| I1 | Mesclar `origin/staging` atualizado (e o painel, se já estiver nele) na candidata, com as regras da seção 3; commit local | local | Felipe (é a mescla) |
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
