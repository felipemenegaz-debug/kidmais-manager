import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";

/**
 * Renumeração de 10/10/2026: o staging criou 20261010_076_cpf_por_empresa (unicidade do CPF por empresa) e
 * 20261010_077_regras_pagamento_empresa (regras de pagamento por empresa); as migrations do atendimento passaram a
 * 077a (prontas) e 077b (mídia), com a 078 mantida. Esta suíte prova a coexistência das cinco do atendimento (060, 065,
 * 077a, 077b, 078) com a 076 e a 077 do staging, nas duas ordens, e que os DOWNS do atendimento preservam os objetos e os
 * dados sintéticos delas. PostgreSQL descartável (modelo "063": 055…063, com a 060), só pelo check:v1:postgres, com
 * opt-in. Dados sintéticos (CPF fictício de teste); transporte simulado; nenhuma rede.
 *
 *  Y1 atendimento primeiro (065 → 077a → 077b → 078) e dados dele (sessão, nome de perfil, prontas, saída com mídia);
 *  Y2 staging por cima (076 e 077, com pré e postchecks): postchecks dos dois lados; atendimento idêntico;
 *  Y3 dados sintéticos do staging: o mesmo CPF fictício em duas empresas (permitido só com a 076) e uma regra de
 *     pagamento própria da empresa (077);
 *  Y4 rollback de TODO o atendimento (078 → 077b → 065 → 077a → 060, decisões explícitas): depois de CADA down, os dados
 *     e os objetos da 076/077 ficam idênticos (impressão digital) e o postcheck da 076 passa; nenhuma tabela do
 *     atendimento sobra;
 *  Y5 atendimento reaplicado DEPOIS do staging (a outra ordem): postchecks do atendimento; staging idêntico;
 *  Y6 com os dados do Y3, os downs do staging recusam (falham fechado) e nada é removido dos dois lados;
 *  Y7 sem os dados que os bloqueiam, os downs do staging (077 → 076) rodam com o atendimento presente e o atendimento
 *     fica idêntico; o staging reaplicado volta com os mesmos objetos.
 *
 * O postcheck da 077 do staging confere o estado logo depois de aplicar (só a linha legada da Kidmais); com a regra
 * sintética do Y3 ele recusa por desenho, por isso a partir do Y3 a 077 é conferida pela impressão digital.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const comDecisoes = (sql: string, ...chaves: string[]) => sql.replace("SET LOCAL statement_timeout = '60s';", ["SET LOCAL statement_timeout = '60s';", ...chaves.map((k) => `SET LOCAL ${k} = 'sim';`)].join("\n"));
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
/** CPF fictício de teste (dígitos verificadores válidos, base 000000001); nenhum dado real. */
const CPF_FICTICIO = "00000000191";

const A060 = { up: ler("database/migrations/20261001_060_whatsapp_atendimento.sql"), post: ler("database/checks/20261001_060_postcheck.sql"),
  down: ler("database/rollback/20261001_060_whatsapp_atendimento_down.sql"), preDown: ler("database/checks/20261001_060_rollback_precheck.sql"), posDown: ler("database/checks/20261001_060_rollback_postcheck.sql") };
const A065 = { up: ler("database/migrations/20261004_065_whatsapp_nome_perfil.sql"), post: ler("database/checks/20261004_065_postcheck.sql"),
  down: ler("database/rollback/20261004_065_whatsapp_nome_perfil_down.sql"), posDown: ler("database/checks/20261004_065_rollback_postcheck.sql") };
const A077A = { up: ler("database/migrations/20261009_077a_whatsapp_mensagens_prontas.sql"), post: ler("database/checks/20261009_077a_postcheck.sql"),
  down: ler("database/rollback/20261009_077a_whatsapp_mensagens_prontas_down.sql"), posDown: ler("database/checks/20261009_077a_rollback_postcheck.sql") };
const A077B = { up: ler("database/migrations/20261009_077b_whatsapp_prontas_midia.sql"), post: ler("database/checks/20261009_077b_postcheck.sql"),
  down: ler("database/rollback/20261009_077b_whatsapp_prontas_midia_down.sql"), posDown: ler("database/checks/20261009_077b_rollback_postcheck.sql") };
const A078 = { up: ler("database/migrations/20261009_078_wall_e_atendimento.sql"), post: ler("database/checks/20261009_078_postcheck.sql"),
  down: ler("database/rollback/20261009_078_wall_e_atendimento_down.sql") };
const st = (n: string, nome: string) => ({ n, pre: ler(`database/checks/20261010_${n}_precheck.sql`), up: ler(`database/migrations/20261010_${n}_${nome}.sql`),
  post: ler(`database/checks/20261010_${n}_postcheck.sql`), down: ler(`database/rollback/20261010_${n}_${nome}_down.sql`) });
const S076 = st("076", "cpf_por_empresa"), S077 = st("077", "regras_pagamento_empresa");
const TABELAS_STAGING = ["clientes", "empresa_regras_pagamento"];

test("coexistência do atendimento (060/065/077a/077b/078) com a 076 (CPF por empresa) e a 077 (regras de pagamento) do staging; downs do atendimento preservam o staging", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  const existe = async (tabela: string) => (await q("SELECT to_regclass($1) IS NOT NULL AS e", [`public.${tabela}`])).rows[0].e as boolean;
  const dados = async (tabelas: string[]) => {
    const r: Record<string, string> = {};
    for (const tb of tabelas) r[tb] = (await existe(tb)) ? (await q(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*)::int AS n FROM ${tb} x`)).rows.map((x) => `${x.n}:${x.h}`)[0] : "ausente";
    return r;
  };
  const tabelasAtendimento = async () => (await q("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'whatsapp\\_atendimento\\_%' ORDER BY 1")).rows.map((x) => x.tablename as string);
  const objetos = async (prefixoFuncao: string, tabelas: string[]) => (await q(`SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS h, count(*)::int AS n FROM (
      SELECT 'f:' || p.proname || ':' || md5(pg_get_functiondef(p.oid)) AS x FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname ~ $1
      UNION ALL SELECT 't:' || cl.relname || ':' || tg.tgname || ':' || md5(pg_get_triggerdef(tg.oid)) FROM pg_trigger tg JOIN pg_class cl ON cl.oid = tg.tgrelid JOIN pg_proc p ON p.oid = tg.tgfoid WHERE NOT tg.tgisinternal AND (p.proname ~ $1 OR cl.relname = ANY($2))
      UNION ALL SELECT 'c:' || cl.relname || ':' || co.conname || ':' || md5(pg_get_constraintdef(co.oid)) FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid WHERE cl.relname = ANY($2)
      UNION ALL SELECT 'i:' || ic.relname || ':' || md5(pg_get_indexdef(ix.indexrelid)) FROM pg_index ix JOIN pg_class cl ON cl.oid = ix.indrelid JOIN pg_class ic ON ic.oid = ix.indexrelid WHERE cl.relname = ANY($2)
    ) s`, [prefixoFuncao, tabelas])).rows.map((x) => `${x.n}:${x.h}`)[0];
  // A 076 e a 077 do staging não criam funções; o prefixo só pega uma função futura delas (nunca do atendimento).
  const FUNCOES_STAGING = "^kidmais_?07[67]_";
  const FUNCOES_ATENDIMENTO = "^kidmais_?(060|065|077[ab]|078)";
  const indices076 = async () => (await q("SELECT to_regclass('public.clientes_cpf_empresa_canonico_uk') IS NOT NULL AS por_empresa, to_regclass('public.clientes_cpf_canonico_uk') IS NOT NULL AS global")).rows[0];
  const retratoStaging = async () => ({ dados: await dados(TABELAS_STAGING), objetos: await objetos(FUNCOES_STAGING, TABELAS_STAGING), indices: await indices076() });
  const retratoAtendimento = async () => { const tb = await tabelasAtendimento(); return { tabelas: tb, dados: await dados(tb), objetos: await objetos(FUNCOES_ATENDIMENTO, tb) }; };
  const postAtendimento = async (rotulo: string) => { for (const [n, sql] of [["060", A060.post], ["065", A065.post], ["077a", A077A.post], ["077b", A077B.post], ["078", A078.post]] as const) await assert.doesNotReject(q(sql), `${rotulo}: postcheck ${n}`); };
  try {
    // Y1 — atendimento primeiro e os dados dele.
    await q(A060.post);
    for (const m of [A065, A077A, A077B, A078]) { await q(m.up); await q(m.post); }
    await postAtendimento("Y1");
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const empresa = async (rotulo: string) => {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("cp"), `Empresa sintética ${rotulo} (CPF/pagamento)`]);
      await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      return e;
    };
    const A = await empresa("A"), B = await empresa("B");
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness CPF/pagamento', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [A, u]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), A]);
    const sessao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", id: s, empresa_ativa_id: A } as never;
    const { servico, worker, biblioteca } = carregarAtendimento(A);
    await servico.salvarConfiguracao(sessao, { ativo: true, nome: "Empresa sintética", perguntas: [] });
    const contato = "5561900000761";
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "Olá", timestamp: Date.now() - 60_000, nomePerfil: "Perfil sintético CPF/pagamento" });
    const conversa = async () => (await q("SELECT id, versao FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    let cv = await conversa();
    await servico.controlarAtendimento(sessao, { acao: "assumir", conversaId: cv.id, versao: Number(cv.versao) });
    const foto = (await biblioteca.salvarPronta(sessao, { titulo: "Foto sintética CPF/pagamento", categoria: "Teste", tipo: "IMAGEM", texto: "Legenda", link: null, atalho: "SALGADOS", midiaUrl: "https://midia.exemplo.test/cp.jpg" })).id;
    await biblioteca.salvarPronta(sessao, { titulo: "Texto sintético CPF/pagamento", categoria: "Teste", tipo: "TEXTO", texto: "texto", link: null, atalho: null });
    const vista = (await biblioteca.prepararRascunho(sessao, { conversaId: cv.id, id: foto })).midia!;
    cv = await conversa();
    await servico.controlarAtendimento(sessao, { acao: "enviar", conversaId: cv.id, versao: Number(cv.versao), prontaMidiaId: foto, prontaVersao: vista.versao, texto: "Legenda revisada" });
    const envios: ConteudoSaida[] = [];
    await worker.processarLote({ interpretar: async () => { throw new Error("sem modelo"); }, enviar: async (_c: string, conteudo: ConteudoSaida) => { envios.push(conteudo); return cod("gs-"); } }, { maxTarefas: 10 });
    assert.equal(envios.length, 1, "Y1: a saída com mídia sai pelo transporte simulado");
    const atendimentoY1 = await retratoAtendimento();
    assert.ok(atendimentoY1.tabelas.length >= 8, `Y1: tabelas do atendimento (${atendimentoY1.tabelas.join(", ")})`);

    // Y2 — staging por cima (pré e postchecks); atendimento idêntico.
    for (const sm of [S076, S077]) { await q(sm.pre); await q(sm.up); await q(sm.post); }
    await postAtendimento("Y2");
    assert.deepEqual(await retratoAtendimento(), atendimentoY1, "Y2: 076/077 do staging não alteram o atendimento");
    assert.deepEqual(await indices076(), { por_empresa: true, global: false }, "Y2: índice por empresa no lugar do global");

    // Y3 — dados sintéticos do staging: o mesmo CPF fictício em A e B; regra de pagamento própria de A.
    await q(`INSERT INTO clientes (nome_completo, empresa_id, cpf) VALUES ('Cliente sintético A', $1::uuid, $3), ('Cliente sintético B', $2::uuid, $3)`, [A, B, CPF_FICTICIO]);
    await assert.rejects(q(`INSERT INTO clientes (nome_completo, empresa_id, cpf) VALUES ('Cliente sintético A2', $1::uuid, $2)`, [A, CPF_FICTICIO]), /clientes_cpf_empresa_canonico_uk/, "Y3: CPF repetido na MESMA empresa recusado");
    await q(`INSERT INTO empresa_regras_pagamento (empresa_id, pix_avista_percentual, pix_parcelado_percentual, cartao_rotulo, desconto_dia_util, motivo) VALUES ($1::uuid, 5, 0, 'Cartão sintético', false, 'Regra sintética de teste')`, [A]);
    await assert.doesNotReject(q(S076.post), "Y3: postcheck 076 com os dados");
    const stagingY3 = await retratoStaging();
    assert.match(stagingY3.dados.empresa_regras_pagamento, /^[1-9]/, "Y3: regra gravada");

    // Y4 — rollback de todo o atendimento; depois de CADA down o staging fica idêntico.
    const conferirStaging = async (rotulo: string) => { assert.deepEqual(await retratoStaging(), stagingY3, `${rotulo}: dados e objetos da 076/077 idênticos`); await assert.doesNotReject(q(S076.post), `${rotulo}: postcheck 076`); };
    await q(comDecisoes(A078.down, "kidmais.rollback_078_descartar")); await conferirStaging("Y4 sem 078");
    await q(comDecisoes(A077B.down, "kidmais.rollback_077b_descartar_midias", "kidmais.rollback_077b_descartar_prontas_midia")); await q(A077B.posDown); await conferirStaging("Y4 sem 077b");
    await q(comDecisoes(A065.down, "kidmais.rollback_065_descartar_nomes")); await q(A065.posDown); await conferirStaging("Y4 sem 065");
    await q(comDecisoes(A077A.down, "kidmais.rollback_077a_descartar_prontas")); await q(A077A.posDown); await conferirStaging("Y4 sem 077a");
    await q(A060.preDown); await q(comDecisoes(A060.down, "kidmais.rollback_060_descartar_atendimento")); await q(A060.posDown);
    assert.deepEqual(await tabelasAtendimento(), [], "Y4: nenhuma tabela do atendimento sobra");
    await conferirStaging("Y4 sem atendimento");

    // Y5 — atendimento reaplicado DEPOIS do staging (a outra ordem).
    await q(A060.up); await q(A060.post);
    for (const m3 of [A065, A077A, A077B, A078]) { await q(m3.up); await q(m3.post); }
    await postAtendimento("Y5"); await conferirStaging("Y5");
    const atendimentoY5 = await retratoAtendimento();

    // Y6 — com os dados do Y3, os downs do staging falham fechado e nada é removido.
    await assert.rejects(q(S077.down), /077 rollback: há regras configuradas além da legada/, "Y6: down da 077 recusado com regra própria"); await q("ROLLBACK").catch(() => {});
    await assert.rejects(q(S076.down), /076 rollback: CPF repetido entre empresas/, "Y6: down da 076 recusado com CPF em duas empresas"); await q("ROLLBACK").catch(() => {});
    await conferirStaging("Y6");
    assert.deepEqual(await retratoAtendimento(), atendimentoY5, "Y6: recusas do staging não tocam o atendimento");

    // Y7 — sem os dados que os bloqueiam, os downs do staging rodam com o atendimento presente; atendimento idêntico.
    await q(`DELETE FROM empresa_regras_pagamento WHERE empresa_id = $1::uuid`, [A]);
    await q(`DELETE FROM clientes WHERE empresa_id = $1::uuid AND cpf = $2`, [B, CPF_FICTICIO]);
    const objetosStagingAplicado = (await retratoStaging()).objetos;
    await q(S077.down); await q(S076.down);
    assert.equal(await existe("empresa_regras_pagamento"), false, "Y7: tabela da 077 removida");
    assert.deepEqual(await indices076(), { por_empresa: false, global: true }, "Y7: índice global de volta");
    assert.deepEqual(await retratoAtendimento(), atendimentoY5, "Y7: downs do staging não alteram o atendimento");
    await postAtendimento("Y7 sem staging");
    for (const sm of [S076, S077]) { await q(sm.pre); await q(sm.up); await q(sm.post); }
    assert.equal((await retratoStaging()).objetos, objetosStagingAplicado, "Y7: staging reaplicado com os mesmos objetos");
    await postAtendimento("Y7 reaplicado");
    assert.equal(envios.length, 1, "nenhum reenvio em todo o roteiro");
  } finally {
    await c.end();
  }
});
