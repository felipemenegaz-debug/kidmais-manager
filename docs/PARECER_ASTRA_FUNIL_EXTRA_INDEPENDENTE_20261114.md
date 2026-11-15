# Parecer independente — Funil, conferência extra restrita

14/11/2026, 19:13 UTC. **APROVADO LOCALMENTE no escopo autorizado: P2-R2-1 encerrado; 0 P1, 0 P2 e nenhum novo P3.**

Revisor: Codex, nesta conversa independente da implementação/correção. O nome deste arquivo segue o pedido dirigido ao Astra; não atribuir a revisão a outro agente/modelo. Esta conversa não implementou nem corrigiu o código. `docs/PARECER_ASTRA_FUNIL_EXTRA_20261114.md` e suas provas da conferência anterior não foram usados como evidência nem como base do veredito. Os testes e controles abaixo foram executados nesta sessão.

Checkout `D:/glass/KidMais Manager/kidmais-manager-funil-oportunidades-20261114`, branch `codex/funil-oportunidades-20261114`, HEAD `2133d398f02f519170b443b5702c6b23b9da41b7`, candidata local sem commit. Escopo: herança de origem/campanha e vínculo sem 409 no mesmo par, com regressões nos três módulos indicados. Nenhum outro achado encerrado, migration, numeração ou rota de resumo foi reaberto. É a conferência extra expressamente autorizada após o teto da classe A; não inicia outra rodada.

## Resultado e referências do código

Não há achado bloqueante ou nova pendência P3 reproduzida neste escopo.

| Contrato conferido | Local da candidata | Prova própria |
|---|---|---|
| Caminhos manual e automático compartilham vínculo/herança | `lib/marketing/contatos.ts:315`, `lib/oportunidades/conversao.ts:25`, `lib/marketing/conversao.ts:7` | Ambos executados no PostgreSQL; sem implementação alternativa da cópia de origem |
| Origem, campanha, canal, detalhe e UTM herdados; primeira origem do cliente preservada | `lib/marketing/conversao.ts:31`, `lib/marketing/atribuicao.ts:110` | Cliente novo e recorrente, origem do cliente GOOGLE e contato INSTAGRAM; dados herdados integralmente com método HERDADO |
| Origem própria da negociação preservada | `lib/marketing/conversao.ts:32`, `lib/marketing/atribuicao.ts:110` | Fotografias completas de todas as atribuições iguais antes/depois nos caminhos manual e automático |
| Mesmo par retorna sucesso sem alterar dados/atribuições | `lib/marketing/conversao.ts:14`, `lib/marketing/conversao.ts:19` | Duas repetições pelo serviço manual após a conversão automática, mais repetição automática: zero INSERT/UPDATE/DELETE e fotografias integrais iguais, incluindo histórico |
| Vínculo diferente, destino de outro cliente/empresa, inexistente e contato sem cliente continuam recusados | `lib/marketing/conversao.ts:9`, `lib/marketing/conversao.ts:12`, `lib/marketing/conversao.ts:15`, `lib/marketing/conversao.ts:26` | 409 para outro vínculo/negociação já ocupada/sem cliente; 404 para tenant, cliente ou negociação inválidos; dados originais preservados |
| Contato convertido, ação, responsável, atribuição e histórico na transação do chamador | `lib/oportunidades/conversao.ts:18`, `lib/oportunidades/conversao.ts:25`, `lib/marketing/conversao.ts:38`; gancho de criação em `lib/fechamentos/services/fechamento.service.ts:200` | COMMIT real nos fluxos válidos. Responsável B herdado quando ausente; A prevalece quando já definido. Falhas injetadas antes de inserir atribuição e antes de inserir histórico propagam e o ROLLBACK restaura as cinco fotografias |
| Relatório associa a nova negociação à campanha do contato | `lib/marketing/metricas.ts:91`, `lib/marketing/atribuicao.ts:86` | `painelMarketing` real retorna uma negociação na campanha INSTAGRAM, tanto para cliente novo quanto recorrente |
| Caminho manual funciona sem a migration122 | `lib/oportunidades/conversao.ts:7` | Suítes canônicas de Marketing executadas no modelo086, inclusive rota real de vínculo repetido com HTTP200 e uma única atribuição |

## Execuções próprias e reprodução

Evidências próprias em `docs/evidencias/funil-extra-independente-20261114/`.

1. **Controle anterior causal:** `provas.mjs` extraiu somente o módulo `lib/oportunidades/conversao.ts` do diff completo histórico R2. A fonte reconstruída confere exatamente com o SHA-256 do manifesto anterior (`5c5727406b4c1388d9022645a15af3555e244d9450b8be4311c60e6b6d5e0ad9`). Executada com PostgreSQL real e dependência real de histórico: contato fica vinculado, mas há zero atribuições FECHAMENTO. Fonte preservada em `conversao-r2-extraida.txt`. Nenhum arquivo da candidata foi revertido ou modificado para esse controle.
2. **Candidata, 9/9 grupos próprios PASS:** o controle anterior mais oito grupos de herança/repetição, origem própria, recusas e atomicidade, descritos na tabela. `provas.log` e `resultado.json`. Os módulos reais são transpilados pelo carregador do projeto; o acesso global ao banco recebe a conexão sintética. Escritores, SQL, histórico e relatório não são simulados. As duas falhas de atomicidade são injeções explícitas no executor; o ROLLBACK é real. A prova cobre a composição na transação, não uma indisponibilidade de infraestrutura.
3. **Runner PostgreSQL canônico: cinco arquivos, 44/44 testes/subtestes PASS, zero skip e zero falha de limpeza:** correcoes-r1-r4 17/17, marketing-a 9/9, origem-negociacao 12/12, oportunidades/atribuicao 2/2, oportunidades/funil 4/4. Modelos086 e 122 construídos do schema vazio pela receita do projeto. Saída `postgres-regressao-autorizada.log`; relatório da guarda `guarda-regressao.json`. Oito ordens de fixture fora do padrão no modelo086 foram registradas pelo runner, sem violação bloqueante; não são nova falha do produto.
4. **Sem banco: 26/26 PASS**, seis arquivos pertinentes de contatos/métricas/rotas, modelo/aplicador/UI do funil (`unitarios.log`). **TypeScript PASS**, `--noEmit --incremental false` (`typescript.log`). `git diff --check` PASS.
5. **Integridade própria:** 56/56 hashes do manifesto vigente e 77/77 hashes do pacote de evidências conferidos. Contra o manifesto anterior: quatro entradas alteradas e seis adicionadas, incluindo os módulos/testes novos; diff rastreado e arquivos novos examinados. Treze arquivos declarados intocados continuam iguais. Fotografias antes/depois de **3.221 arquivos** em app/components/lib/scripts/database: zero alteração, adição ou remoção. `integridade-inicial.json` e `integridade-final.json`. A checagem de integridade não atribui validade aos resultados do implementador.

Comandos principais executados, a partir da raiz deste checkout:

```powershell
node docs/evidencias/funil-extra-independente-20261114/integridade.cjs
node docs/evidencias/funil-extra-independente-20261114/ambiente.cjs inicio
node docs/evidencias/funil-extra-independente-20261114/ambiente.cjs exec postgres-regressao-autorizada.log docs/evidencias/funil-extra-independente-20261114/regressao.cjs
node docs/evidencias/funil-extra-independente-20261114/ambiente.cjs exec restaurar.log docs/evidencias/funil-extra-independente-20261114/restaurar.cjs
node docs/evidencias/funil-extra-independente-20261114/ambiente.cjs exec provas.log --experimental-strip-types docs/evidencias/funil-extra-independente-20261114/provas.mjs
node docs/evidencias/funil-extra-independente-20261114/integridade.cjs fim
node docs/evidencias/funil-extra-independente-20261114/ambiente.cjs limpar
```

`ambiente.cjs` usa ambiente mínimo permitido, sem DATABASE_URL, KIDMAIS_HOMOLOGACAO_DATABASE_URL, PG* ou NODE_OPTIONS herdados; não lê `.env`. O conector e a receita oficiais conferem endereço, porta, banco, papel e cluster antes de escrever. O arquivo `cluster.json` é registro preservado desta execução: uma reprodução exige registro/pasta próprios; o início recusa sobrescrevê-lo.

## Limites, intercorrências e encerramento

- PostgreSQL 18 próprio exclusivamente em `E:/kidmais-pg-descartavel/funil-oportunidades/independente-20261114-14d2a1d6-c2a8-4833-932a-0d8b38b1f9b5`, `127.0.0.1:55834`, papel/cluster `kidmais_descartavel`, banco de trabalho `kidmais_pacotes_v1_descartavel`. Identidade em `identidade.json`. Cluster parado e removido às 19:13:09 UTC; registro em `cluster-limpeza.json`.
- As primeiras tentativas foram bloqueadas pelo DNS/loopback do sandbox; as repetições autorizadas passaram. A massa própria inicialmente omitiu utm_source/utm_medium, meio/vínculo do contato e a nova tomada da trava de agenda após COMMIT. Ajustes feitos **somente nas provas próprias**, com logs/JSON das tentativas preservados como `*-fixture-*`. Essas falhas paravam antes da asserção pretendida e não foram classificadas como defeitos do produto.
- Runtime executado Node 24.20.0/npm11.19.0; Node 22.23.2 declarado não foi executado. Não repeti static completo/build, suíte PG inteira, navegador/formulário completo, carga, concorrência ou bateria de mutantes. O controle anterior foi carregado em memória; a candidata manteve todos os bytes originais. Não há homologação ou publicação decorrente deste parecer.
- Dependências reinstaladas para esta revisão removidas pela rotina oficial, após simulação, com logs preservados; nenhum build ou servidor web criado. Código, Git e evidências anteriores preservados. Somente novo parecer/provas, nota pertinente do Obsidian, índices e relato foram escritos.
- A reconciliação futura com o módulo homônimo da frente de simplificações permanece pendência de integração já conhecida, fora desta conferência. Área da família continua antes do Funil. Nenhum commit, push, PR, acesso a ambiente/banco real ou envio de mensagem foi realizado. Sem nova rodada automática ou autorização operacional inferida.
