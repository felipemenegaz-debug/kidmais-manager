# Reparo operacional da codificação das funções 016

Preparado e testado exclusivamente em clones. **Ainda não autorizado para execução em `kidmais_manager`.** Não é uma migration e não reaplica a 016.

Arquivo: `20260911_016_reparar_encoding_funcoes.sql`, UTF-8 sem BOM.

## Origem e escopo

As seis definições completas foram extraídas por `pg_get_functiondef()` do clone `kidmais_016_1789127372077`, cuja assinatura foi novamente conferida como `d723f81def59be627132230aa6de2e00b0b509d48f20b0e0701afd7eb99650d7`. As definições foram inseridas integralmente, acrescentando somente os delimitadores `;` necessários entre comandos. Nenhuma lógica foi reescrita e nenhuma definição foi obtida do banco real.

O arquivo contém somente controle transacional, configurações locais de sessão, verificações de catálogo e seis `CREATE OR REPLACE FUNCTION`. Não altera tabelas, dados, índices, constraints, triggers nem outras funções.

## Proteções

- `BEGIN` e `SET LOCAL client_encoding = 'UTF8'`; `search_path` local em `public` para representação de catálogo estável. Não modifica configurações globais.
- A assinatura inicial deve ser a canônica acima **ou exatamente** `f4ed68abf6e44dffb643cc618f0a22561c39e717e5637e032bab175019e43f55`, a divergência textual diagnosticada. Qualquer diferença adicional, inclusive lógica dentro de uma das seis funções, é recusada antes das substituições.
- A assinatura final usa a consulta estrutural integral do código atual, sem normalização ou flexibilização. Deve ser exatamente a canônica. Caso contrário, `RAISE EXCEPTION` aborta a transação; nenhum `COMMIT` das substituições é possível.
- O algoritmo em `estrutura-016.ts`, a assinatura esperada, a Migration016 e seu rollback permaneceram byte a byte inalterados.

## Codificação e futura execução

O clone aprovado foi instalado via Node/`pg`, lendo SQL com `fs.readFileSync(..., 'utf8')`. Em clone novo, executar as definições UTF-8 via `psql` com `PGCLIENTENCODING=WIN1252` reproduziu exatamente a assinatura corrompida observada no real. Isso demonstra o mecanismo provável: os bytes UTF-8 foram interpretados como Windows-1252 durante a aplicação. Não há evidência do comando/sessão original suficiente para afirmar em qual ponto do procedimento real ocorreu essa interpretação.

Somente após nova aprovação: configurar `$env:PGCLIENTENCODING = 'UTF8'` no PowerShell e usar `psql -X -v ON_ERROR_STOP=1 -f` apontando diretamente ao arquivo. Informar explicitamente o destino autorizado e autenticar sem colocar senha no comando. Não usar `Get-Content ... | psql`, redigitar definições ou passar o SQL por conversão de texto. `-X` ignora personalizações do psql; `ON_ERROR_STOP=1` encerra na primeira falha, fazendo a conexão descartar a transação pendente.

O teste também iniciou psql em WIN1252 e executou o reparo com seu `SET LOCAL ... UTF8`: a assinatura permaneceu canônica, comprovando a proteção dentro do próprio arquivo. Ainda assim, UTF8 explícito desde a inicialização é o procedimento previsto.

## Evidências dos testes

Runner: `scripts/festa-016-reparo-encoding.test.cjs`. Exige conexão de clone automatizado registrado, verifica o clone canônico em leitura e cria um clone novo separado. Nenhuma conexão ao banco real é aberta.

- A: aplicar sobre estrutura canônica mantém a assinatura — aprovado.
- B: corrupção reproduzida via psql/WIN1252; reparo retorna à assinatura canônica e postcheck oficial passa — aprovado.
- C: condição lógica `TG_OP='DELETE'` alterada artificialmente para `TG_OP='INSERT'`; guarda inicial recusa e não sobrescreve a diferença — aprovado.
- Falha final induzida: todas as substituições são descartadas automaticamente e o hash anterior permanece — aprovado.
- Definições finais das seis funções iguais integralmente às extraídas do clone — aprovado.
- Hashes de dados das 61 tabelas iguais antes/depois — aprovado.
- Migration016, rollback, algoritmo e assinatura esperada inalterados — aprovado.

Resultados, definições de origem e logs: `.local-festa/reparo-encoding-016/`. Os arquivos `somente-clone-*` dessa pasta são fixtures de teste; não devem ser executados no banco real. O único artefato de reparo operacional é o SQL em `database/repairs/`.
