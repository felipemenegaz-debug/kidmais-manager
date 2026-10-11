/* eslint-disable @typescript-eslint/no-require-imports */
// Etapa 4 — concorrência e reservas (docs/CONCORRENCIA_VAGAS_ISOLADO_20261010.md). PostgreSQL ISOLADO e descartável.
// Sem argumento (ou --plano): plano offline, nenhuma conexão. Execução SOMENTE com a flag única
// --concorrencia-isolada-autorizada e KIDMAIS_CONCORRENCIA_AUTORIZACAO=127.0.0.1:<porta>/kidmais_concorrencia_<nome>.
// Recusa antes de abrir socket: banco real/staging/produção, host fora de 127.0.0.1/localhost, porta 5432,
// DATABASE_URL/PG* herdadas. Depois confere identidade (banco, papel, endereço, porta, cluster_name) e exige
// cluster novo: nenhum outro banco além de postgres/template0/template1. Nunca lê .env, nunca apaga banco, sem rede.
// Os comportamentos sob teste passam pelos serviços de domínio (convites, vagas, ofertas); SQL direto só monta
// fixtures sintéticas, simula a passagem do tempo de um convite e prova que o banco recusa transições proibidas.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomBytes, randomUUID} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {cancelamentoComprovado} = require('./homologacao-fundador-staging.cjs');

const raiz = path.resolve(__dirname, '..');
const FLAG = '--concorrencia-isolada-autorizada';
const FLAG_PLANO = '--plano';
const VAR_AUTORIZACAO = 'KIDMAIS_CONCORRENCIA_AUTORIZACAO';
const PAPEL = 'kidmais_concorrencia'; // papel do initdb e cluster_name do servidor descartável
const PORTA_SUGERIDA = 55480;
const BANCO_SUGERIDO = 'kidmais_concorrencia_vagas_20261010';
const PADRAO_BANCO = /^kidmais_concorrencia_[a-z0-9_]{1,40}$/;
const BANCOS_PROIBIDOS = Object.freeze(['kidmais_manager', 'kidmais_staging_1z91', 'kidmais_production']);
const HOSTS_ACEITOS = Object.freeze(['127.0.0.1', 'localhost']);
const ULTIMA_MIGRATION = '20261011_079_convite_recuperacao_manual.sql';
/** Impressão (sha256, CRLF normalizado) de migrations + checks aplicados. Mudou → revisar o pacote e aprovar de novo. */
const IMPRESSAO_SCHEMA = '5528ce9b70d9599e7bdcc7bfb4fe98dac95acdc2e81ba4e55a2cb520e1662ade';
const CODIGO_SOB_TESTE = Object.freeze(['lib/assinatura/limites-usuarios.ts', 'lib/acessos/convites.ts', 'lib/assinatura/ofertas.ts',
    'lib/assinatura/planos-comerciais.ts', 'database/migrations/20261009_074a_planos_comerciais.sql', 'scripts/homologacao-fundador-staging.cjs']);
const VAGAS_FUNDADOR = 20;
const CONEXOES = 8;
const MOTIVO = 'Concorrência isolada 20261010: cobrança sintética comprovadamente removida';
const GRUPOS = Object.freeze([
    ['a', 'Duas conexões disputam a última vaga do Essencial (3): uma reserva, a outra LIMITE_USUARIOS_PLANO após a trava; rajada de 6'],
    ['b', 'Aceite troca a reserva por pessoa ativa sem aumentar a ocupação; aceite duplicado simultâneo não cria outro vínculo'],
    ['c', 'Convite cancelado/vencido libera a vaga; reenvio de vencido disputa vaga nova (nas duas ordens); reenvio válido não ocupa outra'],
    ['d', 'Falha depois da reserva (criação e aceite) desfaz tudo por rollback, sem consumir vaga'],
    ['e', 'Empresa acima da cota mantém vínculos e sessões, mas não convida'],
    ['f', 'Profissional (10) com duas conexões na última vaga; Premium sem teto; isenta, teste e sem assinatura livres'],
    ['g', 'Duas conexões disputam a 20ª vaga Fundador: uma reserva, a outra FUNDADOR_AGUARDANDO; teto 20 nunca excedido'],
    ['h', 'Liberação RESERVADA → LIBERADA só com contratação CANCELADA e cobrança comprovadamente removida; CONFIRMADA nunca volta'],
    ['z', 'Consistência final: contagens, vínculos únicos, nenhum acesso perdido, teto Fundador e postchecks 074a/075'],
].map(([id, nome]) => Object.freeze({id, nome})));

const recusa = (codigo) => Object.assign(Error(codigo), {codigo});

function modo(argv) {
    if (argv.length === 0 || (argv.length === 1 && argv[0] === FLAG_PLANO)) return 'PLANO';
    if (argv.length === 1 && argv[0] === FLAG) return 'EXECUTAR';
    return null;
}

/** Alvo literal; nenhum padrão implícito. Lança antes de qualquer conexão. */
function alvo(env) {
    const texto = env[VAR_AUTORIZACAO];
    if (typeof texto !== 'string' || texto === '') throw recusa('AUTORIZACAO_AUSENTE');
    const m = /^([^:/\s]+):([0-9]{1,5})\/([A-Za-z0-9_]+)$/.exec(texto);
    if (!m) throw recusa('AUTORIZACAO_MALFORMADA');
    const [, host, portaTexto, banco] = m;
    if (!HOSTS_ACEITOS.includes(host.toLowerCase())) throw recusa('HOST_RECUSADO');
    if (BANCOS_PROIBIDOS.some(b => banco.toLowerCase().includes(b))) throw recusa('BANCO_PROIBIDO');
    if (!PADRAO_BANCO.test(banco)) throw recusa('BANCO_FORA_DO_PADRAO');
    const porta = Number(portaTexto);
    if (!Number.isInteger(porta) || porta < 1024 || porta > 65535 || porta === 5432) throw recusa('PORTA_RECUSADA');
    // localhost pode resolver para ::1; o conector usa sempre 127.0.0.1 e confere o endereço no servidor.
    return Object.freeze({host:'127.0.0.1', porta, banco});
}

const variavelHerdada = nome => nome === 'DATABASE_URL' || /^PG/i.test(nome);
function semConexaoHerdada(env) {
    const herdadas = Object.keys(env).filter(variavelHerdada);
    if (herdadas.length) throw recusa('CONEXAO_HERDADA ' + herdadas.join(','));
}

const SQL_IDENTIDADE = `SELECT current_database() AS db, current_user AS papel, host(inet_server_addr()) AS endereco,
    inet_server_port() AS porta, current_setting('cluster_name') AS cluster,
    ARRAY(SELECT datname::text FROM pg_database WHERE datname NOT IN ('postgres','template0','template1') ORDER BY 1) AS bancos`;
/** Servidor certo e cluster novo: só o banco desta execução pode existir (nenhum real, de staging ou de produção). */
function conferirIdentidade(linha, a, database, bancosEsperados) {
    const r = linha ?? {};
    const obtido = {db:r.db, papel:r.papel, endereco:r.endereco, porta:Number(r.porta), cluster:r.cluster, bancos:r.bancos};
    const esperado = {db:database, papel:PAPEL, endereco:'127.0.0.1', porta:a.porta, cluster:PAPEL, bancos:bancosEsperados};
    try { assert.deepEqual(obtido, esperado); } catch { throw recusa('IDENTIDADE_DIVERGENTE'); }
    return true;
}

/** Remove e-mails, tokens, UUIDs e hashes; limita o tamanho. Saída e falhas só passam por aqui. */
function sanitizar(texto) {
    return String(texto ?? '')
        .replace(/[^\s@'"]+@[^\s@'"]+/g, '<email>')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
        .replace(/\b[0-9a-f]{64}\b/gi, '<hash>')
        .replace(/\b[A-Za-z0-9_-]{43}\b/g, '<token>')
        .slice(0, 160);
}

const lerNormalizado = relativo => fs.readFileSync(path.join(raiz, relativo), 'utf8').replace(/\r\n/g, '\n');
const sha = texto => createHash('sha256').update(texto).digest('hex');

/** Mesma receita de scripts/assinatura-schema-completo.cjs: inventário aprovado, prechecks, migration, postchecks. */
async function plano() {
    const {approvedFiles, requiredChecks} = await import(pathToFileURL(path.join(raiz, 'scripts/production/check-migrations.mjs')).href);
    if (approvedFiles.at(-1) !== ULTIMA_MIGRATION) throw recusa('INVENTARIO_MUDOU');
    const etapas = approvedFiles.map(arquivo => {
        const checks = (arquivo === '20261009_074a_planos_comerciais.sql' ? ['20261009_074a_precheck.sql', '20261009_074a_postcheck.sql'] : requiredChecks(arquivo))
            .map(p => `database/checks/${p}`);
        if (arquivo.split('_')[1] === '011') checks.push('database/checks/20260908_011_pagamentos_postcheck.sql');
        return {migration:`database/migrations/${arquivo}`, antes:checks.filter(p => p.includes('precheck')), depois:checks.filter(p => !p.includes('precheck'))};
    });
    const fontes = [...new Set(etapas.flatMap(e => [...e.antes, e.migration, ...e.depois]))];
    const impressao = sha(fontes.map(f => `${f}\0${sha(lerNormalizado(f))}\n`).join(''));
    const codigo = sha(CODIGO_SOB_TESTE.map(f => `${f}\0${sha(lerNormalizado(f))}\n`).join(''));
    return {etapas, migrations:etapas.length, arquivos:fontes.length, ultima:ULTIMA_MIGRATION, impressao, codigo};
}

async function conectar(a, database, bancosEsperados) {
    const {Client} = require('pg');
    const c = new Client({host:a.host, port:a.porta, user:PAPEL, database, ssl:false, connectionTimeoutMillis:5000,
        password:async () => { throw recusa('SERVIDOR_PEDIU_SENHA'); }, application_name:'kidmais-concorrencia-vagas'});
    await c.connect();
    try {
        conferirIdentidade((await c.query(SQL_IDENTIDADE)).rows[0], a, database, bancosEsperados);
        await c.query("SET statement_timeout='60s'"); await c.query("SET lock_timeout='10s'");
        return c;
    } catch (e) { await c.end().catch(() => {}); throw e; }
}

async function construirSchema(a, p) {
    const admin = await conectar(a, 'postgres', []);
    try { await admin.query(`CREATE DATABASE ${a.banco} TEMPLATE template0 ENCODING 'UTF8'`); } finally { await admin.end(); }
    const c = await conectar(a, a.banco, [a.banco]);
    try {
        for (const etapa of p.etapas) {
            if (etapa.migration.includes('_046_')) {
                // Pré-condição histórica da 046 (igual à receita canônica): identidade sintética, sem login nem e-mail.
                const email = lerNormalizado(etapa.migration).match(/email_alvo text := '([^']+)'/)?.[1];
                assert.ok(email, 'FIXTURE_046_REVISAR');
                await c.query(`INSERT INTO usuarios_administrativos(email,nome,cargo,senha_hash,papel,ativo)
                    VALUES(lower(btrim($1)),'Representante Fixture Sintética','Fixture de teste',$2,'REPRESENTANTE_AUTORIZADO',true)`, [email, hashFalso()]);
            }
            for (const arquivo of [...etapa.antes, etapa.migration, ...etapa.depois]) await c.query(lerNormalizado(arquivo));
        }
    } finally { await c.end(); }
}

function hashFalso() {
    const b64 = n => randomBytes(n).toString('base64').replace(/=+$/, '');
    return `scrypt$v=1$N=131072$r=8$p=1$${b64(16)}==$${b64(64)}==`;
}

const SQL_CAMPANHA = `SELECT count(*) FILTER (WHERE estado='CONFIRMADA')::int AS confirmadas,
    count(*) FILTER (WHERE estado<>'LIBERADA')::int AS ocupadas,
    count(DISTINCT vaga) FILTER (WHERE estado<>'LIBERADA')::int AS numeros,
    coalesce(max(vaga) FILTER (WHERE estado<>'LIBERADA'),0)::int AS maior FROM assinatura_fundadores`;

async function executar(env) {
    const a = alvo(env);
    semConexaoHerdada(env);
    if (path.resolve(process.cwd()).toLowerCase() !== raiz.toLowerCase()) throw recusa('EXECUTAR_NA_RAIZ_DO_REPOSITORIO');
    const p = await plano();
    if (p.impressao !== IMPRESSAO_SCHEMA) throw recusa('SCHEMA_DIVERGENTE_DO_PACOTE');
    global.fetch = async () => { throw Error('REDE_PROIBIDA'); };
    process.env.ADMIN_AUTH_SECRET = randomBytes(32).toString('hex'); // sintético, só neste processo
    process.env.EMAIL_PROVIDER = 'desativado';
    const inicio = Date.now();
    const resumo = {resultado:'INCOMPLETO', alvo:{host:a.host, porta:a.porta, banco:a.banco},
        schema:{migrations:p.migrations, arquivos:p.arquivos, ultima:p.ultima, impressao:p.impressao}, codigo:p.codigo, grupos:[], falha:null};
    const livres = [], fila = [], todos = [];
    let observador = null, grupoAtual = 'schema';
    try {
        await construirSchema(a, p);
        for (let i = 0; i < CONEXOES; i++) { const c = await conectar(a, a.banco, [a.banco]); todos.push(c); livres.push(c); }
        observador = await conectar(a, a.banco, [a.banco]);
        await rodarGrupos({a, resumo, livres, fila, observador, definirGrupo:g => { grupoAtual = g; }});
        resumo.resultado = 'PASS';
    } catch (e) {
        resumo.falha = {grupo:grupoAtual, codigo:sanitizar(e?.code ?? e?.codigo ?? e?.name), mensagem:sanitizar(e?.message)};
    } finally {
        for (const c of [...todos, observador].filter(Boolean)) await c.end().catch(() => {});
    }
    resumo.duracaoSegundos = Math.round((Date.now() - inicio) / 1000);
    resumo.observacao = 'Banco preservado para inspeção; parar/remover o cluster com scripts/cluster-descartavel-postgres.cjs (C5/C6).';
    console.log(JSON.stringify(resumo, null, 2));
    if (resumo.resultado !== 'PASS') process.exitCode = 2;
}

async function rodarGrupos({resumo, livres, fila, observador, definirGrupo}) {
    const pegar = () => new Promise(ok => { const c = livres.pop(); if (c) ok(c); else fila.push(ok); });
    const devolver = c => { const prox = fila.shift(); if (prox) prox(c); else livres.push(c); };
    const withTransaction = async trabalho => {
        const c = await pegar();
        try {
            await c.query('BEGIN');
            try { const r = await trabalho(c); await c.query('COMMIT'); return r; }
            catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        } finally { devolver(c); }
    };
    const db = () => ({query:async (sql, params) => { const c = await pegar(); try { return await c.query(sql, params); } finally { devolver(c); } }});
    const {carregarModulo} = await import(pathToFileURL(path.join(raiz, 'lib/acessos/teste-carregador.ts')).href);
    const cache = new Map();
    const carregar = f => carregarModulo(path.join(raiz, f), {'db/postgres':{db, withTransaction}}, cache);
    const s = {convites:carregar('lib/acessos/convites.ts'), limites:carregar('lib/assinatura/limites-usuarios.ts'), ofertas:carregar('lib/assinatura/ofertas.ts'),
        planos:carregar('lib/assinatura/planos-comerciais.ts'), auth:carregar('lib/autenticacao/service.ts'), tenant:carregar('lib/saas/provar-tenant.ts'),
        auditoria:carregar('lib/clientes/repositories/auditoria.repository.ts'), senha:carregar('lib/autenticacao/senha.ts')};
    const q = async (sql, params) => (await db().query(sql, params)).rows;
    const codigo = e => e?.code ?? e?.codigo ?? e?.name ?? 'ERRO';
    const resultado = async promessa => { try { await promessa; return 'OK'; } catch (e) { return codigo(e); } };
    const execucao = randomBytes(3).toString('hex');
    const gerarToken = () => randomBytes(32).toString('base64url');
    const emailDe = (f, rotulo) => `cv-${f.rotulo}-${rotulo}-${execucao}@example.invalid`;
    let ip = 0;
    const ctx = () => ({requestId:randomUUID(), ip:`198.51.100.${(ip++ % 250) + 1}`, userAgent:'kidmais-concorrencia-isolada'});
    const senha = 'Sintetica-' + randomBytes(12).toString('hex'); // só em memória
    const depsConvite = {withTransaction, registrarAuditoria:s.auditoria.registrarAuditoria, criarHashSenha:s.senha.criarHashSenha,
        conferirSenha:s.senha.conferirSenha, enviarEmail:async () => { throw Error('ENVIO_PROIBIDO'); }, gerarToken};
    const documentos = new Set();
    const documento = () => { let d; do d = '7' + String(randomBytes(6).readUIntBE(0, 6)).padStart(13, '0').slice(-13); while (documentos.has(d)); documentos.add(d); return d; };

    // ---- Fixtures sintéticas (as mesmas transições que o banco aceita para empresas novas).
    async function novaEmpresa(rotulo, {assinatura = true} = {}) {
        const f = {rotulo, empresa:randomUUID(), usuario:randomUUID(), documento:documento()};
        await withTransaction(async c => {
            await c.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,$3,'PROVISIONAMENTO')", [f.empresa, `cv-${rotulo}-${execucao}`, `TESTE concorrência ${rotulo}`]);
            await c.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [f.empresa]);
            await c.query(`INSERT INTO usuarios_administrativos(id,nome,email,cargo,senha_hash,papel,ativo)
                VALUES($1,'Gestão sintética',$2,'Fixture',$3,'REPRESENTANTE_AUTORIZADO',true)`, [f.usuario, emailDe(f, 'gestao'), hashFalso()]);
            await c.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())", [f.empresa, f.usuario]);
            await c.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2", [f.empresa, f.usuario]);
            if (assinatura) await c.query(`INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste)
                VALUES($1,'TESTE',clock_timestamp(),clock_timestamp()+interval '15 days',$2)`, [f.empresa, f.documento]);
        });
        return f;
    }
    const campanha = async () => (await q(SQL_CAMPANHA))[0];
    const pedido = (plano, fundador) => ({plano, ciclo:'MENSAL', valorEsperadoCentavos:s.planos.valorComercial(plano, 'mensal', fundador), versao:s.planos.condicoesComerciais.versao});
    const reservar = (f, c, plano = 'essencial') => s.ofertas.prepararOferta(c, f.empresa, f.usuario, pedido(plano, true));
    /** Contrato confirmado pelos serviços (oferta → pagamento conferido → ativação), com provedor falso e sem rede. */
    async function contratar(f, plano) {
        const oferta = await withTransaction(async c => s.ofertas.prepararOferta(c, f.empresa, f.usuario, pedido(plano, (await campanha()).ocupadas < VAGAS_FUNDADOR)));
        const hoje = (await q("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS dia"))[0].dia;
        const sub = {id:`sub_cv_${f.empresa}`, customer:`cus_cv_${f.empresa}`, externalReference:f.empresa, cycle:'MONTHLY', status:'ACTIVE', deleted:false, valorCentavos:oferta.valor_final_centavos};
        const pago = {id:`pay_cv_${f.empresa}`, status:'RECEIVED', dueDate:hoje, paymentDate:hoje, invoiceUrl:null, deleted:false,
            valorCentavos:oferta.valor_final_centavos, assinaturaId:sub.id, clienteId:sub.customer, billingType:'PIX'};
        await withTransaction(async c => {
            await c.query('SELECT id FROM empresas WHERE id=$1 FOR UPDATE', [f.empresa]);
            await c.query('SELECT empresa_id FROM empresa_assinaturas WHERE empresa_id=$1 FOR UPDATE', [f.empresa]);
            const x = await s.ofertas.confirmarOfertaPaga(c, f.empresa, sub, [pago], sub.customer);
            assert.ok(x, 'CONTRATO_NAO_CONFIRMADO');
            await c.query(`UPDATE empresa_assinaturas SET situacao='ATIVA',ciclo='MENSAL',plano=$2,contratacao_atual_id=$3,provedor='ASAAS',
                provedor_cliente_id=$4,provedor_assinatura_id=$5,periodo_atual_fim=clock_timestamp()+interval '1 month' WHERE empresa_id=$1`, [f.empresa, x.plano, x.id, sub.customer, sub.id]);
        });
        return oferta;
    }
    const vagas = f => withTransaction(c => s.limites.consultarVagas(c, f.empresa));
    const convidar = (f, rotulo, cliente) => {
        const trabalho = c => s.convites.criarConviteNaTransacao(c, {gerarToken}, {empresaId:f.empresa, email:emailDe(f, rotulo), nomeSugerido:null, papel:'ADMINISTRATIVO', criadoPor:f.usuario});
        return cliente ? trabalho(cliente) : withTransaction(trabalho);
    };
    const renovar = (f, conviteId, cliente) => {
        const trabalho = c => s.convites.renovarConviteNaTransacao(c, {gerarToken}, f.empresa, conviteId);
        return cliente ? trabalho(cliente) : withTransaction(trabalho);
    };
    const cancelar = (f, conviteId) => withTransaction(c => s.convites.cancelarConviteNaTransacao(c, f.empresa, conviteId, f.usuario));
    const aceitar = (token, rotulo, deps = {}) => s.convites.aceitarConvite({token, nome:`Pessoa ${rotulo}`, senha, confirmacao:senha}, ctx(), {...depsConvite, ...deps});
    /** Simula a passagem do prazo: expira_em = criado_em + 1 ms (a guarda 063 aceita enquanto PENDENTE). */
    async function expirar(conviteId) {
        await new Promise(ok => setTimeout(ok, 15));
        const r = await withTransaction(c => c.query(`UPDATE convites_acesso SET expira_em = criado_em + interval '1 millisecond'
            WHERE id=$1 AND status='PENDENTE' AND criado_em + interval '1 millisecond' < clock_timestamp()`, [conviteId]));
        assert.equal(r.rowCount, 1, 'EXPIRACAO_NAO_APLICADA');
    }
    const usuarioPorEmail = async email => (await q('SELECT id FROM usuarios_administrativos WHERE email=$1', [email])).map(x => x.id);
    const ocupadas = async (f, esperado, rotulo) => {
        const v = await vagas(f);
        assert.equal(v?.ocupadas, esperado, `${rotulo}: ocupadas`);
        return v;
    };

    async function aguardarBloqueio(pid, liquidado) {
        for (let i = 0; i < 400; i++) {
            if (liquidado()) throw recusa('SEGUNDA_TERMINOU_SEM_DISPUTA');
            const r = (await observador.query('SELECT wait_event_type AS tipo, wait_event AS evento FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
            if (r?.tipo === 'Lock') return `${r.tipo}/${r.evento}`;
            await new Promise(ok => setTimeout(ok, 25));
        }
        throw recusa('SEM_ESPERA_POR_TRAVA');
    }
    /** Disputa determinística: a 1ª conexão segura a trava; a 2ª comprovadamente espera; a 1ª confirma; a 2ª decide depois. */
    async function intercalar(primeiro, segundo) {
        const c1 = await pegar(), c2 = await pegar();
        try {
            await c1.query('BEGIN'); await c2.query('BEGIN');
            const pid = (await c2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const r1 = await primeiro(c1);
            let liquidou = false;
            const p2 = segundo(c2).then(v => ({ok:true, v}), e => ({ok:false, e})).finally(() => { liquidou = true; });
            const espera = await aguardarBloqueio(pid, () => liquidou);
            await c1.query('COMMIT');
            const r2 = await p2;
            await c2.query(r2.ok ? 'COMMIT' : 'ROLLBACK');
            return {r1, segundo:r2.ok ? 'OK' : codigo(r2.e), r2, espera};
        } catch (e) {
            await c1.query('ROLLBACK').catch(() => {}); await c2.query('ROLLBACK').catch(() => {});
            throw e;
        } finally { devolver(c1); devolver(c2); }
    }
    /** N conexões abrem transação antes e disparam juntas; cada uma confirma/desfaz assim que termina. */
    async function rajada(trabalhos) {
        const clientes = [];
        for (let i = 0; i < trabalhos.length; i++) clientes.push(await pegar());
        try {
            for (const c of clientes) await c.query('BEGIN');
            const r = await Promise.allSettled(trabalhos.map((t, i) => t(clientes[i]).then(
                async v => { await clientes[i].query('COMMIT'); return v; },
                async e => { await clientes[i].query('ROLLBACK').catch(() => {}); throw e; })));
            const recusas = {};
            for (const x of r) if (x.status === 'rejected') recusas[codigo(x.reason)] = (recusas[codigo(x.reason)] ?? 0) + 1;
            return {conexoes:trabalhos.length, sucesso:r.filter(x => x.status === 'fulfilled').length, recusas, valores:r.filter(x => x.status === 'fulfilled').map(x => x.value)};
        } finally { for (const c of clientes) { await c.query('ROLLBACK').catch(() => {}); devolver(c); } }
    }
    const somente = (recusas, cod, n) => assert.deepEqual(recusas, n ? {[cod]:n} : {}, `recusas esperadas ${cod}×${n}`);
    async function grupo(id, trabalho) {
        definirGrupo(id);
        const evidencias = await trabalho();
        const g = GRUPOS.find(x => x.id === id);
        resumo.grupos.push({id, nome:g.nome, resultado:'PASS', evidencias});
        console.error(`PASS ${id}: ${g.nome}`);
    }
    const esperado = {}; // ocupação final esperada por empresa de vagas

    // ---- (a) última vaga do Essencial
    await grupo('a', async () => {
        const A = await novaEmpresa('a'); await contratar(A, 'essencial');
        await convidar(A, 'a1'); await ocupadas(A, 2, 'a.antes');
        const d = await intercalar(c => convidar(A, 'a2', c), c => convidar(A, 'a3', c));
        assert.equal(d.segundo, 'LIMITE_USUARIOS_PLANO');
        const v = await ocupadas(A, 3, 'a.disputa'); assert.equal(v.disponiveis, 0);
        await cancelar(A, d.r1.id); await ocupadas(A, 2, 'a.cancelado');
        const r = await rajada(Array.from({length:6}, (_, i) => c => convidar(A, `r${i}`, c)));
        assert.equal(r.sucesso, 1); somente(r.recusas, 'LIMITE_USUARIOS_PLANO', 5);
        await ocupadas(A, 3, 'a.rajada'); esperado.a = [A, 3];
        assert.equal((await q("SELECT count(*)::int AS n FROM convites_acesso WHERE empresa_id=$1 AND status='PENDENTE'", [A.empresa]))[0].n, 2);
        return {limite:v.limite, disputa:{primeira:'OK', segunda:d.segundo, espera:d.espera}, rajada:{conexoes:r.conexoes, sucesso:r.sucesso, recusas:r.recusas}, ocupadas:3};
    });

    // ---- (b) aceite e aceite duplicado
    await grupo('b', async () => {
        const B = await novaEmpresa('b'); await contratar(B, 'essencial');
        const b1 = await convidar(B, 'b1'), b2 = await convidar(B, 'b2'); await ocupadas(B, 3, 'b.cheia');
        await aceitar(b1.token, 'b1');
        let v = await ocupadas(B, 3, 'b.aceite'); assert.deepEqual([v.ativos, v.convitesPendentes], [2, 1]);
        const dupla = await Promise.allSettled([aceitar(b2.token, 'b2'), aceitar(b2.token, 'b2')]);
        assert.equal(dupla.filter(x => x.status === 'fulfilled').length, 1);
        assert.deepEqual(dupla.filter(x => x.status === 'rejected').map(x => codigo(x.reason)), ['LINK_INVALIDO']);
        v = await ocupadas(B, 3, 'b.duplicado'); assert.deepEqual([v.ativos, v.convitesPendentes], [3, 0]);
        const ids = await usuarioPorEmail(emailDe(B, 'b2')); assert.equal(ids.length, 1);
        assert.equal((await q('SELECT count(*)::int AS n FROM memberships WHERE empresa_id=$1 AND usuario_id=$2', [B.empresa, ids[0]]))[0].n, 1);
        assert.equal(await resultado(aceitar(b2.token, 'b2')), 'LINK_INVALIDO');
        assert.equal(await resultado(convidar(B, 'b3')), 'LIMITE_USUARIOS_PLANO');
        esperado.b = [B, 3];
        return {aceite:{ocupadasAntes:3, ocupadasDepois:3, ativos:2}, duplicado:{simultaneos:2, sucesso:1, recusa:'LINK_INVALIDO', vinculos:1, identidades:1}, cheia:'LIMITE_USUARIOS_PLANO'};
    });

    // ---- (c) cancelamento, expiração e reenvio
    await grupo('c', async () => {
        const C = await novaEmpresa('c'); await contratar(C, 'essencial');
        const c1 = await convidar(C, 'c1'), c2 = await convidar(C, 'c2'); await ocupadas(C, 3, 'c.cheia');
        assert.equal(await resultado(convidar(C, 'c3')), 'LIMITE_USUARIOS_PLANO');
        await cancelar(C, c1.id); await ocupadas(C, 2, 'c.cancelado');
        const c3 = await convidar(C, 'c3'); await ocupadas(C, 3, 'c.reocupada');
        await renovar(C, c3.id); await ocupadas(C, 3, 'c.reenvioValido'); // válido: mesma vaga, sem nova reserva
        await expirar(c2.id); await ocupadas(C, 2, 'c.vencido');
        assert.equal(await resultado(aceitar(c2.token, 'c2')), 'LINK_INVALIDO');
        const ida = await intercalar(c => renovar(C, c2.id, c), c => convidar(C, 'c4', c));
        assert.equal(ida.segundo, 'LIMITE_USUARIOS_PLANO'); await ocupadas(C, 3, 'c.reenvioPrimeiro');
        await expirar(c2.id); await ocupadas(C, 2, 'c.vencidoDeNovo');
        const volta = await intercalar(c => convidar(C, 'c5', c), c => renovar(C, c2.id, c));
        assert.equal(volta.segundo, 'LIMITE_USUARIOS_PLANO'); await ocupadas(C, 3, 'c.novoPrimeiro');
        esperado.c = [C, 3];
        return {cancelamentoLibera:true, vencidoLibera:true, aceiteVencido:'LINK_INVALIDO', reenvioValidoSemNovaVaga:true,
            reenvioVencidoPrimeiro:{segunda:ida.segundo, espera:ida.espera}, novoConvitePrimeiro:{segunda:volta.segundo, espera:volta.espera}, ocupadas:3};
    });

    // ---- (d) rollback depois da reserva
    await grupo('d', async () => {
        const D = await novaEmpresa('d'); await contratar(D, 'essencial');
        await convidar(D, 'd1'); await ocupadas(D, 2, 'd.antes');
        assert.equal(await resultado(withTransaction(async c => { await convidar(D, 'd2', c); throw recusa('FALHA_SIMULADA_APOS_RESERVA'); })), 'FALHA_SIMULADA_APOS_RESERVA');
        await ocupadas(D, 2, 'd.criacaoDesfeita');
        assert.equal((await q('SELECT count(*)::int AS n FROM convites_acesso WHERE email=$1', [emailDe(D, 'd2')]))[0].n, 0);
        const d2 = await convidar(D, 'd2'); await ocupadas(D, 3, 'd.cheia');
        const real = s.auditoria.registrarAuditoria;
        const falhar = async (registro, tx) => { if (registro.acao === 'CONVITE_ACEITO') throw recusa('FALHA_SIMULADA_NO_ACEITE'); return real(registro, tx); };
        assert.equal(await resultado(aceitar(d2.token, 'd2', {registrarAuditoria:falhar})), 'FALHA_SIMULADA_NO_ACEITE');
        assert.equal((await usuarioPorEmail(emailDe(D, 'd2'))).length, 0, 'identidade desfeita');
        assert.equal((await q("SELECT status FROM convites_acesso WHERE id=$1", [d2.id]))[0].status, 'PENDENTE');
        let v = await ocupadas(D, 3, 'd.aceiteDesfeito'); assert.deepEqual([v.ativos, v.convitesPendentes], [1, 2]);
        await aceitar(d2.token, 'd2');
        v = await ocupadas(D, 3, 'd.aceiteRepetido'); assert.deepEqual([v.ativos, v.convitesPendentes], [2, 1]);
        assert.equal(await resultado(convidar(D, 'd3')), 'LIMITE_USUARIOS_PLANO');
        esperado.d = [D, 3];
        return {criacaoDesfeita:{ocupadas:2, convites:0}, aceiteDesfeito:{identidades:0, convite:'PENDENTE', ocupadas:3}, repeticao:'OK', cheia:'LIMITE_USUARIOS_PLANO'};
    });

    // ---- (e) acima da cota
    await grupo('e', async () => {
        const E = await novaEmpresa('e');
        for (const r of ['e1', 'e2', 'e3']) { const x = await convidar(E, r); await aceitar(x.token, r); } // teste: sem teto
        assert.equal(await vagas(E), null, 'teste não limita');
        const usuarios = [E.usuario, ...(await Promise.all(['e1', 'e2', 'e3'].map(r => usuarioPorEmail(emailDe(E, r))))).flat()];
        assert.equal(usuarios.length, 4);
        const sessoes = [];
        for (const u of usuarios) sessoes.push((await withTransaction(c => s.auth.criarSessaoAdministrativa(c, u, null, 'kidmais-concorrencia-isolada'))).token);
        await contratar(E, 'essencial');
        const v = await ocupadas(E, 4, 'e.acima'); assert.equal(v.excedido, true);
        assert.equal(await resultado(convidar(E, 'e4')), 'LIMITE_USUARIOS_PLANO');
        const r = await rajada(Array.from({length:3}, (_, i) => c => convidar(E, `er${i}`, c)));
        assert.equal(r.sucesso, 0); somente(r.recusas, 'LIMITE_USUARIOS_PLANO', 3);
        assert.equal((await q("SELECT count(*)::int AS n FROM memberships WHERE empresa_id=$1 AND status='ATIVA'", [E.empresa]))[0].n, 4);
        for (const t of sessoes) await s.auth.consultarSessao(t);
        for (const u of usuarios) await withTransaction(c => s.tenant.provarTenant(c, {usuario_id:u, papel:'ADMINISTRATIVO'}, E.empresa));
        await ocupadas(E, 4, 'e.depois'); esperado.e = [E, 4];
        return {limite:3, ocupadas:4, excedido:true, convite:'LIMITE_USUARIOS_PLANO', rajada:{conexoes:3, sucesso:0}, vinculosAtivos:4, sessoesValidas:4, tenantComprovado:4};
    });

    // ---- (f) Profissional, Premium, isenta, teste, sem assinatura
    await grupo('f', async () => {
        const P = await novaEmpresa('p'); await contratar(P, 'profissional');
        for (let i = 1; i <= 8; i++) await convidar(P, `p${i}`);
        await ocupadas(P, 9, 'f.profissional');
        const r = await rajada([c => convidar(P, 'px', c), c => convidar(P, 'py', c)]);
        assert.equal(r.sucesso, 1); somente(r.recusas, 'LIMITE_USUARIOS_PLANO', 1);
        const vp = await ocupadas(P, 10, 'f.profissionalCheia'); assert.equal(vp.limite, 10);
        assert.equal(await resultado(convidar(P, 'pz')), 'LIMITE_USUARIOS_PLANO');
        const M = await novaEmpresa('m'); await contratar(M, 'premium');
        for (let i = 1; i <= 12; i++) await convidar(M, `m${i}`);
        const vm = await ocupadas(M, 13, 'f.premium'); assert.deepEqual([vm.limite, vm.disponiveis, vm.excedido], [null, null, false]);
        const X = await novaEmpresa('x');
        await withTransaction(c => c.query('INSERT INTO assinatura_isencoes(empresa_id,documento_verificado,motivo,concedida_por) VALUES($1,$2,$3,$4)',
            [X.empresa, X.documento, 'Isenção sintética de teste', X.usuario]));
        const T = await novaEmpresa('t'), S = await novaEmpresa('s', {assinatura:false});
        for (const f of [X, T, S]) {
            for (let i = 1; i <= 5; i++) await convidar(f, `${f.rotulo}${i}`);
            assert.equal(await vagas(f), null, `${f.rotulo}: sem teto`);
        }
        esperado.p = [P, 10]; esperado.m = [M, 13];
        return {profissional:{limite:10, rajada:{conexoes:2, sucesso:1, recusas:r.recusas}, ocupadas:10}, premium:{limite:null, convites:12, ocupadas:13},
            isenta:{convites:5, limite:null}, teste:{convites:5, limite:null}, semAssinatura:{convites:5, limite:null}};
    });

    // ---- (g) última vaga Fundador
    let F1, F1reserva, aguardando;
    await grupo('g', async () => {
        const antes = await campanha();
        assert.equal(antes.confirmadas, antes.ocupadas, 'só confirmadas das empresas de vagas');
        for (let i = antes.ocupadas; i < VAGAS_FUNDADOR - 1; i++) { const f = await novaEmpresa(`g${i}`); await withTransaction(c => reservar(f, c)); }
        assert.equal((await campanha()).ocupadas, VAGAS_FUNDADOR - 1);
        F1 = await novaEmpresa('f1'); const F2 = await novaEmpresa('f2');
        const d = await intercalar(c => reservar(F1, c), c => reservar(F2, c));
        assert.equal(d.segundo, 'FUNDADOR_AGUARDANDO'); assert.ok(d.r1.fundador_id); assert.equal(d.r1.valor_final_centavos, pedido('essencial', true).valorEsperadoCentavos);
        F1reserva = (await q('SELECT id, vaga FROM assinatura_fundadores WHERE empresa_id=$1', [F1.empresa]))[0];
        let cp = await campanha(); assert.deepEqual([cp.ocupadas, cp.numeros, cp.maior], [20, 20, 20]);
        aguardando = [F2, ...await Promise.all([1, 2, 3, 4].map(i => novaEmpresa(`fa${i}`)))];
        const r = await rajada(aguardando.slice(1).map(f => c => reservar(f, c)));
        assert.equal(r.sucesso, 0); somente(r.recusas, 'FUNDADOR_AGUARDANDO', 4);
        assert.equal(await resultado(withTransaction(c => s.ofertas.prepararOferta(c, F2.empresa, F2.usuario, pedido('essencial', false)))), 'FUNDADOR_AGUARDANDO');
        assert.equal((await q('SELECT count(*)::int AS n FROM assinatura_contratacoes WHERE empresa_id=ANY($1::uuid[])', [aguardando.map(f => f.empresa)]))[0].n, 0, 'nenhuma contratação para quem aguarda');
        const teto = await resultado(withTransaction(c => c.query('INSERT INTO assinatura_fundadores(empresa_id,documento_beneficiario,vaga) VALUES($1,$2,21)', [F2.empresa, F2.documento])));
        const repetida = await resultado(withTransaction(c => c.query('INSERT INTO assinatura_fundadores(empresa_id,documento_beneficiario,vaga) VALUES($1,$2,$3)', [F2.empresa, F2.documento, F1reserva.vaga])));
        assert.equal(teto, '23514'); assert.equal(repetida, '23505');
        cp = await campanha(); assert.deepEqual([cp.ocupadas, cp.numeros, cp.maior], [20, 20, 20]);
        return {antes:{confirmadas:antes.confirmadas, ocupadas:antes.ocupadas}, disputa:{primeira:'OK', segunda:d.segundo, espera:d.espera, vaga:F1reserva.vaga, desconto:d.r1.desconto_percentual},
            rajada:{conexoes:r.conexoes, sucesso:0, recusas:r.recusas}, valorRegularAguardando:'FUNDADOR_AGUARDANDO', contratacoesDeQuemAguarda:0,
            vaga21:teto, vagaRepetida:repetida, campanha:{ocupadas:cp.ocupadas, numerosDistintos:cp.numeros, maior:cp.maior}};
    });

    // ---- (h) liberação comprovada; CONFIRMADA nunca volta
    await grupo('h', async () => {
        const MOTIVO_SQL = "UPDATE assinatura_fundadores SET estado='LIBERADA', liberada_em=clock_timestamp(), evidencia_liberacao=$2 WHERE id=$1";
        const direta = await resultado(withTransaction(c => c.query(MOTIVO_SQL, [F1reserva.id, MOTIVO])));
        assert.equal(direta, 'P0001', 'contratação aberta bloqueia a liberação');
        const liberar = async (f, evidencia) => {
            if (!cancelamentoComprovado(evidencia)) return 'RESERVA_MANTIDA';
            return withTransaction(async c => {
                await c.query('SELECT id FROM empresas WHERE id=$1 FOR UPDATE', [f.empresa]);
                await c.query(`UPDATE assinatura_contratacoes SET estado='CANCELADA', cancelada_em=clock_timestamp(), motivo_cancelamento=$2
                    WHERE empresa_id=$1 AND estado='EM_ABERTO' AND fundador_id IS NOT NULL`, [f.empresa, MOTIVO]);
                const v = await c.query(`UPDATE assinatura_fundadores SET estado='LIBERADA', liberada_em=clock_timestamp(), evidencia_liberacao=$2
                    WHERE empresa_id=$1 AND estado='RESERVADA'`, [f.empresa, MOTIVO]);
                assert.equal(v.rowCount, 1, 'VAGA_NAO_LIBERADA');
                return 'LIBERADA';
            });
        };
        const cobranca = extra => ({id:'pay_sintetica', deleted:true, status:'PENDING', paymentDate:null, ...extra});
        const paga = await liberar(F1, {completo:true, assinaturas:[{deleted:true}], cobrancas:[cobranca({status:'RECEIVED', paymentDate:'2026-10-10'})]});
        const incompleta = await liberar(F1, {completo:true, assinaturas:[{deleted:true}], cobrancas:[null]});
        assert.deepEqual([paga, incompleta], ['RESERVA_MANTIDA', 'RESERVA_MANTIDA']);
        assert.deepEqual((await q(`SELECT f.estado AS vaga, c.estado AS contratacao FROM assinatura_fundadores f
            JOIN assinatura_contratacoes c ON c.fundador_id=f.id WHERE f.id=$1`, [F1reserva.id]))[0], {vaga:'RESERVADA', contratacao:'EM_ABERTO'});
        assert.equal(await liberar(F1, {completo:true, assinaturas:[{deleted:true}], cobrancas:[cobranca()]}), 'LIBERADA');
        assert.equal((await campanha()).ocupadas, VAGAS_FUNDADOR - 1);
        const relibera = await resultado(withTransaction(c => c.query(MOTIVO_SQL, [F1reserva.id, MOTIVO])));
        const reabre = await resultado(withTransaction(c => c.query("UPDATE assinatura_fundadores SET estado='RESERVADA', liberada_em=NULL, evidencia_liberacao=NULL WHERE id=$1", [F1reserva.id])));
        assert.deepEqual([relibera, reabre], ['P0001', 'P0001']);
        const [F2, F3] = aguardando;
        const r = await rajada([c => reservar(F2, c), c => reservar(F3, c)]);
        assert.equal(r.sucesso, 1); somente(r.recusas, 'FUNDADOR_AGUARDANDO', 1);
        const nova = (await q("SELECT vaga FROM assinatura_fundadores WHERE empresa_id=ANY($1::uuid[]) AND estado='RESERVADA'", [[F2.empresa, F3.empresa]]));
        assert.equal(nova.length, 1); assert.equal(nova[0].vaga, F1reserva.vaga, 'reutiliza o número liberado');
        const confirmada = (await q("SELECT f.id AS vaga, c.id AS contratacao FROM assinatura_fundadores f JOIN assinatura_contratacoes c ON c.fundador_id=f.id AND c.estado='CONFIRMADA' WHERE f.estado='CONFIRMADA' LIMIT 1"))[0];
        const liberarConfirmada = await resultado(withTransaction(c => c.query(MOTIVO_SQL, [confirmada.vaga, MOTIVO])));
        const cancelarConfirmada = await resultado(withTransaction(c => c.query("UPDATE assinatura_contratacoes SET estado='CANCELADA', cancelada_em=clock_timestamp(), confirmada_em=NULL, pagamento_confirmacao_id=NULL, provedor_assinatura_id=NULL, motivo_cancelamento=$2 WHERE id=$1", [confirmada.contratacao, MOTIVO])));
        assert.deepEqual([liberarConfirmada, cancelarConfirmada], ['P0001', 'P0001']);
        const cp = await campanha(); assert.deepEqual([cp.ocupadas, cp.numeros, cp.maior], [20, 20, 20]);
        return {liberacaoComContratacaoAberta:direta, evidenciaPaga:paga, evidenciaIncompleta:incompleta, liberacaoComprovada:'LIBERADA', reliberar:relibera, reabrir:reabre,
            disputaPelaVagaLiberada:{conexoes:2, sucesso:1, recusas:r.recusas, mesmoNumero:true}, confirmadaLiberar:liberarConfirmada, confirmadaCancelar:cancelarConfirmada,
            campanha:{confirmadas:cp.confirmadas, ocupadas:cp.ocupadas, maior:cp.maior}};
    });

    // ---- (z) consistência final
    await grupo('z', async () => {
        const contagens = {};
        for (const [id, [f, n]] of Object.entries(esperado)) contagens[id] = (await ocupadas(f, n, `z.${id}`)).ocupadas;
        const duplicados = (await q('SELECT count(*)::int AS n FROM (SELECT 1 FROM memberships GROUP BY empresa_id, usuario_id HAVING count(*)>1) x'))[0].n;
        const pendentesDuplicados = (await q("SELECT count(*)::int AS n FROM (SELECT 1 FROM convites_acesso WHERE status='PENDENTE' GROUP BY empresa_id, email HAVING count(*)>1) x"))[0].n;
        const ativos = (await q("SELECT count(*)::int AS n FROM memberships m JOIN usuarios_administrativos u ON u.id=m.usuario_id WHERE m.status='ATIVA' AND u.ativo AND m.empresa_id=ANY($1::uuid[])",
            [Object.values(esperado).map(([f]) => f.empresa)]))[0].n;
        // a:1, b:3, c:1, d:2, e:4, p:1, m:1 vínculos ativos
        assert.deepEqual([duplicados, pendentesDuplicados, ativos], [0, 0, 13]);
        const incoerentes = (await q(`SELECT count(*)::int AS n FROM assinatura_contratacoes c JOIN assinatura_fundadores f ON f.id=c.fundador_id
            WHERE (f.estado='LIBERADA') <> (c.estado='CANCELADA') OR (f.estado='CONFIRMADA') <> (c.estado='CONFIRMADA')`))[0].n;
        const cp = await campanha();
        assert.equal(incoerentes, 0); assert.ok(cp.ocupadas <= VAGAS_FUNDADOR && cp.maior <= VAGAS_FUNDADOR && cp.numeros === cp.ocupadas);
        // Os postchecks abrem a própria transação somente leitura; rodam na conexão de observação, ociosa aqui.
        for (const check of ['database/checks/20261009_074a_postcheck.sql', 'database/checks/20261009_075_postcheck.sql'])
            await observador.query(lerNormalizado(check));
        return {ocupadas:contagens, vinculosDuplicados:duplicados, convitesPendentesDuplicados:pendentesDuplicados, vinculosAtivos:ativos,
            fundador:{confirmadas:cp.confirmadas, ocupadas:cp.ocupadas, maior:cp.maior, incoerencias:incoerentes}, postchecks:['074a', '075']};
    });
}

async function principal(argv, env) {
    const m = modo(argv);
    if (m === null) { console.error('USO: sem argumento/--plano (offline) ou ' + FLAG + ' (exige aprovação)'); process.exitCode = 1; return; }
    if (m === 'PLANO') {
        const p = await plano();
        console.log(JSON.stringify({modo:'PLANO_OFFLINE', conexao:false, alvoEsperado:`127.0.0.1:${PORTA_SUGERIDA}/${BANCO_SUGERIDO}`, papel:PAPEL,
            migrations:p.migrations, arquivos:p.arquivos, ultima:p.ultima, impressao:p.impressao, impressaoAprovada:IMPRESSAO_SCHEMA,
            confere:p.impressao === IMPRESSAO_SCHEMA, codigo:p.codigo, grupos:GRUPOS.map(g => g.id + ': ' + g.nome)}, null, 2));
        return;
    }
    await executar(env);
}

if (require.main === module)
    principal(process.argv.slice(2), process.env).catch(e => {
        console.error('CONCORRENCIA_RECUSADA ' + sanitizar(e?.codigo ?? e?.message)); process.exitCode = 1;
    });
module.exports = {FLAG, FLAG_PLANO, VAR_AUTORIZACAO, PAPEL, PORTA_SUGERIDA, BANCO_SUGERIDO, BANCOS_PROIBIDOS, GRUPOS, IMPRESSAO_SCHEMA,
    modo, alvo, semConexaoHerdada, conferirIdentidade, sanitizar, plano, SQL_IDENTIDADE};
