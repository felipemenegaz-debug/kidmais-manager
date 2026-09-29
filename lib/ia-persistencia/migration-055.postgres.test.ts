import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";

/**
 * Harness PostgreSQL das migrations 055a–d e dos rollbacks (H8). ESCRITO, NÃO EXECUTADO.
 *
 * Só roda pelo `check:v1:postgres`, no cluster descartável (127.0.0.1, porta de `portaDescartavel()`, banco
 * kidmais_pacotes_v1_descartavel) e com KIDMAIS_POSTGRES_DESCARTAVEL definido. Nunca em staging/produção.
 * A execução depende de autorização explícita do Felipe (docs/OPERACAO_AGENTES.md).
 *
 * Roteiro (sempre com os SCRIPTS REAIS de up/down/checks):
 *  0. hash + contagem das tabelas do Core antes de tudo;
 *  1. ciclo limpo: up 055a→d + postchecks; reaplicação recusada (com ROLLBACK explícito depois);
 *     rollback precheck + down + verificação pós-rollback d→a;
 *  2. corrida "rollback primeiro": o down REAL da 055b roda numa transação que ainda não comitou (trava
 *     tomada); uma escrita concorrente espera e, depois do COMMIT do down, falha (tabela não existe);
 *  3. corrida "escrita primeiro" + recusas, cada uma com o down REAL:
 *     importação (055d), documento (055c), operação executada e rascunho válido (055b), reserva aberta e
 *     histórico sem descarte explícito (055a). Escrita com transação aberta ⇒ o down estoura o
 *     lock_timeout e nada muda; escrita comitada ⇒ a reconferência sob a trava recusa;
 *  4. descarte explícito do histórico da 055a (SET LOCAL na mesma transação do down);
 *  5. limpeza do descartável e hash do Core idêntico ao do passo 0.
 */
const ler = (f: string) => readFileSync(f, "utf8");
type Migracao = { id: string; tabela: string; up: string; down: string; post: string; pre: string; verificacao: string };
const MIGRACOES: Migracao[] = [
  ["a", "uso", "ia_orcamento_reservas"],
  ["b", "operacoes", "ia_operacoes"],
  ["c", "documentos", "ia_documentos"],
  ["d", "importacoes", "ia_importacoes"],
].map(([l, nome, tabela]) => ({
  id: `055${l}`,
  tabela,
  up: ler(`database/migrations/20260928_055${l}_inteligencia_${nome}.sql`),
  down: ler(`database/rollback/20260928_055${l}_inteligencia_${nome}_down.sql`),
  post: ler(`database/checks/20260928_055${l}_postcheck.sql`),
  pre: ler(`database/checks/20260928_055${l}_rollback_precheck.sql`),
  verificacao: ler(`database/checks/20260928_055${l}_rollback_postcheck.sql`),
}));
const m = (id: string) => MIGRACOES.find((x) => x.id === id)!;
const CORE = ["empresas", "usuarios_administrativos", "clientes", "fechamentos", "contratos", "pacotes", "precos_pacote", "tabelas_preco"];

async function existe(db: Client, tabela: string) {
  return (await db.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${tabela}`])).rows[0]?.ok === true;
}

/** Contagem + md5 de cada tabela do Core, em ordem determinística. */
async function retratoCore(db: Client) {
  const retrato: Record<string, string> = {};
  for (const tabela of CORE) {
    if (!await existe(db, tabela)) continue;
    const r = await db.query<{ n: string; h: string | null }>(`SELECT count(*)::text AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS h FROM public.${tabela} t`);
    retrato[tabela] = `${r.rows[0].n}:${r.rows[0].h ?? "-"}`;
  }
  return retrato;
}

/** Falha esperada: confere a mensagem e SEMPRE encerra a transação abortada com ROLLBACK explícito. */
async function recusa(db: Client, sql: string, motivo: RegExp) {
  await assert.rejects(db.query(sql), motivo);
  await db.query("ROLLBACK");
}

async function fixture(db: Client) {
  const empresa = (await db.query<{ id: string }>(`SELECT id FROM empresas ORDER BY criado_em LIMIT 1`)).rows[0]?.id;
  const usuario = (await db.query<{ id: string }>(`SELECT id FROM usuarios_administrativos ORDER BY criado_em LIMIT 1`)).rows[0]?.id;
  assert.ok(empresa && usuario, "o banco descartável precisa ter empresa e usuário de fixture");
  return { empresa, usuario };
}

const inserir = {
  reserva: (empresa: string, estado = "ABERTA") => [
    `INSERT INTO ia_orcamento_reservas (id, empresa_id, capacidade, correlation_id, tokens_reservados, estado, criado_em, encerrado_em, periodo_dia, periodo_mes)
     VALUES ($1, $2, 'x', 'harness', 10, $3::varchar, now(), CASE WHEN $3::varchar = 'ABERTA' THEN NULL ELSE now() END, CURRENT_DATE, to_char(CURRENT_DATE, 'YYYY-MM'))`,
    [randomUUID(), empresa, estado],
  ] as const,
  operacao: (empresa: string, usuario: string, estado: "EXECUTADA" | "COLETANDO") => [
    `INSERT INTO ia_operacoes (id, empresa_id, usuario_id, correlation_id, idempotency_key, capacidade, ferramenta, estado, versao, payload, payload_hash, resultado, expira_em)
     VALUES ($1, $2, $3, 'harness', $1, 'criar_pacote', 'pacotes.criar', $4::varchar, 1, '{}'::jsonb, '', CASE WHEN $4::varchar = 'EXECUTADA' THEN '{"ok":true}'::jsonb END, now() + interval '1 hour')`,
    [randomUUID(), empresa, usuario, estado],
  ] as const,
  documento: (empresa: string, usuario: string) => [
    `INSERT INTO ia_documentos (empresa_id, tipo, status, enviado_por) VALUES ($1, 'CONTRATO_HISTORICO', 'RECEBIDO', $2) RETURNING id`,
    [empresa, usuario],
  ] as const,
};

/** Remoção só para devolver o DESCARTÁVEL ao estado inicial (não é o rollback sob teste). */
async function limparDescartavel(db: Client) {
  for (const sql of [
    "DROP TABLE IF EXISTS ia_importacoes", "DROP FUNCTION IF EXISTS kidmais_055_importacao_guarda()",
    "DROP TABLE IF EXISTS ia_evidencias", "DROP TABLE IF EXISTS ia_extracoes", "DROP TABLE IF EXISTS ia_documento_originais",
    "DROP TABLE IF EXISTS ia_documentos", "DROP FUNCTION IF EXISTS kidmais_055_documento_guarda()",
    "DROP VIEW IF EXISTS ia_operacoes_resumo", "DROP TABLE IF EXISTS ia_operacoes", "DROP FUNCTION IF EXISTS kidmais_055_operacao_guarda()",
    "DROP VIEW IF EXISTS ia_uso_diario", "DROP TABLE IF EXISTS ia_uso_modelo", "DROP TABLE IF EXISTS ia_orcamento_reservas",
    "DROP FUNCTION IF EXISTS kidmais_055a_reserva_guarda()", "DROP FUNCTION IF EXISTS kidmais_055_somente_insercao()",
  ]) await db.query(sql);
}

/**
 * Escrita primeiro: B abre transação e escreve; o down REAL (sessão A) estoura o lock_timeout e nada
 * muda. B comita; o down REAL, agora com a trava, reconfere e recusa.
 */
async function corridaEscritaPrimeiro(a: Client, b: Client, alvo: Migracao, escrever: () => Promise<unknown>, recusaEsperada: RegExp) {
  await b.query("BEGIN");
  await escrever();
  await recusa(a, alvo.down, /lock timeout|canceling statement due to lock timeout/i);
  assert.equal(await existe(a, alvo.tabela), true, `${alvo.id}: nada removido com escrita em andamento`);
  await b.query("COMMIT");
  await recusa(a, alvo.down, recusaEsperada);
  assert.equal(await existe(a, alvo.tabela), true, `${alvo.id}: reconferência sob a trava recusou`);
  await assert.rejects(a.query(alvo.pre), /remoção insegura|ainda existe/);
  await a.query("ROLLBACK").catch(() => undefined);
}

test("055a–d: ciclo completo, corridas nas duas ordens e recusas, com scripts reais e Core intacto", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const a = await conectarDescartavel();
  const b = await conectarDescartavel({ travar: false });
  try {
    for (const x of MIGRACOES) if (await existe(a, x.tabela)) throw new Error(`${x.id} já existe no descartável: recrie o banco antes do harness`);
    const coreAntes = await retratoCore(a);
    const { empresa, usuario } = await fixture(a);

    // 1. Ciclo limpo a→d e d→a.
    for (const x of MIGRACOES) {
      await a.query(x.up);
      await a.query(x.post);
      await recusa(a, x.up, /já aplicada/);
    }
    for (const x of [...MIGRACOES].reverse()) {
      await a.query(x.pre);
      await a.query(x.down);
      await a.query(x.verificacao);
    }
    for (const x of MIGRACOES) assert.equal(await existe(a, x.tabela), false, `${x.id} removida`);

    // 2. Rollback primeiro (055b): o down REAL segura a trava sem comitar; a escrita concorrente espera e falha.
    for (const x of MIGRACOES) await a.query(x.up);
    await a.query("BEGIN");
    await a.query(semTransacaoExplicita(m("055b").down));
    const [sqlOp, valoresOp] = inserir.operacao(empresa, usuario, "COLETANDO");
    const concorrente = b.query(sqlOp, [...valoresOp]).then(() => "inseriu", (e: Error) => e.message);
    await new Promise((ok) => setTimeout(ok, 200));
    await a.query("COMMIT");
    assert.match(await concorrente, /does not exist|não existe|could not open relation/i, "a escrita concorrente não sobrevive ao rollback");
    await b.query("ROLLBACK").catch(() => undefined);
    await a.query(m("055b").verificacao);
    await a.query(m("055b").up);

    // 3. Escrita primeiro + recusas, com o down REAL de cada migration.
    const docId = async (db: Client) => { const [s, v] = inserir.documento(empresa, usuario); return (await db.query<{ id: string }>(s, [...v])).rows[0].id; };
    // 055d: importação (precisa de documento, original e extração comitados antes).
    const documento = await docId(a);
    const original = (await a.query<{ id: string }>(
      `INSERT INTO ia_documento_originais (documento_id, empresa_id, versao, nome_original, content_type, tamanho_bytes, sha256, conteudo, enviado_por)
       VALUES ($1, $2, 1, 'h.pdf', 'application/pdf', 1, encode(sha256('\\x25'::bytea), 'hex'), '\\x25'::bytea, $3) RETURNING id`, [documento, empresa, usuario])).rows[0].id;
    const extracao = (await a.query<{ id: string }>(
      `INSERT INTO ia_extracoes (documento_id, empresa_id, original_id, metodo, schema_versao, status, correlation_id, iniciado_em, concluido_em)
       VALUES ($1, $2, $3, 'DETERMINISTICO', 1, 'PARCIAL', 'harness', now(), now()) RETURNING id`, [documento, empresa, original])).rows[0].id;
    await corridaEscritaPrimeiro(a, b, m("055d"), () => b.query(
      `INSERT INTO ia_importacoes (documento_id, empresa_id, extracao_id, status, versao, dados, criado_por) VALUES ($1, $2, $3, 'EM_REVISAO', 1, '{}'::jsonb, $4)`,
      [documento, empresa, extracao, usuario]), /há importações registradas/);
    // 055c: documento (a 055d precisa sair antes; o ciclo usa a limpeza do descartável para isso).
    await a.query("DROP TABLE ia_importacoes; DROP FUNCTION kidmais_055_importacao_guarda();");
    await corridaEscritaPrimeiro(a, b, m("055c"), () => docId(b), /há documentos registrados/);
    // 055b: operação executada e, noutra rodada, rascunho ainda válido.
    const [sqlExec, valoresExec] = inserir.operacao(empresa, usuario, "EXECUTADA");
    await corridaEscritaPrimeiro(a, b, m("055b"), () => b.query(sqlExec, [...valoresExec]), /há operações executadas/);
    await a.query("DROP VIEW ia_operacoes_resumo; DROP TABLE ia_operacoes; DROP FUNCTION kidmais_055_operacao_guarda();");
    await a.query(m("055b").up);
    const [sqlRasc, valoresRasc] = inserir.operacao(empresa, usuario, "COLETANDO");
    await corridaEscritaPrimeiro(a, b, m("055b"), () => b.query(sqlRasc, [...valoresRasc]), /há rascunho ainda válido/);
    // 055a: dependente (055c) ainda instalado ⇒ recusa antes de tudo.
    await recusa(a, m("055a").down, /remova antes a 055c/);
    // Tira c e d do caminho (limpeza do descartável) para exercitar a 055a sozinha.
    await a.query("DROP TABLE ia_evidencias; DROP TABLE ia_extracoes; DROP TABLE ia_documento_originais; DROP TABLE ia_documentos; DROP FUNCTION kidmais_055_documento_guarda();");
    const [sqlRes, valoresRes] = inserir.reserva(empresa);
    await corridaEscritaPrimeiro(a, b, m("055a"), () => b.query(sqlRes, [...valoresRes]), /reserva de orçamento aberta/);

    // 4. Reserva vira órfã (encerrada): sem descarte explícito, recusa; com SET LOCAL na mesma transação, remove.
    await a.query(`UPDATE ia_orcamento_reservas SET estado = 'ORFA', encerrado_em = now() WHERE estado = 'ABERTA'`);
    await recusa(a, m("055a").down, /há histórico de uso/);
    await a.query("BEGIN");
    await a.query("SET LOCAL kidmais.rollback_055a_descartar_uso = 'sim'");
    await a.query(semTransacaoExplicita(m("055a").down));
    await a.query("COMMIT");
    await a.query(m("055a").verificacao);

    // 5. Limpeza e Core intacto.
    await limparDescartavel(a);
    for (const x of MIGRACOES) assert.equal(await existe(a, x.tabela), false);
    assert.deepEqual(await retratoCore(a), coreAntes, "nenhuma linha do Core mudou");
  } finally {
    await limparDescartavel(a).catch(() => undefined);
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(a);
  }
});
