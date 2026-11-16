# Procedimentos de proteção de dados (LGPD): índice

**Estado (03/11/2026): LOCAL, documental, não publicado.** Os cinco procedimentos de 21/10/2026 (clone de procedimentos LGPD) foram copiados e atualizados para:
- a fornecedora **Demerzel Labs Ltda.**, CNPJ 69.938.612/0001-26, SCRN 704/705, Bloco D, Loja 12, Asa Norte, Brasília/DF, CEP 70730-640 ("Demerzel Labs");
- o produto **iA.Fest**;
- o canal oficial **contato@demerzellabs.com.br**;
- o encarregado **Felipe Menegaz**;
- os textos `2026-11-15-termos`, `2026-11-15-privacidade` e `2026-11-15-dpa`.

O buffet **Kidmais Festas** é uma empresa cliente da plataforma. Pessoas ligadas à Demerzel Labs atuam nele.

**Fonte de verdade:** `lib/cadastro/documentos-legais.ts`. Se um procedimento divergir dos textos, valem os textos. Nenhum procedimento depende de parecer jurídico: as decisões são de Felipe, com risco assumido.

| Documento | Para quê | Executável hoje? |
|---|---|---|
| [BACKUPS-E-COPIAS.md](BACKUPS-E-COPIAS.md) | Inventário de PITR, exportações e dumps; regra de 90 dias com cópias locais; eliminação; reaplicar exclusões depois de restaurar | **Sim**, manual + script de inventário (no clone de procedimentos) |
| [DIREITOS-DO-TITULAR.md](DIREITOS-DO-TITULAR.md) | Canal, papéis (Demerzel Labs × empresa cliente), prazos, identificação, execução de cada direito, registro e modelos | **Sim**, manual |
| [REACEITE-EMPRESA-EXISTENTE.md](REACEITE-EMPRESA-EXISTENTE.md) | Novo aceite dos Termos e do DPA 2026-11-15 pela empresa existente, com ciência do Aviso | **Não ainda**: depende dos textos 2026-11-15 no ar em produção |
| [RESPOSTA-A-INCIDENTES.md](RESPOSTA-A-INCIDENTES.md) | Detecção, contenção, avaliação, aviso à empresa cliente com meta de 24 h, comunicação à ANPD pela controladora, registro e modelos | **Sim**, manual |
| [ENSAIO-EXPORTACAO-E-DEVOLUCAO.md](ENSAIO-EXPORTACAO-E-DEVOLUCAO.md) | Roteiro de ensaio: exportação completa em até 15 dias, isolada por empresa; devolução proporcional do anual no sandbox do Asaas | **Não executado**: depende de autorização para o ambiente |
| [CALENDARIO-DE-ELIMINACOES.md](CALENDARIO-DE-ELIMINACOES.md) | Rotina do dia 1º e eventos (fim de teste ou assinatura, aviso 30 dias antes, exclusão, restauração), derivados da tabela de retenção | **Sim**, manual; exclusões em produção a definir com autorização |

## Responsável e agenda

Felipe Menegaz (encarregado) é responsável por todos os procedimentos.

| Quando | O quê |
|---|---|
| Todo dia 1º | Rotina mensal ([CALENDARIO](CALENDARIO-DE-ELIMINACOES.md), seção 2), incluindo cópias ([BACKUPS](BACKUPS-E-COPIAS.md), seção 3) |
| Toda segunda-feira | Pedidos de titulares abertos e prazos ([DIREITOS](DIREITOS-DO-TITULAR.md)) |
| 1º de janeiro | Contratos (10 anos) e documentos fiscais vencidos ([CALENDARIO](CALENDARIO-DE-ELIMINACOES.md)) |
| Até 14/11/2026 | Decidir sobre o INC-20261015-01 antes do fim dos 30 dias de logs de abuso da OpenAI ([INCIDENTES](RESPOSTA-A-INCIDENTES.md)) |
| Textos 2026-11-15 no ar em produção | Reaceite ([REACEITE](REACEITE-EMPRESA-EXISTENTE.md)) |
| Antes do primeiro pedido real | Ensaio de exportação e devolução ([ENSAIO](ENSAIO-EXPORTACAO-E-DEVOLUCAO.md)) |
| A cada 6 meses | Exercício de incidente |

## Registros (onde ficam)

Todos os registros vivem no vault do Obsidian, **sem dados pessoais**. Evidências e documentos assinados ficam em pasta privada fora do Git e do vault.

| Registro (nota do vault) | Conteúdo | Disponível à empresa cliente |
|---|---|---|
| `Registro de incidentes LGPD` | Incidentes, avaliação e comunicações | A pedido (DPA, "Incidentes de segurança") |
| `Registro de pedidos de titulares LGPD` | Protocolos, prazos, papel e medida, sem nome nem contato | — |
| `Registro de copias e eliminacoes LGPD` | Cópias, exportações, eliminações e linhas de encerramento por empresa | A pedido (Aviso, "Armazenamento, segurança e retenção") |
| `Registro de acessos de suporte LGPD` | Acessos de pessoal da Demerzel Labs a dados de empresas clientes | A pedido (DPA, "Segurança e acesso de suporte"; Termos) |

**Atenção:** a pasta do workspace (`D:/glass/KidMais Manager/`, nome do repositório) é um repositório Git solto. Não guardar planilhas, PDFs ou dumps nela.

## Acessos de suporte

Os textos prometem: o acesso de pessoal da Demerzel Labs aos dados de uma empresa cliente limita-se a suporte solicitado, segurança do serviço ou obrigação legal. Cada acesso é anotado em registro próprio, com **data, empresa, motivo e pessoa**, fornecido à empresa a pedido. O pessoal do buffet Kidmais Festas não acessa dados de outras empresas, salvo quando a mesma pessoa presta suporte técnico solicitado, e só no necessário.

Regra: **anotar antes ou logo depois de cada acesso**, no mesmo dia.

| Campo | Exemplo |
|---|---|
| Identificador | `SUP-20261103-01` |
| Data e hora (UTC) | 03/11/2026 14:00Z |
| Empresa | id da empresa (não o nome de clientes dela) |
| Motivo | suporte solicitado em [protocolo ou e-mail de data]; segurança; incidente `INC-…`; obrigação legal |
| Pessoa | Felipe Menegaz (hoje é a única pessoa que acessa) |
| O que foi acessado | tela ou tabela, sem conteúdo |
| Ambiente | produção ou staging |

Contam como acesso: abrir telas da empresa pelo painel do desenvolvedor ou por troca de empresa; ler o banco filtrando a empresa; baixar exportação para atender pedido. Não conta: ver contagens agregadas sem dados de pessoas.

## O que ainda é manual e o que precisa de ferramenta

| Tema | Manual hoje | Ferramenta futura |
|---|---|---|
| Cópias locais e dumps no disco do Render | Inventário mensal + eliminação manual | Rotação automática dos dumps P1; alerta |
| Reaplicar exclusões após restauração | Tela por tela, a partir dos registros | Registro de determinações fora do banco + script de reaplicação |
| Pedidos de titulares | Registro no vault, telas atuais, CSV filtrado à mão | Protocolo no produto, busca e exportação por titular, anonimização de cliente |
| Eliminação de cliente | Inexistente (só inativação e edição manual) | Anonimização |
| Dados de saúde | Ação da empresa; lembrete mensal | Campo estruturado com lembrete de 30 dias |
| Exportação completa da empresa | CSV na tela + exportação manual a pedido em até 15 dias | Pacote ZIP verificável (branch local de 21/10) |
| Exclusão após 12 meses da suspensão | Calendário manual com aviso 30 dias antes | Exclusão programada automática |
| Retenção do WhatsApp | Rotina existe; prazo depende da empresa | Agendamento diário + alarme |
| Reaceite | Documento eletrônico | Aviso de novos termos no login |
| Incidentes | Detecção manual; sem substituto | Alertas; acesso de emergência |
| Acessos de suporte | Registro manual no vault | Trilha automática no produto |

## Pendências de decisão (Felipe)

1. Prazo de guarda do registro de pedidos (proposta: 5 anos) e do registro de acessos de suporte. O de incidentes é de no mínimo 5 anos.
2. Método de assinatura do reaceite (gov.br ou ICP-Brasil).
3. Classificação final do INC-20261015-01 e do INC-20261014-01.
4. Destino do banco local antigo (portas 5432/5433) e das cópias da classe B.
5. Estorno de Pix: resolvido em 03/11 — os Termos seguem o código (Pix e cartão voltam à origem; dados bancários só no boleto ou em estorno recusado) ([ENSAIO](ENSAIO-EXPORTACAO-E-DEVOLUCAO.md)).
6. Domínio de envio dos e-mails transacionais no Resend: conferir se ainda é um domínio do buffet e não da Demerzel Labs.
7. Levar o script de inventário de cópias (`scripts/lgpd-inventario-backups.cjs`) do clone de procedimentos para o clone que for publicado.
