import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { carregarComBanco, cliente, comercial, contratoAssinado, empresa, fechamento, pedido, type Resposta, vincular, SENHA_FALSA, cod } from "./harness-postgres.ts";

/**
 * Origem da negociação herdada do cliente (decisão de Felipe, 30/10/2026), pelas ROTAS reais no modelo 086:
 *   1. sem origem própria, a PRIMEIRA negociação do cliente conta no painel pela origem do cliente; a segunda não;
 *   2. a API da origem mostra a herança só na primeira (a tela da festa/perfil explica de onde vem o número);
 *   3. origem própria vence a herança (nada foi gravado: a herança some sozinha);
 *   4. origem DESCONHECIDA do cliente não é herdada (continua "Origem não registrada");
 *   5. empresa B não vê nem herda nada de A.
 * Tudo numa transação desfeita no fim.
 */
const BASE = "http://127.0.0.1:3000";
type Rota = { GET?: (r: unknown, ctx?: unknown) => Promise<Resposta>; POST?: (r: unknown, ctx?: unknown) => Promise<Resposta> };
type Linha = { origemCodigo: string | null; campanhaId: string | null; negociacoes: number; contratos: number; receitaContratadaCentavos: number | null; receitaRecebidaCentavos: number };

async function gestao(c: Client, empresaId: string, nome: string) {
  const usuario = (await c.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, $2, $3, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`,
    [`${cod("u")}@marketing.test`, nome, SENHA_FALSA])).rows[0].id;
  return vincular(c, empresaId, usuario, "REPRESENTANTE_AUTORIZADO", nome);
}

test("origem da negociação: primeira negociação herda a origem do cliente; própria vence; desconhecida não herda; A×B", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c: Client = await conectarDescartavel();
  try {
    let sessao: unknown = null;
    const cache = new Map();
    const carregar = <T>(arquivo: string) => carregarComBanco(arquivo, c, () => sessao, {}, cache) as unknown as T;
    const resumo = carregar<Rota>("app/api/admin/marketing/resumo/route.ts");
    const atribuicoes = carregar<Rota>("app/api/admin/marketing/atribuicoes/route.ts");
    const chamar = async (rota: Rota, metodo: "GET" | "POST", url: string, corpo?: unknown) => {
      const r = await rota[metodo]!(pedido(`${BASE}${url}`, corpo, metodo));
      return { status: r.status, corpo: await r.json() };
    };
    const ok = async (rota: Rota, metodo: "GET" | "POST", url: string, corpo?: unknown) => {
      const r = await chamar(rota, metodo, url, corpo);
      assert.equal(r.status, 200, `${metodo} ${url}: ${JSON.stringify(r.corpo)}`);
      return r.corpo.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const painel = async () => (await ok(resumo, "GET", "/api/admin/marketing/resumo")).painel as { linhas: Linha[]; negociacoesSemOrigem: number; negociacoesHerdadas: number };
    const linha = (p: { linhas: Linha[] }, origem: string) => p.linhas.find((l) => !l.campanhaId && l.origemCodigo === origem);
    const origemDe = (fechamentoId: string) => ok(atribuicoes, "GET", `/api/admin/marketing/atribuicoes?alvoTipo=FECHAMENTO&alvoId=${fechamentoId}`);

    await c.query("BEGIN");
    const A = await empresa(c, "Buffet Alfa sintético"), B = await empresa(c, "Buffet Beta sintético");
    const gestaoA = await gestao(c, A, "Gestão A"), gestaoB = await gestao(c, B, "Gestão B");
    const baseA = await comercial(c, A);
    const clara = await cliente(c, A, "Clara Instagram", "5511977771001");
    const davi = await cliente(c, A, "Davi Desconhecido", "5511977771002");
    sessao = gestaoA.sessao;
    await ok(atribuicoes, "POST", "/api/admin/marketing/atribuicoes", { alvoTipo: "CLIENTE", alvoId: clara, origemCodigo: "INSTAGRAM" });
    await c.query(`INSERT INTO marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id, origem_codigo, metodo) VALUES ($1::uuid, 'CLIENTE', $2::uuid, 'DESCONHECIDA', 'DESCONHECIDO')`, [A, davi]);
    // Primeira (há 5 dias, com contrato) e segunda (hoje) negociação da Clara; uma do Davi. Nenhuma com origem própria.
    const primeira = await fechamento(c, A, baseA, clara, { data: "2027-03-06", status: "AGUARDANDO_CONTRATO", atualizadoHaDias: 5 });
    const segunda = await fechamento(c, A, baseA, clara, { data: "2027-09-11", status: "AGUARDANDO_CONTRATO" });
    const deDavi = await fechamento(c, A, baseA, davi, { data: "2027-04-10", status: "AGUARDANDO_CONTRATO" });
    await contratoAssinado(c, primeira, 6000, 2000);

    await t.test("1. só a primeira negociação herda; contrato e receita seguem a herança, sem duplicar", async () => {
      const p = await painel();
      assert.deepEqual(
        (({ negociacoes, contratos, receitaContratadaCentavos, receitaRecebidaCentavos }) => ({ negociacoes, contratos, receitaContratadaCentavos, receitaRecebidaCentavos }))(linha(p, "INSTAGRAM")!),
        { negociacoes: 1, contratos: 1, receitaContratadaCentavos: 600000, receitaRecebidaCentavos: 200000 });
      assert.equal(linha(p, "SEM_REGISTRO")!.negociacoes, 2, "segunda da Clara + a do Davi");
      assert.equal(linha(p, "SEM_REGISTRO")!.contratos, 0);
      assert.equal(p.negociacoesSemOrigem, 2);
      assert.equal(p.negociacoesHerdadas, 1);
    });

    await t.test("2. a API mostra a herança só na primeira negociação; desconhecida não é herdada", async () => {
      const r1 = await origemDe(primeira);
      assert.equal(r1.vigente, null);
      assert.equal(r1.herdadaDoCliente.origemCodigo, "INSTAGRAM");
      assert.equal(r1.herdadaDoCliente.alvoTipo, "CLIENTE");
      assert.equal((await origemDe(segunda)).herdadaDoCliente, null);
      assert.equal((await origemDe(deDavi)).herdadaDoCliente, null);
      assert.equal(linha(await painel(), "DESCONHECIDA"), undefined, "desconhecida do cliente não vira linha da negociação");
    });

    await t.test("3. origem própria vence a herança e nada herdado fica gravado", async () => {
      assert.equal(Number((await c.query(`SELECT count(*) AS n FROM marketing_atribuicoes WHERE alvo_tipo = 'FECHAMENTO'`)).rows[0].n), 0, "herança não grava linha");
      await ok(atribuicoes, "POST", "/api/admin/marketing/atribuicoes", { alvoTipo: "FECHAMENTO", alvoId: primeira, origemCodigo: "FACEBOOK" });
      const p = await painel();
      assert.equal(linha(p, "INSTAGRAM"), undefined);
      assert.deepEqual([linha(p, "FACEBOOK")!.negociacoes, linha(p, "FACEBOOK")!.contratos, linha(p, "FACEBOOK")!.receitaContratadaCentavos], [1, 1, 600000]);
      assert.equal(p.negociacoesHerdadas, 0);
      const r = await origemDe(primeira);
      assert.equal(r.vigente.origemCodigo, "FACEBOOK");
      assert.equal(r.herdadaDoCliente, null);
    });

    await t.test("4. empresa B não lê a origem nem herda nada de A", async () => {
      sessao = gestaoB.sessao;
      assert.equal((await chamar(atribuicoes, "GET", `/api/admin/marketing/atribuicoes?alvoTipo=FECHAMENTO&alvoId=${segunda}`)).status, 404);
      const p = await painel();
      assert.deepEqual([p.linhas.length, p.negociacoesSemOrigem, p.negociacoesHerdadas], [0, 0, 0]);
      sessao = gestaoA.sessao;
    });
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});

/**
 * Casos de borda (P3-1 da revisão do Astra, 30/10/2026). Cada cliente usa uma origem diferente para isolar a linha:
 *   OUTRO (Ester) empate de iniciado_em → desempate por id; GOOGLE (Fábio) primeira negociação CANCELADA, a segunda não
 *   herda, e a correção da origem do cliente reclassifica; FACEBOOK (Gabi) cancelamento segue a herança; INSTAGRAM com
 *   campanha (Helena) → linha da campanha; INDICACAO (Igor) com origem própria DESCONHECIDA não herda; negociação sem
 *   cliente não herda; período fora não conta; empresa B com dados próprios não se mistura com A.
 */
test("origem da negociação: empate, sem cliente, primeira cancelada, cancelamento, campanha, desconhecida própria, correção, período, A×B", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c: Client = await conectarDescartavel();
  try {
    let sessao: unknown = null;
    const cache = new Map();
    const carregar = <T>(arquivo: string) => carregarComBanco(arquivo, c, () => sessao, {}, cache) as unknown as T;
    const resumo = carregar<Rota>("app/api/admin/marketing/resumo/route.ts");
    const atribuicoes = carregar<Rota>("app/api/admin/marketing/atribuicoes/route.ts");
    const campanhas = carregar<Rota>("app/api/admin/marketing/campanhas/route.ts");
    const ok = async (rota: Rota, metodo: "GET" | "POST", url: string, corpo?: unknown) => {
      const r = await rota[metodo]!(pedido(`${BASE}${url}`, corpo, metodo));
      const json = await r.json();
      assert.equal(r.status, 200, `${metodo} ${url}: ${JSON.stringify(json)}`);
      return json.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    type Painel = { linhas: Array<Linha & { cancelamentos: number }>; negociacoesSemOrigem: number; negociacoesHerdadas: number };
    const painel = async (consulta = "") => (await ok(resumo, "GET", `/api/admin/marketing/resumo${consulta}`)).painel as Painel;
    const linha = (p: Painel, origem: string) => p.linhas.find((l) => !l.campanhaId && l.origemCodigo === origem);
    const herdada = async (fechamentoId: string) => (await ok(atribuicoes, "GET", `/api/admin/marketing/atribuicoes?alvoTipo=FECHAMENTO&alvoId=${fechamentoId}`)).herdadaDoCliente as { origemCodigo: string } | null;
    const origemCliente = (clienteId: string, origemCodigo: string, extra: Record<string, unknown> = {}) =>
      ok(atribuicoes, "POST", "/api/admin/marketing/atribuicoes", { alvoTipo: "CLIENTE", alvoId: clienteId, origemCodigo, ...extra });

    await c.query("BEGIN");
    const A = await empresa(c, "Buffet Alfa sintético"), B = await empresa(c, "Buffet Beta sintético");
    const gestaoA = await gestao(c, A, "Gestão A"), gestaoB = await gestao(c, B, "Gestão B");
    const baseA = await comercial(c, A), baseB = await comercial(c, B);
    sessao = gestaoA.sessao;
    const novo = async (nome: string, tel: string, origem: string, extra: Record<string, unknown> = {}) => {
      const id = await cliente(c, A, nome, tel);
      await origemCliente(id, origem, extra);
      return id;
    };
    const ester = await novo("Ester Empate", "5511966661001", "OUTRO");
    const fabio = await novo("Fábio Cancelou", "5511966661002", "GOOGLE");
    const gabi = await novo("Gabi Cancelamento", "5511966661003", "FACEBOOK");
    const campanha = (await ok(campanhas, "POST", "/api/admin/marketing/campanhas", { acao: "criar", codigo: "out-borda", nome: "Outubro Borda", canal: "INSTAGRAM",
      origemCodigo: "INSTAGRAM", inicio: "2026-10-01", utmSource: "instagram", utmMedium: "social" })).campanha.id as string;
    const helena = await novo("Helena Campanha", "5511966661004", "INSTAGRAM", { campanhaId: campanha });
    const igor = await novo("Igor Próprio", "5511966661005", "INDICACAO");

    // Empate: duas negociações da Ester com o MESMO iniciado_em (mesma transação, mesmo deslocamento) → vence o menor id.
    const empate = [await fechamento(c, A, baseA, ester, { data: "2027-05-01", status: "AGUARDANDO_CONTRATO", atualizadoHaDias: 3 }),
      await fechamento(c, A, baseA, ester, { data: "2027-05-02", status: "AGUARDANDO_CONTRATO", atualizadoHaDias: 3 })].sort();
    const fabio1 = await fechamento(c, A, baseA, fabio, { data: "2027-06-01", status: "CANCELADO", atualizadoHaDias: 4 });
    const fabio2 = await fechamento(c, A, baseA, fabio, { data: "2027-06-08", status: "AGUARDANDO_CONTRATO" });
    const deGabi = await fechamento(c, A, baseA, gabi, { data: "2027-07-01", status: "AGUARDANDO_CONTRATO", atualizadoHaDias: 2 });
    const { contrato } = await contratoAssinado(c, deGabi, 7000, null);
    await c.query(`UPDATE contratos SET status = 'CANCELADO', cancelado_em = now() WHERE id = $1::uuid`, [contrato]);
    const deHelena = await fechamento(c, A, baseA, helena, { data: "2027-08-01", status: "AGUARDANDO_CONTRATO", atualizadoHaDias: 1 });
    const deIgor = await fechamento(c, A, baseA, igor, { data: "2027-09-01", status: "AGUARDANDO_CONTRATO", atualizadoHaDias: 1 });
    await c.query(`INSERT INTO marketing_atribuicoes (empresa_id, alvo_tipo, alvo_id, origem_codigo, metodo) VALUES ($1::uuid, 'FECHAMENTO', $2::uuid, 'DESCONHECIDA', 'DESCONHECIDO')`, [A, deIgor]);
    const semCliente = await fechamento(c, A, baseA, null as unknown as string, { data: "2027-10-01", status: "AGUARDANDO_CONTRATO" });
    // Empresa B com dados próprios: cliente de B com origem e uma negociação.
    sessao = gestaoB.sessao;
    const daB = await cliente(c, B, "Bruna de B", "5511966661009");
    await origemCliente(daB, "INSTAGRAM");
    const fechB = await fechamento(c, B, baseB, daB, { data: "2027-03-03", status: "AGUARDANDO_CONTRATO" });
    sessao = gestaoA.sessao;

    await t.test("1. empate de iniciado_em: só a negociação de menor id herda", async () => {
      assert.equal((await herdada(empate[0]))?.origemCodigo, "OUTRO");
      assert.equal(await herdada(empate[1]), null);
      assert.equal(linha(await painel(), "OUTRO")!.negociacoes, 1);
    });

    await t.test("2. negociação sem cliente não herda; primeira cancelada impede a herança da segunda", async () => {
      assert.equal(await herdada(semCliente), null);
      assert.equal((await herdada(fabio1))?.origemCodigo, "GOOGLE", "a cancelada continua sendo a primeira");
      assert.equal(await herdada(fabio2), null);
      assert.equal(linha(await painel(), "GOOGLE")!.negociacoes, 1);
    });

    await t.test("3. cancelamento e campanha seguem a herança; origem própria DESCONHECIDA vence", async () => {
      const p = await painel();
      const facebook = linha(p, "FACEBOOK")!;
      assert.deepEqual([facebook.negociacoes, facebook.contratos, facebook.cancelamentos], [1, 0, 1]);
      const daCampanha = p.linhas.find((l) => l.campanhaId === campanha)!;
      assert.equal(daCampanha.negociacoes, 1, "herança leva a campanha do cliente");
      assert.equal(linha(p, "INSTAGRAM"), undefined, "nada vaza de B nem duplica fora da campanha");
      assert.equal((await herdada(deHelena))?.origemCodigo, "INSTAGRAM");
      assert.equal(await herdada(deIgor), null);
      assert.equal(linha(p, "INDICACAO"), undefined);
      assert.equal(linha(p, "DESCONHECIDA")!.negociacoes, 1);
      // Herdadas: Ester (1), Fábio cancelada (1), Gabi (1), Helena (1). Sem origem: Ester 2ª, Fábio 2ª, sem cliente.
      assert.deepEqual([p.negociacoesHerdadas, p.negociacoesSemOrigem], [4, 3]);
    });

    await t.test("4. corrigir a origem do cliente reclassifica a negociação herdada", async () => {
      const vigente = (await ok(atribuicoes, "GET", `/api/admin/marketing/atribuicoes?alvoTipo=CLIENTE&alvoId=${fabio}`)).vigente as { id: string };
      await origemCliente(fabio, "PASSAGEM_FRENTE", { corrigeId: vigente.id, motivo: "correção sintética" });
      const p = await painel();
      assert.equal(linha(p, "GOOGLE"), undefined);
      assert.equal(linha(p, "PASSAGEM_FRENTE")!.negociacoes, 1);
    });

    await t.test("5. período sem negociações não conta herança", async () => {
      const hoje = (await c.query<{ d: string }>(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS d`)).rows[0].d;
      const dia = (n: number) => new Date(Date.parse(`${hoje}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
      const p = await painel(`?de=${dia(90)}&ate=${dia(60)}`);
      assert.deepEqual([p.linhas.length, p.negociacoesHerdadas, p.negociacoesSemOrigem], [0, 0, 0]);
    });

    await t.test("6. empresa B vê só a própria herança; A não vê B", async () => {
      sessao = gestaoB.sessao;
      const p = await painel();
      assert.deepEqual([p.linhas.length, linha(p, "INSTAGRAM")!.negociacoes, p.negociacoesHerdadas, p.negociacoesSemOrigem], [1, 1, 1, 0]);
      assert.equal((await herdada(fechB))?.origemCodigo, "INSTAGRAM");
      const cruzado = await atribuicoes.GET!(pedido(`${BASE}/api/admin/marketing/atribuicoes?alvoTipo=FECHAMENTO&alvoId=${deHelena}`));
      assert.equal(cruzado.status, 404);
      sessao = gestaoA.sessao;
    });
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(c);
  }
});
