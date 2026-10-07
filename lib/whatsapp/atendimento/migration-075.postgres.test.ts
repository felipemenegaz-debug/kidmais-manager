import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, semTransacaoExplicita } from "../../comercial/postgres-descartavel.ts";
import { cod } from "./harness-postgres.ts";

/**
 * Migration 075 (Wall-e) no PostgreSQL descartável: só pelo check:v1:postgres, com KIDMAIS_POSTGRES_DESCARTAVEL, no
 * cluster descartável local (GOAL Wall-e: bancos descartáveis exclusivamente locais). Dados sintéticos.
 *
 * Roteiro:
 *  0. ordem: 075 sem a 074 é recusada;
 *  1. dados anteriores (pronta ativa e arquivada, saída com foto da 074) → 075 aplicada; postchecks da 060, 073, 074 e
 *     075 passam juntos; reaplicação recusada; prontas antigas viram PUBLICADA/ARQUIVADA;
 *  2. arquivos: tipo×mime, tamanho por tipo, hash conferido pelo banco, token único, só inserção (UPDATE/DELETE recusados);
 *  3. prontas: PDF só com arquivo próprio; arquivo de OUTRA empresa ou de OUTRO tipo recusado pela FK; URL e arquivo
 *     juntos recusados; estado coerente com `ativa`; envio automático exige finalidade; unidade de outra empresa recusada;
 *  4. mensagens: várias saídas da mesma entrada (grupo + ordem) sem duplicar; a unicidade da 060 em origem_id continua;
 *     PDF exige arquivo e nome; arquivo com tipo diferente da mídia recusado;
 *  5. rollback: com arquivo na fila recusa sempre; sem a decisão recusa; com a decisão remove só a 075 (rascunho vira
 *     arquivado, PDF e arquivo próprio saem, foto por URL da 074 fica); postchecks 060/073/074 passam; reaplicável.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP060 = ler("database/migrations/20261001_060_whatsapp_atendimento.sql");
const POST060 = ler("database/checks/20261001_060_postcheck.sql");
const UP073 = ler("database/migrations/20261007_073_whatsapp_mensagens_prontas.sql");
const POST073 = ler("database/checks/20261007_073_postcheck.sql");
const UP074 = ler("database/migrations/20261007_074_whatsapp_prontas_midia.sql");
const POST074 = ler("database/checks/20261007_074_postcheck.sql");
const UP = ler("database/migrations/20261007_075_wall_e_atendimento.sql");
const POST = ler("database/checks/20261007_075_postcheck.sql");
const DOWN = ler("database/rollback/20261007_075_wall_e_atendimento_down.sql");
const comDecisao = (sql: string) => sql.replace("SET LOCAL statement_timeout = '60s';", "SET LOCAL statement_timeout = '60s';\nSET LOCAL kidmais.rollback_075_descartar = 'sim';");

async function recusa(c: Client, sql: string, v: unknown[], motivo: RegExp) {
  await c.query("BEGIN");
  await assert.rejects(c.query(sql, v), motivo);
  await c.query("ROLLBACK");
}
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const PDF = Buffer.from("%PDF-1.4\n% tabela sintética\n%%EOF\n");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR sintético")]);
const token = () => randomBytes(32).toString("base64url");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("075: Wall-e — ordem, aplicação sobre dados da 074, arquivos, prontas, várias saídas e rollback", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  try {
    const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
    const n = async (sql: string, v: unknown[] = []) => Number((await c.query(sql, v)).rows[0].n);
    // 0. Ordem.
    await c.query(UP060); await c.query(POST060); await c.query(UP073); await c.query(POST073);
    await assert.rejects(c.query(UP), /075 exige a 060, a 073 e a 074/); await c.query("ROLLBACK").catch(() => {});
    await c.query(UP074); await c.query(POST074);

    // 1. Dados anteriores à 075.
    const empresa = async (nome: string) => { const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("we"), nome]); await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1`, [e]); return e; };
    const A = await empresa("Empresa sintética A (075)"), B = await empresa("Empresa sintética B (075)");
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness 075', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const insPronta = `INSERT INTO whatsapp_atendimento_mensagens_prontas (empresa_id, ambiente, titulo, categoria, tipo, texto, midia_url, ativa, criada_por, atualizada_por) VALUES ($1, 'staging', $2, 'Teste', $3, 'texto', $4, $5, $6, $6) RETURNING id`;
    const ativa = await id(insPronta, [A, "Ativa antiga", "TEXTO", null, true, u]);
    const arquivada = await id(insPronta, [A, "Arquivada antiga", "TEXTO", null, false, u]);
    const fotoUrl = await id(insPronta, [A, "Foto por URL", "IMAGEM", "https://midia.exemplo.test/f.jpg", true, u]);
    const conversa = await id(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato) VALUES ($1, 'staging', '5561900000701') RETURNING id`, [A]);
    const entrada = await id(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, externa_id, direcao, texto, estado, versao_conversa) VALUES ($1, $2, 'staging', $3, 'ENTRADA', 'oi', 'PROCESSADA', 0) RETURNING id`, [conversa, A, cod("e")]);
    await c.query(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, midia_tipo, midia_url, midia_pronta_id, midia_pronta_versao) VALUES ($1, $2, 'staging', 'SAIDA', 'legenda', 'ENTREGUE', 0, 'IMAGEM', 'https://midia.exemplo.test/f.jpg', $3, 0)`, [conversa, A, fotoUrl]);

    await c.query(UP);
    for (const p of [POST060, POST073, POST074, POST]) await c.query(p);
    await assert.rejects(c.query(semTransacaoExplicita(UP)), /075 já aplicada/); await c.query("ROLLBACK").catch(() => {});
    const estados = (await c.query("SELECT id, estado, ativa, envio_automatico FROM whatsapp_atendimento_mensagens_prontas")).rows;
    assert.deepEqual(Object.fromEntries(estados.map((r) => [r.id, [r.estado, r.ativa, r.envio_automatico]])), { [ativa]: ["PUBLICADA", true, false], [arquivada]: ["ARQUIVADA", false, false], [fotoUrl]: ["PUBLICADA", true, false] }, "nada passa a ser enviado automaticamente sem autorização");

    // 2. Arquivos.
    const insArq = `INSERT INTO whatsapp_atendimento_arquivos (empresa_id, ambiente, tipo, mime, nome, tamanho_bytes, sha256, conteudo, token, criado_por) VALUES ($1, 'staging', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`;
    const pdfA = await id(insArq, [A, "DOCUMENTO", "application/pdf", "Tabela sintética.pdf", PDF.length, sha(PDF), PDF, token(), u]);
    const pngA = await id(insArq, [A, "IMAGEM", "image/png", "Salão sintético.png", PNG.length, sha(PNG), PNG, token(), u]);
    const pdfB = await id(insArq, [B, "DOCUMENTO", "application/pdf", "Tabela de B.pdf", PDF.length, sha(PDF), PDF, token(), u]);
    await recusa(c, insArq, [A, "DOCUMENTO", "image/png", "x.pdf.", PDF.length, sha(PDF), PDF, token(), u], /whatsapp_arquivos_mime_por_tipo/);
    await recusa(c, insArq, [A, "DOCUMENTO", "application/pdf", "Errado.pdf", PDF.length, sha(PNG), PDF, token(), u], /whatsapp_arquivos_hash/);
    await recusa(c, insArq, [A, "DOCUMENTO", "application/pdf", "Errado.pdf", PDF.length + 1, sha(PDF), PDF, token(), u], /whatsapp_arquivos_tamanho/);
    await recusa(c, insArq, [A, "DOCUMENTO", "application/pdf", "../x.pdf", PDF.length, sha(PDF), PDF, token(), u], /whatsapp_atendimento_arquivos_nome_check/);
    const grande = Buffer.alloc(5 * 1024 * 1024 + 1);
    await recusa(c, insArq, [A, "IMAGEM", "image/png", "Grande.png", grande.length, sha(grande), grande, token(), u], /whatsapp_arquivos_tamanho/);
    const tokRepetido = (await c.query("SELECT token FROM whatsapp_atendimento_arquivos WHERE id = $1", [pdfA])).rows[0].token;
    await recusa(c, insArq, [A, "DOCUMENTO", "application/pdf", "Outra.pdf", PDF.length, sha(PDF), PDF, tokRepetido, u], /whatsapp_arquivos_token_uk/);
    await recusa(c, "UPDATE whatsapp_atendimento_arquivos SET nome = 'Trocado.pdf' WHERE id = $1", [pdfA], /só inserção/);
    await recusa(c, "DELETE FROM whatsapp_atendimento_arquivos WHERE id = $1", [pdfA], /só inserção/);

    // 3. Prontas.
    const insP = `INSERT INTO whatsapp_atendimento_mensagens_prontas (empresa_id, ambiente, titulo, categoria, tipo, texto, midia_url, arquivo_id, estado, ativa, envio_automatico, finalidade, estabelecimento_id, criada_por, atualizada_por)
      VALUES ($1, 'staging', $2, 'Teste', $3, 'legenda', $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING id`;
    const tabela = await id(insP, [A, "Tabela de preços", "DOCUMENTO", null, pdfA, "PUBLICADA", true, true, "PRECOS", null, u]);
    const rascunhoFoto = await id(insP, [A, "Salão (rascunho)", "IMAGEM", null, pngA, "RASCUNHO", true, false, "GERAL", null, u]);
    const rascunhoTexto = await id(insP, [A, "Horários (rascunho)", "TEXTO", null, null, "RASCUNHO", true, false, null, null, u]);
    assert.ok(rascunhoFoto);
    await recusa(c, insP, [A, cod("t"), "DOCUMENTO", "https://midia.exemplo.test/t.pdf", null, "PUBLICADA", true, false, null, null, u], /whatsapp_prontas_midia_por_tipo/);
    await recusa(c, insP, [A, cod("t"), "IMAGEM", "https://midia.exemplo.test/f.jpg", pngA, "PUBLICADA", true, false, null, null, u], /whatsapp_prontas_midia_por_tipo/);
    await recusa(c, insP, [A, cod("t"), "DOCUMENTO", null, pdfB, "PUBLICADA", true, false, null, null, u], /whatsapp_prontas_arquivo/);
    await recusa(c, insP, [A, cod("t"), "IMAGEM", null, pdfA, "PUBLICADA", true, false, null, null, u], /whatsapp_prontas_arquivo/);
    await recusa(c, insP, [A, cod("t"), "TEXTO", null, null, "ARQUIVADA", true, false, null, null, u], /whatsapp_prontas_estado_ativa/);
    await recusa(c, insP, [A, cod("t"), "TEXTO", null, null, "PUBLICADA", true, true, null, null, u], /whatsapp_prontas_automatico_finalidade/);
    await recusa(c, insP, [A, cod("t"), "TEXTO", null, null, "PUBLICADA", true, false, "OUTRA", null, u], /whatsapp_prontas_finalidade/);
    const unidadeB = await id(`INSERT INTO estabelecimentos (empresa_id, codigo, nome, status) VALUES ($1, $2, 'Unidade de B', 'SUSPENSO') RETURNING id`, [B, `unidade-b-${cod("x")}`]);
    await recusa(c, insP, [A, cod("t"), "TEXTO", null, null, "PUBLICADA", true, false, "LOCALIZACAO", unidadeB, u], /whatsapp_prontas_estabelecimento/);
    await recusa(c, "UPDATE whatsapp_atendimento_mensagens_prontas SET pacote_codigo = 'pacote com espaço' WHERE id = $1", [tabela], /whatsapp_prontas_pacote_codigo/);

    // 4. Mensagens: várias saídas da mesma entrada; PDF exige arquivo e nome.
    const insS = `INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, origem_id, origem_grupo_id, ordem, direcao, texto, estado, versao_conversa, midia_tipo, midia_arquivo_id, midia_nome, midia_pronta_id, midia_pronta_versao, fonte)
      VALUES ($1, $2, 'staging', $3, $4, $5, 'SAIDA', $6, 'PENDENTE', 0, $7, $8, $9, $10, $11, $12) RETURNING id`;
    await id(insS, [conversa, A, entrada, entrada, 0, "Segue a tabela.", null, null, null, null, null, { tipo: "texto" }]);
    await id(insS, [conversa, A, null, entrada, 1, "Tabela de preços", "DOCUMENTO", pdfA, "Tabela sintética.pdf", tabela, 0, { tipo: "pronta", id: tabela, versao: 0 }]);
    await recusa(c, insS, [conversa, A, null, entrada, 1, "duplicada", null, null, null, null, null, null], /whatsapp_mensagens_origem_grupo_uk/);
    await recusa(c, insS, [conversa, A, entrada, null, 0, "duplicada pela 060", null, null, null, null, null, null], /whatsapp_atendimento_mensagens_origem_id_key/);
    await recusa(c, insS, [conversa, A, null, entrada, 2, "sem nome", "DOCUMENTO", pdfA, null, tabela, 0, null], /whatsapp_mensagens_midia_par/);
    await recusa(c, insS, [conversa, A, null, entrada, 2, "tipo trocado", "IMAGEM", pdfA, null, tabela, 0, null], /whatsapp_mensagens_midia_arquivo/);
    await recusa(c, insS, [conversa, A, null, entrada, 2, "ordem", null, null, null, null, null, null].map((v, i) => (i === 4 ? 10 : v)), /whatsapp_mensagens_ordem/);
    // ON CONFLICT DO NOTHING (sem alvo) cobre as duas unicidades: um retry não duplica nada.
    await c.query(`${insS.replace(" RETURNING id", "")} ON CONFLICT DO NOTHING`, [conversa, A, entrada, entrada, 0, "retry", null, null, null, null, null, null]);
    assert.equal(await n("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE origem_grupo_id = $1", [entrada]), 2);
    await c.query("UPDATE whatsapp_atendimento_conversas SET contexto = '{\"convidados\": 60}'::jsonb, passagem = '{\"motivo\": \"PEDIDO\"}'::jsonb WHERE id = $1", [conversa]);

    // 5. Rollback.
    await assert.rejects(c.query(comDecisao(DOWN)), /arquivo próprio ou PDF na fila de envio/, "fila bloqueia mesmo com a decisão"); await c.query("ROLLBACK").catch(() => {});
    await c.query("UPDATE whatsapp_atendimento_mensagens SET estado = 'ENTREGUE' WHERE origem_grupo_id = $1", [entrada]);
    await assert.rejects(c.query(DOWN), /kidmais\.rollback_075_descartar/); await c.query("ROLLBACK").catch(() => {});
    await c.query(comDecisao(DOWN));
    for (const p of [POST060, POST073, POST074]) await c.query(p);
    assert.equal((await c.query("SELECT to_regclass('public.whatsapp_atendimento_arquivos') AS t")).rows[0].t, null);
    assert.deepEqual((await c.query("SELECT id, ativa FROM whatsapp_atendimento_mensagens_prontas ORDER BY titulo")).rows.map((r) => [r.id, r.ativa]).sort(),
      [[ativa, true], [arquivada, false], [fotoUrl, true], [rascunhoTexto, false]].sort(),
      "PDF e prontas com arquivo próprio (inclusive o rascunho de foto) saíram; rascunho de texto ficou ARQUIVADO (no código anterior apareceria ativo); foto por URL da 074 ficou");
    assert.equal(await n("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE midia_tipo = 'IMAGEM' AND midia_url IS NOT NULL"), 1, "a foto por URL enviada antes continua");
    assert.equal(await n("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND direcao = 'SAIDA'", [conversa]), 3, "saídas continuam no histórico (o PDF fica só com a legenda)");
    await c.query(UP); await c.query(POST);
  } finally {
    await c.end();
  }
});
