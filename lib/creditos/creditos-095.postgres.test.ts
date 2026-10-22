import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { hashSnapshotContrato } from "../contratos/services/snapshot-core.ts";
import type { DbExecutor } from "../db/contracts";
import type { SessaoAdmin } from "../autenticacao/service.ts";
import { AsaasFalhou, type CobrancaProvedor } from "../assinatura/asaas.ts";
import { processarEvento, registrarEvento } from "../assinatura/sincronizacao.ts";
import { carregarModulo } from "../acessos/teste-carregador.ts";
import { hashTextoIA } from "../convites/consentimento.ts";
import { VERSAO_TEXTOS_IA } from "../convites/consentimento-textos.ts";
import { abrirCarteira, conferirCarteira, creditarLote, creditosInstalados, encerrarReserva, expirarVencidos, lerCarteira, reservar, SaldoInsuficiente } from "./ledger.ts";
import { aplicarCorte, simularCorte } from "./corte.ts";
import { criarPedido, type DepsCreditos } from "./compra.ts";
import { consultarCreditos } from "./servico.ts";
import { processarEventoCreditos, processarPedido, pedidosParaReconciliar } from "./pagamento.ts";
import { concluirCobrancaExtra, reprocessarPedido, resolverBloqueio, resolverRevisao } from "./operacao.ts";
import { createRequire } from "node:module";
import { registrarDevolucao, solicitarDevolucao } from "./devolucao.ts";
import { concederCortesia } from "./cortesia.ts";
import { manutencaoEmpresa } from "./manutencao.ts";
import { liquidarChamada, reservarChamada } from "./walle.ts";
import { proporcionalCentavos as proporcional, referenciaExterna } from "./dominio.ts";

/**
 * 095 — créditos de IA no PostgreSQL DESCARTÁVEL sobre o modelo 089 (inventário inteiro até a 089; a 095 é aplicada aqui).
 * Asaas e IA são DUBLÊS em memória (nenhuma rede); dados sintéticos. Só pelo check:v1:postgres com o opt-in do descartável.
 *   1. sem a 095: código novo tolera o schema antigo (instalado=false, compra 503, exportação com tabelas ausentes);
 *   2. precheck, aplicação, postcheck, reaplicação recusada, rollback vazio e reaplicação;
 *   3. corte do legado (lote LEGADO, idempotente, recusa com geração aberta), guardas (extrato imutável, sem negativo,
 *      FKs compostas por empresa, lote imutável, vencimento só prorroga);
 *   4. concorrência REAL: duas conexões disputam o último crédito (espera observada em pg_blocking_pids);
 *   5. compra com Asaas dublê: pedido/idempotência, recusa 4xx, timeout → incerto → recuperação pela referência,
 *      duplicidade → revisão, valor divergente → revisão, AUTHORIZED não libera, CONFIRMED → RECEIVED credita UMA vez,
 *      webhook duplicado em duas conexões (espera observada) → um lote; avulsa nunca toca a assinatura;
 *   6. devolução × consumo concorrentes, arrependimento integral com uso, proporcional, estorno automático por flag;
 *   7. expiração, manutenção (franquia mensal só para cortadas), cortesia com teto, Wall-e em µUS$, disputa/estorno externo;
 *   8. Convites pelo serviço real (IA dublê): motor legado intacto; motor novo consome 1 por geração concluída, devolve na
 *      falha pré-envio, mantém reserva em verificação; 088 continua obrigatória antes de reservar; flag off = 503;
 *   9. isolamento: empresa B com lotes, pedidos e reservas elegíveis, fotografia idêntica antes/depois;
 *  10. exportação com a 095 (CSVs dos créditos, colunas excluídas, filtro por empresa) e rollback recusado com dados.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP = ler("database/migrations/20261022_095_ia_creditos.sql");
const PRE = ler("database/checks/20261022_095_precheck.sql");
const POST = ler("database/checks/20261022_095_postcheck.sql");
const DOWN = ler("database/rollback/20261022_095_ia_creditos_down.sql");
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
const cod = () => `cr${randomBytes(3).toString("hex")}`;
const id = async (db: Client, sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
const SENHA_FALSA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const ENV = { CREDITOS_CATALOGO_ATIVO: "true", CREDITOS_COMPRA_ATIVA: "true", CREDITOS_CONVITES_CONSUMO_ATIVO: "true", KIDMAIS_DEPLOY_ENV: "staging" };

function emTx(c: Client) {
  return async <T>(w: (tx: DbExecutor) => Promise<T>): Promise<T> => {
    await c.query("BEGIN");
    try { const r = await w(c as unknown as DbExecutor); await c.query("COMMIT"); return r; }
    catch (e) { await c.query("ROLLBACK"); throw e; }
  };
}
const sessao = (u: string) => ({ usuario_id: u, autenticado_em: new Date().toISOString(), consultado_em: new Date().toISOString() }) as unknown as SessaoAdmin;

/** Asaas dublê (em memória): cobrança avulsa, consulta por id e por referência, estorno. Nenhuma rede. */
function asaasDuble() {
  const s = { cobrancas: new Map<string, CobrancaProvedor>(), posts: 0, modo: "normal" as "normal" | "timeout" | "recusa" | "duplicar", estornos: [] as { id: string; valor: number }[], leituras: 0 };
  const cliente = {
    async criarCobrancaAvulsa(i: { cliente: string; forma: string; valorCentavos: number; vencimento: string; referencia: string }) {
      s.posts += 1;
      if (s.modo === "recusa") throw new AsaasFalhou("criar cobrança avulsa", 400, "HTTP");
      const nova = (sufixo: string): CobrancaProvedor => ({ id: `pay_${s.posts}${sufixo}_${randomBytes(3).toString("hex")}`, status: "PENDING", dueDate: i.vencimento, paymentDate: null,
        invoiceUrl: `https://sandbox.asaas.com/i/fatura${s.posts}${sufixo}`, deleted: false, valorCentavos: i.valorCentavos, clienteId: i.cliente, billingType: i.forma, externalReference: i.referencia, assinaturaId: null });
      const c = nova("");
      s.cobrancas.set(c.id, c);
      if (s.modo === "duplicar") { const d = nova("d"); s.cobrancas.set(d.id, d); }
      if (s.modo === "timeout" || s.modo === "duplicar") throw new AsaasFalhou("criar cobrança avulsa", null, "TEMPO_ESGOTADO");
      return { ...c };
    },
    async obterCobranca(idc: string) { s.leituras += 1; const c = s.cobrancas.get(idc); return c ? { ...c } : null; },
    async listarCobrancasPorReferencia(ref: string) { s.leituras += 1; return [...s.cobrancas.values()].filter((c) => c.externalReference === ref).map((c) => ({ ...c })); },
    async estornarCobranca(idc: string, valor: number) { s.estornos.push({ id: idc, valor }); const c = s.cobrancas.get(idc)!; c.status = "REFUND_REQUESTED"; return { status: "REFUND_REQUESTED", estornos: [] }; },
    // Leitura de assinatura (o processarEvento exige o tipo; a avulsa nunca chega aqui).
    async obterAssinatura() { throw new Error("assinatura não deve ser lida para cobrança avulsa"); },
    async listarCobrancasDaAssinatura() { throw new Error("assinatura não deve ser lida para cobrança avulsa"); },
  };
  return { s, cliente, pagar: (pagamentoId: string, status = "RECEIVED", extra: Partial<CobrancaProvedor> = {}) => Object.assign(s.cobrancas.get(pagamentoId)!, { status, ...extra }) };
}

async function empresa(db: Client, nome: string) {
  const e = await id(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod(), nome]);
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
  return e;
}
async function gestao(db: Client, empresaId: string) {
  const u = await id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Créditos', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
    [`${cod()}@example.test`, SENHA_FALSA]);
  const m = await id(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [empresaId, u]);
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
  return u;
}
/** Assinatura paga ATIVA no Asaas (sintética), como o E2E da devolução. */
async function assinaturaPaga(db: Client, empresaId: string, cliente: string) {
  await db.query(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, documento_teste)
    VALUES ($1::uuid, 'TESTE', clock_timestamp() - interval '40 days', clock_timestamp() - interval '25 days', $2)`, [empresaId, `${randomBytes(6).toString("hex").toUpperCase()}01`]);
  await db.query(`UPDATE empresa_assinaturas SET situacao = 'ATIVA', ciclo = 'MENSAL', periodo_atual_fim = clock_timestamp() + interval '20 days', provedor = 'ASAAS',
    provedor_cliente_id = $2, provedor_assinatura_id = $3, provedor_situacao = 'ACTIVE' WHERE empresa_id = $1::uuid`, [empresaId, cliente, `sub_${randomBytes(4).toString("hex")}`]);
}
async function legado(db: Client, empresaId: string, limite: number, usado: number) {
  await db.query("INSERT INTO convite_carteiras (empresa_id, limite_mensal, ativo) VALUES ($1::uuid, $2, true)", [empresaId, limite]);
  if (usado) await db.query("INSERT INTO convite_consumos (empresa_id, mes, usado) VALUES ($1::uuid, date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date, $2)", [empresaId, usado]);
}

/** Contrato ASSINADO com versão vigente, a Festa e o convite (cópia do fixture de lib/convites/autorizacoes-088.postgres.test.ts). */
async function festa(db: Client, empresaId: string, criador: string) {
  const pacote = await id(db, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Festa CR', 1, true, true) RETURNING id`, [empresaId, cod().toUpperCase()]);
  const tabela = await id(db, `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela CR', '2026-01-01', false, $2::uuid) RETURNING id`, [cod(), empresaId]);
  const preco = await id(db, `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id`, [tabela, pacote]);
  const agenda = await id(db, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda CR', '10:00', '18:00', 9) RETURNING id`, [cod()]);
  const cliente = await id(db, `INSERT INTO clientes (nome_completo, empresa_id) VALUES ('Cliente CR', $1::uuid) RETURNING id`, [empresaId]);
  const fechamento = await id(db, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
      categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
    VALUES ('2099-09-01', '14:00', '18:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $6::uuid, 'AGUARDANDO_PAGAMENTO') RETURNING id`,
    [agenda, empresaId, pacote, tabela, preco, cliente]);
  const contrato = await id(db, `INSERT INTO contratos (fechamento_id, status, assinado_em) VALUES ($1::uuid, 'ASSINADO', now()) RETURNING id`, [fechamento]);
  const snapshot = { comercial: { valorFinalContrato: 100 }, evento: { data: "2099-09-01", convidados: 20, pacote: { codigo: "CR", nome: "Festa CR" } }, contratacao: { buffet: {}, adicionais: [] } };
  const hash = hashSnapshotContrato(snapshot);
  const pdf = Buffer.from(`%PDF-1.4\n% CR contrato ${randomUUID()}\n%%EOF\n`);
  const pdfHash = createHash("sha256").update(pdf).digest("hex");
  const versao = await id(db, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
     VALUES ($1::uuid, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP') RETURNING id`, [contrato, JSON.stringify(snapshot), hash, pdfHash]);
  const doc = await id(db, `INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf, gerado_por_usuario_id)
     VALUES ($1::uuid, 'CONTRATO', 1, $2, 'CONTRATO_CR', 1, $3, $4, $5, $6::uuid) RETURNING id`, [versao, hash, pdfHash, pdf.length, pdf, criador]);
  const comprovante = await id(db, `INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf)
     VALUES ($1::uuid, 'COMPROVANTE_ASSINATURA', 1, $2, 'COMPROVANTE_CR', 1, $3, $4, $5) RETURNING id`, [versao, hash, pdfHash, pdf.length, pdf]);
  await db.query(`INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id, documento_revisado_id, revisado_por_usuario_id, revisado_em)
     VALUES ($1::uuid, $2::uuid, 'INICIAL', 'CONCLUIDA', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $3::uuid, $3::uuid, $4::uuid, $3::uuid, now())`, [versao, contrato, criador, doc]);
  const validacao = await id(db, `INSERT INTO validacoes_identidade_cliente (cliente_id, canal, status, confirmado_em, token_prova_hash, prova_expira_em) VALUES ($1::uuid, 'EMAIL', 'CONFIRMADA', now(), $2, now() + interval '10 minutes') RETURNING id`, [cliente, randomBytes(32).toString("hex")]);
  await db.query(`INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, usuario_id, sessao_id, autenticacao_metodo, autenticado_em, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
     VALUES ($1::uuid, 'KIDMAIS', $2::uuid, $3::uuid, $4::uuid, 'SENHA', now(), $5::jsonb, $6, $7, 'SESSAO_REAUTENTICADA', 'INTERNAL', now(), $8::uuid, $9::uuid, $10::uuid)`,
    [versao, doc, criador, randomUUID(), JSON.stringify({ usuarioId: criador, papel: "REPRESENTANTE_AUTORIZADO", nome: "Usuário CR", cargo: null }), hash, pdfHash, randomUUID(), randomUUID(), comprovante]);
  await db.query(`INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, validacao_identidade_id, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
     VALUES ($1::uuid, 'CLIENTE', $2::uuid, $3::uuid, $4::jsonb, $5, $6, 'OTP', 'INTERNAL', now(), $7::uuid, $8::uuid, $9::uuid)`,
    [versao, doc, validacao, JSON.stringify({ schemaVersao: 1, clienteId: cliente, nome: "Cliente CR" }), hash, pdfHash, randomUUID(), randomUUID(), comprovante]);
  await db.query(`INSERT INTO contrato_fluxos (contrato_id, versao_vigente_id) VALUES ($1::uuid, $2::uuid)`, [contrato, versao]);
  // Ponteiro lógico da vigência (validação adiada do COMMIT): esta suíte confirma o fixture.
  await db.query('UPDATE contratos SET versao_atual = 1 WHERE id = $1::uuid', [contrato]);
  const f = await id(db, `INSERT INTO festas (contrato_id, versao_contratual_criacao_id, chave_criacao, payload_hash, criado_por) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid) RETURNING id`,
    [contrato, versao, randomUUID(), createHash("sha256").update("cr").digest("hex"), criador]);
  const token = randomBytes(32).toString("base64url");
  const rascunho = { tema: "celebrar", nome: "Alice", idade: "5 anos", data: "2099-09-01", horario: "14:00", local: "Salão", endereco: "Rua Sintética, 1", mensagem: "Venha!", arteId: null, confirmarPresenca: true };
  const convite = await id(db, `INSERT INTO convites (empresa_id, festa_id, cliente_id, estabelecimento_id, publico_token, rascunho, versao_contrato_id, limite_festa, limite_cliente, editor_hash, editor_expira_em)
    VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, $4, $5::jsonb, $6::uuid, 10, 10, $7, now() + interval '1 day') RETURNING id`,
  [empresaId, f, cliente, randomBytes(32).toString("base64url"), JSON.stringify(rascunho), versao, createHash("sha256").update(token).digest("hex")]);
  return { id: convite, empresa_id: empresaId, festa_id: f, cliente_id: cliente, token };
}

/** Espera até a conexão `pid` estar BLOQUEADA por `bloqueador` (pg_blocking_pids), sem sleep como prova. */
async function esperarBloqueio(obs: Client, pid: number, bloqueador: number) {
  for (let i = 0; i < 400; i++) {
    const r = (await obs.query<{ b: number[] }>("SELECT pg_blocking_pids($1::int) AS b", [pid])).rows[0];
    if (r.b.map(Number).includes(bloqueador)) return true;
    await new Promise((f) => setTimeout(f, 25));
  }
  return false;
}
const pidDe = async (c: Client) => Number((await c.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);

/** Fotografia de TODAS as linhas de créditos da empresa (comparação antes/depois do trabalho de outra empresa). */
async function fotografia(c: Client, empresaId: string) {
  const r: Record<string, unknown[]> = {};
  for (const t of ["ia_credito_carteiras", "ia_credito_lotes", "ia_credito_reservas", "ia_credito_reserva_lotes", "ia_credito_pedidos", "ia_credito_cobrancas",
    "ia_credito_devolucoes", "ia_credito_cortesias", "ia_credito_cortes", "ia_credito_notificacoes"])
    r[t] = (await c.query(`SELECT * FROM ${t} WHERE empresa_id = $1::uuid ORDER BY 1, 2`, [empresaId])).rows;
  r.lancamentos = (await c.query("SELECT * FROM ia_credito_lancamentos WHERE empresa_id = $1::uuid ORDER BY id", [empresaId])).rows;
  r.legado = (await c.query("SELECT * FROM convite_consumos WHERE empresa_id = $1::uuid ORDER BY mes", [empresaId])).rows;
  r.assinatura = (await c.query("SELECT situacao, periodo_atual_fim, provedor_situacao FROM empresa_assinaturas WHERE empresa_id = $1::uuid", [empresaId])).rows;
  return JSON.stringify(r);
}
async function recusa(c: Client, fn: () => Promise<unknown>, motivo: RegExp) {
  await c.query("SAVEPOINT recusa");
  await assert.rejects(fn(), motivo);
  await c.query("ROLLBACK TO SAVEPOINT recusa");
}

// Estado compartilhado entre os passos da suíte (um banco de trabalho restaurado do modelo 089 por execução).
const S = {} as { A: string; B: string; C: string; D: string; uA: string; uB: string; uC: string; uD: string; fotoB: string; pedidoC: string; protocoloC: string;
  conviteA: Awaited<ReturnType<typeof festa>>; conviteD: Awaited<ReturnType<typeof festa>> };

test("095 ausente: código novo tolera o schema antigo (instalado=false, compra 503, exportação com tabelas ausentes)", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    assert.equal(await creditosInstalados(c as unknown as DbExecutor), false);
    await c.query("BEGIN");
    const E = await empresa(c, "Sem 095"), u = await gestao(c, E);
    await assinaturaPaga(c, E, "cus_sem095");
    await c.query("COMMIT");
    const tenant = async <T>(_s: unknown, _e: unknown, w: (tx: DbExecutor, t: { empresaComprovada: string; papelAtual: string; membershipId: string; usuarioId: string }) => Promise<T>) =>
      emTx(c)((tx) => w(tx, { empresaComprovada: E, papelAtual: "REPRESENTANTE_AUTORIZADO", membershipId: "m", usuarioId: u }));
    const leitura = await consultarCreditos(sessao(u), null, { withTenantTransaction: tenant as DepsCreditos["withTenantTransaction"], env: ENV });
    assert.equal(leitura.instalado, false);
    assert.equal(leitura.convites.motor, "LEGADO");
    const duble = asaasDuble();
    await assert.rejects(criarPedido(sessao(u), null, { oferta: "CONVITES_10", forma: "PIX", chave: randomUUID(), confirmar: true, precoEsperadoCentavos: 5900, termosVersao: "creditos-ia-20261022.demo" },
      { withTenantTransaction: tenant as DepsCreditos["withTenantTransaction"], withTransaction: emTx(c), provedor: () => ({ cliente: duble.cliente, ambiente: "sandbox" }), consumirLimite: async () => true, env: ENV }),
    (e: { code?: string; httpStatus?: number }) => e.code === "COBRANCA_NAO_CONFIGURADA" && e.httpStatus === 503);
    assert.equal(duble.s.posts, 0, "sem a 095 nenhuma cobrança é criada");
    // Exportação: o pacote sai e registra as dez tabelas dos créditos como ausentes (migration não aplicada).
    const { gerarPacote } = await import("../exportacao/pacote.ts");
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const p = await gerarPacote(c as unknown as DbExecutor, E);
    await c.query("COMMIT");
    await p.limpar();
    assert.deepEqual(p.manifesto.entidadesAusentes.map((a) => a.tabela).sort(), ["ia_credito_carteiras", "ia_credito_cobrancas", "ia_credito_cortes", "ia_credito_cortesias",
      "ia_credito_devolucoes", "ia_credito_lancamentos", "ia_credito_lotes", "ia_credito_pedidos", "ia_credito_reserva_lotes", "ia_credito_reservas"]);
  } finally {
    await encerrarDescartavel(c);
  }
});

test("095: precheck, aplicação, postcheck, reaplicação recusada, rollback vazio e reaplicação", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    await c.query(PRE);
    await c.query(UP);
    await c.query(POST);
    await assert.rejects(c.query(UP), /095: precheck falhou/); await c.query("ROLLBACK").catch(() => {});
    await assert.rejects(c.query(PRE), /095 precheck: aplicação anterior ou parcial/);
    await c.query(DOWN);
    assert.equal(await creditosInstalados(c as unknown as DbExecutor), false);
    await c.query(PRE);
    await c.query(UP);
    await c.query(POST);
    assert.equal(await creditosInstalados(c as unknown as DbExecutor), true);
  } finally {
    await encerrarDescartavel(c);
  }
});

test("095: corte do legado, guardas do extrato, FKs compostas, lote imutável e sem saldo negativo", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const q = (s: string, v: unknown[] = []) => c.query(s, v);
  try {
    await q("BEGIN");
    S.A = await empresa(c, "Créditos A"); S.B = await empresa(c, "Créditos B"); S.C = await empresa(c, "Créditos C"); S.D = await empresa(c, "Créditos D (legado)");
    S.uA = await gestao(c, S.A); S.uB = await gestao(c, S.B); S.uC = await gestao(c, S.C); S.uD = await gestao(c, S.D);
    await assinaturaPaga(c, S.A, "cus_A"); await assinaturaPaga(c, S.B, "cus_B"); await assinaturaPaga(c, S.C, "cus_C"); await assinaturaPaga(c, S.D, "cus_D");
    await legado(c, S.A, 5, 2); await legado(c, S.B, 4, 0); await legado(c, S.C, 0, 0); await legado(c, S.D, 3, 1);
    await q("COMMIT");
    // O fixture de contrato (cópia da 088) não fecha as validações adiadas de assinatura/revisão do contrato no COMMIT:
    // só nesta transação de preparação, os gatilhos ficam desligados (banco descartável, superusuário sintético).
    await q("BEGIN");
    await q("SET LOCAL session_replication_role = replica");
    S.conviteA = await festa(c, S.A, S.uA);
    S.conviteD = await festa(c, S.D, S.uD);
    await q("COMMIT");
    const tx = c as unknown as DbExecutor;

    // Corte recusado com geração aberta (RESERVADA); depois de encerrada, o corte passa.
    const g = randomUUID();
    await q(`INSERT INTO convite_geracoes (id, convite_id, empresa_id, ator, payload_hash, modelo, etapas_registradas) VALUES ($1::uuid, $2::uuid, $3::uuid, 'CLIENTE:x', $4, 'm', true)`,
      [g, S.conviteA.id, S.A, "a".repeat(64)]);
    const sim = await emTx(c)((t2) => simularCorte(t2, S.A));
    assert.deepEqual({ elegivel: sim.elegivel, motivo: sim.motivo, limite: sim.limiteMensal, usado: sim.usado, legado: sim.quantidadeLegado }, { elegivel: false, motivo: "GERACOES_ABERTAS", limite: 5, usado: 2, legado: 3 });
    await assert.rejects(emTx(c)((t2) => aplicarCorte(t2, S.A, "TESTE-LOCAL 22/10")), /GERACOES_ABERTAS/);
    await q("UPDATE convite_geracoes SET estado = 'NAO_ENVIADA', falha_classe = 'PRE_ENVIO', falha_diagnostico = 'teste' WHERE id = $1::uuid", [g]);
    const corteA = await emTx(c)((t2) => aplicarCorte(t2, S.A, "TESTE-LOCAL 22/10"));
    assert.deepEqual({ repetido: corteA.repetido, q: corteA.quantidadeLegado }, { repetido: false, q: 3 });
    assert.equal((await emTx(c)((t2) => aplicarCorte(t2, S.A, "TESTE-LOCAL 22/10"))).repetido, true, "corte idempotente");
    for (const e of [S.B, S.C]) await emTx(c)((t2) => aplicarCorte(t2, e, "TESTE-LOCAL 22/10"));
    assert.equal((await lerCarteira(tx, S.A, "CONVITES"))!.saldo, 3);
    assert.equal((await lerCarteira(tx, S.B, "CONVITES"))!.saldo, 4);
    assert.equal((await lerCarteira(tx, S.C, "CONVITES"))!.saldo, 0);
    assert.equal(await lerCarteira(tx, S.D, "CONVITES"), null, "D continua no motor legado");
    assert.equal((await q("SELECT count(*)::int AS n FROM ia_credito_lotes WHERE empresa_id = $1::uuid", [S.C])).rows[0].n, 0, "limite 0: nenhum lote");

    await q("BEGIN");
    const loteA = (await q("SELECT id FROM ia_credito_lotes WHERE empresa_id = $1::uuid AND origem = 'LEGADO'", [S.A])).rows[0].id;
    const loteB = (await q("SELECT id FROM ia_credito_lotes WHERE empresa_id = $1::uuid AND origem = 'LEGADO'", [S.B])).rows[0].id;
    const x = (await q("SELECT id FROM ia_credito_lancamentos WHERE empresa_id = $1::uuid LIMIT 1", [S.A])).rows[0].id;
    await recusa(c, () => q("UPDATE ia_credito_lancamentos SET quantidade = 99 WHERE id = $1", [x]), /extrato é imutável/);
    await recusa(c, () => q("DELETE FROM ia_credito_lancamentos WHERE id = $1", [x]), /extrato é imutável/);
    await recusa(c, () => q("TRUNCATE ia_credito_lancamentos"), /não é truncada/);
    await recusa(c, () => q("DELETE FROM ia_credito_lotes WHERE id = $1::uuid", [loteA]), /não é apagado/);
    await recusa(c, () => q("UPDATE ia_credito_lotes SET quantidade = quantidade + 1, disponivel = disponivel + 1 WHERE id = $1::uuid", [loteA]), /imutáveis/);
    await recusa(c, () => q("UPDATE ia_credito_lotes SET vence_em = vence_em - interval '1 day' WHERE id = $1::uuid", [loteA]), /só pode ser prorrogado/);
    await q("UPDATE ia_credito_lotes SET vence_em = vence_em + interval '1 day' WHERE id = $1::uuid", [loteA]);
    await recusa(c, () => q("UPDATE ia_credito_carteiras SET saldo = -1 WHERE empresa_id = $1::uuid AND recurso = 'CONVITES'", [S.A]), /ia_credito_carteiras_valores_check/);
    await recusa(c, () => q("UPDATE ia_credito_carteiras SET reservado = saldo + 1 WHERE empresa_id = $1::uuid AND recurso = 'CONVITES'", [S.A]), /ia_credito_carteiras_valores_check/);
    // Lançamento de A apontando para lote de B: FK composta (lote, empresa, recurso) recusa.
    await recusa(c, () => q(`INSERT INTO ia_credito_lancamentos (empresa_id, recurso, lote_id, tipo, quantidade, delta_saldo, delta_reservado, delta_bloqueado, operacao, ator)
      VALUES ($1::uuid, 'CONVITES', $2::uuid, 'CREDITO', 1, 1, 0, 0, 'CREDITO:x', 'SISTEMA')`, [S.A, loteB]), /foreign key/);
    // Deltas incoerentes com o tipo: CHECK.
    await recusa(c, () => q(`INSERT INTO ia_credito_lancamentos (empresa_id, recurso, lote_id, tipo, quantidade, delta_saldo, delta_reservado, delta_bloqueado, operacao, ator)
      VALUES ($1::uuid, 'CONVITES', $2::uuid, 'CONSUMO', 1, 1, 0, 0, 'CONSUMO:x', 'SISTEMA')`, [S.A, loteA]), /ia_credito_lancamentos_deltas_check/);
    // Carteira CONVITES sem corte não nasce (um motor por empresa).
    await recusa(c, () => q("INSERT INTO ia_credito_carteiras (empresa_id, recurso) VALUES ($1::uuid, 'CONVITES')", [S.D]), /ia_credito_carteiras_corte_check/);
    // Reserva com lote de outra empresa: FK composta da alocação recusa.
    const r = (await q(`INSERT INTO ia_credito_reservas (empresa_id, recurso, operacao_id, quantidade) VALUES ($1::uuid, 'CONVITES', 'op-x', 1) RETURNING id`, [S.A])).rows[0].id;
    await recusa(c, () => q("INSERT INTO ia_credito_reserva_lotes (reserva_id, lote_id, empresa_id, ordem, quantidade) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 1)", [r, loteB, S.A]), /foreign key/);
    await q("ROLLBACK");
    // A carteira só muda pelo extrato: conferência independente sem divergência.
    for (const e of [S.A, S.B, S.C]) assert.deepEqual(await conferirCarteira(tx, e, "CONVITES"), []);
  } finally {
    await encerrarDescartavel(c);
  }
});

test("095: duas conexões reais disputam o último crédito (espera observada; a segunda vê saldo insuficiente)", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c1 = await conectarDescartavel();
  const c2 = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  try {
    // B fica com trabalho elegível (lote e reserva aberta) enquanto A disputa: fotografia de B antes/depois.
    await emTx(c1)((tx) => reservar(tx, { empresaId: S.B, recurso: "CONVITES", operacaoId: "b-aberta", quantidade: 1, ator: "EQUIPE" }));
    S.fotoB = await fotografia(c1, S.B);
    // A: 3 do lote LEGADO; reserva 2 deixa 1 disponível.
    await emTx(c1)((tx) => reservar(tx, { empresaId: S.A, recurso: "CONVITES", operacaoId: "a-1", quantidade: 2, ator: "EQUIPE" }));
    const p1 = await pidDe(c1), p2 = await pidDe(c2);
    await c1.query("BEGIN");
    await reservar(c1 as unknown as DbExecutor, { empresaId: S.A, recurso: "CONVITES", operacaoId: "a-ultimo-1", quantidade: 1, ator: "EQUIPE" });
    await c2.query("BEGIN");
    const segunda = reservar(c2 as unknown as DbExecutor, { empresaId: S.A, recurso: "CONVITES", operacaoId: "a-ultimo-2", quantidade: 1, ator: "CLIENTE" }).then(() => "RESERVOU", (e) => e);
    assert.equal(await esperarBloqueio(obs, p2, p1), true, "a segunda conexão espera a trava da carteira da primeira");
    await c1.query("COMMIT");
    const r2 = await segunda;
    assert.ok(r2 instanceof SaldoInsuficiente, `segunda reserva recusada por saldo (obtido: ${String(r2)})`);
    await c2.query("ROLLBACK");
    const w = (await lerCarteira(c1 as unknown as DbExecutor, S.A, "CONVITES"))!;
    assert.deepEqual([w.saldo, w.reservado, w.saldo - w.reservado - w.bloqueado], [3, 3, 0]);
    assert.deepEqual(await conferirCarteira(c1 as unknown as DbExecutor, S.A, "CONVITES"), []);
    // A mesma operação não reserva duas vezes (idempotência).
    const rep = await emTx(c1)((tx) => reservar(tx, { empresaId: S.A, recurso: "CONVITES", operacaoId: "a-ultimo-1", quantidade: 1, ator: "EQUIPE" }));
    assert.equal(rep.repetida, true);
    // Encerramentos: consome 1 de a-1 (libera 1), libera a-ultimo-1; repetir não muda nada.
    const e1 = await emTx(c1)((tx) => encerrarReserva(tx, { empresaId: S.A, recurso: "CONVITES", operacaoId: "a-1", quantidadeFinal: 1, ator: "SISTEMA" }));
    assert.deepEqual([e1.estado, e1.consumido, e1.liberado], ["CONSUMIDA", 1, 1]);
    assert.equal((await emTx(c1)((tx) => encerrarReserva(tx, { empresaId: S.A, recurso: "CONVITES", operacaoId: "a-1", quantidadeFinal: 0, ator: "SISTEMA" }))).repetido, true);
    await emTx(c1)((tx) => encerrarReserva(tx, { empresaId: S.A, recurso: "CONVITES", operacaoId: "a-ultimo-1", quantidadeFinal: 0, ator: "SISTEMA" }));
    const w2 = (await lerCarteira(c1 as unknown as DbExecutor, S.A, "CONVITES"))!;
    assert.deepEqual([w2.saldo, w2.reservado], [2, 0]);
    assert.deepEqual(await conferirCarteira(c1 as unknown as DbExecutor, S.A, "CONVITES"), []);
    assert.equal(await fotografia(c1, S.B), S.fotoB, "B intacta enquanto A disputava");
  } finally {
    await encerrarDescartavel(obs, false);
    await encerrarDescartavel(c2, false);
    await encerrarDescartavel(c1);
  }
});

test("095: compra avulsa com Asaas dublê — idempotência, recusa, incerto, duplicidade, divergência e crédito único", { timeout: 180_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const c2 = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  try {
    const tx = c as unknown as DbExecutor;
    const duble = asaasDuble();
    const assinaturaAntes = (await c.query("SELECT * FROM empresa_assinaturas WHERE empresa_id = $1::uuid", [S.C])).rows;
    const tenant = (empresaId: string, u: string, papel = "REPRESENTANTE_AUTORIZADO") => (async <T>(_s: unknown, _e: unknown, w: (t2: DbExecutor, t: object) => Promise<T>) =>
      emTx(c)((t2) => w(t2, { empresaComprovada: empresaId, papelAtual: papel, membershipId: "m", usuarioId: u }))) as unknown as DepsCreditos["withTenantTransaction"];
    const deps = (empresaId: string, u: string, papel?: string, env: Record<string, string> = ENV): DepsCreditos => ({ withTenantTransaction: tenant(empresaId, u, papel), withTransaction: emTx(c),
      provedor: () => ({ cliente: duble.cliente, ambiente: "sandbox" }), consumirLimite: async () => true, env });
    const corpo = (extra: Record<string, unknown> = {}) => ({ oferta: "CONVITES_10", forma: "PIX", chave: randomUUID(), confirmar: true, precoEsperadoCentavos: 5900, termosVersao: "creditos-ia-20261022.demo", ...extra });
    const ctx = { provedor: duble.cliente, ambiente: "sandbox" as const, conta: "padrao" };

    // Papel indevido, flags desligadas e preço adulterado: recusa antes de qualquer cobrança.
    await assert.rejects(criarPedido(sessao(S.uC), null, corpo(), deps(S.C, S.uC, "EQUIPE")), (e: { code?: string }) => e.code === "COBRANCA_SEM_PERMISSAO");
    await assert.rejects(criarPedido(sessao(S.uC), null, corpo(), deps(S.C, S.uC, undefined, { ...ENV, CREDITOS_COMPRA_ATIVA: "false" })), (e: { code?: string }) => e.code === "COBRANCA_NAO_CONFIGURADA");
    await assert.rejects(criarPedido(sessao(S.uC), null, corpo(), deps(S.C, S.uC, undefined, { ...ENV, KIDMAIS_DEPLOY_ENV: "production" })),
      (e: { code?: string; details?: { motivo?: string } }) => e.code === "COBRANCA_NAO_CONFIGURADA" && e.details?.motivo === "CATALOGO_NAO_APROVADO_PRODUCAO");
    await assert.rejects(criarPedido(sessao(S.uC), null, corpo({ precoEsperadoCentavos: 100 }), deps(S.C, S.uC)), (e: { code?: string }) => e.code === "OFERTA_ALTERADA");
    await assert.rejects(criarPedido(sessao(S.uC), null, corpo({ oferta: "WALLE_5000", precoEsperadoCentavos: 9900 }), deps(S.C, S.uC)), (e: { code?: string }) => e.code === "CONFLITO");
    await assert.rejects(criarPedido({ ...sessao(S.uC), autenticado_em: "2000-01-01T00:00:00.000Z" } as SessaoAdmin, null, corpo(), deps(S.C, S.uC)), (e: { code?: string }) => e.code === "REAUTENTICACAO");
    await assert.rejects(criarPedido(sessao(S.uD), null, corpo(), deps(S.D, S.uD)), /franquia mensal anterior/, "empresa sem corte não compra Convites");
    assert.equal(duble.s.posts, 0);

    // Pedido normal; mesma chave + mesmo conteúdo = mesmo pedido (sem 2º POST); mesma chave + outro conteúdo = conflito.
    const ch = randomUUID();
    const p1 = await criarPedido(sessao(S.uC), null, corpo({ chave: ch }), deps(S.C, S.uC));
    assert.equal(p1.estado, "AGUARDANDO_PAGAMENTO");
    assert.match(p1.urlPagamento ?? "", /^https:\/\/sandbox\.asaas\.com\//);
    const rep = await criarPedido(sessao(S.uC), null, corpo({ chave: ch }), deps(S.C, S.uC));
    assert.deepEqual([rep.protocolo, rep.repetido, duble.s.posts], [p1.protocolo, true, 1]);
    await assert.rejects(criarPedido(sessao(S.uC), null, corpo({ chave: ch, forma: "BOLETO" }), deps(S.C, S.uC)), (e: { code?: string }) => e.code === "CONFLITO");
    const pedido1 = (await c.query("SELECT id, estado FROM ia_credito_pedidos WHERE protocolo = $1", [p1.protocolo])).rows[0];
    S.pedidoC = pedido1.id; S.protocoloC = p1.protocolo;
    const pay1 = (await c.query("SELECT pagamento_id FROM ia_credito_cobrancas WHERE pedido_id = $1::uuid AND canonica", [pedido1.id])).rows[0].pagamento_id;

    // Criar a cobrança não credita; AUTHORIZED também não; valor divergente → revisão (sem crédito).
    assert.equal((await emTx(c)((t2) => processarPedido(t2, pedido1.id, ctx))).resultado, "AGUARDANDO");
    duble.pagar(pay1, "AUTHORIZED");
    assert.equal((await emTx(c)((t2) => processarPedido(t2, pedido1.id, ctx))).resultado, "AGUARDANDO");
    duble.pagar(pay1, "CONFIRMED", { valorCentavos: 5800 });
    assert.deepEqual(await emTx(c)((t2) => processarPedido(t2, pedido1.id, ctx)), { resultado: "REVISAO", motivo: "VALOR_DIVERGENTE" });
    assert.equal((await lerCarteira(tx, S.C, "CONVITES"))!.saldo, 0);
    duble.pagar(pay1, "CONFIRMED", { valorCentavos: 5900 });

    // Webhook duplicado processado por DUAS conexões ao mesmo tempo: a segunda espera a trava do pedido e não credita de novo.
    const ref = referenciaExterna("sandbox", pedido1.id);
    const ev = async (n: string) => (await emTx(c)((t2) => registrarEvento(t2, { eventoId: `evt_${n}_${randomBytes(3).toString("hex")}`, tipo: "PAYMENT_CONFIRMED", criadoNoProvedor: null,
      assinaturaId: null, cobrancaId: pay1, checkoutId: null, referenciaExterna: ref }))).id;
    const ev1 = await ev("1"), ev2 = await ev("2");
    const depsEvento = { provedor: duble.cliente, creditos: { ambiente: "sandbox" as const, conta: "padrao" } };
    const pA = await pidDe(c), pB = await pidDe(c2);
    await c.query("BEGIN");
    const r1 = await processarEvento(c as unknown as DbExecutor, ev1, depsEvento as never);
    await c2.query("BEGIN");
    const r2p = processarEvento(c2 as unknown as DbExecutor, ev2, depsEvento as never);
    assert.equal(await esperarBloqueio(obs, pB, pA), true, "segunda instância espera a trava do pedido");
    await c.query("COMMIT");
    const r2 = await r2p;
    await c2.query("COMMIT");
    assert.deepEqual([r1.situacao, r2.situacao], ["PROCESSADO", "PROCESSADO"]);
    const lotes = (await c.query("SELECT quantidade, origem FROM ia_credito_lotes WHERE pedido_id = $1::uuid", [pedido1.id])).rows;
    assert.deepEqual(lotes, [{ quantidade: "10", origem: "COMPRA" }], "um único lote COMPRA");
    assert.equal((await c.query("SELECT estado FROM ia_credito_pedidos WHERE id = $1::uuid", [pedido1.id])).rows[0].estado, "CREDITADO");
    // RECEIVED depois de CONFIRMED não credita de novo; avulsa nunca mexe na assinatura.
    duble.pagar(pay1, "RECEIVED");
    assert.equal((await emTx(c)((t2) => processarPedido(t2, pedido1.id, ctx))).resultado, "JA_CONCLUIDO");
    assert.equal((await lerCarteira(tx, S.C, "CONVITES"))!.saldo, 10);
    assert.deepEqual((await c.query("SELECT * FROM empresa_assinaturas WHERE empresa_id = $1::uuid", [S.C])).rows, assinaturaAntes, "assinatura intacta");
    assert.equal((await c.query("SELECT count(*)::int AS n FROM ia_credito_notificacoes WHERE empresa_id = $1::uuid AND tipo = 'PAGAMENTO_CONFIRMADO'", [S.C])).rows[0].n, 1);

    // 4xx definitivo: FALHOU_CRIACAO, nada criado. Timeout: incerto, 0 POST repetido, recuperação pela referência.
    duble.s.modo = "recusa";
    const p2 = await criarPedido(sessao(S.uC), null, corpo({ forma: "CARTAO" }), deps(S.C, S.uC));
    assert.equal(p2.estado, "FALHOU_CRIACAO");
    duble.s.modo = "timeout";
    const postsAntes = duble.s.posts;
    const p3 = await criarPedido(sessao(S.uC), null, corpo({ forma: "BOLETO" }), deps(S.C, S.uC));
    assert.equal(p3.estado, "CRIACAO_INCERTA");
    const pedido3 = (await c.query("SELECT id FROM ia_credito_pedidos WHERE protocolo = $1", [p3.protocolo])).rows[0].id;
    duble.s.modo = "normal";
    assert.equal((await emTx(c)((t2) => processarPedido(t2, pedido3, ctx))).resultado, "AGUARDANDO", "recuperada pela referência (vincula e lê)");
    assert.equal(duble.s.posts, postsAntes + 1, "nenhum POST repetido");
    assert.equal((await c.query("SELECT estado FROM ia_credito_pedidos WHERE id = $1::uuid", [pedido3])).rows[0].estado, "AGUARDANDO_PAGAMENTO");
    // Duplicidade no provedor (timeout com duas cobranças pela mesma referência): revisão, nenhum crédito.
    duble.s.modo = "duplicar";
    const p4 = await criarPedido(sessao(S.uC), null, corpo(), deps(S.C, S.uC));
    duble.s.modo = "normal";
    const pedido4 = (await c.query("SELECT id FROM ia_credito_pedidos WHERE protocolo = $1", [p4.protocolo])).rows[0].id;
    assert.deepEqual(await emTx(c)((t2) => processarPedido(t2, pedido4, ctx)), { resultado: "REVISAO", motivo: "COBRANCA_DUPLICADA" });
    assert.equal((await c.query("SELECT count(*)::int AS n FROM ia_credito_cobrancas WHERE pedido_id = $1::uuid AND NOT canonica", [pedido4])).rows[0].n, 2);
    // Limite de pendentes (3 por empresa): com p3 e mais dois aguardando, o próximo é recusado.
    await criarPedido(sessao(S.uC), null, corpo(), deps(S.C, S.uC));
    await criarPedido(sessao(S.uC), null, corpo({ forma: "CARTAO" }), deps(S.C, S.uC));
    await assert.rejects(criarPedido(sessao(S.uC), null, corpo(), deps(S.C, S.uC)), (e: { code?: string }) => e.code === "LIMITE_TENTATIVAS");
    // Reconciliação revisita os abertos; Gestão lê pedidos, extrato e catálogo de demonstração; Equipe só o saldo.
    assert.ok((await emTx(c)((t2) => pedidosParaReconciliar(t2))).includes(pedido3));
    const leitura = await consultarCreditos(sessao(S.uC), null, { withTenantTransaction: tenant(S.C, S.uC), env: ENV });
    assert.equal(leitura.convites.motor, "CREDITOS");
    assert.ok("pedidos" in leitura && leitura.pedidos!.some((p) => p.protocolo === p1.protocolo && p.estado === "CREDITADO"));
    assert.equal(leitura.catalogo?.proposta, true);
    const equipe = await consultarCreditos(sessao(S.uC), null, { withTenantTransaction: tenant(S.C, S.uC, "EQUIPE"), env: ENV });
    assert.equal("pedidos" in equipe, false, "Equipe não vê pedidos nem faturamento");
    assert.deepEqual(await conferirCarteira(tx, S.C, "CONVITES"), []);
    assert.equal(await fotografia(c, S.B), S.fotoB, "B intacta");
  } finally {
    await encerrarDescartavel(obs, false);
    await encerrarDescartavel(c2, false);
    await encerrarDescartavel(c);
  }
});

test("095: devolução × consumo concorrentes, garantia integral com uso, proporcional e estorno automático só com flag", { timeout: 180_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c1 = await conectarDescartavel();
  const c2 = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  try {
    const tx = c1 as unknown as DbExecutor;
    // C usa 2 (consumidas) e deixa 1 reservada em andamento; o resto (7) disponível.
    await emTx(c1)((t2) => reservar(t2, { empresaId: S.C, recurso: "CONVITES", operacaoId: "c-uso", quantidade: 2, ator: "EQUIPE" }));
    await emTx(c1)((t2) => encerrarReserva(t2, { empresaId: S.C, recurso: "CONVITES", operacaoId: "c-uso", ator: "SISTEMA" }));
    // Concorrência: c1 reserva (trava a carteira) e c2 registra a devolução (trava o pedido e espera a carteira).
    const p1 = await pidDe(c1), p2 = await pidDe(c2);
    await c1.query("BEGIN");
    await reservar(tx, { empresaId: S.C, recurso: "CONVITES", operacaoId: "c-andamento", quantidade: 1, ator: "CLIENTE" });
    await c2.query("BEGIN");
    const dev = registrarDevolucao(c2 as unknown as DbExecutor, { empresaId: S.C, protocoloPedido: S.protocoloC, tipo: "ARREPENDIMENTO_7_DIAS", valorEsperado: 5900, chave: randomUUID(),
      solicitadoPor: S.uC, origem: "GESTAO" });
    assert.equal(await esperarBloqueio(obs, p2, p1), true, "devolução espera a trava da carteira");
    await c1.query("COMMIT");
    const r = await dev;
    await c2.query("COMMIT");
    // Garantia de 7 dias: integral (5900) mesmo com 2 usadas; cancela o disponível (7) e mantém a reserva em andamento.
    assert.deepEqual([r.tipo, r.valorCentavos, r.quantidadeCancelada, r.estado], ["ARREPENDIMENTO_7_DIAS", 5900, 7, "AGUARDANDO_MANUAL"]);
    const lote = (await c1.query("SELECT disponivel, reservado, consumido, cancelado FROM ia_credito_lotes WHERE pedido_id = $1::uuid", [S.pedidoC])).rows[0];
    assert.deepEqual(lote, { disponivel: "0", reservado: "1", consumido: "2", cancelado: "7" });
    // A geração em andamento falha antes do envio: liberar NÃO devolve ao disponível (lote devolvido) → cancelado.
    await emTx(c1)((t2) => encerrarReserva(t2, { empresaId: S.C, recurso: "CONVITES", operacaoId: "c-andamento", quantidadeFinal: 0, ator: "SISTEMA" }));
    const lote2 = (await c1.query("SELECT disponivel, reservado, consumido, cancelado FROM ia_credito_lotes WHERE pedido_id = $1::uuid", [S.pedidoC])).rows[0];
    assert.deepEqual(lote2, { disponivel: "0", reservado: "0", consumido: "2", cancelado: "8" });
    assert.deepEqual(await conferirCarteira(tx, S.C, "CONVITES"), []);
    // Segunda devolução do mesmo pedido: recusada (soma nunca passa do pago); repetição da mesma chave = mesmo protocolo.
    await assert.rejects(emTx(c1)((t2) => registrarDevolucao(t2, { empresaId: S.C, protocoloPedido: S.protocoloC, tipo: "SALDO_NAO_UTILIZADO", valorEsperado: 1, chave: randomUUID(),
      solicitadoPor: S.uC, origem: "GESTAO" })), /não está disponível/);
    await c1.query("BEGIN");
    await assert.rejects(c1.query(`INSERT INTO ia_credito_devolucoes (empresa_id, pedido_id, cobranca_id, lote_id, protocolo, tipo, origem, chave_idempotencia, solicitado_por, regra,
        quantidade_comprada, quantidade_consumida, quantidade_cancelada, valor_pago_centavos, valor_centavos, forma, prazo, estado)
      SELECT d.empresa_id, d.pedido_id, d.cobranca_id, d.lote_id, 'KM-20261022-ZZZZZZZZ', 'SALDO_NAO_UTILIZADO', 'GESTAO', gen_random_uuid(), d.solicitado_por, 'X', 10, 0, 0, 5900, 1, 'PIX', current_date, 'AGUARDANDO_MANUAL'
      FROM ia_credito_devolucoes d WHERE d.protocolo = $1`, [r.protocolo]), /ia_credito_devolucoes_pedido_uk|acima do valor pago/);
    await c1.query("ROLLBACK");
    assert.equal(await fotografia(c1, S.B), S.fotoB, "B intacta");

    // Proporcional fora da garantia + estorno automático com CREDITOS_ESTORNO_ATIVO (Pix): registro prévio e uma chamada.
    const duble = asaasDuble();
    const tenant = (async <T>(_s: unknown, _e: unknown, w: (t2: DbExecutor, t: object) => Promise<T>) =>
      emTx(c1)((t2) => w(t2, { empresaComprovada: S.B, papelAtual: "REPRESENTANTE_AUTORIZADO", membershipId: "m", usuarioId: S.uB }))) as unknown as DepsCreditos["withTenantTransaction"];
    const deps: DepsCreditos = { withTenantTransaction: tenant, withTransaction: emTx(c1), provedor: () => ({ cliente: duble.cliente, ambiente: "sandbox" }), consumirLimite: async () => true,
      env: { ...ENV, CREDITOS_ESTORNO_ATIVO: "true" } };
    const pB = await criarPedido(sessao(S.uB), null, { oferta: "CONVITES_30", forma: "PIX", chave: randomUUID(), confirmar: true, precoEsperadoCentavos: 15900, termosVersao: "creditos-ia-20261022.demo" }, deps);
    const pedidoB = (await c1.query("SELECT id FROM ia_credito_pedidos WHERE protocolo = $1", [pB.protocolo])).rows[0].id;
    duble.pagar((await c1.query("SELECT pagamento_id FROM ia_credito_cobrancas WHERE pedido_id = $1::uuid", [pedidoB])).rows[0].pagamento_id, "RECEIVED");
    await emTx(c1)((t2) => processarPedido(t2, pedidoB, { provedor: duble.cliente, ambiente: "sandbox", conta: "padrao" }));
    // Simula 10 dias depois: a liberação do lote recua (só no banco descartável, com gatilho desligado nesta sessão).
    await c1.query("BEGIN");
    await c1.query("SET LOCAL session_replication_role = replica");
    await c1.query("UPDATE ia_credito_lotes SET liberado_em = liberado_em - interval '10 days' WHERE pedido_id = $1::uuid", [pedidoB]);
    await c1.query("COMMIT");
    await emTx(c1)((t2) => reservar(t2, { empresaId: S.B, recurso: "CONVITES", operacaoId: "b-uso", quantidade: 6, ator: "EQUIPE" }));
    const fotoAntes = await fotografia(c1, S.A);
    await emTx(c1)((t2) => encerrarReserva(t2, { empresaId: S.B, recurso: "CONVITES", operacaoId: "b-uso", ator: "SISTEMA" }));
    const loteB = (await c1.query("SELECT quantidade, disponivel, consumido FROM ia_credito_lotes WHERE pedido_id = $1::uuid", [pedidoB])).rows[0];
    const disponivelB = Number(loteB.disponivel);
    const esperado = Math.floor((15900 * disponivelB * 2 + 30) / 60);
    const sd = await solicitarDevolucao(sessao(S.uB), null, { pedido: pB.protocolo, tipo: "SALDO_NAO_UTILIZADO", valorEsperadoCentavos: esperado, chave: randomUUID(), confirmar: true }, deps);
    assert.deepEqual([sd.tipo, sd.valorCentavos, sd.estado], ["SALDO_NAO_UTILIZADO", esperado, "SOLICITADO"]);
    assert.deepEqual(duble.s.estornos.map((e) => e.valor), [esperado], "uma chamada de estorno");
    assert.equal(await fotografia(c1, S.A), fotoAntes, "A intacta enquanto B devolvia");
    // Webhook de estorno concluído (REFUNDED) fecha a devolução; sem reabrir crédito.
    const payB = (await c1.query("SELECT pagamento_id FROM ia_credito_cobrancas WHERE pedido_id = $1::uuid", [pedidoB])).rows[0].pagamento_id;
    duble.pagar(payB, "REFUNDED");
    await emTx(c1)((t2) => processarPedido(t2, pedidoB, { provedor: duble.cliente, ambiente: "sandbox", conta: "padrao" }));
    assert.equal((await c1.query("SELECT estado FROM ia_credito_devolucoes WHERE protocolo = $1", [sd.protocolo])).rows[0].estado, "CONCLUIDO");
    assert.deepEqual(await conferirCarteira(tx, S.B, "CONVITES"), []);
    S.fotoB = await fotografia(c1, S.B);
  } finally {
    await encerrarDescartavel(obs, false);
    await encerrarDescartavel(c2, false);
    await encerrarDescartavel(c1);
  }
});

test("095: expiração, manutenção (franquia só para cortadas), cortesia com teto e Wall-e em µUS$",{ timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const tx = c as unknown as DbExecutor;
    // Lote que vence em 1 h (o primeiro na ordem de consumo de A); depois da reserva, a preparação o faz vencer no banco
    // descartável (gatilhos desligados só nessa transação). Sem depender de tempo: a prova é o estado.
    await emTx(c)(async (t2) => { await lerCarteira(t2, S.A, "CONVITES", true); await creditarLote(t2, { empresaId: S.A, recurso: "CONVITES", origem: "CORTESIA", chaveOrigem: "CORTESIA:expira-teste",
      quantidade: 4, venceEm: Date.now() + 3_600_000, ator: "PLATAFORMA" }); });
    await emTx(c)((t2) => reservar(t2, { empresaId: S.A, recurso: "CONVITES", operacaoId: "a-expira", quantidade: 1, ator: "EQUIPE" }));
    assert.equal((await c.query("SELECT reservado FROM ia_credito_lotes WHERE empresa_id = $1::uuid AND chave_origem = 'CORTESIA:expira-teste'", [S.A])).rows[0].reservado, "1",
      "a reserva saiu do lote que vai vencer");
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(`UPDATE ia_credito_lotes SET liberado_em = clock_timestamp() - interval '1 day', vence_em = clock_timestamp() - interval '1 second'
      WHERE empresa_id = $1::uuid AND chave_origem = 'CORTESIA:expira-teste'`, [S.A]);
    await c.query("COMMIT");
    const exp = await emTx(c)((t2) => expirarVencidos(t2, S.A, "CONVITES"));
    assert.equal(exp, 3, "o disponível do lote vencido expira (a parte reservada fica)");
    assert.equal(await emTx(c)((t2) => expirarVencidos(t2, S.A, "CONVITES")), 0, "expiração idempotente");
    // A reserva sobre o lote vencido termina sem consumo: a parte liberada também EXPIRA (não volta ao disponível).
    await emTx(c)((t2) => encerrarReserva(t2, { empresaId: S.A, recurso: "CONVITES", operacaoId: "a-expira", quantidadeFinal: 0, ator: "SISTEMA" }));
    assert.equal((await c.query("SELECT expirado FROM ia_credito_lotes WHERE empresa_id = $1::uuid AND chave_origem = 'CORTESIA:expira-teste'", [S.A])).rows[0].expirado, "4");
    assert.deepEqual(await conferirCarteira(tx, S.A, "CONVITES"), []);
    // Manutenção: A está no mês do corte (lote LEGADO cobre o mês) → nenhuma franquia; D (legado) não é tocada.
    const m = await emTx(c)((t2) => manutencaoEmpresa(t2, S.A));
    assert.equal(m.franquia.motivo, "MES_DO_CORTE");
    // Cortesia: só pela plataforma, dentro do teto; idempotente; teto da empresa recusa o excedente.
    const chave = randomUUID();
    const cort = await emTx(c)((t2) => concederCortesia(t2, S.uA, { empresaId: S.A, campanha: "PILOTO-CONVITES-20261022", quantidade: 6, motivo: "Piloto sintético", chave }));
    assert.equal((await emTx(c)((t2) => concederCortesia(t2, S.uA, { empresaId: S.A, campanha: "PILOTO-CONVITES-20261022", quantidade: 6, motivo: "Piloto sintético", chave }))).protocolo, cort.protocolo);
    await assert.rejects(emTx(c)((t2) => concederCortesia(t2, S.uA, { empresaId: S.A, campanha: "PILOTO-CONVITES-20261022", quantidade: 5, motivo: "Excedente", chave: randomUUID() })), /TETO_DA_EMPRESA/);
    await assert.rejects(emTx(c)((t2) => concederCortesia(t2, S.uA, { empresaId: S.D, campanha: "PILOTO-CONVITES-20261022", quantidade: 1, motivo: "Sem corte", chave: randomUUID() })), /CARTEIRA_SEM_CORTE/);
    // Wall-e: indisponível (gates do atendimento) não reserva; com a carteira e o gate, debita o custo apurado e libera o excesso.
    assert.deepEqual(await emTx(c)((t2) => reservarChamada(t2, { empresaId: S.A, operacaoId: "w-1", maximoMicrousd: 5000, versaoPrecos: "v1" }, {})), { ok: false, motivo: "WALLE_INDISPONIVEL" });
    const envWalle = { CREDITOS_WALLE_CONSUMO_ATIVO: "true", WHATSAPP_ATENDIMENTO_ENABLED: "true", WHATSAPP_ATENDIMENTO_RECEPTOR: "staging", KIDMAIS_DEPLOY_ENV: "staging",
      WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO: "modelo", WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO: "R6-teste-local", WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS: "5511900000000" };
    await emTx(c)(async (t2) => { await abrirCarteira(t2, S.A, "WALLE"); await creditarLote(t2, { empresaId: S.A, recurso: "WALLE", origem: "CORTESIA", chaveOrigem: "CORTESIA:walle-teste",
      quantidade: 10_000, venceEm: Date.now() + 86_400_000, ator: "PLATAFORMA" }); });
    assert.deepEqual(await emTx(c)((t2) => reservarChamada(t2, { empresaId: S.A, operacaoId: "w-1", maximoMicrousd: 6000, versaoPrecos: "v1" }, envWalle)), { ok: true, reservaRepetida: false });
    assert.deepEqual(await emTx(c)((t2) => reservarChamada(t2, { empresaId: S.A, operacaoId: "w-2", maximoMicrousd: 6000, versaoPrecos: "v1" }, envWalle)), { ok: false, motivo: "SALDO_INSUFICIENTE" });
    assert.equal((await emTx(c)((t2) => liquidarChamada(t2, { empresaId: S.A, operacaoId: "w-1", custoRealMicrousd: null }))).estado, "CUSTO_DESCONHECIDO", "custo desconhecido nunca vira zero");
    assert.equal((await lerCarteira(tx, S.A, "WALLE"))!.reservado, 6000, "reserva mantida");
    const liq = await emTx(c)((t2) => liquidarChamada(t2, { empresaId: S.A, operacaoId: "w-1", custoRealMicrousd: 7200 }));
    assert.deepEqual([liq.estado, liq.debitado, liq.excedenteMicrousd, liq.suspender], ["CONSUMIDA", 6000, 1200, true], "excedente absorvido, nunca negativo");
    assert.deepEqual(await conferirCarteira(tx, S.A, "WALLE"), []);
    assert.equal(await fotografia(c, S.B), S.fotoB, "B intacta");
  } finally {
    await encerrarDescartavel(c);
  }
});

test("095: disputa (chargeback) bloqueia só o remanescente com exposição; favorável desbloqueia; perdida/estorno externo cancela", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const tx = c as unknown as DbExecutor;
    // Dublê novo com as cobranças pendentes de C (mesmos ids gravados no banco).
    const duble = asaasDuble();
    const abertos = (await c.query(`SELECT p.id, p.ambiente, p.forma, p.preco_centavos, c.pagamento_id FROM ia_credito_pedidos p JOIN ia_credito_cobrancas c ON c.pedido_id = p.id AND c.canonica
      WHERE p.empresa_id = $1::uuid AND p.estado = 'AGUARDANDO_PAGAMENTO' ORDER BY p.criado_em LIMIT 2`, [S.C])).rows;
    assert.equal(abertos.length, 2);
    const tipo: Record<string, string> = { PIX: "PIX", CARTAO: "CREDIT_CARD", BOLETO: "BOLETO" };
    for (const a of abertos) duble.s.cobrancas.set(a.pagamento_id, { id: a.pagamento_id, status: "RECEIVED", dueDate: "2026-10-25", paymentDate: "2026-10-22", invoiceUrl: null, deleted: false,
      valorCentavos: Number(a.preco_centavos), clienteId: "cus_C", billingType: tipo[a.forma], externalReference: referenciaExterna(a.ambiente, a.id), assinaturaId: null });
    const ctx = { provedor: duble.cliente, ambiente: "sandbox" as const, conta: "padrao" };
    const [p1, p2] = abertos;
    for (const p of [p1, p2]) assert.equal((await emTx(c)((t2) => processarPedido(t2, p.id, ctx))).resultado, "CREDITADO");
    const lote = async (pedidoId: string) => (await c.query("SELECT disponivel, bloqueado, consumido, cancelado FROM ia_credito_lotes WHERE pedido_id = $1::uuid", [pedidoId])).rows[0];
    const cob = async (pagamentoId: string) => (await c.query("SELECT disputa, exposicao_centavos, revisao_motivo FROM ia_credito_cobrancas WHERE pagamento_id = $1", [pagamentoId])).rows[0];
    // Usa 4 de p1 (lotes de C: só os de compra têm saldo; ordem por vencimento — reserva direta no lote de p1 pelo serviço).
    await emTx(c)((t2) => reservar(t2, { empresaId: S.C, recurso: "CONVITES", operacaoId: "c-disputa-uso", quantidade: 4, ator: "EQUIPE" }));
    await emTx(c)((t2) => encerrarReserva(t2, { empresaId: S.C, recurso: "CONVITES", operacaoId: "c-disputa-uso", ator: "SISTEMA" }));
    const l1 = await lote(p1.id), l2 = await lote(p2.id);
    const usados1 = Number(l1.consumido), usados2 = Number(l2.consumido);
    assert.equal(usados1 + usados2, 4);
    // Disputa aberta em p1: bloqueia só o remanescente; exposição = parte usada pelo preço original.
    duble.pagar(p1.pagamento_id, "CHARGEBACK_REQUESTED");
    assert.equal((await emTx(c)((t2) => processarPedido(t2, p1.id, ctx))).resultado, "DISPUTA");
    assert.deepEqual(await lote(p1.id), { disponivel: "0", bloqueado: String(10 - usados1), consumido: String(usados1), cancelado: "0" });
    assert.deepEqual(await cob(p1.pagamento_id), { disputa: "ABERTA", exposicao_centavos: String(proporcional(5900, usados1, 10)), revisao_motivo: null });
    assert.ok((await lerCarteira(tx, S.C, "CONVITES"))!.bloqueado >= 10 - usados1);
    // Repetir o mesmo estado não bloqueia de novo.
    assert.equal((await emTx(c)((t2) => processarPedido(t2, p1.id, ctx))).resultado, "DISPUTA");
    // Resolvida a favor (volta a RECEIVED): o remanescente volta ao disponível, uma vez; nunca recredita o pedido inteiro.
    duble.pagar(p1.pagamento_id, "RECEIVED");
    assert.deepEqual(await emTx(c)((t2) => processarPedido(t2, p1.id, ctx)), { resultado: "SEM_MUDANCA", motivo: "DISPUTA_FAVORAVEL" });
    assert.deepEqual(await lote(p1.id), { disponivel: String(10 - usados1), bloqueado: "0", consumido: String(usados1), cancelado: "0" });
    assert.equal((await cob(p1.pagamento_id)).disputa, "FAVORAVEL");
    // p2: disputa e depois estorno (perdida): o remanescente é cancelado; o usado vira exposição; carteira nunca negativa.
    duble.pagar(p2.pagamento_id, "CHARGEBACK_DISPUTE");
    await emTx(c)((t2) => processarPedido(t2, p2.id, ctx));
    duble.pagar(p2.pagamento_id, "REFUNDED");
    assert.equal((await emTx(c)((t2) => processarPedido(t2, p2.id, ctx))).resultado, "ESTORNO");
    assert.deepEqual(await lote(p2.id), { disponivel: "0", bloqueado: "0", consumido: String(usados2), cancelado: String(10 - usados2) });
    assert.equal((await cob(p2.pagamento_id)).disputa, "PERDIDA");
    const w = (await lerCarteira(tx, S.C, "CONVITES"))!;
    assert.ok(w.saldo >= 0 && w.reservado >= 0 && w.bloqueado >= 0 && w.reservado + w.bloqueado <= w.saldo);
    assert.deepEqual(await conferirCarteira(tx, S.C, "CONVITES"), []);
    assert.equal(await fotografia(c, S.B), S.fotoB, "B intacta");
  } finally {
    await encerrarDescartavel(c);
  }
});

test("095: Convites pelo serviço real com IA dublê — legado intacto, motor novo, 088 antes da reserva, flag off e verificação", { timeout: 240_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const salvo = { ...process.env };
  const fetchOriginal = globalThis.fetch;
  const chamadas: string[] = [];
  let modoIA: "ok" | "falha_rede" = "ok";
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  try {
    // IA dublê: só api.openai.com é atendida, em memória; qualquer outra rede falha (nada sai da máquina).
    globalThis.fetch = (async (u: string | URL | Request) => {
      const url = typeof u === "string" ? u : u instanceof URL ? u.href : u.url;
      if (!url.startsWith("https://api.openai.com/")) throw new Error(`rede bloqueada no teste: ${url}`);
      chamadas.push(url);
      if (modoIA === "falha_rede") throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }], usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    Object.assign(process.env, { CONVITES_ENABLED: "true", CONVITES_IA_ENABLED: "true", CONVITES_IA_PROVIDER: "openai", OPENAI_API_KEY: "sk-sintetica-de-teste", CONVITES_IA_TETO_DIARIO_MICROUSD: "10000000",
      CREDITOS_CONVITES_CONSUMO_ATIVO: "true" });
    const comTx = emTx(c);
    const svc = carregarModulo("lib/convites/service.ts", { "db/postgres": { db: () => c, withTransaction: comTx } }, new Map()) as {
      comandar: (a: unknown, raw: unknown) => Promise<Record<string, unknown>>; consultar: (a: unknown) => Promise<Record<string, unknown>> };
    const autorizar = async (cv: Awaited<ReturnType<typeof festa>>) => svc.comandar({ tipo: "cliente", token: cv.token }, { acao: "autorizar_ia", versao: VERSAO_TEXTOS_IA, provedor: "openai",
      textoHash: hashTextoIA("openai", "CLIENTE"), responsavelNome: "Responsável Sintético", vinculo: "MAE", declaracao: true });
    const gerar = (cv: Awaited<ReturnType<typeof festa>>) => svc.comandar({ tipo: "cliente", token: cv.token }, { acao: "gerar", chave: randomUUID(), prompt: "Tema jardim com borboletas", referencias: [] });

    // 088 continua obrigatória: sem autorização, recusa ANTES de reservar (nenhuma reserva nem chamada).
    await assert.rejects(gerar(S.conviteA), /autorização específica do responsável/);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM ia_credito_reservas WHERE empresa_id = $1::uuid AND recurso = 'CONVITES' AND operacao_id ~ '^[0-9a-f-]{36}$'", [S.A])).rows[0].n, 0);
    assert.equal(chamadas.length, 0);
    await autorizar(S.conviteA); await autorizar(S.conviteD);

    // Motor legado (D, sem corte): consome convite_consumos como antes; nada no extrato.
    const consumoD = Number((await c.query("SELECT usado FROM convite_consumos WHERE empresa_id = $1::uuid", [S.conviteD.empresa_id])).rows[0].usado);
    const gd = await gerar(S.conviteD);
    assert.equal(gd.estado, "CONCLUIDA");
    assert.equal(Number((await c.query("SELECT usado FROM convite_consumos WHERE empresa_id = $1::uuid", [S.D])).rows[0].usado), consumoD + 1);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM ia_credito_lancamentos WHERE empresa_id = $1::uuid", [S.D])).rows[0].n, 0);

    // Motor novo (A, cortada): 1 crédito consumido por geração concluída; consumo mensal legado intocado.
    const antes = (await lerCarteira(c as unknown as DbExecutor, S.A, "CONVITES"))!;
    const consumoLegadoA = (await c.query("SELECT usado FROM convite_consumos WHERE empresa_id = $1::uuid", [S.A])).rows[0].usado;
    const ga = await gerar(S.conviteA);
    assert.equal(ga.estado, "CONCLUIDA");
    const depois = (await lerCarteira(c as unknown as DbExecutor, S.A, "CONVITES"))!;
    assert.deepEqual([depois.saldo, depois.reservado], [antes.saldo - 1, antes.reservado]);
    assert.equal((await c.query("SELECT usado FROM convite_consumos WHERE empresa_id = $1::uuid", [S.A])).rows[0].usado, consumoLegadoA, "um motor por empresa");
    const leitura = await svc.consultar({ tipo: "cliente", token: S.conviteA.token });
    assert.equal(leitura.creditos, null, "cliente da festa não vê saldo empresarial");

    // Flag desligada: empresa cortada não gera (503 tratado), sem cair no legado nem reservar nada.
    process.env.CREDITOS_CONVITES_CONSUMO_ATIVO = "false";
    const chamadasAntes = chamadas.length;
    await assert.rejects(gerar(S.conviteA), (e: { status?: number; message?: string }) => e.status === 503 && /manutenção/.test(e.message ?? ""));
    assert.equal(chamadas.length, chamadasAntes, "nenhuma chamada com a flag desligada");
    assert.equal((await c.query("SELECT usado FROM convite_consumos WHERE empresa_id = $1::uuid", [S.A])).rows[0].usado, consumoLegadoA, "sem fallback para o legado");
    process.env.CREDITOS_CONVITES_CONSUMO_ATIVO = "true";
    // Falha de rede depois do marcador de envio: INCERTA, reserva mantida ("em verificação"), sem nova tentativa automática.
    modoIA = "falha_rede";
    const gi = await gerar(S.conviteA);
    assert.equal(gi.estado, "VERIFICANDO");
    const emVerificacao = (await lerCarteira(c as unknown as DbExecutor, S.A, "CONVITES"))!;
    assert.equal(emVerificacao.reservado, antes.reservado + 1);
    modoIA = "ok";
    // Operador resolve SEM_COBRANCA: devolve ao saldo uma vez (funciona com qualquer flag).
    const incerta = (await c.query("SELECT id FROM convite_geracoes WHERE convite_id = $1::uuid AND estado = 'INCERTA'", [S.conviteA.id])).rows[0].id;
    const svcResolver = svc as unknown as { resolverGeracaoIncerta: (tx: DbExecutor, op: string, raw: unknown) => Promise<{ liberouReserva: boolean }> };
    process.env.CREDITOS_CONVITES_CONSUMO_ATIVO = "false";
    const res = await comTx((t2) => svcResolver.resolverGeracaoIncerta(t2, S.uA, { geracaoId: incerta, resultado: "SEM_COBRANCA", evidencia: "Painel da OpenAI sem cobrança (teste)" }));
    process.env.CREDITOS_CONVITES_CONSUMO_ATIVO = "true";
    assert.equal(res.liberouReserva, true);
    const final = (await lerCarteira(c as unknown as DbExecutor, S.A, "CONVITES"))!;
    assert.deepEqual([final.saldo, final.reservado], [antes.saldo - 1, antes.reservado]);
    assert.deepEqual(await conferirCarteira(c as unknown as DbExecutor, S.A, "CONVITES"), []);
    assert.equal(await fotografia(c, S.B), S.fotoB, "B intacta");
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const k of Object.keys(process.env)) if (!(k in salvo)) delete process.env[k];
    Object.assign(process.env, salvo);
    await encerrarDescartavel(c);
  }
});

test("095: corte concorrente com geração (duas conexões): a geração espera o corte na trava da empresa e usa só o motor novo; o legado não debita", { timeout: 180_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const c2 = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  const salvo = { ...process.env };
  const fetchOriginal = globalThis.fetch;
  const chamadas: string[] = [];
  try {
    globalThis.fetch = (async (u: string | URL | Request) => {
      const url = typeof u === "string" ? u : u instanceof URL ? u.href : u.url;
      if (!url.startsWith("https://api.openai.com/")) throw new Error(`rede bloqueada no teste: ${url}`);
      chamadas.push(url);
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      return new Response(JSON.stringify({ data: [{ b64_json: png }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    Object.assign(process.env, { CONVITES_ENABLED: "true", CONVITES_IA_ENABLED: "true", CONVITES_IA_PROVIDER: "openai", OPENAI_API_KEY: "sk-sintetica-de-teste",
      CONVITES_IA_TETO_DIARIO_MICROUSD: "10000000", CREDITOS_CONVITES_CONSUMO_ATIVO: "true" });
    // Empresa E no motor legado (limite 3, nada usado), com festa, convite do cliente e autorização 088 vigente.
    await c.query("BEGIN");
    const E = await empresa(c, "Créditos E (corte concorrente)"), uE = await gestao(c, E);
    await assinaturaPaga(c, E, "cus_E");
    await legado(c, E, 3, 0);
    await c.query("COMMIT");
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    const conviteE = await festa(c, E, uE);
    await c.query("COMMIT");
    const svc2 = carregarModulo("lib/convites/service.ts", { "db/postgres": { db: () => c2, withTransaction: emTx(c2) } }, new Map()) as {
      comandar: (a: unknown, raw: unknown) => Promise<Record<string, unknown>> };
    await svc2.comandar({ tipo: "cliente", token: conviteE.token }, { acao: "autorizar_ia", versao: VERSAO_TEXTOS_IA, provedor: "openai",
      textoHash: hashTextoIA("openai", "CLIENTE"), responsavelNome: "Responsável Sintético", vinculo: "MAE", declaracao: true });
    const consumoAntes = (await c.query("SELECT coalesce(sum(usado), 0)::int AS n FROM convite_consumos WHERE empresa_id = $1::uuid", [E])).rows[0].n;
    // c: corte aberto (FOR SHARE na empresa E, depois convite_carteiras). c2: geração pelo serviço real, que começa travando a
    // empresa FOR UPDATE: espera o corte inteiro e, depois do COMMIT, vê a carteira nova (um motor por empresa).
    const pCorte = await pidDe(c), pGera = await pidDe(c2);
    await c.query("BEGIN");
    const corteE = await aplicarCorte(c as unknown as DbExecutor, E, "TESTE corte concorrente 22/10");
    assert.equal(corteE.quantidadeLegado, 3);
    const geracao = svc2.comandar({ tipo: "cliente", token: conviteE.token }, { acao: "gerar", chave: randomUUID(), prompt: "Tema jardim com borboletas", referencias: [] })
      .then((x) => x, (e: { status?: number; message?: string }) => e);
    assert.equal(await esperarBloqueio(obs, pGera, pCorte), true, "a geração espera o corte (trava da empresa)");
    const espera = (await obs.query<{ q: string }>("SELECT query AS q FROM pg_stat_activity WHERE pid = $1", [pGera])).rows[0].q;
    assert.match(espera, /FROM empresas WHERE id=\$1 AND status='ATIVA' FOR UPDATE/, "espera na trava da empresa, antes de escolher o motor");
    assert.equal(chamadas.length, 0, "nada é enviado enquanto o corte está aberto");
    await c.query("COMMIT");
    const r = await geracao as { estado?: string };
    assert.equal(r.estado, "CONCLUIDA", `geração concluída pelo motor novo (obtido: ${JSON.stringify(r)})`);
    // Um motor só: o legado não debitou; a carteira nova consumiu 1 do lote LEGADO criado pelo corte.
    assert.equal((await c.query("SELECT coalesce(sum(usado), 0)::int AS n FROM convite_consumos WHERE empresa_id = $1::uuid", [E])).rows[0].n, consumoAntes, "legado intacto");
    assert.equal((await c.query("SELECT count(*)::int AS n FROM ia_credito_reservas WHERE empresa_id = $1::uuid AND estado = 'CONSUMIDA'", [E])).rows[0].n, 1);
    assert.equal(chamadas.length, 1, "uma chamada ao provedor (dublê)");
    const w = (await lerCarteira(c as unknown as DbExecutor, E, "CONVITES"))!;
    assert.deepEqual([w.saldo, w.reservado], [2, 0], "3 do lote LEGADO menos a geração concluída");
    assert.deepEqual(await conferirCarteira(c as unknown as DbExecutor, E, "CONVITES"), []);
    assert.equal(await fotografia(c, S.B), S.fotoB, "B intacta");
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const k of Object.keys(process.env)) if (!(k in salvo)) delete process.env[k];
    Object.assign(process.env, salvo);
    await c.query("ROLLBACK").catch(() => {});
    await encerrarDescartavel(obs, false);
    await encerrarDescartavel(c2, false);
    await encerrarDescartavel(c);
  }
});

test("095: geração já em curso e corte (duas conexões): o corte espera na trava da empresa, sem deadlock, e vê o consumo legado", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const gen = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  try {
    await c.query("BEGIN");
    const F = await empresa(c, "Créditos F (geração antes do corte)");
    await legado(c, F, 4, 0);
    await c.query("COMMIT");
    // `gen` reproduz a ordem de travas da geração legada (lib/convites/service.ts): empresa FOR UPDATE no início,
    // convite_carteiras FOR UPDATE depois, e o débito mensal.
    const pGen = await pidDe(gen), pCorte = await pidDe(c);
    await gen.query("BEGIN");
    await gen.query("SELECT id FROM empresas WHERE id = $1::uuid AND status = 'ATIVA' FOR UPDATE", [F]);
    await c.query("BEGIN");
    await c.query("SET LOCAL lock_timeout = '20s'");
    const corte = aplicarCorte(c as unknown as DbExecutor, F, "TESTE geracao antes do corte 22/10").then((x) => x, (e) => e);
    const bloqueou = await esperarBloqueio(obs, pCorte, pGen);
    const situacaoCorte = await Promise.race([corte.then((x) => (x instanceof Error ? `ERRO ${(x as { code?: string }).code} ${x.message}` : `CONCLUIU ${JSON.stringify(x)}`)),
      new Promise((f) => setTimeout(() => f("PENDENTE"), 50))]);
    assert.equal(bloqueou, true, `o corte espera a geração na trava da empresa (corte: ${situacaoCorte})`);
    // A geração continua sem esperar o corte (ele ainda não pegou convite_carteiras): nenhum ciclo de espera.
    await gen.query("SET LOCAL lock_timeout = '5s'");
    await gen.query("SELECT empresa_id FROM convite_carteiras WHERE empresa_id = $1::uuid FOR UPDATE", [F]);
    await gen.query(`INSERT INTO convite_consumos (empresa_id, mes, usado) VALUES ($1::uuid, date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date, 1)
      ON CONFLICT (empresa_id, mes) DO UPDATE SET usado = convite_consumos.usado + 1`, [F]);
    await gen.query("COMMIT");
    const r = await corte;
    assert.ok(!(r instanceof Error), `corte concluído sem deadlock (obtido: ${r instanceof Error ? (r as { code?: string }).code + " " + r.message : "ok"})`);
    await c.query("COMMIT");
    assert.equal((r as { quantidadeLegado: number }).quantidadeLegado, 3, "a fotografia do corte inclui o consumo legado que terminou antes");
    assert.equal((await lerCarteira(c as unknown as DbExecutor, F, "CONVITES"))!.saldo, 3);
    assert.equal(await fotografia(c, S.B), S.fotoB, "B intacta");
  } finally {
    await gen.query("ROLLBACK").catch(() => {});
    await c.query("ROLLBACK").catch(() => {});
    await encerrarDescartavel(obs, false);
    await encerrarDescartavel(gen, false);
    await encerrarDescartavel(c);
  }
});

test("095 (P2 da revisão): pago após cancelamento → revisão; saídas do operador; estorno parcial; disputa preserva o liberado", { timeout: 240_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const tx = c as unknown as DbExecutor;
    const duble = asaasDuble();
    const ctx = { provedor: duble.cliente, ambiente: "sandbox" as const, conta: "padrao" };
    const reconciliar = createRequire(import.meta.url)("../../scripts/assinatura-reconciliar.cjs") as {
      lerPendenciasCreditos: (c: unknown) => Promise<{ item: string; resultado: string; motivo: string; critico: boolean }[]> };
    await c.query("BEGIN");
    const G = await empresa(c, "Créditos G (P2)"), uG = await gestao(c, G);
    await assinaturaPaga(c, G, "cus_G");
    await legado(c, G, 0, 0);
    const Hh = await empresa(c, "Créditos H (P2-6)"), uH = await gestao(c, Hh);
    await assinaturaPaga(c, Hh, "cus_H");
    await legado(c, Hh, 0, 0);
    await c.query("COMMIT");
    for (const e of [G, Hh]) await emTx(c)((t2) => aplicarCorte(t2, e, "TESTE P2 22/10"));
    const tenant = (empresaId: string, u: string) => (async <T>(_s: unknown, _e: unknown, w: (t2: DbExecutor, t: object) => Promise<T>) =>
      emTx(c)((t2) => w(t2, { empresaComprovada: empresaId, papelAtual: "REPRESENTANTE_AUTORIZADO", membershipId: "m", usuarioId: u }))) as unknown as DepsCreditos["withTenantTransaction"];
    const deps = (empresaId: string, u: string, env: Record<string, string> = ENV): DepsCreditos => ({ withTenantTransaction: tenant(empresaId, u), withTransaction: emTx(c),
      provedor: () => ({ cliente: duble.cliente, ambiente: "sandbox" }), consumirLimite: async () => true, env });
    const comprar = async (empresaId: string, u: string, oferta = "CONVITES_10", preco = 5900, env?: Record<string, string>) => {
      const r = await criarPedido(sessao(u), null, { oferta, forma: "PIX", chave: randomUUID(), confirmar: true, precoEsperadoCentavos: preco, termosVersao: "creditos-ia-20261022.demo" }, deps(empresaId, u, env));
      const p = (await c.query("SELECT p.id, c.pagamento_id FROM ia_credito_pedidos p JOIN ia_credito_cobrancas c ON c.pedido_id = p.id AND c.canonica WHERE p.protocolo = $1", [r.protocolo])).rows[0];
      return { protocolo: r.protocolo, id: p.id as string, pagamento: p.pagamento_id as string };
    };
    const estado = async (id: string) => (await c.query("SELECT estado, revisao_motivo FROM ia_credito_pedidos WHERE id = $1::uuid", [id])).rows[0];

    // P2-2: cobrança cancelada (deleted) → ENCERRADO; o cliente paga mesmo assim → REVISAO crítica, revisitada pela reconciliação.
    const x = await comprar(G, uG);
    duble.pagar(x.pagamento, "PENDING", { deleted: true });
    assert.equal((await emTx(c)((t2) => processarPedido(t2, x.id, ctx))).resultado, "ENCERRADO");
    assert.ok((await emTx(c)((t2) => pedidosParaReconciliar(t2))).includes(x.id), "ENCERRADO recente com cobrança é revisitado");
    duble.pagar(x.pagamento, "RECEIVED", { deleted: false });
    assert.deepEqual(await emTx(c)((t2) => processarPedido(t2, x.id, ctx)), { resultado: "REVISAO", motivo: "PAGO_APOS_CANCELAMENTO" });
    assert.deepEqual(await estado(x.id), { estado: "REVISAO", revisao_motivo: "PAGO_APOS_CANCELAMENTO" });
    assert.ok((await reconciliar.lerPendenciasCreditos(c)).some((i) => i.item === "PEDIDO_CREDITOS" && i.motivo === "PAGO_APOS_CANCELAMENTO" && i.critico), "item CRÍTICO (D4)");
    // P2-3: saída do operador — sem referência recusa; CREDITAR só com o pagamento relido agora; crédito único.
    await assert.rejects(emTx(c)((t2) => resolverRevisao(t2, uG, { protocolo: x.protocolo, resultado: "CREDITAR", referencia: " " }, ctx)), /REFERENCIA_OBRIGATORIA/);
    assert.deepEqual(await emTx(c)((t2) => resolverRevisao(t2, uG, { protocolo: x.protocolo, resultado: "CREDITAR", referencia: "Cliente escolheu os creditos (D3)" }, ctx)), { estado: "CREDITADO" });
    assert.equal((await lerCarteira(tx, G, "CONVITES"))!.saldo, 10);
    await assert.rejects(emTx(c)((t2) => resolverRevisao(t2, uG, { protocolo: x.protocolo, resultado: "CREDITAR", referencia: "de novo" }, ctx)), /PEDIDO_NAO_ESTA_EM_REVISAO/);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'CREDITOS_REVISAO_RESOLVIDA' AND entidade_id = $1::uuid", [x.id])).rows[0].n, 1);
    // P3-5 (revisão do delta): a auditoria guarda o preço do pedido e o valor lido no provedor.
    assert.deepEqual((await c.query("SELECT dados_depois->'precoCentavos' AS p, dados_depois->'valorLidoCentavos' AS v FROM auditoria WHERE acao = 'CREDITOS_REVISAO_RESOLVIDA' AND entidade_id = $1::uuid", [x.id])).rows[0], { p: 5900, v: 5900 });

    // P2-3: revisão por valor divergente → ENCERRAR com referência (devolvido no painel); creditar sem pagamento confirmado recusa.
    const y = await comprar(G, uG);
    duble.pagar(y.pagamento, "RECEIVED", { valorCentavos: 6100 });
    assert.deepEqual(await emTx(c)((t2) => reprocessarPedido(t2, uG, y.protocolo, ctx)), { resultado: "REVISAO", motivo: "VALOR_DIVERGENTE" });
    // P3-2 (revisão do delta): ENCERRAR com o pagamento ainda confirmado recusa (devolver no painel antes).
    await assert.rejects(emTx(c)((t2) => resolverRevisao(t2, uG, { protocolo: y.protocolo, resultado: "ENCERRAR", referencia: "ainda nao devolvido" }, ctx)), /PAGAMENTO_CONFIRMADO_DEVOLVER_ANTES/);
    assert.deepEqual(await estado(y.id), { estado: "REVISAO", revisao_motivo: "VALOR_DIVERGENTE" });
    duble.pagar(y.pagamento, "REFUND_REQUESTED");
    await assert.rejects(emTx(c)((t2) => resolverRevisao(t2, uG, { protocolo: y.protocolo, resultado: "CREDITAR", referencia: "tentativa" }, ctx)), /PAGAMENTO_NAO_CONFIRMADO_NO_PROVEDOR/);
    assert.deepEqual(await emTx(c)((t2) => resolverRevisao(t2, uG, { protocolo: y.protocolo, resultado: "ENCERRAR", referencia: "Estorno integral no painel Asaas" }, ctx)), { estado: "ENCERRADO" });
    assert.deepEqual(await estado(y.id), { estado: "ENCERRADO", revisao_motivo: null });

    // P2-3: pagamento duplicado (cobrança extra paga) → concluído pelo operador com referência.
    duble.s.modo = "duplicar";
    const dup = await criarPedido(sessao(uG), null, { oferta: "CONVITES_10", forma: "PIX", chave: randomUUID(), confirmar: true, precoEsperadoCentavos: 5900, termosVersao: "creditos-ia-20261022.demo" }, deps(G, uG));
    duble.s.modo = "normal";
    const dupId = (await c.query("SELECT id FROM ia_credito_pedidos WHERE protocolo = $1", [dup.protocolo])).rows[0].id;
    await emTx(c)((t2) => processarPedido(t2, dupId, ctx));
    const extra = (await c.query("SELECT id, pagamento_id FROM ia_credito_cobrancas WHERE pedido_id = $1::uuid AND NOT canonica ORDER BY pagamento_id LIMIT 1", [dupId])).rows[0];
    duble.pagar(extra.pagamento_id, "RECEIVED");
    await emTx(c)((t2) => processarEventoCreditos(t2, { cobrancaProvedorId: extra.pagamento_id, referenciaExterna: null }, { pedidoId: dupId, cobrancaId: extra.id, canonica: false }, ctx));
    assert.equal((await c.query("SELECT revisao_motivo FROM ia_credito_cobrancas WHERE id = $1::uuid", [extra.id])).rows[0].revisao_motivo, "PAGAMENTO_DUPLICADO");
    await emTx(c)((t2) => concluirCobrancaExtra(t2, uG, { pagamentoId: extra.pagamento_id, referencia: "Estorno do duplicado no painel" }));
    assert.deepEqual((await c.query("SELECT revisao_motivo, estornado_centavos FROM ia_credito_cobrancas WHERE id = $1::uuid", [extra.id])).rows[0], { revisao_motivo: null, estornado_centavos: "5900" });

    // P2-5: estorno externo PARCIAL (refunds DONE, status continua RECEIVED) → bloqueia o remanescente e marca para o operador.
    const z = await comprar(G, uG);
    duble.pagar(z.pagamento, "RECEIVED");
    await emTx(c)((t2) => processarPedido(t2, z.id, ctx));
    duble.pagar(z.pagamento, "RECEIVED", { estornos: [{ status: "DONE", valorCentavos: 2000, descricao: null }] });
    assert.deepEqual(await emTx(c)((t2) => processarPedido(t2, z.id, ctx)), { resultado: "REVISAO", motivo: "ESTORNO_EXTERNO_PARCIAL" });
    const loteZ = async () => (await c.query("SELECT disponivel, bloqueado, cancelado FROM ia_credito_lotes WHERE pedido_id = $1::uuid", [z.id])).rows[0];
    assert.deepEqual(await loteZ(), { disponivel: "0", bloqueado: "10", cancelado: "0" });
    assert.deepEqual((await c.query("SELECT estornado_centavos, revisao_motivo FROM ia_credito_cobrancas WHERE pedido_id = $1::uuid AND canonica", [z.id])).rows[0],
      { estornado_centavos: "2000", revisao_motivo: "ESTORNO_EXTERNO_PARCIAL" });
    assert.ok((await reconciliar.lerPendenciasCreditos(c)).some((i) => i.resultado === "ESTORNO_EXTERNO_PARCIAL" && i.critico));
    await emTx(c)((t2) => resolverBloqueio(t2, uG, { pagamentoId: z.pagamento, resultado: "LIBERAR", referencia: "Estorno era de outra venda (conferido)" }));
    assert.deepEqual(await loteZ(), { disponivel: "10", bloqueado: "0", cancelado: "0" });
    // P2-N1 (revisão do delta): o mesmo estorno relido depois da decisão do operador não realarma nem bloqueia...
    assert.notEqual((await emTx(c)((t2) => processarPedido(t2, z.id, ctx))).resultado, "REVISAO");
    assert.deepEqual(await loteZ(), { disponivel: "10", bloqueado: "0", cancelado: "0" });
    assert.equal((await c.query("SELECT revisao_motivo FROM ia_credito_cobrancas WHERE pedido_id = $1::uuid AND canonica", [z.id])).rows[0].revisao_motivo, null);
    assert.ok(!(await reconciliar.lerPendenciasCreditos(c)).some((i) => i.resultado === "ESTORNO_EXTERNO_PARCIAL"), "sem alarme depois da decisão");
    // ...e um 2º estorno maior é episódio novo: bloqueia de novo; CANCELAR leva o bloqueado à perda definitiva.
    duble.pagar(z.pagamento, "RECEIVED", { estornos: [{ status: "DONE", valorCentavos: 2000, descricao: null }, { status: "DONE", valorCentavos: 1500, descricao: null }] });
    assert.deepEqual(await emTx(c)((t2) => processarPedido(t2, z.id, ctx)), { resultado: "REVISAO", motivo: "ESTORNO_EXTERNO_PARCIAL" });
    assert.deepEqual(await loteZ(), { disponivel: "0", bloqueado: "10", cancelado: "0" });
    await emTx(c)((t2) => resolverBloqueio(t2, uG, { pagamentoId: z.pagamento, resultado: "CANCELAR", referencia: "Cliente ficou com o reembolso (conferido)" }));
    assert.deepEqual(await loteZ(), { disponivel: "0", bloqueado: "0", cancelado: "10" });
    assert.equal((await emTx(c)((t2) => processarPedido(t2, z.id, ctx))).resultado === "REVISAO", false, "cancelado não realarma");

    // P3-6 + P2-N2 (revisões do delta): cliente divergente sem dinheiro recebido não é CRÍTICO; recebido, é — tudo pelo
    // caminho real (processarPedido com o dublê), sem forçar estado no banco.
    const w = await comprar(G, uG);
    const saldoAntesW = (await lerCarteira(tx, G, "CONVITES"))!.saldo;
    const itemW = async () => (await reconciliar.lerPendenciasCreditos(c)).find((i) => i.item === "PEDIDO_CREDITOS" && i.motivo === "CLIENTE_DIVERGENTE");
    const situacaoW = async () => (await c.query("SELECT situacao_provedor FROM ia_credito_cobrancas WHERE pedido_id = $1::uuid AND canonica", [w.id])).rows[0].situacao_provedor;
    duble.pagar(w.pagamento, "PENDING", { clienteId: "cus_outro" });
    assert.deepEqual(await emTx(c)((t2) => processarPedido(t2, w.id, ctx)), { resultado: "REVISAO", motivo: "CLIENTE_DIVERGENTE" });
    assert.equal(await situacaoW(), "PENDING");
    assert.equal((await itemW())?.critico, false, "sem dinheiro recebido: não crítico");
    duble.pagar(w.pagamento, "RECEIVED", { clienteId: "cus_outro" });
    assert.deepEqual(await emTx(c)((t2) => processarPedido(t2, w.id, ctx)), { resultado: "REVISAO", motivo: "CLIENTE_DIVERGENTE" });
    assert.equal(await situacaoW(), "RECEIVED", "o ramo REVISAO grava o status lido");
    assert.equal((await itemW())?.critico, true, "recebido com cliente divergente: CRÍTICO (D4)");
    assert.equal((await lerCarteira(tx, G, "CONVITES"))!.saldo, saldoAntesW, "nada creditado");

    // P2-6: disputa aberta com geração em andamento; a liberação fica BLOQUEADA (não cancelada) e volta inteira na disputa favorável.
    const h = await comprar(Hh, uH);
    duble.pagar(h.pagamento, "RECEIVED");
    await emTx(c)((t2) => processarPedido(t2, h.id, ctx));
    await emTx(c)((t2) => reservar(t2, { empresaId: Hh, recurso: "CONVITES", operacaoId: "h-em-andamento", quantidade: 2, ator: "EQUIPE" }));
    duble.pagar(h.pagamento, "CHARGEBACK_REQUESTED");
    assert.equal((await emTx(c)((t2) => processarPedido(t2, h.id, ctx))).resultado, "DISPUTA");
    await emTx(c)((t2) => encerrarReserva(t2, { empresaId: Hh, recurso: "CONVITES", operacaoId: "h-em-andamento", quantidadeFinal: 0, ator: "SISTEMA" }));
    const loteH = async () => (await c.query("SELECT disponivel, reservado, bloqueado, cancelado FROM ia_credito_lotes WHERE pedido_id = $1::uuid", [h.id])).rows[0];
    assert.deepEqual(await loteH(), { disponivel: "0", reservado: "0", bloqueado: "10", cancelado: "0" }, "liberado durante a disputa fica bloqueado");
    duble.pagar(h.pagamento, "RECEIVED");
    await emTx(c)((t2) => processarPedido(t2, h.id, ctx));
    assert.deepEqual(await loteH(), { disponivel: "10", reservado: "0", bloqueado: "0", cancelado: "0" }, "disputa favorável devolve tudo");

    // P2-5: devolução própria (saldo não usado, estorno automático) concluída por estorno PARCIAL DONE com status RECEIVED.
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query("UPDATE ia_credito_lotes SET liberado_em = liberado_em - interval '10 days' WHERE pedido_id = $1::uuid", [h.id]);
    await c.query("COMMIT");
    const envEstorno = { ...ENV, CREDITOS_ESTORNO_ATIVO: "true" };
    const sd = await solicitarDevolucao(sessao(uH), null, { pedido: h.protocolo, tipo: "SALDO_NAO_UTILIZADO", valorEsperadoCentavos: 5900, chave: randomUUID(), confirmar: true }, deps(Hh, uH, envEstorno));
    assert.equal(sd.estado, "SOLICITADO");
    duble.pagar(h.pagamento, "RECEIVED", { estornos: [{ status: "PENDING", valorCentavos: 5900, descricao: null }] });
    await emTx(c)((t2) => processarPedido(t2, h.id, ctx));
    assert.equal((await c.query("SELECT estado FROM ia_credito_devolucoes WHERE protocolo = $1", [sd.protocolo])).rows[0].estado, "SOLICITADO", "estorno ainda não concluído");
    duble.pagar(h.pagamento, "RECEIVED", { estornos: [{ status: "DONE", valorCentavos: 2000, descricao: null }, { status: "PENDING", valorCentavos: 3900, descricao: null }] });
    await emTx(c)((t2) => processarPedido(t2, h.id, ctx));
    assert.equal((await c.query("SELECT estado FROM ia_credito_devolucoes WHERE protocolo = $1", [sd.protocolo])).rows[0].estado, "SOLICITADO", "parte feita não conclui a devolução");
    duble.pagar(h.pagamento, "RECEIVED", { estornos: [{ status: "DONE", valorCentavos: 5900, descricao: null }] });
    assert.equal((await emTx(c)((t2) => processarPedido(t2, h.id, ctx))).resultado, "ESTORNO");
    assert.equal((await c.query("SELECT estado FROM ia_credito_devolucoes WHERE protocolo = $1", [sd.protocolo])).rows[0].estado, "CONCLUIDO");
    for (const e of [G, Hh]) assert.deepEqual(await conferirCarteira(tx, e, "CONVITES"), []);
    assert.equal(await fotografia(c, S.B), S.fotoB, "B intacta");
  } finally {
    await encerrarDescartavel(c);
  }
});

test("095: exportação com os créditos (colunas excluídas, filtro por empresa) e rollback recusado com dados", { timeout: 120_000 }, async (t) => {
  if (!opt()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const { gerarPacote } = await import("../exportacao/pacote.ts");
    const { lerZip } = await import("../exportacao/zip.ts");
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const p = await gerarPacote(c as unknown as DbExecutor, S.C);
    await c.query("COMMIT");
    const zip = lerZip(readFileSync(p.zipCaminho));
    await p.limpar();
    assert.deepEqual(p.manifesto.entidadesAusentes, []);
    const csv = (nome: string) => zip.get(`dados/creditos/${nome}.csv`)?.toString("utf8") ?? "";
    const arq = (t2: string) => p.manifesto.arquivos.find((a) => a.tabela === t2)!;
    assert.ok(arq("ia_credito_pedidos").linhas! >= 4);
    for (const [tabela, coluna] of [["ia_credito_pedidos", "chave_idempotencia"], ["ia_credito_pedidos", "payload_sha256"], ["ia_credito_cobrancas", "url_fatura"],
      ["ia_credito_cobrancas", "conta"], ["ia_credito_lancamentos", "operacao"], ["ia_credito_lotes", "chave_origem"]])
      assert.equal(arq(tabela).colunas!.includes(coluna), false, `${tabela}.${coluna} fica fora`);
    assert.ok(csv("pedidos").includes(S.protocoloC));
    assert.doesNotMatch(csv("cobrancas"), /asaas\.com/, "sem link de fatura");
    assert.doesNotMatch(csv("extrato") + csv("lotes") + csv("pedidos"), new RegExp(S.B), "nada da empresa B");
    // Rollback recusado: há obrigações financeiras registradas.
    await assert.rejects(c.query(DOWN), /095 rollback recusado: há registros/);
    await c.query("ROLLBACK").catch(() => {});
    assert.equal(await creditosInstalados(c as unknown as DbExecutor), true);
  } finally {
    await encerrarDescartavel(c);
  }
});
