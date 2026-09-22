# Sanitização lógica V1 pós-019

## Estado e autoridade

Perfil aprovado: `V1_POST019_EMPTY_OPERATION`. B5B-2A: projeção física selada em
duas reconstruções PostgreSQL 18.6 independentes e descartáveis. A primeira
tentativa B5B-2B não concluiu sanitização nem emitiu PASS (`42501`); após o R1,
a repetição integrada A/B concluiu apply e verify no descartável, conforme as
evidências abaixo. O incidente histórico não foi contado como PASS.

As regras oficiais de [segurança](../04-SEGURANCA-E-AUDITORIA.md) e
[arquitetura](../02-ARQUITETURA-SAAS.md) continuam vigentes.
Este perfil é legado V1, não é implantação SaaS, não prova isolamento entre tenants
e não autoriza 1B-C. Destruir dados operacionais só é admissível no destino descartável
explicitamente autorizado; nunca é um procedimento de correção de contratos reais.

### Gate deliberado antes de qualquer conexão

`expected-schema.json` contém expectativa lógica derivada de fontes Git:
63 tabelas, 862 colunas, 39 funções finais e declarações de evolução.
Não é uma captura inventada de `pg_catalog`.
`physical_projection` contém a projeção revisada e o gate
`REVIEWED_DISPOSABLE_PROJECTION`. Qualquer alteração do selo, da receita ou de
seus 22 componentes volta a recusar a execução com `BASELINE_UNSEALED`.

A migration 015 gera objetos via SQL dinâmico; a 019 registra metadados de NOT NULL
em comentário. A B5B-2A reconstruiu a cadeia completa duas vezes, sem dump, usando
os 20 blobs Git normalizados e verificados. O SHA-256 físico selado é
`3b1066bc2bd546d589347561356490aaa19158026f31ea8893fd6c0db32d596e`.
Nunca copiar fingerprint do alvo de sanitização e tratá-lo como autoridade.

## Fontes e reprodução

Commit canônico: `0460d0a10ed0ba1afbd2061055762cf3913bda0b`.
O manifesto contém paths e SHA-256 UTF-8/LF das 20 fontes explícitas:
001–019, incluindo 006a. O arquivo 999 de rollback é excluído.
Os blobs UTF-8/LF estão incorporados em sources[].sql do manifesto, com hashes
individuais e digest da cadeia fixado no código. As declarações apontam para
índices de statements, sem duplicar seus textos. São snapshots de evidência,
não novas migrations nem scripts a executar. Isso torna a suíte autocontida em
clones rasos sem origin/staging. Os testes comparam a derivação integral com os
JSONs e também os arquivos históricos presentes no checkout. Não executam SQL.

006 + 006a são tratadas como unidade legada composta; o aviso DRAFT de 006 é
preservado como histórico, sem reinterpretá-lo como autorização de execução.
019: `121265ed0e5c89882abf27a7178f206d26f0e1dea15a773bc413fdaf68ed4d90`.
Canônica por equivalência física estabelecida na B3; identidade byte a byte do
artefato historicamente executado não foi comprovada. Nenhuma errata histórica
ou migration é alterada aqui.

O scanner estático é deliberadamente restrito às fontes fixadas, não um parser SQL geral.
`deriveSchema` conserva declarações históricas, incluindo substituições/DO;
isso não significa que todas as declarações coexistam no schema final.
`deriveCatalog` extrai literais/VALUES/projeções e aplica as relações explícitas
dos seeds 005 → 006 → 006a → 017. Regras CASE são interpretadas por código
específico, exigindo revisão e comparação nativa independente na B5B-2.

Catálogo esperado: 305 linhas, distribuídas 2/7/31/1/69/66/14/99/16 conforme
as respectivas tabelas. A validação compara todos os atributos comerciais e
textos, não só contagens. Referências UUID são resolvidas em códigos de negócio.
Somente `id`, `criado_em` e `atualizado_em` são excluídos da comparação entre
instalações; sua preservação no próprio alvo é verificada por fingerprint
antes/depois. Nenhum hash de linhas operacionais é produzido ou atestado.

## Política exata — 63 / 9 / 54

`policy.json` é a partição executável. Seu digest aprovado impede trocas de
política mesmo preservando as contagens 63/9/54. Inventário e catálogo devem
concordar com ela. Qualquer tabela/coluna inesperada é recusa, nunca exclusão silenciosa.

| Nº | Tabela | Política |
| --- | --- | --- |
| 1 | `adicionais` | PRESERVE_CANONICAL |
| 2 | `aniversariantes` | EMPTY |
| 3 | `aprovacoes_negociacao` | EMPTY |
| 4 | `auditoria` | EMPTY |
| 5 | `bloqueios_agenda` | EMPTY |
| 6 | `clientes` | EMPTY |
| 7 | `configuracao_agenda` | PRESERVE_CANONICAL |
| 8 | `contrato_assinaturas` | EMPTY |
| 9 | `contrato_documentos` | EMPTY |
| 10 | `contrato_edicoes` | EMPTY |
| 11 | `contrato_fluxos` | EMPTY |
| 12 | `contrato_pendencias_financeiras` | EMPTY |
| 13 | `contrato_versoes` | EMPTY |
| 14 | `contratos` | EMPTY |
| 15 | `eventos_historico_cliente` | EMPTY |
| 16 | `fechamento_adicionais` | EMPTY |
| 17 | `fechamento_revisao_adicionais` | EMPTY |
| 18 | `fechamento_revisoes` | EMPTY |
| 19 | `fechamentos` | EMPTY |
| 20 | `festa_areas` | EMPTY |
| 21 | `festa_buffet` | EMPTY |
| 22 | `festa_contagens_convidados` | EMPTY |
| 23 | `festa_eventos` | EMPTY |
| 24 | `festa_pendencias` | EMPTY |
| 25 | `festa_solicitacoes` | EMPTY |
| 26 | `festa_tarefas` | EMPTY |
| 27 | `festa_usuario_capacidades` | EMPTY |
| 28 | `festas` | EMPTY |
| 29 | `limites_autenticacao` | EMPTY |
| 30 | `mesclagens_clientes` | EMPTY |
| 31 | `pacotes` | PRESERVE_CANONICAL |
| 32 | `pagamento_ajuste_bases` | EMPTY |
| 33 | `pagamento_ajustes_contratuais` | EMPTY |
| 34 | `pagamento_comprovantes` | EMPTY |
| 35 | `pagamento_credito_reservas` | EMPTY |
| 36 | `pagamento_cronograma_itens` | EMPTY |
| 37 | `pagamento_cronogramas` | EMPTY |
| 38 | `pagamento_devolucao_alocacoes` | EMPTY |
| 39 | `pagamento_devolucao_comprovantes` | EMPTY |
| 40 | `pagamento_devolucoes` | EMPTY |
| 41 | `pagamento_estornos` | EMPTY |
| 42 | `pagamento_eventos` | EMPTY |
| 43 | `pagamento_gestoes` | EMPTY |
| 44 | `pagamento_movimentos_contextos` | EMPTY |
| 45 | `pagamento_parcelas` | EMPTY |
| 46 | `pagamento_planos` | EMPTY |
| 47 | `pagamento_recebimento_alocacoes` | EMPTY |
| 48 | `pagamento_recebimentos` | EMPTY |
| 49 | `pagamento_tratamentos` | EMPTY |
| 50 | `pagamentos` | EMPTY |
| 51 | `possiveis_duplicidades_cliente` | EMPTY |
| 52 | `precos_adicional` | PRESERVE_CANONICAL |
| 53 | `precos_pacote` | PRESERVE_CANONICAL |
| 54 | `regras_categoria_horario` | PRESERVE_CANONICAL |
| 55 | `regras_desconto_pacote` | PRESERVE_CANONICAL |
| 56 | `regras_disponibilidade_pacote` | PRESERVE_CANONICAL |
| 57 | `responsaveis_adicionais` | EMPTY |
| 58 | `sessoes_administrativas` | EMPTY |
| 59 | `tabelas_preco` | PRESERVE_CANONICAL |
| 60 | `usuarios_administrativos` | EMPTY |
| 61 | `validacoes_identidade_cliente` | EMPTY |
| 62 | `whatsapp_conexoes` | EMPTY |
| 63 | `whatsapp_onboarding_tentativas` | EMPTY |

## Tratamento sensível

Todas as colunas das 54 tabelas EMPTY são eliminadas logicamente junto com suas
linhas. Isso inclui nomes, CPF/RG, contatos, endereços, datas pessoais, identificadores
operacionais, usuários, hashes de senha, sessões/CSRF, OTP/provas, contratos,
PDFs/comprovantes bytea, snapshots/assinaturas, históricos/auditoria, IP/user-agent,
pagamentos/festas, JSON/JSONB, campos livres, OAuth/WhatsApp e credenciais cifradas.
Não se tenta mascarar somente chaves conhecidas de JSON, preservar tokens expirados,
anonimizar hashes de baixa entropia ou conservar PDFs sem inspeção.
As duas tabelas WhatsApp ficam vazias, inclusive ciphertext, IV, tag e state.

Dados técnicos/comerciais das nove tabelas preservadas devem corresponder às
fontes canônicas. Texto livre adicional, preço editado, vigência divergente,
chave extra ou ausência de linha causam recusa. Nenhum usuário de acesso permanece.
Carregar fixtures depois invalida o atestado do perfil de operação vazia.

## Destino, processo e credenciais

Allowlist exata: host `127.0.0.1`, porta `55429`,
database `kidmais_sanitize_v1_post019_b5b`, usuário `kidmais_b5b_sanitizer`.
`kidmais_manager` e `kidmais_v1_homologacao` são absolutamente recusados
em todos os modos. O segundo é clone-evidência e não pode ser reutilizado.
Não aceitar localhost/IPv6/DNS, URI/conninfo em argumentos, serviços ou fallback.

Executável fixo: `C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe`.
Processo com `shell:false`, janela oculta, `-X`, `-w`,
`ON_ERROR_STOP=0` no protocolo interativo: cada instrução isolada produz
quadro `ERROR`/`SQLSTATE`; após erro, somente `ROLLBACK` é aceito. Timeout de
conexão/statement/lock/idle. O bootstrap mantém `ON_ERROR_STOP=1`.
O ambiente filho é construído somente com SystemRoot/APPDATA e opções PG
definidas pelo utilitário; não copia o ambiente inteiro.
O reprodutor da referência usa `trust` local temporário, restrito no HBA ao banco
e às três roles exatas; o PGDATA é apagado ao final. Já o uso futuro do sanitizador
fora desse bootstrap deve autenticar exclusivamente pelo pgpass nativo do libpq.
O script não lê arquivos de senha, .env, .env.local, DATABASE_URL ou PGPASSWORD,
nem aceita senha via CLI. APPDATA serve apenas à descoberta nativa do pgpass.

Stdout do servidor é protocolo interno, nunca log bruto; stderr é drenado e
descartado. Erros públicos são códigos de allowlist. Não há HTTP, provedor
WhatsApp, Render, importação do runtime ou provisionamento de banco.

## Modos e autorização

As coordenadas devem ser passadas explicitamente, inclusive no modo padrão.
`--dry-run` é padrão; `--verify` e `--apply` são mutuamente exclusivos.

Forma permitida para dry-run após a selagem B5B-2A:

```text
node scripts/sanitize-v1-post-019.cjs --host 127.0.0.1 --port 55429 --user kidmais_b5b_sanitizer --database kidmais_sanitize_v1_post019_b5b --dry-run
```

Dry-run usa transação READ ONLY, ROLLBACK e retorna PLAN/digest, nunca PASS.
Verify não escreve e só emite PASS para estado já vazio/canônico; não alega
que o próprio verify executou sanitização.

Apply exige adicionalmente `--apply`,
`--authorize-target 127.0.0.1:55429/kidmais_sanitize_v1_post019_b5b` e
`--plan-digest <digest-exato-do-dry-run>`.
O digest vincula destino, perfil, fontes/manifests, catálogo físico canônico,
contagens, lista destrutiva e locks. Alteração sob locks o invalida.
Consentimento CLI não substitui autorização humana desta sequência de fases.

## PRECHECK → SANITIZATION → POSTCHECK → ATTESTATION

1. Validar CLI, destino, partição/manifests e selo físico antes de qualquer spawn.
2. Abrir sessão com `default_transaction_read_only=on`; iniciar
   `REPEATABLE READ READ ONLY`. Validar banco, IP, porta, usuário, UTF8, PG18,
   default read-only e transaction read-only. Divergência: rollback/encerrar.
3. Comparar inventário exato e projeção estrutural antes de ler conteúdo de catálogo.
   A projeção inclui funções/corpos/propriedades, constraints, índices, triggers,
   comentários, schemas, tipos, owners/ACL/default privileges, extensões e sequences,
   replica identity, missing values de colunas e propriedades do database atual.
   Recusar tabelas externas, views/materializadas, partições/herança/RLS, triggers
   de TRUNCATE/desabilitados, constraints/índices inválidos, colunas descartadas,
   large objects, servidores estrangeiros, publicação/subscription e FKs externas
   apontando para qualquer EMPTY. Erro de privilégio também é recusa.
4. Validar catálogo completo, gerar plano, ROLLBACK. Dry-run/verify encerram aqui.
5. Apply: validar digest; iniciar READ COMMITTED READ WRITE na mesma sessão.
   O default permanece on; somente esta transação passa para escrita após preflight.
   Adquirir advisory lock, ACCESS EXCLUSIVE nas 54 EMPTY e ACCESS SHARE nas nove
   PRESERVE_CANONICAL, em ordem fixa e somente em instância exclusiva.
   Repetir identidade, schema, catálogo e plano sob locks.
6. Executar um único TRUNCATE explícito das 54 tabelas, CONTINUE IDENTITY RESTRICT.
   Sem ampliação automática, sem desabilitar triggers/constraints ou alterar schema.
   Toda a malha FK operacional participa da mesma instrução.
7. Forçar constraints diferidas; repetir checks, catálogo/fingerprint antes-depois,
   contagens zero e estado das duas sequences inalterado sob locks.
   Sem chamar rotinas de negócio ou criar Festa/assinaturas artificiais.
8. COMMIT só depois de POSTCHECK aprovado; confirmar tag COMMIT.
   Qualquer falha anterior tenta ROLLBACK; somente a tag recebida confirma
   `ROLLED_BACK`. Falta de confirmação é `TRANSACTION_OUTCOME_UNKNOWN`.
   Desconexão após envio de COMMIT é COMMIT_UNKNOWN; nunca repetir automaticamente.
9. Gerar atestado fechado. Falha de saída depois do commit confirmado:
   COMMIT_CONFIRMED_ATTESTATION_FAILED. Se commit já era incerto, preservar
   COMMIT_UNKNOWN mesmo que a publicação falhe.

TRUNCATE não dispara triggers de DELETE por linha; isso é excepcionalmente
intencional no reset descartável e não equivale a uma mutação comercial legítima.
Nenhuma linha de contrato/assinatura/festa permanece. Invariantes 019 tornam-se
vacuamente satisfeitas no estado vazio, mas a integridade física dos mecanismos
deve permanecer; isso foi exercitado com cenários válidos na repetição B5B-2B.

**Pré-condição operacional adicional:** instância isolada e exclusiva, aplicação/
workers desligados, nenhuma sessão concorrente ou DDL administrativo. Locks de
tabela/advisory não impedem outro superuser de alterar funções/grants. Não alegar
isolamento de DDL completo apenas por esses locks.

## Critérios objetivos de PASS

- Gate físico previamente revisado em fonte independente e alvo allowlisted.
- Exatamente 63 tabelas/862 colunas da expectativa lógica e projeção física aprovada;
  nenhum objeto residual/perigoso, drift de schema/owner/grant ou dependência desconhecida.
- Nove catálogos completos iguais à projeção canônica; identidade técnica preservada.
- Todas as 54 EMPTY com contagem zero, incluindo binários/JSON/credenciais.
- Constraints válidas, índices válidos/prontos, triggers habilitados e duas
  sequences preservadas, mesmo quando avançadas.
- Apply: COMMIT confirmado. Verify: ROLLBACK confirmado; nenhuma alegação de escrita.
- Atestado validado estrutural e semanticamente. Dry-run nunca é PASS.
- Aplicabilidade SQL e equivalência física comprovadas na B5B-2, não por mocks.

## Atestado seguro e versionável

Schema: [V1-POST-019-SANITIZATION.schema.json](./V1-POST-019-SANITIZATION.schema.json).
Geração/validação: `attestation.cjs`, com propriedades fechadas recursivamente e
máquina de estados adicional ao JSON Schema.
Campos: versão/perfil/modo/resultado, commit-fonte, hashes dos artefatos canônicos,
destino fixo, timestamps UTC, confirmações de commit/rollback, resultado
transacional explícito, digest do plano,
código de erro fechado quando houver, 63 contagens finais somente no PASS,
zero linhas operacionais e limitações explícitas.
Não aceitar campos extras, mensagens arbitrárias, IDs operacionais, emails,
telefones, CPF, tokens, credenciais ou hashes de PII.

Resultados: PLAN, PASS, FAIL, COMMIT_UNKNOWN,
COMMIT_CONFIRMED_ATTESTATION_FAILED.
A saída JSON é entregue a um writer (stdout pela CLI). A repetição B5B-2B
emitiu atestado PASS após verify independente, mas não o persistiu no Git.
O utilitário não cria automaticamente um
arquivo PASS nem sobrescreve atestados. Se stdout falhar, usar o estado seguro
independente, nunca anunciar certificação persistida.
Checksums detectam diferenças, não são assinatura digital nem provam quem executou.
A validade é pontual: qualquer nova escrita exige nova verificação.

## Fixture e harness integrado

`fixture.cjs` conserva metadados determinísticos e o SHA-256 UTF-8/LF do arquivo
`fixture.sql`. O SQL versionado foi aceito integralmente pelas constraints e
triggers pós-019 em reconstrução descartável limpa. Ele contém somente valores
sintéticos e cobre CRM, aniversariante/responsável, usuário/sessão, OTP consumido,
fechamento, contrato/versão/snapshot, duas assinaturas, três documentos binários,
Festa formalizada, eventos/histórico/auditoria, pagamento/comprovante e WhatsApp
com ciphertext artificial. Nenhuma constraint ou trigger é desabilitada.

`sanitize-v1-post-019.integration.ps1` deriva um executor temporário da receita
selada, carrega a fixture como papel de construção e executa o CLI como
`kidmais_b5b_sanitizer`. O executor temporário e o PGDATA são removidos em
`finally`. O CJS de integração continua recusando execução direta; a entrada
operacional autorizada é o PowerShell com alvo fixo.

## B5B-2A — referência física selada

As construções finais A e B usaram PGDATA distintos e produziram system identifiers
`7688421646760666436` e `7688421719144704788`. Após excluir somente esse identificador
efêmero, todas as evidências coincidiram: 63 tabelas, 862 colunas, catálogo integral
de 305 linhas, 1.261 constraints, 288 índices, 828 triggers, 107 funções, duas
sequences, três extensões, ACLs, owners, default privileges, roles e memberships.
Cada uma das 20 migrations passou; 006+006a permaneceram `legacy-composite`.

Triggers internos são identificados semanticamente por tabela/schema, constraint,
`tgtype`, função/assinatura, estado enabled e propriedades de deferimento, nunca pelo
nome interno derivado de OID. ACLs são projetadas como grantor/grantee/privilégio/
grant option; ordem textual de arrays ACL não participa da identidade.

A receita versionada é `reference-bootstrap.json`, SHA-256 UTF-8/LF
`443ea6b6950d59a7546ea11b264847338c4369abd7a87a341c97696f12a6064b`.
O executor reproduzível é `scripts/sanitize-v1-post-019.reference.ps1`; aceita
somente `-Build A` ou `-Build B`; para certificação após o selo, `-Mode Verify` é
obrigatório. `-Mode Derive` permanece um modo não certificante, reservado a uma
nova derivação deliberada. Ele cria o alvo literal e aplica um arquivo por processo.
As execuções A/B concluídas encerraram e removeram o PGDATA; uma interrupção anormal
durante `pg_ctl stop` exige confirmação manual da limpeza. Seu SHA-256 UTF-8/LF é
`31646a289dc1ebf3db13d4a620e3dabfb8e470ea79447f162e65dbe45f9baaf3`.
O owner de construção termina `NOLOGIN`; a role sanitizadora tem limite de uma
conexão, nenhum atributo elevado ou membership, CONNECT sem TEMP somente no banco
exato, USAGE sem CREATE no schema, SELECT nas 63, TRUNCATE nas 54 EMPTY e somente
SELECT — sem USAGE/UPDATE — nas duas sequences.

## B5B-2B — falha histórica e resolução R1

Gate 0, fingerprint físico, catálogo e fixture passaram. O dry-run passou após
fixar `search_path=pg_catalog,public`: `pg_catalog` permanece primeiro contra
shadowing, enquanto `public` torna as definições `pg_get_*` compatíveis com a
canonicalização selada. O plano continuou sendo exatamente 54 EMPTY e nove
PRESERVE_CANONICAL.

O apply falhou antes de commit, na etapa `TRUNCATE`, com SQLSTATE `42501`.
`TRUNCATE ... RESTART IDENTITY` exige poder para reiniciar as duas sequences;
o papel selado possui somente SELECT nelas e não é owner. O sanitizador tentou
ROLLBACK, mas o encerramento do `psql` por `ON_ERROR_STOP` impediu confirmação
protocolar; a transação não chegou a COMMIT e o cluster inteiro foi descartado.
Nenhum PASS foi publicado. Isso confirma uma incompatibilidade entre o plano
destrutivo aprovado e o modelo de privilégios da referência B5B-2A.

R1 adotou `CONTINUE IDENTITY RESTRICT`: o perfil certifica operação vazia, não
numeração reiniciada. As duas sequences `IDENTITY` pertencem a
`kidmais_b5b_owner`, com dependência interna (`i`) de
`festa_contagens_convidados.sequencia` e `festa_eventos.sequencia`. Ambas
começam em 1, incrementam 1, têm cache 1, mínimo 1, máximo 2^63−1 e não
ciclam. Após as migrations: `last_value=1,is_called=false`; após a fixture
sintética: `last_value=1,is_called=true`. O estado anterior ao reset é
preservado e verificado, mesmo se avançado. Isso não promete ocultar indícios
agregados de atividade pela numeração; se tal propriedade for necessária,
exigirá nova decisão e revisão de privilégios. Nenhum USAGE/UPDATE/ownership
foi concedido ao sanitizador.

O protocolo interativo agora mantém o `psql` ativo após erro SQL, lê o
SQLSTATE do quadro de resposta e exige ROLLBACK confirmado. Falha de
comunicação é `TRANSACTION_OUTCOME_UNKNOWN`; COMMIT sem confirmação é
`COMMIT_OUTCOME_UNKNOWN`, sem retry destrutivo. Stderr é descartado, não
publicado. A falha intermitente de startup veio do sandbox Windows
(`pg_ctl: could not create restricted token`, código 87), sem listener nem
`server.log`; fora dessa restrição, o mesmo executor iniciou. Não há retry
nem fallback de porta ou banco.

A/B foram reconstruídas independentemente com Gate 0, 001–019, 63 tabelas,
862 colunas, 1261 constraints, 288 índices, 828 triggers, 107 funções,
duas sequences, catálogo e ACL idênticos. O fingerprint físico permanece
`3b1066bc2bd546d589347561356490aaa19158026f31ea8893fd6c0db32d596e`;
o digest dos 22 componentes permanece
`3b602275f000caeed8f12dcefc2bbfff59ca2dc806b168806776068322cba757`.
Mudaram apenas os selos da receita e executor acima.

Em referências descartáveis novas, uma fixture mínima inseriu uma linha
técnica sintética e avançou as duas sequences. Dry-run → TRUNCATE → postcheck
→ ROLLBACK preservou linha e sequences; dry-run → TRUNCATE → postcheck →
COMMIT → verify removeu a linha e preservou as sequences. Um erro SQL `22012`
induzido antes do TRUNCATE teve ROLLBACK protocolar confirmado. Isso não
substituía a bateria B5B-2B; a repetição integrada está documentada abaixo.
Não iniciar 1B-C automaticamente.

Limites adicionais da fixture atual: timestamps fixos em 2030 exigem revisão para
valores relativos a `transaction_timestamp()` antes de uso durável; os inserts
comprovam a validade do grafo final, não todas as transições de estado. A fixture
expandida cobre as 12 tabelas da 015, incluindo tratamento, ajuste, crédito e
devolução, mas não todos os estados e caminhos possíveis de cada fluxo.

## B5B-2B — repetição integrada após R1

**Resultado final: SANITIZADOR PÓS-019 VALIDADO — B5B CONCLUÍDA**, somente
para a referência descartável e o perfil lógico declarado.

Em 2026-09-22, A e B foram reconstruídas do zero exclusivamente no banco local
descartável `127.0.0.1:55429/kidmais_sanitize_v1_post019_b5b`, por Gate 0 e
001–019. Ambas confirmaram o mesmo fingerprint físico e digest de componentes
acima, 63 tabelas e nove catálogos. A fixture versionada é exclusivamente
sintética e cobre CRM, contratos/documentos, festa, autenticação/OTP, WhatsApp
artificial, pagamentos e as 12 tabelas da malha 015, todas com contagem positiva
antes da sanitização. O dry-run preservou 63
contagens, catálogo, fingerprint e duas sequences; retornou somente PLAN.

Os dois apply executaram um único `TRUNCATE ... CONTINUE IDENTITY RESTRICT`
pela role mínima, com COMMIT confirmado. Os dois verify foram sessões novas,
READ ONLY, e retornaram PASS com 54 EMPTY sem linhas e nove catálogos intactos.
As duas sequences mantiveram `last_value=1,is_called=true` antes e depois do
apply; as identities não foram reiniciadas. O atestado de apply foi exposto
somente depois do verify. O verify não afirma preservação temporal das sequences
no seu próprio atestado; essa afirmação pertence ao apply, que comparou os
snapshots sob locks. Os digests dos planos A/B diferem por IDs técnicos gerados
independentemente, mas cada digest correspondeu ao seu próprio dry-run/apply;
os estados lógicos finais e os selos físicos coincidiram. Na repetição com a
fixture ampliada, os digests dos planos foram
`6547cc40bab75fee3993b269844eaed2396d231cff1d65dc0e6e2653a3415193`
(A) e `8b9790d2ddc985a12e531899bb638f9c1ceff360de44ba7a5ee63b95c647c37e`
(B); ambos produziram apply PASS e verify independente PASS.

Reconstruções adicionais independentes provaram rollback confirmado para
falhas antes do TRUNCATE, após locks, após TRUNCATE, postcheck inválido, erro
SQL `22012`, timeout `57014` e concorrência real (`lock_timeout`, `55P03`).
Falha simulada de publicação após COMMIT retornou
`COMMIT_CONFIRMED_ATTESTATION_FAILED`, seguida de verify PASS. Negativos físicos
de tabela/coluna inesperada, catálogo adulterado, FK nova, fingerprint alterado
e sequence alterada entre dry-run/apply falharam fechados, sem COMMIT. Guards
de host, banco, autorização, digest e proibição de `RESTART IDENTITY` também
são cobertos por testes unitários sem conexão aos destinos proibidos.

O atestado seguro foi ampliado com fingerprint, digest dos componentes, hashes
da receita/executor R1, 63/54/9 e os flags
`sequences_preserved=true`/`identities_restarted=false` no apply PASS. O perfil
certificado continua somente `V1_POST019_EMPTY_OPERATION`: não equivale a
apagamento físico, reset de sequences nem certificação multi-tenant.

## Limites, recuperação e riscos

Sanitização **lógica**, não secure erasure: páginas físicas, WAL, backups, dumps,
logs externos, anexos fora do banco e mídias não são apagados por este utilitário.
Não exportar o diretório físico do cluster como se fosse sanitizado.
Antes de COMMIT, falha exige ROLLBACK; depois, recuperar apenas reconstruindo o
descartável de fontes limpas. Nunca reimportar dados do clone para “recuperar”.
Commit incerto requer investigação read-only posterior, nunca retry destrutivo.

O fingerprint é sensível à versão exata do PG, extensions, owners/ACLs,
roles/memberships/settings, nomes/defaults de argumentos de funções e owners de tipos.
Toda divergência é bloqueio, não autorreparo.
RLS/multi-tenant e compatibilidade funcional dos runtimes entre branches não são
certificados por operação vazia. Não há login/OTP utilizável após a sanitização.

## Validação local

Executar somente `node --test scripts/sanitize-v1-post-019.test.cjs`,
`node --check` nos CJS e `git diff --check`.
A suíte intercepta toda criação de subprocessos, usa sessões simuladas,
verifica zero tentativas e lê os snapshots SQL locais sem precisar executar Git.
Os testes offline continuam sem criar subprocessos. A aplicabilidade das migrations
e da projeção read-only foi comprovada nas duas referências descartáveis. A
primeira tentativa B5B-2B terminou em `42501` e não foi usada como PASS. A
repetição pós-R1 produziu atestado runtime PASS validado pelo schema versionado,
mas não adicionou um atestado de execução ao Git. Todas as referências
descartáveis foram encerradas após cada cenário.

Nenhuma instalação de dependências é exigida: apenas módulos built-in do Node.
Lint ESLint/typecheck de aplicação não substituem os testes; se node_modules não
estiver disponível, registrar a limitação sem instalar ou executar build que
possa ler configuração de ambiente.
