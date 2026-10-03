import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Client } from "pg";
import { hashToken } from "../lib/autenticacao/senha.ts";
import type { DbExecutor } from "../lib/db/contracts.ts";

/**
 * Apoio de teste (como os demais scripts/*-test-support): cenários SINTÉTICOS das suítes PostgreSQL da integração (061) e da agenda por empresa/unidade (062). Só é usado
 * por `*.postgres.test.ts`, que rodam apenas no cluster descartável com opt-in (nunca staging/produção nem o banco
 * local `kidmais_manager`). Nada aqui conecta sozinho: recebe o Client já aberto pela suíte.
 */
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exigir = createRequire(import.meta.url);
const extensoes = exigir.extensions as unknown as Record<string, (module: { _compile(code: string, filename: string): void }, filename: string) => void>;
extensoes[".ts"] = (module, filename) => {
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText.replace(/require\("@\/([^"\n]+)"\)/g, (_texto, caminho: string) => `require(${JSON.stringify(resolve(root, caminho))})`);
  module._compile(output, filename);
};
/** Carrega um módulo do repositório pelo caminho a partir da raiz (CommonJS, com o alias `@/`). */
export const carregar = <T>(relativo: string) => exigir(resolve(root, relativo)) as T;
export const ler = (f: string) => readFileSync(resolve(root, f), "utf8");
export const cod = () => `i2${randomBytes(3).toString("hex")}`;
export const id = async (db: Client, sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
export const executor = (db: Client): DbExecutor => ({ query: async (sql, values = []) => { const r = await db.query(sql, [...values]); return { rows: r.rows, rowCount: r.rowCount }; } }) as DbExecutor;
export const dia = (deslocamento: number) => new Date(Date.now() + deslocamento * 86_400_000).toISOString().slice(0, 10);

/**
 * Dispara AGORA as verificações diferidas pendentes (como no commit) e devolve cada restrição ao seu modo padrão:
 * as INITIALLY DEFERRED voltam a diferidas e as INITIALLY IMMEDIATE seguem imediatas. Sem isso, um
 * `SET CONSTRAINTS ALL IMMEDIATE` valeria para o resto da transação e anteciparia guardas de sequências
 * multi-comando (ledger 015, vínculo da 061) que no produto rodam cada uma na própria transação.
 */
export async function validarAgora(db: Client) {
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  const diferidas = (await db.query<{ nome: string }>(
    `SELECT DISTINCT quote_ident(n.nspname) || '.' || quote_ident(c.conname) AS nome
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.condeferrable AND c.condeferred AND n.nspname = 'public' ORDER BY 1`,
  )).rows.map((r) => r.nome);
  // Nome compartilhado com uma restrição INITIALLY IMMEDIATE mudaria o modo dela: recusa em vez de aproximar.
  const ambiguas = (await db.query(
    `SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.condeferrable GROUP BY c.conname HAVING bool_or(c.condeferred) AND bool_or(NOT c.condeferred)`,
  )).rows;
  if (ambiguas.length) throw new Error(`validarAgora: nomes de restrição ambíguos ${JSON.stringify(ambiguas)}`);
  if (diferidas.length) await db.query(`SET CONSTRAINTS ${diferidas.join(", ")} DEFERRED`);
}

export async function existe(db: Client, tabela: string) {
  return (await db.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${tabela}`])).rows[0]?.ok === true;
}

/** 055a–d com os scripts reais (pré-requisito da 061); idempotente no banco de trabalho. */
export async function instalar055(db: Client) {
  for (const [l, nome] of [["a", "uso"], ["b", "operacoes"], ["c", "documentos"], ["d", "importacoes"]]) {
    const tabela = { a: "ia_orcamento_reservas", b: "ia_operacoes", c: "ia_documentos", d: "ia_importacoes" }[l]!;
    if (!await existe(db, tabela)) {
      await db.query(ler(`database/migrations/20260928_055${l}_inteligencia_${nome}.sql`));
      await db.query(ler(`database/checks/20260928_055${l}_postcheck.sql`));
    }
  }
}

/** 061 com precheck, migration e postcheck reais; reaplicar é recusado. */
export async function instalar061(db: Client) {
  await db.query(ler("database/checks/20261002_061_precheck.sql"));
  await db.query(ler("database/migrations/20261002_061_contratos_importados_integracao.sql"));
  await db.query(ler("database/checks/20261002_061_postcheck.sql"));
  await assert.rejects(db.query(ler("database/migrations/20261002_061_contratos_importados_integracao.sql")), /061 já aplicada/);
  await db.query("ROLLBACK");
}

/** 062 com precheck, migration e postcheck reais; reaplicar é recusado. */
export async function instalar062(db: Client) {
  await db.query(ler("database/checks/20261002_062_precheck.sql"));
  await db.query(ler("database/migrations/20261002_062_agenda_empresa_unidade.sql"));
  await db.query(ler("database/checks/20261002_062_postcheck.sql"));
  await assert.rejects(db.query(ler("database/migrations/20261002_062_agenda_empresa_unidade.sql")), /062 já aplicada/);
  await db.query("ROLLBACK");
}

/**
 * Empresa ativa, usuário com membership ADMINISTRATIVO e sessão (recebimento exige sessão viva), pacote com preço e
 * `unidades` unidades (a 043 cria toda unidade SUSPENSO; a agenda usa a unidade não desativada).
 */
export async function cenario(db: Client, unidades = 1) {
  const empresa = await id(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa 061', 'PROVISIONAMENTO') RETURNING id`, [cod()]);
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [empresa]);
  const usuario = await id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Operador 061', $2, 'ADMINISTRATIVO', true) RETURNING id`,
    [`${cod()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
  const membership = await id(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'ADMINISTRATIVO') RETURNING id`, [empresa, usuario]);
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [membership]);
  const token = randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
     VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours')`, [usuario, hashToken(token), hashToken(randomBytes(32).toString("base64url"))]);
  const pacote = await id(db, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Festa 061', 1, true, true) RETURNING id`, [empresa, cod().toUpperCase()]);
  const tabela = await id(db, `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela 061', '2020-01-01', false, $2::uuid) RETURNING id`, [cod(), empresa]);
  await db.query(`INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO')`, [tabela, pacote]);
  const agendaCodigo = cod().toUpperCase();
  await db.query(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda 061', '10:00', '22:00', 99)`, [agendaCodigo]);
  const lista: string[] = [];
  for (let i = 0; i < unidades; i++) {
    lista.push(await id(db, `INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, $3, 'SUSPENSO') RETURNING id`, [empresa, `u-${cod()}`, `Unidade ${i + 1}`]));
  }
  return { empresa, usuario, membership, token, pacote, agendaCodigo, unidade: lista[0] ?? null, unidades: lista,
    tenant: { empresaComprovada: empresa, membershipId: membership, usuarioId: usuario, papelAtual: "ADMINISTRATIVO" } };
}

export type Cenario = Awaited<ReturnType<typeof cenario>>;

/** Representante autorizado SINTÉTICO (Gestão, 056) com membership ATIVA na empresa do cenário: operador da agenda por unidade. */
export async function representante(db: Client, c: { empresa: string }) {
  const usuario = await id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Representante 062', $2, 'ADMINISTRATIVO', true) RETURNING id`,
    [`${cod()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
  const membership = await id(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [c.empresa, usuario]);
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [membership]);
  return { empresaComprovada: c.empresa, membershipId: membership, usuarioId: usuario, papelAtual: "REPRESENTANTE_AUTORIZADO" };
}

export type Evento = { data: string; inicio: string; fim: string };

/** Importação CONFIRMADA (IMPORTADA) com original real e o snapshot como o motor grava. */
export async function importacao(db: Client, c: Cenario, evento: Evento) {
  const cliente = await id(db, `INSERT INTO clientes (nome_completo, empresa_id, telefone) VALUES ('Cliente 061', $1::uuid, '11999990000') RETURNING id`, [c.empresa]);
  const documento = await id(db, `INSERT INTO ia_documentos (empresa_id, tipo, status, enviado_por) VALUES ($1::uuid, 'CONTRATO_HISTORICO', 'RECEBIDO', $2::uuid) RETURNING id`, [c.empresa, c.usuario]);
  const pdf = Buffer.from(`%PDF-1.4\n% contrato em papel ${randomUUID()}\n%%EOF\n`);
  const sha = createHash("sha256").update(pdf).digest("hex");
  const original = await id(db, `INSERT INTO ia_documento_originais (documento_id, empresa_id, versao, nome_original, content_type, tamanho_bytes, sha256, conteudo, enviado_por)
     VALUES ($1::uuid, $2::uuid, 1, 'contrato.pdf', 'application/pdf', $3, $4, $5, $6::uuid) RETURNING id`, [documento, c.empresa, pdf.length, sha, pdf, c.usuario]);
  const extracao = await id(db, `INSERT INTO ia_extracoes (documento_id, empresa_id, original_id, metodo, schema_versao, status, resultado, correlation_id, iniciado_em, concluido_em)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'DETERMINISTICO', 1, 'SUCESSO', '{}'::jsonb, 'h061', now(), now()) RETURNING id`, [documento, c.empresa, original]);
  const imp = await id(db, `INSERT INTO ia_importacoes (documento_id, empresa_id, extracao_id, status, versao, dados, criado_por) VALUES ($1::uuid, $2::uuid, $3::uuid, 'EM_REVISAO', 1, '{}'::jsonb, $4::uuid) RETURNING id`,
    [documento, c.empresa, extracao, c.usuario]);
  const snapshot = {
    evento: { data: evento.data, horario: { inicio: evento.inicio, fim: evento.fim }, duracaoMinutos: 240, aniversariante: "Lia", idade: 6, convidados: 50, tema: "Circo" },
    pacote: { nome: "Festa de 2019", duracaoMinutos: 240, quantidade: 50, itens: "Buffet completo" },
    buffet: { itens: null, observacoes: null, restricoes: null },
    valores: { preco: 500000, adicionais: 0, total: 500000 },
    pagamentosPrevistos: { condicao: "30% de entrada", entrada: { valor: 150000, vencimento: dia(-60) }, parcelas: [{ numero: 1, valor: 350000, vencimento: dia(30) }], natureza: "PREVISTO" },
    observacoes: null,
  };
  await db.query(`UPDATE ia_importacoes SET status = 'IMPORTADA', versao = 2, cliente_id = $2::uuid, resultado = $3::jsonb WHERE id = $1::uuid`,
    [imp, cliente, JSON.stringify({ clienteId: cliente, clienteAcao: "CRIAR", contratoHistorico: snapshot, pendencias: [], importadoEm: new Date().toISOString(), importadoPor: c.usuario })]);
  return { id: imp, cliente, sha };
}

/** Sem unidade por padrão: a regra de elegibilidade da 062 (D6) ainda não aceita unidade SUSPENSO (a única possível na 043). */
export function decisoes(c: Cenario, evento: Evento, financeiro: unknown, unidade: string | null = null) {
  return {
    situacaoContrato: "VIGENTE", estabelecimentoId: unidade, pacoteReferenciaId: c.pacote,
    evento: { data: evento.data, horarioInicio: evento.inicio, horarioFim: evento.fim, convidados: 50 },
    valorContratadoCentavos: 500000, motivos: {}, financeiro, outroContratoConfirmado: false, conferenciaDeclarada: true,
  };
}
export const PARCIAL = () => ({ situacao: "PARCIALMENTE_PAGO", parcelas: [
  { valorCentavos: 150000, vencimento: dia(-60), recebimento: { data: dia(-58), forma: "PIX" } },
  { valorCentavos: 350000, vencimento: dia(30), recebimento: null },
] });

export type Servico = typeof import("../lib/contratos/integracao-importados/servico.ts");

export async function integrar(s: Servico, core: unknown, db: Client, c: Cenario, imp: string, d: ReturnType<typeof decisoes>, chave = randomUUID()) {
  const tx = executor(db);
  const sim = await s.simularIntegracao(tx, c.tenant as never, imp, d, dia(0));
  if (sim.integrada || !sim.pronto) throw new Error(`simulação não pronta: ${JSON.stringify(sim)}`);
  const ctx = { usuarioId: c.usuario, token: c.token, requestId: randomUUID(), ip: null, userAgent: "h061" };
  return s.confirmarIntegracao(tx, c.tenant as never, ctx, imp, { decisoes: d, resumoHash: sim.resumoHash, chave }, dia(0), core as never);
}
