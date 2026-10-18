# Aplicador de staging das migrations 085/086 do Marketing (18/10/2026)

**Estado:** preparado localmente; **nunca executado contra banco**. Executar exige:
- revisão independente;
- autorização específica da operação de staging, conforme `docs/OPERACAO_AGENTES.md`.

**Arquivos:**
- `scripts/migration-085-086-staging.cjs` (aplicador);
- `scripts/migration-085-086-staging.test.cjs` (testes com cliente simulado; CI);
- `lib/marketing/aplicador-085-086.postgres.test.ts` e `lib/marketing/composicao-convites-085-086.postgres.test.ts`: suítes PostgreSQL da OBS-2, para a rodada descartável autorizada; **NÃO EXECUTADAS** neste commit.

## Uso (no Web Shell do serviço de staging, depois das autorizações)

```
node scripts/migration-085-086-staging.cjs                                # PLANO: não lê DATABASE_URL, não conecta
node scripts/migration-085-086-staging.cjs --conferir-085-086              # só leitura: identidade, estado, privilégios, pre/postcheck
node scripts/migration-085-086-staging.cjs --aplicar-085-086-autorizado    # aplica 085 e 086 (primeira tentativa)
node scripts/migration-085-086-staging.cjs --retomar-085-086-autorizado    # só após revisão de tentativa não concluída
```

Os registros ficam no disco persistente: `/opt/render/project/src/data/atualizacao-staging-marketing-085-086/`.

## Padrão escolhido

O padrão é o dos aplicadores de staging **083/084** (`scripts/migration-083-staging.cjs`, `migration-084-staging.cjs`), não um de produção:

| Aspecto | Padrão |
|---|---|
| Trava de alvo | `alvo()` de `migration-078-staging.cjs` → `assinatura-staging-ensaio.cjs`: `RENDER=true`, `RENDER_SERVICE_ID=srv-daif418ae00c73e8k2gg`, `KIDMAIS_DEPLOY_ENV=staging`, `ASAAS_AMBIENTE=sandbox`, host `dpg-daidko3m8hqs73ce4jt0-a`, banco `/kidmais_staging_1z91`, porta 5432, sem `ssl*` na URL, `DATABASE_SSL` explícito; mais a recusa de qualquer query string na URL, como na 083/084 |
| Identidade da conexão efetiva | `conexao-staging.cjs` (`SQL_IDENTIDADE` + `conferirIdentidade`): banco exato, TLS conforme `DATABASE_SSL`, sem TLS só em servidor de rede privada. A trava não depende de substring do nome; o servidor precisa responder o banco e o TLS esperados |
| Disco persistente | `exigirDisco()`: o registro das tentativas fica em `/opt/render/project/src/data/...`, nunca no sistema de arquivos efêmero |
| SQL executado | só o revisado: sha256 do conteúdo LF fixado no aplicador; divergência = `ARQUIVO_DIVERGENTE` antes de conectar |
| Registro de aplicação | arquivo JSON por tentativa no disco persistente (`flag: 'wx'`), como 083/084; **sem tabela de controle nova** no banco. O projeto não tem tabela de migrations; o estado vem do próprio schema |

## Modos

| Modo | Como | Efeito |
|---|---|---|
| **plano (padrão)** | sem flag | confere os hashes locais e imprime fases, pré-condições e variáveis exigidas (só nomes). **Não lê `DATABASE_URL`, não abre conexão, não executa subprocesso nem grava arquivo** |
| conferência | `--conferir-085-086` (sozinha) | conecta, confere identidade, estado do schema e privilégios e roda o precheck ou postcheck aplicável, **só leitura** (os prechecks já trazem `BEGIN TRANSACTION READ ONLY … ROLLBACK`; postcheck dentro de `BEGIN TRANSACTION READ ONLY … COMMIT`); grava `conferencia-085-086-N.json` |
| aplicação | `--aplicar-085-086-autorizado` (sozinha) | executa as fases abaixo; exige que não haja tentativa anterior |
| retomada | `--retomar-085-086-autorizado` (sozinha) | só depois de revisão humana de tentativa anterior **não concluída**; nova tentativa numerada; o plano volta a ser derivado do schema |

Qualquer outra combinação de flags é recusada.

## Fases (execução)

1. **Antes de conectar:** trava de alvo, disco, hashes e registro de tentativa (`wx`).
2. **Conexão:** identidade; `pg_try_advisory_lock` de sessão (chave fixa do aplicador). Se outro aplicador já segura a trava: `EXECUCAO_CONCORRENTE`, sem SQL.
3. **Estado (`SQL_ESTADO`, leitura):**
   - 083 presente (mesmo critério do aplicador da 083) e 084 presente (mesmo critério do da 084);
   - estado de 085 e de 086 como **ausente / completa / parcial**, por contagem de tabelas e funções;
   - privilégios: `CREATE` em `public`, `REFERENCES` em `empresas`/`estabelecimentos`/`memberships`/`clientes`/`fechamentos`/`usuarios_administrativos` e `TRIGGER` em `clientes` (para a 086);
   - agregados de preservação (sem ids): estados de `convite_geracoes` e contagem de `whatsapp_conexoes`.
4. **Recusas antes de escrever:**
   - 083 ou 084 ausente: `PRE_REQUISITO_AUSENTE`;
   - estado parcial: `INSTALACAO_PARCIAL`;
   - 086 sem 085: `ESTADO_INCOERENTE`;
   - privilégio faltando: `SEM_PRIVILEGIO`.
5. **085 ausente:** `precheck 085` (todos os booleanos `true`, senão `PRECHECK_RECUSOU`) → `migration 085` (transação própria do arquivo) → releitura do estado (085 completa) → `postcheck 085` (leitura). **085 completa:** só `postcheck 085`.
6. **086:** mesma sequência (precheck 086 → migration 086 → releitura → postcheck 086), ou só o postcheck se já completa.
7. **Final:** os agregados de preservação devem ser iguais aos de antes (senão `INVARIANTE_ALTERADA`). Libera a trava e grava `concluido: true`.

**Transações:** cada migration é atômica (`BEGIN … COMMIT` no próprio arquivo). Se a 086 falhar depois da 085 ter feito COMMIT, **a 085 fica aplicada**; o aplicador registra a falha e **não** executa down. A retomada aplica só o que falta, pelo estado.

## Limites de tempo e trava (onde estão de fato)

- `lock_timeout = 5s` e `statement_timeout = 60s`: **`SET LOCAL` dentro das migrations e dos downs** (arquivos revisados).
- O aplicador não muda isso. Os prechecks e postchecks não definem timeout próprio.
- `connectionTimeoutMillis: 10000` (da trava de alvo) é **timeout de conexão do driver**, não de SQL.

## Concorrência

- **Mesmo disco:** o arquivo de tentativa `wx` impede duas tentativas iniciadas com o mesmo número.
- **Qualquer origem que use este aplicador:** a trava consultiva de sessão (`pg_try_advisory_lock`), liberada ao fim da sessão ou da conexão.
- **Não coberto:** alguém aplicando o SQL manualmente, fora do aplicador. Nesse caso, os blocos `DO` das migrations ("085 já aplicada (total ou parcialmente)") e os prechecks recusam o que já existe, mas duas transações simultâneas de DDL não são serializadas pelo aplicador.

## Recuperação (nenhum down automático)

| Cenário | Estado | Ação |
|---|---|---|
| Falha antes de conectar ou na identidade | nada escrito | corrigir a configuração; nova tentativa exige revisão (retomada) |
| Precheck 085 recusou | nada escrito | investigar o pré-requisito |
| Migration 085 falhou | a transação da 085 é desfeita pelo próprio PostgreSQL (sem COMMIT) | analisar o erro; retomada |
| Postcheck 085 falhou | 085 **commitada** | parar; não aplicar a 086; avaliar. O down 085 só **sem dados** (recusa com contatos/atribuições/versões/eventos), por decisão e autorização próprias |
| Migration 086 falhou | 085 commitada, 086 desfeita | retomada aplica só a 086 |
| Postcheck 086 falhou | 085 e 086 commitadas | parar; avaliar; down 086 e depois 085, só sem dados e com autorização |
| Processo interrompido | tentativa sem `concluido` | revisar o registro e o schema; retomada deriva o plano do estado (parcial = recusa) |
| Invariante alterada | migrations commitadas | parar; investigar; não há down automático |

Rollback operacional preferido: chaves do Marketing desligadas e código anterior. O schema aditivo pode ficar.

## Efeitos colaterais proibidos

Não liga flags (`MARKETING_*`), automações, transportes ou domínios. Não envia mensagens. Não lê `.env`.

**Logs:**
- só fase, resultado e mensagens truncadas a 160 caracteres;
- nunca a URL de conexão;
- agregados sem ids nem dados de clientes.

## Códigos de saída

| Código | Situação |
|---|---|
| 0 | PLANO, CONFERIDO ou PASS |
| 1 | recusa antes de conectar: flags, alvo, disco, hashes, tentativa anterior |
| 2 | FALHA durante conferência ou execução, registrada no arquivo da tentativa |
