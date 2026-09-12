import FestaConsole from '@/components/festas/FestaConsole';
export default async function Page({params}:{params:Promise<{festaId:string}>}){const {festaId}=await params;return <FestaConsole festaId={festaId}/>;}
