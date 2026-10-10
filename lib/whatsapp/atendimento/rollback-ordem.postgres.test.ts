import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";

/**
 * Revisão final (H1/M1): os downs e os rollback prechecks do atendimento RECUSAM enquanto uma migration dependente
 * ainda está aplicada (total ou parcialmente), ANTES de travar ou alterar qualquer coisa — nada muda na recusa (catálogo
 * e dados idênticos). Ordem válida: 078 → 077b → 077a → 065 → 060. Modelo "063" (com a 060), só pelo check:v1:postgres,
 * com opt-in, no cluster descartável. Dados sintéticos; transporte simulado; nenhuma rede.
 *
 *  O1 tabelas vazias: 077b com a 078, 077a com 077b/078, 060 com 065/077a/077b/078 recusam (down e precheck); a cada passo da
 *     ordem válida, os de baixo continuam recusando; 078 parcial (uma coluna sobrando) também recusa o down da 077b;
 *  O2 com dados sintéticos (conversa, nome de perfil, prontas com foto e PDF, saídas com mídia e grupo) e TODAS as decisões
 *     de descarte ligadas: os mesmos downs fora de ordem recusam e nada é apagado; a ordem válida remove tudo.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const comDecisoes = (sql: string, ...chaves: string[]) => sql.replace("SET LOCAL statement_timeout = '60s';", ["SET LOCAL statement_timeout = '60s';", ...chaves.map((k) => `SET LOCAL ${k} = 'sim';`)].join("\n"));
const TODAS = ["kidmais.rollback_060_descartar_atendimento", "kidmais.rollback_065_descartar_nomes", "kidmais.rollback_077a_descartar_prontas", "kidmais.rollback_077b_descartar_midias", "kidmais.rollback_077b_descartar_prontas_midia", "kidmais.rollback_078_descartar"];
const M = {
  "060": { up: ler("database/migrations/20261001_060_whatsapp_atendimento.sql"), post: ler("database/checks/20261001_060_postcheck.sql"), down: ler("database/rollback/20261001_060_whatsapp_atendimento_down.sql"), pre: ler("database/checks/20261001_060_rollback_precheck.sql"), posDown: ler("database/checks/20261001_060_rollback_postcheck.sql") },
  "065": { up: ler("database/migrations/20261004_065_whatsapp_nome_perfil.sql"), post: ler("database/checks/20261004_065_postcheck.sql"), down: ler("database/rollback/20261004_065_whatsapp_nome_perfil_down.sql"), pre: null, posDown: ler("database/checks/20261004_065_rollback_postcheck.sql") },
  "077a": { up: ler("database/migrations/20261009_077a_whatsapp_mensagens_prontas.sql"), post: ler("database/checks/20261009_077a_postcheck.sql"), down: ler("database/rollback/20261009_077a_whatsapp_mensagens_prontas_down.sql"), pre: ler("database/checks/20261009_077a_rollback_precheck.sql"), posDown: ler("database/checks/20261009_077a_rollback_postcheck.sql") },
  "077b": { up: ler("database/migrations/20261009_077b_whatsapp_prontas_midia.sql"), post: ler("database/checks/20261009_077b_postcheck.sql"), down: ler("database/rollback/20261009_077b_whatsapp_prontas_midia_down.sql"), pre: ler("database/checks/20261009_077b_rollback_precheck.sql"), posDown: ler("database/checks/20261009_077b_rollback_postcheck.sql") },
  "078": { up: ler("database/migrations/20261009_078_wall_e_atendimento.sql"), post: ler("database/checks/20261009_078_postcheck.sql"), down: ler("database/rollback/20261009_078_wall_e_atendimento_down.sql"), pre: null, posDown: null },
} as const;
type Id = keyof typeof M;
const RECUSA: Record<string, RegExp> = { "077b": /Rollback da 077b recusado: a 078 ainda está aplicada/, "077a": /Rollback da 077a recusado: a 077b ou a 078 ainda estão aplicadas/, "060": /Rollback da 060 recusado: 065, 077a, 077b ou 078 ainda estão aplicadas/ };
const RECUSA_PRE: Record<string, RegExp> = { "077b": /077b rollback precheck: a 078 ainda está aplicada/, "077a": /077a rollback precheck: a 077b ou a 078 ainda estão aplicadas/, "060": /060 rollback precheck: 065, 077a, 077b ou 078 ainda estão aplicadas/ };
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const PDF = Buffer.from("%PDF-1.4\n% material sintético (ordem dos rollbacks)\n%%EOF\n");

test("rollbacks do atendimento recusam dependentes aplicados, sem alteração parcial, com e sem dados", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  // Retrato do atendimento: tabelas, colunas, restrições, índices, gatilhos, funções da 078 e DADOS de cada tabela.
  const retrato = async () => (await q(`SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS h, count(*)::int AS n FROM (
      SELECT 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull AS x FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'whatsapp\\_atendimento\\_%' AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL SELECT 'con:' || cl.relname || ':' || co.conname || ':' || pg_get_constraintdef(co.oid) FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid WHERE cl.relname LIKE 'whatsapp\\_atendimento\\_%'
      UNION ALL SELECT 'idx:' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'whatsapp\\_atendimento\\_%'
      UNION ALL SELECT 'trg:' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'whatsapp\\_atendimento\\_%'
      UNION ALL SELECT 'fn:' || proname || ':' || md5(prosrc) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'kidmais07%'
    ) s`)).rows[0] as { h: string; n: number };
  const dados = async () => {
    const tabelas = (await q("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'whatsapp\\_atendimento\\_%' ORDER BY 1")).rows.map((x) => x.tablename as string);
    const r: Record<string, string> = {};
    for (const tb of tabelas) r[tb] = (await q(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${tb} x`)).rows.map((x) => `${x.n}:${x.h}`)[0];
    return r;
  };
  const foto = async () => ({ esquema: await retrato(), dados: await dados() });
  // Tenta o down (com ou sem decisões) e o precheck: os dois recusam, e nada muda.
  const recusa = async (rotulo: string, id: "060" | "077a" | "077b", decisoes: string[]) => {
    const antes = await foto();
    await assert.rejects(q(comDecisoes(M[id].down, ...decisoes)), RECUSA[id], `${rotulo}: down da ${id} recusa`); await q("ROLLBACK").catch(() => {});
    await assert.rejects(q(M[id].pre!), RECUSA_PRE[id], `${rotulo}: rollback precheck da ${id} recusa`); await q("ROLLBACK").catch(() => {});
    assert.deepEqual(await foto(), antes, `${rotulo}: a recusa da ${id} não altera catálogo nem dados`);
  };
  const desce = async (id: Id, decisoes: string[]) => {
    if (M[id].pre) await q(M[id].pre!);
    await q(comDecisoes(M[id].down, ...decisoes));
    if (M[id].posDown) await q(M[id].posDown!);
  };
  const tabelasAtendimento = async () => (await q("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'whatsapp\\_atendimento\\_%'")).rows[0].n as number;
  // Roteiro completo a partir de "tudo aplicado": fora de ordem recusa a cada passo; a ordem válida remove tudo.
  const roteiro = async (rotulo: string, decisoes: string[]) => {
    for (const id of ["077b", "077a", "060"] as const) await recusa(`${rotulo} (tudo aplicado)`, id, decisoes);
    await desce("078", decisoes);
    for (const id of ["077a", "060"] as const) await recusa(`${rotulo} (sem a 078)`, id, decisoes);
    await q(M["077b"].pre!); // 077b já pode descer: o precheck passa
    await desce("077b", decisoes);
    await recusa(`${rotulo} (sem 077b/078)`, "060", decisoes);
    await desce("077a", decisoes);
    await recusa(`${rotulo} (só 060 + 065)`, "060", decisoes);
    await desce("065", decisoes);
    await desce("060", decisoes);
    assert.equal(await tabelasAtendimento(), 0, `${rotulo}: ordem válida remove todo o atendimento`);
  };
  const aplicar = async (ids: Id[]) => { for (const id of ids) { await q(M[id].up); await q(M[id].post); } };
  try {
    assert.equal(await tabelasAtendimento() > 0, true, "modelo 063 com a 060");
    // O1 — tabelas vazias.
    await aplicar(["065", "077a", "077b", "078"]);
    // 078 PARCIAL: depois do down da 078, uma coluna dela sobrando (estado misto) ainda recusa o down da 077b e o da 077a.
    await desce("078", []);
    await q("ALTER TABLE whatsapp_atendimento_mensagens_prontas ADD COLUMN estado text");
    await recusa("O1 (078 parcial)", "077b", []);
    await recusa("O1 (078 parcial)", "077a", []);
    await q("ALTER TABLE whatsapp_atendimento_mensagens_prontas DROP COLUMN estado");
    await q(M["077b"].pre!);
    await aplicar(["078"]);
    await roteiro("O1 tabelas vazias", []);

    // O2 — dados sintéticos e TODAS as decisões de descarte ligadas.
    await aplicar(["060", "065", "077a", "077b", "078"]);
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const A = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa sintética (ordem dos rollbacks)', 'PROVISIONAMENTO') RETURNING id`, [cod("ro")]);
    await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [A]);
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness ordem dos rollbacks', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [A, u]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), A]);
    const sessao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", id: s, empresa_ativa_id: A } as never;
    const { servico, worker, biblioteca } = carregarAtendimento(A);
    await servico.salvarConfiguracao(sessao, { ativo: true, nome: "Empresa sintética", perguntas: [] });
    const contato = "5561900000901";
    await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "Olá", timestamp: Date.now() - 60_000, nomePerfil: "Perfil ordem dos rollbacks" });
    const conversa = async () => (await q("SELECT id, versao FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    let cv = await conversa();
    await servico.controlarAtendimento(sessao, { acao: "assumir", conversaId: cv.id, versao: Number(cv.versao) });
    const fotoPronta = (await biblioteca.salvarPronta(sessao, { titulo: "Foto (ordem dos rollbacks)", categoria: "Teste", tipo: "IMAGEM", texto: "Legenda", link: null, atalho: "SALGADOS", midiaUrl: "https://midia.exemplo.test/ro.jpg" })).id;
    const arquivo = await biblioteca.salvarArquivo(sessao, { nome: "material.pdf", bytes: PDF, tipoEsperado: "DOCUMENTO" });
    await biblioteca.salvarPronta(sessao, { titulo: "PDF (ordem dos rollbacks)", categoria: "Teste", tipo: "DOCUMENTO", texto: "Material", link: null, atalho: null, arquivoId: arquivo.id, estado: "PUBLICADA", envioAutomatico: true, finalidade: "PRECOS" });
    const vista = (await biblioteca.prepararRascunho(sessao, { conversaId: cv.id, id: fotoPronta })).midia!;
    cv = await conversa();
    await servico.controlarAtendimento(sessao, { acao: "enviar", conversaId: cv.id, versao: Number(cv.versao), prontaMidiaId: fotoPronta, prontaVersao: vista.versao, texto: "Legenda revisada" });
    const envios: ConteudoSaida[] = [];
    await worker.processarLote({ interpretar: async () => { throw new Error("sem modelo"); }, enviar: async (_c: string, conteudo: ConteudoSaida) => { envios.push(conteudo); return cod("gs-"); } }, { maxTarefas: 10 });
    assert.equal(envios.length, 1, "O2: a saída com mídia saiu pelo transporte simulado (nenhuma rede)");
    const comDados = await dados();
    assert.ok(Object.values(comDados).filter((v) => !v.startsWith("0:")).length >= 5, `O2: dados em várias tabelas ${JSON.stringify(comDados)}`);
    await roteiro("O2 com dados e decisões", TODAS);
    assert.equal(envios.length, 1, "nenhum envio durante os rollbacks");
  } finally {
    await c.end();
  }
});
