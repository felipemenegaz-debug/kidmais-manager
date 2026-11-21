import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { cenario, representante, id, cpfValido, poolNaTransacao, ambienteAssinatura, catalogoNativo, carregar, importacao, completarCliente, integrar, decisoes, PARCIAL, type Servico } from '../../scripts/integracao-importados-test-support.ts';
import { carregarComBanco, cliente, comercial, executor, fechamento, porTransacao } from '../marketing/harness-postgres.ts';
import { travarConfiguracaoAgenda } from '../agenda/trava-configuracao.ts';

async function criarDestinoRetido(db: Client) {
  const c = await cenario(db, 0);
  const restaurarPool = poolNaTransacao(db);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    await travarConfiguracaoAgenda(executor(db), c.empresa, {modo:'COMPARTILHADA', linha:'KEY_SHARE'});
    const nativo = await catalogoNativo(db, c);
    const servico = carregar<Servico>('lib/contratos/integracao-importados/servico.ts');
    const {coreNativo} = carregar<typeof import('../contratos/integracao-importados/composicao.ts')>('lib/contratos/integracao-importados/composicao.ts');
    const {operarContrato} = carregar<typeof import('../contratos/services/administrativo.service.ts')>('lib/contratos/services/administrativo.service.ts');
    const {fontesPreparacao} = carregar<typeof import('../fechamentos/services/revisao-operacional.service.ts')>('lib/fechamentos/services/revisao-operacional.service.ts');
    const origem = {data:'2029-03-31',inicio:'10:00',fim:'22:00'};
    const imp = await importacao(db,c,origem);
    await completarCliente(db,imp.cliente);
    const contrato = await integrar(servico,coreNativo,db,c,imp.id,decisoes(c,origem,PARCIAL()));
    const ctx = {requestId:randomUUID(),ip:null,userAgent:'paridade-131'};
    const versao = async (coluna:'versao_vigente_id'|'versao_em_preparacao_id') =>
      (await db.query(`SELECT ${coluna} AS id FROM contrato_fluxos WHERE contrato_id=$1`,[contrato.contratoId])).rows[0].id as string;
    await operarContrato(await versao('versao_vigente_id'),{acao:'nova_versao',tipo:'NOVA_VERSAO',motivo:'Paridade de agenda',chaveCriacao:randomUUID()},c.token,ctx,c.empresa);
    const preparacao = await versao('versao_em_preparacao_id');
    const fonte = (await fontesPreparacao(preparacao,executor(db)))!;
    const revisao = (await db.query('SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id=$1',[preparacao])).rows[0].revisao;
    await operarContrato(preparacao,{acao:'editar_festa',revisao,motivo:'Retenção do destino',fonteHash:fonte.fonteHash,
      pacoteId:c.pacote, convidados:50, dataEvento:'2029-04-04', configuracaoAgendaId:nativo.turno,
      horarioInicio:'10:00', horarioFim:'22:00', adicionais:fonte.adicionais, idadeAniversarianteEvento:6,
      temaFesta:'Circo', buffetStatus:'PENDENTE', buffetSalgados:'', buffetBebidas:'',buffetDoces:'', buffetBolo:'',buffetOutros:'',observacoesEquipe:'Paridade'},c.token,ctx,c.empresa);
    return (await db.query<{id:string}>('SELECT id FROM fechamento_revisoes WHERE contrato_versao_id=$1 AND hold_destino_adquirido_em IS NOT NULL',[preparacao])).rows[0]?.id;
  } finally { restaurarAmbiente(); restaurarPool(); }
}

test('pré-reserva e agenda em duas conexões PostgreSQL', {timeout:120000}, async t=>{
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== 'kidmais_pacotes_v1_descartavel') {
    t.skip('PostgreSQL descartável sem opt-in');
    return;
  }
  const a=await conectarDescartavel();
  const b=await conectarDescartavel({travar:false});
  try {
    const projecoes = ['kidmais062_ocupacoes_escopo','kidmais094_ocupacoes'];
    const lerOcupacoes = async () => Promise.all(projecoes.map(async nome =>
      (await a.query(`SELECT * FROM ${nome}('2029-04-01','2029-04-30') ORDER BY fechamento_id,revisao_id,data,origem`)).rows));
    await porTransacao(a)(async tx => {
      const empresa = await cenario(a,0);
      const catalogo = await comercial(a,empresa.empresa);
      const clienteId = await cliente(a,empresa.empresa,'Paridade',null);
      await travarConfiguracaoAgenda(tx,empresa.empresa,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});
      for (const [data,status] of [['2029-04-01','CONFIRMADO'],['2029-04-02','CONFIRMADO'],['2029-04-03','AGUARDANDO_CONTRATO']]) {
        await fechamento(a,empresa.empresa,catalogo,clienteId,{data,status});
      }
    });
    const integracaoAnterior = process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED;
    let destinoRetido: string | undefined;
    try {
      process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED='true';
      destinoRetido=await porTransacao(a)(()=>criarDestinoRetido(a));
    } finally {
      if (integracaoAnterior === undefined) delete process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED;
      else process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED=integracaoAnterior;
    }
    assert.ok(destinoRetido);
    const antes = await lerOcupacoes();
    for (const linhas of antes) {
      assert.equal(linhas.length,3);
      assert.deepEqual(linhas.filter(l=>l.origem==='REVISAO_DESTINO').map(l=>l.revisao_id),[destinoRetido]);
    }
    for (const arq of ['checks/20261120_131_precheck','migrations/20261120_131_pre_reserva_agenda','checks/20261120_131_postcheck'])
      await a.query(readFileSync('database/'+arq+'.sql','utf8'));
    await t.test('paridade das duas projeções com a base 130 sem pré-reservas',async()=>{
      assert.deepEqual(await lerOcupacoes(),antes);
    });
    await t.test('postcheck da 131 detecta funções alteradas e gatilhos ausentes, desativados e trocados',async()=>{
      const check=readFileSync('database/checks/20261120_131_postcheck.sql','utf8');
      for (const altera of [
        "ALTER FUNCTION kidmais062_ocupacoes_escopo(date,date) VOLATILE",
        "ALTER FUNCTION kidmais094_ocupacoes(date,date) VOLATILE",
        "ALTER FUNCTION pre_reserva_preservar_destino() STRICT",
        "ALTER FUNCTION pre_reserva_exigir_configuracao() STRICT",
        "ALTER TABLE pre_reserva_aceites DISABLE TRIGGER a131_config_antes_do_aceite",
        "DROP TRIGGER a131_config_antes_do_recebimento ON pre_reserva_recebimentos",
        "DROP TRIGGER pre_reserva_motivo_historico ON pre_reserva_recebimentos",
        "DROP TRIGGER pre_reserva_destino_garantido ON fechamentos; CREATE TRIGGER pre_reserva_destino_garantido AFTER UPDATE ON fechamentos FOR EACH ROW EXECUTE FUNCTION pre_reserva_preservar_destino()",
      ]) {
        await a.query('BEGIN');
        try { await a.query(altera);await assert.rejects(a.query(check),/131: definição divergente/); }
        finally { await a.query('ROLLBACK'); }
      }
      await a.query(check);
    });
    await a.query('BEGIN');
    const c=await cenario(a,2), gestor=await representante(a,c);
    const base=await comercial(a,c.empresa);
    const titular=await cliente(a,c.empresa,'Família do piloto','11988880123');
    const trava=async (db:Client)=>travarConfiguracaoAgenda(executor(db),c.empresa,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});
    await trava(a);
    await a.query(`INSERT INTO agenda_escopo_config(empresa_id,modo,capacidade_tipo,intervalo_minimo_minutos,configurado_por)
      VALUES($1,'FIXO','POR_SALAO',0,$2)`,[c.empresa,gestor.usuarioId]);
    const salao=(nome:string)=>id(a,'INSERT INTO agenda_saloes(empresa_id,nome) VALUES($1,$2) RETURNING id',[c.empresa,nome]);
    const A=await salao('A'), B=await salao('B');
    const salas=carregarComBanco('lib/agenda/configuracao-unidade.ts',a,()=>({})) as typeof import('../agenda/configuracao-unidade');
    const {id:AB}=await salas.criarSalaoCombinado(executor(a),{empresaId:c.empresa,usuarioId:gestor.usuarioId,requestId:randomUUID()},
      {estabelecimentoId:null,nome:'A + B',capacidadeConvidados:180,membros:[A,B]});
    const unidades=carregarComBanco('lib/disponibilidade/unidades-agenda.ts',a,()=>({})) as typeof import('../disponibilidade/unidades-agenda');
    for (const unidade of c.unidades) {
      await unidades.habilitarUnidadeAgenda(executor(a),gestor,unidade,'Teste de independência',{requestId:randomUUID(),ip:null,userAgent:'teste'},async()=>{});
    }
    await a.query("UPDATE clientes SET cpf=$2,email='teste@example.test',cep='01001000',logradouro='Rua Teste',numero='1',bairro='Centro',cidade='São Paulo',uf='SP' WHERE id=$1",[titular,cpfValido()]);
    const aniversariante=await id(a,"INSERT INTO aniversariantes(cliente_id,nome) VALUES ($1,'Teste') RETURNING id",[titular]);
    const modelo={titulo:'Contrato',contratada:{nome:'Buffet Sintético',documento:'11.222.333/0001-81',endereco:'Rua Teste, 2',representante:'Pessoa Teste'},preambulo:[],clausulas:[{titulo:'Objeto',texto:'Festa em {{festa.data}} para {{contratante.nome}}.'}],observacoes:[],cidadeAssinatura:'Cidade Teste'};
    await a.query("INSERT INTO modelos_contrato_empresa(empresa_id,versao,conteudo,conteudo_sha256,aprovado_por) VALUES($1,1,$2,$3,$4)",[c.empresa,JSON.stringify(modelo),'a'.repeat(64),gestor.usuarioId]);
    const novo=async(dia:string,sala:string|null,unidade:string|null=null, antecedencia?:number)=>{
      await trava(a);
      const pedido=await fechamento(a,c.empresa,base,titular,{data:dia,status:'AGUARDANDO_CONTRATO'});
      await a.query('UPDATE fechamentos SET estabelecimento_id=$2,aniversariante_id=$3 WHERE id=$1',[pedido,unidade,aniversariante]);
      if (antecedencia !== undefined) {
        await a.query(`WITH alvo AS (SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') + make_interval(mins=>$2) AS inicio)
          UPDATE fechamentos SET data_evento=inicio::date, horario_inicio=inicio::time,
            horario_fim=least(inicio+interval '5 minutes',inicio::date+time '23:59:59.999999')::time FROM alvo WHERE id=$1`,[pedido,antecedencia]);
      }
      await a.query(`INSERT INTO pre_reserva_aceites(empresa_id,fechamento_id,cliente_id,salao_id,estabelecimento_id,inicio_evento,fim_evento,
        preco_aceito_centavos,sinal_centavos,recebedor,chave_pix,termos_versao,termos_aceitos)
        SELECT empresa_id,id,cliente_id,$2,estabelecimento_id,(data_evento+horario_inicio) AT TIME ZONE 'America/Sao_Paulo',
        (data_evento+horario_fim) AT TIME ZONE 'America/Sao_Paulo',450000,10000,'Teste','pix@example.test','1','Teste' FROM fechamentos WHERE id=$1`,[pedido,sala]);
      return pedido;
    };
    const dia='2028-08-14', pAB=await novo(dia,AB), pA=await novo(dia,A), pB=await novo(dia,B);
    await a.query('COMMIT');
    const ref=(n:number)=>'E12345678202611201234'+String(n).padStart(11,'0');
    const confirmar=async(db:Client,p:string,n:number)=>{
      // A rota chama o serviço com empresa comprovada e travada pelo withTenantTransaction.
      await db.query('SELECT 1 FROM empresas WHERE id=$1 FOR UPDATE',[c.empresa]);
      const mod=carregarComBanco('lib/pre-reserva/confirmacao.ts',db,()=>({})) as typeof import('./confirmacao');
      return mod.confirmarSinal(executor(db),gestor,p,{referencia:ref(n),valorCentavos:10000,aceiteSequencia:1});
    };
    const pidB=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    async function corrida<T,U>(primeira:()=>Promise<T>, segunda:()=>Promise<U>){
      await a.query('BEGIN');
      let resultado:Promise<U>|undefined;
      try {
        const inicial=await primeira();
        resultado=porTransacao(b)(segunda);
        void resultado.catch(()=>{});
        const limite=Date.now()+15000;
        while (!(await a.query('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS bloqueada',[pidB])).rows[0].bloqueada) {
          assert.ok(Date.now()<limite,'segunda conexão deve esperar a primeira');
          await new Promise(r=>setTimeout(r,10));
        }
        await a.query('COMMIT');
        return [inicial,await resultado] as const;
      } finally {await a.query('ROLLBACK');await resultado?.catch(()=>{});}
    }
    const repo=carregarComBanco('lib/disponibilidade/repositories/disponibilidade.repository.ts',a,()=>({})) as typeof import('../disponibilidade/repositories/disponibilidade.repository');
    const ocupacoes=(d:string)=>repo.listarFechamentosConfirmadosPorPeriodo(d,d,executor(a),{empresaId:c.empresa,estabelecimentoId:null});
    await t.test('pedidos e aceites sem recebimento não ocupam',async()=>assert.deepEqual(await ocupacoes(dia),[]));
    await t.test('confirmações sobrepostas, combinado contra seus dois membros, repetição do Pix',async()=>{
      const [primeiro,segundo]=await corrida(()=>confirmar(a,pAB,1),()=>confirmar(b,pA,2));
      assert.ok(primeiro.garantiaAte);
      assert.equal(segundo.garantiaAte,null);
      assert.equal((await porTransacao(b)(()=>confirmar(b,pB,3))).garantiaAte,null);
      assert.deepEqual(await porTransacao(b)(()=>confirmar(b,pAB,1)),primeiro);
      assert.deepEqual((await ocupacoes(dia)).map(o=>o.salaoId),[AB]);
      const saldos=await a.query('SELECT dinheiro,count(*)::int AS n FROM pre_reserva_situacoes WHERE empresa_id=$1 GROUP BY dinheiro ORDER BY dinheiro',[c.empresa]);
      assert.deepEqual(saldos.rows,[{dinheiro:'A_DEVOLVER',n:2},{dinheiro:'EM_GARANTIA',n:1}]);
    });
    const disponibilidade=carregarComBanco('lib/disponibilidade/services/availability.service.ts',a,()=>({})) as typeof import('../disponibilidade/services/availability.service');
    async function periodo(d:string,unidade:string|null,sala?:string){
      const data=await disponibilidade.consultarDisponibilidadeData(d,executor(a),undefined,{empresaId:c.empresa,estabelecimentoId:unidade},sala?{saloesDoPacote:[sala]}:undefined);
      const codigo=(await a.query('SELECT codigo FROM configuracao_agenda WHERE id=$1',[base.agenda])).rows[0].codigo;
      return data.periodos.find(p=>p.codigo===codigo)?.status;
    }
    await t.test('PostgreSQL registra a destinação nos dois lados dos limites de 24 e 48 horas',async()=>{
      for (const [i,minutos] of [1439,1441,2879,2881].entries()) {
        const p=await porTransacao(a)(()=>novo('2028-08-27',null,c.unidades[i%2],minutos));
        const retorno=await porTransacao(b)(()=>confirmar(b,p,50+i));
        const r=(await a.query(`SELECT p.garantia_ate IS NOT DISTINCT FROM a.inicio_evento AS ate_evento,
          p.garantia_ate=p.confirmado_em+interval '48 hours' AS prazo,s.dinheiro
          FROM pre_reserva_recebimentos p JOIN pre_reserva_aceites a ON a.empresa_id=p.empresa_id AND a.fechamento_id=p.fechamento_id AND a.sequencia=p.aceite_sequencia
          JOIN pre_reserva_situacoes s ON s.empresa_id=p.empresa_id AND s.end_to_end_id=p.end_to_end_id WHERE p.fechamento_id=$1`,[p])).rows[0];
        assert.equal(retorno.motivo,minutos<1440?'MENOS_DE_24_HORAS':null);
        assert.equal(r.dinheiro,minutos<1440?'A_DEVOLVER':'EM_GARANTIA');
        assert.equal(r.ate_evento,minutos>=1440 && minutos<2880);
        if(minutos>=1440)assert.equal(r.prazo,minutos>2880);
      }
    });
    await t.test('valor divergente pede conferência antes de atribuir o crédito',async()=>{
      const p=await porTransacao(a)(()=>novo('2028-08-26',A));
      const mod=carregarComBanco('lib/pre-reserva/confirmacao.ts',a,()=>({})) as typeof import('./confirmacao');
      await assert.rejects(porTransacao(a)(async tx=>{
        await a.query('SELECT id FROM empresas WHERE id=$1 FOR UPDATE',[c.empresa]);
        return mod.confirmarSinal(tx,gestor,p,{referencia:ref(90),valorCentavos:9900,aceiteSequencia:1});
      }),{code:'PIX_VALOR_DIVERGENTE'});
      assert.equal((await a.query('SELECT count(*)::int n FROM pre_reserva_recebimentos WHERE end_to_end_id=$1',[ref(90)])).rows[0].n,0);
      const registrar=()=>porTransacao(a)(async tx=>{
        await a.query('SELECT id FROM empresas WHERE id=$1 FOR UPDATE',[c.empresa]);
        return mod.confirmarSinal(tx,gestor,p,{acao:'REGISTRAR_DIVERGENTE_A_DEVOLVER',referencia:ref(90),valorCentavos:9900,aceiteSequencia:1});
      });
      assert.deepEqual(await registrar(),{garantiaAte:null,motivo:'VALOR_DIVERGENTE'});
      assert.deepEqual(await registrar(),{garantiaAte:null,motivo:'VALOR_DIVERGENTE'});
      await assert.rejects(porTransacao(b)(()=>confirmar(b,pA,90)),{code:'PIX_JA_LANCADO'});
      assert.deepEqual((await a.query('SELECT dinheiro,valor_centavos::int AS valor FROM pre_reserva_situacoes WHERE fechamento_id=$1',[p])).rows,[{dinheiro:'A_DEVOLVER',valor:9900}]);
      assert.deepEqual(await ocupacoes('2028-08-26'),[]);
      assert.equal((await a.query("SELECT garantia_ate-confirmado_em=interval '48 hours' AS prazo FROM pre_reserva_recebimentos WHERE fechamento_id=$1",[pAB])).rows[0].prazo,true);
    });
    await t.test('calendário público fecha os dois membros do combinado',async()=>{
      for (const sala of [A,B]) assert.equal(await periodo(dia,null,sala),'INDISPONIVEL');
    });
    await t.test('duplo clique simultâneo recupera o único recebimento',async()=>{
      const p=await porTransacao(a)(()=>novo('2028-08-16',A));
      const [um,dois]=await corrida(()=>confirmar(a,p,5),()=>confirmar(b,p,5));
      assert.ok(um.garantiaAte);assert.deepEqual(dois,um);
      assert.equal((await a.query('SELECT count(*)::int AS n FROM pre_reserva_recebimentos WHERE fechamento_id=$1',[p])).rows[0].n,1);
    });
    await t.test('duas unidades no mesmo horário concordam com o calendário',async()=>{
      const d='2028-08-17',[u1,u2]=c.unidades;
      const p1=await porTransacao(a)(()=>novo(d,null,u1)), p2=await porTransacao(a)(()=>novo(d,null,u2));
      assert.ok((await porTransacao(a)(()=>confirmar(a,p1,6))).garantiaAte);
      assert.equal(await periodo(d,u1),'INDISPONIVEL');
      assert.equal(await periodo(d,u2),'DISPONIVEL');
      assert.ok((await porTransacao(b)(()=>confirmar(b,p2,7))).garantiaAte);
      assert.equal(await periodo(d,u2),'INDISPONIVEL');
    });
    await t.test('recusa e sinal nas duas ordens',async()=>{
      const recusar=async(db:Client,p:string)=>{
        await db.query('SELECT id FROM empresas WHERE id=$1 FOR UPDATE',[c.empresa]);
        const perda=carregarComBanco('lib/oportunidades/service.ts',db,()=>({})) as typeof import('../oportunidades/service');
        return perda.recusarPedido(executor(db),gestor,p,{motivo:'Preço'});
      };
      const p=await porTransacao(a)(()=>novo('2028-08-18',A)), q=await porTransacao(a)(()=>novo('2028-08-19',B));
      const [antes]=await corrida(()=>confirmar(a,p,8),()=>recusar(b,p));
      assert.ok(antes.garantiaAte);
      assert.deepEqual((await a.query('SELECT garantia,dinheiro FROM pre_reserva_situacoes WHERE fechamento_id=$1',[p])).rows,[{garantia:'RECUSA',dinheiro:'A_DEVOLVER'}]);
      const [,depois]=await corrida(()=>recusar(a,q),()=>confirmar(b,q,9));
      assert.equal(depois.garantiaAte,null);
      assert.deepEqual(await ocupacoes('2028-08-18'),[]);
    });
    await t.test('formalização e remarcação de festa disputam a mesma vaga nas duas ordens',async()=>{
      for(const [i,remarcar] of [false,true].entries()){
        const unidade=c.unidades[0];
        const datas=remarcar?['2028-09-03','2028-09-04']:['2028-09-01','2028-09-02'];
        for(const [j,destino] of datas.entries()){
          const p=await porTransacao(a)(()=>novo(destino,null,unidade));
          const festa=await porTransacao(a)(async()=>{
            await trava(a);
            const f=await fechamento(a,c.empresa,base,titular,{data:remarcar?'2028-10-0'+(j+1):destino,status:'AGUARDANDO_CONTRATO'});
            await a.query('UPDATE fechamentos SET estabelecimento_id=$2,status=$3 WHERE id=$1',[f,unidade,remarcar?'CONFIRMADO':'AGUARDANDO_CONTRATO']);
            return f;
          });
          async function ocupar(db:Client){
            await trava(db);
            if(remarcar) await db.query('UPDATE fechamentos SET data_evento=$2 WHERE id=$1',[festa,destino]);
            else await db.query("UPDATE fechamentos SET status='CONFIRMADO' WHERE id=$1",[festa]);
            await db.query('SET CONSTRAINTS ALL IMMEDIATE');
          }
          const pix=20+i*2+j;
          if(j===0){
            const [,tardio]=await corrida(()=>ocupar(a),()=>confirmar(b,p,pix));
            assert.equal(tardio.garantiaAte,null);
          } else {
            await assert.rejects(corrida(()=>confirmar(a,p,pix),()=>ocupar(b)),/conflito|ocupado/i);
          }
          assert.equal(await periodo(destino,unidade),'INDISPONIVEL');
        }
      }
    });
    await t.test('vencimento libera a vaga pelo relógio sem encerrar o pedido',async()=>{
      const d='2028-09-06',unidade=c.unidades[0];
      const p=await porTransacao(a)(()=>novo(d,null,unidade));
      const ate=await porTransacao(a)(async()=>{
        await trava(a);
        const q=await a.query(`INSERT INTO pre_reserva_recebimentos
          (empresa_id,fechamento_id,end_to_end_id,confirmado_por,valor_centavos,sinal_garantido_centavos,confirmado_em,garantia_ate)
          VALUES($1,$2,$3,$4,10000,10000,now()-interval '47 hours 59 minutes 58 seconds',now()+interval '2 seconds') RETURNING garantia_ate`,[c.empresa,p,ref(40),gestor.usuarioId]);
        return q.rows[0].garantia_ate;
      });
      assert.equal(await periodo(d,unidade),'INDISPONIVEL');
      await assert.rejects(porTransacao(a)(async()=>{await trava(a);await a.query("UPDATE fechamentos SET data_evento=data_evento+1 WHERE id=$1",[p]);}),/Destino protegido/);
      await b.query('SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))))',[ate]);
      assert.equal(await periodo(d,unidade),'DISPONIVEL');
      const fim=await a.query('SELECT status,garantia,dinheiro FROM fechamentos f JOIN pre_reserva_situacoes p ON p.fechamento_id=f.id WHERE f.id=$1',[p]);
      assert.deepEqual(fim.rows[0],{status:'AGUARDANDO_CONTRATO',garantia:'EXPIRADA',dinheiro:'A_DEVOLVER'});
    });
    await t.test('gerar contrato e sinal nas duas ordens',async()=>{
      const gerar=(db:Client,p:string)=>{
        const mod=carregarComBanco('lib/contratos/services/contrato.service.ts',db,()=>({})) as typeof import('../contratos/services/contrato.service');
        return mod.gerarContrato({fechamentoId:p},{usuarioId:gestor.usuarioId,origem:'SISTEMA',executor:executor(db)});
      };
      const p=await porTransacao(a)(()=>novo('2028-08-20',B)),q=await porTransacao(a)(()=>novo('2028-08-21',null,c.unidades[0]));
      const [sinal,gerado]=await corrida(()=>confirmar(a,p,10),()=>gerar(b,p));
      assert.ok(sinal.garantiaAte); assert.ok(gerado.contrato.id);
      const escolha=carregarComBanco('lib/agenda/salao-festa.ts',a,()=>({})) as typeof import('../agenda/salao-festa');
      const sala=await porTransacao(a)(async tx=>{
        await trava(a);
        return escolha.escolherSalaoParaEmissao(tx,p);
      });
      assert.ok(sala.porSalao && sala.salao?.id===B);
      const [contrato]=await corrida(()=>gerar(a,q),()=>confirmar(b,q,11));
      assert.ok(contrato.contrato.id);
    });
    await t.test('bloqueio prévio recusa garantia, garantia existente impede bloqueio',async()=>{
      const inserir=(d:string)=>a.query("INSERT INTO bloqueios_agenda(data,dia_inteiro,motivo,empresa_id,criado_por_usuario_id) VALUES($1,true,'Teste',$2,$3)",[d,c.empresa,c.usuario]);
      const bloqueado='2028-08-15';
      const pedido=await porTransacao(a)(async()=>{const p=await novo(bloqueado,A);await inserir(bloqueado);return p;});
      assert.equal((await porTransacao(b)(()=>confirmar(b,pedido,4))).garantiaAte,null);
      await assert.rejects(porTransacao(a)(async()=>{await trava(a);await inserir(dia);}),/Bloqueio conflita/);
    });
  } finally {await a.query('ROLLBACK');await encerrarDescartavel(b);await encerrarDescartavel(a);}
});
