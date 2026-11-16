import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { hashToken } from "../autenticacao/senha.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { hashSnapshotContrato } from "../contratos/services/snapshot-core.ts";
import {
  contarRecebiveis,
  criarContaPagar,
  editarContaPagar,
  garantirCategorias,
  financeiroDaFesta,
  fluxoCaixa,
  liquidoRecebidoPorFesta,
  listarRecebiveis,
  pagarConta,
  prepararBaixa,
  recebidoNoPeriodo,
  relatorio,
} from "./servico.ts";

// O motor tem imports sem extensão (ex.: '../services/cancelamento-core'): carrega pelo transpilador local, como a
// suíte de estorno completo, e não pelo carregador ESM do runner.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigir = createRequire(import.meta.url);
const extensoes = exigir.extensions as unknown as Record<string, (module: { _compile(code: string, filename: string): void }, filename: string) => void>;
extensoes[".ts"] = (module, filename) => {
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText.replace(/require\("@\/([^"\n]+)"\)/g, (_texto, caminho: string) => `require(${JSON.stringify(resolve(root, caminho))})`);
  module._compile(output, filename);
};
type Motor = typeof import("../pagamentos/repositories/alteracao-financeira.repository.ts");
type Capacidade = typeof import("../pagamentos/services/movimentos-consolidados.ts");
const { lerPosicaoFinanceira } = exigir(resolve(root, "lib/pagamentos/repositories/alteracao-financeira.repository.ts")) as Motor;
const { validarCapacidadeConsolidada } = exigir(resolve(root, "lib/pagamentos/services/movimentos-consolidados.ts")) as Capacidade;
const { AlteracaoFinanceiraError } = exigir(resolve(root, "lib/pagamentos/services/alteracao-financeira-core.ts")) as typeof import("../pagamentos/services/alteracao-financeira-core.ts");

const HOJE = "2026-11-07";
const codigo = () => `tm${randomBytes(4).toString("hex")}`;

function executor(db: Client): DbExecutor {
  return {
    async query<Row extends object>(text: string, values?: readonly unknown[]) {
      const result = await db.query(text, values as unknown[]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

/**
 * P2 (D-FIN-9): saldo absoluto só com abertura. Os cenários conferem primeiro o caso sem abertura (null) e depois abrem
 * o caixa explicitamente em D0, antes de todo movimento, com saldo zero: os números a partir daí são os de antes da P2.
 * A suíte roda nos modelos 062 e 114 (sem a 121: o leitor só pode dar null, e os oráculos de saldo absoluto ficam de fora)
 * e no 121, onde a tabela é obrigatória e todos os oráculos rodam. Devolve se abriu.
 */
const MODELO_COM_ABERTURA = process.env.KIDMAIS_POSTGRES_MODELO === "121";
async function abrirCaixa(db: Client, empresaId: string, ator: string, dataBase = "2026-03-01"): Promise<boolean> {
  const tem = (await db.query<{ ok: boolean }>("SELECT to_regclass('public.financeiro_aberturas') IS NOT NULL AS ok")).rows[0]?.ok;
  if (!tem) {
    if (MODELO_COM_ABERTURA) throw new Error("o modelo 121 precisa de financeiro_aberturas");
    return false;
  }
  await db.query(
    `INSERT INTO financeiro_aberturas (empresa_id, versao, data_base, saldo, justificativa, conjunto_hash, chave_idempotencia, criado_por)
     VALUES ($1::uuid, 1, $2::date, 0, 'Abertura do teste', repeat('0', 64), $3, $4::uuid)`,
    [empresaId, dataBase, `teste-${codigo()}`, ator]);
  return true;
}

async function semAbertura(tx: DbExecutor, empresaId: string, inicio: string, fim: string) {
  const fluxo = await fluxoCaixa(tx, empresaId, inicio, fim, HOJE);
  assert.deepEqual([fluxo.saldoInicialCentavos, fluxo.saldoFinalCentavos, fluxo.motivoSaldo], [null, null, "SEM_ABERTURA"], "sem abertura não há saldo absoluto");
  assert.equal(fluxo.movimentoPeriodoCentavos, fluxo.entradasCentavos - fluxo.saidasCentavos);
  return fluxo;
}

async function umId(db: Client, sql: string, valores: unknown[] = []) {
  return (await db.query<{ id: string }>(sql, valores)).rows[0].id;
}

async function usuario(db: Client) {
  return umId(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Teste P1', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
    [`${codigo()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
}

async function empresa(db: Client) {
  return umId(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $1, 'PROVISIONAMENTO') RETURNING id`, [codigo()]);
}

/**
 * Validadores diferidos do contrato que o commit executaria: o fluxo e a formalização da 013 (no corpo da 057 e da 061:
 * vigência, ponteiro lógico, edição, documento revisado, assinatura de quem pode assinar pela empresa e OTP consumido) e
 * a formalização da 019 (duas assinaturas válidas, festa ativa, ocupação sem conflito). A suíte nunca confirma a transação;
 * forçar estes gatilhos é o que prova que a fixture seria aceita.
 */
const VALIDADORES_DE_CONTRATO = [
  "contrato_versoes_validar_fluxo_trg", "contrato_fluxos_validar_trg", "contrato_edicoes_validar_trg", "contrato_assinaturas_validar_trg",
  "festa019_contrato", "festa019_fluxo", "festa019_fechamento", "festa019_festa",
].join(", ");

async function validarContratoAgora(db: Client) {
  await db.query(`SET CONSTRAINTS ${VALIDADORES_DE_CONTRATO} IMMEDIATE`);
  await db.query(`SET CONSTRAINTS ${VALIDADORES_DE_CONTRATO} DEFERRED`);
}

const sha256 = (dados: Buffer | string) => createHash("sha256").update(dados).digest("hex");
const pdfDe = (rotulo: string) => Buffer.from(`%PDF-1.4\n% ${rotulo} ${randomUUID()}\n%%EOF\n`);
const NOME_ASSINANTE = "Teste P1";

// Cada contrato formalizado ocupa a agenda da empresa: horários distintos evitam o conflito de ocupação da 019.
let horarioLivre = 0;
function proximoHorario() {
  const inicio = 6 * 60 + (horarioLivre++ % 32) * 30;
  const hora = (minutos: number) => `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;
  return { inicio: hora(inicio), fim: hora(inicio + 30) };
}

/** Quem assina pela empresa (057): Gestão ATIVA na empresa com a capability CONTRATO_ASSINAR_EMPRESA. */
async function assinantePelaEmpresa(db: Client, empresaId: string) {
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid AND status = 'PROVISIONAMENTO'`, [empresaId]);
  const assinante = await usuario(db);
  const membership = await umId(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [empresaId, assinante]);
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [membership]);
  await db.query(`INSERT INTO empresa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1::uuid, $2::uuid, 'CONTRATO_ASSINAR_EMPRESA', $3::uuid, 'Fixture P1')`, [empresaId, membership, assinante]);
  return assinante;
}

/** Documento revisado e comprovante da versão, como guardarDocumento grava (hash do conteúdo). */
async function documentosDaVersao(db: Client, versao: string, snapshotHash: string, pdf: Buffer, autor: string) {
  const inserir = (categoria: string, modelo: string, gerador: string | null) => umId(db,
    `INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf, gerado_por_usuario_id)
     VALUES ($1::uuid, $2, 1, $3, $4, 1, $5, $6, $7, $8::uuid) RETURNING id`, [versao, categoria, snapshotHash, modelo, sha256(pdf), pdf.length, pdf, gerador]);
  return { documento: await inserir("CONTRATO", "CONTRATO_P1", autor), comprovante: await inserir("COMPROVANTE_ASSINATURA", "COMPROVANTE_P1", null) };
}

/** Edição da versão com revisão comercial aprovada, documento revisado e liberação ao cliente (013). */
async function gravarEdicao(db: Client, contrato: string, versao: string, documento: string, autor: string, estado: "CONCLUIDA" | "AGUARDANDO_CLIENTE", origem: string | null) {
  await db.query(
    `INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, origem_versao_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id,
       revisao_comercial_aprovada, aprovado_comercial_por_usuario_id, aprovado_comercial_em, documento_revisado_id, revisado_por_usuario_id, revisado_em, liberado_por_usuario_id, liberado_em)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $6::uuid, $6::uuid, 1, $6::uuid, now(), $7::uuid, $6::uuid, now(), $6::uuid, now())`,
    [versao, contrato, origem, origem ? "NOVA_VERSAO" : "INICIAL", estado, autor, documento]);
}

/** Assinatura KIDMAIS com sessão recém-autenticada do assinante (013/057: no máximo 5 minutos entre autenticar e assinar). */
async function assinarPelaEmpresa(db: Client, versao: string, docs: { documento: string; comprovante: string }, snapshotHash: string, pdf: Buffer, assinante: string) {
  const sessao = await umId(db,
    `INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
     VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours') RETURNING id`,
    [assinante, hashToken(randomBytes(32).toString("base64url")), hashToken(randomBytes(32).toString("base64url"))]);
  await db.query(
    `INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, usuario_id, sessao_id, autenticacao_metodo, autenticado_em, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
     SELECT $1::uuid, 'KIDMAIS', $2::uuid, $3::uuid, s.id, 'SENHA', s.autenticado_em, jsonb_build_object('usuarioId', $3::text, 'papel', 'REPRESENTANTE_AUTORIZADO', 'nome', $4::text, 'cargo', null),
            $5, $6, 'SESSAO_REAUTENTICADA', 'INTERNAL', clock_timestamp(), $7::uuid, $8::uuid, $9::uuid
       FROM sessoes_administrativas s WHERE s.id = $10::uuid`,
    [versao, docs.documento, assinante, NOME_ASSINANTE, snapshotHash, sha256(pdf), randomUUID(), randomUUID(), docs.comprovante, sessao]);
}

/** OTP do cliente consumido por esta versão, como consumirProvaParaContrato deixa a validação. */
async function provaDoCliente(db: Client, cliente: string, versao: string) {
  return umId(db,
    `INSERT INTO validacoes_identidade_cliente (cliente_id, finalidade, canal, status, confirmado_em, token_prova_hash, prova_expira_em, consumido_em, consumido_por_contrato_versao_id)
     VALUES ($1::uuid, 'CONTRATO_ACEITE', 'EMAIL', 'CONSUMIDA', now(), $2, now() + interval '10 minutes', now(), $3::uuid) RETURNING id`,
    [cliente, sha256(randomBytes(32)), versao]);
}

/**
 * Um contrato formalizado, pagamento e festa. A versão 1 tem o que o fluxo nativo deixa: documento revisado e comprovante,
 * edição INICIAL concluída, assinatura KIDMAIS de quem tem a capability da empresa, aceite do cliente com OTP consumido,
 * fluxo com a vigência e contratos.versao_atual = 1. Os validadores do contrato rodam na hora (validarContratoAgora).
 * O snapshot é íntegro e o fechamento aceita recebimento, para que lerPosicaoFinanceira e validarCapacidadeConsolidada
 * (a confirmação do motor) leiam o mesmo contrato.
 * Antes do fechamento, a trava de configuração da agenda da empresa, como a entrada real (travarConfiguracaoAgenda):
 * com a 114, os gatilhos da 019 recusam fechamento, contrato e festa sem ela (KD114). É de transação e vale até o
 * ROLLBACK; sem a 114, não muda nada.
 */
async function contratoComFesta(db: Client, empresaId: string, ator: string, valorTotal = 1000, dataEvento = "2026-03-20") {
  await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('kidmais:agenda-config:' || $1::text, 0))", [empresaId]);
  const assinante = await assinantePelaEmpresa(db, empresaId);
  const pacote = await umId(db, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Festa Completa', 1, true, true) RETURNING id`, [empresaId, codigo().toUpperCase()]);
  const tabela = await umId(db, `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela', '2026-01-01', false, $2::uuid) RETURNING id`, [codigo(), empresaId]);
  const preco = await umId(db, `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id`, [tabela, pacote]);
  const agenda = await umId(db, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda', '10:00', '18:00', 9) RETURNING id`, [codigo()]);
  const cliente = await umId(db, `INSERT INTO clientes (nome_completo, empresa_id) VALUES ('Maria Silva', $1::uuid) RETURNING id`, [empresaId]);
  const horario = proximoHorario();
  const fechamento = await umId(db,
    `INSERT INTO fechamentos (
       data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
       categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados,
       valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status
     ) VALUES ($1::date, $8::time, $9::time, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
       'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $7::uuid, 'AGUARDANDO_PAGAMENTO') RETURNING id`,
    [dataEvento, agenda, empresaId, pacote, tabela, preco, cliente, horario.inicio, horario.fim]);
  const contrato = await umId(db, `INSERT INTO contratos (fechamento_id, status, assinado_em, versao_atual) VALUES ($1::uuid, 'ASSINADO', now(), 1) RETURNING id`, [fechamento]);
  const snapshot = { contratante: { clienteId: cliente, nomeCompleto: "Maria Silva" }, comercial: { valorFinalContrato: valorTotal }, evento: { data: dataEvento } };
  const snapshotHash = hashSnapshotContrato(snapshot);
  const pdf = pdfDe(`contrato ${contrato} v1`);
  const versao = await umId(db,
    `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
     VALUES ($1::uuid, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP') RETURNING id`,
    [contrato, JSON.stringify(snapshot), snapshotHash, sha256(pdf)]);
  const docs = await documentosDaVersao(db, versao, snapshotHash, pdf, assinante);
  await gravarEdicao(db, contrato, versao, docs.documento, assinante, "CONCLUIDA", null);
  await assinarPelaEmpresa(db, versao, docs, snapshotHash, pdf, assinante);
  const prova = await provaDoCliente(db, cliente, versao);
  await db.query(
    `INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, validacao_identidade_id, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
     SELECT $1::uuid, 'CLIENTE', $2::uuid, $3::uuid, $4::jsonb, $5, $6, 'OTP', 'INTERNAL', v.assinado_em, $7::uuid, $3::uuid, $8::uuid FROM contrato_versoes v WHERE v.id = $1::uuid`,
    [versao, docs.documento, prova, JSON.stringify({ schemaVersao: 1, clienteId: cliente, nome: "Maria Silva" }), snapshotHash, sha256(pdf), randomUUID(), docs.comprovante]);
  await db.query(`INSERT INTO contrato_fluxos (contrato_id, versao_vigente_id) VALUES ($1::uuid, $2::uuid)`, [contrato, versao]);
  const pagamento = await umId(db, `INSERT INTO pagamentos (contrato_versao_id, valor_total_contratado) VALUES ($1::uuid, $2) RETURNING id`, [versao, valorTotal]);
  const festa = await umId(db,
    `INSERT INTO festas (contrato_id, versao_contratual_criacao_id, chave_criacao, payload_hash, criado_por)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid) RETURNING id`,
    [contrato, versao, randomUUID(), "b".repeat(64), ator]);
  await db.query(`INSERT INTO pagamento_gestoes (pagamento_id, contrato_id) VALUES ($1::uuid, $2::uuid)`, [pagamento, contrato]);
  await validarContratoAgora(db);
  return { contrato, versao, pagamento, festa, cliente, assinante, snapshot };
}

// A classe vem do mesmo cache de require que o motor usa.
const excedeSaldo = (erro: unknown) => erro instanceof AlteracaoFinanceiraError && erro.code === "VALOR_EXCEDE_SALDO";

/**
 * Paridade com a leitura e a capacidade do motor (lerPosicaoFinanceira + validarCapacidadeConsolidada):
 * - a soma cobrável da lista é o saldo da posição;
 * - título que o motor não tem em `futuro` é histórico e tem saldo zero; os demais nunca passam do futuro do motor,
 *   e são iguais a ele quando o futuro cobre exatamente a posição;
 * - a capacidade aceita o total com as alocações da lista e recusa um centavo a mais com as mesmas alocações;
 * - com cronograma, cada item aceita o próprio saldo e recusa um centavo a mais;
 * - saldo zero: um centavo alocado em qualquer título é recusado.
 * Sem cronograma, a capacidade do motor só confere o teto global: o saldo por parcela vem da comparação com `futuro`.
 */
async function paridadeComMotor(tx: DbExecutor, contrato: string, empresaId: string) {
  const p = await lerPosicaoFinanceira(tx, contrato, true);
  const titulos = (await listarRecebiveis(tx, empresaId, HOJE)).filter((item) => item.pagamentoId === p.pagamento.id);
  const total = titulos.reduce((soma, item) => soma + item.saldoCentavos, 0);
  assert.equal(BigInt(total), p.posicao.saldo, "saldo cobrável da lista = saldo da posição do motor");
  const futuroCobre = p.futuro.reduce((soma, item) => soma + BigInt(item.valorCentavos), 0n) === p.posicao.saldo;
  for (const item of titulos) {
    const doMotor = p.futuro.find((futuro) => futuro.parcelaId === item.id);
    if (!doMotor) {
      assert.equal(item.saldoCentavos, 0, "título fora do futuro do motor é histórico, sem saldo");
      continue;
    }
    assert.ok(BigInt(item.saldoCentavos) <= BigInt(doMotor.valorCentavos), "saldo do título nunca passa do futuro do motor");
    if (futuroCobre) assert.equal(BigInt(item.saldoCentavos), BigInt(doMotor.valorCentavos), "saldo do título = futuro do motor");
  }
  const comSaldo = titulos.filter((item) => item.saldoCentavos > 0);
  const alocacoes = comSaldo.map((item) => ({ parcelaId: item.id, valor: item.saldoCentavos / 100 }));
  if (total > 0) {
    validarCapacidadeConsolidada(p, total / 100, alocacoes);
    assert.throws(() => validarCapacidadeConsolidada(p, (total + 1) / 100, alocacoes), excedeSaldo);
  } else {
    for (const item of titulos) {
      assert.throws(() => validarCapacidadeConsolidada(p, 0.01, [{ parcelaId: item.id, valor: 0.01 }]), excedeSaldo);
    }
  }
  if (p.cronograma) {
    for (const item of comSaldo) {
      validarCapacidadeConsolidada(p, item.saldoCentavos / 100, [{ parcelaId: item.id, valor: item.saldoCentavos / 100 }]);
      assert.throws(() => validarCapacidadeConsolidada(p, 0.01, [{ parcelaId: item.id, valor: (item.saldoCentavos + 1) / 100 }]), excedeSaldo);
    }
  }
}

async function plano(db: Client, pagamento: string, numeroVersao = 1, ativo = true) {
  return umId(db,
    `INSERT INTO pagamento_planos (pagamento_id, numero_versao, status, meio_pagamento, modalidade, quantidade_parcelas, substituido_em, motivo_substituicao)
     VALUES ($1::uuid, $2, $3, 'PIX', 'PARCELADO', 2, $4::timestamptz, $5) RETURNING id`,
    [pagamento, numeroVersao, ativo ? "ATIVO" : "SUBSTITUIDO", ativo ? null : "2026-03-10T12:00:00Z", ativo ? null : "Substituído no teste"]);
}

async function parcela(db: Client, planoId: string, numero: number, valor: number, vencimento: string) {
  return umId(db, `INSERT INTO pagamento_parcelas (plano_id, numero, valor_previsto, vencimento) VALUES ($1::uuid, $2, $3, $4::date) RETURNING id`, [planoId, numero, valor, vencimento]);
}

async function recebimento(db: Client, pagamento: string, valor: number, quando: string, alocacoes: Array<[string, number]>, metadata: Record<string, unknown> = { forma: "PIX", taxaCentavos: 0 }, meio = "PIX") {
  const id = await umId(db,
    `INSERT INTO pagamento_recebimentos (pagamento_id, status, meio_pagamento, valor_bruto, recebido_em, confirmado_em, chave_idempotencia, metadata_provedor)
     VALUES ($1::uuid, 'CONFIRMADO', $2, $3, $4::timestamptz, now(), $5, $6::jsonb) RETURNING id`,
    [pagamento, meio, valor, quando, randomUUID(), JSON.stringify(metadata)]);
  for (const [parcelaId, alocado] of alocacoes) {
    await db.query(`INSERT INTO pagamento_recebimento_alocacoes (recebimento_id, parcela_id, valor_alocado) VALUES ($1::uuid, $2::uuid, $3)`, [id, parcelaId, alocado]);
  }
  return id;
}

async function estorno(db: Client, recebimentoId: string, parcelaId: string, valor: number, quando: string) {
  return umId(db,
    `INSERT INTO pagamento_estornos (recebimento_id, parcela_id, valor, status, confirmado_em, chave_idempotencia)
     VALUES ($1::uuid, $2::uuid, $3, 'CONFIRMADO', $4::timestamptz, $5) RETURNING id`,
    [recebimentoId, parcelaId, valor, quando, randomUUID()]);
}

async function evento(db: Client, pagamento: string, ator: string, sequencia: number, tipo: string, identidade: Record<string, unknown> = {}) {
  return umId(db,
    `INSERT INTO pagamento_eventos (pagamento_id, sequencia, tipo, chave_idempotencia, pedido_hash, usuario_id, ator_tipo, identidade_snapshot, request_id, dados_antes, dados_depois, resultado)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::uuid, 'USUARIO', $7::jsonb, $8::uuid, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) RETURNING id`,
    [pagamento, sequencia, tipo, randomUUID(), "d".repeat(64), ator, JSON.stringify(identidade), randomUUID()]);
}

/** Como registrarEventoFinanceiro: a sequência da gestão acompanha o último evento (validação diferida da 015). */
async function eventoNaGestao(db: Client, pagamento: string, ator: string, sequencia: number, tipo: string, identidade: Record<string, unknown> = {}) {
  const id = await evento(db, pagamento, ator, sequencia, tipo, identidade);
  await db.query(`UPDATE pagamento_gestoes SET sequencia = $2 WHERE pagamento_id = $1::uuid`, [pagamento, sequencia]);
  return id;
}

/** Evento no próximo número da gestão, depois dos que os serviços já gravaram. */
async function proximoEvento(db: Client, pagamento: string, ator: string, tipo: string, identidade: Record<string, unknown> = {}) {
  const atual = Number((await db.query<{ s: string }>(`SELECT sequencia::text AS s FROM pagamento_gestoes WHERE pagamento_id = $1::uuid`, [pagamento])).rows[0].s);
  return eventoNaGestao(db, pagamento, ator, atual + 1, tipo, identidade);
}

test("as leituras gerenciais seguem o motor: estorno, devolução, alocação, data e contagem", { timeout: 120_000 }, async () => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    // A guarda imediata da Festa (festa019_invalidacao) fica ligada: contratoComFesta formaliza antes de inserir a Festa.
    const tx = executor(db);
    const ator = await usuario(db);

    // Taxa: R$ 1.000 quitados com taxa de R$ 20. Caixa 980, cobrável 0, sem Pix.
    {
      const id = await empresa(db);
      const c = await contratoComFesta(db, id, ator);
      const p = await parcela(db, await plano(db, c.pagamento), 1, 1000, "2026-03-05");
      await recebimento(db, c.pagamento, 1000, "2026-03-05T00:00:00Z", [[p, 1000]], { forma: "PIX", taxaCentavos: 2000 });
      const [item] = await listarRecebiveis(tx, id, HOJE);
      assert.equal(item.saldoCentavos, 0);
      assert.equal(item.status, "Pago");
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-03-01", "2026-03-31"), 98000);
      await paridadeComMotor(tx, c.contrato, id);
      await assert.rejects(() => prepararBaixa(tx, id, HOJE, { parcelaId: p, valor: 1, data: HOJE, forma: "PIX" }));
    }

    // Estorno de R$ 400: caixa 600 e cobrável 400. A pré-validação da baixa aceita 400 e recusa 400,01.
    {
      const id = await empresa(db);
      const c = await contratoComFesta(db, id, ator);
      const p = await parcela(db, await plano(db, c.pagamento), 1, 1000, "2026-03-05");
      const rec = await recebimento(db, c.pagamento, 1000, "2026-03-05T00:00:00Z", [[p, 1000]]);
      await estorno(db, rec, p, 400, "2026-04-10T15:00:00Z");
      const [item] = await listarRecebiveis(tx, id, HOJE);
      assert.equal(item.saldoCentavos, 40000);
      assert.equal(item.recebidoCentavos, 60000);
      assert.equal(item.brutoRecebidoCentavos, 100000);
      await paridadeComMotor(tx, c.contrato, id);
      assert.equal((await prepararBaixa(tx, id, HOJE, { parcelaId: p, valor: 400, data: HOJE, forma: "PIX" })).valorReais, 400);
      await assert.rejects(() => prepararBaixa(tx, id, HOJE, { parcelaId: p, valor: 400.01, data: HOJE, forma: "PIX" }),
        (erro: unknown) => erro instanceof PacoteAdminError && erro.code === "VALOR_EXCEDE_SALDO");
      // O estorno sai na data dele, sem mudar o mês do recebimento.
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-03-01", "2026-03-31"), 100000);
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-04-01", "2026-04-30"), -40000);
      assert.equal((await semAbertura(tx, id, "2026-04-01", "2026-04-30")).movimentoPeriodoCentavos, -40000);
      const abril = await fluxoCaixa(tx, id, "2026-04-01", "2026-04-30", HOJE);
      assert.equal(abril.saidasCentavos, 40000);
      assert.ok(abril.linhas.some((linha) => linha.descricao === "Estorno de recebimento" && linha.saida === 40000));
      if (await abrirCaixa(db, id, ator)) {
        const abrilComSaldo = await fluxoCaixa(tx, id, "2026-04-01", "2026-04-30", HOJE);
        assert.equal(abrilComSaldo.motivoSaldo, null);
        assert.equal(abrilComSaldo.saldoInicialCentavos, 100000);
        assert.equal(abrilComSaldo.saldoFinalCentavos, 60000);
        const maio = await fluxoCaixa(tx, id, "2026-05-01", "2026-05-31", HOJE);
        assert.equal(maio.saldoInicialCentavos, abrilComSaldo.saldoFinalCentavos, "o saldo final de um período é o inicial do seguinte");
      }
      assert.equal((await liquidoRecebidoPorFesta(tx, id, c.festa)).get(c.festa), 60000);
      assert.equal((await financeiroDaFesta(tx, id, c.festa, HOJE)).resultadoCaixaCentavos, 60000);
      const rel = await relatorio(tx, id, "2026-04-01", "2026-04-30", HOJE);
      assert.equal(rel.recebidoCentavos, -40000);
      assert.deepEqual(rel.formas, [{ forma: "PIX", centavos: -40000 }]);
      assert.equal(rel.margens.find((linha) => linha.festaId === c.festa)?.resultadoCaixaCentavos, -40000);
      assert.equal(rel.margens.find((linha) => linha.festaId === c.festa)?.margemEstimadaCentavos, null);
    }

    // Um recebimento em duas parcelas conta uma vez no caixa e abate cada uma.
    {
      const id = await empresa(db);
      const c = await contratoComFesta(db, id, ator);
      const pl = await plano(db, c.pagamento);
      const p1 = await parcela(db, pl, 1, 500, "2026-03-05");
      const p2 = await parcela(db, pl, 2, 500, "2026-04-05");
      await recebimento(db, c.pagamento, 700, "2026-03-05T00:00:00Z", [[p1, 500], [p2, 200]]);
      const itens = await listarRecebiveis(tx, id, HOJE);
      assert.equal(itens.find((item) => item.id === p1)?.saldoCentavos, 0);
      assert.equal(itens.find((item) => item.id === p2)?.saldoCentavos, 30000);
      await paridadeComMotor(tx, c.contrato, id);
      const marco = await fluxoCaixa(tx, id, "2026-03-01", "2026-03-31", HOJE);
      assert.equal(marco.entradasCentavos, 70000);
      assert.equal(marco.linhas.filter((linha) => linha.tipo === "realizado").length, 1);
    }

    // Data civil da baixa × horário real, com a sessão em São Paulo.
    {
      const id = await empresa(db);
      const c = await contratoComFesta(db, id, ator);
      const p = await parcela(db, await plano(db, c.pagamento), 1, 1000, "2026-03-05");
      await db.query("SET LOCAL TIME ZONE 'America/Sao_Paulo'");
      await recebimento(db, c.pagamento, 100, "2026-04-01T00:00:00Z", [[p, 100]]);
      await recebimento(db, c.pagamento, 200, "2026-04-01T01:30:00Z", [[p, 200]]);
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-04-01", "2026-04-01"), 10000, "meia-noite UTC é a própria data escolhida");
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-03-31", "2026-03-31"), 20000, "horário real vale a data de Brasília");
      await db.query("SET LOCAL TIME ZONE 'UTC'");
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-04-01", "2026-04-01"), 10000, "o timezone da sessão não muda o resultado");
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-03-31", "2026-03-31"), 20000);
    }

    // Devolução pendente é reserva e não sai do caixa. Concluída, sai na data dela. Nenhuma reabre cobrança.
    {
      const id = await empresa(db);
      const c = await contratoComFesta(db, id, ator, 600);
      const p = await parcela(db, await plano(db, c.pagamento), 1, 1000, "2026-03-05");
      const rec = await recebimento(db, c.pagamento, 1000, "2026-03-05T00:00:00Z", [[p, 1000]]);
      const alocacao = await umId(db, `SELECT id FROM pagamento_recebimento_alocacoes WHERE recebimento_id = $1::uuid`, [rec]);
      const eventoReserva = await eventoNaGestao(db, c.pagamento, ator, 1, "DEVOLUCAO_SOLICITADA");
      const reserva = await umId(db, `INSERT INTO pagamento_credito_reservas (pagamento_id, evento_criacao_id, valor_centavos, estado) VALUES ($1::uuid, $2::uuid, 40000, 'ATIVA') RETURNING id`, [c.pagamento, eventoReserva]);
      const devolucao = await umId(db,
        `INSERT INTO pagamento_devolucoes (pagamento_id, reserva_id, evento_solicitacao_id, estado, valor_centavos, beneficiario_snapshot, motivo)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDENTE', 40000, '{"nome":"Maria"}'::jsonb, 'Redução') RETURNING id`,
        [c.pagamento, reserva, eventoReserva]);
      await db.query(`INSERT INTO pagamento_devolucao_alocacoes (devolucao_id, recebimento_alocacao_id, valor_centavos) VALUES ($1::uuid, $2::uuid, 40000)`, [devolucao, alocacao]);
      assert.equal((await listarRecebiveis(tx, id, HOJE))[0].saldoCentavos, 0);
      await paridadeComMotor(tx, c.contrato, id);
      await semAbertura(tx, id, "2026-05-01", "2026-05-31");
      const comSaldo = await abrirCaixa(db, id, ator);
      if (comSaldo) assert.equal((await fluxoCaixa(tx, id, "2026-05-01", "2026-05-31", HOJE)).saldoInicialCentavos, 100000, "pendente não sai do caixa");
      // A 015 também no estado intermediário (devolução PENDENTE, reserva ATIVA); depois volta a diferir para a transição.
      await db.query("SET CONSTRAINTS p015_validar, p015_validar_movimento IMMEDIATE");
      await db.query("SET CONSTRAINTS p015_validar, p015_validar_movimento DEFERRED");
      const eventoFim = await eventoNaGestao(db, c.pagamento, ator, 2, "DEVOLUCAO_CONCLUIDA", { papel: "REPRESENTANTE_AUTORIZADO" });
      await db.query(
        `UPDATE pagamento_devolucoes SET estado = 'CONCLUIDA', evento_conclusao_id = $2::uuid, devolvido_em = $3::timestamptz, meio_devolucao = 'PIX', observacao_execucao = 'Feito', justificativa_sem_comprovante = 'Teste' WHERE id = $1::uuid`,
        [devolucao, eventoFim, new Date("2026-03-31T21:00:00-03:00").toISOString()]);
      await db.query(`UPDATE pagamento_credito_reservas SET estado = 'CONSUMIDA', evento_encerramento_id = $2::uuid, encerrado_em = clock_timestamp() WHERE id = $1::uuid`, [reserva, eventoFim]);
      const [item] = await listarRecebiveis(tx, id, HOJE);
      assert.equal(item.saldoCentavos, 0);
      assert.equal(item.motor?.liquidoCentavos, 60000);
      await paridadeComMotor(tx, c.contrato, id);
      // Devolvida em 31/03 às 21:00 de Brasília (gravada 01/04 00:00Z): é março, não abril.
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-03-01", "2026-03-31"), 60000);
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-04-01", "2026-04-30"), 0);
      if (comSaldo) assert.equal((await fluxoCaixa(tx, id, "2026-04-01", "2026-04-30", HOJE)).saldoInicialCentavos, 60000);
      assert.ok((await fluxoCaixa(tx, id, "2026-03-01", "2026-03-31", HOJE)).linhas.some((linha) => linha.descricao === "Devolução ao cliente" && linha.saida === 40000));
    }

    // Cronograma misto: item preservado de plano substituído, item novo, parcela antiga fora dele (plano substituído) e
    // parcela histórica do plano ativo fora do cronograma, com recebimento. Contar e listar concordam.
    // Cobertura exata da 015: obrigação 1.000 − recebido 400 = itens 300 + 300.
    {
      const id = await empresa(db);
      const c = await contratoComFesta(db, id, ator);
      const antigo = await plano(db, c.pagamento, 1, false);
      const novo = await plano(db, c.pagamento, 2, true);
      const preservada = await parcela(db, antigo, 1, 300, "2026-04-20");
      const semItem = await parcela(db, antigo, 2, 700, "2026-04-05");
      const nova = await parcela(db, novo, 1, 400, "2026-05-05");
      const historica = await parcela(db, novo, 2, 100, "2026-04-10");
      const eventoCrono = await eventoNaGestao(db, c.pagamento, ator, 1, "CRONOGRAMA_REPROGRAMADO");
      const crono = await umId(db,
        `INSERT INTO pagamento_cronogramas (pagamento_id, evento_id, plano_id, versao_referencia_id, estado, modo, saldo_inicial_centavos, data_festa_referencia)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ATIVO', 'PERSONALIZADO', 60000, '2026-03-20') RETURNING id`,
        [c.pagamento, eventoCrono, novo, c.versao]);
      await db.query(
        `INSERT INTO pagamento_cronograma_itens (cronograma_id, parcela_id, ordem, origem, saldo_inicial_centavos, recebido_base_centavos, estornado_base_centavos, vencimento_referencia)
         VALUES ($1::uuid, $2::uuid, 1, 'PRESERVADA', 30000, 0, 0, '2026-04-20'), ($1::uuid, $3::uuid, 2, 'REPROGRAMADA', 30000, 0, 0, '2026-05-05')`,
        [crono, preservada, nova]);
      await recebimento(db, c.pagamento, 300, "2026-03-05T00:00:00Z", [[semItem, 300]]);
      await recebimento(db, c.pagamento, 100, "2026-03-06T00:00:00Z", [[historica, 100]]);
      const itens = await listarRecebiveis(tx, id, HOJE);
      assert.deepEqual(itens.map((item) => item.id).sort(), [nova, preservada, historica].sort(),
        "a antiga de plano substituído fora do cronograma não é título; a do plano ativo com recebimento é histórico");
      assert.equal(itens.find((item) => item.id === preservada)?.saldoCentavos, 30000);
      assert.equal(itens.find((item) => item.id === preservada)?.vencimento, "2026-04-20");
      assert.equal(itens.find((item) => item.id === nova)?.saldoCentavos, 30000);
      assert.equal(itens.find((item) => item.id === historica)?.saldoCentavos, 0);
      await paridadeComMotor(tx, c.contrato, id);
      assert.equal(await contarRecebiveis(tx, id, 100), itens.length);
      assert.equal(await contarRecebiveis(tx, id, 1), 2, "para em teto + 1");
      assert.equal((await financeiroDaFesta(tx, id, c.festa, HOJE)).valorContratadoCentavos, 100000);
      assert.equal((await financeiroDaFesta(tx, id, c.festa, HOJE)).recebidoCentavos, 40000);
      await assert.rejects(() => prepararBaixa(tx, id, HOJE, { parcelaId: semItem, valor: 1, data: HOJE, forma: "PIX" }));
      await assert.rejects(() => prepararBaixa(tx, id, HOJE, { parcelaId: historica, valor: 1, data: HOJE, forma: "PIX" }));
    }

    // Festa de outro mês com só despesa paga no período aparece no resultado, com margem fora do escopo.
    {
      const id = await empresa(db);
      const c = await contratoComFesta(db, id, ator, 1000, "2026-01-10");
      await parcela(db, await plano(db, c.pagamento), 1, 1000, "2026-01-05");
      const categoria = await umId(db, `INSERT INTO financeiro_categorias (empresa_id, tipo, nome) VALUES ($1::uuid, 'DESPESA', 'Compras') RETURNING id`, [id]);
      const conta = await criarContaPagar(tx, id, ator, { descricao: "Decoração", categoriaId: categoria, valor: 300, vencimento: "2026-03-10", festaId: c.festa });
      await pagarConta(tx, id, ator, HOJE, { contaId: conta, valor: 300, data: "2026-03-10", forma: "PIX", chave: randomUUID() });
      const rel = await relatorio(tx, id, "2026-03-01", "2026-03-31", HOJE);
      const linha = rel.margens.find((item) => item.festaId === c.festa);
      assert.equal(linha?.resultadoCaixaCentavos, -30000);
      assert.equal(linha?.margemEstimadaCentavos, null);
      assert.equal(linha?.noEscopo, false);
    }

    // Festa de maio com R$ 100 recebidos e R$ 100 estornados em abril: aparece em abril com resultado zero.
    {
      const id = await empresa(db);
      const c = await contratoComFesta(db, id, ator, 1000, "2026-05-10");
      const p = await parcela(db, await plano(db, c.pagamento), 1, 1000, "2026-04-05");
      const rec = await recebimento(db, c.pagamento, 100, "2026-04-05T00:00:00Z", [[p, 100]]);
      await estorno(db, rec, p, 100, "2026-04-20T15:00:00Z");
      const linha = (await relatorio(tx, id, "2026-04-01", "2026-04-30", HOJE)).margens.find((item) => item.festaId === c.festa);
      assert.equal(linha?.resultadoCaixaCentavos, 0);
      assert.equal(linha?.noEscopo, false);
    }

    // Cartão sem taxa conta no aviso. Dinheiro e Pix sem taxa, não.
    {
      const id = await empresa(db);
      const c = await contratoComFesta(db, id, ator);
      const p = await parcela(db, await plano(db, c.pagamento), 1, 1000, "2026-03-05");
      await recebimento(db, c.pagamento, 100, "2026-03-05T00:00:00Z", [[p, 100]], { forma: "CARTAO_CREDITO", taxaCentavos: 0 }, "CARTAO");
      await recebimento(db, c.pagamento, 100, "2026-03-05T00:00:00Z", [[p, 100]], { forma: "CARTAO_CREDITO", taxaCentavos: 300 }, "CARTAO");
      await recebimento(db, c.pagamento, 100, "2026-03-05T00:00:00Z", [[p, 100]], { forma: "DINHEIRO", taxaCentavos: 0 }, "DINHEIRO");
      await recebimento(db, c.pagamento, 100, "2026-03-05T00:00:00Z", [[p, 100]], {}, "PIX");
      assert.equal((await fluxoCaixa(tx, id, "2026-03-01", "2026-03-31", HOJE)).recebimentosSemTaxa, 1);
      assert.equal((await relatorio(tx, id, "2026-03-01", "2026-03-31", HOJE)).recebimentosSemTaxa, 1);
    }

    // Idempotência da despesa: retry devolve a mesma, pedido diferente recusa, chave vale entre avulsa e série.
    {
      const id = await empresa(db);
      const outra = await empresa(db);
      const categoria = await umId(db, `INSERT INTO financeiro_categorias (empresa_id, tipo, nome) VALUES ($1::uuid, 'DESPESA', 'Compras') RETURNING id`, [id]);
      const categoriaOutra = await umId(db, `INSERT INTO financeiro_categorias (empresa_id, tipo, nome) VALUES ($1::uuid, 'DESPESA', 'Compras') RETURNING id`, [outra]);
      const c = await contratoComFesta(db, id, ator);
      const conflito = (erro: unknown) => erro instanceof PacoteAdminError && erro.code === "IDEMPOTENCIA_CONFLITANTE" && erro.httpStatus === 409;
      const avulsa = { descricao: "Compra", categoriaId: categoria, valor: 50, vencimento: "2026-03-10", chave: "chave-avulsa-1" };
      const criada = await criarContaPagar(tx, id, ator, avulsa);
      assert.equal(await criarContaPagar(tx, id, ator, avulsa), criada);
      await assert.rejects(() => criarContaPagar(tx, id, ator, { ...avulsa, valor: 51 }), conflito);
      // Editada para R$ 51, a chave continua presa ao pedido original de R$ 50.
      await editarContaPagar(tx, id, ator, criada, { descricao: "Compra", categoriaId: categoria, valor: 51, vencimento: "2026-03-10" });
      assert.equal(await criarContaPagar(tx, id, ator, avulsa), criada);
      await assert.rejects(() => criarContaPagar(tx, id, ator, { ...avulsa, valor: 51 }), conflito);
      await assert.rejects(() => criarContaPagar(tx, id, ator, { ...avulsa, recorrente: true }), conflito);
      assert.notEqual(await criarContaPagar(tx, outra, ator, { ...avulsa, categoriaId: categoriaOutra }), criada, "a chave é por empresa");

      const serie = { descricao: "Aluguel", categoriaId: categoria, valor: 80, vencimento: "2026-03-10", recorrente: true, chave: "chave-serie-1" };
      const primeira = await criarContaPagar(tx, id, ator, serie);
      assert.equal(await criarContaPagar(tx, id, ator, serie), primeira);
      await assert.rejects(() => criarContaPagar(tx, id, ator, { ...serie, valor: 81 }), conflito);
      await assert.rejects(() => criarContaPagar(tx, id, ator, { ...serie, recorrente: false }), conflito);
      const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM financeiro_contas_pagar WHERE empresa_id = $1::uuid AND descricao = 'Aluguel'`, [id]);
      assert.equal(total.rows[0].n, 12);
      // A primeira ocorrência (10/03) passa para 11/04, depois da segunda (10/04): a chave segue presa ao pedido original.
      await editarContaPagar(tx, id, ator, primeira, { descricao: "Aluguel", categoriaId: categoria, valor: 80, vencimento: "2026-04-11" });
      assert.equal(await criarContaPagar(tx, id, ator, serie), primeira);
      await assert.rejects(() => criarContaPagar(tx, id, ator, { ...serie, vencimento: "2026-04-10" }), conflito);

      // Legado sem impressão com a mesma chave nas duas tabelas (a 052 permite): cada modalidade responde pela sua.
      const luzSerie = await umId(db, `INSERT INTO financeiro_recorrencias (empresa_id, horizonte_meses, chave_idempotencia) VALUES ($1::uuid, 12, 'chave-legado') RETURNING id`, [id]);
      const gasAvulsa = await umId(db,
        `INSERT INTO financeiro_contas_pagar (empresa_id, categoria_id, descricao, valor, vencimento, chave_criacao, criado_por)
         VALUES ($1::uuid, $2::uuid, 'Gás', 30, '2026-03-05', 'chave-legado', $3::uuid) RETURNING id`, [id, categoria, ator]);
      const luzPrimeira = await umId(db,
        `INSERT INTO financeiro_contas_pagar (empresa_id, categoria_id, recorrencia_id, descricao, valor, vencimento, criado_por)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Luz', 70, '2026-03-10', $4::uuid) RETURNING id`, [id, categoria, luzSerie, ator]);
      const luz = { descricao: "Luz", categoriaId: categoria, valor: 70, vencimento: "2026-03-10", recorrente: true, chave: "chave-legado" };
      const gas = { descricao: "Gás", categoriaId: categoria, valor: 30, vencimento: "2026-03-05", chave: "chave-legado" };
      assert.equal(await criarContaPagar(tx, id, ator, luz), luzPrimeira, "série legada responde pela série, não pela avulsa de 05/03");
      assert.equal(await criarContaPagar(tx, id, ator, gas), gasAvulsa);
      await assert.rejects(() => criarContaPagar(tx, id, ator, { ...luz, valor: 71 }), conflito);
      await assert.rejects(() => criarContaPagar(tx, id, ator, { ...gas, valor: 31 }), conflito);

      // Chave legada só numa modalidade: a outra recebe 409 e não cria nada; o retry legado continua valendo.
      const soAvulsa = await umId(db,
        `INSERT INTO financeiro_contas_pagar (empresa_id, categoria_id, descricao, valor, vencimento, chave_criacao, criado_por)
         VALUES ($1::uuid, $2::uuid, 'Água', 40, '2026-03-06', 'chave-legado-avulsa', $3::uuid) RETURNING id`, [id, categoria, ator]);
      const agua = { descricao: "Água", categoriaId: categoria, valor: 40, vencimento: "2026-03-06", chave: "chave-legado-avulsa" };
      await assert.rejects(() => criarContaPagar(tx, id, ator, { ...agua, recorrente: true }), conflito);
      const semSerie = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM financeiro_recorrencias WHERE empresa_id = $1::uuid AND chave_idempotencia = 'chave-legado-avulsa'`, [id]);
      assert.equal(semSerie.rows[0].n, 0);
      assert.equal(await criarContaPagar(tx, id, ator, agua), soAvulsa);
      const soSerie = await umId(db, `INSERT INTO financeiro_recorrencias (empresa_id, horizonte_meses, chave_idempotencia) VALUES ($1::uuid, 12, 'chave-legado-serie') RETURNING id`, [id]);
      const soSeriePrimeira = await umId(db,
        `INSERT INTO financeiro_contas_pagar (empresa_id, categoria_id, recorrencia_id, descricao, valor, vencimento, criado_por)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Internet', 60, '2026-03-07', $4::uuid) RETURNING id`, [id, categoria, soSerie, ator]);
      const internet = { descricao: "Internet", categoriaId: categoria, valor: 60, vencimento: "2026-03-07", recorrente: true, chave: "chave-legado-serie" };
      await assert.rejects(() => criarContaPagar(tx, id, ator, { ...internet, recorrente: false }), conflito);
      const semAvulsa = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM financeiro_contas_pagar WHERE empresa_id = $1::uuid AND chave_criacao = 'chave-legado-serie'`, [id]);
      assert.equal(semAvulsa.rows[0].n, 0);
      assert.equal(await criarContaPagar(tx, id, ator, internet), soSeriePrimeira);

      // Auditoria que falha volta ao savepoint e sobe com a causa original, sem deixar conta.
      await db.query(`
        CREATE FUNCTION financeiro_auditoria_falha_p1() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN IF NEW.acao = 'CONTA_PAGAR_PEDIDO' THEN RAISE EXCEPTION 'falha de auditoria do teste'; END IF; RETURN NEW; END $f$;
        CREATE TRIGGER falha_impressao_trg BEFORE INSERT ON financeiro_auditoria FOR EACH ROW EXECUTE FUNCTION financeiro_auditoria_falha_p1();`);
      await assert.rejects(() => criarContaPagar(tx, id, ator, { ...avulsa, chave: "chave-auditoria-falha" }), /falha de auditoria do teste/);
      await db.query("DROP TRIGGER falha_impressao_trg ON financeiro_auditoria; DROP FUNCTION financeiro_auditoria_falha_p1()");
      const semConta = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM financeiro_contas_pagar WHERE empresa_id = $1::uuid AND chave_criacao = 'chave-auditoria-falha'`, [id]);
      assert.equal(semConta.rows[0].n, 0);

      const daFesta = { descricao: "Bolo", categoriaId: categoria, valor: 90, vencimento: "2026-03-10", festaId: c.festa, chave: "chave-festa-1" };
      const bolo = await criarContaPagar(tx, id, ator, daFesta);
      assert.equal(await criarContaPagar(tx, id, ator, daFesta), bolo);
      await assert.rejects(() => criarContaPagar(tx, id, ator, { ...daFesta, festaId: null }), conflito);
    }
    // As fixtures precisam passar pelos validadores diferidos; o ROLLBACK sozinho não os verificaria. Os do contrato
    // (013/057/061 e 019) já rodaram em cada contratoComFesta e rodam de novo aqui; os financeiros (015) rodam aqui.
    await validarContratoAgora(db);
    await db.query("SET CONSTRAINTS p015_validar, p015_validar_movimento IMMEDIATE");
    // Todo gatilho diferido restante (ex.: fr_confirmacao_agenda_trg da 014, cuja função a 114 altera), como no commit.
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("ROLLBACK");
  } finally {
    await encerrarDescartavel(db);
  }
});

test("duas conexões com a mesma chave criam uma despesa só", { timeout: 120_000 }, async () => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  const outro = await conectarDescartavel({ travar: false });
  const db2 = outro as unknown as Client;
  try {
    await db.query("BEGIN");
    const id = await empresa(db);
    const ator = await usuario(db);
    const categoria = await umId(db, `INSERT INTO financeiro_categorias (empresa_id, tipo, nome) VALUES ($1::uuid, 'DESPESA', 'Compras') RETURNING id`, [id]);
    // Categorias já gravadas: a espera observada na corrida só pode ser a trava da chave.
    await garantirCategorias(executor(db), id);
    await db.query("COMMIT");
    const pid2 = (await db2.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;

    async function corrida(pedido: Parameters<typeof criarContaPagar>[3], divergente?: Parameters<typeof criarContaPagar>[3]) {
      await db.query("BEGIN");
      const primeira = await criarContaPagar(executor(db), id, ator, pedido);
      await db2.query("BEGIN");
      const segunda = criarContaPagar(executor(db2), id, ator, divergente ?? pedido).then((valor) => valor, (erro: unknown) => erro);
      for (let tentativa = 0; ; tentativa += 1) {
        if ((await db.query(`SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted AND locktype = 'advisory'`, [pid2])).rowCount) break;
        if (tentativa === 99) throw new Error("a segunda conexão não esperou: não houve concorrência real");
        await new Promise((resolver) => setTimeout(resolver, 50));
      }
      await db.query("COMMIT");
      const resultado = await segunda;
      await db2.query("COMMIT");
      return { primeira, resultado };
    }

    const avulsa = { descricao: "Compra", categoriaId: categoria, valor: 50, vencimento: "2026-03-10", chave: `corrida-${randomUUID()}` };
    const a = await corrida(avulsa);
    assert.equal(a.resultado, a.primeira);
    const contagem = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM financeiro_contas_pagar WHERE empresa_id = $1::uuid AND chave_criacao = $2`, [id, avulsa.chave]);
    assert.equal(contagem.rows[0].n, 1);

    const diferente = { ...avulsa, chave: `corrida-${randomUUID()}` };
    const b = await corrida(diferente, { ...diferente, valor: 51 });
    assert.ok(b.resultado instanceof PacoteAdminError && b.resultado.code === "IDEMPOTENCIA_CONFLITANTE");

    // Avulsa × série: restrições únicas de tabelas diferentes; a trava por chave impede as duas de gravar.
    const cruzada = { ...avulsa, chave: `corrida-${randomUUID()}` };
    const x = await corrida(cruzada, { ...cruzada, recorrente: true });
    assert.ok(x.resultado instanceof PacoteAdminError && x.resultado.code === "IDEMPOTENCIA_CONFLITANTE");
    const cruzadas = await db.query<{ contas: number; series: number }>(
      `SELECT (SELECT count(*)::int FROM financeiro_contas_pagar WHERE empresa_id = $1::uuid AND chave_criacao = $2) AS contas,
              (SELECT count(*)::int FROM financeiro_recorrencias WHERE empresa_id = $1::uuid AND chave_idempotencia = $2) AS series`,
      [id, cruzada.chave]);
    assert.deepEqual(cruzadas.rows[0], { contas: 1, series: 0 });
    const inversa = { ...avulsa, chave: `corrida-${randomUUID()}`, recorrente: true };
    const y = await corrida(inversa, { ...inversa, recorrente: false });
    assert.ok(y.resultado instanceof PacoteAdminError && y.resultado.code === "IDEMPOTENCIA_CONFLITANTE");
    const inversas = await db.query<{ contas: number; series: number }>(
      `SELECT (SELECT count(*)::int FROM financeiro_contas_pagar WHERE empresa_id = $1::uuid AND chave_criacao = $2) AS contas,
              (SELECT count(*)::int FROM financeiro_recorrencias WHERE empresa_id = $1::uuid AND chave_idempotencia = $2) AS series`,
      [id, inversa.chave]);
    assert.deepEqual(inversas.rows[0], { contas: 0, series: 1 });

    const serie = { descricao: "Aluguel", categoriaId: categoria, valor: 80, vencimento: "2026-03-10", recorrente: true, chave: `corrida-${randomUUID()}` };
    const s = await corrida(serie);
    assert.equal(s.resultado, s.primeira);
    const ocorrencias = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM financeiro_contas_pagar conta JOIN financeiro_recorrencias r ON r.id = conta.recorrencia_id WHERE r.chave_idempotencia = $1`, [serie.chave]);
    assert.equal(ocorrencias.rows[0].n, 12);
  } finally {
    await encerrarDescartavel(db2);
    await encerrarDescartavel(db);
  }
});

// ---------------------------------------------------------------- consumidores reais (plano rev. 3.2 §406)

async function empresaAtiva(db: Client) {
  const id = await empresa(db);
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
  return id;
}

async function membershipAtiva(db: Client, empresaId: string, usuarioId: string) {
  const id = await umId(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp()) RETURNING id`, [empresaId, usuarioId]);
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [id]);
}

async function sessaoAdministrativa(db: Client, usuarioId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
     VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours')`,
    [usuarioId, hashToken(token), hashToken(randomBytes(32).toString("base64url"))]);
  return token;
}

/** Como a suíte da baixa: BEGIN/COMMIT/ROLLBACK dos serviços viram SAVEPOINTs da transação externa, nunca confirmada. */
function instalarPool(db: Client) {
  const troca: Record<string, string> = { BEGIN: "SAVEPOINT operacao", COMMIT: "RELEASE SAVEPOINT operacao", ROLLBACK: "ROLLBACK TO SAVEPOINT operacao" };
  (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool = {
    query: (sql: string, values?: unknown[]) => db.query(sql, values),
    connect: async () => ({ query: (sql: string, values?: unknown[]) => db.query(troca[sql] ?? sql, values), release() {} }),
  };
}

/** Valor do campo 54 do BR Code (TLV EMV): lido do próprio texto, não da resposta do serviço. */
function valorDoBrCode(brCode: string) {
  let i = 0;
  while (i + 4 <= brCode.length) {
    const id = brCode.slice(i, i + 2), tamanho = Number(brCode.slice(i + 2, i + 4));
    if (id === "54") return brCode.slice(i + 4, i + 4 + tamanho);
    i += 4 + tamanho;
  }
  return null;
}

/** Linhas do CSV (sem BOM e cabeçalho), separadas por ; e sem aspas: os valores deste cenário não têm ; nem aspas. */
function linhasCsv(conteudo: string) {
  const [cabecalho, ...linhas] = conteudo.replace(/^﻿/, "").split("\r\n").filter(Boolean).map((l) => l.split(";"));
  return linhas.map((l) => Object.fromEntries(cabecalho.map((c, i) => [c, l[i]])));
}

const diasCorridos = (de: string, ate: string) => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000);

/**
 * O modelo 062 não tem a 066. Ela entra na transação do teste e sai no ROLLBACK, como na suíte do Pix.
 * O arquivo tem BEGIN e COMMIT próprios: rodado inteiro, o COMMIT confirmaria a transação externa. Entra só o corpo, e só
 * quando a tabela não existe (nos modelos a partir da 066 ela já está lá).
 */
async function garantirPix066(db: Client) {
  if ((await db.query<{ t: string | null }>("SELECT to_regclass('public.empresa_pix_recebimento')::text AS t")).rows[0].t) return "presente";
  const texto = readFileSync(resolve(root, "database/migrations/20261006_066_pix_recebimento_empresa.sql"), "utf8");
  const controles = (texto.match(/^[ \t]*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)[ \t]*;/gim) ?? []).map((linha) => linha.trim().toUpperCase());
  assert.deepEqual(controles, ["BEGIN;", "COMMIT;"], "066: só o BEGIN e o COMMIT do arquivo controlam a transação");
  await db.query(texto.replace(/^[ \t]*BEGIN[ \t]*;/im, "").replace(/^[ \t]*COMMIT[ \t]*;/im, ""));
  assert.ok((await db.query<{ t: string | null }>("SELECT to_regclass('public.empresa_pix_recebimento')::text AS t")).rows[0].t, "066 instalada na transação");
  return "instalada";
}

// Passado no relógio real: a confirmação do motor recusa data posterior a Date.now() (pagamento.service.ts).
const DATA_BAIXA = "2026-10-30";

/** Uma linha do CSV (Vencimento, Valor, Recebido, Saldo, Situação) e o Pix esperado da parcela: valores fixos do cenário. */
type Titulo = { parcela: string; csv: [string, string, string, string, string]; pix: string };
type Faixa = { quantidade: number; totalCentavos: number };
const zero: Faixa = { quantidade: 0, totalCentavos: 0 };
const umTitulo = (totalCentavos: number): Faixa => ({ quantidade: 1, totalCentavos });
const centavosDoCsv = (texto: string) => Number(texto.replace(",", ""));

test("Pix, pré-validação, confirmação do motor, MCP e CSV concordam em cada cenário; outra empresa é controle de isolamento", { timeout: 300_000 }, async () => {
  const anterior = { NODE_ENV: process.env.NODE_ENV, ADMIN_AUTH_ORIGIN: process.env.ADMIN_AUTH_ORIGIN, RENDER: process.env.RENDER, KIDMAIS_DEPLOY_ENV: process.env.KIDMAIS_DEPLOY_ENV };
  (process.env as { NODE_ENV?: string }).NODE_ENV = "test";
  process.env.ADMIN_AUTH_ORIGIN = "http://localhost:3000";
  delete process.env.RENDER;
  delete process.env.KIDMAIS_DEPLOY_ENV;
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  type Tenant = { empresaComprovada: string; membershipId: string; usuarioId: string; papelAtual: string };
  const { pixDaParcela } = exigir(resolve(root, "lib/pagamentos/pix/recebimento.ts")) as { pixDaParcela: (tx: DbExecutor, tenant: Tenant, parcelaId: string, hoje: string) => Promise<{ copiaECola: string; valorCentavos: number }> };
  const { baixarRecebimentoNoTenant } = exigir(resolve(root, "lib/financeiro/baixa.ts")) as {
    baixarRecebimentoNoTenant: (tx: DbExecutor, tenant: Tenant, hoje: string, input: { parcelaId: string; valor: number; data: string; forma: "PIX"; chave: string }, context: { token: string; usuarioId: string; origem: string; requestId: string }) => Promise<{ reutilizado: boolean }>;
  };
  const { withTenantTransaction } = exigir(resolve(root, "lib/saas/provar-tenant.ts")) as { withTenantTransaction: <T>(sessao: { usuario_id: string; papel: string }, empresa: string | null, work: (tx: DbExecutor, tenant: Tenant) => Promise<T>) => Promise<T> };
  const { executarFerramentaMcp } = exigir(resolve(root, "lib/integracoes/mcp/ferramentas.ts")) as { executarFerramentaMcp: (nome: string, argumentos: unknown, principal: unknown, deps: unknown) => Promise<Record<string, unknown>> };
  const { exportarDados } = exigir(resolve(root, "lib/assinatura/exportacao.ts")) as { exportarDados: (tx: DbExecutor, tenant: Tenant, tipo: "contas-receber", ctx: { ip: null; userAgent: null }, hoje: string) => Promise<{ conteudo: string; total: number }> };
  // Serviços reais do reconhecimento da 015 e do cancelamento, pelo mesmo transpilador do motor.
  const { iniciarTratamento, resolverAlteracao } = exigir(resolve(root, "lib/pagamentos/services/alteracao-financeira.service.ts")) as typeof import("../pagamentos/services/alteracao-financeira.service.ts");
  const { cancelarFinanceiroDaContratacao } = exigir(resolve(root, "lib/pagamentos/services/cancelamento.service.ts")) as typeof import("../pagamentos/services/cancelamento.service.ts");
  const { registrarEstornoPagamento, registrarRecebimentoPagamento } = exigir(resolve(root, "lib/pagamentos/services/pagamento.service.ts")) as typeof import("../pagamentos/services/pagamento.service.ts");
  const { reprogramarCronograma } = exigir(resolve(root, "lib/pagamentos/services/cronograma.service.ts")) as typeof import("../pagamentos/services/cronograma.service.ts");
  // Aceite público da versão 2: os dois passos reais depois do OTP (contrato-publico.service).
  const { marcarVersaoContratoAssinada } = exigir(resolve(root, "lib/contratos/repositories/contrato.repository.ts")) as typeof import("../contratos/repositories/contrato.repository.ts");
  const { concluirFluxoCliente } = exigir(resolve(root, "lib/contratos/services/fluxo-publico.ts")) as typeof import("../contratos/services/fluxo-publico.ts");
  const codigoDe = async (p: Promise<unknown>) => { try { await p; return "SEM_ERRO"; } catch (erro) { return (erro as { code?: string; codigo?: string }).code ?? (erro as { codigo?: string }).codigo ?? String(erro); } };
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    await garantirPix066(db);
    // BEGIN/COMMIT/ROLLBACK dos serviços viram SAVEPOINTs desta transação, nunca confirmada.
    instalarPool(db);
    const tx = executor(db);
    const atorA = await usuario(db);
    const atorB = await usuario(db);
    const token = await sessaoAdministrativa(db, atorA);
    const sessao = { usuario_id: atorA, papel: "REPRESENTANTE_AUTORIZADO" };
    const tenants = new Map<string, Tenant>();

    // Cada cenário numa empresa própria: o MCP e o CSV somam por empresa, então o esperado é só o do cenário.
    async function novaEmpresa(ator = atorA) {
      const id = await empresaAtiva(db);
      await membershipAtiva(db, id, ator);
      await db.query("INSERT INTO empresa_pix_recebimento (empresa_id, tipo_chave, chave, nome_recebedor, cidade_recebedor, atualizado_por) VALUES ($1::uuid, 'EMAIL', $2, 'Buffet', 'Recife', $3::uuid)", [id, `${codigo()}@buffet.test`, ator]);
      tenants.set(id, { empresaComprovada: id, membershipId: `m-${id}`, usuarioId: ator, papelAtual: "REPRESENTANTE_AUTORIZADO" });
      return id;
    }
    const tenant = (empresaId: string) => tenants.get(empresaId)!;

    // Consumidores reais. Pix: valor lido do próprio BR Code. MCP: fonte real (contarRecebiveis + listarRecebiveis), relógio
    // fixo. CSV: arquivo gerado. Baixa: withTenantTransaction + baixarRecebimentoNoTenant, que chega à confirmação do motor.
    const pixDe = async (empresaId: string, parcelaId: string) => {
      try { return valorDoBrCode((await pixDaParcela(tx, tenant(empresaId), parcelaId, HOJE)).copiaECola); } catch (erro) { return (erro as { code?: string }).code ?? String(erro); }
    };
    const depsMcp = (extra: Record<string, unknown> = {}) => ({
      env: { MCP_ENABLED: "true", MCP_TENANT_ALLOWLIST: [...tenants.keys()].join(","), MCP_PUBLIC_URL: "http://127.0.0.1:9/api/mcp", MCP_REF_SECRET: "r".repeat(40), INTELIGENCIA_ENABLED: "true", AI_READ_ENABLED: "true", NODE_ENV: "test" },
      agora: () => new Date(`${HOJE}T15:00:00Z`),
      withTenantTransaction: async (_sessao: unknown, empresaId: string, work: (t: DbExecutor, tenant: Tenant) => Promise<unknown>) => work(tx, tenant(empresaId)),
      concessaoVigente: async () => true, leituraComercialPermitida: async () => true, agenda: async () => [],
      contarRecebiveis, recebiveis: listarRecebiveis, corpus: () => null, registrar: () => {}, ...extra,
    });
    const mcp = (empresaId: string, extra: Record<string, unknown> = {}) => executarFerramentaMcp("kidmais_consultar_recebiveis_resumo", {},
      { concessaoId: `c-${empresaId}`, usuarioId: tenant(empresaId).usuarioId, empresaId, clientId: "https://chatgpt.com/oauth/client.json", escopos: ["financeiro:read"], papel: "REPRESENTANTE_AUTORIZADO" }, depsMcp(extra));
    const csvDe = async (empresaId: string) => linhasCsv((await exportarDados(tx, tenant(empresaId), "contas-receber", { ip: null, userAgent: null }, HOJE)).conteudo)
      .map((l) => [l.Vencimento, l["Valor (R$)"], l["Recebido (R$)"], l["Saldo (R$)"], l["Situação"]])
      .sort((a, b) => a[0].localeCompare(b[0]));
    const baixaReal = (empresaId: string, parcelaId: string, valor: number, chave: string = randomUUID()) => withTenantTransaction(sessao, empresaId, (t, tenantProvado) =>
      baixarRecebimentoNoTenant(t, tenantProvado, HOJE, { parcelaId, valor, data: DATA_BAIXA, forma: "PIX", chave }, { token, usuarioId: atorA, origem: "financeiro", requestId: randomUUID() }));

    /** Pix, pré-validação, CSV e MCP contra os valores fixos do cenário. A capacidade do motor é a de paridadeComMotor. */
    async function confrontar(nome: string, empresaId: string, titulos: Titulo[], resumo: { emAberto: Faixa; vencidos: Faixa; aVencer: Faixa }) {
      for (const t of titulos) {
        assert.equal(await pixDe(empresaId, t.parcela), t.pix, `${nome}: Pix de ${t.csv[0]}`);
        const saldo = centavosDoCsv(t.csv[3]);
        const pedido = (valor: number) => prepararBaixa(tx, empresaId, HOJE, { parcelaId: t.parcela, valor, data: DATA_BAIXA, forma: "PIX" });
        if (saldo > 0) {
          assert.equal((await pedido(saldo / 100)).valorReais, saldo / 100, `${nome}: a pré-validação aceita o saldo de ${t.csv[0]}`);
          assert.equal(await codigoDe(pedido((saldo + 1) / 100)), "VALOR_EXCEDE_SALDO", `${nome}: e recusa um centavo a mais`);
        } else {
          assert.equal(await codigoDe(pedido(0.01)), "NAO_ENCONTRADO", `${nome}: sem saldo, ${t.csv[0]} não é oferecida à baixa`);
        }
      }
      assert.deepEqual(await csvDe(empresaId), titulos.map((t) => [...t.csv]).sort((a, b) => a[0].localeCompare(b[0])), `${nome}: CSV`);
      const lido = await mcp(empresaId);
      assert.deepEqual({ emAberto: lido.emAberto, vencidos: lido.vencidos, aVencer: lido.aVencer }, resumo, `${nome}: MCP`);
    }

    /** A confirmação do motor aceita exatamente o valor do QR de cada título aberto; depois, nada fica cobrável. */
    async function quitarPeloMotor(nome: string, empresaId: string, contrato: string, titulos: Titulo[]) {
      for (const t of titulos) {
        const saldo = centavosDoCsv(t.csv[3]);
        if (saldo > 0) assert.equal((await baixaReal(empresaId, t.parcela, saldo / 100)).reutilizado, false, `${nome}: a confirmação aceita o valor do QR de ${t.csv[0]}`);
      }
      await paridadeComMotor(tx, contrato, empresaId);
      for (const t of titulos) assert.equal(await pixDe(empresaId, t.parcela), "PARCELA_SEM_SALDO", `${nome}: ${t.csv[0]} sem QR depois da baixa`);
      assert.deepEqual((await mcp(empresaId)).emAberto, zero, `${nome}: nada em aberto depois da baixa`);
    }

    // Reconhecimento da 015 pelos serviços reais, na transação do teste (executor), com a sessão de atorA.
    type Pedido = Parameters<typeof resolverAlteracao>[2];
    const contextoFinanceiro = () => ({ token, requestId: randomUUID(), ip: null, userAgent: null, executor: tx, papelNoTenant: "REPRESENTANTE_AUTORIZADO" });
    const validar015Agora = async () => {
      await db.query("SET CONSTRAINTS p015_validar, p015_validar_movimento IMMEDIATE");
      await db.query("SET CONSTRAINTS p015_validar, p015_validar_movimento DEFERRED");
    };
    async function regularizar(contrato: string, pendencia: string, pedido: Omit<Pedido, "posicaoHash" | "decisaoContratante">) {
      const antes = await lerPosicaoFinanceira(tx, contrato);
      const iniciado = await iniciarTratamento(contrato, pendencia, antes.posicaoHash, randomUUID(), contextoFinanceiro()) as { resultado: { tratamentoId: string } };
      const emTratamento = await lerPosicaoFinanceira(tx, contrato);
      await resolverAlteracao(contrato, iniciado.resultado.tratamentoId, { ...pedido, posicaoHash: emTratamento.posicaoHash, decisaoContratante: "NAO_SE_APLICA" }, randomUUID(), contextoFinanceiro());
      await validar015Agora();
    }

    /**
     * Versão 2 pelo caminho do aceite público (contrato-publico.service): versão ATIVA em preparação, documento revisado,
     * edição AGUARDANDO_CLIENTE liberada e assinada pela empresa, OTP consumido por ela; depois os passos reais
     * marcarVersaoContratoAssinada e concluirFluxoCliente (assinatura do cliente, detecção da pendência financeira, edição
     * concluída, vigência e versao_atual = 2). Os validadores do contrato rodam antes de qualquer tratamento financeiro.
     */
    async function promoverVersao2(c: Awaited<ReturnType<typeof contratoComFesta>>, comercial: Record<string, unknown>, motivo: string) {
      await db.query("SELECT public.kidmais019_bloquear_contrato($1::uuid)", [c.contrato]);
      const snapshot = { ...c.snapshot, comercial };
      const snapshotHash = hashSnapshotContrato(snapshot);
      const pdf = pdfDe(`contrato ${c.contrato} v2`);
      const v2 = await umId(db,
        `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, documento_template_versao, motivo_nova_versao)
         VALUES ($1::uuid, 2, 'ATIVA', $2::jsonb, $3, 1, $4) RETURNING id`, [c.contrato, JSON.stringify(snapshot), snapshotHash, motivo]);
      const docs = await documentosDaVersao(db, v2, snapshotHash, pdf, c.assinante);
      await gravarEdicao(db, c.contrato, v2, docs.documento, c.assinante, "AGUARDANDO_CLIENTE", c.versao);
      await db.query(`UPDATE contrato_fluxos SET versao_em_preparacao_id = $2::uuid WHERE contrato_id = $1::uuid`, [c.contrato, v2]);
      await assinarPelaEmpresa(db, v2, docs, snapshotHash, pdf, c.assinante);
      const prova = await provaDoCliente(db, c.cliente, v2);
      const assinada = await marcarVersaoContratoAssinada({ versaoId: v2, documentoTemplateVersao: 1, documentoPdfHash: sha256(pdf), aceiteMetodo: "OTP" }, tx);
      assert.ok(assinada, "versão 2 marcada como assinada");
      await concluirFluxoCliente(tx, assinada, prova, { requestId: randomUUID(), ip: null, userAgent: null });
      await validarContratoAgora(db);
      const estado = (await db.query<{ versao_atual: number; vigente: string; preparacao: string | null; edicao: string; assinaturas: number }>(
        `SELECT c.versao_atual, f.versao_vigente_id::text AS vigente, f.versao_em_preparacao_id::text AS preparacao, e.estado AS edicao,
                (SELECT count(*)::int FROM contrato_assinaturas WHERE contrato_versao_id = $2::uuid) AS assinaturas
           FROM contratos c JOIN contrato_fluxos f ON f.contrato_id = c.id JOIN contrato_edicoes e ON e.contrato_versao_id = $2::uuid
          WHERE c.id = $1::uuid`, [c.contrato, v2])).rows[0];
      assert.deepEqual(estado, { versao_atual: 2, vigente: v2, preparacao: null, edicao: "CONCLUIDA", assinaturas: 2 }, "vigência da versão 2 pelo aceite real");
      const pendencias = (await db.query<{ id: string; motivos: string[] }>(
        `SELECT id::text AS id, ARRAY(SELECT jsonb_array_elements_text(diferencas->'motivos')) AS motivos
           FROM contrato_pendencias_financeiras WHERE contrato_id = $1::uuid AND versao_nova_id = $2::uuid`, [c.contrato, v2])).rows;
      assert.equal(pendencias.length, 1, "uma pendência, gravada pela detecção real");
      return { v2, pendencia: pendencias[0].id, motivos: pendencias[0].motivos };
    }

    // ------------------------------------------------ A: estorno parcial e quitação com taxa; B: controle de isolamento
    const A = await novaEmpresa();
    const B = await novaEmpresa(atorB);
    const parcial = await contratoComFesta(db, A, atorA);
    const pParcial = await parcela(db, await plano(db, parcial.pagamento), 1, 1000, "2026-03-05");
    // Baixa original pelo serviço, com chave conhecida, e estorno real de R$ 400 sobre ela (registrarEstornoPagamento).
    const chaveOriginal = randomUUID();
    assert.equal((await baixaReal(A, pParcial, 1000, chaveOriginal)).reutilizado, false, "baixa original pelo serviço");
    const recParcial = await umId(db, `SELECT id::text AS id FROM pagamento_recebimentos WHERE pagamento_id = $1::uuid`, [parcial.pagamento]);
    const estornoParcial = await registrarEstornoPagamento(
      { pagamentoId: parcial.pagamento, recebimentoId: recParcial, parcelaId: pParcial, valor: 400, motivo: "Estorno parcial", chaveIdempotencia: randomUUID(), confirmarAgora: true },
      { token, usuarioId: atorA, origem: "PAGAMENTO_INTERNO_DEV", requestId: randomUUID(), executor: tx });
    assert.equal(estornoParcial.reutilizado, false, "estorno real");
    await validar015Agora();
    const quitado = await contratoComFesta(db, A, atorA);
    const pQuitado = await parcela(db, await plano(db, quitado.pagamento), 1, 1000, "2026-03-06");
    await recebimento(db, quitado.pagamento, 1000, "2026-03-06T00:00:00Z", [[pQuitado, 1000]], { forma: "PIX", taxaCentavos: 2000 });
    const controle = await contratoComFesta(db, B, atorB);
    const pControle = await parcela(db, await plano(db, controle.pagamento), 1, 250, "2026-12-01");
    const tControle: Titulo[] = [{ parcela: pControle, csv: ["2026-12-01", "250,00", "0,00", "250,00", "A receber"], pix: "250.00" }];

    await paridadeComMotor(tx, parcial.contrato, A);
    await paridadeComMotor(tx, quitado.contrato, A);
    await confrontar("estorno parcial e taxa", A, [
      { parcela: pParcial, csv: ["2026-03-05", "1000,00", "600,00", "400,00", "Vencido"], pix: "400.00" },
      { parcela: pQuitado, csv: ["2026-03-06", "1000,00", "1000,00", "0,00", "Pago"], pix: "PARCELA_SEM_SALDO" },
    ], { emAberto: umTitulo(40000), vencidos: umTitulo(40000), aVencer: zero });
    const mcpA = await mcp(A);
    assert.deepEqual(mcpA.faixasAtraso, [
      { faixa: "ATE_30_DIAS", quantidade: 0, totalCentavos: 0 },
      { faixa: "DE_31_A_60_DIAS", quantidade: 0, totalCentavos: 0 },
      { faixa: "ACIMA_60_DIAS", quantidade: 1, totalCentavos: 40000 },
    ]);
    assert.equal(mcpA.maiorAtrasoDias, diasCorridos("2026-03-05", HOJE));
    // Caixa: em março só a quitação com taxa (1.000 − 20); a baixa original de A entra na data dela (DATA_BAIXA, outubro).
    // O estorno real grava o horário do relógio (novembro de 2026 em diante), fora dos dois meses conferidos.
    const caixaA = async () => [await recebidoNoPeriodo(tx, A, "2026-03-01", "2026-03-31"), await recebidoNoPeriodo(tx, A, "2026-10-01", "2026-10-31")];
    assert.deepEqual(await caixaA(), [98000, 100000]);
    await confrontar("controle B", B, tControle, { emAberto: umTitulo(25000), vencidos: zero, aVencer: umTitulo(25000) });
    assert.equal(await pixDe(B, pParcial), "PARCELA_NAO_ENCONTRADA", "B não alcança a parcela de A");
    assert.equal(await codigoDe(prepararBaixa(tx, B, HOJE, { parcelaId: pParcial, valor: 1, data: DATA_BAIXA, forma: "PIX" })), "NAO_ENCONTRADO");
    // Acima do teto: recusa na contagem, antes de listar.
    let listou = false;
    assert.equal(await codigoDe(mcp(A, {
      contarRecebiveis: async (t: DbExecutor, e: string, teto: number) => (await contarRecebiveis(t, e, teto)) + teto,
      recebiveis: async () => { listou = true; return []; },
    })), "VOLUME_ACIMA_DO_LIMITE");
    assert.equal(listou, false);

    // Baixa original, estorno, novo pagamento com outra chave e retry das duas chaves, com o rastro do que a confirmação grava.
    const recebimentosA = async () => (await db.query<{ id: string }>(`SELECT id::text AS id FROM pagamento_recebimentos WHERE pagamento_id = $1::uuid ORDER BY id`, [parcial.pagamento])).rows.map((r) => r.id);
    const rastro = async () => (await db.query<{ eventos: string[]; contextos: number; auditoria: number; historico: number; sequencia: string }>(
      `SELECT ARRAY(SELECT tipo || ':' || id::text FROM pagamento_eventos WHERE pagamento_id = $1::uuid ORDER BY sequencia) AS eventos,
              (SELECT count(*)::int FROM pagamento_movimentos_contextos WHERE pagamento_id = $1::uuid) AS contextos,
              (SELECT count(*)::int FROM financeiro_auditoria WHERE empresa_id = $2::uuid AND acao = 'RECEBIMENTO_REGISTRADO' AND entidade_id::text = $3) AS auditoria,
              (SELECT count(*)::int FROM eventos_historico_cliente WHERE entidade_tipo = 'PAGAMENTO_RECEBIMENTO' AND metadata->>'pagamentoId' = $1::text) AS historico,
              (SELECT sequencia::text FROM pagamento_gestoes WHERE pagamento_id = $1::uuid) AS sequencia`,
      [parcial.pagamento, A, pParcial])).rows[0];
    const antes = await rastro();
    assert.match(antes.eventos[0] ?? "", /^RECEBIMENTO_CONFIRMADO:/, "a baixa original pelo serviço");
    assert.match(antes.eventos.at(-1) ?? "", /^ESTORNO_CONFIRMADO:/, "o estorno real");
    assert.deepEqual([antes.auditoria, antes.historico], [1, 1], "a baixa original audita e registra no histórico");
    assert.equal(await codigoDe(baixaReal(A, pParcial, 400.01)), "VALOR_EXCEDE_SALDO");
    assert.deepEqual(await rastro(), antes, "a recusa não grava evento, contexto, auditoria nem histórico");
    assert.deepEqual(await recebimentosA(), [recParcial]);
    const chave = randomUUID();
    assert.equal((await baixaReal(A, pParcial, 400, chave)).reutilizado, false);
    const depoisDaPrimeira = await recebimentosA();
    const novo = depoisDaPrimeira.filter((id) => id !== recParcial);
    assert.equal(novo.length, 1, "um movimento novo");
    const primeira = await rastro();
    assert.deepEqual(primeira.eventos.slice(0, antes.eventos.length), antes.eventos, "os eventos anteriores ficam");
    assert.equal(primeira.eventos.length, antes.eventos.length + 1, "um evento financeiro novo");
    assert.match(primeira.eventos.at(-1) ?? "", /^RECEBIMENTO_CONFIRMADO:/, "a confirmação, sem registro pendente antes");
    assert.deepEqual([primeira.contextos, primeira.auditoria, primeira.historico], [antes.contextos + 1, antes.auditoria + 1, antes.historico + 1]);
    assert.deepEqual(await caixaA(), [98000, 140000], "o novo pagamento entra em outubro, na data da baixa");
    assert.notEqual(primeira.sequencia, antes.sequencia);
    // Um retrato só para as duas chaves e os dois conflitos: recebimentos, alocações, caixa (março, outubro e o dia civil
    // do estorno real), eventos, contextos, auditoria financeira, histórico, sequência e a auditoria geral dos dois
    // recebimentos (o original, estornado, e o novo).
    const diaDoEstorno = (await db.query<{ dia: string }>(
      `SELECT (confirmado_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia FROM pagamento_estornos WHERE id = $1::uuid`, [estornoParcial.estorno.id])).rows[0].dia;
    assert.notEqual(diaDoEstorno, DATA_BAIXA, "o estorno real cai em outro dia que as baixas");
    assert.equal(await recebidoNoPeriodo(tx, A, diaDoEstorno, diaDoEstorno), -40000, "o estorno real sai do caixa no dia civil dele");
    const alocacoesA = async () => (await db.query<{ n: number; total: string }>(
      `SELECT count(*)::int AS n, coalesce(sum(a.valor_alocado), 0)::text AS total
         FROM pagamento_recebimento_alocacoes a JOIN pagamento_recebimentos r ON r.id = a.recebimento_id WHERE r.pagamento_id = $1::uuid`,
      [parcial.pagamento])).rows[0];
    const auditoriaDosRecebimentos = async () => (await db.query<{ original: number; novo: number }>(
      `SELECT count(*) FILTER (WHERE entidade_id::text = $1)::int AS original, count(*) FILTER (WHERE entidade_id::text = $2)::int AS novo
         FROM auditoria WHERE entidade_id::text IN ($1, $2)`, [recParcial, novo[0]])).rows[0];
    const retrato = async () => ({
      recebimentos: await recebimentosA(),
      alocacoes: await alocacoesA(),
      caixa: [...(await caixaA()), await recebidoNoPeriodo(tx, A, diaDoEstorno, diaDoEstorno)],
      rastro: await rastro(),
      auditoria: await auditoriaDosRecebimentos(),
    });
    const base = await retrato();
    assert.deepEqual(base.caixa, [98000, 140000, -40000]);
    assert.ok(base.auditoria.original >= 1 && base.auditoria.novo >= 1, "as duas confirmações auditam o movimento");
    const repeticoes: Array<[string, number, string, boolean]> = [
      ["nova", 400, chave, true],
      ["nova com outro valor", 399, chave, false],
      ["original", 1000, chaveOriginal, true],
      ["original com outro valor", 999, chaveOriginal, false],
    ];
    for (const [nome, valor, chaveDaBaixa, reutiliza] of repeticoes) {
      if (reutiliza) assert.equal((await baixaReal(A, pParcial, valor, chaveDaBaixa)).reutilizado, true, `retry da chave ${nome}`);
      else assert.equal(await codigoDe(baixaReal(A, pParcial, valor, chaveDaBaixa)), "IDEMPOTENCIA_CONFLITANTE", `chave ${nome}`);
      assert.deepEqual(await retrato(), base, `${nome}: recebimentos, alocações, caixa, trilha e auditoria iguais`);
    }
    await paridadeComMotor(tx, parcial.contrato, A);
    await confrontar("estorno parcial depois da baixa", A, [
      { parcela: pParcial, csv: ["2026-03-05", "1000,00", "1000,00", "0,00", "Pago"], pix: "PARCELA_SEM_SALDO" },
      { parcela: pQuitado, csv: ["2026-03-06", "1000,00", "1000,00", "0,00", "Pago"], pix: "PARCELA_SEM_SALDO" },
    ], { emAberto: zero, vencidos: zero, aVencer: zero });
    await confrontar("controle B depois da baixa em A", B, tControle, { emAberto: umTitulo(25000), vencidos: zero, aVencer: umTitulo(25000) });

    // ------------------------------------------------ Estorno total: R$ 1.000 recebidos e estornados; tudo volta a cobrar.
    {
      const id = await novaEmpresa();
      const c = await contratoComFesta(db, id, atorA);
      const p = await parcela(db, await plano(db, c.pagamento), 1, 1000, "2026-03-05");
      const rec = await recebimento(db, c.pagamento, 1000, "2026-03-05T00:00:00Z", [[p, 1000]]);
      await estorno(db, rec, p, 1000, "2026-04-10T15:00:00Z");
      const titulos: Titulo[] = [{ parcela: p, csv: ["2026-03-05", "1000,00", "0,00", "1000,00", "Vencido"], pix: "1000.00" }];
      await paridadeComMotor(tx, c.contrato, id);
      await confrontar("estorno total", id, titulos, { emAberto: umTitulo(100000), vencidos: umTitulo(100000), aVencer: zero });
      await quitarPeloMotor("estorno total", id, c.contrato, titulos);
    }

    // ------------------------------------------------ Obrigação reduzida pela 015 e devolução do crédito (oráculo do plano):
    // R$ 1.000 recebidos; a versão 2 reduz para R$ 600 e entra em vigor pelo aceite real (promoverVersao2, com os
    // validadores do contrato); o reconhecimento passa pelos serviços reais (iniciarTratamento + resolverAlteracao: ajuste
    // com delta −400, bases e cronograma SEM_SALDO vinculado ao ajuste). Depois, devolução de R$ 400 pendente (reserva) e
    // concluída (sai do caixa). Nenhum estado reabre cobrança.
    {
      const id = await novaEmpresa();
      const c = await contratoComFesta(db, id, atorA);
      const p = await parcela(db, await plano(db, c.pagamento), 1, 1000, "2026-03-05");
      const rec = await recebimento(db, c.pagamento, 1000, "2026-03-05T00:00:00Z", [[p, 1000]]);
      const { v2, pendencia, motivos } = await promoverVersao2(c, { valorFinalContrato: 600 }, "Pacote reduzido");
      assert.deepEqual(motivos, ["VALOR"], "a detecção real registra a redução");
      const antesDoAjuste = await lerPosicaoFinanceira(tx, c.contrato);
      assert.deepEqual([antesDoAjuste.motivos, antesDoAjuste.posicao.obrigacao, antesDoAjuste.posicao.credito, antesDoAjuste.vigente.id], [["VALOR"], 100000n, 0n, v2]);
      await regularizar(c.contrato, pendencia, { modo: "SEM_SALDO", parcelas: [], credito: "MANTER", justificativa: "Pacote reduzido" });
      const reconhecida = await lerPosicaoFinanceira(tx, c.contrato);
      assert.deepEqual(
        [reconhecida.reconhecida.id, reconhecida.ajustes.map((a) => [a.delta_centavos, a.obrigacao_depois_centavos]), reconhecida.cronograma?.saldo_inicial_centavos, reconhecida.futuro, reconhecida.motivos],
        [v2, [["-40000", "60000"]], "0", [], []],
        "015: versão 2 reconhecida, delta −400, cronograma SEM_SALDO, sem pendência");
      assert.deepEqual([reconhecida.posicao.obrigacao, reconhecida.posicao.liquido, reconhecida.posicao.saldo, reconhecida.posicao.credito, reconhecida.posicao.disponivel], [60000n, 100000n, 0n, 40000n, 40000n]);
      const titulos: Titulo[] = [{ parcela: p, csv: ["2026-03-05", "1000,00", "1000,00", "0,00", "Pago"], pix: "PARCELA_SEM_SALDO" }];
      const motorDaLista = async () => (await listarRecebiveis(tx, id, HOJE)).map((item) => item.motor);
      assert.deepEqual(await motorDaLista(), [{ obrigacaoCentavos: 60000, liquidoCentavos: 100000, cronograma: true }]);
      await paridadeComMotor(tx, c.contrato, id);
      await confrontar("obrigação reduzida, crédito disponível", id, titulos, { emAberto: zero, vencidos: zero, aVencer: zero });

      const alocacao = await umId(db, `SELECT id FROM pagamento_recebimento_alocacoes WHERE recebimento_id = $1::uuid`, [rec]);
      const eventoReserva = await proximoEvento(db, c.pagamento, atorA, "DEVOLUCAO_SOLICITADA");
      const reserva = await umId(db, `INSERT INTO pagamento_credito_reservas (pagamento_id, evento_criacao_id, valor_centavos, estado) VALUES ($1::uuid, $2::uuid, 40000, 'ATIVA') RETURNING id`, [c.pagamento, eventoReserva]);
      const devolucao = await umId(db,
        `INSERT INTO pagamento_devolucoes (pagamento_id, reserva_id, evento_solicitacao_id, estado, valor_centavos, beneficiario_snapshot, motivo)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDENTE', 40000, '{"nome":"Maria"}'::jsonb, 'Redução') RETURNING id`,
        [c.pagamento, reserva, eventoReserva]);
      await db.query(`INSERT INTO pagamento_devolucao_alocacoes (devolucao_id, recebimento_alocacao_id, valor_centavos) VALUES ($1::uuid, $2::uuid, 40000)`, [devolucao, alocacao]);
      const pendente = await lerPosicaoFinanceira(tx, c.contrato);
      assert.deepEqual([pendente.posicao.obrigacao, pendente.posicao.liquido, pendente.posicao.saldo, pendente.posicao.credito, pendente.posicao.reservado, pendente.posicao.disponivel], [60000n, 100000n, 0n, 40000n, 40000n, 0n], "pendente: reserva o crédito");
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-03-01", "2026-03-31"), 100000);
      await semAbertura(tx, id, "2026-05-01", "2026-05-31");
      const comSaldo = await abrirCaixa(db, id, atorA);
      if (comSaldo) assert.equal((await fluxoCaixa(tx, id, "2026-05-01", "2026-05-31", HOJE)).saldoInicialCentavos, 100000, "pendente não sai do caixa");
      assert.deepEqual(await motorDaLista(), [{ obrigacaoCentavos: 60000, liquidoCentavos: 100000, cronograma: true }]);
      await paridadeComMotor(tx, c.contrato, id);
      await confrontar("obrigação reduzida, devolução pendente", id, titulos, { emAberto: zero, vencidos: zero, aVencer: zero });
      // A 015 também no estado intermediário; depois volta a diferir para a conclusão.
      await db.query("SET CONSTRAINTS p015_validar, p015_validar_movimento IMMEDIATE");
      await db.query("SET CONSTRAINTS p015_validar, p015_validar_movimento DEFERRED");

      const eventoFim = await proximoEvento(db, c.pagamento, atorA, "DEVOLUCAO_CONCLUIDA", { papel: "REPRESENTANTE_AUTORIZADO" });
      await db.query(
        `UPDATE pagamento_devolucoes SET estado = 'CONCLUIDA', evento_conclusao_id = $2::uuid, devolvido_em = $3::timestamptz, meio_devolucao = 'PIX', observacao_execucao = 'Feito', justificativa_sem_comprovante = 'Teste' WHERE id = $1::uuid`,
        [devolucao, eventoFim, "2026-04-01T15:00:00Z"]);
      await db.query(`UPDATE pagamento_credito_reservas SET estado = 'CONSUMIDA', evento_encerramento_id = $2::uuid, encerrado_em = clock_timestamp() WHERE id = $1::uuid`, [reserva, eventoFim]);
      const concluida = await lerPosicaoFinanceira(tx, c.contrato);
      assert.deepEqual([concluida.posicao.obrigacao, concluida.posicao.devolvido, concluida.posicao.liquido, concluida.posicao.saldo, concluida.posicao.credito, concluida.posicao.reservado], [60000n, 40000n, 60000n, 0n, 0n, 0n], "concluída: sai do caixa, nada a cobrar");
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-03-01", "2026-03-31"), 100000);
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-04-01", "2026-04-30"), -40000, "a devolução sai na data dela");
      if (comSaldo) assert.equal((await fluxoCaixa(tx, id, "2026-05-01", "2026-05-31", HOJE)).saldoInicialCentavos, 60000);
      assert.deepEqual(await motorDaLista(), [{ obrigacaoCentavos: 60000, liquidoCentavos: 60000, cronograma: true }]);
      await paridadeComMotor(tx, c.contrato, id);
      await confrontar("obrigação reduzida, devolução concluída", id, titulos, { emAberto: zero, vencidos: zero, aVencer: zero });

      // Limitação do cancelamento, fora da P1: depois de um ajuste da 015, o p015_legado preserva a situação original do
      // pagamento e das parcelas, e cancelarFinanceiroDaContratacao é recusado. O estado e as leituras não mudam.
      const situacao = async () => (await db.query<{ pagamento: string; parcelas: string[] }>(
        `SELECT (SELECT status FROM pagamentos WHERE id = $1::uuid) AS pagamento,
                ARRAY(SELECT pp.status FROM pagamento_parcelas pp JOIN pagamento_planos pl ON pl.id = pp.plano_id WHERE pl.pagamento_id = $1::uuid ORDER BY pp.id) AS parcelas`,
        [c.pagamento])).rows[0];
      const antesDoCancelamento = await situacao();
      await db.query("SAVEPOINT cancelar_apos_ajuste");
      await db.query("SELECT public.kidmais019_bloquear_contrato($1::uuid)", [c.contrato]);
      await assert.rejects(
        cancelarFinanceiroDaContratacao(tx, c.contrato, c.cliente, { usuario_id: atorA } as never, "Cliente desistiu", randomUUID(), { requestId: randomUUID(), userAgent: null }),
        /Situação original preservada após regularização|Estado histórico preservado; consulte cronograma/,
        "depois da regularização, o cancelamento financeiro é recusado pela 015");
      await db.query("ROLLBACK TO SAVEPOINT cancelar_apos_ajuste");
      await db.query("RELEASE SAVEPOINT cancelar_apos_ajuste");
      assert.deepEqual(await situacao(), antesDoCancelamento);
      await confrontar("obrigação reduzida, cancelamento recusado", id, titulos, { emAberto: zero, vencidos: zero, aVencer: zero });
    }

    // ------------------------------------------------ Transferência de saldo (plano D.3): R$ 400 do item A para o item novo B.
    // Contrato de 1.000 com 600 recebidos em A. A versão 2 muda a condição de pagamento (aceite real); a regularização real
    // preserva A com os 400 (PERSONALIZADO). Depois, reprogramarCronograma real leva o saldo a B, num plano novo; o plano de
    // A fica substituído e A sai do cronograma. O caixa não muda; A perde a elegibilidade e só B cobra, pelo saldo do item.
    {
      const id = await novaEmpresa();
      const c = await contratoComFesta(db, id, atorA);
      const a = await parcela(db, await plano(db, c.pagamento), 1, 1000, "2026-03-05");
      await recebimento(db, c.pagamento, 600, "2026-03-05T00:00:00Z", [[a, 600]]);
      const { pendencia, motivos } = await promoverVersao2(c, { valorFinalContrato: 1000, formaPagamentoPretendida: "PIX_AVISTA" }, "Condição de pagamento");
      assert.deepEqual(motivos, ["CONDICAO"]);
      await regularizar(c.contrato, pendencia, { modo: "PERSONALIZADO", parcelas: [{ parcelaId: a, valorCentavos: "40000", vencimento: "2026-03-05" }], credito: "NAO_SE_APLICA", justificativa: "Mantém A" });
      await semAbertura(tx, id, "2026-05-01", "2026-05-31");
      const comSaldo = await abrirCaixa(db, id, atorA);
      const caixa = async () => [
        await recebidoNoPeriodo(tx, id, "2026-03-01", "2026-03-31"),
        (await fluxoCaixa(tx, id, "2026-05-01", "2026-05-31", HOJE)).saldoInicialCentavos,
      ];
      const caixaAntes = await caixa();
      assert.deepEqual(caixaAntes, [60000, comSaldo ? 60000 : null]);
      await paridadeComMotor(tx, c.contrato, id);
      await confrontar("transferência: antes, A cobra 400", id, [{ parcela: a, csv: ["2026-03-05", "1000,00", "600,00", "400,00", "Vencido"], pix: "400.00" }],
        { emAberto: umTitulo(40000), vencidos: umTitulo(40000), aVencer: zero });

      const posicaoAntes = await lerPosicaoFinanceira(tx, c.contrato);
      await reprogramarCronograma(c.contrato, {
        posicaoHash: posicaoAntes.posicaoHash, modo: "REPROGRAMAR", parcelas: [{ valorCentavos: "40000", vencimento: "2026-12-10" }],
        credito: "NAO_SE_APLICA", decisaoContratante: "NAO_SE_APLICA", justificativa: "Saldo de A para B",
      }, randomUUID(), contextoFinanceiro());
      await validar015Agora();
      const depois = await lerPosicaoFinanceira(tx, c.contrato, true);
      assert.equal(depois.futuro.length, 1, "um item no cronograma novo");
      const b = depois.futuro[0].parcelaId;
      assert.notEqual(b, a);
      assert.deepEqual([depois.futuro[0].valorCentavos, depois.futuro[0].vencimento, depois.posicao.saldo], ["40000", "2026-12-10", 40000n], "motor: B com os 400");
      // Mesmo que a pré-validação deixasse passar, a confirmação do motor recusa alocar em A (fora do cronograma vigente).
      assert.throws(() => validarCapacidadeConsolidada(depois, 0.01, [{ parcelaId: a, valor: 0.01 }]),
        (erro: unknown) => erro instanceof AlteracaoFinanceiraError && erro.code === "ALOCACAO_INVALIDA", "o motor recusa A com B em aberto");
      validarCapacidadeConsolidada(depois, 400, [{ parcelaId: b, valor: 400 }]);
      assert.deepEqual(await caixa(), caixaAntes, "o caixa não muda com a transferência");
      const titulosB: Titulo[] = [{ parcela: b, csv: ["2026-12-10", "400,00", "0,00", "400,00", "A receber"], pix: "400.00" }];
      await paridadeComMotor(tx, c.contrato, id);
      await confrontar("transferência: depois, só B cobra", id, titulosB, { emAberto: umTitulo(40000), vencidos: zero, aVencer: umTitulo(40000) });
      assert.equal(await pixDe(id, a), "PARCELA_NAO_ENCONTRADA", "A sem elegibilidade: nenhum QR pelo nominal de A");
      assert.equal(await codigoDe(prepararBaixa(tx, id, HOJE, { parcelaId: a, valor: 0.01, data: DATA_BAIXA, forma: "PIX" })), "NAO_ENCONTRADO");
      assert.equal(await codigoDe(baixaReal(id, a, 400)), "NAO_ENCONTRADO", "a baixa real também recusa A");
      await quitarPeloMotor("transferência", id, c.contrato, titulosB);
      assert.equal(await recebidoNoPeriodo(tx, id, "2026-03-01", "2026-03-31"), 60000, "a baixa de B entra na data dela, não em março");
    }

    // ------------------------------------------------ Cronograma misto (mesma montagem do teste das leituras gerenciais):
    // item preservado de plano substituído, item novo, parcela antiga sem item (não é título) e histórica do plano ativo.
    {
      const id = await novaEmpresa();
      const c = await contratoComFesta(db, id, atorA);
      const antigo = await plano(db, c.pagamento, 1, false);
      const novoPlano = await plano(db, c.pagamento, 2, true);
      const preservada = await parcela(db, antigo, 1, 300, "2026-04-20");
      const semItem = await parcela(db, antigo, 2, 700, "2026-04-05");
      const nova = await parcela(db, novoPlano, 1, 400, "2026-05-05");
      const historica = await parcela(db, novoPlano, 2, 100, "2026-04-10");
      const eventoCrono = await eventoNaGestao(db, c.pagamento, atorA, 1, "CRONOGRAMA_REPROGRAMADO");
      const crono = await umId(db,
        `INSERT INTO pagamento_cronogramas (pagamento_id, evento_id, plano_id, versao_referencia_id, estado, modo, saldo_inicial_centavos, data_festa_referencia)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ATIVO', 'PERSONALIZADO', 60000, '2026-03-20') RETURNING id`,
        [c.pagamento, eventoCrono, novoPlano, c.versao]);
      await db.query(
        `INSERT INTO pagamento_cronograma_itens (cronograma_id, parcela_id, ordem, origem, saldo_inicial_centavos, recebido_base_centavos, estornado_base_centavos, vencimento_referencia)
         VALUES ($1::uuid, $2::uuid, 1, 'PRESERVADA', 30000, 0, 0, '2026-04-20'), ($1::uuid, $3::uuid, 2, 'REPROGRAMADA', 30000, 0, 0, '2026-05-05')`,
        [crono, preservada, nova]);
      await recebimento(db, c.pagamento, 300, "2026-03-05T00:00:00Z", [[semItem, 300]]);
      await recebimento(db, c.pagamento, 100, "2026-03-06T00:00:00Z", [[historica, 100]]);
      const titulos: Titulo[] = [
        { parcela: historica, csv: ["2026-04-10", "100,00", "100,00", "0,00", "Pago"], pix: "PARCELA_SEM_SALDO" },
        { parcela: preservada, csv: ["2026-04-20", "300,00", "0,00", "300,00", "Vencido"], pix: "300.00" },
        { parcela: nova, csv: ["2026-05-05", "300,00", "0,00", "300,00", "Vencido"], pix: "300.00" },
      ];
      await paridadeComMotor(tx, c.contrato, id);
      await confrontar("cronograma misto", id, titulos, { emAberto: { quantidade: 2, totalCentavos: 60000 }, vencidos: { quantidade: 2, totalCentavos: 60000 }, aVencer: zero });
      assert.equal(await pixDe(id, semItem), "PARCELA_NAO_ENCONTRADA", "parcela antiga sem item não é título");
      assert.equal(await codigoDe(prepararBaixa(tx, id, HOJE, { parcelaId: semItem, valor: 0.01, data: DATA_BAIXA, forma: "PIX" })), "NAO_ENCONTRADO");
      await quitarPeloMotor("cronograma misto", id, c.contrato, titulos);
    }

    // ------------------------------------------------ Duas alocações: R$ 700 entre duas parcelas de 500.
    {
      const id = await novaEmpresa();
      const c = await contratoComFesta(db, id, atorA);
      const pl = await plano(db, c.pagamento);
      const p1 = await parcela(db, pl, 1, 500, "2026-03-05");
      const p2 = await parcela(db, pl, 2, 500, "2026-04-05");
      await recebimento(db, c.pagamento, 700, "2026-03-05T00:00:00Z", [[p1, 500], [p2, 200]]);
      const titulos: Titulo[] = [
        { parcela: p1, csv: ["2026-03-05", "500,00", "500,00", "0,00", "Pago"], pix: "PARCELA_SEM_SALDO" },
        { parcela: p2, csv: ["2026-04-05", "500,00", "200,00", "300,00", "Vencido"], pix: "300.00" },
      ];
      await paridadeComMotor(tx, c.contrato, id);
      await confrontar("duas alocações", id, titulos, { emAberto: umTitulo(30000), vencidos: umTitulo(30000), aVencer: zero });
      await quitarPeloMotor("duas alocações", id, c.contrato, titulos);
    }

    // ------------------------------------------------ Obrigação cancelada, no estado que o cancelamento real grava:
    // R$ 300 recebidos numa parcela e R$ 200 recebidos e estornados na outra. cancelarFinanceiroDaContratacao cancela o
    // plano ativo, as parcelas elegíveis e o pagamento; o contrato é cancelado como em cancelarContratacaoDaFesta.
    // Regra de visibilidade: sem cronograma, as parcelas do plano cancelado saem de contas a receber (lista, contagem,
    // CSV, Pix, baixa e MCP); o histórico fica no contrato. A posição do motor guarda a obrigação remanescente, sem cobrança.
    {
      const id = await novaEmpresa();
      const c = await contratoComFesta(db, id, atorA);
      const pl = await plano(db, c.pagamento);
      const p1 = await parcela(db, pl, 1, 500, "2026-03-05");
      const p2 = await parcela(db, pl, 2, 500, "2026-04-05");
      await recebimento(db, c.pagamento, 300, "2026-03-05T00:00:00Z", [[p1, 300]]);
      const rec2 = await recebimento(db, c.pagamento, 200, "2026-03-06T00:00:00Z", [[p2, 200]]);
      await estorno(db, rec2, p2, 200, "2026-04-10T15:00:00Z");
      const antes: Titulo[] = [
        { parcela: p1, csv: ["2026-03-05", "500,00", "300,00", "200,00", "Vencido"], pix: "200.00" },
        { parcela: p2, csv: ["2026-04-05", "500,00", "0,00", "500,00", "Vencido"], pix: "500.00" },
      ];
      await paridadeComMotor(tx, c.contrato, id);
      await confrontar("antes do cancelamento", id, antes, { emAberto: { quantidade: 2, totalCentavos: 70000 }, vencidos: { quantidade: 2, totalCentavos: 70000 }, aVencer: zero });

      await db.query("SELECT public.kidmais019_bloquear_contrato($1::uuid)", [c.contrato]);
      await cancelarFinanceiroDaContratacao(tx, c.contrato, c.cliente, { usuario_id: atorA } as never, "Cliente desistiu", randomUUID(), { requestId: randomUUID(), userAgent: null });
      await db.query("UPDATE contratos SET status = 'CANCELADO', cancelado_em = clock_timestamp() WHERE id = $1::uuid", [c.contrato]);
      const gravado = await db.query<{ plano: string; parcelas: string[]; pagamento: string }>(
        `SELECT (SELECT status FROM pagamento_planos WHERE id = $1::uuid) AS plano,
                ARRAY(SELECT status FROM pagamento_parcelas WHERE plano_id = $1::uuid ORDER BY numero) AS parcelas,
                (SELECT status FROM pagamentos WHERE id = $2::uuid) AS pagamento`, [pl, c.pagamento]);
      assert.deepEqual(gravado.rows[0], { plano: "CANCELADO", parcelas: ["CANCELADA", "CANCELADA"], pagamento: "CANCELADO" }, "estado do serviço real");
      const posicao = await lerPosicaoFinanceira(tx, c.contrato, true);
      assert.deepEqual(
        [posicao.cobranca.encerrada, posicao.cobranca.saldoACobrar, posicao.cobranca.acertoAdministrativoPendente, posicao.futuro, posicao.posicao.saldo],
        [true, 0n, true, [], 70000n],
        "motor: encerrada, nada a cobrar, R$ 700 de obrigação remanescente só no acerto administrativo");
      assert.equal(await contarRecebiveis(tx, id, 100), 0, "contar e listar concordam: nenhum título");
      await confrontar("obrigação cancelada", id, [], { emAberto: zero, vencidos: zero, aVencer: zero });
      for (const parcelaCancelada of [p1, p2]) {
        assert.equal(await pixDe(id, parcelaCancelada), "PARCELA_NAO_ENCONTRADA", "sem QR para parcela de plano cancelado");
        assert.equal(await codigoDe(prepararBaixa(tx, id, HOJE, { parcelaId: parcelaCancelada, valor: 0.01, data: DATA_BAIXA, forma: "PIX" })), "NAO_ENCONTRADO");
      }
      const antesDaBaixa = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pagamento_recebimentos WHERE pagamento_id = $1::uuid`, [c.pagamento])).rows[0].n;
      assert.equal(await codigoDe(baixaReal(id, p1, 0.01)), "NAO_ENCONTRADO", "a baixa real também recusa");
      // Abaixo da pré-validação: o serviço de pagamentos (registrarRecebimentoPagamento) recusa o pagamento cancelado.
      assert.equal(await codigoDe(registrarRecebimentoPagamento(
        { pagamentoId: c.pagamento, meioPagamento: "PIX", valorBruto: 0.01, recebidoEm: `${DATA_BAIXA}T00:00:00.000Z`, chaveIdempotencia: randomUUID(), confirmarAgora: true, alocacoes: [{ parcelaId: p1, valor: 0.01 }] },
        { token, usuarioId: atorA, origem: "PAGAMENTO_INTERNO_DEV", requestId: randomUUID(), executor: tx })), "PAGAMENTO_CANCELADO", "o serviço de pagamentos recusa a obrigação cancelada");
      assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pagamento_recebimentos WHERE pagamento_id = $1::uuid`, [c.pagamento])).rows[0].n, antesDaBaixa);
    }

    // ------------------------------------------------ Teto da obrigação sobre o plano (não é a redução da 015, coberta acima):
    // contrato de 600, parcela de 1.000 e R$ 300 recebidos. O plano diria 700; a obrigação limita a 300.
    {
      const id = await novaEmpresa();
      const c = await contratoComFesta(db, id, atorA, 600);
      const p = await parcela(db, await plano(db, c.pagamento), 1, 1000, "2026-03-05");
      await recebimento(db, c.pagamento, 300, "2026-03-05T00:00:00Z", [[p, 300]]);
      const posicao = await lerPosicaoFinanceira(tx, c.contrato, true);
      assert.deepEqual([posicao.posicao.saldo, posicao.futuro.map((item) => item.valorCentavos)], [30000n, ["70000"]], "motor: saldo 300, plano 700");
      const titulos: Titulo[] = [{ parcela: p, csv: ["2026-03-05", "1000,00", "300,00", "300,00", "Vencido"], pix: "300.00" }];
      await paridadeComMotor(tx, c.contrato, id);
      await confrontar("teto da obrigação", id, titulos, { emAberto: umTitulo(30000), vencidos: umTitulo(30000), aVencer: zero });
      await quitarPeloMotor("teto da obrigação", id, c.contrato, titulos);
    }

    await confrontar("controle B no fim", B, tControle, { emAberto: umTitulo(25000), vencidos: zero, aVencer: umTitulo(25000) });
    await validarContratoAgora(db);
    await db.query("SET CONSTRAINTS p015_validar, p015_validar_movimento IMMEDIATE");
    // Todo gatilho diferido restante (ex.: fr_confirmacao_agenda_trg da 014, cuja função a 114 altera), como no commit.
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    await db.query("ROLLBACK");
  } finally {
    delete (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool;
    for (const [nome, valor] of Object.entries(anterior)) {
      if (valor === undefined) delete (process.env as Record<string, string | undefined>)[nome];
      else (process.env as Record<string, string | undefined>)[nome] = valor;
    }
    await encerrarDescartavel(db);
  }
});
