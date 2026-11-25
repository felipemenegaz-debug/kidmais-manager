import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../../../db/contracts.ts";
import type { MensagemEmail } from "../../../acessos/email.ts";
import { carregarAtendimento, cod, db } from "../harness-postgres.ts";
import * as multiempresa from "../multiempresa.ts";
import type { ConteudoSaida } from "../transporte.ts";
import type { PortaWallE } from "../worker.ts";
import { contarAguardandoEquipe, MAX_TENTATIVAS } from "../aviso-equipe.ts";
import { fonteEncaminhamento, MENSAGEM_ENCAMINHAMENTO } from "../core.ts";
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
 * Astra r2 (r3, 25/11): a marca PENDENTE nasce no mesmo UPDATE que põe a conversa na fila, com os motivos dessa passagem.
 *  A10 evento reentregue com horário antigo (30 h; PARAR com reclamação): o motivo vai no e-mail (não depende da idade);
 *  A11 os retries repetem os motivos gravados na transição, mesmo que o registro da passagem mude depois;
 *  A12 sem janela de 24 h: passagem antiga sem aviso e retry depois de 24 h ainda avisam;
 *  A13 recuperação de trabalhos interrompidos: a conversa vai para a fila COM a marca e recebe aviso (motivo genérico);
 *  A14 tentativas por destinatário: o 1º sempre falha e esgota o prazo; o 2º é chamado no lote seguinte; o 1º para em 3;
 *  A15 prazo conferido de novo depois da revalidação: nenhum envio nem tentativa contada;
 *  A16 sem automação: um prazo só desde a entrada do lote (a fila e o aviso não começam nada depois dele);
 *  A17 contingência reconhecida pela origem gravada: a de verdade sai; a resposta automática com o MESMO texto é revogada;
 *  A18 sem a 082, salvar e-mails de aviso é recusado (ATENDIMENTO_AVISO_SEM_082).
 * Astra r3 (r4, 25/11):
 *  A19 o prazo vence entre o COMMIT da tentativa e o provedor: nada sai e a tentativa é desfeita;
 *  A20 queda depois do 1º aceite: o aceite já está na marca e o lote seguinte não reenvia para ele;
 *  A21 janela de idempotência: 1ª tentativa há 24 h, o destinatário não é tentado de novo (ESGOTADO);
 *  A22 pausa reconhecida na recepção com automação ligada: o e-mail leva o motivo da pausa;
 *  A23 modo PILOTO (rollback): o lote da piloto não manda o aviso de outra empresa, nem se o modo muda no meio;
 *      de volta a MULTI, o aviso sai uma vez;
 *  A12 passa a ser retry 22 h depois (dentro da janela).
 * Fatia 9 (Astra r4 da fatia 8, 26/11), Wall-e desligado (fase B), relógio fixo no domingo:
 *  A24 «atendente» na fase B: marca e e-mail com PEDIDO_CLIENTE, sem o texto; resposta com a previsão do horário salvo;
 *  A25 contingência enfileirada com 9h e horário corrigido para 14h antes do despacho: sai 14h, ainda isenta.
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
    // Astra r2: cada destinatário tem as próprias tentativas (destinos[resumo] = {n, em}).
    const tentativas = (cv: { contexto: { avisoEquipe: { destinos: Record<string, { n: number }> } } }) => Object.values(cv.contexto.avisoEquipe.destinos).map((d) => d.n).sort();
    // Envelhece a marca e as tentativas em 11 min (libera o retry sem esperar).
    const envelhecer = (conversaId: string, intervalo = "11 minutes") => c.query(`UPDATE whatsapp_atendimento_conversas SET contexto = jsonb_set(jsonb_set(contexto, '{avisoEquipe,em}', to_jsonb((clock_timestamp() - $2::interval)::text)),
      '{avisoEquipe,destinos}', COALESCE((SELECT jsonb_object_agg(k, v || jsonb_build_object('em', (clock_timestamp() - $2::interval)::text, 'primeira', (clock_timestamp() - $2::interval)::text)) FROM jsonb_each(contexto->'avisoEquipe'->'destinos') d(k, v)), '{}'::jsonb)) WHERE id = $1`, [conversaId, intervalo]);

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
    assert.deepEqual(tentativas(cv1), [1, 1], "A2: uma tentativa por destinatário (o inativo nem conta)");

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
    assert.ok(emails.slice(2).every((m) => m.texto.includes(NOME_MOTIVO.PEDIDO_CLIENTE)), "A4: motivo da passagem nova (posterior à saída)");

    // A5 — falha do provedor: espera 10 min e repete com a MESMA chave; sem porta de e-mail, nada.
    falharEmail = true;
    const c2 = "5561900000802";
    await receber(servico, c2, PEDIDO);
    await worker.processarLote(deps, { maxTarefas: 10 });
    let cv2 = await conversa(A.empresa, c2);
    assert.equal(cv2.contexto.avisoEquipe.estado, "FALHOU");
    assert.deepEqual(tentativas(cv2), [1, 1]);
    const chaveFalha = cv2.contexto.avisoEquipe.chave;
    falharEmail = false;
    await worker.processarLote(deps, { maxTarefas: 10 });
    assert.equal(emails.length, 4, "A5: antes de 10 min, não repete");
    await worker.processarLote({ ...deps, avisoEquipe: undefined }, { maxTarefas: 10 });
    await envelhecer(cv2.id);
    await worker.processarLote({ ...deps, avisoEquipe: undefined }, { maxTarefas: 10 });
    assert.equal(emails.length, 4, "A5: sem porta de e-mail (provedor desativado), nenhuma tentativa");
    await worker.processarLote(deps, { maxTarefas: 10 });
    cv2 = await conversa(A.empresa, c2);
    assert.equal(emails.length, 6, "A5: repetiu depois de 10 min");
    assert.equal(cv2.contexto.avisoEquipe.chave, chaveFalha, "A5: mesma passagem, mesma chave");
    assert.equal(cv2.contexto.avisoEquipe.estado, "ENVIADO");
    assert.deepEqual(tentativas(cv2), [2, 2]);
    assert.ok(emails.slice(4).every((m) => m.idempotencia?.includes(chaveFalha)), "A5: idempotência da mesma passagem");

    // A6 — empresa sem e-mails: nada; selo só da própria empresa.
    const cb = "5561900000803";
    await receber(daB.servico, cb, PEDIDO);
    await daB.worker.processarLote(deps, { maxTarefas: 10 });
    const cvb = await conversa(B.empresa, cb);
    assert.equal(cvb?.estado, "AGUARDANDO_HUMANO", `A6: passou para a equipe da B (${papeis.join(",")})`);
    assert.equal(cvb.contexto.avisoEquipe.estado, "SEM_DESTINATARIO", "A6: sem e-mails configurados, marca fechada sem envio");
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
    }

    // A9 — prazo do lote: corta no prazo (PARCIAL) e o próximo lote manda só o que faltou.
    {
      const contato = "5561900000807", antes: number = emails.length;
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      let agoraMs = 1_000;
      await worker.avisarEquipeDoLote(avisoEquipe, { prazo: 1_000, relogio: () => agoraMs });
      assert.equal(emails.length, antes, "A9: prazo já vencido, nenhum envio começa");
      assert.equal((await conversa(A.empresa, contato)).contexto.avisoEquipe.estado, "PENDENTE", "A9: nem reserva (marca da transição intacta)");
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
      assert.deepEqual(tentativas(cv9), [1, 1], "A9: continuação não conta nova tentativa para quem já recebeu");
    }

    // A10 — evento reentregue com 30 h (dentro da janela de reentrega): o motivo vem da passagem gravada na transição.
    {
      const contato = "5561900000808", antes: number = emails.length;
      await servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto: "outra mensagem hoje? para de me mandar mensagem", timestamp: Date.now() - 30 * 3600_000, nomePerfil: null });
      const cv10 = await conversa(A.empresa, contato);
      assert.equal(cv10.estado, "AGUARDANDO_HUMANO");
      assert.equal(cv10.contexto.avisoEquipe.estado, "PENDENTE", "A10: marca nascida na transição");
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes + 2);
      for (const m of emails.slice(antes)) assert.ok(m.texto.includes(NOME_MOTIVO.RECLAMACAO), "A10: motivo da passagem (reclamação), mesmo com o evento antigo");
    }

    // A11 — retries repetem os motivos gravados na transição.
    {
      const contato = "5561900000809", antes: number = emails.length;
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      const cv11 = await conversa(A.empresa, contato);
      const motivos11 = cv11.contexto.avisoEquipe.motivos;
      assert.ok(motivos11.includes("PEDIDO_CLIENTE"), "A11: motivo fixado na transição");
      await c.query(`UPDATE whatsapp_atendimento_conversas SET passagem = jsonb_build_object('motivos', '["RECLAMACAO"]'::jsonb, 'em', to_jsonb(clock_timestamp())) WHERE id = $1`, [cv11.id]);
      falharEmail = true;
      await worker.avisarEquipeDoLote(avisoEquipe);
      falharEmail = false;
      assert.deepEqual((await conversa(A.empresa, contato)).contexto.avisoEquipe.motivos, motivos11, "A11: o registro mudado depois não troca a marca");
      await c.query(`UPDATE whatsapp_atendimento_conversas SET passagem = jsonb_build_object('motivos', '["PAGAMENTO"]'::jsonb, 'em', to_jsonb(clock_timestamp())) WHERE id = $1`, [cv11.id]);
      await envelhecer(cv11.id);
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes + 2, "A11: retry enviado");
      for (const m of emails.slice(antes)) {
        assert.ok(m.texto.includes(NOME_MOTIVO.PEDIDO_CLIENTE), "A11: mesmo motivo da transição");
        assert.ok(!m.texto.includes(NOME_MOTIVO.PAGAMENTO) && !m.texto.includes(NOME_MOTIVO.RECLAMACAO), "A11: o registro novo não troca o motivo do aviso");
      }
      assert.deepEqual(tentativas(await conversa(A.empresa, contato)), [2, 2]);
    }

    // A12 — sem janela de 24 h na seleção: a marca pendente é avisada mesmo antiga, e o retry 22 h depois também
    // (dentro da janela de idempotência do provedor; depois dela, A21).
    {
      const contato = "5561900000810", antes: number = emails.length;
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      const cv12 = await conversa(A.empresa, contato);
      await c.query("UPDATE whatsapp_atendimento_conversas SET atualizada_em = clock_timestamp() - interval '30 hours', ultima_entrada_em = clock_timestamp() - interval '30 hours' WHERE id = $1", [cv12.id]);
      falharEmail = true;
      await worker.avisarEquipeDoLote(avisoEquipe);
      falharEmail = false;
      assert.equal((await conversa(A.empresa, contato)).contexto.avisoEquipe.estado, "FALHOU", "A12: passagem de 30 h ainda tentada");
      await envelhecer(cv12.id, "22 hours");
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes + 2, "A12: retry 22 h depois ainda avisa");
      assert.equal((await conversa(A.empresa, contato)).contexto.avisoEquipe.estado, "ENVIADO");
    }

    // A13 — recuperação de trabalhos interrompidos põe na fila COM a marca.
    {
      const contato = "5561900000812", antes: number = emails.length;
      await receber(servico, contato, "oi");
      const cv13 = await conversa(A.empresa, contato);
      assert.equal(cv13.estado, "IA");
      await c.query("UPDATE whatsapp_atendimento_mensagens SET estado = 'PROCESSANDO', iniciada_em = clock_timestamp() - interval '11 minutes' WHERE conversa_id = $1 AND estado = 'PENDENTE'", [cv13.id]);
      await servico.recuperarTrabalhosInterrompidos();
      const depois = await conversa(A.empresa, contato);
      assert.equal(depois.estado, "AGUARDANDO_HUMANO", "A13: recuperada para a equipe");
      assert.equal(depois.contexto.avisoEquipe.estado, "PENDENTE", "A13: marca gravada na recuperação");
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes + 2, "A13: aviso da passagem recuperada");
      for (const m of emails.slice(antes)) assert.match(m.texto, /A conversa aguarda a equipe\./, "A13: motivo genérico");
    }

    // A14 — tentativas por destinatário: o 1º falha sempre e gasta o prazo; o 2º não fica sem aviso.
    {
      const contato = "5561900000813", antes: number = emails.length;
      const [primeiro, segundo] = [A.rep.email, adm.email].sort();
      let agoraMs = 0, chamadasPrimeiro = 0;
      const lenta = { origem: () => ORIGEM, enviar: async (m: MensagemEmail) => {
        if (m.para === primeiro) { chamadasPrimeiro++; agoraMs += 5_000; throw Object.assign(new Error("provedor lento"), { codigo: "EMAIL_TIMEOUT" }); }
        emails.push(m); return { provedor: "arquivo" as const, idExterno: null };
      } };
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      const cv14 = await conversa(A.empresa, contato);
      const lote = async () => { agoraMs = 0; await worker.avisarEquipeDoLote(lenta, { prazo: 1_000, relogio: () => agoraMs }); };
      await lote();
      assert.equal(chamadasPrimeiro, 1);
      assert.equal(emails.length, antes, "A14: lote 1 cortado pelo prazo depois do 1º");
      assert.equal((await conversa(A.empresa, contato)).contexto.avisoEquipe.estado, "PARCIAL");
      await lote();
      assert.equal(chamadasPrimeiro, 1, "A14: lote 2 não repete o 1º antes de 10 min");
      assert.deepEqual(emails.slice(antes).map((m) => m.para), [segundo], "A14: o 2º recebe no lote seguinte");
      for (let i = 0; i < 4; i++) { await envelhecer(cv14.id); await lote(); }
      const fim14 = await conversa(A.empresa, contato);
      assert.equal(chamadasPrimeiro, MAX_TENTATIVAS, "A14: o 1º para nas tentativas dele");
      assert.equal(fim14.contexto.avisoEquipe.estado, "ESGOTADO");
      assert.deepEqual(tentativas(fim14), [1, MAX_TENTATIVAS]);
      assert.equal(emails.length, antes + 1);
    }

    // A15 — o prazo vence durante a revalidação: nada sai e a tentativa não é contada.
    {
      const contato = "5561900000814", antes: number = emails.length;
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      let leituras = 0;
      await worker.avisarEquipeDoLote(avisoEquipe, { prazo: 1_000, relogio: () => (++leituras >= 3 ? 5_000 : 0) });
      const cv15 = await conversa(A.empresa, contato);
      assert.equal(emails.length, antes, "A15: nenhum e-mail começa depois do prazo");
      assert.equal(cv15.contexto.avisoEquipe.estado, "PARCIAL");
      assert.deepEqual(cv15.contexto.avisoEquipe.destinos, {}, "A15: nenhuma tentativa contada");
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes + 2, "A15: o lote seguinte avisa");
    }

    // A16 — sem automação: prazo único desde a entrada do lote.
    {
      const contato = "5561900000815", antes: number = emails.length;
      await receber(servico, contato, PEDIDO);
      let primeira = true;
      const relogio = () => { if (primeira) { primeira = false; return 0; } return 25_000; };
      await worker.processarLote(deps, { maxTarefas: 10, semAutomacao: true, relogio });
      assert.equal((await c.query("SELECT count(*)::int AS n FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas v ON v.id = m.conversa_id WHERE v.empresa_id = $1 AND v.contato = $2 AND m.estado = 'PENDENTE'", [A.empresa, contato])).rows[0].n, 1, "A16: a fila não começa tarefa depois do prazo");
      assert.equal(emails.length, antes, "A16: nem aviso");
      await worker.processarLote(deps, { maxTarefas: 10, semAutomacao: true });
      assert.equal((await conversa(A.empresa, contato)).estado, "AGUARDANDO_HUMANO");
      assert.equal(emails.length, antes + 2, "A16: dentro do prazo, fila e aviso andam");
    }

    // A17 — contingência pela origem gravada, não pelo texto.
    {
      const verdadeira = "5561900000816", imitacao = "5561900000817";
      for (const contato of [verdadeira, imitacao]) { await receber(servico, contato, "oi"); await worker.processarLote(semAviso, { maxTarefas: 10 }); }
      const saida = async (contato: string, fonte: string) => {
        const cv = await conversa(A.empresa, contato);
        assert.equal(cv.estado, "IA");
        return id(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, fonte, criada_em)
          VALUES ($1, $2, 'staging', 'SAIDA', $3, 'PENDENTE', $4, $5::jsonb, clock_timestamp() - interval '1 minute') RETURNING id`, [cv.id, A.empresa, MENSAGEM_ENCAMINHAMENTO, cv.versao, fonte]);
      };
      const m1 = await saida(verdadeira, fonteEncaminhamento());
      const m2 = await saida(imitacao, JSON.stringify({ tipo: "WALLE", fontes: [] }));
      await c.query("UPDATE whatsapp_atendimento_config SET atualizada_em = clock_timestamp() WHERE empresa_id = $1", [A.empresa]);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      const estado = async (m: string) => (await c.query("SELECT estado FROM whatsapp_atendimento_mensagens WHERE id = $1", [m])).rows[0].estado;
      assert.notEqual(await estado(m1), "CANCELADA", "A17: a contingência de verdade sai");
      assert.equal(await estado(m2), "CANCELADA", "A17: o mesmo texto sem a origem é revogado");
      const cv17 = await conversa(A.empresa, imitacao);
      assert.equal(cv17.estado, "AGUARDANDO_HUMANO", "A17: revogada com a IA conduzindo, vai para a equipe");
      assert.equal(cv17.contexto.avisoEquipe.estado, "PENDENTE", "A17: com a marca do aviso");
    }

    // A19 — o prazo vence depois do COMMIT da tentativa (4ª leitura do relógio): nada sai e a tentativa é desfeita.
    await worker.avisarEquipeDoLote(avisoEquipe); // marcas da piloto ainda pendentes (A17) saem antes: o relógio conta só este caso
    {
      const contato = "5561900000818", antes: number = emails.length;
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      let leituras = 0;
      await worker.avisarEquipeDoLote(avisoEquipe, { prazo: 1_000, relogio: () => (++leituras >= 4 ? 5_000 : 0) });
      const cv19 = await conversa(A.empresa, contato);
      assert.equal(leituras, 4, "A19: o relógio foi lido depois do COMMIT");
      assert.equal(emails.length, antes, "A19: nenhum e-mail depois do prazo");
      assert.equal(cv19.contexto.avisoEquipe.estado, "PARCIAL");
      assert.deepEqual(cv19.contexto.avisoEquipe.destinos, {}, "A19: tentativa desfeita");
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes + 2, "A19: o lote seguinte avisa");
      assert.deepEqual(tentativas(await conversa(A.empresa, contato)), [1, 1]);
    }

    // A20 — queda depois do 1º aceite (o relógio lança na 5ª leitura, antes do 2º): o aceite já está na marca.
    {
      const contato = "5561900000819", antes: number = emails.length;
      const [primeiro, segundo] = [A.rep.email, adm.email].sort();
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      let leituras = 0;
      await worker.avisarEquipeDoLote(avisoEquipe, { prazo: 1_000, relogio: () => { if (++leituras === 5) throw Object.assign(new Error("queda"), { codigo: "QUEDA" }); return 0; } });
      assert.deepEqual(emails.slice(antes).map((m) => m.para), [primeiro], "A20: só o 1º saiu antes da queda");
      const cv20 = await conversa(A.empresa, contato);
      assert.equal(cv20.contexto.avisoEquipe.estado, "ENVIANDO", "A20: a queda deixou a marca em curso");
      assert.equal(cv20.contexto.avisoEquipe.feitos.length, 1, "A20: o aceite do 1º já foi gravado");
      await envelhecer(cv20.id);
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.deepEqual(emails.slice(antes).map((m) => m.para), [primeiro, segundo], "A20: depois, só o 2º; o 1º não recebe de novo");
      assert.equal((await conversa(A.empresa, contato)).contexto.avisoEquipe.estado, "ENVIADO");
    }

    // A21 — janela de idempotência do provedor: a 1ª tentativa foi há 24 h; ninguém é tentado de novo.
    {
      const contato = "5561900000820", antes: number = emails.length;
      await receber(servico, contato, PEDIDO);
      await worker.processarLote(semAviso, { maxTarefas: 10 });
      falharEmail = true;
      await worker.avisarEquipeDoLote(avisoEquipe);
      falharEmail = false;
      const cv21 = await conversa(A.empresa, contato);
      assert.equal(cv21.contexto.avisoEquipe.estado, "FALHOU");
      await envelhecer(cv21.id, "24 hours");
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes, "A21: fora da janela, nenhum reenvio");
      const fim21 = await conversa(A.empresa, contato);
      assert.equal(fim21.contexto.avisoEquipe.estado, "ESGOTADO");
      assert.deepEqual(tentativas(fim21), [1, 1], "A21: nenhuma tentativa nova");
    }

    // A22 — pausa reconhecida na recepção com a automação ligada: a marca nasce com o motivo da pausa.
    {
      const contato = "5561900000821", antes: number = emails.length;
      await receber(servico, contato, "pausa as mensagens");
      const cv22 = await conversa(A.empresa, contato);
      assert.equal(cv22.estado, "AGUARDANDO_HUMANO", "A22: a pausa vai para a equipe na recepção");
      assert.deepEqual(cv22.contexto.avisoEquipe.motivos, ["PARAR_A_CONFIRMAR"], "A22: motivo gravado na marca");
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes + 2);
      for (const m of emails.slice(antes)) {
        assert.ok(m.texto.includes(NOME_MOTIVO.PARAR_A_CONFIRMAR), "A22: o e-mail leva o motivo da pausa");
        assert.doesNotMatch(m.texto, /A conversa aguarda a equipe\./, "A22: não o genérico");
        assert.doesNotMatch(`${m.texto}\n${m.html}`, /pausa as mensagens/, "A22: nunca o texto do cliente");
      }
    }

    // A23 — modo efetivo: PILOTO (rollback) não manda o aviso de outra empresa; de volta a MULTI, sai uma vez.
    {
      await worker.avisarEquipeDoLote(avisoEquipe); // nada da piloto pendente antes do caso
      await daB.servico.salvarConfiguracao(B.sessao, { ...base, avisoEquipe: { emails: [B.rep.email] } });
      const contato = "5561900000822";
      await receber(daB.servico, contato, PEDIDO);
      await daB.worker.processarLote(semAviso, { maxTarefas: 10 });
      const deB = () => emails.filter((m) => m.para === B.rep.email).length;
      assert.equal((await conversa(B.empresa, contato)).contexto.avisoEquipe.estado, "PENDENTE");
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(deB(), 0, "A23: PILOTO (piloto A) não manda o aviso de B");
      assert.equal((await conversa(B.empresa, contato)).contexto.avisoEquipe.estado, "PENDENTE", "A23: a marca de B fica intacta");
      // MULTI na reserva, PILOTO na revalidação (rollback no meio): nada sai e a marca fica PARCIAL.
      const modos: ("MULTI" | "PILOTO")[] = ["MULTI", "PILOTO"];
      const viraNoMeio = carregarAtendimento(A.empresa, "staging", { "./multiempresa.ts": { ...multiempresa, modoEfetivo: async () => modos.shift() ?? "PILOTO" } });
      await viraNoMeio.worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(deB(), 0, "A23: rollback entre a reserva e o envio: nada sai");
      assert.equal((await conversa(B.empresa, contato)).contexto.avisoEquipe.estado, "PARCIAL", "A23: fica PARCIAL");
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(deB(), 0, "A23: PARCIAL de B continua fora do lote da piloto A");
      const multi = carregarAtendimento(A.empresa, "staging", { "./multiempresa.ts": { ...multiempresa, modoEfetivo: async () => "MULTI" } });
      await multi.worker.avisarEquipeDoLote(avisoEquipe);
      await multi.worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(deB(), 1, "A23: de volta a MULTI, o aviso de B sai uma vez");
      assert.equal((await conversa(B.empresa, contato)).contexto.avisoEquipe.estado, "ENVIADO");
    }

    // Fatia 9 (Astra r4 da fatia 8): Wall-e DESLIGADO na configuração (fase B, com a 082), relógio fixo no domingo 10h.
    {
      const domingo = () => new Date("2026-11-29T10:00:00-03:00");
      const faseB = { ...deps, agora: domingo };
      const semAviso9 = { ...faseB, avisoEquipe: undefined };
      const config = (inicio: string) => servico.salvarConfiguracao(A.sessao, { ...base, wallE: { ativo: false }, avisoEquipe: { emails: [A.rep.email, adm.email] }, horarioEquipe: { seg: { inicio, fim: "18:00" } } });
      await config("09:00");
      await worker.avisarEquipeDoLote(avisoEquipe); // nada pendente de casos anteriores
      // A24 (P-F8-1 e P-F8-2) — «atendente» na fase B: marca com PEDIDO_CLIENTE, e-mail com o rótulo e sem o texto; a resposta
      // ao cliente diz quando a equipe volta.
      const contato = "5561900000824", antes = emails.length, enviadosAntes = envios.length;
      await receber(servico, contato, "atendente");
      await worker.processarLote(semAviso9, { maxTarefas: 10 });
      const cv24 = await conversa(A.empresa, contato);
      assert.equal(cv24.estado, "AGUARDANDO_HUMANO", "A24: fase B passou para a equipe");
      assert.deepEqual(cv24.contexto.avisoEquipe.motivos, ["PEDIDO_CLIENTE"], "A24: motivo gravado na marca");
      const enviada = envios.slice(enviadosAntes).map((x) => JSON.stringify(x)).join(" | ");
      assert.ok(enviada.includes("Vou encaminhar seu pedido para um atendente. Sua mensagem foi encaminhada fora do horário de atendimento: a equipe responde na segunda-feira a partir das 9h."), "A24: previsão pelo horário salvo");
      await worker.avisarEquipeDoLote(avisoEquipe);
      assert.equal(emails.length, antes + 2);
      for (const m of emails.slice(antes)) {
        assert.ok(m.texto.includes(NOME_MOTIVO.PEDIDO_CLIENTE), "A24: o e-mail leva o rótulo do motivo");
        assert.ok(!m.texto.includes("A conversa aguarda a equipe."), "A24: não o genérico");
        assert.doesNotMatch(`${m.assunto} | ${m.texto} | ${m.html}`, /atendente|5561900000824/, "A24: nunca o texto nem o telefone do cliente");
      }
      // A25 (P-F8-3) — contingência enfileirada prometendo 9h; a equipe corrige para 14h antes do despacho: sai 14h, isenta.
      const c25 = "5561900000825";
      await receber(servico, c25, "qual o valor do pacote?");
      await worker.processarLote(semAviso9, { maxTarefas: 1 }); // só a entrada: a contingência fica na fila
      const fila = (await c.query("SELECT m.id, m.texto, m.fonte FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas v ON v.id = m.conversa_id WHERE v.contato = $1 AND m.direcao = 'SAIDA'", [c25])).rows;
      assert.equal(fila.length, 1);
      assert.deepEqual(fila[0].fonte, JSON.parse(fonteEncaminhamento()), "A25: contingência com a origem gravada");
      assert.match(fila[0].texto, /a partir das 9h.$/, "A25: composta com o horário de então");
      await config("14:00");
      const enviadosAntes25 = envios.length;
      await worker.processarLote(semAviso9, { maxTarefas: 10 });
      const final = (await c.query("SELECT estado, texto FROM whatsapp_atendimento_mensagens WHERE id = $1", [fila[0].id])).rows[0];
      assert.equal(final.estado, "SUBMETIDA", "A25: a isenção continua (a edição da configuração não a revoga)");
      assert.match(final.texto, /na segunda-feira a partir das 14h.$/, "A25: texto gravado recomposto");
      assert.match(JSON.stringify(envios.slice(enviadosAntes25)), /a partir das 14h./, "A25: o provedor recebe o horário vigente");
      assert.doesNotMatch(JSON.stringify(envios.slice(enviadosAntes25)), /a partir das 9h/, "A25: nunca o horário antigo");
    }

    // A18 — sem a 082 (simulada pela coluna que o tem082 confere), e-mails de aviso não são aceitos.
    await c.query("ALTER TABLE whatsapp_atendimento_mensagens RENAME COLUMN origem_grupo_id TO origem_grupo_id_r3");
    try {
      await assert.rejects(servico.salvarConfiguracao(A.sessao, { ...base, avisoEquipe: { emails: [A.rep.email] } }), /ATENDIMENTO_AVISO_SEM_082/, "A18: sem a 082, recusa");
    } finally {
      await c.query("ALTER TABLE whatsapp_atendimento_mensagens RENAME COLUMN origem_grupo_id_r3 TO origem_grupo_id");
    }
    assert.ok(envios.length > 0, "o Wall-e respondeu ao cliente pelo transporte simulado");
  } finally {
    await c.end();
  }
});
