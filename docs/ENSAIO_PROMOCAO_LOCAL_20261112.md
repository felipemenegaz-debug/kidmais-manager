# Ensaio local da promoção staging → production (12/11/2026)

Roteiro para ensaiar a cadeia de migrations da promoção numa **cópia do banco de production restaurada num PostgreSQL local descartável**, antes da janela. Executor: `scripts/ensaio-promocao-local.cjs`. Ordem da cadeia: `scripts/promocao-production-ordem.cjs` (roteiro de production em `docs/PROMOCAO_UNICA_PRODUCTION_20261112.md`).

**Isto não é autorização de nada em production nem em staging.** O executor só conecta em `127.0.0.1`, num cluster com `cluster_name = kidmais_descartavel`, e nunca usa os adaptadores de production.

## Avisos antes de começar

1. **O dump tem dados pessoais** (clientes, contratantes, crianças, documentos, telefones). Ele fica só em `E:/kidmais-pg-descartavel/ensaio-promocao/` e não sai dali: não copiar para o repositório, para o vault, para outra pasta, para chat nem para ferramenta externa. O cluster restaurado também fica só nessa pasta. No fim, tudo é apagado (seção 6).
2. **O relatório do executor não tem conteúdo de linha**: só passo, fase, código, resultado, situação do COMMIT, duração, rótulos de estado, hashes de catálogo e contagens. Os marcadores que os núcleos gravam na pasta do ensaio trazem o mesmo tipo de informação (estados e contagens agregadas). Ainda assim, não colar a saída de `psql` nem trechos do dump em lugar nenhum.
3. **Versão do PostgreSQL: a mesma versão maior do servidor, a 18.** Os scripts do repositório usam `C:/Program Files/PostgreSQL/18/bin` e os núcleos recusam fora dela onde o retrato foi medido (102: `VERSAO_PG_NAO_MEDIDA_102`; 107-108: retratos medidos no PostgreSQL 18). `pg_restore` de versão menor que a do `pg_dump` que gerou o arquivo também falha. Confirmar a versão de production no painel do Render antes de pedir o dump.
4. **Restauração lógica muda retratos de catálogo sem deriva real.** `pg_dump`/`pg_restore` recria CHECKs, índices e defaults a partir do texto que o servidor devolve (`pg_get_constraintdef` e afins), e esse texto não faz ida e volta exata (por exemplo `BETWEEN` vira dois `AND` reagrupados). Consequências, conforme `scripts/migration-102-103-comum.cjs` (cabeçalho e plano):
   - **102**: o retrato semântico da 102 (`RETRATO_102`) é medido sobre os objetos que a própria 102 cria. No ensaio a 102 é aplicada **depois** da restauração, então os objetos dela nascem do SQL da migration e o retrato confere. O problema aparece se o dump for tirado de um banco que **já tem a 102** (por exemplo, um dump de production feito depois da janela, ou um dump de staging): aí a integridade e o postcheck da 102 dão falso e o down recusa, sem que haja deriva. Nesse caso o núcleo manda não aceitar o hash encontrado: comparar as definições, revisar e aprovar uma referência nova. Para a recuperação da janela real vale só PITR (restauração física).
   - **107-108 — PROVADO no sintético (seção 7): numa cópia restaurada por `pg_restore`, o CONFERIR da 107-108 recusa com `RETRATO_F0_DIVERGENTE`.** O retrato F0 cobre objetos que já existem antes da promoção; a restauração muda as seções `constraints` e `indices` do retrato (as outras seis ficam iguais) mesmo num banco que, antes do dump, dava `canonico`. Logo, **o ensaio sobre o dump real para no passo 107-108** (depois de 089 … 104-106), e os passos seguintes (109 em diante) não são alcançados. Isso não é defeito da cadeia nem achado sobre production: o F0 de production só o `--conferir-107-108` de production mostra. Não contornar aceitando o hash encontrado; como ensaiar da 107-108 em diante é decisão do dono (ver "Limites" na seção 7). `--no-privileges` ainda remove as ACL explícitas, que também entram no retrato.
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

Antes da promoção é **esperado** que vários passos respondam `RECUSARIA` por dependência ainda não aplicada (094, 100, 102-103, 104-106, 107-108, 114, 116, 111): cada um depende de um passo anterior da própria cadeia. No banco sintético (seção 7) foram exatamente esses oito. O que **não** é esperado e deve ser relatado: `parcial`, `divergente` num passo sem dependência pendente (a 114 aparece `divergente` enquanto a 094 não entra: os corpos que ela compara são os de depois da 094), `FALHA` (código 2), ou 099/105 fora do estado previsto (essas duas não têm passo; conferir com `scripts/conferencia-b5-producao.cjs` se necessário).

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
| `mensagem`, `etapa` | só quando o código não é 0: a mensagem do núcleo (e-mail, UUID, CPF/CNPJ e números longos mascarados) e a etapa em que falhou |
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

Apagar também as pastas do ensaio no diretório temporário (`kidmais-ensaio-promocao-*`), depois de copiar para o vault só o `relatorio.txt` que interessar (ele não tem dados de linha). O dump e o cluster não são copiados para lugar nenhum.

## 7. O que já foi provado (banco sintético, 12/11/2026)

Cluster novo em `E:/kidmais-pg-descartavel/ensaio-sintetico`, PostgreSQL 18.6, porta 55843, removido ao fim. Banco montado **sem editar a receita**: modelo `b14-P0a` de `scripts/regressao-v1-postgres-receita.cjs` (inventário até a 088, na ordem do inventário, com os checks) e, numa cópia dele, a 099 e a 105 por `aplicarMigracoes` — a mesma "base de production" da suíte `lib/assinatura/conferidor-g-vazio.postgres.test.ts`, e o prefixo `ESPERADO_BASE_ANTES_DO_E3`/`ESPERADO_ANTES_DO_E3` de `scripts/conferencia-b5-producao.cjs` (089–097 ausentes, 099 e 105 completas, 100 `sem_094`, o resto ausente).

- `--so-conferir`: 23 passos conferidos; 15 `PRONTA_PARA_APLICAR` e 8 `RECUSARIA` por dependência de passo anterior (094, 100, 102-103, 104-106, 107-108, 114, 116, 111). Nenhuma escrita (181 tabelas antes e depois).
- Ensaio completo: os 23 passos, 69 fases, todas com código 0; retrato F0 da 107-108 = `canonico`; 181 → 227 tabelas; contagens das tabelas existentes iguais, salvo `adicional_categorias` 6 → 7.
- Parada: numa cópia com a 090 sabotada (tabela `assinatura_campanhas` vazia criada à mão), o ensaio aplicou a 089, parou no CONFERIR da 090 com código 3 (`APLICACAO_PARCIAL_090`) e saiu com 2.

- Restauração lógica: `pg_dump -Fc` do banco sintético e `pg_restore --no-owner --no-privileges --exit-on-error` num banco novo (saída 0, log vazio). Sobre a cópia restaurada, o ensaio passou 089 … 104-106 (33 fases com código 0) e **parou no CONFERIR da 107-108 com `RETRATO_F0_DIVERGENTE`** (código 3, saída 2). Comparando o resumo por seção com o do banco original: `constraints` (162) e `indices` (56) diferentes; `colunas`, `funcoes`, `gatilhos`, `marcador_108`, `presenca_funcoes` e `relacoes` iguais. O `--so-conferir` nessa cópia mostrou a 109 `PRONTA_PARA_APLICAR`.
- Recomeço: rodar a cadeia de novo, do início, numa cópia que já tinha a 094 parou no CONFERIR do passo `092-093` (`ESCOPO_092_093_EXIGE_094_AUSENTE`).

**Limites.** (1) O banco sintético não tem festas, contratos, assinaturas, mensagens nem a deriva de catálogo de production (o retrato deu `canonico`; o de staging é `staging_20261030`). Ele prova o executor, a ordem e que a cadeia fecha sobre o schema do inventário; **não** prova os prechecks sobre dados reais (inventário de pares da 100, documentos da 091, preservações), os retratos de production nem os tempos. (2) Sobre o dump real, pelo que a restauração do sintético mostrou, o ensaio vai até a 104-106 e para na 107-108: da 107-108 em diante, o ensaio com dados reais depende de uma decisão do dono (por exemplo, cópia física em vez de lógica, ou um modo de ensaio que meça os retratos na própria cópia — este último enfraquece a verificação do retrato e não foi implementado).

