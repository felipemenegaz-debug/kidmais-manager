# Integração local atendimento × painel — procedimento para autorização

**Situação:** I1–I2 executados (ok) e I3 executado até a O2 alvo (**4/13 falhas**, parado e encerrado); correções preparadas e repetição proposta ao final. Antes: preparada; nada executado. Sem mescla, banco, push ou deploy até a autorização explícita do Felipe ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)). Plano e regras de resolução: [PLANO_INTEGRACAO_ATENDIMENTO.md](PLANO_INTEGRACAO_ATENDIMENTO.md). Recomendação aceita pelo Felipe: **o painel entra primeiro em `staging`**.

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

## Resultados (04/10/2026)

**I1–I2 (autorizados), HEAD integrado `2442f37`:**
- I1: 3 conflitos previstos; resolução idêntica à simulação; `production.test` 37/37; `check-migrations` PASS.
- I2: unitários **1998/1998**, harness 103/103, lint sem erros, `tsc` e build ok.

Evidências em `.local-ux/integracao/EVIDENCIAS-I1-I2.txt`.

**I3 (autorizado), `2442f37`, 127.0.0.1:55500:**
- retrato antes, O0 e O1 (identidade exata): ok.
- **O2 alvo: 9/13 ok, 4 FALHAS**, sem correção nem retomada:

| Suíte | Modelo | Resultado |
| --- | --- | --- |
| painel-063 (pela primeira vez com a 060 no modelo) | — | ok |
| coexistência 060/063/064/065 | — | ok |
| tenant-festa | atual/061/062/063 | ok |
| hg8-tenant | atual/063 | ok |
| concorrência | — | ok |
| migration-060 | — | **falhou**: esperava a mensagem crua do tenant; a recusa chega como `ATENDIMENTO_SEM_ACESSO` |
| migration-064 | — | **falhou**: idem |
| migration-065 | — | **falhou**: idem |
| empresa-ativa | — | **falhou** em E3 "configurar": a configuração de teste era inválida e o serviço validava o conteúdo antes do acesso. E4–E6 não rodaram |

**Encerramento autorizado, 20:45:**
- O4 removeu só `kidmais-pg-integracao\data`, com a identidade reconfirmada.
- Retrato depois: listagens e hashes idênticos.
- O `retrato.ps1` acusou divergência **só no motivo** da linha da demo: o PID antigo 45140 do `postmaster.pid` (inalterado, `87D6A8CA…`) passou a ser um `cmd.exe` desta sessão. Era um falso positivo da comparação.
- Log bloqueado conferido depois do encerramento: `21e72415…7b9278`.
- Evidências em `.local-ux/integracao/pg/rodada-2442f37/`.

## Correções (candidata `e11d7a7`, só local)

**Código:** `salvarConfiguracao` confere empresa ativa, vínculo e papel **antes** de validar a configuração.

**Testes:**
- Suítes 060/064/065: 4 asserções passam a esperar `ATENDIMENTO_SEM_ACESSO`, inclusive a do vínculo PENDENTE, que nem chegou a rodar.
- Unitário: recusa com **configuração inválida**. As 4 situações de acesso (seleção pendente, divergência, sem vínculo, papel) vencem a validação, e nada é gravado; com acesso, a validação recusa.
- Guarda estática: nenhuma suíte PostgreSQL do atendimento espera a mensagem antiga; roda no gate, sem banco.

Os dois testes novos falham na versão anterior.

**Pacote** (`arquivos/.../empresa-ativa.postgres.test.ts`): em E3–E6, configurar é recusado pelo acesso com configuração válida **e** inválida.

**Retrato** (`val-prontas/guardas.ps1`, `vp.ps1`, `pg/retrato.ps1`):
- antes/depois compara a **chave estável** (caminho, estado, itens, hash);
- o motivo entre parênteses fica informativo e é listado quando muda;
- `teste-offline.ps1`: **79/79**, incluindo o par real da rodada `2442f37` (2 diferenças brutas, 0 por chave).

## Repetição proposta (cada pedido com autorização própria)

**Pedido A — I1b + I2.**

| Item | Valor |
| --- | --- |
| Base | A mesma worktree e branch de verificação (`2442f37`, sem upstream) |
| I1b | `bash .local-ux/integracao/i1b-atualiza.sh` |
| I2 | `bash .local-ux/integracao/i2-gate.sh` (inalterado) |
| Fora | Banco, push e deploy |

O I1b:
- confere a candidata (HEAD pinado), o painel (`ad6b1b9`, sem nova mescla) e a worktree em `2442f37` limpa;
- mescla a candidata, sem conflito esperado, e troca a suíte empresa-ativa pela do pacote;
- aceita só os arquivos esperados e roda o `production.test`;
- faz **1 commit local** e preserva `HEAD-integracao-2442f37.txt`;
- em qualquer divergência, `merge --abort` e para.

O teste offline `teste-i1b-offline.sh` usa `git merge-tree`, sem tocar em worktree.

**Pedido B — I3 completo**, só depois do relato do I2: a mesma sequência e o mesmo alvo da rodada anterior.
1. `retrato.ps1 antes` → `o0` → `o1` → `o2 alvo` → `o2 completa` → `o4` → `retrato.ps1 depois`.
2. Alvo `C:\Users\Glass\AppData\Local\Temp\kidmais-pg-integracao\data` (removido; a pasta-mãe vazia fica), porta 55500.
3. `o0`/`o1`/`o2`/`o4` inalterados; `retrato.ps1` e `guardas.ps1` com hashes novos.

Hashes de A e B: `.local-ux/integracao/MANIFESTO.txt`.
