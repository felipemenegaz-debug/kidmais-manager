import { NextResponse,type NextRequest } from 'next/server';
import { withTransaction } from '@/lib/db/postgres';
import { criarEnviarEmail } from '@/lib/acessos/email';
import { secretMatches } from '@/lib/integracoes/gupshup/webhook';
import { enviarResumosDiarios } from '@/lib/oportunidades/resumo';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:NextRequest){
 const responder=(corpo:unknown,status=200)=>NextResponse.json(corpo,{status,headers:{'Cache-Control':'no-store'}});
 const segredo=process.env.OPORTUNIDADES_RESUMO_SECRET;
 if(!segredo||segredo.length<32||!secretMatches(request.headers.get('x-kidmais-worker-secret')??'',segredo))return responder({ok:false,codigo:'NAO_AUTORIZADO'},401);
 if(process.env.OPORTUNIDADES_RESUMO_EMAIL!=='true')return responder({ok:false,codigo:'RESUMO_DESLIGADO'},409);
 try{return responder({ok:true,data:await enviarResumosDiarios({transacao:withTransaction,enviar:criarEnviarEmail(),env:process.env})});}
 catch{return responder({ok:false,codigo:'RESUMO_FALHOU'},500);}
}
