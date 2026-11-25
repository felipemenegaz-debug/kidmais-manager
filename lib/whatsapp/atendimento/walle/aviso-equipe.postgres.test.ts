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
    const avisoEquipe = { origem: () => ORIGEM, enviar: async (m: MensagemEmail) => {
      if (falharEmail) throw Object.assign(new Error("provedor fora"), { codigo: "EMAIL_INDISPONIVEL" });
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
    assert.ok(envios.length > 0, "o Wall-e respondeu ao cliente pelo transporte simulado");
  } finally {
    await c.end();
  }
});
