# Consolidação dos aplicadores de produção B-1…B-6 sobre staging (30/10/2026)

Branch `codex/consolidacao-b1-b6-20261030` sobre staging `d89437422b35575e51a247f72aa4d2f6a8b79782` (#273). Junta, numa
árvore só, o backlog técnico do plano de promoção que estava em clones locais sem commit:

| Item | Origem (clone, base) | Conteúdo |
| --- | --- | --- |
| B-1 | aplicador-092-094-production-20261025 (54598a92) | aplicador de produção da 092–094 com escopos 092-093 (E3) e 094 (E6); blocos de produção |
| B-2 | aplicador-099-production-20261025 (54598a92) | aplicador de produção da 099, núcleo comum, check de vínculo/versão, blocos |
| B-3 | aplicador-100-production-20261026 (a590d247) | aplicador de produção da 100 (depois do E6), blocos |
| B-4 | entrega-grupo-a-production-20261026 (a590d247) | entrega dos aplicadores do grupo A antes do código (partes ≤ 40 KB conferidas por sha) |
| B-5 | conferencia-b5-production-20261026 (58c54518) | conferência somente leitura de produção (E1/E2c) e blocos de entrega |
| B-6/B-10 | ci-inventario-b6-b10-20261027 (9ea280ae) | CI com os testes de 090/091/096/097; comentários do inventário de migrations |

Cada item foi aplicado em 3 vias a partir do diff do próprio clone contra a própria base. Os arquivos novos entraram sem
conflito; os demais conflitos vieram de uma só causa, descrita abaixo.

## Conflito com a 107/108 de staging (ad7fbee9, #267/#270)

Depois das bases dos clones, staging recebeu os aplicadores da 107/108. Com eles:

- `scripts/migration-092-094-comum.cjs` confere a integridade da 094 também com o corpo da 108 (`integridade094` lê
  sempre as evidências da 108; com o corpo da 108 exige a prova única e `INTEGRIDADE_094_APOS_108`); corpo desconhecido
  passou a ser recusa nomeada; o 40003 é INDETERMINADO;
- `scripts/migration-100-comum.cjs` carrega `migration-108-evidencias.cjs` já no `require` e reconhece `substituida_108`;
- os blocos de staging da 092–094 e da 100 conferem 7 arquivos a mais (4 módulos da 107/108, o retrato da 108, os
  retratos esperados e `20261029_094_integridade_apos_108.sql`).

Resolução (sem mudar o comportamento de staging):

1. **Núcleo da 092–094**: as duas mudanças juntas — `conferirNoCliente`/`aplicarNoCliente` recebem `prova108` (staging)
   e `escopos`/`escopo` (B-1); o plano lista `INTEGRIDADE_094_APOS_108`; os exports são a união.
2. **Blocos de produção da 092–094 (B-1) e da 100 (B-3)**: as mesmas dependências da 107/108 que staging (sem
   `conexao-staging.cjs`), porque o núcleo confere a integridade da 094 com a prova da 108 e o aplicador lê
   `INTEGRIDADE_094_APOS_108` ao iniciar.
3. **B-4**: a lista continua sendo exatamente a dos blocos de produção do B-1 e do B-2, agora com 28 arquivos em 6
   partes (antes 21 em 3). Gerador inalterado; o teste passa a esperar 28.
4. **B-5**: o pacote leva também os 4 módulos da 107/108 que os núcleos carregam (15 arquivos; antes 11). O B-5 só usa
   `SQL_ESTADO`/`lerEstado`, que não leem os arquivos de dados da 108. Uma 100 com o corpo da 108 em produção apareceria
   como presente (`100:substituida_108`).
5. **Testes de produção do B-1 e do B-3**: o cliente simulado responde à consulta de evidências da 108 ("sem 108") e,
   no B-1, devolve por padrão o corpo da 094 na regra de conflito — o mesmo desenho das suítes de staging desde a
   ad7fbee9; as listas esperadas de arquivos, hashes e corpos ganham os itens da 108.
6. **CI**: os passos de B-1, B-2, B-3, B-4, B-5 e B-6 somados aos de staging.

B-1, B-3, B-4 e B-5 deixam de ser byte a byte o que o Astra aprovou nos clones de origem; a consolidação pede revisão
focal antes do merge. Nada foi aplicado em banco; nenhum deploy.

Docs do B-4 e do B-5 atualizados só nas contagens (B-4: 28 arquivos em 6 partes; B-5: 15 arquivos em 8 partes).

## Validação local (30/10/2026, sem banco e sem Shell real)

- CI local: os 47 passos `run:` do `ci.yml` (menos `npm ci`, já feito) com o Node 22.23.2 do CI, código 0 em todos —
  inclui regressão estática, lint, TypeScript e build.
- Suíte do B-4 32/32; bateria completa do B-4 no clone consolidado (cópia da r12 com o clone novo, mesmas 41 âncoras):
  `BATERIA_OK` — controle 32/32, 40 mutantes derrubados por asserção, manifestos válidos, gerador inalterado por sha.
- Blocos gerados com o rótulo `d894374`: B-4 6 partes (16,0 a 28,4 KB) + 5 curtos (5,6 a 7,5 KB); B-5 8 partes
  (15,1 a 28,8 KB) + 3 curtos.
- Clone de origem do B-4 intacto (composição do índice `2c020b00…`).

## Revisão focal do Astra — APROVADO COM RESSALVAS (1 P3) e correção C-F1 (LOCAL, sem commit, 30/10/2026)

**C-F1 (P3):** os testes de produção do B-1 e do B-3 respondiam sempre "sem 108"; uma regressão no encaminhamento da
prova/escopo passaria nessas suítes e falharia num production que já tenha a 108. Correção só nos dois testes (código
dos aplicadores inalterado): o cliente simulado aceita evidências e linha da prova (desenho das suítes de staging), e 3
testes novos em cada suíte passam pelo adaptador de produção (`prod.principal`):

- 108 íntegra: E6 (`--conferir-094`, `--aplicar-094-autorizado`) e a global dão `PASS_CORPO_108` com a prova em READ ONLY
  (`search_path = pg_catalog`) antes da integridade após a 108, sem escrita; E3 recusa pela 094 presente. Na 100:
  `JA_APLICADA_SUBSTITUIDA_108` em conferir e aplicar, sem inventário, migration, postcheck nem integridade após a 100
  (inclusive sem dono/CREATE) — **a 100 nunca é reaplicada sobre a 108**;
- 108 não íntegra, parcial e corpo desconhecido: RECUSARIA (código 3) / FALHA (código 2), prova só com o corpo da 108,
  nenhuma integridade e nenhuma escrita;
- F2 não medido recusa sem consultar a prova; o override de retratos de teste (válido ou ilegível) é sempre recusado em
  produção — prova de que o env do serviço chega à prova e de que produção nunca aceita o override.

Prova: suítes de produção 28/28 (eram 22); 12 mutantes só de produção (prova sem env, override aceito, prova perdida
por escopo na conferência e na aplicação, prova recusada ignorada, corpo desconhecido aceito, 108 parcial ignorada, a 100
fora do caminho `substituida_108`, evidências omitidas) passam nas suítes antigas e nas de staging (41/41) e caem só nas
novas, por asserção; CI local 47/47 com o Node 22.23.2.
