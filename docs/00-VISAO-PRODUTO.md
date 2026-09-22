# 00 — Visão do Produto

## Propósito
O Kidmais Manager é um sistema operacional vertical para casas de festas e buffets, cobrindo o ciclo comercial e operacional desde a consulta de disponibilidade até a execução e gestão da festa.

## Origem
O produto nasceu da operação real da Kidmais. As regras de negócio foram definidas com base em necessidades concretas de CRM, disponibilidade, fechamento, contratos, pagamentos, festas, buffet e operação.

## Direção de produto
A evolução do Kidmais Manager deve transformar regras específicas da Kidmais em configurações reutilizáveis, sem enfraquecer regras centrais de segurança, integridade e auditoria.

## Hierarquia-alvo
```
Plataforma Kidmais Manager
└── Empresa / Tenant
    ├── Estabelecimento A
    │   ├── Configurações
    │   └── Dados operacionais
    └── Estabelecimento B
        ├── Configurações
        └── Dados operacionais
```

## Princípios
1. Multiempresa por padrão.
2. Múltiplos estabelecimentos por empresa.
3. Configuração por estabelecimento quando a regra puder variar entre unidades.
4. Herança de padrões da empresa com sobrescrita por estabelecimento quando aplicável.
5. Segurança, auditoria e integridade permanecem no Core.
6. O cliente deve conseguir operar e configurar o sistema sem depender de alterações de código.
7. O produto deve priorizar self-service com padrões prontos, evitando complexidade desnecessária.

## Objetivo de productização
O marco de productização é atingido quando uma segunda casa de festas, diferente da Kidmais, consegue operar o sistema sem fork e sem mudanças específicas de código.
