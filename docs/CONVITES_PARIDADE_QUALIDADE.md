# Qualidade do convite completo

O editor publicado oferece as mesmas opções do laboratório aprovado: Alta (`high`), Muito alta (`xhigh`, padrão) e Máxima (`max`). O seletor aparece para buffet e cliente quando o convite completo está disponível. Qualidade maior pode aumentar custo e tempo; o teto interno continua sendo de reservas, não um limite garantido de cobrança do provedor.

A API aceita somente essas três qualidades, exclusivamente para convite completo. Pedidos antigos sem o campo continuam usando `xhigh`. O modelo, a resolução e as referências de estilo continuam definidos pelo servidor.

A qualidade integra a identidade do pedido. Repetir a mesma chave não envia uma segunda chamada; reutilizar a chave com outra qualidade é recusado. O padrão `xhigh` preserva o hash e a assinatura anteriores, inclusive para pedidos iniciados antes desta atualização. Não há migração nem alteração de variáveis.

Os testes do serviço cobrem buffet e cliente, as três opções, consumo único, repetição, conflito de qualidade, compatibilidade do hash anterior e rejeição de valores inválidos antes da reserva.

Na conferência visual, abrir um convite existente e conferir o seletor ao lado de Estilo. Alternar entre as três opções sem clicar em gerar. A validação da interface não requer chamada paga.

Os controles experimentais de provedor, ComfyUI e geração separada de avatar permanecem exclusivos do laboratório. Os recursos publicados de compartilhamento, cotas e recuperação de geração continuam preservados.
