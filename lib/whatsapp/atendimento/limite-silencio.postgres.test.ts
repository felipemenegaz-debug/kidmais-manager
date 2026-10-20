import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarAtendimento, cod } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";
import type { PortaWallE } from "./worker.ts";
import { comandoDireto, pausaPedidaNaRecepcao } from "./core.ts";
import { pedidoDeParar } from "./opt-out.ts";

/**
 * M1 (revisão da correção P1): com o limite diário de respostas ESGOTADO, a mensagem vai para a equipe em SILÊNCIO — sem
 * modelo, sem Wall-e e sem o texto fixo de encaminhamento — e o resumo diz LIMITE_DIARIO: o silêncio não é apresentado
 * como reconhecimento de pausa. Marcas e memória já gravadas ficam como estão; toda marca registra a origem (B5).
 * Worker e recepção REAIS no PostgreSQL descartável (modelo "atual" + 060/080/081/082), só pelo check:v1:postgres, com
 * opt-in. Contatos e dados sintéticos; transporte simulado (nenhuma rede). A porta do Wall-e simula o modelo para a
 * paráfrase do W22 (pausa que as regras não reconhecem) e responde as demais mensagens com texto sintético e memória.
 *
 *  S1 limite esgotado + paráfrase do W22: nada sai, nada é chamado, LIMITE_DIARIO, nenhuma marca de pausa inventada;
 *  S2 sem limite + paráfrase do W22: o Wall-e (modelo simulado) reconhece a pausa — marca com origem WALLE;
 *  S3 limite esgotado + pausa determinística: a recepção captura — marca com origem RECEPCAO, nada sai;
 *  S4 limite esgotado + mensagem comum: silêncio LIMITE_DIARIO; a memória do Wall-e é preservada; sem marca;
 *  S5 limite esgotado + PARAR inequívoco: bloqueio definitivo, nada sai;
 *  S6 marca já existente (S2) persiste com mensagens novas, encerramento e reabertura; a equipe continua respondendo;
 *  S7 pausa já enfileirada (recepção anterior à correção) com o limite esgotado: barreira do worker, marca com origem FILA.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const MIGRATIONS = [
  ["database/migrations/20261001_060_whatsapp_atendimento.sql", "database/checks/20261001_060_postcheck.sql"],
  ["database/migrations/20261011_080_whatsapp_mensagens_prontas.sql", "database/checks/20261011_080_postcheck.sql"],
  ["database/migrations/20261011_081_whatsapp_prontas_midia.sql", "database/checks/20261011_081_postcheck.sql"],
  ["database/migrations/20261011_082_wall_e_atendimento.sql", "database/checks/20261011_082_postcheck.sql"],
].map(([up, post]) => [ler(up), ler(post)]);
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const PARAFRASE_W22 = "dá uma segurada nas mensagens por uns tempos, depois eu volto a falar com vcs";
const PAUSA = "por enquanto não precisa me mandar mais nada, depois eu chamo vocês";
const PARAR = "não quero receber mais nada de vocês";
const MEMORIA = { tema: "Frozen", convidados: 50 };

test("limite diário esgotado: equipe em silêncio, sem modelo nem texto fixo, sem inventar pausa; marcas preservadas e com origem", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  assert.equal(pedidoDeParar(PARAFRASE_W22), null, "W22: as regras não reconhecem a paráfrase");
  assert.ok(!pausaPedidaNaRecepcao(PARAFRASE_W22));
  assert.ok(pausaPedidaNaRecepcao(PAUSA), "pausa determinística");
  assert.equal(comandoDireto(PARAR)?.intencao, "PARAR", "PARAR inequívoco");
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  try {
    for (const [up, post] of MIGRATIONS) { await q(up); await q(post); }
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const A = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet sintético (limite em silêncio)', 'PROVISIONAMENTO') RETURNING id`, [cod("ls")]);
    await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [A]);
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness limite', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [A, u]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const sessao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO" } as never;
    const { servico, worker } = carregarAtendimento(A);
    await servico.salvarConfiguracao(sessao, { ativo: true, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 1 }, wallE: { ativo: true } });

    const chamadas = { wallE: 0, modeloLeuPausa: 0, faseB: 0 };
    const porta: PortaWallE = { async responder(e) {
      chamadas.wallE++;
      if (e.texto === PARAFRASE_W22) {
        // Simula o modelo reconhecendo a pausa (W22): o resolvedor devolve silêncio com o resumo de pausa.
        chamadas.modeloLeuPausa++;
        return { saidas: [], contexto: { ...MEMORIA } as never, silencio: true,
          passagem: { motivo: "PARAR_A_CONFIRMAR", motivos: ["PARAR_A_CONFIRMAR"], em: e.agora, coletado: { data: null, turno: null, convidados: 50, pacote: null, unidade: null, tema: "Frozen" }, enviados: [], pendentes: [], ultimaMensagem: e.texto } };
      }
      return { saidas: [{ texto: "Resposta sintética do Wall-e", anexo: null, fontes: [] }], contexto: { ...MEMORIA } as never, passagem: null };
    } };
    const envios: { contato: string; conteudo: ConteudoSaida }[] = [];
    const deps = { interpretar: async () => { chamadas.faseB++; return { intencao: "OUTRO" as const, perguntaId: null, data: null, convidados: null }; },
      enviar: async (contato: string, conteudo: ConteudoSaida) => { envios.push({ contato, conteudo }); return cod("gs-"); }, wallE: porta };
    const receber = (contato: string, texto: string) => servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp: Date.now(), nomePerfil: null });
    const processar = () => worker.processarLote(deps, { maxTarefas: 20 });
    const conversa = async (contato: string) => (await q("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    const textos = (contato: string) => envios.filter((x) => x.contato === contato).map((x) => (x.conteudo.tipo === "TEXTO" ? x.conteudo.texto : x.conteudo.tipo));
    const saidasAutomaticas = async (contato: string) => Number((await q(`SELECT count(*)::int AS n FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas cv ON cv.id = m.conversa_id
      WHERE cv.empresa_id = $1 AND cv.contato = $2 AND m.direcao = 'SAIDA' AND m.autor_usuario_id IS NULL`, [A, contato])).rows[0].n);
    const esgotar = async (contato: string) => {
      await receber(contato, "quanto custa a festa?");
      await processar();
      assert.deepEqual(textos(contato), ["Resposta sintética do Wall-e"], `limite de 1 resposta esgotado para ${contato}`);
    };
    const silencioPorLimite = async (rotulo: string, contato: string) => {
      const cv = await conversa(contato);
      assert.equal(await saidasAutomaticas(contato), 1, `${rotulo}: nenhuma saída automática nova (nem o texto fixo)`);
      assert.deepEqual(textos(contato), ["Resposta sintética do Wall-e"], `${rotulo}: nada enviado depois do limite`);
      assert.equal(cv.estado, "AGUARDANDO_HUMANO", `${rotulo}: com a equipe`);
      assert.deepEqual(cv.passagem?.motivos, ["LIMITE_DIARIO"], `${rotulo}: o resumo diz limite diário, não pausa`);
      return cv;
    };

    // S1 — limite esgotado + paráfrase do W22.
    const s1 = "5561900004001";
    await esgotar(s1);
    const antesS1 = { ...chamadas };
    await receber(s1, PARAFRASE_W22);
    await processar();
    const cv1 = await silencioPorLimite("S1", s1);
    assert.deepEqual(chamadas, antesS1, "S1: nem Wall-e, nem modelo, nem fase B");
    assert.equal(cv1.contexto?.semAutomatico ?? null, null, "S1: nenhuma marca de pausa — a paráfrase não foi classificada");
    assert.deepEqual([cv1.contexto?.tema, cv1.contexto?.convidados], ["Frozen", 50], "S1: memória preservada");

    // S2 — sem limite + paráfrase do W22: o Wall-e reconhece (modelo simulado); marca com origem WALLE.
    const s2 = "5561900004002";
    await receber(s2, PARAFRASE_W22);
    await processar();
    const cv2 = await conversa(s2);
    assert.equal(chamadas.modeloLeuPausa, 1, "S2: o modelo leu a pausa");
    assert.equal(await saidasAutomaticas(s2), 0, "S2: silêncio");
    assert.deepEqual([cv2.estado, cv2.passagem?.motivo, cv2.contexto?.semAutomatico?.motivo, cv2.contexto?.semAutomatico?.origem], ["AGUARDANDO_HUMANO", "PARAR_A_CONFIRMAR", "PARAR_A_CONFIRMAR", "WALLE"], "S2: marca com origem WALLE");

    // S3 — limite esgotado + pausa determinística: a recepção captura (origem RECEPCAO).
    const s3 = "5561900004003";
    await esgotar(s3);
    await receber(s3, PAUSA);
    await processar();
    const cv3 = await conversa(s3);
    assert.equal(await saidasAutomaticas(s3), 1, "S3: nada novo sai");
    assert.deepEqual([cv3.estado, cv3.passagem?.motivo, cv3.contexto?.semAutomatico?.origem], ["AGUARDANDO_HUMANO", "PARAR_A_CONFIRMAR", "RECEPCAO"], "S3: pausa reconhecida, origem RECEPCAO");
    await assert.rejects(servico.controlarAtendimento(sessao, { acao: "retomar", conversaId: cv3.id, versao: Number(cv3.versao) }), /ATENDIMENTO_PAUSA_PEDIDA/, "S3: retomada recusada");

    // S4 — limite esgotado + mensagem comum: silêncio LIMITE_DIARIO, memória preservada, sem marca.
    const s4 = "5561900004004";
    await esgotar(s4);
    await receber(s4, "e qual o endereço de vocês?");
    await processar();
    const cv4 = await silencioPorLimite("S4", s4);
    assert.equal(cv4.contexto?.semAutomatico ?? null, null, "S4: mensagem comum não vira pausa");
    assert.deepEqual([cv4.contexto?.tema, cv4.contexto?.convidados], ["Frozen", 50], "S4: memória preservada");

    // S5 — limite esgotado + PARAR inequívoco: bloqueio definitivo.
    const s5 = "5561900004005";
    await esgotar(s5);
    await receber(s5, PARAR);
    await processar();
    const cv5 = await conversa(s5);
    assert.deepEqual([cv5.nao_contatar, cv5.estado], [true, "ENCERRADA"], "S5: bloqueio definitivo");
    assert.equal(await saidasAutomaticas(s5), 1, "S5: nada depois do PARAR");

    // S6 — a marca já existente (S2) persiste: mensagem nova, encerramento e reabertura; a equipe responde.
    await receber(s2, "oi?");
    await processar();
    let cv6 = await conversa(s2);
    assert.equal(cv6.contexto?.semAutomatico?.origem, "WALLE", "S6: marca intacta após nova mensagem");
    await servico.controlarAtendimento(sessao, { acao: "encerrar", conversaId: cv6.id, versao: Number(cv6.versao) });
    await receber(s2, "voltei");
    await processar();
    cv6 = await conversa(s2);
    assert.deepEqual([cv6.estado, cv6.contexto?.semAutomatico?.origem], ["AGUARDANDO_HUMANO", "WALLE"], "S6: reabertura com a marca intacta");
    await assert.rejects(servico.controlarAtendimento(sessao, { acao: "retomar", conversaId: cv6.id, versao: Number(cv6.versao) }), /ATENDIMENTO_PAUSA_PEDIDA/);
    await servico.controlarAtendimento(sessao, { acao: "assumir", conversaId: cv6.id, versao: Number(cv6.versao) });
    cv6 = await conversa(s2);
    await servico.controlarAtendimento(sessao, { acao: "enviar", conversaId: cv6.id, versao: Number(cv6.versao), texto: "Oi! Equipe sintética." });
    await processar();
    assert.deepEqual(textos(s2), ["Oi! Equipe sintética."], "S6: a equipe responde");
    assert.equal(await saidasAutomaticas(s2), 0, "S6: nada automático");

    // S7 — pausa já enfileirada com o limite esgotado: barreira do worker, origem FILA.
    const s7 = "5561900004007";
    await esgotar(s7);
    await receber(s7, "ok, entendi");
    await q(`UPDATE whatsapp_atendimento_mensagens m SET texto = $3 FROM whatsapp_atendimento_conversas cv
      WHERE cv.id = m.conversa_id AND cv.empresa_id = $1 AND cv.contato = $2 AND m.direcao = 'ENTRADA' AND m.estado = 'PENDENTE'`, [A, s7, PAUSA]);
    await processar();
    const cv7 = await conversa(s7);
    assert.equal(await saidasAutomaticas(s7), 1, "S7: nada novo sai");
    assert.deepEqual([cv7.passagem?.motivo, cv7.contexto?.semAutomatico?.origem], ["PARAR_A_CONFIRMAR", "FILA"], "S7: marca com origem FILA");
    assert.equal(chamadas.faseB, 0, "fase B (modelo) nunca chamada");
  } finally {
    await c.end();
  }
});
