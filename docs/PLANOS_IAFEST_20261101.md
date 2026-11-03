# Planos do iA.Fest — catálogo após as decisões de 01/11/2026

Decisões de Felipe (01/11/2026, registradas no vault em `06 - Productizacao/Planos iA.Fest benchmark e proposta 20261101.md`):

- **D-PL-1.** Atendimento por IA no WhatsApp (hoje "Wall-e no WhatsApp" na vitrine) **incluído só no Premium**, **comprável como adicional só no Profissional**, **nunca no Essencial**.
- **D-PL-2.** Franquias de conversas provisórias (300 no Premium, 150 no adicional, pacote de 100) até um piloto medir volume e custo. **Não vão ao site** antes disso.
- **D-PL-3.** IA que ajuda o dono entra em todos os planos: copiloto e convite com IA no Essencial com franquia básica.
- **D-PL-4.** Catálogo corrigido: importação por IA com as cotas da D-LOTE-6 (5 na implantação / 10 por mês / 30 por mês); implantação dedicada do Premium inclui a conexão do WhatsApp.
- **D-PL-5.** Modelo do atendente (Haiku na triagem, Sonnet onde precisa) — sem efeito neste catálogo.
- **D-PL-6.** Nomes dos planos mantidos; linhas "Organize / Venda mais / Atenda 24 h".

## O que muda nesta entrega (só vitrine)

`lib/site/catalogo.ts`:

| Plano | Antes | Depois |
|---|---|---|
| Essencial | Copiloto de IA **excluído**; convite ausente; "Importação por IA na implantação" | "Copiloto de IA, franquia básica"; "Convite da festa com IA, franquia básica"; "Importação por IA na implantação: até 5 documentos"; "Wall-e no WhatsApp" **excluído explicitamente** |
| Profissional | "Importação … com cota"; "Copiloto de IA, franquia básica" | "… até 10 documentos por mês"; "Copiloto de IA, franquia maior"; "Convite da festa com IA, franquia maior"; "Wall-e no WhatsApp como adicional" (inalterado) |
| Premium | "Importação por IA sem cota"; "Implantação dedicada" | "Importação por IA: até 30 documentos por mês"; "Convite da festa com IA, franquia ampla"; "Implantação dedicada, com a conexão do seu WhatsApp" (selo do recurso `walle_whatsapp`) |
| Adicional Wall-e no WhatsApp | "O que passar da franquia é cobrado por uso." | "Para o Profissional … Quando a franquia acaba, a conversa passa para a sua equipe; nada é cobrado por uso sem você comprar um pacote." (regra D-C6 estendida ao WhatsApp) |
| Descrições | "Para começar a sair…" / "Para quem quer o caixa…" / "Para buffets com equipe grande…" | "Organize. …" / "Venda mais. …" / "Atenda 24 h. …" |

Os itens novos carregam os recursos `copiloto`, `convite` e `walle_whatsapp`, todos ainda `em_breve` no catálogo, logo aparecem com o selo. Nenhum número de franquia de IA entra no site (D-PL-2); as cotas de importação entram porque a D-LOTE-6 já as decidiu.

`lib/site/site.test.ts`: teste novo "planos iA.Fest (01/11)" cobrindo os pontos acima. Controle negativo em worktree separada da `staging` (`5d2f710a`): o teste novo falha no catálogo antigo em "essencial inclui copiloto"; os outros 15 passam.

## O que não muda

- Preços, `condicoesComerciais.versao` (`2026-10-20`), checkout, Asaas, `lib/assinatura/recursos-plano.ts`: nenhuma barreira de servidor foi alterada. O checkout não lê os itens do catálogo.
- **Wall-e publicitário (peças com IA).** A D-PL-3 previa "20 peças no Essencial", mas a decisão de 23/10 (`docs/SITE_IAFEST_IDENTIDADE_20261023.md`, commit `aaaf2696`) retirou o projeto publicitário da vitrine por pausa de prioridade, inclusive como "Em breve"; o teste "projeto publicitário pausado fora da vitrine" protege isso. Por isso as peças do Wall-e **não entram** no catálogo. No código, não há o que separar hoje: o gate `MARKETING` cobre campanhas, atribuições, site por unidade, domínios e automações; o Wall-e de arte é um aplicativo à parte, ainda sem o login do Manager (F1 da proposta de contas). A separação "gerar e baixar (todos os planos) × Marketing completo (Profissional+)" fica como requisito para quando o Wall-e entrar no Manager.
- Status dos recursos: `convite` continua `em_breve` na vitrine embora o convite avulso já esteja em produção (#288/#290); atualizar a evidência é tarefa própria, fora desta entrega.

## Validação

- `node --experimental-strip-types --test lib/site/site.test.ts`: 16/16.
- `tsc --noEmit`, `eslint` nos arquivos alterados e `git diff --check`: limpos.
- `check:v1:static`: código 0 (4154/4154 e 103/103; lint 0 erros, 3 avisos pré-existentes fora destes arquivos). `build`: código 0, 84 páginas.

Sem commit, PR, deploy ou mudança de env.
