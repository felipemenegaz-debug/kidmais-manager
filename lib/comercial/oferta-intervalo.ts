import type { DbExecutor } from "../db/contracts.ts";
import type { DisponibilidadeDataPublica, HorarioCandidatoPublico } from "../disponibilidade/services/models.ts";
import { PACOTES_CONTRATAVEIS_V1 } from "./pacotes-v1.ts";
import { regrasPublicasDoPacote } from "./disponibilidade-pacote-publica.ts";
import { motivoPacoteNoPeriodo, type OfertaPeriodo } from "./venda-periodo.ts";

import { centavosPorPontos } from "./modelo-preco.ts";

type FaixaCartao = { exata: boolean; tipo: string; min: number; max: number | null; valor: string };

export function precoDoMinimo(linhas: FaixaCartao[], minimo: number) {
  const exatas = linhas.filter(l => l.exata);
  const categoria = exatas.length ? exatas : linhas;
  const pontos = categoria.filter(l => l.tipo === "PONTO");
  if (pontos.length) {
    const calculo = centavosPorPontos(pontos.map(p => ({ convidados: p.min, valor: p.valor })), minimo);
    return calculo ? calculo.centavos / 100 : null;
  }
  // Mesma precedência da cotação: faixa aplicável exata antes de GERAL, depois maior início.
  const faixa = linhas.filter(l => l.min <= minimo && (l.max === null || l.max >= minimo))
    .sort((a, b) => Number(b.exata) - Number(a.exata) || b.min - a.min)[0];
  if (!faixa) return null;
  return Math.round(Number(faixa.valor) * 100) * (faixa.tipo === "POR_CONVIDADO" ? minimo : 1) / 100;
}

type Linha = Parameters<typeof regrasPublicasDoPacote>[0][number] & {
  pacote: string; minimo: number | null; maximo: number | null;
  precos_cartao?: FaixaCartao[];
  datas_com_preco: string[]; saloes: string[];
};

// A existência de preço segue a categoria e a precedência de buscarPrecoPacoteAplicavel.
// Entre pontos consecutivos a cotação interpola, inclusive nos dois extremos.
const tabelaECategoria = (dia: string, configuracao: string) => `
  JOIN LATERAL (
    SELECT (array_agg(t.id))[1] AS id FROM tabelas_preco t
     WHERE t.empresa_id = p.empresa_id AND t.publicada_em IS NOT NULL AND t.substituida_em IS NULL
       AND t.vigencia_inicio <= ${dia}::date AND (t.vigencia_fim IS NULL OR t.vigencia_fim >= ${dia}::date)
     HAVING count(*) = 1
  ) tabela ON true
  JOIN LATERAL (
    SELECT cat.categoria_horario FROM regras_categoria_horario cat
     WHERE cat.ativo AND cat.dia_semana = extract(isodow FROM ${dia}::date)
       AND cat.configuracao_agenda_id = ${configuracao}
       AND cat.vigencia_inicio <= ${dia}::date AND (cat.vigencia_fim IS NULL OR cat.vigencia_fim >= ${dia}::date)
     ORDER BY cat.vigencia_inicio DESC LIMIT 1
  ) categoria ON true`;

const datasComPreco = `ARRAY(
  SELECT dia::date::text FROM generate_series($2::date::timestamp, $3::date::timestamp, interval '1 day') dia
  ${tabelaECategoria("dia", "r.configuracao_agenda_id")}
  WHERE r.dia_semana = extract(isodow FROM dia) AND (
    SELECT CASE
      WHEN count(*) FILTER (WHERE ponto AND exata) > 0 THEN
        greatest($5::int, p.convidados_minimos) BETWEEN min(convidados_min) FILTER (WHERE ponto AND exata) AND max(convidados_min) FILTER (WHERE ponto AND exata)
      WHEN count(*) FILTER (WHERE exata) = 0 AND count(*) FILTER (WHERE ponto) > 0 THEN
        greatest($5::int, p.convidados_minimos) BETWEEN min(convidados_min) FILTER (WHERE ponto) AND max(convidados_min) FILTER (WHERE ponto)
      ELSE bool_or(convidados_min <= greatest($5::int, p.convidados_minimos) AND
        (convidados_max IS NULL OR convidados_max >= greatest($5::int, p.convidados_minimos))) END
    FROM (SELECT pp.*, pp.tipo_calculo = 'PONTO' AS ponto, pp.categoria_horario = categoria.categoria_horario AS exata
            FROM precos_pacote pp WHERE pp.ativo AND pp.tabela_preco_id = tabela.id AND pp.pacote_id = p.id
              AND pp.categoria_horario IN (categoria.categoria_horario, 'GERAL')) precos)
)`;

// Apenas para a etapa Pacote: preços da data e configuração escolhidas, no mesmo lote das regras.
const precosCartao = `(SELECT jsonb_agg(jsonb_build_object(
      'exata', pp.categoria_horario = categoria.categoria_horario, 'tipo', pp.tipo_calculo,
      'min', pp.convidados_min, 'max', pp.convidados_max, 'valor', pp.valor::text) ORDER BY pp.convidados_min)
    FROM precos_pacote pp
    ${tabelaECategoria("$2", "$5::uuid")}
    WHERE pp.ativo AND pp.pacote_id = p.id AND pp.tabela_preco_id = tabela.id
      AND pp.categoria_horario IN (categoria.categoria_horario, 'GERAL'))`;

export async function ofertasDoIntervalo(db: DbExecutor, empresa: string, kidmais: boolean, inicio: string, fim: string, convidados?: number, porSalao = false, configuracaoCartao?: string) {
  const params: unknown[] = [empresa, inicio, fim, kidmais ? PACOTES_CONTRATAVEIS_V1.map(p => p.codigo) : null];
  if (convidados) params.push(convidados);
  const incluirPrecoCartao = !convidados && Boolean(configuracaoCartao);
  if (incluirPrecoCartao) params.push(configuracaoCartao);
  const { rows } = await db.query<Linha>(`
    SELECT p.codigo AS pacote, p.convidados_minimos AS minimo, p.convidados_maximos AS maximo,
           ${incluirPrecoCartao ? precosCartao + " AS precos_cartao," : ""}
           r.dia_semana, r.estado, r.configuracao_agenda_id::text AS configuracao_id,
           c.codigo, r.vigencia_inicio::text, r.vigencia_fim::text,
           ${convidados ? datasComPreco : "ARRAY[]::text[]"} AS datas_com_preco,
           ${porSalao ? "ARRAY(SELECT ps.salao_id::text FROM pacote_saloes ps WHERE ps.pacote_id = p.id)" : "ARRAY[]::text[]"} AS saloes
      FROM pacotes p
      LEFT JOIN regras_disponibilidade_pacote r ON r.pacote_id = p.id AND r.ativo
       AND r.vigencia_inicio <= $3::date AND (r.vigencia_fim IS NULL OR r.vigencia_fim >= $2::date)
      LEFT JOIN configuracao_agenda c ON c.id = r.configuracao_agenda_id
     WHERE p.empresa_id = $1::uuid AND p.ativo AND p.vigente AND p.arquivado_em IS NULL
       AND ($4::text[] IS NULL OR p.codigo = ANY($4::text[]))
     ORDER BY p.codigo, r.vigencia_inicio`, params);
  const pacotes = new Map<string, OfertaPeriodo & { precosAplicaveis?: Set<string>; precoNoMinimo?: number | null }>();
  for (const row of rows) {
    let pacote = pacotes.get(row.pacote);
    if (!pacote) {
      pacote = { codigo: row.pacote, convidadosMinimos: row.minimo, convidadosMaximos: row.maximo, disponibilidade: [],
        ...(incluirPrecoCartao && row.minimo ? { precoNoMinimo: precoDoMinimo(row.precos_cartao ?? [], row.minimo) } : {}),
        saloesPermitidos: row.saloes, ...(convidados ? { precosAplicaveis: new Set<string>() } : {}) };
      pacotes.set(row.pacote, pacote);
    }
    for (const data of row.datas_com_preco ?? []) pacote.precosAplicaveis?.add(data + "/" + row.configuracao_id);
    if (row.configuracao_id) pacote.disponibilidade.push(...regrasPublicasDoPacote([row]));
  }
  return [...pacotes.values()];
}

export function aplicarOferta(dia: DisponibilidadeDataPublica, ofertas: OfertaPeriodo[], kidmais: boolean, n: number, saloesLivres?: ReadonlyMap<HorarioCandidatoPublico, string[]>): DisponibilidadeDataPublica {
  const semRegras = !ofertas.some(p => p.disponibilidade.length);
  const periodos = dia.periodos.map(p => {
    if (p.status !== "DISPONIVEL") return p;
    const elegiveis = ofertas.filter(o => motivoPacoteNoPeriodo(o, kidmais, n, dia.data, p.configuracaoId) === null);
    let minimo = Infinity;
    const horarios = p.horarios.map(h => {
      if (h.status !== "DISPONIVEL") return h;
      const livres = saloesLivres?.get(h);
      const vendaveis = elegiveis.filter(o => !livres || livres.some(id => !o.saloesPermitidos?.length || o.saloesPermitidos.includes(id)));
      for (const o of vendaveis) minimo = Math.min(minimo, o.convidadosMinimos ?? n);
      return { ...h, pacotesVendaveis: vendaveis.map(o => o.codigo), status: vendaveis.length ? "DISPONIVEL" as const : "INDISPONIVEL" as const };
    });
    if (Number.isFinite(minimo)) {
      return { ...p, horarios, ...(minimo > n ? { minimoFaturavel: minimo, avisoMinimoFaturavel: `Para ${n} convidados, a cobrança começa em ${minimo} convidados.` } : {}) };
    }
    const motivoComercial = semRegras ? "O buffet não tem venda online configurada para este intervalo." : `Sem pacote para ${n} convidados nesta data e período.`;
    return { ...p, status: "INDISPONIVEL" as const, motivoComercial, horarios };
  });
  const automaticos = ofertas.filter(o => !(kidmais && o.codigo === "PIZZA_PARTY") && o.disponibilidade.some(r => r.estado === "DISPONIVEL"));
  const minimo = Math.min(...automaticos.map(o => o.convidadosMinimos ?? 1));
  return { ...dia, periodos, ...(Number.isFinite(minimo) && minimo > n ? { minimoFaturavel: minimo } : {}) };
}
