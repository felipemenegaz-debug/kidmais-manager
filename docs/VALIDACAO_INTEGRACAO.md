# Integração local atendimento × painel — procedimento para autorização

**Situação:** preparada; **nada executado**. Sem mescla, banco, push ou deploy até a autorização explícita do Felipe ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)). Plano e regras de resolução: [PLANO_INTEGRACAO_ATENDIMENTO.md](PLANO_INTEGRACAO_ATENDIMENTO.md). Recomendação aceita pelo Felipe: **o painel entra primeiro em `staging`**.

## O que já está na candidata (`ba9f8c4`)

**Empresa ativa explícita com a 063, compatível sem ela** (`lib/whatsapp/atendimento/core.ts`, `conferirEmpresaAtiva`). Vale para toda entrada da tela (lista, ações, configuração e biblioteca), antes de abrir transação:

| Sessão | Resultado |
| --- | --- |
| Sem o campo `empresa_ativa_id` (sem a 063) | Comportamento anterior: a piloto, provada no banco |
| Com a 063, `empresa_ativa_id` = piloto | Abre |
| Com a 063, nula | `ATENDIMENTO_EMPRESA_NAO_SELECIONADA` (403): **seleção obrigatória**, mesmo com vínculo ativo |
| Com a 063, outra empresa | `ATENDIMENTO_EMPRESA_DIVERGENTE` (403) |
| Sem vínculo ativo na piloto (tenant não comprovado) | `ATENDIMENTO_SEM_ACESSO` (403). Antes, nas rotas da biblioteca, virava 503 genérico |

**Tela:** um bloco próprio para cada situação, e os dados já carregados somem quando o próximo carregamento é recusado. Textos atuais (podem ser ajustados):

| Situação | Título | Orientação |
| --- | --- | --- |
| Divergência | "A empresa ativa é outra" | "O Atendimento WhatsApp pertence a outra empresa. Troque a empresa ativa no menu para usá-lo." |
| Seleção pendente | "Selecione a empresa ativa" | "Nenhuma empresa está ativa nesta sessão. Selecione a empresa no menu para abrir o Atendimento WhatsApp." |
| Sem acesso (vínculo ou papel) | "Sem acesso ao Atendimento WhatsApp" | "Seu acesso nesta empresa não inclui o Atendimento WhatsApp. Peça a liberação a quem administra a empresa." |

**Testes:** núcleo, serviço (as recusas não consultam o banco), biblioteca, mapeamento 403 e tela. O teste da tela falha 5/6 no componente anterior.

**Gate completo em `ba9f8c4`:** PASS 1937/1937 + 103/103, lint, `tsc` e build. Log `.local-ux/check-v1-static-ba9f8c4.log` (SHA-256 `41160130…1fc851`).

## Pacote da integração (fora do Git, `.local-ux/integracao/`)

| Arquivo | Papel |
| --- | --- |
| `i1-mescla.sh` | I1. Fixa o HEAD da candidata; o hash está no `MANIFESTO.txt` |
| `i1-auxiliar.cjs`, `i1-mensagem.txt` | Resolução do I1 (trocar lados, login, seleção) e mensagem do commit |
| `arquivos/lib/whatsapp/atendimento/empresa-ativa.postgres.test.ts` | Suíte E2–E7 (6.2 do plano). Só compila na árvore mesclada |
| `arquivos/lib/whatsapp/atendimento/coexistencia-060-065.postgres.test.ts` | Suíte K1–K4 (6.3 do plano) |
| `teste-i1-offline.sh` | Prova a resolução sem mesclar o repositório: `git merge-file` em pasta temporária gera os mesmos conflitos; o resultado é idêntico ao da simulação das 19:01 |
| `pg/o0.sh`, `o1.sh`, `o2.sh`, `o4.ps1`, `teste-o4.ps1`, `retrato.ps1` | Rodada PostgreSQL (I3) |

SHA-256 dos arquivos fixos:

```
23b1d2e3f968d42f11593ac5b1432c3e06c1eb7257f4404e6b56729044673fd7 *integracao/i1-auxiliar.cjs
320df634d03310e3ec96649524d69e348198dc7af14e2f282f914ccb767d3785 *integracao/i1-mensagem.txt
85f58075a8617c401e186d8d10c1e4cabd6878e492eeebb14be138446a363127 *integracao/arquivos/.../empresa-ativa.postgres.test.ts
f81f275ca614d34e35d2eacc99014ec07d2deb7188cd9f8f94d3dddbca361cac *integracao/arquivos/.../coexistencia-060-065.postgres.test.ts
057dd37877d782a198239641754f64c9e5d95c554b14f7c2d8c498f117ffc33a *coordenacao-painel/resolver-inventario.mjs
4436db6d9bb950f578a7b0790656fa7dfef5be3677716b240b8f27290a39f431 *coordenacao-painel/simulacao-resolucao.diff
e6c3c6e5f63cb267cb9b60c484d2a4733c2ea1ba6571c7f8b18a5cf98a7988f3 *integracao/pg/o0.sh
4685d30814e15a271e591e993187f7cf46ba8343a7b9cc3e1ebda9c640de4f1d *integracao/pg/o1.sh
e26976d7780d99f53da429b560da0fc3afb95c2fde97cdbd7fb6ceb97d03be01 *integracao/pg/o2.sh
add4f8d2328f41436aab2198069bec776043eaccc493d53471bd2d5208eece4b *integracao/pg/o4.ps1
48d6467da682406c4100498180b6615d0b89e461f28766cc342c2213b06ef468 *integracao/pg/retrato.ps1
bc6b63bc6385d19a2f4384ba0f58e709343b392f581cde0287a78981b90e53a8 *val-prontas/guardas.ps1   (usado pelo retrato)
```

## Etapas e alvos

| # | Operação | Alvo | O que faz | Autorização |
| --- | --- | --- | --- | --- |
| I0 | `git fetch` + conferência de refs | leitura | Painel `ad6b1b9`, staging `904b451` (contido no painel), candidata = HEAD autorizado. Divergência = parar e reapresentar | — |
| I1 | `bash .local-ux/integracao/i1-mescla.sh` | Worktree **nova** `C:\Users\Glass\.codex\worktrees\0997\kidmais-integracao-painel`, branch local **`integracao/atendimento-x-painel`** (nunca publicada) | Mescla o painel (traz também a PR #93 de staging, 2 commits). Exige exatamente os 3 conflitos previstos e resolução idêntica à simulação. Copia as 2 suítes e as põe na seleção PostgreSQL. `production.test` + `check-migrations`. **1 commit local**; `node_modules` por hardlink (`cp -al`, nada baixado). Qualquer divergência desfaz worktree e branch | **Sim** (mescla) |
| I2 | Gate estático completo na worktree de I1 (`scripts/regressao-v1-estatica.cjs`), log com HEAD e árvore limpa | local | Unitários, harness, lint, `tsc`, build | Incluída em I1 |
| I3 | `retrato.ps1 -Rotulo antes` → `pg/o0.sh` → `o1.sh` → `o2.sh alvo` → `o2.sh completa` → `o4.ps1` → `retrato.ps1 -Rotulo depois` | Cluster **novo** em `C:\Users\Glass\AppData\Local\Temp\kidmais-pg-integracao\data` (não existe), **127.0.0.1:55500**, banco `kidmais_pacotes_v1_descartavel`, marca `# Validacao integracao atendimento x painel (descartavel)`, identidade `kidmais_descartavel\|127.0.0.1\|55500\|kidmais_descartavel\|postgres\|0\|C\|60\|<diretório>` | **Alvo:** empresa-ativa, coexistência, painel-063, 060/064/065, concorrência, hg8-tenant, tenant-festa. **Completa:** todas. O4 remove só o alvo | **Sim** (banco), no HEAD gerado por I1 (`.local-ux/integracao/HEAD-integracao.txt`) |
| I4 | Navegador curto na árvore mesclada | — | **Preparado depois de I1–I3.** Depende do fluxo de seleção de empresa do painel na árvore mesclada; nova base sintética com a 063 | Sim, à parte |

**Protegidos (só retratados, nunca tocados):**
- a demo parada (`…-4b6271`);
- `kidmais-pg-demo-atendimento`, `kidmais-pg-063`, `kidmais-pg-060` e `kidmais-pg-identificacao` (vazia);
- o cluster da outra sessão em `D:\glass\KidMais Manager\ambientes-locais\pg-painel-multi-codex-20261004`.

O retrato agora **mede** o estado: em execução só se o `postmaster.pid` aponta para um processo postgres vivo. Parado, o cluster é retratado com hash e precisa ficar idêntico antes e depois. Hoje todos aparecem parados; a demo tem um `postmaster.pid` antigo sem processo.

**Testes offline:**
- `teste-i1-offline.sh`: 12/12 com o HEAD preenchido;
- `pg/teste-o4.ps1`: 15/15;
- `val-prontas/teste-offline.ps1`: 59/59, incluindo o retrato medido.

**Fora desta etapa:** push, PR, merge em `staging`, banco remoto, deploy e Gupshup.
