// Entrada para agendamento diário externo. Sem configuração e chave ligadas, não abre rede.
import {pathToFileURL} from 'node:url';
export async function executarResumo(env,fetcher=fetch){
 if(env.OPORTUNIDADES_RESUMO_EMAIL!=='true')return {desligado:true};
 const url=new URL(env.OPORTUNIDADES_RESUMO_URL??'');
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/api/integracoes/oportunidades/resumo')throw Error('URL_RECUSADA');
 if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('HTTPS_OBRIGATORIO');
 if(!/^[\x21-\x7e]{32,256}$/.test(env.OPORTUNIDADES_RESUMO_SECRET??''))throw Error('SEGREDO_INVALIDO');
 const r=await fetcher(url,{method:'POST',redirect:'error',headers:{'x-kidmais-worker-secret':env.OPORTUNIDADES_RESUMO_SECRET},signal:AbortSignal.timeout(120000)});
 if(!r.ok)throw Error('RESUMO_RECUSADO_'+r.status);
 const j=await r.json();return j.data;
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)executarResumo(process.env).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('RESUMO_FALHOU');process.exitCode=1;});
