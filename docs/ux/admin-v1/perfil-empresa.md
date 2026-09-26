# Perfil da Empresa

UX Pilot é referência visual. A documentação funcional do Kidmais é a regra de produto. Código, APIs e migrations existentes são a implementação técnica. Alinhar cards, largura e cabeçalho não muda o contrato da API. Nenhuma funcionalidade inexistente deve ser criada só porque aparece no mockup.

## Referência visual

- Desktop aprovado: “Kidmais - AdminPerfilEmpresa”, versão 3/3, ID `NyzMuM4gcmrvcqH7WxGB`, artboard 1440×1658.
- Mobile, base visual (não chame de aprovada): versão 2/2, ID `pJtifCp4ezXtllds7P9o`, artboard 375×2465.

Tokens e o que não é pixel oficial estão em [tokens.md](tokens.md). Versões a ignorar estão em [referencias.md](referencias.md). O selo “Publicado”, o histórico inventado e “Sem número” como placeholder pertencem a versões que não são referência. Não os transforme em regra.

O ícone de menu da prancheta mobile não é especificação. A navegação funcional está em [navegacao.md](navegacao.md).

## Onde está a implementação

Tela e estilo:

- `app/admin/configuracoes/perfil-empresa/page.tsx`
- `components/admin/PerfilEmpresa.tsx`
- `components/admin/perfil-empresa.module.css`
- `components/admin/PerfilEmpresa.test.ts`

API e consulta de CEP:

- `app/api/admin/configuracoes/perfil-empresa/route.ts`
- `app/api/endereco/consultar-cep/route.ts`

Domínio:

- `lib/perfil/cadastro.ts`
- `lib/perfil/cadastro-service.ts`
- `lib/perfil/autorizacao.ts`
- `lib/perfil/capacidades.ts`
- `lib/perfil/reautenticacao.ts`
- `lib/perfil/consulta-cep.ts`
- `lib/perfil/tela-cadastro.ts`

Migrations já presentes no repositório, e já aplicadas no staging: `database/migrations/20260925_026_perfil_empresa_estrutura.sql`, `database/migrations/20260925_027_perfil_empresa_cadastro.sql`, `database/migrations/20260925_028_perfil_empresa_revisao_aplicacao.sql`. Esta documentação não autoriza nova migration.

## O que preservar

A tela consulta `GET /api/admin/configuracoes/perfil-empresa` e grava com `POST` nas ações `salvar-rascunho` e `aplicar`. A sessão administrativa entra por `exigirApiAdminCrmDisponivel`. O corpo do cadastro é o objeto `CadastroPerfil` em `lib/perfil/cadastro.ts`. Não acrescente campo a esse contrato para acompanhar o mockup.

Capacidades, em `lib/perfil/capacidades.ts`:

- `PERFIL_CONSULTAR`
- `PERFIL_EDITAR_RASCUNHO`
- `PERFIL_APLICAR`
- `PERFIL_ADMINISTRAR_CONCESSOES`

Sem `PERFIL_CONSULTAR` ativa a tela informa que não há concessão para consultar. Sem `PERFIL_EDITAR_RASCUNHO` o formulário fica desabilitado. Sem `PERFIL_APLICAR` a seção “Revisar e aplicar” não aparece. `PERFIL_ADMINISTRAR_CONCESSOES` não é uma UI desta página. A tela e a rota do perfil não listam nem gravam concessões; o teste `components/admin/PerfilEmpresa.test.ts` impede `perfil_empresa_concessoes` e `INSERT INTO` nesses arquivos. Não desenhe administração de acesso dentro do perfil.

Estados que a tela já cobre e que o visual novo precisa continuar a comunicar: carregando, sem concessão, estrutura não instalada, empresa ainda não provisionada (o formulário não cria a primeira empresa), erro com “Tentar novamente”, operação em andamento, rascunho salvo, conflito.

Rascunho pode ficar incompleto. Aplicar exige o cadastro válido em `validarAplicacao`, motivo com pelo menos 3 caracteres, confirmação do antes e do depois do rascunho salvo, e rascunho já salvo. Texto só no formulário, ainda sujo, não entra na aplicação. A própria tela diz que aplicar grava o cadastro desta empresa e não altera contratos, PDFs nem documentos já emitidos. Mantenha esse sentido.

Conflito responde `409` com código `PERFIL_CONFLITO` (também nos códigos SQL `23505`, `40001` e `40P01` tratados na rota). A mensagem de serviço é que outra edição alterou o perfil e os dados digitados foram mantidos. A tela bloqueia aplicar até a pessoa carregar a versão publicada e confirmar de novo. Não substitua esse fluxo por um toast genérico que descarte o que foi digitado.

Auditoria já ocorre no serviço: `PERFIL_RASCUNHO_SALVO` ao gravar rascunho e `PERFIL_CADASTRO_APLICADO` ao aplicar, via `registrarAuditoria`. Não invente outra trilha.

Reautenticação de 5 minutos (`JANELA_REAUTENTICACAO_MS` em `lib/perfil/reautenticacao.ts`) só entra na aplicação, e só quando `alteracaoSensivel` em `lib/perfil/cadastro.ts` é verdadeira. Sensível significa mudança de razão social, de CNPJ, do endereço da sede, de “mesmo endereço da sede”, ou do endereço da unidade quando ele não é o da sede. A tela oferece o campo de senha e, se estiver preenchido, chama a reautenticação da sessão antes do `POST` de aplicar. Não estenda essa janela a outros campos nem a “Salvar rascunho”.

CEP já existe. Com 8 dígitos, a consulta preenche logradouro, bairro, cidade e UF. Número e complemento continuam manuais. A rota é `POST /api/endereco/consultar-cep`.

O checkbox “Sem número” já existe na sede e na unidade. Marcado, o número fica vazio e o campo desabilita. Na aplicação, o número é exigido salvo esse checkbox. Não use “Sem número” como placeholder de input; essa apresentação pertence à versão desktop 2/3, que não é referência.

Asteriscos continuam regidos por `campoExigidoNaAplicacao` em `lib/perfil/cadastro.ts`, não pelo mockup. Na aplicação, o asterisco vale para nome comercial, razão social, CNPJ, nome da unidade, e para CEP, logradouro, número, bairro, cidade e UF da sede. Os mesmos campos da unidade levam asterisco só quando “mesmo endereço da sede” está desmarcado. Não levam asterisco: telefone, WhatsApp, e-mail comercial, site, Instagram, referência de chegada e complemento. Telefone e WhatsApp também não levam asterisco individual: `contatoExigidoNaAplicacao` exige pelo menos um dos dois, com 10 dígitos, e a tela já explica isso em texto.

O histórico já vem de `dados.historico`: número, estado rascunho ou aplicada, quem editou, quando, quem aplicou, quando e o motivo. O visual pode reestilizar a lista. O texto das linhas continua sendo o da API, não amostra de artboard.

## Código da empresa

O código é exibido e não é editado. O cabeçalho atual escreve “Empresa {codigoEmpresa} · Unidade {codigoUnidade} · versão {versao}”, lido do contexto do `GET`. `codigoEmpresa` e `codigoUnidade` não fazem parte de `CadastroPerfil`. O schema do `POST` não os aceita. O `UPDATE` de `perfil_empresas` em `lib/perfil/cadastro-service.ts` não altera `codigo`. Se o mockup mostrar código como campo de formulário, não o implemente como input.

## Card Marca

A referência visual inclui um card de Marca: logo atual, nova logo, escolher arquivo e prévias. Isso é direção visual.

Upload de logo não deve ser implementado até uma decisão específica de armazenamento. O teste atual proíbe `type="file"` em `components/admin/PerfilEmpresa.tsx`. A tela hoje diz: “Marca, logo e PDF público não fazem parte desta tela.” Um alinhamento visual pode reservar a região do card, desde que não haja seletor de arquivo, envio, persistência nem promessa de que a logo já entra em contratos ou PDFs.

## O que o mockup mostra e esta documentação não autoriza

- Upload de logo ou qualquer `input type="file"` nesta tela.
- Código da empresa como campo editável. O código só é exibido, como descrito acima.
- Aplicar o perfil em contratos ou na marca. Hoje nenhum módulo de contrato, festa, marca ou PDF lê `perfil_empresas`. A leitura da tabela está em `lib/perfil` (cadastro, estrutura e proteção de usuários) e no script `scripts/perfil-empresa-provisionar.cjs`. `lib/autenticacao/usuarios.test.ts` só cita o nome da tabela em dublê de teste. Não faça outro módulo passar a ler o perfil só porque o desenho sugere identidade aplicada no produto.

## O que um agente de UI pode alinhar

Pode, sem mudar regra de negócio nem o contrato HTTP:

- Largura. Hoje `.page` em `components/admin/perfil-empresa.module.css` tem `max-width: 46rem` e fica na coluna de conteúdo, à esquerda, sem centralizar com `margin: auto`. O protótipo traz o literal de classe `max-w-[1200px]`. Aproximar a largura é visual.
- Trocar o fieldset único por cards (Identificação, endereços, contatos e a região visual de Marca), mantendo os mesmos campos e a mesma validação.
- Cabeçalho com a unidade e o estado real de rascunho (há rascunho, há alteração não salva, versão). Use os dados já carregados.
- Ações “Salvar rascunho” e “Revisar e aplicar”, que já existem, com a hierarquia visual da referência.
- Ajuda contextual no lugar dos vários botões “Ajuda”. O texto de ajuda pode continuar o que `Rotulo` já mostra. Não invente regra nova dentro da ajuda.
- Checkbox “Sem número” e a consulta de CEP, que já existem.

Mudar o visual não muda a API. Não altere `app/api/admin/configuracoes/perfil-empresa/route.ts`, `lib/perfil/cadastro.ts` nem o serviço para “caber” no desenho.

## Checklist do agente de UI

Pode:

- Aplicar tokens oficiais de [tokens.md](tokens.md) na casca e nesta tela.
- Recompor a página em cards, com cabeçalho de unidade e rascunho, ações existentes e ajuda contextual.
- Manter CEP, “Sem número”, asteriscos de `campoExigidoNaAplicacao`, comparação antes/depois, motivo, reautenticação e histórico.
- Tratar a área de Marca como direção visual, sem arquivo.

Não pode:

- Criar upload, storage, campo editável de código, migration, concessão nesta tela, ou leitura do perfil por contratos e PDFs.
- Copiar selo “Publicado”, histórico de exemplo ou placeholder “Sem número” das versões descartadas.
- Ligar o ícone de menu do protótipo no lugar da gaveta descrita em [navegacao.md](navegacao.md).
- Criar links falsos para Dashboard, Solicitações, Pacotes, Tabelas de Preços ou Segurança.
- Tratar o catálogo “Buffet e adicionais” como se tivesse o rascunho e a auditoria do perfil.
