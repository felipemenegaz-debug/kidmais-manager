import test from "node:test";
import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { randomBytes } from "node:crypto";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarComponente } from "../../../components/admin/teste-componente.ts";
import * as arquivos from "./arquivos.ts";
import { carregarAtendimento, cod, db } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";

/**
 * Privacidade (D2 e D3) no schema integrado (modelo "082"), com o serviço, o worker e a rota pública REAIS e dados
 * sintéticos; transporte simulado, nenhuma rede.
 *
 *  P1 exclusão a pedido (gestão): mensagens, status do provedor, nome de perfil, memória, passagem e a conversa saem; a
 *     auditoria fica sem o vínculo; o registro de privacidade não guarda contato nem texto; a conversa de OUTRA empresa
 *     com o mesmo número fica idêntica; outra empresa e a equipe (ADMINISTRATIVO) são recusadas sem apagar nada;
 *  P2 contato com PARAR: só o número e a marca ficam (o pedido de não contatar continua valendo numa mensagem nova);
 *  P3 tarefa em andamento (PROCESSANDO, ou a linha travada pelo worker) adia a exclusão sem apagar nada;
 *  P4 retenção: sem prazo (ausente ou inválido) nada é apagado; com prazo, só as conversas inativas além dele, de
 *     todas as empresas; a conversa já reduzida à marca de PARAR não é selecionada de novo;
 *  P5 revogação de arquivo: servido antes; depois, não servido, conteúdo vazio, link trocado, pronta arquivada, saída na
 *     fila cancelada, registro; o gatilho recusa restaurar, apagar ou mudar de novo; outra empresa não revoga;
 *  P6 troca de link: o link antigo deixa de servir e o novo serve; P7 expiração: vencido não é servido nem enviado pelo
 *     worker (a saída é cancelada); sem expiração volta a servir; P8 empresa suspensa: o arquivo não é servido.
 */
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const PDF = Buffer.from("%PDF-1.4\n% material sintético da privacidade\n%%EOF\n");
const publico = carregarComponente("lib/whatsapp/atendimento/arquivos-publico.ts", {
  "node:crypto": nodeCrypto, "../../db/postgres.ts": { db }, "./configuracao.ts": { ambienteAtendimento: () => "staging" }, "./arquivos.ts": arquivos,
}).modulo as typeof import("./arquivos-publico.ts");

test("privacidade do atendimento: exclusão (pedido e retenção), PARAR preservado, tarefas pendentes, revogação, troca de link e expiração de arquivos", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  try {
    assert.ok((await q("SELECT to_regclass('public.whatsapp_atendimento_privacidade') IS NOT NULL AS e")).rows[0].e, "modelo com a 082 (registro de privacidade)");
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    async function empresa(rotulo: string, papel = "REPRESENTANTE_AUTORIZADO") {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("pv"), `Empresa sintética ${rotulo} (privacidade)`]);
      await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      const sessao = async (p: string) => {
        const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness privacidade', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, p]);
        const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [e, u, p]);
        await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
        const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
          VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), e]);
        return { usuario_id: u, papel: p, id: s, empresa_ativa_id: e } as never;
      };
      const gestao = await sessao(papel);
      const equipe = await sessao("ADMINISTRATIVO");
      const h = carregarAtendimento(e);
      await h.servico.salvarConfiguracao(gestao, { ativo: true, nome: `Empresa sintética ${rotulo}`, perguntas: [] });
      return { e, gestao, equipe, ...h };
    }
    const A = await empresa("A"), B = await empresa("B");
    const conversa = async (emp: string, contato: string) => (await q("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [emp, contato])).rows[0];
    const receber = (h: typeof A, contato: string, texto: string, nome: string | null = null) =>
      h.servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp: Date.now() - 1000, nomePerfil: nome });
    const retrato = async (conv: string) => (await q(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*)::int AS n FROM (
      SELECT c::text AS x FROM whatsapp_atendimento_conversas c WHERE c.id = $1 UNION ALL SELECT m::text FROM whatsapp_atendimento_mensagens m WHERE m.conversa_id = $1) s`, [conv])).rows[0];

    // P1 — exclusão a pedido.
    const numero = "5561900000831";
    await receber(A, numero, "Olá, meu cpf é 123.456.789-09", "Perfil sintético A");
    await receber(B, numero, "Olá da outra empresa", "Perfil sintético B");
    let cvA = await conversa(A.e, numero);
    const cvB = await conversa(B.e, numero);
    await A.servico.controlarAtendimento(A.gestao, { acao: "assumir", conversaId: cvA.id, versao: Number(cvA.versao) });
    cvA = await conversa(A.e, numero);
    await A.servico.controlarAtendimento(A.gestao, { acao: "enviar", conversaId: cvA.id, versao: Number(cvA.versao), texto: "Resposta sintética" });
    const envios: ConteudoSaida[] = [];
    const deps = { interpretar: async () => { throw new Error("sem modelo"); }, enviar: async (_c: string, conteudo: ConteudoSaida) => { envios.push(conteudo); return cod("gs-"); } };
    await A.worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(envios.length, 1, "P1: a resposta da equipe saiu (transporte simulado)");
    const provedor = (await q("SELECT provedor_id FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND provedor_id IS NOT NULL", [cvA.id])).rows[0].provedor_id as string;
    await q("INSERT INTO whatsapp_atendimento_status (empresa_id, ambiente, provedor_id, estado) VALUES ($1, 'staging', $2, 'ENTREGUE') ON CONFLICT DO NOTHING", [A.e, `${provedor}-tardio`]);
    await q("UPDATE whatsapp_atendimento_mensagens SET provedor_id = $2 WHERE conversa_id = $1 AND provedor_id = $3", [cvA.id, `${provedor}-tardio`, provedor]);
    await q(`UPDATE whatsapp_atendimento_conversas SET contexto = '{"tema":"Tema sintético","data":"2027-11-14"}'::jsonb, passagem = '{"motivo":"HUMANO","ultimaMensagem":"texto sintético"}'::jsonb WHERE id = $1`, [cvA.id]);
    const auditoriaAntes = Number((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_auditoria WHERE empresa_id = $1", [A.e])).rows[0].n);
    const bAntes = await retrato(cvB.id);
    await assert.rejects(B.privacidade.excluirConversaAPedido(B.gestao, { conversaId: cvA.id }), /ATENDIMENTO_NAO_ENCONTRADO/, "P1: outra empresa não alcança a conversa");
    await assert.rejects(A.privacidade.excluirConversaAPedido(A.equipe, { conversaId: cvA.id }), /ATENDIMENTO_ACESSO_NEGADO/, "P1: a equipe não exclui");
    assert.ok(await conversa(A.e, numero), "P1: recusas não apagam nada");
    const r1 = await A.privacidade.excluirConversaAPedido(A.gestao, { conversaId: cvA.id });
    assert.equal(r1.estado, "EXCLUIDA");
    assert.ok(r1.estado === "EXCLUIDA" && r1.mensagens >= 2 && !r1.manteveNaoContatar, "P1: mensagens contadas");
    assert.equal(await conversa(A.e, numero), undefined, "P1: conversa apagada (nome de perfil, memória e passagem junto)");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1", [cvA.id])).rows[0].n, 0, "P1: mensagens apagadas");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_status WHERE provedor_id = $1", [`${provedor}-tardio`])).rows[0].n, 0, "P1: status do provedor apagado");
    assert.equal(Number((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_auditoria WHERE empresa_id = $1", [A.e])).rows[0].n), auditoriaAntes, "P1: auditoria preservada");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_auditoria WHERE conversa_id = $1", [cvA.id])).rows[0].n, 0, "P1: auditoria sem o vínculo");
    const reg = (await q("SELECT * FROM whatsapp_atendimento_privacidade WHERE conversa_id = $1", [cvA.id])).rows;
    assert.equal(reg.length, 1); assert.equal(reg[0].acao, "CONVERSA_EXCLUIDA"); assert.equal(reg[0].origem, "PEDIDO");
    assert.ok(!JSON.stringify(reg[0]).includes(numero) && !JSON.stringify(reg[0]).includes("123.456.789-09"), "P1: registro sem contato nem texto");
    assert.deepEqual(await retrato(cvB.id), bAntes, "P1: a conversa da outra empresa (mesmo número) fica idêntica");

    // P2 — contato com PARAR: só o número e a marca ficam; mensagem nova continua bloqueada.
    const numeroParar = "5561900000832";
    await receber(A, numeroParar, "Quero saber o preço", "Perfil sintético parar");
    await q("UPDATE whatsapp_atendimento_conversas SET nao_contatar = true, estado = 'ENCERRADA', contexto = '{\"tema\":\"x\"}'::jsonb WHERE empresa_id = $1 AND contato = $2", [A.e, numeroParar]);
    const cvParar = await conversa(A.e, numeroParar);
    const r2 = await A.privacidade.excluirConversaAPedido(A.gestao, { conversaId: cvParar.id });
    assert.ok(r2.estado === "EXCLUIDA" && r2.manteveNaoContatar, "P2: marca preservada");
    const reduzida = await conversa(A.e, numeroParar);
    assert.equal(reduzida.nao_contatar, true); assert.equal(reduzida.nome_perfil, null); assert.deepEqual(reduzida.contexto, {}); assert.equal(reduzida.passagem, null);
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1", [cvParar.id])).rows[0].n, 0, "P2: nenhuma mensagem fica");
    await receber(A, numeroParar, "oi de novo");
    assert.equal((await conversa(A.e, numeroParar)).nao_contatar, true, "P2: o pedido de não contatar continua valendo");

    // P3 — tarefa em andamento adia a exclusão sem apagar nada.
    const numeroFila = "5561900000833";
    await receber(A, numeroFila, "Quero orçamento");
    const cvFila = await conversa(A.e, numeroFila);
    const fila = await retrato(cvFila.id);
    const outra = await conectarDescartavel({ travar: false });
    try {
      await outra.query("BEGIN");
      await outra.query("SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 FOR UPDATE", [cvFila.id]);
      await assert.rejects(A.privacidade.excluirConversaAPedido(A.gestao, { conversaId: cvFila.id }), /ATENDIMENTO_ENVIO_EM_ANDAMENTO/, "P3: linha travada pelo worker");
      await outra.query("ROLLBACK");
    } finally { await outra.end(); }
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSANDO', iniciada_em = clock_timestamp() WHERE conversa_id = $1 AND estado = 'PENDENTE'", [cvFila.id]);
    const filaProcessando = await retrato(cvFila.id);
    await assert.rejects(A.privacidade.excluirConversaAPedido(A.gestao, { conversaId: cvFila.id }), /ATENDIMENTO_ENVIO_EM_ANDAMENTO/, "P3: PROCESSANDO");
    assert.deepEqual(await retrato(cvFila.id), filaProcessando, "P3: nada apagado");
    assert.notDeepEqual(fila, filaProcessando);
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'PENDENTE' WHERE conversa_id = $1 AND estado = 'PROCESSANDO'", [cvFila.id]);
    const r3 = await A.privacidade.excluirConversaAPedido(A.gestao, { conversaId: cvFila.id });
    assert.ok(r3.estado === "EXCLUIDA" && r3.pendentesCanceladas === 1, "P3: depois, a pendente sai junto (nada mais é enviado)");

    // P4 — retenção.
    const velha = "5561900000834", nova = "5561900000835", velhaB = "5561900000836";
    await receber(A, velha, "mensagem antiga sintética"); await receber(A, nova, "mensagem recente sintética"); await receber(B, velhaB, "mensagem antiga de B");
    for (const [emp, n] of [[A.e, velha], [B.e, velhaB]]) {
      await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSADA' WHERE conversa_id = (SELECT id FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2)", [emp, n]);
      await q("UPDATE whatsapp_atendimento_conversas SET ultima_entrada_em = clock_timestamp() - interval '40 days', atualizada_em = clock_timestamp() - interval '40 days' WHERE empresa_id = $1 AND contato = $2", [emp, n]);
    }
    await q("UPDATE whatsapp_atendimento_conversas SET ultima_entrada_em = clock_timestamp() - interval '40 days', atualizada_em = clock_timestamp() - interval '40 days' WHERE empresa_id = $1 AND contato = $2", [A.e, numeroParar]);
    await q("DELETE FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1", [cvParar.id]);
    for (const env of [{}, { WHATSAPP_ATENDIMENTO_RETENCAO_DIAS: "" }, { WHATSAPP_ATENDIMENTO_RETENCAO_DIAS: "abc" }, { WHATSAPP_ATENDIMENTO_RETENCAO_DIAS: "0" }, { WHATSAPP_ATENDIMENTO_RETENCAO_DIAS: "99999" }]) {
      const r = await A.privacidade.aplicarRetencao({ env: env as unknown as NodeJS.ProcessEnv });
      assert.equal(r.estado, "PRAZO_NAO_DEFINIDO", `P4: ${JSON.stringify(env)}`);
    }
    assert.ok(await conversa(A.e, velha) && await conversa(B.e, velhaB), "P4: sem prazo, nada apagado");
    const r4 = await A.privacidade.aplicarRetencao({ env: { WHATSAPP_ATENDIMENTO_RETENCAO_DIAS: "30" } as unknown as NodeJS.ProcessEnv });
    assert.equal(r4.estado, "APLICADA");
    assert.equal(await conversa(A.e, velha), undefined, "P4: inativa além do prazo excluída");
    assert.equal(await conversa(B.e, velhaB), undefined, "P4: de todas as empresas");
    assert.ok(await conversa(A.e, nova), "P4: recente fica");
    assert.ok(await conversa(A.e, numeroParar), "P4: marca de PARAR já reduzida não é selecionada de novo");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_privacidade WHERE origem = 'RETENCAO' AND prazo_dias = 30")).rows[0].n, 2);

    // P5 — revogação de arquivo.
    const arq = await A.biblioteca.salvarArquivo(A.gestao, { nome: "material-privacidade.pdf", bytes: PDF, tipoEsperado: "DOCUMENTO" });
    const tok = () => q("SELECT token FROM whatsapp_atendimento_arquivos WHERE id = $1", [arq.id]).then((r) => r.rows[0].token as string);
    const token0 = await tok();
    assert.ok(await publico.lerArquivoPublico(arq.id, token0), "P5: servido antes");
    const pronta = (await A.biblioteca.salvarPronta(A.gestao, { titulo: "PDF sintético", categoria: "Teste", tipo: "DOCUMENTO", texto: "Material", link: null, atalho: null, arquivoId: arq.id, estado: "PUBLICADA", envioAutomatico: true, finalidade: "PRECOS" })).id;
    const numeroPdf = "5561900000837";
    await receber(A, numeroPdf, "me manda o material");
    let cvPdf = await conversa(A.e, numeroPdf);
    await A.servico.controlarAtendimento(A.gestao, { acao: "assumir", conversaId: cvPdf.id, versao: Number(cvPdf.versao) });
    cvPdf = await conversa(A.e, numeroPdf);
    const versaoPronta = (await q("SELECT versao FROM whatsapp_atendimento_mensagens_prontas WHERE id = $1", [pronta])).rows[0].versao;
    await A.servico.controlarAtendimento(A.gestao, { acao: "enviar", conversaId: cvPdf.id, versao: Number(cvPdf.versao), prontaMidiaId: pronta, prontaVersao: Number(versaoPronta), texto: "Segue" });
    await assert.rejects(B.privacidade.revogarArquivo(B.gestao, { arquivoId: arq.id }), /ATENDIMENTO_ARQUIVO_NAO_ENCONTRADO/, "P5: outra empresa não revoga");
    await assert.rejects(A.privacidade.revogarArquivo(A.equipe, { arquivoId: arq.id }), /ATENDIMENTO_ACESSO_NEGADO/, "P5: a equipe não revoga");
    const r5 = await A.privacidade.revogarArquivo(A.gestao, { arquivoId: arq.id });
    assert.deepEqual(r5, { prontasArquivadas: 1, saidasCanceladas: 1 });
    const rev = (await q("SELECT octet_length(conteudo) AS n, token, revogado_em IS NOT NULL AS revogado, sha256, tamanho_bytes FROM whatsapp_atendimento_arquivos WHERE id = $1", [arq.id])).rows[0];
    assert.equal(rev.n, 0, "P5: conteúdo apagado"); assert.ok(rev.revogado); assert.notEqual(rev.token, token0, "P5: link trocado");
    assert.equal(await publico.lerArquivoPublico(arq.id, token0), null, "P5: link antigo não serve");
    assert.equal(await publico.lerArquivoPublico(arq.id, rev.token), null, "P5: nem o novo (revogado)");
    assert.equal((await q("SELECT estado FROM whatsapp_atendimento_mensagens_prontas WHERE id = $1", [pronta])).rows[0].estado, "ARQUIVADA");
    assert.equal((await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE midia_arquivo_id = $1", [arq.id])).rows[0].estado, "CANCELADA", "P5: saída na fila cancelada");
    await A.worker.processarLote(deps, { maxTarefas: 10 });
    const documentos = () => envios.filter((e) => e.tipo === "DOCUMENTO").length;
    assert.equal(documentos(), 0, "P5: nada do arquivo revogado sai");
    await assert.rejects(q("UPDATE whatsapp_atendimento_arquivos SET conteudo = $2, revogado_em = NULL, revogado_por = NULL WHERE id = $1", [arq.id, PDF]), /revogado: não muda mais/, "P5: gatilho recusa restaurar");
    await assert.rejects(q("DELETE FROM whatsapp_atendimento_arquivos WHERE id = $1", [arq.id]), /não é apagado/, "P5: gatilho recusa apagar");
    await assert.rejects(A.privacidade.revogarArquivo(A.gestao, { arquivoId: arq.id }), /ATENDIMENTO_ARQUIVO_NAO_ENCONTRADO/, "P5: revogar de novo");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_privacidade WHERE arquivo_id = $1 AND acao = 'ARQUIVO_REVOGADO'", [arq.id])).rows[0].n, 1);

    // P6 — troca de link.
    const arq2 = await A.biblioteca.salvarArquivo(A.gestao, { nome: "material-dois.pdf", bytes: PDF, tipoEsperado: "DOCUMENTO" });
    const t2 = (await q("SELECT token FROM whatsapp_atendimento_arquivos WHERE id = $1", [arq2.id])).rows[0].token as string;
    await assert.rejects(q("UPDATE whatsapp_atendimento_arquivos SET token = $2 WHERE id = $1", [arq2.id, randomBytes(32).toString("base64url")]), /registra token_trocado_em/, "P6: troca de link sem registro recusada pelo banco");
    await assert.rejects(q("UPDATE whatsapp_atendimento_arquivos SET conteudo = $2 WHERE id = $1", [arq2.id, Buffer.from("%PDF-1.4\n%%EOF\n")]), /conteúdo não muda/, "P6: conteúdo não muda sem revogar");
    await A.privacidade.trocarLinkArquivo(A.gestao, { arquivoId: arq2.id });
    const t2b = (await q("SELECT token FROM whatsapp_atendimento_arquivos WHERE id = $1", [arq2.id])).rows[0].token as string;
    assert.equal(await publico.lerArquivoPublico(arq2.id, t2), null, "P6: link antigo não serve");
    assert.ok(await publico.lerArquivoPublico(arq2.id, t2b), "P6: link novo serve");

    // P7 — expiração (vencido: nem servido nem enviado pelo worker).
    const criado = (await q("SELECT criado_em FROM whatsapp_atendimento_arquivos WHERE id = $1", [arq2.id])).rows[0].criado_em as Date;
    await A.privacidade.definirExpiracaoArquivo(A.gestao, { arquivoId: arq2.id, expiraEm: new Date(criado.getTime() + 1).toISOString() });
    assert.equal(await publico.lerArquivoPublico(arq2.id, t2b), null, "P7: vencido não é servido");
    const pronta2 = (await A.biblioteca.salvarPronta(A.gestao, { titulo: "PDF dois", categoria: "Teste", tipo: "DOCUMENTO", texto: "Material dois", link: null, atalho: null, arquivoId: arq2.id, estado: "PUBLICADA", envioAutomatico: false, finalidade: "PRECOS" })).id;
    const numeroExp = "5561900000838";
    await receber(A, numeroExp, "me manda o material dois");
    let cvExp = await conversa(A.e, numeroExp);
    await A.servico.controlarAtendimento(A.gestao, { acao: "assumir", conversaId: cvExp.id, versao: Number(cvExp.versao) });
    cvExp = await conversa(A.e, numeroExp);
    const v2 = (await q("SELECT versao FROM whatsapp_atendimento_mensagens_prontas WHERE id = $1", [pronta2])).rows[0].versao;
    await A.servico.controlarAtendimento(A.gestao, { acao: "enviar", conversaId: cvExp.id, versao: Number(cvExp.versao), prontaMidiaId: pronta2, prontaVersao: Number(v2), texto: "Segue o dois" });
    await A.worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(documentos(), 0, "P7: arquivo vencido não sai");
    assert.equal((await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE midia_arquivo_id = $1", [arq2.id])).rows[0].estado, "CANCELADA", "P7: saída cancelada no envio");
    await A.privacidade.definirExpiracaoArquivo(A.gestao, { arquivoId: arq2.id, expiraEm: null });
    assert.ok(await publico.lerArquivoPublico(arq2.id, t2b), "P7: sem expiração volta a servir");

    // P8 — empresa suspensa: o arquivo não é servido.
    const C = await empresa("C");
    const arq3 = await C.biblioteca.salvarArquivo(C.gestao, { nome: "material-tres.pdf", bytes: PDF, tipoEsperado: "DOCUMENTO" });
    const t3 = (await q("SELECT token FROM whatsapp_atendimento_arquivos WHERE id = $1", [arq3.id])).rows[0].token as string;
    assert.ok(await publico.lerArquivoPublico(arq3.id, t3), "P8: servido com a empresa ativa");
    await q("UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1", [C.e]);
    assert.equal(await publico.lerArquivoPublico(arq3.id, t3), null, "P8: empresa suspensa não serve arquivo");
  } finally {
    await c.end();
  }
});
