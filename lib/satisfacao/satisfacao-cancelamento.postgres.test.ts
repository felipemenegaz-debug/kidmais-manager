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
import { hashSnapshotContrato } from "../contratos/services/snapshot-core.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { carregarComBanco, cod, porTransacao, SENHA_FALSA, vincular } from "../marketing/harness-postgres.ts";
import { baseSintetica, type CriarEnvio } from "./harness-postgres.ts";
import { assinarToken, lerAnel, type AnelChaves } from "./token.ts";

/**
 * Pesquisa de satisfação (110, PS-1) × cancelamento pelas ENTRADAS REAIS (P2-2 do Astra), no PostgreSQL descartável,
 * modelo 110, com dados COMMITADOS e três conexões (c1 = resposta pública, c2 = entrada de cancelamento, c3 = fixtures e
 * observação de pg_stat_activity/pg_blocking_pids). Nada de SQL que imite o protocolo: o cancelamento é o serviço da
 * Festa (comandarFesta → cancelarContratacaoDaFesta) e o operarContrato, carregados do código da aplicação, no pool
 * apontado para c2. A ordem real de travas das duas entradas é fechamento → contrato (FOR UPDATE, com espera); a
 * pesquisa trava contrato e fechamento FOR SHARE NOWAIT (travas.ts).
 *
 *  - ordem 1 (cancelamento primeiro): a entrada para numa BARREIRA com as travas tomadas; a resposta NUNCA espera — cada
 *    tentativa recebe 55P03 na hora (um VIGIA observa o PID da resposta: bloqueado pelo PID do cancelamento = falha
 *    pela espera identificada, M01); o cancelamento confirma e a próxima tentativa revoga (Festa) ou grava (operarContrato,
 *    que recusa contrato assinado e desfaz);
 *  - ordem 2 (resposta primeiro): a resposta para numa barreira com as travas FOR SHARE dos pais; a entrada de
 *    cancelamento ESPERA (bloqueio observado pelos PIDs) e só segue depois do COMMIT da resposta; RESPONDIDO se preserva.
 * Contrato formalizado (versão, documento, edição, assinaturas, fluxo e Festa) gravado com session_replication_role =
 * replica numa transação própria (precedente: harness-postgres.ts e lib/agenda/aplicador-100.postgres.test.ts): as
 * guardas da formalização não são o objeto aqui; nada da 110 é gravado assim.
 */
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exigirCjs = createRequire(import.meta.url);
const extensoes = exigirCjs.extensions as unknown as Record<string, (m: { _compile(code: string, filename: string): void }, filename: string) => void>;
extensoes[".ts"] = (m, filename) => {
  const saida = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
  }).outputText.replace(/require\("@\/([^"\n]+)"\)/g, (_t, caminho: string) => `require(${JSON.stringify(resolve(raiz, caminho))})`);
  m._compile(saida, filename);
};

process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${"x".repeat(24)}`;
const anel = lerAnel({ SATISFACAO_LINK_CHAVES: `1:${randomBytes(32).toString("base64")}`, SATISFACAO_LINK_CHAVE_ATUAL: "1" }) as AnelChaves;
type Publico = Record<"responderPesquisa", (corpo: unknown, ctx: { ip: string | null }, deps: unknown) => Promise<Record<string, unknown>>>;
type Envios = { criarEnvio: CriarEnvio };
type Festas = { comandarFesta(id: string, raw: unknown, ctx: unknown): Promise<Record<string, unknown>> };
type Contratos = { operarContrato(versaoId: string, input: unknown, token: string, ctx: unknown): Promise<Record<string, unknown>> };

const identidade = async (db: Client) => (await db.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
  VALUES ($1, 'Gestão sintética', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`, [`${cod("u")}@pesquisa.test`, SENHA_FALSA])).rows[0].id;
const erroDe = (code: string, status?: number) => (e: unknown) => (e as { code?: string }).code === code && (status === undefined || (e as { httpStatus?: number }).httpStatus === status);
const pid = async (c: Client) => Number((await c.query(`SELECT pg_backend_pid() AS p`)).rows[0].p);
const adiado = () => { let liberar!: () => void; const p = new Promise<void>((r) => { liberar = r; }); return { p, liberar }; };

/** Espera (com prazo) o backend `alvo` ficar bloqueado por `bloqueador` com o trecho de SQL esperado. Prova, não sleep. */
async function esperarBloqueio(obs: Client, alvo: number, bloqueador: number, trecho: string) {
  for (let i = 0; i < 500; i++) {
    await obs.query(`SELECT pg_stat_clear_snapshot()`);
    const r = (await obs.query(`SELECT a.query, $2::int = ANY (pg_blocking_pids(a.pid)) AS bloqueado FROM pg_stat_activity a WHERE a.pid = $1::int`, [alvo, bloqueador])).rows[0];
    if (r?.bloqueado && String(r.query).includes(trecho)) return String(r.query);
    await new Promise((fim) => setTimeout(fim, 10));
  }
  throw new Error(`backend ${alvo} não ficou bloqueado por ${bloqueador} em "${trecho}"`);
}

/** Vigia: enquanto ativo, registra se `alvo` aparece bloqueado por `bloqueador` (e chama `aoVer` para destravar o teste). */
function vigiar(obs: Client, alvo: number, bloqueador: number, aoVer: () => void) {
  let ativo = true, visto: string | null = null;
  const laco = (async () => {
    while (ativo) {
      await obs.query(`SELECT pg_stat_clear_snapshot()`);
      const r = (await obs.query(`SELECT a.query, $2::int = ANY (pg_blocking_pids(a.pid)) AS bloqueado FROM pg_stat_activity a WHERE a.pid = $1::int`, [alvo, bloqueador])).rows[0];
      if (r?.bloqueado) { visto = String(r.query); aoVer(); return; }
      await new Promise((fim) => setTimeout(fim, 5));
    }
  })();
  return async () => { ativo = false; await laco; return visto; };
}

test("110: resposta × cancelamento pelas entradas reais (Festa e operarContrato), nas duas ordens", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const festaAntes = process.env.FESTA_ENABLED;
  process.env.FESTA_ENABLED = "true";
  const c1 = await conectarDescartavel();
  const c2 = await conectarDescartavel({ travar: false });
  const c3 = await conectarDescartavel({ travar: false });
  const global = globalThis as { __kidmaisPgPool?: unknown };
  try {
    const carregar = <T>(f: string) => carregarComBanco(f, c1, () => null, {}, new Map()) as unknown as T;
    const pub = carregar<Publico>("lib/satisfacao/publico.ts");
    const envios = carregar<Envios>("lib/satisfacao/envios.ts");
    const { A, festa, execucao, emTransacao } = await baseSintetica(c3, anel, envios.criarEnvio, identidade);
    const [p1, p2] = [await pid(c1), await pid(c2)];
    const um = async (sql: string, v: unknown[] = []) => (await c3.query(sql, v)).rows[0];

    // Pool da aplicação = c2, com uma BARREIRA opcional: depois do SQL que casa com `trecho`, a transação para até ser liberada.
    let barreira: { trecho: RegExp; chegou: ReturnType<typeof adiado>; seguir: ReturnType<typeof adiado> } | null = null;
    const conexao = { async query(sql: string, v?: unknown[]) {
      const r = await c2.query(sql, v);
      if (barreira && barreira.trecho.test(sql)) { const b = barreira; barreira = null; b.chegou.liberar(); await b.seguir.p; }
      return r;
    }, release() {} };
    global.__kidmaisPgPool = { query: (sql: string, v?: unknown[]) => c2.query(sql, v), connect: async () => conexao };
    const armar = (trecho: RegExp) => { const b = { trecho, chegou: adiado(), seguir: adiado() }; barreira = b; return b; };
    const festas = exigirCjs(resolve(raiz, "lib/festas/service.ts")) as Festas;
    const contratos = exigirCjs(resolve(raiz, "lib/contratos/services/administrativo.service.ts")) as Contratos;

    // Gestão com FESTA_CORRIGIR em A e sessão (identidade criada pela suíte, guarda F1).
    const gestor = await emTransacao(async () => {
      const u = await identidade(c3);
      const { membership } = await vincular(c3, A, u, "REPRESENTANTE_AUTORIZADO");
      for (const cap of ["FESTA_CONSULTAR", "FESTA_OPERAR", "FESTA_CORRIGIR"]) {
        await c3.query(`INSERT INTO festa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'Fixture pesquisa')`, [A, membership, cap, u]);
      }
      const token = randomBytes(32).toString("base64url");
      await c3.query(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em)
        VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours')`, [u, hashToken(token), hashToken(randomBytes(32).toString("base64url"))]);
      return { u, token };
    });

    /** Festa assinada e FORMALIZADA (versão vigente, documento, edição, assinaturas, fluxo e Festa) + envio pelo serviço. */
    async function envioFormalizado() {
      const { cl, f } = await festa({ assinado: false });
      const formal = await emTransacao(async () => {
        await c3.query("SET LOCAL session_replication_role = replica");
        const id = async (sql: string, v: unknown[]) => (await c3.query<{ id: string }>(sql, v)).rows[0].id;
        const contrato = await id(`INSERT INTO contratos (fechamento_id, status, assinado_em, versao_atual) VALUES ($1::uuid, 'ASSINADO', now(), 1) RETURNING id::text AS id`, [f]);
        const snapshot = { comercial: { valorFinalContrato: 4500 }, evento: { data: "2026-09-01", convidados: 20, pacote: { codigo: "COMPLETA", nome: "Completa sintética" } }, contratacao: { buffet: {}, adicionais: [] }, fechamento: { id: f } };
        const hash = hashSnapshotContrato(snapshot);
        const pdf = Buffer.from(`%PDF-1.4\n% pesquisa ${randomUUID()}\n%%EOF\n`);
        const pdfHash = createHash("sha256").update(pdf).digest("hex");
        const versao = await id(`INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
          VALUES ($1::uuid, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP') RETURNING id::text AS id`, [contrato, JSON.stringify(snapshot), hash, pdfHash]);
        const doc = await id(`INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf, gerado_por_usuario_id)
          VALUES ($1::uuid, 'CONTRATO', 1, $2, 'CONTRATO_PESQUISA', 1, $3, $4, $5, $6::uuid) RETURNING id::text AS id`, [versao, hash, pdfHash, pdf.length, pdf, gestor.u]);
        await c3.query(`INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id, documento_revisado_id, revisado_por_usuario_id, revisado_em)
          VALUES ($1::uuid, $2::uuid, 'INICIAL', 'CONCLUIDA', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $3::uuid, $3::uuid, $4::uuid, $3::uuid, now())`, [versao, contrato, gestor.u, doc]);
        await c3.query(`INSERT INTO contrato_fluxos (contrato_id, versao_vigente_id) VALUES ($1::uuid, $2::uuid)`, [contrato, versao]);
        const festaId = await id(`INSERT INTO festas (contrato_id, versao_contratual_criacao_id, chave_criacao, payload_hash, criado_por) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid) RETURNING id::text AS id`,
          [contrato, versao, randomUUID(), createHash("sha256").update("pesquisa").digest("hex"), gestor.u]);
        await c3.query("SET LOCAL session_replication_role = origin");
        return { contrato, versao, festaId };
      });
      const x = await execucao(A, cl, f);
      const r = await emTransacao((tx) => envios.criarEnvio(tx, anel, { empresaId: A, execucaoId: x, canais: ["WHATSAPP", "EMAIL"], agendadaPara: new Date(), maxTentativas: 3 }));
      if (!r.criado) throw new Error(`fixture: envio não criado (${r.motivo})`);
      return { cl, f, ...formal, envio: r.envioId!, token: assinarToken(anel, r.envioId!, 1, anel.atual) };
    }
    const ctxFesta = () => ({ token: gestor.token, requestId: randomUUID(), userAgent: null, empresaSolicitada: null });
    const cancelarPelaFesta = (p: { festaId: string; versao: string }) =>
      festas.comandarFesta(p.festaId, { acao: "cancelar_contratacao", chave: randomUUID(), revisao: 1, versaoId: p.versao, motivo: "Cliente desistiu (sintético)" }, ctxFesta());
    const cancelarPeloContrato = (p: { versao: string }) =>
      contratos.operarContrato(p.versao, { acao: "cancelar_contratacao", motivo: "Cliente desistiu (sintético)" }, gestor.token, { requestId: randomUUID(), ip: null, userAgent: null });
    let ipN = 0;
    const ip = () => `192.0.2.${++ipN}`;
    const estado = (envio: string) => um(`SELECT estado, motivo_revogacao FROM satisfacao_envios WHERE id = $1::uuid`, [envio]);
    const respostas = async (envio: string) => Number((await um(`SELECT count(*) AS n FROM satisfacao_respostas WHERE envio_id = $1::uuid`, [envio])).n);

    /**
     * Ordem 1: a entrada de cancelamento para na barreira com as travas tomadas; a resposta corre com um vigia no PID dela.
     * Na espera antes da 2ª tentativa, o teste libera o cancelamento e aguarda o fim dele.
     */
    async function cancelamentoPrimeiro(p: Awaited<ReturnType<typeof envioFormalizado>>, entrada: () => Promise<unknown>, trecho: RegExp) {
      const b = armar(trecho);
      const cancelamento = entrada().then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
      await b.chegou.p;
      const codigos: string[] = [];
      let liberado = false;
      const liberar = async () => { if (!liberado) { liberado = true; b.seguir.liberar(); await cancelamento; } };
      const pararVigia = vigiar(c3, p1, p2, () => { void liberar(); });
      let resultado: unknown;
      try {
        resultado = await pub.responderPesquisa({ token: p.token, notaIndicacao: 2 }, { ip: ip() }, {
          withTransaction: porTransacao(c1), anel: () => anel,
          repeticao: { esperar: async () => { await liberar(); }, aoRepetir: (_n: number, cod: string) => codigos.push(cod) },
        }).then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
      } finally {
        const visto = await pararVigia();
        await liberar();
        assert.equal(visto, null, `a resposta (pid ${p1}) esperou pela trava do cancelamento (pid ${p2}) em: ${visto}`);
      }
      return { resultado: resultado as { ok: boolean; r?: unknown; e?: unknown }, cancelamento: await cancelamento, codigos };
    }

    /**
     * Ordem 2: a resposta para na barreira depois de travar os pais (FOR SHARE); a entrada espera por ela (PIDs). Desde a
     * 114 a resposta segura a empresa em FOR KEY SHARE, então a entrada espera já no provarTenant (empresa FOR UPDATE).
     */
    async function respostaPrimeiro(p: Awaited<ReturnType<typeof envioFormalizado>>, entrada: () => Promise<unknown>, trechoDaEspera: string) {
      const chegou = adiado(), seguir = adiado();
      let pais = 0;
      const comBarreira = (base: DbExecutor): DbExecutor => ({
        async query(sql, v) {
          const r = await base.query(sql, v);
          if (sql.includes("satisfacao:travar-pais") && ++pais === 2) { chegou.liberar(); await seguir.p; }
          return r;
        },
      } as DbExecutor);
      const resposta = pub.responderPesquisa({ token: p.token, notaIndicacao: 9 }, { ip: ip() }, {
        withTransaction: <T>(work: (tx: DbExecutor) => Promise<T>) => porTransacao(c1)((tx) => work(comBarreira(tx))), anel: () => anel, repeticao: { esperar: async () => {} },
      });
      await chegou.p;
      const cancelamento = entrada().then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
      const esperando = await esperarBloqueio(c3, p2, p1, trechoDaEspera);
      seguir.liberar();
      assert.deepEqual(await resposta, { gravada: true, linkAvaliacao: null });
      return { esperando, cancelamento: await cancelamento };
    }

    await t.test("Festa, cancelamento primeiro: a resposta nunca espera (55P03 na hora); o cancelamento confirma e a próxima tentativa revoga", async () => {
      const p = await envioFormalizado();
      const r = await cancelamentoPrimeiro(p, () => cancelarPelaFesta(p), /UPDATE contratos SET status='CANCELADO'/);
      assert.equal(r.cancelamento.ok, true, `cancelamento real: ${(r.cancelamento as { e?: Error }).e?.message ?? ""}`);
      assert.deepEqual(r.codigos, ["55P03"], "uma tentativa recusada por pai ocupado, sem espera");
      assert.equal(r.resultado.ok, false);
      assert.ok(erroDe("LINK_INDISPONIVEL", 404)(r.resultado.e), "a tentativa seguinte vê o contrato cancelado");
      assert.deepEqual(await estado(p.envio), { estado: "REVOGADO", motivo_revogacao: "CONTRATO_NAO_ASSINADO" });
      assert.equal((await um(`SELECT status FROM contratos WHERE id = $1::uuid`, [p.contrato])).status, "CANCELADO");
      assert.equal(await respostas(p.envio), 0);
    });

    await t.test("Festa, resposta primeiro: o cancelamento ESPERA a resposta (PIDs) e confirma depois; RESPONDIDO se preserva", async () => {
      const p = await envioFormalizado();
      const r = await respostaPrimeiro(p, () => cancelarPelaFesta(p), "FROM empresas WHERE id = $1::uuid FOR UPDATE");
      assert.equal(r.cancelamento.ok, true, `cancelamento real: ${(r.cancelamento as { e?: Error }).e?.message ?? ""}`);
      assert.equal((await um(`SELECT status FROM contratos WHERE id = $1::uuid`, [p.contrato])).status, "CANCELADO");
      assert.equal((await estado(p.envio)).estado, "RESPONDIDO", "resposta confirmada antes do cancelamento continua valendo");
      assert.equal(await respostas(p.envio), 1);
    });

    await t.test("operarContrato, entrada primeiro: a resposta nunca espera; o operarContrato recusa contrato assinado e desfaz; a resposta grava", async () => {
      const p = await envioFormalizado();
      const r = await cancelamentoPrimeiro(p, () => cancelarPeloContrato(p), /FROM contratos WHERE id=\$1 FOR UPDATE/);
      assert.equal(r.cancelamento.ok, false);
      assert.match(String((r.cancelamento as { e: Error }).e.message), /Use o fluxo de cancelamento da Festa/);
      assert.deepEqual(r.codigos, ["55P03"]);
      assert.deepEqual(r.resultado, { ok: true, r: { gravada: true, linkAvaliacao: null } });
      assert.equal((await um(`SELECT status FROM contratos WHERE id = $1::uuid`, [p.contrato])).status, "ASSINADO");
      assert.equal((await estado(p.envio)).estado, "RESPONDIDO");
    });

    await t.test("operarContrato, resposta primeiro: a entrada ESPERA a resposta (PIDs) e depois recusa o contrato assinado", async () => {
      const p = await envioFormalizado();
      const r = await respostaPrimeiro(p, () => cancelarPeloContrato(p), "FROM empresas WHERE id = $1::uuid FOR UPDATE");
      assert.equal(r.cancelamento.ok, false);
      assert.match(String((r.cancelamento as { e: Error }).e.message), /Use o fluxo de cancelamento da Festa/);
      assert.equal((await estado(p.envio)).estado, "RESPONDIDO");
    });
  } finally {
    delete global.__kidmaisPgPool;
    if (festaAntes === undefined) delete process.env.FESTA_ENABLED; else process.env.FESTA_ENABLED = festaAntes;
    await encerrarDescartavel(c3, false);
    await encerrarDescartavel(c2, false);
    await encerrarDescartavel(c1);
  }
});
