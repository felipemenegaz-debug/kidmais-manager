import {capacidades,type Capacidade} from './domain.ts';
export const perfis:Record<'GESTAO'|'EQUIPE',readonly Capacidade[]>={
 GESTAO:capacidades,
 EQUIPE:['FESTA_CONSULTAR','FESTA_OPERAR'],
};
export function nomePerfil(atuais:readonly string[]){
 for(const perfil of ['GESTAO','EQUIPE'] as const)if(atuais.length===perfis[perfil].length&&perfis[perfil].every(c=>atuais.includes(c)))return perfil==='GESTAO'?'Gestão':'Equipe';
 return atuais.length?'Acesso personalizado':'Sem acesso';
}

