import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../../db/contracts.ts";
import { carregarAtendimento, cod, db } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";
import type { PortaWallE } from "./worker.ts";
import { comandoDireto, pausaPedidaNaRecepcao } from "./core.ts";
import { pedidoDeParar } from "./opt-out.ts";
import { lerContexto } from "./walle/contexto.ts";
import { entenderPorRegras } from "./walle/entendimento.ts";
import { catalogosWallE, fontesPostgres } from "./walle/fontes-postgres.ts";
import { resolverWallE } from "./walle/resolver.ts";

/**
 * Correção P1 da revisão da candidata final (pausa × limite diário). Worker e recepção REAIS no PostgreSQL descartável
 * (modelo "atual" + 060/077a/077b/078), só pelo check:v1:postgres, com opt-in. Dados e contatos sintéticos; transporte
 * simulado (nenhuma rede); nenhum modelo. A porta do Wall-e usa as REGRAS e o RESOLVEDOR reais para os pedidos de parar
 * (o caminho que o Wall-e real segue) e uma resposta sintética fixa para o resto (para esgotar o limite).
 *
 *  L1 limite diário ESGOTADO + pausa: nada sai (nem o texto fixo); equipe com PARAR_A_CONFIRMAR; marca persistida;
 *     "Devolver ao Wall-e" recusado; mensagem posterior e reabertura não removem a pausa; atendimento humano continua;
 *  L2 pausa sem limite (silêncio do Wall-e): o mesmo resultado;
 *  L3 pausa com o Wall-e DESLIGADO (fase B) e L4 pausa com o Wall-e FALHANDO: os caminhos fixos não perdem a pausa;
 *  L5 controle — mensagem comum com o limite esgotado: equipe em silêncio (LIMITE_DIARIO; desde o M1, sem o texto fixo),
 *     sem marca de pausa;
 *  L6 controle — PARAR inequívoco (com o limite esgotado): bloqueio definitivo, nada sai;
 *  L7 barreira do worker — pausa já enfileirada (recepção anterior à correção) com o limite esgotado: silêncio e marca.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const MIGRATIONS = [
  ["database/migrations/20261001_060_whatsapp_atendimento.sql", "database/checks/20261001_060_postcheck.sql"],
  ["database/migrations/20261009_077a_whatsapp_mensagens_prontas.sql", "database/checks/20261009_077a_postcheck.sql"],
  ["database/migrations/20261009_077b_whatsapp_prontas_midia.sql", "database/checks/20261009_077b_postcheck.sql"],
  ["database/migrations/20261009_078_wall_e_atendimento.sql", "database/checks/20261009_078_postcheck.sql"],
].map(([up, post]) => [ler(up), ler(post)]);
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const PAUSA = "por enquanto não precisa me mandar mais nada, depois eu chamo vocês";
const PARAR = "não quero receber mais nada de vocês";

test("pausa reconhecida pelas regras vence o limite diário e os caminhos fixos; nada é enviado e a marca persiste", { timeout: 300_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  assert.equal(pedidoDeParar(PAUSA)?.tipo, "AMBIGUO", "o texto é pausa pelas regras (opt-out ambíguo)");
  assert.ok(pausaPedidaNaRecepcao(PAUSA)); assert.notEqual(comandoDireto(PAUSA)?.intencao, "PARAR");
  assert.equal(comandoDireto(PARAR)?.intencao, "PARAR");
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  try {
    for (const [up, post] of MIGRATIONS) { await q(up); await q(post); }
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const A = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet sintético (pausa × limite)', 'PROVISIONAMENTO') RETURNING id`, [cod("pl")]);
    await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [A]);
    const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness pausa', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`, [`${cod("u")}@example.test`, SENHA]);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [A, u]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const sessao = { usuario_id: u, papel: "REPRESENTANTE_AUTORIZADO" } as never;
    const { servico, worker } = carregarAtendimento(A);
    const configurar = (wallE: boolean) => servico.salvarConfiguracao(sessao, { ativo: true, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 1 }, wallE: { ativo: wallE } });
    await configurar(true);

    const chamadas = { wallE: 0, modelo: 0 };
    let falharWallE = false;
    const porta: PortaWallE = { async responder(e) {
      chamadas.wallE++;
      if (falharWallE) throw new Error("falha simulada do Wall-e");
      if (pedidoDeParar(e.texto)) {
        // Pedido de parar: o caminho REAL do Wall-e (regras + resolvedor), como em produção no modo regras.
        const ex = db() as unknown as DbExecutor;
        const catalogos = await catalogosWallE(ex, e.empresa, e.config, e.hoje);
        const contexto = lerContexto(e.contexto);
        return resolverWallE({ texto: e.texto, entendimento: entenderPorRegras(e.texto, catalogos, contexto), contexto, config: e.config, catalogos, agora: e.agora },
          fontesPostgres(ex, { empresaId: e.empresa, ambiente: e.ambiente, hoje: e.hoje, linkContratoProprio: async () => null }));
      }
      return { saidas: [{ texto: "Resposta sintética do Wall-e", anexo: null, fontes: [] }], contexto: {} as never, passagem: null };
    } };
    const envios: { contato: string; conteudo: ConteudoSaida }[] = [];
    const deps = { interpretar: async () => { chamadas.modelo++; return { intencao: "OUTRO" as const, perguntaId: null, data: null, convidados: null }; },
      enviar: async (contato: string, conteudo: ConteudoSaida) => { envios.push({ contato, conteudo }); return cod("gs-"); }, wallE: porta };
    const receber = (contato: string, texto: string) => servico.receberEntrada({ id: cod("evt-"), app: "KidmaisManager", source: contato, texto, timestamp: Date.now(), nomePerfil: null });
    const processar = () => worker.processarLote(deps, { maxTarefas: 20 });
    const conversa = async (contato: string) => (await q("SELECT * FROM whatsapp_atendimento_conversas WHERE empresa_id = $1 AND contato = $2", [A, contato])).rows[0];
    const textos = (contato: string) => envios.filter((x) => x.contato === contato).map((x) => (x.conteudo.tipo === "TEXTO" ? x.conteudo.texto : x.conteudo.tipo));
    const saidasAutomaticas = async (contato: string) => Number((await q(`SELECT count(*)::int AS n FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas cv ON cv.id = m.conversa_id
      WHERE cv.empresa_id = $1 AND cv.contato = $2 AND m.direcao = 'SAIDA' AND m.autor_usuario_id IS NULL`, [A, contato])).rows[0].n);
    const pausada = async (rotulo: string, contato: string) => {
      const cv = await conversa(contato);
      assert.equal(cv.estado, "AGUARDANDO_HUMANO", `${rotulo}: conversa com a equipe`);
      assert.equal(cv.nao_contatar, false, `${rotulo}: pausa não é bloqueio definitivo`);
      assert.equal(cv.passagem?.motivo, "PARAR_A_CONFIRMAR", `${rotulo}: motivo de pausa no resumo`);
      assert.equal(cv.contexto?.semAutomatico?.motivo, "PARAR_A_CONFIRMAR", `${rotulo}: marca semAutomatico persistida`);
      await assert.rejects(servico.controlarAtendimento(sessao, { acao: "retomar", conversaId: cv.id, versao: Number(cv.versao) }), /ATENDIMENTO_PAUSA_PEDIDA/, `${rotulo}: Devolver ao Wall-e recusado`);
      return cv;
    };
    const esgotar = async (contato: string) => {
      await receber(contato, "quanto custa a festa?");
      await processar();
      assert.deepEqual(textos(contato), ["Resposta sintética do Wall-e"], `limite de 1 resposta esgotado para ${contato}`);
    };

    // L1 — limite esgotado + pausa.
    const l1 = "5561900003001";
    await esgotar(l1);
    const wallEAntes = chamadas.wallE;
    await receber(l1, PAUSA);
    await processar();
    assert.equal(await saidasAutomaticas(l1), 1, "L1: nenhuma saída automática nova (nem o texto fixo de encaminhamento)");
    assert.deepEqual(textos(l1), ["Resposta sintética do Wall-e"], "L1: nada enviado depois da pausa");
    await pausada("L1", l1);
    assert.equal(chamadas.wallE, wallEAntes, "L1: pausa reconhecida pelas regras, sem Wall-e nem modelo");
    // Mensagem posterior: segue com a equipe, a marca continua, nada sai.
    await receber(l1, "oi, tudo bem?");
    await processar();
    assert.equal(await saidasAutomaticas(l1), 1, "L1: mensagem posterior sem resposta automática");
    await pausada("L1 depois de nova mensagem", l1);
    // Reabertura: encerrar e o cliente escreve de novo.
    let cv1 = await conversa(l1);
    await servico.controlarAtendimento(sessao, { acao: "encerrar", conversaId: cv1.id, versao: Number(cv1.versao) });
    await receber(l1, "voltei, alguém aí?");
    await processar();
    assert.equal(await saidasAutomaticas(l1), 1, "L1: reabertura sem resposta automática");
    await pausada("L1 depois da reabertura", l1);
    // Atendimento humano continua permitido.
    cv1 = await conversa(l1);
    await servico.controlarAtendimento(sessao, { acao: "assumir", conversaId: cv1.id, versao: Number(cv1.versao) });
    cv1 = await conversa(l1);
    await servico.controlarAtendimento(sessao, { acao: "enviar", conversaId: cv1.id, versao: Number(cv1.versao), texto: "Oi! Aqui é da equipe (sintético)." });
    await processar();
    assert.deepEqual(textos(l1), ["Resposta sintética do Wall-e", "Oi! Aqui é da equipe (sintético)."], "L1: resposta humana enviada");
    assert.equal((await conversa(l1)).contexto?.semAutomatico?.motivo, "PARAR_A_CONFIRMAR", "L1: a marca continua com a equipe atendendo");

    // L2 — pausa sem limite: silêncio.
    const l2 = "5561900003002";
    await receber(l2, PAUSA);
    await processar();
    assert.equal(await saidasAutomaticas(l2), 0, "L2: silêncio"); assert.deepEqual(textos(l2), []);
    await pausada("L2", l2);

    // L3 — pausa com o Wall-e desligado (fase B): o caminho fixo não perde a pausa.
    await configurar(false);
    const l3 = "5561900003003";
    await receber(l3, PAUSA);
    await processar();
    assert.equal(await saidasAutomaticas(l3), 0, "L3: fase B sem resposta (nem o texto de atendente)"); assert.deepEqual(textos(l3), []);
    await pausada("L3", l3);
    assert.equal(chamadas.modelo, 0, "L3: modelo não chamado");
    await configurar(true);

    // L4 — pausa com o Wall-e falhando: o encaminhamento fixo não perde a pausa.
    falharWallE = true;
    const l4 = "5561900003004";
    await receber(l4, PAUSA);
    await processar();
    falharWallE = false;
    assert.equal(await saidasAutomaticas(l4), 0, "L4: sem texto fixo de encaminhamento"); assert.deepEqual(textos(l4), []);
    await pausada("L4", l4);

    // L7 — barreira do worker: entrada de pausa que JÁ estava na fila (enfileirada por uma recepção anterior à correção),
    // com o limite esgotado: o worker reconhece a pausa antes do limite; nada sai e a marca é gravada.
    const l7 = "5561900003007";
    await esgotar(l7);
    await receber(l7, "ok, entendi");
    await q(`UPDATE whatsapp_atendimento_mensagens m SET texto = $3 FROM whatsapp_atendimento_conversas cv
      WHERE cv.id = m.conversa_id AND cv.empresa_id = $1 AND cv.contato = $2 AND m.direcao = 'ENTRADA' AND m.estado = 'PENDENTE'`, [A, l7, PAUSA]);
    const wallEAntesL7 = chamadas.wallE;
    await processar();
    assert.equal(await saidasAutomaticas(l7), 1, "L7: nada novo sai (nem o texto fixo)");
    await pausada("L7", l7);
    assert.equal(chamadas.wallE, wallEAntesL7, "L7: sem Wall-e nem modelo");

    // L5 — controle: mensagem comum com o limite esgotado ⇒ equipe em silêncio, sem marca de pausa. Diferença intencional
    // do M1: antes desta correção saía o texto fixo de encaminhamento (MENSAGEM_ENCAMINHAMENTO).
    const l5 = "5561900003005";
    await esgotar(l5);
    await receber(l5, "e qual o endereço?");
    await processar();
    assert.deepEqual(textos(l5), ["Resposta sintética do Wall-e"], "L5: nada sai depois do limite (nem o texto fixo)");
    const cv5 = await conversa(l5);
    assert.equal(cv5.estado, "AGUARDANDO_HUMANO"); assert.equal(cv5.contexto?.semAutomatico ?? null, null, "L5: mensagem comum não vira pausa");
    assert.deepEqual(cv5.passagem?.motivos, ["LIMITE_DIARIO"], "L5: o resumo diz limite diário");

    // L6 — controle: PARAR inequívoco com o limite esgotado ⇒ bloqueio definitivo, nada sai.
    const l6 = "5561900003006";
    await esgotar(l6);
    await receber(l6, PARAR);
    await processar();
    const cv6 = await conversa(l6);
    assert.equal(cv6.nao_contatar, true, "L6: bloqueio definitivo"); assert.equal(cv6.estado, "ENCERRADA");
    assert.deepEqual(textos(l6), ["Resposta sintética do Wall-e"], "L6: nada depois do PARAR");
    await assert.rejects(servico.controlarAtendimento(sessao, { acao: "assumir", conversaId: cv6.id, versao: Number(cv6.versao) }), /ATENDIMENTO_CONTATO_BLOQUEADO/, "L6: equipe também não contata");
    assert.equal(chamadas.modelo, 0, "nenhuma chamada de modelo em todo o roteiro");
  } finally {
    await c.end();
  }
});
