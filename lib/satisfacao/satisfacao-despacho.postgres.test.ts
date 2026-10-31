import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { carregarComBanco, cod, executor, fechamento, porTransacao, SENHA_FALSA } from "../marketing/harness-postgres.ts";
import { ativarRegraPesquisa, baseSintetica, contratoAssinadoMinimo, type CriarEnvio } from "./harness-postgres.ts";
import { lerAnel, type AnelChaves } from "./token.ts";

/**
 * Pesquisa de satisfação (110, PS-2): criação pelo motor e despacho por entrega, no PostgreSQL descartável, modelo 110,
 * dados COMMITADOS e transportes SIMULADOS (caixas de saída locais). Prova, do plano rev. 6 (tabela de testes da PS-2):
 *   motor   — PESQUISA_CRIADA com as entregas INICIAL; idempotência do ciclo; desligada não planeja; contato pós-festa
 *             anterior e frequência suprimem a criação; a Mensagem simples é suprimida quando a festa já tem pesquisa;
 *             precedência da regra da unidade sobre a da empresa (planejamento e revalidação); janela de 14 dias;
 *   despacho— e-mail com o marcador no lugar do link (o token não é gravado); consentimento por canal revalidado a cada
 *             tentativa (descadastro, saída das pesquisas, sem e-mail, autorização revogada); frequência só na INICIAL e
 *             o lembrete isento; falha parcial; TEMPORARIO até o máximo; DESCONHECIDO → INCERTA; queda depois do envio
 *             → posse vencida → INCERTA sem reenvio; dois workers (barreira na trava por cliente): uma única saída;
 *             fronteiras de 30 dias (24 h), 48 h do segundo canal, 3 dias do lembrete, janela e fim de semana, atraso;
 *             festa cancelada revoga; pais ocupados não consomem tentativa; sem segredo do link a entrega espera;
 *             resposta cancela o lembrete; troca de ação e pausa suprimem; nenhuma chamada de rede.
 */
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${"x".repeat(24)}`;
const anel = lerAnel({ SATISFACAO_LINK_CHAVES: `1:${randomBytes(32).toString("base64")}`, SATISFACAO_LINK_CHAVE_ATUAL: "1" }) as AnelChaves;
const ORIGEM = "http://127.0.0.1:3000";
const DIA = 86_400_000;

type Banco = { transacao<T>(w: (tx: DbExecutor) => Promise<T>): Promise<T> };
type Resultado = { desligada: boolean; incertas: number; processadas: number; resultados: Record<string, number> };
type Despacho = {
  executarEntregas(b: Banco, ctx: unknown, agora: Date, o: unknown): Promise<Resultado>;
  despacharEntrega(b: Banco, ctx: unknown, id: string, agora?: Date): Promise<string>;
  aplicarRetornoEntrega(tx: DbExecutor, id: string, s: string, d: string | null): Promise<string>;
  recuperarPossesEntregas(b: Banco, agora: Date, empresaId: string | null, repeticao?: unknown): Promise<number>;
};
type Motor = {
  executarCiclo(b: Banco, t: unknown, agora: Date, o?: unknown): Promise<{ planejamento: { criadas: number }; resultados: Record<string, number>; entregas: Resultado | null }>;
  simularEmpresa(tx: DbExecutor, e: string, regra: unknown, agora: Date): Promise<{ alvos: Array<{ alvoId: string; impedimento: string | null }>; total: number }>;
  aplicarRetorno(tx: DbExecutor, id: string, s: string, d: string | null): Promise<string>;
};
type Regras = { regraDaEmpresa(tx: DbExecutor, e: string, id: string): Promise<unknown>; pausarRegra(tx: DbExecutor, e: string, u: string, id: string): Promise<unknown> };
type Pref = { alterarPreferencia(tx: DbExecutor, e: string, u: string, i: unknown): Promise<unknown> };
type Transp = { transportesSimulados(c: () => DbExecutor): Transportes; transportesDoAmbiente(c: () => DbExecutor, env: Record<string, string>): unknown };
type Transportes = { enviarWhatsapp(m: unknown): Promise<{ provedorMensagemId: string }>; enviarEmail(m: unknown): Promise<{ provedorMensagemId: string }> };
type TranspMarketing = { transporteSimulado(c: () => DbExecutor): unknown };
type Publico = { responderPesquisa(corpo: unknown, ctx: { ip: string | null }, deps: unknown): Promise<Record<string, unknown>> };
type Envios = { criarEnvio: CriarEnvio };

const identidade = async (db: Client) => (await db.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
  VALUES ($1, 'Gestão sintética', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`, [`${cod("u")}@pesquisa.test`, SENHA_FALSA])).rows[0].id;
const pid = async (c: Client) => Number((await c.query(`SELECT pg_backend_pid() AS p`)).rows[0].p);

async function esperarBloqueio(obs: Client, alvos: number[], bloqueador: number, trecho: string) {
  for (let i = 0; i < 400; i++) {
    await obs.query(`SELECT pg_stat_clear_snapshot()`);
    const r = (await obs.query(`SELECT count(*)::int AS n FROM pg_stat_activity a WHERE a.pid = ANY($1::int[]) AND $2::int = ANY(pg_blocking_pids(a.pid)) AND a.query LIKE '%' || $3 || '%'`,
      [alvos, bloqueador, trecho])).rows[0];
    if (r.n === alvos.length) return;
    await new Promise((fim) => setTimeout(fim, 10));
  }
  throw new Error(`backends ${alvos.join("/")} não ficaram bloqueados por ${bloqueador} em "${trecho}"`);
}

/** Próximo sábado às 12:00 de Brasília (15:00Z), a partir de amanhã. */
function proximoSabadoMeioDia() {
  const d = new Date(Date.now() + DIA);
  while (d.getUTCDay() !== 6) d.setTime(d.getTime() + DIA);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 0, 0));
}
const hojeSp = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const diasAtras = (n: number) => new Date(Date.parse(`${hojeSp()}T12:00:00Z`) - n * DIA).toISOString().slice(0, 10);

test("110 PS-2: criação pelo motor e despacho das entregas", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c1 = await conectarDescartavel();
  const c2 = await conectarDescartavel({ travar: false });
  const c3 = await conectarDescartavel({ travar: false });
  // Nenhuma rede: qualquer chamada HTTP/HTTPS durante a suíte é contada (e recusada).
  let chamadasDeRede = 0;
  const originais = { fetch: globalThis.fetch, httpReq: http.request, httpsReq: https.request };
  globalThis.fetch = (async () => { chamadasDeRede++; throw new Error("rede recusada na suíte"); }) as typeof fetch;
  (http as { request: unknown }).request = () => { chamadasDeRede++; throw new Error("rede recusada na suíte"); };
  (https as { request: unknown }).request = () => { chamadasDeRede++; throw new Error("rede recusada na suíte"); };
  try {
    const carregar = <T>(c: Client, f: string, cache: Map<unknown, unknown>) => carregarComBanco(f, c, () => null, {}, cache) as unknown as T;
    const m1 = new Map(), m2 = new Map(), m3 = new Map();
    const desp1 = carregar<Despacho>(c1, "lib/satisfacao/despacho.ts", m1), desp2 = carregar<Despacho>(c2, "lib/satisfacao/despacho.ts", m2);
    const motor = carregar<Motor>(c1, "lib/marketing/automacoes/motor.ts", m1);
    const regras = carregar<Regras>(c3, "lib/marketing/automacoes/regras.ts", m3);
    const pref = carregar<Pref>(c3, "lib/marketing/automacoes/preferencias.ts", m3);
    const tp1 = carregar<Transp>(c1, "lib/satisfacao/transporte.ts", m1), tp2 = carregar<Transp>(c2, "lib/satisfacao/transporte.ts", m2);
    const tm1 = carregar<TranspMarketing>(c1, "lib/marketing/automacoes/transporte.ts", m1);
    const publico = carregar<Publico>(c3, "lib/satisfacao/publico.ts", m3);
    const envios = carregar<Envios>(c3, "lib/satisfacao/envios.ts", m3);
    const { A, usuario, regraA, festa, emTransacao, execucao, envioPronto, envioNoPassado, cancelarFesta } = await baseSintetica(c3, anel, envios.criarEnvio, identidade);
    await ativarRegraPesquisa(c3, regraA);

    const banco1: Banco = { transacao: porTransacao(c1) }, banco2: Banco = { transacao: porTransacao(c2) };
    const ctx = (c: Client, tp: Transp, extra: Record<string, unknown> = {}) =>
      ({ habilitada: true, anel, origem: ORIGEM, transportes: tp.transportesSimulados(() => executor(c)), repeticao: { esperar: async () => {} }, ...extra });
    const ctx1 = ctx(c1, tp1), ctx2 = ctx(c2, tp2);
    const um = async (sql: string, v: unknown[] = []) => (await c3.query(sql, v)).rows[0];
    const n = async (sql: string, v: unknown[] = []) => Number((await um(sql, v)).n);
    /** Entregas do envio como CANAL/ETAPA:ESTADO:motivo, em ordem fixa. */
    const entregas = async (envio: string) => (await c3.query(`SELECT canal, etapa, estado, motivo FROM satisfacao_entregas WHERE envio_id = $1::uuid ORDER BY etapa, canal`, [envio])).rows
      .map((x) => `${x.canal}/${x.etapa}:${x.estado}:${String(x.motivo ?? "-").split(":")[0]}`);
    const entrega = async (envio: string, canal: string, etapa = "INICIAL") =>
      um(`SELECT id::text, estado, motivo, tentativas, agendada_para, proxima_tentativa_em, conteudo, destinatario_mascarado FROM satisfacao_entregas WHERE envio_id = $1::uuid AND canal = $2 AND etapa = $3`, [envio, canal, etapa]);
    const autorizar = (cl: string, tel: string) => emTransacao((tx) => pref.alterarPreferencia(tx, A, usuario, { acao: "preferencia", clienteId: cl, operacao: "autorizar", destino: tel, confirmacao: "Autorizou (sintético)" }));
    /** Despacha só as entregas deste envio (os subtestes não interferem uns nos outros). */
    // Instante 1 s à frente: fixtures gravam agendada_para com o now() do banco, que pode passar alguns ms do relógio do Node.
    const despachar = async (envio: string, agora = new Date(Date.now() + 1000), d = desp1, b = banco1, cx: unknown = ctx1) => {
      const ids = (await c3.query(`SELECT id::text FROM satisfacao_entregas WHERE envio_id = $1::uuid AND estado = 'PENDENTE' ORDER BY etapa, canal`, [envio])).rows.map((x) => x.id);
      const r: string[] = [];
      for (const id of ids) r.push(await d.despacharEntrega(b, cx, id, agora));
      return r;
    };
    const pronto = async (opcoes: { autorizado?: boolean; email?: string | null; telefone?: string; clienteId?: string } = {}) => {
      const p = await envioPronto({ telefone: opcoes.telefone, clienteId: opcoes.clienteId });
      if (opcoes.autorizado !== false && !opcoes.clienteId) await autorizar(p.cl, p.telefone);
      if (opcoes.email !== undefined) await emTransacao(() => c3.query(`UPDATE clientes SET email = $2 WHERE id = $1::uuid`, [p.cl, opcoes.email]));
      return p;
    };
    let tel = 0;
    const numero = (fim = "") => `5511977${String(100000 + ++tel).slice(0, 6 - fim.length)}${fim}`;

    // Festas recentes (dentro da janela de 14 dias do Pós-festa com espera 1) numa agenda própria.
    // A empresa já tem o pacote COMPLETA (baseSintetica): só uma agenda nova para as festas recentes.
    const baseRecente = await emTransacao(async () => {
      const r = await c3.query(`SELECT p.id::text AS pacote, t.id::text AS tabela, pp.id::text AS preco FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id
        JOIN tabelas_preco t ON t.id = pp.tabela_preco_id WHERE p.empresa_id = $1::uuid LIMIT 1`, [A]);
      const agenda = (await c3.query(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda recente', '10:00', '18:00', 8) RETURNING id::text AS id`, [cod("ag")])).rows[0].id as string;
      return { ...r.rows[0], agenda } as { pacote: string; tabela: string; preco: string; agenda: string };
    });
    let recente = 1;
    async function festaRecente(opcoes: { dias?: number; estabelecimento?: string | null; clienteId?: string; telefone?: string } = {}) {
      const dias = opcoes.dias ?? ++recente;
      const data = diasAtras(dias);
      const telefone = opcoes.telefone ?? numero();
      const r = await emTransacao(async () => {
        const cl = opcoes.clienteId ?? (await c3.query(`INSERT INTO clientes (empresa_id, nome_completo, telefone, whatsapp, email) VALUES ($1::uuid, 'Paula Recente Sintética', $2, $2, $3) RETURNING id::text AS id`,
          [A, telefone, `${cod("r")}@pesquisa.test`])).rows[0].id as string;
        const f = await fechamento(c3, A, baseRecente, cl, { data, status: "AGUARDANDO_PAGAMENTO" });
        if (opcoes.estabelecimento) await c3.query(`UPDATE fechamentos SET estabelecimento_id = $2::uuid WHERE id = $1::uuid AND estabelecimento_id IS NULL`, [f, opcoes.estabelecimento]);
        return { cl, f };
      });
      await emTransacao(() => contratoAssinadoMinimo(c3, r.f));
      return { ...r, telefone, data };
    }
    // Instante 1 s à frente pelo mesmo motivo de `despachar` (agendada_para vem do relógio do banco).
    // O relógio das tentativas vai junto (+1 s): o despacho lê o próprio relógio, não o instante do ciclo (P2-2).
    const ctxCiclo = { ...ctx1, relogio: () => new Date(Date.now() + 1000) };
    const ciclo = (agora = new Date(Date.now() + 1000), pesquisa: unknown = ctxCiclo) => motor.executarCiclo(banco1, tm1.transporteSimulado(() => executor(c1)), agora, { empresaId: A, pesquisa });
    const execucoesDe = async (f: string) => (await c3.query(`SELECT acao, estado, motivo, regra_id::text FROM marketing_automacao_execucoes WHERE fechamento_id = $1::uuid ORDER BY criado_em`, [f])).rows;
    const envioDe = async (f: string) => (await um(`SELECT id::text FROM satisfacao_envios WHERE fechamento_id = $1::uuid`, [f]))?.id as string | undefined;
    const caixaEmail = (entregaId: string) => n(`SELECT count(*) AS n FROM satisfacao_email_simulado WHERE entrega_id = $1::uuid`, [entregaId]);

    await t.test("M1 desligada: o ciclo não planeja a pesquisa; ligada: cria o envio (PESQUISA_CRIADA) e já despacha; repetir não duplica", async () => {
      const r = await festaRecente();
      await autorizar(r.cl, r.telefone);
      await ciclo(new Date(), null);
      assert.deepEqual(await execucoesDe(r.f), [], "sem contexto da pesquisa: nada planejado");
      const c = await ciclo();
      assert.deepEqual((await execucoesDe(r.f)).map((x) => `${x.acao}:${x.estado}`), ["PESQUISA_SATISFACAO:PESQUISA_CRIADA"]);
      const envio = (await envioDe(r.f))!;
      assert.ok(envio, "envio criado pelo motor");
      assert.equal(c.entregas?.desligada, false);
      assert.deepEqual(await entregas(envio), ["EMAIL/INICIAL:ACEITA:-", "WHATSAPP/INICIAL:ACEITA:-", "EMAIL/LEMBRETE:PENDENTE:-", "WHATSAPP/LEMBRETE:PENDENTE:-"]);
      const contato = await um(`SELECT contato_em IS NOT NULL AS ok FROM satisfacao_envios WHERE id = $1::uuid`, [envio]);
      assert.equal(contato.ok, true, "marco de contato gravado pelo gatilho no primeiro aceite");
      await ciclo();
      assert.equal(await n(`SELECT count(*) AS n FROM satisfacao_envios WHERE fechamento_id = $1::uuid`, [r.f]), 1, "uma pesquisa por festa");
      assert.equal(await n(`SELECT count(*) AS n FROM satisfacao_entregas WHERE envio_id = $1::uuid`, [envio]), 4, "nada novo no segundo ciclo");
    });

    await t.test("D1 conteúdo: o link nunca é gravado (marcador no lugar); e-mail com 11 notas pré-marcadas só na versão enviada", async () => {
      const p = await pronto();
      let enviado = "";
      const espiao = { ...ctx1, transportes: { ...ctx1.transportes, enviarEmail: async (m: { html: string; texto: string }) => { enviado = m.html; return ctx1.transportes.enviarEmail(m); } } };
      await despachar(p.envio, new Date(), desp1, banco1, espiao);
      for (let nota = 0; nota <= 10; nota++) assert.ok(enviado.includes(`/p/satisfacao#${p.token}.n${nota}"`), `nota ${nota} pré-marcada no e-mail enviado`);
      const gravado = await um(`SELECT string_agg(texto, ' ') AS t FROM satisfacao_email_simulado s JOIN satisfacao_entregas d ON d.id = s.entrega_id WHERE d.envio_id = $1::uuid`, [p.envio]);
      const conteudos = (await c3.query(`SELECT conteudo FROM satisfacao_entregas WHERE envio_id = $1::uuid`, [p.envio])).rows.map((x) => String(x.conteudo ?? "")).join(" ");
      const whats = (await um(`SELECT string_agg(texto, ' ') AS t FROM marketing_transporte_simulado WHERE empresa_id = $1::uuid`, [A])).t as string;
      for (const texto of [gravado.t as string, conteudos, whats]) {
        assert.ok(!texto.includes(p.token) && !texto.includes("/p/satisfacao#"), "nenhum token gravado");
      }
      assert.ok(String(gravado.t).includes("[link da pesquisa]") && conteudos.includes("[link da pesquisa]"));
      assert.equal(chamadasDeRede, 0);
    });

    await t.test("D2 consentimento por canal revalidado no despacho: descadastro, saída das pesquisas, sem e-mail, autorização revogada", async () => {
      // Descadastro e revogação ANTES da pesquisa (criada depois, nasce PENDENTE): quem barra é a revalidação do despacho.
      const d0 = await pronto();
      await emTransacao((tx) => pref.alterarPreferencia(tx, A, usuario, { acao: "preferencia", clienteId: d0.cl, operacao: "descadastrar", confirmacao: "Pediu (sintético)" }));
      const descad = await pronto({ clienteId: d0.cl });
      assert.deepEqual(await entregas(descad.envio), ["EMAIL/INICIAL:PENDENTE:-", "WHATSAPP/INICIAL:PENDENTE:-"]);
      const saida = await pronto();
      await emTransacao(() => c3.query(`INSERT INTO satisfacao_saidas (empresa_id, cliente_id, origem) VALUES ($1::uuid, $2::uuid, 'EQUIPE')`, [A, saida.cl]));
      const semEmail = await pronto({ email: null });
      // Sem pesquisa anterior do cliente (uma pesquisa pendente conta como contato e a frequência barraria).
      const f0 = await festa({ telefone: numero() });
      await autorizar(f0.cl, f0.telefone);
      const r0 = { cl: f0.cl };
      const aut = await um(`SELECT id::text FROM marketing_contato_autorizacoes WHERE cliente_id = $1::uuid AND estado = 'CONFIRMADA'`, [r0.cl]);
      await emTransacao((tx) => pref.alterarPreferencia(tx, A, usuario, { acao: "preferencia", clienteId: r0.cl, operacao: "revogar", autorizacaoId: aut.id, confirmacao: "Revogou (sintético)" }));
      const revogado = await pronto({ clienteId: r0.cl });
      for (const p of [descad, saida, semEmail, revogado]) await despachar(p.envio);
      assert.deepEqual(await entregas(descad.envio), ["EMAIL/INICIAL:SUPRIMIDA:DESCADASTRADO", "WHATSAPP/INICIAL:SUPRIMIDA:DESCADASTRADO"]);
      assert.deepEqual(await entregas(saida.envio), ["EMAIL/INICIAL:SUPRIMIDA:SAIDA_PESQUISAS", "WHATSAPP/INICIAL:SUPRIMIDA:SAIDA_PESQUISAS"]);
      assert.deepEqual(await entregas(semEmail.envio), ["EMAIL/INICIAL:SUPRIMIDA:SEM_EMAIL", "WHATSAPP/INICIAL:ACEITA:-", "WHATSAPP/LEMBRETE:PENDENTE:-"]);
      assert.deepEqual(await entregas(revogado.envio), ["EMAIL/INICIAL:ACEITA:-", "WHATSAPP/INICIAL:SUPRIMIDA:SEM_AUTORIZACAO", "EMAIL/LEMBRETE:PENDENTE:-"],
        "lembrete só no canal aceito");
    });

    await t.test("D3 frequência: INICIAL de outra pesquisa do cliente é suprimida; o próprio envio (segundo canal) e o lembrete não", async () => {
      const p = await pronto();
      await despachar(p.envio); // contato agora
      const outra = await pronto({ clienteId: p.cl });
      await despachar(outra.envio);
      assert.deepEqual(await entregas(outra.envio), ["EMAIL/INICIAL:SUPRIMIDA:LIMITE_FREQUENCIA", "WHATSAPP/INICIAL:SUPRIMIDA:LIMITE_FREQUENCIA"]);
      // Lembrete devido do primeiro envio, com o contato recente da própria pesquisa e de OUTRA mensagem automática (que,
      // numa INICIAL, daria LIMITE_FREQUENCIA): sai (exceção).
      const xm = await execucao(A, p.cl, outra.f, "MENSAGEM_WHATSAPP");
      await emTransacao(() => c3.query(`UPDATE marketing_automacao_execucoes SET estado = 'INCERTA', motivo = 'FIXTURE' WHERE id = $1::uuid`, [xm]));
      await emTransacao(() => c3.query(`UPDATE satisfacao_entregas SET agendada_para = now() - interval '1 minute' WHERE envio_id = $1::uuid AND etapa = 'LEMBRETE'`, [p.envio]));
      await despachar(p.envio);
      assert.deepEqual(await entregas(p.envio), ["EMAIL/INICIAL:ACEITA:-", "WHATSAPP/INICIAL:ACEITA:-", "EMAIL/LEMBRETE:ACEITA:-", "WHATSAPP/LEMBRETE:ACEITA:-"]);
      // Um único lembrete por canal: um novo aceite de INICIAL não cria outro.
      assert.equal(await n(`SELECT count(*) AS n FROM satisfacao_entregas WHERE envio_id = $1::uuid AND etapa = 'LEMBRETE'`, [p.envio]), 2);
      // E o banco recusa um segundo lembrete do mesmo canal, venha de onde vier (UNIQUE envio, canal, etapa).
      await assert.rejects(emTransacao(() => c3.query(`INSERT INTO satisfacao_entregas (empresa_id, envio_id, canal, etapa, agendada_para, max_tentativas)
        VALUES ($1::uuid, $2::uuid, 'EMAIL', 'LEMBRETE', now(), 3)`, [A, p.envio])), (e: { code?: string }) => e.code === "23505", "lembrete duplicado recusado");
    });

    await t.test("D4 falha parcial e classificação: WhatsApp recusado FALHOU, e-mail ACEITA; TEMPORARIO até o máximo; DESCONHECIDO → INCERTA", async () => {
      const recusado = await pronto({ telefone: numero("0000") });
      await despachar(recusado.envio);
      assert.deepEqual(await entregas(recusado.envio), ["EMAIL/INICIAL:ACEITA:-", "WHATSAPP/INICIAL:FALHOU:RECUSADO", "EMAIL/LEMBRETE:PENDENTE:-"]);
      const temp = await pronto({ email: `${cod("t")}@temporario.test`, autorizado: false });
      const agora = Date.now();
      await despachar(temp.envio, new Date(agora));
      let e = await entrega(temp.envio, "EMAIL");
      assert.equal(e.estado, "PENDENTE"); assert.equal(e.tentativas, 1); assert.ok(e.proxima_tentativa_em);
      assert.equal(await desp1.despacharEntrega(banco1, ctx1, e.id, new Date(agora + 1000)), "IGNORADA", "não é devida antes da espera");
      await desp1.despacharEntrega(banco1, ctx1, e.id, new Date(agora + 3600_000));
      await desp1.despacharEntrega(banco1, ctx1, e.id, new Date(agora + 7200_000));
      e = await entrega(temp.envio, "EMAIL");
      assert.equal(e.estado, "FALHOU"); assert.equal(e.tentativas, 3, "máximo de tentativas da regra");
      const incerto = await pronto({ email: `${cod("i")}@incerto.test`, autorizado: false });
      await despachar(incerto.envio);
      assert.equal((await entrega(incerto.envio, "EMAIL")).estado, "INCERTA");
      assert.equal(await despachar(incerto.envio).then((r) => r.length), 0, "INCERTA nunca é reenviada");
      assert.equal((await um(`SELECT contato_em IS NOT NULL AS ok FROM satisfacao_envios WHERE id = $1::uuid`, [incerto.envio])).ok, true, "INCERTA também marca o contato");
    });

    await t.test("D5 queda depois de enviar o WhatsApp (reinício entre canais): posse vencida → INCERTA, sem reenvio; o e-mail segue no reinício", async () => {
      const p = await pronto();
      let caiu = false;
      const queda: Banco = { transacao: async (w) => { if (caiu) throw new Error("QUEDA_SIMULADA"); return porTransacao(c1)(w); } };
      const transportes = { ...ctx1.transportes,
        enviarWhatsapp: async (m: unknown) => { const r = await ctx1.transportes.enviarWhatsapp(m); caiu = true; return r; },
        enviarEmail: async () => { throw new Error("o e-mail não deveria sair antes da queda"); } };
      const whatsId = (await entrega(p.envio, "WHATSAPP")).id;
      await assert.rejects(desp1.despacharEntrega(queda, { ...ctx1, transportes }, whatsId, new Date()), /QUEDA_SIMULADA/);
      assert.equal((await entrega(p.envio, "WHATSAPP")).estado, "ENVIANDO", "ENVIANDO foi confirmado antes da rede");
      const antes = await n(`SELECT count(*) AS n FROM marketing_transporte_simulado WHERE empresa_id = $1::uuid`, [A]);
      // Reinício 6 minutos depois: a posse venceu.
      const r = await desp1.executarEntregas(banco1, ctx1, new Date(Date.now() + 6 * 60_000), { empresaId: A, limite: 500 });
      assert.ok(r.incertas >= 1);
      const w = await entrega(p.envio, "WHATSAPP");
      assert.equal(w.estado, "INCERTA"); assert.equal(w.motivo, "POSSE_VENCIDA_DURANTE_ENVIO");
      assert.equal(await n(`SELECT count(*) AS n FROM marketing_transporte_simulado WHERE empresa_id = $1::uuid`, [A]), antes, "nenhum reenvio do WhatsApp");
      assert.equal((await entrega(p.envio, "EMAIL")).estado, "ACEITA", "o outro canal saiu no reinício");

      // Envio lento: a posse vence e é recuperada (INCERTA) DURANTE a chamada; a conclusão tardia não vira ACEITA.
      const lento = await pronto();
      const emailId = (await entrega(lento.envio, "EMAIL")).id;
      const tardio = { ...ctx1.transportes, enviarEmail: async (m: unknown) => {
        await desp1.recuperarPossesEntregas({ transacao: emTransacao }, new Date(Date.now() + 6 * 60_000), A);
        return ctx1.transportes.enviarEmail(m);
      } };
      assert.equal(await desp1.despacharEntrega(banco1, { ...ctx1, transportes: tardio }, emailId, new Date(Date.now() + 1000)), "POSSE_PERDIDA");
      const e = await entrega(lento.envio, "EMAIL");
      assert.equal(e.estado, "INCERTA"); assert.equal(e.motivo, "POSSE_VENCIDA_DURANTE_ENVIO");
      assert.equal(await n(`SELECT count(*) AS n FROM satisfacao_entregas WHERE envio_id = $1::uuid AND etapa = 'LEMBRETE'`, [lento.envio]), 0, "sem aceite, sem lembrete");
    });

    await t.test("D6 dois workers na mesma entrega (barreira na trava por cliente): uma única saída", async () => {
      const p = await pronto({ autorizado: false });
      const id = (await entrega(p.envio, "EMAIL")).id;
      await c3.query("BEGIN");
      await c3.query(`SELECT pg_advisory_xact_lock(hashtext('marketing:' || $1 || ':' || $2))`, [A, p.cl]);
      const w1 = desp1.despacharEntrega(banco1, ctx1, id, new Date()), w2 = desp2.despacharEntrega(banco2, ctx2, id, new Date());
      await esperarBloqueio(c3, [await pid(c1), await pid(c2)], await pid(c3), "pg_advisory_xact_lock");
      await c3.query("COMMIT");
      const resultados = (await Promise.all([w1, w2])).sort();
      assert.deepEqual(resultados, ["ACEITA", "IGNORADA"]);
      assert.equal(await caixaEmail(id), 1, "um único e-mail na caixa de saída");
    });

    await t.test("D7 dois ciclos completos em paralelo: cada entrega sai uma vez", async () => {
      const lote = [];
      for (let i = 0; i < 6; i++) lote.push(await pronto());
      const [r1, r2] = await Promise.all([
        desp1.executarEntregas(banco1, ctx1, new Date(), { empresaId: A, limite: 500 }),
        desp2.executarEntregas(banco2, ctx2, new Date(), { empresaId: A, limite: 500 }),
      ]);
      assert.ok((r1.resultados.ACEITA ?? 0) + (r2.resultados.ACEITA ?? 0) >= 12);
      for (const p of lote) {
        assert.deepEqual((await entregas(p.envio)).slice(0, 2), ["EMAIL/INICIAL:ACEITA:-", "WHATSAPP/INICIAL:ACEITA:-"]);
        const e = await entrega(p.envio, "EMAIL");
        assert.equal(await caixaEmail(e.id), 1);
      }
      assert.equal(await n(`SELECT count(*) AS n FROM (SELECT idempotencia FROM marketing_transporte_simulado GROUP BY idempotencia HAVING count(*) > 1) x`), 0);
    });

    await t.test("D8 prazos: 24 h antes de expirar, vencido, 48 h do segundo canal, atraso do lembrete", async () => {
      const quase = await envioNoPassado(29.5);
      await despachar(quase.envio);
      assert.deepEqual(await entregas(quase.envio), ["EMAIL/INICIAL:SUPRIMIDA:PRAZO_ESGOTADO", "WHATSAPP/INICIAL:SUPRIMIDA:PRAZO_ESGOTADO"]);
      const ainda = await envioNoPassado(28.9);
      await despachar(ainda.envio);
      assert.equal((await entrega(ainda.envio, "EMAIL")).estado, "ACEITA", "mais de 24 h antes de expirar: sai");
      const vencido = await envioNoPassado(30.2);
      const rv = await despachar(vencido.envio);
      assert.deepEqual(rv, ["CANCELADA", "IGNORADA"], `retorno do vencido: ${JSON.stringify(rv)}`);
      assert.deepEqual(await entregas(vencido.envio), ["EMAIL/INICIAL:CANCELADA:EXPIRADO", "WHATSAPP/INICIAL:CANCELADA:EXPIRADO"]);
      assert.equal((await um(`SELECT estado FROM satisfacao_envios WHERE id = $1::uuid`, [vencido.envio])).estado, "EXPIRADO");
      const segundo = await envioNoPassado(3);
      await emTransacao(() => c3.query(`UPDATE satisfacao_envios SET contato_em = now() - interval '49 hours' WHERE id = $1::uuid`, [segundo.envio]));
      await despachar(segundo.envio);
      assert.deepEqual(await entregas(segundo.envio), ["EMAIL/INICIAL:SUPRIMIDA:SEGUNDO_CANAL_FORA_DO_PRAZO", "WHATSAPP/INICIAL:SUPRIMIDA:SEGUNDO_CANAL_FORA_DO_PRAZO"]);
      // Lembrete atrasado (motor parado) num envio de 10 dias: sai; num envio de 29,2 dias: PRAZO_ESGOTADO.
      for (const [dias, esperado] of [[10, "ACEITA"], [29.2, "SUPRIMIDA"]] as const) {
        const e = await envioNoPassado(dias);
        await emTransacao(() => c3.query(`INSERT INTO satisfacao_entregas (empresa_id, envio_id, canal, etapa, agendada_para, max_tentativas) VALUES ($1::uuid, $2::uuid, 'EMAIL', 'LEMBRETE', now() - interval '5 days', 3)`, [A, e.envio]));
        await emTransacao(() => c3.query(`UPDATE satisfacao_entregas SET estado = 'CANCELADA', motivo = 'FIXTURE', concluida_em = now() WHERE envio_id = $1::uuid AND etapa = 'INICIAL'`, [e.envio]));
        await despachar(e.envio);
        assert.equal((await entrega(e.envio, "EMAIL", "LEMBRETE")).estado, esperado, `lembrete atrasado em envio de ${dias} dias`);
      }
    });

    await t.test("D9 lembrete 3 dias depois do primeiro aceite; janela e fim de semana; resposta cancela o lembrete", async () => {
      const p = await pronto({ autorizado: false });
      const antes = Date.now();
      await despachar(p.envio, new Date(antes));
      const l = await entrega(p.envio, "EMAIL", "LEMBRETE");
      const delta = new Date(l.agendada_para).getTime() - antes;
      assert.ok(delta >= 3 * DIA - 60_000 && delta <= 3 * DIA + 60_000, `lembrete em 3 dias (delta ${delta})`);
      assert.deepEqual(await despachar(p.envio, new Date(antes + 2 * DIA)), ["IGNORADA"], "ainda não devido");
      // Fora da janela (sábado com fim de semana desligado): a entrega vai para segunda 09:00 de Brasília.
      await ativarRegraPesquisa(c3, regraA, { janelaInicio: "09:00", janelaFim: "18:00", fimDeSemana: false });
      try {
        const sabado = proximoSabadoMeioDia();
        const q = await pronto({ autorizado: false });
        assert.deepEqual(await despachar(q.envio, sabado), ["REAGENDADA", "REAGENDADA"]);
        const r = await entrega(q.envio, "EMAIL");
        assert.equal(new Date(r.agendada_para).toISOString(), new Date(sabado.getTime() + 2 * DIA - 3 * 3600_000).toISOString(), "segunda 09:00 (12:00Z)");
      } finally {
        await ativarRegraPesquisa(c3, regraA);
      }
      // Resposta: o lembrete pendente é cancelado e nunca sai.
      await publico.responderPesquisa({ token: p.token, notaIndicacao: 9 }, { ip: "203.0.113.90" },
        { withTransaction: porTransacao(c3), anel: () => anel, repeticao: { esperar: async () => {} } });
      assert.equal((await entrega(p.envio, "EMAIL", "LEMBRETE")).estado, "CANCELADA", "a resposta cancela o lembrete pendente");
      assert.deepEqual(await despachar(p.envio, new Date(antes + 4 * DIA)), []);
    });

    await t.test("D10 festa cancelada revoga; pais ocupados não consomem tentativa; sem segredo do link a entrega espera", async () => {
      const cancelada = await pronto();
      await cancelarFesta(cancelada.f);
      await despachar(cancelada.envio);
      assert.deepEqual(await entregas(cancelada.envio), ["EMAIL/INICIAL:CANCELADA:FESTA_CANCELADA", "WHATSAPP/INICIAL:CANCELADA:FESTA_CANCELADA"]);
      assert.equal((await um(`SELECT estado, motivo_revogacao FROM satisfacao_envios WHERE id = $1::uuid`, [cancelada.envio])).motivo_revogacao, "FESTA_CANCELADA");
      const ocupada = await pronto({ autorizado: false });
      const id = (await entrega(ocupada.envio, "EMAIL")).id;
      await c3.query("BEGIN");
      await c3.query(`SELECT 1 FROM fechamentos WHERE id = $1::uuid FOR UPDATE`, [ocupada.f]);
      try {
        assert.equal(await desp1.despacharEntrega(banco1, ctx1, id, new Date()), "AGUARDANDO_TRAVA");
      } finally {
        await c3.query("ROLLBACK");
      }
      const e = await entrega(ocupada.envio, "EMAIL");
      assert.equal(e.estado, "PENDENTE"); assert.equal(e.tentativas, 0);
      const semLink = await pronto({ autorizado: false });
      const sid = (await entrega(semLink.envio, "EMAIL")).id;
      assert.equal(await desp1.despacharEntrega(banco1, { ...ctx1, anel: null }, sid, new Date()), "ADIADA");
      const s = await entrega(semLink.envio, "EMAIL");
      assert.equal(s.estado, "PENDENTE"); assert.equal(s.motivo, "LINK_NAO_CONFIGURADO"); assert.equal(s.tentativas, 0);
    });

    await t.test("D11 retorno do provedor (WhatsApp da pesquisa) pela mesma porta do Marketing: ACEITA → ENTREGUE, repetição ignorada", async () => {
      const p = await pronto();
      await despachar(p.envio);
      const w = await um(`SELECT provedor_mensagem_id AS id FROM satisfacao_entregas WHERE envio_id = $1::uuid AND canal = 'WHATSAPP' AND etapa = 'INICIAL'`, [p.envio]);
      assert.equal(await emTransacao((tx) => motor.aplicarRetorno(tx, w.id, "ENTREGUE", null)), "ENTREGUE");
      assert.equal(await emTransacao((tx) => motor.aplicarRetorno(tx, w.id, "FALHOU", "atrasado")), "IGNORADO");
      assert.equal((await entrega(p.envio, "WHATSAPP")).estado, "ENTREGUE");
    });

    // Unidade com regra própria ATIVA (Mensagem simples Pós-festa), para precedência e supressão recíproca.
    // Duas unidades habilitadas na agenda (com uma só, o INSERT de toda festa nova cairia nela automaticamente — 062).
    const [unidade] = await emTransacao(async () => {
      const ids: string[] = [];
      for (const nome of ["Unidade Pesquisa", "Unidade Pesquisa 2"]) {
        const u = (await c3.query(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, $3, 'SUSPENSO') RETURNING id::text AS id`, [A, cod("u"), nome])).rows[0].id as string;
        await c3.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'REPRESENTANTE_AUTORIZADO', 'Pesquisa PS-2 sintética')`, [A, u, usuario]);
        ids.push(u);
      }
      return ids;
    });
    const regraUnidade = (await emTransacao(() => c3.query(`INSERT INTO marketing_automacao_regras (empresa_id, estabelecimento_id, tipo, acao, espera_dias, janela_inicio, janela_fim, fim_de_semana,
        template_texto, template_provedor, template_revisado_em, status, ativada_em, criado_por, atualizado_por)
      VALUES ($1::uuid, $2::uuid, 'POS_FESTA', 'MENSAGEM_WHATSAPP', 1, '00:00', '23:59', true, 'Olá {{nome}}! Obrigado pela festa. Responda PARAR para não receber mais.', 'pos_festa_v1', now(), 'RASCUNHO', NULL, $3::uuid, $3::uuid)
      RETURNING id::text AS id`, [A, unidade, usuario]))).rows[0].id as string;

    await t.test("M2 precedência: regra da empresa ignora a festa da unidade com regra ATIVA (planejamento e revalidação); a Mensagem simples é suprimida se a festa já tem pesquisa", async () => {
      const daUnidade = await festaRecente({ estabelecimento: unidade });
      await autorizar(daUnidade.cl, daUnidade.telefone);
      // Execução da regra da empresa planejada ANTES de a unidade ter regra ativa (revalidação), sem processar ainda.
      const regraEmpresa = () => emTransacao((tx) => regras.regraDaEmpresa(tx, A, regraA));
      const sim = await motor.simularEmpresa(executor(c3), A, await regraEmpresa(), new Date());
      assert.ok(sim.alvos.some((x) => x.alvoId === daUnidade.f), "sem regra da unidade: a regra da empresa vê a festa");
      const x = (await emTransacao(() => c3.query(`INSERT INTO marketing_automacao_execucoes (empresa_id, regra_id, regra_versao, acao, alvo_tipo, alvo_id, cliente_id, fechamento_id,
          chave_idempotencia, agendada_para, max_tentativas) VALUES ($1::uuid, $2::uuid, 1, 'PESQUISA_SATISFACAO', 'FECHAMENTO', $3::uuid, $4::uuid, $3::uuid, $5, clock_timestamp(), 3) RETURNING id::text AS id`,
        [A, regraA, daUnidade.f, daUnidade.cl, `${regraA}:PESQUISA_SATISFACAO:${daUnidade.f}:${daUnidade.data}`]))).rows[0].id as string;
      await emTransacao(() => c3.query(`UPDATE marketing_automacao_regras SET status = 'ATIVA', ativada_em = now() WHERE id = $1::uuid`, [regraUnidade]));
      const sim2 = await motor.simularEmpresa(executor(c3), A, await regraEmpresa(), new Date());
      assert.ok(!sim2.alvos.some((y) => y.alvoId === daUnidade.f), "com regra da unidade ATIVA: a da empresa ignora a festa");
      // A execução da empresa já agendada perde na revalidação; a da unidade (Mensagem) é planejada.
      await ciclo();
      const ex = await execucoesDe(daUnidade.f);
      assert.equal(ex.length, 2, "nenhuma execução nova da regra da empresa");
      assert.equal(ex.find((y) => y.regra_id === regraA)?.estado, "SUPRIMIDA", `execução ${x}`);
      assert.equal(ex.find((y) => y.regra_id === regraA)?.motivo, "ALVO_NAO_ELEGIVEL");
      assert.equal(ex.find((y) => y.regra_id === regraUnidade)?.estado, "ACEITA", "a regra da unidade agiu");
      assert.equal(await envioDe(daUnidade.f), undefined);

      // Recíproca: festa da unidade que JÁ tem pesquisa (criada antes) → a Mensagem simples é suprimida.
      const comPesquisa = await festaRecente({ estabelecimento: unidade });
      await autorizar(comPesquisa.cl, comPesquisa.telefone);
      const xp = await execucao(A, comPesquisa.cl, comPesquisa.f);
      await emTransacao((tx) => envios.criarEnvio(tx, anel, { empresaId: A, execucaoId: xp, canais: ["EMAIL"], agendadaPara: new Date(Date.now() + 3600_000), maxTentativas: 3 }));
      await ciclo();
      const ex2 = await execucoesDe(comPesquisa.f);
      const msg = ex2.find((y) => y.regra_id === regraUnidade);
      assert.equal(msg?.estado, "SUPRIMIDA"); assert.equal(msg?.motivo, "PESQUISA_JA_EXISTE");
      await emTransacao(() => c3.query(`UPDATE marketing_automacao_regras SET status = 'PAUSADA', pausada_em = now() WHERE id = $1::uuid`, [regraUnidade]));
    });

    await t.test("M3 criação suprimida: contato pós-festa anterior (Mensagem simples) e frequência; janela de 14 dias", async () => {
      // Festa da empresa (sem unidade) com Mensagem simples Pós-festa que já saiu (regra da unidade, mesmo tipo).
      const contato = await festaRecente();
      const xm = await execucao(A, contato.cl, contato.f, "MENSAGEM_WHATSAPP", regraUnidade);
      await emTransacao(() => c3.query(`UPDATE marketing_automacao_execucoes SET estado = 'INCERTA', motivo = 'FIXTURE', atualizado_em = now() - interval '60 days' WHERE id = $1::uuid`, [xm]));
      await ciclo();
      const p = (await execucoesDe(contato.f)).find((y) => y.acao === "PESQUISA_SATISFACAO");
      assert.equal(p?.estado, "SUPRIMIDA"); assert.equal(p?.motivo, "CONTATO_POS_FESTA_JA_FEITO");
      // Frequência: o cliente recebeu uma mensagem automática há 2 dias (outra festa).
      const freq = await festaRecente();
      const outra = await festaRecente({ clienteId: freq.cl, dias: 30 });
      const xo = await execucao(A, freq.cl, outra.f, "MENSAGEM_WHATSAPP", regraUnidade);
      await emTransacao(() => c3.query(`UPDATE marketing_automacao_execucoes SET estado = 'INCERTA', motivo = 'FIXTURE' WHERE id = $1::uuid`, [xo]));
      await ciclo();
      const pf = (await execucoesDe(freq.f)).find((y) => y.acao === "PESQUISA_SATISFACAO");
      assert.equal(pf?.estado, "SUPRIMIDA"); assert.equal(pf?.motivo, "LIMITE_FREQUENCIA");
      // Ordem das supressões (plano R5): festa cuja pesquisa JÁ saiu (contato recente) → PESQUISA_JA_EXISTE, não frequência.
      const dup = await festaRecente();
      const x1 = await execucao(A, dup.cl, dup.f);
      const criado = await emTransacao((tx) => envios.criarEnvio(tx, anel, { empresaId: A, execucaoId: x1, canais: ["EMAIL"], agendadaPara: new Date(), maxTentativas: 3 }));
      await despachar(criado.envioId!);
      // Segunda execução com a chave do planejador (a revalidação confere o alvo pela chave).
      const x2 = (await emTransacao(() => c3.query(`INSERT INTO marketing_automacao_execucoes (empresa_id, regra_id, regra_versao, acao, alvo_tipo, alvo_id, cliente_id, fechamento_id,
          chave_idempotencia, agendada_para, max_tentativas) VALUES ($1::uuid, $2::uuid, 1, 'PESQUISA_SATISFACAO', 'FECHAMENTO', $3::uuid, $4::uuid, $3::uuid, $5, clock_timestamp(), 3) RETURNING id::text AS id`,
        [A, regraA, dup.f, dup.cl, `${regraA}:PESQUISA_SATISFACAO:${dup.f}:${dup.data}`]))).rows[0].id as string;
      await ciclo();
      const segunda = await um(`SELECT estado, motivo FROM marketing_automacao_execucoes WHERE id = $1::uuid`, [x2]);
      assert.equal(segunda.estado, "SUPRIMIDA"); assert.equal(segunda.motivo, "PESQUISA_JA_EXISTE", "pesquisa da festa vem antes da frequência");
      // 14 dias (espera 1): festa de 14 dias atrás entra; de 15, não.
      const dentro = await festaRecente({ dias: 14 }), fora = await festaRecente({ dias: 15 });
      const sim = await motor.simularEmpresa(executor(c3), A, await emTransacao((tx) => regras.regraDaEmpresa(tx, A, regraA)), new Date());
      assert.ok(sim.alvos.some((x) => x.alvoId === dentro.f) || sim.total > sim.alvos.length, "14 dias: dentro");
      assert.ok(!sim.alvos.some((x) => x.alvoId === fora.f), "15 dias: fora");
    });

    await t.test("D12 transporte do ambiente: só 'simulado' (nada real, sem fallback); nenhuma chamada de rede na suíte", async () => {
      assert.throws(() => tp1.transportesDoAmbiente(() => executor(c1), { SATISFACAO_EMAIL_TRANSPORTE: "resend" }), { code: "TRANSPORTE_NAO_CONFIGURADO" });
      assert.throws(() => tp1.transportesDoAmbiente(() => executor(c1), { MARKETING_TRANSPORTE: "gupshup" }), { code: "TRANSPORTE_NAO_CONFIGURADO" });
      assert.ok(tp1.transportesDoAmbiente(() => executor(c1), { RESEND_API_KEY: "re_falsa" }), "RESEND_API_KEY não troca o transporte");
      assert.equal(chamadasDeRede, 0, "nenhuma chamada HTTP/HTTPS durante a suíte");
    });

    await t.test("D13 troca de ação e pausa: pendentes suprimidas (ACAO_ALTERADA no despacho; REGRA_PAUSADA pela pausa)", async () => {
      const pausa = await pronto({ autorizado: false });
      await emTransacao((tx) => regras.pausarRegra(tx, A, usuario, regraA));
      assert.deepEqual(await entregas(pausa.envio), ["EMAIL/INICIAL:SUPRIMIDA:REGRA_PAUSADA", "WHATSAPP/INICIAL:SUPRIMIDA:REGRA_PAUSADA"], "supressão adiantada da pausa");
      await ativarRegraPesquisa(c3, regraA);
      const troca = await pronto({ autorizado: false });
      await emTransacao(() => c3.query(`UPDATE marketing_automacao_regras SET acao = 'TAREFA_INTERNA', canais = '{}' WHERE id = $1::uuid`, [regraA]));
      await despachar(troca.envio);
      assert.deepEqual(await entregas(troca.envio), ["EMAIL/INICIAL:SUPRIMIDA:ACAO_ALTERADA", "WHATSAPP/INICIAL:SUPRIMIDA:ACAO_ALTERADA"]);
      // A regra volta à pesquisa para os testes seguintes.
      await emTransacao(() => c3.query(`UPDATE marketing_automacao_regras SET acao = 'PESQUISA_SATISFACAO', canais = '{WHATSAPP,EMAIL}' WHERE id = $1::uuid`, [regraA]));
      await ativarRegraPesquisa(c3, regraA);
    });

    // Rodada 2 (Astra PS-2 P2-1..P2-3): as intercalações reproduzidas com barreiras, nas duas ordens.
    const whatsSimulados = () => n(`SELECT count(*) AS n FROM marketing_transporte_simulado WHERE empresa_id = $1::uuid`, [A]);
    const pid1 = await pid(c1), pid2 = await pid(c2), pid3 = await pid(c3);
    // Falha no meio de uma barreira: a transação de c3 é desfeita para não prender os testes seguintes.
    const r2 = (nome: string, corpo: () => Promise<void>) => t.test(nome, async () => {
      try { await corpo(); } finally { await c3.query("ROLLBACK").catch(() => {}); }
    });

    await r2("R2-1 cadastro × despacho (P2-1): a edição do WhatsApp e a revogação esperam o despacho, ou o despacho espera e relê", async () => {
      // Ordem A1: edição do número em aberto → o despacho espera no cliente (FOR SHARE) e relê o número novo (sem autorização).
      const a1 = await pronto();
      const a1Id = (await entrega(a1.envio, "WHATSAPP")).id;
      const novo = numero();
      const antesA1 = await whatsSimulados();
      await c3.query("BEGIN");
      await c3.query(`UPDATE clientes SET whatsapp = $2, telefone = $2 WHERE id = $1::uuid`, [a1.cl, novo]);
      const d1 = desp1.despacharEntrega(banco1, ctx1, a1Id, new Date(Date.now() + 1000));
      await esperarBloqueio(c3, [pid1], pid3, "satisfacao:travar-cliente");
      await c3.query("COMMIT");
      assert.equal(await d1, "SUPRIMIDA");
      // O gatilho marketing_aut_numero_saiu (086) revoga a autorização do número que saiu do cadastro: relido, nada sobra.
      assert.equal((await entrega(a1.envio, "WHATSAPP")).motivo, "SEM_AUTORIZACAO", "relido o cadastro confirmado pela edição");
      assert.equal(await whatsSimulados(), antesA1, "nenhum WhatsApp para o número antigo");

      // Ordem A2: revogação em aberto → o despacho espera no cliente; a revogação suprime a entrega e nada sai.
      const a2 = await pronto();
      const a2Id = (await entrega(a2.envio, "WHATSAPP")).id;
      const aut = await um(`SELECT id::text FROM marketing_contato_autorizacoes WHERE cliente_id = $1::uuid AND estado = 'CONFIRMADA'`, [a2.cl]);
      const antesA2 = await whatsSimulados();
      await c3.query("BEGIN");
      await pref.alterarPreferencia(executor(c3), A, usuario, { acao: "preferencia", clienteId: a2.cl, operacao: "revogar", autorizacaoId: aut.id, confirmacao: "Revogou (sintético)" });
      const d2 = desp1.despacharEntrega(banco1, ctx1, a2Id, new Date(Date.now() + 1000));
      await esperarBloqueio(c3, [pid1], pid3, "satisfacao:travar-cliente");
      await c3.query("COMMIT");
      assert.equal(await d2, "IGNORADA", "a revogação já tinha suprimido a entrega");
      assert.equal((await entrega(a2.envio, "WHATSAPP")).estado, "SUPRIMIDA");
      assert.equal(await whatsSimulados(), antesA2);

      // Ordem B: o despacho já tem o cliente (parado no envio, que c3 segura) → edição e revogação esperam o despacho
      // terminar o preparo; o WhatsApp sai para o número que valia, e só depois o cadastro muda.
      for (const operacao of ["editar", "revogar"] as const) {
        const b = await pronto();
        const bId = (await entrega(b.envio, "WHATSAPP")).id;
        const autB = await um(`SELECT id::text FROM marketing_contato_autorizacoes WHERE cliente_id = $1::uuid AND estado = 'CONFIRMADA'`, [b.cl]);
        const antesB = await whatsSimulados();
        const destinos: string[] = [];
        const espiao = { ...ctx1, transportes: { ...ctx1.transportes, enviarWhatsapp: async (m: { telefone: string }) => { destinos.push(m.telefone); return ctx1.transportes.enviarWhatsapp(m); } } };
        await c3.query("BEGIN");
        await c3.query(`SELECT 1 FROM satisfacao_envios WHERE id = $1::uuid FOR UPDATE`, [b.envio]);
        const d = desp1.despacharEntrega(banco1, espiao, bId, new Date(Date.now() + 1000));
        await esperarBloqueio(c3, [pid1], pid3, "satisfacao:travar-envio");
        const mudanca = operacao === "editar"
          ? porTransacao(c2)(() => c2.query(`UPDATE clientes SET whatsapp = $2, telefone = $2 WHERE id = $1::uuid`, [b.cl, numero()]))
          : porTransacao(c2)((tx) => pref.alterarPreferencia(tx, A, usuario, { acao: "preferencia", clienteId: b.cl, operacao: "revogar", autorizacaoId: autB.id, confirmacao: "Revogou (sintético)" }));
        await esperarBloqueio(c3, [pid2], pid1, "clientes");
        await c3.query("COMMIT");
        assert.equal(await d, "ACEITA", `${operacao}: o despacho que travou o cliente primeiro conclui`);
        await mudanca;
        assert.equal(await whatsSimulados(), antesB + 1, `${operacao}: um WhatsApp`);
        assert.deepEqual(destinos, [b.telefone], `${operacao}: o transporte recebeu o número que valia quando o cliente foi travado`);
      }
    });

    await r2("R2-2 relógio por tentativa (P2-2): lido depois das travas; lembrete ancorado no aceite; o ciclo não fixa o instante", async () => {
      // Janela 09:00–18:00 (Brasília) todos os dias; amanhã 17:59 está dentro, 18:01 fora.
      const amanha = new Date(Date.now() + DIA);
      const dia = Date.UTC(amanha.getUTCFullYear(), amanha.getUTCMonth(), amanha.getUTCDate());
      const dentro = new Date(dia + 20 * 3600_000 + 59 * 60_000), fora = new Date(dia + 21 * 3600_000 + 60_000);
      await ativarRegraPesquisa(c3, regraA, { janelaInicio: "09:00", janelaFim: "18:00", fimDeSemana: true });
      try {
        // (a) A tentativa espera a trava por cliente com o relógio em 17:59; quando a trava cai, já são 18:01 → REAGENDADA.
        const p = await pronto({ autorizado: false });
        const id = (await entrega(p.envio, "EMAIL")).id;
        let momento = dentro;
        await c3.query("BEGIN");
        await c3.query(`SELECT pg_advisory_xact_lock(hashtext('marketing:' || $1 || ':' || $2))`, [A, p.cl]);
        const d = desp1.despacharEntrega(banco1, { ...ctx1, relogio: () => momento }, id);
        await esperarBloqueio(c3, [pid1], pid3, "satisfacao:preparar");
        momento = fora;
        await c3.query("COMMIT");
        assert.equal(await d, "REAGENDADA", "fora da janela no instante real da tentativa");
        assert.equal(await caixaEmail(id), 0);

        // (b) Transporte lento (1 h): o lembrete conta 3 dias a partir do aceite, não do preparo.
        const q = await pronto({ autorizado: false });
        const qId = (await entrega(q.envio, "EMAIL")).id;
        const inicio = new Date(dia + 13 * 3600_000); // 10:00 de Brasília
        let agoraQ = inicio;
        const lento = { ...ctx1.transportes, enviarEmail: async (m: unknown) => { agoraQ = new Date(inicio.getTime() + 3600_000); return ctx1.transportes.enviarEmail(m); } };
        assert.equal(await desp1.despacharEntrega(banco1, { ...ctx1, transportes: lento, relogio: () => agoraQ }, qId), "ACEITA");
        const l = await entrega(q.envio, "EMAIL", "LEMBRETE");
        assert.equal(new Date(l.agendada_para).toISOString(), new Date(inicio.getTime() + 3 * DIA + 3600_000).toISOString(), "3 dias depois do aceite (11:00)");

        // (c) O ciclo escolhe com o seu instante (17:59), mas cada tentativa lê o relógio da tentativa (18:01).
        const r = await pronto({ autorizado: false });
        const rId = (await entrega(r.envio, "EMAIL")).id;
        await desp1.executarEntregas(banco1, { ...ctx1, relogio: () => fora }, dentro, { empresaId: A, limite: 500 });
        assert.equal((await entrega(r.envio, "EMAIL")).estado, "PENDENTE", "reagendada, não enviada");
        assert.equal(await caixaEmail(rId), 0);
      } finally {
        await ativarRegraPesquisa(c3, regraA);
      }
    });

    await r2("R2-3 recuperação de posse × conclusão (P2-3): mesma ordem de travas, sem 40P01, nas duas ordens", async () => {
      for (const primeiro of ["recuperacao", "conclusao"] as const) {
        const p = await pronto({ autorizado: false });
        const id = (await entrega(p.envio, "EMAIL")).id;
        let noTransporte!: () => void, liberar!: () => void;
        const chegou = new Promise<void>((ok) => { noTransporte = ok; });
        const solto = new Promise<void>((ok) => { liberar = ok; });
        const preso = { ...ctx1.transportes, enviarEmail: async (m: unknown) => { noTransporte(); await solto; return ctx1.transportes.enviarEmail(m); } };
        // Nenhuma repetição em nenhum dos dois: "sem 40P01" é observado, não inferido do PASS.
        const repeticoes: string[] = [];
        const contadas = { esperar: async () => {}, aoRepetir: (_: number, codigo: string) => { repeticoes.push(codigo); } };
        const d = desp1.despacharEntrega(banco1, { ...ctx1, transportes: preso, repeticao: contadas }, id, new Date(Date.now() + 1000));
        await Promise.race([chegou, d.then((s) => { throw new Error(`o despacho terminou sem chegar ao transporte: ${s}`); })]);
        await emTransacao(() => c3.query(`UPDATE satisfacao_entregas SET posse_ate = clock_timestamp() - interval '1 minute' WHERE id = $1::uuid`, [id]));
        await c3.query("BEGIN");
        await c3.query(`SELECT pg_advisory_xact_lock(hashtext('marketing:' || $1 || ':' || $2))`, [A, p.cl]);
        let recuperacao: Promise<number>;
        if (primeiro === "recuperacao") {
          recuperacao = desp2.recuperarPossesEntregas(banco2, new Date(), A, contadas);
          await esperarBloqueio(c3, [pid2], pid3, "satisfacao:recuperar-posse");
          liberar();
          await esperarBloqueio(c3, [pid1], pid3, "satisfacao:concluir");
        } else {
          liberar();
          await esperarBloqueio(c3, [pid1], pid3, "satisfacao:concluir");
          recuperacao = desp2.recuperarPossesEntregas(banco2, new Date(), A, contadas);
          await esperarBloqueio(c3, [pid2], pid3, "satisfacao:recuperar-posse");
        }
        await c3.query("COMMIT");
        const [estado, recuperadas] = await Promise.all([d, recuperacao]);
        const e = await entrega(p.envio, "EMAIL");
        const lembretes = await n(`SELECT count(*) AS n FROM satisfacao_entregas WHERE envio_id = $1::uuid AND etapa = 'LEMBRETE'`, [p.envio]);
        if (primeiro === "recuperacao") {
          assert.equal(estado, "POSSE_PERDIDA"); assert.ok(recuperadas >= 1);
          assert.equal(e.estado, "INCERTA"); assert.equal(e.motivo, "POSSE_VENCIDA_DURANTE_ENVIO"); assert.equal(lembretes, 0);
        } else {
          assert.equal(estado, "ACEITA"); assert.equal(e.estado, "ACEITA"); assert.equal(lembretes, 1);
          assert.equal(await n(`SELECT count(*) AS n FROM satisfacao_entregas WHERE id = $1::uuid AND estado = 'INCERTA'`, [id]), 0, "a recuperação reconferiu e não mexeu");
        }
        assert.equal(await caixaEmail(id), 1, `${primeiro}: o transporte rodou uma vez (nunca repetido)`);
        assert.deepEqual(repeticoes, [], `${primeiro}: nenhuma repetição (nenhum 40P01/55P03)`);
      }
    });

    await r2("R2-4 40P01 na conclusão (injetado depois do ACEITA): uma falha → repetida e ACEITA; duas → ENVIANDO e recuperação INCERTA; transporte uma vez", async () => {
      // Injeção determinística de SQLSTATE com aborto real da transação (não um deadlock entre sessões): prova a política
      // de repetição da conclusão — só a transação volta; o transporte nunca é chamado de novo.
      for (const falhas of [1, 2]) {
        const p = await pronto({ autorizado: false });
        const id = (await entrega(p.envio, "EMAIL")).id;
        let injetadas = 0, transportes = 0;
        const repeticoes: string[] = [];
        const bancoFalha: Banco = { transacao: (work) => porTransacao(c1)((tx) => work({
          query: (async (sql: string, args?: unknown[]) => {
            const r = await tx.query(sql, args as unknown[]);
            if (sql.includes("SET estado = 'ACEITA'") && injetadas < falhas) {
              injetadas++;
              await tx.query(`DO $$ BEGIN RAISE EXCEPTION 'falha sintética' USING ERRCODE = '40P01'; END $$`);
            }
            return r;
          }) as DbExecutor["query"],
        } as DbExecutor)) };
        const contexto = { ...ctx1, transportes: { ...ctx1.transportes, enviarEmail: async (m: unknown) => { transportes++; return ctx1.transportes.enviarEmail(m); } },
          repeticao: { esperar: async () => {}, aoRepetir: (_: number, codigo: string) => { repeticoes.push(codigo); } } };
        const tentativa = desp1.despacharEntrega(bancoFalha, contexto, id, new Date(Date.now() + 1000));
        if (falhas === 1) assert.equal(await tentativa, "ACEITA");
        else await assert.rejects(tentativa, (e: { code?: string }) => e.code === "40P01");
        assert.equal(injetadas, falhas);
        assert.deepEqual(repeticoes, ["40P01"], "40P01 repetido uma única vez");
        assert.equal(transportes, 1, "transporte chamado uma vez"); assert.equal(await caixaEmail(id), 1);
        const lembretes = () => n(`SELECT count(*) AS n FROM satisfacao_entregas WHERE envio_id = $1::uuid AND etapa = 'LEMBRETE'`, [p.envio]);
        if (falhas === 1) {
          assert.equal((await entrega(p.envio, "EMAIL")).estado, "ACEITA"); assert.equal(await lembretes(), 1);
        } else {
          assert.equal((await entrega(p.envio, "EMAIL")).estado, "ENVIANDO", "a segunda falha desfaz a conclusão"); assert.equal(await lembretes(), 0);
          await emTransacao(() => c3.query(`UPDATE satisfacao_entregas SET posse_ate = clock_timestamp() - interval '1 minute' WHERE id = $1::uuid`, [id]));
          await desp2.recuperarPossesEntregas(banco2, new Date(), A);
          assert.equal((await entrega(p.envio, "EMAIL")).estado, "INCERTA");
          assert.equal(transportes, 1, "nenhum reenvio depois da recuperação");
        }
      }
    });

    await r2("R2-5 ordem envio → entrega na recuperação: com c3 imitando a conclusão (envio, depois entrega), sem 40P01", async () => {
      // A inversão original: a recuperação travava a entrega e o gatilho do marco de contato (contato_em nulo) pedia o
      // envio; a conclusão segura envio e pede entrega → 40P01. Aqui c3 segura o envio; a recuperação precisa ficar
      // presa NO ENVIO, sem a entrega, e c3 consegue a entrega na hora.
      const p = await pronto({ autorizado: false });
      const id = (await entrega(p.envio, "EMAIL")).id;
      let noTransporte!: () => void, liberar!: () => void;
      const chegou = new Promise<void>((ok) => { noTransporte = ok; });
      const solto = new Promise<void>((ok) => { liberar = ok; });
      const repeticoes: string[] = [];
      const contadas = { esperar: async () => {}, aoRepetir: (_: number, codigo: string) => { repeticoes.push(codigo); } };
      const preso = { ...ctx1.transportes, enviarEmail: async (m: unknown) => { noTransporte(); await solto; return ctx1.transportes.enviarEmail(m); } };
      const d = desp1.despacharEntrega(banco1, { ...ctx1, transportes: preso, repeticao: contadas }, id, new Date(Date.now() + 1000));
      await Promise.race([chegou, d.then((s) => { throw new Error(`o despacho terminou sem chegar ao transporte: ${s}`); })]);
      assert.equal((await um(`SELECT contato_em IS NULL AS sem FROM satisfacao_envios WHERE id = $1::uuid`, [p.envio])).sem, true, "primeira INICIAL: o gatilho mexeria no envio");
      await emTransacao(() => c3.query(`UPDATE satisfacao_entregas SET posse_ate = clock_timestamp() - interval '1 minute' WHERE id = $1::uuid`, [id]));
      await c3.query("BEGIN");
      await c3.query(`SELECT 1 FROM satisfacao_envios WHERE id = $1::uuid FOR UPDATE`, [p.envio]);
      const recuperacao = desp2.recuperarPossesEntregas(banco2, new Date(), A, contadas);
      await esperarBloqueio(c3, [pid2], pid3, "satisfacao_e");
      // c3 pede a entrega como a conclusão pediria: com a ordem comum ela está livre; invertida, 40P01.
      await c3.query(`SELECT 1 FROM satisfacao_entregas WHERE id = $1::uuid FOR UPDATE`, [id]);
      await c3.query("COMMIT");
      assert.equal(await recuperacao, 1);
      assert.deepEqual(repeticoes, [], "nenhum 40P01 na recuperação");
      assert.equal((await entrega(p.envio, "EMAIL")).estado, "INCERTA");
      liberar();
      assert.equal(await d, "POSSE_PERDIDA");
      assert.equal(await caixaEmail(id), 1);
    });
  } finally {
    globalThis.fetch = originais.fetch;
    (http as { request: unknown }).request = originais.httpReq;
    (https as { request: unknown }).request = originais.httpsReq;
    await encerrarDescartavel(c1);
    await encerrarDescartavel(c2);
    await encerrarDescartavel(c3);
  }
});
