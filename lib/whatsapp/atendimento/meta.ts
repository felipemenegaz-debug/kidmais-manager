import { db } from '../../db/postgres.ts';
import type { DbExecutor } from '../../db/contracts.ts';
import type { AmbienteWhatsapp } from '../configuracao.ts';
import { carregarChaveCredencial, decifrarCredencialWhatsapp } from '../credencial.ts';
import type { EventosMeta } from '../../integracoes/meta/webhook.ts';
import { ambienteAtendimento, canalEnvio, empresaPiloto, recepcaoAtiva, recepcaoMetaAtiva } from './configuracao.ts';
import { APP_META, nomePerfilSeguro, type Entrada } from './core.ts';
import { receberEntrada, registrarStatus } from './service.ts';
import { enviarMensagem, type ConteudoSaida } from './transporte.ts';

/**
 * WhatsApp Cloud API (Meta) como canal do atendimento. O número é o que a empresa conectou em Configurações > WhatsApp
 * (Embedded Signup, `whatsapp_conexoes` da 018/083): a conexão CONFIGURADA do número diz de qual empresa é o evento, e a
 * credencial cifrada dela é a que envia. Nada aqui lê variáveis de número, chave de provedor ou lista de empresas.
 *
 * Enquanto o atendimento atende uma única empresa (a piloto, WHATSAPP_ATENDIMENTO_EMPRESA_ID — tela e worker leem
 * dela), evento de número conectado a OUTRA empresa é confirmado sem gravar. As mesmas chaves do canal valem para os dois
 * provedores (recepção, envio, receptor e, fora de produção, a lista de contatos permitidos).
 */
const ambienteConexao = (): AmbienteWhatsapp => (ambienteAtendimento() === 'production' ? 'PRODUCTION' : 'STAGING');

type LinhaConexao = { id: string; empresa_id: string; meta_app_id: string; business_id: string; waba_id: string; phone_number_id: string; credencial_cifrada: Buffer; credencial_iv: Buffer; credencial_tag: Buffer; credencial_chave_versao: number; token_expira_em: string | null };

/** Empresa dona do número conectado (CONFIGURADA, mesmo ambiente e mesma conta WhatsApp do evento) ou null. */
export async function empresaDoNumeroMeta(tx: DbExecutor, phoneNumberId: string, wabaId: string) {
  const r = await tx.query<{ empresa_id: string }>(`SELECT empresa_id FROM whatsapp_conexoes
    WHERE ambiente=$1 AND phone_number_id=$2 AND waba_id=$3 AND status='CONFIGURADA' AND empresa_id IS NOT NULL`, [ambienteConexao(), phoneNumberId, wabaId]);
  return r.rows[0]?.empresa_id ?? null;
}

/** Entrada da Meta no formato do atendimento: `source` é o wa_id (só dígitos, com DDI) e o horário vem em ms. */
export function entradaMeta(e: EventosMeta['entradas'][number]): Entrada {
  return { id: e.id, app: APP_META, source: e.contato, texto: e.texto, timestamp: e.timestamp, nomePerfil: nomePerfilSeguro(e.nomePerfil) };
}

/**
 * Persiste os eventos de um POST do webhook. Por evento: número conectado → empresa; só a piloto grava (ver acima).
 * Status `read` e `delivered` valem ENTREGUE; `failed` vale FALHOU (o mesmo tratamento da falha do Gupshup).
 */
export async function receberEventosMeta(eventos: EventosMeta, opcoes: { automacaoGlobal?: boolean } = {}) {
  const piloto = empresaPiloto();
  const empresas = new Map<string, string | null>();
  const empresaDe = async (phoneNumberId: string, wabaId: string) => {
    const chave = `${phoneNumberId}:${wabaId}`;
    if (!empresas.has(chave)) empresas.set(chave, await empresaDoNumeroMeta(db(), phoneNumberId, wabaId));
    return empresas.get(chave) ?? null;
  };
  for (const e of eventos.entradas) {
    if ((await empresaDe(e.phoneNumberId, e.wabaId)) !== piloto) continue;
    await receberEntrada(entradaMeta(e), { ...opcoes, empresa: piloto });
  }
  for (const s of eventos.status) {
    if ((await empresaDe(s.phoneNumberId, s.wabaId)) !== piloto) continue;
    await registrarStatus(piloto, s.id, s.tipo === 'failed' ? 'FALHOU' : 'ENTREGUE');
  }
}

export type ConexaoEnvioMeta = { phoneNumberId: string; token: string };

/**
 * Credencial de envio da empresa: a conexão CONFIGURADA dela neste ambiente, decifrada com a identidade completa
 * (ambiente, app, negócio, conta, número e empresa — a mesma da cifragem no onboarding). Sem conexão: null (a empresa
 * não usa a Meta). Chave de outra versão ou token vencido: transporte não configurado (nada sai, a mensagem termina
 * FALHOU e vai para a equipe), nunca uma tentativa com credencial errada.
 */
export async function conexaoEnvioMeta(tx: DbExecutor, empresaId: string, env: NodeJS.ProcessEnv = process.env): Promise<ConexaoEnvioMeta | null> {
  const ambiente = ambienteConexao();
  const c = (await tx.query<LinhaConexao>(`SELECT id,empresa_id,meta_app_id,business_id,waba_id,phone_number_id,credencial_cifrada,credencial_iv,credencial_tag,credencial_chave_versao,token_expira_em::text
    FROM whatsapp_conexoes WHERE ambiente=$1 AND empresa_id=$2 AND status='CONFIGURADA'`, [ambiente, empresaId])).rows[0];
  if (!c) return null;
  if (c.token_expira_em && new Date(c.token_expira_em).getTime() <= Date.now()) throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO');
  let versao: number;
  try { versao = carregarChaveCredencial(env).version; } catch { throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO'); }
  if (Number(c.credencial_chave_versao) !== versao) throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO');
  try {
    const token = decifrarCredencialWhatsapp({ ciphertext: c.credencial_cifrada, iv: c.credencial_iv, tag: c.credencial_tag },
      { ambiente, appId: c.meta_app_id, businessId: c.business_id, wabaId: c.waba_id, phoneNumberId: c.phone_number_id, empresaId: c.empresa_id }, env);
    return { phoneNumberId: c.phone_number_id, token };
  } catch { throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO'); }
}

/** Mesmo critério do Gupshup: o provedor respondeu e não aceitou (nada saiu) → FALHOU; o resto é incerto. */
const RECUSA_DEFINITIVA = new Set([400, 401, 403, 404, 413, 415, 422, 429]);

/**
 * Corpo de `POST /{phone-number-id}/messages` (mensagem de sessão, dentro da janela de 24 h): texto sem prévia de link;
 * foto, vídeo e documento por `link` https com legenda opcional (documento leva o nome do arquivo). Legenda vazia não vai.
 */
export function mensagemMeta(to: string, c: ConteudoSaida) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  if (c.tipo === 'TEXTO') return { ...base, type: 'text', text: { body: c.texto, preview_url: false } };
  const caption = c.legenda?.trim() ? { caption: c.legenda.trim() } : {};
  if (c.tipo === 'DOCUMENTO') return { ...base, type: 'document', document: { link: c.url, filename: c.nome, ...caption } };
  return c.tipo === 'IMAGEM' ? { ...base, type: 'image', image: { link: c.url, ...caption } } : { ...base, type: 'video', video: { link: c.url, ...caption } };
}

/** Versão da Graph API do ambiente (a mesma do Embedded Signup). */
export function versaoGraph(env: NodeJS.ProcessEnv = process.env) {
  const v = env.META_GRAPH_API_VERSION?.trim() ?? '';
  if (!/^v[0-9]+\.[0-9]+$/.test(v)) throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO');
  return v;
}

/** Envia pela Cloud API e devolve o id da mensagem (wamid), o mesmo que volta nos status do webhook. */
export async function enviarMensagemMeta(conexao: ConexaoEnvioMeta, destination: string, conteudo: ConteudoSaida, buscar: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env) {
  if (!/^\d{8,15}$/.test(destination) || !/^\d{1,32}$/.test(conexao.phoneNumberId) || !conexao.token) throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO');
  if (conteudo.tipo !== 'TEXTO' && !/^https:\/\/[^\s]+$/.test(conteudo.url)) throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO');
  const versao = versaoGraph(env);
  const r = await buscar(`https://graph.facebook.com/${versao}/${conexao.phoneNumberId}/messages`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), cache: 'no-store',
    headers: { Authorization: `Bearer ${conexao.token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(mensagemMeta(destination, conteudo)),
  });
  if (RECUSA_DEFINITIVA.has(r.status)) { await r.body?.cancel().catch(() => {}); throw new Error('ATENDIMENTO_ENVIO_RECUSADO'); }
  const reader = r.body?.getReader();
  if (!reader) throw new Error('ATENDIMENTO_RESULTADO_INCERTO');
  let bytes = 0, body = ''; const decoder = new TextDecoder();
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 8192) { await reader.cancel(); throw new Error('ATENDIMENTO_RESULTADO_INCERTO'); } body += decoder.decode(chunk.value, { stream: true }); }
    body += decoder.decode();
  } finally { reader.releaseLock(); }
  let data: { messages?: { id?: unknown }[] };
  try { data = JSON.parse(body); } catch { throw new Error('ATENDIMENTO_RESULTADO_INCERTO'); }
  const id = data?.messages?.[0]?.id;
  if (r.status < 200 || r.status > 299 || typeof id !== 'string' || !id.length || id.length > 512) throw new Error('ATENDIMENTO_RESULTADO_INCERTO');
  return id;
}

/**
 * Porta `enviar` do worker (composition root), pelo canal EXPLÍCITO (canalEnvio), nunca pela simples existência de uma
 * conexão: GUPSHUP (padrão) ignora a conexão Meta; META exige a conexão Meta CONFIGURADA e válida da piloto, sem
 * fallback; INVALIDO não envia. Toda recusa acontece antes da rede (ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO: nada saiu,
 * o worker marca FALHOU).
 */
export async function enviarPelaEmpresa(contato: string, conteudo: ConteudoSaida, deps: { gupshup?: typeof enviarMensagem; buscar?: typeof fetch; executor?: DbExecutor; env?: NodeJS.ProcessEnv } = {}) {
  const canal = canalEnvio(deps.env ?? process.env);
  if (canal === 'INVALIDO') throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO');
  if (canal === 'GUPSHUP') return (deps.gupshup ?? enviarMensagem)(contato, conteudo, deps.buscar);
  let conexao: ConexaoEnvioMeta | null;
  try { conexao = await conexaoEnvioMeta(deps.executor ?? db(), empresaPiloto()); }
  catch { throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO'); }
  if (!conexao) throw new Error('ATENDIMENTO_TRANSPORTE_NAO_CONFIGURADO');
  return enviarMensagemMeta(conexao, contato, conteudo, deps.buscar);
}

/**
 * Persistência do webhook da Meta, decidida por requisição: só com a recepção do atendimento ligada (recepcaoAtiva) E a
 * chave própria da Meta (recepcaoMetaAtiva). Sem as duas: undefined. O webhook então só confere a assinatura e responde
 * 200, DESCARTANDO mensagens e status (sem gravar, enfileirar ou chamar a IA; a Meta não reenvia).
 */
export function persistenciaWebhookMeta(opcoes: { automacaoGlobal?: boolean }, env: NodeJS.ProcessEnv = process.env, receber: typeof receberEventosMeta = receberEventosMeta) {
  if (!recepcaoAtiva(env) || !recepcaoMetaAtiva(env)) return undefined;
  return (eventos: EventosMeta) => receber(eventos, opcoes);
}
