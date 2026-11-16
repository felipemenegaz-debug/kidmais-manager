# Migration 124 (assinatura do cliente em papel) em STAGING — blocos do Web Shell

Somente o web de staging `srv-daif418ae00c73e8k2gg` (banco `kidmais_staging_1z91`), no Web Shell do Render, DEPOIS do deploy
de staging que traz `scripts/migration-124-staging.cjs`. Production fica pelo aplicador genérico, com autorização própria.

Pré-requisitos: a 061, a 122 e a 123 já aplicadas em staging (o precheck da 124 recusa sem elas) e o código da #425 LIVE
em staging. Sem a 124, o código segue o caminho anterior (o registro em papel fica indisponível).

Condição operacional: nenhum bloco deste roteiro roda antes de terminar a promoção para production em curso
(decisão de Felipe de 15/11/2026). Depois dela, cada bloco continua dependendo do sim de Felipe naquele momento.

Regras:
- um bloco por vez, colando a saída inteira no chat;
- qualquer `codigo=` diferente de 0, ou sha256 que não confere: PARAR (não repetir, não seguir);
- no bloco 1, as quatro linhas do sha256 precisam dizer `OK`; o CONFERIR só roda se os quatro conferirem (sem isso, `codigo=1`);
- o APLICAR só com o parecer do Astra e o sim de Felipe;
- nunca rodar o down (`database/rollback/`), nunca mudar env, nunca em production.

Saídas esperadas: `codigo=0` em todos os blocos; CONFERIR antes = `PRONTA_PARA_APLICAR`; APLICAR = `APLICADA_POSTCHECK_PASS` com
`"commitadas":["124"]`; CONFERIR depois = `JA_APLICADA_POSTCHECK_PASS`. Se o primeiro CONFERIR já disser
`JA_APLICADA_POSTCHECK_PASS`, a 124 já está aplicada: não rodar o APLICAR.

## Bloco 1 — CONFERIR (somente leitura)

```bash
cd /opt/render/project/src && echo "servico=$RENDER_SERVICE_ID ambiente=$KIDMAIS_DEPLOY_ENV commit=$RENDER_GIT_COMMIT" && sha256sum -c - <<'SHA' && node scripts/migration-124-staging.cjs --conferir-124; echo "codigo=$?"
6ceb61e017e4ee2722ddde8ea9354853f4e3d327fbd2b6f202a74799e6ec83fe  scripts/migration-124-staging.cjs
fef0ad012f252428150f11c7a3e947884086ed8842e6a694ec9392c9dd85962c  scripts/migration-generico-production.cjs
ce3b584fd02209e9141390dab6610746e7768c4dab593b431e66bcbe38e2b83a  scripts/conexao-staging.cjs
192aa80ed52fad017072d67d4bcbc3a73e96c875119e39c70c71b598ee4ca49a  scripts/migration-116-staging.cjs
SHA
```

O hash dos 3 SQL da 124 (precheck, migration, postcheck) é conferido pelo próprio aplicador (lista fechada do genérico).

## Bloco 2 — registro do backup (no painel do Render, não no Shell)

No painel do banco de staging (`dpg-daidko3m8hqs73ce4jt0-a`), em Recovery, conferir que a recuperação até um ponto no tempo
está disponível. O registro é o horário UTC de agora, imediatamente antes do APLICAR, no formato
`staging PITR 2026-11-16T22:10Z` (só letras, números, espaço e `: . _ / -`, de 6 a 120 caracteres). Colar o registro no
chat.

## Bloco 3 — APLICAR (uma vez; só com o parecer do Astra e o sim de Felipe)

Trocar `<REGISTRO>` pelo registro do bloco 2.

```bash
cd /opt/render/project/src && node scripts/migration-124-staging.cjs --aplicar-124-autorizado --backup "<REGISTRO>"; echo "codigo=$?"
```

O aplicador refaz a conferência só de leitura (identidade, estado, privilégios e precheck) antes de gravar o marcador
`/opt/render/project/src/data/assinatura-papel-124-staging/migration-124.json`. A migration roda numa transação só: precheck →
corpo → postcheck → COMMIT.

Em caso de `codigo=2` (FALHA), copiar a saída e o marcador; o campo `commits` diz `NAO_COMMITADA`, `CONFIRMADO`,
`DESFEITA_PELO_SERVIDOR` ou `INDETERMINADO`. Não repetir: a decisão é de Felipe.

```bash
cat /opt/render/project/src/data/assinatura-papel-124-staging/migration-124.json
```

## Bloco 4 — CONFERIR depois (somente leitura)

```bash
cd /opt/render/project/src && node scripts/migration-124-staging.cjs --conferir-124; echo "codigo=$?"
```

Esperado: `JA_APLICADA_POSTCHECK_PASS`, `codigo=0`.
