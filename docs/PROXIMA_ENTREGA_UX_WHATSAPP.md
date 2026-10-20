# Próxima entrega de UX e atendimento no WhatsApp

Plano preparado em 01/10/2026 a pedido de Felipe. A administração da plataforma foi documentada para implementação posterior. O ciclo combina correções de UX com atendimento automático por IA no WhatsApp. A candidata local já tem alterações de código; consultar [o handoff atualizado](HANDOFF_CLAUDE_UX_WHATSAPP.md) para o estado implementado, validações e pendências operacionais. As tabelas abaixo preservam o escopo planejado, sem atestar publicação.

## Documentos de referência

- [Administração da plataforma para comercialização](ADMINISTRACAO_PLATAFORMA_PLANO.md).
- [Atendimento automático por IA no WhatsApp](ATENDIMENTO_IA_WHATSAPP_PLANO.md).
- [Entrega anterior de UX](UX_CONTRATOS_PERFIL.md), como evidência histórica; não assumir que cobre os pedidos posteriores.
- [Política operacional](OPERACAO_AGENTES.md).

## Escopo de UX a consolidar

| Item | Comportamento desejado | Situação nesta preparação |
| --- | --- | --- |
| Cancelar importação | Botão visível na revisão e confirmação, confirmação do descarte e retorno à lista | Proposta; não implementado por este plano |
| Corrigir importação | Editar campo, Não consta no documento, identificação de alteração manual e preservação ao voltar | Proposta; não implementado por este plano |
| Erro de extração | Exibir falha real; nunca substituir um arquivo real por dados fictícios silenciosamente | Critério para revisão do fluxo real e demonstração |
| Origem dos dados | Página e trecho quando realmente extraídos; ausentes não aparecem como encontrados | Dependente do motor real de extração |
| Modelo por empresa | Upload separado de importação histórica, rascunho, variáveis e revisão antes de publicar | Escopo a dimensionar com isolamento de empresa |
| Criação simples de festa | Atalho na página Festas que prepara contratação pelos serviços oficiais e mostra consequências | Desenho pendente; não fazer inserção direta |
| Assistente administrativo | Pedido de festa deve preparar contratação; corrigir roteamento que sugere novo pacote indevidamente | Regressão necessária na candidata |
| Botões e cards | Padrão visível, bordas em degradê com movimento, destaque dos botões da IA e redução de movimento respeitada | Pedidos anteriores a verificar antes de alterar novamente |
| Navegação do dashboard | Ação recomendada e próxima festa abrem seu contrato específico | Pedidos anteriores a verificar na candidata |
| Clientes e disponibilidade | Remover cabeçalho redundante, reposicionar Fechamento e Ver tela do cliente e padronizar Consultar disponibilidade | Pedidos anteriores a verificar na candidata |
| Logo e perfil | Seleção produz prévia ou erro, salvar/aplicar preserva logo; perfil abre com contexto correto | Pedidos anteriores a verificar na candidata |

Os últimos seis itens incluem relatos de entregas anteriores. Inspecionar o código e reproduzir em ambiente isolado antes de classificá-los como regressões ou trabalho ainda necessário. Não reimplementar por pressuposto.

## Importação e criação de festa

Na preparação inicial, a tela consultada usava dados de demonstração; escolher um PDF não comprovava extração. A base atual também contém importação real condicionada às flags e ao contexto autorizado, que deve continuar separada da demonstração. A prévia apresentada ao usuário usou campos previamente conferidos do PDF fornecido e não comprovava um motor implementado. O texto sobre restrições alimentares mostrado na demonstração anterior não deve ser atribuído a esse documento.

Cancelar a revisão não cancela um contrato existente. Após uma importação efetiva, correção ou cancelamento seguem o domínio de contratos, com auditoria. Definir explicitamente quando o fluxo apenas descarta estado local e quando exige remover um upload temporário do servidor.

Proposta para Nova festa: seleção/criação de cliente autorizado, unidade, data completa, horário, pacote e convidados; revisão de preço e pagamento; encaminhamento para o fechamento oficial. Rascunho não bloqueia agenda. Gerar contrato não equivale a festa confirmada. Uma eventual reserva temporária exige regra própria de prazo, concorrência e liberação e fica fora da primeira versão sem decisão explícita.

IA administrativa e atalho visual usam os mesmos serviços e validações. A IA do WhatsApp prepara interesse comercial e encaminha; não recebe autoridade para confirmar festa, assinatura, preço excepcional ou pagamento.

## Ordem sugerida

1. Fechar escopo, provedor e atendimento humano do WhatsApp; definir consequências da importação e da criação simples de festa.
2. Revisar isolamento e contexto mínimo para conexão, empresa e unidade. Completar a parte necessária ao piloto sem construir todo o painel da plataforma.
3. Corrigir UX e comportamento de demonstração; integrar extração real somente com origem verificável e erros explícitos.
4. Implementar caixa de atendimento, persistência/fila, transporte, ferramentas comerciais restritas e pausa da IA.
5. Homologar cenários de erro, segurança, concorrência, consumo e encaminhamento com mocks e dados sintéticos.
6. Validar piloto em staging com número e destinatários autorizados. Somente então preparar promoção e ativação gradual em produção.

## Condições de publicação

- Critérios de aceite dos dois planos verificados; UX testada em celular, teclado e estados de erro.
- Contratação preserva preço oficial, aprovação, assinaturas, financeiro e disponibilidade no servidor.
- Nenhum dado fictício aparece como extraído de documento real.
- Resposta automática respeita empresa, unidade, pausa humana, janela de atendimento e limite de consumo.
- Novas migrations têm validação, plano de recuperação e autorização para o destino antes de executar.
- Flags de atendimento separadas do OTP e da IA administrativa; desligamento interrompe novos envios e trata a fila sem apagar o histórico.
- Sem envio a clientes reais ou ativação remota nesta fase documental. Commit, merge, deploy e mudanças operacionais serão definidos para a candidata concreta conforme a política vigente.

## Registro de decisões

| Assunto | Estado em 01/10/2026 |
| --- | --- |
| Documentar administração para depois | Solicitado pelo usuário; planos preparados localmente |
| WhatsApp com IA no próximo ciclo junto da UX | Prioridade solicitada pelo usuário |
| Atendimento inicial de interessados | Recomendação, ainda sem decisão explícita |
| Atendimento de contratos privados pelo WhatsApp | Fora da proposta inicial; exige decisão e identificação apropriada |
| Uso de Gupshup no atendimento | Escolhido pelo usuário, com o número atual da Kidmais; homologação real pendente |
| Novo painel completo da plataforma no próximo ciclo | Não incluído; manter como evolução posterior |
| Piloto e publicação | Não executados por esta preparação |
