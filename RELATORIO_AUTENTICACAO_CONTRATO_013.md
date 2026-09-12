# Autenticação administrativa e Contrato — entrega da Migration 013

Validação encerrada em 09/09/2026. Fonte: `D:\glass\KidMais Manager\kidmais-manager` e PostgreSQL local. A continuação implementou o bloco funcional autorizado, sem reaplicar ou modificar a Migration 013. Nova versão e retificação documental estão habilitadas; aditivo permanece bloqueado até a revisão específica do template prevista na proposta. Não foi iniciado outro módulo.

## 1. Migration 013 final e motivo

A autenticação anterior dependia de uma habilitação de desenvolvimento, e o Contrato não tinha prova administrativa real, armazenamento imutável do PDF ou distinção entre versão vigente e versão em elaboração. A 013 fornece essas estruturas complementares.

Arquivo aplicado: `database/migrations/20260909_013_autenticacao_contrato.sql`. Seu SHA-256 foi comparado novamente com a evidência da aplicação e permanece igual. Nenhuma Migration 014 foi criada. A Migration 012 e `schema_mvp_kidmais.sql` permanecem byte a byte iguais ao checkpoint.

Artefatos acompanhantes: `database/checks/20260909_013_precheck.sql`, `20260909_013_postcheck.sql` e `20260909_013_rollback.sql`. Os scripts `migration-013.apply.cjs`, `migration-013.validation.cjs` e `migration-013.integrity.cjs` preservam a execução anterior; **não foram reaplicados nesta continuação**.

## 2. Estrutura física antes/depois

Antes: 30 tabelas, versões contratuais e dois casos reais de Pagamentos, sem as oito tabelas administrativas novas. Depois: 38 tabelas. Nenhuma coluna das 30 tabelas anteriores foi modificada. As constraints anteriores foram comparadas integralmente, descontando somente as duas adições autorizadas em `contrato_versoes` — unicidade composta e constraint trigger de fluxo.

| Tabela nova | Conteúdo e proteção |
|---|---|
| usuarios_administrativos | UUID, email normalizado/único, nome/cargo, scrypt, papel obrigatório sem default de privilégio, ativo default true, timestamps. Sem seed. |
| sessoes_administrativas | UUID, FK de usuário, hashes de token e CSRF, autenticação, atividade, expiração, revogação, IP e user-agent. Sessão operacional temporária. |
| limites_autenticacao | Chave HMAC, tipo, contador, janela e bloqueio persistidos. Sem guardar senha tentada. |
| contrato_fluxos | Um registro por Contrato, ponteiros separados para preparação e vigente; FKs compostas asseguram pertencimento. |
| contrato_edicoes | Tipo/origem, estado, revisão, fonte documental, alterações, revisão/aprovação, documento selecionado e autoria da liberação. |
| contrato_documentos | BYTEA, categoria, revisão, versão/template, hashes, tamanho e autoria. INSERT apenas; hash e tamanho conferidos no banco. |
| contrato_assinaturas | Prova permanente de Kidmais/cliente, documento/comprovante exatos, identidade e contexto do ato. INSERT apenas. |
| contrato_pendencias_financeiras | Diferenças explícitas, versões e Pagamento vinculado; unicidade por Pagamento/nova versão; sem execução financeira. |

Em `contrato_versoes`, o índice antigo que permitia apenas uma ATIVA/ASSINADA por Contrato foi substituído pelo índice parcial de uma ATIVA. A constraint `UNIQUE(contrato_id,id)` permite FKs de pertencimento. Triggers preservam versões assinadas, edições congeladas e consistência transacional do fluxo. Quatro funções novas implementam essas proteções. Reutiliza-se a função anterior de atualização de timestamp.

A assinatura Kidmais mantém FK de `usuario_id`, mas **não tem FK de `sessao_id` para sessões**. Congela nome, cargo disponível, papel, usuário, UUID histórico da sessão, método, instante real da autenticação, request_id e contexto disponível. A assinatura do cliente mantém a validação OTP pertinente. Nenhum hash de senha, token ou CSRF integra a prova.

O catálogo final completo, incluindo tipos, defaults, nulabilidade, constraints, índices, triggers e funções, está em `.tmp/verificacao-final-013.json`. Essa coleta usa transação somente leitura.

## 3. UP/DOWN isolado e rollback

Evidência preservada em `.backups/pre-013-20260909-183215/teste-isolado.json`: UP/postcheck, 65 objetos nomeados, DOWN vazio, segundo UP, recusa de DOWN após uso, BYTEA, hashes, imutabilidade e exclusão da sessão histórica. Banco da validação estrutural: `kidmais_013_test_1788989979908`.

O rollback trava as tabelas pertinentes e recusa execução se QUALQUER tabela nova tiver dados ou se versões coexistentes impedirem o índice anterior. Antes de uso, remove os objetos novos na ordem de dependência e restaura o índice anterior. Não contém limpeza de dados para vencer a guarda, não transforma assinatura em NULL e não altera Pagamentos. Depois de uso, exige preservação dos dados e correção para frente; não se deve reverter só o código para a versão anterior e continuar criando contratos sobre o banco novo.

Nenhum DOWN foi executado no banco de trabalho nesta continuação. Os checkpoints permanecem disponíveis; restaurá-los futuramente exige uma decisão operacional explícita e coordenada entre código e banco.

## 4. Aplicação no banco local

A aplicação já autorizada e concluída está registrada em `.backups/pre-013-20260909-183215/aplicacao-local.json`. A continuação conferiu o banco físico, os objetos e o hash do arquivo aplicado; não recriou a migration.

## 5. Comparação e preservação

Comparação final de todas as linhas, serializadas integralmente e ordenadas, das **30 tabelas anteriores**: mesmas contagens e mesmos SHA-256 do checkpoint. Inclui Clientes, aniversariantes, Fechamentos, aprovações, Contratos, versões, snapshots, hashes, OTP, agenda, auditoria, histórico e todas as tabelas de Pagamentos.

As oito tabelas novas continuam **vazias no banco de trabalho**. Nenhum usuário administrativo real foi criado. Os testes de autenticação e contratos com commits executaram em clones isolados; suítes antigas também utilizam transações com rollback. Nenhum backfill ou importação de PDF legado ocorreu.

Os dois casos reais mantêm os valores, planos, parcelas, recebimentos, estorno e comprovante anteriores. Permanecem dois Pagamentos, três planos, cinco parcelas, três recebimentos, três alocações, um estorno e um comprovante.

Arquivos protegidos conferidos por hash: `.env.local`, `next.config.ts` (incluindo Tailscale), `next-env.d.ts`, `data/disponibilidade.json`, Migration 012 e `schema_mvp_kidmais.sql`. O build gerou referências de tipos em `next-env.d.ts`; esse efeito automático foi restaurado exatamente do checkpoint, seguido de nova verificação TypeScript. Nenhum código de Festa foi alterado; a rota antiga `/festas/[id]` aparece no build porque já existia.

## 6. Bootstrap e provisionamento

Comandos locais implementados:

```powershell
node scripts/admin-provision.cjs bootstrap
node scripts/admin-provision.cjs criar
node scripts/admin-provision.cjs atualizar
```

O primeiro cria exclusivamente REPRESENTANTE_AUTORIZADO e recusa execução se existir QUALQUER usuário, inclusive inativo. O lock de tabela serializa dois bootstraps; exatamente um venceu no teste concorrente.

O CLI solicita a conexão de provisionamento em prompt oculto ou usa `KIDMAIS_PROVISION_DATABASE_URL` previamente injetada no processo. Não carrega `.env.local` nem usa `DATABASE_URL` como fallback. Senha e confirmação são digitadas de forma oculta em terminal interativo; não entram em argumentos, logs ou auditoria. Não existe senha padrão, usuário fixo ou rota web de provisionamento. A confirmação final exige digitar `CONFIRMAR`.

O comando `atualizar` permite papel, ativação/desativação e redefinição opcional de senha, revogando as sessões. A auditoria registra a operação de provisionamento como SISTEMA/CLI e dados não secretos. Não foi criada automaticamente uma role PostgreSQL operacional nem alteradas credenciais reais.

## 7. Arquivos alterados

O inventário completo ao final deste documento foi calculado contra o manifesto do checkpoint pré-013, pois esta pasta não é um repositório Git. Ele distingue arquivos novos e alterados e informa finalidade/cobertura. Os 64 arquivos de implementação, migration e testes devem permanecer juntos; não há reversão de correções válidas da etapa PIX.

Impactos fora de Contrato: rotas administrativas e cliente HTTP do CRM, layout de `/clientes`, Disponibilidade administrativa, revisão de Fechamento e rotas de Pagamentos passaram a exigir sessão/CSRF reais. A regra comercial do PIX não foi reescrita. O renderer do resumo recebeu somente um rótulo de cabeçalho opcional, com default anterior preservado, para produzir comprovantes corretamente identificados.

## 8. Autenticação implementada

Login por email/senha, scrypt assíncrono `N=131072, r=8, p=1`, salt de 16 bytes, derivação de 64 bytes, comparação em tempo constante e no máximo duas derivações simultâneas por processo. Política de 15–128 caracteres, com limite de bytes e sem truncamento.

Tokens opacos aleatórios de 32 bytes; PostgreSQL armazena somente hashes. Sessão de oito horas absolutas e 30 minutos sem atividade. Login emite um token novo; reautenticação rotaciona e revoga o anterior atomicamente. Logout, desativação, alteração de papel e redefinição de senha revogam sessões. Usuário inexistente e senha incorreta recebem resposta genérica.

CSRF aleatório em cookie HttpOnly, devolvido pelo endpoint same-origin de sessão e exigido em cabeçalho nas mutações, inclusive login. Origin deve coincidir com ADMIN_AUTH_ORIGIN. Rate limit persistido: cinco tentativas por identificador em 15 minutos (sucesso limpa seu contador) e até 30 tentativas por origem em cinco minutos. Sem proxy confiável configurado, a origem de limitação é um bucket compartilhado conservador; IP não é inventado a partir de cabeçalhos do cliente.

Em HTTPS, cookies `__Host-`, Secure, HttpOnly, SameSite=Lax, Path=/, sem Domain. HTTP é exceção de desenvolvimento local; o endereço IP HTTP do Tailscale não foi autorizado como origem administrativa segura. Nenhum cabeçalho `x-kidmais-dev-user-id` autentica usuários. Seu único uso restante é um teste de spoof que deve ser recusado.

## 9. Tela administrativa

`/admin/login` oferece o formulário real. `/admin/contratos` reúne seleção do Contrato, vigente, preparação, histórico, contratante, evento, valor, forma e condições comerciais, campo documental, documentos, assinaturas e comprovantes. `/clientes` e `/admin/*` utilizam a sessão administrativa; a autorização efetiva permanece também nas APIs.

A única edição habilitada diretamente no Contrato é **observação documental**, limitada a 2.000 caracteres. O payload é estrito: não aceita alterações de contratante, data, horário, pacote, convidados, valor, desconto, condição comercial, parcelas, IDs, status, hash ou assinatura. Observações não constituem autorização para mudar obrigações desses domínios.

Salvar incrementa a revisão, recalcula o snapshot/hash e invalida revisão documental anterior. Gerar PDF produz um novo registro; revisar seleciona o documento exato após confirmação explícita. A tela pode regenerar documento somente durante elaboração. Geração antiga pelo Fechamento não sobrepõe uma elaboração administrativa existente.

A conferência comercial registrada na edição atesta a correspondência com as condições já existentes no snapshot. Ela não cria aprovação oficial de renegociação, não substitui o serviço Comercial e não modifica a aprovação do Fechamento.

## 10. Assinatura Kidmais e liberação

Somente REPRESENTANTE_AUTORIZADO assina. O serviço confere a sessão real, usuário ativo, papel, vínculo da sessão, janela de cinco minutos, versão/revisão exatas, PDF revisado e hashes dentro da transação. A prova vem da identidade autenticada, não do nome fixo existente no template jurídico legado. Tentativas concorrentes com a mesma chave retornam a mesma assinatura; operação divergente é recusada.

Após assinatura, fonte, snapshot, revisão, documento BYTEA e prova são congelados. ADMINISTRATIVO comum foi recusado ao assinar e permitido ao **liberar** depois da assinatura Kidmais. Liberação não é assinatura, recebimento ou quitação. Ela muda para AGUARDANDO_CLIENTE e registra autor/instante.

A exclusão da sessão utilizada foi testada depois do commit: a assinatura e a liberação continuaram válidas e a prova permaneceu idêntica. Limpeza futura de sessões expiradas/revogadas não faz UPDATE/SET NULL na prova; a política e o job de retenção não foram implementados neste bloco.

## 11. BYTEA, comprovantes e impressão

O PDF principal é persistido antes da assinatura e servido pelo seu registro imutável. O aceite não o gera novamente. Leitura confere SHA-256 e tamanho; o banco recusa hash/tamanho incompatíveis e UPDATE/DELETE de documentos. A aplicação limita a geração a 10 MB.

Cada parte recebe comprovante independente, também BYTEA, com parte, nome, versão, instante, método, hash do PDF e hash do snapshot. A linha permanente de assinatura guarda contexto mais completo que a apresentação PDF. Na revisão visual foi corrigido um comprovante que não renderizava o corpo; o teste agora exige parte e seção de dados nos bytes do PDF.

“Imprimir contrato completo” abre uma composição lógica de três objetos: principal, comprovante Kidmais e comprovante cliente quando disponível. Cada visualizador permite impressão/abertura do objeto. Não foi gerado ou armazenado um PDF combinado permanente, nem alterado o original para anexar certificados. A composição não substitui uma assinatura criptográfica PAdES/ICP-Brasil.

Os PDFs legados continuam no checkpoint anterior. Sua regeneração para apresentação como original assinado fica recusada, e não foram importados para BYTEA. O resumo informativo mantém o mecanismo anterior baseado no snapshot; não é tratado como o PDF principal assinado.

## 12. Versionamento

V1 assinada permanece vigente enquanto V2 é preparada. A nova elaboração copia o snapshot consolidado e as observações documentais anteriores, mas não herda assinaturas. Cada nova versão ou retificação exige revisão e assinatura Kidmais, liberação e aceite do cliente.

Somente após aceite válido a transação conclui a edição, registra prova do cliente, promove o ponteiro vigente e atualiza o número da versão lógica. V1 permanece histórica/imutável. O Fechamento já avançado não regride para um estado anterior por causa de uma nova versão documental.

## 13. Cliente e OTP

O mecanismo OTP existente foi preservado. O token de acesso fica vinculado ao Contrato/versão/desafio; a prova é conferida para esse contexto. PDF, snapshot e hashes do aceite são os mesmos revisados e assinados pela Kidmais.

A interface pública foi corrigida para decidir o aceite pelo status da **versão exibida**, permitindo aceitar V2 quando o Contrato lógico já está assinado por V1. Os comprovantes podem ser baixados com a mesma autorização contextual. Documento de outra categoria/versão não pode ser usado como comprovante. Disponibilidade e Fechamento públicos continuam públicos.

## 14. Pagamentos

Pagamento continua vinculado à `contrato_versao_id` original. Recebimentos validam pertencimento, assinatura, integridade do snapshot e valor da obrigação original, sem exigir que seja a última versão. A criação valida a versão vigente assinada e impede criar segunda obrigação quando já há Pagamento em outra versão do mesmo Contrato.

V2 documental não recalcula desconto, total, parcelas, recebimentos, saldo, estornos ou comprovantes. Promoção com diferença comercial tem uma função de registro idempotente de pendência financeira; ela não renegocia nem transfere obrigação. Esse caso foi exercitado isoladamente em transação revertida, com objeto sintético de diferença — **não foi habilitada uma jornada de renegociação comercial para produzir essa mudança no produto**.

O teste antigo que recusava recebimento por versão antiga foi atualizado para a semântica aprovada. As demais invariantes financeiras e os testes de UUID/subcentavos foram mantidos.

## 15. Testes executados

| Bateria | Resultado |
|---|---|
| Autenticação/Contrato com PostgreSQL e commits isolados | 30 cenários aprovados |
| Navegador real Edge/Playwright contra Next dev isolado | Login, painel, versão, edição, PDF, revisão, reautenticação, assinatura, liberação, impressão, CRM/CSRF e logout aprovados; nenhum pageerror |
| Comercial/PIX unitário | 22/22 |
| Comercial/Fechamento/Contrato/OTP/Pagamentos integrado | 19 cenários, incluindo conferência imediata dos triggers diferidos do fluxo inicial |
| Contrato unitário | 12/12 |
| Pagamentos unitário | 30/30 |
| Pagamentos engenharia PostgreSQL | 24 cenários |
| Pagamentos HTTP | 35 requisições com autenticação real |
| Pagamentos/agenda concorrência | 5 cenários com espera física observada |
| Disponibilidade unitário | 5/5 |
| PricingService | 10 cenários |
| Identidade repository/service/Fechamento | 8 / 9 / 4 verificações funcionais anteriores aprovadas |
| TypeScript | Sem erros |
| Lint direcionado dos arquivos funcionais/testes alterados | 56 arquivos, sem erros ou avisos na execução final |
| Build Next 16.3.4 | Compilação, tipos e geração de páginas aprovados |
| Dados/catálogo/arquivos protegidos | Conferidos e preservados |
| PDF visual | Principal de três páginas e dois comprovantes de uma página conferidos |

Cobertura de autenticação inclui bootstrap concorrente/recusa, usuário inexistente, senha errada, login, inatividade, expiração absoluta, logout, desativação, mudança de papel, CSRF, spoof, rate limit persistido, reautenticação correta/incorreta/fora da janela e cookies HTTPS de produção em handlers reais.

Cobertura documental inclui revisão desatualizada, assinatura concorrente/idempotente, papel comum recusado ao assinar/permitido ao liberar, sessão histórica excluída, BYTEA/hash/UPDATE/DELETE, V1+V2, promoção, OTP/retry, conteúdo dos comprovantes e campos de outro domínio recusados.

## 16. Regressões e reprodução automatizada

Executados nesta continuação:

```powershell
node --env-file=.env.local scripts/admin-contrato.integration.cjs
node --env-file=.env.local scripts/validacao-funcional-013.cjs
node --env-file=.env.local scripts/admin-navegador.integration.cjs
npx.cmd tsc --noEmit
npm.cmd run build
node --env-file=.env.local scripts/verificacao-final-013.cjs
```

O primeiro cria um clone de teste a partir do banco atual, sem reaplicar a migration. O segundo executa as baterias unitárias e integrações nesse clone; comandos e resultados ficam em `.tmp/regressoes-013.json` e `.tmp/regressao-013-*.log`. O terceiro cria credencial sintética em memória, inicia Next local na porta 3100, percorre a UI e encerra o servidor de teste. Reexecutar o ciclo deve começar pelo primeiro script, para obter clone limpo.

O runner de navegador utiliza Playwright disponível no runtime desta máquina e Edge instalado; `PLAYWRIGHT_MODULE` permite informar outro caminho do módulo. O runner de clone utiliza os utilitários PostgreSQL 18 no caminho local registrado no script. Não se presume portabilidade desses dois caminhos para outra máquina.

Resultados detalhados: `.tmp/admin-contrato-resultados.json`, `.tmp/navegador-013.json`, `.tmp/lint-013.log` e `.tmp/verificacao-final-013.json`. Capturas: `.tmp/admin-login-013.png`, `.tmp/admin-contrato-013.png`, `.tmp/admin-impressao-013.png`. PDFs copiados para inspeção ficam em `.tmp/pdf-013`; são evidência de teste, não storage do produto.

## 17. Limitações e pontos de parada

- **Publicação ainda exige configuração operacional.** A conexão local existente é superusuária. O runtime web deve receber uma role com privilégios mínimos, sem provisionar/promover usuários; a conexão do CLI deve ser separada. Nenhuma role ou senha real foi criada automaticamente. Não declaro esse ambiente local pronto para exposição pública.
- ADMIN_AUTH_SECRET e ADMIN_AUTH_ORIGIN devem ser configurados pelo operador. HTTP remoto/Tailscale não recebe exceção para autenticação; produção exige HTTPS e origem correta. Não foi testado um proxy TLS real de implantação, somente cookies/regras de produção nos handlers.
- Aditivo continua recusado no serviço e desabilitado na tela. A proposta aprovada exige revisar seu template e cláusulas antes da habilitação. Não foi inventada uma cláusula de substituição integral nem anunciado aditivo assinável.
- Remarcação, renegociação comercial pós-contrato, troca de contratante e renegociação financeira continuam bloqueadas e exigem autorização/desenho dos serviços proprietários. Somente observações documentais estão editáveis neste bloco.
- Não há importação de PDF legado, ICP-Brasil, assinatura PAdES, provider externo, cobrança automática ou job de retenção. OTP local console continua sendo o mecanismo anterior para teste, sem envio externo real.
- O teste financeiro de pendência valida a função e a ausência de mutação, não um fluxo comercial pós-contrato completo. Concorrência foi validada nos casos descritos, não como teste de carga ou recuperação de queda.
- Os testes de infraestrutura com rollback não substituem os testes de commit; por isso há também fluxo V2 com commits reais em clone e conferência dos triggers diferidos no fluxo inicial.
- Avisos do Node sobre módulo TS e de pg sobre consultas simultâneas no mesmo cliente do harness continuam existentes. O Poppler emitiu avisos sobre fontes de fallback, mas as páginas renderizadas foram inspecionadas. O lint global de arquivos antigos fora do escopo não foi declarado corrigido.

## 18. Passo a passo exato no navegador

### Preparar o acesso local

1. Abra um terminal PowerShell na pasta `D:\glass\KidMais Manager\kidmais-manager`. Não execute migrations.
2. Configure em `.env.local` `ADMIN_AUTH_ORIGIN=http://localhost:3000` e `ADMIN_AUTH_SECRET` com segredo aleatório de pelo menos 32 caracteres. Preserve DATABASE_URL, pepper/OTP e demais configurações existentes. Esse é um segredo do servidor, diferente da sua senha de usuário. Não use prefixo NEXT_PUBLIC.
3. Para criar um segredo de servidor sem exibi-lo, caso ainda não exista a configuração, execute em PowerShell:

```powershell
$bytesAdmin = New-Object byte[] 32
$rngAdmin = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rngAdmin.GetBytes($bytesAdmin)
$secretAdmin = [Convert]::ToBase64String($bytesAdmin)
Add-Content -LiteralPath '.env.local' -Value "`nADMIN_AUTH_ORIGIN=http://localhost:3000`nADMIN_AUTH_SECRET=$secretAdmin"
$rngAdmin.Dispose()
Remove-Variable bytesAdmin, rngAdmin, secretAdmin
```

Não repita para criar chaves duplicadas se essas variáveis já estiverem presentes; nesse caso edite as entradas existentes. Nenhum desses comandos foi executado automaticamente no banco/ambiente real.

4. No terminal local interativo, execute `node scripts/admin-provision.cjs bootstrap`. No prompt oculto informe a conexão PostgreSQL de provisionamento. Informe seu email, nome e cargo opcional. Escolha você mesmo sua senha de 15–128 caracteres, confirme-a e digite `CONFIRMAR`. A senha não será exibida. Se já existir usuário, o bootstrap recusa; não apague usuários para reabrir bootstrap.
5. Execute `npm.cmd run dev`. Caso já exista servidor nessa porta, reinicie-o para carregar as variáveis novas. Abra **http://localhost:3000/admin/login** — use essa origem exata nesta configuração, não o IP HTTP do Tailscale.
6. Entre com sua conta. Deve abrir `/admin/contratos`, mostrar seu nome e a navegação Clientes/Contratos/Disponibilidade. Em janela anônima, abrir uma página administrativa deve levar ao login e a API administrativa deve recusar sem sessão.

### Criar uma contratação de teste nova

7. Não use os dois casos reais preservados. Abra `/disponibilidade`, escolha data e horário livres e siga para Fechamento. Na contratação de teste, escolha Festa Completa e 50 convidados, sem adicionais, buffet a definir. Complete seus dados de teste válidos.
8. Informe base comercial combinada **9.290,00**. Na etapa da forma de pagamento, confira PIX à vista **8.361,00**, PIX parcelado **9.011,30** e Cartão **9.290,00**. Selecione PIX parcelado e informe uma proposta parcial, por exemplo parcela pretendida **500,25**, deixando outros campos vazios.
9. Abra F12 → Rede/Network e envie para conferência. Copie `fechamentoId` da resposta de `/api/fechamentos`. O estado esperado é AGUARDANDO_APROVACAO; nenhuma parcela financeira ou Pagamento deve existir.
10. Já autenticado, abra `/admin/fechamentos/FECHAMENTO_ID/revisao`, substituindo o ID. Aprove a base 9290 quando solicitada, entrada **0**, parcela **4505,65**, quantidade **2**, motivo e confirmação de conferência. O resultado é AGUARDANDO_CONTRATO com proposta/aprovação separadas e total **9011,30**.
11. Clique **Gerar contrato**. Use o link **Abrir revisão e assinatura administrativa do Contrato** e selecione a contratação na lista. Abrir acesso público antes da liberação não deve permitir o aceite.

### Revisar e assinar pela Kidmais

12. Na versão inicial EM_ELABORACAO, confira contratante, evento e condição de pagamento. Se necessário, preencha somente uma observação documental e clique **Salvar revisão**. Não tente alterar preço/data/partes por essa observação.
13. Clique **Gerar PDF da revisão N**. Abra o PDF dessa revisão e confira os dados. Clique **Confirmar revisão deste PDF** e confirme a mensagem que identifica a versão, revisão e ID exatos.
14. No campo **Confirme sua senha**, digite sua senha. Clique **APROVAR E ASSINAR PELA KIDMAIS** e confirme o ato. O estado passa a ASSINADA_KIDMAIS, o comprovante aparece e o conteúdo deixa de ser editável.
15. Clique **LIBERAR PARA O CLIENTE**. O estado passa a AGUARDANDO_CLIENTE e aparece **Abrir acesso público do cliente**. Essa ação não registra pagamento nem recebimento.
16. Opcionalmente, para testar o papel comum, crie outra conta com `node scripts/admin-provision.cjs criar`, escolha ADMINISTRATIVO e uma senha definida por você. Em outra sessão, esse papel pode revisar/liberar após a assinatura, mas o serviço deve recusar sua tentativa de assinar pela Kidmais.

### Aceite do cliente

17. Abra o link público `/contrato/CONTRATO_ID`. Informe o CPF usado no novo Fechamento, escolha o contato e solicite o código. No provider local console, o OTP aparece no terminal do Next; não é enviado por WhatsApp real nesse modo.
18. Confirme os seis dígitos. Confira o resumo, abra a aba **Contrato Oficial**, marque o aceite e clique **Aceitar e assinar eletronicamente**. Deve registrar o aceite da versão exibida e disponibilizar os comprovantes. Não cria Pagamento automaticamente.
19. Volte ao painel administrativo. A edição estará CONCLUIDA, a versão será vigente/ASSINADA e existirão dois comprovantes. Abra **Imprimir contrato completo**: o principal e os dois comprovantes são objetos separados. Imprima pelo controle de cada visualizador.

### Criar Pagamentos explicitamente

20. Copie o fechamentoId do novo teste. Abra `/api/admin/pagamentos?fechamentoId=FECHAMENTO_ID`: antes da criação não há Pagamento. Na mesma origem autenticada, no Console do navegador, faça a operação explícita abaixo, ajustando ID e vencimentos:

```javascript
const sessao = await (await fetch('/api/admin/autenticacao', {cache:'no-store'})).json();
const resposta = await fetch('/api/admin/pagamentos', {
  method: 'POST',
  headers: {'Content-Type':'application/json', 'x-csrf-token':sessao.data.csrf},
  body: JSON.stringify({
    fechamentoId: 'COLE_O_ID_DO_NOVO_TESTE',
    plano: {meioPagamento:'PIX', modalidade:'PARCELADO', parcelas:[
      {valor:4505.65, vencimento:'2026-09-20', confirmaReserva:true},
      {valor:4505.65, vencimento:'2026-10-01'}
    ]}
  })
});
console.log(resposta.status, await resposta.json());
```

21. Espere HTTP 201, total 9011,30 e soma de parcelas 9011,30. Não há novo desconto. A criação do plano não equivale a recebimento.

### Nova versão e controles

22. Na vigente assinada desse novo teste, escolha Nova versão ou Retificação documental, informe motivo e clique **Iniciar elaboração**. A vigente anterior deve continuar assinada; a nova não terá assinaturas. A obrigação financeira continua vinculada à anterior.
23. Altere somente a observação documental, salve, gere/revise outro PDF, assine pela Kidmais e libere. O cliente precisa repetir OTP/aceite da nova versão. Até a conclusão, a vigente anterior permanece; depois, a nova é promovida e a anterior fica no histórico.
24. Não tente usar esse fluxo para remarcação, troca de contratante, mudança de valor ou renegociação financeira. Aditivo está desabilitado nesta entrega.
25. Clique **Sair**. Reabrir API administrativa deve retornar ausência de autenticação. Para desativar, promover ou redefinir senha de um usuário de teste, use `node scripts/admin-provision.cjs atualizar`; sessões anteriores devem deixar de funcionar.

Os testes manuais criam dados reais no banco selecionado. Para preservar os dois casos existentes, utilize somente uma contratação nova e as contas que você provisionar conscientemente.

---

## Inventário completo de arquivos

| Arquivo | Estado | Motivo / decisão | Cobertura |
|---|---|---|---|
| app/admin/contratos/imprimir/page.tsx | novo | Interface/layout administrativo, navegação e apresentação documental. Mantido. | Navegador real, TypeScript, lint e build |
| app/admin/contratos/page.tsx | novo | Interface/layout administrativo, navegação e apresentação documental. Mantido. | Navegador real, TypeScript, lint e build |
| app/admin/layout.tsx | novo | Interface/layout administrativo, navegação e apresentação documental. Mantido. | Navegador real, TypeScript, lint e build |
| app/admin/login/page.tsx | novo | Interface/layout administrativo, navegação e apresentação documental. Mantido. | Navegador real, TypeScript, lint e build |
| app/api/admin/autenticacao/route.ts | novo | Endpoint/contexto protegido para autenticação ou documentos exatos; erros/no-store. Mantido. | Handlers reais, OTP, navegador e TypeScript |
| app/api/admin/clientes/analisar-cadastro/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/admin/clientes/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/admin/clientes/[id]/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/admin/contratos/documentos/[documentoId]/route.ts | novo | Endpoint/contexto protegido para autenticação ou documentos exatos; erros/no-store. Mantido. | Handlers reais, OTP, navegador e TypeScript |
| app/api/admin/contratos/painel/route.ts | novo | Endpoint/contexto protegido para autenticação ou documentos exatos; erros/no-store. Mantido. | Handlers reais, OTP, navegador e TypeScript |
| app/api/admin/contratos/pdf/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/admin/contratos/resumo/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/admin/contratos/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/admin/contratos/versoes/[versaoId]/route.ts | novo | Endpoint/contexto protegido para autenticação ou documentos exatos; erros/no-store. Mantido. | Handlers reais, OTP, navegador e TypeScript |
| app/api/admin/disponibilidade/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/admin/fechamentos/[fechamentoId]/revisao/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/admin/pagamentos/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/admin/pagamentos/[pagamentoId]/comprovantes/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/admin/pagamentos/[pagamentoId]/estornos/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/admin/pagamentos/[pagamentoId]/plano/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/admin/pagamentos/[pagamentoId]/recebimentos/route.ts | alterado | Guard de sessão/CSRF e ator real; respostas CRM sem cache quando aplicável. Mantido. | Regressões HTTP, Comercial, CRM e navegador |
| app/api/contratos/route-utils.ts | alterado | Endpoint/contexto protegido para autenticação ou documentos exatos; erros/no-store. Mantido. | Handlers reais, OTP, navegador e TypeScript |
| app/api/contratos/[contratoId]/comprovante/route.ts | novo | Endpoint/contexto protegido para autenticação ou documentos exatos; erros/no-store. Mantido. | Handlers reais, OTP, navegador e TypeScript |
| app/clientes/layout.tsx | novo | Interface/layout administrativo, navegação e apresentação documental. Mantido. | Navegador real, TypeScript, lint e build |
| components/admin/admin.module.css | novo | Interface/layout administrativo, navegação e apresentação documental. Mantido. | Navegador real, TypeScript, lint e build |
| components/admin/AdminDisponibilidade.tsx | alterado | Mutações administrativas enviam CSRF real; público preservado. Mantido. | Disponibilidade, API guard e TypeScript |
| components/admin/AdminShell.tsx | novo | Interface/layout administrativo, navegação e apresentação documental. Mantido. | Navegador real, TypeScript, lint e build |
| components/admin/ContratoAdmin.tsx | novo | Interface/layout administrativo, navegação e apresentação documental. Mantido. | Navegador real, TypeScript, lint e build |
| components/admin/RevisaoComercial.tsx | alterado | Sessão/CSRF e encaminhamento à revisão/assinatura administrativa. Mantido. | Comercial, navegador e TypeScript |
| components/clientes/ClientesPage.tsx | alterado | Orientação de erro atualizada para login real. Mantido. | Navegador CRM, TypeScript e build |
| components/contrato/ContratoPublico.tsx | alterado | Aceite por status da versão e download contextual dos comprovantes. Mantido. | OTP, contexto/comprovantes, TypeScript e build |
| database/checks/20260909_013_postcheck.sql | novo | Estrutura/checks da 013 já aplicada; preservar integralmente. Mantido. | UP/DOWN e catálogo físico anteriores; conferência final |
| database/checks/20260909_013_precheck.sql | novo | Estrutura/checks da 013 já aplicada; preservar integralmente. Mantido. | UP/DOWN e catálogo físico anteriores; conferência final |
| database/checks/20260909_013_rollback.sql | novo | Estrutura/checks da 013 já aplicada; preservar integralmente. Mantido. | UP/DOWN e catálogo físico anteriores; conferência final |
| database/migrations/20260909_013_autenticacao_contrato.sql | novo | Estrutura/checks da 013 já aplicada; preservar integralmente. Mantido. | UP/DOWN e catálogo físico anteriores; conferência final |
| lib/autenticacao/senha.ts | novo | Scrypt, comparação e concorrência de derivação. Mantido. | Autenticação real, bootstrap e navegador |
| lib/autenticacao/service.ts | novo | Sessões, rate limit, login/logout e reautenticação persistidos. Mantido. | 30 cenários e navegador |
| lib/clientes/api-client.ts | alterado | Cliente HTTP envia CSRF obtido da sessão e trata perda de autenticação. Mantido. | HTTP e navegador CRM/Contrato |
| lib/clientes/services/errors.ts | alterado | Política real de origem/sessão, contexto autenticado e erros seguros. Mantido. | Autenticação, spoof/CSRF, APIs e TypeScript |
| lib/contratos/documento/models.ts | alterado | Cabeçalho opcional de comprovante, mantendo default anterior do resumo. Mantido. | 12 unitários Contrato, conteúdo e inspeção visual PDF |
| lib/contratos/documento/pdf.ts | alterado | Cabeçalho opcional de comprovante, mantendo default anterior do resumo. Mantido. | 12 unitários Contrato, conteúdo e inspeção visual PDF |
| lib/contratos/repositories/contrato.repository.ts | alterado | Resolver vigente/preparação pelos ponteiros, com fallback legado. Mantido. | V1/V2 e regressões Pagamentos |
| lib/contratos/services/acesso-token.ts | alterado | Validar token por Contrato e versão histórica exata. Mantido. | Unitários Contrato e fluxo OTP |
| lib/contratos/services/administrativo.service.ts | novo | Revisões, PDF, assinatura Kidmais, liberação e novas versões documentais. Mantido. | Fluxo inicial/30 cenários/navegador |
| lib/contratos/services/contrato-publico.service.ts | alterado | Token para versão exata, PDF congelado, aceite e comprovantes. Mantido. | OTP real em integração, promoção e retry |
| lib/contratos/services/contrato.service.ts | alterado | Geração inicial com autoria/edição; não sobrepor elaboração administrativa. Mantido. | 19 cenários comerciais e triggers diferidos |
| lib/contratos/services/fluxo-publico.ts | novo | Leitura BYTEA, promoção e pendência sem mutação financeira. Mantido. | OTP, V1/V2, idempotência e pendência isolada |
| lib/contratos/storage/postgres.ts | novo | Persistência/leitura BYTEA com integridade e limite. Mantido. | Hash/tamanho, imutabilidade, PDFs no navegador |
| lib/http/admin-crm-api.ts | alterado | Política real de origem/sessão, contexto autenticado e erros seguros. Mantido. | Autenticação, spoof/CSRF, APIs e TypeScript |
| lib/http/admin-fetch.ts | novo | Cliente HTTP envia CSRF obtido da sessão e trata perda de autenticação. Mantido. | HTTP e navegador CRM/Contrato |
| lib/http/api-response.ts | alterado | Política real de origem/sessão, contexto autenticado e erros seguros. Mantido. | Autenticação, spoof/CSRF, APIs e TypeScript |
| lib/pagamentos/services/pagamento.service.ts | alterado | Obrigação original assinada/íntegra e recusa de duplicação por nova versão. Mantido. | 30 unitários, 24 engenharia, 35 HTTP, concorrência e V1/V2 |
| scripts/admin-contrato.integration.cjs | novo | Runner/helper de teste ou conferência; manter para reprodução. Mantido. | Bateria correspondente descrita nas seções 15–16 |
| scripts/admin-navegador.integration.cjs | novo | Runner/helper de teste ou conferência; manter para reprodução. Mantido. | Bateria correspondente descrita nas seções 15–16 |
| scripts/admin-provision.cjs | novo | Bootstrap/provisionamento local oculto e revogação. Mantido. | Bootstrap concorrente, papel e desativação |
| scripts/admin-test-support.cjs | novo | Runner/helper de teste ou conferência; manter para reprodução. Mantido. | Bateria correspondente descrita nas seções 15–16 |
| scripts/condicao-pagamento.integration.cjs | alterado | Runner/helper de teste ou conferência; manter para reprodução. Mantido. | Bateria correspondente descrita nas seções 15–16 |
| scripts/migration-013.apply.cjs | novo | Evidência reprodutível de aplicação/validação estrutural; não reexecutar no banco atual. Mantido. | Evidências do checkpoint pré-013 |
| scripts/migration-013.integrity.cjs | novo | Evidência reprodutível de aplicação/validação estrutural; não reexecutar no banco atual. Mantido. | Evidências do checkpoint pré-013 |
| scripts/migration-013.validation.cjs | novo | Evidência reprodutível de aplicação/validação estrutural; não reexecutar no banco atual. Mantido. | Evidências do checkpoint pré-013 |
| scripts/pagamentos-engenharia.integration.cjs | alterado | Runner/helper de teste ou conferência; manter para reprodução. Mantido. | Bateria correspondente descrita nas seções 15–16 |
| scripts/pagamentos-http.integration.cjs | alterado | Runner/helper de teste ou conferência; manter para reprodução. Mantido. | Bateria correspondente descrita nas seções 15–16 |
| scripts/validacao-funcional-013.cjs | novo | Runner/helper de teste ou conferência; manter para reprodução. Mantido. | Bateria correspondente descrita nas seções 15–16 |
| scripts/verificacao-final-013.cjs | novo | Runner/helper de teste ou conferência; manter para reprodução. Mantido. | Bateria correspondente descrita nas seções 15–16 |

O presente relatório é um artefato adicional à lista. Checkpoints e arquivos temporários de validação não são storage funcional nem precisam ser publicados.
