import type { DbExecutor } from "../db/contracts.ts";
import { createHash } from "node:crypto";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { contarEventosImportadosAIntegrar } from "../contratos/importados.ts";
import {
  CATEGORIAS_DESPESA,
  FORMAS,
  HORIZONTE_RECORRENCIA_MESES,
  PAGAR_EM_ABERTO,
  IMPLANTACAO_FINANCEIRO,
  VERSAO_RESUMO_FINANCEIRO,
  aceitaBaixa,
  centavosDe,
  formaParaRecebimento,
  liquidoCentavos,
  margemEstimada,
  periodoSelecionado,
  resultadoCaixa,
  saldoCentavos,
  somarDias,
  statusPagar,
  statusReceber,
  vencimentosMensais,
  type FormaFinanceira,
  type StatusPagar,
  type StatusReceber,
} from "./calculos.ts";
import { saldoItemVigente } from "../pagamentos/services/alteracao-financeira-core.ts";
import {
  pendenciasDaAbertura,
  saldoDoPeriodo,
  somaMovimentos,
  ultimaConferencia,
  type AberturaVigente,
  type MovimentoCaixa,
  type TipoOrigemMovimento,
} from "./abertura.ts";

/**
 * Schema da P2. 120 = liquidação de entrada manual e reversão de pagamento de conta; 121 = abertura de saldo.
 * Sem as tabelas, o leitor se comporta como antes da P2: sem liquidações, sem reversões e sem abertura (logo, sem saldo
 * absoluto). Uma consulta ao catálogo por transação.
 */
export type EsquemaP2 = { movimentos: boolean; abertura: boolean };
const esquemasP2 = new WeakMap<object, Promise<EsquemaP2>>();
export function esquemaP2(tx: DbExecutor): Promise<EsquemaP2> {
  let lido = esquemasP2.get(tx);
  if (!lido) {
    lido = tx.query<{ movimentos: boolean; abertura: boolean }>(
      `SELECT (to_regclass('public.financeiro_entradas_liquidacoes') IS NOT NULL
               AND to_regclass('public.financeiro_saidas_reversoes') IS NOT NULL) AS movimentos,
              (to_regclass('public.financeiro_aberturas') IS NOT NULL
               AND to_regclass('public.financeiro_abertura_conferencias') IS NOT NULL) AS abertura`,
    ).then((r) => ({ movimentos: r.rows[0]?.movimentos === true, abertura: r.rows[0]?.abertura === true }));
    esquemasP2.set(tx, lido);
  }
  return lido;
}

/**
 * Recebimentos efetivos de entradas manuais, um por linha, no formato de `financeiro_entradas_manuais` (`recebido_em`,
 * `valor` bruto, `taxa`). Entrada com `recebido_em` e sem liquidação é o registro anterior à P2: vale como uma liquidação
 * de valor − taxa naquela data. Com liquidação, só as liquidações contam. Exige `$1` = empresa.
 */
export function manuaisRecebidasSql(e: EsquemaP2) {
  const legado = `
    SELECT entrada.id AS origem_id, 'ENTRADA_MANUAL'::text AS origem_tipo, entrada.id AS entrada_id, entrada.empresa_id,
           entrada.festa_id, entrada.forma, entrada.descricao, entrada.recebido_em, entrada.valor, entrada.taxa
      FROM financeiro_entradas_manuais entrada
     WHERE entrada.empresa_id = $1::uuid AND entrada.recebido_em IS NOT NULL`;
  if (!e.movimentos) return legado;
  return `${legado}
       AND NOT EXISTS (SELECT 1 FROM financeiro_entradas_liquidacoes liq WHERE liq.entrada_id = entrada.id AND liq.empresa_id = entrada.empresa_id)
    UNION ALL
    SELECT liq.id, 'LIQUIDACAO_MANUAL'::text, entrada.id, entrada.empresa_id,
           entrada.festa_id, liq.forma, entrada.descricao, liq.recebido_em, liq.valor, liq.taxa
      FROM financeiro_entradas_liquidacoes liq
      JOIN financeiro_entradas_manuais entrada ON entrada.id = liq.entrada_id AND entrada.empresa_id = liq.empresa_id
     WHERE liq.empresa_id = $1::uuid`;
}

/**
 * Pagamentos de conta com sinal, no formato de `financeiro_saidas` (`valor`, `pago_em`): saída positiva, reversão negativa
 * na data em que o dinheiro voltou. Somar `valor` dá o pago líquido. Exige `$1` = empresa.
 */
export function saidasLiquidasSql(e: EsquemaP2) {
  const base = `
    SELECT saida.id AS origem_id, 'SAIDA'::text AS origem_tipo, saida.conta_id, saida.empresa_id, saida.valor, saida.pago_em, saida.forma
      FROM financeiro_saidas saida
     WHERE saida.empresa_id = $1::uuid`;
  if (!e.movimentos) return base;
  return `${base}
    UNION ALL
    SELECT rev.id, 'REVERSAO_SAIDA'::text, saida.conta_id, rev.empresa_id, -rev.valor, rev.revertido_em, saida.forma
      FROM financeiro_saidas_reversoes rev
      JOIN financeiro_saidas saida ON saida.id = rev.saida_id AND saida.empresa_id = rev.empresa_id
     WHERE rev.empresa_id = $1::uuid`;
}

function recusar(code: string, message: string, status: number): never {
  throw new PacoteAdminError(code, message, status);
}

async function auditar(tx: DbExecutor, empresaId: string, acao: string, entidade: string, entidadeId: string, atorId: string, detalhe: string) {
  await tx.query(
    `INSERT INTO financeiro_auditoria (empresa_id, acao, entidade, entidade_id, ator_id, detalhe)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6)`,
    [empresaId, acao, entidade, entidadeId, atorId, detalhe],
  );
}

export async function garantirCategorias(tx: DbExecutor, empresaId: string) {
  for (const nome of CATEGORIAS_DESPESA) {
    await tx.query(
      `INSERT INTO financeiro_categorias (empresa_id, tipo, nome)
       VALUES ($1::uuid, 'DESPESA', $2)
       ON CONFLICT (empresa_id, tipo, nome) DO NOTHING`,
      [empresaId, nome],
    );
  }
}

/** Consulta sem criar categorias: usada para revisar uma conta antes da confirmação. */
export async function listarCategoriasDespesa(tx: DbExecutor, empresaId: string) {
  return (await tx.query<{ id: string; nome: string }>(
    "SELECT id::text AS id, nome FROM financeiro_categorias WHERE empresa_id = $1::uuid AND tipo = 'DESPESA' AND ativo ORDER BY nome",
    [empresaId],
  )).rows;
}

/**
 * Títulos vigentes: fonte única da seleção de contar e listar.
 * Com cronograma ativo, valem os itens dele, mesmo que a parcela esteja em plano substituído (cronograma misto);
 * parcela do plano ativo fora do cronograma só aparece se já recebeu, como histórico, sem saldo nem elegibilidade.
 * Sem cronograma, valem as parcelas do plano ativo.
 */
const TITULOS_VIGENTES_SQL = `
    FROM pagamento_parcelas parcela
    JOIN pagamento_planos plano ON plano.id = parcela.plano_id
    JOIN pagamentos pag ON pag.id = plano.pagamento_id
    JOIN contrato_versoes ver ON ver.id = pag.contrato_versao_id
    JOIN contratos contrato ON contrato.id = ver.contrato_id
    JOIN fechamentos fech ON fech.id = contrato.fechamento_id
    JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
    LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id AND cliente.empresa_id = $1::uuid
    LEFT JOIN festas festa ON festa.contrato_id = contrato.id AND festa.invalidada_em IS NULL
    LEFT JOIN pagamento_cronogramas crono ON crono.pagamento_id = pag.id AND crono.estado = 'ATIVO'
    LEFT JOIN pagamento_cronograma_itens item ON item.cronograma_id = crono.id AND item.parcela_id = parcela.id
   WHERE (crono.id IS NULL AND plano.status = 'ATIVO')
      OR item.id IS NOT NULL
      OR (plano.status = 'ATIVO' AND EXISTS (
            SELECT 1 FROM pagamento_recebimento_alocacoes aloc
              JOIN pagamento_recebimentos rec ON rec.id = aloc.recebimento_id
             WHERE aloc.parcela_id = parcela.id AND rec.status = 'CONFIRMADO'))
`;

/**
 * Mesmo comando para título e posição do pagamento: uma só fotografia, nas mesmas somas de lerPosicaoFinanceira.
 * As somas por parcela e o EXISTS do histórico usam o escopo do motor e do validador 015 (alocação e estorno da
 * parcela, sem filtrar o pagamento do recebimento). Filtrar só aqui faria a lista divergir da baixa. Um vínculo de
 * recebimento de outro pagamento numa parcela não é impedido pelo schema (011 valida as FKs separadamente); fechar
 * isso exige mudar motor e 015 juntos, fora da P1.
 */
const RECEBER_SQL = `
  SELECT parcela.id::text AS id,
         pag.id::text AS pagamento_id,
         parcela.numero,
         parcela.valor_previsto::text AS valor,
         parcela.vencimento::text AS vencimento,
         parcela.status AS status_gravado,
         pag.status AS status_pagamento,
         contrato.status AS status_contrato,
         COALESCE(cliente.nome_completo, 'Cliente') AS cliente,
         cliente.id::text AS cliente_id,
         festa.id::text AS festa_id,
         COALESCE(NULLIF(ver.snapshot #>> '{evento,pacote,nome}', ''), pac.nome) AS pacote,
         fech.data_evento::text AS data_evento,
         plano.meio_pagamento AS forma,
         crono.id::text AS cronograma_id,
         item.id::text AS item_id,
         item.saldo_inicial_centavos::text AS item_saldo_inicial,
         item.recebido_base_centavos::text AS item_recebido_base,
         item.estornado_base_centavos::text AS item_estornado_base,
         item.vencimento_referencia::text AS item_vencimento,
         (SELECT COALESCE(SUM(aloc.valor_alocado), 0)
            FROM pagamento_recebimento_alocacoes aloc
            JOIN pagamento_recebimentos rec ON rec.id = aloc.recebimento_id
           WHERE aloc.parcela_id = parcela.id AND rec.status = 'CONFIRMADO')::text AS recebido,
         (SELECT COALESCE(SUM(est.valor), 0)
            FROM pagamento_estornos est
           WHERE est.parcela_id = parcela.id AND est.status = 'CONFIRMADO')::text AS estornado,
         pag.valor_total_contratado::text AS pos_contratado,
         (SELECT COALESCE(SUM(aj.delta_centavos), 0) FROM pagamento_ajustes_contratuais aj WHERE aj.pagamento_id = pag.id)::text AS pos_ajustes_centavos,
         (SELECT COALESCE(SUM(rec.valor_bruto), 0) FROM pagamento_recebimentos rec WHERE rec.pagamento_id = pag.id AND rec.status = 'CONFIRMADO')::text AS pos_recebido,
         (SELECT COALESCE(SUM(est.valor), 0)
            FROM pagamento_estornos est
            JOIN pagamento_recebimentos rec ON rec.id = est.recebimento_id
           WHERE rec.pagamento_id = pag.id AND est.status = 'CONFIRMADO')::text AS pos_estornado,
         (SELECT COALESCE(SUM(dev.valor_centavos), 0) FROM pagamento_devolucoes dev WHERE dev.pagamento_id = pag.id AND dev.estado = 'CONCLUIDA')::text AS pos_devolvido_centavos
  ${TITULOS_VIGENTES_SQL}
`;

export type LinhaReceber = {
  id: string;
  pagamento_id: string;
  numero: number;
  valor: string;
  vencimento: string;
  status_gravado: string;
  status_pagamento: string;
  status_contrato: string;
  cliente: string;
  cliente_id: string | null;
  festa_id: string | null;
  pacote: string;
  data_evento: string;
  forma: string;
  cronograma_id: string | null;
  item_id: string | null;
  item_saldo_inicial: string | null;
  item_recebido_base: string | null;
  item_estornado_base: string | null;
  item_vencimento: string | null;
  recebido: string;
  estornado: string;
  pos_contratado: string;
  pos_ajustes_centavos: string;
  pos_recebido: string;
  pos_estornado: string;
  pos_devolvido_centavos: string;
};

export type Recebivel = {
  id: string;
  origem?: "CONTRATO" | "ENTRADA_MANUAL";
  pagamentoId: string;
  cliente: string;
  clienteId?: string | null;
  festaId: string | null;
  pacote: string;
  data: string;
  parcela: number;
  vencimento: string;
  valorCentavos: number;
  recebidoCentavos: number;
  saldoCentavos: number;
  forma: string;
  status: StatusReceber;
  diasAtraso: number;
  /** Bruto alocado neste título, sem o estorno. Não é caixa. */
  brutoRecebidoCentavos?: number;
  estornadoCentavos?: number;
  /** Posição do pagamento no motor. Com cronograma, a festa soma por aqui, e não pelo nominal das parcelas. */
  motor?: { obrigacaoCentavos: number; liquidoCentavos: number; cronograma: boolean };
};

function diasDeAtraso(status: StatusReceber, vencimento: string, hoje: string) {
  return status === "Vencido"
    ? Math.max(0, Math.round((Date.parse(`${hoje}T00:00:00Z`) - Date.parse(`${vencimento}T00:00:00Z`)) / 86400000))
    : 0;
}

/**
 * Adaptador único do motor para as leituras gerenciais. O saldo do título é a mesma conta de lerPosicaoFinanceira
 * e nunca passa do saldo da posição, que é o que validarCapacidadeConsolidada aceita na confirmação.
 */
export function consolidarTitulos(linhas: LinhaReceber[], hoje: string): Recebivel[] {
  const ordem = [...linhas].sort((a, b) =>
    (a.item_vencimento ?? a.vencimento).localeCompare(b.item_vencimento ?? b.vencimento)
    || Number(a.numero) - Number(b.numero) || a.id.localeCompare(b.id));
  const restantePorPagamento = new Map<string, number>();
  return ordem.map((linha) => {
    const bruto = centavosDe(linha.recebido);
    const estornado = centavosDe(linha.estornado);
    const liquidoItem = bruto - estornado;
    const comItem = linha.item_id != null;
    const recebidoBase = comItem ? Number(linha.item_recebido_base) : 0;
    const estornadoBase = comItem ? Number(linha.item_estornado_base) : 0;
    const baseSaldo = comItem ? Number(linha.item_saldo_inicial) : centavosDe(linha.valor);
    const saldoItem = Number(saldoItemVigente({
      base: BigInt(baseSaldo),
      recebido: BigInt(bruto),
      estornado: BigInt(estornado),
      recebidoBase: BigInt(recebidoBase),
      estornadoBase: BigInt(estornadoBase),
    }));
    const obrigacao = centavosDe(linha.pos_contratado) + Number(linha.pos_ajustes_centavos);
    const liquidoPosicao = centavosDe(linha.pos_recebido) - centavosDe(linha.pos_estornado) - Number(linha.pos_devolvido_centavos);
    const encerrada = linha.status_contrato === "CANCELADO" || linha.status_pagamento === "CANCELADO";
    const reembolsado = encerrada && estornado > 0 && liquidoItem <= 0;
    const cancelado = !reembolsado && (encerrada || (!comItem && linha.status_gravado === "CANCELADA"));
    const restante = restantePorPagamento.get(linha.pagamento_id) ?? Math.max(0, obrigacao - liquidoPosicao);
    const foraDoCronograma = linha.cronograma_id != null && !comItem;
    const saldo = cancelado || reembolsado || foraDoCronograma ? 0 : Math.min(saldoItem, restante);
    if (!cancelado && !reembolsado) restantePorPagamento.set(linha.pagamento_id, restante - saldo);
    const vencimento = linha.item_vencimento ?? linha.vencimento;
    const recebido = Math.max(0, liquidoItem);
    const valor = comItem ? baseSaldo + recebidoBase - estornadoBase : foraDoCronograma ? recebido : centavosDe(linha.valor);
    const status = statusReceber({ cancelado, reembolsado, valorCentavos: valor, recebidoCentavos: recebido, saldoCentavos: saldo, vencimento, hoje });
    return {
      id: linha.id,
      origem: "CONTRATO" as const,
      pagamentoId: linha.pagamento_id,
      cliente: linha.cliente,
      clienteId: linha.cliente_id,
      festaId: linha.festa_id,
      pacote: linha.pacote,
      data: linha.data_evento,
      parcela: Number(linha.numero),
      vencimento,
      valorCentavos: valor,
      recebidoCentavos: recebido,
      saldoCentavos: saldo,
      forma: linha.forma,
      status,
      diasAtraso: diasDeAtraso(status, vencimento, hoje),
      brutoRecebidoCentavos: bruto,
      estornadoCentavos: estornado,
      motor: { obrigacaoCentavos: obrigacao, liquidoCentavos: liquidoPosicao, cronograma: linha.cronograma_id != null },
    };
  });
}

/** `recebido`: soma bruta dos recebimentos da entrada (liquidações, ou a linha anterior à P2 inteira). */
const manualSql = (e: EsquemaP2) => `
  SELECT entrada.id::text AS id, entrada.descricao, entrada.contraparte, entrada.festa_id::text AS festa_id,
         pac.nome AS festa, entrada.valor::text AS valor, entrada.vencimento::text AS vencimento,
         entrada.forma, entrada.recebido_em::text AS recebido_em, entrada.taxa::text AS taxa,
         COALESCE((SELECT SUM(mov.valor) FROM (${manuaisRecebidasSql(e)}) mov WHERE mov.entrada_id = entrada.id), 0)::text AS recebido
    FROM financeiro_entradas_manuais entrada
    LEFT JOIN festas festa ON festa.id = entrada.festa_id AND festa.invalidada_em IS NULL
    LEFT JOIN contratos contrato ON contrato.id = festa.contrato_id
    LEFT JOIN fechamentos fech ON fech.id = contrato.fechamento_id
    LEFT JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = entrada.empresa_id
   WHERE entrada.empresa_id = $1::uuid
`;

export type LinhaManual = {
  id: string;
  descricao: string;
  contraparte: string | null;
  festa_id: string | null;
  festa: string | null;
  valor: string;
  vencimento: string;
  forma: string | null;
  recebido_em: string | null;
  taxa: string;
  /** Soma bruta recebida. Ausente só em leitura anterior à P2: aí vale 0% ou 100% pelo `recebido_em`. */
  recebido?: string;
};

/** Recebido pela soma dos recebimentos (P2): R$ 100 de R$ 300 é parcial, com R$ 200 de saldo. */
export function mapearManual(linha: LinhaManual, hoje: string): Recebivel {
  const valor = centavosDe(linha.valor);
  const somado = linha.recebido != null ? centavosDe(linha.recebido) : linha.recebido_em ? valor : 0;
  const recebido = Math.min(valor, Math.max(0, somado));
  const status = statusReceber({
    cancelado: false,
    reembolsado: false,
    valorCentavos: valor,
    recebidoCentavos: recebido,
    vencimento: linha.vencimento,
    hoje,
  });
  const atraso = diasDeAtraso(status, linha.vencimento, hoje);
  const cliente = [linha.contraparte, linha.descricao].filter(Boolean).join(" · ");
  return {
    id: linha.id,
    origem: "ENTRADA_MANUAL",
    pagamentoId: linha.id,
    cliente,
    festaId: linha.festa_id,
    pacote: linha.festa ?? "Entrada manual",
    data: linha.vencimento,
    parcela: 0,
    vencimento: linha.vencimento,
    valorCentavos: valor,
    recebidoCentavos: recebido,
    saldoCentavos: saldoCentavos(valor, recebido),
    forma: linha.forma ?? "",
    status,
    diasAtraso: atraso,
  };
}

export async function listarRecebiveis(tx: DbExecutor, empresaId: string, hoje: string) {
  const resultado = await tx.query<LinhaReceber>(RECEBER_SQL, [empresaId]);
  const manuais = await tx.query<LinhaManual>(manualSql(await esquemaP2(tx)), [empresaId]);
  return [...consolidarTitulos(resultado.rows, hoje), ...manuais.rows.map((linha) => mapearManual(linha, hoje))]
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento) || a.cliente.localeCompare(b.cliente));
}

/**
 * Quantas linhas `listarRecebiveis` devolveria, contando no banco e parando em `teto` + 1 (trabalho e memória limitados).
 * Usa a mesma seleção de títulos da lista e conta uma linha por entrada manual. Quem precisa recusar volumes grandes
 * chama antes de materializar a lista.
 */
export async function contarRecebiveis(tx: DbExecutor, empresaId: string, teto: number) {
  const r = await tx.query<{ n: number }>(`
    SELECT (SELECT count(*) FROM (
              SELECT 1
              ${TITULOS_VIGENTES_SQL}
               LIMIT $2) parcelas)
         + (SELECT count(*) FROM (SELECT 1 FROM financeiro_entradas_manuais entrada WHERE entrada.empresa_id = $1::uuid LIMIT $2) manuais)
         AS n`, [empresaId, teto + 1]);
  return Number(r.rows[0]?.n ?? 0);
}

type LinhaPagar = {
  id: string;
  descricao: string;
  favorecido: string | null;
  categoria: string;
  categoria_id: string;
  festa_id: string | null;
  valor: string;
  vencimento: string;
  competencia: string | null;
  forma: string | null;
  observacao: string | null;
  cancelado_em: string | null;
  pago: string;
};

export type ContaPagar = {
  id: string;
  descricao: string;
  favorecido: string | null;
  categoria: string;
  categoriaId: string;
  festaId: string | null;
  valorCentavos: number;
  pagoCentavos: number;
  saldoCentavos: number;
  vencimento: string;
  competencia: string | null;
  forma: string | null;
  observacao: string | null;
  status: StatusPagar;
};

function mapearPagar(linha: LinhaPagar, hoje: string): ContaPagar {
  const valor = centavosDe(linha.valor);
  const pago = centavosDe(linha.pago);
  return {
    id: linha.id,
    descricao: linha.descricao,
    favorecido: linha.favorecido,
    categoria: linha.categoria,
    categoriaId: linha.categoria_id,
    festaId: linha.festa_id,
    valorCentavos: valor,
    pagoCentavos: pago,
    saldoCentavos: saldoCentavos(valor, pago),
    vencimento: linha.vencimento,
    competencia: linha.competencia,
    forma: linha.forma,
    observacao: linha.observacao,
    status: statusPagar({
      cancelado: linha.cancelado_em != null,
      valorCentavos: valor,
      pagoCentavos: pago,
      vencimento: linha.vencimento,
      hoje,
    }),
  };
}

/** `pago` líquido das reversões (P2). */
const pagarSql = (e: EsquemaP2) => `
  SELECT conta.id::text AS id, conta.descricao, conta.favorecido, categoria.nome AS categoria,
         categoria.id::text AS categoria_id, conta.festa_id::text AS festa_id, conta.valor::text AS valor,
         conta.vencimento::text AS vencimento, conta.competencia::text AS competencia, conta.forma,
         conta.observacao, conta.cancelado_em::text AS cancelado_em,
         COALESCE((SELECT SUM(saida.valor) FROM (${saidasLiquidasSql(e)}) saida WHERE saida.conta_id = conta.id), 0)::text AS pago
    FROM financeiro_contas_pagar conta
    JOIN financeiro_categorias categoria ON categoria.id = conta.categoria_id AND categoria.empresa_id = conta.empresa_id
   WHERE conta.empresa_id = $1::uuid
   ORDER BY conta.vencimento, conta.descricao
`;

export async function listarContasPagar(tx: DbExecutor, empresaId: string, hoje: string) {
  await garantirCategorias(tx, empresaId);
  const resultado = await tx.query<LinhaPagar>(pagarSql(await esquemaP2(tx)), [empresaId]);
  return resultado.rows.map((linha) => mapearPagar(linha, hoje));
}

/** `pagoMesCentavos` nulo = saídas fora do alcance desta leitura: sem movimento do período, em vez de um número só com as entradas. */
export function resumo(recebiveis: Recebivel[], contas: ContaPagar[], recebidoMesCentavos: number, hoje: string, pagoMesCentavos: number | null = null) {
  const abertos = recebiveis.filter((item) => item.status === "A receber" || item.status === "Parcialmente pago" || item.status === "Vencido");
  const aReceber = abertos.reduce((total, item) => total + item.saldoCentavos, 0);
  const emAtrasoReceber = recebiveis.filter((item) => item.status === "Vencido").reduce((total, item) => total + item.saldoCentavos, 0);
  const aPagar = contas.filter((item) => PAGAR_EM_ABERTO.has(item.status)).reduce((total, item) => total + item.saldoCentavos, 0);
  const emAtrasoPagar = contas.filter((item) => item.status === "Vencido").reduce((total, item) => total + item.saldoCentavos, 0);
  const limite30 = somarDias(hoje, 30);
  const aPagar30 = contas
    .filter((item) => (item.status === "A pagar" || item.status === "Parcialmente paga") && item.vencimento >= hoje && item.vencimento <= limite30)
    .reduce((total, item) => total + item.saldoCentavos, 0);
  return {
    recebidoMesCentavos,
    aReceberCentavos: aReceber,
    aPagarCentavos: aPagar,
    aPagar30DiasCentavos: aPagar30,
    emAtrasoReceberCentavos: emAtrasoReceber,
    emAtrasoPagarCentavos: emAtrasoPagar,
    movimentoPeriodoCentavos: pagoMesCentavos == null ? null : recebidoMesCentavos - pagoMesCentavos,
    pagoMesCentavos: pagoMesCentavos ?? 0,
    versao: VERSAO_RESUMO_FINANCEIRO,
  };
}

/** Data de Brasília de um horário real (estorno confirmado, devolução concluída). Não depende do timezone da sessão. */
function dataBrasiliaSql(coluna: string) {
  return `(${coluna} AT TIME ZONE 'America/Sao_Paulo')::date`;
}

/**
 * Data civil da baixa. A baixa manual grava a data escolhida à meia-noite UTC; esse instante exato é a própria data.
 * Qualquer outro é um horário real e vale a data de Brasília. Só vale para `recebido_em`: estorno e devolução
 * gravam horário real, e meia-noite UTC neles é 21:00 de Brasília do dia anterior.
 */
function dataCivilSql(coluna: string) {
  return `(CASE WHEN ${coluna} = (date_trunc('day', ${coluna} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    THEN (${coluna} AT TIME ZONE 'UTC')::date
    ELSE (${coluna} AT TIME ZONE 'America/Sao_Paulo')::date END)`;
}

const DATA_RECEBIDO_SQL = dataCivilSql("rec.recebido_em");

const LIQUIDO_RECEBIDO_SQL = `(rec.valor_bruto - LEAST(rec.valor_bruto, COALESCE((rec.metadata_provedor->>'taxaCentavos')::numeric, 0) / 100))`;

const RECEBIDO_EMPRESA_SQL = `
  FROM pagamento_recebimentos rec
  JOIN pagamentos pag ON pag.id = rec.pagamento_id
  JOIN contrato_versoes ver ON ver.id = pag.contrato_versao_id
  JOIN contratos contrato ON contrato.id = ver.contrato_id
  JOIN fechamentos fech ON fech.id = contrato.fechamento_id
  JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
 WHERE rec.status = 'CONFIRMADO'
`;

const LIQUIDO_MANUAL_SQL = `(valor - LEAST(valor, taxa))`;

type Abatimento = { data: string; tipo: "ESTORNO" | "DEVOLUCAO"; centavos: number; festaId: string | null; forma: string; origemId?: string };

/**
 * Saídas de caixa do motor: estorno confirmado e devolução concluída, na data em que ocorreram. Reserva e devolução
 * pendente não saem do caixa. A taxa do recebimento original não volta: ela já ficou fora do líquido.
 */
async function abatimentosContratuais(
  tx: DbExecutor,
  empresaId: string,
  filtro: { inicio?: string; fim?: string; antesDe?: string; festaId?: string } = {},
): Promise<Abatimento[]> {
  const contrato = `
       JOIN contrato_versoes ver ON ver.id = pag.contrato_versao_id
       JOIN contratos contrato ON contrato.id = ver.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
       LEFT JOIN festas festa ON festa.contrato_id = contrato.id AND festa.invalidada_em IS NULL`;
  const resultado = await tx.query<{ data: string; tipo: Abatimento["tipo"]; centavos: string; festa_id: string | null; forma: string; origem_id: string }>(
    `SELECT mov.data::text AS data, mov.tipo, mov.centavos::text AS centavos, mov.festa_id, mov.forma, mov.origem_id
       FROM (
         SELECT ${dataBrasiliaSql("est.confirmado_em")} AS data, 'ESTORNO' AS tipo, (est.valor * 100)::bigint AS centavos,
                festa.id::text AS festa_id, COALESCE(rec.metadata_provedor->>'forma', rec.meio_pagamento)::text AS forma,
                est.id::text AS origem_id
           FROM pagamento_estornos est
           JOIN pagamento_recebimentos rec ON rec.id = est.recebimento_id
           JOIN pagamentos pag ON pag.id = rec.pagamento_id
           ${contrato}
          WHERE est.status = 'CONFIRMADO'
         UNION ALL
         SELECT ${dataBrasiliaSql("dev.devolvido_em")}, 'DEVOLUCAO', dev.valor_centavos,
                festa.id::text, dev.meio_devolucao::text, dev.id::text
           FROM pagamento_devolucoes dev
           JOIN pagamentos pag ON pag.id = dev.pagamento_id
           ${contrato}
          WHERE dev.estado = 'CONCLUIDA'
       ) mov
      WHERE ($2::date IS NULL OR mov.data >= $2::date)
        AND ($3::date IS NULL OR mov.data <= $3::date)
        AND ($4::date IS NULL OR mov.data < $4::date)
        AND ($5::text IS NULL OR mov.festa_id = $5::text)
      ORDER BY 1`,
    [empresaId, filtro.inicio ?? null, filtro.fim ?? null, filtro.antesDe ?? null, filtro.festaId ?? null],
  );
  return resultado.rows.map(abatimentoDeLinha);
}

/** A coluna `centavos` já vem em centavos inteiros (estorno × 100, devolução em centavos): não passa por centavosDe. */
export function abatimentoDeLinha(linha: { data: string; tipo: Abatimento["tipo"]; centavos: string; festa_id: string | null; forma: string; origem_id?: string }): Abatimento {
  const centavos = Number(linha.centavos);
  if (!/^-?\d+$/.test(linha.centavos) || !Number.isSafeInteger(centavos)) throw new Error("abatimento sem centavos inteiros");
  return { data: linha.data, tipo: linha.tipo, centavos, festaId: linha.festa_id, forma: linha.forma, ...(linha.origem_id ? { origemId: linha.origem_id } : {}) };
}

function somaAbatimentos(itens: Abatimento[]) {
  return itens.reduce((total, item) => total + item.centavos, 0);
}

/**
 * Recebimentos de cartão ou boleto sem taxa informada no período. Ausente ou zero não prova que não houve tarifa.
 * Dinheiro, transferência e Pix ficam de fora, para não alertar onde normalmente não há tarifa.
 */
async function recebimentosSemTaxa(tx: DbExecutor, empresaId: string, inicio: string, fim: string) {
  const manuais = manuaisRecebidasSql(await esquemaP2(tx));
  const resultado = await tx.query<{ n: number }>(
    `SELECT (SELECT count(*)
               ${RECEBIDO_EMPRESA_SQL}
               AND ${DATA_RECEBIDO_SQL} BETWEEN $2::date AND $3::date
               AND (rec.meio_pagamento = 'CARTAO' OR rec.metadata_provedor->>'forma' IN ('CARTAO_CREDITO', 'CARTAO_DEBITO', 'BOLETO'))
               AND COALESCE((rec.metadata_provedor->>'taxaCentavos')::numeric, 0) = 0)
          + (SELECT count(*)
               FROM (${manuais}) entrada
              WHERE entrada.recebido_em BETWEEN $2::date AND $3::date
                AND entrada.forma IN ('CARTAO_CREDITO', 'CARTAO_DEBITO', 'BOLETO')
                AND entrada.taxa = 0) AS n`,
    [empresaId, inicio, fim],
  );
  return Number(resultado.rows[0]?.n ?? 0);
}

async function liquidoManualNoPeriodo(tx: DbExecutor, empresaId: string, inicio: string, fim: string) {
  const resultado = await tx.query<{ liquido: string }>(
    `SELECT COALESCE(SUM(${LIQUIDO_MANUAL_SQL}), 0)::text AS liquido
       FROM (${manuaisRecebidasSql(await esquemaP2(tx))}) entrada
      WHERE entrada.recebido_em BETWEEN $2::date AND $3::date`,
    [empresaId, inicio, fim],
  );
  return centavosDe(resultado.rows[0]?.liquido ?? "0");
}

/** Caixa de entrada do período: recebido líquido das taxas informadas, menos estornos e devoluções efetivos. Pode ser negativo. */
export async function recebidoNoPeriodo(tx: DbExecutor, empresaId: string, inicio: string, fim: string) {
  const resultado = await tx.query<{ liquido: string }>(
    `SELECT COALESCE(SUM(${LIQUIDO_RECEBIDO_SQL}), 0)::text AS liquido
       ${RECEBIDO_EMPRESA_SQL}
       AND ${DATA_RECEBIDO_SQL} BETWEEN $2::date AND $3::date`,
    [empresaId, inicio, fim],
  );
  return centavosDe(resultado.rows[0]?.liquido ?? "0")
    + await liquidoManualNoPeriodo(tx, empresaId, inicio, fim)
    - somaAbatimentos(await abatimentosContratuais(tx, empresaId, { inicio, fim }));
}

export async function liquidoRecebidoPorFesta(
  tx: DbExecutor,
  empresaId: string,
  festaId?: string,
  periodo?: { inicio: string; fim: string },
) {
  const resultado = await tx.query<{ festa_id: string; liquido: string }>(
    `SELECT festa.id::text AS festa_id, COALESCE(SUM(${LIQUIDO_RECEBIDO_SQL}), 0)::text AS liquido
       FROM pagamento_recebimentos rec
       JOIN pagamentos pag ON pag.id = rec.pagamento_id
       JOIN contrato_versoes ver ON ver.id = pag.contrato_versao_id
       JOIN contratos contrato ON contrato.id = ver.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
       JOIN festas festa ON festa.contrato_id = contrato.id AND festa.invalidada_em IS NULL
      WHERE rec.status = 'CONFIRMADO'
        AND ($2::uuid IS NULL OR festa.id = $2::uuid)
        AND ($3::date IS NULL OR ${DATA_RECEBIDO_SQL} BETWEEN $3::date AND $4::date)
      GROUP BY festa.id`,
    [empresaId, festaId ?? null, periodo?.inicio ?? null, periodo?.fim ?? null],
  );
  const mapa = new Map(resultado.rows.map((linha) => [linha.festa_id, centavosDe(linha.liquido)]));
  const manuais = await tx.query<{ festa_id: string; liquido: string }>(
    `SELECT entrada.festa_id::text AS festa_id, COALESCE(SUM(${LIQUIDO_MANUAL_SQL}), 0)::text AS liquido
       FROM (${manuaisRecebidasSql(await esquemaP2(tx))}) entrada
      WHERE entrada.festa_id IS NOT NULL
        AND ($2::uuid IS NULL OR entrada.festa_id = $2::uuid)
        AND ($3::date IS NULL OR entrada.recebido_em BETWEEN $3::date AND $4::date)
      GROUP BY entrada.festa_id`,
    [empresaId, festaId ?? null, periodo?.inicio ?? null, periodo?.fim ?? null],
  );
  for (const linha of manuais.rows) mapa.set(linha.festa_id, (mapa.get(linha.festa_id) ?? 0) + centavosDe(linha.liquido));
  for (const item of await abatimentosContratuais(tx, empresaId, { inicio: periodo?.inicio, fim: periodo?.fim, festaId })) {
    if (item.festaId) mapa.set(item.festaId, (mapa.get(item.festaId) ?? 0) - item.centavos);
  }
  return mapa;
}

async function despesasPagasPorFesta(tx: DbExecutor, empresaId: string, inicio: string, fim: string) {
  const resultado = await tx.query<{ festa_id: string; pago: string }>(
    `SELECT conta.festa_id::text AS festa_id, COALESCE(SUM(saida.valor), 0)::text AS pago
       FROM (${saidasLiquidasSql(await esquemaP2(tx))}) saida
       JOIN financeiro_contas_pagar conta ON conta.id = saida.conta_id AND conta.empresa_id = saida.empresa_id
      WHERE conta.festa_id IS NOT NULL
        AND saida.pago_em BETWEEN $2::date AND $3::date
      GROUP BY conta.festa_id`,
    [empresaId, inicio, fim],
  );
  return new Map(resultado.rows.map((linha) => [linha.festa_id, centavosDe(linha.pago)]));
}

export async function recebidoNoMes(tx: DbExecutor, empresaId: string, hoje: string) {
  const { inicio, fim } = periodoSelecionado(hoje, "mes");
  return recebidoNoPeriodo(tx, empresaId, inicio, fim);
}

/** Pago no período, líquido das reversões do período (P2). Pode ser negativo se só houve reversão. */
export async function pagoNoPeriodo(tx: DbExecutor, empresaId: string, inicio: string, fim: string) {
  const resultado = await tx.query<{ pago: string }>(
    `SELECT COALESCE(SUM(saida.valor), 0)::text AS pago
       FROM (${saidasLiquidasSql(await esquemaP2(tx))}) saida
      WHERE saida.pago_em BETWEEN $2::date AND $3::date`,
    [empresaId, inicio, fim],
  );
  return centavosDe(resultado.rows[0]?.pago ?? "0");
}

function noIntervalo(dia: string, inicio: string, fim: string) {
  return dia >= inicio && dia <= fim;
}

export type LeituraPeriodo = {
  inicio: string;
  fim: string;
  faturamentoCentavos: number;
  aReceberCentavos: number;
  aPagarCentavos: number;
  inadimplenciaCentavos: number;
  ticketCentavos: number;
  pacoteMaisVendido: string;
  pacotes: Array<{ pacote: string; centavos: number }>;
  /** `margemEstimadaCentavos` nula: festa fora do escopo do período ou sem custo lançado. Nunca zero presumido. */
  margens: Array<{ festaId: string; cliente: string; margemEstimadaCentavos: number | null; resultadoCaixaCentavos: number; custosLancados: boolean; noEscopo: boolean }>;
};

/** Contratado e recebido de um conjunto de títulos. Pagamento com cronograma soma uma vez pela posição do motor. */
function somaContratual(itens: Recebivel[]) {
  const vistos = new Set<string>();
  let valor = 0;
  let recebido = 0;
  for (const item of itens) {
    if (item.motor?.cronograma) {
      if (vistos.has(item.pagamentoId)) continue;
      vistos.add(item.pagamentoId);
      valor += item.motor.obrigacaoCentavos;
      recebido += Math.max(0, item.motor.liquidoCentavos);
      continue;
    }
    valor += item.valorCentavos;
    recebido += item.recebidoCentavos;
  }
  return { valor, recebido };
}

function tituloAtivo(item: Recebivel) {
  return item.status !== "Cancelado" && item.status !== "Reembolsado";
}

export function leituraPeriodo(
  recebiveis: Recebivel[],
  contas: ContaPagar[],
  inicio: string,
  fim: string,
  liquidoPorFesta: ReadonlyMap<string, number> = new Map(),
  pagoPorFestaNoPeriodo?: ReadonlyMap<string, number>,
): LeituraPeriodo {
  const ativos = recebiveis.filter((item) => item.origem !== "ENTRADA_MANUAL" && tituloAtivo(item) && item.festaId && noIntervalo(item.data, inicio, fim));
  const titulosPorFesta = new Map<string, Recebivel[]>();
  for (const item of ativos) titulosPorFesta.set(item.festaId!, [...(titulosPorFesta.get(item.festaId!) ?? []), item]);
  const porFesta = new Map<string, { cliente: string; pacote: string; valor: number; recebido: number }>();
  for (const [festaId, titulos] of titulosPorFesta) {
    porFesta.set(festaId, { cliente: titulos[0].cliente, pacote: titulos[0].pacote, ...somaContratual(titulos) });
  }
  const festas = [...porFesta.values()];
  const faturamento = festas.reduce((total, festa) => total + festa.valor, 0);
  const contagem = new Map<string, number>();
  const receita = new Map<string, number>();
  for (const festa of festas) {
    contagem.set(festa.pacote, (contagem.get(festa.pacote) ?? 0) + 1);
    receita.set(festa.pacote, (receita.get(festa.pacote) ?? 0) + festa.valor);
  }
  const pacoteMaisVendido = [...contagem.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "—";
  const contasPeriodo = contas.filter((item) => item.status !== "Cancelado" && noIntervalo(item.vencimento, inicio, fim));
  const margens = [...porFesta.entries()].map(([festaId, festa]) => {
    const vinculadas = contas.filter((item) => item.festaId === festaId && item.status !== "Cancelado");
    const custos = vinculadas.reduce((total, item) => total + item.valorCentavos, 0);
    const pagas = pagoPorFestaNoPeriodo
      ? (pagoPorFestaNoPeriodo.get(festaId) ?? 0)
      : vinculadas.reduce((total, item) => total + item.pagoCentavos, 0);
    return {
      festaId,
      cliente: festa.cliente,
      margemEstimadaCentavos: vinculadas.length ? margemEstimada(festa.valor, custos) : null,
      resultadoCaixaCentavos: resultadoCaixa(liquidoPorFesta.get(festaId) ?? 0, pagas),
      custosLancados: vinculadas.length > 0,
      noEscopo: true,
    };
  });
  // Festa com movimento de caixa no período, mas evento em outra data: resultado de caixa, sem margem presumida.
  // Só no modo período (mapas do período): a chave do mapa é o movimento, mesmo que entrada e estorno se anulem.
  const foraDoEscopo = pagoPorFestaNoPeriodo ? new Set([...liquidoPorFesta.keys(), ...pagoPorFestaNoPeriodo.keys()]) : new Set<string>();
  for (const festaId of foraDoEscopo) {
    const liquido = liquidoPorFesta.get(festaId) ?? 0;
    const pago = pagoPorFestaNoPeriodo?.get(festaId) ?? 0;
    if (porFesta.has(festaId)) continue;
    margens.push({
      festaId,
      cliente: recebiveis.find((item) => item.festaId === festaId)?.cliente ?? "Cliente",
      margemEstimadaCentavos: null,
      resultadoCaixaCentavos: resultadoCaixa(liquido, pago),
      custosLancados: contas.some((item) => item.festaId === festaId && item.status !== "Cancelado"),
      noEscopo: false,
    });
  }
  return {
    inicio,
    fim,
    faturamentoCentavos: faturamento,
    aReceberCentavos: recebiveis
      .filter((item) => item.status !== "Cancelado" && item.status !== "Pago" && item.status !== "Reembolsado" && noIntervalo(item.vencimento, inicio, fim))
      .reduce((total, item) => total + item.saldoCentavos, 0),
    aPagarCentavos: contasPeriodo.filter((item) => PAGAR_EM_ABERTO.has(item.status)).reduce((total, item) => total + item.saldoCentavos, 0),
    inadimplenciaCentavos: recebiveis
      .filter((item) => item.status === "Vencido" && noIntervalo(item.vencimento, inicio, fim))
      .reduce((total, item) => total + item.saldoCentavos, 0),
    ticketCentavos: festas.length ? Math.round(faturamento / festas.length) : 0,
    pacoteMaisVendido,
    pacotes: [...receita.entries()].map(([pacote, centavos]) => ({ pacote, centavos })),
    margens,
  };
}

export async function prepararBaixa(
  tx: DbExecutor,
  empresaId: string,
  hoje: string,
  input: { parcelaId: string; valor: number; data: string; forma: FormaFinanceira; taxa?: number },
) {
  if (!FORMAS.includes(input.forma)) recusar("DADOS_INVALIDOS", "Escolha uma forma de pagamento.", 409);
  if (input.data > hoje) recusar("DADOS_INVALIDOS", "A data do recebimento não pode ser futura.", 409);
  const alvo = (await listarRecebiveis(tx, empresaId, input.data)).find((item) => item.id === input.parcelaId);
  if (!alvo || alvo.origem === "ENTRADA_MANUAL" || alvo.status === "Cancelado" || alvo.status === "Pago" || alvo.status === "Reembolsado") {
    recusar("NAO_ENCONTRADO", "Esta parcela não está aberta nesta empresa.", 404);
  }
  const valor = centavosDe(input.valor);
  const taxa = centavosDe(input.taxa ?? 0);
  if (!aceitaBaixa(alvo.saldoCentavos, valor)) recusar("VALOR_EXCEDE_SALDO", "O valor passa do saldo desta parcela.", 409);
  return {
    pagamentoId: alvo.pagamentoId,
    parcelaId: alvo.id,
    valorReais: valor / 100,
    taxa,
    liquidoCentavos: liquidoCentavos(valor, taxa),
    meio: formaParaRecebimento(input.forma),
  };
}

export async function auditarRecebimento(tx: DbExecutor, empresaId: string, atorId: string, parcelaId: string, valorReais: number) {
  await auditar(tx, empresaId, "RECEBIMENTO_REGISTRADO", "pagamento_parcelas", parcelaId, atorId, `Baixa de ${valorReais}.`);
}

export async function criarEntradaManual(
  tx: DbExecutor,
  empresaId: string,
  atorId: string,
  hoje: string,
  input: {
    descricao: string;
    contraparte?: string | null;
    festaId?: string | null;
    valor: number;
    vencimento: string;
    forma?: FormaFinanceira | null;
    status: "A receber" | "Pago";
    recebidoEm?: string | null;
    taxa?: number;
    observacao?: string | null;
    chave: string;
  },
) {
  const descricao = input.descricao.trim();
  const contraparte = input.contraparte?.trim() || null;
  const observacao = input.observacao?.trim() || null;
  const festaId = input.festaId?.trim() || null;
  const pago = input.status === "Pago";
  const recebidoEm = pago ? input.recebidoEm ?? null : null;
  const valor = centavosDe(input.valor);
  const taxa = pago ? centavosDe(input.taxa ?? 0) : 0;
  const repetida = await tx.query<{
    id: string; descricao: string; contraparte: string | null; festa_id: string | null; valor: string;
    vencimento: string; forma: string | null; observacao: string | null; recebido_em: string | null; taxa: string;
  }>(
    `SELECT id::text AS id, descricao, contraparte, festa_id::text AS festa_id, valor::text AS valor,
            vencimento::text AS vencimento, forma, observacao, recebido_em::text AS recebido_em, taxa::text AS taxa
       FROM financeiro_entradas_manuais
      WHERE empresa_id = $1::uuid AND chave_criacao = $2`,
    [empresaId, input.chave],
  );
  if (repetida.rowCount) {
    const linha = repetida.rows[0];
    const mesma = linha.descricao === descricao
      && (linha.contraparte ?? "") === (contraparte ?? "")
      && (linha.festa_id ?? "") === (festaId ?? "")
      && centavosDe(linha.valor) === valor
      && linha.vencimento === input.vencimento
      && (linha.forma ?? "") === (input.forma ?? "")
      && (linha.observacao ?? "") === (observacao ?? "")
      && (linha.recebido_em ?? "") === (recebidoEm ?? "")
      && centavosDe(linha.taxa) === taxa;
    if (!mesma) recusar("IDEMPOTENCIA_CONFLITANTE", "Esta chave já registrou outra entrada nesta empresa.", 409);
    return { reutilizado: true, id: linha.id };
  }
  if (!descricao) recusar("DADOS_INVALIDOS", "Informe a descrição.", 409);
  if (pago && !recebidoEm) recusar("DADOS_INVALIDOS", "Informe a data do recebimento.", 409);
  if (recebidoEm && recebidoEm > hoje) recusar("DADOS_INVALIDOS", "A data do recebimento não pode ser futura.", 409);
  if (taxa > valor) recusar("DADOS_INVALIDOS", "A taxa não pode passar do valor.", 409);
  if (festaId) {
    const festa = await tx.query(
      `SELECT festa.id
         FROM festas festa
         JOIN contratos contrato ON contrato.id = festa.contrato_id
         JOIN fechamentos fech ON fech.id = contrato.fechamento_id
         JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $2::uuid
        WHERE festa.id = $1::uuid AND festa.invalidada_em IS NULL`,
      [festaId, empresaId],
    );
    if (!festa.rowCount) recusar("DADOS_INVALIDOS", "A festa vinculada não é desta empresa.", 409);
  }
  const historico = input.vencimento < IMPLANTACAO_FINANCEIRO || (recebidoEm != null && recebidoEm < IMPLANTACAO_FINANCEIRO);
  const criada = await tx.query<{ id: string }>(
    `INSERT INTO financeiro_entradas_manuais (
       empresa_id, descricao, contraparte, festa_id, valor, vencimento, forma, observacao,
       recebido_em, taxa, historico, chave_criacao, criado_por
     ) VALUES (
       $1::uuid, $2, $3, $4::uuid, $5, $6::date, $7, $8, $9::date, $10, $11, $12, $13::uuid
     ) RETURNING id::text AS id`,
    [
      empresaId, descricao, contraparte, festaId, (valor / 100).toFixed(2), input.vencimento,
      input.forma ?? null, observacao, recebidoEm, (taxa / 100).toFixed(2), historico, input.chave, atorId,
    ],
  );
  const id = criada.rows[0].id;
  await auditar(tx, empresaId, "ENTRADA_MANUAL_CRIADA", "financeiro_entradas_manuais", id, atorId, historico ? `${descricao} (registro histórico).` : descricao);
  return { reutilizado: false, id };
}

type PedidoContaPagar = {
  descricao: string;
  favorecido?: string | null;
  categoriaId: string;
  valor: number;
  vencimento: string;
  competencia?: string | null;
  festaId?: string | null;
  forma?: FormaFinanceira | null;
  observacao?: string | null;
  recorrente?: boolean;
  chave?: string | null;
};

const ACAO_PEDIDO_CONTA = "CONTA_PAGAR_PEDIDO";

/** Impressão do pedido de criação, gravada na auditoria. Só hash: nenhum dado do pedido sai em claro. */
export function impressaoPedidoConta(input: PedidoContaPagar) {
  const normalizado = [
    input.recorrente === true, input.categoriaId, input.festaId ?? "", input.descricao.trim(), input.favorecido ?? "",
    centavosDe(input.valor), input.vencimento, input.competencia ?? "", input.forma ?? "", input.observacao ?? "",
  ];
  return `sha256:${createHash("sha256").update(JSON.stringify(normalizado)).digest("hex")}`;
}

/**
 * A chave vale para avulsa e série na mesma empresa. Devolve a conta já criada quando o pedido é o mesmo da criação e
 * recusa quando diverge, mesmo que a conta tenha sido editada depois.
 * Política:
 * 1. Conta com impressão (criada desde a P1): o pedido é comparado com a impressão, em qualquer modalidade.
 * 2. Sem impressão (legado): responde a conta da modalidade do pedido, como antes (série pela chave da recorrência,
 *    primeira por vencimento; avulsa pela chave da conta), comparada com o estado atual. A 052 permite a mesma chave
 *    legada nas duas tabelas, e cada modalidade continua respondendo pela sua.
 * 3. Chave legada só na outra modalidade: 409, sem criar. A criação gravaria uma impressão, que passaria a responder
 *    pela chave e invalidaria o retry intacto da conta legada.
 */
async function contaDaMesmaChave(tx: DbExecutor, empresaId: string, chave: string, input: PedidoContaPagar) {
  const encontrada = await tx.query<{
    id: string; recorrencia_id: string | null; categoria_id: string; festa_id: string | null; descricao: string; favorecido: string | null;
    valor: string; vencimento: string; competencia: string | null; forma: string | null; observacao: string | null; impressao: string | null;
  }>(
    `SELECT conta.id::text AS id, conta.recorrencia_id::text AS recorrencia_id, conta.categoria_id::text AS categoria_id,
            conta.festa_id::text AS festa_id, conta.descricao, conta.favorecido, conta.valor::text AS valor,
            conta.vencimento::text AS vencimento, conta.competencia::text AS competencia, conta.forma, conta.observacao,
            impressao.detalhe AS impressao
       FROM financeiro_contas_pagar conta
       LEFT JOIN financeiro_recorrencias serie ON serie.id = conta.recorrencia_id AND serie.empresa_id = conta.empresa_id
       LEFT JOIN LATERAL (
         SELECT aud.detalhe FROM financeiro_auditoria aud
          WHERE aud.empresa_id = conta.empresa_id AND aud.entidade_id = conta.id AND aud.acao = $3
          ORDER BY aud.criado_em, aud.id LIMIT 1
       ) impressao ON true
      WHERE conta.empresa_id = $1::uuid
        AND ((conta.chave_criacao = $2 AND conta.recorrencia_id IS NULL) OR serie.chave_idempotencia = $2)
      ORDER BY (impressao.detalhe IS NULL), conta.vencimento, conta.id`,
    [empresaId, chave, ACAO_PEDIDO_CONTA],
  );
  if (!encontrada.rowCount) return null;
  // A impressão fica na primeira conta criada; editar vencimentos da série não muda qual conta a guarda.
  const comImpressao = encontrada.rows.find((candidata) => candidata.impressao != null);
  if (comImpressao) {
    if (comImpressao.impressao !== impressaoPedidoConta(input)) recusar("IDEMPOTENCIA_CONFLITANTE", "Esta chave já registrou outra conta nesta empresa.", 409);
    return comImpressao.id;
  }
  const linha = encontrada.rows.find((candidata) => (candidata.recorrencia_id != null) === (input.recorrente === true));
  if (!linha) recusar("IDEMPOTENCIA_CONFLITANTE", "Esta chave já registrou outra conta nesta empresa.", 409);
  const mesma = linha.categoria_id === input.categoriaId
    && (linha.festa_id ?? "") === (input.festaId ?? "")
    && linha.descricao === input.descricao.trim()
    && (linha.favorecido ?? "") === (input.favorecido ?? "")
    && centavosDe(linha.valor) === centavosDe(input.valor)
    && linha.vencimento === input.vencimento
    && (linha.competencia ?? "") === (input.competencia ?? "")
    && (linha.forma ?? "") === (input.forma ?? "")
    && (linha.observacao ?? "") === (input.observacao ?? "");
  if (!mesma) recusar("IDEMPOTENCIA_CONFLITANTE", "Esta chave já registrou outra conta nesta empresa.", 409);
  return linha.id;
}

function chaveDeContaRepetida(error: unknown) {
  return chaveRepetida(error)
    && ["financeiro_recorrencias_chave_uk", "financeiro_contas_pagar_criacao_uk"].includes(String((error as { constraint?: string }).constraint));
}

export async function criarContaPagar(
  tx: DbExecutor,
  empresaId: string,
  atorId: string,
  input: PedidoContaPagar,
) {
  await garantirCategorias(tx, empresaId);
  const chave = input.chave?.trim() || null;
  if (chave) {
    // Avulsa e série gravam em tabelas com restrições únicas diferentes: a trava serializa a mesma chave entre as duas.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`financeiro_conta_pagar:${empresaId}:${chave}`]);
    const existente = await contaDaMesmaChave(tx, empresaId, chave, input);
    if (existente) return existente;
  }
  const categoria = await tx.query(
    `SELECT id FROM financeiro_categorias WHERE id = $1::uuid AND empresa_id = $2::uuid AND ativo`,
    [input.categoriaId, empresaId],
  );
  if (!categoria.rowCount) recusar("DADOS_INVALIDOS", "Escolha uma categoria desta empresa.", 409);
  if (input.festaId) {
    const festa = await tx.query(
      `SELECT festa.id
         FROM festas festa
         JOIN contratos contrato ON contrato.id = festa.contrato_id
         JOIN fechamentos fech ON fech.id = contrato.fechamento_id
         JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $2::uuid
        WHERE festa.id = $1::uuid AND festa.invalidada_em IS NULL`,
      [input.festaId, empresaId],
    );
    if (!festa.rowCount) recusar("DADOS_INVALIDOS", "Esta festa não pertence à empresa.", 409);
  }
  const valor = (centavosDe(input.valor) / 100).toFixed(2);
  let recorrenciaId: string | null = null;
  const vencimentos = input.recorrente ? vencimentosMensais(input.vencimento, HORIZONTE_RECORRENCIA_MESES) : [input.vencimento];
  // Duas conexões com a mesma chave: a segunda espera a primeira, recebe 23505 e passa a comparar o pedido.
  if (chave) await tx.query("SAVEPOINT conta_idempotente");
  try {
    if (input.recorrente) {
      const recorrencia = await tx.query<{ id: string }>(
        `INSERT INTO financeiro_recorrencias (empresa_id, horizonte_meses, chave_idempotencia) VALUES ($1::uuid, $2, $3) RETURNING id`,
        [empresaId, HORIZONTE_RECORRENCIA_MESES, chave],
      );
      recorrenciaId = recorrencia.rows[0].id;
    }
    let primeira = "";
    for (const vencimento of vencimentos) {
      const criada = await tx.query<{ id: string }>(
        `INSERT INTO financeiro_contas_pagar
           (empresa_id, categoria_id, recorrencia_id, festa_id, descricao, favorecido, valor, vencimento, competencia, forma, observacao, chave_criacao, criado_por)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::date, $9::date, $10, $11, $12, $13::uuid)
         RETURNING id`,
        [empresaId, input.categoriaId, recorrenciaId, input.festaId ?? null, input.descricao.trim(), input.favorecido ?? null, valor, vencimento, input.competencia ?? null, input.forma ?? null, input.observacao ?? null, input.recorrente ? null : chave, atorId],
      );
      primeira ||= criada.rows[0].id;
    }
    await auditar(tx, empresaId, "CONTA_PAGAR_CRIADA", "financeiro_contas_pagar", primeira, atorId, input.descricao.trim());
    if (chave) await auditar(tx, empresaId, ACAO_PEDIDO_CONTA, "financeiro_contas_pagar", primeira, atorId, impressaoPedidoConta(input));
    if (chave) await tx.query("RELEASE SAVEPOINT conta_idempotente");
    return primeira;
  } catch (error) {
    if (!chave) throw error;
    await tx.query("ROLLBACK TO SAVEPOINT conta_idempotente");
    if (!chaveDeContaRepetida(error)) throw error;
    const existente = await contaDaMesmaChave(tx, empresaId, chave, input);
    if (!existente) throw error;
    return existente;
  }
}

/**
 * Trava a conta e só DEPOIS soma os pagamentos, em outro comando. Em READ COMMITTED, um SUM no mesmo
 * SELECT ... FOR UPDATE usa o retrato tirado antes de esperar a trava: uma baixa concorrente recém-confirmada
 * ficaria de fora e a conta poderia ser paga além do valor, editada ou cancelada depois de paga.
 */
async function travarConta(tx: DbExecutor, empresaId: string, id: string) {
  const conta = await tx.query<{ valor: string; cancelado_em: string | null }>(
    `SELECT valor::text AS valor, cancelado_em::text AS cancelado_em
       FROM financeiro_contas_pagar
      WHERE id = $1::uuid AND empresa_id = $2::uuid
      FOR UPDATE`,
    [id, empresaId],
  );
  if (!conta.rowCount) recusar("NAO_ENCONTRADO", "Conta não encontrada nesta empresa.", 404);
  // Pago líquido das reversões (P2): conta com pagamento revertido volta a aceitar pagamento até o valor.
  const pago = await tx.query<{ pago: string }>(
    `SELECT COALESCE(SUM(saida.valor), 0)::text AS pago FROM (${saidasLiquidasSql(await esquemaP2(tx))}) saida WHERE saida.conta_id = $2::uuid`,
    [empresaId, id],
  );
  return { ...conta.rows[0], pago: pago.rows[0].pago };
}

export async function editarContaPagar(
  tx: DbExecutor,
  empresaId: string,
  atorId: string,
  id: string,
  input: { descricao: string; favorecido?: string | null; categoriaId: string; valor: number; vencimento: string; observacao?: string | null },
) {
  const trava = await travarConta(tx, empresaId, id);
  if (centavosDe(trava.pago) > 0) recusar("EM_USO", "Esta conta já tem pagamento e não volta a ser editada.", 409);
  const categoria = await tx.query(
    `SELECT id FROM financeiro_categorias WHERE id = $1::uuid AND empresa_id = $2::uuid AND ativo`,
    [input.categoriaId, empresaId],
  );
  if (!categoria.rowCount) recusar("DADOS_INVALIDOS", "Escolha uma categoria desta empresa.", 409);
  await tx.query(
    `UPDATE financeiro_contas_pagar
        SET descricao = $3, favorecido = $4, categoria_id = $5::uuid, valor = $6, vencimento = $7::date, observacao = $8, atualizado_em = now()
      WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [id, empresaId, input.descricao.trim(), input.favorecido ?? null, input.categoriaId, (centavosDe(input.valor) / 100).toFixed(2), input.vencimento, input.observacao ?? null],
  );
  await auditar(tx, empresaId, "CONTA_PAGAR_EDITADA", "financeiro_contas_pagar", id, atorId, input.descricao.trim());
}

export async function pagarConta(
  tx: DbExecutor,
  empresaId: string,
  atorId: string,
  hoje: string,
  input: { contaId: string; valor: number; data: string; forma: FormaFinanceira; observacao?: string; chave: string },
) {
  const repetida = await tx.query<{ id: string; conta_id: string; valor: string; pago_em: string; forma: string; observacao: string | null }>(
    `SELECT id::text AS id, conta_id::text AS conta_id, valor::text AS valor, pago_em::text AS pago_em, forma, observacao
       FROM financeiro_saidas
      WHERE empresa_id = $1::uuid AND chave_idempotencia = $2`,
    [empresaId, input.chave],
  );
  if (repetida.rowCount) {
    const linha = repetida.rows[0];
    if (!mesmaSaida(linha, input)) recusar("IDEMPOTENCIA_CONFLITANTE", "Esta chave já registrou outro pagamento nesta empresa.", 409);
    return { reutilizado: true, id: linha.id };
  }
  if (input.data > hoje) recusar("DADOS_INVALIDOS", "A data do pagamento não pode ser futura.", 409);
  const trava = await travarConta(tx, empresaId, input.contaId);
  if (trava.cancelado_em) recusar("CANCELADA", "Conta cancelada não recebe pagamento.", 409);
  const saldo = saldoCentavos(centavosDe(trava.valor), centavosDe(trava.pago));
  const valor = centavosDe(input.valor);
  if (!aceitaBaixa(saldo, valor)) recusar("VALOR_EXCEDE_SALDO", "O valor passa do saldo desta conta.", 409);
  await tx.query("SAVEPOINT saida_idempotente");
  try {
    const criada = await tx.query<{ id: string }>(
      `INSERT INTO financeiro_saidas (empresa_id, conta_id, valor, pago_em, forma, observacao, chave_idempotencia, criado_por)
       VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::uuid)
       RETURNING id::text AS id`,
      [empresaId, input.contaId, (valor / 100).toFixed(2), input.data, input.forma, input.observacao ?? null, input.chave, atorId],
    );
    await tx.query("RELEASE SAVEPOINT saida_idempotente");
    await auditar(tx, empresaId, "PAGAMENTO_REGISTRADO", "financeiro_contas_pagar", input.contaId, atorId, `Pagamento de ${valor} centavos.`);
    return { reutilizado: false, id: criada.rows[0].id };
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT saida_idempotente");
    if (!chaveRepetida(error)) throw error;
    const deNovo = await tx.query<{ id: string; conta_id: string; valor: string; pago_em: string; forma: string; observacao: string | null }>(
      `SELECT id::text AS id, conta_id::text AS conta_id, valor::text AS valor, pago_em::text AS pago_em, forma, observacao
         FROM financeiro_saidas WHERE chave_idempotencia = $1 AND empresa_id = $2::uuid`,
      [input.chave, empresaId],
    );
    if (!deNovo.rowCount || !mesmaSaida(deNovo.rows[0], input)) {
      recusar("IDEMPOTENCIA_CONFLITANTE", "Esta chave já registrou outro pagamento nesta empresa.", 409);
    }
    return { reutilizado: true, id: deNovo.rows[0].id };
  }
}

function mesmaSaida(
  linha: { conta_id: string; valor: string; pago_em: string; forma: string; observacao: string | null },
  input: { contaId: string; valor: number; data: string; forma: FormaFinanceira; observacao?: string },
) {
  return linha.conta_id === input.contaId
    && centavosDe(linha.valor) === centavosDe(input.valor)
    && linha.pago_em === input.data
    && linha.forma === input.forma
    && (linha.observacao ?? "").trim() === (input.observacao ?? "").trim();
}

function chaveRepetida(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "23505";
}

export async function cancelarConta(tx: DbExecutor, empresaId: string, atorId: string, id: string) {
  const trava = await travarConta(tx, empresaId, id);
  if (centavosDe(trava.pago) > 0) recusar("EM_USO", "Estorne o pagamento antes de cancelar esta conta.", 409);
  const atualizada = await tx.query(
    `UPDATE financeiro_contas_pagar
        SET cancelado_em = COALESCE(cancelado_em, now()), atualizado_em = now()
      WHERE id = $1::uuid AND empresa_id = $2::uuid
      RETURNING id`,
    [id, empresaId],
  );
  if (!atualizada.rowCount) recusar("NAO_ENCONTRADO", "Conta não encontrada nesta empresa.", 404);
  await auditar(tx, empresaId, "CONTA_CANCELADA", "financeiro_contas_pagar", id, atorId, "Conta cancelada.");
}

/** `despesasIncluidas` = o plano inclui contas a pagar; sem ele, custos/margem/caixa não são calculados (dados preservados). */
export async function financeiroDaFesta(tx: DbExecutor, empresaId: string, festaId: string, hoje: string, despesasIncluidas = true) {
  const recebiveis = (await listarRecebiveis(tx, empresaId, hoje)).filter((item) => item.origem !== "ENTRADA_MANUAL" && item.festaId === festaId);
  const ativos = recebiveis.filter(tituloAtivo);
  const contratual = somaContratual(ativos);
  if (!despesasIncluidas) {
    return {
      despesasIncluidas,
      valorContratadoCentavos: contratual.valor,
      recebidoCentavos: contratual.recebido,
      aReceberCentavos: ativos.reduce((total, item) => total + item.saldoCentavos, 0),
      custosCentavos: null,
      custosLancados: null,
      margemEstimadaCentavos: null,
      resultadoCaixaCentavos: null,
      recebimentos: recebiveis,
      despesas: [],
    };
  }
  const contas = (await listarContasPagar(tx, empresaId, hoje)).filter((item) => item.festaId === festaId);
  const vinculadas = contas.filter((item) => item.status !== "Cancelado");
  const contratado = contratual.valor;
  const recebido = contratual.recebido;
  const liquido = (await liquidoRecebidoPorFesta(tx, empresaId, festaId)).get(festaId) ?? 0;
  const custos = vinculadas.reduce((total, item) => total + item.valorCentavos, 0);
  const pagas = vinculadas.reduce((total, item) => total + item.pagoCentavos, 0);
  return {
    despesasIncluidas,
    valorContratadoCentavos: contratado,
    recebidoCentavos: recebido,
    aReceberCentavos: ativos.reduce((total, item) => total + item.saldoCentavos, 0),
    custosCentavos: custos,
    custosLancados: vinculadas.length > 0,
    margemEstimadaCentavos: vinculadas.length ? margemEstimada(contratado, custos) : null,
    resultadoCaixaCentavos: resultadoCaixa(liquido, pagas),
    recebimentos: recebiveis,
    despesas: contas,
  };
}

/** `financeiroCompleto` = o plano inclui contas a pagar; sem ele, os números do painel usam só recebíveis. */
export async function painelGeral(tx: DbExecutor, empresaId: string, hoje: string, financeiroCompleto = true) {
  const recebiveis = await listarRecebiveis(tx, empresaId, hoje);
  const contas = financeiroCompleto ? await listarContasPagar(tx, empresaId, hoje) : [];
  const recebido = await recebidoNoMes(tx, empresaId, hoje);
  const mesAtual = periodoSelecionado(hoje, "mes");
  const pago = financeiroCompleto ? await pagoNoPeriodo(tx, empresaId, mesAtual.inicio, mesAtual.fim) : null;
  const numeros = resumo(recebiveis, contas, recebido, hoje, pago);
  const festas = await tx.query<{ id: string; contratoId: string; versaoId: string | null; data: string; cliente: string; pacote: string; convidados: number; status: string; hora: string }>(
    `SELECT festa.id::text AS id, contrato.id::text AS "contratoId", fluxo.versao_vigente_id::text AS "versaoId", fech.data_evento::text AS data, COALESCE(cliente.nome_completo, 'Cliente') AS cliente,
            COALESCE(NULLIF(vigente.snapshot #>> '{evento,pacote,nome}', ''), pac.nome) AS pacote, fech.convidados, contrato.status AS status, fech.horario_inicio::text AS hora
       FROM festas festa
       JOIN contratos contrato ON contrato.id = festa.contrato_id
       LEFT JOIN contrato_fluxos fluxo ON fluxo.contrato_id = contrato.id
       LEFT JOIN contrato_versoes vigente ON vigente.id = fluxo.versao_vigente_id AND vigente.contrato_id = contrato.id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
       LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id
      WHERE festa.invalidada_em IS NULL
        AND fech.data_evento >= $2::date
      ORDER BY fech.data_evento, fech.horario_inicio
      LIMIT 8`,
    [empresaId, hoje],
  );
  const pendentes = await tx.query<{ id: string; versaoId: string | null; cliente: string; n: number }>(
    `SELECT contrato.id::text AS id, fluxo.versao_em_preparacao_id::text AS "versaoId",
            COALESCE(cliente.nome_completo, 'Cliente') AS cliente, count(*) OVER ()::int AS n
       FROM contratos contrato
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
       LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id
       LEFT JOIN contrato_fluxos fluxo ON fluxo.contrato_id = contrato.id
      WHERE contrato.status = 'AGUARDANDO_ASSINATURA'
      ORDER BY fech.data_evento, contrato.id LIMIT 3`,
    [empresaId],
  );
  const mes = periodoSelecionado(hoje, "mes");
  const leituraMes = leituraPeriodo(recebiveis, contas, mes.inicio, mes.fim, await liquidoRecebidoPorFesta(tx, empresaId));
  const empresa = await tx.query<{ nome: string }>(`SELECT nome FROM empresas WHERE id = $1::uuid`, [empresaId]);
  const proximasContagem = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM festas festa
       JOIN contratos contrato ON contrato.id = festa.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
      WHERE festa.invalidada_em IS NULL
        AND fech.data_evento >= $2::date
        AND fech.data_evento < ($2::date + interval '30 days')`,
    [empresaId, hoje],
  );
  const mesResumo = await tx.query<{ realizadas: number; futuras: number }>(
    `SELECT count(*) FILTER (WHERE fech.data_evento < $3::date)::int AS realizadas,
            count(*) FILTER (WHERE fech.data_evento >= $3::date)::int AS futuras
       FROM festas festa
       JOIN contratos contrato ON contrato.id = festa.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
      WHERE festa.invalidada_em IS NULL
        AND fech.data_evento >= $2::date
        AND fech.data_evento <= $4::date`,
    [empresaId, mes.inicio, hoje, mes.fim],
  );
  const linhaMes = mesResumo.rows[0];
  // Eventos de contratos importados com data futura: só um aviso com link; nunca entram em `proximas` nem nos contadores.
  const importadosAIntegrar = await contarEventosImportadosAIntegrar(tx, empresaId, hoje);
  // P2: saldo de caixa só com abertura (D-FIN-9); sem plano completo não há saídas, então não há caixa.
  const caixa = financeiroCompleto ? await caixaDaEmpresa(tx, empresaId, hoje) : null;
  return {
    empresa: empresa.rows[0]?.nome ?? "Empresa",
    hoje,
    financeiroCompleto,
    numeros,
    caixa,
    agenda: festas.rows.filter((festa) => festa.data === hoje),
    proximas: festas.rows,
    importadosAIntegrar,
    atencao: [
      ...recebiveis.filter((item) => item.status === "Vencido").slice(0, 3).map((item) => ({
        tom: "alerta" as const, titulo: `Pagamento vencido — ${item.cliente}`, detalhe: item.vencimento, href: "/admin/financeiro/contas-receber",
      })),
      ...pendentes.rows.map((item) => ({
        tom: "aviso" as const, titulo: "Contrato aguardando assinatura", detalhe: item.cliente,
        href: `/admin/contratos?contratoId=${item.id}${item.versaoId ? `&versaoId=${item.versaoId}` : ''}#documentacao`,
      })),
    ],
    contratosPendentes: Number(pendentes.rows[0]?.n ?? 0),
    festasProximas: Number(proximasContagem.rows[0]?.n ?? 0),
    realizadas: Number(linhaMes?.realizadas ?? 0),
    futuras: Number(linhaMes?.futuras ?? 0),
    ticketCentavos: leituraMes.ticketCentavos,
    pacote: leituraMes.pacoteMaisVendido,
  };
}

/** Abertura vigente (maior versão) da empresa. `null` sem a 121 ou sem abertura confirmada: nenhum saldo absoluto. */
export async function aberturaVigente(tx: DbExecutor, empresaId: string): Promise<AberturaVigente | null> {
  if (!(await esquemaP2(tx)).abertura) return null;
  const r = await tx.query<{ id: string; versao: number; data_base: string; saldo: string; confirmada_em: string }>(
    `SELECT id::text AS id, versao, data_base::text AS data_base, saldo::text AS saldo,
            (criado_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS confirmada_em
       FROM financeiro_aberturas
      WHERE empresa_id = $1::uuid
      ORDER BY versao DESC
      LIMIT 1`,
    [empresaId],
  );
  const linha = r.rows[0];
  if (!linha) return null;
  return { id: linha.id, versao: Number(linha.versao), dataBase: linha.data_base, saldoCentavos: centavosDe(linha.saldo), confirmadaEm: linha.confirmada_em };
}

/** Origens conferidas na revisão: chave `TIPO:id` → hash da conferência de maior sequência da origem (histórico da 121). */
export async function conferidosDaAbertura(tx: DbExecutor, empresaId: string, aberturaId: string) {
  const r = await tx.query<{ origem_tipo: string; origem_id: string; atributos_hash: string; sequencia: number | string }>(
    `SELECT origem_tipo, origem_id::text AS origem_id, atributos_hash, sequencia
       FROM financeiro_abertura_conferencias
      WHERE empresa_id = $1::uuid AND abertura_id = $2::uuid
      ORDER BY origem_tipo, origem_id, sequencia`,
    [empresaId, aberturaId],
  );
  return ultimaConferencia(r.rows.map((linha) => ({ origemTipo: linha.origem_tipo, origemId: linha.origem_id, atributosHash: linha.atributos_hash, sequencia: Number(linha.sequencia) })));
}

/**
 * Movimentos efetivos de caixa com origem tipada, de `desde` a `ate` inclusive (null = sem limite). Fonte única do caixa
 * realizado, do saldo com abertura e das pendências da conferência. Entrada positiva, saída negativa; reversão de
 * pagamento de conta volta como saída negativa na data em que o dinheiro voltou.
 */
export async function movimentosCaixa(tx: DbExecutor, empresaId: string, desde: string | null, ate: string | null): Promise<MovimentoCaixa[]> {
  const e = await esquemaP2(tx);
  const filtro = (coluna: string) => `($2::date IS NULL OR ${coluna} >= $2::date) AND ($3::date IS NULL OR ${coluna} <= $3::date)`;
  const parametros = [empresaId, desde, ate];
  type Linha = { origem_tipo: TipoOrigemMovimento; origem_id: string; data: string; valor: string; taxa: string; estado: string; descricao: string; festa_id: string | null; forma: string | null };
  const recebidos = await tx.query<Linha>(
    `SELECT 'RECEBIMENTO' AS origem_tipo, rec.id::text AS origem_id, ${DATA_RECEBIDO_SQL}::text AS data,
            ${LIQUIDO_RECEBIDO_SQL}::text AS valor,
            LEAST(rec.valor_bruto, COALESCE((rec.metadata_provedor->>'taxaCentavos')::numeric, 0) / 100)::text AS taxa,
            rec.status::text AS estado, 'Recebimento' AS descricao, festa.id::text AS festa_id,
            COALESCE(rec.metadata_provedor->>'forma', rec.meio_pagamento)::text AS forma
       FROM pagamento_recebimentos rec
       JOIN pagamentos pag ON pag.id = rec.pagamento_id
       JOIN contrato_versoes ver ON ver.id = pag.contrato_versao_id
       JOIN contratos contrato ON contrato.id = ver.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
       LEFT JOIN festas festa ON festa.contrato_id = contrato.id AND festa.invalidada_em IS NULL
      WHERE rec.status = 'CONFIRMADO' AND ${filtro(DATA_RECEBIDO_SQL)}`,
    parametros,
  );
  const manuais = await tx.query<Linha>(
    `SELECT entrada.origem_tipo, entrada.origem_id::text AS origem_id, entrada.recebido_em::text AS data,
            ${LIQUIDO_MANUAL_SQL}::text AS valor, LEAST(valor, taxa)::text AS taxa, 'EFETIVO' AS estado,
            entrada.descricao, entrada.festa_id::text AS festa_id, COALESCE(entrada.forma, 'OUTRO') AS forma
       FROM (${manuaisRecebidasSql(e)}) entrada
      WHERE ${filtro("entrada.recebido_em")}`,
    parametros,
  );
  const saidas = await tx.query<Linha>(
    `SELECT saida.origem_tipo, saida.origem_id::text AS origem_id, saida.pago_em::text AS data, saida.valor::text AS valor,
            '0' AS taxa, 'EFETIVO' AS estado, conta.descricao, conta.festa_id::text AS festa_id, saida.forma
       FROM (${saidasLiquidasSql(e)}) saida
       JOIN financeiro_contas_pagar conta ON conta.id = saida.conta_id AND conta.empresa_id = saida.empresa_id
      WHERE ${filtro("saida.pago_em")}`,
    parametros,
  );
  const abatimentos = await abatimentosContratuais(tx, empresaId, { inicio: desde ?? undefined, fim: ate ?? undefined });
  const lista: MovimentoCaixa[] = [
    ...recebidos.rows.map((l) => ({ tipo: l.origem_tipo, origemId: l.origem_id, data: l.data, centavos: centavosDe(l.valor), taxaCentavos: centavosDe(l.taxa), estado: l.estado, descricao: l.descricao, festaId: l.festa_id, forma: l.forma ?? "OUTRO" })),
    ...manuais.rows.map((l) => ({ tipo: l.origem_tipo, origemId: l.origem_id, data: l.data, centavos: centavosDe(l.valor), taxaCentavos: centavosDe(l.taxa), estado: l.estado, descricao: l.descricao, festaId: l.festa_id, forma: l.forma ?? "OUTRO" })),
    ...saidas.rows.map((l) => ({
      tipo: l.origem_tipo, origemId: l.origem_id, data: l.data, centavos: -centavosDe(l.valor), taxaCentavos: 0, estado: l.estado,
      descricao: l.origem_tipo === "REVERSAO_SAIDA" ? `Pagamento revertido — ${l.descricao}` : l.descricao, festaId: l.festa_id, forma: l.forma ?? "OUTRO",
    })),
    ...abatimentos.map((item) => ({
      tipo: item.tipo, origemId: item.origemId ?? "", data: item.data, centavos: -item.centavos, taxaCentavos: 0, estado: "EFETIVO",
      descricao: item.tipo === "ESTORNO" ? "Estorno de recebimento" : "Devolução ao cliente", festaId: item.festaId, forma: item.forma,
    })),
  ];
  return lista.sort((a, b) => a.data.localeCompare(b.data));
}

const TIPOS_SAIDA: ReadonlySet<TipoOrigemMovimento> = new Set(["SAIDA", "REVERSAO_SAIDA", "ESTORNO", "DEVOLUCAO"]);

/**
 * Situação do caixa da empresa em `hoje`: saldo só com abertura (D-FIN-9), pendências da conferência (C.2.2).
 * Mesma leitura para tela, Dashboard e Copiloto.
 */
export async function caixaDaEmpresa(tx: DbExecutor, empresaId: string, hoje: string) {
  const abertura = await aberturaVigente(tx, empresaId);
  if (!abertura) {
    return { saldoCentavos: null, motivoSaldo: "SEM_ABERTURA" as const, abertura: null, pendencias: { quantidade: 0, centavos: 0 } };
  }
  const desdeD0 = abertura.dataBase <= hoje ? await movimentosCaixa(tx, empresaId, abertura.dataBase, hoje) : [];
  const saldo = saldoDoPeriodo(abertura, hoje, hoje, (de, ate) => somaMovimentos(desdeD0, de, ate));
  const pendencias = await pendenciasAtuais(tx, empresaId, abertura);
  return {
    saldoCentavos: saldo.saldoFinalCentavos,
    motivoSaldo: saldo.motivoSaldo,
    abertura: { versao: abertura.versao, dataBase: abertura.dataBase, saldoCentavos: abertura.saldoCentavos, confirmadaEm: abertura.confirmadaEm },
    pendencias: { quantidade: pendencias.quantidade, centavos: pendencias.centavos },
  };
}

/**
 * Só as pendências da conferência da abertura vigente (C.2.2), para quem não precisa do saldo: o Copiloto
 * (`atencao_hoje`). Somente leitura, sem passar por painelGeral. Sem abertura (ou sem a 121), null.
 */
export async function pendenciasDoCaixa(tx: DbExecutor, empresaId: string): Promise<{ quantidade: number; centavos: number } | null> {
  const abertura = await aberturaVigente(tx, empresaId);
  if (!abertura) return null;
  const pendencias = await pendenciasAtuais(tx, empresaId, abertura);
  return { quantidade: pendencias.quantidade, centavos: pendencias.centavos };
}

async function pendenciasAtuais(tx: DbExecutor, empresaId: string, abertura: AberturaVigente) {
  const vespera = somarDias(abertura.confirmadaEm, -1);
  if (vespera < abertura.dataBase) return pendenciasDaAbertura(abertura, [], new Map());
  const janela = await movimentosCaixa(tx, empresaId, abertura.dataBase, vespera);
  return pendenciasDaAbertura(abertura, janela, await conferidosDaAbertura(tx, empresaId, abertura.id));
}

/**
 * Caixa realizado do período (C.2.1). Sem abertura, não há saldo inicial nem final: só o movimento do período, com o
 * motivo. Antes de D0 a coluna de saldo das linhas fica vazia; com o período atravessando D0, a abertura aparece como linha.
 */
export async function fluxoCaixa(tx: DbExecutor, empresaId: string, inicio: string, fim: string, hoje: string) {
  const recebiveis = await listarRecebiveis(tx, empresaId, hoje);
  const contas = await listarContasPagar(tx, empresaId, hoje);
  const abertura = await aberturaVigente(tx, empresaId);
  const doPeriodo = await movimentosCaixa(tx, empresaId, inicio, fim);
  const desdeD0 = abertura && abertura.dataBase <= fim
    ? (abertura.dataBase >= inicio ? doPeriodo : await movimentosCaixa(tx, empresaId, abertura.dataBase, fim))
    : [];
  const saldo = saldoDoPeriodo(abertura, inicio, fim, (de, ate) => somaMovimentos(desdeD0, de, ate));
  const previstos = [
    ...recebiveis.filter((item) => item.status !== "Cancelado" && item.saldoCentavos > 0 && noIntervalo(item.vencimento, inicio, fim)).map((item) => ({
      data: item.vencimento, descricao: `A receber — ${item.cliente}`, entrada: item.saldoCentavos, saida: 0, tipo: "previsto" as const,
    })),
    ...contas.filter((item) => item.saldoCentavos > 0 && item.status !== "Cancelado" && noIntervalo(item.vencimento, inicio, fim)).map((item) => ({
      data: item.vencimento, descricao: item.descricao, entrada: 0, saida: item.saldoCentavos, tipo: "previsto" as const,
    })),
  ];
  const realizados = doPeriodo.map((m) => ({
    data: m.data,
    descricao: m.descricao,
    entrada: TIPOS_SAIDA.has(m.tipo) ? 0 : m.centavos,
    saida: TIPOS_SAIDA.has(m.tipo) ? -m.centavos : 0,
    tipo: "realizado" as string,
  }));
  const linhasRealizadas: Array<{ data: string; descricao: string; entrada: number; saida: number; tipo: string; saldo: number | null }> = [];
  let corrente: number | null = saldo.saldoInicialCentavos;
  let marcada = !(abertura && saldo.motivoSaldo === "ATRAVESSA_ABERTURA");
  for (const linha of realizados) {
    if (!marcada && abertura && linha.data >= abertura.dataBase) {
      corrente = abertura.saldoCentavos;
      linhasRealizadas.push({ data: abertura.dataBase, descricao: "Abertura de saldo", entrada: 0, saida: 0, tipo: "abertura", saldo: corrente });
      marcada = true;
    }
    if (corrente != null) corrente += linha.entrada - linha.saida;
    linhasRealizadas.push({ ...linha, saldo: corrente });
  }
  if (!marcada && abertura) {
    linhasRealizadas.push({ data: abertura.dataBase, descricao: "Abertura de saldo", entrada: 0, saida: 0, tipo: "abertura", saldo: abertura.saldoCentavos });
  }
  const linhas = [
    ...linhasRealizadas,
    ...previstos.map((linha) => ({ ...linha, saldo: null as number | null })),
  ];
  const entradasCentavos = realizados.reduce((total, linha) => total + linha.entrada, 0);
  const saidasCentavos = realizados.reduce((total, linha) => total + linha.saida, 0);
  const pendencias = abertura ? await pendenciasAtuais(tx, empresaId, abertura) : { quantidade: 0, centavos: 0 };
  return {
    versao: VERSAO_RESUMO_FINANCEIRO,
    saldoInicialCentavos: saldo.saldoInicialCentavos,
    entradasCentavos,
    saidasCentavos,
    movimentoPeriodoCentavos: entradasCentavos - saidasCentavos,
    saldoFinalCentavos: saldo.saldoFinalCentavos,
    motivoSaldo: saldo.motivoSaldo,
    abertura: abertura ? { versao: abertura.versao, dataBase: abertura.dataBase, saldoCentavos: abertura.saldoCentavos, confirmadaEm: abertura.confirmadaEm } : null,
    pendencias: { quantidade: pendencias.quantidade, centavos: pendencias.centavos },
    recebimentosSemTaxa: await recebimentosSemTaxa(tx, empresaId, inicio, fim),
    linhas,
  };
}

export async function relatorio(tx: DbExecutor, empresaId: string, inicio: string, fim: string, hoje: string) {
  const esquema = await esquemaP2(tx);
  const recebiveis = await listarRecebiveis(tx, empresaId, hoje);
  const contas = await listarContasPagar(tx, empresaId, hoje);
  const recebido = await recebidoNoPeriodo(tx, empresaId, inicio, fim);
  const periodo = { inicio, fim };
  const leitura = leituraPeriodo(
    recebiveis,
    contas,
    inicio,
    fim,
    await liquidoRecebidoPorFesta(tx, empresaId, undefined, periodo),
    await despesasPagasPorFesta(tx, empresaId, inicio, fim),
  );
  const despesas = await tx.query<{ categoria: string; valor: string }>(
    `SELECT categoria.nome AS categoria, COALESCE(SUM(saida.valor), 0)::text AS valor
       FROM (${saidasLiquidasSql(esquema)}) saida
       JOIN financeiro_contas_pagar conta ON conta.id = saida.conta_id AND conta.empresa_id = saida.empresa_id
       JOIN financeiro_categorias categoria ON categoria.id = conta.categoria_id AND categoria.empresa_id = conta.empresa_id
      WHERE saida.pago_em BETWEEN $2::date AND $3::date
      GROUP BY categoria.nome
      ORDER BY categoria.nome`,
    [empresaId, inicio, fim],
  );
  const formas = await tx.query<{ forma: string; liquido: string; taxa: string }>(
    `SELECT COALESCE(rec.metadata_provedor->>'forma', rec.meio_pagamento) AS forma,
            COALESCE(SUM(${LIQUIDO_RECEBIDO_SQL}), 0)::text AS liquido,
            COALESCE(SUM(LEAST(rec.valor_bruto, COALESCE((rec.metadata_provedor->>'taxaCentavos')::numeric, 0) / 100)), 0)::text AS taxa
       ${RECEBIDO_EMPRESA_SQL}
       AND ${DATA_RECEBIDO_SQL} BETWEEN $2::date AND $3::date
      GROUP BY 1
      ORDER BY 1`,
    [empresaId, inicio, fim],
  );
  const taxasManuais = await tx.query<{ forma: string; liquido: string; taxa: string }>(
    `SELECT COALESCE(forma, 'OUTRO') AS forma,
            COALESCE(SUM(${LIQUIDO_MANUAL_SQL}), 0)::text AS liquido,
            COALESCE(SUM(LEAST(valor, taxa)), 0)::text AS taxa
       FROM (${manuaisRecebidasSql(esquema)}) entrada
      WHERE recebido_em BETWEEN $2::date AND $3::date
      GROUP BY 1`,
    [empresaId, inicio, fim],
  );
  const formasPorNome = new Map<string, { liquido: number; taxa: number }>();
  for (const linha of [...formas.rows, ...taxasManuais.rows]) {
    const atual = formasPorNome.get(linha.forma) ?? { liquido: 0, taxa: 0 };
    atual.liquido += centavosDe(linha.liquido);
    atual.taxa += centavosDe(linha.taxa);
    formasPorNome.set(linha.forma, atual);
  }
  // A forma fecha com "Recebido no período": estorno sai da forma do recebimento, e devolução, do meio usado.
  for (const item of await abatimentosContratuais(tx, empresaId, { inicio, fim })) {
    const atual = formasPorNome.get(item.forma) ?? { liquido: 0, taxa: 0 };
    atual.liquido -= item.centavos;
    formasPorNome.set(item.forma, atual);
  }
  const taxasCentavos = [...formasPorNome.values()].reduce((total, linha) => total + linha.taxa, 0);
  return {
    // Mesmo contrato do resumo: a tela nova recusa relatório sem versão (servidor antigo, margem sem custos cheia).
    versao: VERSAO_RESUMO_FINANCEIRO,
    inicio,
    fim,
    faturamentoCentavos: leitura.faturamentoCentavos,
    recebidoCentavos: recebido,
    aReceberCentavos: leitura.aReceberCentavos,
    aPagarCentavos: leitura.aPagarCentavos,
    inadimplenciaCentavos: leitura.inadimplenciaCentavos,
    ticketCentavos: leitura.ticketCentavos,
    pacoteMaisVendido: leitura.pacoteMaisVendido,
    despesas: despesas.rows.map((linha) => ({ categoria: linha.categoria, centavos: centavosDe(linha.valor) })),
    pacotes: leitura.pacotes,
    formas: [...formasPorNome.entries()].map(([forma, linha]) => ({ forma, centavos: linha.liquido })),
    taxasCentavos,
    recebimentosSemTaxa: await recebimentosSemTaxa(tx, empresaId, inicio, fim),
    margens: leitura.margens,
  };
}

export async function estenderRecorrencia(tx: DbExecutor, empresaId: string, recorrenciaId: string, meses: number) {
  const serie = await tx.query<{ horizonte: number }>(
    `SELECT horizonte_meses AS horizonte
       FROM financeiro_recorrencias
      WHERE id = $1::uuid AND empresa_id = $2::uuid
      FOR UPDATE`,
    [recorrenciaId, empresaId],
  );
  if (!serie.rowCount) recusar("NAO_ENCONTRADO", "Recorrência não encontrada nesta empresa.", 404);
  const inicio = await tx.query<{ inicio: string }>(
    `SELECT MIN(vencimento)::text AS inicio
       FROM financeiro_contas_pagar
      WHERE recorrencia_id = $1::uuid AND empresa_id = $2::uuid`,
    [recorrenciaId, empresaId],
  );
  if (!inicio.rows[0]?.inicio) recusar("NAO_ENCONTRADO", "Recorrência sem vencimentos nesta empresa.", 404);
  const horizonte = Math.min(24, Number(serie.rows[0].horizonte) + meses);
  const modelo = await tx.query<{ categoria_id: string; festa_id: string | null; descricao: string; favorecido: string | null; valor: string; forma: string | null; observacao: string | null; criado_por: string | null }>(
    `SELECT categoria_id::text AS categoria_id, festa_id::text AS festa_id, descricao, favorecido, valor::text AS valor, forma, observacao, criado_por::text AS criado_por
       FROM financeiro_contas_pagar
      WHERE recorrencia_id = $1::uuid AND empresa_id = $2::uuid
      ORDER BY vencimento
      LIMIT 1`,
    [recorrenciaId, empresaId],
  );
  const base = modelo.rows[0];
  for (const vencimento of vencimentosMensais(inicio.rows[0].inicio, horizonte)) {
    await tx.query(
      `INSERT INTO financeiro_contas_pagar
         (empresa_id, categoria_id, recorrencia_id, festa_id, descricao, favorecido, valor, vencimento, forma, observacao, criado_por)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::date, $9, $10, $11::uuid)
       ON CONFLICT (recorrencia_id, vencimento) DO NOTHING`,
      [empresaId, base.categoria_id, recorrenciaId, base.festa_id, base.descricao, base.favorecido, base.valor, vencimento, base.forma, base.observacao, base.criado_por],
    );
  }
  await tx.query(
    `UPDATE financeiro_recorrencias SET horizonte_meses = $3 WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [recorrenciaId, empresaId, horizonte],
  );
  return horizonte;
}

export { RECEBER_SQL, pagarSql };
