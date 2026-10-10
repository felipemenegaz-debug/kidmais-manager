# Identificação da Kidmais — hipótese do rascunho

Felipe reconfirmou em 10/10/2026 a Kidmais Festas em produção com CNPJ `20.119.900.0001-60`. Normalizado, é `20119900000160`, o mesmo documento das consultas anteriores; pontuação não explica a ausência de correspondência no perfil aplicado.

Leitura de metadados Render confirmou deploy LIVE `dep-db49tpu7bikc73e2l4lg`, commit `4af8b38e52c8b8c5724ade980d900face0c73562`. O código desse commit foi buscado por Git, sem alterar a branch de trabalho. `lib/perfil/cadastro-service.ts` lê o aplicado de `perfil_empresas.cnpj` e o rascunho de `perfil_empresa_revisoes.conteudo`. `lib/perfil/tela-cadastro.ts`, função `aposCarga`, prefere `contexto.rascunho?.conteudo` no preenchimento da tela. Assim, ver o CNPJ na tela não distingue rascunho de aplicado. **Hipótese, ainda não diagnóstico confirmado por dados.** Nenhuma nova consulta SQL foi executada.

## Operação concreta preparada, aguardando autorização

Uma única sessão Shell do web existente `srv-dak77m2d0e5s73b8rkkg`, workspace `tea-daidbj95efls73d2bcf0`, até cinco minutos. Sem nova instância, deploy, restart ou alterações de infraestrutura. Pode haver cobrança por duração da sessão no plano atual.

Alvo exclusivo: PostgreSQL `dpg-dak750gae00c73fudmg0-a:5432`, banco `kidmais_production`. [SQL](../database/checks/20261010_kidmais_rascunho_identidade_production.sql) e [comando exato](evidencias/kidmais-rascunho-production-comando-20261010.txt) preparados. Sintaxe JavaScript e reversibilidade das aspas do comando conferidas localmente, sem executá-lo ou acessar credenciais.

O comando reutiliza as guardas revisadas da última leitura aprovada: identidade Render/serviço/ambiente, URL host/banco/porta fixos, TLS existente sem override em parâmetros, comparação de banco/TLS antes da consulta, `BEGIN READ ONLY`, conexão 5s, statement 10s, lock 3s, `ROLLBACK` e fechamento. A única mudança de escopo é a fonte do rascunho atual; as sessões anteriores únicas já terminaram.

Consulta apenas `estado='RASCUNHO'` e CNPJ exato normalizado em `conteudo->>'cnpj'`. Não percorre histórico aplicado/descartado, nomes aproximados, documentos diferentes ou conteúdo JSON integral. Retorna IDs do perfil/empresa, número/edição, nome comercial do rascunho, correspondência booleana do CNPJ aplicado e ID de Felipe somente se já possuir Gestão ativa. Associação do perfil ao tenant usa a regra real da aplicação e recusa ambiguidade. Não confere titularidade fiscal nem concede acesso.

Se zero/múltiplos resultados, ambiguidade ou falha, registrar e fechar; sem repetir ou ampliar a pesquisa. Depois de salvar a saída sanitizada, enviar exit e fechar a aba, sem reconectar para conferir. Não aplicar perfil, conceder isenção, alterar cobrança/usuários, chamar provedores ou testar funcionalidades em produção. Não mudar rede, TLS, env ou credenciais. Banco local real permanece proibido.

Se o rascunho corresponder, essa evidência pode localizar o perfil/tenant, mas a gratuidade permanente ainda exige identidade conferida e uma proposta auditada de concessão aprovada separadamente. Não aplicar rascunho em nome do usuário por inferência.

A autorização adicional decorre de `OPERACAO_AGENTES.md`: “Acesso direto a banco deve estar explicitamente no escopo e ter o destino validado”. A fonte rascunho não estava no escopo das sessões já concluídas.

## Resultado após autorização

Felipe autorizou expressamente: “autorizo a leitura do rascunho”. Executado uma vez o comando preparado, na instância existente m6jzq. Identidade do banco e TLS conferidos; tabelas presentes; consulta retornou zero rascunhos correspondentes. [Resultado sanitizado](evidencias/kidmais-rascunho-production-resultado-20261010.json) e [captura](evidencias/kidmais-rascunho-production-resultado-20261010.png).

Sessão aberta após 03:10:02 UTC de 10/10/2026; comando terminou e exit foi enviado, seguido do fechamento da aba dentro dos cinco minutos. Lista de abas vazia. Isso registra o fechamento do navegador, sem alegar confirmação do desprovisionamento por API. Nenhum SQL adicional, mudança de dados ou concessão. A hipótese do rascunho não foi confirmada; não prova ausência da Kidmais em outra origem/instalação. Antes de outra leitura, falta confirmar a URL exata da tela em que Felipe vê esse CNPJ; não repetir Shell ou ampliar busca por inferência.
