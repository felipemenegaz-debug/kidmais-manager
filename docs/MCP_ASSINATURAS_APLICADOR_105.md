# Aplicador da migration 105 (canal MCP) em staging

> **ESTADO ATUAL (28/10/2026, vale sobre os blocos datados abaixo, que são histórico):**
> - **Staging:** código do canal LIVE (até a #261, `a18677cb`); migration **105 APLICADA** (integridade PASS); canal
>   ligado só para a empresa de teste (`MCP_TENANT_ALLOWLIST`).
> - **Conexão real:** ChatGPT e Claude conectados de verdade por CIMD; 4 perguntas-roteiro, Desconectar e renovação depois
>   de 1 h aprovados (MCP_ASSINATURAS_V1.md §20). Ressalvas da revisão do Astra de 28/10: isolamento e "zero dados pessoais" só com a base vazia;
>   a recusa da empresa fora do piloto foi vista na tela, mas o POST 403 real não foi feito.
> - **Revisão do Astra de 28/10:** "resultado de staging aprovado; produção pode ser planejada". **Não é GO para
>   produção.**
> - **Produção:** nada aplicado nem ligado. Pede aplicador 105 próprio + PITR, candidata validada no Node 22.23.2, env
>   própria, monitoramento/desligamento e as decisões D3/RET-1/D-EXP (lista em MCP_ASSINATURAS_V1.md §21).

Histórico: preparado em 27/10/2026, **LOCAL e sem commit** (PostgreSQL descartável aprovado); depois mergeado (#256) e **executado em staging** (APLICADA_POSTCHECK_PASS, depois JA_APLICADA_INTEGRIDADE_PASS). **É de staging: não serve para produção**, na branch `codex/aplicador-105-staging-20261027` sobre o staging `dfb872a8`. Nada foi executado em staging. Mesmo desenho dos aplicadores da 092–094, 100 e 102/103.

A 105 é aplicada **sozinha**. O aplicador conjunto da 104/106 (outra sessão, `Plano aplicador 104 106 staging 20261027`) deixa a 105 de fora de propósito (decisão D2 daquele plano). As três são independentes entre si.

## Peças

| Arquivo | Papel |
|---|---|
| `database/checks/20261027_105_integridade.sql` | **Novo.** Integridade só de catálogo e **repetível** (o postcheck exige tabelas vazias e só vale logo após a aplicação). Confere: 6 tabelas com o número exato de colunas e de restrições CHECK/PK/UNIQUE/FK (sem NOT NULL, que o PG 18 guarda como restrição); 11 índices nomeados, `mcp_oauth_concessoes_ativa_uk` único e parcial; corpo da função de gatilho por sha256 do `prosrc`; gatilho BEFORE UPDATE FOR EACH ROW habilitado. Devolve `integra_105`. |
| `scripts/migration-105-comum.cjs` | Núcleo: estado, plano, conferência, aplicação e marcador. |
| `scripts/migration-105-staging.cjs` | Alvo fixo de staging (serviço, host, banco, porta, TLS de `conexao-staging.cjs`); marcador em `data/mcp-105-staging`. |
| `scripts/bloco-shell-105.cjs` | Blocos CONFERIR e APLICAR para o Web Shell (ASCII, ≤ 32 KB, `bind` antes da guarda, corpo em subshell, sha256 dos 8 arquivos implantados). |
| `scripts/migration-105.test.cjs` | 12 testes com cliente simulado (no CI). |
| `scripts/bloco-shell-105.test.cjs` | 10 testes com colagem real em bash e `bash -i` (no CI). |
| `lib/integracoes/oauth/aplicador-105.postgres.test.ts` | Aplicador REAL em PostgreSQL descartável, modelos 103 e 104 (**preparado, não executado**: pede autorização de cluster). |
| `.github/workflows/ci.yml`, `scripts/regressao-v1-selecao.cjs` | Dois passos novos no CI; suíte PG no seletor. |

## Lógica

- **Modos:**
  - sem argumentos: plano, sem conexão;
  - `--conferir-105`: somente leitura;
  - `--aplicar-105-autorizado --backup "<registro>"`: uma vez, com marcador exclusivo.
- **Estado, só pelo catálogo**, sem ler dados antes do plano:
  - 105 `ausente`: nenhum objeto;
  - `completa`: 6 tabelas, a função e o gatilho;
  - `parcial`: qualquer outra combinação, que recusa (`APLICACAO_PARCIAL_105`).
- **Privilégios**, como `current_user`, porque o Render entra com `SET role`:
  - sempre: USAGE em public;
  - com a 105 pendente: CREATE em public, REFERENCES em `usuarios_administrativos` e `empresas`, USAGE em plpgsql e EXECUTE em `gen_random_uuid()`;
  - com a 105 completa: SELECT nas 6 tabelas, para as contagens.
  - Cada falta gera uma recusa nomeada.
- **Aplicação**, nesta ordem:
  1. precheck (READ ONLY);
  2. migration **sem o COMMIT final**, com postcheck e integridade **dentro da mesma transação**;
  3. COMMIT só com tudo PASS;
  4. estado relido (`completa`);
  5. integridade (READ ONLY).
- **Situação do COMMIT:** `NAO_COMMITADA`, `CONFIRMADO`, `DESFEITA_PELO_SERVIDOR` ou `INDETERMINADO` (40003, classes 08/57/58/XX ou sem SQLSTATE). O resultado fica registrado no marcador.
- **Sem trava de versão do PostgreSQL:** a integridade usa contagens e `prosrc`, não o deparse da versão.
- **Saída:** nomes de etapas, booleanos, a versão do servidor e contagens (clientes, concessões, ativas, tokens, auditoria). Sem ids, tokens ou URL.
- **Nunca executa:** down, env (inclusive `MCP_ENABLED`), deploy, restart, escrita nas tabelas `mcp_*`.
- **Códigos:** 0 (plano, pronta, aplicada ou já aplicada); 1 (recusa antes de conectar); 2 (FALHA registrada); 3 (conferência RECUSARIA). O bloco usa 4 para as recusas dele.

## Ordem operacional (cada passo com autorização própria)

1. PR deste aplicador → CI verde → merge e deploy em staging, por Felipe. Gerar os blocos da árvore implantada (`node scripts/bloco-shell-105.cjs staging CONFERIR <commit>`) e conferir os sha256.
2. **CONFERIR** (somente leitura). Esperado: `PRONTA_PARA_APLICAR`.
3. Ponto de recuperação **PITR** comprovado e registrado (referência e horário).
4. Autorização de Felipe **específica da 105 em staging**.
5. Janela sem DDL concorrente. As FKs pegam SHARE ROW EXCLUSIVE em `usuarios_administrativos` e `empresas` durante a transação, então escritas nessas tabelas esperam no máximo 5 s.
6. CONFERIR → **APLICAR** → CONFERIR (esperado `JA_APLICADA_INTEGRIDADE_PASS`).
7. **Aplicar a 105 não liga o canal.** Ligar (`MCP_ENABLED`, `MCP_TENANT_ALLOWLIST`, `MCP_PUBLIC_URL`, `MCP_REF_SECRET`) é outro passo, com autorização própria.

**Recuperação:**
- `database/rollback/20261027_105_mcp_assinaturas_down.sql`, com autorização própria. Recusa se houver concessão ou auditoria; depois de uso real, desliga-se o canal por flag, sem apagar nada.
- Em último caso, PITR ao ponto registrado.

## Validação local (27/10/2026)

- `scripts/migration-105.test.cjs`: 12/12. `scripts/bloco-shell-105.test.cjs`: 10/10.
- `tsc` e lint sem erros. CI local completo: ver a nota do vault.
- **PostgreSQL (27/10/2026, cluster descartável autorizado, `127.0.0.1:55692`, removido):** `aplicador-105.postgres.test.ts` aprovado nos estados **103** (staging de hoje) e **104** (com a 104 da S-E), em **3 execuções seguidas**. Cobre: conferência PRONTA sem mudar nada; 105 parcial recusada; papel mínimo não superusuário, com cada privilégio retirado isoladamente gerando a recusa nomeada; aplicação; integridade PASS no catálogo real; marcador anti-repetição; deriva (corpo da função, índice removido, gatilho desabilitado, coluna extra) recusada; down restaurando a impressão inicial; falha real por trava em `empresas` (NAO_COMMITADA, nada criado) e retomada. Relatórios em `ambientes-locais/pg-descartavel-aplicador-105-20261027-relatorios`.
