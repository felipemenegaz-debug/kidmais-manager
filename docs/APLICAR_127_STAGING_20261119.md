# Migration 127 (guarda dos clientes, marca de saída por contato) em STAGING — blocos do Web Shell

Somente o web de staging `srv-daif418ae00c73e8k2gg` (banco `kidmais_staging_1z91`), no Web Shell do Render, DEPOIS do deploy
de staging que traz `scripts/migration-127-staging.cjs`. Production fica pelo aplicador genérico, com autorização própria.

O que a 127 faz: cria `marketing_saidas_contato` (quem saiu das campanhas, por telefone e por e-mail), a função do e-mail
canônico, os gatilhos que mantêm a marca (descadastro em `marketing_contato_preferencias`, troca de contato em `clientes`,
`nao_contatar` em `whatsapp_atendimento_conversas`) e faz a carga inicial a partir dos descadastros e das conversas com
`nao_contatar` de hoje. É aditiva: não apaga nem altera linha existente dessas tabelas.

Pré-requisitos: a 086 e a 060 já aplicadas em staging (o precheck recusa sem elas) e o deploy de staging do commit com este
aplicador. O código da fase 1 (#466) já está em staging e funciona sem a 127 (confere a tabela por `to_regclass`): até a 127,
as campanhas usam só o descadastro do cadastro e a tela do cliente mostra as datas-base sem a marca de saída.

Trava: durante o APLICAR, `clientes`, `marketing_contato_preferencias` e `whatsapp_atendimento_conversas` ficam em
SHARE ROW EXCLUSIVE (leitura liberada, escrita espera) pelo tempo da carga inicial, com `lock_timeout` de 5 s e
`statement_timeout` de 60 s. Rodar fora de horário de uso do painel de staging.

Regras:
- um bloco por vez, colando a saída inteira no chat;
- cada bloco depende do sim de Felipe naquele momento;
- qualquer `codigo=` diferente de 0, ou sha256 que não confere: PARAR (não repetir, não seguir);
- no bloco 1, as quatro linhas do sha256 precisam dizer `OK`; o CONFERIR só roda se os quatro conferirem (sem isso, `codigo=1`);
- nunca rodar o down (`database/rollback/`), nunca mudar env, nunca em production.

Saídas esperadas: `codigo=0` em todos os blocos; CONFERIR antes = `PRONTA_PARA_APLICAR`; APLICAR = `APLICADA_POSTCHECK_PASS` com
`"commitadas":["127"]`; CONFERIR depois = `JA_APLICADA_POSTCHECK_PASS`. Se o primeiro CONFERIR já disser
`JA_APLICADA_POSTCHECK_PASS`, a 127 já está aplicada: não rodar o APLICAR.

## Bloco 1 — CONFERIR (somente leitura)

```bash
cd /opt/render/project/src && echo "servico=$RENDER_SERVICE_ID ambiente=$KIDMAIS_DEPLOY_ENV commit=$RENDER_GIT_COMMIT" && sha256sum -c - <<'SHA' && node scripts/migration-127-staging.cjs --conferir-127; echo "codigo=$?"
664a15f1118e85db52fd0af67d9fb4850e10dacd28ed760e5fdfbf751997cf8f  scripts/migration-127-staging.cjs
ced6edfdd94dbd285351e23ee35be230ea4f9ab757aa8d8c2885e98030c3d670  scripts/migration-generico-production.cjs
ce3b584fd02209e9141390dab6610746e7768c4dab593b431e66bcbe38e2b83a  scripts/conexao-staging.cjs
192aa80ed52fad017072d67d4bcbc3a73e96c875119e39c70c71b598ee4ca49a  scripts/migration-116-staging.cjs
SHA
```

O hash dos 3 SQL da 127 (precheck, migration, postcheck) é conferido pelo próprio aplicador (lista fechada do genérico).

## Bloco 2 — registro do backup (no painel do Render, não no Shell)

No painel do banco de staging (`dpg-daidko3m8hqs73ce4jt0-a`), em Recovery, conferir que a recuperação até um ponto no tempo
está disponível. O registro é o horário UTC de agora, imediatamente antes do APLICAR, no formato
`staging PITR 2026-11-19T12:00Z` (só letras, números, espaço e `: . _ / -`, de 6 a 120 caracteres). Colar o registro no
chat.

## Bloco 3 — APLICAR (uma vez; só com o sim de Felipe)

Trocar `<REGISTRO>` pelo registro do bloco 2.

```bash
cd /opt/render/project/src && node scripts/migration-127-staging.cjs --aplicar-127-autorizado --backup "<REGISTRO>"; echo "codigo=$?"
```

O aplicador refaz a conferência só de leitura (identidade, estado, privilégios e precheck) antes de gravar o marcador
`/opt/render/project/src/data/guarda-saidas-contato-127-staging/migration-127.json`. A migration roda numa transação só:
precheck → corpo → postcheck → COMMIT.

Em caso de `codigo=2` (FALHA), copiar a saída e o marcador; o campo `commits` diz `NAO_COMMITADA`, `CONFIRMADO`,
`DESFEITA_PELO_SERVIDOR` ou `INDETERMINADO`. Não repetir: a decisão é de Felipe.

```bash
cat /opt/render/project/src/data/guarda-saidas-contato-127-staging/migration-127.json
```

## Bloco 4 — CONFERIR depois (somente leitura)

```bash
cd /opt/render/project/src && node scripts/migration-127-staging.cjs --conferir-127; echo "codigo=$?"
```

Esperado: `JA_APLICADA_POSTCHECK_PASS`, `codigo=0`. Depois disso, conferir no painel de staging: a tela de um cliente
descadastrado mostra a marca de saída, e uma campanha de teste (sem envio real) o deixa de fora.
