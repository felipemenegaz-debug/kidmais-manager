# Correção da R1 — 14/11/2026 — somente LOCAL

Estado: quatro achados corrigidos e provas do implementador aprovadas; **aguarda Astra R2, última rodada classe A**. Base `2133d398f02f519170b443b5702c6b23b9da41b7`, mesmo clone/branch, sem commit/push/PR/operação real. P3-3/P3-4 do pedido correspondem a P3-1/P3-2 do parecer histórico.

## Mudanças por achado

| Achado | Arquivo/linha | Comportamento corrigido |
| --- | --- | --- |
| P2-1 | `lib/oportunidades/consultas.ts:9`, `service.ts:38`, `lib/marketing/contatos.ts:286` | Contato sem vínculo próprio continua visível/editável/descartável mesmo com fechamento histórico do cliente. Motivo obrigatório preservado. |
| P2-1, herança | `lib/oportunidades/conversao.ts:9`, `:24` | Vínculo explícito seleciona aquele contato. Na criação, a ação mais recente identifica um contato e grava seu vínculo com a negociação. Não encerra outras oportunidades independentes do cliente. |
| P2-2 | `lib/oportunidades/conversao.ts:17`, `:25` | Sem responsável no fechamento: herda B; com A: ação transferida para A. Histórico conserva responsáveis da ação/negociação anteriores e o final. |
| P2-2, consumidores | `lib/oportunidades/consultas.ts:17`, `:23`, `:38`; `resumo.ts:19` | Fechamento define cartão/filtro/Para hoje/e-mail e os contadores que já usavam o fechamento. Ação antiga divergente não muda a pessoa da oportunidade. |
| P3-3 | `app/api/admin/oportunidades/route.ts:19`; `components/admin/oportunidades/Oportunidades.tsx:17`, `:20`, `:25`, `:34`, `:41` | GET informa edição conforme capacidade comprovada. Leitor não recebe botões nem janelas de edição. Guarda POST intacta e recusa403 coberta no PG. |
| P3-4 | `lib/oportunidades/resumo.ts:11`, `:35` | Nome lido na empresa comprovada, assunto/cabeçalho com nome e HTML escapado. Chave por empresa/usuário/dia preservada. |

Migration122 (SQL/checks/down/hashes/aplicadores), inventário/receita/exportação, script diário e **rota de resumo** continuam byte a byte iguais ao manifesto anterior. Nenhuma mudança da ordem 123→122, que pertence à futura integração, com Área da família antes do Funil.

## Reprodução e resultados

1. Antes de alterar a implementação, acrescentados os três casos PG em `lib/oportunidades/funil.postgres.test.ts:13`: cliente com CONFIRMADO antigo + contato novo, B→negociação sem responsável e B→negociação de A. [Log antes](postgres-antes.log): os três falham nos defeitos corretos, respectivamente contato oculto, fechamento NULL e ação ainda B. O ciclo original passa. O [teste de UI antes](ui-antes.log) falha no botão Novo contato indevido para leitor.
2. [PostgreSQL final](postgres-final.log): **4/4 grupos PASS**, sem skip, modelo122 com receita completa e pre/postchecks, mais guarda de escritores sem ordem inválida e encerramento sem falhas. Todos os cenários anteriores e o ciclo inteiro do funil. Novo contato recorrente agenda/perde com motivo, descarte pelo serviço antigo, outro retorno converte em negociação nova com vínculo explícito e fechamento histórico preservado. Os dois cenários de responsáveis conferem cartão/ação/filtro/Para hoje, histórico, e-mail simulado, fechadas e perdidas para a mesma pessoa, inclusive ação divergente. Outra ação de contato do mesmo cliente continua aberta. Leitor GET permitido e POST403. Não é a suíte PG inteira do repositório.
3. [Suíte unitária inteira do funil e UI](funil-unitarios.log): **6/6 PASS** (modelo3, aplicador1, UI2). Leitor não tem quatro controles de edição; editor continua tendo. E-mail inclui empresa no assunto/cabeçalho, escapa cliente/empresa no HTML e conserva chave; flag desligada não consulta/envia.
4. [`npm run check:v1:static` inteiro](static-final.log): **5.017/5.017 + 103/103**, lint 0 erros (4 avisos preexistentes), TypeScript, build e worker PDF PASS. Runtime **Node24.20.0/npm11.19.0**; projeto declara Node22.23.2, não repetido nele.

Comando da suíte PG: `env -u DATABASE_URL -u KIDMAIS_HOMOLOGACAO_DATABASE_URL KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel KIDMAIS_DESCARTAVEL_PORTA=55814 KIDMAIS_DESCARTAVEL_AUTORIZACAO=127.0.0.1:55814/kidmais_pacotes_v1_descartavel KIDMAIS_POSTGRES_SOMENTE=lib/oportunidades/funil.postgres.test.ts npm run check:v1:postgres`. Unitários/static/npm ci/demo também lançados com as duas variáveis removidas. Nenhum `.env*` real lido. Cluster novo PostgreSQL18 em `E:/kidmais-pg-descartavel/funil-oportunidades`, porta55814; não foram usadas5432/5433.

## Navegador localhost:3794, somente dados fictícios

- [Cartões e Para hoje](01-p2-cartoes.jpg): contato com festa antiga aparece; as duas negociações convertidas exibem B herdado e A prevalecendo. [Filtro B](02-p2-filtro-b.jpg): só retorno/B herdado. Conversões montadas pelo serviço real no seed sintético; não são conversões clicadas na interface.
- [Próxima ação salva](03-retorno-acao-salva.jpg): retorno alterado pela interface de Ligar para WhatsApp; [perda com Preço](05-retorno-perda.jpg) aceita e contabilizada, com CONFIRMADO antigo intacto, conferido em [resultados PG da demo](demo-resultados.json).
- [Leitor sem edição](04-leitor-sem-edicao.jpg): login próprio com somente MARKETING_VISUALIZAR; três ações do dia e três cartões, nenhum Novo contato/Feito/próxima ação/perda. Asserção sobre botões reais do DOM e AX preservados ao lado das capturas. Atualizar, filtros e links de leitura continuam.
- [Negociação de A perdida](06-p2-perda-a.jpg): perda Outro pela interface, filtroA mostra1 perdida. Depois, filtroB observado com1 fechada e1 perdida (a do retorno). **A confirmação de B foi montada por fixture SQL**, respeitando trava de agenda; não é prova da contratação completa pela interface. A suíte PG testa fechada/perdida em ambos os cenários.
- Capturas apenas do conteúdo da aba da demo, sem desktop/outras janelas. Seed/fixture reproduzíveis preservados como `.cjs.txt`; não contêm credencial real. E-mail desativado, automações desligadas, transporte simulado; [autoverificação](demo-ambiente.json).

## Falhas intermediárias e limites

- As quatro regressões falham antes como esperado; logs preservados, não são falhas atuais.
- Primeiro static passou5.017+103 mas parou no lint: nove erros `no-require-imports` no artefato CJS da revisão AstraR1. Original preservado em `provas-r1-original.cjs.txt`; foi acrescentada só uma anotação ESLint de formato CommonJS em `docs/evidencias/astra-funil-r1/provas.cjs:1`, sem mudar a prova. Segundo static completo PASS. O relatório/resultado histórico da R1 não foi reescrito nem executado como teste da correção.
- Primeira montagem da confirmação sintética de B recusada por falta de trava de agenda; transação revertida, sem escrita. Script auxiliar corrigido para usar `travarConfiguracaoAgenda`, repetição PASS. [Tentativa recusada](demo-resultados-tentativa1.log).
- Ao encerrar a demo, taskkill terminou a árvore, mas a checagem imediata de bind ainda indicou porta ocupada e o helper saiu com erro. A reconferência posterior mostrou3794 livre emIPv4/IPv6 e nenhum processo da aplicação; o registro de processos foi encerrado após essa prova. [Conferência final](demo-porta-final.json). Nenhum servidor foi reiniciado.
- Nenhuma prova obrigatória falhando no encerramento. Sem envio real, carga, nova bateria de mutantes ou validação independente nesta correção. As provas positivas não autorizam publicação. Revisor precisa distinguir evidência lida de execução própria.

## Encerramento

Servidor3794 encerrado/porta livre; PostgreSQL parado e diretório apagado ([registro](cluster-limpeza.json),130.464.256 bytes). Dependências/builds desta tarefa removidos pela rotina oficial após simulação:0,73GB principal+0,23GB demo, além do cluster; logs de limpeza preservados. O build isolado `.next-festa-manual` foi movido para `.next` (caminhos absolutos verificados) e passou por nova simulação/aplicação da rotina, que reconhece esse nome. Clone, código, Git, capturas, relatórios e vault mantidos para a última revisão; retomar exige `npm ci` e build. Nenhum artefato de outra tarefa foi removido.

Manifesto atualizado inclui os arquivos novos; `manifesto-anterior.json` permite conferir o delta. `diff-completo.patch` reúne diff rastreado e arquivos novos de código/documentação do manifesto. `sha256.json` confere evidências atuais e as anteriores; não inclui seu próprio hash. Documentação técnica, nota existente do vault e fila atualizadas; um relato resumido acrescentado a `orquestracao/relatos.md`. Próximo: usar `docs/PEDIDO_ASTRA_FUNIL_20261114_R2.md`, sem terceira rodada automática.
