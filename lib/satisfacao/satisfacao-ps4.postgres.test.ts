import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Client } from "pg";
import { hashToken } from "../autenticacao/senha.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { cod, SENHA_FALSA, vincular } from "../marketing/harness-postgres.ts";
import { baseSintetica, contratoAssinadoMinimo } from "./harness-postgres.ts";
import { lerAnel, type AnelChaves } from "./token.ts";

/**
 * PS-4 (plano rev. 0 + rev. 1 + rev. 1.1; D-PS4-1..6) pelas ROTAS reais (guarda, withTenantTransaction, plano), sobre
 * conexões próprias do cluster descartável (BEGIN/COMMIT reais), como a suíte de rotas da PS-3:
 *   - oráculos de NPS (arredondamento do PostgreSQL, meio para longe de zero), taxa, histograma e aspectos;
 *   - população P: festa no período (bordas), REVOGADO, festa cancelada depois da resposta, sem contrato ASSINADO,
 *     ATIVO vencido, EXPIRADO, resposta antiga de link vencido; a tarefa da festa cancelada continua na fila (D-PS4-6);
 *   - autorização: Gestão, VER, só TRATAR (404, D-PS4-2), VER+TRATAR mistos (cartão "X de Y"), revogação, foto do
 *     vínculo, membership futura/vencida, outra empresa, "sem unidade" pela Equipe, flag desligada (503), plano sem
 *     Marketing (403, injeção DECLARADA da leitura do contrato no pool da suíte);
 *   - menu pela rota de autenticação, inclusive a janela de papel (papel muda DEPOIS da leitura de contextoDaSessao);
 *   - JSON com chaves exatas (projeção explícita; `retorno`/`retornosAbertos` ausentes fora de VER ∩ TRATAR);
 *   - cursor: empate de instante, borda de 1 µs, navegação viva (resposta nova entre páginas; revogação → 404);
 *   - filtros e período (365/366/367 datas, 29/02, invertido, data inválida, atalhos no calendário de São Paulo);
 *   - retornos: 201 abertas + 3 concluídas, estado no servidor antes do limite, cursor, Equipe TRATAR sem Marketing.
 * Fixtures de envio/resposta/tarefa com instantes controlados são gravadas em modo réplica (a guarda da resposta
 * carimba clock_timestamp()), numa transação própria — o caminho real de resposta é provado nas suítes PS-1/PS-3.
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

type Json = Record<string, unknown>;
type Corpo = { ok: boolean; data?: Json; erro?: string; codigo?: string };
type Resposta = { status: number; json(): Promise<Corpo> };
type Acesso = { id: string; token: string; csrf: string; usuario: string };
type Pessoa = { usuario: string; membership: string };
type Item = { id: string; respondidaEm: string; notaIndicacao: number; unidade: string | null; primeiroNome: string; retorno?: { tarefaId: string; estado: string } } & Json;
type Resultados = {
  periodo: { inicio: string; fim: string }; unidade: string | null; unidades: Array<{ id: string; nome: string }>; semUnidade: boolean;
  cartoes: Json & { pesquisasCriadas: number; respostas: number; taxa: string | null; aindaNoPrazo: number; semContato: number; nps: number | null;
    grupos: { promotores: number; neutros: number; detratores: number }; histograma: number[];
    aspectos: Record<string, { media: string | null; respostas: number }>; retornosAbertos?: { abertos: number; unidadesComTratar: number; unidadesNoFiltro: number } };
  lista: { total: number; totalFiltrado: number; itens: Item[]; proximo: string | null };
};
type Tarefa = { id: string; estabelecimentoId: string | null; estado: string; criadaEm: string; concluidaEm: string | null } & Json;
type Painel = { gestao: boolean; tarefas: Tarefa[]; unidades: Json[]; abertasSemUnidade: number | null; totalNoEstado: number; proximo: string | null };

const DIA = 86_400_000;
const somarDias = (data: string, n: number) => new Date(Date.parse(`${data}T00:00:00Z`) + n * DIA).toISOString().slice(0, 10);
/** Ordem decrescente estrita por (instante, id); instantes no formato fixo com µs e uuids minúsculos comparam como texto. */
const emOrdem = <T>(itens: T[], chave: (x: T) => [string, string]) => itens.every((x, i) => {
  if (i === 0) return true;
  const [a, ia] = chave(itens[i - 1]), [b, ib] = chave(x);
  return a > b || (a === b && ia > ib);
});

test("PS-4 pelas rotas reais: métricas, população, escopos, menu, cursor, período e retornos", { timeout: 900_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const anterior = { NODE_ENV: process.env.NODE_ENV, ADMIN_AUTH_ORIGIN: process.env.ADMIN_AUTH_ORIGIN, RENDER: process.env.RENDER, KIDMAIS_DEPLOY_ENV: process.env.KIDMAIS_DEPLOY_ENV, FLAG: process.env.SATISFACAO_PESQUISA_ENABLED };
  (process.env as { NODE_ENV?: string }).NODE_ENV = "test";
  process.env.ADMIN_AUTH_ORIGIN = ORIGEM;
  process.env.SATISFACAO_PESQUISA_ENABLED = "true";
  delete process.env.RENDER;
  delete process.env.KIDMAIS_DEPLOY_ENV;

  const c = await conectarDescartavel();
  const extras: Client[] = [];
  for (let i = 0; i < 4; i++) extras.push(await conectarDescartavel({ travar: false }));
  const [auto, r1, r2, r3] = extras;
  try {
    // ---- pool da suíte: conexões próprias; ganchos DECLARADOS (plano injetado; ação depois de um SQL) ----
    const livres = [r1, r2, r3];
    const planoEssencial = new Set<string>();
    /** Ação depois da n-ésima ocorrência do trecho; `sonda` só conta (para achar a ÚLTIMA leitura antes do menu). */
    let depoisDe: { trecho: string; n: number; acao: () => Promise<void> } | null = null;
    let sonda: { trecho: string; n: number } | null = null;
    /** PS4-R4.5: observa a MESMA conexão da rota antes e depois de cada instrução (consultas próprias, fora do gancho). */
    let espiar: ((cx: Client, sql: string, v: unknown[] | undefined, fase: "antes" | "depois") => Promise<void>) | null = null;
    const passar = async (cx: Client, sql: string, v?: unknown[]) => {
      if (sql.includes("FROM empresa_assinaturas a") && sql.includes("assinatura_contratacoes") && planoEssencial.has(String(v?.[0]))) return { rows: [{ plano: "ESSENCIAL" }] };
      if (espiar) await espiar(cx, sql, v, "antes");
      const r = await cx.query(sql, v);
      if (espiar) await espiar(cx, sql, v, "depois");
      if (sonda && sql.includes(sonda.trecho)) sonda.n++;
      if (depoisDe && sql.includes(depoisDe.trecho) && --depoisDe.n === 0) { const acao = depoisDe.acao; depoisDe = null; await acao(); }
      return r;
    };
    (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool = {
      query: (sql: string, v?: unknown[]) => passar(auto, sql, v),
      connect: async () => {
        const cx = livres.shift();
        if (!cx) throw new Error("pool da suíte esgotado");
        return { query: (sql: string, v?: unknown[]) => passar(cx, sql, v), release() { livres.push(cx); } };
      },
    };
    const envios = carregar<{ criarEnvio: Parameters<typeof baseSintetica>[2] }>("lib/satisfacao/envios.ts");
    type Rota = Record<"GET", (request: unknown) => Promise<Resposta>>;
    const rotaResultados = carregar<Rota>("app/api/admin/satisfacao/resultados/route.ts");
    const rotaTarefas = carregar<Rota>("app/api/admin/satisfacao/tarefas/route.ts");
    const rotaAutenticacao = carregar<Rota>("app/api/admin/autenticacao/route.ts");
    const { NextRequest } = exigir("next/server") as { NextRequest: new (url: string, init: { method: string; headers: Headers }) => unknown };

    const um = async (sql: string, v: unknown[] = []) => (await c.query(sql, v)).rows[0];
    const identidade = (papel: string) => async (db: Client) => (await db.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
      VALUES ($1, 'Pessoa sintética PS-4', $2, $3, true) RETURNING id::text AS id`, [`${cod("p4")}@pesquisa.test`, SENHA_FALSA, papel])).rows[0].id;
    const { A, B, usuario, regraA, emTransacao, festa, execucao, cancelarFesta } = await baseSintetica(c, anel, envios.criarEnvio, identidade(GESTAO));
    const gestorB = await emTransacao(async () => { const u = await identidade(GESTAO)(c); await vincular(c, B, u, GESTAO); return u; });
    const regraB = (await um(`INSERT INTO marketing_automacao_regras (empresa_id, tipo, acao, espera_dias, canais, criado_por, atualizado_por)
      VALUES ($1::uuid, 'POS_FESTA', 'PESQUISA_SATISFACAO', 1, '{EMAIL}', $2::uuid, $2::uuid) RETURNING id::text AS id`, [B, gestorB])).id as string;

    async function sessao(usuarioId: string, empresa: string): Promise<Acesso> {
      const token = randomBytes(32).toString("base64url"), csrf = randomBytes(32).toString("base64url");
      const id = (await emTransacao(() => c.query(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
        VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours', $4::uuid) RETURNING id::text AS id`, [usuarioId, hashToken(token), hashToken(csrf), empresa]))).rows[0].id as string;
      return { id, token, csrf, usuario: usuarioId };
    }
    function pedido(url: string, acesso: Acesso) {
      const h = new Headers({ origin: ORIGEM, host: "localhost:3000" });
      h.set("cookie", `kidmais_admin_dev=${acesso.token}; kidmais_admin_csrf_dev=${acesso.csrf}`);
      h.set("x-csrf-token", acesso.csrf);
      return new NextRequest(`${ORIGEM}${url}`, { method: "GET", headers: h });
    }
    const resp = async (r: Promise<Resposta>) => { const x = await r; return { status: x.status, corpo: await x.json() }; };
    const resultados = (a: Acesso, q: Record<string, string> = {}) => resp(rotaResultados.GET(pedido(`/api/admin/satisfacao/resultados?${new URLSearchParams(q)}`, a)));
    const retornos = (a: Acesso, q: Record<string, string> = {}) => resp(rotaTarefas.GET(pedido(`/api/admin/satisfacao/tarefas?${new URLSearchParams(q)}`, a)));
    const menu = async (a: Acesso) => {
      const r = await resp(rotaAutenticacao.GET(pedido("/api/admin/autenticacao", a)));
      assert.equal(r.status, 200);
      assert.equal(r.corpo.data!.usuarioId, a.usuario, "sessão válida na rota de autenticação");
      return (r.corpo.data!.recursos as { satisfacao: unknown }).satisfacao;
    };
    async function ok<T>(p: Promise<{ status: number; corpo: Corpo }>, msg: string): Promise<T> {
      const r = await p;
      assert.equal(r.status, 200, `${msg}: ${r.status} ${JSON.stringify(r.corpo)}`);
      return r.corpo.data as T;
    }
    async function recusa(p: Promise<{ status: number; corpo: Corpo }>, status: number, codigo: string, msg: string) {
      const r = await p;
      assert.equal(r.status, status, `${msg}: ${r.status} ${JSON.stringify(r.corpo)}`);
      assert.equal(r.corpo.ok, false, msg);
      assert.equal(r.corpo.codigo, codigo, msg);
      assert.equal(r.corpo.data, undefined, `${msg}: nenhum dado na recusa`);
    }

    // ---- unidades, pessoas, concessões ----
    async function unidade(empresa: string, nome: string, habilitador: string) {
      return emTransacao(async () => {
        const u = (await c.query(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, $3, 'SUSPENSO') RETURNING id::text AS id`, [empresa, cod("u"), nome])).rows[0].id as string;
        await c.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'REPRESENTANTE_AUTORIZADO', 'Pesquisa PS-4 sintética')`, [empresa, u, habilitador]);
        return u;
      });
    }
    const U1 = await unidade(A, "Unidade Centro PS4", usuario), U2 = await unidade(A, "Unidade Norte PS4", usuario);
    const UB = await unidade(B, "Unidade B PS4", gestorB);
    async function pessoaEquipe(empresa = A): Promise<Pessoa> {
      return emTransacao(async () => {
        const u = await identidade("ADMINISTRATIVO")(c);
        const v = await vincular(c, empresa, u, "ADMINISTRATIVO");
        return { usuario: u, membership: v.membership };
      });
    }
    /** Vínculo ATIVO em modo réplica (fixture das suítes PS-3; um por pessoa e unidade, reaproveitado) e concessão pelo
     *  caminho normal com a foto lida do banco. */
    async function conceder(p: Pessoa, u: string, capacidade: "SATISFACAO_VER" | "SATISFACAO_TRATAR", empresa = A, janela: { ate?: string } = {}) {
      const existente = (await um(`SELECT id::text AS id FROM membership_estabelecimentos WHERE membership_id = $1::uuid AND estabelecimento_id = $2::uuid`, [p.membership, u]))?.id as string | undefined;
      const vinculo = existente ?? await emTransacao(async () => {
        await c.query("SET LOCAL session_replication_role = replica");
        return (await c.query(`INSERT INTO membership_estabelecimentos (empresa_id, estabelecimento_id, membership_id, status, vigente_desde, vigente_ate)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'ATIVA', clock_timestamp() - interval '1 day', $4::timestamptz) RETURNING id::text AS id`, [empresa, u, p.membership, janela.ate ?? null])).rows[0].id as string;
      });
      const concessao = await emTransacao(async () => (await c.query(`INSERT INTO satisfacao_capacidades (empresa_id, membership_id, estabelecimento_id, capacidade, vinculo_id, vinculo_atualizado_em, concedida_por)
        SELECT v.empresa_id, v.membership_id, v.estabelecimento_id, $2, v.id, v.atualizado_em, $3::uuid FROM membership_estabelecimentos v WHERE v.id = $1::uuid RETURNING id::text AS id`,
        [vinculo, capacidade, empresa === A ? usuario : gestorB])).rows[0].id as string);
      return { vinculo, concessao };
    }
    const revogar = (concessao: string) => emTransacao(() => c.query(`UPDATE satisfacao_capacidades SET revogada_em = clock_timestamp(), revogada_por = $2::uuid WHERE id = $1::uuid`, [concessao, usuario]));

    // ---- datas de festa (cada festa num dia próprio; cada caso usa a sua faixa) ----
    let diaN = 0;
    const BASE = "2031-01-01";
    const novaData = () => somarDias(BASE, diaN++);
    const proxima = () => somarDias(BASE, diaN);
    const ultima = () => somarDias(BASE, diaN - 1);

    type Op = {
      empresa?: string; unidade?: string | null; data?: string; estado?: "ATIVO" | "RESPONDIDO" | "EXPIRADO" | "REVOGADO";
      nota?: number; comida?: number | null; equipe?: number | null; espaco?: number | null; comentario?: string | null;
      respondidoEm?: string; respostaId?: string; criadoDiasAtras?: number; contato?: boolean; semContrato?: boolean; nome?: string;
      tarefa?: "ABERTA" | "CONCLUIDA"; tarefaEm?: string; concluidaEm?: string;
    };
    /** Festa real (fixture do harness) + envio/resposta/tarefa com instantes controlados, em modo réplica numa transação própria. */
    async function envio(o: Op = {}) {
      const empresa = o.empresa ?? A;
      const { cl, f } = await festa({ empresaId: empresa, assinado: false, data: o.data ?? novaData(), nome: o.nome });
      if (o.unidade) await emTransacao(async () => { await c.query(`UPDATE fechamentos SET estabelecimento_id = $2::uuid WHERE id = $1::uuid`, [f, o.unidade]); });
      if (!o.semContrato) await emTransacao(() => contratoAssinadoMinimo(c, f));
      const x = await execucao(empresa, cl, f, "PESQUISA_SATISFACAO", empresa === A ? regraA : regraB);
      const estado = o.estado ?? (o.nota === undefined ? "ATIVO" : "RESPONDIDO");
      const id = randomUUID();
      const r = await emTransacao(async () => {
        await c.query("SET LOCAL session_replication_role = replica");
        const e = (await c.query(`INSERT INTO satisfacao_envios (id, empresa_id, estabelecimento_id, fechamento_id, cliente_id, execucao_id, chave_versao, token_hash, estado,
            criado_em, expira_em, contato_em, respondido_em, expirado_em, revogado_em, motivo_revogacao)
          SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 1, $7::bytea, $8::text, k.c, k.c + interval '30 days',
                 CASE WHEN $9::boolean THEN k.c + interval '1 minute' END,
                 CASE WHEN $8::text = 'RESPONDIDO' THEN coalesce($10::timestamptz, k.c + interval '1 hour') END,
                 CASE WHEN $8::text = 'EXPIRADO' THEN k.c + interval '30 days' END,
                 CASE WHEN $8::text = 'REVOGADO' THEN clock_timestamp() END,
                 CASE WHEN $8::text = 'REVOGADO' THEN 'FESTA_CANCELADA' END
            FROM (SELECT clock_timestamp() - $11::numeric * interval '1 day' AS c) k
          RETURNING respondido_em::text AS respondido_em`, [id, empresa, o.unidade ?? null, f, cl, x, randomBytes(32), estado, Boolean(o.contato), o.respondidoEm ?? null, o.criadoDiasAtras ?? 1])).rows[0];
        if (estado !== "RESPONDIDO") return { resposta: null as string | null, tarefa: null as string | null };
        const resposta = (await c.query(`INSERT INTO satisfacao_respostas (id, empresa_id, envio_id, versao_questionario, nota_indicacao, nota_comida, nota_equipe, nota_espaco, comentario, respondido_em)
          VALUES (coalesce($9::uuid, gen_random_uuid()), $1::uuid, $2::uuid, 1, $3, $4, $5, $6, $7, $8) RETURNING id::text AS id`,
          [empresa, id, o.nota, o.comida ?? null, o.equipe ?? null, o.espaco ?? null, o.comentario ?? null, e.respondido_em, o.respostaId ?? null])).rows[0].id as string;
        const tarefa = o.tarefa ? (await c.query(`INSERT INTO satisfacao_tarefas (empresa_id, estabelecimento_id, envio_id, resposta_id, estado, criado_em, concluida_em, concluida_por, observacao)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, coalesce($6::timestamptz, $7::timestamptz), CASE WHEN $5 = 'CONCLUIDA' THEN coalesce($8::timestamptz, clock_timestamp()) END,
                  CASE WHEN $5 = 'CONCLUIDA' THEN $9::uuid END, CASE WHEN $5 = 'CONCLUIDA' THEN 'Retorno sintético' END) RETURNING id::text AS id`,
          [empresa, o.unidade ?? null, id, resposta, o.tarefa, o.tarefaEm ?? null, e.respondido_em, o.concluidaEm ?? null, empresa === A ? usuario : gestorB])).rows[0].id as string : null;
        return { resposta, tarefa };
      });
      return { f, cl, envio: id, ...r };
    }
    const instante = async (expr: string, v: unknown[] = []) => (await um(`SELECT (${expr})::timestamptz::text AS i`, v)).i as string;
    const periodo = (inicio: string, fim: string, extra: Record<string, string> = {}) => ({ inicio, fim, ...extra });

    const gestao = await sessao(usuario, A);
    const gestaoB = await sessao(gestorB, B);

    await t.test("NPS (round do PostgreSQL, meio longe de zero), grupos, histograma, taxa e aspectos", async () => {
      const casos: Array<{ notas: number[]; nps: number; ativos?: number; taxa?: string; aspectos?: Array<Partial<Op>> }> = [
        { notas: [10, 10, 9, 7, 3, 8, 9], nps: 43, ativos: 1, taxa: "87.5", aspectos: [{ comida: 5 }, { comida: 4 }, { comida: 4, equipe: 2 }] },
        { notas: [0, 2, 6, 7, 9, 10], nps: -17 },
        { notas: [9, 7, 7, 7, 7, 7, 7, 7], nps: 13 },
        { notas: [0, 7, 7, 7, 7, 7, 7, 7], nps: -13 },
      ];
      for (const caso of casos) {
        const ini = proxima();
        for (const [i, nota] of caso.notas.entries()) await envio({ nota, ...(caso.aspectos?.[i] ?? {}) });
        for (let i = 0; i < (caso.ativos ?? 0); i++) await envio();
        const d = await ok<Resultados>(resultados(gestao, periodo(ini, ultima())), `NPS ${caso.notas}`);
        const k = d.cartoes;
        assert.equal(k.nps, caso.nps, `NPS de ${caso.notas}`);
        assert.equal(k.respostas, caso.notas.length);
        assert.equal(k.pesquisasCriadas, caso.notas.length + (caso.ativos ?? 0));
        assert.deepEqual(k.grupos, { promotores: caso.notas.filter((n) => n >= 9).length, neutros: caso.notas.filter((n) => n === 7 || n === 8).length, detratores: caso.notas.filter((n) => n <= 6).length });
        assert.deepEqual(k.histograma, Array.from({ length: 11 }, (_, n) => caso.notas.filter((x) => x === n).length));
        if (caso.taxa) assert.equal(k.taxa, caso.taxa);
        if (caso.aspectos) assert.deepEqual(k.aspectos, { comida: { media: "4.3", respostas: 3 }, equipe: { media: "2.0", respostas: 1 }, espaco: { media: null, respostas: 0 } });
        assert.equal(d.lista.total, caso.notas.length);
      }
      const ini = proxima();
      await envio(); await envio();
      const zero = (await ok<Resultados>(resultados(gestao, periodo(ini, ultima())), "sem respostas")).cartoes;
      assert.deepEqual([zero.nps, zero.respostas, zero.pesquisasCriadas, zero.taxa], [null, 0, 2, "0.0"]);
      assert.deepEqual(zero.aspectos, { comida: { media: null, respostas: 0 }, equipe: { media: null, respostas: 0 }, espaco: { media: null, respostas: 0 } });
      const vazio = (await ok<Resultados>(resultados(gestao, periodo("2040-01-01", "2040-01-31")), "sem pesquisas")).cartoes;
      assert.deepEqual([vazio.nps, vazio.respostas, vazio.pesquisasCriadas, vazio.taxa, vazio.aindaNoPrazo, vazio.semContato], [null, 0, 0, null, 0, 0]);
    });

    await t.test("população P: bordas da data da festa, REVOGADO, cancelada depois da resposta, sem contrato, ATIVO vencido, EXPIRADO, resposta antiga", async () => {
      await envio({ nota: 10 });                                  // véspera do período: fora
      const ini = proxima();
      await envio();                                             // borda inicial: dentro (ATIVO no prazo, sem contato)
      await envio({ contato: true });                            // ATIVO no prazo com contato
      await envio({ criadoDiasAtras: 40 });                      // ATIVO com o link vencido: criada, fora do prazo
      await envio({ estado: "EXPIRADO", criadoDiasAtras: 40 });  // EXPIRADO: criada
      await envio({ estado: "REVOGADO" });                       // REVOGADO com festa válida: fora
      const cancelada = await envio({ nota: 2, tarefa: "ABERTA" });
      await cancelarFesta(cancelada.f);                           // cancelada depois da resposta: sai (D-PS4-6)
      const expiradaCancelada = await envio({ estado: "EXPIRADO", criadoDiasAtras: 40 });
      await cancelarFesta(expiradaCancelada.f);
      await envio({ nota: 9, semContrato: true });               // sem contrato ASSINADO: fora
      // Festa CANCELADA com o contrato ainda ASSINADO não existe: a 019 recusa (por isso o mutante P06 é equivalente).
      const soFesta = await envio({ nota: 10 });
      await assert.rejects(um(`UPDATE fechamentos SET status = 'CANCELADO' WHERE id = $1::uuid RETURNING id`, [soFesta.f]), { code: "23514" }, "019 recusa festa cancelada com contrato ASSINADO");
      await cancelarFesta(soFesta.f);
      await envio({ nota: 8, criadoDiasAtras: 60, respondidoEm: await instante(`clock_timestamp() - interval '50 days'`) }); // resposta antiga, link vencido: conta
      await envio();                                             // borda final
      const fim = ultima();
      await envio({ nota: 0 });                                  // dia seguinte: fora
      const k = (await ok<Resultados>(resultados(gestao, periodo(ini, fim)), "população")).cartoes;
      assert.deepEqual({ criadas: k.pesquisasCriadas, respostas: k.respostas, noPrazo: k.aindaNoPrazo, semContato: k.semContato, nps: k.nps },
        { criadas: 6, respostas: 1, noPrazo: 3, semContato: 5, nps: 0 }, "população P");
      // D-PS4-6: a resposta fica guardada e o retorno continua na fila da Gestão.
      const fila = await ok<Painel>(retornos(gestao), "fila da Gestão");
      assert.ok(fila.tarefas.some((x) => x.id === cancelada.tarefa), "tarefa da festa cancelada segue aberta na fila");
      assert.equal((await um(`SELECT count(*)::int AS n FROM satisfacao_respostas WHERE envio_id = $1::uuid`, [cancelada.envio])).n, 1, "resposta guardada");
      // Festa cancelada fica fora mesmo filtrando por grupo (filtro só da lista).
      const d = await ok<Resultados>(resultados(gestao, periodo(ini, fim, { grupo: "detratores" })), "detratores");
      assert.deepEqual([d.lista.total, d.lista.totalFiltrado, d.lista.itens.length], [1, 0, 0], "população P com filtro de grupo");
    });

    await t.test("escopos pelas rotas: Gestão; VER; só TRATAR → 404; VER U1+U2 com TRATAR U1 (1 de 2); VER U1 com TRATAR U2; sem unidade; outra empresa", async () => {
      const ini = proxima();
      const d1 = await envio({ unidade: U1, nota: 3, tarefa: "ABERTA", comentario: "Demorou", nome: "  Ana   Lima Sintética " });
      const p2 = await envio({ unidade: U2, nota: 10, comentario: "Ótimo" });
      const d2 = await envio({ unidade: U2, nota: 4, tarefa: "ABERTA" });
      const sem = await envio({ nota: 1, tarefa: "CONCLUIDA" });
      const fim = ultima();
      const q = periodo(ini, fim);

      const g = await ok<Resultados>(resultados(gestao, q), "Gestão");
      assert.equal(g.cartoes.respostas, 4, "Gestão: respostas de U1, U2 e sem unidade");
      assert.equal(g.semUnidade, true);
      assert.ok([U1, U2].every((u) => g.unidades.some((x) => x.id === u)));
      assert.equal(g.cartoes.retornosAbertos!.abertos, 2);
      assert.equal(g.cartoes.retornosAbertos!.unidadesComTratar, g.cartoes.retornosAbertos!.unidadesNoFiltro, "Gestão trata tudo o que vê");
      assert.deepEqual(g.lista.itens.find((x) => x.id === sem.resposta)!.retorno, { tarefaId: sem.tarefa, estado: "CONCLUIDA" });
      assert.equal(g.lista.itens.find((x) => x.id === d1.resposta)!.primeiroNome, "Ana", "primeiro nome do nome aparado");
      const gSem = await ok<Resultados>(resultados(gestao, { ...q, unidade: "sem-unidade" }), "Gestão sem unidade");
      assert.deepEqual(gSem.lista.itens.map((x) => x.id), [sem.resposta], "Gestão: só a festa sem unidade");
      assert.deepEqual(gSem.cartoes.retornosAbertos, { abertos: 0, unidadesComTratar: 1, unidadesNoFiltro: 1 }, "cartão: 1 de 1 (interseção com o filtro sem unidade)");

      const ver = await pessoaEquipe(); await conceder(ver, U1, "SATISFACAO_VER");
      const sVer = await sessao(ver.usuario, A);
      const v = await ok<Resultados>(resultados(sVer, q), "VER U1");
      assert.deepEqual(v.lista.itens.map((x) => x.id), [d1.resposta], "VER U1: só a resposta da U1");
      assert.deepEqual([v.unidades.map((x) => x.id), v.semUnidade], [[U1], false]);
      assert.equal("retornosAbertos" in v.cartoes, false, "sem TRATAR: cartão de retornos AUSENTE");
      assert.equal("retorno" in v.lista.itens[0], false, "sem TRATAR: estado do retorno AUSENTE");
      for (const u of [U2, "sem-unidade", "nao-uuid", randomUUID()]) await recusa(resultados(sVer, { ...q, unidade: u }), 404, "NAO_ENCONTRADO", `VER U1 filtrando ${u}`);

      const tratar = await pessoaEquipe(); await conceder(tratar, U1, "SATISFACAO_TRATAR");
      await recusa(resultados(await sessao(tratar.usuario, A), q), 404, "NAO_ENCONTRADO", "só TRATAR não dá VER (D-PS4-2)");

      const misto = await pessoaEquipe();
      await conceder(misto, U1, "SATISFACAO_VER"); await conceder(misto, U2, "SATISFACAO_VER"); await conceder(misto, U1, "SATISFACAO_TRATAR");
      const sMisto = await sessao(misto.usuario, A);
      const m = await ok<Resultados>(resultados(sMisto, q), "VER U1+U2, TRATAR U1");
      assert.equal(m.cartoes.respostas, 3);
      assert.deepEqual(m.cartoes.retornosAbertos, { abertos: 1, unidadesComTratar: 1, unidadesNoFiltro: 2 }, "cartão: 1 de 2 unidades");
      assert.deepEqual(m.lista.itens.find((x) => x.id === d1.resposta)!.retorno, { tarefaId: d1.tarefa, estado: "ABERTA" });
      assert.equal("retorno" in m.lista.itens.find((x) => x.id === d2.resposta)!, false, "U2 sem TRATAR: chave ausente");
      assert.equal("retorno" in m.lista.itens.find((x) => x.id === p2.resposta)!, false);
      const mU2 = await ok<Resultados>(resultados(sMisto, { ...q, unidade: U2 }), "misto filtrando U2");
      assert.equal("retornosAbertos" in mU2.cartoes, false, "filtro fora da interseção: cartão ausente");

      const cruzado = await pessoaEquipe();
      await conceder(cruzado, U1, "SATISFACAO_VER"); await conceder(cruzado, U2, "SATISFACAO_TRATAR");
      const x = await ok<Resultados>(resultados(await sessao(cruzado.usuario, A), q), "VER U1, TRATAR U2");
      assert.equal("retornosAbertos" in x.cartoes, false);
      assert.ok(x.lista.itens.every((i) => !("retorno" in i)));
      assert.deepEqual(x.lista.itens.map((i) => i.id), [d1.resposta]);

      // Outra empresa: o tenant vem da sessão (empresa na query é ignorada); unidade de A pela Gestão de B → 404.
      const b = await ok<Resultados>(resultados(gestaoB, { ...q, empresaId: A }), "Gestão B");
      assert.deepEqual([b.cartoes.pesquisasCriadas, b.lista.total], [0, 0]);
      await recusa(resultados(gestaoB, { ...q, unidade: U1 }), 404, "NAO_ENCONTRADO", "unidade de outra empresa");
      // Equipe de A sem nenhuma concessão: 404 (sem VER).
      await recusa(resultados(await sessao((await pessoaEquipe()).usuario, A), q), 404, "NAO_ENCONTRADO", "Equipe sem concessão");
    });

    await t.test("vigência: revogação, foto do vínculo, membership futura/vencida → sem dados; JSON com chaves exatas", async () => {
      const ini = proxima();
      const r = await envio({ unidade: U1, nota: 6, comentario: "<img src=x onerror=alert(1)>", tarefa: "ABERTA" });
      const q = periodo(ini, ultima());
      const rev = await pessoaEquipe(); const cRev = await conceder(rev, U1, "SATISFACAO_VER");
      const sRev = await sessao(rev.usuario, A);
      await ok(resultados(sRev, q), "antes da revogação");
      await revogar(cRev.concessao);
      await recusa(resultados(sRev, q), 404, "NAO_ENCONTRADO", "VER revogada");

      const foto = await pessoaEquipe();
      const cf = await conceder(foto, U1, "SATISFACAO_VER", A, { ate: await instante(`clock_timestamp() + interval '10 days'`) });
      const sFoto = await sessao(foto.usuario, A);
      await ok(resultados(sFoto, q), "foto igual");
      await emTransacao(async () => { await c.query(`UPDATE membership_estabelecimentos SET vigente_ate = vigente_ate + interval '1 day' WHERE id = $1::uuid`, [cf.vinculo]); });
      await recusa(resultados(sFoto, q), 404, "NAO_ENCONTRADO", "foto do vínculo diferente");

      for (const [rotulo, sql] of [["futura", `vigente_desde = clock_timestamp() + interval '1 day'`], ["vencida", `vigente_desde = clock_timestamp() - interval '2 days', vigente_ate = clock_timestamp() - interval '1 second'`]] as const) {
        const p = await pessoaEquipe(); await conceder(p, U1, "SATISFACAO_VER");
        const s = await sessao(p.usuario, A);
        await ok(resultados(s, q), `${rotulo}: controle`);
        // A 063 não deixa o chamador mudar a vigência da membership: fixture em modo réplica, numa transação própria.
        await emTransacao(async () => { await c.query("SET LOCAL session_replication_role = replica"); await c.query(`UPDATE memberships SET ${sql} WHERE id = $1::uuid`, [p.membership]); });
        const x = await resultados(s, q);
        assert.ok([401, 403, 404].includes(x.status) && x.corpo.ok === false && x.corpo.data === undefined, `membership ${rotulo}: recusa sem dados (${x.status})`);
        assert.equal(await menu(s).catch(() => null), null, `membership ${rotulo}: menu oculto`);
      }

      const ver = await pessoaEquipe(); await conceder(ver, U1, "SATISFACAO_VER"); await conceder(ver, U1, "SATISFACAO_TRATAR");
      const d = await ok<Resultados>(resultados(await sessao(ver.usuario, A), q), "chaves");
      assert.deepEqual(Object.keys(d).sort(), ["cartoes", "lista", "periodo", "semUnidade", "unidade", "unidades"]);
      assert.deepEqual(Object.keys(d.cartoes).sort(), ["aindaNoPrazo", "aspectos", "grupos", "histograma", "nps", "pesquisasCriadas", "respostas", "retornosAbertos", "semContato", "taxa"]);
      assert.deepEqual(Object.keys(d.lista).sort(), ["itens", "proximo", "total", "totalFiltrado"]);
      const item = d.lista.itens.find((x) => x.id === r.resposta)!;
      assert.deepEqual(Object.keys(item).sort(), ["comentario", "dataFesta", "id", "notaComida", "notaEquipe", "notaEspaco", "notaIndicacao", "primeiroNome", "respondidaEm", "retorno", "unidade"]);
      assert.equal(item.comentario, "<img src=x onerror=alert(1)>", "comentário devolvido como texto, sem transformação");
      const texto = JSON.stringify(d);
      for (const proibido of ["Sintética", "clienteId", "whatsapp", "observacao", "@pesquisa.test"]) assert.equal(texto.includes(proibido), false, `projeção: sem ${proibido}`);

      const painel = await ok<Painel>(retornos(gestao), "chaves do painel");
      assert.deepEqual(Object.keys(painel).sort(), ["abertasSemUnidade", "gestao", "proximo", "tarefas", "totalNoEstado", "unidades"]);
      assert.deepEqual(Object.keys(painel.tarefas[0]).sort(), ["cliente", "clienteId", "comentario", "concluidaEm", "criadaEm", "dataFesta", "estabelecimentoId", "estado", "id", "notaIndicacao", "observacao", "unidade"],
        "contrato de TRATAMENTO da PS-3 preservado; sem _ordem");
    });

    await t.test("flag desligada (503) e plano sem Marketing (403, leitura do contrato injetada): resultados, retornos e menu", async () => {
      const q = periodo("2031-01-01", "2031-12-31");
      const tr = await pessoaEquipe(); await conceder(tr, U1, "SATISFACAO_TRATAR");
      const sTr = await sessao(tr.usuario, A);
      process.env.SATISFACAO_PESQUISA_ENABLED = "false";
      try {
        await recusa(resultados(gestao, q), 503, "PESQUISA_INDISPONIVEL", "flag desligada");
        await recusa(retornos(gestao), 503, "PESQUISA_INDISPONIVEL", "flag desligada (retornos)");
        assert.equal(await menu(gestao), null, "flag desligada: menu oculto");
      } finally { process.env.SATISFACAO_PESQUISA_ENABLED = "true"; }
      planoEssencial.add(A);
      try {
        await recusa(resultados(gestao, q), 403, "RECURSO_FORA_DO_PLANO", "plano sem Marketing");
        await recusa(retornos(sTr), 403, "RECURSO_FORA_DO_PLANO", "plano sem Marketing (Equipe TRATAR)");
        assert.equal(await menu(gestao), null, "plano sem Marketing: menu oculto");
      } finally { planoEssencial.clear(); }
      assert.notEqual(await menu(gestao), null, "controle: plano restaurado");
    });

    await t.test("menu pela rota de autenticação: matriz, contador TRATAR e janela de papel (papel relido na instrução do menu)", async () => {
      const abertas = async (u?: string) => Number((await um(`SELECT count(*) AS n FROM satisfacao_tarefas WHERE empresa_id = $1::uuid AND estado = 'ABERTA' AND ($2::uuid IS NULL OR estabelecimento_id = $2::uuid)`, [A, u ?? null])).n);
      assert.deepEqual(await menu(gestao), { ver: true, tratar: true, retornosAbertos: await abertas() });
      const ver = await pessoaEquipe(); await conceder(ver, U1, "SATISFACAO_VER");
      assert.deepEqual(await menu(await sessao(ver.usuario, A)), { ver: true, tratar: false, retornosAbertos: 0 });
      const tr = await pessoaEquipe(); await conceder(tr, U1, "SATISFACAO_TRATAR");
      assert.deepEqual(await menu(await sessao(tr.usuario, A)), { ver: false, tratar: true, retornosAbertos: await abertas(U1) });
      const nada = await pessoaEquipe();
      const sNada = await sessao(nada.usuario, A);
      assert.equal(await menu(sNada), null, "sem permissão: grupo oculto");
      // Janela de papel: a ÚLTIMA leitura de contextoDaSessao (a da rota) vê ADMINISTRATIVO; o papel vira Gestão logo depois,
      // ANTES da instrução do menu → o menu segue o banco. A sonda conta quantas vezes a leitura ocorre numa chamada.
      const LEITURA = "FROM memberships m JOIN empresas e ON e.id = m.empresa_id";
      sonda = { trecho: LEITURA, n: 0 };
      await menu(sNada);
      const ocorrencias = sonda.n; sonda = null;
      assert.ok(ocorrencias >= 1, "a rota lê o contexto da sessão");
      depoisDe = { trecho: LEITURA, n: ocorrencias, acao: async () => {
        await emTransacao(async () => { await c.query(`UPDATE memberships SET papel = $2 WHERE id = $1::uuid`, [nada.membership, GESTAO]); });
      } };
      assert.deepEqual(await menu(sNada), { ver: true, tratar: true, retornosAbertos: await abertas() }, "promovida entre as leituras: menu da Gestão");
      assert.equal(depoisDe, null, "gancho executado");
      depoisDe = { trecho: LEITURA, n: ocorrencias, acao: async () => {
        await emTransacao(async () => { await c.query(`UPDATE memberships SET papel = 'ADMINISTRATIVO' WHERE id = $1::uuid`, [nada.membership]); });
      } };
      assert.equal(await menu(sNada), null, "rebaixada entre as leituras: menu oculto (papel lido antes não promove)");
      assert.equal(depoisDe, null, "gancho executado");
    });

    await t.test("cursor: empate de instante, borda de 1 µs e navegação viva (resposta nova entre páginas; revogação → 404)", async () => {
      const pessoa = await pessoaEquipe(); const cv = await conceder(pessoa, U1, "SATISFACAO_VER");
      const s = await sessao(pessoa.usuario, A);
      const ini = proxima();
      const reserva = novaData();
      const T = await instante(`date_trunc('second', clock_timestamp()) - interval '1 day'`);
      // Borda da página (mutantes 16 e 17 da rev. 1.1, deterministas): X tem 500 µs; a 50ª resposta (X, id ffff…) fecha a
      // página 1; a 51ª empata no instante com id menor (0000…01) e a 52ª está 1 µs antes. Sem desempate por id a 51ª some;
      // com o cursor passando por Date (ms) X vira X − 500 µs e as duas somem.
      const X = await instante(`$1::timestamptz - interval '100 seconds' + interval '500 microseconds'`, [T]);
      const mais1 = await instante(`$1::timestamptz + interval '1 microsecond'`, [X]), menos1 = await instante(`$1::timestamptz - interval '1 microsecond'`, [X]);
      const ID_ALTO = "ffffffff-ffff-4fff-bfff-fffffffffff0", ID_BAIXO = "00000000-0000-4000-8000-000000000001";
      const criadas: string[] = [];
      for (let k = 0; k < 48; k++) criadas.push((await envio({ unidade: U1, nota: k % 11, respondidoEm: await instante(`$1::timestamptz - $2::int * interval '1 second'`, [T, k]) })).resposta!);
      for (const [em, respostaId] of [[mais1, undefined], [X, ID_ALTO], [X, ID_BAIXO], [menos1, undefined]] as const) criadas.push((await envio({ unidade: U1, nota: 5, respondidoEm: em, respostaId })).resposta!);
      const q = periodo(ini, ultima());
      const p1 = await ok<Resultados>(resultados(s, q), "página 1");
      assert.equal(p1.lista.itens.length, 50);
      assert.ok(p1.lista.proximo);
      assert.equal(p1.lista.itens[49].id, ID_ALTO, "a página 1 termina na 1ª resposta empatada em X");
      assert.ok(p1.lista.itens[49].respondidaEm.endsWith(".000500Z"), `instante com µs no JSON (${p1.lista.itens[49].respondidaEm})`);
      assert.equal((await um(`SELECT $1::timestamptz = $2::timestamptz AS ok`, [p1.lista.itens[49].respondidaEm, X])).ok, true);
      // Resposta nova (mais recente que tudo) chega entre as páginas: não aparece na página 2 nem duplica nada.
      const nova = await envio({ unidade: U1, data: reserva, nota: 10, respondidoEm: await instante(`clock_timestamp()`) });
      const p2 = await ok<Resultados>(resultados(s, { ...q, cursor: p1.lista.proximo! }), "página 2");
      assert.deepEqual(p2.lista.itens.map((i) => i.id), [ID_BAIXO, criadas[51]], "página 2: o empatado em X (id menor) e o de X − 1 µs");
      assert.equal(p2.lista.proximo, null);
      assert.equal(p2.lista.total, 53, "a página 2 é um snapshot novo (total vivo)");
      const todos = [...p1.lista.itens, ...p2.lista.itens];
      assert.deepEqual(new Set(todos.map((i) => i.id)), new Set(criadas), "sem perda nem duplicação");
      assert.ok(!todos.some((i) => i.id === nova.resposta));
      assert.ok(emOrdem(todos, (i) => [i.respondidaEm, i.id]), "ordem (instante, id) decrescente estrita");
      // Cursor inválido → 400; revogação entre páginas → 404 sem dados.
      for (const cursor of ["x", "%%%", Buffer.from("2031-01-01T00:00:00.000000Z|nao-uuid").toString("base64url"), Buffer.from("2031-13-40T00:00:00.000000Z|" + randomUUID()).toString("base64url")])
        await recusa(resultados(s, { ...q, cursor }), 400, "DADOS_INVALIDOS", `cursor ${cursor}`);
      await revogar(cv.concessao);
      await recusa(resultados(s, { ...q, cursor: p1.lista.proximo! }), 404, "NAO_ENCONTRADO", "revogada entre as páginas");
    });

    await t.test("PS4-R4.5: random_page_cost 1.1 só na instrução dos Resultados, dentro da transação da rota, e devolvido depois", async () => {
      const ler = async (s: string) => (await c.query(s)).rows[0].v as string;
      const padrao = await ler(`SELECT current_setting('random_page_cost') AS v`);
      assert.notEqual(padrao, "1.1", "o valor da sessão difere do ajuste (senão o teste não distingue nada)");
      const visto: string[] = [];
      let daRota: Client | null = null;
      espiar = async (cx, sql, _v, fase) => {
        if (sql.includes("satisfacao:resultados")) daRota = cx;
        const q = async (s: string) => (await cx.query(s)).rows[0].v as string;
        if (fase === "antes" && sql.includes("satisfacao:resultados")) {
          visto.push(`resultados:${await q(`SELECT current_setting('random_page_cost') AS v`)}`);
          // Em transação, now() fica no início da transação; em autocommit seria o instante desta instrução.
          visto.push(`transacao:${await q(`SELECT (now() < statement_timestamp())::text AS v`)}`);
        }
        if (fase === "depois" && sql.startsWith("SELECT set_config('random_page_cost'")) visto.push(`devolvido:${await q(`SELECT current_setting('random_page_cost') AS v`)}`);
      };
      try {
        const ini = proxima();
        await envio({ nota: 8 });
        await ok<Resultados>(resultados(gestao, periodo(ini, ultima())), "leitura com o ajuste");
      } finally { espiar = null; }
      // Mensagens com marcador próprio (fora do título do subteste), para os mutantes P38–P40 morrerem pela causa.
      const naInstrucao = (visto.find((x) => x.startsWith("resultados:")) ?? "resultados:ausente").slice("resultados:".length);
      assert.equal(naInstrucao, "1.1", `AJUSTE-R45 a instrução dos Resultados executou com random_page_cost=${naInstrucao} (valor da sessão: ${padrao})`);
      assert.deepEqual(visto, ["resultados:1.1", "transacao:true", `devolvido:${padrao}`], `AJUSTE-R45 sequência na conexão da rota (esperado o anterior ${padrao} devolvido logo depois)`);
      assert.ok(daRota, "conexão da rota observada");
      const depois = (await (daRota as Client).query(`SELECT current_setting('random_page_cost') AS v`)).rows[0].v as string;
      assert.equal(depois, padrao, "nada vaza para a sessão da conexão da rota depois do COMMIT");
    });

    await t.test("filtros combinados e período: 365/366/367 datas, 29/02, invertido, inválido, atalhos de São Paulo", async () => {
      const ini = proxima();
      await envio({ nota: 2, comentario: "Frio" }); await envio({ nota: 3 }); await envio({ nota: 9, comentario: "Lindo" }); await envio({ nota: 7 });
      const q = periodo(ini, ultima());
      const f = await ok<Resultados>(resultados(gestao, { ...q, grupo: "detratores", comComentario: "1" }), "detratores com comentário");
      assert.deepEqual([f.lista.total, f.lista.totalFiltrado, f.lista.itens.length, f.cartoes.respostas, f.cartoes.nps], [4, 1, 1, 4, -25], "filtros só da lista");
      assert.equal((await ok<Resultados>(resultados(gestao, { ...q, grupo: "neutros" }), "neutros")).lista.totalFiltrado, 1);
      assert.equal((await ok<Resultados>(resultados(gestao, { ...q, comComentario: "1" }), "comentário")).lista.totalFiltrado, 2);
      await recusa(resultados(gestao, { ...q, grupo: "todos" }), 400, "DADOS_INVALIDOS", "grupo inválido");
      await recusa(resultados(gestao, { ...q, comComentario: "true" }), 400, "DADOS_INVALIDOS", "comComentario inválido");

      const per = async (inicio: string, fim: string) => ok<Resultados>(resultados(gestao, { inicio, fim }), `${inicio}..${fim}`);
      assert.deepEqual((await per("2027-01-01", "2027-12-31")).periodo, { inicio: "2027-01-01", fim: "2027-12-31" }, "365 datas");
      await per("2028-01-01", "2028-12-31"); // 366 (bissexto)
      await per("2027-01-01", "2028-01-01"); // 366
      await per("2024-02-29", "2024-02-29"); // uma data, 29/02
      for (const [inicio, fim, rotulo] of [["2027-01-01", "2028-01-02", "367 datas"], ["2023-02-29", "2023-03-01", "29/02 inexistente"], ["2031-02-02", "2031-02-01", "invertido"],
        ["2031-13-01", "2031-13-02", "mês 13"], ["2031-1-01", "2031-01-02", "formato"], ["2031-01-01", "", "só início"]] as const) {
        await recusa(resultados(gestao, fim ? { inicio, fim } : { inicio }), 400, "DADOS_INVALIDOS", rotulo);
      }
      await recusa(resultados(gestao, { atalho: "ano" }), 400, "DADOS_INVALIDOS", "atalho inválido");
      // Atalhos no calendário de negócio (America/Sao_Paulo), oráculo independente do SQL da aplicação.
      const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
      const [ano, mes] = hoje.split("-").map(Number);
      const primeiro = (a: number, m: number) => new Date(Date.UTC(a, m - 1, 1)).toISOString().slice(0, 10);
      const esperado = {
        "este-mes": { inicio: primeiro(ano, mes), fim: hoje },
        "mes-passado": { inicio: primeiro(ano, mes - 1), fim: somarDias(primeiro(ano, mes), -1) },
        "ultimos-3-meses": { inicio: primeiro(ano, mes - 2), fim: hoje },
      };
      for (const [atalho, p] of Object.entries(esperado)) assert.deepEqual((await ok<Resultados>(resultados(gestao, { atalho }), atalho)).periodo, p, atalho);
      assert.deepEqual((await ok<Resultados>(resultados(gestao), "padrão")).periodo, esperado["ultimos-3-meses"], "padrão = últimos 3 meses");
    });

    await t.test("retornos: 201 abertas + 3 concluídas, estado antes do limite, cursor com empates; Equipe TRATAR sem Marketing; regra não ativa", async () => {
      const R = await instante(`date_trunc('second', clock_timestamp()) - interval '2 days'`);
      const abertas: string[] = [];
      for (let k = 0; k < 201; k++) {
        // Empates de instante a cada 3 tarefas; a unidade UB em 1 de cada 4.
        const em = await instante(`$1::timestamptz - $2::int * interval '1 second'`, [R, Math.floor(k / 3)]);
        abertas.push((await envio({ empresa: B, unidade: k % 4 === 0 ? UB : null, nota: k % 7, tarefa: "ABERTA", criadoDiasAtras: 3, respondidoEm: em, tarefaEm: em })).tarefa!);
      }
      const concluidas: string[] = [];
      for (let k = 0; k < 3; k++) concluidas.push((await envio({ empresa: B, nota: 1, tarefa: "CONCLUIDA", concluidaEm: await instante(`$1::timestamptz + $2::int * interval '1 microsecond'`, [R, k % 2]) })).tarefa!);

      const paginas: Tarefa[] = [];
      let cursor: string | null = null, n = 0;
      do {
        const p: Painel = await ok<Painel>(retornos(gestaoB, cursor ? { cursor } : {}), `página ${++n}`);
        assert.equal(p.totalNoEstado, 201, "totalNoEstado: só as do estado (filtro antes do limite)");
        assert.ok(p.tarefas.length <= 50);
        assert.ok(p.tarefas.every((x) => x.estado === "ABERTA"));
        paginas.push(...p.tarefas);
        cursor = p.proximo;
      } while (cursor && n < 10);
      assert.equal(n, 5, "50+50+50+50+1");
      assert.deepEqual(new Set(paginas.map((x) => x.id)), new Set(abertas), "201 abertas, sem perda nem duplicação (sem o LIMIT 200)");
      assert.equal(paginas.length, 201);
      const ordem = async (ids: string[], col: string) => (await c.query(`SELECT id::text AS id FROM satisfacao_tarefas WHERE id = ANY($1::uuid[]) ORDER BY ${col} DESC, id DESC`, [ids])).rows.map((x) => x.id as string);
      assert.deepEqual(paginas.map((x) => x.id), await ordem(abertas, "criado_em"), "ordem (criado_em, id) decrescente");

      const conc = await ok<Painel>(retornos(gestaoB, { estado: "CONCLUIDA" }), "concluídas");
      assert.deepEqual([conc.totalNoEstado, conc.proximo], [3, null]);
      assert.deepEqual(conc.tarefas.map((x) => x.id), await ordem(concluidas, "concluida_em"), "estado no servidor antes do limite; ordem (concluida_em, id)");
      await recusa(retornos(gestaoB, { estado: "TODAS" }), 400, "DADOS_INVALIDOS", "estado inválido");
      await recusa(retornos(gestaoB, { cursor: "!!" }), 400, "DADOS_INVALIDOS", "cursor inválido");

      // Equipe de B só com TRATAR na UB, sem nenhuma capacidade de Marketing; a regra de B nunca foi ativada.
      assert.notEqual((await um(`SELECT status FROM marketing_automacao_regras WHERE id = $1::uuid`, [regraB])).status, "ATIVA");
      const eq = await pessoaEquipe(B); await conceder(eq, UB, "SATISFACAO_TRATAR", B);
      const sEq = await sessao(eq.usuario, B);
      const minhas: Tarefa[] = [];
      let cur: string | null = null;
      do { const p: Painel = await ok<Painel>(retornos(sEq, cur ? { cursor: cur } : {}), "Equipe B"); assert.equal(p.gestao, false); minhas.push(...p.tarefas); cur = p.proximo; } while (cur);
      assert.equal(minhas.length, 51);
      assert.ok(minhas.every((x) => x.estabelecimentoId === UB));
      assert.deepEqual(await menu(sEq), { ver: false, tratar: true, retornosAbertos: 51 });
      await recusa(resultados(sEq, periodo("2031-01-01", "2031-12-31")), 404, "NAO_ENCONTRADO", "TRATAR sem VER não lê resultados");
    });
  } finally {
    for (const [k, v] of Object.entries({ NODE_ENV: anterior.NODE_ENV, ADMIN_AUTH_ORIGIN: anterior.ADMIN_AUTH_ORIGIN, RENDER: anterior.RENDER, KIDMAIS_DEPLOY_ENV: anterior.KIDMAIS_DEPLOY_ENV, SATISFACAO_PESQUISA_ENABLED: anterior.FLAG })) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k]; else (process.env as Record<string, string | undefined>)[k] = v;
    }
    delete (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool;
    for (const x of extras.reverse()) await encerrarDescartavel(x, false);
    await encerrarDescartavel(c);
  }
});
