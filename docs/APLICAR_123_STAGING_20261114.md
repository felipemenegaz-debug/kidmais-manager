# Migration 123 (área da família) em STAGING — blocos do Web Shell

Somente o web de staging `srv-daif418ae00c73e8k2gg` (banco `kidmais_staging_1z91`), no Web Shell do Render, DEPOIS do deploy
de staging que traz `scripts/migration-123-staging.cjs`. Production fica para o passo 24 da promoção, com autorização própria.

Regras:
- um bloco por vez, colando a saída inteira no chat;
- qualquer `codigo=` diferente de 0, ou sha256 que não confere: PARAR (não repetir, não seguir);
- o APLICAR só com o parecer do Astra e o sim de Felipe;
- nunca rodar o down (`database/rollback/`), nunca mudar env, nunca em production.

Saídas esperadas: `codigo=0` em todos os blocos; CONFERIR antes = `PRONTA_PARA_APLICAR`; APLICAR = `APLICADA_POSTCHECK_PASS` com
`"commitadas":["123"]`; CONFERIR depois = `JA_APLICADA_POSTCHECK_PASS`. Se o primeiro CONFERIR já disser
`JA_APLICADA_POSTCHECK_PASS`, a 123 já está aplicada: não rodar o APLICAR.

## Bloco 1 — CONFERIR (somente leitura)

```bash
cd /opt/render/project/src && echo "servico=$RENDER_SERVICE_ID ambiente=$KIDMAIS_DEPLOY_ENV commit=$RENDER_GIT_COMMIT" && sha256sum -c - <<'SHA'
a8b9e9963940c82340fa04406cbb42820063f303e69d599ffaa43345db5b38d6  scripts/migration-123-staging.cjs
cdb1b9f4eaa044cb95081a1fc43611c7db9533784b0024fa291dc99269690bde  scripts/migration-generico-production.cjs
ce3b584fd02209e9141390dab6610746e7768c4dab593b431e66bcbe38e2b83a  scripts/conexao-staging.cjs
192aa80ed52fad017072d67d4bcbc3a73e96c875119e39c70c71b598ee4ca49a  scripts/migration-116-staging.cjs
SHA
node scripts/migration-123-staging.cjs --conferir-123; echo "codigo=$?"
```

O hash dos 3 SQL da 123 (precheck, migration, postcheck) é conferido pelo próprio aplicador (lista fechada do genérico).

## Bloco 2 — registro do backup (no painel do Render, não no Shell)

No painel do banco de staging (`dpg-daidko3m8hqs73ce4jt0-a`), em Recovery, conferir que a recuperação até um ponto no tempo
está disponível. O registro é o horário UTC de agora, imediatamente antes do APLICAR, no formato
`staging PITR 2026-11-14T22:10Z` (só letras, números, espaço e `: . _ / -`, de 6 a 120 caracteres). Colar o registro no
chat.

## Bloco 3 — APLICAR (uma vez; só com o parecer do Astra e o sim de Felipe)

Trocar `<REGISTRO>` pelo registro do bloco 2.

```bash
cd /opt/render/project/src && node scripts/migration-123-staging.cjs --aplicar-123-autorizado --backup "<REGISTRO>"; echo "codigo=$?"
```

O aplicador refaz a conferência só de leitura (identidade, estado, privilégios e precheck) antes de gravar o marcador
`/opt/render/project/src/data/area-familia-123-staging/migration-123.json`. A migration roda numa transação só: precheck →
corpo → postcheck → COMMIT.

Em caso de `codigo=2` (FALHA), copiar a saída e o marcador; o campo `commits` diz `NAO_COMMITADA`, `CONFIRMADO`,
`DESFEITA_PELO_SERVIDOR` ou `INDETERMINADO`. Não repetir: a decisão é de Felipe.

```bash
cat /opt/render/project/src/data/area-familia-123-staging/migration-123.json
```

## Bloco 4 — CONFERIR depois (somente leitura)

```bash
cd /opt/render/project/src && node scripts/migration-123-staging.cjs --conferir-123; echo "codigo=$?"
```

Esperado: `JA_APLICADA_POSTCHECK_PASS`, `codigo=0`.
