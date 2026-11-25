import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../../../db/contracts.ts";
import type { MensagemEmail } from "../../../acessos/email.ts";
import { carregarAtendimento, cod, db } from "../harness-postgres.ts";
import type { ConteudoSaida } from "../transporte.ts";
import type { PortaWallE } from "../worker.ts";
import { contarAguardandoEquipe } from "../aviso-equipe.ts";
import { lerContexto } from "./contexto.ts";
import { entenderPorRegras } from "./entendimento.ts";
import { catalogosWallE, fontesPostgres } from "./fontes-postgres.ts";
import { resolverWallE } from "./resolver.ts";
import { NOME_MOTIVO } from "./tipos.ts";

/**
 * Fatia 8 (25/11/2026): aviso por e-mail à equipe na passagem, no worker REAL e no PostgreSQL descartável (só pelo
 * check:v1:postgres, com opt-in). Dados sintéticos; Wall-e por regras locais (sem modelo); transporte e e-mail simulados
 * (nenhuma rede, nenhum envio real).
 *
 *  A1 salvar recusa e-mail de quem não tem acesso ao Atendimento da empresa (outra empresa, papel sem acesso);
 *  A2 uma passagem = um aviso por destinatário autorizado, com motivo e link; nunca o texto do cliente;
 *     destinatário que perdeu o acesso depois de salvo não recebe (revalidado a cada envio);
 *  A3 outro lote e nova mensagem do cliente com a conversa na fila: nenhum aviso novo;
 *  A4 assumir limpa a marca; devolvida ao Wall-e e passada de novo, a nova passagem gera novo aviso;
 *  A5 falha do provedor: nova tentativa só depois de 10 min, com a MESMA chave de idempotência; sem porta, nada;
 *  A6 empresa sem e-mails configurados: nenhum aviso; o selo conta só as conversas da própria empresa.
 * Astra r1 (r2 de exceção, 25/11):
 *  A7 com o 1º e-mail em curso, o 2º destinatário sai da lista ou perde o acesso: não recebe;
 *  A8 com o 1º e-mail em curso, a equipe assume a conversa: o 2º não sai e a marca fica limpa;
 *  A9 prazo do lote: o envio para no prazo (PARCIAL) e o lote seguinte manda só o que faltou, mesma passagem;
 *  A10 motivo da passagem anterior à última saída da fila não vai no e-mail (motivo genérico);
 *  A11 os retries repetem os motivos da 1ª reserva, mesmo que o registro da passagem mude;
 *  A12 a janela de 24 h conta da passagem (atualizada_em), não da última entrada do cliente.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const MIGRATIONS = [
  ["database/migrations/20261001_060_whatsapp_atendimento.sql", "database/checks/20261001_060_postcheck.sql"],
  ["database/migrations/20261011_080_whatsapp_mensagens_prontas.sql", "database/checks/20261011_080_postcheck.sql"],
  ["database/migrations/20261011_081_whatsapp_prontas_midia.sql", "database/checks/20261011_081_postcheck.sql"],
  ["database/migrations/20261011_082_wall_e_atendimento.sql", "database/checks/20261011_082_postcheck.sql"],
].map(([up, post]) => [ler(up), ler(post)]);
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const ORIGEM = "https://painel.exemplo.test";

test("aviso à equipe por e-mail na passagem: um por passagem, destinatários autorizados, sem texto do cliente", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  try {
    for (const [up, post] of MIGRATIONS) { await c.query(up); await c.query(post); }
    const id = async (sql: string, v: unknown[]) => (await c.query<{ id: string }>(sql, v)).rows[0].id;
    async function pessoa(empresa: string, papel: string) {
      const email = `${cod("av")}@example.test`;
      const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness aviso', $2, $3, true) RETURNING id`, [email, SENHA, papel]);
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [empresa, u, papel]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      return { usuario: u, email };
    }
    async function empresa(nome: string) {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("ae"), nome]);
      await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      const rep = await pessoa(e, "REPRESENTANTE_AUTORIZADO");
      return { empresa: e, rep, sessao: { usuario_id: rep.usuario, papel: "REPRESENTANTE_AUTORIZADO" } as never };
    }
    const A = await empresa("Buffet <Aviso> & Cia");
    const B = await empresa("Outra empresa sintética");
    const adm = await pessoa(A.empresa, "ADMINISTRATIVO");
    const saiDepois = await pessoa(A.empresa, "ADMINISTRATIVO");
    const papeis = (await c.query<{ papel: string }>("SELECT DISTINCT papel FROM memberships")).rows.map((r) => r.papel);
    const { servico, worker } = carregarAtendimento(A.empresa);
    const daB = carregarAtendimento(B.empresa);
    const base = { ativo: true, nome: "Buffet sintético", perguntas: [], wallE: { ativo: true } };

    // A1 — salvar: só e-mails de pessoas com acesso ao Atendimento desta empresa.
    await assert.rejects(servico.salvarConfiguracao(A.sessao, { ...base, avisoEquipe: { emails: [A.rep.email, B.rep.email] } }), /ATENDIMENTO_AVISO_DESTINATARIO/, "A1: e-mail de outra empresa");
    await assert.rejects(servico.salvarConfiguracao(A.sessao, { ...base, avisoEquipe: { emails: ["ninguem@example.test"] } }), /ATENDIMENTO_AVISO_DESTINATARIO/, "A1: e-mail sem cadastro");
    await servico.salvarConfiguracao(A.sessao, { ...base, avisoEquipe: { emails: [A.rep.email.toUpperCase(), adm.email, saiDepois.email] },
      horarioEquipe: { seg: { inicio: "09:00", fim: "18:00" } } });
    const salva = (await c.query("SELECT configuracao FROM whatsapp_atendimento_config WHERE empresa_id = $1", [A.empresa])).rows[0].configuracao;
    assert.deepEqual(salva.avisoEquipe.emails, [A.rep.email, adm.email, saiDepois.email], "A1: gravado em minúsculas");
    assert.deepEqual(salva.horarioEquipe, { seg: { inicio: "09:00", fim: "18:00" } });
    await daB.servico.salvarConfiguracao(B.sessao, base);
    // Perde o acesso depois de salvo: o envio revalida e não manda para ele.
    await c.query("UPDATE usuarios_administrativos SET ativo = false WHERE id = $1", [saiDepois.usuario]);

    const portaWallE: PortaWallE = { async responder(e) {
      const ex2 = db() as unknown as DbExecutor;
      const catalogos = await catalogosWallE(ex2, e.empresa, e.config, e.hoje);
      const contexto = lerContexto(e.contexto);
      return resolverWallE({ texto: e.texto, entendimento: entenderPorRegras(e.texto, catalogos, contexto), contexto, config: e.config, catalogos, agora: e.agora },
        fontesPostgres(ex2, { empresaId: e.empresa, ambiente: e.ambiente, hoje: e.hoje, linkContratoProprio: async () => null }));
    } };
    const emails: MensagemEmail[] = [];
    let falharEmail = false;
    // Pausa no 1º e-mail seguinte: roda a corrida (revogação, assumir, relógio) com o envio em curso.
    let pausa: ((m: MensagemEmail) => Promise<void>) | null = null;
    const avisoEquipe = { origem: () => ORIGEM, enviar: async (m: MensagemEmail) => {
      if (falharEmail) throw Object.assign(new Error("provedor fora"), { codigo: "EMAIL_INDISPONIVEL" });
      if (pausa) { const p = pausa; pausa = null; await p(m); }
      emails.push(m); return { provedor: "arquivo" as const, idExterno: null };
    } };
    const envios: ConteudoSaida[] = [];
    const deps = { interpretar: async () => { throw new Error("modelo proibido no harness"); }, enviar: async (_: string, conteudo: ConteudoSaida) => { envios.push(conteudo); return cod("gs-"); }, wallE: portaWallE, avisoEquipe };
    const receber = (s: typeof servico, contato: string, texto: string) => s.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp: Date.now(), nomePerfil: null });
    const conversa = async (empresaId: string, contato: string) => (await c.query("SELECT id, versao, estado, contexto FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [empresaId, contato])).rows[0];
    const PEDIDO = "quero falar com um atendente por favor";

    // A2 — passagem: um aviso por destinatário autorizado.
    const c1 = "5561900000801";
    await receber(servico, c1, PEDIDO);
    await worker.processarLote(deps, { maxTarefas: 10 });
    const cv1 = await conversa(A.empresa, c1);
    assert.equal(cv1.estado, "AGUARDANDO_HUMANO", "A2: passou para a equipe");
    assert.deepEqual(emails.map((m) => m.para).sort(), [A.rep.email, adm.email].sort(), "A2: só quem tem acesso ativo");
    for (const m of emails) {
      assert.match(m.texto, new RegExp(`${ORIGEM.replace(/\./g, "\\.")}/admin/atendimento\\?conversa=${cv1.id}`), "A2: link autenticado da conversa");
      assert.match(m.texto, /Pedido do cliente|pediu|equipe/i);
      assert.doesNotMatch(`${m.assunto}\n${m.texto}\n${m.html}`, /quero falar|por favor|5561900000801/, "A2: nenhum texto nem telefone do cliente");
      assert.match(m.html, /Buffet &lt;Aviso&gt; &amp; Cia/);
      assert.match(m.idempotencia ?? "", /^[A-Za-z0-9_:/-]{1,200}$/);
    }
    assert.equal(new Set(emails.map((m) => m.idempotencia)).size, 2, "A2: uma chave por destinatário");
    assert.equal(cv1.contexto.avisoEquipe.estado, "ENVIADO");
    assert.equal(cv1.contexto.avisoEquipe.tentativas, 1);

    // A3 — outro lote e mensagem nova com a conversa na fila: nenhum aviso novo.
    await worker.processarLote(deps, { maxTarefas: 10 });
    await receber(servico, c1, "oi, tem alguém aí?");
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(emails.length, 2, "A3: um aviso por passagem");
    assert.equal((await conversa(A.empresa, c1)).contexto.avisoEquipe?.estado, "ENVIADO", "A3: a marca continua");
    assert.equal(await contarAguardandoEquipe(db() as unknown as DbExecutor, A.empresa, "staging"), 1, "A3: selo do menu");

    // A4 — assumir limpa a marca; de volta ao Wall-e e passada de novo, novo aviso.
    let cv = await conversa(A.empresa, c1);
    await servico.controlarAtendimento(A.sessao, { acao: "assumir", conversaId: cv.id, versao: Number(cv.versao) });
    cv = await conversa(A.empresa, c1);
    assert.equal(cv.contexto.avisoEquipe, undefined, "A4: assumida, a marca sai");
    assert.equal(await contarAguardandoEquipe(db() as unknown as DbExecutor, A.empresa, "staging"), 0, "A4: selo zera");
    await servico.controlarAtendimento(A.sessao, { acao: "retomar", conversaId: cv.id, versao: Number(cv.versao) });
    await receber(servico, c1, PEDIDO);
    await worker.processarLote(deps, { maxTarefas: 10 });
    cv = await conversa(A.empresa, c1);
    assert.equal(cv.estado, "AGUARDANDO_HUMANO");
    assert.equal(emails.length, 4, "A4: nova passagem, novo aviso");
    assert.notEqual(emails[2].idempotencia, emails[0].idempotencia, "A4: chave nova para a nova passagem");
    assert.ok(cv.contexto.avisoEquipeSaida, "A4: a memória do Wall-e preserva o fim da passagem anterior");
    assert.ok(emails.slice(2).every((m) => m.texto.includes(NOME_MOTIVO.PEDIDO_CLIENTE)), "A4: motivo da passagem nova (posterior à saída)");

    // A5 — falha do provedor: espera 10 min e repete com a MESMA chave; sem porta de e-mail, nada.
    falharEmail = true;
    const c2 = "5561900000802";
    await receber(servico, c2, PEDIDO);
    await worker.processarLote(deps, { maxTarefas: 10 });
    let cv2 = await conversa(A.empresa, c2);
    assert.equal(cv2.contexto.avisoEquipe.estado, "FALHOU");
    assert.equal(cv2.contexto.avisoEquipe.tentativas, 1);
    const chaveFalha = cv2.contexto.avisoEquipe.chave;
    falharEmail = false;
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(emails.length, 4, "A5: antes de 10 min, não repete");
    await worker.processarLote({ ...deps, avisoEquipe: undefined }, { maxTarefas: 10 });
    await c.query("UPDATE whatsapp_atendimento_conversas SET contexto = jsonb_set(contexto, '{avisoEquipe,em}', to_jsonb((clock_timestamp() - interval '11 minutes')::text)) WHERE id = $1", [cv2.id]);
    await worker.processarLote({ ...deps, avisoEquipe: undefined }, { maxTarefas: 10 });
    assert.equal(emails.length, 4, "A5: sem porta de e-mail (provedor desativado), nenhuma tentativa");
    await worker.processarLote(deps, { maxTarefas: 10 });
    cv2 = await conversa(A.empresa, c2);
    assert.equal(emails.length, 6, "A5: repetiu depois de 10 min");
    assert.equal(cv2.contexto.avisoEquipe.chave, chaveFalha, "A5: mesma passagem, mesma chave");
    assert.equal(cv2.contexto.avisoEquipe.estado, "ENVIADO");
    assert.equal(cv2.contexto.avisoEquipe.tentativas, 2);
    assert.ok(emails.slice(4).every((m) => m.idempotencia?.includes(chaveFalha)), "A5: idempotência da mesma passagem");

    // A6 — empresa sem e-mails: nada; selo só da própria empresa.
    const cb = "5561900000803";
    await receber(daB.servico, cb, PEDIDO);
    await daB.worker.processarLote(deps, { maxTarefas: 10 });
    const cvb = await conversa(B.empresa, cb);
    assert.equal(cvb?.estado, "AGUARDANDO_HUMANO", `A6: passou para a equipe da B (${papeis.join(",")})`);
    assert.equal(cvb.contexto.avisoEquipe, undefined, "A6: sem e-mails configurados, sem marca");
    assert.equal(emails.length, 6, "A6: nenhum aviso para a B");
    assert.equal(await contarAguardandoEquipe(db() as unknown as DbExecutor, B.empresa, "staging"), 1);
    assert.equal(await contarAguardandoEquipe(db() as unknown as DbExecutor, A.empresa, "staging"), 2);

    const semAviso = { ...deps, avisoEquipe: undefined };
    const lista = async (emailsLista: string[]) => c.query("UPDATE whatsapp_atendimento_config SET configuracao = jsonb_set(configuracao, '{avisoEquipe,emails}', $2::jsonb) WHERE empresa_id = $1", [A.empresa, JSON.stringify(emailsLista)]);
    const outro = (m: MensagemEmail) => (m.para === A.rep.email ? { email: adm.email, usuario: adm.usuario } : { email: A.rep.email, usuario: A.rep.usuario });

    // A7 — corrida: o 2º destinatário sai da lista / perde o acesso com o 1º e-mail em curso.
    for (const [contato, modo] of [["5561900000804", "lista"], ["5561900000805", "acesso"]] as const) {
      const antes: number = emails.length;
      let revogado = "";
      pausa = async (m) => {
        const o = outro(m); revogado = o.email;
        if (modo === "lista") await lista([m.para]);
        else await c.query("UPDATE usuarios_administrativos SET ativo = false WHERE id = $1", [o.usuario]);
      };
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(deps, { maxTarefas: 10 });
      const cv7 = await conversa(A.empresa, contato);
      assert.equal(emails.length, antes + 1, `A7 (${modo}): só o 1º e-mail saiu`);
      assert.ok(!emails.slice(antes).some((m) => m.para === revogado), `A7 (${modo}): o revogado não recebe`);
      assert.equal(cv7.contexto.avisoEquipe.estado, "ENVIADO", `A7 (${modo}): marca fechada, sem retry para o revogado`);
      assert.equal(cv7.contexto.avisoEquipe.feitos.length, 2);
      await lista([A.rep.email, adm.email, saiDepois.email]);
      await c.query("UPDATE usuarios_administrativos SET ativo = true WHERE id = ANY($1::uuid[])", [[A.rep.usuario, adm.usuario]]);
      await worker.processarLote(deps, { maxTarefas: 10 });
      assert.equal(emails.length, antes + 1, `A7 (${modo}): acesso devolvido não reabre a passagem já avisada`);
    }

    // A8 — corrida: a equipe assume a conversa com o 1º e-mail em curso.
    {
      const contato = "5561900000806", antes: number = emails.length;
      pausa = async () => {
        const atual = await conversa(A.empresa, contato);
        await servico.controlarAtendimento(A.sessao, { acao: "assumir", conversaId: atual.id, versao: Number(atual.versao) });
      };
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(deps, { maxTarefas: 10 });
      const cv8 = await conversa(A.empresa, contato);
      assert.equal(cv8.estado, "HUMANO");
      assert.equal(emails.length, antes + 1, "A8: depois de assumida, o 2º aviso não sai");
      assert.equal(cv8.contexto.avisoEquipe, undefined, "A8: a marca limpa pelo assumir não é regravada");
      assert.ok(cv8.contexto.avisoEquipeSaida, "A8: fim da passagem registrado");
    }

    // A9 — prazo do lote: corta no prazo (PARCIAL) e o próximo lote manda só o que faltou.
    {
      const contato = "5561900000807", antes: number = emails.length;
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      let agoraMs = 1_000;
      await worker.avisarEquipeDoLote(avisoEquipe, { prazo: 1_000, relogio: () => agoraMs });
      assert.equal(emails.length, antes, "A9: prazo já vencido, nenhum envio começa");
      assert.equal((await conversa(A.empresa, contato)).contexto.avisoEquipe, undefined, "A9: nem reserva");
      agoraMs = 0;
      pausa = async () => { agoraMs = 5_000; };
      await worker.avisarEquipeDoLote(avisoEquipe, { prazo: 1_000, relogio: () => agoraMs });
      let cv9 = await conversa(A.empresa, contato);
      assert.equal(emails.length, antes + 1, "A9: só o e-mail iniciado antes do prazo");
      assert.equal(cv9.contexto.avisoEquipe.estado, "PARCIAL");
      assert.equal(cv9.contexto.avisoEquipe.feitos.length, 1);
      const chave9 = cv9.contexto.avisoEquipe.chave;
      await worker.avisarEquipeDoLote(avisoEquipe);
      cv9 = await conversa(A.empresa, contato);
      assert.equal(emails.length, antes + 2, "A9: o lote seguinte continua sem esperar 10 min");
      assert.deepEqual(emails.slice(antes).map((m) => m.para).sort(), [A.rep.email, adm.email].sort(), "A9: ninguém recebe duas vezes");
      assert.equal(cv9.contexto.avisoEquipe.estado, "ENVIADO");
      assert.equal(cv9.contexto.avisoEquipe.chave, chave9, "A9: mesma passagem");
      assert.equal(cv9.contexto.avisoEquipe.tentativas, 1, "A9: continuação não conta como nova tentativa");
    }

    // A10 — motivo de passagem anterior à última saída da fila: e-mail com motivo genérico.
    {
      const contato = "5561900000808", antes: number = emails.length;
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      const cv10 = await conversa(A.empresa, contato);
      await c.query(`UPDATE whatsapp_atendimento_conversas SET passagem = jsonb_build_object('motivos', '["RECLAMACAO"]'::jsonb, 'em', to_jsonb((clock_timestamp() - interval '3 minutes'))),
        contexto = contexto || jsonb_build_object('avisoEquipeSaida', to_jsonb(clock_timestamp() - interval '2 minutes')) WHERE id = $1`, [cv10.id]);
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes + 2);
      for (const m of emails.slice(antes)) {
        assert.ok(!m.texto.includes(NOME_MOTIVO.RECLAMACAO), "A10: motivo velho não vai");
        assert.match(m.texto, /A conversa aguarda a equipe\./, "A10: motivo genérico");
      }
    }

    // A11 — retries repetem os motivos da 1ª reserva.
    {
      const contato = "5561900000809", antes: number = emails.length;
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      const cv11 = await conversa(A.empresa, contato);
      await c.query(`UPDATE whatsapp_atendimento_conversas SET passagem = jsonb_build_object('motivos', '["RECLAMACAO"]'::jsonb, 'em', to_jsonb(clock_timestamp())) WHERE id = $1`, [cv11.id]);
      falharEmail = true;
      await worker.avisarEquipeDoLote(avisoEquipe);
      falharEmail = false;
      assert.deepEqual((await conversa(A.empresa, contato)).contexto.avisoEquipe.motivos, ["RECLAMACAO"], "A11: motivo fixado na marca");
      await c.query(`UPDATE whatsapp_atendimento_conversas SET passagem = jsonb_build_object('motivos', '["PAGAMENTO"]'::jsonb, 'em', to_jsonb(clock_timestamp())),
        contexto = jsonb_set(contexto, '{avisoEquipe,em}', to_jsonb((clock_timestamp() - interval '11 minutes')::text)) WHERE id = $1`, [cv11.id]);
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes + 2, "A11: retry enviado");
      for (const m of emails.slice(antes)) {
        assert.ok(m.texto.includes(NOME_MOTIVO.RECLAMACAO), "A11: mesmo motivo da 1ª reserva");
        assert.ok(!m.texto.includes(NOME_MOTIVO.PAGAMENTO), "A11: o registro novo não troca o motivo do aviso");
      }
      assert.equal((await conversa(A.empresa, contato)).contexto.avisoEquipe.tentativas, 2);
    }

    // A12 — janela pela passagem, não pela última entrada (entrada reentregue antiga gera passagem agora).
    {
      const contato = "5561900000810", antes: number = emails.length;
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      const cv12 = await conversa(A.empresa, contato);
      await c.query("UPDATE whatsapp_atendimento_conversas SET ultima_entrada_em = clock_timestamp() - interval '30 hours' WHERE id = $1", [cv12.id]);
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes + 2, "A12: passagem recente é avisada mesmo com a última entrada antiga");
      const velho = "5561900000811";
      await receber(servico, velho, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      await c.query("UPDATE whatsapp_atendimento_conversas SET atualizada_em = clock_timestamp() - interval '25 hours' WHERE empresa_id = $1 AND contato = $2", [A.empresa, velho]);
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes + 2, "A12: passagem de mais de 24 h não gera aviso atrasado");
    }
    assert.ok(envios.length > 0, "o Wall-e respondeu ao cliente pelo transporte simulado");
  } finally {
    await c.end();
  }
});
