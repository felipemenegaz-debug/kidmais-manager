# P1 — Backup antes do lancamento

Status: executado uma vez com autorizacao de Felipe, resultado `BACKUP_CUSTOM_CONFERIDO_SEM_RESTORE`; [evidencia](evidencias/backup-production-codex-20261011.md). Nao autoriza migrations, reparo, restore, deploy ou mudancas de configuracao. As secoes abaixo preservam o pacote autorizado; uma nova execucao exige autorizacao propria.

## Alvo e impacto delimitados

- Workspace `My Workspace`, `tea-daidbj95efls73d2bcf0`.
- Web `srv-dak77m2d0e5s73b8rkkg`; PostgreSQL `dpg-dak750gae00c73fudmg0-a`, banco `kidmais_production`.
- Metadados Render lidos em 11/10/2026: PostgreSQL 18, banco disponivel, acesso externo fechado; web production, auto-deploy OFF, disco `dsk-dakalm142hec739sqrt0`, 1 GB, `/opt/render/project/src/data`.
- Uma sessao Shell de ate 10 minutos, com possivel cobranca pela duracao. Nenhuma conexao externa ao banco; exportacao pela rede privada e TLS conforme configuracao atual.
- Ler no painel Recovery a disponibilidade/janela PITR e registrar a hora UTC, sem clicar em restaurar. PITR deve ter sido conferido ha menos de 24 horas.
- Escrever tres scripts revisados em pasta temporaria exclusiva, com hashes conferidos; nao exige publicar candidata.
- Exportar banco inteiro em formato custom no disco persistente; dados confidenciais (incluindo cadastros e hashes) ficam no dump, nunca em saida, chat, Git ou download local. Pasta 0700, arquivo 0600, nomes exclusivos.
- Consultar somente identidade de banco/TLS e exportar com `default_transaction_read_only=on`. Nao alterar registros, schema, rede, credenciais ou variaveis persistentes.
- Conferir arquivo completo com `pg_restore --file=/dev/null`: descompacta e descarta SQL, nao conecta a destino nem restaura banco. Gerar registro com SHA-256 so se tudo passar.
- Encerrar Shell no fim. Dump, registro e eventuais arquivos parciais ficam preservados; nao repetir automaticamente.

## Precondicoes / parada

1. Identidade Render/producao/banco/host fixos e TLS; flags de cadastro, planos e cotacao por empresa desligadas.
2. Disco efetivamente montado, sem symlink; binarios `pg_dump` e `pg_restore` versao 18 disponiveis. Ausencia/falha → parar, sem instalar ou fazer deploy.
3. PITR disponivel no painel e hora UTC registrada. Nao declarar PITR confirmado com base apenas no campo digitado no comando.
4. Timeout de exportacao/verificacao: ate 4 minutos por subprocesso, respeitando o orcamento total de 9 minutos do script; sessao limitada a 10 minutos. Falha de ferramenta, falta de espaco ou leitura invalida → nenhum registro de sucesso.
5. Nao imprimir erros brutos de libpq, env ou dump. Saida de sucesso apenas resultado/caminho do registro.

## Comando revisavel

Arquivo autossuficiente de transferencia: `docs/evidencias/backup-production-comando-codex-20261011.txt`.
Substituir somente `HORA_UTC_PITR_CONFIRMADA` pela hora real observada no painel (ISO UTC). Os tres scripts transferidos sao o backup, a trava de alvo do diagnostico e as constantes/verificador de migrations; nenhum destes aplica migrations ao ser importado.

O comando verifica SHA-256 dos scripts antes de carregar qualquer um, usa o `pg` ja instalado no web e nao imprime os valores de conexao. Para leitura offline sem conectar: `node scripts/backup-lancamento-production.cjs --plano`.

## Aceite e limites

- Aceite P1: `BACKUP_CUSTOM_CONFERIDO_SEM_RESTORE`, arquivo nao vazio, hash confirmado, leitura integral do custom archive, registro recente no disco persistente e PITR conferido.
- Leitura integral nao prova uma restauracao real nem a recuperacao por PITR. Nao dar baixa nesses aceites. Restaurar dados reais exige pacote e autorizacao proprios em destino isolado (nunca local real nem producao).
- O backup e um requisito para executar o pacote de migrations; nao concede autorizacao para esse pacote.
- Testes locais deste passo usam filesystem/client/subprocessos simulados. Nenhum backup de producao foi gerado na preparacao.

## Autorizacao solicitada

Preparacao validada: 30/30 testes de diagnostico, preflight, migrations e backup; TypeScript; ESLint (zero erros/avisos nos scripts alterados); build de producao com 61 paginas. O comando de transferencia foi compilado sem executar e seus tres arquivos/hashes conferem com as fontes atuais. Nenhum backup real, Shell, dump ou restore foi executado nesta preparacao.

P1 apenas: leitura do painel PITR e uma sessao Shell de ate 10 minutos no web de producao para o comando delimitado acima, incluindo exportacao e escrita de arquivos no disco. Sem migrations, reparo dos bloqueios, restore, deploy, instalacao ou alteracao de configuracao.
