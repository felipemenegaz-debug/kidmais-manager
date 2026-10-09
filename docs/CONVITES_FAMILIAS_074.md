# Convites: famílias e links individuais — 09/10/2026

Status: implementação local preparada; **migration 074 não executada, recurso não publicado**. A simplificação visual do editor é independente e já está em staging no commit `45f8336`.

## Comportamento

Buffet e organizador cadastram uma família com nome e previsão de adultos/crianças. O painel separa pendentes, confirmações, recusas e arquivadas, com busca. Cada família recebe um link próprio, copiado pelo usuário para envio manual. Nenhuma mensagem é enviada automaticamente; cadastro e RSVP não consomem créditos de IA.

O visitante abre o convite com as cores e arte publicadas, vê o nome da família e registra sua presença e quantidades. O mesmo link consulta e atualiza uma única resposta em qualquer dispositivo. Nome e identificador vêm do cadastro no servidor; o visitante não escolhe outra família enviando um UUID. A troca entre links na mesma aba recarrega o contexto, e o atalho de confirmação preserva o acesso.

Renovar ou revogar invalida o link anterior e preserva a resposta. Arquivar revoga o link e retira a família dos totais, sem apagar a resposta. Restaurar recupera o cadastro/resposta e exige gerar novo link. Revisões por família evitam sobrescrever alterações de outra pessoa; essas operações não salvam nem substituem edições pendentes da arte.

O link geral continua funcionando por dispositivo. Suas respostas não são associadas automaticamente às famílias cadastradas. Se uma pessoa responder pelas duas modalidades, pode aparecer duas vezes; o painel explica essa distinção. Limites: 500 cadastros por convite, incluindo arquivadas; até 20 adultos e 20 crianças por resposta; teto existente de 2.000 respostas e limite HTTP agregado mantidos.

## Acesso e dados

Token aleatório de 256 bits, armazenado somente como SHA-256. A URL usa fragmento `#familia=...`; a API recebe o token pelo cabeçalho Authorization, nunca por query string. Não é persistido no localStorage. A resposta privada de criação/renovação é o único lugar que entrega o link em claro; listagem, histórico e auditoria não devolvem o token/hash. As respostas HTTP permanecem sem cache e sem referer.

Links recém-gerados ficam disponíveis apenas na aba atual. Após fechar/recarregar, é preciso renová-los para copiar de novo, invalidando o anterior. Quem possui um link pode ver o nome e alterar a resposta daquela família; não há verificação de identidade. Isso aparece no painel antes do compartilhamento. O acesso público não revela listas de famílias nem informações do contrato.

Permissões do buffet/cliente, tenant, unidade, contrato e acesso comercial são as mesmas do editor. As mutações e RSVPs compartilham a trava do convite; revogação/arquivo são revalidados após obtê-la. Nenhuma credencial do provedor é necessária.

## Banco e compatibilidade

Arquivos: `database/migrations/20261009_074_convite_familias.sql`, precheck e postcheck homônimos em `database/checks`.

A migration cria `convite_familias`, acrescenta `familia_id` opcional a `convite_respostas`, FK composta para impedir vínculo com outra festa e índice único para uma resposta por família. O cadastro tem FK composta para o tenant do convite. Respostas existentes permanecem com `familia_id` nulo. Não há backfill, exclusão, franquia de crédito ou alteração contratual. Aplicação transacional com lock timeout de 5 segundos e statement timeout de 60 segundos; repetição/aplicação parcial é recusada pelo precheck.

O código novo **depende da 074** inclusive para listar convites existentes: não publicar antes da migration. O código atualmente em staging suporta a adição de tabelas/coluna, permitindo aplicar a migration primeiro e então implantar a nova versão. Não remover tabelas/colunas após haver respostas individuais.

## Validação preparada

Executado localmente em 09/10/2026: `check:v1:static` aprovado (2.106 testes gerais + 103 do harness sem rede/banco, TypeScript, lint, build e verificação de PDF); 19 testes CJS do serviço aprovados, além dos três testes de domínio incluídos na suíte geral; quatro suítes de navegador aprovadas. Lint sem erros; um aviso preexistente de import não usado em `lib/inteligencia/skills/catalogo.ts`. Configuração de banco sintética apontava para porta indisponível. Não houve conexão PostgreSQL nem chamada paga. Evidências locais em `.local-convites-qa/static-familias.log` e screenshots `familias-*.png`.

- Testes de domínio: campos estritos, limites, UUID e revisão.
- Serviço real com banco/provedor simulados: idempotência, isolamento entre festas/empresas, permissão, link revogado, renovação, arquivo/restauração, resposta única entre dispositivos, não sobrescrever resposta de outra família, legado e ausência de consumo de IA.
- Navegador com APIs simuladas: buffet e cliente, cadastro/cópia, preenchimento e atualização em outro contexto, mudança de link na mesma aba, filtros, revogação, arquivo/restauração, edição pendente preservada, 320/390/1365 px. Script `scripts/convites-familias-ui.cjs`. Regressões de editor, cores/PNG, exclusão de imagem e página pública também executadas.
- Harness PostgreSQL preparado em `scripts/convites-postgres.cjs`, **não executado** para a 074. Exige `scripts/testar-convites-postgres.ps1 -Executar -Incluir074`, autorização específica e cluster novo. Valida migrations 073/074, preservação de resposta legada, FKs, unicidade concorrente, idempotência e revogação antes da transação do RSVP. Dependências anteriores usam schema sintético mínimo; não substitui ensaio no schema completo de staging.

## Plano operacional para autorização

Alvos: workspace `tea-daidbj95efls73d2bcf0`; serviço `kidmais-manager-staging` (`srv-daif418ae00c73e8k2gg`); banco esperado `kidmais_staging_1z91`, host interno `dpg-daidko3m8hqs73ce4jt0-a`. Confirmar identidade novamente antes de conectar. Produção fora do escopo. Não alterar env, secrets ou cobrança.

1. Executar harness em PostgreSQL 18 descartável novo, apenas dados sintéticos, porta local 55458 e banco `kidmais_convites_v1_teste`; o runner recusa porta ocupada, não usa DATABASE_URL e para o cluster ao terminar. Não acessar `kidmais_manager`.
2. Revalidar metadados do serviço e commit candidato, conexão SSL e identidade do banco de staging. Fazer backup custom recente no disco persistente, conferir hash e inventário sem copiar dados/credenciais ao chat. Não afirmar que inventário equivale a teste de restauração.
3. Ensaiar 074 sobre o schema completo efetivo de staging: transação externa, precheck, migration sem BEGIN/COMMIT internos, postcheck, verificação de respostas legadas, ROLLBACK; repetir precheck após rollback. Espera-se adicionar uma tabela às 135 observadas na homologação anterior; conferir contagem atual antes de usar esse número. Não executar replay da cadeia histórica.
4. Após o ensaio aprovado e backup verificado, aplicar 074, conferir postcheck após COMMIT e preservação dos registros anteriores. Parar se houver divergência ou lock timeout; não repetir automaticamente.
5. Integrar somente o candidato validado em `staging`, com auto-deploy revalidado, e disparar um deploy manual. Acompanhar build/live, health e leitura autenticada do editor. Não enviar WhatsApp, chamar IA ou criar confirmações reais em nome do usuário. O teste interativo com famílias fica disponível ao usuário após ativação.

Recuperação: antes do COMMIT, rollback transacional. Se a migration foi aplicada mas o deploy não concluiu, manter o código anterior e a estrutura aditiva enquanto corrige. Após uso dos links individuais, priorizar correção adiante; código anterior pode incluir respostas de famílias arquivadas nos totais e não entende os links individuais. DROP, restore geral, desativação de módulo ou outras alterações de configuração exigem decisão específica; não são ações automáticas deste plano.

A [política operacional](OPERACAO_AGENTES.md) exige: “Migrations, writes SQL, restore, delete e alteração de `DATABASE_URL` sempre exigem autorização explícita de Felipe. A mesma exigência vale em staging e em ambientes isolados; autorização para preparar arquivos não autoriza executá-los em um banco.” A autorização anterior para a 073 não foi usada para executar a nova 074.
