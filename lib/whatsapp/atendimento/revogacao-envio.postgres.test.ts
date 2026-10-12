import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { adiado, carregarAtendimento, cod, noPrazo } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";

/**
 * Corrida revogação × envio (revisão de 8b2c55d, item 4; 12/10/2026), determinística: a ordem é imposta por travas de uma
 * terceira conexão e confirmada em pg_stat_activity (quem espera e em qual consulta), nunca por tempo. Serviço, worker e
 * privacidade REAIS no modelo "082"; transporte simulado, nenhuma rede; dados sintéticos.
 *
 * Ponto de serialização observado: a revogação roda no Tenant Context, que trava a empresa (FOR UPDATE); toda transação
 * do worker começa pela empresa (FOR SHARE). Uma não começa enquanto a outra não termina.
 *  C1 a revogação chega primeiro: o worker espera a empresa já na reserva; a revogação cancela a saída com motivo e o
 *     worker não encontra o que enviar. Nada sai.
 *  C2 o envio chega primeiro: o worker segura a empresa e o arquivo (FOR SHARE) até gravar ENVIANDO; a revogação espera
 *     e então recusa (ATENDIMENTO_ENVIO_EM_ANDAMENTO) — ponto sem volta: o POST ao provedor não é desfeito. Depois do resultado
 *     (SUBMETIDA) a revogação passa; a cópia já entregue não é recolhida.
 *  C3 resposta em grupo já parcialmente enviada (texto SUBMETIDA, PDF na fila): a revogação recusa e nada muda.
 *  C4 resposta em grupo inteira na fila ("segue o PDF" + PDF): a revogação cancela AS DUAS com motivo, tira o PDF da
 *     memória de envio e passa a conversa à equipe; o worker depois não envia nada.
 */
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const PDF = Buffer.from("%PDF-1.4\n% material sintético da corrida\n%%EOF\n");

test("revogação × envio: travas na ordem conversa → arquivo, ponto sem volta e grupo sem \"segue o PDF\"", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  const x = await conectarDescartavel({ travar: false });
  try {
    assert.ok((await q("SELECT to_regclass('public.whatsapp_atendimento_controles_contato') IS NOT NULL AS e")).rows[0].e, "modelo com a 082 de 12/10");
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa sintética (corrida)', 'PROVISIONAMENTO') RETURNING id`, [cod("rv")]);
    await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness corrida', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, u]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), e]);
    const gestao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", id: s, empresa_ativa_id: e, autenticado_em: new Date().toISOString() };
    const A = carregarAtendimento(e);
    await A.servico.salvarConfiguracao(gestao as never, { ativo: true, nome: "Empresa sintética (corrida)", perguntas: [] });

    const envios: ConteudoSaida[] = [];
    const deps = { interpretar: async () => { throw new Error("sem modelo"); }, enviar: async (_c: string, conteudo: ConteudoSaida) => { envios.push(conteudo); return cod("gs-"); } };
    const conversa = async (contato: string) => (await q("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [e, contato])).rows[0];
    const mensagem = async (mid: string) => (await q("SELECT estado, motivo_cancelamento FROM whatsapp_atendimento_mensagens WHERE id = $1", [mid])).rows[0];
    const arquivo = async (aid: string) => (await q("SELECT revogado_em IS NOT NULL AS revogado, octet_length(conteudo) AS n FROM whatsapp_atendimento_arquivos WHERE id = $1", [aid])).rows[0];
    /** Espera até cada trecho aparecer numa consulta à espera de trava (wait_event_type = 'Lock'); falha em 10 s. */
    async function esperando(trechos: string[]) {
      let visto: string[] = [];
      for (let i = 0; i < 400; i++) {
        const r = (await q("SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows.map((l) => String(l.query));
        if (trechos.every((tr) => r.some((l) => l.includes(tr)))) return;
        visto = r;
        await new Promise((ok) => setTimeout(ok, 25));
      }
      throw new Error(`não chegou à espera: ${trechos.join(" | ")}; esperando: ${visto.map((l) => l.replace(/\s+/g, " ").slice(0, 120)).join(" | ")}`);
    }
    /** Conversa assumida pela Gestão com um PDF da biblioteca na fila (saída humana PENDENTE). */
    async function pdfNaFila(contato: string) {
      const arq = await A.biblioteca.salvarArquivo(gestao as never, { nome: `${cod("material-")}.pdf`, bytes: PDF, tipoEsperado: "DOCUMENTO" });
      const pronta = (await A.biblioteca.salvarPronta(gestao as never, { titulo: cod("PDF "), categoria: "Teste", tipo: "DOCUMENTO", texto: "Material", link: null, atalho: null, arquivoId: arq.id, estado: "PUBLICADA", envioAutomatico: true, finalidade: "PACOTES" })).id;
      await A.servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "me manda o material", timestamp: Date.now() - 1000, nomePerfil: null });
      let cv = await conversa(contato);
      await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSADA' WHERE conversa_id = $1 AND estado = 'PENDENTE'", [cv.id]);
      await A.servico.controlarAtendimento(gestao as never, { acao: "assumir", conversaId: cv.id, versao: Number(cv.versao) });
      cv = await conversa(contato);
      const versao = Number((await q("SELECT versao FROM whatsapp_atendimento_mensagens_prontas WHERE id = $1", [pronta])).rows[0].versao);
      await A.servico.controlarAtendimento(gestao as never, { acao: "enviar", conversaId: cv.id, versao: Number(cv.versao), prontaMidiaId: pronta, prontaVersao: versao });
      const saida = (await q("SELECT id FROM whatsapp_atendimento_mensagens WHERE midia_arquivo_id = $1", [arq.id])).rows[0].id as string;
      return { arq: arq.id, pronta, versao, saida, conversa: cv.id };
    }

    // C1 — a revogação chega primeiro.
    const c1 = await pdfNaFila("5561900000901");
    await x.query("BEGIN");
    await x.query("SELECT id FROM whatsapp_atendimento_arquivos WHERE id = $1 FOR UPDATE", [c1.arq]);
    const rev1 = A.privacidade.revogarArquivo(gestao, { arquivoId: c1.arq });
    await esperando(["revogado_em IS NULL FOR UPDATE"]);
    const lote1 = A.worker.processarLote(deps, { maxTarefas: 3 });
    await esperando(["revogado_em IS NULL FOR UPDATE", "FROM empresas WHERE id=$1 AND status='ATIVA' FOR SHARE"]);
    assert.equal((await mensagem(c1.saida)).estado, "PENDENTE", "C1: o worker espera a empresa ainda na reserva");
    await x.query("COMMIT");
    const r1 = await noPrazo(rev1, 10_000, "C1 revogação");
    await noPrazo(lote1, 10_000, "C1 worker");
    assert.equal(envios.length, 0, "C1: nada sai");
    assert.equal((await arquivo(c1.arq)).revogado, true);
    assert.equal(r1.saidasCanceladas, 1, "C1: a revogação cancela a saída da fila");
    assert.deepEqual(await mensagem(c1.saida), { estado: "CANCELADA", motivo_cancelamento: "ARQUIVO_REVOGADO" }, "C1: cancelada com motivo, não em silêncio");

    // C2 — o envio chega primeiro; ponto sem volta.
    const c2 = await pdfNaFila("5561900000902");
    const portao = adiado<string>();
    let chamadas = 0;
    const depsLentos = { ...deps, enviar: async (_c: string, conteudo: ConteudoSaida) => { chamadas++; envios.push(conteudo); return portao.p; } };
    await x.query("BEGIN");
    await x.query("SELECT empresa_id FROM whatsapp_atendimento_config WHERE empresa_id = $1 FOR UPDATE", [e]);
    const lote2 = A.worker.processarLote(depsLentos, { maxTarefas: 1 });
    await esperando(["FROM whatsapp_atendimento_config WHERE empresa_id=$1 AND ambiente=$2 FOR SHARE"]);
    assert.equal((await mensagem(c2.saida)).estado, "PROCESSANDO", "C2: o worker está na transação de envio, com o arquivo em FOR SHARE");
    const rev2 = A.privacidade.revogarArquivo(gestao, { arquivoId: c2.arq });
    await esperando(["FROM whatsapp_atendimento_config WHERE empresa_id=$1 AND ambiente=$2 FOR SHARE", "FROM empresas WHERE id = $1::uuid FOR UPDATE"]);
    await x.query("COMMIT");
    await assert.rejects(noPrazo(rev2, 10_000, "C2 revogação"), /ATENDIMENTO_ENVIO_EM_ANDAMENTO/, "C2: envio já iniciado: recusa");
    assert.equal(chamadas, 1, "C2: o POST ao provedor já começou");
    assert.equal((await mensagem(c2.saida)).estado, "ENVIANDO");
    assert.deepEqual(await arquivo(c2.arq), { revogado: false, n: PDF.length }, "C2: nada revogado pela tentativa recusada");
    portao.liberar(cod("gs-"));
    await noPrazo(lote2, 10_000, "C2 worker");
    assert.equal((await mensagem(c2.saida)).estado, "SUBMETIDA");
    const r2 = await A.privacidade.revogarArquivo(gestao, { arquivoId: c2.arq });
    assert.equal(r2.saidasCanceladas, 0, "C2: depois do resultado a revogação passa; a cópia enviada não é recolhida");
    assert.equal((await arquivo(c2.arq)).revogado, true);

    // C3 e C4 — respostas do Wall-e em grupo (texto + PDF).
    async function grupo(contato: string, estadoTexto: "PENDENTE" | "SUBMETIDA") {
      const base = await pdfNaFila(contato);
      await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'CANCELADA' WHERE id = $1", [base.saida]);
      const entrada = (await q("SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND direcao = 'ENTRADA'", [base.conversa])).rows[0].id as string;
      await q(`UPDATE whatsapp_atendimento_conversas SET estado = 'IA', responsavel_id = NULL, contexto = jsonb_build_object('enviados', jsonb_build_array(jsonb_build_object('prontaId', $2::text, 'versao', $3::int, 'finalidade', 'PACOTES', 'em', now()::text))) WHERE id = $1`, [base.conversa, base.pronta, base.versao]);
      const versao = Number((await q("SELECT versao FROM whatsapp_atendimento_conversas WHERE id = $1", [base.conversa])).rows[0].versao);
      const fonte = JSON.stringify({ tipo: "WALLE", fontes: [{ tipo: "PRONTA", id: base.pronta, versao: base.versao }] });
      const texto = await id(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, origem_id, origem_grupo_id, ordem, direcao, texto, estado, versao_conversa, fonte, provedor_id)
        VALUES ($1, $2, 'staging', $3, $3, 0, 'SAIDA', 'Segue o PDF com os pacotes.', $4, $5, $6::jsonb, $7) RETURNING id`, [base.conversa, e, entrada, estadoTexto, versao, fonte, estadoTexto === "SUBMETIDA" ? cod("gs-") : null]);
      const pdf = await id(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, origem_grupo_id, ordem, direcao, texto, estado, versao_conversa, midia_tipo, midia_arquivo_id, midia_nome, midia_pronta_id, midia_pronta_versao, fonte, criada_em)
        VALUES ($1, $2, 'staging', $3, 1, 'SAIDA', 'Material', 'PENDENTE', $4, 'DOCUMENTO', $5, 'material.pdf', $6, $7, $8::jsonb, clock_timestamp() + interval '1 millisecond') RETURNING id`, [base.conversa, e, entrada, versao, base.arq, base.pronta, base.versao, fonte]);
      return { ...base, texto, pdf };
    }
    const c3 = await grupo("5561900000903", "SUBMETIDA");
    const antes3 = (await q("SELECT md5(string_agg(m::text, '|' ORDER BY m.id)) AS h FROM whatsapp_atendimento_mensagens m WHERE conversa_id = $1", [c3.conversa])).rows[0].h;
    await assert.rejects(A.privacidade.revogarArquivo(gestao, { arquivoId: c3.arq }), /ATENDIMENTO_ENVIO_EM_ANDAMENTO/, "C3: grupo parcialmente enviado: recusa");
    assert.equal((await q("SELECT md5(string_agg(m::text, '|' ORDER BY m.id)) AS h FROM whatsapp_atendimento_mensagens m WHERE conversa_id = $1", [c3.conversa])).rows[0].h, antes3, "C3: nada muda");
    assert.equal((await arquivo(c3.arq)).revogado, false);
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'CANCELADA' WHERE id = $1", [c3.pdf]);

    const c4 = await grupo("5561900000904", "PENDENTE");
    const r4 = await A.privacidade.revogarArquivo(gestao, { arquivoId: c4.arq });
    assert.equal(r4.saidasCanceladas, 2, "C4: o PDF e o \"segue o PDF\"");
    for (const mid of [c4.texto, c4.pdf]) assert.deepEqual(await mensagem(mid), { estado: "CANCELADA", motivo_cancelamento: "ARQUIVO_REVOGADO" }, "C4: motivo nas duas");
    const cv4 = (await q("SELECT estado, contexto FROM whatsapp_atendimento_conversas WHERE id = $1", [c4.conversa])).rows[0];
    assert.equal(cv4.estado, "AGUARDANDO_HUMANO", "C4: equipe chamada"); assert.deepEqual(cv4.contexto.enviados, [], "C4: memória de envio sem o PDF");
    const antes4 = envios.length;
    await A.worker.processarLote(deps, { maxTarefas: 5 });
    assert.equal(envios.length, antes4, "C4: o worker não envia nada do grupo");
  } finally {
    await x.query("ROLLBACK").catch(() => {});
    await x.end();
    await c.end();
  }
});
