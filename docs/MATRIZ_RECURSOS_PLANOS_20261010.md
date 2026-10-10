# Recursos por plano — revisão local de 10/10/2026

## Resultado e alcance

A vitrine diferencia recursos entre Essencial, Profissional e Premium. A implementação comercial consultada aplica preços, condição Fundador e limites de pessoas; não foi encontrada uma autorização central por recurso vinculada ao plano contratado. O paywall atual decide pelo estado da assinatura, não pela lista de módulos do plano. Portanto, a matriz abaixo é um diagnóstico do código, não comprovação de disponibilidade em produção nem autorização para retirar acessos existentes.

Revisão local, sem consultas de banco, credenciais, provedores, mudanças de ambiente ou deploy. Base: commit `fecdf3d`. Preservar a gratuidade da Kidmais e todos os acessos existentes enquanto a identidade e a concessão permanente não estiverem conferidas.

## Oferta e implementação

| Item | Essencial | Profissional | Premium | Evidência / pendência |
|---|---|---|---|---|
| Pessoas | 3 | 10 | Ilimitadas | `lib/assinatura/limites-usuarios.ts`: Gestão, usuários ativos e convites pendentes válidos; não duplica convite de pessoa já ativa. Contrato confirmado limita novas vagas; trial, legado e isenção preservados. Falta ensaio físico de concorrência. |
| Agenda, clientes, festas, pacotes e contratos | Incluídos | Incluídos | Incluídos | Módulos presentes; permissões e tenant continuam obrigatórios. Status da vitrine não comprova ativação remota. |
| Pix e contas a receber | Incluídos | Incluídos | Incluídos | Não confundir Pix do cliente do buffet com cobrança da assinatura Kidmais pelo Asaas. |
| Contas a pagar, fluxo de caixa e relatórios | Excluídos | Incluídos | Incluídos | A descrição de “financeiro completo” está em `lib/site/catalogo.ts`. `lib/financeiro/http.ts` passa pela guarda geral da assinatura; ainda falta separar as operações por plano. |
| Orçamento online e horário nobre | Excluídos | Incluídos | Incluídos | Exclusão existe na vitrine; não foi encontrada barreira comercial por esses recursos no catálogo de planos do servidor. A futura barreira deve cobrir APIs e caminhos públicos, além do menu. |
| Importação por IA | Na implantação | Contínua, com cota | “Sem cota” | Vitrine marca Em breve. Não há quantidades comerciais definidas. Orçamento técnico da IA não equivale a franquia contratada. “Sem cota” precisa esclarecer limites operacionais antes da liberação. |
| Copiloto | Excluído | Franquia básica | Franquia ampla | Em breve; faltam quantidades, período, consumo e política de excedentes. Não atribuir franquias inventadas. |
| Wall-e no WhatsApp | Sem inclusão anunciada | Adicional | Franquia incluída | Em breve; não há franquia definida ou contratação de adicional habilitada. Não habilitar cobrança por uso automaticamente. |
| Código de assinatura no WhatsApp, cartão e convite da festa | Dependem do item anunciado | Dependem do item anunciado | Dependem do item anunciado | Em breve; exigem homologação e configuração próprias. Convite da festa é distinto do convite de acesso que ocupa vaga de usuário. |
| Suporte | E-mail | WhatsApp | Prioritário | Oferta de atendimento humano; depende de canais e operação definidos. Não tratar como autorização de módulo. |
| Implantação | Oferta avulsa; anual anuncia gratuidade | Mesma condição | Dedicada | Execução humana e condições de serviço precisam estar prontas; não comprova importação IA ativa. |
| Unidade extra | Adicional anunciado | Adicional anunciado | Adicional anunciado | Preço anunciado não comprova contratação, tenant ou unidade adicional provisionada. Não criar unidade nem cobrar sem fluxo homologado. |

Fontes: `lib/site/catalogo.ts`, `components/site/Planos.tsx`, `components/site/elementos.tsx`, `lib/assinatura/planos-comerciais.ts`, `lib/assinatura/limites-usuarios.ts`, `lib/assinatura/paywall.ts`, `lib/financeiro/http.ts`, `lib/convites/service.ts` e `lib/inteligencia/modelos/orcamento.ts`.

## Critérios para implementar a separação dos módulos

1. Resolver a empresa pela sessão/tenant e ler somente o contrato confirmado atual. Nenhum plano informado pelo navegador autoriza recurso.
2. Preservar legado, empresa isenta e acessos já existentes. Não converter a falta de contrato em Essencial nem bloquear a Kidmais por falta de identificação.
3. No teste de 15 dias, liberar os recursos efetivamente disponíveis; Em breve continua indisponível. A escolha do plano ocorre ao assinar, conforme decisão de Felipe.
4. Diferenciar a situação comercial (assinatura ativa, leitura ou suspensão) da inclusão do recurso no plano. Manter recuperação da conta, cobrança e exportação acessíveis pelas regras atuais.
5. Mapear cada operação de financeiro, orçamento e horário nobre à autorização de servidor. Ocultar um menu não basta. Caminhos públicos e ações da IA devem respeitar a mesma empresa e regra.
6. Definir como consultar e exportar dados de um módulo após mudança de plano antes de habilitar upgrade/downgrade. Esse fluxo ainda não está habilitado; não inventar uma política retroativa.
7. Para IA/WhatsApp, aprovar unidade de consumo, período, quantidade, renovação de saldo e excedentes antes da cobrança. Manter os tetos técnicos de segurança/custo independentemente da franquia comercial.
8. Homologar com empresas sintéticas: recurso incluído funciona, excluído é recusado no servidor, outro tenant não atravessa a barreira, trial e isenção preservados, falha de leitura do contrato não concede um recurso pago indevidamente.

## Próxima validação independente preparada

Validar as vagas em PostgreSQL isolado, sem tocar staging, produção ou o banco local real `kidmais_manager`:

- Duas conexões disputam a última vaga do Essencial: somente uma cria reserva; a outra recebe `LIMITE_USUARIOS_PLANO` após a trava.
- Convite válido aceito transforma reserva em pessoa ativa sem aumentar a ocupação; aceite duplicado não cria outro vínculo.
- Convite vencido/cancelado libera a vaga; reenvio de convite vencido precisa disputar uma nova vaga.
- Falha após a reserva reverte convite/vínculo por rollback, sem consumir vaga.
- Empresa acima do limite mantém vínculos e sessões, mas não recebe novos convites.
- Profissional usa o teto 10; Premium não aplica teto comercial; isenção e legado permanecem livres.
- Alterações e resultados ficam restritos a fixtures próprias e dados sintéticos. E-mail falso e bloqueio de rede externa durante o ensaio.

Esta lista define o aceite do ensaio; **não é um teste executável nem um resultado aprovado**. Preparar o executor e revisar seus efeitos antes de solicitar a execução no alvo isolado exato. A política `OPERACAO_AGENTES.md` exige autorização explícita para escritas de banco, inclusive isolado; o pedido genérico de próximo passo não autoriza nova operação de banco.

## Pendências que permanecem

A identificação exata da Kidmais continua pendente: os três diagnósticos aprovados não retornaram correspondência do CNPJ informado nas fontes consultadas. Falta confirmar o CNPJ exibido e se o perfil foi aplicado ou está em rascunho. Não repetir sessões de produção já encerradas nem procurar outras empresas por aproximação.

Renovação persistida/publicada, ensaio real de renovação sandbox, processamento periódico e pacote de liberação comercial continuam pendentes conforme `CONCLUSAO_INTEGRACAO_20261009.md`. Esta revisão não habilita módulos, planos em produção, cobranças, mudanças de acesso ou rotinas remotas.
