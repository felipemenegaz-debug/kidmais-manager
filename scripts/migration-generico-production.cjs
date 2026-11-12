/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador GENÉRICO de PRODUÇÃO para as migrations da promoção de 12/11/2026 que não têm aplicador próprio: 120, 121, 110,
// 111 e 115 (nessa ordem, a do inventário; scripts/promocao-production-ordem.cjs). SOMENTE no PostgreSQL do web de produção,
// no Web Shell do srv-dak77m2d0e5s73b8rkkg, DEPOIS do deploy de uma árvore que traga este arquivo e os SQL.
//   - LISTA FECHADA neste arquivo: para cada id, o sha256 (LF) fixado do precheck, da migration e do postcheck, e as
//     SENTINELAS do estado — os mesmos objetos que o precheck da própria migration usa para dizer "já presente" (o teste
//     confere cada nome contra o texto do precheck). Fora da lista = recusa antes de qualquer conexão;
//   - estado só pelo catálogo: nenhuma sentinela = ausente; todas (e as removidas ausentes) = presente; outro = PARCIAL
//     (recusa). A 115 é idempotente por desenho (CREATE INDEX IF NOT EXISTS + DROP INDEX IF EXISTS, e o precheck aceita os
//     dois estados): nela o estado intermediário (índice novo criado e o antigo ainda presente) é aplicável;
//   - alvo, identidade (TLS e rede privada provados no servidor) e disco de scripts/conexao-production.cjs, com a rigidez dos
//     adaptadores recentes (PG* herdadas, `?`/`#`, caracteres de controle, configuração explícita);
//   - CONFERIR: tudo em BEGIN TRANSACTION READ ONLY; ausente → precheck; presente → postcheck. Não grava no banco nem no disco;
//   - APLICAR: exige o registro de backup; marcador exclusivo no disco persistente (migration-<id>.json); UMA transação:
//     precheck → corpo da migration (sem o BEGIN e sem o COMMIT do arquivo) → postcheck → COMMIT só com tudo PASS → estado
//     relido (presente) → postcheck de novo em READ ONLY;
//   - falha de check = erro do servidor (todo precheck/postcheck destas migrations sinaliza por RAISE EXCEPTION; 120 e 121
//     terminam com uma linha `aprovado`: se vier diferente de true, também é falha), como no precedente por manifesto
//     (scripts/migrations-lancamento-production.cjs), que roda os checks e deixa a exceção abortar a transação;
//   - situação do COMMIT como nos aplicadores recentes (regra da 109–118, a função é a do núcleo da 118): falha antes do
//     COMMIT = NAO_COMMITADA; falha NO COMMIT = DESFEITA_PELO_SERVIDOR (SQLSTATE de resposta fora de 08/57/58/XX e ≠ 40003)
//     ou INDETERMINADO; COMMIT respondido como ROLLBACK = DESFEITA_PELO_SERVIDOR;
//   - códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar; 2 FALHA registrada; 3 conferência RECUSARIA.
// Privilégios: não há guarda prévia por migration (as 5 só criam objetos novos ou trocam índice); papel sem privilégio falha
// DENTRO da transação = NAO_COMMITADA, nada fica aplicado. Nunca executa o down de nenhuma delas.
//   node scripts/migration-generico-production.cjs                                                     → plano, sem conexão
//   node scripts/migration-generico-production.cjs --conferir <id>                                     → somente leitura
//   node scripts/migration-generico-production.cjs --aplicar-autorizado <id> --backup "<registro>"     → uma vez por id
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {lerRevisado} = require('./migration-092-094-comum.cjs');
const {commitNaFalha} = require('./migration-118-comum.cjs');
const prd = require('./conexao-production.cjs');

const FLAG_CONFERIR = '--conferir';
const FLAG_APLICAR = '--aplicar-autorizado';
const FLAG_BACKUP = '--backup';
const ALVO = prd.ALVO;
const DIR = prd.pastaRegistro('promocao-generico-producao');
const SQL_IDENTIDADE = prd.SQL_IDENTIDADE;
const PG_HERDADAS_RECUSADAS = prd.PG_HERDADAS_RECUSADAS;

const tabela = t => [t, `to_regclass('public.${t}') IS NOT NULL`];
const funcao = f => [f, `to_regprocedure('public.${f}') IS NOT NULL`];
const restricao = c => [c, `EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${c}')`];
const coluna = (t, c) => [`${t}.${c}`, `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${t}' AND column_name = '${c}')`];
const congelar = o => Object.freeze({...o, arquivos: Object.freeze(o.arquivos.map(a => Object.freeze(a))), criados: Object.freeze(o.criados), removidos: Object.freeze(o.removidos ?? [])});
/** LISTA FECHADA: [etapa, arquivo, sha256 do conteúdo com CRLF normalizado para LF]. */
const MIGRATIONS = Object.freeze({
  '120': congelar({escopo: 'financeiro P2: liquidações de entradas e reversões de saídas (aditiva; exige a 052)',
    arquivos: [['precheck', 'database/checks/20261109_120_precheck.sql', '9dfc0577c0861e303a0b9b254eb63accb621de238c5493bdd45e9e7632c8f0ad'],
      ['migration', 'database/migrations/20261109_120_financeiro_movimentos.sql', '6d2a4e54581f41bf65723ddca2bfd7f41c92cf475438c8cdb3d2ee5baf6f084c'],
      ['postcheck', 'database/checks/20261109_120_postcheck.sql', '5b5376fa562d4249d4c237d11c029dfb193c05b40f0b67726af3b4405c26a7e9']],
    criados: [tabela('financeiro_entradas_liquidacoes'), tabela('financeiro_saidas_reversoes'),
      restricao('financeiro_entradas_manuais_empresa_uk'), restricao('financeiro_saidas_empresa_uk')]}),
  '121': congelar({escopo: 'financeiro P2: abertura do financeiro e conferências, só de acréscimo (aditiva; exige empresas e a 052)',
    arquivos: [['precheck', 'database/checks/20261109_121_precheck.sql', '24e786410f669905260fa9d641c14b6bc01a4440a9b2ce6bffd713c52e1e1860'],
      ['migration', 'database/migrations/20261109_121_financeiro_abertura.sql', 'f9fd4c5e717e2c02440cc3d23e5a9298100fa8baf6d804cc6d9cf2f3c0900479'],
      ['postcheck', 'database/checks/20261109_121_postcheck.sql', '7bbd85fd52841b1bbdc2157155a8368d349de1ec7ba1d28e2f35bb35789b7423']],
    criados: [tabela('financeiro_aberturas'), tabela('financeiro_abertura_conferencias'), funcao('kidmais_121_somente_acrescimo()')]}),
  '110': congelar({escopo: 'pesquisa de satisfação pós-festa (PS-1; exige 043, 054 e 086)',
    arquivos: [['precheck', 'database/checks/20261030_110_precheck.sql', 'd6bee1250665f9d0b3ae0c607ba26e275c307b74927b5507a0a929d377fcd1c5'],
      ['migration', 'database/migrations/20261030_110_satisfacao_pesquisa.sql', '8e9a9a714f6ccf1139042fd8cf8b3029ea18abc3fd8ff569e85d0e9fe69c2439'],
      ['postcheck', 'database/checks/20261030_110_postcheck.sql', 'b04dccb7cd8aafd8973a06ebb1a84717fbbe1a9f16e68c51b621e8a91f063744']],
    criados: [tabela('satisfacao_envios'), tabela('satisfacao_respostas'), tabela('satisfacao_entregas'), funcao('kidmais110_envio_guarda()'),
      coluna('marketing_automacao_regras', 'canais')]}),
  '111': congelar({escopo: 'pesquisa de satisfação: links de avaliação e auditoria só de acréscimo (PS-3; exige a 110 e PostgreSQL 15+)',
    arquivos: [['precheck', 'database/checks/20261031_111_precheck.sql', '483640b99a5a09729240dd19476b217e19ca26ce4abcc15b5b4d401bec7bb4a1'],
      ['migration', 'database/migrations/20261031_111_satisfacao_links_auditoria.sql', '030d564ff067b45fc789ca4a57f5fa99b52be234546f92494eba63b2c2e57c60'],
      ['postcheck', 'database/checks/20261031_111_postcheck.sql', 'c97fbc56872a880b705645ea3b8f83a778f5e07e90c05b2b7e895a146daf60f1']],
    criados: [tabela('satisfacao_links_avaliacao'), tabela('satisfacao_auditoria'), funcao('kidmais111_link_guarda()'),
      funcao('kidmais111_auditoria_somente_insercao()'), funcao('kidmais111_auditoria_coerencia()')]}),
  '115': congelar({escopo: 'índice (empresa_id, data_evento) em fechamentos no lugar do índice da 054 (PS-4; a criação bloqueia escritas em fechamentos enquanto dura)',
    idempotente: true,
    arquivos: [['precheck', 'database/checks/20261103_115_precheck.sql', '61d6f61e69b993e68ee2564ef9a8c6618afe2b64b742a522ef792b224b485f23'],
      ['migration', 'database/migrations/20261103_115_fechamentos_empresa_data.sql', '35e971aaa4b089331324eb198309bbd7055cf4ec265263b803b6aaa3b39dc79e'],
      ['postcheck', 'database/checks/20261103_115_postcheck.sql', '112a2e3995ba02896ca071316dc8e9aa44d0eac6f5fc2e94a3d8e695a5eec201']],
    criados: [tabela('fechamentos_115_empresa_data_idx')], removidos: [tabela('fechamentos_054_empresa_idx')]}),
});
/** Ordem do inventário (scripts/production/check-migrations.mjs, approvedFiles): 120, 121, 110, 111, 115. */
const IDS = Object.freeze(['120', '121', '110', '111', '115']);
const definicao = id => { assert.ok(typeof id === 'string' && Object.hasOwn(MIGRATIONS, id), 'MIGRATION_FORA_DA_LISTA'); return MIGRATIONS[id]; };
const marcadorDe = id => `migration-${id}.json`;
const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 300);

/** Estado (só catálogo): uma coluna booleana por sentinela, c<i> das criadas e r<i> das removidas. */
function sqlEstado(id) {
  const d = definicao(id);
  return `/* estado-${id} */ SELECT ${[...d.criados.map(([, e], i) => `(${e}) AS c${i}`), ...d.removidos.map(([, e], i) => `(${e}) AS r${i}`)].join(',\n  ')}`;
}
function lerEstado(id, linha) {
  const d = definicao(id);
  const criados = d.criados.map((_, i) => linha?.['c' + i]), removidos = d.removidos.map((_, i) => linha?.['r' + i]);
  for (const v of [...criados, ...removidos]) assert.equal(typeof v, 'boolean', 'ESTADO_ILEGIVEL ' + id);
  const n = criados.filter(Boolean).length, sobras = removidos.filter(Boolean).length;
  const situacao = n === 0 ? 'ausente' : n === criados.length && sobras === 0 ? 'presente' : 'parcial';
  const s = {situacao, criados: `${n}/${criados.length}`, ...(removidos.length ? {removidosAindaPresentes: `${sobras}/${removidos.length}`} : {})};
  if (situacao === 'parcial') s.divergencias = [...d.criados.filter((_, i) => !criados[i]).map(([nome]) => 'falta ' + nome), ...d.removidos.filter((_, i) => removidos[i]).map(([nome]) => 'sobra ' + nome)];
  return s;
}
/** Plano a partir do estado; parcial recusa, salvo na migration idempotente (115), em que o precheck decide. */
function planoEtapas(id, s) {
  const d = definicao(id);
  if (s.situacao === 'presente') return ['postcheck'];
  assert.ok(s.situacao === 'ausente' || d.idempotente === true, `APLICACAO_PARCIAL_${id} ${(s.divergencias ?? []).join(', ')}`);
  return ['precheck', 'migration', 'postcheck'];
}

/** O arquivo da migration sem a moldura: só comentários antes do único BEGIN; e o único COMMIT; é a última linha. */
function corpoMigration(sql, nome) {
  assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1, 'TRANSACAO_INESPERADA ' + nome);
  assert.equal((sql.match(/^COMMIT;$/gm) ?? []).length, 1, 'TRANSACAO_INESPERADA ' + nome);
  assert.equal((sql.match(/^(?:ROLLBACK;|START TRANSACTION|SET TRANSACTION|SAVEPOINT|RELEASE|BEGIN TRANSACTION)/gm) ?? []).length, 0, 'TRANSACAO_INESPERADA ' + nome);
  assert.ok(sql.endsWith('\nCOMMIT;\n'), 'TRANSACAO_INESPERADA ' + nome);
  const i = sql.indexOf('BEGIN;\n');
  assert.ok(sql.slice(0, i).split('\n').every(l => l === '' || l.startsWith('--')), 'TRANSACAO_INESPERADA ' + nome);
  return sql.slice(i + 'BEGIN;\n'.length, -'COMMIT;\n'.length);
}
/**
 * Precheck e postcheck: ou trazem a própria moldura (BEGIN TRANSACTION READ ONLY … ROLLBACK no fim) ou nenhuma (postchecks
 * da 110, 111 e 115); o aplicador envia só o CORPO, dentro da transação dele.
 */
function corpoCheck(sql, nome) {
  const inicio = (sql.match(/^BEGIN TRANSACTION READ ONLY;$/gm) ?? []).length, fim = (sql.match(/^ROLLBACK;$/gm) ?? []).length;
  assert.equal((sql.match(/^(?:BEGIN;|COMMIT;|START TRANSACTION|SET TRANSACTION|SAVEPOINT|RELEASE)/gm) ?? []).length, 0, 'MOLDURA_INESPERADA ' + nome);
  if (inicio === 0 && fim === 0) return sql;
  assert.ok(inicio === 1 && fim === 1 && sql.endsWith('\nROLLBACK;\n'), 'MOLDURA_INESPERADA ' + nome);
  const i = sql.indexOf('BEGIN TRANSACTION READ ONLY;\n');
  assert.ok(sql.slice(0, i).split('\n').every(l => l === '' || l.startsWith('--')), 'MOLDURA_INESPERADA ' + nome);
  return sql.slice(i + 'BEGIN TRANSACTION READ ONLY;\n'.length, -'ROLLBACK;\n'.length);
}
/** Lê os 3 arquivos revisados do id (hash conferido) e devolve os corpos prontos para enviar. */
function carregar(raiz, id) {
  const corpos = {};
  for (const [etapa, arquivo, hash] of definicao(id).arquivos) {
    const sql = lerRevisado(raiz, arquivo, hash);
    corpos[etapa] = etapa === 'migration' ? corpoMigration(sql, `migration ${id}`) : corpoCheck(sql, `${etapa} ${id}`);
  }
  return corpos;
}
/** Check que devolve linha com `aprovado` (120 e 121): só `true` passa. Sem a coluna, vale a ausência de exceção. */
function exigirAprovado(resultado, nome) {
  for (const r of [].concat(resultado ?? [])) for (const linha of r?.rows ?? [])
    if (linha && Object.hasOwn(linha, 'aprovado')) assert.ok(linha.aprovado === true, 'CHECK_REPROVADO ' + nome);
}

async function somenteLeitura(db, sql) {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
const estadoAtual = async (db, id) => lerEstado(id, (await somenteLeitura(db, sqlEstado(id))).rows[0]);
const checkSomenteLeitura = async (db, corpos, etapa, id) => exigirAprovado(await somenteLeitura(db, corpos[etapa]), `${etapa} ${id}`);

/** Conferência (nenhuma escrita no banco nem no disco): identidade, estado, plano e, em READ ONLY, precheck ou postcheck. */
async function conferirNoCliente(db, {id, raiz, sqlIdentidade = SQL_IDENTIDADE, identidade = prd.identidade}) {
  const corpos = carregar(raiz, id);
  const r = {modo: 'conferencia', id};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = await estadoAtual(db, id);
  try { r.plano = planoEtapas(id, r.estado); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  const etapa = r.estado.situacao === 'presente' ? 'postcheck' : 'precheck';
  r.checks = {};
  try { await checkSomenteLeitura(db, corpos, etapa, id); r.checks[etapa] = 'PASS'; }
  catch (e) { r.checks[etapa] = 'FALHOU'; r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.resultado = r.estado.situacao === 'presente' ? 'JA_APLICADA_POSTCHECK_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/** UMA transação: precheck → corpo da migration → postcheck → COMMIT. Registra a situação do COMMIT antes de qualquer outra leitura. */
async function migrarNaTransacao(db, corpos, id, passo, registrar) {
  let fase = 'inicio';
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    await db.query('SET LOCAL search_path = public, pg_catalog');
    passo.antesDoCommit = {};
    fase = 'precheck';
    exigirAprovado(await db.query(corpos.precheck), `precheck ${id}`);
    passo.antesDoCommit.precheck = 'PASS';
    fase = 'migration';
    await db.query(corpos.migration);
    passo.antesDoCommit.migration = 'ENVIADA';
    fase = 'postcheck';
    exigirAprovado(await db.query(corpos.postcheck), `postcheck ${id}`);
    passo.antesDoCommit.postcheck = 'PASS';
    registrar();
    fase = 'commit';
    const c = await db.query('COMMIT');
    // COMMIT numa transação abortada volta como ROLLBACK sem erro: nada confirmado.
    if (c?.command === 'ROLLBACK') { passo.commit = 'DESFEITA_PELO_SERVIDOR'; registrar(); assert.fail(`COMMIT_RESPONDIDO_COMO_ROLLBACK_${id}`); }
  } catch (e) {
    passo.faseDaFalha = fase;
    if (!passo.commit) passo.commit = fase === 'commit' ? commitNaFalha(e) : 'NAO_COMMITADA';
    registrar();
    await db.query('ROLLBACK').catch(() => {}); throw e;
  }
  passo.commit = 'CONFIRMADO'; registrar();
}

/** Aplicação: o estado é relido aqui, imediatamente antes; presente = só o postcheck (READ ONLY), nada é reaplicado. */
async function aplicarNoCliente(db, {id, raiz, sqlIdentidade = SQL_IDENTIDADE, identidade = prd.identidade, registrar = () => {}}) {
  const corpos = carregar(raiz, id);
  const r = {id, etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db, id);
  r.plano = planoEtapas(id, r.estadoAntes); registrar(r);
  if (r.plano.includes('migration')) {
    const passo = {nome: `transacao ${id}`, inicio: new Date().toISOString()};
    r.etapas.push(passo); registrar(r);
    await migrarNaTransacao(db, corpos, id, passo, () => registrar(r));
    assert.equal((await estadoAtual(db, id)).situacao, 'presente', `ESTADO_DEPOIS_${id}`);
    Object.assign(passo, {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  const final = {nome: `postcheck ${id}`, inicio: new Date().toISOString()};
  r.etapas.push(final); registrar(r);
  await checkSomenteLeitura(db, corpos, 'postcheck', id);
  Object.assign(final, {ok: true, fim: new Date().toISOString()});
  r.estadoDepois = await estadoAtual(db, id);
  assert.equal(r.estadoDepois.situacao, 'presente', `ESTADO_FINAL_${id}`);
  r.resultado = r.plano.includes('migration') ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_POSTCHECK_PASS';
  registrar(r);
  return r;
}
const situacoes = r => Object.fromEntries((r.etapas ?? []).filter(x => x.commit).map(x => [r.id, x.commit]));
const commitadas = r => Object.entries(situacoes(r)).filter(([, c]) => c === 'CONFIRMADO').map(([id]) => id);

const BACKUP = /^[A-Za-z0-9:._/ -]{6,120}$/;
function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 2 && argv[0] === FLAG_CONFERIR) { definicao(argv[1]); return {modo: 'conferir', id: argv[1]}; }
  if (argv.length === 4 && argv[0] === FLAG_APLICAR && argv[2] === FLAG_BACKUP) {
    definicao(argv[1]);
    assert.match(argv[3], BACKUP, 'BACKUP_INVALIDO');
    return {modo: 'aplicar', id: argv[1], backup: argv[3]};
  }
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

const raizPadrao = path.resolve(__dirname, '..');
function alvo(env, id) { definicao(id); return prd.alvoRigido(env, `kidmais-migration-${id}-production`); }
const identidade = id => prd.identidade(id);
const exigirDisco = (...a) => prd.exigirDisco(...a);

function plano({raiz = raizPadrao} = {}) {
  return {resultado: 'PLANO', conecta: false, ambiente: 'production', alvo: ALVO, registro: DIR,
    migrations: IDS.map(id => ({id, escopo: MIGRATIONS[id].escopo, idempotente: MIGRATIONS[id].idempotente === true, marcador: marcadorDe(id),
      arquivos: MIGRATIONS[id].arquivos.map(([etapa, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {etapa, arquivo, sha256: hash}; }),
      sentinelas: {criados: MIGRATIONS[id].criados.map(([n]) => n), removidos: MIGRATIONS[id].removidos.map(([n]) => n)}})),
    modos: {conferir: `${FLAG_CONFERIR} <id>`, aplicar: `${FLAG_APLICAR} <id> ${FLAG_BACKUP} <registro-do-backup>`},
    provaNoAlvo: 'precheck, corpo da migration e postcheck na MESMA transação; COMMIT só com tudo PASS; depois, estado pelo catálogo e o postcheck em READ ONLY',
    prazos: 'lock_timeout 5 s e statement_timeout 60 s (SET LOCAL do aplicador e do próprio SQL); estouro antes do COMMIT = NAO_COMMITADA; no COMMIT = INDETERMINADO',
    ordem: ['árvore implantada no web de produção com este aplicador e os SQL; conferir commit e sha256 implantados (o bloco CONFERIR confere)',
      'uma migration por vez, na ordem 120, 121, 110, 111, 115 (a 111 exige a 110; o precheck de cada uma confere as dependências)',
      `${FLAG_CONFERIR} <id>: PRONTA_PARA_APLICAR (JA_APLICADA_POSTCHECK_PASS = não aplicar)`,
      'backup restaurável de production registrado (dump conferido + PITR; export funcional não substitui)',
      'autorização de Felipe para a migration em produção',
      'janela curta, sem DDL concorrente (a 115 bloqueia escritas em fechamentos enquanto cria o índice)',
      `${FLAG_CONFERIR} <id> de novo, imediatamente antes`, `${FLAG_APLICAR} <id>`, `${FLAG_CONFERIR} <id>: JA_APLICADA_POSTCHECK_PASS`],
    paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir nem seguir para a próxima migration',
      'FALHA: commit = NAO_COMMITADA | CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com a conferência antes de decidir',
      'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-<id>.<horario>.json'],
    recuperacao: ['down de cada migration (database/rollback/) só com autorização própria e conforme as condições do próprio arquivo',
      'em último caso, restauração do backup registrado'],
    nuncaExecuta: ['down de qualquer migration', 'migration fora da lista fechada', 'alteração de env', 'deploy', 'restart']};
}
async function conferir({env, id, raiz = raizPadrao, Client = require('pg').Client}) {
  const opts = alvo(env, id);
  const db = new Client(opts); db.on?.('error', () => undefined);
  try { await db.connect(); return await conferirNoCliente(db, {id, raiz}); }
  catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', id, resultado: 'FALHA', mensagem: curta(e)}; }
  finally { await db.end().catch(() => {}); }
}
async function executar({env, id, backup, dir = DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => exigirDisco()}) {
  const opts = alvo(env, id); disco();
  assert.match(String(backup ?? ''), BACKUP, 'BACKUP_OBRIGATORIO');
  carregar(raiz, id);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const marcador = path.join(dir, marcadorDe(id));
  const anteriores = fs.readdirSync(dir).filter(n => n.startsWith(`migration-${id}.`) && n.endsWith('.json') && n !== marcadorDe(id)).sort();
  const registro = {inicio: new Date().toISOString(), ambiente: 'production', id, backup, situacao: 'INICIADA', tentativasAnteriores: anteriores};
  try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
  catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
  const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
  let ultimo = {id};
  const db = new Client(opts); db.on?.('error', () => undefined);
  try {
    await db.connect();
    const r = await aplicarNoCliente(db, {id, raiz, registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
    ultimo = JSON.parse(JSON.stringify(r));
    salvar({...r, situacao: 'CONCLUIDA', commits: situacoes(r), commitadas: commitadas(r)});
    return {resultado: r.resultado, id, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, estadoDepois: r.estadoDepois,
      etapas: r.etapas.map(e => e.nome), commits: situacoes(r), commitadas: commitadas(r)};
  } catch (e) {
    // Já conectou: sempre FALHA (código 2) com a situação do COMMIT guardada em memória, mesmo que o marcador não possa
    // mais ser gravado (disco cheio): a falha de gravação nunca esconde um COMMIT confirmado nem vira recusa (código 1).
    const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
    const situacao = {commits: situacoes(ultimo), commitadas: commitadas(ultimo), reconciliar: `${FLAG_CONFERIR} ${id} antes de qualquer decisão; não repetir`};
    let marcadorAtualizado = true, erroMarcador;
    try { salvar({...ultimo, situacao: 'FALHA', falha, ...situacao}); } catch (e2) { marcadorAtualizado = false; erroMarcador = curta(e2); }
    return {resultado: 'FALHA', id, marcador, falha, ...situacao, marcadorAtualizado,
      ...(marcadorAtualizado ? {} : {erroMarcador, aviso: 'MARCADOR_DESATUALIZADO: copiar esta saída (é o único registro do COMMIT); não repetir'})};
  } finally { await db.end().catch(() => {}); }
}
/** Códigos: 0 PLANO/CONFERIDO/PASS; 1 recusa antes de conectar (lançada); 2 FALHA registrada; 3 conferência RECUSARIA. */
const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_POSTCHECK_PASS: 0, APLICADA_POSTCHECK_PASS: 0, FALHA: 2, RECUSARIA: 3});
async function principal(argv, env, deps = {}) {
  const m = modo(argv);
  if (m.modo === 'plano') return {codigo: 0, saida: plano(deps)};
  const s = m.modo === 'conferir' ? await conferir({env, id: m.id, ...deps}) : await executar({env, id: m.id, backup: m.backup, ...deps});
  return {codigo: CODIGO[s.resultado] ?? 2, saida: s};
}
function cli() {
  principal(process.argv.slice(2), process.env).then(({codigo, saida}) => {
    (codigo === 0 ? console.log : console.error)(JSON.stringify(saida)); process.exitCode = codigo;
  }).catch(e => { console.error('RECUSADO ' + curta(e)); process.exitCode = 1; });
}
if (require.main === module) cli();
module.exports = {ALVO, DIR, SQL_IDENTIDADE, PG_HERDADAS_RECUSADAS, MIGRATIONS, IDS, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, CODIGO, marcadorDe, sqlEstado, lerEstado,
  planoEtapas, corpoMigration, corpoCheck, carregar, exigirAprovado, conferirNoCliente, aplicarNoCliente, modo, alvo, identidade, exigirDisco, plano, conferir, executar,
  principal, cli};
