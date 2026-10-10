/* eslint-disable @typescript-eslint/no-require-imports */
// Rodada Fundador (rodada 2 de 10/10/2026, docs/HOMOLOGACAO_FUNDADOR_STAGING_20261010.md). Executar SOMENTE no Web Shell
// do srv-daif418ae00c73e8k2gg, depois da aprovação explícita, com a flag única --fundador-rodada-2-autorizada.
// Só reserva (sem pagamento): uma vaga confirmada nunca volta a LIBERADA (gatilho da 074), então nada é pago.
// Escreve só nas três fixtures; nunca apaga linha; libera só as vagas das fixtures depois de comprovar no Asaas
// que a assinatura e as cobranças da rodada foram removidas. Encerra no finally e no modo de recuperação.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createHash, randomBytes} = require('node:crypto');
const {alvo: alvoEnsaio, documento, cookies} = require('./assinatura-staging-ensaio.cjs');
const {SQL_IDENTIDADE, conferirIdentidade, exigirDisco} = require('./conexao-staging.cjs');
const {sqlPreservacao, processoVivo, erroFinal, projecaoAgenda} = require('./homologacao-planos-cotacao-staging.cjs');

const BASE = 'https://kidmais-manager-staging.onrender.com';
const DIR = '/opt/render/project/src/data/homologacao-planos-cotacao-20261010';
const ARQUIVO = DIR + '/fundador-rodada-2.json';
const MARCA = 'homologacao-fundador-20261010-r2';
const FLAG = '--fundador-rodada-2-autorizada';
const FLAG_ENCERRAR = '--encerrar-fundador-rodada-2-autorizada';
const KIDMAIS_CNPJ = '20119900000160';
const VAGAS_CAMPANHA = 20;
/** Preços em centavos fixados aqui (independentes do código): mensal regular e com 40% Fundador. */
const PRECOS = Object.freeze({
    essencial: {regular:19700, fundador:11820}, profissional: {regular:34700, fundador:20820}, premium: {regular:59700, fundador:35820},
});
const FIXTURES = Object.freeze([
    {chave:'FE', empresa:'ed7800c8-1ddd-4596-b82b-a5db0e5eafc2', usuario:'92eb6686-ad99-44bc-8bdb-d6909dfd96e3', codigo:'hml-fundador-essencial', plano:'essencial'},
    {chave:'FP', empresa:'3970a4d0-6fb2-4a0b-8c9a-b12dbce9f002', usuario:'132a7cc6-8626-4056-9322-f9586528ae47', codigo:'hml-fundador-profissional', plano:'profissional'},
    {chave:'FM', empresa:'be4f80f6-4f55-45b6-97e3-ceae28797cea', usuario:'2b0cb15e-2008-429a-a658-5ade854d50c2', codigo:'hml-fundador-premium', plano:'premium'},
].map(f => Object.freeze({...f, email:`hml-fundador-${f.usuario.slice(0,8)}@example.invalid`,
    nome:`TESTE Kidmais — Fundador staging 20261010 r2 ${f.chave}`})));
const IDS_EMPRESAS = FIXTURES.map(f => f.empresa);
const MOTIVO = 'Homologação Fundador staging 20261010 r2: assinatura sandbox removida e conferida no Asaas';

/** Comparadas antes/depois sem as fixtures; a campanha inteira (vagas de terceiros) tem de ficar idêntica. */
const PRESERVADAS = Object.freeze([
    ['empresas', 'id', []], ['memberships', 'empresa_id', []],
    ['empresa_assinaturas', 'empresa_id', ['sincronizado_em','atualizado_em','versao']],
    ['assinatura_contratacoes', 'empresa_id', []], ['assinatura_fundadores', 'empresa_id', []], ['assinatura_isencoes', 'empresa_id', []],
    ['clientes', 'empresa_id', []], ['fechamentos', 'empresa_id', []], ['pacotes', 'empresa_id', []],
]);

function alvo(env) { return alvoEnsaio(env); }
function alvoEncerramento(env) { return alvoEnsaio({...env, ASSINATURA_PLANOS_ATIVOS:'true'}); }
function modo(argv) {
    const flags = argv.filter(a => a.startsWith('--'));
    if (flags.length !== 1) return null;
    return flags[0] === FLAG ? 'RODADA' : flags[0] === FLAG_ENCERRAR ? 'ENCERRAR' : null;
}
function conferir(nome, obtido, esperado) {
    if (obtido !== esperado) throw Object.assign(Error('MATRIZ_DIVERGENTE'), {parada:'S2', item:nome, obtido, esperado});
}
/** Vagas livres para a rodada sem tocar no teto: as três fixtures precisam caber; senão S4. */
function cabeNaCampanha(c) {
    return Number.isInteger(c?.ocupadas) && c.ocupadas + FIXTURES.length <= VAGAS_CAMPANHA;
}

/**
 * O que a rodada comprovadamente criou, a partir do estado gravado ANTES de cada criação:
 *  - fixtures: S1 provou IDs/códigos/e-mails inexistentes E a rodada registrou intencaoFixture;
 *  - assinatura/cliente sandbox de F: S1 provou referência livre no Asaas E a rodada registrou intencaoCheckout;
 *  - vaga/contratação de F: existem só por causa do checkout da fixture (empresa nova provada em S1).
 */
function recursosComprovados(r) {
    const livre = r?.precheck?.fixturesLivres === true;
    return {
        fixtures: livre && r.intencaoFixture === true,
        assinaturas: Object.fromEntries(FIXTURES.map(f => [f.chave, livre && r?.precheck?.asaasLivre?.[f.chave] === true && r[f.chave]?.intencaoCheckout === true])),
    };
}

/**
 * Cancelamento comprovado no provedor: toda assinatura da referência removida (404 ou deleted) e toda cobrança
 * registrada antes da remoção removida (404 ou deleted). Cobrança paga ou desconhecida = não comprovado.
 */
function cancelamentoComprovado({assinaturas, cobrancas}) {
    return Array.isArray(assinaturas) && Array.isArray(cobrancas)
        && assinaturas.every(a => a === null || a.deleted === true)
        && cobrancas.every(c => c === null || c.deleted === true);
}

/**
 * Encerramento idempotente (finally e recuperação). Nunca lança; o erro original prevalece no chamador.
 * Ordem por fixture: remove a assinatura sandbox → relê e comprova → (banco) cancela a contratação aberta e libera a
 * vaga reservada. Sem prova, a vaga fica reservada e o motivo é registrado (nunca forçado). Vaga CONFIRMADA não é tocada.
 */
async function encerrar({db, conectado, r, p, obterCobranca, salvar}) {
    let erro = null;
    const gravar = () => { try { salvar(); } catch { /* disco indisponível não impede o encerramento */ } };
    const falhar = (etapa, e) => { erro ??= Object.assign(Error('LIMPEZA_' + etapa), {etapa});
        r.falhasEncerramento = [...(r.falhasEncerramento ?? []), {etapa, mensagem:String(e?.message ?? e).slice(0, 120)}]; gravar(); };
    try {
        if (conectado) await db.query('ROLLBACK').catch(() => {});
        const prova = recursosComprovados(r);
        r.encerramento = {inicio:new Date().toISOString(), prova, vagas:{}}; gravar();
        const comprovados = [];
        for (const f of FIXTURES) {
            if (!prova.assinaturas[f.chave]) { r.encerramento[f.chave] = {acao:'NADA_CRIADO_PELA_RODADA'}; gravar(); continue; }
            try {
                const subs = await p.listarAssinaturasPorReferencia(f.empresa); assert.ok(subs.length <= 1, 'SUB_DUPLICADA');
                for (const sub of subs) {
                    assert.equal(sub.externalReference, f.empresa, 'SUB_DE_OUTRA_REFERENCIA');
                    if (r[f.chave]?.clienteId) assert.equal(sub.customer, r[f.chave].clienteId, 'SUB_DE_OUTRO_CLIENTE');
                    if (r[f.chave]?.assinaturaId) assert.equal(sub.id, r[f.chave].assinaturaId, 'SUB_DIFERENTE_DA_REGISTRADA');
                }
                // Cobranças registradas antes da remoção (a remoção as apaga; depois a listagem pode não existir).
                const ids = new Set(r[f.chave]?.cobrancas ?? []);
                for (const sub of subs.filter(s => !s.deleted)) {
                    for (const c of await p.listarCobrancasDaAssinatura(sub.id)) {
                        assert.ok(!['RECEIVED','CONFIRMED','RECEIVED_IN_CASH'].includes(c.status) || c.deleted, 'COBRANCA_PAGA');
                        ids.add(c.id);
                    }
                    r[f.chave] = {...r[f.chave], cobrancas:[...ids]}; gravar();
                    assert.equal((await p.removerAssinatura(sub.id)).removida, true, 'SUB_NAO_REMOVIDA');
                }
                const idsSubs = [...new Set([...subs.map(s => s.id), ...(r[f.chave]?.assinaturaId ? [r[f.chave].assinaturaId] : [])])];
                const releitura = {assinaturas:await Promise.all(idsSubs.map(id => p.obterAssinatura(id))),
                    cobrancas:await Promise.all([...ids].map(id => obterCobranca(id)))};
                const comprovado = cancelamentoComprovado(releitura);
                r.encerramento[f.chave] = {acao:comprovado ? 'ASSINATURA_REMOVIDA_COMPROVADA' : 'REMOCAO_NAO_COMPROVADA',
                    assinaturas:idsSubs.length, cobrancas:ids.size}; gravar();
                if (comprovado) comprovados.push(f); else throw Error('CANCELAMENTO_NAO_COMPROVADO');
            } catch (e) { r.limpezaAssinaturaPendente = true; falhar('ASSINATURA_' + f.chave, e); }
        }
        try {
            if (!prova.fixtures) r.encerramento.fixtures = 'NADA_CRIADO_PELA_RODADA';
            else if (!conectado) throw Error('BANCO_INDISPONIVEL');
            else {
                await db.query('BEGIN');
                for (const f of comprovados) {
                    // A empresa da fixture foi provada inexistente em S1: toda contratação/vaga dela é da rodada.
                    const c = await db.query(`UPDATE assinatura_contratacoes SET estado='CANCELADA', cancelada_em=clock_timestamp(), motivo_cancelamento=$2
                        WHERE empresa_id=$1 AND estado='EM_ABERTO'`, [f.empresa, MOTIVO]);
                    const v = await db.query(`UPDATE assinatura_fundadores SET estado='LIBERADA', liberada_em=clock_timestamp(), evidencia_liberacao=$2
                        WHERE empresa_id=$1 AND estado='RESERVADA'`, [f.empresa, MOTIVO]);
                    const resto = (await db.query("SELECT estado FROM assinatura_fundadores WHERE empresa_id=$1 AND estado<>'LIBERADA'", [f.empresa])).rows;
                    r.encerramento.vagas[f.chave] = {contratacoesCanceladas:c.rowCount, vagasLiberadas:v.rowCount, naoLiberadas:resto.map(x => x.estado)};
                }
                await db.query('UPDATE usuarios_administrativos SET ativo=false WHERE id=ANY($1::uuid[]) AND email=ANY($2::text[])', [FIXTURES.map(f => f.usuario), FIXTURES.map(f => f.email)]);
                await db.query("UPDATE memberships SET status='REVOGADA' WHERE empresa_id=ANY($1::uuid[]) AND usuario_id=ANY($2::uuid[]) AND status<>'REVOGADA'", [IDS_EMPRESAS, FIXTURES.map(f => f.usuario)]);
                await db.query("UPDATE empresas SET status='DESATIVADA' WHERE id=ANY($1::uuid[]) AND codigo=ANY($2::text[]) AND nome=ANY($3::text[]) AND status<>'DESATIVADA'", [IDS_EMPRESAS, FIXTURES.map(f => f.codigo), FIXTURES.map(f => f.nome)]);
                await db.query('COMMIT'); r.fixturesDesativadas = true; r.encerramento.fixtures = 'DESATIVADAS';
                const presas = Object.entries(r.encerramento.vagas).filter(([, x]) => x.naoLiberadas.length).map(([k]) => k);
                if (presas.length) throw Error('VAGA_NAO_LIBERADA ' + presas.join(','));
            }
            gravar();
        } catch (e) { if (conectado) await db.query('ROLLBACK').catch(() => {}); r.limpezaBancoPendente = true; falhar('BANCO', e); }
    } catch (e) { falhar('ENCERRAMENTO', e); }
    try { r.encerramento = {...(r.encerramento ?? {}), fim:new Date().toISOString()}; } catch { /* nada */ }
    gravar();
    return erro;
}

/** Cliente Asaas sandbox + leitura de uma cobrança por id (404 = removida). */
async function provedorSandbox() {
    const {configuracaoAsaas, criarClienteAsaas} = await import('../lib/assinatura/asaas.ts');
    const cfg = configuracaoAsaas(); assert.ok(cfg.ligado, 'ASAAS_DESLIGADO');
    const obterCobranca = async id => {
        assert.match(String(id), /^[A-Za-z0-9_-]{1,100}$/);
        const res = await fetch('https://api-sandbox.asaas.com/v3/payments/' + encodeURIComponent(id), {redirect:'error', signal:AbortSignal.timeout(15000),
            headers:{access_token:cfg.config.apiKey, 'User-Agent':'kidmais-staging-homologacao'}});
        if (res.status === 404) return null;
        if (!res.ok) throw Object.assign(Error('ASAAS_HTTP'), {status:res.status});
        const j = await res.json(); return {id:j.id, deleted:j.deleted === true, status:j.status};
    };
    return {p:criarClienteAsaas(cfg.config), obterCobranca};
}

async function campanha(db) {
    return (await db.query(`SELECT count(*) FILTER (WHERE estado='CONFIRMADA')::int AS confirmadas,
        count(*) FILTER (WHERE estado<>'LIBERADA')::int AS ocupadas FROM assinatura_fundadores`)).rows[0];
}

async function recuperar() {
    const opts = alvoEncerramento(process.env);
    exigirDisco();
    assert.ok(fs.existsSync(ARQUIVO), 'SEM_RODADA_PARA_ENCERRAR');
    const r = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    assert.equal(r.marca, MARCA, 'ESTADO_DE_OUTRA_RODADA');
    assert.ok(!(r.concluido === undefined && processoVivo(r.pid)), 'RODADA_EM_EXECUCAO');
    const salvar = () => fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600});
    r.recuperacoes = [...(r.recuperacoes ?? []), new Date().toISOString()]; salvar();
    const {Client} = require('pg');
    const {p, obterCobranca} = await provedorSandbox();
    const db = new Client(opts); let conectado = false, erro = null;
    try {
        await db.connect(); conectado = true; await db.query("SET statement_timeout='15s'");
        conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0], process.env, '_S1');
    } catch (e) { conectado = false; erro = e; }
    erro = erroFinal(erro, await encerrar({db, conectado, r, p, obterCobranca, salvar}));
    if (conectado) r.campanhaDepois = await campanha(db).catch(() => null);
    await db.end().catch(() => {});
    r.recuperado = !erro; salvar();
    console.log(JSON.stringify({resultado:erro ? 'ENCERRAMENTO_INCOMPLETO' : 'ENCERRADO', erro:erro ? String(erro.message).slice(0, 80) : null,
        encerramento:r.encerramento ?? null, campanhaAntes:r.campanhaAntes ?? null, campanhaDepois:r.campanhaDepois ?? null, falhasEncerramento:r.falhasEncerramento ?? []}));
    if (erro) process.exitCode = 2;
}

async function main() {
    const opts = alvo(process.env);
    const {Client} = require('pg');
    const {criarHashSenha} = await import('../lib/autenticacao/senha.ts');
    const {p, obterCobranca} = await provedorSandbox();
    exigirDisco();
    fs.mkdirSync(DIR, {recursive:true, mode:0o700});
    assert.ok(!fs.existsSync(ARQUIVO), 'RODADA_EXISTENTE_S1');
    const r = {marca:MARCA, inicio:new Date().toISOString(), pid:process.pid, etapas:[], resultados:{}};
    fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600, flag:'wx'});
    const salvar = () => fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600});
    const db = new Client(opts); let conectado = false, erro, etapa = 'PRECHECK';
    const marcar = e => { etapa = e; r.etapas.push(e); salvar(); };
    const senhas = new Map(FIXTURES.map(f => [f.chave, 'Sintetica-' + randomBytes(24).toString('hex')])); // só em memória
    const sessao = f => {
        const jar = new Map();
        const pedir = async (caminho, method = 'GET', body, extras = {}) => {
            assert.ok(caminho.startsWith('/api/admin/'));
            const res = await fetch(BASE + caminho, {method, redirect:'error', signal:AbortSignal.timeout(60000),
                headers:{Cookie:[...jar].map(([k, v]) => k + '=' + v).join(';'), 'Content-Type':'application/json', ...extras}, ...(body ? {body:JSON.stringify(body)} : {})});
            cookies(res.headers, jar); const j = await res.json().catch(() => ({})); return {status:res.status, j};
        };
        const post = async (caminho, body) => { const s = (await pedir('/api/admin/autenticacao')).j.data ?? {};
            return pedir(caminho, 'POST', body, {Origin:BASE, 'x-csrf-token':s.csrf ?? '', ...(s.sessaoId ? {'x-kidmais-sessao':s.sessaoId} : {})}); };
        return {pedir, post, entrar: async () => {
            assert.equal((await post('/api/admin/autenticacao', {acao:'login', email:f.email, senha:senhas.get(f.chave)})).status, 200, 'LOGIN_' + f.chave);
            assert.equal((await post('/api/admin/autenticacao', {acao:'selecionar-empresa', empresaId:f.empresa})).status, 200, 'EMPRESA_' + f.chave);
        }};
    };
    const preservacao = async () => {
        const hashes = {};
        for (const [tabela, coluna, volateis] of PRESERVADAS) {
            const linhas = (await db.query(sqlPreservacao(tabela, coluna, volateis), [IDS_EMPRESAS])).rows.map(x => x.linha);
            hashes[tabela] = createHash('sha256').update(JSON.stringify(linhas)).digest('hex');
        }
        return hashes;
    };
    const kidmaisPublico = async () => {
        const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1, 1); const i = d.toISOString().slice(0, 10); d.setUTCMonth(d.getUTCMonth() + 1, 0);
        const [pac, ag] = await Promise.all(['/api/fechamentos/pacotes', `/api/disponibilidade?inicio=${i}&fim=${d.toISOString().slice(0, 10)}`]
            .map(c => fetch(BASE + c, {redirect:'manual', signal:AbortSignal.timeout(60000)}).then(async x => ({status:x.status, j:await x.json().catch(() => null)}))));
        assert.equal(pac.status, 200, 'KIDMAIS_PACOTES'); assert.equal(ag.status, 200, 'KIDMAIS_AGENDA');
        const h = v => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');
        return {pacotes:h(pac.j), agenda:h(projecaoAgenda(ag.j))};
    };
    try {
        // ---- S1: alvo, conexão, schema 074, fixtures e referências livres, vagas disponíveis sem tocar no teto.
        await db.connect(); conectado = true; await db.query("SET statement_timeout='15s'");
        r.conexao = conferirIdentidade((await db.query(SQL_IDENTIDADE)).rows[0], process.env, '_S1'); salvar();
        const schema = (await db.query(`SELECT to_regclass('public.assinatura_fundadores') IS NOT NULL AND to_regclass('public.assinatura_contratacoes') IS NOT NULL
            AND to_regclass('public.assinatura_fundadores_vaga_uk') IS NOT NULL AS ok`)).rows[0];
        assert.equal(schema.ok, true, 'SCHEMA_S1');
        const ocupado = (await db.query(`SELECT EXISTS(SELECT 1 FROM empresas WHERE id=ANY($1::uuid[]) OR codigo=ANY($2::text[]))
            OR EXISTS(SELECT 1 FROM usuarios_administrativos WHERE id=ANY($3::uuid[]) OR email=ANY($4::text[])) AS ocupado`,
            [IDS_EMPRESAS, FIXTURES.map(f => f.codigo), FIXTURES.map(f => f.usuario), FIXTURES.map(f => f.email)])).rows[0];
        assert.equal(ocupado.ocupado, false, 'FIXTURE_PREEXISTENTE_S1');
        r.campanhaAntes = await campanha(db); salvar();
        if (!cabeNaCampanha(r.campanhaAntes)) throw Object.assign(Error('FUNDADOR_SEM_VAGAS_S4'), {parada:'S4'});
        r.precheck = {fixturesLivres:true, asaasLivre:{}}; salvar();
        for (const f of FIXTURES) {
            assert.equal(await p.buscarClientePorReferencia(f.empresa), null, 'CLIENTE_ASAAS_PREEXISTENTE_S1');
            assert.equal((await p.listarAssinaturasPorReferencia(f.empresa)).length, 0, 'ASSINATURA_ASAAS_PREEXISTENTE_S1');
            r.precheck.asaasLivre[f.chave] = true; salvar();
        }
        r.antes = await preservacao(); r.kidmaisAntes = await kidmaisPublico(); salvar();

        // ---- Fixtures (uma transação): empresas com teste encerrado, prontas para assinar.
        marcar('FIXTURES'); r.intencaoFixture = true; salvar(); await db.query('BEGIN');
        for (const f of FIXTURES) {
            let doc; do { doc = documento(); } while (doc === KIDMAIS_CNPJ
                || (await db.query('SELECT 1 FROM assinatura_fundadores WHERE documento_beneficiario=$1', [doc])).rowCount);
            await db.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,$3,'PROVISIONAMENTO')", [f.empresa, f.codigo, f.nome]);
            await db.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [f.empresa]);
            await db.query("INSERT INTO usuarios_administrativos(id,email,nome,senha_hash,papel,ativo) VALUES($1,$2,'Gestão Sintética Fundador',$3,'REPRESENTANTE_AUTORIZADO',true)",
                [f.usuario, f.email, await criarHashSenha(senhas.get(f.chave))]);
            await db.query("UPDATE usuarios_administrativos SET senha_alterada_em=clock_timestamp()-interval '1 hour' WHERE id=$1", [f.usuario]);
            await db.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())", [f.empresa, f.usuario]);
            await db.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2", [f.empresa, f.usuario]);
            await db.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste) VALUES($1,'TESTE',clock_timestamp()-interval '16 days',clock_timestamp()-interval '1 hour',$2)", [f.empresa, doc]);
        }
        await db.query('COMMIT'); r.fixture = true; salvar();

        // ---- Checkout Fundador (sem pagamento): oferta, reserva, contratação e assinatura sandbox com 40%.
        const s = Object.fromEntries(FIXTURES.map(f => [f.chave, sessao(f)]));
        for (const f of FIXTURES) await s[f.chave].entrar();
        for (const f of FIXTURES) {
            marcar('CHECKOUT_' + f.chave);
            const o = (await s[f.chave].pedir('/api/admin/assinatura')).j.data?.ofertas;
            conferir(f.chave + '.habilitado', o?.habilitado, true); conferir(f.chave + '.fundador', o?.fundador, true);
            conferir(f.chave + '.aguardandoVaga', o?.aguardandoVaga, false);
            const oferta = o.planos.find(x => x.id === f.plano);
            conferir(f.chave + '.precoRegular', oferta?.mensalRegular, PRECOS[f.plano].regular);
            conferir(f.chave + '.precoFundador', oferta?.mensal, PRECOS[f.plano].fundador);
            r[f.chave] = {intencaoCheckout:true}; salvar(); // prova de autoria ANTES do checkout
            const ck = await s[f.chave].post('/api/admin/assinatura/checkout', {plano:f.plano, ciclo:'MENSAL', valorEsperadoCentavos:PRECOS[f.plano].fundador, versao:o.versao});
            conferir(f.chave + '.checkout', ck.status, 200);
            const linha = (await db.query('SELECT provedor_cliente_id,provedor_assinatura_id,plano FROM empresa_assinaturas WHERE empresa_id=$1', [f.empresa])).rows[0];
            Object.assign(r[f.chave], {clienteId:linha.provedor_cliente_id, assinaturaId:linha.provedor_assinatura_id}); salvar();
            conferir(f.chave + '.semConfirmacao', linha.plano, 'UNICO'); // só reserva: plano contratado ainda não confirmado
            const vaga = (await db.query(`SELECT v.id, v.estado, v.vaga, v.documento_beneficiario = a.documento_teste AS doc_ok,
                    c.estado AS contratacao, c.plano, c.desconto_percentual, c.valor_regular_centavos, c.valor_final_centavos
                FROM assinatura_fundadores v JOIN empresa_assinaturas a ON a.empresa_id=v.empresa_id
                JOIN assinatura_contratacoes c ON c.empresa_id=v.empresa_id AND c.fundador_id=v.id WHERE v.empresa_id=$1`, [f.empresa])).rows;
            conferir(f.chave + '.reservas', vaga.length, 1);
            const x = vaga[0]; r[f.chave].vaga = x.vaga; salvar();
            conferir(f.chave + '.vaga.estado', x.estado, 'RESERVADA'); conferir(f.chave + '.vaga.documento', x.doc_ok, true);
            conferir(f.chave + '.contratacao', x.contratacao, 'EM_ABERTO'); conferir(f.chave + '.contratacao.plano', x.plano, f.plano.toUpperCase());
            conferir(f.chave + '.desconto', x.desconto_percentual, 40);
            conferir(f.chave + '.contratacao.regular', x.valor_regular_centavos, PRECOS[f.plano].regular);
            conferir(f.chave + '.contratacao.final', x.valor_final_centavos, PRECOS[f.plano].fundador);
            // Provedor: uma assinatura com o valor Fundador e a primeira cobrança pendente, nunca paga.
            const subs = (await p.listarAssinaturasPorReferencia(f.empresa)).filter(a => !a.deleted);
            conferir(f.chave + '.asaas.assinaturas', subs.length, 1); conferir(f.chave + '.asaas.id', subs[0].id, r[f.chave].assinaturaId);
            conferir(f.chave + '.asaas.valor', subs[0].valorCentavos, PRECOS[f.plano].fundador);
            const cobrancas = (await p.listarCobrancasDaAssinatura(subs[0].id)).filter(c => !c.deleted);
            r[f.chave].cobrancas = cobrancas.map(c => c.id); salvar();
            conferir(f.chave + '.asaas.cobrancas', cobrancas.length, 1);
            conferir(f.chave + '.asaas.cobranca.valor', cobrancas[0].valorCentavos, PRECOS[f.plano].fundador);
            conferir(f.chave + '.asaas.cobranca.pendente', cobrancas[0].status, 'PENDING');
            const depois = (await s[f.chave].pedir('/api/admin/assinatura')).j.data?.ofertas;
            conferir(f.chave + '.pendente.valor', depois?.pendente?.valorCentavos, PRECOS[f.plano].fundador);
            r.resultados[f.chave] = {plano:f.plano, vaga:x.vaga, regular:x.valor_regular_centavos, fundador:x.valor_final_centavos, asaas:subs[0].valorCentavos}; salvar();
        }

        // ---- Campanha: exatamente três vagas a mais, todas reservadas pelas fixtures; demais intactas (S3).
        marcar('CAMPANHA');
        r.campanhaReservada = await campanha(db);
        conferir('campanha.ocupadas', r.campanhaReservada.ocupadas, r.campanhaAntes.ocupadas + FIXTURES.length);
        conferir('campanha.confirmadas', r.campanhaReservada.confirmadas, r.campanhaAntes.confirmadas);
        marcar('PRESERVACAO');
        r.kidmaisDepois = await kidmaisPublico();
        conferir('kidmais.pacotes', r.kidmaisDepois.pacotes, r.kidmaisAntes.pacotes); conferir('kidmais.agenda', r.kidmaisDepois.agenda, r.kidmaisAntes.agenda);
        r.depois = await preservacao();
        for (const [tabela] of PRESERVADAS) if (r.depois[tabela] !== r.antes[tabela]) throw Object.assign(Error('PRESERVACAO_S3'), {parada:'S3', tabela});
        r.aprovado = true; salvar();
    } catch (e) {
        erro = e ?? Error('FALHA_DESCONHECIDA');
        r.falha = {etapa, parada:e?.parada ?? null, item:e?.item ?? e?.tabela ?? null, obtido:e?.obtido ?? null, esperado:e?.esperado ?? null,
            mensagem:String(e?.message ?? e).slice(0, 120)};
        try { salvar(); } catch { /* o encerramento roda mesmo sem gravar o estado */ }
        console.error(JSON.stringify(r.falha));
    } finally {
        // ---- Encerramento: SEMPRE; libera só vagas da rodada com remoção comprovada no Asaas.
        erro = erroFinal(erro, await encerrar({db, conectado, r, p, obterCobranca, salvar}));
        if (conectado) {
            r.campanhaDepois = await campanha(db).catch(() => null);
            r.depoisEncerramento = await preservacao().catch(() => null); // terceiros continuam idênticos
            if (r.depoisEncerramento && r.antes && PRESERVADAS.some(([t]) => r.depoisEncerramento[t] !== r.antes[t]))
                erro = erroFinal(erro, Object.assign(Error('PRESERVACAO_APOS_ENCERRAMENTO'), {parada:'S3'}));
        }
        await db.end().catch(() => {});
    }
    if (!erro && r.campanhaDepois?.ocupadas !== r.campanhaAntes?.ocupadas) erro = Error('CAMPANHA_NAO_RESTAURADA');
    r.concluido = !erro; try { salvar(); } catch { /* idem */ }
    console.log(JSON.stringify({resultado:erro ? 'INCOMPLETO' : 'PASS', falha:r.falha ?? null, erro:erro ? String(erro.message).slice(0, 80) : null,
        resultados:r.resultados, campanhaAntes:r.campanhaAntes ?? null, campanhaReservada:r.campanhaReservada ?? null, campanhaDepois:r.campanhaDepois ?? null,
        encerramento:r.encerramento ?? null, falhasEncerramento:r.falhasEncerramento ?? []}));
    if (erro) process.exitCode = 2;
}

if (require.main === module) {
    const m = modo(process.argv.slice(2));
    if (m === 'RODADA') main().catch(e => { console.error('HOMOLOGACAO_RECUSADA_ANTES_DAS_MUTACOES ' + String(e?.message ?? '').slice(0, 60)); process.exitCode = 1; });
    else if (m === 'ENCERRAR') recuperar().catch(e => { console.error(String(e?.message ?? 'RECUPERACAO_RECUSADA').slice(0, 80)); process.exitCode = 1; });
    else { console.error('AGUARDANDO_AUTORIZACAO_FUNDADOR'); process.exitCode = 1; }
}
module.exports = {FIXTURES, PRECOS, PRESERVADAS, MARCA, FLAG, FLAG_ENCERRAR, ARQUIVO, MOTIVO, VAGAS_CAMPANHA, alvo, alvoEncerramento, modo,
    cabeNaCampanha, recursosComprovados, cancelamentoComprovado, encerrar, conferir};
