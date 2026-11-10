import { createHash } from "node:crypto";
import type { DbExecutor } from "../db/contracts.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { aceitaBaixa, centavosDe, saldoCentavos, somarDias, type FormaFinanceira } from "./calculos.ts";
import {
  atributosMovimento,
  chaveOrigem,
  hashConjunto,
  pendenciasDaAbertura,
  somaMovimentos,
  type AberturaVigente,
  type MovimentoCaixa,
  type TipoOrigemMovimento,
} from "./abertura.ts";
import { aberturaVigente, conferidosDaAbertura, esquemaP2, movimentosCaixa } from "./servico.ts";

/**
 * P2 fase B — escritor (plano rev. 3.2 C.2, C.2.2, E.2; plano de execução P2 §3). Grava o que a fase A já lê:
 * liquidação de entrada manual (120), reversão de pagamento de conta (120), revisão de abertura e conferência (121).
 *
 * Guarda por operação no servidor (E.2, gate 3): cada operação tem uma flag própria, DESLIGADA por padrão; só o texto
 * exato `true` liga. A guarda fica aqui no serviço, então vale para API e para qualquer chamador futuro (IA inclusive).
 * Desligar a escrita não esconde dados: leitura, exportação e pendências continuam iguais.
 *
 *   FINANCEIRO_LIQUIDACAO_ATIVA  liquidação parcial ou total de entrada manual
 *   FINANCEIRO_REVERSAO_ATIVA    reversão de pagamento de conta a pagar
 *   FINANCEIRO_ABERTURA_ATIVA    confirmar/corrigir abertura e conferir pendências
 *
 * Papéis (D-FIN-7 e complemento de 07/11): liquidação e reversão para qualquer membership administrativa da empresa
 * (Equipe e Gestão); abertura e conferência só para a Gestão (`exigirGestaoNoTenant`, na rota). Somente leitura comercial
 * já é recusado antes, em `exigirApiAdminCrmDisponivel` (mutação).
 */

type Ambiente = Record<string, string | undefined>;
export type OperacaoEscritaP2 = "LIQUIDACAO" | "REVERSAO" | "ABERTURA";
const FLAG: Record<OperacaoEscritaP2, string> = {
  LIQUIDACAO: "FINANCEIRO_LIQUIDACAO_ATIVA",
  REVERSAO: "FINANCEIRO_REVERSAO_ATIVA",
  ABERTURA: "FINANCEIRO_ABERTURA_ATIVA",
};

export function escritaP2Ligada(operacao: OperacaoEscritaP2, env: Ambiente = process.env) {
  return env[FLAG[operacao]]?.trim() === "true";
}

function recusar(code: string, message: string, status: number, detalhes?: unknown): never {
  throw new PacoteAdminError(code, message, status, detalhes ?? null);
}

/** Flag da operação e schema da P2. Chamar dentro da transação do tenant, antes de qualquer leitura de negócio. */
export async function exigirEscritaP2(tx: DbExecutor, operacao: OperacaoEscritaP2, env: Ambiente = process.env) {
  if (!escritaP2Ligada(operacao, env)) {
    recusar("OPERACAO_DESLIGADA", "Esta operação do financeiro ainda não está disponível.", 409);
  }
  const esquema = await esquemaP2(tx);
  const presente = operacao === "ABERTURA" ? esquema.abertura : esquema.movimentos;
  if (!presente) recusar("OPERACAO_DESLIGADA", "Esta operação do financeiro ainda não está disponível.", 409);
}

async function auditar(tx: DbExecutor, empresaId: string, acao: string, entidade: string, entidadeId: string, atorId: string, detalhe: string) {
  await tx.query(
    `INSERT INTO financeiro_auditoria (empresa_id, acao, entidade, entidade_id, ator_id, detalhe)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6)`,
    [empresaId, acao, entidade, entidadeId, atorId, detalhe],
  );
}

function chaveRepetida(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "23505";
}

const texto = (valor: string | null | undefined) => (valor ?? "").trim();
const reais = (centavos: number) => (centavos / 100).toFixed(2);

/**
 * Insere dentro de um savepoint. Corrida na mesma chave (23505) relê pela chave e compara; o resto propaga.
 * Assim duas conexões com a mesma chave terminam com uma linha e o mesmo resultado para as duas.
 */
async function inserirIdempotente<T>(
  tx: DbExecutor,
  nome: string,
  inserir: () => Promise<T>,
  reler: () => Promise<T | null>,
  conflito: () => never,
): Promise<{ reutilizado: boolean; valor: T }> {
  await tx.query(`SAVEPOINT ${nome}`);
  try {
    const valor = await inserir();
    await tx.query(`RELEASE SAVEPOINT ${nome}`);
    return { reutilizado: false, valor };
  } catch (error) {
    await tx.query(`ROLLBACK TO SAVEPOINT ${nome}`);
    if (!chaveRepetida(error)) throw error;
    const deNovo = await reler();
    if (deNovo == null) conflito();
    return { reutilizado: true, valor: deNovo };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Liquidação de entrada manual (120)
// ---------------------------------------------------------------------------------------------------------------------

export type PedidoLiquidacao = {
  entradaId: string;
  valor: number;
  data: string;
  forma: FormaFinanceira;
  taxa?: number;
  observacao?: string;
  chave: string;
};

type LinhaLiquidacao = { id: string; entrada_id: string; valor: string; taxa: string; recebido_em: string; forma: string; observacao: string | null };

function mesmaLiquidacao(linha: LinhaLiquidacao, input: PedidoLiquidacao) {
  return linha.entrada_id === input.entradaId
    && centavosDe(linha.valor) === centavosDe(input.valor)
    && centavosDe(linha.taxa) === centavosDe(input.taxa ?? 0)
    && linha.recebido_em === input.data
    && linha.forma === input.forma
    && texto(linha.observacao) === texto(input.observacao);
}

async function liquidacaoDaChave(tx: DbExecutor, empresaId: string, chave: string) {
  const r = await tx.query<LinhaLiquidacao>(
    `SELECT id::text AS id, entrada_id::text AS entrada_id, valor::text AS valor, taxa::text AS taxa,
            recebido_em::text AS recebido_em, forma, observacao
       FROM financeiro_entradas_liquidacoes
      WHERE empresa_id = $1::uuid AND chave_idempotencia = $2`,
    [empresaId, chave],
  );
  return r.rows[0] ?? null;
}

/**
 * Liquidação parcial ou total de uma entrada manual. Recusa acima do saldo, data futura (dia de Brasília), taxa acima do
 * valor e entrada registrada antes da P2 como recebida inteira (`recebido_em`): nela, uma liquidação nova tiraria o
 * recebimento legado da soma. Trava a entrada: duas liquidações concorrentes não passam do saldo.
 */
export async function liquidarEntradaManual(tx: DbExecutor, empresaId: string, atorId: string, hoje: string, input: PedidoLiquidacao) {
  await exigirEscritaP2(tx, "LIQUIDACAO");
  const conflito = (): never => recusar("IDEMPOTENCIA_CONFLITANTE", "Esta chave já registrou outro recebimento nesta empresa.", 409);
  const repetida = await liquidacaoDaChave(tx, empresaId, input.chave);
  if (repetida) {
    if (!mesmaLiquidacao(repetida, input)) conflito();
    return { reutilizado: true, id: repetida.id };
  }
  const valor = centavosDe(input.valor);
  const taxa = centavosDe(input.taxa ?? 0);
  if (input.data > hoje) recusar("DADOS_INVALIDOS", "A data do recebimento não pode ser futura.", 409);
  if (taxa < 0 || taxa > valor) recusar("DADOS_INVALIDOS", "A taxa não pode passar do valor.", 409);
  const entrada = await tx.query<{ valor: string; recebido_em: string | null; descricao: string }>(
    `SELECT valor::text AS valor, recebido_em::text AS recebido_em, descricao
       FROM financeiro_entradas_manuais
      WHERE id = $1::uuid AND empresa_id = $2::uuid
      FOR UPDATE`,
    [input.entradaId, empresaId],
  );
  if (!entrada.rowCount) recusar("NAO_ENCONTRADO", "Entrada não encontrada nesta empresa.", 404);
  const linha = entrada.rows[0];
  // Retry da mesma chave que esperou esta trava: a primeira já gravou; devolve o resultado em vez de julgar o saldo.
  const vencedora = await liquidacaoDaChave(tx, empresaId, input.chave);
  if (vencedora) {
    if (!mesmaLiquidacao(vencedora, input)) conflito();
    return { reutilizado: true, id: vencedora.id };
  }
  if (linha.recebido_em) recusar("JA_RECEBIDA", "Esta entrada já foi registrada como recebida.", 409);
  const somado = await tx.query<{ recebido: string }>(
    `SELECT COALESCE(SUM(valor), 0)::text AS recebido
       FROM financeiro_entradas_liquidacoes
      WHERE entrada_id = $1::uuid AND empresa_id = $2::uuid`,
    [input.entradaId, empresaId],
  );
  const saldo = saldoCentavos(centavosDe(linha.valor), centavosDe(somado.rows[0].recebido));
  if (!aceitaBaixa(saldo, valor)) recusar("VALOR_EXCEDE_SALDO", "O valor passa do saldo desta entrada.", 409);
  const gravada = await inserirIdempotente(
    tx,
    "liquidacao_idempotente",
    async () => (await tx.query<{ id: string }>(
      `INSERT INTO financeiro_entradas_liquidacoes (empresa_id, entrada_id, valor, taxa, recebido_em, forma, observacao, chave_idempotencia, criado_por)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6, $7, $8, $9::uuid)
       RETURNING id::text AS id`,
      [empresaId, input.entradaId, reais(valor), reais(taxa), input.data, input.forma, texto(input.observacao) || null, input.chave, atorId],
    )).rows[0].id,
    async () => {
      const deNovo = await liquidacaoDaChave(tx, empresaId, input.chave);
      return deNovo && mesmaLiquidacao(deNovo, input) ? deNovo.id : null;
    },
    conflito,
  );
  if (!gravada.reutilizado) {
    await auditar(tx, empresaId, "ENTRADA_LIQUIDADA", "financeiro_entradas_manuais", input.entradaId, atorId,
      `Recebimento de ${valor} centavos (taxa ${taxa}) — ${linha.descricao}.`);
  }
  return { reutilizado: gravada.reutilizado, id: gravada.valor };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reversão de pagamento de conta (120)
// ---------------------------------------------------------------------------------------------------------------------

export type PedidoReversao = {
  contaId: string;
  saidaId: string;
  valor: number;
  data: string;
  motivo: string;
  chave: string;
};

type LinhaReversao = { id: string; saida_id: string; conta_id: string; valor: string; revertido_em: string; motivo: string };

function mesmaReversao(linha: LinhaReversao, input: PedidoReversao) {
  return linha.saida_id === input.saidaId
    && linha.conta_id === input.contaId
    && centavosDe(linha.valor) === centavosDe(input.valor)
    && linha.revertido_em === input.data
    && texto(linha.motivo) === texto(input.motivo);
}

async function reversaoDaChave(tx: DbExecutor, empresaId: string, chave: string) {
  const r = await tx.query<LinhaReversao>(
    `SELECT rev.id::text AS id, rev.saida_id::text AS saida_id, saida.conta_id::text AS conta_id, rev.valor::text AS valor,
            rev.revertido_em::text AS revertido_em, rev.motivo
       FROM financeiro_saidas_reversoes rev
       JOIN financeiro_saidas saida ON saida.id = rev.saida_id AND saida.empresa_id = rev.empresa_id
      WHERE rev.empresa_id = $1::uuid AND rev.chave_idempotencia = $2`,
    [empresaId, chave],
  );
  return r.rows[0] ?? null;
}

/**
 * Reversão de um pagamento lançado (C.4, D-FIN-6): o dinheiro volta ao caixa na data informada, o pago da conta cai e a
 * obrigação, o custo e a margem contratual não mudam. Trava a conta, a mesma trava do pagamento: reversão × pagamento
 * se serializam, e a soma das reversões de uma saída nunca passa do valor dela.
 */
export async function reverterPagamentoConta(tx: DbExecutor, empresaId: string, atorId: string, hoje: string, input: PedidoReversao) {
  await exigirEscritaP2(tx, "REVERSAO");
  const conflito = (): never => recusar("IDEMPOTENCIA_CONFLITANTE", "Esta chave já registrou outra reversão nesta empresa.", 409);
  const repetida = await reversaoDaChave(tx, empresaId, input.chave);
  if (repetida) {
    if (!mesmaReversao(repetida, input)) conflito();
    return { reutilizado: true, id: repetida.id };
  }
  const motivo = texto(input.motivo);
  if (motivo.length < 3 || motivo.length > 500) recusar("DADOS_INVALIDOS", "Informe o motivo da reversão.", 409);
  if (input.data > hoje) recusar("DADOS_INVALIDOS", "A data da reversão não pode ser futura.", 409);
  const valor = centavosDe(input.valor);
  if (valor <= 0) recusar("DADOS_INVALIDOS", "Informe o valor revertido.", 409);
  const conta = await tx.query<{ descricao: string }>(
    `SELECT descricao FROM financeiro_contas_pagar WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
    [input.contaId, empresaId],
  );
  if (!conta.rowCount) recusar("NAO_ENCONTRADO", "Conta não encontrada nesta empresa.", 404);
  // Retry da mesma chave que esperou a trava da conta: devolve o que a primeira gravou.
  const vencedora = await reversaoDaChave(tx, empresaId, input.chave);
  if (vencedora) {
    if (!mesmaReversao(vencedora, input)) conflito();
    return { reutilizado: true, id: vencedora.id };
  }
  const saida = await tx.query<{ valor: string; pago_em: string; revertido: string }>(
    `SELECT saida.valor::text AS valor, saida.pago_em::text AS pago_em,
            COALESCE((SELECT SUM(rev.valor) FROM financeiro_saidas_reversoes rev
                       WHERE rev.saida_id = saida.id AND rev.empresa_id = saida.empresa_id), 0)::text AS revertido
       FROM financeiro_saidas saida
      WHERE saida.id = $1::uuid AND saida.conta_id = $2::uuid AND saida.empresa_id = $3::uuid`,
    [input.saidaId, input.contaId, empresaId],
  );
  if (!saida.rowCount) recusar("NAO_ENCONTRADO", "Pagamento não encontrado nesta conta.", 404);
  const pagamento = saida.rows[0];
  if (input.data < pagamento.pago_em) recusar("DADOS_INVALIDOS", "A reversão não pode ser anterior ao pagamento.", 409);
  const restante = saldoCentavos(centavosDe(pagamento.valor), centavosDe(pagamento.revertido));
  if (!aceitaBaixa(restante, valor)) recusar("VALOR_EXCEDE_PAGAMENTO", "O valor passa do que resta deste pagamento.", 409);
  const gravada = await inserirIdempotente(
    tx,
    "reversao_idempotente",
    async () => (await tx.query<{ id: string }>(
      `INSERT INTO financeiro_saidas_reversoes (empresa_id, saida_id, valor, revertido_em, motivo, chave_idempotencia, criado_por)
       VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7::uuid)
       RETURNING id::text AS id`,
      [empresaId, input.saidaId, reais(valor), input.data, motivo, input.chave, atorId],
    )).rows[0].id,
    async () => {
      const deNovo = await reversaoDaChave(tx, empresaId, input.chave);
      return deNovo && mesmaReversao(deNovo, input) ? deNovo.id : null;
    },
    conflito,
  );
  if (!gravada.reutilizado) {
    await auditar(tx, empresaId, "PAGAMENTO_REVERTIDO", "financeiro_contas_pagar", input.contaId, atorId,
      `Reversão de ${valor} centavos — ${motivo}`);
  }
  return { reutilizado: gravada.reutilizado, id: gravada.valor };
}

// ---------------------------------------------------------------------------------------------------------------------
// Abertura (121): prévia, confirmação/correção e conferência
// ---------------------------------------------------------------------------------------------------------------------

/** Trava por empresa da abertura: confirmar, corrigir e conferir se serializam. */
async function travarAbertura(tx: DbExecutor, empresaId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:financeiro-abertura'), hashtext($1))", [empresaId]);
}

/**
 * Dia de Brasília pelo relógio do banco: é o mesmo relógio de `criado_em`, de onde o leitor tira `confirmadaEm`.
 * Assim a janela conferida na gravação é exatamente a que o leitor usa para as pendências, mesmo perto da meia-noite.
 */
async function hojeDoBanco(tx: DbExecutor) {
  const r = await tx.query<{ hoje: string }>(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS hoje`);
  return r.rows[0].hoje;
}

export type MovimentoVisto = MovimentoCaixa & { atributosHash: string };

const visto = (m: MovimentoCaixa): MovimentoVisto => ({ ...m, atributosHash: atributosMovimento(m) });

export type PreviaAbertura = {
  dataBase: string;
  /** Janela conferida: de D0 até a véspera da confirmação. Vazia quando D0 é hoje. */
  janela: { de: string; ate: string } | null;
  movimentos: MovimentoVisto[];
  conjuntoHash: string;
  /** Movimentos de D0 até hoje: saldo resultante = saldo informado + este total. */
  movimentoDesdeD0Centavos: number;
};

async function montarPrevia(tx: DbExecutor, empresaId: string, dataBase: string, hoje: string): Promise<PreviaAbertura> {
  const desdeD0 = await movimentosCaixa(tx, empresaId, dataBase, hoje);
  const vespera = somarDias(hoje, -1);
  const janela = desdeD0.filter((m) => m.data <= vespera);
  for (const m of janela) if (!m.origemId) throw new Error("movimento sem origem não entra na conferência");
  return {
    dataBase,
    janela: vespera >= dataBase ? { de: dataBase, ate: vespera } : null,
    movimentos: janela.map(visto),
    conjuntoHash: hashConjunto(janela),
    movimentoDesdeD0Centavos: somaMovimentos(desdeD0, dataBase, hoje),
  };
}

function resumoVigente(abertura: AberturaVigente | null) {
  return abertura
    ? { versao: abertura.versao, dataBase: abertura.dataBase, saldoCentavos: abertura.saldoCentavos, confirmadaEm: abertura.confirmadaEm }
    : null;
}

async function pendenciasVistas(tx: DbExecutor, empresaId: string, abertura: AberturaVigente | null) {
  if (!abertura) return { quantidade: 0, centavos: 0, itens: [] as MovimentoVisto[] };
  const vespera = somarDias(abertura.confirmadaEm, -1);
  if (vespera < abertura.dataBase) return { quantidade: 0, centavos: 0, itens: [] as MovimentoVisto[] };
  const janela = await movimentosCaixa(tx, empresaId, abertura.dataBase, vespera);
  const p = pendenciasDaAbertura(abertura, janela, await conferidosDaAbertura(tx, empresaId, abertura.id));
  return { quantidade: p.quantidade, centavos: p.centavos, itens: p.itens.map(visto) };
}

const DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET da abertura: revisão vigente, pendências da conferência com os atributos exibidos e a prévia para a data D0
 * pedida (padrão: hoje; D-FIN-10). Só leitura; não exige flag nem Gestão (a Equipe vê o resultado).
 */
export async function leituraAbertura(tx: DbExecutor, empresaId: string, dataBase: string | null) {
  const esquema = await esquemaP2(tx);
  const hoje = await hojeDoBanco(tx);
  const d0 = dataBase && DATA.test(dataBase) ? dataBase : hoje;
  if (d0 > hoje) recusar("DADOS_INVALIDOS", "A data da abertura não pode ser futura.", 409);
  const vigente = await aberturaVigente(tx, empresaId);
  return {
    disponivel: esquema.abertura && escritaP2Ligada("ABERTURA"),
    hoje,
    vigente: resumoVigente(vigente),
    pendencias: await pendenciasVistas(tx, empresaId, vigente),
    previa: await montarPrevia(tx, empresaId, d0, hoje),
  };
}

export type PedidoAbertura = {
  dataBase: string;
  /** Saldo informado imediatamente antes dos movimentos de D0. Pode ser zero ou negativo. */
  saldo: number;
  justificativa: string;
  /** Versão vigente que a tela viu; 0 quando não havia abertura. */
  versaoEsperada: number;
  /** `conjuntoHash` da prévia que a tela mostrou. */
  conjuntoHash: string;
  chave: string;
};

type LinhaAbertura = { id: string; versao: number; data_base: string; saldo: string; justificativa: string; conjunto_hash: string };

function mesmaAbertura(linha: LinhaAbertura, input: PedidoAbertura) {
  return linha.data_base === input.dataBase
    && centavosDe(linha.saldo) === centavosDe(input.saldo)
    && texto(linha.justificativa) === texto(input.justificativa)
    && Number(linha.versao) === input.versaoEsperada + 1
    && linha.conjunto_hash === input.conjuntoHash;
}

async function aberturaDaChave(tx: DbExecutor, empresaId: string, chave: string) {
  const r = await tx.query<LinhaAbertura>(
    `SELECT id::text AS id, versao, data_base::text AS data_base, saldo::text AS saldo, justificativa, conjunto_hash
       FROM financeiro_aberturas
      WHERE empresa_id = $1::uuid AND chave_idempotencia = $2`,
    [empresaId, chave],
  );
  return r.rows[0] ?? null;
}

/** Chave por linha PREVIA da abertura, derivada da chave do pedido: cabe em 160 e repete igual num retry. */
function chaveDaLinha(chave: string, m: Pick<MovimentoCaixa, "tipo" | "origemId">) {
  return createHash("sha256").update(`conferencia\0${chave}\0${chaveOrigem(m)}`).digest("hex");
}

const sha256 = (valor: string) => createHash("sha256").update(valor).digest("hex");

/**
 * Chaves das linhas de um lote de conferência: "<pedido>:<item>", 129 caracteres.
 * - <pedido> = sha256 da chave do pedido: prefixo comum a todas as linhas gravadas com essa chave, qualquer que seja o lote.
 * - <item> = sha256 da identidade do lote inteiro (versão + itens com atributos, em ordem canônica) e da origem do item.
 * Um retry acha todas as linhas da chave e só é "reutilizado" se o lote gravado for exatamente o mesmo.
 */
export function chavesDaConferencia(chave: string, versaoAbertura: number, itens: ItemConferencia[]) {
  const prefixo = sha256(`conferencia-lote\0${chave}`);
  const lote = sha256(JSON.stringify([versaoAbertura, itens.map((item) => `${chaveOrigem(item)}:${item.atributosHash}`).sort()]));
  return { prefixo, chaves: itens.map((item) => `${prefixo}:${sha256(`${lote}\0${chaveOrigem(item)}`)}`) };
}

/**
 * Confirma (versão 1) ou corrige (versão seguinte) a abertura (C.2.2). Sob a trava da empresa: versão divergente devolve
 * 409 com a revisão atual; conjunto da janela diferente do que a tela viu devolve 409 com nova prévia; nada é gravado.
 * Se bateu, grava a revisão e as origens da janela como conferidas na prévia (modo PREVIA, sequência 1).
 * Retry com a mesma chave devolve o mesmo resultado, mesmo depois de outra revisão.
 */
export async function confirmarAbertura(tx: DbExecutor, empresaId: string, atorId: string, input: PedidoAbertura) {
  await exigirEscritaP2(tx, "ABERTURA");
  await travarAbertura(tx, empresaId);
  const repetida = await aberturaDaChave(tx, empresaId, input.chave);
  if (repetida) {
    if (!mesmaAbertura(repetida, input)) recusar("IDEMPOTENCIA_CONFLITANTE", "Esta chave já registrou outra abertura nesta empresa.", 409);
    return { reutilizado: true, id: repetida.id, versao: Number(repetida.versao) };
  }
  const justificativa = texto(input.justificativa);
  if (justificativa.length < 3 || justificativa.length > 1000) recusar("DADOS_INVALIDOS", "Informe a justificativa da abertura.", 409);
  const hoje = await hojeDoBanco(tx);
  if (input.dataBase > hoje) recusar("DADOS_INVALIDOS", "A data da abertura não pode ser futura.", 409);
  const vigente = await aberturaVigente(tx, empresaId);
  const versaoAtual = vigente?.versao ?? 0;
  if (versaoAtual !== input.versaoEsperada) {
    recusar("VERSAO_DIVERGENTE", "A abertura foi alterada por outra pessoa. Confira a versão atual.", 409, {
      vigente: resumoVigente(vigente),
      previa: await montarPrevia(tx, empresaId, input.dataBase, hoje),
    });
  }
  const previa = await montarPrevia(tx, empresaId, input.dataBase, hoje);
  if (previa.conjuntoHash !== input.conjuntoHash) {
    recusar("CONJUNTO_MUDOU", "Os movimentos desde a data da abertura mudaram. Confira a nova prévia.", 409, { previa });
  }
  const saldo = centavosDe(input.saldo);
  const criada = await tx.query<{ id: string }>(
    `INSERT INTO financeiro_aberturas (empresa_id, versao, data_base, saldo, justificativa, conjunto_hash, substitui_id, chave_idempotencia, criado_por)
     VALUES ($1::uuid, $2, $3::date, $4, $5, $6, $7::uuid, $8, $9::uuid)
     RETURNING id::text AS id`,
    [empresaId, versaoAtual + 1, input.dataBase, reais(saldo), justificativa, previa.conjuntoHash, vigente?.id ?? null, input.chave, atorId],
  );
  const id = criada.rows[0].id;
  for (const m of previa.movimentos) {
    await tx.query(
      `INSERT INTO financeiro_abertura_conferencias (empresa_id, abertura_id, origem_tipo, origem_id, atributos_hash, modo, sequencia, chave_idempotencia, criado_por)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, 'PREVIA', 1, $6, $7::uuid)`,
      [empresaId, id, m.tipo, m.origemId, m.atributosHash, chaveDaLinha(input.chave, m), atorId],
    );
  }
  await auditar(tx, empresaId, vigente ? "ABERTURA_CORRIGIDA" : "ABERTURA_CONFIRMADA", "financeiro_aberturas", id, atorId,
    `Versão ${versaoAtual + 1}: D0 ${input.dataBase}, saldo ${saldo} centavos, ${previa.movimentos.length} movimento(s) conferido(s) na prévia. ${justificativa}`);
  return { reutilizado: false, id, versao: versaoAtual + 1 };
}

export type ItemConferencia = { tipo: TipoOrigemMovimento; origemId: string; atributosHash: string };
export type PedidoConferencia = { versaoAbertura: number; itens: ItemConferencia[]; chave: string };

/**
 * "Conferido" por movimento ou lote explícito (C.2.2). Sob a trava da empresa. Revisão trocada → 409 com a vigente; algum
 * item que não está mais pendente com os atributos vistos → 409 com as pendências atuais, sem gravar nenhum item (o estado
 * novo nunca é registrado como visto). Item já conferido com os mesmos atributos encerra uma vez: não grava de novo.
 */
export async function conferirPendencias(tx: DbExecutor, empresaId: string, atorId: string, input: PedidoConferencia) {
  await exigirEscritaP2(tx, "ABERTURA");
  await travarAbertura(tx, empresaId);
  // Lote com o mesmo movimento duas vezes é inválido antes de qualquer leitura, inclusive de retry.
  const origens = input.itens.map((item) => chaveOrigem({ tipo: item.tipo, origemId: item.origemId }));
  if (new Set(origens).size !== origens.length) recusar("DADOS_INVALIDOS", "O mesmo movimento apareceu duas vezes no lote.", 409);
  const { prefixo, chaves } = chavesDaConferencia(input.chave, input.versaoAbertura, input.itens);
  // Todas as linhas já gravadas com esta chave de pedido, de qualquer lote (o prefixo é hex: sem curinga do LIKE).
  const ja = await tx.query<{ chave_idempotencia: string }>(
    `SELECT conf.chave_idempotencia
       FROM financeiro_abertura_conferencias conf
      WHERE conf.empresa_id = $1::uuid AND conf.chave_idempotencia LIKE $2`,
    [empresaId, `${prefixo}:%`],
  );
  if (ja.rowCount) {
    // Reutiliza só o mesmo lote inteiro: subconjunto, superconjunto, outra versão ou lote disjunto com a mesma chave é conflito.
    const gravadas = new Set(ja.rows.map((linha) => linha.chave_idempotencia));
    const mesmo = gravadas.size === chaves.length && chaves.every((c) => gravadas.has(c));
    if (!mesmo) recusar("IDEMPOTENCIA_CONFLITANTE", "Esta chave já registrou outra conferência nesta empresa.", 409);
    return { reutilizado: true, conferidos: input.itens.length };
  }
  const vigente = await aberturaVigente(tx, empresaId);
  if (!vigente || vigente.versao !== input.versaoAbertura) {
    recusar("VERSAO_DIVERGENTE", "A abertura foi alterada por outra pessoa. Confira a versão atual.", 409, {
      vigente: resumoVigente(vigente),
      pendencias: await pendenciasVistas(tx, empresaId, vigente),
    });
  }
  const pendencias = await pendenciasVistas(tx, empresaId, vigente);
  const pendentes = new Map(pendencias.itens.map((m) => [chaveOrigem(m), m]));
  const divergentes: ItemConferencia[] = [];
  for (const [i, item] of input.itens.entries()) {
    const atual = pendentes.get(origens[i]);
    if (!atual || atual.atributosHash !== item.atributosHash) divergentes.push(item);
  }
  if (divergentes.length) {
    recusar("ATRIBUTOS_MUDARAM", "Algum movimento mudou ou já não está pendente. Confira a lista atualizada.", 409, { divergentes, pendencias });
  }
  for (const [i, item] of input.itens.entries()) {
    const seq = await tx.query<{ proxima: number }>(
      `SELECT COALESCE(MAX(sequencia), 0) + 1 AS proxima
         FROM financeiro_abertura_conferencias
        WHERE empresa_id = $1::uuid AND abertura_id = $2::uuid AND origem_tipo = $3 AND origem_id = $4::uuid`,
      [empresaId, vigente.id, item.tipo, item.origemId],
    );
    await tx.query(
      `INSERT INTO financeiro_abertura_conferencias (empresa_id, abertura_id, origem_tipo, origem_id, atributos_hash, modo, sequencia, chave_idempotencia, criado_por)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, 'CONFERIDO', $6, $7, $8::uuid)`,
      [empresaId, vigente.id, item.tipo, item.origemId, item.atributosHash, Number(seq.rows[0].proxima), chaves[i], atorId],
    );
  }
  await auditar(tx, empresaId, "ABERTURA_CONFERENCIA", "financeiro_aberturas", vigente.id, atorId,
    `${input.itens.length} movimento(s) conferido(s) na versão ${vigente.versao}.`);
  return { reutilizado: false, conferidos: input.itens.length };
}

/** Quais escritas da P2 estão ligadas, para a tela esconder o botão. A guarda que vale é a do serviço. */
export function operacoesP2(env: Ambiente = process.env) {
  return { liquidacao: escritaP2Ligada("LIQUIDACAO", env), reversao: escritaP2Ligada("REVERSAO", env), abertura: escritaP2Ligada("ABERTURA", env) };
}

/** Pagamentos de uma conta com o que já foi revertido de cada um: base do diálogo de reversão. Só leitura. */
export async function pagamentosDaConta(tx: DbExecutor, empresaId: string, contaId: string) {
  const { movimentos } = await esquemaP2(tx);
  const revertido = movimentos
    ? `COALESCE((SELECT SUM(rev.valor) FROM financeiro_saidas_reversoes rev WHERE rev.saida_id = saida.id AND rev.empresa_id = saida.empresa_id), 0)`
    : "0";
  const r = await tx.query<{ id: string; pago_em: string; valor: string; revertido: string; forma: string | null }>(
    `SELECT saida.id::text AS id, saida.pago_em::text AS pago_em, saida.valor::text AS valor, ${revertido}::text AS revertido, saida.forma
       FROM financeiro_saidas saida
      WHERE saida.conta_id = $1::uuid AND saida.empresa_id = $2::uuid
      ORDER BY saida.pago_em, saida.id`,
    [contaId, empresaId],
  );
  return r.rows.map((linha) => {
    const valorCentavos = centavosDe(linha.valor);
    const revertidoCentavos = centavosDe(linha.revertido);
    return { id: linha.id, data: linha.pago_em, forma: linha.forma, valorCentavos, revertidoCentavos, restanteCentavos: saldoCentavos(valorCentavos, revertidoCentavos) };
  });
}
