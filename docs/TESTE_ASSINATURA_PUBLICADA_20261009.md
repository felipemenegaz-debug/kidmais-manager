# Assinatura fictícia na homologação publicada — plano preparado

## Estado conferido, sem alterações remotas

Web `srv-daif418ae00c73e8k2gg` e cron `crn-db493i142hec73ahmoe0`, workspace `tea-daidbj95efls73d2bcf0`, Virginia, branch staging, auto-deploy OFF. Web usa banco `kidmais_staging_1z91` (`dpg-daidko3m8hqs73ce4jt0-a`). Produção não é alvo.

Nomes ASAAS_AMBIENTE, ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN presentes no web, valores não revelados; validade não comprovada. ASSINATURA_PLANOS_ATIVOS ausente. Cron está em aplicar e alerta recebido. As rodadas vazias anteriores não validaram a nova chave contra a API nem pagamentos reais do sandbox.

## Preparação local

`scripts/assinatura-staging-preflight.cjs` faz apenas GET da referência fictícia no Asaas sandbox. Recusa execução fora dos dois serviços staging exatos, produção e configuração inválida. Não importa pg, não acessa banco, não cria cobrança e não imprime chave ou resposta. Código local preparado, ainda não publicado. Três testes com respostas sintéticas (incluindo 401), lint, TypeScript e build isolado sem credenciais aprovados. Log ignorado `.local-staging-preflight-build.log`.

Fixture reservada para esta rodada:

- Empresa: `63304a1f-78c5-4aa6-99ad-2ca8778e4648`, nome `TESTE Kidmais — assinatura staging 20261009`.
- Usuário: `7963c744-d8f6-41e4-a6fc-62ab94ff44a2`, e-mail `assinatura-staging-7963c744@example.invalid`.
- Documento sintético gerado somente para sandbox, diferente de `20119900000160`. Antes de inserir, verificar unicidade no banco e nunca reutilizar empresa existente.
- Senha aleatória apenas no processo de ensaio, hash no banco; não mostrar/registrar senha nem token de sessão.
- Plano Essencial mensal, preço vigente da contratação 19700 centavos e Fundador automático 40% = 11820 centavos se a vaga for concedida. Conferir oferta efetiva antes de confirmar checkout; interromper se divergir. Nenhum pagamento financeiro real.

O harness local `scripts/assinatura-webhook-homologar.cjs` é referência já validada. Ele está preso a um banco local e a uma rodada concluída: NÃO executá-lo apontando para staging nem remover suas guardas. O ensaio remoto deve usar adaptador específico, com os IDs/alvos acima e validação prévia do schema/estado, após autorização.

## Ações operacionais propostas para aprovação

1. Publicar o diagnóstico e adaptador pertinente em staging após checks adequados e revisão da candidata. Executar diagnóstico autenticado separadamente no web e cron, sem copiar secrets entre eles. No cron, usar temporariamente o comando de execução `node --experimental-strip-types scripts/assinatura-staging-preflight.cjs`, validar uma rodada e restaurar `node scripts/assinatura-cron.cjs`. Isso causa rebuild do cron e pausa o processamento durante a janela; não iniciar dois reconciliadores em paralelo. Usar o Web Shell autenticado do web para seu diagnóstico, sem revelar env. Se qualquer chave falhar, parar antes de dados/cobranças e deixar o cron aguardando até correção.
2. No web staging, definir somente `ASSINATURA_PLANOS_ATIVOS=true`, mantendo sandbox, cadastro público e preços públicos como estão. A alteração provoca deploy: identificar/revisar o commit, acompanhar build/health e testar regressão. Não alterar DATABASE_URL nem demais flags.
3. No banco staging exato, inspecionar catálogo e registrar hash agregado do estado comercial anterior. Em transação, criar somente a empresa, usuário, membership e assinatura de teste com trial fictício encerrado, todos nos IDs acima. Conservar um registro da rodada para não repetir INSERT/checkout após resultado incerto. Não atualizar usuários ou empresas preexistentes. Consultas de verificação limitadas a esses IDs e ao agregado de preservação.
4. No Asaas sandbox, autenticar e verificar os vínculos antes de mutações. Reutilizar webhook se houver um correspondente válido; caso contrário criar webhook temporário para `https://kidmais-manager-staging.onrender.com/api/integracoes/asaas/webhook`, token do próprio web e somente PAYMENT_CONFIRMED/PAYMENT_RECEIVED. Não alterar webhooks alheios. Criar um cliente e uma assinatura fictícios pelo checkout autenticado da aplicação. Confirmar um pagamento pela API exclusiva do sandbox. O cron deve encontrar o cliente da referência criada pelo web; se não encontrar, as chaves podem ser de contas sandbox diferentes e a rodada deve parar.
5. Verificar callback/processamento, passagem SOMENTE_LEITURA → COMPLETO, contratação e Fundador únicos, sem dupla cobrança. Esperar o cron remoto; verificar nova rodada sem duplicação. Não enviar aviso comercial nem usar endereço real de cliente.
6. Cancelar apenas a assinatura fictícia pelo fluxo autenticado da aplicação, preservando o período já simulado como pago. Conferir cancelamento no Asaas, encerrando recorrência fictícia. Remover apenas o webhook temporário criado por esta rodada, se houver; preservar webhook previamente existente. Desativar acesso do usuário/membership da fixture e marcar empresa de teste DESATIVADA pelo fluxo permitido, preservando histórico de auditoria; não excluir históricos. Comparar o agregado anterior excluindo a fixture.
7. Restaurar a flag ASSINATURA_PLANOS_ATIVOS ao estado anterior (ausente), com deploy de recuperação somente do web. Restaurar o comando e modo aplicar do cron, validar health/execução e registrar resultado.

## Interrupção e recuperação

Erro/resultado externo incerto: não repetir checkout ou confirmação cegamente; retomar por IDs/referência da rodada. Cancelar apenas a assinatura fictícia se criada e conferir resultado. Preservar evidências, restaurar flag/comando e interromper antes de outro alvo. Nenhum restore, migration, delete de dados existentes, cobrança real ou alteração de produção está incluído. A isenção da Kidmais Festas não será cadastrada por este ensaio; seu acesso existente deve permanecer preservado.

Não ativar novas credenciais por inferência. Se credencial existente for inválida ou incompatível, Felipe deve corrigir diretamente no serviço sandbox correspondente; não pedir chave na conversa.

## Por que precisa de autorização

[OPERACAO_AGENTES.md](OPERACAO_AGENTES.md) exige aprovação explícita para alterações de env/deploy e para SQL de escrita, inclusive staging. A aprovação do cron cobria reconciliação de itens existentes, não habilitação da contratação no web nem criação/cancelamento desta fixture. Solicitar aprovação deste plano antes das ações operacionais.

`n## Autorização recebida`nFelipe respondeu "autorizo" ao plano acima em 09/10/2026. Executar apenas nesses alvos, preservando condições existentes e os limites de recuperação.
