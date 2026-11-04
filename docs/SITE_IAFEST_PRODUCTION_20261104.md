# Site iA.Fest em production — recorte 2 (04/11/2026)

Leva a `production` a identidade iA.Fest do site público e a galeria de recursos com capturas, já LIVE em `staging` desde 23/10.

## Origem

Os seis commits diretos de staging de 23/10:

- `aaaf2696`: identidade iA.Fest e retirada do Wall-e publicitário.
- `69707d0c`: logo fora do fundo.
- `53b02951`: Marketing e automações.
- `c8529e3a`: importação, financeiro e site do buffet.
- `e4fcf9a4`: cabeçalho.
- `dc906c2f`: galeria com capturas e cabeçalho compacto.

Os arquivos do site que production não alterou depois de 23/10 vêm iguais à versão de staging em `dc906c2f`. `lib/site/catalogo.ts` e `lib/site/site.test.ts` foram mesclados à mão, porque production já tem os planos iA.Fest da #295.

## Fora do recorte

- **Plano Fundador com campanha** (`lib/site/fundador*.ts` e as mudanças da #221 em `Site.tsx`, `Planos.tsx` e `secoes.tsx`). Lê a campanha da migration 090, que production não tem. O texto do Fundador continua o de production.
- **Seção "Agenda por salão"** (`AgendaSaloes`), seus links no cabeçalho e no rodapé, e o texto de agenda por salão com intervalo entre festas. Salões (098+) e o intervalo entre festas (#211) existem só em staging. A aba Agenda mantém o texto que production já publicava.
- **Nome iA.Fest em `/termos`, `/privacidade` e `DocumentoLegal`.** Esses arquivos pertencem à rodada R-5 dos textos legais.
- **Documentos de publicação em staging** (`docs/SITE_IAFEST_IDENTIDADE_20261023.md`, `docs/SITE_GALERIA_RECURSOS_20261023.md`) e suas evidências.

## Auditoria de veracidade da galeria

Cada item foi conferido contra o código de production `acd98849`:

| Item | Production tem | Ajuste |
|---|---|---|
| Agenda | Disponibilidade, bloqueios e regras comerciais por pacote | Título, texto e itens trocados: sem salão nem intervalo |
| Orçamento online | Jornada pública com disponibilidade e pacotes | — |
| Contratos | Modelo, dados da contratação, histórico | — |
| Financeiro | Contas a receber/pagar, fluxo de caixa, festa | — |
| Gestão de festas | Buffet, checklist, financeiro, histórico | — |
| Convites | Criação por IA, foto opcional, presença de adultos e crianças | — |
| Clientes | Família, aniversariantes | — |
| Pacotes | Faixas de convidados, horários, adicionais | Captura recortada sem o aviso de "preços a confirmar" (092, só staging) |
| Site do buffet | Prévia, publicação, SEO | — |
| Marketing | Pós-festa, proposta parada, recompra, datas vagas | — |
| Importação por IA | Modelo, contratos fechados com integração, tabela de preços | — |
| Copiloto | Pacotes, conta a pagar, contratação, consultas | — |

Ficam como estavam em production: os textos que citam salões na aba Agenda e no mock da agenda. Na rodada 2, "Antes e depois" passou a dizer "datas e horários".

## Rodada 2 (revisão do Astra: REPROVADO, 3 P2 e 2 P3)

- **P2-1. Selos na galeria.** Cada item de `lib/site/galeria.ts` passou a ter `recursos`, com os ids do catálogo. As abas e o título do painel usam `<Recurso>`, o mesmo componente dos planos. Mostram "Em breve": Orçamento online, Convites, Importação por IA e Copiloto.
- **P2-2. Condição de plano.** Orçamento online, Site do buffet e Marketing levam "Nos planos Profissional e Premium" no painel da galeria. A seção Marketing traz a mesma linha abaixo do título, e o card do site do buffet também. A condição segue a barreira do servidor: `ORCAMENTO_ONLINE` e `MARKETING` em `lib/assinatura/recursos-plano.ts`.
- **P2-3.** O texto do Antes e depois "datas e salões estão livres" passou a "datas e horários estão livres".
- **P3. Cobertura.** Novo teste em `lib/site/site.test.ts`, que verifica:
  - selo de cada aba e de cada painel conforme o status do catálogo;
  - linha de planos só nos itens com barreira, conferida contra o texto de `recursos-plano.ts` sem importá-lo;
  - Marketing com a condição de plano;
  - nenhuma superfície nova com "salão", "salões" ou "intervalo";
  - ausência de `AgendaSaloes` e de `#saloes`.

  Mutantes: 9 de 9 mortos.
