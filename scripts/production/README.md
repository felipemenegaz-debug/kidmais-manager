# Verificações de preparação Render

Somente leitura. Não carregam `.env` nem `.env.local`. Recebem variáveis já injetadas no processo; não cole secrets na linha de comando. Não há comandos de deploy, migration ou alteração de infraestrutura. Execute da raiz do clone.

Os scripts usam ES modules (`.mjs`, `import`/`export`) no Node.js 22.23.2 definido pelo projeto, compatíveis com o ESLint padrão, sem exceções de lint. Importar um módulo não executa sua CLI. O driver `pg` é importado dinamicamente somente no caminho de conexão explícita, após validar destino e TLS; os testes injetam um cliente falso sem abrir conexão. Os comandos npm e o contrato JSON permanecem iguais.

| Comando | Escopo |
| --- | --- |
| `npm run production:check` | Ambiente, URL do banco e arquivos SQL locais; NO-GO sem evidências e smoke |
| `npm run production:check:json` | Mesmo agregado em JSON; use `npm run --silent production:check:json` para stdout exclusivamente JSON |
| `node scripts/production/check-env.mjs --json` | Configuração injetada, sem imprimir valores |
| `node scripts/production/check-database-target.mjs --json` | Analisa URL, sem conexão |
| `node scripts/production/check-migrations.mjs --json` | Inventário 001–018, incluindo 006a; exclui rollback 999 |
| `node scripts/production/smoke-test.mjs --base-url=https://servico.example --json` | GET `/api/health`, sem redirects, limite 64 KiB e timeout 10 s |
| `npm run --silent production:check:json -- --base-url=https://servico.example --evidence=registro.json` | Agrega verificações e atestação operacional |
| `npm run production:test` | Testes isolados com env sintético e fetch simulado; zero rede/banco |

Cada CLI aceita `--json`. A saída usa **`schemaVersion: 2`** (mudança de contrato), com `check`, `status`, `blockers`, `unknown`, `pending`, `reported`, `evidence` e `ok`. Consumidores da versão 1 precisam considerar `unknown`, além de `blockers`. Código 1 indica falha comprovada, evidência obrigatória desconhecida ou argumento inválido; 0 indica check aprovado (inclui GO-PARCIAL no agregado). `ok: false` sozinho não significa configuração errada. Erros não imprimem exceções, respostas HTTP nem configuração. Argumentos desconhecidos/duplicados falham. A saída não imprime sequer hostname/username, evitando exposição por campos maliciosos. URLs PostgreSQL com query/fragment são recusadas para impedir overrides de conexão/TLS; use as variáveis SSL dedicadas.

## Origem e estado das evidências

- **LOCAL:** configuração disponível no processo. Variável ausente produz `UNKNOWN` e `LOCAL:<VARIAVEL>_NOT_AVAILABLE`. O estado real no Render não foi verificado. Valor presente que viole uma regra produz `FAIL_VERIFIED` no escopo local, sem afirmar que essa configuração esteja implantada remotamente.
- **REPOSITORY (REPOSITÓRIO):** inventário de arquivos e código. `PASS` no inventário comprova apenas os arquivos exigidos, nunca aplicação no destino.
- **OPERATIONAL (OPERACIONAL):** relatos externos e, quando expressamente autorizado, observações do destino. Relato validado recebe `PASS_REPORTED` e `directlyVerified: false`; não equivale a verificação direta.

O `status` de cada check é `FAIL_VERIFIED` quando há problema comprovado, `UNKNOWN` quando faltam evidências obrigatórias e `PASS` quando o check direto passa. Relatos individuais usam `PASS_REPORTED`. O agregado mantém categorias separadas: `blockers` (falhas comprovadas), `unknown` (evidências não verificadas), `pending` (pendências não bloqueadoras do escopo técnico) e `reported` (fatos externos confirmados). Falhas e lacunas podem coexistir; o status resumido prioriza falhas. `UNKNOWN` obrigatório mantém NO-GO para operação real.

O agregado lê somente o bloco `production-operational-report` do handoff principal. Há um contrato restrito para a rotação: versão 1, production, gate `credentialRotation`, confirmação externa explícita, banco e usuário esperados, e os sete fatos booleanos verdadeiros. Bloco ausente, inválido, incompleto ou duplicado não produz relato aprovado. Campos livres nunca são emitidos. Esse bloco registra o relato autorizado do responsável; não preenche automaticamente a atestação de prontidão atual nem executa conexão. A rotação concluída permanece `PASS_REPORTED` mesmo quando falta atestação atual vinculada ao ambiente/commit. Essa lacuna pede revisão da evidência atual, **não repetir a rotação**.

Sem `--base-url`, o agregado registra saúde `UNKNOWN` sem requisição HTTP. Sem `--connect`/`--inspect-db`, não abre conexão. O inventário deixa o estado aplicado explicitamente desconhecido; a exigência de evidência atual de migrations aparece em `unknown` no agregado. Uma falha de transporte não comprova configuração errada; resposta HTTP 503 realmente observada continua sendo falha comprovada.

`--connect` no verificador de destino e `--inspect-db` no inventário são opt-in independentes, nunca usados pelo agregado. Exigem destino permitido, TLS conforme a política abaixo e a dependência `pg` já declarada. Estabelecem sessão `default_transaction_read_only=on`, com timeouts, consultam identidade e contagem de tabelas; param no erro. Não executam SQL de arquivos ou postchecks. Inspeção não comprova aplicação de migrations: exige revisão externa dos pré-requisitos, histórico, estrutura e postchecks aprovados. **014: o postcheck antigo pode produzir falso negativo em schema evoluído; não concluir corrupção nem reaplicar SQL por esse resultado.**

## Evidência operacional

Arquivo JSON de atestação revisada por responsável, sem secrets. Não é prova obtida pelo script nem assinatura criptográfica. Campos obrigatórios: `schemaVersion` (1), `environment` (`staging` ou `production`), `commit` (SHA completo atual), `origin` (origem HTTPS do smoke), `database` (nome do banco), `verifiedAt` (ISO UTC de até 24 horas, sem data futura). Deve ser reemitido após mudanças no ambiente; correspondência de commit não detecta alterações remotas de configuração.

Os seguintes campos precisam ser booleanos `true`, com registros comprobatórios revisados pelo operador: `migrationsThrough019`, `credentialRotation`, `secretsExclusive`, `persistentDisk`, `https`, `backupRestore`, `adminSmoke`, `regression`, `monitoring`, `operationalAcceptance`. Não preencher automaticamente a partir do handoff. A rotação da credencial comprometida de production e exclusividade dos secrets são condições reais, não comprovadas por presença de variáveis. `whatsappDelivery: true` exige validação real da integração/recebimento controlado, além de OTP ready no smoke. Não registrar dados de clientes nesse arquivo.

NO-GO: bloqueador técnico, segurança crítica ou evidência obrigatória ausente/incerta, incluindo migrations; consultar as categorias separadas para distinguir a causa. GO-PARCIAL: os quatro checks diretos presentes e aprovados, atestações atuais completas, WhatsApp pendente. GO: inclui recebimento WhatsApp validado externamente. PASS_REPORTED isolado não libera operação nem elimina falhas/lacunas dos checks. Nenhum GO autoriza deploy, tráfego ou escrita. `released` e `blocked` explicitam o escopo; próximos passos de preparação podem ser planejados mesmo com NO-GO.

Staging aceita HTTP 200 degraded apenas com OTP explicitamente desabilitado nas duas variáveis previstas no código. HTTP 503 sempre bloqueia o smoke, inclusive quando a causa possível é OTP. A rota atual omite componentes no 503: o script não pode atribuir sua causa. Isso não impede preparar banco, secrets, migrations, disco e HTTPS mediante aprovação. OTP ausente é pendência separada no check-env; `console` ou `disabled` fora do staging autorizado são incoerências. Health ready comprova configuração, não entrega.

## Política TLS

Production sempre exige `DATABASE_SSL=true`. O valor `false` continua sendo `FAIL_VERIFIED` (`PRODUCTION_TLS_REQUIRED`); ausência permanece `UNKNOWN`.

A URL já validada classifica o destino sem imprimir seus campos: `RENDER_INTERNAL` somente para o hostname curto que corresponda integralmente a `dpg-` + 20 caracteres alfanuméricos + `-` + uma letra; `EXTERNAL` para nomes com domínio ou endereços IP; `UNKNOWN` nos demais casos. A classificação não consulta DNS e não comprova rede privada ou região. Um hostname com domínio, ponto final, sufixo adicional ou formato interno não reconhecido não recebe a exceção. Novos formatos devem ser revisados explicitamente.

Para production com destino permitido classificado como `RENDER_INTERNAL`, `DATABASE_SSL_REJECT_UNAUTHORIZED=false` é aceito com TLS obrigatório, acomodando o certificado autoassinado do cenário interno informado pelo operador. Isso mantém criptografia, mas não autentica o servidor pela cadeia CA; o uso efetivo da rede interna e da mesma região continua sendo evidência operacional externa. A exceção não aprova o GO por si só. A saída registra a política como evidência LOCAL, com estado remoto não verificado.

Para `EXTERNAL`, desativar a validação do certificado produz `FAIL_VERIFIED` (`PRODUCTION_CERTIFICATE_VERIFICATION_REQUIRED`). Para `UNKNOWN`, produz `UNKNOWN` obrigatório (`TLS_INTERNAL_DESTINATION_NOT_VERIFIED`), mantendo NO-GO. URL inválida ou banco proibido continuam bloqueados. A leitura opcional usa a mesma exceção e recusa configuração indeterminada antes de carregar `pg`. Staging mantém a exigência anterior de certificado validado nessa leitura.

`NODE_VERSION` segue o pin 22.23.2 do projeto, não identifica o runtime remoto. Os scripts não verificam DNS privado, privilégios do usuário, força/rotação real de secrets, Render ou fluxos administrativos autenticados. O único smoke implementado é o health. Estado local do código, resultados dos scripts e relatos externos permanecem separados.
