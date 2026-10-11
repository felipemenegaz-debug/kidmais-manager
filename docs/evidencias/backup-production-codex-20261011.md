# P1 — Backup de producao executado em 11/10/2026

Autorizacao: Felipe respondeu `autorizo` ao pacote P1 (PITR + uma sessao Shell de ate 10 minutos, sem migrations, reparo, restore ou deploy). Pacote preparado no commit `d2ac19c`.

## PITR e alvo

- Painel Recovery do PostgreSQL `dpg-dak750gae00c73fudmg0-a`, banco `kidmais_production`, workspace My Workspace.
- PITR disponivel, janela **3 dias**, conferido em **2026-10-11T09:17:05Z**. Nenhum botao de restore/export do painel acionado.
- Shell do web `srv-dak77m2d0e5s73b8rkkg`, instancia `m6jzq`, prompt de `~/project/src`.
- Script conferiu Render/producao, host/banco exatos, TLS, disco montado, flags de abertura desligadas e binarios PostgreSQL 18 antes da exportacao.

## Execucao e resultado

- Comando autossuficiente revisado, com tres fontes/hash conferidos, executado **uma vez**, substituindo apenas a hora PITR do placeholder. Nao houve repeticao, instalacao ou deploy.
- `pg_dump` custom, com conexao somente leitura; `pg_restore --file=/dev/null` leu o arquivo inteiro sem banco de destino. Resultado **BACKUP_CUSTOM_CONFERIDO_SEM_RESTORE**.
- Registro conferido depois por leitura apenas de metadados de arquivo: **REGISTRO_BACKUP_CONFERIDO**.

| Campo | Valor |
|---|---|
| Arquivo | `/opt/render/project/src/data/lancamento-venda-20261011/backup-eac358bd-fab7-4ff3-b0b9-23a86d4913bc.dump` |
| Registro | mesmo diretorio, `backup-eac358bd-fab7-4ff3-b0b9-23a86d4913bc.json` |
| Criado em | `2026-10-11T09:18:07.394Z` |
| Tamanho | **9.799.207 bytes** |
| SHA-256 | `36921d91662e8027f06b1e739471f96e3e85dcc46fb201914c54be7706ebd8fd` |
| Leitura integral | `true` |
| Permissoes dump / registro | `600` / `600` |
| Restauracao real comprovada | **false** |

Dump e registro permanecem exclusivamente no disco persistente de producao. Nao foram baixados nem incluidos no Git; nenhuma credencial ou conteudo do dump foi impresso. A captura [backup-production-20261011.png](backup-production-20261011.png) mostra apenas o comando de conferencia de metadados, seu resultado e o contexto do Shell.

## Encerramento e limites

- Abas Shell e Recovery fechadas apos a conferencia, dentro da janela de 10 minutos; inventario do navegador confirmou que ficou apenas a aba preexistente do Resend.
- Nenhum dado de negocio/schema, configuracao, segredo, rede ou deploy foi alterado. Escritas limitadas aos scripts temporarios e aos arquivos de backup autorizados.
- P1 concluido quanto a exportacao/conferencia do arquivo e PITR disponivel. Nao comprova restore real nem autoriza o cutover.
- O verificador exige backup e PITR com menos de 24 horas; a validade mais curta deste registro termina em `2026-10-12T09:17:05Z`. Se a publicacao ocorrer depois, ou se precisar de um snapshot novo para a janela, preparar nova exportacao autorizada; nao repetir esta automaticamente.
- Continuam pendentes as entregas reais de staging, dados fiscais/legais e a autorizacao especifica de publicacao/migrations/reparo.
