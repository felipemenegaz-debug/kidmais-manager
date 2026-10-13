# P0 — produção, 11/10/2026

Autorização de Felipe: P0 somente leitura via Render MCP, com uma sessão Shell de até cinco minutos se necessário. Serviço `srv-dak77m2d0e5s73b8rkkg`; banco `kidmais_production`.

MCP recusou a conexão porque a lista de IPs externos do banco está vazia. Nenhuma mudança de rede realizada. Executado uma vez no Web Shell o comando autossuficiente preparado, SHA-256 `6606c08e58d01c633e6b55d65683156585f069f2d4c5d96ccfee80f2b7d5615a`; conferência do arquivo retornou OK. Resultado `DIAGNOSTICO`, banco correto, TLS verdadeiro. Transação somente leitura encerrada com ROLLBACK; Shell fechado após ler a saída. Nenhuma migration, configuração ou cobrança alterada.

## Resultado

- Objetos de 062, 063, 064, 066–074 presentes.
- Objetos de **074a, 075, 076, 077, 078 e 079 ausentes**. A presença de objetos não substitui os prechecks e postchecks de cada migration.
- Uma empresa `kidmais`, ativa, ID `7e990a2b-e64b-4630-9aae-4646fe936ede`; zero assinaturas da empresa e zero assinaturas no banco. Sem 074a, não se consultaram as tabelas de contratação, Fundador ou isenção, que ainda não existem.
- **Cinco bloqueios globais ativos futuros**, sem empresa. Não foram editados nem apagados. O novo cadastro público recusa enquanto existirem: preparar identificação e atribuição comprovada antes da abertura.
- Variáveis de cobrança, planos, cadastro, e-mail e identificação comercial listadas pelo diagnóstico estão ausentes. `AGENDA_PUBLICA_EMPRESA_ID` e `CONVITES_ENABLED` presentes; valores não lidos para a saída.

## Próxima sequência

1. Preparar e revisar aplicadores de produção para as seis migrations ausentes, com hashes, alvo fixo, backup e pre/postchecks.
2. Preparar leitura da lista de cópias do catálogo 078 e identificação dos cinco bloqueios. Não atribuir os bloqueios por suposição; não apagar.
3. Concluir e-mail real e pagamentos sandbox em staging, textos comerciais/legais e configuração fiscal.
4. Autorizar a operação de produção concreta, depois de backup/PITR e homologação. Cadastro público deve ser a última configuração ligada.

Staging já publicou `5386a4df36b8b8b7cb649bc15d17e48e6b853b90`, descendente da candidata Codex `d5d930f`. Deploy `dep-db5kk17avr4c73950kq0` LIVE; health, `/conheca` e `/planos` retornaram 200. Isso comprova publicação e leitura, não cadastro real nem pagamento sandbox.
