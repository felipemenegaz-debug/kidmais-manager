/* eslint-disable @typescript-eslint/no-require-imports */
// Homologação do painel do desenvolvedor em staging (11/10/2026, pacote PACOTE-AUTORIZACAO-FINAL-PAINEL-4b8ce38, opção D-B):
// fixtures sintéticas mínimas. Executar SOMENTE no Web Shell do srv-daif418ae00c73e8k2gg, com aprovação explícita, uma flag por vez:
//   --diagnosticar                          leitura (transação READ ONLY): fixtures reutilizáveis e se as desta rodada estão livres.
//   --criar-fixtures-painel-autorizado      cria 2 contas, 3 empresas ATIVAS e isentas e 4 vínculos de Gestão. As senhas são
//                                           DIGITADAS por quem executa (terminal sem eco); nada de senha fixa, nada impresso.
//   --encerrar-fixtures-painel-autorizado   desativa só o que foi comprovadamente criado aqui. Nada é apagado.
//   --conferir-encerramento                 leitura: confere que o encerramento foi completo.
// Nunca toca outra empresa, conta ou vínculo; nunca cria Perfil, concessão, cobrança, assinatura ou contato com o Asaas.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {alvo: alvoEnsaio, documento} = require('./assinatura-staging-ensaio.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco} = require('./conexao-staging.cjs');

const DIR = '/opt/render/project/src/data/painel-staging-20261011';
const ARQUIVO = 'fixtures.json';
const RODADA = 'painel-staging-20261011-fixtures';
const FLAGS = Object.freeze({
    '--diagnosticar': 'DIAGNOSTICAR',
    '--criar-fixtures-painel-autorizado': 'CRIAR',
    '--encerrar-fixtures-painel-autorizado': 'ENCERRAR',
    '--conferir-encerramento': 'CONFERIR',
});
const KIDMAIS_CNPJ = '20119900000160';
const MOTIVO_ENCERRAMENTO = 'Encerramento das fixtures do painel (staging 20261011)';
const PAPEL_GLOBAL_NEUTRO = 'ADMINISTRATIVO';

/** Duas empresas para a troca de empresa (E1, E2) e uma para o Perfil (P, onde A e B são Gestão). */
const EMPRESAS = Object.freeze([
    {chave:'E1', id:'88dc9354-a79b-4b6f-acfe-194cfec4e6d9', codigo:'hml-painel-e1'},
    {chave:'E2', id:'96aa7146-b85f-4416-be93-5bf287f5fddf', codigo:'hml-painel-e2'},
    {chave:'P', id:'3706aab8-58b3-4e02-98b9-aec13f17d80a', codigo:'hml-painel-p'},
].map(e => Object.freeze({...e, nome:`TESTE Kidmais — painel staging 20261011 ${e.chave}`})));
const CONTAS = Object.freeze([
    {chave:'A', id:'291c4d76-c3b9-4888-87cd-3d0cc004219f'},
    {chave:'B', id:'e34946b5-b0e4-4b7b-b801-efc640ac05f8'},
].map(c => Object.freeze({...c, email:`hml-painel-${c.chave.toLowerCase()}-${c.id.slice(0, 8)}@example.invalid`, nome:`Gestão Sintética Painel ${c.chave}`})));
/** A: Gestão em E1, E2 e P. B: Gestão em P. */
const VINCULOS = Object.freeze([['A', 'E1'], ['A', 'E2'], ['A', 'P'], ['B', 'P']]);
const IDS_EMPRESAS = EMPRESAS.map(e => e.id);
const IDS_CONTAS = CONTAS.map(c => c.id);
const empresa = chave => EMPRESAS.find(e => e.chave === chave);
const conta = chave => CONTAS.find(c => c.chave === chave);

function modo(argv) {
    const flags = argv.filter(a => a.startsWith('--'));
    return flags.length === 1 ? (FLAGS[flags[0]] ?? null) : null;
}
/** Trava do staging (serviço, ambiente, banco, porta, TLS) dos executores de 09–11/10; não exige as chaves de planos. */
function alvo(env) {
    return alvoEnsaio({...env, ASSINATURA_PLANOS_ATIVOS:'true'});
}
/** Prova de autoria: o precheck comprovou ids, códigos e e-mails livres E a intenção foi registrada antes de escrever. */
function comprovadas(r) {
    return r?.rodada === RODADA && r?.precheck?.livres === true && r?.intencao === true;
}

const SQL_OCUPADO = `SELECT EXISTS(SELECT 1 FROM empresas WHERE id=ANY($1::uuid[]) OR codigo=ANY($2::text[]))
    OR EXISTS(SELECT 1 FROM usuarios_administrativos WHERE id=ANY($3::uuid[]) OR lower(email)=ANY($4::text[])) AS ocupado`;
const paramsOcupado = () => [IDS_EMPRESAS, EMPRESAS.map(e => e.codigo), IDS_CONTAS, CONTAS.map(c => c.email.toLowerCase())];
/** Impressão das OUTRAS linhas (fora das fixtures): igual antes e depois da criação. */
const SQL_PRESERVACAO = `SELECT
    (SELECT md5(coalesce(string_agg(id::text || ':' || status, ',' ORDER BY id), '')) FROM empresas WHERE NOT (id = ANY($1::uuid[]))) AS empresas,
    (SELECT md5(coalesce(string_agg(id::text || ':' || status || ':' || coalesce(papel, ''), ',' ORDER BY id), '')) FROM memberships WHERE NOT (empresa_id = ANY($1::uuid[]))) AS memberships,
    (SELECT md5(coalesce(string_agg(id::text || ':' || ativo::text || ':' || papel, ',' ORDER BY id), '')) FROM usuarios_administrativos WHERE NOT (id = ANY($2::uuid[]))) AS usuarios`;

async function conectar(Client, env) {
    const db = new Client(alvo(env));
    await db.connect();
    try {
        await db.query("SET statement_timeout='15s'");
        return {db, conexao:conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0], env)};
    } catch (e) { await db.end().catch(() => {}); throw e; }
}
async function leitura(db, fn) {
    await db.query('BEGIN READ ONLY');
    try { return await fn(); } finally { await db.query('ROLLBACK').catch(() => {}); }
}

/** Diagnóstico somente leitura: há fixtures sintéticas reutilizáveis? As desta rodada estão livres? Nenhum e-mail impresso. */
async function diagnosticar({env, Client}) {
    const {db, conexao} = await conectar(Client, env);
    try {
        return await leitura(db, async () => {
            const ocupado = (await db.query(SQL_OCUPADO, paramsOcupado())).rows[0].ocupado;
            const hml = (await db.query(`SELECT e.codigo,
                    count(m.id) FILTER (WHERE m.status='ATIVA' AND m.papel='REPRESENTANTE_AUTORIZADO')::int AS gestoes_ativas
                FROM empresas e LEFT JOIN memberships m ON m.empresa_id = e.id
                WHERE e.codigo LIKE 'hml-%' AND e.status = 'ATIVA' GROUP BY e.codigo ORDER BY e.codigo`)).rows;
            const contas = (await db.query(`SELECT count(*)::int AS n FROM (
                    SELECT u.id FROM usuarios_administrativos u
                      JOIN memberships m ON m.usuario_id = u.id AND m.status='ATIVA' AND m.papel='REPRESENTANTE_AUTORIZADO'
                      JOIN empresas e ON e.id = m.empresa_id AND e.status='ATIVA' AND e.codigo LIKE 'hml-%'
                     WHERE u.ativo AND (lower(u.email) LIKE '%@example.invalid' OR lower(u.email) LIKE '%@exemplo.test')
                     GROUP BY u.id HAVING count(DISTINCT e.id) >= 2) x`)).rows[0].n;
            // Aproximação por código (a associação do produto também aceita id; lib/perfil/autorizacao.ts).
            const perfis = (await db.query(`SELECT e.codigo FROM empresas e
                    JOIN perfil_empresas p ON lower(p.codigo) = e.codigo AND p.id <> e.id
                   WHERE e.codigo LIKE 'hml-%' AND e.status='ATIVA'
                     AND (SELECT count(*) FROM memberships m WHERE m.empresa_id=e.id AND m.status='ATIVA' AND m.papel='REPRESENTANTE_AUTORIZADO') >= 2
                   ORDER BY e.codigo`)).rows.map(x => x.codigo);
            return {resultado:'DIAGNOSTICO', conexao, fixturesDestaRodadaLivres:!ocupado, hmlAtivas:hml,
                contasSinteticasComGestaoEmDuasHmlAtivas:contas, empresasHmlAtivasComPerfilProprioEDuasGestoes:perfis,
                candidatoReutilizavel:contas > 0 && perfis.length > 0,
                observacao:'Reutilizar exige que quem executa conheça a senha da conta existente; esta rodada não lê nem redefine senhas.'};
        });
    } finally { await db.end().catch(() => {}); }
}

/** Senhas digitadas por quem executa, duas vezes, sem eco; validadas pela regra do produto; nunca impressas nem gravadas. */
async function lerSenhas(lerSenha, senhaValida) {
    const senhas = {};
    for (const c of CONTAS) {
        const s1 = await lerSenha(`Senha da conta ${c.chave} (${c.email}), não aparece na tela`);
        const s2 = await lerSenha(`Repita a senha da conta ${c.chave}`);
        assert.ok(s1 === s2, 'SENHAS_DIFERENTES');
        assert.ok(senhaValida(s1), 'SENHA_FORA_DA_REGRA');
        senhas[c.chave] = s1;
    }
    assert.ok(senhas.A !== senhas.B, 'SENHAS_IGUAIS_ENTRE_CONTAS');
    return senhas;
}

/** Desativa só o que foi comprovadamente criado aqui; cada UPDATE confere id + marcador (código, nome, e-mail). */
async function desativar(db, r, servicos) {
    if (!comprovadas(r)) return 'NADA_CRIADO_PELA_RODADA';
    const tx = {query:async (t, v) => { const x = await db.query(t, v); return {rows:x.rows, rowCount:x.rowCount}; }};
    await db.query('BEGIN');
    try {
        // Perfis associados às empresas (enquanto ATIVAS: perfilDoTenantOuNulo só associa empresa ATIVA): anotados para a conferência.
        r.perfis = [];
        for (const e of EMPRESAS) {
            const ativa = (await db.query("SELECT status='ATIVA' AS ativa FROM empresas WHERE id=$1 AND codigo=$2", [e.id, e.codigo])).rows[0]?.ativa;
            const perfil = ativa ? await servicos.perfilDoTenantOuNulo(tx, e.id) : null;
            if (perfil) r.perfis.push(perfil);
        }
        const revogadas = [];
        for (const c of CONTAS)
            for (const perfil of r.perfis)
                revogadas.push(...await servicos.revogarConcessoesAtivasDoUsuario(tx, {usuarioId:c.id, operadorId:conta('A').id, motivo:MOTIVO_ENCERRAMENTO, empresaId:perfil}));
        r.concessoesRevogadas = revogadas.length;
        r.sessoesRevogadas = (await db.query('UPDATE sessoes_administrativas SET revogado_em=clock_timestamp() WHERE usuario_id=ANY($1::uuid[]) AND revogado_em IS NULL RETURNING id', [IDS_CONTAS])).rowCount;
        await db.query("UPDATE memberships SET status='SUSPENSA' WHERE empresa_id=ANY($1::uuid[]) AND usuario_id=ANY($2::uuid[]) AND status='ATIVA'", [IDS_EMPRESAS, IDS_CONTAS]);
        await db.query('UPDATE usuarios_administrativos SET ativo=false WHERE id=ANY($1::uuid[]) AND lower(email)=ANY($2::text[]) AND ativo', [IDS_CONTAS, CONTAS.map(c => c.email.toLowerCase())]);
        await db.query("UPDATE empresas SET status='DESATIVADA' WHERE id=ANY($1::uuid[]) AND codigo=ANY($2::text[]) AND nome=ANY($3::text[]) AND status IN ('ATIVA','SUSPENSA','PROVISIONAMENTO')",
            [IDS_EMPRESAS, EMPRESAS.map(e => e.codigo), EMPRESAS.map(e => e.nome)]);
        await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
    return 'DESATIVADAS';
}

async function criar({env, Client, servicos, lerSenha, dir = DIR, disco = exigirDisco}) {
    alvo(env);
    disco();
    fs.mkdirSync(dir, {recursive:true, mode:0o700});
    const arquivo = dir + '/' + ARQUIVO;
    assert.ok(!fs.existsSync(arquivo), 'RODADA_EXISTENTE');
    // Senhas antes de qualquer escrita: cancelar aqui não deixa rastro nem bloqueia uma nova tentativa.
    const senhas = await lerSenhas(lerSenha, servicos.senhaValida);
    const hashes = {};
    for (const c of CONTAS) hashes[c.chave] = await servicos.criarHashSenha(senhas[c.chave]);
    for (const k of Object.keys(senhas)) senhas[k] = null;
    const r = {rodada:RODADA, inicio:new Date().toISOString(), pid:process.pid, etapas:[]};
    fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600, flag:'wx'});
    const salvar = () => fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600});
    const marcar = e => { r.etapas.push(e); salvar(); };
    let db = null, erro = null;
    try {
        ({db, conexao:r.conexao} = await conectar(Client, env)); salvar();
        const schema = (await db.query(`SELECT to_regclass('public.assinatura_isencoes') IS NOT NULL
              AND to_regclass('public.perfil_empresas') IS NOT NULL
              AND to_regclass('public.plataforma_desenvolvedores') IS NOT NULL AS ok`)).rows[0];
        assert.equal(schema.ok, true, 'SCHEMA_S1');
        assert.equal((await db.query(SQL_OCUPADO, paramsOcupado())).rows[0].ocupado, false, 'FIXTURE_PREEXISTENTE_S1');
        r.precheck = {livres:true}; salvar();
        r.antes = (await db.query(SQL_PRESERVACAO, [IDS_EMPRESAS, IDS_CONTAS])).rows[0]; salvar();

        marcar('FIXTURES'); r.intencao = true; salvar();
        await db.query('BEGIN');
        try {
            for (const e of EMPRESAS) {
                await db.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,$3,'PROVISIONAMENTO')", [e.id, e.codigo, e.nome]);
                await db.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [e.id]);
            }
            for (const c of CONTAS)
                await db.query('INSERT INTO usuarios_administrativos(id,email,nome,senha_hash,papel,ativo) VALUES($1,$2,$3,$4,$5,true)',
                    [c.id, c.email, c.nome, hashes[c.chave], PAPEL_GLOBAL_NEUTRO]);
            for (const [c, e] of VINCULOS) {
                await db.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())", [empresa(e).id, conta(c).id]);
                await db.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2", [empresa(e).id, conta(c).id]);
            }
            // Isenção comercial: acesso COMPLETO sem cobrança, sem Asaas (mesmo mecanismo das fixtures de 11/10).
            for (const e of EMPRESAS) {
                const doc = documento(); assert.notEqual(doc, KIDMAIS_CNPJ);
                await db.query("INSERT INTO assinatura_isencoes(empresa_id,documento_verificado,motivo,concedida_por) VALUES($1,$2,'Homologação sintética do painel staging 20261011',$3)", [e.id, doc, conta('A').id]);
            }
            await db.query('COMMIT');
        } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
        r.fixtures = true; salvar();

        marcar('CONFERENCIA');
        const vinculos = (await db.query("SELECT count(*)::int AS n FROM memberships WHERE empresa_id=ANY($1::uuid[]) AND usuario_id=ANY($2::uuid[]) AND status='ATIVA' AND papel='REPRESENTANTE_AUTORIZADO'", [IDS_EMPRESAS, IDS_CONTAS])).rows[0].n;
        assert.equal(vinculos, VINCULOS.length, 'VINCULOS');
        r.depois = (await db.query(SQL_PRESERVACAO, [IDS_EMPRESAS, IDS_CONTAS])).rows[0];
        for (const k of ['empresas', 'memberships', 'usuarios']) assert.equal(r.depois[k], r.antes[k], 'PRESERVACAO_' + k);
        r.aprovado = true; salvar();
    } catch (e) {
        erro = e;
        r.falha = {etapa:r.etapas.at(-1) ?? 'S1', mensagem:String(e?.message ?? e).slice(0, 160)}; salvar();
        // Falha depois da intenção: desativa o que foi criado (nunca deixa fixture parcial ativa).
        if (db) { try { r.encerramento = await desativar(db, r, servicos); } catch (e2) { r.encerramentoFalhou = String(e2?.message).slice(0, 120); } salvar(); }
    } finally {
        if (db) await db.end().catch(() => {});
    }
    r.concluido = !erro; salvar();
    return {resultado:erro ? 'FALHA' : 'PASS', falha:r.falha ?? null, conexao:r.conexao ?? null,
        empresas:EMPRESAS.map(e => e.codigo), contas:CONTAS.map(c => ({chave:c.chave, login:c.email})), vinculos:VINCULOS.length,
        preservacao:r.aprovado ? 'IGUAL' : null, encerramento:r.encerramento ?? null};
}

function lerEstado(dir) {
    const arquivo = dir + '/' + ARQUIVO;
    assert.ok(fs.existsSync(arquivo), 'SEM_FIXTURES_PARA_ENCERRAR');
    const r = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    assert.equal(r.rodada, RODADA, 'ESTADO_DE_OUTRA_RODADA');
    return {r, salvar:() => fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600})};
}

async function encerrar({env, Client, servicos, dir = DIR, disco = exigirDisco}) {
    alvo(env);
    disco();
    const {r, salvar} = lerEstado(dir);
    const {db} = await conectar(Client, env);
    try {
        r.encerramento = await desativar(db, r, servicos);
        r.encerradoEm = new Date().toISOString(); salvar();
        return {resultado:'ENCERRADO', encerramento:r.encerramento, concessoesRevogadas:r.concessoesRevogadas ?? 0, sessoesRevogadas:r.sessoesRevogadas ?? 0};
    } finally { await db.end().catch(() => {}); }
}

/** Leitura: o encerramento deixou tudo inativo? (empresas DESATIVADA, nenhum vínculo ATIVO, contas inativas, 0 sessões e 0 concessões ativas). */
async function conferirEncerramento({env, Client, dir = DIR, disco = exigirDisco}) {
    alvo(env);
    disco();
    const {r} = lerEstado(dir);
    const {db} = await conectar(Client, env);
    try {
        return await leitura(db, async () => {
            const c = (await db.query(`SELECT
                (SELECT count(*)::int FROM empresas WHERE id=ANY($1::uuid[]) AND status<>'DESATIVADA') AS empresas_nao_desativadas,
                (SELECT count(*)::int FROM memberships WHERE empresa_id=ANY($1::uuid[]) AND status='ATIVA') AS vinculos_ativos,
                (SELECT count(*)::int FROM usuarios_administrativos WHERE id=ANY($2::uuid[]) AND ativo) AS contas_ativas,
                (SELECT count(*)::int FROM sessoes_administrativas WHERE usuario_id=ANY($2::uuid[]) AND revogado_em IS NULL AND expira_em > clock_timestamp()) AS sessoes_ativas,
                (SELECT count(*)::int FROM perfil_empresa_concessoes WHERE usuario_id=ANY($2::uuid[]) AND revogado_em IS NULL) AS concessoes_ativas`,
                [IDS_EMPRESAS, IDS_CONTAS])).rows[0];
            const ok = Object.values(c).every(n => n === 0);
            return {resultado:ok ? 'VERIFICADO' : 'DIVERGENTE', encerradoEm:r.encerradoEm ?? null, ...c};
        });
    } finally { await db.end().catch(() => {}); }
}

/** Leitura de senha no terminal sem eco (Render Shell). Recusa sem terminal: nada vem de argumento, ambiente ou arquivo. */
async function lerSenhaDoTerminal(rotulo, {entrada = process.stdin, saida = process.stderr} = {}) {
    assert.ok(entrada.isTTY && typeof entrada.setRawMode === 'function', 'SEM_TERMINAL');
    return new Promise((resolve, reject) => {
        let v = '';
        saida.write(rotulo + ': ');
        entrada.setRawMode(true); entrada.setEncoding('utf8'); entrada.resume();
        const fim = (erro) => {
            entrada.setRawMode(false); entrada.pause(); entrada.removeListener('data', aoDigitar); saida.write('\n');
            if (erro) reject(erro); else resolve(v);
        };
        function aoDigitar(pedaco) {
            for (const ch of pedaco) {
                if (ch === '\r' || ch === '\n') return fim(null);
                if (ch === '\u0003' || ch === '\u0004') return fim(new Error('CANCELADO'));
                if (ch === '\u007f' || ch === '\b') { v = [...v].slice(0, -1).join(''); continue; }
                v += ch;
            }
        }
        entrada.on('data', aoDigitar);
    });
}

if (require.main === module) {
    const m = modo(process.argv.slice(2));
    const {Client} = require('pg');
    const servicosReais = async () => ({
        ...(await import('../lib/autenticacao/senha.ts')), ...(await import('../lib/perfil/tenant.ts')),
        ...(await import('../lib/perfil/protecao-usuarios.ts')),
    });
    const fim = s => { const ok = ['PASS', 'ENCERRADO', 'VERIFICADO', 'DIAGNOSTICO'].includes(s.resultado); (ok ? console.log : console.error)(JSON.stringify(s)); if (!ok) process.exitCode = 2; };
    const falhou = e => { console.error(String(e?.message ?? 'RECUSADO').slice(0, 120)); process.exitCode = 1; };
    if (m === 'DIAGNOSTICAR') diagnosticar({env:process.env, Client}).then(fim, falhou);
    else if (m === 'CRIAR') servicosReais().then(servicos => criar({env:process.env, Client, servicos, lerSenha:lerSenhaDoTerminal})).then(fim, falhou);
    else if (m === 'ENCERRAR') servicosReais().then(servicos => encerrar({env:process.env, Client, servicos})).then(fim, falhou);
    else if (m === 'CONFERIR') conferirEncerramento({env:process.env, Client}).then(fim, falhou);
    else { console.error('AGUARDANDO_AUTORIZACAO_FIXTURES_PAINEL'); process.exitCode = 1; }
}
module.exports = {EMPRESAS, CONTAS, VINCULOS, RODADA, ARQUIVO, FLAGS, modo, alvo, comprovadas, lerSenhas, desativar, diagnosticar, criar, encerrar, conferirEncerramento, lerSenhaDoTerminal, SQL_OCUPADO, SQL_PRESERVACAO};
