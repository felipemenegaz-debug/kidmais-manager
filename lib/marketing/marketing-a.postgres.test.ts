import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { carregarComBanco, cliente, comercial, contratoAssinado, empresa, executor, fechamento, pedido, type Resposta, vincular, SENHA_FALSA, cod } from "./harness-postgres.ts";
import type { Client as ClientePg } from "pg";

/** Identidade sintética da suíte (senha_hash falsa: não autentica) + vínculo com a empresa. */
async function pessoa(c: ClientePg, empresaId: string, papel: "REPRESENTANTE_AUTORIZADO" | "ADMINISTRATIVO", nome = "Pessoa sintética") {
  const usuario = (await c.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, $4, true) RETURNING id::text AS id`,
    [`${cod("u")}@marketing.test`, nome, SENHA_FALSA, papel])).rows[0].id;
  return vincular(c, empresaId, usuario, papel, nome);
}

/**
 * Entrega A (Marketing) no PostgreSQL descartável, modelo 086, pelas ROTAS reais (guarda administrativa dublada pela
 * sessão sintética; tenant, plano e capacidades reais no banco). Tudo numa transação desfeita no fim (contratos têm
 * validações diferidas). Evidências do goal:
 *   1. empresa A publica o site, o formulário com campanha cria/reaproveita contato, a negociação e o contrato são
 *      vinculados e o painel mostra os números certos;
 *   2. empresa B não lê nem altera nada de A (contatos, campanha, site, imagem, origem, domínio, painel), por API;
 *   3. sem UTM = desconhecida; cliente recorrente preserva a origem e a negociação recebe a nova;
 *   4. clique, contato e contrato são contagens diferentes; repetir o envio não duplica;
 *   5. rascunho × publicação × despublicação; canonical e sitemap;
 *   6. domínio não verificado, duplicado, host desconhecido e remoção (provedor simulado).
 */
const BASE = "http://127.0.0.1:3000";
type Rota = { GET?: (r: unknown, ctx?: unknown) => Promise<Resposta>; POST?: (r: unknown, ctx?: unknown) => Promise<Resposta> };

test("Entrega A: site, formulário com campanha, atribuição até contrato, painel, isolamento A×B, publicação e domínio", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  Object.assign(process.env, { MARKETING_SITES_PUBLICOS: "true", MARKETING_DOMINIOS_PERSONALIZADOS: "true", MARKETING_DOMINIO_SIMULADO_SERVIR: "true", SITE_URL: BASE });
  const c: Client = await conectarDescartavel();
  try {
  const tx = executor(c);
  let sessao: unknown = null;
  const cache = new Map();
  const carregar = <T>(arquivo: string) => carregarComBanco(arquivo, c, () => sessao, {}, cache) as unknown as T;
  const site = carregar<Rota>("app/api/admin/marketing/site/route.ts");
  const campanhas = carregar<Rota>("app/api/admin/marketing/campanhas/route.ts");
  const contatos = carregar<Rota>("app/api/admin/marketing/contatos/route.ts");
  const resumo = carregar<Rota>("app/api/admin/marketing/resumo/route.ts");
  const dominios = carregar<Rota>("app/api/admin/marketing/dominios/route.ts");
  const atribuicoes = carregar<Rota>("app/api/admin/marketing/atribuicoes/route.ts");
  const imagemAdmin = carregar<Rota>("app/api/admin/marketing/site/imagens/[imagemId]/route.ts");
  const formulario = carregar<Rota>("app/api/publico/marketing/[slug]/contato/route.ts");
  const publicas = carregar<{
    respostaCliqueCampanha(v: unknown, c: string, r: unknown): Promise<Resposta>; respostaSitemap(v: unknown): Promise<Resposta>;
    resolverPagina(v: unknown, env?: unknown): Promise<{ canonical: string; indexavel: boolean; site: { conteudo: { apresentacao: { texto: string } } } } | null>;
  }>("lib/marketing/site/rotas-publicas.ts");
  const publico = carregar<{ sitePublicoPorSlug(tx: unknown, slug: string): Promise<{ versaoId: string; conteudo: { apresentacao: { texto: string }; versao: number } } | null>;
    sitePublicoPorHost(tx: unknown, host: string, env?: unknown): Promise<unknown>; imagemPublica(tx: unknown, s: unknown, id: string): Promise<unknown> }>("lib/marketing/site/publico.ts");
  const imagens = carregar<{ normalizarImagemSite(b: Buffer): Promise<unknown>; salvarImagem(...a: unknown[]): Promise<{ id: string }> }>("lib/marketing/site/imagens.ts");

  const chamar = async (rota: Rota, metodo: "GET" | "POST", url: string, corpo?: unknown, ctx?: unknown) => {
    const r = await rota[metodo]!(pedido(`${BASE}${url}`, corpo, metodo), ctx);
    return { status: r.status, corpo: await r.json() };
  };
  const ok = async (rota: Rota, metodo: "GET" | "POST", url: string, corpo?: unknown, ctx?: unknown) => {
    const r = await chamar(rota, metodo, url, corpo, ctx);
    assert.equal(r.status, 200, `${metodo} ${url}: ${JSON.stringify(r.corpo)}`);
    return r.corpo.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const n = async (sql: string, v: unknown[] = []) => Number((await c.query(sql, v)).rows[0].n);

    await c.query("BEGIN");
    const A = await empresa(c, "Buffet Alfa sintético"), B = await empresa(c, "Buffet Beta sintético");
    const gestaoA = await pessoa(c, A, "REPRESENTANTE_AUTORIZADO", "Gestão A"), equipeA = await pessoa(c, A, "ADMINISTRATIVO", "Equipe A");
    const gestaoB = await pessoa(c, B, "REPRESENTANTE_AUTORIZADO", "Gestão B");
    const baseA = await comercial(c, A);
    const recorrente = await cliente(c, A, "Rita Recorrente", "5511988881001");

    await t.test("CRM básico: Equipe sem capacidade de Marketing informa a origem do cliente; Marketing exige capacidade", async () => {
      sessao = equipeA.sessao;
      await ok(atribuicoes, "POST", "/api/admin/marketing/atribuicoes", { alvoTipo: "CLIENTE", alvoId: recorrente, origemCodigo: "INDICACAO", detalhe: "Indicada pela Ana" });
      const negado = await chamar(site, "GET", "/api/admin/marketing/site");
      assert.equal(negado.status, 403);
      assert.equal(negado.corpo.codigo, "MARKETING_SEM_PERMISSAO");
    });

    let siteId = "", slug = "", versaoRascunho = 0, imagemGaleria = "", imagemAvulsa = "";
    let conteudo: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    await t.test("1/5. Gestão A cria o rascunho (pré-preenchido), envia imagens e publica; público vê só a versão publicada", async () => {
      sessao = gestaoA.sessao;
      const criado = await ok(site, "POST", "/api/admin/marketing/site", { acao: "criar", slug: "buffet-alfa-sintetico" });
      siteId = criado.site.id; slug = criado.site.slug; versaoRascunho = criado.site.rascunhoVersao; conteudo = criado.site.rascunho;
      assert.equal(slug, "buffet-alfa-sintetico");
      assert.equal(criado.site.estado, "RASCUNHO");
      assert.equal(await publico.sitePublicoPorSlug(tx, slug), null, "rascunho nunca é público");
      const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#7c3aed" } }).png().toBuffer();
      imagemGaleria = (await imagens.salvarImagem(tx, A, siteId, gestaoA.usuario, await imagens.normalizarImagemSite(png), "Salão")).id;
      imagemAvulsa = (await imagens.salvarImagem(tx, A, siteId, gestaoA.usuario, await imagens.normalizarImagemSite(png), "Privada")).id;
      conteudo = { ...conteudo, apresentacao: { titulo: "Festas inesquecíveis", texto: "Versão 1 do texto." }, galeria: [{ imagemId: imagemGaleria, legenda: "Salão" }],
        pacotes: [{ codigo: "COMPLETA", destaque: "Mais pedido", mostrarPreco: true }], seo: { titulo: "Buffet Alfa", descricao: "Buffet infantil sintético", indexavel: true } };
      const salvo = await ok(site, "POST", "/api/admin/marketing/site", { acao: "salvar", siteId, rascunhoVersao: versaoRascunho, conteudo });
      versaoRascunho = salvo.site.rascunhoVersao;
      const publicado = await ok(site, "POST", "/api/admin/marketing/site", { acao: "publicar", siteId, rascunhoVersao: versaoRascunho });
      assert.equal(publicado.site.estado, "PUBLICADO");
      const visto = await publico.sitePublicoPorSlug(tx, slug);
      assert.equal(visto?.conteudo.apresentacao.texto, "Versão 1 do texto.");
      assert.ok(await publico.imagemPublica(tx, visto, imagemGaleria), "imagem da galeria publicada é servida");
      assert.equal(await publico.imagemPublica(tx, visto, imagemAvulsa), null, "upload não citado continua privado");
    });

    let campanhaId = "";
    await t.test("4. campanha, cliques (evento próprio) e formulário idempotente", async () => {
      const criada = await ok(campanhas, "POST", "/api/admin/marketing/campanhas", { acao: "criar", codigo: "nov-centro", nome: "Novembro Centro", canal: "INSTAGRAM",
        origemCodigo: "INSTAGRAM", inicio: "2026-10-01", utmSource: "instagram", utmMedium: "social", orcamentoCentavos: 80000 });
      campanhaId = criada.campanha.id;
      for (let i = 0; i < 2; i++) {
        const r = await publicas.respostaCliqueCampanha({ tipo: "PLATAFORMA", slug }, "nov-centro", pedido(`${BASE}/s/${slug}/c/nov-centro`));
        assert.equal(r.status, 302);
        assert.match(r.headers.get("location") ?? "", /^\/s\/buffet-alfa-sintetico\/\?.*kc=nov-centro/);
      }
      assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_eventos WHERE empresa_id = $1 AND tipo = 'CLIQUE_LINK_CAMPANHA'`, [A]), 2);
      const corpo = { nome: "Nina Nova", telefone: "(11) 98888-1002", chave: "chave-nina-0000000001", kc: "nov-centro", utm_source: "instagram", utm_medium: "social", utm_campaign: "nov-centro" };
      for (let i = 0; i < 3; i++) {
        const r = await formulario.POST!(pedido(`${BASE}/api/publico/marketing/${slug}/contato`, corpo, "POST", { origin: BASE }), { params: Promise.resolve({ slug }) });
        assert.equal(r.status, 202);
      }
      assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_contatos WHERE empresa_id = $1`, [A]), 1, "repetição não duplica contato");
      assert.equal(await n(`SELECT count(*)::int AS n FROM clientes WHERE empresa_id = $1 AND telefone = '11988881002'`, [A]), 1, "nem cliente");
      assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_atribuicoes WHERE empresa_id = $1`, [A]), 3, "contato + cliente novo (+ origem manual da Rita)");
    });

    await t.test("3. sem UTM = desconhecida; cliente recorrente é reaproveitado e mantém a primeira origem", async () => {
      const enviar = (corpo: Record<string, unknown>) => formulario.POST!(pedido(`${BASE}/api/publico/marketing/${slug}/contato`, corpo, "POST"), { params: Promise.resolve({ slug }) });
      assert.equal((await enviar({ nome: "Sérgio Sem UTM", telefone: "11988881003", chave: "chave-sergio-00000001" })).status, 202);
      assert.equal((await enviar({ nome: "Rita (outro nome)", telefone: "11988881001", chave: "chave-rita-0000000001", kc: "nov-centro" })).status, 202);
      const linhas = (await c.query(`SELECT k.nome, k.vinculo_cliente, k.cliente_id::text, a.origem_codigo, a.metodo FROM marketing_contatos k
        JOIN marketing_atribuicoes a ON a.alvo_tipo = 'CONTATO' AND a.alvo_id = k.id AND a.vigente WHERE k.empresa_id = $1 ORDER BY k.recebido_em`, [A])).rows;
      assert.deepEqual(linhas.map((l) => [l.nome, l.origem_codigo, l.metodo]), [["Nina Nova", "INSTAGRAM", "CAPTURADO"], ["Sérgio Sem UTM", "DESCONHECIDA", "DESCONHECIDO"], ["Rita (outro nome)", "INSTAGRAM", "CAPTURADO"]]);
      const rita = linhas[2];
      assert.equal(rita.cliente_id, recorrente);
      assert.equal(rita.vinculo_cliente, "EXISTENTE_CONTATO");
      assert.equal((await c.query(`SELECT nome_completo FROM clientes WHERE id = $1`, [recorrente])).rows[0].nome_completo, "Rita Recorrente", "cadastro não alterado pelo formulário");
      const origemRita = (await c.query(`SELECT origem_codigo, metodo FROM marketing_atribuicoes WHERE alvo_tipo = 'CLIENTE' AND alvo_id = $1 AND vigente`, [recorrente])).rows[0];
      assert.deepEqual(origemRita, { origem_codigo: "INDICACAO", metodo: "INFORMADO" }, "primeira origem histórica preservada");
    });

    let fechNina = "", fechRita = "";
    await t.test("1. negociações vinculadas herdam a origem do contato; contrato herda pelo vínculo; painel por campanha sem duplicar", async () => {
      const contatoDe = async (nome: string) => (await c.query(`SELECT id::text, cliente_id::text FROM marketing_contatos WHERE empresa_id = $1 AND nome = $2`, [A, nome])).rows[0];
      const nina = await contatoDe("Nina Nova"), rita = await contatoDe("Rita (outro nome)");
      fechNina = await fechamento(c, A, baseA, nina.cliente_id, { data: "2026-12-12", status: "AGUARDANDO_CONTRATO" });
      fechRita = await fechamento(c, A, baseA, rita.cliente_id, { data: "2026-12-19", status: "AGUARDANDO_CONTRATO" });
      await ok(contatos, "POST", "/api/admin/marketing/contatos", { acao: "vincular-negociacao", id: nina.id, fechamentoId: fechNina });
      await ok(contatos, "POST", "/api/admin/marketing/contatos", { acao: "vincular-negociacao", id: rita.id, fechamentoId: fechRita });
      const origemNeg = (await c.query(`SELECT alvo_id::text, origem_codigo, metodo, campanha_id::text FROM marketing_atribuicoes WHERE alvo_tipo = 'FECHAMENTO' AND vigente ORDER BY alvo_id`)).rows;
      assert.equal(origemNeg.length, 2);
      assert.ok(origemNeg.every((o) => o.metodo === "HERDADO" && o.campanha_id === campanhaId), "negociação recebe a nova origem (campanha)");
      const repetido = await chamar(contatos, "POST", "/api/admin/marketing/contatos", { acao: "vincular-negociacao", id: nina.id, fechamentoId: fechNina });
      assert.equal(repetido.status, 409);
      await contratoAssinado(c, fechNina, 4500, 1000);
      const painel = (await ok(resumo, "GET", "/api/admin/marketing/resumo?de=2026-01-01&ate=2026-12-31")).painel;
      const linha = painel.linhas.find((l: { campanhaId: string }) => l.campanhaId === campanhaId);
      assert.deepEqual({ cliques: linha.cliquesLink, contatos: linha.contatos, negociacoes: linha.negociacoes, contratos: linha.contratos, contratada: linha.receitaContratadaCentavos,
        recebida: linha.receitaRecebidaCentavos, conversao: linha.conversao, orcamento: linha.orcamentoCentavos },
      { cliques: 2, contatos: 2, negociacoes: 2, contratos: 1, contratada: 450000, recebida: 100000, conversao: 0.5, orcamento: 80000 });
      assert.equal(painel.total.receitaContratadaCentavos, 450000, "receita aparece uma vez");
      assert.equal(painel.linhas.find((l: { origemCodigo: string }) => l.origemCodigo === "DESCONHECIDA").contatos, 1);
      // Repetir o envio depois do contrato não muda nada.
      await formulario.POST!(pedido(`${BASE}/api/publico/marketing/${slug}/contato`, { nome: "Nina Nova", telefone: "11988881002", chave: "chave-nina-0000000001", kc: "nov-centro" }, "POST"), { params: Promise.resolve({ slug }) });
      const depois = (await ok(resumo, "GET", "/api/admin/marketing/resumo?de=2026-01-01&ate=2026-12-31")).painel;
      assert.deepEqual(depois.total, painel.total);
    });

    await t.test("2. empresa B não lê nem altera nada de A, inclusive com ids diretos nas APIs", async () => {
      const ninaContato = (await c.query(`SELECT id::text FROM marketing_contatos WHERE empresa_id = $1 AND nome = 'Nina Nova'`, [A])).rows[0].id;
      const dominioA = (await ok(dominios, "POST", "/api/admin/marketing/dominios", { acao: "solicitar", siteId, host: "festas.alfa-sintetico.test" })).resultado.ids[0];
      sessao = gestaoB.sessao;
      try {
      const recusas: Array<[Rota, "GET" | "POST", string, unknown?, unknown?]> = [
        [contatos, "GET", `/api/admin/marketing/contatos?id=${ninaContato}`],
        [contatos, "POST", "/api/admin/marketing/contatos", { acao: "status", id: ninaContato, status: "DESCARTADO" }],
        [campanhas, "POST", "/api/admin/marketing/campanhas", { acao: "pausar", id: campanhaId, versao: 1 }],
        [site, "POST", "/api/admin/marketing/site", { acao: "salvar", siteId, rascunhoVersao: versaoRascunho, conteudo }],
        [site, "POST", "/api/admin/marketing/site", { acao: "despublicar", siteId }],
        [dominios, "GET", `/api/admin/marketing/dominios?siteId=${siteId}`],
        [dominios, "POST", "/api/admin/marketing/dominios", { acao: "remover", id: dominioA }],
        [atribuicoes, "GET", `/api/admin/marketing/atribuicoes?alvoTipo=CLIENTE&alvoId=${recorrente}`],
        [atribuicoes, "POST", "/api/admin/marketing/atribuicoes", { alvoTipo: "FECHAMENTO", alvoId: fechNina, origemCodigo: "GOOGLE" }],
        [imagemAdmin, "GET", `/api/admin/marketing/site/imagens/${imagemAvulsa}`, undefined, { params: Promise.resolve({ imagemId: imagemAvulsa }) }],
      ];
      for (const [rota, metodo, url, corpo, ctx] of recusas) {
        const r = metodo === "GET" && url.includes("/imagens/") ? { status: (await rota.GET!(pedido(`${BASE}${url}`), ctx)).status } : await chamar(rota, metodo, url, corpo, ctx);
        assert.equal(r.status, 404, `${metodo} ${url} deveria ser 404 para B`);
      }
      const listaB = await ok(contatos, "GET", "/api/admin/marketing/contatos");
      assert.equal(listaB.contatos.length, 0);
      assert.equal((await ok(resumo, "GET", "/api/admin/marketing/resumo?de=2026-01-01&ate=2026-12-31")).painel.total.contatos, 0);
      assert.equal((await ok(site, "GET", "/api/admin/marketing/site")).site, null);
      assert.equal((await ok(campanhas, "GET", "/api/admin/marketing/campanhas")).campanhas.length, 0);
      assert.equal(await n(`SELECT count(*)::int AS n FROM marketing_contatos WHERE id = $1 AND status = 'DESCARTADO'`, [ninaContato]), 0, "nada de A mudou");
      } finally { sessao = gestaoA.sessao; }
    });

    await t.test("5. rascunho não vaza; publicação nova troca a versão; não indexável sai do sitemap; despublicado = 404", async () => {
      const novo: Record<string, any> = { ...conteudo, apresentacao: { titulo: "Festas", texto: "Versão 2 do texto (rascunho)." } }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const salvo = await ok(site, "POST", "/api/admin/marketing/site", { acao: "salvar", siteId, rascunhoVersao: versaoRascunho, conteudo: novo });
      versaoRascunho = salvo.site.rascunhoVersao;
      assert.equal(salvo.site.alteracoesNaoPublicadas, true);
      assert.equal((await publico.sitePublicoPorSlug(tx, slug))?.conteudo.apresentacao.texto, "Versão 1 do texto.", "rascunho não aparece");
      const conflito = await chamar(site, "POST", "/api/admin/marketing/site", { acao: "publicar", siteId, rascunhoVersao: versaoRascunho - 1 });
      assert.equal(conflito.status, 409, "publicar exige a versão que a pessoa revisou");
      await ok(site, "POST", "/api/admin/marketing/site", { acao: "publicar", siteId, rascunhoVersao: versaoRascunho });
      const v2 = await publico.sitePublicoPorSlug(tx, slug);
      assert.equal(v2?.conteudo.apresentacao.texto, "Versão 2 do texto (rascunho).");
      assert.equal(v2?.conteudo.versao, 2);
      const pagina = await publicas.resolverPagina({ tipo: "PLATAFORMA", slug });
      assert.equal(pagina?.canonical, `${BASE}/s/${slug}`);
      assert.equal(pagina?.indexavel, true);
      assert.match(await (await publicas.respostaSitemap({ tipo: "PLATAFORMA", slug })).text(), new RegExp(`<loc>${BASE}/s/${slug}</loc>`));
      const naoIndexar = await ok(site, "POST", "/api/admin/marketing/site", { acao: "salvar", siteId, rascunhoVersao: versaoRascunho, conteudo: { ...novo, seo: { ...novo.seo, indexavel: false } } });
      versaoRascunho = naoIndexar.site.rascunhoVersao;
      await ok(site, "POST", "/api/admin/marketing/site", { acao: "publicar", siteId, rascunhoVersao: versaoRascunho });
      assert.equal((await publicas.resolverPagina({ tipo: "PLATAFORMA", slug }))?.indexavel, false);
      assert.doesNotMatch(await (await publicas.respostaSitemap({ tipo: "PLATAFORMA", slug })).text(), /<url>/);
      await ok(site, "POST", "/api/admin/marketing/site", { acao: "despublicar", siteId });
      assert.equal(await publico.sitePublicoPorSlug(tx, slug), null);
      assert.equal((await publicas.respostaSitemap({ tipo: "PLATAFORMA", slug })).status, 404);
      const r = await formulario.POST!(pedido(`${BASE}/api/publico/marketing/${slug}/contato`, { nome: "Depois", telefone: "11988881009", chave: "chave-depois-00000001" }, "POST"), { params: Promise.resolve({ slug }) });
      assert.equal(r.status, 404, "formulário de site despublicado não recebe");
      const versoes = (await ok(site, "GET", "/api/admin/marketing/site")).versoes;
      assert.equal(versoes.length, 3, "histórico de versões publicadas mantido");
      await ok(site, "POST", "/api/admin/marketing/site", { acao: "publicar", siteId, rascunhoVersao: versaoRascunho });
    });

    await t.test("6. domínio: não verificado não abre; duplicado recusado; host desconhecido 404; simulado nunca indexável; remoção imediata", async () => {
      const host = "festas.alfa-sintetico.test";
      const lista = (await ok(dominios, "GET", `/api/admin/marketing/dominios?siteId=${siteId}`)).dominios;
      const dominio = lista.find((d: { host: string }) => d.host === host);
      assert.equal(dominio.status, "PENDENTE_DNS");
      assert.equal(await publico.sitePublicoPorHost(tx, host), null, "pendente não é servido");
      sessao = gestaoB.sessao;
      const siteB = (await ok(site, "POST", "/api/admin/marketing/site", { acao: "criar", slug: "buffet-beta-sintetico" })).site.id;
      const duplicado = await chamar(dominios, "POST", "/api/admin/marketing/dominios", { acao: "solicitar", siteId: siteB, host });
      assert.equal(duplicado.status, 409);
      assert.doesNotMatch(duplicado.corpo.erro ?? "", /Alfa|outra empresa/i, "não revela o dono");
      sessao = gestaoA.sessao;
      const semDns = await ok(dominios, "POST", "/api/admin/marketing/dominios", { acao: "verificar", id: dominio.id });
      assert.equal(semDns.resultado.status, "FALHOU");
      await ok(dominios, "POST", "/api/admin/marketing/dominios", { acao: "simular-dns", id: dominio.id });
      const ativo = await ok(dominios, "POST", "/api/admin/marketing/dominios", { acao: "verificar", id: dominio.id });
      assert.equal(ativo.resultado.status, "ATIVO");
      assert.equal(ativo.dominios[0].simulado, true);
      assert.ok(await publico.sitePublicoPorHost(tx, host), "ativo (simulado) servido no modo local");
      assert.equal(await publico.sitePublicoPorHost(tx, host, { ...process.env, MARKETING_DOMINIO_SIMULADO_SERVIR: "false" }), null, "fora do modo local, simulado não abre");
      assert.equal(await publico.sitePublicoPorHost(tx, "desconhecido.alfa-sintetico.test"), null);
      const pagina = await publicas.resolverPagina({ tipo: "DOMINIO", host });
      assert.equal(pagina?.indexavel, false, "domínio simulado não indexável");
      assert.equal(pagina?.canonical, `${BASE}/s/${slug}`, "canonical continua no endereço da plataforma");
      await ok(dominios, "POST", "/api/admin/marketing/dominios", { acao: "remover", id: dominio.id });
      assert.equal(await publico.sitePublicoPorHost(tx, host), null, "removido deixa de abrir na hora");
      sessao = gestaoB.sessao;
      const tomada = await ok(dominios, "POST", "/api/admin/marketing/dominios", { acao: "solicitar", siteId: siteB, host });
      const verifB = await ok(dominios, "POST", "/api/admin/marketing/dominios", { acao: "verificar", id: tomada.resultado.ids[0] });
      assert.equal(verifB.resultado.status, "FALHOU", "outra empresa só ativa com o DNS dela (o registro antigo foi removido)");
      sessao = gestaoA.sessao;
    });
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});
