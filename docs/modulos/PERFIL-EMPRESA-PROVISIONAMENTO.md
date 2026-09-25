# Provisionamento inicial do Perfil da Empresa

Data: 25/09/2026. Status: procedimento redigido, sem execução. Não cria empresa, unidade nem concessão enquanto Felipe não autorizar o ambiente e a conexão. A tela em `/admin/configuracoes/perfil-empresa` consulta e edita somente depois das migrations 026, 027 e 028 e desse provisionamento. Antes disso ela informa estrutura ausente ou empresa não provisionada e não concede acesso. Doubles não comprovam execução de SQL nem concorrência no PostgreSQL.

Ordem, cada uma com autorização própria:

1. Aplicar `database/migrations/20260925_026_perfil_empresa_estrutura.sql` e os checks 026. O postcheck de zero linhas só vale nessa instalação.
2. Aplicar `database/migrations/20260925_027_perfil_empresa_cadastro.sql` e os checks 027. O postcheck de zero revisões só vale antes do primeiro rascunho.
3. Aplicar `database/migrations/20260925_028_perfil_empresa_revisao_aplicacao.sql` e os checks 028. O postcheck confere as colunas que o serviço usa e o motivo não nulo da revisão aplicada. Não exige zero linhas.
4. Confirmar em canal privado a conta de Gestão ativa. O identificador sozinho não prova titularidade. Este arquivo não guarda e-mail nem credencial.
5. Rodar `node scripts/perfil-empresa-provisionar.cjs --autorizado-por-felipe` com `KIDMAIS_PERFIL_PROVISIONAR=CONFIRMAR`, em terminal interativo. A conexão é digitada sem eco. O operador declara host, nome do banco e ambiente (`staging` ou `producao`); o nome do banco não prova o ambiente. Produção ainda exige `AUTORIZAR-PRODUCAO`. Sem as marcas de autorização, o script encerra antes de abrir conexão. A confirmação da conta usa só o sinal mascarado.
6. O script trava `kidmais:perfil-empresa:provisionamento-inicial` antes da primeira empresa e, em seguida, `kidmais:perfil-empresa:${id}`. Se não houver empresa, cria uma e uma unidade. Se já existir exatamente uma empresa e uma unidade, reutiliza os identificadores. Qualquer outro formato interrompe sem concessão. Não duplica concessão ativa e não cria recuperação. Dentro da transação, relê e trava operador e conta, exige Gestão ativa, grava a auditoria `PERFIL_CONCESSAO_INICIAL` com operador e referência, sem e-mail nem credencial.

Staging e produção são autorizações separadas. Análise estática não comprova execução ou concorrência.
