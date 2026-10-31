import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { catalogoNativo, catalogoNoTurno, cenario, dia, id, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { carregarComBanco, executor, porTransacao } from "../marketing/harness-postgres.ts";
import { carregarModulo } from "../acessos/teste-carregador.ts";
import * as cotacaoPublicaReal from "../comercial/cotacao-publica.ts";
import * as escopoReal from "../disponibilidade/escopo.ts";
import { MARCADORES } from "../assinatura/recuperacao-execucao.ts";
import { apresentacaoInstalada, salvarApresentacao } from "../agenda/salao-apresentacao.ts";
import { criarServicosComuns } from "../comercial/servicos-comuns.ts";
import { combinadosInstalados, hashVersaoInstalada, preferidoInstalado } from "../agenda/salao-festa.ts";
import { estadoCombinados } from "../agenda/estado-combinados.ts";
import { capacidadeRenovacao } from "../assinatura/renovacao-schema.ts";
import { criarRepositorioOAuthPostgres, SchemaMcpAusente } from "../integracoes/oauth/postgres.ts";
import { conexoesDaPessoa } from "../integracoes/oauth/conexoes.ts";
import { criarTransporteMcp } from "../integracoes/mcp/servidor.ts";
import { cpfDisponivel, schemaCpfInstalado } from "../assinatura/documento-contratante.ts";
import { validarAmbienteFesta } from "../festas/ambiente.ts";
import { assinaturaEstruturaFestaAtual, estruturaFesta016Sql, tabelasFesta016 } from "../festas/estrutura-016.ts";

/**
 * B-19 do plano de promoção para production (rodada 18, R17-F5; §4.5): a candidata roda no schema FINAL desta promoção
 * (089–097, 099 e 100, na ordem do runbook) COM e SEM a 091, e SEM 098 e 102–109 (D-ESC-4…7 = (a)). Modelos da receita:
 * b14-P11 (com a 091) e b14-P10 (sem a 091). Cada modelo roda a suíte inteira; o modelo é identificado pelo catálogo, e o
 * primeiro teste recusa qualquer outro schema (a suíte nunca "passa" num estado que não é o da promoção).
 * Cobre as RECUSAS da ausência pelos caminhos reais (serviço ou rota carregada com o banco do cluster):
 *   102 → 409 RECURSO_INDISPONIVEL; 103 → 409 RECURSO_INDISPONIVEL (categoria Serviços); 104 → hashVersaoInstalada falso e
 *   módulo Festa/health aceitos (assinatura estrutural atual); 105 → transporte MCP 503 antes de qualquer dependência com o
 *   canal desligado E GET/POST administrativos de conexões 503 (SchemaMcpAusente), sem criar nada; 106 → preferidoInstalado
 *   falso e POST público com preferência = 409 SALAO_INDISPONIVEL sem escrita; 107/108 → combinados AUSENTE (e os caminhos
 *   da agenda seguem sem combinados); 109 → renovação no modo 075; 091 → CPF disponível só com a 091 E a chave ligada.
 * Fluxos normais: o mesmo POST público sem preferência cria o fechamento (201), e o health responde 200 com Festa ligada.
 * 100 → com um salão, capacidade antiga 2 aceita uma festa por horário. "Sem escrita" é medido dentro da transação
 * (pg_stat_xact_user_tables) antes do ROLLBACK. As suítes de domínio (agenda, Festa, renovação, disponibilidade) rodam
 * também nestes modelos (regressao-v1-selecao.cjs).
 */
let a: Client;
let tx: DbExecutor;
let com091 = false;

async function existe(tipo: "tabela" | "funcao", nome: string) {
  const sql = tipo === "tabela" ? "SELECT to_regclass('public.' || $1) IS NOT NULL AS ok"
    : "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1) AS ok";
  return (await a.query<{ ok: boolean }>(sql, [nome])).rows[0]!.ok === true;
}
async function coluna(tabela: string, nome: string) {
  return (await a.query<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.' || $1)
    AND attname = $2 AND NOT attisdropped) AS ok`, [tabela, nome])).rows[0]!.ok === true;
}
async function codigoDe(promessa: Promise<unknown>) {
  try { await promessa; return "SEM_RECUSA"; }
  catch (e) { const x = e as { code?: string; codigo?: string; httpStatus?: number; status?: number };
    return `${x.codigo ?? x.code ?? (e instanceof Error ? e.name : "ERRO")}:${x.httpStatus ?? x.status ?? ""}`; }
}
async function emTransacaoDesfeita<T>(fn: () => Promise<T>): Promise<T> {
  await a.query("BEGIN");
  try { return await fn(); } finally { await a.query("ROLLBACK"); }
}
/** Escritas desta sessão na transação aberta (INSERT/UPDATE/DELETE em tabelas do usuário, inclusive as que serão desfeitas). */
const escritasNaTransacao = async () => (await a.query<{ n: number }>(
  `SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::int AS n FROM pg_stat_xact_user_tables`)).rows[0]!.n;
/** Recusa observada DENTRO da transação, antes do ROLLBACK (revisão do Astra, P3): qualquer escrita antes da recusa aparece. */
async function recusaSemEscrita(fn: () => Promise<unknown>) {
  return emTransacaoDesfeita(async () => {
    const antes = await escritasNaTransacao();
    const codigo = await codigoDe(fn());
    return { codigo, escritas: (await escritasNaTransacao()) - antes };
  });
}
function cpfValido() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (base.every((d) => d === base[0])) base[8] = (base[0]! + 1) % 10;
  const dv = (n: number[]) => { const soma = n.reduce((t, d, i) => t + d * (n.length + 1 - i), 0) % 11; return soma < 2 ? 0 : 11 - soma; };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join("");
}
const ctx = (c: Cenario) => ({ empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() });

test.before(async () => {
  a = await conectarDescartavel();
  tx = executor(a);
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("B-19: o schema é o final da promoção (089–097, 099, 100; 091 conforme o modelo) sem 098 e 102–109", async () => {
  for (const [m, o] of Object.entries(MARCADORES)) {
    if (m === "091") continue;
    assert.equal(await existe(o.tipo, o.nome), true, `marcador da ${m} presente`);
  }
  assert.equal(await existe("funcao", "kidmais_100_capacidade_por_horario") || await coluna("agenda_escopo_config", "capacidade_tipo"), true, "100/094 presentes");
  com091 = await existe("tabela", "empresa_documento_continuidades");
  assert.equal(com091, await schemaCpfInstalado(tx), "091: tabela e função andam juntas (nunca parcial)");
  // Ausentes: 098 e 102–109 (objetos próprios de cada uma).
  assert.equal(await existe("funcao", "kidmais098_conjunto"), false, "098/108 ausentes");
  assert.equal(await existe("tabela", "agenda_salao_itens_catalogo"), false, "102 ausente");
  assert.equal(await coluna("agenda_saloes", "convidados_minimo"), false, "102 ausente (colunas)");
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM adicional_categorias WHERE codigo = 'SERVICOS'`)).rows[0]!.n, 0, "103 ausente");
  assert.equal(await coluna("fechamento_revisoes", "hash_versao"), false, "104 ausente");
  assert.equal(await existe("funcao", "kidmais104_hash_versao_imutavel"), false, "104 ausente (função)");
  assert.equal(await existe("tabela", "mcp_oauth_clientes"), false, "105 ausente");
  assert.equal(await existe("tabela", "mcp_oauth_concessoes"), false, "105 ausente (concessões)");
  assert.equal(await coluna("fechamentos", "salao_preferido_id"), false, "106 ausente");
  assert.equal(await coluna("agenda_saloes", "combinado"), false, "108 ausente (coluna)");
  console.log(`B-19 modelo: ${com091 ? "b14-P11 (com a 091)" : "b14-P10 (sem a 091)"}`);
});

test("B-19 (102/103): apresentação dos salões e categoria Serviços recusam com 409 RECURSO_INDISPONIVEL, sem escrita", async () => {
  assert.equal(await apresentacaoInstalada(tx), "AUSENTE");
  const c = await cenario(a, 0);
  const salao = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem) VALUES ($1::uuid, 'Salão B-19', 80, 1) RETURNING id`, [c.empresa]);
  const r102 = await recusaSemEscrita(() => salvarApresentacao(tx, ctx(c), salao, 1, {
    convidadosMinimo: null, convidadosSentados: null, areaM2: 100, idadeMin: 3, idadeMax: 10, frase: "B-19", outraFestaSimultanea: true, exclusivos: [], fotosReferencia: "2026-09",
  }, []));
  assert.deepEqual(r102, { codigo: "RECURSO_INDISPONIVEL:409", escritas: 0 }, "102: recusa sem nenhuma escrita antes dela");
  const r103 = await recusaSemEscrita(() => criarServicosComuns(tx, ctx(c)));
  assert.deepEqual(r103, { codigo: "RECURSO_INDISPONIVEL:409", escritas: 0 }, "103: recusa sem nenhuma escrita antes dela");
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM adicional_categorias WHERE codigo = 'SERVICOS'`)).rows[0]!.n, 0, "nada criado");
});

test("B-19 (104): sem hash_versao; o módulo Festa aceita a estrutura e o health responde 200 com Festa ligada", async () => {
  assert.equal(await hashVersaoInstalada(tx), false);
  assert.equal((await a.query<{ assinatura: string }>(estruturaFesta016Sql, [tabelasFesta016])).rows[0]!.assinatura, assinaturaEstruturaFestaAtual,
    "assinatura estrutural = a anterior à 104 (o código de production também a aceita)");
  const anterior = process.env.FESTA_ENABLED;
  process.env.FESTA_ENABLED = "true";
  try {
    await validarAmbienteFesta(tx);
    const rota = carregarComBanco("app/api/health/route.ts", a, () => null, {
      "db/postgres": { db: () => tx, databaseHealthCheck: async () => (await a.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]!.ok === 1 },
      "identidade/delivery": { validarConfiguracaoOtpAmbiente: () => ({ provider: "gupshup", status: "ready", configured: true, enabled: true }) },
    }, new Map()) as unknown as { GET: () => Promise<Response> };
    const r = await rota.GET();
    assert.equal(r.status, 200, await r.text());
  } finally {
    if (anterior === undefined) delete process.env.FESTA_ENABLED; else process.env.FESTA_ENABLED = anterior;
  }
});

test("B-19 (105): transporte MCP desligado = 503 sem tocar dependência; conexões (GET/POST) = 503 SchemaMcpAusente sem DDL", async () => {
  const tocadas: string[] = [];
  const barreira = (nome: string): unknown => new Proxy(() => undefined, {
    get: (_alvo, p) => { if (p === "then") return undefined; tocadas.push(`${nome}.${String(p)}`); return barreira(`${nome}.${String(p)}`); },
    apply: () => { tocadas.push(`${nome}()`); throw new Error(`dependência tocada: ${nome}`); },
  });
  const atender = criarTransporteMcp({ oauth: { env: {} }, ferramentas: barreira("ferramentas"), limitador: barreira("limitador"), prazoCorpoMs: 200 } as never);
  const r = await atender(new Request("https://manager.example.test/api/mcp", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
  assert.equal(r.status, 503);
  assert.deepEqual(tocadas.filter((t) => t.endsWith("()")), [], "nenhuma dependência chamada com o canal desligado");

  const c = await cenario(a, 0);
  const repo = criarRepositorioOAuthPostgres(() => tx, porTransacao(a));
  await assert.rejects(conexoesDaPessoa({}, repo, c.usuario), SchemaMcpAusente);
  await assert.rejects(conexoesDaPessoa({ MCP_ENABLED: "false" }, repo, c.usuario), SchemaMcpAusente);
  // A rota é carregada pelo carregador de testes (transpila cada módulo): o repositório dela vem do MESMO cache, para que
  // o SchemaMcpAusente lançado seja a classe que a rota reconhece (instanceof), como no servidor real.
  const cache = new Map<string, Record<string, unknown>>();
  const postgresDaRota = carregarModulo("lib/integracoes/oauth/postgres.ts", {}, cache) as { criarRepositorioOAuthPostgres: typeof criarRepositorioOAuthPostgres };
  const repoDaRota = postgresDaRota.criarRepositorioOAuthPostgres(() => tx, porTransacao(a));
  const rota = carregarComBanco("app/api/admin/mcp/conexoes/route.ts", a, () => ({ usuario_id: c.usuario, empresa_ativa_id: c.empresa }), {
    "mcp/dependencias": { repositorioDaPessoa: () => repoDaRota },
    // O carregador de rotas não transpila este módulo; a rota só o usa em `instanceof` (prazo vencido → 503 próprio).
    "db/transacao-com-prazo": { PrazoDaTransacaoVencido: class PrazoDaTransacaoVencido extends Error {} },
  }, cache) as unknown as { GET: (r: unknown) => Promise<Response>; POST: (r: unknown) => Promise<Response> };
  const get = await rota.GET(new Request("http://localhost/api/admin/mcp/conexoes"));
  assert.equal(get.status, 503);
  assert.equal((await get.json() as { codigo: string }).codigo, "INDISPONIVEL");
  const post = await rota.POST(new Request("http://localhost/api/admin/mcp/conexoes", { method: "POST", body: JSON.stringify({ concessaoId: randomUUID() }),
    headers: { "content-type": "application/json" } }));
  assert.equal(post.status, 503);
  assert.equal((await post.json() as { codigo: string }).codigo, "INDISPONIVEL");
  assert.equal(await existe("tabela", "mcp_oauth_concessoes"), false, "nenhum objeto criado");
});

test("B-19 (106 e fluxo normal): POST público sem preferência cria o fechamento (201); com preferência = 409 SALAO_INDISPONIVEL sem escrita", async () => {
  assert.equal(await preferidoInstalado(tx), false);
  const c = await cenario(a, 0);
  const tarde = await id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos, passo_inicio_minutos,
                ordem_exibicao, empresa_id, capacidade) VALUES ('TARDE_B19', 'Tarde', '15:00', '19:00', 0, 30, 1, $1::uuid, 1) RETURNING id`, [c.empresa]);
  await catalogoNativo(a, c);
  await catalogoNoTurno(a, c, tarde);
  const extras = {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } },
    "http/limite-publico": { limitarPublico: async () => null },
    "comercial/cotacao-publica": { ...cotacaoPublicaReal, codigoEmpresaDoPedido: () => "buffet-b19",
      escopoCotacaoPublica: async () => ({ empresaId: c.empresa, estabelecimentoId: null, porCodigo: true }) },
    "disponibilidade/escopo": { ...escopoReal, escopoDaEmpresa: async () => ({ estabelecimentoId: null }) },
    "db/postgres": { db: () => executor(a), withTransaction: porTransacao(a) },
  };
  const rota = carregarComBanco("app/api/fechamentos/route.ts", a, () => null, extras, new Map()) as unknown as {
    POST: (r: unknown) => Promise<{ status: number; body: Record<string, unknown> }> };
  const enviar = (data: string, salaoPreferido?: string) => rota.POST({ url: "http://localhost/api/fechamentos", nextUrl: new URL("http://localhost/api/fechamentos"),
    headers: new Headers(), json: async () => ({
      pacote: "completa", dataFesta: data, configuracaoId: tarde, ajusteHorario: "0", horarioInicio: "15:00", horarioFim: "19:00",
      identidadeTipo: "NOVO_CLIENTE", statusDisponibilidade: "disponivel", convidadosPagantes: 50, buffetDefinicao: "depois", adicionaisSelecionados: [],
      valorCombinado: "100,00", formaPagamento: "pix_avista", nomeCliente: "Cliente Sintético B19", cpf: cpfValido(), email: `b19-${randomBytes(3).toString("hex")}@buffet.test`,
      whatsapp: "11988880019", telefone: "1133330019", cep: "70000000", logradouro: "Rua Sintética", numero: "1", bairro: "Centro", cidade: "Brasília", uf: "DF",
      nomeAniversariante: "Aniversariante B19", idadeAniversariante: 6, ...(salaoPreferido ? { salaoPreferido } : {}),
    }) });
  const contagem = async () => (await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM fechamentos WHERE empresa_id = $1::uuid`, [c.empresa])).rows[0]!.n;
  const ok = await enviar(dia(170));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(await contagem(), 1, "fechamento criado pelo caminho público normal");
  const salao = await id(a, `INSERT INTO agenda_saloes (empresa_id, nome, capacidade_convidados, ordem) VALUES ($1::uuid, 'Salão B-19', 80, 1) RETURNING id`, [c.empresa]);
  const pref = await enviar(dia(171), salao);
  assert.deepEqual([pref.status, pref.body.codigo], [409, "SALAO_INDISPONIVEL"], JSON.stringify(pref.body));
  assert.equal(await contagem(), 1, "preferência recusada sem escrita");
});

test("B-19 (107/108): combinados AUSENTE; os caminhos da agenda seguem sem combinados (nunca ANTIGA/PARCIAL)", async () => {
  assert.deepEqual(await estadoCombinados(tx), { estado: "AUSENTE", coluna: false });
  assert.equal(await combinadosInstalados(tx), false);
});

test("B-19 (109): a renovação roda no modo 075 (retrato da tabela de renovações íntegro, sem a SUBSTITUTA)", async () => {
  assert.deepEqual(await capacidadeRenovacao(tx), { capacidade: "075" });
});

test("B-19 (091): CPF só com a 091 instalada E a chave ligada; sem a 091 a chave ligada não basta", async () => {
  assert.equal(await cpfDisponivel(tx, {}), false, "chave desligada: nunca");
  assert.equal(await cpfDisponivel(tx, { ASSINATURA_CPF_ATIVO: "true" }), com091, com091 ? "P11: disponível com a chave" : "P10: indisponível mesmo com a chave");
});

test("B-19 (100): com um salão (POR_HORARIO), capacidade antiga 2 aceita só uma festa no horário; outro horário segue livre", async () => {
  const conflito = "kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)";
  assert.equal((await a.query<{ h: string }>(`SELECT encode(sha256(convert_to(replace(prosrc, E'\r', ''), 'UTF8')), 'hex') AS h FROM pg_proc
    WHERE oid = to_regprocedure('public.${conflito}')`)).rows[0]?.h, "805cd427a7cc7a725fb3bdfb4fd050f04e618131104fcfc0678a0ddadd5b4bdb", "corpo da regra = o da 100");
  const c = await cenario(a, 0);
  const D = dia(45);
  await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                 VALUES ($1::uuid, 'FIXO', 'POR_HORARIO', NULL, 60, $2::uuid)`, [c.empresa, c.usuario]);
  const horario = (codigo: string, inicio: string, fim: string) => id(a, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao,
      tolerancia_inicio_minutos, passo_inicio_minutos, ordem_exibicao, empresa_id, capacidade) VALUES ($1, $1, $2, $3, 0, 30, 1, $4::uuid, 2) RETURNING id`,
    [codigo, inicio, fim, c.empresa]);
  const tarde = await horario("B19_TARDE_DOIS", "15:00", "19:00"), manha = await horario("B19_MANHA_DOIS", "08:00", "11:00");
  // Festa gravada e confirmada numa transação: os gatilhos diferidos conferem a agenda no COMMIT.
  const confirmada = async (cfg: string, inicio: string, fim: string) => {
    await a.query("BEGIN");
    try {
      const f = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
            categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
          SELECT $1::date, $2::time, $3::time, $4::uuid, $5::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
                 'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $6::uuid RETURNING fechamentos.id`,
        [D, inicio, fim, cfg, c.empresa, c.pacote]);
      await a.query(`UPDATE fechamentos SET status = 'CONFIRMADO' WHERE id = $1::uuid`, [f]);
      await a.query("COMMIT");
      return f;
    } catch (error) {
      await a.query("ROLLBACK");
      throw error;
    }
  };
  await confirmada(tarde, "15:00", "19:00");
  await assert.rejects(confirmada(tarde, "15:00", "19:00"), /Conflito/, "segunda festa no mesmo horário recusada apesar da capacidade 2");
  await confirmada(manha, "08:00", "11:00");
  assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int AS n FROM fechamentos WHERE empresa_id = $1::uuid AND status = 'CONFIRMADO'`, [c.empresa])).rows[0]!.n, 2);
});
