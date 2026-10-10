# Evidência — catálogo do buffet por empresa (078), Frente D (10/10/2026)

Pacote: [HOMOLOGACAO_CATALOGO_BUFFET_20261010.md](../HOMOLOGACAO_CATALOGO_BUFFET_20261010.md). Candidata autorizada:
`ec61f02fa7877fe9cecdcd487d7c51014058820e` (código `b364ece`). Autorização de Felipe: D1–D3; B0–B6 condicionados ao sucesso de
todas as suítes PostgreSQL.

**Resultado: FALHA em D2 — B0–B6 NÃO executados.**

## Pré-condições

| Item | Resultado |
|---|---|
| `HEAD` | `ec61f02…`; depois de `b364ece` só `docs/HOMOLOGACAO_CATALOGO_BUFFET_20261010.md` |
| Árvore | limpa |
| `.env*`, `DATABASE_URL`, `PG*` | ausentes |
| Portas 55498 / 55481 / 3481 | livres |
| Planos offline (seed e concorrência) | `confere: true` |
| Observação | `KIDMAIS_HOMOLOGACAO_DATABASE_URL` estava definida no ambiente da sessão (valor não lido). Nenhuma ferramenta do pacote a usa; mesmo assim foi **removida do ambiente de cada comando** (`env -u`), sem alterar o ambiente do usuário |

## Frente D

| Passo | Resultado |
|---|---|
| D1 | `CRIADO` → `INICIADO` (escuta `127.0.0.1`) → `CONFERE`, PostgreSQL 18.0006, bancos `[]`; pasta `.local-descartavel-pg-22d5cd3fba084970be25e8e8597c15b9` |
| D2 | **4/5 arquivos OK, 1 FALHA** (log: [catalogo-078-d2-20261010.txt](catalogo-078-d2-20261010.txt)) |
| D3 | `PARADO`; pasta preservada; portas livres |

| Suíte | Modelo | Resultado |
|---|---|---|
| `lib/comercial/adicionais-070.postgres.test.ts` | 063 | OK |
| `lib/comercial/catalogo-buffet-078.postgres.test.ts` | 063 | **FALHA — 1/10** |
| `lib/comercial/catalogo-ux.postgres.test.ts` (com 078 na transação) | 063 | OK |
| `lib/comercial/round4-remediacao.postgres.test.ts` | atual | OK |
| `lib/saas/hg8-catalogo.postgres.test.ts` | atual | OK |

## Falha

Teste `078: precheck lista só OUTRA; migration e postcheck; segunda aplicação recusada` (linha 160):

- O precheck, a **primeira aplicação da 078** e o **postcheck** executaram sem erro (linhas anteriores do mesmo teste).
  A troca de unicidade antes das cópias não gerou violação com OUTRA usando categorias e itens sem categoria do catálogo antigo.
- A **segunda aplicação foi recusada**, mas com `078 exige a 050 (itens sem categoria).` em vez de `078 já aplicada.`:
  a guarda da 050 confere o índice `buffet_itens_codigo_sem_categoria_uk`, que a própria 078 remove; essa guarda vem antes da
  guarda “já aplicada”. A asserção da mensagem falhou.
- A falha deixou a conexão em transação abortada (o `ROLLBACK` do teste fica depois da asserção): os 8 testes seguintes falharam
  com `current transaction is aborted` — **efeito em cascata, sem verificar o conteúdo**. Portanto, as asserções de Kidmais
  idêntica, cópias com os mesmos códigos, histórico intocado e isolamento X/Y **não foram comprovadas** nesta execução.

Não houve efeito fora do cluster descartável. A reaplicação da 078 é recusada nos dois casos (fail-closed), mas a mensagem
induziria o operador a erro.

## Correção (preparada em `b73653b`, não executada em banco)

1. Na 078, conferir “já aplicada” (coluna `empresa_id`) **antes** da guarda da 050 (ou aceitar o índice da 050 ou o novo
   `buffet_itens_empresa_codigo_sem_categoria_uk`).
2. No teste, executar o `ROLLBACK` mesmo quando a asserção falha (`try/finally`), para que uma falha não mascare as demais.
3. Repetir D1–D3 em cluster novo; só então B0–B6 — pendente de nova autorização.

As duas correções estão em `b73653b6ab5c713c7ff0ae04b342de61ee7451fa`, com testes estáticos que falham contra `b364ece`;
pacote atualizado em [HOMOLOGACAO_CATALOGO_BUFFET_20261010.md](../HOMOLOGACAO_CATALOGO_BUFFET_20261010.md) §0.

Efeitos permanentes: somente a pasta `.local-descartavel-pg-22d5cd3fba084970be25e8e8597c15b9` (git-ignorada), preservada.
Sem chamadas externas, banco real, Render, push ou deploy.
