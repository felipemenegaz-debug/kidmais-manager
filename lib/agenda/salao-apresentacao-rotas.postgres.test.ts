import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { carregarComBanco, empresa, pedido, SENHA_FALSA, cod, vincular, type Resposta } from "../marketing/harness-postgres.ts";
import * as normalizacaoReal from "../imagens/normalizar-webp.ts";

/**
 * Rotas reais da apresentação do salão (102) e dos serviços comuns (103), modelo 103 no PostgreSQL DESCARTÁVEL. Guarda
 * administrativa dublada pela sessão sintética; tenant, Gestão e posse reais no banco (T4 do plano rev. 4):
 *   * leitura por membership; escrita só por Gestão (sem exceção de assistente); salão de outra empresa = 404 igual;
 *   * upload: a autorização vem ANTES de ler o corpo; teto efetivo do corpo sem Content-Length e com Content-Length
 *     falso, recusado antes do parse multipart e do sharp (normalização dublada conta as chamadas);
 *   * foto privada por empresa; declaração com versão desatualizada = 409;
 *   * rota da agenda: capacidade abaixo de sentados vira mensagem (409), não erro interno.
 * Desde a #239 (concorrência otimista da agenda) todo salvar da agenda leva a versaoAgenda do GET real da mesma sessão;
 * versão ausente ou antiga = 409 AGENDA_MUDOU (caso próprio abaixo), antes de qualquer tradução da S-A.
 * Tudo numa transação desfeita no fim.
 */
const BASE = "http://127.0.0.1:3000";
type Rota = Record<string, (r: unknown, ctx?: unknown) => Promise<Resposta>>;
type Corpo = { ok?: boolean; data?: unknown; erro?: string; codigo?: string };

async function pessoa(c: Client, empresaId: string, papel: "REPRESENTANTE_AUTORIZADO" | "ADMINISTRATIVO") {
  const usuario = (await c.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Pessoa', $2, $3, true) RETURNING id::text AS id`,
    [`${cod("u")}@saloes.test`, SENHA_FALSA, papel])).rows[0].id;
  return vincular(c, empresaId, usuario, papel);
}

/** Corpo multipart em stream; `lido` registra se alguém leu o corpo. */
function upload(url: string, bytes: Buffer, opcoes: { contentLength?: string; tamanhoFalso?: boolean } = {}) {
  const fronteira = "----kidmais102";
  const cabeca = Buffer.from(`--${fronteira}\r\nContent-Disposition: form-data; name="arquivo"; filename="foto.png"\r\nContent-Type: image/png\r\n\r\n`);
  const corpo = Buffer.concat([cabeca, bytes, Buffer.from(`\r\n--${fronteira}--\r\n`)]);
  const estado = { lido: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      estado.lido = true;
      for (let i = 0; i < corpo.length; i += 65_536) controller.enqueue(new Uint8Array(corpo.subarray(i, i + 65_536)));
      controller.close();
    },
  });
  const headers = new Headers({ host: "127.0.0.1:3000", "content-type": `multipart/form-data; boundary=${fronteira}` });
  if (opcoes.contentLength) headers.set("content-length", opcoes.contentLength);
  const pedidoUpload = { method: "POST", url, nextUrl: new URL(url), headers, body, signal: new AbortController().signal, cookies: { get: () => undefined } };
  return { pedidoUpload, estado };
}

test("rotas da apresentação do salão e dos serviços comuns: tenant, Gestão, upload limitado, foto privada e tradução", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente"); return; }
  const c = await conectarDescartavel();
  let sessao: unknown = null;
  const cache = new Map();
  let normalizacoes = 0;
  const dubles = {
    "imagens/normalizar-webp": { ...normalizacaoReal, normalizarWebp: async (b: Buffer) => { normalizacoes++; return normalizacaoReal.normalizarWebp(b); } },
  };
  const carregar = (arquivo: string) => carregarComBanco(arquivo, c, () => sessao, dubles, cache) as unknown as Rota;
  const salaoRota = carregar("app/api/admin/configuracoes/saloes/[id]/route.ts");
  const lista = carregar("app/api/admin/configuracoes/saloes/route.ts");
  const fotos = carregar("app/api/admin/configuracoes/saloes/[id]/fotos/route.ts");
  const foto = carregar("app/api/admin/configuracoes/saloes/[id]/fotos/[fotoId]/route.ts");
  const agenda = carregar("app/api/admin/configuracoes/agenda/route.ts");
  const servicos = carregar("app/api/admin/configuracoes/adicionais/servicos-comuns/route.ts");
  const chamar = async (rota: Rota, metodo: string, url: string, corpo?: unknown, params?: Record<string, string>) => {
    const r = await rota[metodo](pedido(`${BASE}${url}`, corpo, metodo), params ? { params: Promise.resolve(params) } : undefined);
    const tipo = r.headers.get("content-type") ?? "";
    const resposta: Corpo = tipo.includes("json") ? await r.json() : {};
    return { status: r.status, corpo: resposta, tipo };
  };
  /** Versão da agenda pelo GET REAL da rota, na sessão atual (como a tela faz antes de salvar). */
  const versaoDaAgenda = async () => {
    const r = await chamar(agenda, "GET", "/api/admin/configuracoes/agenda");
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const v = (r.corpo.data as { agenda: { versaoAgenda: string } }).agenda.versaoAgenda;
    assert.match(v, /^va1:[0-9a-f]{64}$/);
    return v;
  };
  try {
    await c.query("BEGIN");
    const A = await empresa(c, "Buffet A sintético"), B = await empresa(c, "Buffet B sintético");
    const gestaoA = await pessoa(c, A, "REPRESENTANTE_AUTORIZADO"), equipeA = await pessoa(c, A, "ADMINISTRATIVO"), gestaoB = await pessoa(c, B, "REPRESENTANTE_AUTORIZADO");

    // Salão criado pela rota REAL da agenda (Gestão A).
    sessao = gestaoA.sessao;
    const versaoInicial = await versaoDaAgenda();
    const criada = await chamar(agenda, "POST", "/api/admin/configuracoes/agenda", {
      acao: "salvar", origem: "CONFIGURACOES", versaoAgenda: versaoInicial, estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_HORARIO", limiteFestasDia: null,
      intervaloMinimoMinutos: 0, saloes: [{ nome: "Salão Aventura", capacidadeConvidados: 120 }],
      horarios: [{ nome: "Tarde", inicio: "14:00", fim: "18:00", dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 1, saloes: [] }],
    });
    assert.equal(criada.status, 201, JSON.stringify(criada.corpo));
    const salao = (criada.corpo.data as { saloes: { id: string; nome: string }[] }).saloes[0];
    const horario = (criada.corpo.data as { horarios: { id: string }[] }).horarios[0];
    const url = `/api/admin/configuracoes/saloes/${salao.id}`;
    const params = { id: salao.id };

    await t.test("leitura por membership; escrita só por Gestão; outra empresa = 404", async () => {
      sessao = equipeA.sessao;
      const lidaEquipe = await chamar(salaoRota, "GET", url, undefined, params);
      assert.equal(lidaEquipe.status, 200);
      assert.equal((lidaEquipe.corpo.data as { gestao: boolean }).gestao, false);
      const negada = await chamar(salaoRota, "POST", url, { acao: "declarar", versao: 0 }, params);
      assert.equal(negada.status, 403);
      sessao = gestaoB.sessao;
      assert.equal((await chamar(salaoRota, "GET", url, undefined, params)).status, 404);
      assert.equal((await chamar(salaoRota, "POST", url, { acao: "declarar", versao: 0 }, params)).status, 404);
      sessao = gestaoA.sessao;
      const l = await chamar(lista, "GET", "/api/admin/configuracoes/saloes");
      assert.deepEqual((l.corpo.data as { saloes: { id: string }[] }).saloes.map((s) => s.id), [salao.id]);
    });

    let versao = 0;
    await t.test("salvar com sentados; versão desatualizada = 409", async () => {
      sessao = gestaoA.sessao;
      const r = await chamar(salaoRota, "POST", url, { acao: "salvar", versao: 0, campos: {
        convidadosMinimo: null, convidadosSentados: 90, areaM2: 260, idadeMin: null, idadeMax: null, frase: "Mais espaço", outraFestaSimultanea: false,
        exclusivos: [], fotosReferencia: "2026-03" }, itens: [{ grupo: "CONFORTO", codigo: "WIFI", destaque: true }] }, params);
      assert.equal(r.status, 200, JSON.stringify(r.corpo));
      versao = (r.corpo.data as { conteudoVersao: number }).conteudoVersao;
      const velha = await chamar(salaoRota, "POST", url, { acao: "declarar", versao: 0 }, params);
      assert.equal(velha.status, 409);
      assert.equal(velha.corpo.codigo, "SALAO_MUDOU");
    });

    await t.test("rota da agenda (#239): versão ausente ou antiga = 409 AGENDA_MUDOU, sem chegar à tradução da S-A", async () => {
      sessao = gestaoA.sessao;
      const corpo = (versaoAgenda?: string) => ({
        acao: "salvar", origem: "CONFIGURACOES", ...(versaoAgenda ? { versaoAgenda } : {}), estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_HORARIO",
        limiteFestasDia: null, intervaloMinimoMinutos: 0, saloes: [{ id: salao.id, nome: "Salão Aventura", capacidadeConvidados: 80 }],
        horarios: [{ id: horario.id, nome: "Tarde", inicio: "14:00", fim: "18:00", dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 1, saloes: [] }],
      });
      for (const [rotulo, v] of [["ausente", undefined], ["antiga", versaoInicial]] as const) {
        const r = await chamar(agenda, "POST", "/api/admin/configuracoes/agenda", corpo(v));
        assert.deepEqual([r.status, r.corpo.codigo], [409, "AGENDA_MUDOU"], rotulo);
      }
    });

    await t.test("rota da agenda: máximo abaixo de sentados vira 409 com mensagem, não erro interno", async () => {
      sessao = gestaoA.sessao;
      const versaoAtual = await versaoDaAgenda();
      const r = await chamar(agenda, "POST", "/api/admin/configuracoes/agenda", {
        acao: "salvar", origem: "CONFIGURACOES", versaoAgenda: versaoAtual, estabelecimentoId: null, modo: "FIXO", capacidadeTipo: "POR_HORARIO", limiteFestasDia: null,
        intervaloMinimoMinutos: 0, saloes: [{ id: salao.id, nome: "Salão Aventura", capacidadeConvidados: 80 }],
        horarios: [{ id: horario.id, nome: "Tarde", inicio: "14:00", fim: "18:00", dias: [1, 2, 3, 4, 5, 6, 7], capacidade: 1, saloes: [] }],
      });
      assert.equal(r.status, 409, JSON.stringify(r.corpo));
      assert.notEqual(r.corpo.codigo, "AGENDA_MUDOU", "a versão é a atual: o 409 vem da CHECK traduzida");
      assert.match(String(r.corpo.erro), /sentados/);
    });

    let fotoId = "";
    await t.test("upload: autorização antes do corpo; teto efetivo sem Content-Length e com Content-Length falso, antes do parse e do sharp", async () => {
      const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 40, b: 90 } } }).png().toBuffer();
      sessao = equipeA.sessao;
      const negado = upload(`${BASE}${url}/fotos?versao=${versao}&legenda=Sal%C3%A3o`, png);
      assert.equal((await fotos.POST(negado.pedidoUpload, { params: Promise.resolve(params) })).status, 403);
      sessao = gestaoA.sessao;
      const grande = Buffer.alloc(8 * 1024 * 1024 + 70_000, 1);
      const antes = normalizacoes;
      for (const opcoes of [{}, { contentLength: "1000" }]) {
        const u = upload(`${BASE}${url}/fotos?versao=${versao}&legenda=Grande`, grande, opcoes);
        const r = await fotos.POST(u.pedidoUpload, { params: Promise.resolve(params) });
        assert.equal(r.status, 413);
        assert.equal((await r.json()).codigo, "CORPO_GRANDE");
      }
      assert.equal(normalizacoes, antes, "o sharp não pode rodar para corpo acima do teto");
      const ok = upload(`${BASE}${url}/fotos?versao=${versao}&legenda=Sal%C3%A3o%20montado`, png);
      const r = await fotos.POST(ok.pedidoUpload, { params: Promise.resolve(params) });
      assert.equal(r.status, 200);
      const data = (await r.json()).data as { fotos: { id: string; legenda: string }[]; conteudoVersao: number };
      assert.deepEqual(data.fotos.map((f) => f.legenda), ["Salão montado"]);
      assert.equal(normalizacoes, antes + 1);
      fotoId = data.fotos[0].id;
      versao = data.conteudoVersao;
      // Versão velha no upload: a gravação sob lock recusa (409), mesmo depois de normalizar.
      const velho = upload(`${BASE}${url}/fotos?versao=0&legenda=Outra`, png);
      assert.equal((await fotos.POST(velho.pedidoUpload, { params: Promise.resolve(params) })).status, 409);
    });

    await t.test("foto privada: a empresa dona vê; outra empresa recebe 404", async () => {
      sessao = gestaoA.sessao;
      const r = await chamar(foto, "GET", `${url}/fotos/${fotoId}`, undefined, { id: salao.id, fotoId });
      assert.equal(r.status, 200);
      assert.equal(r.tipo, "image/webp");
      sessao = gestaoB.sessao;
      assert.equal((await chamar(foto, "GET", `${url}/fotos/${fotoId}`, undefined, { id: salao.id, fotoId })).status, 404);
    });

    await t.test("serviços comuns: Equipe 403; Gestão cria os 4 só na própria empresa; repetir não duplica", async () => {
      sessao = equipeA.sessao;
      assert.equal((await chamar(servicos, "POST", "/api/admin/configuracoes/adicionais/servicos-comuns", {})).status, 403);
      sessao = gestaoA.sessao;
      const r1 = await chamar(servicos, "POST", "/api/admin/configuracoes/adicionais/servicos-comuns", {});
      assert.equal(r1.status, 200, JSON.stringify(r1.corpo));
      const r2 = await chamar(servicos, "POST", "/api/admin/configuracoes/adicionais/servicos-comuns", {});
      assert.deepEqual((r2.corpo.data as { situacao: string }[]).map((x) => x.situacao), ["JA_EXISTIA", "JA_EXISTIA", "JA_EXISTIA", "JA_EXISTIA"]);
      const n = async (e: string) => Number((await c.query(`SELECT count(*) AS n FROM adicionais WHERE empresa_id = $1::uuid AND categoria = 'SERVICOS'`, [e])).rows[0].n);
      assert.deepEqual([await n(A), await n(B)], [4, 0]);
    });
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});
