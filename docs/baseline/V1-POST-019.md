# Baseline histórico V1 pós-019

## Finalidade e limites

Este documento e o [manifesto versionado](../../database/baseline/v1-post-019.manifest.json) fixam a linhagem histórica V1 que antecede a fundação SaaS. **V1 pós-019 é baseline histórico; ainda não é um schema multi-tenant.** A reconciliação incorpora somente migrations, checks e rollbacks 017–019, sem importar runtime ou executar SQL. Nenhuma migration SaaS é definida aqui.

O baseline é **canônico por equivalência física**, não por prova dos bytes de cada arquivo historicamente executado. Não há ledger de migrations versionado ou observado. A cadeia, os checksums e os blobs Git são verificáveis estaticamente. Os efeitos determinísticos da 019 foram comparados com o clone-evidência na B3; o fingerprint semântico completo, incluindo roles/ACLs dedicadas, foi reproduzido nas referências descartáveis B5B, não atribuído ao clone. Esta C0 não acessa bancos.

## Linhagem e fontes

Ordem de UP: `001 → 002 → 003 → 004 → 005 → 006 → 006a → 007 → 008 → 009 → 010 → 011 → 012 → 013 → 014 → 015 → 016 → 017 → 018 → 019`. Os artefatos 001–016, incluindo 006a, constam de `fdb9bdaa54a8d78366f03f746a174b249cb7c3ce`; 017 de `0ee482b66eb72e217cc6514d75c9769d7d5a0601`; 018 de `b58acc96c9d6600ffed132e751f83f497c2e8877`; 019 de `0460d0a10ed0ba1afbd2061055762cf3913bda0b`. O manifesto registra os 20 UPs e seus checks/prechecks/rollbacks existentes com SHA-256 normalizado UTF-8/LF, blob e dependências. Ausência de check individual é `null`, não evidência inventada. O arquivo 999 é rollback conjunto de desenvolvimento 001–004, fora da cadeia UP; o rollback 013 reside historicamente em `database/checks/`.

### 006 + 006a: composição legada

`logical_id: 006+006a`; `classification: legacy-composite`. O cabeçalho imutável da 006 diz **DRAFT / NÃO aplicar**, mas a aplicação histórica dos seus objetos foi observada; 006a pressupõe 006 aplicada e é necessária ao estado comercial canônico, inclusive à matriz de 69 preços. Portanto, `006.document_status=DRAFT_NAO_APLICAR`, `006.observed_applied_historical=true`, `006a.required_for_canonical_state=true`. Checksums: 006 `7354f57c42246a38329d0ad0ae0b6be4161c5e69a8e9bfafa9f3472595d0e2d9`; 006a `8520360897c2535cfdb0bc06b5da61ac5122ad35fdc9f9c82fa9fec57e27ebdc`. Não reescrever, fazer squash ou renumerar esses arquivos. 006 isolada não define o catálogo final.

### 017–019

- **017 — Pocket sexta:** altera a vigência da regra comercial `POCKET` / `TURNO_1` na sexta-feira; depende do catálogo 006+006a e da disponibilidade. É uma mutação datada de dados, com lock `SHARE ROW EXCLUSIVE`, não uma tabela nova. O rollback possui condições de recusa se o estado posterior já foi utilizado.
- **018 — WhatsApp onboarding:** cria `whatsapp_conexoes`, `whatsapp_onboarding_tentativas`, índices, funções e triggers de proteção; depende de usuários administrativos e auditoria. Credenciais cifradas são dados operacionais, não catálogo preservável. O rollback não é autorização genérica para descartar dados existentes.
- **019 — formalização da Festa:** estende `festas` e `festa_eventos` com autoria explícita, adiciona validação/locks de formalização e funções/triggers; substitui especificamente três definições de função da 014, incluindo `kidmais_ocupacoes_operacionais(date,date)`, e estende objetos criados pela 016. Não substitui as migrations 014 ou 016 inteiras. É instalação sem backfill e pressupõe precheck de conflitos; seu rollback tem limites após uso operacional.

Os doze arquivos históricos 017–019, e **somente eles**, foram copiados dos commits acima, preservando os blobs Git. Os commits também contêm runtime, UI, scripts e configuração externa que não integram esta reconciliação. Não houve merge nem cherry-pick integral.

## Errata forense da 019

O documento histórico `docs/PATCH_019_FESTA_FORMALIZACAO.md`, presente no commit `0460d0a10ed0ba1afbd2061055762cf3913bda0b` e não importado para esta branch, cita `ce6c3eab69541105f27c2ec79b1b0f4a9e406e8f5d05ba25c7ea83c3bd3f9456`. A referência fica preservada como **histórica não resolvida**: nenhum artefato disponível foi vinculado a esse checksum. Ela não deve ser substituída silenciosamente nem usada no manifesto como checksum canônico.

O arquivo Git canônico é `database/migrations/20260915_019_festa_formalizacao.sql` no commit acima, blob `4401bacd9dec167291c61258fe1dac86a0ba6974`, SHA-256 UTF-8/LF `121265ed0e5c89882abf27a7178f206d26f0e1dea15a773bc413fdaf68ed4d90`. Classificação: **CANÔNICO POR EQUIVALÊNCIA FÍSICA**. Seus efeitos determinísticos corresponderam ao estado físico inspecionado, mas a ausência de ledger impede provar que esses bytes exatos foram executados historicamente.

## Projeção física e catálogo

Canonicalização `V1_POST019_PG18_SEMANTIC_V1`, PostgreSQL `180006`. Fingerprint físico `3b1066bc2bd546d589347561356490aaa19158026f31ea8893fd6c0db32d596e`; digest dos 22 componentes `3b602275f000caeed8f12dcefc2bbfff59ca2dc806b168806776068322cba757`. Inventário: 63 tabelas públicas, 862 colunas, 1.261 constraints, 288 índices, 828 triggers, 107 funções, duas sequences e três extensões. O hash do catálogo físico de referência é `f39fa1abc108a29470755a045d6d5cc60ce14c26da21a49861bbcf4bd2e99563`; ele é diferente do hash `7c7cb966b0f5643cea463b6eef9266afbf0e8ef2ab26836a5c13afa08cf9fd24` do manifesto de catálogo usado no atestado.

O catálogo canônico e seus seeds estão em [`canonical-catalog.json`](../../scripts/sanitize-v1-post-019/canonical-catalog.json). Owners, ACLs, roles, memberships e role settings integram o fingerprint semântico. A referência descartável usa owner `kidmais_b5b_owner` e role mínima `kidmais_b5b_sanitizer`; **isso não prova nem redefine owners/grants de produção**. A ausência de ledger e de RLS/policies no baseline V1 é explícita. Nenhum owner, grant ou seed não comprovado é inferido.

## Sanitização certificada B5B

O [procedimento e os limites](./V1-POST-019-SANITIZATION.md) documentam o perfil `V1_POST019_EMPTY_OPERATION`: 63 tabelas classificadas, nove `PRESERVE_CANONICAL`, 54 `EMPTY`, duas sequences preservadas e `identities_restarted=false`. A referência foi reconstruída duas vezes, com fixture sintética nas 12 tabelas da malha financeira 015, dry-run PLAN, apply com COMMIT confirmado, postcheck e verify independente PASS. Atestado de execução foi emitido na bateria descartável, mas não persistido no Git. O selo da receita R1 é `443ea6b6950d59a7546ea11b264847338c4369abd7a87a341c97696f12a6064b`; o do executor, `31646a289dc1ebf3db13d4a620e3dabfb8e470ea79447f162e65dbe45f9baaf3`.

Trata-se de **estado lógico vazio em um destino descartável**, não de secure erasure, limpeza de WAL/backups, reset de identities ou certificação multi-tenant. As sequences preservadas podem reter indícios agregados. A fixture usa timestamps fixos em 2030 e demonstra invariantes finais, não todos os caminhos de transição.

## Fronteira com o SaaS

O histórico V1 é global: não contém isolamento por `empresa_id`/`estabelecimento_id` nem políticas RLS. A futura fundação SaaS deverá decidir escopo, backfill, autorização, testes cross-tenant e estratégia de deploy separadamente, preservando compatibilidade V1. A aprovação deste baseline **não inicia 1B-C, não autoriza migration SaaS e não autoriza acesso a produção, Render ou bancos protegidos**.
