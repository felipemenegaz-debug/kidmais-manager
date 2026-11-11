/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador de PRODUÇÃO da 105: conferência pela DEFINIÇÃO do catálogo das SEIS tabelas (09/11/2026). Complementa
// database/checks/20261029_105_definicoes.sql (hash fixado) onde ele não prova a definição:
//   - NOT NULL VALIDADO: no PG 18 o NOT NULL é a restrição contype 'n' com convalidated; attnotnull fica true mesmo com
//     NOT NULL NOT VALID, e o definicoes.sql lê só attnotnull (e exclui contype 'n' das restrições);
//   - FKs de ENTRADA (confrelid = a tabela) vindas de QUALQUER tabela, inclusive de fora das seis: elas mudam o que pode
//     ser excluído ou atualizado aqui;
//   - validada, adiável, inicialmente adiada, local, sem herança e aplicada (PG 18) de TODAS as restrições;
//   - gatilhos internos pela relação e nome da restrição, função, tipo, outra relação e adiamento (o definicoes.sql só
//     conta os fora do modo O e lista as FKs do lado conrelid);
//   - classe (tipo, persistência, método de acesso, RLS ligada e forçada, identidade de réplica, partição, opções),
//     herança nos dois sentidos, políticas, índices com flags, colunas com tipo e DEFAULT qualificados e a configuração
//     da função da guarda (proconfig, SECURITY DEFINER, STRICT, volatilidade, paralelismo, tipo, LEAKPROOF).
// O SQL é o do B-5 (scripts/conferencia-b5-105.cjs: SQL_RELACAO_105, revisado pelo Astra até a r8) aplicado a cada tabela por
// troca EXATA do literal da relação; a referência de mcp_oauth_concessoes é a RELACAO_105 do B-5, sem cópia. As outras
// cinco foram lidas no PostgreSQL 18.6 descartável (porta 55587; base b14-P11 + 105 em LF; o teste PG confere também no modelo 103) e conferidas à mão
// contra database/migrations/20261027_105_mcp_assinaturas.sql. Regras (pg_rewrite), dono e privilégios continuam no
// definicoes.sql. A comparação devolve só tabela, tipo e categoria (primeira palavra da linha), nunca o texto lido.
// Roda com search_path = pg_catalog, pg_temp (SET_DEPARSE do definicoes): tudo fora de pg_catalog sai qualificado.
const assert = require('node:assert/strict');
const {SQL_RELACAO_105, RELACAO_105} = require('./conferencia-b5-105.cjs');

const LITERAL = "to_regclass('public.mcp_oauth_concessoes')";
const TABELAS = Object.freeze(['mcp_oauth_clientes', 'mcp_oauth_pedidos', 'mcp_oauth_concessoes', 'mcp_oauth_codigos', 'mcp_oauth_tokens', 'mcp_auditoria']);
/** Única versão maior com referência (contype 'n' e conenforced são do PG 18). Outra versão = SEM_REFERENCIA (falha fechada). */
const VERSAO_MAIOR_REFERENCIA = 18;
const LF = String.fromCharCode(10);

/** O miolo de SQL_RELACAO_105 (sem "SELECT " e sem " AS relacao") para uma tabela: troca exata das 7 ocorrências do literal. */
function miolo(tabela) {
  assert.ok(TABELAS.includes(tabela), 'TABELA_FORA_DA_105 ' + tabela);
  assert.ok(SQL_RELACAO_105.startsWith('SELECT (') && SQL_RELACAO_105.endsWith(') AS relacao'), 'SQL_RELACAO_105_FORMA');
  const partes = SQL_RELACAO_105.split(LITERAL);
  assert.equal(partes.length - 1, 7, 'SQL_RELACAO_105_OCORRENCIAS');
  return partes.join("to_regclass('public." + tabela + "')").slice('SELECT '.length, -' AS relacao'.length);
}
/** Um único statement: a versão do servidor e uma coluna de texto por tabela. */
const SQL_RELACOES = 'SELECT current_setting(\'server_version_num\')::int AS versao_pg,' + LF
  + TABELAS.map(t => '  ' + miolo(t) + ' AS ' + t).join(',' + LF);

const REFERENCIAS = Object.freeze({
  mcp_oauth_clientes: [
    'classe r p heap rls f f replica d particao f opcoes -',
    'coluna 001 client_id text -',
    'coluna 002 nome text -',
    'coluna 003 redirect_uris text[] -',
    'coluna 004 valido_ate timestamp with time zone -',
    'coluna 005 atualizado_em timestamp with time zone DEFAULT clock_timestamp()',
    'funcao - f f v u f f',
    'gatilho interno public.mcp_oauth_concessoes mcp_oauth_concessoes_client_id_fkey "RI_FKey_noaction_del" 9 public.mcp_oauth_concessoes f f O',
    'gatilho interno public.mcp_oauth_concessoes mcp_oauth_concessoes_client_id_fkey "RI_FKey_noaction_upd" 17 public.mcp_oauth_concessoes f f O',
    'gatilho interno public.mcp_oauth_pedidos mcp_oauth_pedidos_client_id_fkey "RI_FKey_noaction_del" 9 public.mcp_oauth_pedidos f f O',
    'gatilho interno public.mcp_oauth_pedidos mcp_oauth_pedidos_client_id_fkey "RI_FKey_noaction_upd" 17 public.mcp_oauth_pedidos f f O',
    'heranca 0',
    'indice public.mcp_oauth_clientes_pkey t t f t t t t f CREATE UNIQUE INDEX mcp_oauth_clientes_pkey ON public.mcp_oauth_clientes USING btree (client_id)',
    'politicas 0',
    'restricao public.mcp_oauth_clientes mcp_oauth_clientes_atualizado_em_not_null n t f f t f true NOT NULL atualizado_em',
    'restricao public.mcp_oauth_clientes mcp_oauth_clientes_client_id_check c t f f t f true CHECK (((client_id ~ \'^https://[a-z0-9.-]+/\'::text) AND (length(client_id) <= 500)))',
    'restricao public.mcp_oauth_clientes mcp_oauth_clientes_client_id_not_null n t f f t f true NOT NULL client_id',
    'restricao public.mcp_oauth_clientes mcp_oauth_clientes_nome_check c t f f t f true CHECK (((length(nome) >= 1) AND (length(nome) <= 120)))',
    'restricao public.mcp_oauth_clientes mcp_oauth_clientes_nome_not_null n t f f t f true NOT NULL nome',
    'restricao public.mcp_oauth_clientes mcp_oauth_clientes_pkey p t f f t t true PRIMARY KEY (client_id)',
    'restricao public.mcp_oauth_clientes mcp_oauth_clientes_redirect_uris_check c t f f t f true CHECK (((cardinality(redirect_uris) >= 1) AND (cardinality(redirect_uris) <= 20)))',
    'restricao public.mcp_oauth_clientes mcp_oauth_clientes_redirect_uris_not_null n t f f t f true NOT NULL redirect_uris',
    'restricao public.mcp_oauth_clientes mcp_oauth_clientes_valido_ate_not_null n t f f t f true NOT NULL valido_ate',
    'restricao public.mcp_oauth_concessoes mcp_oauth_concessoes_client_id_fkey f t f f t t true FOREIGN KEY (client_id) REFERENCES public.mcp_oauth_clientes(client_id)',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_client_id_fkey f t f f t t true FOREIGN KEY (client_id) REFERENCES public.mcp_oauth_clientes(client_id)',
  ].join(LF),
  mcp_oauth_pedidos: [
    'classe r p heap rls f f replica d particao f opcoes -',
    'coluna 001 chave_hash text -',
    'coluna 002 client_id text -',
    'coluna 003 cliente_nome text -',
    'coluna 004 redirect_uri text -',
    'coluna 005 state text -',
    'coluna 006 code_challenge text -',
    'coluna 007 escopos text[] -',
    'coluna 008 recurso text -',
    'coluna 009 criado_em timestamp with time zone DEFAULT clock_timestamp()',
    'coluna 010 expira_em timestamp with time zone -',
    'coluna 011 consumido_em timestamp with time zone -',
    'funcao - f f v u f f',
    'gatilho interno public.mcp_oauth_pedidos mcp_oauth_pedidos_client_id_fkey "RI_FKey_check_ins" 5 public.mcp_oauth_clientes f f O',
    'gatilho interno public.mcp_oauth_pedidos mcp_oauth_pedidos_client_id_fkey "RI_FKey_check_upd" 17 public.mcp_oauth_clientes f f O',
    'heranca 0',
    'indice public.mcp_oauth_pedidos_cliente_idx f f f t t t t f CREATE INDEX mcp_oauth_pedidos_cliente_idx ON public.mcp_oauth_pedidos USING btree (client_id, expira_em) WHERE (consumido_em IS NULL)',
    'indice public.mcp_oauth_pedidos_expira_idx f f f t t t t f CREATE INDEX mcp_oauth_pedidos_expira_idx ON public.mcp_oauth_pedidos USING btree (expira_em)',
    'indice public.mcp_oauth_pedidos_pkey t t f t t t t f CREATE UNIQUE INDEX mcp_oauth_pedidos_pkey ON public.mcp_oauth_pedidos USING btree (chave_hash)',
    'politicas 0',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_chave_hash_check c t f f t f true CHECK ((chave_hash ~ \'^[0-9a-f]{64}$\'::text))',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_chave_hash_not_null n t f f t f true NOT NULL chave_hash',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_check c t f f t f true CHECK (((expira_em > criado_em) AND (expira_em <= (criado_em + \'00:15:00\'::interval))))',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_client_id_fkey f t f f t t true FOREIGN KEY (client_id) REFERENCES public.mcp_oauth_clientes(client_id)',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_client_id_not_null n t f f t f true NOT NULL client_id',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_cliente_nome_check c t f f t f true CHECK ((length(cliente_nome) <= 120))',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_cliente_nome_not_null n t f f t f true NOT NULL cliente_nome',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_code_challenge_check c t f f t f true CHECK ((code_challenge ~ \'^[A-Za-z0-9._~-]{43,128}$\'::text))',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_code_challenge_not_null n t f f t f true NOT NULL code_challenge',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_criado_em_not_null n t f f t f true NOT NULL criado_em',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_escopos_check c t f f t f true CHECK ((((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 3)) AND (escopos <@ ARRAY[\'agenda:read\'::text, \'financeiro:read\'::text, \'conhecimento:read\'::text])))',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_escopos_not_null n t f f t f true NOT NULL escopos',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_expira_em_not_null n t f f t f true NOT NULL expira_em',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_pkey p t f f t t true PRIMARY KEY (chave_hash)',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_recurso_check c t f f t f true CHECK ((length(recurso) <= 500))',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_recurso_not_null n t f f t f true NOT NULL recurso',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_redirect_uri_check c t f f t f true CHECK (((redirect_uri ~ \'^https://\'::text) AND (length(redirect_uri) <= 500)))',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_redirect_uri_not_null n t f f t f true NOT NULL redirect_uri',
    'restricao public.mcp_oauth_pedidos mcp_oauth_pedidos_state_check c t f f t f true CHECK (((state IS NULL) OR (length(state) <= 500)))',
  ].join(LF),
  mcp_oauth_concessoes: RELACAO_105,
  mcp_oauth_codigos: [
    'classe r p heap rls f f replica d particao f opcoes -',
    'coluna 001 codigo_hash text -',
    'coluna 002 concessao_id uuid -',
    'coluna 003 redirect_uri text -',
    'coluna 004 code_challenge text -',
    'coluna 005 criado_em timestamp with time zone DEFAULT clock_timestamp()',
    'coluna 006 expira_em timestamp with time zone -',
    'coluna 007 usado_em timestamp with time zone -',
    'funcao - f f v u f f',
    'gatilho interno public.mcp_oauth_codigos mcp_oauth_codigos_concessao_id_fkey "RI_FKey_check_ins" 5 public.mcp_oauth_concessoes f f O',
    'gatilho interno public.mcp_oauth_codigos mcp_oauth_codigos_concessao_id_fkey "RI_FKey_check_upd" 17 public.mcp_oauth_concessoes f f O',
    'heranca 0',
    'indice public.mcp_oauth_codigos_concessao_idx f f f t t t t f CREATE INDEX mcp_oauth_codigos_concessao_idx ON public.mcp_oauth_codigos USING btree (concessao_id)',
    'indice public.mcp_oauth_codigos_expira_idx f f f t t t t f CREATE INDEX mcp_oauth_codigos_expira_idx ON public.mcp_oauth_codigos USING btree (expira_em)',
    'indice public.mcp_oauth_codigos_pkey t t f t t t t f CREATE UNIQUE INDEX mcp_oauth_codigos_pkey ON public.mcp_oauth_codigos USING btree (codigo_hash)',
    'politicas 0',
    'restricao public.mcp_oauth_codigos mcp_oauth_codigos_check c t f f t f true CHECK (((expira_em > criado_em) AND (expira_em <= (criado_em + \'00:10:00\'::interval))))',
    'restricao public.mcp_oauth_codigos mcp_oauth_codigos_code_challenge_check c t f f t f true CHECK ((code_challenge ~ \'^[A-Za-z0-9._~-]{43,128}$\'::text))',
    'restricao public.mcp_oauth_codigos mcp_oauth_codigos_code_challenge_not_null n t f f t f true NOT NULL code_challenge',
    'restricao public.mcp_oauth_codigos mcp_oauth_codigos_codigo_hash_check c t f f t f true CHECK ((codigo_hash ~ \'^[0-9a-f]{64}$\'::text))',
    'restricao public.mcp_oauth_codigos mcp_oauth_codigos_codigo_hash_not_null n t f f t f true NOT NULL codigo_hash',
    'restricao public.mcp_oauth_codigos mcp_oauth_codigos_concessao_id_fkey f t f f t t true FOREIGN KEY (concessao_id) REFERENCES public.mcp_oauth_concessoes(id)',
    'restricao public.mcp_oauth_codigos mcp_oauth_codigos_concessao_id_not_null n t f f t f true NOT NULL concessao_id',
    'restricao public.mcp_oauth_codigos mcp_oauth_codigos_criado_em_not_null n t f f t f true NOT NULL criado_em',
    'restricao public.mcp_oauth_codigos mcp_oauth_codigos_expira_em_not_null n t f f t f true NOT NULL expira_em',
    'restricao public.mcp_oauth_codigos mcp_oauth_codigos_pkey p t f f t t true PRIMARY KEY (codigo_hash)',
    'restricao public.mcp_oauth_codigos mcp_oauth_codigos_redirect_uri_check c t f f t f true CHECK ((length(redirect_uri) <= 500))',
    'restricao public.mcp_oauth_codigos mcp_oauth_codigos_redirect_uri_not_null n t f f t f true NOT NULL redirect_uri',
  ].join(LF),
  mcp_oauth_tokens: [
    'classe r p heap rls f f replica d particao f opcoes -',
    'coluna 001 id uuid DEFAULT public.gen_random_uuid()',
    'coluna 002 concessao_id uuid -',
    'coluna 003 tipo text -',
    'coluna 004 token_hash text -',
    'coluna 005 escopos text[] -',
    'coluna 006 criado_em timestamp with time zone DEFAULT clock_timestamp()',
    'coluna 007 expira_em timestamp with time zone -',
    'coluna 008 revogado_em timestamp with time zone -',
    'funcao - f f v u f f',
    'gatilho interno public.mcp_oauth_tokens mcp_oauth_tokens_concessao_id_fkey "RI_FKey_check_ins" 5 public.mcp_oauth_concessoes f f O',
    'gatilho interno public.mcp_oauth_tokens mcp_oauth_tokens_concessao_id_fkey "RI_FKey_check_upd" 17 public.mcp_oauth_concessoes f f O',
    'heranca 0',
    'indice public.mcp_oauth_tokens_concessao_idx f f f t t t t f CREATE INDEX mcp_oauth_tokens_concessao_idx ON public.mcp_oauth_tokens USING btree (concessao_id) WHERE (revogado_em IS NULL)',
    'indice public.mcp_oauth_tokens_expira_idx f f f t t t t f CREATE INDEX mcp_oauth_tokens_expira_idx ON public.mcp_oauth_tokens USING btree (expira_em)',
    'indice public.mcp_oauth_tokens_pkey t t f t t t t f CREATE UNIQUE INDEX mcp_oauth_tokens_pkey ON public.mcp_oauth_tokens USING btree (id)',
    'indice public.mcp_oauth_tokens_token_hash_key t f f t t t t f CREATE UNIQUE INDEX mcp_oauth_tokens_token_hash_key ON public.mcp_oauth_tokens USING btree (token_hash)',
    'politicas 0',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_check c t f f t f true CHECK ((expira_em > criado_em))',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_check1 c t f f t f true CHECK (((tipo <> \'ACESSO\'::text) OR (expira_em <= (criado_em + \'02:00:00\'::interval))))',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_check2 c t f f t f true CHECK (((tipo <> \'ATUALIZACAO\'::text) OR (expira_em <= (criado_em + \'31 days\'::interval))))',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_concessao_id_fkey f t f f t t true FOREIGN KEY (concessao_id) REFERENCES public.mcp_oauth_concessoes(id)',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_concessao_id_not_null n t f f t f true NOT NULL concessao_id',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_criado_em_not_null n t f f t f true NOT NULL criado_em',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_escopos_check c t f f t f true CHECK ((((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 3)) AND (escopos <@ ARRAY[\'agenda:read\'::text, \'financeiro:read\'::text, \'conhecimento:read\'::text])))',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_escopos_not_null n t f f t f true NOT NULL escopos',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_expira_em_not_null n t f f t f true NOT NULL expira_em',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_id_not_null n t f f t f true NOT NULL id',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_pkey p t f f t t true PRIMARY KEY (id)',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_tipo_check c t f f t f true CHECK ((tipo = ANY (ARRAY[\'ACESSO\'::text, \'ATUALIZACAO\'::text])))',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_tipo_not_null n t f f t f true NOT NULL tipo',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_token_hash_check c t f f t f true CHECK ((token_hash ~ \'^[0-9a-f]{64}$\'::text))',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_token_hash_key u t f f t t true UNIQUE (token_hash)',
    'restricao public.mcp_oauth_tokens mcp_oauth_tokens_token_hash_not_null n t f f t f true NOT NULL token_hash',
  ].join(LF),
  mcp_auditoria: [
    'classe r p heap rls f f replica d particao f opcoes -',
    'coluna 001 id bigint -',
    'coluna 002 ocorrido_em timestamp with time zone DEFAULT clock_timestamp()',
    'coluna 003 evento text -',
    'coluna 004 resultado text -',
    'coluna 005 codigo text -',
    'coluna 006 concessao_id uuid -',
    'coluna 007 usuario_id uuid -',
    'coluna 008 empresa_id uuid -',
    'coluna 009 client_id text -',
    'coluna 010 capacidade text -',
    'coluna 011 itens integer -',
    'coluna 012 duracao_ms integer -',
    'funcao - f f v u f f',
    'heranca 0',
    'indice public.mcp_auditoria_empresa_idx f f f t t t t f CREATE INDEX mcp_auditoria_empresa_idx ON public.mcp_auditoria USING btree (empresa_id, ocorrido_em DESC) WHERE (empresa_id IS NOT NULL)',
    'indice public.mcp_auditoria_ocorrido_idx f f f t t t t f CREATE INDEX mcp_auditoria_ocorrido_idx ON public.mcp_auditoria USING btree (ocorrido_em)',
    'indice public.mcp_auditoria_pkey t t f t t t t f CREATE UNIQUE INDEX mcp_auditoria_pkey ON public.mcp_auditoria USING btree (id)',
    'politicas 0',
    'restricao public.mcp_auditoria mcp_auditoria_capacidade_check c t f f t f true CHECK (((capacidade IS NULL) OR (capacidade ~ \'^[a-z_]{1,64}$\'::text)))',
    'restricao public.mcp_auditoria mcp_auditoria_client_id_check c t f f t f true CHECK (((client_id IS NULL) OR (length(client_id) <= 500)))',
    'restricao public.mcp_auditoria mcp_auditoria_codigo_check c t f f t f true CHECK ((codigo ~ \'^[A-Za-z0-9_:,]{1,80}$\'::text))',
    'restricao public.mcp_auditoria mcp_auditoria_codigo_not_null n t f f t f true NOT NULL codigo',
    'restricao public.mcp_auditoria mcp_auditoria_duracao_ms_check c t f f t f true CHECK (((duracao_ms IS NULL) OR ((duracao_ms >= 0) AND (duracao_ms <= 600000))))',
    'restricao public.mcp_auditoria mcp_auditoria_evento_check c t f f t f true CHECK ((evento = ANY (ARRAY[\'PEDIDO_RECEBIDO\'::text, \'PEDIDO_RECUSADO\'::text, \'AUTORIZACAO_CONCEDIDA\'::text, \'AUTORIZACAO_NEGADA\'::text, \'TOKEN_EMITIDO\'::text, \'TOKEN_RENOVADO\'::text, \'TOKEN_RECUSADO\'::text, \'REUSO_DETECTADO\'::text, \'REVOGACAO\'::text, \'FERRAMENTA\'::text])))',
    'restricao public.mcp_auditoria mcp_auditoria_evento_not_null n t f f t f true NOT NULL evento',
    'restricao public.mcp_auditoria mcp_auditoria_id_not_null n t f f t f true NOT NULL id',
    'restricao public.mcp_auditoria mcp_auditoria_itens_check c t f f t f true CHECK (((itens IS NULL) OR ((itens >= 0) AND (itens <= 10000))))',
    'restricao public.mcp_auditoria mcp_auditoria_ocorrido_em_not_null n t f f t f true NOT NULL ocorrido_em',
    'restricao public.mcp_auditoria mcp_auditoria_pkey p t f f t t true PRIMARY KEY (id)',
    'restricao public.mcp_auditoria mcp_auditoria_resultado_check c t f f t f true CHECK ((resultado ~ \'^[A-Z_]{1,24}$\'::text))',
    'restricao public.mcp_auditoria mcp_auditoria_resultado_not_null n t f f t f true NOT NULL resultado',
  ].join(LF),
});

/**
 * A única forma alternativa aceita: o DEFAULT das chaves uuid resolve para public.gen_random_uuid() (pgcrypto em public,
 * como nos modelos) ou para pg_catalog.gen_random_uuid() (sem qualificação com search_path = pg_catalog). Qual das duas é
 * legítima é decidido no definicoes.sql (uuid_publico: ausente ou o pgcrypto GENUÍNO; senão INCOERENTE), na mesma fotografia.
 */
const ALTERNATIVAS = Object.freeze({
  mcp_oauth_concessoes: Object.freeze({'coluna 001 id uuid DEFAULT gen_random_uuid()': 'coluna 001 id uuid DEFAULT public.gen_random_uuid()'}),
  mcp_oauth_tokens: Object.freeze({'coluna 001 id uuid DEFAULT gen_random_uuid()': 'coluna 001 id uuid DEFAULT public.gen_random_uuid()'}),
});
/**
 * Categorias fixas que o SQL gera no início de cada registro. Um nome ou uma expressão do catálogo pode conter LF e
 * produzir uma "linha" cujo primeiro token vem do banco (Astra r1, P2-1): fora desta lista, o rótulo é fixo (ILEGIVEL),
 * nunca o fragmento lido. A comparação exata por multiconjunto não muda.
 */
const CATEGORIAS = Object.freeze(['classe', 'heranca', 'politicas', 'restricao', 'indice', 'gatilho', 'coluna', 'funcao']);
const categoria = l => { const c = l.split(' ', 1)[0]; return CATEGORIAS.includes(c) ? c : 'ILEGIVEL'; };
/** Multiconjunto: linha → quantas vezes. */
function contar(linhas) { const m = new Map(); for (const l of linhas) m.set(l, (m.get(l) ?? 0) + 1); return m; }

/**
 * Compara a linha lida com as referências. Saída sem texto do banco: {integra, versaoPg, tabelas: {t: {lidas, esperadas}},
 * divergencias: ['<tabela> FALTA|SOBRA|ILEGIVEL <categoria>' | 'SEM_REFERENCIA_PG <maior>' ...]}.
 */
function compararRelacoes(linha) {
  const divergencias = [], tabelas = {};
  const versaoPg = Number.isInteger(linha?.versao_pg) ? linha.versao_pg : null;
  if (versaoPg === null) divergencias.push('VERSAO_PG ILEGIVEL');
  else if (Math.floor(versaoPg / 10000) !== VERSAO_MAIOR_REFERENCIA) divergencias.push('SEM_REFERENCIA_PG ' + Math.floor(versaoPg / 10000));
  for (const t of TABELAS) {
    const ref = REFERENCIAS[t].split(LF);
    const lido = linha?.[t];
    if (typeof lido !== 'string') { divergencias.push(t + ' ILEGIVEL'); tabelas[t] = {lidas: null, esperadas: ref.length}; continue; }
    const linhas = lido.split(LF).map(l => (Object.hasOwn(ALTERNATIVAS[t] ?? {}, l) ? ALTERNATIVAS[t][l] : l));
    tabelas[t] = {lidas: linhas.length, esperadas: ref.length};
    const a = contar(ref), b = contar(linhas);
    const tipos = new Set();
    for (const [l, n] of a) if ((b.get(l) ?? 0) < n) tipos.add(t + ' FALTA ' + categoria(l));
    for (const [l, n] of b) if ((a.get(l) ?? 0) < n) tipos.add(t + ' SOBRA ' + categoria(l));
    divergencias.push(...[...tipos].sort());
  }
  return {integra: divergencias.length === 0, versaoPg, tabelas, divergencias};
}

module.exports = {TABELAS, VERSAO_MAIOR_REFERENCIA, SQL_RELACOES, REFERENCIAS, ALTERNATIVAS, CATEGORIAS, miolo, compararRelacoes};
