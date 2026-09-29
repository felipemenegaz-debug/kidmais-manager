import type { DbExecutor } from "../../db/contracts.ts";

/**
 * Leituras de contrato escopadas pela empresa comprovada, somente leitura.
 *
 * Mesmo predicado de tenant do Dashboard (`painelGeral`): contrato → fechamento → pacote da empresa.
 * As rotas administrativas de contrato provam o tenant por `contrato-tenant.ts`, `exportacao-tenant.ts`,
 * `resumo-tenant.ts` ou `contratoDoTenant`/`versaoDoTenant` (mapa em docs/INTELIGENCIA_PRODUCAO_V1.md,
 * seção 8). Estas funções não as substituem nem as reutilizam.
 * Não devolvem CPF, RG, telefone, e-mail, endereço, hash, token nem comprovante.
 */
export type ContratoPendente = {
  contratoId: string;
  dataEvento: string;
  pacote: string;
  cliente: string;
  criadoEm: string;
};

export async function contratosAguardandoAssinatura(tx: DbExecutor, empresaId: string, limite = 20) {
  const total = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM contratos contrato
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
      WHERE contrato.status = 'AGUARDANDO_ASSINATURA'`,
    [empresaId],
  );
  const lista = await tx.query<{ id: string; data: string; pacote: string; cliente: string; criado_em: string }>(
    `SELECT contrato.id::text AS id, fech.data_evento::text AS data, pac.nome AS pacote,
            COALESCE(cliente.nome_completo, 'Cliente') AS cliente, contrato.criado_em::text AS criado_em
       FROM contratos contrato
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
       LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id
      WHERE contrato.status = 'AGUARDANDO_ASSINATURA'
      ORDER BY fech.data_evento, contrato.criado_em
      LIMIT $2`,
    [empresaId, Math.max(1, Math.min(limite, 100))],
  );
  return {
    total: Number(total.rows[0]?.n ?? 0),
    contratos: lista.rows.map((linha): ContratoPendente => ({
      contratoId: linha.id,
      dataEvento: linha.data,
      pacote: linha.pacote,
      cliente: linha.cliente,
      criadoEm: linha.criado_em,
    })),
  };
}

export type ResumoContratoTenant = {
  contratoId: string;
  status: string;
  versaoVigente: number | null;
  versaoEmPreparacao: boolean;
  dataEvento: string | null;
  horarioInicio: string | null;
  horarioFim: string | null;
  pacote: string | null;
  convidados: number | null;
  valorFinalContrato: number | null;
  formaPagamento: string | null;
  buffetStatus: string | null;
  assinaturas: string[];
  canceladoEm: string | null;
};

type Snapshot = {
  evento?: { data?: string; horarioInicio?: string; horarioFim?: string; convidados?: number; pacote?: { nome?: string } };
  comercial?: { valorFinalContrato?: number; formaPagamentoPretendida?: string; condicaoPagamento?: { forma?: string } | null };
  contratacao?: { buffet?: { status?: string } };
};

/** null quando o contrato não existe ou não pertence à empresa: as duas situações respondem igual. */
export async function resumoContratoDoTenant(tx: DbExecutor, empresaId: string, contratoId: string): Promise<ResumoContratoTenant | null> {
  const linha = (await tx.query<{
    id: string; status: string; cancelado_em: string | null; numero_versao: number | null; snapshot: Snapshot | null; em_preparacao: boolean; versao_id: string | null;
  }>(
    `SELECT contrato.id::text AS id, contrato.status, contrato.cancelado_em::text AS cancelado_em,
            ver.numero_versao, ver.snapshot, ver.id::text AS versao_id,
            (fluxo.versao_em_preparacao_id IS NOT NULL) AS em_preparacao
       FROM contratos contrato
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $2::uuid
       LEFT JOIN contrato_fluxos fluxo ON fluxo.contrato_id = contrato.id
       LEFT JOIN contrato_versoes ver ON ver.id = fluxo.versao_vigente_id
      WHERE contrato.id = $1::uuid`,
    [contratoId, empresaId],
  )).rows[0];
  if (!linha) return null;
  const assinaturas = linha.versao_id
    ? (await tx.query<{ parte: string }>(
      `SELECT DISTINCT parte FROM contrato_assinaturas WHERE contrato_versao_id = $1::uuid ORDER BY parte`,
      [linha.versao_id],
    )).rows.map((a) => a.parte)
    : [];
  const s = linha.snapshot ?? {};
  const valor = s.comercial?.valorFinalContrato;
  return {
    contratoId: linha.id,
    status: linha.status,
    versaoVigente: linha.numero_versao == null ? null : Number(linha.numero_versao),
    versaoEmPreparacao: Boolean(linha.em_preparacao),
    dataEvento: s.evento?.data ?? null,
    horarioInicio: s.evento?.horarioInicio?.slice(0, 5) ?? null,
    horarioFim: s.evento?.horarioFim?.slice(0, 5) ?? null,
    pacote: s.evento?.pacote?.nome ?? null,
    convidados: typeof s.evento?.convidados === "number" ? s.evento.convidados : null,
    valorFinalContrato: typeof valor === "number" && Number.isFinite(valor) ? valor : null,
    formaPagamento: s.comercial?.condicaoPagamento?.forma ?? s.comercial?.formaPagamentoPretendida ?? null,
    buffetStatus: s.contratacao?.buffet?.status ?? null,
    assinaturas,
    canceladoEm: linha.cancelado_em,
  };
}
