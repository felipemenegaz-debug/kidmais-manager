import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { hashToken } from "../autenticacao/senha.ts";
import { temAutoridadeDePlataforma } from "../autenticacao/plataforma.ts";
import { conectarDescartavel, encerrarDescartavel, portaDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";

/**
 * 057 no PostgreSQL descartável (estado "atual" = … + 056 + 057). A regra de assinatura em nome da empresa roda de
 * verdade: a validação DIFERIDA da 013 (kidmais_validar_fluxo_contrato) é disparada na hora com
 * SET CONSTRAINTS … IMMEDIATE, dentro de savepoints, sobre um contrato em preparação válido.
 *   tenant → membership ATIVA → Gestão → CONTRATO_ASSINAR_EMPRESA → contrato da empresa → assinatura.
 * Depois, o ciclo da migration: down recusado com concessão nova, down/up com backfill determinístico e o
 * histórico de assinaturas intacto. O banco é recriado pela receita antes da suíte (pode confirmar).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ler = (p: string) => readFileSync(resolve(root, p), "utf8");
const UP = "database/migrations/20260929_057_assinatura_contrato_empresa.sql";
const DOWN = "database/rollback/20260929_057_assinatura_contrato_empresa_down.sql";
const PRE = "database/checks/20260929_057_precheck.sql";
const POST = "database/checks/20260929_057_postcheck.sql";
const cod = () => `g57${randomBytes(3).toString("hex")}`;
const senha = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const RECUSA = /Sessão\/identidade de assinatura inválida/;
const id = async (db: Client, sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;

async function tentar(db: Client, fn: () => Promise<unknown>) {
  await db.query("SAVEPOINT tentativa");
  try {
    await fn();
    return "passou";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    await db.query("ROLLBACK TO SAVEPOINT tentativa");
  }
}

async function empresa(db: Client) {
  const e = await id(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa 057', 'PROVISIONAMENTO') RETURNING id`, [cod()]);
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
  return e;
}

type Vinculo = { empresa: string; papel: "ADMINISTRATIVO" | "REPRESENTANTE_AUTORIZADO"; assina?: boolean };
/** Identidade global (papel global dado) + memberships ATIVAS (papel e capability de assinatura por empresa) + sessão recente. */
async function usuario(db: Client, vinculos: Vinculo[], papelGlobal: "ADMINISTRATIVO" | "REPRESENTANTE_AUTORIZADO") {
  const u = await id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Pessoa 057', $2, $3, true) RETURNING id`, [`${cod()}@example.test`, senha, papelGlobal]);
  const memberships: Record<string, string> = {};
  for (const v of vinculos) {
    const m = await id(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [v.empresa, u, v.papel]);
    await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    if (v.assina) {
      await db.query(`INSERT INTO empresa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1::uuid, $2::uuid, 'CONTRATO_ASSINAR_EMPRESA', $3::uuid, 'Fixture 057')`, [v.empresa, m, u]);
    }
    memberships[v.empresa] = m;
  }
  const sessao = await id(db, `INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
     VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours') RETURNING id`, [u, hashToken(randomBytes(32).toString("base64url")), hashToken(randomBytes(32).toString("base64url"))]);
  return { id: u, sessao, memberships, papelGlobal };
}

/** Contrato EM PREPARAÇÃO da empresa: versão ATIVA, edição EM_ELABORACAO com documento revisado e comprovante. */
async function contrato(db: Client, empresaId: string, criador: string) {
  const pacote = await id(db, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Festa 057', 1, true, true) RETURNING id`, [empresaId, cod().toUpperCase()]);
  const tabela = await id(db, `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela 057', '2026-01-01', false, $2::uuid) RETURNING id`, [cod(), empresaId]);
  const preco = await id(db, `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id`, [tabela, pacote]);
  const agenda = await id(db, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda 057', '10:00', '18:00', 9) RETURNING id`, [cod()]);
  const cliente = await id(db, `INSERT INTO clientes (nome_completo, empresa_id) VALUES ('Cliente 057', $1::uuid) RETURNING id`, [empresaId]);
  const fechamento = await id(db, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
      categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
    VALUES ('2026-10-01', '14:00', '18:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $6::uuid, 'AGUARDANDO_PAGAMENTO') RETURNING id`,
    [agenda, empresaId, pacote, tabela, preco, cliente]);
  const c = await id(db, `INSERT INTO contratos (fechamento_id) VALUES ($1::uuid) RETURNING id`, [fechamento]);
  const snapshot = { comercial: { valorFinalContrato: 100 }, evento: { data: "2026-10-01", convidados: 20 } };
  const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const pdf = Buffer.from(`%PDF-1.4\n% 057 ${randomUUID()}\n%%EOF\n`);
  const pdfHash = createHash("sha256").update(pdf).digest("hex");
  const versao = await id(db, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, documento_template_versao)
     VALUES ($1::uuid, 1, 'ATIVA', $2::jsonb, $3, 1) RETURNING id`, [c, JSON.stringify(snapshot), hash]);
  const doc = await id(db, `INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf, gerado_por_usuario_id)
     VALUES ($1::uuid, 'CONTRATO', 1, $2, 'CONTRATO_057', 1, $3, $4, $5, $6::uuid) RETURNING id`, [versao, hash, pdfHash, pdf.length, pdf, criador]);
  const comprovante = await id(db, `INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf)
     VALUES ($1::uuid, 'COMPROVANTE_ASSINATURA', 1, $2, 'COMPROVANTE_057', 1, $3, $4, $5) RETURNING id`, [versao, hash, pdfHash, pdf.length, pdf]);
  await db.query(`INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id, documento_revisado_id, revisado_por_usuario_id, revisado_em)
     VALUES ($1::uuid, $2::uuid, 'INICIAL', 'EM_ELABORACAO', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $3::uuid, $3::uuid, $4::uuid, $3::uuid, now())`, [versao, c, criador, doc]);
  await db.query(`INSERT INTO contrato_fluxos (contrato_id, versao_em_preparacao_id) VALUES ($1::uuid, $2::uuid)`, [c, versao]);
  return { versao, doc, comprovante, hash, pdfHash };
}

/** Assinatura KIDMAIS (em nome da empresa) com a sessão real do usuário; a validação diferida roda na hora. */
async function assinar(db: Client, k: Awaited<ReturnType<typeof contrato>>, u: { id: string; sessao: string }) {
  await db.query(`INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, usuario_id, sessao_id, autenticacao_metodo, autenticado_em, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
     SELECT $1::uuid, 'KIDMAIS', $2::uuid, $3::uuid, s.id, 'SENHA', s.autenticado_em, jsonb_build_object('usuarioId', $3::text, 'papel', 'REPRESENTANTE_AUTORIZADO', 'nome', 'Pessoa 057', 'cargo', null),
            $4, $5, 'SESSAO_REAUTENTICADA', 'INTERNAL', clock_timestamp(), $6::uuid, $7::uuid, $8::uuid
       FROM sessoes_administrativas s WHERE s.id = $9::uuid`,
    [k.versao, k.doc, u.id, k.hash, k.pdfHash, randomUUID(), randomUUID(), k.comprovante, u.sessao]);
  await db.query("SET CONSTRAINTS contrato_assinaturas_validar_trg IMMEDIATE");
  await db.query("SET CONSTRAINTS contrato_assinaturas_validar_trg DEFERRED");
}

test("057 no postgres descartável: assinatura em nome da empresa é capability da membership, nunca papel global", { timeout: 120_000 }, async (t) => {
  const client = await conectarDescartavel();
  const db = client as unknown as Client;
  try {
    const ident = (await db.query<{ db: string; port: number }>("SELECT current_database() AS db, inet_server_port() AS port")).rows[0];
    assert.equal(ident.db, "kidmais_pacotes_v1_descartavel");
    assert.equal(Number(ident.port), portaDescartavel());

    await t.test("regra real da 013/057: A com capability assina A; sem capability, outra empresa, Equipe, plataforma e membership revogada não", async () => {
      await db.query("BEGIN");
      try {
        const A = await empresa(db);
        const B = await empresa(db);
        // Conta criada por empresa: papel global NEUTRO; Gestão + capability só em A.
        const gestorA = await usuario(db, [{ empresa: A, papel: "REPRESENTANTE_AUTORIZADO", assina: true }], "ADMINISTRATIVO");
        const semCapacidade = await usuario(db, [{ empresa: A, papel: "REPRESENTANTE_AUTORIZADO" }], "ADMINISTRATIVO");
        const compartilhado = await usuario(db, [{ empresa: A, papel: "REPRESENTANTE_AUTORIZADO", assina: true }, { empresa: B, papel: "REPRESENTANTE_AUTORIZADO" }], "ADMINISTRATIVO");
        const equipeComCapacidade = await usuario(db, [{ empresa: A, papel: "ADMINISTRATIVO", assina: true }], "ADMINISTRATIVO");
        const plataformaSemVinculo = await usuario(db, [{ empresa: B, papel: "ADMINISTRATIVO" }], "REPRESENTANTE_AUTORIZADO");
        const plataformaGestaoSemCapacidade = await usuario(db, [{ empresa: A, papel: "REPRESENTANTE_AUTORIZADO" }], "REPRESENTANTE_AUTORIZADO");
        const contratoA = await contrato(db, A, gestorA.id);
        const contratoB = await contrato(db, B, gestorA.id);

        assert.equal(await tentar(db, () => assinar(db, contratoA, gestorA)), "passou", "Gestão de A com capability assina contrato de A (sem papel global)");
        assert.match(await tentar(db, () => assinar(db, contratoA, semCapacidade)), RECUSA, "Gestão de A sem capability");
        assert.match(await tentar(db, () => assinar(db, contratoB, gestorA)), RECUSA, "capability de A não assina contrato de B");
        assert.equal(await tentar(db, () => assinar(db, contratoA, compartilhado)), "passou", "compartilhado assina em A");
        assert.match(await tentar(db, () => assinar(db, contratoB, compartilhado)), RECUSA, "compartilhado não assina em B");
        assert.match(await tentar(db, () => assinar(db, contratoA, equipeComCapacidade)), RECUSA, "capability sem Gestão nesta empresa não basta");
        assert.match(await tentar(db, () => assinar(db, contratoA, plataformaSemVinculo)), RECUSA, "Platform Admin sem membership em A");
        assert.match(await tentar(db, () => assinar(db, contratoA, plataformaGestaoSemCapacidade)), RECUSA, "Platform Admin com Gestão mas sem capability");

        // Capability de assinatura não é plataforma e não mexe na identidade.
        assert.equal((await db.query<{ papel: string }>("SELECT papel FROM usuarios_administrativos WHERE id = $1::uuid", [gestorA.id])).rows[0].papel, "ADMINISTRATIVO");
        assert.equal(temAutoridadeDePlataforma({ papel: gestorA.papelGlobal }), false, "sem tabela PDF nem WhatsApp");

        // Capability revogada e membership revogada: nova assinatura recusada.
        const revogar = await usuario(db, [{ empresa: A, papel: "REPRESENTANTE_AUTORIZADO", assina: true }], "ADMINISTRATIVO");
        await db.query(`UPDATE empresa_membership_capacidades SET revogado_por = $2::uuid, revogado_em = clock_timestamp(), motivo_revogacao = 'Teste 057'
                         WHERE membership_id = $1::uuid AND revogado_em IS NULL`, [revogar.memberships[A], gestorA.id]);
        assert.match(await tentar(db, () => assinar(db, contratoA, revogar)), RECUSA, "capability revogada");
        await db.query("SELECT set_config('kidmais.ator_usuario_id', $1, true)", [gestorA.id]);
        const saiu = await usuario(db, [{ empresa: A, papel: "REPRESENTANTE_AUTORIZADO", assina: true }], "ADMINISTRATIVO");
        await db.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [saiu.memberships[A]]);
        assert.match(await tentar(db, () => assinar(db, contratoA, saiu)), RECUSA, "membership revogada");

        // Histórico: assinatura feita com autoridade continua válida depois que a autoridade sai.
        await assinar(db, contratoA, compartilhado);
        await db.query(`UPDATE memberships SET status = 'REVOGADA' WHERE id = $1::uuid`, [compartilhado.memberships[A]]);
        await db.query(`UPDATE contrato_edicoes SET atualizado_em = clock_timestamp() WHERE contrato_versao_id = $1::uuid`, [contratoA.versao]);
        await db.query("SET CONSTRAINTS contrato_edicoes_validar_trg, contrato_versoes_validar_fluxo_trg, contrato_fluxos_validar_trg IMMEDIATE");
        await db.query("SET CONSTRAINTS ALL DEFERRED");
        assert.equal((await db.query("SELECT 1 FROM contrato_assinaturas WHERE contrato_versao_id = $1::uuid AND parte = 'KIDMAIS' AND usuario_id = $2::uuid", [contratoA.versao, compartilhado.id])).rows.length, 1);
        const gatilho = (await db.query<{ tgtype: number }>("SELECT tgtype FROM pg_trigger WHERE tgname = 'contrato_assinaturas_validar_trg'")).rows[0].tgtype;
        assert.equal(gatilho & 4, 4, "valida INSERT");
        assert.equal(gatilho & (8 | 16), 0, "não revalida assinatura existente (sem UPDATE/DELETE)");
      } finally {
        await db.query("ROLLBACK");
      }
    });

    await t.test("migration: down recusa concessão nova; down/up restauram a 013 e refazem o backfill determinístico; histórico intacto", async () => {
      const assinaturasAntes = (await db.query<{ h: string | null }>("SELECT md5(string_agg(id::text || usuario_id::text, ',' ORDER BY id)) AS h FROM contrato_assinaturas")).rows[0].h;
      const A = await empresa(db);
      const legado = await usuario(db, [{ empresa: A, papel: "REPRESENTANTE_AUTORIZADO" }], "REPRESENTANTE_AUTORIZADO");
      const gestaoDaEmpresa = await usuario(db, [{ empresa: A, papel: "REPRESENTANTE_AUTORIZADO" }], "ADMINISTRATIVO");
      const equipeComPapelGlobal = await usuario(db, [{ empresa: A, papel: "ADMINISTRATIVO" }], "REPRESENTANTE_AUTORIZADO");

      // Concessão feita por empresa depois da 057: o down recusaria perdê-la.
      await db.query("BEGIN");
      try {
        await db.query(`INSERT INTO empresa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1::uuid, $2::uuid, 'CONTRATO_ASSINAR_EMPRESA', $3::uuid, 'Concedida pela empresa')`, [A, gestaoDaEmpresa.memberships[A], legado.id]);
        assert.match(await tentar(db, () => db.query(semTransacaoExplicita(ler(DOWN)))), /057 down: há concessão ou revogação/);
      } finally {
        await db.query("ROLLBACK");
      }

      await db.query(ler(DOWN));
      const md5 = async () => (await db.query<{ h: string }>("SELECT md5(replace(prosrc, chr(13), '')) AS h FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure")).rows[0].h;
      assert.equal(await md5(), "3de688e21a383e2dcdaf4f28bcff31d7", "validação volta a ser exatamente a da 013");
      assert.equal((await db.query("SELECT to_regclass('public.empresa_membership_capacidades') AS t")).rows[0].t, null);

      await db.query(ler(PRE));
      await db.query(ler(UP));
      await db.query(ler(POST));
      assert.equal(await md5(), "e7d4d19ac1b1d925135adbc45a2247a5");
      const comCapacidade = async (u: { memberships: Record<string, string> }) =>
        (await db.query("SELECT 1 FROM empresa_membership_capacidades WHERE membership_id = $1::uuid AND capacidade = 'CONTRATO_ASSINAR_EMPRESA' AND revogado_em IS NULL", [u.memberships[A]])).rows.length === 1;
      assert.equal(await comCapacidade(legado), true, "backfill: quem já assinava pela empresa (Gestão + papel global) continua assinando");
      assert.equal(await comCapacidade(gestaoDaEmpresa), false, "Gestão criada por empresa não ganha capability no backfill");
      assert.equal(await comCapacidade(equipeComPapelGlobal), false, "papel global com Equipe na empresa não ganha");
      assert.equal((await db.query<{ h: string | null }>("SELECT md5(string_agg(id::text || usuario_id::text, ',' ORDER BY id)) AS h FROM contrato_assinaturas")).rows[0].h, assinaturasAntes, "assinaturas históricas intactas");
      await db.query("BEGIN");
      try {
        assert.match(await tentar(db, () => db.query(`DELETE FROM empresa_membership_capacidades WHERE membership_id = $1::uuid`, [legado.memberships[A]])), /057: capacidade da empresa não é apagada/);
      } finally {
        await db.query("ROLLBACK");
      }
    });
    await t.test("corrida real do down: decisão sob ACCESS EXCLUSIVE; nada confirmado durante a espera é apagado; escrita depois da trava não passa", async () => {
      const MOTIVO = "057: backfill — já assinava pela empresa (papel da identidade e da membership)";
      const assinaturas = async () => (await db.query<{ h: string | null }>("SELECT md5(string_agg(id::text || usuario_id::text, ',' ORDER BY id)) AS h FROM contrato_assinaturas")).rows[0].h;
      const historico = await assinaturas();
      const aplicada = async () => (await db.query<{ t: string | null }>("SELECT to_regclass('public.empresa_membership_capacidades')::text AS t")).rows[0].t !== null;
      const reaplicar = async () => { await db.query(ler(PRE)); await db.query(ler(UP)); await db.query(ler(POST)); };
      const pid = async (c: Client) => (await c.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p;
      /** Espera até `esperando` estar bloqueado por `bloqueador` (prova de que a ordem da corrida aconteceu). */
      const esperarBloqueio = async (esperando: number, bloqueador: number) => {
        const fim = Date.now() + 4000;
        while (Date.now() < fim) {
          const r = await db.query<{ pids: number[] }>("SELECT pg_blocking_pids($1) AS pids", [esperando]);
          if (r.rows[0].pids.map(Number).includes(bloqueador)) return;
          await new Promise((ok) => setTimeout(ok, 20));
        }
        assert.fail(`sessão ${esperando} deveria esperar a trava de ${bloqueador}`);
      };
      /** Limpeza SÓ do teste (banco descartável): volta a tabela ao estado reversível (apenas backfill ativo). */
      const limparPosteriores = async () => {
        await db.query("BEGIN");
        await db.query("ALTER TABLE empresa_membership_capacidades DISABLE TRIGGER kidmais_057_emc_imutavel_trg");
        await db.query("DELETE FROM empresa_membership_capacidades WHERE motivo <> $1", [MOTIVO]);
        await db.query("UPDATE empresa_membership_capacidades SET revogado_por = NULL, revogado_em = NULL, motivo_revogacao = NULL WHERE revogado_em IS NOT NULL");
        await db.query("ALTER TABLE empresa_membership_capacidades ENABLE TRIGGER kidmais_057_emc_imutavel_trg");
        await db.query("COMMIT");
      };

      // Fixture confirmada: legado (Gestão + papel global) recebe backfill na reaplicação; nova Gestão da empresa não.
      const A = await empresa(db);
      const legado = await usuario(db, [{ empresa: A, papel: "REPRESENTANTE_AUTORIZADO" }], "REPRESENTANTE_AUTORIZADO");
      const nova = await usuario(db, [{ empresa: A, papel: "REPRESENTANTE_AUTORIZADO" }], "ADMINISTRATIVO");
      const txA = await conectarDescartavel({ travar: false }) as unknown as Client;
      const txB = await conectarDescartavel({ travar: false }) as unknown as Client;
      try {
        const [pa, pb] = [await pid(txA), await pid(txB)];
        const conceder = (c: Client) => c.query(`INSERT INTO empresa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1::uuid, $2::uuid, 'CONTRATO_ASSINAR_EMPRESA', $3::uuid, 'Concedida durante o down')`, [A, nova.memberships[A], legado.id]);

        // 1. Concessão ABERTA, depois abortada: o down espera, reavalia e desfaz normalmente (sem recusa falsa).
        await txA.query("BEGIN");
        await conceder(txA);
        const down1 = txB.query(ler(DOWN)).then(() => "ok", (e: Error) => e.message);
        await esperarBloqueio(pb, pa);
        await txA.query("ROLLBACK");
        assert.equal(await down1, "ok");
        assert.equal(await aplicada(), false);
        await reaplicar();
        assert.equal((await db.query("SELECT 1 FROM empresa_membership_capacidades WHERE membership_id = $1::uuid AND motivo = $2 AND revogado_em IS NULL", [legado.memberships[A], MOTIVO])).rows.length, 1, "backfill refeito");

        // 2. Concessão ABERTA e CONFIRMADA enquanto o down espera: o down, já com a trava, vê e RECUSA.
        await txA.query("BEGIN");
        await conceder(txA);
        const down2 = txB.query(ler(DOWN)).then(() => "ok", (e: Error) => e.message);
        await esperarBloqueio(pb, pa);
        await txA.query("COMMIT");
        assert.match(await down2, /057 down: há concessão ou revogação/);
        await txB.query("ROLLBACK").catch(() => undefined);
        assert.equal(await aplicada(), true, "tabela preservada");
        assert.equal((await db.query("SELECT 1 FROM empresa_membership_capacidades WHERE membership_id = $1::uuid AND revogado_em IS NULL", [nova.memberships[A]])).rows.length, 1, "concessão confirmada não foi apagada");
        await limparPosteriores();

        // 3. Revogação ABERTA e CONFIRMADA enquanto o down espera: também recusa; a revogação permanece.
        await txA.query("BEGIN");
        await txA.query(`UPDATE empresa_membership_capacidades SET revogado_por = $2::uuid, revogado_em = clock_timestamp(), motivo_revogacao = 'Revogada durante o down'
                          WHERE membership_id = $1::uuid AND revogado_em IS NULL`, [legado.memberships[A], nova.id]);
        const down3 = txB.query(ler(DOWN)).then(() => "ok", (e: Error) => e.message);
        await esperarBloqueio(pb, pa);
        await txA.query("COMMIT");
        assert.match(await down3, /057 down: há concessão ou revogação/);
        await txB.query("ROLLBACK").catch(() => undefined);
        assert.equal((await db.query("SELECT 1 FROM empresa_membership_capacidades WHERE membership_id = $1::uuid AND revogado_em IS NOT NULL", [legado.memberships[A]])).rows.length, 1, "revogação confirmada não foi apagada");
        await limparPosteriores();

        // 4. Ordem inversa: o down pega a trava primeiro; a concessão que chega depois espera e, com o down
        //    confirmado, falha — nunca é confirmada e perdida.
        await txB.query("BEGIN");
        await txB.query(semTransacaoExplicita(ler(DOWN)));
        const tardia = txA.query("BEGIN").then(() => conceder(txA)).then(() => txA.query("COMMIT")).then(() => "ok", (e: Error) => e.message);
        await esperarBloqueio(pa, pb);
        await txB.query("COMMIT");
        assert.match(await tardia, /empresa_membership_capacidades|does not exist|não existe|relation|relação|OID/);
        await txA.query("ROLLBACK").catch(() => undefined);
        assert.equal(await aplicada(), false, "down concluído");
        await reaplicar();
        assert.equal((await db.query("SELECT count(*)::int AS n FROM empresa_membership_capacidades WHERE motivo <> $1", [MOTIVO])).rows[0].n, 0, "nada da escrita tardia sobreviveu");

        // 5. Com o down em espera, nenhuma escrita nova passa à frente: a fila da trava bloqueia quem chega depois.
        await txA.query("BEGIN");
        await conceder(txA);
        const down5 = txB.query(ler(DOWN)).then(() => "ok", (e: Error) => e.message);
        await esperarBloqueio(pb, pa);
        const terceira = await conectarDescartavel({ travar: false }) as unknown as Client;
        try {
          const p3 = await pid(terceira);
          const depois = terceira.query("BEGIN").then(() => terceira.query("SET LOCAL lock_timeout = '1s'")).then(() => conceder(terceira)).then(() => "ok", (e: Error) => e.message);
          await esperarBloqueio(p3, pb);
          assert.match(await depois, /lock|trava|bloqueio|timeout|tempo/i, "escrita que chega depois da trava pedida espera o down");
          await terceira.query("ROLLBACK").catch(() => undefined);
        } finally {
          await encerrarDescartavel(terceira, false);
        }
        await txA.query("COMMIT");
        assert.match(await down5, /057 down: há concessão ou revogação/);
        await txB.query("ROLLBACK").catch(() => undefined);
        await limparPosteriores();

        // Estado final: 057 aplicada, só backfill; histórico de assinaturas intacto; down volta a funcionar.
        assert.equal(await assinaturas(), historico, "assinaturas históricas intactas");
        await db.query(ler(DOWN));
        assert.equal((await db.query<{ h: string }>("SELECT md5(replace(prosrc, chr(13), '')) AS h FROM pg_proc WHERE oid = 'public.kidmais_validar_fluxo_contrato()'::regprocedure")).rows[0].h, "3de688e21a383e2dcdaf4f28bcff31d7");
        await reaplicar();
      } finally {
        await encerrarDescartavel(txA, false);
        await encerrarDescartavel(txB, false);
      }
    });
  } finally {
    await encerrarDescartavel(client);
  }
});
