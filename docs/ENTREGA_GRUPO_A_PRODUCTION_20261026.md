# Entrega dos aplicadores do grupo A em produção (B-4, 26/10/2026)

> **31/10/2026 — a 099 saiu deste pacote (rodada 16, LOCAL, sem commit; ver a última seção).** O aplicador da 099 chegou a production pelo próprio deploy (E-1, #288, `733e39ad`) e a 099 foi aplicada em 31/10/2026 (`APLICADA_POSTCHECK_PASS`, depois `JA_APLICADA_POSTCHECK_PASS`); o código de Convites avulsos está LIVE (E-2, #290, `5bdd5ac4`). O B-4 agora transporta **só o B-1**: 22 arquivos em 5 partes, modos `PARTE-1..5`, `CONFERIR-092-093`, `APLICAR-092-093` e `LIMPEZA`. No E3 a 099 é **pré-condição já aplicada**, possivelmente com convites avulsos em uso: conferida com o aplicador do artefato publicado, nunca entregue, aplicada nem desfeita por estes blocos (sem down automático), e o marcador `data/convites-avulsos-099-producao/migration-099.json` é preservado. As seções abaixo descrevem o desenho vigente; as rodadas 1–15 ficam como histórico (lá aparecem os modos da 099, que não existem mais).

Estado: **implementação LOCAL**, sem commit; **rodada 1 da revisão corrigida** (P2-1, P2-2, P3-1, item 4 e 091). Clone `kidmais-manager-entrega-grupo-a-production-20261026`, branch `codex/entrega-grupo-a-production-20261026`, sobre staging `a590d247bb11a8e687447707dc0c368ac20b07db`. Nada foi colado em nenhum Shell e nada rodou em nenhum banco. Este documento não autoriza execução.

Origem: B-4 do plano de promoção (`PLANO_PROMOCAO_PRODUCTION_20261025.md`, §5 e §12; decisão D-OP-2 = opção **(a)**, bloco autossuficiente). No E3, o artefato publicado em produção ainda é o antigo (`00d3019a`). Ele tem o aplicador da 089, mas não tem os da 091, 092/093 (B-1, escopo `092-093`) nem o da 099 (B-2), conferido nos objetos do git. Sem a entrega, o E3 não roda.

## Composição desta árvore

O B-1 e o B-2 aprovados vivem em clones próprios, sem commit. Para o B-4 ter os arquivos reais, os dois diffs foram aplicados aqui e **ficam no índice do git** (staged). O B-4 é só o que está fora do índice (`git diff`, com `git add -N` nos arquivos novos):

| Origem | Patch aplicado | Conferência |
| --- | --- | --- |
| B-1 (`kidmais-manager-aplicador-092-094-production-20261025`) | `git diff --binary` sha `e88daa64…` | 9 arquivos com o mesmo sha256 do clone aprovado |
| B-2 (`kidmais-manager-aplicador-099-production-20261025`) | `git diff --binary` sha `f7832198…` | 7 arquivos com o mesmo sha256 do clone aprovado |

Os arquivos do B-1/B-2 não mudaram entre a base deles (`54598a92`) e `a590d247`. O `ci.yml` composto junta os passos dos dois sem conflito. Composição no índice: `git diff --cached --binary` sha `2c020b00…`.

## O que o B-4 acrescenta

| Arquivo | Conteúdo |
| --- | --- |
| `scripts/bloco-shell-entrega-grupo-a-producao.cjs` | gerador dos blocos de entrega, no desenho dos blocos de produção de 19/10/2026 (`bloco-shell-migracoes-producao-20261019.cjs`), mais o carregador conferido, o destino físico e o backup verificado |
| `scripts/bloco-shell-entrega-grupo-a-producao.test.cjs` | 24 testes com bash real em deploy temporário |
| `.github/workflows/ci.yml` | passo novo para a suíte |

### Blocos

| Bloco | Faz | Banco |
| --- | --- | --- |
| `PARTE-1-DE-N` … `PARTE-N-DE-N` | transportam os arquivos do bloco de produção do B-1 (desde 31/10/2026, sem a 099: 22 arquivos em 5 partes, com as dependências da 107/108; na consolidação, com a 099, eram 28 em 6; antes 21 em 3) (gzip+base64) para `/opt/render/project/src/.kidmais-entrega-grupo-a-producao/.partes/<sha256>`. Cada arquivo é conferido por sha256, e todos os itens da parte são conferidos antes de gravar o primeiro. Repetir é seguro (`JA_PRESENTE` só com o sha certo) | não conecta |
| `CONFERIR-092-093` | exige todas as partes íntegras, monta a pasta própria e roda `--conferir-092-093` (B-1) | só leitura |
| `APLICAR-092-093` | confere o backup do E2 antes de tudo, monta e roda `--aplicar-092-093-autorizado --backup <registro>`. Nunca aplica a 094 (garantia do B-1) | DDL, autorização própria |
| `LIMPEZA` | remove da pasta própria só o que tem o sha esperado, preserva divergentes, nunca toca o deploy nem `data/` (inclusive o marcador da 099); sem a pasta, `NADA_A_LIMPAR` | não conecta |

A 099 não tem bloco aqui: `CONFERIR-099`/`APLICAR-099` são `MODO_DESCONHECIDO`.

Tamanhos com a árvore atual (rótulo `a590d24`): partes de 28,0 KB, 23,8 KB e 26,4 KB; curtos de 5,2 a 6,6 KB; LIMPEZA 4,7 KB. Todos abaixo da maior colagem comprovada no Web Shell (35,9 KB).

### Garantias de desenho

- **Carregador conferido (P2-2):** o bloco colado tem só os comentários, o `bind`, a guarda de serviço e um carregador mínimo. Todo o programa de controle (o "corpo") vai codificado num heredoc e só roda, num `bash` próprio sem `BASH_ENV`/`ENV`, se o sha256 dele bater com o fixado no carregador. Perder uma linha do corpo que altere o texto decodificado dá `CORPO_DIVERGENTE`, código 4, e nada é executado. A garantia é que o que executa é sempre o corpo conferido, não que toda linha perdida seja detectada: perder só a última linha base64 (o final do gzip) ou só o `umask 077` pode executar o corpo íntegro normalmente. `CODIGO_SAIDA_BLOCO=0` só pode ser impresso pelo corpo conferido (no `trap` de saída dele); o carregador só imprime 4. Se faltar uma linha do carregador, o resultado é 4, nenhuma linha de código ou, quando a linha perdida não muda os bytes conferidos (o `umask 077`, por exemplo), a execução normal do corpo conferido; sem o 0 impresso pelo corpo, a regra é parar e ler. O sha confere os bytes do corpo, não a origem do arquivo nem que o carregador foi colado inteiro. O corpo repete a guarda de serviço, então perder a linha da guarda não basta para rodar em outro serviço.
- **Destino físico (P2-1):** no gerador, o destino é normalizado e só aceito como um único nome `.kidmais-…` diretamente sob o deploy. Nunca o próprio deploy, nada fora dele, nada dentro de `data/` e nada com `..`. No Shell, antes de criar, transportar, montar ou limpar:
  - o destino não pode ser link ou junção, e se existir precisa ser pasta;
  - depois de entrar nele, `pwd -P` precisa ser exatamente `<deploy físico>/<nome>`;
  - nenhum link pode existir dentro da pasta (`find -type l`): subpastas, `.partes` e arquivos.
  O sha prova o conteúdo; agora o lugar também é provado.
- **Reconferência no ponto de uso (P2-2):** `JA_PRESENTE` só vale com o sha certo, tanto nas partes quanto na montagem. Um arquivo existente com outro conteúdo para com 4 mesmo que a linha de conferência prévia tenha sido perdida.
- **Backup verificável (item 4):** os blocos APLICAR exigem `KIDMAIS_REGISTRO_BACKUP=backup-<uuid>.json`, o nome exato do registro gravado pela ferramenta do E2 (`scripts/backup-lancamento-production.cjs`, padrão P1, presente no artefato publicado), em `data/lancamento-venda-20261011`. Antes de tocar em qualquer arquivo, o bloco confere:
  - pasta, registro e dump sem link, presentes, e dump não vazio;
  - o sha256 do dump, recalculado no Shell, igual ao do registro;
  - serviço `srv-dak77m2d0e5s73b8rkkg`, banco `kidmais_production`, `arquivo` coerente com o nome e `arquivoIntegralmenteLido: true`;
  - `criadoEm` e `pitrConferidoEm` há menos de 24 h (nem no futuro).
  Ao aplicador vai o caminho relativo do registro, que fica no marcador. Limite que continua: o PITR é declarado pelo operador à ferramenta do E2 (datado e gravado, mas não verificável do Shell), e a restaurabilidade real é o B-12.
- **Uma só lista de arquivos:** é exatamente `arquivos('production')` do bloco de produção do B-1 (22 com as dependências da 107/108; a do B-2 saiu em 31/10/2026). Os geradores de origem recusam SQL divergente do hash revisado. A lista inclui os SQL da 094 e a integridade da 094 após a 100, porque o aplicador do B-1 confere os hashes de toda a trilha; o escopo `092-093` nunca os aplica.
- **O aplicador roda da pasta própria:** o `raiz` dos aplicadores é a pasta deles, então eles leem os SQL transportados e nunca os do deploy. O `node_modules` é o do deploy (`NODE_PATH`), com `pg` exigido antes de montar. O marcador do escopo fica em `data/agenda-precos-092-094-producao`; o da 099 (`data/convites-avulsos-099-producao`, gravado na aplicação de 31/10/2026) não é lido nem escrito por estes blocos.
- Comum aos blocos: `bind` antes da guarda; código 0/1/2/3 do aplicador e 4 do bloco; o `trap` preserva o código (inclusive sinais); ASCII.

## Uso no E3 (artefato de revisão — não executar sem autorização)

1. Gerar os blocos **da árvore integrada final**: `node scripts/bloco-shell-entrega-grupo-a-producao.cjs TODOS <commit> <pasta-nova>`. Conferir sha256 e bytes de cada bloco antes de colar, e conferir que os scripts e SQL da árvore têm os hashes dos pacotes aprovados (o rótulo não comprova a árvore).
2. E2 concluído: registro `backup-<uuid>.json` gravado pela ferramenta do E2 há menos de 24 h. O backup e a recuperação da promoção partem de uma base **com a 099** (e possivelmente convites avulsos): restaurar um backup de antes de 31/10/2026 perderia a 099 e os avulsos.
3. **Pré-condição da 099** (somente leitura, com o aplicador do próprio artefato publicado; não é bloco deste pacote): no Web Shell, `node scripts/migration-099-production.cjs --conferir-099` → `JA_APLICADA_POSTCHECK_PASS`, e o marcador `data/convites-avulsos-099-producao/migration-099.json` presente. Qualquer outro resultado: parar e seguir o ENC; **nunca** aplicar nem desfazer a 099 na janela.
4. Web Shell do `srv-dak77m2d0e5s73b8rkkg`, na mesma sessão: `export KIDMAIS_REGISTRO_BACKUP=backup-<uuid>.json`; colar `PARTE-1` … `PARTE-5` (uma vez cada; repetir é seguro).
5. `CONFERIR-092-093` → (autorização, janela) → `CONFERIR-092-093` imediatamente antes → `APLICAR-092-093` → `CONFERIR-092-093` (094 **ausente**).
6. `LIMPEZA` (opcional; a pasta some no próximo deploy).

### Interrupções e recuperação (P3-1)

A pasta própria é local à instância e efêmera. Uma interrupção nunca autoriza, por dedução, repetir um APLICAR.

- **Perda da pasta ANTES de qualquer APLICAR** (deploy, restart ou troca de instância entre as partes e os curtos; o curto acusa `PARTE_AUSENTE_OU_DIVERGENTE` ou `MONTAGEM_RECUSADA`): antes de colar as partes de novo, reconferir no Render que o deploy publicado ainda é o do E3 (código antigo, commit esperado) e que nenhum deploy novo entrou. Se o código publicado mudou, a premissa do E3 caiu: parar e seguir o ENC do plano. Se não mudou, colar as partes de novo e repetir o CONFERIR do escopo.
- **Interrupção DURANTE ou DEPOIS de um APLICAR** (sem `CODIGO_SAIDA_BLOCO`, código diferente de 0, ou queda do Shell): não colar o APLICAR de novo. Copiar a saída, ler o marcador do escopo (`data/agenda-precos-092-094-producao/migration-092-093.json`, inclusive o estado do COMMIT), reconferir o artefato publicado e rodar o CONFERIR do escopo. Se a pasta sumiu, colar as partes de novo para isso. Retomar só com decisão de Felipe e o procedimento do aplicador (renomear o marcador, nunca apagar).
- **099:** já aplicada antes do E3 (31/10/2026). Nenhuma interrupção deste pacote autoriza reaplicar, desfazer ou rodar o down da 099; o down recusa com avulsos ou autorização de IA sem festa, e a reversão da 099 é só de código (`docs/CONVITES_AVULSOS_PRODUCTION_20261031.md`, clone `kidmais-manager-convites-avulsos-production-20261031`).
- **Código 1 sem `ARQUIVOS_OK` (P3-N2):** o bloco parou ANTES do aplicador; nada foi feito no banco. A linha `BLOCO_PAROU_COMANDO_FALHOU (linha N do programa)` diz que um comando do próprio bloco falhou (ex.: `.partes` ocupado por um arquivo, `find` com erro). Ler a linha anterior, corrigir a causa e colar o MESMO bloco. O código 1 do aplicador (recusa antes de conectar) vem sempre depois de `ARQUIVOS_OK`.
- **Variáveis do Shell do operador (P2-N1/P3-N1/P2-R3-1):** o corpo zera `T` antes do `trap`. O carregador abre com `( \command builtin unset -v C T || …` (sem alias e sem função `builtin`); o temporário, o `trap` e a escrita do corpo estão numa única linha, de modo que perdê-la não escreve nem apaga nada, qualquer que seja `C`. Se `C` ou `T` forem somente leitura no shell (`readonly`/`declare -r`), o bloco recusa com `VARIAVEIS_DO_CARREGADOR_NAO_LIMPAS` e código 4: abrir uma sessão nova do Shell e colar de novo. Essa recusa vale com os builtins normais e com aliases; com uma **função `command`** definida pelo operador ela não é garantida (ver residual abaixo). Um `T`/`C` herdado nunca é removido nem sobrescrito.

## Validação local (sem banco e sem Shell real)

- `scripts/bloco-shell-entrega-grupo-a-producao.test.cjs` 24/24 (Git Bash real em deploy temporário), cobrindo:
  - lista igual à do B-1/B-2; tamanhos; modos e 15 formas de destino inválido recusados;
  - carregador: corpo embutido igual ao programa do modo, sha fixado, só 4 impresso pelo carregador;
  - guarda e guarda repetida no corpo;
  - backup: 19 casos de registro ruim por APLICAR, todos com 4 antes de criar a pasta, e o caso válido passando o caminho relativo;
  - `pg` ausente; montagem só com todas as partes; fluxo do E3 completo até a LIMPEZA (e `NADA_A_LIMPAR`);
  - planos offline reais do B-1 e do B-2 executados da pasta montada; conferências e APLICAR reais recusando fora do Render (código 1) sem marcador novo;
  - P2-1: pasta própria como junção para o deploy, para fora e para `data/` (4 em parte, curto, APLICAR e LIMPEZA, isca preservada); subpasta, `database/checks` e `.partes` como junção (4, nada gravado no alvo); lugar físico divergente sem link (`pwd -P`);
  - arquivo divergente preservado, inclusive com as linhas `livre` removidas do corpo (o `inst` reconfere); parte adulterada; carga corrompida ou trocada por conteúdo válido; parte que só grava depois de conferir todos os itens;
  - P2-2: perder **cada** linha de um APLICAR-099 com arquivo divergente presente nunca executa nem dá 0; perder cada linha de um APLICAR-092-093 íntegro ou executa conferido ou não dá 0; sem a linha de execução do carregador, nada roda e não há código; perder linhas de uma parte (carregador inteiro e amostra do corpo) nunca dá 0 sem a parte nem grava parte errada;
  - colagem truncada; colagem interativa com códigos 0–4 e shell do operador intacto; corpo imune a `BASH_ENV`/`ENV`; `trap` com `rm` falso; hashes iguais aos que os blocos de origem conferem; CLI `TODOS`.
- Suítes do B-1, B-2 e da 100 nesta composição: 92/92.
- 25 mutantes em cópia isolada (controle 24/24), todos derrubados:
  - os 11 ainda aplicáveis da versão inicial;
  - carregador sem conferir o sha; carregador imprimindo o código; corpo sem a guarda; corpo com `BASH_ENV`; `inst` sem reconferir;
  - sem `pwd -P` (sobreviveu à primeira bateria; teste do lugar físico acrescentado); sem `find` de links; sem recusa do link do destino; gerador sem normalizar;
  - backup sem sha, sem PITR, sem idade, sem banco e com nome livre.
- ESLint dos arquivos novos sem erro; `git diff --check` limpo; `npm run check:v1:static` código 0 (3599 + 103 testes; 2 avisos de ESLint preexistentes; build compilado; `next-env.d.ts` restaurado).

## Pontos em aberto

- **091 (recomendação da revisão):** mover a 091 explicitamente para o **E6**, condicionada ao B-15, sem ampliar este transporte. O aplicador de produção da 091 determina código primeiro, e a funcionalidade que depende dela fica indisponível até os gates. **Rodada 10 do plano (26/10/2026, só documental, aguarda revisão):** a 091 saiu do E3 e foi para o E6 no plano de promoção (tabela, orçamento 20/35 min, E5b ≥ 60 min, B-15, ENC, §10 e decisões A4/A7).
- **Ferramenta do E2 em produção (observação, não verificada):** `scripts/backup-lancamento-production.cjs` recusa exportar se `CADASTRO_PUBLICO_ATIVO`, `ASSINATURA_PLANOS_ATIVOS` ou `COTACAO_PUBLICA_POR_EMPRESA` estiverem `true`. Depois da abertura da venda, isso pode bloquear o E2 em produção. Os envs de produção não foram lidos (o Render MCP não lê envs); conferir antes da janela.
- Os blocos precisam ser gerados de novo da árvore integrada final, e os hashes do B-1/B-2 nela devem ser os dos pacotes aprovados.
- Nenhuma colagem real: o tempo de colagem e o comportamento do Web Shell de produção com 5 partes não foram medidos. Também não foi medido o tempo do `sha256sum` do dump (proporcional ao tamanho do dump de produção).
- Residual aceito: funções exportadas no ambiente do operador (`export -f`) alcançariam o corpo; os testes usam isso de propósito para simular falhas.
- Residual aceito (P3-R5-2): aliases ou funções do operador sobre os comandos do próprio carregador (`command`, `trap`, `mktemp`, `sha256sum`, `env`, `bash`…). Com uma função `command` (testada com a sintética `command() { return 0; }`; não é prova para qualquer implementação), o `unset` da abertura não roda. Com o **bloco inteiro**: `C` somente leitura para com status 1 sem linha de código e deixa um temporário **vazio**; `T` somente leitura roda o corpo conferido normalmente. **Sem a linha do temporário**, com `C` apontando para um arquivo de conteúdo diferente do corpo (a isca dos testes), nada executa; se `C` contiver exatamente o corpo conferido, esse corpo legítimo executa e o arquivo fica intacto (controle P3-R6-1). Em nenhum caso o arquivo ou a pasta apontados por `C`/`T` são escritos ou removidos (testes P3-R5-2 e P3-R6-1).
- **Premissa a conferir na sessão autorizada (não verificada):** o Web Shell do Render não define aliases nem funções sobre esses comandos. Antes do primeiro bloco, `alias` e `declare -F` devem sair vazios; se não saírem, abrir uma sessão nova do Shell.

## Revisão independente — rodada 1 (REPROVADO: 2 P2 + 1 P3; item 4 e 091) e correção

- **P2-1** (destino podia escapar; LIMPEZA removeu arquivo do deploy através de uma pasta própria redirecionada): destino normalizado no gerador e lugar físico conferido no Shell (sem link no destino, `pwd -P`, nenhum link dentro). Testes com junções para o deploy, para fora, para `data/` e nas subpastas, e com lugar físico divergente sem link.
- **P2-2** (perder a linha `livre` executava o divergente com 0; perder a linha de execução dava 0 sem executar): carregador conferido por sha256 e código 0 só do corpo conferido. `inst` reconfere o sha no ponto de uso. Testes de perda sistemática de linhas e as duas sondas da revisão.
- **P3-1** (recuperação simplificada): seção "Interrupções e recuperação", que separa perda da pasta antes do APLICAR de interrupção durante ou depois dele; exige reconferir o artefato publicado, o estado dos escopos e os marcadores; nunca repetir o APLICAR por dedução.
- **Item 4** (backup só por formato): registro da ferramenta do E2 conferido (sha do dump, serviço, banco, datas de criação e PITR).
- **Item 8** (091): recomendação registrada em "Pontos em aberto"; o transporte não foi ampliado.

## Re-revisão do Codex — APROVADO COM RESSALVAS (26/10/2026)

> Atribuição corrigida em 26/10/2026: esta seção é a re-revisão do **Codex** (não pegou o P2-N1). A re-revisão do **Astra** foi **REPROVADA** — ver a seção seguinte.

- P2-1, P2-2 e P3-1 fechados; as sondas da rodada 1 foram reproduzidas contra o desenho novo e não repetiram as falhas. O revisor acrescentou 20 sondas de duplicação e reordenação de linhas, todas aprovadas. O item 4 está fechado no B-4 (`JS_BACKUP` só lê); PITR real e restauração seguem nos gates próprios (E2, B-12).
- **P3-R2-1 (item 8 parcialmente fechado):** este documento recomenda a 091 no E6, mas a tabela do E3 do plano de promoção ainda a manda executar no E3. Isso bloqueia o **uso operacional** até uma rodada documental própria do plano (tabela E3/E6, orçamento, checkpoint E5b, B-15 e recuperação); não bloqueia o aceite local deste código.
- Residuais aceitos sob operador único e shell confiável: a checagem física não é atômica contra escritores concorrentes; a integridade do corpo não garante execução única; colagem malformada exige parada e sessão nova.
- Antes de production: reconciliar o plano; gerar os blocos de novo da árvore final conferida; comprovar backup, PITR e B-12; revalidar ambiente, instância e autorizações; medir os tempos de colagem e do `sha256sum` do dump.
- Pacote aprovado: diff `5004b3a9…`, gerador `4e1dcd65…`, testes `c0aa77d1…`, composição `2c020b00…`. Esta seção é só documental.

## Re-revisão do Astra — REPROVADO (26/10/2026)

Parecer: `ambientes-locais/revisao-b4-r2-astra-20261026/parecer.md` (sondas e logs na mesma pasta). P2-1, P2-2, P3-1 e item 4 **fechados**; item 8 aceito no B-4 e pendente no plano. Achados novos, encontrados só por sondas (as suítes 24/24 e 92/92 passavam):

- **P2-N1:** o `trap` de saída do corpo removia (`rm -rf`) um `T` **herdado** do ambiente nos modos CONFERIR, APLICAR e LIMPEZA, e numa PARTE que parasse antes do `mktemp -d`. Na sonda, com `T` exportado apontando para uma isca, o CONFERIR-099 saiu com código 4 e a isca foi apagada. Com `T=/opt/render/project/src/data`, iriam embora o disco persistente, os marcadores e o dump do E2.
- **P3-N1:** se a linha do `mktemp` do carregador se perdesse, um `C` do shell do operador era sobrescrito e depois apagado.
- **P3-N2:** a parada por `set -e` antes do aplicador saía com 1, sem motivo impresso.

## Rodada 3 — correção (LOCAL, sem commit, 26/10/2026)

- **P2-N1:** `T=` é a primeira linha do corpo, antes do `trap`; só o `mktemp -d` da parte define `T`.
- **P3-N1:** o carregador abre com `( unset C T`. Perder essa linha continua dando erro de sintaxe, sem executar nada.
- **P3-N2:** `trap ERR` imprime `BLOCO_PAROU_COMANDO_FALHOU (linha N do programa)`, e a regra "código 1 sem `ARQUIVOS_OK`" foi registrada em "Interrupções e recuperação". Os caminhos normais não imprimem a linha (testado).
- Testes novos, todos com bash real:
  - **P2-N1:** `T` exportado apontando para uma pasta-isca em **todos** os modos, antes e depois das partes (PARTE-1..N, CONFERIR-092-093, APLICAR-092-093, CONFERIR-099, APLICAR-099, LIMPEZA), e numa PARTE que para antes do `mktemp` (`DESTINO_NAO_E_PASTA`). A isca sobrevive.
  - **P3-N1:** linha do `mktemp` perdida, com `C` não exportado e exportado apontando para um arquivo-isca. A isca fica intacta e nada é executado.
  - **P3-N2:** `.partes` ocupado por um arquivo dá código 1 com o motivo e sem `ARQUIVOS_OK`; partes, aplicador com código 2 e LIMPEZA não imprimem o motivo.
- Mutantes novos R1 (sem `T=`), R2 (abertura sem `unset`) e R3 (sem o motivo). A bateria foi reconstruída em `ambientes-locais/mutantes-b4-r3-20261026.cjs` porque o script da bateria anterior de 25 não foi localizado: 10 mutantes das defesas da versão inicial, os 14 nomeados na rodada 1 e os 3 novos.
- Resultado da validação: ver o pacote da rodada 3 no vault ("Planejamento atualizacao production 20261025").
- Continuam valendo os pré-requisitos antes de production:
  - revisão focal deste delta;
  - rodada documental 091 → E6 (rodada 10, aguardando revisão);
  - ler em production `CADASTRO_PUBLICO_ATIVO`, `ASSINATURA_PLANOS_ATIVOS` e `COTACAO_PUBLICA_POR_EMPRESA` (qualquer um em `true` trava o E2/E3);
  - E2 e B-12;
  - gerar os blocos da árvore integrada final;
  - medir o tempo da colagem e do `sha256sum` do dump.

## Revisão focal da rodada 3 — REPROVADO (1 P2) e rodada 4 (LOCAL, sem commit, 26/10/2026)

Parecer: `ambientes-locais/revisao-b4-r3-independente-20261026-01/parecer.md`. P2-N1 e P3-N2 fechados no escopo testado; P3-N1 só parcialmente.

- **P2-R3-1:** com `readonly C=<arquivo>` (ou `declare -rx C`) no shell e a linha do `mktemp` perdida, o `unset` falhava sem guarda. O carregador então sobrescrevia o arquivo, executava o corpo (código 0) e o apagava no `trap`. Reproduzido em script e em `bash -i`.
- **Correção:** a abertura do carregador é `( builtin unset -v C T || { echo "VARIAVEIS_DO_CARREGADOR_NAO_LIMPAS …"; echo "CODIGO_SAIDA_BLOCO=4"; exit 4; }`. Ela recusa antes de armar o `trap` ou redirecionar conteúdo; `builtin` evita uma função `unset`. A abertura é exportada (`ABERTURA_CARREGADOR`) e conferida pelo teste do carregador.
- **Teste novo:** `readonly C`, `declare -rx C`, `readonly T` e `declare -rx T`, em CONFERIR-099 e LIMPEZA, com e sem a linha do `mktemp`, em script e em `bash -i` (32 execuções). Em todas: recusa 4 com o motivo, arquivo-isca e pasta-isca intactos, nada executado e nenhum 0.
- **Mutantes:** bateria refeita (`ambientes-locais/mutantes-b4-r4-20261026.cjs`), com a suíte completa em cópias isoladas. Inclui:
  - os 25 da rodada 1 (`mutantes-b4r1.cjs`, localizado pela revisão), com os mesmos operadores, inclusive os seis que faltavam na reconstrução: m1, m5, m6, m7, m11 e m12;
  - as variantes da reconstrução;
  - R1 (sem `T=`), R2 (abertura sem `unset`), R3 (sem o motivo), R4 (`unset` sem recusa), R5 (ignora `readonly`) e R6 (`T=` depois do `trap`, comportamentalmente equivalente; só a asserção literal o derruba).
  - O resultado está no pacote da rodada 4 no vault.

## Revisão focal da rodada 4 — REPROVADO (1 P2) e rodada 5 (LOCAL, sem commit, 26/10/2026)

Parecer: `ambientes-locais/revisao-b4-r4-focal-20261026-02/parecer.md`. O caso `readonly` passou 32/32.

- **P2-R4-1:** com `alias builtin='true'` (padrão no `bash -i`; em script, com `expand_aliases`) e a linha do `mktemp` perdida, o `unset` virava `true`, `C` permanecia e o carregador sobrescrevia, executava (código 0) e apagava o arquivo do operador. Valia também com `C` comum, e foi uma regressão em relação à rodada 3.
- **Correção, em duas camadas:**
  1. **Estrutura:** `LINHA_TEMPORARIO` (exportada) põe `C="$(mktemp)" && trap … EXIT && { { base64 -d | gzip -dc > "$C"; } 2>/dev/null; true; } <<'CORPO' || {recusa 4}` numa **linha só**. Perder essa linha não arma `trap` nem escreve em lugar nenhum; um `C` herdado só é **lido** pela conferência do sha: conteúdo diferente do corpo sai com 4; exatamente o corpo conferido executa esse corpo (P3-R6-1). A proteção não depende do `unset` nem de alias ou função.
  2. **Abertura:** `( \command builtin unset -v C T || {recusa 4}`, como proposto na revisão. A barra impede o alias e `command` evita uma função `builtin`. Continua recusando `C`/`T` somente leitura.
- **Teste novo:** `alias builtin=true`, `alias command=true`/`alias unset=true`, função `builtin` e função `command` (não exportadas), em script e `bash -i`, em CONFERIR-099 e LIMPEZA. Sem a linha do temporário, o arquivo de `C` fica intacto, nada é executado e não sai 0. Com o bloco inteiro e os mesmos aliases ou funções, roda normal (0, `APLICADOR_RODOU`), o arquivo do operador fica intacto e nenhum temporário é deixado.
- **Mutantes novos:** R7 (carregador em linhas separadas, o desenho da rodada 4) e R8 (abertura sem `\command`). R8 é comportamentalmente equivalente com a estrutura nova e só a asserção literal o derruba. **Corrigido na rodada 6 (P3-R5-1):** nesta rodada o R7 caía só por estrutura, e o R8 não é equivalente: com `alias builtin` e `T` somente leitura ele executa e sai 0.
- **Residual declarado:** um alias ou uma função do operador sobre os comandos do próprio carregador (`trap`, `mktemp`, `sha256sum`, `env`, `bash`…) continua fora do modelo, como `export -f`. O Web Shell do Render não define nenhum. (Qualificado na rodada 6: inclui `command`, e a afirmação sobre o Render é premissa a conferir.)
- O resultado da validação está no pacote da rodada 5, no vault.

## Revisão focal da rodada 5 — APROVADO COM RESSALVAS (2 P3) e rodada 6 (LOCAL, sem commit, 27/10/2026)

Parecer: `ambientes-locais/revisao-b4-r5-focal-20261027-01/parecer.md`. O P2-R4-1 ficou fechado; nenhuma isca foi perdida em 438 sessões.

- **P3-R5-1 (evidência dos mutantes):** o teste do alias procurava o texto exato da linha do temporário, então o R7 caía na procura, antes de chegar à isca. Agora a linha é achada pelo conteúdo (`C="$(mktemp)"`). Teste novo: `alias builtin` e `alias command`/`unset` × `C` ou `T` somente leitura, com e sem a linha do temporário, em script e `bash -i`, CONFERIR-099 e LIMPEZA. Espera a recusa 4 com o motivo e as iscas intactas, o que derruba o R8 por comportamento.
- **P3-R5-2 (residual):** a função `command` passou a ser nomeada no residual e no comentário da abertura, e a recusa de `readonly` ficou qualificada (com builtins normais e aliases). Teste novo: a combinação função `command` × `readonly`, que prova o limite declarado: iscas intactas, nada executado com `C` somente leitura apontando para uma isca de conteúdo diferente do corpo, e temporários deixados vazios. Com `T` somente leitura, o bloco inteiro dá 4 ou executa o corpo conferido. "O Web Shell do Render não define nenhum" virou premissa a conferir (`alias`/`declare -F` vazios antes do primeiro bloco).
- **Frase forte:** "qualquer linha perdida = nada executado" (cabeçalho do bloco e doc) virou "o que executa é sempre o corpo conferido". Perder só o final do gzip ou o `umask` pode rodar o corpo íntegro.
- O resultado da validação está no pacote da rodada 6, no vault.

## Revisão focal da rodada 6 — APROVADO COM RESSALVAS (1 P3) e rodada 7 (LOCAL, sem commit, 27/10/2026)

Parecer: `ambientes-locais/revisao-b4-r6-focal-20261027-01/parecer.md`. P3-R5-1 e P3-R5-2 fechados; nenhum P1/P2 novo.

- **P3-R6-1 (redação):** restavam frases de recusa universal incompatíveis com as exceções já reconhecidas: perder o `umask 077` roda o corpo íntegro, e um `C` com exatamente o corpo esperado executa esse corpo mesmo sem a linha do temporário. Nenhum dos dois executa conteúdo divergente.
- **Correção:** as frases foram trocadas pela garantia de conteúdo, no parágrafo do carregador, na linha da estrutura, no residual da função `command` e no resumo da rodada 6, e também no cabeçalho e no comentário do carregador no gerador (só comentários JavaScript; os blocos emitidos não mudam). Ficou explícito que o sha confere os bytes do corpo, não a origem do arquivo nem que o carregador foi colado inteiro, e que as sondas de não execução com `C` usam uma isca de conteúdo diferente do corpo. O título do teste P3-R5-2 diz isso.
- **Controle novo (teste P3-R6-1):** execução legítima. (a) Sem a linha `umask 077`, o bloco inteiro roda o corpo conferido com 0, em script e `bash -i`. (b) Função `command`, `C` comum ou somente leitura contendo exatamente o corpo decodificado, sem a linha do temporário: o corpo conferido executa com 0, o arquivo de `C` fica com os mesmos bytes e nenhum temporário é deixado.
- O resultado da validação está no pacote da rodada 7, no vault.

## Revisão focal da rodada 7 — APROVADO COM RESSALVAS (1 P3) e rodada 8 (LOCAL, sem commit, 28/10/2026)

Parecer: `ambientes-locais/revisao-b4-r7-focal-20261028-01/parecer.md`. P3-R6-1 fechado; nenhum P1/P2 novo.

- **P3-R7-1 (evidência do teste novo):** o teste P3-R6-1 achava o corpo decodificando o heredoc a partir da linha exata do temporário e lendo o sha por regex. No m14 (sem a conferência do sha) e no R7 (carregador em linhas separadas), ele quebrava nessa preparação, antes do comportamento; a queda era teste vermelho, não prova comportamental.
- **Correção (só testes):** o corpo exato vem agora de `b.corpo` com os mesmos argumentos que `gerar` usa, e não do heredoc nem da linha do sha. Que o heredoc traz exatamente `b.corpo` e o sha dele já está provado no teste do carregador (P2-2), por modo. A preparação só procura as duas linhas que remove (`umask 077` e a que cria `C`); qualquer erro de preparação sai como `PREPARACAO_FIXTURE <rótulo>: …`, distinto das falhas de comportamento. O teste também confere que `C` não foi removido antes de comparar os bytes.
- **Efeito nos mutantes:** no R7 o teste chega ao comportamento (o trap do R7 apaga o arquivo de `C`: falha "C não removido"). No m14 o controle positivo passa, como esperado: a prova negativa da conferência fica com os testes de conteúdo divergente.
- **Bateria com manifesto de entradas:** cada execução grava `<mutante>.entradas.json` com o sha de cada arquivo da cópia (scripts/ e database/), um sha agregado, a versão do node e o sha do `package-lock.json`, antes e depois da suíte. A retomada só aproveita um log se o manifesto existir, antes = depois, e o sha agregado for igual ao da cópia preparada agora. O resumo marca falhas de preparação (`PREPARACAO_FIXTURE`) à parte, e a bateria sai com 1 se o controle falhar, algum mutante sobreviver, algum manifesto divergir ou houver queda só por preparação.
- O resultado da validação está no pacote da rodada 8, no vault.

## Revisão focal da rodada 8 — APROVADO COM RESSALVAS (2 P3) e rodada 9 (LOCAL, sem commit, 28/10/2026)

Parecer: `ambientes-locais/revisao-b4-r8-focal-20261028-01/parecer.md`. P3-R7-1 fechado; nenhum P1/P2 novo. Os dois P3 eram da ferramenta de mutantes, não do gerador nem dos blocos (gerador inalterado desde a rodada 7).

- **P3-R8-1 (retomada confiava no agregado declarado):** a bateria (`ambientes-locais/mutantes-b4-r9-20261028.cjs`) agora **valida** o manifesto de cada execução: esquema e identidade (nome, node, `package-lock.json`, lock do `node_modules` instalado), agregados **recalculados** dos mapas completos (pares ordenados), hashes redundantes do gerador e dos testes conferidos nos mapas, mapas antes = depois = cópia preparada agora, e o log amarrado ao manifesto (sha do log, código de saída e sinal do processo). Limite declarado: o conteúdo do `node_modules` não é selado arquivo a arquivo; valem os dois locks.
- **P3-R8-2 (controle incompleto e "comportamento" = sem rótulo):** o controle só aprova com saída 0 sem sinal, `tests` = `pass` = número de `test()` do arquivo e zero fail/skipped/cancelled/todo. Um mutante só conta como derrubado com saída 1 sem sinal, todos os testes executados e ao menos uma falha de **asserção** sem `PREPARACAO_FIXTURE`; falhas por outro erro (TypeError, ENOENT…) contam à parte como "outros" e sozinhas não derrubam.
- **Testes:** os dois "outros" reais da rodada 8 viraram asserções. O auxiliar `embutido` devolve `null` no que faltar e o teste do carregador (P2-2) afirma explicitamente o heredoc decodificável e a linha que confere o sha (era o TypeError do m14). As leituras do arquivo-isca usam `conteudo()`, que devolve `null` se a isca sumiu (era o ENOENT do R7 no P3-R5-2).
- **Sonda sintética da retomada** (`b4-r9-20261028/sonda-retomada.cjs`, `RETOMAR=1 SO_CONFERIR=1`, nada roda): 13/13 conforme — o caso válido aprova e reprovam mapas vazios, mapa falso com agregado recalculado, gerador redundante diferente, log alterado depois de selado, controle com zero testes, com saída 1 ou com sinal, mutante só com TypeError, só com preparação, com teste cancelado ou com saída 0, e log faltando.
- O resultado da validação está no pacote da rodada 9, no vault.

## Revisão focal da rodada 9 — APROVADO COM RESSALVAS (3 P3) e rodada 10 (LOCAL, sem commit, 29/10/2026)

Parecer: `ambientes-locais/revisao-b4-r9-focal-20261028-01/parecer.md`. P3-R8-1 fechado; P3-R8-2 parcial; nenhum P1/P2. Os três P3 eram da ferramenta de mutantes e da sonda, não do gerador nem dos blocos (gerador inalterado desde a rodada 7; testes inalterados desde a rodada 9).

- **P3-R9-1 (asserção por substring):** a bateria (`ambientes-locais/mutantes-b4-r10-20261029.cjs`) roda a suíte também com um relator próprio do node:test (`ambientes-locais/relator-eventos-b4-r10.mjs`), que grava por teste a **causa estruturada** da falha. Só conta como asserção uma falha do corpo do teste (`testCodeFailure`) cuja causa é `AssertionError` com código `ERR_ASSERTION` e operador, sem `PREPARACAO_FIXTURE`. Um TypeError que cita ERR_ASSERTION na mensagem, ou até com `code` igual a ERR_ASSERTION, conta como "outros".
- **P3-R9-2 (primeiro rodapé vencia):** as contagens saem só dos eventos estruturados (`<mutante>.eventos.ndjson`, selado no manifesto junto com o sha do relator). Toda linha tem de ser JSON de tipo conhecido; exatamente dois resumos (o do arquivo e o final); nomes de nível 0 únicos e do arquivo de teste; nenhum subteste; e **os dois resumos iguais às contagens derivadas dos resultados individuais**. Os nomes de cada mutante têm de ser os do controle aceito. O log do reporter spec continua selado, só para leitura.
- **P3-R9-3 (oráculo da sonda):** a sonda nova (`b4-r10-20261029/sonda-retomada.cjs`) exige término normal, uma única linha de veredito, o código esperado, o conjunto **exato** de recusados e o motivo esperado de cada um. Falha de infraestrutura é INCONCLUSIVO e impede SONDA_OK; um autoteste do oráculo confirma isso com 4 processos que não validam nada (EPERM, veredito duplicado, saída sem veredito, morte por sinal).
- **SO_CONFERIR somente leitura:** o esperado de cada execução é calculado em memória (fonte + trocas), sem criar nem descartar cópias, e nada é removido. A sonda confere a pasta de cada caso byte a byte antes e depois, e que a pasta padrão não foi criada. Nas execuções reais, a cópia preparada tem de bater com o esperado em memória.
- **Sonda:** os eventos vêm de execuções reais do node --test com o relator, sobre arquivos sintéticos de 32 testes. Resultado: 22/22 conforme, incluindo as três contraprovas do revisor (TypeError citando ERR_ASSERTION, eventos do controle duplicados e resumo de 32/32 anteposto a um controle de um teste). Também: TypeError com code ERR_ASSERTION, só timeout, teste pulado, nomes diferentes do controle, linha não JSON, eventos e log alterados ou ausentes, e relator diferente.
- Limites declarados: o conteúdo do `node_modules` não é selado arquivo a arquivo (valem os dois locks); manifesto, log e eventos não são autenticados contra quem regrave os três juntos; a identidade de asserção supõe que o próprio arquivo de teste não fabrique um AssertionError falso.
- O resultado da validação está no pacote da rodada 10, no vault.

## Revisão focal da rodada 10 — APROVADO COM RESSALVAS (3 P3) e rodada 11 (LOCAL, sem commit, 29/10/2026)

Parecer: `ambientes-locais/revisao-b4-r10-focal-20261029-01/parecer.md`. P3-R9-1/2/3 e SO_CONFERIR fechados; nenhum P1/P2. Os três P3 novos eram da bateria de mutantes e da sonda, não do gerador, dos testes nem dos blocos (gerador inalterado desde a rodada 7; testes inalterados desde a rodada 9; blocos idênticos aos da rodada 10).

- **P3-R10-1 (hook síncrono contava como asserção do corpo):** o arquivo de teste selado não pode registrar hooks (before/after/beforeEach/afterEach) — checagem lexical; o arquivo real não tem nenhum. O relator novo (`ambientes-locais/relator-eventos-b4-r11.mjs`) grava no resumo do arquivo o sha256 do arquivo de teste **executado**, e a bateria (`ambientes-locais/mutantes-b4-r11-20261029.cjs`) exige que seja o selado no manifesto ("arquivo de teste executado diferente do selado").
- **P3-R10-2 (eventos reordenados/incoerentes aceitos):** esquema exato de cada evento (chaves na ordem do relator e tipo de cada campo; "passou" sem erro; falha com causa nula ou completa) e sequência fixa resultados → resumo do arquivo → resumo final, nada depois. Entrada malformada vira recusa controlada ("erro ao classificar"), nunca exceção que derruba a bateria.
- **P3-R10-3 (oráculo):** a bateria sai com 0 em BATERIA_OK e 3 em BATERIA_REPROVADA; qualquer outro código é exceção/infraestrutura. O veredito é a última linha da saída padrão. O oráculo da sonda exige, nesta ordem: sem erro nem sinal, código 0 ou 3, um único veredito na última linha, veredito bem formado e código coerente com o rótulo (senão INCONCLUSIVO); polaridade errada (REPROVADA no caso positivo) é NAO_CONFORME. Kill e throw depois do veredito (status 1 no Windows) saem INCONCLUSIVO.
- **Sonda (`b4-r11-20261029/sonda-retomada.cjs`):** 32/32 conforme, oráculo 13/13 (inclui um processo coerente que tem de dar CONFORME), hooks 5/5. Reproduz as contraprovas da revisão: hook de outro arquivo, resumos antepostos, ordem invertida, resultado depois do resumo final, passou com erro, flags ausentes ou em texto, resumo sem sha, causa sem mensagem e polaridade.
- Limites declarados: os da rodada 10, mais: a checagem de hooks é lexical e supõe arquivo de teste não adversário; um encerramento anômalo que coincida com o código 3 depois de um veredito REPROVADA bem formado não é distinguível pelo código.
- O resultado da validação está no pacote da rodada 11, no vault.

## Revisão focal da rodada 11 — APROVADO COM RESSALVAS (2 P3) e rodada 12 (LOCAL, sem commit, 29/10/2026)

Parecer: `ambientes-locais/revisao-b4-r11-focal-20261029-01/parecer.md`. P3-R10-1/2/3 fechados; nenhum P1/P2. Os dois P3 novos eram da bateria de mutantes e do oráculo da sonda, não do gerador, dos testes nem dos blocos (gerador inalterado desde a rodada 7; testes inalterados desde a rodada 9; blocos idênticos aos das rodadas 10 e 11). O relator é o mesmo da rodada 11.

- **P3-R11-1 (código externo do erro incoerente aceito):** a bateria (`ambientes-locais/mutantes-b4-r12-20261029.cjs`) só conta como asserção a falha cujo envelope do runner é coerente — código `ERR_TEST_FAILURE` e `testCodeFailure` — além da causa `AssertionError`/`ERR_ASSERTION` com operador. Código externo nulo ou outro conta como "outros". As 115 falhas reais das execuções usam `ERR_TEST_FAILURE`.
- **P3-R11-2 (oráculo aceitava linhas contraditórias):** o oráculo da sonda (`b4-r12-20261029/sonda-retomada.cjs`) exige, antes do veredito, exatamente uma linha de classificação por execução, na ordem da bateria, cada uma com um único estado (ACEITO, RECUSADO ou FALTA); NAO_APROVEITADO só com FALTA; os não aceitos têm de ser exatamente os do veredito; e o BATERIA_OK tem de ter o texto exato da bateria. Qualquer incoerência é INCONCLUSIVO. O autoteste usa saídas completas (41 linhas) e confere o motivo de cada recusa, para que cada processo pare na checagem que pretende exercitar.
- **Sonda:** 34/34 conforme, oráculo 21/21 (dois processos coerentes, um negativo e um positivo, têm de dar CONFORME), hooks 5/5, envelope 4/4. Inclui as contraprovas da revisão: código externo nulo e inexistente, linha ACEITO com veredito REPROVADA, linha RECUSADO com BATERIA_OK, linhas duplicadas e BATERIA_OK com texto diferente.
- As chaves das contagens são conferidas como conjunto exato (sem ordem); as do resultado, do erro e da causa, na ordem do relator.
- Limites declarados: os da rodada 11; hooks escondidos em helper, nome calculado ou escape Unicode escapam da checagem lexical (o teste selado é tratado como não adversário); um encerramento anômalo que coincida com o código 3 depois de um veredito REPROVADA bem formado não é distinguível.
- O resultado da validação está no pacote da rodada 12, no vault.

## Revisão focal da rodada 12 — APROVADO COM RESSALVAS (1 P3) e rodada 13 (LOCAL, sem commit, 30/10/2026)

Parecer: `ambientes-locais/revisao-b4-r12-focal-20261030-01/parecer.md`. P3-R11-1 e P3-R11-2 fechados; nenhum P1/P2. O P3 novo era só do oráculo da sonda: gerador, testes, blocos, relator e bateria ficam inalterados nesta rodada (bateria `ambientes-locais/mutantes-b4-r12-20261029.cjs`, a mesma da rodada 12).

- **P3-R12-1 (motivo podia vir de uma classificação extra na saída de erro):** o oráculo da sonda (`b4-r13-20261030/sonda-retomada.cjs`) lê o motivo de cada execução só da linha de classificação já validada na saída padrão ou, para FALTA, do NAO_APROVEITADO já validado. Qualquer classificação na saída de erro (inclusive indentada) é INCONCLUSIVO.
- **Sonda:** 34/34 conforme, oráculo 27/27, hooks 5/5, envelope 4/4. Inclui as contraprovas da revisão (motivo só na saída de erro e contradição na saída de erro), o motivo errado sem saída de erro (NAO_CONFORME) e o caminho legítimo FALTA + NAO_APROVEITADO com motivo certo (CONFORME) e errado (NAO_CONFORME).
- **Bateria:** como não mudou, não houve nova execução dos 40 mutantes; ela conferiu em modo somente leitura (RETOMAR=1 SO_CONFERIR=1) os 41 registros reais da rodada 12, com retrato da pasta antes e depois.
- Limites declarados: os da rodada 12, inclusive o encerramento anômalo (exceção ou rejeição com exitCode 3 depois de um veredito REPROVADA coerente), que não é distinguível pelo código.
- O resultado da validação está no pacote da rodada 13, no vault.

## Revisão focal da rodada 13 — APROVADO COM RESSALVAS (1 P3) e rodada 14 (LOCAL, sem commit, 30/10/2026)

Parecer: `ambientes-locais/revisao-b4-r13-focal-20261030-01/parecer.md`. P3-R12-1 fechado; nenhum P1/P2. O P3 novo era só do oráculo da sonda: gerador, testes, blocos, relator e bateria ficam inalterados (bateria `ambientes-locais/mutantes-b4-r12-20261029.cjs`, a mesma das rodadas 12 e 13).

- **P3-R13-1 (motivo casava com o nome do teste depois do "|" ou com outra classificação na mesma linha):** o oráculo da sonda (`b4-r14-20261030/sonda-retomada.cjs`) lê cada linha pelo formato exato da bateria — cabeçalho ancorado (status, contagens, entradas), um único " | ", um único marcador de estado, um único ": status ", sem caracteres de controle (CR inclusive). O motivo é só o conteúdo do campo RECUSADO (...); os nomes de falhas depois do " | " nunca servem de motivo. NAO_APROVEITADO com caractere de controle é INCONCLUSIVO, e o motivo de FALTA é só o texto depois de "NAO_APROVEITADO <nome>: ".
- **Conferência do parser:** lê todas as 1.435 linhas reais de classificação das rodadas 12 e 13 (842 ACEITO, 584 RECUSADO, 9 FALTA), cada uma com o estado certo.
- **Sonda:** 34/34 conforme, oráculo 35/35, hooks 5/5, envelope 4/4. Inclui as contraprovas da revisão (motivo no nome do teste → NAO_CONFORME; CR com outra classificação, RECUSADO duplicado na mesma linha → INCONCLUSIVO), " | " dentro do motivo, cabeçalho fora do formato, RECUSADO no nome de falha de uma linha ACEITO, NAO_APROVEITADO com CR e o controle positivo com o motivo certo no campo (CONFORME).
- **Bateria:** como não mudou, conferiu em modo somente leitura (RETOMAR=1 SO_CONFERIR=1) os 41 registros reais da rodada 12, com retrato da pasta antes e depois.
- Limites declarados: os da rodada 12, inclusive o encerramento anômalo (exceção ou rejeição com exitCode 3 depois de um veredito REPROVADA coerente), que não é distinguível pelo código.
- O resultado da validação está no pacote da rodada 14, no vault.

## Revisão focal da rodada 14 — APROVADO COM RESSALVAS (2 P3) e rodada 15 (LOCAL, sem commit, 30/10/2026)

Parecer: `ambientes-locais/revisao-b4-r14-focal-20261030-01/parecer.md`. P3-R13-1 fechado; nenhum P1/P2. Os dois P3 novos eram só do parser do oráculo da sonda: gerador, testes, blocos, relator e bateria ficam inalterados (bateria `ambientes-locais/mutantes-b4-r12-20261029.cjs`).

- **P3-R14-1 (INVALIDAS corrompido na montagem da expressão):** a troca de "N" pelo padrão de número também atingia o N de "INVALIDAS", que passava a aceitar "I1VALIDAS"/"I?VALIDAS" e a recusar o literal. Agora o modelo usa o marcador `{N}`, que não aparece em nenhum literal, e a sonda confere ao carregar que a expressão final contém os literais intactos (9 marcadores; "INVALIDAS: " e o trecho de asserção/preparação/outros).
- **P3-R14-2 (controles C1 aceitos):** a recusa de caracteres de controle passa a cobrir C0 (U+0000–U+001F), DEL e C1 (U+007F–U+009F) e os separadores U+2028/U+2029, na linha de classificação e no NAO_APROVEITADO. Não há normalização Unicode: outros caracteres são comparados como estão.
- **Sonda (`b4-r15-20261030/sonda-retomada.cjs`):** 34/34 conforme, oráculo 42/42, hooks 5/5, envelope 4/4, controles 201/201 (os 67 controles em três posições de uma linha válida, todos recusados). Novos no autoteste: INVALIDAS literal (CONFORME), I1VALIDAS e I?VALIDAS (INCONCLUSIVO), U+0085 no motivo, U+009B no nome de falha e U+0085/U+009B no NAO_APROVEITADO (INCONCLUSIVO). O parser continua lendo as 1.435 linhas reais das rodadas 12 e 13, cada uma com o estado certo.
- **Bateria:** como não mudou, conferiu em modo somente leitura (RETOMAR=1 SO_CONFERIR=1) os 41 registros reais da rodada 12, com retrato da pasta antes e depois.
- Limites declarados: os da rodada 12, inclusive o encerramento anômalo (exceção ou rejeição com exitCode 3 depois de um veredito REPROVADA coerente), que não é distinguível pelo código; e a ausência de normalização Unicode.
- O resultado da validação está no pacote da rodada 15, no vault.

## Rodada 16 — a 099 sai do pacote (LOCAL, sem commit, 31/10/2026)

Motivo: em 31/10/2026 o menu Convites foi levado a production fora da promoção completa (`docs/CONVITES_AVULSOS_PRODUCTION_20261031.md`, clone `kidmais-manager-convites-avulsos-production-20261031`). O E-1 (#288, `733e39ad`) pôs o aplicador da 099 no artefato de production; a 099 foi aplicada pelo Web Shell (`APLICADA_POSTCHECK_PASS`, depois `JA_APLICADA_POSTCHECK_PASS`, marcador `data/convites-avulsos-099-producao/migration-099.json`); o E-2 (#290, `5bdd5ac4`) publicou as telas. O transporte e os modos da 099 deste pacote ficaram sem uso e passariam a ser um risco (reaplicar ou recontar uma migration já aplicada, com avulsos possivelmente em uso).

Base: clone novo `kidmais-manager-b4-sem-099-20261031`, branch local `codex/b4-sem-099-20261031`, sobre staging `95531909` (o B-4 está em staging desde a consolidação #280; o clone de 26/10 ficou desatualizado — 21 arquivos, sem a 107/108 — e não foi alterado). Gerador de partida = `ad24204a…` (o aprovado na r15 e na consolidação).

- **Gerador** (`a6ed9bf7…`): lista = `arquivos('production')` do B-1 só (sai o `require` do B-2 e a conferência pelo gerador dele); `EXECUCOES` sem `CONFERIR-099`/`APLICAR-099` (agora `MODO_DESCONHECIDO`); cabeçalhos dos curtos dizem que a 099 já está aplicada e não faz parte do pacote. Nada mais muda: carregador, destino físico, backup, LIMPEZA e códigos são os mesmos bytes de lógica.
- **Resultado:** 22 arquivos em 5 partes (antes 28 em 6). Os 22 são os mesmos arquivos do B-1, com o mesmo sha256 e na mesma ordem de antes; saíram exatamente os 6 da 099 (`migration-099-production.cjs`, `migration-099-comum.cjs`, precheck, vínculo/versão, migration e postcheck). Nenhum bloco contém `migration-099`, `convites-avulsos-099`, `--conferir-099` ou `--aplicar-099`.
- **099 como pré-condição já aplicada:** conferida no E3 com o aplicador do artefato publicado (`--conferir-099` → `JA_APLICADA_POSTCHECK_PASS`), fora destes blocos; nenhum bloco aplica, desfaz ou lê a 099; sem down automático; o marcador é preservado (a LIMPEZA nunca toca `data/`). Backup/recuperação partem de uma base com a 099 e talvez com avulsos. A 092/093 do B-1 não depende da 099 (o núcleo não lê convites nem o catálogo deles), então aplicar a 099 antes não muda o CONFERIR/APLICAR-092-093.
- **Testes** (`1a06210d…`, 32 testes, mesma contagem): exemplos que usavam os modos e a isca da 099 passam a usar `CONFERIR/APLICAR-092-093` e `scripts/migration-092-094-comum.cjs`; listas com os dois escopos ficam só com o 092-093. Novas garantias: lista = B-1 (22, 5 partes, nenhum arquivo com 099); `CONFERIR-099`/`APLICAR-099` = `MODO_DESCONHECIDO`; nenhum corpo menciona a 099; o deploy de teste tem o marcador da 099 e `intactoDoDeploy` exige que ele siga intacto em todos os testes (fluxo do E3, junções, LIMPEZA…); a pasta montada não tem arquivo da 099; a lista de `data/` inclui `convites-avulsos-099-producao` e nenhum marcador novo. A leitura do deploy em `intactoDoDeploy` usa `conteudo()` (arquivo ausente = asserção, não ENOENT).
- **Bateria** (`ambientes-locais/mutantes-b4-sem-099-20261031.cjs`, cópia da r12 `73eedd8d…`): mesmos operadores, relator, classificação e veredito; clone e pasta de saída novos. Dois operadores dependiam da 099 e foram reescritos com o mesmo papel: `m7-lista-sem-o-ultimo` (era lista só do B-1) e `m11-aplicar-092-093-com-flag-094` (era APLICAR-099 com o aplicador da 092). Três novos: `m28-099-de-volta-na-lista`, `m29-modo-conferir-099-de-volta`, `m30-limpeza-apaga-marcador-099`.
  - 1ª execução: BATERIA_OK, mas o `m30` caiu com 1 asserção + 2 "outros" (ENOENT ao ler o marcador apagado). Corrigido no teste (`conteudo()`), suíte e bateria repetidas inteiras.
  - 2ª execução (a que vale): **BATERIA_OK** — controle 32/32, **43/43 mutantes derrubados por asserção**, 44 ACEITO, 123 falhas de asserção, **0 "outros"** em todas, gerador e testes conferidos por sha depois da bateria; `m30` cai com 3 asserções.
- **Validação:** suíte B-4 **32/32** (Git Bash real, 302 s); ESLint dos dois arquivos sem erro; `git diff --check` limpo; blocos determinísticos (gerados duas vezes, iguais). `npm run check:v1:static` código 0 (4087 + 103 testes, 3 avisos de ESLint preexistentes, build compilado; `next-env.d.ts` restaurado).
- **Blocos** (rótulo `95531909`, só para conferência; os da janela saem da árvore integrada final): PARTE-1..5 de 24,8 / 20,6 / 28,4 / 27,0 / 13,7 KB; CONFERIR-092-093 5,7 KB; APLICAR-092-093 7,1 KB; LIMPEZA 5,1 KB. `blocos.txt` com sha e bytes no pacote.
- Pacote: `ambientes-locais/b4-sem-099-20261031` (diff `b4-sem-099.diff`, blocos, logs da suíte, das duas baterias e do static, `SHA256SUMS.txt`).
- **Fora deste pacote (pendente):** o plano de promoção (E3, orçamento de tempo, ENC e a ordem que ainda lista `CONFERIR-099 → APLICAR-099`) está em pacote congelado e não foi alterado aqui; precisa de uma rodada documental própria. Nada foi colado em Shell, nada rodou em banco, nada foi commitado.

## Revisão focal da rodada 16 — APROVADO (LOCAL, 01/11/2026)

**APROVADO no escopo LOCAL da r16, sem bloqueadores (Astra, 01/11/2026).**

- Integridade: 19/19 hashes e manifesto conferidos; diff empacotado igual ao clone; os 22 arquivos mantêm sha e ordem de staging `95531909`; saíram exatamente os seis da 099.
- Comportamento: corpos das partes, curtos e LIMPEZA equivalentes depois de retirar a 099 e ajustar as contagens; carregador, backup, guardas e códigos preservados.
- Pré-condição: conferir a 099 fora dos blocos, pelo aplicador publicado, é suficiente. Exigir só o marcador no B-4 **não** é recomendado (não comprova a integridade atual do banco). A independência da 092/093 em relação à 099 se sustenta.
- Testes: m7/m11 pertinentes; m28–m30 adequados; `conteudo()` mantém a exigência de conteúdo exato e transforma ausência em falha de asserção.
- Validação independente: suíte 32/32 (código 0); reconferência dos 44 registros da bateria: 43/43 por asserção, 123 asserções, zero "outros".
- Pendente: rodada documental do plano congelado (E3, orçamento, ENC). Limites r12–r15 preservados; sonda não reexecutada; sem banco nem Web Shell. Clone e pacote de entrada não foram editados pelo revisor.

Parecer: `C:/Users/Glass/Documents/Codex/2026-11-01/revis-o-focal-b-4-entrega/outputs/parecer-b4-r16.txt` (evidências e log independente na mesma pasta). Não é autorização de commit, PR, merge, deploy nem operação.
