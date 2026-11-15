import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {conectarDescartavel,encerrarDescartavel} from '../comercial/postgres-descartavel.ts';

// Parecer do Astra (15/11/2026, P2): o postcheck da 122 tem de reprovar um schema sem os dois CHECKs de perda,
// com um deles NOT VALID ou com a definição trocada. Tudo dentro de uma transação desfeita no fim.
const POSTCHECK=fs.readFileSync('database/checks/20261114_122_postcheck.sql','utf8');
const CK={contato:['marketing_contatos','oportunidades_contato_perda_ck'],fechamento:['fechamentos','oportunidades_fechamento_perda_ck']} as const;

test('postcheck da 122 reprova CHECKs de perda ausentes, NOT VALID ou com definição trocada',{timeout:180000},async(t)=>{
 if(process.env.KIDMAIS_POSTGRES_DESCARTAVEL!=='kidmais_pacotes_v1_descartavel'){t.skip('postgres-descartavel: opt-in ausente');return;}
 const c=await conectarDescartavel();
 try{
  await c.query('BEGIN');
  const defs=(await c.query<{conname:string;def:string}>("SELECT conname,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ($1,$2) ORDER BY conname",[CK.contato[1],CK.fechamento[1]])).rows;
  t.diagnostic(JSON.stringify(defs));
  assert.equal(defs.length,2);
  const aprovado=async()=>{const r=await c.query(POSTCHECK) as unknown as {rows:unknown[]}|Array<{rows:unknown[]}>;return (Array.isArray(r)?r.at(-1):r)?.rows;};
  assert.deepEqual(await aprovado(),[{aprovado:true}]);
  const def=Object.fromEntries(defs.map(d=>[d.conname,d.def]));
  const casos:Array<[string,string[]]>=[
   ['sem o CHECK do contato',[`ALTER TABLE ${CK.contato[0]} DROP CONSTRAINT ${CK.contato[1]}`]],
   ['sem o CHECK da negociação',[`ALTER TABLE ${CK.fechamento[0]} DROP CONSTRAINT ${CK.fechamento[1]}`]],
   ['CHECK do contato NOT VALID',[`ALTER TABLE ${CK.contato[0]} DROP CONSTRAINT ${CK.contato[1]}`,`ALTER TABLE ${CK.contato[0]} ADD CONSTRAINT ${CK.contato[1]} ${def[CK.contato[1]]} NOT VALID`]],
   ['CHECK da negociação NOT VALID',[`ALTER TABLE ${CK.fechamento[0]} DROP CONSTRAINT ${CK.fechamento[1]}`,`ALTER TABLE ${CK.fechamento[0]} ADD CONSTRAINT ${CK.fechamento[1]} ${def[CK.fechamento[1]]} NOT VALID`]],
   ['CHECK do contato sem um motivo',[`ALTER TABLE ${CK.contato[0]} DROP CONSTRAINT ${CK.contato[1]}`,`ALTER TABLE ${CK.contato[0]} ADD CONSTRAINT ${CK.contato[1]} CHECK ((perda_motivo IS NULL AND perdida_em IS NULL AND perda_observacao IS NULL) OR (status='DESCARTADO' AND perdida_em IS NOT NULL AND perda_motivo IN ('Preço','Data ocupada','Fechou com outro buffet','Desistiu da festa','Parou de responder')))`]],
   ['CHECK da negociação aceitando outro status',[`ALTER TABLE ${CK.fechamento[0]} DROP CONSTRAINT ${CK.fechamento[1]}`,`ALTER TABLE ${CK.fechamento[0]} ADD CONSTRAINT ${CK.fechamento[1]} CHECK ((perda_motivo IS NULL AND perdida_em IS NULL AND perda_observacao IS NULL) OR (status IN ('CANCELADO','RECUSADO','EXPIRADO','CONFIRMADO') AND perdida_em IS NOT NULL AND perda_motivo IN ('Preço','Data ocupada','Fechou com outro buffet','Desistiu da festa','Parou de responder','Outro')))`]],
   ['CHECK do contato com outro nome',[`ALTER TABLE ${CK.contato[0]} RENAME CONSTRAINT ${CK.contato[1]} TO oportunidades_contato_perda_ck_antigo`]],
   ['CHECK do contato na tabela errada',[`ALTER TABLE ${CK.contato[0]} DROP CONSTRAINT ${CK.contato[1]}`,`ALTER TABLE ${CK.fechamento[0]} ADD CONSTRAINT ${CK.contato[1]} CHECK (perda_motivo IS NULL OR perdida_em IS NOT NULL)`]],
  ];
  for(const [nome,sqls] of casos){
   await c.query('SAVEPOINT caso');
   for(const sql of sqls)await c.query(sql);
   await assert.rejects(c.query(POSTCHECK),(e:Error)=>e.message==='122: CHECKs de perda divergentes',nome);
   await c.query('ROLLBACK TO SAVEPOINT caso');
  }
  // Depois de desfazer cada caso, o schema íntegro volta a passar.
  assert.deepEqual(await aprovado(),[{aprovado:true}]);
 }finally{await c.query('ROLLBACK').catch(()=>{});await encerrarDescartavel(c);}
});
