# Administração da plataforma para comercialização

Planejamento de 01/10/2026 para cadastrar, ativar e apoiar empresas no Kidmais Manager. Este documento organiza implementação futura; não registra funcionalidades entregues, alterações de banco ou autorização de publicação. O próximo ciclo prioriza [UX e atendimento por IA no WhatsApp](PROXIMA_ENTREGA_UX_WHATSAPP.md).

## Situação encontrada no código

- Existem empresas, memberships, estruturas de unidades e provas de acesso. Não há cadastro comercial completo de empresa pela interface.
- [provisionarTenant](../lib/saas/provisionar-tenant.ts) não é o onboarding comercial final. Recusa a marca Kidmais e não deve ser exposto diretamente como cadastro de clientes reais.
- [provarEstabelecimento](../lib/saas/provar-estabelecimento.ts) verifica vínculos. A [migration 043](../database/migrations/20260926_043_estrutura_tenant.sql) mantém estabelecimentos novos suspensos e bloqueia a ativação operacional enquanto a decisão D03 está adiada.
- O Perfil da Empresa edita o cadastro existente e tem provisionamento inicial próprio. É necessário mapear explicitamente o perfil à empresa e suas unidades antes do cadastro comercial de múltiplas empresas. Não usar a coincidência de haver uma empresa em cada estrutura como associação permanente.
- A [autoridade de plataforma](../lib/autenticacao/plataforma.ts) usa hoje o papel global legado REPRESENTANTE_AUTORIZADO. O papel de representante de uma empresa não concede essa autoridade. O desenho de permissões abaixo é futuro e exige compatibilização com esse modelo.
- A [configuração de WhatsApp](../lib/whatsapp/onboarding.service.ts) é hoje por ambiente e usa autoridade de plataforma. Uma conexão configurada não comprova atendimento automático funcional.

Estas são constatações do checkout consultado. Não houve inventário remoto ou consulta a dados de produção nesta preparação.

## Organização proposta

O painel da plataforma fica separado do painel operacional das empresas. Uma empresa reúne identidade comercial, assinatura e acessos. Uma unidade pertence a essa empresa e possui endereço e agenda próprios. O cliente não ganha autoridade de plataforma ao ser cadastrado.

| Área | Primeira versão comercial | Evolução posterior |
| --- | --- | --- |
| Empresas | Listar, criar, retomar configuração, revisar, ativar e suspender com motivo | Cadastro iniciado pelo cliente via convite |
| Unidades | Criar e configurar unidades da empresa, controlar limites | Configurações e catálogos específicos por unidade |
| Planos e assinaturas | Recursos, limites, teste e cobrança registrada manualmente | Cobrança recorrente e reconciliação com provedor |
| Responsáveis e acessos | Convites, expiração, revogação, acesso mínimo | Papéis específicos para suporte, comercial e financeiro da plataforma |
| Configuração inicial | Pendências de perfil, logo, contrato, catálogo e WhatsApp | Guias e modelos iniciais reutilizáveis |
| Suporte | Chamados, responsável, autorização temporária de acesso | SLA, busca de problemas recorrentes e central de ajuda |
| Auditoria | Alterações sensíveis com ator, motivo e resultado | Consulta avançada e exportação controlada |
| Saúde e consumo | Falhas, situação de integrações, consumo e custos por empresa | Tendências, alertas e acompanhamento de margem |
| Comercial | Situação de implantação e responsável pela conta | Funil de interessados, demonstrações e conversão |
| Encerramento | Política de suspensão e solicitação de exportação | Exportação e exclusão com retenção definida |

## Cadastro assistido de empresa

1. Informar nome comercial, razão social, CNPJ e contato do responsável. Validar duplicidade sem revelar dados de outra empresa.
2. Criar a primeira unidade com endereço, horários e capacidade. Não ativar agenda operacional até concluir as dependências de domínio.
3. Convidar o responsável a definir a senha por um mecanismo próprio, com token temporário e de uso único. Não enviar senha criada pelo operador.
4. Configurar logo, catálogo, modelo de contrato e canal de atendimento. Salvar e continuar depois deve funcionar em todas as etapas.
5. Revisar pendências e ativar somente os recursos cujos pré-requisitos estejam satisfeitos.

Estados propostos de apresentação: Em configuração, Em teste, Ativa, Suspensa e Encerrada. Antes de criar enums ou migrations, mapear esses estados aos ciclos canônicos existentes; não duplicar o ciclo de empresa. Situação financeira e configuração de recursos são dimensões separadas.

Convites pendentes ou falhas de integrações não devem deixar uma empresa parcialmente ativa sem diagnóstico. Operações repetidas precisam retomar o cadastro existente, sem duplicar empresa, unidade, acesso ou cobrança.

## Cadastro de unidade

Empresa selecionada por contexto autorizado; nome, endereço, contato, horários, capacidade e responsáveis específicos. Oferecer cópia explícita de configurações da empresa, sem copiar clientes, contratos ou conversas. Revisar antes de ativar.

Definir antes da implementação se unidade tem catálogo próprio, preço próprio, logo próprio e contrato específico. Proposta inicial: identidade e modelo padrão da empresa; agenda, endereço e horários da unidade. Uma mesma unidade não pode pertencer simultaneamente a duas empresas.

## Modelos de contrato

Separar upload de modelo de importação de contrato histórico. O upload prepara texto, cláusulas e variáveis em rascunho, com arquivo original, versão e trechos de origem. Dados pessoais do contrato usado como exemplo não viram valores padrão do modelo.

O responsável revisa e publica uma versão. Contratos já gerados preservam a versão e os dados usados; mudar o modelo não reescreve contratos existentes. Validação do texto contratual é uma decisão da empresa, e não uma aprovação automática pela IA.

## Permissões e suporte

Permissões propostas: gerir empresas, gerir assinaturas, operar suporte e consultar auditoria. Implementar capacidades explícitas e provas no servidor, sem traduzir qualquer representante de empresa em administrador global.

Ser administrador da plataforma não deve liberar leitura indiscriminada de dados de negócio. Acesso de suporte precisa ter empresa, finalidade, autorização, prazo, revogação e auditoria. A primeira versão pode operar sem acesso a conteúdo de clientes, usando chamados e diagnóstico sanitizado. Impersonação irrestrita não entra no MVP.

## Regras comerciais a decidir

- Planos, preço, duração do teste e limites de unidades, usuários, mensagens e IA.
- Quem ativa ou suspende empresas; efeito da suspensão sobre consultas, assinaturas, atendimento e exportação.
- Cadastro iniciado por operador ou pelo cliente; proposta inicial: assistido pelo operador.
- Prazos de retenção, encerramento, exportação e exclusão, definidos com os responsáveis apropriados antes de automatizar.
- Quem paga o provedor WhatsApp e o consumo de IA; credenciais e ativos pertencentes a cada empresa.

Valores monetários, prazos e políticas comerciais não estão aprovados neste plano.

## Etapas de implementação

| Etapa | Resultado verificável | Dependência |
| --- | --- | --- |
| Fundamentos | Perfil associado explicitamente à empresa, isolamento comprovado e decisão de ativação de unidades | Revisão do Core e compatibilidade das migrations |
| Cadastro assistido | Empresa e primeira unidade criadas de forma repetível, convite e retomada | Fundamentos e autorização de plataforma |
| Operação comercial | Plano e limites aplicados no servidor, ativação e suspensão auditadas | Cadastro assistido |
| Suporte e consumo | Diagnóstico, chamados, autorização temporária e orçamento de IA | Separação de permissões |
| Escala | Cobrança automática, funil, exportação e indicadores | Política comercial e provedores definidos |

## Critérios de aceite

- Um operador autorizado cadastra e retoma uma empresa sem terminal ou SQL manual.
- Duas empresas sintéticas não compartilham clientes, contratos, agendas, documentos, conversas ou credenciais.
- Um administrador de empresa não acessa recursos da plataforma ou de outra empresa.
- Repetir uma solicitação ou convite não duplica entidades nem aumenta privilégios.
- Unidades só entram em operação quando o modelo de ativação e agenda estiver aprovado e implementado.
- Suspensão, reativação, convites e acesso de suporte têm comportamento definido e registro verificável.
- Cadastro e formulários funcionam em celular, teclado, erro e retomada.

Testes usam dados sintéticos e ambientes isolados. Operações remotas seguem [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md). Este plano não altera segredos, acessos, infraestrutura ou dados reais.
