# Resposta a incidentes de segurança com dados pessoais

**Estado (03/11/2026): procedimento LOCAL, documental, não publicado.** Versão de 21/10/2026 atualizada para a fornecedora **Demerzel Labs Ltda.** ("Demerzel Labs"), produto **iA.Fest**, e para os textos `2026-11-15-dpa` e `2026-11-15-privacidade`. É o "procedimento documentado de resposta a incidentes e registro das ocorrências" que o DPA promete, disponível à empresa cliente a pedido. Nenhum painel, log ou banco foi consultado para escrever este documento.

Fonte de verdade: `lib/cadastro/documentos-legais.ts` (DPA, "Incidentes de segurança"). Se este procedimento divergir dos textos, valem os textos. As referências à Resolução CD/ANPD nº 15/2024 são indicações técnicas; a decisão de comunicar ou não é registrada por Felipe, sem depender de parecer jurídico.

Índice: [INDICE.md](INDICE.md).

## 1. O que é incidente

Qualquer evento, confirmado ou suspeito, que afete a **confidencialidade, integridade, disponibilidade ou autenticidade** de dados pessoais tratados no iA.Fest. Exemplos:
- credencial vazada;
- acesso indevido a uma conta ou a outra empresa;
- acesso de pessoal do buffet Kidmais Festas a dados de outra empresa cliente;
- link de arquivo ou convite exposto;
- dado enviado ao destinatário errado, inclusive a um prestador ou provedor de IA fora do combinado;
- perda ou corrupção do banco;
- notebook perdido com cópia;
- e-mail enviado à pessoa errada;
- ataque a um prestador (Render, Asaas, Resend, OpenAI, Meta).

**Na dúvida, abrir o registro.** Abrir não obriga a comunicar; a decisão vem da avaliação (seção 3.4).

## 2. Papéis, contatos e relógio

| Papel | Quem | Contato |
|---|---|---|
| Responsável pela resposta e encarregado | Felipe Menegaz (Demerzel Labs) | contato@demerzellabs.com.br |
| Substituto | **Não há.** Lacuna registrada: se Felipe estiver indisponível, ninguém mais tem acesso administrativo a Render, Asaas, Resend, OpenAI e GitHub | — |
| Revisão independente (opcional, não é condição) | Astra | canal habitual |
| Empresa cliente afetada | Gestão e responsável cadastrados da empresa (painel do desenvolvedor → empresa → membros) | e-mail cadastrado |
| ANPD | Comunicação de incidente pelo canal oficial da ANPD (gov.br/anpd) | — |

**O relógio começa na ciência (T0):** o momento em que a Demerzel Labs soube que dados pessoais podem ter sido afetados. Anotar em UTC.

| Prazo a partir de T0 | Ação | Quem decide |
|---|---|---|
| imediato | abrir o registro, conter, preservar evidências | Demerzel Labs |
| **meta de até 24 horas** | **avisar a empresa cliente** cujos dados foram afetados, sem demora injustificada, mesmo com informação incompleta; complementar à medida que for apurado (DPA) | Demerzel Labs (obrigação contratual) |
| **em regra, 3 dias úteis** | **comunicação à ANPD e aos titulares** de incidente relevante | **A controladora.** Para dados inseridos pela empresa cliente, cabe à **empresa cliente** avaliar e comunicar (DPA). A Demerzel Labs entrega as informações para isso. A Demerzel Labs comunica só quando ela for a controladora: dados de conta, assinatura, cobrança, suporte e segurança da plataforma |
| depois | complementar as informações conforme o regulamento da ANPD | a controladora |
| sempre | manter o registro do incidente, comunicado ou não, por **no mínimo 5 anos** (Res. CD/ANPD nº 15/2024) | Demerzel Labs |

O prazo de 24 horas é contratual. **Não é** o prazo legal de comunicação à ANPD (DPA). Não contar com prazos diferenciados de agente de pequeno porte: a regra interna é 24 horas para a empresa cliente e 3 dias úteis quando a Demerzel Labs for controladora.

## 3. Passo a passo

### 3.1 Detectar

Fontes de alerta:
- aviso de usuário, de titular ou de empresa cliente;
- e-mail de prestador (Render, OpenAI, Meta, GitHub, Asaas, Resend);
- `/api/health` fora do ar;
- erro anormal nos logs do Render;
- pico de uso de IA (`ia_uso_modelo`);
- ações estranhas na auditoria;
- acesso de suporte sem anotação em `Registro de acessos de suporte LGPD`;
- segredo colado em chat, issue ou arquivo, como já ocorreu em 07/10 e 14/10.

### 3.2 Abrir o registro (primeiros 15 minutos)

Criar uma linha `INC-AAAAMMDD-NN` em `Registro de incidentes LGPD` (seção 6) com:
- T0;
- como soube;
- o que se sabe;
- ambientes afetados (produção ou staging: staging também tem dados reais da equipe e de contatos permitidos);
- empresas clientes possivelmente afetadas (pelo id).

Criar a pasta privada de evidências, fora do Git e do vault (ex.: `D:/Felipe/registros-lgpd-iafest/incidentes/INC-…/`).

### 3.3 Conter (sem destruir evidência)

Antes de mudar algo, salvar o que pode sumir: trecho de log do Render, captura do painel, lista de sessões. Os logs do Render têm retenção limitada pelo plano.

| Situação | Contenção disponível hoje | Referência |
|---|---|---|
| Senha ou sessão de usuário comprometida | Trocar a senha (encerra **todas** as sessões do usuário) ou usar a recuperação de senha | `lib/acessos/senha-propria.ts`; `lib/acessos/recuperacao.ts`; `lib/autenticacao/service.ts` |
| Membro que não deveria ter acesso | Desativar o membro pelo perfil da equipe ou pelo painel | `lib/desenvolvedor/vinculos.ts` |
| Empresa usada indevidamente | Suspender a empresa no painel do desenvolvedor, avisando o motivo logo em seguida (Termos, "Uso adequado e suspensão"). A suspensão não impede a exportação, salvo ordem legal | `lib/desenvolvedor/empresas.ts` |
| Função vazando dados | Desligar por variável de ambiente no Render (gera novo deploy). Ver a tabela abaixo | `docs/OPERACAO_AGENTES.md` (só Felipe altera env de produção) |
| Link de arquivo do WhatsApp exposto | Revogar ou trocar o link | `lib/whatsapp/atendimento/privacidade.ts` |
| Convite público exposto | Despublicar o convite; revogar o link de edição | Termos, "Links e páginas públicas" |
| Site público de Marketing com dado indevido | Despublicar o site ou desligar `MARKETING_SITES_PUBLICOS` | — |
| Segredo vazado (API, banco, sessão) | Rotacionar no prestador e no Render, nesta ordem: criar novo → trocar env → conferir → revogar o antigo | `docs/ROTACAO_CREDENCIAIS_20261007.md` |
| Dado enviado a prestador indevido | Pedir exclusão ao prestador (modelo D) e desligar a integração | — |
| Banco corrompido ou apagado | PITR (**janela de 3 dias**: agir rápido) para instância nova, com plano e autorização próprios, e reaplicar as exclusões | [BACKUPS-E-COPIAS.md](BACKUPS-E-COPIAS.md), seção 6 |
| Notebook ou disco perdido | Conferir BitLocker; encerrar sessões; rotacionar segredos que estavam no disco (`.env.local`) | — |

Variáveis para desligar funções:

| Função | Variável |
|---|---|
| Convites com IA | `CONVITES_IA_ENABLED` |
| IA administrativa | `INTELIGENCIA_ENABLED` |
| Atendimento WhatsApp | `WHATSAPP_ATENDIMENTO_ENABLED` e `WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED` |
| Cadastro público | `CADASTRO_PUBLICO_ATIVO` |
| Sites públicos de Marketing | `MARKETING_SITES_PUBLICOS` |
| E-mail | `EMAIL_PROVIDER=desativado` |

### 3.4 Avaliar o risco (até 24 horas)

Responder no registro:
1. Que dados? Quantos titulares? De quais empresas clientes?
2. Houve acesso, cópia ou alteração **confirmados**, ou só exposição possível? Por quanto tempo?
3. Quem é a controladora de cada conjunto: Demerzel Labs ou empresa cliente?
4. Os dados estavam protegidos (hash, cifra, token)?
5. A contenção já eliminou o risco?

**Risco ou dano relevante** (Res. 15/2024): o incidente pode afetar significativamente interesses e direitos fundamentais dos titulares **e** envolve pelo menos um destes:
- dados sensíveis (ex.: saúde em observações);
- dados de **crianças** (aniversariantes, convites, fotografias);
- dados financeiros;
- dados de autenticação;
- dados protegidos por sigilo;
- tratamento em larga escala.

Nos buffets, quase todo incidente toca dados de crianças. Avaliar com cuidado e registrar a justificativa da conclusão, inclusive quando ela for "não comunicar". Quando a controladora for a empresa cliente, a avaliação da Demerzel Labs é uma **recomendação**; a decisão é da empresa.

### 3.5 Comunicar

| Para quem | Quando | Quem envia | Modelo |
|---|---|---|---|
| Empresa cliente afetada | meta de até 24 h de T0; complementar depois | Demerzel Labs | A |
| ANPD | incidente relevante, em regra em 3 dias úteis | a controladora: a empresa cliente para os dados dela; a Demerzel Labs para os dados de que é controladora | B (campos) |
| Titulares | mesma condição, linguagem simples | a controladora | C |
| Prestador envolvido | assim que preciso, para informação ou exclusão | Demerzel Labs | D |

Se a empresa cliente pedir, a Demerzel Labs ajuda a montar a comunicação dela (DPA, "Direitos dos titulares e assistência"), sem enviá-la em nome da empresa sem instrução escrita.

### 3.6 Erradicar, recuperar e encerrar

- Corrigir a causa, conferir que a contenção funcionou e religar o que foi desligado.
- Se houve restauração, reaplicar as exclusões ([BACKUPS-E-COPIAS.md](BACKUPS-E-COPIAS.md), seção 6).
- Encerrar o registro com lições aprendidas e atualizar este documento se o passo a passo falhou em algo.

## 4. Onde estão os logs e as ferramentas

**Leitura de banco de produção exige autorização explícita de Felipe** (`docs/OPERACAO_AGENTES.md`). Felipe pode autorizar a si mesmo durante um incidente, registrando o que leu. Agentes só leem com autorização dada para aquele incidente. Toda leitura de dados de uma empresa cliente também é anotada em `Registro de acessos de suporte LGPD`, com o motivo "incidente INC-…".

### 4.1 Sistema (Render e banco)

| Onde | O que tem | Como acessar |
|---|---|---|
| Render: web de produção `srv-dak77m2d0e5s73b8rkkg`, web de staging `srv-daif418ae00c73e8k2gg`, cron de assinatura | Logs da aplicação (webhooks gravam resumos sanitizados), eventos, deploys, métricas, Shell | Painel do Render, workspace `tea-daidbj95efls73d2bcf0` |
| Render: PostgreSQL de produção `dpg-dak750gae00c73fudmg0-a` e de staging `dpg-daidko3m8hqs73ce4jt0-a` | Recovery (PITR de 3 dias, exportações), conexões | Painel do Render |
| Tabela `auditoria` | Ações administrativas: ator, ação, entidade, IP, navegador, data | migration 003; `lib/clientes/repositories/auditoria.repository.ts` |
| Painel do desenvolvedor → Atividade | Auditoria administrativa da plataforma por empresa e período | `app/desenvolvedor/atividade/page.tsx` |
| `sessoes_administrativas` | Login, última atividade, expiração, revogação, IP e navegador por usuário | migration 013 |
| `limites_autenticacao` | Tentativas e bloqueios de login | migration 013 |
| `financeiro_auditoria` | Alterações financeiras | migration 052 |
| `whatsapp_atendimento_auditoria`, `whatsapp_atendimento_privacidade` | Eventos do atendimento; exclusões e revogações | migrations 060 e 082 |
| `ia_uso_modelo` | Uma linha por chamada de IA (empresa, provedor, modelo, tokens), **sem prompt nem resposta** | migration 055a |
| `convite_ia_autorizacoes` | Autorizações e revogações de IA nos convites | migration 088 |
| `aceites_documentos_legais` | Aceites com versão, hash, IP | migration 069 |

### 4.2 Prestadores

Situação conforme a relação do Aviso `2026-11-15-privacidade`.

| Prestador | O que guarda de pessoal | Onde olhar e conter |
|---|---|---|
| **Render** (hospedagem, banco, disco; Virginia, EUA) | Tudo | Painel: logs, Recovery, Shell; troca de env; suporte pelo painel; página de status |
| **Asaas** (cobrança da assinatura; Brasil) | Razão social e CNPJ da empresa cliente, cobranças; dados que o pagador informa direto ao Asaas | Painel do Asaas: cobranças, logs de webhook, chaves (`ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`) |
| **Resend** (e-mails transacionais; EUA) | E-mail, nome, nome da empresa e links de acesso | Painel do Resend: histórico de envios, chaves (`RESEND_API_KEY`), webhooks (`RESEND_WEBHOOK_SECRET`), domínio de envio configurado |
| **OpenAI** (só geração de convites com IA; EUA) | Dados selecionados da festa e, com confirmação a cada geração, fotografia e imagens da galeria. A OpenAI informa que conteúdos podem ser mantidos temporariamente para monitoramento de abuso; não há promessa de retenção zero | Plataforma da OpenAI: uso por projeto, chaves (`OPENAI_API_KEY`), configurações de dados; pedidos de privacidade pelo canal oficial da OpenAI |
| **Meta/WhatsApp** | Telefones, mensagens, mídias, códigos | WhatsApp Manager (Meta Business); tokens no Render e credencial da empresa cifrada no banco |
| **ViaCEP** (Brasil) | Somente o CEP | — |
| **Google Gemini** e **DeepSeek** | Nenhum: **não habilitados** | Se algum dado tiver ido a eles, é incidente (envio fora do combinado) |
| **GitHub** | Código, sem dados de clientes | Alertas de segredo; histórico de commits; Actions |

A IA no atendimento pelo WhatsApp **não está habilitada** para nenhuma empresa (Aviso). Qualquer envio de mensagens de clientes a um provedor de IA hoje é incidente a apurar.

## 5. Modelos

Enviar sempre de contato@demerzellabs.com.br.

**A — Aviso à empresa cliente (meta de até 24 h)**
> **Assunto:** Aviso de incidente de segurança — [INC-…]
>
> Informamos que em [data e hora de T0] a Demerzel Labs tomou ciência de um incidente que [envolve / pode envolver] dados que a [empresa] mantém no iA.Fest.
>
> - **Natureza do incidente, até agora:** [descrição curta].
> - **Dados e titulares possivelmente afetados:** [categorias; quantidade estimada; se há dados de crianças ou de saúde].
> - **Período:** [início e fim conhecidos].
> - **Medidas adotadas:** [contenção].
> - **Medidas recomendadas:** [ex.: trocar senhas, avisar clientes].
>
> Este é o aviso contratual previsto no Acordo de Tratamento de Dados. Ele não é a comunicação legal à ANPD. Como controladora, cabe à [empresa] avaliar e realizar a comunicação de incidente relevante à ANPD e aos titulares, em regra em três dias úteis. Enviaremos as informações complementares assim que apuradas, inclusive as necessárias para essa comunicação. Contato: contato@demerzellabs.com.br (Felipe Menegaz, encarregado).

**B — Comunicação à ANPD (campos a reunir; envio pelo canal oficial, pela controladora)**
- identificação do controlador e do encarregado;
- data e hora da ocorrência (se conhecida) e da ciência;
- natureza do incidente e como foi descoberto;
- categorias e quantidade de titulares (indicar crianças e adolescentes);
- categorias de dados (indicar sensíveis);
- medidas técnicas e de segurança que protegiam os dados;
- riscos e consequências prováveis;
- medidas adotadas e previstas para reverter ou mitigar;
- se os titulares foram comunicados, quando e como;
- motivo de eventual demora;
- informações a complementar e previsão.

**C — Comunicação aos titulares (pela controladora)**
> Olá, [nome]. Em [data] identificamos um problema de segurança que [afetou / pode ter afetado] [quais dados seus]. [O que aconteceu, em linguagem simples.] Já [medidas]. Recomendamos que você [ações]. Se tiver dúvidas ou quiser exercer seus direitos, escreva para [canal da controladora; quando for a Demerzel Labs: contato@demerzellabs.com.br, encarregado Felipe Menegaz].

**D — Pedido ao prestador**
> Identificamos em [data] um incidente envolvendo dados enviados à [prestador] pela conta/projeto [id]. Solicitamos: (1) confirmação de quais dados foram recebidos e onde estão armazenados; (2) registros de acesso do período [início–fim]; (3) a exclusão de [dados], quando não houver obrigação de guarda, com confirmação por escrito.

**E — Nota interna de encerramento**
> INC-… encerrado em [data]. Causa: […]. Dados afetados: […]. Comunicações: empresa cliente em […], ANPD [sim/não, por quem, motivo], titulares [sim/não, por quem]. Lições: […]. Documentos alterados: […].

## 6. Registro de incidentes

Nota do vault: `Registro de incidentes LGPD`. **Sem dados pessoais**: titulares só como categorias e quantidades. Evidências ficam na pasta privada. O registro é disponível à empresa cliente a pedido, na parte que a envolve (DPA).

Campos:
- id;
- T0 (ciência, em UTC);
- data da ocorrência;
- como foi detectado;
- ambiente;
- controladora (Demerzel Labs ou empresa cliente, pelo id);
- dados e titulares (categorias e quantidades);
- crianças, saúde ou financeiro (sim ou não);
- contenção (o quê e quando);
- avaliação de risco e justificativa;
- empresa cliente avisada em (e horas desde T0);
- ANPD comunicada em, por quem (ou motivo para não comunicar);
- titulares comunicados em, por quem;
- situação (ABERTO, EM AVALIAÇÃO, ENCERRADO);
- lições.

### Registros abertos em 21/10/2026

A situação atual de cada um está no vault. Este documento não a atualiza.

| Id | Fato | Situação em 21/10 |
|---|---|---|
| **INC-20261015-01** | Uso de IA (OpenAI) no atendimento WhatsApp com dados de clientes reais, relatado por Felipe em 15/10/2026. `docs/PRIVACIDADE_ATENDIMENTO_D1_D4.md` dizia para não ligar o modo IA com dados reais antes de concluir D1–D4. Divergência de recomendação interna não prova, sozinha, incidente notificável | **EM AVALIAÇÃO.** A apurar: empresa controladora; período; contatos e mensagens enviados (`ia_uso_modelo` dá a contagem, não o conteúdo); configuração da época; termos da OpenAI vigentes; se houve violação de segurança e risco relevante. Se não houver fundamento para conservar, pedir exclusão à OpenAI. Os 30 dias dos logs de abuso vencem por volta de 14/11/2026. Hoje o Aviso declara a IA no WhatsApp **não habilitada**: conferir que continua desligada |
| **INC-20261014-01** | Credenciais do banco de **staging** coladas em chat de sessão de agente (exposição de 07/10; nova exposição da credencial v3 em 14/10) | **Proposta: ENCERRAR sem comunicação**, decisão de Felipe. Contenção: rotações v2→v3 e v3→v4 concluídas em 14/10/2026; a conferência da rotação v4 não observou uso da credencial antiga. Acesso ao banco restrito por lista de IPs |

## 7. Exercício

A cada 6 meses, simular um caso, por exemplo "chave da OpenAI publicada no GitHub". Cronometrar até a contenção e a minuta do aviso à empresa cliente (meta de 24 h). Registrar como `INC-SIMULADO-…`.

## 8. O que ainda é manual e o que precisa de ferramenta

| Item | Hoje | Futuro |
|---|---|---|
| Detecção | Manual (avisos, leitura de logs) | Alertas: falhas de login em massa, pico de IA, erro de isolamento entre empresas, retenção sem rodar há mais de 48 h |
| Substituto | Nenhum | Segunda pessoa com acesso de emergência documentado e dever de confidencialidade por escrito |
| Logs | Retenção do Render conforme o plano; sem exportação contínua | Envio de logs a armazenamento com prazo de 6 meses (tabela de retenção) |
| Acesso de suporte | `Registro de acessos de suporte LGPD`, manual ([INDICE.md](INDICE.md)) | Trilha automática no produto |
| Registro | Nota do vault | Mantém-se manual (baixo volume) |
