# Pacotes V1 — status de engenharia

Documento temporário de continuidade. Não é fonte funcional. A decisão de produto permanece no Second Brain e no Goal Mestre.

## Objetivo

Entregar o Módulo Administrativo de Pacotes V1 com proteção histórica append-only, isolamento por empresa e administração de preços, sem comprometer fechamentos, contratos, preços ou documentos históricos.

## Branch

`fix/v1-snapshot-comercial`

Upstream removido de propósito. A branch nasceu de `origin/staging` e não deve receber push para `staging` nem `main`.

## Base SHA

`c54a809169b825e5dde25cac1385602bafa3faf3`

Confirmado após `git fetch origin` em 2026-09-26. `origin/staging` não avançou em relação ao Goal (`c54a809`, 2026-09-24, merge do PR #8).

## HEAD atual

`c54a809169b825e5dde25cac1385602bafa3faf3` no início do Marco 0, antes do commit de caracterização.

## Marco atual

Marco 0 — caracterização. Prechecks concluídos. Testes de caracterização em execução. Nenhuma migration nova.

## Marcos concluídos

Nenhum.

## Decisões aplicadas

- Base: `origin/staging` em `c54a809`. Não partir de `origin/main` nem de `review/v1-perfil-empresa`.
- Não reutilizar migration 020 nem 026–028.
- Migrations novas, quando existirem, começam em `20260926_029`.
- Empresas: tabela vazia no shape da 020, sem copiar o arquivo e sem inserir a Kidmais. Associação dos sete pacotes atuais permanece HG-6.
- Working tree estava limpa em `v1/usuarios-acessos-layout` (`8e28b81`) antes do checkout.

## Migrations criadas

Nenhuma.

Sequência real em `origin/staging`: `001`–`006`, `006a`, `999`, `007`–`019`, `021`–`025`. Sem `020`, `026`, `027` ou `028`.

## Testes executados

Sem banco e sem `.env.local`, em 2026-09-26:

- `lib/comercial/caracterizacao-comercial-v1.test.ts` — 6 passaram
- `lib/comercial/pacotes-v1.test.ts` — 3 passaram
- `lib/comercial/pizza-party.test.ts` — 4 passaram
- `lib/fechamentos/convidados.test.ts` — 5 passaram
- `lib/festas/buffet.test.ts` — 3 passaram
- `lib/contratos/services/snapshot-core.test.ts` — 4 passaram
- `lib/contratos/documento/documento-core.test.ts` — 36 passaram
- `lib/comercial/condicao-pagamento.test.ts` — 22 passaram

Total da suíte combinada antes do ajuste final: 77 passaram e o arquivo novo falhou ao importar o serviço de edição. Depois de caracterizar a lista pelo fonte, o arquivo novo passou com 6 testes. Nenhum comportamento de produção foi alterado.

## Resultados

Precheck: fetch ok; staging inalterado em `c54a809`; árvore limpa; sequência `001`–`025` sem `020`/`026`–`028`; branch criada sem upstream. Caracterização congelou o comportamento atual, incluindo a divergência da salada na migration 023.

## Riscos

- A branch chegou a rastrear `origin/staging` no `checkout -b`. O upstream foi removido antes de qualquer push.
- Migration 023 marca `SALADA_PREMIUM` como INCLUSO só no Premium. A lista hardcoded de `adicionaisIncluidos` trata combos da Completa como inclusos, enquanto a 023 os marca `INDISPONIVEL`. Caracterizado, não corrigido.
- `duracao_minutos` do seed está vazio. A prosa da UI não é histórico persistido.

## Próximos passos

Concluir e registrar os testes do Marco 0. Commit. Em seguida Marco 1: `fechamento_pacote_snapshots` e `fechamento_pacote_composicao`, somente em banco local descartável.

## Human Gates pendentes

- HG-6: não associar os sete pacotes atuais a uma empresa sem identidade comprovável.
- HG-8 registrado e decidido: `empresas` vazia será criada no Marco 5; a 020 precisará ser reajustada depois. Não executar a 020.
- HG-1, HG-2, HG-3, HG-4, HG-5 e HG-7: não acionados.

## Arquivos principais alterados

- `lib/comercial/caracterizacao-comercial-v1.test.ts`
- `docs/work/PACOTES-V1-STATUS.md`
