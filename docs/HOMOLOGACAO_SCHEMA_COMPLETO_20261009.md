# Homologação da assinatura com schema completo — execução concluída

Preparado e executado em 09/10/2026. Felipe respondeu “próximo passo” à pergunta explícita para criar `kidmais_renovacao_075_completa`, executar as migrations/checks/rollbacks e encerrar o cluster. Essa autorização específica foi usada somente no alvo proposto.

## Resultado

**PASS: 76 migrations e checks**, com SHA-256 dos 194 arquivos conferido antes da conexão. Banco criado vazio com `template0`; nenhum arquivo SQL precisou de correção. Rollback 075/074, reaplicação e comparação das assinaturas sintéticas antes/depois aprovados. Conexões fechadas, variável de autorização removida do processo e cluster encerrado com `server stopped`; consulta de status posterior retornou `no server running`.

Logs locais ignorados pelo Git: `homologacao-schema-completo.log` (execução) e `homologacao-schema-completo-pg.log` (cluster). Os bancos sintéticos anteriores e o novo foram preservados no cluster parado. Não houve acesso a banco real, chamada a provedor, envio de e-mail, commit, push ou deploy.

O resultado comprova instalação do schema completo e os rollbacks testados; não comprova checkout/renovação funcional nesse schema nem integração HTTP com Asaas/Resend. Não houve alteração de código ou SQL nesta execução; não foi necessário repetir testes da aplicação ou build.

## Ensaio funcional posterior — 09/10/2026

Após o pedido seguinte “próximo passo”, foi executada a etapa anunciada de testes de oferta/confirmacão e renovação no mesmo banco descartável completo. O harness `scripts/assinatura-074-075-homologacao.cjs` ganhou o modo `--testar-completo`: empresas começam em PROVISIONAMENTO e passam para ATIVA, usuários têm hashes sintéticos, memberships começam PENDENTE e são ativadas. Nenhum trigger ou constraint foi desativado. Todas as chamadas de cobrança/e-mail permanecem simuladas; `fetch` permanece bloqueado.

**Nove grupos aprovados, em três execuções continuadas sem apagar ou recriar o banco:**

1. Oferta idempotente, recusa de adulteração financeira e plano sem pagamento, vínculo cruzado entre empresas recusado e empresa isenta impedida de contratar.
2. Duas transações disputando a última vaga Fundador: uma reserva, outra aguarda; limite de 20 preservado.
3. Pagamentos com preço ou pagador divergentes recusados; oferta permanece aberta.
4. Confirmação atômica e reentrega idempotente com FKs reais.
5. Resposta perdida do envio mantém AVISANDO; resposta perdida da alteração de preço mantém APLICANDO.
6. Retomada e concorrência de workers concluem REGULAR com somente um aviso aceito pelo simulador idempotente e uma alteração de preço; DTO confirma aviso.
7. Histórico imutável e rollbacks com dados recusados.
8. Simulação não muda registros nem chama mutações/envios; postchecks aprovados.
9. Cancelamento repetido impede renovação sem chamadas externas, preserva fim do período pago e mantém outras assinaturas intactas; postchecks finais aprovados.

Foram corrigidas duas expectativas do próprio harness: `confirmarOfertaPaga` lança `PAGAMENTO_OFERTA_DIVERGENTE`, em vez de retornar null para prova incompatível; uma assinatura cancelada exige `cancelada_em`. As duas recusas comprovaram as guardas da aplicação/banco. Nenhuma alteração em código da aplicação ou migrations foi necessária. Retomadas verificaram o estado esperado e preservaram as 20 reservas/histórico. O modo completo inicial recusa execução se já existirem contratações; os modos de retomada não são reset genérico.

Logs: `homologacao-fluxos-completo.log` (grupos 1–2 e primeira expectativa incorreta), `homologacao-fluxos-completo-retomada.log` (grupos 3–8 e fixture de cancelamento incompleta), `homologacao-fluxos-completo-cancelamento.log` (grupo 9). **99/99 testes unitários** passaram novamente, ESLint do harness sem erros. Cluster encerrado com `server stopped`. Node local 24.20.0; permanece pendente repetição na versão 22.23.2 declarada. Build não repetido, pois somente harness/documentação mudaram.

Limites: são funções de oferta/confirmação e repository/worker de renovação com SQL real; não é teste HTTP da tela, autenticação/tenant middleware, criação de assinatura no Asaas ou webhook real. O cancelamento foi persistido com SQL válido e consumido pelo worker, sem testar o endpoint de cancelamento. A renovação usa fixture explícita com vencimento regular em hoje + 30 dias; calendário dos 12 meses continua nos unitários. Idempotência do e-mail foi simulada por chave, não verificada no Resend. Revogação da Gestão, cancelamento concorrente ao aumento e jornada ponta a ponta ainda precisam de cobertura ampliada.

## Alvo e efeitos autorizados

### Jornada de interface — 09/10/2026

Executado `scripts/assinatura-interface-completa.cjs` após o pedido seguinte de avanço. Alvo fixo: mesmo banco completo em 55475; app de desenvolvimento isolado em `http://localhost:3195`, diretório `.next-festa-auto`. Cada tentativa cria usuário sintético e memberships nas empresas de fixture existentes, sem apagar histórico. Conexão confirma identidade do banco antes de escrever. Arquivos `.env*` são recusados; configuração do processo filho usa credenciais sintéticas e e-mail desativado.

**Aprovado no Chrome:** login real com senha sintética; seleção real de empresa pela API de autenticação; leitura real da assinatura; botão Retomar envia plano Essencial, ciclo mensal e preço da oferta; resposta de checkout interceptada no navegador exibe pagamento pendente; viewport 390 px sem rolagem horizontal; empresa cancelada não exibe botão de cancelamento. Snapshot de todas as assinaturas antes/depois permaneceu igual. Capturas inspecionadas em `.local-assinatura-interface/pagamento-pendente.png`, `pagamento-pendente-mobile.png`, `cancelada-mobile.png`; relatório em `resultado.json`.

Limite explícito: o endpoint de checkout e o Asaas não foram chamados pelo teste de pagamento; apenas a resposta foi simulada. A consulta de assinatura, login e seleção de empresa usaram servidor e banco reais sintéticos. O link externo de pagamento não foi aberto; não houve envio de e-mail nem webhook real. Configuração externa ainda pendente.

As primeiras tentativas identificaram ajustes do harness: campo de ordenação incorreto, uso de HTTP em modo produção, normalização da origem local para localhost, rota de seleção de empresa e espera da hidratação. A jornada final usa as regras existentes de autenticação, sem flexibilização de origem/CSRF.

**Correção da aplicação encontrada no teste:** o formulário de login não declarava método, permitindo submissão nativa GET antes da hidratação, com os campos na URL. Adicionado `method="post"` em `app/admin/login/page.tsx`. Teste com JavaScript desativado intercepta a submissão e verifica POST sem query string; login hidratado também passou. Isso evita exposição pela URL; não adiciona autenticação sem JavaScript. Eventuais campos sintéticos registrados nas primeiras tentativas foram ocultados no log local.

Validação final: jornada aprovada, ESLint do harness/login sem erros, TypeScript e build aprovados (`homologacao-interface-build.log`). Alterações automáticas do Next em `tsconfig.json`/`next-env.d.ts` foram revertidas pontualmente para o estado anterior. Servidor filho encerrado e cluster parado (`server stopped`). Nenhum deploy, commit ou alteração de produção.

- Reutilizar o cluster descartável `.local-renovacao-pg075`, usuário e cluster `kidmais_renovacao_075`, em `127.0.0.1:55475`.
- Criar **somente** `kidmais_renovacao_075_completa`, a partir de `template0`. Se existir, abortar; não sobrescrever nem apagar.
- Aplicar 76 arquivos de migration no total: inventário até 073 mais 074/075, incluindo 006a e 055a–d. Os números ausentes do inventário não são inventados. Executar prechecks, backfill e postchecks exigidos na ordem do inventário.
- Antes da 046, criar a identidade sintética exigida pela própria migration, com hash aleatório que não permite login. A migration histórica pode semear o nome canônico Kidmais; nenhuma linha é copiada de banco existente, nenhum CNPJ real é vinculado à isenção e nenhum e-mail é enviado.
- Testar rollback 075/074 sem contratações novas, reaplicar e comparar as assinaturas sintéticas antes/depois.
- Fechar conexões e parar esse cluster ao concluir ou falhar. Manter os dois bancos descartáveis e logs para inspeção; não fazer DROP, restore ou reset.

Não acessa `kidmais_manager`, staging ou produção. Não altera configuração Render, credenciais, Git remoto ou serviço de e-mail. Não cria cobranças externas.

## Artefatos preparados

`scripts/assinatura-schema-completo.cjs` usa conexão fixa e valida banco/usuário/endereço/porta/cluster, além da ausência do banco real no cluster. Recusa configuração herdada `DATABASE_URL`/`PG*`, solicitação de senha e banco de destino existente. Bloqueia `fetch`.

O modo padrão `--plano` só lê arquivos e grava o manifesto local `docs/evidencias/assinatura-schema-completo-20261009.json`, com ordem e SHA-256 de **194 arquivos**. O modo `--aplicar` exige autorização literal e recusa mudanças de conteúdo desde a preparação. O valor da variável é uma trava operacional, não substitui a autorização humana exigida por `OPERACAO_AGENTES.md`.

Na preparação anterior: geração offline do manifesto, ESLint sem erros e tentativa sem autorização literal, corretamente recusada antes de abrir conexão. Após autorização, a execução de banco foi concluída conforme o resultado acima. Não houve alteração de código da aplicação, portanto o build anterior permanece a evidência disponível.

Comando executado após autorização, com log do cluster fora do diretório de dados para evitar conflito de recuperação no Windows (não repetir sobre o banco já existente):

```powershell
$env:KIDMAIS_SCHEMA_COMPLETO_AUTORIZACAO='127.0.0.1:55475/kidmais_renovacao_075_completa'
node scripts/assinatura-schema-completo.cjs --aplicar
```

Encerrar sempre o cluster pelo caminho exato com `pg_ctl -D ... -m fast -w stop` e remover a variável somente do processo de teste. Se houver falha, preservar o banco parcial e registrar o último arquivo executado; não tentar reaplicar toda a sequência nem alterar migrations históricas sem diagnóstico.

## Critérios de conclusão e etapas seguintes

Esta execução comprova **instalação e compatibilidade do schema completo**, não regressão funcional completa. Depois dela, adaptar fixtures de checkout/renovação às tabelas reais e executar cenários de concorrência, falhas após commit, isolamento por empresa, revogação da Gestão e cancelamento. O harness reduzido anterior não deve ser apontado ao novo banco sem essa adaptação.

Para Asaas e e-mail, os nomes `ASAAS_AMBIENTE`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`, `EMAIL_PROVIDER` e `RESEND_API_KEY` não estavam presentes no ambiente do processo durante a preparação. Isso não informa a configuração de serviços remotos. `.env.local` não foi aberto. A homologação externa depende de disponibilização segura da conta sandbox e definição de destinatário exclusivo de teste; não pedir chaves em mensagem nem usar pagadores/clientes reais.

Antes de qualquer chamada externa, preparar o roteiro com os objetos sintéticos a criar, cobrança simulada, retorno/webhook, idempotência, cancelamento e destino dos avisos. Credenciais presentes não autorizam envio de e-mail. O executável de renovação permanece limitado a `EMAIL_PROVIDER=arquivo` nesta entrega; envio remoto de teste precisa de um caminho explicitamente preparado e autorizado. Nenhuma configuração externa é solicitada ou alterada por este plano de banco.

Persistem como etapas independentes: limites de recursos por plano, vínculo da isenção da Kidmais ao ID real em operação autorizada, homologação do provedor e publicação controlada. Não habilitar vendas em produção apenas com a aprovação dos testes locais.
