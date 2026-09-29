/* eslint-disable @typescript-eslint/no-explicit-any */
// Migration 054 (PR-B1) no PostgreSQL descartável. Só roda com o alvo autorizado por humano
// (KIDMAIS_054_*; ver alvo-054.ts): nunca DATABASE_URL, nunca kidmais_manager.
//
// Ciclo: identidade → (053 se ausente) → abortos e dependências degradadas (transações desfeitas)
// → fixtures confirmadas → precheck → 054 real (BEGIN/COMMIT do arquivo) → backfill imediato →
// postcheck → preservação → adversariais → locks/autorização → concorrência → rollback inseguro
// → rollback seguro → limpeza → verificação final.
//
// Fixtures de contrato/revisão existem só em transações desfeitas: contrato_edicoes e revisões
// históricas não podem ser apagadas, e uma revisão histórica válida perante a 014/019 exige
// contrato formalizado (duas assinaturas OTP e Festa). O que é confirmado (empresas, catálogo,
// clientes, fechamentos) é removido no fim.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import ts from "typescript";
import { conectar054, encerrar054, semTransacaoExplicita054 } from "./postgres-descartavel-054.ts";
import { empresaReservada054, executarComLimpeza054, exigirSemResiduo054, novoRegistro054, registrar054, removerRegistrados054,
  type Registro054, type TabelaRegistrada } from "./harness-054.ts";

const req = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ler = (arquivo: string) => readFileSync(resolve(root, arquivo), "utf8");
const SQL = {
  precheck: "database/checks/20260928_054_precheck.sql",
  up: "database/migrations/20260928_054_empresa_id_clientes_fechamentos.sql",
  backfill: "database/checks/20260928_054_backfill_imediato.sql",
  postcheck: "database/checks/20260928_054_postcheck.sql",
  rollbackPrecheck: "database/checks/20260928_054_rollback_precheck.sql",
  down: "database/rollback/20260928_054_empresa_id_clientes_fechamentos_down.sql",
  precheck053: "database/checks/20260928_053_precheck.sql",
  up053: "database/migrations/20260928_053_integridade_tenant_fechamento.sql",
  down053: "database/rollback/20260928_053_integridade_tenant_fechamento_down.sql",
};
const PREFIXO = "Fixture 054";
const LOCK = /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i;
const GUARDAS_HISTORICAS = ["fr_fechamento_proteger_trg", "fr_confirmacao_agenda_trg", "festa019_fechamento", "festa019_lock_fechamento"];
const PRIMEIRO_LOCK_CONTRATO = "SELECT id FROM fechamentos WHERE id=$1 AND empresa_id=$2::uuid FOR UPDATE";

// ---------------------------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------------------------
const texto = (erro: unknown) => (erro instanceof Error ? erro.message : String(erro));
const codigoDe = (erro: unknown) => (erro as { code?: string })?.code;
const codigo = (prefixo: string) => `${prefixo}${randomBytes(4).toString("hex")}`;

async function id(db: Client, sql: string, params: unknown[]) {
  return (await db.query<{ id: string }>(sql, params)).rows[0].id;
}
/** Executa dentro de SAVEPOINT e exige a recusa com o trecho; o estado volta ao anterior. */
async function recusa(db: Client, sql: string, params: unknown[], trecho: string) {
  await db.query("SAVEPOINT prova");
  let mensagem = "passou";
  try {
    await (params.length ? db.query(sql, params) : db.query(sql));
  } catch (erro) {
    mensagem = texto(erro);
  }
  await db.query("ROLLBACK TO SAVEPOINT prova");
  assert.equal(mensagem.includes(trecho), true, `${trecho}: ${mensagem}`);
}
/** Executa dentro de SAVEPOINT e exige sucesso; o estado volta ao anterior. */
async function aceita(db: Client, sql: string, params: unknown[]) {
  await db.query("SAVEPOINT prova");
  try {
    await db.query(sql, params);
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT prova");
  }
}
/** Arquivo SQL completo (com o próprio BEGIN/COMMIT). Devolve a mensagem de erro ou null. */
async function arquivo(db: Client, caminho: string): Promise<string | null> {
  try {
    await db.query(ler(caminho));
    return null;
  } catch (erro) {
    await db.query("ROLLBACK").catch(() => {});
    return texto(erro);
  }
}
/**
 * Processa agora os eventos diferidos das fixtures (prova que são válidas) e devolve cada
 * restrição INITIALLY DEFERRED ao modo diferido: a migration encontra a transação como no deploy.
 */
async function processarFila(db: Client) {
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  const r = await db.query<{ nomes: string | null }>(
    `SELECT string_agg(DISTINCT format('%I.%I', n.nspname, c.conname), ', ') AS nomes
       FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace
      WHERE c.condeferrable AND c.condeferred`,
  );
  if (r.rows[0].nomes) await db.query(`SET CONSTRAINTS ${r.rows[0].nomes} DEFERRED`);
}
async function instalada054(db: Client) {
  return (await db.query<{ ok: boolean }>("SELECT to_regprocedure('public.kidmais_054_falhar_se_incompativel()') IS NOT NULL AS ok")).rows[0].ok;
}
async function instalada053(db: Client) {
  return (await db.query<{ ok: boolean }>("SELECT to_regprocedure('public.kidmais_053_falhar_se_incompativel()') IS NOT NULL AS ok")).rows[0].ok;
}
async function objetos054(db: Client) {
  return (await db.query<{ funcoes: number; gatilhos: number; colunas: number; indices: number; fks: number }>(
    `SELECT (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'kidmais\\_054\\_%') AS funcoes,
            (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%\\_054\\_%') AS gatilhos,
            (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('clientes', 'fechamentos') AND column_name = 'empresa_id') AS colunas,
            (SELECT count(*)::int FROM pg_class WHERE relname IN ('clientes_054_empresa_idx', 'fechamentos_054_empresa_idx')) AS indices,
            (SELECT count(*)::int FROM pg_constraint WHERE conname IN ('clientes_054_empresa_fk', 'fechamentos_054_empresa_fk')) AS fks`,
  )).rows[0];
}
const SEM_054 = { funcoes: 0, gatilhos: 0, colunas: 0, indices: 0, fks: 0 };
const COM_054 = { funcoes: 5, gatilhos: 5, colunas: 2, indices: 2, fks: 2 };
/** Contagens e hash de clientes/fechamentos sem a coluna empresa_id (comparável antes, durante e depois). */
async function estado(db: Client) {
  return (await db.query<{ clientes: string; fechamentos: string; hc: string; hf: string }>(
    `SELECT (SELECT count(*) FROM clientes)::text AS clientes, (SELECT count(*) FROM fechamentos)::text AS fechamentos,
            (SELECT md5(coalesce(string_agg((to_jsonb(c) - 'empresa_id')::text, ',' ORDER BY c.id), '')) FROM clientes c) AS hc,
            (SELECT md5(coalesce(string_agg((to_jsonb(f) - 'empresa_id')::text, ',' ORDER BY f.id), '')) FROM fechamentos f) AS hf`,
  )).rows[0];
}
/** Todos os gatilhos de usuário do schema public fora da 054: nome, tabela, função, eventos, habilitação, diferimento, WHEN. */
async function gatilhos(db: Client) {
  return (await db.query<{ linha: string }>(
    `SELECT concat_ws('|', c.relname, t.tgname, t.tgfoid::regprocedure::text, t.tgtype, t.tgenabled, t.tgdeferrable, t.tginitdeferred, t.tgqual IS NOT NULL) AS linha
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND t.tgname NOT LIKE '%\\_054\\_%'
      ORDER BY 1`,
  )).rows.map((r) => r.linha);
}
async function guardasHabilitadas(db: Client) {
  const r = await db.query<{ tgname: string; tgenabled: string }>(
    "SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'public.fechamentos'::regclass AND tgname = ANY($1::text[]) ORDER BY tgname",
    [GUARDAS_HISTORICAS],
  );
  return Object.fromEntries(r.rows.map((x) => [x.tgname, x.tgenabled]));
}
const TODAS_HABILITADAS = Object.fromEntries([...GUARDAS_HISTORICAS].sort().map((g) => [g, "O"]));

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
type Cat = { empresa: string | null; pacote: string; tabela: string; preco: string };
async function empresa(db: Client, nome: string) {
  return id(db, "INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id", [codigo("e54"), `${PREFIXO} ${nome}`]);
}
/** Registra o id quando a linha pertence a fixture confirmada (sem registro: transação desfeita). */
const anotar = (reg: Registro054 | undefined, tabela: TabelaRegistrada, valor: string) => (reg ? registrar054(reg, tabela, valor) : valor);
async function catalogo(db: Client, nome: string, empresaId: string | null, reg?: Registro054): Promise<Cat> {
  const pacote = await id(db, "INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, $3, 540, true, true) RETURNING id", [empresaId, codigo("P54").toUpperCase(), `${PREFIXO} ${nome}`]);
  const tabela = await id(db, "INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, ativa) VALUES ($1::uuid, $2, $3, '2026-01-01', false) RETURNING id", [empresaId, codigo("t54"), `${PREFIXO} ${nome}`]);
  const preco = await id(db, "INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id", [tabela, pacote]);
  anotar(reg, "pacotes", pacote);
  anotar(reg, "tabelas_preco", tabela);
  anotar(reg, "precos_pacote", preco);
  return { empresa: empresaId, pacote, tabela, preco };
}
async function agendaDe(db: Client, reg?: Registro054) {
  return anotar(reg, "configuracao_agenda", await id(db, "INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, $2, '10:00', '18:00', 54) RETURNING id", [codigo("ag54"), PREFIXO]));
}
async function usuarioDe(db: Client) {
  return id(db, "INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
    [`${codigo("u54")}@example.test`, PREFIXO, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
}
async function clienteDe(db: Client, nome: string, opcoes: { principal?: string; empresa?: string | null; reg?: Registro054 } = {}) {
  const nomeCompleto = `${PREFIXO} ${nome}`;
  if (opcoes.principal) {
    return anotar(opcoes.reg, "clientes_mesclados", await id(db, "INSERT INTO clientes (nome_completo, status, cliente_principal_id, mesclado_em) VALUES ($1, 'MESCLADO', $2::uuid, now()) RETURNING id", [nomeCompleto, opcoes.principal]));
  }
  if (opcoes.empresa !== undefined) return anotar(opcoes.reg, "clientes", await id(db, "INSERT INTO clientes (nome_completo, empresa_id) VALUES ($1, $2::uuid) RETURNING id", [nomeCompleto, opcoes.empresa]));
  return anotar(opcoes.reg, "clientes", await id(db, "INSERT INTO clientes (nome_completo) VALUES ($1) RETURNING id", [nomeCompleto]));
}
const COLUNAS_FECHAMENTO = `data_evento, horario_inicio, horario_fim, configuracao_agenda_id, pacote_id, tabela_preco_id, preco_pacote_id,
  regra_desconto_pacote_id, categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados,
  valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status`;
const VALORES_FECHAMENTO = `'2031-05-01', '14:00', '18:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL,
  'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, 'RASCUNHO'`;
/** Antes da 054 (sem a coluna). */
const INSERIR_FECHAMENTO = `INSERT INTO fechamentos (${COLUNAS_FECHAMENTO}) VALUES (${VALORES_FECHAMENTO}) RETURNING id`;
/** Depois da 054: empresa explícita ($6), como o repositório grava. */
const INSERIR_FECHAMENTO_054 = `INSERT INTO fechamentos (${COLUNAS_FECHAMENTO}, empresa_id) VALUES (${VALORES_FECHAMENTO}, $6::uuid) RETURNING id`;
const fechamentoDe = async (db: Client, agenda: string, cat: Cat, cliente: string | null, reg?: Registro054) =>
  anotar(reg, "fechamentos", await id(db, INSERIR_FECHAMENTO, [agenda, cat.pacote, cat.tabela, cat.preco, cliente]));
const argsFechamento054 = (agenda: string, cat: Cat, cliente: string | null, empresaId: string | null) =>
  [agenda, cat.pacote, cat.tabela, cat.preco, cliente, empresaId];

const INSERIR_REVISAO = `INSERT INTO fechamento_revisoes (
  fechamento_id, contrato_id, contrato_versao_id, versao_base_id, motivo, chave_criacao, fonte_base_hash, conteudo_hash,
  criado_por_usuario_id, atualizado_por_usuario_id, cliente_id, data_evento, horario_inicio, horario_fim,
  configuracao_agenda_id, pacote_id, tabela_preco_id, preco_pacote_id, regra_desconto_pacote_id, categoria_horario,
  categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'Revisão 054', $5::uuid, '${"a".repeat(64)}', '${"a".repeat(64)}', $6::uuid, $6::uuid, $7::uuid,
  '2031-05-01', '14:00', '18:00', $8::uuid, $9::uuid, $10::uuid, $11::uuid, NULL, 'PADRAO', 'PADRAO', 20, 20, 100, 100, 100) RETURNING id`;
/** Base contratual mínima (versão substituída + versão em preparação). Só em transação desfeita. */
async function contratoDoFechamento(db: Client, fechamento: string) {
  const contrato = await id(db, "INSERT INTO contratos (fechamento_id, status) VALUES ($1::uuid, 'AGUARDANDO_ASSINATURA') RETURNING id", [fechamento]);
  const versaoBase = await id(db, "INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, substituido_em) VALUES ($1::uuid, 1, 'SUBSTITUIDA', '{}'::jsonb, $2, now()) RETURNING id", [contrato, "a".repeat(64)]);
  const versaoNova = await id(db, "INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash) VALUES ($1::uuid, 2, 'ATIVA', '{}'::jsonb, $2) RETURNING id", [contrato, "a".repeat(64)]);
  return { contrato, versaoBase, versaoNova };
}

/** Cenário confirmado do backfill: cada cliente/fechamento com a empresa esperada depois da 054. */
type Fixtures = {
  eA: string; eB: string; catA: Cat; catB: Cat; catL: Cat; agenda: string;
  clientes: Record<string, string>; fechamentos: Record<string, string>;
  esperadoCliente: Record<string, string | null>; esperadoFechamento: Record<string, string | null>;
};
async function criarFixtures(db: Client, reg: Registro054): Promise<Fixtures> {
  await db.query("BEGIN");
  try {
    const eA = await empresaReservada054(db, "A");
    const eB = await empresaReservada054(db, "B");
    const catA = await catalogo(db, "A", eA, reg);
    const catB = await catalogo(db, "B", eB, reg);
    const catL = await catalogo(db, "legado", null, reg);
    const agenda = await agendaDe(db, reg);
    const c: Record<string, string> = {};
    c.c0 = await clienteDe(db, "sem fechamento", { reg });
    c.cA = await clienteDe(db, "canônico A", { reg });
    c.cAm = await clienteDe(db, "mesclado em A sem fechamento", { principal: c.cA, reg });
    c.cM = await clienteDe(db, "canônico sem fechamento", { reg });
    c.cMm = await clienteDe(db, "mesclado com a prova", { principal: c.cM, reg });
    c.cL = await clienteDe(db, "legado mais A", { reg });
    c.cLeg = await clienteDe(db, "só legado", { reg });
    c.cB = await clienteDe(db, "canônico B", { reg });
    const f: Record<string, string> = {};
    f.fA = await fechamentoDe(db, agenda, catA, c.cA, reg);
    f.fA2 = await fechamentoDe(db, agenda, catA, c.cA, reg);
    f.fM = await fechamentoDe(db, agenda, catA, c.cMm, reg);
    f.fL = await fechamentoDe(db, agenda, catL, c.cL, reg);
    f.fLA = await fechamentoDe(db, agenda, catA, c.cL, reg);
    f.fLeg = await fechamentoDe(db, agenda, catL, c.cLeg, reg);
    f.fB = await fechamentoDe(db, agenda, catB, c.cB, reg);
    f.fSem = await fechamentoDe(db, agenda, catA, null, reg);
    await db.query("COMMIT");
    return {
      eA, eB, catA, catB, catL, agenda, clientes: c, fechamentos: f,
      // 0 empresas -> NULL; 1 empresa -> o grupo inteiro (canônico + mesclados); pacote NULL não prova.
      esperadoCliente: { c0: null, cA: eA, cAm: eA, cM: eA, cMm: eA, cL: eA, cLeg: null, cB: eB },
      esperadoFechamento: { fA: eA, fA2: eA, fM: eA, fL: null, fLA: eA, fLeg: null, fB: eB, fSem: eA },
    };
  } catch (erro) {
    await db.query("ROLLBACK").catch(() => {});
    throw erro;
  }
}
// ---------------------------------------------------------------------------------------------
// Serviços reais (transpilados) sobre o executor do teste; só sessão/tenant são simulados.
// ---------------------------------------------------------------------------------------------
type Registro = { exec: any; sql: { texto: string; v: unknown[] }[] };
function registrar(db: Client): Registro {
  const sql: Registro["sql"] = [];
  return {
    sql,
    exec: {
      async query(textoSql: string, v?: readonly unknown[]) {
        sql.push({ texto: textoSql, v: [...(v ?? [])] });
        const r = await db.query(textoSql, v as unknown[]);
        return { rows: r.rows, rowCount: r.rowCount };
      },
    },
  };
}
function carregar(arquivoTs: string, mocks: Record<string, unknown>) {
  const cache = new Map<string, Record<string, unknown>>();
  const achar = (base: string) => [base, `${base}.ts`, `${base}/index.ts`].find((p) => existsSync(p) && statSync(p).isFile()) ?? base;
  function load(file: string): Record<string, unknown> {
    const abs = achar(resolve(root, file)).replaceAll("\\", "/");
    for (const [chave, valor] of Object.entries(mocks)) if (abs.endsWith(chave)) return valor as Record<string, unknown>;
    const hit = cache.get(abs);
    if (hit) return hit;
    const exports: Record<string, unknown> = {};
    cache.set(abs, exports);
    const code = ts.transpileModule(readFileSync(abs, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    new Function("require", "exports", code)((n: string) => (n.startsWith("@/") ? load(n.slice(2)) : n.startsWith(".") ? load(resolve(dirname(abs), n)) : req(n)), exports);
    return exports;
  }
  return load(arquivoTs);
}
/** Módulos com o executor trocado a cada cenário (`atual.exec`) e tenant/sessão simulados. */
function servicos(atual: { exec: any; tenant: string; usuario: string }) {
  const banco = { db: () => atual.exec, withTransaction: (fn: (tx: unknown) => unknown) => fn(atual.exec) };
  const comuns = {
    "lib/db/postgres.ts": banco,
    "lib/autenticacao/service.ts": { consultarSessao: async () => ({ usuario_id: atual.usuario, papel: "ADMINISTRATIVO" }), authError: (m = "Sessão inválida.") => new Error(m) },
    "lib/saas/provar-tenant.ts": { provarTenant: async () => ({ empresaComprovada: atual.tenant, membershipId: randomUUID(), usuarioId: atual.usuario }) },
    "lib/contratos/documento/index.ts": {}, "lib/contratos/storage/postgres.ts": {},
  };
  return {
    contratos: carregar("lib/contratos/services/administrativo.service.ts", comuns) as any,
    comercial: carregar("lib/fechamentos/services/revisao-comercial.service.ts", comuns) as any,
    operacional: carregar("lib/fechamentos/services/revisao-operacional.service.ts", comuns) as any,
    repositorio: carregar("lib/fechamentos/repositories/fechamento.repository.ts", comuns) as any,
    hash: (carregar("lib/contratos/services/snapshot-core.ts", {}) as any).hashSnapshotContrato as (s: unknown) => string,
  };
}
/** xmax de cada linha: muda quando esta transação trava a linha (FOR UPDATE/SHARE/KEY SHARE/NO KEY UPDATE). */
async function xmax(db: Client, linhas: [string, string][]) {
  const saida: string[] = [];
  for (const [tabela, linha] of linhas) {
    saida.push(`${tabela}:${(await db.query<{ x: string }>(`SELECT xmax::text AS x FROM ${tabela} WHERE id = $1::uuid`, [linha])).rows[0]?.x}`);
  }
  return saida;
}
/** Contrato + versão ATIVA com hash válido, só nesta transação (nunca confirmado). */
async function contratoMinimo(db: Client, hash: (s: unknown) => string, fechamento: string, cliente: string | null) {
  const snapshot = { fechamento: { id: fechamento }, contratante: { clienteId: cliente }, aniversariante: { id: null } };
  const contrato = await id(db, "INSERT INTO contratos (fechamento_id, status) VALUES ($1::uuid, 'AGUARDANDO_ASSINATURA') RETURNING id", [fechamento]);
  const versao = await id(db, "INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash) VALUES ($1::uuid, 1, 'ATIVA', $2::jsonb, $3) RETURNING id", [contrato, JSON.stringify(snapshot), hash(snapshot)]);
  return { contrato, versao };
}
async function esperarBloqueio(observador: Client, pid: number) {
  for (let tentativa = 0; tentativa < 200; tentativa++) {
    const r = await observador.query<{ bloqueado: boolean }>("SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS bloqueado", [pid]);
    if (r.rows[0].bloqueado) return;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  assert.fail(`a conexão ${pid} não ficou bloqueada`);
}
/** Chama o serviço num SAVEPOINT: erro SQL não aborta a transação do teste (o xmax continua legível). */
async function chamar(db: Client, fn: () => Promise<unknown>) {
  await db.query("SAVEPOINT servico");
  let erro: unknown = null;
  try {
    await fn();
  } catch (e) {
    erro = e;
  }
  try {
    await db.query("RELEASE SAVEPOINT servico");
  } catch {
    await db.query("ROLLBACK TO SAVEPOINT servico");
  }
  return erro;
}
const pidDe = async (c: Client) => (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;

const edicao = {
  acao: "editar_festa", revisao: 1, motivo: "Ajuste 054", fonteHash: "a".repeat(64), pacoteId: randomUUID(), convidados: 30, dataEvento: "2031-05-01",
  configuracaoAgendaId: randomUUID(), horarioInicio: "14:00", horarioFim: "18:00", adicionais: [], idadeAniversarianteEvento: null, temaFesta: "",
  buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "", observacoesEquipe: "",
};
const PAYLOADS: [string, object][] = [
  ["apenas data", { ...edicao, dataEvento: "2031-06-20" }],
  ["apenas pacote", { ...edicao, pacoteId: randomUUID() }],
  ["apenas condição comercial", { ...edicao, comercial: { confirmarAprovacao: true, forma: "PIX_AVISTA", baseNegociada: null, condicaoPix: null } }],
  ["salvar", { acao: "salvar", revisao: 1, observacoesDocumentais: "" }],
  ["revalidar destino", { acao: "revalidar_destino", revisao: 1 }],
  ["cancelar revisão", { acao: "cancelar_revisao", revisao: 1, motivo: "Cancelar agora" }],
  ["cancelar contratação", { acao: "cancelar_contratacao", motivo: "Cliente desistiu" }],
];

// ---------------------------------------------------------------------------------------------
// Ciclo
// ---------------------------------------------------------------------------------------------
test("migration 054 no postgres descartável", { timeout: 600_000 }, async (t) => {
  assert.equal(process.env.DATABASE_URL, undefined, "DATABASE_URL nunca participa do ciclo");
  const client = await conectar054();
  const db = client as unknown as Client;
  const reg = novoRegistro054();
  const estadoCiclo = { instalou053: false, instalou054: false };
  const ciclo = async () => {
    const ident = (await db.query<{ db: string; addr: string; port: number; usuario: string }>(
      "SELECT current_database() AS db, host(inet_server_addr()) AS addr, inet_server_port() AS port, current_user AS usuario",
    )).rows[0];
    assert.notEqual(ident.db.toLowerCase(), "kidmais_manager");
    t.diagnostic(`alvo confirmado: ${ident.addr}:${ident.port}/${ident.db} (usuário ${ident.usuario})`);

    // Resíduo inesperado aborta antes de qualquer escrita; a limpeza não toca dado preexistente.
    await exigirSemResiduo054(db);
    assert.equal(await instalada054(db), false, "o banco descartável precisa começar sem a 054");
    assert.deepEqual(await objetos054(db), SEM_054);
    if (!(await instalada053(db))) {
      assert.equal(await arquivo(db, SQL.precheck053), null, "precheck 053");
      assert.equal(await arquivo(db, SQL.up053), null, "053");
      estadoCiclo.instalou053 = true;
    }
    assert.deepEqual(await guardasHabilitadas(db), TODAS_HABILITADAS, "guardas 014/019 reais presentes e ligadas");

    await abortos(db);
    await degradacoes(db);

    // ---------------- instalação real ----------------
    const gatilhosAntes = await gatilhos(db);
    const fx = await criarFixtures(db, reg);
    const antes = await estado(db);
    const atualizadoAntes = await atualizados(db, fx);
    assert.equal(await arquivo(db, SQL.precheck), null, "precheck");
    const erroUp = await arquivo(db, SQL.up);
    assert.equal(erroUp, null, `054 (nenhum erro de evento diferido/DDL esperado): ${erroUp}`);
    estadoCiclo.instalou054 = true;
    assert.equal(await arquivo(db, SQL.backfill), null, "backfill imediato");
    assert.equal(await arquivo(db, SQL.postcheck), null, "postcheck");
    assert.deepEqual(await objetos054(db), COM_054);
    await conferirBackfill(db, fx);
    assert.deepEqual(await atualizados(db, fx), atualizadoAntes, "atualizado_em preservado");
    const depois = await estado(db);
    assert.deepEqual(depois, antes, "contagens e hash (sem empresa_id) preservados: nenhuma outra coluna mudou");
    assert.deepEqual(await gatilhos(db), gatilhosAntes, "gatilhos fora da 054 idênticos (timestamps religados; guardas intactas)");
    assert.deepEqual(await guardasHabilitadas(db), TODAS_HABILITADAS);
    await revisoesHistoricasComClienteSemEmpresa(db, fx, t);

    await adversariais(db, fx);
    await postcheckDegradado(db);
    await locksAutorizacao(db, fx);
    await concorrencia(db, fx);
    await rollbackInseguro(db, fx, reg);

    // ---------------- rollback seguro ----------------
    assert.equal(await arquivo(db, SQL.rollbackPrecheck), null, "rollback precheck");
    const antesDown = await estado(db);
    assert.equal(await arquivo(db, SQL.down), null, "down");
    assert.deepEqual(await objetos054(db), SEM_054, "objetos da 054 removidos (funções, gatilhos, colunas, índices, FKs)");
    assert.deepEqual(await estado(db), antesDown, "o down não apaga nem altera linha");
    assert.deepEqual(await estado(db), antes, "estado anterior à 054 restaurado");
    assert.deepEqual(await gatilhos(db), gatilhosAntes);
    assert.deepEqual(await guardasHabilitadas(db), TODAS_HABILITADAS);
  };
  try {
    await executarComLimpeza054(ciclo, estadoCiclo, {
      // Só os IDs registrados por esta execução; nunca DELETE por nome.
      removerRegistrados: async () => {
        await db.query("ROLLBACK").catch(() => {});
        await removerRegistrados054(db, reg);
      },
      instalada054: () => instalada054(db),
      down054: () => arquivo(db, SQL.down),
      ausencia054: async () => JSON.stringify(await objetos054(db)) === JSON.stringify(SEM_054),
      down053: () => arquivo(db, SQL.down053),
      verificarFinal: async () => {
        await exigirSemResiduo054(db);
        assert.deepEqual(await guardasHabilitadas(db), TODAS_HABILITADAS, "guardas históricas ligadas");
      },
      encerrar: () => encerrar054(client),
    });
  } catch (erro) {
    const extras = (erro as { errosDeLimpeza?: string[] }).errosDeLimpeza;
    if (extras?.length) t.diagnostic(`erros adicionais de limpeza: ${extras.join(" | ")}`);
    throw erro;
  }
});

async function atualizados(db: Client, fx: Fixtures) {
  const r = await db.query<{ id: string; t: string }>(
    `SELECT id::text, atualizado_em::text AS t FROM clientes WHERE id = ANY($1::uuid[])
      UNION ALL SELECT id::text, atualizado_em::text FROM fechamentos WHERE id = ANY($2::uuid[]) ORDER BY 1`,
    [Object.values(fx.clientes), Object.values(fx.fechamentos)],
  );
  return r.rows.map((x) => `${x.id}=${x.t}`);
}

async function conferirBackfill(db: Client, fx: Fixtures) {
  for (const [nome, cid] of Object.entries(fx.clientes)) {
    const r = await db.query<{ e: string | null }>("SELECT empresa_id::text AS e FROM clientes WHERE id = $1::uuid", [cid]);
    assert.equal(r.rows[0].e, fx.esperadoCliente[nome], `cliente ${nome}`);
  }
  for (const [nome, fid] of Object.entries(fx.fechamentos)) {
    const r = await db.query<{ e: string | null }>("SELECT empresa_id::text AS e FROM fechamentos WHERE id = $1::uuid", [fid]);
    assert.equal(r.rows[0].e, fx.esperadoFechamento[nome], `fechamento ${nome}`);
  }
}

/** 2+ empresas no grupo canônico: precheck e migration abortam, atomicamente (transação desfeita). */
async function abortos(db: Client) {
  for (const viaMesclado of [false, true]) {
    await db.query("BEGIN");
    try {
      const eA = await empresa(db, "aborto A");
      const eB = await empresa(db, "aborto B");
      const catA = await catalogo(db, "aborto A", eA);
      const catB = await catalogo(db, "aborto B", eB);
      const catL = await catalogo(db, "aborto legado", null);
      const agenda = await agendaDe(db);
      const canonico = await clienteDe(db, "aborto canônico");
      await fechamentoDe(db, agenda, catA, canonico);
      await fechamentoDe(db, agenda, catL, canonico);
      const outro = viaMesclado ? await clienteDe(db, "aborto mesclado", { principal: canonico }) : canonico;
      await fechamentoDe(db, agenda, catB, outro);
      await processarFila(db);
      const antes = await estado(db);
      await recusa(db, ler(SQL.precheck), [], "grupo(s) canônico(s) com fechamentos em empresas distintas");
      await recusa(db, semTransacaoExplicita054(ler(SQL.up)), [], "054: cliente com fechamentos em empresas distintas (grupo canônico)");
      assert.deepEqual(await objetos054(db), SEM_054, "aborto atômico: nenhum objeto da 054");
      assert.deepEqual(await estado(db), antes, "aborto atômico: nenhuma linha alterada");
    } finally {
      await db.query("ROLLBACK");
    }
  }
}

/** Uma dependência degradada por vez: precheck e migration recusam antes de criar qualquer objeto. */
async function degradacoes(db: Client) {
  const casos: [string, string, string][] = [
    ["014 ausente", "DROP TRIGGER fr_fechamento_proteger_trg ON fechamentos", "fr_fechamento_proteger_trg"],
    ["019 desabilitada", "ALTER TABLE fechamentos DISABLE TRIGGER festa019_lock_fechamento", "festa019_lock_fechamento"],
    ["019 só réplica", "ALTER TABLE fechamentos ENABLE REPLICA TRIGGER festa019_fechamento", "festa019_fechamento"],
    ["014 função errada", `DROP TRIGGER fr_confirmacao_agenda_trg ON fechamentos;
      CREATE CONSTRAINT TRIGGER fr_confirmacao_agenda_trg AFTER INSERT OR UPDATE ON fechamentos DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION kidmais_proteger_fechamento_em_revisao()`, "fr_confirmacao_agenda_trg"],
    ["019 eventos errados", `DROP TRIGGER festa019_fechamento ON fechamentos;
      CREATE CONSTRAINT TRIGGER festa019_fechamento AFTER UPDATE ON fechamentos DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION kidmais019_validar_contrato()`, "festa019_fechamento"],
    ["019 WHEN indevido", `DROP TRIGGER festa019_lock_fechamento ON fechamentos;
      CREATE TRIGGER festa019_lock_fechamento BEFORE INSERT OR UPDATE ON fechamentos
      FOR EACH ROW WHEN (NEW.status IS NOT NULL) EXECUTE FUNCTION kidmais019_lock_ocupacao()`, "festa019_lock_fechamento"],
    ["014 diferimento incorreto", `DROP TRIGGER fr_fechamento_proteger_trg ON fechamentos;
      CREATE CONSTRAINT TRIGGER fr_fechamento_proteger_trg AFTER UPDATE ON fechamentos DEFERRABLE INITIALLY IMMEDIATE
      FOR EACH ROW EXECUTE FUNCTION kidmais_proteger_fechamento_em_revisao()`, "fr_fechamento_proteger_trg"],
    ["036 desabilitada", "ALTER TABLE pacotes DISABLE TRIGGER pacotes_empresa_imutavel_trg", "pacotes_empresa_imutavel_trg"],
    ["036/038 WHEN", `DROP TRIGGER tabelas_preco_empresa_imutavel_trg ON tabelas_preco;
      CREATE TRIGGER tabelas_preco_empresa_imutavel_trg BEFORE UPDATE OF empresa_id ON tabelas_preco
      FOR EACH ROW WHEN (OLD.empresa_id IS NULL) EXECUTE FUNCTION public.kidmais_036_empresa_pai_imutavel()`, "tabelas_preco_empresa_imutavel_trg"],
    ["036 ausente", "DROP TRIGGER adicionais_empresa_imutavel_trg ON adicionais", "adicionais_empresa_imutavel_trg"],
    ["053 diferimento", `DROP TRIGGER fechamentos_053_filhos_trg ON fechamentos;
      CREATE CONSTRAINT TRIGGER fechamentos_053_filhos_trg AFTER UPDATE OF pacote_id, tabela_preco_id ON fechamentos
      DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.kidmais_053_fechamento_filhos()`, "fechamentos_053_filhos_trg"],
    ["053 desabilitada", "ALTER TABLE fechamento_revisoes DISABLE TRIGGER fechamento_revisoes_053_empresa_trg", "fechamento_revisoes_053_empresa_trg"],
    ["timestamp desabilitado", "ALTER TABLE clientes DISABLE TRIGGER clientes_atualizado_em_trg", "clientes_atualizado_em_trg"],
    ["053 função sem search_path", "ALTER FUNCTION public.kidmais_053_revisao() RESET search_path", "054: instalação da 053 incompleta"],
    ["053 FK da fotografia", "ALTER TABLE fechamento_pacote_snapshots DROP CONSTRAINT fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk", "054: instalação da 053 incompleta"],
  ];
  await db.query("BEGIN");
  try {
    // Controle: sem degradação, precheck passa e a migration instala dentro da transação.
    await db.query(ler(SQL.precheck));
    await db.query("SAVEPOINT controle");
    await db.query(semTransacaoExplicita054(ler(SQL.up)));
    assert.deepEqual(await objetos054(db), COM_054, "controle: instala sem degradação");
    await db.query("ROLLBACK TO SAVEPOINT controle");
    for (const [caso, degradar, trecho] of casos) {
      await db.query("SAVEPOINT dependencia");
      await db.query(degradar);
      const esperado = trecho.startsWith("054:") ? trecho : `054: dependência ausente ou degradada: ${trecho}`;
      await recusa(db, ler(SQL.precheck), [], esperado);
      await recusa(db, semTransacaoExplicita054(ler(SQL.up)), [], esperado);
      assert.deepEqual(await objetos054(db), SEM_054, `${caso}: nenhum objeto residual da 054`);
      await db.query("ROLLBACK TO SAVEPOINT dependencia");
    }
    assert.deepEqual(await guardasHabilitadas(db), TODAS_HABILITADAS);
  } finally {
    await db.query("ROLLBACK");
  }
}

/** Revisões históricas já existentes com cliente sem empresa: preservadas; nova troca recusada. */
async function revisoesHistoricasComClienteSemEmpresa(db: Client, fx: Fixtures, t: { diagnostic: (m: string) => void }) {
  const r = await db.query<{ id: string }>(
    `SELECT r.id::text FROM fechamento_revisoes r JOIN clientes c ON c.id = r.cliente_id WHERE c.empresa_id IS NULL ORDER BY r.id LIMIT 3`,
  );
  t.diagnostic(`revisões históricas com cliente sem empresa no banco descartável: ${r.rows.length} (amostra até 3)`);
  if (!r.rows.length) return;
  await db.query("BEGIN");
  try {
    for (const { id: rid } of r.rows) {
      // Cliente sem empresa: nunca autoriza nova associação, qualquer que seja a empresa do fechamento.
      await recusa(db, "UPDATE fechamento_revisoes SET cliente_id = $2::uuid WHERE id = $1::uuid", [rid, fx.clientes.c0], "054: cliente da revisão sem a mesma empresa comprovada");
    }
  } finally {
    await db.query("ROLLBACK");
  }
}

/** Cliente↔fechamento, coerência, imutabilidade, revisão e legado por SQL direto (sem serviço). */
async function adversariais(db: Client, fx: Fixtures) {
  const { clientes: c, fechamentos: f, eA, eB, catA, catB, catL, agenda } = fx;
  const CLIENTE = "054: cliente e fechamento sem a mesma empresa comprovada";
  const REVISAO = "054: cliente da revisão sem a mesma empresa comprovada do fechamento";
  await db.query("BEGIN");
  try {
    // Nova associação cliente/fechamento (empresa do cliente / empresa do fechamento).
    await aceita(db, INSERIR_FECHAMENTO_054, argsFechamento054(agenda, catA, c.cA, eA)); // A/A
    await recusa(db, INSERIR_FECHAMENTO_054, argsFechamento054(agenda, catB, c.cA, eB), CLIENTE); // A/B
    await recusa(db, INSERIR_FECHAMENTO_054, argsFechamento054(agenda, catA, c.cB, eA), CLIENTE); // B/A
    await recusa(db, INSERIR_FECHAMENTO_054, argsFechamento054(agenda, catL, c.cA, null), CLIENTE); // A/NULL
    await recusa(db, INSERIR_FECHAMENTO_054, argsFechamento054(agenda, catA, c.c0, eA), CLIENTE); // NULL/A
    await recusa(db, INSERIR_FECHAMENTO_054, argsFechamento054(agenda, catL, c.c0, null), CLIENTE); // NULL/NULL
    await recusa(db, INSERIR_FECHAMENTO_054, argsFechamento054(agenda, catL, c.cLeg, null), CLIENTE); // NULL/NULL (legado)
    await recusa(db, "UPDATE fechamentos SET cliente_id = $2::uuid WHERE id = $1::uuid", [f.fSem, c.cB], CLIENTE);
    await recusa(db, "UPDATE fechamentos SET cliente_id = $2::uuid WHERE id = $1::uuid", [f.fSem, c.c0], CLIENTE);
    await recusa(db, "UPDATE fechamentos SET cliente_id = $2::uuid WHERE id = $1::uuid", [f.fLeg, c.c0], CLIENTE);
    await aceita(db, "UPDATE fechamentos SET cliente_id = $2::uuid WHERE id = $1::uuid", [f.fSem, c.cA]);
    // Vínculo histórico sem troca não é revalidado (legado preservado).
    await aceita(db, "UPDATE fechamentos SET cliente_id = cliente_id WHERE id = ANY($1::uuid[])", [[f.fL, f.fLeg]]);

    // Coerência com o pacote e imutabilidade (legado nunca é adotado).
    await recusa(db, INSERIR_FECHAMENTO_054, argsFechamento054(agenda, catA, null, eB), "054: fechamentos.empresa_id diverge");
    await recusa(db, INSERIR_FECHAMENTO_054, argsFechamento054(agenda, catA, null, null), "054: fechamentos.empresa_id diverge");
    await recusa(db, INSERIR_FECHAMENTO_054, argsFechamento054(agenda, catL, null, eA), "054: fechamentos.empresa_id diverge");
    await recusa(db, "UPDATE fechamentos SET empresa_id = $2::uuid WHERE id = $1::uuid", [f.fA, eB], "054:");
    await recusa(db, "UPDATE fechamentos SET empresa_id = $2::uuid WHERE id = $1::uuid", [f.fLeg, eA], "054:");
    await recusa(db, "UPDATE clientes SET empresa_id = $2::uuid WHERE id = $1::uuid", [c.cA, eB], "054: a empresa de clientes não muda");
    await recusa(db, "UPDATE clientes SET empresa_id = $2::uuid WHERE id = $1::uuid", [c.c0, eA], "054: a empresa de clientes não muda");

    // Revisão: só A/A; troca para B ou para NULL recusada; legado NULL/NULL recusado.
    const usuario = await usuarioDe(db);
    const base = await contratoDoFechamento(db, f.fA);
    const revisao = (cliente: string) => [f.fA, base.contrato, base.versaoNova, base.versaoBase, randomUUID(), usuario, cliente, agenda, catA.pacote, catA.tabela, catA.preco];
    await recusa(db, INSERIR_REVISAO, revisao(c.cB), REVISAO);
    await recusa(db, INSERIR_REVISAO, revisao(c.c0), REVISAO);
    const rA = await id(db, INSERIR_REVISAO, revisao(c.cA));
    await recusa(db, "UPDATE fechamento_revisoes SET cliente_id = $2::uuid WHERE id = $1::uuid", [rA, c.cB], REVISAO);
    await recusa(db, "UPDATE fechamento_revisoes SET cliente_id = $2::uuid WHERE id = $1::uuid", [rA, c.c0], REVISAO);
    await db.query("SAVEPOINT sem_troca");
    let semTroca = "passou";
    try {
      await db.query("UPDATE fechamento_revisoes SET cliente_id = cliente_id WHERE id = $1::uuid", [rA]);
    } catch (erro) {
      semTroca = texto(erro);
    }
    await db.query("ROLLBACK TO SAVEPOINT sem_troca");
    assert.equal(semTroca.includes("054:"), false, `revisão sem troca não é revalidada pela 054: ${semTroca}`);
    const baseLegado = await contratoDoFechamento(db, f.fLeg);
    await recusa(db, INSERIR_REVISAO, [f.fLeg, baseLegado.contrato, baseLegado.versaoNova, baseLegado.versaoBase, randomUUID(), usuario, c.cLeg, agenda, catL.pacote, catL.tabela, catL.preco], REVISAO);
  } finally {
    await db.query("ROLLBACK");
  }
}

/** O postcheck recusa a 054 ou uma guarda histórica degradada depois da instalação. */
async function postcheckDegradado(db: Client) {
  const casos: [string, string][] = [
    ["ALTER TABLE fechamentos DISABLE TRIGGER fechamentos_054_cliente_coerente_trg", "054 postcheck: gatilho ausente ou divergente"],
    ["DROP TRIGGER fechamento_revisoes_054_cliente_coerente_trg ON fechamento_revisoes", "054 postcheck: gatilho ausente ou divergente"],
    ["ALTER TABLE fechamentos DISABLE TRIGGER festa019_fechamento", "054: dependência ausente ou degradada: festa019_fechamento"],
    ["ALTER FUNCTION public.kidmais_054_empresa_imutavel() SECURITY DEFINER", "054 postcheck: funções da 054"],
    ["ALTER TABLE clientes ALTER COLUMN empresa_id SET DEFAULT gen_random_uuid()", "054 postcheck: coluna empresa_id ausente ou divergente"],
  ];
  await db.query("BEGIN");
  try {
    await db.query(ler(SQL.postcheck));
    for (const [degradar, trecho] of casos) {
      await db.query("SAVEPOINT pos");
      await db.query(degradar);
      await recusa(db, ler(SQL.postcheck), [], trecho);
      await db.query("ROLLBACK TO SAVEPOINT pos");
    }
  } finally {
    await db.query("ROLLBACK");
  }
}

/**
 * Serviços reais sobre o banco real: A→B recusado sem nenhuma consulta com lock e sem mudar o
 * xmax de linha do alvo; A→A autoriza sem lock e o primeiro lock é o tenant-scoped.
 */
async function locksAutorizacao(db: Client, fx: Fixtures) {
  const atual = { exec: null as any, tenant: fx.eA, usuario: randomUUID() };
  const s = servicos(atual);
  const ctx = () => ({ requestId: randomUUID(), ip: null, userAgent: null });
  const emTransacao = async (fn: (reg: Registro) => Promise<void>) => {
    await db.query("BEGIN");
    try {
      const reg = registrar(db);
      atual.exec = reg.exec;
      await fn(reg);
    } finally {
      await db.query("ROLLBACK");
    }
  };
  const semLock = (reg: Registro) => assert.deepEqual(reg.sql.filter((x) => LOCK.test(x.texto)).map((x) => x.texto), [], "nenhuma consulta com lock de qualquer modalidade");

  // Repositório real lendo a coluna gravada pela 054 (movido da suíte da 053, que roda num estado anterior à 054):
  // empresa A/B, legado → null, inexistente → undefined; a variante sem trava não emite lock.
  for (const nome of ["empresaDoFechamentoSemTrava", "empresaDoFechamentoComTrava"] as const) {
    await emTransacao(async (reg) => {
      for (const [f, fid] of Object.entries(fx.fechamentos)) assert.equal(await s.repositorio[nome](fid, reg.exec), fx.esperadoFechamento[f], `${nome}: ${f}`);
      assert.equal(await s.repositorio[nome](randomUUID(), reg.exec), undefined, `${nome}: inexistente`);
      if (nome === "empresaDoFechamentoSemTrava") semLock(reg);
    });
  }

  // operarContrato A→B, para cada payload; fechamento legado; versão inexistente.
  for (const [caso, payload] of PAYLOADS) {
    for (const [alvo, fechamento, cliente] of [["B", fx.fechamentos.fB, fx.clientes.cB], ["legado", fx.fechamentos.fLeg, fx.clientes.cLeg]] as const) {
      await emTransacao(async (reg) => {
        const k = await contratoMinimo(db, s.hash, fechamento, cliente);
        const linhas: [string, string][] = [["fechamentos", fechamento], ["contratos", k.contrato], ["contrato_versoes", k.versao]];
        const antes = await xmax(db, linhas);
        reg.sql.length = 0;
        await assert.rejects(s.contratos.operarContrato(k.versao, payload, "token", ctx(), fx.eA), (e: any) => e.message === "Versão não encontrada.", `${caso} (${alvo})`);
        semLock(reg);
        assert.deepEqual(await xmax(db, linhas), antes, `${caso} (${alvo}): nenhuma linha do alvo travada`);
        const leitura = reg.sql.find((x) => x.texto.includes("empresa_id::text AS empresa_id"));
        assert.ok(leitura, "a autorização leu a empresa do fechamento");
      });
    }
  }
  await emTransacao(async (reg) => {
    await assert.rejects(s.contratos.operarContrato(randomUUID(), PAYLOADS[0][1], "token", ctx(), fx.eA), (e: any) => e.message === "Versão não encontrada.");
    semLock(reg);
  });

  // GET da edição (versaoDoTenant) e revisão comercial A→B.
  await emTransacao(async (reg) => {
    const k = await contratoMinimo(db, s.hash, fx.fechamentos.fB, fx.clientes.cB);
    const linhas: [string, string][] = [["fechamentos", fx.fechamentos.fB], ["contrato_versoes", k.versao]];
    const antes = await xmax(db, linhas);
    reg.sql.length = 0;
    await assert.rejects(s.contratos.versaoDoTenant(reg.exec, k.versao, fx.eA), /Versão não encontrada/);
    await assert.rejects(s.comercial.obterRevisaoComercial(fx.fechamentos.fB, fx.eA, reg.exec), (e: any) => e.code === "FECHAMENTO_NAO_ENCONTRADO");
    await assert.rejects(s.comercial.revisarComercial(fx.fechamentos.fB, fx.eA, { solicitacaoId: randomUUID(), decisao: "RECUSAR", motivo: "Motivo 054" }, { usuarioId: atual.usuario, origem: "CRM_INTERNO" }, reg.exec),
      (e: any) => e.code === "FECHAMENTO_NAO_ENCONTRADO");
    const r = { id: randomUUID(), estado: "EM_ELABORACAO", contrato_versao_id: k.versao, fechamento_id: fx.fechamentos.fB, revisao: 1, conteudo_hash: "a".repeat(64),
      operacao: { clienteId: fx.clientes.cB, aniversarianteId: null } };
    await assert.rejects(s.operacional.editarPreparacao(reg.exec, r, { ...edicao, dataEvento: "2031-06-20" }, { usuarioId: atual.usuario, empresaAutorizada: fx.eA }), /empresa administrativa comprovada/);
    semLock(reg);
    assert.deepEqual(await xmax(db, linhas), antes);
  });

  // operarContrato A→A: autorização sem lock; primeiro lock tenant-scoped; depois contrato e versão.
  for (const [caso, payload] of [PAYLOADS[0], PAYLOADS[1], PAYLOADS[2], PAYLOADS[4]]) {
    await emTransacao(async (reg) => {
      const k = await contratoMinimo(db, s.hash, fx.fechamentos.fA, fx.clientes.cA);
      const linhas: [string, string][] = [["fechamentos", fx.fechamentos.fA], ["contratos", k.contrato], ["contrato_versoes", k.versao]];
      const antes = await xmax(db, linhas);
      reg.sql.length = 0;
      const erro: any = await chamar(db, () => s.contratos.operarContrato(k.versao, payload, "token", ctx(), fx.eA));
      assert.notEqual(codigoDe(erro), "40P01", `${caso}: sem deadlock`);
      assert.notEqual(erro?.message, "Versão não encontrada.", `${caso}: A→A autorizado`);
      const primeiro = reg.sql.findIndex((x) => LOCK.test(x.texto));
      assert(primeiro > 0, `${caso}: houve lock depois da autorização`);
      assert.equal(reg.sql[primeiro].texto, PRIMEIRO_LOCK_CONTRATO, `${caso}: primeiro lock tenant-scoped`);
      assert.deepEqual(reg.sql[primeiro].v, [fx.fechamentos.fA, fx.eA]);
      assert(reg.sql.slice(0, primeiro).some((x) => x.texto.includes("empresa_id::text AS empresa_id") && !LOCK.test(x.texto)), `${caso}: autorização sem lock antes`);
      const depois = await xmax(db, linhas);
      for (let i = 0; i < linhas.length; i++) assert.notEqual(depois[i], antes[i], `${caso}: ${linhas[i][0]} travado só depois da autorização`);
    });
  }

  // Revisão comercial A→A: leitura sem trava, depois FOR UPDATE e revalidação com FOR SHARE.
  await emTransacao(async (reg) => {
    const erro: any = await chamar(db, () => s.comercial.revisarComercial(fx.fechamentos.fA, fx.eA, { solicitacaoId: randomUUID(), decisao: "RECUSAR", motivo: "Motivo 054" }, { usuarioId: atual.usuario, origem: "CRM_INTERNO" }, reg.exec));
    assert.equal(erro?.code, "REVISAO_COMERCIAL_INVALIDA", `A→A autorizado e resultado de domínio esperado: ${erro?.code}`);
    const primeiro = reg.sql.findIndex((x) => LOCK.test(x.texto));
    assert(primeiro > 0);
    assert(reg.sql.slice(0, primeiro).some((x) => x.texto.includes("empresa_id::text AS empresa_id")));
    assert.match(reg.sql[primeiro].texto, /FOR UPDATE/);
    assert.match(reg.sql[primeiro + 1]?.texto ?? "", /empresa_id::text AS empresa_id[\s\S]*FOR SHARE/);
  });
}

/** Duas conexões sobre fechamentos confirmados: A→B não espera lock de B; mesmo tenant serializa sem deadlock. */
async function concorrencia(db: Client, fx: Fixtures) {
  const c1 = (await conectar054({ travar: false })) as unknown as Client;
  const c2 = (await conectar054({ travar: false })) as unknown as Client;
  const atual = { exec: null as any, tenant: fx.eA, usuario: randomUUID() };
  const s = servicos(atual);
  const { fA, fB } = fx.fechamentos;
  try {
    const pid2 = await pidDe(c2);

    // K1: B trava o próprio fechamento; A (lock_timeout curto) é recusado sem esperar nem travar.
    await c1.query("BEGIN");
    await c1.query("SELECT id FROM fechamentos WHERE id = $1::uuid FOR UPDATE", [fB]);
    await c2.query("BEGIN");
    await c2.query("SET LOCAL lock_timeout = '500ms'");
    atual.exec = registrar(c2).exec;
    await assert.rejects(s.comercial.obterRevisaoComercial(fB, fx.eA, atual.exec), (e: any) => e.code === "FECHAMENTO_NAO_ENCONTRADO");
    await c2.query("SAVEPOINT k1");
    await assert.rejects(s.comercial.revisarComercial(fB, fx.eA, { solicitacaoId: randomUUID(), decisao: "RECUSAR", motivo: "Motivo 054" }, { usuarioId: atual.usuario, origem: "CRM_INTERNO" }, atual.exec),
      (e: any) => e.code === "FECHAMENTO_NAO_ENCONTRADO");
    await c2.query("ROLLBACK TO SAVEPOINT k1");
    assert.equal(await s.repositorio.empresaDoFechamentoSemTrava(fB, atual.exec), fx.eB, "leitura de autorização não espera o lock de B");
    // Controle de sensibilidade: a variante com trava esperaria o lock de B (lock_timeout).
    await c2.query("SAVEPOINT controle");
    await assert.rejects(s.repositorio.empresaDoFechamentoComTrava(fB, atual.exec), (e: any) => codigoDe(e) === "55P03");
    await c2.query("ROLLBACK TO SAVEPOINT controle");
    await c2.query("ROLLBACK");
    await c1.query("ROLLBACK");

    // K2: duas sessões do mesmo tenant. A segunda autoriza sem lock e espera no primeiro lock de domínio.
    await c1.query("BEGIN");
    await c1.query(PRIMEIRO_LOCK_CONTRATO, [fA, fx.eA]);
    await c2.query("BEGIN");
    const reg2 = registrar(c2);
    atual.exec = reg2.exec;
    const segunda = s.comercial.revisarComercial(fA, fx.eA, { solicitacaoId: randomUUID(), decisao: "RECUSAR", motivo: "Motivo 054" }, { usuarioId: atual.usuario, origem: "CRM_INTERNO" }, reg2.exec)
      .then(() => "passou", (e: any) => `${codigoDe(e) ?? ""}:${texto(e)}`);
    await esperarBloqueio(db, pid2);
    // pg_stat_activity trunca o texto (track_activity_query_size); o statement em espera é o último
    // enviado pela conexão, conferido pelo registro real de SQL e pelo início do texto no servidor.
    const atividade = (await db.query<{ q: string; tipo: string | null }>("SELECT query AS q, wait_event_type AS tipo FROM pg_stat_activity WHERE pid = $1", [pid2])).rows[0];
    const emEspera = reg2.sql[reg2.sql.length - 1];
    assert.equal(atividade.tipo, "Lock", "a segunda sessão espera um lock");
    assert.equal(emEspera.texto.startsWith(atividade.q.slice(0, 200)), true, "o servidor executa o último statement registrado");
    assert.match(emEspera.texto, /FROM fechamentos\s+WHERE id = \$1::uuid\s+LIMIT 1\s+FOR UPDATE/, "espera no lock de domínio");
    assert.deepEqual(emEspera.v, [fA]);
    const antesDoLock = reg2.sql.slice(0, -1);
    assert(antesDoLock.some((x) => x.texto.includes("empresa_id::text AS empresa_id") && !LOCK.test(x.texto)), "a autorização já passou, sem lock");
    assert.deepEqual(antesDoLock.filter((x) => LOCK.test(x.texto)), [], "nenhum lock antes do lock de domínio");
    await c1.query("COMMIT");
    const resultado = await segunda;
    // Depois do lock liberado, só o resultado de domínio esperado (solicitação inexistente no fluxo);
    // timeout, conexão interrompida, erro SQL ou de programação falham aqui.
    assert.equal(resultado.split(":")[0], "REVISAO_COMERCIAL_INVALIDA", `resultado de domínio esperado: ${resultado}`);
    await c2.query("ROLLBACK");

    // K3: alteração concorrente relevante ao primeiro lock. Troca de empresa/cliente cruzado é recusada;
    // uma atualização legítima segura a linha e a sessão autorizada espera, depois revalida a mesma empresa.
    await c1.query("BEGIN");
    await assert.rejects(c1.query("UPDATE fechamentos SET empresa_id = $2::uuid WHERE id = $1::uuid", [fA, fx.eB]), /054:/);
    await c1.query("ROLLBACK");
    await c1.query("BEGIN");
    await assert.rejects(c1.query("UPDATE fechamentos SET cliente_id = $2::uuid WHERE id = $1::uuid", [fA, fx.clientes.cB]), /054: cliente e fechamento/);
    await c1.query("ROLLBACK");
    await c1.query("BEGIN");
    await c1.query("UPDATE fechamentos SET observacoes_equipe = observacoes_equipe WHERE id = $1::uuid", [fA]);
    await c2.query("BEGIN");
    const lock2 = c2.query(PRIMEIRO_LOCK_CONTRATO, [fA, fx.eA]).then((r) => r.rowCount, (e) => `${codigoDe(e)}:${texto(e)}`);
    await esperarBloqueio(db, pid2);
    await c1.query("ROLLBACK");
    assert.equal(await lock2, 1, "a sessão autorizada obtém o fechamento com a mesma empresa");
    await c2.query("ROLLBACK");

    // K4: as duas sessões travam na mesma ordem (tenant-scoped fA → fA2): uma espera, nenhuma entra em deadlock.
    const fA2 = fx.fechamentos.fA2;
    await c1.query("BEGIN");
    await c2.query("BEGIN");
    await c1.query(PRIMEIRO_LOCK_CONTRATO, [fA, fx.eA]);
    const ordem2 = (async () => {
      await c2.query(PRIMEIRO_LOCK_CONTRATO, [fA, fx.eA]);
      await c2.query(PRIMEIRO_LOCK_CONTRATO, [fA2, fx.eA]);
      return "ok";
    })().catch((e) => `${codigoDe(e)}:${texto(e)}`);
    await esperarBloqueio(db, pid2);
    await c1.query(PRIMEIRO_LOCK_CONTRATO, [fA2, fx.eA]);
    await c1.query("COMMIT");
    assert.equal(await ordem2, "ok", "sem deadlock na ordem comum");
    await c2.query("COMMIT");
  } finally {
    await c1.query("ROLLBACK").catch(() => {});
    await c2.query("ROLLBACK").catch(() => {});
    await encerrar054(c1, false);
    await encerrar054(c2, false);
  }
}

/** Dado com empresa não reconstruível: rollback precheck e down abortam; nada é removido. */
async function rollbackInseguro(db: Client, fx: Fixtures, reg: Registro054) {
  const inseguro = await clienteDe(db, "inseguro para o rollback", { empresa: fx.eA, reg }); // confirmado (autocommit)
  try {
    const pre = await arquivo(db, SQL.rollbackPrecheck);
    assert.ok(pre?.includes("054 rollback precheck: remover a 054 perderia empresa não reconstruível"), String(pre));
    const down = await arquivo(db, SQL.down);
    assert.ok(down?.includes("054 rollback: remover a 054 perderia empresa não reconstruível"), String(down));
    assert.equal(await instalada054(db), true, "a 054 continua instalada");
    assert.deepEqual(await objetos054(db), COM_054);
    assert.equal(await arquivo(db, SQL.postcheck), null, "instalação íntegra após o rollback recusado");
    const r = await db.query<{ e: string }>("SELECT empresa_id::text AS e FROM clientes WHERE id = $1::uuid", [inseguro]);
    assert.equal(r.rows[0]?.e, fx.eA, "o dado permanece");
  } finally {
    // Remoção imediata por id (a 054 precisa voltar a ter só dado reconstruível antes do down).
    await db.query("DELETE FROM clientes WHERE id = $1::uuid", [inseguro]);
    reg.ids.clientes = reg.ids.clientes.filter((x) => x !== inseguro);
  }
}
