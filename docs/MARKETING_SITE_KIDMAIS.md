# Origem dos pedidos de kidmaisfestas.com

O site externo do buffet usa o identificador da campanha criada em Marketing → Campanhas. O painel oferece o endereço de kidmaisfestas.com para a empresa configurada quando o operador escolhe esse destino. Campanhas com um site do iA.Fest selecionado continuam usando o endereço desse site.

## Configuração

- No serviço web e no processo que executa o atendimento, configurar `MARKETING_SITE_KIDMAIS_EMPRESA_ID` com o UUID da empresa Kidmais do respectivo ambiente. Ausente, o recurso fica desligado. Usar a configuração de Marketing e o plano já atribuídos à empresa.
- A captura no funil depende da função de oportunidades do Wall-e (fatia 1a, migration 132) e do processamento dos pedidos qualificados. Esta integração não acrescenta migration.
- Publicar o pacote do site externo no projeto Netlify proprietário de kidmaisfestas.com. A página usa a API de produção configurada em seu JavaScript. Em homologação, usar uma cópia de teste com a API e a origem de teste correspondentes, ou interceptar localmente o tráfego.
- Criar uma campanha por divulgação, por exemplo Instagram pago, Instagram bio e Google Perfil. Escolher o site externo e copiar o link completo. Colocar esse link no destino do anúncio, na bio ou no perfil correspondente. Um anúncio que leva ao perfil do Instagram só permite medir a origem que o link da bio representa.

## Conferência

1. Abrir o link copiado em uma visita nova. O site envia um POST sem corpo com o UUID da campanha e o tipo de evento. Os dados do pedido ficam fora desse evento.
2. Conferir o clique para WhatsApp no atalho direto e na última tela do simulador. Ambos usam a última linha `Ref. iA.Fest: <UUID>` na mensagem. A remoção da referência impede a atribuição automática.
3. Conferir em Marketing → Resultados os cliques no link e no WhatsApp. Em um pedido comercial recebido e qualificado pelo Wall-e, conferir a campanha do contato e, depois de vincular a negociação, a origem herdada. A origem vem do cadastro da campanha da mesma empresa. A referência recebida é editável pelo remetente e a atribuição do contato é registrada como informada.
4. Para pedidos sem referência, recebidos só por telefone ou atendidos manualmente, registrar a origem declarada no CRM. Manter a primeira atribuição existente. A configuração só mede acessos e mensagens que ocorrerem com o rastreamento em funcionamento.

## O que o sistema atribui em cada caso

Homologação sintética de 24/11/2026 (`lib/marketing/site-kidmais-homologacao.postgres.test.ts`, PostgreSQL descartável).

| Caso | Visita e clique no WhatsApp | Contato no funil | Campanha no contato |
|---|---|---|---|
| Link da campanha, botão direto ou simulador, Wall-e atende e o pedido qualifica | Contados | Criado pelo Wall-e | Sim, como informada |
| Wall-e responde e passa para a equipe na mesma mensagem (motivo comum) | Contados | Criado | Sim |
| Nova mensagem do mesmo pedido, com ou sem referência, mesmo com referência de outra campanha | Contados se houver novo clique | Não duplica | Mantém a primeira |
| Conversa que já está com a equipe, ou Wall-e desligado | Contados | Não é criado | Não. A equipe registra à mão |
| Primeira mensagem com a referência não é um pedido (só saudação) e o pedido vem depois sem a referência | Contados | Criado | Não. Fica "Origem não registrada" |
| Sem referência, referência alterada, fora da última linha, repetida, de campanha arquivada, inexistente ou de outra empresa | Clique só é contado para campanha válida da empresa | Criado se o pedido qualifica | Não |
| Telefone, indicação, visita ao salão | Não há | Registrado pela equipe | A que a equipe informar |

Medidas diferentes, nesta ordem: cliques no link (eventos de visita), cliques no WhatsApp (eventos), pedidos (contatos), negociações, contratos assinados. Os cliques contam eventos: a mesma pessoa que recarrega a página ou clica duas vezes conta de novo. Não há visitantes únicos.

Limites conhecidos:

- Em Marketing → Resultados, os cliques aparecem em "Ver mais", por campanha.
- O filtro de Unidade esconde os cliques do site externo e os contatos criados pelo Wall-e, porque nascem sem unidade. Consultar com "Todas".
- O contrato conta para a campanha pela negociação. A negociação herda a origem do contato quando é vinculada.

## Registro manual da origem

- Funil → "Novo contato": "Chegou por" (telefone, WhatsApp, presencial, e-mail, outro), "Como conheceu" e "Campanha (opcional)".
- Marketing → Pedidos e contatos → abrir o contato: "Informar origem" ou "Corrigir origem", enquanto não houver negociação.
- Depois de vinculada a negociação: "Corrigir origem" no perfil do cliente (negociações) ou na tela da festa.
- Telefone é o canal por onde o pedido chegou. A origem é como a pessoa conheceu o buffet: Google, Instagram, Facebook, Indicação, Já era cliente, Passou em frente ou Outro.

## Desativação

Remover a variável do web e do worker pelo fluxo de operação do ambiente e restaurar o pacote anterior do site se necessário. Os clientes ainda podem usar os links para abrir o site e enviar mensagens. Os eventos e atribuições já registrados permanecem no histórico.
