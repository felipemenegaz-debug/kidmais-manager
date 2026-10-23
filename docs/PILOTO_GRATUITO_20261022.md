# Piloto gratuito com buffets reais em produção (22/10/2026)

Roteiro operacional para o Felipe criar de 3 a 5 buffets pelo painel do desenvolvedor, acompanhá-los e depois encerrar o
piloto ou convertê-lo em assinatura. Durante o piloto não há cobrança nem Asaas. Este documento **não autoriza** deploy,
alteração de env nem SQL em produção. Cada uma dessas ações continua exigindo autorização própria
([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)).

- Base lida: `staging` `326895e`. Produção está em `aeca2c2`. Os arquivos deste fluxo são idênticos nas duas branches:
  provisionamento, convite, acesso comercial, ofertas, cadastro e painel comercial. As diferenças entre elas
  (089 devolução, exportação completa) não mudam o piloto. A diferença na exportação está descrita no §4.
- Termo jurídico do piloto: rascunho em `pacote-revisao-juridica-astra-20261020/piloto/` (fora do repositório). No vault,
  está na nota "Piloto gratuito termo e pergunta Astra 20261022". **O piloto não começa antes do parecer da Astra e do
  termo assinado.**

## 1. O que o sistema faz hoje (sem código novo)

| Pergunta | Resposta | Evidência |
|---|---|---|
| O que o "Provisionar contratante" cria | Na mesma transação: empresa já `ATIVA`, cadastro administrativo (implantação "Aguardando primeiro acesso"), interessada marcada `CONVERTIDA` (se houver) e um **convite de Gestão** (7 dias). Nenhum usuário, unidade ou Perfil é criado. O e-mail sai depois do commit, e o resultado real aparece na tela | `lib/desenvolvedor/empresas.ts:281-329`, `:267-274` |
| Dados pedidos | Nome*, código (opcional), nome empresarial, CPF ou CNPJ, responsável*, e-mail*, telefone e observações | `components/desenvolvedor/Provisionar.tsx:73-80`, `lib/desenvolvedor/empresas.ts:200-228` |
| Segurança | Concessão de desenvolvedor, prévia sem escrita, confirmação explícita e senha confirmada há no máximo 5 minutos | `app/api/desenvolvedor/empresas/route.ts:19-24`, `lib/desenvolvedor/empresas.ts:282-285` |
| Aceite de Termos e Privacidade | **Não existe** no provisionamento nem no aceite do convite. `aceites_documentos_legais` só é gravado pelo cadastro público | `lib/acessos/convites.ts:209-292` (sem aceite), `lib/cadastro/publico.ts:88-94` |
| Flags desligadas | Funciona com `CADASTRO_PUBLICO_ATIVO` e `ASSINATURA_PLANOS_ATIVOS` desligados, porque nenhum dos dois é lido nesse caminho. Basta o e-mail estar configurado; se não estiver, a prévia avisa e o convite pode ser reenviado | `lib/cadastro/publico.ts:58` (só no cadastro), `lib/desenvolvedor/empresas.ts:273` |
| Acesso da empresa | **Completo, sem prazo e "Sem cobrança"**, como a Kidmais. A empresa provisionada não tem linha em `empresa_assinaturas` | `lib/assinatura/acesso.ts:64-66`, `lib/assinatura/estado.ts:54-59`, `components/admin/Assinatura.tsx:53-56` |
| Plano e recursos | Nenhum limite. Sem contrato confirmado, `planoConfirmado` é `null`, então Financeiro completo, Orçamento online e Marketing ficam liberados e não há limite de pessoas | `lib/assinatura/limites-usuarios.ts:10-19,22-24`, `lib/assinatura/recursos-plano.ts:37-47` |
| Convites com IA | Dependem da franquia em `convite_carteiras`. Sem linha, o limite mensal é 0 e a empresa não gera nada. Não há tela para criar a franquia: é SQL em produção, com autorização. Também é preciso que o responsável autorize na tela (088) | `lib/convites/service.ts:123-127`, `database/migrations/20261008_073_convites.sql:6-10` |
| WhatsApp | Não há trava por plano. Depende da conexão Meta de cada empresa (083) e das flags globais do atendimento (Wall-e) | `lib/desenvolvedor/empresas.ts:159-168` |
| Isenção, cortesia ou acesso temporário com prazo | Não serve ao piloto. A isenção (074a) é **permanente** e impede contratar e usar o Fundador. A cortesia e o acesso temporário (067) exigem empresa **com** assinatura ("Empresa sem cobrança: o acesso já é completo") | `database/migrations/20261009_074a_planos_comerciais.sql:34-40,137-148`, `lib/assinatura/servico.ts:78-92` |
| Conversão pela tela | **Bloqueada sem código novo.** Sem linha de assinatura, `consultarOfertas` devolve `habilitado=false` e `prepararOferta` recusa com `EMPRESA_SEM_COBRANCA`. A vaga Fundador exige `documento_teste` (CNPJ), gravado só por `iniciarTeste`, que só o cadastro público chamava | `lib/assinatura/ofertas.ts:89-99,127-129,145-151`, `lib/cadastro/publico.ts:310` |
| Cron D-C4 | Ignora essas empresas. A reconciliação só lê empresas com `provedor_assinatura_id`, e o alarme de gratuidade olha só o código `kidmais` | `lib/assinatura/sincronizacao.ts:314`, `scripts/assinatura-reconciliar.cjs:378-401` |
| Exportação | Produção (`aeca2c2`): CSV de clientes e contas a receber pela Gestão, sempre permitido pelo paywall. Staging tem o pacote completo (ZIP), que ainda não está em produção. Nenhum dos dois depende de assinatura | `lib/assinatura/exportacao.ts:14,23`, `lib/exportacao/servico.ts` |

## 2. O que mudou (commit local, sem push): "Iniciar teste grátis" no painel

Painel do desenvolvedor → ficha da empresa → **Situação comercial** → **Iniciar teste grátis…**. A operação aparece só
em empresa sem cobrança.

- Cria a assinatura em `TESTE`, com plano `UNICO` e sem provedor. Usa o CNPJ do **cadastro administrativo**. O prazo vai
  de 1 a 90 dias, contado no relógio do banco. É a mesma função `iniciarTeste` do cadastro público
  (`lib/desenvolvedor/comercial.ts`).
- Recusa a operação quando:
  - a empresa não está `ATIVA`;
  - a empresa é a `kidmais`;
  - a empresa é isenta;
  - a empresa já tem situação comercial;
  - o cadastro não tem CNPJ (CPF não serve, porque o teste e o Fundador exigem CNPJ).
- Exige motivo e senha recente. É auditada como `COMERCIAL_TESTE_INICIADO`. Não tem volta, porque a assinatura não é
  apagada.
- Efeitos:
  - acesso **completo até a data**; depois, 60 dias de somente leitura com exportação, e então bloqueio. É a régua comum de
    `lib/assinatura/acesso.ts`;
  - o prazo pode ser estendido pela operação já existente **Estender teste** (até 60 dias por vez);
  - com a venda ligada, a Gestão vê os planos e a condição Fundador e contrata pela tela.
- Sem migration: usa só 067, 068 e 074a, já aplicadas em produção.
- Para usar em produção, é preciso PR → staging → `production` + deploy, cada passo com autorização.

Validação local:
- `tsc`, ESLint e `check:v1:static`: PASS.
- Unitários relacionados: 48/48.
- PostgreSQL descartável na porta 55583, já removido:
  - `comercial` 8/8, com `painel-063` e `cadastro-069` também verdes;
  - controle negativo sem o código novo: 3 falhas esperadas.

## 3. Passo a passo

### 3.1 Antes do primeiro buffet

1. Parecer da Astra e termo do piloto assinado por buffet (vault).
2. Confirmar que a conta do Felipe tem concessão de desenvolvedor em produção. A concessão é dada só pelo CLI
   `scripts/admin-provision.cjs`.
3. Decidir sobre os Convites com IA. Se o buffet for usar IA, é preciso criar a franquia em `convite_carteiras`
   (`ativo=true`, `limite_mensal=N`), por SQL em produção com autorização. Sem a franquia, os convites funcionam sem
   gerar imagem.
4. Exigir o **CNPJ** do buffet. Sem CNPJ não há conversão pela tela nem Fundador.

### 3.2 Criar cada empresa (cerca de 3 minutos cada)

1. Entrar em `/desenvolvedor/empresas/provisionar`.
2. Preencher os dados:
   - Nome da empresa;
   - Nome empresarial;
   - **CNPJ**;
   - Responsável (quem vai administrar);
   - E-mail do responsável;
   - Telefone;
   - Observações: "Piloto gratuito — termo `<versão>` assinado em `<data>`".
3. **Revisar efeitos.** Conferir a linha "O e-mail do convite é enviado logo após a confirmação" e a ausência de conflitos.
4. **Confirmar provisionamento** e digitar a senha.
5. Na tela de resultado, conferir se o convite foi enviado. Se não foi, abrir a ficha e usar **Reenviar** depois de
   corrigir o envio.
6. (Opcional) Para dar ao piloto uma data de fim automática (ex.: até 31/12/2026), é preciso o código do §2 em produção:
   - abrir a ficha → Situação comercial → **Iniciar teste grátis**;
   - em **dias**, informar o número de dias até a data (de 22/10 a 31/12 são 70);
   - em **motivo**, escrever "Piloto gratuito até 31/12/2026".
   Sem isso, a empresa fica "Sem cobrança", com acesso completo e sem prazo.

### 3.3 O que o buffet recebe

- Um e-mail com o convite, válido por 7 dias. Pelo link (`/acesso/convite`), ele define nome e senha. Se o e-mail já tiver
  conta, confirma com a senha atual.
- Acesso de **Gestão** com tudo liberado: CRM, festas, contratos, financeiro completo, orçamento online, Marketing, sem
  limite de pessoas.
- Na tela "Assinatura", aparece "Sem cobrança". Se o teste do §3.2 passo 6 tiver sido iniciado, aparece "Teste grátis até
  `<data>`".
- Para concluir a implantação, a Gestão:
  - cria o Perfil da empresa em Configurações → Perfil (com CNPJ e endereço) e aplica o cadastro;
  - depois cadastra pacotes, unidade/agenda e convida a equipe.

### 3.4 Acompanhar

- `/desenvolvedor/empresas`, com filtro "Em implantação":
  - situação, comercial ("Sem cobrança" ou "Teste grátis · Completo");
  - membros ativos e convites pendentes.
- Ficha da empresa:
  - pendências reais de implantação (Gestão ativa, Perfil criado/aplicado);
  - membros, convites, atividade auditada e Situação comercial.
- Quando as pendências obrigatórias estiverem atendidas, usar **Concluir implantação**.

### 3.5 Encerrar sem conversão

- **Com o código do §2 em produção e o CNPJ no cadastro** (recomendado, porque segue a regra L2 do termo):
  - iniciar um teste curto (1 dia) ou deixar o teste vencer;
  - a empresa passa a somente leitura por 60 dias, com exportação, e depois é bloqueada;
  - nada é apagado. A exclusão segue o procedimento manual do termo.
- **Sem o código:** **Suspender** na ficha.
  - O acesso cai na hora e os dados ficam preservados. **Reativar** devolve o acesso.
  - Em produção, uma empresa suspensa não exporta. A exportação de empresa suspensa só existe em staging. Por isso, peça
    ao buffet que exporte os CSVs e os PDFs **antes** de suspender.

### 3.6 Converter em assinatura (quando o CNPJ novo e o Asaas de produção saírem)

Pré-requisitos, cada um com autorização própria:

1. Código do §2 publicado em produção (PR → staging → `production` + deploy manual).
2. Textos finais publicados. **Lacuna:** não existe tela para uma conta já existente aceitar novas versões de Termos e
   Privacidade. Hoje o aceite só é gravado no cadastro público, e o checkout não pede aceite. A Astra precisa decidir:
   - aceite fora do sistema (documento eletrônico, como no procedimento de reaceite);
   - ou código novo de aceite na contratação, antes da conversão.
3. Envs de produção, **ligados juntos**:
   - `ASSINATURA_PLANOS_ATIVOS=true`;
   - Asaas de produção: `ASAAS_AMBIENTE=producao`, chave e token do webhook.
   Com o Asaas ligado e os planos desligados, uma empresa em teste vê o checkout legado ("Assinar mensal"), caso
   `ASSINATURA_PRECO_*` esteja definido (`components/admin/AssinaturaAcoes.tsx:138-150`).

Para cada buffet:

1. Abrir a ficha → Situação comercial → **Iniciar teste grátis**, com 15 a 30 dias. Esse é o prazo para contratar sem
   perder escrita. Motivo: "Conversão piloto → assinatura". Se o teste já tiver sido iniciado no §3.2, use
   **Estender teste** se for preciso.
2. O buffet (Gestão) vai em **Assinatura** e:
   - escolhe o plano e o ciclo;
   - vê o desconto **Fundador** (40% por 12 meses) enquanto houver vaga;
   - paga na página do Asaas.
   O acesso vira "Assinatura ativa" com o plano escolhido.
3. Avisar o buffet antes da escolha:
   - **Essencial** limita a 3 pessoas e não inclui Financeiro completo, Orçamento online nem Marketing. Os dados ficam
     guardados.
   - Profissional permite 10 pessoas. Premium não tem limite.

## 4. Riscos e o mínimo a fazer

1. **Fundador não é "garantido" no código.**
   - São 20 vagas globais, ocupadas por ordem de contratação, e a reserva acontece só no checkout.
   - O termo promete "sem limite de vaga por 30 dias". Ou o termo se ajusta, ou os pilotos são convertidos antes de abrir
     a venda ao público.
   - Não há reserva antecipada no sistema.
2. **Sem aceite registrado durante o piloto.** A base é o termo assinado fora do sistema. Guarde o termo e a versão nas
   observações da ficha.
3. **CPF em vez de CNPJ:**
   - o buffet não converte pela tela;
   - não recebe o Fundador;
   - não entra no encerramento em somente leitura.
4. **Convites com IA:** sem franquia não há geração. A franquia é escrita em banco de produção e exige autorização.
5. **Suspensão em produção bloqueia a exportação.** Exporte antes de suspender.
6. **"Iniciar teste" não tem volta.** O teste vence sozinho. Se a venda atrasar, estenda antes da data (a extensão é
   auditada).
