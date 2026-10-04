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
| `i2-gate.sh` | I2: gate na worktree do I1 (confere branch, HEAD registrado e árvore limpa) |
| `pg/o0.sh`, `o1.sh`, `o2.sh`, `o4.ps1`, `teste-o4.ps1`, `retrato.ps1` | Rodada PostgreSQL (I3) |

## Identidade dos protegidos (corrigida antes da rodada de banco)

O retrato (`val-prontas/guardas.ps1`, usado pelo `vp.ps1` e por `pg/retrato.ps1`) agora **comprova** se o processo é o postmaster do diretório registrado. Ele usa os campos do `postmaster.pid` (PID, diretório, início em segundos Unix, porta) e o processo pelo CIM (nome, início, linha de comando).

| Situação | Resultado |
| --- | --- |
| `-D` da linha de comando = este diretório **e** início igual (±5 s) | Em execução |
| Linha de comando ilegível (processo de outro usuário), início igual **e** o servidor na porta registrada confirma o `data_directory` | Em execução |
| Sem `postmaster.pid`; PID sem processo; PID de processo que não é postgres | Parado (com hash) |
| **PID antigo reutilizado por outro postgres**: `-D` de outro diretório, ou início diferente do registrado | Parado (com hash) |
| `postmaster.pid` ilegível ou de outro diretório; `-D` igual com início diferente; linha ilegível sem confirmação do servidor | **INCONCLUSIVO**: sem retrato; o `vp.ps1` e o `retrato.ps1` **param** (o retrato fica gravado como evidência) |

**Por que importa:** nesta máquina rodam 17 processos postgres dos serviços 17/18, com linha de comando ilegível. A versão anterior marcava "em execução" qualquer postgres vivo no PID registrado e pulava o hash da pasta.

| Controle (`postmaster.pid` com o PID real de um postgres do serviço) | Resultado |
| --- | --- |
| Versão anterior | "em execução (... PID 6556, postgres)" |
| Versão nova | "parado (... reutilizado por outro postgres (início 13:40:11 ≠ registrado 04:20:21))" |

**Testes offline** (`val-prontas/teste-offline.ps1`): **74/74**.
- 12 combinações simuladas de identidade;
- retrato e `Test-VpRetratoInconclusivo`;
- dois casos com processos **reais**, só leitura: este PowerShell e um postgres do serviço.

**Retrato real de hoje:** todos os protegidos parados, com a mesma listagem antes da mudança (`pg/retrato-preparo-identidade.txt`).

**Evidências preservadas:** as versões anteriores dos scripts, manifestos e logs estão em `.local-ux/historico/antes-identidade-protegidos/` (`SHA256.txt`).

## Pedido de autorização 1 — I1 e I2 (mescla de verificação local + gate)

| Item | Valor |
| --- | --- |
| Candidata | HEAD fixado em `i1-mescla.sh` (o commit que traz este documento; no `MANIFESTO.txt`), árvore limpa |
| Refs exigidas | Painel `ad6b1b9`, `origin/staging` `904b451` (contido no painel). O I0 refaz o `git fetch`; divergência = parar e reapresentar |
| Alvo | Worktree **nova** `C:\Users\Glass\.codex\worktrees\0997\kidmais-integracao-painel`, branch local **`integracao/atendimento-x-painel`** (nunca publicada) |
| I1 | `bash .local-ux/integracao/i1-mescla.sh` |
| I2 | `bash .local-ux/integracao/i2-gate.sh` |
| Fora | Banco, push, PR, merge em `staging` e deploy |

**I1 — o que faz:**
- mescla o painel, o que traz também a PR #93 de staging (2 commits);
- exige exatamente os 3 conflitos previstos e uma resolução idêntica à simulação;
- acrescenta as 2 suítes à seleção PostgreSQL;
- roda `production.test` e `check-migrations`;
- faz **1 commit local** e copia o `node_modules` por hardlink (nada baixado);
- qualquer divergência desfaz a worktree e a branch.

**I2 — o que faz:** o gate completo na árvore integrada. Depois dele relato **HEAD, resultados e eventuais falhas**, e nada é corrigido no meio.

Hashes: seção "I1–I2" do `.local-ux/integracao/MANIFESTO.txt`.

## Pedido de autorização 2 — I3 (PostgreSQL descartável), só depois do relato do I2

| Item | Valor |
| --- | --- |
| HEAD | O da branch de verificação, gerado pelo I1 e relatado depois do I2 (`.local-ux/integracao/HEAD-integracao.txt`) |
| Cluster | **Novo**, em `C:\Users\Glass\AppData\Local\Temp\kidmais-pg-integracao\data` (não existe) |
| Endereço | **127.0.0.1:55500**, só loopback; banco `kidmais_pacotes_v1_descartavel` |
| Marca | `# Validacao integracao atendimento x painel (descartavel)` |
| Identidade exigida | `kidmais_descartavel\|127.0.0.1\|55500\|kidmais_descartavel\|postgres\|0\|C\|60\|<diretório>` |
| Sequência | `retrato.ps1 -Rotulo antes` (para se houver INCONCLUSIVO) → `o0.sh` → `o1.sh` → `o2.sh alvo` → `o2.sh completa` → `o4.ps1` → `retrato.ps1 -Rotulo depois` |
| Alvo da O2 | empresa-ativa, coexistência, painel-063, 060/064/065, concorrência, hg8-tenant, tenant-festa |
| Completa | todas as suítes |
| O4 | Remove só o alvo |
| Protegidos | A demo parada (`…-4b6271`), `kidmais-pg-demo-atendimento`, `kidmais-pg-063`, `kidmais-pg-060`, `kidmais-pg-identificacao` e o cluster da outra sessão em `D:\glass\KidMais Manager\ambientes-locais\pg-painel-multi-codex-20261004`. Retratados com identidade comprovada; antes e depois idênticos |

Hashes: seção "I3" do `.local-ux/integracao/MANIFESTO.txt`.

**I4 (navegador)** é preparado depois de I1–I3; depende do fluxo de seleção de empresa do painel na árvore mesclada.

**Testes offline:**
- `teste-i1-offline.sh`: 12/12;
- `pg/teste-o4.ps1`: 15/15;
- `val-prontas/teste-offline.ps1`: 74/74.
