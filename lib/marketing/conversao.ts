import type { DbExecutor } from '../db/contracts.ts';
import { MarketingError, naoEncontrado } from './erros.ts';
import { atribuicaoVigente, registrarSeAusente } from './atribuicao.ts';
import { registrarEventoHistorico } from '../clientes/repositories/historico.repository.ts';
import { herdarAcoesDoContato } from '../oportunidades/conversao.ts';

export type OrigemVinculo = 'CRM_INTERNO' | 'FECHAMENTO_PUBLICO';

/**
 * Wall-e 1a (r5/r6): cartão do Wall-e anonimizado a pedido do titular é só leitura em TODO caminho que grava nele (ações do
 * contato, Oportunidades, vínculo com negociação). Chamar com a linha do contato já travada (FOR UPDATE), antes de resolver
 * ou criar cliente: vincular de novo o ligaria a alguém, e a próxima exclusão (que só alcança vínculos ainda não
 * anonimizados) não o limparia. Sem a 132, não há cartão anonimizado.
 */
export async function exigirContatoNaoAnonimizado(tx: DbExecutor, contatoId: string) {
  if ((await tx.query<{ ok: boolean }>("SELECT to_regclass('public.whatsapp_atendimento_oportunidades') IS NOT NULL AS ok")).rows[0]?.ok
    && (await tx.query("SELECT 1 FROM whatsapp_atendimento_oportunidades WHERE contato_id = $1::uuid AND anonimizado_em IS NOT NULL", [contatoId])).rows.length)
    throw new MarketingError("MARKETING_CONTATO_ANONIMIZADO", "Este contato foi anonimizado a pedido do titular e não pode ser alterado.", 409);
}

/**
 * Implementação única do vínculo contato → negociação e da herança de origem e campanha, na transação do chamador.
 * Usada pelo botão manual, pela conversão automática e pela transferência de ações do Funil.
 * Repetição do mesmo par não escreve e não devolve 409.
 */
export async function vincularContatoNegociacao(
  tx: DbExecutor, empresaId: string, usuarioId: string | null, acao: { id: string; fechamentoId: string },
  contexto: { origemVinculo?: OrigemVinculo } = {},
) {
  const contato = (await tx.query<{ cliente_id: string | null; fechamento_id: string | null }>(
    'SELECT cliente_id::text,fechamento_id::text FROM marketing_contatos WHERE empresa_id=$1::uuid AND id=$2::uuid FOR UPDATE', [empresaId, acao.id])).rows[0];
  if (!contato) naoEncontrado('Contato não encontrado nesta empresa.');
  await exigirContatoNaoAnonimizado(tx, acao.id);
  // vincular-negociacao: a negociação herda a origem do contato (se ainda não tiver uma). Contrato herda da negociação.
  if (contato.fechamento_id && contato.fechamento_id !== acao.fechamentoId) throw new MarketingError("MARKETING_CONTATO_CONVERTIDO", "Contato já vinculado a uma negociação.", 409);
  if (!contato.cliente_id) throw new MarketingError("MARKETING_CONTATO_SEM_CLIENTE", "Vincule o contato a um cliente antes da negociação.", 409);
  const fechamento = await tx.query<{ id: string }>(
    `SELECT id::text FROM fechamentos WHERE id = $1::uuid AND empresa_id = $2::uuid AND cliente_id = $3::uuid`,
    [acao.fechamentoId, empresaId, contato.cliente_id],
  );
  if (fechamento.rows.length !== 1) throw new MarketingError("MARKETING_NAO_ENCONTRADO", "Negociação não encontrada para este cliente.", 404);
  if (contato.fechamento_id === acao.fechamentoId) return { id: acao.id, origemNegociacaoExistente: true };
  try {
    await tx.query(
      `UPDATE marketing_contatos SET fechamento_id = $2::uuid, status = 'CONVERTIDO', atualizado_por = $3::uuid, atualizado_em = clock_timestamp() WHERE id = $1::uuid`,
      [acao.id, acao.fechamentoId, usuarioId],
    );
  } catch (error) {
    if ((error as { constraint?: string }).constraint === "marketing_contatos_fechamento_uk") {
      throw new MarketingError("MARKETING_NEGOCIACAO_JA_VINCULADA", "Esta negociação já está vinculada a outro contato.", 409);
    }
    throw error;
  }
  const origemContato = await atribuicaoVigente(tx, empresaId, "CONTATO", acao.id);
  const herdada = origemContato ? await registrarSeAusente(tx, empresaId, {
    alvoTipo: "FECHAMENTO", alvoId: acao.fechamentoId,
    origemCodigo: origemContato.origemCodigo, canalAtendimento: origemContato.canalAtendimento, campanhaId: origemContato.campanhaId,
    metodo: origemContato.metodo === "DESCONHECIDO" ? "DESCONHECIDO" : "HERDADO", detalhe: origemContato.detalhe, utm: origemContato.utm,
    contatoId: acao.id, registradoPor: usuarioId,
  }) : null;
  await registrarEventoHistorico({
    clienteId: contato.cliente_id, tipoEvento: "CONTATO_MARKETING_NEGOCIACAO", origem: contexto.origemVinculo ?? "CRM_INTERNO", entidadeTipo: "FECHAMENTO", entidadeId: acao.fechamentoId,
    usuarioId, metadata: { contatoMarketingId: acao.id, origemHerdada: Boolean(herdada) },
  }, tx);
  return { id: acao.id, origemNegociacaoExistente: !herdada };
}

/**
 * Participa da transação que criou a negociação. Empresa, cliente e autor vêm da negociação persistida.
 * Tudo ou nada dentro do SAVEPOINT: herança de origem e campanha, contato convertido, transferência da próxima ação
 * e regra do responsável. Falha do Marketing não derruba a venda: desfaz só o SAVEPOINT, o contato continua como
 * estava (pode ser vinculado depois pelo botão, que é idempotente) e a falha fica no log e no histórico do cliente.
 * Sem a 085, o fluxo comercial legado continua disponível. Não reconstitui vínculos históricos.
 */
export async function vincularContatoAutomaticamente(tx: DbExecutor, fechamentoId: string) {
  // Fora do catch: uma transação já abortada (ou sem BEGIN) não é falha do Marketing.
  await tx.query('SAVEPOINT marketing_conversao_automatica');
  try {
    await converterNaTransacao(tx, fechamentoId);
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
    await registrarFalhaNoHistorico(tx, fechamentoId, codigo);
    return;
  }
  // Falha ao liberar o SAVEPOINT também não é tratada como falha do vínculo.
  await tx.query('RELEASE SAVEPOINT marketing_conversao_automatica');
}

async function converterNaTransacao(tx: DbExecutor, fechamentoId: string) {
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
  if (contato.rows[0]) {
    // Mesmo vínculo, herança e histórico do botão manual.
    const publico = f.origem_fechamento === 'CLIENTE';
    await vincularContatoNegociacao(tx, f.empresa_id, publico ? null : f.usuario_id, { id: contato.rows[0].id, fechamentoId },
      { origemVinculo: publico ? 'FECHAMENTO_PUBLICO' : 'CRM_INTERNO' });
  }
  // Próxima ação do contato e regra do responsável (Funil); sem a 122, não faz nada.
  await herdarAcoesDoContato(tx, fechamentoId);
}

/** O registro da falha também não pode derrubar a venda: SAVEPOINT próprio; se falhar, fica só o log. */
async function registrarFalhaNoHistorico(tx: DbExecutor, fechamentoId: string, codigo: string) {
  await tx.query('SAVEPOINT marketing_conversao_falha');
  try {
    const f = (await tx.query<{ cliente_id: string | null }>('SELECT cliente_id::text FROM fechamentos WHERE id=$1::uuid', [fechamentoId])).rows[0];
    if (f?.cliente_id) {
      await registrarEventoHistorico({
        clienteId: f.cliente_id, tipoEvento: 'CONTATO_MARKETING_VINCULO_FALHOU', origem: 'SISTEMA', entidadeTipo: 'FECHAMENTO', entidadeId: fechamentoId,
        detalhe: 'O pedido de Marketing não foi vinculado automaticamente a esta negociação. Use "Vincular" no pedido.', metadata: { codigo },
      }, tx);
    }
  } catch (erro) {
    await tx.query('ROLLBACK TO SAVEPOINT marketing_conversao_falha');
    await tx.query('RELEASE SAVEPOINT marketing_conversao_falha');
    const code = (erro as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^(08|25|2D|3B|40)/.test(code)) throw erro;
    console.error('[Marketing] falha do vínculo automático não registrada no histórico', { fechamentoId });
    return;
  }
  await tx.query('RELEASE SAVEPOINT marketing_conversao_falha');
}
