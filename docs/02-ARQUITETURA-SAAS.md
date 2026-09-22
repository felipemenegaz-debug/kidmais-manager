# 02 — Arquitetura SaaS

## Objetivo
Preparar o Kidmais Manager para operar como SaaS multiempresa, multiestabelecimento e configurável, preservando isolamento, segurança e auditabilidade.

## Entidades estruturais

### Empresa / Tenant
Cada empresa deve possuir, no mínimo:
- `id` interno imutável;
- `codigo` único e legível;
- nome / razão social;
- CNPJ quando aplicável;
- status;
- plano SaaS;
- administradores;
- configurações globais;
- timestamps e trilha de auditoria.

### Estabelecimento
Cada estabelecimento deve possuir, no mínimo:
- `id`;
- `empresa_id`;
- `codigo` próprio no contexto da empresa;
- nome / nome fantasia;
- endereço e contatos;
- status;
- identidade;
- configurações operacionais próprias.

Relação oficial:
```
Empresa 1:N Estabelecimentos
```

## Escopo de dados
Registros operacionais que dependem de unidade devem carregar `empresa_id` e `estabelecimento_id`, direta ou indiretamente de forma inequivocamente resolvível.

Exemplos:
- disponibilidade;
- fechamento;
- contrato;
- pagamento;
- festa;
- pacote;
- agenda;
- buffet;
- adicionais.

Clientes podem ser modelados no escopo da empresa, com relacionamento às unidades quando necessário.

## Herança de configuração
Quando aplicável:
1. a empresa define um padrão;
2. o estabelecimento herda esse padrão;
3. o estabelecimento pode sobrescrever campos permitidos;
4. a origem efetiva da configuração deve ser rastreável.

## Isolamento
Usuários da Empresa A nunca podem acessar dados da Empresa B, mesmo por manipulação de URL, ID, request manual ou falha de interface.

O isolamento deve ser imposto no backend e, quando adotado, reforçado no banco.

## Core x Configuração
### Core
- autenticação;
- autorização;
- isolamento;
- auditoria;
- versionamento;
- integridade;
- regras de segurança;
- invariantes contratuais e financeiras.

### Configuração
- pacotes;
- buffet;
- adicionais;
- horários;
- preços;
- disponibilidade;
- contratos-modelo;
- meios de pagamento;
- identidade;
- mensagens;
- usuários e permissões permitidas;
- parâmetros operacionais.

## Teste da segunda empresa
A productização só é considerada validada após operar uma empresa fictícia ou real diferente da Kidmais, com pacotes, horários, buffet, preços, contratos e regras próprias, sem alteração de código específica.
