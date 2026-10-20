# Ensaio do reparo e migrations do lancamento — 11/10/2026

Resultado: PASS local, com dados sinteticos. Nenhuma conexao externa, leitura de banco real, push, deploy ou alteracao de producao.

## Destino e encerramento

- PostgreSQL 18.6; cluster `kidmais_descartavel`, usuario `kidmais_descartavel`, somente `127.0.0.1:55498`.
- Cluster novo `.local-descartavel-pg-6fe04818b19f4b72927f2ca0103feb15`, identidade `CONFERE`, inicialmente sem bancos.
- Modelo 063 construido do schema vazio e inventario canonico; banco de trabalho `kidmais_pacotes_v1_descartavel`, atualizado ate 074 com os checks do inventario.
- Configuracoes de conexao herdadas retiradas somente do processo do ensaio, sem ler seus valores. Nenhuma credencial real carregada.
- Cluster encerrado no `finally`, resultado `PARADO`, processo finalizado com codigo 0; porta 55498 sem listener na conferencia posterior. Pastas anteriores e novas preservadas.
- Primeira tentativa no sandbox criou `.local-descartavel-pg-cd356c176ec940b7b38b017954a96053`, mas recebeu EPERM antes de iniciar. Pasta preservada. Reexecucao autorizada fora do sandbox criou o cluster novo acima.
- Registro detalhado sanitizado preservado em `<pasta do cluster>/ensaio-lancamento.json` (ignorado pelo Git).

## Reparo dos cinco bloqueios

O ensaio insere os cinco IDs/datas do pacote com conteudo sintetico. Para a execucao positiva, substitui somente o nome do banco pelo banco de trabalho e o UUID da Kidmais pelo UUID da fixture. O SQL versionado de producao permanece intacto, com alvo fixo.

| Caso | Resultado |
|---|---|
| SQL original de producao em banco local | Recusado `BANCO_RECUSADO` |
| SQL adaptado sem flag de autorizacao | Recusado `REPARO_NAO_AUTORIZADO`; zero resolucoes |
| Um horario final divergente (22h) | Recusado; zero resolucoes e nenhum reparo parcial |
| Cinco bloqueios corretos | Cinco resolucoes e cinco bloqueios vinculados a Kidmais inteira; ativos, sem unidade |
| Preservacao | Todos os campos iguais antes/depois, exceto empresa_id e atualizado_em |
| Segunda aplicacao | Recusada; conexao encerrada sem transacao pendente |

## Migrations

- Os 18 arquivos de precheck/migration/postcheck conferem com os hashes fixados no manifesto.
- Aplicador executou 074a, 075, 076, 077, 078 e 079, cada uma em transacao unica incluindo precheck e postcheck: seis `APLICADA_POSTCHECK_PASS`.
- Segunda verificacao: seis `JA_APLICADA_POSTCHECK_PASS`; apenas postcheck em transacao somente leitura, sem reaplicar SQL de migration.
- Falha injetada no postcheck da 074a provocou rollback integral: tabela planos_comerciais ausente depois da falha; conexao utilizavel. Em seguida, a aplicacao correta passou.
- IDs, codigos e nomes do catalogo permaneceram iguais. Kidmais terminou com zero assinaturas.
- A dependencia injetada de identidade local existe somente na chamada interna do ensaio. A CLI de producao usa a verificacao padrao de banco fixo e TLS, sem opcao para troca de alvo.

## Validacoes adicionais e limites

- Suítes do diagnostico, preflight e aplicador: **21/21**, incluindo 10 testes do aplicador (alvo/TLS, hashes, rollback, dependencia, somente leitura e recusa de backup fora do disco).
- TypeScript (`tsc --noEmit`), ESLint nos tres scripts (zero erros e avisos), build de producao (61 paginas) e `git diff --check`: PASS.
- Este ensaio nao comprova backup real, recuperacao PITR, capacidade fiscal do Asaas nem envio real de cadastro. Esses itens continuam pendentes.
- A CLI exige registro de backup recente, PITR recente, dump nao vazio com hash confirmado e disco montado. O caminho positivo dessa verificacao ainda exige validacao no ambiente autorizado; nao foi simulado como se fosse um backup real.
- Marcador exclusivo por migration impede repeticao automatica apos interrupcao ou resposta de COMMIT incerta. Nessa situacao, parar e conferir por leitura; nunca remover marcador e repetir automaticamente.

Executar novamente exige autorizacao para novo cluster sintetico e a flag `--ensaio-local-autorizado`. Este registro nao autoriza escrita em producao.
