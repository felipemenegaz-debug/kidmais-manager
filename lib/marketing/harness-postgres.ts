import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { carregarModulo } from "../acessos/teste-carregador.ts";

/**
 * Apoio das suítes PostgreSQL do Marketing (goal local 14/10/2026). NÃO abre conexão: recebe o cliente da suíte, que
 * conectou pelo conector descartável. Fixtures 100% sintéticas (domínios .test, telefones 55119888xxxxx).
 */
export const SENHA_FALSA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
export const cod = (prefixo: string) => `${prefixo}${randomUUID().replace(/-/g, "").slice(0, 10)}`;

export function executor(c: Client): DbExecutor {
  return { async query(text, values) { const r = await c.query(text, values as unknown[]); return { rows: r.rows, rowCount: r.rowCount }; } };
}

/** "Transação" dos serviços como SAVEPOINT dentro da transação externa da suíte (validações diferidas só no COMMIT). */
export function porSavepoint(c: Client) {
  let n = 0;
  return async <T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> => {
    const sp = `mk_sp_${++n}`;
    await c.query(`SAVEPOINT ${sp}`);
    try { const r = await work(executor(c)); await c.query(`RELEASE SAVEPOINT ${sp}`); return r; }
    catch (e) { await c.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
  };
}

/** Transação real (BEGIN/COMMIT) numa conexão própria — para cenários de concorrência com dados commitados. */
export function porTransacao(c: Client) {
  return async <T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> => {
    await c.query("BEGIN");
    try { const r = await work(executor(c)); await c.query("COMMIT"); return r; }
    catch (e) { await c.query("ROLLBACK"); throw e; }
  };
}

const id = async (c: Client, sql: string, v: unknown[] = []) => (await c.query<{ id: string }>(sql, v)).rows[0].id as string;

export async function empresa(c: Client, nome: string) {
  const e = await id(c, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`, [cod("mk"), nome]);
  await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
  return e;
}

/**
 * Vínculo da pessoa sintética com a empresa. A identidade (usuarios_administrativos) é criada pela PRÓPRIA suíte
 * (guarda F1: no código da aplicação, só lib/autenticacao/usuarios.ts cria identidade).
 */
export async function vincular(c: Client, empresaId: string, usuario: string, papel: "REPRESENTANTE_AUTORIZADO" | "ADMINISTRATIVO", nome = "Pessoa sintética") {
  const membership = await id(c, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), $3) RETURNING id::text AS id`,
    [empresaId, usuario, papel]);
  await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [membership]);
  return { usuario, membership, sessao: { usuario_id: usuario, nome, papel, empresa_ativa_id: empresaId } };
}

export async function cliente(c: Client, empresaId: string, nome: string, telefone: string | null, email: string | null = null) {
  return id(c, `INSERT INTO clientes (empresa_id, nome_completo, telefone, whatsapp, email) VALUES ($1::uuid, $2, $3, $3, $4) RETURNING id::text AS id`, [empresaId, nome, telefone, email]);
}

/** Pacote + tabela + preço + agenda da empresa (mínimo para uma negociação válida). */
export async function comercial(c: Client, empresaId: string) {
  const pacote = await id(c, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, 'COMPLETA', 'Completa sintética', 1, true, true) RETURNING id::text AS id`, [empresaId]);
  const tabela = await id(c, `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela sintética', '2026-01-01', false, $2::uuid) RETURNING id::text AS id`, [cod("t"), empresaId]);
  const preco = await id(c, `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 4500, 'PADRAO') RETURNING id::text AS id`, [tabela, pacote]);
  const agenda = await id(c, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda sintética', '10:00', '18:00', 9) RETURNING id::text AS id`, [cod("ag")]);
  return { pacote, tabela, preco, agenda };
}

export async function fechamento(c: Client, empresaId: string, base: Awaited<ReturnType<typeof comercial>>, clienteId: string,
  opcoes: { data: string; status?: string; atualizadoHaDias?: number }) {
  // Movimentação antiga já no INSERT (o carimbo automático só atua em UPDATE; ALTER TABLE não roda com eventos diferidos).
  return id(c, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
      categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status,
      atualizado_em, iniciado_em)
    VALUES ($1::date, '14:00', '18:00', $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'PADRAO', 'PADRAO', 50, 50, 4500, 4500, 4500, 'ATENDIMENTO_KIDMAIS', $7::uuid, $8,
      now() - make_interval(days => $9::int), now() - make_interval(days => $9::int))
    RETURNING id::text AS id`, [opcoes.data, base.agenda, empresaId, base.pacote, base.tabela, base.preco, clienteId, opcoes.status ?? "RASCUNHO", opcoes.atualizadoHaDias ?? 0]);
}

/** Contrato ASSINADO + versão + pagamento (valor contratado) + recebimento confirmado (opcional). Só dentro de transação. */
export async function contratoAssinado(c: Client, fechamentoId: string, valor: number, recebido: number | null) {
  const contrato = await id(c, `INSERT INTO contratos (fechamento_id, status, assinado_em) VALUES ($1::uuid, 'ASSINADO', now()) RETURNING id::text AS id`, [fechamentoId]);
  const versao = await id(c, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
    VALUES ($1::uuid, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP') RETURNING id::text AS id`, [contrato, JSON.stringify({ comercial: { valorFinalContrato: valor } }), "a".repeat(64), "c".repeat(64)]);
  const pagamento = await id(c, `INSERT INTO pagamentos (contrato_versao_id, valor_total_contratado) VALUES ($1::uuid, $2) RETURNING id::text AS id`, [versao, valor]);
  if (recebido !== null) {
    await c.query(`INSERT INTO pagamento_recebimentos (pagamento_id, status, meio_pagamento, valor_bruto, recebido_em, confirmado_em, chave_idempotencia, metadata_provedor)
      VALUES ($1::uuid, 'CONFIRMADO', 'PIX', $2, now(), now(), $3, '{"forma":"PIX"}'::jsonb)`, [pagamento, recebido, randomUUID()]);
  }
  return { contrato, versao, pagamento };
}

/** Pedido falso para route handlers (sem rede). */
export function pedido(url: string, corpo?: unknown, metodo = corpo === undefined ? "GET" : "POST", headers: Record<string, string> = {}) {
  const texto = corpo === undefined ? "" : JSON.stringify(corpo);
  return { method: metodo, url, nextUrl: new URL(url), headers: new Headers({ host: "127.0.0.1:3000", ...headers }), cookies: { get: () => undefined },
    async text() { return texto; }, async json() { return JSON.parse(texto); } };
}

/** Carrega um módulo real (rota ou serviço) com o banco dublado pela conexão da suíte e a guarda administrativa dublada. */
export function carregarComBanco(arquivo: string, c: Client, sessaoAtual: () => unknown, extras: Record<string, unknown> = {}, cache = new Map()) {
  return carregarModulo(arquivo, {
    "db/postgres": { db: () => executor(c), withTransaction: porSavepoint(c) },
    "http/admin-crm-api": { exigirApiAdminCrmDisponivel: async () => sessaoAtual() },
    ...extras,
  }, cache);
}

export type Resposta = { status: number; headers: Headers; json(): Promise<{ ok: boolean; data?: Record<string, unknown> & unknown; erro?: string; codigo?: string }>; text(): Promise<string> };
