/* eslint-disable @typescript-eslint/no-require-imports */
const test=require('node:test'),assert=require('node:assert/strict');
const {executarCiclo}=require('./assinatura-reconciliar.cjs');
test('ciclo sinaliza falha sem abandonar os próximos itens e faz rollback por item',async()=>{
    const comandos=[],visitados=[];
    const client={query:async sql=>{comandos.push(sql);}};
    const sinc={eventosPendentes:async()=>['erro','falhou','ok'],empresasComProvedor:async()=>['recusada'],
        processarEvento:async(_c,id)=>{visitados.push(id);if(id==='erro')throw Error('segredo-nao-deve-sair');return{situacao:id==='falhou'?'FALHOU':'PROCESSADO'};},
        sincronizarEmpresa:async()=>({resultado:'RECUSADA'})};
    const r=await executarCiclo({client,provedor:{},aplicar:true,banco:'sintetico',sinc});
    assert.equal(r.incompleto,true);assert.deepEqual(visitados,['erro','falhou','ok']);
    assert.deepEqual(r.eventos,{ERRO_Error:1,FALHOU:1,PROCESSADO:1});
    assert.equal(comandos.filter(s=>s==='ROLLBACK').length,1);assert.equal(comandos.filter(s=>s==='COMMIT').length,3);
    assert.ok(!JSON.stringify(r).includes('segredo'));
});
test('simulação não confirma transações; ciclo sem falhas é completo',async()=>{
    const comandos=[];
    const sinc={eventosPendentes:async()=>['ok'],empresasComProvedor:async()=>[],processarEvento:async()=>({situacao:'PROCESSADO'})};
    const r=await executarCiclo({client:{query:async s=>comandos.push(s)},provedor:{},aplicar:false,banco:'sintetico',sinc});
    assert.equal(r.incompleto,false);assert.deepEqual(comandos,['BEGIN','ROLLBACK']);
});

test('URL do banco não pode desabilitar verificação TLS remota',()=>{
    const {opcoesConexao}=require('./assinatura-reconciliar.cjs');
    const alvo={connectionString:'postgresql://fixture@example.test/staging?sslmode=require',local:false};
    const o=opcoesConexao(alvo);
    assert.equal(o.ssl.rejectUnauthorized,true);
    assert.equal(new URL(o.connectionString).searchParams.has('sslmode'),false);
    assert.throws(()=>opcoesConexao({...alvo,connectionString:alvo.connectionString.replace('require','no-verify')}),/TLS_MODO_RECUSADO/);
    assert.equal(opcoesConexao(alvo,{KIDMAIS_RECONCILIAR_CA_PEM:'certificado-fixture'}).ssl.ca,'certificado-fixture');
    const tentativa=opcoesConexao({...alvo,connectionString:alvo.connectionString+'&ssl=false&uselibpqcompat=true'});
    assert.equal(tentativa.ssl.rejectUnauthorized,true);
    assert.equal(new URL(tentativa.connectionString).searchParams.has('ssl'),false);
});

test('TLS interno exige opt-in, identidade do cron Render e alvo literal exato',()=>{
    const {validarAlvo,opcoesConexao}=require('./assinatura-reconciliar.cjs');
    const env={RENDER:'true',RENDER_SERVICE_ID:'crn-db493i142hec73ahmoe0',KIDMAIS_DEPLOY_ENV:'staging',ASAAS_AMBIENTE:'sandbox',
        KIDMAIS_RECONCILIAR_TLS:'render-interno-criptografado',
        KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://fixture@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91?sslmode=require',
        KIDMAIS_RECONCILIAR_ALVO:'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432'};
    const alvo=validarAlvo(env);
    assert.deepEqual(opcoesConexao(alvo,env).ssl,{rejectUnauthorized:false,minVersion:'TLSv1.2'});
    assert.equal(opcoesConexao(alvo,{...env,KIDMAIS_RECONCILIAR_TLS:undefined}).ssl.rejectUnauthorized,true);
    for(const mudanca of [{RENDER:undefined},{RENDER_SERVICE_ID:'outro'},{KIDMAIS_DEPLOY_ENV:'production'},{ASAAS_AMBIENTE:'producao'}])
        assert.throws(()=>opcoesConexao(alvo,{...env,...mudanca}),/TLS_REDE_PRIVADA_RECUSADA/);
    for(const [host,db,porta] of [['example.test','kidmais_staging_1z91',5432],['dpg-daidko3m8hqs73ce4jt0-a','outro',5432],['dpg-daidko3m8hqs73ce4jt0-a','kidmais_staging_1z91',6432]]) {
        const alterado={...env,KIDMAIS_RECONCILIAR_DATABASE_URL:`postgresql://fixture@${host}:${porta}/${db}`,KIDMAIS_RECONCILIAR_ALVO:`${db}@${host}:${porta}`};
        assert.throws(()=>opcoesConexao(validarAlvo(alterado),alterado),/TLS_REDE_PRIVADA_RECUSADA/);
    }
    assert.throws(()=>opcoesConexao({...alvo,connectionString:'postgresql://fixture@example.test/outro'},env),/TLS_REDE_PRIVADA_RECUSADA/);
    assert.throws(()=>opcoesConexao(alvo,{...env,KIDMAIS_RECONCILIAR_TLS:'no-verify'}),/TLS_POLITICA_RECUSADA/);
});

test('produção: só o alvo exato com serviço e provedor de produção; TLS do serviço; kidmais_manager sempre recusado',()=>{
    const {validarAlvo,opcoesConexao,PRODUCAO}=require('./assinatura-reconciliar.cjs');
    const url=`postgresql://fixture@${PRODUCAO.host}:${PRODUCAO.port}/${PRODUCAO.database}`;
    const env={RENDER:'true',KIDMAIS_DEPLOY_ENV:'production',ASAAS_AMBIENTE:'producao',DATABASE_SSL:'true',
        KIDMAIS_RECONCILIAR_DATABASE_URL:url,KIDMAIS_RECONCILIAR_ALVO:`${PRODUCAO.database}@${PRODUCAO.host}:${PRODUCAO.port}`};
    const alvo=validarAlvo(env);
    assert.equal(alvo.producao,true);
    assert.deepEqual(opcoesConexao(alvo,env).ssl,{rejectUnauthorized:true,minVersion:'TLSv1.2'});
    assert.equal(opcoesConexao(alvo,{...env,DATABASE_SSL_REJECT_UNAUTHORIZED:'false'}).ssl.rejectUnauthorized,false,'espelha o serviço');
    assert.throws(()=>opcoesConexao(alvo,{...env,DATABASE_SSL:undefined}),/TLS_PRODUCAO_RECUSADO/);
    assert.throws(()=>opcoesConexao(alvo,{...env,KIDMAIS_RECONCILIAR_TLS:'render-interno-criptografado'}),/TLS_PRODUCAO_RECUSADO/);
    for(const mudanca of [{RENDER:undefined},{KIDMAIS_DEPLOY_ENV:'staging'},{ASAAS_AMBIENTE:'sandbox'},{ASAAS_AMBIENTE:undefined}])
        assert.throws(()=>validarAlvo({...env,...mudanca}),/conferência de produção exige/,JSON.stringify(mudanca));
    const outroHost={...env,KIDMAIS_RECONCILIAR_DATABASE_URL:url.replace(PRODUCAO.host,'outro'),KIDMAIS_RECONCILIAR_ALVO:`${PRODUCAO.database}@outro:${PRODUCAO.port}`};
    assert.throws(()=>validarAlvo(outroHost),/conferência de produção exige/);
    const real={...env,KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://fixture@localhost:5432/kidmais_manager',KIDMAIS_RECONCILIAR_ALVO:'kidmais_manager@localhost:5432'};
    assert.throws(()=>validarAlvo(real),/proibido/);
    // staging continua sem a marca de produção
    const stg=validarAlvo({KIDMAIS_RECONCILIAR_DATABASE_URL:'postgresql://fixture@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91',KIDMAIS_RECONCILIAR_ALVO:'kidmais_staging_1z91@dpg-daidko3m8hqs73ce4jt0-a:5432'});
    assert.equal(stg.producao,false);
});

test('conferência: evento pendente ou empresa que mudaria = divergência; em produção sai 2; sem divergência sai 0',async()=>{
    const {executarCiclo,codigoDeSaida}=require('./assinatura-reconciliar.cjs');
    const ciclo=(eventos,empresas)=>executarCiclo({client:{query:async()=>{}},provedor:{},aplicar:false,banco:'sintetico',
        sinc:{eventosPendentes:async()=>eventos,empresasComProvedor:async()=>empresas.map((_,i)=>String(i)),processarEvento:async()=>({situacao:'PROCESSADO'}),
            sincronizarEmpresa:async(_c,i)=>empresas[Number(i)]}});
    const limpo=await ciclo([],[{resultado:'SINCRONIZADA',mudou:false}]);
    assert.equal(limpo.divergente,false); assert.equal(codigoDeSaida(limpo,true),0);
    const pago=await ciclo([],[{resultado:'SINCRONIZADA',mudou:true,antes:'TESTE',depois:'ATIVA'}]);
    assert.equal(pago.divergente,true); assert.equal(codigoDeSaida(pago,true),2); assert.equal(codigoDeSaida(pago,false),0,'staging inalterado');
    const evento=await ciclo(['e1'],[]);
    assert.equal(evento.divergente,true); assert.equal(codigoDeSaida(evento,true),2);
});

test('produção: --aplicar recusado antes de conectar',()=>{
    const fonte=require('node:fs').readFileSync(__dirname+'/assinatura-reconciliar.cjs','utf8');
    assert.match(fonte,/if \(alvo\.producao && aplicar\)\s+throw new Error\('Produção aceita só conferência/);
    assert.ok(fonte.indexOf('if (alvo.producao && aplicar)')<fonte.indexOf('await client.connect()'));
});

test('gratuidade da Kidmais na conferência: qualquer desvio é violação e reprova (saída 2) em qualquer ambiente',async()=>{
    const {conferirKidmais,codigoDeSaida}=require('./assinatura-reconciliar.cjs');
    const cliente=linha=>({query:async()=>({rows:[linha]})});
    const ok={empresas:1,ativas:1,assinaturas:0,contratacoes:0,fundadores:0,isencoes:0};
    assert.equal((await conferirKidmais(cliente(ok))).violada,false);
    assert.equal((await conferirKidmais(cliente({...ok,isencoes:1}))).isenta,true);
    for(const desvio of [{empresas:0,ativas:0},{empresas:2,ativas:2},{ativas:0},{assinaturas:1},{contratacoes:1},{fundadores:1}])
        assert.equal((await conferirKidmais(cliente({...ok,...desvio}))).violada,true,JSON.stringify(desvio));
    const limpo={incompleto:false,divergente:false,kidmais:{violada:false}};
    assert.equal(codigoDeSaida(limpo,true),0);
    assert.equal(codigoDeSaida({...limpo,kidmais:{violada:true}},true),2);
    assert.equal(codigoDeSaida({...limpo,kidmais:{violada:true}},false),2);
});
test('P1: empresa com leitura sem confirmação (404) deixa o ciclo incompleto (saída 2) e não conta como sem mudança',async()=>{
    const sinc={eventosPendentes:async()=>[],empresasComProvedor:async()=>['sem-confirmacao','ok'],processarEvento:async()=>({situacao:'PROCESSADO'}),
        sincronizarEmpresa:async(_c,id)=>id==='ok'?{resultado:'SINCRONIZADA',mudou:false}:{resultado:'SEM_CONFIRMACAO',motivo:'ASSINATURA_NAO_ENCONTRADA'}};
    const r=await executarCiclo({client:{query:async()=>{}},provedor:{},aplicar:true,banco:'sintetico',sinc});
    assert.deepEqual(r.empresas,{SEM_CONFIRMACAO:1,SEM_MUDANCA:1});
    assert.equal(r.incompleto,true);assert.equal(r.divergente,true);
});

// ---------------------------------------------------------------------------------------------------------------------
// D-C4 (aprovada em 20/10/2026): alarme por idade na conferência de PRODUÇÃO. Sem banco e sem rede.
// ---------------------------------------------------------------------------------------------------------------------
const D = require('./assinatura-reconciliar.cjs');
const HORA = 3600000, DIA = 24 * HORA;
// Execução real com atraso de 2 min 13 s; a referência do dia é 09:00:00 UTC.
const AGORA = Date.parse('2026-11-20T09:02:13.000Z'), REF = Date.parse('2026-11-20T09:00:00.000Z');
/** Recebido `d` dias completos antes da referência (+3 h: no meio da janela daquele dia). */
const noDia = (d) => REF - d * DIA - 3 * HORA;
const UUIDS = Array.from({length: 40}, (_, i) => `0000000${i}`.slice(-8) + '-aaaa-4bbb-8ccc-0123456789ab');

/** Ciclo de conferência de produção com dublês: eventos = [{dia|recebidoMs, semLinha, item, situacao, motivo, erro}]. */
async function conferencia(eventos, empresas = [], agoraMs = AGORA) {
    const ids = eventos.map((_, i) => UUIDS[i]);
    const sinc = {
        eventosPendentes: async () => ids,
        empresasComProvedor: async () => empresas.map((_, i) => UUIDS[30 + i]),
        processarEvento: async (_c, id) => {
            const e = eventos[ids.indexOf(id)];
            if (e.erro) throw Object.assign(new Error('falha com ' + id), {name: e.erro});
            return {situacao: e.situacao ?? 'FALHOU', empresaId: UUIDS[39], motivo: e.motivo};
        },
        sincronizarEmpresa: async (_c, id) => empresas[UUIDS.indexOf(id) - 30],
    };
    const lidos = [];
    const idadesDosEventos = async (_c, lista) => {
        lidos.push(...lista);
        const mapa = new Map();
        eventos.forEach((e, i) => {
            if (e.semLinha) return;
            const recebidoMs = 'recebidoMs' in e ? e.recebidoMs : noDia(e.dia);
            mapa.set(ids[i], {item: e.item ?? 'EVENTO_ASAAS', recebidoMs});
        });
        return {agoraMs, eventos: mapa};
    };
    const r = await D.executarCiclo({client: {query: async () => {}}, provedor: {}, aplicar: false, banco: 'kidmais_production', sinc, idadesDosEventos});
    r.kidmais = {violada: false};
    assert.deepEqual(lidos, ids, 'idades lidas para exatamente os eventos listados');
    return r;
}

test('D-C4: referência do dia = 09:00 UTC; atraso de até 23 h e antecipação de até 1 h caem no mesmo dia', () => {
    assert.equal(D.HORA_CRON_UTC, 9);
    for (const t of ['2026-11-20T09:00:00.000Z', '2026-11-20T09:02:13.000Z', '2026-11-20T11:00:00.000Z', '2026-11-20T08:00:00.000Z', '2026-11-21T07:59:59.999Z'])
        assert.equal(new Date(D.referenciaDoDia(Date.parse(t))).toISOString(), '2026-11-20T09:00:00.000Z', t);
    assert.equal(new Date(D.referenciaDoDia(Date.parse('2026-11-20T07:59:59.999Z'))).toISOString(), '2026-11-19T09:00:00.000Z');
    assert.equal(new Date(D.referenciaDoDia(Date.parse('2026-11-21T08:00:00.000Z'))).toISOString(), '2026-11-21T09:00:00.000Z');
});

test('D-C4: dias de aviso = 0 (novo), 1, 3, 7, 14, 21, 28…; fora da janela 2, 4–6, 8–13, 15…', () => {
    const avisos = Array.from({length: 61}, (_, d) => d).filter(D.diaDeAviso);
    assert.deepEqual(avisos, [0, 1, 3, 7, 14, 21, 28, 35, 42, 49, 56]);
    // Bordas exatas da janela de 24 h (medida até a referência, não até o instante real da execução).
    assert.equal(D.diaDoItem(REF - 1, REF), 0);
    assert.equal(D.diaDoItem(REF - DIA + 1, REF), 0);
    assert.equal(D.diaDoItem(REF - DIA, REF), 1);
    assert.equal(D.diaDoItem(REF - 2 * DIA, REF), 2);
    assert.equal(D.diaDoItem(REF + 60000, REF), 0, 'recebido depois das 09:00 e antes da consulta = novo');
    for (const ausente of [null, undefined, NaN, '2026-11-20', Infinity]) assert.equal(D.diaDoItem(ausente, REF), null, String(ausente));
    assert.equal(D.diaDoItem(REF, null), null);
});

test('D-C4: execuções diárias com atrasos diferentes avisam cada marco exatamente uma vez (sem duplicar nem perder dia)', () => {
    // Atrasos reais da execução em relação às 09:00 UTC: 0, segundos, minutos, horas e uma antecipação de 50 min.
    const atrasos = [0, 13000, 2 * 60000, 2 * HORA, 5 * HORA, -50 * 60000, 22 * HORA, 30000];
    const base = Date.parse('2026-11-01T09:00:00.000Z');
    // Recebimentos em vários horários (fora do intervalo entre 09:00 e a consulta daquele dia, tratado logo abaixo).
    for (const recebido of [base - 1, base - 5 * HORA, base - 23 * HORA, base - 12 * HORA - 7]) {
        const dias = [];
        for (let k = 0; k < 70; k++) {
            const execucao = base + k * DIA + atrasos[k % atrasos.length];
            if (execucao <= recebido) continue;
            dias.push(D.diaDoItem(recebido, D.referenciaDoDia(execucao)));
        }
        assert.deepEqual(dias, dias.map((_, i) => i), `dia avança 1 por execução, sem repetir nem pular (recebido ${new Date(recebido).toISOString()})`);
        assert.deepEqual(dias.filter(D.diaDeAviso), [0, 1, 3, 7, 14, 21, 28, 35, 42, 49, 56, 63]);
    }
    // Limitação documentada: recebido entre 09:00 e a consulta do dia é visto hoje E amanhã como novo (aviso a mais, nunca a menos).
    const execucao = base + 2 * 60000, recebido = base + 60000;
    assert.equal(D.diaDoItem(recebido, D.referenciaDoDia(execucao)), 0);
    assert.equal(D.diaDoItem(recebido, D.referenciaDoDia(execucao + DIA)), 0);
    assert.equal(D.diaDoItem(recebido, D.referenciaDoDia(execucao + 2 * DIA)), 1);
});

test('D-C4: item novo e dias 1/3/7/14/21 alarmam (saída 2); dias 2/4/8/15 não alarmam e saem em pendentesConhecidos', async () => {
    for (const d of [0, 1, 3, 7, 14, 21]) {
        const r = await conferencia([{dia: d}]);
        assert.equal(D.codigoDeSaida(r, true), 2, `dia ${d}`);
        assert.deepEqual(r.alarme.itens, [{item: 'EVENTO_ASAAS', resultado: 'FALHOU', motivo: null, idadeDias: d, aviso: d === 0 ? 'NOVO' : `DIA_${d}`}]);
        assert.deepEqual(r.pendentesConhecidos, []);
    }
    const proximo = {2: 3, 4: 7, 8: 14, 15: 21};
    for (const d of [2, 4, 8, 15]) {
        const r = await conferencia([{dia: d, item: 'PENDENCIA_CRIACAO', motivo: 'CRIACAO_SEM_RESPOSTA'}]);
        assert.equal(r.divergente, true, 'a divergência continua no relatório');
        assert.equal(r.incompleto, true, 'FALHOU continua marcado como incompleto');
        assert.equal(D.codigoDeSaida(r, true), 0, `dia ${d}: sem alarme`);
        assert.deepEqual(r.alarme.itens, []);
        assert.deepEqual(r.pendentesConhecidos, [{item: 'PENDENCIA_CRIACAO', resultado: 'FALHOU', motivo: 'CRIACAO_SEM_RESPOSTA', idadeDias: d, proximoAvisoDia: proximo[d]}]);
    }
    assert.equal(Date.parse((await conferencia([])).alarme.referencia), REF);
});

test('D-C4: idade ausente (sem linha, recebido_em nulo/inválido ou relógio do banco ausente) alarma — falha fechada', async () => {
    for (const e of [{semLinha: true}, {recebidoMs: null}, {recebidoMs: NaN}, {recebidoMs: undefined}]) {
        const r = await conferencia([{dia: 8}, e]);
        assert.equal(D.codigoDeSaida(r, true), 2, JSON.stringify(e));
        assert.deepEqual(r.alarme.itens.map((i) => i.aviso), ['SEM_IDADE']);
        assert.equal(r.pendentesConhecidos.length, 1);
    }
    const semRelogio = await conferencia([{dia: 8}, {dia: 15}], [], null);
    assert.deepEqual(semRelogio.alarme.itens.map((i) => i.aviso), ['SEM_IDADE', 'SEM_IDADE']);
    assert.equal(semRelogio.alarme.referencia, null);
    assert.equal(D.codigoDeSaida(semRelogio, true), 2);
});

test('D-C4: mistura — antigos fora da janela + 1 em janela = 2; empresa divergente e erro desta execução alarmam sempre', async () => {
    const r = await conferencia([
        {dia: 2, item: 'MARCADOR_REMOCAO', motivo: 'REVISAO_HUMANA: REMOCAO_SEM_CONFIRMACAO'},
        {dia: 9, situacao: 'PROCESSADO'},
        {dia: 16, item: 'PENDENCIA_CONTRATACAO', motivo: 'ADIADA: MARCADOR_NAO_GRAVADO'},
        {dia: 3, item: 'PENDENCIA_VINCULO', motivo: 'AGUARDANDO_CONFIRMACAO: CRIACAO_NAO_CONFIRMADA'},
        {dia: 40, motivo: 'PROVEDOR_INDISPONIVEL: obterAssinatura (503)'},
        {dia: 40, erro: 'TypeError'},
    ], [
        {resultado: 'SINCRONIZADA', mudou: false},
        {resultado: 'SINCRONIZADA', mudou: true, antes: 'ATIVA', depois: 'EM_ATRASO'},
        {resultado: 'RECUSADA', motivo: 'REFERENCIA_DIVERGENTE'},
    ]);
    assert.deepEqual(r.alarme.itens.map((i) => [i.item, i.resultado, i.aviso]), [
        ['PENDENCIA_VINCULO', 'FALHOU', 'DIA_3'],
        ['EVENTO_ASAAS', 'FALHOU', 'ERRO_NESTA_EXECUCAO'],
        ['EVENTO_ASAAS', 'ERRO_TypeError', 'ERRO_NESTA_EXECUCAO'],
        ['EMPRESA', 'MUDOU_ATIVA_PARA_EM_ATRASO', 'EMPRESA_SEM_IDADE'],
        ['EMPRESA', 'RECUSADA', 'EMPRESA_SEM_IDADE'],
    ]);
    assert.deepEqual(r.pendentesConhecidos.map((i) => [i.item, i.idadeDias, i.motivo, i.proximoAvisoDia]), [
        ['MARCADOR_REMOCAO', 2, 'REVISAO_HUMANA: REMOCAO_SEM_CONFIRMACAO', 3],
        ['EVENTO_ASAAS', 9, null, 14],
        ['PENDENCIA_CONTRATACAO', 16, 'ADIADA: MARCADOR_NAO_GRAVADO', 21],
    ]);
    assert.equal(D.codigoDeSaida(r, true), 2);
    // Só os antigos fora da janela: 0, com tudo listado.
    const antigos = await conferencia([{dia: 2}, {dia: 9}, {dia: 16}], [{resultado: 'SINCRONIZADA', mudou: false}]);
    assert.equal(D.codigoDeSaida(antigos, true), 0);
    assert.equal(antigos.pendentesConhecidos.length, 3);
    // Contagem que não fecha com a classificação (relatório adulterado ou incompleto): falha fechada.
    assert.equal(D.codigoDeSaida({...antigos, eventos: {FALHOU: 4}}, true), 2);
    assert.equal(D.codigoDeSaida({...antigos, pendentesConhecidos: antigos.pendentesConhecidos.slice(1)}, true), 2);
    assert.equal(D.codigoDeSaida({...antigos, pendentesConhecidos: undefined}, true), 2, 'sem a lista, vale a regra anterior');
});

test('D-C4: violação da gratuidade da Kidmais continua saída 2 mesmo sem nenhum item em alarme', async () => {
    const r = await conferencia([{dia: 9}]);
    assert.equal(D.codigoDeSaida(r, true), 0);
    assert.equal(D.codigoDeSaida({...r, kidmais: {violada: true}}, true), 2);
    const vazio = await conferencia([]);
    assert.equal(D.codigoDeSaida(vazio, true), 0);
    assert.equal(D.codigoDeSaida({...vazio, kidmais: {violada: true}}, true), 2);
});

test('D-C4: staging inalterado — sem idades não há classificação e a saída segue incompleto/violada', async () => {
    const sinc = {eventosPendentes: async () => ['a', 'b'], empresasComProvedor: async () => ['e'],
        processarEvento: async (_c, id) => ({situacao: id === 'a' ? 'FALHOU' : 'PROCESSADO'}),
        sincronizarEmpresa: async () => ({resultado: 'SINCRONIZADA', mudou: true, antes: 'TESTE', depois: 'ATIVA'})};
    for (const aplicar of [true, false]) {
        const r = await D.executarCiclo({client: {query: async () => {}}, provedor: {}, aplicar, banco: 'kidmais_staging_1z91', sinc});
        assert.deepEqual(Object.keys(r).sort(), ['banco', 'divergente', 'empresas', 'eventos', 'incompleto', 'modo'], 'mesmas chaves de antes');
        r.kidmais = {violada: false};
        assert.equal(D.codigoDeSaida(r, false), 2, 'FALHOU = incompleto = 2, como antes');
        assert.equal(D.codigoDeSaida({...r, incompleto: false}, false), 0, 'divergência sem falha: 0 em staging, como antes');
        assert.equal(D.codigoDeSaida({...r, kidmais: {violada: true}, incompleto: false}, false), 2);
    }
    // Mesmo com a classificação presente, staging (producao=false) ignora a regra D-C4.
    const comRegra = await conferencia([{dia: 9}]);
    assert.equal(D.codigoDeSaida(comRegra, false), 2, 'staging: incompleto continua 2');
    // O CLI só passa as idades para o alvo de produção (o cron de staging nunca é alvo de produção).
    const fonte = require('node:fs').readFileSync(__dirname + '/assinatura-reconciliar.cjs', 'utf8');
    assert.match(fonte, /const idadesDosEventos = alvo\.producao \? lerIdadesDosEventos : undefined;/);
});

test('D-C4: alarme e pendentesConhecidos sem dados sensíveis (só categoria, resultado, código do motivo e idade)', async () => {
    const r = await conferencia([
        {dia: 2, motivo: `REVISAO_HUMANA: ${UUIDS[39]} felipe@example.test sub_abc123`},
        {dia: 9, motivo: 'ERRO_GENERICO: Cliente Fulano de Tal'},
        {dia: 15, motivo: 'texto livre com id ' + UUIDS[5]},
        {dia: 1, motivo: 'LISTA_INCOMPLETA: listar cobranças (mais registros que o limite conferido; revisão humana)'},
    ], [{resultado: 'SEM_CONFIRMACAO', motivo: 'ASSINATURA_NAO_ENCONTRADA'}]);
    const texto = JSON.stringify({alarme: r.alarme, pendentesConhecidos: r.pendentesConhecidos});
    for (const proibido of [...UUIDS, '@', 'sub_', 'Fulano', 'texto livre', 'cobranças', 'kidmais:'])
        assert.ok(!texto.includes(proibido), proibido);
    assert.deepEqual(r.pendentesConhecidos.map((i) => i.motivo), ['REVISAO_HUMANA', 'ERRO_GENERICO', null]);
    assert.deepEqual(r.alarme.itens.map((i) => i.motivo), ['LISTA_INCOMPLETA', 'ASSINATURA_NAO_ENCONTRADA']);
    const permitidas = new Set(['item', 'resultado', 'motivo', 'idadeDias', 'proximoAvisoDia', 'aviso']);
    for (const i of [...r.alarme.itens, ...r.pendentesConhecidos]) for (const k of Object.keys(i)) assert.ok(permitidas.has(k), k);
});

test('D-C4: leitura das idades — relógio do banco, só os ids listados, categorias iguais às constantes do código', async () => {
    const consultas = [];
    const client = {query: async (sql, params) => {
        consultas.push([sql, params]);
        if (/clock_timestamp/.test(sql)) return {rows: [{agora_ms: AGORA}]};
        return {rows: [{id: UUIDS[0], recebido_ms: noDia(3), item: 'PENDENCIA_CRIACAO'}, {id: UUIDS[1], recebido_ms: null, item: 'EVENTO_ASAAS'}]};
    }};
    const lido = await D.lerIdadesDosEventos(client, [UUIDS[0], UUIDS[1]]);
    assert.equal(lido.agoraMs, AGORA);
    assert.deepEqual(lido.eventos.get(UUIDS[0]), {item: 'PENDENCIA_CRIACAO', recebidoMs: noDia(3)});
    assert.deepEqual(lido.eventos.get(UUIDS[1]), {item: 'EVENTO_ASAAS', recebidoMs: null});
    assert.equal(consultas.length, 2);
    assert.deepEqual(consultas[1][1], [[UUIDS[0], UUIDS[1]]]);
    assert.match(consultas[1][0], /FROM cobranca_eventos WHERE id = ANY\(\$1::uuid\[\]\)/);
    assert.doesNotMatch(D.SQL_IDADES_EVENTOS, /\b(INSERT|UPDATE|DELETE)\b/i, 'somente leitura');
    const vazio = [];
    await D.lerIdadesDosEventos({query: async (sql) => { vazio.push(sql); return {rows: [{agora_ms: AGORA}]}; }}, []);
    assert.equal(vazio.length, 1, 'sem eventos, só o relógio');
    // As categorias usam os mesmos literais de lib/assinatura/reconciliacao-contratacao.ts.
    const ts = require('node:fs').readFileSync(require('node:path').join(__dirname, '../lib/assinatura/reconciliacao-contratacao.ts'), 'utf8');
    for (const [nome, sufixo] of [['TIPO_PENDENCIA', ''], ['PREFIXO_PENDENCIA', '%'], ['PREFIXO_CRIACAO', '%'], ['PREFIXO_ID_CONFIRMADO', '%'], ['PREFIXO_REMOCAO_SEM_CONFIRMACAO', '%']]) {
        const valor = new RegExp(`export const ${nome} = '([^']+)';`).exec(ts)[1];
        assert.ok(D.SQL_IDADES_EVENTOS.includes(`'${valor}${sufixo}'`), nome);
    }
    assert.ok(D.SQL_IDADES_EVENTOS.includes("'kidmais:contratacao:%'"));
    assert.match(ts, /\$\{PREFIXO_PENDENCIA\}contratacao:/, 'prefixo das pendências de contratação');
});

test('D-C4 (P2-2): lista de eventos no limite alarma LISTA_LIMITE_ATINGIDO — um evento novo pode ter ficado de fora', async () => {
    assert.equal(D.LIMITE_EVENTOS, 500);
    const ciclo = async (n) => {
        const ids = Array.from({length: n}, (_, i) => `e${i}`);
        const pedidos = [];
        const sinc = {eventosPendentes: async (_c, limite) => { pedidos.push(limite); return ids.slice(0, limite); },
            empresasComProvedor: async () => [], processarEvento: async () => ({situacao: 'FALHOU', motivo: 'CRIACAO_SEM_RESPOSTA'})};
        const idadesDosEventos = async (_c, lista) => ({agoraMs: AGORA, eventos: new Map(lista.map((id) => [id, {item: 'PENDENCIA_CRIACAO', recebidoMs: noDia(9)}]))});
        const r = await D.executarCiclo({client: {query: async () => {}}, provedor: {}, aplicar: false, banco: 'kidmais_production', sinc, idadesDosEventos});
        r.kidmais = {violada: false};
        assert.deepEqual(pedidos, [500], 'o ciclo pede exatamente o limite');
        return r;
    };
    const abaixo = await ciclo(499);
    assert.deepEqual(abaixo.alarme.itens, []);
    assert.equal(abaixo.pendentesConhecidos.length, 499);
    assert.equal(D.codigoDeSaida(abaixo, true), 0, '499 antigos fora da janela: sem alarme');
    for (const n of [500, 800]) {
        const r = await ciclo(n);
        assert.deepEqual(r.alarme.itens, [{item: 'LISTA_EVENTOS', resultado: 'LIMITE_500', motivo: 'LISTA_LIMITE_ATINGIDO', aviso: 'LISTA_LIMITE_ATINGIDO'}], `${n} pendentes`);
        assert.equal(r.pendentesConhecidos.length, 500, 'os 500 lidos continuam listados');
        assert.equal(D.codigoDeSaida(r, true), 2, 'lista saturada = saída 2 (falha fechada)');
    }
    // Sem idades (staging), a lista no limite não muda nada.
    const sinc = {eventosPendentes: async () => Array.from({length: 500}, (_, i) => `e${i}`), empresasComProvedor: async () => [], processarEvento: async () => ({situacao: 'PROCESSADO'})};
    const stg = await D.executarCiclo({client: {query: async () => {}}, provedor: {}, aplicar: true, banco: 'kidmais_staging_1z91', sinc});
    assert.equal('alarme' in stg, false);
});

test('D-C4 (P3-2): LISTA_INCOMPLETA e PROVEDOR_SEM_ESCRITA em item antigo = erro desta execução (alarma)', async () => {
    const r = await conferencia([
        {dia: 9, motivo: 'LISTA_INCOMPLETA: listar assinaturas (mais registros que o limite conferido; revisão humana)'},
        {dia: 16, item: 'PENDENCIA_CONTRATACAO', motivo: 'PROVEDOR_SEM_ESCRITA'},
        {dia: 15, motivo: 'ERRO_INTERNO: TypeError'},
        {dia: 9, motivo: 'REVISAO_HUMANA: LISTA_INCOMPLETA_NAO_E_PREFIXO'},
    ]);
    assert.deepEqual(r.alarme.itens.map((i) => [i.motivo, i.aviso]), [
        ['LISTA_INCOMPLETA', 'ERRO_NESTA_EXECUCAO'], ['PROVEDOR_SEM_ESCRITA', 'ERRO_NESTA_EXECUCAO'], ['ERRO_INTERNO', 'ERRO_NESTA_EXECUCAO']]);
    assert.deepEqual(r.pendentesConhecidos.map((i) => i.motivo), ['REVISAO_HUMANA: LISTA_INCOMPLETA_NAO_E_PREFIXO']);
    assert.equal(D.codigoDeSaida(r, true), 2);
});

test('D-C4 (P3-4): o CASE da SQL mapeia cada (tipo, evento_id) na categoria certa', () => {
    // Intérprete mínimo do CASE: WHEN <termo> [OR <termo>] THEN '<cat>' ... ELSE '<cat>' END; termos "tipo <> 'x'",
    // "evento_id LIKE 'p%'" e "evento_id NOT LIKE 'p%'". Qualquer outra forma falha o teste (a SQL precisa continuar simples).
    const sql = D.SQL_IDADES_EVENTOS.replace(/\s+/g, ' ');
    const corpo = /CASE (.*?) END AS item/.exec(sql)[1];
    const ramos = [...corpo.matchAll(/WHEN (.*?) THEN '([A-Z_]+)'/g)].map((m) => [m[1], m[2]]);
    const senao = /ELSE '([A-Z_]+)'$/.exec(corpo)[1];
    assert.equal(corpo.replace(/WHEN (.*?) THEN '([A-Z_]+)' ?/g, '').trim(), `ELSE '${senao}'`, 'só WHEN/THEN e um ELSE');
    const like = (valor, padrao) => { assert.match(padrao, /^[^%_]*%$/, 'só prefixo%'); return valor.startsWith(padrao.slice(0, -1)); };
    const termo = (t, linha) => {
        let m;
        if ((m = /^tipo <> '([^']*)'$/.exec(t))) return linha.tipo !== m[1];
        if ((m = /^evento_id NOT LIKE '([^']*)'$/.exec(t))) return !like(linha.evento_id, m[1]);
        if ((m = /^evento_id LIKE '([^']*)'$/.exec(t))) return like(linha.evento_id, m[1]);
        throw new Error('termo fora do formato: ' + t);
    };
    const categoria = (linha) => {
        for (const [cond, cat] of ramos) if (cond.split(' OR ').some((t) => termo(t, linha))) return cat;
        return senao;
    };
    const ts = require('node:fs').readFileSync(require('node:path').join(__dirname, '../lib/assinatura/reconciliacao-contratacao.ts'), 'utf8');
    const k = (nome) => new RegExp(`export const ${nome} = '([^']+)';`).exec(ts)[1];
    const P = k('TIPO_PENDENCIA'), E = '11111111-2222-4333-8444-555555555555';
    const casos = [
        [P, `${k('PREFIXO_CRIACAO')}${E}:${E}`, 'PENDENCIA_CRIACAO'],
        [P, `${k('PREFIXO_PENDENCIA')}contratacao:${E}:${E}`, 'PENDENCIA_CONTRATACAO'],
        [P, `${k('PREFIXO_ID_CONFIRMADO')}${E}:${E}`, 'PENDENCIA_VINCULO'],
        [P, `${k('PREFIXO_REMOCAO_SEM_CONFIRMACAO')}${E}:${E}`, 'MARCADOR_REMOCAO'],
        [P, `${k('PREFIXO_PENDENCIA')}outra:${E}`, 'PENDENCIA_INTERNA'],
        [P, 'evt_sem_prefixo', 'EVENTO_ASAAS'],
        ['PAYMENT_CONFIRMED', `${k('PREFIXO_CRIACAO')}${E}`, 'EVENTO_ASAAS'],
        ['PAYMENT_RECEIVED', 'evt_abc&123', 'EVENTO_ASAAS'],
    ];
    for (const [tipo, evento_id, esperado] of casos) assert.equal(categoria({tipo, evento_id}), esperado, `${tipo} ${evento_id.slice(0, 20)}`);
});

test('089 na conferência D-C4: pedido vencido vira item por idade (novo alarma; fora do dia de aviso fica conhecido); staging só conta',async()=>{
    const {executarCiclo,codigoDeSaida}=require('./assinatura-reconciliar.cjs');
    const agoraMs=Date.parse('2026-11-20T09:30:00Z'), DIA=86400000;
    const sinc={eventosPendentes:async()=>[],empresasComProvedor:async()=>['a'],processarEvento:async()=>({situacao:'PROCESSADO'}),
        sincronizarEmpresa:async()=>({resultado:'SINCRONIZADA',mudou:false})};
    const ciclo=(pend,producao=true)=>executarCiclo({client:{query:async()=>{}},provedor:{},aplicar:false,banco:'sintetico',sinc,
        idadesDosEventos:producao?async()=>({agoraMs,eventos:new Map()}):undefined,pendenciasEncerramento:async()=>pend});
    const novo=await ciclo([{item:'DEVOLUCAO_PENDENTE',resultado:'AGUARDANDO_MANUAL',motivo:'ARREPENDIMENTO_7_DIAS',recebidoMs:agoraMs-3600000}]);
    assert.deepEqual(novo.encerramentos,{DEVOLUCAO_PENDENTE_AGUARDANDO_MANUAL:1});
    assert.deepEqual(novo.alarme.itens,[{item:'DEVOLUCAO_PENDENTE',resultado:'AGUARDANDO_MANUAL',motivo:'ARREPENDIMENTO_7_DIAS',idadeDias:0,aviso:'NOVO'}]);
    assert.equal(codigoDeSaida(novo,true),2);
    const antigo=await ciclo([{item:'RENOVACAO_NAO_REMOVIDA',resultado:'SEM_CONFIRMACAO',motivo:'CANCELAMENTO_FIM_PERIODO',recebidoMs:agoraMs-2*DIA-3600000}]);
    assert.deepEqual([antigo.alarme.itens.length,antigo.pendentesConhecidos.length,antigo.pendentesConhecidos[0].proximoAvisoDia],[0,1,3]);
    assert.equal(codigoDeSaida(antigo,true),0,'conhecido fora do dia de aviso: sem alarme, mas listado');
    const vazio=await ciclo([]);
    assert.deepEqual([vazio.encerramentos,codigoDeSaida(vazio,true)],[{},0]);
    const staging=await ciclo([{item:'DEVOLUCAO_PENDENTE',resultado:'RECUSADO',motivo:'ENCERRAMENTO_ANUAL_PROPORCIONAL',recebidoMs:agoraMs}],false);
    assert.deepEqual([staging.encerramentos,staging.alarme,codigoDeSaida(staging,false)],[{DEVOLUCAO_PENDENTE_RECUSADO:1},undefined,0]);
    const fonte=require('node:fs').readFileSync(__dirname+'/assinatura-reconciliar.cjs','utf8');
    assert.match(fonte,/pendenciasEncerramento: lerPendenciasEncerramento/);
});
