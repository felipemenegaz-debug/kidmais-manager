/* eslint-disable @typescript-eslint/no-require-imports */
// Reparo dos cinco bloqueios globais da Kidmais em PRODUÇÃO — executor de 20/10/2026 (V1 da abertura da venda).
//
// O SQL é o MESMO revisado em 11–13/10 (database/repairs/20261011_lancamento_bloqueios_kidmais.sql, sha256 fixo abaixo,
// idêntico ao embutido no corte de 13/10): vincula os cinco bloqueios globais à Kidmais inteira e registra a decisão em
// agenda_062_bloqueios_resolucao. Nada é apagado nem desativado; datas, horários e motivo ficam como estão.
//
// Por que um executor novo (o de 11/10, scripts/reparo-bloqueios-production.cjs, fica intacto como histórico):
//   - não tinha conferência SOMENTE LEITURA (CONFERIR) para rodar antes da autorização;
//   - a identidade conferida era só banco + TLS (aqui: TLS 1.2+, rede privada, PostgreSQL 18, como o pacote de 19/10);
//   - não antecipava o que só falharia dentro da transação (conjunto global, conflito com contratação vigente,
//     gatilhos inesperados, privilégio) nem conferia o estado DEPOIS do COMMIT além da contagem global;
//   - marcador único sem retomada: uma falha de lock_timeout (nada gravado) travaria o reparo para sempre.
// Com as migrations 074a–086 aplicadas em 20/10, nenhuma delas toca bloqueios_agenda nem agenda_062_bloqueios_resolucao
// (o ensaio local confere o mesmo conjunto de gatilhos e o SQL byte a byte).
//
// Modos (exatamente um; outra combinação = recusa antes de ler o ambiente):
//   node scripts/reparo-bloqueios-producao-20261020.cjs                    → PLANO, sem conexão
//   node scripts/reparo-bloqueios-producao-20261020.cjs --conferir         → SOMENTE LEITURA (banco e disco)
//   node scripts/reparo-bloqueios-producao-20261020.cjs --aplicar-autorizado --backup <registro do P1>
//   node scripts/reparo-bloqueios-producao-20261020.cjs --retomar-autorizado --backup <registro do P1>
// Aplicar/retomar: só no Web Shell do srv-dak77m2d0e5s73b8rkkg, flags de abertura desligadas, disco persistente montado,
// registro de backup < 24 h conferido por conferirBackup do aplicador do lançamento (dump íntegro, PITR < 24 h).
// Marcador exclusivo em /opt/render/project/src/data/reparo-bloqueios-producao-20261020 (reparo.json, depois
// reparo.tentativa-<n>.json): tentativa anterior impede repetição automática; retomada só com a flag própria e só com os
// cinco bloqueios INTACTOS (nada gravado antes). O marcador do executor de 11/10 (lancamento-venda-20261011/
// reparo-bloqueios.json), se existir, também impede a aplicação comum.
// Saída: só códigos curtos, booleanos, contagens e datas dos cinco bloqueios; nunca URL, credencial ou dado de cliente.
// Códigos de saída: 0 PLANO/CONFERIDO/REPARO_JA_APLICADO/PASS; 1 recusa antes de conectar; 2 FALHA; 3 conferência RECUSARIA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const SQL_ARQUIVO = 'database/repairs/20261011_lancamento_bloqueios_kidmais.sql';
const SQL_SHA256 = 'a36f8fe981d226e9ac96f1d83677666dc142265bb64ad6b19f720f982c223f85';
const AUTORIZACAO = 'cinco-bloqueios-kidmais-20261011';
const ALVO = Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', host: 'dpg-dak750gae00c73fudmg0-a', database: 'kidmais_production', port: 5432});
const KIDMAIS_ID = '7e990a2b-e64b-4630-9aae-4646fe936ede';
/** Os cinco bloqueios do SQL revisado (ids e datas), na ordem do arquivo. */
const ALVOS = Object.freeze([
  Object.freeze({ordem: 1, id: '57618aab-a62c-4be1-9385-17308ac8dda3', data: '2026-10-15'}),
  Object.freeze({ordem: 2, id: '3b06e365-7ac1-42e6-ba1a-6b82de76af8b', data: '2026-11-01'}),
  Object.freeze({ordem: 3, id: '11b9459d-35f8-4a9f-8e6f-aeb7311ff651', data: '2026-11-07'}),
  Object.freeze({ordem: 4, id: 'e4cc53fd-b423-46bc-98b4-86b318a0d688', data: '2026-11-13'}),
  Object.freeze({ordem: 5, id: 'd4e6cf8c-1b42-4bd1-8d18-1750cc3b958e', data: '2027-05-27'}),
]);
const DISCO = '/opt/render/project/src/data';
const DIR = path.posix.join(DISCO, 'reparo-bloqueios-producao-20261020');
const DIR_LANCAMENTO = path.posix.join(DISCO, 'lancamento-venda-20261011');
const MARCADOR_LEGADO = 'reparo-bloqueios.json';
const FLAG_CONFERIR = '--conferir';
const FLAG_APLICAR = '--aplicar-autorizado';
const FLAG_RETOMAR = '--retomar-autorizado';
/** Interruptores da venda: ligado (= 'true', como o código lê) recusa a aplicação e faz a conferência dizer RECUSARIA. */
const FLAGS_ABERTURA = Object.freeze(['CADASTRO_PUBLICO_ATIVO', 'ASSINATURA_PLANOS_ATIVOS', 'COTACAO_PUBLICA_POR_EMPRESA']);
/** Gatilhos (não internos) esperados nas duas tabelas tocadas: 005 (atualizado_em), 014 (proteção de revisão) e 062 (unidade). */
const GATILHOS_ESPERADOS = Object.freeze(['agenda_062_bloqueios_resolucao:-', 'bloqueios_agenda:bloqueios_agenda_062_unidade_trg:O',
  'bloqueios_agenda:bloqueios_agenda_atualizado_em_trg:O', 'bloqueios_agenda:fr_bloqueio_proteger_trg:O']);
/** Trava consultiva de sessão própria deste executor (pg_try_advisory_lock(int,int)). */
const TRAVA = Object.freeze([20261020, 5]);
const CODIGOS_DE_SAIDA = Object.freeze({0: 'PLANO / CONFERIDO / REPARO_JA_APLICADO / PASS', 1: 'recusa antes de conectar (nenhuma escrita)',
  2: 'FALHA: ler gravado/situacaoDepois; falha de conexão, identidade ou trava = nenhuma escrita', 3: 'conferência RECUSARIA (nenhuma escrita)'});

const sha = s => createHash('sha256').update(s).digest('hex');
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').replace(/\s+/g, ' ').slice(0, 160);

/** SQL revisado, LF, conferido pelo sha256 fixo. */
function lerSql(raiz = path.resolve(__dirname, '..')) {
  const texto = fs.readFileSync(path.join(raiz, SQL_ARQUIVO), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!texto.includes('\r'), 'SQL_CR_ISOLADO');
  assert.ok(sha(texto) === SQL_SHA256, 'SQL_DIVERGENTE');
  return texto;
}

/** Trava de alvo (mesma do pacote de migrations de 19/10): web de produção, host interno exato, banco, porta, TLS, URL sem query. */
function alvo(env) {
  assert.ok(env.RENDER === 'true', 'FORA_DO_RENDER');
  assert.ok(env.RENDER_SERVICE_ID === ALVO.servico, 'SERVICO_RECUSADO');
  assert.ok(env.KIDMAIS_DEPLOY_ENV === 'production', 'AMBIENTE_RECUSADO');
  assert.ok(env.DATABASE_SSL === 'true', 'TLS_OBRIGATORIO');
  let u;
  try { u = new URL(env.DATABASE_URL); } catch { assert.fail('URL_RECUSADA'); }
  assert.ok(['postgres:', 'postgresql:'].includes(u.protocol), 'URL_RECUSADA');
  assert.ok(u.hostname === ALVO.host && !u.hostname.includes('.'), 'HOST_RECUSADO');
  assert.ok(decodeURIComponent(u.pathname.slice(1)) === ALVO.database, 'BANCO_RECUSADO');
  assert.ok(!u.port || Number(u.port) === ALVO.port, 'PORTA_RECUSADA');
  assert.ok(u.search === '', 'CONNECTION_QUERY_REJECTED');
  return {connectionString: env.DATABASE_URL, ssl: {rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false', minVersion: 'TLSv1.2'},
    application_name: 'kidmais-reparo-bloqueios-20261020', connectionTimeoutMillis: 10000};
}
const SQL_IDENTIDADE = `SELECT current_database() AS db,
  (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
  (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls_versao,
  coalesce(inet_server_addr() << ANY('{10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}'::inet[]), false) AS servidor_privado,
  current_setting('server_version_num')::int / 10000 AS pg_major`;
function conferirIdentidade(id) {
  assert.ok(id?.db === ALVO.database, 'BANCO_DIVERGENTE');
  assert.ok(id.tls === true, 'SEM_TLS');
  assert.ok(['TLSv1.2', 'TLSv1.3'].includes(id.tls_versao), 'TLS_VERSAO_RECUSADA');
  assert.ok(id.servidor_privado === true, 'SERVIDOR_FORA_DA_REDE_PRIVADA');
  assert.ok(Number(id.pg_major) === 18, 'VERSAO_POSTGRES_DIVERGENTE');
  return {banco: id.db, tls: true, tlsVersao: id.tls_versao, servidorPrivado: true, pgMajor: 18};
}
function flagsLigadas(env) { return FLAGS_ABERTURA.filter(k => String(env[k] ?? '').trim().toLowerCase() === 'true'); }
function exigirDisco(disco = DISCO, stat = fs.lstatSync) {
  let d, pai;
  try { d = stat(disco); pai = stat(path.dirname(disco)); } catch { d = null; }
  assert.ok(d && d.isDirectory() && !d.isSymbolicLink() && d.dev !== pai.dev, 'DISCO_PERSISTENTE_AUSENTE');
}

/** Pré-requisitos do SQL revisado (062 e 014) e privilégios do papel conectado. Só catálogo: roda em qualquer schema. */
const SQL_SCHEMA = `SELECT
  to_regclass('public.bloqueios_agenda') IS NOT NULL AS tabela_bloqueios,
  to_regclass('public.agenda_062_bloqueios_resolucao') IS NOT NULL AS tabela_resolucao,
  to_regclass('public.empresas') IS NOT NULL AS tabela_empresas,
  EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.bloqueios_agenda') AND attname = 'empresa_id' AND attnum > 0 AND NOT attisdropped) AS coluna_empresa,
  EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.bloqueios_agenda') AND attname = 'estabelecimento_id' AND attnum > 0 AND NOT attisdropped) AS coluna_unidade,
  to_regprocedure('public.kidmais_lock_datas_revisao(date[])') IS NOT NULL AS funcao_trava_datas,
  to_regprocedure('public.kidmais062_bloqueio_aplica(uuid,uuid,uuid,uuid)') IS NOT NULL AS funcao_alcance,
  to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NOT NULL AS funcao_ocupacoes,
  (SELECT coalesce(array_agg(x ORDER BY x), '{}') FROM (
     SELECT 'agenda_062_bloqueios_resolucao:-' AS x
      WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.agenda_062_bloqueios_resolucao') AND NOT tgisinternal)
     UNION ALL SELECT c.relname || ':' || t.tgname || ':' || t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgrelid IN (to_regclass('public.bloqueios_agenda'), to_regclass('public.agenda_062_bloqueios_resolucao')) AND NOT t.tgisinternal) g) AS gatilhos,
  (current_user <> session_user) AS papel_trocado`;
const SQL_PRIVILEGIOS = `SELECT
  has_table_privilege(current_user, 'public.bloqueios_agenda', 'SELECT') AND has_table_privilege(current_user, 'public.bloqueios_agenda', 'UPDATE') AS bloqueios,
  has_table_privilege(current_user, 'public.agenda_062_bloqueios_resolucao', 'SELECT') AND has_table_privilege(current_user, 'public.agenda_062_bloqueios_resolucao', 'INSERT')
    AND has_table_privilege(current_user, 'public.agenda_062_bloqueios_resolucao', 'UPDATE') AS resolucao,
  has_table_privilege(current_user, 'public.empresas', 'SELECT') AS empresas,
  has_function_privilege(current_user, 'public.kidmais_lock_datas_revisao(date[])', 'EXECUTE') AS trava_datas`;
const valores = ALVOS.map(a => `(${a.ordem}, '${a.id}'::uuid, '${a.data}'::date)`).join(', ');
const K = `'${KIDMAIS_ID}'::uuid`;
/**
 * Situação dos cinco alvos e agregados (sem dados pessoais): as mesmas condições das conferências do SQL revisado,
 * mais o que só falharia dentro da transação (conflito com contratação vigente, pelo gatilho fr_bloqueio_proteger_trg).
 */
const SQL_SITUACAO = `WITH alvo(ordem, id, data) AS (VALUES ${valores})
SELECT current_date::text AS hoje,
  (SELECT count(*) FROM public.empresas)::int AS empresas,
  (SELECT count(*) FROM public.empresas WHERE codigo = 'kidmais')::int AS kidmais,
  EXISTS (SELECT 1 FROM public.empresas WHERE id = ${K} AND codigo = 'kidmais' AND status = 'ATIVA') AS kidmais_id_confere,
  (SELECT jsonb_agg(jsonb_build_object('ordem', a.ordem, 'data', a.data::text, 'passado', a.data < current_date,
     'existe', b.id IS NOT NULL, 'data_confere', b.data IS NOT DISTINCT FROM a.data, 'ativo', coalesce(b.ativo, false),
     'sem_empresa', b.id IS NOT NULL AND b.empresa_id IS NULL, 'da_kidmais', b.empresa_id IS NOT DISTINCT FROM ${K},
     'sem_unidade', b.id IS NOT NULL AND b.estabelecimento_id IS NULL,
     'formato', coalesce(NOT b.dia_inteiro AND b.horario_inicio = '17:00'::time AND b.horario_fim = '21:00'::time, false),
     'resolucao', r.bloqueio_id IS NOT NULL,
     'resolucao_kidmais', r.bloqueio_id IS NOT NULL AND r.empresa_id = ${K} AND r.estabelecimento_id IS NULL,
     'conflitos', (SELECT count(*) FROM public.kidmais062_ocupacoes_escopo(a.data, a.data) o
        WHERE public.kidmais062_bloqueio_aplica(${K}, NULL, o.empresa_id, o.estabelecimento_id)
          AND o.horario_inicio < '21:00'::time AND o.horario_fim > '17:00'::time)::int) ORDER BY a.ordem)
     FROM alvo a LEFT JOIN public.bloqueios_agenda b ON b.id = a.id LEFT JOIN public.agenda_062_bloqueios_resolucao r ON r.bloqueio_id = a.id) AS alvos,
  (SELECT count(*) FROM public.bloqueios_agenda WHERE ativo AND empresa_id IS NULL)::int AS globais_ativos,
  (SELECT count(*) FROM public.bloqueios_agenda WHERE ativo AND empresa_id IS NULL AND data >= current_date)::int AS globais_futuros,
  (SELECT count(*) FROM public.bloqueios_agenda WHERE ativo AND empresa_id IS NULL AND data >= current_date AND id NOT IN (SELECT id FROM alvo))::int AS globais_futuros_fora_do_alvo,
  (SELECT count(*) FROM public.bloqueios_agenda WHERE ativo AND empresa_id IS NULL AND data < current_date AND id NOT IN (SELECT id FROM alvo))::int AS globais_passados_fora_do_alvo,
  (SELECT count(*) FROM public.bloqueios_agenda)::int AS bloqueios_total,
  (SELECT count(*) FROM public.bloqueios_agenda WHERE ativo)::int AS bloqueios_ativos,
  (SELECT count(*) FROM public.bloqueios_agenda WHERE ativo AND empresa_id = ${K})::int AS bloqueios_ativos_kidmais,
  (SELECT count(*) FROM public.agenda_062_bloqueios_resolucao)::int AS resolucoes_total`;
const SQL_TRAVA = `SELECT pg_try_advisory_lock(${TRAVA[0]}, ${TRAVA[1]}) AS trava`;
const SQL_SOLTAR = `SELECT pg_advisory_unlock(${TRAVA[0]}, ${TRAVA[1]}) AS solta`;

async function somenteLeitura(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL statement_timeout = '30s'");
    await db.query("SET LOCAL lock_timeout = '5s'");
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}

/** INTACTO (como o SQL exige), REPARADO (como o SQL deixa), AUSENTE ou DIVERGENTE. */
function classificar(a) {
  if (!a.existe) return 'AUSENTE';
  const base = a.data_confere && a.ativo && a.sem_unidade && a.formato;
  if (base && a.sem_empresa && !a.resolucao) return 'INTACTO';
  if (base && a.da_kidmais && a.resolucao && a.resolucao_kidmais) return 'REPARADO';
  return 'DIVERGENTE';
}
/** Avaliação pura (testável): APTO, JA_APLICADO ou RECUSARIA com motivos curtos. */
function avaliar(schema, privilegios, s) {
  const motivos = [];
  for (const k of ['tabela_bloqueios', 'tabela_resolucao', 'tabela_empresas', 'coluna_empresa', 'coluna_unidade', 'funcao_trava_datas', 'funcao_alcance', 'funcao_ocupacoes'])
    if (schema?.[k] !== true) motivos.push('SCHEMA_AUSENTE ' + k);
  if (motivos.length) return {resultado: 'RECUSARIA', motivos, alvos: []};
  const gatilhos = [...(schema.gatilhos ?? [])].sort();
  if (JSON.stringify(gatilhos) !== JSON.stringify([...GATILHOS_ESPERADOS].sort())) motivos.push('GATILHOS_DIVERGENTES ' + gatilhos.join(','));
  for (const [k, v] of Object.entries(privilegios ?? {})) if (v !== true) motivos.push('SEM_PRIVILEGIO ' + k);
  if (!s) return {resultado: 'RECUSARIA', motivos: [...motivos, 'SITUACAO_ILEGIVEL'], alvos: []};
  if (s.kidmais !== 1 || s.kidmais_id_confere !== true) motivos.push(`IDENTIDADE_KIDMAIS_DIVERGENTE kidmais=${s.kidmais} id_confere=${s.kidmais_id_confere}`);
  const alvos = (s.alvos ?? []).map(a => ({ordem: a.ordem, data: a.data, passado: a.passado, estado: classificar(a), conflitos: a.conflitos}));
  assert.ok(alvos.length === ALVOS.length, 'ALVOS_ILEGIVEIS');
  const estados = new Set(alvos.map(a => a.estado));
  let resultado;
  if (estados.size === 1 && estados.has('INTACTO')) {
    if (s.globais_futuros_fora_do_alvo !== 0) motivos.push(`CONJUNTO_GLOBAL_DIVERGENTE fora_do_alvo=${s.globais_futuros_fora_do_alvo}`);
    const conflitos = alvos.filter(a => a.conflitos !== 0);
    if (conflitos.length) motivos.push('CONFLITO_COM_CONTRATACAO_VIGENTE ' + conflitos.map(a => `${a.data}:${a.conflitos}`).join(','));
    resultado = motivos.length ? 'RECUSARIA' : 'APTO';
  } else if (estados.size === 1 && estados.has('REPARADO')) {
    if (s.globais_futuros !== 0) motivos.push(`GLOBAL_FUTURO_RESTANTE ${s.globais_futuros}`);
    resultado = motivos.length ? 'RECUSARIA' : 'JA_APLICADO';
  } else {
    motivos.push('ALVOS_MISTOS_OU_DIVERGENTES ' + alvos.map(a => `${a.ordem}:${a.estado}`).join(','));
    resultado = 'RECUSARIA';
  }
  return {resultado, motivos, alvos};
}
/** Leitura completa em transações READ ONLY. A situação só é lida com o schema completo (senão as consultas nem compilam). */
async function lerEstado(db) {
  const schema = (await somenteLeitura(db, SQL_SCHEMA)).rows[0];
  const completo = ['tabela_bloqueios', 'tabela_resolucao', 'tabela_empresas', 'coluna_empresa', 'coluna_unidade', 'funcao_trava_datas', 'funcao_alcance', 'funcao_ocupacoes']
    .every(k => schema[k] === true);
  const privilegios = completo ? (await somenteLeitura(db, SQL_PRIVILEGIOS)).rows[0] : null;
  const situacao = completo ? (await somenteLeitura(db, SQL_SITUACAO)).rows[0] : null;
  const avaliacao = avaliar(schema, privilegios, situacao);
  const agregados = situacao ? Object.fromEntries(Object.entries(situacao).filter(([k]) => k !== 'alvos')) : null;
  return {schema: {...schema, papel_trocado: schema.papel_trocado}, privilegios, agregados, ...avaliacao};
}

/** Nomes .json de uma pasta (sem seguir links). */
function nomesJson(dir, fsImpl = fs) {
  try { if (fsImpl.lstatSync(dir).isSymbolicLink()) return ['PASTA_E_LINK']; return fsImpl.readdirSync(dir).filter(x => x.endsWith('.json')).sort(); }
  catch { return []; }
}
/** Marcadores deste executor e o do executor de 11/10. */
function marcadores({dir = DIR, dirLancamento = DIR_LANCAMENTO, fsImpl = fs} = {}) {
  return {proprios: nomesJson(dir, fsImpl).filter(x => /^reparo(?:\.tentativa-\d+)?\.json$/.test(x)),
    legado: nomesJson(dirLancamento, fsImpl).includes(MARCADOR_LEGADO) ? path.posix.join(dirLancamento, MARCADOR_LEGADO) : null};
}
/** Arquivo do marcador desta tentativa: primeira, ou retomada explícita (nunca depois de COMMIT_CONFIRMADO). */
function tentativa(retomar, {dir = DIR, dirLancamento = DIR_LANCAMENTO, fsImpl = fs} = {}) {
  const m = marcadores({dir, dirLancamento, fsImpl});
  const anteriores = m.proprios;
  if (m.legado) assert.ok(retomar, 'MARCADOR_LEGADO_REVISAR ' + m.legado);
  if (!anteriores.length) return {arquivo: path.posix.join(dir, 'reparo.json'), numero: 1, anteriores, legado: m.legado};
  assert.ok(retomar, 'TENTATIVA_ANTERIOR_REVISAR ' + anteriores.join(','));
  for (const a of anteriores) {
    let reg; try { reg = JSON.parse(fsImpl.readFileSync(path.posix.join(dir, a), 'utf8')); } catch { throw new Error('TENTATIVA_ILEGIVEL ' + a); }
    assert.ok(reg.situacao !== 'COMMIT_CONFIRMADO', 'JA_CONFIRMADA ' + a);
  }
  const numero = anteriores.length + 1;
  return {arquivo: path.posix.join(dir, `reparo.tentativa-${numero}.json`), numero, anteriores, legado: m.legado};
}

/** CONFERIR: nenhuma escrita no banco nem no disco. */
async function conferirNoCliente(db, {env = {}, identidade = conferirIdentidade, dir = DIR, dirLancamento = DIR_LANCAMENTO, fsImpl = fs} = {}) {
  const r = {modo: 'CONFERENCIA_SOMENTE_LEITURA'};
  r.conexao = identidade((await somenteLeitura(db, SQL_IDENTIDADE)).rows[0]);
  r.flagsLigadas = flagsLigadas(env);
  Object.assign(r, await lerEstado(db));
  r.estadoDoReparo = r.resultado;
  r.marcadores = marcadores({dir, dirLancamento, fsImpl});
  const pendencias = [];
  if (r.flagsLigadas.length) pendencias.push('FLAG_LIGADA ' + r.flagsLigadas.join(','));
  if (r.estadoDoReparo === 'APTO' && (r.marcadores.proprios.length || r.marcadores.legado))
    pendencias.push('MARCADOR_ANTERIOR (nada gravado: so com --retomar-autorizado, depois de ler o marcador)');
  r.motivos = [...r.motivos, ...pendencias];
  r.resultado = r.estadoDoReparo === 'JA_APLICADO' ? 'REPARO_JA_APLICADO' : r.estadoDoReparo === 'APTO' && !pendencias.length ? 'CONFERIDO' : 'RECUSARIA';
  return r;
}

/**
 * APLICAR/RETOMAR numa conexão já aberta. Antes da escrita: identidade, trava, estado APTO, marcador exclusivo. O SQL
 * revisado roda inteiro (BEGIN … COMMIT dele mesmo) com a autorização de sessão; depois, leitura READ ONLY exige os
 * cinco REPARADOS, nenhum global futuro, datas/horários/ativo e totais preservados (+5 resoluções).
 */
async function aplicarNoCliente(db, {sql, retomar = false, identidade = conferirIdentidade, dir = DIR, dirLancamento = DIR_LANCAMENTO, fsImpl = fs,
  relogio = () => new Date().toISOString()}) {
  assert.ok(sha(sql) === SQL_SHA256, 'SQL_DIVERGENTE');
  const r = {modo: retomar ? 'RETOMADA' : 'APLICACAO', gravado: false};
  r.conexao = identidade((await somenteLeitura(db, SQL_IDENTIDADE)).rows[0]);
  assert.ok((await db.query(SQL_TRAVA)).rows[0]?.trava === true, 'EXECUCAO_CONCORRENTE');
  let marcador = null, arquivo = null;
  const salvar = x => { Object.assign(marcador, x, {em: relogio()}); fsImpl.writeFileSync(arquivo, JSON.stringify(marcador, null, 2), {mode: 0o600}); };
  try {
    const antes = await lerEstado(db);
    r.antes = {resultado: antes.resultado, motivos: antes.motivos, alvos: antes.alvos, agregados: antes.agregados};
    assert.ok(antes.resultado === 'APTO', 'ESTADO_NAO_APTO ' + antes.resultado + ' ' + antes.motivos.join(' | '));
    const t = tentativa(retomar, {dir, dirLancamento, fsImpl});
    fsImpl.mkdirSync(dir, {recursive: true, mode: 0o700});
    arquivo = t.arquivo;
    marcador = {tentativa: t.numero, inicio: relogio(), sql: {arquivo: SQL_ARQUIVO, sha256: SQL_SHA256}, anteriores: t.anteriores, marcadorLegado: t.legado,
      antes: r.antes.agregados, situacao: 'INICIADA'};
    fsImpl.writeFileSync(arquivo, JSON.stringify(marcador, null, 2), {flag: 'wx', mode: 0o600});
    r.marcador = arquivo;
    salvar({situacao: 'EM_TRANSACAO'});
    await db.query(`SET kidmais.reparo_lancamento = '${AUTORIZACAO}'`);
    try { await db.query(sql); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
    finally { await db.query('RESET kidmais.reparo_lancamento').catch(() => {}); }
    salvar({situacao: 'COMMIT_RESPONDIDO'});
    const depois = await lerEstado(db);
    r.depois = {resultado: depois.resultado, motivos: depois.motivos, alvos: depois.alvos, agregados: depois.agregados};
    assert.ok(depois.resultado === 'JA_APLICADO', 'POSCHECK_ESTADO ' + depois.resultado + ' ' + depois.motivos.join(' | '));
    const a = antes.agregados, d = depois.agregados;
    assert.ok(d.globais_futuros === 0, 'POSCHECK_AINDA_GLOBAL');
    assert.ok(d.bloqueios_total === a.bloqueios_total, 'POSCHECK_TOTAL_BLOQUEIOS');
    assert.ok(d.bloqueios_ativos === a.bloqueios_ativos, 'POSCHECK_ATIVOS');
    assert.ok(d.resolucoes_total === a.resolucoes_total + ALVOS.length, 'POSCHECK_RESOLUCOES');
    assert.ok(d.bloqueios_ativos_kidmais === a.bloqueios_ativos_kidmais + ALVOS.length, 'POSCHECK_KIDMAIS');
    assert.ok(d.globais_ativos === a.globais_ativos - ALVOS.length, 'POSCHECK_GLOBAIS');
    r.gravado = true;
    salvar({situacao: 'COMMIT_CONFIRMADO', depois: d});
    r.resultado = 'PASS';
  } catch (erro) {
    r.resultado = 'FALHA';
    r.falha = curta(erro);
    try {
      const x = await lerEstado(db);
      r.situacaoDepois = {resultado: x.resultado, alvos: x.alvos, agregados: x.agregados};
      r.gravado = x.resultado === 'JA_APLICADO' || x.alvos.some(a => a.estado !== 'INTACTO');
    } catch { r.situacaoDepois = 'ILEGIVEL (conexão perdida: rodar CONFERIR)'; r.gravado = null; }
    if (marcador) {
      const situacao = r.gravado === false ? 'FALHA_NADA_GRAVADO' : r.gravado ? 'FALHA_ESTADO_GRAVADO_REVISAR' : 'FALHA_ESTADO_DESCONHECIDO';
      try { salvar({situacao, falha: r.falha}); } catch { r.marcadorNaoAtualizado = true; }
    }
  } finally { await db.query(SQL_SOLTAR).catch(() => {}); }
  return r;
}

/** Plano sem conexão. */
function plano({raiz = path.resolve(__dirname, '..')} = {}) {
  lerSql(raiz);
  return {resultado: 'PLANO', conecta: false, alvo: ALVO, sql: {arquivo: SQL_ARQUIVO, sha256: SQL_SHA256}, kidmais: KIDMAIS_ID,
    alvos: ALVOS.map(a => ({ordem: a.ordem, data: a.data})), modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} --backup <registro>`,
      retomar: `${FLAG_RETOMAR} --backup <registro>`}, marcadores: DIR, marcadorLegado: path.posix.join(DIR_LANCAMENTO, MARCADOR_LEGADO),
    backup: DIR_LANCAMENTO + '/backup-*.json (P1 do lançamento, < 24 h)', flagsQueRecusam: FLAGS_ABERTURA, codigosDeSaida: CODIGOS_DE_SAIDA,
    nuncaExecuta: ['DELETE ou desativação de bloqueio', 'outras resoluções antigas', 'migration', 'mudança de variável', 'deploy']};
}

function modo(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--plano')) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  if (argv.length === 3 && [FLAG_APLICAR, FLAG_RETOMAR].includes(argv[0]) && argv[1] === '--backup')
    return {modo: argv[0] === FLAG_APLICAR ? 'aplicar' : 'retomar', backup: argv[2]};
  throw new Error('USO_RECUSADO');
}

async function principal(argv, env, {Client, raiz = path.resolve(__dirname, '..'), conferirBackup, disco = () => exigirDisco()} = {}) {
  const m = modo(argv);
  if (m.modo === 'plano') return {codigo: 0, saida: plano({raiz})};
  const sql = lerSql(raiz);
  const opts = alvo(env);
  let backup = null;
  if (m.modo !== 'conferir') {
    disco();
    const ligadas = flagsLigadas(env);
    assert.ok(ligadas.length === 0, 'FLAG_LIGADA ' + ligadas.join(','));
    assert.match(m.backup, /^\/opt\/render\/project\/src\/data\/lancamento-venda-20261011\/backup-[A-Za-z0-9-]+\.json$/, 'REGISTRO_BACKUP_INVALIDO');
    const conferir = conferirBackup ?? require('./migrations-lancamento-production.cjs').conferirBackup;
    const b = await conferir(m.backup);
    backup = {registro: m.backup, criadoEm: b.criadoEm, pitrConferidoEm: b.pitrConferidoEm};
  }
  const Cliente = Client ?? require('pg').Client;
  const db = new Cliente(opts); db.on?.('error', () => undefined);
  try {
    await db.connect();
    if (m.modo === 'conferir') {
      const s = await conferirNoCliente(db, {env});
      return {codigo: s.resultado === 'RECUSARIA' ? 3 : 0, saida: s};
    }
    const s = await aplicarNoCliente(db, {sql, retomar: m.modo === 'retomar'});
    s.backup = backup; s.certificadoVerificado = opts.ssl.rejectUnauthorized;
    return {codigo: s.resultado === 'PASS' ? 0 : 2, saida: s};
  } catch (e) {
    // Conexão, identidade ou trava: antes de qualquer escrita.
    return {codigo: 2, saida: {resultado: 'FALHA', mensagem: curta(e), gravado: false}};
  } finally { await db.end().catch(() => {}); }
}

if (require.main === module) {
  principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida, null, 1)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
module.exports = {SQL_ARQUIVO, SQL_SHA256, AUTORIZACAO, ALVO, KIDMAIS_ID, ALVOS, DIR, DIR_LANCAMENTO, MARCADOR_LEGADO, FLAGS_ABERTURA, GATILHOS_ESPERADOS,
  TRAVA, CODIGOS_DE_SAIDA, SQL_IDENTIDADE, SQL_SCHEMA, SQL_PRIVILEGIOS, SQL_SITUACAO, SQL_TRAVA, SQL_SOLTAR, lerSql, alvo, conferirIdentidade,
  flagsLigadas, exigirDisco, somenteLeitura, classificar, avaliar, lerEstado, nomesJson, marcadores, tentativa, conferirNoCliente,
  aplicarNoCliente, plano, modo, principal};
