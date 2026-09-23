# Catálogo V1 — extras unitários e Pizza Party (025)

Implementado e revisado em 23/09/2026 na branch `v1/catalogo-021a`. Publicação autorizada
somente nesta branch, após conferência visual e restauração dos dados de teste; sem deploy.
A migration 024 aplicada anteriormente **não foi editada nem reaplicada**.

## Produtos e regras aprovadas

| SKU | Oferta nova | Regra |
|---|---|---|
| BOMBOM | R$ 4,00/unidade extra | Seleção opcional; a partir de 1 unidade extra, sem lote mínimo. Premium já inclui 4 bombons: informar somente extras, sem cobrar os incluídos e sem subtrair 4 da quantidade extra. |
| LEMBRANCINHA_COPO | R$ 9,00/unidade extra | SKU novo, distinto de personalizada/premium. |
| LEMBRANCINHA_BOLA | R$ 12,00/unidade extra | SKU novo, distinto de personalizada/premium. |
| LEMBRANCINHA_PERSONALIZADA | Oculta/inativa para novas contratações | Nome, ID e preço histórico de R$ 18 preservados; produto não confirmado. |
| LEMBRANCINHA_PREMIUM | Oculta/inativa para novas contratações | Nome, ID e preço histórico de R$ 25 preservados; produto não confirmado. |

Copo/Bola encontrados em buffet são escolhas, não os SKUs comerciais antigos.
A ambiguidade foi apresentada ao proprietário, que autorizou SKUs separados e a
suspensão das duas ofertas antigas. Nenhum produto foi renomeado por inferência.

Os extras cobram quantidades inteiras positivas selecionadas. Zero extras significa
não selecionar o item. O navegador informa quantidade e total; o servidor calcula
com os preços persistidos, recusa frações para UNIDADE e não aceita preço do cliente.
Os fluxos público e administrativo enviam as quantidades reais. Edição/revisão
administrativa aceita bombom EXTRA no Premium; a proteção dos demais itens incluídos
permanece. A quantidade incluída é distinta do limite de sabores do buffet.

Pizza Party recebe vínculos EXTRA para todos os adicionais ativos com preço definido,
sem criar outra tabela por pacote ou alterar faixas. Sua base/elegibilidade continua
SOB_CONSULTA. A tela inicial oferece consulta de extras por data/convidados sem liberar
fechamento automático nem inventar preço base. A consulta usa a mesma API de preços.

## Versionamento e execução no clone

- Nova migration: `database/migrations/20260923_025_extras_unitarios_pizza.sql`.
- Precheck/postcheck: `database/checks/20260923_025_precheck.sql` e `20260923_025_postcheck.sql`.
- Tabela nova `COMERCIAL_2026_09_EXTRAS_V3`, clonada da tabela pós-024. Preços de pacote e
  demais extras/faixas são copiados sem alteração; somente o bombom muda na nova tabela.
- Preços antigos, IDs referenciados, nomes/snapshots aplicados e PDFs não são regravados.
- Se a substituição ocorre no mesmo dia, a tabela anterior é inativada (sem data final
  anterior à inicial); se ocorre depois, encerra-se sua vigência no dia anterior.
- Precheck, aplicação e postcheck: **PASS**, destino confirmado `kidmais_v1_homologacao`,
  host `::1` (loopback), porta `5432`, única credencial de origem
  `KIDMAIS_HOMOLOGACAO_DATABASE_URL`.
- A primeira tentativa encontrou `23502 adicionais.categoria_id`. Foi revertida
  integralmente; corrigido o vínculo obrigatório introduzido pela 021, e o ciclo
  precheck/aplicação/postcheck passou. Houve somente **uma aplicação commitada da 025**.
- O executor manteve a migration dentro de uma única transação e só fez COMMIT após
  postcheck e comparação dos históricos. Nenhuma escrita fora do clone.
- A 025 permanece aplicada no clone; os dados fictícios dos testes foram revertidos.

## Lista final de adicionais visíveis

Lista observada pela API pública no clone, tabela nova, data 26/06/2027, conferida
nas faixas de 79 e 80 convidados. “—” significa não oferecido como EXTRA naquele pacote;
um item pode já estar incluído. Não representa indisponibilidade da composição inclusa.
Os oito combos já tinham preço e vínculo comercial na 023, mas faltavam no mapa público:
foram mapeados pelos próprios códigos, sem inventar equivalência ou preço.

| Pacote | Quantidade de SKUs extras visíveis |
|---|---|
| POCKET | 31 |
| MINI_FESTA | 31 |
| COMPACTA | 31 |
| ESSENCIAL | 31 |
| COMPLETA | 26 |
| PREMIUM | 22 |
| PIZZA_PARTY | 31 |

| Adicional | Pocket | Mini Festa | Compacta | Essencial | Completa | Premium | Pizza Party |
|---|---|---|---|---|---|---|---|
| Taxa para bebida alcoólica (`BEBIDA_ALCOOLICA`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Penne à bolonhesa e molho branco (`PENNE`) | Sim | Sim | Sim | Sim | — | — | Sim |
| Salada premium (`SALADA_PREMIUM`) | Sim | Sim | Sim | Sim | Sim | — | Sim |
| Crepe — 1 sabor (`CREPE_1_SABOR`) | Sim | Sim | Sim | Sim | — | — | Sim |
| Crepe — 2 sabores (`CREPE_2_SABORES`) | Sim | Sim | Sim | Sim | Sim | — | Sim |
| Pastelzinho de carne e queijo (`PASTELZINHO`) | Sim | Sim | Sim | Sim | Sim | — | Sim |
| Sorvete (`SORVETE`) | Sim | Sim | Sim | Sim | — | — | Sim |
| Empratado premium (`EMPRATADO_PREMIUM`) | Sim | Sim | Sim | Sim | Sim | — | Sim |
| Combo Adultos (`COMBO_ADULTOS`) | Sim | Sim | Sim | Sim | — | — | Sim |
| Combo Lanchinhos (`COMBO_LANCHINHOS`) | Sim | Sim | Sim | Sim | — | — | Sim |
| Combo Mesa Bonita — Simples (`COMBO_MESA_BONITA_SIMPLES`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Combo Mesa Bonita — Médio (`COMBO_MESA_BONITA_MEDIO`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Combo Mesa Bonita — Premium (`COMBO_MESA_BONITA_PREMIUM`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Visual Premium (`VISUAL_PREMIUM`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Visual Premium + personalizados (`VISUAL_PREMIUM_PERSONALIZADOS`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Visual Premium completo (`VISUAL_PREMIUM_COMPLETO`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Arco de balão simples (`ARCO_BALAO_SIMPLES`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Arco de balão médio (`ARCO_BALAO_MEDIO`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Arco de balão grande (`ARCO_BALAO_GRANDE`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| 2º tema (`SEGUNDO_TEMA`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Painel redondo (`PAINEL_REDONDO`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Painel retangular grande (`PAINEL_RETANGULAR_GRANDE`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Chão de vidro (`CHAO_VIDRO`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Montagem de personalizados (`MONTAGEM_PERSONALIZADOS`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Doces tradicionais extras (`DOCES_TRADICIONAIS_EXTRAS`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Bombom (`BOMBOM`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Lembrancinha extra — Copo (`LEMBRANCINHA_COPO`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Lembrancinha extra — Bola (`LEMBRANCINHA_BOLA`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Mesa de café (`MESA_CAFE`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Mesa de frios (`MESA_FRIOS`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |
| Mesa de frutas (`MESA_FRUTAS`) | Sim | Sim | Sim | Sim | Sim | Sim | Sim |

Personalizada e Premium (lembrancinhas antigas) **não aparecem em nenhum pacote**.
Pizza usa integralmente as mesmas regras de preço e unidades dos demais pacotes;
rolha: 79 convidados R$ 190,00; 80 convidados R$ 290,00. Nenhum preço base de Pizza foi criado.

## Validação e preservação

| Verificação | Resultado |
|---|---|
| 025 precheck / aplicação / postcheck | PASS no clone |
| API de adicionais dos 7 pacotes, 79/80 convidados | PASS; Copo/Bola/bombom disponíveis, SKUs suspensos ausentes |
| Pizza: todos os adicionais ativos precificados | PASS; igualdade de SKUs e valores com catálogo de preços; base continua PACOTE_SOB_CONSULTA |
| Quantidades extras 1, 2 e 80; totais | PASS; total dos três SKUs = quantidade × R$ 25 |
| Premium sem extras / 1 bombom extra | PASS; extras R$ 0 / R$ 4, sem cobrar os 4 incluídos |
| Quantidades 0, negativas e fracionárias | PASS; rejeitadas sem criação parcial |
| Fechamento real pelo serviço e pelo POST público | PASS; 3 bombons + 2 copos + 1 bola = R$ 42,00, quantidades e preços persistidos conferidos |
| Edição administrativa para Premium com 1 bombom extra | PASS; cálculo de extras R$ 4,00 |
| Dez fechamentos históricos e valores | PASS; hash integral idêntico antes/depois da migration e dos testes |
| Contratos, versões, documentos, assinaturas e preços antigos | PASS; contagens/hashes idênticos antes/depois da migration |
| Restauração dos testes | PASS; 72 tabelas idênticas ao baseline pós-025 após ROLLBACK |
| Testes unitários afetados | 84 PASS / 0 FAIL |
| ESLint / TypeScript / build isolado | PASS |
| git diff --check | PASS |

Grupos integrados: `catalogo,rolha,fechamento,negativos_buffet,extras025`: 5 PASS.
O grupo `extras025` foi repetido após acrescentar a conferência do POST público real:
PASS. Na primeira versão do teste, um pacote restrito foi precificado no sábado;
a aplicação recusou corretamente. O teste de extras foi separado da elegibilidade
específica de cada pacote, sem afrouxar regras de dia/horário.

Hash dos 10 fechamentos: `5009709cb89bd0bb0e008334cf0ca446c76cfaa191edea58d2d0441ac3af37ca`.
Evidências locais ignoradas: `.tmp/catalogo025-migration-evidence.json`,
`.tmp/catalogo025-unit.log`, `.tmp/catalogo025-integration-final.log`;
resultados em pastas temporárias `kidmais-catalogo-regressao-p6s82x` e
`kidmais-catalogo-regressao-hZgZEX`. Nenhuma credencial ou dado pessoal foi incluído.
Build usou cópia isolada, sem dotenv/credencial real; não conectou ao clone.
## Revisão visual e preparação para publicação — 23/09/2026

Navegador local em desktop (1365 × 900) e celular (390 × 844), com a aplicação
conectada exclusivamente ao clone `kidmais_v1_homologacao`, `::1:5432`. O adaptador
temporário do teste manteve as operações reais em uma transação externa: a aplicação
usou seus serviços/APIs e savepoints, sem publicar o adaptador ou criar um bypass no produto.

| Conferência | Resultado |
|---|---|
| Listas no fechamento público | PASS: Pocket/Mini/Compacta/Essencial 31, Completa 26, Premium 22; igualdade com a lista acima |
| Pizza no fechamento público | PASS: consulta com 31 extras precificados; base continua **Sob consulta**, sem habilitar fechamento automático |
| Rolha na consulta Pizza | PASS: 79 → R$ 190; 80 → R$ 290, mesmas faixas vigentes |
| Editor administrativo | PASS: mesmos extras habilitados; itens inclusos aparecem identificados e desabilitados, sem oferta das lembrancinhas suspensas |
| Copo/Bola/bombom no público | PASS: R$ 9/R$ 12/R$ 4 por unidade extra; 1 de cada = R$ 25; 3 bombons + 2 copos + 1 bola = R$ 42 |
| Premium sem extras / 1 bombom extra | PASS: nenhum extra obrigatório; editor R$ 8.321,50 → R$ 8.325,50, apenas R$ 4 de diferença; os 4 incluídos não são cobrados |
| Quantidade selecionada zero | PASS: avanço público bloqueado com mensagem de quantidade inteira positiva; para zero extras, desmarcar |
| Gravação/reabertura administrativa | PASS: revisão temporária salva e relida com Bombom (3), Copo (2), Bola (1), R$ 42 de adicionais e R$ 8.363,50 no total |
| Layout dos extras | PASS: campos e totais utilizáveis em desktop/celular; sem transbordamento horizontal nos controles conferidos |
| Restauração final | PASS: rollback integral; consulta independente read-only confirmou 72 tabelas idênticas ao baseline pós-025 e os mesmos 10 fechamentos/valores |

Pocket/Mini foram conferidos em segunda-feira; Compacta em domingo, com os 40
convidados exigidos pelo preço automático existente. A tentativa com 60 foi
corretamente recusada; nenhuma regra do pacote foi relaxada.

A revisão temporária cancelou a preparação V1 anterior pelo fluxo existente; na
reabertura, a linha foi localizada com **Incluir contratos cancelados** (rótulo
“PREPARACAO CANCELADA”), enquanto o painel confirmou contrato
`AGUARDANDO_ASSINATURA` e V2 `EM_ELABORACAO`. Esse comportamento de listagem não foi
alterado pela 025. Toda a revisão e a conta administrativa fictícia foram revertidas.

As falhas iniciais de carregamento vieram do adaptador temporário de banco na cópia
isolada (resolução de módulo pelo bundler). Foram corrigidas somente nessa cópia,
antes da gravação administrativa bem-sucedida; não exigiram mudança na aplicação.

Capturas inspecionadas durante a sessão, logs, cópia da aplicação, hashes completos
do clone e adaptadores temporários ficam fora do commit. Evidência independente:
`test-results/catalogo-browser/fix-after-hashes.json` (ignorado).

Não houve reaplicação da migration, deploy, acesso a outro banco, merge ou alteração
de OTP/Gupshup nesta revisão. Somente código, testes, migration/checks 025 e documentação
serão publicados na branch do PR #5, que deve permanecer em rascunho.
