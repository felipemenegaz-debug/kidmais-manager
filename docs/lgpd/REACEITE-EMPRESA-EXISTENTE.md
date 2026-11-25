# Reaceite da empresa existente por documento eletrônico

**Estado (03/11/2026): procedimento e modelos LOCAIS, ainda não executáveis.** Versão de 21/10/2026 atualizada. O CNPJ da nova fornecedora já existe: **Demerzel Labs Ltda.**, CNPJ 69.938.612/0001-26. Falta publicar em produção os textos finais. Nada foi gravado em banco nem enviado.

Fonte de verdade: `lib/cadastro/documentos-legais.ts`. Os Termos dizem: "Enquanto o sistema não oferecer o novo aceite na própria tela, ele é formalizado por documento eletrônico enviado ao responsável cadastrado, que identifica as versões e as impressões digitais aceitas." Este procedimento executa essa regra.

Índice: [INDICE.md](INDICE.md).

## 1. Versões vigentes

| Documento | Versão | Endereço |
|---|---|---|
| Termos de uso do iA.Fest | `2026-11-25-termos` | `/termos` |
| Aviso de privacidade do iA.Fest | `2026-11-17-privacidade` | `/privacidade` |
| Acordo de Tratamento de Dados do iA.Fest (DPA) | `2026-11-17-dpa` | `/acordo-de-tratamento` |

As impressões digitais (SHA-256 do texto canônico) estão em `lib/cadastro/textos-legais/manifesto.json`. **Não copiar os hashes para este documento**: eles ainda podem mudar até a publicação. No dia do reaceite, ler os valores do manifesto **no commit que estiver em produção** (seção 4).

## 2. O que é e o que não é

- **É:** um novo aceite, pela empresa que já usa o sistema em produção, dos **Termos de uso** e do **Acordo de Tratamento de Dados** vigentes, assinado por quem tem poderes para representá-la. Junto vai a **comunicação destacada do Aviso de privacidade**, com registro de ciência.
- O DPA é incorporado aos Termos por referência (versão e SHA-256 completo do DPA estão no texto dos Termos). O documento de reaceite cita os dois mesmo assim, para ficar autoexplicativo.
- **Não é:**
  - regravar o aceite antigo (Termos: "o aceite anterior não é regravado");
  - inserir linha manual em `aceites_documentos_legais`. A tabela é só de inserção, só aceita `TERMOS_USO`/`PRIVACIDADE` e origem `CADASTRO`/`NOVA_EMPRESA` (migration 069);
  - consentimento geral: a ciência do Aviso não autoriza todos os tratamentos;
  - substituto dos consentimentos específicos. A autorização de IA e fotografia dos convites continua separada (migration 088);
  - condição de uso: **não bloquear a exportação, a consulta nem o uso** para forçar o aceite, nem aplicar regras novas retroativamente (Termos: "a falta do novo aceite não bloqueia a exportação dos dados").

## 3. Partes e quem assina

| Parte | Quem | Prova de poderes |
|---|---|---|
| **Empresa cliente** (cada empresa com aceite anterior às versões vigentes da seção 1; em 21/10 era só o buffet **Kidmais Festas**) | Representante legal da pessoa jurídica cadastrada. Para o buffet Kidmais Festas, a razão social usada até aqui era Mary Marra Menegaz – EPP, CNPJ 20.119.900/0001-60. **Conferir na ficha da empresa** no painel do desenvolvedor qual CNPJ está cadastrado | Titular da EPP (requerimento de empresário) ou administrador no contrato social; se for outra pessoa, procuração com poderes para contratar |
| **Contratante pessoa física** (cadastro por CPF, possível desde 17/11) | A própria pessoa cadastrada, assinando em nome próprio, identificada por nome e CPF. Conferir na ficha da empresa que o cadastro é por CPF | Nenhuma além da identificação na assinatura eletrônica (gov.br ou ICP-Brasil) |
| **Fornecedora e operadora** | Representante legal da **Demerzel Labs Ltda.**, CNPJ 69.938.612/0001-26, SCRN 704/705, Bloco D, Loja 12, Asa Norte, Brasília/DF, CEP 70730-640 | Ato constitutivo da Demerzel Labs |

Pessoas ligadas à Demerzel Labs atuam no buffet Kidmais Festas (DPA, "Uso próprio e confidencialidade"). Se a mesma pessoa ou a mesma família representar os dois lados, registrar isso no documento (cláusula 6 do modelo). O reaceite continua necessário: fornecedora e buffet são pessoas jurídicas distintas.

Na plataforma, quem tem papel de Gestão (`REPRESENTANTE_AUTORIZADO`) **não** é automaticamente o representante legal. O documento precisa da pessoa com poderes.

## 4. Pré-condições (todas)

- [x] CNPJ da Demerzel Labs emitido; razão social, número e endereço nos textos.
- [ ] Textos com `minuta: false` e sem marcadores `[…]` pendentes (`marcadoresPendentes` vazio), aprovados por Felipe. Não há parecer jurídico como condição; a decisão é de Felipe, com risco assumido.
- [ ] Textos mesclados e **no ar em produção**. O commit no ar foi conferido por leitura.
- [ ] Versões e SHA-256 lidos do `manifesto.json` desse commit e conferidos com o comando abaixo. A "impressão digital" exibida em `/termos`, `/privacidade` e `/acordo-de-tratamento` deve coincidir.
- [ ] Representante legal identificado e documento de poderes em mãos.
- [ ] Método de assinatura escolhido (seção 5, passo 4).

Como conferir os hashes, no clone, no commit em produção (Git Bash):

```bash
git checkout --detach <commit-no-ar-em-producao>
node --experimental-strip-types --no-warnings -e "import('./lib/cadastro/documentos-legais.ts').then(m=>{for(const d of Object.keys(m.DOCUMENTOS))console.log(JSON.stringify(m.versaoVigente(d)))})"
```

Saída: uma linha por documento (`TERMOS_USO`, `PRIVACIDADE`, `DPA`) com `versao` e `hash` de 64 caracteres. Os valores devem ser iguais aos do `manifesto.json` (entradas com as versões da seção 1). Se divergirem, parar. O hash é o mesmo que o cadastro grava em `aceites_documentos_legais.hash_conteudo` (`lib/cadastro/publico.ts`).

## 5. Passo a passo (Felipe)

1. **Preencher** o modelo da seção 8 com versões e hashes completos, links públicos, data e dados das partes.
2. **Gerar o PDF** e calcular o SHA-256 dele (PowerShell: `Get-FileHash .\reaceite.pdf -Algorithm SHA256`). Anotar.
3. **Comunicar com destaque e com antecedência** (modelo da seção 9; Termos, "Alterações destes Termos"). Destinatários:
   - o representante legal;
   - o responsável cadastrado;
   - **todos os usuários ativos** da empresa, porque também são titulares dos dados da própria conta.

   Enviar de **contato@demerzellabs.com.br**, com o PDF anexado e os links. O assunto deve deixar claro que há documentos novos.
4. **Assinar eletronicamente:** representante da empresa e representante da Demerzel Labs. Opções:
   - assinatura eletrônica avançada **gov.br**, gratuita, para PDF;
   - certificado **ICP-Brasil**.

   Validar a assinatura no validador oficial do ITI e salvar o relatório. A escolha do método é decisão de Felipe.
5. **Registrar a ciência do Aviso:**
   - para o representante, o documento assinado traz a declaração de ciência;
   - para os demais usuários, guardar a resposta "Li e estou ciente" (ou a confirmação de leitura) com data e hora. Ciência não é consentimento (Aviso, "Atualizações deste aviso").

   **A falta de resposta não bloqueia o acesso.** Registrar o envio e reenviar uma vez depois de 7 dias.
6. **Guardar** em pasta privada fora do Git e do vault (ex.: `D:/Felipe/registros-lgpd-iafest/reaceite/`):
   - o PDF assinado e o relatório de validação;
   - os e-mails de envio e de ciência, exportados em `.eml`.
7. **Registrar no vault** (sem dados pessoais além do cargo): seção 6.
8. **Se a empresa não assinar:**
   - o uso continua nas condições aceitas antes;
   - não bloquear exportação nem consulta;
   - registrar a recusa ou o silêncio; Felipe decide o próximo passo.

## 6. Registro (modelo para o vault)

Nota do vault com o resumo do reaceite (uma linha por empresa), sem dados pessoais:

| Campo | Valor |
|---|---|
| Identificador | `REACEITE-AAAAMMDD-NN` |
| Empresa | id da empresa em produção |
| Termos | `2026-11-25-termos` · SHA-256 do manifesto |
| DPA | `2026-11-17-dpa` · SHA-256 do manifesto |
| Aviso (ciência) | `2026-11-17-privacidade` · SHA-256 do manifesto |
| Commit em produção | sha · deploy |
| PDF assinado | SHA-256 · local da guarda |
| Assinaturas | empresa: cargo, data, método · Demerzel Labs: cargo, data, método |
| Comunicação | enviada em · n.º de usuários · ciências recebidas em |
| Observações | conflito de interesses registrado? recusa? |

## 7. Depois: fluxo no produto (antes da próxima versão relevante)

Fora desta entrega:
- migration que amplia os CHECKs da 069 (`origem` com `REACEITE`; `documento` com `DPA`, se houver linha própria);
- aviso "Novos termos" no login da Gestão, gravando via `registrarAceites` (`lib/cadastro/publico.ts`), sem bloquear exportação nem consulta;
- registro de ciência do Aviso por usuário.

## 8. Modelo do documento de reaceite

> **TERMO DE ACEITE DOS TERMOS DE USO E DO ACORDO DE TRATAMENTO DE DADOS DO iA.Fest E DE CIÊNCIA DO AVISO DE PRIVACIDADE**
>
> **Fornecedora e operadora:** Demerzel Labs Ltda., CNPJ 69.938.612/0001-26, com sede no SCRN 704/705, Bloco D, Loja 12, Asa Norte, Brasília/DF, CEP 70730-640, neste ato representada por [NOME], [CARGO] ("Demerzel Labs").
>
> **Empresa cliente:** [RAZÃO SOCIAL], CNPJ [CNPJ], com sede em [ENDEREÇO], neste ato representada por [NOME], [CARGO / titular / procurador conforme (documento)] ("Empresa"), usuária do iA.Fest desde [data], identificada no sistema como "[nome da empresa no sistema]".
>
> *Se o Contratante for pessoa física (cadastro por CPF), usar no lugar do parágrafo acima:* **Contratante:** [NOME], CPF [CPF], com endereço em [ENDEREÇO], assinando em nome próprio ("Empresa", para os fins deste termo), usuário do iA.Fest desde [data], identificado no sistema como "[nome da empresa no sistema]".
>
> **1. Documentos aceitos.** A Empresa declara ter lido e aceita, a partir da data da última assinatura, as versões abaixo, publicadas em [URL de produção] e identificadas pelo SHA-256 do texto canônico:
>
> | Documento | Versão | SHA-256 | Endereço |
> |---|---|---|---|
> | Termos de uso | 2026-11-25-termos | [64 caracteres, do manifesto] | [URL]/termos |
> | Acordo de Tratamento de Dados (integra os Termos) | 2026-11-17-dpa | [64 caracteres, do manifesto] | [URL]/acordo-de-tratamento |
>
> **2. Substituição.** Estes documentos substituem, para o futuro, os aceitos anteriormente. O aceite anterior permanece registrado como foi feito e não é alterado. As novas condições não se aplicam retroativamente a período já pago nem a tratamentos já concluídos.
>
> **3. Papéis.** Para os dados pessoais que a Empresa insere ou recebe no iA.Fest, a Empresa é controladora e a Demerzel Labs é operadora, nos termos do Acordo de Tratamento de Dados. Para dados de conta, assinatura, cobrança, suporte e segurança da plataforma, a Demerzel Labs é controladora.
>
> **4. Ciência do Aviso de privacidade.** O representante declara ter recebido e lido o Aviso de privacidade versão 2026-11-17-privacidade, SHA-256 [64 caracteres, do manifesto], em [URL]/privacidade. A ciência não constitui consentimento para tratamentos específicos. Consentimentos específicos, como a autorização do responsável para convites com inteligência artificial e fotografia, são obtidos separadamente.
>
> **5. Exportação e acesso.** Este aceite não condiciona o acesso aos dados nem a exportação, que permanecem disponíveis nos termos dos documentos.
>
> **6. Conflito de interesses (quando aplicável).** As partes registram que [descrever a relação entre os representantes ou sócios]. A Demerzel Labs não utiliza dados da Empresa para prospecção própria, comparação comercial que identifique a Empresa ou seus clientes, ou acesso por pessoal sem necessidade de suporte. Os acessos de suporte são anotados em registro próprio (data, empresa, motivo e pessoa), disponível à Empresa a pedido.
>
> **7. Forma.** As partes reconhecem a validade da assinatura eletrônica deste documento ([gov.br / ICP-Brasil]).
>
> [Local], [data].
>
> ________________________ Empresa — [nome, cargo]
>
> ________________________ Demerzel Labs — [nome, cargo]

## 9. Modelo da comunicação destacada

> **Assunto:** IMPORTANTE: novos Termos de uso, Acordo de Tratamento de Dados e Aviso de privacidade do iA.Fest
>
> Olá, [nome].
>
> A partir de [data], o iA.Fest passa a ser prestado pela Demerzel Labs Ltda., CNPJ 69.938.612/0001-26, e os documentos abaixo foram atualizados:
>
> - **Termos de uso**, versão 2026-11-25-termos — [link]
> - **Acordo de Tratamento de Dados**, versão 2026-11-17-dpa — [link]
> - **Aviso de privacidade**, versão 2026-11-17-privacidade — [link]
>
> **O que muda, em resumo:** [3 a 5 pontos, ex.: nova responsável; devolução no arrependimento e no encerramento antecipado do anual; guarda por até 12 meses após a suspensão, com aviso 30 dias antes da exclusão; relação de prestadores e transferências; aviso de incidente à empresa em até 24 horas].
>
> **O que você precisa fazer:**
> - **Representante legal:** assinar o termo de aceite anexo.
> - **Demais usuários:** responder a este e-mail com "Li e estou ciente do Aviso de privacidade versão 2026-11-17-privacidade".
>
> Seu acesso, seus dados e a exportação continuam disponíveis normalmente, com ou sem resposta.
>
> Dúvidas e pedidos sobre seus dados: contato@demerzellabs.com.br (encarregado: Felipe Menegaz).

### 9.1 Variante para quem já aceitou as versões 2026-11-17 (só os Termos mudam)

Usar com as empresas cujo aceite mais recente é dos Termos `2026-11-17-termos`: a fornecedora já era a Demerzel Labs e o DPA e o Aviso continuam nas mesmas versões. Ajustes em relação ao fluxo completo:

- **Termo de aceite (seção 8):**
  - título: "TERMO DE ACEITE DOS TERMOS DE USO DO iA.Fest" (sem "e do Acordo de Tratamento de Dados" e sem "de ciência do Aviso de privacidade");
  - cláusulas 1 e 2: **substituir** pelo texto abaixo. O aceite e a substituição tratam só dos Termos; o DPA aparece em frase separada, como documento que continua valendo, e não entra na lista aceita nem na substituição;
  - cláusula 4 (ciência do Aviso): **omitir** e renumerar as seguintes; o Aviso não muda;
  - as demais cláusulas e as assinaturas ficam como estão.

  > **1. Documento aceito e início.** A Empresa declara ter lido e aceita os Termos de uso abaixo, publicados em [URL de produção] e identificados pelo SHA-256 do texto canônico:
  >
  > | Documento | Versão | SHA-256 | Endereço |
  > |---|---|---|---|
  > | Termos de uso | 2026-11-25-termos | [64 caracteres, do manifesto] | [URL]/termos |
  >
  > Para a Empresa, estes Termos passam a valer na **mais tardia** entre a data de início comunicada, **[data de início comunicada]**, e a data da última assinatura deste termo. Até lá, valem os Termos de uso 2026-11-17-termos.
  >
  > O Acordo de Tratamento de Dados versão 2026-11-17-dpa, aceito pela Empresa em [data do aceite anterior], continua em vigor sem alteração e integra os Termos acima. Este termo não o aceita de novo nem o substitui.
  >
  > **2. Substituição.** Os Termos de uso 2026-11-25-termos substituem, a partir do início definido na cláusula 1 e para o futuro, apenas os Termos de uso 2026-11-17-termos. O aceite anterior permanece registrado como foi feito e não é alterado. As novas condições não se aplicam retroativamente a período já pago.

- **Passo 3 (destinatários):** o representante legal (ou, no cadastro por CPF, o próprio contratante) e o responsável cadastrado. Os usuários ativos não precisam receber, porque o Aviso não muda.
- **Passo 5 (ciência do Aviso):** **omitir**; não há nova ciência a registrar.
- **Passo 6 (guarda):** guardar o PDF assinado, o relatório de validação e o e-mail de envio da comunicação (`.eml`). Não há e-mails de ciência a guardar.
- **Passo 7 e seção 6 (registro):** na linha da empresa, "DPA" com `2026-11-17-dpa` e a anotação "mantido, aceito em [data]"; "Aviso (ciência)" com "não aplicável: Aviso 2026-11-17-privacidade mantido"; "Comunicação" com a data de envio, a data de início comunicada e "ciências: não aplicável"; em "Observações", a data em que os Termos 2026-11-25 passaram a valer para a empresa (a mais tardia entre a data comunicada e a última assinatura).
- **Vigência para cada contratante:** as novas condições de cobrança valem para ele na mais tardia entre a data de início comunicada e a última assinatura do termo de aceite, e essa data fica escrita no próprio termo (cláusula 1). Sem assinatura, vale o passo 8: o uso continua nas condições aceitas antes (Termos `2026-11-17-termos`).

> **Assunto:** IMPORTANTE: mudança nos Termos de uso do iA.Fest sobre as tarifas do WhatsApp
>
> Olá, [nome].
>
> Publicamos os **Termos de uso versão 2026-11-25-termos** — [link]. Para a sua empresa, eles passam a valer **somente depois que o termo de aceite anexo for assinado**, e nunca antes de [data de início, com antecedência de pelo menos (prazo) desta comunicação]. Até lá, continuam valendo os Termos 2026-11-17 que você já aceitou. O **Acordo de Tratamento de Dados** (2026-11-17-dpa) e o **Aviso de privacidade** (2026-11-17-privacidade) **continuam os mesmos** e não precisam de nova assinatura ou ciência.
>
> **O que muda:** só a cobrança das mensagens do atendimento pelo WhatsApp, quando ele usa o número da sua empresa conectado à conta do WhatsApp Business dela.
> - **Quem paga:** eventuais tarifas da Meta passam a ser cobradas pela Meta diretamente na conta do WhatsApp Business da sua empresa, pelo meio de pagamento cadastrado lá. Nos Termos 2026-11-17, essas tarifas estavam incluídas no plano, dentro do uso justo. A Demerzel Labs não paga nem repassa essas tarifas.
> - **Teto:** para manter o atendimento dentro da faixa sem tarifa da Meta, as respostas automáticas param ao atingir o limite mensal, de no máximo 1.000 mensagens, com aviso no painel a partir de 80% (800 no limite de 1.000). Depois disso só a equipe responde; as mensagens dela continuam contando e, acima da faixa sem tarifa, podem ser cobradas pela Meta na conta da sua empresa.
> - **Se a contagem não puder ser feita:** as respostas automáticas também param e só a equipe responde. Enquanto isso, as mensagens da equipe não entram na contagem nem geram aviso no painel, e podem ser cobradas pela Meta na conta da sua empresa conforme as regras dela.
> - **Contagem:** é uma estimativa do sistema, por empresa e por mês de São Paulo, das mensagens que ele registra para envio (equipe e automáticas, mesmo que depois falhem ou sejam canceladas). Quando a contagem começa no meio de um mês, ela parte das mensagens desse mês já registradas que não falharam nem foram canceladas. Mensagens enviadas pelo número fora do iA.Fest não entram.
> - A faixa sem tarifa e os valores são definidos pela Meta e podem mudar. Os códigos de verificação enviados pela Demerzel Labs não são cobrados.
>
> **O que você precisa fazer:** o representante legal (ou, no cadastro por CPF, o próprio contratante) assina o termo de aceite anexo. Sem a assinatura, o uso continua nas condições dos Termos 2026-11-17.
>
> Seu acesso, seus dados e a exportação continuam disponíveis normalmente, com ou sem resposta.
>
> Dúvidas: contato@demerzellabs.com.br.
