import { randomBytes, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts.ts';
import { withTransaction } from '../db/postgres.ts';
import { consultarSessao, type SessaoAdmin } from '../autenticacao/service.ts';
import { registrarAuditoria } from '../clientes/repositories/auditoria.repository.ts';
import { provarTenant, revalidarTenant, type TenantComprovado } from '../saas/provar-tenant.ts';
import { configuracaoWhatsappPublica, configuracaoWhatsappServidorPronta, exigirConfiguracaoWhatsappPrivada, type AmbienteWhatsapp } from './configuracao.ts';
import { cifrarCredencialWhatsapp } from './credencial.ts';
import { demoAtivosTesteVisivel } from './demo-ativos-teste.ts';
import { WhatsappOnboardingError } from './errors.ts';
import { trocarCodigoEValidarAtivos } from './meta-client.ts';
import { concluirOnboardingSchema, concluirRenovacaoSchema, conferirTentativaSchema, desconectarSchema, divergenciaRenovacao, exigirEsquemaPorEmpresa, exigirGestaoDaEmpresa, exigirReautenticacaoRecente, hashState, stateCorresponde } from './onboarding-core.ts';

export { concluirOnboardingSchema, desconectarSchema, exigirGestaoDaEmpresa, exigirReautenticacaoRecente, stateCorresponde } from './onboarding-core.ts';

/**
 * WhatsApp POR EMPRESA (083): cada empresa conecta o próprio número pelo Embedded Signup da Meta. Toda operação roda
 * na empresa COMPROVADA da sessão (provarTenant: empresa ativa, membership ativa, empresa ATIVA) e exige a Gestão
 * dela; conexão, tentativa, lock e credencial cifrada ficam presos a essa empresa. Uma conexão CONFIGURADA por
 * (ambiente, empresa) e o mesmo número em no máximo uma empresa por ambiente (índices da 083).
 */
export type ContextoWhatsapp = { requestId: string; ip: string | null; userAgent: string | null };
type Transacao = <T>(work: (tx: DbExecutor) => Promise<T>) => Promise<T>;
/** Instante em ISO 8601 UTC (`2027-01-17T03:00:00.000Z`) para a tela: `timestamptz::text` depende do parser do navegador. NULL continua NULL. */
const ISO_UTC = (coluna: string) => `to_char(${coluna} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${coluna}`;
export type DepsWhatsapp = { transacao?: Transacao; validarMeta?: typeof trocarCodigoEValidarAtivos };
type Tentativa = { id: string; ambiente: AmbienteWhatsapp; empresa_id: string | null; usuario_id: string; sessao_referencia_id: string; state_hash: Buffer; status: string; expira_em: string };

const transacaoDe = (deps: DepsWhatsapp): Transacao => deps.transacao ?? withTransaction;

/** Sessão travada + reautenticação recente + empresa comprovada com Gestão. */
async function gestaoTransacional(tx: DbExecutor, token: string, acao: string) {
  const sessao = await consultarSessao(token, tx, true);
  exigirReautenticacaoRecente(sessao);
  const tenant = await provarTenant(tx, sessao, null);
  exigirGestaoDaEmpresa(tenant.papelAtual, acao);
  await exigirEsquemaPorEmpresa(tx);
  return { sessao, tenant };
}
async function lockEmpresa(tx: DbExecutor, ambiente: AmbienteWhatsapp, empresaId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('KIDMAIS_WHATSAPP_' || $1 || ':' || $2, 0))", [ambiente, empresaId]);
}
const auditoriaBase = (contexto: ContextoWhatsapp) => ({ origem: 'WHATSAPP_CONFIGURACAO', requestId: contexto.requestId, ip: contexto.ip, userAgent: contexto.userAgent });

export async function consultarConfiguracaoWhatsapp(sessao: SessaoAdmin, deps: DepsWhatsapp = {}) {
  const publica = configuracaoWhatsappPublica();
  const servidorPronto = configuracaoWhatsappServidorPronta();
  const ambiente = publica.ambiente;
  return transacaoDe(deps)(async (tx) => {
    const tenant = await provarTenant(tx, sessao, null);
    exigirGestaoDaEmpresa(tenant.papelAtual, 'consultar');
    const empresa = (await tx.query<{ nome: string }>('SELECT nome FROM empresas WHERE id=$1::uuid', [tenant.empresaComprovada])).rows[0]?.nome ?? null;
    await exigirEsquemaPorEmpresa(tx);
    const demoAtivosTeste = demoAtivosTesteVisivel(tenant, sessao.usuario_id);
    if (!ambiente) {
      await revalidarTenant(tx, tenant);
      return { estado: 'ACAO_NECESSARIA', metaConfigurada: false, ambiente: null, empresa, conexao: null, tentativa: null, demoAtivosTeste };
    }
    const conexao = (await tx.query<{ id: string; ambiente: string; business_id: string; waba_id: string; phone_number_id: string; numero_exibicao: string; nome_verificado: string; status: string; meta_validada_em: string; token_expira_em: string | null }>(
      `SELECT id,ambiente,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,status,${ISO_UTC('meta_validada_em')},${ISO_UTC('token_expira_em')}
         FROM whatsapp_conexoes WHERE ambiente=$1 AND empresa_id=$2::uuid AND status='CONFIGURADA'`, [ambiente, tenant.empresaComprovada],
    )).rows[0] ?? null;
    const tentativa = (await tx.query<{ id: string; status: string; expira_em: string }>(
      `SELECT id,status,${ISO_UTC('expira_em')} FROM whatsapp_onboarding_tentativas
        WHERE ambiente=$1 AND empresa_id=$2::uuid ORDER BY criada_em DESC LIMIT 1`, [ambiente, tenant.empresaComprovada],
    )).rows[0] ?? null;
    await revalidarTenant(tx, tenant);
    const estado = conexao ? 'CONFIGURADA_SEM_WEBHOOK_OTP'
      : tentativa?.status === 'INICIADA' ? 'AGUARDANDO_META'
        : tentativa?.status === 'VALIDANDO' ? 'VALIDANDO'
          : tentativa?.status === 'EXPIRADA' ? 'TENTATIVA_EXPIRADA'
            : servidorPronto ? 'NAO_CONFIGURADA' : 'ACAO_NECESSARIA';
    return {
      estado, metaConfigurada: servidorPronto, ambiente, empresa,
      conexao: conexao && { id: conexao.id, ambiente: conexao.ambiente, businessId: conexao.business_id, wabaId: conexao.waba_id, phoneNumberId: conexao.phone_number_id, numeroExibicao: conexao.numero_exibicao, nomeVerificado: conexao.nome_verificado, status: conexao.status, metaValidadaEm: conexao.meta_validada_em, tokenExpiraEm: conexao.token_expira_em },
      tentativa,
      demoAtivosTeste,
    };
  });
}

/**
 * Só a empresa COMPROVADA (com lock) tem tentativas vencidas marcadas como EXPIRADA: nenhuma escrita em outra empresa,
 * mesmo da mesma pessoa.
 */
async function expirarTentativasVencidasDaEmpresa(tx: DbExecutor, ambiente: string, empresaId: string) {
  await tx.query(`UPDATE whatsapp_onboarding_tentativas SET status='EXPIRADA',consumida_em=COALESCE(consumida_em,clock_timestamp()),erro_codigo='TENTATIVA_EXPIRADA',atualizada_em=clock_timestamp()
    WHERE ambiente=$1 AND empresa_id=$2::uuid AND status IN ('INICIADA','VALIDANDO') AND expira_em<=clock_timestamp()`, [ambiente, empresaId]);
}
/**
 * Rotina do SISTEMA (não da pessoa nem da empresa comprovada): fecha as tentativas VENCIDAS da própria pessoa da sessão,
 * em qualquer empresa, para que uma tentativa abandonada noutra empresa (até sem Gestão ativa lá) não a bloqueie para
 * sempre pelo índice whatsapp_tentativas_usuario_iniciada_uk. Roda ANTES e FORA da transação do pedido: uma transação
 * por tentativa, com o lock da empresa DELA, UPDATE só se ainda estiver vencida e em andamento (o prazo é imutável pelo
 * trigger da 018) e auditoria com ator SISTEMA. Só lê a sessão (sem lock): a autorização do pedido segue na transação
 * principal. Não há cron no lugar desta rotina porque um cron novo é um serviço novo no Render.
 */
async function expirarTentativasVencidasDaPessoa(transacao: Transacao, token: string, ambiente: AmbienteWhatsapp, contexto: ContextoWhatsapp) {
  const vencidas = await transacao(async (tx) => {
    const sessao = await consultarSessao(token, tx, false);
    // Banco anterior à 083: o mesmo 503 claro dos inícios, nunca erro de SQL desta leitura.
    await exigirEsquemaPorEmpresa(tx);
    return (await tx.query<{ id: string; empresa_id: string | null }>(`SELECT id,empresa_id FROM whatsapp_onboarding_tentativas
      WHERE ambiente=$1 AND usuario_id=$2::uuid AND status IN ('INICIADA','VALIDANDO') AND expira_em<=clock_timestamp() ORDER BY criada_em LIMIT 20`, [ambiente, sessao.usuario_id])).rows;
  });
  for (const vencida of vencidas) {
    await transacao(async (tx) => {
      if (vencida.empresa_id) await lockEmpresa(tx, ambiente, vencida.empresa_id);
      const fechada = (await tx.query<{ status_antes: string }>(`UPDATE whatsapp_onboarding_tentativas t SET status='EXPIRADA',consumida_em=COALESCE(t.consumida_em,clock_timestamp()),erro_codigo='TENTATIVA_EXPIRADA',atualizada_em=clock_timestamp()
        FROM (SELECT id,status AS status_antes FROM whatsapp_onboarding_tentativas WHERE id=$1::uuid FOR UPDATE) a
        WHERE t.id=a.id AND t.status IN ('INICIADA','VALIDANDO') AND t.expira_em<=clock_timestamp() RETURNING a.status_antes`, [vencida.id])).rows[0];
      if (!fechada) return; // outra escrita já fechou ou concluiu
      await registrarAuditoria({ atorTipo: 'SISTEMA', usuarioId: null, acao: 'WHATSAPP_TENTATIVA_EXPIRADA_SISTEMA', entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: vencida.id, dadosAntes: { status: fechada.status_antes }, dadosDepois: { ambiente, empresaId: vencida.empresa_id, status: 'EXPIRADA', erroCodigo: 'TENTATIVA_EXPIRADA' }, ...auditoriaBase(contexto) }, tx);
    });
  }
}
/**
 * Concorrência: uma tentativa em andamento por empresa (lock da empresa) e uma por pessoa em qualquer empresa (índice
 * único whatsapp_tentativas_usuario_iniciada_uk). Só leitura: a da pessoa noutra empresa ainda no prazo dá 409; a vencida
 * já foi fechada pela rotina do sistema. Corrida entre dois pedidos da mesma pessoa em empresas diferentes: o índice
 * recusa o segundo INSERT (23505), traduzido para o mesmo 409 por `tentativaConcorrente`. Antes desta leitura, a
 * preparação nova da MESMA pessoa na MESMA empresa substitui a INICIADA dela (`substituirTentativaPropria`, r7).
 */
async function existeTentativaEmAndamento(tx: DbExecutor, ambiente: string, empresaId: string, usuarioId: string) {
  return Boolean((await tx.query(`SELECT 1 FROM whatsapp_onboarding_tentativas WHERE ambiente=$1 AND status IN ('INICIADA','VALIDANDO')
    AND (empresa_id=$2::uuid OR usuario_id=$3::uuid) LIMIT 1`, [ambiente, empresaId, usuarioId])).rows[0]);
}
/**
 * r7: a preparação nova da MESMA pessoa (senha recente, Gestão comprovada, lock desta empresa) substitui a tentativa
 * INICIADA dela nesta empresa e neste ambiente, que ainda não foi consumida (nenhuma chamada à Meta começou). Cobre a
 * janela da senha (5 min) menor que a da tentativa (10 min): a reautenticação cria outra sessão e a tentativa antiga não
 * serve mais. VALIDANDO (chamada à Meta em curso), tentativa de outra pessoa e a da pessoa noutra empresa seguem no 409.
 */
async function substituirTentativaPropria(tx: DbExecutor, ambiente: AmbienteWhatsapp, empresaId: string, usuarioId: string, contexto: ContextoWhatsapp) {
  const substituidas = (await tx.query<{ id: string }>(`UPDATE whatsapp_onboarding_tentativas SET status='EXPIRADA',consumida_em=clock_timestamp(),erro_codigo='TENTATIVA_SUBSTITUIDA',atualizada_em=clock_timestamp()
    WHERE ambiente=$1 AND empresa_id=$2::uuid AND usuario_id=$3::uuid AND status='INICIADA' RETURNING id`, [ambiente, empresaId, usuarioId])).rows;
  for (const { id } of substituidas) {
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId, acao: 'WHATSAPP_TENTATIVA_SUBSTITUIDA', entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: id, dadosAntes: { status: 'INICIADA' }, dadosDepois: { ambiente, empresaId, status: 'EXPIRADA', erroCodigo: 'TENTATIVA_SUBSTITUIDA' }, ...auditoriaBase(contexto) }, tx);
  }
}
const TENTATIVA_CONCORRENTE = () => new WhatsappOnboardingError('WHATSAPP_TENTATIVA_CONCORRENTE', 'Já existe uma tentativa de conexão em andamento.', 409);
const tentativaConcorrente = (error: unknown) => (error as { code?: string })?.code === '23505' && (error as { constraint?: string }).constraint === 'whatsapp_tentativas_usuario_iniciada_uk' ? TENTATIVA_CONCORRENTE() : error;

export async function iniciarOnboardingWhatsapp(token: string, contexto: ContextoWhatsapp, deps: DepsWhatsapp = {}) {
  const config = exigirConfiguracaoWhatsappPrivada();
  const state = randomBytes(32).toString('base64url');
  await expirarTentativasVencidasDaPessoa(transacaoDe(deps), token, config.ambiente, contexto);
  const result = await transacaoDe(deps)(async (tx) => {
    const { sessao, tenant } = await gestaoTransacional(tx, token, 'conectar');
    const empresaId = tenant.empresaComprovada;
    await lockEmpresa(tx, config.ambiente, empresaId);
    await expirarTentativasVencidasDaEmpresa(tx, config.ambiente, empresaId);
    if ((await tx.query("SELECT 1 FROM whatsapp_conexoes WHERE ambiente=$1 AND empresa_id=$2::uuid AND status='CONFIGURADA' FOR UPDATE", [config.ambiente, empresaId])).rows[0]) {
      throw new WhatsappOnboardingError('WHATSAPP_JA_CONFIGURADO', 'Esta empresa já tem um WhatsApp conectado. Desconecte-o antes de conectar outro número.', 409);
    }
    await substituirTentativaPropria(tx, config.ambiente, empresaId, sessao.usuario_id, contexto);
    if (await existeTentativaEmAndamento(tx, config.ambiente, empresaId, sessao.usuario_id)) {
      throw TENTATIVA_CONCORRENTE();
    }
    const tentativa = (await tx.query<{ id: string; expira_em: string }>(`INSERT INTO whatsapp_onboarding_tentativas(ambiente,empresa_id,usuario_id,sessao_referencia_id,state_hash,expira_em)
      VALUES($1,$2::uuid,$3,$4,$5,clock_timestamp()+interval '10 minutes') RETURNING id,${ISO_UTC('expira_em')}`, [config.ambiente, empresaId, sessao.usuario_id, sessao.id, hashState(state)])).rows[0];
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'WHATSAPP_ONBOARDING_INICIADO', entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: tentativa.id, dadosDepois: { ambiente: config.ambiente, empresaId, status: 'INICIADA', expiraEm: tentativa.expira_em }, ...auditoriaBase(contexto) }, tx);
    await revalidarTenant(tx, tenant);
    return { tentativa };
  }).catch((error: unknown) => { throw tentativaConcorrente(error); });
  return {
    tentativaId: result.tentativa.id, state, expiraEm: result.tentativa.expira_em,
    meta: { appId: config.appId, graphApiVersion: config.graphApiVersion, configurationId: config.configurationId, eventName: config.eventName, launchOptions: config.launchOptions, messageOrigins: config.messageOrigins },
  };
}

/**
 * Inscrição do app na WABA (escrita externa da #168) que pode ter ficado ativa sem conexão local: CONFIRMADA quando a
 * validação inteira passou e a gravação falhou depois; INCERTA quando a resposta da inscrição não comprovou nem sucesso
 * nem recusa (rede, prazo, 5xx, corpo ilegível ou fora do contrato; ver meta-client).
 * Fica na tentativa (`waba_id`) e na auditoria para a recuperação manual (docs); nada é desinscrito automaticamente.
 */
type InscricaoPendente = { inscricaoWebhook: 'CONFIRMADA' | 'INCERTA'; wabaId: string };

async function bloquearTentativa(tx: DbExecutor, tentativaId: string, ambiente: string, empresaId: string) {
  return (await tx.query<Tentativa>(
    'SELECT * FROM whatsapp_onboarding_tentativas WHERE id=$1::uuid AND ambiente=$2 AND empresa_id=$3::uuid FOR UPDATE',
    [tentativaId, ambiente, empresaId],
  )).rows[0];
}

async function marcarFalha(transacao: Transacao, alvo: { tentativaId: string; ambiente: string; empresaId: string; usuarioId: string }, contexto: ContextoWhatsapp, code: string, inscricao?: InscricaoPendente, acao = 'WHATSAPP_ONBOARDING_FALHOU') {
  const { tentativaId, ambiente, empresaId, usuarioId } = alvo;
  await transacao(async (tx) => {
    const tentativa = await bloquearTentativa(tx, tentativaId, ambiente, empresaId);
    if (!tentativa || tentativa.status !== 'VALIDANDO') return;
    await tx.query("UPDATE whatsapp_onboarding_tentativas SET status='FALHOU',erro_codigo=$2,waba_id=COALESCE($3,waba_id),atualizada_em=clock_timestamp() WHERE id=$1", [tentativaId, code, inscricao?.wabaId ?? null]);
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId, acao, entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: tentativaId, dadosDepois: { ambiente: tentativa.ambiente, empresaId: tentativa.empresa_id, status: 'FALHOU', erroCodigo: code, ...(inscricao ?? {}) }, ...auditoriaBase(contexto) }, tx);
  });
}

/** A tentativa é desta pessoa, desta sessão E da empresa comprovada agora (trocar de empresa no meio do fluxo recusa). */
function tentativaDaSessao(tentativa: Tentativa | undefined, sessao: SessaoAdmin, tenant: TenantComprovado) {
  return Boolean(tentativa && tentativa.usuario_id === sessao.usuario_id && tentativa.sessao_referencia_id === sessao.id && tentativa.empresa_id === tenant.empresaComprovada);
}

const NUMERO_EM_USO = () => new WhatsappOnboardingError('WHATSAPP_NUMERO_EM_USO', 'Este número de WhatsApp já está conectado a outra empresa no iA.Fest.', 409);

export async function concluirOnboardingWhatsapp(raw: unknown, token: string, contexto: ContextoWhatsapp, deps: DepsWhatsapp = {}) {
  const input = concluirOnboardingSchema.safeParse(raw);
  if (!input.success) throw new WhatsappOnboardingError('WHATSAPP_DADOS_INVALIDOS', 'Dados de conclusão do onboarding inválidos.', 400);
  const config = exigirConfiguracaoWhatsappPrivada();
  const transacao = transacaoDe(deps);
  const preparada = await transacao(async (tx) => {
    const { sessao, tenant } = await gestaoTransacional(tx, token, 'conectar');
    await lockEmpresa(tx, config.ambiente, tenant.empresaComprovada);
    const tentativa = await bloquearTentativa(tx, input.data.tentativaId, config.ambiente, tenant.empresaComprovada);
    if (!tentativa || !tentativaDaSessao(tentativa, sessao, tenant)) throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_INVALIDA', 'Tentativa de onboarding inválida.', 403);
    // Tentativa de RENOVAÇÃO nunca conecta: recusada antes de consumir a tentativa e antes de qualquer chamada à Meta.
    if (await conexaoMiradaPelaRenovacao(tx, tentativa.id)) throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_INVALIDA', 'Tentativa de onboarding inválida.', 403);
    if (tentativa.status !== 'INICIADA') throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_CONSUMIDA', 'Esta tentativa já foi utilizada.', 409);
    if (new Date(tentativa.expira_em).getTime() <= Date.now()) {
      await tx.query("UPDATE whatsapp_onboarding_tentativas SET status='EXPIRADA',consumida_em=clock_timestamp(),erro_codigo='TENTATIVA_EXPIRADA',atualizada_em=clock_timestamp() WHERE id=$1", [tentativa.id]);
      return { erro: new WhatsappOnboardingError('WHATSAPP_TENTATIVA_EXPIRADA', 'Esta tentativa expirou. Inicie uma nova conexão.', 409) } as const;
    }
    if (!stateCorresponde(input.data.state, tentativa.state_hash)) throw new WhatsappOnboardingError('WHATSAPP_STATE_INVALIDO', 'A confirmação não corresponde à tentativa iniciada.', 403);
    await tx.query("UPDATE whatsapp_onboarding_tentativas SET status='VALIDANDO',consumida_em=clock_timestamp(),atualizada_em=clock_timestamp() WHERE id=$1", [tentativa.id]);
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'WHATSAPP_ONBOARDING_VALIDANDO', entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: tentativa.id, dadosAntes: { status: 'INICIADA' }, dadosDepois: { ambiente: config.ambiente, empresaId: tenant.empresaComprovada, status: 'VALIDANDO' }, ...auditoriaBase(contexto) }, tx);
    await revalidarTenant(tx, tenant);
    return { sessao, empresaId: tenant.empresaComprovada } as const;
  });
  if ('erro' in preparada) throw preparada.erro;
  const alvo = { tentativaId: input.data.tentativaId, ambiente: config.ambiente, empresaId: preparada.empresaId, usuarioId: preparada.sessao.usuario_id };
  let validada: Awaited<ReturnType<typeof trocarCodigoEValidarAtivos>>;
  try {
    validada = await (deps.validarMeta ?? trocarCodigoEValidarAtivos)({
      code: input.data.authorizationCode,
      businessId: input.data.businessId,
      wabaId: input.data.wabaId,
      phoneNumberId: input.data.phoneNumberId,
    }, config);
  } catch (error) {
    const code = error instanceof WhatsappOnboardingError ? error.code : 'META_VALIDACAO_FALHOU';
    const incerta = code === 'META_WEBHOOK_INSCRICAO_INCERTA' ? { inscricaoWebhook: 'INCERTA' as const, wabaId: input.data.wabaId } : undefined;
    await marcarFalha(transacao, alvo, contexto, code, incerta);
    if (error instanceof WhatsappOnboardingError) throw error;
    throw new WhatsappOnboardingError('META_VALIDACAO_FALHOU', 'Não foi possível validar a configuração com a Meta.', 502);
  }
  // Negócio e número COMPROVADOS pela validação (o evento da Meta pode não trazê-los): nunca os do navegador sem prova.
  const { businessId, phoneNumberId } = validada;
  const identidade = { ambiente: config.ambiente, appId: config.appId, businessId, wabaId: input.data.wabaId, phoneNumberId, empresaId: preparada.empresaId };
  let concluida: { id: string };
  try {
    // Dentro do try: falha ao cifrar (chave ausente/inválida) também marca FALHOU e registra a inscrição já feita.
    const credencial = cifrarCredencialWhatsapp(validada.accessToken, identidade);
    concluida = await transacao(async (tx) => {
      const { sessao, tenant } = await gestaoTransacional(tx, token, 'conectar');
      const empresaId = tenant.empresaComprovada;
      await lockEmpresa(tx, config.ambiente, empresaId);
      const tentativa = await bloquearTentativa(tx, input.data.tentativaId, config.ambiente, empresaId);
      if (!tentativa || tentativa.status !== 'VALIDANDO' || !tentativaDaSessao(tentativa, sessao, tenant) || empresaId !== preparada.empresaId) throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_CONSUMIDA', 'Esta tentativa já foi utilizada.', 409);
      if ((await tx.query("SELECT 1 FROM whatsapp_conexoes WHERE ambiente=$1 AND empresa_id=$2::uuid AND status='CONFIGURADA' FOR UPDATE", [config.ambiente, empresaId])).rows[0]) throw new WhatsappOnboardingError('WHATSAPP_TROCA_SILENCIOSA_RECUSADA', 'Já existe uma conexão. Desconecte-a explicitamente antes de conectar outro número.', 409);
      if ((await tx.query("SELECT 1 FROM whatsapp_conexoes WHERE ambiente=$1 AND phone_number_id=$2 AND status='CONFIGURADA'", [config.ambiente, phoneNumberId])).rows[0]) throw NUMERO_EM_USO();
      const conexao = (await tx.query<{ id: string }>(`WITH instante AS (SELECT clock_timestamp() AS agora)
        INSERT INTO whatsapp_conexoes(ambiente,empresa_id,meta_app_id,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,coexistencia_confirmada,status,escopos,credencial_cifrada,credencial_iv,credencial_tag,credencial_chave_versao,token_tipo,token_expira_em,meta_validada_em,criada_por_usuario_id,sessao_referencia_id,criada_em,atualizada_em)
        SELECT $1,$17::uuid,$2,$3,$4,$5,$6,$7,true,'CONFIGURADA',$8,$9,$10,$11,$12,$13,$14,agora,$15,$16,agora,agora FROM instante RETURNING id`,
        [config.ambiente, config.appId, businessId, input.data.wabaId, phoneNumberId, validada.displayPhoneNumber, validada.verifiedName, validada.scopes, credencial.ciphertext, credencial.iv, credencial.tag, credencial.keyVersion, validada.tokenType, validada.expiresAt, sessao.usuario_id, sessao.id, empresaId])).rows[0];
      await tx.query(`UPDATE whatsapp_onboarding_tentativas SET status='CONCLUIDA',business_id=$2,waba_id=$3,phone_number_id=$4,conexao_id=$5,atualizada_em=clock_timestamp() WHERE id=$1`, [tentativa.id, businessId, input.data.wabaId, phoneNumberId, conexao.id]);
      await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'WHATSAPP_CONEXAO_CONFIGURADA', entidadeTipo: 'WHATSAPP_CONEXAO', entidadeId: conexao.id, dadosDepois: { ambiente: config.ambiente, empresaId, businessId, wabaId: input.data.wabaId, phoneNumberId, numeroExibicao: validada.displayPhoneNumber, nomeVerificado: validada.verifiedName, coexistenciaConfirmada: true, inscricaoWebhook: 'CONFIRMADA', webhookAtivo: false, otpAtivo: false }, ...auditoriaBase(contexto) }, tx);
      await revalidarTenant(tx, tenant);
      return conexao;
    });
  } catch (error) {
    // Corrida entre duas empresas com o mesmo número: o índice único da 083 decide; a mensagem é a mesma.
    const normalizado = (error as { code?: string; constraint?: string })?.code === '23505' && (error as { constraint?: string }).constraint === 'whatsapp_conexoes_numero_configurado_uk' ? NUMERO_EM_USO() : error;
    const code = normalizado instanceof WhatsappOnboardingError ? normalizado.code : 'WHATSAPP_PERSISTENCIA_FALHOU';
    // A validação passou inteira, inclusive a inscrição: a WABA ficou inscrita sem conexão local.
    await marcarFalha(transacao, alvo, contexto, code, { inscricaoWebhook: 'CONFIRMADA', wabaId: input.data.wabaId });
    throw normalizado;
  }
  return { conexaoId: concluida.id, estado: 'CONFIGURADA_SEM_WEBHOOK_OTP', numeroExibicao: validada.displayPhoneNumber, nomeVerificado: validada.verifiedName };
}

/** Desconecta o WhatsApp DA EMPRESA comprovada (CONFIGURADA → DESCONECTADA, transição da 018), com motivo e auditoria. */
export async function desconectarWhatsapp(raw: unknown, token: string, contexto: ContextoWhatsapp, deps: DepsWhatsapp = {}) {
  const input = desconectarSchema.safeParse(raw);
  if (!input.success) throw new WhatsappOnboardingError('WHATSAPP_DADOS_INVALIDOS', 'Informe o motivo da desconexão (mínimo de 3 caracteres).', 400);
  const ambiente = configuracaoWhatsappPublica().ambiente;
  if (!ambiente) throw new WhatsappOnboardingError('META_CONFIGURACAO_PENDENTE', 'O ambiente do WhatsApp não está configurado.', 503);
  return transacaoDe(deps)(async (tx) => {
    const { sessao, tenant } = await gestaoTransacional(tx, token, 'desconectar');
    const empresaId = tenant.empresaComprovada;
    await lockEmpresa(tx, ambiente, empresaId);
    const conexao = (await tx.query<{ id: string; status: string; revisao: number; phone_number_id: string; numero_exibicao: string }>(
      'SELECT id,status,revisao,phone_number_id,numero_exibicao FROM whatsapp_conexoes WHERE id=$1::uuid AND ambiente=$2 AND empresa_id=$3::uuid FOR UPDATE',
      [input.data.conexaoId, ambiente, empresaId])).rows[0];
    if (!conexao) throw new WhatsappOnboardingError('WHATSAPP_CONEXAO_NAO_ENCONTRADA', 'Conexão WhatsApp não encontrada nesta empresa.', 404);
    if (conexao.status !== 'CONFIGURADA') throw new WhatsappOnboardingError('WHATSAPP_JA_DESCONECTADO', 'Este WhatsApp já foi desconectado.', 409);
    await tx.query(`UPDATE whatsapp_conexoes SET status='DESCONECTADA',desconectada_em=clock_timestamp(),desconectada_por_usuario_id=$2,motivo_desconexao=$3,
        revisao=revisao+1,atualizada_em=clock_timestamp() WHERE id=$1`, [conexao.id, sessao.usuario_id, input.data.motivo]);
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'WHATSAPP_CONEXAO_DESCONECTADA', entidadeTipo: 'WHATSAPP_CONEXAO', entidadeId: conexao.id, dadosAntes: { status: 'CONFIGURADA', revisao: conexao.revisao }, dadosDepois: { ambiente, empresaId, status: 'DESCONECTADA', phoneNumberId: conexao.phone_number_id, numeroExibicao: conexao.numero_exibicao }, justificativa: input.data.motivo, ...auditoriaBase(contexto) }, tx);
    await revalidarTenant(tx, tenant);
    return { conexaoId: conexao.id, estado: 'DESCONECTADA' as const };
  });
}

/**
 * RENOVAÇÃO DA CREDENCIAL (20/11/2026): o token salvo pelo Embedded Signup pode vencer (60 dias, configuração antiga) e,
 * vencido, nada sai pelo número (`conexaoEnvioMeta`). A Meta não documenta refresh desse token sem `business_management`
 * (recusada na análise do app), então a Gestão repete o Embedded Signup e o servidor troca SÓ a credencial da conexão
 * CONFIGURADA: mesmo app, WABA, negócio e número, conferidos antes da Meta (evento) e depois (comprovados). Status,
 * número e identidade não mudam (o gatilho da 018/083 também os protege); a inscrição do webhook é a mesma chamada
 * idempotente da conexão. A tentativa usa a tabela de sempre, marcada pela auditoria WHATSAPP_RENOVACAO_INICIADA:
 * uma tentativa de conexão não renova, e uma de renovação não conecta (a conclusão normal recusa com conexão existente).
 */
type ConexaoRenovavel = { id: string; meta_app_id: string; business_id: string; waba_id: string; phone_number_id: string; revisao: number; token_tipo: string; token_expira_em: string | null; escopos: string[]; credencial_chave_versao: number };
const SELECT_CONEXAO_RENOVAVEL = `SELECT id,meta_app_id,business_id,waba_id,phone_number_id,revisao,token_tipo,${ISO_UTC('token_expira_em')},escopos,credencial_chave_versao
  FROM whatsapp_conexoes WHERE ambiente=$1 AND empresa_id=$2::uuid AND status='CONFIGURADA' FOR UPDATE`;
const SEM_CONEXAO_PARA_RENOVAR = () => new WhatsappOnboardingError('WHATSAPP_NAO_CONFIGURADO', 'Esta empresa não tem um WhatsApp conectado para renovar.', 409);
const RENOVACAO_DIVERGENTE = () => new WhatsappOnboardingError('WHATSAPP_RENOVACAO_DIVERGENTE', 'A Meta autorizou outra conta ou outro número. Na renovação, escolha o mesmo número já conectado.', 409);

export async function iniciarRenovacaoWhatsapp(token: string, contexto: ContextoWhatsapp, deps: DepsWhatsapp = {}) {
  const config = exigirConfiguracaoWhatsappPrivada();
  const state = randomBytes(32).toString('base64url');
  await expirarTentativasVencidasDaPessoa(transacaoDe(deps), token, config.ambiente, contexto);
  const result = await transacaoDe(deps)(async (tx) => {
    const { sessao, tenant } = await gestaoTransacional(tx, token, 'renovar');
    const empresaId = tenant.empresaComprovada;
    await lockEmpresa(tx, config.ambiente, empresaId);
    await expirarTentativasVencidasDaEmpresa(tx, config.ambiente, empresaId);
    const conexao = (await tx.query<ConexaoRenovavel>(SELECT_CONEXAO_RENOVAVEL, [config.ambiente, empresaId])).rows[0];
    if (!conexao) throw SEM_CONEXAO_PARA_RENOVAR();
    // Outro app no ambiente: a autorização nova seria de outro app e não serviria a esta conexão.
    if (conexao.meta_app_id !== config.appId) throw RENOVACAO_DIVERGENTE();
    await substituirTentativaPropria(tx, config.ambiente, empresaId, sessao.usuario_id, contexto);
    if (await existeTentativaEmAndamento(tx, config.ambiente, empresaId, sessao.usuario_id)) {
      throw TENTATIVA_CONCORRENTE();
    }
    const tentativa = (await tx.query<{ id: string; expira_em: string }>(`INSERT INTO whatsapp_onboarding_tentativas(ambiente,empresa_id,usuario_id,sessao_referencia_id,state_hash,expira_em)
      VALUES($1,$2::uuid,$3,$4,$5,clock_timestamp()+interval '10 minutes') RETURNING id,${ISO_UTC('expira_em')}`, [config.ambiente, empresaId, sessao.usuario_id, sessao.id, hashState(state)])).rows[0];
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'WHATSAPP_RENOVACAO_INICIADA', entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: tentativa.id, dadosDepois: { ambiente: config.ambiente, empresaId, conexaoId: conexao.id, revisao: conexao.revisao, status: 'INICIADA', expiraEm: tentativa.expira_em }, ...auditoriaBase(contexto) }, tx);
    await revalidarTenant(tx, tenant);
    return { tentativa };
  }).catch((error: unknown) => { throw tentativaConcorrente(error); });
  return {
    tentativaId: result.tentativa.id, state, expiraEm: result.tentativa.expira_em,
    meta: { appId: config.appId, graphApiVersion: config.graphApiVersion, configurationId: config.configurationId, eventName: config.eventName, launchOptions: config.launchOptions, messageOrigins: config.messageOrigins },
  };
}

/** A conexão que a tentativa de renovação mirou (gravada na auditoria de início), ou null se a tentativa não é de renovação. */
async function conexaoMiradaPelaRenovacao(tx: DbExecutor, tentativaId: string) {
  const linha = (await tx.query<{ conexao_id: string | null; revisao: number | null }>(
    `SELECT dados_depois->>'conexaoId' AS conexao_id, (dados_depois->>'revisao')::int AS revisao FROM auditoria
      WHERE acao='WHATSAPP_RENOVACAO_INICIADA' AND entidade_tipo='WHATSAPP_ONBOARDING_TENTATIVA' AND entidade_id=$1 ORDER BY criado_em LIMIT 1`, [tentativaId])).rows[0];
  return linha?.conexao_id ? { conexaoId: linha.conexao_id, revisao: linha.revisao } : null;
}

export async function concluirRenovacaoWhatsapp(raw: unknown, token: string, contexto: ContextoWhatsapp, deps: DepsWhatsapp = {}) {
  const input = concluirRenovacaoSchema.safeParse(raw);
  if (!input.success) throw new WhatsappOnboardingError('WHATSAPP_DADOS_INVALIDOS', 'Dados de conclusão da renovação inválidos.', 400);
  const config = exigirConfiguracaoWhatsappPrivada();
  const transacao = transacaoDe(deps);
  const preparada = await transacao(async (tx) => {
    const { sessao, tenant } = await gestaoTransacional(tx, token, 'renovar');
    const empresaId = tenant.empresaComprovada;
    await lockEmpresa(tx, config.ambiente, empresaId);
    const tentativa = await bloquearTentativa(tx, input.data.tentativaId, config.ambiente, empresaId);
    if (!tentativa || !tentativaDaSessao(tentativa, sessao, tenant)) throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_INVALIDA', 'Tentativa de renovação inválida.', 403);
    const mirada = await conexaoMiradaPelaRenovacao(tx, tentativa.id);
    if (!mirada) throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_INVALIDA', 'Tentativa de renovação inválida.', 403);
    if (tentativa.status !== 'INICIADA') throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_CONSUMIDA', 'Esta tentativa já foi utilizada.', 409);
    if (new Date(tentativa.expira_em).getTime() <= Date.now()) {
      await tx.query("UPDATE whatsapp_onboarding_tentativas SET status='EXPIRADA',consumida_em=clock_timestamp(),erro_codigo='TENTATIVA_EXPIRADA',atualizada_em=clock_timestamp() WHERE id=$1", [tentativa.id]);
      return { erro: new WhatsappOnboardingError('WHATSAPP_TENTATIVA_EXPIRADA', 'Esta tentativa expirou. Inicie a renovação de novo.', 409) } as const;
    }
    if (!stateCorresponde(input.data.state, tentativa.state_hash)) throw new WhatsappOnboardingError('WHATSAPP_STATE_INVALIDO', 'A confirmação não corresponde à tentativa iniciada.', 403);
    await tx.query("UPDATE whatsapp_onboarding_tentativas SET status='VALIDANDO',consumida_em=clock_timestamp(),atualizada_em=clock_timestamp() WHERE id=$1", [tentativa.id]);
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'WHATSAPP_RENOVACAO_VALIDANDO', entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: tentativa.id, dadosAntes: { status: 'INICIADA' }, dadosDepois: { ambiente: config.ambiente, empresaId, conexaoId: mirada.conexaoId, status: 'VALIDANDO' }, ...auditoriaBase(contexto) }, tx);
    const conexao = (await tx.query<ConexaoRenovavel>(SELECT_CONEXAO_RENOVAVEL, [config.ambiente, empresaId])).rows[0];
    // A conexão mudou desde o início (desconectada, trocada ou renovada por outra tentativa) ou o evento aponta outra
    // conta: recusa ANTES de chamar a Meta, para nenhuma escrita externa (inscrição) em WABA alheia.
    const codigo = !conexao || conexao.id !== mirada.conexaoId || conexao.revisao !== mirada.revisao ? 'WHATSAPP_RENOVACAO_CONEXAO_ALTERADA'
      : divergenciaRenovacao(conexao, config.appId, input.data) ? 'WHATSAPP_RENOVACAO_DIVERGENTE' : null;
    await revalidarTenant(tx, tenant);
    return { sessao, empresaId, conexao: conexao!, codigo } as const;
  });
  if ('erro' in preparada) throw preparada.erro;
  const alvo = { tentativaId: input.data.tentativaId, ambiente: config.ambiente, empresaId: preparada.empresaId, usuarioId: preparada.sessao.usuario_id };
  const falhou = (code: string) => marcarFalha(transacao, alvo, contexto, code, undefined, 'WHATSAPP_RENOVACAO_FALHOU');
  if (preparada.codigo) {
    await falhou(preparada.codigo);
    throw preparada.codigo === 'WHATSAPP_RENOVACAO_DIVERGENTE' ? RENOVACAO_DIVERGENTE()
      : new WhatsappOnboardingError('WHATSAPP_RENOVACAO_CONEXAO_ALTERADA', 'A conexão do WhatsApp mudou durante a renovação. Atualize a página e tente de novo.', 409);
  }
  const atual = preparada.conexao;
  let validada: Awaited<ReturnType<typeof trocarCodigoEValidarAtivos>>;
  try {
    // Negócio e número CONECTADOS são os pedidos à Meta: sem eles no evento, a validação confere o dono da WABA e procura
    // exatamente esse número ANTES da inscrição do webhook (dono divergente é recusado sem nenhum POST).
    validada = await (deps.validarMeta ?? trocarCodigoEValidarAtivos)({
      code: input.data.authorizationCode, businessId: input.data.businessId ?? atual.business_id, wabaId: input.data.wabaId, phoneNumberId: input.data.phoneNumberId ?? atual.phone_number_id,
    }, config);
  } catch (error) {
    const code = error instanceof WhatsappOnboardingError ? error.code : 'META_VALIDACAO_FALHOU';
    await falhou(code);
    if (error instanceof WhatsappOnboardingError) throw error;
    throw new WhatsappOnboardingError('META_VALIDACAO_FALHOU', 'Não foi possível validar a configuração com a Meta.', 502);
  }
  if (divergenciaRenovacao(atual, config.appId, { wabaId: input.data.wabaId, businessId: validada.businessId, phoneNumberId: validada.phoneNumberId })) {
    await falhou('WHATSAPP_RENOVACAO_DIVERGENTE');
    throw RENOVACAO_DIVERGENTE();
  }
  try {
    const credencial = cifrarCredencialWhatsapp(validada.accessToken, { ambiente: config.ambiente, appId: atual.meta_app_id, businessId: atual.business_id, wabaId: atual.waba_id, phoneNumberId: atual.phone_number_id, empresaId: preparada.empresaId });
    return await transacao(async (tx) => {
      const { sessao, tenant } = await gestaoTransacional(tx, token, 'renovar');
      const empresaId = tenant.empresaComprovada;
      await lockEmpresa(tx, config.ambiente, empresaId);
      const tentativa = await bloquearTentativa(tx, input.data.tentativaId, config.ambiente, empresaId);
      if (!tentativa || tentativa.status !== 'VALIDANDO' || !tentativaDaSessao(tentativa, sessao, tenant) || empresaId !== preparada.empresaId) throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_CONSUMIDA', 'Esta tentativa já foi utilizada.', 409);
      const conexao = (await tx.query<ConexaoRenovavel>(SELECT_CONEXAO_RENOVAVEL, [config.ambiente, empresaId])).rows[0];
      if (!conexao || conexao.id !== atual.id || conexao.revisao !== atual.revisao) throw new WhatsappOnboardingError('WHATSAPP_RENOVACAO_CONEXAO_ALTERADA', 'A conexão do WhatsApp mudou durante a renovação. Atualize a página e tente de novo.', 409);
      // CONTRATO: muda SÓ a credencial (cifrada, iv, tag, versão da chave), o tipo, os escopos e a validade do token, mais
      // meta_validada_em (instante desta validação na Meta), revisao (+1, exigida pelo gatilho) e atualizada_em. Status,
      // número, identidade e todo o resto ficam; o teste PG compara a linha inteira contra essa lista.
      const depois = (await tx.query<{ revisao: number; token_expira_em: string | null; meta_validada_em: string }>(`UPDATE whatsapp_conexoes SET credencial_cifrada=$2,credencial_iv=$3,credencial_tag=$4,credencial_chave_versao=$5,
          token_tipo=$6,escopos=$7,token_expira_em=$8,meta_validada_em=clock_timestamp(),revisao=revisao+1,atualizada_em=clock_timestamp()
        WHERE id=$1 AND status='CONFIGURADA' RETURNING revisao,${ISO_UTC('token_expira_em')},${ISO_UTC('meta_validada_em')}`,
        [conexao.id, credencial.ciphertext, credencial.iv, credencial.tag, credencial.keyVersion, validada.tokenType, validada.scopes, validada.expiresAt])).rows[0];
      await tx.query(`UPDATE whatsapp_onboarding_tentativas SET status='CONCLUIDA',business_id=$2,waba_id=$3,phone_number_id=$4,conexao_id=$5,atualizada_em=clock_timestamp() WHERE id=$1`, [tentativa.id, conexao.business_id, conexao.waba_id, conexao.phone_number_id, conexao.id]);
      await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'WHATSAPP_CREDENCIAL_RENOVADA', entidadeTipo: 'WHATSAPP_CONEXAO', entidadeId: conexao.id,
        dadosAntes: { revisao: conexao.revisao, tokenTipo: conexao.token_tipo, tokenExpiraEm: conexao.token_expira_em, escopos: conexao.escopos, credencialChaveVersao: conexao.credencial_chave_versao },
        dadosDepois: { ambiente: config.ambiente, empresaId, tentativaId: tentativa.id, status: 'CONFIGURADA', phoneNumberId: conexao.phone_number_id, revisao: depois.revisao, tokenTipo: validada.tokenType, tokenExpiraEm: depois.token_expira_em, escopos: validada.scopes, credencialChaveVersao: credencial.keyVersion, inscricaoWebhook: 'CONFIRMADA' },
        ...auditoriaBase(contexto) }, tx);
      await revalidarTenant(tx, tenant);
      return { conexaoId: conexao.id, estado: 'CONFIGURADA_SEM_WEBHOOK_OTP' as const, tokenExpiraEm: depois.token_expira_em };
    });
  } catch (error) {
    const code = error instanceof WhatsappOnboardingError ? error.code : 'WHATSAPP_PERSISTENCIA_FALHOU';
    await falhou(code);
    throw error;
  }
}

/**
 * Conferência de uma conclusão (conexão ou renovação) que terminou sem resposta legível na tela: devolve o status da
 * tentativa pelo id, só na empresa comprovada. Tentativa VENCIDA ainda em andamento (INICIADA ou VALIDANDO depois do
 * prazo, por exemplo quando o processo caiu no meio da validação) é fechada aqui como EXPIRADA, sob o lock da empresa,
 * com auditoria SISTEMA, como na rotina dos inícios: a tela nunca fica presa num status que ninguém mais muda. Com o lock,
 * uma conclusão em curso na mesma empresa termina antes desta leitura. Não exige reautenticação: não toca em credencial,
 * conexão nem tentativa no prazo. Tentativa de outra empresa ou inexistente: `tentativa: null`.
 */
export async function conferirTentativaWhatsapp(raw: unknown, token: string, contexto: ContextoWhatsapp, deps: DepsWhatsapp = {}) {
  const input = conferirTentativaSchema.safeParse(raw);
  if (!input.success) throw new WhatsappOnboardingError('WHATSAPP_DADOS_INVALIDOS', 'Dados da conferência inválidos.', 400);
  const { ambiente } = configuracaoWhatsappPublica();
  if (!ambiente) throw new WhatsappOnboardingError('META_CONFIGURACAO_PENDENTE', 'O ambiente do WhatsApp não está configurado.', 503);
  return transacaoDe(deps)(async (tx) => {
    const sessao = await consultarSessao(token, tx, false);
    const tenant = await provarTenant(tx, sessao, null);
    exigirGestaoDaEmpresa(tenant.papelAtual, 'consultar');
    await exigirEsquemaPorEmpresa(tx);
    const empresaId = tenant.empresaComprovada;
    await lockEmpresa(tx, ambiente, empresaId);
    const fechada = (await tx.query<{ status_antes: string }>(`UPDATE whatsapp_onboarding_tentativas t SET status='EXPIRADA',consumida_em=COALESCE(t.consumida_em,clock_timestamp()),erro_codigo='TENTATIVA_EXPIRADA',atualizada_em=clock_timestamp()
      FROM (SELECT id,status AS status_antes FROM whatsapp_onboarding_tentativas WHERE id=$1::uuid AND ambiente=$2 AND empresa_id=$3::uuid FOR UPDATE) a
      WHERE t.id=a.id AND t.status IN ('INICIADA','VALIDANDO') AND t.expira_em<=clock_timestamp() RETURNING a.status_antes`, [input.data.tentativaId, ambiente, empresaId])).rows[0];
    if (fechada) await registrarAuditoria({ atorTipo: 'SISTEMA', usuarioId: null, acao: 'WHATSAPP_TENTATIVA_EXPIRADA_SISTEMA', entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: input.data.tentativaId, dadosAntes: { status: fechada.status_antes }, dadosDepois: { ambiente, empresaId, status: 'EXPIRADA', erroCodigo: 'TENTATIVA_EXPIRADA' }, ...auditoriaBase(contexto) }, tx);
    const tentativa = (await tx.query<{ id: string; status: string; expira_em: string }>(
      `SELECT id,status,${ISO_UTC('expira_em')} FROM whatsapp_onboarding_tentativas WHERE id=$1::uuid AND ambiente=$2 AND empresa_id=$3::uuid`,
      [input.data.tentativaId, ambiente, empresaId])).rows[0] ?? null;
    await revalidarTenant(tx, tenant);
    return { tentativa };
  });
}

export function contextoWhatsapp(userAgent: string | null): ContextoWhatsapp {
  return { requestId: randomUUID(), ip: null, userAgent: userAgent?.slice(0, 1000) ?? null };
}
