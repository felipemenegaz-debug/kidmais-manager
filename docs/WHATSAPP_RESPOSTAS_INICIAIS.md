# Atendimento WhatsApp — respostas iniciais para aprovação

Preparado em 04/10/2026. **Proposta: nada foi alterado no código.** Os textos atuais estão em `lib/whatsapp/atendimento/core.ts` (`responder`, `MENSAGEM_ENCAMINHAMENTO`). Depois da aprovação, a troca é local: textos e testes, com gates.

## Regras dos textos fixos

- Não citar preço, desconto, disponibilidade, prazo, condição comercial nem cláusula. Isso só aparece nas **respostas publicadas** pela empresa, cadastradas na tela.
- Não prometer horário de retorno nem atendimento imediato ("agora"): o atendimento humano não tem horário configurado na V1.
- Não sugerir "atendente" a quem pediu PARAR: o bloqueio não é desfeito por nenhuma mensagem do contato.
- Sempre deixar claro quando a conversa foi encaminhada a uma pessoa e como pedir um atendente.
- Data nunca é "reservada" nem "disponível": só registrada como interesse.
- Frases curtas, sem emoji, tratamento por "você". O nome da empresa vem da configuração (`{empresa}`).

## Textos atuais e propostas

| # | Situação (gatilho no código) | Texto atual | Proposta | Motivo |
| --- | --- | --- | --- | --- |
| 1 | **Apresentação:** mensagem sem pergunta reconhecida (`OUTRO`) | Sou o atendimento virtual da {empresa}. Posso ajudar com as informações publicadas e encaminhar sua festa para a equipe. Para falar com uma pessoa, escreva “atendente”. | Olá! Sou o atendimento virtual da {empresa}. Posso responder dúvidas sobre a casa e registrar a data e o número de convidados da sua festa para a equipe. Para falar com uma pessoa, escreva “atendente”. | Diz o que o assistente faz, sem prometer valores ou datas |
| 2 | **Dúvida sem resposta publicada** (`DUVIDA` sem correspondência; a conversa vai para a equipe) | (usa o texto 1) | Não tenho essa informação nas respostas publicadas. Encaminhei sua pergunta para a equipe da {empresa}, que vai continuar o atendimento por aqui. | **Lacuna comprovada:** hoje a conversa vai para a equipe, mas o cliente recebe a apresentação e não sabe que foi encaminhado |
| 3 | **Qualificação, falta a data** (`INTERESSE`) | Qual é a data desejada para a festa? Informe também o ano. | Qual é a data desejada para a festa? Informe dia, mês e ano. | Pede a data completa de forma explícita |
| 4 | **Qualificação, falta o número de convidados** | Quantas pessoas você pretende convidar? | Quantos convidados você espera, contando adultos e crianças? | Evita contar só crianças. **Decisão:** a empresa quer separar adultos e crianças? A V1 guarda um único número |
| 5 | **Data inexistente** | Essa data não existe no calendário. Qual é a data completa da festa, incluindo o ano? | (manter) | — |
| 6 | **Data passada** | Essa data já passou. Qual é a data desejada para a festa, incluindo o ano? | (manter) | — |
| 7 | **Qualificação concluída** (vai para a equipe) | Registrei seu interesse para {data} e {n} pessoas. Vou encaminhar para a equipe conferir disponibilidade, pacote e valores. A data ainda não está reservada. | Anotei seu interesse para {data}, com {n} convidados. A equipe da {empresa} vai conferir a disponibilidade e enviar as opções de pacote. **A data ainda não está reservada.** | Mantém o aviso de não reserva; não promete prazo |
| 8 | **Pedido de atendente, reclamação, negociação ou pagamento** (`HUMANO`) | Vou encaminhar seu pedido para um atendente. A resposta dependerá do horário da equipe. | Certo, encaminhei sua conversa para a equipe da {empresa}. Uma pessoa vai continuar o atendimento por aqui assim que possível. | Confirma o encaminhamento sem prometer horário |
| 9 | **Falha da IA, orçamento ou limite** (`MENSAGEM_ENCAMINHAMENTO`) | Não consigo responder automaticamente agora. Encaminhei sua mensagem para a equipe; a resposta dependerá do horário de atendimento. | Não consigo responder automaticamente agora. Encaminhei sua mensagem para a equipe da {empresa}, que vai continuar o atendimento por aqui. | Hoje é uma constante: a regra de revogação o reconhece por igualdade e o deixa sair mesmo depois de a configuração mudar. Incluir o nome da empresa exige ajustar essa regra. **Decisão:** manter sem o nome (recomendado)? |
| 10 | **Mídia, áudio ou mensagem longa** (vai para a equipe sem modelo) | (nada é enviado) | Recebi seu arquivo. Ainda não consigo analisar esse tipo de conteúdo; encaminhei para a equipe da {empresa}. | Hoje o cliente fica sem retorno. **Decisão:** responder ou só encaminhar em silêncio? |
| 11 | **PARAR** (opt-out) | (nada é enviado; contato bloqueado) | Pronto: você não vai mais receber mensagens da {empresa} por aqui. | **Decisão:** confirmar ou não. Recomendação: confirmar uma única vez. Exige liberar só essa confirmação depois do bloqueio. **O texto não oferece "atendente":** depois do PARAR, mensagens novas do contato (inclusive "atendente") ficam registradas, mas não reabrem a conversa nem liberam envios, e a equipe também não pode responder pela tela. Reativação exige consentimento verificável, fora da V1 |

## Ausência

A V1 **não tem horário de atendimento configurado**, então não sabe quando a equipe está ausente. Por isso não há mensagem de ausência automática. Os textos 2, 8 e 9 dizem que "uma pessoa vai continuar o atendimento" sem prometer horário. Duas opções:

- **A (recomendada para a V1):** a empresa publica uma resposta aprovada "Qual é o horário de atendimento?" na tela. O assistente usa essa resposta quando perguntado, sem código novo.
- **B (fora da V1):** horário por dia da semana na configuração e texto de ausência automático fora dele, por exemplo: "Nossa equipe está fora do horário de atendimento agora. Sua mensagem ficou registrada e vamos responder por aqui no próximo horário." Exige implementação, testes e aprovação.

## Identificação como atendimento virtual

**Hoje:** só a apresentação (texto 1) diz que é um assistente virtual. Se a primeira mensagem do cliente já é uma pergunta publicada, a resposta sai direto, sem identificação.

**Proposta, com mudança pequena no código:** na primeira resposta automática da sessão (24 h), prefixar "Atendimento virtual da {empresa}: ". **Decisão do Felipe.**

## Decisões pedidas

1. Aprovar ou ajustar os textos 1–4 e 7–9, que são as trocas diretas.
2. Item 4: um número total ou adultos e crianças separados?
3. Item 9: incluir o nome da empresa?
4. Item 10: responder à mídia ou só encaminhar?
5. Item 11: confirmar o PARAR?
6. Ausência: opção A ou B.
7. Identificação na primeira resposta da sessão: sim ou não.

Depois das decisões: troca de textos e testes, gates e nova revisão. Nenhum texto é enviado a cliente real antes da homologação.
