import type { DbExecutor } from "../db/contracts.ts";
import { ORIGEM_DESCONHECIDA } from "./origens.ts";

/**
 * Painel de Marketing — definições (também mostradas na tela; docs/MARKETING_LOCAL_20261014.md):
 *
 * Modelo de atribuição: TOQUE ÚNICO pela origem VIGENTE da negociação (fechamento). Cada contrato conta para no máximo
 * uma campanha/origem; receita nunca é somada a várias campanhas. Contrato sem origem de negociação vai para
 * "Origem não registrada"; origem DESCONHECIDA fica em linha própria. Atribuição é associação registrada, não prova de
 * causa: o painel não mostra retorno sobre investimento.
 *
 * Período (datas em America/Sao_Paulo, inclusivas):
 *   cliques             eventos de clique no período (link de campanha e botão de WhatsApp contados separadamente);
 *   contatos            contatos recebidos no período, pela origem do CONTATO;
 *   negociações         fechamentos iniciados no período, pela origem da negociação;
 *   contratos           contratos ASSINADOS no período (status atual ASSINADO), pela origem da negociação;
 *   cancelamentos       contratos cancelados no período (linha separada; não são descontados de "contratos");
 *   receita contratada  soma do valor contratado vigente dos contratos assinados no período (ajuste contratual > valor do
 *                       pagamento > snapshot da versão), em centavos;
 *   receita recebida    recebimentos CONFIRMADOS no período − estornos CONFIRMADOS no período − devoluções CONCLUÍDAS no
 *                       período, de qualquer contrato, pela origem da negociação do contrato;
 *   conversão           dos contatos RECEBIDOS no período, quantos estão vinculados a negociação com contrato ASSINADO
 *                       hoje ÷ contatos recebidos no período. Sem contato no período: indisponível (null), nunca 0%.
 */
export type FiltroPeriodo = { de: string; ate: string; unidadeId: string | null };

export type LinhaPainel = {
  chave: string;
  campanhaId: string | null;
  campanhaNome: string | null;
  origemCodigo: string | null;
  orcamentoCentavos: number | null;
  cliquesLink: number;
  cliquesWhatsapp: number;
  contatos: number;
  contatosComContrato: number;
  negociacoes: number;
  contratos: number;
  cancelamentos: number;
  receitaContratadaCentavos: number;
  receitaRecebidaCentavos: number;
  conversao: number | null;
};

export type PainelMarketing = {
  periodo: FiltroPeriodo;
  linhas: LinhaPainel[];
  total: LinhaPainel;
  negociacoesSemOrigem: number;
};

const SEM_REGISTRO = "SEM_REGISTRO";

function periodo(coluna: string, de: string, ate: string) {
  return `${coluna} >= (${de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND ${coluna} < ((${ate}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
}

/** Valor contratado vigente em centavos (ajuste > pagamento > snapshot). NULL quando ilegível. */
export const SQL_VALOR_CONTRATADO = `COALESCE(
  (SELECT aj.obrigacao_depois_centavos FROM pagamento_gestoes g JOIN pagamento_ajustes_contratuais aj ON aj.pagamento_id = g.pagamento_id
    WHERE g.contrato_id = ct.id AND NOT EXISTS (SELECT 1 FROM pagamento_ajustes_contratuais n WHERE n.ajuste_anterior_id = aj.id)
    ORDER BY aj.criado_em DESC LIMIT 1),
  (SELECT round(p.valor_total_contratado * 100)::bigint FROM pagamentos p JOIN contrato_versoes v ON v.id = p.contrato_versao_id
    WHERE v.contrato_id = ct.id AND p.status <> 'CANCELADO' ORDER BY v.numero_versao DESC LIMIT 1),
  (SELECT CASE WHEN (v.snapshot->'comercial'->>'valorFinalContrato') ~ '^[0-9]+(\\.[0-9]+)?$'
               THEN round((v.snapshot->'comercial'->>'valorFinalContrato')::numeric * 100)::bigint END
     FROM contrato_versoes v WHERE v.contrato_id = ct.id AND v.status IN ('ASSINADA', 'ATIVA') ORDER BY v.numero_versao DESC LIMIT 1))`;

type Agregado = { campanha_id: string | null; origem_codigo: string | null; n: string; extra?: string | null; valor?: string | null };

export async function painelMarketing(tx: DbExecutor, empresaId: string, filtro: FiltroPeriodo): Promise<PainelMarketing> {
  const p = [empresaId, filtro.de, filtro.ate, filtro.unidadeId];
  const atribFechamento = `LEFT JOIN marketing_atribuicoes a ON a.empresa_id = f.empresa_id AND a.alvo_tipo = 'FECHAMENTO' AND a.alvo_id = f.id AND a.vigente`;

  const cliques = await tx.query<{ campanha_id: string | null; tipo: string; n: string }>(
    `SELECT e.campanha_id::text, e.tipo, count(*)::text AS n
       FROM marketing_eventos e LEFT JOIN marketing_sites s ON s.id = e.site_id AND s.empresa_id = e.empresa_id
      WHERE e.empresa_id = $1::uuid AND ${periodo("e.ocorrido_em", "$2", "$3")}
        AND ($4::uuid IS NULL OR s.estabelecimento_id = $4::uuid)
      GROUP BY e.campanha_id, e.tipo`, p);

  const contatos = await tx.query<Agregado>(
    `SELECT a.campanha_id::text, a.origem_codigo, count(*)::text AS n,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contratos ct WHERE ct.fechamento_id = k.fechamento_id AND ct.status = 'ASSINADO'))::text AS extra
       FROM marketing_contatos k
       LEFT JOIN marketing_atribuicoes a ON a.empresa_id = k.empresa_id AND a.alvo_tipo = 'CONTATO' AND a.alvo_id = k.id AND a.vigente
      WHERE k.empresa_id = $1::uuid AND ${periodo("k.recebido_em", "$2", "$3")}
        AND ($4::uuid IS NULL OR k.estabelecimento_id = $4::uuid)
      GROUP BY a.campanha_id, a.origem_codigo`, p);

  const negociacoes = await tx.query<Agregado>(
    `SELECT a.campanha_id::text, a.origem_codigo, count(*)::text AS n
       FROM fechamentos f ${atribFechamento}
      WHERE f.empresa_id = $1::uuid AND ${periodo("f.iniciado_em", "$2", "$3")}
        AND ($4::uuid IS NULL OR f.estabelecimento_id = $4::uuid)
      GROUP BY a.campanha_id, a.origem_codigo`, p);

  const contratos = await tx.query<Agregado>(
    `SELECT a.campanha_id::text, a.origem_codigo, count(*)::text AS n, COALESCE(sum(${SQL_VALOR_CONTRATADO}), 0)::text AS valor,
            count(*) FILTER (WHERE ${SQL_VALOR_CONTRATADO} IS NULL)::text AS extra
       FROM contratos ct JOIN fechamentos f ON f.id = ct.fechamento_id ${atribFechamento}
      WHERE f.empresa_id = $1::uuid AND ct.status = 'ASSINADO' AND ${periodo("ct.assinado_em", "$2", "$3")}
        AND ($4::uuid IS NULL OR f.estabelecimento_id = $4::uuid)
      GROUP BY a.campanha_id, a.origem_codigo`, p);

  const cancelados = await tx.query<Agregado>(
    `SELECT a.campanha_id::text, a.origem_codigo, count(*)::text AS n
       FROM contratos ct JOIN fechamentos f ON f.id = ct.fechamento_id ${atribFechamento}
      WHERE f.empresa_id = $1::uuid AND ct.status = 'CANCELADO' AND ${periodo("ct.cancelado_em", "$2", "$3")}
        AND ($4::uuid IS NULL OR f.estabelecimento_id = $4::uuid)
      GROUP BY a.campanha_id, a.origem_codigo`, p);

  const recebido = await tx.query<Agregado>(
    `WITH movimentos AS (
       SELECT v.contrato_id, r.valor_bruto * 100 AS centavos
         FROM pagamento_recebimentos r JOIN pagamentos pg ON pg.id = r.pagamento_id JOIN contrato_versoes v ON v.id = pg.contrato_versao_id
        WHERE r.status = 'CONFIRMADO' AND ${periodo("r.recebido_em", "$2", "$3")}
       UNION ALL
       SELECT v.contrato_id, -es.valor * 100
         FROM pagamento_estornos es JOIN pagamento_recebimentos r ON r.id = es.recebimento_id JOIN pagamentos pg ON pg.id = r.pagamento_id
         JOIN contrato_versoes v ON v.id = pg.contrato_versao_id
        WHERE es.status = 'CONFIRMADO' AND ${periodo("es.confirmado_em", "$2", "$3")}
       UNION ALL
       SELECT g.contrato_id, -d.valor_centavos
         FROM pagamento_devolucoes d JOIN pagamento_gestoes g ON g.pagamento_id = d.pagamento_id
        WHERE d.estado = 'CONCLUIDA' AND ${periodo("d.devolvido_em", "$2", "$3")}
     )
     SELECT a.campanha_id::text, a.origem_codigo, count(DISTINCT ct.id)::text AS n, round(sum(m.centavos))::text AS valor
       FROM movimentos m JOIN contratos ct ON ct.id = m.contrato_id JOIN fechamentos f ON f.id = ct.fechamento_id ${atribFechamento}
      WHERE f.empresa_id = $1::uuid AND ($4::uuid IS NULL OR f.estabelecimento_id = $4::uuid)
      GROUP BY a.campanha_id, a.origem_codigo`, p);

  const semOrigem = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM fechamentos f ${atribFechamento}
      WHERE f.empresa_id = $1::uuid AND a.id IS NULL AND ${periodo("f.iniciado_em", "$2", "$3")}
        AND ($4::uuid IS NULL OR f.estabelecimento_id = $4::uuid)`, p);

  const campanhas = await tx.query<{ id: string; nome: string; origem_codigo: string; orcamento_centavos: string | null }>(
    `SELECT id::text, nome, origem_codigo, orcamento_centavos::text FROM marketing_campanhas WHERE empresa_id = $1::uuid`, [empresaId]);

  return montarPainel(filtro, {
    cliques: cliques.rows, contatos: contatos.rows, negociacoes: negociacoes.rows, contratos: contratos.rows, cancelados: cancelados.rows,
    recebido: recebido.rows, campanhas: campanhas.rows, negociacoesSemOrigem: Number(semOrigem.rows[0]?.n ?? 0),
  });
}

function chaveDe(campanhaId: string | null, origem: string | null) {
  if (campanhaId) return `c:${campanhaId}`;
  return `o:${origem ?? SEM_REGISTRO}`;
}

function vazia(chave: string, campanhaId: string | null, origemCodigo: string | null): LinhaPainel {
  return {
    chave, campanhaId, campanhaNome: null, origemCodigo, orcamentoCentavos: null, cliquesLink: 0, cliquesWhatsapp: 0, contatos: 0,
    contatosComContrato: 0, negociacoes: 0, contratos: 0, cancelamentos: 0, receitaContratadaCentavos: 0, receitaRecebidaCentavos: 0, conversao: null,
  };
}

/** Agregação pura (testada sem banco). Linhas sem nenhum número são omitidas, exceto campanhas ativas sem resultado. */
export function montarPainel(
  periodo: FiltroPeriodo,
  dados: {
    cliques: Array<{ campanha_id: string | null; tipo: string; n: string }>;
    contatos: Agregado[]; negociacoes: Agregado[]; contratos: Agregado[]; cancelados: Agregado[]; recebido: Agregado[];
    campanhas: Array<{ id: string; nome: string; origem_codigo: string; orcamento_centavos: string | null }>;
    negociacoesSemOrigem: number;
  },
): PainelMarketing {
  const linhas = new Map<string, LinhaPainel>();
  const linha = (campanhaId: string | null, origem: string | null) => {
    const chave = chaveDe(campanhaId, origem);
    let l = linhas.get(chave);
    if (!l) { l = vazia(chave, campanhaId, campanhaId ? null : origem ?? SEM_REGISTRO); linhas.set(chave, l); }
    return l;
  };
  for (const c of dados.cliques) {
    // Clique sem campanha (botão de WhatsApp fora de campanha) vai para "sem campanha"; nunca vira contato.
    const l = linha(c.campanha_id, c.campanha_id ? null : SEM_REGISTRO);
    if (c.tipo === "CLIQUE_LINK_CAMPANHA") l.cliquesLink += Number(c.n);
    else l.cliquesWhatsapp += Number(c.n);
  }
  for (const c of dados.contatos) { const l = linha(c.campanha_id, c.origem_codigo); l.contatos += Number(c.n); l.contatosComContrato += Number(c.extra ?? 0); }
  for (const c of dados.negociacoes) linha(c.campanha_id, c.origem_codigo).negociacoes += Number(c.n);
  for (const c of dados.contratos) { const l = linha(c.campanha_id, c.origem_codigo); l.contratos += Number(c.n); l.receitaContratadaCentavos += Number(c.valor ?? 0); }
  for (const c of dados.cancelados) linha(c.campanha_id, c.origem_codigo).cancelamentos += Number(c.n);
  for (const c of dados.recebido) linha(c.campanha_id, c.origem_codigo).receitaRecebidaCentavos += Number(c.valor ?? 0);
  for (const camp of dados.campanhas) {
    const l = linhas.get(`c:${camp.id}`);
    if (!l) continue;
    l.campanhaNome = camp.nome;
    l.origemCodigo = camp.origem_codigo;
    l.orcamentoCentavos = camp.orcamento_centavos === null ? null : Number(camp.orcamento_centavos);
  }
  const total = vazia("total", null, null);
  for (const l of linhas.values()) {
    l.conversao = l.contatos > 0 ? l.contatosComContrato / l.contatos : null;
    for (const campo of ["cliquesLink", "cliquesWhatsapp", "contatos", "contatosComContrato", "negociacoes", "contratos", "cancelamentos",
      "receitaContratadaCentavos", "receitaRecebidaCentavos"] as const) total[campo] += l[campo];
  }
  total.conversao = total.contatos > 0 ? total.contatosComContrato / total.contatos : null;
  const ordem = (l: LinhaPainel) => (l.campanhaId ? 0 : l.origemCodigo === ORIGEM_DESCONHECIDA ? 2 : l.origemCodigo === SEM_REGISTRO ? 3 : 1);
  return {
    periodo,
    linhas: [...linhas.values()].sort((a, b) => ordem(a) - ordem(b) || b.contratos - a.contratos || b.contatos - a.contatos || a.chave.localeCompare(b.chave)),
    total,
    negociacoesSemOrigem: dados.negociacoesSemOrigem,
  };
}

export const ORIGEM_SEM_REGISTRO = SEM_REGISTRO;

/** Período padrão: últimos 30 dias até hoje (America/Sao_Paulo). */
export function periodoPadrao(hojeIso: string) {
  const fim = new Date(`${hojeIso}T12:00:00Z`);
  const inicio = new Date(fim.getTime() - 29 * 86_400_000);
  return { de: inicio.toISOString().slice(0, 10), ate: hojeIso };
}

export function validarPeriodo(de: string, ate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate) || de > ate) return false;
  const dias = (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(dias) && dias <= 731;
}
