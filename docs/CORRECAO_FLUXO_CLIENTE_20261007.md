# Correção do fechamento público — 07/10/2026

## Problema

As rotas públicas de pacotes, buffet e adicionais retornavam sempre
`CATALOGO_PUBLICO_INDETERMINADO`. O formulário parava em Personalização.
A busca por código no envio final também recusava qualquer contratação.
O atalho Fechamento do CRM apontava para esse formulário com parâmetros administrativos.

## Correção

- O catálogo usa exclusivamente a empresa ativa e a unidade configuradas no servidor
  para a agenda pública (`AGENDA_PUBLICA_EMPRESA_ID` / `AGENDA_PUBLICA_UNIDADE_ID`).
- Sem configuração válida ou sem o escopo da migration 062, permanece fechado;
  não escolhe a primeira empresa nem aceita empresa/unidade da URL.
- Pacotes precisam ser vigentes, ativos e não arquivados. Buffet usa o pacote
  resolvido; adicionais reutilizam a consulta por empresa, data e convidados.
- O envio resolve o pacote pela mesma empresa, revalida a agenda e transmite a unidade
  ao núcleo comercial. As verificações existentes de identidade continuam obrigatórias.
- O catálogo de pacotes não publica preço mínimo sem data/convidados. A cotação
  definitiva continua no núcleo comercial.
- Links antigos de atendimento redirecionam à seleção de cliente; o CRM abre o
  fechamento administrativo autenticado. Dados digitados na página antiga não são transferidos.

## Validação local

- Regressão: 2058 testes unitários e 103 testes do harness de staging, sem falhas.
- Acrescentado teste do POST público: suíte administrativa reexecutada, 48/48.
  Exercita a rota e busca real do repositório com banco e serviço de criação simulados;
  pacote de outra empresa é recusado, unidade forjada é ignorada.
- Casos públicos: contexto ausente/inválido/inativo, schema antigo, revisões ambíguas,
  empresa forjada na URL, pacotes/buffet/adicionais da empresa configurada.
- TypeScript, lint e build aprovados; worker PDF do build aprovado.
  Lint global tem um aviso preexistente em `lib/inteligencia/skills/skills.ts`.
- Build inicial sem rede falhou ao baixar Google Fonts; build com rede aprovado.
- Executado com Node 24.20.0; o projeto declara Node 22.23.2.

## Publicação e recuperação

Ainda não publicado. Nenhum banco real foi usado para testes. Nenhuma migration ou
alteração de variável de ambiente faz parte do patch. Homologação com PostgreSQL
e navegador no ambiente publicado continua pendente.

Antes da liberação, conferir a configuração pública do ambiente sem expor valores
e homologar disponibilidade → fechamento → adicionais → envio em staging.
Se a configuração estiver ausente/inválida, o patch continuará recusando o catálogo;
qualquer ajuste operacional exige autorização específica.

Publicar primeiro em staging, depois promover somente este patch para production
com autorização de Felipe. Registrar o commit/deploy anterior ao publicar.
Rollback: reimplantar esse commit anterior, sem rollback de banco (não há migration).
Isso também restaura o bloqueio anterior do fluxo público.
