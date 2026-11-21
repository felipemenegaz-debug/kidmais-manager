import { encerrarGarantia } from '../pre-reserva/destinacao.ts';
import { exigirGestaoNoTenant, type TenantComprovado } from '../saas/provar-tenant.ts';
import type { DbExecutor } from '../db/contracts.ts';
import { registrarEventoHistorico } from '../clientes/repositories/historico.repository.ts';
import { registrarAuditoria } from '../clientes/repositories/auditoria.repository.ts';
import { buscarRevisaoDaVersao } from '../fechamentos/repositories/revisao.repository.ts';
import { cancelarPreparacao } from '../fechamentos/services/revisao-operacional.service.ts';
import { travarConfiguracaoAgenda } from '../agenda/trava-configuracao.ts';
import { clienteDoContato } from '../marketing/contatos.ts';
import { conflito, MarketingError, naoEncontrado } from '../marketing/erros.ts';
import { gravarPerda } from './perda.ts';
import { comandoSchema, etapaDoEstado, type Alvo, type Comando } from './modelo.ts';

export async function exigirSchema(tx: DbExecutor) {
  if (!(await tx.query<{ ok: boolean }>("SELECT to_regclass('public.oportunidades_acoes') IS NOT NULL AS ok")).rows[0]?.ok)
    throw new MarketingError('OPORTUNIDADES_INDISPONIVEIS', 'Oportunidades indisponíveis neste ambiente.', 503);
}

export async function clienteDoAlvo(tx: DbExecutor, empresaId: string, alvo: Alvo, estadoExigido?: 'AGUARDANDO_CONTRATO') {
  const contato = alvo.tipo === 'CONTATO';
  const r = (await tx.query<{ cliente_id: string | null; status: string; nome?: string; telefone?: string | null; email?: string | null }>(
    `SELECT cliente_id::text,status${contato ? ',nome,telefone,email' : ''} FROM ${contato ? 'marketing_contatos' : 'fechamentos'} WHERE empresa_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [empresaId, alvo.id])).rows[0];
  if (!r) naoEncontrado();
  if (estadoExigido && r.status !== estadoExigido) conflito("O pedido já não está aguardando contrato. Atualize a revisão.");
  if (!r.cliente_id && contato) {
    const cliente = await clienteDoContato(tx, empresaId, { nome: r.nome!, telefone: r.telefone ?? null, email: r.email ?? null });
    r.cliente_id = cliente.clienteId;
    await tx.query("UPDATE marketing_contatos SET cliente_id=$3::uuid,vinculo_cliente='MANUAL' WHERE empresa_id=$1::uuid AND id=$2::uuid", [empresaId, alvo.id, r.cliente_id]);
  }
  if (!r.cliente_id) throw new MarketingError('OPORTUNIDADE_SEM_CLIENTE', 'Vincule a negociação a um cliente primeiro.', 409);
  return r as typeof r & { cliente_id: string };
}

async function contratoParaPerda(tx: DbExecutor, fechamentoId: string, empresaId: string, membershipId: string | undefined, travar: boolean) {
  const trava = travar ? 'FOR UPDATE' : '';
  const contrato = (await tx.query<{id: string; status: string}>(`SELECT id::text,status FROM contratos WHERE fechamento_id=$1::uuid ${trava}`,[fechamentoId])).rows[0];
  if (contrato) {
    const fluxo = (await tx.query<{versao_vigente_id: string | null; versao_em_preparacao_id: string | null}>(`SELECT versao_vigente_id,versao_em_preparacao_id FROM contrato_fluxos WHERE contrato_id=$1::uuid ${trava}`,[contrato.id])).rows[0];
    if (contrato.status!=='AGUARDANDO_ASSINATURA' || fluxo?.versao_vigente_id) conflito('Use o cancelamento da Festa para este contrato.');
    if (!(await tx.query("SELECT 1 FROM festa_membership_capacidades WHERE membership_id=$1::uuid AND empresa_id=$2::uuid AND capacidade='FESTA_CORRIGIR' AND revogado_em IS NULL",[membershipId ?? null,empresaId])).rows.length)
      throw new MarketingError('OPORTUNIDADE_SEM_PERMISSAO','Somente a Gestão com acesso ao contrato pode cancelar a contratação.',403);
    if ((await tx.query("SELECT 1 FROM contrato_assinaturas WHERE contrato_versao_id IN (SELECT id FROM contrato_versoes WHERE contrato_id=$1::uuid) AND parte='CLIENTE' LIMIT 1",[contrato.id])).rows.length ||
      (await tx.query('SELECT 1 FROM festas WHERE contrato_id=$1::uuid UNION ALL SELECT 1 FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id WHERE v.contrato_id=$1::uuid LIMIT 1',[contrato.id])).rows.length)
      conflito('Há assinatura, Festa ou plano financeiro. Use o fluxo de cancelamento do contrato.');
    return { id: contrato.id, preparacaoId: fluxo?.versao_em_preparacao_id };
  }
  return null;
}

export async function situacaoRecusa(tx: DbExecutor, fechamentoId: string, tenant: TenantComprovado) {
  await exigirSchema(tx);
  const contrato = await contratoParaPerda(tx, fechamentoId, tenant.empresaComprovada, tenant.membershipId, false);
  return contrato ? 'COM_PREPARACAO' as const : 'SEM_CONTRATO' as const;
}

async function acaoAberta(tx: DbExecutor, empresaId: string, alvo: Alvo) {
  const coluna = alvo.tipo === 'CONTATO' ? 'contato_id' : 'fechamento_id';
  return (await tx.query<{ id: string }>(`SELECT id::text FROM oportunidades_acoes WHERE empresa_id=$1::uuid AND ${coluna}=$2::uuid AND encerrada_em IS NULL FOR UPDATE`, [empresaId,alvo.id])).rows[0];
}

async function perder(tx: DbExecutor, empresaId: string, usuarioId: string, cmd: Pick<Extract<Comando, { acao: 'perder' }>, 'alvo' | 'perda' | 'concluir'>,
  atual: { status: string; cliente_id: string }, aberta: { id: string } | undefined, gestao: boolean, membershipId?: string) {
  if (cmd.alvo.tipo === 'FECHAMENTO') {
    if (!gestao) throw new MarketingError('OPORTUNIDADE_SEM_PERMISSAO','Somente a Gestão pode cancelar a negociação.',403);
    if (['CONTRATO_ASSINADO','AGUARDANDO_PAGAMENTO'].includes(atual.status)) conflito('Use o cancelamento de contrato na tela do contrato.');
    // O fluxo contratual existente preserva preparação, assinaturas e financeiro; nunca o contornar.
    const contrato = await contratoParaPerda(tx, cmd.alvo.id, empresaId, membershipId, true);
    if (contrato) {
      const preparacao = contrato.preparacaoId ? await buscarRevisaoDaVersao(contrato.preparacaoId,tx,true) : null;
      if (preparacao && ['EM_ELABORACAO','CONGELADA'].includes(preparacao.estado)) await cancelarPreparacao(tx,preparacao,{usuarioId,requestId:null,ip:null,userAgent:null},cmd.perda.motivo);
      await tx.query("UPDATE contratos SET status='CANCELADO',cancelado_em=clock_timestamp() WHERE id=$1::uuid",[contrato.id]);
      await registrarAuditoria({clienteId:atual.cliente_id,usuarioId,atorTipo:'USUARIO',acao:'CONTRATO_CANCELADO_ANTES_DA_FORMALIZACAO',entidadeTipo:'CONTRATO',entidadeId:contrato.id,dadosDepois:{motivo:cmd.perda.motivo},origem:'CRM_INTERNO'},tx);
    }
  }
  if (cmd.concluir && aberta) await concluirAcao(tx,empresaId,usuarioId,atual.cliente_id,cmd.alvo,aberta.id);
  await tx.query(`UPDATE ${cmd.alvo.tipo === 'CONTATO' ? 'marketing_contatos' : 'fechamentos'} SET status=$3 WHERE empresa_id=$1::uuid AND id=$2::uuid`,[empresaId,cmd.alvo.id,cmd.alvo.tipo === 'CONTATO' ? 'DESCARTADO' : 'CANCELADO']);
  if (cmd.alvo.tipo === 'FECHAMENTO') await encerrarGarantia(tx, empresaId, cmd.alvo.id, 'RECUSA');
  await gravarPerda(tx,empresaId,usuarioId,cmd.alvo,atual.cliente_id,cmd.perda);
  return { perdida: true };
}

export async function recusarPedido(tx: DbExecutor, tenant: TenantComprovado, id: string, perda: Extract<Comando, { acao: 'perder' }>['perda']) {
  exigirGestaoNoTenant(tenant, 'Somente a Gestão pode recusar o pedido.');
  const empresaId = tenant.empresaComprovada;
  await exigirSchema(tx);
  await travarConfiguracaoAgenda(tx, empresaId, { modo: 'COMPARTILHADA', linha: 'JA_TRAVADA' });
  const alvo = { tipo: 'FECHAMENTO' as const, id };
  const atual = await clienteDoAlvo(tx, empresaId, alvo, 'AGUARDANDO_CONTRATO');
  const aberta = await acaoAberta(tx, empresaId, alvo);
  return perder(tx, empresaId, tenant.usuarioId, { alvo, perda }, atual, aberta, true, tenant.membershipId);
}

export async function executarOportunidade(tx: DbExecutor, empresaId: string, usuarioId: string, entrada: Comando, gestao: boolean, membershipId?: string) {
  const cmd = comandoSchema.parse(entrada);
  await exigirSchema(tx);
  // Toda ação numa negociação grava em fechamentos (perda, responsável do próximo passo): a 114 exige a configuração
  // da agenda travada nesta transação antes da linha do fechamento (empresa → configuração → resto).
  if (cmd.alvo.tipo==='FECHAMENTO') await travarConfiguracaoAgenda(tx,empresaId,{modo:'COMPARTILHADA',linha:'JA_TRAVADA'});
  const atual = await clienteDoAlvo(tx, empresaId, cmd.alvo);
  if (!etapaDoEstado(atual.status, cmd.alvo.tipo === 'CONTATO')) conflito('Esta oportunidade já foi encerrada. Atualize a tela.');
  if (cmd.alvo.tipo === 'CONTATO' && (await tx.query(`SELECT 1 FROM marketing_contatos k WHERE k.empresa_id=$1::uuid AND k.id=$2::uuid AND
    k.fechamento_id IS NOT NULL`, [empresaId,cmd.alvo.id])).rows.length)
    conflito('Este contato já tem negociação. Abra a negociação.');
  const aberta = await acaoAberta(tx, empresaId, cmd.alvo);
  if ((aberta?.id ?? null) !== cmd.esperada) conflito('A próxima ação mudou. Atualize a tela antes de salvar.');
  if (cmd.acao === 'perder') {
    return perder(tx, empresaId, usuarioId, cmd, atual, aberta, gestao, membershipId);
  }
  const responsavel = await tx.query(`SELECT 1 FROM memberships m JOIN usuarios_administrativos u ON u.id=m.usuario_id
    WHERE m.empresa_id=$1::uuid AND m.usuario_id=$2::uuid AND m.status='ATIVA' AND u.ativo
    AND (m.papel='REPRESENTANTE_AUTORIZADO' OR EXISTS(SELECT 1 FROM marketing_membership_capacidades cap WHERE cap.empresa_id=m.empresa_id AND cap.membership_id=m.id AND cap.revogado_em IS NULL))
    FOR SHARE OF m,u`,[empresaId,cmd.proxima.responsavelId]);
  if (!responsavel.rows.length) naoEncontrado('Responsável indisponível nesta empresa.');
  if (aberta) {
    if (cmd.acao === 'concluir') await concluirAcao(tx,empresaId,usuarioId,atual.cliente_id,cmd.alvo,aberta.id);
    else await tx.query("UPDATE oportunidades_acoes SET encerrada_em=clock_timestamp(),resultado='SUBSTITUIDA' WHERE empresa_id=$1::uuid AND id=$2::uuid",[empresaId,aberta.id]);
  }
  const coluna = cmd.alvo.tipo === "CONTATO" ? "contato_id" : "fechamento_id";
  const nova = (await tx.query<{ id: string }>(`INSERT INTO oportunidades_acoes(empresa_id,${coluna},responsavel_id,tipo,data,observacao,criada_por)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::date,$6,$7::uuid) RETURNING id::text`,[empresaId,cmd.alvo.id,cmd.proxima.responsavelId,cmd.proxima.tipo,cmd.proxima.data,cmd.proxima.observacao || null,usuarioId])).rows[0];
  await tx.query(`UPDATE ${cmd.alvo.tipo === 'CONTATO' ? 'marketing_contatos' : 'fechamentos'} SET ${cmd.alvo.tipo === 'CONTATO' ? 'responsavel_id' : 'usuario_responsavel_id'}=$3::uuid WHERE empresa_id=$1::uuid AND id=$2::uuid`,[empresaId,cmd.alvo.id,cmd.proxima.responsavelId]);
  await registrarEventoHistorico({clienteId:atual.cliente_id,usuarioId,tipoEvento:'OPORTUNIDADE_PROXIMA_ACAO',origem:'CRM_INTERNO',entidadeTipo:cmd.alvo.tipo,entidadeId:cmd.alvo.id,
    metadata:{anteriorId:aberta?.id ?? null,acaoId:nova.id,...cmd.proxima}},tx);
  return { id: nova.id };
}
async function concluirAcao(tx: DbExecutor,empresaId: string,usuarioId: string,clienteId: string,alvo: Alvo,id: string) {
  await tx.query("UPDATE oportunidades_acoes SET encerrada_em=clock_timestamp(),resultado='FEITA' WHERE empresa_id=$1::uuid AND id=$2::uuid",[empresaId,id]);
  await registrarEventoHistorico({clienteId,usuarioId,tipoEvento:'OPORTUNIDADE_ACAO_FEITA',origem:'CRM_INTERNO',entidadeTipo:alvo.tipo,entidadeId:alvo.id,metadata:{acaoId:id}},tx);
}
