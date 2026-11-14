# Correção única P2-R2-1 — 14/11/2026

Somente LOCAL, por autorização explícita de Felipe para uma revisão extra restrita a origem/campanha, idempotência e regressão em conversão/atribuição. Parecer R2 preservado. Sem commit/push/PR/operação real. Estado: implementado; revisão extra pendente.

## Mudança

- `lib/marketing/conversao.ts:7`: extraído o bloco existente de vinculação de contatos.ts para `vincularContatoNegociacao`, sem segunda implementação da herança. Mantém validação empresa/cliente, vínculo exclusivo, origem/campanha/canal/detalhe/UTM, escritor `registrarSeAusente` e histórico. Mesmo par validado retorna sucesso antes de qualquer escrita; outro fechamento continua409.
- `lib/marketing/contatos.ts:315`: caminho manual delega ao código comum e depois transfere ações como antes.
- `lib/oportunidades/conversao.ts:25`: substituído UPDATE isolado por chamada ao mesmo vínculo/herança. Usa o mesmo executor/transação da criação e transferência; qualquer erro propaga ao chamador. Responsável e histórico da ação mantidos.
- `lib/marketing/marketing-a.postgres.test.ts:154`: expectativa antiga409 atualizada para200 com contagem de atribuição única, conforme decisão de produto.
- `lib/oportunidades/atribuicao.postgres.test.ts`: regressões novo/recorrente, origem/campanha, vínculo, ação, responsável, repetição e painel real de metricas.ts; registro do teste no modelo122 da seleção. SQL/migration122, rota de resumo e demais funções fora do escopo intactos.

O arquivo marketing/conversao.ts mencionado no pedido não existia neste checkout; existia na frente de simplificações. Sua leitura confirmou que também delegava ao vínculo de contatos.ts. Aqui apenas extraímos esse bloco comum; não importamos a conversão automática, SAVEPOINT ou outras mudanças daquela frente. Na integração, reconciliar as duas versões do módulo mantendo uma única herança.

## Provas

- `antes.log`: os dois testes PG falham antes da correção porque a atribuição da negociação é undefined.
- `pg-final.log`: regressões novas2/2, funil original4/4, origem-negociação12/12 e correções Marketing17/17 passam. Marketing A inicialmente falhou por esperar409 no mesmo vínculo; após atualizar somente essa expectativa, `marketing-final.log` passa9/9. Resultado final: cinco arquivos PG aprovados,44 testes/subtestes. Não é a suíte PG inteira do repositório.
- `unitarios.log`:26/26 PASS, incluindo funil inteiro (modelo/aplicador/UI) e contatos/métricas/rotas de Marketing.
- As regressões criam fechamento com fixture comercial válida e chamam o gancho real da criação; não simulam o formulário completo. Comparam a fotografia de todas as atribuições antes/depois: linhas anteriores preservadas, repetição sem UPDATE/duplicação; painelMarketing conta1 negociação na campanha certa para cliente novo e recorrente.
- PostgreSQL18 descartável exclusivamente em E:/kidmais-pg-descartavel/funil-oportunidades,55814. Todos os comandos de aplicação/testes com `env -u DATABASE_URL -u KIDMAIS_HOMOLOGACAO_DATABASE_URL`; nenhum banco real, e-mail ou navegador. Cluster parado/apagado após provas; `cluster-limpeza.json`.

## Falhas intermediárias

Fixture inicial usou substituiId em vez de corrigeId, parou409 antes de exercer o defeito; corrigida no teste e repetida antes de alterar implementação (`fixture-inicial.log`). Uma tentativa de seleção PG por prefixo foi recusada pelo runner, que exige nomes exatos (`depois.log`); corrigido o comando. O teste legado que esperava409 foi atualizado para a nova regra idempotente. Avisos da guarda de escritores em testes Marketing do modelo086 (anterior à114) foram registrados pelo runner, sem reprovação; nenhuma guarda de produto foi alterada.

Runtime Node24.20.0/npm11.19.0; Node22.23.2 declarado não executado. Nenhuma prova de carga/concorrência nova ou envio real. Revisão extra deve distinguir estas provas do implementador de execução própria.

## Static final

check:v1:static completo, saída0: 5.017/5.017 testes,103/103 harness, lint0 erros/4 avisos existentes, TypeScript/build/worker PDF PASS (static.log).

Limpeza desta correção concluída pela rotina oficial: node_modules/.next removidos (0,73 GB); cluster já apagado. A primeira simulação não conseguiu listar processos no sandbox; repetição autorizada com acesso à listagem passou. Código, Git, evidências e vault preservados.
