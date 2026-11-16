/** Atalhos locais: abrir WhatsApp nunca envia uma mensagem pelo servidor. */
export function linkChamar(telefone:string|null|undefined,nome:string,texto?:string){
 let numero=(telefone??'').replace(/\D/g,''); if(/^\d{10,11}$/.test(numero))numero='55'+numero;
 if(!/^\d{12,15}$/.test(numero))return null;
 return 'https://wa.me/'+numero+'?text='+encodeURIComponent(texto??('Olá, '+nome+'! Recebemos seu pedido de orçamento. Podemos conversar sobre a festa?'));
}
export function linkNegociacao(c:{clienteId:string|null;dataDesejada:string|null;convidados:number|null}){
 const q=new URLSearchParams();if(c.dataDesejada)q.set('data',c.dataDesejada);if(c.convidados)q.set('convidados',String(c.convidados));
 return '/admin/clientes/'+encodeURIComponent(c.clienteId??'')+'/fechamento?'+q;
}
