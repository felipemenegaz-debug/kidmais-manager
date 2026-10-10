import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";

/**
 * Candidata de integração (07/10/2026): coexistência e rollback cruzado do atendimento (060, 065, 077a, 077b, 078) com
 * as migrations novas de staging (064 reimportação, 066 Pix, 067 modelo comercial, 068 cobrança, 069 cadastro
 * público e, desde 07/10 à tarde, 070 adicionais do buffet — que só altera a tabela adicionais: entra na sequência de
 * staging com pré e postcheck e no rollback; a impressão digital continua nas tabelas novas de staging), no PostgreSQL descartável (modelo "063": 055…063, com a 060). Só pelo check:v1:postgres, com opt-in e
 * autorização explícita do Felipe. Dados sintéticos; transporte simulado; nenhuma rede.
 *
 *  X1 atendimento primeiro (065 → 077a → 077b → 078) e dados dele (sessão, nome de perfil, prontas, saída com mídia);
 *  X2 staging por cima (064 → 066 → 067 → 068 → 069, com pré e postchecks): os postchecks dos dois lados passam;
 *  X3 rollback de TODO o staging (069 → 068 → 067 → 066 → 064) com o atendimento presente: os dados e os objetos do
 *     atendimento ficam idênticos (impressão digital) e os postchecks dele passam; staging reaplicado;
 *  X4 dados das funcionalidades de staging (chave Pix, exceção comercial, cadastro público pendente);
 *  X5 rollback de TODO o atendimento (078 → 077b → 065 → 077a → 060, com as decisões explícitas) com os dados de staging:
 *     os dados e os objetos de staging ficam idênticos e os postchecks de staging passam; nenhuma tabela do atendimento
 *     sobra;
 *  X6 atendimento reaplicado depois de staging (a outra ordem): postchecks dos dois lados;
 *  X7 com dados, os rollbacks de staging recusam (falham fechado) e nada é removido.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const comDecisoes = (sql: string, ...chaves: string[]) => sql.replace("SET LOCAL statement_timeout = '60s';", ["SET LOCAL statement_timeout = '60s';", ...chaves.map((k) => `SET LOCAL ${k} = 'sim';`)].join("\n"));
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;

// Atendimento (060 no modelo 063).
const A060 = { pre: null, up: ler("database/migrations/20261001_060_whatsapp_atendimento.sql"), post: ler("database/checks/20261001_060_postcheck.sql"),
  down: ler("database/rollback/20261001_060_whatsapp_atendimento_down.sql"), preDown: ler("database/checks/20261001_060_rollback_precheck.sql"), posDown: ler("database/checks/20261001_060_rollback_postcheck.sql") };
const A065 = { up: ler("database/migrations/20261004_065_whatsapp_nome_perfil.sql"), post: ler("database/checks/20261004_065_postcheck.sql"),
  down: ler("database/rollback/20261004_065_whatsapp_nome_perfil_down.sql"), posDown: ler("database/checks/20261004_065_rollback_postcheck.sql") };
const A077A = { up: ler("database/migrations/20261009_077a_whatsapp_mensagens_prontas.sql"), post: ler("database/checks/20261009_077a_postcheck.sql"),
  down: ler("database/rollback/20261009_077a_whatsapp_mensagens_prontas_down.sql"), posDown: ler("database/checks/20261009_077a_rollback_postcheck.sql") };
const A077B = { up: ler("database/migrations/20261009_077b_whatsapp_prontas_midia.sql"), post: ler("database/checks/20261009_077b_postcheck.sql"),
  down: ler("database/rollback/20261009_077b_whatsapp_prontas_midia_down.sql"), posDown: ler("database/checks/20261009_077b_rollback_postcheck.sql") };
const A078 = { up: ler("database/migrations/20261009_078_wall_e_atendimento.sql"), post: ler("database/checks/20261009_078_postcheck.sql"),
  down: ler("database/rollback/20261009_078_wall_e_atendimento_down.sql") };
// Staging.
const st = (data: string, n: string, nome: string) => ({ n, pre: ler(`database/checks/${data}_${n}_precheck.sql`), up: ler(`database/migrations/${data}_${n}_${nome}.sql`),
  post: ler(`database/checks/${data}_${n}_postcheck.sql`), down: ler(`database/rollback/${data}_${n}_${nome}_down.sql`) });
const STAGING = [st("20261006", "064", "reimportacao_apos_cancelamento"), st("20261006", "066", "pix_recebimento_empresa"), st("20261006", "067", "modelo_comercial_empresa"),
  st("20261007", "068", "cobranca_assinatura"), st("20261007", "069", "cadastro_publico"), st("20261007", "070", "adicionais_do_buffet")];
const TABELAS_STAGING = ["empresa_pix_recebimento", "empresa_assinaturas", "empresa_excecoes_comerciais", "empresa_representacoes", "cobranca_eventos", "cadastros_publicos",
  "aceites_documentos_legais", "cadastros_empresas", "empresa_socios", "solicitacoes_acesso_empresa"];

test("coexistência e rollback cruzado do atendimento com 064/066/067/068/069/070 de staging, preservando os dados dos dois lados", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  const existe = async (tabela: string) => (await q("SELECT to_regclass($1) IS NOT NULL AS e", [`public.${tabela}`])).rows[0].e as boolean;
  // Impressão digital dos DADOS de uma lista de tabelas (as ausentes contam como ausentes).
  const dados = async (tabelas: string[]) => {
    const r: Record<string, string> = {};
    for (const tb of tabelas) r[tb] = (await existe(tb)) ? (await q(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*)::int AS n FROM ${tb} x`)).rows.map((x) => `${x.n}:${x.h}`)[0] : "ausente";
    return r;
  };
  const tabelasAtendimento = async () => (await q("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'whatsapp\\_atendimento\\_%' ORDER BY 1")).rows.map((x) => x.tablename as string);
  // Impressão digital dos OBJETOS: funções e gatilhos pelo prefixo da migration; restrições e índices pelas tabelas.
  const objetos = async (prefixoFuncao: string, tabelas: string[]) => (await q(`SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS h, count(*)::int AS n FROM (
      SELECT 'f:' || p.proname || ':' || md5(pg_get_functiondef(p.oid)) AS x FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname ~ $1
      UNION ALL SELECT 't:' || cl.relname || ':' || tg.tgname || ':' || md5(pg_get_triggerdef(tg.oid)) FROM pg_trigger tg JOIN pg_class cl ON cl.oid = tg.tgrelid JOIN pg_proc p ON p.oid = tg.tgfoid WHERE NOT tg.tgisinternal AND (p.proname ~ $1 OR cl.relname = ANY($2))
      UNION ALL SELECT 'c:' || cl.relname || ':' || co.conname || ':' || md5(pg_get_constraintdef(co.oid)) FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid WHERE cl.relname = ANY($2)
      UNION ALL SELECT 'i:' || ic.relname || ':' || md5(pg_get_indexdef(ix.indexrelid)) FROM pg_index ix JOIN pg_class cl ON cl.oid = ix.indrelid JOIN pg_class ic ON ic.oid = ix.indexrelid WHERE cl.relname = ANY($2)
    ) s`, [prefixoFuncao, tabelas])).rows.map((x) => `${x.n}:${x.h}`)[0];
  const FUNCOES_STAGING = "^kidmais_?(06[46789]|070)"; // 064, 066–070 de staging (a 065 é do atendimento)
  // 060, 065, 077a, 077b e 078 do atendimento. Sem 07[6-8]: desde 10/10 a 076 e a 077 são do staging (CPF e regras de
  // pagamento por empresa) e uma função delas não pode ser contada como do atendimento.
  const FUNCOES_ATENDIMENTO = "^kidmais_?(060|065|077[ab]|078)";
  const retratoStaging = async () => ({ dados: await dados(TABELAS_STAGING), objetos: await objetos(FUNCOES_STAGING, TABELAS_STAGING) });
  const retratoAtendimento = async () => { const tb = await tabelasAtendimento(); return { tabelas: tb, dados: await dados(tb), objetos: await objetos(FUNCOES_ATENDIMENTO, tb) }; };
  const postStaging = async (rotulo: string) => { for (const s of STAGING) await assert.doesNotReject(q(s.post), `${rotulo}: postcheck ${s.n}`); };
  const postAtendimento = async (rotulo: string) => { for (const [n, sql] of [["060", A060.post], ["065", A065.post], ["077a", A077A.post], ["077b", A077B.post], ["078", A078.post]] as const) await assert.doesNotReject(q(sql), `${rotulo}: postcheck ${n}`); };
  try {
    // X1 — atendimento primeiro e os dados dele.
    await q(A060.post);
    for (const m of [A065, A077A, A077B, A078]) { await q(m.up); await q(m.post); }
    await postAtendimento("X1");
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const A = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa sintética (coexistência staging)', 'PROVISIONAMENTO') RETURNING id`, [cod("cs")]);
    await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [A]);
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness coexistência staging', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [A, u]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), A]);
    const sessao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", id: s, empresa_ativa_id: A } as never;
    const { servico, worker, biblioteca } = carregarAtendimento(A);
    await servico.salvarConfiguracao(sessao, { ativo: true, nome: "Empresa sintética", perguntas: [] });
    const contato = "5561900000601";
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "Olá", timestamp: Date.now() - 60_000, nomePerfil: "Perfil coexistência staging" });
    const conversa = async () => (await q("SELECT id, versao FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    let cv = await conversa();
    await servico.controlarAtendimento(sessao, { acao: "assumir", conversaId: cv.id, versao: Number(cv.versao) });
    const foto = (await biblioteca.salvarPronta(sessao, { titulo: "Foto coexistência staging", categoria: "Teste", tipo: "IMAGEM", texto: "Legenda", link: null, atalho: "SALGADOS", midiaUrl: "https://midia.exemplo.test/cs.jpg" })).id;
    await biblioteca.salvarPronta(sessao, { titulo: "Texto coexistência staging", categoria: "Teste", tipo: "TEXTO", texto: "texto", link: null, atalho: null });
    const vista = (await biblioteca.prepararRascunho(sessao, { conversaId: cv.id, id: foto })).midia!;
    cv = await conversa();
    await servico.controlarAtendimento(sessao, { acao: "enviar", conversaId: cv.id, versao: Number(cv.versao), prontaMidiaId: foto, prontaVersao: vista.versao, texto: "Legenda revisada" });
    const envios: ConteudoSaida[] = [];
    await worker.processarLote({ interpretar: async () => { throw new Error("sem modelo"); }, enviar: async (_c: string, conteudo: ConteudoSaida) => { envios.push(conteudo); return cod("gs-"); } }, { maxTarefas: 10 });
    assert.equal(envios.length, 1, "X1: a saída com mídia sai pelo transporte simulado");
    const atendimentoX1 = await retratoAtendimento();
    assert.ok(atendimentoX1.tabelas.length >= 8, `X1: tabelas do atendimento (${atendimentoX1.tabelas.join(", ")})`);

    // X2 — staging por cima (pré e postchecks).
    for (const m2 of STAGING) { await q(m2.pre); await q(m2.up); await q(m2.post); }
    await postStaging("X2"); await postAtendimento("X2");
    assert.deepEqual(await retratoAtendimento(), atendimentoX1, "X2: staging não altera o atendimento");
    const stagingVazio = await retratoStaging();

    // X3 — rollback de todo o staging com o atendimento presente; atendimento idêntico; staging reaplicado.
    for (const m2 of [...STAGING].reverse()) await q(m2.down);
    for (const tb of TABELAS_STAGING) assert.equal(await existe(tb), false, `X3: ${tb} removida`);
    assert.deepEqual(await retratoAtendimento(), atendimentoX1, "X3: rollback de staging não altera o atendimento");
    await postAtendimento("X3 sem staging");
    for (const m2 of STAGING) { await q(m2.pre); await q(m2.up); await q(m2.post); }
    assert.deepEqual(await retratoStaging(), stagingVazio, "X3: staging reaplicado igual");
    await postStaging("X3 reaplicado"); await postAtendimento("X3 reaplicado");

    // X4 — dados das funcionalidades de staging.
    await q(`INSERT INTO empresa_pix_recebimento (empresa_id, tipo_chave, chave, nome_recebedor, cidade_recebedor, atualizado_por) VALUES ($1::uuid, 'EMAIL', 'pix@coexistencia.example.test', 'Empresa Sintetica', 'Brasilia', $2::uuid)`, [A, u]);
    await q(`INSERT INTO empresa_excecoes_comerciais (empresa_id, tipo, valida_ate, motivo, criado_por) VALUES ($1::uuid, 'CORTESIA', clock_timestamp() + interval '30 days', 'Teste de coexistência sintético', $2::uuid)`, [A, u]);
    const hex = () => randomBytes(32).toString("hex");
    await q(`INSERT INTO cadastros_publicos (email, nome, senha_hash, token_hash, expira_em, termos_versao, termos_hash, privacidade_versao, privacidade_hash)
      VALUES (lower($1), 'Cadastro sintético', $2, $3, clock_timestamp() + interval '1 day', '2026-10-07', $4, '2026-10-07', $5)`, [`${cod("cad")}@example.test`, SENHA, hex(), hex(), hex()]);
    const stagingComDados = await retratoStaging();
    assert.notDeepEqual(stagingComDados.dados, stagingVazio.dados, "X4: dados de staging gravados");
    await postStaging("X4");

    // X5 — rollback de todo o atendimento (decisões explícitas) com os dados de staging; staging idêntico.
    await q(comDecisoes(A078.down, "kidmais.rollback_078_descartar"));
    assert.deepEqual(await retratoStaging(), stagingComDados, "X5: down da 078 preserva staging"); await postStaging("X5 sem 078");
    await q(comDecisoes(A077B.down, "kidmais.rollback_077b_descartar_midias", "kidmais.rollback_077b_descartar_prontas_midia")); await q(A077B.posDown);
    assert.deepEqual(await retratoStaging(), stagingComDados, "X5: down da 077b preserva staging"); await postStaging("X5 sem 077b");
    await q(comDecisoes(A065.down, "kidmais.rollback_065_descartar_nomes")); await q(A065.posDown);
    await q(comDecisoes(A077A.down, "kidmais.rollback_077a_descartar_prontas")); await q(A077A.posDown);
    assert.deepEqual(await retratoStaging(), stagingComDados, "X5: down da 065 e da 077a preservam staging"); await postStaging("X5 sem 065/077a");
    await q(A060.preDown); await q(comDecisoes(A060.down, "kidmais.rollback_060_descartar_atendimento")); await q(A060.posDown);
    assert.deepEqual(await tabelasAtendimento(), [], "X5: nenhuma tabela do atendimento sobra");
    assert.deepEqual(await retratoStaging(), stagingComDados, "X5: rollback completo do atendimento preserva staging (dados e objetos)");
    await postStaging("X5 sem atendimento");
    assert.equal((await q("SELECT empresa_ativa_id::text AS e FROM sessoes_administrativas WHERE id = $1::uuid", [s])).rows[0].e, A, "X5: sessão (063) intacta");

    // X6 — atendimento reaplicado DEPOIS de staging (a outra ordem).
    await q(A060.up); await q(A060.post);
    for (const m3 of [A065, A077A, A077B, A078]) { await q(m3.up); await q(m3.post); }
    await postAtendimento("X6"); await postStaging("X6");
    assert.deepEqual(await retratoStaging(), stagingComDados, "X6: reaplicar o atendimento preserva staging");

    // X7 — com dados, os rollbacks de staging falham fechado e nada é removido.
    for (const [n, padrao] of [["069", /069 rollback recusado/], ["067", /067 rollback recusado/], ["066", /066 rollback recusado/]] as const) {
      await assert.rejects(q(STAGING.find((x) => x.n === n)!.down), padrao, `X7: down da ${n} recusado com dados`); await q("ROLLBACK").catch(() => {});
    }
    assert.deepEqual(await retratoStaging(), stagingComDados, "X7: recusas não removem nada");
    await postStaging("X7"); await postAtendimento("X7");
    assert.equal(envios.length, 1, "nenhum reenvio em todo o roteiro");
  } finally {
    await c.end();
  }
});
