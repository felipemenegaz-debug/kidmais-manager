# B-9: o modo agendado não regrava registro sem mudança (D-P5-3, 27/10/2026)

**Estado:** LOCAL, sem commit, na branch `codex/b9-escrita-idempotente-20261027`, sobre `85f60574`. **APROVADO COM RESSALVAS** pela revisão independente (27/10): sem P1/P2, e os dois P3 de texto foram incorporados abaixo. Sem push, PR ou deploy.

## Origem

- A revisão independente do pedido do passo 5 (`aplicar` no cron de staging) **reprovou** a premissa "única escrita = criar o `PENDENTE`".
- Em `processarRenovacao`:
  - para empresa não vigente, a verificação de vigência vem **antes** do retorno por registro já `CANCELADA`, e por isso chama `marcar(CANCELADA)` de novo;
  - um registro já `REGULAR` chega ao `marcar(REGULAR)` final.
- `repositorio.marcar` faz um `UPDATE` sem filtro de igualdade e grava `ultimo_erro`. O gatilho 075 aceita a transição para o mesmo estado e atualiza `atualizado_em`.
- Com o cron de hora em hora, isso daria **3 UPDATEs por hora** no inventário de staging (2 canceladas e a B9), sem efeito de negócio. **O mesmo aconteceria em production.**
- Felipe escolheu a opção B: corrigir antes do `aplicar`.

## O que muda

`lib/assinatura/renovacao-fundador.ts`, só no **modo agendado** (`deps.modoAgendado`):
- **Empresa não vigente com registro já `CANCELADA`:** retorna `CANCELADA` sem chamar `marcar`.
- **Registro já `REGULAR` que chega ao fim do fluxo:** retorna `REGULAR` sem chamar `marcar`.

**O que continua igual:**
- **Fora do modo agendado** (ferramenta restrita): o comportamento anterior, inclusive a regravação.
- **Transições reais** continuam sendo gravadas no modo agendado: `PENDENTE`, `AVISANDO`, `AVISADA`, `APLICANDO` ou `REGULAR` → `CANCELADA` de empresa não vigente; `REGULAR` → `CANCELADA` por assinatura inativa; e a **primeira** chegada a `REGULAR`.
- **Resultado e código de saída:** iguais. O relatório e a classificação não mudam.

**Por que não se perde informação:**
- Os únicos caminhos que gravam `CANCELADA` ou `REGULAR` são os `marcar` desta rotina, e todos gravam `ultimo_erro = null`.
- `renovacao-entrega.ts` só grava `REVISAO`.
- As evidências (`aviso_*`, `preco_aplicado_em`) são imutáveis pela 075 e preservadas por `COALESCE`.
- Pular a regravação só deixa de mudar `atualizado_em`.

**Por que a correção fica na rotina, e não no repositório:** uma guarda genérica em `marcar`, comparando com o registro em memória, poderia pular uma gravação necessária quando o registro local está desatualizado. É o caso de `AVISANDO` com `erro: ENVIO_INCERTO` depois de uma tentativa no mesmo ciclo. As duas guardas pontuais não têm esse risco.

## Validação local

- **`lib/assinatura/renovacao-fundador.test.ts`:** 32/32, com 2 casos novos:
  - **CANCELADA:**
    - no agendado, nenhuma chamada (nem `marcar`, nem rede);
    - na ferramenta restrita, `marcar(CANCELADA)` como antes;
    - no agendado, `PENDENTE`, `AVISANDO`, `AVISADA`, `APLICANDO` e `REGULAR` de empresa não vigente continuam sendo marcados `CANCELADA`.
  - **REGULAR:**
    - a primeira chegada é gravada;
    - a segunda execução agendada não faz nenhuma chamada (escrita, envio ou PUT), e o registro fica idêntico;
    - na ferramenta restrita, regrava como antes;
    - `REGULAR` → `CANCELADA` por assinatura inativa continua gravado.
- **`lib/assinatura/renovacao-agendada.postgres.test.ts`, caso 11 novo**, em PostgreSQL descartável, com a entrada real num processo filho:
  - um registro `REGULAR` (o do caso 2) passa por uma nova execução `aplicar` com **estado, `ultimo_erro`, evidências (`aviso_*`, `preco_aplicado_em`) e `atualizado_em` idênticos**, sem envio nem PUT. Com o gatilho 075 ativo, `atualizado_em` igual já detecta qualquer regravação;
  - uma empresa nova vai a `PENDENTE`, é desativada e passa a `CANCELADA` (escrita real); na execução seguinte, os mesmos campos ficam idênticos.
- **Mutantes em cópia isolada:** 7/7 detectados (I1–I7), e o controle I0 sobreviveu. O I7 (guarda pelo estado errado) sobreviveu na primeira rodada e levou ao reforço do teste com os outros estados.
- **PostgreSQL descartável (cluster 55615, removido no fim):**
  - arquivo alterado OK;
  - bateria completa: **170/170 arquivos, 1021 aprovados, 0 falhas, 41 pulados por desenho**.
  - Numa primeira rodada completa, `lib/agenda/aplicador-098.postgres.test.ts` falhou uma vez: uma falha injetada saiu `APLICADA_POSTCHECK_PASS`. Esse arquivo não importa nada da renovação. Rodado sozinho, passou, e a segunda rodada completa também. O fecho de imports dele não chega à renovação, o que sustenta a independência desta mudança. A causa não foi demonstrada: a revisão aponta uma corrida plausível no próprio teste, que observa o precheck sem garantir o lock antes da migration (linha 106). Fica como intermitência a tratar à parte.
- **CI local:** os 28 passos de `.github/workflows/ci.yml` em `85f60574`, inclusive 102-103, com saída 0. O estático (lint, TypeScript e build) passou 3724/3724, e o `production:test` 103/103.

## Limites

- A eliminação das regravações vale **só para `CANCELADA` e `REGULAR`**. Os estados intermediários mantêm o comportamento anterior, de propósito:
  - `APLICANDO` → `APLICANDO` continua sendo regravado em retomadas;
  - as retentativas em `AVISANDO` também, porque podem limpar ou registrar `ENVIO_INCERTO`.
  - Decisões operacionais usam `atualizado_em` desses estados (`renovacao-operacao.ts`). Mudar isso exigiria uma avaliação separada.
- Os UPDATEs de **transição real** continuam acontecendo, e isso é o esperado.
- Em `aplicar`, o INSERT do `PENDENTE` de empresa vigente sem registro continua, por desenho.
- Esta mudança não altera o relatório. A prova em staging é a primeira execução `aplicar` do cron, no passo 5, com pedido e autorização próprios.
