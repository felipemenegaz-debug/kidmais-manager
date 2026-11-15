import test from 'node:test';
import assert from 'node:assert/strict';
import {conectarDescartavel,encerrarDescartavel} from '../comercial/postgres-descartavel.ts';
import {carregarComBanco,cliente,cod,empresa,executor,SENHA_FALSA,vincular} from './harness-postgres.ts';

test('abrir negociação de contato manual: reaproveita cliente, cria quando necessário, preserva origem e recusa outra empresa',async t=>{
  if(process.env.KIDMAIS_POSTGRES_DESCARTAVEL!=='kidmais_pacotes_v1_descartavel')return t.skip('opt-in descartável ausente');
  const c=await conectarDescartavel();
  try{
    await c.query('BEGIN');const A=await empresa(c,'Alfa sintética'),B=await empresa(c,'Beta sintética');
    const usuario=(await c.query(`INSERT INTO usuarios_administrativos(email,nome,senha_hash,papel,ativo) VALUES($1,'Equipe sintética',$2,'REPRESENTANTE_AUTORIZADO',true) RETURNING id::text`,[`${cod('u')}@marketing.test`,SENHA_FALSA])).rows[0].id;
    await vincular(c,A,usuario,'REPRESENTANTE_AUTORIZADO');
    const m=carregarComBanco('lib/marketing/contatos.ts',c,()=>null) as unknown as typeof import('./contatos.ts');const tx=executor(c);
    const existente=await cliente(c,A,'Cliente sintético','5511988881111');
    const registrar=async(telefone:string)=>m.executarAcaoContato(tx,A,usuario,m.esquemaAcaoContato.parse({acao:'registrar',nome:'Contato sintético',telefone,canal:'WHATSAPP',origemCodigo:'INSTAGRAM',chave:'contato-manual-'+cod('id')}));
    const abrir=(id:string,empresaId=A)=>m.executarAcaoContato(tx,empresaId,usuario,m.esquemaAcaoContato.parse({acao:'preparar-negociacao',id}));
    const primeiro=await registrar('5511988881111');
    assert.equal((await abrir(primeiro.id)).clienteId,existente);
    assert.equal((await abrir(primeiro.id)).clienteId,existente,'repetição preserva cliente');
    const novo=await registrar('5511988882222');
    const n=await abrir(novo.id);
    assert.ok(n.clienteId&&n.clienteId!==existente);
    assert.equal((await c.query(`SELECT origem_codigo FROM marketing_atribuicoes WHERE empresa_id=$1 AND alvo_tipo='CLIENTE' AND alvo_id=$2 AND vigente`,[A,n.clienteId])).rows[0].origem_codigo,'INSTAGRAM');
    const antes=(await c.query('SELECT count(*)::int AS n FROM clientes')).rows[0].n;
    await assert.rejects(()=>abrir(novo.id,B),/Contato não encontrado/);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM clientes')).rows[0].n,antes);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM clientes WHERE empresa_id=$1',[A])).rows[0].n,2);
  }finally{await encerrarDescartavel(c);}
});
