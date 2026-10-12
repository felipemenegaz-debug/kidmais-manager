import { withTransaction, db } from '../../db/postgres.ts';
import type { DbExecutor } from '../../db/contracts.ts';
import { withTenantTransaction, type SessaoParaTenant, type TenantComprovado } from '../../saas/provar-tenant.ts';
import { atendimentoAtivo, ambienteAtendimento, contatoPermitido, empresaPiloto, recepcaoAtiva, receptorDoNumero } from './configuracao.ts';
import { configuracaoSchema, comandoDireto, conferirEmpresaAtiva, passagemSemRespostaAutomatica, pausaPedidaNaRecepcao, semAutomatico, janelaAberta, nomePerfilSeguro, situacaoCadastro, type CadastroContato, type Entrada } from './core.ts';
import { ARQUIVO_DISPONIVEL_SQL, caminhoPublicoArquivo } from './arquivos.ts';
import { registroDaPausa, registroDoBloqueio } from './walle/entendimento.ts';
// O worker usa o mesmo resumo de pausa (sem importar o entendimento do Wall-e).
export { registroDaPausa };

/** `contexto` e `passagem` (082): memória do Wall-e e resumo para a equipe (ausentes sem a 082). */
export type Conversa = { id: string; empresa_id: string; ambiente: string; contato: string; estado: 'IA' | 'HUMANO' | 'AGUARDANDO_HUMANO' | 'ENCERRADA'; responsavel_id: string | null; nao_contatar: boolean; versao: number; ultima_entrada_em: string; atualizada_em?: string; interesse: { data: string | null; convidados: number | null }; contexto?: Record<string, unknown>; passagem?: Record<string, unknown> | null };
export type Mensagem = { id: string; conversa_id: string; empresa_id: string; ambiente: string; origem_id: string | null; autor_usuario_id: string | null; texto: string | null; direcao: string; estado: string; versao_conversa: number; criada_em: string; midia_tipo?: 'IMAGEM' | 'VIDEO' | 'DOCUMENTO' | null; midia_url?: string | null; midia_arquivo_id?: string | null; midia_nome?: string | null; origem_grupo_id?: string | null; ordem?: number; fonte?: Record<string, unknown> | null };
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
/**
 * Fotos e vídeos chegam com a migration 081 (colunas de mídia em mensagens e mensagens prontas). Sem ela o atendimento
 * segue só com texto e a biblioteca oferece mídia como indisponível. Consulta de catálogo a cada uso, sem cache.
 */
export async function temMidia(tx: DbExecutor) {
  const r = await tx.query<{ existe: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.whatsapp_atendimento_mensagens') AND attname='midia_tipo' AND NOT attisdropped)
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.whatsapp_atendimento_mensagens_prontas') AND attname='midia_url' AND NOT attisdropped) AS existe`);
  return !!r.rows[0]?.existe;
}
/**
 * Wall-e (082): arquivos próprios, PDF, estados da biblioteca, várias saídas por entrada, fonte, memória e passagem.
 * Consulta de catálogo a cada uso, sem cache (aplicar ou reverter a 082 não exige reiniciar a aplicação).
 */
/** Controles de privacidade da 082 (12/10): controles mínimos, eventos excluídos, retenção. */
export async function temControlesPrivacidade(tx: DbExecutor) {
  return (await tx.query<{ e: boolean }>("SELECT to_regclass('public.whatsapp_atendimento_controles_contato') IS NOT NULL AS e")).rows[0]?.e === true;
}
export async function tem082(tx: DbExecutor) {
  const r = await tx.query<{ existe: boolean }>(`SELECT to_regclass('public.whatsapp_atendimento_arquivos') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.whatsapp_atendimento_mensagens') AND attname='origem_grupo_id' AND NOT attisdropped) AS existe`);
  return !!r.rows[0]?.existe;
}
export type MidiaDaPronta = { tipo: 'IMAGEM' | 'VIDEO' | 'DOCUMENTO'; midia_url: string | null; arquivo_id: string | null; nome: string | null; versao: number };
/**
 * Anexo de uma mensagem pronta DESTA empresa e ambiente, na VERSÃO vista na prévia: a única origem de mídia no envio
 * (URL externa da 081 ou arquivo próprio da 082). Pronta alterada, arquivada ou de volta a rascunho depois da prévia:
 * recusa (nada é gravado nem enviado; a pessoa revisa de novo) — o anexo nunca é trocado em silêncio. FOR SHARE: uma
 * alteração em andamento termina antes desta leitura (e é vista); a leitura e a cópia para a mensagem são da mesma versão.
 */
export async function midiaDaPronta(tx: DbExecutor, empresa: string, ambiente: string, prontaId: string, versao: number): Promise<MidiaDaPronta> {
  if (!(await temMidia(tx))) throw new Error('ATENDIMENTO_MIDIA_INDISPONIVEL');
  const r082 = await tem082(tx);
  const r = (await tx.query<{ tipo: string; midia_url: string | null; versao: string; ativa: boolean; estado: string; arquivo_id: string | null; arquivo_nome: string | null }>(r082
    ? `SELECT p.tipo,p.midia_url,p.versao,p.ativa,p.estado,p.arquivo_id,a.nome AS arquivo_nome FROM whatsapp_atendimento_mensagens_prontas p
       LEFT JOIN whatsapp_atendimento_arquivos a ON a.id=p.arquivo_id AND a.empresa_id=p.empresa_id AND a.ambiente=p.ambiente
       WHERE p.id=$1 AND p.empresa_id=$2 AND p.ambiente=$3 FOR SHARE OF p`
    : `SELECT tipo,midia_url,versao,ativa,NULL::text AS estado,NULL::uuid AS arquivo_id,NULL::text AS arquivo_nome FROM whatsapp_atendimento_mensagens_prontas WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 FOR SHARE`, [prontaId, empresa, ambiente])).rows[0];
  if (!r) throw new Error('ATENDIMENTO_PRONTA_NAO_ENCONTRADA');
  if (Number(r.versao) !== versao || !r.ativa || (r082 && r.estado !== 'PUBLICADA')) throw new Error('ATENDIMENTO_PRONTA_MIDIA_ALTERADA');
  if (!['IMAGEM', 'VIDEO', 'DOCUMENTO'].includes(r.tipo) || (!r.midia_url && !r.arquivo_id)) throw new Error('ATENDIMENTO_PRONTA_NAO_ENCONTRADA');
  // M3 (12/10): arquivo revogado, vencido ou de empresa inativa não entra na fila (o operador vê o motivo na hora).
  if (r.arquivo_id && !(await tx.query(`SELECT 1 FROM whatsapp_atendimento_arquivos a WHERE a.id=$1 AND a.empresa_id=$2 AND a.ambiente=$3 AND ${ARQUIVO_DISPONIVEL_SQL}`, [r.arquivo_id, empresa, ambiente])).rows.length) throw new Error('ATENDIMENTO_ARQUIVO_INDISPONIVEL');
  return { tipo: r.tipo as MidiaDaPronta['tipo'], midia_url: r.midia_url, arquivo_id: r.arquivo_id, nome: r.arquivo_nome, versao };
}
export const LIMITE_LEGENDA_ENVIO = 1024;
/** `midia_nome` e `midia_caminho` (082): nome do arquivo próprio e o caminho público para conferir na tela. */
export type MensagemLista = Pick<Mensagem, 'id' | 'conversa_id' | 'direcao' | 'texto' | 'estado' | 'criada_em'> & { humana: boolean; midia_tipo: 'IMAGEM' | 'VIDEO' | 'DOCUMENTO' | null; midia_url: string | null; midia_nome?: string | null; midia_caminho?: string | null; ordem?: number; motivo_cancelamento?: 'ARQUIVO_INDISPONIVEL' | 'ARQUIVO_REVOGADO' | null };
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
/**
 * `automacaoGlobal`: estado da chave GLOBAL da IA, decidido na composition root da IA (app/api/admin/inteligencia/whatsapp/
 * automacao.ts) e entregue pelo webhook — o Core não lê a chave. Desligada: a entrada nasce PROCESSADA e a conversa vai
 * para a equipe com o motivo SEM_RESPOSTA_AUTOMATICA; ela nunca fica PENDENTE, então religar a IA não a responde depois,
 * mesmo sem nenhum ciclo do worker no meio. O padrão (ligada) vale só para chamadas internas e suítes; o webhook sempre
 * informa (teste estático).
 */
export async function receberEntrada(entrada: Entrada, opcoes: { automacaoGlobal?: boolean } = {}) {
  const automacaoGlobal = opcoes.automacaoGlobal ?? true;
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
    // M1 (12/10): reentrega (ou replay) de um evento cuja mensagem foi EXCLUÍDA: confirma sem gravar nada (o hash do id do
    // evento fica em whatsapp_atendimento_eventos_excluidos por um prazo técnico; nenhum texto ou nome é guardado de novo).
    const privacidade082 = await temControlesPrivacidade(tx);
    if (privacidade082 && (await tx.query("SELECT 1 FROM whatsapp_atendimento_eventos_excluidos WHERE empresa_id=$1 AND ambiente=$2 AND provedor='GUPSHUP' AND evento_sha256=encode(sha256(convert_to($3,'UTF8')),'hex')", [empresa, ambiente, entrada.id])).rows.length) return;
    let conversa = (await tx.query<Conversa & { criada: boolean }>(`INSERT INTO whatsapp_atendimento_conversas(empresa_id,ambiente,contato,ultima_entrada_em) VALUES($1,$2,$3,$4)
      ON CONFLICT(empresa_id,ambiente,contato) DO UPDATE SET ultima_entrada_em=GREATEST(whatsapp_atendimento_conversas.ultima_entrada_em,EXCLUDED.ultima_entrada_em),versao=whatsapp_atendimento_conversas.versao+1,atualizada_em=clock_timestamp()
      RETURNING *,(xmax = 0) AS criada`, [empresa, ambiente, entrada.source, em])).rows[0];
    // A2 (12/10): conversa NOVA de um número cuja conversa anterior foi excluída herda os controles mínimos (PARAR, pausa,
    // equipe) e a linha de controle é consumida. Nunca volta sozinha ao bot: PARAR encerra e bloqueia; pausa grava a marca
    // persistente (origem EXCLUSAO); equipe deixa a conversa aguardando a equipe.
    if (conversa.criada && privacidade082) {
      const c = (await tx.query<{ nao_contatar: boolean; sem_automatico: boolean; com_equipe: boolean }>('DELETE FROM whatsapp_atendimento_controles_contato WHERE empresa_id=$1 AND ambiente=$2 AND contato=$3 RETURNING nao_contatar,sem_automatico,com_equipe', [empresa, ambiente, entrada.source])).rows[0];
      if (c) conversa = (await tx.query<Conversa & { criada: boolean }>(`UPDATE whatsapp_atendimento_conversas SET nao_contatar=$2,
          estado=CASE WHEN $2 THEN 'ENCERRADA' WHEN $3 OR $4 THEN 'AGUARDANDO_HUMANO' ELSE estado END,
          contexto=CASE WHEN $3 THEN COALESCE(contexto,'{}'::jsonb)||jsonb_build_object('semAutomatico',$5::jsonb) ELSE contexto END
        WHERE id=$1 RETURNING *,true AS criada`, [conversa.id, c.nao_contatar, c.sem_automatico, c.com_equipe, JSON.stringify({ motivo: 'PARAR_A_CONFIRMAR', em, origem: 'EXCLUSAO' })])).rows[0];
    }
    // Nome de perfil (não verificado): o mais recente vence; replay antigo não sobrescreve. Não muda versão nem estado.
    const nomePerfil = nomePerfilSeguro(entrada.nomePerfil);
    if (nomePerfil && await temNomePerfil(tx)) {
      await tx.query('UPDATE whatsapp_atendimento_conversas SET nome_perfil=$2,nome_perfil_em=$3 WHERE id=$1 AND (nome_perfil_em IS NULL OR nome_perfil_em<$3)', [conversa.id, nomePerfil, em]);
    }
    // Encerrada pela equipe (sem pedido de PARAR): nova mensagem do cliente reabre como um contato novo.
    const reaberta = conversa.estado === 'ENCERRADA' && !conversa.nao_contatar;
    const estadoAtual = reaberta ? 'IA' : conversa.estado;
    // Correção da pausa (revisão da candidata final): pedido de PAUSA reconhecido pelas regras (opt-out ambíguo) nunca
    // entra na fila automática — o limite diário, a fase B, a falha do Wall-e e o encaminhamento fixo não chegam a vê-lo.
    // A conversa vai para a equipe já com o resumo de pausa e a marca persistente (abaixo). PARAR inequívoco não é pausa.
    const pausa = !!entrada.texto && !conversa.nao_contatar && pausaPedidaNaRecepcao(entrada.texto);
    const automatico = automacaoGlobal && atendimentoAtivo() && !!config?.ativo && !conversa.nao_contatar && !semAutomatico(conversa) && estadoAtual === 'IA' && entrada.texto !== null && !pausa;
    await tx.query(`INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,externa_id,direcao,texto,estado,versao_conversa,criada_em) VALUES($1,$2,$3,$4,'ENTRADA',$5,$6,$7,$8)`, [conversa.id, empresa, ambiente, entrada.id, entrada.texto, automatico ? 'PENDENTE' : 'PROCESSADA', conversa.versao, em]);
    if (reaberta) await tx.query('UPDATE whatsapp_atendimento_conversas SET estado=$2,responsavel_id=NULL WHERE id=$1', [conversa.id, automatico ? 'IA' : 'AGUARDANDO_HUMANO']);
    else if (estadoAtual === 'IA' && !automatico) await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='AGUARDANDO_HUMANO' WHERE id=$1", [conversa.id]);
    const parar = !!entrada.texto && comandoDireto(entrada.texto)?.intencao === 'PARAR';
    // Proteção final: com a automação global desligada, a equipe vê POR QUE a mensagem ficou sem resposta automática (o
    // mesmo resumo do processador). PARAR tem o próprio registro abaixo; a marca de pausa também é gravada abaixo.
    if (!automacaoGlobal && estadoAtual === 'IA' && !conversa.nao_contatar && !parar && await tem082(tx)) {
      const pausa = !semAutomatico(conversa) && pausaPedidaNaRecepcao(entrada.texto);
      await tx.query('UPDATE whatsapp_atendimento_conversas SET passagem=$2::jsonb WHERE id=$1', [conversa.id, JSON.stringify(passagemSemRespostaAutomatica(conversa.contexto, em, pausa))]);
    }
    if (parar && entrada.texto) {
      // Rodada 18: com reclamação junto ("não quero mais propaganda… a festa foi péssima"), o mesmo bloqueio, e a reclamação
      // fica na fila da equipe (AGUARDANDO_HUMANO + passagem, só com a 082), sem reabrir o contato.
      const registro = (await tem082(tx)) ? registroDoBloqueio(entrada.texto, em) : null;
      if (registro) await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='AGUARDANDO_HUMANO',nao_contatar=true,passagem=$2::jsonb,versao=versao+1 WHERE id=$1", [conversa.id, JSON.stringify(registro)]);
      else await tx.query("UPDATE whatsapp_atendimento_conversas SET estado='ENCERRADA',nao_contatar=true,versao=versao+1 WHERE id=$1", [conversa.id]);
      // Saídas ainda na fila não saem mais. SKIP LOCKED (como no encerramento): a que o worker segura neste instante é
      // cancelada por ele mesmo ao revalidar sob a trava da conversa (nao_contatar).
      await tx.query(`UPDATE whatsapp_atendimento_mensagens SET estado='CANCELADA' WHERE id IN (SELECT id FROM whatsapp_atendimento_mensagens
        WHERE conversa_id=$1 AND empresa_id=$2 AND ambiente=$3 AND direcao='SAIDA' AND estado='PENDENTE' FOR UPDATE SKIP LOCKED)`, [conversa.id, empresa, ambiente]);
    }
    // Rodada 47 (IA × h45 aa73, h46 aa61): pedido de PAUSA (ou de parar junto de outro pedido) numa mensagem que o Wall-e
    // não processa — a conversa já está com a equipe, assumida, sem automação: grava a MESMA marca persistente que o worker
    // grava quando o Wall-e passa o pedido em silêncio (contexto.semAutomatico, PARAR_A_CONFIRMAR). Sem bloqueio definitivo
    // (a equipe continua respondendo); com a marca, "Devolver ao Wall-e" é recusado e nada automático sai depois, nem
    // numa reabertura. PARAR inequívoco continua sendo o bloqueio acima. Só com a 082 (a marca vive no contexto).
    else if (entrada.texto && !automatico && !conversa.nao_contatar && !semAutomatico(conversa) && pausaPedidaNaRecepcao(entrada.texto) && await tem082(tx)) {
      // Conversa que saiu da IA por causa deste pedido: o resumo para a equipe é o da pausa (o mesmo do resolvedor). Com a
      // automação global desligada o resumo já foi gravado acima (inclui a pausa); conversa já com a equipe: só a marca.
      const resumo = estadoAtual === 'IA' && automacaoGlobal ? JSON.stringify(registroDaPausa(entrada.texto, em, conversa.contexto)) : null;
      await tx.query("UPDATE whatsapp_atendimento_conversas SET contexto=COALESCE(contexto,'{}'::jsonb)||jsonb_build_object('semAutomatico',$2::jsonb),passagem=COALESCE($3::jsonb,passagem),versao=versao+1 WHERE id=$1",
        [conversa.id, JSON.stringify({ motivo: 'PARAR_A_CONFIRMAR', em, origem: 'RECEPCAO' }), resumo]);
    }
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
 * Sem escolha explícita, como no painel: uma única empresa ativa vale como a atual; mais de uma = seleção pendente.
 */
const EMPRESAS_ATIVAS_DO_USUARIO = `SELECT count(*) AS n FROM memberships m JOIN empresas e ON e.id = m.empresa_id
  WHERE m.usuario_id = $1::uuid AND m.status = 'ATIVA' AND e.status = 'ATIVA'`;
async function naEmpresaDoAtendimento<T>(sessao: SessaoParaTenant, work: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>) {
  const piloto = empresaPiloto();
  const situacao = conferirEmpresaAtiva(sessao, piloto);
  try {
    return await withTenantTransaction(sessao, piloto, async (tx, tenant) => {
      if (situacao === 'SEM_ESCOLHA') {
        const ativas = Number((await tx.query<{ n: string }>(EMPRESAS_ATIVAS_DO_USUARIO, [sessao.usuario_id])).rows[0]?.n ?? 0);
        if (ativas !== 1) throw new Error('ATENDIMENTO_EMPRESA_NAO_SELECIONADA');
      }
      return work(tx, tenant);
    });
  }
  catch (erro) {
    if ((erro as { code?: unknown })?.code !== 'TENANT_NAO_COMPROVADO') throw erro;
    // Com a 063 e sem escolha explícita, o provarTenant do painel já recusa quem tem mais de uma empresa ativa: isso é
    // seleção pendente (a tela orienta a escolher), não falta de acesso. Só a contagem de vínculos é lida.
    if (situacao === 'SEM_ESCOLHA') {
      const ativas = Number((await db().query<{ n: string }>(EMPRESAS_ATIVAS_DO_USUARIO, [sessao.usuario_id])).rows[0]?.n ?? 0);
      if (ativas > 1) throw new Error('ATENDIMENTO_EMPRESA_NAO_SELECIONADA');
    }
    throw new Error('ATENDIMENTO_SEM_ACESSO');
  }
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
    const midia = await temMidia(tx), r082 = await tem082(tx);
    // Com a 082: nome do arquivo próprio e o caminho público (token) para conferir; várias saídas da mesma entrada na ordem.
    const colunasMidia = r082 ? `m.midia_tipo,m.midia_url,m.midia_nome,m.ordem,a.id AS arquivo_id,a.token AS arquivo_token${(await temControlesPrivacidade(tx)) ? ',m.motivo_cancelamento' : ''}`
      : midia ? 'm.midia_tipo,m.midia_url' : 'NULL::text AS midia_tipo,NULL::text AS midia_url';
    // D3: arquivo revogado/vencido não tem mais caminho (o registro da mensagem fica, sem o link).
    const juntaArquivo = r082 ? ` LEFT JOIN whatsapp_atendimento_arquivos a ON a.id=m.midia_arquivo_id AND a.empresa_id=m.empresa_id AND a.ambiente=m.ambiente AND ${ARQUIVO_DISPONIVEL_SQL}` : '';
    type LinhaMensagem = MensagemLista & { arquivo_id?: string | null; arquivo_token?: string | null };
    const mensagens = conversaId ? (await tx.query<LinhaMensagem>(`SELECT m.id,m.conversa_id,m.direcao,m.texto,m.estado,m.criada_em,m.autor_usuario_id IS NOT NULL AS humana,${colunasMidia} FROM whatsapp_atendimento_mensagens m${juntaArquivo}
      WHERE m.empresa_id=$1 AND m.ambiente=$2 AND m.conversa_id=$3 ORDER BY m.criada_em DESC,${r082 ? 'm.ordem DESC,' : ''}m.id DESC LIMIT 100`, [empresa, ambiente, conversaId])).rows.reverse()
      .map(({ arquivo_id, arquivo_token, ...m }): MensagemLista => (r082 ? { ...m, midia_caminho: arquivo_id && arquivo_token && m.midia_nome ? caminhoPublicoArquivo(arquivo_id, arquivo_token, m.midia_nome) : null } : m)) : [];
    const canal: EstadoCanal = { ambiente, receptor: receptorDoNumero(), recepcao: recepcaoAtiva(), envio: atendimentoAtivo() };
    const lista: ConversaLista[] = conversas.map(({ clientes, cliente_nome, ...c }) => ({ ...c, versao: Number(c.versao), cadastro: situacaoCadastro(Number(clientes ?? 0), cliente_nome) }));
    return { conversas: lista, mensagens, usuarioId: sessao.usuario_id, configuracao: await configuracao(tx, empresa), automacaoDisponivel: atendimentoAtivo(), canal, podeConfigurar: papel === 'REPRESENTANTE_AUTORIZADO' };
  });
}
/**
 * `prontaMidiaId` + `prontaVersao` (só em "enviar"): foto/vídeo de uma mensagem pronta da empresa, na versão vista na
 * prévia. A URL é lida do banco aqui; a tela manda só o id, a versão e a legenda (texto, opcional, até 1024). A saída
 * guarda a origem (pronta e versão). Janela de 24 h, PARAR, responsável e chaves valem igual.
 */
export async function controlarAtendimento(sessao: SessaoParaTenant, pedido: { acao: 'assumir' | 'retomar' | 'encerrar' | 'enviar'; conversaId: string; texto?: string; versao: number; prontaMidiaId?: string; prontaVersao?: number }) {
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
      if ((!pedido.texto && !pedido.prontaMidiaId) || conversa.estado !== 'HUMANO' || conversa.responsavel_id !== sessao.usuario_id) throw new Error('ATENDIMENTO_ASSUMA_ANTES_DE_ENVIAR');
      if (!janelaAberta(new Date(conversa.ultima_entrada_em), new Date())) throw new Error('ATENDIMENTO_JANELA_EXPIRADA');
      if (pedido.prontaMidiaId) {
        // Sem a versão revisada não há como provar que a mídia é a da prévia: recusa como alterada (revisar de novo).
        if (pedido.prontaVersao === undefined) throw new Error('ATENDIMENTO_PRONTA_MIDIA_ALTERADA');
        if (pedido.texto && pedido.texto.length > LIMITE_LEGENDA_ENVIO) throw new Error('ATENDIMENTO_LEGENDA_LONGA');
        const midia = await midiaDaPronta(tx, empresa, ambiente, pedido.prontaMidiaId, pedido.prontaVersao);
        if (midia.arquivo_id) await tx.query(`INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,direcao,texto,estado,versao_conversa,autor_usuario_id,midia_tipo,midia_arquivo_id,midia_nome,midia_pronta_id,midia_pronta_versao,fonte) VALUES($1,$2,$3,'SAIDA',$4,'PENDENTE',$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
          [conversa.id, empresa, ambiente, pedido.texto || null, Number(conversa.versao) + 1, sessao.usuario_id, midia.tipo, midia.arquivo_id, midia.nome, pedido.prontaMidiaId, midia.versao, JSON.stringify({ tipo: 'PRONTA', id: pedido.prontaMidiaId, versao: midia.versao, por: 'ATENDENTE' })]);
        else await tx.query(`INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,direcao,texto,estado,versao_conversa,autor_usuario_id,midia_tipo,midia_url,midia_pronta_id,midia_pronta_versao) VALUES($1,$2,$3,'SAIDA',$4,'PENDENTE',$5,$6,$7,$8,$9,$10)`, [conversa.id, empresa, ambiente, pedido.texto || null, Number(conversa.versao) + 1, sessao.usuario_id, midia.tipo, midia.midia_url, pedido.prontaMidiaId, midia.versao]);
      } else await tx.query(`INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,direcao,texto,estado,versao_conversa,autor_usuario_id) VALUES($1,$2,$3,'SAIDA',$4,'PENDENTE',$5,$6)`, [conversa.id, empresa, ambiente, pedido.texto, Number(conversa.versao) + 1,sessao.usuario_id]);
    }
    const estado = pedido.acao === 'retomar' ? 'IA' : pedido.acao === 'encerrar' ? 'ENCERRADA' : 'HUMANO';
    if (pedido.acao === 'retomar' && (!atendimentoAtivo() || !(await configuracao(tx, empresa))?.ativo)) throw new Error('ATENDIMENTO_AUTOMACAO_DESLIGADA');
    // Rodada 22: o cliente pediu para parar (sem bloqueio definitivo): só a equipe responde, o Wall-e não volta.
    if (pedido.acao === 'retomar' && semAutomatico(conversa)) throw new Error('ATENDIMENTO_PAUSA_PEDIDA');
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
