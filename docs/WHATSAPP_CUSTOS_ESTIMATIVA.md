# Atendimento WhatsApp — estimativa de custos

Preparada em 04/10/2026. Estimativa para decisão, não orçamento contratado. Valores em US$. Desde 01/07/2026 a Meta fatura em BRL para clientes elegíveis no Brasil; converter pela cotação da fatura.

## Fontes e confiança

| Item | Valor usado | Fonte | Confiança |
| --- | --- | --- | --- |
| Mensagem recebida do cliente (Meta) | Grátis | [Preços da plataforma do WhatsApp Business](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), página "Updated: 30 de set de 2026", lida em 04/10/2026: a Meta não cobra pelas mensagens do usuário para a empresa | Oficial |
| Resposta de serviço (texto livre na janela de 24 h) | **1.000 grátis por mês por número comercial**; a partir da 1.001ª, cobrada | Mesma página: "a partir da meia-noite [...] em 1º de outubro de 2026. A Meta retomou a cobrança pelas mensagens de serviço" | Oficial |
| Preço da resposta de serviço no Brasil, acima da franquia | US$ 0,0068 por mensagem | Mesma página: exemplo oficial de 10 mil respostas a usuários no Brasil, "US$ 0,68 ¢ por mensagem", com base na taxa atual de utilidade e autenticação do Brasil. A tabela CSV oficial não foi baixada | Oficial (exemplo da Meta); **conferir na tabela** |
| Taxa do Gupshup | US$ 0,001 por mensagem, **enviada e recebida** | Só fontes de terceiros. A página oficial de preços do Gupshup não abriu (404) e os artigos de suporte não puderam ser lidos (403) | **Não confirmada.** Conferir no painel ou contrato do app `KidmaisManager` |
| Modelo da IA (ECONOMY em staging: `gpt-6-luna`) | US$ 0,10 por 1M tokens de entrada, US$ 0,01 em cache, US$ 0,50 de saída | [Modelo](https://developers.openai.com/api/docs/models/gpt-6-luna) e [preços OpenAI](https://developers.openai.com/api/docs/pricing), 04/10/2026; mesmo valor registrado em `docs/IA_CONVERSA_ADAPTATIVA.md` em 01/10/2026 | Oficial |
| Worker | US$ 0 na homologação (máquina do Felipe). Render Background Worker Starter: cerca de US$ 7/mês, só de referência | Terceiros; a tabela oficial do Render não foi extraída | Referência; **nenhum serviço será criado nesta etapa** |
| Processador | Roda dentro do serviço web já existente | — | Sem custo adicional estimado |
| OTP | Já existe (templates de autenticação). O atendimento não envia templates | — | Fora desta estimativa |

## Consumo de IA por mensagem do cliente

Uma chamada de classificação por entrada de texto. Rajadas na mesma conversa geram uma chamada. Comandos diretos ("atendente", "PARAR") e mídia não chamam o modelo.

| Parte | Tamanho típico | Teto |
| --- | --- | --- |
| Entrada: instrução, até 30 perguntas publicadas, até 8 mensagens da sessão e schema | cerca de 1.000 a 1.500 tokens | cerca de 4.000 tokens (30 perguntas longas e 8 mensagens longas) |
| Saída: JSON de classificação | cerca de 40 a 80 tokens | 250 tokens (`maxTokensSaida`) |
| **Custo por chamada** | **cerca de US$ 0,00015** | **cerca de US$ 0,0005** |

O orçamento do sistema (`AI_BUDGET_JSON`, capacidade `whatsapp_atendimento`) reserva de forma conservadora (1 token por byte) e recusa a chamada acima do teto. A conversa vai então para a equipe com o texto fixo.

## Cenários mensais (um número comercial)

**Premissas por conversa:**
- 4 mensagens do cliente e 3 respostas (automáticas ou humanas pela tela);
- 3 chamadas de modelo.

Tudo é ajustável. A franquia de 1.000 respostas de serviço por mês vale para **todas** as respostas de serviço do número, inclusive as humanas.

| Conversas/mês | Respostas (serviço) | Meta | Gupshup (não confirmado) | IA (típico / teto) | Total aproximado |
| --- | --- | --- | --- | --- | --- |
| 100 | 300 | US$ 0 (dentro da franquia) | 700 × 0,001 = US$ 0,70 | US$ 0,05 / 0,15 | **cerca de US$ 0,75 a 0,85** |
| 500 | 1.500 | 500 × 0,0068 = US$ 3,40 | 3.500 × 0,001 = US$ 3,50 | US$ 0,23 / 0,75 | **cerca de US$ 7 a 8** |
| 2.000 | 6.000 | 5.000 × 0,0068 = US$ 34,00 | 14.000 × 0,001 = US$ 14,00 | US$ 0,90 / 3,00 | **cerca de US$ 49 a 51** |

**Fórmula:**

```text
Meta = max(0, respostas − 1000) × 0,0068
Gupshup = (mensagens recebidas + respostas) × taxa_gupshup
IA = chamadas × custo_por_chamada
```

O limite de respostas automáticas por conversa (padrão 20 em 24 h) põe um teto por conversa. Na tarifa acima da franquia, cerca de US$ 0,14 de Meta, mais Gupshup e IA.

## Fora da estimativa

- Templates (o atendimento não os usa; mensagens proativas estão fora da V1).
- Meta Business Agent (produto da Meta, não usado).
- Tempo da equipe.

## A confirmar antes da produção

1. Tarifa de serviço do Brasil na tabela oficial da Meta (CSV em BRL ou USD da mesma página).
2. Taxa e forma de cobrança do Gupshup para o app `KidmaisManager`: por mensagem, se inclui recebidas, e mensalidade.
3. Volume real de conversas e mensagens por conversa, medido na homologação (H8) e no início da operação.
