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

/** Provedor sandbox simulado: subs e clientes por referência; registra toda mutação. */
function provedorFalso({subs = [], clientes = [], falharRemocao = false, falharLeituraClientes = false} = {}) {
    const mutacoes = [];
    const p = {
        listarAssinaturasPorReferencia: async ref => subs.filter(x => x.externalReference === ref).map(x => ({...x})),
        removerAssinatura: async id => { mutacoes.push('removerAssinatura:' + id); if (falharRemocao) throw Error('ASAAS 500');
            subs.find(x => x.id === id).deleted = true; return {removida:true}; },
    };
    const clientesPorReferencia = async () => { if (falharLeituraClientes) throw Error('LEITURA_CLIENTES');
        return clientes.map(c => ({...c})); }; // leitura crua da API: a conferência é da sonda
    const removerCliente = async id => { mutacoes.push('removerCliente:' + id); clientes.find(c => c.id === id).deleted = true; return {http:200, corpo:{deleted:true, id}}; };
    return {p, clientesPorReferencia, removerCliente, mutacoes};
}
const provada = (extra = {}) => ({referencia:REF, precheck:{referenciaLivre:true}, intencaoCliente:true, intencaoAssinatura:true,
    clienteId:'cus_1', assinaturaId:'sub_1', ...extra});
const subDe = (extra = {}) => ({id:'sub_1', customer:'cus_1', externalReference:REF, deleted:false, ...extra});
const cliDe = (extra = {}) => ({id:'cus_1', externalReference:REF, deleted:false, ...extra});
const limpar = (x, r) => s.encerrar({r, ...x, salvar:() => {}});

test('limpeza com prova: remove a assinatura e depois o cliente da sonda; idempotente', async () => {
    const x = provedorFalso({subs:[subDe()], clientes:[cliDe()]}); const r = provada();
    assert.deepEqual(await limpar(x, r), []);
    assert.deepEqual(x.mutacoes, ['removerAssinatura:sub_1', 'removerCliente:cus_1']);
    assert.deepEqual(r.limpeza, {acao:'REMOVIDOS', assinatura:true, cliente:true, restantes:0, clientesAtivos:0});
    assert.deepEqual(await limpar(x, r), []); assert.equal(x.mutacoes.length, 2, 'segunda limpeza não remove nada novo');
});

test('queda antes de salvar IDs: acha cliente e assinatura pela referência, confere e remove', async () => {
    const x = provedorFalso({subs:[subDe({id:'sub_9', customer:'cus_9'})], clientes:[cliDe({id:'cus_9'})]});
    const r = provada({clienteId:undefined, assinaturaId:undefined});
    assert.deepEqual(await limpar(x, r), []); assert.deepEqual(x.mutacoes, ['removerAssinatura:sub_9', 'removerCliente:cus_9']);
    // Só o cliente chegou a ser criado (sem intenção de assinatura): remove só ele.
    const y = provedorFalso({clientes:[cliDe({id:'cus_7'})]});
    assert.deepEqual(await limpar(y, provada({clienteId:undefined, assinaturaId:undefined, intencaoAssinatura:undefined})), []);
    assert.deepEqual(y.mutacoes, ['removerCliente:cus_7']);
});

test('sem prova de autoria registrada antes da criação: nenhum recurso é removido', async () => {
    for (const r of [{referencia:REF}, provada({precheck:undefined}), provada({precheck:{referenciaLivre:false}}), provada({intencaoCliente:undefined}),
        provada({referencia:'outra-referencia'}), {}]) {
        const x = provedorFalso({subs:[subDe()], clientes:[cliDe()]});
        assert.deepEqual(await limpar(x, r), [], JSON.stringify(r)); assert.deepEqual(x.mutacoes, [], JSON.stringify(r));
        assert.equal(r.limpeza.acao, 'NADA_CRIADO_PELA_SONDA');
    }
});

test('colisão: qualquer divergência de IDs/referência não remove NENHUM recurso (nem assinatura nem cliente)', async () => {
    for (const [nome, subs, clientes, extra = {}] of [
        ['duas assinaturas', [subDe(), subDe({id:'sub_2'})], [cliDe()]],
        ['dois clientes', [subDe()], [cliDe(), cliDe({id:'cus_2'})]],
        ['assinatura com outro id', [subDe({id:'sub_outra'})], [cliDe()]],
        ['assinatura de outro cliente', [subDe({customer:'cus_outro'})], [cliDe()]],
        ['cliente com outro id', [subDe()], [cliDe({id:'cus_outro'})]],
        ['assinatura sem intenção registrada', [subDe()], [cliDe()], {intencaoAssinatura:undefined, assinaturaId:undefined}],
        ['cliente de outra referência na listagem', [subDe()], [cliDe(), cliDe({id:'cus_x', externalReference:'outra'})]],
        ['cliente removido e assinatura sem cliente conhecido', [subDe()], [], {clienteId:undefined}]]) {
        const x = provedorFalso({subs, clientes}); const r = provada(extra);
        const falhas = await limpar(x, r);
        assert.deepEqual(x.mutacoes, [], nome); assert.match(falhas[0], /COLISAO/, nome);
        assert.equal(r.limpeza.acao, 'COLISAO_OU_LEITURA_NADA_REMOVIDO', nome);
    }
    // Falha ao ler clientes: também não remove nada.
    const x = provedorFalso({subs:[subDe()], clientes:[cliDe()], falharLeituraClientes:true});
    assert.match((await limpar(x, provada()))[0], /LEITURA_CLIENTES/); assert.deepEqual(x.mutacoes, []);
});

test('falha ao remover a assinatura: não remove o cliente, registra e nunca lança', async () => {
    const x = provedorFalso({subs:[subDe()], clientes:[cliDe()], falharRemocao:true}); const r = provada();
    const falhas = await limpar(x, r);
    assert.deepEqual(x.mutacoes, ['removerAssinatura:sub_1']); assert.match(falhas[0], /ASAAS 500/); assert.equal(r.limpeza.acao, 'REMOCAO_INCOMPLETA');
});

test('recuperação recusa enquanto a sonda estiver ativa; segue quando concluída, em outra instância ou com processo morto', async () => {
    const os = require('node:os'); const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonda-')); const arquivo = path.join(dir, 'sonda.json');
    const filho = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)']);
    try {
        let chamadas = 0; const x = provedorFalso({subs:[subDe()], clientes:[cliDe()]});
        const deps = async () => { chamadas++; return x; };
        const base = {env:envStaging(), arquivo, disco:() => {}, deps, instancia:'inst-a'};
        fs.writeFileSync(arquivo, JSON.stringify(provada({pid:filho.pid, instancia:'inst-a'})));
        await assert.rejects(s.recuperar(base), /SONDA_EM_EXECUCAO/);
        assert.equal(chamadas, 0, 'nem abre o provedor'); assert.deepEqual(x.mutacoes, []);
        assert.equal(JSON.parse(fs.readFileSync(arquivo, 'utf8')).recuperacoes, undefined, 'estado intocado');
        // Outra instância (deploy trocou o contêiner): o processo original não existe mais.
        assert.equal((await s.recuperar({...base, instancia:'inst-b'})).resultado, 'LIMPA'); assert.equal(chamadas, 1);
        // Concluída: segue (idempotente).
        fs.writeFileSync(arquivo, JSON.stringify(provada({pid:filho.pid, instancia:'inst-a', concluido:false})));
        assert.equal((await s.recuperar(base)).resultado, 'LIMPA');
        // Processo morto na mesma instância: segue.
        fs.writeFileSync(arquivo, JSON.stringify(provada({pid:filho.pid, instancia:'inst-a'})));
        filho.kill(); await new Promise(ok => filho.once('exit', ok));
        assert.equal((await s.recuperar(base)).resultado, 'LIMPA');
        // Sem estado ou fora do staging: recusa.
        await assert.rejects(s.recuperar({...base, arquivo:path.join(dir, 'nao-existe.json')}), /SEM_SONDA_PARA_ENCERRAR/);
        await assert.rejects(s.recuperar({...base, env:{...envStaging(), KIDMAIS_DEPLOY_ENV:'production'}}));
    } finally { filho.kill(); fs.rmSync(dir, {recursive:true, force:true}); }
});

test('código-fonte: sem banco, sem pagamento, só sandbox, uma execução por disco', () => {
    assert.doesNotMatch(fonte, /require\('pg'\)|DATABASE_URL|db\.query/);
    assert.doesNotMatch(fonte, /sandbox\/payment|\/confirm|receiveInCash|assinatura_fundadores/);
    assert.match(fonte, /const SANDBOX = 'https:\/\/api-sandbox\.asaas\.com\/v3'/);
    assert.equal(s.VALOR_CENTAVOS, 500);
    assert.match(fonte, /flag:'wx'/);
    const mutacoes = fonte.match(/chamar\('(POST|PUT|DELETE)'/g) ?? [];
    assert.deepEqual(mutacoes, ["chamar('DELETE'"], 'única mutação direta: remover o cliente da sonda');
    const i = t => fonte.indexOf(t);
    assert.ok(i('r.precheck = {referenciaLivre:true}') < i('r.intencaoCliente = true') && i('r.intencaoCliente = true') < i('p.criarCliente('));
    assert.ok(i('r.intencaoAssinatura = true') < i('p.criarAssinatura('));
});
