import type { DbExecutor } from '../db/contracts.ts';
import { criarIdentityServiceComAmbiente } from '../identidade/services/identity.service';
import { enviarOtpComAmbiente } from '../identidade/delivery';
import { travarConfiguracaoAgenda } from '../agenda/trava-configuracao.ts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { encerrarGarantia } from './destinacao.ts';
import { auditarMovimentoPreReserva } from './auditoria.ts';
import { exigirSessaoMeuPedido, travarContatoDaSessao, type SessaoMeuPedido } from './acesso-pedido.ts';

export async function desistirDaGarantia(tx: DbExecutor, empresa: string, pedido: string,
  acesso: { sessao: SessaoMeuPedido; pepper: string } | string) {
  const legado = typeof acesso === 'string';
  const identidade = legado ? criarIdentityServiceComAmbiente(enviarOtpComAmbiente) : null;
  const titular = legado ? await identidade!.resolverClientePorProva(acesso, tx, 'FECHAMENTO_PUBLICO')
    : exigirSessaoMeuPedido(acesso.sessao, empresa);
  await travarConfiguracaoAgenda(tx, empresa, { modo: 'COMPARTILHADA', linha: 'KEY_SHARE' });
  const { rows: [alvo] } = await tx.query<{ status: string }>(`SELECT status FROM fechamentos
    WHERE empresa_id=$1 AND id=$2 AND cliente_id=$3 FOR UPDATE`, [empresa,pedido,titular.clienteId]);
  if (!legado) await travarContatoDaSessao(tx, acesso.sessao, acesso.pepper);
  if (!alvo || (legado && alvo.status !== 'AGUARDANDO_CONTRATO'))
    throw new PacoteAdminError('PEDIDO_INDISPONIVEL','Pedido indisponível para desistência.',404);

  const instante = alvo.status === 'AGUARDANDO_CONTRATO'
    ? await encerrarGarantia(tx, empresa, pedido, 'DESISTENCIA', !legado) : null;
  if (!instante) {
    if (legado) throw new PacoteAdminError('GARANTIA_INDISPONIVEL','A garantia já foi encerrada ou não existe.',409);
    return;
  }
  if (legado) await identidade!.consumirProvaParaFechamento(acesso, pedido, tx);
  await auditarMovimentoPreReserva(tx, titular, 'PRE_RESERVA_DESISTENCIA', empresa, pedido, 'DESISTENCIA', instante);
}
