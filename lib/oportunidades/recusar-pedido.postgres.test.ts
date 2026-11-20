import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarComBanco, pedido, cliente, fechamento, comercial, executor, vincular, SENHA_FALSA, type Resposta } from '../marketing/harness-postgres.ts';
import { travarConfiguracaoAgenda } from '../agenda/trava-configuracao.ts';
import { cenario, id, cpfValido } from '../../scripts/integracao-importados-test-support.ts';

type Http = (r: ReturnType<typeof pedido>, ctx: {params: Promise<{fechamentoId: string}>}) => Promise<Resposta>;
test('Recusa na contratação do Essencial, estados, concorrência e isolamento', {timeout: 180_000}, async t => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== 'kidmais_pacotes_v1_descartavel') {
    t.skip('PostgreSQL descartável sem opt-in');
    return;
  }
  const db = await conectarDescartavel();
  const outra = await conectarDescartavel({travar:false});
  try {
    await db.query('BEGIN');
    const c = await cenario(db,0);
    const gestorId = await id(db, "INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel,ativo) VALUES($1,'Gestão',$2,'REPRESENTANTE_AUTORIZADO',true) RETURNING id",[randomUUID()+'@example.test',SENHA_FALSA]);
    const gestor = await vincular(db,c.empresa,gestorId,'REPRESENTANTE_AUTORIZADO');
    const b = await cenario(db,0);
    let sessao = gestor.sessao;
    const modulos = new Map([[db,new Map()], [outra,new Map()]]);
    const carregar = (p:string, conexao=db) => carregarComBanco(p,conexao,()=>sessao,{},modulos.get(conexao)) as {GET:Http;POST:Http};
    const endpoint = 'app/api/admin/fechamentos/[fechamentoId]/recusar/route.ts';
    const recusar = (fid:string, body:unknown={motivo:'Preço'}, conexao=db) =>
      carregar(endpoint,conexao).POST(pedido('http://localhost/api/admin/fechamentos/'+fid+'/recusar',body),{params:Promise.resolve({fechamentoId:fid})});
    const base = await comercial(db,c.empresa);
    await travarConfiguracaoAgenda(executor(db),c.empresa,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});
    const cli = await cliente(db,c.empresa,'Pessoa sintética','11988880123');
    const novo = (status='AGUARDANDO_CONTRATO') => fechamento(db,c.empresa,base,cli,{status,data:'2028-03-01'});
    await db.query("INSERT INTO empresa_assinaturas (empresa_id,situacao,teste_inicio,teste_fim) VALUES ($1,'TESTE',now(),now()+interval '20 days')",[c.empresa]);
    const assinatura = await id(db,"INSERT INTO assinatura_contratacoes(empresa_id,chave_idempotencia,plano,ciclo,catalogo_versao,valor_regular_centavos,valor_final_centavos,criada_por) VALUES($1,$2,'ESSENCIAL','MENSAL','teste',9900,9900,$3) RETURNING id",[c.empresa,randomUUID(),gestorId]);
    const sub='sub-'+randomUUID();
    await db.query("UPDATE assinatura_contratacoes SET estado='CONFIRMADA',confirmada_em=clock_timestamp(),pagamento_confirmacao_id=$2,provedor_assinatura_id=$3 WHERE id=$1",[assinatura,randomUUID(),sub]);
    await db.query("UPDATE empresa_assinaturas SET situacao='ATIVA',plano='ESSENCIAL',ciclo='MENSAL',provedor='ASAAS',contratacao_atual_id=$2,provedor_assinatura_id=$3,periodo_atual_fim=now()+interval '29 days' WHERE empresa_id=$1",[c.empresa,assinatura,sub]);
    async function marketingBloqueado(){
      for(const path of ['oportunidades','marketing/campanhas','marketing/automacoes']){
        const rota=carregar('app/api/admin/'+path+'/route.ts');
        for(const metodo of ['GET','POST'] as const){
          const res=await rota[metodo](pedido('http://localhost/api/admin/'+path,metodo==='POST'?{}:undefined),{params:Promise.resolve({fechamentoId:''})});
          assert.equal((await res.json()).codigo,'RECURSO_FORA_DO_PLANO',path+' '+metodo);
          assert.equal(res.status,403);
        }
      }
    }
    await marketingBloqueado();
    for(const estado of ['RASCUNHO','AGUARDANDO_APROVACAO','APROVADO','CONTRATO_ASSINADO','AGUARDANDO_PAGAMENTO','CONFIRMADO','CANCELADO','RECUSADO','EXPIRADO']){
      const fid=await novo('RASCUNHO');
      await db.query("UPDATE fechamentos SET status=$2, valor_negociado=4500,valor_aprovado=4500 WHERE id=$1",[fid,estado]);
      const resposta=await recusar(fid);
      assert.equal(resposta.status,409,estado+JSON.stringify(await resposta.json()));
      assert.deepEqual((await db.query('SELECT status,perdida_em FROM fechamentos WHERE id=$1',[fid])).rows[0],{status:estado,perdida_em:null});
      t.diagnostic(estado + ': 409, estado e data de perda preservados');
    }
    const fid=await novo();
    for(const body of [{motivo:'Outro'}, {motivo:'Outro',observacao:'   '},{motivo:'Preço',esperada:null},{motivo:'Preço',empresaId:b.empresa}])
      assert.equal((await recusar(fid,body)).status,400);
    await db.query("INSERT INTO marketing_membership_capacidades(empresa_id,membership_id,capacidade,concedido_por,motivo) VALUES($1,$2,'MARKETING_CAMPANHAS_EDITAR',$3,'Fixture de equipe')",[c.empresa,c.membership,gestorId]);
    sessao={...gestor.sessao,usuario_id:c.usuario,papel:'ADMINISTRATIVO'};
    assert.equal((await recusar(fid)).status,403);
    sessao=gestor.sessao;
    const bb=await comercial(db,b.empresa);
    await travarConfiguracaoAgenda(executor(db),b.empresa,{modo:'COMPARTILHADA',linha:'KEY_SHARE'});
    const fora=await fechamento(db,b.empresa,bb,await cliente(db,b.empresa,'Pessoa B',null),{status:'AGUARDANDO_CONTRATO',data:'2028-03-02'});
    assert.deepEqual(await (await recusar(fora)).json(),await (await recusar(randomUUID())).json());
    assert.equal((await recusar(fora)).status,404);
    await db.query('ALTER TABLE oportunidades_acoes RENAME TO oportunidades_acoes_teste');
    const indisponivel=await recusar(fid);
    assert.equal(indisponivel.status,503);
    assert.equal((await indisponivel.json()).codigo,'OPORTUNIDADES_INDISPONIVEIS');
    assert.deepEqual((await db.query('SELECT status,perdida_em FROM fechamentos WHERE id=$1',[fid])).rows[0],{status:'AGUARDANDO_CONTRATO',perdida_em:null});
    await db.query('ALTER TABLE oportunidades_acoes_teste RENAME TO oportunidades_acoes');
    await db.query("INSERT INTO oportunidades_acoes(empresa_id,fechamento_id,responsavel_id,tipo,data,criada_por) VALUES($1,$2,$3,'Ligar',current_date,$3)",[c.empresa,fid,gestorId]);
    const protegida = await novo();
    await db.query("INSERT INTO contratos(fechamento_id,status) VALUES($1,'AGUARDANDO_ASSINATURA')",[protegida]);
    await db.query("UPDATE festa_membership_capacidades SET revogado_em=clock_timestamp(),revogado_por=$2,motivo_revogacao='Teste' WHERE membership_id=$1 AND capacidade='FESTA_CORRIGIR' AND revogado_em IS NULL",[gestor.membership,gestorId]);
    assert.equal((await recusar(protegida)).status,403);
    assert.equal((await db.query('SELECT status FROM contratos WHERE fechamento_id=$1',[protegida])).rows[0].status,'AGUARDANDO_ASSINATURA');
    const agendaPrimeiro = await novo();
    const perdaPrimeiro = await novo();
    const corrida = await novo();
    const corridaInversa = await novo();
    await db.query("UPDATE clientes SET cpf=$2,email='teste@example.test',cep='01001000',logradouro='Rua Sintética',numero='1',bairro='Centro',cidade='São Paulo',uf='SP' WHERE id=$1",[cli,cpfValido()]);
    const aniversariante = await id(db,"INSERT INTO aniversariantes(cliente_id,nome) VALUES ($1,'Teste') RETURNING id",[cli]);
    await db.query("UPDATE fechamentos SET aniversariante_id=$2 WHERE id=ANY($1::uuid[])",[[corrida,corridaInversa],aniversariante]);
    const modelo={titulo:'Contrato',contratada:{nome:'Buffet Sintético',documento:'11.222.333/0001-81',endereco:'Rua Teste, 2',representante:'Pessoa Teste'},preambulo:[],clausulas:[{titulo:'Objeto',texto:'Festa em {{festa.data}} para {{contratante.nome}}.'}],observacoes:[],cidadeAssinatura:'Cidade Teste'};
    await db.query("INSERT INTO modelos_contrato_empresa(empresa_id,versao,conteudo,conteudo_sha256,aprovado_por) VALUES($1,1,$2,$3,$4)",[c.empresa,JSON.stringify(modelo),'a'.repeat(64),gestorId]);
    await db.query("INSERT INTO festa_membership_capacidades(empresa_id,membership_id,capacidade,concedido_por,motivo) SELECT $1,$2,'FESTA_CORRIGIR',$3,'Teste de corrida' WHERE NOT EXISTS (SELECT 1 FROM festa_membership_capacidades WHERE membership_id=$2 AND capacidade='FESTA_CORRIGIR' AND revogado_em IS NULL)",[c.empresa,gestor.membership,gestorId]);
    await db.query('COMMIT');
    await db.query('BEGIN'); await outra.query('BEGIN');
    const perda=await recusar(fid,{motivo:'Outro',observacao:'Teste de duplicação'});
    assert.equal(perda.status,200,JSON.stringify(await perda.json()));
    const pidOutra=(await outra.query('SELECT pg_backend_pid() AS id')).rows[0].id;
    const pidPrincipal=(await db.query('SELECT pg_backend_pid() AS id')).rows[0].id;
    async function esperarTrava(observador: typeof db, bloqueado: number, dono: number) {
      const limite = Date.now()+5000;
      do {
        if ((await observador.query('SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS esperando',[dono,bloqueado])).rows[0].esperando) return;
        await new Promise(resolve=>setTimeout(resolve,15));
      } while(Date.now()<limite);
      throw new Error('A segunda operação não esperou a trava do fechamento');
    }
    const segundo=recusar(fid,{motivo:'Preço'},outra);
    await esperarTrava(db,pidOutra,pidPrincipal);
    await db.query('COMMIT');
    assert.equal((await segundo).status,409);
    await outra.query('ROLLBACK');
    await db.query('BEGIN');
    assert.equal((await db.query('SELECT resultado FROM oportunidades_acoes WHERE fechamento_id=$1',[fid])).rows[0].resultado,'PERDIDA');
    assert.equal((await db.query("SELECT count(*)::int n FROM eventos_historico_cliente WHERE entidade_id=$1 AND tipo_evento='OPORTUNIDADE_PERDIDA' AND usuario_id=$2",[fid,gestorId])).rows[0].n,1);
    await marketingBloqueado();
    const contratos=carregarComBanco('lib/contratos/services/contrato.service.ts',outra,()=>sessao) as typeof import('../contratos/services/contrato.service.ts');
    const gerar=(fechamentoId:string)=>contratos.gerarContrato({fechamentoId},{usuarioId:gestorId,origem:'SISTEMA',executor:executor(outra)});

    await outra.query('BEGIN');
    assert.equal((await recusar(corrida)).status,200);
    const geracaoTardia=assert.rejects(gerar(corrida), {code:'STATUS_FECHAMENTO_NAO_PERMITE_CONTRATO'});
    await esperarTrava(db,pidOutra,pidPrincipal);
    await db.query('COMMIT');
    await geracaoTardia;
    await outra.query('ROLLBACK');

    await outra.query('BEGIN');
    const gerado=await gerar(corridaInversa);
    await db.query('BEGIN');
    const recusaTardia=recusar(corridaInversa);
    await esperarTrava(outra,pidPrincipal,pidOutra);
    await outra.query('COMMIT');
    const resposta=await recusaTardia;
    assert.equal(resposta.status,200,JSON.stringify(await resposta.json()));
    assert.equal((await db.query('SELECT status FROM contratos WHERE id=$1',[gerado.contrato.id])).rows[0].status,'CANCELADO');
    assert.equal((await db.query('SELECT count(*)::int n FROM contratos WHERE fechamento_id=$1',[corrida])).rows[0].n,0);
    await db.query('COMMIT');

    // O Funil já está autorizado em sua própria entrada. Exercitar a mesma escrita concorrente
    // diretamente evita habilitar Marketing no Essencial para montar o cenário.
    const funil=carregarComBanco('lib/oportunidades/service.ts',outra,()=>sessao) as typeof import('./service.ts');
    const agendar=async (fid:string) => {
      await outra.query('SELECT id FROM empresas WHERE id=$1 FOR UPDATE',[c.empresa]);
      return funil.executarOportunidade(executor(outra),c.empresa,gestorId,{
        acao:'agendar',alvo:{tipo:'FECHAMENTO',id:fid},esperada:null,
        proxima:{tipo:'Ligar',data:'2028-02-01',responsavelId:gestorId}
      },true,gestor.membership);
    };
    await outra.query('BEGIN');
    await agendar(agendaPrimeiro);
    await db.query('BEGIN');
    const perdaDepois=recusar(agendaPrimeiro);
    await esperarTrava(outra,pidPrincipal,pidOutra);
    await outra.query('COMMIT');
    assert.equal((await perdaDepois).status,200);
    assert.equal((await db.query('SELECT resultado FROM oportunidades_acoes WHERE fechamento_id=$1',[agendaPrimeiro])).rows[0].resultado,'PERDIDA');
    await db.query('COMMIT');

    await db.query('BEGIN');
    assert.equal((await recusar(perdaPrimeiro)).status,200);
    await outra.query('BEGIN');
    const agendaDepois=assert.rejects(agendar(perdaPrimeiro),{code:'MARKETING_CONFLITO'});
    await esperarTrava(db,pidOutra,pidPrincipal);
    await db.query('COMMIT');
    await agendaDepois;
    assert.equal((await outra.query('SELECT count(*)::int n FROM oportunidades_acoes WHERE fechamento_id=$1',[perdaPrimeiro])).rows[0].n,0);
  } finally {
    await Promise.all([encerrarDescartavel(outra,false),encerrarDescartavel(db)]);
  }
});
