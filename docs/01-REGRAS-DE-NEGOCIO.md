# 01 — Regras de Negócio

Este documento é o índice oficial das regras de negócio. O detalhamento fica nos arquivos de cada módulo.

## Regras estruturais
- Cada empresa/tenant possui identificador interno e código único.
- Uma empresa pode possuir vários estabelecimentos.
- Cada estabelecimento pertence a uma única empresa.
- Dados operacionais devem ser isolados entre empresas.
- Quando aplicável, dados operacionais também devem possuir escopo por estabelecimento.
- Configurações podem existir em nível de empresa e/ou estabelecimento.
- Um estabelecimento pode herdar padrões da empresa e sobrescrevê-los quando permitido.
- Nenhuma regra comercial específica da Kidmais deve permanecer fixa em código quando puder razoavelmente ser uma configuração.
- Regras de segurança, auditoria, integridade, versionamento e consistência permanecem no Core.

## Módulos oficiais
### Clientes / CRM
Ver [modulos/CLIENTES-CRM.md](./modulos/CLIENTES-CRM.md).

### Disponibilidade
Ver [modulos/DISPONIBILIDADE.md](./modulos/DISPONIBILIDADE.md).

### Fechamento
Ver [modulos/FECHAMENTO.md](./modulos/FECHAMENTO.md).

### Contratos
Ver [modulos/CONTRATOS.md](./modulos/CONTRATOS.md).

### Pagamentos
Ver [modulos/PAGAMENTOS.md](./modulos/PAGAMENTOS.md).

### Festas
Ver [modulos/FESTAS.md](./modulos/FESTAS.md).

### Buffet
Ver [modulos/BUFFET.md](./modulos/BUFFET.md).

### Configurações
Ver [modulos/CONFIGURACOES.md](./modulos/CONFIGURACOES.md).

## Regra de mudança
Toda alteração relevante de regra deve:
1. ser registrada no documento do módulo;
2. atualizar este índice quando necessário;
3. entrar no changelog funcional;
4. gerar ADR quando houver impacto arquitetural relevante.
