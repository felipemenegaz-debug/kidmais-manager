import { withTransaction, db } from '../../db/postgres.ts';
import type { DbExecutor } from '../../db/contracts.ts';
import { withTenantTransaction, type SessaoParaTenant, type TenantComprovado } from '../../saas/provar-tenant.ts';
import { atendimentoAtivo, ambienteAtendimento, contatoPermitido, empresaPiloto, recepcaoAtiva, receptorDoNumero } from './configuracao.ts';
import { configuracaoSchema, comandoDireto, conferirEmpresaAtiva, janelaAberta, nomePerfilSeguro, situacaoCadastro, type CadastroContato, type Entrada } from './core.ts';

export type Conversa = { id: string; empresa_id: string; ambiente: string; contato: string; estado: 'IA' | 'HUMANO' | 'AGUARDANDO_HUMANO' | 'ENCERRADA'; responsavel_id: string | null; nao_contatar: boolean; versao: number; ultima_entrada_em: string; atualizada_em?: string; interesse: { data: string | null; convidados: number | null } };
export type Mensagem = { id: string; conversa_id: string; empresa_id: string; ambiente: string; origem_id: string | null; autor_usuario_id: string | null; texto: string | null; direcao: string; estado: string; versao_conversa: number; criada_em: string };
/**
 * Linha da tela de Atendimento (só para quem passa por acessoAtendimento: ADMINISTRATIVO ou REPRESENTANTE da empresa
 * piloto comprovada). Leva o número completo, o vínculo com o cadastro DA EMPRESA (sem escolher entre vários) e o nome
 * de perfil do WhatsApp, que NÃO é verificado. Nada disso vai ao modelo nem a logs.
 */
export type ConversaLista = Conversa & { contato_final: string; responsavel_nome: string | null; nome_perfil: string | null; cadastro: CadastroContato };
type LinhaConversa = Omit<ConversaLista, 'cadastro'> & { clientes: number; cliente_nome: string | null };

/**
 * A coluna nome_perfil chega com a migration 065; sem ela (ou depois do rollback), o atendimento segue sem o nome de
 * perfil. Consulta de catálogo a cada uso, sem cache: aplicar ou reverter a 065 não exige reiniciar a aplicação.
 */
async function temNomePerfil(tx: DbExecutor) {
  const r = await tx.query<{ existe: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.whatsapp_atendimento_conversas') AND attname='nome_perfil' AND NOT attisdropped) AS existe`);
  return !!r.rows[0]?.existe;
}
export type MensagemLista = Pick<Mensagem, 'id' | 'conversa_id' | 'direcao' | 'texto' | 'estado' | 'criada_em'> & { humana: boolean };
/** Situação do canal neste ambiente, em partes separadas: receber, responder e a configuração da empresa. */
export type EstadoCanal = { ambiente: string; receptor: boolean; recepcao: boolean; envio: boolean };
/**
 * `travar`: FOR SHARE na linha da configuração até o fim da transação. Salvar a configuração espera essa transação
 * terminar (e grava `atualizada_em` depois dela); quem trava depois de um salvamento lê a versão nova.
 */
export async function configuracao(tx: DbExecutor, empresaId: string, travar = false) {
  const r = await tx.query<{ configuracao: unknown }>(`SELECT configuracao FROM whatsapp_atendimento_config WHERE empresa_id=$1 AND ambiente=$2${travar ? ' FOR SHARE' : ''}`, [empresaId, ambienteAtendimento()]);
  const parsed = configuracaoSchema.safeParse(r.rows[0]?.configuracao);
  return parsed.success ? parsed.data : null;
}
export async function receberEntrada(entrada: Entrada) {
  const empresa = empresaPiloto(), ambiente = ambienteAtendimento();
  // Fora da lista de contatos permitidos: confirma o evento sem gravar nada (nenhum dado do contato entra no banco).
  if (!contatoPermitido(entrada.source)) return;
  if (entrada.app !== 'KidmaisManager') throw new Error('ATENDIMENTO_EVENTO_INVALIDO');
  // A sessão usa o horário do evento no Gupshup (ms); replay não reabre a janela. Horário à frente do relógio local
  // (diferença de relógio) vale como agora: recusar faria o provedor repetir o evento sem fim.
  const em = new Date(Math.min(entrada.timestamp, Date.now())).toISOString();
  await withTransaction(async tx => {
    // Condições que um retry não corrige não devolvem 503 (o Gupshup repetiria até desistir e a mensagem se perderia).
    // Empresa suspensa: confirma sem gravar. Sem trava na linha da empresa: o worker revalida antes de enviar, e uma
    // transação administrativa longa não segura o webhook além do prazo de 10 s do provedor.
    const ativa = await tx.query('SELECT id FROM empresas WHERE id=$1 AND status=\'ATIVA\'', [empresa]);
    if (!ativa.rows.length) return;
    // Sem configuração salva: grava para a equipe, sem automação.
    const config = await configuracao(tx, empresa);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`wa:${ambiente}:${empresa}:${entrada.source}`]);
    if ((await tx.query('SELECT id FROM whatsapp_atendimento_mensagens WHERE empresa_id=$1 AND ambiente=$2 AND externa_id=$3', [empresa, ambiente, entrada.id])).rows.length) return;
    const conversa = (await tx.query<Conversa>(`INSERT INTO whatsapp_atendimento_conversas(empresa_id,ambiente,contato,ultima_entrada_em) VALUES($1,$2,$3,$4)
      ON CONFLICT(empresa_id,ambiente,contato) DO UPDATE SET ultima_entrada_em=GREATEST(whatsapp_atendimento_conversas.ultima_entrada_em,EXCLUDED.ultima_entrada_em),versao=whatsapp_atendimento_conversas.versao+1,atualizada_em=clock_timestamp()
      RETURNING *`, [empresa, ambiente, entrada.source, em])).rows[0];
    // Nome de perfil (não verificado): o mais recente vence; replay antigo não sobrescreve. Não muda versão nem estado.
    const nomePerfil = nomePerfilSeguro(entrada.nomePerfil);
    if (nomePerfil && await temNomePerfil(tx)) {
      await tx.query('UPDATE whatsapp_atendimento_conversas SET nome_perfil=$2,nome_perfil_em=$3 WHERE id=$1 AND (nome_perfil_em IS NULL OR nome_perfil_em<$3)', [conversa.id, nomePerfil, em]);
    }
    // Encerrada pela equipe (sem pedido de PARAR): nova mensagem do cliente reabre como um contato novo.
    const reaberta = conversa.estado === 'ENCERRADA' && !conversa.nao_contatar;
    const estadoAtual = reaberta ? 'IA' : conversa.estado;
    const automatico = atendimentoAtivo() && !!config?.ativo && !conversa.nao_contatar && estadoAtual === 'IA' && entrada.texto !== null;
    await tx.query(`INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,externa_id,direcao,texto,estado,versao_conversa,criada_em) VALUES($1,$2,$3,$4,'ENTRADA',$5,$6,$7,$8)`, [conversa.id, empresa, ambiente, entrada.id, entrada.texto, automatico ? 'PENDENTE' : 'PROCESSADA', conversa.versao, em]);
    if (reaberta) await tx.query('UPDATE whatsapp_atendimento_conversas SET estado=$2,responsavel_id=NULL WHERE id=$1', [conversa.id, automatico ? 'IA' : 'AGUARDANDO_HUMANO']);
    else if (estadoAtual === 'IA' && !automatico) await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='AGUARDANDO_HUMANO' WHERE id=$1", [conversa.id]);
    if (entrada.texto && comandoDireto(entrada.texto)?.intencao === 'PARAR') await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='ENCERRADA',nao_contatar=true,versao=versao+1 WHERE id=$1", [conversa.id]);
  });
}

/** Status sem mensagem correspondente (ex.: OTP do mesmo app, envio que nunca retornou) expira neste prazo. */
export const RETENCAO_STATUS_HORAS = 24;
/** Status é correlacionado só ao envio da empresa piloto; não registra payload ou reason externos. */
export async function receberStatus(raw: unknown) {
  const e = raw as { payload?: { id?: unknown; type?: unknown; gsId?: unknown } };
  const payload = e?.payload;
  const id = typeof payload?.gsId === 'string' ? payload.gsId : payload?.id;
  if (typeof id !== 'string' || !id.length || id.length > 512) return;
  if (!['delivered','read','failed'].includes(String(payload?.type))) return;
  const estado = payload?.type === 'failed' ? 'FALHOU' : 'ENTREGUE';
  await withTransaction(async tx => {
    // Persistir antes da correlação: o callback pode chegar antes do retorno do POST de envio.
    await tx.query(`INSERT INTO whatsapp_atendimento_status(empresa_id,ambiente,provedor_id,estado) VALUES($1,$2,$3,$4) ON CONFLICT(empresa_id,ambiente,provedor_id) DO UPDATE SET estado=CASE WHEN whatsapp_atendimento_status.estado='ENTREGUE' THEN 'ENTREGUE' ELSE EXCLUDED.estado END`, [empresaPiloto(),ambienteAtendimento(),id,estado]);
    await correlacionarStatus(tx, empresaPiloto(), ambienteAtendimento(), id);
  });
  // Retenção também com só a recepção ligada (o processador pode estar desligado): status de OTP não se acumulam.
  // Falha na limpeza não recusa o evento já gravado.
  await limparStatusExpirados().catch(() => {});
}

/** Aplica o status guardado à mensagem com o mesmo identificador e apaga a linha: só os sem correspondência ficam. */
export async function correlacionarStatus(tx: DbExecutor, empresa: string, ambiente: string, provedorId: string) {
  await tx.query("UPDATE whatsapp_atendimento_mensagens m SET estado=s.estado FROM whatsapp_atendimento_status s WHERE m.empresa_id=s.empresa_id AND m.ambiente=s.ambiente AND m.provedor_id=s.provedor_id AND m.empresa_id=$1 AND m.ambiente=$2 AND m.provedor_id=$3 AND m.estado IN ('SUBMETIDA','INCERTO','FALHOU')", [empresa, ambiente, provedorId]);
  await tx.query('DELETE FROM whatsapp_atendimento_status s USING whatsapp_atendimento_mensagens m WHERE s.empresa_id=$1 AND s.ambiente=$2 AND s.provedor_id=$3 AND m.empresa_id=s.empresa_id AND m.ambiente=s.ambiente AND m.provedor_id=s.provedor_id', [empresa, ambiente, provedorId]);
}
/**
 * Toda entrada da tela passa por aqui: primeiro a empresa ativa da sessão (só existe com a 063 do painel; sem ela,
 * comportamento anterior), depois a prova do tenant no banco. Sem vínculo ativo na piloto = sem acesso (403).
 */
async function naEmpresaDoAtendimento<T>(sessao: SessaoParaTenant, work: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>) {
  const piloto = empresaPiloto();
  conferirEmpresaAtiva(sessao, piloto);
  try { return await withTenantTransaction(sessao, piloto, work); }
  catch (erro) { if ((erro as { code?: unknown })?.code === 'TENANT_NAO_COMPROVADO') throw new Error('ATENDIMENTO_SEM_ACESSO'); throw erro; }
}
export async function acessoAtendimento<T>(sessao: SessaoParaTenant, work: (tx: DbExecutor, empresaId: string, papel: string) => Promise<T>) {
  return naEmpresaDoAtendimento(sessao, async (tx, tenant) => {
    if (!['ADMINISTRATIVO','REPRESENTANTE_AUTORIZADO'].includes(tenant.papelAtual)) throw new Error('ATENDIMENTO_ACESSO_NEGADO');
    return work(tx, tenant.empresaComprovada, tenant.papelAtual);
  });
}
export async function listarAtendimento(sessao: SessaoParaTenant, conversaId?: string) {
  return acessoAtendimento(sessao, async (tx, empresa, papel) => {
    const ambiente = ambienteAtendimento();
    const nomePerfil = await temNomePerfil(tx);
    // Nome do responsável só quando ele tem vínculo ativo com a mesma empresa (o mesmo critério do envio humano).
    // Cadastro: clientes DESTA empresa, não mesclados, com o número no telefone ou no WhatsApp, com e sem o 55 (mesma
    // regra de buscarClientesPorContatoExato + variantesTelefone). Com mais de um, só a quantidade: nenhum é escolhido.
    const conversas = (await tx.query<LinhaConversa>(`SELECT c.id,c.empresa_id,c.ambiente,c.contato,right(c.contato,4) AS contato_final,c.estado,c.responsavel_id,c.nao_contatar,c.versao,c.ultima_entrada_em,c.atualizada_em,c.interesse,u.nome AS responsavel_nome,
        ${nomePerfil ? 'c.nome_perfil' : 'NULL::text'} AS nome_perfil,cad.clientes,cad.cliente_nome FROM whatsapp_atendimento_conversas c
      LEFT JOIN usuarios_administrativos u ON u.id=c.responsavel_id AND EXISTS(SELECT 1 FROM memberships m WHERE m.usuario_id=u.id AND m.empresa_id=c.empresa_id AND m.status='ATIVA')
      CROSS JOIN LATERAL (SELECT CASE WHEN c.contato LIKE '55%' AND length(c.contato) IN (12,13) THEN substr(c.contato,3) END AS sem55) v
      CROSS JOIN LATERAL (SELECT count(*)::int AS clientes, CASE WHEN count(*)=1 THEN max(cl.nome_completo) END AS cliente_nome FROM clientes cl
        WHERE cl.empresa_id=c.empresa_id AND cl.status<>'MESCLADO' AND (cl.telefone IN (c.contato,v.sem55) OR cl.whatsapp IN (c.contato,v.sem55))) cad
      WHERE c.empresa_id=$1 AND c.ambiente=$2 ORDER BY c.atualizada_em DESC LIMIT 100`, [empresa, ambiente])).rows;
    const mensagens = conversaId ? (await tx.query<MensagemLista>('SELECT id,conversa_id,direcao,texto,estado,criada_em,autor_usuario_id IS NOT NULL AS humana FROM whatsapp_atendimento_mensagens WHERE empresa_id=$1 AND ambiente=$2 AND conversa_id=$3 ORDER BY criada_em DESC,id DESC LIMIT 100', [empresa, ambiente, conversaId])).rows.reverse() : [];
    const canal: EstadoCanal = { ambiente, receptor: receptorDoNumero(), recepcao: recepcaoAtiva(), envio: atendimentoAtivo() };
    const lista: ConversaLista[] = conversas.map(({ clientes, cliente_nome, ...c }) => ({ ...c, versao: Number(c.versao), cadastro: situacaoCadastro(Number(clientes ?? 0), cliente_nome) }));
    return { conversas: lista, mensagens, usuarioId: sessao.usuario_id, configuracao: await configuracao(tx, empresa), automacaoDisponivel: atendimentoAtivo(), canal, podeConfigurar: papel === 'REPRESENTANTE_AUTORIZADO' };
  });
}
export async function controlarAtendimento(sessao: SessaoParaTenant, pedido: { acao: 'assumir' | 'retomar' | 'encerrar' | 'enviar'; conversaId: string; texto?: string; versao: number }) {
  return acessoAtendimento(sessao, async (tx, empresa) => {
    const ambiente = ambienteAtendimento();
    const conversa = (await tx.query<Conversa>('SELECT * FROM whatsapp_atendimento_conversas WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 FOR UPDATE', [pedido.conversaId, empresa, ambiente])).rows[0];
    if (!conversa) throw new Error('ATENDIMENTO_NAO_ENCONTRADO');
    if (Number(conversa.versao) !== pedido.versao) throw new Error('ATENDIMENTO_DESATUALIZADO');
    if (conversa.nao_contatar && pedido.acao !== 'encerrar') throw new Error('ATENDIMENTO_CONTATO_BLOQUEADO');
    if ((await tx.query("SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND estado='ENVIANDO'", [conversa.id])).rows.length) throw new Error('ATENDIMENTO_ENVIO_EM_ANDAMENTO');
    const canceladas = { entradas: 0, saidas: 0 };
    if (pedido.acao === 'encerrar') {
      // Na MESMA transação do encerramento, sob a trava da conversa: entradas ainda sem resposta automática e saídas na
      // fila (automáticas ou do atendente) viram CANCELADA; o histórico fica. ENVIANDO já recusou acima (envio iniciado
      // não é cancelado). SKIP LOCKED evita espera cruzada com o worker, que trava a mensagem ANTES da conversa:
      // a linha que ele segura neste instante é PULADA aqui (não entra no contador) e é cancelada DEPOIS pelo próprio
      // worker, que espera esta transação terminar, revalida sob a trava da conversa, vê ENCERRADA e grava CANCELADA
      // (worker.ts: reserva, interpretação e envio). Evidência: encerrar-concorrencia.postgres.test.ts.
      for (const { direcao } of (await tx.query<{ direcao: string }>(`UPDATE whatsapp_atendimento_mensagens SET estado='CANCELADA' WHERE id IN (
        SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND empresa_id=$2 AND ambiente=$3 AND estado IN ('PENDENTE','PROCESSANDO') FOR UPDATE SKIP LOCKED) RETURNING direcao`, [conversa.id, empresa, ambiente])).rows) {
        if (direcao === 'ENTRADA') canceladas.entradas++; else canceladas.saidas++;
      }
    }
    if (pedido.acao === 'enviar') {
      if (!atendimentoAtivo() || !(await configuracao(tx,empresa))?.ativo) throw new Error('ATENDIMENTO_AUTOMACAO_DESLIGADA');
      if (!pedido.texto || conversa.estado !== 'HUMANO' || conversa.responsavel_id !== sessao.usuario_id) throw new Error('ATENDIMENTO_ASSUMA_ANTES_DE_ENVIAR');
      if (!janelaAberta(new Date(conversa.ultima_entrada_em), new Date())) throw new Error('ATENDIMENTO_JANELA_EXPIRADA');
      await tx.query(`INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,direcao,texto,estado,versao_conversa,autor_usuario_id) VALUES($1,$2,$3,'SAIDA',$4,'PENDENTE',$5,$6)`, [conversa.id, empresa, ambiente, pedido.texto, Number(conversa.versao) + 1,sessao.usuario_id]);
    }
    const estado = pedido.acao === 'retomar' ? 'IA' : pedido.acao === 'encerrar' ? 'ENCERRADA' : 'HUMANO';
    if (pedido.acao === 'retomar' && (!atendimentoAtivo() || !(await configuracao(tx, empresa))?.ativo)) throw new Error('ATENDIMENTO_AUTOMACAO_DESLIGADA');
    await tx.query('UPDATE whatsapp_atendimento_conversas SET estado=$2,responsavel_id=$3,versao=versao+1,atualizada_em=clock_timestamp() WHERE id=$1', [conversa.id, estado, estado === 'HUMANO' ? sessao.usuario_id : null]);
    await tx.query('INSERT INTO whatsapp_atendimento_auditoria(empresa_id,ambiente,usuario_id,acao,conversa_id) VALUES($1,$2,$3,$4,$5)', [empresa, ambiente, sessao.usuario_id, pedido.acao, conversa.id]);
    return { canceladas };
  });
}
export async function salvarConfiguracao(sessao: SessaoParaTenant, valor: unknown) {
  // Acesso antes do conteúdo: empresa ativa, vínculo e papel são conferidos antes de validar a configuração enviada.
  return naEmpresaDoAtendimento(sessao, async (tx, tenant) => {
    if (tenant.papelAtual !== 'REPRESENTANTE_AUTORIZADO') throw new Error('ATENDIMENTO_ACESSO_NEGADO');
    const config = configuracaoSchema.parse(valor);
    if (config.ativo && !atendimentoAtivo()) throw new Error('ATENDIMENTO_AUTOMACAO_DESLIGADA');
    await tx.query(`INSERT INTO whatsapp_atendimento_config(empresa_id,ambiente,configuracao) VALUES($1,$2,$3::jsonb) ON CONFLICT(empresa_id,ambiente) DO UPDATE SET configuracao=EXCLUDED.configuracao,atualizada_em=clock_timestamp()`, [tenant.empresaComprovada, ambienteAtendimento(), JSON.stringify(config)]);
    await tx.query('INSERT INTO whatsapp_atendimento_auditoria(empresa_id,ambiente,usuario_id,acao) VALUES($1,$2,$3,$4)', [tenant.empresaComprovada, ambienteAtendimento(), sessao.usuario_id, 'CONFIGURACAO_ATUALIZADA']);
  });
}
/** Retenção: status sem correspondência por mais de 24 h é apagado em lotes (só identificador e estado, sem conteúdo). */
export async function limparStatusExpirados() {
  await db().query(`DELETE FROM whatsapp_atendimento_status WHERE ctid IN (SELECT ctid FROM whatsapp_atendimento_status WHERE empresa_id=$1 AND ambiente=$2 AND recebido_em < clock_timestamp()-make_interval(hours => $3) LIMIT 1000)`, [empresaPiloto(), ambienteAtendimento(), RETENCAO_STATUS_HORAS]);
}
export async function recuperarTrabalhosInterrompidos() {
  // Estado incerto nunca é reenviado automaticamente após reinício.
  await db().query(`WITH interrompidas AS (UPDATE whatsapp_atendimento_mensagens SET estado=CASE WHEN estado='ENVIANDO' THEN 'INCERTO' ELSE 'FALHOU' END WHERE empresa_id=$1 AND ambiente=$2 AND estado IN ('PROCESSANDO','ENVIANDO') AND iniciada_em < clock_timestamp()-interval '10 minutes' RETURNING conversa_id) UPDATE whatsapp_atendimento_conversas SET estado='AGUARDANDO_HUMANO',versao=versao+1 WHERE id IN(SELECT conversa_id FROM interrompidas) AND estado='IA'`, [empresaPiloto(), ambienteAtendimento()]);
}
