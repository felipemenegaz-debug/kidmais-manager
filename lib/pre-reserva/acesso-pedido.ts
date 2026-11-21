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

const canalToken = z.enum(['w', 'e']);
const dadosToken = z.object({
  empresaId: z.uuid(), id: z.uuid(), expiraEm: z.number().int(),
  canal: canalToken, contato: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
type DadosToken = z.infer<typeof dadosToken>;
type Vinculo = Pick<DadosToken, 'canal' | 'contato'>;
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

export type SessaoMeuPedido = { empresaId: string; clienteId: string; expiraEm: number } & Vinculo;

async function lerContato(tx: DbExecutor, empresaId: string, id: string, canal: Vinculo['canal'],
  por: 'cliente' | 'validacao', travar = false) {
  const { rows: [cliente] } = await tx.query<{ id: string; destino: string | null; alteradoEm: string }>(`SELECT
    id, CASE WHEN $3 = 'w' THEN whatsapp ELSE email END AS destino,
    to_char(atualizado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "alteradoEm"
    FROM clientes WHERE empresa_id=$1 AND status <> 'MESCLADO'
      AND id=${por === 'cliente' ? '$2' : '(SELECT cliente_id FROM validacoes_identidade_cliente WHERE id=$2)'}${travar ? ' FOR SHARE' : ''}`,
    [empresaId, id, canal]);
  return cliente;
}

function assinaturaDoContato(pepper: string, empresaId: string, canal: Vinculo['canal'],
  cliente: NonNullable<Awaited<ReturnType<typeof lerContato>>>) {
  // A revisão do cadastro evita revalidar um token antigo se o contato for trocado e depois restaurado.
  return createHmac('sha256', pepper).update('meu-pedido:contato:v1|')
    .update(JSON.stringify([empresaId, cliente.id, canal, cliente.destino?.trim(), cliente.alteradoEm])).digest('base64url');
}

async function contatoConfere(tx: DbExecutor, empresaId: string, clienteId: string, vinculo: Vinculo, pepper: string, travar = false) {
  const cliente = await lerContato(tx, empresaId, clienteId, vinculo.canal, 'cliente', travar);
  return !!cliente?.destino && assinaturaDoContato(pepper, empresaId, vinculo.canal, cliente) === vinculo.contato;
}

export function abrirSessaoMeuPedido(empresaId: string, token: string | undefined, pepper: string): SessaoMeuPedido | null {
  const dados = abrirToken(pepper, 'sessao', empresaId, token, Date.now());
  return dados && { empresaId, clienteId: dados.id, expiraEm: dados.expiraEm, canal: dados.canal, contato: dados.contato };
}

export async function lerSessaoMeuPedido(tx: DbExecutor, empresaId: string, token: string | undefined, pepper: string): Promise<SessaoMeuPedido | null> {
  const sessao = abrirSessaoMeuPedido(empresaId, token, pepper);
  if (!sessao || !await contatoConfere(tx, empresaId, sessao.clienteId, sessao, pepper)) return null;
  return sessao;
}

export function exigirSessaoMeuPedido(sessao: SessaoMeuPedido | null, empresaId: string) {
  if (!sessao || sessao.empresaId !== empresaId || sessao.expiraEm <= Date.now())
    throw new PacoteAdminError('SESSAO_ENCERRADA', 'Sua sessão terminou. Entre novamente.', 401);
  return sessao;
}

export async function travarContatoDaSessao(tx: DbExecutor, sessao: SessaoMeuPedido, pepper: string) {
  // Depois da trava do pedido, lê a revisão atual do contato e impede alterações até o commit.
  const valido = await contatoConfere(tx, sessao.empresaId, sessao.clienteId, sessao, pepper, true);
  exigirSessaoMeuPedido(valido ? sessao : null, sessao.empresaId);
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
  pepper: string) {
  let id: string = randomUUID();
  let vinculo: Vinculo = { canal: canal === 'WHATSAPP' ? 'w' : 'e', contato: randomBytes(32).toString('base64url') };
  const entregas = new Map<string, Vinculo>();
  const expiraEm = Date.now() + TTL_DESAFIO_MS;
  try {
    const identidade = criarIdentityServiceComAmbiente(async entrega => {
      const canalEntregue = entrega.canal === 'WHATSAPP' ? 'w' : 'e';
      const cliente = await lerContato(tx, empresaId, entrega.validacaoId, canalEntregue, 'validacao');
      if (!cliente?.destino || cliente.destino.trim() !== entrega.destino.trim())
        throw new Error('Contato do cadastro alterado antes do envio.');
      const enviado = await enviarOtpComAmbiente(entrega);
      entregas.set(entrega.validacaoId, {
        canal: canalEntregue, contato: assinaturaDoContato(pepper, empresaId, canalEntregue, cliente),
      });
      return enviado;
    }, { otpTtlMs: TTL_DESAFIO_MS });
    const desafio = await identidade.iniciarDesafio({
      cpf, canal, escopo: { empresaId, incluirLegadoSemEmpresa: false },
    }, tx);
    const entrega = entregas.get(desafio.validacaoId);
    if (!entrega) throw new Error('Desafio sem vínculo de entrega.');
    id = desafio.validacaoId;
    vinculo = entrega;
  } catch (error) {
    if (!isIdentityServiceError(error) || !['CLIENTE_NAO_ENCONTRADO', 'CANAL_INDISPONIVEL', 'FALHA_ENVIO_OTP', 'LIMITE_ENVIOS_OTP'].includes(error.code)) throw error;
  }
  // Não consulta se há pedidos. O ticket fictício tem o mesmo formato e a mesma expiração do real.
  return { desafio: selarToken(pepper, 'desafio', { empresaId, id, expiraEm, ...vinculo }), expiraEm: new Date(expiraEm) };
}

export async function confirmarEntradaMeuPedido(tx: DbExecutor, empresaId: string, desafio: string, codigo: string,
  pepper: string) {
  const dados = abrirToken(pepper, 'desafio', empresaId, desafio, Date.now());
  if (!dados) return null;
  try {
    const identidade = criarIdentityServiceComAmbiente(enviarOtpComAmbiente, { otpTtlMs: TTL_DESAFIO_MS });
    // A prova fica no servidor. O ticket opaco também protege o id do desafio da confirmação genérica.
    const prova = await identidade.confirmarCodigo({ validacaoId: dados.id, codigo }, tx);
    const titular = await identidade.resolverClientePorProva(prova.provaToken, tx);
    if (!await contatoConfere(tx, empresaId, titular.clienteId, dados, pepper)) return null;
    return selarToken(pepper, 'sessao', {
      empresaId, id: titular.clienteId, expiraEm: Date.now() + TTL_SESSAO_PEDIDO_MS, canal: dados.canal, contato: dados.contato,
    });
  } catch (error) {
    if (isIdentityServiceError(error) && error.httpStatus < 500) return null;
    throw error;
  }
}

export function cpfEntradaPedido(cpf: string) {
  return classificarDocumentoIdentidade(cpf)?.tipo === 'CPF';
}
