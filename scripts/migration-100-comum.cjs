/* eslint-disable @typescript-eslint/no-require-imports */
// Núcleo do aplicador manual da 100 (agenda com um salão: uma festa por vez no horário POR_HORARIO, qualquer que seja a
// capacidade gravada) — staging e produção (scripts/migration-100-staging.cjs e scripts/migration-100-production.cjs fixam o
// alvo, a identidade da conexão e o disco; produção também a ordem do runbook de promoção).
// Mesmo desenho do aplicador da 092–094 (alvo travado, TLS, hash fixado de cada SQL com CRLF normalizado, marcador
// exclusivo no disco persistente, COMMIT confirmado/desfeito/indeterminado, códigos 0/1/2/3), para UMA migration que só
// troca o corpo de kidmais094_conflito_ocupacao:
//   - estado pelo sha256 do corpo: o da 094 = ausente; o da 100 = completa; sem a função = sem 094; outro corpo (098,
//     deriva) = divergente. Fora de ausente/completa, recusa antes de qualquer escrita;
//   - inventário somente leitura (sem ids): horários com capacidade > 1 em escopos POR_HORARIO (a 100 passa a tratá-los
//     como 1) e PARES de ocupações futuras (festas e destinos de remarcação em hold) no mesmo horário que se sobrepõem
//     com o intervalo mínimo. Esses pares, válidos antes, conflitariam depois da 100: a aplicação RECUSA com pares > 0
//     (decisão de Felipe; nada é remarcado ou cancelado por aqui);
//   - aplicação: precheck (READ ONLY) → migration (transação do arquivo) → COMMIT registrado → estado completo →
//     postcheck (corpo da 100) → integridade da 094 com o corpo da 100 (validação composta: gatilhos, colunas, FKs e os
//     demais corpos da 094 intactos). Já completa: só postcheck e integridade;
//   - conferência: somente leitura (BEGIN TRANSACTION READ ONLY em toda consulta), não grava no banco nem no disco.
// Ordem: o CÓDIGO com este aplicador e os SQL é publicado ANTES (a tela e o servidor já gravam capacidade 1). Depois:
// --conferir-100 → backup restaurável → autorização → janela sem escrita de agenda/DDL → --conferir-100 de novo →
// --aplicar-100-autorizado --backup <registro> → --conferir-100. Nunca executa o down (rollback manual, autorização
// própria: reabre a capacidade gravada no SQL). Depois da 100, o CONFERIR da 092–094 usa a integridade da 094 com o
// corpo da 100 (scripts/migration-092-094-comum.cjs) — só essa expectativa muda.
// Privilégio: CREATE OR REPLACE FUNCTION exige ser DONO da função (pg_has_role USAGE no papel dono), avaliado como
// current_user (no Render a credencial entra com `SET role`; lição de 14/10/2026).
// 108 (plano E4, E4-6; P2-E4-R2-2): a 108 substitui a regra de conflito da 100 por um corpo próprio. Com esse corpo E a
// 108 íntegra pela prova única (sqlProva108Integra, a mesma da 094 e do aplicador 107/108), o estado é
// JA_APLICADA_SUBSTITUIDA_108 — sucesso (código 0) SEM reaplicar a 100 (reaplicar desfaria a 108). Corpo da 108 sem a
// prova, ou qualquer evidência da 108 com o corpo da 094/100 (108 parcial), recusa antes de qualquer escrita.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {commitNaFalha, lerRevisado, CORPO_CONFLITO_094, CORPO_CONFLITO_100, CORPO_CONFLITO_108, INTEGRIDADE_094_APOS_100, INTEGRIDADE_094_APOS_108} =
  require('./migration-092-094-comum.cjs');
const ev108 = require('./migration-108-evidencias.cjs');

const FLAG_CONFERIR = '--conferir-100';
const FLAG_APLICAR = '--aplicar-100-autorizado';
const FLAG_BACKUP = '--backup';
const MARCADOR = 'migration-100.json';
const ETAPAS = Object.freeze([
  ['precheck 100', 'database/checks/20261025_100_precheck.sql', 'b25ce78ac2a917ebdab4ec577657389f927d0803a89ed05d3461c5ccb6b96dd7'],
  ['migration 100', 'database/migrations/20261025_100_agenda_um_salao.sql', '3e0a19fecde436f3549a876c5e73009bf4cffc3d0d51cb52c19d7ed7255d3f39'],
  ['postcheck 100', 'database/checks/20261025_100_postcheck.sql', '57213ea78cdb3ad1044311b87ad88d30a73af258980ac5519a34a15f6a2e3fc4'],
  INTEGRIDADE_094_APOS_100,
]);
const etapa = nome => ETAPAS.find(e => e[0] === nome);
const FUNCAO = 'kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)';

/**
 * Estado (somente leitura): dependências, corpo da regra de conflito, privilégios de definição e SET role sem nomes.
 * Parecer do Astra (P3): CREATE OR REPLACE FUNCTION exige ser dono da função existente, CREATE no schema, USAGE na
 * linguagem e nos tipos dos argumentos e do retorno (documentação do PostgreSQL 18, CREATE FUNCTION).
 */
const SQL_ESTADO = `SELECT
  (to_regclass('public.agenda_escopo_config') IS NOT NULL AND to_regprocedure('public.kidmais094_ocupacoes(date,date)') IS NOT NULL
    AND to_regprocedure('public.kidmais062_mesmo_recurso(uuid,uuid,uuid,uuid)') IS NOT NULL) AS d100,
  (SELECT encode(sha256(convert_to(replace(prosrc, E'\\r', ''), 'UTF8')), 'hex') FROM pg_proc WHERE oid = to_regprocedure('public.${FUNCAO}')) AS corpo,
  coalesce((SELECT pg_has_role(current_user, proowner, 'USAGE') FROM pg_proc WHERE oid = to_regprocedure('public.${FUNCAO}')), false) AS dono,
  has_schema_privilege(current_user, 'public', 'CREATE') AS pode_criar,
  coalesce(has_language_privilege(current_user, 'plpgsql', 'USAGE'), false) AS linguagem,
  (has_type_privilege(current_user, 'uuid', 'USAGE') AND has_type_privilege(current_user, 'date', 'USAGE')
    AND has_type_privilege(current_user, 'time without time zone', 'USAGE') AND has_type_privilege(current_user, 'boolean', 'USAGE')) AS tipos,
  (session_user <> current_user) AS papel_trocado`;

/**
 * Inventário (somente leitura, sem ids); "hoje" de São Paulo. A 100 muda o último passo de kidmais094_conflito_ocupacao
 * para a ocupação AFETADA x — a de um escopo POR_HORARIO (a configuração e o intervalo são os do escopo dela) — contra
 * TODAS as ocupações y do mesmo recurso (kidmais062_mesmo_recurso: unidade nula compartilha com as unidades), no mesmo
 * horário configurado, fechamento distinto (a remarcação em hold é a mesma festa), sobrepostas com o intervalo de x.
 * Pareceres do Astra (25/10, P2-I1/P2-I2): y vem do conjunto completo (não só de escopos POR_HORARIO) e cada direção é
 * avaliada com o intervalo do lado afetado ANTES de deduplicar o par — o resultado não depende da ordem dos ids.
 */
const SQL_INVENTARIO = `WITH um AS (
    SELECT empresa_id, estabelecimento_id, intervalo_minimo_minutos AS intervalo FROM agenda_escopo_config WHERE capacidade_tipo = 'POR_HORARIO'),
  todas AS MATERIALIZED (
    SELECT o.fechamento_id, o.data, o.empresa_id, o.estabelecimento_id, o.configuracao_agenda_id,
           (extract(epoch FROM o.horario_inicio) / 60)::integer AS ini, (extract(epoch FROM o.horario_fim) / 60)::integer AS fim
      FROM kidmais094_ocupacoes((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date, 'infinity'::date) o),
  afetadas AS (
    SELECT t.*, um.intervalo FROM todas t JOIN um ON um.empresa_id = t.empresa_id AND um.estabelecimento_id IS NOT DISTINCT FROM t.estabelecimento_id),
  pares AS (
    SELECT DISTINCT least(x.fechamento_id, y.fechamento_id) AS a, greatest(x.fechamento_id, y.fechamento_id) AS b
      FROM afetadas x JOIN todas y ON y.data = x.data AND y.fechamento_id <> x.fechamento_id AND y.configuracao_agenda_id = x.configuracao_agenda_id
       AND kidmais062_mesmo_recurso(x.empresa_id, x.estabelecimento_id, y.empresa_id, y.estabelecimento_id)
     WHERE x.ini < y.fim + x.intervalo AND x.fim > y.ini - x.intervalo)
SELECT
  (SELECT count(*) FROM configuracao_agenda ca JOIN um ON um.empresa_id = ca.empresa_id AND um.estabelecimento_id IS NOT DISTINCT FROM ca.estabelecimento_id
    WHERE ca.capacidade > 1)::int AS horarios_capacidade_maior,
  (SELECT count(*) FROM pares)::int AS pares_mesmo_horario,
  (SELECT count(*) FROM afetadas)::int AS ocupacoes_futuras_um_salao`;

const curta = e => String(e?.message ?? e).replace(/postgres(?:ql)?:\/\/\S+/gi, '<url>').slice(0, 160);

function lerEstado(e) {
  for (const k of ['d100', 'dono', 'pode_criar', 'linguagem', 'tipos', 'papel_trocado']) assert.equal(typeof e?.[k], 'boolean', 'ESTADO_ILEGIVEL ' + k);
  assert.ok(e.corpo === null || /^[0-9a-f]{64}$/.test(e.corpo), 'ESTADO_ILEGIVEL corpo');
  const m100 = e.corpo === CORPO_CONFLITO_100 ? 'completa' : e.corpo === CORPO_CONFLITO_094 ? 'ausente' : e.corpo === CORPO_CONFLITO_108 ? 'substituida_108'
    : e.corpo === null ? 'sem_094' : 'divergente';
  return {d100: e.d100, dono: e.dono, pode_criar: e.pode_criar, linguagem: e.linguagem, tipos: e.tipos, papel_trocado: e.papel_trocado, m100};
}
function lerInventario(i) {
  for (const k of ['horarios_capacidade_maior', 'pares_mesmo_horario', 'ocupacoes_futuras_um_salao']) assert.ok(Number.isInteger(i?.[k]) && i[k] >= 0, 'INVENTARIO_ILEGIVEL ' + k);
  return {horarios_capacidade_maior: i.horarios_capacidade_maior, pares_mesmo_horario: i.pares_mesmo_horario, ocupacoes_futuras_um_salao: i.ocupacoes_futuras_um_salao};
}
/**
 * Estado aplicável (só catálogo): recusa sem 094, corpo divergente, dependência ausente e privilégio faltando ANTES de
 * ler qualquer dado — um papel sem privilégio recebe a recusa nomeada, não um erro de permissão do inventário.
 */
function exigirAplicavel(s, evidencias = []) {
  assert.ok(s.m100 !== 'sem_094', 'DEPENDENCIA_AUSENTE_100 094');
  assert.ok(s.m100 !== 'divergente', 'CORPO_DIVERGENTE_100 (098 presente ou deriva)');
  // Corpo da 108: só segue com a prova íntegra (lida à parte, em conferirSubstituida108); aqui nunca há reaplicação.
  if (s.m100 === 'substituida_108') return;
  assert.ok(evidencias.length === 0, 'EVIDENCIA_108_PARCIAL ' + evidencias.join(' '));
  if (s.m100 === 'completa') return;
  assert.ok(s.d100, 'DEPENDENCIA_AUSENTE_100 093/094/062');
  const falta = [!s.dono && 'DONO', !s.pode_criar && 'CREATE', !s.linguagem && 'LINGUAGEM', !s.tipos && 'TIPOS'].filter(Boolean);
  assert.ok(falta.length === 0, 'SEM_PRIVILEGIO_100 ' + falta.join(' '));
}
/** Plano a partir do estado e do inventário; recusa ANTES de qualquer escrita o que não for seguro. */
function planoEtapas(s, inv, evidencias = []) {
  exigirAplicavel(s, evidencias);
  if (s.m100 === 'substituida_108') return ['prova 108', 'integridade 094 apos 108'];
  if (s.m100 === 'completa') return ['postcheck 100', 'integridade 094 apos 100'];
  assert.equal(inv.pares_mesmo_horario, 0, 'CONFLITOS_PREEXISTENTES_100 ' + inv.pares_mesmo_horario);
  return ['precheck 100', 'migration 100', 'postcheck 100', 'integridade 094 apos 100'];
}

async function somenteLeitura(db, sql, tempo = '30s') {
  await db.query('BEGIN TRANSACTION READ ONLY');
  try {
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query(`SET LOCAL statement_timeout = '${tempo}'`);
    const r = await db.query(sql);
    await db.query('ROLLBACK');
    return r;
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
}
const estadoAtual = async db => lerEstado((await somenteLeitura(db, SQL_ESTADO)).rows[0]);
// Evidências da 108 (só catálogo), lidas junto com o estado e antes do inventário.
const evidencias = async db => ev108.evidencias108(ev108.lerEvidencias108((await somenteLeitura(db, ev108.SQL_EVIDENCIA_108)).rows[0]));
/**
 * Substituída pela 108: a prova única "108 íntegra" (READ ONLY, search_path = pg_catalog) e a integridade da 094 após a
 * 108. Não íntegra = recusa nomeada com os motivos (nunca sucesso, nunca reaplicação).
 */
async function conferirSubstituida108(db, raiz, checks, prova108 = {}) {
  const prova = await ev108.provar108(db, {raiz, ...prova108});
  if (!prova.integra) throw ev108.recusa('SUBSTITUIDA_108_NAO_INTEGRA ' + prova.motivos.join(' '));
  checks['prova 108'] = 'INTEGRA';
  await somenteLeitura(db, lerRevisado(raiz, INTEGRIDADE_094_APOS_108[1], INTEGRIDADE_094_APOS_108[2]));
  checks['integridade 094 apos 108'] = 'PASS';
}
// O inventário lê ocupações futuras (dados): tempo maior que o das leituras de catálogo.
const inventario = async db => lerInventario((await somenteLeitura(db, SQL_INVENTARIO, '120s')).rows[0]);

/** Conferência (nenhuma escrita): identidade, estado, inventário, plano e, em READ ONLY, precheck ou postcheck + integridade. */
async function conferirNoCliente(db, {raiz, sqlIdentidade, identidade, prova108}) {
  const r = {modo: 'conferencia'};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]);
  r.estado = await estadoAtual(db);
  r.evidencias108 = await evidencias(db);
  try { exigirAplicavel(r.estado, r.evidencias108); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  if (r.estado.m100 === 'substituida_108') {
    r.plano = planoEtapas(r.estado, undefined, r.evidencias108); r.checks = {};
    try { await conferirSubstituida108(db, raiz, r.checks, prova108); } catch (e) {
      if (!e?.recusa) throw e;
      r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r;
    }
    r.resultado = 'JA_APLICADA_SUBSTITUIDA_108';
    return r;
  }
  if (r.estado.m100 === 'ausente') r.inventario = await inventario(db);
  try { r.plano = planoEtapas(r.estado, r.inventario, r.evidencias108); } catch (e) { r.resultado = 'RECUSARIA'; r.motivo = curta(e); return r; }
  r.checks = {};
  for (const nome of r.plano.filter(n => !n.startsWith('migration '))) {
    if (r.estado.m100 === 'ausente' && nome !== 'precheck 100') { r.checks[nome] = 'APOS_100'; continue; }
    const [, arquivo, hash] = etapa(nome);
    await somenteLeitura(db, lerRevisado(raiz, arquivo, hash));
    r.checks[nome] = 'PASS';
  }
  r.resultado = r.estado.m100 === 'completa' ? 'JA_APLICADA_INTEGRIDADE_PASS' : 'PRONTA_PARA_APLICAR';
  return r;
}

/** Aplicação na ordem do plano; o inventário é relido aqui, imediatamente antes (nunca o da conferência anterior). */
async function aplicarNoCliente(db, {raiz, sqlIdentidade, identidade, registrar = () => {}, prova108}) {
  const sqls = new Map(ETAPAS.map(([nome, arquivo, hash]) => [nome, lerRevisado(raiz, arquivo, hash)]));
  const r = {etapas: []};
  r.conexao = identidade((await somenteLeitura(db, sqlIdentidade)).rows[0]); registrar(r);
  r.estadoAntes = await estadoAtual(db);
  r.evidencias108 = await evidencias(db);
  exigirAplicavel(r.estadoAntes, r.evidencias108);
  if (r.estadoAntes.m100 === 'substituida_108') {
    // Nenhuma escrita: só a prova e a integridade da 094 após a 108 (a 100 nunca é reaplicada sobre a 108).
    r.plano = planoEtapas(r.estadoAntes, undefined, r.evidencias108); registrar(r);
    r.etapas.push({nome: 'prova 108 + integridade 094 apos 108', inicio: new Date().toISOString()}); registrar(r);
    r.checks = {};
    await conferirSubstituida108(db, raiz, r.checks, prova108);
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()});
    r.estadoDepois = await estadoAtual(db);
    assert.equal(r.estadoDepois.m100, 'substituida_108', 'ESTADO_FINAL_100');
    r.resultado = 'JA_APLICADA_SUBSTITUIDA_108';
    registrar(r);
    return r;
  }
  if (r.estadoAntes.m100 === 'ausente') r.inventarioAntes = await inventario(db);
  r.plano = planoEtapas(r.estadoAntes, r.inventarioAntes, r.evidencias108); registrar(r);
  for (const nome of r.plano) {
    r.etapas.push({nome, inicio: new Date().toISOString()}); registrar(r);
    if (nome === 'migration 100') {
      try { await db.query(sqls.get(nome)); } catch (e) {
        r.etapas.at(-1).commit = commitNaFalha(e); registrar(r);
        await db.query('ROLLBACK').catch(() => {}); throw e;
      }
      // A consulta voltou sem erro: o COMMIT do arquivo valeu. Registrado ANTES de qualquer outra leitura.
      r.etapas.at(-1).commit = 'CONFIRMADO'; registrar(r);
      assert.equal((await estadoAtual(db)).m100, 'completa', 'ESTADO_DEPOIS_100');
    } else await somenteLeitura(db, sqls.get(nome));
    Object.assign(r.etapas.at(-1), {ok: true, fim: new Date().toISOString()}); registrar(r);
  }
  r.estadoDepois = await estadoAtual(db);
  assert.equal(r.estadoDepois.m100, 'completa', 'ESTADO_FINAL_100');
  r.resultado = r.plano.includes('migration 100') ? 'APLICADA_POSTCHECK_PASS' : 'JA_APLICADA_INTEGRIDADE_PASS';
  registrar(r);
  return r;
}
const commitDe = r => (r.etapas ?? []).find(x => x.nome === 'migration 100')?.commit ?? null;

function modo(argv) {
  if (argv.length === 0) return {modo: 'plano'};
  if (argv.length === 1 && argv[0] === FLAG_CONFERIR) return {modo: 'conferir'};
  if (argv.length === 3 && argv[0] === FLAG_APLICAR && argv[1] === FLAG_BACKUP) {
    assert.match(argv[2], /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_INVALIDO');
    return {modo: 'aplicar', backup: argv[2]};
  }
  assert.fail(argv.includes(FLAG_APLICAR) ? 'BACKUP_OBRIGATORIO' : 'ARGUMENTOS_RECUSADOS');
}

/**
 * Fábrica do aplicador de um ambiente (mesmo contrato da 092–094: nome, ALVO, DIR, SQL_IDENTIDADE, alvo, identidade, exigirDisco;
 * `ordem` opcional substitui a ordem operacional de staging — produção segue o runbook do plano de promoção).
 */
function criarAplicador(amb) {
  const raizPadrao = path.resolve(__dirname, '..');
  // Override de F2 (KIDMAIS_RETRATOS_108_TESTE) só com aceitaRetratosTeste: true (suíte PostgreSQL; staging nunca).
  const prova = env => ({env, aceitaTeste: amb.aceitaRetratosTeste === true});
  function plano({raiz = raizPadrao} = {}) {
    return {resultado: 'PLANO', conecta: false, ambiente: amb.nome, alvo: amb.ALVO,
      arquivos: [...ETAPAS, INTEGRIDADE_094_APOS_108].map(([nome, arquivo, hash]) => { lerRevisado(raiz, arquivo, hash); return {nome, arquivo, sha256: hash}; }),
      corpos: {ausente: CORPO_CONFLITO_094, completa: CORPO_CONFLITO_100, substituida_108: CORPO_CONFLITO_108},
      modos: {conferir: FLAG_CONFERIR, aplicar: `${FLAG_APLICAR} ${FLAG_BACKUP} <registro-do-backup>`}, registro: amb.DIR,
      preRequisitos: ['093/094 aplicadas (agenda_escopo_config, kidmais094_ocupacoes, kidmais062_mesmo_recurso) e a regra de conflito com o corpo EXATO da 094',
        'sem a 098 (corpo diferente: recusa)', 'com a 108: só confere (prova "108 íntegra" + integridade da 094 após a 108; nunca reaplica); 108 parcial recusa', 'current_user dono da função kidmais094_conflito_ocupacao, com CREATE em public e USAGE em plpgsql e nos tipos da assinatura',
        'inventário: nenhum par de ocupações futuras no mesmo horário em que um lado é de agenda com um salão (contra todas as ocupações do mesmo recurso; pares > 0 = recusa; decidir com Felipe)'],
      ordem: amb.ordem ?? ['deploy do código com este aplicador e os SQL; conferir commit e hashes implantados', FLAG_CONFERIR,
        'backup restaurável de staging registrado (id/horário; export funcional não substitui)', 'autorização de Felipe',
        'janela combinada: sem escritas de agenda/festas nem DDL concorrente', `${FLAG_CONFERIR} de novo, imediatamente antes`, FLAG_APLICAR, FLAG_CONFERIR,
        'CONFERIR da 092–094 (integridade da 094 com o corpo da 100)'],
      paradas: ['qualquer código ≠ 0: parar, copiar a saída e o marcador; não repetir',
        'FALHA: commit = CONFIRMADO | DESFEITA_PELO_SERVIDOR | INDETERMINADO; INDETERMINADO = reconciliar com a conferência antes de decidir',
        'retomada só com decisão de Felipe: renomear o marcador anterior (nunca apagar) para migration-100.<horario>.json'],
      recuperacao: ['database/rollback/20261025_100_agenda_um_salao_down.sql só com autorização própria: volta o corpo da 094 e reabre a capacidade gravada no SQL',
        'restauração do backup registrado em último caso'],
      nuncaExecuta: ['down 100', 'alteração de env', 'deploy', 'restart', 'remarcação ou cancelamento de festas']};
  }
  async function conferir({env, raiz = raizPadrao, Client = require('pg').Client}) {
    const opts = amb.alvo(env);
    const db = new Client(opts); db.on?.('error', () => undefined);
    try { await db.connect(); return await conferirNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env), prova108: prova(env)}); }
    catch (e) { await db.query('ROLLBACK').catch(() => {}); return {modo: 'conferencia', resultado: 'FALHA', mensagem: curta(e)}; }
    finally { await db.end().catch(() => {}); }
  }
  async function executar({env, backup, dir = amb.DIR, raiz = raizPadrao, Client = require('pg').Client, disco = () => amb.exigirDisco()}) {
    const opts = amb.alvo(env); disco();
    assert.match(String(backup ?? ''), /^[A-Za-z0-9:._/ -]{6,120}$/, 'BACKUP_OBRIGATORIO');
    for (const [, arquivo, hash] of [...ETAPAS, INTEGRIDADE_094_APOS_108]) lerRevisado(raiz, arquivo, hash);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const marcador = path.join(dir, MARCADOR);
    const anteriores = fs.readdirSync(dir).filter(n => /^migration-100\..+\.json$/.test(n)).sort();
    const registro = {inicio: new Date().toISOString(), ambiente: amb.nome, backup, situacao: 'INICIADA', tentativasAnteriores: anteriores};
    try { fs.writeFileSync(marcador, JSON.stringify(registro, null, 2), {flag: 'wx', mode: 0o600}); }
    catch (e) { if (e?.code === 'EEXIST') assert.fail('TENTATIVA_ANTERIOR_REVISAR ' + marcador); throw e; }
    const salvar = r => fs.writeFileSync(marcador, JSON.stringify({...registro, ...r}, null, 2), {mode: 0o600});
    let ultimo = {};
    const db = new Client(opts); db.on?.('error', () => undefined);
    try {
      await db.connect();
      const r = await aplicarNoCliente(db, {raiz, sqlIdentidade: amb.SQL_IDENTIDADE, identidade: l => amb.identidade(l, env), prova108: prova(env),
        registrar: x => { ultimo = JSON.parse(JSON.stringify(x)); salvar({...ultimo, situacao: 'EM_ANDAMENTO'}); }});
      salvar({...r, situacao: 'CONCLUIDA', commit: commitDe(r)});
      return {resultado: r.resultado, marcador, conexao: r.conexao, estadoAntes: r.estadoAntes, inventarioAntes: r.inventarioAntes,
        estadoDepois: r.estadoDepois, etapas: r.etapas.map(e => e.nome), commit: commitDe(r), ...(r.checks ? {checks: r.checks} : {})};
    } catch (e) {
      // Já conectou: sempre FALHA (código 2) com o estado do COMMIT guardado em memória (`ultimo`), mesmo que o marcador
      // não possa mais ser gravado (disco cheio, por exemplo). Parecer do Astra (B-3, P2): a falha de gravação nunca pode
      // escapar como recusa antes de conectar (código 1) nem esconder um COMMIT confirmado. O marcador anterior continua
      // no disco e impede a repetição.
      const falha = {etapa: ultimo.etapas?.at(-1)?.nome ?? 'CONEXAO', mensagem: curta(e)};
      const situacao = {commit: commitDe(ultimo), reconciliar: `${FLAG_CONFERIR} antes de qualquer decisão; não repetir`};
      let marcadorAtualizado = true, erroMarcador;
      try { salvar({...ultimo, situacao: 'FALHA', falha, ...situacao}); } catch (e2) { marcadorAtualizado = false; erroMarcador = curta(e2); }
      return {resultado: 'FALHA', marcador, falha, ...situacao, marcadorAtualizado,
        ...(marcadorAtualizado ? {} : {erroMarcador, aviso: 'MARCADOR_DESATUALIZADO: copiar esta saída (é o único registro do COMMIT); não repetir'})};
    } finally { await db.end().catch(() => {}); }
  }
  /**
   * Códigos: 0 PLANO/CONFERIDO/PASS (inclusive JA_APLICADA_SUBSTITUIDA_108: 108 íntegra, nada reaplicado); 1 recusa antes
   * de conectar (lançada); 2 FALHA registrada; 3 conferência RECUSARIA.
   */
  const CODIGO = Object.freeze({PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_INTEGRIDADE_PASS: 0, APLICADA_POSTCHECK_PASS: 0, JA_APLICADA_SUBSTITUIDA_108: 0,
    FALHA: 2, RECUSARIA: 3});
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

module.exports = {ETAPAS, FLAG_CONFERIR, FLAG_APLICAR, FLAG_BACKUP, MARCADOR, SQL_ESTADO, SQL_INVENTARIO, lerEstado, lerInventario, exigirAplicavel, planoEtapas,
  conferirNoCliente, aplicarNoCliente, modo, criarAplicador};
