import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import type { PagamentoServiceContext } from "../pagamentos/services/models.ts";
import { registrarRecebimentoPagamento } from "../pagamentos/services/pagamento.service.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import { centavosDe, liquidoCentavos, type FormaFinanceira } from "./calculos.ts";
import { chaveNoTenant, centavosDaTaxaGravada, mesmaBaixa } from "./idempotencia.ts";
import { auditarRecebimento, prepararBaixa } from "./servico.ts";

export type PedidoBaixa = {
  parcelaId: string;
  valor: number;
  data: string;
  forma: FormaFinanceira;
  taxa?: number;
  observacao?: string;
  chave: string;
};

function recusar(code: string, message: string, status: number): never {
  throw new PacoteAdminError(code, message, status);
}

type LinhaChave = {
  empresa_id: string | null;
  bruto: string;
  meio: string;
  metadata: { forma?: string; taxaCentavos?: number } | null;
  parcela_id: string | null;
  alocado: string | null;
  data: string | null;
  observacao: string | null;
};

/** A chave é consultada no escopo da empresa, antes do saldo. */
export async function repetirBaixa(tx: DbExecutor, empresaId: string, input: PedidoBaixa) {
  const linhas = await tx.query<LinhaChave>(
    `SELECT pac.empresa_id::text AS empresa_id, rec.valor_bruto::text AS bruto, rec.meio_pagamento AS meio,
            rec.metadata_provedor AS metadata, aloc.parcela_id::text AS parcela_id, aloc.valor_alocado::text AS alocado,
            to_char(rec.recebido_em AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS data, rec.observacoes AS observacao
       FROM pagamento_recebimentos rec
       LEFT JOIN pagamento_recebimento_alocacoes aloc ON aloc.recebimento_id = rec.id
       LEFT JOIN pagamentos pag ON pag.id = rec.pagamento_id
       LEFT JOIN contrato_versoes ver ON ver.id = pag.contrato_versao_id
       LEFT JOIN contratos contrato ON contrato.id = ver.contrato_id
       LEFT JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       LEFT JOIN pacotes pac ON pac.id = fech.pacote_id
      WHERE rec.chave_idempotencia = $1`,
    [chaveNoTenant(empresaId, "recebimento", input.chave)],
  );
  if (!linhas.rowCount) return null;
  if (linhas.rows.some((linha) => linha.empresa_id !== empresaId)) {
    recusar("IDEMPOTENCIA_CONFLITANTE", "Esta chave não pode ser reutilizada.", 409);
  }
  const primeira = linhas.rows[0];
  const bruto = centavosDe(primeira.bruto);
  const taxa = centavosDaTaxaGravada(primeira.metadata?.taxaCentavos);
  const mesma = mesmaBaixa({
    brutoCentavos: bruto,
    meio: primeira.meio,
    forma: primeira.metadata?.forma ?? null,
    taxaCentavos: taxa,
    parcelaId: primeira.parcela_id,
    alocadoCentavos: primeira.alocado == null ? null : centavosDe(primeira.alocado),
    data: primeira.data,
    observacao: primeira.observacao,
    alocacoes: linhas.rows.length,
  }, input);
  if (!mesma || taxa == null) recusar("IDEMPOTENCIA_CONFLITANTE", "Esta chave já registrou outro recebimento nesta empresa.", 409);
  return { reutilizado: true as const, liquidoCentavos: liquidoCentavos(bruto, taxa) };
}

/** Recebimento, alocação e auditoria usam o executor do tenant. A revalidação fica no commit dessa transação. */
export async function baixarRecebimentoNoTenant(
  tx: DbExecutor,
  tenant: TenantComprovado,
  input: PedidoBaixa,
  context: Omit<PagamentoServiceContext, "executor" | "aoConfirmar">,
) {
  const repetida = await repetirBaixa(tx, tenant.empresaComprovada, input);
  if (repetida) return repetida;
  const baixa = await prepararBaixa(tx, tenant.empresaComprovada, input);
  const resultado = await registrarRecebimentoPagamento({
    pagamentoId: baixa.pagamentoId,
    meioPagamento: baixa.meio,
    valorBruto: baixa.valorReais,
    recebidoEm: `${input.data}T00:00:00.000Z`,
    chaveIdempotencia: chaveNoTenant(tenant.empresaComprovada, "recebimento", input.chave),
    observacoes: input.observacao ?? null,
    metadataProvedor: { forma: input.forma, taxaCentavos: baixa.taxa },
    confirmarAgora: true,
    alocacoes: [{ parcelaId: baixa.parcelaId, valor: baixa.valorReais }],
  }, {
    ...context,
    executor: tx,
    aoConfirmar: async (txConfirmar) => {
      await auditarRecebimento(txConfirmar, tenant.empresaComprovada, tenant.usuarioId, baixa.parcelaId, baixa.valorReais);
    },
  });
  return { reutilizado: resultado.reutilizado, liquidoCentavos: baixa.liquidoCentavos };
}
