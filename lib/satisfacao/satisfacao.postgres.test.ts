import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { carregarComBanco, cod, executor, porTransacao, SENHA_FALSA } from "../marketing/harness-postgres.ts";
import { baseSintetica, type CriarEnvio } from "./harness-postgres.ts";
import { assinarToken, lerAnel, type AnelChaves } from "./token.ts";

/**
 * Pesquisa de satisfação (110, PS-1) no PostgreSQL descartável, modelo 110. Dados sintéticos COMMITADOS (cada cenário
 * com a sua festa). Esquema: vínculos, imutabilidade, terminalidade, UNIQUEs, CHECKs, invariante diferida, marco de
 * contato, prazos da entrega, 086 com PESQUISA_CRIADA e o pós-check. Serviço: criação, abertura, resposta atômica,
 * tarefa da nota baixa (falha injetada volta tudo), expiração, revogação, regeneração do link, limites de tentativas,
 * saída das pesquisas e alcance de cada opt-out, frequência/contato_em e bloqueio do WhatsApp (antigo × novo).
 * A concorrência (duas conexões) está em satisfacao-concorrencia.postgres.test.ts.
 */
// Segredo sintético da suíte (chave do limite por origem; nunca o de um ambiente real).
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${"x".repeat(24)}`;
const anel = lerAnel({ SATISFACAO_LINK_CHAVES: `1:${randomBytes(32).toString("base64")},2:${randomBytes(32).toString("base64")}`, SATISFACAO_LINK_CHAVE_ATUAL: "1" }) as AnelChaves;
const soChave2 = (a: AnelChaves) => lerAnel({ SATISFACAO_LINK_CHAVES: `2:${a.chaves.get(2)!.toString("base64")}`, SATISFACAO_LINK_CHAVE_ATUAL: "2" }) as AnelChaves;

type Publico = Record<"abrirPesquisa" | "responderPesquisa" | "sairDasPesquisas", (corpo: unknown, ctx: { ip: string | null }, deps: unknown) => Promise<Record<string, unknown>>>;
type Envios = {
  criarEnvio(tx: unknown, anel: AnelChaves, e: { empresaId: string; execucaoId: string; canais: string[]; agendadaPara: Date; maxTentativas: number }): Promise<{ criado: boolean; envioId?: string; motivo?: string }>;
  linkDoEnvio(tx: unknown, anel: AnelChaves, envioId: string): Promise<{ token: string; geracao: number; regenerado: boolean } | null>;
};
type Supressao = {
  suprimirPesquisas(tx: unknown, e: string, c: string, a: { canal: string; motivo: string }): Promise<{ execucoes: number; entregas: number }>;
  clientesDoNumero(tx: unknown, e: string, contato: string): Promise<string[]>;
};
type Pref = {
  alterarPreferencia(tx: unknown, e: string, u: string, i: unknown): Promise<unknown>;
  bloqueioWhatsappDoDestino(tx: unknown, e: string, destino: string): Promise<boolean>;
};
type Motor = { frequenciaExcedida(tx: unknown, e: string, c: string, dias: number, excetoId: string | null, excetoEnvioId?: string | null): Promise<boolean> };

/** Identidade sintética da suíte (senha em formato válido que não autentica). */
const identidade = async (db: Client) => (await db.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
  VALUES ($1, 'Gestão sintética', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`, [`${cod("u")}@pesquisa.test`, SENHA_FALSA])).rows[0].id;

const erroDe = (code: string, status?: number) => (e: unknown) => (e as { code?: string }).code === code && (status === undefined || (e as { httpStatus?: number }).httpStatus === status);

async function recusa(c: Client, sql: string, v: unknown[], padrao: RegExp | string) {
  await assert.rejects(c.query(sql, v), (e: unknown) => {
    const { code, message } = e as { code?: string; message: string };
    return typeof padrao === "string" ? code === padrao : padrao.test(message);
  }, sql.slice(0, 90));
}

test("110: esquema, serviço público, supressões e frequência", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  try {
    const cache = new Map();
    const carregar = <T>(f: string) => carregarComBanco(f, c, () => null, {}, cache) as unknown as T;
    const publico = carregar<Publico>("lib/satisfacao/publico.ts");
    const envios = carregar<Envios>("lib/satisfacao/envios.ts");
    const supressao = carregar<Supressao>("lib/satisfacao/supressao.ts");
    const pref = carregar<Pref>("lib/marketing/automacoes/preferencias.ts");
    const motor = carregar<Motor>("lib/marketing/automacoes/motor.ts");
    const tx = executor(c);
    const emTransacao = porTransacao(c);
    const um = async (sql: string, v: unknown[] = []) => (await c.query(sql, v)).rows[0];
    let ipN = 0;
    const ip = () => `198.51.100.${++ipN}`;
    const deps = (extra: Record<string, unknown> = {}) => ({ withTransaction: emTransacao, anel: () => anel, repeticao: { esperar: async () => {} }, ...extra });

    // ---- base sintética (commitada) ----
    const { A, B, usuario, regraA, festa, outraFestaDoCliente, cancelarFesta, execucao, envioPronto, envioNoPassado } = await baseSintetica(c, anel, envios.criarEnvio as CriarEnvio, identidade);

    const estado = async (envio: string) => um(`SELECT estado, motivo_revogacao, contato_em, geracao FROM satisfacao_envios WHERE id = $1::uuid`, [envio]);
    const entregas = async (envio: string) => (await c.query(`SELECT canal, etapa, estado, motivo FROM satisfacao_entregas WHERE envio_id = $1::uuid ORDER BY canal, etapa`, [envio])).rows;

    await t.test("pós-check 110 passa (054, guarda 043, FKs RESTRICT, invariantes diferidas, 086 com PESQUISA_CRIADA)", async () => {
      await c.query(readFileSync("database/checks/20261030_110_postcheck.sql", "utf8"));
    });

    await t.test("086: corpo vivo = corpo da 086 com PESQUISA_CRIADA na lista de concluídas (e nada mais)", async () => {
      const fonte = readFileSync("database/migrations/20261018_086_marketing_automacoes.sql", "utf8");
      const inicio = fonte.indexOf("CREATE FUNCTION kidmais086_execucao_tenant()");
      const corpo086 = fonte.slice(fonte.indexOf("$$", inicio) + 2, fonte.indexOf("$$;", inicio));
      const vivo = (await um(`SELECT prosrc FROM pg_proc WHERE proname = 'kidmais086_execucao_tenant'`)).prosrc as string;
      const esperado = corpo086.replace("OLD.estado IN ('TAREFA_CRIADA', 'ENTREGUE'", "OLD.estado IN ('TAREFA_CRIADA', 'PESQUISA_CRIADA', 'ENTREGUE'");
      assert.notEqual(esperado, corpo086, "a lista da 086 mudou de formato");
      assert.equal(vivo.replace(/\r\n/g, "\n").trim(), esperado.replace(/\r\n/g, "\n").trim());
    });

    await t.test("execução: PESQUISA_CRIADA só para a pesquisa e imutável; a pesquisa nunca fica ENVIANDO", async () => {
      const { cl, f } = await festa();
      const x = await execucao(A, cl, f);
      await recusa(c, `UPDATE marketing_automacao_execucoes SET estado = 'ENVIANDO', posse_token = gen_random_uuid(), posse_ate = now() WHERE id = $1::uuid`, [x], "23514");
      await c.query(`UPDATE marketing_automacao_execucoes SET estado = 'PESQUISA_CRIADA', concluida_em = clock_timestamp() WHERE id = $1::uuid`, [x]);
      await recusa(c, `UPDATE marketing_automacao_execucoes SET estado = 'CANCELADA' WHERE id = $1::uuid`, [x], /concluída não muda \(PESQUISA_CRIADA\)/);
      const m = await execucao(A, cl, f, "MENSAGEM_WHATSAPP");
      await recusa(c, `UPDATE marketing_automacao_execucoes SET estado = 'PESQUISA_CRIADA', concluida_em = clock_timestamp() WHERE id = $1::uuid`, [m], "23514");
      await recusa(c, `INSERT INTO marketing_automacao_regras (empresa_id, tipo, acao, espera_dias, canais, criado_por, atualizado_por)
        VALUES ($1::uuid, 'RECOMPRA', 'PESQUISA_SATISFACAO', 1, '{EMAIL}', $2::uuid, $2::uuid)`, [A, usuario], "23514");
      await recusa(c, `UPDATE marketing_automacao_regras SET status = 'ATIVA', ativada_em = now() WHERE id = $1::uuid`, [regraA], "23514");
    });

    await t.test("envio: nasce ATIVO e coerente com festa, cliente, unidade e execução", async () => {
      const { cl, f } = await festa();
      const x = await execucao(A, cl, f);
      const outra = await festa();
      const xOutra = await execucao(A, outra.cl, outra.f);
      const xMsg = await execucao(A, cl, f, "MENSAGEM_WHATSAPP");
      const unidade = (await um(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1::uuid, $2, 'Unidade sintética', 'SUSPENSO') RETURNING id::text AS id`,
        [A, `u-${randomBytes(3).toString("hex")}`])).id;
      const ins = (campos: Record<string, unknown>) => {
        const v = { id: randomUUID(), empresa_id: A, estabelecimento_id: null, fechamento_id: f, cliente_id: cl, execucao_id: x, chave_versao: 1, token_hash: randomBytes(32), ...campos };
        const nomes = Object.keys(v);
        return [`INSERT INTO satisfacao_envios (${nomes.join(", ")}, criado_em, expira_em) VALUES (${nomes.map((_, i) => `$${i + 1}`).join(", ")}, now(), now() + interval '30 days')`, Object.values(v)] as const;
      };
      for (const [campos, padrao] of [
        [{ estado: "RESPONDIDO", respondido_em: new Date() }, /nasce ATIVO/],
        [{ geracao: 2 }, /nasce ATIVO/],
        [{ empresa_id: B }, /festa de outra empresa/],
        [{ cliente_id: outra.cl }, /cliente diferente da festa/],
        [{ estabelecimento_id: unidade }, /unidade diferente da festa/],
        [{ execucao_id: xOutra }, /execução de outra festa/],
        [{ execucao_id: xMsg }, /outra ação/],
        [{ token_hash: randomBytes(31) }, /satisfacao_envios_hash/],
      ] as const) {
        const [sql, v] = ins(campos);
        await recusa(c, sql, [...v], padrao);
      }
      // A validade é de exatamente 30 dias a partir da criação.
      await recusa(c, `INSERT INTO satisfacao_envios (empresa_id, fechamento_id, cliente_id, execucao_id, chave_versao, token_hash, criado_em, expira_em)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, now(), now() + interval '31 days')`, [A, f, cl, x, randomBytes(32)], /satisfacao_envios_validade/);
    });

    await t.test("envio: vínculos imutáveis, DELETE recusado, terminal congelado, regeneração só ATIVO e com geração + 1", async () => {
      const p = await envioPronto();
      const outra = await festa();
      await recusa(c, `UPDATE satisfacao_envios SET cliente_id = $2::uuid WHERE id = $1::uuid`, [p.envio, outra.cl], /imutáveis/);
      await recusa(c, `UPDATE satisfacao_envios SET expira_em = expira_em + interval '1 day' WHERE id = $1::uuid`, [p.envio], /imutáveis/);
      await recusa(c, `DELETE FROM satisfacao_envios WHERE id = $1::uuid`, [p.envio], /não é apagado/);
      await recusa(c, `UPDATE satisfacao_envios SET geracao = 3, token_hash = $2 WHERE id = $1::uuid`, [p.envio, randomBytes(32)], /regeneração/);
      await recusa(c, `UPDATE satisfacao_envios SET geracao = 2 WHERE id = $1::uuid`, [p.envio], /regeneração/);
      await c.query(`UPDATE satisfacao_envios SET contato_em = clock_timestamp() WHERE id = $1::uuid`, [p.envio]);
      await recusa(c, `UPDATE satisfacao_envios SET contato_em = clock_timestamp() WHERE id = $1::uuid`, [p.envio], /gravado uma vez/);
      await c.query(`UPDATE satisfacao_envios SET estado = 'EXPIRADO', expirado_em = clock_timestamp() WHERE id = $1::uuid`, [p.envio]);
      await recusa(c, `UPDATE satisfacao_envios SET estado = 'ATIVO', expirado_em = NULL WHERE id = $1::uuid`, [p.envio], /terminal/);
      await recusa(c, `UPDATE satisfacao_envios SET geracao = 2, token_hash = $2 WHERE id = $1::uuid`, [p.envio, randomBytes(32)], /regeneração/);
      const q = await envioPronto();
      await c.query(`UPDATE satisfacao_envios SET estado = 'REVOGADO', revogado_em = clock_timestamp(), motivo_revogacao = 'FESTA_CANCELADA' WHERE id = $1::uuid`, [q.envio]);
      await recusa(c, `UPDATE satisfacao_envios SET estado = 'ATIVO', revogado_em = NULL, motivo_revogacao = NULL WHERE id = $1::uuid`, [q.envio], /terminal/);
      await recusa(c, `UPDATE satisfacao_envios SET motivo_revogacao = 'CONTRATO_NAO_ASSINADO' WHERE id = $1::uuid`, [q.envio], /terminal/);
    });

    await t.test("UNIQUE: uma pesquisa por festa, uma por execução, hash único (INSERT direto e pelo serviço)", async () => {
      const p = await envioPronto();
      const x2 = await execucao(A, p.cl, p.f);
      await recusa(c, `INSERT INTO satisfacao_envios (empresa_id, fechamento_id, cliente_id, execucao_id, chave_versao, token_hash, criado_em, expira_em)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, now(), now() + interval '30 days')`, [A, p.f, p.cl, x2, randomBytes(32)], "23505");
      const r = await emTransacao((t2) => envios.criarEnvio(t2, anel, { empresaId: A, execucaoId: x2, canais: ["EMAIL"], agendadaPara: new Date(), maxTentativas: 3 }));
      assert.deepEqual(r, { criado: false, motivo: "PESQUISA_JA_EXISTE" });
      const outra = await festa();
      const xo = await execucao(A, outra.cl, outra.f);
      const hash = (await um(`SELECT token_hash FROM satisfacao_envios WHERE id = $1::uuid`, [p.envio])).token_hash;
      await recusa(c, `INSERT INTO satisfacao_envios (empresa_id, fechamento_id, cliente_id, execucao_id, chave_versao, token_hash, criado_em, expira_em)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, now(), now() + interval '30 days')`, [A, outra.f, outra.cl, xo, hash], "23505");
      await recusa(c, `INSERT INTO satisfacao_envios (empresa_id, fechamento_id, cliente_id, execucao_id, chave_versao, token_hash, criado_em, expira_em)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, now(), now() + interval '30 days')`, [A, outra.f, outra.cl, p.x, randomBytes(32)], /execução de outra festa/);
      await recusa(c, `INSERT INTO satisfacao_entregas (empresa_id, envio_id, canal, etapa, agendada_para, max_tentativas) VALUES ($1::uuid, $2::uuid, 'EMAIL', 'INICIAL', now(), 3)`, [A, p.envio], "23505");
    });

    await t.test("criação pelo serviço: contrato não assinado, festa cancelada e execução de outra ação não criam envio", async () => {
      const sem = await festa({ assinado: false });
      const xs = await execucao(A, sem.cl, sem.f);
      const r1 = await emTransacao((t2) => envios.criarEnvio(t2, anel, { empresaId: A, execucaoId: xs, canais: ["EMAIL"], agendadaPara: new Date(), maxTentativas: 3 }));
      assert.deepEqual(r1, { criado: false, motivo: "CONTRATO_NAO_ASSINADO" });
      const canc = await festa();
      const xc = await execucao(A, canc.cl, canc.f);
      await cancelarFesta(canc.f);
      const r2 = await emTransacao((t2) => envios.criarEnvio(t2, anel, { empresaId: A, execucaoId: xc, canais: ["EMAIL"], agendadaPara: new Date(), maxTentativas: 3 }));
      assert.deepEqual(r2, { criado: false, motivo: "FESTA_CANCELADA" });
      const msg = await festa();
      const r3 = await emTransacao(async (t2) => envios.criarEnvio(t2, anel, { empresaId: A, execucaoId: await execucao(A, msg.cl, msg.f, "MENSAGEM_WHATSAPP"), canais: ["EMAIL"], agendadaPara: new Date(), maxTentativas: 3 }));
      assert.deepEqual(r3, { criado: false, motivo: "EXECUCAO_INVALIDA" });
      const r4 = await emTransacao(async (t2) => envios.criarEnvio(t2, anel, { empresaId: B, execucaoId: xc, canais: ["EMAIL"], agendadaPara: new Date(), maxTentativas: 3 }));
      assert.deepEqual(r4, { criado: false, motivo: "EXECUCAO_INVALIDA" }, "execução de outra empresa");
      assert.equal(Number((await um(`SELECT count(*) AS n FROM satisfacao_envios WHERE fechamento_id = ANY($1::uuid[])`, [[sem.f, canc.f, msg.f]])).n), 0);
    });

    await t.test("resposta: CHECKs, só em envio ATIVO e válido, imutável; invariante resposta ⇔ RESPONDIDO no COMMIT", async () => {
      const p = await envioPronto();
      const insResp = `INSERT INTO satisfacao_respostas (empresa_id, envio_id, versao_questionario, nota_indicacao, nota_comida, comentario) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`;
      await recusa(c, insResp, [A, p.envio, 1, 11, null, null], /satisfacao_respostas_nps/);
      await recusa(c, insResp, [A, p.envio, 1, 8, 0, null], /satisfacao_respostas_aspectos/);
      await recusa(c, insResp, [A, p.envio, 1, 8, null, " com espaço "], /satisfacao_respostas_comentario/);
      await recusa(c, insResp, [A, p.envio, 2, 8, null, null], /satisfacao_respostas_versao/);
      await recusa(c, insResp, [B, p.envio, 1, 8, null, null], /./);
      // Resposta sem o envio RESPONDIDO: barrada no COMMIT (invariante diferida relê as tabelas).
      await c.query("BEGIN");
      await c.query(insResp, [A, p.envio, 1, 8, null, null]);
      await assert.rejects(c.query("COMMIT"), /com 1 resposta\(s\) no COMMIT/);
      // Envio RESPONDIDO sem resposta: idem.
      await c.query("BEGIN");
      await c.query(`UPDATE satisfacao_envios SET estado = 'RESPONDIDO', respondido_em = clock_timestamp() WHERE id = $1::uuid`, [p.envio]);
      await assert.rejects(c.query("COMMIT"), /RESPONDIDO com 0 resposta/);
      assert.equal((await estado(p.envio)).estado, "ATIVO");
      // Caminho correto (o do serviço) passa; depois a resposta é imutável e o envio terminal.
      await c.query("BEGIN");
      const r = (await um(`${insResp} RETURNING id::text AS id`, [A, p.envio, 1, 8, null, null])).id;
      await c.query(`UPDATE satisfacao_envios SET estado = 'RESPONDIDO', respondido_em = clock_timestamp() WHERE id = $1::uuid`, [p.envio]);
      await c.query("COMMIT");
      await recusa(c, `UPDATE satisfacao_respostas SET nota_indicacao = 10 WHERE id = $1::uuid`, [r], /imutável/);
      await recusa(c, `DELETE FROM satisfacao_respostas WHERE id = $1::uuid`, [r], /imutável/);
      await recusa(c, insResp, [A, p.envio, 1, 9, null, null], /só envio ATIVO/);
      const v = await envioNoPassado(31);
      await recusa(c, insResp, [A, v.envio, 1, 9, null, null], /só envio ATIVO e válido/);
      // Tarefa: só nota 0–6 e só na unidade do envio.
      await recusa(c, `INSERT INTO satisfacao_tarefas (empresa_id, estabelecimento_id, envio_id, resposta_id) VALUES ($1::uuid, NULL, $2::uuid, $3::uuid)`, [A, p.envio, r], /nota de 0 a 6/);
    });

    await t.test("abrir e responder: dados da festa, resposta atômica com tarefa (nota ≤ 6), segundo POST = já respondida", async () => {
      const p = await envioPronto({ nome: "  Mariana  Souza Sintética" });
      const aberta = await publico.abrirPesquisa({ token: p.token }, { ip: ip() }, deps());
      assert.deepEqual({ ...aberta, buffet: typeof aberta.buffet, dataFesta: /^2026-\d\d-\d\d$/.test(String(aberta.dataFesta)) }, { situacao: "ABERTA", primeiroNome: "Mariana", buffet: "string", unidade: null, dataFesta: true, versaoQuestionario: 1 });
      await assert.rejects(publico.responderPesquisa({ token: p.token, notaIndicacao: 4, empresaId: B }, { ip: ip() }, deps()), /Unrecognized key|unrecognized/i);
      assert.deepEqual(await publico.responderPesquisa({ token: p.token, notaIndicacao: 4, notaComida: 2, comentario: "  Atrasou o bolo  " }, { ip: ip() }, deps()), { gravada: true });
      const resp = await um(`SELECT nota_indicacao, nota_comida, nota_equipe, comentario, empresa_id::text FROM satisfacao_respostas WHERE envio_id = $1::uuid`, [p.envio]);
      assert.deepEqual(resp, { nota_indicacao: 4, nota_comida: 2, nota_equipe: null, comentario: "Atrasou o bolo", empresa_id: A });
      assert.equal((await estado(p.envio)).estado, "RESPONDIDO");
      assert.deepEqual((await entregas(p.envio)).map((x) => [x.estado, x.motivo]), [["CANCELADA", "RESPONDIDA"], ["CANCELADA", "RESPONDIDA"]]);
      assert.equal(Number((await um(`SELECT count(*) AS n FROM satisfacao_tarefas WHERE envio_id = $1::uuid AND estado = 'ABERTA'`, [p.envio])).n), 1);
      await assert.rejects(publico.responderPesquisa({ token: p.token, notaIndicacao: 10 }, { ip: ip() }, deps()), erroDe("JA_RESPONDIDA", 409));
      assert.equal((await um(`SELECT nota_indicacao FROM satisfacao_respostas WHERE envio_id = $1::uuid`, [p.envio])).nota_indicacao, 4, "não sobrescreve");
      assert.equal(Number((await um(`SELECT count(*) AS n FROM satisfacao_tarefas WHERE envio_id = $1::uuid`, [p.envio])).n), 1);
      assert.deepEqual(Object.keys(await publico.abrirPesquisa({ token: p.token }, { ip: ip() }, deps())).sort(), ["buffet", "situacao"]);
      // Nota 7+: sem tarefa.
      const q = await envioPronto();
      await publico.responderPesquisa({ token: q.token, notaIndicacao: 9 }, { ip: ip() }, deps());
      assert.equal(Number((await um(`SELECT count(*) AS n FROM satisfacao_tarefas WHERE envio_id = $1::uuid`, [q.envio])).n), 0);
    });

    await t.test("falha injetada na tarefa: nada fica gravado (resposta, estado, entregas)", async () => {
      const p = await envioPronto();
      const falha = deps({ criarTarefa: async () => { throw new Error("falha injetada na tarefa"); } });
      await assert.rejects(publico.responderPesquisa({ token: p.token, notaIndicacao: 2 }, { ip: ip() }, falha), /falha injetada/);
      assert.equal((await estado(p.envio)).estado, "ATIVO");
      assert.equal(Number((await um(`SELECT count(*) AS n FROM satisfacao_respostas WHERE envio_id = $1::uuid`, [p.envio])).n), 0);
      assert.deepEqual((await entregas(p.envio)).map((x) => x.estado), ["PENDENTE", "PENDENTE"]);
    });

    await t.test("identidade do token: geração, chave e envio de outra pesquisa recusados de forma genérica", async () => {
      const p = await envioPronto();
      for (const token of [assinarToken(anel, p.envio, 2, anel.atual), assinarToken(anel, p.envio, 1, 2), assinarToken(anel, randomUUID(), 1, anel.atual)]) {
        await assert.rejects(publico.abrirPesquisa({ token }, { ip: ip() }, deps()), erroDe("LINK_INDISPONIVEL", 404));
      }
      assert.equal((await estado(p.envio)).estado, "ATIVO");
    });

    await t.test("regeneração: chave retirada do anel gera a geração 2 (uma vez); o link antigo deixa de valer", async () => {
      const p = await envioPronto();
      const mesmo = await emTransacao((t2) => envios.linkDoEnvio(t2, anel, p.envio));
      assert.deepEqual(mesmo, { token: p.token, geracao: 1, regenerado: false });
      const novoAnel = soChave2(anel);
      const novo = await emTransacao((t2) => envios.linkDoEnvio(t2, novoAnel, p.envio));
      assert.equal(novo?.geracao, 2);
      assert.equal(novo?.regenerado, true);
      assert.deepEqual(await emTransacao((t2) => envios.linkDoEnvio(t2, novoAnel, p.envio)), { token: novo!.token, geracao: 2, regenerado: false });
      const comNovo = { ...deps(), anel: () => novoAnel };
      await assert.rejects(publico.abrirPesquisa({ token: p.token }, { ip: ip() }, deps()), erroDe("LINK_INDISPONIVEL", 404));
      assert.equal((await publico.abrirPesquisa({ token: novo!.token }, { ip: ip() }, comNovo)).situacao, "ABERTA");
    });

    await t.test("expiração (30 dias) e revogação (festa cancelada, contrato não assinado); RESPONDIDO se preserva", async () => {
      const v = await envioNoPassado(31);
      await assert.rejects(publico.abrirPesquisa({ token: v.token }, { ip: ip() }, deps()), erroDe("LINK_INDISPONIVEL", 404));
      assert.equal((await estado(v.envio)).estado, "EXPIRADO");
      assert.deepEqual((await entregas(v.envio)).map((x) => [x.estado, x.motivo]), [["CANCELADA", "EXPIRADO"], ["CANCELADA", "EXPIRADO"]]);
      const p = await envioPronto();
      await cancelarFesta(p.f);
      await assert.rejects(publico.responderPesquisa({ token: p.token, notaIndicacao: 3 }, { ip: ip() }, deps()), erroDe("LINK_INDISPONIVEL", 404));
      assert.deepEqual([(await estado(p.envio)).estado, (await estado(p.envio)).motivo_revogacao], ["REVOGADO", "FESTA_CANCELADA"]);
      assert.equal(Number((await um(`SELECT count(*) AS n FROM satisfacao_respostas WHERE envio_id = $1::uuid`, [p.envio])).n), 0);
      const q = await envioPronto();
      await c.query(`UPDATE contratos SET status = 'CANCELADO', cancelado_em = clock_timestamp() WHERE fechamento_id = $1::uuid`, [q.f]);
      await assert.rejects(publico.abrirPesquisa({ token: q.token }, { ip: ip() }, deps()), erroDe("LINK_INDISPONIVEL", 404));
      assert.equal((await estado(q.envio)).motivo_revogacao, "CONTRATO_NAO_ASSINADO");
      const r = await envioPronto();
      await publico.responderPesquisa({ token: r.token, notaIndicacao: 10 }, { ip: ip() }, deps());
      await cancelarFesta(r.f);
      assert.equal((await publico.abrirPesquisa({ token: r.token }, { ip: ip() }, deps())).situacao, "RESPONDIDA");
      assert.equal((await estado(r.envio)).estado, "RESPONDIDO");
    });

    await t.test("entrega: nasce PENDENTE; ENVIANDO exige envio ATIVO, prazo (−24 h) e segundo canal até 48 h do marco; marco = início da tentativa", async () => {
      const p = await envioPronto();
      await recusa(c, `INSERT INTO satisfacao_entregas (empresa_id, envio_id, canal, etapa, estado, agendada_para, max_tentativas) VALUES ($1::uuid, $2::uuid, 'EMAIL', 'LEMBRETE', 'ENVIANDO', now(), 3)`, [A, p.envio], /nasce PENDENTE/);
      const enviando = `UPDATE satisfacao_entregas SET estado = 'ENVIANDO', posse_token = gen_random_uuid(), posse_ate = now() + interval '5 min', tentativa_iniciada_em = $3::timestamptz
        WHERE envio_id = $1::uuid AND canal = $2 AND etapa = 'INICIAL'`;
      const inicio = (await um(`SELECT clock_timestamp() AS t`)).t;
      await c.query(enviando, [p.envio, "WHATSAPP", inicio]);
      assert.equal((await estado(p.envio)).contato_em, null, "ENVIANDO ainda não é contato");
      await c.query(`UPDATE satisfacao_entregas SET estado = 'INCERTA', posse_token = NULL, posse_ate = NULL WHERE envio_id = $1::uuid AND canal = 'WHATSAPP'`, [p.envio]);
      assert.equal(((await estado(p.envio)).contato_em as Date).getTime(), (inicio as Date).getTime(), "marco = início da tentativa, na mesma instrução");
      await recusa(c, `UPDATE satisfacao_entregas SET canal = 'EMAIL' WHERE envio_id = $1::uuid AND canal = 'WHATSAPP'`, [p.envio], /identidade da entrega/);
      await recusa(c, `DELETE FROM satisfacao_entregas WHERE envio_id = $1::uuid`, [p.envio], /não é apagada/);
      // Prazo: envio criado há 29,5 dias → ainda ATIVO e válido (12 h), mas a menos de 24 h de expirar.
      const velho = await envioNoPassado(29.5);
      await recusa(c, enviando, [velho.envio, "EMAIL", new Date()], /PRAZO_ESGOTADO/);
      // Segundo canal: marco há 49 h.
      const segundo = await envioNoPassado(5);
      await c.query(`UPDATE satisfacao_envios SET contato_em = now() - interval '49 hours' WHERE id = $1::uuid`, [segundo.envio]);
      await recusa(c, enviando, [segundo.envio, "EMAIL", new Date()], /SEGUNDO_CANAL_FORA_DO_PRAZO/);
      // Envio terminal: nada passa a ENVIANDO; entrega concluída é terminal.
      await c.query(`UPDATE satisfacao_entregas SET estado = 'CANCELADA', concluida_em = now() WHERE envio_id = $1::uuid AND canal = 'EMAIL'`, [p.envio]);
      await recusa(c, enviando, [p.envio, "EMAIL", new Date()], /concluída não muda/);
    });

    await t.test("frequência: reserva viva conta como contato agora; marco dentro do limite conta; exceto o próprio envio", async () => {
      const p = await envioPronto();
      assert.equal(await motor.frequenciaExcedida(tx, A, p.cl, 30, null), true, "INICIAL PENDENTE sem marco = reserva viva");
      assert.equal(await motor.frequenciaExcedida(tx, A, p.cl, 30, null, p.envio), false, "o próprio envio não se bloqueia");
      await c.query(`UPDATE satisfacao_entregas SET estado = 'SUPRIMIDA', concluida_em = now() WHERE envio_id = $1::uuid`, [p.envio]);
      assert.equal(await motor.frequenciaExcedida(tx, A, p.cl, 30, null), false, "sem reserva e sem marco");
      const q = await envioNoPassado(40);
      await c.query(`UPDATE satisfacao_entregas SET estado = 'SUPRIMIDA', concluida_em = now() WHERE envio_id = $1::uuid`, [q.envio]);
      await c.query(`UPDATE satisfacao_envios SET contato_em = criado_em + interval '1 day' WHERE id = $1::uuid`, [q.envio]);
      assert.equal(await motor.frequenciaExcedida(tx, A, q.cl, 30, null), false, "marco há 39 dias, limite 30");
      assert.equal(await motor.frequenciaExcedida(tx, A, q.cl, 60, null), true, "marco há 39 dias, limite 60");
      assert.equal(await motor.frequenciaExcedida(tx, B, q.cl, 60, null), false, "outra empresa");
    });

    await t.test("limites: com IP 30 aberturas/10 min; sem IP 5 por token (outro token não é afetado); 429 com Retry-After", async () => {
      const p = await envioPronto(), q = await envioPronto();
      const meuIp = ip();
      for (let i = 0; i < 30; i++) await publico.abrirPesquisa({ token: p.token }, { ip: meuIp }, deps());
      await assert.rejects(publico.abrirPesquisa({ token: p.token }, { ip: meuIp }, deps()),
        (e: unknown) => erroDe("MUITAS_TENTATIVAS", 429)(e) && Number((e as { details?: { retryAfterSegundos?: number } }).details?.retryAfterSegundos) > 0);
      await publico.abrirPesquisa({ token: p.token }, { ip: ip() }, deps());
      for (let i = 0; i < 5; i++) await publico.abrirPesquisa({ token: p.token }, { ip: null }, deps());
      await assert.rejects(publico.abrirPesquisa({ token: p.token }, { ip: null }, deps()), erroDe("MUITAS_TENTATIVAS", 429));
      await publico.abrirPesquisa({ token: q.token }, { ip: null }, deps());
      const r = await envioPronto(), ipR = ip();
      for (let i = 0; i < 10; i++) await assert.rejects(publico.responderPesquisa({ token: r.token, notaIndicacao: 99 }, { ip: ipR }, deps()));
      await assert.rejects(publico.responderPesquisa({ token: r.token, notaIndicacao: 9 }, { ip: ipR }, deps()), erroDe("MUITAS_TENTATIVAS", 429));
      assert.equal((await estado(r.envio)).estado, "ATIVO");
    });

    await t.test("saída das pesquisas: os dois canais e a execução AGENDADA da pesquisa; Mensagem simples intacta; aceita envio encerrado", async () => {
      const p = await envioPronto();
      const outraFesta = await outraFestaDoCliente(p.cl);
      const xPesquisa = await execucao(A, p.cl, outraFesta);
      const xMsg = await execucao(A, p.cl, outraFesta, "MENSAGEM_WHATSAPP");
      await publico.responderPesquisa({ token: p.token, notaIndicacao: 8 }, { ip: ip() }, deps());
      assert.deepEqual(await publico.sairDasPesquisas({ token: p.token }, { ip: ip() }, deps()), { saiu: true });
      assert.equal((await um(`SELECT origem FROM satisfacao_saidas WHERE empresa_id = $1::uuid AND cliente_id = $2::uuid`, [A, p.cl])).origem, "PAGINA");
      const estados = async (id: string) => (await um(`SELECT estado, motivo FROM marketing_automacao_execucoes WHERE id = $1::uuid`, [id]));
      assert.deepEqual(await estados(xPesquisa), { estado: "SUPRIMIDA", motivo: "SAIDA_PESQUISAS" });
      assert.equal((await estados(xMsg)).estado, "AGENDADA", "Mensagem simples não é alcançada pela saída das pesquisas");
      assert.deepEqual(await publico.sairDasPesquisas({ token: p.token, origem: "LINK_EMAIL" }, { ip: ip() }, deps()), { saiu: true }, "repetir não falha");
      await assert.rejects(publico.sairDasPesquisas({ token: p.token, origem: "EQUIPE" }, { ip: ip() }, deps()), erroDe("LINK_INDISPONIVEL", 404));
    });

    await t.test("alcance: descadastro cancela tudo; revogar autorização e PARAR só o WhatsApp; e-mail continua", async () => {
      const autorizar = async (cl: string, telefone: string) => pref.alterarPreferencia(tx, A, usuario, { acao: "preferencia", clienteId: cl, operacao: "autorizar", destino: telefone, confirmacao: "Autorizou (sintético)" });
      const d = await envioPronto();
      const xMsg = await execucao(A, d.cl, d.f, "MENSAGEM_WHATSAPP");
      await emTransacao((t2) => pref.alterarPreferencia(t2, A, usuario, { acao: "preferencia", clienteId: d.cl, operacao: "descadastrar", confirmacao: "Pediu para sair (sintético)" }));
      assert.deepEqual((await entregas(d.envio)).map((x) => [x.canal, x.estado, x.motivo]), [["EMAIL", "SUPRIMIDA", "DESCADASTRADO"], ["WHATSAPP", "SUPRIMIDA", "DESCADASTRADO"]]);
      assert.equal((await um(`SELECT estado FROM marketing_automacao_execucoes WHERE id = $1::uuid`, [xMsg])).estado, "SUPRIMIDA");

      const r = await envioPronto();
      await emTransacao(() => autorizar(r.cl, r.telefone));
      const aut = (await um(`SELECT id::text AS id FROM marketing_contato_autorizacoes WHERE cliente_id = $1::uuid AND estado <> 'REVOGADA'`, [r.cl])).id;
      await emTransacao((t2) => pref.alterarPreferencia(t2, A, usuario, { acao: "preferencia", clienteId: r.cl, operacao: "revogar", autorizacaoId: aut, confirmacao: "Revogou (sintético)" }));
      assert.deepEqual((await entregas(r.envio)).map((x) => [x.canal, x.estado]), [["EMAIL", "PENDENTE"], ["WHATSAPP", "SUPRIMIDA"]]);

      const s = await envioPronto();
      assert.deepEqual(await supressao.clientesDoNumero(tx, A, s.telefone), [s.cl], "com DDI");
      assert.deepEqual(await supressao.clientesDoNumero(tx, A, s.telefone.slice(2)), [s.cl], "sem DDI");
      assert.deepEqual(await supressao.clientesDoNumero(tx, B, s.telefone), [], "outra empresa");
      await emTransacao((t2) => supressao.suprimirPesquisas(t2, A, s.cl, { canal: "WHATSAPP", motivo: "PARAR" }));
      assert.deepEqual((await entregas(s.envio)).map((x) => [x.canal, x.estado]), [["EMAIL", "PENDENTE"], ["WHATSAPP", "SUPRIMIDA"]]);
    });

    await t.test("bloqueio do WhatsApp: novo ⊇ antigo; conversa com PARAR passa a bloquear; qualquer ambiente; com/sem DDI; outra empresa não", async () => {
      // Predicado antigo (até a 110): só os controles, sem filtro de ambiente, destino com e sem DDI.
      const antigo = async (e: string, destino: string) => {
        const nacional = destino.startsWith("55") ? destino.slice(2) : destino;
        return (await c.query(`SELECT 1 FROM whatsapp_atendimento_controles_contato WHERE empresa_id = $1::uuid AND nao_contatar AND contato IN ($2, $3) LIMIT 1`, [e, destino, nacional])).rows.length > 0;
      };
      const casos: Array<{ nome: string; preparar: (n: string) => Promise<void>; esperado: boolean; mudou?: boolean }> = [
        { nome: "nenhum registro", preparar: async () => {}, esperado: false },
        { nome: "controle staging", preparar: async (n) => { await c.query(`INSERT INTO whatsapp_atendimento_controles_contato (empresa_id, ambiente, contato, nao_contatar) VALUES ($1::uuid, 'staging', $2, true)`, [A, n]); }, esperado: true },
        { nome: "controle production sem DDI", preparar: async (n) => { await c.query(`INSERT INTO whatsapp_atendimento_controles_contato (empresa_id, ambiente, contato, nao_contatar) VALUES ($1::uuid, 'production', $2, true)`, [A, n.slice(2)]); }, esperado: true },
        { nome: "só conversa com PARAR", preparar: async (n) => { await c.query(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, nao_contatar) VALUES ($1::uuid, 'production', $2, true)`, [A, n]); }, esperado: true, mudou: true },
        { nome: "conversa sem PARAR", preparar: async (n) => { await c.query(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato) VALUES ($1::uuid, 'staging', $2)`, [A, n]); }, esperado: false },
        { nome: "controle e conversa de outra empresa", preparar: async (n) => {
          await c.query(`INSERT INTO whatsapp_atendimento_controles_contato (empresa_id, ambiente, contato, nao_contatar) VALUES ($1::uuid, 'staging', $2, true)`, [B, n]);
          await c.query(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, nao_contatar) VALUES ($1::uuid, 'staging', $2, true)`, [B, n]);
        }, esperado: false },
      ];
      let n = 0;
      for (const caso of casos) {
        const numero = `55119777${String(10000 + ++n).padStart(5, "0")}`;
        await caso.preparar(numero);
        const velho = await antigo(A, numero), novo = await pref.bloqueioWhatsappDoDestino(tx, A, numero);
        assert.equal(novo, caso.esperado, caso.nome);
        assert.equal(velho, caso.mudou ? false : caso.esperado, `${caso.nome} (antigo)`);
        assert.ok(novo || !velho, `${caso.nome}: o novo nunca libera o que o antigo bloqueava`);
      }
    });

    await t.test("sigilo (N7): o link e o seu prefixo não aparecem em nenhuma tabela, log da aplicação nem mensagem de erro", async () => {
      const capturado: string[] = [];
      const metodos = ["log", "info", "warn", "error", "debug"] as const;
      const originais = metodos.map((m) => console[m]);
      for (const m of metodos) console[m] = (...a: unknown[]) => { capturado.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
      const erros: string[] = [];
      const p = await envioPronto(), vencido = await envioNoPassado(31);
      const adulterado = `${p.token.slice(0, -2)}${p.token.endsWith("A") ? "BA" : "AA"}`;
      try {
        await publico.abrirPesquisa({ token: p.token }, { ip: ip() }, deps());
        await publico.responderPesquisa({ token: p.token, notaIndicacao: 3, comentario: "Sem sigilo quebrado" }, { ip: ip() }, deps());
        for (const tentativa of [
          () => publico.responderPesquisa({ token: p.token, notaIndicacao: 8 }, { ip: ip() }, deps()),
          () => publico.abrirPesquisa({ token: adulterado }, { ip: ip() }, deps()),
          () => publico.abrirPesquisa({ token: vencido.token }, { ip: null }, deps()),
          () => publico.responderPesquisa({ token: vencido.token, notaIndicacao: 5 }, { ip: ip() }, deps()),
          () => publico.responderPesquisa({ token: p.token, notaIndicacao: 11 }, { ip: ip() }, deps()),
          () => publico.responderPesquisa({ token: p.token, notaIndicacao: 2 }, { ip: ip() }, deps({ criarTarefa: async () => { throw new Error("falha"); } })),
        ]) {
          try { await tentativa(); erros.push("(sem erro)"); } catch (e) { erros.push(`${(e as Error).message} ${JSON.stringify(e)}`); }
        }
      } finally {
        metodos.forEach((m, i) => { console[m] = originais[i]!; });
      }
      assert.equal(erros.length, 6);
      for (const token of [p.token, vencido.token]) {
        for (const trecho of [token, token.slice(0, 16)]) {
          const tabelas = (await c.query<{ t: string }>(`SELECT quote_ident(table_name) AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).rows.map((r) => r.t);
          for (const tabela of tabelas) {
            const n = Number((await c.query(`SELECT count(*) AS n FROM public.${tabela} x WHERE strpos(x::text, $1) > 0`, [trecho])).rows[0].n);
            assert.equal(n, 0, `trecho do link na tabela ${tabela}`);
          }
          for (const linha of [...capturado, ...erros]) assert.equal(linha.includes(trecho), false, `trecho do link em log ou erro: ${linha.slice(0, 80)}`);
        }
      }
    });
  } finally {
    await encerrarDescartavel(c);
  }
});
