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

## Desativação

Remover a variável do web e do worker pelo fluxo de operação do ambiente e restaurar o pacote anterior do site se necessário. Os clientes ainda podem usar os links para abrir o site e enviar mensagens. Os eventos e atribuições já registrados permanecem no histórico.
