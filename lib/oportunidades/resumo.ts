import type { DbExecutor } from '../db/contracts.ts';
import type { EnviarEmail, MensagemEmail } from '../acessos/email.ts';
import { withTenantTransaction } from '../saas/provar-tenant.ts';
import { hojeSaoPaulo } from '../marketing/utm.ts';
import { listarOportunidades } from './consultas.ts';
import type { Oportunidade } from './modelo.ts';
import { exigirRecursoPlano } from '../assinatura/recursos-plano.ts';
import { exigirCapacidadeMarketing } from '../marketing/capacidades.ts';

type Transacao = <T>(work:(tx:DbExecutor)=>Promise<T>)=>Promise<T>;
export function mensagemResumo(para:string,empresaId:string,usuarioId:string,hoje:string,itens:Oportunidade[],empresaNome:string):MensagemEmail {
  const texto=`iA.Fest — ${empresaNome} — ações para ${hoje.split('-').reverse().join('/')}\n\n`+itens.map(i=>`${i.proxima!.data<hoje?'Atrasada':'Hoje'} · ${i.proxima!.tipo} · ${i.nome} · ${i.proxima!.data}`).join('\n')+'\n\nConfira os próximos passos em Oportunidades no painel.';
  return {para,assunto:`iA.Fest · ${empresaNome}: suas ações de hoje`,texto,html:'<pre>'+texto.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')+'</pre>',idempotencia:`oportunidades/${empresaId}/${usuarioId}/${hoje}`};
}
/** Só faz consultas se a chave estiver explicitamente ligada. Provedor é injetável, como nos demais e-mails. */
export async function enviarResumosDiarios(deps:{transacao:Transacao;enviar:EnviarEmail;env:Record<string,string|undefined>;tenant?:typeof withTenantTransaction}) {
  if (deps.env.OPORTUNIDADES_RESUMO_EMAIL!=='true') return {desligado:true,enviados:0,falhas:0};
  const hoje=hojeSaoPaulo(),tenantTx=deps.tenant??withTenantTransaction;
  const candidatos=await deps.transacao(async tx=>(await tx.query<{empresa_id:string;usuario_id:string}>(`SELECT DISTINCT a.empresa_id::text,(CASE WHEN a.fechamento_id IS NOT NULL THEN f.usuario_responsavel_id ELSE a.responsavel_id END)::text AS usuario_id
    FROM oportunidades_acoes a JOIN empresas e ON e.id=a.empresa_id AND e.status='ATIVA'
    LEFT JOIN fechamentos f ON f.empresa_id=a.empresa_id AND f.id=a.fechamento_id
    WHERE a.encerrada_em IS NULL AND a.data<=$1::date
    AND (CASE WHEN a.fechamento_id IS NOT NULL THEN f.usuario_responsavel_id ELSE a.responsavel_id END) IS NOT NULL ORDER BY 1,2`,[hoje])).rows);
  let enviados=0,falhas=0;
  for (const c of candidatos) {
    try {
      const sessao={usuario_id:c.usuario_id,empresa_ativa_id:c.empresa_id,papel:'ADMINISTRATIVO'};
      await tenantTx(sessao,null,async(tx,tenant)=>{
        await exigirRecursoPlano(tx,tenant.empresaComprovada,'MARKETING');
        await exigirCapacidadeMarketing(tx,tenant,'MARKETING_VISUALIZAR');
        const u=(await tx.query<{email:string}>('SELECT email FROM usuarios_administrativos WHERE id=$1::uuid AND ativo',[tenant.usuarioId])).rows[0];
        if (!u) return;
        const itens=(await listarOportunidades(tx,tenant.empresaComprovada,tenant.usuarioId)).filter(i=>i.proxima&&i.proxima.data<=hoje);
        if (!itens.length) return;
        const empresa=(await tx.query<{nome:string}>('SELECT nome FROM empresas WHERE id=$1::uuid',[tenant.empresaComprovada])).rows[0];
        const mensagem=mensagemResumo(u.email,tenant.empresaComprovada,tenant.usuarioId,hoje,itens,empresa.nome);
        const acoes=itens.map(i=>i.proxima!.id).sort();
        await tx.query(`INSERT INTO oportunidades_resumos(empresa_id,usuario_id,dia,mensagem) VALUES($1::uuid,$2::uuid,$3::date,$4::jsonb) ON CONFLICT DO NOTHING`,[tenant.empresaComprovada,tenant.usuarioId,hoje,JSON.stringify({mensagem,acoes})]);
      });
      // Fotografia já persistida: chave e conteúdo são os mesmos mesmo se o processo cair após o aceite do provedor.
      await tenantTx(sessao,null,async(tx,tenant)=>{
        await exigirRecursoPlano(tx,tenant.empresaComprovada,'MARKETING');
        await exigirCapacidadeMarketing(tx,tenant,'MARKETING_VISUALIZAR');
        const registro=(await tx.query<{mensagem:{mensagem:MensagemEmail;acoes:string[]};estado:string}>('SELECT mensagem,estado FROM oportunidades_resumos WHERE empresa_id=$1::uuid AND usuario_id=$2::uuid AND dia=$3::date FOR UPDATE',[tenant.empresaComprovada,tenant.usuarioId,hoje])).rows[0];
        if (!registro || registro.estado!=='PENDENTE') return;
        const itens=(await listarOportunidades(tx,tenant.empresaComprovada,tenant.usuarioId)).filter(i=>i.proxima&&i.proxima.data<=hoje);
        const email=(await tx.query<{email:string}>('SELECT email FROM usuarios_administrativos WHERE id=$1::uuid AND ativo',[tenant.usuarioId])).rows[0]?.email;
        let estado='OBSOLETO';
        if (email===registro.mensagem.mensagem.para && JSON.stringify(itens.map(i=>i.proxima!.id).sort())===JSON.stringify(registro.mensagem.acoes)) {
          try {await deps.enviar(registro.mensagem.mensagem);estado='ENVIADO';enviados++;} catch {estado='FALHOU';falhas++;}
        }
        await tx.query("UPDATE oportunidades_resumos SET estado=$4,enviado_em=CASE WHEN $4='ENVIADO' THEN clock_timestamp() END WHERE empresa_id=$1::uuid AND usuario_id=$2::uuid AND dia=$3::date",[tenant.empresaComprovada,tenant.usuarioId,hoje,estado]);
      });
    } catch {falhas++;}
  }
  return {desligado:false,enviados,falhas};
}
