// Destructive synthetic fixtures ONLY in an explicitly authorized disposable local database.
// Does not create databases, apply migrations, copy production, or load dotenv.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const loadTs = createRequire(import.meta.url);
let url;
try { url = new URL(process.env.FESTA_019_TEST_URL ?? 'postgresql://invalid@invalid/invalid'); }
catch { throw Error('Invalid disposable target; no connection attempted'); }
const database = decodeURIComponent(url.pathname.slice(1));
if (!process.argv.includes('--authorize-disposable') || database !== 'kidmais_smoke_patch_final_test' || url.port !== '55439' || url.username !== 'smoke_patch_test'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search || url.hash
    || !['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw Error('Explicit disposable local target and --authorize-disposable required. No connection attempted.');
}
const pool = new Pool({ connectionString: url.toString(), max: 8, connectionTimeoutMillis: 5000,
    options: '-c lock_timeout=5s -c statement_timeout=20000' });
const results = [];
try {
    const target=(await pool.query('SELECT current_database() db,current_user usuario,host(inet_server_addr()) host,inet_server_port() porta')).rows[0]; assert.deepEqual(target,{db:database,usuario:'smoke_patch_test',host:'127.0.0.1',porta:55439}); console.log(JSON.stringify(target));

    Object.assign(process.env, { NODE_ENV: 'test', RENDER: 'false', KIDMAIS_DEPLOY_ENV: 'test', DATABASE_URL: url.toString(),
        DATABASE_SSL: 'false', FESTA_ENABLED: 'true', CONTRATO_ACEITE_DEV_ENABLED: 'true', IDENTIDADE_OTP_PEPPER: randomBytes(32).toString('hex') });
    globalThis.__kidmaisPgPool = pool;
    // Existing offline TypeScript loader; no connection or fixture is created on import.
    await import('./pagamentos-test-support.cjs');
    const admin = await loadTs('./admin-test-support.cjs').autenticarTeste(pool);
    const { validarAmbienteFesta } = loadTs('../lib/festas/ambiente.ts');
    await validarAmbienteFesta(pool);
    const cs = loadTs('../lib/contratos/services/administrativo.service.ts');
    const publico = loadTs('../lib/contratos/services/contrato-publico.service.ts');
    const identity = loadTs('../lib/identidade/services/index.ts');
    const festa = loadTs('../lib/festas/service.ts');
    const ctx = () => ({ token: admin.token, requestId: randomUUID(), ip: null, userAgent: 'Synthetic 019 integration' });
    const op = (vid, input) => cs.operarContrato(vid, input, admin.token, ctx());
    // Deliberately do NOT grant FESTA_CRIAR.
    for (const cap of ['FESTA_CONSULTAR', 'FESTA_OPERAR', 'FESTA_CORRIGIR']) {
        await pool.query('INSERT INTO festa_usuario_capacidades(usuario_id,capacidade,concedido_por,motivo) VALUES($1,$2,$1,$3)', [admin.usuarioId, cap, 'Synthetic 019']);
    }
    const check = async (name, work) => { await work(); results.push(name); console.log('PASS ' + name); };
    const config = (await pool.query("SELECT id FROM configuracao_agenda WHERE codigo='TURNO_2'")).rows[0].id;
    const pack = (await pool.query("SELECT id FROM pacotes WHERE codigo='COMPLETA'")).rows[0].id;
    const count = async cid => (await pool.query('SELECT count(*)::int n FROM festas WHERE contrato_id=$1 AND invalidada_em IS NULL', [cid])).rows[0].n;
    const occupied = async day => (await pool.query('SELECT * FROM kidmais_ocupacoes_operacionais($1::date,$1::date)', [day])).rows;
    async function freeze(vid) {
        const e = (await pool.query('SELECT * FROM contrato_edicoes WHERE contrato_versao_id=$1', [vid])).rows[0];
        const d = await op(vid, { acao: 'gerar_pdf', revisao: e.revisao });
        await op(vid, { acao: 'revisar', revisao: e.revisao, documentoId: d.documentoId });
        await op(vid, { acao: 'assinar', revisao: e.revisao, documentoId: d.documentoId, chaveIdempotencia: randomUUID() });
        await op(vid, { acao: 'liberar', revisao: e.revisao });
    }
    async function prepare(day, start = '17:00', end = '21:00') {
        const digits = Array.from({ length: 9 }, () => randomInt(0, 10));
        for (const peso of [10, 11]) { const r = digits.reduce((sum, d, i) => sum + d * (peso - i), 0) * 10 % 11; digits.push(r === 10 ? 0 : r); }
        const total = (await loadTs('../lib/comercial/services/index.ts').calcularResumoComercial({ data: day, configuracaoAgendaId: config, pacoteId: pack, convidados: 50 })).valorTotalTabela;
        const f = (await loadTs('../lib/fechamentos/services/fechamento-publico.service.ts').criarFechamentoPublicoComIdentidade({
            dataEvento: day, horarioInicio: start, horarioFim: end, configuracaoAgendaId: config, pacoteId: pack,
            convidados: 50, valorProposto: total, formaPagamentoPretendida: 'CARTAO_CIELO', identidade: { tipo: 'NOVO_CLIENTE' },
            idadeAniversarianteEvento: 1, cliente: { nomeCompleto: 'Synthetic 019', cpf: digits.join(''), telefone: '11999998888',
                whatsapp: '11999998888', email: randomUUID() + '@example.invalid', cep: '01001000', logradouro: 'Rua Sintética', numero: '1', bairro: 'Centro', cidade: 'São Paulo', uf: 'SP' },
            aniversariante: { nome: 'Synthetic child 019' },
        })).fechamento;
        const c = await loadTs('../lib/contratos/services/contrato.service.ts').gerarContrato({ fechamentoId: f.id }, { usuarioId: admin.usuarioId, origem: 'SISTEMA' });
        await freeze(c.versao.id);
        return { cid: c.contrato.id, vid: c.versao.id, fid: f.id, day };
    }
    async function acceptance(cid) {
        const v = (await pool.query('SELECT v.snapshot FROM contrato_fluxos cf JOIN contrato_versoes v ON v.id=cf.versao_em_preparacao_id WHERE cf.contrato_id=$1', [cid])).rows[0];
        const cpf = v.snapshot.contratante.cpf;
        const access = await publico.consultarAcessoContrato({ contratoId: cid, cpf });
        let code; const sender = async x => { code = x.codigo; };
        const challenge = await publico.iniciarDesafioContrato({ contratoId: cid, cpf, canal: access.canais[0].canal }, sender);
        const proof = await identity.criarIdentityServiceComAmbiente(sender).confirmarCodigo({ validacaoId: challenge.validacaoId, codigo: code });
        const input = { contratoId: cid, acessoToken: challenge.acessoToken, provaToken: proof.provaToken };
        const context = await publico.obterContextoContratoPublico(input);
        return { ...input, versaoId: context.versao.id, snapshotHash: context.versao.snapshotHash, documentoPdfHash: context.versao.documentoPdfHash };
    }
    const accept = input => publico.assinarContratoPublico(input, async () => { throw Error('No external OTP permitted'); }, ctx());
    async function concurrentAccepts(inputs) {
        const backends = new Set();
        let ready = 0, release;
        let timer;
        const barrier = new Promise((resolve, reject) => {
            release = resolve;
            timer = setTimeout(() => reject(Error('Concurrent transaction barrier timed out')), 10000);
        });
        globalThis.__kidmaisPgPool = { query: (...args) => pool.query(...args), connect: async () => {
            const c = await pool.connect();
            return { query: async (sql, values) => {
                const result = await c.query(sql, values);
                if (sql === 'BEGIN') {
                    backends.add((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);
                    if (++ready === inputs.length) release();
                    await barrier;
                }
                return result;
            }, release: () => c.release() };
        } };
        try {
            const result = await Promise.allSettled(inputs.map(accept));
            assert.equal(backends.size, inputs.length, 'Distinct real transactions must begin before either can proceed');
            return result;
        } finally { clearTimeout(timer); globalThis.__kidmaisPgPool = pool; }
    }

    const rs = loadTs('../lib/fechamentos/services/revisao-operacional.service.ts');
    const ri = loadTs('../lib/contratos/services/revisao-inicial.ts');
    const year = randomInt(2150, 2900);
    const day = n => `${year}-10-${String(n).padStart(2,'0')}`;
    const intervals = rows => [...new Set(rows.map(x=>[String(x.data),x.horario_inicio,x.horario_fim,x.fechamento_id].join('|')))].sort();
    const edition = async vid => (await pool.query('SELECT * FROM contrato_edicoes WHERE contrato_versao_id=$1',[vid])).rows[0];
    const material = async vid => JSON.stringify((await pool.query(`SELECT v.snapshot,v.snapshot_hash,v.documento_pdf_hash,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM contrato_assinaturas a WHERE a.contrato_versao_id=v.id) assinaturas,
        (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM contrato_documentos d WHERE d.contrato_versao_id=v.id) documentos
        FROM contrato_versoes v WHERE v.id=$1`,[vid])).rows);
    const operation = async b => JSON.stringify((await pool.query(`SELECT to_jsonb(f) fechamento,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM fechamento_adicionais a WHERE a.fechamento_id=f.id) adicionais,
        (SELECT jsonb_agg(to_jsonb(ft) ORDER BY ft.id) FROM festas ft WHERE ft.contrato_id=$2) festas
        FROM fechamentos f WHERE f.id=$1`,[b.fid,b.cid])).rows);
    const source = async (b,vid) => await rs.fontesPreparacao(vid) ?? await ri.fonteDaRevisaoInicial(
        await loadTs('../lib/contratos/repositories/index.ts').buscarVersaoPorId(vid),await cs.fontesEdicao(b.fid),pool);
    const financial = async () => {
        const out={};
        const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename='pagamentos' OR tablename LIKE 'pagamento_%') ORDER BY tablename")).rows;
        for(const {tablename} of tables){assert.match(tablename,/^[a-z_]+$/);out[tablename]=(await pool.query(`SELECT to_jsonb(t)::text value FROM ${tablename} t ORDER BY to_jsonb(t)::text`)).rows;}
        return JSON.stringify(out);
    };
    async function payload(b,vid,patch={}) {
        const src=await source(b,vid),f=src.fechamento;
        const fields=Object.fromEntries(['buffetSalgados','buffetBebidas','buffetDoces','buffetBolo','buffetOutros','buffetLembrancinha','buffetEmpratado','buffetBombom','observacoesEquipe'].map(k=>[k,f[k]??'']));
        return {acao:'editar_festa',revisao:(await edition(vid)).revisao,fonteHash:src.fonteHash,motivo:'Synthetic V2 field edit',
            pacoteId:f.pacoteId,convidados:f.convidados,dataEvento:f.dataEvento,configuracaoAgendaId:f.configuracaoAgendaId,
            horarioInicio:f.horarioInicio.slice(0,5),horarioFim:f.horarioFim.slice(0,5),adicionais:src.adicionais,
            idadeAniversarianteEvento:f.idadeAniversarianteEvento,temaFesta:f.temaFesta??'',buffetStatus:f.buffetStatus,...fields,
            comercial:{confirmarAprovacao:true,forma:'CARTAO_CIELO',baseNegociada:null,condicaoPix:null},...patch};
    }
    async function faultDuring(work,match) {
        let triggered=false;
        globalThis.__kidmaisPgPool={query:(...args)=>pool.query(...args),connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(sql,values)=>{
            if(match(String(sql),values)){triggered=true;return c.query('SELECT 1/0');}return c.query(sql,values);
        }};}};
        try{await assert.rejects(work(),e=>e.code==='22012');assert(triggered);}finally{globalThis.__kidmaisPgPool=pool;}
    }
    const premium=(await pool.query("SELECT id FROM pacotes WHERE codigo='PREMIUM'")).rows[0].id;
    const morning=(await pool.query("SELECT id FROM configuracao_agenda WHERE codigo='TURNO_1'")).rows[0].id;
    for(const formalized of [false,true]) {
        const tag=formalized?'V1 dupla assinatura':'V1 assinatura Kidmais';
        const b=await prepare(day(formalized?2:1));if(formalized)await accept(await acceptance(b.cid));
        if(formalized){
            const payments=loadTs('../lib/pagamentos/services/pagamento.service.ts');
            const value=Number((await pool.query("SELECT snapshot->'comercial'->>'valorFinalContrato' total FROM contrato_versoes WHERE id=$1",[b.vid])).rows[0].total);
            const pc={...ctx(),usuarioId:admin.usuarioId,origem:'TESTE_019'};
            const p=(await payments.criarPagamentoDoFechamento({fechamentoId:b.fid,plano:{meioPagamento:'PIX',modalidade:'AVISTA',parcelas:[{valor:value,vencimento:b.day,confirmaReserva:true}]}},pc)).detalhe;
            await payments.registrarRecebimentoPagamento({pagamentoId:p.pagamento.id,meioPagamento:'PIX',valorBruto:value,chaveIdempotencia:randomUUID(),alocacoes:[{parcelaId:p.parcelas[0].id,valor:value}]},pc);
        }
        const financialBefore=await financial();
        const oldProof=await material(b.vid),oldOperation=await operation(b),oldOccupancy=await occupied(b.day);
        const request=formalized?{acao:'nova_versao',tipo:'NOVA_VERSAO',motivo:'Synthetic V2 isolated edition',chaveCriacao:randomUUID()}:
            {acao:'substituir_preparacao',motivo:'Synthetic V2 isolated edition',chaveCriacao:randomUUID()};
        const next=(await op(b.vid,request)).versaoId;
        await check(`${tag}: active unsigned V2 and creation retry`,async()=>{
            assert.equal((await edition(next)).estado,'EM_ELABORACAO');assert.equal((await op(b.vid,request)).versaoId,next);
            await assert.rejects(op(b.vid,{acao:'salvar',revisao:1,observacoesDocumentais:'must not change V1'}));
        });
        const destination=day(formalized?12:11);
        for(const [field,change,validate] of [
            ['convidados',{convidados:60},s=>assert.equal(s.evento.convidados,60)],
            ['pacote',{pacoteId:premium,buffetStatus:'PENDENTE'},s=>assert.equal(s.evento.pacote.codigo,'PREMIUM')],
            ['data/horario',{dataEvento:destination,configuracaoAgendaId:morning,horarioInicio:'11:00',horarioFim:'15:00'},s=>{assert.equal(s.evento.data,destination);assert.equal(s.evento.horarioInicio.slice(0,5),'11:00');}],
            ['adicionais/buffet',{adicionais:[{codigo:'MESA_CAFE',quantidade:1}],buffetStatus:'DEFINIDO',buffetBolo:'Chocolate sintético'},s=>{assert.equal(s.contratacao.adicionais.length,1);assert.equal(s.contratacao.buffet.bolo,'Chocolate sintético');}]
        ]) await check(`${tag}: ${field} persists only in V2`,async()=>{
            const p=await payload(b,next,change);await op(next,p);
            const stored=(await pool.query('SELECT snapshot FROM contrato_versoes WHERE id=$1',[next])).rows[0].snapshot;validate(stored);
            assert.equal(await material(b.vid),oldProof);assert.equal(await operation(b),oldOperation);assert.deepEqual(intervals(await occupied(b.day)),intervals(oldOccupancy));
            assert.equal(await financial(),financialBefore);
            await assert.rejects(op(next,p));assert.equal((await pool.query('SELECT count(*)::int n FROM contrato_versoes WHERE contrato_id=$1',[b.cid])).rows[0].n,2);
        });
        await check(`${tag}: reopening and documentary save keep proposed fields and differences`,async()=>{
            const src=await source(b,next);assert.equal(src.fechamento.convidados,60);assert.equal(src.fechamento.dataEvento,destination);assert.equal(src.adicionais[0].codigo,'MESA_CAFE');
            await op(next,{acao:'salvar',revisao:(await edition(next)).revisao,observacoesDocumentais:'Synthetic V2 notes'});
            const paths=(await edition(next)).alteracoes.campos.map(x=>x.campo);
            for(const path of ['evento.convidados','evento.pacote.id','evento.data','contratacao.adicionais','contratacao.buffet.bolo'])assert(paths.includes(path),path);
            assert.equal((await source(b,next)).fechamento.convidados,60);
            assert.equal(await operation(b),oldOperation);
        });
        await check(`${tag}: save rollback restores entire V2 and operation`,async()=>{
            const before=await material(next),edBefore=await edition(next),occ=await occupied(destination);
            const p=await payload(b,next,{convidados:70});
            await faultDuring(()=>op(next,p),(sql,values)=>/INSERT INTO (public\.)?auditoria/.test(sql)&&values?.includes('CONTRATO_EDICAO_SALVA'));
            assert.equal(await material(next),before);assert.deepEqual(await edition(next),edBefore);assert.equal(await operation(b),oldOperation);assert.deepEqual(await occupied(destination),occ);
        });
        await check(`${tag}: destination conflict rolls back draft without damaging either version`,async()=>{
            const conflict=day(formalized?22:21);await pool.query("INSERT INTO bloqueios_agenda(data,dia_inteiro,motivo) VALUES($1,true,'Synthetic conflict')",[conflict]);
            const before=await material(next);await assert.rejects(op(next,await payload(b,next,{dataEvento:conflict})));
            assert.equal(await material(next),before);assert.equal(await material(b.vid),oldProof);assert.equal(await operation(b),oldOperation);
        });
        await check(`${tag}: new Kidmais signature mandatory; signed V2 immutable`,async()=>{
            await assert.rejects(op(next,{acao:'liberar',revisao:(await edition(next)).revisao}));
            await freeze(next);assert.equal((await edition(next)).estado,'AGUARDANDO_CLIENTE');
            const signed=await material(next);await assert.rejects(op(next,await payload(b,next,{convidados:80})));
            await assert.rejects(op(next,{acao:'salvar',revisao:(await edition(next)).revisao,observacoesDocumentais:'forbidden'}));
            assert.equal(await material(next),signed);assert.equal(await operation(b),oldOperation);
        });
        const input=await acceptance(b.cid);
        if(!formalized)await check('V2 inicial: conflito posterior ao PDF recusa aceite; data antiga não impede novo destino',async()=>{
            const before=await material(next),ed=await edition(next);
            const block=(await pool.query("INSERT INTO bloqueios_agenda(data,dia_inteiro,motivo) VALUES($1,true,'Synthetic conflict after PDF') RETURNING id",[destination])).rows[0].id;
            await assert.rejects(accept(input));assert.equal(await material(next),before);assert.deepEqual(await edition(next),ed);assert.equal(await operation(b),oldOperation);
            await pool.query('UPDATE bloqueios_agenda SET ativo=false WHERE id=$1',[block]);
            await pool.query("INSERT INTO bloqueios_agenda(data,dia_inteiro,motivo) VALUES($1,true,'Synthetic old interval now used elsewhere')",[b.day]);
        });
        await check(`${tag}: formalization rollback preserves operation, proofs and occupancy`,async()=>{
            const before=await material(next),occ=await occupied(destination);
            await faultDuring(()=>accept(input),(sql,values)=>/INSERT INTO (public\.)?auditoria/.test(sql)&&values?.includes('CONTRATO_ACEITO_CLIENTE'));
            assert.equal(await material(next),before);assert.equal(await operation(b),oldOperation);assert.deepEqual(await occupied(destination),occ);
        });
        await check(`${tag}: double signature atomically promotes V2, unique Festa and retry`,async()=>{
            const r=await concurrentAccepts([input,input]);assert.equal(r.filter(x=>x.status==='fulfilled').length,2,r.map(x=>x.reason?.message).join(','));
            await accept(input);assert.equal(await count(b.cid),1);assert.equal(await material(b.vid),oldProof);
            const ft=(await pool.query('SELECT id FROM festas WHERE contrato_id=$1',[b.cid])).rows[0];await festa.consultarFestas(ctx(),ft.id);
            const f=(await pool.query('SELECT convidados,data_evento::text,horario_inicio,pacote_id FROM fechamentos WHERE id=$1',[b.fid])).rows[0];
            assert.equal(f.convidados,60);assert.equal(f.data_evento,destination);assert.equal(f.horario_inicio.slice(0,5),'11:00');assert.equal(f.pacote_id,premium);
            assert(!(await occupied(b.day)).some(x=>x.fechamento_id===b.fid));assert.equal((await occupied(destination)).length,1);
            assert.equal(await financial(),financialBefore);
        });
    }
    await check('V2 substituída por V3 conserva proposta, V1/V2 e revoga novamente acesso antigo',async()=>{
        const b=await prepare(day(4));const original=await material(b.vid),before=await operation(b);
        const request=()=>({acao:'substituir_preparacao',motivo:'Synthetic successive initial revision',chaveCriacao:randomUUID()});
        const v2=(await op(b.vid,request())).versaoId;await op(v2,await payload(b,v2,{convidados:60}));await freeze(v2);
        const oldInput=await acceptance(b.cid),proof=await material(v2);
        const v3=(await op(v2,request())).versaoId;
        assert.equal((await source(b,v3)).fechamento.convidados,60);
        await op(v3,await payload(b,v3,{convidados:70}));
        assert.equal((await source(b,v3)).fechamento.convidados,70);
        assert.equal(await material(b.vid),original);assert.equal(await material(v2),proof);assert.equal(await operation(b),before);
        await assert.rejects(accept(oldInput),e=>e.code==='VERSAO_CONTRATO_DIVERGENTE');
        await freeze(v3);await accept(await acceptance(b.cid));assert.equal(await count(b.cid),1);
    });
    console.log(JSON.stringify({status:'PASS',checks:results.length}));
} catch(error) {
    console.error(JSON.stringify({status:'FAIL',checksPassed:results.length,code:error?.code??'ASSERTION',message:error?.message}));process.exitCode=1;
} finally {delete globalThis.__kidmaisPgPool;await pool.end();}
