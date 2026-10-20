# Migrations de produção — pacote de 19/10/2026

**Status: PREPARADO E ENSAIADO LOCALMENTE, NÃO EXECUTADO** (revisado em 19/10: APROVADO COM RESSALVAS; ressalvas P2-1…P2-4 e P3 tratadas neste pacote). Nada foi aplicado, lido ou conectado em produção ou staging
nesta preparação. Executar qualquer bloco exige autorização própria de Felipe (docs/OPERACAO_AGENTES.md); preparar e ensaiar
não autoriza aplicar.

Objetivo: levar `kidmais_production` (`dpg-dak750gae00c73fudmg0-a`, web `srv-dak77m2d0e5s73b8rkkg`, PostgreSQL 18) ao schema
exigido pelo código de staging (`bd9bd674…`), a partir do estado lido em 19/10: presentes 061–074, 079 e 084; ausentes 074a,
075, 076, 077, 078, 060, 065, 080, 081, 082, 083, 085 e 086. Uma empresa (`kidmais`, ATIVA, sem assinatura).

## Ordem e dependências (lidas nos SQL e prechecks)

| # | Migration | Aplicador | Depende de (no SQL) | Observação |
|---|---|---|---|---|
| 1 | 074a planos comerciais | lançamento | 067 `empresa_assinaturas`, 068 `cobranca_eventos` + guarda 068 com md5 fixo, 069 `plataforma_empresas_cadastro` | troca a guarda 068; nenhuma linha alterada |
| 2 | 075 renovação Fundador | lançamento | 074a (`assinatura_contratacoes`, `_fundadores`, `_isencoes`) | |
| 3 | 076 CPF por empresa | lançamento | 054 (`clientes.empresa_id`) e índice global `clientes_cpf_canonico_uk` (002/054) | troca de índice; trava escrita em `clientes` |
| 4 | 077 regras de pagamento | lançamento | 031 `empresas` | insere a linha legada da `kidmais` |
| 5 | 078 catálogo do buffet por empresa | lançamento | 021, 034, 050, 053, 070 | com uma empresa, nenhuma cópia; gatilhos novos |
| — | 079 recuperação manual de convites | (já presente, 17/10) | 073 | só postcheck READ ONLY |
| — | 084 etapas da geração de convites | (já presente, 18/10) | 079 | só postcheck READ ONLY; ausente = recusa |
| 6 | 060 atendimento WhatsApp | este pacote | 031 `empresas`, 013 `usuarios_administrativos`, 043 `memberships` | independe de 061–079 (provado em `ordem-staging-real`) |
| 7 | 065 nome de perfil | este pacote | 060 | |
| 8 | 080 mensagens prontas | este pacote | 060 | |
| 9 | 081 mídia nas prontas | este pacote | 060 + 080 (CHECKs exatos da 080) | |
| 10 | 082 Wall-e | este pacote | 060, 080, 081 (CHECKs exatos da 081), `estabelecimentos(empresa_id,id)` (043) | |
| 11 | 083 WhatsApp por empresa | este pacote | 018 (`whatsapp_conexoes`, índice `…_ambiente_configurada_uk`), 031 | independe de 060–082 |
| 12 | 085 Marketing | este pacote | 031, 043, 054, 062 | staging exigiu 083 e 084 antes (mesma ordem aqui) |
| 13 | 086 automações de Marketing | este pacote | 085 | gatilho novo em `clientes` |

079 e 084, aplicadas antes da 074a, não conflitam: 074a–078 não tocam tabelas de convites e 079/084 não tocam as de
assinatura, clientes, catálogo ou WhatsApp. O postcheck da 079 continua passando depois da 084 (não confere a lista exata de
estados). A ordem 074a→078 e depois 060→086 é a do staging (060/065 também entraram lá depois de 061–079).

## Reaproveitamento do pacote de lançamento (11–13/10)

Continua válido para 074a–078: manifesto `628eb4f6…` com os 18 hashes iguais aos SQL atuais; aplicador, diagnóstico, reparo,
backup e corte inalterados (hashes iguais aos embutidos nos comandos `docs/evidencias/*-comando-*.txt`). O pacote novo chama o
aplicador do lançamento sem alterá-lo, um processo por migration ausente. O que NÃO é reaproveitado como estava: o corte
`cutover-lancamento-production.cjs` (aplicaria o reparo dos bloqueios automaticamente no fim e gravaria um marcador para a
079 já presente); por isso a sequência agora é conduzida por `scripts/migrations-producao-20261019.cjs`, e o reparo ficou fora.

## Pacote

- `docs/MIGRATIONS_PRODUCTION_20261019.json`: manifesto (sha256 `db81ff8e…`), amarrado ao manifesto e ao aplicador do lançamento.
- `scripts/migrations-producao-20261019.cjs`, com estes modos:
  - PLANO, sem conexão;
  - `--conferir`, somente leitura;
  - `--aplicar-autorizado --backup <registro>`;
  - `--retomar-autorizado <id> --backup <registro>`, aceito para 074a–078 e 060/065/080–083/085/086, nunca para 079/084.

  Travas, conferências e transação de cada migration:
  - **Trava de alvo:** serviço, ambiente, host interno exato, banco, porta, TLS e URL sem query.
  - **Identidade vista pelo servidor:** banco, TLS 1.2+, rede privada, PostgreSQL 18, `search_path` padrão e nenhum schema "$user".
  - **Antes de conectar:** interruptores de abertura, atendimento e Marketing desligados; backup do P1 conferido (`conferirBackup` do lançamento); disco persistente montado.
  - **Privilégio:** dono, CREATE e REFERENCES para as migrations ausentes.
  - **Antes da 1ª escrita (e no CONFERIR):**
    - marcadores anteriores de migrations ausentes, deste pacote e do lançamento;
    - prechecks de **todas** as ausentes que só dependem da base atual (074a, 076, 077, 078, 083, 085);
    - antecipações de dados dos postchecks: `kidmais` única e ATIVA (077/078) e as 7 categorias originais (078).
  - **Execução:** trava consultiva; marcador exclusivo por migration; para na primeira falha.
  - **Migrations deste pacote:** precheck externo em READ ONLY, depois `BEGIN` → corpo → `SET TRANSACTION READ ONLY` → postcheck → `COMMIT`.
  - **074a–078:** processo filho do aplicador do lançamento, sem alteração. O marcador próprio `lancamento-<id>` guarda a situação verdadeira, e o postcheck roda de novo em READ ONLY.
  - **Retomada de 074a–078:** renomeia o marcador do lançamento para `.tentativa-<n>`, registrando isso antes de renomear.
  - **CONFERIR também emite:**
    - o md5 da impressão do schema;
    - as contagens de risco: pacotes e fechamentos sem empresa, conexões WhatsApp CONFIGURADAS sem empresa, onboarding em andamento e categorias originais ausentes.
- `scripts/bloco-shell-migracoes-producao-20261019.cjs`: blocos para o Web Shell de produção.
  - **PARTE-1..N:** cada parte tem no máximo 40 KB e só transporta arquivos, com sha conferido, para `.partes/`.
  - **CONFERIR, APLICAR, RETOMAR e LIMPEZA:** blocos curtos. Montam a pasta própria só com todas as partes presentes; caso contrário, dizem qual parte colar.
  - Pasta própria: `/opt/render/project/src/.kidmais-migracoes-producao-20261019`. Nada do deploy é sobrescrito ou removido.
- `scripts/ensaio-migracoes-producao-20261019.cjs` (+ `.dados.sql`): ensaio em PostgreSQL 18 descartável local.
- `docs/MIGRATIONS_PRODUCTION_20261019_RECUPERACAO.md`: gate de prontidão do deploy, pausas, janela, códigos de saída,
  recuperação por cenário e incompatibilidades do código antigo `cf3de338`.

## Sequência operacional proposta (cada passo com autorização própria)

Está em `docs/MIGRATIONS_PRODUCTION_20261019_RECUPERACAO.md` (seções 1–3). Em resumo:
1. gate de prontidão do deploy VERDE;
2. P1;
3. pausas (catálogo, pacotes e adicionais; clientes e fechamento público; onboarding WhatsApp; nenhum deploy ou troca de env);
4. PARTES 1..N e CONFERIR;
5. APLICAR, uma vez;
6. CONFERIR pós-aplicação **antes** de disparar o deploy;
7. deploy LIVE e smoke;
8. fim das pausas.

A agenda não precisa de pausa.

## Limites

- O ensaio local não substitui backup e PITR reais e não prova o comportamento sob tráfego. O `lock_timeout` de 5 s pode abortar uma migration com atividade concorrente; a falha é atômica, e a retomada é explícita e foi ensaiada na 076.
- O reparo dos cinco bloqueios globais continua como pacote separado (decisão de Felipe).
- Evidência local: pacote `pacote-migrations-producao-20261019`, fora do repositório.
