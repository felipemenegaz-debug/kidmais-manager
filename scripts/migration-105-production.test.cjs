/* eslint-disable @typescript-eslint/no-require-imports */
// Aplicador da 105 de PRODUÇÃO (plano MCP produção pré-requisitos, rev. 3, P1) com cliente simulado que só CONFIRMA no
// COMMIT e descarta no ROLLBACK: alvo/TLS/papel/disco, PITR como gate, conferência só leitura com os cinco estados,
// transação ÚNICA (precheck, DDL, postcheck, integridade e definições antes do COMMIT), integridade por DEFINIÇÕES com
// mutantes que preservam nomes e contagens, situação do COMMIT (40003 = INDETERMINADO), marcador com o estado em memória
// e falhas de disco (ENOSPC) antes, durante e depois do COMMIT. Sem rede nem banco: a forma real do deparse é provada no
// PostgreSQL descartável autorizado (pendente).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const comum = require('./migration-105-comum.cjs');
const nucleo = require('./migration-105-production-nucleo.cjs');
const defs = require('./migration-105-definicoes.cjs');
const prod = require('./migration-105-production.cjs');
const {lerRevisado} = require('./migration-092-094-comum.cjs');

const raiz = path.resolve(__dirname, '..');
const ler = nome => { const [, a, h] = nucleo.ETAPAS.find(e => e[0] === nome); return lerRevisado(raiz, a, h); };
const M105 = ler('migration 105'), PRE = ler('precheck 105'), POS = ler('postcheck 105'), INT = ler('integridade 105'), DEF = ler('definicoes 105');
const CORPO = nucleo.corpoDaMigration(M105);
const URL_PROD = 'postgresql://usuario:SENHA_FALSA@dpg-dak750gae00c73fudmg0-a:5432/kidmais_production';
const ENV = Object.freeze({RENDER: 'true', RENDER_SERVICE_ID: 'srv-dak77m2d0e5s73b8rkkg', KIDMAIS_DEPLOY_ENV: 'production', DATABASE_SSL: 'true',
  DATABASE_SSL_REJECT_UNAUTHORIZED: 'false', DATABASE_URL: URL_PROD});
const ID = Object.freeze({db: 'kidmais_production', tls: true, tls_versao: 'TLSv1.3', servidor_privado: true, papel_trocado: true, sessao_membro: true,
  papel_superusuario: false, sessao_superusuario: false, dono_empresas: true, dono_usuarios: true});
const AGORA = Date.parse('2026-11-02T03:30:00Z');
const BACKUP = 'PITR 2026-11-02T03:10Z painel Render janela 7 dias';
const erroPg = (code, msg = 'erro simulado') => Object.assign(new Error(msg), code ? {code} : {});
const estado = (extra = {}) => ({versao_pg: 180006, d105: true, m105_tabelas: 0, m105_funcao: 0, m105_gatilho: 0, usar_public: true, pode_criar: true,
  referencias_105: true, plpgsql: true, gerar_uuid: true, ler_105: false, papel_trocado: true, ...extra});
const COMPLETA = {m105_tabelas: 6, m105_funcao: 1, m105_gatilho: 1, ler_105: true};
const CONTAGENS = {clientes: 0, concessoes: 0, concessoes_ativas: 0, tokens: 0, auditoria: 0};
/** O inventário que o catálogo devolveria para a 105 íntegra (primeira alternativa de cada chave), na ordem do SQL. */
const linhas = () => Object.entries(defs.ESPERADO).map(([chave, v]) => ({chave, definicao: [v].flat()[0]}))
  .sort((a, b) => (a.chave < b.chave ? -1 : 1));
const UUID_AUSENTE = Object.freeze([{chave: 'uuid_publico:gen_random_uuid()', definicao: 'ausente'}]);
const UUID_HOMONIMO = 'extensao=|linguagem=sql|simbolo=SELECT 00000000-0000-0000-0000-000000000000::uuid|biblioteca=|retorno=uuid|volatil=v';
const muda = (chave, f) => rs => rs.map(l => (l.chave === chave ? {...l, definicao: f(l.definicao)} : l));

/** Mutantes de SCHEMA que preservam nomes e contagens (plano P1): cada um troca só o texto que o catálogo devolveria. */
const MUTANTES = Object.freeze({
  'predicado do índice invertido': muda('indice:mcp_oauth_concessoes.mcp_oauth_concessoes_ativa_uk', d => d.replace('WHERE (revogada_em IS NULL)', 'WHERE (revogada_em IS NOT NULL)')),
  'CHECK afrouxado (escopos até 30)': muda('restricao:mcp_oauth_tokens.mcp_oauth_tokens_escopos_check', d => d.replace('<= 3)', '<= 30)')),
  'CHECK afrouxado (ACESSO até 31 dias)': muda('restricao:mcp_oauth_tokens.mcp_oauth_tokens_check1', d => d.replace("'02:00:00'::interval", "'31 days'::interval")),
  'FK trocada para ON DELETE CASCADE': muda('restricao:mcp_oauth_tokens.mcp_oauth_tokens_concessao_id_fkey', d => d.replace('(id)|', '(id) ON DELETE CASCADE|')),
  'corpo do gatilho trocado': muda('funcao:mcp_oauth_concessao_revogacao_imutavel()', d => d.replace(/corpo=[0-9a-f]{64}/, 'corpo=' + 'ab'.repeat(32))),
  'gatilho desabilitado': muda('gatilho:mcp_oauth_concessoes.mcp_oauth_concessoes_revogacao_imutavel', d => d.replace('habilitado=O', 'habilitado=D')),
  'gatilho de FK desabilitado': muda('gatilhos_internos:mcp_oauth_codigos', () => 'fora_do_modo_O=2'),
  // Rodada 1 do Astra, P2-1: modo O→R (não dispara nas operações normais), lado referenciado e gatilho ausente.
  'gatilho interno O→R': muda('gatilhos_internos:mcp_oauth_tokens', () => 'fora_do_modo_O=1'),
  'gatilho de FK em modo R': muda('gatilhos_fk:mcp_oauth_tokens.mcp_oauth_tokens_concessao_id_fkey', d => d.replace('public.mcp_oauth_tokens:RI_FKey_check_ins:5:O', 'public.mcp_oauth_tokens:RI_FKey_check_ins:5:R')),
  'gatilho de FK desabilitado no lado referenciado (empresas)': muda('gatilhos_fk:mcp_oauth_concessoes.mcp_oauth_concessoes_empresa_id_fkey', d => d.replace('public.empresas:RI_FKey_noaction_del:9:O', 'public.empresas:RI_FKey_noaction_del:9:D')),
  'gatilho de FK ausente': muda('gatilhos_fk:mcp_oauth_concessoes.mcp_oauth_concessoes_usuario_id_fkey', d => d.split(',').slice(1).join(',')),
  'gatilho de FK com CASCADE no lado referenciado': muda('gatilhos_fk:mcp_oauth_codigos.mcp_oauth_codigos_concessao_id_fkey', d => d.replace('RI_FKey_noaction_del', 'RI_FKey_cascade_del')),
  // Rodada 1 do Astra, P2-2: homônimo de public.gen_random_uuid() que não é o pgcrypto genuíno.
  'public.gen_random_uuid() homônimo': muda('uuid_publico:gen_random_uuid()', () => UUID_HOMONIMO),
  'RLS ligada': muda('tabela:mcp_oauth_concessoes', d => d.replace('rls=false', 'rls=true')),
  'RULE criada': muda('tabela:mcp_auditoria', d => d.replace('regras=0', 'regras=1')),
  'dono diferente': muda('tabela:mcp_oauth_tokens', d => d.replace('dono_da_aplicacao=true', 'dono_da_aplicacao=false')),
  'função SECURITY DEFINER': muda('funcao:mcp_oauth_concessao_revogacao_imutavel()', d => d.replace('definer=false', 'definer=true')),
  'coluna anulável': muda('coluna:mcp_oauth_concessoes.empresa_id', d => d.replace('NOT NULL', 'NULL')),
  'DEFAULT trocado': muda('coluna:mcp_auditoria.ocorrido_em', d => d.replace('clock_timestamp()', 'now()')),
  'índice único virou comum': muda('indice:mcp_oauth_tokens.mcp_oauth_tokens_token_hash_key', d => d.replace('unico=true', 'unico=false')),
  // Mesmos tokens, agrupamento diferente (lição do B-2: comparar sem parênteses deixava passar).
  'agrupamento trocado (mesmos tokens)': muda('restricao:mcp_oauth_tokens.mcp_oauth_tokens_escopos_check', d => d.replace(
    '(((cardinality(escopos) >= 1) AND (cardinality(escopos) <= 3)) AND (escopos <@ ', '((cardinality(escopos) >= 1) AND ((cardinality(escopos) <= 3) AND (escopos <@ ')
    .replace("'conhecimento:read'::text])))", "'conhecimento:read'::text]))))")),
  'restrição NOT VALID': muda('restricao:mcp_oauth_codigos.mcp_oauth_codigos_check', d => d.replace('validada=true', 'validada=false')),
});

/**
 * Cliente simulado transacional: o corpo da migration deixa o efeito PENDENTE (estado completo e o inventário
 * `aplicadas`); COMMIT confirma; ROLLBACK descarta. Opções: falharEm (trecho), falharCommit ({erro} | {rollback}),
 * trava (pg_try_advisory_xact_lock), integra / integraNaTransacao, estadoNaTransacao (estado relido dentro da transação).
 */
function clienteFalso({inicial = estado(), id = ID, inicialDefs = UUID_AUSENTE, aplicadas = linhas(), integra = true, integraNaTransacao = true,
  falharEm, erro, falharCommit, trava = true, estadoNaTransacao, falharConnect} = {}) {
  const log = []; let ro = false, tx = false, pendente = null, commits = 0;
  const atual = {estado: {...inicial}, defs: inicialDefs, integra};
  const visivel = () => pendente ?? atual;
  const C = class {
    on() {} async connect() { if (falharConnect) throw falharConnect; } async end() {}
    async query(sql) {
      if (sql === 'BEGIN TRANSACTION READ ONLY') { ro = true; tx = true; } else if (sql === 'BEGIN') { ro = false; tx = true; }
      log.push({sql, ro, tx});
      if (falharEm && sql.includes(falharEm)) throw erro ?? erroPg('55P03', 'falha simulada');
      if (sql === 'ROLLBACK') { ro = false; tx = false; pendente = null; return {rows: [], command: 'ROLLBACK'}; }
      if (sql === 'COMMIT') {
        commits++; tx = false;
        if (falharCommit?.rollback) { pendente = null; return {rows: [], command: 'ROLLBACK'}; }
        if (falharCommit?.erro) { if (falharCommit.efetivou && pendente) Object.assign(atual, pendente); pendente = null; throw falharCommit.erro; }
        if (pendente) { Object.assign(atual, pendente); pendente = null; }
        return {rows: [], command: 'COMMIT'};
      }
      if (sql === prod.SQL_IDENTIDADE) return {rows: [id]};
      if (sql === comum.SQL_ESTADO) return {rows: [{...(tx && !ro && !pendente && estadoNaTransacao ? estadoNaTransacao : visivel().estado)}]};
      if (sql.includes('pg_try_advisory_xact_lock')) return {rows: [{ok: trava}]};
      if (sql === INT) return {rows: [{integra_105: visivel().integra}]};
      if (sql === DEF) return {rows: visivel().defs};
      if (sql.includes('AS concessoes_ativas')) return {rows: [{...CONTAGENS}]};
      if (sql === CORPO) {
        assert.equal(ro, false, 'DDL nunca em READ ONLY'); assert.equal(tx, true, 'DDL só dentro da transação aberta pelo aplicador');
        pendente = {estado: {...atual.estado, ...COMPLETA}, defs: aplicadas, integra: integraNaTransacao};
      }
      assert.notEqual(sql, M105, 'o arquivo com BEGIN/COMMIT nunca é enviado');
      return {rows: []};
    }
  };
  C.log = log; C.atual = atual; C.commits = () => commits;
  return C;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aplicador-105-prod-'));
const semDisco = () => {};
const executar = (C, extra = {}) => prod.executar({env: ENV, backup: BACKUP, dir: extra.dir ?? tmp(), Client: C, disco: semDisco, agora: AGORA, ...extra});
const conferir = C => prod.conferir({env: ENV, Client: C});
const marcadorDe = dir => JSON.parse(fs.readFileSync(path.join(dir, 'migration-105.json'), 'utf8'));
const escritasNoBanco = log => log.filter(x => !x.ro && x.sql !== 'ROLLBACK' && !/^(BEGIN TRANSACTION READ ONLY|SET LOCAL)/.test(x.sql));
const sha = s => createHash('sha256').update(s).digest('hex');

test('hashes dos 5 SQL (LF); corpo da migration sem BEGIN/COMMIT finais e com os SET LOCAL; arquivos com transação inesperada recusados', () => {
  for (const [, arquivo, hash] of nucleo.ETAPAS) assert.equal(sha(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n')), hash, arquivo);
  assert.deepEqual(nucleo.ETAPAS.map(e => e[0]), ['precheck 105', 'migration 105', 'postcheck 105', 'integridade 105', 'definicoes 105']);
  assert.deepEqual(nucleo.ETAPAS.slice(0, 4), comum.ETAPAS, 'os 4 SQL de staging, com os mesmos hashes');
  assert.doesNotMatch(CORPO, /^BEGIN;$/m); assert.doesNotMatch(CORPO, /^COMMIT;$/m);
  assert.match(CORPO, /SET LOCAL lock_timeout = '5s';/); assert.match(CORPO, /SET LOCAL search_path = public, pg_catalog;/);
  assert.equal(M105.replace(/^BEGIN;\n/m, ''), CORPO + 'COMMIT;\n');
  assert.throws(() => nucleo.corpoDaMigration(M105 + 'COMMIT;\n'), /TRANSACAO_INESPERADA/);
  assert.throws(() => nucleo.corpoDaMigration(M105.replace(/^BEGIN;\n/m, '')), /TRANSACAO_INESPERADA/);
});

test('SQL de definições: só leitura do catálogo, tabelas por nome qualificado, NOT NULL do PG18 fora, ordem estável, sem SET próprio', () => {
  assert.doesNotMatch(DEF.replace(/--.*$/gm, ''), /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|SET|COPY|DO)\b/i);
  for (const t of ["to_regclass('public.' || t.nome)", "k.contype <> 'n'", 'pg_get_constraintdef(k.oid)', 'pg_get_indexdef(i.indexrelid)',
    'pg_get_triggerdef(g.oid)', 'r.relrowsecurity', 'r.relforcerowsecurity', 'pg_policy', 'pg_rewrite', 'pg_inherits', 'tgisinternal',
    'sha256(convert_to(p.prosrc', 'p.prosecdef', 'p.proconfig', 'g.tgconstraint = k.oid', "g.tgenabled <> 'O'", "dp.deptype = 'e'", "p.proname = 'gen_random_uuid'", "to_regclass('public.empresas')", 'ORDER BY chave COLLATE "C"']) assert.ok(DEF.includes(t), t);
  assert.deepEqual([...defs.SET_DEPARSE], ['SET LOCAL search_path = pg_catalog, pg_temp', "SET LOCAL IntervalStyle = 'postgres'"]);
});

test('inventário esperado confere com a migration e com as contagens da integridade antiga (145 definições)', () => {
  const E = defs.ESPERADO, chaves = Object.keys(E);
  assert.equal(chaves.length, 145);
  const VALORES = [...INT.matchAll(/\('(mcp_\w+)', (\d+), (\d+), (\d+), (\d+), (\d+)\)/g)];
  assert.equal(VALORES.length, 6);
  for (const [, t, colunas, checks, pks, uniques, fks] of VALORES) {
    const r = tipo => chaves.filter(k => k.startsWith(`restricao:${t}.`) && [E[k]].flat()[0].startsWith(tipo + '|')).length;
    assert.equal(chaves.filter(k => k.startsWith(`coluna:${t}.`)).length, Number(colunas), t + ' colunas');
    assert.deepEqual([r('c'), r('p'), r('u'), r('f')], [checks, pks, uniques, fks].map(Number), t + ' restrições');
    assert.ok(E['tabela:' + t] && E['gatilhos_internos:' + t], t);
    for (const [, c] of M105.split(`CREATE TABLE public.${t} (`)[1].split('\n);')[0].matchAll(/^ {2}([a-z_]+) (text|uuid|bigint|integer|timestamptz)/gm)) assert.ok(E[`coluna:${t}.${c}`], `${t}.${c}`);
  }
  for (const [, unico, nome, t, corpo] of M105.matchAll(/^CREATE (UNIQUE )?INDEX (\w+) ON public\.(\w+) \(([^)]+)\)/gm)) {
    const d = E[`indice:${t}.${nome}`];
    assert.ok(d, nome); assert.ok(d.includes(`USING btree (${corpo})`), nome); assert.equal(d.startsWith('CREATE UNIQUE'), Boolean(unico), nome);
  }
  assert.equal(chaves.filter(k => k.startsWith('indice:')).length, 11 + 6 + 1, '11 nomeados + 6 PK + 1 UNIQUE');
  const fks = chaves.filter(k => k.startsWith('restricao:') && [E[k]].flat()[0].startsWith('f|'));
  assert.deepEqual(chaves.filter(k => k.startsWith('gatilhos_fk:')).map(k => k.slice('gatilhos_fk:'.length)).sort(), fks.map(k => k.slice('restricao:'.length)).sort());
  for (const [t, nome, ref] of defs.FKS) {
    assert.ok(E[`restricao:${t}.${nome}`].includes(`REFERENCES public.${ref}(`), nome);
    const g = E[`gatilhos_fk:${t}.${nome}`].split(',');
    assert.equal(g.length, 4, nome); assert.ok(g.every(x => x.endsWith(':O')), nome);
    assert.equal(g.filter(x => x.startsWith(`public.${ref}:`)).length + g.filter(x => x.startsWith(`public.${t}:`)).length, 4, nome + ': os dois lados');
  }
  assert.match(E['funcao:mcp_oauth_concessao_revogacao_imutavel()'], /corpo=71cd349698aff45d2d36d5a1355466dbaa1db3d32115b4c9d2779c34ac87a862\|/);
  assert.ok(INT.includes('71cd349698aff45d2d36d5a1355466dbaa1db3d32115b4c9d2779c34ac87a862'), 'mesmo corpo da integridade antiga');
  for (const m of ['10 minutes', '15 minutes', '2 hours', '31 days']) assert.ok(M105.includes(`interval '${m}'`), m);
});

test('comparação: íntegro passa; alternativa do gen_random_uuid aceita; falta, sobra, repetida e ilegível divergem; saída só com chaves', () => {
  assert.deepEqual(defs.compararDefinicoes(linhas()), {integra: true, total: 145, esperado: 145, divergencias: []});
  const pgcrypto = linhas().map(l => (l.chave.endsWith('_tokens.id') || l.chave.endsWith('_concessoes.id') ? {...l, definicao: l.definicao.replace('gen_random_uuid()', 'public.gen_random_uuid()')} : l));
  assert.equal(pgcrypto.filter(l => l.definicao.includes('public.gen_random_uuid()')).length, 2);
  // Qualificado só com o pgcrypto GENUÍNO em public (rodada 1 do Astra, P2-2); sem ele, as duas colunas são INCOERENTES.
  assert.deepEqual(defs.compararDefinicoes(pgcrypto).divergencias, [{chave: 'coluna:mcp_oauth_concessoes.id', tipo: 'INCOERENTE'}, {chave: 'coluna:mcp_oauth_tokens.id', tipo: 'INCOERENTE'}]);
  const comPgcrypto = muda('uuid_publico:gen_random_uuid()', () => defs.UUID_PGCRYPTO);
  assert.equal(defs.compararDefinicoes(comPgcrypto(pgcrypto)).integra, true, 'qualificado + pgcrypto genuíno');
  assert.equal(defs.compararDefinicoes(comPgcrypto(linhas())).integra, true, 'não qualificado (pg_catalog) com pgcrypto instalado depois');
  const homonimo = muda('uuid_publico:gen_random_uuid()', () => UUID_HOMONIMO)(pgcrypto);
  assert.deepEqual(defs.compararDefinicoes(homonimo).divergencias.map(d => d.tipo).sort(), ['DIFERENTE', 'INCOERENTE', 'INCOERENTE']);
  assert.equal(defs.UUID_PGCRYPTO, 'extensao=pgcrypto|linguagem=c|simbolo=pg_random_uuid|biblioteca=$libdir/pgcrypto|retorno=uuid|volatil=v');
  const outra = muda('coluna:mcp_oauth_tokens.id', d => d.replace('gen_random_uuid()', 'outro.gen_random_uuid()'))(linhas());
  assert.deepEqual(defs.compararDefinicoes(outra).divergencias, [{chave: 'coluna:mcp_oauth_tokens.id', tipo: 'DIFERENTE'}]);
  assert.deepEqual(defs.compararDefinicoes(linhas().slice(1)).divergencias, [{chave: linhas()[0].chave, tipo: 'FALTA'}]);
  const extra = [...linhas(), {chave: 'indice:mcp_oauth_tokens.atalho_idx', definicao: 'CREATE INDEX x'}];
  assert.deepEqual(defs.compararDefinicoes(extra).divergencias, [{chave: 'indice:mcp_oauth_tokens.atalho_idx', tipo: 'SOBRA'}]);
  assert.deepEqual(defs.compararDefinicoes([...linhas(), linhas()[3]]).divergencias, [{chave: linhas()[3].chave, tipo: 'REPETIDA'}]);
  assert.equal(defs.compararDefinicoes([...linhas(), {chave: 1}]).divergencias[0].tipo, 'ILEGIVEL');
  assert.equal(defs.compararDefinicoes(undefined).integra, false);
  assert.equal(defs.compararDefinicoes([]).divergencias.length, 145);
  const texto = JSON.stringify(defs.compararDefinicoes(MUTANTES['FK trocada para ON DELETE CASCADE'](linhas())));
  assert.doesNotMatch(texto, /CASCADE|REFERENCES/, 'nenhuma definição lida volta na saída');
});

test('mutantes de schema que preservam nomes e contagens: cada um é DIFERENTE exatamente na chave mutada', () => {
  for (const [nome, f] of Object.entries(MUTANTES)) {
    const m = f(linhas());
    assert.equal(m.length, 145, nome); assert.notDeepEqual(m, linhas(), nome + ': o mutante muda alguma linha');
    const c = defs.compararDefinicoes(m);
    assert.equal(c.integra, false, nome); assert.equal(c.divergencias.length, 1, nome); assert.equal(c.divergencias[0].tipo, 'DIFERENTE', nome);
  }
});

test('alvo fixo de produção: serviço, ambiente, TLS obrigatório, host interno, banco, porta e URL sem query; staging recusado', () => {
  const o = prod.alvo(ENV);
  assert.deepEqual(o.ssl, {rejectUnauthorized: false, minVersion: 'TLSv1.2'}); assert.equal(o.application_name, 'kidmais-migration-105-production');
  assert.deepEqual(prod.alvo({...ENV, DATABASE_SSL_REJECT_UNAUTHORIZED: 'true'}).ssl, {rejectUnauthorized: true, minVersion: 'TLSv1.2'});
  const casos = [[{RENDER: undefined}, /FORA_DO_RENDER/], [{RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}, /SERVICO_RECUSADO/],
    [{KIDMAIS_DEPLOY_ENV: 'staging'}, /AMBIENTE_RECUSADO/], [{DATABASE_SSL: 'false'}, /TLS_OBRIGATORIO/], [{DATABASE_SSL: undefined}, /TLS_OBRIGATORIO/],
    [{DATABASE_URL: 'nada'}, /URL_RECUSADA/], [{DATABASE_URL: URL_PROD.replace('-a:', '-a.oregon-postgres.render.com:')}, /HOST_RECUSADO/],
    [{DATABASE_URL: URL_PROD.replace('/kidmais_production', '/kidmais_staging_1z91')}, /BANCO_RECUSADO/],
    [{DATABASE_URL: URL_PROD.replace(':5432', ':5433')}, /PORTA_RECUSADA/], [{DATABASE_URL: URL_PROD + '?sslmode=disable'}, /CONNECTION_QUERY_REJECTED/]];
  for (const [mudanca, re] of casos) assert.throws(() => prod.alvo({...ENV, ...mudanca}), re, JSON.stringify(mudanca));
  assert.equal(prod.ALVO.servico, 'srv-dak77m2d0e5s73b8rkkg'); assert.equal(prod.DIR, '/opt/render/project/src/data/mcp-105-producao');
});

test('identidade e papel: banco, TLS 1.2/1.3, rede privada, sessão membro do papel, sem superusuário, papel dono da aplicação', () => {
  assert.deepEqual(prod.identidade(ID), {banco: 'kidmais_production', tls: true, tlsVersao: 'TLSv1.3', servidorPrivado: true, papelTrocado: true, papelDono: true});
  assert.equal(prod.identidade({...ID, papel_trocado: false}).papelTrocado, false, 'sem SET role também vale');
  const casos = [[{db: 'kidmais_staging_1z91'}, /BANCO_DIVERGENTE/], [{tls: false}, /SEM_TLS/], [{tls_versao: 'TLSv1.1'}, /TLS_VERSAO_RECUSADA/],
    [{servidor_privado: false}, /SERVIDOR_FORA_DA_REDE_PRIVADA/], [{papel_trocado: null}, /PAPEL_ILEGIVEL/], [{sessao_membro: false}, /SESSAO_FORA_DO_PAPEL/],
    [{papel_superusuario: true}, /SUPERUSUARIO_RECUSADO/], [{sessao_superusuario: true}, /SUPERUSUARIO_RECUSADO/], [{sessao_superusuario: null}, /SUPERUSUARIO_RECUSADO/],
    [{dono_empresas: false}, /PAPEL_NAO_E_DONO_DA_APLICACAO/], [{dono_usuarios: false}, /PAPEL_NAO_E_DONO_DA_APLICACAO/]];
  for (const [mudanca, re] of casos) assert.throws(() => prod.identidade({...ID, ...mudanca}), re, JSON.stringify(mudanca));
  for (const t of ['session_user <> current_user', "pg_has_role(session_user, current_user, 'MEMBER')", 'rolsuper', "to_regclass('public.empresas')",
    "to_regclass('public.usuarios_administrativos')", 'pg_stat_ssl', 'inet_server_addr()']) assert.ok(prod.SQL_IDENTIDADE.includes(t), t);
});

test('disco persistente: montado, diretório e não symlink', () => {
  const st = (dev, extra = {}) => ({dev, isDirectory: () => true, isSymbolicLink: () => false, ...extra});
  assert.doesNotThrow(() => prod.exigirDisco('/d/data', p => (p === '/d/data' ? st(2) : st(1))));
  assert.throws(() => prod.exigirDisco('/d/data', () => st(1)), /DISCO_PERSISTENTE_AUSENTE/);
  assert.throws(() => prod.exigirDisco('/d/data', p => (p === '/d/data' ? st(2, {isSymbolicLink: () => true}) : st(1))), /DISCO_PERSISTENTE_AUSENTE/);
  assert.throws(() => prod.exigirDisco('/d/data', () => { throw new Error('ENOENT'); }), /DISCO_PERSISTENTE_AUSENTE/);
});

test('PITR como gate: formato, horário UTC válido, conferido há ≤ 120 min e não no futuro; argumentos estritos', () => {
  const p = nucleo.lerPitr(BACKUP, AGORA);
  assert.equal(p.referencia, BACKUP); assert.equal(p.conferidoEm, '2026-11-02T03:10:00.000Z'); assert.match(p.gate, /painel do Render/);
  assert.doesNotThrow(() => nucleo.lerPitr('PITR 2026-11-02T01:30Z ok ok', AGORA), '120 min exatos');
  assert.throws(() => nucleo.lerPitr('PITR 2026-11-02T01:29Z ok ok', AGORA), /PITR_CONFERENCIA_ANTIGA/);
  assert.throws(() => nucleo.lerPitr('PITR 2026-11-02T03:36Z ok ok', AGORA), /PITR_CONFERENCIA_NO_FUTURO/);
  for (const ruim of ['backup 2026-11-02', 'PITR 2026-11-02 03:10 ref', 'pitr 2026-11-02T03:10Z ref', 'PITR 2026-11-02T03:10Z ', 'PITR 2026-11-02T03:10Z ref; rm -rf /', '']) {
    assert.throws(() => nucleo.lerPitr(ruim, AGORA), /PITR_REFERENCIA_INVALIDA/, ruim);
  }
  assert.throws(() => nucleo.lerPitr('PITR 2026-13-02T03:10Z ref', AGORA), /PITR_HORARIO_INVALIDO/);
  assert.throws(() => nucleo.lerPitr('PITR 2026-02-30T03:10Z ref', AGORA), /PITR_HORARIO_INVALIDO/);
  assert.deepEqual(nucleo.modo([]), {modo: 'plano'}); assert.deepEqual(nucleo.modo(['--conferir-105']), {modo: 'conferir'});
  assert.equal(nucleo.modo(['--aplicar-105-autorizado', '--backup', BACKUP], AGORA).pitr.conferidoEm, '2026-11-02T03:10:00.000Z');
  assert.throws(() => nucleo.modo(['--aplicar-105-autorizado']), /BACKUP_OBRIGATORIO/);
  assert.throws(() => nucleo.modo(['--conferir-105', '--x']), /ARGUMENTOS_RECUSADOS/);
  assert.throws(() => nucleo.modo(['--aplicar-105-autorizado', '--backup', 'PITR staging 27/10'], AGORA), /PITR_REFERENCIA_INVALIDA/);
});

test('plano: sem conexão, 5 arquivos com hash, ordem PITR → CONFERIR → APLICAR, estados e códigos, nunca o down', async () => {
  const {codigo, saida} = await prod.principal([], {});
  assert.equal(codigo, 0); assert.equal(saida.conecta, false); assert.equal(saida.arquivos.length, 5); assert.equal(saida.definicoesEsperadas, 145);
  assert.deepEqual(saida.estadosDaConferencia, {PRONTA_PARA_APLICAR: 0, JA_APLICADA_INTEGRIDADE_PASS: 0, DIVERGENTE: 3, PARCIAL: 3, FALHA_DE_CONFERENCIA: 3});
  const ordem = saida.ordem.join('\n');
  assert.ok(ordem.indexOf('PITR') < ordem.indexOf('--aplicar-105-autorizado') && ordem.indexOf('--conferir-105') < ordem.indexOf('--aplicar-105-autorizado'));
  assert.match(ordem, /DORMENTE/); assert.match(saida.recuperacao.join(' '), /SÓ ANTES DO PILOTO/); assert.match(saida.recuperacao.join(' '), /PRESERVADAS/);
  assert.ok(saida.nuncaExecuta.includes('down 105'));
  assert.deepEqual(nucleo.CODIGO, {PLANO: 0, PRONTA_PARA_APLICAR: 0, JA_APLICADA_INTEGRIDADE_PASS: 0, APLICADA_POSTCHECK_PASS: 0, FALHA: 2,
    DIVERGENTE: 3, PARCIAL: 3, FALHA_DE_CONFERENCIA: 3, FALHA_MARCADOR_DESATUALIZADO: 5});
});

test('CONFERIR só leitura: PRONTA (precheck), JA_APLICADA (integridade + definições), DIVERGENTE, PARCIAL e FALHA_DE_CONFERENCIA', async () => {
  const casos = [
    [clienteFalso(), 'PRONTA_PARA_APLICAR', 0],
    [clienteFalso({inicial: estado(COMPLETA), inicialDefs: linhas()}), 'JA_APLICADA_INTEGRIDADE_PASS', 0],
    [clienteFalso({inicial: estado(COMPLETA), inicialDefs: linhas(), integra: false}), 'DIVERGENTE', 3],
    [clienteFalso({inicial: estado(COMPLETA), inicialDefs: linhas().slice(2)}), 'DIVERGENTE', 3],
    [clienteFalso({inicial: estado({m105_tabelas: 3})}), 'PARCIAL', 3],
    [clienteFalso({inicial: estado({m105_tabelas: 6, m105_funcao: 1, ler_105: true})}), 'PARCIAL', 3],
    [clienteFalso({id: {...ID, sessao_membro: false}}), 'FALHA_DE_CONFERENCIA', 3],
    [clienteFalso({inicial: estado({pode_criar: false})}), 'FALHA_DE_CONFERENCIA', 3],
    [clienteFalso({inicial: estado({d105: false})}), 'FALHA_DE_CONFERENCIA', 3],
    [clienteFalso({inicial: estado(COMPLETA), inicialDefs: linhas(), falharEm: 'definicao'}), 'FALHA_DE_CONFERENCIA', 3],
    [clienteFalso({falharEm: '105 precheck'}), 'FALHA_DE_CONFERENCIA', 3],
    [clienteFalso({inicialDefs: [{chave: 'uuid_publico:gen_random_uuid()', definicao: UUID_HOMONIMO}]}), 'FALHA_DE_CONFERENCIA', 3],
    [clienteFalso({inicialDefs: [{chave: 'uuid_publico:gen_random_uuid()', definicao: defs.UUID_PGCRYPTO}]}), 'PRONTA_PARA_APLICAR', 0],
    [clienteFalso({inicialDefs: []}), 'FALHA_DE_CONFERENCIA', 3],
    [clienteFalso({falharConnect: erroPg('ECONNREFUSED', 'connect ECONNREFUSED postgresql://u:SENHA@h/db')}), 'FALHA_DE_CONFERENCIA', 3],
  ];
  for (const [C, resultado, codigo] of casos) {
    const r = await prod.principal(['--conferir-105'], ENV, {Client: C});
    assert.equal(r.saida.resultado, resultado, JSON.stringify(r.saida)); assert.equal(r.codigo, codigo);
    assert.deepEqual(escritasNoBanco(C.log), [], resultado + ': nada fora de READ ONLY');
    assert.equal(C.log.filter(x => x.sql === CORPO).length, 0); assert.doesNotMatch(JSON.stringify(r.saida), /SENHA/);
  }
  const C = clienteFalso({inicial: estado(COMPLETA), inicialDefs: MUTANTES['predicado do índice invertido'](linhas())});
  const r = await conferir(C);
  assert.equal(r.resultado, 'DIVERGENTE'); assert.equal(r.checks.integridade, 'PASS', 'a integridade antiga NÃO pega este mutante');
  assert.deepEqual(r.checks.divergencias, [{chave: 'indice:mcp_oauth_concessoes.mcp_oauth_concessoes_ativa_uk', tipo: 'DIFERENTE'}]);
  const ordem = C.log.map(x => x.sql), iDef = ordem.indexOf(DEF);
  assert.deepEqual(ordem.slice(iDef - 2, iDef), [...defs.SET_DEPARSE], 'deparse fixado na mesma transação READ ONLY');
});

test('CONFERIR: cada mutante que preserva nomes e contagens dá DIVERGENTE (código 3) mesmo com a integridade antiga PASS', async () => {
  for (const [nome, f] of Object.entries(MUTANTES)) {
    const r = await prod.principal(['--conferir-105'], ENV, {Client: clienteFalso({inicial: estado(COMPLETA), inicialDefs: f(linhas())})});
    assert.equal(r.saida.resultado, 'DIVERGENTE', nome); assert.equal(r.codigo, 3, nome); assert.equal(r.saida.checks.integridade, 'PASS', nome);
  }
});

test('APLICAR: UMA transação com trava, estado, precheck, DDL, postcheck, integridade, definições e estado completo antes do COMMIT', async () => {
  const dir = tmp(), C = clienteFalso();
  const {codigo, saida} = await prod.principal(['--aplicar-105-autorizado', '--backup', BACKUP], ENV, {Client: C, dir, disco: semDisco, agora: AGORA});
  assert.equal(codigo, 0, JSON.stringify(saida)); assert.equal(saida.resultado, 'APLICADA_POSTCHECK_PASS'); assert.equal(saida.commit, 'CONFIRMADO');
  assert.equal(saida.conferenciaDepois.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.deepEqual(saida.etapas, ['transacao 105']);
  const L = C.log.map(x => x.sql), iBegin = L.indexOf('BEGIN'), iCommit = L.indexOf('COMMIT');
  assert.ok(iBegin >= 0 && iCommit > iBegin); assert.equal(L.filter(s => s === 'BEGIN').length, 1); assert.equal(C.commits(), 1);
  const dentro = L.slice(iBegin, iCommit + 1);
  const pos = s => dentro.indexOf(s);
  assert.ok(dentro.some(s => s.includes('pg_try_advisory_xact_lock(1052029)')));
  const seq = [dentro.findIndex(s => s.includes('pg_try_advisory_xact_lock')), pos(comum.SQL_ESTADO), pos(PRE), pos(CORPO), pos(POS), pos(INT), pos(DEF), dentro.lastIndexOf(comum.SQL_ESTADO), dentro.length - 1];
  assert.deepEqual([...seq].sort((a, b) => a - b), seq, 'ordem dentro da transação: ' + seq);
  assert.ok(seq.every(i => i >= 0));
  assert.ok(!dentro.slice(0, -1).some(s => s === 'COMMIT' || s === 'ROLLBACK' || s.startsWith('BEGIN TRANSACTION')), 'nada fecha a transação antes do COMMIT');
  assert.deepEqual(C.log.slice(0, iBegin).filter(x => !x.ro && !/^(ROLLBACK|BEGIN TRANSACTION READ ONLY|SET LOCAL)/.test(x.sql)), [], 'antes: só leitura');
  const m = marcadorDe(dir);
  assert.equal(m.situacao, 'CONCLUIDA'); assert.equal(m.commit, 'CONFIRMADO'); assert.equal(m.backup, BACKUP); assert.equal(m.pitr.conferidoEm, '2026-11-02T03:10:00.000Z');
  assert.equal(m.etapas[0].antesDoCommit['precheck 105'], 'PASS'); assert.equal(m.etapas[0].antesDoCommit.definicoes, 'PASS');
  assert.ok(!fs.existsSync(path.join(dir, 'migration-105.json.tmp')));
  const deNovo = await prod.principal(['--aplicar-105-autorizado', '--backup', BACKUP], ENV, {Client: C, dir, disco: semDisco, agora: AGORA}).catch(e => e);
  assert.match(String(deNovo.message), /TENTATIVA_ANTERIOR_REVISAR/, 'marcador impede a repetição (recusa antes de conectar)');
  fs.renameSync(path.join(dir, 'migration-105.json'), path.join(dir, 'migration-105.20261102T0331.json'));
  const retomada = await executar(C, {dir});
  assert.equal(retomada.resultado, 'JA_APLICADA_INTEGRIDADE_PASS'); assert.equal(C.commits(), 1, 'sem novo DDL');
  assert.deepEqual(marcadorDe(dir).tentativasAnteriores, ['migration-105.20261102T0331.json']);
});

test('APLICAR recusa antes de qualquer DDL: parcial, privilégio, dependência, papel, aplicação concorrente, estado mudado e completa divergente', async () => {
  const casos = [[{inicial: estado({m105_tabelas: 2})}, /APLICACAO_PARCIAL_105/], [{inicial: estado({referencias_105: false})}, /SEM_PRIVILEGIO_105 REFERENCES/],
    [{inicial: estado({d105: false})}, /DEPENDENCIA_AUSENTE_105/], [{id: {...ID, dono_empresas: false}}, /PAPEL_NAO_E_DONO_DA_APLICACAO/],
    [{trava: false}, /APLICACAO_CONCORRENTE_105/], [{estadoNaTransacao: estado({m105_tabelas: 1})}, /APLICACAO_PARCIAL_105/],
    [{estadoNaTransacao: estado({pode_criar: false})}, /SEM_PRIVILEGIO_105 CREATE/],
    // Outra sessão completou a 105 entre a leitura READ ONLY e a transação: o estado relido sob a trava recusa.
    [{estadoNaTransacao: estado(COMPLETA)}, /ESTADO_MUDOU_105 completa/],
    [{inicial: estado(COMPLETA), inicialDefs: MUTANTES['FK trocada para ON DELETE CASCADE'](linhas())}, /JA_APLICADA_SEM_INTEGRIDADE_105 DIVERGENTE/]];
  for (const [opcoes, re] of casos) {
    const dir = tmp(), C = clienteFalso(opcoes);
    const r = await executar(C, {dir});
    assert.equal(r.resultado, 'FALHA', re.source); assert.match(r.falha.mensagem, re); assert.equal(nucleo.CODIGO[r.resultado], 2);
    assert.equal(C.log.filter(x => x.sql === CORPO).length, 0, re.source + ': DDL nunca enviado'); assert.equal(C.commits(), 0);
    assert.ok(['NAO_COMMITADA', 'SEM_TRANSACAO'].includes(r.commit), r.commit); assert.equal(marcadorDe(dir).situacao, 'FALHA');
    assert.deepEqual(C.atual.defs, opcoes.inicialDefs ?? UUID_AUSENTE);
  }
});

test('APLICAR: mutante na transação (deparse divergente) → ROLLBACK antes do COMMIT, NAO_COMMITADA, nada confirmado', async () => {
  for (const [nome, f] of Object.entries(MUTANTES)) {
    const dir = tmp(), C = clienteFalso({aplicadas: f(linhas())});
    const r = await executar(C, {dir});
    assert.equal(r.resultado, 'FALHA', nome); assert.equal(r.commit, 'NAO_COMMITADA', nome); assert.match(r.falha.mensagem, /INTEGRIDADE_105_ANTES_DO_COMMIT/, nome);
    assert.equal(C.commits(), 0, nome); assert.equal(C.atual.estado.m105_tabelas, 0, nome);
    assert.ok(C.log.some(x => x.sql === 'ROLLBACK' && !x.ro), nome);
    assert.equal(marcadorDe(dir).etapas[0].antesDoCommit.definicoes, 'FALHOU', nome);
  }
  for (const [opcoes, re] of [[{integraNaTransacao: false}, /INTEGRIDADE_105_ANTES_DO_COMMIT/], [{falharEm: '105 postcheck'}, /falha simulada/],
    [{falharEm: 'CREATE TABLE public.mcp_oauth_tokens', erro: erroPg('55P03', 'lock timeout')}, /lock timeout/]]) {
    const C = clienteFalso(opcoes), r = await executar(C);
    assert.equal(r.commit, 'NAO_COMMITADA'); assert.match(r.falha.mensagem, re); assert.equal(C.commits(), 0);
  }
});

test('conferência depois do COMMIT que não passa: FALHA (2) com o COMMIT CONFIRMADO, nunca APLICADA_POSTCHECK_PASS', async () => {
  // As contagens só são lidas na conferência depois do COMMIT (105 completa); a falha delas vira FALHA_DE_CONFERENCIA.
  const dir = tmp(), C = clienteFalso({falharEm: 'AS concessoes_ativas'});
  const r = await executar(C, {dir});
  assert.equal(r.resultado, 'FALHA'); assert.equal(r.commit, 'CONFIRMADO'); assert.match(r.falha.mensagem, /CONFERENCIA_DEPOIS_DO_COMMIT_105 FALHA_DE_CONFERENCIA/);
  assert.equal(C.commits(), 1); assert.equal(marcadorDe(dir).commit, 'CONFIRMADO');
  assert.equal((await executar(clienteFalso())).resultado, 'APLICADA_POSTCHECK_PASS', 'controle sem a falha');
});

test('falha NO COMMIT: 40003, 08xxx, 57xxx e sem SQLSTATE = INDETERMINADO; SQLSTATE do servidor = DESFEITA; COMMIT→ROLLBACK = DESFEITA; nunca repete', async () => {
  for (const [erro, esperado] of [[erroPg('40003'), 'INDETERMINADO'], [erroPg('08006'), 'INDETERMINADO'], [erroPg('57P01'), 'INDETERMINADO'],
    [erroPg('XX000'), 'INDETERMINADO'], [erroPg(undefined, 'Connection terminated'), 'INDETERMINADO'], [erroPg('40001'), 'DESFEITA_PELO_SERVIDOR'],
    [erroPg('23514'), 'DESFEITA_PELO_SERVIDOR']]) {
    const dir = tmp(), C = clienteFalso({falharCommit: {erro}});
    const r = await executar(C, {dir});
    assert.equal(r.resultado, 'FALHA'); assert.equal(r.commit, esperado, String(erro.code)); assert.equal(C.commits(), 1, 'um COMMIT só');
    assert.match(r.reconciliar, /--conferir-105/); assert.equal(marcadorDe(dir).commit, esperado);
  }
  const r = await executar(clienteFalso({falharCommit: {rollback: true}}));
  assert.equal(r.commit, 'DESFEITA_PELO_SERVIDOR'); assert.match(r.falha.mensagem, /COMMIT_RESPONDIDO_COMO_ROLLBACK_105/);
  const efetivou = clienteFalso({falharCommit: {erro: erroPg('08006'), efetivou: true}});
  const x = await executar(efetivou);
  assert.equal(x.commit, 'INDETERMINADO'); assert.equal(efetivou.atual.estado.m105_tabelas, 6, 'o servidor pode ter confirmado: daí a reconciliação');
  assert.equal((await conferir(efetivou)).resultado, 'JA_APLICADA_INTEGRIDADE_PASS', 'a conferência reconcilia');
});

/** Gravador que lança ENOSPC quando `quando(obj, n)` diz (obj = JSON gravado; n = ordem da gravação). */
function discoCheio(quando, {persistente = true} = {}) {
  let n = 0, falhou = false;
  const escrever = (arquivo, dados, opcoes) => {
    n++;
    const obj = JSON.parse(dados);
    if ((persistente && falhou) || quando(obj, n)) { falhou = true; throw Object.assign(new Error('ENOSPC: no space left on device, write'), {code: 'ENOSPC'}); }
    return fs.writeFileSync(arquivo, dados, opcoes);
  };
  return escrever;
}
const commitNoObj = o => o.etapas?.[0]?.commit;

test('ENOSPC antes de conectar (marcador inicial): recusa código 1, sem conexão', async () => {
  const C = clienteFalso();
  await assert.rejects(prod.principal(['--aplicar-105-autorizado', '--backup', BACKUP], ENV,
    {Client: C, dir: tmp(), disco: semDisco, agora: AGORA, escrever: discoCheio((o, n) => n === 1)}), /ENOSPC/);
  assert.equal(C.log.length, 0);
});

test('ENOSPC antes do COMMIT (registro pré-COMMIT): ROLLBACK, COMMIT nunca enviado, código 5 com NAO_COMMITADA', async () => {
  const dir = tmp(), C = clienteFalso();
  const r = await prod.principal(['--aplicar-105-autorizado', '--backup', BACKUP], ENV,
    {Client: C, dir, disco: semDisco, agora: AGORA, escrever: discoCheio(o => o.etapas?.[0]?.antesDoCommit?.definicoes === 'PASS')});
  assert.equal(r.codigo, 5); assert.equal(r.saida.resultado, 'FALHA_MARCADOR_DESATUALIZADO'); assert.equal(r.saida.commit, 'NAO_COMMITADA');
  assert.equal(C.commits(), 0); assert.equal(C.atual.estado.m105_tabelas, 0); assert.match(r.saida.erroMarcador, /ENOSPC/);
  assert.match(r.saida.aviso, /único registro do COMMIT/); assert.equal(marcadorDe(dir).situacao, 'EM_ANDAMENTO', 'último registro íntegro preservado');
});

test('ENOSPC logo depois do COMMIT (persistente): código 5 (nunca 1), COMMIT CONFIRMADO vindo da memória, marcador antigo íntegro', async () => {
  const dir = tmp(), C = clienteFalso();
  const r = await prod.principal(['--aplicar-105-autorizado', '--backup', BACKUP], ENV,
    {Client: C, dir, disco: semDisco, agora: AGORA, escrever: discoCheio(o => commitNoObj(o) === 'CONFIRMADO')});
  assert.equal(r.codigo, 5); assert.equal(r.saida.commit, 'CONFIRMADO'); assert.equal(r.saida.marcadorAtualizado, false);
  assert.equal(C.atual.estado.m105_tabelas, 6); assert.equal(C.commits(), 1);
  const m = marcadorDe(dir);
  assert.equal(m.situacao, 'EM_ANDAMENTO'); assert.equal(commitNoObj(m), undefined, 'o disco ficou no registro pré-COMMIT');
  await assert.rejects(executar(C, {dir}), /TENTATIVA_ANTERIOR_REVISAR/, 'o marcador antigo impede a repetição');
  assert.equal((await conferir(C)).resultado, 'JA_APLICADA_INTEGRIDADE_PASS');
});

test('ENOSPC na gravação CONCLUIDA (persistente): código 5 com CONFIRMADO; transitório só nela: código 2 com o marcador em FALHA/CONFIRMADO', async () => {
  const d1 = tmp(), C1 = clienteFalso();
  const r1 = await executar(C1, {dir: d1, escrever: discoCheio(o => o.situacao === 'CONCLUIDA')});
  assert.equal(r1.resultado, 'FALHA_MARCADOR_DESATUALIZADO'); assert.equal(r1.commit, 'CONFIRMADO'); assert.equal(nucleo.CODIGO[r1.resultado], 5);
  assert.equal(marcadorDe(d1).resultado, 'APLICADA_POSTCHECK_PASS', 'o último registro EM_ANDAMENTO já tinha o resultado');
  const d2 = tmp();
  const r2 = await executar(clienteFalso(), {dir: d2, escrever: discoCheio(o => o.situacao === 'CONCLUIDA', {persistente: false})});
  assert.equal(r2.resultado, 'FALHA'); assert.equal(r2.commit, 'CONFIRMADO'); assert.equal(r2.marcadorAtualizado, true);
  assert.equal(marcadorDe(d2).situacao, 'FALHA'); assert.equal(marcadorDe(d2).commit, 'CONFIRMADO');
});

test('ENOSPC durante a conferência pós-COMMIT e depois de COMMIT INDETERMINADO (40003/08006): código 5 com o estado certo', async () => {
  const r1 = await executar(clienteFalso(), {escrever: discoCheio(o => Boolean(o.conferenciaDepois))});
  assert.equal(r1.resultado, 'FALHA_MARCADOR_DESATUALIZADO'); assert.equal(r1.commit, 'CONFIRMADO');
  for (const code of ['40003', '08006']) {
    const r = await executar(clienteFalso({falharCommit: {erro: erroPg(code)}}), {escrever: discoCheio(o => commitNoObj(o) === 'INDETERMINADO')});
    assert.equal(r.resultado, 'FALHA_MARCADOR_DESATUALIZADO', code); assert.equal(r.commit, 'INDETERMINADO', code); assert.match(r.reconciliar, /--conferir-105/);
  }
});

test('gravação atômica: falha no .tmp nunca trunca o marcador; nenhum .tmp é tomado por tentativa anterior', async () => {
  const dir = tmp();
  let n = 0;
  const escrever = (arquivo, dados, opcoes) => {
    n++;
    if (n >= 3) { fs.writeFileSync(arquivo, dados.slice(0, 10), opcoes); throw Object.assign(new Error('ENOSPC'), {code: 'ENOSPC'}); }
    return fs.writeFileSync(arquivo, dados, opcoes);
  };
  const r = await executar(clienteFalso(), {dir, escrever});
  assert.equal(r.resultado, 'FALHA_MARCADOR_DESATUALIZADO');
  assert.doesNotThrow(() => marcadorDe(dir), 'o marcador continua JSON íntegro');
  fs.renameSync(path.join(dir, 'migration-105.json'), path.join(dir, 'migration-105.antes.json'));
  const r2 = await executar(clienteFalso(), {dir});
  assert.deepEqual(marcadorDe(dir).tentativasAnteriores, ['migration-105.antes.json']); assert.equal(r2.resultado, 'APLICADA_POSTCHECK_PASS');
});

test('CLI real: fora do Render recusa com código 1; nenhuma saída traz URL ou senha', () => {
  const {spawnSync} = require('node:child_process');
  const env = {...process.env};
  for (const k of ['RENDER', 'RENDER_SERVICE_ID', 'DATABASE_URL', 'KIDMAIS_DEPLOY_ENV']) delete env[k];
  const pitrAgora = `PITR ${new Date().toISOString().slice(0, 16)}Z painel Render`;
  for (const args of [['--conferir-105'], ['--aplicar-105-autorizado', '--backup', pitrAgora]]) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'migration-105-production.cjs'), ...args], {encoding: 'utf8', env});
    assert.equal(r.status, 1); assert.match(r.stderr, /^RECUSADO FORA_DO_RENDER/);
  }
  const r = spawnSync(process.execPath, [path.join(__dirname, 'migration-105-production.cjs'), '--conferir-105'],
    {encoding: 'utf8', env: {...env, ...ENV, RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg'}});
  assert.equal(r.status, 1); assert.match(r.stderr, /SERVICO_RECUSADO/); assert.doesNotMatch(r.stderr + r.stdout, /SENHA_FALSA|postgresql:\/\//);
});
