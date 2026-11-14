/** Constantes e montagem de link usadas pelas telas (sem dependência de servidor). */
import { hojeSaoPaulo } from './utm.ts';

/** Data real, única e não passada para o atalho de divulgação. Entrada inválida é ignorada. */
export function dataInicialDaCampanha(valor: unknown, hoje = hojeSaoPaulo()): string | undefined {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor) || valor < hoje) return undefined;
  const data = new Date(`${valor}T12:00:00Z`);
  return Number.isFinite(data.getTime()) && data.toISOString().slice(0, 10) === valor ? valor : undefined;
}

export const CANAIS_CAMPANHA_UI = ["GOOGLE", "INSTAGRAM", "FACEBOOK", "WHATSAPP", "EMAIL", "INDICACAO", "OFFLINE", "OUTRO"] as const;
export const ROTULO_CANAL_UI: Record<(typeof CANAIS_CAMPANHA_UI)[number], string> = {
  GOOGLE: "Google", INSTAGRAM: "Instagram", FACEBOOK: "Facebook", WHATSAPP: "WhatsApp", EMAIL: "E-mail",
  INDICACAO: "Indicação", OFFLINE: "Material impresso / offline", OUTRO: "Outro",
};

/** Link rastreável que a campanha divulga: passa pelo registro de clique antes da página do site. */
export function linkDaCampanha(origemPlataforma: string, slugSite: string, codigoCampanha: string) {
  return `${origemPlataforma.replace(/\/+$/, "")}/s/${encodeURIComponent(slugSite)}/c/${encodeURIComponent(codigoCampanha)}`;
}

/** Gera o arquivo localmente com a biblioteca já usada no projeto. Sem serviço externo. */
export async function baixarQrCampanha(link:string,codigo:string){
 const {default:qrcode}=await import('qrcode-generator');
 const qr=qrcode(0,'M');qr.addData(link);qr.make();
 const blob=new Blob([qr.createSvgTag({cellSize:8,margin:32,scalable:true})],{type:'image/svg+xml'});
 const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='campanha-'+codigo+'.svg';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
