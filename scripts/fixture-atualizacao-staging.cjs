/* eslint-disable @typescript-eslint/no-require-imports */
// Atualização de staging (11/10/2026, docs/ATUALIZACAO_STAGING_20261011.md): fixtures dedicadas para /b/<código>.
// Executar SOMENTE no Web Shell do srv-daif418ae00c73e8k2gg, com aprovação explícita, uma flag por vez:
//   --criar-fixtures-autorizado     cria DUAS empresas de homologação ATIVAS e isentas (acesso COMPLETO), cada uma com Pocket
//                                   (preço, dias/períodos e catálogo do buffet próprios); confere as demais empresas antes/depois.
//   --encerrar-fixtures-autorizado  desativa as fixtures (empresa, vínculo, usuário) — só as comprovadamente criadas aqui.
// Nunca apaga linha; nunca toca outra empresa. As fixtures ficam ATIVAS entre os dois modos (testes de navegador e OTP).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createHash, randomBytes, randomUUID} = require('node:crypto');
const {alvo: alvoEnsaio, documento} = require('./assinatura-staging-ensaio.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco} = require('./conexao-staging.cjs');
const {PRESERVADAS: PRESERVADAS_PLANOS, sqlPreservacao} = require('./homologacao-planos-cotacao-staging.cjs');

const BASE = 'https://kidmais-manager-staging.onrender.com';
const DIR = '/opt/render/project/src/data/atualizacao-staging-20261011';
const ARQUIVO = 'fixtures.json';
const FLAG_CRIAR = '--criar-fixtures-autorizado';
const FLAG_ENCERRAR = '--encerrar-fixtures-autorizado';
const RODADA = 'atualizacao-staging-20261011-fixtures';
const KIDMAIS_CNPJ = '20119900000160';
/**
 * A vende o Pocket todos os dias; B só em dias úteis (prova a disponibilidade por empresa na tela). A MESMA categoria
 * SALGADOS nas duas, com itens diferentes (catálogo por empresa, 078). Preços diferentes (isolamento visível).
 */
const FIXTURES = Object.freeze([
    {chave:'A', empresa:'b788360d-c46c-45d1-9b57-fd06a6cab786', usuario:'b2ceef18-f574-4702-ad1e-5efe68e31be2', codigo:'hml-atualizacao-a',
        valor:'1500.00', dias:[1, 2, 3, 4, 5, 6, 7],
        composicao:[['SALGADOS', 'Salgados', 2, ['Coxinha homologação A', 'Kibe homologação A', 'Esfiha homologação A']], ['DOCES', 'Doces', 1, ['Brigadeiro homologação A', 'Beijinho homologação A']]]},
    {chave:'B', empresa:'0656ce48-c803-4917-8808-5ffbe47667a1', usuario:'f34aad11-1451-46f8-8702-8dcc6d8d7e47', codigo:'hml-atualizacao-b',
        valor:'2300.00', dias:[1, 2, 3, 4, 5],
        composicao:[['SALGADOS', 'Salgados', 1, ['Empada homologação B', 'Pastel homologação B']], ['MASSA_BOLO', 'Massa do bolo', 1, ['Massa branca homologação B', 'Massa de chocolate homologação B']]]},
].map(f => Object.freeze({...f, email:`hml-atualizacao-${f.usuario.slice(0, 8)}@example.invalid`,
    nome:`TESTE Kidmais — atualização staging 20261011 ${f.chave}`})));
const FAIXA = Object.freeze({min:20, max:30});
const IDS = FIXTURES.map(f => f.empresa);
/** Mesmas tabelas da rodada de planos + catálogo do buffet (078: empresa_id), sempre SEM as fixtures. */
const PRESERVADAS = Object.freeze([...PRESERVADAS_PLANOS, ['buffet_categorias', 'empresa_id', []], ['buffet_itens', 'empresa_id', []]]);

function modo(argv) {
    const flags = argv.filter(a => a.startsWith('--'));
    if (flags.length !== 1) return null;
    return flags[0] === FLAG_CRIAR ? 'CRIAR' : flags[0] === FLAG_ENCERRAR ? 'ENCERRAR' : null;
}
/** Trava do staging (serviço, banco, porta, TLS) do ensaio de 09/10, sem exigir as chaves da rodada. */
function alvo(env) {
    return alvoEnsaio({...env, ASSINATURA_PLANOS_ATIVOS:'true'});
}
/** Prova de autoria: S1 comprovou que IDs, códigos e e-mails estavam livres E a rodada registrou a intenção antes de criar. */
function comprovadas(r) {
    return r?.rodada === RODADA && r?.precheck?.livres === true && r?.intencao === true;
}
function hash(valor) {
    return createHash('sha256').update(JSON.stringify(valor ?? null)).digest('hex');
}

/** Desativa só o que foi comprovadamente criado aqui; cada UPDATE confere ID + marcador (código, nome, e-mail). */
async function desativar(db, r) {
    if (!comprovadas(r)) return 'NADA_CRIADO_PELA_RODADA';
    await db.query('BEGIN');
    try {
        await db.query('UPDATE usuarios_administrativos SET ativo=false WHERE id=ANY($1::uuid[]) AND email=ANY($2::text[])', [FIXTURES.map(f => f.usuario), FIXTURES.map(f => f.email)]);
        await db.query("UPDATE memberships SET status='REVOGADA' WHERE empresa_id=ANY($1::uuid[]) AND usuario_id=ANY($2::uuid[]) AND status<>'REVOGADA'", [IDS, FIXTURES.map(f => f.usuario)]);
        await db.query("UPDATE empresas SET status='DESATIVADA' WHERE id=ANY($1::uuid[]) AND codigo=ANY($2::text[]) AND nome=ANY($3::text[]) AND status<>'DESATIVADA'", [IDS, FIXTURES.map(f => f.codigo), FIXTURES.map(f => f.nome)]);
        await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
    return 'DESATIVADAS';
}

async function publico(caminho, fetcher = fetch) {
    assert.ok(caminho.startsWith('/api/fechamentos/'));
    const res = await fetcher(BASE + caminho, {redirect:'manual', signal:AbortSignal.timeout(60000)});
    let j = null; try { j = await res.json(); } catch { /* não JSON */ }
    return {status:res.status, j};
}

async function criar({env, Client, servicos, dir = DIR, disco = exigirDisco, fetcher = fetch}) {
    const opts = alvo(env);
    disco();
    fs.mkdirSync(dir, {recursive:true, mode:0o700});
    const arquivo = dir + '/' + ARQUIVO;
    assert.ok(!fs.existsSync(arquivo), 'RODADA_EXISTENTE');
    const r = {rodada:RODADA, inicio:new Date().toISOString(), pid:process.pid, etapas:[]};
    fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600, flag:'wx'});
    const salvar = () => fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600});
    const db = new Client(opts); let conectado = false, erro = null;
    const tx = {query: async (t, v) => { const x = await db.query(t, v); return {rows:x.rows, rowCount:x.rowCount}; }};
    const emTransacao = async (fn) => { await db.query('BEGIN'); try { const v = await fn(); await db.query('COMMIT'); return v; } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; } };
    const marcar = e => { r.etapas.push(e); salvar(); };
    try {
        await db.connect(); conectado = true; await db.query("SET statement_timeout='15s'");
        r.conexao = conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0], env); salvar();
        // S1: schema esperado (062, 074a, 077, 078) e fixtures livres.
        const schema = (await db.query(`SELECT to_regclass('public.assinatura_isencoes') IS NOT NULL
              AND to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NOT NULL
              AND to_regclass('public.empresa_regras_pagamento') IS NOT NULL
              AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='buffet_categorias' AND column_name='empresa_id') AS ok`)).rows[0];
        assert.equal(schema.ok, true, 'SCHEMA_S1');
        const ocupado = (await db.query(`SELECT EXISTS(SELECT 1 FROM empresas WHERE id=ANY($1::uuid[]) OR codigo=ANY($2::text[]))
            OR EXISTS(SELECT 1 FROM usuarios_administrativos WHERE id=ANY($3::uuid[]) OR email=ANY($4::text[])) AS ocupado`,
            [IDS, FIXTURES.map(f => f.codigo), FIXTURES.map(f => f.usuario), FIXTURES.map(f => f.email)])).rows[0];
        assert.equal(ocupado.ocupado, false, 'FIXTURE_PREEXISTENTE_S1');
        r.precheck = {livres:true}; salvar();
        const preservacao = async () => Object.fromEntries(await Promise.all(PRESERVADAS.map(async ([t, c, v]) =>
            [t, hash((await db.query(sqlPreservacao(t, c, v), [IDS])).rows.map(x => x.linha))])));
        r.antes = await preservacao(); salvar();

        // Empresas, usuário (senha aleatória só em memória, descartada), vínculo, isenção: uma transação.
        marcar('FIXTURES'); r.intencao = true; salvar();
        await emTransacao(async () => {
            for (const f of FIXTURES) {
                const doc = documento(); assert.notEqual(doc, KIDMAIS_CNPJ);
                await db.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,$3,'PROVISIONAMENTO')", [f.empresa, f.codigo, f.nome]);
                await db.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [f.empresa]);
                await db.query("INSERT INTO usuarios_administrativos(id,email,nome,senha_hash,papel,ativo) VALUES($1,$2,'Gestão Sintética Homologação',$3,'REPRESENTANTE_AUTORIZADO',true)",
                    [f.usuario, f.email, await servicos.criarHashSenha('Sintetica-' + randomBytes(24).toString('hex'))]);
                await db.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())", [f.empresa, f.usuario]);
                await db.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2", [f.empresa, f.usuario]);
                await db.query("INSERT INTO financeiro_categorias(empresa_id,tipo,nome) VALUES($1,'DESPESA','Homologação')", [f.empresa]);
                await db.query("INSERT INTO assinatura_isencoes(empresa_id,documento_verificado,motivo,concedida_por) VALUES($1,$2,'Homologação sintética staging 20261011',$3)", [f.empresa, doc, f.usuario]);
            }
        });
        r.fixtures = true; salvar();

        // Pocket, preço, dias/períodos e catálogo próprio, pelos serviços de domínio (mesmo caminho da tela).
        marcar('CATALOGO');
        const horarios = (await db.query('SELECT id::text AS id FROM configuracao_agenda WHERE ativo')).rows.map(x => x.id);
        assert.ok(horarios.length > 0, 'AGENDA_SEM_HORARIOS');
        r.pacotes = {};
        for (const f of FIXTURES) {
            const ctx = () => ({empresaId:f.empresa, usuarioId:f.usuario, requestId:randomUUID(), motivo:'PACOTE_EDITADO'});
            const pacote = (await db.query(`INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
                VALUES ($1, 'POCKET', 'Pocket homologação', 1, true, true, $2, $3) RETURNING id::text AS id`, [f.empresa, FAIXA.min, FAIXA.max])).rows[0].id;
            r.pacotes[f.chave] = pacote; salvar();
            await emTransacao(() => servicos.gravarFaixasPacote(tx, f.empresa, pacote, [{convidadosMin:FAIXA.min, convidadosMax:FAIXA.max, valor:f.valor}], {minimo:FAIXA.min, maximo:FAIXA.max}, ctx()));
            await emTransacao(() => servicos.definirDisponibilidadePacoteAdmin(tx, pacote, {disponibilidade:f.dias.flatMap(dia => horarios.map(horarioId => ({dia, horarioId})))}, ctx()));
            const categorias = [];
            for (const [codigo, nome, escolhas, itens] of f.composicao) {
                const categoriaId = await emTransacao(() => servicos.criarCategoriaBuffet(tx, f.empresa, nome, true, codigo));
                for (const item of itens) await emTransacao(() => servicos.criarItemBuffet(tx, f.empresa, item, categoriaId));
                categorias.push({categoriaId, escolhas});
            }
            await emTransacao(() => servicos.definirCategoriasPacoteAdmin(tx, pacote, categorias, ctx()));
        }
        r.catalogo = true; salvar();

        // Conferências: demais empresas intactas; endereço público (se a chave estiver ligada) com o Pocket de cada uma.
        marcar('CONFERENCIA');
        r.depois = await preservacao();
        for (const [t] of PRESERVADAS) assert.equal(r.depois[t], r.antes[t], 'PRESERVACAO_' + t);
        r.publico = {};
        if (env.COTACAO_PUBLICA_POR_EMPRESA === 'true') {
            for (const f of FIXTURES) {
                const p = await publico('/api/fechamentos/pacotes?empresa=' + f.codigo, fetcher);
                assert.equal(p.status, 200, 'PUBLICO_' + f.chave);
                assert.deepEqual(p.j.pacotes.map(x => x.codigo), ['POCKET'], 'PACOTES_' + f.chave);
                const dias = [...new Set((p.j.pacotes[0].disponibilidade ?? []).map(x => x.dia))].sort();
                assert.deepEqual(dias, f.dias, 'DIAS_' + f.chave);
                const c = await publico('/api/fechamentos/catalogo?pacote=POCKET&empresa=' + f.codigo, fetcher);
                assert.equal(c.status, 200, 'CATALOGO_' + f.chave);
                const itens = (c.j.categorias ?? []).flatMap(x => (x.itens ?? []).map(i => i.nome)).sort();
                assert.deepEqual(itens, f.composicao.flatMap(([, , , l]) => l).sort(), 'ITENS_' + f.chave);
                r.publico[f.chave] = {pacotes:['POCKET'], dias, categorias:(c.j.categorias ?? []).map(x => x.codigo).sort(), itens:itens.length, preco:p.j.pacotes[0].precoMinimo};
            }
        } else r.publico = 'CHAVE_COTACAO_DESLIGADA';
        r.aprovado = true; salvar();
    } catch (e) {
        erro = e;
        r.falha = {etapa:r.etapas.at(-1) ?? 'S1', mensagem:String(e?.message ?? e).slice(0, 160)}; salvar();
        // Falha depois da intenção: desativa o que foi criado (nunca deixa fixture parcial ativa).
        if (conectado) { try { r.encerramento = await desativar(db, r); } catch (e2) { r.encerramentoFalhou = String(e2?.message).slice(0, 120); } salvar(); }
    } finally {
        await db.end().catch(() => {});
    }
    r.concluido = !erro; salvar();
    return {resultado:erro ? 'FALHA' : 'PASS', falha:r.falha ?? null, conexao:r.conexao ?? null, fixtures:FIXTURES.map(f => f.codigo),
        publico:r.publico ?? null, preservacao:r.depois ? 'IGUAL' : null, encerramento:r.encerramento ?? null};
}

async function encerrar({env, Client, dir = DIR, disco = exigirDisco}) {
    const opts = alvo(env);
    disco();
    const arquivo = dir + '/' + ARQUIVO;
    assert.ok(fs.existsSync(arquivo), 'SEM_FIXTURES_PARA_ENCERRAR');
    const r = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    assert.equal(r.rodada, RODADA, 'ESTADO_DE_OUTRA_RODADA');
    const salvar = () => fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600});
    const db = new Client(opts);
    try {
        await db.connect(); await db.query("SET statement_timeout='15s'");
        conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0], env);
        r.encerramento = await desativar(db, r);
        r.encerradoEm = new Date().toISOString(); salvar();
        const estado = (await db.query('SELECT codigo, status FROM empresas WHERE id=ANY($1::uuid[]) ORDER BY codigo', [IDS])).rows;
        return {resultado:'ENCERRADO', encerramento:r.encerramento, empresas:estado};
    } finally { await db.end().catch(() => {}); }
}

if (require.main === module) {
    const m = modo(process.argv.slice(2));
    const {Client} = require('pg');
    if (m === 'CRIAR') {
        (async () => {
            const servicos = {
                ...(await import('../lib/autenticacao/senha.ts')), ...(await import('../lib/comercial/pacote-precos.ts')),
                ...(await import('../lib/comercial/pacotes-admin.ts')), ...(await import('../lib/comercial/catalogo-buffet.ts')),
            };
            const s = await criar({env:process.env, Client, servicos});
            (s.resultado === 'PASS' ? console.log : console.error)(JSON.stringify(s)); if (s.resultado !== 'PASS') process.exitCode = 2;
        })().catch(e => { console.error(String(e?.message ?? 'RECUSADO').slice(0, 120)); process.exitCode = 1; });
    } else if (m === 'ENCERRAR') {
        encerrar({env:process.env, Client}).then(s => console.log(JSON.stringify(s)))
            .catch(e => { console.error(String(e?.message ?? 'RECUSADO').slice(0, 120)); process.exitCode = 1; });
    } else { console.error('AGUARDANDO_AUTORIZACAO_FIXTURES'); process.exitCode = 1; }
}
module.exports = {FIXTURES, PRESERVADAS, FLAG_CRIAR, FLAG_ENCERRAR, RODADA, ARQUIVO, modo, alvo, comprovadas, desativar, criar, encerrar};
