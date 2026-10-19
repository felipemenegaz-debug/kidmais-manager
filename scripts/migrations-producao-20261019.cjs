/* eslint-disable @typescript-eslint/no-require-imports */
// Pacote único de migrations de PRODUÇÃO (19/10/2026): leva o banco kidmais_production do estado lido hoje (…074, 079 e
// 084 presentes; 074a–078, 060, 065, 080–083, 085 e 086 ausentes) ao schema exigido pelo código de staging.
//
// Ordem (docs/MIGRATIONS_PRODUCTION_20261019.json): 074a → 075 → 076 → 077 → 078 → 079 (já presente) → 084 (já presente)
// → 060 → 065 → 080 → 081 → 082 → 083 → 085 → 086. Para na primeira falha.
//   * 074a–079: REAPROVEITA o aplicador revisado do lançamento (scripts/migrations-lancamento-production.cjs, manifesto
//     628eb4f6…), sem alterá-lo: um processo filho por migration ausente, com o mesmo registro de backup. Já presente
//     (079): só o postcheck, aqui, em transação READ ONLY (nenhum marcador novo do lançamento).
//   * 084: aplicada em 18/10 pelo aplicador próprio; aqui só o postcheck READ ONLY. Ausente = recusa (não é deste pacote).
//   * 060, 065, 080, 081, 082, 083, 085, 086: aplicadas AQUI, uma transação por migration: precheck externo (quando
//     existe) em READ ONLY; depois BEGIN → corpo da migration (molduras BEGIN/COMMIT do arquivo removidas, corpo intacto)
//     → SET TRANSACTION READ ONLY → postcheck → COMMIT. Postcheck que falha desfaz a migration inteira.
//
// Modos (exatamente um; qualquer outra combinação é recusada antes de ler o ambiente):
//   node scripts/migrations-producao-20261019.cjs                         → PLANO, sem conexão
//   node scripts/migrations-producao-20261019.cjs --conferir              → SOMENTE LEITURA (banco e disco)
//   node scripts/migrations-producao-20261019.cjs --aplicar-autorizado --backup <registro>
//   node scripts/migrations-producao-20261019.cjs --retomar-autorizado <id> --backup <registro>
// O registro de backup é o do P1 do lançamento (backup-lancamento-production.cjs; pasta lancamento-venda-20261011),
// conferido por conferirBackup do aplicador do lançamento: < 24 h, PITR < 24 h, dump íntegro com o hash registrado.
// Marcador exclusivo por migration (deste pacote: migration-<id>; do processo filho do lançamento: lancamento-<id>, com a
// situação verdadeira depois do filho) em /opt/render/project/src/data/migracoes-producao-20261019: uma tentativa
// anterior impede repetição automática. Retomada só com a flag própria, só com o schema da migration AUSENTE; para
// 074a–078 o marcador ativo do lançamento é renomeado para .tentativa-<n> (registrado antes) e o filho roda de novo.
// Antes da 1ª escrita (e na conferência): marcadores anteriores de migrations ausentes, prechecks de TODAS as ausentes
// que só dependem da base atual e as condições de dados dos postchecks (kidmais; 7 categorias da 078).
// Saída: só nomes de etapas, booleanos, contagens agregadas e códigos curtos; nunca URL, credencial ou dado de cliente.
// Códigos de saída (CODIGOS_DE_SAIDA): 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar; 2 FALHA (ver
// confirmadasNestaExecucao/nenhumaEscrita; falha de conexão/identidade não escreve); 3 conferência RECUSARIA.
// Qualquer outro código (127, 130, 143…) = parar e ler.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');

const MANIFESTO = 'docs/MIGRATIONS_PRODUCTION_20261019.json';
const HASH_MANIFESTO = 'db81ff8edef1fa5fecae6e1aec43d755b683240372cbefa2707c8d207dd5da69';
const ALVO = Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
const DISCO = '/opt/render/project/src/data';
const DIR = path.posix.join(DISCO, 'migracoes-producao-20261019');
const DIR_LANCAMENTO = path.posix.join(DISCO, 'lancamento-venda-20261011');
const FLAG_CONFERIR = '--conferir';
const FLAG_APLICAR = '--aplicar-autorizado';
const FLAG_RETOMAR = '--retomar-autorizado';
/** Chave fixa da trava consultiva de sessão (pg_try_advisory_lock(int,int)) deste pacote. */
const TRAVA = Object.freeze([20261019, 74086]);
/** Interruptores que abrem venda, atendimento ou Marketing: ligado (= 'true', como o código lê) recusa a aplicação. */
const FLAGS_ABERTURA = Object.freeze(['CADASTRO_PUBLICO_ATIVO', 'ASSINATURA_PLANOS_ATIVOS', 'COTACAO_PUBLICA_POR_EMPRESA',
  'WHATSAPP_ATENDIMENTO_ENABLED', 'WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED', 'MARKETING_AUTOMACOES_ENABLED', 'MARKETING_SITES_PUBLICOS',
  'MARKETING_DOMINIOS_PERSONALIZADOS']);
/** Os cinco bloqueios globais do reparo do lançamento (database/repairs/20261011_lancamento_bloqueios_kidmais.sql). */
const BLOQUEIOS_REPARO = Object.freeze(['57618aab-a62c-4be1-9385-17308ac8dda3', '3b06e365-7ac1-42e6-ba1a-6b82de76af8b',
  '11b9459d-35f8-4a9f-8e6f-aeb7311ff651', 'e4cc53fd-b423-46bc-98b4-86b318a0d688', 'd4e6cf8c-1b42-4bd1-8d18-1750cc3b958e']);
const KIDMAIS_ID = '7e990a2b-e64b-4630-9aae-4646fe936ede';
/** Já aplicadas em produção (079 em 17/10 e 084 em 18/10, pelos aplicadores próprios): só conferidas aqui. */
const JA_PRESENTES = Object.freeze(['079', '084']);
/** Aplicadas pelo processo filho do aplicador do lançamento (retomada própria, P2-1 da revisão de 19/10). */
const DO_LANCAMENTO = Object.freeze(['074a', '075', '076', '077', '078']);
/** Prechecks externos que só dependem da base ATUAL (rodam todos na conferência e antes da 1ª escrita; P2-2). */
const PRECHECK_INDEPENDENTE = Object.freeze(['074a', '076', '077', '078', '083', '085']);
/** Categorias originais do catálogo exigidas pelo postcheck da 078 (database/checks/20261010_078_postcheck.sql). */
const CATEGORIAS_ORIGINAIS = Object.freeze(['SALGADOS', 'DOCES', 'MASSA_BOLO', 'RECHEIO_BOLO', 'BOMBONS', 'EMPRATADOS', 'LEMBRANCINHAS']);

// Catálogo (pg_attribute), não information_schema: este só mostra colunas de tabelas com privilégio do papel atual, e um
// papel sem privilégio veria a 079 como "parcial" (achado do ensaio local de 19/10).
const col = (t, c) => `EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.${t}') AND attname='${c}' AND attnum > 0 AND NOT attisdropped)`;
const tab = t => `to_regclass('public.${t}') IS NOT NULL`;
const fun = f => `to_regprocedure('public.${f}') IS NOT NULL`;
const con = (t, c) => `EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.${t}') AND conname='${c}')`;
const trg = (t, g) => `EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.${t}') AND tgname='${g}' AND NOT tgisinternal)`;
const todos = xs => '(' + xs.join(' AND ') + ')';
const algum = xs => '(' + xs.join(' OR ') + ')';
const T085 = ['marketing_membership_capacidades', 'marketing_origens_opcoes', 'marketing_sites', 'marketing_site_versoes', 'marketing_site_imagens',
  'marketing_dominios', 'marketing_dns_simulado', 'marketing_campanhas', 'marketing_contatos', 'marketing_atribuicoes', 'marketing_eventos'];
const T086 = ['marketing_automacao_regras', 'marketing_automacao_execucoes', 'marketing_automacao_eventos', 'marketing_contato_preferencias',
  'marketing_contato_preferencias_eventos', 'marketing_contato_autorizacoes', 'marketing_tarefas', 'marketing_transporte_simulado'];
const T082 = ['whatsapp_atendimento_arquivos', 'whatsapp_atendimento_privacidade', 'whatsapp_atendimento_controles_contato',
  'whatsapp_atendimento_eventos_excluidos', 'whatsapp_atendimento_retencao_config', 'whatsapp_atendimento_retencao_execucoes'];
const T060 = ['whatsapp_atendimento_config', 'whatsapp_atendimento_conversas', 'whatsapp_atendimento_mensagens', 'whatsapp_atendimento_status',
  'whatsapp_atendimento_auditoria'];
/**
 * Objetos de cada migration (todos criados por ela e por nenhuma outra da sequência): `completa` exige todos; `vestigio`
 * acusa qualquer um. Ausente = nenhum vestígio; vestígio sem completa = PARCIAL (cada migration é uma transação: só por
 * intervenção manual) e sempre recusa.
 */
const OBJETOS = Object.freeze({
  '074a': [tab('assinatura_isencoes'), tab('assinatura_fundadores'), tab('assinatura_contratacoes'), fun('kidmais_074_registro_guarda()'),
    col('empresa_assinaturas', 'contratacao_atual_id')],
  '075': [tab('assinatura_renovacoes'), fun('kidmais_075_renovacao_guarda()')],
  '076': [tab('clientes_cpf_empresa_canonico_uk'), "to_regclass('public.clientes_cpf_canonico_uk') IS NULL"],
  '077': [tab('empresa_regras_pagamento')],
  '078': [col('buffet_categorias', 'empresa_id'), col('buffet_itens', 'empresa_id'), fun('kidmais_078_empresa_imutavel()'),
    tab('buffet_categorias_empresa_codigo_uk')],
  '079': [col('convite_geracoes', 'resolucao_resultado'), con('convite_geracoes', 'convite_geracoes_resolucao_consistente'),
    tab('convite_geracoes_incertas')],
  '084': [col('convite_geracoes', 'etapas_registradas'), col('convite_geracoes', 'falha_classe'),
    con('convite_geracoes', 'convite_geracoes_etapas_consistentes'), tab('convite_geracoes_em_aberto')],
  '060': T060.map(tab),
  '065': [col('whatsapp_atendimento_conversas', 'nome_perfil'), col('whatsapp_atendimento_conversas', 'nome_perfil_em')],
  '080': [tab('whatsapp_atendimento_mensagens_prontas'), tab('whatsapp_atendimento_mensagens_prontas_favoritas')],
  '081': [col('whatsapp_atendimento_mensagens_prontas', 'midia_url'), col('whatsapp_atendimento_mensagens', 'midia_tipo'),
    col('whatsapp_atendimento_mensagens', 'midia_pronta_id'), col('whatsapp_atendimento_mensagens', 'midia_pronta_versao'),
    con('whatsapp_atendimento_mensagens_prontas', 'whatsapp_prontas_tipo')],
  '082': [...T082.map(tab), col('whatsapp_atendimento_mensagens_prontas', 'estado'), col('whatsapp_atendimento_mensagens', 'origem_grupo_id'),
    col('whatsapp_atendimento_conversas', 'contexto')],
  // Para a 083, o índice antigo (018) AUSENTE faz parte da instalação completa; presente com coluna nova = parcial.
  '083': [col('whatsapp_conexoes', 'empresa_id'), col('whatsapp_onboarding_tentativas', 'empresa_id'),
    tab('whatsapp_conexoes_empresa_configurada_uk'), "to_regclass('public.whatsapp_conexoes_ambiente_configurada_uk') IS NULL"],
  '085': [...T085.map(tab), "EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'kidmais085\\_%')"],
  '086': [...T086.map(tab), trg('clientes', 'marketing_aut_numero_saiu')],
});
/** Vestígio: no 076 e no 083, a ausência do índice antigo sozinha não é vestígio (o antigo só some junto com o novo). */
const VESTIGIO = Object.freeze(Object.fromEntries(Object.entries(OBJETOS).map(([id, xs]) => [id, xs.filter(x => !/IS NULL$/.test(x))])));
const SQL_ESTADO = 'SELECT ' + Object.keys(OBJETOS).map(id => `${todos(OBJETOS[id])} AS "c${id}", ${algum(VESTIGIO[id])} AS "v${id}"`).join(',\n  ');

/** Privilégios exigidos por migration AUSENTE: dono das tabelas/funções alteradas e REFERENCES nas referenciadas. */
const PRIVILEGIOS = Object.freeze({
  '074a': {criar: true, tabelas: ['empresa_assinaturas'], funcoes: ['kidmais_068_assinatura_guarda()'], referencias: ['empresas', 'usuarios_administrativos', 'empresa_assinaturas']},
  '075': {criar: true, tabelas: [], funcoes: [], referencias: ['empresas', 'usuarios_administrativos']},
  '076': {criar: false, tabelas: ['clientes'], funcoes: [], referencias: []},
  '077': {criar: true, tabelas: [], funcoes: [], referencias: ['empresas']},
  '078': {criar: true, tabelas: ['buffet_categorias', 'buffet_itens', 'pacote_buffet_categorias', 'pacote_buffet_itens', 'pacote_itens_especificos',
    'adicionais', 'fechamento_buffet_escolhas'], funcoes: [], referencias: ['empresas']},
  '079': {criar: false, tabelas: [], funcoes: [], referencias: []},
  '084': {criar: false, tabelas: [], funcoes: [], referencias: []},
  '060': {criar: true, tabelas: [], funcoes: [], referencias: ['empresas', 'usuarios_administrativos']},
  '065': {criar: false, tabelas: [], funcoes: [], referencias: []},
  '080': {criar: true, tabelas: [], funcoes: [], referencias: ['empresas', 'usuarios_administrativos']},
  '081': {criar: false, tabelas: [], funcoes: [], referencias: []},
  '082': {criar: true, tabelas: [], funcoes: [], referencias: ['empresas', 'usuarios_administrativos', 'estabelecimentos']},
  '083': {criar: true, tabelas: ['whatsapp_conexoes', 'whatsapp_onboarding_tentativas'],
    funcoes: ['kidmais_whatsapp_conexao_proteger()', 'kidmais_whatsapp_tentativa_proteger()'], referencias: ['empresas']},
  '085': {criar: true, tabelas: [], funcoes: [], referencias: ['empresas', 'estabelecimentos', 'memberships', 'clientes', 'fechamentos', 'usuarios_administrativos']},
  '086': {criar: true, tabelas: ['clientes'], funcoes: [], referencias: ['empresas', 'estabelecimentos', 'clientes', 'fechamentos', 'usuarios_administrativos']},
});
const uniq = xs => [...new Set(xs)].sort();
const TODAS_TABELAS = uniq(Object.values(PRIVILEGIOS).flatMap(p => p.tabelas));
const TODAS_FUNCOES = uniq(Object.values(PRIVILEGIOS).flatMap(p => p.funcoes));
const TODAS_REFERENCIAS = uniq(Object.values(PRIVILEGIOS).flatMap(p => p.referencias));
const arr = xs => `ARRAY[${xs.map(x => `'${x}'`).join(',')}]::text[]`;
const SQL_PRIVILEGIOS = `SELECT has_schema_privilege(current_user,'public','CREATE') AS criar,
  (current_user <> session_user) AS papel_trocado,
  (SELECT jsonb_object_agg(t, coalesce((SELECT pg_has_role(current_user, c.relowner, 'USAGE') FROM pg_class c WHERE c.oid = to_regclass('public.'||t)), false))
     FROM unnest(${arr(TODAS_TABELAS)}) t) AS tabelas,
  (SELECT jsonb_object_agg(f, coalesce((SELECT pg_has_role(current_user, p.proowner, 'USAGE') FROM pg_proc p WHERE p.oid = to_regprocedure('public.'||f)), false))
     FROM unnest(${arr(TODAS_FUNCOES)}) f) AS funcoes,
  (SELECT jsonb_object_agg(t, coalesce(has_table_privilege(current_user, to_regclass('public.'||t), 'REFERENCES'), false))
     FROM unnest(${arr(TODAS_REFERENCIAS)}) t) AS referencias`;
/** Identidade vista pelo servidor (mesmos critérios do aplicador da 084 de produção) e versão principal. */
const SQL_IDENTIDADE = `SELECT current_database() AS db,
  (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
  (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_versao,
  coalesce(inet_server_addr() << ANY('{10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}'::inet[]), false) AS servidor_privado,
  current_setting('server_version_num')::int / 10000 AS pg_major,
  current_setting('search_path') AS search_path,
  EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = current_user) AS schema_do_usuario`;
const lista = xs => xs.map(x => `'${x}'::uuid`).join(',');
/** Agregados (sem ids nem dados pessoais) da Kidmais, dos bloqueios do reparo e de preservação. */
const SQL_SITUACAO = `SELECT (SELECT count(*) FROM empresas)::int AS empresas,
  (SELECT count(*) FROM empresas WHERE status = 'ATIVA')::int AS empresas_ativas,
  (SELECT count(*) FROM empresas WHERE codigo = 'kidmais')::int AS kidmais,
  EXISTS (SELECT 1 FROM empresas WHERE codigo = 'kidmais' AND id = '${KIDMAIS_ID}'::uuid AND status = 'ATIVA') AS kidmais_id_confere,
  CASE WHEN to_regclass('public.empresa_assinaturas') IS NULL THEN NULL ELSE (SELECT count(*) FROM empresa_assinaturas)::int END AS assinaturas,
  (SELECT count(*) FROM bloqueios_agenda WHERE ativo AND empresa_id IS NULL AND data >= current_date)::int AS bloqueios_globais_futuros,
  (SELECT count(*) FROM bloqueios_agenda WHERE ativo AND empresa_id IS NULL)::int AS bloqueios_globais_ativos,
  (SELECT count(*) FROM bloqueios_agenda b WHERE b.id IN (${lista(BLOQUEIOS_REPARO)}) AND b.ativo AND b.empresa_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM agenda_062_bloqueios_resolucao r WHERE r.bloqueio_id = b.id))::int AS reparo_alvos_intactos,
  (SELECT count(*) FROM bloqueios_agenda WHERE ativo AND empresa_id IS NULL AND data >= current_date AND id NOT IN (${lista(BLOQUEIOS_REPARO)}))::int AS reparo_globais_fora_do_alvo,
  (SELECT count(*) FROM clientes)::int AS clientes,
  (SELECT count(*) FROM buffet_categorias)::int AS buffet_categorias,
  (SELECT count(*) FROM buffet_itens)::int AS buffet_itens,
  CASE WHEN to_regclass('public.whatsapp_conexoes') IS NULL THEN NULL ELSE (SELECT count(*) FROM whatsapp_conexoes)::int END AS whatsapp_conexoes,
  CASE WHEN to_regclass('public.convite_geracoes') IS NULL THEN NULL ELSE
    (SELECT coalesce(jsonb_object_agg(estado, n), '{}'::jsonb) FROM (SELECT estado, count(*) AS n FROM convite_geracoes GROUP BY estado) e) END AS convites_estados,
  -- Contagens de risco (P3-5 da revisão de 19/10): sem ids nem dados pessoais.
  (SELECT count(*) FROM pacotes WHERE empresa_id IS NULL)::int AS pacotes_sem_empresa,
  (SELECT count(*) FROM fechamentos WHERE empresa_id IS NULL)::int AS fechamentos_sem_empresa,
  (SELECT count(*) FROM whatsapp_conexoes w WHERE w.status = 'CONFIGURADA' AND (to_jsonb(w) ->> 'empresa_id') IS NULL)::int AS whatsapp_configuradas_sem_empresa,
  (SELECT count(*) FROM whatsapp_onboarding_tentativas WHERE status IN ('INICIADA', 'VALIDANDO'))::int AS onboarding_em_andamento,
  ARRAY(SELECT c FROM unnest(${arr(CATEGORIAS_ORIGINAIS)}) c WHERE NOT EXISTS (SELECT 1 FROM buffet_categorias b WHERE b.codigo = c) ORDER BY c) AS categorias_originais_ausentes`;
/**
 * Condições de dados que só apareceriam no MEIO da aplicação (P2-2 da revisão de 19/10): 077/078 exigem uma `kidmais`
 * ATIVA; o postcheck da 078 exige as 7 categorias originais (hoje sem empresa; a 078 as entrega à kidmais).
 */
const SQL_ANTECIPACOES = `SELECT (SELECT count(*) FROM empresas WHERE codigo = 'kidmais')::int AS kidmais,
  (SELECT count(*) FROM empresas WHERE codigo = 'kidmais' AND status = 'ATIVA')::int AS kidmais_ativa,
  (SELECT count(DISTINCT codigo) FROM buffet_categorias WHERE codigo = ANY(${arr(CATEGORIAS_ORIGINAIS)}))::int AS categorias_originais`;
/** Impressão do schema public (definições, nunca OID): a mesma do ensaio local, para comparar a base de produção com a dele. */
const SQL_SCHEMA = `
    WITH rel AS (
      SELECT c.oid, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f')
    ), fn AS (
      SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
    )
    SELECT x FROM (
      SELECT 'rel:' || relname || ':' || relkind::text AS x FROM rel
      UNION ALL SELECT 'col:' || r.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text
             || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ':' || a.attidentity::text || ':' || a.attgenerated::text
        FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum
      UNION ALL SELECT 'con:' || r.relname || '.' || co.conname || ':' || pg_get_constraintdef(co.oid) || ':valid=' || co.convalidated::text || ':def=' || co.condeferrable::text || co.condeferred::text
        FROM pg_constraint co JOIN rel r ON r.oid = co.conrelid
      UNION ALL SELECT 'idx:' || r.relname || '.' || i.relname || ':' || pg_get_indexdef(ix.indexrelid)
        FROM pg_index ix JOIN rel r ON r.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid
      UNION ALL SELECT 'trg:' || r.relname || '.' || t.tgname || ':' || t.tgenabled::text || ':' || pg_get_triggerdef(t.oid)
        FROM pg_trigger t JOIN rel r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal
      UNION ALL SELECT 'fn:' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || '):' || md5(pg_get_functiondef(f.oid)) FROM fn f
      UNION ALL SELECT 'view:' || r.relname || ':' || md5(pg_get_viewdef(r.oid)) FROM rel r WHERE r.relkind IN ('v','m')
      UNION ALL SELECT 'pol:' || p.tablename || '.' || p.policyname || ':' || p.cmd || ':' || coalesce(p.qual, '') || ':' || coalesce(p.with_check, '')
        FROM pg_policies p WHERE p.schemaname = 'public'
      UNION ALL SELECT 'enum:' || t.typname || ':' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid WHERE n.nspname = 'public' GROUP BY t.typname
      UNION ALL SELECT 'comment:' || r.relname || '.' || coalesce(a.attname, '') || ':' || md5(d.description)
        FROM pg_description d JOIN rel r ON r.oid = d.objoid AND d.classoid = 'pg_class'::regclass
        LEFT JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = d.objsubid AND d.objsubid > 0
    ) s ORDER BY x`;
const SQL_IMPRESSAO = `SELECT md5(string_agg(x, chr(10) ORDER BY x)) AS md5, count(*)::int AS objetos FROM (${SQL_SCHEMA}) i`;
const SQL_TRAVA = `SELECT pg_try_advisory_lock(${TRAVA[0]}, ${TRAVA[1]}) AS trava`;
const SQL_SOLTAR = `SELECT pg_advisory_unlock(${TRAVA[0]}, ${TRAVA[1]}) AS solta`;

const sha = s => createHash('sha256').update(s).digest('hex');
const lerLf = (raiz, arquivo) => fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').replace(/\s+/g, ' ').slice(0, 160);

/** Remove só as molduras externas (BEGIN/COMMIT da migration; BEGIN READ ONLY/ROLLBACK dos checks); o corpo fica intacto. */
function corpo(sql, tipo) {
  const linhas = sql.split('\n'), moldura = /^\s*(?:BEGIN(?: TRANSACTION READ ONLY)?|COMMIT|ROLLBACK);\s*$/i;
  const molduras = linhas.filter(l => moldura.test(l)).map(l => l.trim().toUpperCase());
  if (tipo === 'migration') assert.deepEqual(molduras, ['BEGIN;', 'COMMIT;'], 'MOLDURA_MIGRATION_DIVERGENTE');
  else {
    assert.ok(molduras.length === 0 || (molduras.length === 2 && molduras[0] === 'BEGIN TRANSACTION READ ONLY;' && molduras[1] === 'ROLLBACK;'), 'MOLDURA_CHECK_DIVERGENTE');
    // Leitura estática (sem comentários nem literais) + execução sempre em transação READ ONLY.
    const semTexto = sql.replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");
    assert.ok(!/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|COPY)\b/i.test(semTexto), 'CHECK_NAO_LEITURA');
  }
  return linhas.filter(l => !moldura.test(l)).join('\n');
}

/** Manifesto com hash fixo, amarrado ao manifesto/aplicador do lançamento; cada SQL conferido pelo hash LF. */
function carregar(raiz = path.resolve(__dirname, '..'), {lancamento = require('./migrations-lancamento-production.cjs')} = {}) {
  const texto = lerLf(raiz, MANIFESTO);
  assert.equal(sha(texto), HASH_MANIFESTO, 'MANIFESTO_DIVERGENTE');
  const m = JSON.parse(texto);
  assert.deepEqual(m.alvo, ALVO, 'ALVO_MANIFESTO_DIVERGENTE');
  assert.equal(m.lancamento.sha256, lancamento.HASH_MANIFESTO, 'MANIFESTO_LANCAMENTO_DIVERGENTE');
  assert.equal(sha(lerLf(raiz, m.lancamento.aplicador)), m.lancamento.aplicadorSha256, 'APLICADOR_LANCAMENTO_DIVERGENTE');
  assert.equal(sha(lerLf(raiz, m.lancamento.diagnostico)), m.lancamento.diagnosticoSha256, 'DIAGNOSTICO_LANCAMENTO_DIVERGENTE');
  const lanc = new Map(lancamento.carregar(raiz).map(e => [e.id, e]));
  const sequencia = m.sequencia.map(e => {
    assert.ok(Object.hasOwn(OBJETOS, e.id), 'MIGRATION_SEM_ESTADO ' + e.id);
    if (e.aplicador === 'lancamento') {
      assert.ok(lanc.has(e.id), 'FORA_DO_LANCAMENTO ' + e.id);
      return {...e, arquivos: lanc.get(e.id).arquivos.map(({tipo, arquivo, sha256, sql}) => ({tipo, arquivo, sha256, sql}))};
    }
    assert.ok(['este', 'migration-084-production'].includes(e.aplicador), 'APLICADOR_DESCONHECIDO ' + e.id);
    return {...e, arquivos: e.arquivos.map(a => {
      const sql = lerLf(raiz, a.arquivo);
      assert.equal(sha(sql), a.sha256, 'SQL_DIVERGENTE ' + a.arquivo);
      corpo(sql, a.tipo);
      return {...a, sql};
    })};
  });
  assert.deepEqual(sequencia.map(e => e.id), ['074a', '075', '076', '077', '078', '079', '084', '060', '065', '080', '081', '082', '083', '085', '086'], 'ORDEM_DIVERGENTE');
  return {manifesto: m, sequencia};
}

/** Trava de alvo: só o web de produção e o banco interno exato; TLS conforme a configuração do serviço (084 de produção). */
function alvo(env) {
  assert.ok(env.RENDER === 'true', 'FORA_DO_RENDER');
  assert.ok(env.RENDER_SERVICE_ID === ALVO.servico, 'SERVICO_RECUSADO');
  assert.ok(env.KIDMAIS_DEPLOY_ENV === 'production', 'AMBIENTE_RECUSADO');
  assert.ok(env.DATABASE_SSL === 'true', 'TLS_OBRIGATORIO');
  let u;
  try { u = new URL(env.DATABASE_URL); } catch { assert.fail('URL_RECUSADA'); }
  assert.ok(u.hostname === ALVO.host && !u.hostname.includes('.'), 'HOST_RECUSADO');
  assert.ok(decodeURIComponent(u.pathname.slice(1)) === ALVO.database, 'BANCO_RECUSADO');
  assert.ok(!u.port || Number(u.port) === ALVO.port, 'PORTA_RECUSADA');
  assert.ok(u.search === '', 'CONNECTION_QUERY_REJECTED');
  return {connectionString: env.DATABASE_URL, ssl: {rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false', minVersion: 'TLSv1.2'},
    application_name: 'kidmais-migracoes-producao-20261019', connectionTimeoutMillis: 10000};
}
function conferirIdentidade(id) {
  assert.ok(id?.db === ALVO.database, 'BANCO_DIVERGENTE');
  assert.ok(id.tls === true, 'SEM_TLS');
  assert.ok(['TLSv1.2', 'TLSv1.3'].includes(id.tls_versao), 'TLS_VERSAO_RECUSADA');
  assert.ok(id.servidor_privado === true, 'SERVIDOR_FORA_DA_REDE_PRIVADA');
  assert.ok(Number(id.pg_major) === 18, 'VERSAO_POSTGRES_DIVERGENTE');
  exigirSearchPath(id);
  return {banco: id.db, tls: true, tlsVersao: id.tls_versao, servidorPrivado: true, pgMajor: 18, searchPath: id.search_path};
}
/** As migrations sem SET search_path próprio criam objetos no primeiro schema: exige o padrão e nenhum schema "$user". */
function exigirSearchPath(id) {
  assert.ok(id?.search_path === '"$user", public', 'SEARCH_PATH_DIVERGENTE');
  assert.ok(id.schema_do_usuario === false, 'SCHEMA_DO_USUARIO_EXISTE');
}
/** Nomes (nunca valores) dos interruptores ligados. */
function flagsLigadas(env) { return FLAGS_ABERTURA.filter(k => String(env[k] ?? '').trim().toLowerCase() === 'true'); }
function exigirDisco(disco = DISCO, stat = fs.lstatSync) {
  let d, pai;
  try { d = stat(disco); pai = stat(path.dirname(disco)); } catch { d = null; }
  assert.ok(d && d.isDirectory() && !d.isSymbolicLink() && d.dev !== pai.dev, 'DISCO_PERSISTENTE_AUSENTE');
}

async function somenteLeitura(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query("SET LOCAL lock_timeout = '5s'");
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
const linhasDe = r => (Array.isArray(r) ? r : [r]).flatMap(x => x?.rows ?? []);
/** Linhas só de booleanos (prechecks 085/086) precisam ser todas true; as demais linhas são informativas. */
function exigirPrecheck(id, resultado) {
  for (const l of linhasDe(resultado).filter(x => Object.keys(x).length && Object.values(x).every(v => typeof v === 'boolean'))) {
    const falsos = Object.entries(l).filter(([, v]) => v !== true).map(([k]) => k);
    assert.equal(falsos.length, 0, `PRECHECK_RECUSOU ${id}: ${falsos.join(',')}`);
  }
}

/** Estado por migration: AUSENTE | COMPLETA | PARCIAL. */
function lerEstado(linha) {
  const r = {};
  for (const id of Object.keys(OBJETOS)) {
    const c = linha?.['c' + id], v = linha?.['v' + id];
    assert.ok(typeof c === 'boolean' && typeof v === 'boolean', 'ESTADO_ILEGIVEL ' + id);
    r[id] = c ? 'COMPLETA' : v ? 'PARCIAL' : 'AUSENTE';
  }
  return r;
}
/** Privilégios faltantes para as migrations ainda ausentes (lista de códigos curtos). */
function faltasDePrivilegio(estado, p) {
  const faltas = [];
  for (const [id, req] of Object.entries(PRIVILEGIOS)) {
    if (estado[id] !== 'AUSENTE') continue;
    if (req.criar && p.criar !== true) faltas.push(`${id}:CREATE_public`);
    for (const t of req.tabelas) if (p.tabelas?.[t] !== true) faltas.push(`${id}:dono_${t}`);
    for (const f of req.funcoes) if (p.funcoes?.[f] !== true) faltas.push(`${id}:dono_${f}`);
    for (const t of req.referencias) if (p.referencias?.[t] !== true) faltas.push(`${id}:references_${t}`);
  }
  return faltas;
}
/**
 * Plano a partir do estado, na ordem do manifesto; recusa ANTES de qualquer escrita: parcial, 079/084 ausentes (não
 * são deste pacote), migration completa depois de uma ausente (ordem quebrada) e privilégio faltante.
 */
function planoEtapas(sequencia, estado, faltas = []) {
  const plano = [];
  let ausenteVista = null;
  for (const e of sequencia) {
    const s = estado[e.id];
    assert.notEqual(s, 'PARCIAL', 'APLICACAO_PARCIAL ' + e.id);
    // 079 e 084 já estão em produção (aplicadas antes da 074a): exigidas presentes, fora da regra de ordem.
    if (JA_PRESENTES.includes(e.id)) { assert.equal(s, 'COMPLETA', 'PRESENTE_ESPERADA_AUSENTE ' + e.id); plano.push({id: e.id, acao: 'POSTCHECK'}); continue; }
    if (s === 'COMPLETA') {
      assert.equal(ausenteVista, null, `ORDEM_QUEBRADA ${e.id} presente depois de ${ausenteVista} ausente`);
      plano.push({id: e.id, acao: 'POSTCHECK'});
    } else {
      ausenteVista ??= e.id;
      plano.push({id: e.id, acao: e.aplicador === 'lancamento' ? 'APLICAR_LANCAMENTO' : 'APLICAR'});
    }
  }
  assert.equal(faltas.length, 0, 'SEM_PRIVILEGIO ' + faltas.join(','));
  return plano;
}
const arquivosDe = (e, tipo) => e.arquivos.filter(a => a.tipo === tipo);

/** Postcheck em transação READ ONLY (migration já presente). */
async function postcheckSomenteLeitura(db, e) {
  for (const a of arquivosDe(e, 'postcheck')) await somenteLeitura(db, corpo(a.sql, 'postcheck'));
}
/**
 * Uma migration deste pacote: precheck externo em READ ONLY; depois uma transação com o corpo da migration e o postcheck
 * já em modo READ ONLY. Falha em qualquer ponto = ROLLBACK integral. `registrar` grava o progresso (marcador).
 */
async function aplicarEtapa(db, e, {registrar = () => {}} = {}) {
  for (const a of arquivosDe(e, 'precheck')) exigirPrecheck(e.id, await somenteLeitura(db, corpo(a.sql, 'precheck')));
  registrar({situacao: 'PRECHECK_PASS'});
  const [mig] = arquivosDe(e, 'migration');
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '120s'");
    // search_path NÃO é alterado: o mesmo da aplicação em staging (padrão "$user", public, conferido na identidade). Forçar
    // public, pg_catalog ligaria os DEFAULT gen_random_uuid() da 060/080/082 ao do pgcrypto (achado do ensaio de 19/10).
    registrar({situacao: 'EM_TRANSACAO'});
    await db.query(corpo(mig.sql, 'migration'));
    // A partir daqui a transação não escreve mais: o postcheck roda em modo somente leitura e decide o COMMIT.
    await db.query('SET TRANSACTION READ ONLY');
    for (const a of arquivosDe(e, 'postcheck')) await db.query(corpo(a.sql, 'postcheck'));
    registrar({situacao: 'COMMIT_ENVIADO'});
    await db.query('COMMIT');
  } catch (erro) { await db.query('ROLLBACK').catch(() => {}); throw erro; }
}

async function lerTudo(db) {
  const estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  const p = (await somenteLeitura(db, SQL_PRIVILEGIOS)).rows[0];
  const privilegios = {criar: p.criar, papelTrocado: p.papel_trocado, tabelas: p.tabelas ?? {}, funcoes: p.funcoes ?? {}, referencias: p.referencias ?? {}};
  return {estado, privilegios, faltas: faltasDePrivilegio(estado, privilegios)};
}

/** Lista de arquivos .json de uma pasta (só nomes), sem seguir links. */
function nomesJson(dir, fsImpl = fs) {
  try { if (fsImpl.lstatSync(dir).isSymbolicLink()) return ['PASTA_E_LINK']; return fsImpl.readdirSync(dir).filter(x => x.endsWith('.json')).sort(); }
  catch { return []; }
}
/** Registros de backup do P1 (sem abrir o dump): nome, idade em horas, PITR, pacote e leitura integral. */
function registrosBackup(dir = DIR_LANCAMENTO, agora = Date.now(), fsImpl = fs, hashLancamento) {
  return nomesJson(dir, fsImpl).filter(x => /^backup-[A-Za-z0-9-]+\.json$/.test(x)).map(nome => {
    try {
      const b = JSON.parse(fsImpl.readFileSync(path.posix.join(dir, nome), 'utf8'));
      return {registro: path.posix.join(dir, nome), idadeHoras: Math.round((agora - Date.parse(b.criadoEm)) / 360000) / 10,
        pitrIdadeHoras: Math.round((agora - Date.parse(b.pitrConferidoEm)) / 360000) / 10, pacoteConfere: b.manifestoSha256 === hashLancamento,
        integralmenteLido: b.arquivoIntegralmenteLido === true};
    } catch { return {registro: path.posix.join(dir, nome), ilegivel: true}; }
  });
}
function discoLivreMb(dir = DISCO) { try { const s = fs.statfsSync(dir); return Math.floor(Number(s.bavail) * Number(s.bsize) / 1048576); } catch { return null; } }

/** Nomes de marcadores anteriores (deste pacote e do lançamento) de uma migration. */
function marcadoresDe(id, {dir = DIR, dirLancamento = DIR_LANCAMENTO, fsImpl = fs} = {}) {
  const proprio = new RegExp(`^(?:migration|lancamento)-${id}(?:\\.tentativa-\\d+)?\\.json$`);
  const doPacote = nomesJson(dir, fsImpl).filter(x => proprio.test(x));
  // Do lançamento só importa o marcador ativo (migration-<id>.json): é ele que faz o filho falhar em EEXIST.
  const doLancamento = DO_LANCAMENTO.includes(id) ? nomesJson(dirLancamento, fsImpl).filter(x => x === `migration-${id}.json`) : [];
  return {doPacote, doLancamento};
}

/**
 * Verificações em READ ONLY que antecipam o que só falharia no MEIO da aplicação (P2-2 e P3-1 da revisão de 19/10):
 * marcadores anteriores de migrations ainda ausentes (exigem retomada explícita), prechecks de TODAS as migrations
 * ausentes que só dependem da base atual e as condições de dados dos postchecks (kidmais; 7 categorias da 078).
 * `retomar` dispensa só o marcador daquela migration. Devolve a lista; falha = item com `falha`.
 */
async function verificacoesPrevias(db, sequencia, estado, {retomar = null, dir = DIR, dirLancamento = DIR_LANCAMENTO, fsImpl = fs} = {}) {
  const v = [];
  for (const e of sequencia) {
    if (estado[e.id] !== 'AUSENTE' || e.id === retomar) continue;
    const m = marcadoresDe(e.id, {dir, dirLancamento, fsImpl});
    if (m.doPacote.length || m.doLancamento.length)
      v.push({id: e.id, falha: `MARCADOR_ANTERIOR ${[...m.doPacote, ...m.doLancamento.map(x => 'lancamento/' + x)].join(',')} (retomada explícita exigida)`});
  }
  for (const e of sequencia) {
    if (estado[e.id] !== 'AUSENTE') continue;
    if (!PRECHECK_INDEPENDENTE.includes(e.id)) { v.push({id: e.id, precheck: arquivosDe(e, 'precheck').length ? 'DEPENDE_DE_ANTERIOR' : 'SEM_PRECHECK_EXTERNO'}); continue; }
    try {
      for (const a of arquivosDe(e, 'precheck')) exigirPrecheck(e.id, await somenteLeitura(db, corpo(a.sql, 'precheck')));
      v.push({id: e.id, precheck: 'PASS'});
    } catch (erro) { v.push({id: e.id, precheck: 'FALHA', falha: curta(erro)}); }
  }
  const a = (await somenteLeitura(db, SQL_ANTECIPACOES)).rows[0];
  if (estado['077'] === 'AUSENTE' || estado['078'] === 'AUSENTE')
    v.push(a.kidmais === 1 && a.kidmais_ativa === 1 ? {id: '077/078', antecipacao: 'PASS'}
      : {id: '077/078', antecipacao: 'FALHA', falha: `ANTECIPACAO_KIDMAIS kidmais=${a.kidmais} ativa=${a.kidmais_ativa}`});
  if (estado['078'] === 'AUSENTE')
    v.push(a.categorias_originais === CATEGORIAS_ORIGINAIS.length ? {id: '078', antecipacao: 'PASS'}
      : {id: '078', antecipacao: 'FALHA', falha: `ANTECIPACAO_078 categorias originais ${a.categorias_originais}/${CATEGORIAS_ORIGINAIS.length} (postcheck da 078 falharia)`});
  return v;
}

/** CONFERIR: nenhuma escrita no banco nem no disco. Identidade, flags, privilégios, estado, checks aplicáveis, agregados. */
async function conferirNoCliente(db, {sequencia, env = {}, identidade = conferirIdentidade, dir = DIR, dirLancamento = DIR_LANCAMENTO, fsImpl = fs}) {
  const r = {modo: 'CONFERENCIA_SOMENTE_LEITURA', verificacoes: []};
  r.conexao = identidade((await somenteLeitura(db, SQL_IDENTIDADE)).rows[0]);
  r.flagsLigadas = flagsLigadas(env);
  Object.assign(r, await lerTudo(db));
  r.situacao = (await somenteLeitura(db, SQL_SITUACAO)).rows[0];
  r.impressaoSchema = (await somenteLeitura(db, SQL_IMPRESSAO)).rows[0];
  try { r.plano = planoEtapas(sequencia, r.estado, r.faltas); } catch (e) { r.planoRecusado = curta(e); }
  for (const e of sequencia) {
    if (r.estado[e.id] !== 'COMPLETA') continue;
    try { await postcheckSomenteLeitura(db, e); r.verificacoes.push({id: e.id, postcheck: 'PASS'}); }
    catch (erro) { r.verificacoes.push({id: e.id, postcheck: 'FALHA', falha: curta(erro)}); }
  }
  r.verificacoes.push(...await verificacoesPrevias(db, sequencia, r.estado, {dir, dirLancamento, fsImpl}));
  const falhou = r.verificacoes.some(v => v.falha);
  r.resultado = r.planoRecusado || falhou || r.flagsLigadas.length ? 'RECUSARIA' : 'CONFERIDO';
  return r;
}

/** Marcadores exclusivos deste pacote (`base` = migration-<id> ou lancamento-<id>): primeira tentativa ou retomada explícita. */
function tentativa(dir, base, retomar, fsImpl = fs) {
  if (/^[0-9a-z]{3,4}$/.test(base)) base = `migration-${base}`;
  const anteriores = nomesJson(dir, fsImpl).filter(x => x === base + '.json' || new RegExp(`^${base}\\.tentativa-\\d+\\.json$`).test(x));
  if (!anteriores.length) return {arquivo: path.posix.join(dir, base + '.json'), numero: 1, anteriores};
  assert.ok(retomar, 'TENTATIVA_ANTERIOR_REVISAR ' + anteriores.join(','));
  for (const a of anteriores) {
    let reg; try { reg = JSON.parse(fsImpl.readFileSync(path.posix.join(dir, a), 'utf8')); } catch { throw new Error('TENTATIVA_ILEGIVEL ' + a); }
    assert.notEqual(reg.situacao, 'COMMIT_CONFIRMADO', 'JA_CONFIRMADA ' + a);
  }
  const numero = anteriores.length + 1;
  return {arquivo: path.posix.join(dir, `${base}.tentativa-${numero}.json`), numero, anteriores};
}
/**
 * Retomada de 074a–078 sem alterar o aplicador do lançamento: o marcador ativo dele (`migration-<id>.json`, gravado com
 * `wx` antes de conectar) é lido, recusado se disser COMMIT_CONFIRMADO, e RENOMEADO para `.tentativa-<n>` (registro no
 * marcador deste pacote antes do rename). Sem marcador do lançamento: nada a fazer.
 */
function prepararMarcadorLancamento(id, retomar, {dirLancamento = DIR_LANCAMENTO, fsImpl = fs} = {}) {
  const ativo = path.posix.join(dirLancamento, `migration-${id}.json`);
  if (!fsImpl.existsSync(ativo)) return null;
  assert.ok(retomar, 'TENTATIVA_ANTERIOR_LANCAMENTO_REVISAR ' + ativo);
  let anterior; try { anterior = JSON.parse(fsImpl.readFileSync(ativo, 'utf8')); } catch { throw new Error('MARCADOR_LANCAMENTO_ILEGIVEL ' + ativo); }
  assert.notEqual(anterior.situacao, 'COMMIT_CONFIRMADO', 'JA_CONFIRMADA ' + ativo);
  let n = 2; while (fsImpl.existsSync(path.posix.join(dirLancamento, `migration-${id}.tentativa-${n}.json`))) n++;
  return {ativo, renomearPara: path.posix.join(dirLancamento, `migration-${id}.tentativa-${n}.json`), situacaoAnterior: anterior.situacao ?? null};
}

/** Processo filho do aplicador revisado do lançamento (uma migration ausente por processo; marcador próprio dele). */
function rodarLancamento(id, backup, {dir = __dirname, executar = spawnSync} = {}) {
  const p = executar(process.execPath, [path.join(dir, 'migrations-lancamento-production.cjs'), '--aplicar-migration-autorizada', id, '--backup', backup],
    {encoding: 'utf8', env: process.env, timeout: 300000, killSignal: 'SIGTERM'});
  const ok = !p.error && !p.signal && p.status === 0;
  let saida = null;
  try { saida = JSON.parse(String(p.stdout || '').trim().split('\n').at(-1)); } catch { /* saída não JSON */ }
  return {ok: ok && saida?.id === id && saida?.resultado === 'APLICADA_POSTCHECK_PASS', saida, erro: ok ? null : curta(p.stderr || p.stdout || p.signal || p.error || 'SEM_SAIDA')};
}

/**
 * APLICAR (sequência, para na primeira falha). `deps` existe para os testes e o ensaio local: cliente já conectado,
 * identidade, pastas dos marcadores, sistema de arquivos e executor do lançamento.
 */
async function aplicarNoCliente(db, {sequencia, backup, retomar = null, identidade = conferirIdentidade, dir = DIR, dirLancamento = DIR_LANCAMENTO, fsImpl = fs,
  lancamento = id => rodarLancamento(id, backup), relogio = () => new Date().toISOString()}) {
  const r = {modo: retomar ? 'RETOMADA' : 'APLICACAO', etapas: []};
  r.conexao = identidade((await somenteLeitura(db, SQL_IDENTIDADE)).rows[0]);
  assert.equal((await db.query(SQL_TRAVA)).rows[0]?.trava, true, 'EXECUCAO_CONCORRENTE');
  try {
    const antes = await lerTudo(db);
    r.estadoAntes = antes.estado;
    r.situacaoAntes = (await somenteLeitura(db, SQL_SITUACAO)).rows[0];
    r.plano = planoEtapas(sequencia, antes.estado, antes.faltas);
    if (retomar) assert.ok(r.plano.some(p => p.id === retomar && p.acao.startsWith('APLICAR')), 'RETOMADA_RECUSADA ' + retomar);
    // Antes da 1ª escrita: as mesmas antecipações da conferência (marcadores, prechecks independentes, dados).
    r.verificacoesPrevias = await verificacoesPrevias(db, sequencia, antes.estado, {retomar, dir, dirLancamento, fsImpl});
    const recusa = r.verificacoesPrevias.find(v => v.falha);
    assert.ok(!recusa, 'VERIFICACAO_PREVIA ' + (recusa ? `${recusa.id}: ${recusa.falha}` : ''));
    fsImpl.mkdirSync(dir, {recursive: true, mode: 0o700});
    for (const passo of r.plano) {
      const e = sequencia.find(x => x.id === passo.id);
      const etapa = {id: e.id, acao: passo.acao, inicio: relogio()};
      r.etapas.push(etapa);
      try {
        if (passo.acao === 'POSTCHECK') { await postcheckSomenteLeitura(db, e); etapa.resultado = 'JA_APLICADA_POSTCHECK_PASS'; }
        else {
          const lanc = passo.acao === 'APLICAR_LANCAMENTO';
          const t = tentativa(dir, `${lanc ? 'lancamento' : 'migration'}-${e.id}`, retomar === e.id, fsImpl);
          const marcador = {id: e.id, tentativa: t.numero, inicio: etapa.inicio, aplicador: lanc ? 'lancamento (processo filho)' : 'este pacote',
            arquivos: e.arquivos.map(a => ({tipo: a.tipo, arquivo: a.arquivo, sha256: a.sha256})), situacao: 'INICIADA'};
          const prep = lanc ? prepararMarcadorLancamento(e.id, retomar === e.id, {dirLancamento, fsImpl}) : null;
          if (prep) marcador.marcadorDoLancamentoAnterior = {arquivo: prep.ativo, situacao: prep.situacaoAnterior, renomeadoPara: prep.renomearPara};
          fsImpl.writeFileSync(t.arquivo, JSON.stringify(marcador, null, 2), {flag: 'wx', mode: 0o600});
          const salvar = x => { Object.assign(marcador, x, {em: relogio()}); fsImpl.writeFileSync(t.arquivo, JSON.stringify(marcador, null, 2), {mode: 0o600}); };
          etapa.marcador = t.arquivo;
          if (prep) { assert.ok(!fsImpl.existsSync(prep.renomearPara), 'RENOMEACAO_RECUSADA ' + prep.renomearPara); fsImpl.renameSync(prep.ativo, prep.renomearPara); salvar({situacao: 'MARCADOR_DO_LANCAMENTO_RENOMEADO'}); }
          try {
            if (lanc) {
              salvar({situacao: 'PROCESSO_FILHO_EM_EXECUCAO'});
              const x = await lancamento(e.id);
              const depois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0])[e.id];
              // O marcador do filho fica ANTES_DA_TRANSACAO mesmo depois de ROLLBACK: a situação verdadeira fica neste.
              if (!x.ok) { salvar({situacao: depois === 'AUSENTE' ? 'FALHA_SCHEMA_AUSENTE' : 'FALHA_SCHEMA_' + depois, falha: x.erro ?? 'SEM_SAIDA'}); throw new Error('LANCAMENTO_FALHOU ' + e.id + (x.erro ? ' ' + x.erro : '')); }
              assert.equal(depois, 'COMPLETA', 'COMMIT_NAO_CONFIRMADO ' + e.id);
              // O postcheck do lançamento rodou na transação de escrita dele; aqui roda de novo em READ ONLY.
              await postcheckSomenteLeitura(db, e);
              salvar({situacao: 'COMMIT_CONFIRMADO', postcheckSomenteLeitura: 'PASS'});
              etapa.resultado = x.saida.resultado;
            } else {
              await aplicarEtapa(db, e, {registrar: salvar});
              const depois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
              assert.equal(depois[e.id], 'COMPLETA', 'COMMIT_NAO_CONFIRMADO ' + e.id);
              salvar({situacao: 'COMMIT_CONFIRMADO'});
              etapa.resultado = 'APLICADA_POSTCHECK_PASS';
            }
          } catch (erro) { if (!String(marcador.situacao).startsWith('FALHA')) salvar({situacao: 'FALHA', falha: curta(erro)}); throw erro; }
        }
        etapa.fim = relogio();
      } catch (erro) { etapa.falha = curta(erro); throw erro; }
    }
    r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
    assert.ok(sequencia.every(e => r.estadoDepois[e.id] === 'COMPLETA'), 'ESTADO_FINAL_INCOMPLETO');
    r.situacaoDepois = (await somenteLeitura(db, SQL_SITUACAO)).rows[0];
    r.resultado = 'PASS';
  } catch (erro) {
    r.resultado = 'FALHA';
    r.falha = {etapa: r.etapas.at(-1)?.id ?? 'ANTES_DAS_ETAPAS', mensagem: curta(erro)};
    try { r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]); } catch { /* conexão perdida */ }
  } finally { await db.query(SQL_SOLTAR).catch(() => {}); }
  // Leitura humana da falha: o que ficou confirmado (migrations são atômicas: as demais não mudaram).
  r.confirmadasNestaExecucao = r.etapas.filter(e => e.acao !== 'POSTCHECK' && e.resultado).map(e => e.id);
  r.nenhumaEscrita = r.confirmadasNestaExecucao.length === 0;
  return r;
}

/** Plano sem conexão: confere manifesto e hashes e descreve a sequência. */
function plano({raiz = path.resolve(__dirname, '..')} = {}) {
  const {sequencia} = carregar(raiz);
  return {resultado: 'PLANO', conecta: false, alvo: ALVO, manifesto: {arquivo: MANIFESTO, sha256: HASH_MANIFESTO},
    modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} --backup <registro>`, retomar: `${FLAG_RETOMAR} <id> --backup <registro>`},
    sequencia: sequencia.map(e => ({id: e.id, aplicador: e.aplicador, arquivos: e.arquivos.map(a => ({tipo: a.tipo, arquivo: a.arquivo, sha256: a.sha256}))})),
    marcadores: DIR, backup: DIR_LANCAMENTO + '/backup-*.json (P1 do lançamento)', flagsQueRecusam: FLAGS_ABERTURA,
    codigosDeSaida: CODIGOS_DE_SAIDA, nuncaExecuta: ['reparo dos bloqueios', 'down de migration', 'mudança de variável', 'deploy']};
}
/** Códigos de saída (também no roteiro de recuperação). Qualquer outro código = parar e ler a saída. */
const CODIGOS_DE_SAIDA = Object.freeze({0: 'PLANO / CONFERIDO / PASS', 1: 'recusa antes de conectar (nenhuma escrita)',
  2: 'FALHA: ler confirmadasNestaExecucao/nenhumaEscrita; falha de conexão ou identidade = nenhuma escrita', 3: 'conferência RECUSARIA (nenhuma escrita)'});

/** Argumentos estritos. Retomada: 074a–078 (lançamento) e 060/065/080–083/085/086 (este pacote); nunca 079/084. */
function modo(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--plano')) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  if (argv.length === 3 && argv[0] === FLAG_APLICAR && argv[1] === '--backup') return {modo: 'aplicar', backup: argv[2]};
  if (argv.length === 4 && argv[0] === FLAG_RETOMAR && argv[2] === '--backup' && /^(?:074a|07[5-8]|060|065|08[0-3]|08[56])$/.test(argv[1]))
    return {modo: 'retomar', retomar: argv[1], backup: argv[3]};
  throw new Error('USO_RECUSADO');
}

async function principal(argv, env, {Client = require('pg').Client, raiz = path.resolve(__dirname, '..'), lancamento = require('./migrations-lancamento-production.cjs'),
  disco = () => exigirDisco()} = {}) {
  const m = modo(argv);
  if (m.modo === 'plano') return {codigo: 0, saida: plano({raiz})};
  const {sequencia} = carregar(raiz, {lancamento});
  const opts = alvo(env);
  let backup = null;
  if (m.modo !== 'conferir') {
    disco();
    const ligadas = flagsLigadas(env);
    assert.equal(ligadas.length, 0, 'FLAG_LIGADA ' + ligadas.join(','));
    assert.match(m.backup, /^\/opt\/render\/project\/src\/data\/lancamento-venda-20261011\/backup-[A-Za-z0-9-]+\.json$/, 'REGISTRO_BACKUP_INVALIDO');
    const b = await lancamento.conferirBackup(m.backup);
    backup = {registro: m.backup, criadoEm: b.criadoEm, pitrConferidoEm: b.pitrConferidoEm};
  }
  const db = new Client(opts); db.on?.('error', () => undefined);
  try {
    await db.connect();
    if (m.modo === 'conferir') {
      const s = await conferirNoCliente(db, {sequencia, env});
      s.marcadores = {pacote: nomesJson(DIR), lancamento: nomesJson(DIR_LANCAMENTO).filter(x => !x.startsWith('backup-'))};
      s.backups = registrosBackup(DIR_LANCAMENTO, Date.now(), fs, lancamento.HASH_MANIFESTO);
      s.discoLivreMb = discoLivreMb();
      return {codigo: s.resultado === 'CONFERIDO' ? 0 : 3, saida: s};
    }
    const s = await aplicarNoCliente(db, {sequencia, backup: m.backup, retomar: m.retomar ?? null});
    s.backup = backup; s.certificadoVerificado = opts.ssl.rejectUnauthorized;
    return {codigo: s.resultado === 'PASS' ? 0 : 2, saida: s};
  } catch (e) {
    // Conexão, identidade ou trava: antes de qualquer escrita.
    return {codigo: 2, saida: {resultado: 'FALHA', mensagem: curta(e), nenhumaEscrita: true}};
  } finally { await db.end().catch(() => {}); }
}

if (require.main === module) {
  principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida, null, 1)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
module.exports = {MANIFESTO, HASH_MANIFESTO, ALVO, DIR, DIR_LANCAMENTO, FLAGS_ABERTURA, JA_PRESENTES, DO_LANCAMENTO, PRECHECK_INDEPENDENTE, CATEGORIAS_ORIGINAIS,
  TRAVA, OBJETOS, PRIVILEGIOS, BLOQUEIOS_REPARO, KIDMAIS_ID, CODIGOS_DE_SAIDA,
  SQL_ESTADO, SQL_PRIVILEGIOS, SQL_IDENTIDADE, SQL_SITUACAO, SQL_ANTECIPACOES, SQL_SCHEMA, SQL_IMPRESSAO, SQL_TRAVA, SQL_SOLTAR, corpo, carregar, alvo,
  conferirIdentidade, flagsLigadas, exigirDisco, exigirSearchPath, somenteLeitura, exigirPrecheck, lerEstado, faltasDePrivilegio, planoEtapas, aplicarEtapa,
  postcheckSomenteLeitura, lerTudo, marcadoresDe, verificacoesPrevias, conferirNoCliente, tentativa, prepararMarcadorLancamento, rodarLancamento,
  aplicarNoCliente, plano, modo, principal, registrosBackup, nomesJson};
