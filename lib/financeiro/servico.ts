import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import {
  CATEGORIAS_DESPESA,
  FORMAS,
  HORIZONTE_RECORRENCIA_MESES,
  aceitaBaixa,
  centavosDe,
  formaParaRecebimento,
  liquidoCentavos,
  margemEstimada,
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

const RECEBER_SQL = `
  SELECT parcela.id::text AS id,
         pag.id::text AS pagamento_id,
         parcela.numero,
         parcela.valor_previsto::text AS valor,
         parcela.vencimento::text AS vencimento,
         parcela.status AS status_gravado,
         COALESCE(cliente.nome_completo, 'Cliente') AS cliente,
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
    LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id
    LEFT JOIN festas festa ON festa.contrato_id = contrato.id AND festa.invalidada_em IS NULL
    LEFT JOIN pagamento_recebimento_alocacoes aloc ON aloc.parcela_id = parcela.id
    LEFT JOIN pagamento_recebimentos rec ON rec.id = aloc.recebimento_id
   GROUP BY parcela.id, pag.id, parcela.numero, parcela.valor_previsto, parcela.vencimento, parcela.status,
            cliente.nome_completo, festa.id, pac.nome, fech.data_evento, plano.meio_pagamento
`;

type LinhaReceber = {
  id: string;
  pagamento_id: string;
  numero: number;
  valor: string;
  vencimento: string;
  status_gravado: string;
  cliente: string;
  festa_id: string | null;
  pacote: string;
  data_evento: string;
  recebido: string;
  forma: string;
};

export type Recebivel = {
  id: string;
  pagamentoId: string;
  cliente: string;
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
    pagamentoId: linha.pagamento_id,
    cliente: linha.cliente,
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

export async function listarRecebiveis(tx: DbExecutor, empresaId: string, hoje: string) {
  const resultado = await tx.query<LinhaReceber>(RECEBER_SQL, [empresaId]);
  return resultado.rows.map((linha) => mapearRecebivel(linha, hoje));
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

export function resumo(recebiveis: Recebivel[], contas: ContaPagar[], recebidoMesCentavos: number, hoje: string) {
  const abertos = recebiveis.filter((item) => item.status === "A receber" || item.status === "Parcialmente pago" || item.status === "Vencido");
  const aReceber = abertos.reduce((total, item) => total + item.saldoCentavos, 0);
  const emAtrasoReceber = recebiveis.filter((item) => item.status === "Vencido").reduce((total, item) => total + item.saldoCentavos, 0);
  const aPagar = contas.filter((item) => item.status === "A pagar" || item.status === "Vencido").reduce((total, item) => total + item.saldoCentavos, 0);
  const emAtrasoPagar = contas.filter((item) => item.status === "Vencido").reduce((total, item) => total + item.saldoCentavos, 0);
  const mes = hoje.slice(0, 7);
  const pagoMes = contas
    .filter((item) => item.pagoCentavos > 0 && item.vencimento.startsWith(mes))
    .reduce((total, item) => total + item.pagoCentavos, 0);
  return {
    recebidoMesCentavos,
    aReceberCentavos: aReceber,
    aPagarCentavos: aPagar,
    emAtrasoCentavos: emAtrasoReceber + emAtrasoPagar,
    saldoPrevistoCentavos: recebidoMesCentavos + aReceber - aPagar,
    pagoMesCentavos: pagoMes,
  };
}

export async function recebidoNoMes(tx: DbExecutor, empresaId: string, hoje: string) {
  const inicio = `${hoje.slice(0, 7)}-01`;
  const resultado = await tx.query<{ bruto: string; taxa: string }>(
    `SELECT COALESCE(SUM(rec.valor_bruto), 0)::text AS bruto,
            COALESCE(SUM(COALESCE((rec.metadata_provedor->>'taxaCentavos')::numeric, 0) / 100), 0)::text AS taxa
       FROM pagamento_recebimentos rec
       JOIN pagamentos pag ON pag.id = rec.pagamento_id
       JOIN contrato_versoes ver ON ver.id = pag.contrato_versao_id
       JOIN contratos contrato ON contrato.id = ver.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
      WHERE rec.status = 'CONFIRMADO'
        AND rec.recebido_em::date >= $2::date
        AND rec.recebido_em::date < ($2::date + interval '1 month')`,
    [empresaId, inicio],
  );
  const bruto = centavosDe(resultado.rows[0]?.bruto ?? "0");
  const taxa = centavosDe(resultado.rows[0]?.taxa ?? "0");
  return liquidoCentavos(bruto, Math.min(taxa, bruto));
}

export async function prepararBaixa(
  tx: DbExecutor,
  empresaId: string,
  input: { parcelaId: string; valor: number; data: string; forma: FormaFinanceira; taxa?: number },
) {
  if (!FORMAS.includes(input.forma)) recusar("DADOS_INVALIDOS", "Escolha uma forma de pagamento.", 409);
  const alvo = (await listarRecebiveis(tx, empresaId, input.data)).find((item) => item.id === input.parcelaId);
  if (!alvo || alvo.status === "Cancelado" || alvo.status === "Pago" || alvo.status === "Reembolsado") {
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
  },
) {
  await garantirCategorias(tx, empresaId);
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
      `INSERT INTO financeiro_recorrencias (empresa_id, horizonte_meses) VALUES ($1::uuid, $2) RETURNING id`,
      [empresaId, HORIZONTE_RECORRENCIA_MESES],
    );
    recorrenciaId = recorrencia.rows[0].id;
  }
  let primeira = "";
  for (const vencimento of vencimentos) {
    const criada = await tx.query<{ id: string }>(
      `INSERT INTO financeiro_contas_pagar
         (empresa_id, categoria_id, recorrencia_id, festa_id, descricao, favorecido, valor, vencimento, competencia, forma, observacao, criado_por)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::date, $9::date, $10, $11, $12::uuid)
       RETURNING id`,
      [empresaId, input.categoriaId, recorrenciaId, input.festaId ?? null, input.descricao.trim(), input.favorecido ?? null, valor, vencimento, input.competencia ?? null, input.forma ?? null, input.observacao ?? null, atorId],
    );
    primeira ||= criada.rows[0].id;
  }
  await auditar(tx, empresaId, "CONTA_PAGAR_CRIADA", "financeiro_contas_pagar", primeira, atorId, input.descricao.trim());
  return primeira;
}

export async function editarContaPagar(
  tx: DbExecutor,
  empresaId: string,
  atorId: string,
  id: string,
  input: { descricao: string; favorecido?: string | null; categoriaId: string; valor: number; vencimento: string; observacao?: string | null },
) {
  const trava = await tx.query<{ pago: string }>(
    `SELECT COALESCE((SELECT SUM(valor) FROM financeiro_saidas WHERE conta_id = conta.id AND empresa_id = conta.empresa_id), 0)::text AS pago
       FROM financeiro_contas_pagar conta
      WHERE conta.id = $1::uuid AND conta.empresa_id = $2::uuid
      FOR UPDATE`,
    [id, empresaId],
  );
  if (!trava.rowCount) recusar("NAO_ENCONTRADO", "Conta não encontrada nesta empresa.", 404);
  if (centavosDe(trava.rows[0].pago) > 0) recusar("EM_USO", "Esta conta já tem pagamento e não volta a ser editada.", 409);
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
  const trava = await tx.query<{ valor: string; cancelado_em: string | null; pago: string }>(
    `SELECT conta.valor::text AS valor, conta.cancelado_em::text AS cancelado_em,
            COALESCE((SELECT SUM(valor) FROM financeiro_saidas WHERE conta_id = conta.id AND empresa_id = conta.empresa_id), 0)::text AS pago
       FROM financeiro_contas_pagar conta
      WHERE conta.id = $1::uuid AND conta.empresa_id = $2::uuid
      FOR UPDATE`,
    [input.contaId, empresaId],
  );
  if (!trava.rowCount) recusar("NAO_ENCONTRADO", "Conta não encontrada nesta empresa.", 404);
  if (trava.rows[0].cancelado_em) recusar("CANCELADA", "Conta cancelada não recebe pagamento.", 409);
  const saldo = saldoCentavos(centavosDe(trava.rows[0].valor), centavosDe(trava.rows[0].pago));
  const valor = centavosDe(input.valor);
  if (!aceitaBaixa(saldo, valor)) recusar("VALOR_EXCEDE_SALDO", "O valor passa do saldo desta conta.", 409);
  const existente = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM financeiro_saidas WHERE chave_idempotencia = $1 AND empresa_id = $2::uuid`,
    [input.chave, empresaId],
  );
  if (existente.rowCount) return { reutilizado: true, id: existente.rows[0].id };
  const criada = await tx.query<{ id: string }>(
    `INSERT INTO financeiro_saidas (empresa_id, conta_id, valor, pago_em, forma, observacao, chave_idempotencia, criado_por)
     VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::uuid)
     RETURNING id::text AS id`,
    [empresaId, input.contaId, (valor / 100).toFixed(2), input.data, input.forma, input.observacao ?? null, input.chave, atorId],
  );
  await auditar(tx, empresaId, "PAGAMENTO_REGISTRADO", "financeiro_contas_pagar", input.contaId, atorId, `Pagamento de ${valor} centavos.`);
  return { reutilizado: false, id: criada.rows[0].id };
}

export async function cancelarConta(tx: DbExecutor, empresaId: string, atorId: string, id: string) {
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
  const recebiveis = (await listarRecebiveis(tx, empresaId, hoje)).filter((item) => item.festaId === festaId);
  const contas = (await listarContasPagar(tx, empresaId, hoje)).filter((item) => item.festaId === festaId);
  const contratado = recebiveis.reduce((total, item) => total + item.valorCentavos, 0);
  const recebido = recebiveis.reduce((total, item) => total + item.recebidoCentavos, 0);
  const custos = contas.filter((item) => item.status !== "Cancelado").reduce((total, item) => total + item.pagoCentavos, 0);
  return {
    valorContratadoCentavos: contratado,
    recebidoCentavos: recebido,
    aReceberCentavos: recebiveis.reduce((total, item) => total + item.saldoCentavos, 0),
    custosCentavos: custos,
    margemEstimadaCentavos: margemEstimada(recebido, custos),
    recebimentos: recebiveis,
    despesas: contas,
  };
}

export async function painelGeral(tx: DbExecutor, empresaId: string, hoje: string) {
  const recebiveis = await listarRecebiveis(tx, empresaId, hoje);
  const contas = await listarContasPagar(tx, empresaId, hoje);
  const recebido = await recebidoNoMes(tx, empresaId, hoje);
  const numeros = resumo(recebiveis, contas, recebido, hoje);
  const festas = await tx.query<{ id: string; data: string; cliente: string; pacote: string; convidados: number; status: string; hora: string }>(
    `SELECT festa.id::text AS id, fech.data_evento::text AS data, COALESCE(cliente.nome_completo, 'Cliente') AS cliente,
            pac.nome AS pacote, fech.convidados, contrato.status AS status, fech.horario_inicio::text AS hora
       FROM festas festa
       JOIN contratos contrato ON contrato.id = festa.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
       LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id
      WHERE festa.invalidada_em IS NULL
        AND fech.data_evento >= $2::date
      ORDER BY fech.data_evento, fech.horario_inicio
      LIMIT 8`,
    [empresaId, hoje],
  );
  const pendentes = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM contratos contrato
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
      WHERE contrato.status = 'AGUARDANDO_ASSINATURA'`,
    [empresaId],
  );
  const mes = `${hoje.slice(0, 7)}-01`;
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
  const mesResumo = await tx.query<{ realizadas: number; futuras: number; ticket: string; pacote: string | null }>(
    `SELECT count(*) FILTER (WHERE fech.data_evento < $3::date)::int AS realizadas,
            count(*) FILTER (WHERE fech.data_evento >= $3::date)::int AS futuras,
            COALESCE(AVG(COALESCE(fech.valor_aprovado, fech.valor_negociado, fech.valor_tabela)) FILTER (WHERE fech.data_evento < $3::date), 0)::text AS ticket,
            (SELECT pac2.nome FROM festas f2
               JOIN contratos c2 ON c2.id = f2.contrato_id
               JOIN fechamentos fe2 ON fe2.id = c2.fechamento_id
               JOIN pacotes pac2 ON pac2.id = fe2.pacote_id AND pac2.empresa_id = $1::uuid
              WHERE f2.invalidada_em IS NULL AND fe2.data_evento >= $2::date AND fe2.data_evento < ($2::date + interval '1 month')
              GROUP BY pac2.nome ORDER BY count(*) DESC LIMIT 1) AS pacote
       FROM festas festa
       JOIN contratos contrato ON contrato.id = festa.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
      WHERE festa.invalidada_em IS NULL
        AND fech.data_evento >= $2::date
        AND fech.data_evento < ($2::date + interval '1 month')`,
    [empresaId, mes, hoje],
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
      ...Array.from({ length: Number(pendentes.rows[0]?.n ?? 0) > 0 ? 1 : 0 }, () => ({
        tom: "aviso" as const, titulo: "Contrato aguardando assinatura", detalhe: `${pendentes.rows[0].n} em aberto`, href: "/admin/contratos",
      })),
    ],
    contratosPendentes: Number(pendentes.rows[0]?.n ?? 0),
    festasProximas: Number(proximasContagem.rows[0]?.n ?? 0),
    realizadas: Number(linhaMes?.realizadas ?? 0),
    futuras: Number(linhaMes?.futuras ?? 0),
    ticketCentavos: centavosDe(linhaMes?.ticket ?? "0"),
    pacote: linhaMes?.pacote ?? "—",
  };
}

export async function fluxoCaixa(tx: DbExecutor, empresaId: string, inicio: string, fim: string, hoje: string) {
  const recebiveis = await listarRecebiveis(tx, empresaId, hoje);
  const contas = await listarContasPagar(tx, empresaId, hoje);
  const entradas = await tx.query<{ data: string; descricao: string; valor: string }>(
    `SELECT rec.recebido_em::date::text AS data, 'Recebimento' AS descricao, rec.valor_bruto::text AS valor
       FROM pagamento_recebimentos rec
       JOIN pagamentos pag ON pag.id = rec.pagamento_id
       JOIN contrato_versoes ver ON ver.id = pag.contrato_versao_id
       JOIN contratos contrato ON contrato.id = ver.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
      WHERE rec.status = 'CONFIRMADO' AND rec.recebido_em::date BETWEEN $2::date AND $3::date`,
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
    ...recebiveis.filter((item) => item.saldoCentavos > 0 && item.vencimento >= inicio && item.vencimento <= fim).map((item) => ({
      data: item.vencimento, descricao: `A receber — ${item.cliente}`, entrada: item.saldoCentavos, saida: 0, tipo: "previsto" as const,
    })),
    ...contas.filter((item) => item.saldoCentavos > 0 && item.status !== "Cancelado" && item.vencimento >= inicio && item.vencimento <= fim).map((item) => ({
      data: item.vencimento, descricao: item.descricao, entrada: 0, saida: item.saldoCentavos, tipo: "previsto" as const,
    })),
  ];
  const realizados = [
    ...entradas.rows.map((item) => ({ data: item.data, descricao: item.descricao, entrada: centavosDe(item.valor), saida: 0, tipo: "realizado" as const })),
    ...saidas.rows.map((item) => ({ data: item.data, descricao: item.descricao, entrada: 0, saida: centavosDe(item.valor), tipo: "realizado" as const })),
  ];
  const linhas = [...realizados, ...previstos].sort((a, b) => a.data.localeCompare(b.data));
  let saldo = 0;
  const comSaldo = linhas.map((linha) => {
    saldo += linha.entrada - linha.saida;
    return { ...linha, saldo };
  });
  const entradasTotal = comSaldo.reduce((total, linha) => total + linha.entrada, 0);
  const saidasTotal = comSaldo.reduce((total, linha) => total + linha.saida, 0);
  return { saldoInicialCentavos: 0, entradasCentavos: entradasTotal, saidasCentavos: saidasTotal, saldoFinalCentavos: entradasTotal - saidasTotal, linhas: comSaldo };
}

export async function relatorio(tx: DbExecutor, empresaId: string, hoje: string) {
  const recebiveis = await listarRecebiveis(tx, empresaId, hoje);
  const contas = await listarContasPagar(tx, empresaId, hoje);
  const recebido = await recebidoNoMes(tx, empresaId, hoje);
  const contratado = recebiveis.reduce((total, item) => total + item.valorCentavos, 0);
  const porCategoria = new Map<string, number>();
  for (const conta of contas) {
    if (conta.status === "Cancelado") continue;
    porCategoria.set(conta.categoria, (porCategoria.get(conta.categoria) ?? 0) + conta.pagoCentavos);
  }
  const porPacote = new Map<string, number>();
  for (const item of recebiveis) porPacote.set(item.pacote, (porPacote.get(item.pacote) ?? 0) + item.recebidoCentavos);
  return {
    faturamentoCentavos: contratado,
    recebidoCentavos: recebido,
    aReceberCentavos: recebiveis.reduce((total, item) => total + item.saldoCentavos, 0),
    aPagarCentavos: contas.filter((item) => item.status !== "Cancelado" && item.status !== "Pago").reduce((total, item) => total + item.saldoCentavos, 0),
    inadimplenciaCentavos: recebiveis.filter((item) => item.status === "Vencido").reduce((total, item) => total + item.saldoCentavos, 0),
    despesas: [...porCategoria.entries()].map(([categoria, centavos]) => ({ categoria, centavos })),
    pacotes: [...porPacote.entries()].map(([pacote, centavos]) => ({ pacote, centavos })),
  };
}

export { RECEBER_SQL, PAGAR_SQL };
