# Smoke operacional de assinatura — exclusivo de staging

CLI manual para **usar** um contrato fictício inicial já preparado pela aplicação,
assinado pela KIDMAIS e liberado para o CLIENTE. Não cria cliente/fechamento/contrato,
não prepara assinatura KIDMAIS e não serve como endpoint ou recurso administrativo.
Execução remota exige autorização própria; implementar/testar este código não a concede.

## Alvo e execução

`target.json` contém somente identificadores públicos fixados e revisados:
serviço `kidmais-manager-staging`, branch `staging`, banco `kidmais_staging_1z91`
e host **exatamente** `dpg-daidko3m8hqs73ce4jt0-a`. A instância PostgreSQL é
`kidmais-staging`; esse nome descritivo não substitui a validação do banco/host e
não deve ser confundido com o nome da aplicação web `kidmais-manager-staging`.
Não deduzir outros hosts a partir desse identificador. Nenhuma credencial neste arquivo.

Requer Node 22.23.2, checkout completo limpo, Git e dependências de desenvolvimento
(TypeScript faz a composição privada dos serviços). Não executar pelo start/build,
CI de deploy, cron ou processo web. O CI executa somente mocks, nunca este comando.

Exemplo **para futura execução autorizada**, sem segredos em argumentos:

```text
node scripts/staging-smoke/run.mjs --execute-staging-smoke --expected-commit <SHA_COMPLETO_APROVADO> --smoke-id <UUID_V4> --contract-id <UUID_DO_CONTRATO>
```

O SHA aprovado deve coincidir com HEAD, origin/staging e RENDER_GIT_COMMIT;
branch, serviço e metadados Render devem coincidir exatamente. Checkout detached,
sujo, desatualizado ou sem metadados também aborta. Não efetua fetch nem deploy.
Esses requisitos são pré-condições, não instruções para alterar ambiente ou Render.

Credenciais próprias de staging devem ser fornecidas por injeção segura ao processo
em `KIDMAIS_STAGING_DATABASE_URL`. Não lê dotenv, arquivos de credenciais nem aceita
URL na linha de comando. Se DATABASE_URL existir, deve ser idêntica à variável dedicada;
ela nunca é usada como fallback. Não reutilizar credenciais de produção.

TLS é obrigatório: `sslmode=verify-full`, porta 5432, certificado/hostname verificados.
O hostname fornecido é interno: resolução e validade de seu certificado **não foram
comprovadas pelos mocks**. Se o ambiente não resolver esse host ou TLS não o validar,
o CLI aborta. Nunca reduzir verificação TLS, inferir hostname externo ou ampliar a
allowlist automaticamente. Isso precisa de análise e autorização separadas.

## Guardas antes de escrever

- Ambiente staging + ID/nome/origem exatos do serviço, branch e SHA aprovado.
- URL PostgreSQL, banco e host exatos; rejeição de produção, outro DATABASE_URL,
  opções de conexão adicionais, NODE_OPTIONS e overrides de PG/TLS.
- OTP real continua gupshup, `GUPSHUP_OTP_ENABLED=false` e
  `KIDMAIS_STAGING_OTP_DISABLED=SIM`. O CLI não modifica essas variáveis.
- GET único no health fixo de staging, sem redirecionamento: database/festa ready,
  gupshup configurado, enabled=false, reason=staging_disabled.
- Mesma sessão TLS para ler current_database(), porta, SSL e privilégios do papel;
  recusa superuser, createdb, createrole, replication e bypassrls.
- Validador estrutural real das migrations 016/019, somente leitura.
- Conferência do fluxo fictício e assinatura KIDMAIS antes de escrever; nova
  conferência sob lock da contratação, dentro da transação.

As guardas protegem contra uso acidental/má configuração em produção. Não são uma
barreira contra alguém que possa editar o código ou falsificar todas as evidências
do processo; isolamento de credenciais, permissões e revisão continuam necessários.

## Fixture obrigatória

Preparar pela aplicação, em tarefa autorizada, um novo fluxo com UUID v4 exclusivo:

- Nome do cliente e observações da equipe: `SMOKE-STAGING-<UUID>`.
- E-mail: prefixo em minúsculas seguido de `@example.invalid`.
- Telefone e WhatsApp sintéticos: `11900000000`; CPF fictício válido, nunca de pessoa real.
- Aniversariante: `SMOKE-STAGING-<UUID>-ANIVERSARIANTE`.
- Endereço fictício: Rua Ficticia Smoke, número 1, Bairro Ficticio, Cidade Ficticia,
  SP, CEP 00000000; sem complemento, RG ou responsável adicional.
- Uma única versão inicial ATIVA, contrato AGUARDANDO_ASSINATURA, edição
  AGUARDANDO_CLIENTE com documento revisado e uma assinatura KIDMAIS válida.
- Snapshot correspondente ao mesmo cliente/fechamento, prefixo, contatos e endereço;
  nenhuma Festa/ocupação prévia. Não reutilizar cliente real ou cenário anterior.

O prefixo e os campos sintéticos são obrigatórios, mas não provam a origem de um CPF:
a preparação administrativa continua responsável por nunca usar dados pessoais reais.

## Fluxo e atomicidade

O loader compõe um grafo privado dos mesmos módulos TypeScript da aplicação, sem
alterar arquivos de domínio, process.env, cache global de módulos ou pool web.
Usa a fábrica real `criarIdentityService` com transporte em memória; substitui
somente a composição de provider da fábrica web nesse grafo privado. A fábrica web
original continua recusando OTP desabilitado, mesmo quando recebe um sender.

`iniciarDesafioContrato` → `confirmarCodigo` → `assinarContratoPublico` → fluxo
público normal → `garantirFestaFormalizada`. Mantém CPF, desafio aleatório, hash,
expiração, prova consumível, documento, snapshot e regras de assinatura. Não há
inserções ad hoc em assinatura nem chamada direta do harness à função de formalização.

Código simulado capturado e consumido uma vez em memória, nunca retornado/logado.
Imports de providers externos são recusados. Após health, bloqueia HTTP/fetch,
HTTP2/UDP e TCP fora do host PostgreSQL fixado; SSL permanece verificado.

Todo o fluxo usa uma transação na mesma conexão; transações internas viram
savepoints. Erro na assinatura, formalização, postcheck ou auditoria provoca rollback.
Postcheck exige duas assinaturas, uma Festa AUTOMATICA_FORMALIZACAO, uma ocupação e
um evento de criação; compara hashes e repete a chamada real com a mesma prova para
verificar idempotência antes do commit.

Auditoria normal `STAGING_SMOKE_ASSINATURA_CLIENTE` registra UUID de smoke, versão,
commit, `MEMORY_ONLY`, synthetic=true e externalOtpEnabled=false, sem código/tokens.
Nova execução de fluxo já concluído só retorna IDs/contagens se essa auditoria for
compatível; não cria outro desafio, assinatura, Festa ou evento.
Erros CLI são sanitizados; não imprimir erro bruto/stack, URL, CPF, códigos ou tokens.

## Distribuição e testes locais

Nada em app/lib importa este diretório; nenhuma rota, flag genérica de bypass ou
comando start/build foi adicionado. Ferramenta operacional fora do runtime web,
com TypeScript como dependência de desenvolvimento. Fixtures não fazem parte do CLI.

```text
node --test scripts/staging-smoke/smoke.test.mjs
```

Mocks cobrem destino/ambiente/SHA/OTP/TLS, rede bloqueada, ausência de logs de código,
identidade/documento inválidos, domínio real de assinatura/formalização, idempotência
e rollback integral inclusive por falha de auditoria. Repositórios e executor SQL
são fixtures em memória: estes testes não atestam permissões, DNS, TLS nem execução
no banco remoto. A regressão estática V1 inclui esses testes.
