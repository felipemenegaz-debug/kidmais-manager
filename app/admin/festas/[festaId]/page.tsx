import FestaConsole from '@/components/festas/FestaConsole';
import { ContextoKidmais } from '@/components/admin/inteligencia/PerguntarKidmais';
export default async function Page({params}:{params:Promise<{festaId:string}>}){const {festaId}=await params;return <><ContextoKidmais tela="festa" entidadeId={festaId}/><FestaConsole festaId={festaId} convitesEnabled={process.env.CONVITES_ENABLED==='true'}/></>;}
