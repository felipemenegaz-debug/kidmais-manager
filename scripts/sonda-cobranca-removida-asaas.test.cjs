/* eslint-disable @typescript-eslint/no-require-imports */
// Testes offline da sonda de cobrança removida: sem rede, sem Asaas, sem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const s = require('./sonda-cobranca-removida-asaas.cjs');

const fonte = fs.readFileSync(__dirname + '/sonda-cobranca-removida-asaas.cjs', 'utf8');
const envStaging = () => ({RENDER:'true', RENDER_SERVICE_ID:'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV:'staging', ASAAS_AMBIENTE:'sandbox'});
const REF = s.PREFIXO_REF + '00000000-0000-4000-8000-000000000000';

test('flag única; sem ela nada roda; recuperação sem disco é recusada', () => {
    assert.equal(s.modo([]), null); assert.equal(s.modo([s.FLAG, '--x']), null);
    assert.equal(s.modo([s.FLAG]), 'SONDA'); assert.equal(s.modo([s.FLAG_ENCERRAR]), 'ENCERRAR');
    const r = spawnSync(process.execPath, [__dirname + '/sonda-cobranca-removida-asaas.cjs'], {encoding:'utf8', env:{PATH:process.env.PATH}, timeout:20000});
    assert.equal(r.status, 1); assert.match(r.stderr, /AGUARDANDO_AUTORIZACAO_SONDA/);
    for (const flag of [s.FLAG, s.FLAG_ENCERRAR]) {
        const x = spawnSync(process.execPath, [__dirname + '/sonda-cobranca-removida-asaas.cjs', flag], {encoding:'utf8', env:{...envStaging(), PATH:process.env.PATH}, timeout:20000});
        assert.equal(x.status, 1); assert.match(x.stderr, /DISCO_PERSISTENTE_AUSENTE/, flag);
    }
});

test('alvo: só web staging com Asaas sandbox', () => {
    assert.doesNotThrow(() => s.alvo(envStaging()));
    for (const v of [{RENDER_SERVICE_ID:'srv-dak77m2d0e5s73b8rkkg'}, {KIDMAIS_DEPLOY_ENV:'production'}, {ASAAS_AMBIENTE:'producao'}, {RENDER:undefined}])
        assert.throws(() => s.alvo({...envStaging(), ...v}), undefined, JSON.stringify(v));
});

test('leituras restritas: só GET de recursos da sonda; IDs e referência validados', () => {
    assert.equal(s.caminhoLeitura('cobranca', 'pay_123'), '/payments/pay_123');
    assert.equal(s.caminhoLeitura('cobrancasDaAssinatura', 'sub_1'), '/subscriptions/sub_1/payments');
    assert.equal(s.caminhoLeitura('porReferencia', REF), '/payments?externalReference=' + encodeURIComponent(REF));
    assert.throws(() => s.caminhoLeitura('cobranca', '../customers'));
    assert.throws(() => s.caminhoLeitura('porReferencia', 'outra-referencia'));
    assert.throws(() => s.caminhoLeitura('qualquer', 'x'));
});

test('classificação usa a regra do executor Fundador', () => {
    const removida = {http:200, corpo:{id:'pay_1', deleted:true, status:'PENDING', value:5}};
    const sub404 = {http:404, corpo:null};
    assert.equal(s.classificar({assinaturaRelida:sub404, cobrancasRelidas:[removida]}), 'REGRA_ATENDIDA');
    assert.equal(s.classificar({assinaturaRelida:{http:200, corpo:{deleted:true}}, cobrancasRelidas:[removida]}), 'REGRA_ATENDIDA');
    assert.equal(s.classificar({assinaturaRelida:sub404, cobrancasRelidas:[{http:404, corpo:null}]}), 'COBRANCA_404');
    for (const [nome, c, a = sub404] of [['paga removida', {http:200, corpo:{id:'p', deleted:true, status:'RECEIVED'}}],
        ['não removida', {http:200, corpo:{id:'p', deleted:false, status:'PENDING'}}], ['estado desconhecido', {http:200, corpo:{id:'p', deleted:true}}],
        ['erro http', {http:500, corpo:null}], ['assinatura ativa', removida, {http:200, corpo:{deleted:false}}]])
        assert.equal(s.classificar({assinaturaRelida:a, cobrancasRelidas:[c]}), 'OUTRO', nome);
    assert.equal(s.classificar({assinaturaRelida:sub404, cobrancasRelidas:[]}), 'OUTRO');
    assert.deepEqual(s.forma({id:'p', deleted:true, status:'PENDING', value:5, customer:'cus_x', description:'x'}),
        {id:'p', deleted:true, status:'PENDING', paymentDate:null, valorCentavos:500}, 'sem campos pessoais');
});

function provedorFalso({subs = [], cliente = null, falharRemocao = false} = {}) {
    const chamadas = [];
    const p = {
        listarAssinaturasPorReferencia: async ref => { chamadas.push('listar:' + ref); return subs.filter(x => x.externalReference === ref); },
        removerAssinatura: async id => { chamadas.push('remover:' + id); if (falharRemocao) throw Error('ASAAS 500'); subs.find(x => x.id === id).deleted = true; return {removida:true}; },
        buscarClientePorReferencia: async ref => { chamadas.push('cliente:' + ref); return cliente; },
    };
    const removerCliente = async id => { chamadas.push('removerCliente:' + id); return {http:200, corpo:{deleted:true, id}}; };
    return {p, removerCliente, chamadas, subs};
}

test('limpeza: só a assinatura e o cliente da referência desta sonda; nunca lança', async () => {
    let x = provedorFalso({subs:[{id:'sub_1', externalReference:REF, deleted:false}]}); let r = {referencia:REF, clienteId:'cus_1'};
    assert.deepEqual(await s.encerrar({r, ...x, salvar:() => {}}), []);
    assert.deepEqual(x.chamadas.filter(c => !c.startsWith('listar')), ['remover:sub_1', 'removerCliente:cus_1']);
    assert.deepEqual(r.limpeza, {restantes:0, clienteRemovido:true});
    // Queda antes de salvar o id do cliente: acha pela referência única.
    x = provedorFalso({cliente:{id:'cus_9'}}); r = {referencia:REF};
    assert.deepEqual(await s.encerrar({r, ...x, salvar:() => {}}), []); assert.ok(x.chamadas.includes('removerCliente:cus_9'));
    // Nada criado: não remove nada.
    x = provedorFalso(); r = {referencia:REF};
    assert.deepEqual(await s.encerrar({r, ...x, salvar:() => {}}), []); assert.equal(r.clienteRemovido, 'NADA_CRIADO');
    // Falha ao remover: registra, não lança, acusa assinatura ativa.
    x = provedorFalso({subs:[{id:'sub_1', externalReference:REF, deleted:false}], falharRemocao:true}); r = {referencia:REF, clienteId:'cus_1'};
    const falhas = await s.encerrar({r, ...x, salvar:() => {}}); assert.ok(falhas.some(f => /ASSINATURA/.test(f))); assert.ok(falhas.some(f => /ASSINATURAS_ATIVAS 1/.test(f)));
    // Referência alheia: nada é chamado.
    x = provedorFalso({subs:[{id:'sub_x', externalReference:'outra', deleted:false}]}); r = {referencia:'outra', clienteId:'cus_x'};
    assert.equal((await s.encerrar({r, ...x, salvar:() => {}})).length, 1); assert.deepEqual(x.chamadas, []);
});

test('código-fonte: sem banco, sem pagamento, só sandbox, uma execução por disco', () => {
    assert.doesNotMatch(fonte, /require\('pg'\)|DATABASE_URL|db\.query/);
    assert.doesNotMatch(fonte, /sandbox\/payment|\/confirm|receiveInCash|assinatura_fundadores/);
    assert.match(fonte, /const SANDBOX = 'https:\/\/api-sandbox\.asaas\.com\/v3'/);
    assert.equal(s.VALOR_CENTAVOS, 500);
    assert.match(fonte, /flag:'wx'/);
    const mutacoes = fonte.match(/chamar\('(POST|PUT|DELETE)'/g) ?? [];
    assert.deepEqual(mutacoes, ["chamar('DELETE'"], 'única mutação direta: remover o cliente da sonda');
    assert.ok(fonte.indexOf("r.intencaoCliente = true") < fonte.indexOf('p.criarCliente('));
});
