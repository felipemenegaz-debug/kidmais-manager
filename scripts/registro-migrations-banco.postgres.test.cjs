/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
// Testes do registro de migrations em PostgreSQL descartável (vault "Registro de migrations no banco 20261120", §4).
// Só rodam com KIDMAIS_REGISTRO_PG_PORTA (cluster kidmais_descartavel em 127.0.0.1; 5432/5433 recusadas) e sem
// DATABASE_URL/KIDMAIS_HOMOLOGACAO_DATABASE_URL/PG* no ambiente. Cada caso usa um banco registro_t_* copiado do modelo até a 128.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const apoio = require('./registro-migrations-banco.pg-apoio.cjs');
const reg = require('./registro-migrations-banco.cjs');

const P = apoio.porta();
const pular = P ? false : 'KIDMAIS_REGISTRO_PG_PORTA ausente: testes de PG não rodaram';
const raiz = path.resolve(__dirname, '..');
const BACKUP = 'backup-teste-local:2026-11-21';
const ANT_OK = async () => ({codigo: 0, linhas: ['117 PASS (injetada no teste)'], pendentes: []});
let admin, seq = 0;
const bancos = [];

test.before(async () => {
  if (pular) return;
  admin = await apoio.conectar(P, 'postgres');
  await apoio.garantirBase(admin, P);
});
test.after(async () => {
  if (!admin) return;
  for (const b of bancos) await apoio.removerBanco(admin, b).catch(() => {});
  await admin.end();
});

async function banco() {
  const nome = `registro_t_${process.pid}_${++seq}`;
  bancos.push(nome);
  return apoio.novoBanco(admin, nome);
}
async function rodar(nome, args, deps = {}) {
  const linhas = [];
  const r = await reg.principal(['--ambiente', 'staging', ...args], {}, {
    ...apoio.ambienteLocal(P, nome, deps.portaAlvo), antecessoras: ANT_OK, prazoLiquidacao: 5000, ...deps, out: t => linhas.push(t),
  });
  return {...r, texto: r.linhas.join('\n')};
}
async function sql(nome, texto, params) {
  const c = await apoio.conectar(P, nome);
  try { return await c.query(texto, params); } finally { await c.end(); }
}
const uuidDe = (r, situacao) => (new RegExp(`tentativa=([0-9a-f-]{36}) situacao=${situacao}`).exec(r.texto) ?? [])[1];
const ok = (r, re, codigo = 0) => { assert.match(r.texto, re); assert.equal(r.codigo, codigo, r.texto); };
async function comRegistro() { const b = await banco(); ok(await rodar(b, ['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 129/); return b; }
const lerMig = id => fs.readFileSync(path.join(raiz, 'database/migrations', fs.readdirSync(path.join(raiz, 'database/migrations')).find(a => a.split('_')[1] === id)), 'utf8');

test('upgrade completo: bootstrap 129, aplicar 130 e 131, diagnóstico 0', {skip: pular}, async () => {
  const b = await comRegistro();
  ok(await rodar(b, ['--conferir-tentativa', '129', '--tentativa', (await sql(b, "SELECT tentativa::text t FROM operacao_migration_tentativas WHERE migration='129'")).rows[0].t]), /CONCLUIDA/);
  const r130 = await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP]);
  ok(r130, /APLICADA_POSTCHECK_PASS 130/);
  ok(await rodar(b, ['--aplicar-131-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 131/);
  ok(await rodar(b, ['--conferir-registro', '--tentativa', uuidDe(r130, 'CONCLUIDA')]), /TENTATIVA .* migration=130/);
  ok(await rodar(b, ['--conferir-130']), /JA_APLICADA_POSTCHECK_PASS 130/);
  ok(await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP]), /JA_APLICADA_POSTCHECK_PASS 130/);
  const linhas = (await sql(b, 'SELECT migration, situacao, versao FROM operacao_migration_tentativas ORDER BY id')).rows;
  assert.deepEqual(linhas.map(l => `${l.migration}:${l.situacao}:${l.versao}`), ['129:CONCLUIDA:2', '130:CONCLUIDA:3', '131:CONCLUIDA:3']);
});

test('133 (agenda por empresa): sem a 131 = antecessora pendente (3); depois da 131 aplica com postcheck; repetida e conferida = já aplicada; diagnóstico 0', {skip: pular}, async () => {
  const b = await comRegistro();
  ok(await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 130/);
  ok(await rodar(b, ['--aplicar-133-autorizado', '--backup', BACKUP]), /ANTECESSORA_PENDENTE 131 sem linha/, 3);
  assert.equal((await sql(b, "SELECT to_regprocedure('public.kidmais133_ocupacoes_escopo(date,date,uuid,uuid)') IS NULL AS ausente")).rows[0].ausente, true);
  ok(await rodar(b, ['--aplicar-131-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 131/);
  ok(await rodar(b, ['--aplicar-133-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 133/);
  ok(await rodar(b, ['--conferir-133']), /JA_APLICADA_POSTCHECK_PASS 133/);
  ok(await rodar(b, ['--aplicar-133-autorizado', '--backup', BACKUP]), /JA_APLICADA_POSTCHECK_PASS 133/);
  ok(await rodar(b, ['--conferir-registro']), /POSTCHECK 133 PASS[\s\S]*DIAGNOSTICO_CODIGO 0/);
  const linhas = (await sql(b, 'SELECT migration, situacao FROM operacao_migration_tentativas ORDER BY id')).rows;
  assert.deepEqual(linhas.map(l => `${l.migration}:${l.situacao}`), ['129:CONCLUIDA', '130:CONCLUIDA', '131:CONCLUIDA', '133:CONCLUIDA']);
});

test('134 (Cliente/Interna): sem a 133 = antecessora pendente (3); depois da 133 aplica com postcheck; repetida e conferida = já aplicada; diagnóstico 0', {skip: pular}, async () => {
  const b = await comRegistro();
  ok(await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 130/);
  ok(await rodar(b, ['--aplicar-131-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 131/);
  ok(await rodar(b, ['--aplicar-134-autorizado', '--backup', BACKUP]), /ANTECESSORA_PENDENTE 133 sem linha/, 3);
  assert.equal((await sql(b, "SELECT to_regclass('public.plataforma_empresas_uso') IS NULL AS ausente")).rows[0].ausente, true);
  ok(await rodar(b, ['--aplicar-133-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 133/);
  ok(await rodar(b, ['--aplicar-134-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 134/);
  ok(await rodar(b, ['--conferir-134']), /JA_APLICADA_POSTCHECK_PASS 134/);
  ok(await rodar(b, ['--aplicar-134-autorizado', '--backup', BACKUP]), /JA_APLICADA_POSTCHECK_PASS 134/);
  ok(await rodar(b, ['--conferir-registro']), /POSTCHECK 134 PASS[\s\S]*DIAGNOSTICO_CODIGO 0/);
  const linhas = (await sql(b, 'SELECT migration, situacao FROM operacao_migration_tentativas ORDER BY id')).rows;
  assert.deepEqual(linhas.map(l => `${l.migration}:${l.situacao}`), ['129:CONCLUIDA', '130:CONCLUIDA', '131:CONCLUIDA', '133:CONCLUIDA', '134:CONCLUIDA']);
});

test('Astra r1 (134): postcheck recusa UNIQUE extra e NOT NULL não validado; down recusa com tentativa ativa no registro', {skip: pular}, async () => {
  const b = await comRegistro();
  for (const m of ['130', '131', '133', '134']) ok(await rodar(b, [`--aplicar-${m}-autorizado`, '--backup', BACKUP]), new RegExp('APLICADA_POSTCHECK_PASS ' + m));
  const pos = fs.readFileSync(path.join(raiz, 'database/checks/20261123_134_postcheck.sql'), 'utf8');
  const down = fs.readFileSync(path.join(raiz, 'database/rollback/20261123_134_empresas_uso_down.sql'), 'utf8');
  await sql(b, pos);
  await sql(b, 'SET quote_all_identifiers = on;\n' + pos); // Astra r2 (P3)
  await sql(b, 'CREATE UNIQUE INDEX t134_extra ON plataforma_empresas_uso (uso)');
  await assert.rejects(sql(b, pos), /forma divergente/);
  await sql(b, 'DROP INDEX t134_extra');
  await sql(b, 'ALTER TABLE plataforma_empresas_uso ALTER COLUMN uso DROP NOT NULL; ALTER TABLE plataforma_empresas_uso ADD CONSTRAINT t134_nn NOT NULL uso NOT VALID');
  await assert.rejects(sql(b, pos), /forma divergente/);
  await sql(b, 'ALTER TABLE plataforma_empresas_uso VALIDATE CONSTRAINT t134_nn');
  await assert.rejects(sql(b, "SET kidmais.rollback_134 = 'descartar-marcas';\n" + down), /tentativa ativa no registro/);
  assert.equal((await sql(b, "SELECT to_regclass('public.plataforma_empresas_uso') IS NOT NULL AS existe")).rows[0].existe, true);
  ok(await rodar(b, ['--conferir-134']), /JA_APLICADA_POSTCHECK_PASS 134/);
});

test('bootstrap: repetido = 0; identidade recusada = 1 sem DDL; antecessoras pendentes = 3 sem DDL', {skip: pular}, async () => {
  const b = await comRegistro();
  ok(await rodar(b, ['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP]), /JA_APLICADA_POSTCHECK_PASS 129/);
  const c = await banco();
  const r = await rodar(c, ['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP], {identidade: () => { throw new Error('banco errado'); }});
  ok(r, /IDENTIDADE_RECUSADA|banco errado/, 1);
  const r2 = await rodar(c, ['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP], {antecessoras: async () => ({codigo: 3, linhas: ['117 PENDENTE'], pendentes: ['117']})});
  ok(r2, /ANTECESSORAS_PENDENTES 117/, 3);
  assert.equal((await sql(c, "SELECT to_regclass('public.operacao_migration_tentativas') t")).rows[0].t, null);
});

test('sem a 129: aplicar recusa REGISTRO_INVALIDO; diagnóstico também; estado da 130 sem registro', {skip: pular}, async () => {
  const b = await banco();
  ok(await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP]), /REGISTRO_INVALIDO tabela ausente/, 1);
  ok(await rodar(b, ['--conferir-registro']), /REGISTRO_AUSENTE[\s\S]*DIAGNOSTICO_CODIGO 3/, 3);
  const c = await comRegistro();
  await sql(c, lerMig('130'));
  ok(await rodar(c, ['--aplicar-130-autorizado', '--backup', BACKUP]), /ESTADO_SEM_REGISTRO_REVISAR 130/, 1);
});

test('linha da 129 não CONCLUIDA e estrutura adulterada recusam (exigirRegistro)', {skip: pular}, async () => {
  const b = await comRegistro();
  await sql(b, 'GRANT SELECT ON operacao_migration_tentativas TO PUBLIC');
  ok(await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP]), /REGISTRO_INVALIDO .*concessão na tabela/, 1);
  const c = await banco();
  const r = await rodar(c, ['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP], {ganchos: {depoisDoCommit129: () => { throw new Error('morto depois do COMMIT'); }}});
  ok(r, /VERIFICACAO_PENDENTE/, 1);
  ok(await rodar(c, ['--aplicar-130-autorizado', '--backup', BACKUP]), /REGISTRO_INVALIDO linha da 129 VERIFICACAO_PENDENTE/, 1);
  ok(await rodar(c, ['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP]), /REGISTRO_PENDENTE 129 VERIFICACAO_PENDENTE/, 3);
  ok(await rodar(c, ['--arquivar-tentativa', '129', '--tentativa', uuidDe(r, 'VERIFICACAO_PENDENTE'), '--motivo', 'motivo de teste longo']), /LINHA_129_NAO_ARQUIVA/, 1);
  ok(await rodar(c, ['--concluir-verificacao', '129', '--tentativa', uuidDe(r, 'VERIFICACAO_PENDENTE')]), /CONCLUIDA 129/);
});

test('falha no corpo: FALHA sem estado, arquivar, nova reserva vincula substituida_por', {skip: pular}, async () => {
  const b = await comRegistro();
  const r = await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP], {ganchos: {antesDoCommitCorpo: () => { throw new Error('falha simulada'); }}});
  ok(r, /CORPO 130 commit=NAO_COMMITADA[\s\S]*FALHA 130/, 2);
  const u = uuidDe(r, 'INICIADA');
  ok(await rodar(b, ['--conferir-130']), /TENTATIVA_ANTERIOR_REVISAR .* FALHA/, 1);
  ok(await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP]), /TENTATIVA_ANTERIOR_REVISAR/, 1);
  ok(await rodar(b, ['--concluir-verificacao', '130', '--tentativa', u]), /CONCLUSAO_RECUSADA/, 1);
  ok(await rodar(b, ['--arquivar-tentativa', '130', '--tentativa', u, '--motivo', 'falha simulada no teste']), /ARQUIVADA/);
  ok(await rodar(b, ['--arquivar-tentativa', '130', '--tentativa', u, '--motivo', 'falha simulada no teste']), /TENTATIVA_ARQUIVADA/, 1);
  const r2 = await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP]);
  ok(r2, /APLICADA_POSTCHECK_PASS 130/);
  const v = (await sql(b, 'SELECT substituida_por::text s FROM operacao_migration_tentativas WHERE tentativa = $1', [u])).rows[0].s;
  assert.equal(v, uuidDe(r2, 'INICIADA'));
});

test('morto depois do COMMIT do corpo: EM_ANDAMENTO, concluir-verificacao fecha; morto antes: INICIADA, concluir recusa, arquivar', {skip: pular}, async () => {
  const b = await comRegistro();
  const r = await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP], {ganchos: {depoisDoCommitCorpo: () => { throw new Error('morto'); }}});
  ok(r, /situacao=EM_ANDAMENTO/, 1);
  const u = uuidDe(r, 'INICIADA');
  ok(await rodar(b, ['--conferir-tentativa', '130', '--tentativa', u]), /EM_ANDAMENTO/, 3);
  ok(await rodar(b, ['--arquivar-tentativa', '130', '--tentativa', u, '--motivo', 'não deveria arquivar']), /USAR_CONCLUIR_VERIFICACAO/, 1);
  ok(await rodar(b, ['--concluir-verificacao', '130', '--tentativa', u]), /CONCLUIDA 130/);
  const r2 = await rodar(b, ['--aplicar-131-autorizado', '--backup', BACKUP], {ganchos: {depoisDaReserva: () => { throw new Error('morto'); }}});
  const u2 = uuidDe(r2, 'INICIADA');
  ok(await rodar(b, ['--concluir-verificacao', '131', '--tentativa', u2]), /CONCLUSAO_RECUSADA .* INICIADA corpo=nao/, 1);
  ok(await rodar(b, ['--arquivar-tentativa', '131', '--tentativa', u2, '--motivo', 'reserva sem corpo no teste']), /ARQUIVADA/);
});

test('DIVERGENCIA: CONCLUIDA ou corpo com estado ausente = 3', {skip: pular}, async () => {
  const b = await comRegistro();
  await sql(b, "INSERT INTO operacao_migration_tentativas (ambiente, migration, tentativa, backup, situacao) VALUES ('staging', '130', gen_random_uuid(), 'backup-x', 'CONCLUIDA')");
  ok(await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP]), /DIVERGENCIA_REGISTRO_ESTADO/, 3);
  ok(await rodar(b, ['--conferir-130']), /DIVERGENCIA_REGISTRO_ESTADO/, 3);
});

test('EXECUTOR_ATIVO com a trava ocupada; ordem: próprio id antes da antecessora; antecessora pendente', {skip: pular}, async () => {
  const b = await comRegistro();
  const outro = await apoio.conectar(P, b);
  try {
    await outro.query("SELECT pg_advisory_lock(hashtext('kidmais-migration'), hashtext('staging:130'))");
    ok(await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP]), /EXECUTOR_ATIVO staging:130/, 1);
    ok(await rodar(b, ['--conferir-130']), /TRAVA staging:130 OCUPADA/);
  } finally { await outro.end(); }
  ok(await rodar(b, ['--aplicar-131-autorizado', '--backup', BACKUP]), /ANTECESSORA_PENDENTE 130 sem linha/, 3);
  await sql(b, "INSERT INTO operacao_migration_tentativas (ambiente, migration, tentativa, backup, situacao) VALUES ('staging', '131', gen_random_uuid(), 'backup-x', 'FALHA')");
  const r = await rodar(b, ['--aplicar-131-autorizado', '--backup', BACKUP]);
  ok(r, /TENTATIVA_ANTERIOR_REVISAR/, 1);
  assert.doesNotMatch(r.texto, /ANTECESSORA/);
  const c = await comRegistro();
  await sql(c, "INSERT INTO operacao_migration_tentativas (ambiente, migration, tentativa, backup, situacao) VALUES ('staging', '130', gen_random_uuid(), 'backup-x', 'CONCLUIDA')");
  // 130 CONCLUIDA no registro mas sem estado: a 131 recusa por antecessora divergente.
  ok(await rodar(c, ['--aplicar-131-autorizado', '--backup', BACKUP]), /ANTECESSORA_DIVERGENTE 130 estado=ausente/, 3);
});

test('VINCULO_DESATUALIZADO quando a arquivada muda antes do vínculo', {skip: pular}, async () => {
  const b = await comRegistro();
  const r = await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP], {ganchos: {antesDoCommitCorpo: () => { throw new Error('x'); }}});
  const u = uuidDe(r, 'INICIADA');
  ok(await rodar(b, ['--arquivar-tentativa', '130', '--tentativa', u, '--motivo', 'falha simulada no teste']), /ARQUIVADA/);
  const r2 = await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP], {ganchos: {antesDoVinculo: async () => {
    await sql(b, "UPDATE operacao_migration_tentativas SET versao = versao + 1, detalhe = detalhe || '{\"teste\":1}' WHERE tentativa = $1", [u]);
  }}});
  ok(r2, /VINCULO_DESATUALIZADO/, 1);
  assert.equal((await sql(b, "SELECT count(*)::int n FROM operacao_migration_tentativas WHERE migration='130'")).rows[0].n, 1);
});

test('gatilho: UPDATE de CONCLUIDA e DELETE recusados', {skip: pular}, async () => {
  const b = await comRegistro();
  await assert.rejects(sql(b, "UPDATE operacao_migration_tentativas SET versao = versao + 1 WHERE migration = '129'"));
  await assert.rejects(sql(b, "DELETE FROM operacao_migration_tentativas WHERE migration = '129'"));
});

test('conferir-tentativa: uuid de outra migration = 1; ausente = 3 ou conclusivo', {skip: pular}, async () => {
  const b = await comRegistro();
  const u129 = (await sql(b, "SELECT tentativa::text t FROM operacao_migration_tentativas WHERE migration='129'")).rows[0].t;
  ok(await rodar(b, ['--conferir-tentativa', '130', '--tentativa', u129]), /TENTATIVA_DE_OUTRA_MIGRATION/, 1);
  const r = await rodar(b, ['--conferir-tentativa', '130', '--tentativa', '00000000-0000-4000-8000-000000000000']);
  assert.ok([0, 3].includes(r.codigo), r.texto);
  assert.match(r.texto, /AUSENTE|NAO_ENCONTRADA|nenhuma/);
});

test('proxy: resposta do COMMIT do corpo perdida = COMMIT_INDETERMINADO ou CONFIRMADO conferível, sem repetir', {skip: pular}, async () => {
  const b = await comRegistro();
  const px = await apoio.proxy(P);
  try {
    let armado = false;
    px.regra = (cx, d) => (armado && apoio.ehComando(d, 'COMMIT') ? 'cortarResposta' : 'passar');
    const r = await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP], {portaAlvo: px.porta, ganchos: {antesDoCommitCorpo: () => { armado = true; }}});
    assert.equal(r.codigo, 2, r.texto);
    assert.match(r.texto, /COMMIT_(INDETERMINADO|CONFIRMADO|[A-Z_]+) 130/);
    const u = uuidDe(r, 'INICIADA');
    const t = await rodar(b, ['--conferir-tentativa', '130', '--tentativa', u]);
    assert.match(t.texto, /EM_ANDAMENTO/);
    ok(await rodar(b, ['--concluir-verificacao', '130', '--tentativa', u]), /CONCLUIDA 130/);
  } finally { await px.fechar(); }
});

test('proxy: queda antes do COMMIT da reserva = nada reservado', {skip: pular}, async () => {
  const b = await comRegistro();
  const px = await apoio.proxy(P);
  try {
    let armado = false;
    px.regra = (cx, d) => (armado && apoio.ehComando(d, 'COMMIT') ? 'cortar' : 'passar');
    const r = await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP], {portaAlvo: px.porta, ganchos: {antesDoCommitReserva: () => { armado = true; }}});
    ok(r, /RESERVA_INDETERMINADA/, 2);
    await new Promise(s => setTimeout(s, 500));
    assert.equal((await sql(b, "SELECT count(*)::int n FROM operacao_migration_tentativas WHERE migration='130'")).rows[0].n, 0);
    ok(await rodar(b, ['--conferir-tentativa', '130', '--tentativa', uuidDe(r, 'RESERVANDO')]), /^AUSENTE tentativa=.* historico=nenhum$/m, 3);
  } finally { await px.fechar(); }
});

test('sessão de leitura: diagnóstico não escreve nada e sobrevive a tabela que aparece entre as rodadas', {skip: pular}, async () => {
  const b = await banco();
  ok(await rodar(b, ['--conferir-registro']), /REGISTRO_AUSENTE[\s\S]*DIAGNOSTICO_CODIGO 3/, 3);
  ok(await rodar(b, ['--aplicar-129-bootstrap-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 129/);
  const antes = (await sql(b, 'SELECT count(*)::int n, max(versao) v FROM operacao_migration_tentativas')).rows[0];
  ok(await rodar(b, ['--conferir-registro']), /ESTADO 130 ausente/);
  const depois = (await sql(b, 'SELECT count(*)::int n, max(versao) v FROM operacao_migration_tentativas')).rows[0];
  assert.deepEqual(depois, antes);
});

test('down da 129: recusa com linhas; vazia remove a tabela e a função', {skip: pular}, async () => {
  const down = fs.readFileSync(path.join(raiz, 'database/rollback/20261121_129_registro_migrations_down.sql'), 'utf8');
  const a = await comRegistro();
  await assert.rejects(sql(a, down), /tem linhas; recusado/);
  const b = await banco();
  await sql(b, fs.readFileSync(path.join(raiz, 'database/migrations/20261121_129_registro_migrations.sql'), 'utf8'));
  await sql(b, down);
  const r = (await sql(b, "SELECT to_regclass('public.operacao_migration_tentativas') t, to_regprocedure('public.operacao_migration_tentativas_terminal()') f")).rows[0];
  assert.deepEqual(r, {t: null, f: null});
});

// ---------------------------------------------------------------- sessões curtas do diagnóstico em PG real (§4 (a), (c), (d), (f), isolamento)
async function comUpgrade() {
  const b = await comRegistro();
  ok(await rodar(b, ['--aplicar-130-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 130/);
  ok(await rodar(b, ['--aplicar-131-autorizado', '--backup', BACKUP]), /APLICADA_POSTCHECK_PASS 131/);
  return b;
}
const na130 = (info, rotulo) => info.sessao === 'ESTADO 130' && info.rotulo === rotulo;
const DIAG = ['--conferir-registro', '--ids', '130,131'];

test('sessões (a)/(c)/(d): P0001 marcado = FALHOU (3); timeout = 57014 (1); P0001 auxiliar = ERRO_VERIFICACAO (1); 131 sempre PASS', {skip: pular}, async () => {
  const b = await comUpgrade();
  ok(await rodar(b, DIAG), /POSTCHECK 130 PASS[\s\S]*POSTCHECK 131 PASS[\s\S]*DIAGNOSTICO_CODIGO 0/);
  const a = await rodar(b, DIAG, {ganchos: {sql: (i, s) => (na130(i, 'POSTCHECK') ? "DO $$BEGIN RAISE EXCEPTION 'reprovado no teste'; END$$" : s)}});
  ok(a, /POSTCHECK 130 FALHOU[\s\S]*POSTCHECK 131 PASS/, 3);
  assert.doesNotMatch(a.texto, /ERRO_VERIFICACAO/);
  const c = await rodar(b, DIAG, {ganchos: {sql: (i, s) => (na130(i, 'POSTCHECK') ? "SET LOCAL statement_timeout = '300ms'; SELECT pg_sleep(3)" : s)}});
  ok(c, /ERRO_VERIFICACAO ESTADO 130 POSTCHECK 57014[\s\S]*POSTCHECK 131 PASS/, 1);
  assert.doesNotMatch(c.texto, /FALHOU/);
  const d = await rodar(b, DIAG, {ganchos: {auxiliar: ({sessao}) => (sessao === 'ESTADO 130' ? "DO $$BEGIN RAISE EXCEPTION 'auxiliar'; END$$" : null)}});
  ok(d, /ERRO_VERIFICACAO ESTADO 130 AUXILIAR P0001[\s\S]*POSTCHECK 131 PASS/, 1);
  assert.doesNotMatch(d.texto, /FALHOU/);
});

test('sessões (f): backend da 130 encerrado na pausa antes do postcheck = 57P01, sem ROLLBACK, 131 PASS', {skip: pular}, async () => {
  const b = await comUpgrade();
  const enviados = [];
  const r = await rodar(b, DIAG, {ganchos: {
    antesDe: async i => { if (na130(i, 'POSTCHECK')) { await admin.query('SELECT pg_terminate_backend($1)', [i.pid]); await new Promise(s => setTimeout(s, 300)); } },
    sql: (i, s) => { enviados.push(`${i.sessao}|${s.slice(0, 8)}`); return s; },
  }});
  ok(r, /ERRO_VERIFICACAO ESTADO 130 POSTCHECK 57P01[\s\S]*POSTCHECK 131 PASS/, 1);
  assert.equal(r.linhas.filter(l => l.startsWith('ERRO_VERIFICACAO ESTADO 130')).length, 1);
  assert.ok(!enviados.includes('ESTADO 130|ROLLBACK'), enviados.join(','));
});

test('isolamento: BEGIN trocado por REPEATABLE READ = LEITURA_ISOLAMENTO_INVALIDO (1) sem consultar', {skip: pular}, async () => {
  const b = await comUpgrade();
  const consultas = [];
  const r = await rodar(b, DIAG, {ganchos: {sql: (i, s) => { consultas.push(i.rotulo); return i.rotulo === 'BEGIN' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : s; }}});
  ok(r, /LEITURA_ISOLAMENTO_INVALIDO/, 1);
  assert.ok(!consultas.includes('SONDAGEM') && !consultas.includes('SENTINELAS'), consultas.join(','));
});
