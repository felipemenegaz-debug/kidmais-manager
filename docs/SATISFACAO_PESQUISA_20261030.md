# Pesquisa de satisfação pós-festa — PS-1 local — 30/10/2026

**Estado: PS-1 IMPLEMENTADA E VALIDADA LOCALMENTE, aguardando revisão do Astra.** Sem commit, push, PR, staging,
produção, Render ou envio real. A migration 110 **não** foi aplicada em nenhum banco real: só no cluster PostgreSQL
descartável da PS-1 (127.0.0.1:55551), autorizado por Felipe ("Autorizar", 30/10).

- Plano: vault `02 - Kidmais Manager SaaS/07 - Roadmap/Plano pesquisa de satisfacao 20261030.md` (rev. 6 APROVADA
  pelo Astra; D-PS1..D-PS8 de Felipe).
- Clone: `kidmais-manager-satisfacao-ps1-20261030`, branch `codex/satisfacao-ps1-20261030`, base `origin/staging`
  `d8943742`.
- Interruptor: `SATISFACAO_PESQUISA_ENABLED` (desligado = 503 genérico antes de ler o corpo). Anel de chaves do link:
  `SATISFACAO_LINK_CHAVES` + `SATISFACAO_LINK_CHAVE_ATUAL` (ausente ou malformado = falha fechada).

## O que a PS-1 entrega

| Parte | Arquivos |
|---|---|
| Migration 110 | `database/migrations/20261030_110_satisfacao_pesquisa.sql`, `database/checks/20261030_110_{precheck,postcheck}.sql`, `database/rollback/20261030_110_satisfacao_pesquisa_down.sql` |
| Módulo | `lib/satisfacao/`: `token.ts` (HMAC, anel, rotação), `fragmento.ts`, `questionario.ts` (v1 e NPS), `envios.ts` (criação e regeneração), `travas.ts` (pais NOWAIT, 5 tentativas), `publico.ts` (abrir, responder, sair), `supressao.ts` (alcance por canal), `http.ts`, `erros.ts` |
| Rotas e página | `app/api/satisfacao/{abrir,responder,sair}/route.ts` (só POST), `app/p/satisfacao/` (página pública), cabeçalhos `/p/:path*` em `next.config.ts` |
| Marketing | `preferencias.ts` (`bloqueioWhatsappDoDestino`: controles OU conversas na mesma instrução; `suprimirPesquisas`), `motor.ts` (`frequenciaExcedida` com reserva viva e `excetoEnvioId`; `PESQUISA_NAO_DISPONIVEL`) |
| WhatsApp | `service.ts`: PARAR suprime só o WhatsApp das pesquisas pendentes dos clientes do número |
| Inventários | `check-migrations.mjs`/`production.test.mjs` (110 na lista, autorização explícita), receita do modelo `110`, seleção das suítes PG, exportação verificável (8 tabelas `satisfacao_*` no pacote com `migracao: '110'`, `satisfacao_email_simulado` fora do escopo; retrato `colunas-esperadas-110.json`) |

## Resultados (todos locais)

| Prova | Resultado |
|---|---|
| Unitários `lib/satisfacao/satisfacao.test.ts` | 7/7 |
| PG `satisfacao.postgres.test.ts` (modelo 110) | 21/21 |
| PG `satisfacao-concorrencia.postgres.test.ts` (três conexões, espera observada em `pg_stat_activity`) | 9/9 |
| Regressão PG Marketing + WhatsApp + pesquisa | 43 arquivos, 150 testes, 0 falhas, 0 skips |
| Exportação verificável nos modelos 098/103/108/109/110 | 29/29; retratos antigos inalterados; o 110 = 109 + tabelas da pesquisa + 3 colunas novas de `marketing_automacao_regras` |
| Mutantes causais (clone LF isolado, `npm ci` próprio) | 28/28 MORTOS (3 pelo postcheck; ver abaixo) |
| CI local (todos os passos de `ci.yml`) | 34/34 |
| E2E Playwright 1366 e 390 px | 28/28 conferências PASS |

### Mutantes

28 mutantes, um por defesa (M01–M28 em `ambientes-locais/satisfacao-ps1-mutantes.cjs`), controle sem mutação PASS antes.
Todos MORTOS. Causa de cada um conferida no relatório:

- M01–M14, M16–M20, M23–M28: morrem na prova específica (ex.: M02 sem `FOR UPDATE` → a segunda resposta deixa de
  esperar no marcador `satisfacao:travar-envio`; M17 sem o prazo de 24 h → o envio a 12 h de expirar passa a aceitar
  ENVIANDO; M28 link num log → a varredura de sigilo acha).
- **M15 (086 sem `PESQUISA_CRIADA`), M21 (sem UNIQUE da festa) e M22 (sem UNIQUE da resposta): morrem no postcheck da
  110** durante a montagem do modelo — gate estrutural, não a prova de comportamento. A prova de comportamento de M21
  existe (INSERT direto com outra execução da mesma festa → 23505), mas não chega a rodar. A de M22 é mascarada pelo
  gatilho "resposta só em envio ATIVO" + invariante + `FOR UPDATE` (defesa em profundidade); fica só o gate estrutural.
- M17 sobreviveu na primeira rodada: a prova usava um envio de 30 dias (já vencido), que o mutante também recusava.
  Corrigido para 29,5 dias (expira em 12 h) e o mutante passou a morrer pela causa certa.

### E2E

`ambientes-locais/satisfacao-ps1-e2e.cjs` (+ semente sintética com as fixtures das suítes) num banco
`kidmais_satisfacao_e2e` do cluster descartável (criado do modelo 110 e apagado no fim). Capturas só da página.

- Produção (`next start`): `Cache-Control: no-store`, `noindex`, `no-referrer` em GET e HEAD; CSP só `'self'`, sem
  `unsafe-eval`.
- Fluxos (`next dev`, convenção dos roteiros `scripts/*-ui.cjs`): GET/HEAD sem gravação; GET nas APIs = 405; nota
  pré-marcada pelo link sem gravar resposta; resposta gravada (1366 e 390, sem rolagem horizontal); nota 3 com aviso e
  tarefa ABERTA; o link sai da barra de endereço; mesmo link = "já respondida"; vencido, adulterado e sem token =
  "Pesquisa indisponível"; saída das pesquisas grava e encerra as entregas; zero requisição a terceiros; o link (nem o
  prefixo) não aparece em URL, Referer nem log do servidor.

**Achados do E2E (corrigidos):**
1. **`Origin: null` recusado:** o `fetch` da página usava `referrerPolicy: "no-referrer"`, e com isso o navegador manda
   `Origin: null`; a conferência de origem recusava o POST (a página caía em "indisponível"). As suítes chamam o
   serviço direto e não pegam isso. Agora `same-origin` (o Referer nunca leva o fragmento; o documento segue
   `no-referrer`).
2. **Pergunta sobre a borda do cartão:** a `<legend>` do fieldset ficava sobre a borda; `legend` flutuante resolve.

### CI local

Todos os passos de `.github/workflows/ci.yml` (menos `npm ci`) com o código de saída de cada um conferido.
Primeira rodada: 33/34; a falha (`production:test`, "latest" ainda 109) foi corrigida (37/37). **Rodada final, sobre a
árvore com as correções do E2E: 34/34 passos com saída 0** (`check:v1:static` inclui lint, TypeScript, build e os
4 077 + 103 testes estáticos; restam 3 avisos de lint antigos, fora desta mudança).

Relatórios (fora do repositório, em `ambientes-locais/pg-descartavel-satisfacao-ps1-relatorios/`): regressão PG
`2026-10-30T11-47-57-355Z-check-v1-postgres.log`, mutantes finais `2026-10-30T13-03-25-302Z-mutantes.txt`, E2E final
`2026-10-30T12-55-26-413Z-e2e/` (resultado e capturas).

## Desvios do plano (para o Astra)

- `satisfacao_envios.estabelecimento_id` é anulável (festa sem unidade); o gatilho exige igualdade com a festa.
- A guarda da 043 torna inutilizáveis, hoje, as concessões por unidade de `satisfacao_capacidades` (só a tabela e o
  gatilho entram na PS-1; o uso é da PS-4).
- A criação trava os pais `FOR SHARE NOWAIT` **antes** do INSERT (o gatilho trava de novo); a troca do cliente da
  festa espera a criação, e a criação recebe 55P03 se a troca chegou antes (provado nas duas ordens).
- Agregados e expurgos: só as tabelas (escritor na PS-6, D-PS7).
- Fixtures: contrato ASSINADO mínimo gravado com `session_replication_role = replica` (precedente
  `lib/agenda/aplicador-100.postgres.test.ts`), numa transação própria; nada da 110 é gravado assim.
- Resposta × cancelamento: reproduzido com a ordem de travas de `operarContrato` em SQL (contrato e depois fechamento),
  não chamando o serviço de cancelamento inteiro (a formalização real exige assinaturas, sessão, OTP e Festa que
  nenhuma suíte commita).
- PARAR: provado por `suprimirPesquisas` + `clientesDoNumero` (e o serviço do WhatsApp com stub/real nas suítes
  existentes), não por um fluxo completo do webhook.
- Bug achado pela suíte e corrigido na 110: `CASE` com `NEW.envio_id` no gatilho de invariante falhava em
  `satisfacao_envios` (o PL/pgSQL resolve o campo ao planejar); agora ramos `IF` separados.
- Erro de configuração em produção (ex.: origem administrativa ausente) vira 500 genérico na rota pública, sem
  detalhe — falha fechada.

## Rollback

Código: descartar a branch (nada commitado). Banco: a 110 não foi aplicada fora do cluster descartável; o down
`database/rollback/20261030_110_satisfacao_pesquisa_down.sql` existe para quando houver aplicação autorizada.

## Próximos passos

1. Revisão do Astra sobre esta PS-1.
2. Commit só quando Felipe pedir.
3. PS-2 (despacho simulado, lembrete), PS-3, PS-4, PS-5 e PS-6 (expurgo) — a pesquisa não liga em produção sem a PS-6.
