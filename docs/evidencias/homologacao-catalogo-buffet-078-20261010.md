# Evidência — catálogo do buffet por empresa (078), homologação local (10/10/2026)

Pacote: [HOMOLOGACAO_CATALOGO_BUFFET_20261010.md](../HOMOLOGACAO_CATALOGO_BUFFET_20261010.md). Duas execuções:

| # | Candidata (pacote / código) | Autorização | Resultado |
|---|---|---|---|
| 1 | `ec61f02` / `b364ece` | D1–D3; B0–B6 condicionados | **FALHA em D2** (abaixo, §Execução 1); B não executado |
| 2 | `be1b612c63d528f0e61695aeea19eea18898df48` / `b73653b` | D1–D3 em cluster novo; B0–B6 só se as 5 suítes passassem; sem envio de pedidos | **PASS**: D 5/5 suítes; B0–B6 concluídos; K1–K8 PASS (§Execução 2) |

## Execução 2 — `be1b612` (PASS)

### Pré-condições
HEAD `be1b612`; só `docs/` depois de `b73653b`; árvore limpa; sem `.env*`, `DATABASE_URL`, `PG*`; portas 55498/55481/3481 livres;
planos `confere: true`. `KIDMAIS_HOMOLOGACAO_DATABASE_URL` (valor não lido) removida do ambiente de todos os comandos (`env -u`).

### Frente D
| Passo | Resultado |
|---|---|
| D1 | cluster **novo** `.local-descartavel-pg-e0138ee7f0914de798b145301ef4e48c`: `CRIADO`, `INICIADO` (127.0.0.1:55498), `CONFERE`, bancos `[]` |
| D2 | **PASS — 5/5 arquivos** ([log](catalogo-078-d2-b73653b-20261010.txt)): adicionais-070 9/9; **catalogo-buffet-078 10/10**; catalogo-ux 1/1; round4-remediacao 8/8; hg8-catalogo 6/6 |
| D3 | `PARADO`; pasta preservada; 55498 livre |

A suíte da 078 comprovou em PostgreSQL: precheck lista só OUTRA; aplicação, postcheck e **reaplicação recusada como “078 já aplicada”**;
Kidmais idêntica; cópia só do usado com **os mesmos códigos** (categorias e itens sem categoria, via pacote e via adicional); NOVA sem
catálogo; pedidos/fotografias intocados; isolamento X/Y em leitura, escrita, gatilhos, escolha no pedido, adicional e cotação.

### Frente B
| Passo | Resultado |
|---|---|
| B0 | `.local-navegador` → `.local-navegador-execucao-59b0898` (intacta) |
| B1 | cluster novo `.local-navegador-pg-adc57ac480cd49128f6814e18817b00c`: `CONFERE`, bancos `[]` |
| B2 | seed `PASS` em `kidmais_navegador_catalogo_20261010`: 80 migrations, última 078, impressão `ba47d7bf…22c1`; Profissional DOCES+SALGADOS (5 itens); Premium MASSA_BOLO+SALGADOS (4 itens); legado Kidmais 7 categorias / 62 itens; nenhuma senha/CPF no console |
| B3 | servidor 127.0.0.1:3481, Asaas `DESLIGADO(CHAVE_FORA_DO_SANDBOX)`, `consultaCepExterna: false`; variável de homologação ausente do ambiente |
| B4 | checklist abaixo (navegador embutido; desktop 1280 px e celular 375×812) |
| B5 | pós-conferência `--catalogo` `CONFERE`, `vinculosEntreEmpresas: 0`; kidmais 7/62, premium 2/4, profissional 3/6 (com K5), essencial 0/0 |
| B6 | servidor encerrado (árvore de processos do lançador), cluster `PARADO`, portas livres, `next-env.d.ts` restaurado, aba do navegador fechada |

### Checklist
| # | Resultado | D | C |
|---|---|---|---|
| K1 | Buffet do Profissional: Doces (Beijinho/Brigadeiro Profissional sintético) e Salgados (Coxinha/Esfiha/Kibe Profissional sintético); nenhum termo da Kidmais/Premium nem no conteúdo oculto | PASS | PASS |
| K2 | Premium: **mesma categoria “Salgados”** com Empada/Pastel Premium; Massa do bolo Premium; nada do Profissional/Kidmais | PASS | PASS |
| K3 | `/fechamento` Festa Completa: cardápio original (Salgados 8 de 25 itens, iniciando por “Bombom de mandioca com carne seca”; Doces 16; Massa; Recheio; Lembrancinhas); nenhum item sintético | PASS | PASS |
| K4 | APIs sem sessão: Profissional só itens Profissional; Premium só Premium; `COMPLETA` sem empresa = cardápio Kidmais | PASS | — |
| K5 | Gestão Profissional: lista só o próprio catálogo; criou “Bolos sintéticos” e “Bolo de cenoura sintético”; editou o nome (“… editado”); desativou e reativou (“Alterações salvas.” em cada passo); no celular, leitura sem rolagem horizontal | PASS | PASS (leitura) |
| K6 | Gestão Premium: só Massa do bolo/Salgados; `PATCH` editar e excluir o item do Profissional (com sessão e CSRF válidos) → **404 NAO_ENCONTRADO**; leitura só-leitura no banco: item intacto (nome, ativo, empresa) | PASS | — |
| K7 | Equipe do Essencial: `PATCH nova_categoria` → **403 PAPEL_NAO_AUTORIZADO**; leitura 200; nada criado (consulta só-leitura) | PASS | — |
| K8 | `/b/nav-profissional` depois de K5: Buffet só Doces/Salgados; nada de K5/K6 no Profissional, Premium ou legado (tela e APIs) | PASS | — |

Envio de pedidos: **nenhum** (`POST /api/fechamentos` 0×; só `cotacao` 7× e `autenticacao` 6×). Nenhuma chamada externa no log
(ViaCEP, fontes, Asaas: 0). Credenciais sintéticas digitadas só em `localhost:3481`.

### Observação (fora do escopo do catálogo; pré-existente)
`lib/agenda/disponibilidade.ts` aplica regras **fixas da Kidmais** por código de pacote (`pocket`: segunda a quinta e sexta no almoço;
`mini`, `compacta`). O pacote `POCKET` de uma empresa terceira herda essa regra: em 14/11/2026 (sábado) o Profissional recebeu
“Este pacote não está disponível para a data e período escolhidos”, embora a seed libere todos os dias. O checklist foi feito em 18/11
(quarta). Mesmo tipo de acoplamento já corrigido para textos e pagamentos em `72b8659`; sugerido registrar como pendência de produção
multiempresa (decisão de produto). O navegador ficou oculto durante parte da execução; as interações usaram tamanho emulado.

## Execução 1 — `ec61f02` (FALHA em D2)

### Pré-condições

| Item | Resultado |
|---|---|
| `HEAD` | `ec61f02…`; depois de `b364ece` só `docs/HOMOLOGACAO_CATALOGO_BUFFET_20261010.md` |
| Árvore | limpa |
| `.env*`, `DATABASE_URL`, `PG*` | ausentes |
| Portas 55498 / 55481 / 3481 | livres |
| Planos offline (seed e concorrência) | `confere: true` |
| Observação | `KIDMAIS_HOMOLOGACAO_DATABASE_URL` estava definida no ambiente da sessão (valor não lido). Nenhuma ferramenta do pacote a usa; mesmo assim foi **removida do ambiente de cada comando** (`env -u`), sem alterar o ambiente do usuário |

### Frente D

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

### Falha

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

### Correção (preparada em `b73653b`, não executada em banco)

1. Na 078, conferir “já aplicada” (coluna `empresa_id`) **antes** da guarda da 050 (ou aceitar o índice da 050 ou o novo
   `buffet_itens_empresa_codigo_sem_categoria_uk`).
2. No teste, executar o `ROLLBACK` mesmo quando a asserção falha (`try/finally`), para que uma falha não mascare as demais.
3. Repetir D1–D3 em cluster novo; só então B0–B6 — pendente de nova autorização.

As duas correções estão em `b73653b6ab5c713c7ff0ae04b342de61ee7451fa`, com testes estáticos que falham contra `b364ece`;
pacote atualizado em [HOMOLOGACAO_CATALOGO_BUFFET_20261010.md](../HOMOLOGACAO_CATALOGO_BUFFET_20261010.md) §0.

Efeitos permanentes: somente a pasta `.local-descartavel-pg-22d5cd3fba084970be25e8e8597c15b9` (git-ignorada), preservada.
Sem chamadas externas, banco real, Render, push ou deploy.
