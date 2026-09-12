/* eslint-disable @typescript-eslint/no-require-imports */
const {randomUUID}=require('node:crypto');
require('./pagamentos-test-support.cjs');
const {hashSnapshotContrato}=require('../lib/contratos/services/snapshot-core.ts');
const {db}=require('../lib/db/postgres.ts');
const {lerPosicaoFinanceira}=require('../lib/pagamentos/repositories/alteracao-financeira.repository.ts');
const service=require('../lib/pagamentos/services/alteracao-financeira.service.ts');
async function fixtureFinanceiro(c,ctx,recebido=0){
 const base=(await c.query('SELECT v.snapshot FROM contrato_versoes v ORDER BY numero_versao LIMIT 1')).rows[0].snapshot;
 const f=await require('./pagamentos-test-support.cjs').fixture(c);
 // Cria uma nova versão de teste; nunca altera o snapshot assinado da fixture.
 const snapshot=structuredClone(base);snapshot.comercial.valorFinalContrato=100;snapshot.contratante.clienteId=f.clienteId;snapshot.evento.data=f.data;
 snapshot.comercial.formaPagamentoPretendida='PIX_PARCELADO';snapshot.comercial.condicaoPagamento={...snapshot.comercial.condicaoPagamento,forma:'PIX_PARCELADO'};
 const v=(await c.query(`INSERT INTO contrato_versoes(contrato_id,numero_versao,status,snapshot,snapshot_hash,assinado_em,documento_template_versao,documento_pdf_hash,aceite_metodo) VALUES($1,2,'ASSINADA',$2,$3,now(),1,$3,'OTP') RETURNING id`,[f.contratoId,snapshot,hashSnapshotContrato(snapshot)])).rows[0];
 await c.query('UPDATE contratos SET versao_atual=2 WHERE id=$1',[f.contratoId]);
 await c.query('INSERT INTO contrato_fluxos(contrato_id,versao_vigente_id) VALUES($1,$2)',[f.contratoId,v.id]);
 const ps=require('../lib/pagamentos/services/pagamento.service.ts');
 const d=await ps.criarPagamentoDoFechamento({fechamentoId:f.fechamentoId,plano:{meioPagamento:'PIX',modalidade:'AVISTA',parcelas:[{valor:100,vencimento:'2098-10-01',confirmaReserva:true}]}},ctx);
 let r=null;if(recebido)r=await ps.registrarRecebimentoPagamento({pagamentoId:d.detalhe.pagamento.id,meioPagamento:'PIX',valorBruto:recebido,alocacoes:[{parcelaId:d.detalhe.parcelas[0].id,valor:recebido}],chaveIdempotencia:randomUUID()},ctx);
 return {...f,snapshot,pagamento:d.detalhe.pagamento,recebimento:r,versaoId:v.id};
}
async function promover(c,f,valor,extra={}){
 const p=await lerPosicaoFinanceira(db(),f.contratoId),snapshot=structuredClone(p.vigente.snapshot);
 snapshot.comercial.valorFinalContrato=valor;
 if(extra.clienteId)snapshot.contratante.clienteId=extra.clienteId;
 if(extra.data)snapshot.evento.data=extra.data;
 if(extra.forma)snapshot.comercial.condicaoPagamento.forma=extra.forma;
 const numero=p.vigente.numero_versao+1;
 const v=(await c.query(`INSERT INTO contrato_versoes(contrato_id,numero_versao,status,snapshot,snapshot_hash,assinado_em,documento_template_versao,documento_pdf_hash,aceite_metodo) VALUES($1,$2,'ASSINADA',$3,$4,now(),1,$4,'OTP') RETURNING id`,[f.contratoId,numero,snapshot,hashSnapshotContrato(snapshot)])).rows[0];
 await require('../lib/pagamentos/services/pendencias-financeiras.service.ts').detectarPendenciasFinanceiras(db(),{id:v.id,contratoId:f.contratoId,numeroVersao:numero,snapshot},p.vigente.id);
 await c.query('UPDATE contratos SET versao_atual=$2 WHERE id=$1',[f.contratoId,numero]);
 await c.query('UPDATE contrato_fluxos SET versao_vigente_id=$2 WHERE contrato_id=$1',[f.contratoId,v.id]);
 return lerPosicaoFinanceira(db(),f.contratoId);
}
async function resolver(f,ctx,extra={}){
 let p=await lerPosicaoFinanceira(db(),f.contratoId);const pend=p.pendencias.find(x=>x.versao_nova_id===p.vigente.id);
 const t=await service.iniciarTratamento(f.contratoId,pend.id,p.posicaoHash,randomUUID(),ctx);
 p=await lerPosicaoFinanceira(db(),f.contratoId);const saldo=p.valorVigente-p.posicao.liquido;
 const input={posicaoHash:p.posicaoHash,modo:saldo>0n?'REPROGRAMAR':'SEM_SALDO',parcelas:saldo>0n?[{valorCentavos:saldo.toString(),vencimento:p.vigente.snapshot.evento.data}]:[],credito:'MANTER',decisaoContratante:'NAO_SE_APLICA',justificativa:'Teste de regra financeira',...extra};
 const result=await service.resolverAlteracao(f.contratoId,t.resultado.tratamentoId,input,randomUUID(),ctx);
 await db().query('SET CONSTRAINTS p015_validar,p015_validar_movimento IMMEDIATE');
 await db().query('SET CONSTRAINTS p015_validar,p015_validar_movimento DEFERRED');
 return result;
}
module.exports={fixtureFinanceiro,promover,resolver};
