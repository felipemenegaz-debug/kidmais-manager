import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Client } from "pg";
import { hashToken } from "../autenticacao/senha.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { lerCsv } from "../exportacao/fixture.postgres.test-apoio.ts";
import { lerZip } from "../exportacao/zip.ts";
import { cod, executor, porTransacao, SENHA_FALSA, vincular } from "../marketing/harness-postgres.ts";
import { baseSintetica, contratoAssinadoMinimo } from "./harness-postgres.ts";
import { assinarToken, lerAnel, type AnelChaves } from "./token.ts";

/**
 * PS-3 rodada 2 (parecer PS3-C-P2-3/P2-4): as TRÊS rotas administrativas reais, com a guarda real
 * (exigirApiAdminCrmDisponivel: sessão, CSRF, origem, situação comercial), withTenantTransaction e plano, sobre um
 * pool de conexões PRÓPRIAS do cluster descartável com BEGIN/COMMIT de verdade (nada de SAVEPOINT): é isso que permite
 * provar espera real em travas de outras transações.
 *   - matriz HTTP: Gestão × Equipe TRATAR × só VER, sessão ausente/inválida/antiga/revogada/senha trocada, CSRF, origem,
 *     sessão da página trocada (409), flag desligada, injeção de empresa/ator no corpo e na query, 404/409/503 com o
 *     corpo JSON e zero efeitos nas recusas;
 *   - atomicidade: falha injetada DEPOIS do UPDATE da conclusão, DEPOIS do INSERT da auditoria e depois do INSERT do
 *     link → 500, nada persiste, e a nova tentativa grava uma vez;
 *   - relógio REAL: vencimento atravessado enquanto a requisição espera na guarda de tenant (empresa travada por outra
 *     transação) e na tarefa; início atravessado na espera (autoriza); revogação (b) composta — conclusão esperando
 *     na tarefa com o FOR SHARE da concessão já tomado, revogador esperando na concessão;
 *   - instalação: AUSENTE e PARCIAL (só links, só auditoria, sem o gatilho TRUNCATE, funções sem tabelas, coerência
 *     desligada) em TODAS as superfícies (GET de tarefas, conclusão, links, página pública, exportação, down), down
 *     sem mudar o catálogo, preservação das linhas da 110, restauração da 111 com falha injetada depois do INSERT e
 *     captura idêntica por hash;
 *   - exportação A/B com eventos reais de link e conclusão: CSV/manifesto só da empresa, contagens e hashes.
 */
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
const carregar = <T>(arquivo: string) => exigir(resolve(root, arquivo)) as T;

process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${"x".repeat(24)}`;
const anel = lerAnel({ SATISFACAO_LINK_CHAVES: `1:${randomBytes(32).toString("base64")}`, SATISFACAO_LINK_CHAVE_ATUAL: "1" }) as AnelChaves;
const GESTAO = "REPRESENTANTE_AUTORIZADO";
const ORIGEM = "http://localhost:3000";

type Corpo = { ok: boolean; data?: Record<string, unknown> & { tarefas?: Array<{ id: string; estabelecimentoId: string | null }> }; erro?: string; codigo?: string; detalhes?: unknown };
type Resposta = { status: number; json(): Promise<Corpo> };
type Acesso = { id: string; token: string; csrf: string; usuario: string };
type Tx = { query: (sql: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

const pid = async (c: Client) => Number((await c.query(`SELECT pg_backend_pid() AS p`)).rows[0].p);
const dormir = (ms: number) => new Promise((fim) => setTimeout(fim, ms));
const sha = (texto: string) => createHash("sha256").update(texto).digest("hex");

test("PS-3 pelas rotas reais: matriz HTTP, atomicidade, relógio real, instalação e exportação", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const anterior = { NODE_ENV: process.env.NODE_ENV, ADMIN_AUTH_ORIGIN: process.env.ADMIN_AUTH_ORIGIN, RENDER: process.env.RENDER, KIDMAIS_DEPLOY_ENV: process.env.KIDMAIS_DEPLOY_ENV, FLAG: process.env.SATISFACAO_PESQUISA_ENABLED };
  (process.env as { NODE_ENV?: string }).NODE_ENV = "test";
  process.env.ADMIN_AUTH_ORIGIN = ORIGEM;
  process.env.SATISFACAO_PESQUISA_ENABLED = "true";
  delete process.env.RENDER;
  delete process.env.KIDMAIS_DEPLOY_ENV;

  const c = await conectarDescartavel();
  const extras: Client[] = [];
  for (let i = 0; i < 6; i++) extras.push(await conectarDescartavel({ travar: false }));
  const [auto, r1, r2, r3, c3, c4] = extras;
  try {
    // ---- pool real: `query` em autocommit numa conexão; `connect` entrega uma conexão livre (BEGIN/COMMIT reais) ----
    const livres = [r1, r2, r3];
    const pidsRota = [await pid(r1), await pid(r2), await pid(r3)];
    let falhaDepois: RegExp | null = null;
    (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool = {
      query: (sql: string, v?: unknown[]) => auto.query(sql, v),
      connect: async () => {
        const cx = livres.shift();
        if (!cx) throw new Error("pool da suíte esgotado");
        return {
          query: async (sql: string, v?: unknown[]) => {
            const r = await cx.query(sql, v);
            if (falhaDepois && falhaDepois.test(sql)) { falhaDepois = null; throw new Error("falha injetada pela suíte"); }
            return r;
          },
          release() { livres.push(cx); },
        };
      },
    };
    const { withTransaction } = carregar<{ withTransaction: <T>(w: (tx: Tx) => Promise<T>) => Promise<T> }>("lib/db/postgres.ts");
    const envios = carregar<{ criarEnvio: Parameters<typeof baseSintetica>[2] }>("lib/satisfacao/envios.ts");
    const publico = carregar<Record<"abrirPesquisa" | "responderPesquisa", (corpo: unknown, ctx: { ip: string | null }, deps: unknown) => Promise<Record<string, unknown>>>>("lib/satisfacao/publico.ts");
    const links = carregar<{ salvarLink(tx: Tx, t: unknown, e: { estabelecimentoId: string | null; url: string }): Promise<unknown> }>("lib/satisfacao/links.ts");
    const instalacao = carregar<{ estadoInstalacao111(tx: Tx): Promise<string> }>("lib/satisfacao/instalacao.ts");
    const pacote = carregar<{ gerarPacote(tx: Tx, empresa: string): Promise<{ zipCaminho: string; manifesto: { arquivos: Array<{ caminho: string; tabela?: string; linhas?: number; sha256: string }>; entidadesAusentes: Array<{ tabela: string }> }; limpar(): Promise<void> }> }>("lib/exportacao/pacote.ts");
    type Rota = Record<"GET" | "POST", (request: unknown, ctx?: unknown) => Promise<Resposta>>;
    const rotaTarefas = carregar<Rota>("app/api/admin/satisfacao/tarefas/route.ts");
    const rotaConcluir = carregar<Rota>("app/api/admin/satisfacao/tarefas/[id]/concluir/route.ts");
    const rotaLinks = carregar<Rota>("app/api/admin/satisfacao/links/route.ts");
    const { NextRequest } = exigir("next/server") as { NextRequest: new (url: string, init: { method: string; headers: Headers; body?: string }) => unknown };

    const emTransacao = porTransacao(c);
    const um = async (sql: string, v: unknown[] = []) => (await c.query(sql, v)).rows[0];
    const tx = executor(c);
    let ipN = 0;
    const ip = () => `203.0.113.${(++ipN % 250) + 1}`;
    const deps = () => ({ withTransaction, anel: () => anel, repeticao: { esperar: async () => {} } });

    const identidade = (papel: string) => async (db: Client) => (await db.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
      VALUES ($1, 'Pessoa sintética PS-3 rotas', $2, $3, true) RETURNING id::text AS id`, [`${cod("r")}@pesquisa.test`, SENHA_FALSA, papel])).rows[0].id;
    const { A, B, usuario, festa, execucao } = await baseSintetica(c, anel, envios.criarEnvio, identidade(GESTAO));

    async function sessao(usuarioId: string, empresa: string): Promise<Acesso> {
      const token = randomBytes(32).toString("base64url"), csrf = randomBytes(32).toString("base64url");
      const id = (await emTransacao(() => c.query(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
        VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours', $4::uuid) RETURNING id::text AS id`, [usuarioId, hashToken(token), hashToken(csrf), empresa]))).rows[0].id as string;
      return { id, token, csrf, usuario: usuarioId };
    }
    function pedido(metodo: string, url: string, acesso: Acesso | null, corpo?: unknown, cab: Record<string, string | null> = {}) {
      const h = new Headers({ origin: ORIGEM, host: "localhost:3000", "content-type": "application/json" });
      if (acesso) { h.set("cookie", `kidmais_admin_dev=${acesso.token}`); h.set("x-csrf-token", acesso.csrf); }
      for (const [k, v] of Object.entries(cab)) { if (v === null) h.delete(k); else h.set(k, v); }
      return new NextRequest(`${ORIGEM}${url}`, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    }
    const resp = async (r: Promise<Resposta>) => { const x = await r; return { status: x.status, corpo: await x.json() }; };
    const listar = (a: Acesso | null, query = "", cab: Record<string, string | null> = {}) => resp(rotaTarefas.GET(pedido("GET", `/api/admin/satisfacao/tarefas${query}`, a, undefined, cab)));
    const concluir = (a: Acesso | null, id: string, corpo: unknown = {}, cab: Record<string, string | null> = {}) =>
      resp(rotaConcluir.POST(pedido("POST", `/api/admin/satisfacao/tarefas/${id}/concluir`, a, corpo, cab), { params: Promise.resolve({ id }) }));
    const verLinks = (a: Acesso | null) => resp(rotaLinks.GET(pedido("GET", "/api/admin/satisfacao/links", a)));
    const gravarLink = (a: Acesso | null, corpo: unknown, cab: Record<string, string | null> = {}) => resp(rotaLinks.POST(pedido("POST", "/api/admin/satisfacao/links", a, corpo, cab)));
    /** Erro no formato das rotas da pesquisa: { ok: false, erro, codigo } (a guarda acrescenta `detalhes`). */
    const erro = (r: { status: number; corpo: Corpo }, status: number, codigo: string, msg: string) => {
      assert.equal(r.status, status, `${msg}: status ${r.status} ${JSON.stringify(r.corpo)}`);
      assert.equal(r.corpo.ok, false, msg);
      assert.equal(r.corpo.codigo, codigo, msg);
      assert.equal(typeof r.corpo.erro, "string", msg);
      assert.equal(r.corpo.data, undefined, msg);
    };
    /** Retrato das linhas que as rotas poderiam mudar (tarefas, links, auditoria): igual antes/depois = zero efeitos. */
    const retrato = async () => (await um(`SELECT
        (SELECT coalesce(json_agg(x ORDER BY x.id), '[]')::text FROM satisfacao_tarefas x) AS tarefas,
        (SELECT coalesce(json_agg(x ORDER BY x.id), '[]')::text FROM satisfacao_links_avaliacao x) AS links,
        (SELECT coalesce(json_agg(x ORDER BY x.id), '[]')::text FROM satisfacao_auditoria x) AS auditoria`)) as Record<string, string>;
    const semEfeito = async <T>(msg: string, f: () => Promise<T>) => { const antes = await retrato(); const r = await f(); assert.deepEqual(await retrato(), antes, `${msg}: zero efeitos`); return r; };

    // ---- unidades, pessoas e concessões ----
    const [U1, U2] = await emTransacao(async () => {
      const ids: string[] = [];
      for (const nome of ["Unidade Centro rotas", "Unidade Norte rotas"]) {
        const u = (await c.query(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, $3, 'SUSPENSO') RETURNING id::text AS id`, [A, cod("u"), nome])).rows[0].id as string;
        await c.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'REPRESENTANTE_AUTORIZADO', 'Pesquisa PS-3 rotas sintética')`, [A, u, usuario]);
        ids.push(u);
      }
      return ids;
    });
    async function pessoaEquipe(empresa = A) {
      return emTransacao(async () => {
        const u = await identidade("ADMINISTRATIVO")(c);
        const v = await vincular(c, empresa, u, "ADMINISTRATIVO");
        return { usuario: u, membership: v.membership };
      });
    }
    /** Vínculo ATIVO em modo réplica (fixture, como na suíte PS-3) e concessão com a foto lida do banco. */
    async function conceder(p: { membership: string }, unidade: string, capacidade = "SATISFACAO_TRATAR", janela: { desde?: string; ate?: string | null } = {}) {
      const vinculo = await emTransacao(async () => {
        await c.query("SET LOCAL session_replication_role = replica");
        return (await c.query(`INSERT INTO membership_estabelecimentos (empresa_id, estabelecimento_id, membership_id, status, vigente_desde, vigente_ate)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'ATIVA', coalesce($4::timestamptz, clock_timestamp() - interval '1 day'), $5::timestamptz) RETURNING id::text AS id`,
          [A, unidade, p.membership, janela.desde ?? null, janela.ate ?? null])).rows[0].id as string;
      });
      const concessao = await emTransacao(async () => (await c.query(`INSERT INTO satisfacao_capacidades (empresa_id, membership_id, estabelecimento_id, capacidade, vinculo_id, vinculo_atualizado_em, concedida_por)
        SELECT v.empresa_id, v.membership_id, v.estabelecimento_id, $2, v.id, v.atualizado_em, $3::uuid FROM membership_estabelecimentos v WHERE v.id = $1::uuid RETURNING id::text AS id`,
        [vinculo, capacidade, usuario])).rows[0].id as string);
      return { vinculo, concessao };
    }
    /** Envio ATIVO (festa com contrato assinado, entrega inicial pendente), ainda sem resposta. */
    async function ativo(unidade: string | null) {
      const { cl, f } = await festa({ assinado: false });
      if (unidade) await emTransacao(async () => { await c.query(`UPDATE fechamentos SET estabelecimento_id = $2::uuid WHERE id = $1::uuid AND estabelecimento_id IS NULL`, [f, unidade]); });
      await emTransacao(() => contratoAssinadoMinimo(c, f));
      const x = await execucao(A, cl, f);
      const r = await emTransacao((t2) => envios.criarEnvio(t2, anel, { empresaId: A, execucaoId: x, canais: ["EMAIL"], agendadaPara: new Date(), maxTentativas: 3 }));
      if (!r.criado) throw new Error(`fixture: envio não criado (${r.motivo})`);
      return { f, envio: r.envioId!, token: assinarToken(anel, r.envioId!, 1, anel.atual) };
    }
    async function respondida(unidade: string | null, nota: number) {
      const { f, envio, token } = await ativo(unidade);
      const resposta = await publico.responderPesquisa({ token, notaIndicacao: nota, comentario: "Comentário sintético" }, { ip: ip() }, deps());
      const tarefa = (await um(`SELECT id::text FROM satisfacao_tarefas WHERE envio_id = $1::uuid`, [envio]))?.id as string | undefined;
      return { f, envio, token, resposta, tarefa };
    }
    const tarefaEm = async (unidade: string | null) => { const r = await respondida(unidade, 3); assert.ok(r.tarefa); return r.tarefa!; };
    const estadoTarefa = (id: string) => um(`SELECT estado, concluida_em::text AS concluida_em, concluida_por::text AS por, observacao FROM satisfacao_tarefas WHERE id = $1::uuid`, [id]);
    const auditorias = async (tarefa: string) => (await c.query(`SELECT criado_em::text AS criado_em, ator_usuario_id::text AS ator FROM satisfacao_auditoria WHERE tarefa_id = $1::uuid`, [tarefa])).rows;

    /** Espera (com prazo) até alguma conexão das ROTAS estar bloqueada por `bloqueador` num SQL que contém `trecho`. */
    async function rotaBloqueada(bloqueador: number, trecho: string) {
      for (let i = 0; i < 500; i++) {
        await auto.query(`SELECT pg_stat_clear_snapshot()`);
        const r = (await auto.query(`SELECT a.query FROM pg_stat_activity a WHERE a.pid = ANY($1::int[]) AND $2::int = ANY(pg_blocking_pids(a.pid))`, [pidsRota, bloqueador])).rows;
        if (r.some((x) => String(x.query).includes(trecho))) return;
        await dormir(10);
      }
      throw new Error(`nenhuma rota bloqueada por ${bloqueador} em "${trecho}"`);
    }
    async function bloqueadoPorRota(alvo: number, trecho: string) {
      for (let i = 0; i < 500; i++) {
        await auto.query(`SELECT pg_stat_clear_snapshot()`);
        const r = (await auto.query(`SELECT a.query, pg_blocking_pids(a.pid) && $2::int[] AS b FROM pg_stat_activity a WHERE a.pid = $1::int`, [alvo, pidsRota])).rows[0];
        if (r?.b && String(r.query).includes(trecho)) return;
        await dormir(10);
      }
      throw new Error(`backend ${alvo} não ficou bloqueado por uma conexão da rota em "${trecho}"`);
    }
    /** Barreira com prazo do caso (c): o primeiro dos dois resultados observáveis; o prazo sozinho nunca vale como prova. */
    async function revogadorPresoOuConfirmado(alvo: number, trecho: string, confirmado: () => boolean): Promise<"PRESO" | "CONFIRMADO"> {
      for (let i = 0; i < 500; i++) {
        if (confirmado()) return "CONFIRMADO";
        await auto.query(`SELECT pg_stat_clear_snapshot()`);
        const r = (await auto.query(`SELECT a.query, pg_blocking_pids(a.pid) && $2::int[] AS b FROM pg_stat_activity a WHERE a.pid = $1::int`, [alvo, pidsRota])).rows[0];
        if (r?.b && String(r.query).includes(trecho)) return "PRESO";
        await dormir(10);
      }
      throw new Error(`barreira (c): backend ${alvo} nem bloqueado pela rota em "${trecho}" nem confirmado`);
    }
    /** Espera o relógio REAL do PostgreSQL passar do instante (sem relógio injetado). */
    async function relogioPassou(instante: string) {
      for (let i = 0; i < 1000; i++) {
        if ((await um(`SELECT clock_timestamp() > $1::timestamptz AS ok`, [instante])).ok) return;
        await dormir(20);
      }
      throw new Error(`relógio não passou de ${instante}`);
    }
    const daqui = async (ms: number) => (await um(`SELECT (clock_timestamp() + $1::int * interval '1 millisecond')::text AS i`, [ms])).i as string;

    const gestao = await sessao(usuario, A);
    const equipe = await pessoaEquipe();
    await conceder(equipe, U1);
    const equipeSessao = await sessao(equipe.usuario, A);
    const soVer = await pessoaEquipe();
    await conceder(soVer, U1, "SATISFACAO_VER");
    const soVerSessao = await sessao(soVer.usuario, A);
    const gestorB = await emTransacao(async () => { const u = await identidade(GESTAO)(c); await vincular(c, B, u, GESTAO); return u; });
    const gestaoB = await sessao(gestorB, B);
    const L_EMPRESA = "https://search.google.com/local/writereview?placeid=ChIJrotasSintetica001";

    await t.test("matriz: Gestão e Equipe TRATAR pelas rotas; só VER vazio; Equipe sem acesso aos links; injeção de empresa/ator ignorada ou recusada", async () => {
      const t1 = await tarefaEm(U1), t2 = await tarefaEm(U2);
      const g = await listar(gestao);
      assert.equal(g.status, 200);
      assert.ok(g.corpo.data!.tarefas!.some((x) => x.id === t1) && g.corpo.data!.tarefas!.some((x) => x.id === t2));
      const e = await listar(equipeSessao);
      assert.equal(e.status, 200);
      assert.ok(e.corpo.data!.tarefas!.some((x) => x.id === t1));
      assert.ok(e.corpo.data!.tarefas!.every((x) => x.estabelecimentoId === U1), "Equipe só vê a unidade TRATAR");
      assert.deepEqual((await listar(soVerSessao)).corpo.data, { gestao: false, tarefas: [], unidades: [], abertasSemUnidade: null }, "só VER: lista vazia");
      erro(await listar(equipeSessao, `?unidadeId=${U2}`), 404, "NAO_ENCONTRADO", "Equipe filtrando unidade sem TRATAR");
      erro(await listar(gestao, "?unidadeId=nao-uuid"), 404, "NAO_ENCONTRADO", "unidade malformada");
      // Injeção: empresa na query é ignorada (o tenant vem da sessão); empresa/ator no corpo → 400 sem efeito.
      const injetada = await listar(gestaoB, `?empresaId=${A}`);
      assert.equal(injetada.status, 200);
      assert.ok(!injetada.corpo.data!.tarefas!.some((x) => x.id === t1), "empresa B não vê tarefas de A pela query");
      await semEfeito("empresa no corpo", async () => erro(await concluir(gestao, t1, { observacao: null, empresaId: B }), 400, "DADOS_INVALIDOS", "empresa no corpo"));
      await semEfeito("ator no corpo", async () => erro(await concluir(equipeSessao, t1, { concluidaPor: usuario }), 400, "DADOS_INVALIDOS", "ator no corpo"));
      await semEfeito("ator no link", async () => erro(await gravarLink(gestao, { acao: "salvar", estabelecimentoId: null, url: L_EMPRESA, empresaId: B }), 400, "DADOS_INVALIDOS", "empresa no corpo do link"));
      await semEfeito("Equipe nos links", async () => {
        erro(await verLinks(equipeSessao), 403, "SEM_PERMISSAO", "Equipe lendo links");
        erro(await gravarLink(equipeSessao, { acao: "salvar", estabelecimentoId: null, url: L_EMPRESA }), 403, "SEM_PERMISSAO", "Equipe gravando link");
      });
      await semEfeito("Equipe fora do escopo", async () => {
        erro(await concluir(equipeSessao, t2), 404, "NAO_ENCONTRADO", "Equipe em outra unidade");
        erro(await concluir(soVerSessao, t1), 404, "NAO_ENCONTRADO", "só VER");
        erro(await concluir(gestaoB, t1), 404, "NAO_ENCONTRADO", "Gestão de outra empresa");
        erro(await concluir(gestao, randomUUID()), 404, "NAO_ENCONTRADO", "tarefa inexistente");
        erro(await concluir(gestao, "nao-uuid"), 404, "NAO_ENCONTRADO", "id malformado");
      });
      const ok = await concluir(equipeSessao, t1, { observacao: "Liguei para a família." });
      assert.equal(ok.status, 200, `Equipe TRATAR conclui na própria unidade: ${JSON.stringify(ok.corpo)}`);
      assert.deepEqual([ok.corpo.ok, ok.corpo.data!.estado], [true, "CONCLUIDA"]);
      const s = await estadoTarefa(t1);
      assert.deepEqual([s.estado, s.por, s.observacao], ["CONCLUIDA", equipe.usuario, "Liguei para a família."]);
      assert.deepEqual(await auditorias(t1), [{ criado_em: s.concluida_em, ator: equipe.usuario }], "auditoria no mesmo instante, ator da sessão");
      await semEfeito("segunda conclusão", async () => erro(await concluir(gestao, t1), 409, "JA_CONCLUIDA", "segunda conclusão"));
      const link = await gravarLink(gestao, { acao: "salvar", estabelecimentoId: null, url: L_EMPRESA });
      assert.equal(link.status, 200);
      assert.equal((await um(`SELECT ator_usuario_id::text AS a FROM satisfacao_auditoria WHERE empresa_id = $1::uuid AND acao = 'LINK_INCLUIDO' AND url_nova = $2`, [A, L_EMPRESA])).a, usuario);
      // Valor bruto (B'): espaço em volta é recusado pela rota, sem normalizar.
      await semEfeito("link com espaço", async () => erro(await gravarLink(gestao, { acao: "salvar", estabelecimentoId: U1, url: ` ${L_EMPRESA}` }), 400, "LINK_INVALIDO", "espaço inicial"));
      await semEfeito("link com newline", async () => erro(await gravarLink(gestao, { acao: "salvar", estabelecimentoId: U1, url: `${L_EMPRESA}\n` }), 400, "LINK_INVALIDO", "newline final"));
      await semEfeito("link com 501 espaços", async () => erro(await gravarLink(gestao, { acao: "salvar", estabelecimentoId: U1, url: `${" ".repeat(501)}${L_EMPRESA}` }), 400, "LINK_INVALIDO", "501 espaços"));
      await semEfeito("link de unidade da empresa B", async () => {
        const uB = (await um(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, 'Unidade B rotas', 'SUSPENSO') RETURNING id::text AS id`, [B, cod("u")])).id;
        erro(await gravarLink(gestao, { acao: "salvar", estabelecimentoId: uB, url: L_EMPRESA }), 404, "NAO_ENCONTRADO", "unidade de outra empresa");
      });
    });

    await t.test("sessão e guarda: ausente, inválida, antiga, revogada, senha trocada (401); CSRF e origem (403); sessão da página trocada (409); flag desligada (503)", async () => {
      const id = await tarefaEm(U1);
      await semEfeito("guarda", async () => {
        erro(await concluir(null, id), 401, "AUTENTICACAO_ADMINISTRATIVA", "sem cookie");
        erro(await listar({ ...gestao, token: randomBytes(32).toString("base64url") }), 401, "AUTENTICACAO_ADMINISTRATIVA", "token desconhecido");
        erro(await listar({ ...gestao, token: "curto" }), 401, "AUTENTICACAO_ADMINISTRATIVA", "token malformado");
        erro(await concluir(gestao, id, {}, { "x-csrf-token": null }), 403, "AUTENTICACAO_ADMINISTRATIVA", "sem CSRF");
        erro(await concluir(gestao, id, {}, { "x-csrf-token": randomBytes(32).toString("base64url") }), 403, "AUTENTICACAO_ADMINISTRATIVA", "CSRF errado");
        erro(await concluir(gestao, id, {}, { origin: "https://evil.test" }), 403, "AUTENTICACAO_ADMINISTRATIVA", "origem alheia");
        erro(await gravarLink(gestao, { acao: "remover", estabelecimentoId: null }, { origin: null }), 403, "AUTENTICACAO_ADMINISTRATIVA", "sem origem");
        erro(await concluir(gestao, id, {}, { "x-kidmais-sessao": randomUUID() }), 409, "AUTENTICACAO_ADMINISTRATIVA", "sessão da página trocada");
        // Inatividade: pessoa própria com a senha trocada há um dia (isola a regra dos 30 min); controle com 29 min passa.
        const inativa = async (minutos: number) => {
          const u = await emTransacao(async () => { const x = await identidade(GESTAO)(c); await vincular(c, A, x, GESTAO);
            await c.query(`UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 day' WHERE id = $1::uuid`, [x]); return x; });
          const s = await sessao(u, A);
          await emTransacao(() => c.query(`UPDATE sessoes_administrativas SET criado_em = clock_timestamp() - $2::int * interval '1 minute', autenticado_em = clock_timestamp() - $2::int * interval '1 minute',
            ultima_atividade_em = clock_timestamp() - $2::int * interval '1 minute' WHERE id = $1::uuid`, [s.id, minutos]));
          return s;
        };
        erro(await concluir(await inativa(31), id), 401, "AUTENTICACAO_ADMINISTRATIVA", "sessão inativa há 31 min");
        assert.equal((await listar(await inativa(29))).status, 200, "controle: 29 min ainda vale");
        const revogada = await sessao(usuario, A);
        await emTransacao(() => c.query(`UPDATE sessoes_administrativas SET revogado_em = clock_timestamp() WHERE id = $1::uuid`, [revogada.id]));
        erro(await concluir(revogada, id), 401, "AUTENTICACAO_ADMINISTRATIVA", "sessão revogada");
        const trocou = await pessoaEquipe();
        await conceder(trocou, U1);
        const deTrocou = await sessao(trocou.usuario, A);
        await emTransacao(() => c.query(`UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() WHERE id = $1::uuid`, [trocou.usuario]));
        erro(await concluir(deTrocou, id), 401, "AUTENTICACAO_ADMINISTRATIVA", "senha trocada depois do login");
        delete process.env.SATISFACAO_PESQUISA_ENABLED;
        try {
          erro(await concluir(gestao, id), 503, "PESQUISA_INDISPONIVEL", "flag desligada (conclusão)");
          erro(await listar(gestao), 503, "PESQUISA_INDISPONIVEL", "flag desligada (leitura)");
          erro(await gravarLink(gestao, { acao: "remover", estabelecimentoId: null }), 503, "PESQUISA_INDISPONIVEL", "flag desligada (links)");
        } finally { process.env.SATISFACAO_PESQUISA_ENABLED = "true"; }
      });
      assert.equal((await estadoTarefa(id)).estado, "ABERTA");
      assert.equal((await concluir(gestao, id, { observacao: "  " })).status, 200, "a mesma sessão segue válida depois das recusas");
    });

    await t.test("atomicidade: falha depois do UPDATE da conclusão, do INSERT da auditoria e do INSERT do link → 500, nada persiste; nova tentativa grava uma vez", async () => {
      const id = await tarefaEm(U1);
      for (const ponto of [/^UPDATE satisfacao_tarefas SET estado = 'CONCLUIDA'/, /INSERT INTO satisfacao_auditoria/]) {
        await semEfeito(String(ponto), async () => {
          falhaDepois = ponto;
          const r = await concluir(equipeSessao, id, { observacao: "Primeira tentativa" });
          assert.equal(falhaDepois, null, `${ponto}: a falha foi disparada`);
          assert.equal(r.status, 500, `${ponto}: ${JSON.stringify(r.corpo)}`);
          assert.equal(r.corpo.ok, false);
        });
        assert.deepEqual(await estadoTarefa(id), { estado: "ABERTA", concluida_em: null, por: null, observacao: null }, String(ponto));
        assert.deepEqual(await auditorias(id), [], String(ponto));
      }
      const r = await concluir(equipeSessao, id, { observacao: "Nova tentativa" });
      assert.equal(r.status, 200);
      const s = await estadoTarefa(id);
      assert.deepEqual([s.estado, s.observacao, s.por], ["CONCLUIDA", "Nova tentativa", equipe.usuario]);
      assert.deepEqual(await auditorias(id), [{ criado_em: s.concluida_em, ator: equipe.usuario }]);

      const L_U2 = "https://g.page/r/CnorteRotas01/review";
      for (const ponto of [/INSERT INTO satisfacao_links_avaliacao/, /INSERT INTO satisfacao_auditoria/]) {
        await semEfeito(String(ponto), async () => {
          falhaDepois = ponto;
          const x = await gravarLink(gestao, { acao: "salvar", estabelecimentoId: U2, url: L_U2 });
          assert.equal(falhaDepois, null, `${ponto}: a falha foi disparada`);
          assert.equal(x.status, 500);
        });
      }
      assert.equal((await gravarLink(gestao, { acao: "salvar", estabelecimentoId: U2, url: L_U2 })).status, 200);
      assert.equal(Number((await um(`SELECT count(*) AS n FROM satisfacao_auditoria WHERE estabelecimento_id = $1::uuid AND acao = 'LINK_INCLUIDO'`, [U2])).n), 1);
    });

    /**
     * Uma conclusão pela rota que fica presa numa trava de OUTRA transação (c3) enquanto o relógio real atravessa o
     * início ou o fim da vigência. A tarefa e a sessão nascem ANTES da janela; ao ver a rota bloqueada, a suíte confere
     * que o instante ainda NÃO chegou — só então espera o relógio passar e libera.
     */
    async function atravessar(trava: "empresa" | "tarefa", borda: "desde" | "ate") {
      const pessoa = await pessoaEquipe();
      const s = await sessao(pessoa.usuario, A);
      const id = await tarefaEm(U1);
      const instante = await daqui(1500);
      await conceder(pessoa, U1, "SATISFACAO_TRATAR", { [borda]: instante });
      if (borda === "desde") await semEfeito("antes do início", async () => erro(await concluir(s, id), 404, "NAO_ENCONTRADO", "antes do início"));
      const p3 = await pid(c3);
      await c3.query("BEGIN");
      let pendente: Promise<{ status: number; corpo: Corpo }> | null = null;
      try {
        if (trava === "empresa") await c3.query(`SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE`, [A]);
        else await c3.query(`SELECT id FROM satisfacao_tarefas WHERE id = $1::uuid FOR UPDATE`, [id]);
        pendente = concluir(s, id);
        // Qualquer ponto de espera atrás da c3 (a trava esperada ou, num mutante, o UPDATE): o oráculo é o resultado.
        await rotaBloqueada(p3, "");
        assert.equal((await um(`SELECT clock_timestamp() < $1::timestamptz AS antes`, [instante])).antes, true, "a rota ficou presa ANTES da borda");
        await relogioPassou(instante);
        await c3.query("COMMIT");
      } catch (e) { await c3.query("ROLLBACK").catch(() => {}); throw e; }
      return { r: await pendente!, id, pessoa, instante };
    }

    await t.test("relógio real: vencimento atravessado na espera da guarda de tenant e na espera da tarefa → 404 sem efeito; início atravessado → autoriza", async () => {
      for (const trava of ["empresa", "tarefa"] as const) {
        const { r, id } = await atravessar(trava, "ate");
        erro(r, 404, "NAO_ENCONTRADO", `venceu durante a espera (${trava})`);
        assert.equal((await estadoTarefa(id)).estado, "ABERTA", trava);
        assert.deepEqual(await auditorias(id), [], trava);
      }
      const { r, id, pessoa, instante } = await atravessar("tarefa", "desde");
      assert.equal(r.status, 200, `início atravessado na espera: ${JSON.stringify(r.corpo)}`);
      const st = await estadoTarefa(id);
      assert.equal((await um(`SELECT $1::timestamptz >= $2::timestamptz AS ok`, [st.concluida_em, instante])).ok, true, "instante decidido depois da espera");
      assert.equal(r.corpo.data!.concluidaEm, st.concluida_em, "instante retornado = persistido");
      assert.deepEqual(await auditorias(id), [{ criado_em: st.concluida_em, ator: pessoa.usuario }]);
    });

    await t.test("revogação (b) composta: conclusão espera na tarefa com o FOR SHARE da concessão; o revogador espera a conclusão", async () => {
      const pessoa = await pessoaEquipe();
      const { concessao } = await conceder(pessoa, U1);
      const s = await sessao(pessoa.usuario, A);
      const id = await tarefaEm(U1);
      const p3 = await pid(c3), p4 = await pid(c4);
      await c3.query("BEGIN");
      let pendente: Promise<{ status: number; corpo: Corpo }> | null = null;
      let revogacao: Promise<unknown> | null = null;
      try {
        await c3.query(`SELECT id FROM satisfacao_tarefas WHERE id = $1::uuid FOR UPDATE`, [id]);
        pendente = concluir(s, id);
        await rotaBloqueada(p3, "satisfacao:travar-tarefa");
        await c4.query("BEGIN");
        let revogou = false;
        revogacao = c4.query(`UPDATE satisfacao_capacidades SET revogada_em = clock_timestamp(), revogada_por = $2::uuid WHERE id = $1::uuid`, [concessao, usuario]).then((x) => { revogou = true; return x; });
        // O revogador espera a ROTA (dona do FOR SHARE da concessão), não a c3; e não termina antes dela.
        await bloqueadoPorRota(p4, "satisfacao_capacidades");
        await dormir(50);
        assert.equal(revogou, false, "o revogador segue esperando a conclusão (que ainda espera a tarefa)");
        await c3.query("COMMIT");
        const r = await pendente;
        assert.equal(r.status, 200, `conclusão confirma antes da revogação: ${JSON.stringify(r.corpo)}`);
        await revogacao;
        await c4.query("COMMIT");
      } catch (e) { await c3.query("ROLLBACK").catch(() => {}); await c4.query("ROLLBACK").catch(() => {}); throw e; }
      const st = await estadoTarefa(id);
      assert.deepEqual([st.estado, st.por], ["CONCLUIDA", pessoa.usuario]);
      // revogada_em é o clock_timestamp() do UPDATE, avaliado antes da espera: a ordem provada é a de COMMIT, não a do carimbo.
      assert.ok((await um(`SELECT revogada_em FROM satisfacao_capacidades WHERE id = $1::uuid`, [concessao])).revogada_em, "revogação confirmada");
      const outra = await tarefaEm(U1);
      await semEfeito("depois da revogação", async () => erro(await concluir(s, outra), 404, "NAO_ENCONTRADO", "depois da revogação"));
    });

    await t.test("revogação (c) entre a decisão e o COMMIT da conclusão: o FOR SHARE segura o revogador (sem anomalia)", async () => {
      const pessoa = await pessoaEquipe();
      const { concessao } = await conceder(pessoa, U1);
      const s = await sessao(pessoa.usuario, A);
      const id = await tarefaEm(U1);
      const p3 = await pid(c3), p4 = await pid(c4);
      await c3.query("BEGIN");
      let pendente: Promise<{ status: number; corpo: Corpo }> | null = null;
      let revogou = false;
      let revogacao: Promise<unknown> | null = null;
      try {
        // A unidade travada FOR UPDATE prende a rota na FK da auditoria (FOR KEY SHARE), DEPOIS da decisão e do UPDATE.
        await c3.query(`SELECT id FROM estabelecimentos WHERE id = $1::uuid FOR UPDATE`, [U1]);
        pendente = concluir(s, id);
        await rotaBloqueada(p3, "INSERT INTO satisfacao_auditoria");
        await c4.query("BEGIN");
        revogacao = c4.query(`UPDATE satisfacao_capacidades SET revogada_em = clock_timestamp(), revogada_por = $2::uuid WHERE id = $1::uuid`, [concessao, usuario])
          .then(async (x) => { await c4.query("COMMIT"); revogou = true; return x; });
        // Barreira observada (nada de janela fixa): ou o revogador aparece bloqueado por uma conexão da ROTA no UPDATE da
        // concessão, ou ele confirma enquanto a rota segue presa (anomalia). Só então a auditoria é liberada.
        const barreira = await revogadorPresoOuConfirmado(p4, "satisfacao_capacidades", () => revogou);
        if (barreira === "PRESO") assert.equal(revogou, false, "preso pela rota: ainda não confirmou");
        await c3.query("COMMIT");
        const r = await pendente;
        await revogacao;
        assert.ok(!(barreira === "CONFIRMADO" && r.status === 200), "anomalia: revogação confirmada antes e conclusão autorizada");
        assert.equal(barreira, "PRESO", "o revogador ficou bloqueado pela conexão da rota até o COMMIT da conclusão");
        assert.equal(r.status, 200, JSON.stringify(r.corpo));
      } catch (e) { await c3.query("ROLLBACK").catch(() => {}); await c4.query("ROLLBACK").catch(() => {}); throw e; }
      assert.deepEqual([(await estadoTarefa(id)).estado, (await auditorias(id)).length], ["CONCLUIDA", 1]);
    });

    // ---- exportação ----
    async function exportar(empresa: string) {
      await c4.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        await c4.query("SET LOCAL TimeZone = 'UTC'");
        const p = await pacote.gerarPacote(executor(c4) as unknown as Tx, empresa);
        const zip = lerZip(readFileSync(p.zipCaminho));
        await p.limpar();
        await c4.query("COMMIT");
        return { manifesto: p.manifesto, zip };
      } catch (e) { await c4.query("ROLLBACK").catch(() => {}); throw e; }
    }
    const csv = (pac: Awaited<ReturnType<typeof exportar>>, tabela: string) => {
      const a = pac.manifesto.arquivos.find((x) => x.tabela === tabela);
      if (!a) return null;
      const bytes = pac.zip.get(a.caminho)!;
      assert.equal(createHash("sha256").update(bytes).digest("hex"), a.sha256, `${tabela}: sha256 do manifesto`);
      const [cab, ...linhas] = lerCsv(bytes.toString("utf8")).filter((l) => l.length > 1 || l[0] !== "");
      assert.equal(linhas.length, a.linhas, `${tabela}: linhas do manifesto`);
      return linhas.map((l) => Object.fromEntries(cab.map((k, i) => [k, l[i]])));
    };

    await t.test("exportação A/B com eventos reais de link e conclusão: só a própria empresa, contagens e hashes", async () => {
      const L_B = "https://g.page/r/CempresaBrotas1/review";
      const membB = (await um(`SELECT id::text FROM memberships WHERE empresa_id = $1::uuid AND usuario_id = $2::uuid`, [B, gestorB])).id;
      await withTransaction((x) => links.salvarLink(x, { empresaComprovada: B, membershipId: membB, usuarioId: gestorB, papelAtual: GESTAO }, { estabelecimentoId: null, url: L_B }));
      const id = await tarefaEm(U1);
      assert.equal((await concluir(gestao, id, { observacao: "Exportação A/B" })).status, 200);
      const pa = await exportar(A), pb = await exportar(B);
      for (const [pac, dona, outra] of [[pa, A, B], [pb, B, A]] as const) {
        const ls = csv(pac, "satisfacao_links_avaliacao")!, au = csv(pac, "satisfacao_auditoria")!;
        assert.ok(ls && au, "links e auditoria no pacote 111");
        assert.ok(ls.every((l) => l.empresa_id === dona) && au.every((l) => l.empresa_id === dona), "só linhas da empresa");
        assert.equal(ls.length, Number((await um(`SELECT count(*) AS n FROM satisfacao_links_avaliacao WHERE empresa_id = $1::uuid`, [dona])).n));
        assert.equal(au.length, Number((await um(`SELECT count(*) AS n FROM satisfacao_auditoria WHERE empresa_id = $1::uuid`, [dona])).n));
        const tudo = [...pac.zip.values()].map((b) => b.toString("latin1")).join("\n");
        assert.ok(!tudo.includes(outra), "nenhum arquivo cita a outra empresa");
      }
      assert.ok(csv(pa, "satisfacao_links_avaliacao")!.some((l) => l.url === L_EMPRESA) && !csv(pa, "satisfacao_links_avaliacao")!.some((l) => l.url === L_B));
      assert.ok(csv(pb, "satisfacao_links_avaliacao")!.some((l) => l.url === L_B) && !csv(pb, "satisfacao_links_avaliacao")!.some((l) => l.url === L_EMPRESA));
      assert.ok(csv(pa, "satisfacao_auditoria"), "auditoria no pacote 111");
      const conc = csv(pa, "satisfacao_auditoria")!.filter((l) => l.tarefa_id === id);
      assert.equal(conc.length, 1);
      assert.equal(conc[0].acao, "TAREFA_CONCLUIDA");
      assert.equal(conc[0].ator_usuario_id, usuario);
      assert.equal((await um(`SELECT $1::timestamptz = concluida_em AS ok FROM satisfacao_tarefas WHERE id = $2::uuid`, [conc[0].criado_em, id])).ok, true, "instante exportado = concluida_em");
      assert.equal(csv(pa, "satisfacao_tarefas")!.find((l) => l.id === id)!.estado, "CONCLUIDA");
    });

    await t.test("instalação AUSENTE e PARCIAL em todas as superfícies; down sem mudar o catálogo; 110 preservada; restauração com falha injetada e hash idêntico", async () => {
      const r = await respondida(null, 9);
      assert.equal((await publico.abrirPesquisa({ token: r.token }, { ip: ip() }, deps())).linkAvaliacao, L_EMPRESA);
      const aberta = await tarefaEm(U1);
      const captura = async (tabela: string) => (await um(`SELECT coalesce(json_agg(x ORDER BY x.id), '[]'::json)::text AS j FROM ${tabela} x`)).j as string;
      const capLinks = await captura("satisfacao_links_avaliacao"), capAud = await captura("satisfacao_auditoria");
      const hashLinks = sha(capLinks), hashAud = sha(capAud);
      // Envios ATIVOS preparados com a 111 completa, um por estado (AUSENTE + 5 PARCIAL): o POST público de cada um é a
      // única mudança legítima da 110 no ciclo e fica FORA do retrato "nenhum efeito" (que exclui as linhas desses envios).
      const ESTADOS_POST = ["AUSENTE", "coerência desligada", "sem o gatilho TRUNCATE", "só links (auditoria removida)", "só auditoria (links removidos)", "funções sem as tabelas"];
      const novos = new Map<string, { envio: string; token: string }>();
      for (const rotulo of ESTADOS_POST) novos.set(rotulo, await ativo(null));
      const idsNovos = [...novos.values()].map((n) => n.envio);
      const COLUNA_ENVIO: Record<string, string> = { satisfacao_envios: "id", satisfacao_respostas: "envio_id", satisfacao_tarefas: "envio_id", satisfacao_entregas: "envio_id" };
      const TABELAS_110 = ["satisfacao_envios", "satisfacao_respostas", "satisfacao_tarefas", "satisfacao_entregas", "satisfacao_saidas", "satisfacao_capacidades", "satisfacao_agregados_mensais", "satisfacao_expurgos"];
      const linhas110 = async () => Object.fromEntries(await Promise.all(TABELAS_110.map(async (tb) => {
        const filtro = COLUNA_ENVIO[tb] ? `WHERE NOT (x.${COLUNA_ENVIO[tb]} = ANY($1::uuid[]))` : `WHERE cardinality($1::uuid[]) >= 0`;
        return [tb, (await um(`SELECT coalesce(json_agg(x ORDER BY x.id), '[]'::json)::text AS j FROM ${tb} x ${filtro}`, [idsNovos])).j as string] as const;
      })));
      /** Linhas das tabelas da 111 que existirem no estado atual (null = tabela ausente). */
      const linhas111 = async () => Object.fromEntries(await Promise.all(["satisfacao_links_avaliacao", "satisfacao_auditoria"].map(async (tb) =>
        [tb, (await um(`SELECT to_regclass($1) IS NOT NULL AS existe`, [`public.${tb}`])).existe ? await captura(tb) : null] as const)));
      const efeitoPost = (envio: string) => um(`SELECT e.estado,
          (SELECT count(*) FROM satisfacao_respostas x WHERE x.envio_id = e.id)::int AS respostas,
          (SELECT count(*) FROM satisfacao_tarefas x WHERE x.envio_id = e.id AND x.estado = 'ABERTA')::int AS tarefas,
          (SELECT count(*) FROM satisfacao_entregas x WHERE x.envio_id = e.id AND x.estado = 'PENDENTE')::int AS pendentes,
          (SELECT count(*) FROM satisfacao_entregas x WHERE x.envio_id = e.id AND x.estado = 'CANCELADA' AND x.motivo = 'RESPONDIDA')::int AS canceladas
        FROM satisfacao_envios e WHERE e.id = $1::uuid`, [envio]);
      for (const id of idsNovos) assert.deepEqual(await efeitoPost(id), { estado: "ATIVO", respostas: 0, tarefas: 0, pendentes: 1, canceladas: 0 }, "fixture: envio ATIVO com a entrega pendente");
      const antes110 = await linhas110();
      const catalogo = async () => (await um(`SELECT
          (SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class WHERE relname IN ('satisfacao_links_avaliacao', 'satisfacao_auditoria') AND relkind = 'r') AS tabelas,
          (SELECT string_agg(tgname || ':' || tgrelid::regclass::text || ':' || tgenabled::text || ':' || tgtype::text, ',' ORDER BY tgname) FROM pg_trigger WHERE tgname LIKE 'satisfacao_links%' OR tgname LIKE 'satisfacao_auditoria%') AS gatilhos,
          (SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE proname LIKE 'kidmais111_%') AS funcoes,
          (SELECT string_agg(conname || ':' || convalidated::text, ',' ORDER BY conname) FROM pg_constraint WHERE conname LIKE 'satisfacao_links%' OR conname LIKE 'satisfacao_auditoria%') AS restricoes`)) as Record<string, string | null>;
      const DOWN = readFileSync("database/rollback/20261031_111_satisfacao_links_auditoria_down.sql", "utf8");
      const MIGRATION = readFileSync("database/migrations/20261031_111_satisfacao_links_auditoria.sql", "utf8");
      const down = async () => {
        await c.query(`SET kidmais111.captura_confirmada = 'sim'`);
        try { await c.query(DOWN); } catch (e) { await c.query("ROLLBACK"); throw e; } finally { await c.query(`RESET kidmais111.captura_confirmada`); }
      };
      async function superficies(estado: "AUSENTE" | "PARCIAL", rotulo: string) {
        const codigo = estado === "AUSENTE" ? "NAO_INSTALADO" : "INSTALACAO_INCOMPLETA";
        assert.equal(await instalacao.estadoInstalacao111(tx), estado, rotulo);
        const g = await listar(gestao);
        assert.equal(g.status, 200, `${rotulo}: GET de tarefas segue`);
        assert.ok(g.corpo.data!.tarefas!.some((x) => x.id === aberta), rotulo);
        const antes = await linhas110();
        const rc = await concluir(gestao, aberta);
        assert.equal((await estadoTarefa(aberta)).estado, "ABERTA", `${rotulo}: nenhuma tarefa mudou`);
        erro(rc, 503, codigo, `${rotulo}: conclusão`);
        erro(await verLinks(gestao), 503, codigo, `${rotulo}: leitura dos links`);
        erro(await gravarLink(gestao, { acao: "salvar", estabelecimentoId: null, url: L_EMPRESA }), 503, codigo, `${rotulo}: gravação do link`);
        const reaberta = await publico.abrirPesquisa({ token: r.token }, { ip: ip() }, deps());
        assert.deepEqual([reaberta.situacao, reaberta.linkAvaliacao], ["RESPONDIDA", null], `${rotulo}: página pública sem link`);
        assert.deepEqual(await linhas110(), antes, `${rotulo}: superfícies recusadas não mudam a 110`);
        // POST público (F'): a transação de resposta inteira segue normal, só sem link; nenhuma linha da 111 é escrita.
        const novo = novos.get(rotulo)!;
        const antes111 = await linhas111();
        const respondeu = await publico.responderPesquisa({ token: novo.token, notaIndicacao: 3, comentario: "Resposta com a 111 incompleta" }, { ip: ip() }, deps())
          .catch((e: { code?: string; message?: string }) => assert.fail(`${rotulo}: POST público recusado (${e.code ?? e.message})`));
        assert.deepEqual(respondeu, { gravada: true, linkAvaliacao: null }, `${rotulo}: POST público grava sem link`);
        assert.deepEqual(await efeitoPost(novo.envio), { estado: "RESPONDIDO", respostas: 1, tarefas: 1, pendentes: 0, canceladas: 1 }, `${rotulo}: resposta, RESPONDIDO, entrega encerrada e tarefa`);
        await assert.rejects(publico.responderPesquisa({ token: novo.token, notaIndicacao: 2 }, { ip: ip() }, deps()), (e: unknown) => (e as { code?: string }).code === "JA_RESPONDIDA", `${rotulo}: segundo POST`);
        assert.deepEqual(await efeitoPost(novo.envio), { estado: "RESPONDIDO", respostas: 1, tarefas: 1, pendentes: 0, canceladas: 1 }, `${rotulo}: tarefa criada uma única vez`);
        const depois = await publico.abrirPesquisa({ token: novo.token }, { ip: ip() }, deps());
        assert.deepEqual([depois.situacao, depois.linkAvaliacao], ["RESPONDIDA", null], `${rotulo}: reaberta sem link`);
        assert.deepEqual(await linhas111(), antes111, `${rotulo}: o POST não escreveu na 111`);
        assert.deepEqual(await linhas110(), antes, `${rotulo}: o POST só mudou as linhas do próprio envio`);
        if (estado === "AUSENTE") {
          const pac = await exportar(A);
          assert.deepEqual(pac.manifesto.entidadesAusentes.map((x) => x.tabela).filter((x) => x.startsWith("satisfacao_")).sort(), ["satisfacao_auditoria", "satisfacao_links_avaliacao"], rotulo);
          assert.ok(pac.manifesto.arquivos.some((x) => x.tabela === "satisfacao_tarefas"), `${rotulo}: pacote do schema 110`);
          await assert.rejects(c.query(DOWN), /111 ausente/, rotulo);
          await c.query("ROLLBACK");
        } else {
          await assert.rejects(exportar(A), (e: unknown) => (e as { code?: string; httpStatus?: number }).code === "EXPORTACAO_INSTALACAO_INCOMPLETA" && (e as { httpStatus?: number }).httpStatus === 503, `${rotulo}: exportação recusa`);
          const cat = await catalogo();
          await assert.rejects(down(), /111 parcial \(/, `${rotulo}: down recusa`);
          assert.deepEqual(await catalogo(), cat, `${rotulo}: down não removeu nada`);
        }
      }
      const limparResiduos = async () => {
        await c.query(`DROP TABLE IF EXISTS satisfacao_auditoria; DROP TABLE IF EXISTS satisfacao_links_avaliacao;
          DROP FUNCTION IF EXISTS kidmais111_auditoria_coerencia(), kidmais111_auditoria_somente_insercao(), kidmais111_link_guarda()`);
        assert.equal(await instalacao.estadoInstalacao111(tx), "AUSENTE");
      };

      await down();
      await superficies("AUSENTE", "AUSENTE");
      // Primeiro os estados com TODAS as tabelas (a conclusão gravaria de fato sem a conferência), depois os sem tabela.
      const variantes: Array<[string, string]> = [
        ["coerência desligada", `ALTER TABLE satisfacao_auditoria DISABLE TRIGGER satisfacao_auditoria_coerencia`],
        ["sem o gatilho TRUNCATE", `DROP TRIGGER satisfacao_auditoria_truncate ON satisfacao_auditoria`],
        ["só links (auditoria removida)", `DROP TABLE satisfacao_auditoria`],
        ["só auditoria (links removidos)", `DROP TABLE satisfacao_links_avaliacao`],
        ["funções sem as tabelas", `DROP TABLE satisfacao_auditoria; DROP TABLE satisfacao_links_avaliacao`],
      ];
      for (const [rotulo, ddl] of variantes) {
        await c.query(MIGRATION);
        await c.query(ddl);
        await superficies("PARCIAL", rotulo);
        await limparResiduos();
      }

      // Restauração: 111 de novo; importação com falha injetada depois do INSERT volta inteira; a repetição é idêntica.
      await c.query(MIGRATION);
      await c.query(readFileSync("database/checks/20261031_111_postcheck.sql", "utf8"));
      const importar = (falhar: boolean) => emTransacao(async () => {
        await c.query(`INSERT INTO satisfacao_links_avaliacao SELECT * FROM json_populate_recordset(NULL::satisfacao_links_avaliacao, $1::json)`, [capLinks]);
        await c.query(`INSERT INTO satisfacao_auditoria SELECT * FROM json_populate_recordset(NULL::satisfacao_auditoria, $1::json)`, [capAud]);
        if (falhar) throw new Error("falha injetada depois do INSERT");
      });
      await assert.rejects(importar(true), /falha injetada depois do INSERT/);
      assert.deepEqual([await captura("satisfacao_links_avaliacao"), await captura("satisfacao_auditoria")], ["[]", "[]"], "a falha não deixou linhas");
      await importar(false);
      assert.deepEqual([sha(await captura("satisfacao_links_avaliacao")), sha(await captura("satisfacao_auditoria"))], [hashLinks, hashAud], "restauração idêntica por hash");
      assert.deepEqual(await linhas110(), antes110, "a 110 não mudou no ciclo inteiro (down, variantes, restauração)");
      assert.equal(await instalacao.estadoInstalacao111(tx), "COMPLETA");
      assert.equal((await publico.abrirPesquisa({ token: r.token }, { ip: ip() }, deps())).linkAvaliacao, L_EMPRESA, "link de volta");
      assert.equal((await concluir(gestao, aberta)).status, 200, "conclusão de volta");
    });
  } finally {
    (process.env as { NODE_ENV?: string }).NODE_ENV = anterior.NODE_ENV;
    for (const [k, v] of Object.entries({ ADMIN_AUTH_ORIGIN: anterior.ADMIN_AUTH_ORIGIN, RENDER: anterior.RENDER, KIDMAIS_DEPLOY_ENV: anterior.KIDMAIS_DEPLOY_ENV, SATISFACAO_PESQUISA_ENABLED: anterior.FLAG })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool;
    for (const x of extras.reverse()) await encerrarDescartavel(x, false);
    await encerrarDescartavel(c);
  }
});
