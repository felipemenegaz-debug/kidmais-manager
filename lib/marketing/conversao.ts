import type { DbExecutor } from '../db/contracts.ts';
import { executarAcaoContato } from './contatos.ts';
import { MarketingError } from './erros.ts';

/**
 * Participa da transação que criou a negociação. Empresa, cliente e autor vêm da negociação persistida.
 * Sem a 085, o fluxo comercial legado continua disponível. Não reconstitui vínculos históricos.
 */
export async function vincularContatoAutomaticamente(tx: DbExecutor, fechamentoId: string) {
  // Fora do catch: uma transação já abortada (ou sem BEGIN) não é falha do Marketing.
  await tx.query('SAVEPOINT marketing_conversao_automatica');
  try {
    await vincularContatoNaTransacao(tx, fechamentoId);
  } catch (erro) {
    // Se a recuperação falhar, o erro continua para o dono da transação; não se pode seguir vendendo nela.
    await tx.query('ROLLBACK TO SAVEPOINT marketing_conversao_automatica');
    await tx.query('RELEASE SAVEPOINT marketing_conversao_automatica');
    const code = (erro as { code?: unknown } | null)?.code;
    // Falhas de conexão/transação e de serialização exigem tratamento pelo dono da transação inteira.
    if (typeof code === 'string' && /^(08|25|2D|3B|40)/.test(code)) throw erro;
    const codigo = erro instanceof MarketingError ? erro.code
      : typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'MARKETING_VINCULO_FALHOU';
    console.error('[Marketing] vínculo automático não concluído', { fechamentoId, codigo });
    return;
  }
  // Falha ao liberar o SAVEPOINT também não é tratada como falha do vínculo.
  await tx.query('RELEASE SAVEPOINT marketing_conversao_automatica');
}

async function vincularContatoNaTransacao(tx: DbExecutor, fechamentoId: string) {
  const schema = await tx.query<{ disponivel: boolean }>(
    "SELECT to_regclass('public.marketing_contatos') IS NOT NULL AS disponivel",
  );
  if (!schema.rows[0]?.disponivel) return;
  // Mantida até o COMMIT no sucesso. O rollback parcial libera apenas as travas tomadas após o SAVEPOINT.
  // NO KEY UPDATE serializa vínculos do mesmo cliente sem conflitar com o KEY SHARE das FKs.
  const origem = await tx.query<{ empresa_id: string; cliente_id: string; usuario_id: string | null; origem_fechamento: string }>(
    `SELECT f.empresa_id::text, f.cliente_id::text, f.iniciado_por_usuario_id::text AS usuario_id, f.origem_fechamento
       FROM fechamentos f JOIN clientes c ON c.id = f.cliente_id AND c.empresa_id = f.empresa_id
      WHERE f.id = $1::uuid FOR NO KEY UPDATE OF c`, [fechamentoId],
  );
  const f = origem.rows[0];
  if (!f) return;
  const contato = await tx.query<{ id: string }>(
    `SELECT k.id::text FROM marketing_contatos k
      WHERE k.empresa_id = $1::uuid AND k.cliente_id = $2::uuid
        AND k.status IN ('NOVO', 'EM_ATENDIMENTO') AND k.fechamento_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM marketing_contatos vinculado
                         WHERE vinculado.empresa_id = $1::uuid AND vinculado.fechamento_id = $3::uuid)
      ORDER BY k.recebido_em DESC, k.id DESC LIMIT 1 FOR UPDATE OF k`,
    [f.empresa_id, f.cliente_id, fechamentoId],
  );
  if (!contato.rows[0]) return;
  // Mesmo vínculo, herança e histórico do botão manual; falha desfaz só este vínculo pelo SAVEPOINT acima.
  const publico = f.origem_fechamento === 'CLIENTE';
  await executarAcaoContato(tx, f.empresa_id, publico ? null : f.usuario_id, {
    acao: 'vincular-negociacao', id: contato.rows[0].id, fechamentoId,
  }, { origemVinculo: publico ? 'FECHAMENTO_PUBLICO' : 'CRM_INTERNO' });
}
