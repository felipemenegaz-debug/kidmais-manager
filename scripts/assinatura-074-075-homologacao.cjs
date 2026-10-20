/* eslint-disable @typescript-eslint/no-require-imports */
/** Alvo fixo autorizado em 09/10/2026. Nunca lê .env/DATABASE_URL nem cria conexões herdadas.
 * --preparar: banco vazio + dependências sintéticas mínimas + migrations reais 067/068/074/075.
 * --testar: ensaios de integração com PostgreSQL real e provedor/e-mail falsos.
 * --testar-completo: mesmos ensaios + falhas/cancelamento no banco completo autorizado, com fixtures reais.
 * --retomar-completo e --cancelamento-completo: retomadas delimitadas, sem limpar histórico.
 * Não testa HTTP/autenticação ponta a ponta; não executa chamadas externas.
 */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client, Pool } = require('pg');
const retomarCompleto = process.argv[2] === '--retomar-completo';
const somenteCancelamento = process.argv[2] === '--cancelamento-completo';
const completo = process.argv[2] === '--testar-completo' || retomarCompleto || somenteCancelamento;
const DATABASE = completo ? 'kidmais_renovacao_075_completa' : 'kidmais_renovacao_075_sintetica';
const CLUSTER = 'kidmais_renovacao_075';
const config = { host:'127.0.0.1', port:55475, user:CLUSTER, password:'senha-sintetica-nao-utilizada', database:DATABASE,
    ssl:false, connectionTimeoutMillis:5000, application_name:'kidmais-homologacao-074-075' };
const sql = p => readFileSync(p,'utf8');
const M = n => `database/migrations/${n}`;
const UP74 = M('20261009_074a_planos_comerciais.sql'), UP75 = M('20261009_075_renovacao_fundador.sql');
const DOWN74 = 'database/rollback/20261009_074a_planos_comerciais_down.sql', DOWN75 = 'database/rollback/20261009_075_renovacao_fundador_down.sql';
const PRE74 = 'database/checks/20261009_074a_precheck.sql', POS74 = 'database/checks/20261009_074a_postcheck.sql';
const PRE75 = 'database/checks/20261009_075_precheck.sql', POS75 = 'database/checks/20261009_075_postcheck.sql';
global.fetch = async () => { throw new Error('HTTP proibido nesta homologação.'); };

async function identidade(c, database = DATABASE) {
    const r = (await c.query(`SELECT current_database() AS db, current_user AS papel, inet_server_port() AS porta,
        host(inet_server_addr()) AS endereco, current_setting('cluster_name') AS cluster`)).rows[0];
    assert.deepEqual(r,{ db:database,papel:CLUSTER,porta:55475,endereco:'127.0.0.1',cluster:CLUSTER });
}
async function conectar(database = DATABASE) {
    const c = new Client({ ...config,database }); await c.connect(); await identidade(c,database);
    await c.query("SET statement_timeout = '15s'"); await c.query("SET lock_timeout = '5s'"); return c;
}
async function recusar(c, comando, params = [], re) {
    await c.query('SAVEPOINT deve_recusar');
    let erro;
    try { await c.query(comando,params); } catch (e) { erro = e; }
    await c.query('ROLLBACK TO SAVEPOINT deve_recusar');
    assert.ok(erro,'Operação deveria ser recusada'); if (re) assert.match(erro.message,re);
}
async function preparar(continuar = false) {
    if (!continuar) {
    const admin = await conectar('postgres');
    try {
        assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[DATABASE])).rowCount,0,'Banco já existe; não sobrescrever.');
        await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally { await admin.end(); }
    }
    const c = await conectar();
    try {
        if (!continuar) {
        await c.query(`CREATE TABLE empresas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), codigo text UNIQUE, nome text NOT NULL, status text NOT NULL);
          CREATE TABLE usuarios_administrativos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text NOT NULL, email text NOT NULL, ativo boolean NOT NULL DEFAULT true);
          CREATE TABLE memberships (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), empresa_id uuid REFERENCES empresas(id), usuario_id uuid REFERENCES usuarios_administrativos(id), papel text, status text);
          CREATE TABLE plataforma_empresas_cadastro (empresa_id uuid PRIMARY KEY REFERENCES empresas(id), nome_empresarial text, documento_fiscal text);
          CREATE TABLE auditoria (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ator_tipo text, usuario_id uuid, acao text, entidade_tipo text, entidade_id uuid,
            dados_antes jsonb, dados_depois jsonb, justificativa text, origem text, request_id uuid, ip inet);`);
        await c.query(sql(M('20261006_067_modelo_comercial_empresa.sql')));
        await c.query(sql(M('20261007_068_cobranca_assinatura.sql')));
        const legado = randomUUID();
        await c.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,'legado-sintetico','Legado sintético','ATIVA')",[legado]);
        await c.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim) VALUES($1,'TESTE',clock_timestamp(),clock_timestamp()+interval '15 days')",[legado]);
        }
        assert.equal((await c.query("SELECT to_regclass('public.assinatura_contratacoes') AS tabela")).rows[0].tabela,null);
        const legados = (await c.query("SELECT a.* FROM empresa_assinaturas a JOIN empresas e ON e.id=a.empresa_id WHERE e.codigo='legado-sintetico'")).rows;
        assert.equal(legados.length,1);
        const antes = legados[0], legado = antes.empresa_id;
        for (const p of [PRE74,UP74,POS74,PRE75,UP75,POS75,DOWN75,DOWN74,PRE74,UP74,POS74,PRE75,UP75,POS75]) await c.query(sql(p));
        const depois = (await c.query('SELECT * FROM empresa_assinaturas WHERE empresa_id=$1',[legado])).rows[0]; delete depois.contratacao_atual_id;
        assert.deepEqual(depois,antes,'Legado deve permanecer literalmente intacto');
        for (const p of [UP74,UP75]) {
            await assert.rejects(c.query(sql(p))); await c.query('ROLLBACK');
        }
        console.log('PASS preparo: identidade, 067/068, 074/075 up/down/reaplicação, pre/postchecks e legado intacto.');
    } finally { await c.end(); }
}

async function testar() {
    const { prepararOferta, confirmarOfertaPaga } = await import('../lib/assinatura/ofertas.ts');
    const { repositorioRenovacao, consultarRenovacao } = await import('../lib/assinatura/renovacao-repositorio.ts');
    const { processarRenovacao } = await import('../lib/assinatura/renovacao-fundador.ts');
    const { travaPorEmpresa } = await import('../lib/assinatura/cobranca.ts');
    const pool = new Pool({ ...config,max:8 });
    const c = await conectar();
    let passou = 0;
    const reportar = nome => { passou++; console.log(`PASS ${passou}: ${nome}`); };
    const tx = async f => {
        const p = await pool.connect();
        try { await identidade(p); await p.query('BEGIN'); await p.query("SET LOCAL lock_timeout='5s'"); await p.query("SET LOCAL statement_timeout='15s'");
            const r = await f(p); await p.query('COMMIT'); return r;
        } catch (e) { await p.query('ROLLBACK'); throw e; } finally { p.release(); }
    };
    const pedido = { plano:'essencial',ciclo:'MENSAL',valorEsperadoCentavos:11820,versao:'2026-10-09' };
    let contador = 0;
    const novo = async (p, empresa = randomUUID()) => {
        const usuario = randomUUID();
        // Documento sintético, único por execução; nenhum CNPJ real é utilizado.
        const documento = BigInt(`0x${randomUUID().replaceAll('-','').slice(0,11)}`).toString().padStart(14,'0');
        if (completo) {
            await p.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,'Buffet sintético','PROVISIONAMENTO')",[empresa,`t-${empresa}`]);
            await p.query("UPDATE empresas SET status='ATIVA' WHERE id=$1",[empresa]);
            const b64 = n => randomBytes(n).toString('base64').replace(/=+$/, '');
            const senha = `scrypt$v=1$N=131072$r=8$p=1$${b64(16)}==$${b64(64)}==`;
            await p.query("INSERT INTO usuarios_administrativos(id,nome,email,cargo,senha_hash,papel,ativo) VALUES($1,'Gestão sintética',$2,'Fixture',$3,'REPRESENTANTE_AUTORIZADO',true)",[usuario,`sintetico-${usuario}@example.invalid`,senha]);
            await p.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status,vigente_desde) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','PENDENTE',clock_timestamp())",[empresa,usuario]);
            await p.query("UPDATE memberships SET status='ATIVA' WHERE empresa_id=$1 AND usuario_id=$2",[empresa,usuario]);
        } else {
            await p.query("INSERT INTO empresas(id,codigo,nome,status) VALUES($1,$2,'Buffet sintético','ATIVA')",[empresa,`t-${empresa}`]);
            await p.query("INSERT INTO usuarios_administrativos(id,nome,email) VALUES($1,'Gestão sintética',$2)",[usuario,`sintetico-${++contador}@example.invalid`]);
            await p.query("INSERT INTO memberships(empresa_id,usuario_id,papel,status) VALUES($1,$2,'REPRESENTANTE_AUTORIZADO','ATIVA')",[empresa,usuario]);
        }
        await p.query("INSERT INTO empresa_assinaturas(empresa_id,situacao,teste_inicio,teste_fim,documento_teste) VALUES($1,'TESTE',clock_timestamp(),clock_timestamp()+interval '15 days',$2)",[empresa,documento]);
        return { empresa,usuario,documento };
    };
    try {
        if (somenteCancelamento) {
            const regs=(await c.query("SELECT empresa_id FROM assinatura_renovacoes WHERE estado='REGULAR'")).rows;
            assert.equal(regs.length,1);
            const empresa=regs[0].empresa_id;
            const repo=repositorioRenovacao(tx);
            const antesOutra=JSON.stringify((await c.query('SELECT * FROM empresa_assinaturas WHERE empresa_id<>$1 ORDER BY empresa_id',[empresa])).rows);
            const periodo=(await c.query('SELECT periodo_atual_fim FROM empresa_assinaturas WHERE empresa_id=$1',[empresa])).rows[0].periodo_atual_fim;
            await tx(p=>p.query("UPDATE empresa_assinaturas SET situacao='CANCELADA_FIM_PERIODO',cancelada_em=clock_timestamp() WHERE empresa_id=$1",[empresa]));
            const proibido=async()=>{throw new Error('Chamada externa após cancelamento');};
            const deps={repositorio:repo,travar:travaPorEmpresa(tx),simular:false,agora:()=>new Date(),origem:'https://kidmais.example',enviar:proibido,provedor:new Proxy({}, {get:()=>proibido})};
            assert.equal(await processarRenovacao(empresa,deps),'CANCELADA');
            assert.equal(await processarRenovacao(empresa,deps),'CANCELADA');
            assert.equal((await repo.ler(empresa)).registro.estado,'CANCELADA');
            assert.deepEqual((await c.query('SELECT periodo_atual_fim FROM empresa_assinaturas WHERE empresa_id=$1',[empresa])).rows[0].periodo_atual_fim,periodo);
            assert.equal(JSON.stringify((await c.query('SELECT * FROM empresa_assinaturas WHERE empresa_id<>$1 ORDER BY empresa_id',[empresa])).rows),antesOutra);
            await c.query(sql(POS74));await c.query(sql(POS75));
            reportar('cancelamento idempotente, nenhuma chamada externa, período pago e outras empresas preservados; postchecks aprovados');
            return;
        }
        let resultados, disputantes;
        if (!retomarCompleto) {
        if (completo) assert.equal((await c.query('SELECT count(*)::int AS n FROM assinatura_contratacoes')).rows[0].n,0,'Ensaio completo exige base sem contratações: não repetir nem apagar histórico.');
        // Sem efeitos persistidos: constraints, isenção e integridade da confirmação.
        await c.query('BEGIN');
        const a = await novo(c), b = await novo(c);
        const oferta = await prepararOferta(c,a.empresa,a.usuario,pedido);
        assert.equal((await prepararOferta(c,a.empresa,a.usuario,pedido)).id,oferta.id);
        await recusar(c,'UPDATE assinatura_contratacoes SET valor_final_centavos=1 WHERE id=$1',[oferta.id],/imutável/);
        await recusar(c,'DELETE FROM assinatura_contratacoes WHERE id=$1',[oferta.id],/apagado/);
        await recusar(c,'TRUNCATE assinatura_contratacoes',[],/foreign key constraint/);
        await recusar(c,"UPDATE empresa_assinaturas SET plano='ESSENCIAL',contratacao_atual_id=$2 WHERE empresa_id=$1",[a.empresa,oferta.id],/confirmada/);
        await recusar(c,"UPDATE empresa_assinaturas SET plano='ESSENCIAL',contratacao_atual_id=$2 WHERE empresa_id=$1",[b.empresa,oferta.id]);
        await c.query('INSERT INTO assinatura_isencoes(empresa_id,documento_verificado,motivo,concedida_por) VALUES($1,$2,$3,$4)',[b.empresa,b.documento,'Teste de isenção',b.usuario]);
        await assert.rejects(prepararOferta(c,b.empresa,b.usuario,pedido),/isenção permanente/);
        await c.query('ROLLBACK'); reportar('oferta idempotente, snapshot imutável, plano sem pagamento recusado e isenção');

        // Vinte conexões concorrentes não são necessárias: 19 reservas e duas disputando a última.
        disputantes = [];
        await c.query('BEGIN');
        const ocupadas = (await c.query("SELECT count(*)::int AS n FROM assinatura_fundadores WHERE estado<>'LIBERADA'")).rows[0].n;
        for (let i=ocupadas;i<19;i++) { const f = await novo(c); await prepararOferta(c,f.empresa,f.usuario,pedido); }
        for (let i=0;i<2;i++) disputantes.push(await novo(c));
        await c.query('COMMIT');
        resultados = await Promise.allSettled(disputantes.map(f => tx(p => prepararOferta(p,f.empresa,f.usuario,pedido))));
        assert.equal(resultados.filter(x=>x.status==='fulfilled').length,1);
        assert.equal(resultados.filter(x=>x.status==='rejected' && x.reason.code==='FUNDADOR_AGUARDANDO').length,1);
        assert.equal((await c.query("SELECT count(*)::int AS n FROM assinatura_fundadores WHERE estado<>'LIBERADA'")).rows[0].n,20);
        reportar('concorrência real pela 20ª vaga: uma concessão, outra aguarda, teto preservado');
        } else {
            assert.equal((await c.query("SELECT count(*)::int AS n FROM assinatura_contratacoes WHERE estado='EM_ABERTO'")).rows[0].n,20);
            assert.equal((await c.query('SELECT count(*)::int AS n FROM assinatura_renovacoes')).rows[0].n,0);
            const ultimo = (await c.query('SELECT c.* FROM assinatura_contratacoes c JOIN assinatura_fundadores f ON f.id=c.fundador_id WHERE f.vaga=20 AND f.estado=\'RESERVADA\'')).rows;
            assert.equal(ultimo.length,1);
            resultados=[{status:'fulfilled',value:ultimo[0]}];
            disputantes=[{empresa:ultimo[0].empresa_id}];
            console.log('RETOMADA: 20 reservas preservadas; grupos 1 e 2 aprovados na execução anterior.');
        }

        const vencedora = resultados.find(x=>x.status==='fulfilled').value;
        const dono = disputantes.find(x=>x.empresa===vencedora.empresa_id);
        const sub = { id:`sub_${dono.empresa}`,customer:`cus_${dono.empresa}`,externalReference:dono.empresa,cycle:'MONTHLY',status:'ACTIVE',deleted:false,valorCentavos:11820 };
        const hoje = (await c.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS dia")).rows[0].dia;
        const pago = { id:`pay_${dono.empresa}`,status:'RECEIVED',dueDate:hoje,paymentDate:hoje,invoiceUrl:null,deleted:false,valorCentavos:11820,assinaturaId:sub.id,clienteId:sub.customer,billingType:'PIX' };
        if (completo) {
            await assert.rejects(tx(p => confirmarOfertaPaga(p,dono.empresa,sub,[{...pago,valorCentavos:1}],sub.customer)),{code:'PAGAMENTO_OFERTA_DIVERGENTE'});
            await assert.rejects(tx(p => confirmarOfertaPaga(p,dono.empresa,sub,[{...pago,clienteId:'cus_outra_empresa'}],sub.customer)),{code:'PAGAMENTO_OFERTA_DIVERGENTE'});
            assert.equal((await c.query('SELECT estado FROM assinatura_contratacoes WHERE id=$1',[vencedora.id])).rows[0].estado,'EM_ABERTO');
            reportar('pagamentos com valor ou pagador divergentes não confirmam contrato');
        }
        await tx(async p => {
            await p.query('SELECT id FROM empresas WHERE id=$1 FOR UPDATE',[dono.empresa]);
            await p.query('SELECT empresa_id FROM empresa_assinaturas WHERE empresa_id=$1 FOR UPDATE',[dono.empresa]);
            const x = await confirmarOfertaPaga(p,dono.empresa,sub,[pago],sub.customer);
            await p.query("UPDATE empresa_assinaturas SET situacao='ATIVA',ciclo='MENSAL',plano=$2,contratacao_atual_id=$3,provedor='ASAAS',provedor_cliente_id=$4,provedor_assinatura_id=$5,periodo_atual_fim=clock_timestamp()+interval '1 month' WHERE empresa_id=$1",[dono.empresa,x.plano,x.id,sub.customer,sub.id]);
        });
        assert.equal(await tx(p => confirmarOfertaPaga(p,dono.empresa,sub,[pago],sub.customer)),null);
        reportar('confirmação atômica, FK diferida e reentrega idempotente');

        // O relógio real impede simular envio daqui a 11 meses sem adulterar triggers.
        // Exercita repository/guardas com registro explícito de renovação cujo aviso é hoje.
        const repo = repositorioRenovacao(tx);
        const ctx = await repo.ler(dono.empresa); assert.ok(ctx && ctx.destinatarioValido);
        const dataRegular = new Date(`${hoje}T12:00:00Z`); dataRegular.setUTCDate(dataRegular.getUTCDate()+30);
        const id = randomUUID(), diaRegular = dataRegular.toISOString().slice(0,10);
        await repo.criar({ id,empresaId:dono.empresa,contratacaoId:ctx.contratacaoId,destinatarioId:ctx.destinatarioId,
            primeiroVencimento:hoje,primeiraDataRegular:diaRegular,mensagem:{ para:ctx.email,assunto:'Teste',texto:'Teste sintético',html:'<p>Teste</p>',idempotencia:`kidmais-renovacao/${id}` },estado:'PENDENTE',avisoTentadoEm:null,avisoEnviadoEm:null,precoAplicadoEm:null,ultimoErro:null });
        let envios=0,puts=0, tentativasEnvio=0;
        const mensagens = new Set();
        sub.nextDueDate=diaRegular;
        const parcela={ ...pago,id:`renew_${dono.empresa}`,dueDate:diaRegular,status:'PENDING' };
        const deps={ repositorio:repo,origem:'https://kidmais.example',agora:()=>new Date(),simular:false,travar:travaPorEmpresa(tx),
            enviar:async mensagem=>{ tentativasEnvio++; if (!mensagens.has(mensagem.idempotencia)) { mensagens.add(mensagem.idempotencia); envios++; } assert.equal((await repo.ler(dono.empresa)).registro.estado,'AVISANDO'); if(completo && tentativasEnvio===1) throw new Error('Resposta de envio perdida'); return { provedor:'arquivo',idExterno:'sintetico_1' }; },
            provedor:{ obterAssinatura:async()=>({...sub}),obterCobranca:async pid=>({...(pid===pago.id?pago:parcela)}),listarCobrancasDaAssinatura:async()=>[{...pago},{...parcela}],
                atualizarValorAssinatura:async(_i,v)=>{ puts++; sub.valorCentavos=v; if(completo && puts===1) throw new Error('Resposta de preço perdida'); return {...sub}; },atualizarValorCobranca:async(_p,v)=>{parcela.valorCentavos=v;return {...parcela};},
                suspenderGeracao:async()=>{throw new Error('Suspensão inesperada');} } };
        if (completo) {
            assert.equal(await processarRenovacao(dono.empresa,deps),'ENVIO_INCERTO');
            assert.equal((await repo.ler(dono.empresa)).registro.estado,'AVISANDO');
            await assert.rejects(processarRenovacao(dono.empresa,deps),/Resposta de preço perdida/);
            assert.equal((await repo.ler(dono.empresa)).registro.estado,'APLICANDO');
            assert.equal(envios,1); assert.equal(puts,1);
            reportar('respostas perdidas de e-mail/preço deixam intenção persistida recuperável');
        }
        const dupla=await Promise.allSettled([processarRenovacao(dono.empresa,deps),processarRenovacao(dono.empresa,deps)]);
        assert.ok(dupla.some(r=>r.status==='fulfilled' && r.value==='REGULAR'));
        for(const r of dupla) if(r.status==='rejected') assert.equal(r.reason.code,'CONTRATACAO_EM_ANDAMENTO');
        await processarRenovacao(dono.empresa,deps);
        assert.equal(envios,1);assert.equal(puts,1);
        assert.equal((await repo.ler(dono.empresa)).registro.estado,'REGULAR');
        assert.equal((await consultarRenovacao(c,dono.empresa)).avisoEnviado,true);
        reportar('repository real, envio após commit, concorrência de workers, retomada e DTO do aviso');

        await c.query('BEGIN');
        await recusar(c,"UPDATE assinatura_renovacoes SET mensagem=mensagem || '{\"para\":\"outro@example.invalid\"}'::jsonb WHERE id=$1",[id],/imutáveis/);
        await recusar(c,"UPDATE assinatura_renovacoes SET aviso_enviado_em=clock_timestamp()+interval '2 days' WHERE id=$1",[id],/imutáveis/);
        await recusar(c,'DELETE FROM assinatura_renovacoes WHERE id=$1',[id],/apagado/);
        await recusar(c,'TRUNCATE assinatura_renovacoes',[],/apagado/);
        await c.query('ROLLBACK');
        await assert.rejects(c.query(sql(DOWN75)),/rollback recusado/);await c.query('ROLLBACK');
        await assert.rejects(c.query(sql(DOWN74)),/rollback recusado/);await c.query('ROLLBACK');
        reportar('guardas de histórico e rollbacks com dados recusados');
        const antes = JSON.stringify((await c.query('SELECT * FROM assinatura_renovacoes ORDER BY id')).rows);
        await processarRenovacao(dono.empresa,{ ...deps,simular:true,enviar:async()=>{throw new Error('Envio proibido');} });
        assert.equal(JSON.stringify((await c.query('SELECT * FROM assinatura_renovacoes ORDER BY id')).rows),antes);
        assert.equal(envios,1);assert.equal(puts,1);
        await c.query(sql(POS74));await c.query(sql(POS75));
        reportar('simulação sem escrita/envio/mutação e postchecks finais');
        if (completo) {
            const antesOutra = JSON.stringify((await c.query('SELECT * FROM empresa_assinaturas WHERE empresa_id<>$1 ORDER BY empresa_id',[dono.empresa])).rows);
            await tx(p=>p.query("UPDATE empresa_assinaturas SET situacao='CANCELADA_FIM_PERIODO',cancelada_em=clock_timestamp() WHERE empresa_id=$1",[dono.empresa]));
            const naoChamar = async()=>{throw new Error('Provedor não deve ser chamado após cancelamento');};
            assert.equal(await processarRenovacao(dono.empresa,{...deps,enviar:naoChamar,provedor:{...deps.provedor,obterAssinatura:naoChamar}}),'CANCELADA');
            assert.equal((await repo.ler(dono.empresa)).registro.estado,'CANCELADA');
            assert.equal(JSON.stringify((await c.query('SELECT * FROM empresa_assinaturas WHERE empresa_id<>$1 ORDER BY empresa_id',[dono.empresa])).rows),antesOutra);
            assert.equal(envios,1); assert.equal(puts,1);
            reportar('cancelamento impede renovação e mantém assinaturas de outras empresas intactas');
        }
        console.log(`PASS ${passou} grupos de integração PostgreSQL. Schema ${completo ? 'completo' : 'reduzido'}, dados sintéticos, sem HTTP.`);
    } finally { await c.query('ROLLBACK').catch(()=>{});await c.end();await pool.end(); }
}
const modo=process.argv[2];
if (!['--preparar','--continuar-preparo','--testar','--testar-completo','--retomar-completo','--cancelamento-completo'].includes(modo) || process.argv.length!==3) throw new Error('Modo inválido para o alvo fixo autorizado.');
(modo==='--testar'||completo?testar():preparar(modo==='--continuar-preparo')).catch(e=>{console.error('FAIL',e.code??e.name,e.message,e.stack);process.exitCode=1;});
