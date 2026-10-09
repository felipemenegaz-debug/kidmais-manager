# Pré-requisito do cron: migrations 074/075 em staging

Execução autorizada por Felipe em resposta ao plano ("Próximo passo"). Migrations de planos e renovação aplicadas em staging em 09/10/2026. Produção não alterada.

## Resultado da execução

Backup lógico Render concluído às 03:23 BRT, com retenção mínima informada de 7 dias; recuperação pontual de 3 dias disponível. Restore não executado. O deploy paralelo de convites foi aguardado até ficar live no commit 1be816798603daa9a5af0126c62f47cff7a4cad9; esta operação não disparou deploy.

A entrega de convites já ocupava 074 e os nomes dos checks. Renomeamos os arquivos de planos para **074a**, mantendo literalmente o SQL (mesmo SHA-256), os nomes das funções e a autorização original. O código comercial do commit em execução não divergia da base revisada; o precheck confirmou o legado UNICO e a guarda 068 esperada.

Prechecks, aplicação e postchecks de 074a/075 passaram. Comparação agregada de todos os campos anteriores confirmou preservação integral da única assinatura existente. TLS ativo. Health HTTP 200 com banco, festa e OTP disponíveis. Cinco testes locais das migrations e ESLint passaram.

Evidência: [resultado sanitizado](evidencias/assinatura-migrations-staging-20261009.json). O cron permanece não criado; retomada depende de publicação e revisão da candidata compatível, preservando a autorização anterior.

## Alvo e mudança

Workspace `tea-daidbj95efls73d2bcf0`; banco Render `kidmais-staging`, ID `dpg-daidko3m8hqs73ce4jt0-a`, database `kidmais_staging_1z91`, host privado `dpg-daidko3m8hqs73ce4jt0-a`, porta 5432. A inspeção somente de leitura confirmou ausência das quatro tabelas 074/075. Produção e banco local real não fazem parte desta operação.

Arquivos preparados e já testados em schema sintético completo:

- `database/migrations/20261009_074a_planos_comerciais.sql`: tabelas de isenção, Fundador e contratação; coluna/vínculo da contratação atual na assinatura; ampliação da guarda comercial, mantendo o legado.
- `database/migrations/20261009_075_renovacao_fundador.sql`: registro durável e guardas da renovação Fundador.
- Prechecks e postchecks correspondentes em `database/checks/`; rollbacks condicionais em `database/rollback/`.

## Plano autorizado e executado

1. Revalidar alvo e estado do deploy; fixar e revisar os hashes dos arquivos. Confirmar disponibilidade de backup recuperável de staging, método e permissões antes de qualquer DDL. Se backup/restore não estiver verificável, parar. Não usar backup de produção nem imprimir dados do dump. Backup inclui dados de staging e deve permanecer protegido em armazenamento autorizado.
2. Conferir privilégios do papel e executar precheck 074, incluindo assinatura da função 068 e compatibilidade do plano legado. Esse precheck inspeciona condições agregadas dos registros sem exibir dados pessoais. Divergência exige revisão; não desativar a guarda para forçar instalação.
3. Aplicar 074 em sua transação, conferir postcheck; executar precheck 075, aplicar 075 em sua transação e conferir postcheck. Respeitar lock_timeout de 5s: conflito aborta a etapa; não repetir nem interromper conexões de terceiros automaticamente.
4. Conferir metadados e preservação das condições legadas, sem alterar cadastro/isencão da Kidmais real por CNPJ autodeclarado. As migrations não inserem automaticamente a isenção nem criam cobranças.
5. Retomar o plano do cron já autorizado somente após código candidato compatível revisado/publicado e validação de conexão TLS e credenciais exclusivas sandbox. Não alterar o serviço web nesta operação; se sua compatibilidade exigir deploy coordenado, apresentar o commit e obter autorização específica antes do DDL.

## Falhas e recuperação

Falha dentro de uma migration reverte sua própria transação. Se 074 confirmar e 075 falhar, não habilitar cron/checkout: registrar estado parcial e diagnosticar. Rollbacks 075/074 só são tecnicamente permitidos sem uso dos novos históricos; nunca apagar registros para satisfazer as guardas. Priorizar correção progressiva após uso. Restore, exclusão de dados ou rollback destrutivo não estão incluídos nesta proposta e exigem decisão específica.

## Escopo da autorização recebida

Autorizados backup protegido, prechecks agregados, aplicação 074a/075 e postchecks exclusivamente no banco staging identificado, condicionados à compatibilidade do código e disponibilidade de recuperação. A [política operacional](OPERACAO_AGENTES.md) exige autorização explícita para migrations; a autorização já dada para o cron continua válida e não será solicitada novamente.
