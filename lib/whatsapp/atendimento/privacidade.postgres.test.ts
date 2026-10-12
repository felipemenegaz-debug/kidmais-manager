import test from "node:test";
import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarComponente } from "../../../components/admin/teste-componente.ts";
import type { DbExecutor } from "../../db/contracts.ts";
import * as arquivos from "./arquivos.ts";
import { carregarAtendimento, cod, db } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";
import { fontesPostgres } from "./walle/fontes-postgres.ts";

/**
 * Privacidade (D2 e D3) depois da revisão de 8b2c55d (12/10/2026), no schema integrado (modelo "082"), com o serviço, o
 * worker, a privacidade e a rota pública REAIS e dados sintéticos; transporte simulado, nenhuma rede.
 *
 *  P1 exclusão a pedido: só a Gestão, com senha confirmada há ≤ 5 min, da empresa ATIVA da sessão; tudo da conversa sai
 *     (mensagens, status, nome de perfil, memória, passagem); auditoria sem o vínculo; registro sem contato nem texto; a
 *     conversa de outra empresa com o mesmo número fica idêntica;
 *  P2 controles mínimos: PARAR, pausa e conversa com a equipe sobrevivem à exclusão SEPARADOS do conteúdo; a conversa
 *     nova do número os herda (PARAR encerrada; pausa e equipe aguardando a equipe, entrada sem automação; "Devolver ao
 *     Wall-e" recusado com a pausa) e a linha de controle é consumida; contato comum volta como contato novo;
 *  P3 reentrega do provedor de um evento excluído não recria nada (escopo: empresa + provedor + hash do id); evento novo
 *     grava; o mesmo id em outra empresa não é afetado;
 *  P4 tarefa em processamento, ou linha travada pelo worker, adia (EXCLUSAO_ADIADA) sem apagar nada;
 *  P5 retenção: sem prazo, nada; prazo por empresa (configurado pela Gestão); só a empresa com prazo; entrada pendente
 *     antiga sai contada; tarefa em processamento adia contada; falha de UMA conversa é registrada e as demais seguem;
 *     ids de deduplicação vencidos apagados; registro da execução;
 *  P6 empresa que NÃO é a piloto (B) exclui, revoga e configura a retenção dos próprios dados;
 *  P7 arquivos: troca de link, expiração "agora" (acesso e fila invalidados, motivo visível), data inválida, arquivo
 *     vencido só volta com reativação explícita e link novo (o banco recusa o atalho), revogação (conteúdo apagado, link
 *     trocado, pronta arquivada; o banco recusa desfazer), cache no-store, empresa suspensa;
 *  P8 envio manual com arquivo indisponível: recusado na hora (ATENDIMENTO_ARQUIVO_INDISPONIVEL);
 *  P9 resposta do Wall-e em grupo (texto "segue o PDF" + PDF) com o PDF vencido: nada do grupo sai, motivo nas duas, a
 *     memória de envio perde o PDF e a conversa vai para a equipe; a escolha do Wall-e já não oferece a pronta;
 *  P10 down da 082 com registro de privacidade, controles, eventos, retenção e arquivo revogado: recusa sem a decisão;
 *     com ela, remove tudo e devolve o schema da 081.
 */
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const PDF = Buffer.from("%PDF-1.4\n% material sintético da privacidade\n%%EOF\n");
const publico = carregarComponente("lib/whatsapp/atendimento/arquivos-publico.ts", {
  "node:crypto": nodeCrypto, "../../db/postgres.ts": { db }, "./configuracao.ts": { ambienteAtendimento: () => "staging" }, "./arquivos.ts": arquivos,
}).modulo as typeof import("./arquivos-publico.ts");
const comDecisao = (sql: string, chave: string) => sql.replace("SET LOCAL statement_timeout = '60s';", `SET LOCAL statement_timeout = '60s';\nSET LOCAL ${chave} = 'sim';`);

test("privacidade: exclusão, controles mínimos, reentrega, retenção, empresa não piloto, arquivos, envio e rollback da 082", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  try {
    assert.ok((await q("SELECT to_regclass('public.whatsapp_atendimento_controles_contato') IS NOT NULL AS e")).rows[0].e, "modelo com a 082 de 12/10");
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    async function empresa(rotulo: string) {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("pv"), `Empresa sintética ${rotulo} (privacidade)`]);
      await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      const sessao = async (papel: string) => {
        const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness privacidade', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, papel]);
        const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [e, u, papel]);
        await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
        const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
          VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), e]);
        return { usuario_id: u, papel, id: s, empresa_ativa_id: e, autenticado_em: new Date().toISOString() };
      };
      const gestao = await sessao("REPRESENTANTE_AUTORIZADO");
      const equipe = await sessao("ADMINISTRATIVO");
      const h = carregarAtendimento(e);
      await h.servico.salvarConfiguracao(gestao as never, { ativo: true, nome: `Empresa sintética ${rotulo}`, perguntas: [] });
      return { e, gestao, equipe, ...h };
    }
    const A = await empresa("A"), B = await empresa("B");
    const conversa = async (emp: string, contato: string) => (await q("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [emp, contato])).rows[0];
    const receber = (h: typeof A, contato: string, texto: string, evento = cod("evt-"), nome: string | null = null) =>
      h.servico.receberEntrada({ id: evento, app: "KidmaisManager", source: contato, texto, timestamp: Date.now() - 1000, nomePerfil: nome });
    const retrato = async (conv: string) => (await q(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*)::int AS n FROM (
      SELECT c::text AS x FROM whatsapp_atendimento_conversas c WHERE c.id = $1 UNION ALL SELECT m::text FROM whatsapp_atendimento_mensagens m WHERE m.conversa_id = $1) s`, [conv])).rows[0];
    const envios: ConteudoSaida[] = [];
    const deps = { interpretar: async () => { throw new Error("sem modelo"); }, enviar: async (_c: string, conteudo: ConteudoSaida) => { envios.push(conteudo); return cod("gs-"); } };

    // P1 — exclusão a pedido.
    const numero = "5561900000841";
    await receber(A, numero, "Olá, meu cpf é 123.456.789-09", cod("evt-"), "Perfil sintético A");
    await receber(B, numero, "Olá da outra empresa", cod("evt-"), "Perfil sintético B");
    let cvA = await conversa(A.e, numero);
    const cvB = await conversa(B.e, numero);
    await A.servico.controlarAtendimento(A.gestao as never, { acao: "assumir", conversaId: cvA.id, versao: Number(cvA.versao) });
    cvA = await conversa(A.e, numero);
    await A.servico.controlarAtendimento(A.gestao as never, { acao: "enviar", conversaId: cvA.id, versao: Number(cvA.versao), texto: "Resposta sintética" });
    await A.worker.processarLote(deps, { maxTarefas: 10 });
    const provedor = (await q("SELECT provedor_id FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 AND provedor_id IS NOT NULL", [cvA.id])).rows[0].provedor_id as string;
    await q("INSERT INTO whatsapp_atendimento_status (empresa_id, ambiente, provedor_id, estado) VALUES ($1, 'staging', $2, 'ENTREGUE') ON CONFLICT DO NOTHING", [A.e, provedor]);
    await q(`UPDATE whatsapp_atendimento_conversas SET contexto = '{"tema":"Tema sintético"}'::jsonb, passagem = '{"motivo":"HUMANO","ultimaMensagem":"texto sintético"}'::jsonb WHERE id = $1`, [cvA.id]);
    const bAntes = await retrato(cvB.id);
    await assert.rejects(B.privacidade.excluirConversaAPedido(B.gestao, { conversaId: cvA.id, motivo: "PEDIDO_DO_TITULAR" }), /ATENDIMENTO_NAO_ENCONTRADO/, "P1: outra empresa não alcança a conversa");
    await assert.rejects(A.privacidade.excluirConversaAPedido(A.equipe, { conversaId: cvA.id, motivo: "PEDIDO_DO_TITULAR" }), /ATENDIMENTO_ACESSO_NEGADO/, "P1: a equipe não exclui");
    await assert.rejects(A.privacidade.excluirConversaAPedido({ ...A.gestao, autenticado_em: new Date(Date.now() - 10 * 60_000).toISOString() }, { conversaId: cvA.id, motivo: "PEDIDO_DO_TITULAR" }), /ATENDIMENTO_REAUTENTICACAO/, "P1: senha não confirmada há pouco");
    assert.ok(await conversa(A.e, numero), "P1: recusas não apagam nada");
    const r1 = await A.privacidade.excluirConversaAPedido(A.gestao, { conversaId: cvA.id, motivo: "PEDIDO_DO_TITULAR" });
    assert.ok(r1.estado === "EXCLUIDA" && r1.mensagens >= 2 && r1.controles.equipe, "P1: excluída; estava com a equipe (assumida)");
    assert.equal(await conversa(A.e, numero), undefined, "P1: conversa apagada");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1", [cvA.id])).rows[0].n, 0, "P1: mensagens apagadas");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_status WHERE provedor_id = $1", [provedor])).rows[0].n, 0, "P1: status apagado");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_auditoria WHERE conversa_id = $1", [cvA.id])).rows[0].n, 0, "P1: auditoria sem o vínculo");
    const reg = (await q("SELECT * FROM whatsapp_atendimento_privacidade WHERE conversa_id = $1", [cvA.id])).rows;
    assert.equal(reg.length, 1); assert.equal(reg[0].motivo, "PEDIDO_DO_TITULAR"); assert.equal(reg[0].manteve_equipe, true);
    assert.ok(!JSON.stringify(reg[0]).includes(numero) && !JSON.stringify(reg[0]).includes("123.456"), "P1: registro sem contato nem texto");
    const controleA = (await q("SELECT * FROM whatsapp_atendimento_controles_contato WHERE empresa_id = $1 AND contato = $2", [A.e, numero])).rows[0];
    assert.deepEqual([controleA.nao_contatar, controleA.sem_automatico, controleA.com_equipe], [false, false, true], "P1: só o controle mínimo (equipe)");
    assert.equal(Object.keys(controleA).sort().join(","), "ambiente,atualizado_em,com_equipe,contato,empresa_id,nao_contatar,registrado_em,sem_automatico", "P1: nenhum conteúdo no controle");
    assert.deepEqual(await retrato(cvB.id), bAntes, "P1: a conversa da outra empresa (mesmo número) fica idêntica");

    // P2 — controles herdados pela conversa nova (equipe) e os demais.
    await receber(A, numero, "oi de novo");
    const nova = await conversa(A.e, numero);
    assert.equal(nova.estado, "AGUARDANDO_HUMANO", "P2: conversa com a equipe não volta ao bot");
    assert.equal((await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1", [nova.id])).rows[0].estado, "PROCESSADA", "P2: sem automação");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_controles_contato WHERE empresa_id = $1 AND contato = $2", [A.e, numero])).rows[0].n, 0, "P2: controle consumido");
    const numParar = "5561900000842", numPausa = "5561900000843", numComum = "5561900000844";
    for (const n of [numParar, numPausa, numComum]) await receber(A, n, "Quero saber o preço");
    await q("UPDATE whatsapp_atendimento_conversas SET nao_contatar = true, estado = 'ENCERRADA' WHERE empresa_id = $1 AND contato = $2", [A.e, numParar]);
    await q(`UPDATE whatsapp_atendimento_conversas SET contexto = contexto || '{"semAutomatico":{"motivo":"PARAR_A_CONFIRMAR","origem":"RECEPCAO"}}'::jsonb, estado = 'IA' WHERE empresa_id = $1 AND contato = $2`, [A.e, numPausa]);
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSADA' WHERE empresa_id = $1 AND estado = 'PENDENTE'", [A.e]);
    for (const n of [numParar, numPausa, numComum]) {
      const cv = await conversa(A.e, n);
      assert.equal((await A.privacidade.excluirConversaAPedido(A.gestao, { conversaId: cv.id, motivo: "DECISAO_DA_EMPRESA" })).estado, "EXCLUIDA");
    }
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_controles_contato WHERE empresa_id = $1 AND contato = $2", [A.e, numComum])).rows[0].n, 0, "P2: contato comum não deixa controle");
    for (const n of [numParar, numPausa, numComum]) await receber(A, n, "oi, voltei");
    const parar = await conversa(A.e, numParar), pausa = await conversa(A.e, numPausa), comum = await conversa(A.e, numComum);
    assert.equal(parar.nao_contatar, true); assert.equal(parar.estado, "ENCERRADA", "P2: PARAR continua valendo");
    assert.equal(pausa.estado, "AGUARDANDO_HUMANO"); assert.equal(pausa.contexto.semAutomatico.origem, "EXCLUSAO", "P2: pausa herdada");
    for (const cv of [parar, pausa]) assert.equal((await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1", [cv.id])).rows[0].estado, "PROCESSADA", "P2: nada automático");
    await A.servico.controlarAtendimento(A.gestao as never, { acao: "assumir", conversaId: pausa.id, versao: Number(pausa.versao) });
    const pausaAssumida = await conversa(A.e, numPausa);
    await assert.rejects(A.servico.controlarAtendimento(A.gestao as never, { acao: "retomar", conversaId: pausaAssumida.id, versao: Number(pausaAssumida.versao) }), /ATENDIMENTO_PAUSA_PEDIDA/, "P2: Devolver ao Wall-e recusado");
    assert.equal(comum.estado, "IA", "P2: contato comum volta como contato novo");

    // P3 — reentrega de evento excluído.
    const numRe = "5561900000845", evento = cod("evt-re-");
    await receber(A, numRe, "mensagem sintética para excluir", evento, "Perfil reentrega");
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSADA' WHERE empresa_id = $1 AND estado = 'PENDENTE'", [A.e]);
    await A.privacidade.excluirConversaAPedido(A.gestao, { conversaId: (await conversa(A.e, numRe)).id, motivo: "PEDIDO_DO_TITULAR" });
    await receber(A, numRe, "mensagem sintética para excluir", evento, "Perfil reentrega");
    assert.equal(await conversa(A.e, numRe), undefined, "P3: reentrega não recria a conversa nem o texto");
    assert.equal((await q("SELECT count(*)::int AS n FROM whatsapp_atendimento_eventos_excluidos WHERE empresa_id = $1 AND evento_sha256 = encode(sha256(convert_to($2,'UTF8')),'hex')", [A.e, evento])).rows[0].n, 1, "P3: só o hash");
    await receber(B, numRe, "mesmo id em outra empresa", evento);
    assert.ok(await conversa(B.e, numRe), "P3: o hash é por empresa");
    await receber(A, numRe, "mensagem nova de verdade");
    assert.ok(await conversa(A.e, numRe), "P3: evento novo grava");

    // P4 — adiamento.
    const numFila = "5561900000846";
    await receber(A, numFila, "Quero orçamento");
    const cvFila = await conversa(A.e, numFila);
    const outra = await conectarDescartavel({ travar: false });
    try {
      await outra.query("BEGIN");
      await outra.query("SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1 FOR UPDATE", [cvFila.id]);
      await assert.rejects(A.privacidade.excluirConversaAPedido(A.gestao, { conversaId: cvFila.id, motivo: "PEDIDO_DO_TITULAR" }), /ATENDIMENTO_EXCLUSAO_ADIADA/, "P4: linha do worker");
      await outra.query("ROLLBACK");
    } finally { await outra.end(); }
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSANDO', iniciada_em = clock_timestamp() WHERE conversa_id = $1", [cvFila.id]);
    const antesFila = await retrato(cvFila.id);
    await assert.rejects(A.privacidade.excluirConversaAPedido(A.gestao, { conversaId: cvFila.id, motivo: "PEDIDO_DO_TITULAR" }), /ATENDIMENTO_EXCLUSAO_ADIADA/, "P4: PROCESSANDO");
    assert.deepEqual(await retrato(cvFila.id), antesFila, "P4: nada apagado");

    // P5 — retenção.
    const envelhecer = (emp: string, n: string) => q("UPDATE whatsapp_atendimento_conversas SET ultima_entrada_em = clock_timestamp() - interval '40 days', atualizada_em = clock_timestamp() - interval '40 days' WHERE empresa_id = $1 AND contato = $2", [emp, n]);
    const [velhaA, velhaPend, velhaFalha, recenteA, velhaB] = ["5561900000851", "5561900000852", "5561900000853", "5561900000854", "5561900000855"];
    for (const n of [velhaA, velhaPend, velhaFalha, recenteA]) await receber(A, n, "mensagem sintética");
    await receber(B, velhaB, "mensagem sintética de B");
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSADA' WHERE estado = 'PENDENTE' AND conversa_id IN (SELECT id FROM whatsapp_atendimento_conversas WHERE contato = ANY($1))", [[velhaA, velhaFalha, recenteA, velhaB]]);
    for (const [emp, n] of [[A.e, velhaA], [A.e, velhaPend], [A.e, velhaFalha], [B.e, velhaB], [A.e, numFila]] as const) await envelhecer(emp, n);
    await q("INSERT INTO whatsapp_atendimento_eventos_excluidos (empresa_id, ambiente, provedor, evento_sha256, excluido_em) VALUES ($1, 'staging', 'GUPSHUP', $2, clock_timestamp() - interval '40 days')", [A.e, "a".repeat(64)]);
    const semPrazo = await A.privacidade.executarRetencao();
    assert.ok(semPrazo.estado === "CONCLUIDA" && semPrazo.empresas === 0 && semPrazo.excluidas === 0, "P5: sem prazo, nada apagado");
    assert.equal(semPrazo.dedup, 1, "P5: ids de deduplicação vencidos saem mesmo sem prazo de conteúdo (prazo técnico próprio)");
    assert.ok(await conversa(A.e, velhaA), "P5: sem prazo, a conversa antiga fica");
    await assert.rejects(A.privacidade.configurarRetencao(A.gestao, { prazoDias: 0 }), /ATENDIMENTO_PRAZO_INVALIDO/);
    await assert.rejects(A.privacidade.configurarRetencao(A.equipe, { prazoDias: 30 }), /ATENDIMENTO_ACESSO_NEGADO/);
    await A.privacidade.configurarRetencao(A.gestao, { prazoDias: 30 });
    const falhaId = (await conversa(A.e, velhaFalha)).id;
    await q(`CREATE FUNCTION teste_falha_retencao() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.conversa_id = '${falhaId}'::uuid THEN RAISE EXCEPTION 'falha sintética de uma conversa'; END IF; RETURN NEW; END $$`);
    await q("CREATE TRIGGER teste_falha_retencao BEFORE INSERT ON whatsapp_atendimento_privacidade FOR EACH ROW EXECUTE FUNCTION teste_falha_retencao()");
    const r5 = await A.privacidade.executarRetencao();
    await q("DROP TRIGGER teste_falha_retencao ON whatsapp_atendimento_privacidade"); await q("DROP FUNCTION teste_falha_retencao()");
    assert.ok(r5.estado === "CONCLUIDA_COM_FALHAS" && r5.empresas === 1 && r5.excluidas === 2 && r5.adiadas === 1 && r5.falhas === 1 && r5.pendentes === 1 && r5.dedup === 0, `P5: contagens ${JSON.stringify(r5)}`);
    assert.ok(r5.estado === "CONCLUIDA_COM_FALHAS" && r5.erros.includes("SQLSTATE_P0001"), "P5: erro observável (só o código)");
    assert.equal(await conversa(A.e, velhaA), undefined, "P5: inativa além do prazo excluída");
    assert.equal(await conversa(A.e, velhaPend), undefined, "P5: com entrada pendente antiga, excluída e contada");
    assert.ok(await conversa(A.e, velhaFalha), "P5: a que falhou fica (transação própria)");
    assert.ok(await conversa(A.e, numFila), "P5: em processamento, adiada");
    assert.ok(await conversa(A.e, recenteA), "P5: recente fica");
    assert.ok(await conversa(B.e, velhaB), "P5: empresa sem prazo não é tocada");
    const execucao = (await q("SELECT * FROM whatsapp_atendimento_retencao_execucoes ORDER BY iniciada_em DESC LIMIT 1")).rows[0];
    assert.equal(execucao.estado, "CONCLUIDA_COM_FALHAS"); assert.ok(execucao.terminada_em); assert.deepEqual(execucao.erros, ["SQLSTATE_P0001"]);
    // Só o código (comentários fora): o comentário da rotina cita as chaves justamente para dizer que não as consulta.
    const fonte = readFileSync("lib/whatsapp/atendimento/privacidade.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(fonte, /atendimentoAtivo|inteligenciaAtiva|INTELIGENCIA/, "P5: a retenção não consulta as chaves do canal nem da IA");

    // P6 — empresa que não é a piloto (B: o harness de A tem A como piloto) exerce as ações sobre os próprios dados.
    const cvB2 = await conversa(B.e, numero);
    assert.equal((await A.privacidade.excluirConversaAPedido(B.gestao, { conversaId: cvB2.id, motivo: "PEDIDO_DO_TITULAR" })).estado, "EXCLUIDA", "P6: B exclui fora da piloto");
    await A.privacidade.configurarRetencao(B.gestao, { prazoDias: 90 });
    assert.equal((await A.privacidade.situacaoPrivacidade(B.gestao)).retencao.prazoDias, 90, "P6: situação da empresa ativa, não da piloto");

    // P7 — arquivos.
    const arq = await A.biblioteca.salvarArquivo(A.gestao as never, { nome: "material-privacidade.pdf", bytes: PDF, tipoEsperado: "DOCUMENTO" });
    const token = () => q("SELECT token FROM whatsapp_atendimento_arquivos WHERE id = $1", [arq.id]).then((r) => r.rows[0].token as string);
    const t0 = await token();
    const servido = await publico.lerArquivoPublico(arq.id, t0);
    assert.ok(servido, "P7: servido");
    assert.equal(publico.respostaArquivo(servido, null, false).headers.get("Cache-Control"), "no-store, max-age=0", "P7: sem cache (revogação vale na hora)");
    await A.privacidade.trocarLinkArquivo(A.gestao, { arquivoId: arq.id });
    const t1 = await token();
    assert.equal(await publico.lerArquivoPublico(arq.id, t0), null, "P7: link antigo morto"); assert.ok(await publico.lerArquivoPublico(arq.id, t1));
    await assert.rejects(A.privacidade.definirExpiracaoArquivo(A.gestao, { arquivoId: arq.id, expiraEm: new Date(Date.now() - 3600_000).toISOString() }), /ATENDIMENTO_DATA_INVALIDA/, "P7: data passada");
    await assert.rejects(A.privacidade.definirExpiracaoArquivo(A.gestao, { arquivoId: arq.id, expiraEm: "não é data" }), /ATENDIMENTO_DATA_INVALIDA/, "P7: data inválida");
    const pronta = (await A.biblioteca.salvarPronta(A.gestao as never, { titulo: "PDF sintético", categoria: "Teste", tipo: "DOCUMENTO", texto: "Segue o PDF", link: null, atalho: null, arquivoId: arq.id, estado: "PUBLICADA", envioAutomatico: true, finalidade: "PRECOS" })).id;
    const numArq = "5561900000861";
    await receber(A, numArq, "me manda o material");
    let cvArq = await conversa(A.e, numArq);
    await A.servico.controlarAtendimento(A.gestao as never, { acao: "assumir", conversaId: cvArq.id, versao: Number(cvArq.versao) });
    cvArq = await conversa(A.e, numArq);
    const versaoPronta = Number((await q("SELECT versao FROM whatsapp_atendimento_mensagens_prontas WHERE id = $1", [pronta])).rows[0].versao);
    await A.servico.controlarAtendimento(A.gestao as never, { acao: "enviar", conversaId: cvArq.id, versao: Number(cvArq.versao), prontaMidiaId: pronta, prontaVersao: versaoPronta, texto: "Segue" });
    const exp = await A.privacidade.definirExpiracaoArquivo(A.gestao, { arquivoId: arq.id, expiraEm: "agora" });
    assert.equal(exp.saidasCanceladas, 1, "P7: expirar agora cancela a fila");
    assert.equal((await q("SELECT motivo_cancelamento FROM whatsapp_atendimento_mensagens WHERE midia_arquivo_id = $1", [arq.id])).rows[0].motivo_cancelamento, "ARQUIVO_INDISPONIVEL", "P7: motivo visível");
    assert.equal(await publico.lerArquivoPublico(arq.id, t1), null, "P7: vencido não é servido");
    await assert.rejects(A.privacidade.definirExpiracaoArquivo(A.gestao, { arquivoId: arq.id, expiraEm: new Date(Date.now() + 86400_000).toISOString() }), /ATENDIMENTO_ARQUIVO_VENCIDO/, "P7: vencido não muda pela expiração");
    await assert.rejects(q("UPDATE whatsapp_atendimento_arquivos SET expira_em = NULL WHERE id = $1", [arq.id]), /reativar um arquivo vencido exige link novo/, "P7: o banco recusa reativar sem link novo");
    await A.privacidade.reativarArquivo(A.gestao, { arquivoId: arq.id, expiraEm: null });
    const t2 = await token();
    assert.notEqual(t2, t1); assert.equal(await publico.lerArquivoPublico(arq.id, t1), null, "P7: o link anterior nunca volta"); assert.ok(await publico.lerArquivoPublico(arq.id, t2), "P7: reativado com link novo");
    await assert.rejects(A.privacidade.reativarArquivo(A.gestao, { arquivoId: arq.id, expiraEm: null }), /ATENDIMENTO_ARQUIVO_NAO_VENCIDO/);
    await assert.rejects(B.privacidade.revogarArquivo(B.gestao, { arquivoId: arq.id }), /ATENDIMENTO_ARQUIVO_NAO_ENCONTRADO/, "P7: outra empresa não revoga");
    const r7 = await A.privacidade.revogarArquivo(A.gestao, { arquivoId: arq.id });
    assert.equal(r7.prontasArquivadas, 1);
    const rev = (await q("SELECT octet_length(conteudo) AS n, token, revogado_em IS NOT NULL AS revogado FROM whatsapp_atendimento_arquivos WHERE id = $1", [arq.id])).rows[0];
    assert.equal(rev.n, 0); assert.ok(rev.revogado); assert.notEqual(rev.token, t2);
    assert.equal(await publico.lerArquivoPublico(arq.id, t2), null);
    await assert.rejects(q("UPDATE whatsapp_atendimento_arquivos SET conteudo = $2, revogado_em = NULL, revogado_por = NULL WHERE id = $1", [arq.id, PDF]), /revogado: não muda mais/, "P7: o banco recusa desfazer pela aplicação");
    await assert.rejects(q("DELETE FROM whatsapp_atendimento_arquivos WHERE id = $1", [arq.id]), /não é apagado/);
    const arqB = await B.biblioteca.salvarArquivo(B.gestao as never, { nome: "material-b.pdf", bytes: PDF, tipoEsperado: "DOCUMENTO" });
    assert.equal((await A.privacidade.revogarArquivo(B.gestao, { arquivoId: arqB.id })).prontasArquivadas, 0, "P6/P7: B revoga o próprio arquivo fora da piloto");
    const C = await empresa("C");
    const arqC = await C.biblioteca.salvarArquivo(C.gestao as never, { nome: "material-c.pdf", bytes: PDF, tipoEsperado: "DOCUMENTO" });
    const tC = (await q("SELECT token FROM whatsapp_atendimento_arquivos WHERE id = $1", [arqC.id])).rows[0].token as string;
    await q("UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1", [C.e]);
    assert.equal(await publico.lerArquivoPublico(arqC.id, tC), null, "P7: empresa suspensa não serve arquivo");

    // P8 — envio manual com arquivo indisponível: recusado na hora.
    const arq8 = await A.biblioteca.salvarArquivo(A.gestao as never, { nome: "material-oito.pdf", bytes: PDF, tipoEsperado: "DOCUMENTO" });
    const pronta8 = (await A.biblioteca.salvarPronta(A.gestao as never, { titulo: "PDF oito", categoria: "Teste", tipo: "DOCUMENTO", texto: "Material oito", link: null, atalho: null, arquivoId: arq8.id, estado: "PUBLICADA", envioAutomatico: true, finalidade: "PACOTES" })).id;
    await A.privacidade.definirExpiracaoArquivo(A.gestao, { arquivoId: arq8.id, expiraEm: "agora" });
    cvArq = await conversa(A.e, numArq);
    const v8 = Number((await q("SELECT versao FROM whatsapp_atendimento_mensagens_prontas WHERE id = $1", [pronta8])).rows[0].versao);
    await assert.rejects(A.servico.controlarAtendimento(A.gestao as never, { acao: "enviar", conversaId: cvArq.id, versao: Number(cvArq.versao), prontaMidiaId: pronta8, prontaVersao: v8, texto: "Segue" }), /ATENDIMENTO_ARQUIVO_INDISPONIVEL/, "P8");

    // P9 — grupo do Wall-e com o PDF vencido: nada do grupo sai; escolha do Wall-e não oferece a pronta.
    const numG = "5561900000871";
    await receber(A, numG, "quero a tabela");
    const cvG = await conversa(A.e, numG);
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSADA' WHERE conversa_id = $1", [cvG.id]);
    // Fila de A limpa das cenas anteriores (entradas viram histórico; saídas pendentes canceladas): só o grupo concorre.
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = CASE WHEN direcao = 'ENTRADA' THEN 'PROCESSADA' ELSE 'CANCELADA' END WHERE empresa_id = $1 AND estado = 'PENDENTE'", [A.e]);
    const entrada = (await q("SELECT id FROM whatsapp_atendimento_mensagens WHERE conversa_id = $1", [cvG.id])).rows[0].id as string;
    await q(`UPDATE whatsapp_atendimento_conversas SET estado = 'IA', contexto = jsonb_build_object('enviados', jsonb_build_array(jsonb_build_object('prontaId', $2::text, 'versao', $3::int, 'finalidade', 'PACOTES', 'em', now()::text))) WHERE id = $1`, [cvG.id, pronta8, v8]);
    const versaoG = Number((await conversa(A.e, numG)).versao);
    const fonteW = JSON.stringify({ tipo: "WALLE", fontes: [{ tipo: "PRONTA", id: pronta8, versao: v8 }] });
    await q(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, origem_id, origem_grupo_id, ordem, direcao, texto, estado, versao_conversa, fonte)
      VALUES ($1, $2, 'staging', $3, $3, 0, 'SAIDA', 'Segue o PDF com os pacotes.', 'PENDENTE', $4, $5::jsonb)`, [cvG.id, A.e, entrada, versaoG, fonteW]);
    await q(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, origem_grupo_id, ordem, direcao, texto, estado, versao_conversa, midia_tipo, midia_arquivo_id, midia_nome, midia_pronta_id, midia_pronta_versao, fonte, criada_em)
      VALUES ($1, $2, 'staging', $3, 1, 'SAIDA', 'Material oito', 'PENDENTE', $4, 'DOCUMENTO', $5, 'material-oito.pdf', $6, $7, $8::jsonb, clock_timestamp() + interval '1 millisecond')`, [cvG.id, A.e, entrada, versaoG, arq8.id, pronta8, v8, fonteW]);
    const antes9 = envios.length;
    await A.worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(envios.length, antes9, "P9: nem o \"segue o PDF\" nem o PDF saem");
    const grupo = (await q("SELECT estado, motivo_cancelamento FROM whatsapp_atendimento_mensagens WHERE origem_grupo_id = $1 ORDER BY ordem", [entrada])).rows;
    assert.deepEqual(grupo, [{ estado: "CANCELADA", motivo_cancelamento: "ARQUIVO_INDISPONIVEL" }, { estado: "CANCELADA", motivo_cancelamento: "ARQUIVO_INDISPONIVEL" }], "P9: motivo nas duas");
    const depoisG = await conversa(A.e, numG);
    assert.equal(depoisG.estado, "AGUARDANDO_HUMANO", "P9: equipe chamada"); assert.deepEqual(depoisG.contexto.enviados, [], "P9: memória de envio sem o PDF");
    const escolha = await fontesPostgres(db() as unknown as DbExecutor, { empresaId: A.e, ambiente: "staging", hoje: "2026-10-12", linkContratoProprio: async () => null }).prontasAutorizadas("PACOTES");
    assert.ok(!escolha.some((p) => p.id === pronta8), "P9: o Wall-e não escolhe pronta com arquivo indisponível");

    // P10 — down da 082 com dados de privacidade e arquivo revogado.
    const down = readFileSync("database/rollback/20261011_082_wall_e_atendimento_down.sql", "utf8");
    await q("UPDATE whatsapp_atendimento_mensagens SET estado = 'CANCELADA' WHERE estado IN ('PENDENTE','PROCESSANDO','ENVIANDO')");
    await assert.rejects(q(down), /registro de privacidade/, "P10: sem a decisão, recusa");
    await q("ROLLBACK").catch(() => {});
    for (const tb of ["whatsapp_atendimento_privacidade", "whatsapp_atendimento_eventos_excluidos", "whatsapp_atendimento_retencao_config", "whatsapp_atendimento_retencao_execucoes"])
      assert.ok((await q(`SELECT count(*)::int AS n FROM ${tb}`)).rows[0].n > 0, `P10: ${tb} com dados antes do down`);
    await q(comDecisao(down, "kidmais.rollback_082_descartar"));
    for (const tb of ["whatsapp_atendimento_privacidade", "whatsapp_atendimento_controles_contato", "whatsapp_atendimento_eventos_excluidos", "whatsapp_atendimento_retencao_config", "whatsapp_atendimento_retencao_execucoes", "whatsapp_atendimento_arquivos"])
      assert.equal((await q("SELECT to_regclass($1) IS NULL AS e", [`public.${tb}`])).rows[0].e, true, `P10: ${tb} removida`);
    await q(readFileSync("database/checks/20261011_081_postcheck.sql", "utf8"));
  } finally {
    await q("ROLLBACK").catch(() => {});
    await c.end();
  }
});
