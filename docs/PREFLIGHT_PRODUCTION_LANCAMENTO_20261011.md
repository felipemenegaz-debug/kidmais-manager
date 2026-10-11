# P0b — revisão do impacto em produção

**Preparado, não executado.** Complementa o P0 aprovado e concluído. Não concede isenção, muda cobrança, publica código, altera TLS/rede ou aplica migrations.

## Alvo e comando

Uma única sessão Web Shell de até cinco minutos no serviço `srv-dak77m2d0e5s73b8rkkg`, banco privado `kidmais_production`, host `dpg-dak750gae00c73fudmg0-a`, porta 5432, TLS do serviço. A sessão pode ser cobrada por duração.

Comando exato: [preflight-production-comando-codex-20261011.txt](evidencias/preflight-production-comando-codex-20261011.txt). Copia somente a ferramenta autossuficiente para `/tmp`, verifica SHA-256 `40206690e1076daee8f33b688a6d8b0993b2191b6f855d80e4fd767f450883a5` e executa a flag única `--preflight-somente-leitura`. Não executar esse comando no PowerShell local.

O script usa o `pg` instalado no serviço atual; não depende do deploy da candidata. Exige banco correto, TLS e empresa Kidmais ativa com o ID identificado em P0. Todas as etapas usam transação READ ONLY, timeout de dez segundos por comando e ROLLBACK final. Uma falha interrompe as etapas seguintes e encerra a sessão, sem repetir.

## Leituras

1. Até vinte bloqueios globais ativos futuros: ID, data, período, códigos de empresas vinculadas ao autor e decisão já registrada, se houver. Não lê motivo, nome/e-mail/ID do autor ou dados de clientes. Vínculos do autor são indícios e não autorizam atribuição automática.
2. Empresas que receberiam cópias na 078, com contagens das categorias utilizadas e indicação de item sem categoria; mesma consulta de uso do precheck existente.
3. Prechecks revisados de 074a, 076, 077, 078 e 079. Sem valores de CPF ou dados de clientes; 076 retorna somente contagens. O precheck 075 depende da 074a aplicada e não roda nesta leitura.

Os arquivos SQL foram embutidos exatamente no script. Testes offline confirmam igualdade com a fonte, alvo/TLS, interrupção ao falhar e ROLLBACK. P0/P0b: 11/11. Esses testes não substituem a leitura autorizada do banco real.

## Preparação das migrations

[Manifesto dos 18 arquivos](MIGRATIONS_PRODUCTION_LANCAMENTO_20261011.json): precheck, migration e postcheck de 074a, 075, 076, 077, 078 e 079, com SHA-256 normalizado (CRLF para LF), alvo e ordem. É inventário revisável; **não é um aplicador autorizado**.

Depois da leitura, apresentar a lista de bloqueios/cópias para decisão de Felipe e finalizar o aplicador de produção, backup/PITR e janela. Não usar aplicadores de staging em produção. A leitura P0b não autoriza nenhuma escrita posterior.

## Motivo da autorização específica

`docs/OPERACAO_AGENTES.md`: “Acesso direto a banco deve estar explicitamente no escopo e ter o destino validado”. P0 contou os bloqueios e identificou objetos; P0b lê registros delimitados e as dependências do schema. Por isso requer autorização própria para essa sessão.
