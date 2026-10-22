/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo dos aplicadores manuais da 090 (campanha Fundador em duas fases) — staging e produção
// (scripts/migration-090-staging.cjs e scripts/migration-090-production.cjs, que fixam o alvo, a identidade da conexão e
// o disco). Derivado do núcleo da 089 (revisado em 21/10/2026): alvo travado, TLS, hash fixado de cada SQL com CRLF
// normalizado, estado ausente/completa/parcial, privilégios, marcador exclusivo no disco persistente, saída sanitizada.
// Ordem: o CÓDIGO é publicado ANTES, já com este aplicador e os SQL na árvore implantada; sem a 090 o código mantém a regra
// anterior (20 primeiros). Depois: --conferir-090 → autorização → --aplicar-090-autorizado --backup <registro> → --conferir-090.
// A 090 NÃO cria nem ativa campanha: ativar exige decisões comerciais e operação própria, fora deste aplicador.
// Conferência: somente leitura (BEGIN TRANSACTION READ ONLY em toda consulta), não grava nada no banco nem no disco.
// Aplicação: precheck (READ ONLY) → migration (transação própria do arquivo, lock_timeout 5s) → postcheck (READ ONLY) →
// prova agregada de preservação (resumo das colunas antigas de assinatura_fundadores igual antes e depois).
// Nunca executa o down. A saída tem só nomes de etapas, booleanos, contagens e resumos md5 agregados (sem ids nem documentos).
// Privilégios avaliados como current_user (no Render a credencial entra com `SET role` do dono; lição de 14/10/2026).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const FLAG_CONFERIR = '--conferir-090';
const FLAG_APLICAR = '--aplicar-090-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-090.json';
const ETAPAS = Object.freeze([
  ['precheck 090', 'database/checks/20261022_090_precheck.sql', '87c7f08c827d0f7762520d33a9a2391e53a3ef9e682f55e2edccc1869083711f'],
  ['migration 090', 'database/migrations/20261022_090_campanha_fundador.sql', '8296b98e9487159fbe9746914484f01de9c7eb1a2741d986d60e756f1692da72'],
  ['postcheck 090', 'database/checks/20261022_090_postcheck.sql', '7c30693ce3b0c9f6516f677708afdeff4ee1f340f5f472e6d4298285b9fdfaf4'],
]);
/** Tabelas que a 090 referencia por FK (REFERENCES exigido) e a tabela que ela altera (dono exigido). */
const REFERENCIADAS = Object.freeze(['usuarios_administrativos']);
const ALTERADAS = Object.freeze(['assinatura_fundadores']);
const lista = xs => xs.map(x => `'${x}'`).join(',');
/** Estado estrutural (leitura): dependências, cada objeto da 090, índice antigo e privilégios. Sem ids nem dados. */
const SQL_ESTADO = `SELECT
  (to_regclass('public.assinatura_fundadores') IS NOT NULL AND to_regclass('public.assinatura_contratacoes') IS NOT NULL
    AND to_regprocedure('public.kidmais_074_registro_guarda()') IS NOT NULL) AS m074a,
  to_regclass('public.assinatura_renovacoes') IS NOT NULL AS m075,
  to_regclass('public.usuarios_administrativos') IS NOT NULL AS usuarios,
  to_regclass('public.assinatura_campanhas') IS NOT NULL AS tabela,
  to_regprocedure('public.kidmais_090_campanha_guarda()') IS NOT NULL AS funcao_campanha,
  to_regprocedure('public.kidmais_090_fundador_guarda()') IS NOT NULL AS funcao_fundador,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='assinatura_fundadores' AND column_name='origem') AS coluna_origem,
  to_regclass('public.assinatura_fundadores_vaga_legado_uk') IS NOT NULL AS indice_legado,
  to_regclass('public.assinatura_fundadores_vaga_pos_uk') IS NOT NULL AS indice_pos,
  to_regclass('public.assinatura_campanhas_ativa_uk') IS NOT NULL AS indice_ativa,
  to_regclass('public.assinatura_fundadores_campanha_idx') IS NOT NULL AS indice_campanha,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='assinatura_campanhas_090_guarda' AND tgrelid=to_regclass('public.assinatura_campanhas')) AS gatilho_campanha,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='assinatura_campanhas_090_truncate' AND tgrelid=to_regclass('public.assinatura_campanhas')) AS gatilho_truncate,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='assinatura_fundadores_090_campanha' AND tgrelid=to_regclass('public.assinatura_fundadores')) AS gatilho_fundador,
  to_regclass('public.assinatura_fundadores_vaga_uk') IS NOT NULL AS indice_antigo,
  has_schema_privilege(current_user,'public','CREATE') AS pode_criar,
  coalesce((SELECT bool_and(has_table_privilege(current_user,to_regclass('public.'||t),'REFERENCES'))
    FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL), false)
    AND (SELECT count(*) FROM unnest(ARRAY[${lista(REFERENCIADAS)}]) t WHERE to_regclass('public.'||t) IS NOT NULL)=${REFERENCIADAS.length} AS pode_referenciar,
  coalesce((SELECT bool_and(pg_has_role(current_user, c.relowner, 'USAGE')) FROM pg_class c
    WHERE c.oid IN (SELECT to_regclass('public.'||t) FROM unnest(ARRAY[${lista(ALTERADAS)}]) t)), false) AS dono_alteradas,
  session_user <> current_user AS papel_trocado`;
const OBJETOS = Object.freeze(['tabela', 'funcao_campanha', 'funcao_fundador', 'coluna_origem', 'indice_legado', 'indice_pos', 'indice_ativa',
  'indice_campanha', 'gatilho_campanha', 'gatilho_truncate', 'gatilho_fundador']);
/** Corte lido no banco ANTES da migration: a prova compara só linhas criadas até ele (tráfego durante a janela não conta). */
const SQL_CORTE = `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS corte`;
const CORTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ts = c => `coalesce(to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US'),'~')`;
const tx = c => `coalesce((${c})::text,'~')`;
/**
 * Resumo só das colunas IMUTÁVEIS que a 090 não pode mudar (identidade da concessão e snapshot da contratação; estado,
 * confirmação e pagamento mudam com o tráfego normal e ficam fora — revisão de 22/10/2026). NULL explícito ('~'); só o
 * md5 agregado sai.
 */
function SQL_PRESERVACAO(corte) {
  assert.match(String(corte), CORTE, 'CORTE_INVALIDO');
  const ate = `'${corte}'::timestamptz`;
  return `/* preservacao-090 */ SELECT
  (SELECT count(*)::int FROM assinatura_fundadores WHERE reservada_em <= ${ate}) AS fundadores,
  (SELECT coalesce(md5(string_agg(concat_ws('|', id, empresa_id, documento_beneficiario, ${tx('vaga')}, ${ts('reservada_em')}), ',' ORDER BY id)), 'vazio')
     FROM assinatura_fundadores WHERE reservada_em <= ${ate}) AS resumo_fundadores,
  (SELECT count(*)::int FROM assinatura_contratacoes WHERE criada_em <= ${ate}) AS contratacoes,
  (SELECT coalesce(md5(string_agg(concat_ws('|', id, empresa_id, chave_idempotencia, plano, ciclo, catalogo_versao, valor_regular_centavos, desconto_percentual,
       valor_final_centavos, ${tx('fundador_id')}, criada_por, ${ts('criada_em')}), ',' ORDER BY id)), 'vazio')
     FROM assinatura_contratacoes WHERE criada_em <= ${ate}) AS resumo_contratacoes`;
}

function lerRevisado(raiz, arquivo, hash) {
  const sql = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(sql, 'utf8').digest('hex'), hash, 'ARQUIVO_DIVERGENTE ' + arquivo);
  return sql;
}
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

/** ausente | completa | parcial, pelos objetos da 090 e pelo índice de vaga antigo (substituído na mesma transação). */
function lerEstado(e) {
  for (const k of ['m074a', 'm075', 'usuarios', ...OBJETOS, 'indice_antigo', 'pode_criar', 'pode_referenciar', 'dono_alteradas', 'papel_trocado'])
    assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  const presentes = OBJETOS.filter(k => e[k]).length;
  const m090 = presentes === 0 && e.indice_antigo ? 'ausente' : presentes === OBJETOS.length && !e.indice_antigo ? 'completa' : 'parcial';
  return {m074a: e.m074a, m075: e.m075, usuarios: e.usuarios, m090, pode_criar: e.pode_criar, pode_referenciar: e.pode_referenciar,
    dono_alteradas: e.dono_alteradas, papel_trocado: e.papel_trocado};
}
/** Plano a partir do estado; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s) {
  assert.ok(s.m074a && s.m075 && s.usuarios, 'DEPENDENCIA_AUSENTE_074A_075');
  assert.notEqual(s.m090, 'parcial', 'APLICACAO_PARCIAL_090');
  if (s.m090 === 'completa') return ['postcheck 090'];
  assert.ok(s.pode_criar && s.pode_referenciar && s.dono_alteradas, 'SEM_PRIVILEGIO_090 ' + (s.pode_criar ? '' : 'CREATE ')
    + (s.pode_referenciar ? '' : 'REFERENCES ') + (s.dono_alteradas ? '' : 'DONO'));
  return ETAPAS.map(([nome]) => nome);
}

async function somenteLeitura(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL statement_timeout = '30s'");
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
/** Contagens e resumos agregados (sem ids nem documentos); com a 090 completa, concessões por origem e campanhas por estado. */
async function contagens(db, estado, corte) {
  const r = {...(await somenteLeitura(db, SQL_PRESERVACAO(corte))).rows[0]};
  if (estado.m090 === 'completa') Object.assign(r, (await somenteLeitura(db, `SELECT
    (SELECT count(*) FROM assinatura_fundadores WHERE origem = 'LEGADO' AND reservada_em <= '${corte}'::timestamptz)::int AS legado_ate_corte,
    (SELECT count(*) FROM assinatura_fundadores WHERE origem = 'LEGADO')::int AS legado,
    (SELECT count(*) FROM assinatura_fundadores WHERE origem = 'JANELA')::int AS janela,
    (SELECT count(*) FROM assinatura_fundadores WHERE origem = 'POS_JANELA')::int AS pos_janela,
    (SELECT count(*) FROM assinatura_campanhas WHERE estado <> 'RASCUNHO')::int AS campanhas_ativadas`)).rows[0]);
  return r;
}

/** Conferência (nenhuma escrita no banco nem no disco): identidade, estado, plano e o check aplicável em READ ONLY. */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  try { r.plano = planoEtapas(r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.contagens = await contagens(db, r.estado, (await somenteLeitura(db, SQL_CORTE)).rows[0]?.corte);
  const [nome, arquivo, hash] = r.estado.m090 === 'completa' ? ETAPAS[2] : ETAPAS[0];
  await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
  r[nome.split(' ')[0]] = 'PASS';
  r.resultado = r.estado.m090 === 'completa' ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/** Aplicação: precheck (READ ONLY) → migration (transação do arquivo) → estado completo → postcheck → preservação. */
/**
 * Uma escrita feita ANTES do corte, mas ainda não confirmada quando o corte é lido, entraria no "depois" e não no "antes"
 * (falso PRESERVACAO_DIVERGENTE; revisão de 22/10/2026). Espera, só lendo, até nenhuma outra sessão deste banco ter
 * transação aberta desde antes do corte; sem isso, recusa ANTES de qualquer escrita. Limite: o papel precisa enxergar
 * `xact_start` das outras sessões (mesmo papel ou pg_read_all_stats); sessões invisíveis não são esperadas.
 */
const SQL_ANTERIORES = corte => `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database()
  AND xact_start IS NOT NULL AND xact_start <= '${corte}'::timestamptz`;
async function esperarTransacoesAnteriores(db, corte, pausa, tentativas) {
  assert.match(String(corte), CORTE, 'CORTE_INVALIDO');
  for (let i = 0; i < tentativas; i++) {
    if (Number((await somenteLeitura(db, SQL_ANTERIORES(corte))).rows[0]?.n ?? 1) === 0) return i;
    await pausa(500);
  }
  assert.fail('TRANSACOES_ANTERIORES_AO_CORTE');
}
const dormir = ms => new Promise(fim => setTimeout(fim, ms));

async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}, pausa = dormir, tentativas = 60}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  r.plano = planoEtapas(r.estadoAntes);
  r.corte = (await somenteLeitura(db, SQL_CORTE)).rows[0]?.corte;
  r.esperasCorte = await esperarTransacoesAnteriores(db, r.corte, pausa, tentativas);
  r.contagensAntes = await contagens(db, r.estadoAntes, r.corte); registrar(r);
  for (const nome of r.plano) {
    r.etapas.push({nome, inicio: new Date().toISOString()}); registrar(r);
    if (nome === 'migration 090') {
      try { await db.query(sqls.get(nome)); } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
      // A migration commitou no próprio arquivo: o estado precisa estar completo antes do postcheck.
      assert.equal(lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]).m090, 'completa', 'ESTADO_DEPOIS_090');
    } else await somenteLeitura(db, sqls.get(nome));
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
  assert.equal(r.estadoDepois.m090, 'completa', 'ESTADO_FINAL_090');
  r.contagensDepois = await contagens(db, r.estadoDepois, r.corte);
  // Prova agregada: nenhuma coluna antiga de concessão nem contratação mudou (a migration só acrescenta origem/campanha).
  for (const k of ['fundadores', 'resumo_fundadores', 'contratacoes', 'resumo_contratacoes'])
    assert.equal(r.contagensDepois[k], r.contagensAntes[k], 'PRESERVACAO_DIVERGENTE ' + k);
  if (r.plano.length > 1) assert.equal(r.contagensDepois.legado_ate_corte, r.contagensAntes.fundadores, 'BACKFILL_LEGADO_INCOMPLETO');
  r.resultado = r.plano.length === 1 ? 'JA_APLICADA_POSTCHECK_PASS' : 'APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}

/** Modo pelos argumentos: nenhum (plano), --conferir-090, ou --aplicar-090-autorizado --backup <registro>. */
function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  if (argv.length === 3 && argv[0] === FLAG_APLICAR && argv[1] === FLAG_BACKUP) {
    // Referência do backup/export feito antes (ex.: horário e id do export, PITR anotado); só texto curto e seguro.
    assert.match(argv[2], /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_INVALIDO');
    return {modo: 'aplicar', backup: argv[2]};
  }
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

/**
 * Fábrica do aplicador de um ambiente. `amb` fixa: nome, alvo(env) → opções do pg, SQL de identidade, identidade(linha),
 * diretório do registro e verificação do disco persistente.
 */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: ETAPAS.map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['074a e 075 (assinatura_fundadores, assinatura_contratacoes, assinatura_renovacoes) e usuarios_administrativos',
        '090 ausente ou completa (nunca parcial)', 'CREATE em public', 'REFERENCES em ' + REFERENCIADAS.join('/'), 'dono de ' + ALTERADAS.join('/')],
      ordem: ['deploy do código (sem a 090: regra anterior de 20 vagas)', FLAG_CONFERIR, 'autorização de Felipe', FLAG_APLICAR, FLAG_CONFERIR,
        'campanha continua em rascunho/inexistente até decisão e ativação autorizadas'],
      nuncaExecuta: ['down 090', 'criação ou ativação de campanha', 'alteração de env', 'chamada ao Asaas']};
  }
  async function conferir({env, raiz = raizPadrao, Client = require('pg').Client}) {
    const opts = amb.alvo(env);
    const db = new Client(opts); db.on?.('error', () => undefined);
    try { await db.connect(); return await conferirNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env)}); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', resultado: 'FALHA', mensagem: curta(e)}; }
    finally { await db.end().catch(() => {}); }
  }
  async function executar({env, backup, dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco(), pausa, tentativas}) {
    const opts = amb.alvo(env); disco();
    assert.match(String(backup ?? ''), /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_OBRIGATORIO');
    for (const [, arquivo, hash] of ETAPAS) lerRevisado(raiz, arquivo, hash);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const marcador = path.join(dir, MARCADOR);
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, backup, situacao: 'INICIADA'};
    // Exclusivo: qualquer tentativa anterior (concluída, falha ou perdida) impede repetição automática.
    try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    let ultimo = {};
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await aplicarNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env), pausa, tentativas,
        registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
      salvar({...r, situacao: 'CONCLUIDA'});
      return {resultado: r.resultado, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
        contagensAntes: r.contagensAntes, contagensDepois: r.contagensDepois, etapas: r.etapas.map(e => e.nome)};
    } catch (e) {
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
      salvar({...ultimo, situacao: 'FALHA', falha});
      return {resultado: 'FALHA', marcador, falha, migracaoCommitada: ultimo.etapas?.some(x => x.nome === 'migration 090' && x.ok) === true};
    } finally { await db.end().catch(() => {}); }
  }
  /** Códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar (lançada); 2 FALHA registrada; 3 conferência RECUSARIA. */
  const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_POSTCHECK_PASS: 0, APLICADA_POSTCHECK_PASS: 0, FALHA: 2, RECUSARIA: 3});
  async function principal(argv, env, deps = {}) {
    const m = modo(argv);
    if (m.modo === 'plano') return {codigo: 0, saida: plano(deps)};
    const s = m.modo === 'conferir' ? await conferir({env, ...deps}) : await executar({env, backup: m.backup, ...deps});
    return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
  }
  function cli() {
    principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
      (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
    }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
  }
  return {plano, conferir, executar, principal, cli, CODIGO};
}

module.exports = {ETAPAS, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, REFERENCIADAS, ALTERADAS, OBJETOS, SQL_ESTADO, SQL_PRESERVACAO, SQL_CORTE, SQL_ANTERIORES,
  lerRevisado, lerEstado, planoEtapas, conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
