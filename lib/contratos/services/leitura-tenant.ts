import { versaoAssinadaEmPapel } from "../assinatura-papel.ts";
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
  /** Versão vigente é a conferência de contrato assinado em papel (061): não há assinatura eletrônica a esperar. */
  assinadoEmPapel?: boolean;
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
    id: string; status: string; cancelado_em: string | null; numero_versao: number | null; snapshot: Snapshot | null; em_preparacao: boolean; versao_id: string | null; aceite_metodo: string | null;
  }>(
    `SELECT contrato.id::text AS id, contrato.status, contrato.cancelado_em::text AS cancelado_em,
            ver.numero_versao, ver.snapshot, ver.id::text AS versao_id, ver.aceite_metodo,
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
    assinadoEmPapel: versaoAssinadaEmPapel({ aceite_metodo: linha.aceite_metodo, snapshot: linha.snapshot }),
    canceladoEm: linha.cancelado_em,
  };
}

/**
 * Relações de um contrato (AI V1.1, PR 4): contrato → cliente (fechamento.cliente_id) e contrato → festa ativa
 * (festas.contrato_id, quando existir). Mesmo predicado de tenant: outra empresa ⇒ null (inexistente).
 */
export type RelacoesContrato = {
  contratoId: string;
  status: string;
  versaoVigente: number | null;
  dataEvento: string | null;
  clienteId: string | null;
  cliente: string | null;
  festaId: string | null;
};

export async function relacoesContratoDoTenant(tx: DbExecutor, empresaId: string, contratoId: string): Promise<RelacoesContrato | null> {
  const linha = (await tx.query<{
    id: string; status: string; numero_versao: number | null; data: string | null; cliente_id: string | null; cliente: string | null; festa_id: string | null;
  }>(
    `SELECT contrato.id::text AS id, contrato.status, ver.numero_versao, fech.data_evento::text AS data,
            cliente.id::text AS cliente_id, cliente.nome_completo AS cliente,
            (SELECT festa.id::text FROM festas festa WHERE festa.contrato_id = contrato.id AND festa.invalidada_em IS NULL LIMIT 1) AS festa_id
       FROM contratos contrato
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $2::uuid
       LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id
       LEFT JOIN contrato_fluxos fluxo ON fluxo.contrato_id = contrato.id
       LEFT JOIN contrato_versoes ver ON ver.id = fluxo.versao_vigente_id
      WHERE contrato.id = $1::uuid`,
    [contratoId, empresaId],
  )).rows[0];
  if (!linha) return null;
  return {
    contratoId: linha.id,
    status: linha.status,
    versaoVigente: linha.numero_versao == null ? null : Number(linha.numero_versao),
    dataEvento: linha.data,
    clienteId: linha.cliente_id,
    cliente: linha.cliente,
    festaId: linha.festa_id,
  };
}

/**
 * Contratos mais recentes (AI V1.1, PR 5.5). "Último" = critério do próprio domínio: o painel de Contratos
 * (`listarContratosDoTenant`) ordena por `contratos.criado_em DESC` e, por padrão, esconde os cancelados e as
 * preparações canceladas. Mesmo filtro e mesma ordem aqui, com desempate por id e o instante de criação devolvido
 * para detectar empate. Empresa comprovada no predicado (fechamento e pacote da empresa).
 */
export type ContratoRecente = {
  contratoId: string;
  status: string;
  criadoEm: string;
  cliente: string | null;
  clienteId: string | null;
  dataEvento: string | null;
  festaId: string | null;
};

export async function ultimosContratosDoTenant(
  tx: DbExecutor,
  empresaId: string,
  filtro: { limite: number; incluirCancelados?: boolean },
): Promise<ContratoRecente[]> {
  const r = await tx.query<{ id: string; status: string; criado_em: string; cliente: string | null; cliente_id: string | null; data: string | null; festa_id: string | null }>(
    `SELECT c.id::text AS id, c.status, c.criado_em::text AS criado_em,
            cliente.nome_completo AS cliente, cliente.id::text AS cliente_id, fech.data_evento::text AS data,
            (SELECT festa.id::text FROM festas festa WHERE festa.contrato_id = c.id AND festa.invalidada_em IS NULL LIMIT 1) AS festa_id
       FROM contratos c
       JOIN fechamentos fech ON fech.id = c.fechamento_id AND fech.empresa_id = $2::uuid
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $2::uuid
       LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id
       LEFT JOIN contrato_versoes v ON v.contrato_id = c.id AND v.numero_versao = c.versao_atual
       LEFT JOIN contrato_edicoes e ON e.contrato_versao_id = v.id
      WHERE ($1::boolean OR (c.status <> 'CANCELADO' AND (e.estado IS DISTINCT FROM 'CANCELADA' OR c.status = 'ASSINADO')))
      ORDER BY c.criado_em DESC, c.id DESC
      LIMIT $3`,
    [filtro.incluirCancelados === true, empresaId, Math.max(1, Math.min(filtro.limite, 20))],
  );
  return r.rows.map((l) => ({ contratoId: l.id, status: l.status, criadoEm: l.criado_em, cliente: l.cliente, clienteId: l.cliente_id, dataEvento: l.data, festaId: l.festa_id }));
}
