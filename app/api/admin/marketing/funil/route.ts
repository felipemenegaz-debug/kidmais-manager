import type { NextRequest } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { parametroData,parametroUuid,rotaMarketing } from '@/lib/marketing/http';
import { exigirUnidadeDaEmpresa } from '@/lib/marketing/campanhas';
import { periodoPadrao,validarPeriodo } from '@/lib/marketing/metricas';
import { hojeSaoPaulo } from '@/lib/marketing/utm';
import { MarketingError } from '@/lib/marketing/erros';
import { relatorioFunil } from '@/lib/oportunidades/consultas';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){
 return rotaMarketing(request,exigirApiAdminCrmDisponivel,{capacidade:'MARKETING_VISUALIZAR'},async({tx,tenant})=>{
  const q=request.nextUrl.searchParams,p=periodoPadrao(hojeSaoPaulo()),de=parametroData(q.get('de'))??p.de,ate=parametroData(q.get('ate'))??p.ate;
  if(!validarPeriodo(de,ate))throw new MarketingError('PERIODO_INVALIDO','Período inválido.',400);
  const unidade=await exigirUnidadeDaEmpresa(tx,tenant.empresaComprovada,parametroUuid(q.get('unidadeId')));
  return relatorioFunil(tx,tenant.empresaComprovada,de,ate,unidade);
 });
}
