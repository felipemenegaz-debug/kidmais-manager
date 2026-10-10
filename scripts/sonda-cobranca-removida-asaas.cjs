/* eslint-disable @typescript-eslint/no-require-imports */
// Sonda isolada no Asaas SANDBOX (docs/SONDA_COBRANCA_REMOVIDA_ASAAS_20261010.md): como o provedor devolve a cobrança
// de uma assinatura removida. Sem banco, sem pagamento, sem empresa e sem vaga Fundador. Executar SOMENTE no Web Shell
// do srv-daif418ae00c73e8k2gg (única origem da chave sandbox), depois de aprovação, com a flag única abaixo.
// Cria: 1 cliente sintético (referência única, notificações desligadas) e 1 assinatura de R$ 5,00. Remove ambos no finally.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const {randomUUID} = require('node:crypto');
const {documento} = require('./assinatura-staging-ensaio.cjs');
const {exigirDisco} = require('./conexao-staging.cjs');
const {cancelamentoComprovado, pagamentoConhecido} = require('./homologacao-fundador-staging.cjs');
const {processoVivo} = require('./homologacao-planos-cotacao-staging.cjs');

const DIR = '/opt/render/project/src/data/homologacao-planos-cotacao-20261010';
const ARQUIVO = DIR + '/sonda-cobranca-removida.json';
const FLAG = '--sonda-cobranca-removida-autorizada';
const FLAG_ENCERRAR = '--encerrar-sonda-cobranca-removida-autorizada';
const SANDBOX = 'https://api-sandbox.asaas.com/v3';
const PREFIXO_REF = 'hml-sonda-cobranca-20261010-';
const VALOR_CENTAVOS = 500;

/** Só o web staging com Asaas sandbox. A sonda não abre conexão com banco algum. */
function alvo(env) {
    assert.equal(env.RENDER, 'true'); assert.equal(env.RENDER_SERVICE_ID, 'srv-daif418ae00c73e8k2gg');
    assert.equal(env.KIDMAIS_DEPLOY_ENV, 'staging'); assert.equal(env.ASAAS_AMBIENTE, 'sandbox');
}
function modo(argv) {
    const flags = argv.filter(a => a.startsWith('--'));
    if (flags.length !== 1) return null;
    return flags[0] === FLAG ? 'SONDA' : flags[0] === FLAG_ENCERRAR ? 'ENCERRAR' : null;
}
/** Leituras permitidas (só GET, só recursos desta sonda). */
function caminhoLeitura(tipo, v) {
    const id = x => { assert.match(String(x), /^[A-Za-z0-9_-]{1,100}$/); return encodeURIComponent(x); };
    const ref = x => { assert.ok(String(x).startsWith(PREFIXO_REF)); return encodeURIComponent(x); };
    return {cobranca:() => `/payments/${id(v)}`, assinatura:() => `/subscriptions/${id(v)}`, cobrancasDaAssinatura:() => `/subscriptions/${id(v)}/payments`,
        porAssinatura:() => `/payments?subscription=${id(v)}`, porCliente:() => `/payments?customer=${id(v)}`, porReferencia:() => `/payments?externalReference=${ref(v)}`,
        clientesPorReferencia:() => `/customers?externalReference=${ref(v)}`}[tipo]();
}
/** Forma mínima de uma cobrança (sem valores pessoais): o que a regra do executor usa. */
function forma(c) {
    return c && typeof c === 'object' ? {id:typeof c.id === 'string' ? c.id : null, deleted:c.deleted === true, status:typeof c.status === 'string' ? c.status : 'DESCONHECIDO',
        paymentDate:typeof c.paymentDate === 'string' ? c.paymentDate : null, valorCentavos:typeof c.value === 'number' ? Math.round(c.value * 100) : null} : null;
}
/**
 * Classificação pela MESMA regra do executor Fundador: REGRA_ATENDIDA quando a releitura direta de cada cobrança prova a
 * remoção (deleted=true, PENDING/OVERDUE, sem pagamento); COBRANCA_404 quando a leitura direta responde 404; OUTRO caso contrário.
 */
function classificar({assinaturaRelida, cobrancasRelidas}) {
    if (!Array.isArray(cobrancasRelidas) || cobrancasRelidas.length === 0) return 'OUTRO';
    if (cobrancasRelidas.some(c => c.http === 404)) return 'COBRANCA_404';
    const prova = cancelamentoComprovado({completo:true, assinaturas:[assinaturaRelida.http === 404 ? null : forma(assinaturaRelida.corpo)],
        cobrancas:cobrancasRelidas.map(c => c.http === 200 ? forma(c.corpo) : null)});
    return prova ? 'REGRA_ATENDIDA' : 'OUTRO';
}

async function provedor() {
    const {configuracaoAsaas, criarClienteAsaas, ASAAS_SANDBOX_URL} = await import('../lib/assinatura/asaas.ts');
    const cfg = configuracaoAsaas(); assert.ok(cfg.ligado, 'ASAAS_DESLIGADO');
    assert.equal(cfg.config.ambiente, 'sandbox'); assert.equal(cfg.config.baseUrl, SANDBOX); assert.equal(ASAAS_SANDBOX_URL, SANDBOX);
    const chamar = async (method, caminho) => {
        const res = await fetch(SANDBOX + caminho, {method, redirect:'error', signal:AbortSignal.timeout(15000),
            headers:{access_token:cfg.config.apiKey, 'User-Agent':'kidmais-staging-sonda'}});
        return {http:res.status, corpo:await res.json().catch(() => null)};
    };
    const ler = (tipo, v) => chamar('GET', caminhoLeitura(tipo, v));
    const removerCliente = id => { assert.match(String(id), /^cus_[A-Za-z0-9]{1,60}$/); return chamar('DELETE', `/customers/${encodeURIComponent(id)}`); };
    /** Todos os clientes da referência (não só o primeiro), para detectar colisão. Falha de leitura lança. */
    const clientesPorReferencia = async ref => {
        const l = await ler('clientesPorReferencia', ref);
        assert.ok(l.http === 200 && Array.isArray(l.corpo?.data), 'LEITURA_CLIENTES');
        return l.corpo.data.map(c => ({id:String(c.id), externalReference:c.externalReference ?? null, deleted:c.deleted === true}));
    };
    return {p:criarClienteAsaas(cfg.config), ler, removerCliente, clientesPorReferencia};
}

/** Lista (só formas) de uma leitura paginada do Asaas. */
const resumoLista = l => ({http:l.http, total:Array.isArray(l.corpo?.data) ? l.corpo.data.length : null,
    itens:Array.isArray(l.corpo?.data) ? l.corpo.data.map(forma) : null});

/**
 * Prova de autoria gravada ANTES de qualquer criação: referência única da sonda, provada livre no Asaas (sem cliente e
 * sem assinatura) e intenção de criar o cliente registrada. Sem ela, a limpeza não toca em nada.
 */
function provaDeAutoria(r) {
    return typeof r?.referencia === 'string' && r.referencia.startsWith(PREFIXO_REF) && r.precheck?.referenciaLivre === true
        && r.intencaoCliente === true;
}

/**
 * Levantamento completo ANTES de qualquer remoção. Qualquer divergência é colisão e nada é removido: mais de uma
 * assinatura ou cliente na referência, referência diferente, assinatura sem intenção registrada, id de assinatura ou de
 * cliente diferente do gravado, assinatura de outro cliente. Devolve o que pode ser removido.
 */
function conferirRecursos(r, subs, clientes) {
    const ref = r.referencia;
    assert.ok(subs.every(s => s.externalReference === ref) && clientes.every(c => c.externalReference === ref), 'COLISAO_REFERENCIA');
    const ativosCli = clientes.filter(c => !c.deleted);
    assert.ok(subs.length <= 1, 'COLISAO_ASSINATURAS'); assert.ok(ativosCli.length <= 1, 'COLISAO_CLIENTES');
    if (r.clienteId) assert.ok(ativosCli.every(c => c.id === r.clienteId), 'COLISAO_CLIENTE');
    const clienteId = r.clienteId ?? ativosCli[0]?.id ?? null;
    for (const s of subs) {
        assert.equal(r.intencaoAssinatura, true, 'COLISAO_ASSINATURA_SEM_INTENCAO');
        if (r.assinaturaId) assert.equal(s.id, r.assinaturaId, 'COLISAO_ASSINATURA');
        assert.ok(clienteId !== null && s.customer === clienteId, 'COLISAO_CLIENTE_DA_ASSINATURA');
    }
    return {assinatura:subs.find(s => !s.deleted) ?? null, cliente:ativosCli[0] ?? null};
}

/** Limpeza só do que a sonda comprovadamente criou. Confere tudo antes; remove assinatura e depois cliente. Nunca lança. */
async function encerrar({r, p, clientesPorReferencia, removerCliente, salvar}) {
    const falhas = [];
    const gravar = () => { try { salvar(); } catch { /* nada */ } };
    if (!provaDeAutoria(r)) { r.limpeza = {acao:'NADA_CRIADO_PELA_SONDA'}; r.falhasLimpeza = falhas; gravar(); return falhas; }
    let alvos;
    try {
        alvos = conferirRecursos(r, await p.listarAssinaturasPorReferencia(r.referencia), await clientesPorReferencia(r.referencia));
    } catch (e) {
        falhas.push(String(e?.message ?? e).slice(0, 80));
        r.limpeza = {acao:'COLISAO_OU_LEITURA_NADA_REMOVIDO'}; r.falhasLimpeza = falhas; gravar(); return falhas;
    }
    try {
        if (alvos.assinatura) assert.equal((await p.removerAssinatura(alvos.assinatura.id)).removida, true, 'ASSINATURA_NAO_REMOVIDA');
        if (alvos.cliente) {
            const d = await removerCliente(alvos.cliente.id);
            assert.ok(d.http === 404 || d.corpo?.deleted === true, 'CLIENTE_NAO_REMOVIDO HTTP ' + d.http);
        }
        const restantes = (await p.listarAssinaturasPorReferencia(r.referencia)).filter(s => !s.deleted).length;
        const clientesAtivos = (await clientesPorReferencia(r.referencia)).filter(c => !c.deleted).length;
        if (restantes || clientesAtivos) falhas.push(`ATIVOS assinaturas=${restantes} clientes=${clientesAtivos}`);
        r.limpeza = {acao:'REMOVIDOS', assinatura:!!alvos.assinatura, cliente:!!alvos.cliente, restantes, clientesAtivos};
    } catch (e) { falhas.push(String(e?.message ?? e).slice(0, 80)); r.limpeza = {acao:'REMOCAO_INCOMPLETA'}; }
    r.falhasLimpeza = falhas; gravar();
    return falhas;
}

async function main() {
    alvo(process.env); exigirDisco();
    const {p, ler, removerCliente, clientesPorReferencia} = await provedor();
    fs.mkdirSync(DIR, {recursive:true, mode:0o700});
    const r = {inicio:new Date().toISOString(), pid:process.pid, instancia:os.hostname(), referencia:PREFIXO_REF + randomUUID()};
    fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600, flag:'wx'}); // uma sonda só; sem sobrescrever
    const salvar = () => fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600});
    let erro = null;
    try {
        // Prova de autoria ANTES de criar: referência única sem cliente e sem assinatura no provedor.
        assert.equal((await clientesPorReferencia(r.referencia)).length, 0, 'REFERENCIA_OCUPADA');
        assert.equal((await p.listarAssinaturasPorReferencia(r.referencia)).length, 0, 'REFERENCIA_OCUPADA');
        r.precheck = {referenciaLivre:true}; salvar();
        r.intencaoCliente = true; salvar();
        r.clienteId = (await p.criarCliente({nome:'TESTE Kidmais sonda cobrança removida', cpfCnpj:documento(), referencia:r.referencia})).id; salvar();
        const venc = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
        r.intencaoAssinatura = true; salvar();
        const sub = await p.criarAssinatura({cliente:r.clienteId, valorCentavos:VALOR_CENTAVOS, ciclo:'MENSAL', vencimento:venc, referencia:r.referencia,
            descricao:'Sonda sintética de homologação — sem pagamento'});
        r.assinaturaId = sub.id; salvar();
        const antes = (await p.listarCobrancasDaAssinatura(sub.id)).filter(c => !c.deleted);
        r.cobrancas = antes.map(c => c.id); salvar();
        assert.ok(antes.length >= 1, 'SEM_COBRANCA_GERADA');
        assert.ok(antes.every(c => !pagamentoConhecido(c)), 'COBRANCA_PAGA'); // nunca pagamos; se aparecer paga, para
        r.antes = {cobrancas:await Promise.all(r.cobrancas.map(async id => { const x = await ler('cobranca', id); return {http:x.http, forma:forma(x.corpo)}; }))};
        salvar();
        r.remocao = await p.removerAssinatura(sub.id); salvar();
        // Releituras: a regra do executor (leitura direta) e as alternativas, para desenhar outra prova sem nova sonda.
        const assinaturaRelida = await ler('assinatura', sub.id);
        const cobrancasRelidas = await Promise.all(r.cobrancas.map(id => ler('cobranca', id)));
        r.depois = {
            assinatura:{http:assinaturaRelida.http, deleted:assinaturaRelida.corpo?.deleted === true, status:assinaturaRelida.corpo?.status ?? null},
            cobrancas:cobrancasRelidas.map(c => ({http:c.http, forma:forma(c.corpo)})),
            cobrancasDaAssinatura:resumoLista(await ler('cobrancasDaAssinatura', sub.id)),
            porAssinatura:resumoLista(await ler('porAssinatura', sub.id)),
            porCliente:resumoLista(await ler('porCliente', r.clienteId)),
            porReferencia:resumoLista(await ler('porReferencia', r.referencia)),
        };
        r.resultado = classificar({assinaturaRelida, cobrancasRelidas}); salvar();
    } catch (e) {
        erro = e; r.falha = String(e?.message ?? e).slice(0, 120); try { salvar(); } catch { /* nada */ }
    } finally {
        await encerrar({r, p, clientesPorReferencia, removerCliente, salvar});
    }
    r.concluido = !erro && r.falhasLimpeza.length === 0; salvar();
    console.log(JSON.stringify({resultado:r.resultado ?? 'INCOMPLETO', falha:r.falha ?? null, antes:r.antes ?? null, depois:r.depois ?? null,
        limpeza:r.limpeza ?? null, falhasLimpeza:r.falhasLimpeza}));
    if (!r.concluido) process.exitCode = 2;
}

/**
 * Recuperação (queda no meio): repete só a limpeza, com a mesma prova de autoria e conferência. Recusa enquanto a
 * sonda original estiver ativa (sem conclusão gravada e processo vivo nesta mesma instância).
 */
async function recuperar({env = process.env, arquivo = ARQUIVO, disco = () => exigirDisco(), deps = provedor, instancia = os.hostname(), vivo = processoVivo} = {}) {
    alvo(env); disco();
    assert.ok(fs.existsSync(arquivo), 'SEM_SONDA_PARA_ENCERRAR');
    const r = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    assert.ok(!(r.concluido === undefined && r.instancia === instancia && vivo(r.pid)), 'SONDA_EM_EXECUCAO');
    const salvar = () => fs.writeFileSync(arquivo, JSON.stringify(r, null, 2), {mode:0o600});
    r.recuperacoes = [...(r.recuperacoes ?? []), new Date().toISOString()]; salvar();
    const {p, removerCliente, clientesPorReferencia} = await deps();
    const falhas = await encerrar({r, p, clientesPorReferencia, removerCliente, salvar});
    return {resultado:falhas.length ? 'LIMPEZA_INCOMPLETA' : 'LIMPA', limpeza:r.limpeza ?? null, falhasLimpeza:falhas};
}

if (require.main === module) {
    const m = modo(process.argv.slice(2));
    if (m === 'SONDA') main().catch(e => { console.error('SONDA_RECUSADA ' + String(e?.message ?? '').slice(0, 80)); process.exitCode = 1; });
    else if (m === 'ENCERRAR') recuperar().then(x => { console.log(JSON.stringify(x)); if (x.falhasLimpeza.length) process.exitCode = 2; }).catch(e => { console.error(String(e?.message ?? 'RECUPERACAO_RECUSADA').slice(0, 80)); process.exitCode = 1; });
    else { console.error('AGUARDANDO_AUTORIZACAO_SONDA'); process.exitCode = 1; }
}
module.exports = {FLAG, FLAG_ENCERRAR, PREFIXO_REF, VALOR_CENTAVOS, ARQUIVO, alvo, modo, caminhoLeitura, forma, classificar,
    provaDeAutoria, conferirRecursos, encerrar, recuperar};
