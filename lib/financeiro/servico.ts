import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import {
  CATEGORIAS_DESPESA,
  FORMAS,
  HORIZONTE_RECORRENCIA_MESES,
  IMPLANTACAO_FINANCEIRO,
  aceitaBaixa,
  centavosDe,
  formaParaRecebimento,
  liquidoCentavos,
  margemEstimada,
  periodoSelecionado,
  resultadoCaixa,
  saldoCentavos,
  statusPagar,
  statusReceber,
  vencimentosMensais,
  type FormaFinanceira,
  type StatusPagar,
  type StatusReceber,
} from "./calculos.ts";

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

const RECEBER_SQL = `
  SELECT parcela.id::text AS id,
         pag.id::text AS pagamento_id,
         parcela.numero,
         parcela.valor_previsto::text AS valor,
         parcela.vencimento::text AS vencimento,
         parcela.status AS status_gravado,
         COALESCE(cliente.nome_completo, 'Cliente') AS cliente,
         cliente.id::text AS cliente_id,
         festa.id::text AS festa_id,
         pac.nome AS pacote,
         fech.data_evento::text AS data_evento,
         COALESCE(SUM(aloc.valor_alocado) FILTER (WHERE rec.status = 'CONFIRMADO'), 0)::text AS recebido,
         plano.meio_pagamento AS forma
    FROM pagamento_parcelas parcela
    JOIN pagamento_planos plano ON plano.id = parcela.plano_id AND plano.status = 'ATIVO'
    JOIN pagamentos pag ON pag.id = plano.pagamento_id
    JOIN contrato_versoes ver ON ver.id = pag.contrato_versao_id
    JOIN contratos contrato ON contrato.id = ver.contrato_id
    JOIN fechamentos fech ON fech.id = contrato.fechamento_id
    JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
    LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id AND cliente.empresa_id = $1::uuid
    LEFT JOIN festas festa ON festa.contrato_id = contrato.id AND festa.invalidada_em IS NULL
    LEFT JOIN pagamento_recebimento_alocacoes aloc ON aloc.parcela_id = parcela.id
    LEFT JOIN pagamento_recebimentos rec ON rec.id = aloc.recebimento_id
   GROUP BY parcela.id, pag.id, parcela.numero, parcela.valor_previsto, parcela.vencimento, parcela.status,
            cliente.id, cliente.nome_completo, festa.id, pac.nome, fech.data_evento, plano.meio_pagamento
`;

type LinhaReceber = {
  id: string;
  pagamento_id: string;
  numero: number;
  valor: string;
  vencimento: string;
  status_gravado: string;
  cliente: string;
  cliente_id: string | null;
  festa_id: string | null;
  pacote: string;
  data_evento: string;
  recebido: string;
  forma: string;
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
};

function mapearRecebivel(linha: LinhaReceber, hoje: string): Recebivel {
  const valor = centavosDe(linha.valor);
  const recebido = centavosDe(linha.recebido);
  const status = statusReceber({
    cancelado: linha.status_gravado === "CANCELADA",
    reembolsado: linha.status_gravado === "ESTORNADA",
    valorCentavos: valor,
    recebidoCentavos: recebido,
    vencimento: linha.vencimento,
    hoje,
  });
  const atraso = status === "Vencido"
    ? Math.max(0, Math.round((Date.parse(`${hoje}T00:00:00Z`) - Date.parse(`${linha.vencimento}T00:00:00Z`)) / 86400000))
    : 0;
  return {
    id: linha.id,
    origem: "CONTRATO",
    pagamentoId: linha.pagamento_id,
    cliente: linha.cliente,
    clienteId: linha.cliente_id,
    festaId: linha.festa_id,
    pacote: linha.pacote,
    data: linha.data_evento,
    parcela: Number(linha.numero),
    vencimento: linha.vencimento,
    valorCentavos: valor,
    recebidoCentavos: recebido,
    saldoCentavos: saldoCentavos(valor, recebido),
    forma: linha.forma,
    status,
    diasAtraso: atraso,
  };
}

const MANUAL_SQL = `
  SELECT entrada.id::text AS id, entrada.descricao, entrada.contraparte, entrada.festa_id::text AS festa_id,
         pac.nome AS festa, entrada.valor::text AS valor, entrada.vencimento::text AS vencimento,
         entrada.forma, entrada.recebido_em::text AS recebido_em, entrada.taxa::text AS taxa
    FROM financeiro_entradas_manuais entrada
    LEFT JOIN festas festa ON festa.id = entrada.festa_id AND festa.invalidada_em IS NULL
    LEFT JOIN contratos contrato ON contrato.id = festa.contrato_id
    LEFT JOIN fechamentos fech ON fech.id = contrato.fechamento_id
    LEFT JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = entrada.empresa_id
   WHERE entrada.empresa_id = $1::uuid
`;

function mapearManual(linha: {
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
}, hoje: string): Recebivel {
  const valor = centavosDe(linha.valor);
  const recebido = linha.recebido_em ? valor : 0;
  const status = statusReceber({
    cancelado: false,
    reembolsado: false,
    valorCentavos: valor,
    recebidoCentavos: recebido,
    vencimento: linha.vencimento,
    hoje,
  });
  const atraso = status === "Vencido"
    ? Math.max(0, Math.round((Date.parse(`${hoje}T00:00:00Z`) - Date.parse(`${linha.vencimento}T00:00:00Z`)) / 86400000))
    : 0;
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
  const manuais = await tx.query<{
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
  }>(MANUAL_SQL, [empresaId]);
  return [...resultado.rows.map((linha) => mapearRecebivel(linha, hoje)), ...manuais.rows.map((linha) => mapearManual(linha, hoje))]
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento) || a.cliente.localeCompare(b.cliente));
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

const PAGAR_SQL = `
  SELECT conta.id::text AS id, conta.descricao, conta.favorecido, categoria.nome AS categoria,
         categoria.id::text AS categoria_id, conta.festa_id::text AS festa_id, conta.valor::text AS valor,
         conta.vencimento::text AS vencimento, conta.competencia::text AS competencia, conta.forma,
         conta.observacao, conta.cancelado_em::text AS cancelado_em,
         COALESCE((SELECT SUM(saida.valor) FROM financeiro_saidas saida WHERE saida.conta_id = conta.id AND saida.empresa_id = conta.empresa_id), 0)::text AS pago
    FROM financeiro_contas_pagar conta
    JOIN financeiro_categorias categoria ON categoria.id = conta.categoria_id AND categoria.empresa_id = conta.empresa_id
   WHERE conta.empresa_id = $1::uuid
   ORDER BY conta.vencimento, conta.descricao
`;

export async function listarContasPagar(tx: DbExecutor, empresaId: string, hoje: string) {
  await garantirCategorias(tx, empresaId);
  const resultado = await tx.query<LinhaPagar>(PAGAR_SQL, [empresaId]);
  return resultado.rows.map((linha) => mapearPagar(linha, hoje));
}

export function resumo(recebiveis: Recebivel[], contas: ContaPagar[], recebidoMesCentavos: number, _hoje: string, pagoMesCentavos = 0) {
  const abertos = recebiveis.filter((item) => item.status === "A receber" || item.status === "Parcialmente pago" || item.status === "Vencido");
  const aReceber = abertos.reduce((total, item) => total + item.saldoCentavos, 0);
  const emAtrasoReceber = recebiveis.filter((item) => item.status === "Vencido").reduce((total, item) => total + item.saldoCentavos, 0);
  const aPagar = contas.filter((item) => item.status === "A pagar" || item.status === "Vencido").reduce((total, item) => total + item.saldoCentavos, 0);
  const emAtrasoPagar = contas.filter((item) => item.status === "Vencido").reduce((total, item) => total + item.saldoCentavos, 0);
  return {
    recebidoMesCentavos,
    aReceberCentavos: aReceber,
    aPagarCentavos: aPagar,
    emAtrasoCentavos: emAtrasoReceber + emAtrasoPagar,
    saldoPrevistoCentavos: recebidoMesCentavos + aReceber - aPagar,
    pagoMesCentavos,
  };
}

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

async function liquidoManualNoPeriodo(tx: DbExecutor, empresaId: string, inicio: string, fim: string) {
  const resultado = await tx.query<{ liquido: string }>(
    `SELECT COALESCE(SUM(${LIQUIDO_MANUAL_SQL}), 0)::text AS liquido
       FROM financeiro_entradas_manuais entrada
      WHERE entrada.empresa_id = $1::uuid
        AND entrada.recebido_em IS NOT NULL
        AND entrada.recebido_em BETWEEN $2::date AND $3::date`,
    [empresaId, inicio, fim],
  );
  return centavosDe(resultado.rows[0]?.liquido ?? "0");
}

export async function recebidoNoPeriodo(tx: DbExecutor, empresaId: string, inicio: string, fim: string) {
  const resultado = await tx.query<{ liquido: string }>(
    `SELECT COALESCE(SUM(${LIQUIDO_RECEBIDO_SQL}), 0)::text AS liquido
       ${RECEBIDO_EMPRESA_SQL}
       AND rec.recebido_em::date BETWEEN $2::date AND $3::date`,
    [empresaId, inicio, fim],
  );
  return centavosDe(resultado.rows[0]?.liquido ?? "0") + await liquidoManualNoPeriodo(tx, empresaId, inicio, fim);
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
        AND ($3::date IS NULL OR rec.recebido_em::date BETWEEN $3::date AND $4::date)
      GROUP BY festa.id`,
    [empresaId, festaId ?? null, periodo?.inicio ?? null, periodo?.fim ?? null],
  );
  const mapa = new Map(resultado.rows.map((linha) => [linha.festa_id, centavosDe(linha.liquido)]));
  const manuais = await tx.query<{ festa_id: string; liquido: string }>(
    `SELECT entrada.festa_id::text AS festa_id, COALESCE(SUM(${LIQUIDO_MANUAL_SQL}), 0)::text AS liquido
       FROM financeiro_entradas_manuais entrada
      WHERE entrada.empresa_id = $1::uuid
        AND entrada.festa_id IS NOT NULL
        AND entrada.recebido_em IS NOT NULL
        AND ($2::uuid IS NULL OR entrada.festa_id = $2::uuid)
        AND ($3::date IS NULL OR entrada.recebido_em BETWEEN $3::date AND $4::date)
      GROUP BY entrada.festa_id`,
    [empresaId, festaId ?? null, periodo?.inicio ?? null, periodo?.fim ?? null],
  );
  for (const linha of manuais.rows) mapa.set(linha.festa_id, (mapa.get(linha.festa_id) ?? 0) + centavosDe(linha.liquido));
  return mapa;
}

async function despesasPagasPorFesta(tx: DbExecutor, empresaId: string, inicio: string, fim: string) {
  const resultado = await tx.query<{ festa_id: string; pago: string }>(
    `SELECT conta.festa_id::text AS festa_id, COALESCE(SUM(saida.valor), 0)::text AS pago
       FROM financeiro_saidas saida
       JOIN financeiro_contas_pagar conta ON conta.id = saida.conta_id AND conta.empresa_id = saida.empresa_id
      WHERE saida.empresa_id = $1::uuid
        AND conta.festa_id IS NOT NULL
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

export async function pagoNoPeriodo(tx: DbExecutor, empresaId: string, inicio: string, fim: string) {
  const resultado = await tx.query<{ pago: string }>(
    `SELECT COALESCE(SUM(valor), 0)::text AS pago
       FROM financeiro_saidas
      WHERE empresa_id = $1::uuid
        AND pago_em BETWEEN $2::date AND $3::date`,
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
  margens: Array<{ festaId: string; cliente: string; margemEstimadaCentavos: number; resultadoCaixaCentavos: number }>;
};

export function leituraPeriodo(
  recebiveis: Recebivel[],
  contas: ContaPagar[],
  inicio: string,
  fim: string,
  liquidoPorFesta: ReadonlyMap<string, number> = new Map(),
  pagoPorFestaNoPeriodo?: ReadonlyMap<string, number>,
): LeituraPeriodo {
  const ativos = recebiveis.filter((item) => item.origem !== "ENTRADA_MANUAL" && item.status !== "Cancelado" && item.festaId && noIntervalo(item.data, inicio, fim));
  const porFesta = new Map<string, { cliente: string; pacote: string; valor: number; recebido: number }>();
  for (const item of ativos) {
    const atual = porFesta.get(item.festaId!) ?? { cliente: item.cliente, pacote: item.pacote, valor: 0, recebido: 0 };
    atual.valor += item.valorCentavos;
    atual.recebido += item.recebidoCentavos;
    porFesta.set(item.festaId!, atual);
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
      margemEstimadaCentavos: margemEstimada(festa.valor, custos),
      resultadoCaixaCentavos: resultadoCaixa(liquidoPorFesta.get(festaId) ?? 0, pagas),
    };
  });
  for (const [festaId, liquido] of liquidoPorFesta) {
    if (liquido <= 0 || porFesta.has(festaId)) continue;
    const cliente = recebiveis.find((item) => item.festaId === festaId)?.cliente ?? "Cliente";
    margens.push({
      festaId,
      cliente,
      margemEstimadaCentavos: 0,
      resultadoCaixaCentavos: resultadoCaixa(liquido, pagoPorFestaNoPeriodo?.get(festaId) ?? 0),
    });
  }
  return {
    inicio,
    fim,
    faturamentoCentavos: faturamento,
    aReceberCentavos: recebiveis
      .filter((item) => item.status !== "Cancelado" && item.status !== "Pago" && item.status !== "Reembolsado" && noIntervalo(item.vencimento, inicio, fim))
      .reduce((total, item) => total + item.saldoCentavos, 0),
    aPagarCentavos: contasPeriodo.filter((item) => item.status === "A pagar" || item.status === "Vencido").reduce((total, item) => total + item.saldoCentavos, 0),
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
  input: { parcelaId: string; valor: number; data: string; forma: FormaFinanceira; taxa?: number },
) {
  if (!FORMAS.includes(input.forma)) recusar("DADOS_INVALIDOS", "Escolha uma forma de pagamento.", 409);
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

export async function criarContaPagar(
  tx: DbExecutor,
  empresaId: string,
  atorId: string,
  input: {
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
  },
) {
  await garantirCategorias(tx, empresaId);
  const chave = input.chave?.trim() || null;
  if (chave && input.recorrente) {
    const serie = await tx.query<{ id: string }>(
      `SELECT id::text AS id FROM financeiro_recorrencias WHERE empresa_id = $1::uuid AND chave_idempotencia = $2`,
      [empresaId, chave],
    );
    if (serie.rowCount) {
      const primeira = await tx.query<{ id: string }>(
        `SELECT id::text AS id FROM financeiro_contas_pagar WHERE recorrencia_id = $1::uuid AND empresa_id = $2::uuid ORDER BY vencimento LIMIT 1`,
        [serie.rows[0].id, empresaId],
      );
      return primeira.rows[0].id;
    }
  }
  if (chave && !input.recorrente) {
    const existente = await tx.query<{ id: string }>(
      `SELECT id::text AS id FROM financeiro_contas_pagar WHERE empresa_id = $1::uuid AND chave_criacao = $2`,
      [empresaId, chave],
    );
    if (existente.rowCount) return existente.rows[0].id;
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
  return primeira;
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
  const pago = await tx.query<{ pago: string }>(
    `SELECT COALESCE(SUM(valor), 0)::text AS pago FROM financeiro_saidas WHERE conta_id = $1::uuid AND empresa_id = $2::uuid`,
    [id, empresaId],
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

export async function financeiroDaFesta(tx: DbExecutor, empresaId: string, festaId: string, hoje: string) {
  const recebiveis = (await listarRecebiveis(tx, empresaId, hoje)).filter((item) => item.origem !== "ENTRADA_MANUAL" && item.festaId === festaId);
  const contas = (await listarContasPagar(tx, empresaId, hoje)).filter((item) => item.festaId === festaId);
  const ativos = recebiveis.filter((item) => item.status !== "Cancelado");
  const vinculadas = contas.filter((item) => item.status !== "Cancelado");
  const contratado = ativos.reduce((total, item) => total + item.valorCentavos, 0);
  const recebido = ativos.reduce((total, item) => total + item.recebidoCentavos, 0);
  const liquido = (await liquidoRecebidoPorFesta(tx, empresaId, festaId)).get(festaId) ?? 0;
  const custos = vinculadas.reduce((total, item) => total + item.valorCentavos, 0);
  const pagas = vinculadas.reduce((total, item) => total + item.pagoCentavos, 0);
  return {
    valorContratadoCentavos: contratado,
    recebidoCentavos: recebido,
    aReceberCentavos: ativos.reduce((total, item) => total + item.saldoCentavos, 0),
    custosCentavos: custos,
    margemEstimadaCentavos: margemEstimada(contratado, custos),
    resultadoCaixaCentavos: resultadoCaixa(liquido, pagas),
    recebimentos: recebiveis,
    despesas: contas,
  };
}

export async function painelGeral(tx: DbExecutor, empresaId: string, hoje: string) {
  const recebiveis = await listarRecebiveis(tx, empresaId, hoje);
  const contas = await listarContasPagar(tx, empresaId, hoje);
  const recebido = await recebidoNoMes(tx, empresaId, hoje);
  const numeros = resumo(recebiveis, contas, recebido, hoje);
  const festas = await tx.query<{ id: string; contratoId: string; versaoId: string | null; data: string; cliente: string; pacote: string; convidados: number; status: string; hora: string }>(
    `SELECT festa.id::text AS id, contrato.id::text AS "contratoId", fluxo.versao_vigente_id::text AS "versaoId", fech.data_evento::text AS data, COALESCE(cliente.nome_completo, 'Cliente') AS cliente,
            pac.nome AS pacote, fech.convidados, contrato.status AS status, fech.horario_inicio::text AS hora
       FROM festas festa
       JOIN contratos contrato ON contrato.id = festa.contrato_id
       LEFT JOIN contrato_fluxos fluxo ON fluxo.contrato_id = contrato.id
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
  return {
    empresa: empresa.rows[0]?.nome ?? "Empresa",
    hoje,
    numeros,
    agenda: festas.rows.filter((festa) => festa.data === hoje),
    proximas: festas.rows,
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

export async function fluxoCaixa(tx: DbExecutor, empresaId: string, inicio: string, fim: string, hoje: string) {
  const recebiveis = await listarRecebiveis(tx, empresaId, hoje);
  const contas = await listarContasPagar(tx, empresaId, hoje);
  const saldoInicialCentavos = await saldoCaixaAte(tx, empresaId, inicio);
  const entradas = await tx.query<{ data: string; descricao: string; valor: string }>(
    `SELECT rec.recebido_em::date::text AS data, 'Recebimento' AS descricao, ${LIQUIDO_RECEBIDO_SQL}::text AS valor
       ${RECEBIDO_EMPRESA_SQL}
       AND rec.recebido_em::date BETWEEN $2::date AND $3::date
     UNION ALL
     SELECT entrada.recebido_em::text AS data, entrada.descricao, ${LIQUIDO_MANUAL_SQL}::text AS valor
       FROM financeiro_entradas_manuais entrada
      WHERE entrada.empresa_id = $1::uuid
        AND entrada.recebido_em BETWEEN $2::date AND $3::date`,
    [empresaId, inicio, fim],
  );
  const saidas = await tx.query<{ data: string; descricao: string; valor: string }>(
    `SELECT saida.pago_em::text AS data, conta.descricao, saida.valor::text AS valor
       FROM financeiro_saidas saida
       JOIN financeiro_contas_pagar conta ON conta.id = saida.conta_id AND conta.empresa_id = saida.empresa_id
      WHERE saida.empresa_id = $1::uuid AND saida.pago_em BETWEEN $2::date AND $3::date`,
    [empresaId, inicio, fim],
  );
  const previstos = [
    ...recebiveis.filter((item) => item.status !== "Cancelado" && item.saldoCentavos > 0 && noIntervalo(item.vencimento, inicio, fim)).map((item) => ({
      data: item.vencimento, descricao: `A receber — ${item.cliente}`, entrada: item.saldoCentavos, saida: 0, tipo: "previsto" as const,
    })),
    ...contas.filter((item) => item.saldoCentavos > 0 && item.status !== "Cancelado" && noIntervalo(item.vencimento, inicio, fim)).map((item) => ({
      data: item.vencimento, descricao: item.descricao, entrada: 0, saida: item.saldoCentavos, tipo: "previsto" as const,
    })),
  ];
  const realizados = [
    ...entradas.rows.map((item) => ({ data: item.data, descricao: item.descricao, entrada: centavosDe(item.valor), saida: 0, tipo: "realizado" as const })),
    ...saidas.rows.map((item) => ({ data: item.data, descricao: item.descricao, entrada: 0, saida: centavosDe(item.valor), tipo: "realizado" as const })),
  ].sort((a, b) => a.data.localeCompare(b.data));
  let saldo = saldoInicialCentavos;
  const linhasRealizadas = realizados.map((linha) => {
    saldo += linha.entrada - linha.saida;
    return { ...linha, saldo };
  });
  const linhas = [
    ...linhasRealizadas,
    ...previstos.map((linha) => ({ ...linha, saldo: null as number | null })),
  ];
  const entradasCentavos = realizados.reduce((total, linha) => total + linha.entrada, 0);
  const saidasCentavos = realizados.reduce((total, linha) => total + linha.saida, 0);
  return {
    saldoInicialCentavos,
    entradasCentavos,
    saidasCentavos,
    saldoFinalCentavos: saldoInicialCentavos + entradasCentavos - saidasCentavos,
    linhas,
  };
}

async function saldoCaixaAte(tx: DbExecutor, empresaId: string, inicio: string) {
  const entradas = await tx.query<{ liquido: string }>(
    `SELECT COALESCE(SUM(${LIQUIDO_RECEBIDO_SQL}), 0)::text AS liquido
       ${RECEBIDO_EMPRESA_SQL}
       AND rec.recebido_em::date < $2::date`,
    [empresaId, inicio],
  );
  const manuais = await tx.query<{ liquido: string }>(
    `SELECT COALESCE(SUM(${LIQUIDO_MANUAL_SQL}), 0)::text AS liquido
       FROM financeiro_entradas_manuais
      WHERE empresa_id = $1::uuid AND recebido_em IS NOT NULL AND recebido_em < $2::date`,
    [empresaId, inicio],
  );
  const saidas = await tx.query<{ pago: string }>(
    `SELECT COALESCE(SUM(valor), 0)::text AS pago
       FROM financeiro_saidas
      WHERE empresa_id = $1::uuid AND pago_em < $2::date`,
    [empresaId, inicio],
  );
  return centavosDe(entradas.rows[0]?.liquido ?? "0") + centavosDe(manuais.rows[0]?.liquido ?? "0") - centavosDe(saidas.rows[0]?.pago ?? "0");
}

export async function relatorio(tx: DbExecutor, empresaId: string, inicio: string, fim: string, hoje: string) {
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
       FROM financeiro_saidas saida
       JOIN financeiro_contas_pagar conta ON conta.id = saida.conta_id AND conta.empresa_id = saida.empresa_id
       JOIN financeiro_categorias categoria ON categoria.id = conta.categoria_id AND categoria.empresa_id = conta.empresa_id
      WHERE saida.empresa_id = $1::uuid
        AND saida.pago_em BETWEEN $2::date AND $3::date
      GROUP BY categoria.nome
      ORDER BY categoria.nome`,
    [empresaId, inicio, fim],
  );
  const formas = await tx.query<{ forma: string; liquido: string; taxa: string }>(
    `SELECT COALESCE(rec.metadata_provedor->>'forma', rec.meio_pagamento) AS forma,
            COALESCE(SUM(${LIQUIDO_RECEBIDO_SQL}), 0)::text AS liquido,
            COALESCE(SUM(LEAST(rec.valor_bruto, COALESCE((rec.metadata_provedor->>'taxaCentavos')::numeric, 0) / 100)), 0)::text AS taxa
       ${RECEBIDO_EMPRESA_SQL}
       AND rec.recebido_em::date BETWEEN $2::date AND $3::date
      GROUP BY 1
      ORDER BY 1`,
    [empresaId, inicio, fim],
  );
  const taxasManuais = await tx.query<{ forma: string; liquido: string; taxa: string }>(
    `SELECT COALESCE(forma, 'OUTRO') AS forma,
            COALESCE(SUM(${LIQUIDO_MANUAL_SQL}), 0)::text AS liquido,
            COALESCE(SUM(LEAST(valor, taxa)), 0)::text AS taxa
       FROM financeiro_entradas_manuais
      WHERE empresa_id = $1::uuid
        AND recebido_em IS NOT NULL
        AND recebido_em BETWEEN $2::date AND $3::date
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
  const taxasCentavos = [...formasPorNome.values()].reduce((total, linha) => total + linha.taxa, 0);
  return {
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

export { RECEBER_SQL, PAGAR_SQL };
