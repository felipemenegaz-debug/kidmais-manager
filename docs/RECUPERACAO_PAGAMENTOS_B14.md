# B-14 — Procedimento operacional da recuperação de pagamentos

Rev. 2, 28/10/2026, LOCAL. A rev. 1 foi REPROVADA pelo Astra: ordem do RESTORE, garantia do código 1 e fila do painel. Plano: `docs/PLANO_RECUPERACAO_PAGAMENTOS_B14_20261027.md` (rev. 8.1); implementação: `docs/RECUPERACAO_PAGAMENTOS_B14_IMPLEMENTACAO.md`.

**Este documento não autoriza nada.** Cada passo cita a autorização de que precisa (§10 do plano). Uma aprovação histórica, de revisão ou de um passo anterior, não vale para o seguinte.

## 1. Quando usar

| Situação | Modo | Autorização |
| --- | --- | --- |
| E0 da promoção (código antigo no ar) | ENTREGA → FILA → **CONFERIR-E0** (linha de base) | A-B14-L (+ A-B14-F se faltar evento) |
| Depois da reabertura, com a candidata no ar | RECUPERAR → FILA → CONFERIR | A-B14-R + A-B14-L |
| Fila do webhook pausada | Felipe corrige e reativa no painel → RECUPERAR + CONFERIR | A-B14-F, A-B14-R |
| Restore, rollback com dados ou código antigo | manutenção → barreira B-16 → `R` + instâncias (Render) → reinício → prova da drenagem (metadados + DRENAGEM) → **só então** restore → export novo → VSC → INVENTARIO → decisões → APLICAR-CASO + CONFERIR-CASO por caso (INVENTARIO novo entre casos da mesma empresa) → LIBERACAO → desligar a manutenção (detalhe na §5) | A-B14-C, A-B14-L, A-B14-O por caso |
| Encerramento | LIMPEZA com `KIDMAIS_B14_ENCERRAMENTO=SIM` | A-B14-L |

**Matriz (quem roda onde),** conferida pela entrada antes de conectar:

| Schema | Código no ar | Modos admitidos |
| --- | --- | --- |
| P0a; P0b = P1 (089 aplicada) | antigo (`00d3019a` ou `4ef9adb6`, B-23) | fila, JANELA `--conferir`, RESTORE |
| P2, P3, P4 | antigo (`00d3019a` ou `4ef9adb6`, B-23) | fila, RESTORE |
| P0a–P3 | candidata | só fila |
| P4–P11 | candidata | JANELA completa, RESTORE |
| P5–P11 | antigo (`00d3019a` ou `4ef9adb6`, B-23) | só fila |
| PH (só sandbox: P11 + 102–106) | candidata | como P11 |
| fora da lista | qualquer | só fila |

Fonte: `modoAdmitido` em `lib/assinatura/recuperacao-execucao.ts`. Cada linha é provada no PG descartável, em cada prefixo, com o pacote entregue (`recuperacao-prefixos.postgres.test.ts`).

## 2. Antes de qualquer colagem

1. **Gerar os blocos localmente:**
   ```bash
   node scripts/bloco-shell-recuperacao-b14.cjs <staging|production> <candidata-sha40> <pasta-de-saida-nova>
   ```
   O comando imprime o sha256 e os bytes de cada bloco. Esses valores entram no pedido de autorização.
2. **Conferir antes de colar:** sha e bytes do bloco iguais aos do pedido; o serviço do Web Shell é o do ambiente (staging `srv-daif418ae00c73e8k2gg`, production `srv-dak77m2d0e5s73b8rkkg`). O bloco recusa outro serviço sozinho, mas a conferência humana vem primeiro.
3. **Ver se há variáveis `PG*` no serviço, só os nomes:**
   ```bash
   env | cut -d= -f1 | grep -E '^(PG|NODE_PG_FORCE_NATIVE)' || echo SEM_PG
   ```
   Qualquer nome listado faz toda conexão recusar (`AMBIENTE_COM_VARIAVEL_PG`). Nesse caso, parar e levar a Felipe. Nunca remover a variável sem autorização.
4. **Exportar antes de colar** as variáveis `KIDMAIS_B14_*` que o cabeçalho do bloco pede. Os valores aceitam só `[A-Za-z0-9:._,/+-]`, sem espaço nem aspas. `KIDMAIS_B14_MIGRACOES` é a lista do CONFERIR do B-5, conferida contra os marcadores no banco.

## 3. Colagem

- **Uma colagem por bloco, inteira, e Enter.** Prompt `>` depois de colar quer dizer colagem incompleta: Ctrl-C, e nunca colar por cima.
- **Fim esperado:** a linha `CODIGO_SAIDA_BLOCO=<n>`. Sem essa linha, ou com um código fora da tabela abaixo (127, 130, 143…), **parar e ler**.
- **Entrega da árvore:**
  1. colar ENTREGA-1..N; cada parte termina em `PARTE_OK k/N`, e colar de novo dá `JA_PRESENTE`;
  2. colar ENTREGA-CONFERIR, que termina em `ARVORE_OK <hash>`, com runtime `node=v22.23.2 pg=8.23.0 zod=4.5.4`.
- **Blocos de operação:** cada um reconfere a árvore e o runtime. Na JANELA, exige `lib/` idêntico ao deploy (`EQUIVALENCIA_LIB … diferentes=0`). O CONFERIR-E0 aceita o código antigo e só informa a diferença.

## 4. Códigos

| Código | Significado | O que fazer |
| --- | --- | --- |
| 0 | concluído, cobertura completa | registrar a evidência |
| 1 | recusa técnica, antes ou durante (alvo, trava, marcadores, modo, backup, parada, `COMMIT_INDETERMINADO`) | ler o `motivo` e a evidência. **Não há garantia de que nada foi gravado:** numa parada durante a JANELA `--recuperar`, os casos já confirmados antes dela continuam gravados (a evidência lista os `aplicados` quando chegou a ser escrita), e um `COMMIT` sem resposta pode ou não ter gravado. Antes de repetir: JANELA → `--conferir` com o mesmo `--desde`/`--ate`; RESTORE → CONFERIR-CASO com a `--execucao` da aplicação. Corrigir a causa e repetir só se o motivo permitir |
| 2 | divergência ou estado que exige decisão (JANELA com casos; RESTORE sempre assistido) | levar a Felipe com a evidência; no RESTORE, decisões por caso (A-B14-O) |
| 3 | cobertura incompleta (limite, prazo de 15 min, lista truncada) | não declarar "reconciliado"; repetir com uma janela menor ou registrar a exceção |
| 4 | recusa do próprio bloco (árvore, runtime, variável, serviço, E0 fora do código antigo, LIMPEZA sem a confirmação) | a entrada (`node`) **não** rodou: nada no banco nem no Asaas. Mas o bloco pode ter mexido em arquivos antes de recusar: uma ENTREGA pode ter gravado parte dos arquivos da árvore (`ESCRITO …`) antes de `GRAVACAO_FALHOU`, e a LIMPEZA pode ter removido parte dos arquivos da árvore (sem linha própria) ou dos casos (`CASOS_REMOVIDO …`) antes de `REMOCAO_FALHOU`. Ler as linhas anteriores ao código. ENTREGA: colar de novo é idempotente (`JA_PRESENTE`) e a ENTREGA-CONFERIR diz se a árvore está inteira. LIMPEZA: colar de novo continua de onde parou |

**`COMMIT` sem resposta:**
- na JANELA, repetir o `--conferir` com o mesmo `--desde`/`--ate`;
- no RESTORE, nunca repetir o APLICAR-CASO: rodar o CONFERIR-CASO com a `--execucao` da aplicação (APLICADO, NAO_APLICADO ou DIVERGENTE).

## 5. RESTORE, passo a passo (§5 do plano)

**A barreira e a drenagem vêm ANTES de restaurar ou inventariar,** e a barreira dura até a liberação. A tabela da §6 do plano resume a sequência sem a drenagem; vale a §5.

1. **Contenção:**
   - manutenção do web ligada (A-B14-C), com o instante anotado (início da contenção);
   - todas as entradas públicas fechadas (webhook recebe 503 e o Asaas retém).
2. **Barreira B-16 validada:** consumidores internos pausados e crons cuja execução coincidiria suspensos (A-B14-C).
3. **Antes do reinício,** anotar o instante `R` (UTC) e a lista de instâncias do serviço, lida nos metadados do Render (somente leitura).
4. **Reinício do web com a manutenção ligada** (A-B14-C).
5. **Prova da drenagem em três partes.** O reinício sozinho não prova nada.
   - **(a) Fora do SQL,** nos metadados do Render: o evento de reinício/deploy concluído, e nenhuma instância anterior a `R` em execução (todas com início ≥ `R`). Sem essa leitura, a drenagem não está provada.
   - **(b) e (c) Bloco DRENAGEM,** com `KIDMAIS_B14_REINICIO=R` e `KIDMAIS_B14_CONTENCAO_DESDE` = início da contenção. Esperado: `PASS`. Ele confere:
     - nenhuma sessão com `backend_start < R`, fora as identificadas (ferramenta, crons com `application_name` próprio);
     - em amostras por 2 min, nenhuma sessão posterior a `R` em `idle in transaction` ou com transação de mais de 5 s.
   - **Barreira B-16 revalidada depois do reinício.** As pausas precisam sobreviver a ele.
   - Qualquer consumidor não contido ou não drenado **bloqueia**.
6. **Restore** e, depois dele, um **export novo**, que é o backup exigido (D-B14-12). Em seguida, a VSC do plano de promoção.
7. **INVENTARIO.** Grava só o arquivo de casos (600). Nada no banco.
8. **Decisões de Felipe por caso** (A-B14-O), com o arquivo de decisões ligado ao inventário.
9. **APLICAR-CASO** por caso aprovado, depois **CONFERIR-CASO**. **Vários casos da mesma empresa:** a pré-condição de cada um é a fotografia da empresa inteira, então aplicar um invalida a proposta dos outros. A aplicação seguinte recusa com `DIVERGENTE` e nada é gravado. Entre um e outro, rodar um INVENTARIO novo e aprovar a proposta nova (A-B14-O do caso, pelo hash novo). Qualquer aplicação depois do inventário de liberação (Tf) invalida a liberação: refazer a LIBERACAO.
10. **LIBERACAO,** imediatamente antes de desligar a manutenção, sem nenhum APLICAR-CASO depois. Exige:
    - todos os casos decididos;
    - toda chave KidMais em `SEM_EFEITO` sob as regras do código que fica no ar (com a candidata, a árvore verifica);
    - órfãs decididas e cobertura completa ou aceita;
    - FILA com código 0, ou só `interrupted` com as demais condições da §3.7;
    - **com o código antigo**, a prova do cron `7ce0916f` (exceção expressa, D-B14-18). Ela é disparada manualmente no Render (A-B14-C), só conferência, e precisa ter: concluída, código 0, `divergente = false`, `incompleto = false` e `kidmais.violada = false`. Os pontos cegos aceitos por escrito ficam no registro.
11. **Desligar a manutenção,** retomar os consumidores e crons pausados, e fazer a conferência pós-reabertura:
    - **com a candidata:** JANELA `--conferir` com `--desde` = Tf;
    - **com o código antigo:** **não** rodar o CONFERIR do B-14 (a JANELA não é admitida com o antigo depois do P1). A conferência é a **próxima execução do cron antigo**;
    - **se a liberação usou a exceção `interrupted`:** reativação efetiva da fila (A-B14-F), nova FILA com código 0, e a confirmação de entrega (evento novo em `cobranca_eventos` depois da reabertura, ou os logs de webhooks do painel conferidos por Felipe).
12. **Prazo:** passados 14 dias de contenção, a perda de eventos retidos entra como limitação aceita, com aceite explícito na decisão.

## 6. Homologação em staging (prefixo PH)

O staging tem migrations neutras (102, 103 e 105; 104/106 a confirmar) além do P11. A entrada só o admite como `PH`, e só porque o alvo é sandbox:
- `KIDMAIS_B14_MIGRACOES` = P11 + as neutras **efetivamente aplicadas**, conferidas por marcador. A 103 vale pela declaração do CONFERIR.
- Registrar no relatório o conjunto exato aplicado, que é o que a revisão do PH pede.
- Production nunca aceita `PH`.

Roteiro completo, autorizações e critérios de PASS: `docs/PEDIDO_HOMOLOGACAO_B14_STAGING_20261028.md` (H0–H9).

## 7. Encerramento

- **Estados finais** (D-B14-11):
  - "reconciliação concluída": JANELA com código 0;
  - "encerrada com exceções aceitas": JANELA com 2/3 e aceite item a item;
  - "encerrada por aceite": RESTORE com a liberação cumprida.
- **LIMPEZA:** `export KIDMAIS_B14_ENCERRAMENTO=SIM` e colar o bloco. Ele remove a árvore (só arquivos com o sha certo) e **todos** os `casos-*.json`. As demais evidências ficam. O arquivo de casos some no encerramento ou em 30 dias (D-B14-8).

## 8. Efeito observável da gravação só com mudança (§3.3.1)

O processamento compartilhado (web e ferramenta) não regrava valores iguais. Por isso:
- O gatilho da 095 renova `ia_credito_cobrancas.atualizada_em` em **todo** `UPDATE` da linha. Essa coluna ordena a fila do painel de créditos (`lib/desenvolvedor/creditos.ts:59`) e mede a idade das pendências no reconciliador. Por isso o efeito depende do tipo:
  - **cobrança canônica:** toda leitura grava o cursor `conferida_em`, então `atualizada_em` se renova **a cada leitura**, mesmo sem mudança. A posição na fila e a idade contam da última leitura, não da última mudança real;
  - **cobrança extra (não canônica, `processarExtra`):** não há cursor, então só uma mudança real renova `atualizada_em`. Releitura sem mudança mantém posição e idade;
  - **pedido (`ia_credito_pedidos`):** o cursor da reconciliação é `reconciliado_em`, que anda a cada tentativa. Estado e motivo só mudam com mudança real.
- Os cursores (`conferida_em`, `reconciliado_em`) estão no domínio do `SEM_EFEITO` e não bloqueiam a liberação.
- **Disputa aberta:** a exposição acompanha o consumo a cada leitura (só sobe). Uma reserva feita antes da disputa e consumida depois aumenta a exposição na leitura seguinte, e isso é efeito. O bloqueio do remanescente é só na abertura; o que volta de reserva durante a disputa já cai em bloqueado (revisão do HB-3, 28/10).
- **Disputa perdida** (ABERTA → PERDIDA) mantém o motivo que tinha. Ela não vira "estorno sem pedido" numa leitura seguinte; achado e corrigido na matriz de 28/10.

## 9. Nunca

- colar um bloco de outro ambiente, ou um bloco cujo sha/bytes não confere;
- repetir um APLICAR-CASO sem antes rodar o CONFERIR-CASO;
- escrever no Asaas pela ferramenta (ela só lê);
- remover ou neutralizar variáveis do serviço, mudar crons ou flags sem autorização própria;
- usar `PH` ou blocos de staging em production.
