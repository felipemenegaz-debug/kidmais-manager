# Etapa 4 — concorrência e reservas em PostgreSQL isolado (pacote de 10/10/2026)

> **Reaprovação de 25/10/2026 (inventário até a 100):** o roteiro estava fixado na 079 (`INVENTARIO_MUDOU` no teste offline). Ajustes, todos no roteiro e sem mudar a aplicação:
> - inventário até `20261025_100_agenda_um_salao.sql`, **sem a 098** (`EXCLUIDAS`): ela está pausada, fora de staging e production, e a 100 recusa banco com ela. Ficam 102 migrations e 265 arquivos, impressão `16f57be8…eb22`;
> - documentos sintéticos com DV oficial, porque a 091 recusa DV inválido;
> - ofertas com as versões vigentes dos documentos legais, exigidas pela 096;
> - inserções diretas de prova no grupo g com `origem = 'LEGADO'`, obrigatória desde a 090;
> - conferência final do grupo z com os postchecks da 090 e da 075 (evidência `postchecks: ['090', '075']`). O da 074a recusa os índices de vaga que a 090 trocou. O da 090 não reproduz todas as conferências gerais da 074a: não é substituição integral;
> - o grupo g prova o teto e a disputa por vagas LEGADO com a 090 instalada, não a campanha 090 ativa.
>
> **Execução C1–C6 (opção B) em cluster novo `.local-concorrencia-pg-<guid>` (127.0.0.1:55480): grupos a–h e z PASS, saída 0; cluster parado e removido.** Evidência em `ambientes-locais/pg-descartavel-renovacao-agendada-20261025-relatorios/concorrencia-100/` (fora do repositório).

> **Execução de 10/10/2026 (candidata `23a203a`):** C1–C3 ok; C4 exit 2 no grupo `a` antes de qualquer verificação (gerador de documento sintético, `readUIntBE` de 7 bytes); C4b/C5 ok; C6 não executado (pasta preservada). Ver [evidência](evidencias/pacotes-locais-concorrencia-navegador-20261010.md). Corrigido na nova candidata; a nova execução usa pasta nova.


> **Candidata fixada em 10/10/2026:** código `4337aa4510ea0a7ed876e44abdbd1f9df30527e1`. Este pacote está no commit seguinte, que altera só `docs/`; o SHA desse commit é o apresentado no pedido de aprovação e é o único que pode ser usado (`git diff --name-only 4337aa4510ea0a7ed876e44abdbd1f9df30527e1 HEAD` deve listar só `docs/`). Qualquer outra diferença: parar.

**Status: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.** Só um cluster PostgreSQL 18 **novo, local e descartável**, criado para esta execução por `scripts/cluster-descartavel-postgres.cjs`. Não toca o banco local real, staging, produção, Render, Asaas, GitHub ou e-mail. A [política](OPERACAO_AGENTES.md) exige autorização explícita de Felipe também para escrita em banco isolado: preparar este pacote não autoriza executá-lo. Cada passo C1–C6 abaixo é uma ação distinta; a aprovação deve dizer quais passos estão autorizados e se C6 remove a pasta ou a mantém.

## Objetivo

Comprovar com conexões reais disputando as mesmas travas que as vagas de pessoas por plano (`lib/assinatura/limites-usuarios.ts`) e as vagas Fundador (`lib/assinatura/ofertas.ts`, gatilho `kidmais_074_registro_guarda`) não excedem o limite, não duplicam e não tiram acessos existentes. A contagem deve ficar consistente e o teto Fundador de 20 deve ser preservado. É a validação prevista em [MATRIZ_RECURSOS_PLANOS_20261010.md](MATRIZ_RECURSOS_PLANOS_20261010.md), seção “Próxima validação independente preparada”, mais a reserva/liberação Fundador.

## Candidata

| Item | Valor |
|---|---|
| Commit candidato | código `4337aa4510ea0a7ed876e44abdbd1f9df30527e1`; pacote no commit seguinte (só `docs/`), SHA no pedido de aprovação |
| Base atual | `0619755` (`claude/kidmais-manager-sales-site-9b9a2d`) |
| Arquivos do pacote (novos) | `scripts/cluster-descartavel-postgres.cjs`, `scripts/cluster-descartavel-postgres.test.cjs`, `scripts/concorrencia-vagas-isolado.cjs`, `scripts/concorrencia-vagas-isolado.test.cjs` e este documento. Aplicação, migrations e scripts existentes não foram alterados |
| Conferência dos arquivos | `git rev-parse 4337aa4510ea0a7ed876e44abdbd1f9df30527e1:scripts/concorrencia-vagas-isolado.cjs` (e idem para os outros) deve coincidir com o blob listado no pedido de aprovação |
| Impressão do schema | `8a9a97477eac3d046dbd891bfd601df6e8f301f469247ef1e5e0f13403e03cfb`: 79 migrations do inventário aprovado (`scripts/production/check-migrations.mjs`, última `20261010_077_regras_pagamento_empresa.sql`) + prechecks/postchecks, 201 arquivos, sha256 com CRLF normalizado. **Recalculada em 10/10/2026 após a entrada de 076/077 no inventário: confere.** A impressão anterior (`ba653a17…0922`, 77 migrations, 195 arquivos, até a 075) deixou de valer. O executor recusa (`SCHEMA_DIVERGENTE_DO_PACOTE` / `INVENTARIO_MUDOU`) se ela mudar |
| Impressão do código sob teste | `6dcd75ff4934d223eebcb3f254c6bf0e54cbafda6816cddcc5336a8a90ec2a6d` (vagas, convites, ofertas, planos, 074a e a regra de prova Fundador). Informativa: `--plano` imprime o valor atual; divergência = parar e revisar |

### Migrations 076/077 no inventário (atualização de 10/10/2026)

- `20261010_076_cpf_por_empresa.sql` (índice único em `clientes`) e `20261010_077_regras_pagamento_empresa.sql` (tabela nova `empresa_regras_pagamento`) foram aplicadas em staging em 10/10/2026 ([evidência](evidencias/homologacao-planos-cotacao-staging-tentativa2-20261010.md), N3 PASS) e **agora fazem parte** do inventário aprovado de `check-migrations.mjs`, com o formato padrão (precheck → migration → postcheck). O executor aplica o inventário completo, portanto o banco descartável as terá. Em produção continuam `NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION`.
- Nenhuma das duas toca as tabelas exercitadas aqui (`convites_acesso`, `memberships`, `usuarios_administrativos`, `empresa_assinaturas`, `assinatura_*`). A matriz continua válida com elas.
- O executor fixa `ULTIMA_MIGRATION = 20261010_077_regras_pagamento_empresa.sql` e a `IMPRESSAO_SCHEMA` recalculada (`8a9a9747…3cfb`, 79 migrations / 201 arquivos), já na candidata acima.
- **Se o inventário aprovado mudar de novo**, o executor recusa antes de conectar. Será preciso atualizar `ULTIMA_MIGRATION` e `IMPRESSAO_SCHEMA` no executor, recalcular com `--plano`, revisar este pacote e pedir nova aprovação.

## Alvo exato

| Item | Valor |
|---|---|
| Binários | PostgreSQL **18** em `C:/Program Files/PostgreSQL/18/bin`, indicado por `KIDMAIS_PG_BIN` (não estão no `PATH` desta máquina). A ferramenta confere `initdb`, `pg_ctl` e `psql` por `--version` e recusa outra versão (`VERSAO_RECUSADA`) |
| Pasta | `.local-concorrencia-pg-<guid>` (guid de 32 hex) na raiz da worktree, ignorada pelo Git pela regra `.local-*/` do `.gitignore` (conferida; `criar` recusa se a regra faltar ou houver reinclusão). Dentro: marca `.kidmais-cluster-descartavel.json` (guid, nome, porta), `dados/` (initdb), `initdb.log`, `servidor.log`, `pg_ctl.log` e, depois, `resultado.json`/`progresso.log` |
| Rede | escuta só em `127.0.0.1`, porta **55480** (lista fechada da ferramenta: `kidmais_concorrencia`↔55480, `kidmais_navegador`↔55481; nenhuma outra). Diferente de 5432, 55498 (D3), 55475 (074/075) e 55458 (convites) |
| Papel / `cluster_name` | `kidmais_concorrencia` / `kidmais_concorrencia`, autenticação `trust` local (`initdb -A trust`). Se o servidor pedir senha, a conexão é recusada; nenhuma senha é carregada e o `psql` usa um arquivo de senhas inexistente |
| Banco | `kidmais_concorrencia_vagas_20261010`, criado pelo executor a partir de `template0` |
| Autorização literal | `KIDMAIS_CONCORRENCIA_AUTORIZACAO=127.0.0.1:55480/kidmais_concorrencia_vagas_20261010` |

### Guardas da ferramenta do cluster

- `plano` (padrão) só imprime; não executa binário, não cria pasta, não abre socket.
- Cada subcomando que muda algo exige a própria flag: `criar --criar-autorizado`, `iniciar --iniciar-autorizado`, `parar --parar-autorizado`, `remover --remover-autorizado`. Flag de outro subcomando, opção desconhecida ou repetida → recusa. `conferir` é só leitura (transação `READ ONLY`).
- Recusa `DATABASE_URL`/`PG*` herdadas; os processos filhos recebem só `PATH`, `SystemRoot` e afins.
- `iniciar` recusa porta já ocupada em 127.0.0.1, `postmaster.pid` existente e dados que não sejam PG 18. Passa `-c listen_addresses=127.0.0.1 -p 55480 -c cluster_name=kidmais_concorrencia`, que também ficam gravados no `postgresql.conf` do cluster.
- `conferir` exige versão 18.x, papel, endereço `127.0.0.1`, porta, `cluster_name`, `data_directory` igual a `<pasta>/dados` e bancos só de sistema (ou só o `--banco` informado, no padrão `kidmais_concorrencia_*`).
- `iniciar`, `conferir`, `parar` e `remover` só aceitam uma pasta filha direta da raiz, com nome `.local-<concorrencia|navegador>-pg-<guid>`, sem link/junção e com marca coerente com o nome e a lista fechada. Caminhos com `..`, absolutos fora da raiz e subpastas são recusados.
- `remover` exige, além disso, ausência de `postmaster.pid`, `pg_ctl status` = parado (código 3) e nenhum link dentro da pasta (ex.: `pg_tblspc`). Apaga só essa pasta.

### Guardas do executor (antes de abrir socket)

- Sem a flag única `--concorrencia-isolada-autorizada`, só imprime o plano offline.
- Autorização ausente ou malformada. Host diferente de `127.0.0.1`/`localhost` (sempre conecta em `127.0.0.1`). Porta 5432 ou fora de 1024–65535. Nome fora de `kidmais_concorrencia_[a-z0-9_]` ou que contenha o nome de um banco real.
- `DATABASE_URL` ou qualquer `PG*` no processo. Execução fora da raiz do repositório. Inventário ou impressão do schema diferente do pacote.

### Guardas do executor depois de conectar (antes de qualquer outro SQL)

- `current_database`, `current_user`, `inet_server_addr` = `127.0.0.1`, `inet_server_port` e `cluster_name` iguais aos esperados.
- **Cluster novo:** antes da criação, nenhum banco além de `postgres/template0/template1`. Depois, só o banco desta execução. O executor nunca substitui um banco existente.
- `fetch` global bloqueado (`REDE_PROIBIDA`), envio de e-mail dublado para falhar (`ENVIO_PROIBIDO`) e `ADMIN_AUTH_SECRET` sintético gerado no processo. Nenhum arquivo de ambiente é lido.

## Sequência

Windows PowerShell, na raiz da worktree, num único processo. Cada passo só roda se o anterior terminou com sucesso.

### Pré-condições (somente leitura; parar se alguma falhar)

```powershell
git diff --name-only 4337aa4510ea0a7ed876e44abdbd1f9df30527e1 HEAD          # só docs/ (HEAD = commit do pacote)
git diff --quiet HEAD -- lib database scripts/production scripts/homologacao-fundador-staging.cjs scripts/concorrencia-vagas-isolado.cjs scripts/cluster-descartavel-postgres.cjs; $LASTEXITCODE   # 0: código sob teste sem alteração local
Get-ChildItem Env: | Where-Object { $_.Name -eq 'DATABASE_URL' -or $_.Name -like 'PG*' }   # vazio
$env:KIDMAIS_PG_BIN = 'C:/Program Files/PostgreSQL/18/bin'
node scripts/cluster-descartavel-postgres.cjs plano --cluster kidmais_concorrencia         # gitignore.ignorada = true; binarios = a pasta acima
node scripts/concorrencia-vagas-isolado.cjs --plano                                         # confere = true; impressões iguais às da tabela Candidata
```

O `git diff --quiet` continua obrigatório: o executor carrega o código da árvore de trabalho, que precisa ser exatamente o da candidata.

### Passos (cada um depende da aprovação)

```powershell
# C1 — criar
$saida = node scripts/cluster-descartavel-postgres.cjs criar --cluster kidmais_concorrencia --criar-autorizado
if ($LASTEXITCODE -ne 0) { throw 'C1' }
$c = $saida | Out-String | ConvertFrom-Json; $pasta = $c.pasta; $dir = $c.caminho; $pasta

# C2 — iniciar
node scripts/cluster-descartavel-postgres.cjs iniciar --pasta $pasta --iniciar-autorizado
if ($LASTEXITCODE -ne 0) { throw 'C2' }

# C3 — conferir (leitura)
node scripts/cluster-descartavel-postgres.cjs conferir --pasta $pasta
if ($LASTEXITCODE -ne 0) { throw 'C3' }

# C4 — executor
$env:KIDMAIS_CONCORRENCIA_AUTORIZACAO = '127.0.0.1:55480/kidmais_concorrencia_vagas_20261010'
$p = Start-Process -FilePath node -ArgumentList '--experimental-strip-types','scripts/concorrencia-vagas-isolado.cjs','--concorrencia-isolada-autorizada' `
    -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $dir 'resultado.json') -RedirectStandardError (Join-Path $dir 'progresso.log')
Remove-Item Env:KIDMAIS_CONCORRENCIA_AUTORIZACAO
$p.ExitCode

# C4b — conferir de novo (leitura)
node scripts/cluster-descartavel-postgres.cjs conferir --pasta $pasta --banco kidmais_concorrencia_vagas_20261010

# C5 — parar
node scripts/cluster-descartavel-postgres.cjs parar --pasta $pasta --parar-autorizado

# C6 — remover (agora na opção B; depois da revisão na opção A)
node scripts/cluster-descartavel-postgres.cjs remover --pasta $pasta --remover-autorizado
```

| # | Efeito |
|---|---|
| C1 | Cria `.local-concorrencia-pg-<guid>` com a marca, roda `initdb -D <pasta>/dados -U kidmais_concorrencia -A trust --encoding=UTF8 --locale=C` e grava `listen_addresses/port/cluster_name` no `postgresql.conf`. Imprime `pasta` e `caminho` |
| C2 | Confere porta livre e inicia o servidor em `127.0.0.1:55480` (`pg_ctl ... -w -t 60 start`) |
| C3 | Leitura: `resultado: CONFERE`, versão 18, `bancos: []` |
| C4 | Cria o banco, aplica o schema completo e roda os grupos a–z. Saída em `<pasta>/resultado.json` (resumo JSON sanitizado) e `<pasta>/progresso.log` (`PASS x` por grupo). Código 0 = PASS, 2 = divergência na matriz, 1 = recusa antes de escrever |
| C4b | Leitura: confirma que o cluster só tem o banco desta execução |
| C5 | `pg_ctl -m fast -w stop`; os dados ficam na pasta |
| C6 | Escolha de Felipe. **(A, recomendado)** manter a pasta parada até revisar `resultado.json` e registrar a evidência sanitizada em `docs/evidencias/`; depois remover. **(B)** remover logo após C5. Nos dois casos apaga só a pasta marcada |

Em outra sessão, a pasta é localizada com `Get-ChildItem -Directory -Force -Filter '.local-concorrencia-pg-*'`.

Duração estimada: initdb + início < 1 min; schema ~1–2 min; grupos ~1–3 min (scrypt real nos aceites). Custo zero; nenhuma rede além de loopback.

## Efeitos

- **Criado:** a pasta `.local-concorrencia-pg-<guid>` e tudo dentro dela. Nela ficam o cluster, o banco `kidmais_concorrencia_vagas_20261010` com o schema completo (79 migrations, incluindo 076/077), a fixture histórica da 046 e as fixtures sintéticas: 28 empresas `TESTE concorrência …` com códigos `cv-…`, e-mails `cv-…@example.invalid`, documentos sintéticos de 14 dígitos, hashes de senha falsos para Gestão, senha dos aceites só em memória e provedor de cobrança falso com IDs `sub_cv_…`/`pay_cv_…`.
- **Durante C2–C5:** um processo `postgres.exe` do usuário atual escutando em `127.0.0.1:55480` com `trust`. Qualquer processo local poderia conectar nessa janela. O risco é aceito porque a escuta é só loopback, a janela é curta e os dados são sintéticos. Não registra serviço do Windows nem altera firewall. Se o Windows exibir um aviso de firewall para `postgres.exe`, não liberar: loopback não precisa.
- **Destruído pelo executor:** nada. Sem `DROP`, `DELETE`, `TRUNCATE` ou gatilho desligado. As transições recusadas são revertidas por `ROLLBACK`. A expiração de convite é simulada com `expira_em = criado_em + 1 ms`, aceita pela guarda 063 enquanto o convite está `PENDENTE`.
- **Removido em C6:** só a pasta marcada.
- **Efeitos permanentes fora da pasta:** nenhum. Nada remoto, nenhum segredo, nenhuma configuração do sistema, nenhum arquivo versionado. `git status` não mostra a pasta, porque ela é ignorada.

## Matriz de aceite

Os comportamentos passam pelos serviços reais: `criarConviteNaTransacao`, `renovarConviteNaTransacao`, `cancelarConviteNaTransacao`, `aceitarConvite`, `consultarVagas`/`exigirVaga`, `prepararOferta` e `confirmarOfertaPaga`, carregados com o dublê de banco das suítes 063. SQL direto só monta fixtures, simula o tempo e prova recusas do banco.

**Disputa determinística:** a 1ª conexão segura a trava. O executor comprova em `pg_stat_activity` que a 2ª está em espera de `Lock` antes de confirmar a 1ª. Sem espera comprovada → falha (`SEM_ESPERA_POR_TRAVA`).

**Rajada:** N conexões abrem a transação antes e disparam juntas.

| Grupo | Esperado |
|---|---|
| a — última vaga Essencial (3) | Disputa determinística: 1ª reserva e 2ª `LIMITE_USUARIOS_PLANO` depois da espera. Depois de cancelar uma reserva, uma rajada de 6 tem 1 sucesso e 5 `LIMITE_USUARIOS_PLANO`. Ocupação = 3 e `disponiveis` = 0 |
| b — aceite | Empresa cheia com convite: o aceite cria uma pessoa ativa e a ocupação continua 3 (ativos 2, pendentes 1). Dois aceites simultâneos do mesmo token: 1 sucesso e 1 `LINK_INVALIDO`, com 1 identidade e 1 vínculo. Reaceite = `LINK_INVALIDO`. Novo convite = `LIMITE_USUARIOS_PLANO` |
| c — cancelar, vencer, reenviar | Cancelar libera a vaga. O convite vencido deixa de contar e não é aceito (`LINK_INVALIDO`). O reenvio de convite válido não ocupa outra vaga. O reenvio de convite vencido disputa vaga nova nas duas ordens: reenvio primeiro → novo convite `LIMITE`; novo convite primeiro → reenvio `LIMITE`. Ocupação nunca passa de 3 |
| d — rollback | Falha depois de `criarConviteNaTransacao` não deixa convite e mantém a ocupação. Falha no fim do aceite (auditoria) não deixa identidade nem vínculo, o convite continua `PENDENTE` e a ocupação continua 3. A repetição aceita normalmente |
| e — acima da cota | 4 pessoas ativas no teste, sem teto, e depois o Essencial confirmado: `excedido` = true. Convite e rajada de 3 → `LIMITE_USUARIOS_PLANO`. Os 4 vínculos continuam `ATIVA`, as 4 sessões continuam válidas e `provarTenant` funciona para os 4 |
| f — demais planos | Profissional com 9 ocupadas: 2 conexões → 1 sucesso, 1 `LIMITE`. Ocupação 10 e o próximo é recusado. Premium aceita 12 convites, com limite `null`. Isenta, em teste e sem assinatura: 5 convites cada e `consultarVagas` = `null` |
| g — 20ª vaga Fundador | 19 vagas ocupadas: disputa determinística por `pg_advisory_xact_lock` → 1 reserva com 40% e 1 `FUNDADOR_AGUARDANDO`. Rajada de mais 4 → todas aguardam. Valor regular também aguarda e quem aguarda não tem contratação. Vaga 21 → `23514`; número repetido → `23505`. Ocupadas = 20, números distintos = 20, maior = 20 |
| h — liberação | `RESERVADA → LIBERADA` com contratação aberta → recusa do gatilho. Evidência paga ou incompleta (`cancelamentoComprovado` da rodada Fundador) mantém a reserva. Evidência de cobrança removida → contratação `CANCELADA` e vaga `LIBERADA` na mesma transação. Reliberar ou reabrir → recusa. Duas conexões disputam a vaga liberada: 1 reserva o mesmo número e 1 aguarda. `CONFIRMADA → LIBERADA` e cancelar contratação confirmada → recusa. Teto continua 20 |
| z — consistência | Ocupação final por empresa = esperado (a3 b3 c3 d3 e4 p10 m13). Nenhum vínculo duplicado nem convite pendente duplicado. Vínculos ativos = 13, sem perda de acesso. Vaga e contratação coerentes (liberada ↔ cancelada, confirmada ↔ confirmada). Postchecks 074a e 075 aprovados |

Resultado aceito: `"resultado": "PASS"` com os 9 grupos em `resultado.json` e código de saída 0. A saída contém só contagens, códigos e eventos de espera; e-mails, UUIDs, tokens e hashes são mascarados.

## Critérios de parada

- **S0 — pré-condição:** `git diff --name-only 4337aa4510ea0a7ed876e44abdbd1f9df30527e1 HEAD` com algo fora de `docs/`, alteração local no código sob teste, `DATABASE_URL`/`PG*` presente, binários ausentes ou ≠ 18, regra `.local-*/` ausente, impressão do schema ou do código divergente. Nada é criado.
- **S1 — cluster:** C1 ou C2 com falha (inclusive `PORTA_OCUPADA`), ou C3 diferente de `CONFERE` com `bancos: []`. Não seguir para C4.
- **S2 — alvo do executor:** qualquer guarda anterior à conexão, identidade divergente, cluster com outro banco, servidor pedindo senha. Código 1; nada é escrito.
- **S3 — matriz:** a primeira divergência interrompe os grupos seguintes. O resumo traz `falha.grupo`, código e mensagem sanitizada; código 2. O banco fica preservado para inspeção (C5 e opção A de C6), sem nova execução no mesmo cluster.
- Em qualquer parada: não improvisar outro cluster, outra porta, outro banco ou outro binário sem nova aprovação.

## Recuperação

| Situação | Ação |
|---|---|
| C1 falhou (`INITDB_FALHOU`) | A pasta parcial tem a marca: `remover --pasta $pasta --remover-autorizado` (sem servidor, não precisa de `pg_ctl status`). Nova tentativa começa em C1 com outro guid |
| C2 falhou | Ler `<pasta>/pg_ctl.log` e `servidor.log`. Se `postmaster.pid` existir, `parar`; depois `remover`. `PORTA_OCUPADA`: nada foi iniciado; não trocar de porta sem aprovação |
| C3/C4b divergente, C4 com código 1 ou 2 | `parar`; manter a pasta para inspeção (C6-A). Uma nova execução exige cluster novo (C1) e nova aprovação; nunca reaproveitar o banco |
| Servidor preso ou sessão interrompida | `parar --pasta <pasta> --parar-autorizado` (localizar a pasta pelo filtro acima) |
| `postmaster.pid` órfão (processo morto, `parar` falha) | Conferir que não há `postgres.exe` com a pasta na linha de comando (`Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" \| Where-Object CommandLine -like "*$pasta*"`). Se não houver, apagar só `<pasta>/dados/postmaster.pid` com autorização própria e então `remover` |
| Código | Os cinco arquivos são novos; reverter o commit que os adicionar |

Nenhum ambiente remoto, segredo ou configuração é alterado, então não há recuperação remota.

## Riscos declarados

- **Dublê de banco:** os serviços rodam sobre um pool de teste de 8 conexões verificadas, e não sobre `lib/db/postgres.ts`, que exige `DATABASE_URL` e que esta execução proíbe. As travas, a ordem dos `FOR UPDATE` e as transações são as reais.
- **Fixtures por SQL:** empresas, Gestão e isenção são inseridas diretamente, mas passam pelos gatilhos 044/063/068/074. O contrato confirmado passa por `prepararOferta` e `confirmarOfertaPaga`, com provedor falso. A ativação de `empresa_assinaturas` segue a mesma `UPDATE` da homologação 074/075.
- **Vagas Fundador:** as empresas de vagas (a–f) também reservam e confirmam Fundador porque a campanha está aberta no banco novo. Isso só define o ponto de partida do grupo g (7 confirmadas).
- **Tempo:** a expiração é simulada por `UPDATE` permitido pela guarda. Não há relógio adiantado nem gatilho desligado.
- **Cenários:** a ordem em disputas não determinísticas (rajadas) varia de uma execução para outra. Os grupos determinísticos fixam a ordem que o critério exige.
- **Ferramenta do cluster:** testada só com binários falsos. C1–C3 são o primeiro uso real de `initdb`/`pg_ctl`/`psql` por ela; uma falha ali para em S1, sem efeito fora da pasta.
- **`trust` em loopback:** ver Efeitos.

## O que esta execução não comprova

- HTTP, CSRF, sessão no navegador e rotas `app/api/**`: só serviços e banco.
- Criação direta de usuário pela empresa (`lib/autenticacao/usuarios.ts`) e reativação de vínculo pelo painel (`lib/desenvolvedor/vinculos.ts`): também chamam `exigirVaga`, mas não são exercitadas aqui.
- Prova real de cobrança removida no Asaas: aqui a evidência é sintética. A regra (`cancelamentoComprovado`) é a mesma da rodada Fundador, e o comportamento do Asaas é tratado na [sonda](SONDA_COBRANCA_REMOVIDA_ASAAS_20261010.md).
- Carga alta (dezenas de conexões), failover, `pgbouncer`, latência de rede e o pool de produção. Não substitui a homologação em staging nem autoriza ligar planos.
- Renovação e aviso de 30 dias (Etapa 5).

## Uso pela frente de testes de navegador

A mesma ferramenta atende o cluster `kidmais_navegador` (porta 55481, pasta `.local-navegador-pg-<guid>`, bancos `kidmais_navegador_*`) com os mesmos subcomandos e flags. As duas frentes têm porta, papel, `cluster_name` e pasta distintos, e uma não consegue operar a pasta da outra com o nome errado. Essa frente precisa de pacote e aprovação próprios; este pacote não a autoriza.

## Evidências locais (sem banco)

| Validação | Resultado |
|---|---|
| `node --test scripts/concorrencia-vagas-isolado.test.cjs scripts/cluster-descartavel-postgres.test.cjs` | 24/24 (10 do executor, 14 da ferramenta; binários falsos, pastas temporárias) |
| `node scripts/concorrencia-vagas-isolado.cjs --plano` | plano offline, `conexao: false`, `confere: true`, impressões acima |
| `node scripts/cluster-descartavel-postgres.cjs plano` | só imprime; `gitignore.ignorada: true`; nenhuma pasta criada |
| `npx eslint` nos quatro scripts | 0 erros, 0 avisos |
| Cluster, banco e grupos a–z em PostgreSQL | **não executados** |
