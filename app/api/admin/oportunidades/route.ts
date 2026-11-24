import type { NextRequest } from 'next/server';
import { exigirApiAdminCrmDisponivel } from '@/lib/http/admin-crm-api';
import { rotaMarketing, lerCorpo, parametroUuid } from '@/lib/marketing/http';
import { esquemaAcaoContato, executarAcaoContato } from '@/lib/marketing/contatos';
import { hojeSaoPaulo } from '@/lib/marketing/utm';
import { comandoSchema } from '@/lib/oportunidades/modelo';
import { executarOportunidade, clienteDoAlvo, exigirSchema } from '@/lib/oportunidades/service';
import { contadoresMes, listarOportunidades, responsaveis } from '@/lib/oportunidades/consultas';
import { MarketingError } from '@/lib/marketing/erros';
import { lerOrigens } from '@/lib/marketing/origens';
import { listarCampanhas } from '@/lib/marketing/campanhas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Reutiliza as permissões e o plano do Marketing: contatos são dados pessoais já protegidos por essa barreira.
export async function GET(request: NextRequest) {
  return rotaMarketing(request,exigirApiAdminCrmDisponivel,{capacidade:'MARKETING_VISUALIZAR'},async({tx,tenant,capacidades})=>{
    const responsavelId=parametroUuid(request.nextUrl.searchParams.get('responsavelId'));
    if (request.nextUrl.searchParams.has('responsavelId') && !responsavelId) throw new MarketingError('FILTRO_INVALIDO','Responsável inválido.',400);
    const empresaId=tenant.empresaComprovada,hoje=hojeSaoPaulo(),podeEditar=capacidades.includes('MARKETING_CAMPANHAS_EDITAR');
    // "Como conheceu" no Novo contato: as mesmas listas da tela Pedidos e contatos, só para quem registra (sem campanha arquivada).
    const opcoesRegistro=podeEditar?{origens:await lerOrigens(tx,empresaId),campanhas:(await listarCampanhas(tx,empresaId)).map(c=>({id:c.id,nome:c.nome}))}:{};
    return {hoje,usuarioId:tenant.usuarioId,podeEditar,...opcoesRegistro,itens:await listarOportunidades(tx,empresaId,responsavelId),responsaveis:await responsaveis(tx,empresaId),contadores:await contadoresMes(tx,empresaId,hoje,responsavelId)};
  });
}
export async function POST(request: NextRequest) {
  return rotaMarketing(request,exigirApiAdminCrmDisponivel,{capacidade:'MARKETING_CAMPANHAS_EDITAR'},async({tx,tenant})=>{
    const entrada=await lerCorpo(request);
    await exigirSchema(tx);
    if (typeof entrada==='object' && entrada!==null && 'acao' in entrada && entrada.acao==='registrar') {
      const acao=esquemaAcaoContato.parse(entrada);
      if (acao.acao!=='registrar') throw new Error('Ação inválida');
      const resultado=await executarAcaoContato(tx,tenant.empresaComprovada,tenant.usuarioId,acao);
      await clienteDoAlvo(tx,tenant.empresaComprovada,{tipo:'CONTATO',id:resultado.id});
      return resultado;
    }
    return executarOportunidade(tx,tenant.empresaComprovada,tenant.usuarioId,comandoSchema.parse(entrada),tenant.papelAtual==='REPRESENTANTE_AUTORIZADO',tenant.membershipId);
  });
}
