import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, dia, executor, id, poolNaTransacao,
  type Cenario,
} from "../../../scripts/integracao-importados-test-support.ts";
import { travarConfiguracaoAgenda } from "../../agenda/trava-configuracao.ts";

/**
 * 126 (escopo OAuth `clientes:read` do MCP, etapa 0b) no PostgreSQL DESCARTÁVEL recriado do modelo 126.
 *
 * Migration: precheck e up repetido recusam com a 126 instalada sem alterar nada; down COMMITA (sem linhas com
 * clientes:read), o CHECK volta ao da 105 e o precheck passa; up de novo reproduz o MESMO catálogo e o postcheck passa.
 * O CHECK novo aceita `clientes:read` e até 4 escopos, recusa escopo desconhecido e 5 escopos; sem a 126 a linha com
 * `clientes:read` é recusada (23514). O down RECUSA com qualquer linha (pedido, concessão ou token) com clientes:read.
 *
 * Leitores da 0b (lib/festas/resumo-tenant.ts) contra o schema real: busca SÓ no nome exibível (sem acento, sem caixa,
 * acento decomposto e espaços duplos), termo que só existe no contato/dígitos não acha nada, coringa do LIKE nunca lista
 * tudo, filtro por data, aniversariante de outro cliente/empresa ignorado, isolamento entre empresas (o id da festa de A
 * nunca vale em B), capacidade FESTA_CONSULTAR por membership e contagens. Tudo em transação desfeita (ROLLBACK).
 *
 * r2: com o opt-in do PG descartável, o modelo PRECISA ter a 126 inteira (3 CHECKs exatos e validados); sem ela a suíte
 * falha no before, em vez de pular os casos.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
const UP = readFileSync("database/migrations/20261118_126_mcp_escopo_clientes.sql", "utf8");
const DOWN = readFileSync("database/rollback/20261118_126_mcp_escopo_clientes_down.sql", "utf8");
const PRE = readFileSync("database/checks/20261118_126_precheck.sql", "utf8");
const POS = readFileSync("database/checks/20261118_126_postcheck.sql", "utf8");
const semTransacao = (sql: string) => sql.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");

let a: Client;
test.before(async () => {
  if (!opt()) return;
  process.env.FESTA_ENABLED = "true";
  a = await conectarDescartavel();
  // r3 (P2 #9): o próprio postcheck da 126 (definição EXATA nas 3 tabelas), não um fragmento da definição.
  try {
    await a.query(POS);
  } catch (e) {
    await a.query("ROLLBACK").catch(() => undefined);
    throw new Error(`PG descartável sem a 126 exata: recrie o modelo 126 (preparar) antes de rodar esta suíte. ${(e as Error).message}`);
  }
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

async function catalogo() {
  const q = async (sql: string) => (await a.query<{ x: string }>(sql)).rows.map((r) => r.x);
  return {
    tabelas: await q(`SELECT c.relname || ':' || c.relkind::text AS x FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','S','p') ORDER BY 1`),
    colunas: await q(`SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS x FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`),
    constraints: await q(`SELECT conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) || ':' || convalidated AS x FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`),
    gatilhos: await q(`SELECT tgrelid::regclass::text || '.' || tgname || ':' || tgenabled::text || ':' || pg_get_triggerdef(oid) AS x FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
    indices: await q(`SELECT indexdef AS x FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`),
    funcoes: await q(`SELECT p.oid::regprocedure::text || ':' || md5(replace(prosrc, chr(13), '')) AS x FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`),
  };
}
async function recusaScript(sql: string, re: RegExp, rotulo: string) {
  await assert.rejects(a.query(sql), (e) => re.test((e as Error).message), rotulo);
  await a.query("ROLLBACK");
}
async function recusaEmTx(preparo: string, sql: string, re: RegExp, rotulo: string) {
  await a.query("BEGIN");
  try {
    await a.query(preparo);
    await assert.rejects(a.query(semTransacao(sql)), (e) => re.test((e as Error).message), rotulo);
  } finally { await a.query("ROLLBACK"); }
}
async function recusaSql(sql: string, params: unknown[], re: RegExp, rotulo: string) {
  await a.query("SAVEPOINT trava");
  await assert.rejects(a.query(sql, params), (e) => re.test(`${(e as { code?: string }).code ?? ""} ${(e as Error).message}`), rotulo);
  await a.query("ROLLBACK TO SAVEPOINT trava");
}

const CLIENTE_OAUTH = "https://assistente.example.test/cimd.json";
const CHALLENGE = "a".repeat(43);
async function clienteOauth() {
  await a.query(`INSERT INTO mcp_oauth_clientes (client_id, nome, redirect_uris, valido_ate) VALUES ($1, 'Assistente sintético', ARRAY['https://assistente.example.test/cb'], now() + interval '1 day')
                 ON CONFLICT (client_id) DO NOTHING`, [CLIENTE_OAUTH]);
}
const pedido = (escopos: string[]) => a.query(
  `INSERT INTO mcp_oauth_pedidos (chave_hash, client_id, cliente_nome, redirect_uri, code_challenge, escopos, recurso, expira_em)
   VALUES ($1, $2, 'Assistente sintético', 'https://assistente.example.test/cb', $3, $4::text[], 'https://ia.fest.test/api/mcp', now() + interval '5 minutes')`,
  [randomBytes(32).toString("hex"), CLIENTE_OAUTH, CHALLENGE, escopos]);

test("126: ciclo — precheck e up repetido recusam; down → precheck passa → up reproduz o mesmo catálogo → postcheck passa", { skip: !opt(), timeout: 300_000 }, async () => {
  const original = await catalogo();
  const cheques = original.constraints.filter((c) => /mcp_oauth_(pedidos|concessoes|tokens)_escopos_check/.test(c));
  assert.equal(cheques.length, 3);
  for (const c of cheques) assert.match(c, /cardinality\(escopos\) <= 4.*'clientes:read'::text.*:true$/);

  await a.query(POS);
  await recusaScript(PRE, /126 precheck: CHECK de escopos fora do formato da 105/, "precheck com a 126 instalada");
  await recusaScript(UP, /126: já \(parcialmente\) aplicada/, "up repetido");
  assert.deepEqual(await catalogo(), original, "o up recusado não altera nada");

  await a.query(DOWN);
  const sem = await catalogo();
  assert.equal(sem.constraints.some((c) => c.includes("clientes:read")), false, "o CHECK volta ao da 105");
  assert.deepEqual(sem.tabelas, original.tabelas, "a 126 não cria nem remove tabela");
  assert.deepEqual(sem.colunas, original.colunas, "a 126 não muda coluna");
  assert.deepEqual(sem.indices, original.indices, "a 126 não muda índice");
  assert.deepEqual(sem.gatilhos, original.gatilhos, "a 126 não muda gatilho");
  assert.deepEqual(sem.funcoes, original.funcoes, "a 126 não muda função");
  await a.query(PRE);
  await recusaScript(DOWN, /126 down: a 126 não está aplicada inteira/, "down sem a 126 instalada");
  await recusaScript(POS, /126 postcheck: CHECK de escopos fora do formato da 126/, "postcheck sem a 126");
  assert.deepEqual(await catalogo(), sem, "o down recusado não altera nada");

  await a.query(UP);
  await a.query(POS);
  assert.deepEqual(await catalogo(), original, "up/down/up: o catálogo volta idêntico");
});

test("126: o CHECK aceita clientes:read e até 4 escopos, recusa desconhecido e 5; sem a 126, clientes:read é recusado; down recusa com dados", { skip: !opt(), timeout: 300_000 }, async () => {
  await a.query("BEGIN");
  try {
    await clienteOauth();
    await pedido(["clientes:read"]);
    await pedido(["agenda:read", "financeiro:read", "conhecimento:read", "clientes:read"]);
    await recusaSql(`INSERT INTO mcp_oauth_pedidos (chave_hash, client_id, cliente_nome, redirect_uri, code_challenge, escopos, recurso, expira_em)
      VALUES ($1, $2, 'x', 'https://assistente.example.test/cb', $3, ARRAY['agenda:read','financeiro:read','conhecimento:read','clientes:read','agenda:read'], 'r', now() + interval '5 minutes')`,
      [randomBytes(32).toString("hex"), CLIENTE_OAUTH, CHALLENGE], /23514/, "5 escopos");
    await recusaSql(`INSERT INTO mcp_oauth_pedidos (chave_hash, client_id, cliente_nome, redirect_uri, code_challenge, escopos, recurso, expira_em)
      VALUES ($1, $2, 'x', 'https://assistente.example.test/cb', $3, ARRAY['clientes:write'], 'r', now() + interval '5 minutes')`,
      [randomBytes(32).toString("hex"), CLIENTE_OAUTH, CHALLENGE], /23514/, "escopo desconhecido");
    // Com linha de clientes:read, o down recusa e não altera nada (a mensagem é a da trava de dados).
    await a.query("SAVEPOINT down");
    await assert.rejects(a.query(semTransacao(DOWN)), /126 down: há linhas com clientes:read; nada foi alterado/);
    await a.query("ROLLBACK TO SAVEPOINT down");
    assert.equal((await a.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE pg_get_constraintdef(oid) LIKE '%clientes:read%'`)).rows[0].n, 3);
  } finally { await a.query("ROLLBACK"); }

  // Sem a 126 (down na transação), a mesma linha é recusada pelo CHECK da 105.
  await a.query("BEGIN");
  try {
    await a.query(semTransacao(DOWN));
    await clienteOauth();
    await pedido(["agenda:read", "financeiro:read", "conhecimento:read"]);
    await recusaSql(`INSERT INTO mcp_oauth_pedidos (chave_hash, client_id, cliente_nome, redirect_uri, code_challenge, escopos, recurso, expira_em)
      VALUES ($1, $2, 'x', 'https://assistente.example.test/cb', $3, ARRAY['clientes:read'], 'r', now() + interval '5 minutes')`,
      [randomBytes(32).toString("hex"), CLIENTE_OAUTH, CHALLENGE], /23514/, "clientes:read sem a 126");
  } finally { await a.query("ROLLBACK"); }
  await a.query(POS);
});

test("126: precheck e up recusam sem a 105 e com CHECK fora do formato; tudo em ROLLBACK", { skip: !opt(), timeout: 300_000 }, async () => {
  const down = semTransacao(DOWN);
  await recusaEmTx(`${down}; ALTER TABLE public.mcp_oauth_tokens RENAME TO mcp_oauth_tokens_x;`, PRE, /126 precheck: exige a 105/, "precheck sem a 105");
  await recusaEmTx(`${down}; ALTER TABLE public.mcp_oauth_tokens RENAME TO mcp_oauth_tokens_x;`, UP, /126: exige a 105/, "up sem a 105");
  const adulterar = `${down}; ALTER TABLE public.mcp_oauth_pedidos DROP CONSTRAINT mcp_oauth_pedidos_escopos_check;
    ALTER TABLE public.mcp_oauth_pedidos ADD CONSTRAINT mcp_oauth_pedidos_escopos_check CHECK (cardinality(escopos) BETWEEN 1 AND 3);`;
  await recusaEmTx(adulterar, PRE, /126 precheck: CHECK de escopos fora do formato da 105/, "precheck com CHECK adulterado");
  await recusaEmTx(adulterar, UP, /126: CHECK de escopos fora do formato da 105/, "up com CHECK adulterado");
  // Instalação parcial: só uma tabela com o CHECK novo → up recusa como já (parcialmente) aplicada; down recusa.
  const parcial = `${down}; ALTER TABLE public.mcp_oauth_tokens DROP CONSTRAINT mcp_oauth_tokens_escopos_check;
    ALTER TABLE public.mcp_oauth_tokens ADD CONSTRAINT mcp_oauth_tokens_escopos_check CHECK (cardinality(escopos) BETWEEN 1 AND 4 AND escopos <@ ARRAY['agenda:read','financeiro:read','conhecimento:read','clientes:read']);`;
  await recusaEmTx(parcial, UP, /126: já \(parcialmente\) aplicada/, "up com 126 parcial");
  await recusaEmTx(parcial, DOWN, /126 down: a 126 não está aplicada inteira/, "down com 126 parcial");
  // r2: CHECK da 105 com o mesmo nome mas NOT VALID → precheck e up recusam (definição exata E validada).
  const naoValidado = `${down}; ALTER TABLE public.mcp_oauth_tokens DROP CONSTRAINT mcp_oauth_tokens_escopos_check;
    ALTER TABLE public.mcp_oauth_tokens ADD CONSTRAINT mcp_oauth_tokens_escopos_check CHECK (cardinality(escopos) BETWEEN 1 AND 3 AND escopos <@ ARRAY['agenda:read','financeiro:read','conhecimento:read']) NOT VALID;`;
  await recusaEmTx(naoValidado, PRE, /126 precheck: CHECK de escopos fora do formato da 105/, "precheck com CHECK NOT VALID");
  await recusaEmTx(naoValidado, UP, /126: CHECK de escopos fora do formato da 105/, "up com CHECK NOT VALID");
  // r2: CHECK divergente que CONTÉM clientes:read (não é o da 126) → up não sobrescreve; down não desfaz.
  const divergente = `ALTER TABLE public.mcp_oauth_concessoes DROP CONSTRAINT mcp_oauth_concessoes_escopos_check;
    ALTER TABLE public.mcp_oauth_concessoes ADD CONSTRAINT mcp_oauth_concessoes_escopos_check CHECK (cardinality(escopos) BETWEEN 1 AND 9 AND escopos <@ ARRAY['agenda:read','financeiro:read','conhecimento:read','clientes:read','clientes:write']);`;
  await recusaEmTx(`${down}; ${divergente}`, UP, /126: CHECK de escopos fora do formato da 105/, "up com CHECK divergente que contém clientes:read");
  await recusaEmTx(divergente, DOWN, /126 down: a 126 não está aplicada inteira/, "down com CHECK divergente");
  await recusaEmTx(divergente, POS, /126 postcheck: CHECK de escopos fora do formato da 126/, "postcheck com CHECK divergente");
  await a.query(POS);
});

// ---------------------------------------------------------------------------------------------------------------------
// Leitores da 0b contra o schema real (modelo 126 = estado do staging com a 125).
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
const MODELO = {
  titulo: "Contrato", contratada: { nome: "Buffet Teste Ltda", documento: "12.345.678/0001-90", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
  preambulo: [], observacoes: [], cidadeAssinatura: "Cidade Teste",
  clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} das {{festa.inicio}} às {{festa.fim}} ({{festa.pacote}}), {{festa.convidados}} convidados, {{valor.total}}, {{pagamento.condicao}}. {{contratante.tipo_documento}} {{contratante.documento}}." }],
};
const nativos = new Map<string, Awaited<ReturnType<typeof catalogoNativo>>>();
type Festa = { c: Cenario; festaId: string; contratoId: string; data: string };

/** Contrato assinado pelos dois lados (a festa nasce na formalização), com os nomes dados. */
async function festa(c: Cenario, diasAteFesta: number, cliente: string, aniversariante: string): Promise<Festa> {
  let nativo = nativos.get(c.empresa);
  if (!nativo) {
    nativo = await catalogoNativo(a, c);
    nativos.set(c.empresa, nativo);
    await travarConfiguracaoAgenda(executor(a), c.empresa, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
  }
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por)
                 SELECT $1::uuid, 1, $2::jsonb, $3, $4::uuid WHERE NOT EXISTS (SELECT 1 FROM modelos_contrato_empresa WHERE empresa_id = $1::uuid)`,
    [c.empresa, JSON.stringify(MODELO), "a".repeat(64), c.usuario]);
  const cpf = cpfValido();
  const clienteId = await id(a,
    `INSERT INTO clientes (nome_completo, cpf, empresa_id, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
     VALUES ($4, $1, $2::uuid, $3, '11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`,
    [cpf, c.empresa, `${randomUUID()}@example.invalid`, cliente]);
  const aniv = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, $2) RETURNING id`, [clienteId, aniversariante]);
  const data = dia(diasAteFesta);
  const fechamento = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 30, 30, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO'
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
    [data, nativo.turno, c.empresa, c.pacote, clienteId, aniv]);
  const contratos = carregar<typeof import("../../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
  const gerado = await contratos.gerarContrato({ fechamentoId: fechamento } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
  const adm = carregar<typeof import("../../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  await congelarEAssinarKidmais(a, adm.operarContrato as unknown as Operar, gerado.versao.id, c.empresa, c.token, nativo.tokenRepresentante);
  await assinarComoCliente(gerado.contrato.id, cpf);
  const festaId = (await a.query<{ id: string }>("SELECT id::text AS id FROM festas WHERE contrato_id = $1::uuid", [gerado.contrato.id])).rows[0]?.id;
  assert.ok(festaId, "a festa nasce na formalização");
  return { c, festaId, contratoId: gerado.contrato.id, data };
}

const leitor = () => carregar<typeof import("../../festas/resumo-tenant.ts")>("lib/festas/resumo-tenant.ts");

test("0b leitores: busca por nome sem acento, data, coringa como texto, isolamento A/B, capacidade e contagens", { skip: !opt(), timeout: 600_000 }, async () => {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const A = await cenario(a, 0);
    const B = await cenario(a, 0);
    const alice = await festa(A, 40, "Mário Sintético", "Alíce Sintética");
    const bento = await festa(A, 70, "Rafaela 50%_Prado", "Bento Sintético");
    // Cliente com telefone no campo de nome; aniversariante com acento DECOMPOSTO (NFD) e espaços duplos.
    const lucia = await festa(A, 55, "Carla tel 11 98888-7777", "Lu\u0301cia  Sintética");
    const deB = await festa(B, 40, "Cliente Secreto B", "Alice da Empresa B");
    const hoje = dia(0);
    const ler = leitor();
    const tx = executor(a);
    const buscar = async (empresa: string, nome: string, data: string | null, limite = 11) => {
      const r = await ler.festasPorNome(tx, empresa, nome, data, hoje, limite);
      assert.equal(r.incompleto, false);
      return r.festas;
    };
    const ids = async (empresa: string, nome: string, data: string | null = null) => (await buscar(empresa, nome, data)).map((f) => f.festaId);

    // Sem acento e sem caixa, pelo aniversariante ou pelo cliente; só a empresa comprovada.
    const porAlice = await buscar(A.empresa, "ALICE", null);
    assert.deepEqual(porAlice.map((f) => f.festaId), [alice.festaId]);
    assert.equal(porAlice[0].aniversariante, "Alíce Sintética");
    assert.equal(porAlice[0].cliente, "Mário Sintético");
    assert.equal(porAlice[0].data, alice.data);
    assert.equal(porAlice[0].horaInicio, "10:00");
    assert.equal(porAlice[0].convidados, 30);
    assert.deepEqual(Object.keys(porAlice[0]).sort(), ["aniversariante", "cliente", "contratoId", "contratoStatus", "convidados", "data", "festaId", "horaFim", "horaInicio"]);
    assert.deepEqual(await ids(A.empresa, "mario"), [alice.festaId]);
    assert.deepEqual(await ids(B.empresa, "alice"), [deB.festaId], "B só vê a festa de B");
    assert.equal((await buscar(B.empresa, "Sintética", null)).length, 0, "nomes de A nunca aparecem em B");

    // Várias, ordenadas da mais próxima; limite respeitado; filtro por data.
    assert.deepEqual(await ids(A.empresa, "sintetic"), [alice.festaId, lucia.festaId, bento.festaId]);
    assert.equal((await buscar(A.empresa, "sintetic", null, 1)).length, 1);
    assert.deepEqual(await ids(A.empresa, "sintetic", bento.data), [bento.festaId]);

    // r2 (P1 #2/#3, P3 #10): nome não exibível sai null e NÃO é usado na busca; acento decomposto e espaços duplos casam.
    const porLucia = await buscar(A.empresa, "lucia sintetica", null);
    assert.deepEqual(porLucia.map((f) => f.festaId), [lucia.festaId], "NFD + espaços duplos no banco casam com o termo simples");
    assert.equal(porLucia[0].aniversariante, "Lúcia Sintética", "sai NFC e com espaços colapsados");
    assert.equal(porLucia[0].cliente, null, "cliente com telefone no nome sai omitido");
    assert.deepEqual(await ids(A.empresa, "LÚCIA"), [lucia.festaId]);
    for (const termo of ["98888", "98888-7777", "tel", "carla", "carla tel", "rafaela", "prado", "50%_pr", "%", "a_i", "_", "%%"]) {
      assert.deepEqual(await ids(A.empresa, termo), [], `termo só na parte omitida (ou coringa) não acha nada: ${termo}`);
    }
    const porBento = await buscar(A.empresa, "bento", null);
    assert.equal(porBento[0].cliente, null, "cliente com dígitos e % sai omitido");

    // Contrato cancelado sai da busca.
    // Os gatilhos adiados das festas criadas acima precisam disparar antes do ALTER TABLE (55006 com eventos pendentes).
    await a.query("SET CONSTRAINTS ALL IMMEDIATE");
    await a.query("SAVEPOINT cancelado");
    try {
      await a.query("ALTER TABLE contratos DISABLE TRIGGER USER");
      await a.query("UPDATE contratos SET status = 'CANCELADO', cancelado_em = now() WHERE id = $1::uuid", [bento.contratoId]);
      assert.equal((await buscar(A.empresa, "bento", null)).length, 0, "cancelada fica fora");
    } finally { await a.query("ROLLBACK TO SAVEPOINT cancelado"); }

    // r2 (P1 #1): fechamento de A apontando para o aniversariante de um cliente de B. O nome de B nunca sai nem acha.
    await a.query("SAVEPOINT cruzaniv");
    try {
      await a.query("ALTER TABLE fechamentos DISABLE TRIGGER USER");
      await a.query(`UPDATE fechamentos SET aniversariante_id = (SELECT f.aniversariante_id FROM fechamentos f JOIN contratos c ON c.fechamento_id = f.id WHERE c.id = $2::uuid)
                       WHERE id = (SELECT fechamento_id FROM contratos WHERE id = $1::uuid)`, [alice.contratoId, deB.contratoId]);
      assert.deepEqual(await ids(A.empresa, "empresa b"), [], "o aniversariante de B não é achado pela empresa A");
      const semAniv = await buscar(A.empresa, "mario", null);
      assert.deepEqual(semAniv.map((f) => f.festaId), [alice.festaId]);
      assert.equal(semAniv[0].aniversariante, null, "aniversariante de outro cliente não sai");
    } finally { await a.query("ROLLBACK TO SAVEPOINT cruzaniv"); }

    // r3 (P3 #10): sem lower() do banco, a collation não muda o resultado (Æ/æ casam pela forma do JavaScript).
    // r3 (P1 #2): endereço por extenso no nome do cliente sai omitido e não é usado na busca.
    await a.query("SAVEPOINT nomesr3");
    try {
      await a.query("ALTER TABLE aniversariantes DISABLE TRIGGER USER");
      await a.query("ALTER TABLE clientes DISABLE TRIGGER USER");
      const fech = "(SELECT fechamento_id FROM contratos WHERE id = $1::uuid)";
      await a.query(`UPDATE aniversariantes SET nome = 'Ægide Sintética' WHERE id = (SELECT aniversariante_id FROM fechamentos WHERE id = ${fech})`, [alice.contratoId]);
      await a.query(`UPDATE clientes SET nome_completo = 'Rua das Flores número dez' WHERE id = (SELECT cliente_id FROM fechamentos WHERE id = ${fech})`, [alice.contratoId]);
      for (const termo of ["ÆGIDE", "ægide", "Ægide sintetica"]) assert.deepEqual(await ids(A.empresa, termo), [alice.festaId], termo);
      const porAegide = await buscar(A.empresa, "ægide", null);
      assert.equal(porAegide[0].aniversariante, "Ægide Sintética");
      assert.equal(porAegide[0].cliente, null, "endereço por extenso no nome sai omitido");
      for (const termo of ["rua", "flores", "rua das flores", "numero dez", "dez"]) assert.deepEqual(await ids(A.empresa, termo), [], `endereço omitido não acha: ${termo}`);
      // r4 (Astra r3 #2): caixa postal com centena no feminino.
      await a.query(`UPDATE clientes SET nome_completo = 'Caixa Postal Duzentas' WHERE id = (SELECT cliente_id FROM fechamentos WHERE id = ${fech})`, [alice.contratoId]);
      assert.equal((await buscar(A.empresa, "ægide", null))[0].cliente, null, "caixa postal no nome sai omitida");
      for (const termo of ["caixa", "postal", "caixa postal", "duzentas"]) assert.deepEqual(await ids(A.empresa, termo), [], `caixa postal omitida não acha: ${termo}`);
      // r5 (Astra r4 #2): "Caixa Dezasseis".
      await a.query(`UPDATE clientes SET nome_completo = 'Caixa Dezasseis' WHERE id = (SELECT cliente_id FROM fechamentos WHERE id = ${fech})`, [alice.contratoId]);
      assert.equal((await buscar(A.empresa, "ægide", null))[0].cliente, null, "Caixa Dezasseis no nome sai omitido");
      for (const termo of ["caixa", "dezasseis", "caixa dezasseis"]) assert.deepEqual(await ids(A.empresa, termo), [], `Caixa Dezasseis omitido não acha: ${termo}`);
    } finally { await a.query("ROLLBACK TO SAVEPOINT nomesr3"); }

    // r3 (P1 #3 e P2 novo): o teto é das festas ATIVAS da empresa no recorte, decidido antes de conferir nomes. A tem 3
    // festas ativas: com teto 2 TODO termo recusa (inclusive o que só existe na parte omitida e o que não existe), com
    // teto 3 nenhum recusa. Mesmo com o limite de candidatas já atingido, o teto recusa sem lista parcial.
    const comTeto = (nome: string, data: string | null, limite: number, teto: number) => ler.festasPorNome(tx, A.empresa, nome, data, hoje, limite, teto);
    // r4 (Astra r3 P2): "A1" e "98888" são termos impossíveis (não passam no formato) e recebem a mesma resposta.
    for (const termo of ["alice", "sintetic", "carla", "rafaela", "zuleica", "A1", "98888"]) {
      assert.deepEqual(await comTeto(termo, null, 11, 2), { festas: [], incompleto: true }, `teto 2: ${termo}`);
      assert.equal((await comTeto(termo, null, 11, 3)).incompleto, false, `teto 3: ${termo}`);
    }
    assert.deepEqual(await comTeto("A1", null, 11, 3), { festas: [], incompleto: false }, "termo impossível abaixo do teto: lista vazia");
    assert.deepEqual(await comTeto("sintetic", null, 1, 2), { festas: [], incompleto: true }, "limite de candidatas atingido não mascara o teto");
    assert.deepEqual((await comTeto("bento", bento.data, 11, 1)).festas.map((f) => f.festaId), [bento.festaId], "com data, o teto conta só as festas do dia");

    // Capacidade FESTA_CONSULTAR por membership e por empresa.
    assert.equal(await ler.membershipPodeConsultarFestas(tx, A.empresa, A.membership), false, "sem capacidade");
    await a.query(`INSERT INTO festa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1::uuid, $2::uuid, 'FESTA_CONSULTAR', $3::uuid, 'Fixture 0b')`,
      [A.empresa, A.membership, A.usuario]);
    assert.equal(await ler.membershipPodeConsultarFestas(tx, A.empresa, A.membership), true, "com capacidade em A");
    assert.equal(await ler.membershipPodeConsultarFestas(tx, B.empresa, A.membership), false, "a capacidade de A não vale em B");

    // Contagens: pendências abertas e tarefas pendentes por prioridade; resolvidas e concluídas fora; prazo vencido.
    const versao = (await a.query<{ v: string }>("SELECT versao_vigente_id::text AS v FROM contrato_fluxos WHERE contrato_id = $1::uuid", [alice.contratoId])).rows[0].v;
    const pend = (prio: string, estado: string, prazo: string) => a.query(
      `INSERT INTO festa_pendencias (festa_id, natureza, descricao, prioridade, estado, prazo, criado_por) VALUES ($1::uuid, 'OPERACIONAL', 'Texto livre que nunca sai: CPF 123.456.789-00', $2, $3, ${prazo}, $4::uuid)`,
      [alice.festaId, prio, estado, A.usuario]);
    await pend("CRITICA", "ABERTA", "now() - interval '3 days'");
    await pend("ATENCAO", "EM_TRATAMENTO", "now() + interval '3 days'");
    await pend("NORMAL", "RESOLVIDA", "now() - interval '3 days'");
    await a.query(`INSERT INTO festa_tarefas (festa_id, titulo, prioridade, estado, prazo, versao_contratual_id, criado_por) VALUES
      ($1::uuid, 'Ligar para a família', 'NORMAL', 'PENDENTE', now() - interval '2 days', $2::uuid, $3::uuid),
      ($1::uuid, 'Conferir decoração', 'NORMAL', 'CONCLUIDA', NULL, $2::uuid, $3::uuid)`, [alice.festaId, versao, A.usuario]);
    const resumo = await ler.resumoOperacionalDaFesta(tx, A.empresa, alice.festaId, hoje);
    assert.deepEqual(resumo.pendenciasAbertas, { critica: 1, atencao: 1, normal: 0, comPrazoVencido: 1 });
    assert.deepEqual(resumo.tarefasPendentes, { critica: 0, atencao: 0, normal: 1, comPrazoVencido: 1 });
    assert.ok(resumo.buffetCamposSemDefinicao === null || Number.isInteger(resumo.buffetCamposSemDefinicao));
    assert.equal(JSON.stringify(resumo).includes("CPF"), false, "nenhum texto livre sai");

    // O id da festa de A nunca vale em B (404), nem o de B em A.
    await a.query("SAVEPOINT cruzado");
    await assert.rejects(ler.resumoOperacionalDaFesta(tx, B.empresa, alice.festaId, hoje), (e) => (e as { httpStatus?: number }).httpStatus === 404);
    await a.query("ROLLBACK TO SAVEPOINT cruzado");
    await assert.rejects(ler.resumoOperacionalDaFesta(tx, A.empresa, deB.festaId, hoje), (e) => (e as { httpStatus?: number }).httpStatus === 404);
  } finally { await a.query("ROLLBACK"); nativos.clear(); restaurarAmbiente(); restaurarPool(); }
});
