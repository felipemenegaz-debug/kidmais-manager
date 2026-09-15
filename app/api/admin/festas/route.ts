import {NextRequest,NextResponse} from 'next/server';
import {ZodError,z} from 'zod';
import {randomUUID} from 'node:crypto';
import {exigirApiAdminCrmDisponivel,tokenAdmin} from '@/lib/http/admin-crm-api';
import {aplicarPerfil,consultarPerfis,ambienteFesta,consultarFestas,criarFesta,comandarFesta,administrarCapacidade,consultarCapacidades,administrarArea,FestaError} from '@/lib/festas/service';
export const runtime='nodejs';
export const dynamic='force-dynamic';
function json(data:unknown,status=200){return NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}});}
async function processar(request:NextRequest,write:boolean){try{
 await ambienteFesta(); // Before the shared guard: never refresh a real-database session from Festa.
 await exigirApiAdminCrmDisponivel(request);
 const ctx={token:tokenAdmin(request),requestId:randomUUID(),userAgent:request.headers.get('user-agent')?.slice(0,1000)??null};
 const recurso=request.nextUrl.searchParams.get('recurso');
 const rawId=request.nextUrl.searchParams.get('id');const id=rawId?z.string().uuid().parse(rawId).toLowerCase():undefined;
 const rawCliente=request.nextUrl.searchParams.get('clienteId');const clienteId=rawCliente?z.string().uuid().parse(rawCliente).toLowerCase():undefined;
 if(!write)return json({ok:true,data:recurso==='perfis'?await consultarPerfis(ctx):recurso==='capacidades'?await consultarCapacidades(ctx):await consultarFestas(ctx,id,clienteId)});
 const body=await request.json();
 const data=recurso==='perfis'?await aplicarPerfil(body,ctx):recurso==='capacidades'?await administrarCapacidade(body,ctx):recurso==='areas'?await administrarArea(body,ctx):id?await comandarFesta(id,body,ctx):await criarFesta(body);
 return json({ok:true,data});
 }catch(error){
 if(error instanceof ZodError||error instanceof SyntaxError)return json({ok:false,erro:'Dados inválidos. Confira os campos.'},400);
 if(error instanceof FestaError)return json({ok:false,erro:error.message},error.status);
 const e=error as {httpStatus?:number;message?:string;code?:string};
 if(e.httpStatus)return json({ok:false,erro:e.message},e.httpStatus);
 if(['23505','40001','40P01'].includes(e.code??''))return json({ok:false,erro:'Outra operação alterou este registro. Atualize e tente novamente.'},409);
 if(['23514','23503'].includes(e.code??''))return json({ok:false,erro:'Operação recusada pelas proteções de integridade.'},409);
 console.error('[Festa]',e.code??'erro');return json({ok:false,erro:'Não foi possível concluir a operação.'},500);
 }}
export function GET(r:NextRequest){return processar(r,false);}
export function POST(r:NextRequest){return processar(r,true);}
