import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../comercial/postgres-descartavel.ts";
import { travarConfiguracaoAgenda } from "../agenda/trava-configuracao.ts";
import { carregarAtendimento, cod } from "../whatsapp/atendimento/harness-postgres.ts";
import type { ConteudoSaida } from "../whatsapp/atendimento/transporte.ts";
import type { PortaWallE } from "../whatsapp/atendimento/worker.ts";
import type { Entendimento, ResultadoWallE, TipoIntencao } from "../whatsapp/atendimento/walle/tipos.ts";
import { carregarComBanco, comercial, contratoAssinado, executor, fechamento, pedido } from "./harness-postgres.ts";
import { painelMarketing, type LinhaPainel, type PainelMarketing } from "./metricas.ts";

/**
 * Homologação LOCAL (23–24/11/2026) da origem dos pedidos de kidmaisfestas.com (docs/MARKETING_SITE_KIDMAIS.md): eventos
 * pela rota pública REAL, mensagem com "Ref. iA.Fest: <UUID>" processada pelo worker REAL do Wall-e (porta do modelo
 * dublada: devolve o entendimento validado), captura do cartão, atribuição INFORMADO, herança na negociação e o painel
 * Marketing → Resultados (painelMarketing) no período de hoje. PostgreSQL descartável (modelo 131 + a 132 e a 136 aplicadas
 * pela suíte), só pelo check:v1:postgres com opt-in. Dados 100% sintéticos; transporte simulado (sem rede).
 *
 * Cada cenário imprime o retrato do painel ANTES e DEPOIS numa linha "EVIDENCIA {json}". Os asserts fixam o comportamento
 * REAL observado; onde ele diverge do esperado pelo dono do buffet, o nome do assert diz "ACHADO".
 *
 *  H1 três campanhas (Instagram pago, Instagram bio, Google Perfil): 2 visitas + 1 clique no WhatsApp + 1 pedido cada;
 *     cliques são EVENTOS (uma 3ª visita repetida sobe o contador);
 *  H2 nova mensagem do mesmo pedido (com Ref igual, sem Ref, com Ref de outra campanha): primeira atribuição vence;
 *  H3 isolamento entre empresas (B fora da variável; Ref cruzada nos dois sentidos);
 *  H4 referência ausente ou ambígua, campanha inexistente/arquivada, rota 400/403/404, variável ausente;
 *  H5 atendimento humano (conversa já com a equipe; passagem na mesma mensagem; Ref só na saudação);
 *  H6 negociação e contrato ASSINADO herdam a campanha; registro manual Indicação/Telefone;
 *  H7 filtro de Unidade (só documenta);
 *  H8 (r2, P1) falha da atribuição não desfaz o cartão: a referência fica no contexto, sobrevive a nova mensagem e a nova
 *     tentativa ao fim do lote atribui; com a falha persistente, o teto (5 tentativas) descarta a referência sem atribuir;
 *  H9 (r2, P2, 136) na empresa da integração convivem campanha externa, interna com site do iA.Fest e antiga sem site:
 *     só a externa recebe cliques e atribuição pelo Wall-e; destino externo com site ou fora da empresa é recusado.
 *  A 136 é aplicada pela suíte depois da 132; as campanhas de A nos cenários H1–H8 são externas (destinoExterno).
 */
const ler = (f: string) => readFileSync(f, "utf8");
const M136 = ["database/checks/20261124_136_precheck.sql", "database/migrations/20261124_136_campanha_destino_externo.sql", "database/checks/20261124_136_postcheck.sql"].map(ler);
const M132 = ["database/checks/20261123_132_precheck.sql", "database/migrations/20261123_132_walle_oportunidades.sql", "database/checks/20261123_132_postcheck.sql"].map(ler);
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const hoje = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
const somarDias = (iso: string, d: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const DATA = somarDias(hoje, 90);
const vazio = { data: null, turno: null, convidados: null, pacotes: [], unidade: null, tema: null };
const SITE = "https://kidmaisfestas.com";
const UUID_INEXISTENTE = "6f1c2b3a-1d2e-4f50-8a9b-0c1d2e3f4a5b";
function cpfValido() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  for (const peso of [10, 11]) { const r = d.reduce((soma, x, i) => soma + x * (peso - i), 0) * 10 % 11; d.push(r === 10 ? 0 : r); }
  return d.join("");
}

// Mensagens sintéticas (a 1ª linha decide o entendimento devolvido pelo dublê do modelo).
const PEDIDO = "Sintético: quero orçar a festa do meu filho para 60 crianças";
const MAIS_CONVIDADOS = "Sintético: na verdade vão ser 80 convidados";
const SAUDACAO = "Sintético: oi, boa tarde";
const COM_ATENDENTE = "Sintético: quero a festa para 50 crianças, mas prefiro falar com uma pessoa";
const comRef = (corpo: string, campanha: string) => `${corpo}\n\nOrigem: instagram | Campanha: ${campanha} | Anúncio: criativo-sintetico\nRef. iA.Fest: ${campanha}`;

test("Homologação: site kidmaisfestas.com → eventos, Wall-e, cartão, negociação e painel de Marketing", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = <T = Record<string, unknown>>(sql: string, v: unknown[] = []) => c.query(sql, v) as unknown as Promise<{ rows: T[] }>;
  const ambienteAntes = process.env.KIDMAIS_DEPLOY_ENV;
  const variavelAntes = process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID;
  process.env.KIDMAIS_DEPLOY_ENV = "staging";
  try {
    for (const sql of [...M132, ...M136]) await q(sql);
    const id = async (sql: string, v: unknown[]) => (await q<{ id: string }>(sql, v)).rows[0].id;
    async function empresaComRepresentante(nome: string) {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text`, [cod("hs"), nome]);
      await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Sintético representante', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text`, [`${cod("u")}@example.test`, SENHA]);
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id::text`, [e, u]);
      await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      return { empresa: e, usuario: u, sessao: { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", autenticado_em: new Date().toISOString() } as never };
    }
    const A = await empresaComRepresentante("Sintético Buffet Kidmais A");
    const B = await empresaComRepresentante("Sintético Buffet B");
    const aStg = carregarAtendimento(A.empresa, "staging");
    const bStg = carregarAtendimento(B.empresa, "staging");
    for (const [s, sessao] of [[aStg, A.sessao], [bStg, B.sessao]] as const)
      await s.servico.salvarConfiguracao(sessao, { ativo: true, nome: "Sintético buffet", perguntas: [], wallE: { ativo: true } });

    // Dublê do modelo: o entendimento validado vem da 1ª linha do texto (o resto, inclusive a Ref, não muda a classificação).
    type Roteiro = { tipos: TipoIntencao[]; convidados?: number | null; data?: string | null; passagem?: ResultadoWallE["passagem"] };
    const passagemCliente = { motivo: "PEDIDO_CLIENTE", motivos: ["PEDIDO_CLIENTE"], em: new Date().toISOString(), coletado: { data: null, turno: null, convidados: null, pacote: null, unidade: null, tema: null }, enviados: [], pendentes: [], ultimaMensagem: "" } as never;
    const roteiro = new Map<string, Roteiro>([
      [PEDIDO, { tipos: ["PRECOS"], convidados: 60, data: DATA }],
      [MAIS_CONVIDADOS, { tipos: ["PACOTES"], convidados: 80 }],
      [SAUDACAO, { tipos: ["SAUDACAO"] }],
      [COM_ATENDENTE, { tipos: ["PRECOS"], convidados: 50, passagem: passagemCliente }],
    ]);
    const entendimento = (r: Roteiro): Entendimento => ({ intencoes: r.tipos.map((tipo) => ({ tipo, trecho: "x" })), entidades: { ...vazio, data: r.data ?? null, convidados: r.convidados ?? null }, reenviar: false, alergia: false, origem: "REGRAS" });
    const porta: PortaWallE = { async responder(e) {
      const r = roteiro.get(e.texto.split(/\r?\n/)[0]) ?? { tipos: ["OUTRO"] };
      const anterior = (e.contexto ?? {}) as { data?: string | null; convidados?: number | null };
      const contexto = { data: r.data ?? anterior.data ?? null, convidados: r.convidados ?? anterior.convidados ?? null, ultimoEntendimento: entendimento(r) };
      return { saidas: [{ texto: "Resposta sintética do Wall-e", anexo: null, fontes: [] }], contexto: contexto as never, passagem: r.passagem ?? null };
    } };
    const envios: { contato: string; conteudo: ConteudoSaida }[] = [];
    const deps = { interpretar: async () => ({ intencao: "OUTRO" as const, perguntaId: null, data: null, convidados: null }),
      enviar: async (contato: string, conteudo: ConteudoSaida) => { envios.push({ contato, conteudo }); return cod("gs-"); }, wallE: porta };
    const receber = (s: typeof aStg, contato: string, texto: string, nomePerfil: string | null = null) =>
      s.servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp: Date.now(), nomePerfil });
    const processar = (s: typeof aStg) => s.worker.processarLote(deps, { maxTarefas: 20 });
    const conversa = async (empresa: string, contato: string) =>
      (await q<{ id: string; estado: string; contexto: Record<string, unknown> | null; oportunidade_pendente_em: string | null }>(
        "SELECT id::text, estado, contexto, oportunidade_pendente_em::text FROM whatsapp_atendimento_conversas WHERE empresa_id=$1 AND ambiente='staging' AND contato=$2", [empresa, contato])).rows[0];
    const cartoes = async (empresa: string, telefone: string) => (await q<{ id: string; nome: string; cliente_id: string | null; status: string }>(
      "SELECT id::text, nome, cliente_id::text, status FROM marketing_contatos WHERE empresa_id=$1 AND telefone=$2 ORDER BY recebido_em, id", [empresa, telefone])).rows;
    const atribuicoes = async (alvo: string) => (await q<{ empresa_id: string; campanha_id: string | null; origem_codigo: string; metodo: string; canal_atendimento: string | null; vigente: boolean }>(
      "SELECT empresa_id::text, campanha_id::text, origem_codigo, metodo, canal_atendimento, vigente FROM marketing_atribuicoes WHERE alvo_id=$1 ORDER BY vigente DESC, id", [alvo])).rows;
    const eventos = async (empresa: string) => (await q<{ campanha_id: string | null; tipo: string; n: number }>(
      "SELECT campanha_id::text, tipo, count(*)::int AS n FROM marketing_eventos WHERE empresa_id=$1 GROUP BY 1,2 ORDER BY 1,2", [empresa])).rows;
    const totalEventos = async () => Number((await q<{ n: number }>("SELECT count(*)::int AS n FROM marketing_eventos")).rows[0].n);

    // Módulos de Marketing reais com a conexão da suíte (sem SAVEPOINT: as transações são abertas aqui quando precisam).
    const cache = new Map();
    const semSavepoint = { "db/postgres": { db: () => executor(c as never), withTransaction: async (w: (tx: unknown) => unknown) => w(executor(c as never)) } };
    const carregar = <T>(arquivo: string) => carregarComBanco(arquivo, c as never, () => null, semSavepoint, cache) as unknown as T;
    const campanhas = carregar<typeof import("./campanhas.ts")>("lib/marketing/campanhas.ts");
    const contatos = carregar<typeof import("./contatos.ts")>("lib/marketing/contatos.ts");
    const conversao = carregar<typeof import("./conversao.ts")>("lib/marketing/conversao.ts");
    const rota = carregar<{ POST(req: ReturnType<typeof pedido>): Promise<Response> }>("app/api/publico/marketing/site-kidmais/evento/route.ts");
    const txc = executor(c as never);
    const evento = (tipo: string, campanha: string, origem: string | null = SITE, extra = "") => rota.POST(pedido(
      `http://localhost/api/publico/marketing/site-kidmais/evento?evento=${tipo}&campanha=${campanha}${extra}`, undefined, "POST", origem ? { origin: origem } : {}));

    const painel = (empresa: string, unidadeId: string | null = null) => painelMarketing(txc, empresa, { de: hoje, ate: hoje, unidadeId });
    const resumoLinha = (l: LinhaPainel) => ({ linha: l.campanhaNome ?? `origem:${l.origemCodigo}`, cliquesLink: l.cliquesLink, cliquesWhatsapp: l.cliquesWhatsapp, contatos: l.contatos,
      negociacoes: l.negociacoes, contratos: l.contratos, receitaContratadaCentavos: l.receitaContratadaCentavos });
    async function evidencia(cenario: string, fase: "ANTES" | "DEPOIS", rotulo: "A" | "B", unidadeId: string | null = null): Promise<PainelMarketing> {
      const p = await painel(rotulo === "A" ? A.empresa : B.empresa, unidadeId);
      console.log("EVIDENCIA " + JSON.stringify({ cenario, fase, empresa: rotulo, periodo: hoje, unidade: unidadeId ? "filtrada" : "todas", linhas: p.linhas.map(resumoLinha), total: resumoLinha(p.total) }));
      return p;
    }
    const linhaCampanha = (p: PainelMarketing, campanha: string) => p.linhas.find((l) => l.campanhaId === campanha);
    const linhaOrigem = (p: PainelMarketing, origem: string) => p.linhas.find((l) => !l.campanhaId && l.origemCodigo === origem);
    const numeros = (l: LinhaPainel | undefined) => l ? [l.cliquesLink, l.cliquesWhatsapp, l.contatos] : [0, 0, 0];

    // 136: na empresa da integração (A) as campanhas dos cenários H1–H8 têm destino externo; B não pode marcar (fora da variável).
    const destino = (empresa: string): Record<string, unknown> => empresa === A.empresa ? { destinoExterno: true } : {};
    async function criarCampanha(empresa: string, usuario: string, codigo: string, nome: string, canal: "INSTAGRAM" | "GOOGLE", origem: string) {
      await q("BEGIN");
      try {
        const r = await campanhas.executarAcaoCampanha(txc, empresa, usuario, { acao: "criar", codigo, nome, canal, origemCodigo: origem, inicio: "2026-11-01",
          utmSource: canal === "GOOGLE" ? "google" : "instagram", utmMedium: canal === "GOOGLE" ? "organic" : "social", ...destino(empresa) } as never) as { id: string; versao: number };
        await q("COMMIT");
        return r;
      } catch (e) { await q("ROLLBACK"); throw e; }
    }
    process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID = A.empresa;
    const igPago = await criarCampanha(A.empresa, A.usuario, cod("ig-pago-").slice(0, 20), "Sintético Instagram pago", "INSTAGRAM", "INSTAGRAM");
    const igBio = await criarCampanha(A.empresa, A.usuario, cod("ig-bio-").slice(0, 20), "Sintético Instagram bio", "INSTAGRAM", "INSTAGRAM");
    const google = await criarCampanha(A.empresa, A.usuario, cod("google-").slice(0, 20), "Sintético Google Perfil", "GOOGLE", "GOOGLE");
    const campB = await criarCampanha(B.empresa, B.usuario, cod("b-ig-").slice(0, 20), "Sintético campanha de B", "INSTAGRAM", "INSTAGRAM");
    const TRES = [
      { nome: "Instagram pago", c: igPago, origem: "INSTAGRAM", fone: "5561900000101" },
      { nome: "Instagram bio", c: igBio, origem: "INSTAGRAM", fone: "5561900000102" },
      { nome: "Google Perfil", c: google, origem: "GOOGLE", fone: "5561900000103" },
    ];
    // Cliente ÚNICO com o telefone do Instagram pago: o cartão nasce ligado a ele (H6 precisa do cliente para a negociação).
    const clienteIgPago = await id("INSERT INTO clientes (nome_completo, empresa_id, telefone, whatsapp, cpf) VALUES ('Sintético Cliente Instagram pago', $1, $2, $2, $3) RETURNING id::text", [A.empresa, TRES[0].fone, cpfValido()]);

    await t.test("H1: três campanhas, eventos pela rota pública e pedido com Ref pelo Wall-e", async () => {
      const antes = await evidencia("H1", "ANTES", "A");
      for (const x of TRES) assert.deepEqual(numeros(linhaCampanha(antes, x.c.id)), [0, 0, 0], `H1 ${x.nome}: painel zerado antes`);
      for (const x of TRES) {
        for (const tipo of ["visita", "visita", "whatsapp"]) assert.equal((await evento(tipo, x.c.id)).status, 204, `H1 ${x.nome}: evento ${tipo} aceito (204)`);
        await receber(aStg, x.fone, comRef(PEDIDO, x.c.id), `Sintético ${x.nome}`);
      }
      await processar(aStg);
      for (const x of TRES) {
        const k = await cartoes(A.empresa, x.fone);
        assert.equal(k.length, 1, `H1 ${x.nome}: um cartão`);
        assert.deepEqual((await atribuicoes(k[0].id)).map((a) => [a.campanha_id, a.origem_codigo, a.metodo, a.canal_atendimento, a.vigente]),
          [[x.c.id, x.origem, "INFORMADO", "WHATSAPP", true]], `H1 ${x.nome}: cartão nasce com a campanha, a origem ${x.origem} e método INFORMADO`);
        assert.equal((await conversa(A.empresa, x.fone)).contexto?.campanhaSitePendente, undefined, `H1 ${x.nome}: referência pendente limpa após a captura`);
      }
      assert.equal(TRES.every((x) => envios.some((e) => e.contato === x.fone)), true, "H1: o Wall-e respondeu os três");
      const depois = await evidencia("H1", "DEPOIS", "A");
      for (const x of TRES)
        assert.deepEqual(numeros(linhaCampanha(depois, x.c.id)), [2, 1, 1], `H1 ${x.nome}: painel cliquesLink=2 (EVENTOS de visita), cliquesWhatsapp=1 (EVENTO), contatos=1`);
      assert.equal(linhaCampanha(depois, igPago.id)?.origemCodigo, "INSTAGRAM");
      assert.equal(linhaCampanha(depois, google.id)?.origemCodigo, "GOOGLE");
      // Cliques são EVENTOS, não pessoas: a mesma pessoa recarregando a página conta de novo.
      assert.equal((await evento("visita", igPago.id)).status, 204);
      const recarga = await evidencia("H1-recarga", "DEPOIS", "A");
      assert.deepEqual(numeros(linhaCampanha(recarga, igPago.id)), [3, 1, 1], "H1: 3ª visita repetida (mesma pessoa recarregando) sobe cliquesLink para 3 — cliques são EVENTOS, não visitantes únicos; contatos continua 1");
    });

    await t.test("H2: nova mensagem do mesmo pedido não cria contato nem troca a campanha", async () => {
      const antes = await evidencia("H2", "ANTES", "A");
      const fone = TRES[0].fone;
      const [k] = await cartoes(A.empresa, fone);
      for (const [rotulo, texto] of [["mesma Ref", comRef(PEDIDO, igPago.id)], ["sem Ref", MAIS_CONVIDADOS], ["Ref de OUTRA campanha (Instagram bio)", comRef(PEDIDO, igBio.id)],
        ["Ref de OUTRA campanha (Google) sem mudar convidados", comRef(MAIS_CONVIDADOS, google.id)]] as const) {
        await receber(aStg, fone, texto);
        await processar(aStg);
        const ks = await cartoes(A.empresa, fone);
        assert.deepEqual(ks.map((x) => x.id), [k.id], `H2 ${rotulo}: continua o mesmo cartão, sem segundo contato`);
        assert.deepEqual((await atribuicoes(k.id)).map((a) => [a.campanha_id, a.metodo, a.vigente]), [[igPago.id, "INFORMADO", true]], `H2 ${rotulo}: a primeira atribuição vence (Instagram pago), sem correção`);
        assert.equal((await conversa(A.empresa, fone)).contexto?.campanhaSitePendente, undefined, `H2 ${rotulo}: nenhuma referência pendente sobra na conversa`);
      }
      const depois = await evidencia("H2", "DEPOIS", "A");
      for (const x of TRES) assert.deepEqual(numeros(linhaCampanha(depois, x.c.id)), numeros(linhaCampanha(antes, x.c.id)), `H2 ${x.nome}: painel igual (sem contato novo, sem troca)`);
    });

    await t.test("H3: isolamento entre empresas", async () => {
      const antesA = await evidencia("H3", "ANTES", "A");
      await evidencia("H3", "ANTES", "B");
      const totalAntes = await totalEventos();
      // Evento com a campanha de B: a rota é da empresa configurada (A); nada é gravado (204 sem efeito).
      assert.equal((await evento("visita", campB.id)).status, 204, "H3: evento com campanha de B responde 204");
      assert.equal((await evento("whatsapp", campB.id)).status, 204);
      assert.equal(await totalEventos(), totalAntes, "H3: nenhum evento gravado para campanha de B");
      assert.deepEqual(await eventos(B.empresa), [], "H3: B sem eventos");
      // Conversa de B com a Ref de uma campanha de A (variável aponta para A).
      const foneB1 = "5561900000301", foneB2 = "5561900000302", foneA = "5561900000303";
      await receber(bStg, foneB1, comRef(PEDIDO, igPago.id), "Sintético B com Ref de A");
      await receber(bStg, foneB2, comRef(PEDIDO, campB.id), "Sintético B com Ref de B");
      await processar(bStg);
      // A recebe a Ref com o UUID de uma campanha de B.
      await receber(aStg, foneA, comRef(PEDIDO, campB.id), "Sintético A com Ref de B");
      await processar(aStg);
      for (const [rotulo, empresa, fone] of [["B com Ref de A", B.empresa, foneB1], ["B com Ref de B (B fora da variável)", B.empresa, foneB2], ["A com Ref de B", A.empresa, foneA]] as const) {
        const ks = await cartoes(empresa, fone);
        assert.equal(ks.length, 1, `H3 ${rotulo}: cartão do pedido criado na própria empresa`);
        assert.deepEqual(await atribuicoes(ks[0].id), [], `H3 ${rotulo}: nenhuma atribuição`);
      }
      assert.equal((await q("SELECT 1 FROM marketing_atribuicoes WHERE campanha_id=$1", [campB.id])).rows.length, 0, "H3: campanha de B sem nenhuma atribuição");
      assert.equal((await q("SELECT 1 FROM marketing_atribuicoes WHERE empresa_id=$1", [B.empresa])).rows.length, 0, "H3: B sem nenhuma atribuição");
      const depoisA = await evidencia("H3", "DEPOIS", "A");
      const depoisB = await evidencia("H3", "DEPOIS", "B");
      assert.deepEqual(depoisB.linhas.filter((l) => l.campanhaId).map((l) => [l.campanhaNome, l.cliquesLink, l.cliquesWhatsapp, l.contatos]), [], "H3: nenhuma linha de campanha com número no painel de B");
      assert.deepEqual([depoisB.total.cliquesLink, depoisB.total.cliquesWhatsapp], [0, 0], "H3: B sem cliques");
      assert.equal(linhaOrigem(depoisB, "SEM_REGISTRO")?.contatos, 2, "H3: os 2 cartões de B aparecem como origem não registrada");
      for (const x of TRES) assert.deepEqual(numeros(linhaCampanha(depoisA, x.c.id)), numeros(linhaCampanha(antesA, x.c.id)), `H3 ${x.nome}: painel de A inalterado`);
      assert.equal((linhaOrigem(depoisA, "SEM_REGISTRO")?.contatos ?? 0) - (linhaOrigem(antesA, "SEM_REGISTRO")?.contatos ?? 0), 1, "H3: o cartão de A com Ref de B entra como origem não registrada");
    });

    await t.test("H4: referência ausente ou ambígua; rota recusa entradas inválidas", async () => {
      const antes = await evidencia("H4", "ANTES", "A");
      // Campanha arquivada.
      const arquivada = await criarCampanha(A.empresa, A.usuario, cod("arq-").slice(0, 20), "Sintético arquivada", "INSTAGRAM", "INSTAGRAM");
      await q("BEGIN");
      await campanhas.executarAcaoCampanha(txc, A.empresa, A.usuario, { acao: "arquivar", id: arquivada.id, versao: arquivada.versao });
      await q("COMMIT");
      const totalAntes = await totalEventos();
      // Rota: entradas inválidas.
      assert.equal((await evento("visita", igPago.id, SITE, `&campanha=${igBio.id}`)).status, 400, "H4: dois parâmetros campanha = 400");
      assert.equal((await evento("visita", igPago.id, SITE, "&evento=whatsapp")).status, 400, "H4: dois parâmetros evento = 400");
      assert.equal((await evento("compra", igPago.id)).status, 400, "H4: evento desconhecido = 400");
      assert.equal((await evento("visita", "nao-e-uuid")).status, 400, "H4: campanha fora do formato = 400");
      assert.equal((await evento("visita", igPago.id, "https://example.invalid")).status, 403, "H4: Origin errado = 403");
      assert.equal((await evento("visita", igPago.id, null)).status, 403, "H4: sem Origin = 403");
      assert.equal((await evento("visita", UUID_INEXISTENTE)).status, 204, "H4: campanha inexistente = 204 sem efeito");
      assert.equal((await evento("whatsapp", arquivada.id)).status, 204, "H4: campanha arquivada = 204 sem efeito");
      delete process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID;
      try {
        assert.equal((await evento("visita", igPago.id)).status, 404, "H4: variável ausente = 404");
        // Variável ausente: mensagem com Ref válida não atribui.
        await receber(aStg, "5561900000409", comRef(PEDIDO, igPago.id), "Sintético variável ausente");
        await processar(aStg);
      } finally { process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID = A.empresa; }
      assert.equal(await totalEventos(), totalAntes, "H4: nenhum evento gravado em nenhuma das recusas");

      const casos = [
        { rotulo: "sem Ref", fone: "5561900000401", texto: PEDIDO, campanhaReal: null as string | null },
        { rotulo: "Ref com UUID inválido", fone: "5561900000402", texto: `${PEDIDO}\nRef. iA.Fest: nao-e-uuid`, campanhaReal: null },
        { rotulo: "Ref fora da última linha", fone: "5561900000403", texto: `${PEDIDO}\nRef. iA.Fest: ${igPago.id}\nObrigado!`, campanhaReal: null },
        // ACHADO 1 corrigido: duas linhas de referência são ambíguas e não atribuem.
        { rotulo: "duas linhas Ref (bio, depois Google)", fone: "5561900000404", texto: `${PEDIDO}\nRef. iA.Fest: ${igBio.id}\nRef. iA.Fest: ${google.id}`, campanhaReal: null },
        { rotulo: "UUID de campanha inexistente", fone: "5561900000405", texto: comRef(PEDIDO, UUID_INEXISTENTE), campanhaReal: null },
        { rotulo: "campanha ARQUIVADA", fone: "5561900000406", texto: comRef(PEDIDO, arquivada.id), campanhaReal: null },
      ];
      for (const x of casos) await receber(aStg, x.fone, x.texto, `Sintético ${x.rotulo}`);
      await processar(aStg);
      for (const x of [...casos, { rotulo: "variável ausente", fone: "5561900000409", campanhaReal: null }]) {
        const ks = await cartoes(A.empresa, x.fone);
        assert.equal(ks.length, 1, `H4 ${x.rotulo}: cartão criado`);
        const a = await atribuicoes(ks[0].id);
        assert.deepEqual(a, [], `H4 ${x.rotulo}: cartão sem atribuição de campanha`);
      }
      const depois = await evidencia("H4", "DEPOIS", "A");
      const sem = (p: PainelMarketing) => linhaOrigem(p, "SEM_REGISTRO")?.contatos ?? 0;
      assert.equal(sem(depois) - sem(antes), 7, "H4: os 7 cartões sem atribuição (inclusive o de duas Refs) aparecem em origem não registrada");
      assert.equal(linhaCampanha(depois, arquivada.id), undefined, "H4: campanha arquivada sem linha no painel");
      assert.deepEqual(numeros(linhaCampanha(depois, igPago.id)), numeros(linhaCampanha(antes, igPago.id)), "H4: Instagram pago inalterado");
      assert.deepEqual(numeros(linhaCampanha(depois, google.id)), [2, 1, 1], "H4: Google segue 2/1/1 (mensagem com duas Refs não atribui)");
      assert.deepEqual(numeros(linhaCampanha(depois, igBio.id)), numeros(linhaCampanha(antes, igBio.id)), "H4: Instagram bio inalterado");
    });

    await t.test("H5: atendimento humano", async () => {
      const antes = await evidencia("H5", "ANTES", "A");
      // (a) conversa já com a equipe (HUMANO e AGUARDANDO_HUMANO) recebe pedido com Ref válida.
      const humanos = [["HUMANO", "5561900000501"], ["AGUARDANDO_HUMANO", "5561900000502"]] as const;
      for (const [estado, fone] of humanos) {
        await receber(aStg, fone, SAUDACAO, `Sintético ${estado}`);
        await processar(aStg);
        const cv = await conversa(A.empresa, fone);
        await q("UPDATE whatsapp_atendimento_conversas SET estado=$2, responsavel_id=CASE WHEN $2='HUMANO' THEN $3::uuid ELSE responsavel_id END, versao=versao+1 WHERE id=$1", [cv.id, estado, A.usuario]);
      }
      const enviadosAntes = (fone: string) => envios.filter((e) => e.contato === fone).length;
      const base5a = Object.fromEntries(humanos.map(([, f]) => [f, enviadosAntes(f)]));
      for (const [, fone] of humanos) {
        assert.equal((await evento("whatsapp", igBio.id)).status, 204);
        await receber(aStg, fone, comRef(PEDIDO, igBio.id));
      }
      await processar(aStg);
      for (const [estado, fone] of humanos) {
        const cv = await conversa(A.empresa, fone);
        const ultima = (await q<{ estado: string }>("SELECT estado FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND direcao='ENTRADA' ORDER BY criada_em DESC LIMIT 1", [cv.id])).rows[0];
        console.log("EVIDENCIA " + JSON.stringify({ cenario: "H5a", estadoInicial: estado, estadoConversa: cv.estado, marcaPendente: cv.oportunidade_pendente_em !== null,
          campanhaSitePendente: cv.contexto?.campanhaSitePendente ?? null, entrada: ultima?.estado ?? null, respostasDoWallE: enviadosAntes(fone) - base5a[fone], cartoes: (await cartoes(A.empresa, fone)).length }));
        assert.equal((await cartoes(A.empresa, fone)).length, 0, `H5a ${estado}: nenhum cartão (pedido com a equipe não entra no funil)`);
        assert.equal(cv.oportunidade_pendente_em, null, `H5a ${estado}: nenhuma marca`);
        assert.equal(cv.contexto?.campanhaSitePendente, undefined, `H5a ${estado}: nenhuma referência guardada`);
        assert.equal(enviadosAntes(fone) - base5a[fone], 0, `H5a ${estado}: o Wall-e não responde`);
      }
      // (b) o Wall-e responde e passa para a equipe na mesma mensagem (motivo não bloqueante PEDIDO_CLIENTE).
      const fone5b = "5561900000503";
      await receber(aStg, fone5b, comRef(COM_ATENDENTE, igBio.id), "Sintético passagem");
      await processar(aStg);
      const [k5b] = await cartoes(A.empresa, fone5b);
      assert.ok(k5b, "H5b: cartão criado");
      assert.equal((await conversa(A.empresa, fone5b)).estado, "AGUARDANDO_HUMANO", "H5b: conversa passou para a equipe");
      assert.deepEqual((await atribuicoes(k5b.id)).map((a) => [a.campanha_id, a.metodo]), [[igBio.id, "INFORMADO"]], "H5b: cartão com a campanha (Instagram bio)");
      // (c) Ref só na saudação (não qualifica); pedido depois, sem Ref.
      const fone5c = "5561900000504";
      await receber(aStg, fone5c, comRef(SAUDACAO, google.id), "Sintético saudação com Ref");
      await processar(aStg);
      const cv5c = await conversa(A.empresa, fone5c);
      assert.deepEqual([cv5c.contexto?.campanhaSitePendente ?? null, (await cartoes(A.empresa, fone5c)).length], [null, 0], "H5c: saudação com Ref não guarda a referência nem cria cartão");
      await receber(aStg, fone5c, PEDIDO);
      await processar(aStg);
      const [k5c] = await cartoes(A.empresa, fone5c);
      assert.ok(k5c, "H5c: o pedido sem Ref cria o cartão");
      assert.deepEqual(await atribuicoes(k5c.id), [], "H5c: ACHADO — cartão SEM campanha (a Ref da 1ª mensagem se perdeu)");
      const depois = await evidencia("H5", "DEPOIS", "A");
      assert.deepEqual(numeros(linhaCampanha(depois, igBio.id)).map((n, i) => n - numeros(linhaCampanha(antes, igBio.id))[i]), [0, 2, 1],
        "H5: Instagram bio +2 cliques no WhatsApp (H5a contados) e +1 contato (H5b); H5a sem contato");
      assert.deepEqual(numeros(linhaCampanha(depois, google.id)), numeros(linhaCampanha(antes, google.id)), "H5c: Google sem contato novo");
    });

    await t.test("H6: negociação e contrato herdam a campanha; registro manual por Indicação", async () => {
      const antes = await evidencia("H6", "ANTES", "A");
      const [k] = await cartoes(A.empresa, TRES[0].fone);
      assert.equal(k.cliente_id, clienteIgPago, "H6: cartão do Instagram pago ligado ao cliente único");
      await q("BEGIN");
      let negocio: string;
      try {
        await travarConfiguracaoAgenda(txc, A.empresa, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
        const base = await comercial(c as never, A.empresa);
        negocio = await fechamento(c as never, A.empresa, base, clienteIgPago, { data: somarDias(hoje, 100), status: "AGUARDANDO_CONTRATO" });
        await conversao.vincularContatoNegociacao(txc, A.empresa, A.usuario, { id: k.id, fechamentoId: negocio });
        await q("COMMIT");
      } catch (e) { await q("ROLLBACK"); throw e; }
      assert.deepEqual((await atribuicoes(negocio)).map((a) => [a.campanha_id, a.origem_codigo, a.metodo, a.vigente]), [[igPago.id, "INSTAGRAM", "HERDADO", true]],
        "H6: FECHAMENTO herda a campanha Instagram pago (HERDADO)");
      assert.equal((await cartoes(A.empresa, TRES[0].fone))[0].status, "CONVERTIDO", "H6: cartão convertido");
      const comNegociacao = await evidencia("H6-negociacao", "DEPOIS", "A");
      assert.equal(linhaCampanha(comNegociacao, igPago.id)?.negociacoes, 1, "H6: Instagram pago com negociações=1 (gravada)");
      // Registro manual: Indicação por telefone, sem campanha.
      let manual: { id: string };
      await q("BEGIN");
      try {
        manual = await contatos.executarAcaoContato(txc, A.empresa, A.usuario, contatos.esquemaAcaoContato.parse({ acao: "registrar", nome: "Sintético Indicação", telefone: "5561900000601",
          canal: "TELEFONE", origemCodigo: "INDICACAO", chave: cod("sintetico-indicacao-") })) as { id: string };
        await q("COMMIT");
      } catch (e) { await q("ROLLBACK"); throw e; }
      assert.deepEqual((await atribuicoes(manual.id)).map((a) => [a.campanha_id, a.origem_codigo, a.metodo, a.canal_atendimento]), [[null, "INDICACAO", "INFORMADO", "TELEFONE"]], "H6: registro manual com origem Indicação e canal Telefone");
      // Contrato ASSINADO: mesmo fixture das outras suítes de Marketing (contratoAssinado), lido DENTRO da transação. A trava
      // diferida kidmais019_validar_contrato exige duas assinaturas e Festa ativa no COMMIT; a formalização completa não é
      // escopo daqui, então a transação é desfeita depois da leitura (H7 roda sem o contrato).
      await q("BEGIN");
      try {
        await travarConfiguracaoAgenda(txc, A.empresa, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
        await contratoAssinado(c as never, negocio, 4500, null);
        const depois = await evidencia("H6", "DEPOIS", "A");
        const l = linhaCampanha(depois, igPago.id)!;
        assert.deepEqual([l.negociacoes, l.contratos, l.receitaContratadaCentavos, l.contatosComContrato], [1, 1, 450000, 1], "H6: Instagram pago com negociações=1, contratos=1 e receita contratada R$ 4.500,00");
        for (const x of TRES.slice(1)) assert.equal(linhaCampanha(depois, x.c.id)?.contratos ?? 0, 0, `H6: ${x.nome} segue com contratos=0`);
        assert.equal((linhaOrigem(depois, "INDICACAO")?.contatos ?? 0) - (linhaOrigem(antes, "INDICACAO")?.contatos ?? 0), 1, "H6: o registro manual aparece na linha da origem Indicação");
      } finally { await q("ROLLBACK"); }
    });

    await t.test("H7: filtro de Unidade (documenta, sem reprovar)", async () => {
      const unidade = await id("INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, 'Sintético Unidade 1', 'SUSPENSO') RETURNING id::text", [A.empresa, cod("u-")]);
      const todas = await evidencia("H7", "ANTES", "A");
      const filtrado = await evidencia("H7", "DEPOIS", "A", unidade);
      console.log("EVIDENCIA " + JSON.stringify({ cenario: "H7", comparacao: TRES.map((x) => ({ campanha: x.nome, semFiltro: numeros(linhaCampanha(todas, x.c.id)), comUnidade: numeros(linhaCampanha(filtrado, x.c.id)) })) }));
      assert.ok(true, "H7: só evidência");
    });

    await t.test("H8 (r3): falha da atribuição não desfaz o cartão; segue sem campanha, contada à parte, sem nova tentativa", async () => {
      const falha = await criarCampanha(A.empresa, A.usuario, cod("h8-falha-").slice(0, 20), "Sintético H8 falha", "INSTAGRAM", "INSTAGRAM");
      // Falha sintética só desta campanha, no INSERT da atribuição (SQLSTATE P0001: falha de negócio, não de conexão).
      await q(`CREATE FUNCTION h8_sintetico_falha() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
        IF NEW.campanha_id = '${falha.id}'::uuid THEN RAISE EXCEPTION 'falha sintética H8'; END IF; RETURN NEW; END $f$`);
      await q("CREATE TRIGGER h8_sintetico_falha BEFORE INSERT ON marketing_atribuicoes FOR EACH ROW EXECUTE FUNCTION h8_sintetico_falha()");
      // Contador do lote pelo aviso operacional do worker (sem dado pessoal; não diz que o cartão deixou de ser gravado).
      const avisos: unknown[][] = [];
      const processarContando = async () => {
        const original = console.warn;
        console.warn = (...a: unknown[]) => { if (String(a[0]).includes("campanha do site não atribuída")) avisos.push(a); else original(...a); };
        try { await processar(aStg); } finally { console.warn = original; }
      };
      const fone = "5561900000801";
      let removido = false;
      try {
        await receber(aStg, fone, comRef(PEDIDO, falha.id), "Sintético H8");
        await processarContando();
        const [k] = await cartoes(A.empresa, fone);
        assert.ok(k, "H8: o cartão nasce mesmo com a atribuição falhando");
        assert.deepEqual(await atribuicoes(k.id), [], "H8: sem atribuição (SAVEPOINT desfeito)");
        const cv = await conversa(A.empresa, fone);
        // Só a memória da festa (data, convidados) que o Wall-e grava: nenhuma chave sobre a campanha ou a falha.
        assert.deepEqual(Object.keys(cv.contexto ?? {}).filter((x) => !["data", "convidados"].includes(x)), [], "H8: contexto sem campanhaSitePendente, sem campanhaSiteAtribuir e sem outra chave da falha");
        assert.equal(cv.oportunidade_pendente_em, null, "H8: a marca foi limpa (a conversa não fica adiada)");
        assert.deepEqual(avisos.map((a) => [a[0], a[1]]), [["[Atendimento WhatsApp] campanha do site não atribuída em %d cartão(ões) do funil; atribuir à mão.", 1]], "H8: contador de falhas da atribuição = 1");
        assert.ok(!avisos.some((a) => a.slice(1).some((x) => String(x).includes(fone) || String(x).includes(falha.id))), "H8: o aviso não leva telefone nem campanha");
        // A falha passa e os ciclos seguintes rodam: nada é tentado de novo.
        await q("DROP TRIGGER h8_sintetico_falha ON marketing_atribuicoes");
        removido = true;
        await receber(aStg, fone, MAIS_CONVIDADOS);
        await processarContando();
        await processarContando();
        assert.deepEqual(await atribuicoes(k.id), [], "H8: sem nova tentativa nos ciclos seguintes");
        assert.deepEqual((await cartoes(A.empresa, fone)).map((x) => x.id), [k.id], "H8: sem segundo cartão");
        assert.equal(avisos.length, 1, "H8: nenhuma falha nova contada");
        assert.deepEqual(Object.keys((await conversa(A.empresa, fone)).contexto ?? {}).filter((x) => !["data", "convidados"].includes(x)), [], "H8: nada guardado depois");
        const p = await evidencia("H8", "DEPOIS", "A");
        assert.deepEqual(numeros(linhaCampanha(p, falha.id)), [0, 0, 0], "H8: o contato não aparece na campanha (a equipe atribui à mão)");
      } finally {
        if (!removido) await q("DROP TRIGGER IF EXISTS h8_sintetico_falha ON marketing_atribuicoes");
        await q("DROP FUNCTION IF EXISTS h8_sintetico_falha()");
      }
    });

    await t.test("H9 (r2, P2, 136): campanha externa, interna com site e antiga sem site convivem na empresa da integração", async () => {
      const site = await id(`INSERT INTO marketing_sites (empresa_id, slug, rascunho, criado_por, atualizado_por) VALUES ($1, $2, '{}'::jsonb, $3, $3) RETURNING id::text`, [A.empresa, cod("h9-"), A.usuario]);
      const criar = async (codigo: string, extra: Record<string, unknown>) => {
        await q("BEGIN");
        try {
          const r = await campanhas.executarAcaoCampanha(txc, A.empresa, A.usuario, { acao: "criar", codigo, nome: `Sintético ${codigo}`, canal: "INSTAGRAM", origemCodigo: "INSTAGRAM",
            inicio: "2026-11-01", utmSource: "instagram", utmMedium: "social", ...extra } as never) as { id: string; destinoExterno: boolean; siteId: string | null };
          await q("COMMIT");
          return r;
        } catch (e) { await q("ROLLBACK"); throw e; }
      };
      const externa = await criar(cod("h9-ext-").slice(0, 20), { destinoExterno: true });
      const interna = await criar(cod("h9-int-").slice(0, 20), { siteId: site });
      const antiga = await criar(cod("h9-old-").slice(0, 20), {});
      assert.deepEqual([externa.destinoExterno, interna.destinoExterno, interna.siteId, antiga.destinoExterno, antiga.siteId], [true, false, site, false, null]);
      const totalAntes = await totalEventos();
      for (const c of [interna, antiga]) for (const tipo of ["visita", "whatsapp"]) assert.equal((await evento(tipo, c.id)).status, 204, "H9: 204 sem efeito");
      assert.equal(await totalEventos(), totalAntes, "H9: campanha interna ou antiga sem destino externo não grava clique do site externo");
      assert.equal((await evento("visita", externa.id)).status, 204);
      assert.deepEqual((await eventos(A.empresa)).filter((e) => e.campanha_id === externa.id).map((e) => [e.tipo, e.n]), [["CLIQUE_LINK_CAMPANHA", 1]], "H9: a externa grava");
      // Wall-e: Ref com o UUID da interna ou da antiga não atribui; a da externa atribui.
      const casos = [["5561900000901", interna.id, null], ["5561900000902", antiga.id, null], ["5561900000903", externa.id, externa.id]] as const;
      for (const [fone, campanha] of casos) await receber(aStg, fone, comRef(PEDIDO, campanha), "Sintético H9");
      await processar(aStg);
      for (const [fone, , esperada] of casos) {
        const [k] = await cartoes(A.empresa, fone);
        assert.ok(k, `H9 ${fone}: cartão criado`);
        assert.deepEqual((await atribuicoes(k.id)).map((a) => a.campanha_id), esperada ? [esperada] : [], `H9 ${fone}: atribuição só da externa`);
      }
      // Recusas do domínio: externa com site; externa fora da empresa da integração.
      const recusa = async (empresa: string, usuario: string, extra: Record<string, unknown>, codigo: string) => {
        await q("BEGIN");
        try {
          await assert.rejects(campanhas.executarAcaoCampanha(txc, empresa, usuario, { acao: "criar", codigo: cod("h9-x-").slice(0, 20), nome: "Sintético recusa", canal: "INSTAGRAM",
            origemCodigo: "INSTAGRAM", inicio: "2026-11-01", utmSource: "instagram", utmMedium: "social", ...extra } as never), (e: { code?: string }) => e.code === codigo, codigo);
        } finally { await q("ROLLBACK"); }
      };
      await recusa(A.empresa, A.usuario, { destinoExterno: true, siteId: site }, "MARKETING_DESTINO_EXTERNO_COM_SITE");
      await recusa(B.empresa, B.usuario, { destinoExterno: true }, "MARKETING_DESTINO_EXTERNO_INDISPONIVEL");
      assert.equal((await q("SELECT 1 FROM marketing_campanhas WHERE empresa_id=$1 AND destino_externo", [B.empresa])).rows.length, 0, "H9: B sem campanha externa");
      await evidencia("H9", "DEPOIS", "A");
    });
  } finally {
    if (variavelAntes === undefined) delete process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID; else process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID = variavelAntes;
    if (ambienteAntes === undefined) delete process.env.KIDMAIS_DEPLOY_ENV; else process.env.KIDMAIS_DEPLOY_ENV = ambienteAntes;
    await c.end();
  }
});
