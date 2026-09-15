# Verificações de preparação Render

Somente leitura. Não carregam `.env` nem `.env.local`. Recebem variáveis já injetadas no processo; não cole secrets na linha de comando. Não há comandos de deploy, migration ou alteração de infraestrutura. Execute da raiz do clone.

| Comando | Escopo |
| --- | --- |
| `npm run production:check` | Ambiente, URL do banco e arquivos SQL locais; NO-GO sem evidências e smoke |
| `npm run production:check:json` | Mesmo agregado em JSON; use `npm run --silent production:check:json` para stdout exclusivamente JSON |
| `node scripts/production/check-env.cjs --json` | Configuração injetada, sem imprimir valores |
| `node scripts/production/check-database-target.cjs --json` | Analisa URL, sem conexão |
| `node scripts/production/check-migrations.cjs --json` | Inventário 001–018, incluindo 006a; exclui rollback 999 |
| `node scripts/production/smoke-test.cjs --base-url=https://servico.example --json` | GET `/api/health`, sem redirects, limite 64 KiB e timeout 10 s |
| `npm run --silent production:check:json -- --base-url=https://servico.example --evidence=registro.json` | Agrega verificações e atestação operacional |
| `npm run production:test` | Testes isolados com env sintético e fetch simulado; zero rede/banco |

Cada CLI aceita `--json`: `schemaVersion: 1`, `check`, `blockers`, `pending`, `evidence`, `ok`. Código 1 indica bloqueador ou argumento inválido; 0 indica verificação aprovada (inclui GO-PARCIAL). Erros não imprimem exceções, respostas HTTP nem configuração. Argumentos desconhecidos/duplicados falham. A saída não imprime sequer hostname/username, evitando exposição por campos maliciosos. URLs PostgreSQL com query/fragment são recusadas para impedir overrides de conexão/TLS; use as variáveis SSL dedicadas.

`--connect` no verificador de destino e `--inspect-db` no inventário são opt-in independentes, nunca usados pelo agregado. Exigem destino permitido, TLS com certificado validado e a dependência `pg` já declarada. Estabelecem sessão `default_transaction_read_only=on`, com timeouts, consultam identidade e contagem de tabelas; param no erro. Não executam SQL de arquivos ou postchecks. Inspeção não comprova aplicação de migrations: exige revisão externa dos pré-requisitos, histórico, estrutura e postchecks aprovados. **014: o postcheck antigo pode produzir falso negativo em schema evoluído; não concluir corrupção nem reaplicar SQL por esse resultado.**

## Evidência operacional

Arquivo JSON de atestação revisada por responsável, sem secrets. Não é prova obtida pelo script nem assinatura criptográfica. Campos obrigatórios: `schemaVersion` (1), `environment` (`staging` ou `production`), `commit` (SHA completo atual), `origin` (origem HTTPS do smoke), `database` (nome do banco), `verifiedAt` (ISO UTC de até 24 horas, sem data futura). Deve ser reemitido após mudanças no ambiente; correspondência de commit não detecta alterações remotas de configuração.

Os seguintes campos precisam ser booleanos `true`, com registros comprobatórios revisados pelo operador: `migrationsThrough018`, `credentialRotation`, `secretsExclusive`, `persistentDisk`, `https`, `backupRestore`, `adminSmoke`, `regression`, `monitoring`, `operationalAcceptance`. Não preencher automaticamente a partir do handoff. A rotação da credencial comprometida de production e exclusividade dos secrets são condições reais, não comprovadas por presença de variáveis. `whatsappDelivery: true` exige validação real da integração/recebimento controlado, além de OTP ready no smoke. Não registrar dados de clientes nesse arquivo.

NO-GO: bloqueador técnico, segurança crítica ou evidência ausente/incerta, incluindo migrations. GO-PARCIAL: verificações técnicas e atestações completas, WhatsApp pendente. GO: inclui recebimento WhatsApp validado externamente. Nenhum GO autoriza deploy, tráfego ou escrita. `released` e `blocked` explicitam o escopo; próximos passos de preparação podem ser planejados mesmo com NO-GO.

Staging aceita HTTP 200 degraded apenas com OTP explicitamente desabilitado nas duas variáveis previstas no código. HTTP 503 sempre bloqueia o smoke, inclusive quando a causa possível é OTP. A rota atual omite componentes no 503: o script não pode atribuir sua causa. Isso não impede preparar banco, secrets, migrations, disco e HTTPS mediante aprovação. OTP ausente é pendência separada no check-env; `console` ou `disabled` fora do staging autorizado são incoerências. Health ready comprova configuração, não entrega.

Política conservadora: production exige SSL e validação de certificado; ambientes que dependam de conexão privada sem TLS exigem revisão desta política antes de qualquer flexibilização. `NODE_VERSION` segue o pin 22.23.2 do projeto, não identifica o runtime remoto. Os scripts não verificam DNS privado, privilégios do usuário, força/rotação real de secrets, Render ou fluxos administrativos autenticados. O único smoke implementado é o health. Estado local do código, resultados dos scripts e relatos externos permanecem separados.
