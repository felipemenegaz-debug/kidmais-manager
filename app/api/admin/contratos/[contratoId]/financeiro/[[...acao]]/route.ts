import { NextRequest,NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { exigirApiAdminCrmDisponivel,tokenAdmin } from '@/lib/http/admin-crm-api';
import { erroPagamentoApi } from '@/lib/http/pagamentos-api';
import { consultarPainelFinanceiro } from '@/lib/pagamentos/services/financeiro-consulta.service';
import { iniciarTratamento,cancelarTratamento,simularAlteracao,resolverAlteracao,simularPosicao } from '@/lib/pagamentos/services/alteracao-financeira.service';
import { reprogramarCronograma } from '@/lib/pagamentos/services/cronograma.service';
import { solicitarDevolucao,concluirDevolucao,cancelarDevolucao,anexarComprovanteDevolucao } from '@/lib/pagamentos/services/devolucao.service';
import { recusarFinanceiro } from '@/lib/pagamentos/services/alteracao-financeira-core';
import { lerPosicaoFinanceira,serializarFinanceiro } from '@/lib/pagamentos/repositories/alteracao-financeira.repository';
import { contratoNoTenant,executarComPosseNoTenant } from '@/lib/contratos/services/contrato-tenant';
import { withTenantTransaction,type TenantComprovado } from '@/lib/saas/provar-tenant';
import type { DbExecutor } from '@/lib/db/contracts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Params={params:Promise<{contratoId:string;acao?:string[]}>};
const uuid=z.string().uuid().transform(x=>x.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/),centavos=z.string().regex(/^[1-9]\d{0,11}$/),texto=z.string().trim().min(1).max(2000);
const resolucao=z.object({posicaoHash:hash,modo:z.enum(['REPROGRAMAR','MANTER_E_COMPLEMENTAR','PERSONALIZADO','SEM_SALDO']),parcelas:z.array(z.object({parcelaId:uuid.optional(),valorCentavos:centavos,vencimento:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict()).max(60),credito:z.enum(['NAO_SE_APLICA','MANTER','APROVEITAR']),decisaoContratante:z.enum(['NAO_SE_APLICA','MANTER_APROVEITAMENTO','APROVEITAMENTO_AUTORIZADO','DEVOLUCAO_AO_PAGADOR_ANTERIOR']),justificativa:texto}).strict();
/**
 * C2: tenant (usuário, empresa, membership, papel atual) + posse do contrato + leitura/escrita na MESMA
 * transação (`executor`), com as travas do tenant mantidas até o commit. O corpo (JSON ou arquivo) é lido
 * ANTES da transação, para as travas não esperarem upload. Outra empresa, legado ou inexistente ⇒ 404 igual.
 */
const noTenant=<T>(request:NextRequest,sessao:{usuario_id:string;papel:string},id:string,trabalho:(tx:DbExecutor,tenant:TenantComprovado)=>Promise<T>)=>executarComPosseNoTenant(sessao,request.nextUrl.searchParams.get('empresaId'),id,contratoNoTenant,{withTenantTransaction},trabalho);
function resposta(data:unknown){return NextResponse.json({ok:true,data},{headers:{'Cache-Control':'no-store'}});}
function parse<T>(schema:z.ZodType<T>,data:unknown):T{const r=schema.safeParse(data);if(!r.success)recusarFinanceiro('DADOS_INVALIDOS','Confira os campos informados.',400);return r.data;}
export async function GET(request:NextRequest,context:Params){try{
 const sessao=await exigirApiAdminCrmDisponivel(request),params=await context.params,id=parse(uuid,params.contratoId),a=params.acao??[];
 if(a.length===4&&a[0]==='devolucoes'&&a[2]==='comprovantes'){
  const d=parse(uuid,a[1]),prova=parse(uuid,a[3]);
  return await noTenant(request,sessao,id,async tx=>{
   const p=(await tx.query<{conteudo:Buffer;mime_type:string}>(`SELECT cp.conteudo,cp.mime_type FROM pagamento_devolucao_comprovantes cp JOIN pagamento_devolucoes d ON d.id=cp.devolucao_id JOIN pagamento_gestoes g ON g.pagamento_id=d.pagamento_id WHERE g.contrato_id=$1 AND d.id=$2 AND cp.id=$3`,[id,d,prova])).rows[0];
   if(!p)recusarFinanceiro('RECURSO_NAO_ENCONTRADO','Comprovante não encontrado.',404);
   return new NextResponse(new Uint8Array(p.conteudo),{headers:{'Content-Type':p.mime_type,'Content-Disposition':'attachment; filename="comprovante"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  });
 }
 if(a.length&&!(a.length===1&&a[0]==='historico'))recusarFinanceiro('RECURSO_NAO_ENCONTRADO','Rota não encontrada.',404);
 return resposta(await noTenant(request,sessao,id,async (tx,tenant)=>({painel:await consultarPainelFinanceiro(id,tx),papel:tenant.papelAtual})));
}catch(e){return erroPagamentoApi(e);}}
export async function POST(request:NextRequest,context:Params){try{
 const sessao=await exigirApiAdminCrmDisponivel(request);
 const params=await context.params,id=parse(uuid,params.contratoId),a=params.acao??[];
 const chave=parse(uuid,request.headers.get('Idempotency-Key'));
 const anexo=a.length===3&&a[0]==='devolucoes'&&a[2]==='comprovantes';
 let arquivo:{nome:string;tipo:string;conteudo:Buffer}|null=null,body:unknown=null;
 if(anexo){const form=await request.formData(),f=form.get('arquivo');if(!(f instanceof File)||f.size>10485760)recusarFinanceiro('DADOS_INVALIDOS','Informe um arquivo de até 10 MiB.',400);arquivo={nome:f.name,tipo:f.type,conteudo:Buffer.from(await f.arrayBuffer())};}
 else body=await request.json().catch(()=>null);
 return await noTenant(request,sessao,id,async (tx,tenant)=>{
  const ctx={token:tokenAdmin(request),requestId:randomUUID(),ip:null,userAgent:request.headers.get('user-agent')?.slice(0,1000)??null,executor:tx,papelNoTenant:tenant.papelAtual};
  if(anexo&&arquivo)return resposta(await anexarComprovanteDevolucao(id,parse(uuid,a[1]),arquivo.nome,arquivo.tipo,arquivo.conteudo,chave,ctx));
  if(a.length===3&&a[0]==='pendencias'&&a[2]==='tratamentos'){const b=parse(z.object({posicaoHash:hash}).strict(),body);return resposta(await iniciarTratamento(id,parse(uuid,a[1]),b.posicaoHash,chave,ctx));}
  if(a.length===3&&a[0]==='tratamentos'){
   const t=parse(uuid,a[1]);
   if(a[2]==='cancelar'){const b=parse(z.object({motivo:texto}).strict(),body);return resposta(await cancelarTratamento(id,t,b.motivo,chave,ctx));}
   if(a[2]==='simulacao')return resposta(await simularAlteracao(id,t,parse(resolucao,body),tx));
   if(a[2]==='resolver')return resposta(await resolverAlteracao(id,t,parse(resolucao,body),chave,ctx));
  }
  if(a.length===2&&a[0]==='cronograma'){
   const b=parse(resolucao,body);
   if(a[1]==='simulacao')return resposta(serializarFinanceiro(simularPosicao(await lerPosicaoFinanceira(tx,id),b,true)));
   if(a[1]==='reprogramar')return resposta(await reprogramarCronograma(id,b,chave,ctx));
  }
  if(a.length===1&&a[0]==='devolucoes')return resposta(await solicitarDevolucao(id,parse(z.object({posicaoHash:hash,valorCentavos:centavos,beneficiarioClienteId:uuid.optional(),beneficiario:z.object({nome:texto,documento:z.string().trim().max(40).optional()}).strict(),motivo:texto,origens:z.array(z.object({alocacaoId:uuid,valorCentavos:centavos}).strict()).min(1).max(120)}).strict(),body),chave,ctx));
  if(a.length===3&&a[0]==='devolucoes'){
   const d=parse(uuid,a[1]);
   if(a[2]==='cancelar'){const b=parse(z.object({motivo:texto}).strict(),body);return resposta(await cancelarDevolucao(id,d,b.motivo,chave,ctx));}
   if(a[2]==='concluir')return resposta(await concluirDevolucao(id,d,parse(z.object({posicaoHash:hash,devolvidoEm:z.string().datetime({offset:true}),meio:z.enum(['PIX','CARTAO','TRANSFERENCIA','DINHEIRO','OUTRO']),provedorCodigo:z.string().trim().min(1).max(50).optional(),referenciaExterna:z.string().trim().min(1).max(160).optional(),observacao:texto,justificativaSemComprovante:texto.optional()}).strict(),body),chave,ctx));
  }
  recusarFinanceiro('RECURSO_NAO_ENCONTRADO','Rota não encontrada.',404);
 });
}catch(e){return erroPagamentoApi(e);}}
