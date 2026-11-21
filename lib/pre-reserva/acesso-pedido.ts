import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DbExecutor } from '../db/contracts.ts';
import { classificarDocumentoIdentidade } from '../identidade/documento.ts';
import { criarIdentityServiceComAmbiente } from '../identidade/services/identity.service.ts';
import { isIdentityServiceError } from '../identidade/services/errors.ts';
import { enviarOtpComAmbiente } from '../identidade/delivery/index.ts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';

export const CAMINHO_API_MEU_PEDIDO = '/api/meu-pedido';
const TTL_DESAFIO_MS = 10 * 60_000;
export const TTL_SESSAO_PEDIDO_MS = 15 * 60_000;

const dadosToken = z.object({ empresaId: z.uuid(), id: z.uuid(), expiraEm: z.number().int() });
type DadosToken = z.infer<typeof dadosToken>;
type TipoToken = 'desafio' | 'sessao';

function chaveToken(pepper: string, tipo: TipoToken) {
  return createHmac('sha256', pepper).update('meu-pedido:v1:' + tipo).digest();
}

function selarToken(pepper: string, tipo: TipoToken, dados: DadosToken) {
  const iv = randomBytes(12);
  const cifra = createCipheriv('aes-256-gcm', chaveToken(pepper, tipo), iv);
  const corpo = Buffer.concat([cifra.update(JSON.stringify(dados), 'utf8'), cifra.final()]);
  return Buffer.concat([iv, cifra.getAuthTag(), corpo]).toString('base64url');
}

function abrirToken(pepper: string, tipo: TipoToken, empresaId: string, token: string | undefined, agora: number) {
  if (!token || !/^[A-Za-z0-9_-]{38,320}$/.test(token)) return null;
  try {
    const bytes = Buffer.from(token, 'base64url');
    const cifra = createDecipheriv('aes-256-gcm', chaveToken(pepper, tipo), bytes.subarray(0, 12));
    cifra.setAuthTag(bytes.subarray(12, 28));
    const bruto = Buffer.concat([cifra.update(bytes.subarray(28)), cifra.final()]).toString('utf8');
    const dados = dadosToken.parse(JSON.parse(bruto));
    return dados.empresaId === empresaId && dados.expiraEm > agora ? dados : null;
  } catch {
    return null;
  }
}

export type SessaoMeuPedido = { empresaId: string; clienteId: string; expiraEm: number };
type Identidade = Pick<ReturnType<typeof criarIdentityServiceComAmbiente>, 'iniciarDesafio' | 'confirmarCodigo' | 'resolverClientePorProva'>;
const identidadePadrao = () => criarIdentityServiceComAmbiente(enviarOtpComAmbiente, { otpTtlMs: TTL_DESAFIO_MS });

export function emitirSessaoMeuPedido(empresaId: string, clienteId: string, pepper: string, agora = Date.now()) {
  return selarToken(pepper, 'sessao', { empresaId, id: clienteId, expiraEm: agora + TTL_SESSAO_PEDIDO_MS });
}

export function lerSessaoMeuPedido(empresaId: string, token: string | undefined, pepper: string, agora = Date.now()): SessaoMeuPedido | null {
  const dados = abrirToken(pepper, 'sessao', empresaId, token, agora);
  return dados && { empresaId, clienteId: dados.id, expiraEm: dados.expiraEm };
}

export function exigirSessaoMeuPedido(sessao: SessaoMeuPedido | null, empresaId: string) {
  if (!sessao || sessao.empresaId !== empresaId || sessao.expiraEm <= Date.now())
    throw new PacoteAdminError('SESSAO_ENCERRADA', 'Sua sessão terminou. Entre novamente.', 401);
  return sessao;
}

export function nomeCookiePedido(empresaId: string) {
  return '__Secure-kmpedido-' + empresaId;
}

export function cookieMeuPedido(empresaId: string, token: string) {
  return {
    name: nomeCookiePedido(empresaId), value: token, path: CAMINHO_API_MEU_PEDIDO,
    httpOnly: true, secure: true, sameSite: 'lax' as const, maxAge: TTL_SESSAO_PEDIDO_MS / 1000,
  };
}

export async function iniciarEntradaMeuPedido(tx: DbExecutor, empresaId: string, cpf: string, canal: 'WHATSAPP' | 'EMAIL',
  pepper: string, identidade: Identidade = identidadePadrao()) {
  let id: string = randomUUID();
  const expiraEm = Date.now() + TTL_DESAFIO_MS;
  try {
    const desafio = await identidade.iniciarDesafio({
      cpf, canal, escopo: { empresaId, incluirLegadoSemEmpresa: false },
    }, tx);
    id = desafio.validacaoId;
  } catch (error) {
    if (!isIdentityServiceError(error) || !['CLIENTE_NAO_ENCONTRADO', 'CANAL_INDISPONIVEL', 'FALHA_ENVIO_OTP', 'LIMITE_ENVIOS_OTP'].includes(error.code)) throw error;
  }
  // Não consulta se há pedidos. O ticket fictício tem o mesmo formato e a mesma expiração do real.
  return { desafio: selarToken(pepper, 'desafio', { empresaId, id, expiraEm }), expiraEm: new Date(expiraEm) };
}

export async function confirmarEntradaMeuPedido(tx: DbExecutor, empresaId: string, desafio: string, codigo: string,
  pepper: string, identidade: Identidade = identidadePadrao()) {
  const dados = abrirToken(pepper, 'desafio', empresaId, desafio, Date.now());
  if (!dados) return null;
  try {
    // A prova fica no servidor. O ticket opaco também protege o id do desafio da confirmação genérica.
    const prova = await identidade.confirmarCodigo({ validacaoId: dados.id, codigo }, tx);
    const titular = await identidade.resolverClientePorProva(prova.provaToken, tx);
    return emitirSessaoMeuPedido(empresaId, titular.clienteId, pepper);
  } catch (error) {
    if (isIdentityServiceError(error) && error.httpStatus < 500) return null;
    throw error;
  }
}

export function cpfEntradaPedido(cpf: string) {
  return classificarDocumentoIdentidade(cpf)?.tipo === 'CPF';
}
