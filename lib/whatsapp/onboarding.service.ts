import { randomBytes, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts.ts';
import { withTransaction } from '../db/postgres.ts';
import { consultarSessao, type SessaoAdmin } from '../autenticacao/service.ts';
import { registrarAuditoria } from '../clientes/repositories/auditoria.repository.ts';
import { provarTenant, revalidarTenant, type TenantComprovado } from '../saas/provar-tenant.ts';
import { configuracaoWhatsappPublica, configuracaoWhatsappServidorPronta, exigirConfiguracaoWhatsappPrivada, type AmbienteWhatsapp } from './configuracao.ts';
import { cifrarCredencialWhatsapp } from './credencial.ts';
import { WhatsappOnboardingError } from './errors.ts';
import { trocarCodigoEValidarAtivos } from './meta-client.ts';
import { concluirOnboardingSchema, desconectarSchema, exigirEsquemaPorEmpresa, exigirGestaoDaEmpresa, exigirReautenticacaoRecente, hashState, stateCorresponde } from './onboarding-core.ts';

export { concluirOnboardingSchema, desconectarSchema, exigirGestaoDaEmpresa, exigirReautenticacaoRecente, stateCorresponde } from './onboarding-core.ts';

/**
 * WhatsApp POR EMPRESA (083): cada empresa conecta o próprio número pelo Embedded Signup da Meta. Toda operação roda
 * na empresa COMPROVADA da sessão (provarTenant: empresa ativa, membership ativa, empresa ATIVA) e exige a Gestão
 * dela; conexão, tentativa, lock e credencial cifrada ficam presos a essa empresa. Uma conexão CONFIGURADA por
 * (ambiente, empresa) e o mesmo número em no máximo uma empresa por ambiente (índices da 083).
 */
export type ContextoWhatsapp = { requestId: string; ip: string | null; userAgent: string | null };
type Transacao = <T>(work: (tx: DbExecutor) => Promise<T>) => Promise<T>;
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
    if (!ambiente) {
      await revalidarTenant(tx, tenant);
      return { estado: 'ACAO_NECESSARIA', metaConfigurada: false, ambiente: null, empresa, conexao: null, tentativa: null };
    }
    const conexao = (await tx.query<{ id: string; ambiente: string; business_id: string; waba_id: string; phone_number_id: string; numero_exibicao: string; nome_verificado: string; status: string; meta_validada_em: string }>(
      `SELECT id,ambiente,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,status,meta_validada_em::text
         FROM whatsapp_conexoes WHERE ambiente=$1 AND empresa_id=$2::uuid AND status='CONFIGURADA'`, [ambiente, tenant.empresaComprovada],
    )).rows[0] ?? null;
    const tentativa = (await tx.query<{ id: string; status: string; expira_em: string }>(
      `SELECT id,status,expira_em::text FROM whatsapp_onboarding_tentativas
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
      conexao: conexao && { id: conexao.id, ambiente: conexao.ambiente, businessId: conexao.business_id, wabaId: conexao.waba_id, phoneNumberId: conexao.phone_number_id, numeroExibicao: conexao.numero_exibicao, nomeVerificado: conexao.nome_verificado, status: conexao.status, metaValidadaEm: conexao.meta_validada_em },
      tentativa,
    };
  });
}

export async function iniciarOnboardingWhatsapp(token: string, contexto: ContextoWhatsapp, deps: DepsWhatsapp = {}) {
  const config = exigirConfiguracaoWhatsappPrivada();
  const state = randomBytes(32).toString('base64url');
  const result = await transacaoDe(deps)(async (tx) => {
    const { sessao, tenant } = await gestaoTransacional(tx, token, 'conectar');
    const empresaId = tenant.empresaComprovada;
    await lockEmpresa(tx, config.ambiente, empresaId);
    // Expira as tentativas vencidas desta empresa e as desta pessoa (uma em andamento por pessoa, em qualquer empresa).
    await tx.query(`UPDATE whatsapp_onboarding_tentativas SET status='EXPIRADA',consumida_em=COALESCE(consumida_em,clock_timestamp()),erro_codigo='TENTATIVA_EXPIRADA',atualizada_em=clock_timestamp()
      WHERE ambiente=$1 AND (empresa_id=$2::uuid OR usuario_id=$3::uuid) AND status IN ('INICIADA','VALIDANDO') AND expira_em<=clock_timestamp()`, [config.ambiente, empresaId, sessao.usuario_id]);
    if ((await tx.query("SELECT 1 FROM whatsapp_conexoes WHERE ambiente=$1 AND empresa_id=$2::uuid AND status='CONFIGURADA' FOR UPDATE", [config.ambiente, empresaId])).rows[0]) {
      throw new WhatsappOnboardingError('WHATSAPP_JA_CONFIGURADO', 'Esta empresa já tem um WhatsApp conectado. Desconecte-o antes de conectar outro número.', 409);
    }
    if ((await tx.query("SELECT 1 FROM whatsapp_onboarding_tentativas WHERE ambiente=$1 AND (empresa_id=$2::uuid OR usuario_id=$3::uuid) AND status IN ('INICIADA','VALIDANDO') FOR UPDATE", [config.ambiente, empresaId, sessao.usuario_id])).rows[0]) {
      throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_CONCORRENTE', 'Já existe uma tentativa de conexão em andamento.', 409);
    }
    const tentativa = (await tx.query<{ id: string; expira_em: string }>(`INSERT INTO whatsapp_onboarding_tentativas(ambiente,empresa_id,usuario_id,sessao_referencia_id,state_hash,expira_em)
      VALUES($1,$2::uuid,$3,$4,$5,clock_timestamp()+interval '10 minutes') RETURNING id,expira_em::text`, [config.ambiente, empresaId, sessao.usuario_id, sessao.id, hashState(state)])).rows[0];
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'WHATSAPP_ONBOARDING_INICIADO', entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: tentativa.id, dadosDepois: { ambiente: config.ambiente, empresaId, status: 'INICIADA', expiraEm: tentativa.expira_em }, ...auditoriaBase(contexto) }, tx);
    await revalidarTenant(tx, tenant);
    return { tentativa };
  });
  return {
    tentativaId: result.tentativa.id, state, expiraEm: result.tentativa.expira_em,
    meta: { appId: config.appId, graphApiVersion: config.graphApiVersion, configurationId: config.configurationId, eventName: config.eventName, launchOptions: config.launchOptions, messageOrigins: config.messageOrigins },
  };
}

async function marcarFalha(transacao: Transacao, tentativaId: string, usuarioId: string, contexto: ContextoWhatsapp, code: string) {
  await transacao(async (tx) => {
    const tentativa = (await tx.query<Tentativa>('SELECT * FROM whatsapp_onboarding_tentativas WHERE id=$1 FOR UPDATE', [tentativaId])).rows[0];
    if (!tentativa || tentativa.status !== 'VALIDANDO') return;
    await tx.query("UPDATE whatsapp_onboarding_tentativas SET status='FALHOU',erro_codigo=$2,atualizada_em=clock_timestamp() WHERE id=$1", [tentativaId, code]);
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId, acao: 'WHATSAPP_ONBOARDING_FALHOU', entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: tentativaId, dadosDepois: { ambiente: tentativa.ambiente, empresaId: tentativa.empresa_id, status: 'FALHOU', erroCodigo: code }, ...auditoriaBase(contexto) }, tx);
  });
}

/** A tentativa é desta pessoa, desta sessão E da empresa comprovada agora (trocar de empresa no meio do fluxo recusa). */
function tentativaDaSessao(tentativa: Tentativa | undefined, sessao: SessaoAdmin, tenant: TenantComprovado) {
  return Boolean(tentativa && tentativa.usuario_id === sessao.usuario_id && tentativa.sessao_referencia_id === sessao.id && tentativa.empresa_id === tenant.empresaComprovada);
}

const NUMERO_EM_USO = () => new WhatsappOnboardingError('WHATSAPP_NUMERO_EM_USO', 'Este número de WhatsApp já está conectado a outra empresa no Kidmais.', 409);

export async function concluirOnboardingWhatsapp(raw: unknown, token: string, contexto: ContextoWhatsapp, deps: DepsWhatsapp = {}) {
  const input = concluirOnboardingSchema.safeParse(raw);
  if (!input.success) throw new WhatsappOnboardingError('WHATSAPP_DADOS_INVALIDOS', 'Dados de conclusão do onboarding inválidos.', 400);
  const config = exigirConfiguracaoWhatsappPrivada();
  const transacao = transacaoDe(deps);
  const preparada = await transacao(async (tx) => {
    const { sessao, tenant } = await gestaoTransacional(tx, token, 'conectar');
    await lockEmpresa(tx, config.ambiente, tenant.empresaComprovada);
    const tentativa = (await tx.query<Tentativa>('SELECT * FROM whatsapp_onboarding_tentativas WHERE id=$1 FOR UPDATE', [input.data.tentativaId])).rows[0];
    if (!tentativa || tentativa.ambiente !== config.ambiente || !tentativaDaSessao(tentativa, sessao, tenant)) throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_INVALIDA', 'Tentativa de onboarding inválida.', 403);
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
    await marcarFalha(transacao, input.data.tentativaId, preparada.sessao.usuario_id, contexto, code);
    if (error instanceof WhatsappOnboardingError) throw error;
    throw new WhatsappOnboardingError('META_VALIDACAO_FALHOU', 'Não foi possível validar a configuração com a Meta.', 502);
  }
  const identidade = { ambiente: config.ambiente, appId: config.appId, businessId: input.data.businessId, wabaId: input.data.wabaId, phoneNumberId: input.data.phoneNumberId, empresaId: preparada.empresaId };
  const credencial = cifrarCredencialWhatsapp(validada.accessToken, identidade);
  let concluida: { id: string };
  try {
    concluida = await transacao(async (tx) => {
      const { sessao, tenant } = await gestaoTransacional(tx, token, 'conectar');
      const empresaId = tenant.empresaComprovada;
      await lockEmpresa(tx, config.ambiente, empresaId);
      const tentativa = (await tx.query<Tentativa>('SELECT * FROM whatsapp_onboarding_tentativas WHERE id=$1 FOR UPDATE', [input.data.tentativaId])).rows[0];
      if (!tentativa || tentativa.status !== 'VALIDANDO' || !tentativaDaSessao(tentativa, sessao, tenant) || empresaId !== preparada.empresaId) throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_CONSUMIDA', 'Esta tentativa já foi utilizada.', 409);
      if ((await tx.query("SELECT 1 FROM whatsapp_conexoes WHERE ambiente=$1 AND empresa_id=$2::uuid AND status='CONFIGURADA' FOR UPDATE", [config.ambiente, empresaId])).rows[0]) throw new WhatsappOnboardingError('WHATSAPP_TROCA_SILENCIOSA_RECUSADA', 'Já existe uma conexão. Desconecte-a explicitamente antes de conectar outro número.', 409);
      if ((await tx.query("SELECT 1 FROM whatsapp_conexoes WHERE ambiente=$1 AND phone_number_id=$2 AND status='CONFIGURADA'", [config.ambiente, input.data.phoneNumberId])).rows[0]) throw NUMERO_EM_USO();
      const conexao = (await tx.query<{ id: string }>(`WITH instante AS (SELECT clock_timestamp() AS agora)
        INSERT INTO whatsapp_conexoes(ambiente,empresa_id,meta_app_id,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,coexistencia_confirmada,status,escopos,credencial_cifrada,credencial_iv,credencial_tag,credencial_chave_versao,token_tipo,token_expira_em,meta_validada_em,criada_por_usuario_id,sessao_referencia_id,criada_em,atualizada_em)
        SELECT $1,$17::uuid,$2,$3,$4,$5,$6,$7,true,'CONFIGURADA',$8,$9,$10,$11,$12,$13,$14,agora,$15,$16,agora,agora FROM instante RETURNING id`,
        [config.ambiente, config.appId, input.data.businessId, input.data.wabaId, input.data.phoneNumberId, validada.displayPhoneNumber, validada.verifiedName, validada.scopes, credencial.ciphertext, credencial.iv, credencial.tag, credencial.keyVersion, validada.tokenType, validada.expiresAt, sessao.usuario_id, sessao.id, empresaId])).rows[0];
      await tx.query(`UPDATE whatsapp_onboarding_tentativas SET status='CONCLUIDA',business_id=$2,waba_id=$3,phone_number_id=$4,conexao_id=$5,atualizada_em=clock_timestamp() WHERE id=$1`, [tentativa.id, input.data.businessId, input.data.wabaId, input.data.phoneNumberId, conexao.id]);
      await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'WHATSAPP_CONEXAO_CONFIGURADA', entidadeTipo: 'WHATSAPP_CONEXAO', entidadeId: conexao.id, dadosDepois: { ambiente: config.ambiente, empresaId, businessId: input.data.businessId, wabaId: input.data.wabaId, phoneNumberId: input.data.phoneNumberId, numeroExibicao: validada.displayPhoneNumber, nomeVerificado: validada.verifiedName, coexistenciaConfirmada: true, webhookAtivo: false, otpAtivo: false }, ...auditoriaBase(contexto) }, tx);
      await revalidarTenant(tx, tenant);
      return conexao;
    });
  } catch (error) {
    // Corrida entre duas empresas com o mesmo número: o índice único da 083 decide; a mensagem é a mesma.
    const normalizado = (error as { code?: string; constraint?: string })?.code === '23505' && (error as { constraint?: string }).constraint === 'whatsapp_conexoes_numero_configurado_uk' ? NUMERO_EM_USO() : error;
    const code = normalizado instanceof WhatsappOnboardingError ? normalizado.code : 'WHATSAPP_PERSISTENCIA_FALHOU';
    await marcarFalha(transacao, input.data.tentativaId, preparada.sessao.usuario_id, contexto, code);
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

export function contextoWhatsapp(userAgent: string | null): ContextoWhatsapp {
  return { requestId: randomUUID(), ip: null, userAgent: userAgent?.slice(0, 1000) ?? null };
}
