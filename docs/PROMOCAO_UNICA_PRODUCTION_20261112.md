# Promoção única staging → production (roteiro de 12/11/2026)

> Gerado por `node scripts/promocao-production-ordem.cjs --roteiro`. Não editar à mão: mudar os dados em `scripts/promocao-production-ordem.cjs` e gerar de novo (o teste confere).

**Isto é um roteiro, não uma autorização.** Nada aqui foi executado em production nem em staging. Cada passo continua exigindo, na hora: a autorização específica de Felipe, o backup restaurável registrado (dump conferido + PITR; export funcional não substitui) e os pré-requisitos do plano do próprio aplicador (`node <aplicador>`, sem argumentos, imprime o plano sem conectar).

## Regras da cadeia

- Onde: Web Shell do web de production (`srv-dak77m2d0e5s73b8rkkg`), com a árvore implantada trazendo os aplicadores, os núcleos e os SQL. Os blocos de Shell conferem o sha256 de cada arquivo implantado antes de rodar.
- Cada passo tem três fases, nesta ordem: **CONFERIR** (só leitura) → **APLICAR** (uma vez; marcador exclusivo no disco persistente) → **CONFERIR** de novo.
- **Qualquer código de saída diferente de 0 para a cadeia.** Não repetir o passo, não seguir para o próximo: copiar a saída e o marcador e decidir com Felipe. `proximoPasso()` deste script devolve PARAR nesses casos.
- A 098 é histórica e **nunca** entra (a 102 e a 108 recusam se ela existir). A 099 e a 105 já estão em production.
- O aplicador da 092–094 de production tem dois escopos: 092-093 e 094. O 094 exige antes o deploy do código novo.
- Os adaptadores de `scripts/migration-102-103-production.cjs`, `scripts/migration-104-106-production.cjs`, `scripts/migration-107-108-production.cjs`, `scripts/migration-109-production.cjs` são do outro lote desta promoção: os comandos deles abaixo usam as flags do núcleo e precisam ser conferidos contra o adaptador entregue.

## O que cada resultado significa

| Código | Significado | O que fazer |
|---|---|---|
| 0 | PLANO, PRONTA_PARA_APLICAR, APLICADA_POSTCHECK_PASS ou JA_APLICADA (conferência PASS) | seguir para a próxima fase |
| 1 | recusa do aplicador ANTES de conectar (alvo, disco, backup, argumentos, marcador de tentativa anterior, chave ligada na 117) | parar; nada foi enviado ao banco |
| 2 | FALHA registrada no marcador | parar; ler `commit`/`commits` na saída e rodar o CONFERIR do passo antes de qualquer decisão |
| 3 | conferência RECUSARIA | parar; ler o motivo; nada foi escrito |
| 4 | recusa do bloco de Shell (arquivo divergente, backup não informado, destino) | parar; o aplicador não rodou |
| outro ou sem a linha `CODIGO_SAIDA_BLOCO` | linha perdida, sinal ou colagem incompleta | parar e ler |

Situação do COMMIT numa FALHA: `NAO_COMMITADA` (o COMMIT nunca foi enviado: nada aplicado), `CONFIRMADO` (aplicado; a falha veio depois), `DESFEITA_PELO_SERVIDOR` (o servidor recusou o COMMIT: nada aplicado) e `INDETERMINADO` (sem resposta do COMMIT: só o CONFERIR diz se aplicou). Em todos os casos o marcador impede a repetição; retomar exige decisão de Felipe e o marcador anterior renomeado, nunca apagado.

## Regra de volta

- **Antes da 094** (passos 089, 090, 091, 092-093): voltar ao deploy anterior basta.
- **Da 094 em diante**: restaurar o backup registrado ou corrigir para a frente. O down de cada migration (`database/rollback/`) nunca é executado pelos aplicadores e só vale com autorização própria e nas condições do próprio arquivo.

## Fora da cadeia

| Migration | Situação | Motivo |
|---|---|---|
| 098 | EXCLUIDA | salões combinados HISTÓRICA: nunca entra na cadeia; a 102 e a 108 recusam se ela existir (a 108 é a 098 rebaseada) |
| 099 | JA_APLICADA | convites avulsos: já está em production |
| 105 | JA_APLICADA | canal MCP por assinatura: já está em production; fica fora do aplicador da 104–106 |

## Ordem e comandos

### 1. 089 — pedidos de cancelamento e devolução da assinatura, com protocolo

- Aplicador: `scripts/migration-089-production.cjs`
- CONFERIR: `node scripts/migration-089-production.cjs --conferir-089`
- APLICAR: `node scripts/migration-089-production.cjs --aplicar-089-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-089-production.cjs --conferir-089`
- Bloco de Shell: `node scripts/bloco-shell-089.cjs production <CONFERIR|APLICAR> <rotulo>`
- Volta: deploy anterior basta

### 2. 090 — campanha Fundador em duas fases

- Aplicador: `scripts/migration-090-production.cjs`
- CONFERIR: `node scripts/migration-090-production.cjs --conferir-090`
- APLICAR: `node scripts/migration-090-production.cjs --aplicar-090-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-090-production.cjs --conferir-090`
- Bloco de Shell: `node scripts/bloco-shell-090.cjs production <CONFERIR|APLICAR> <rotulo>`
- Volta: deploy anterior basta

### 3. 091 — documento fiscal CPF/CNPJ do contratante

- Aplicador: `scripts/migration-091-production.cjs`
- CONFERIR: `node scripts/migration-091-production.cjs --conferir-091`
- APLICAR: `node scripts/migration-091-production.cjs --aplicar-091-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-091-production.cjs --conferir-091`
- Bloco de Shell: `node scripts/bloco-shell-091.cjs production <CONFERIR|APLICAR> <rotulo>`
- Volta: deploy anterior basta

### 4. 092-093 — preço por quantidades cheias (092) e configuração da agenda por unidade (093); recusa se a 094 já estiver presente

- Aplicador: `scripts/migration-092-094-production.cjs`
- CONFERIR: `node scripts/migration-092-094-production.cjs --conferir-092-093`
- APLICAR: `node scripts/migration-092-094-production.cjs --aplicar-092-093-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-092-094-production.cjs --conferir-092-093`
- Bloco de Shell: `node scripts/bloco-shell-092-094.cjs production <CONFERIR-092-093|APLICAR-092-093> <rotulo>`
- Volta: deploy anterior basta

### 5. 094 — capacidade, limite do dia e intervalo na regra de conflito; exige 092 e 093 completas

**Antes deste passo:** deploy do código NOVO em production: o aplicador da 092–094 só aceita o escopo 094 depois dele (o código antigo não reconhece os corpos de função da 094).

- Aplicador: `scripts/migration-092-094-production.cjs`
- CONFERIR: `node scripts/migration-092-094-production.cjs --conferir-094`
- APLICAR: `node scripts/migration-092-094-production.cjs --aplicar-094-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-092-094-production.cjs --conferir-094`
- Bloco de Shell: `node scripts/bloco-shell-092-094.cjs production <CONFERIR-094|APLICAR-094> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 6. 095 — créditos de IA: carteiras, lotes, extrato, compra avulsa e devolução

- Aplicador: `scripts/migration-095-production.cjs`
- CONFERIR: `node scripts/migration-095-production.cjs --conferir-095`
- APLICAR: `node scripts/migration-095-production.cjs --aplicar-095-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-095-production.cjs --conferir-095`
- Bloco de Shell: `node scripts/bloco-shell-095.cjs production <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 7. 096 — comprovante da contratação e arquivo das versões dos documentos legais

- Aplicador: `scripts/migration-096-production.cjs`
- CONFERIR: `node scripts/migration-096-production.cjs --conferir-096`
- APLICAR: `node scripts/migration-096-production.cjs --aplicar-096-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-096-production.cjs --conferir-096`
- Bloco de Shell: `node scripts/bloco-shell-096.cjs production <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 8. 097 — manifestações do direito de arrependimento

- Aplicador: `scripts/migration-097-production.cjs`
- CONFERIR: `node scripts/migration-097-production.cjs --conferir-097`
- APLICAR: `node scripts/migration-097-production.cjs --aplicar-097-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-097-production.cjs --conferir-097`
- Bloco de Shell: `node scripts/bloco-shell-097.cjs production <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 9. 100 — agenda com um salão: troca o corpo de kidmais094_conflito_ocupacao; exige o corpo exato da 094

- Aplicador: `scripts/migration-100-production.cjs`
- CONFERIR: `node scripts/migration-100-production.cjs --conferir-100`
- APLICAR: `node scripts/migration-100-production.cjs --aplicar-100-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-100-production.cjs --conferir-100`
- Bloco de Shell: `node scripts/bloco-shell-100.cjs production <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 10. 102-103 — apresentação do salão (102) e categoria Serviços nos adicionais (103); a 102 recusa a 098

- Aplicador: `scripts/migration-102-103-production.cjs` — **do outro lote; conferir as flags contra o adaptador entregue**
- CONFERIR: `node scripts/migration-102-103-production.cjs --conferir-102-103`
- APLICAR: `node scripts/migration-102-103-production.cjs --aplicar-102-103-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-102-103-production.cjs --conferir-102-103`
- Bloco de Shell: gerador de production a cargo do outro lote
- Volta: restaurar o backup ou corrigir para a frente

### 11. 104-106 — versão do hash da revisão operacional (104) e salão de preferência do cliente (106); a 105 não entra

- Aplicador: `scripts/migration-104-106-production.cjs` — **do outro lote; conferir as flags contra o adaptador entregue**
- CONFERIR: `node scripts/migration-104-106-production.cjs --conferir-104-106`
- APLICAR: `node scripts/migration-104-106-production.cjs --aplicar-104-106-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-104-106-production.cjs --conferir-104-106`
- Bloco de Shell: gerador de production a cargo do outro lote
- Volta: restaurar o backup ou corrigir para a frente

### 12. 107-108 — reparo da deriva da agenda (107) e salões combinados rebaseados (108); a 108 recusa a 098

- Aplicador: `scripts/migration-107-108-production.cjs` — **do outro lote; conferir as flags contra o adaptador entregue**
- CONFERIR: `node scripts/migration-107-108-production.cjs --conferir-107-108`
- APLICAR: `node scripts/migration-107-108-production.cjs --aplicar-107-108-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-107-108-production.cjs --conferir-107-108`
- Bloco de Shell: gerador de production a cargo do outro lote
- Volta: restaurar o backup ou corrigir para a frente

### 13. 109 — renovação substituta do B-9; quebra o código anterior: código compatível antes

- Aplicador: `scripts/migration-109-production.cjs` — **do outro lote; conferir as flags contra o adaptador entregue**
- CONFERIR: `node scripts/migration-109-production.cjs --conferir-109`
- APLICAR: `node scripts/migration-109-production.cjs --aplicar-109-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-109-production.cjs --conferir-109`
- Bloco de Shell: gerador de production a cargo do outro lote
- Volta: restaurar o backup ou corrigir para a frente

### 14. 114 — trava da configuração da agenda nos gatilhos da 019 (KD114); sem checks externos, a prova é do núcleo

- Aplicador: `scripts/migration-114-production.cjs`
- CONFERIR: `node scripts/migration-114-production.cjs --conferir-114`
- APLICAR: `node scripts/migration-114-production.cjs --aplicar-114-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-114-production.cjs --conferir-114`
- Bloco de Shell: `node scripts/bloco-shell-promocao-production.cjs 114 <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 15. 112 — cliente pessoa jurídica; trava clientes pelo tempo da transação

- Aplicador: `scripts/migration-112-production.cjs`
- CONFERIR: `node scripts/migration-112-production.cjs --conferir-112`
- APLICAR: `node scripts/migration-112-production.cjs --aplicar-112-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-112-production.cjs --conferir-112`
- Bloco de Shell: `node scripts/bloco-shell-promocao-production.cjs 112 <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 16. 116 — franquias de IA por plano e ciclo; CREDITOS_FRANQUIA_PLANO_ATIVO continua desligada

- Aplicador: `scripts/migration-116-production.cjs`
- CONFERIR: `node scripts/migration-116-production.cjs --conferir-116`
- APLICAR: `node scripts/migration-116-production.cjs --aplicar-116-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-116-production.cjs --conferir-116`
- Bloco de Shell: `node scripts/bloco-shell-promocao-production.cjs 116 <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 17. 117 — atendimento WhatsApp multiempresa; o núcleo recusa com WHATSAPP_ATENDIMENTO_MULTIEMPRESA ligada

- Aplicador: `scripts/migration-117-production.cjs`
- CONFERIR: `node scripts/migration-117-production.cjs --conferir-117`
- APLICAR: `node scripts/migration-117-production.cjs --aplicar-117-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-117-production.cjs --conferir-117`
- Bloco de Shell: `node scripts/bloco-shell-promocao-production.cjs 117 <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 18. 118 — cota de leitura de documentos da importação de contratos; backup no formato "PITR <AAAA-MM-DDTHH:MMZ> <referencia>"

- Aplicador: `scripts/migration-118-production.cjs`
- CONFERIR: `node scripts/migration-118-production.cjs --conferir-118`
- APLICAR: `node scripts/migration-118-production.cjs --aplicar-118-autorizado --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-118-production.cjs --conferir-118`
- Bloco de Shell: `node scripts/bloco-shell-118-production.cjs <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 19. 120 — financeiro P2: liquidações de entradas e reversões de saídas

- Aplicador: `scripts/migration-generico-production.cjs` (genérico, lista fechada)
- CONFERIR: `node scripts/migration-generico-production.cjs --conferir 120`
- APLICAR: `node scripts/migration-generico-production.cjs --aplicar-autorizado 120 --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-generico-production.cjs --conferir 120`
- Bloco de Shell: `node scripts/bloco-shell-promocao-production.cjs 120 <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 20. 121 — financeiro P2: abertura do financeiro e conferências

- Aplicador: `scripts/migration-generico-production.cjs` (genérico, lista fechada)
- CONFERIR: `node scripts/migration-generico-production.cjs --conferir 121`
- APLICAR: `node scripts/migration-generico-production.cjs --aplicar-autorizado 121 --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-generico-production.cjs --conferir 121`
- Bloco de Shell: `node scripts/bloco-shell-promocao-production.cjs 121 <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 21. 110 — pesquisa de satisfação pós-festa

- Aplicador: `scripts/migration-generico-production.cjs` (genérico, lista fechada)
- CONFERIR: `node scripts/migration-generico-production.cjs --conferir 110`
- APLICAR: `node scripts/migration-generico-production.cjs --aplicar-autorizado 110 --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-generico-production.cjs --conferir 110`
- Bloco de Shell: `node scripts/bloco-shell-promocao-production.cjs 110 <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 22. 111 — pesquisa de satisfação: links de avaliação e auditoria; exige a 110

- Aplicador: `scripts/migration-generico-production.cjs` (genérico, lista fechada)
- CONFERIR: `node scripts/migration-generico-production.cjs --conferir 111`
- APLICAR: `node scripts/migration-generico-production.cjs --aplicar-autorizado 111 --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-generico-production.cjs --conferir 111`
- Bloco de Shell: `node scripts/bloco-shell-promocao-production.cjs 111 <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

### 23. 115 — índice (empresa_id, data_evento) em fechamentos no lugar do índice da 054

- Aplicador: `scripts/migration-generico-production.cjs` (genérico, lista fechada)
- CONFERIR: `node scripts/migration-generico-production.cjs --conferir 115`
- APLICAR: `node scripts/migration-generico-production.cjs --aplicar-autorizado 115 --backup "<registro-do-backup>"`
- CONFERIR de novo: `node scripts/migration-generico-production.cjs --conferir 115`
- Bloco de Shell: `node scripts/bloco-shell-promocao-production.cjs 115 <CONFERIR|APLICAR> <rotulo>`
- Volta: restaurar o backup ou corrigir para a frente

## Pendências conhecidas deste roteiro

- Nenhum passo foi ensaiado em PostgreSQL real por este lote: os adaptadores novos e o genérico têm só testes com cliente simulado.
- A fronteira de deploy (código antigo no escopo 092-093, código novo a partir do 094) é regra do aplicador da 092–094; como e quando a árvore com os aplicadores chega ao web de production é decisão do plano de promoção, não deste roteiro.
