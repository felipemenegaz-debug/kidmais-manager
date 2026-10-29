// Inventário ESPERADO das definições da 105 e comparação com o que o catálogo devolve
// (database/checks/20261029_105_definicoes.sql). Plano MCP produção pré-requisitos, rev. 3, P1 (P2-3 do Astra): a
// integridade passa a comparar DEFINIÇÕES, não só nomes e contagens. Um mutante que preserva nomes e contagens (predicado
// do índice invertido, CHECK afrouxado, FK com ON DELETE CASCADE, corpo do gatilho trocado) muda a linha do objeto.
//   - comparação EXATA, sem faltar nem sobrar; nenhum texto do catálogo é executado;
//   - deparse com `search_path = pg_catalog, pg_temp` e `IntervalStyle = postgres` (fixados por `lerDefinicoes`);
//   - única alternativa aceita: o DEFAULT das chaves uuid pode resolver para gen_random_uuid() do pg_catalog ou para
//     public.gen_random_uuid() (a migration roda com search_path = public, pg_catalog). A forma qualificada só vale se
//     public.gen_random_uuid() for a função GENUÍNA do pgcrypto (linha uuid_publico; revisão do Astra, rodada 1, P2-2):
//     um homônimo qualquer (wrapper que devolve UUID constante) diverge, e DEFAULT qualificado sem o pgcrypto é INCOERENTE;
//   - gatilhos das FKs pelo tgconstraint, nos dois lados, com função, tgtype e modo (rodada 1, P2-1): O→R, desabilitado
//     ou CASCADE mudam a linha da FK;
//   - a FORMA do deparse foi escrita a partir das regras do ruleutils e CONFIRMADA no PostgreSQL 18.6 descartável
//     (29/10/2026); outra versão pode diferir: a conferência dá DIVERGENTE e a aplicação desfaz antes do COMMIT.
// Saída da comparação: só chaves (nomes de objetos da 105) e o tipo da diferença; nenhum dado de tabela.
const T = (...linhas) => linhas.join('');
const SQL_ARQUIVO = 'database/checks/20261029_105_definicoes.sql';

const TABELA = 'tipo=r|persistencia=p|opcoes=|tipada=false|particao=false|replica=d|heranca=0|rls=false|forcar_rls=false|politicas=0|regras=0|dono_da_aplicacao=true';
const col = (n, tipo, nulo, def = '', identidade = '') => `${n}|${tipo}|${nulo ? 'NULL' : 'NOT NULL'}|default=${def}|identidade=${identidade}|gerada=|collation=`;
const CLOCK = 'clock_timestamp()';
const UUID = Object.freeze(['gen_random_uuid()', 'public.gen_random_uuid()']);
const TZ = 'timestamp with time zone';
const restr = (tipo, def) => `${tipo}|${def}|validada=true|aplicada=true`;
const chk = def => restr('c', `CHECK (${def})`);
const fk = (colunas, ref) => restr('f', `FOREIGN KEY (${colunas}) REFERENCES public.${ref}`);
const pk = colunas => restr('p', `PRIMARY KEY (${colunas})`);
const FLAGS = (unico, primario) => `unico=${unico}|primario=${primario}|valido=true|pronto=true|vivo=true|imediato=true|nulos_iguais=false`;
const idx = (nome, tabela, corpo, {unico = false, primario = false} = {}) =>
  `CREATE ${unico ? 'UNIQUE ' : ''}INDEX ${nome} ON public.${tabela} USING btree ${corpo}|${FLAGS(unico, primario)}`;
const ESCOPOS = T("(((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 3)) AND ",
  "(escopos <@ ARRAY['agenda:read'::text, 'financeiro:read'::text, 'conhecimento:read'::text]))");
const HASH = c => `(${c} ~ '^[0-9a-f]{64}$'::text)`;
const DESAFIO = "(code_challenge ~ '^[A-Za-z0-9._~-]{43,128}$'::text)";
const REDIRECT_HTTPS = "((redirect_uri ~ '^https://'::text) AND (length(redirect_uri) <= 500))";
const EVENTOS = ['PEDIDO_RECEBIDO', 'PEDIDO_RECUSADO', 'AUTORIZACAO_CONCEDIDA', 'AUTORIZACAO_NEGADA', 'TOKEN_EMITIDO', 'TOKEN_RENOVADO',
  'TOKEN_RECUSADO', 'REUSO_DETECTADO', 'REVOGACAO', 'FERRAMENTA'];
const lista = v => `ARRAY[${v.map(x => `'${x}'::text`).join(', ')}]`;
/**
 * Gatilhos internos de uma FK (tgconstraint), na ordem "C" do SQL: os dois de verificação na tabela que referencia
 * (AFTER ROW INSERT = 5, AFTER ROW UPDATE = 17) e os dois de NO ACTION na referenciada (DELETE = 9, UPDATE = 17), modo O.
 */
const gatilhosFk = (tabela, referenciada) => [`public.${referenciada}:RI_FKey_noaction_del:9:O`, `public.${referenciada}:RI_FKey_noaction_upd:17:O`,
  `public.${tabela}:RI_FKey_check_ins:5:O`, `public.${tabela}:RI_FKey_check_upd:17:O`].sort().join(',');
const FKS = Object.freeze([['mcp_oauth_pedidos', 'mcp_oauth_pedidos_client_id_fkey', 'mcp_oauth_clientes'],
  ['mcp_oauth_concessoes', 'mcp_oauth_concessoes_usuario_id_fkey', 'usuarios_administrativos'],
  ['mcp_oauth_concessoes', 'mcp_oauth_concessoes_empresa_id_fkey', 'empresas'],
  ['mcp_oauth_concessoes', 'mcp_oauth_concessoes_client_id_fkey', 'mcp_oauth_clientes'],
  ['mcp_oauth_concessoes', 'mcp_oauth_concessoes_revogada_por_fkey', 'usuarios_administrativos'],
  ['mcp_oauth_codigos', 'mcp_oauth_codigos_concessao_id_fkey', 'mcp_oauth_concessoes'],
  ['mcp_oauth_tokens', 'mcp_oauth_tokens_concessao_id_fkey', 'mcp_oauth_concessoes']]);
/** public.gen_random_uuid() GENUÍNA do pgcrypto (pgcrypto--1.x: LANGUAGE C, 'MODULE_PATHNAME', 'pg_random_uuid'). */
const UUID_PGCRYPTO = 'extensao=pgcrypto|linguagem=c|simbolo=pg_random_uuid|biblioteca=$libdir/pgcrypto|retorno=uuid|volatil=v';
const COLUNAS_UUID = Object.freeze(['coluna:mcp_oauth_concessoes.id', 'coluna:mcp_oauth_tokens.id']);

/** chave → definição esperada (string) ou lista de alternativas aceitas. */
const ESPERADO = Object.freeze({
  'tabela:mcp_oauth_clientes': TABELA, 'tabela:mcp_oauth_pedidos': TABELA, 'tabela:mcp_oauth_concessoes': TABELA,
  'tabela:mcp_oauth_codigos': TABELA, 'tabela:mcp_oauth_tokens': TABELA, 'tabela:mcp_auditoria': TABELA,

  'coluna:mcp_oauth_clientes.client_id': col(1, 'text'), 'coluna:mcp_oauth_clientes.nome': col(2, 'text'),
  'coluna:mcp_oauth_clientes.redirect_uris': col(3, 'text[]'), 'coluna:mcp_oauth_clientes.valido_ate': col(4, TZ),
  'coluna:mcp_oauth_clientes.atualizado_em': col(5, TZ, false, CLOCK),
  'restricao:mcp_oauth_clientes.mcp_oauth_clientes_pkey': pk('client_id'),
  'restricao:mcp_oauth_clientes.mcp_oauth_clientes_client_id_check': chk("((client_id ~ '^https://[a-z0-9.-]+/'::text) AND (length(client_id) <= 500))"),
  'restricao:mcp_oauth_clientes.mcp_oauth_clientes_nome_check': chk('((length(nome) >= 1) AND (length(nome) <= 120))'),
  'restricao:mcp_oauth_clientes.mcp_oauth_clientes_redirect_uris_check': chk('((cardinality(redirect_uris) >= 1) AND (cardinality(redirect_uris) <= 20))'),
  'indice:mcp_oauth_clientes.mcp_oauth_clientes_pkey': idx('mcp_oauth_clientes_pkey', 'mcp_oauth_clientes', '(client_id)', {unico: true, primario: true}),
  'gatilhos_internos:mcp_oauth_clientes': 'fora_do_modo_O=0',

  'coluna:mcp_oauth_pedidos.chave_hash': col(1, 'text'), 'coluna:mcp_oauth_pedidos.client_id': col(2, 'text'),
  'coluna:mcp_oauth_pedidos.cliente_nome': col(3, 'text'), 'coluna:mcp_oauth_pedidos.redirect_uri': col(4, 'text'),
  'coluna:mcp_oauth_pedidos.state': col(5, 'text', true), 'coluna:mcp_oauth_pedidos.code_challenge': col(6, 'text'),
  'coluna:mcp_oauth_pedidos.escopos': col(7, 'text[]'), 'coluna:mcp_oauth_pedidos.recurso': col(8, 'text'),
  'coluna:mcp_oauth_pedidos.criado_em': col(9, TZ, false, CLOCK), 'coluna:mcp_oauth_pedidos.expira_em': col(10, TZ),
  'coluna:mcp_oauth_pedidos.consumido_em': col(11, TZ, true),
  'restricao:mcp_oauth_pedidos.mcp_oauth_pedidos_pkey': pk('chave_hash'),
  'restricao:mcp_oauth_pedidos.mcp_oauth_pedidos_chave_hash_check': chk(HASH('chave_hash')),
  'restricao:mcp_oauth_pedidos.mcp_oauth_pedidos_client_id_fkey': fk('client_id', 'mcp_oauth_clientes(client_id)'),
  'restricao:mcp_oauth_pedidos.mcp_oauth_pedidos_cliente_nome_check': chk('(length(cliente_nome) <= 120)'),
  'restricao:mcp_oauth_pedidos.mcp_oauth_pedidos_redirect_uri_check': chk(REDIRECT_HTTPS),
  'restricao:mcp_oauth_pedidos.mcp_oauth_pedidos_state_check': chk('((state IS NULL) OR (length(state) <= 500))'),
  'restricao:mcp_oauth_pedidos.mcp_oauth_pedidos_code_challenge_check': chk(DESAFIO),
  'restricao:mcp_oauth_pedidos.mcp_oauth_pedidos_escopos_check': chk(ESCOPOS),
  'restricao:mcp_oauth_pedidos.mcp_oauth_pedidos_recurso_check': chk('(length(recurso) <= 500)'),
  'restricao:mcp_oauth_pedidos.mcp_oauth_pedidos_check': chk("((expira_em > criado_em) AND (expira_em <= (criado_em + '00:15:00'::interval)))"),
  'indice:mcp_oauth_pedidos.mcp_oauth_pedidos_pkey': idx('mcp_oauth_pedidos_pkey', 'mcp_oauth_pedidos', '(chave_hash)', {unico: true, primario: true}),
  'indice:mcp_oauth_pedidos.mcp_oauth_pedidos_expira_idx': idx('mcp_oauth_pedidos_expira_idx', 'mcp_oauth_pedidos', '(expira_em)'),
  'indice:mcp_oauth_pedidos.mcp_oauth_pedidos_cliente_idx': idx('mcp_oauth_pedidos_cliente_idx', 'mcp_oauth_pedidos', '(client_id, expira_em) WHERE (consumido_em IS NULL)'),
  'gatilhos_internos:mcp_oauth_pedidos': 'fora_do_modo_O=0',

  'coluna:mcp_oauth_concessoes.id': UUID.map(d => col(1, 'uuid', false, d)), 'coluna:mcp_oauth_concessoes.usuario_id': col(2, 'uuid'),
  'coluna:mcp_oauth_concessoes.empresa_id': col(3, 'uuid'), 'coluna:mcp_oauth_concessoes.client_id': col(4, 'text'),
  'coluna:mcp_oauth_concessoes.cliente_nome': col(5, 'text'), 'coluna:mcp_oauth_concessoes.redirect_uri': col(6, 'text'),
  'coluna:mcp_oauth_concessoes.escopos': col(7, 'text[]'), 'coluna:mcp_oauth_concessoes.recurso': col(8, 'text'),
  'coluna:mcp_oauth_concessoes.criada_em': col(9, TZ, false, CLOCK), 'coluna:mcp_oauth_concessoes.ultimo_uso_em': col(10, TZ, true),
  'coluna:mcp_oauth_concessoes.ultima_ferramenta_em': col(11, TZ, true), 'coluna:mcp_oauth_concessoes.revogada_em': col(12, TZ, true),
  'coluna:mcp_oauth_concessoes.revogada_por': col(13, 'uuid', true), 'coluna:mcp_oauth_concessoes.motivo_revogacao': col(14, 'text', true),
  'restricao:mcp_oauth_concessoes.mcp_oauth_concessoes_pkey': pk('id'),
  'restricao:mcp_oauth_concessoes.mcp_oauth_concessoes_usuario_id_fkey': fk('usuario_id', 'usuarios_administrativos(id)'),
  'restricao:mcp_oauth_concessoes.mcp_oauth_concessoes_empresa_id_fkey': fk('empresa_id', 'empresas(id)'),
  'restricao:mcp_oauth_concessoes.mcp_oauth_concessoes_client_id_fkey': fk('client_id', 'mcp_oauth_clientes(client_id)'),
  'restricao:mcp_oauth_concessoes.mcp_oauth_concessoes_cliente_nome_check': chk('(length(cliente_nome) <= 120)'),
  'restricao:mcp_oauth_concessoes.mcp_oauth_concessoes_redirect_uri_check': chk(REDIRECT_HTTPS),
  'restricao:mcp_oauth_concessoes.mcp_oauth_concessoes_escopos_check': chk(ESCOPOS),
  'restricao:mcp_oauth_concessoes.mcp_oauth_concessoes_recurso_check': chk('(length(recurso) <= 500)'),
  'restricao:mcp_oauth_concessoes.mcp_oauth_concessoes_revogada_por_fkey': fk('revogada_por', 'usuarios_administrativos(id)'),
  'restricao:mcp_oauth_concessoes.mcp_oauth_concessoes_motivo_revogacao_check': chk(`(motivo_revogacao = ANY (${lista(['USUARIO', 'REUSO', 'SUBSTITUIDA'])}))`),
  'restricao:mcp_oauth_concessoes.mcp_oauth_concessoes_check': chk('((revogada_em IS NULL) = (motivo_revogacao IS NULL))'),
  'indice:mcp_oauth_concessoes.mcp_oauth_concessoes_pkey': idx('mcp_oauth_concessoes_pkey', 'mcp_oauth_concessoes', '(id)', {unico: true, primario: true}),
  'indice:mcp_oauth_concessoes.mcp_oauth_concessoes_ativa_uk': idx('mcp_oauth_concessoes_ativa_uk', 'mcp_oauth_concessoes',
    '(usuario_id, empresa_id, client_id) WHERE (revogada_em IS NULL)', {unico: true}),
  'indice:mcp_oauth_concessoes.mcp_oauth_concessoes_usuario_idx': idx('mcp_oauth_concessoes_usuario_idx', 'mcp_oauth_concessoes', '(usuario_id, criada_em DESC)'),
  'indice:mcp_oauth_concessoes.mcp_oauth_concessoes_empresa_idx': idx('mcp_oauth_concessoes_empresa_idx', 'mcp_oauth_concessoes', '(empresa_id) WHERE (revogada_em IS NULL)'),
  'gatilho:mcp_oauth_concessoes.mcp_oauth_concessoes_revogacao_imutavel': T('CREATE TRIGGER mcp_oauth_concessoes_revogacao_imutavel BEFORE UPDATE ON public.mcp_oauth_concessoes ',
    'FOR EACH ROW EXECUTE FUNCTION public.mcp_oauth_concessao_revogacao_imutavel()|habilitado=O'),
  'gatilhos_internos:mcp_oauth_concessoes': 'fora_do_modo_O=0',
  'funcao:mcp_oauth_concessao_revogacao_imutavel()': T('corpo=71cd349698aff45d2d36d5a1355466dbaa1db3d32115b4c9d2779c34ac87a862|linguagem=plpgsql|retorno=trigger|',
    'tipo=f|definer=false|volatil=v|estrita=false|leakproof=false|paralelo=u|config=|dono_da_aplicacao=true'),

  'coluna:mcp_oauth_codigos.codigo_hash': col(1, 'text'), 'coluna:mcp_oauth_codigos.concessao_id': col(2, 'uuid'),
  'coluna:mcp_oauth_codigos.redirect_uri': col(3, 'text'), 'coluna:mcp_oauth_codigos.code_challenge': col(4, 'text'),
  'coluna:mcp_oauth_codigos.criado_em': col(5, TZ, false, CLOCK), 'coluna:mcp_oauth_codigos.expira_em': col(6, TZ),
  'coluna:mcp_oauth_codigos.usado_em': col(7, TZ, true),
  'restricao:mcp_oauth_codigos.mcp_oauth_codigos_pkey': pk('codigo_hash'),
  'restricao:mcp_oauth_codigos.mcp_oauth_codigos_codigo_hash_check': chk(HASH('codigo_hash')),
  'restricao:mcp_oauth_codigos.mcp_oauth_codigos_concessao_id_fkey': fk('concessao_id', 'mcp_oauth_concessoes(id)'),
  'restricao:mcp_oauth_codigos.mcp_oauth_codigos_redirect_uri_check': chk('(length(redirect_uri) <= 500)'),
  'restricao:mcp_oauth_codigos.mcp_oauth_codigos_code_challenge_check': chk(DESAFIO),
  'restricao:mcp_oauth_codigos.mcp_oauth_codigos_check': chk("((expira_em > criado_em) AND (expira_em <= (criado_em + '00:10:00'::interval)))"),
  'indice:mcp_oauth_codigos.mcp_oauth_codigos_pkey': idx('mcp_oauth_codigos_pkey', 'mcp_oauth_codigos', '(codigo_hash)', {unico: true, primario: true}),
  'indice:mcp_oauth_codigos.mcp_oauth_codigos_concessao_idx': idx('mcp_oauth_codigos_concessao_idx', 'mcp_oauth_codigos', '(concessao_id)'),
  'indice:mcp_oauth_codigos.mcp_oauth_codigos_expira_idx': idx('mcp_oauth_codigos_expira_idx', 'mcp_oauth_codigos', '(expira_em)'),
  'gatilhos_internos:mcp_oauth_codigos': 'fora_do_modo_O=0',

  'coluna:mcp_oauth_tokens.id': UUID.map(d => col(1, 'uuid', false, d)), 'coluna:mcp_oauth_tokens.concessao_id': col(2, 'uuid'),
  'coluna:mcp_oauth_tokens.tipo': col(3, 'text'), 'coluna:mcp_oauth_tokens.token_hash': col(4, 'text'),
  'coluna:mcp_oauth_tokens.escopos': col(5, 'text[]'), 'coluna:mcp_oauth_tokens.criado_em': col(6, TZ, false, CLOCK),
  'coluna:mcp_oauth_tokens.expira_em': col(7, TZ), 'coluna:mcp_oauth_tokens.revogado_em': col(8, TZ, true),
  'restricao:mcp_oauth_tokens.mcp_oauth_tokens_pkey': pk('id'),
  'restricao:mcp_oauth_tokens.mcp_oauth_tokens_concessao_id_fkey': fk('concessao_id', 'mcp_oauth_concessoes(id)'),
  'restricao:mcp_oauth_tokens.mcp_oauth_tokens_tipo_check': chk(`(tipo = ANY (${lista(['ACESSO', 'ATUALIZACAO'])}))`),
  'restricao:mcp_oauth_tokens.mcp_oauth_tokens_token_hash_key': restr('u', 'UNIQUE (token_hash)'),
  'restricao:mcp_oauth_tokens.mcp_oauth_tokens_token_hash_check': chk(HASH('token_hash')),
  'restricao:mcp_oauth_tokens.mcp_oauth_tokens_escopos_check': chk(ESCOPOS),
  'restricao:mcp_oauth_tokens.mcp_oauth_tokens_check': chk('(expira_em > criado_em)'),
  'restricao:mcp_oauth_tokens.mcp_oauth_tokens_check1': chk("((tipo <> 'ACESSO'::text) OR (expira_em <= (criado_em + '02:00:00'::interval)))"),
  'restricao:mcp_oauth_tokens.mcp_oauth_tokens_check2': chk("((tipo <> 'ATUALIZACAO'::text) OR (expira_em <= (criado_em + '31 days'::interval)))"),
  'indice:mcp_oauth_tokens.mcp_oauth_tokens_pkey': idx('mcp_oauth_tokens_pkey', 'mcp_oauth_tokens', '(id)', {unico: true, primario: true}),
  'indice:mcp_oauth_tokens.mcp_oauth_tokens_token_hash_key': idx('mcp_oauth_tokens_token_hash_key', 'mcp_oauth_tokens', '(token_hash)', {unico: true}),
  'indice:mcp_oauth_tokens.mcp_oauth_tokens_concessao_idx': idx('mcp_oauth_tokens_concessao_idx', 'mcp_oauth_tokens', '(concessao_id) WHERE (revogado_em IS NULL)'),
  'indice:mcp_oauth_tokens.mcp_oauth_tokens_expira_idx': idx('mcp_oauth_tokens_expira_idx', 'mcp_oauth_tokens', '(expira_em)'),
  'gatilhos_internos:mcp_oauth_tokens': 'fora_do_modo_O=0',

  'coluna:mcp_auditoria.id': col(1, 'bigint', false, '', 'a'), 'coluna:mcp_auditoria.ocorrido_em': col(2, TZ, false, CLOCK),
  'coluna:mcp_auditoria.evento': col(3, 'text'), 'coluna:mcp_auditoria.resultado': col(4, 'text'), 'coluna:mcp_auditoria.codigo': col(5, 'text'),
  'coluna:mcp_auditoria.concessao_id': col(6, 'uuid', true), 'coluna:mcp_auditoria.usuario_id': col(7, 'uuid', true),
  'coluna:mcp_auditoria.empresa_id': col(8, 'uuid', true), 'coluna:mcp_auditoria.client_id': col(9, 'text', true),
  'coluna:mcp_auditoria.capacidade': col(10, 'text', true), 'coluna:mcp_auditoria.itens': col(11, 'integer', true),
  'coluna:mcp_auditoria.duracao_ms': col(12, 'integer', true),
  'restricao:mcp_auditoria.mcp_auditoria_pkey': pk('id'),
  'restricao:mcp_auditoria.mcp_auditoria_evento_check': chk(`(evento = ANY (${lista(EVENTOS)}))`),
  'restricao:mcp_auditoria.mcp_auditoria_resultado_check': chk("(resultado ~ '^[A-Z_]{1,24}$'::text)"),
  'restricao:mcp_auditoria.mcp_auditoria_codigo_check': chk("(codigo ~ '^[A-Za-z0-9_:,]{1,80}$'::text)"),
  'restricao:mcp_auditoria.mcp_auditoria_client_id_check': chk('((client_id IS NULL) OR (length(client_id) <= 500))'),
  'restricao:mcp_auditoria.mcp_auditoria_capacidade_check': chk("((capacidade IS NULL) OR (capacidade ~ '^[a-z_]{1,64}$'::text))"),
  'restricao:mcp_auditoria.mcp_auditoria_itens_check': chk('((itens IS NULL) OR ((itens >= 0) AND (itens <= 10000)))'),
  'restricao:mcp_auditoria.mcp_auditoria_duracao_ms_check': chk('((duracao_ms IS NULL) OR ((duracao_ms >= 0) AND (duracao_ms <= 600000)))'),
  'indice:mcp_auditoria.mcp_auditoria_pkey': idx('mcp_auditoria_pkey', 'mcp_auditoria', '(id)', {unico: true, primario: true}),
  'indice:mcp_auditoria.mcp_auditoria_ocorrido_idx': idx('mcp_auditoria_ocorrido_idx', 'mcp_auditoria', '(ocorrido_em)'),
  'indice:mcp_auditoria.mcp_auditoria_empresa_idx': idx('mcp_auditoria_empresa_idx', 'mcp_auditoria', '(empresa_id, ocorrido_em DESC) WHERE (empresa_id IS NOT NULL)'),
  'gatilhos_internos:mcp_auditoria': 'fora_do_modo_O=0',

  ...Object.fromEntries(FKS.map(([t, nome, ref]) => [`gatilhos_fk:${t}.${nome}`, gatilhosFk(t, ref)])),
  'uuid_publico:gen_random_uuid()': ['ausente', UUID_PGCRYPTO],
});

/**
 * Compara as linhas do catálogo com o esperado: {integra, total, divergencias: [{chave, tipo: FALTA|SOBRA|DIFERENTE|REPETIDA|INCOERENTE}]}.
 * Linha ilegível (sem chave/definição em texto) = divergência ILEGIVEL. Nunca devolve a definição lida (só a chave).
 */
function compararDefinicoes(linhas) {
  const divergencias = [], vistas = new Set();
  for (const l of Array.isArray(linhas) ? linhas : []) {
    if (typeof l?.chave !== 'string' || typeof l?.definicao !== 'string') { divergencias.push({chave: '?', tipo: 'ILEGIVEL'}); continue; }
    if (vistas.has(l.chave)) { divergencias.push({chave: l.chave, tipo: 'REPETIDA'}); continue; }
    vistas.add(l.chave);
    if (!Object.hasOwn(ESPERADO, l.chave)) { divergencias.push({chave: l.chave, tipo: 'SOBRA'}); continue; }
    const aceitas = [ESPERADO[l.chave]].flat();
    if (!aceitas.includes(l.definicao)) divergencias.push({chave: l.chave, tipo: 'DIFERENTE'});
  }
  if (!Array.isArray(linhas)) divergencias.push({chave: '?', tipo: 'ILEGIVEL'});
  for (const chave of Object.keys(ESPERADO)) if (!vistas.has(chave)) divergencias.push({chave, tipo: 'FALTA'});
  // DEFAULT qualificado (public.gen_random_uuid()) só com o pgcrypto genuíno em public; o não qualificado é o do pg_catalog.
  const linha = chave => (Array.isArray(linhas) ? linhas : []).find(l => l?.chave === chave)?.definicao;
  for (const chave of COLUNAS_UUID) {
    if (String(linha(chave) ?? '').includes('default=public.gen_random_uuid()') && linha('uuid_publico:gen_random_uuid()') !== UUID_PGCRYPTO) {
      divergencias.push({chave, tipo: 'INCOERENTE'});
    }
  }
  return {integra: divergencias.length === 0, total: vistas.size, esperado: Object.keys(ESPERADO).length, divergencias};
}

/** Comandos que fixam o deparse (dentro de uma transação já aberta). */
const SET_DEPARSE = Object.freeze(["SET LOCAL search_path = pg_catalog, pg_temp", "SET LOCAL IntervalStyle = 'postgres'"]);

module.exports = {SQL_ARQUIVO, ESPERADO, UUID_PGCRYPTO, FKS, SET_DEPARSE, compararDefinicoes};
