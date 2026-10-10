/* eslint-disable @typescript-eslint/no-require-imports */
// Homologação preparada em 10/10/2026 (docs/HOMOLOGACAO_PLANOS_COTACAO_STAGING_20261010.md). Executar SOMENTE no
// Web Shell do srv-daif418ae00c73e8k2gg, depois da aprovação explícita de O3, com a flag única --rodada-1-autorizada.
// Escreve só nas quatro fixtures abaixo; nunca apaga linha; encerra (desativa) no finally.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createHash, randomBytes, randomUUID} = require('node:crypto');
const {alvo: alvoEnsaio, documento, cookies, prepararWebhook} = require('./assinatura-staging-ensaio.cjs');

const BASE = 'https://kidmais-manager-staging.onrender.com';
const DIR = '/opt/render/project/src/data/homologacao-planos-cotacao-20261010';
const FLAG = '--rodada-1-autorizada';
const KIDMAIS_CNPJ = '20119900000160';
const FIXTURES = Object.freeze([
    {chave:'F1', empresa:'878a2c39-19e5-4d2a-82a7-223b893352c9', usuario:'11e5006f-68d0-4182-9b12-da048b3f7db8', codigo:'hml-planos-essencial', tipo:'PLANO', plano:'essencial', catalogo:true},
    {chave:'F2', empresa:'d1787a4c-aaeb-4eb6-99a1-9659feb3902f', usuario:'4aa233ad-6c4f-41bb-ae7f-62996c1b5018', codigo:'hml-planos-profissional', tipo:'PLANO', plano:'profissional', catalogo:true},
    {chave:'F3', empresa:'6dfd58f1-91fa-4202-9ace-72d705390272', usuario:'7ff5a408-d1da-4813-99a9-0ebd1cf7511e', codigo:'hml-planos-isenta', tipo:'ISENTA', plano:null, catalogo:false},
    {chave:'F4', empresa:'092c5201-91c1-446e-90e8-cea19831e749', usuario:'9029758e-317b-4c4e-95c6-685ac990a956', codigo:'hml-planos-teste', tipo:'TESTE', plano:null, catalogo:true},
].map(f => Object.freeze({...f, email:`hml-planos-${f.usuario.slice(0,8)}@example.invalid`,
    nome:`TESTE Kidmais — planos/cotação staging 20261010 ${f.chave}`})));
const IDS_EMPRESAS = FIXTURES.map(f => f.empresa);

/** Tabelas comparadas antes/depois, sempre SEM as fixtures. Colunas voláteis do cron ficam fora (como no ensaio de 09/10). */
const PRESERVADAS = Object.freeze([
    ['empresas', 'id', []], ['memberships', 'empresa_id', []],
    ['empresa_assinaturas', 'empresa_id', ['sincronizado_em','atualizado_em','versao']],
    ['assinatura_contratacoes', 'empresa_id', []], ['assinatura_fundadores', 'empresa_id', []], ['assinatura_isencoes', 'empresa_id', []],
    ['clientes', 'empresa_id', []], ['fechamentos', 'empresa_id', []], ['pacotes', 'empresa_id', []],
    ['financeiro_categorias', 'empresa_id', []], ['financeiro_contas_pagar', 'empresa_id', []],
]);
function sqlPreservacao(tabela, coluna, volateis) {
    assert.ok(/^[a-z_]+$/.test(tabela) && /^[a-z_]+$/.test(coluna) && volateis.every(v => /^[a-z_]+$/.test(v)));
    const linha = volateis.length ? `to_jsonb(t) - ARRAY[${volateis.map(v => `'${v}'`).join(',')}]::text[]` : 'to_jsonb(t)';
    return `SELECT (${linha})::text AS linha FROM public.${tabela} t WHERE coalesce(t.${coluna}::text,'') <> ALL($1::text[]) ORDER BY 1`;
}

/** Guardas do ensaio de 09/10 + chave da cotação ligada (O2). Qualquer divergência encerra antes de escrever. */
function alvo(env) {
    const opcoes = alvoEnsaio(env);
    assert.equal(env.COTACAO_PUBLICA_POR_EMPRESA, 'true', 'CHAVE_COTACAO_AUSENTE');
    return opcoes;
}
function autorizado(argv) {
    return argv.filter(a => a.startsWith('--')).length === 1 && argv.includes(FLAG);
}

// Matriz de aceite (O4). `null` = qualquer status diferente de 403 RECURSO_FORA_DO_PLANO e < 500.
const FINANCEIRO = Object.freeze({
    F1: {contasPagar:403, criarConta:403, fluxo:403, relatorios:403, completo:false, receber:200},
    F2: {contasPagar:200, criarConta:200, fluxo:200, relatorios:200, completo:true, receber:200},
    F3: {contasPagar:200, criarConta:200, fluxo:200, relatorios:200, completo:true, receber:200},
    F4: {contasPagar:200, criarConta:200, fluxo:200, relatorios:200, completo:true, receber:200},
});
function conferir(nome, obtido, esperado) {
    if (obtido !== esperado) throw Object.assign(Error('MATRIZ_DIVERGENTE'), {parada:'S2', item:nome, obtido, esperado});
}
/** Endereço atual da Kidmais: compara só o que o cliente vê (datas, períodos, horários e status), sem carimbos de tempo. */
function projecaoAgenda(j) {
    const dias = Array.isArray(j?.data) ? j.data : [j?.data];
    return {comercial:j?.comercial ?? null, dias:dias.map(d => ({data:d?.data, periodos:(d?.periodos ?? []).map(p => ({codigo:p.codigo,
        horarios:(p.horarios ?? []).map(h => ({inicio:h.inicio, fim:h.fim, ajuste:h.ajusteMinutos, status:h.status}))}))}))};
}
function hashProjecao(valor) {
    return createHash('sha256').update(JSON.stringify(valor ?? null)).digest('hex');
}
function cpfSintetico() {
    for (;;) {
        const n = Array.from(randomBytes(9), b => b % 10);
        if (new Set(n).size === 1) continue;
        for (const len of [9, 10]) { const s = n.slice(0, len).reduce((t, d, i) => t + d * (len + 1 - i), 0); const r = (s * 10) % 11; n.push(r === 10 ? 0 : r); }
        return n.join('');
    }
}

async function main() {
    const opts = alvo(process.env);
    const {Client} = require('pg');
    const {configuracaoAsaas, criarClienteAsaas} = await import('../lib/assinatura/asaas.ts');
    const {criarHashSenha} = await import('../lib/autenticacao/senha.ts');
    const precos = await import('../lib/comercial/pacote-precos.ts');
    const pacotesAdmin = await import('../lib/comercial/pacotes-admin.ts');
    const cfg = configuracaoAsaas(); assert.ok(cfg.ligado, 'ASAAS_DESLIGADO'); const p = criarClienteAsaas(cfg.config);
    fs.mkdirSync(DIR, {recursive:true, mode:0o700});
    const arquivo = DIR + '/rodada.json';
    assert.ok(!fs.existsSync(arquivo), 'RODADA_EXISTENTE_S1');
    const r = {empresa:'homologacao-planos-cotacao-20261010', inicio:new Date().toISOString(), etapas:[], resultados:{}};
    const salvar = () => fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600}); salvar();
    const db = new Client(opts); let conectado = false, erro, etapa = 'PRECHECK';
    const tx = {query: async (t, v) => { const x = await db.query(t, v); return {rows:x.rows, rowCount:x.rowCount}; }};
    const marcar = e => { etapa = e; r.etapas.push(e); salvar(); };
    const senhas = new Map(FIXTURES.map(f => [f.chave, 'Sintetica-' + randomBytes(24).toString('hex')])); // só em memória
    const api = async (caminho, method = 'GET', body) => {
        assert.ok(/^\/(webhooks|sandbox\/payment)(\/|\?|$)/.test(caminho));
        const res = await fetch('https://api-sandbox.asaas.com/v3' + caminho, {method, redirect:'error', signal:AbortSignal.timeout(15000),
            headers:{access_token:cfg.config.apiKey, 'User-Agent':'kidmais-staging-homologacao', 'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
        if (res.status === 404 && method === 'GET') return null;
        if (!res.ok) throw Object.assign(Error('ASAAS_HTTP'), {status:res.status}); return res.json();
    };
    // Sessão administrativa de uma fixture; cookies e CSRF só em memória.
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
    const publico = async (caminho, method = 'GET', body) => {
        assert.ok(caminho.startsWith('/api/fechamentos') || caminho.startsWith('/api/disponibilidade') || caminho.startsWith('/b/'));
        const res = await fetch(BASE + caminho, {method, redirect:'manual', signal:AbortSignal.timeout(60000),
            headers:{'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
        const texto = await res.text(); let j = null; try { j = JSON.parse(texto); } catch { /* página HTML */ }
        return {status:res.status, j, hash:createHash('sha256').update(texto).digest('hex')};
    };
    const preservacao = async () => {
        const hashes = {};
        for (const [tabela, coluna, volateis] of PRESERVADAS) {
            const linhas = (await db.query(sqlPreservacao(tabela, coluna, volateis), [IDS_EMPRESAS])).rows.map(x => x.linha);
            hashes[tabela] = createHash('sha256').update(JSON.stringify(linhas)).digest('hex'); // hash só em memória/arquivo, nunca linhas
        }
        return hashes;
    };
    const proximoMes = () => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1, 1); const i = d.toISOString().slice(0, 10);
        d.setUTCMonth(d.getUTCMonth() + 1, 0); return `inicio=${i}&fim=${d.toISOString().slice(0, 10)}`; };
    const kidmaisPublico = async () => {
        const pacotes = await publico('/api/fechamentos/pacotes'), agenda = await publico('/api/disponibilidade?' + proximoMes());
        assert.equal(pacotes.status, 200, 'KIDMAIS_PACOTES'); assert.equal(agenda.status, 200, 'KIDMAIS_AGENDA');
        return {pacotes:hashProjecao(pacotes.j), agenda:hashProjecao(projecaoAgenda(agenda.j))};
    };
    try {
        // ---- S1: alvo, identidade do banco, TLS, schema e fixtures livres.
        await db.connect(); conectado = true; await db.query("SET statement_timeout='15s'");
        const id = (await db.query("SELECT current_database() AS db, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls")).rows[0];
        assert.equal(id.db, 'kidmais_staging_1z91', 'BANCO_S1'); assert.equal(id.tls, true, 'TLS_S1');
        const schema = (await db.query(`SELECT to_regclass('public.assinatura_isencoes') IS NOT NULL AND to_regclass('public.financeiro_categorias') IS NOT NULL
            AND to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NOT NULL AS ok`)).rows[0];
        assert.equal(schema.ok, true, 'SCHEMA_S1');
        const ocupado = (await db.query(`SELECT EXISTS(SELECT 1 FROM empresas WHERE id=ANY($1::uuid[]) OR codigo=ANY($2::text[]))
            OR EXISTS(SELECT 1 FROM usuarios_administrativos WHERE id=ANY($3::uuid[]) OR email=ANY($4::text[])) AS ocupado`,
            [IDS_EMPRESAS, FIXTURES.map(f => f.codigo), FIXTURES.map(f => f.usuario), FIXTURES.map(f => f.email)])).rows[0];
        assert.equal(ocupado.ocupado, false, 'FIXTURE_PREEXISTENTE_S1');
        for (const f of FIXTURES.filter(x => x.tipo === 'PLANO')) assert.equal(await p.buscarClientePorReferencia(f.empresa), null, 'CLIENTE_ASAAS_PREEXISTENTE_S1');
        r.antes = await preservacao(); r.kidmaisAntes = await kidmaisPublico(); salvar();

        // ---- Fixtures (uma transação). Nenhuma linha de outra empresa é tocada.
        marcar('FIXTURES'); await db.query('BEGIN');
        for (const f of FIXTURES) {
            const doc = documento(); assert.notEqual(doc, KIDMAIS_CNPJ);
            await db.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,$3,'PROVISIONAMENTO')", [f.empresa, f.codigo, f.nome]);
            await db.query("UPDATE empresas SET status='ATIVA' WHERE id=$1", [f.empresa]);
            await db.query("INSERT INTO usuarios_administrativos(id,email,nome,senha_hash,papel,ativo) VALUES($1,$2,'Gestão Sintética Homologação',$3,'REPRESENTANTE_AUTORIZADO',true)",
                [f.usuario, f.email, await criarHashSenha(senhas.get(f.chave))]);
            await db.query("UPDATE usuarios_administrativos SET senha_alterada_em=clock_timestamp()-interval '1 hour' WHERE id=$1", [f.usuario]);
            await db.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())", [f.empresa, f.usuario]);
            await db.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2", [f.empresa, f.usuario]);
            await db.query("INSERT INTO financeiro_categorias(empresa_id,tipo,nome) VALUES($1,'DESPESA','Homologação')", [f.empresa]);
            if (f.tipo === 'PLANO')
                await db.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste) VALUES($1,'TESTE',clock_timestamp()-interval '16 days',clock_timestamp()-interval '1 hour',$2)", [f.empresa, doc]);
            if (f.tipo === 'TESTE')
                await db.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste) VALUES($1,'TESTE',clock_timestamp(),clock_timestamp()+interval '15 days',$2)", [f.empresa, doc]);
            if (f.tipo === 'ISENTA')
                await db.query("INSERT INTO assinatura_isencoes(empresa_id,documento_verificado,motivo,concedida_por) VALUES($1,$2,'Homologação sintética staging 20261010',$3)", [f.empresa, doc, f.usuario]);
        }
        await db.query('COMMIT'); r.fixture = true; salvar();

        // ---- Catálogo mínimo pelos serviços de domínio (padrão de scripts/adicionais-ui.cjs).
        marcar('CATALOGO');
        const horarios = (await db.query('SELECT id::text AS id FROM configuracao_agenda WHERE ativo')).rows.map(x => x.id);
        assert.ok(horarios.length > 0, 'AGENDA_SEM_HORARIOS');
        for (const f of FIXTURES.filter(x => x.catalogo)) {
            const ctx = () => ({empresaId:f.empresa, usuarioId:f.usuario, requestId:randomUUID(), motivo:'PACOTE_EDITADO'});
            const pacote = (await db.query(`INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
                VALUES ($1, 'POCKET', 'Pocket homologação', 1, true, true, 20, 30) RETURNING id`, [f.empresa])).rows[0].id;
            await db.query('BEGIN'); await precos.gravarFaixasPacote(tx, f.empresa, pacote, [{convidadosMin:20, convidadosMax:30, valor:'1500.00'}], {minimo:20, maximo:30}, ctx()); await db.query('COMMIT');
            await db.query('BEGIN'); await pacotesAdmin.definirDisponibilidadePacoteAdmin(tx, pacote, {disponibilidade:[1,2,3,4,5,6,7].flatMap(dia => horarios.map(horarioId => ({dia, horarioId})))}, ctx()); await db.query('COMMIT');
        }
        r.catalogo = true; salvar();

        // ---- Sessões e contratos pagos no sandbox (F1 Essencial, F2 Profissional). Fundador nunca é consumido (S4).
        const s = Object.fromEntries(FIXTURES.map(f => [f.chave, sessao(f)]));
        for (const f of FIXTURES) await s[f.chave].entrar();
        marcar('WEBHOOK'); await prepararWebhook(api, cfg.config, r, salvar);
        for (const f of FIXTURES.filter(x => x.tipo === 'PLANO')) {
            marcar('CHECKOUT_' + f.chave);
            const antes = (await s[f.chave].pedir('/api/admin/assinatura')).j.data;
            assert.equal(antes.ofertas.habilitado, true);
            if (antes.ofertas.fundador || antes.ofertas.aguardandoVaga) throw Object.assign(Error('FUNDADOR_S4'), {parada:'S4'});
            const oferta = antes.ofertas.planos.find(x => x.id === f.plano); assert.ok(oferta);
            r[f.chave] = {intencaoCheckout:true, valor:oferta.mensal}; salvar();
            const ck = await s[f.chave].post('/api/admin/assinatura/checkout', {plano:f.plano, ciclo:'MENSAL', valorEsperadoCentavos:oferta.mensal, versao:antes.ofertas.versao});
            assert.equal(ck.status, 200, 'CHECKOUT_' + f.chave);
            const linha = (await db.query('SELECT provedor_cliente_id,provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id=$1', [f.empresa])).rows[0];
            Object.assign(r[f.chave], {clienteId:linha.provedor_cliente_id, assinaturaId:linha.provedor_assinatura_id}); salvar();
            const pagamento = (await p.listarCobrancasDaAssinatura(r[f.chave].assinaturaId)).filter(x => !x.deleted).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
            assert.ok(pagamento && pagamento.valorCentavos === oferta.mensal && pagamento.assinaturaId === r[f.chave].assinaturaId, 'PAGAMENTO_S4');
            r[f.chave].pagamentoId = pagamento.id; salvar();
            await api('/sandbox/payment/' + encodeURIComponent(pagamento.id) + '/confirm', 'POST');
            for (let i = 0; ; i++) {
                const ev = (await db.query("SELECT 1 FROM cobranca_eventos WHERE empresa_id=$1 AND tipo IN ('PAYMENT_RECEIVED','PAYMENT_CONFIRMED') AND situacao='PROCESSADO'", [f.empresa])).rowCount;
                if (ev) break; if (i >= 180) throw Object.assign(Error('CALLBACK_S4'), {parada:'S4'}); await new Promise(ok => setTimeout(ok, 1000));
            }
            const depois = (await s[f.chave].pedir('/api/admin/assinatura')).j.data;
            conferir(f.chave + '.acesso', depois.acesso.nivel, 'COMPLETO'); conferir(f.chave + '.plano', depois.vagas?.plano, f.plano);
        }

        // ---- Matriz do financeiro (O4).
        marcar('MATRIZ_FINANCEIRO');
        for (const f of FIXTURES) {
            const e = FINANCEIRO[f.chave], x = s[f.chave], res = r.resultados[f.chave] = {};
            const categoria = (await db.query("SELECT id::text FROM financeiro_categorias WHERE empresa_id=$1 AND nome='Homologação'", [f.empresa])).rows[0].id;
            res.contasPagar = (await x.pedir('/api/admin/financeiro/contas-pagar')).status; conferir(f.chave + '.contasPagar', res.contasPagar, e.contasPagar);
            const criar = await x.post('/api/admin/financeiro/contas-pagar', {acao:'criar', descricao:'Conta sintética homologação', categoriaId:categoria, valor:10,
                vencimento:new Date(Date.now() + 864e5 * 10).toISOString().slice(0, 10), chave:'hml-' + randomUUID()});
            res.criarConta = criar.status; conferir(f.chave + '.criarConta', res.criarConta, e.criarConta);
            if (e.criarConta === 403) conferir(f.chave + '.codigo', criar.j.codigo, 'RECURSO_FORA_DO_PLANO');
            const contas = (await db.query('SELECT count(*)::int n FROM financeiro_contas_pagar WHERE empresa_id=$1', [f.empresa])).rows[0].n;
            conferir(f.chave + '.contasGravadas', contas, e.criarConta === 200 ? 1 : 0);
            res.fluxo = (await x.pedir('/api/admin/financeiro/fluxo-caixa?' + proximoMes())).status; conferir(f.chave + '.fluxo', res.fluxo, e.fluxo);
            res.relatorios = (await x.pedir('/api/admin/financeiro/relatorios?' + proximoMes())).status; conferir(f.chave + '.relatorios', res.relatorios, e.relatorios);
            const visao = await x.pedir('/api/admin/financeiro'); conferir(f.chave + '.visao', visao.j.data?.financeiroCompleto, e.completo);
            const painel = await x.pedir('/api/admin/dashboard'); conferir(f.chave + '.dashboard', painel.j.data?.financeiroCompleto, e.completo);
            res.receber = (await x.pedir('/api/admin/financeiro/contas-receber')).status; conferir(f.chave + '.receber', res.receber, e.receber);
            const auth = await x.pedir('/api/admin/autenticacao'); conferir(f.chave + '.menu', auth.j.data?.recursos?.financeiroCompleto, e.completo);
            salvar();
        }
        const cruzado = await s.F1.pedir('/api/admin/financeiro/contas-pagar?empresaId=' + FIXTURES[1].empresa);
        r.resultados.cruzado = cruzado.status; if (cruzado.status === 200 || JSON.stringify(cruzado.j).includes('Conta sintética')) throw Object.assign(Error('CRUZADO_S2'), {parada:'S2'});

        // ---- Matriz da cotação (O4). Sem sessão; tudo pelo endereço público.
        marcar('MATRIZ_COTACAO');
        const q = c => '?empresa=' + c, F2 = FIXTURES[1], F4 = FIXTURES[3], c = r.resultados.cotacao = {};
        for (const [nome, caminho, esperado] of [
            ['paginaF2', '/b/' + F2.codigo + '/fechamento', 200], ['agendaPaginaF2', '/b/' + F2.codigo + '/disponibilidade', 200],
            ['pacotesF2', '/api/fechamentos/pacotes' + q(F2.codigo), 200], ['pacotesF4', '/api/fechamentos/pacotes' + q(F4.codigo), 200],
            ['essencial', '/api/fechamentos/pacotes' + q(FIXTURES[0].codigo), 404], ['inexistente', '/api/fechamentos/pacotes' + q('hml-inexistente'), 404],
            ['formatoRuim', '/api/fechamentos/pacotes?empresa=HML_RUIM', 404], ['pdf', '/api/fechamentos/tabela-pacotes' + q(F2.codigo), 404],
            ['paginaEssencial', '/b/' + FIXTURES[0].codigo + '/fechamento', 404]]) {
            const resp = await publico(caminho); c[nome] = resp.status; conferir('cotacao.' + nome, resp.status, esperado);
            if (esperado === 404 && resp.j) conferir('cotacao.' + nome + '.codigo', resp.j.codigo ?? 'PDF', nome === 'pdf' ? 'PDF' : 'COTACAO_PUBLICA_INDISPONIVEL');
        }
        const pacotesF2 = (await publico('/api/fechamentos/pacotes' + q(F2.codigo))).j.pacotes;
        conferir('cotacao.pacotesF2.lista', JSON.stringify(pacotesF2.map(x => x.codigo)), '["POCKET"]');
        const agenda = (await publico('/api/disponibilidade?' + proximoMes() + '&empresa=' + F2.codigo)).j;
        conferir('cotacao.agenda.comercial', JSON.stringify(agenda.comercial), '{"pacoteOverrides":[],"descontos":[]}');
        let horario = null;
        for (const dia of agenda.data) for (const per of dia.periodos ?? []) for (const h of per.horarios ?? [])
            if (!horario && h.status === 'DISPONIVEL' && h.ajusteMinutos === 0) horario = {data:dia.data, base:per.codigo === 'TURNO_1' ? 'almoco' : 'noite', inicio:h.inicio, fim:h.fim};
        assert.ok(horario, 'SEM_HORARIO_DISPONIVEL');
        const cotacao = await publico('/api/fechamentos/cotacao' + q(F2.codigo), 'POST', {pacote:'pocket', dataFesta:horario.data, horarioBase:horario.base, ajusteHorario:'0',
            horarioInicio:horario.inicio, horarioFim:horario.fim, convidados:20});
        conferir('cotacao.valor', cotacao.status, 200);
        const cpf = cpfSintetico();
        const pedido = (codigo, extra = {}) => publico('/api/fechamentos' + q(codigo), 'POST', {identidadeTipo:'NOVO_CLIENTE', dataFesta:horario.data, horarioBase:horario.base,
            ajusteHorario:'0', horarioInicio:horario.inicio, horarioFim:horario.fim, statusDisponibilidade:'disponivel', pacote:'pocket', convidadosPagantes:20,
            buffetDefinicao:'depois', adicionaisSelecionados:[], valorCombinado:String(cotacao.j.data.valor), formaPagamento:'pix_avista',
            nomeCliente:'Cliente Sintético Homologação', cpf, email:'cliente-hml-' + randomBytes(4).toString('hex') + '@example.invalid', whatsapp:'11900000000',
            cep:'01001000', logradouro:'Rua Sintética', numero:'1', bairro:'Centro', cidade:'São Paulo', uf:'SP',
            nomeAniversariante:'Aniversariante Sintético', idadeAniversariante:5, observacoesCliente:'Pedido sintético de homologação 20261010', ...extra});
        const p1 = await pedido(F2.codigo); c.pedidoF2 = p1.status; conferir('cotacao.pedidoF2', p1.status, 201);
        conferir('cotacao.pedidoF2.semCrm', p1.j.crm, undefined);
        conferir('cotacao.pedidoF2.empresa', (await db.query('SELECT empresa_id::text e FROM fechamentos WHERE id=$1', [p1.j.fechamentoId])).rows[0]?.e, F2.empresa);
        // Mesmo CPF em outra empresa (F4): mesma resposta pública; cadastro novo sem CPF.
        const p2 = await pedido(F4.codigo); c.pedidoF4MesmoCpf = p2.status; conferir('cotacao.pedidoF4', p2.status, 201);
        conferir('cotacao.pedidoF4.chaves', JSON.stringify(Object.keys(p2.j).sort()), JSON.stringify(Object.keys(p1.j).sort()));
        const cli = (await db.query('SELECT c.empresa_id::text e, c.cpf FROM fechamentos f JOIN clientes c ON c.id=f.cliente_id WHERE f.id=$1', [p2.j.fechamentoId])).rows[0];
        conferir('cotacao.pedidoF4.empresa', cli.e, F4.empresa); conferir('cotacao.pedidoF4.cpfOmitido', cli.cpf, null);
        const p3 = await pedido(F2.codigo, {identidadeTipo:'CLIENTE_EXISTENTE', provaIdentidade:'p'.repeat(40)});
        c.clienteExistente = p3.status; conferir('cotacao.clienteExistente', p3.j.codigo, 'IDENTIDADE_NAO_DISPONIVEL');

        // ---- Endereço atual da Kidmais e demais empresas inalterados (S3).
        marcar('PRESERVACAO');
        r.kidmaisDepois = await kidmaisPublico();
        conferir('kidmais.pacotes', r.kidmaisDepois.pacotes, r.kidmaisAntes.pacotes); conferir('kidmais.agenda', r.kidmaisDepois.agenda, r.kidmaisAntes.agenda);
        r.depois = await preservacao();
        for (const [tabela] of PRESERVADAS) if (r.depois[tabela] !== r.antes[tabela]) throw Object.assign(Error('PRESERVACAO_S3'), {parada:'S3', tabela});
        r.aprovado = true; salvar();
    } catch (e) {
        erro = e; r.falha = {etapa, parada:e.parada ?? null, item:e.item ?? e.tabela ?? null, http:e.status ?? null, mensagem:String(e.message).slice(0, 120)}; salvar();
        console.error(JSON.stringify(r.falha));
    } finally {
        // ---- Encerramento (O5): assinaturas sandbox, webhook só se criado pela rodada, fixtures desativadas.
        if (conectado) await db.query('ROLLBACK').catch(() => {});
        for (const f of FIXTURES.filter(x => x.tipo === 'PLANO')) {
            try { if (r[f.chave]?.intencaoCheckout) { const subs = await p.listarAssinaturasPorReferencia(f.empresa); assert.ok(subs.length <= 1, 'SUB_DUPLICADA');
                for (const sub of subs) { assert.equal(sub.externalReference, f.empresa); if (!sub.deleted) assert.equal((await p.removerAssinatura(sub.id)).removida, true); }
                r[f.chave].cancelada = true; salvar(); } }
            catch { r.limpezaAssinaturaPendente = true; erro ??= Error('LIMPEZA_ASSINATURA'); salvar(); }
        }
        try { if (r.intencaoWebhook && r.webhookId) { const w = await api('/webhooks/' + encodeURIComponent(r.webhookId));
                if (w) { assert.equal(w.name, r.webhookNome); await api('/webhooks/' + encodeURIComponent(r.webhookId), 'DELETE'); } }
            r.webhookEncerrado = true; salvar(); }
        catch { r.limpezaWebhookPendente = true; erro ??= Error('LIMPEZA_WEBHOOK'); salvar(); }
        try { if (conectado && r.fixture) { await db.query('BEGIN');
                await db.query('UPDATE usuarios_administrativos SET ativo=false WHERE id=ANY($1::uuid[])', [FIXTURES.map(f => f.usuario)]);
                await db.query("UPDATE memberships SET status='REVOGADA' WHERE empresa_id=ANY($1::uuid[]) AND usuario_id=ANY($2::uuid[]) AND status<>'REVOGADA'", [IDS_EMPRESAS, FIXTURES.map(f => f.usuario)]);
                await db.query("UPDATE empresas SET status='DESATIVADA' WHERE id=ANY($1::uuid[]) AND status<>'DESATIVADA'", [IDS_EMPRESAS]);
                await db.query('COMMIT'); r.fixturesDesativadas = true; salvar(); } }
        catch { await db.query('ROLLBACK').catch(() => {}); r.limpezaBancoPendente = true; erro ??= Error('LIMPEZA_BANCO'); salvar(); }
        await db.end().catch(() => {});
    }
    r.concluido = !erro; salvar();
    console.log(JSON.stringify({resultado:erro ? 'INCOMPLETO' : 'PASS', falha:r.falha ?? null, resultados:r.resultados,
        fixturesDesativadas:r.fixturesDesativadas ?? false, assinaturasCanceladas:FIXTURES.filter(f => r[f.chave]?.cancelada).map(f => f.chave),
        webhookEncerrado:r.webhookEncerrado ?? false}));
    if (erro) process.exitCode = 2;
}

if (require.main === module) {
    if (!autorizado(process.argv.slice(2))) { console.error('AGUARDANDO_AUTORIZACAO_O3'); process.exitCode = 1; }
    else main().catch(() => { console.error('HOMOLOGACAO_RECUSADA_ANTES_DAS_MUTACOES'); process.exitCode = 1; });
}
module.exports = {FIXTURES, PRESERVADAS, FINANCEIRO, sqlPreservacao, alvo, autorizado, conferir, cpfSintetico, projecaoAgenda, BASE, DIR, FLAG};
