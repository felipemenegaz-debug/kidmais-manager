# Proposta integrada — autenticação administrativa e Contrato

09/09/2026 — revisão final com BYTEA e fontes de verdade, para aprovação. **Migration 013 NÃO autorizada, criada ou aplicada. Nenhuma funcionalidade deste documento implementada.** Esta revisão substitui a proposta de filesystem e explicita os bloqueios atuais de alterações entre domínios.

Esta proposta continua a análise anterior e o checkpoint `.backups/pix-validado-20260909-130820`. A autorização recebida inclui desenhar autenticação real como pré-requisito; não autoriza executar DDL. Os nomes abaixo são a especificação proposta, não objetos já presentes no banco.

## 1. Inspeção e estado físico

Nova consulta ao PostgreSQL 18.6, banco `kidmais_manager`, em transação `REPEATABLE READ READ ONLY`: 30 tabelas públicas; três contratos/três versões, sendo duas assinadas e uma ativa. Não há usuários/sessões administrativas. O código usa `pg`, Next 16.3.4, Node local 24.20.0; não há biblioteca de autenticação instalada. Foram lidos os guias locais de autenticação e cookies da versão instalada do Next.

| Estrutura existente | O que existe e será preservado | Insuficiência |
| --- | --- | --- |
| `contratos` | UUID, Fechamento único, status, `versao_atual`, autoria opcional e datas | Um número não distingue preparação, vigência e obrigação financeira |
| `contrato_versoes` | UUID, contrato, número, snapshot JSONB/hash, status, motivo, autoria, datas, template/hash PDF e método OTP | Não representa preparação administrativa, origem/tipo da alteração ou assinatura Kidmais |
| `contrato_versoes_numero_uk` | Unicidade de `(contrato_id, numero_versao)` | Adequado; manter |
| `contrato_versoes_corrente_uk` | Único por contrato quando status é `ATIVA` ou `ASSINADA` | Impede V1 assinada + V2 ativa e múltiplas assinadas históricas |
| Checks de Contrato | Estados lógicos `AGUARDANDO_ASSINATURA/ASSINADO/CANCELADO`; versões `ATIVA/SUBSTITUIDA/ASSINADA/CANCELADA`; assinatura exige data, template, hash e OTP | Preservar o significado do aceite do cliente; nova etapa fica em estrutura complementar |
| `validacoes_identidade_cliente` | OTP, finalidade `CONTRATO_ACEITE`, consumo ligado à versão, FK RESTRICT e índice único da versão consumidora | Adequado para cliente; não autentica representante administrativo |
| `pagamentos` | `contrato_versao_id` com FK e unicidade; valor contratado; estados financeiros | Vínculo é adequado, mas o serviço também exige que seja a versão corrente do contrato |
| `auditoria` | Evento com ator/contexto, entidade, antes/depois; trigger impede UPDATE/DELETE | Reutilizar; ator atual de desenvolvimento não é identidade confiável |
| `eventos_historico_cliente` | Repositório insere eventos; referências e metadata | Reutilizar sem reescrever eventos antigos |
| `pagamento_comprovantes` | Metadados, hash e localizador | Não fornece, por si só, armazenamento imutável de PDFs de Contrato |
| Migration 012 | Condição comercial JSONB em Fechamento/aprovação e checks comerciais | Suficiente para PIX; não tocar |

A inspeção `npm run check:pagamentos:db` passou: objetos da Migration 011 conferidos (51 constraints, 15 índices e 4 triggers nomeados pela migration). Os dois casos reais permanecem com totais R$ 8.990,00 e R$ 9.290,00; o primeiro tem R$ 8.990,00 recebidos e R$ 500,00 estornados; o segundo não tem recebimentos. Nenhuma operação de escrita foi executada no banco.

Conferência final contra o checkpoint: existem diferenças atuais em `next-env.d.ts`, `next.config.ts` e `data/disponibilidade.json`, que não foram produzidas nem revertidas por esta etapa de desenho. A configuração atual de Next contém `allowedDevOrigins`; isso permite origem de desenvolvimento, mas não autentica usuários nem substitui HTTPS/CSRF. Preservar essas mudanças atuais ao implementar. Migration 012 continua com SHA-256 `6A920AFC0B0275A568C9176E050F31F2CDC588E36F99FA2252A5FADEC33FD66D`.

## 2. Decisão de arquitetura proposta

Usar **usuários administrativos locais, senha com scrypt e sessão opaca persistida**, sem OAuth externo. Separar três referências:

- versão em preparação: editável somente antes da assinatura Kidmais;
- versão vigente: última versão que completou o fluxo exigido;
- versão da obrigação financeira: o `pagamentos.contrato_versao_id` já existente, que não muda porque surgiu V2.

Adicionar tabelas complementares, mantendo os registros e checks das versões existentes. Substituir somente o índice de exclusividade que impede a coexistência. Guardar documentos novos em PostgreSQL BYTEA, com bytes, metadados e provas participando da mesma transação. Não criar storage_provider, storage_chave, diretório local ou configuração de caminho. A implementação terá interfaces pequenas para autenticação, assinatura e armazenamento documental; não um framework genérico de provedores.

## 3. Autenticação, autorização e cadastro inicial

Dois papéis exclusivos na coluna `papel`: `ADMINISTRATIVO` e `REPRESENTANTE_AUTORIZADO`. O segundo inclui as capacidades do primeiro; não há duas atribuições por usuário. Ambos podem revisar/editar dentro dos limites de domínio; somente `REPRESENTANTE_AUTORIZADO` pode assinar pela Kidmais e liberar o documento. Criar/promover representantes será uma operação local de provisionamento, restrita ao operador do servidor, sem autocadastro e sem promoção pelo próprio navegador.

A identidade será obtida de cookie → hash do token → sessão → usuário ativo no servidor, em cada ação. Remover o caminho `x-kidmais-dev-user-id` das APIs reais, inclusive em desenvolvimento. Os testes usarão usuários temporários e login real; nenhuma chave de bypass. Aplicar a autenticação a todo `app/api/admin/**`, para não deixar rotas antigas contornarem os controles novos. Auditoria de Fechamento, revisão comercial, CRM, Disponibilidade e Pagamentos passa a receber o ator autenticado.

Proposta de senha: scrypt assíncrono de `node:crypto`, salt aleatório de pelo menos 16 bytes, resultado de 64 bytes, parâmetros versionados `N=131072, r=8, p=1`, `maxmem` compatível (proposta: 256 MiB). Comparação em tempo constante; nunca registrar senha, hash, cookie ou token de sessão. Limitar concorrência das derivações e testar custo na máquina. Esses parâmetros seguem a alternativa scrypt indicada pela [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html); a API está documentada pelo [Node.js](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).

A opção por scrypt aproveita uma primitiva estável já disponível no runtime, sem implementar criptografia própria. O guia local do Next recomenda bibliotecas de autenticação como preferência geral; neste projeto, uma camada pequena de sessões PostgreSQL evita introduzir tabelas de OAuth/accounts não utilizadas. Isso exige testes específicos de segurança e revisão da implementação antes de habilitar produção.

Política inicial proposta: senha de 15 a 128 caracteres, sem truncar, permitindo colagem/gerenciador; máximo de bytes explícito para evitar entradas abusivas. Respostas de login genéricas, derivação de comparação também para usuário inexistente e limitação de tentativas por identificador e origem confiável. Não usar somente memória do processo para limitar tentativas.

Provisionamento futuro por comando local interativo, com entrada de senha oculta e sem argumento de linha de comando. A conexão será fornecida por prompt local oculto ou variável `KIDMAIS_PROVISION_DATABASE_URL` injetada exclusivamente no processo do comando por ferramenta operacional; nunca digitada como argumento visível ou gravada em `.env.local` da aplicação. Não haverá fallback para `DATABASE_URL`, segredo hardcoded, variável `NEXT_PUBLIC_*`, rota web ou log de connection string. Erros serão sanitizados. A credencial operacional deve ter os privilégios de provisionamento necessários; o usuário de runtime web não terá INSERT em usuários nem capacidade de promover papel. Provisionar a role PostgreSQL é tarefa operacional explícita, não criação silenciosa de conta/senha pela Migration 013.

Bootstrap: solicitar nome/email/cargo opcional, senha oculta e confirmação; calcular scrypt; abrir transação e bloquear `usuarios_administrativos` contra inserção concorrente; recusar se existir QUALQUER usuário, inclusive inativo; inserir primeiro `REPRESENTANTE_AUTORIZADO` e evento em `auditoria` (`ator_tipo=SISTEMA`, `usuario_id=NULL`, origem CLI, dados não secretos); commit. Nenhum usuário é criado na migration. Depois, comando local distinto permite inclusão/promoção/desativação com confirmação explícita e auditoria, sem reabrir bootstrap. Senha/connection string não entram na auditoria. Redefinição local revoga sessões; recuperação por email fica fora deste bloco. Cadastro não equivale a validação documental da pessoa: a Kidmais atribui o papel a alguém efetivamente autorizado.

## 4. Sessões e proteção das requisições

- Token aleatório de 32 bytes, opaco; somente SHA-256 no PostgreSQL. Não armazenar credencial em localStorage nem JWT com permissões desatualizadas.
- Cookie `HttpOnly`, `SameSite=Lax`, `Path=/`, sem `Domain`; `Secure` e prefixo `__Host-` em HTTPS. HTTP permitido somente no desenvolvimento em loopback, com nome separado. Acesso pela rede/produção exige HTTPS.
- HTTP remoto em `http://100.x.x.x:3000` não habilitará autenticação administrativa: não remover Secure para fazê-la funcionar. Tailscale remoto será resolvido posteriormente com HTTPS/MagicDNS ou homologação. Preservar `next.config.ts`; allowedDevOrigins não é autorização de origem segura por si só. Validar origem configurada, sem confiar em Host/forwarded arbitrários para ativar o modo localhost.
- Proposta de duração: oito horas absolutas e 30 minutos de inatividade, verificadas no servidor. Revogar em logout, troca de senha, desativação ou mudança de papel; rotacionar no login e na reautenticação. Não trocar o token silenciosamente a cada requisição concorrente.
- Assinar exige senha novamente ou reautenticação há no máximo cinco minutos; a sessão deve continuar válida no commit. A revisão visual do documento continua obrigatória mesmo com reautenticação recente.
- Verificar Origin configurado e token CSRF ligado à sessão nas mutações. Login também verifica origem e contexto CSRF pré-autenticação. Cookie SameSite é proteção complementar, conforme [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
- `Cache-Control: no-store` para autenticação, documentos privados e respostas administrativas; autorização no serviço/route handler, além da proteção visual da página. Usar a API assíncrona de cookies da versão instalada.
- IP só de conexão/origem proxy explicitamente confiável. Em ambiente sem origem verificável, gravar NULL em vez de tratar `x-forwarded-for` arbitrário como prova. User-agent é apenas contexto declarado.

## 5. Estrutura nova proposta — oito tabelas

Convenções: IDs novos UUID gerados no servidor/banco; datas `timestamptz`; hashes SHA-256 hex minúsculo com check; FKs `ON DELETE RESTRICT`; nenhuma exclusão em cascata de provas. Defaults abaixo valem apenas para registros novos. As oito tabelas começam vazias.

### 5.1 `usuarios_administrativos`

| Campos | Tipo/default e finalidade |
| --- | --- |
| `id` | UUID PK, `gen_random_uuid()` |
| `email` | text NOT NULL normalizado no servidor; check não vazio; índice único em `lower(btrim(email))` |
| `nome` | text NOT NULL não vazio; identidade cadastrada pelo operador |
| `cargo` | text NULL; informação opcional real, não inventada |
| `senha_hash` | text NOT NULL, formato versionado contendo algoritmo/parâmetros/salt/derivação; não exposto pela API |
| `papel` | varchar(32) NOT NULL, check `ADMINISTRATIVO`/`REPRESENTANTE_AUTORIZADO`; **sem default de privilégio** |
| `ativo` | boolean NOT NULL DEFAULT true |
| `senha_alterada_em`, `criado_em`, `atualizado_em` | timestamptz NOT NULL DEFAULT now(); revogação e rastreabilidade |

Reutilizar trigger `kidmais_set_atualizado_em`. Nome/email/papel podem mudar para o futuro, sem modificar snapshots de assinaturas. Desativar, não apagar usuários usados em provas. Não adicionar FK retroativa às autorias antigas do CRM: seus UUIDs históricos podem não corresponder a contas novas.

### 5.2 `sessoes_administrativas`

`id uuid PK`; `usuario_id uuid NOT NULL FK usuarios_administrativos(id)` com ON DELETE RESTRICT ON UPDATE RESTRICT; `token_hash char(64) NOT NULL UNIQUE`; `csrf_hash char(64) NOT NULL`; `criado_em`, `autenticado_em`, `ultima_atividade_em`, `expira_em` timestamptz NOT NULL; `revogado_em timestamptz` NULL; `ip inet` e `user_agent text` NULL. Check de ordem das datas e hashes; índice `(usuario_id, expira_em)` e índice de expiração. Não criar UNIQUE `(usuario_id,id)`: a associação composta de assinatura foi retirada. A PK id continua única. Revogação explícita e verificação do usuário permitem retirada imediata de acesso.

Sessões são registros operacionais temporários, não prova permanente. Uma política futura poderá excluir sessões expiradas/revogadas após o prazo de retenção a definir, inclusive as utilizadas em assinaturas. O job não será implementado nesta etapa. A exclusão remove também token_hash/csrf_hash; esses segredos derivados nunca são copiados para a prova contratual. Não há FK de contrato_assinaturas para sessões, nem trigger de limpeza que altere assinaturas: nenhum SET NULL, CASCADE, UPDATE ou DELETE de prova. O UUID histórico da sessão permanece inalterado mesmo após remoção da sessão.

A futura limpeza deverá bloquear/reconsultar a sessão antes de excluir, respeitando o protocolo de concorrência de autenticação/revogação/assinatura e a expiração no servidor. Uma assinatura em andamento mantém lock até o commit; exclusão concorrente não pode remover a sessão entre validação e conclusão. Depois do commit, leitura/verificação histórica da prova não exige sessão existente ou usuário ainda ativo/autorizado.

### 5.3 `limites_autenticacao`

`chave_hash char(64) PK`, `tipo varchar(16)` (`IDENTIFICADOR` ou `ORIGEM`), `tentativas integer NOT NULL`, `janela_iniciada_em timestamptz NOT NULL`, `bloqueado_ate timestamptz NULL`, `atualizado_em timestamptz NOT NULL`. Chave HMAC de email normalizado ou origem com segredo operacional; não guardar senha nem tentativa de senha. Check tentativas >= 0; índice de atualização para expiração. Upsert/bloqueio serializa contagem entre processos. Limites iniciais propostos: cinco falhas por identificador em 15 minutos e 30 por origem em cinco minutos, com bloqueio temporário; ajustar com evidência, considerando NAT e abuso de bloqueio de contas.

### 5.4 `contrato_fluxos`

Uma linha por contrato adotando o novo fluxo: `contrato_id uuid PK FK contratos`; `versao_em_preparacao_id uuid NULL`; `versao_vigente_id uuid NULL`; `criado_em/atualizado_em timestamptz NOT NULL DEFAULT now()`.

Dois FKs compostos `(contrato_id, versao_*_id)` → `contrato_versoes(contrato_id,id)`, garantindo que nenhum ponteiro aponte para outro contrato. Exigem a nova UNIQUE `contrato_versoes_contrato_id_id_uk`. Check: ponteiros distintos quando preenchidos. Preparação deve apontar para versão ATIVA com edição não terminal; vigente para ASSINADA. A validação entre tabelas será por constraint trigger deferred, na mesma transação da transição.

Não adicionar uma coluna redundante de versão financeira: essa referência já existe em `pagamentos`. Não inserir linhas de `contrato_fluxos` para contratos antigos na migration.

### 5.5 `contrato_edicoes`

Uma linha por versão do novo fluxo; evita adicionar defaults que classifiquem versões antigas.

| Campos | Finalidade |
| --- | --- |
| `contrato_versao_id uuid PK FK`, `contrato_id uuid NOT NULL` | FK composto para pertencimento |
| `origem_versao_id uuid NULL` | FK composto para a versão de origem do mesmo contrato; diferente de si mesma |
| `tipo varchar(20) NOT NULL` | `INICIAL`, `NOVA_VERSAO`, `RETIFICACAO`, `ADITIVO`; inicial sem origem, demais com origem |
| `estado varchar(32) NOT NULL` | `EM_ELABORACAO`, `ASSINADA_KIDMAIS`, `AGUARDANDO_CLIENTE`, `CONCLUIDA`, `CANCELADA`; sem inferência pelo cliente |
| `revisao integer NOT NULL DEFAULT 1` | Controle otimista a cada salvamento explícito, não a cada tecla; check > 0 |
| `dados_fonte jsonb NOT NULL` | Documento interno versionado de campos permitidos, produzido por validação de formulário; check objeto |
| `alteracoes jsonb NOT NULL` | Diff calculado pelo servidor em relação à origem; objeto, sem status/hashes forjáveis |
| `revisao_comercial_aprovada integer NULL`, `aprovado_comercial_por_usuario_id uuid NULL FK`, `aprovado_comercial_em timestamptz NULL` | Decisão comercial explícita da revisão; trio todo NULL ou todo preenchido, revisão positiva e nunca maior que `revisao` |
| `documento_revisado_id uuid NULL` | PDF exato selecionado para assinatura; FK de documento pertencente à versão |
| `revisado_por_usuario_id uuid NULL FK`, `revisado_em timestamptz NULL` | Revisão explícita autenticada; não assinatura |
| `liberado_por_usuario_id uuid NULL FK`, `liberado_em timestamptz NULL` | Ação distinta de liberar ao cliente |
| `criado_por_usuario_id uuid NOT NULL FK`, `atualizado_por_usuario_id uuid NOT NULL FK` | Autoria administrativa real |
| `criado_em`, `atualizado_em` | NOT NULL DEFAULT now() |

O motivo já existe em `contrato_versoes.motivo_nova_versao`: reutilizar, exigindo preenchimento para alterações com origem. Pricing e condição PIX continuam calculados pelos serviços oficiais; `dados_fonte` não é um editor de JSON exposto. O schema interno inclui `schemaVersao` e campos comerciais validados. A aprovação comercial deve ser vinculada à revisão exata nos campos acima e no snapshot/auditoria; qualquer salvamento invalida a aprovação da revisão anterior. Assinatura exige aprovação explícita da revisão atual. Na versão inicial, a decisão original do Fechamento serve de origem documental, mas a revisão administrativa ainda é ação explícita. Reutilizar a regra da Migration 012; não reescrever a aprovação comercial histórica do Fechamento para fingir que ela aprovou V2. Decisões recusadas e anteriores permanecem na auditoria append-only.

Estados: até concluir, `contrato_versoes.status` permanece ATIVA; na conclusão vira ASSINADA com os metadados OTP existentes. Cancelamento muda para CANCELADA. Uma versão concluída permanece ASSINADA mesmo quando deixa de ser vigente: “histórica/substituída por V2” é uma relação derivada dos ponteiros/origem e auditoria, não UPDATE de V1. O status SUBSTITUIDA legado continua significando a substituição de versão não assinada no fluxo antigo.

### 5.6 `contrato_documentos`

| Coluna | Tipo / nulidade / default |
| --- | --- |
| `id` | uuid PK NOT NULL DEFAULT gen_random_uuid() |
| `contrato_versao_id` | uuid NOT NULL FK contrato_versoes(id) |
| `categoria` | varchar(24) NOT NULL |
| `revisao` | integer NOT NULL |
| `snapshot_hash` | char(64) NOT NULL |
| `template_codigo` | text NOT NULL |
| `template_versao` | integer NOT NULL |
| `pdf_hash` | char(64) NOT NULL |
| `tamanho_bytes` | bigint NOT NULL |
| `conteudo_pdf` | bytea NOT NULL |
| `gerado_por_usuario_id` | uuid NULL FK usuarios_administrativos(id) |
| `criado_em` | timestamptz NOT NULL DEFAULT now() |

PK `id`; UNIQUE `contrato_documentos_versao_id_id_uk (contrato_versao_id,id)`; índice `contrato_documentos_versao_criado_idx (contrato_versao_id, criado_em)`. FKs ON DELETE RESTRICT ON UPDATE RESTRICT. Checks nomeados:

- `contrato_documentos_categoria_check`: categoria em CONTRATO/COMPROVANTE_ASSINATURA;
- `contrato_documentos_revisao_check`: revisao > 0;
- `contrato_documentos_template_check`: template_versao > 0 e template_codigo não vazio;
- `contrato_documentos_hashes_check`: hashes SHA-256 hex minúsculo;
- `contrato_documentos_tamanho_check`: tamanho_bytes > 0 AND tamanho_bytes = octet_length(conteudo_pdf);
- `contrato_documentos_conteudo_hash_check`: pdf_hash = encode(sha256(conteudo_pdf), 'hex');
- `contrato_documentos_autoria_check`: categoria CONTRATO exige gerado_por_usuario_id preenchido.

As expressões acima são especificação, não SQL executado. PostgreSQL 18 possui `sha256(bytea)` e `octet_length(bytea)` nativos; não é necessário criar pgcrypto para esses checks ([documentação oficial](https://www.postgresql.org/docs/18/functions-binarystring.html)). Hash e tamanho enviados pelo navegador não são aceitos como autoridade; o servidor calcula e o banco verifica contra o BYTEA inserido. Toda geração cria uma linha nova. Trigger impede UPDATE/DELETE; role de runtime não recebe TRUNCATE nem DDL. Não indexar BYTEA, nem retornar conteúdo nas listagens de metadados. Sem provider de storage, chave, caminho ou índice de filesystem.

Autoria NULL apenas para comprovante de aceite público produzido pelo servidor, com autoria do cliente registrada na prova correspondente; documento contratual preparado por administração exige usuário autenticado.

### 5.7 `contrato_assinaturas`

| Coluna | Tipo / nulidade / vínculo |
| --- | --- |
| id | uuid PK NOT NULL DEFAULT gen_random_uuid() |
| contrato_versao_id | uuid NOT NULL FK contrato_versoes(id) |
| parte | varchar(12) NOT NULL: KIDMAIS ou CLIENTE |
| documento_id | uuid NOT NULL; FK composta da mesma versão |
| usuario_id | uuid NULL; FK direta usuarios_administrativos(id) |
| sessao_id | uuid NULL; somente referência histórica, SEM FK |
| autenticacao_metodo | varchar(24) NULL; SENHA para Kidmais nesta etapa |
| autenticado_em | timestamptz NULL; instante da autenticação/reautenticação efetivamente usada |
| validacao_identidade_id | uuid NULL; FK validacoes_identidade_cliente(id) |
| identidade_snapshot | jsonb NOT NULL |
| snapshot_hash | char(64) NOT NULL |
| pdf_hash | char(64) NOT NULL |
| metodo | varchar(24) NOT NULL |
| provider | varchar(24) NOT NULL |
| assinado_em | timestamptz NOT NULL |
| ip | inet NULL; somente origem confiável disponível |
| user_agent | text NULL |
| request_id | uuid NOT NULL |
| chave_idempotencia | uuid NOT NULL |
| comprovante_documento_id | uuid NOT NULL; FK composta da mesma versão |

UNIQUE `(contrato_versao_id, parte)` e `(parte,chave_idempotencia)`; FKs compostos `(contrato_versao_id, documento_id)` e `(contrato_versao_id, comprovante_documento_id)` → contrato_documentos(contrato_versao_id,id). Todas as FKs reais usam ON DELETE RESTRICT ON UPDATE RESTRICT. Não há FK, nem composta nem simples, de sessao_id para sessoes_administrativas. Índices não únicos de sessao_id (consulta contextual) e validacao_identidade_id permanecem.

Checks de hashes e snapshot objeto. Kidmais exige usuario_id, sessao_id, autenticacao_metodo=SENHA, autenticado_em, metodo=SESSAO_REAUTENTICADA, provider=INTERNAL e validacao_identidade_id NULL. Exige também autenticado_em <= assinado_em e intervalo de no máximo cinco minutos. autenticado_em é copiado do instante real de autenticação/reautenticação da sessão conferida, nunca atualizado para a hora da assinatura sem validação de senha. Cliente exige validação real CONTRATO_ACEITE, metodo=OTP, provider=INTERNAL e usuario_id/sessao_id/autenticacao_metodo/autenticado_em NULL; o contexto da autenticação do cliente continua na prova OTP existente. Grupos obrigatórios são testados com IS NOT NULL, evitando aceitação por NULL nos CHECKs.

Para Kidmais, identidade_snapshot contém schemaVersao, usuarioId igual ao usuario_id da linha, nome cadastrado não vazio, cargo disponível (NULL quando ausente) e papel=REPRESENTANTE_AUTORIZADO no ato. O servidor copia esses dados do usuário autenticado; a validação de inserção confere correspondência. token_hash, csrf_hash, senha e senha_hash nunca integram esse JSON ou qualquer comprovante. Não implementar outros providers agora.

Na INSERÇÃO da assinatura Kidmais, serviço e constraint trigger conferem a sessão REAL sob lock na mesma transação: existência, usuário correto, usuário ativo/autorizado, ausência de revogação, expiração absoluta/inatividade, autenticação dentro da janela e contexto copiado. A sessão deve continuar válida na validação final antes do commit, usando relógio do servidor. Esse exame é exclusivo do novo ato de assinatura, não uma dependência histórica. Repositório insere no máximo uma prova por parte e nunca faz UPDATE/DELETE.

Triggers de validação de fluxo em futuras operações (por exemplo aceite do cliente, promoção ou consulta da V1 histórica) verificam a prova imutável, pertencimento, revisão, hashes, documentos e OTP pertinente, sem exigir que a sessão histórica Kidmais ainda exista/esteja válida. Não reavaliam a autorização passada com o papel atual do usuário. A FK direta de usuário permanece para identidade referencial, enquanto o snapshot preserva nome/cargo/autorização no ato. Não copiar o representante fixo do template como se tivesse feito login.

### 5.8 `contrato_pendencias_financeiras`

Registro explícito de um evento que o bloco não resolve automaticamente: `id uuid PK`; `contrato_id uuid NOT NULL FK`; `versao_anterior_id uuid NOT NULL`; `versao_nova_id uuid NOT NULL`; `pagamento_id uuid NOT NULL FK`; `motivo text NOT NULL`; `diferencas jsonb NOT NULL`; `criado_em timestamptz NOT NULL DEFAULT now()`.

FKs compostos das versões ao mesmo contrato; check versões distintas/diff objeto; UNIQUE `(pagamento_id, versao_nova_id)`; índice `(contrato_id, criado_em)`. Append-only. Não incluir status “resolvido” ou endpoint de ajuste neste bloco; a resolução futura será evento explícito, com desenho próprio. A pendência alerta e impede gerar obrigação duplicada, sem alterar lançamentos existentes.

## 6. Índices, constraints e triggers: delta completo proposto

Objetos existentes alterados:

1. Substituir `contrato_versoes_corrente_uk` por `contrato_versoes_em_preparacao_uk`, UNIQUE `(contrato_id) WHERE status='ATIVA'`. Continua havendo no máximo uma preparação por contrato, com várias versões assinadas preservadas.
2. Adicionar UNIQUE `contrato_versoes_contrato_id_id_uk` em `(contrato_id,id)` para FKs de pertencimento. Não remover os índices existentes de número/hash/histórico.
3. Adicionar trigger BEFORE UPDATE/DELETE `contrato_versoes_preservar_assinada_trg`, função `kidmais_preservar_versao_assinada()`: versão já ASSINADA não sofre mutação; após assinatura Kidmais, snapshot/hash/identidade/número/origem/motivo não mudam. Permitir exclusivamente metadados e transição necessários ao aceite do cliente/cancelamento formal da preparação, sem tocar prova anterior. Cancelamento não apaga documento nem assinatura Kidmais.
4. Adicionar constraint trigger deferred `contrato_versoes_validar_fluxo_trg` em INSERT/UPDATE, função `kidmais_validar_fluxo_contrato()`. Novas versões exigem edição/fluxo na mesma transação; versões já existentes sem edição continuam legadas. A função também atende triggers deferred `contrato_fluxos_validar_trg`, `contrato_edicoes_validar_trg`, `contrato_assinaturas_validar_trg` nas tabelas novas. Verifica referências, transições, assinaturas necessárias e compatibilidade dos estados no commit, sem substituir autorização de aplicação. A verificação de sessão viva ocorre somente no evento INSERT de nova assinatura Kidmais; demais eventos verificam provas já congeladas, sem JOIN obrigatório com sessão histórica. Nenhum trigger de DELETE/limpeza de sessões altera ou invalida assinaturas. Não adicionar nova função para retenção nesta etapa.
5. Função `kidmais_bloquear_mutacao_prova_contrato()` para triggers BEFORE UPDATE/DELETE em documentos, assinaturas e pendências novas. Edições recebem `contrato_edicoes_preservar_trg`, função `kidmais_preservar_edicao_contrato()`, bloqueando mudança de fonte/origem/revisão/diff após a primeira assinatura, permitindo apenas transições explícitas previstas; concluídas não são reescritas.
6. Triggers de atualizado_em nas novas tabelas mutáveis reutilizam a função atual. Todas as PKs, FKs, checks e índices das oito tabelas são os especificados na seção 5 e são removidos com suas próprias tabelas no rollback.

**Sem colunas novas ou UPDATE em contratos/versões antigos; sem alteração de tabelas financeiras, OTP, Migration 012 ou schema original.** Somente os índices e triggers acima mudam estruturas já existentes. A validação da migration deverá abortar se encontrar qualquer divergência física em relação a esta inspeção.

## 7. Fluxo, elaboração e vigência

```text
FECHAMENTO aprovado / condição comercial revisada
  → CONTRATO EM ELABORAÇÃO (versão + edição; salvar incrementa revisão)
  → revisão explícita do PDF exato
  → ASSINATURA KIDMAIS (representante autenticado; congela conteúdo)
  → liberação explícita ao cliente
  → ASSINATURA CLIENTE (OTP existente; mesmo PDF e snapshot)
  → VERSÃO VIGENTE
  → PAGAMENTOS: criação explícita, quando não houver obrigação anterior

V1 VIGENTE + V2 EM ELABORAÇÃO
  → V1 continua vigente durante revisão/assinatura Kidmais de V2
  → cliente conclui V2, verificações finais passam
  → troca atômica do ponteiro vigente para V2
  → V1 histórica, com conteúdo, status ASSINADA, hashes e provas intactos
  → pagamento originado em V1 continua ligado a V1
```

`contratos.versao_atual` continuará sendo compatibilidade com a versão vigente; não será atualizado para um rascunho V2 enquanto existir V1 vigente. Para contrato novo sem vigente, poderá referenciar a primeira versão em preparação, como hoje, mas o código novo usa os ponteiros explícitos para decidir cada operação. Na conclusão de V2, atualizar número compatível e ponteiro na mesma transação; nunca selecionar vigente por `MAX(numero_versao)`.

O status lógico ASSINADO continua válido enquanto existir V1 vigente, mesmo com V2 em preparação. A interface mostra separadamente status da preparação, vigência e assinaturas. Para origem legada sem `contrato_fluxos`, resolver pelo contrato/número/status existentes. Somente quando o administrador solicitar uma nova versão, criar o controle com V1 como vigente e V2 como preparação; isso é operação explícita posterior, não backfill da migration.

Qualquer salvamento invalida a revisão/documento selecionado e aprovação comercial incompatível. O servidor recalcula fontes, snapshot e hashes; não aceita hash, status, total final ou papel enviados pelo cliente como verdade. Revisão otimista evita sobrescrever outra edição. Cláusulas são campos permitidos/template versionado, sem editor arbitrário de JSON/PDF.

Proposta conservadora para este bloco: toda versão nova destinada a substituir/complementar uma assinada exige Kidmais e cliente novamente, inclusive retificação. Não automatizar dispensa por “não material”. `ADITIVO` registra vínculo e documento correspondente, com snapshot consolidado dos efeitos para leitura comercial; não inventar automaticamente cláusula jurídica de substituição integral. O template de aditivo e os campos/cláusulas editáveis devem ser apresentados para revisão durante a implementação, antes de habilitar assinatura desse tipo.

## 8. Pagamentos e renegociação: regras precisas

**Criação:** resolver a versão vigente, exigir assinatura completa no novo fluxo (ou aceite legado já válido), Fechamento apto, snapshot íntegro e soma exata do plano em centavos. Copiar o total contratual, sem aplicar desconto novamente. Procurar também obrigação existente em qualquer versão do mesmo contrato sob lock, não somente na versão vigente. Se houver, retornar essa obrigação quando a repetição for equivalente ou recusar duplicação; não criar um segundo Pagamento só porque V2 existe, inclusive se o anterior estiver quitado/cancelado, sem tratamento financeiro autorizado.

**Operações no Pagamento existente:** consultar sempre sua própria `contrato_versao_id`; exigir que essa versão permaneça assinada e íntegra e que o pagamento pertença ao contrato correto. Trocar a comparação simplista com `versao_atual` por essas verificações explícitas. Permanecem os bloqueios de cancelamento/estado, soma exata, limite de recebimento/estorno, alocações, idempotência e regras de reserva. Um rascunho V2 não altera nenhum resultado financeiro.

**V2 entra em vigor:** se há Pagamento e mudança em valor, desconto, obrigação/partes ou condição financeira, inserir pendência e evento de auditoria na mesma transação. Não modificar plano, total, vínculo, recebimento ou comprovante. A tela distingue “valor contratual vigente em V2” de “obrigação financeira registrada em V1 — revisão pendente”. Até resolução futura explícita, as operações permitidas seguem a obrigação V1; não cobrar diferença V2 ou emitir quitação global de V2 a partir da quitação V1. Esse comportamento precisa ser aprovado como parte desta proposta.

Mesmo sem recebimentos, não reescrever automaticamente um plano existente: a pendência permite tratamento posterior. Se não existe Pagamento, a criação futura usa V2 vigente. Nem assinatura Kidmais nem cliente cria Pagamento.

Fechamento não deve retroceder de CONFIRMADO/AGUARDANDO_PAGAMENTO para CONTRATO_ASSINADO só porque V2 terminou. Seu histórico comercial original continua preservado. É retirada a proposta de usar snapshot vigente como substituto da fonte operacional. Dados de domínio devem ser aprovados/persistidos pelo serviço proprietário e o contrato congela seu resultado. As lacunas atuais e os pontos de parada obrigatória estão na seção 16. Não concluir versão com data/valor/contratante somente alterados no JSON, nem deixar a agenda em V1 enquanto o contrato declara V2 vigente.

## 9. Bytes do PDF, assinatura e apresentação

Armazenamento primário único: `contrato_documentos.conteudo_pdf BYTEA` no PostgreSQL. Metadados, bytes, comprovante, assinatura e auditoria podem participar da mesma transação por meio do mesmo DbExecutor. A interface de código será pequena: gravarDocumentoImutavel(tx, bytes, metadados), obterMetadados e lerDocumentoVerificado; sem método de overwrite/delete. O adaptador inicial é PostgreSQL. Um futuro object storage exigirá evolução explícita de persistência/atomicidade, mas não mudança na identidade de domínio (documento_id) nem reescrita das assinaturas. Não simular desde já que um storage externo participa de transações PostgreSQL.

Fluxo documental: gerar PDF da revisão → armazenar objeto imutável e metadados → apresentar esse mesmo objeto → confirmação explícita de versão/revisão/documento → inserir assinatura vinculada aos hashes conferidos. Mudança entre revisão e confirmação dá conflito; não assinar conteúdo regenerado silenciosamente. A leitura após assinatura sempre usa bytes armazenados e confere hash, sem fallback de regeneração.

**Separar documento assinado e comprovante da assinatura:** o PDF contratual contém identificação do representante cadastrado, versão e seção “Assinaturas eletrônicas — consulte o comprovante desta versão”, sem alegar que alguém já assinou antes da ação. No ato real, gerar comprovante imutável separado com nome/cargo do snapshot, horário efetivo, método e hashes do PDF contratual; persistir sua referência na prova. A interface de versão assinada apresenta/permite imprimir contrato e comprovantes identificados. Não inserir data de assinatura posteriormente nos bytes já revisados/assinados, nem tentar embutir o próprio hash integral do arquivo nele mesmo. A exigência de indicação de assinatura no PDF é atendida pelo comprovante eletrônico da versão; esta apresentação em dois documentos é uma decisão explícita proposta, não implementação silenciosa de uma exceção ao pedido.

O cliente assina o mesmo PDF contratual que a Kidmais. Seu comprovante é acrescentado como outro objeto; o PDF principal e o primeiro comprovante não mudam. Se for exigido um único arquivo que passe a exibir todas as assinaturas após cada ato, será necessário definir um pacote documental derivado identificado como tal, sem chamá-lo de bytes originais assinados. Não fazer isso implicitamente neste bloco.

### Legados: limite conhecido e tratamento sem regeneração

Não regenerar PDFs assinados antigos nem inserir registros de assinatura retroativos. As duas cópias oficiais já preservadas no checkpoint permanecem intactas. Migration 013 não as importa: todas as tabelas novas começam vazias. Importação futura dessas cópias para BYTEA seria adaptação real de dados legados e exige autorização separada, com origem, hash original, autoria de importação distinta de autoria de geração e nenhuma assinatura inventada. O modelo atual exige autor de geração para documento contratual novo; não preencher esse campo com o importador como se fosse autor histórico. Se essa importação for desejada, parar e definir sua proveniência antes de alterar o modelo. Até lá, não prometer que documentos antigos ausentes do banco estarão disponíveis na nova leitura BYTEA. O backup anterior continua sendo preservação dos originais, não storage primário da funcionalidade nova.

Para legado sem cópia verificada, mostrar “documento histórico indisponível” e solicitar recuperação do original; nunca fabricar um substituto regenerando o template. O pacote da terceira versão atual não tem template oficial disponível; não inventar um. A API deve tratar ausência real. Legados continuam com aceite OTP existente, sem assinatura Kidmais retroativa. Essa limitação impede prometer disponibilidade universal de PDFs antigos que não foram armazenados.

## 10. Transações, concorrência e falhas

DDL futuro: aplicação parada para escrita, backup atualizado, precheck de catálogo/contagens/hashes, BEGIN, lock_timeout curto, tabelas/checks/índices/triggers, postcheck, COMMIT. Sem executar comandos de dados antigos. Se houver timeout/divergência, ROLLBACK e nova análise; não insistir removendo constraints. Código antigo não pode continuar executando a consulta ambígua de versão corrente depois da troca de índice.

Operações de negócio: uniformizar ordem de locks hoje divergente entre assinatura e Pagamentos. Ordem proposta para linhas: Fechamento → Contrato → controle do fluxo → versões ordenadas por ID → edição → Pagamento → plano/recebimento/parcela em ordem estável. Toda operação concorrente que adquirir esses recursos precisa obedecer à mesma ordem; não basta ajustar o endpoint novo. Locks de agenda seguem um protocolo único compartilhado com Disponibilidade; quando dois horários forem envolvidos, ordenar suas chaves de forma determinística. A implementação deve verificar a ordem concreta dos serviços existentes e testar cruzamentos com bloqueio administrativo, recebimento e assinatura.

Na assinatura: usuário/sessão são revalidados e bloqueados em ordem consistente com revogação e futura limpeza; versão/revisão/documento reconsultados; papel e reautenticação conferidos; prova/documento/auditoria gravados atomicamente, incluindo identidade e contexto de autenticação congelados. Após commit, sessao_id é referência histórica sem FK; apagar sessão não muda prova. Idempotência compara parte, ator, versão e hashes; chave repetida com conteúdo diferente dá conflito, não sucesso. Uma requisição de repetição exige autenticação atual válida para acesso, mas não a sobrevivência da sessão original nem alteração do contexto original. Restrição única impede duas provas concorrentes. Cliente usa o consumo OTP existente na mesma transação.

Com BYTEA não há commit dividido banco/filesystem. PDF de revisão é persistido antes da apresentação e permanece como documento imutável mesmo se não for assinado. Na ação de assinatura, reconsultar esse documento sem regenerá-lo; comprovante novo, assinatura e auditoria são inseridos no mesmo tx. Erro antes do commit desfaz esses novos registros integralmente; o documento de revisão já existente permanece. Falha de resposta depois do commit é resolvida por idempotência, retornando a mesma prova. Nenhum endpoint entrega bytes só por conhecer documento_id: verificar autorização/vínculo e recalcular SHA-256/tamanho na leitura. Backup lógico PostgreSQL inclui BYTEA; restauração do banco recupera bytes e referências conjuntamente. Definir limites de tamanho e evitar SELECT * nas listagens para controlar memória/WAL/backup.

Na conclusão de V2, assinatura cliente, ponteiros, estados necessários, pendência financeira e auditoria entram no mesmo commit. Para transição que afete agenda, a validação e a efetivação lógica da ocupação devem ocorrer sob o mesmo protocolo de locks; se falhar, V1 continua vigente. Não alterar dinheiro nessa transação.

## 11. Legados, backfill e riscos

- Zero backfill de banco. Oito tabelas vazias na migration; sem cadastro inicial, assinaturas, documentos ou ponteiros inferidos.
- As duas versões assinadas permanecem com os mesmos IDs, snapshots, hashes, datas, status e OTP. O novo trigger reforça isso.
- A versão ativa legada mantém seu protocolo identificado como legado; não passa a exigir uma assinatura Kidmais retroativa. Nova versão solicitada passa ao fluxo novo. Novos contratos não podem usar o fallback legado para contornar assinatura.
- A adoção de controle em um contrato antigo ocorre somente por comando administrativo explícito de criar V2, em transação auditada. Não é varredura/conversão automática dos antigos.
- Importação dos dois PDFs legados para BYTEA não está incluída na migration nem autorizada; preservar as cópias atuais e não inventar proveniência/assinatura.
- Principal risco de código: consumidores de `buscarVersaoCorrente`/`versao_atual` passarem a selecionar rascunho ou múltiplas linhas. Substituir consultas por intenção explícita e testar todos os consumidores.
- Backup/restauração únicos para documentos novos: dump PostgreSQL inclui conteúdo BYTEA, metadados e provas. Ensaiar restauração isolada e conferir hashes. Custos de armazenamento/WAL crescem com cada geração; sem limpeza destrutiva automática.
- Credencial do banco dona das tabelas pode desabilitar triggers. Runtime sem DDL/TRUNCATE, backups e verificação de hash reduzem risco; assinatura interna não promete proteção criptográfica equivalente a certificado externo.
- Ajuste financeiro posterior fica pendente explícito, sem resolvedor neste bloco. Eventuais efeitos de aditivos precisam de template revisado; não automatizar interpretação jurídica.

## 12. Rollback SQL completo da estrutura proposta

**Somente desenho, não executar.** O rollback abaixo corresponde exatamente aos oito objetos de tabela, índice adicional e triggers/funções propostos. Remove tabelas novas apenas quando TODAS estiverem vazias e o índice antigo puder ser restaurado. Não usa CASCADE; dependências inesperadas fazem abortar. Nenhuma versão é apagada ou convertida. Se a autenticação já foi provisionada ou o fluxo usado, o rollback aborta: a estratégia passa a ser correção para frente, não perda de usuários/provas. Não apagar dados para satisfazer a guarda.

Executar futuramente apenas com aplicação parada e depois de validar que a migration aprovada corresponde a esta proposta. Alterações no desenho exigem revisar este SQL antes de autorizar o DDL.

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = public, pg_catalog;

LOCK TABLE public.contratos, public.contrato_versoes,
  public.usuarios_administrativos, public.sessoes_administrativas,
  public.limites_autenticacao, public.contrato_fluxos,
  public.contrato_edicoes, public.contrato_documentos,
  public.contrato_assinaturas, public.contrato_pendencias_financeiras
  IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.usuarios_administrativos)
     OR EXISTS (SELECT 1 FROM public.sessoes_administrativas)
     OR EXISTS (SELECT 1 FROM public.limites_autenticacao)
     OR EXISTS (SELECT 1 FROM public.contrato_fluxos)
     OR EXISTS (SELECT 1 FROM public.contrato_edicoes)
     OR EXISTS (SELECT 1 FROM public.contrato_documentos)
     OR EXISTS (SELECT 1 FROM public.contrato_assinaturas)
     OR EXISTS (SELECT 1 FROM public.contrato_pendencias_financeiras)
  THEN
    RAISE EXCEPTION
      'Rollback recusado: há dados do novo bloco. Preservar dados e corrigir para frente.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.contrato_versoes
    WHERE status IN ('ATIVA', 'ASSINADA')
    GROUP BY contrato_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Rollback recusado: versões coexistentes incompatíveis com o índice antigo.';
  END IF;
END;
$$;

DROP TRIGGER contrato_versoes_validar_fluxo_trg
  ON public.contrato_versoes;
DROP TRIGGER contrato_versoes_preservar_assinada_trg
  ON public.contrato_versoes;

-- As tabelas novas levam consigo apenas seus próprios índices/triggers.
-- Assinaturas referenciam documentos/usuários/OTP, NÃO sessões.
-- Edições referenciam documentos. Nenhuma prova sofre SET NULL.
DROP TABLE public.contrato_pendencias_financeiras;
DROP TABLE public.contrato_assinaturas;
DROP TABLE public.contrato_edicoes;
DROP TABLE public.contrato_documentos;
DROP TABLE public.contrato_fluxos;
DROP TABLE public.sessoes_administrativas;
DROP TABLE public.limites_autenticacao;
DROP TABLE public.usuarios_administrativos;

DROP FUNCTION public.kidmais_validar_fluxo_contrato();
DROP FUNCTION public.kidmais_preservar_versao_assinada();
DROP FUNCTION public.kidmais_preservar_edicao_contrato();
DROP FUNCTION public.kidmais_bloquear_mutacao_prova_contrato();

ALTER TABLE public.contrato_versoes
  DROP CONSTRAINT contrato_versoes_contrato_id_id_uk;

DROP INDEX public.contrato_versoes_em_preparacao_uk;
CREATE UNIQUE INDEX contrato_versoes_corrente_uk
  ON public.contrato_versoes (contrato_id)
  WHERE status IN ('ATIVA', 'ASSINADA');

COMMIT;
```

Não remover a função existente `kidmais_set_atualizado_em`, tabelas de auditoria/OTP, Migration 012 ou arquivos de documentos. A remoção futura de sessões por retenção não libera rollback: qualquer usuário/documento/assinatura/edição ou outro dado novo remanescente ainda faz a guarda abortar. Não apagar dados para torná-lo possível. Não há FK composta de sessão nem UNIQUE (usuario_id,id) para desfazer. A ordem de DROP continua válida, sem CASCADE. O rollback de código só deve acompanhar um rollback estrutural bem-sucedido; reativar código antigo sobre novas assinaturas não é uma recuperação compatível. SQL ainda não executado/testado porque o banco proposto não foi criado e não há autorização para isso. O teste do up/down será feito em banco isolado após autorização, antes do banco de trabalho.

## 13. Arquivos previstos e impacto fora de Contrato

| Caminho ou grupo | Mudança proposta |
| --- | --- |
| `lib/autenticacao/**` (novo) | Hash de senha, login, sessão, autorização, limites, provisionamento e repositórios |
| `app/admin/login/**`, `app/api/admin/autenticacao/**` (novos) | Login/logout/reautenticação; única exceção controlada ao gate de sessão é login |
| `lib/http/admin-crm-api.ts` | Resolver ator real e autorização; retirar cabeçalho dev |
| `app/api/admin/clientes/**`, `disponibilidade/**`, `fechamentos/**`, `pagamentos/**`, `contratos/**` | Migrar guard/contexto para sessão, CSRF e permissões; impacto transversal explícito |
| `lib/contratos/repositories/contrato.repository.ts`, `models.ts` e repositórios novos | Ponteiros, versões históricas, fontes, provas, documentos e pendências |
| `lib/contratos/services/contrato.service.ts`, `contrato-publico.service.ts`, `documento.service.ts`, `snapshot-core.ts`, modelos/erros | Edição, fluxos, assinatura, integridade, idempotência e consultas sem ambiguidade |
| `lib/contratos/documento/oficial/registry.ts` e novos templates | Renderização nova versionada, comprovante eletrônico; preservar template/asset V1 |
| `lib/contratos/storage/**` (novo) | Interface documental pequena e adaptador PostgreSQL BYTEA com DbExecutor compartilhado; sem filesystem |
| nova página/componente administrativo; `components/contrato/ContratoPublico.tsx` | Formulário, revisão de documento, história, impressão, liberação e provas |
| `lib/pagamentos/services/pagamento.service.ts`, `repositories/pagamento.repository.ts` | Origem da obrigação, bloqueio de duplicação entre versões e contexto financeiro correto; sem refazer cálculos |
| Serviços de Fechamento/Pricing/comercial | Reutilizar validações para edição e aprovação da revisão, sem reescrever aprovação antiga |
| Serviços/consultas de Disponibilidade | Somente depois de resolver/aprovar a lacuna de transferência: operação oficial de agenda; não usar snapshot como fonte operacional |
| Auditoria/histórico CRM | Reutilizar repositórios; adicionar eventos/contexto, sem mudar eventos anteriores |
| scripts/testes/README/configuração de exemplo e `.gitignore` | Provisionamento seguro, regressões, storage/backup; sem segredos nos exemplos |
| `database/migrations/` | Somente após aprovação explícita: nova migration conforme este desenho, pre/postcheck e rollback; não editar arquivos 009–012 |

Esta lista é estimativa de implementação, não declaração de arquivos já alterados. Na etapa anterior foram criados este documento e evidência temporária de leitura do catálogo. Nesta revisão BYTEA somente este documento foi atualizado; nenhum código funcional alterado.

## 14. Validação exigida após autorização

Além dos 25 cenários do pedido original: login real/errado, usuário inexistente, revogação, expiração, CSRF, papel insuficiente, spoof de header, reautenticação, limite concorrente de tentativas; mesma revisão contra edição concorrente; V1 vigente + V2 rascunho sem alterar leitura/operação financeira; V2 concluída sem duplicar obrigação; pendência financeira; duas assinaturas mesmo documento; falhas de disco/commit/resposta; documento corrompido/ausente sem regeneração; rollback vazio e recusa com dados; preservação byte a byte dos dois PDFs legados e dos dois casos financeiros; conflito de agenda na conclusão.

Reexecutar Contrato, Fechamento, comercial/PIX/Pricing, Pagamentos (unidade, integração, HTTP e concorrência), Identidade/CRM e Disponibilidade; TypeScript, lint direcionado e build. Antes disso, testar migration e rollback em banco isolado. Não usar casos reais como fixtures mutáveis. A inspeção read-only de Pagamentos foi executada na etapa anterior, não nesta revisão BYTEA. Nesta revisão não houve execução de SQL ou testes; não declarar os testes do bloco novo como concluídos.

## 15. Decisões submetidas à aprovação

1. Autenticação local com scrypt, sessões PostgreSQL, dois papéis e provisionamento local sem credenciais predefinidas.
2. Oito tabelas complementares, novo índice de preparação e provas/versões preservadas, sem backfill de banco.
3. V1 permanece ASSINADA fisicamente e histórica por relação, enquanto ponteiro vigente passa a V2; todas as novas alterações exigem novo ciclo das duas partes neste bloco.
4. Pagamento fica na obrigação original; V2 comercialmente diferente gera pendência explícita e não cria/reescreve obrigação. Operações permitidas continuam sob V1 até tratamento financeiro posterior.
5. PDF principal e comprovantes separados persistidos em BYTEA, com checks de hash/tamanho e imutabilidade; importação de legados fica pendente de autorização própria, sem regeneração.
6. Rollback estrutural apenas antes de uso, com abort automático diante de dados novos. Após uso, correção preservando registros.

## 16. Matriz de fonte de verdade e pontos de parada

O snapshot é evidência congelada de uma decisão, não novo cadastro mestre. `dados_fonte` admite campos documentais e referências/resultados de serviços oficiais. Uma intenção de mudança de domínio, se registrada durante elaboração, fica identificada como proposta pendente, não como dado aprovado; sem operação oficial correspondente, não pode receber assinatura Kidmais, liberação ou promoção. A aprovação genérica da revisão na tabela de edições não substitui aprovação do domínio proprietário.

| Campo | Fonte de verdade | Editar diretamente no Contrato? | Validação necessária | Efeito na nova versão |
| --- | --- | --- | --- | --- |
| Redação de cláusula permitida | Template/fontes documentais de Contrato | Sim, em campos delimitados | Schema, limites e revisão humana; se alterar obrigação/valor, encaminhar ao domínio | Novo texto congelado; novas assinaturas |
| Observação exclusivamente documental | Contrato | Sim | Não pode contradizer preço, data, partes ou obrigação oficial | Incluída no snapshot/PDF novo |
| Correção tipográfica documental | Contrato | Sim | Não pode disfarçar troca de identidade, data ou valor | V1 intacta; V2 corrigida |
| Nome, CPF, RG, contato/endereço cadastral | Identidade/CRM | Não | Serviço atualizarClienteInterno e regras de identidade; nova prova quando identidade mudar | Congelar resultado cadastral válido, sem reescrever V1 |
| Troca de contratante/responsável | Identidade/CRM + vínculo do Fechamento | Não | Validar identidade, vínculo e efeitos comerciais/financeiros | Bloqueada enquanto não houver operação oficial de troca pós-contrato |
| Data do evento | Fechamento + Disponibilidade | Não | Transferência oficial, disponibilidade e locks, preço por data | Congelar data aprovada; efetivar operação e vigência atomicamente |
| Período/início/fim/ajuste de horário | Fechamento + Disponibilidade | Não | Configuração, sobreposição, transferência e bloqueio concorrente | Mesmo princípio da data; rascunho não muda ocupação |
| Pacote | Catálogo/Pricing + Fechamento | Não | Vigência/elegibilidade/preço/revisão comercial | Referências e resultado oficial na V2 |
| Convidados/quantidade | Fechamento + Pricing | Não | Capacidade, limites e repercussão em preço/obrigação | Quantidade/valor aprovados congelados |
| Adicionais | Catálogo/Pricing + itens do Fechamento | Não | Elegibilidade, quantidade, preço e persistência de itens | Novos itens aprovados; nenhum item só no JSON |
| Buffet/tema/instrução operacional | Fechamento | Não, quando orientar execução | Serviço proprietário e eventual efeito em pacote/preço | Congelar resultado; não deixar operação com informação diferente |
| Valor base/final | Comercial/Pricing + aprovação de Fechamento | Não | Cálculo oficial, aprovação e centavos exatos | Snapshot aprovado; eventual pendência financeira |
| Desconto | Comercial e suas regras/aprovações | Não | Origem autorizada e cálculo oficial; preservar PIX 10%/3%/cartão 0% | Não aceitar percentual ou total arbitrário |
| Forma/condição de pagamento comercial | Comercial/Fechamento, Migration 012 | Não | Proposta distinta da decisão; aprovação da condição exata | Condição aprovada na V2, sem parcelas financeiras automáticas |
| Plano/parcelas/vencimentos financeiros | Pagamentos | Não | Serviço financeiro oficial da obrigação original | Contrato não muda plano de V1; V2 gera pendência quando cabível |
| Recebimentos/saldo/estornos/comprovantes | Pagamentos | Nunca | Invariantes existentes | Nenhuma alteração ao editar/assinar V2 |
| Status/hash/assinatura/IDs/autoria | Serviços de sistema autenticados | Nunca como campo editável | Reconsulta, permissão, locks e integridade | Derivados pelo servidor |

### Lacunas encontradas no código atual — interromper nestes pontos

Leitura de `lib/fechamentos/services/revisao-comercial.service.ts`: `revisarComercial` exige Fechamento AGUARDANDO_APROVACAO e recusa explicitamente Fechamento que já possui Contrato. Não é serviço de renegociação de V1 assinada. `lib/disponibilidade/services/availability.service.ts` revalida disponibilidade; não transfere reserva. Seu repositório consulta `fechamentos` CONFIRMADO usando `data_evento`/horários e também verifica esses dados em bloqueios administrativos. Mudar apenas a consulta para ler o snapshot seria criar a segunda fonte de verdade proibida. `atualizarClienteInterno` atualiza cadastro, mas não equivale a transferir o vínculo contratual/financeiro para outra pessoa.

Portanto, a arquitetura atual NÃO fornece as operações completas de remarcação pós-contrato, renegociação comercial pós-contrato nem troca de contratante. Não remover os guards existentes, não regredir status do Fechamento e não criar atualização SQL direta a partir do editor. Esses caminhos ficam bloqueados e exigem desenho específico dos serviços proprietários, com aprovação antes de evolução estrutural eventualmente necessária. As oito tabelas da 013 não alegam resolver essa lacuna. O bloco documental pode ser desenhado sem ela; a conclusão de V2 com essas mudanças de domínio não pode ser anunciada como suportada.

### Fluxo de data/horário (10/10 → 15/10)

1. Administrador solicita remarcação; enquanto proposta, V1 e operação continuam em 10/10. Disponibilidade pode oferecer prévia de 15/10, sem reserva/garantia automática.
2. **Ponto de parada atual:** falta operação oficial de Fechamento/Disponibilidade para manter a mudança aprovada pendente e efetivá-la na conclusão. Não assinar um snapshot com 15/10 só porque uma consulta disse disponível.
3. Requisito para futura solução: serviço proprietário deve registrar a intenção/aprovação vinculada à revisão, definir validade e condições, sem mudar ocupação de V1 durante elaboração. Contrato congela esse resultado oficial na assinatura Kidmais.
4. Na conclusão, operação oficial revalida as duas datas/horários sob locks compartilhados com reserva/bloqueio administrativo; trata a ocupação própria por ID no caso de sobreposição, sem ignorar ocupações alheias. Revalida também efeitos comerciais.
5. Efetivação operacional no Fechamento/agenda, aceite OTP, promoção de V2 e auditoria devem usar a mesma transação. Conflito/resultado diferente do snapshot congela a tentativa sem concluir: rollback, OTP não consumido, V1 e ocupação antiga preservados. Se precisar mudar conteúdo já assinado pela Kidmais, gerar outra versão; nunca regenerar aquela.

Não foram propostos agora novos campos de remarcação ou alteração de tabela operacional na 013; isso depende do desenho interrompido no passo 2.

### Fluxo de valor/condição (R$ 9.011,30 → R$ 9.500,00)

1. Alteração é solicitação comercial, não digitação livre do valor final do contrato. Pricing calcula e revisão comercial decide no domínio proprietário.
2. **Ponto de parada atual:** o serviço atual recusa Fechamento com Contrato. É necessário desenhar aprovação de renegociação vinculada à revisão sem sobrescrever a aprovação de V1. Não preencher apenas revisao_comercial_aprovada em Contrato e chamar isso de aprovação oficial.
3. Depois que houver operação oficial aprovada, V2 congela seu resultado; assinaturas se referem a ele. A efetivação comercial e promoção precisam ser transacionais e preservar a decisão histórica de V1.
4. Pagamento P continua com contrato_versao_id=V1 e valor_total_contratado=9011.30 durante e após a elaboração. Nenhum saldo, parcela ou recebimento muda.
5. Quando V2 de 9500.00 efetivamente concluir, inserir pendência ligada a P/V1/V2 (diferença de referência 488.70) na mesma transação. Não gerar cobrança, segundo Pagamento, recalcular desconto nem resolver renegociação financeira. Se o serviço comercial não puder concluir coerentemente, V2 não promove.

## 17. Delta exato proposto da Migration 013 revisada

Esta seção especifica estrutura; não é arquivo de migration. Não há autorização para executar SQL.

| Objeto | Delta |
| --- | --- |
| usuarios_administrativos | Criar conforme 5.1, com papel varchar(32), dois valores permitidos, índice de email normalizado; sem seed |
| sessoes_administrativas | Criar conforme 5.2, token único, FK de usuário e índices de usuário/expiração; SEM UNIQUE (usuario_id,id) e SEM dependência de assinaturas para retenção |
| limites_autenticacao | Criar conforme 5.3, chave HMAC e índice de atualização |
| contrato_fluxos | Criar conforme 5.4, PK contrato e dois FKs compostos de preparação/vigência |
| contrato_edicoes | Criar conforme 5.5, FKs de autoria/origem/documento, checks de grupos opcionais, tipo/estado/revisão; índices de contrato/data e origem |
| contrato_documentos | Criar conforme 5.6, conteudo_pdf BYTEA NOT NULL e sete checks listados; UNIQUE de versão/id e índice versão/data; **sem storage_provider/storage_chave** |
| contrato_assinaturas | Criar conforme 5.7; usuario_id com FK direta usuarios_administrativos(id); sessao_id UUID contextual SEM FK; autenticacao_metodo/autenticado_em congelados com checks por parte; FKs de documentos da mesma versão e OTP; UNIQUE parte/versão e parte/idempotência; índices contextuais sessão e validação |
| contrato_pendencias_financeiras | Criar conforme 5.8, UNIQUE pagamento/versão nova, FKs e índices de contrato/data e versões |
| contrato_versoes_contrato_id_id_uk | Adicionar UNIQUE (contrato_id,id) em tabela existente |
| contrato_versoes_corrente_uk | Substituir pelo contrato_versoes_em_preparacao_uk UNIQUE (contrato_id) WHERE status='ATIVA' |
| Triggers/funções | Exatamente os quatro helpers e triggers descritos na seção 6 e no rollback da seção 12; imutabilidade abrange BYTEA e contexto da assinatura; sessão viva conferida somente na inserção do ato Kidmais, sem dependência histórica ou trigger que altere prova ao excluir sessão |
| Tabelas existentes | Nenhuma coluna nova; nenhum UPDATE/INSERT/DELETE de dados existentes |
| Extensões/roles/credenciais | Nenhuma nova extensão para SHA-256; nenhuma role/senha/usuário criada silenciosamente |
| Domínios operacionais | Nenhuma estrutura de remarcação ou renegociação inferida; caminhos bloqueados conforme seção 16 |

Todos os novos FKs usam ON DELETE RESTRICT ON UPDATE RESTRICT. Os checks de revisão/aprovação/liberação tratam grupos opcionais explicitamente, evitando aceitação por NULL. Documentos/provas/pendências são append-only; o runtime não recebe TRUNCATE/DDL. Os grants operacionais são aplicados somente a roles reais identificadas durante implantação, sem nome de usuário inventado.

O rollback completo da seção 12 continua válido: BYTEA pertence à própria tabela, seus checks/índices caem com ela somente se vazia; qualquer documento já persistido faz a guarda abortar. Não há arquivo externo a remover nem extensão nova a desfazer. Não apagar dados para satisfazer a guarda.

### Conferência final desta revisão

As oito tabelas foram mantidas. Sai filesystem primário; entra BYTEA com tamanho/hash conferidos no banco. A matriz e os fluxos acima substituem a ideia anterior de snapshot como fonte operacional. O provisionamento usa segredo exclusivamente local/processual e o acesso remoto HTTP não enfraquece cookies. Permanecem V1 vigente + V2 em elaboração, uma preparação, promoção atômica quando todos os domínios suportarem a operação, V1/provas preservadas, OTP existente e Pagamento na versão original. Nenhum teste de implementação ou SQL foi executado nesta revisão: somente leitura de código/documentação e edição deste documento.

**Aguardar autorização explícita antes de criar Migration 013, implementar autenticação ou alterar banco. Não iniciar Festa. As lacunas de domínio acima permanecem pontos de parada, não permissões implícitas de implementação.**
