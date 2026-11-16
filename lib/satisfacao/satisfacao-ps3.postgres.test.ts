import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { carregarComBanco, cod, executor, porTransacao, SENHA_FALSA, vincular } from "../marketing/harness-postgres.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import { baseSintetica, contratoAssinadoMinimo, travaAgendaFixture, type CriarEnvio } from "./harness-postgres.ts";
import { assinarToken, lerAnel, type AnelChaves } from "./token.ts";

/**
 * PS-3 (111) no PostgreSQL descartável, modelo 111, dados sintéticos COMMITADOS e três conexões:
 *   - pós-check da 111 e invariantes do banco (CHECK da URL, NULLS NOT DISTINCT, guarda do link, auditoria só de
 *     acréscimo inclusive TRUNCATE, coerência da conclusão, FKs compostas por empresa);
 *   - links pela Gestão (inclui, mantém, troca, remove, recusa), Equipe recusada, empresa B isolada, corrida → 409;
 *   - página pública: o MESMO link para as notas 0–10 (tarefa só de 0 a 6), link da unidade sem cair no da empresa,
 *     validade sobre RESPONDIDA (festa cancelada e envio vencido não mostram);
 *   - retornos: escopo Gestão × Equipe (TRATAR, não VER), filtros, "sem responsável", conclusão com auditoria no MESMO
 *     instante, bordas exatas de vigência (instante injetado só aqui), foto do vínculo, revogação antes (404) e depois do
 *     FOR SHARE (a revogação espera; PS3-R21-P3-1), dupla conclusão → 409;
 *   - instalação: PARCIAL (gatilho desligado, em modo réplica, homônimo noutra tabela, outro evento) e AUSENTE → 503;
 *   - ciclo 111 → down (recusa sem captura confirmada) → AUSENTE → 111 de novo, com captura e restauração.
 */
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${"x".repeat(24)}`;
const anel = lerAnel({ SATISFACAO_LINK_CHAVES: `1:${randomBytes(32).toString("base64")}`, SATISFACAO_LINK_CHAVE_ATUAL: "1" }) as AnelChaves;
const GESTAO = "REPRESENTANTE_AUTORIZADO";

type Publico = Record<"abrirPesquisa" | "responderPesquisa", (corpo: unknown, ctx: { ip: string | null }, deps: unknown) => Promise<Record<string, unknown>>>;
type Envios = { criarEnvio: CriarEnvio };
type Tarefas = {
  listarTarefas(tx: DbExecutor, t: TenantComprovado, f?: { estabelecimentoId?: string | null }, o?: { instanteDecisao?: string }): Promise<{
    gestao: boolean; tarefas: Array<{ id: string; estado: string; estabelecimentoId: string | null; observacao: string | null }>;
    unidades: Array<{ id: string; abertas: number; semResponsavel: boolean | null }>; abertasSemUnidade: number | null }>;
  concluirTarefa(tx: DbExecutor, t: TenantComprovado, e: { tarefaId: string; observacao?: string | null }, o?: { instanteDecisao?: string }): Promise<{ id: string; estado: string; concluidaEm: string }>;
};
type Links = {
  listarLinks(tx: DbExecutor, t: TenantComprovado): Promise<{ empresa: { url: string | null }; unidades: Array<{ estabelecimentoId: string; url: string | null }> }>;
  salvarLink(tx: DbExecutor, t: TenantComprovado, e: { estabelecimentoId: string | null; url: string }): Promise<{ alterado: boolean; url: string }>;
  removerLink(tx: DbExecutor, t: TenantComprovado, e: { estabelecimentoId: string | null }): Promise<unknown>;
  linkDoEnvio(tx: DbExecutor, empresaId: string, unidadeId: string | null): Promise<string | null>;
};
type Instalacao = { estadoInstalacao111(tx: DbExecutor): Promise<string> };

const identidade = (papel: string) => async (db: Client) => (await db.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
  VALUES ($1, 'Pessoa sintética PS-3', $2, $3, true) RETURNING id::text AS id`, [`${cod("u")}@pesquisa.test`, SENHA_FALSA, papel])).rows[0].id;
const erroDe = (code: string, status?: number) => (e: unknown) => (e as { code?: string }).code === code && (status === undefined || (e as { httpStatus?: number }).httpStatus === status);
const pid = async (c: Client) => Number((await c.query(`SELECT pg_backend_pid() AS p`)).rows[0].p);

async function recusa(c: Client, sql: string, v: unknown[], padrao: RegExp | string | { code: string; constraint: string }, mensagem?: string) {
  await assert.rejects(c.query(sql, v), (e: unknown) => {
    const { code, message, constraint } = e as { code?: string; message: string; constraint?: string };
    if (typeof padrao === "string") return code === padrao;
    if (padrao instanceof RegExp) return padrao.test(message);
    return code === padrao.code && constraint === padrao.constraint;
  }, mensagem ?? sql.slice(0, 90));
}

/** Espera (com prazo) até `alvo` estar bloqueado por `bloqueador` no trecho de SQL esperado. Prova, não sleep. */
async function esperarBloqueio(obs: Client, alvo: number, bloqueador: number, trecho: string) {
  for (let i = 0; i < 400; i++) {
    await obs.query(`SELECT pg_stat_clear_snapshot()`);
    const r = (await obs.query(`SELECT a.query, $2::int = ANY(pg_blocking_pids(a.pid)) AS bloqueado FROM pg_stat_activity a WHERE a.pid = $1::int`, [alvo, bloqueador])).rows[0];
    if (r?.bloqueado && String(r.query).includes(trecho)) return;
    await new Promise((fim) => setTimeout(fim, 10));
  }
  throw new Error(`backend ${alvo} não ficou bloqueado por ${bloqueador} em "${trecho}"`);
}

test("111: links, retornos, auditoria e instalação da PS-3", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const c2 = await conectarDescartavel({ travar: false });
  const c3 = await conectarDescartavel({ travar: false });
  try {
    const cache = new Map();
    const carregar = <T>(f: string) => carregarComBanco(f, c, () => null, {}, cache) as unknown as T;
    const publico = carregar<Publico>("lib/satisfacao/publico.ts");
    const envios = carregar<Envios>("lib/satisfacao/envios.ts");
    const tarefas = carregar<Tarefas>("lib/satisfacao/tarefas.ts");
    const links = carregar<Links>("lib/satisfacao/links.ts");
    const instalacao = carregar<Instalacao>("lib/satisfacao/instalacao.ts");
    const tx = executor(c);
    const emTransacao = porTransacao(c);
    const um = async (sql: string, v: unknown[] = []) => (await c.query(sql, v)).rows[0];
    const contar = async (sql: string, v: unknown[] = []) => Number((await um(sql, v)).n);
    let ipN = 0;
    const ip = () => `198.51.100.${(++ipN % 250) + 1}`;
    const deps = () => ({ withTransaction: emTransacao, anel: () => anel, repeticao: { esperar: async () => {} } });

    const { A, B, usuario, festa, cancelarFesta, execucao } = await baseSintetica(c, anel, envios.criarEnvio, identidade(GESTAO));
    const tenant = (empresa: string, membership: string, usuarioId: string, papel: string): TenantComprovado =>
      ({ empresaComprovada: empresa, membershipId: membership, usuarioId, papelAtual: papel });
    const gestaoA = tenant(A, (await um(`SELECT id::text FROM memberships WHERE empresa_id = $1::uuid AND usuario_id = $2::uuid`, [A, usuario])).id, usuario, GESTAO);

    // Unidades U1 e U2 habilitadas (com duas, festa nova fica sem unidade até a fixture escolher — 062) e a desativável U3.
    const [U1, U2] = await emTransacao(async () => {
      const ids: string[] = [];
      for (const nome of ["Unidade Centro PS-3", "Unidade Norte PS-3"]) {
        const u = (await c.query(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, $3, 'SUSPENSO') RETURNING id::text AS id`, [A, cod("u"), nome])).rows[0].id as string;
        await c.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'REPRESENTANTE_AUTORIZADO', 'Pesquisa PS-3 sintética')`, [A, u, usuario]);
        ids.push(u);
      }
      return ids;
    });

    /** Pessoa da Equipe de A (ADMINISTRATIVO) com membership ATIVA. */
    async function pessoaEquipe(empresa = A) {
      return emTransacao(async () => {
        const u = await identidade("ADMINISTRATIVO")(c);
        const v = await vincular(c, empresa, u, "ADMINISTRATIVO");
        return tenant(empresa, v.membership, u, "ADMINISTRATIVO");
      });
    }
    /**
     * Vínculo de unidade ATIVO (fixture: a 043 só aceita nascer SUSPENSA e o caminho operacional está fechado; a linha
     * é gravada em modo réplica numa transação própria) e a concessão pelo caminho normal, com a foto lida do banco.
     */
    async function conceder(p: TenantComprovado, unidade: string, capacidade = "SATISFACAO_TRATAR", janela: { desde?: string; ate?: string | null } = {}) {
      const vinculo = await emTransacao(async () => {
        await c.query("SET LOCAL session_replication_role = replica");
        return (await c.query(`INSERT INTO membership_estabelecimentos (empresa_id, estabelecimento_id, membership_id, status, vigente_desde, vigente_ate)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'ATIVA', coalesce($4::timestamptz, clock_timestamp() - interval '1 day'), $5::timestamptz) RETURNING id::text AS id`,
          [p.empresaComprovada, unidade, p.membershipId, janela.desde ?? null, janela.ate ?? null])).rows[0].id as string;
      });
      const concessao = await emTransacao(async () => (await c.query(`INSERT INTO satisfacao_capacidades (empresa_id, membership_id, estabelecimento_id, capacidade, vinculo_id, vinculo_atualizado_em, concedida_por)
        SELECT v.empresa_id, v.membership_id, v.estabelecimento_id, $2, v.id, v.atualizado_em, $3::uuid FROM membership_estabelecimentos v WHERE v.id = $1::uuid RETURNING id::text AS id`,
        [vinculo, capacidade, usuario])).rows[0].id as string);
      return { vinculo, concessao };
    }
    const revogar = (cx: Client, concessao: string) => cx.query(`UPDATE satisfacao_capacidades SET revogada_em = clock_timestamp(), revogada_por = $2::uuid WHERE id = $1::uuid`, [concessao, usuario]);

    /** Festa assinada (na unidade pedida) + envio + resposta pública com a nota; devolve a tarefa (se houver). */
    async function respondida(unidade: string | null, nota: number) {
      const { cl, f } = await festa({ assinado: false });
      if (unidade) await emTransacao(async () => { await travaAgendaFixture(c, A); await c.query(`UPDATE fechamentos SET estabelecimento_id = $2::uuid WHERE id = $1::uuid AND estabelecimento_id IS NULL`, [f, unidade]); });
      await emTransacao(() => contratoAssinadoMinimo(c, f));
      const x = await execucao(A, cl, f);
      const r = await emTransacao((t2) => envios.criarEnvio(t2, anel, { empresaId: A, execucaoId: x, canais: ["EMAIL"], agendadaPara: new Date(), maxTentativas: 3 }));
      if (!r.criado) throw new Error(`fixture: envio não criado (${r.motivo})`);
      const token = assinarToken(anel, r.envioId!, 1, anel.atual);
      const resposta = await publico.responderPesquisa({ token, notaIndicacao: nota, comentario: "Comentário sintético" }, { ip: ip() }, deps());
      const tarefa = (await um(`SELECT id::text FROM satisfacao_tarefas WHERE envio_id = $1::uuid`, [r.envioId]))?.id as string | undefined;
      return { f, envio: r.envioId!, token, resposta, tarefa };
    }
    const tarefaEm = async (unidade: string | null) => { const r = await respondida(unidade, 3); assert.ok(r.tarefa); return r.tarefa!; };
    const estadoTarefa = (id: string) => um(`SELECT estado, concluida_em::text AS concluida_em, concluida_por::text AS por, observacao FROM satisfacao_tarefas WHERE id = $1::uuid`, [id]);
    const auditoriaDe = (tarefa: string) => um(`SELECT count(*) AS n, min(criado_em)::text AS criado_em, min(ator_usuario_id::text) AS ator, min(estabelecimento_id::text) AS unidade FROM satisfacao_auditoria WHERE tarefa_id = $1::uuid`, [tarefa]);

    await t.test("pós-check 111 passa e o detector lê COMPLETA", async () => {
      await c.query(readFileSync("database/checks/20261031_111_postcheck.sql", "utf8"));
      assert.equal(await instalacao.estadoInstalacao111(tx), "COMPLETA");
    });

    const L_EMPRESA = "https://search.google.com/local/writereview?placeid=ChIJempresaSintetica01";
    const L_U1 = "https://g.page/r/CunidadeCentro01/review";

    await t.test("links: Gestão inclui, mantém, troca e remove com auditoria; recusas (inválido, Equipe, unidade alheia/inexistente)", async () => {
      // B': a string BRUTA é validada; espaço/controle em volta recusa (sem trim no serviço).
      for (const [bruta, caso] of [[` ${L_EMPRESA}`, "espaço inicial"], [`${L_EMPRESA}\n`, "newline final"], [`${" ".repeat(501)}${L_EMPRESA}`, "501 espaços"]] as const) {
        await assert.rejects(emTransacao((t2) => links.salvarLink(t2, gestaoA, { estabelecimentoId: null, url: bruta })), erroDe("LINK_INVALIDO", 400), caso);
      }
      assert.equal(Number((await um(`SELECT count(*) AS n FROM satisfacao_links_avaliacao WHERE empresa_id = $1::uuid`, [A])).n), 0, "recusas sem gravar");
      const r1 = await emTransacao((t2) => links.salvarLink(t2, gestaoA, { estabelecimentoId: null, url: L_EMPRESA }));
      assert.deepEqual([r1.alterado, r1.url], [true, L_EMPRESA]);
      assert.equal((await emTransacao((t2) => links.salvarLink(t2, gestaoA, { estabelecimentoId: null, url: L_EMPRESA }))).alterado, false);
      await emTransacao((t2) => links.salvarLink(t2, gestaoA, { estabelecimentoId: U1, url: "https://maps.app.goo.gl/AbCdEfGh12345" }));
      await emTransacao((t2) => links.salvarLink(t2, gestaoA, { estabelecimentoId: U1, url: L_U1 }));
      await emTransacao((t2) => links.salvarLink(t2, gestaoA, { estabelecimentoId: U2, url: "https://g.page/unidade-norte" }));
      await emTransacao((t2) => links.removerLink(t2, gestaoA, { estabelecimentoId: U2 }));
      await assert.rejects(emTransacao((t2) => links.removerLink(t2, gestaoA, { estabelecimentoId: U2 })), erroDe("NAO_ENCONTRADO", 404));
      const trilha = (await c.query(`SELECT acao, estabelecimento_id::text AS u, url_anterior, url_nova, ator_usuario_id::text AS ator FROM satisfacao_auditoria
        WHERE empresa_id = $1::uuid AND tarefa_id IS NULL ORDER BY criado_em, id`, [A])).rows;
      assert.deepEqual(trilha.map((x) => [x.acao, x.u, x.url_anterior, x.url_nova, x.ator]), [
        ["LINK_INCLUIDO", null, null, L_EMPRESA, usuario],
        ["LINK_INCLUIDO", U1, null, "https://maps.app.goo.gl/AbCdEfGh12345", usuario],
        ["LINK_TROCADO", U1, "https://maps.app.goo.gl/AbCdEfGh12345", L_U1, usuario],
        ["LINK_INCLUIDO", U2, null, "https://g.page/unidade-norte", usuario],
        ["LINK_REMOVIDO", U2, "https://g.page/unidade-norte", null, usuario],
      ]);
      await assert.rejects(emTransacao((t2) => links.salvarLink(t2, gestaoA, { estabelecimentoId: null, url: "https://www.google.com/url?q=https://evil.test" })),
        (e: unknown) => erroDe("LINK_INVALIDO", 400)(e) && Array.isArray((e as { details?: { exemplos?: unknown } }).details?.exemplos));
      const equipe = await pessoaEquipe();
      await assert.rejects(emTransacao((t2) => links.salvarLink(t2, equipe, { estabelecimentoId: null, url: L_EMPRESA })), erroDe("SEM_PERMISSAO", 403));
      await assert.rejects(emTransacao((t2) => links.listarLinks(t2, equipe)), erroDe("SEM_PERMISSAO", 403));
      const unidadeB = (await um(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, 'Unidade B', 'SUSPENSO') RETURNING id::text AS id`, [B, cod("u")])).id;
      await assert.rejects(emTransacao((t2) => links.salvarLink(t2, gestaoA, { estabelecimentoId: unidadeB, url: L_U1 })), erroDe("NAO_ENCONTRADO", 404));
      await assert.rejects(emTransacao((t2) => links.salvarLink(t2, gestaoA, { estabelecimentoId: randomUUID(), url: L_U1 })), erroDe("NAO_ENCONTRADO", 404));
      const lista = await emTransacao((t2) => links.listarLinks(t2, gestaoA));
      assert.equal(lista.empresa.url, L_EMPRESA);
      assert.deepEqual(lista.unidades.filter((u) => u.estabelecimentoId === U1 || u.estabelecimentoId === U2).map((u) => [u.estabelecimentoId, u.url]).sort(),
        [[U1, L_U1], [U2, null]].sort());
      const gestorB = await emTransacao(async () => {
        const u = await identidade(GESTAO)(c);
        return tenant(B, (await vincular(c, B, u, GESTAO)).membership, u, GESTAO);
      });
      assert.equal((await emTransacao((t2) => links.listarLinks(t2, gestorB))).empresa.url, null, "empresa B não vê o link de A");
    });

    await t.test("banco: CHECK da URL, uma linha por (empresa, unidade) com NULL igual, identidade imutável, FK por empresa", async () => {
      await recusa(c, `INSERT INTO satisfacao_links_avaliacao (empresa_id, url, criado_por, atualizado_por) VALUES ($1::uuid, 'http://www.google.com/maps', $2::uuid, $2::uuid)`, [B, usuario], { code: "23514", constraint: "satisfacao_links_url" });
      await recusa(c, `INSERT INTO satisfacao_links_avaliacao (empresa_id, url, criado_por, atualizado_por) VALUES ($1::uuid, $2, $3::uuid, $3::uuid)`, [A, L_EMPRESA, usuario], { code: "23505", constraint: "satisfacao_links_uk" });
      await recusa(c, `INSERT INTO satisfacao_links_avaliacao (empresa_id, estabelecimento_id, url, criado_por, atualizado_por) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $4::uuid)`, [B, U1, L_U1, usuario], { code: "23503", constraint: "satisfacao_links_unidade_fk" });
      await recusa(c, `UPDATE satisfacao_links_avaliacao SET estabelecimento_id = $2::uuid WHERE empresa_id = $1::uuid AND estabelecimento_id IS NULL`, [A, U2], "23514", "banco: link não muda de unidade");
      await recusa(c, `UPDATE satisfacao_links_avaliacao SET empresa_id = $2::uuid WHERE empresa_id = $1::uuid AND estabelecimento_id IS NULL`, [A, B], "23514");
      const antes = await um(`SELECT atualizado_em FROM satisfacao_links_avaliacao WHERE empresa_id = $1::uuid AND estabelecimento_id IS NULL`, [A]);
      await c.query(`UPDATE satisfacao_links_avaliacao SET url = url WHERE empresa_id = $1::uuid AND estabelecimento_id IS NULL`, [A]);
      const depois = await um(`SELECT atualizado_em FROM satisfacao_links_avaliacao WHERE empresa_id = $1::uuid AND estabelecimento_id IS NULL`, [A]);
      assert.ok(depois.atualizado_em > antes.atualizado_em, "a guarda carimba atualizado_em");
    });

    await t.test("página pública: o mesmo link para as notas 0–10 (tarefa só de 0 a 6); unidade sem link não herda o da empresa", async () => {
      for (let nota = 0; nota <= 10; nota++) {
        const r = await respondida(null, nota);
        assert.deepEqual(r.resposta, { gravada: true, linkAvaliacao: L_EMPRESA }, `nota ${nota}`);
        assert.equal(Boolean(r.tarefa), nota <= 6, `tarefa da nota ${nota}`);
      }
      assert.deepEqual((await respondida(U1, 7)).resposta, { gravada: true, linkAvaliacao: L_U1 });
      assert.deepEqual((await respondida(U1, 2)).resposta, { gravada: true, linkAvaliacao: L_U1 });
      assert.deepEqual((await respondida(U2, 9)).resposta, { gravada: true, linkAvaliacao: null }, "U2 sem link: nada (sem cair no da empresa)");
      assert.equal(await links.linkDoEnvio(tx, B, null), null, "empresa B sem link");
    });

    await t.test("RESPONDIDA: o link reaparece ao reabrir; festa cancelada ou envio vencido abrem ENCERRADA sem link (validade prevalece)", async () => {
      const r = await respondida(U1, 8);
      const reaberta = await publico.abrirPesquisa({ token: r.token }, { ip: ip() }, deps());
      assert.deepEqual([reaberta.situacao, reaberta.linkAvaliacao], ["RESPONDIDA", L_U1]);
      await cancelarFesta(r.f);
      const cancelada = await publico.abrirPesquisa({ token: r.token }, { ip: ip() }, deps());
      assert.deepEqual(cancelada, { situacao: "ENCERRADA", buffet: reaberta.buffet }, "festa cancelada: ENCERRADA, sem link");
      assert.equal((await um(`SELECT estado FROM satisfacao_envios WHERE id = $1::uuid`, [r.envio])).estado, "RESPONDIDO", "estado persistido intacto");
      const v = await respondida(U1, 9);
      // Fixture: o envio respondido passa a ter vencido (criação e prazo deslocados juntos, em modo réplica).
      await emTransacao(async () => {
        await c.query("SET LOCAL session_replication_role = replica");
        await c.query(`UPDATE satisfacao_envios SET criado_em = criado_em - interval '31 days', expira_em = expira_em - interval '31 days' WHERE id = $1::uuid`, [v.envio]);
      });
      const vencida = await publico.abrirPesquisa({ token: v.token }, { ip: ip() }, deps());
      assert.deepEqual(vencida, { situacao: "ENCERRADA", buffet: reaberta.buffet }, "vencido: ENCERRADA, sem link");
      assert.equal((await um(`SELECT estado FROM satisfacao_envios WHERE id = $1::uuid`, [v.envio])).estado, "RESPONDIDO", "estado persistido intacto");
    });

    // ---- retornos: Equipe de U1 (TRATAR), Equipe só VER, Equipe sem nada ----
    const equipeU1 = await pessoaEquipe();
    await conceder(equipeU1, U1);
    const soVer = await pessoaEquipe();
    await conceder(soVer, U1, "SATISFACAO_VER");
    const semNada = await pessoaEquipe();

    await t.test("leitura: Gestão vê tudo (filtro, sem unidade, sem responsável); Equipe só a unidade TRATAR; VER não basta", async () => {
      const t1 = await tarefaEm(U1), t2 = await tarefaEm(U2), t0 = await tarefaEm(null);
      const g = await emTransacao((x) => tarefas.listarTarefas(x, gestaoA));
      assert.equal(g.gestao, true);
      for (const id of [t1, t2, t0]) assert.ok(g.tarefas.some((x) => x.id === id), id);
      assert.ok((g.abertasSemUnidade ?? 0) >= 1);
      const porId = new Map(g.unidades.map((u) => [u.id, u]));
      assert.equal(porId.get(U1)?.semResponsavel, false);
      assert.equal(porId.get(U2)?.semResponsavel, true);
      assert.equal(porId.get(U2)?.abertas, await contar(`SELECT count(*) AS n FROM satisfacao_tarefas WHERE estabelecimento_id = $1::uuid AND estado = 'ABERTA'`, [U2]));
      const soU2 = await emTransacao((x) => tarefas.listarTarefas(x, gestaoA, { estabelecimentoId: U2 }));
      assert.ok(soU2.tarefas.length > 0 && soU2.tarefas.every((x) => x.estabelecimentoId === U2));
      const e = await emTransacao((x) => tarefas.listarTarefas(x, equipeU1));
      assert.equal(e.gestao, false);
      assert.ok(e.tarefas.some((x) => x.id === t1));
      assert.ok(e.tarefas.every((x) => x.estabelecimentoId === U1));
      assert.deepEqual(e.unidades.map((u) => [u.id, u.semResponsavel]), [[U1, null]]);
      assert.equal(e.abertasSemUnidade, null);
      await assert.rejects(emTransacao((x) => tarefas.listarTarefas(x, equipeU1, { estabelecimentoId: U2 })), erroDe("NAO_ENCONTRADO", 404));
      await assert.rejects(emTransacao((x) => tarefas.listarTarefas(x, gestaoA, { estabelecimentoId: randomUUID() })), erroDe("NAO_ENCONTRADO", 404));
      for (const p of [soVer, semNada]) assert.deepEqual(await emTransacao((x) => tarefas.listarTarefas(x, p)), { gestao: false, tarefas: [], unidades: [], abertasSemUnidade: null, totalNoEstado: 0, proximo: null });
    });

    await t.test("conclusão: Equipe na própria unidade, auditoria no mesmo instante; 409 na segunda; 404 fora do escopo; Gestão na sem unidade", async () => {
      const t1 = await tarefaEm(U1), t2 = await tarefaEm(U2), t0 = await tarefaEm(null);
      await assert.rejects(emTransacao((x) => tarefas.concluirTarefa(x, equipeU1, { tarefaId: t1, observacao: "x".repeat(1001) })), erroDe("DADOS_INVALIDOS", 400));
      const r = await emTransacao((x) => tarefas.concluirTarefa(x, equipeU1, { tarefaId: t1, observacao: "  Liguei e combinamos um desconto.  " }));
      const s = await estadoTarefa(t1);
      assert.deepEqual([s.estado, s.por, s.observacao, s.concluida_em], ["CONCLUIDA", equipeU1.usuarioId, "Liguei e combinamos um desconto.", r.concluidaEm]);
      const a = await auditoriaDe(t1);
      assert.deepEqual([Number(a.n), a.criado_em, a.ator, a.unidade], [1, s.concluida_em, equipeU1.usuarioId, U1]);
      await assert.rejects(emTransacao((x) => tarefas.concluirTarefa(x, equipeU1, { tarefaId: t1 })), erroDe("JA_CONCLUIDA", 409));
      await assert.rejects(emTransacao((x) => tarefas.concluirTarefa(x, gestaoA, { tarefaId: t1 })), erroDe("JA_CONCLUIDA", 409));
      for (const [p, id, caso] of [[equipeU1, t2, "outra unidade"], [equipeU1, t0, "sem unidade"], [soVer, t1, "só VER"], [semNada, t2, "sem concessão"]] as const) {
        await assert.rejects(emTransacao((x) => tarefas.concluirTarefa(x, p, { tarefaId: id })), erroDe("NAO_ENCONTRADO", 404), caso);
      }
      const gestorB = await emTransacao(async () => {
        const u = await identidade(GESTAO)(c);
        return tenant(B, (await vincular(c, B, u, GESTAO)).membership, u, GESTAO);
      });
      await assert.rejects(emTransacao((x) => tarefas.concluirTarefa(x, gestorB, { tarefaId: t2 })), erroDe("NAO_ENCONTRADO", 404), "outra empresa");
      assert.equal((await estadoTarefa(t2)).estado, "ABERTA");
      assert.equal((await emTransacao((x) => tarefas.concluirTarefa(x, gestaoA, { tarefaId: t0 }))).estado, "CONCLUIDA");
      assert.equal(Number((await auditoriaDe(t0)).n), 1);
      assert.equal((await auditoriaDe(t0)).unidade, null);
    });

    await t.test("vigência: bordas exatas do vínculo (instante injetado), concluida_em = instante; foto do vínculo alterada → 404", async () => {
      const { t0, t1 } = await um(`SELECT (date_trunc('second', clock_timestamp()) + interval '1 hour')::text AS t0, (date_trunc('second', clock_timestamp()) + interval '2 hours')::text AS t1`);
      const menos = async (i: string) => (await um(`SELECT ($1::timestamptz - interval '1 microsecond')::text AS i`, [i])).i as string;
      const janela = await pessoaEquipe();
      const { vinculo } = await conceder(janela, U1, "SATISFACAO_TRATAR", { desde: t0, ate: t1 });
      const [a, b, d, e] = [await tarefaEm(U1), await tarefaEm(U1), await tarefaEm(U1), await tarefaEm(U1)];
      const antesDoInicio = await menos(t0), ultimo = await menos(t1);
      await assert.rejects(emTransacao((x) => tarefas.concluirTarefa(x, janela, { tarefaId: a }, { instanteDecisao: antesDoInicio })), erroDe("NAO_ENCONTRADO", 404), "antes do início");
      const noInicio = await emTransacao((x) => tarefas.concluirTarefa(x, janela, { tarefaId: a }, { instanteDecisao: t0 })).catch((e: unknown) => assert.fail(`no início (inclusivo): ${(e as Error).message}`));
      assert.equal((await um(`SELECT $1::timestamptz = $2::timestamptz AS ok`, [noInicio.concluidaEm, t0])).ok, true);
      assert.equal((await um(`SELECT criado_em = $2::timestamptz AS ok FROM satisfacao_auditoria WHERE tarefa_id = $1::uuid`, [a, t0])).ok, true);
      await assert.rejects(emTransacao((x) => tarefas.concluirTarefa(x, janela, { tarefaId: b })), erroDe("NAO_ENCONTRADO", 404), "relógio real (antes de t0)");
      assert.equal((await emTransacao((x) => tarefas.concluirTarefa(x, janela, { tarefaId: b }, { instanteDecisao: ultimo }))).estado, "CONCLUIDA", "último instante");
      await assert.rejects(emTransacao((x) => tarefas.concluirTarefa(x, janela, { tarefaId: d }, { instanteDecisao: t1 })), erroDe("NAO_ENCONTRADO", 404), "no fim (exclusivo)");
      // Foto: a vigência do vínculo muda (caminho permitido pela 043), atualizado_em muda e a concessão deixa de valer.
      await emTransacao(async () => { await c.query(`UPDATE membership_estabelecimentos SET vigente_ate = vigente_ate + interval '1 day' WHERE id = $1::uuid`, [vinculo]); });
      await assert.rejects(emTransacao((x) => tarefas.concluirTarefa(x, janela, { tarefaId: e }, { instanteDecisao: t0 })), erroDe("NAO_ENCONTRADO", 404), "foto diferente");
      assert.equal((await estadoTarefa(e)).estado, "ABERTA");
    });

    await t.test("revogação (a) confirmada antes → 404; (b) depois do FOR SHARE: a revogação ESPERA a conclusão e confirma depois", async () => {
      const ra = await pessoaEquipe(), rb = await pessoaEquipe();
      const ca = await conceder(ra, U1), cb = await conceder(rb, U1);
      const [ta, tb] = [await tarefaEm(U1), await tarefaEm(U1)];
      await emTransacao(async () => { await revogar(c, ca.concessao); });
      await assert.rejects(emTransacao((x) => tarefas.concluirTarefa(x, ra, { tarefaId: ta })), erroDe("NAO_ENCONTRADO", 404));
      const [p2, p3] = [await pid(c2), await pid(c3)];
      await c2.query("BEGIN");
      try {
        await tarefas.concluirTarefa(executor(c2), rb, { tarefaId: tb });
        await c3.query("BEGIN");
        const revogacao = revogar(c3, cb.concessao);
        await esperarBloqueio(c, p3, p2, "satisfacao_capacidades");
        await c2.query("COMMIT");
        await revogacao;
        await c3.query("COMMIT");
      } catch (err) { await c2.query("ROLLBACK").catch(() => {}); await c3.query("ROLLBACK").catch(() => {}); throw err; }
      assert.equal((await estadoTarefa(tb)).estado, "CONCLUIDA");
      assert.ok((await um(`SELECT revogada_em FROM satisfacao_capacidades WHERE id = $1::uuid`, [cb.concessao])).revogada_em);
      const tc = await tarefaEm(U1);
      await assert.rejects(emTransacao((x) => tarefas.concluirTarefa(x, rb, { tarefaId: tc })), erroDe("NAO_ENCONTRADO", 404), "depois da revogação");
    });

    await t.test("corridas: dupla conclusão serializa na tarefa (409); inclusão simultânea do mesmo link → 409", async () => {
      const id = await tarefaEm(U1);
      const [p2, p3] = [await pid(c2), await pid(c3)];
      await c2.query("BEGIN"); await c3.query("BEGIN");
      try {
        await tarefas.concluirTarefa(executor(c2), gestaoA, { tarefaId: id });
        const segunda = tarefas.concluirTarefa(executor(c3), equipeU1, { tarefaId: id }).then(() => null, (e) => e);
        // A segunda espera a primeira em QUALQUER ponto (trava da tarefa ou UPDATE condicional): o contrato é 409, estado e autor.
        await esperarBloqueio(c, p3, p2, "");
        await c2.query("COMMIT");
        assert.ok(erroDe("JA_CONCLUIDA", 409)(await segunda));
        await c3.query("ROLLBACK");
        assert.equal(Number((await auditoriaDe(id)).n), 1);
        assert.equal((await estadoTarefa(id)).por, gestaoA.usuarioId);

        await c2.query("BEGIN"); await c3.query("BEGIN");
        await links.salvarLink(executor(c2), gestaoA, { estabelecimentoId: U2, url: "https://g.page/norte-um" });
        const outra = links.salvarLink(executor(c3), gestaoA, { estabelecimentoId: U2, url: "https://g.page/norte-dois" }).then(() => null, (e) => e);
        await esperarBloqueio(c, p3, p2, "INSERT INTO satisfacao_links_avaliacao");
        await c2.query("COMMIT");
        assert.ok(erroDe("CONFLITO", 409)(await outra), "inclusão simultânea → 409");
        await c3.query("ROLLBACK");
        assert.equal((await um(`SELECT url FROM satisfacao_links_avaliacao WHERE estabelecimento_id = $1::uuid`, [U2])).url, "https://g.page/norte-um");
      } catch (err) { await c2.query("ROLLBACK").catch(() => {}); await c3.query("ROLLBACK").catch(() => {}); throw err; }
    });

    await t.test("auditoria: só acréscimo (UPDATE, DELETE, TRUNCATE recusados); conclusão coerente com a tarefa", async () => {
      await recusa(c, `UPDATE satisfacao_auditoria SET url_nova = url_nova WHERE empresa_id = $1::uuid`, [A], /só de acréscimo \(UPDATE/, "auditoria: UPDATE recusado");
      await recusa(c, `DELETE FROM satisfacao_auditoria WHERE empresa_id = $1::uuid`, [A], /só de acréscimo \(DELETE/, "auditoria: DELETE recusado");
      await recusa(c, `TRUNCATE satisfacao_auditoria`, [], /só de acréscimo \(TRUNCATE/, "auditoria: TRUNCATE recusado");
      const aberta = await tarefaEm(U1);
      const ins = `INSERT INTO satisfacao_auditoria (empresa_id, estabelecimento_id, ator_usuario_id, acao, tarefa_id, criado_em) VALUES ($1::uuid, $2::uuid, $3::uuid, 'TAREFA_CONCLUIDA', $4::uuid, clock_timestamp())`;
      await recusa(c, ins, [A, U1, usuario, aberta], /exige a tarefa CONCLUIDA/, "auditoria: tarefa ABERTA");
      const feita = await tarefaEm(U1);
      await emTransacao((x) => tarefas.concluirTarefa(x, equipeU1, { tarefaId: feita }));
      await recusa(c, ins, [A, U1, usuario, feita], /ator da auditoria difere/, "auditoria: ator diferente");
      await recusa(c, ins, [A, U2, equipeU1.usuarioId, feita], /unidade da auditoria difere/, "auditoria: unidade diferente");
      await recusa(c, ins, [B, null, usuario, feita], /não existe nesta empresa/, "auditoria: outra empresa");
      // Nulidade isolada: conclusão COERENTE (tarefa, unidade e ator certos) com URL só é barrada pelo CHECK de nulidade.
      await recusa(c, `INSERT INTO satisfacao_auditoria (empresa_id, estabelecimento_id, ator_usuario_id, acao, tarefa_id, url_nova, criado_em)
        VALUES ($1::uuid, $2::uuid, $3::uuid, 'TAREFA_CONCLUIDA', $4::uuid, 'https://g.page/x1', clock_timestamp())`, [A, U1, equipeU1.usuarioId, feita],
        { code: "23514", constraint: "satisfacao_auditoria_nulidade" }, "auditoria: nulidade (conclusão com URL)");
      await recusa(c, `INSERT INTO satisfacao_auditoria (empresa_id, ator_usuario_id, acao, url_nova, criado_em) VALUES ($1::uuid, $2::uuid, 'TAREFA_CONCLUIDA', 'https://g.page/x1', clock_timestamp())`, [A, usuario], "23514");
      await recusa(c, `INSERT INTO satisfacao_auditoria (empresa_id, ator_usuario_id, acao, criado_em) VALUES ($1::uuid, $2::uuid, 'OUTRA', clock_timestamp())`, [A, usuario], "23514");
      await recusa(c, `INSERT INTO satisfacao_auditoria (empresa_id, ator_usuario_id, acao, url_nova) VALUES ($1::uuid, $2::uuid, 'LINK_INCLUIDO', 'https://g.page/x1')`, [A, usuario], "23502");
    });

    await t.test("instalação PARCIAL (desligado, réplica, homônimo noutra tabela, outro evento, sem NULLS NOT DISTINCT) → 503 sem mudar nada", async () => {
      const id = await tarefaEm(U1);
      const parciais = [
        `ALTER TABLE satisfacao_auditoria DISABLE TRIGGER satisfacao_auditoria_coerencia`,
        `ALTER TABLE satisfacao_auditoria ENABLE REPLICA TRIGGER satisfacao_auditoria_imutavel`,
        `DROP TRIGGER satisfacao_links_guarda ON satisfacao_links_avaliacao; CREATE TRIGGER satisfacao_links_guarda BEFORE UPDATE ON satisfacao_auditoria FOR EACH ROW EXECUTE FUNCTION kidmais111_link_guarda()`,
        `DROP TRIGGER satisfacao_auditoria_truncate ON satisfacao_auditoria; CREATE TRIGGER satisfacao_auditoria_truncate BEFORE DELETE ON satisfacao_auditoria FOR EACH STATEMENT EXECUTE FUNCTION kidmais111_auditoria_somente_insercao()`,
        `ALTER TABLE satisfacao_links_avaliacao DROP CONSTRAINT satisfacao_links_uk; ALTER TABLE satisfacao_links_avaliacao ADD CONSTRAINT satisfacao_links_uk UNIQUE (empresa_id, estabelecimento_id)`,
        `ALTER TABLE satisfacao_links_avaliacao DROP CONSTRAINT satisfacao_links_url; ALTER TABLE satisfacao_links_avaliacao ADD CONSTRAINT satisfacao_links_url CHECK (char_length(url) <= 500) NOT VALID`,
      ];
      for (const ddl of parciais) {
        await c.query("BEGIN");
        try {
          await c.query(ddl);
          assert.equal(await instalacao.estadoInstalacao111(tx), "PARCIAL", ddl);
          await assert.rejects(tarefas.concluirTarefa(tx, gestaoA, { tarefaId: id }), erroDe("INSTALACAO_INCOMPLETA", 503), ddl);
          await assert.rejects(links.salvarLink(tx, gestaoA, { estabelecimentoId: null, url: L_EMPRESA }), erroDe("INSTALACAO_INCOMPLETA", 503), ddl);
          assert.equal(await links.linkDoEnvio(tx, A, null), null, ddl);
          assert.equal((await estadoTarefa(id)).estado, "ABERTA");
        } finally { await c.query("ROLLBACK"); }
      }
      assert.equal(await instalacao.estadoInstalacao111(tx), "COMPLETA");
    });

    await t.test("ciclo: down recusa sem captura confirmada; com captura → AUSENTE (503, leitura normal, sem link); 111 de novo e restauração", async () => {
      const id = await tarefaEm(U1);
      const captura = async (tabela: string) => (await um(`SELECT coalesce(json_agg(x ORDER BY x.id), '[]'::json)::text AS j, count(*) AS n FROM ${tabela} x`)) as { j: string; n: string };
      const capturaLinks = await captura("satisfacao_links_avaliacao"), capturaAuditoria = await captura("satisfacao_auditoria");
      assert.ok(Number(capturaLinks.n) > 0 && Number(capturaAuditoria.n) > 0);
      const down = readFileSync("database/rollback/20261031_111_satisfacao_links_auditoria_down.sql", "utf8");
      await assert.rejects(c.query(down), /capture e confirme/, "down recusa sem captura confirmada");
      await c.query("ROLLBACK");
      assert.equal(await instalacao.estadoInstalacao111(tx), "COMPLETA");
      await c.query(`SET kidmais111.captura_confirmada = 'sim'`);
      try { await c.query(down); } finally { await c.query(`RESET kidmais111.captura_confirmada`); }
      assert.equal(await instalacao.estadoInstalacao111(tx), "AUSENTE");
      await assert.rejects(c.query(down), /111 ausente/);
      await c.query("ROLLBACK");
      await assert.rejects(emTransacao((x) => tarefas.concluirTarefa(x, gestaoA, { tarefaId: id })), erroDe("NAO_INSTALADO", 503));
      await assert.rejects(emTransacao((x) => links.listarLinks(x, gestaoA)), erroDe("NAO_INSTALADO", 503));
      assert.ok((await emTransacao((x) => tarefas.listarTarefas(x, gestaoA))).tarefas.some((x) => x.id === id), "leitura dos retornos segue");
      assert.deepEqual((await respondida(U1, 10)).resposta, { gravada: true, linkAvaliacao: null });
      assert.equal((await estadoTarefa(id)).estado, "ABERTA");

      await c.query(readFileSync("database/migrations/20261031_111_satisfacao_links_auditoria.sql", "utf8"));
      await c.query(readFileSync("database/checks/20261031_111_postcheck.sql", "utf8"));
      assert.equal(await instalacao.estadoInstalacao111(tx), "COMPLETA");
      await emTransacao(async () => {
        await c.query(`INSERT INTO satisfacao_links_avaliacao SELECT * FROM json_populate_recordset(NULL::satisfacao_links_avaliacao, $1::json)`, [capturaLinks.j]);
        await c.query(`INSERT INTO satisfacao_auditoria SELECT * FROM json_populate_recordset(NULL::satisfacao_auditoria, $1::json)`, [capturaAuditoria.j]);
      });
      assert.deepEqual(await captura("satisfacao_links_avaliacao"), capturaLinks);
      assert.deepEqual(await captura("satisfacao_auditoria"), capturaAuditoria);
      assert.deepEqual((await respondida(U1, 10)).resposta, { gravada: true, linkAvaliacao: L_U1 });
      assert.equal((await emTransacao((x) => tarefas.concluirTarefa(x, gestaoA, { tarefaId: id }))).estado, "CONCLUIDA");
    });
  } finally {
    await encerrarDescartavel(c3, false);
    await encerrarDescartavel(c2, false);
    await encerrarDescartavel(c);
  }
});
