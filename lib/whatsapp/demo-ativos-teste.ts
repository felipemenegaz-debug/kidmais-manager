import type { DbExecutor } from '../db/contracts.ts';
import { withTransaction } from '../db/postgres.ts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { provarTenant, revalidarTenant, type SessaoParaTenant, type TenantComprovado } from '../saas/provar-tenant.ts';
import { WhatsappOnboardingError, isWhatsappOnboardingError } from './errors.ts';
import { lerNumerosDaWaba, wabaPertenceAoNegocio } from './meta-client.ts';
import { PAPEL_GESTAO } from './onboarding-core.ts';

/**
 * VERIFICAÇÃO DE ATIVOS DE TESTE DA META (análise do app, `business_management`): mostra, com ativos de teste do
 * próprio portfólio Kidmais, a mesma leitura de pertencimento WABA ↔ negócio e de números que a conexão real faz.
 * Somente leitura: nenhuma conexão, tentativa, inscrição ou mensagem; nenhuma escrita além da atividade da sessão
 * (feita por toda rota administrativa).
 *
 * Trava: só o serviço web de STAGING, identificado pelo Render (constante abaixo, nunca variável), com a flag ligada,
 * e só para a empresa E o usuário de revisão configurados. Qualquer outra situação responde 404, sem chamar a Meta.
 * `NODE_ENV`, Host e cabeçalhos não participam da decisão. Os ativos são constantes: nada vem do navegador.
 */
export const SERVICO_WEB_STAGING = 'srv-daif418ae00c73e8k2gg';
export const ATIVOS_TESTE = Object.freeze({ businessId: '1591095999057604', wabaId: '1555933295860010', phoneNumberId: '1317246918141796' });
export const AVISO_IS_ON_BIZ_APP = 'O Kidmais só aceita conexão por coexistência de número com is_on_biz_app=true. Esse atributo, sozinho, não comprova elegibilidade completa para coexistência, permissões avançadas nem aprovação da Meta. Esta verificação não cria conexão.';
/** Limitador de FREQUÊNCIA (não é prazo): no máximo uma verificação a cada 30 s por usuário. */
export const INTERVALO_MINIMO_MS = 30_000;
/** PRAZO de cada leitura na Meta, cobrindo a chamada E a leitura do corpo. Esgotado: aborta e responde 504 genérico. */
export const PRAZO_LEITURA_MS = 8_000;

type Env = Record<string, string | undefined>;
export type TravaDemo =
  | { liberada: true; empresaId: string; usuarioId: string; token: string; graphApiVersion: string }
  | { liberada: false; motivo: 'DEMO_AMBIENTE_RECUSADO' | 'DEMO_DESLIGADA' | 'DEMO_CONFIGURACAO_INCOMPLETA' };
export type RequisitoIsOnBizApp = 'atendido' | 'nao_atendido' | 'nao_informado';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Comparações EXATAS (sem trim nem caixa): ausência ou qualquer divergência bloqueia. */
export function travaDemoAtivosTeste(env: Env = process.env): TravaDemo {
  if (env.RENDER !== 'true' || env.RENDER_SERVICE_ID !== SERVICO_WEB_STAGING || env.KIDMAIS_DEPLOY_ENV !== 'staging') return { liberada: false, motivo: 'DEMO_AMBIENTE_RECUSADO' };
  if (env.META_DEMO_ATIVOS_TESTE !== 'true') return { liberada: false, motivo: 'DEMO_DESLIGADA' };
  const empresaId = env.META_DEMO_EMPRESA_ID ?? '', usuarioId = env.META_DEMO_USUARIO_ID ?? '';
  const token = env.META_DEMO_ACCESS_TOKEN ?? '', graphApiVersion = env.META_GRAPH_API_VERSION ?? '';
  if (!UUID.test(empresaId) || !UUID.test(usuarioId) || !/^[A-Za-z0-9._-]{20,4096}$/.test(token) || !/^v[0-9]+\.[0-9]+$/.test(graphApiVersion)) {
    return { liberada: false, motivo: 'DEMO_CONFIGURACAO_INCOMPLETA' };
  }
  return { liberada: true, empresaId, usuarioId, token, graphApiVersion };
}

/** Visível só para a Gestão da empresa de revisão, logada com o usuário de revisão. */
export function demoVisivelPara(trava: TravaDemo, tenant: Pick<TenantComprovado, 'empresaComprovada' | 'usuarioId' | 'papelAtual'>, usuarioIdSessao: string) {
  return trava.liberada && tenant.papelAtual === PAPEL_GESTAO && tenant.empresaComprovada === trava.empresaId
    && tenant.usuarioId === trava.usuarioId && usuarioIdSessao === trava.usuarioId;
}

/** A rota não aceita parâmetros: corpo ou query presentes são recusados antes de qualquer chamada à Meta. */
export function exigirRequisicaoSemParametros(search: string, corpo: string) {
  if (search !== '' || corpo !== '') throw new WhatsappOnboardingError('DEMO_PARAMETROS_RECUSADOS', 'Esta verificação não aceita parâmetros.', 400);
}

export function requisitoIsOnBizApp(numero: Record<string, unknown> | undefined): RequisitoIsOnBizApp {
  if (numero?.is_on_biz_app === true) return 'atendido';
  if (numero?.is_on_biz_app === false) return 'nao_atendido';
  return 'nao_informado';
}

const NAO_ENCONTRADO = () => new WhatsappOnboardingError('NAO_ENCONTRADO', 'Recurso não encontrado.', 404);
const META_RECUSOU = () => new WhatsappOnboardingError('DEMO_META_RECUSOU', 'A Meta não confirmou a leitura dos ativos de teste.', 502);
const META_SEM_RESPOSTA = () => new WhatsappOnboardingError('DEMO_META_SEM_RESPOSTA', 'A Meta não respondeu a tempo. Tente de novo em instantes.', 504);
class PrazoEsgotado extends Error {}

/**
 * Executa UMA leitura com prazo próprio. O `fetch` entregue à leitura carrega o sinal de cancelamento (a chamada e o
 * corpo são abortados), e a corrida com o prazo cobre também um corpo que nunca termina. As funções compartilhadas com o
 * onboarding (`wabaPertenceAoNegocio`, `lerNumerosDaWaba`) não mudam: só recebem este `fetch`.
 */
export async function comPrazo<T>(prazoMs: number, fetchImpl: typeof fetch, leitura: (fetchComPrazo: typeof fetch) => Promise<T>): Promise<T> {
  const controle = new AbortController();
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<never>((_, rejeitar) => { relogio = setTimeout(() => { controle.abort(); rejeitar(new PrazoEsgotado()); }, prazoMs); });
  const fetchComPrazo = ((entrada: Parameters<typeof fetch>[0], init?: RequestInit) => fetchImpl(entrada, { ...init, signal: controle.signal })) as typeof fetch;
  const trabalho = leitura(fetchComPrazo);
  trabalho.catch(() => undefined); // a leitura abortada depois do prazo não vira rejeição sem tratamento
  try { return await Promise.race([trabalho, prazo]); } finally { clearTimeout(relogio); }
}
const texto = (v: unknown) => (typeof v === 'string' ? v : null);

type Transacao = <T>(work: (tx: DbExecutor) => Promise<T>) => Promise<T>;
export type DepsDemo = { env?: Env; transacao?: Transacao; provar?: typeof provarTenant; revalidar?: typeof revalidarTenant; fetchImpl?: typeof fetch; prazoMs?: number; agora?: () => number; log?: (resumo: Record<string, unknown>) => void; ultimas?: Map<string, number> };
const ultimasConsultas = new Map<string, number>();
const logPadrao = (resumo: Record<string, unknown>) => { console.info('[Meta demo ativos]', JSON.stringify(resumo)); };

/** Flag do GET de configuração, calculada no servidor (o cliente nunca decide). */
export function demoAtivosTesteVisivel(tenant: Pick<TenantComprovado, 'empresaComprovada' | 'usuarioId' | 'papelAtual'>, usuarioIdSessao: string, env: Env = process.env) {
  return demoVisivelPara(travaDemoAtivosTeste(env), tenant, usuarioIdSessao);
}

export async function verificarAtivosTeste(sessao: SessaoParaTenant, deps: DepsDemo = {}) {
  const log = deps.log ?? logPadrao;
  const trava = travaDemoAtivosTeste(deps.env ?? process.env);
  if (!trava.liberada) { log({ resultado: trava.motivo }); throw NAO_ENCONTRADO(); }

  const autorizada = await (deps.transacao ?? withTransaction)(async (tx) => {
    let tenant: TenantComprovado;
    try { tenant = await (deps.provar ?? provarTenant)(tx, sessao, null); } catch (error) { if (error instanceof PacoteAdminError) return false; throw error; }
    if (!demoVisivelPara(trava, tenant, sessao.usuario_id)) return false;
    await (deps.revalidar ?? revalidarTenant)(tx, tenant);
    return true;
  });
  if (!autorizada) { log({ resultado: 'DEMO_SESSAO_RECUSADA' }); throw NAO_ENCONTRADO(); }

  const ultimas = deps.ultimas ?? ultimasConsultas, agora = (deps.agora ?? Date.now)();
  const ultima = ultimas.get(sessao.usuario_id);
  if (ultima !== undefined && agora - ultima < INTERVALO_MINIMO_MS) throw new WhatsappOnboardingError('DEMO_AGUARDE', 'Aguarde alguns segundos antes de verificar de novo.', 429);
  ultimas.set(sessao.usuario_id, agora);

  const fetchImpl = deps.fetchImpl ?? fetch, config = { graphApiVersion: trava.graphApiVersion }, prazoMs = deps.prazoMs ?? PRAZO_LEITURA_MS;
  try {
    const possuiWabaTeste = await comPrazo(prazoMs, fetchImpl, (f) => wabaPertenceAoNegocio(ATIVOS_TESTE.businessId, ATIVOS_TESTE.wabaId, trava.token, config, f));
    const lista = possuiWabaTeste ? (await comPrazo(prazoMs, fetchImpl, (f) => lerNumerosDaWaba(ATIVOS_TESTE.wabaId, trava.token, config, f))).data ?? [] : [];
    const numeros = lista.slice(0, 100).map((item) => ({
      id: String(item.id ?? ''), display_phone_number: texto(item.display_phone_number), verified_name: texto(item.verified_name),
      is_on_biz_app: typeof item.is_on_biz_app === 'boolean' ? item.is_on_biz_app : null,
    }));
    const numeroTeste = lista.find((item) => String(item.id) === ATIVOS_TESTE.phoneNumberId);
    const requisito = requisitoIsOnBizApp(numeroTeste);
    log({ resultado: 'OK', pertence: possuiWabaTeste, numeros: numeros.length, numeroTeste: Boolean(numeroTeste), requisito });
    return {
      ambiente: 'teste' as const,
      portfolio: { id: ATIVOS_TESTE.businessId, possuiWabaTeste },
      waba: { id: ATIVOS_TESTE.wabaId },
      numeros,
      numeroTestePresente: Boolean(numeroTeste),
      requisitoKidmaisIsOnBizApp: requisito,
      aviso: AVISO_IS_ON_BIZ_APP,
    };
  } catch (error) {
    // Nunca repassa a mensagem original (pode conter detalhes da chamada); só o código no log.
    if (error instanceof PrazoEsgotado) { log({ resultado: 'DEMO_META_SEM_RESPOSTA' }); throw META_SEM_RESPOSTA(); }
    log({ resultado: 'DEMO_META_RECUSOU', codigo: isWhatsappOnboardingError(error) ? error.code : 'FALHA_DE_REDE' });
    throw META_RECUSOU();
  }
}
