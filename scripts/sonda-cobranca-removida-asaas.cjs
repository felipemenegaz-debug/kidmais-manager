/* eslint-disable @typescript-eslint/no-require-imports */
// Sonda isolada no Asaas SANDBOX (docs/SONDA_COBRANCA_REMOVIDA_ASAAS_20261010.md): como o provedor devolve a cobrança
// de uma assinatura removida. Sem banco, sem pagamento, sem empresa e sem vaga Fundador. Executar SOMENTE no Web Shell
// do srv-daif418ae00c73e8k2gg (única origem da chave sandbox), depois de aprovação, com a flag única abaixo.
// Cria: 1 cliente sintético (referência única, notificações desligadas) e 1 assinatura de R$ 5,00. Remove ambos no finally.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {documento} = require('./assinatura-staging-ensaio.cjs');
const {exigirDisco} = require('./conexao-staging.cjs');
const {cancelamentoComprovado, pagamentoConhecido} = require('./homologacao-fundador-staging.cjs');

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
        porAssinatura:() => `/payments?subscription=${id(v)}`, porCliente:() => `/payments?customer=${id(v)}`, porReferencia:() => `/payments?externalReference=${ref(v)}`}[tipo]();
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
    return {p:criarClienteAsaas(cfg.config), ler, removerCliente};
}

/** Lista (só formas) de uma leitura paginada do Asaas. */
const resumoLista = l => ({http:l.http, total:Array.isArray(l.corpo?.data) ? l.corpo.data.length : null,
    itens:Array.isArray(l.corpo?.data) ? l.corpo.data.map(forma) : null});

/** Limpeza só do que a sonda criou: assinaturas e cliente com a referência única desta execução. Nunca lança. */
async function encerrar({r, p, removerCliente, salvar}) {
    const falhas = [];
    try {
        assert.ok(typeof r.referencia === 'string' && r.referencia.startsWith(PREFIXO_REF), 'REFERENCIA_INVALIDA');
        for (const s of await p.listarAssinaturasPorReferencia(r.referencia)) {
            assert.equal(s.externalReference, r.referencia);
            if (!s.deleted) { try { await p.removerAssinatura(s.id); } catch (e) { falhas.push('ASSINATURA ' + String(e.message).slice(0, 60)); } }
        }
        const cli = r.clienteId ? {id:r.clienteId} : await p.buscarClientePorReferencia(r.referencia);
        if (cli) {
            const d = await removerCliente(cli.id);
            r.clienteRemovido = d.http === 404 || d.corpo?.deleted === true; if (!r.clienteRemovido) falhas.push('CLIENTE HTTP ' + d.http);
        } else r.clienteRemovido = 'NADA_CRIADO';
        const restantes = (await p.listarAssinaturasPorReferencia(r.referencia)).filter(s => !s.deleted).length;
        if (restantes) falhas.push('ASSINATURAS_ATIVAS ' + restantes);
        r.limpeza = {restantes, clienteRemovido:r.clienteRemovido};
    } catch (e) { falhas.push(String(e?.message ?? e).slice(0, 80)); }
    r.falhasLimpeza = falhas; try { salvar(); } catch { /* nada */ }
    return falhas;
}

async function main() {
    alvo(process.env); exigirDisco();
    const {p, ler, removerCliente} = await provedor();
    fs.mkdirSync(DIR, {recursive:true, mode:0o700});
    const r = {inicio:new Date().toISOString(), pid:process.pid, referencia:PREFIXO_REF + randomUUID()};
    fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600, flag:'wx'}); // uma sonda só; sem sobrescrever
    const salvar = () => fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600});
    let erro = null;
    try {
        assert.equal(await p.buscarClientePorReferencia(r.referencia), null, 'REFERENCIA_OCUPADA');
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
        await encerrar({r, p, removerCliente, salvar});
    }
    r.concluido = !erro && r.falhasLimpeza.length === 0; salvar();
    console.log(JSON.stringify({resultado:r.resultado ?? 'INCOMPLETO', falha:r.falha ?? null, antes:r.antes ?? null, depois:r.depois ?? null,
        limpeza:r.limpeza ?? null, falhasLimpeza:r.falhasLimpeza}));
    if (!r.concluido) process.exitCode = 2;
}

/** Recuperação (queda no meio): repete só a limpeza pela referência gravada. */
async function recuperar() {
    alvo(process.env); exigirDisco();
    assert.ok(fs.existsSync(ARQUIVO), 'SEM_SONDA_PARA_ENCERRAR');
    const r = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    const salvar = () => fs.writeFileSync(ARQUIVO, JSON.stringify(r, null, 2), {mode:0o600});
    const {p, removerCliente} = await provedor();
    const falhas = await encerrar({r, p, removerCliente, salvar});
    console.log(JSON.stringify({resultado:falhas.length ? 'LIMPEZA_INCOMPLETA' : 'LIMPA', limpeza:r.limpeza ?? null, falhasLimpeza:falhas}));
    if (falhas.length) process.exitCode = 2;
}

if (require.main === module) {
    const m = modo(process.argv.slice(2));
    if (m === 'SONDA') main().catch(e => { console.error('SONDA_RECUSADA ' + String(e?.message ?? '').slice(0, 80)); process.exitCode = 1; });
    else if (m === 'ENCERRAR') recuperar().catch(e => { console.error(String(e?.message ?? 'RECUPERACAO_RECUSADA').slice(0, 80)); process.exitCode = 1; });
    else { console.error('AGUARDANDO_AUTORIZACAO_SONDA'); process.exitCode = 1; }
}
module.exports = {FLAG, FLAG_ENCERRAR, PREFIXO_REF, VALOR_CENTAVOS, ARQUIVO, alvo, modo, caminhoLeitura, forma, classificar, encerrar};
