# Clientes / CRM

## Objetivo
Centralizar dados de clientes e permitir reutilização segura do cadastro em novos fechamentos.

## Regras oficiais
- clientes existentes devem ser identificados e reaproveitados quando apropriado;
- endereço deve poder ser preenchido por CEP;
- contatos podem ser mascarados conforme contexto e permissão;
- cadastros incompletos devem ser identificados por critérios objetivos;
- exclusão deve seguir fluxo seguro de exclusão lógica/arquivamento;
- exclusão lógica exige dupla confirmação;
- cliente arquivado sai da lista ativa, permanece em histórico/lixeira e pode ser restaurado;
- vínculos com contratos, pagamentos, festas e fechamentos devem ser preservados;
- exclusão física só pode ocorrer quando não quebrar integridade histórica.

## SaaS
- cliente pertence ao escopo da empresa;
- associação com estabelecimentos deve ser rastreável quando houver operação em múltiplas unidades;
- uma empresa nunca pode acessar clientes de outra.
