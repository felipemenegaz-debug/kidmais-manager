import { randomBytes, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts.ts';
import { db, withTransaction } from '../db/postgres.ts';
import { consultarSessao, type SessaoAdmin } from '../autenticacao/service.ts';
import { registrarAuditoria } from '../clientes/repositories/auditoria.repository.ts';
import { configuracaoWhatsappPublica, configuracaoWhatsappServidorPronta, exigirConfiguracaoWhatsappPrivada, type AmbienteWhatsapp } from './configuracao.ts';
import { cifrarCredencialWhatsapp } from './credencial.ts';
import { WhatsappOnboardingError } from './errors.ts';
import { trocarCodigoEValidarAtivos } from './meta-client.ts';
import { concluirOnboardingSchema, exigirRepresentanteRecente, hashState, stateCorresponde } from './onboarding-core.ts';

export { concluirOnboardingSchema, exigirRepresentanteRecente, stateCorresponde } from './onboarding-core.ts';

export type ContextoWhatsapp = { requestId: string; ip: string | null; userAgent: string | null };
type Tentativa = { id: string; ambiente: AmbienteWhatsapp; usuario_id: string; sessao_referencia_id: string; state_hash: Buffer; status: string; expira_em: string };

async function sessaoTransacional(tx: DbExecutor, token: string) {
  const sessao = await consultarSessao(token, tx, true);
  exigirRepresentanteRecente(sessao);
  return sessao;
}
async function lockAmbiente(tx: DbExecutor, ambiente: AmbienteWhatsapp) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('KIDMAIS_WHATSAPP_' || $1, 0))", [ambiente]);
}

export async function consultarConfiguracaoWhatsapp(sessao: SessaoAdmin, executor: DbExecutor = db()) {
  if (sessao.papel !== 'REPRESENTANTE_AUTORIZADO') throw new WhatsappOnboardingError('WHATSAPP_AUTORIZACAO_RECUSADA', 'Somente representante autorizado pode consultar esta configuração.', 403);
  const publica = configuracaoWhatsappPublica();
  const servidorPronto = configuracaoWhatsappServidorPronta();
  const ambiente = publica.ambiente;
  if (!ambiente) return { estado: 'ACAO_NECESSARIA', metaConfigurada: false, conexao: null, tentativa: null };
  const conexao = (await executor.query<{ id: string; ambiente: string; business_id: string; waba_id: string; phone_number_id: string; numero_exibicao: string; nome_verificado: string; status: string; meta_validada_em: string }>(
    `SELECT id,ambiente,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,status,meta_validada_em::text
       FROM whatsapp_conexoes WHERE ambiente=$1 AND status='CONFIGURADA'`, [ambiente],
  )).rows[0] ?? null;
  const tentativa = (await executor.query<{ id: string; status: string; expira_em: string }>(
    `SELECT id,status,expira_em::text FROM whatsapp_onboarding_tentativas
      WHERE ambiente=$1 AND usuario_id=$2 ORDER BY criada_em DESC LIMIT 1`, [ambiente, sessao.usuario_id],
  )).rows[0] ?? null;
  const estado = conexao ? 'CONFIGURADA_SEM_WEBHOOK_OTP'
    : tentativa?.status === 'INICIADA' ? 'AGUARDANDO_META'
      : tentativa?.status === 'VALIDANDO' ? 'VALIDANDO'
        : tentativa?.status === 'EXPIRADA' ? 'TENTATIVA_EXPIRADA'
          : servidorPronto ? 'NAO_CONFIGURADA' : 'ACAO_NECESSARIA';
  return {
    estado, metaConfigurada: servidorPronto,
    conexao: conexao && { id: conexao.id, ambiente: conexao.ambiente, businessId: conexao.business_id, wabaId: conexao.waba_id, phoneNumberId: conexao.phone_number_id, numeroExibicao: conexao.numero_exibicao, nomeVerificado: conexao.nome_verificado, status: conexao.status, validadaEm: conexao.meta_validada_em },
    tentativa,
  };
}

export async function iniciarOnboardingWhatsapp(token: string, contexto: ContextoWhatsapp) {
  const config = exigirConfiguracaoWhatsappPrivada();
  const state = randomBytes(32).toString('base64url');
  const result = await withTransaction(async (tx) => {
    const sessao = await sessaoTransacional(tx, token);
    await lockAmbiente(tx, config.ambiente);
    await tx.query(`UPDATE whatsapp_onboarding_tentativas SET status='EXPIRADA',consumida_em=COALESCE(consumida_em,clock_timestamp()),erro_codigo='TENTATIVA_EXPIRADA',atualizada_em=clock_timestamp()
      WHERE ambiente=$1 AND status IN ('INICIADA','VALIDANDO') AND expira_em<=clock_timestamp()`, [config.ambiente]);
    if ((await tx.query("SELECT 1 FROM whatsapp_conexoes WHERE ambiente=$1 AND status='CONFIGURADA' FOR UPDATE", [config.ambiente])).rows[0]) {
      throw new WhatsappOnboardingError('WHATSAPP_JA_CONFIGURADO', 'Já existe uma conexão WhatsApp configurada neste ambiente.', 409);
    }
    if ((await tx.query("SELECT 1 FROM whatsapp_onboarding_tentativas WHERE ambiente=$1 AND usuario_id=$2 AND status IN ('INICIADA','VALIDANDO') FOR UPDATE", [config.ambiente, sessao.usuario_id])).rows[0]) {
      throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_CONCORRENTE', 'Já existe uma tentativa de conexão em andamento.', 409);
    }
    const tentativa = (await tx.query<{ id: string; expira_em: string }>(`INSERT INTO whatsapp_onboarding_tentativas(ambiente,usuario_id,sessao_referencia_id,state_hash,expira_em)
      VALUES($1,$2,$3,$4,clock_timestamp()+interval '10 minutes') RETURNING id,expira_em::text`, [config.ambiente, sessao.usuario_id, sessao.id, hashState(state)])).rows[0];
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'WHATSAPP_ONBOARDING_INICIADO', entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: tentativa.id, dadosDepois: { ambiente: config.ambiente, status: 'INICIADA', expiraEm: tentativa.expira_em }, origem: 'WHATSAPP_CONFIGURACAO', requestId: contexto.requestId, ip: contexto.ip, userAgent: contexto.userAgent }, tx);
    return { tentativa, sessao };
  });
  return {
    tentativaId: result.tentativa.id, state, expiraEm: result.tentativa.expira_em,
    meta: { appId: config.appId, graphApiVersion: config.graphApiVersion, configurationId: config.configurationId, eventName: config.eventName, launchOptions: config.launchOptions, messageOrigins: config.messageOrigins },
  };
}

async function marcarFalha(tentativaId: string, usuarioId: string, contexto: ContextoWhatsapp, code: string) {
  await withTransaction(async (tx) => {
    const tentativa = (await tx.query<Tentativa>('SELECT * FROM whatsapp_onboarding_tentativas WHERE id=$1 FOR UPDATE', [tentativaId])).rows[0];
    if (!tentativa || tentativa.status !== 'VALIDANDO') return;
    await tx.query("UPDATE whatsapp_onboarding_tentativas SET status='FALHOU',erro_codigo=$2,atualizada_em=clock_timestamp() WHERE id=$1", [tentativaId, code]);
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId, acao: 'WHATSAPP_ONBOARDING_FALHOU', entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: tentativaId, dadosDepois: { ambiente: tentativa.ambiente, status: 'FALHOU', erroCodigo: code }, origem: 'WHATSAPP_CONFIGURACAO', requestId: contexto.requestId, ip: contexto.ip, userAgent: contexto.userAgent }, tx);
  });
}

export async function concluirOnboardingWhatsapp(raw: unknown, token: string, contexto: ContextoWhatsapp, deps: { validarMeta?: typeof trocarCodigoEValidarAtivos } = {}) {
  const input = concluirOnboardingSchema.safeParse(raw);
  if (!input.success) throw new WhatsappOnboardingError('WHATSAPP_DADOS_INVALIDOS', 'Dados de conclusão do onboarding inválidos.', 400);
  const config = exigirConfiguracaoWhatsappPrivada();
  const preparada = await withTransaction(async (tx) => {
    const sessao = await sessaoTransacional(tx, token);
    await lockAmbiente(tx, config.ambiente);
    const tentativa = (await tx.query<Tentativa>('SELECT * FROM whatsapp_onboarding_tentativas WHERE id=$1 FOR UPDATE', [input.data.tentativaId])).rows[0];
    if (!tentativa || tentativa.ambiente !== config.ambiente || tentativa.usuario_id !== sessao.usuario_id || tentativa.sessao_referencia_id !== sessao.id) throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_INVALIDA', 'Tentativa de onboarding inválida.', 404);
    if (tentativa.status !== 'INICIADA') throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_CONSUMIDA', 'Esta tentativa já foi utilizada.', 409);
    if (new Date(tentativa.expira_em).getTime() <= Date.now()) {
      await tx.query("UPDATE whatsapp_onboarding_tentativas SET status='EXPIRADA',consumida_em=clock_timestamp(),erro_codigo='TENTATIVA_EXPIRADA',atualizada_em=clock_timestamp() WHERE id=$1", [tentativa.id]);
      return { erro: new WhatsappOnboardingError('WHATSAPP_TENTATIVA_EXPIRADA', 'Esta tentativa expirou. Inicie uma nova conexão.', 409) } as const;
    }
    if (!stateCorresponde(input.data.state, tentativa.state_hash)) throw new WhatsappOnboardingError('WHATSAPP_STATE_INVALIDO', 'A confirmação não corresponde à tentativa iniciada.', 403);
    await tx.query("UPDATE whatsapp_onboarding_tentativas SET status='VALIDANDO',consumida_em=clock_timestamp(),atualizada_em=clock_timestamp() WHERE id=$1", [tentativa.id]);
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'WHATSAPP_ONBOARDING_VALIDANDO', entidadeTipo: 'WHATSAPP_ONBOARDING_TENTATIVA', entidadeId: tentativa.id, dadosAntes: { status: 'INICIADA' }, dadosDepois: { ambiente: config.ambiente, status: 'VALIDANDO' }, origem: 'WHATSAPP_CONFIGURACAO', requestId: contexto.requestId, ip: contexto.ip, userAgent: contexto.userAgent }, tx);
    return { sessao, tentativa } as const;
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
    await marcarFalha(input.data.tentativaId, preparada.sessao.usuario_id, contexto, code);
    if (error instanceof WhatsappOnboardingError) throw error;
    throw new WhatsappOnboardingError('META_VALIDACAO_FALHOU', 'Não foi possível validar a configuração com a Meta.', 502);
  }
  const identidade = { ambiente: config.ambiente, appId: config.appId, businessId: input.data.businessId, wabaId: input.data.wabaId, phoneNumberId: input.data.phoneNumberId };
  const credencial = cifrarCredencialWhatsapp(validada.accessToken, identidade);
  let concluida: { id: string };
  try {
    concluida = await withTransaction(async (tx) => {
    const sessao = await sessaoTransacional(tx, token);
    await lockAmbiente(tx, config.ambiente);
    const tentativa = (await tx.query<Tentativa>('SELECT * FROM whatsapp_onboarding_tentativas WHERE id=$1 FOR UPDATE', [input.data.tentativaId])).rows[0];
    if (!tentativa || tentativa.status !== 'VALIDANDO' || tentativa.usuario_id !== sessao.usuario_id || tentativa.sessao_referencia_id !== sessao.id) throw new WhatsappOnboardingError('WHATSAPP_TENTATIVA_CONSUMIDA', 'Esta tentativa já foi utilizada.', 409);
    if ((await tx.query("SELECT 1 FROM whatsapp_conexoes WHERE ambiente=$1 AND status='CONFIGURADA' FOR UPDATE", [config.ambiente])).rows[0]) throw new WhatsappOnboardingError('WHATSAPP_TROCA_SILENCIOSA_RECUSADA', 'Já existe uma conexão. Desconecte-a explicitamente antes de conectar outro número.', 409);
    const conexao = (await tx.query<{ id: string }>(`WITH instante AS (SELECT clock_timestamp() AS agora)
      INSERT INTO whatsapp_conexoes(ambiente,meta_app_id,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,coexistencia_confirmada,status,escopos,credencial_cifrada,credencial_iv,credencial_tag,credencial_chave_versao,token_tipo,token_expira_em,meta_validada_em,criada_por_usuario_id,sessao_referencia_id,criada_em,atualizada_em)
      SELECT $1,$2,$3,$4,$5,$6,$7,true,'CONFIGURADA',$8,$9,$10,$11,$12,$13,$14,agora,$15,$16,agora,agora FROM instante RETURNING id`,
      [config.ambiente, config.appId, input.data.businessId, input.data.wabaId, input.data.phoneNumberId, validada.displayPhoneNumber, validada.verifiedName, validada.scopes, credencial.ciphertext, credencial.iv, credencial.tag, credencial.keyVersion, validada.tokenType, validada.expiresAt, sessao.usuario_id, sessao.id])).rows[0];
    await tx.query(`UPDATE whatsapp_onboarding_tentativas SET status='CONCLUIDA',business_id=$2,waba_id=$3,phone_number_id=$4,conexao_id=$5,atualizada_em=clock_timestamp() WHERE id=$1`, [tentativa.id, input.data.businessId, input.data.wabaId, input.data.phoneNumberId, conexao.id]);
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: sessao.usuario_id, acao: 'WHATSAPP_CONEXAO_CONFIGURADA', entidadeTipo: 'WHATSAPP_CONEXAO', entidadeId: conexao.id, dadosDepois: { ambiente: config.ambiente, businessId: input.data.businessId, wabaId: input.data.wabaId, phoneNumberId: input.data.phoneNumberId, numeroExibicao: validada.displayPhoneNumber, nomeVerificado: validada.verifiedName, coexistenciaConfirmada: true, webhookAtivo: false, otpAtivo: false }, origem: 'WHATSAPP_CONFIGURACAO', requestId: contexto.requestId, ip: contexto.ip, userAgent: contexto.userAgent }, tx);
    return conexao;
    });
  } catch (error) {
    const code = error instanceof WhatsappOnboardingError ? error.code : 'WHATSAPP_PERSISTENCIA_FALHOU';
    await marcarFalha(input.data.tentativaId, preparada.sessao.usuario_id, contexto, code);
    throw error;
  }
  return { conexaoId: concluida.id, estado: 'CONFIGURADA_SEM_WEBHOOK_OTP', numeroExibicao: validada.displayPhoneNumber, nomeVerificado: validada.verifiedName };
}

export function contextoWhatsapp(userAgent: string | null): ContextoWhatsapp {
  return { requestId: randomUUID(), ip: null, userAgent: userAgent?.slice(0, 1000) ?? null };
}
