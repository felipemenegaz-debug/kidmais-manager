import type { DbExecutor } from '../db/contracts.ts';
import { criarIdentityServiceComAmbiente } from '../identidade/services/identity.service';
import { enviarOtpComAmbiente } from '../identidade/delivery';
import { travarConfiguracaoAgenda } from '../agenda/trava-configuracao.ts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { encerrarGarantia } from './destinacao.ts';

export async function desistirDaGarantia(tx: DbExecutor, empresa: string, pedido: string, provaToken: string) {
  const identidade = criarIdentityServiceComAmbiente(enviarOtpComAmbiente);
  const titular = await identidade.resolverClientePorProva(provaToken, tx, 'FECHAMENTO_PUBLICO');
  await travarConfiguracaoAgenda(tx, empresa, { modo: 'COMPARTILHADA', linha: 'KEY_SHARE' });
  const alvo = await tx.query(`SELECT id FROM fechamentos WHERE empresa_id=$1 AND id=$2 AND cliente_id=$3
    AND status='AGUARDANDO_CONTRATO' FOR UPDATE`,[empresa,pedido,titular.clienteId]);
  if (!alvo.rows.length) throw new PacoteAdminError('PEDIDO_INDISPONIVEL','Pedido indisponível para desistência.',404);
  if (!await encerrarGarantia(tx, empresa, pedido, 'DESISTENCIA'))
    throw new PacoteAdminError('GARANTIA_INDISPONIVEL','A garantia já foi encerrada ou não existe.',409);
  await identidade.consumirProvaParaFechamento(provaToken, pedido, tx);
}
