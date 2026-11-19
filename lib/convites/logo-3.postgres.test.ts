import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import sharp from "sharp";
import type { Client } from "pg";
import { hashToken } from "../autenticacao/senha.ts";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { hashSnapshotContrato } from "../contratos/services/snapshot-core.ts";
import { lerCsv } from "../exportacao/fixture.postgres.test-apoio.ts";
import { lerZip } from "../exportacao/zip.ts";
import { executor } from "../marketing/harness-postgres.ts";
import { hashTextoIA } from "./consentimento.ts";
import { VERSAO_TEXTOS_IA } from "./consentimento-textos.ts";

/**
 * Logo do buffet no convite, etapa 3 (plano r15.1, §9 "Serviço", "Ordem no servidor", "Rota real", "Fila com o transporte
 * real", "logoOrdem persistida" e 3b), sobre o modelo 124 (estado de staging) num cluster descartável. Serviço, rotas e
 * fila são os módulos reais; o banco é um pool de conexões PRÓPRIAS do cluster com BEGIN/COMMIT de verdade, então a
 * barreira `antesDosBloqueios` (só na chamada interna) e a intercalação com travas acontecem entre transações reais.
 * Nenhuma rede: a IA do 3b é um `fetch` dublê que só atende api.openai.com em memória.
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

const ORIGEM = "http://localhost:3000";
const SENHA_FALSA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const cod = () => `lg${randomBytes(3).toString("hex")}`;
const dormir = (ms: number) => new Promise((fim) => setTimeout(fim, ms));
const pidDe = async (c: Client) => Number((await c.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);

type Posicao = { modo: "sobre" | "faixa"; arteId: string; x: number; y: number; largura: number; fundo: boolean; origem?: string };
type Conteudo = Record<string, unknown> & { arteId?: string | null; logoBuffet?: boolean; logoPosicoes?: Record<string, Posicao>;
  logoOrdem?: { sessoes: { id: string; mostrar?: number; posicoes?: Record<string, number> }[] }; logoGeracoes?: string[]; logoSemNome?: string[] };
type Linha = { rascunho: Conteudo; publicado: Conteudo | null; revisao: number; atualizado_em: Date; eventos: number };
type Acesso = { tipo: "admin"; sessao: Record<string, unknown>; conviteId: string } | { tipo: "cliente"; token: string };
type Resultado = Record<string, unknown> & { logoSessao?: string; aplicado?: { mostrar?: boolean; posicoes?: Record<string, boolean> }; artesAusentes?: string[] };
type Servico = {
  comandar(a: Acesso, raw: unknown): Promise<Resultado>;
  comandarInterno(a: Acesso, raw: unknown, op?: { antesDosBloqueios?: () => Promise<void> }): Promise<Resultado>;
  consultar(a: Acesso, criar?: boolean): Promise<Record<string, unknown> & { conteudo: Conteudo }>;
  consultarPublico(token: string, familia: string | null): Promise<Record<string, unknown> & { conteudo: Conteudo; logoSobre: unknown }>;
  resolverGeracaoIncerta(tx: unknown, op: string, raw: unknown): Promise<unknown>;
};
type Resposta = { status: number; json(): Promise<Record<string, unknown>>; arrayBuffer(): Promise<ArrayBuffer> };

const P = (arteId: string, x = 50, extra: Partial<Posicao> = {}): Posicao => ({ modo: "sobre", arteId, x, y: 50, largura: 18, fundo: false, ...extra });
const semOrigem = (p: Posicao | undefined) => { if (!p) return p; const { origem: _o, ...r } = p; void _o; return r; };

/** Barreira: o comando para depois de abrir a transação e antes do primeiro bloqueio até `soltar()`. */
function barreira() {
  let chegou!: () => void, soltar!: () => void;
  const chegada = new Promise<void>((r) => { chegou = r; });
  const liberada = new Promise<void>((r) => { soltar = r; });
  return { op: { antesDosBloqueios: async () => { chegou(); await liberada; } }, chegada, soltar };
}

test("etapa 3 no PG descartável: sessões, ordem, intercalação, rotas reais, fila real, logoOrdem, exportação e 3b", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const envAntes = { ...process.env };
  const g = globalThis as unknown as Record<string, unknown>;
  const globaisAntes = { fetch: g.fetch, window: g.window, sessionStorage: g.sessionStorage };
  Object.assign(process.env, { NODE_ENV: "test", ADMIN_AUTH_ORIGIN: ORIGEM, ADMIN_AUTH_SECRET: `segredo-sintetico-de-teste-${"x".repeat(24)}`,
    CONVITES_ENABLED: "true", FESTA_ENABLED: "true", CONVITES_IA_ENABLED: "true", CONVITES_IA_PROVIDER: "openai", OPENAI_API_KEY: "sk-sintetica-de-teste",
    CONVITES_IA_TETO_DIARIO_MICROUSD: "100000000" });
  delete process.env.RENDER; delete process.env.KIDMAIS_DEPLOY_ENV; delete process.env.CONVITE_LOGO_AUTO;

  const c = await conectarDescartavel();
  const extras: Client[] = [];
  for (let i = 0; i < 6; i++) extras.push(await conectarDescartavel({ travar: false }));
  const [auto, obs, ...rota] = extras;
  try {
    // ---- pool real: `query` em autocommit; `connect` entrega uma conexão livre (BEGIN/COMMIT reais) ----
    const livres = [...rota];
    const esperando: Array<(cx: Client) => void> = [];
    const pids = new Map<Client, number>();
    for (const cx of rota) pids.set(cx, await pidDe(cx));
    let segurar: { re: RegExp; chegou: (pid: number) => void; portao: Promise<void> } | null = null;
    (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool = {
      query: (sql: string, v?: unknown[]) => auto.query(sql, v),
      connect: async () => {
        const cx = livres.shift() ?? await new Promise<Client>((r) => esperando.push(r));
        return {
          query: async (sql: string, v?: unknown[]) => {
            const r = await cx.query(sql, v);
            const s = segurar;
            if (s && s.re.test(sql)) { segurar = null; s.chegou(pids.get(cx)!); await s.portao; }
            return r;
          },
          release() { const proximo = esperando.shift(); if (proximo) proximo(cx); else livres.push(cx); },
        };
      },
    };
    /** Segura a transação que executar `re` logo DEPOIS dessa instrução (travas já tomadas) até `soltar()`. */
    function segurarDepois(re: RegExp) {
      let soltar!: () => void, chegou!: (pid: number) => void;
      const portao = new Promise<void>((r) => { soltar = r; });
      const pid = new Promise<number>((r) => { chegou = r; });
      segurar = { re, chegou, portao };
      return { pid, soltar };
    }
    async function esperarBloqueadoPor(pid: number) {
      for (let i = 0; i < 400; i++) {
        const r = (await obs.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [pid])).rows[0];
        if (r.n > 0) return true;
        await dormir(25);
      }
      return false;
    }

    const svc = carregar<Servico>("lib/convites/service.ts");
    const { withTransaction } = carregar<{ withTransaction: <T>(w: (tx: unknown) => Promise<T>) => Promise<T> }>("lib/db/postgres.ts");
    type Rota = { GET(r: unknown, ctx?: unknown): Promise<Resposta>; POST(r: unknown, ctx?: unknown): Promise<Resposta> };
    const rotaAdmin = carregar<Rota>("app/api/admin/convites/route.ts");
    const rotaPublica = carregar<Rota>("app/api/convites/publico/[token]/route.ts");
    const pacote = carregar<{ gerarPacote(tx: unknown, empresa: string): Promise<{ zipCaminho: string; manifesto: { arquivos: Array<{ caminho: string; tabela?: string; linhas?: number; sha256: string }> }; limpar(): Promise<void> }> }>("lib/exportacao/pacote.ts");
    const { NextRequest } = exigir("next/server") as { NextRequest: new (url: string, init: { method: string; headers: Headers; body?: string }) => unknown };

    // ---- fixtures (autocommit em `c`) ----
    const um = async <T = Record<string, unknown>>(sql: string, v: unknown[] = []) => (await c.query(sql, v)).rows[0] as T;
    const id = async (sql: string, v: unknown[]) => (await um<{ id: string }>(sql, v)).id;
    async function empresa(nome: string) {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`, [cod(), nome]);
      await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      await c.query(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, documento_teste)
        VALUES ($1::uuid, 'TESTE', clock_timestamp() - interval '40 days', clock_timestamp() - interval '25 days', $2)`, [e, cnpj()]);
      await c.query(`UPDATE empresa_assinaturas SET situacao = 'ATIVA', ciclo = 'MENSAL', periodo_atual_fim = clock_timestamp() + interval '20 days', provedor = 'ASAAS',
        provedor_cliente_id = $2, provedor_assinatura_id = $3, provedor_situacao = 'ACTIVE' WHERE empresa_id = $1::uuid`, [e, `cus_${cod()}`, `sub_${cod()}`]);
      await c.query("INSERT INTO convite_carteiras (empresa_id, limite_mensal, ativo) VALUES ($1::uuid, 50, true)", [e]);
      return e;
    }
    function cnpj() {
      const d = Array.from(randomBytes(12), (b) => b % 10);
      const dv = (n: number[]) => { const p = n.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        const r = n.reduce((s, x, i) => s + x * p[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
      d.push(dv(d)); d.push(dv(d));
      return d.join("");
    }
    async function gestao(empresaId: string) {
      const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Logo', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`,
        [`${cod()}@example.test`, SENHA_FALSA]);
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), 'REPRESENTANTE_AUTORIZADO') RETURNING id::text AS id`, [empresaId, u]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      for (const cap of ["FESTA_OPERAR", "FESTA_CONSULTAR"])
        await c.query(`INSERT INTO festa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'Teste etapa 3')`, [empresaId, m, cap, u]);
      return u;
    }
    async function sessaoAdmin(usuarioId: string, empresaId: string) {
      const token = randomBytes(32).toString("base64url"), csrf = randomBytes(32).toString("base64url");
      const s = (await c.query(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
        VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '8 hours', $4::uuid) RETURNING *`, [usuarioId, hashToken(token), hashToken(csrf), empresaId])).rows[0] as Record<string, unknown>;
      return { sessao: s, token, csrf, usuario: usuarioId };
    }
    /** Contrato ASSINADO com versão vigente, a Festa e o convite (mesmo fixture de lib/creditos/creditos-095.postgres.test.ts). */
    async function festa(empresaId: string, criador: string) {
      // Como em lib/creditos/creditos-095.postgres.test.ts: o fixture de contrato (cópia da 088) não fecha as validações adiadas de
      // assinatura/revisão; só nesta transação de preparação os gatilhos ficam desligados (banco descartável, superusuário sintético).
      await c.query("BEGIN");
      try {
        await c.query("SET LOCAL session_replication_role = replica");
        const r = await festaNaTransacao(empresaId, criador);
        await c.query("COMMIT");
        return r;
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
    }
    async function festaNaTransacao(empresaId: string, criador: string) {
      const pacoteId = await id(`INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Festa LG', 1, true, true) RETURNING id::text AS id`, [empresaId, cod().toUpperCase()]);
      const tabela = await id(`INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela LG', '2026-01-01', false, $2::uuid) RETURNING id::text AS id`, [cod(), empresaId]);
      const preco = await id(`INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id::text AS id`, [tabela, pacoteId]);
      const agenda = await id(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda LG', '10:00', '18:00', 9) RETURNING id::text AS id`, [cod()]);
      const cliente = await id(`INSERT INTO clientes (nome_completo, empresa_id) VALUES ('Cliente LG', $1::uuid) RETURNING id::text AS id`, [empresaId]);
      const fechamento = await id(`INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
        VALUES ('2099-09-01', '14:00', '18:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $6::uuid, 'AGUARDANDO_PAGAMENTO') RETURNING id::text AS id`,
        [agenda, empresaId, pacoteId, tabela, preco, cliente]);
      const contrato = await id(`INSERT INTO contratos (fechamento_id, status, assinado_em) VALUES ($1::uuid, 'ASSINADO', now()) RETURNING id::text AS id`, [fechamento]);
      const snapshot = { comercial: { valorFinalContrato: 100 }, evento: { data: "2099-09-01", convidados: 20, pacote: { codigo: "LG", nome: "Festa LG" } }, contratacao: { buffet: {}, adicionais: [] } };
      const hash = hashSnapshotContrato(snapshot);
      const pdf = Buffer.from(`%PDF-1.4\n% LG contrato ${randomUUID()}\n%%EOF\n`);
      const pdfHash = createHash("sha256").update(pdf).digest("hex");
      const versao = await id(`INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
         VALUES ($1::uuid, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP') RETURNING id::text AS id`, [contrato, JSON.stringify(snapshot), hash, pdfHash]);
      const doc = await id(`INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf, gerado_por_usuario_id)
         VALUES ($1::uuid, 'CONTRATO', 1, $2, 'CONTRATO_LG', 1, $3, $4, $5, $6::uuid) RETURNING id::text AS id`, [versao, hash, pdfHash, pdf.length, pdf, criador]);
      const comprovante = await id(`INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf)
         VALUES ($1::uuid, 'COMPROVANTE_ASSINATURA', 1, $2, 'COMPROVANTE_LG', 1, $3, $4, $5) RETURNING id::text AS id`, [versao, hash, pdfHash, pdf.length, pdf]);
      await c.query(`INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id, documento_revisado_id, revisado_por_usuario_id, revisado_em)
         VALUES ($1::uuid, $2::uuid, 'INICIAL', 'CONCLUIDA', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $3::uuid, $3::uuid, $4::uuid, $3::uuid, now())`, [versao, contrato, criador, doc]);
      const validacao = await id(`INSERT INTO validacoes_identidade_cliente (cliente_id, canal, status, confirmado_em, token_prova_hash, prova_expira_em) VALUES ($1::uuid, 'EMAIL', 'CONFIRMADA', now(), $2, now() + interval '10 minutes') RETURNING id::text AS id`, [cliente, randomBytes(32).toString("hex")]);
      await c.query(`INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, usuario_id, sessao_id, autenticacao_metodo, autenticado_em, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
         VALUES ($1::uuid, 'KIDMAIS', $2::uuid, $3::uuid, $4::uuid, 'SENHA', now(), $5::jsonb, $6, $7, 'SESSAO_REAUTENTICADA', 'INTERNAL', now(), $8::uuid, $9::uuid, $10::uuid)`,
        [versao, doc, criador, randomUUID(), JSON.stringify({ usuarioId: criador, papel: "REPRESENTANTE_AUTORIZADO", nome: "Usuário LG", cargo: null }), hash, pdfHash, randomUUID(), randomUUID(), comprovante]);
      await c.query(`INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, validacao_identidade_id, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
         VALUES ($1::uuid, 'CLIENTE', $2::uuid, $3::uuid, $4::jsonb, $5, $6, 'OTP', 'INTERNAL', now(), $7::uuid, $8::uuid, $9::uuid)`,
        [versao, doc, validacao, JSON.stringify({ schemaVersao: 1, clienteId: cliente, nome: "Cliente LG" }), hash, pdfHash, randomUUID(), randomUUID(), comprovante]);
      await c.query(`INSERT INTO contrato_fluxos (contrato_id, versao_vigente_id) VALUES ($1::uuid, $2::uuid)`, [contrato, versao]);
      await c.query("UPDATE contratos SET versao_atual = 1 WHERE id = $1::uuid", [contrato]);
      const f = await id(`INSERT INTO festas (contrato_id, versao_contratual_criacao_id, chave_criacao, payload_hash, criado_por) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid) RETURNING id::text AS id`,
        [contrato, versao, randomUUID(), createHash("sha256").update(cod()).digest("hex"), criador]);
      const token = randomBytes(32).toString("base64url"), publico = randomBytes(32).toString("base64url");
      const rascunho = { tema: "celebrar", nome: "Alice", idade: "5 anos", data: "2099-09-01", horario: "14:00", local: "Salão", endereco: "Rua Sintética, 1", mensagem: "Venha!", arteId: null, confirmarPresenca: true };
      const convite = await id(`INSERT INTO convites (empresa_id, festa_id, cliente_id, estabelecimento_id, publico_token, rascunho, versao_contrato_id, limite_festa, limite_cliente, editor_hash, editor_expira_em)
        VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, $4, $5::jsonb, $6::uuid, 20, 20, $7, now() + interval '1 day') RETURNING id::text AS id`,
      [empresaId, f, cliente, publico, JSON.stringify(rascunho), versao, createHash("sha256").update(token).digest("hex")]);
      return { id: convite, token, publico };
    }
    const WEBP = await sharp({ create: { width: 64, height: 96, channels: 3, background: { r: 30, g: 120, b: 200 } } }).webp().toBuffer();
    async function arte(conviteId: string, empresaId: string) {
      return id(`INSERT INTO convite_artes (convite_id, empresa_id, imagem, origem) VALUES ($1::uuid, $2::uuid, $3, 'UPLOAD') RETURNING id::text AS id`, [conviteId, empresaId, WEBP]);
    }
    /** Perfil APLICADO com logo PNG (ligação direta perfil.id = empresa.id). */
    async function perfilComLogo(empresaId: string, autor: string) {
      const codigoEmpresa = (await um<{ codigo: string }>("SELECT codigo FROM empresas WHERE id = $1::uuid", [empresaId])).codigo;
      await c.query("INSERT INTO perfil_empresas (id, codigo) VALUES ($1::uuid, $2)", [empresaId, codigoEmpresa]);
      const unidade = await id(`INSERT INTO perfil_unidades (empresa_id, codigo, nome, mesmo_endereco_sede) VALUES ($1::uuid, $2, 'Sede', true) RETURNING id::text AS id`, [empresaId, `U${cod()}`]);
      const png = await sharp({ create: { width: 120, height: 40, channels: 4, background: { r: 200, g: 20, b: 60, alpha: 1 } } }).png().toBuffer();
      const logo = `data:image/png;base64,${png.toString("base64")}`;
      await c.query(`INSERT INTO perfil_empresa_revisoes (empresa_id, unidade_id, numero, estado, versao_base, edicao, conteudo, motivo, autor_id, aplicado_em, aplicado_por)
        VALUES ($1::uuid, $2::uuid, 1, 'APLICADA', 0, 1, $3::jsonb, 'Logo sintética', $4::uuid, now(), $4::uuid)`, [empresaId, unidade, JSON.stringify({ logoDataUrl: logo }), autor]);
      return logo;
    }

    const A = await empresa("Buffet Logo A"), B = await empresa("Buffet Logo B");
    const uA = await gestao(A), uB = await gestao(B);
    const sA = await sessaoAdmin(uA, A), sB = await sessaoAdmin(uB, B);
    await perfilComLogo(A, uA);
    const adm = (conviteId: string, s = sA): Acesso => ({ tipo: "admin", sessao: s.sessao, conviteId });
    const cli = (token: string): Acesso => ({ tipo: "cliente", token });
    const ler = async (conviteId: string): Promise<Linha> => um<Linha>(`SELECT rascunho, publicado, revisao, atualizado_em,
      (SELECT count(*)::int FROM convite_eventos e WHERE e.convite_id = c.id) AS eventos FROM convites c WHERE id = $1::uuid`, [conviteId]);
    const bruto = async (conviteId: string) => um<{ r: string; p: string | null }>("SELECT rascunho::text AS r, publicado::text AS p FROM convites WHERE id = $1::uuid", [conviteId]);
    /** Convite novo de A com duas artes, publicado com a primeira (rascunho = publicado). */
    async function novoConvite(publicar = true) {
      const cv = await festa(A, uA);
      const x = await arte(cv.id, A), y = await arte(cv.id, A);
      if (publicar) {
        const r = await ler(cv.id);
        await svc.comandar(adm(cv.id), { acao: "publicar", revisao: r.revisao, conteudo: { ...r.rascunho, arteId: x, visual: { modo: "completa", ajuste: "conter", x: 50, y: 50 } } });
      }
      return { ...cv, x, y };
    }
    const sessao = async (conviteId: string, substitui?: string) => (await svc.comandar(adm(conviteId), { acao: "logo_sessao", ...(substitui ? { substitui } : {}) })).logoSessao!;
    const logo = (conviteId: string, s: string, seq: number, extra: { mostrar?: boolean; posicoes?: Posicao[] }) =>
      svc.comandar(adm(conviteId), { acao: "logo_buffet", sessao: s, seq, ...extra });
    const listaSessoes = async (conviteId: string) => ((await ler(conviteId)).rascunho.logoOrdem?.sessoes ?? []).map((x) => x.id);
    const rejeita409 = (p: Promise<unknown>) => assert.rejects(p, (e: { status?: number; publico?: { codigo?: string } }) => e.status === 409 && e.publico?.codigo === "sessao_expirada");

    await t.test("sessões: logo_sessao só no rascunho, 20 últimas, substitui, ids nunca reciclados, família 403", async () => {
      const cv = await novoConvite();
      const antes = await ler(cv.id);
      const s1 = await sessao(cv.id);
      const depois = await ler(cv.id);
      assert.deepEqual([depois.revisao, depois.atualizado_em.getTime(), depois.eventos], [antes.revisao, antes.atualizado_em.getTime(), antes.eventos], "sem revisão, atualizado_em nem evento");
      assert.deepEqual(depois.publicado, antes.publicado, "publicado intacto");
      const { logoOrdem: _o, ...restoDepois } = depois.rascunho; void _o;
      assert.deepEqual(restoDepois, antes.rascunho, "só logoOrdem muda no rascunho");
      assert.deepEqual(await listaSessoes(cv.id), [s1]);
      await assert.rejects(svc.comandar(cli(cv.token), { acao: "logo_sessao" }), (e: { status?: number }) => e.status === 403);
      await assert.rejects(svc.comandar(cli(cv.token), { acao: "logo_buffet", sessao: s1, seq: 1, mostrar: false }), (e: { status?: number }) => e.status === 403);
      // id nunca aberto → 409 sem gravar nada (byte a byte)
      const b0 = await bruto(cv.id);
      await rejeita409(logo(cv.id, randomUUID(), 1, { mostrar: false, posicoes: [P(cv.x)] }));
      assert.deepEqual(await bruto(cv.id), b0);
      // 30 em série + 10 concorrentes (conexões diferentes do pool): todos distintos; a lista = 20 últimos na ordem de commit
      const emitidos = [s1];
      for (let i = 0; i < 29; i++) emitidos.push(await sessao(cv.id));
      const concorrentes = await Promise.all(Array.from({ length: 10 }, () => sessao(cv.id)));
      emitidos.push(...concorrentes);
      assert.equal(new Set(emitidos).size, 40, "40 ids distintos");
      const lista = await listaSessoes(cv.id);
      assert.equal(lista.length, 20);
      assert.deepEqual(lista.slice(0, 10), emitidos.slice(20, 30), "as 10 mais antigas restantes são as últimas da série");
      assert.deepEqual(new Set(lista.slice(10)), new Set(concorrentes), "as 10 concorrentes no fim");
      const expulsos = emitidos.filter((x) => !lista.includes(x));
      assert.equal(expulsos.length, 20);
      for (let i = 0; i < 5; i++) await sessao(cv.id);
      const b1 = await bruto(cv.id);
      for (const x of [expulsos[0], expulsos[19]]) await rejeita409(logo(cv.id, x, 99, { mostrar: false }));
      assert.deepEqual(await bruto(cv.id), b1, "expulsos continuam 409 sem gravar");
      // substitui: sai o indicado, novo no fim, os outros na mesma ordem
      const atual = await listaSessoes(cv.id);
      const alvo = atual[7];
      const novo = await sessao(cv.id, alvo);
      assert.deepEqual(await listaSessoes(cv.id), [...atual.filter((x) => x !== alvo), novo]);
      // substitui fora da lista: só abre (e expulsa a mais antiga); formato inválido → 400
      const antesFora = await listaSessoes(cv.id);
      const outro = await sessao(cv.id, expulsos[3]);
      assert.deepEqual(await listaSessoes(cv.id), [...antesFora.slice(1), outro]);
      await assert.rejects(svc.comandar(adm(cv.id), { acao: "logo_sessao", substitui: "nao-e-uuid" }), (e: { name?: string; status?: number }) => e.status === 400 || e.name === "ZodError");
      // 21 aberturas num convite novo → as 20 últimas, a primeira saiu
      const cv2 = await novoConvite(false);
      const abertas: string[] = [];
      for (let i = 0; i < 21; i++) abertas.push(await sessao(cv2.id));
      assert.deepEqual(await listaSessoes(cv2.id), abertas.slice(1));
    });

    await t.test("logo_buffet: duas colunas sem revisão, publicado nulo, campos independentes, seq, última vence, artes ausentes, outra empresa 404", async () => {
      const cv = await novoConvite();
      const s = await sessao(cv.id);
      const antes = await ler(cv.id);
      const r1 = await logo(cv.id, s, 1, { posicoes: [P(cv.x, 20)] });
      assert.deepEqual(r1, { aplicado: { posicoes: { [cv.x]: true } }, artesAusentes: [] });
      const d1 = await ler(cv.id);
      assert.equal(d1.revisao, antes.revisao, "sem mudar revisão");
      assert.ok(d1.atualizado_em.getTime() >= antes.atualizado_em.getTime());
      assert.equal(d1.eventos, antes.eventos + 1, "evento LOGO_BUFFET");
      assert.deepEqual(semOrigem(d1.rascunho.logoPosicoes?.[cv.x]), P(cv.x, 20));
      assert.equal(d1.rascunho.logoPosicoes?.[cv.x]?.origem, "buffet");
      assert.deepEqual(d1.publicado?.logoPosicoes, d1.rascunho.logoPosicoes);
      assert.equal("logoOrdem" in d1.publicado!, false);
      const { logoPosicoes: _a, logoOrdem: _b, ...outrosR } = d1.rascunho; void _a; void _b;
      const { logoOrdem: _c, ...outrosAntes } = antes.rascunho; void _c;
      assert.deepEqual(outrosR, outrosAntes, "nenhum outro campo do rascunho muda");
      // só mostrar preserva a posição; só posição preserva mostrar
      await logo(cv.id, s, 2, { mostrar: false });
      let d = await ler(cv.id);
      assert.equal(d.rascunho.logoBuffet, false); assert.equal(d.publicado?.logoBuffet, false);
      assert.equal(d.rascunho.logoPosicoes?.[cv.x]?.x, 20);
      await logo(cv.id, s, 3, { posicoes: [P(cv.x, 30)] });
      d = await ler(cv.id);
      assert.equal(d.rascunho.logoBuffet, false); assert.equal(d.publicado?.logoPosicoes?.[cv.x]?.x, 30);
      // seq por campo: a 3 já gravou a posição (repetida → ignorada), mas é nova para `mostrar` (a última foi 2) → aplicada
      const rep = await logo(cv.id, s, 3, { mostrar: true, posicoes: [P(cv.x, 90)] });
      assert.deepEqual(rep.aplicado, { mostrar: true, posicoes: { [cv.x]: false } });
      d = await ler(cv.id);
      assert.equal(d.rascunho.logoBuffet, true); assert.equal(d.rascunho.logoPosicoes?.[cv.x]?.x, 30);
      // a mesma seq de novo para os dois campos → nada aplicado
      const rep2 = await logo(cv.id, s, 3, { mostrar: false, posicoes: [P(cv.x, 91)] });
      assert.deepEqual(rep2.aplicado, { mostrar: false, posicoes: { [cv.x]: false } });
      d = await ler(cv.id);
      assert.equal(d.rascunho.logoBuffet, true); assert.equal(d.rascunho.logoPosicoes?.[cv.x]?.x, 30);
      // sessões diferentes: a última gravação vence
      const s2 = await sessao(cv.id);
      await logo(cv.id, s2, 1, { posicoes: [P(cv.x, 70)] });
      await logo(cv.id, s, 4, { posicoes: [P(cv.x, 60)] });
      assert.equal((await ler(cv.id)).publicado?.logoPosicoes?.[cv.x]?.x, 60);
      // arte de outro convite (r14): ignorada e devolvida em artesAusentes, sem 400; `mostrar` do mesmo comando vale
      const outro = await novoConvite(false);
      const b0 = (await ler(cv.id)).rascunho.logoPosicoes;
      const aus = await logo(cv.id, s, 5, { mostrar: true, posicoes: [P(outro.x, 10)] });
      assert.deepEqual(aus, { aplicado: { mostrar: true, posicoes: { [outro.x]: false } }, artesAusentes: [outro.x] });
      d = await ler(cv.id);
      assert.equal(d.rascunho.logoBuffet, true); assert.deepEqual(d.rascunho.logoPosicoes, b0);
      // seq é por arte; excluir a arte esquece a seq dela (por isso posição obsoleta com arte ausente não acontece)
      {
        const ob = await novoConvite();
        const sob = await sessao(ob.id);
        await logo(ob.id, sob, 2, { posicoes: [P(ob.y, 10)] });
        assert.deepEqual(await logo(ob.id, sob, 1, { posicoes: [P(ob.x, 13)] }), { aplicado: { posicoes: { [ob.x]: true } }, artesAusentes: [] }, "seq 1 vale numa arte ainda não gravada");
        assert.equal((await ler(ob.id)).rascunho.logoPosicoes?.[ob.x]?.x, 13);
        const rob = await ler(ob.id);
        await svc.comandar(adm(ob.id), { acao: "excluir_arte", arteId: ob.y, revisao: rob.revisao });
        assert.equal((await ler(ob.id)).rascunho.logoOrdem?.sessoes.find((x) => x.id === sob)?.posicoes?.[ob.y], undefined, "excluir arte esquece a seq dela");
        assert.deepEqual(await logo(ob.id, sob, 2, { posicoes: [P(ob.y, 12)] }), { aplicado: { posicoes: { [ob.y]: false } }, artesAusentes: [ob.y] });
      }
      // publicado nulo → só o rascunho
      const np = await novoConvite(false);
      const snp = await sessao(np.id);
      await logo(np.id, snp, 1, { mostrar: false, posicoes: [P(np.x, 40)] });
      const dn = await ler(np.id);
      assert.equal(dn.publicado, null); assert.equal(dn.rascunho.logoPosicoes?.[np.x]?.x, 40);
      // admin de outra empresa → 404, nada gravado
      const b1 = await bruto(cv.id);
      await assert.rejects(svc.comandar(adm(cv.id, sB), { acao: "logo_sessao" }), (e: { status?: number }) => e.status === 404);
      await assert.rejects(svc.comandar(adm(cv.id, sB), { acao: "logo_buffet", sessao: s, seq: 50, mostrar: false }), (e: { status?: number }) => e.status === 404);
      assert.deepEqual(await bruto(cv.id), b1);
    });

    await t.test("ordem no servidor (barreira antes dos bloqueios): obsoleto, campos independentes, misto com arte excluída, evicção, renovação e reload", async () => {
      // A retido; B (seq maior) confirma; A liberado → posição não aplicada, P2 persistida
      let cv = await novoConvite();
      let s1 = await sessao(cv.id);
      let b = barreira();
      let pa = svc.comandarInterno(adm(cv.id), { acao: "logo_buffet", sessao: s1, seq: 1, posicoes: [P(cv.x, 11)] }, b.op);
      await b.chegada;
      await logo(cv.id, s1, 2, { posicoes: [P(cv.x, 22)] });
      assert.equal((await ler(cv.id)).publicado?.logoPosicoes?.[cv.x]?.x, 22, "B confirmado antes de soltar A");
      b.soltar();
      assert.deepEqual((await pa).aplicado, { posicoes: { [cv.x]: false } });
      let d = await ler(cv.id);
      assert.deepEqual([d.rascunho.logoPosicoes?.[cv.x]?.x, d.publicado?.logoPosicoes?.[cv.x]?.x], [22, 22]);
      // A só mostrar, B só posição → os dois aplicados
      b = barreira();
      pa = svc.comandarInterno(adm(cv.id), { acao: "logo_buffet", sessao: s1, seq: 3, mostrar: false }, b.op);
      await b.chegada;
      await logo(cv.id, s1, 4, { posicoes: [P(cv.x, 33)] });
      b.soltar();
      assert.deepEqual((await pa).aplicado, { mostrar: true });
      d = await ler(cv.id);
      assert.deepEqual([d.publicado?.logoBuffet, d.publicado?.logoPosicoes?.[cv.x]?.x], [false, 33]);
      // misto obsoleto: A (seq 5, mostrar + X) retido; B (seq 6, Y) confirma; X excluída da galeria; A → mostrar sim, X não, sem 400
      cv = await novoConvite(false);
      s1 = await sessao(cv.id);
      b = barreira();
      pa = svc.comandarInterno(adm(cv.id), { acao: "logo_buffet", sessao: s1, seq: 5, mostrar: false, posicoes: [P(cv.y, 15)] }, b.op);
      await b.chegada;
      await logo(cv.id, s1, 6, { posicoes: [P(cv.x, 66)] });
      await svc.comandar(adm(cv.id), { acao: "excluir_arte", arteId: cv.y, revisao: (await ler(cv.id)).revisao });
      b.soltar();
      const ra = await pa;
      assert.equal(ra.aplicado?.mostrar, true);
      assert.equal(ra.aplicado?.posicoes?.[cv.y], false);
      d = await ler(cv.id);
      assert.equal(d.rascunho.logoBuffet, false); assert.equal(d.rascunho.logoPosicoes?.[cv.y], undefined); assert.equal(d.rascunho.logoPosicoes?.[cv.x]?.x, 66);
      // A depois da evicção: A (S1) retido; B (S1) confirma; 20 aberturas tiram S1; A → 409; P2 continua
      cv = await novoConvite();
      s1 = await sessao(cv.id);
      b = barreira();
      pa = svc.comandarInterno(adm(cv.id), { acao: "logo_buffet", sessao: s1, seq: 1, posicoes: [P(cv.x, 12)] }, b.op);
      await b.chegada;
      await logo(cv.id, s1, 2, { posicoes: [P(cv.x, 24)] });
      for (let i = 0; i < 20; i++) await sessao(cv.id);
      b.soltar();
      await rejeita409(pa);
      d = await ler(cv.id);
      assert.deepEqual([d.rascunho.logoPosicoes?.[cv.x]?.x, d.publicado?.logoPosicoes?.[cv.x]?.x], [24, 24]);
      // A depois da renovação: A (S1) retido; S1 sai; B (S1) → 409; abre S2 e B' confirma; A → 409; P2 continua
      cv = await novoConvite();
      s1 = await sessao(cv.id);
      b = barreira();
      pa = svc.comandarInterno(adm(cv.id), { acao: "logo_buffet", sessao: s1, seq: 1, posicoes: [P(cv.x, 13)] }, b.op);
      await b.chegada;
      for (let i = 0; i < 20; i++) await sessao(cv.id);
      await rejeita409(logo(cv.id, s1, 2, { posicoes: [P(cv.x, 26)] }));
      const s2 = await sessao(cv.id);
      await logo(cv.id, s2, 1, { posicoes: [P(cv.x, 26)] });
      b.soltar();
      await rejeita409(pa);
      assert.equal((await ler(cv.id)).publicado?.logoPosicoes?.[cv.x]?.x, 26);
      // A depois do reload: A (S1) retido; página nova abre com substitui S1 → S2 e B confirma; A → 409; B persistido
      cv = await novoConvite();
      s1 = await sessao(cv.id);
      const vizinha = await sessao(cv.id);
      b = barreira();
      pa = svc.comandarInterno(adm(cv.id), { acao: "logo_buffet", sessao: s1, seq: 1, posicoes: [P(cv.x, 14)] }, b.op);
      await b.chegada;
      const recarga = await sessao(cv.id, s1);
      assert.deepEqual(await listaSessoes(cv.id), [vizinha, recarga], "substitui tira S1 no mesmo commit; a outra aba fica");
      await logo(cv.id, recarga, 1, { posicoes: [P(cv.x, 28)] });
      b.soltar();
      await rejeita409(pa);
      d = await ler(cv.id);
      assert.deepEqual([d.rascunho.logoPosicoes?.[cv.x]?.x, d.publicado?.logoPosicoes?.[cv.x]?.x], [28, 28]);
      await logo(cv.id, vizinha, 1, { mostrar: false });
      assert.equal((await ler(cv.id)).publicado?.logoBuffet, false, "a outra aba grava sem 409");
    });

    await t.test("intercalação real com travas: logo_buffet × publicar e × salvar, nas duas ordens, ninguém perde o outro", async () => {
      for (const acao of ["publicar", "salvar"] as const) {
        for (const ordem of ["logo-primeiro", "texto-primeiro"] as const) {
          const cv = await novoConvite();
          const s = await sessao(cv.id);
          const r0 = await ler(cv.id);
          const texto = { ...r0.rascunho, nome: `Alice ${acao} ${ordem}` };
          const comandoTexto = () => svc.comandar(adm(cv.id), { acao, revisao: r0.revisao, conteudo: texto });
          const comandoLogo = () => logo(cv.id, s, 1, { posicoes: [P(cv.x, 77)] });
          const h = segurarDepois(ordem === "logo-primeiro" ? /UPDATE convites SET rascunho=jsonb_set/ : /UPDATE convites SET rascunho=\$2,publicado=CASE WHEN \$3/);
          const primeiro = ordem === "logo-primeiro" ? comandoLogo() : comandoTexto();
          const pidSegurado = await h.pid;
          const segundo = ordem === "logo-primeiro" ? comandoTexto() : comandoLogo();
          assert.ok(await esperarBloqueadoPor(pidSegurado), `${acao}/${ordem}: o segundo espera a trava do primeiro`);
          h.soltar();
          await Promise.all([primeiro, segundo]);
          const d = await ler(cv.id);
          assert.equal(d.rascunho.nome, texto.nome); assert.equal(d.rascunho.logoPosicoes?.[cv.x]?.x, 77);
          if (acao === "publicar") { assert.equal(d.publicado?.nome, texto.nome); assert.equal(d.publicado?.logoPosicoes?.[cv.x]?.x, 77); }
          else { assert.equal(d.publicado?.nome, r0.publicado?.nome, "salvar não publica"); assert.equal(d.publicado?.logoPosicoes?.[cv.x]?.x, 77, "a logo vale no publicado"); }
          assert.equal("logoOrdem" in d.publicado!, false);
          assert.deepEqual(d.rascunho.logoOrdem?.sessoes.map((x) => x.id), [s], "logoOrdem preservada");
        }
      }
    });

    await t.test("logoOrdem: forjada pela tela não grava, publicado sem a chave (com e sem histórico), publicado legado, respostas e exportação", async () => {
      const forjada = { sessoes: [{ id: randomUUID() }] };
      for (const comHistorico of [true, false]) {
        const cv = await novoConvite();
        const s = comHistorico ? await sessao(cv.id) : null;
        if (s) await logo(cv.id, s, 1, { posicoes: [P(cv.x, 35)] });
        for (const acao of ["salvar", "publicar"] as const) {
          const r = await ler(cv.id);
          await svc.comandar(adm(cv.id), { acao, revisao: r.revisao, conteudo: { ...r.rascunho, logoOrdem: forjada, logoPosicoes: { [cv.x]: { ...P(cv.x, 1), origem: "buffet" } }, logoBuffet: false } });
          const d = await ler(cv.id);
          assert.deepEqual(d.rascunho.logoOrdem?.sessoes.map((x) => x.id), s ? [s] : undefined, `${acao}: rascunho só com a gravada`);
          assert.equal(d.rascunho.logoBuffet, undefined, `${acao}: logoBuffet forjado descartado`);
          assert.equal(d.rascunho.logoPosicoes?.[cv.x]?.x, s ? 35 : undefined, `${acao}: logoPosicoes forjado descartado`);
          assert.equal(d.publicado && "logoOrdem" in d.publicado, false, `${acao}: publicado nunca tem logoOrdem`);
        }
        // salvar, publicar e excluir arte preservam logoOrdem inteira
        if (s) {
          const r = await ler(cv.id);
          await svc.comandar(adm(cv.id), { acao: "excluir_arte", arteId: cv.y, revisao: r.revisao });
          assert.deepEqual((await ler(cv.id)).rascunho.logoOrdem, r.rascunho.logoOrdem);
        }
      }
      // publicado legado com a chave (inserida direto): salvar e excluir arte não mexem; logo_buffet e publicar removem
      const cv = await novoConvite();
      const z = await arte(cv.id, A);
      const s = await sessao(cv.id);
      await c.query(`UPDATE convites SET publicado = publicado || jsonb_build_object('logoOrdem', jsonb_build_object('sessoes', '[]'::jsonb), 'logoGeracoes', '[]'::jsonb) WHERE id = $1::uuid`, [cv.id]);
      let r = await ler(cv.id);
      await svc.comandar(adm(cv.id), { acao: "salvar", revisao: r.revisao, conteudo: { ...r.rascunho, nome: "Salvo" } });
      assert.equal("logoOrdem" in (await ler(cv.id)).publicado!, true, "salvar não mexe na coluna publicado");
      r = await ler(cv.id);
      await svc.comandar(adm(cv.id), { acao: "excluir_arte", arteId: z, revisao: r.revisao });
      assert.equal("logoOrdem" in (await ler(cv.id)).publicado!, true, "excluir arte não mexe no resto do publicado");
      // respostas não mostram a chave mesmo com o legado na coluna
      for (const resposta of [await svc.consultar(adm(cv.id)), await svc.consultar(cli(cv.token)), await svc.consultarPublico(cv.publico, null)])
        assert.doesNotMatch(JSON.stringify(resposta), /logoOrdem|logoGeracoes/);
      // exportação: CSV de convites/convites sem logoOrdem, com as outras chaves
      await logo(cv.id, s, 1, { posicoes: [P(cv.x, 45)] });
      const legado = (await ler(cv.id)).publicado!;
      assert.equal("logoOrdem" in legado, false, "logo_buffet remove o logoOrdem legado do publicado");
      assert.equal("logoGeracoes" in legado, false, "logo_buffet remove o logoGeracoes legado do publicado");
      await c.query(`UPDATE convites SET publicado = publicado || jsonb_build_object('logoOrdem', jsonb_build_object('sessoes', '[]'::jsonb)),
        rascunho = rascunho || jsonb_build_object('logoSemNome', jsonb_build_array($2::text)) WHERE id = $1::uuid`, [cv.id, cv.x]);
      assert.deepEqual((await ler(cv.id)).rascunho.logoSemNome, [cv.x], "rascunho com logoSemNome antes de exportar");
      await obs.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      let zip: Map<string, Buffer>, manifesto: Awaited<ReturnType<typeof pacote.gerarPacote>>["manifesto"];
      try {
        await obs.query("SET LOCAL TimeZone = 'UTC'");
        const p = await pacote.gerarPacote(executor(obs), A);
        zip = lerZip(readFileSync(p.zipCaminho)); manifesto = p.manifesto;
        await p.limpar();
        await obs.query("COMMIT");
      } catch (e) { await obs.query("ROLLBACK").catch(() => {}); throw e; }
      const arq = manifesto.arquivos.find((x) => x.tabela === "convites")!;
      const [cab, ...linhas] = lerCsv(zip.get(arq.caminho)!.toString("utf8")).filter((l) => l.length > 1 || l[0] !== "");
      const linha = linhas.map((l) => Object.fromEntries(cab.map((k, i) => [k, l[i]]))).find((l) => l.id === cv.id)!;
      assert.ok(linha, "convite exportado");
      for (const col of ["rascunho", "publicado"]) {
        assert.doesNotMatch(linha[col], /logoOrdem|logoGeracoes|logoSemNome/, `${col} sem as chaves só do rascunho`);
        assert.match(linha[col], /logoPosicoes/, `${col} mantém logoPosicoes`);
      }
      // abrir o editor (leitura) não grava
      const antes = await ler(cv.id);
      await svc.consultar(adm(cv.id)); await svc.consultar(cli(cv.token));
      const depois = await ler(cv.id);
      assert.deepEqual([depois.atualizado_em.getTime(), depois.eventos, depois.revisao], [antes.atualizado_em.getTime(), antes.eventos, antes.revisao]);
      // família: leitura sem os campos da logo
      const familia = await svc.consultar(cli(cv.token));
      assert.equal(familia.logoBuffet, null);
      assert.doesNotMatch(JSON.stringify(familia.conteudo), /logoBuffet|logoPosicoes|logoSemNome/);
    });

    // ---- HTTP ----
    function pedido(metodo: string, url: string, acesso: { token: string; csrf: string } | null, corpo?: unknown, cab: Record<string, string | null> = {}) {
      const h = new Headers({ origin: ORIGEM, host: "localhost:3000", "content-type": "application/json" });
      if (acesso) { h.set("cookie", `kidmais_admin_dev=${acesso.token}`); h.set("x-csrf-token", acesso.csrf); }
      for (const [k, v] of Object.entries(cab)) { if (v === null) h.delete(k); else h.set(k, v); }
      return new NextRequest(`${ORIGEM}${url}`, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    }

    await t.test("rota pública: ?arte=<atual> bytes, <antigo> 409, lixo 404, 1 atual; JSON público só com a projeção permitida", async () => {
      const cv = await novoConvite();
      const s = await sessao(cv.id);
      await logo(cv.id, s, 1, { posicoes: [P(cv.x, 55, { fundo: true })] });
      const get = async (q: string) => rotaPublica.GET(pedido("GET", `/api/convites/publico/${cv.publico}${q}`, null), { params: Promise.resolve({ token: cv.publico }) });
      let r = await get(`?arte=${cv.x}`);
      assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), WEBP);
      r = await get(`?arte=1`);
      assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), WEBP);
      r = await get(`?arte=${cv.y}`);
      assert.equal(r.status, 409); assert.equal((await r.arrayBuffer()).byteLength, 0, "409 sem bytes");
      r = await get(`?arte=lixo`);
      assert.equal(r.status, 404);
      r = await get("");
      const corpo = await r.json() as { data: { logoSobre: Record<string, unknown>; conteudo: Conteudo } };
      assert.deepEqual(Object.keys(corpo.data.logoSobre).sort(), ["fundo", "largura", "x", "y"]);
      assert.deepEqual(corpo.data.logoSobre, { x: 55, y: 50, largura: 18, fundo: true });
      assert.doesNotMatch(JSON.stringify(corpo.data.conteudo), /logoPosicoes|logoOrdem|logoBuffet|logoSemNome/);
      await logo(cv.id, s, 2, { mostrar: false });
      assert.equal((await (await get("")).json() as { data: { logoSobre: unknown } }).data.logoSobre, null, "logoBuffet=false → null");
    });

    await t.test("rota admin real: 409 com codigo sessao_expirada; outros erros só com erro; sem x-csrf-token → 403 da guarda", async () => {
      const cv = await novoConvite();
      const url = `/api/admin/convites?conviteId=${cv.id}`;
      const post = async (corpo: unknown, cab: Record<string, string | null> = {}) => { const r = await rotaAdmin.POST(pedido("POST", url, sA, corpo, cab)); return { status: r.status, corpo: await r.json() }; };
      const s = await post({ acao: "logo_sessao" });
      assert.equal(s.status, 200, JSON.stringify(s.corpo));
      const b0 = await bruto(cv.id);
      const exp = await post({ acao: "logo_buffet", sessao: randomUUID(), seq: 1, mostrar: false });
      assert.equal(exp.status, 409);
      assert.deepEqual(Object.keys(exp.corpo).sort(), ["codigo", "erro", "ok"]);
      assert.deepEqual([exp.corpo.ok, exp.corpo.codigo, exp.corpo.erro], [false, "sessao_expirada", "A sessão da logo terminou."]);
      assert.deepEqual(await bruto(cv.id), b0);
      const outro = await post({ acao: "excluir_arte", arteId: randomUUID(), revisao: (await ler(cv.id)).revisao });
      assert.equal(outro.status, 404); assert.equal("codigo" in outro.corpo, false, "ConviteError sem `publico` não ganha codigo");
      const semCsrf = await post({ acao: "logo_sessao" }, { "x-csrf-token": null });
      assert.equal(semCsrf.status, 403);
      assert.deepEqual(await listaSessoes(cv.id), [(s.corpo.data as { logoSessao: string }).logoSessao], "nada aberto sem CSRF");
    });

    await t.test("fila com o transporte real: adminFetch → rota real → PG; sessão e gravação; 20 aberturas → 409, renova e grava", async () => {
      const cv = await novoConvite();
      const ENDPOINT = `/api/admin/convites?conviteId=${cv.id}`;
      const armazenado = new Map<string, string>();
      const chamadas: { acao: string; sessao?: string; substitui?: string; status: number }[] = [];
      g.window = { location: { pathname: "/admin/convites", replace() {}, assign() {} }, addEventListener() {}, removeEventListener() {} };
      g.sessionStorage = { getItem: (k: string) => armazenado.get(k) ?? null, setItem: (k: string, v: string) => { armazenado.set(k, v); }, removeItem: (k: string) => { armazenado.delete(k); } };
      g.fetch = async (input: string, init: RequestInit = {}) => {
        if (String(input) === "/api/admin/autenticacao")
          return Response.json({ ok: true, data: { usuarioId: uA, sessaoId: sA.sessao.id, csrf: sA.csrf, contexto: { empresaAtual: { id: A } } } });
        assert.equal(String(input), ENDPOINT, "a fila só chama a rota de convites");
        const h = new Headers(init.headers);
        h.set("cookie", `kidmais_admin_dev=${sA.token}`); h.set("origin", ORIGEM); h.set("host", "localhost:3000");
        const r = await rotaAdmin.POST(new NextRequest(`${ORIGEM}${ENDPOINT}`, { method: String(init.method), headers: h, body: String(init.body) }));
        const corpo = JSON.parse(String(init.body)) as { acao: string; sessao?: string; substitui?: string };
        chamadas.push({ acao: corpo.acao, sessao: corpo.sessao, substitui: corpo.substitui, status: r.status });
        assert.equal(init.keepalive, true); assert.equal(h.get("x-csrf-token"), sA.csrf);
        return r as unknown as Response;
      };
      const F = carregar<{ filaDaLogo(conviteId: string): { posicao(p: Posicao): void; temPendencia(): boolean; estado(): { situacao: string } } }>("lib/convites/fila-logo.ts");
      const fila = F.filaDaLogo(cv.id);
      const esvaziar = async () => { for (let i = 0; i < 400 && fila.temPendencia(); i++) await dormir(10); };
      fila.posicao(P(cv.x, 10));
      await esvaziar();
      assert.deepEqual(chamadas.map((x) => [x.acao, x.status]), [["logo_sessao", 200], ["logo_buffet", 200]]);
      const s1 = (await listaSessoes(cv.id))[0];
      assert.equal(chamadas[1].sessao, s1);
      assert.equal((await ler(cv.id)).publicado?.logoPosicoes?.[cv.x]?.x, 10);
      for (let i = 0; i < 20; i++) await sessao(cv.id);
      fila.posicao(P(cv.x, 30));
      await esvaziar();
      assert.deepEqual(chamadas.slice(2).map((x) => [x.acao, x.status]), [["logo_buffet", 409], ["logo_sessao", 200], ["logo_buffet", 200]]);
      const s2 = (await listaSessoes(cv.id)).at(-1);
      assert.deepEqual([chamadas[2].sessao, chamadas[3].substitui, chamadas[4].sessao], [s1, s1, s2], "id antigo, depois o novo");
      const d = await ler(cv.id);
      assert.deepEqual([d.rascunho.logoPosicoes?.[cv.x]?.x, d.publicado?.logoPosicoes?.[cv.x]?.x], [30, 30]);
      assert.equal(fila.estado().situacao, "salvo");
    });

    await t.test("3b: logoLigada divergente → 409 antes de reservar; flag ligada grava a posição automática; família não confere; incerta retira a chave", async () => {
      const PNG_ARTE = await sharp({ create: { width: 512, height: 768, channels: 3, background: { r: 245, g: 240, b: 230 } } }).png().toBuffer();
      // xadrez de 24 px (fixture (h) do §3.1): nenhum dos 6 lugares fica abaixo do limiar → faixa
      const xadrez = Buffer.alloc(512 * 768 * 3);
      for (let y = 0; y < 768; y++) for (let x = 0; x < 512; x++) xadrez.fill((Math.floor(x / 24) + Math.floor(y / 24)) % 2 ? 0 : 255, (y * 512 + x) * 3, (y * 512 + x) * 3 + 3);
      const PNG_RUIDO = await sharp(xadrez, { raw: { width: 512, height: 768, channels: 3 } }).png().toBuffer();
      let modo: "ok" | "ruido" | "rede" = "ok";
      const provedor: string[] = [];
      g.fetch = async (u: string | URL | Request) => {
        const url = typeof u === "string" ? u : u instanceof URL ? u.href : u.url;
        if (!url.startsWith("https://api.openai.com/")) throw new Error(`rede bloqueada no teste: ${url}`);
        provedor.push(url);
        if (modo === "rede") throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ data: [{ b64_json: (modo === "ruido" ? PNG_RUIDO : PNG_ARTE).toString("base64") }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
      };
      const cv = await novoConvite();
      const autorizacao = { acao: "autorizar_ia", versao: VERSAO_TEXTOS_IA, provedor: "openai", responsavelNome: "Responsável Sintético", vinculo: "MAE", declaracao: true };
      await svc.comandar(adm(cv.id), { ...autorizacao, meio: "PRESENCIAL", textoHash: hashTextoIA("openai", "BUFFET") });
      await svc.comandar(cli(cv.token), { ...autorizacao, textoHash: hashTextoIA("openai", "CLIENTE") });
      const completo = (logoLigada: boolean) => ({ acao: "gerar", chave: randomUUID(), prompt: "Tema jardim com borboletas", referencias: [], completo: true, estilo: "cartoon3d", logoLigada });
      const geracoes = async () => (await um<{ n: number }>("SELECT count(*)::int AS n FROM convite_geracoes WHERE convite_id = $1::uuid", [cv.id])).n;
      // divergente (tela diz desligada, gravado ligado) → 409 logo_em_gravacao, nada reservado nem enviado
      const n0 = await geracoes();
      await assert.rejects(svc.comandar(adm(cv.id), completo(false)), (e: { status?: number; publico?: { codigo?: string } }) => e.status === 409 && e.publico?.codigo === "logo_em_gravacao");
      assert.equal(await geracoes(), n0); assert.equal(provedor.length, 0);
      // flag desligada: gera sem logoGeracoes nem entrada automática
      const off = await svc.comandar(adm(cv.id), completo(true));
      assert.equal(off.estado, "CONCLUIDA", JSON.stringify(off));
      let d = await ler(cv.id);
      assert.equal(d.rascunho.logoPosicoes?.[String(off.arteId)], undefined); assert.deepEqual(d.rascunho.logoGeracoes ?? [], []);
      // flag ligada: entrada automática nas duas colunas, arte em logoSemNome, chave retirada
      process.env.CONVITE_LOGO_AUTO = "1";
      const on = await svc.comandar(adm(cv.id), completo(true));
      assert.equal(on.estado, "CONCLUIDA", JSON.stringify(on));
      d = await ler(cv.id);
      const entrada = d.rascunho.logoPosicoes?.[String(on.arteId)];
      assert.ok(entrada, "entrada automática gravada");
      assert.match(String(entrada.origem), /^(reservada|sugerida|faixa)$/, "origem automática, nunca buffet");
      assert.deepEqual(d.publicado?.logoPosicoes?.[String(on.arteId)], entrada);
      assert.deepEqual(d.rascunho.logoSemNome, [String(on.arteId)]);
      assert.deepEqual(d.rascunho.logoGeracoes, []);
      assert.equal("logoSemNome" in d.publicado!, false);
      // arte sem área lisa → caminho da faixa: a entrada é faixa e a arte também entra em logoSemNome
      modo = "ruido";
      const fx = await svc.comandar(adm(cv.id), completo(true));
      assert.equal(fx.estado, "CONCLUIDA", JSON.stringify(fx));
      d = await ler(cv.id);
      assert.equal(d.rascunho.logoPosicoes?.[String(fx.arteId)]?.origem, "faixa");
      assert.equal(d.rascunho.logoPosicoes?.[String(fx.arteId)]?.modo, "faixa");
      assert.deepEqual(d.rascunho.logoSemNome, [String(on.arteId), String(fx.arteId)]);
      assert.deepEqual(d.rascunho.logoGeracoes, []);
      modo = "ok";
      // família: o valor de logoLigada não é conferido e a geração dela nunca é "com logo" (desvio registrado para o Astra)
      const daFamilia = await svc.comandar(cli(cv.token), completo(false));
      assert.equal(daFamilia.estado, "CONCLUIDA", JSON.stringify(daFamilia));
      assert.equal((await ler(cv.id)).rascunho.logoPosicoes?.[String(daFamilia.arteId)], undefined);
      // falha de rede depois do envio → INCERTA com a chave em logoGeracoes; resolver retira a chave
      modo = "rede";
      const inc = await svc.comandar(adm(cv.id), completo(true));
      assert.equal(inc.estado, "VERIFICANDO");
      assert.deepEqual((await ler(cv.id)).rascunho.logoGeracoes, [String(inc.chave)]);
      modo = "ok";
      await withTransaction((tx) => svc.resolverGeracaoIncerta(tx, uA, { geracaoId: inc.chave, resultado: "SEM_COBRANCA", evidencia: "Painel da OpenAI sem cobrança (teste)" }));
      assert.deepEqual((await ler(cv.id)).rascunho.logoGeracoes, []);
    });
  } finally {
    Object.assign(g, globaisAntes);
    for (const k of Object.keys(process.env)) if (!(k in envAntes)) delete process.env[k];
    Object.assign(process.env, envAntes);
    delete (globalThis as { __kidmaisPgPool?: unknown }).__kidmaisPgPool;
    for (const cx of extras) await cx.end().catch(() => {});
    await encerrarDescartavel(c);
  }
});
