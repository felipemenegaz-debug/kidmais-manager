import type { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  leituraPermitida, lerCorpoJson, limitarRotaPublicaNoBanco, origemPublicaValida, pepperIdentidade, responderArea,
} from '../area-familia/http.ts';
import { LIMITES } from '../area-familia/limites.ts';
import { codigoEmpresaDoPedido, escopoCotacaoPublica } from '../comercial/cotacao-publica.ts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { db } from '../db/postgres.ts';
import { isAvailabilityServiceError } from '../disponibilidade/services/errors.ts';
import { limitarPublico, respostaRecusaPublica, type GrupoLimite } from '../http/limite-publico.ts';
import { isIdentityServiceError } from '../identidade/services/errors.ts';
import { abrirSessaoMeuPedido, exigirSessaoMeuPedido, nomeCookiePedido } from './acesso-pedido.ts';
import { exigirSchemaMeuPedido } from './meu-pedido.ts';

type Contexto = { empresaId: string; pepper: string };

export async function rotaMeuPedido(request: NextRequest, executar: (contexto: Contexto) => Promise<Response>,
  grupo: GrupoLimite | 'CONFIRMAR_IDENTIDADE' = 'LEITURA') {
  try {
    const leitura = request.method === 'GET';
    if (!(leitura ? leituraPermitida(request) : origemPublicaValida(request)))
      throw new PacoteAdminError('ORIGEM_RECUSADA', 'Origem recusada.', 403);
    const limite = await limitarPublico(request, grupo === 'CONFIRMAR_IDENTIDADE' ? 'LEITURA' : grupo);
    if (limite) return limite;
    if (grupo === 'CONFIRMAR_IDENTIDADE') {
      const recusa = await limitarRotaPublicaNoBanco(request, LIMITES.IDENTIDADE_CONFIRMAR_ORIGEM, 'identidade:confirmar');
      if (recusa) return recusa;
    }
    await exigirSchemaMeuPedido(db());
    const { empresaId } = await escopoCotacaoPublica(db, codigoEmpresaDoPedido(request.nextUrl), { acompanharPedido: true });
    const pepper = pepperIdentidade();
    if (!pepper) throw new PacoteAdminError('PRE_RESERVA_INDISPONIVEL', 'Meu pedido está indisponível no momento.', 503);
    return await executar({ empresaId, pepper });
  } catch (error) {
    if (error instanceof PacoteAdminError)
      return responderArea({ ok: false, codigo: error.code, erro: error.message }, error.httpStatus);
    if (isAvailabilityServiceError(error)) return respostaRecusaPublica(error);
    if (isIdentityServiceError(error) && error.httpStatus < 500)
      return responderArea({ ok: false, codigo: error.code, erro: error.message }, error.httpStatus);
    // Provedor e PostgreSQL podem trazer identificadores ou valores no objeto de erro.
    console.error('[Meu pedido] falha na rota pública:', error instanceof Error ? error.name : 'erro');
    return responderArea({ ok: false, codigo: 'PRE_RESERVA_INDISPONIVEL', erro: 'Meu pedido está indisponível no momento.' }, 503);
  }
}

export function abrirSessaoDaRequisicao(request: NextRequest, { empresaId, pepper }: Contexto) {
  const token = request.cookies.get(nomeCookiePedido(empresaId))?.value;
  return exigirSessaoMeuPedido(abrirSessaoMeuPedido(empresaId, token, pepper), empresaId);
}

export async function corpoMeuPedido<T>(request: NextRequest, schema: z.ZodType<T>) {
  const dados = schema.safeParse(await lerCorpoJson(request));
  if (!dados.success) throw new PacoteAdminError('DADOS_INVALIDOS', 'Confira os dados enviados.', 400);
  return dados.data;
}

export function idDoPedido(id: string) {
  const resultado = z.uuid().safeParse(id);
  if (!resultado.success) throw new PacoteAdminError('PEDIDO_INDISPONIVEL', 'Pedido não encontrado.', 404);
  return resultado.data;
}
