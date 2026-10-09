# Retomada preparada — autorização pendente

A rodada autorizada com empresa `63304a1f-78c5-4aa6-99ad-2ca8778e4648` parou antes do checkout: o script esperava SOMENTE_LEITURA, mas a fixture tinha trial encerrado há 1 dia. Staging configura ASSINATURA_SOMENTE_LEITURA_DIAS=1; a fronteira já resulta BLOQUEADO. Não é falha de chave ou de pagamento.

As duas chaves autenticaram; catálogo conferido; login/seleção da empresa funcionaram. Nenhum cliente, assinatura, pagamento ou webhook foi criado no Asaas por esta rodada. Acesso fictício desativado: usuário inativo, membership REVOGADA, empresa DESATIVADA. Hash das condições comerciais preexistentes conferido e preservado. O histórico não foi apagado.

DESATIVADA e REVOGADA são terminais. A autorização anterior limitava a escrita aos IDs daquela fixture; não autoriza novos IDs. A retomada precisa de aprovação explícita conforme [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md), seção STAGING: “A permissão de testar não autoriza migrations, SQL de escrita”.

## Plano concreto para aprovação

Repetir as ações e a recuperação do [plano original](TESTE_ASSINATURA_PUBLICADA_20261009.md) nos mesmos serviços staging e mesmo Asaas sandbox, com somente os novos IDs abaixo. Validar que são inexistentes antes de escrever; nenhuma reativação da fixture encerrada.

- Empresa `764067e5-c512-4dcb-bc52-601cfdf0de36`, nome `TESTE Kidmais — assinatura staging 20261009`.
- Usuário `7cfaa928-7ee1-40c4-8d20-43d022169b27`, e-mail `assinatura-staging-7cfaa928@example.invalid`.
- Documento sintético novo, único e diferente do buffet real. Senha somente em memória, hash no banco.
- Trial encerrado há 1 hora, dentro da janela vigente de leitura de 1 dia. Nenhuma alteração de prazo, banco ou regra comercial.
- Essencial mensal, regular 19700 centavos; se elegível Fundador, 11820. Conferir a oferta antes do checkout.
- Revalidar as chaves, conferir o cliente pelo cron antes de simular pagamento, verificar callback/acesso/Fundador/duplicações e cancelar somente a assinatura fictícia.
- Desativar somente esta fixture, remover somente webhook temporário da rodada, preservar condições preexistentes e restaurar flag/comando.

O adaptador agora informa a etapa sanitizada em caso de falha e exige a opção `--rodada-2-autorizada`. Não executar essa opção sem aprovação deste plano. Script/diagnóstico preparados; publicar código não autoriza execução.

## Recuperação concluída

Flag ASSINATURA_PLANOS_ATIVOS removida e ausência confirmada no runtime após deploy `dep-db4ajim7bikc73e4mc4g`, commit `c502711`. Health final PASS. Cron com comando normal e modo APLICAR, deploy `dep-db4ahk7lk1mc73fdlfpg`: manual concluída às 08:45:41 UTC e agendada às 08:50:28 UTC, incompleto=false. Houve falha agendada às 08:45:18 UTC sem logs de aplicação, durante a janela de recuperação; as rodadas seguintes confirmam a recuperação. Não inferir a causa dessa interrupção.

Sete testes pertinentes, ESLint, TypeScript e build isolado sem credenciais aprovados. Rodada 2 não executada. [Evidência sanitizada](evidencias/assinatura-publicada-rodada1-20261009.json) e [cron recuperado](evidencias/assinatura-publicada-cron-recuperado-20261009.png).
