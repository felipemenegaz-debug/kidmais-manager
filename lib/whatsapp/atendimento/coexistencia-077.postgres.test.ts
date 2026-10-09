import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";

/**
 * Coexistência da 077 (fotos/vídeos; origem da mídia com FK para as prontas) com 060 (atendimento), 063 (painel),
 * 076 (mensagens prontas) e 065 (nome de perfil), no PostgreSQL descartável (modelo "063": 055…063, com a 060). Só pelo
 * check:v1:postgres, com opt-in e autorização explícita do Felipe. Dados sintéticos; transporte simulado; nenhuma rede.
 *
 *  C1 ordem 076 → 077 → 065 (a 077 antes da 065): os cinco postchecks passam;
 *  C2 painel sai (sem uso) e volta com 060/076/065/077 presentes: precheck, migration e postcheck da 063 ok;
 *  C3 dados de todos os lados: sessão com empresa ativa (063), nome de perfil (065), pronta de foto com atalho novo e
 *     saída com mídia enviada pelo worker (077, versão da prévia gravada);
 *  C4 rollback cruzado:
 *     a) a 065 sai com a 077 presente (e volta): mídia, origem e tela intactas;
 *     b) a 076 NÃO sai com a 077 presente (guarda explícita do down, antes de travar; nada removido);
 *     c) a 063 em uso recusa o próprio rollback (a 077 não interfere);
 *     d) a 077 sai (com as decisões explícitas) com a 065 presente; 060/063/076/065 e a sessão intactas; a tela segue;
 *     e) só então a 076 sai; reaplicação na ordem 076 → 065 já presente → 077 (a 077 depois da 065): postchecks ok.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const POST060 = ler("database/checks/20261001_060_postcheck.sql");
const PRE063 = ler("database/checks/20261004_063_precheck.sql");
const UP063 = ler("database/migrations/20261004_063_painel_desenvolvedor.sql");
const POST063 = ler("database/checks/20261004_063_postcheck.sql");
const DOWN063 = ler("database/rollback/20261004_063_painel_desenvolvedor_down.sql");
const UP076 = ler("database/migrations/20261009_076_whatsapp_mensagens_prontas.sql");
const POST076 = ler("database/checks/20261009_076_postcheck.sql");
const DOWN076 = ler("database/rollback/20261009_076_whatsapp_mensagens_prontas_down.sql");
const POS_DOWN076 = ler("database/checks/20261009_076_rollback_postcheck.sql");
const UP065 = ler("database/migrations/20261004_065_whatsapp_nome_perfil.sql");
const POST065 = ler("database/checks/20261004_065_postcheck.sql");
const DOWN065 = ler("database/rollback/20261004_065_whatsapp_nome_perfil_down.sql");
const POS_DOWN065 = ler("database/checks/20261004_065_rollback_postcheck.sql");
const UP077 = ler("database/migrations/20261009_077_whatsapp_prontas_midia.sql");
const POST077 = ler("database/checks/20261009_077_postcheck.sql");
const DOWN077 = ler("database/rollback/20261009_077_whatsapp_prontas_midia_down.sql");
const POS_DOWN077 = ler("database/checks/20261009_077_rollback_postcheck.sql");
const comDecisoes = (sql: string, ...chaves: string[]) => sql.replace("SET LOCAL statement_timeout = '60s';", ["SET LOCAL statement_timeout = '60s';", ...chaves.map((k) => `SET LOCAL ${k} = 'sim';`)].join("\n"));
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;

test("coexistência da 077 com 060/063/076/065: as duas ordens, dados de todos os lados e rollback cruzado", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const postchecks = async (rotulo: string, quais: [string, string][]) => { for (const [n, sql] of quais) await assert.doesNotReject(c.query(sql), `${rotulo}: postcheck ${n}`); };
  const cinco = (rotulo: string) => postchecks(rotulo, [["060", POST060], ["063", POST063], ["076", POST076], ["065", POST065], ["077", POST077]]);
  try {
    // C1 — 076 → 077 → 065 (a 077 antes da 065).
    await c.query(POST060); await c.query(POST063);
    await c.query(UP076); await c.query(POST076);
    await c.query(UP077); await c.query(POST077);
    await c.query(UP065); await c.query(POST065);
    await cinco("C1");

    // C2 — painel sai (sem uso) e volta com 060/076/065/077 presentes.
    await c.query(DOWN063);
    assert.equal((await c.query("SELECT to_regclass('public.convites_acesso') AS t")).rows[0].t, null, "C2: 063 fora");
    await postchecks("C2 sem a 063", [["060", POST060], ["076", POST076], ["065", POST065], ["077", POST077]]);
    await c.query(PRE063); await c.query(UP063); await c.query(POST063);
    await cinco("C2");

    // C3 — dados de todos os lados.
    const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
    const A = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa sintética (coexistência 077)', 'PROVISIONAMENTO') RETURNING id`, [cod("cx")]);
    await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [A]);
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness coexistência 077', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [A, u]);
    await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), A]);
    const sessao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", id: s, empresa_ativa_id: A } as never;
    const { servico, worker, biblioteca } = carregarAtendimento(A);
    await servico.salvarConfiguracao(sessao, { ativo: true, nome: "Empresa sintética", perguntas: [] });
    const contato = "5561900000501";
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "Olá", timestamp: Date.now() - 60_000, nomePerfil: "Perfil coexistência 077" });
    const conversa = async () => (await c.query("SELECT id, versao FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    let cv = await conversa();
    await servico.controlarAtendimento(sessao, { acao: "assumir", conversaId: cv.id, versao: Number(cv.versao) });
    const foto = (await biblioteca.salvarPronta(sessao, { titulo: "Foto coexistência", categoria: "Teste", tipo: "IMAGEM", texto: "Legenda", link: null, atalho: "SALGADOS", midiaUrl: "https://midia.exemplo.test/cx.jpg" })).id;
    await biblioteca.salvarPronta(sessao, { titulo: "Texto coexistência", categoria: "Teste", tipo: "TEXTO", texto: "texto", link: null, atalho: null });
    const vista = (await biblioteca.prepararRascunho(sessao, { conversaId: cv.id, id: foto })).midia!;
    cv = await conversa();
    await servico.controlarAtendimento(sessao, { acao: "enviar", conversaId: cv.id, versao: Number(cv.versao), prontaMidiaId: foto, prontaVersao: vista.versao, texto: "Legenda revisada" });
    const envios: ConteudoSaida[] = [];
    await worker.processarLote({ interpretar: async () => { throw new Error("sem modelo"); }, enviar: async (_c: string, conteudo: ConteudoSaida) => { envios.push(conteudo); return cod("gs-"); } }, { maxTarefas: 10 });
    assert.deepEqual(envios, [{ tipo: "IMAGEM", url: "https://midia.exemplo.test/cx.jpg", legenda: "Legenda revisada" }], "C3: a mídia revisada sai pelo transporte simulado");
    const tela = async () => { const r = await servico.listarAtendimento(sessao, cv.id); return { perfil: r.conversas.find((x) => x.contato === contato)!.nome_perfil, saidas: r.mensagens.filter((x) => x.direcao === "SAIDA").map((x) => [x.estado, x.midia_tipo, x.texto]) }; };
    assert.deepEqual(await tela(), { perfil: "Perfil coexistência 077", saidas: [["SUBMETIDA", "IMAGEM", "Legenda revisada"]] }, "C3: tela com empresa ativa, nome de perfil e mídia");
    const origem = async () => (await c.query("SELECT midia_pronta_id, midia_pronta_versao::int AS v FROM whatsapp_atendimento_mensagens WHERE direcao = 'SAIDA' AND empresa_id = $1", [A])).rows;
    assert.deepEqual(await origem(), [{ midia_pronta_id: foto, v: vista.versao }]);
    await cinco("C3");

    // C4a — a 065 sai com a 077 presente (e volta): mídia, origem e tela intactas.
    await c.query(comDecisoes(DOWN065, "kidmais.rollback_065_descartar_nomes")); await c.query(POS_DOWN065);
    await postchecks("C4a sem a 065", [["060", POST060], ["063", POST063], ["076", POST076], ["077", POST077]]);
    assert.deepEqual(await tela(), { perfil: null, saidas: [["SUBMETIDA", "IMAGEM", "Legenda revisada"]] }, "C4a: sem a 065 a tela segue com a mídia");
    assert.deepEqual(await origem(), [{ midia_pronta_id: foto, v: vista.versao }]);
    await c.query(UP065); await c.query(POST065);
    await cinco("C4a reaplicada");
    // O rollback da 065 descartou os nomes (decisão explícita): o nome volta com a próxima mensagem do contato.
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "Oi de novo", timestamp: Date.now(), nomePerfil: "Perfil coexistência 077" });
    assert.equal((await tela()).perfil, "Perfil coexistência 077", "C4a: nome de perfil de volta com a 077 presente");

    // C4b — a 076 NÃO sai com a 077 presente: a guarda do down recusa antes de travar ou alterar; nada é removido.
    const prontas = Number((await c.query("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens_prontas")).rows[0].n);
    await assert.rejects(c.query(comDecisoes(DOWN076, "kidmais.rollback_076_descartar_prontas")), /Rollback da 076 recusado: a 077 ou a 078 ainda estão aplicadas/); await c.query("ROLLBACK").catch(() => {});
    assert.equal(Number((await c.query("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens_prontas")).rows[0].n), prontas, "C4b: prontas intactas");
    assert.ok((await c.query("SELECT to_regclass('public.whatsapp_atendimento_mensagens_prontas_favoritas') AS t")).rows[0].t, "C4b: favoritas intactas");
    await cinco("C4b");

    // C4c — a 063 em uso recusa o próprio rollback; a 077 não interfere.
    await assert.rejects(c.query(DOWN063), /Rollback 063/); await c.query("ROLLBACK").catch(() => {});
    await cinco("C4c");

    // C4d — a 077 sai (decisões explícitas) com a 065 presente; o resto e a sessão ficam; a tela segue.
    await assert.rejects(c.query(DOWN077), /respostas enviadas com mídia/); await c.query("ROLLBACK").catch(() => {});
    await c.query(comDecisoes(DOWN077, "kidmais.rollback_077_descartar_midias", "kidmais.rollback_077_descartar_prontas_midia")); await c.query(POS_DOWN077);
    await postchecks("C4d sem a 077", [["060", POST060], ["063", POST063], ["076", POST076], ["065", POST065]]);
    assert.equal((await c.query("SELECT empresa_ativa_id::text AS e FROM sessoes_administrativas WHERE id = $1::uuid", [s])).rows[0].e, A, "C4d: sessão com empresa ativa intacta");
    assert.deepEqual(await tela(), { perfil: "Perfil coexistência 077", saidas: [["SUBMETIDA", null, "Legenda revisada"]] }, "C4d: sem a 077 a tela segue (sem cache), com o nome de perfil");
    assert.deepEqual((await c.query("SELECT titulo FROM whatsapp_atendimento_mensagens_prontas WHERE empresa_id = $1", [A])).rows.map((r) => r.titulo), ["Texto coexistência"], "C4d: só a pronta de texto fica");

    // C4e — agora a 076 sai; reaplicação 076 → (065 presente) → 077: a 077 depois da 065.
    await c.query(comDecisoes(DOWN076, "kidmais.rollback_076_descartar_prontas")); await c.query(POS_DOWN076);
    await postchecks("C4e sem 076/077", [["060", POST060], ["063", POST063], ["065", POST065]]);
    await c.query(UP076); await c.query(POST076); await c.query(UP077); await c.query(POST077);
    await cinco("C4e reaplicadas");
    assert.equal((await tela()).perfil, "Perfil coexistência 077");
    assert.equal(envios.length, 1, "nenhum reenvio em todo o roteiro");
  } finally {
    await c.end();
  }
});
