import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { adiado, carregarAtendimento, cod, noPrazo } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";

/**
 * Correções da revisão independente de 69dc301 (12/10/2026), no modelo "082", com serviço, worker e privacidade REAIS,
 * transporte simulado e dados sintéticos. Cada cena é a que o experimento da revisão mostrou com defeito (X1–X5):
 *  H2 retenção × entrada nova chegando entre a escolha das candidatas e a exclusão: a conversa ativa fica (RECENTE);
 *  M1 reentrega de evento excluído depois da purga do hash (30 dias): não grava (janela de reentrega da recepção);
 *  M5 duas execuções simultâneas: a segunda devolve EM_EXECUCAO; execução presa há > 2 h vira INTERROMPIDA; trava da
 *     conversa segura por outra transação: adiada em até ~5 s (lock_timeout), não espera para sempre;
 *  M3 grupo texto + PDF: falha incerta no texto ou recusa do PDF → o resto do grupo é cancelado com GRUPO_INCOMPLETO,
 *     a memória de envio perde o material não enviado e a equipe é chamada;
 *  B2 revogar com o grupo parcialmente enviado: ATENDIMENTO_GRUPO_PARCIAL (não "aguarde");
 *  M4 busca exata pelo número completo; número inválido recusado;
 *  B1 envios do arquivo sem confirmação de entrega contados para o aviso da tela;
 *  M5 tela: só a situação da execução e as exclusões DESTA empresa (sem falhas/códigos globais) e o aviso de atraso.
 */
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const PDF = Buffer.from("%PDF-1.4\n% material sintético das correções\n%%EOF\n");

test("correções da revisão de 69dc301: H2, M1, M5, M3, B2, M4, B1", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  const x = await conectarDescartavel({ travar: false });
  try {
    assert.ok((await q("SELECT to_regclass('public.whatsapp_retencao_uma_por_vez') IS NOT NULL AS e")).rows[0].e, "modelo com a 082 corrigida");
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa sintética (correções)', 'PROVISIONAMENTO') RETURNING id`, [cod("rc")]);
    await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness correções', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [e, u]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), e]);
    const gestao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO", id: s, empresa_ativa_id: e, autenticado_em: new Date().toISOString() };
    const A = carregarAtendimento(e);
    await A.servico.salvarConfiguracao(gestao as never, { ativo: true, nome: "Empresa sintética (correções)", perguntas: [] });
    const conversa = async (contato: string) => (await q("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [e, contato])).rows[0];
    const receber = (contato: string, texto: string, evento = cod("evt-"), quando = Date.now() - 1000) =>
      A.servico.receberEntrada({ id: evento, app: "KidmaisManager", source: contato, texto, timestamp: quando, nomePerfil: null });
    const limparFila = () => q("UPDATE whatsapp_atendimento_mensagens SET estado = CASE WHEN direcao = 'ENTRADA' THEN 'PROCESSADA' ELSE 'CANCELADA' END WHERE empresa_id = $1 AND estado = 'PENDENTE'", [e]);
    const envelhecer = async (conv: string) => {
      await q("UPDATE whatsapp_atendimento_conversas SET ultima_entrada_em = clock_timestamp() - interval '40 days', atualizada_em = clock_timestamp() - interval '40 days' WHERE id = $1", [conv]);
      await q("UPDATE whatsapp_atendimento_mensagens SET criada_em = clock_timestamp() - interval '40 days' WHERE conversa_id = $1", [conv]);
    };
    async function esperando(trecho: string) {
      for (let i = 0; i < 400; i++) {
        if ((await q("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%' || $1 || '%'", [trecho])).rows.length) return;
        await new Promise((ok) => setTimeout(ok, 25));
      }
      throw new Error(`não chegou à espera: ${trecho}`);
    }

    // H2 — a mensagem nova chega entre a escolha e a exclusão: a conversa fica.
    await A.privacidade.configurarRetencao(gestao, { prazoDias: 30 });
    const n2 = "5561900000961";
    await receber(n2, "mensagem antiga H2"); await limparFila();
    const cv2 = await conversa(n2);
    await envelhecer(cv2.id);
    await x.query("BEGIN");
    await x.query("SELECT id FROM whatsapp_atendimento_conversas WHERE id = $1 FOR UPDATE", [cv2.id]);
    const ret2 = A.privacidade.executarRetencao();
    await esperando("SELECT id,contato,nao_contatar,estado,contexto FROM whatsapp_atendimento_conversas");
    await x.query("UPDATE whatsapp_atendimento_conversas SET ultima_entrada_em = clock_timestamp(), atualizada_em = clock_timestamp(), versao = versao + 1 WHERE id = $1", [cv2.id]);
    await x.query(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, externa_id, direcao, texto, estado, versao_conversa)
      SELECT id, empresa_id, ambiente, $2, 'ENTRADA', 'mensagem NOVA do cliente', 'PENDENTE', versao FROM whatsapp_atendimento_conversas WHERE id = $1`, [cv2.id, cod("evt-h2-")]);
    await x.query("COMMIT");
    const r2 = await noPrazo(ret2, 15_000, "H2 retenção");
    assert.ok(r2.estado === "CONCLUIDA" && r2.recentes === 1 && r2.excluidas === 0, `H2: conversa reativada não é apagada (${JSON.stringify(r2)})`);
    assert.ok(await conversa(n2), "H2: a conversa e a mensagem nova continuam");
    assert.equal((await q("SELECT recentes FROM whatsapp_atendimento_retencao_execucoes ORDER BY iniciada_em DESC LIMIT 1")).rows[0].recentes, 1, "H2: contada como recente no registro");
    await limparFila();

    // M1 — reentrega depois da purga do hash: não grava.
    const n1 = "5561900000962", ev1 = cod("evt-m1-");
    await receber(n1, "texto sintético M1 para excluir", ev1, Date.now() - 3 * 86400_000); await limparFila();
    await A.privacidade.excluirConversaAPedido(gestao, { conversaId: (await conversa(n1)).id, motivo: "PEDIDO_DO_TITULAR" });
    await q("UPDATE whatsapp_atendimento_eventos_excluidos SET excluido_em = clock_timestamp() - interval '31 days' WHERE empresa_id = $1", [e]);
    const r1 = await A.privacidade.executarRetencao();
    assert.ok(r1.estado === "CONCLUIDA" && r1.dedup >= 1, "M1: hash vencido purgado");
    await receber(n1, "texto sintético M1 para excluir", ev1, Date.now() - 31 * 86400_000);
    assert.equal(await conversa(n1), undefined, "M1: reentrega com horário além da janela não recria nada");
    await receber(n1, "mensagem nova de verdade");
    assert.ok(await conversa(n1), "M1: evento atual continua gravando");
    await limparFila();

    // M5 — execução única, interrompida e espera limitada.
    const n5 = "5561900000963";
    await receber(n5, "mensagem antiga M5"); await limparFila();
    const cv5 = await conversa(n5);
    await envelhecer(cv5.id);
    await x.query("BEGIN");
    await x.query("SELECT id FROM whatsapp_atendimento_conversas WHERE id = $1 FOR UPDATE", [cv5.id]);
    const inicio = Date.now();
    const p1 = A.privacidade.executarRetencao();
    await esperando("SELECT id,contato,nao_contatar,estado,contexto FROM whatsapp_atendimento_conversas");
    const p2 = await A.privacidade.executarRetencao();
    assert.equal(p2.estado, "EM_EXECUCAO", "M5: a segunda execução simultânea é recusada");
    const r5 = await noPrazo(p1, 20_000, "M5 retenção com a conversa travada");
    const ms = Date.now() - inicio;
    await x.query("ROLLBACK");
    assert.ok(r5.estado === "CONCLUIDA" && r5.adiadas === 1 && r5.excluidas === 0 && ms < 15_000, `M5: trava não obtida em ~5 s = adiada (${ms} ms, ${JSON.stringify(r5)})`);
    await q("INSERT INTO whatsapp_atendimento_retencao_execucoes (ambiente, estado, iniciada_em) VALUES ('staging', 'EM_ANDAMENTO', clock_timestamp() - interval '3 hours')");
    const r5b = await A.privacidade.executarRetencao();
    assert.equal(r5b.estado, "CONCLUIDA", "M5: execução presa há > 2 h não bloqueia a próxima");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_retencao_execucoes WHERE estado = 'INTERROMPIDA'")).rows[0].n, 1, "M5: a presa vira INTERROMPIDA");
    assert.equal((await A.privacidade.executarRetencao()).estado, "CONCLUIDA");

    // M5 (tela) e M4/B1 — situação da privacidade.
    const sit = await A.privacidade.situacaoPrivacidade(gestao);
    assert.equal(sit.retencao.atrasada, false, "M5: execução recente, sem atraso");
    assert.deepEqual(Object.keys(sit.retencao.ultimaExecucao ?? {}).sort(), ["excluidasDestaEmpresa", "iniciadaEm", "situacao", "terminadaEm"], "M5: nada de falhas/códigos globais na tela");
    assert.equal(sit.retencao.ultimaExecucao?.situacao, "EXECUTADA");
    await q("UPDATE whatsapp_atendimento_retencao_execucoes SET terminada_em = clock_timestamp() - interval '40 hours', iniciada_em = clock_timestamp() - interval '40 hours' WHERE estado <> 'EM_ANDAMENTO'");
    assert.equal((await A.privacidade.situacaoPrivacidade(gestao)).retencao.atrasada, true, "M5: com prazo e sem execução nas últimas 36 h, atrasada");
    assert.equal(sit.busca, "RECENTES");
    // n5 foi excluída pela retenção (inativa além do prazo); n2 continua (reativada em H2).
    const busca = await A.privacidade.situacaoPrivacidade(gestao, { contato: n2 });
    assert.ok(busca.busca === "NUMERO" && busca.conversas.length === 1 && busca.conversas[0].contatoFinal === n2.slice(-4), "M4: busca exata pelo número completo");
    assert.equal((await A.privacidade.situacaoPrivacidade(gestao, { contato: n5 })).conversas.length, 0, "M5/M4: a inativa foi excluída pela retenção");
    assert.equal((await A.privacidade.situacaoPrivacidade(gestao, { contato: "5561900009999" })).conversas.length, 0, "M4: número sem conversa");
    await assert.rejects(A.privacidade.situacaoPrivacidade(gestao, { contato: "61 9000" }), /ATENDIMENTO_CONTATO_INVALIDO/, "M4: número inválido");
    await A.privacidade.configurarRetencao(gestao, { prazoDias: null });

    // M3 e B2 — grupo texto + PDF.
    async function grupo(contato: string) {
      const arq = await A.biblioteca.salvarArquivo(gestao as never, { nome: `${cod("g-")}.pdf`, bytes: PDF, tipoEsperado: "DOCUMENTO" });
      const pronta = (await A.biblioteca.salvarPronta(gestao as never, { titulo: cod("PDF "), categoria: "Teste", tipo: "DOCUMENTO", texto: "Material", link: null, atalho: null, arquivoId: arq.id, estado: "PUBLICADA", envioAutomatico: true, finalidade: "PACOTES" })).id;
      const versaoP = Number((await q("SELECT versao FROM whatsapp_atendimento_mensagens_prontas WHERE id = $1", [pronta])).rows[0].versao);
      await receber(contato, "quero a tabela"); await limparFila();
      const cv = await conversa(contato);
      const entrada = (await q("SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND direcao = 'ENTRADA' ORDER BY criada_em DESC LIMIT 1", [cv.id])).rows[0].id as string;
      await q(`UPDATE whatsapp_atendimento_conversas SET estado = 'IA', contexto = jsonb_build_object('enviados', jsonb_build_array(jsonb_build_object('prontaId', $2::text, 'versao', $3::int, 'finalidade', 'PACOTES', 'em', now()::text))) WHERE id = $1`, [cv.id, pronta, versaoP]);
      const versao = Number((await conversa(contato)).versao);
      const fonte = JSON.stringify({ tipo: "WALLE", fontes: [{ tipo: "PRONTA", id: pronta, versao: versaoP }] });
      const texto = await id(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, origem_id, origem_grupo_id, ordem, direcao, texto, estado, versao_conversa, fonte)
        VALUES ($1, $2, 'staging', $3, $3, 0, 'SAIDA', 'Segue o PDF com os pacotes.', 'PENDENTE', $4, $5::jsonb) RETURNING id`, [cv.id, e, entrada, versao, fonte]);
      const pdf = await id(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, origem_grupo_id, ordem, direcao, texto, estado, versao_conversa, midia_tipo, midia_arquivo_id, midia_nome, midia_pronta_id, midia_pronta_versao, fonte, criada_em)
        VALUES ($1, $2, 'staging', $3, 1, 'SAIDA', 'Material', 'PENDENTE', $4, 'DOCUMENTO', $5, 'material.pdf', $6, $7, $8::jsonb, clock_timestamp() + interval '1 millisecond') RETURNING id`, [cv.id, e, entrada, versao, arq.id, pronta, versaoP, fonte]);
      return { arq: arq.id, texto, pdf, conversa: cv.id };
    }
    const estado = async (mid: string) => (await q("SELECT estado, motivo_cancelamento FROM whatsapp_atendimento_mensagens WHERE id = $1", [mid])).rows[0];
    const conv = async (cid: string) => (await q("SELECT estado, contexto FROM whatsapp_atendimento_conversas WHERE id = $1", [cid])).rows[0];
    const g1 = await grupo("5561900000964");
    const tentativas1: string[] = [];
    await A.worker.processarLote({ interpretar: null, enviar: async (_c: string, ct: ConteudoSaida) => { tentativas1.push(ct.tipo); if (ct.tipo === "TEXTO") throw new Error("falha de rede sintética"); return cod("gs-"); } } as never, { maxTarefas: 5 });
    assert.deepEqual(tentativas1, ["TEXTO"], "M3: o PDF não sai depois da falha do texto");
    assert.equal((await estado(g1.texto)).estado, "INCERTO");
    assert.deepEqual(await estado(g1.pdf), { estado: "CANCELADA", motivo_cancelamento: "GRUPO_INCOMPLETO" }, "M3: cancelado COM motivo");
    const c1 = await conv(g1.conversa);
    assert.equal(c1.estado, "AGUARDANDO_HUMANO"); assert.deepEqual(c1.contexto.enviados, [], "M3: o PDF não enviado sai da memória");
    const g2 = await grupo("5561900000965");
    await A.worker.processarLote({ interpretar: null, enviar: async (_c: string, ct: ConteudoSaida) => { if (ct.tipo !== "TEXTO") throw new Error("ATENDIMENTO_ENVIO_RECUSADO"); return cod("gs-"); } } as never, { maxTarefas: 5 });
    assert.equal((await estado(g2.texto)).estado, "SUBMETIDA"); assert.equal((await estado(g2.pdf)).estado, "FALHOU");
    const c2 = await conv(g2.conversa);
    assert.equal(c2.estado, "AGUARDANDO_HUMANO", "M3: equipe chamada (o texto já saiu sem o PDF: sem atomicidade no provedor)");
    assert.deepEqual(c2.contexto.enviados, [], "M3: PDF recusado (certamente não saiu) sai da memória");

    // B2 — revogar com o grupo parcialmente enviado.
    const g3 = await grupo("5561900000966");
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'SUBMETIDA', provedor_id = $2 WHERE id = $1", [g3.texto, cod("gs-")]);
    await assert.rejects(A.privacidade.revogarArquivo(gestao, { arquivoId: g3.arq }), /ATENDIMENTO_GRUPO_PARCIAL/, "B2: código próprio, não 'aguarde'");
    // B1 — envios sem confirmação contados (o texto SUBMETIDA não tem o arquivo; marca o PDF como SUBMETIDA para contar).
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'SUBMETIDA', provedor_id = $2 WHERE id = $1", [g3.pdf, cod("gs-")]);
    const arqSit = (await A.privacidade.situacaoPrivacidade(gestao)).arquivos.find((a) => a.id === g3.arq);
    assert.equal(arqSit?.enviosSemConfirmacao, 1, "B1: a tela avisa o envio sem confirmação antes de revogar");
    // C2 (envio em curso) continua com o código de "aguardar".
    const g4 = await grupo("5561900000967");
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'CANCELADA' WHERE id = $1", [g4.texto]);
    const portao = adiado<string>();
    const lote = A.worker.processarLote({ interpretar: null, enviar: async () => portao.p } as never, { maxTarefas: 1 });
    for (let i = 0; i < 400 && (await estado(g4.pdf)).estado !== "ENVIANDO"; i++) await new Promise((ok) => setTimeout(ok, 25));
    await assert.rejects(A.privacidade.revogarArquivo(gestao, { arquivoId: g4.arq }), /ATENDIMENTO_ENVIO_EM_ANDAMENTO/);
    portao.liberar(cod("gs-")); await noPrazo(lote, 10_000, "envio liberado");
  } finally {
    await x.query("ROLLBACK").catch(() => {});
    await x.end();
    await c.end();
  }
});
