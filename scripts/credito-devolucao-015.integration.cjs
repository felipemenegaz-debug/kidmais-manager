/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {rollbackTest,ctx}=require('./pagamentos-test-support.cjs');
const {fixtureFinanceiro,promover,resolver}=require('./financeiro-015-test-support.cjs');
const {db}=require('../lib/db/postgres.ts'),{lerPosicaoFinanceira}=require('../lib/pagamentos/repositories/alteracao-financeira.repository.ts');
const d=require('../lib/pagamentos/services/devolucao.service.ts');
rollbackTest(async c=>{
 assert.match((await c.query('SELECT current_database() banco')).rows[0].banco,/^kidmais_015_\d+$/);
 const context={token:ctx.token,requestId:randomUUID(),ip:null,userAgent:'credito015'};
 const f=await fixtureFinanceiro(c,ctx,100);await promover(c,f,70);await resolver(f,context);
 let p=await lerPosicaoFinanceira(db(),f.contratoId);assert.equal(p.posicao.credito,3000n);assert.equal(p.posicao.saldo,0n);
 const origem=f.recebimento.alocacoes[0].id;
 const pedido=()=>({posicaoHash:p.posicaoHash,valorCentavos:'2000',beneficiario:{nome:'Pagador sintético'},motivo:'Crédito de redução contratual',origens:[{alocacaoId:origem,valorCentavos:'2000'}]});
 const key=randomUUID(),b=pedido(),sol=await d.solicitarDevolucao(f.contratoId,b,key,context);const retry=await d.solicitarDevolucao(f.contratoId,b,key,context);assert.equal(retry.reutilizado,true);
 p=await lerPosicaoFinanceira(db(),f.contratoId);assert.equal(p.posicao.reservado,2000n);assert.equal(p.posicao.disponivel,1000n);assert.equal(p.posicao.liquido,10000n);
 await assert.rejects(d.solicitarDevolucao(f.contratoId,pedido(),randomUUID(),context),{code:'CREDITO_INDISPONIVEL'});
 const exec=()=>({posicaoHash:p.posicaoHash,devolvidoEm:new Date().toISOString(),meio:'PIX',observacao:'Saída efetivada no teste',justificativaSemComprovante:'Operação sintética, revertida integralmente'});
 await c.query("UPDATE usuarios_administrativos SET papel='ADMINISTRATIVO' WHERE id=$1",[ctx.usuarioId]);
 await assert.rejects(d.concluirDevolucao(f.contratoId,sol.resultado.devolucaoId,exec(),randomUUID(),context),{code:'OPERACAO_NAO_AUTORIZADA'});
 await d.cancelarDevolucao(f.contratoId,sol.resultado.devolucaoId,'Solicitação incorreta',randomUUID(),context);
 p=await lerPosicaoFinanceira(db(),f.contratoId);assert.equal(p.posicao.reservado,0n);assert.equal(p.posicao.disponivel,3000n);
 const sol2=await d.solicitarDevolucao(f.contratoId,pedido(),randomUUID(),context);
 await c.query("UPDATE usuarios_administrativos SET papel='REPRESENTANTE_AUTORIZADO' WHERE id=$1",[ctx.usuarioId]);
 p=await lerPosicaoFinanceira(db(),f.contratoId);
 const output=await d.concluirDevolucao(f.contratoId,sol2.resultado.devolucaoId,exec(),randomUUID(),context);assert.equal(output.resultado.estado,'CONCLUIDA');
 p=await lerPosicaoFinanceira(db(),f.contratoId);assert.equal(p.posicao.liquido,8000n);assert.equal(p.posicao.credito,1000n);assert.equal(p.posicao.devolvido,2000n);
 await assert.rejects(d.cancelarDevolucao(f.contratoId,sol2.resultado.devolucaoId,'Tentativa indevida',randomUUID(),context),{code:'DEVOLUCAO_INDISPONIVEL'});
 await promover(c,f,90);await resolver(f,context,{credito:'APROVEITAR'});p=await lerPosicaoFinanceira(db(),f.contratoId);assert.equal(p.posicao.saldo,1000n);assert.equal(p.posicao.credito,0n);assert.equal(p.posicao.liquido,8000n);
 // Fixtures sintéticas de domínio, desfeitas por rollback. O aceite/assinatura
 // completo é validado separadamente pelos runners de Contrato, sem bypass.
 await c.query('SET CONSTRAINTS p015_validar,p015_validar_movimento IMMEDIATE');
 console.log('PASS: redução, crédito, reserva, duplicidade, papel ADMIN/REP, cancelamento, conclusão, imutabilidade e aproveitamento sem desconto duplicado.');
}).catch(e=>{console.error(e);process.exitCode=1;});
