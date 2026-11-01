# Planos de 01/11/2026 em production — recorte só da seção de planos

Felipe pediu (01/11/2026) levar a mudança dos planos para production, **só os planos**, sem publicar os preços.

A mudança de staging é a PR #294 (`4ab4d926`, merge `f40acc51`, live em staging em `dep-dbjjr167bikc73fme4f0`), descrita em `docs/PLANOS_IAFEST_20261101.md` na staging. Ela não aplica limpa sobre production porque production não tem o site do iA.Fest (`aaaf2696`, `c8529e3a`). Este recorte refaz só os itens dos planos sobre production `5bdd5ac4`.

## O que muda

`lib/site/catalogo.ts`, sobre production:

- Itens dos planos idênticos aos de staging: Essencial com copiloto e convite (franquia básica) e Wall-e no WhatsApp como não incluído; cotas de importação da D-LOTE-6 (até 5 / 10 por mês / 30 por mês) no lugar de "com cota" e "sem cota"; convite com franquia maior/ampla; "Implantação dedicada, com a conexão do seu WhatsApp".
- Descrições "Organize. / Venda mais. / Atenda 24 h.".
- Adicional Wall-e no WhatsApp: "Para o Profissional … nada é cobrado por uso sem você comprar um pacote".
- **O adicional "Wall-e publicitário" sai da seção de planos** (pausa de 23/10). O recurso `walle_publicitario` continua no catálogo porque as outras seções do site de production ainda o usam.

`lib/site/site.test.ts`: o mesmo teste da staging, acrescido da conferência de que nenhum adicional é publicitário.

## O que não muda

- Nome do sistema (continua Kidmais Manager em production), demais seções do site, Wall-e publicitário fora da seção de planos, preços, versão da oferta, checkout, Asaas, barreiras do servidor.
- Preços seguem ocultos em production ("Preço a definir"), porque `SITE_PRECOS_PUBLICADOS` não foi alterada.
- Sem migration e sem env.

## Validação

Ver a descrição da PR.
