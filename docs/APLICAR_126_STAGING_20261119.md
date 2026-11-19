# Migration 126 (escopo MCP `clientes:read`) em STAGING — blocos do Web Shell

Somente o web de staging `srv-daif418ae00c73e8k2gg` (banco `kidmais_staging_1z91`), no Web Shell do Render, DEPOIS do deploy
de staging que traz `scripts/migration-126-staging.cjs`. Production fica pelo aplicador genérico, com autorização própria.

O que a 126 faz: troca o CHECK de escopos das 3 tabelas OAuth da 105 para aceitar de 1 a 4 escopos, incluindo
`clientes:read`. Não cria objeto, não mexe em linha existente. Os tokens e consentimentos atuais continuam valendo.

Pré-requisitos: a 105 já aplicada em staging (o precheck da 126 recusa sem ela) e o deploy de staging do commit com este
aplicador. Esse mesmo deploy publica o código da etapa 0b (#458). Entre o deploy e a 126, um pedido de autorização que
inclua `clientes:read` é recusado de forma controlada (`SchemaMcpAusente`); as conexões existentes continuam funcionando.
Por isso o bloco 1 vem logo depois do deploy.

Regras:
- um bloco por vez, colando a saída inteira no chat;
- cada bloco depende do sim de Felipe naquele momento;
- qualquer `codigo=` diferente de 0, ou sha256 que não confere: PARAR (não repetir, não seguir);
- no bloco 1, as quatro linhas do sha256 precisam dizer `OK`; o CONFERIR só roda se os quatro conferirem (sem isso, `codigo=1`);
- nunca rodar o down (`database/rollback/`), nunca mudar env, nunca em production.

Saídas esperadas: `codigo=0` em todos os blocos; CONFERIR antes = `PRONTA_PARA_APLICAR`; APLICAR = `APLICADA_POSTCHECK_PASS` com
`"commitadas":["126"]`; CONFERIR depois = `JA_APLICADA_POSTCHECK_PASS`. Se o primeiro CONFERIR já disser
`JA_APLICADA_POSTCHECK_PASS`, a 126 já está aplicada: não rodar o APLICAR.

## Bloco 1 — CONFERIR (somente leitura)

```bash
cd /opt/render/project/src && echo "servico=$RENDER_SERVICE_ID ambiente=$KIDMAIS_DEPLOY_ENV commit=$RENDER_GIT_COMMIT" && sha256sum -c - <<'SHA' && node scripts/migration-126-staging.cjs --conferir-126; echo "codigo=$?"
3005ac4db0c1590258248e9d6709970800285f9a97049374bff6c19223b02628  scripts/migration-126-staging.cjs
13b40d40f1fa77ee8c9d6f9d54706695797ed5fb37400d3699045decb84acbf6  scripts/migration-generico-production.cjs
ce3b584fd02209e9141390dab6610746e7768c4dab593b431e66bcbe38e2b83a  scripts/conexao-staging.cjs
192aa80ed52fad017072d67d4bcbc3a73e96c875119e39c70c71b598ee4ca49a  scripts/migration-116-staging.cjs
SHA
```

O hash dos 3 SQL da 126 (precheck, migration, postcheck) é conferido pelo próprio aplicador (lista fechada do genérico).

## Bloco 2 — registro do backup (no painel do Render, não no Shell)

No painel do banco de staging (`dpg-daidko3m8hqs73ce4jt0-a`), em Recovery, conferir que a recuperação até um ponto no tempo
está disponível. O registro é o horário UTC de agora, imediatamente antes do APLICAR, no formato
`staging PITR 2026-11-19T12:00Z` (só letras, números, espaço e `: . _ / -`, de 6 a 120 caracteres). Colar o registro no
chat.

## Bloco 3 — APLICAR (uma vez; só com o sim de Felipe)

Trocar `<REGISTRO>` pelo registro do bloco 2.

```bash
cd /opt/render/project/src && node scripts/migration-126-staging.cjs --aplicar-126-autorizado --backup "<REGISTRO>"; echo "codigo=$?"
```

O aplicador refaz a conferência só de leitura (identidade, estado, privilégios e precheck) antes de gravar o marcador
`/opt/render/project/src/data/mcp-escopo-clientes-126-staging/migration-126.json`. A migration roda numa transação só:
precheck → corpo → postcheck → COMMIT.

Em caso de `codigo=2` (FALHA), copiar a saída e o marcador; o campo `commits` diz `NAO_COMMITADA`, `CONFIRMADO`,
`DESFEITA_PELO_SERVIDOR` ou `INDETERMINADO`. Não repetir: a decisão é de Felipe.

```bash
cat /opt/render/project/src/data/mcp-escopo-clientes-126-staging/migration-126.json
```

## Bloco 4 — CONFERIR depois (somente leitura)

```bash
cd /opt/render/project/src && node scripts/migration-126-staging.cjs --conferir-126; echo "codigo=$?"
```

Esperado: `JA_APLICADA_POSTCHECK_PASS`, `codigo=0`. Depois disso, a homologação da etapa 0b em staging (conexão nova com
`clientes:read` e as 2 ferramentas) pode começar.
