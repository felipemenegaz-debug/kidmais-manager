# Integração dos três planos — diagnóstico e decisões

Pedido de Felipe em 09/10/2026: seguir com o ponto 2, integrando os planos comerciais à assinatura do Kidmais Manager.

Estado atualizado em 09/10/2026: catálogo, checkout/confirmação e renovação Fundador preparados localmente. Após autorização específica, migrations 074/075 passaram por aplicação, rollback e reaplicação em PostgreSQL descartável com base sintética reduzida. Seis grupos de integração e 99 testes unitários passaram. Foi corrigida colisão entre nomes de CHECKs na 074. Nenhuma operação remota foi executada; novos planos não estão liberados em produção. Evidências e limites em [Renovação Fundador](RENOVACAO_FUNDADOR_20261009.md#resultado-do-ensaio-isolado).

Atualização posterior: a instalação do **schema completo**, com 76 migrations e checks, e o rollback/reaplicação 074/075 também passaram em outro banco sintético autorizado. [Evidência da execução](HOMOLOGACAO_SCHEMA_COMPLETO_20261009.md). O cluster foi encerrado; nenhum ambiente remoto foi alterado.

As seções abaixo registram as etapas anteriores; referências a SQL ainda não executado descrevem o estado daquela etapa. A instalação do schema não substitui os testes funcionais de checkout/renovação nele, homologação de provedores externos, vínculo da isenção real ou limites de recursos por plano.

## O que existe

| Área | Evidência no código | Mudança necessária |
| --- | --- | --- |
| Oferta do site | `lib/site/catalogo.ts`: Essencial 19700, Profissional 34700, Premium 59700 centavos; anual 10×; Fundador 40% por 12 meses, 20 vagas | Compartilhar a fonte comercial com o servidor de assinatura, preservando a publicação condicional de preços |
| Banco | Migration 067: `empresa_assinaturas.plano` só aceita `UNICO` | Evolução aditiva do schema para os novos planos e condições contratadas, preservando o legado; arquivo e execução dependem do escopo aprovado |
| Início do teste | `lib/assinatura/servico.ts` e cadastro público | Definir se o plano é escolhido antes do cadastro ou ao contratar; intenção de escolha não deve conceder acesso pago |
| Checkout | `app/api/admin/assinatura/checkout/route.ts`, `lib/assinatura/cobranca.ts`: recebe apenas `ciclo` | Receber plano validado, calcular preço no servidor e persistir a oferta contratada; nunca aceitar valor/desconto do navegador |
| Tela de assinatura | `components/admin/AssinaturaAcoes.tsx`, `lib/assinatura/consulta.ts` | Exibir opções, condições e valor final; confirmar a contratação antes de abrir o pagamento |
| Cobrança | `lib/assinatura/asaas.ts`: aceita somente sandbox | Homologar os planos em testes; habilitação real permanece etapa separada, sem alterar a proteção atual |
| Confirmação | Webhook e sincronização liberam acesso após confirmação do provedor | Vincular a confirmação à contratação e ao plano efetivamente pagos, preservando idempotência e reconciliação |
| Controle comercial | `lib/assinatura/paywall.ts`: completo, leitura ou bloqueado por situação/datas | Somar verificação de recursos e limites por plano no servidor, sem substituir permissões do usuário/tenant |
| Empresas atuais | Sem linha de assinatura, acesso atual preservado; assinaturas existentes usam `UNICO` | Definir política de transição sem aplicar reprecificação nem restrição por inferência |

O valor atual da cobrança vem de `ASSINATURA_PRECO_MENSAL_CENTAVOS` e `ASSINATURA_PRECO_ANUAL_CENTAVOS`, separado da vitrine. Apenas trocar esses valores não implementa os três planos.

## Decisões enviadas a Felipe

1. **Escolha do plano — APROVADO por Felipe em 09/10/2026:** ao assinar, após iniciar o teste. Os CTAs do site continuam no mesmo `/cadastro`; a escolha acontece dentro do sistema. Teste de 15 dias dos recursos disponíveis, sem liberar recursos “Em breve”.
2. **Empresas existentes — APROVADO:** preservar o acesso. Felipe informou que a Kidmais Festas, CNPJ **20.119.900/0001-60**, é o único buffet real cadastrado e **não será cobrada**. Isenção permanente da empresa existente, sem consumir vaga Fundador. Não excluir nem alterar outros cadastros por presumir que sejam testes. CNPJ passou na validação sintática local; titularidade e ID persistido não foram consultados. Vincular a isenção ao ID verificado da empresa existente, nunca apenas a um CNPJ enviado pelo navegador ou declarado em novo cadastro.
3. **Fundador — APROVADO:** concessão automática, opção apresentada para os primeiros 20 clientes pagantes. Desconto de 40% por 12 meses conforme referência. Detalhes de reserva/consumo da vaga e renovação serão explicitados na implementação para revisão.
4. **Fim do Fundador — APROVADO por Felipe em 09/10/2026:** renovar pelo preço normal, com aviso prévio. A tela apresenta o preço após o benefício. O valor regular vem do snapshot aceito pelo cliente, não de uma futura edição do catálogo. Felipe confirmou **30 dias de antecedência, por e-mail e no sistema** no goal seguinte. Automação local preparada e testada, ainda não ativada; ver [Renovação Fundador](RENOVACAO_FUNDADOR_20261009.md).

Os quatro itens acima foram respondidos explicitamente por Felipe. Isso não autoriza execução de migration, alteração de ambiente ou cobrança em produção.

## Preparação local após as respostas

- `lib/assinatura/planos-comerciais.ts`: fonte única de preços dos três planos, ciclos, 15 dias, condições Fundador e limites comerciais de usuários. Funções sem banco/efeitos, com validação de IDs e cálculo em centavos.
- `lib/site/catalogo.ts` passa a consumir essa fonte sem mudar preços ou aparência.
- `lib/assinatura/planos-comerciais.test.ts`: preços mensal/anual/Fundador, rejeição de IDs inválidos e garantia de que a configuração legada não é ativada nem reprecificada.
- O desconto calculado para apresentação **não é uma concessão**. Checkout futuro só poderá usá-lo após reserva/concessão persistida e validada no servidor; nenhuma autorização virá do navegador.
- Validação desta preparação: 12 testes aprovados (`planos-comerciais.test.ts`, `configuracao.test.ts`, `site.test.ts`), TypeScript sem erros, ESLint dos três arquivos de código sem avisos, `npm run build` aprovado e `git diff --check` sem erros. Nenhum teste acessou banco ou provedor.

## Mudanças de banco propostas para autorização

Alvo desta preparação: somente arquivos locais no clone desta tarefa. Não aplicar SQL em nenhum ambiente.

1. Ampliar a restrição de `empresa_assinaturas.plano` para os três planos, mantendo `UNICO` para compatibilidade. Nenhuma reclassificação automática dos registros antigos.
2. Registrar a oferta contratada de forma imutável: empresa, plano, ciclo, versão do catálogo, preço regular, preço final, desconto, vigência e referência da intenção/provedor. O plano escolhido só passa a ativo após confirmação válida do pagamento.
3. Registrar isenção permanente e auditável por ID da empresa existente. A futura vinculação da Kidmais Festas exige conferir esse ID e o CNPJ informado; não inserir a isenção automaticamente a partir de dados autodeclarados. A isenção deve impedir criação de cobrança e preservar acesso, sem dar novas permissões de usuário.
4. Registrar campanha e vagas Fundador com unicidade por empresa/beneficiário e teto transacional de 20. Reservar antes de emitir uma cobrança com desconto; confirmar após pagamento verificado. Repetição de webhook não consome vaga extra. Reservas de resultado incerto não podem ser liberadas antes da reconciliação com o provedor.
5. Preparar precheck/postcheck e rollback que recuse destruição de contratos novos. Preservar as migrations históricas. A homologação de SQL dependerá de banco isolado e autorização específica de execução.

O caso em que as 20 vagas estão reservadas mas ainda não pagas precisa ser tratado explicitamente: não cobrar preço cheio nem prometer uma 21ª vaga silenciosamente. A interface deve aguardar confirmação/disponibilidade antes de oferecer uma condição definitiva. A vigência proposta do benefício começa no primeiro pagamento confirmado; nenhuma renovação pode manter desconto indefinidamente por falta de atualização do provedor.

## Sequência proposta de implementação

1. Fechar as decisões acima e a matriz de recursos: Essencial até 3 usuários; Profissional até 10; Premium sem limite comercial de usuários. Definir contagem de convites/vínculos, comportamento ao atingir o limite e exceções existentes.
2. Extrair catálogo comercial compartilhado e versionado. Manter `SITE_PRECOS_PUBLICADOS` como regra de apresentação, separada da habilitação de contratação. Recursos “Em breve” não serão liberados pela compra de plano.
3. Preparar contrato de dados para plano, ciclo, preço contratado, versão da oferta e desconto com validade. Preservar `UNICO` e empresas sem cobrança conforme a decisão de transição. Não editar migrations históricas para mudar bancos já existentes.
4. Integrar seleção e confirmação na tela de assinatura e checkout. Preservar a trava por empresa, a intenção persistida antes do provedor e a recuperação de resultados incertos.
5. Integrar pagamento confirmado, webhooks e reconciliação à oferta contratada. Retorno do navegador nunca libera acesso.
6. Aplicar limites e recursos em todas as operações relevantes do servidor; refletir indisponibilidade na interface. Financeiro básico versus completo exige mapear operações, e não apenas ocultar menus.
7. Implementar concessão/expiração do Fundador conforme decisão. A renovação após o desconto precisa de tratamento no provedor; alterar apenas o preço inicial não basta.
8. Homologar com testes sintéticos e apresentar o diff. Operações de banco, credenciais, publicação e cobrança real ficam para autorização específica.

## Pontos que precisam de regra antes de cobrança real

- Upgrade/downgrade: data de efeito, eventual diferença proporcional, limites excedidos e renovação. Não presumir cobrança imediata nem apagar dados para adequar plano.
- Fundador: mensal versus anual, começo/fim do benefício, vaga em pagamento pendente ou cancelado e retorno ao preço regular.
- Adicionais: unidade extra, implantação e Wall-e têm modalidades diferentes. Não habilitar automaticamente contratação de um adicional indisponível.
- Franquias de IA e convite continuam pendentes de D5; não inventar cotas. Não tratar “Em breve” como funcionalidade entregue.
- Suporte e implantação são serviços humanos; sua oferta exige capacidade operacional, além de código.

## Validação prevista

- Preços e planos calculados no servidor; rejeição de plano/ciclo/valor adulterados e descontos sem concessão.
- Isolamento por empresa, autorização da Gestão, CSRF/origem e permissão do usuário preservados.
- Concorrência de checkout e de vaga Fundador, repetição, falha após criação no provedor e retomada sem duplicação.
- Confirmação atrasada ou fora de ordem, plano divergente, cancelamento e renovação sem acesso indevido.
- Legado inalterado; limite de usuários checado atomicamente; recursos futuros não liberados.
- Unitários/mocks, TypeScript, lint e build. Testes PostgreSQL só em destino isolado e após autorização exigida pelo repositório.

## Limites operacionais

Continuam vigentes: sem commit, push, PR, merge, deploy ou alterações de variáveis no Render sem autorização de Felipe. A resposta “pdoe” autorizou preparar os arquivos de schema descritos acima; não autorizou executá-los. A política `docs/OPERACAO_AGENTES.md` exige autorização explícita para executar migrations/SQL em qualquer banco, inclusive isolado.

## Entrega dos arquivos 074 — preparados, não aplicados

| Arquivo | Conteúdo |
| --- | --- |
| `database/migrations/20261009_074a_planos_comerciais.sql` | Três tabelas, contratos por empresa, vagas, isenção, constraints e evolução da guarda 068 |
| `database/checks/20261009_074a_precheck.sql` | Pré-requisitos, ausência de instalação parcial e hash do corpo da guarda original; transação somente leitura |
| `database/checks/20261009_074a_postcheck.sql` | Estrutura, gatilhos, índices, teto da campanha e coerência dos vínculos; transação somente leitura |
| `database/rollback/20261009_074a_planos_comerciais_down.sql` | Restaura literalmente a função 068 e o plano único, apenas se as novas estruturas nunca foram usadas |
| `lib/assinatura/migration-074.test.ts` | Testes estáticos das garantias de compatibilidade, concorrência estrutural, restauração e ausência de alterações de dados |

O número 074 é o próximo livre **neste clone** (última migration: 073). Revalidar a numeração e a base antes de qualquer integração com outra branch.

Não há INSERT/UPDATE de empresas existentes nem seed de isenção. A coluna nova é nula para o legado. Nenhuma chave, credencial ou CNPJ real está embutido no SQL. Contratos confirmados são imutáveis e conservam preço, desconto, ciclo e versão da oferta. O plano efetivo exige vínculo com confirmação da mesma empresa, ciclo e assinatura do provedor.

O teto Fundador é garantido por vagas 1–20 e índices únicos parciais para vaga, empresa e documento. Confirmados continuam ocupando vaga para sempre; liberados permanecem no histórico. Uma vaga não pode ser liberada enquanto houver contratação aberta/confirmada. A primeira confirmação tem FK diferida para o pagamento de uma contratação da mesma empresa e da mesma vaga; ambas precisam fechar na mesma transação. O fim do benefício é calculado como 12 meses em UTC a partir do instante de confirmação registrado. A aplicação deverá usar o instante confiável da confirmação, nunca um valor enviado pelo navegador.

### Cuidados registrados na preparação da migration

- A migration **não implementa o checkout**, não chama o provedor e não libera funcionalidades. A aplicação deverá checar isenção antes de qualquer chamada de cobrança; uma trava de banco após a chamada não desfaz cobrança externa.
- A Kidmais existente continua com o comportamento legado. A isenção permanente ainda precisa ser vinculada ao ID conferido da empresa, numa operação autorizada posterior. O CNPJ informado não permite conceder isenção a uma empresa autodeclarada.
- Antes de confirmar o Fundador, reconsultar o pagamento, empresa, valor e provedor; registrar a contratação e a vaga na mesma transação. Usar leituras idempotentes nos retries, sem repetir UPDATE de registros já confirmados.
- A aplicação deve adquirir locks na ordem empresa → assinatura → vaga → contratação e manter transações curtas, sem chamadas externas dentro delas. Testar concorrência e tratar deadlock/violação única com releitura; não transformar disputa em segunda cobrança.
- Com 20 reservas pendentes, aguardar disponibilidade em vez de vender uma 21ª vaga ou trocar silenciosamente o preço. Não liberar reserva apenas por timeout; primeiro invalidar/reconciliar a cobrança no provedor.
- A guarda original de troca de assinatura do provedor é mantida. Upgrade/downgrade de contrato ativo não está sendo habilitado por esta estrutura.
- A renovação após 12 meses depende de lógica e reconciliação do provedor ainda não implementadas. Não iniciar oferta paga antes de homologar essa etapa.
- Snapshot é histórico, não tabela de controle de parcelas. Cancelamento do serviço não apaga nem muda uma contratação já confirmada.
- Não aplicar com binários antigos após começar a usar os novos contratos. Se houver qualquer linha nas novas tabelas, o rollback recusa apagar o histórico; corrigir por migration progressiva.

### Validação desta etapa

Revisão dos arquivos e testes estáticos locais, sem conexão com PostgreSQL: **8/8 testes aprovados**, ESLint do teste e `tsc --noEmit` aprovados; `git diff --check` sem erros. As validações verificam a restauração literal da função 068, manutenção das transições antigas, exigência de confirmação por empresa/plano/ciclo/provedor, ausência de DML sobre empresas existentes, índices únicos da campanha e checks somente leitura. Não foi necessário novo build da aplicação para esta etapa restrita a SQL, documentação e teste estático; o build do catálogo compartilhado já havia passado na etapa anterior.

**Ainda não homologado em PostgreSQL.** Antes de aplicação, executar em um banco sintético isolado e explicitamente autorizado: up/down sem dados; rollback recusado com histórico; legado intacto; validação das constraints e dos triggers em INSERT/UPDATE/DELETE/TRUNCATE; confirmação atômica das FKs diferidas; disputa simultânea pela 20ª vaga e por uma empresa; reentrega de webhook; recusa de oferta adulterada; bloqueio por isenção; expiração/renovação do benefício; planos e ciclos divergentes. Nenhum desses ensaios de banco foi executado nesta entrega.

O diagnóstico usa a base local `fb30f70cd06d6522e88475e5185b314612f30f93` e o diff do site; não é uma auditoria do schema nem da configuração atuais de produção.

## Goal seguinte — checkout e confirmação locais (09/10/2026)

Implementação posterior à preparação acima, sem execução da 074:

- `ofertas.ts`: oferta persistida e calculada pelo servidor, versão do catálogo, confirmação explícita do valor apresentado, retomada da mesma contratação, isenção por ID e reserva automática Fundador. A trava global da campanha precede a escolha da vaga; os índices da 074 continuam sendo a proteção definitiva. Com 20 reservas ainda não confirmadas, o cliente aguarda; após 20 confirmações, confirma o preço normal antes de contratar.
- `cobranca.ts`: novos planos somente com `ASSINATURA_PLANOS_ATIVOS=true` **e** `ASAAS_AMBIENTE=sandbox`. Gestão e tenant são comprovados antes de reservar ou chamar o provedor. Preservados intenção anterior ao POST, ID durável, recuperação de resposta incerta e compensação. Preço, ciclo, cliente, empresa e fatura são conferidos antes de devolver o pagamento.
- O endpoint antigo não permite contornar a seleção do plano ou usar preço legado numa contratação nova. Contratos 074 já confirmados podem retomar cobrança sem depender das variáveis de preço legado; não criam nova assinatura por esse caminho. Recontratação e troca de plano continuam exigindo atendimento.
- `pagamento-oferta.ts` e `sincronizacao.ts`: só pagamento reconsultado, com empresa/cliente/assinatura/ciclo/valor correspondentes, confirma contrato e vaga e vincula o plano na mesma transação. Retorno do navegador não ativa nada. Reentrega não regrava o histórico. Pagamento posterior divergente, inclusive baixa manual em dinheiro, não amplia o período usando uma parcela anterior válida. O legado mantém suas regras anteriores.
- A conferência de renovação espera o preço normal após o benefício. A segunda cobrança anual exige preço regular mesmo se a primeira foi confirmada com atraso. Isso **valida pagamentos**, mas ainda não agenda aviso nem atualiza o preço no Asaas.
- `consulta.ts`, `Assinatura.tsx` e `AssinaturaAcoes.tsx`: seleção de plano/ciclo dentro do sistema, retomada da oferta pendente, preço após Fundador e identificação do plano ativo. Anual é apresentado como pagamento único no valor de dez mensalidades.
- `estado.ts`: isenção persistida mantém acesso comercial completo; permissões e isolamento da empresa continuam sendo verificados. Não foi criada isenção real nem concedida por CNPJ autodeclarado.
- Reconciliação e operações que travam a assinatura adquirem antes a trava da empresa quando a 074 está instalada. O sincronizador existente continua consultando o provedor sob a trava para não aplicar leitura obsoleta; não houve refatoração desse comportamento neste goal. Aumenta a necessidade de homologar latência/deadlocks em PostgreSQL antes da ativação.

### Validação local deste goal

- Suíte sintética de assinatura: **78/78 aprovados**, incluindo **18 testes novos** de oferta, teto/reserva, preço adulterado, autorização, criação/retomada, fatura divergente, confirmação, reentrega, legado e renovação. Banco e provedor são mocks; não há teste de concorrência real nesses números.
- Regressão estática ampla: **2.125 testes + 103 do harness aprovados**, TypeScript aprovado, lint sem erros (um aviso preexistente em `lib/inteligencia/skills/catalogo.ts`). Quatro cenários adicionais foram acrescentados depois e incluídos na suíte final de 78 testes acima.
- O build do check amplo foi bloqueado pelo sandbox do Windows ao resolver o caminho do compilador (`Acesso negado`, `jsc.baseUrl`). O build final foi repetido fora desse bloqueio e **aprovado**, incluindo TypeScript. Resultado registrado no log local `planos-checkout-build.log`.
- ESLint dos arquivos finais alterados sem avisos. Nenhum teste PostgreSQL, envio de e-mail ou chamada real de cobrança executado. Node local **24.20.0**; a versão declarada pelo projeto é **22.23.2** e ainda precisa de repetição na homologação.

### Renovação com aviso — evolução no goal seguinte

A decisão foi complementada: renovar pelo valor normal com aviso **30 dias antes, por e-mail e no sistema**. A rotina durável, a migration 075 e os testes sintéticos foram preparados localmente; detalhes e plano de homologação em [Renovação Fundador](RENOVACAO_FUNDADOR_20261009.md). Os parágrafos seguintes preservam os requisitos que orientaram essa implementação.

A rotina precisa reconsultar a assinatura, preservar cancelamento/isencão e aplicar o valor regular às cobranças correspondentes à renovação. O Asaas distingue alteração das próximas cobranças e alteração das já geradas; não usar atualização indiscriminada das pendentes, pois uma parcela vencida anterior ao fim do benefício continua tendo seu preço original. Referências oficiais: [atualizar assinatura](https://docs.asaas.com/reference/atualizar-assinatura-existente) e [atualizar cobrança](https://docs.asaas.com/reference/atualizar-cobranca-existente).

Tratar falhas de aviso, resposta perdida e aplicação parcial sem duplicar cobrança, aumentar preço silenciosamente ou renovar desconto indefinidamente. A simulação deve impedir tanto envio de mensagem quanto mutações no provedor. Nenhum cron ou trabalhador foi criado. Avisos, renovação no provedor e homologação PostgreSQL são **pendências impeditivas da venda real**, não funcionalidades entregues por este goal de checkout local.

Também permanecem: confirmar e vincular a isenção ao ID real da Kidmais em operação autorizada; homologar up/down e concorrência da 074; aplicar limites/recursos por plano no servidor; definir upgrade/downgrade e liberar reservas abandonadas somente após comprovar que não há cobrança pagável. Não ativar em produção apenas porque os testes sintéticos passaram.

## Limites de pessoas — decisão e implementação de 09/10/2026

Felipe confirmou: Gestão, pessoas com conta ativa e vínculo ativo, e convites pendentes dentro da validade contam como vagas. Essencial permite 3, Profissional 10 e Premium não tem limite. Uma pessoa já ativa não conta novamente pelo mesmo email em convite. Convites vencidos, cancelados e aceitos não reservam vagas.

`lib/assinatura/limites-usuarios.ts` calcula ocupação para a empresa comprovada e somente para contratação confirmada; trial, legado e isenção preservam o acesso atual. Criação de convite, renovação de convite vencido, criação direta e reativação de vínculo consultam vagas na mesma transação, com trava da empresa antes da contagem. A tela de assinatura informa ocupação e limite.

Empresas acima da cota mantêm acessos. Convites ainda válidos podem ser reenviados/aceitos porque já reservaram vaga; novas reservas são recusadas, sem revogar acessos para adequar a cota. O aceite foi ajustado para adquirir as travas na ordem usuário → empresa → convite e revalidar o token após a trava. Esta mudança não concede recursos adicionais nem habilita upgrade/downgrade.

Revisão posterior do aceite: a conclusão agora exige, na própria SQL, convite ainda pendente e `expira_em > clock_timestamp()`. Se a prova de senha atravessar a expiração, a atualização não retorna linha e o serviço lança `LINK_INVALIDO` dentro da transação, desfazendo os vínculos/identidade criados na tentativa. Testes sintéticos confirmam aceite de reserva válida no limite/acima dele, aborto transacional na expiração final e recusa de token cancelado/substituído/expirado após esperar a trava. A prova física do rollback em PostgreSQL continua pendente.

Testes sintéticos cobrem limites, isenção, legado, recusa de nova reserva sem email/DML e reenvio válido versus vencido. TypeScript, ESLint e build Next.js aprovados em cópia sem credenciais. Concorrência física das vagas em PostgreSQL e teste autenticado da tela publicada permanecem pendentes; mocks não comprovam locks reais. As evidências anteriores neste documento são históricas, não substituem a validação da candidata atual.

## Ensaio publicado — interrupção e recuperação da terceira rodada

A retomada criou somente a fixture aprovada `e4b274ca-3a51-40c5-bef6-39012a96cfbc`, seu usuário sintético e assinatura sandbox. O cron de preflight encontrou o cliente. O terminal foi perdido antes da liberação para pagamento; não houve intenção de confirmar pagamento no registro persistido. Não reutilizar essa fixture para outra rodada.

Em 09/10/2026, a recuperação conferiu identidade/ambiente/valor/referência no Asaas, cancelou somente a assinatura fictícia, desativou usuário/empresa e revogou seu vínculo. Comparou hashes dos registros comerciais de outras empresas ao snapshot anterior: preservados. O webhook existente foi reutilizado e preservado. A flag temporária `ASSINATURA_PLANOS_ATIVOS` foi removida com Save only; o deploy de recuperação mantém o commit `08aa54d`, sem publicar os limites ainda em validação local.

Pagamento, callback externo, idempotência após pagamento e cancelamento pela aplicação **não foram homologados por esta rodada**. Próxima rodada exige fixture nova e autorização concreta. Evidência: [recuperação](evidencias/assinatura-rodada3-recuperada-20261009.png).

## Plano concreto da quarta rodada — preparado, execução não autorizada

Alvos exclusivos: web staging `srv-daif418ae00c73e8k2gg`, cron staging `crn-db493i142hec73ahmoe0`, banco `kidmais_staging_1z91` no host interno `dpg-daidko3m8hqs73ce4jt0-a` e conta Asaas sandbox configurada nesses serviços. Produção e banco local real ficam fora do plano.

1. Publicar a candidata revisada com limites de vagas e harness da rodada 4. Habilitar temporariamente `ASSINATURA_PLANOS_ATIVOS=true` somente no web e realizar deploy manual; sem migrations ou troca de conexão.
2. Criar exclusivamente empresa sintética `531f9c46-6026-4bfe-86aa-babce78b0cfd`, usuário `a3f1de69-7ed9-47aa-9864-4b8f7fca8c65`, email `assinatura-staging-a3f1de69@example.invalid`, CNPJ fictício e vínculos/contratação associados. Guardar registro no diretório privado `data/ensaio-assinatura-20261009-4`; recusar fixture ou registro de rodada já usado.
3. Executar o harness `--rodada-4-autorizada` como processo independente do terminal (`nohup`, entrada fechada, umask 077, log sanitizado no diretório privado). Não reiniciar/deployar o web enquanto estiver rodando. Se o processo morrer, apenas recuperar recursos comprovadamente próprios; não reiniciar o checkout nem regenerar pagamento cegamente.
4. Cron temporário `node --experimental-strip-types scripts/assinatura-staging-preflight.cjs --rodada-4`: deploy, autenticação por sua própria chave e leitura da referência sintética. Restaurar comando normal `node scripts/assinatura-cron.cjs` com deploy antes de liberar o marcador `cron-conferido` no web.
5. Checkout sandbox Essencial mensal: R$ 118,20 com Fundador ou R$ 197,00 sem benefício, teto R$ 197,00, sem dinheiro real. Confirmar apenas a cobrança da assinatura/cliente dessa fixture. Validar entrega externa autenticada, acesso completo, contratação/Fundador únicos, replay idempotente e rodada agendada do cron sem duplicação. Verificar ocupação de uma vaga Gestão. Cancelar pela aplicação preservando período pago.
6. Recuperação mesmo em falha: cancelar somente assinatura fictícia após conferir referência/cliente/valor; desativar empresa/usuário e revogar vínculo da fixture; preservar webhook existente. Remover somente webhook temporário se criado pela rodada e comprovado pelo ID/nome/URL. Comparar hashes comerciais das outras empresas; remover flag temporária e deployar recuperação; conferir cron normal, ausência da flag e health.

O harness e preflight foram preparados com IDs novos e recusa de flags ambíguas. Este plano não autoriza sua execução: conforme `OPERACAO_AGENTES.md`, env, deploy e SQL de escrita exigem aprovação explícita para estes alvos/ações.

## Auditoria do goal após preparação — 09/10/2026

Conferência atual: código local/branch em `3111f5a`; último deploy web `dep-db4j4n0nilcs73abfesg`, commit `08aa54d`, LIVE. Cron confirmado com comando normal, auto-deploy desligado e execução bem-sucedida às 18:45:22 UTC. Não há ensaio de pagamento confirmado como processo em andamento. A rodada 3 é terminal e foi recuperada; o registro não autoriza reutilizar os IDs.

| Requisito da integração | Evidência conferida | Resultado |
| --- | --- | --- |
| Diagnosticar conflito de webhook e preservar o existente | Harness com precheck antes de DML, reuso compatível e testes; registro da recuperação | Correção preparada; autenticação da entrega externa ainda depende de pagamento sandbox |
| Checkout, pagamento, callback, acesso completo e Fundador | Rodada 3 interrompida antes da confirmação; `naoComprovadoNestaRodada` no JSON de recuperação | Ensaio não concluído |
| Reentrega e cron sem duplicação após pagamento | Harness da rodada 4 contém verificações; cron normal teve sucesso operacional | Sucesso do cron isolado não comprova o fluxo pago; pendente |
| Cancelamento pela aplicação preserva período pago | Harness preparado; recuperação cancelou assinatura fictícia diretamente no provedor | Cancelamento pela aplicação após pagamento não comprovado |
| Preservar empresas existentes e recuperar teste | Cancelamento da assinatura própria, desativação da fixture, hashes comerciais iguais, flag removida, deploy LIVE e smoke PASS | Recuperação da rodada 3 comprovada |
| Contar Gestão/ativos/convites; preservar acesso acima da cota | Código de vagas, testes de convite/aceite, TypeScript, ESLint e build | Preparado na branch; não publicado nem homologado em PostgreSQL para concorrência |
| Renovar Fundador com aviso de 30 dias por email e sistema | Rotina/repository/075 e testes existentes; CLI aplicar exige alvo local e email em arquivo | Cron remoto atual só reconcilia assinatura; envio e renovação remotos não entregues |
| Isenção permanente da Kidmais real | Estrutura por ID no código; nenhuma consulta/escrita ao buffet real nesta rodada | Vínculo real ainda exige operação autorizada específica |

Próxima ação executável para comprovar o fluxo publicado: aprovação da quarta rodada acima. A mesma aprovação pendente foi registrada em três turnos consecutivos; as correções locais independentes de vagas/aceite e a preparação do harness foram concluídas nesse intervalo. Continuação automática não é aprovação para uma fixture nova. O goal não está concluído e deve aguardar a resposta antes de env/deploy/DML de teste. Avisos/renovação remotos, isenção real e liberação comercial exigem seus próprios planos e autorizações após a homologação do fluxo pago.

## Quarta rodada — autorizada, executada e recuperada em 09/10/2026

A resposta posterior de Felipe, “autorizo”, autorizou o plano concreto da quarta rodada. A candidata `850287b` foi publicada em staging e o harness executou em processo independente. O cron de preflight encontrou a referência sintética usando sua própria chave às 20:15:20 UTC; o comando normal foi restaurado e publicado antes da liberação do pagamento.

Comprovados: checkout Essencial mensal com Fundador a R$ 118,20; confirmação sandbox; entrega externa autenticada; acesso completo; uma contratação e uma vaga Fundador confirmadas; limite Essencial de 3 pessoas com uma Gestão ativa e nenhum convite; replay sem duplicação; reconciliação agendada às 20:20:21 UTC sem duplicação; cancelamento pela aplicação preservando acesso durante o período pago.

**Resultado original do harness: INCOMPLETO, saída 2.** A desativação foi commitada, mas a comparação integral dos registros das outras empresas falhou em `empresa_assinaturas`. Contratos, Fundador e isenções mantiveram os hashes integrais. Uma assinatura de outra empresa foi sincronizada durante a janela. O código de reconciliação escreve `sincronizado_em` e o banco mantém metadados; essa é uma explicação possível, não prova retrospectiva de quais colunas mudaram. Sem baseline comercial separado, não declarar preservação integral das condições nem converter o resultado em PASS.

A consulta somente leitura posterior confirmou empresa fictícia desativada, usuário inativo e vínculo revogado. A assinatura sandbox própria foi cancelada, o webhook existente foi preservado e a flag temporária removida. Deploy de recuperação `dep-db4kr0flot8c73be3co0`, commit `850287b`, LIVE às 20:30:22 UTC; regressão Render completa e health PASS. A flag foi comprovada ausente na nova instância. O `limpezaBancoPendente` original veio da comparação após o COMMIT, não de desativação desfeita; registro original preservado.

Correção preparada localmente: `scripts/assinatura-preservacao.cjs` guarda digests integral e comercial antes da fixture, separando somente `sincronizado_em`, `atualizado_em` e `versao` de `empresa_assinaturas`. Todas as demais colunas, inclusive situação, período, plano, provedor e vínculo, permanecem protegidas; contratos/Fundador/isenções protegem todas as colunas. Baseline ausente é recusado. A limpeza SQL e a falha de preservação agora têm marcadores distintos. **18 testes pertinentes, TypeScript, ESLint e build em cópia isolada aprovados.** Correção não implantada nesta recuperação e não aplicável retroativamente à rodada 4.

Evidências: [registro sanitizado](evidencias/assinatura-rodada4-20261009.json) e [runtime recuperado](evidencias/assinatura-rodada4-recuperada-20261009.png). IDs desta rodada estão consumidos; não reiniciar o harness. Nova fixture/deploy/ensaio exige plano e autorização próprios. Avisos/renovação remotos, isenção real, concorrência física das vagas e promoção comercial continuam pendentes.

Continuação preparada e testada: [plano da quinta rodada](ENSAIO_ASSINATURA_RODADA5_20261009.md), com IDs novos e comparação corrigida. 20/20 testes pertinentes, TypeScript, ESLint e build isolado aprovados. Ainda sem autorização de execução; sem novo checkout, pagamento, env ou deploy realizado para essa rodada.
