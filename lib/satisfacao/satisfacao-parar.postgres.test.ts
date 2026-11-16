import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { carregarComBanco, cod, executor, porTransacao, SENHA_FALSA } from "../marketing/harness-postgres.ts";
import { carregarAtendimento } from "../whatsapp/atendimento/harness-postgres.ts";
import { comandoDireto, pausaPedidaNaRecepcao } from "../whatsapp/atendimento/core.ts";
import type { PortaWallE } from "../whatsapp/atendimento/worker.ts";
import type { ConteudoSaida } from "../whatsapp/atendimento/transporte.ts";
import { ativarRegraPesquisa, baseSintetica, type CriarEnvio } from "./harness-postgres.ts";
import { lerAnel, type AnelChaves } from "./token.ts";

/**
 * Pesquisa de satisfação (110, PS-1) × PARAR do WhatsApp pela RECEPÇÃO e pelo WORKER reais (P2-3 do Astra), no
 * PostgreSQL descartável, modelo 110. Serviço e worker do atendimento carregados pelo harness do atendimento (conexão por
 * transação, transporte sem rede, modelo e Wall-e simulados), com os módulos REAIS de supressão e preferências.
 *
 *  P1 recepção, cliente identificado com pesquisa pendente: a entrega de WhatsApp vira SUPRIMIDA (PARAR), o e-mail
 *     continua PENDENTE, a elegibilidade do WhatsApp (o que o despacho revalida) é NAO_CONTATAR_ATENDIMENTO;
 *  P2 recepção, número SEM cliente: nada a suprimir; o cliente vinculado DEPOIS (número no cadastro) e a pesquisa criada
 *     depois do PARAR ficam com o WhatsApp inelegível (bloqueio da conversa) e o e-mail PENDENTE;
 *  P3 recepção, cliente identificado SEM pesquisa: a pesquisa criada depois do PARAR — WhatsApp inelegível, e-mail PENDENTE;
 *  P4 worker, PARAR entendido pelo Wall-e (paráfrase que a recepção não bloqueia): mesmo alcance da recepção;
 *  P5 worker, PARAR entendido pelo modelo (fase B): mesmo alcance da recepção.
 *  P6 (PS-2) o despacho REAL das entregas de P1–P5 revalida cada tentativa: nenhum WhatsApp sai depois do PARAR
 *     (inclusive pesquisa/cliente criados depois dele); todo e-mail sai.
 * A entrega de WhatsApp criada depois do PARAR nasce PENDENTE (a criação não decide canal): quem barra é a revalidação do
 * despacho (elegivelParaMensagem), conferida aqui pelo chamador real; o despacho em si é da PS-2.
 */
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${"x".repeat(24)}`;
const anel = lerAnel({ SATISFACAO_LINK_CHAVES: `1:${randomBytes(32).toString("base64")}`, SATISFACAO_LINK_CHAVE_ATUAL: "1" }) as AnelChaves;
const PARAR = "não quero receber mais nada de vocês";
const PARAFRASE = "podem me esquecer, não tenho mais interesse em nada";

type Envios = { criarEnvio: CriarEnvio };
type Despacho = { executarEntregas(b: unknown, ctx: unknown, agora: Date, o: unknown): Promise<{ resultados: Record<string, number> }> };
type TranspPesquisa = { transportesSimulados(c: () => unknown): unknown };
type Pref = {
  alterarPreferencia(tx: unknown, e: string, u: string, i: unknown): Promise<unknown>;
  elegivelParaMensagem(tx: unknown, e: string, clienteId: string): Promise<{ ok: boolean; motivo?: string }>;
};

/** Identidade sintética da suíte (senha em formato válido que não autentica). */
const identidade = async (db: Client) => (await db.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
  VALUES ($1, 'Gestão sintética', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`, [`${cod("u")}@pesquisa.test`, SENHA_FALSA])).rows[0].id;

test("110: PARAR pela recepção e pelo worker reais do WhatsApp", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  assert.equal(comandoDireto(PARAR)?.intencao, "PARAR", "PARAR inequívoco (recepção)");
  assert.equal(comandoDireto(PARAFRASE), null, "a paráfrase passa pela recepção e vai ao worker");
  assert.ok(!pausaPedidaNaRecepcao(PARAFRASE), "a paráfrase não é pausa");
  const c = await conectarDescartavel();
  try {
    const cache = new Map();
    const carregar = <T>(f: string) => carregarComBanco(f, c, () => null, {}, cache) as unknown as T;
    const envios = carregar<Envios>("lib/satisfacao/envios.ts");
    const pref = carregar<Pref>("lib/marketing/automacoes/preferencias.ts");
    const { A, usuario, regraA, festa, emTransacao, envioPronto } = await baseSintetica(c, anel, envios.criarEnvio, identidade);
    const { servico, worker } = carregarAtendimento(A);
    await servico.salvarConfiguracao({ usuario_id: usuario, papel: "REPRESENTANTE_AUTORIZADO" } as never,
      { ativo: true, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 5 }, wallE: { ativo: true } });

    const um = async (sql: string, v: unknown[] = []) => (await c.query(sql, v)).rows[0];
    const entregas = async (envio: string) => (await c.query(`SELECT canal, estado, motivo FROM satisfacao_entregas WHERE envio_id = $1::uuid ORDER BY canal`, [envio])).rows
      .map((x) => `${x.canal}:${x.estado}:${x.motivo ?? "-"}`);
    const elegivel = (cl: string) => emTransacao((tx) => pref.elegivelParaMensagem(tx, A, cl));
    const autorizar = (cl: string, numero: string) => emTransacao((tx) => pref.alterarPreferencia(tx, A, usuario, { acao: "preferencia", clienteId: cl, operacao: "autorizar", destino: numero, confirmacao: "Autorizou (sintético)" }));
    const conversa = async (numero: string) => um(`SELECT estado, nao_contatar FROM whatsapp_atendimento_conversas WHERE empresa_id = $1::uuid AND contato = $2`, [A, numero]);
    const receber = (numero: string, texto: string) => servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: numero, texto, timestamp: Date.now(), nomePerfil: null });
    let n = 0;
    const numero = () => `55619${String(70000000 + ++n)}`; // contatoPermitido do harness: 55619…
    /** Cliente com o número autorizado e uma pesquisa pendente nos dois canais. */
    const clienteComPesquisa = async () => {
      const tel = numero();
      const p = await envioPronto({ telefone: tel });
      await autorizar(p.cl, tel);
      assert.deepEqual(await entregas(p.envio), ["EMAIL:PENDENTE:-", "WHATSAPP:PENDENTE:-"]);
      assert.equal((await elegivel(p.cl)).ok, true, "antes do PARAR: elegível");
      return { ...p, tel };
    };
    const bloqueadoNoWhatsapp = async (cl: string, rotulo: string) =>
      assert.deepEqual(await elegivel(cl), { ok: false, motivo: "NAO_CONTATAR_ATENDIMENTO" }, `${rotulo}: WhatsApp inelegível no despacho`);
    const semSaidaDasPesquisas = async (cl: string, rotulo: string) =>
      assert.equal(Number((await um(`SELECT count(*) AS n FROM satisfacao_saidas WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid`, [A, cl])).n), 0, `${rotulo}: PARAR não é saída das pesquisas (e-mail continua)`);

    await t.test("P1 recepção, cliente identificado com pesquisa pendente: WhatsApp SUPRIMIDA, e-mail PENDENTE", async () => {
      const p = await clienteComPesquisa();
      await receber(p.tel, PARAR);
      assert.deepEqual(await conversa(p.tel), { estado: "ENCERRADA", nao_contatar: true });
      assert.deepEqual(await entregas(p.envio), ["EMAIL:PENDENTE:-", "WHATSAPP:SUPRIMIDA:PARAR"]);
      await bloqueadoNoWhatsapp(p.cl, "P1");
      await semSaidaDasPesquisas(p.cl, "P1");
    });

    await t.test("P2 recepção, número sem cliente; cliente vinculado depois e pesquisa criada depois do PARAR: WhatsApp inelegível, e-mail PENDENTE", async () => {
      const tel = numero();
      await receber(tel, PARAR);
      assert.deepEqual(await conversa(tel), { estado: "ENCERRADA", nao_contatar: true });
      assert.equal(Number((await um(`SELECT count(*) AS n FROM clientes WHERE empresa_id = $1::uuid AND whatsapp = $2`, [A, tel])).n), 0, "nenhum cliente com o número no PARAR");
      // Cliente cadastrado DEPOIS com o número, autorizado, e a pesquisa da festa criada depois do PARAR.
      const p = await envioPronto({ telefone: tel });
      await autorizar(p.cl, tel);
      assert.deepEqual(await entregas(p.envio), ["EMAIL:PENDENTE:-", "WHATSAPP:PENDENTE:-"], "a criação não decide canal (o despacho revalida)");
      await bloqueadoNoWhatsapp(p.cl, "P2");
      await semSaidaDasPesquisas(p.cl, "P2");
    });

    await t.test("P3 recepção, cliente identificado sem pesquisa; pesquisa criada depois do PARAR: WhatsApp inelegível, e-mail PENDENTE", async () => {
      const tel = numero();
      const f = await festa({ telefone: tel });
      await autorizar(f.cl, tel);
      await receber(tel, PARAR);
      const p = await envioPronto({ clienteId: f.cl });
      assert.deepEqual(await entregas(p.envio), ["EMAIL:PENDENTE:-", "WHATSAPP:PENDENTE:-"]);
      await bloqueadoNoWhatsapp(f.cl, "P3");
      await semSaidaDasPesquisas(f.cl, "P3");
    });

    const envios_: { contato: string; conteudo: ConteudoSaida }[] = [];
    const enviar = async (contato: string, conteudo: ConteudoSaida) => { envios_.push({ contato, conteudo }); return cod("gs-"); };

    await t.test("P4 worker, PARAR entendido pelo Wall-e: WhatsApp SUPRIMIDA, e-mail PENDENTE, nada enviado", async () => {
      const p = await clienteComPesquisa();
      let chamadas = 0;
      const porta: PortaWallE = { async responder(e) {
        chamadas++;
        assert.equal(e.texto, PARAFRASE);
        return { saidas: [], contexto: {} as never, passagem: null, parar: true };
      } };
      await receber(p.tel, PARAFRASE);
      assert.deepEqual(await entregas(p.envio), ["EMAIL:PENDENTE:-", "WHATSAPP:PENDENTE:-"], "a recepção não bloqueou a paráfrase");
      await worker.processarLote({ interpretar: async () => { throw new Error("fase B não deveria rodar"); }, enviar, wallE: porta }, { maxTarefas: 10 });
      assert.equal(chamadas, 1, "o Wall-e (simulado) entendeu o pedido");
      assert.deepEqual(await conversa(p.tel), { estado: "ENCERRADA", nao_contatar: true });
      assert.deepEqual(await entregas(p.envio), ["EMAIL:PENDENTE:-", "WHATSAPP:SUPRIMIDA:PARAR"]);
      await bloqueadoNoWhatsapp(p.cl, "P4");
      await semSaidaDasPesquisas(p.cl, "P4");
      assert.equal(envios_.filter((x) => x.contato === p.tel).length, 0, "P4: nada enviado ao cliente");
    });

    await t.test("P5 worker, PARAR entendido pelo modelo (fase B, sem Wall-e): WhatsApp SUPRIMIDA, e-mail PENDENTE", async () => {
      const p = await clienteComPesquisa();
      // Modo MODELO só neste subteste (autorização R6 e lista de contatos sintéticas); restaurado no fim.
      const nomes = ["WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO", "WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO", "WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS"] as const;
      const antes = nomes.map((k) => process.env[k]);
      Object.assign(process.env, { WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO: "modelo", WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO: "R6-sintetico-pesquisa", WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS: p.tel });
      let interpretacoes = 0;
      try {
        await receber(p.tel, PARAFRASE);
        await worker.processarLote({ interpretar: async () => { interpretacoes++; return { intencao: "PARAR" as const, perguntaId: null, data: null, convidados: null }; }, enviar }, { maxTarefas: 10 });
      } finally {
        nomes.forEach((k, i) => { if (antes[i] === undefined) delete process.env[k]; else process.env[k] = antes[i]; });
      }
      assert.equal(interpretacoes, 1, "o modelo (simulado) entendeu o pedido");
      assert.deepEqual(await conversa(p.tel), { estado: "ENCERRADA", nao_contatar: true });
      assert.deepEqual(await entregas(p.envio), ["EMAIL:PENDENTE:-", "WHATSAPP:SUPRIMIDA:PARAR"]);
      await bloqueadoNoWhatsapp(p.cl, "P5");
      await semSaidaDasPesquisas(p.cl, "P5");
      assert.equal(envios_.filter((x) => x.contato === p.tel).length, 0, "P5: nada enviado ao cliente");
    });

    await t.test("P6 (PS-2) despacho REAL das entregas de P1–P5: nenhum WhatsApp sai depois do PARAR; todo e-mail sai", async () => {
      // A herança do Astra: as entregas de WhatsApp criadas depois do PARAR (P2, P3) nasceram PENDENTE; o despacho
      // revalida e as suprime. As já suprimidas (P1, P4, P5) continuam como estão. O e-mail não é afetado pelo PARAR.
      await ativarRegraPesquisa(c, regraA);
      const despacho = carregar<Despacho>("lib/satisfacao/despacho.ts");
      const transp = carregar<TranspPesquisa>("lib/satisfacao/transporte.ts");
      const ctx = { habilitada: true, anel, origem: "http://127.0.0.1:3000", transportes: transp.transportesSimulados(() => executor(c)), repeticao: { esperar: async () => {} } };
      const r = await despacho.executarEntregas({ transacao: porTransacao(c) }, ctx, new Date(), { empresaId: A, limite: 100 });
      const linhas = (await c.query(`SELECT d.canal, d.estado, d.motivo FROM satisfacao_entregas d WHERE d.empresa_id = $1::uuid AND d.etapa = 'INICIAL'`, [A])).rows;
      const whatsapp = linhas.filter((x) => x.canal === "WHATSAPP"), email = linhas.filter((x) => x.canal === "EMAIL");
      assert.equal(whatsapp.length, 5);
      assert.ok(whatsapp.every((x) => x.estado === "SUPRIMIDA" && ["PARAR", "NAO_CONTATAR_ATENDIMENTO"].includes(x.motivo)), JSON.stringify(whatsapp));
      assert.equal(whatsapp.filter((x) => x.motivo === "NAO_CONTATAR_ATENDIMENTO").length, 2, "P2 e P3: suprimidas pelo despacho");
      assert.ok(email.length === 5 && email.every((x) => x.estado === "ACEITA"), JSON.stringify(email));
      assert.equal(Number((await um(`SELECT count(*) AS n FROM marketing_transporte_simulado WHERE empresa_id = $1::uuid`, [A])).n), 0, "nenhum WhatsApp na caixa de saída");
      assert.equal(Number((await um(`SELECT count(*) AS n FROM satisfacao_email_simulado WHERE empresa_id = $1::uuid`, [A])).n), 5);
      assert.equal(r.resultados.ACEITA, 5);
    });
  } finally {
    await encerrarDescartavel(c);
  }
});
