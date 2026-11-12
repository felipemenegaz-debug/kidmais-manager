import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import { codificarCursor, erroDeDataInvalida, INSTANTE_SQL, lerCursor } from "./cursor.ts";
import { ctesEscopo } from "./escopo.ts";
import { SatisfacaoError } from "./erros.ts";

/**
 * Resultados da pesquisa (PS-4, plano rev. 0 + rev. 1 + rev. 1.1; D-PS4-1..6). Leitura viva, sem gravar nada.
 *
 * População P (R1, D-PS4-1, D-PS4-6): envios da empresa comprovada cuja FESTA (fechamentos.data_evento) cai no período,
 * cuja unidade está no escopo VER (e no filtro), com estado <> REVOGADO e festa válida NO INSTANTE da leitura
 * (f.status <> 'CANCELADO' e contrato ASSINADO — o mesmo predicado de festa de `respondidoValendo`, SEM a guarda de
 * link vencido: resposta antiga de festa válida continua contando depois que o link vence).
 *   Pesquisas criadas = |P| (inclui envio sem despacho, canal suprimido/falho e INCERTA — não é "enviadas");
 *   Respostas = envios RESPONDIDO de P; taxa = Respostas ÷ Pesquisas criadas;
 *   Ainda no prazo = ATIVO com expira_em > agora.i; Sem contato registrado = contato_em nulo (só informativo).
 *   NPS = round(100 × (promotores − detratores) / n) em numeric (round do PostgreSQL: meio para longe de zero).
 *
 * Escopos (R2): métricas e lista em VER; cartão "retornos abertos" e o estado do retorno por linha em VER ∩ TRATAR
 * (chaves AUSENTES do JSON fora da interseção). Filtros `grupo`/`comComentario` só da lista (R4): `total` = respostas de
 * P, `totalFiltrado` = com os filtros. Escopo, cartões, totais e página saem de UMA instrução (um snapshot por
 * requisição); páginas seguintes são requisições novas (navegação viva, R3). Projeção explícita (R7): primeiro nome,
 * data da festa, unidade, notas, comentário e instante — nunca cliente, contato, sobrenome ou observação interna.
 */
export const PAGINA_RESULTADOS = 50;
export const MAXIMO_DATAS = 366;
/** PS4-R4.5: random_page_cost só da instrução dos Resultados (ver lerResultados). */
export const CUSTO_PAGINA_ALEATORIA = "1.1";
export type Grupo = "promotores" | "neutros" | "detratores";
export type Atalho = "este-mes" | "mes-passado" | "ultimos-3-meses";
export type FiltroResultados = {
  inicio?: string | null; fim?: string | null; atalho?: string | null;
  unidade?: string | null; grupo?: string | null; comComentario?: string | null; cursor?: string | null;
};

type Aspecto = { media: string | null; respostas: number };
export type ItemResultado = {
  id: string; primeiroNome: string; dataFesta: string; unidade: string | null; respondidaEm: string;
  notaIndicacao: number; notaComida: number | null; notaEquipe: number | null; notaEspaco: number | null;
  comentario: string | null;
  retorno?: { tarefaId: string; estado: "ABERTA" | "CONCLUIDA" };
};
export type ResultadosSatisfacao = {
  periodo: { inicio: string; fim: string };
  unidade: string | null;
  unidades: Array<{ id: string; nome: string }>;
  semUnidade: boolean;
  cartoes: {
    pesquisasCriadas: number; respostas: number; taxa: string | null; aindaNoPrazo: number; semContato: number;
    nps: number | null;
    grupos: { promotores: number; neutros: number; detratores: number };
    histograma: number[];
    aspectos: Record<"comida" | "equipe" | "espaco", Aspecto>;
    retornosAbertos?: { abertos: number; unidadesComTratar: number; unidadesNoFiltro: number };
  };
  lista: { total: number; totalFiltrado: number; itens: ItemResultado[]; proximo: string | null };
};

const DATA = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATALHOS: readonly Atalho[] = ["este-mes", "mes-passado", "ultimos-3-meses"];
const GRUPOS: readonly Grupo[] = ["promotores", "neutros", "detratores"];
const invalido = (mensagem: string) => new SatisfacaoError("DADOS_INVALIDOS", mensagem, 400);
const naoEncontrada = () => new SatisfacaoError("NAO_ENCONTRADO", "Unidade não encontrada.", 404);

/**
 * Período efetivo (R9): datas explícitas (as duas, texto YYYY-MM-DD convertido pelo PostgreSQL, sem `Date`) ou um
 * atalho do calendário de negócio America/Sao_Paulo resolvido no servidor (padrão: últimos 3 meses = 1º dia do mês de
 * dois meses atrás até hoje). Limite: fim − inicio + 1 ≤ 366 datas; invertido ou acima → 400.
 */
async function resolverPeriodo(tx: DbExecutor, f: FiltroResultados) {
  const explicito = Boolean(f.inicio || f.fim);
  if (explicito && (!f.inicio || !f.fim || !DATA.test(f.inicio) || !DATA.test(f.fim))) throw invalido("Informe o período com início e fim (AAAA-MM-DD).");
  const atalho = (f.atalho || "ultimos-3-meses") as Atalho;
  if (!explicito && !ATALHOS.includes(atalho)) throw invalido("Período inválido.");
  let r: { inicio: string; fim: string; datas: number };
  try {
    r = (await tx.query<typeof r>(
      `WITH hoje AS (SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date AS d),
       p AS (SELECT CASE WHEN $1::text IS NOT NULL THEN $1::date
                         WHEN $3 = 'este-mes' THEN date_trunc('month', hoje.d)::date
                         WHEN $3 = 'mes-passado' THEN (date_trunc('month', hoje.d) - interval '1 month')::date
                         ELSE (date_trunc('month', hoje.d) - interval '2 months')::date END AS inicio,
                    CASE WHEN $2::text IS NOT NULL THEN $2::date
                         WHEN $3 = 'mes-passado' THEN (date_trunc('month', hoje.d) - interval '1 day')::date
                         ELSE hoje.d END AS fim
               FROM hoje)
       SELECT to_char(inicio, 'YYYY-MM-DD') AS inicio, to_char(fim, 'YYYY-MM-DD') AS fim, (fim - inicio + 1) AS datas FROM p`,
      [explicito ? f.inicio : null, explicito ? f.fim : null, atalho])).rows[0];
  } catch (error) {
    if (erroDeDataInvalida(error)) throw invalido("Data inválida.");
    throw error;
  }
  if (r.datas < 1) throw invalido("O fim do período vem antes do início.");
  if (r.datas > MAXIMO_DATAS) throw invalido(`O período aceita até ${MAXIMO_DATAS} dias.`);
  return { inicio: r.inicio, fim: r.fim };
}

const SQL_RESULTADOS = `/* satisfacao:resultados */
WITH agora AS MATERIALIZED (SELECT clock_timestamp() AS i),
${ctesEscopo("$1::uuid", "m.id = $2::uuid")},
-- Universo VER e TRATAR por unidade; NULL = "festas sem unidade" (só a Gestão).
unidades_ver AS (
  SELECT u.id AS unidade FROM estabelecimentos u, gestao WHERE gestao.sim AND u.empresa_id = $1::uuid
  UNION ALL SELECT NULL::uuid FROM gestao WHERE gestao.sim
  UNION ALL SELECT unidade FROM escopo_ver
),
unidades_tratar AS (
  SELECT u.id AS unidade FROM estabelecimentos u, gestao WHERE gestao.sim AND u.empresa_id = $1::uuid
  UNION ALL SELECT NULL::uuid FROM gestao WHERE gestao.sim
  UNION ALL SELECT unidade FROM escopo_tratar
),
no_filtro AS (
  SELECT uv.unidade FROM unidades_ver uv
   WHERE ($5::uuid IS NULL AND NOT $6::boolean) OR uv.unidade = $5::uuid OR ($6::boolean AND uv.unidade IS NULL)
),
interseccao AS (
  SELECT nf.unidade FROM no_filtro nf WHERE EXISTS (SELECT 1 FROM unidades_tratar ut WHERE ut.unidade IS NOT DISTINCT FROM nf.unidade)
),
-- O período entra pelas festas da empresa; os envios são lidos pelo prefixo empresa_id (nenhum índice de envios tem a
-- data da festa) e casados com as festas pela chave (empresa_id, fechamento_id).
-- PS4-R4: um único recorte (empresa_id, data_evento), que a 115 oferece como faixa de índice. O índice não obriga o
-- plano: a escolha continua com o planner e a faixa observada é conferida nos planos pelo verificador. O contrato (sem
-- empresa_id: só alcançável pela festa) entra POR CHAVE (fechamento_id único), depois do recorte de P, em vez de varredura
-- de contratos de todas as empresas.
festas AS MATERIALIZED (
  SELECT f.id, f.data_evento FROM fechamentos f
   WHERE f.empresa_id = $1::uuid AND f.data_evento BETWEEN $3::date AND $4::date AND f.status <> 'CANCELADO'
),
p AS (
  SELECT e.id, e.estado, e.expira_em, e.contato_em, e.estabelecimento_id, e.cliente_id, f.data_evento
    FROM festas f JOIN satisfacao_envios e ON e.empresa_id = $1::uuid AND e.fechamento_id = f.id
   CROSS JOIN LATERAL (SELECT 1 FROM contratos ct WHERE ct.fechamento_id = e.fechamento_id AND ct.status = 'ASSINADO' LIMIT 1) ct
   WHERE e.estado <> 'REVOGADO'
     AND EXISTS (SELECT 1 FROM no_filtro nf WHERE nf.unidade IS NOT DISTINCT FROM e.estabelecimento_id)
),
respostas AS (
  SELECT r.id, r.respondido_em, r.nota_indicacao, r.nota_comida, r.nota_equipe, r.nota_espaco, r.comentario,
         p.estabelecimento_id, p.data_evento, p.cliente_id,
         EXISTS (SELECT 1 FROM interseccao i WHERE i.unidade IS NOT DISTINCT FROM p.estabelecimento_id) AS trata
    -- PS4-C2: busca POR CHAVE (envio_id único) a partir de P. O LIMIT impede o planner de achatar a subconsulta e trocar
    -- as buscas por um Seq Scan + hash da tabela inteira (que lia as respostas de outras empresas para filtrá-las depois).
    FROM p CROSS JOIN LATERAL (
      SELECT r.* FROM satisfacao_respostas r WHERE r.envio_id = p.id AND r.empresa_id = $1::uuid LIMIT 1) r
   WHERE p.estado = 'RESPONDIDO'
),
filtradas AS (
  SELECT * FROM respostas r
   WHERE ($7::text IS NULL
          OR ($7 = 'promotores' AND r.nota_indicacao >= 9)
          OR ($7 = 'neutros' AND r.nota_indicacao BETWEEN 7 AND 8)
          OR ($7 = 'detratores' AND r.nota_indicacao <= 6))
     AND (NOT $8::boolean OR r.comentario IS NOT NULL)
),
pagina AS (
  SELECT * FROM filtradas r
   WHERE $9::timestamptz IS NULL OR (r.respondido_em, r.id) < ($9::timestamptz, $10::uuid)
   ORDER BY r.respondido_em DESC, r.id DESC LIMIT $11::int
),
contas AS (
  SELECT count(*) AS n,
         count(*) FILTER (WHERE nota_indicacao >= 9) AS prom,
         count(*) FILTER (WHERE nota_indicacao BETWEEN 7 AND 8) AS neut,
         count(*) FILTER (WHERE nota_indicacao <= 6) AS detr,
         round(avg(nota_comida)::numeric, 1)::text AS m_comida, count(nota_comida) AS q_comida,
         round(avg(nota_equipe)::numeric, 1)::text AS m_equipe, count(nota_equipe) AS q_equipe,
         round(avg(nota_espaco)::numeric, 1)::text AS m_espaco, count(nota_espaco) AS q_espaco
    FROM respostas
)
SELECT
  (SELECT gestao.sim FROM gestao) OR EXISTS (SELECT 1 FROM escopo_ver) AS tem_ver,
  ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM unidades_ver WHERE unidade = $5::uuid))
    AND (NOT $6::boolean OR EXISTS (SELECT 1 FROM unidades_ver WHERE unidade IS NULL)) AS filtro_valido,
  EXISTS (SELECT 1 FROM unidades_ver WHERE unidade IS NULL) AS sem_unidade,
  coalesce((SELECT json_agg(json_build_object('id', u.id::text, 'nome', u.nome) ORDER BY u.nome, u.id)
     FROM estabelecimentos u
    WHERE u.empresa_id = $1::uuid AND u.id IN (SELECT unidade FROM unidades_ver)
      AND (u.status <> 'DESATIVADO' OR EXISTS (SELECT 1 FROM satisfacao_envios e WHERE e.empresa_id = $1::uuid AND e.estabelecimento_id = u.id))), '[]'::json) AS unidades,
  (SELECT count(*) FROM p) AS criadas,
  (SELECT count(*) FROM p, agora WHERE p.estado = 'ATIVO' AND p.expira_em > agora.i) AS no_prazo,
  (SELECT count(*) FROM p WHERE p.contato_em IS NULL) AS sem_contato,
  contas.*,
  CASE WHEN contas.n = 0 THEN NULL ELSE round(100::numeric * (contas.prom - contas.detr) / contas.n)::int END AS nps,
  CASE WHEN (SELECT count(*) FROM p) = 0 THEN NULL ELSE round(100::numeric * contas.n / (SELECT count(*) FROM p), 1)::text END AS taxa,
  (SELECT array_agg(coalesce(h.q, 0) ORDER BY g.nota) FROM generate_series(0, 10) g(nota)
     LEFT JOIN (SELECT nota_indicacao, count(*) AS q FROM respostas GROUP BY nota_indicacao) h ON h.nota_indicacao = g.nota) AS histograma,
  EXISTS (SELECT 1 FROM interseccao) AS tem_interseccao,
  (SELECT count(*) FROM interseccao) AS unidades_com_tratar,
  (SELECT count(*) FROM no_filtro) AS unidades_no_filtro,
  (SELECT count(*) FROM respostas r CROSS JOIN LATERAL (
      SELECT 1 FROM satisfacao_tarefas t WHERE t.resposta_id = r.id AND t.empresa_id = $1::uuid AND t.estado = 'ABERTA' LIMIT 1) t
    WHERE r.trata) AS retornos_abertos,
  (SELECT count(*) FROM filtradas) AS total_filtrado,
  coalesce((SELECT json_agg(x.item ORDER BY x.respondido_em DESC, x.id DESC) FROM (
    SELECT r.respondido_em, r.id,
           jsonb_build_object(
             'id', r.id::text,
             'primeiroNome', coalesce(nullif(split_part(regexp_replace(btrim(cl.nome_completo), '\\s+', ' ', 'g'), ' ', 1), ''), 'Cliente'),
             'dataFesta', to_char(r.data_evento, 'YYYY-MM-DD'),
             'unidade', u.nome,
             'respondidaEm', ${INSTANTE_SQL("r.respondido_em")},
             'notaIndicacao', r.nota_indicacao, 'notaComida', r.nota_comida, 'notaEquipe', r.nota_equipe, 'notaEspaco', r.nota_espaco,
             'comentario', r.comentario)
           || CASE WHEN r.trata AND t.id IS NOT NULL THEN jsonb_build_object('retorno', jsonb_build_object('tarefaId', t.id::text, 'estado', t.estado)) ELSE '{}'::jsonb END AS item
      FROM pagina r
      JOIN clientes cl ON cl.id = r.cliente_id
      LEFT JOIN estabelecimentos u ON u.id = r.estabelecimento_id AND u.empresa_id = $1::uuid
      LEFT JOIN LATERAL (
        SELECT t.id, t.estado FROM satisfacao_tarefas t WHERE t.resposta_id = r.id AND t.empresa_id = $1::uuid LIMIT 1) t ON true) x), '[]'::json) AS itens
FROM contas`;

type Linha = {
  tem_ver: boolean; filtro_valido: boolean; sem_unidade: boolean; unidades: Array<{ id: string; nome: string }>;
  criadas: string; no_prazo: string; sem_contato: string;
  n: string; prom: string; neut: string; detr: string;
  m_comida: string | null; q_comida: string; m_equipe: string | null; q_equipe: string; m_espaco: string | null; q_espaco: string;
  nps: number | null; taxa: string | null; histograma: Array<string | number>;
  tem_interseccao: boolean; unidades_com_tratar: string; unidades_no_filtro: string; retornos_abertos: string;
  total_filtrado: string; itens: ItemResultado[];
};

/** Leitura no escopo VER do tenant. Sem VER, unidade fora do escopo ou "sem-unidade" pela Equipe → 404 genérico. */
export async function lerResultados(tx: DbExecutor, tenant: TenantComprovado, filtro: FiltroResultados = {}): Promise<ResultadosSatisfacao> {
  const bruto = filtro.unidade ?? null;
  const semUnidade = bruto === "sem-unidade";
  const unidade = bruto && !semUnidade ? bruto : null;
  if (bruto && !semUnidade && !UUID.test(bruto)) throw naoEncontrada();
  const grupo = filtro.grupo || null;
  if (grupo !== null && !GRUPOS.includes(grupo as Grupo)) throw invalido("Filtro de grupo inválido.");
  const com = filtro.comComentario ?? null;
  if (com !== null && com !== "" && com !== "1") throw invalido("Filtro de comentário inválido.");
  const cursor = lerCursor(filtro.cursor);
  const periodo = await resolverPeriodo(tx, filtro);

  // PS4-R4.5 (D-PS4-R4-5): custo de página aleatória do planner SÓ para esta instrução, na transação da rota
  // (withTenantTransaction; fora de transação o ajuste não vale e o resultado é o mesmo, só o plano muda). Com ele o
  // planner busca os envios POR CHAVE a partir das festas no período curto e mantém a leitura pelo prefixo da empresa
  // no longo, em vez de juntar sempre todo o histórico de envios da empresa. Não muda o resultado (conferido nas 20
  // combinações do ensaio); depois da instrução o valor anterior volta, para não alcançar outras leituras da transação.
  const { anterior } = (await tx.query<{ anterior: string }>(
    `WITH a AS MATERIALIZED (SELECT current_setting('random_page_cost') AS v)
     SELECT a.v AS anterior, set_config('random_page_cost', $1, true) AS ajustado FROM a`, [CUSTO_PAGINA_ALEATORIA])).rows[0];
  let r: Linha;
  try {
    r = (await tx.query<Linha>(SQL_RESULTADOS, [tenant.empresaComprovada, tenant.membershipId, periodo.inicio, periodo.fim, unidade, semUnidade,
      grupo, com === "1", cursor?.instante ?? null, cursor?.id ?? null, PAGINA_RESULTADOS + 1])).rows[0];
  } catch (error) {
    if (erroDeDataInvalida(error)) throw invalido("Cursor inválido.");
    throw error;
  }
  await tx.query(`SELECT set_config('random_page_cost', $1, true)`, [anterior]);
  // Sem VER (membership não vigente, só TRATAR ou nenhuma concessão): 404 genérico, como unidade fora do escopo.
  if (!r.tem_ver || !r.filtro_valido) throw naoEncontrada();
  const mais = r.itens.length > PAGINA_RESULTADOS;
  const itens = r.itens.slice(0, PAGINA_RESULTADOS);
  const ultimo = itens[itens.length - 1];
  const aspecto = (media: string | null, q: string): Aspecto => ({ media, respostas: Number(q) });
  const cartoes: ResultadosSatisfacao["cartoes"] = {
    pesquisasCriadas: Number(r.criadas), respostas: Number(r.n), taxa: r.taxa, aindaNoPrazo: Number(r.no_prazo), semContato: Number(r.sem_contato),
    nps: r.nps,
    grupos: { promotores: Number(r.prom), neutros: Number(r.neut), detratores: Number(r.detr) },
    histograma: r.histograma.map(Number),
    aspectos: { comida: aspecto(r.m_comida, r.q_comida), equipe: aspecto(r.m_equipe, r.q_equipe), espaco: aspecto(r.m_espaco, r.q_espaco) },
  };
  if (r.tem_interseccao) {
    cartoes.retornosAbertos = { abertos: Number(r.retornos_abertos), unidadesComTratar: Number(r.unidades_com_tratar), unidadesNoFiltro: Number(r.unidades_no_filtro) };
  }
  return {
    periodo,
    unidade: semUnidade ? "sem-unidade" : unidade,
    unidades: r.unidades,
    semUnidade: r.sem_unidade,
    cartoes,
    lista: { total: Number(r.n), totalFiltrado: Number(r.total_filtrado), itens, proximo: mais && ultimo ? codificarCursor(ultimo.respondidaEm, ultimo.id) : null },
  };
}
