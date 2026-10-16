# WhatsApp por empresa (migration 083), 16/10/2026

Cada empresa (tenant) conecta o próprio WhatsApp Business ao Kidmais pelo Embedded Signup da Meta.

**Escopo desta entrega: só a conexão.** Conectar, ver o estado e desconectar. O envio e o recebimento de mensagens, o webhook e o OTP **não** mudam: o atendimento e o OTP continuam na Gupshup, com o número da Kidmais.

## Regras

- **Quem pode:** só a **Gestão da empresa** (`memberships.papel = REPRESENTANTE_AUTORIZADO` na empresa comprovada por `provarTenant`) consulta, conecta e desconecta. Conectar e desconectar exigem a senha reconfirmada há menos de 5 minutos. O papel global (`usuarios_administrativos.papel`) não decide.
- **Unicidade:** uma conexão CONFIGURADA por (ambiente, empresa), e o mesmo `phone_number_id` em no máximo uma conexão CONFIGURADA por ambiente. A violação é recusada com 409 `WHATSAPP_NUMERO_EM_USO`, sem dizer qual empresa usa o número.
- **Vínculo com a empresa:** tentativa, lock e credencial são presos à empresa. A AAD do AES-256-GCM inclui o `empresaId`. Se a empresa ativa muda no meio do fluxo, a conclusão é recusada (`WHATSAPP_TENTATIVA_INVALIDA`).
- **Desconectar:** CONFIGURADA → DESCONECTADA (transição da 018), com motivo e auditoria `WHATSAPP_CONEXAO_DESCONECTADA`. Depois disso o número fica livre.
- **Navegação:** o menu e o hub de Configurações mostram o WhatsApp para a Gestão da empresa. O painel do desenvolvedor só acompanha, na ficha da empresa.
- **Conexão antiga da plataforma** (sem empresa, criada antes da 083), se existir: fica preservada e inerte, e não aparece para nenhuma empresa.

## Migration 083 (`database/migrations/20261016_083_whatsapp_conexao_empresa.sql`)

Aditiva. Nenhuma linha existente é alterada.

- `empresa_id` em `whatsapp_conexoes` e `whatsapp_onboarding_tentativas`.
- CHECKs `NOT VALID`: conexão CONFIGURADA nova e tentativa em andamento nova exigem empresa.
- Índices novos:
  - por empresa;
  - da plataforma (sem empresa);
  - por número;
  - tentativa ativa por empresa.
- O índice antigo, de uma conexão por ambiente, sai.
- Os gatilhos da 018 são recriados com `empresa_id` na identidade imutável.
- Pré e pós-checagem em `database/checks/20261016_083_*`.
- **O pós-check confere as definições pelo catálogo, não só os nomes** (R2 do parecer independente de 16/10):
  - colunas `empresa_id` do tipo `uuid`, com FK validada para `empresas(id)`;
  - CHECKs com a expressão exata (`pg_get_expr`), na tabela certa;
  - índices únicos, válidos, btree, com as colunas e o predicado exatos;
  - gatilhos ligados às tabelas: habilitados, `BEFORE UPDATE OR DELETE FOR EACH ROW` (tgtype 27), sem WHEN nem lista de colunas, na função certa;
  - corpo das funções, por md5 do `prosrc` com CR ignorado.

  Um objeto de mesmo nome com definição diferente reprova. Os controles negativos estão em `lib/whatsapp/conexao-empresa.postgres.test.ts`.
- O rollback (`database/rollback/20261016_083_whatsapp_conexao_empresa_down.sql`) se recusa a rodar quando já existe conexão ou tentativa de empresa (veja a recuperação abaixo).

## Recuperação depois que a 083 tiver dados

Depois do primeiro onboarding de qualquer empresa, mesmo um que falhou, o rollback SQL **se recusa** a rodar: tentativas e conexões de empresa são histórico preservado (os gatilhos da 018 impedem DELETE). **Não há reversão automática do banco a partir desse ponto.** O plano distingue dois casos:

- **Retorno de código (deploy anterior do web):** possível, com a 083 mantida, porque ela é aditiva. Efeitos conhecidos do código anterior sobre um banco com a 083:
  - a tela antiga do WhatsApp só abre para a conta da plataforma;
  - ela consulta a conexão CONFIGURADA do ambiente sem filtrar empresa, e pode mostrar a conexão de uma contratante como se fosse a da plataforma;
  - o "conectar" antigo é recusado (o CHECK exige empresa; o índice por número também se aplica).

  O caminho preferido é corrigir para a frente, sem voltar o código do WhatsApp.
- **Recuperação do schema (desfazer a 083 com dados):** não há procedimento pronto. Exigiria um plano próprio, revisado e autorizado. Por exemplo:
  1. desconectar as conexões pela tela, com auditoria;
  2. preservar as linhas num arquivo ou tabela de histórico;
  3. só então remover as colunas e os índices.

  Esse plano nunca apaga auditoria nem tentativas por SQL avulso.

## Observações registradas (sem mudança de código nesta etapa)

- **Conexão legada da plataforma (sem empresa):** se existir no ambiente, continua CONFIGURADA, inerte e participando do índice único por número.
  - O número dela **não pode** ser adotado por uma empresa enquanto essa linha estiver CONFIGURADA.
  - As telas novas não a mostram nem a desconectam.
  - Transferir esse número exige um procedimento próprio e autorizado. A linha nunca é alterada automaticamente.
- **Filtro de ambiente na ficha do painel:** `whatsappDaEmpresa` (`lib/desenvolvedor/empresas.ts`) lê a conexão da empresa sem filtrar `ambiente`.
  - Com bancos separados por ambiente, o resultado não muda.
  - Num banco com registros dos dois ambientes, poderia mostrar o número do outro ambiente; não há exposição entre empresas.
  - Ajuste recomendado (filtrar pelo ambiente do deploy), não feito nesta entrega.

## Ordem de publicação em staging (cada passo com autorização própria)

1. **Commit e deploy do web.** O código tolera a 083 ausente: o WhatsApp responde 503 `WHATSAPP_ATUALIZACAO_PENDENTE`, e a ficha do painel omite o bloco. O cron não muda.
2. **Conferência, somente leitura, no Shell do web de staging:**
   ```
   node scripts/migration-083-staging.cjs --conferir-083
   ```
   O resultado precisa trazer `CONFERIDO`, `schema.m083 = false` e `schema.pode_alterar = true` (o login do serviço é membro do papel dono das tabelas da 018). Com `pode_alterar = false`, a aplicação para antes de escrever (`SEM_PRIVILEGIO_DDL`).
3. **Aplicação:**
   ```
   node scripts/migration-083-staging.cjs --aplicar-083-autorizado
   ```
   - Roda o precheck (somente leitura), a 083 e o postcheck, a partir dos hashes revisados.
   - Grava a evidência em `/opt/render/project/src/data/atualizacao-staging-20261016`.
   - Uma tentativa anterior bloqueia uma nova até ser revisada.
4. **Validação funcional** com uma empresa real de homologação, como Gestão:
   - Configurações › WhatsApp abre com o nome da empresa;
   - "Preparar conexão" e "Continuar na Meta" abrem a janela da Meta.

**Do lado da Meta:** para empresas de terceiros conectarem, o app precisa do acesso avançado (`whatsapp_business_management` e `whatsapp_business_messaging`) ou de provedor de tecnologia, aprovado na revisão do app. Sem isso, só números ligados às contas de teste do app conectam.

## Testes

- `lib/whatsapp/conexao-empresa.postgres.test.ts`, modelo `083` do PostgreSQL descartável, com a Meta dublada. Cobre:
  - rollback e reaplicação com a conexão antiga preservada;
  - Gestão conecta;
  - isolamento A/B;
  - número único;
  - Equipe e senha antiga recusadas;
  - troca de empresa no meio do fluxo;
  - desconexão;
  - 503 antes da 083;
  - credencial presa à empresa.
- Unitários:
  - `lib/whatsapp/onboarding.test.ts`;
  - `lib/autenticacao/plataforma.test.ts` (o WhatsApp deixou de ser da plataforma; o PDF de Pacotes continua);
  - `lib/autenticacao/contexto.test.ts`;
  - `lib/admin/navegacao.test.ts`;
  - `components/admin/WhatsappConfiguracao.popup.test.mjs`;
  - `scripts/migration-083-staging.test.cjs` (na CI).
