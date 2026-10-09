# Rodada 3 preparada — autorização pendente

A rodada 2 aprovada por Felipe parou antes do checkout, na validação do webhook existente. A listagem e a consulta individual retornaram HTTP 200 e não incluíram authToken; o script comparou esse campo ausente ao token do site e interrompeu indevidamente. Isso não prova que o token existente seja incorreto. Oferta confirmada: SOMENTE_LEITURA, Essencial mensal 19700 centavos, Fundador elegível 11820. Nenhum cliente, assinatura, pagamento ou webhook foi criado no Asaas pela rodada 2. A fixture foi encerrada e o agregado comercial anterior preservado.

Correção: consultar metadata antes de qualquer INSERT da fixture. Se o token retornado for conhecido e compatível, reutilizar. Quando a API não o devolver, criar somente um callback temporário com o token do próprio web, conforme o plano original; não alterar o callback existente. Conferir metadata do callback criado e removê-lo ao concluir. Testes cobrem token ausente e reutilização sem mutações. [Documentação oficial de tokens](https://docs.asaas.com/changelog/obrigatoriedade-e-auto-gera%C3%A7%C3%A3o-de-tokens-para-webhooks).

## Plano para aprovação

Repetir o [ensaio original](TESTE_ASSINATURA_PUBLICADA_20261009.md), exclusivamente no web `srv-daif418ae00c73e8k2gg`, cron `crn-db493i142hec73ahmoe0`, banco `kidmais_staging_1z91` e Asaas sandbox, com a nova fixture:

- Empresa `e4b274ca-3a51-40c5-bef6-39012a96cfbc`, nome `TESTE Kidmais — assinatura staging 20261009`.
- Usuário `067a7b63-7588-4897-b66b-a93f9fdbd56e`, e-mail `assinatura-staging-067a7b63@example.invalid`.
- Documento sintético único, diferente de 20119900000160; senha em memória e hash no banco.
- Trial encerrado há 1 hora. Preservar a janela existente de 1 dia; nenhum ajuste comercial.
- Conferir oferta Essencial/Fundador, cliente encontrado pelo cron antes de confirmar pagamento sandbox, callback, acesso COMPLETO e idempotência.
- Cancelar somente a assinatura fictícia, preservar período simulado como pago, desativar somente esta fixture, remover somente o callback temporário criado nesta rodada e restaurar flag/comando. Conferir condições comerciais preexistentes.

As duas fixtures anteriores permanecerão encerradas, com seu histórico. Não há migration, restore, cobrança real ou alteração de produção nesta proposta. A opção `--rodada-3-autorizada` não deve ser executada antes da aprovação.

A autorização anterior limitava SQL de escrita aos IDs da rodada 2. [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md) exige aprovação explícita para novos dados; por isso a execução dessa terceira fixture aguarda Felipe.

## Prontidão da candidata

Nove testes pertinentes, ESLint, TypeScript e build isolado sem credenciais aprovados. Web recuperado com health PASS e flag temporária ausente no runtime. Cron normal APLICAR concluído às 09:10:31 UTC, incompleto=false. [Evidência da recuperação](evidencias/assinatura-publicada-rodada2-20261009.json). A correção está preparada para publicação em staging, sem deploy automático; esta proposta não foi executada.
