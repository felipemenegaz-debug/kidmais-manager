# Migration 128 (dados fora do disco) e cópia do disco em STAGING — blocos do Web Shell

Somente o web de staging `srv-daif418ae00c73e8k2gg` (banco `kidmais_staging_1z91`), no Web Shell do Render, DEPOIS do deploy
de staging que traz `scripts/migration-128-staging.cjs`, `scripts/disco-para-banco-128.cjs` e o código que lê do banco.
Production fica pelo aplicador genérico (passo 30 da cadeia) e pela mesma cópia, com autorização própria.
Plano: vault "Convites geracao sobrevive ao deploy 20261120" (fases 3 e 4).

O que a 128 faz: cria `disponibilidade_config_legada` (uma linha com as regras e descontos legados da agenda pública,
antes em `data/disponibilidade.json`) e a coluna opcional `documentos_publicos.conteudo` (bytes do PDF da tabela de
pacotes, conferidos pelo banco contra `tamanho_bytes` e `sha256`). É aditiva: não apaga nem altera linha existente.

Ordem segura (o código tolera qualquer etapa faltando: sem a 128 ou sem a cópia, continua lendo o disco):
1. deploy do código (já feito quando este roteiro estiver no web);
2. blocos 1 a 4: a 128;
3. blocos 5 a 7: a cópia do disco para o banco, só com o deploy deste código LIVE (a instância antiga gravaria no arquivo);
4. só então a remoção do disco (Felipe, no painel), com `NEXT_MANUAL_SIG_HANDLE` e a carência de 150 s (fase 3).

Trava: durante o APLICAR, `documentos_publicos` fica em ACCESS EXCLUSIVE por instantes (ADD COLUMN sem valor padrão e
ADD CONSTRAINT numa tabela de poucas linhas), com `lock_timeout` de 5 s e `statement_timeout` de 60 s.

Regras:
- um bloco por vez, colando a saída inteira no chat;
- cada bloco depende do sim de Felipe naquele momento;
- qualquer `codigo=` diferente de 0, ou sha256 que não confere: PARAR (não repetir, não seguir);
- nos blocos 1 e 5, as quatro linhas do sha256 precisam dizer `OK`; sem isso o resto do bloco não roda (`codigo=1`);
- nunca rodar o down (`database/rollback/`), nunca mudar env, nunca apagar arquivo do disco, nunca em production.

## Bloco 1 — CONFERIR a 128 (somente leitura)

```bash
cd /opt/render/project/src && echo "servico=$RENDER_SERVICE_ID ambiente=$KIDMAIS_DEPLOY_ENV commit=$RENDER_GIT_COMMIT" && sha256sum -c - <<'SHA' && node scripts/migration-128-staging.cjs --conferir-128; echo "codigo=$?"
c77cc13875346cf3022bbe8b28bd07fa42656a55839b766cc9418b19982242e7  scripts/migration-128-staging.cjs
5a032b4a476fc04acfe05293fe5a22e531f84aa72681754b4ff6564fc1ab95cd  scripts/migration-generico-production.cjs
ce3b584fd02209e9141390dab6610746e7768c4dab593b431e66bcbe38e2b83a  scripts/conexao-staging.cjs
192aa80ed52fad017072d67d4bcbc3a73e96c875119e39c70c71b598ee4ca49a  scripts/migration-116-staging.cjs
SHA
```

Esperado: `PRONTA_PARA_APLICAR`. Se já disser `JA_APLICADA_POSTCHECK_PASS`, pular para o bloco 5. O hash dos 3 SQL da 128 é
conferido pelo próprio aplicador (lista fechada do genérico).

## Bloco 2 — registro do backup (no painel do Render, não no Shell)

No painel do banco de staging (`dpg-daidko3m8hqs73ce4jt0-a`), em Recovery, conferir que a recuperação até um ponto no tempo
está disponível. O registro é o horário UTC de agora, no formato `staging PITR 2026-11-20T12:00Z` (só letras, números,
espaço e `: . _ / -`, de 6 a 120 caracteres). Colar o registro no chat.

## Bloco 3 — APLICAR a 128 (uma vez; só com o sim de Felipe)

```bash
cd /opt/render/project/src && node scripts/migration-128-staging.cjs --aplicar-128-autorizado --backup "<REGISTRO>"; echo "codigo=$?"
```

Esperado: `APLICADA_POSTCHECK_PASS` com `"commitadas":["128"]`. Marcador:
`/opt/render/project/src/data/dados-fora-do-disco-128-staging/migration-128.json` (ainda no disco; copie a saída para a nota,
porque o disco sai na fase 3). Em `codigo=2`, copiar a saída e o marcador e parar.

## Bloco 4 — CONFERIR a 128 depois (somente leitura)

```bash
cd /opt/render/project/src && node scripts/migration-128-staging.cjs --conferir-128; echo "codigo=$?"
```

Esperado: `JA_APLICADA_POSTCHECK_PASS`, `codigo=0`.

## Bloco 5 — CONFERIR a cópia do disco (somente leitura)

```bash
cd /opt/render/project/src && sha256sum -c - <<'SHA' && node scripts/disco-para-banco-128.cjs --conferir-128 staging; echo "codigo=$?"
9fa77e3fea86f7eb174b16064cca6248f237f81f3186e9a228e9fcefc5893292  scripts/disco-para-banco-128.cjs
ce3b584fd02209e9141390dab6610746e7768c4dab593b431e66bcbe38e2b83a  scripts/conexao-staging.cjs
d77246715622995abc675205326b4bc4e1ec86f80a302eeac0a1e9b7918b2258  scripts/conexao-production.cjs
192aa80ed52fad017072d67d4bcbc3a73e96c875119e39c70c71b598ee4ca49a  scripts/migration-116-staging.cjs
SHA
```

Esperado: `"situacao":"PRONTO_PARA_COPIAR"` com `pendentes` (config e quantos PDFs) e `"problemas":[]`. A saída traz
tamanhos e sha256, nunca o conteúdo. `codigo=3` com `problemas` (PDF ausente ou divergente; config ilegível: JSON inválido, campo que não é lista ou item que não é objeto; arquivo de
regras ausente sem linha no banco): parar. `staging` no comando é o alvo: precisa ser o `KIDMAIS_DEPLOY_ENV` do serviço,
senão recusa antes de conectar (`codigo=1`). Sem o disco montado também recusa (`codigo=1`).

## Bloco 6 — COPIAR (uma transação; só com o sim de Felipe)

```bash
cd /opt/render/project/src && node scripts/disco-para-banco-128.cjs --copiar-128-autorizado staging; echo "codigo=$?"
```

Esperado: `"resultado":"COPIADO"`, `"releitura":"APOS_COMMIT"`, `"situacao":"NADA_A_COPIAR"` (resumo relido depois do
COMMIT). Se o painel já gravou as regras no banco (origem PAINEL), `configCopiada` vem `false` e nada é sobrescrito; uma
linha DISCO de cópia anterior é atualizada se o arquivo mudou. Repetir é seguro.
- `codigo=2` (FALHA, `"nadaGravado":true`): falhou antes do COMMIT, nada foi gravado. Parar.
- `codigo=4` (INDETERMINADO): o COMMIT foi enviado sem confirmação. Não repetir: rodar o bloco 7 e colar a saída.
- `codigo=0` com `"releitura":"INDISPONIVEL"`: gravado, mas a releitura falhou. Rodar o bloco 7.

## Bloco 7 — CONFERIR a cópia depois (somente leitura)

```bash
cd /opt/render/project/src && node scripts/disco-para-banco-128.cjs --conferir-128 staging; echo "codigo=$?"
```

Esperado: `"situacao":"NADA_A_COPIAR"`, `codigo=0`. Depois, no painel de staging: a agenda pública mostra as mesmas regras
e o PDF da tabela de pacotes abre igual (mesmo sha256 do bloco 5). Se disser `PRONTO_PARA_COPIAR` (o arquivo mudou depois da
cópia), repetir o bloco 6 com novo sim de Felipe e depois este bloco. A remoção do disco só vem depois de `NADA_A_COPIAR`.
