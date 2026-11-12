# Ensaio local da promoção staging → production (12/11/2026)

Roteiro para ensaiar a cadeia de migrations da promoção numa **cópia do banco de production restaurada num PostgreSQL local descartável**, antes da janela. Executor: `scripts/ensaio-promocao-local.cjs`. Ordem da cadeia: `scripts/promocao-production-ordem.cjs` (roteiro de production em `docs/PROMOCAO_UNICA_PRODUCTION_20261112.md`).

**Isto não é autorização de nada em production nem em staging.** O executor só conecta em `127.0.0.1`, num cluster com `cluster_name = kidmais_descartavel`, e nunca usa os adaptadores de production.

## Avisos antes de começar

1. **O dump tem dados pessoais** (clientes, contratantes, crianças, documentos, telefones). Ele fica só em `E:/kidmais-pg-descartavel/ensaio-promocao/` e não sai dali: não copiar para o repositório, para o vault, para outra pasta, para chat nem para ferramenta externa. O cluster restaurado também fica só nessa pasta. No fim, tudo é apagado (seção 6).
2. **O relatório do executor não tem conteúdo de linha**: só passo, fase, código, resultado, situação do COMMIT, duração, rótulos de estado, hashes de catálogo e contagens. Os marcadores que os núcleos gravam na pasta do ensaio trazem o mesmo tipo de informação (estados e contagens agregadas). A mensagem do núcleo entra no relatório por lista de permissão (identificador do núcleo e termos com forma de nome de catálogo ou de migration; texto livre nunca). **A mensagem crua não aparece no terminal** (quem roda o executor pode ser um agente, e a saída do terminal entra na conversa dele): ela é gravada em `saida-crua.log`, dentro da pasta do ensaio, uma linha por ocorrência com hora, passo, fase e código — inclusive `detail`, `where` e `hint` de um erro do servidor, que costumam trazer valor de linha (`Key (email)=(…) already exists`). No terminal e no relatório sai só o aviso de que há saída crua e o nome do arquivo. **`saida-crua.log` e os marcadores dos núcleos (`marcadores/`) têm dado de cliente**: não copiar, não colar em conversa, não anexar; para ler, abrir o arquivo na própria pasta. Os dois somem quando a pasta do ensaio é apagada (seção 6); o executor não apaga nada sozinho. Não colar a saída de `psql` nem trechos do dump em lugar nenhum.
3. **Versão do PostgreSQL: a mesma versão maior do servidor, a 18.** Os scripts do repositório usam `C:/Program Files/PostgreSQL/18/bin` e os núcleos recusam fora dela onde o retrato foi medido (102: `VERSAO_PG_NAO_MEDIDA_102`; 107-108: retratos medidos no PostgreSQL 18). `pg_restore` de versão menor que a do `pg_dump` que gerou o arquivo também falha. Confirmar a versão de production no painel do Render antes de pedir o dump.
4. **Restauração lógica muda retratos de catálogo sem deriva real.** `pg_dump`/`pg_restore` recria CHECKs, índices e defaults a partir do texto que o servidor devolve (`pg_get_constraintdef` e afins), e esse texto não faz ida e volta exata (por exemplo `BETWEEN` vira dois `AND` reagrupados). Consequências, conforme `scripts/migration-102-103-comum.cjs` (cabeçalho e plano):
   - **102**: o retrato semântico da 102 (`RETRATO_102`) é medido sobre os objetos que a própria 102 cria. No ensaio a 102 é aplicada **depois** da restauração, então os objetos dela nascem do SQL da migration e o retrato confere. O problema aparece se o dump for tirado de um banco que **já tem a 102** (por exemplo, um dump de production feito depois da janela, ou um dump de staging): aí a integridade e o postcheck da 102 dão falso e o down recusa, sem que haja deriva. Nesse caso o núcleo manda não aceitar o hash encontrado: comparar as definições, revisar e aprovar uma referência nova. Para a recuperação da janela real vale só PITR (restauração física).
   - **107-108 — PROVADO no sintético (seção 7): numa cópia restaurada por `pg_restore`, o CONFERIR da 107-108 recusa com `RETRATO_F0_DIVERGENTE`.** O retrato F0 cobre objetos que já existem antes da promoção; a restauração muda as seções `constraints` e `indices` do retrato (as outras seis ficam iguais) mesmo num banco que, antes do dump, dava `canonico`. Logo, **sem a flag `--retrato-da-copia` o ensaio sobre o dump real para no passo 107-108** (depois de 089 … 104-106), e os passos seguintes (109 em diante) não são alcançados. Isso não é defeito da cadeia nem achado sobre production: o F0 de production só o `--conferir-107-108` de production mostra. Não contornar aceitando o hash encontrado à mão. **Decisão do dono D-ENS-1 (12/11/2026): para ensaiar da 107-108 em diante usa-se `--retrato-da-copia` (seção 7), que mede o retrato na própria cópia e por isso deixa de verificá-lo de forma independente.** `--no-privileges` ainda remove as ACL explícitas, que também entram no retrato.
   - **109** (retrato de `assinatura_renovacoes` igual ao da 075): na cópia restaurada do sintético o CONFERIR da 109 continuou `PRONTA_PARA_APLICAR`; na cópia real, conferir a linha da 109 no `--so-conferir`.
5. O ensaio **não exercita** o que é do adaptador de production, do bloco de Shell ou do deploy: travas de alvo/TLS/disco, conferência de sha256 dos arquivos implantados, o deploy do código novo antes da 094, e a regra de registro `PITR <AAAA-MM-DDTHH:MMZ> <referencia>` da 118. O relatório lista isso em "não exercido".

## 1. Cluster descartável

Pasta: `E:/kidmais-pg-descartavel/ensaio-promocao` (PGDATA, `server.log` e o dump ficam nela; não escrever em outra pasta do `E:`). Porta: uma livre acima de 55500 que não apareça no `netstat` nem nos scripts de `D:/glass/KidMais Manager/ambientes-locais`; **5432 e 5433 são clusters reais** e o executor os recusa. Nos exemplos, `55844`.

Git Bash, sempre com `env -u DATABASE_URL` (e sem imprimir o `env`):

```bash
D="E:/kidmais-pg-descartavel/ensaio-promocao"; BIN="/c/Program Files/PostgreSQL/18/bin"; PORTA=55844
test ! -e "$D" && mkdir "$D"
netstat -ano | grep -c ":$PORTA "        # precisa dar 0
env -u DATABASE_URL "$BIN/initdb.exe" -D "$D/pgdata" -U kidmais_descartavel --auth=trust --encoding=UTF8 \
  --locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C > "$D/initdb.log" 2>&1
printf "\nlisten_addresses = '127.0.0.1'\nport = $PORTA\ncluster_name = 'kidmais_descartavel'\nlc_messages = 'C'\n" >> "$D/pgdata/postgresql.conf"
env -u DATABASE_URL "$BIN/pg_ctl.exe" -D "$D/pgdata" -l "$D/server.log" -o "-p $PORTA" -w -t 120 start > /dev/null 2>&1 < /dev/null
"$BIN/pg_ctl.exe" -D "$D/pgdata" status
```

O papel do `initdb` e o `cluster_name` têm de ser `kidmais_descartavel`: é o que o executor e cada núcleo conferem no servidor antes de qualquer outra consulta.

## 2. Restaurar o dump

Colocar o arquivo em `E:/kidmais-pg-descartavel/ensaio-promocao/` (nome sem espaços). Restaurar num banco **base**, que não é o banco ensaiado; cada rodada usa uma cópia dele.

Dump em formato custom (`pg_dump -Fc`):

```bash
PSQL="env -u DATABASE_URL $BIN/psql.exe -h 127.0.0.1 -p $PORTA -U kidmais_descartavel -v ON_ERROR_STOP=1"
env -u DATABASE_URL "$BIN/psql.exe" -h 127.0.0.1 -p $PORTA -U kidmais_descartavel -d postgres -qAt -c "CREATE DATABASE kidmais_ensaio_base TEMPLATE template0"
env -u DATABASE_URL "$BIN/pg_restore.exe" -h 127.0.0.1 -p $PORTA -U kidmais_descartavel -d kidmais_ensaio_base \
  --no-owner --no-privileges --exit-on-error "$D/<arquivo>.dump" > "$D/restore.log" 2>&1; echo "pg_restore=$?"
```

Export do Render (`.dir.tar.gz`, formato diretório do `pg_dump`; é o que a página Recovery → Create export entrega, segundo o roteiro da promoção — este caminho **não foi ensaiado** aqui, só o formato custom): extrair dentro da pasta do ensaio e passar o **diretório** extraído ao mesmo `pg_restore`, no lugar do arquivo `.dump`:

```bash
mkdir "$D/export" && tar -xzf "$D/<arquivo>.dir.tar.gz" -C "$D/export"
ls "$D/export"                      # o diretório que contém toc.dat é o que vai para o pg_restore
env -u DATABASE_URL "$BIN/pg_restore.exe" -h 127.0.0.1 -p $PORTA -U kidmais_descartavel -d kidmais_ensaio_base \
  --no-owner --no-privileges --exit-on-error "$D/export/<diretorio-com-toc.dat>" > "$D/restore.log" 2>&1; echo "pg_restore=$?"
```

Export em SQL (texto):

```bash
env -u DATABASE_URL "$BIN/psql.exe" -h 127.0.0.1 -p $PORTA -U kidmais_descartavel -d postgres -qAt -c "CREATE DATABASE kidmais_ensaio_base TEMPLATE template0"
env -u DATABASE_URL "$BIN/psql.exe" -h 127.0.0.1 -p $PORTA -U kidmais_descartavel -d kidmais_ensaio_base -v ON_ERROR_STOP=1 -q -f "$D/<arquivo>.sql" > "$D/restore.log" 2>&1; echo "psql=$?"
```

Notas:

- `--no-owner` é necessário: os núcleos exigem que o papel conectado seja dono dos objetos que alteram, e no cluster local só existe `kidmais_descartavel`. Num export em SQL com `ALTER ... OWNER TO <papel de production>`, a restauração para no primeiro deles; pedir o export sem dono (`--no-owner`) ou restaurar o formato custom.
- `--no-privileges` evita `GRANT` para papéis que não existem aqui; o efeito sobre o retrato F0 está no aviso 4.
- Código de saída diferente de 0 ou qualquer erro em `restore.log` (extensão ausente, por exemplo): **parar** e relatar; não ensaiar sobre restauração parcial. `restore.log` pode citar nomes de objetos, não dados; fica na pasta.
- O banco não pode se chamar `kidmais_production`, `kidmais_staging_1z91`, `kidmais_manager`, `postgres`, `template0` nem `template1`: o executor recusa esses nomes e recusa o cluster inteiro se existir nele um banco com um dos três primeiros.

Cópia de trabalho para cada rodada (o base fica intacto):

```bash
env -u DATABASE_URL "$BIN/psql.exe" -h 127.0.0.1 -p $PORTA -U kidmais_descartavel -d postgres -qAt -c "CREATE DATABASE kidmais_ensaio_r1 TEMPLATE kidmais_ensaio_base"
```

## 3. Só conferir (não aplica nada)

Na raiz do clone, com `npm ci` feito. A autorização é a das suítes PostgreSQL, com o banco do ensaio no literal:

```bash
cd "<clone>"; BANCO=kidmais_ensaio_r1
env -u DATABASE_URL -u KIDMAIS_HOMOLOGACAO_DATABASE_URL \
  KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel KIDMAIS_DESCARTAVEL_PORTA=$PORTA \
  KIDMAIS_DESCARTAVEL_AUTORIZACAO=127.0.0.1:$PORTA/$BANCO \
  node --experimental-strip-types --no-warnings scripts/ensaio-promocao-local.cjs --porta $PORTA --banco $BANCO --so-conferir
```

O executor recusa, antes de conectar, se houver no ambiente `RENDER*`, qualquer `*DATABASE_URL` ou qualquer `PG*` (a mensagem traz só o nome da variável): tirar com `env -u <NOME>`.

`--so-conferir` roda o CONFERIR de **todos** os 23 passos, sem parar, em transações somente leitura. É o modo que mostra, na cópia real:

- **se a 089 falta**: linha `089` com `m089=ausente` e `PRONTA_PARA_APLICAR` (ou `completa`/`parcial`);
- **o retrato da 107-108**: enquanto as dependências (093/094/100/102/104/106) não existem, o núcleo recusa com `SEM_DEPENDENCIA_108` **antes** de medir o retrato; o F0 só aparece no ensaio completo, no CONFERIR do passo `107-108` (coluna `retrato F0 <variante> <hash>`);
- o estado de cada migration: `ausente`, `completa`/`presente`, `parcial`, `divergente` (107: `ausente`/`presente`; 108: `AUSENTE`/`NOVA`/`ANTIGA`/`PARCIAL`).

Antes da promoção é **esperado** que vários passos respondam `RECUSARIA` por dependência ainda não aplicada (094, 100, 102-103, 104-106, 107-108, 114, 116, 111): cada um depende de um passo anterior da própria cadeia. No banco sintético (seção 8) foram exatamente esses oito. O que **não** é esperado e deve ser relatado: `parcial`, `divergente` num passo sem dependência pendente (a 114 aparece `divergente` enquanto a 094 não entra: os corpos que ela compara são os de depois da 094), `FALHA` (código 2), ou 099/105 fora do estado previsto (essas duas não têm passo; conferir com `scripts/conferencia-b5-producao.cjs` se necessário).

## 4. Ensaio completo

Numa cópia nova (por exemplo `kidmais_ensaio_r2`), o mesmo comando sem `--so-conferir`:

```bash
BANCO=kidmais_ensaio_r2
env -u DATABASE_URL -u KIDMAIS_HOMOLOGACAO_DATABASE_URL \
  KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel KIDMAIS_DESCARTAVEL_PORTA=$PORTA \
  KIDMAIS_DESCARTAVEL_AUTORIZACAO=127.0.0.1:$PORTA/$BANCO \
  node --experimental-strip-types --no-warnings scripts/ensaio-promocao-local.cjs --porta $PORTA --banco $BANCO; echo "saida=$?"
```

Para cada passo: CONFERIR → APLICAR → CONFERIR de novo, pelo `principal` do núcleo (`scripts/migration-<n>-comum.cjs`) com o adaptador de ensaio; 120, 121, 110, 111 e 115 pela lógica do aplicador genérico. `proximoPasso` da ordem decide o próximo; **qualquer código diferente de 0 para a cadeia**.

**Cópia restaurada por `pg_dump`/`pg_restore` (o caso do dump real):** acrescentar `--retrato-da-copia` ao mesmo comando. Sem ela a cadeia para na 107-108 (aviso 4 e seção 7); com ela o retrato da 107-108 é medido na própria cópia e o relatório diz isso (seção 7). A flag só vale na cadeia: com `--so-conferir` o executor recusa (`RETRATO_DA_COPIA_EXIGE_CADEIA`).

```bash
BANCO=kidmais_ensaio_r2
env -u DATABASE_URL -u KIDMAIS_HOMOLOGACAO_DATABASE_URL \
  KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel KIDMAIS_DESCARTAVEL_PORTA=$PORTA \
  KIDMAIS_DESCARTAVEL_AUTORIZACAO=127.0.0.1:$PORTA/$BANCO \
  node --experimental-strip-types --no-warnings scripts/ensaio-promocao-local.cjs --porta $PORTA --banco $BANCO --retrato-da-copia; echo "saida=$?"
```

Códigos de saída do executor: `0` cadeia concluída (ou `--so-conferir` terminado); `1` recusa antes de qualquer passo (alvo, ambiente, autorização, identidade do servidor); `2` cadeia parada.

Depois de uma parada, **não repetir na mesma cópia nem na mesma pasta**: os marcadores exclusivos dos núcleos recusam (`TENTATIVA_ANTERIOR_REVISAR`), como em production; e a cadeia **não recomeça do início num banco que já passou da 094** — o CONFERIR do passo `092-093` recusa com `ESCOPO_092_093_EXIGE_094_AUSENTE` (regra do núcleo da 092–094; provado no sintético). Investigar, criar outra cópia do base e rodar de novo (cada execução cria a própria pasta; `--pasta <pasta-nova>` escolhe uma, que precisa estar vazia).

## 5. Ler o relatório

O executor imprime o relatório em texto e grava `relatorio.json` e `relatorio.txt` na pasta do ensaio (por padrão uma pasta nova no diretório temporário do usuário; o caminho sai na última linha). Os marcadores dos núcleos ficam em `<pasta>/marcadores/<passo>/`.

| Campo | Significado |
|---|---|
| `passo`, `fase` | passo da ordem e CONFERIR, APLICAR ou CONFERIR_DEPOIS |
| `codigo` | 0 sucesso; 1 recusa antes de conectar; 2 FALHA registrada; 3 conferência RECUSARIA (os mesmos dos aplicadores) |
| `resultado` | o do núcleo: `PRONTA_PARA_APLICAR`, `APLICADA_POSTCHECK_PASS`, `JA_APLICADA_*`, `RECUSARIA`, `FALHA`, `RECUSADO` |
| `commit` | situação do COMMIT no APLICAR, como o núcleo informou: `CONFIRMADO`, `NAO_COMMITADA`, `DESFEITA_PELO_SERVIDOR`, `INDETERMINADO`; por migration nos passos de grupo. `CONFIRMADO_PELO_RESULTADO` = núcleos da 089 à 097, que não devolvem o campo (a migration commita no próprio arquivo e o resultado é `APLICADA_*`). `SEM_CONFIRMACAO_DO_NUCLEO`/`NAO_INFORMADA` = rodar o CONFERIR antes de concluir qualquer coisa |
| `duracaoMs` | duração da fase |
| `estado` | rótulos por migration (`m089=ausente`…), sem dados |
| `retrato` (107-108) | fase, variante reconhecida, hash do catálogo medido e, no JSON, `secoes` (quantidade e sha256 por seção) |
| `mensagem`, `etapa` | só quando o código não é 0. A mensagem entra por **lista de permissão**: o identificador do núcleo (`APLICACAO_PARCIAL_090`), seguido só de termos com forma de identificador de catálogo ou de migration (os demais são omitidos e contados: `[2 termo(s) omitido(s)]`); mensagem sem identificador vira `MENSAGEM_NAO_RECONHECIDA (detalhe em saida-crua.log, na pasta do ensaio; não copiar para fora dela)`. Nenhum texto livre entra no relatório |
| `saidaCrua` | quando houve alguma fase com código diferente de 0: o nome do arquivo (`saida-crua.log`) e o número de ocorrências; nunca o conteúdo |
| `faltas` | privilégios que faltam, quando o genérico recusa (`CREATE no schema public`, `posse da tabela …`, `REFERENCES em …`, `posse da função …`): a lista inteira |
| `parada` | passo, fase, código, significado e mensagem da fase que parou a cadeia |
| `contagens` | número de tabelas em `public` e linhas por tabela principal, antes e depois da execução inteira |
| `valoresDeEnsaio`, `naoExercido` | o que o ensaio forneceu no lugar do ambiente de production e o que ele não exercita |

Como ler as contagens: tabelas que já existiam devem manter o número de linhas (a exceção conhecida é `adicional_categorias`, +1 pela categoria Serviços da 103); tabelas novas aparecem como `ausente → 0`. Diferença em tabela existente é achado a investigar.

O que levar para a decisão da janela: a tabela passo a passo, a parada (a do passo 107-108 é esperada, aviso 4; qualquer outra é achado), as durações do APLICAR sobre dados reais e, se o retrato divergir, o resumo por seção (`retrato.secoes` no JSON: quantidade e sha256 por seção, sem definições).

## 6. Apagar tudo no fim

```bash
env -u DATABASE_URL "$BIN/pg_ctl.exe" -D "$D/pgdata" stop -m fast -w
"$BIN/pg_ctl.exe" -D "$D/pgdata" status      # "nenhum servidor em execução" (código 3)
netstat -ano | grep -c ":$PORTA "            # 0
rm -rf "$D"; test ! -e "$D" && echo removido
```

Apagar também as pastas do ensaio no diretório temporário (`kidmais-ensaio-promocao-*`), inteiras: é assim que somem `saida-crua.log` e os marcadores, que têm dado de cliente. Antes, copiar para o vault só o `relatorio.txt` que interessar (ele não tem dados de linha); nunca `saida-crua.log` nem `marcadores/`. O dump e o cluster não são copiados para lugar nenhum.

## 7. Dois limites conhecidos: retrato da 107–108 e retomada

### Retrato F0 da 107–108 numa cópia restaurada

Medido no banco sintético em 12/11/2026 (diagnóstico só de catálogo):

- O retrato (`scripts/migration-108-retrato.cjs`) guarda, por constraint e por índice das tabelas do escopo, o **texto** de `pg_get_constraintdef` e de `pg_get_indexdef`, sem normalização. Uma restauração lógica recria esses objetos a partir do texto, e o servidor passa a devolver outro texto, com a mesma semântica.
- No cenário do ensaio (dump antes da cadeia, restauração, cadeia até a 104-106) mudam **12 CHECKs e 2 índices**, todos no deparse de `IN (...)` sobre `varchar`: de `= ANY ((ARRAY['X'::character varying, …])::text[])` para `= ANY (ARRAY[('X'::character varying)::text, …])`. São eles: `contratos_status_check`; `fr_buffet_ck`, `fr_categorias_ck`, `fr_congelamento_ck`, `fr_estado_ck`, `fr_forma_ck`; `fechamentos_buffet_status_check`, `fechamentos_categoria_horario_check`, `fechamentos_categoria_preco_check`, `fechamentos_forma_pagamento_pretendida_check`, `fechamentos_origem_check`, `fechamentos_status_check`; e os índices parciais `fechamento_revisoes_aberta_uk` e `fr_agenda_aberta_idx`. Nomes, quantidades, ordem e os campos booleanos ficam iguais. (Num dump tirado depois da cadeia entram ainda 2 CHECKs com `BETWEEN`.)
- O resultado é o mesmo em **qualquer formato**: custom, diretório (o do export do Render), com ou sem `--no-owner`/`--no-privileges`, com `-j`, com `--section` em separado e SQL por `psql`; e não muda numa segunda restauração.
- Por isso **a cópia restaurada nunca casa com nenhuma das variantes de F0** de `database/checks/20261029_108_retratos_esperados.json` (`canonico`, `deriva_conhecida`, `staging_20261030`), e o CONFERIR da 107–108 recusa com `RETRATO_F0_DIVERGENTE`. Além disso, o `pg_dump` não emite ACL explícita equivalente ao padrão: restaurar um banco como o de staging perde as ACL de EXECUTE que a variante `staging_20261030` registra.
- **Restauração física preserva** as definições e o retrato (é o que o núcleo da 102–103 afirma sobre PITR). O hash medido na cópia lógica não diz nada sobre o retrato de production: esse só o `--conferir-107-108` em production mostra.

### Modo `--retrato-da-copia` (D-ENS-1)

Para ensaiar da 107-108 em diante sobre uma cópia restaurada logicamente, o executor mede o retrato na própria cópia. Só vale na cadeia inteira (recusa com `--so-conferir`) e, sem a flag, nada muda (`aceitaRetratosTeste: false`, variantes do arquivo).

**Como funciona.** Ao chegar no passo 107-108 (a medição é uma só, no CONFERIR do passo, com o banco no estado de então), o executor faz uma **cópia física** temporária do banco do ensaio no mesmo cluster local: `CREATE DATABASE <banco>_gemeo_retrato TEMPLATE <banco>` (cópia de arquivos: preserva o texto do catálogo que a restauração lógica mudou). O gêmeo passa pelas travas do alvo (loopback, porta fora de 5432/5433, nome fora da lista recusada, no máximo 63 caracteres, identidade provada no servidor), só nasce do banco já autorizado, tem nome previsível, é **recusado se já existir** (`GEMEO_JA_EXISTE`) e é apagado sempre, também em falha (`DROP DATABASE ... WITH (FORCE)`; se não apagar, `GEMEO_NAO_APAGADO`). Em cada gêmeo roda o núcleo REAL da 107-108 com `aceitaRetratosTeste: true` e `KIDMAIS_RETRATOS_108_TESTE` com um hash fictício nas fases ainda não medidas; o núcleo mede o retrato **antes** de comparar e um cliente embrulhado guarda o hash:

| Gêmeo | Núcleo | Revela |
|---|---|---|
| 1 | CONFERIR com F0/F1/F2 fictícios (recusa `RETRATO_F0_DIVERGENTE`) | hash F0 |
| 2 | APLICAR com F0 real: a 107 confirma e o F1 fictício recusa (`RETRATO_F1_DIVERGENTE`) | hash F1 |
| 3 | APLICAR com F0 e F1 reais: a 108 mede o F2 dentro da transação e a prova recusa (`RETRATO_F2`) | hash F2 |

O núcleo exige a variante F0 `canonico` se e somente se a avaliação da 107 for toda canônica. Por isso o F0 entra primeiro com o rótulo `copia` e, se o núcleo recusar `RETRATO_F0_INCOERENTE`, o gêmeo é refeito com o rótulo `canonico` para o mesmo hash (um 4º gêmeo). Depois o passo 107-108 REAL roda no banco do ensaio (CONFERIR, APLICAR e CONFERIR_DEPOIS) com os três hashes e `aceitaRetratosTeste: true` — só neste passo e só neste modo. Os marcadores dos gêmeos ficam em `<pasta>/gemeos/` (dado de cliente, como os demais; somem com a pasta).

**O que o relatório mostra.** Bloco `ATENÇÃO — RETRATO DA 107–108 MEDIDO NA CÓPIA`, com os três hashes e se cada um casou com alguma variante do arquivo de esperados (F0 `nenhuma` é o esperado numa restauração lógica); `retratoDaCopia` no JSON (`origem: MEDIDO_NA_COPIA`, `variante: copia`, `confereProduction: false`); a linha de retrato do passo marcada `[MEDIDO NA CÓPIA]` (com o rótulo interno do núcleo, quando for `canonico`); `valoresDeEnsaio` e `naoExercido` trocados conforme o modo. Se o passo 107-108 não for alcançado, o bloco diz que nada foi medido. A política de saída segura é a mesma (lista de permissão, nada cru no terminal, `saida-crua.log` só na pasta).

**O que prova.** Que, na cópia, a 107 e a 108 aplicam sobre os dados e o schema reais, que todas as outras verificações do núcleo (avaliação objeto a objeto da 107, prechecks, integridade, postchecks, prova "108 íntegra" menos a comparação do hash do retrato) passam, que os passos 109 em diante rodam, e os tempos do APLICAR. **O que enfraquece:** o retrato deixa de ser verificação independente no ensaio, porque o esperado é o próprio medido (uma deriva real de catálogo em production não seria apontada por aqui; F0, F1 e F2 sempre "conferem" consigo mesmos). Isso não se transfere para a janela: lá o aplicador de production segue com `aceitaRetratosTeste: false` e as variantes do arquivo, e o `--conferir-107-108` de production é que decide. Os hashes medidos na cópia não valem para production.

### Retomada depois de uma parada

- Depois da 094, **a cadeia não recomeça do início**: o passo `092-093` exige a 094 ausente e o CONFERIR dele recusa (`ESCOPO_092_093_EXIGE_094_AUSENTE`). Em production retoma-se **do passo que parou**, depois de ler a saída e o marcador e com decisão de Felipe; nunca se volta à 089.
- No ensaio, cada tentativa usa **cópia nova** do banco base e pasta nova (o executor sempre parte da 089 e os marcadores são exclusivos).

## 8. O que já foi provado (banco sintético, 12/11/2026)

Cluster novo em `E:/kidmais-pg-descartavel/ensaio-sintetico`, PostgreSQL 18.6, porta 55843, removido ao fim. Banco montado **sem editar a receita**: modelo `b14-P0a` de `scripts/regressao-v1-postgres-receita.cjs` (inventário até a 088, na ordem do inventário, com os checks) e, numa cópia dele, a 099 e a 105 por `aplicarMigracoes` — a mesma "base de production" da suíte `lib/assinatura/conferidor-g-vazio.postgres.test.ts`, e o prefixo `ESPERADO_BASE_ANTES_DO_E3`/`ESPERADO_ANTES_DO_E3` de `scripts/conferencia-b5-producao.cjs` (089–097 ausentes, 099 e 105 completas, 100 `sem_094`, o resto ausente).

- `--so-conferir`: 23 passos conferidos; 15 `PRONTA_PARA_APLICAR` e 8 `RECUSARIA` por dependência de passo anterior (094, 100, 102-103, 104-106, 107-108, 114, 116, 111). Nenhuma escrita (181 tabelas antes e depois).
- Ensaio completo: os 23 passos, 69 fases, todas com código 0; retrato F0 da 107-108 = `canonico`; 181 → 227 tabelas; contagens das tabelas existentes iguais, salvo `adicional_categorias` 6 → 7.
- Parada: numa cópia com a 090 sabotada (tabela `assinatura_campanhas` vazia criada à mão), o ensaio aplicou a 089, parou no CONFERIR da 090 com código 3 (`APLICACAO_PARCIAL_090`) e saiu com 2.

- Restauração lógica: `pg_dump -Fc` do banco sintético e `pg_restore --no-owner --no-privileges --exit-on-error` num banco novo (saída 0, log vazio). Sobre a cópia restaurada, o ensaio passou 089 … 104-106 (33 fases com código 0) e **parou no CONFERIR da 107-108 com `RETRATO_F0_DIVERGENTE`** (código 3, saída 2). Comparando o resumo por seção com o do banco original: `constraints` (162) e `indices` (56) diferentes; `colunas`, `funcoes`, `gatilhos`, `marcador_108`, `presenca_funcoes` e `relacoes` iguais. O `--so-conferir` nessa cópia mostrou a 109 `PRONTA_PARA_APLICAR`.
- Recomeço: rodar a cadeia de novo, do início, numa cópia que já tinha a 094 parou no CONFERIR do passo `092-093` (`ESCOPO_092_093_EXIGE_094_AUSENTE`).
- Genérico com a conferência de privilégios (correções P3 integradas): `--so-conferir` e o ensaio completo repetidos, com o mesmo resultado (69 fases com código 0). Privilégios em servidor real, pelo envelope do ensaio e com a sessão em `SET ROLE`: papel só com USAGE e SELECT → CONFERIR de 120, 121, 110, 111 e 115 `RECUSARIA` (código 3) com `PRIVILEGIO_INSUFICIENTE` e o nome de cada falta (`CREATE no schema public`, `posse da tabela …`, `REFERENCES em …`), e APLICAR recusado antes do marcador (pasta de marcadores vazia, 181 tabelas antes e depois); papel com CREATE e REFERENCES mas sem posse → só as faltas de posse (tabelas e a função `kidmais086_execucao_tenant()`); papel dono → `PRONTA_PARA_APLICAR` e `APLICADA_POSTCHECK_PASS` nas cinco.

- `--retrato-da-copia` (cluster novo PostgreSQL 18.6, porta alta, removido ao fim): base sintética como acima (b14-P0a + 099 + 105), `pg_dump -Fc` + `pg_restore --no-owner --no-privileges`, duas cópias restauradas. (a) Sem a flag: 089 … 104-106 com código 0 e parada no CONFERIR da 107-108 com `RETRATO_F0_DIVERGENTE` (código 3, saída 2). (b) Com a flag, em cópia nova: a cadeia inteira concluiu (23 passos, 69 fases, todas com código 0, saída 0); 4 gêmeos (o rótulo `copia` foi incoerente porque a avaliação da 107 era toda canônica, então o F0 entrou como `canonico`), todos apagados; F0/F1/F2 não casaram com nenhuma variante do arquivo; nenhum gêmeo sobrou no cluster.

**Limites.** (1) O banco sintético não tem festas, contratos, assinaturas, mensagens nem a deriva de catálogo de production (o retrato deu `canonico`; o de staging é `staging_20261030`). Ele prova o executor, a ordem e que a cadeia fecha sobre o schema do inventário; **não** prova os prechecks sobre dados reais (inventário de pares da 100, documentos da 091, preservações), os retratos de production nem os tempos. (2) Sobre o dump real, pelo que a restauração do sintético mostrou, o ensaio sem flag vai até a 104-106 e para na 107-108; com `--retrato-da-copia` (D-ENS-1) vai adiante, ao custo de o retrato não ser verificação independente (seção 7). (3) O modo não foi provado sobre o dump real nem sobre o export em formato diretório do Render, e o `CREATE DATABASE ... TEMPLATE` exige que ninguém esteja conectado ao banco do ensaio durante a medição (o executor não mantém conexão aberta; um `psql` aberto por quem roda faz a medição falhar).

