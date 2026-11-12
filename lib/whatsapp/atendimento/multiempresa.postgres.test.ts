import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { carregarComponente } from "../../../components/admin/teste-componente.ts";
import * as credencial from "../credencial.ts";
import * as core from "./core.ts";
import * as configuracaoReal from "./configuracao.ts";
import * as multiempresa from "./multiempresa.ts";
import { carregarAtendimento, cod, db, transporteSemRede, withTransaction } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";
import type { AlvoEnvio } from "./worker.ts";

/**
 * H-ME (E-ME1; plano "Plano Atendimento WhatsApp multiempresa 20261104" r6.1, §8) no PostgreSQL DESCARTÁVEL, modelo 112
 * (sem a 117: a suíte aplica). Recepção, status, tela e worker REAIS; chave WHATSAPP_ATENDIMENTO_MULTIEMPRESA real
 * (process.env); envio pela porta REAL enviarPelaEmpresa com transporte falso (Gupshup e Graph API espionados: nenhuma
 * rede). Dados sintéticos. A = piloto; B, C, D, E, F = outras empresas com estados comerciais diferentes.
 *
 *  3c   chave true SEM a 117: modo efetivo PILOTO (recepção de B confirma sem gravar; tela de B lê e não liga; reserva só
 *       da piloto); status duplicado entre A e B: correlação legada + contagem, sem consultar a tabela ausente;
 *  117  precheck, aplicação, postcheck, rollback (down) e reaplicação;
 *  6    chave ausente / "false" / inválida = PILOTO; "true" com a 117 = MULTI;
 *  8    direito comercial (§2.3): isenção SIM, teste SIM, legado NÃO, nenhuma informação NÃO;
 *  1    recepção MULTI: B (isenta, conectada, ligada) grava PENDENTE; D (legado) e E (sem informação) confirmam sem gravar;
 *       C (teste, SEM conexão) não liga a automação pela recepção;
 *  2    tela: sessão de B só vê B; ids de A pela sessão de B: não encontrado; ação de D: recurso não incluído;
 *  3    rodízio: a cabeça de B é reservada em ≤ 1 + K reservas com backlog de A; `ordem` só muda na reserva;
 *  4a   F revogada (conexão desconectada) antes da reserva: nada reservado, transporte com 0 chamadas para F;
 *  6/E  envio: A pelo canal da piloto (Gupshup), B só pela conexão Meta de B (Graph do número de B), nunca Gupshup;
 *  1b   mesmo identificador em saídas de A e B: nada aplicado, marca de colisão gravada, nada no buffer;
 *  1e   marca vigente: callback tardio não aplica nem depois que só resta uma saída;
 *  5c   número de A passa a outra dona: o status da saída de A continua indo para A;
 *  1g   PILOTO com a 117: a marca é consultada e gravada também;
 *  5d   status depois de voltar ao PILOTO: a saída da empresa não piloto é atualizada;
 *  1f   marca com mais de 30 dias é apagada pela rotina em lote.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP = ler("database/migrations/20261104_117_atendimento_multiempresa.sql");
const PRE = ler("database/checks/20261104_117_precheck.sql");
const POS = ler("database/checks/20261104_117_postcheck.sql");
const DOWN = ler("database/rollback/20261104_117_atendimento_multiempresa_down.sql");
const SEGREDO = Buffer.alloc(32, 7).toString("base64");
Object.assign(process.env, { WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: SEGREDO, WHATSAPP_CREDENTIAL_KEY_VERSION: "1", META_GRAPH_API_VERSION: "v23.0" });
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const APP = "1622943079270352", NEGOCIO = "1591095999057604";
const CHAVE = "WHATSAPP_ATENDIMENTO_MULTIEMPRESA";
const chave = (valor: string | undefined) => { if (valor === undefined) delete process.env[CHAVE]; else process.env[CHAVE] = valor; };

test("H-ME: atendimento multiempresa (modo, direito, recepção, tela, rodízio, envio e status)", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  // Executor novo por leitura (o catálogo da E-ME1 r2 é memorizado por executor = por transação).
  const cx = () => ({ query: (sql: string, v: readonly unknown[] = []) => c.query(sql, [...v]) }) as never;
  try {
    assert.ok((await q("SELECT to_regclass('public.whatsapp_conexoes') IS NOT NULL AND to_regclass('public.assinatura_isencoes') IS NOT NULL AND to_regclass('public.whatsapp_atendimento_controles_contato') IS NOT NULL AS ok")).rows[0].ok, "modelo com 060–083 e 074a");
    assert.equal((await q("SELECT to_regclass('public.whatsapp_atendimento_rodizio') AS r")).rows[0].r, null, "modelo sem a 117");
    const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
    const empresa = async (rotulo: string) => {
      const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("me"), `Buffet sintético ${rotulo} (multiempresa)`]);
      await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
      return e;
    };
    const [A, B, C, D, E, F] = [await empresa("A piloto"), await empresa("B isenta"), await empresa("C teste"), await empresa("D legado"), await empresa("E sem informação"), await empresa("F revogada")];
    const nomes = new Map([[A, "A"], [B, "B"], [C, "C"], [D, "D"], [E, "E"], [F, "F"]]);
    const sessao = async (e: string, papel = "REPRESENTANTE_AUTORIZADO") => {
      const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness multiempresa', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, papel]);
      const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [e, u, papel]);
      await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
      const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
        VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), e]);
      return { usuario_id: u, papel, id: s, empresa_ativa_id: e, autenticado_em: new Date().toISOString() } as never as { usuario_id: string };
    };
    const sA = await sessao(A), sB = await sessao(B), sC = await sessao(C), sD = await sessao(D), sF = await sessao(F);
    const autor = (sA as { usuario_id: string }).usuario_id;
    const numero = (e: string) => `30000000${[A, B, C, D, E, F].indexOf(e) + 1}`.padEnd(10, "0");
    const waba = (e: string) => `20000000${[A, B, C, D, E, F].indexOf(e) + 1}`.padEnd(10, "0");
    const conectar = async (empresaId: string) => {
      const cifra = credencial.cifrarCredencialWhatsapp(`token-sintetico-${numero(empresaId)}`, { ambiente: "STAGING", appId: APP, businessId: NEGOCIO, wabaId: waba(empresaId), phoneNumberId: numero(empresaId), empresaId });
      return id(`WITH instante AS (SELECT clock_timestamp() AS agora)
        INSERT INTO whatsapp_conexoes(ambiente,empresa_id,meta_app_id,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,coexistencia_confirmada,status,escopos,credencial_cifrada,credencial_iv,credencial_tag,credencial_chave_versao,token_tipo,token_expira_em,meta_validada_em,criada_por_usuario_id,sessao_referencia_id,criada_em,atualizada_em)
        SELECT 'STAGING',$1::uuid,$2,$3,$4,$5,'+55 61 90000-0000','Buffet sintético',true,'CONFIGURADA',ARRAY['whatsapp_business_messaging'],$6,$7,$8,$9,'bearer',NULL,agora,$10::uuid,$11::uuid,agora,agora FROM instante RETURNING id`,
        [empresaId, APP, NEGOCIO, waba(empresaId), numero(empresaId), cifra.ciphertext, cifra.iv, cifra.tag, cifra.keyVersion, autor, randomUUID()]);
    };
    const conexoes = new Map<string, string>();
    for (const e of [A, B, D, E, F]) conexoes.set(e, await conectar(e));
    // Situação comercial (§2.3): B e F isentas; C em teste grátis; D com assinatura sem contrato confirmado (legado); E nada.
    let doc = 10;
    for (const e of [B, F]) await q(`INSERT INTO assinatura_isencoes (empresa_id, documento_verificado, motivo, concedida_por) VALUES ($1, $2, 'Isenção sintética do harness', $3)`, [e, `${String(doc++).padStart(12, "0")}00`, autor]);
    await q(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim) VALUES ($1, 'TESTE', clock_timestamp() - interval '2 days', clock_timestamp() + interval '28 days')`, [C]);
    // Fixture do legado (assinatura ATIVA sem contrato confirmado): gravada com os gatilhos de guarda desligados SÓ nesta
    // sessão do cluster descartável (a 068 exige nascer em TESTE); os CHECKs continuam valendo.
    await q("SET session_replication_role = replica");
    await q(`INSERT INTO empresa_assinaturas (empresa_id, situacao, ciclo, periodo_atual_fim, teste_inicio, teste_fim) VALUES ($1, 'ATIVA', 'MENSAL', clock_timestamp() + interval '20 days', clock_timestamp() - interval '60 days', clock_timestamp() - interval '30 days')`, [D]);
    await q("RESET session_replication_role");

    const { servico, worker } = carregarAtendimento(A);
    const configuracao = { ...configuracaoReal, ambienteAtendimento: () => "staging", empresaPiloto: () => A };
    const meta = carregarComponente("lib/whatsapp/atendimento/meta.ts", {
      "../../db/postgres.ts": { db, withTransaction }, "../credencial.ts": credencial, "./configuracao.ts": configuracao, "./core.ts": core, "./service.ts": servico, "./transporte.ts": transporteSemRede, "./multiempresa.ts": multiempresa,
    }).modulo as typeof import("./meta.ts");

    // Transporte falso: Gupshup e Graph API espionados (nenhuma rede).
    const gupshup: string[] = [], graph: string[] = [], alvos: { empresa: string; piloto: boolean }[] = [];
    const buscar = (async (url: string) => { graph.push(String(url)); return new Response(JSON.stringify({ messages: [{ id: cod("wamid.") }] }), { status: 200 }); }) as unknown as typeof fetch;
    const deps = {
      interpretar: null,
      enviar: (contato: string, conteudo: ConteudoSaida, alvo?: AlvoEnvio) => {
        alvos.push({ empresa: nomes.get(alvo!.empresaId) ?? "?", piloto: alvo!.piloto });
        return meta.enviarPelaEmpresa(contato, conteudo, { alvo, buscar, gupshup: async (contatoG) => { gupshup.push(contatoG); return cod("gs-"); } });
      },
    };
    const entrada = (e: string, contato: string, texto = "Oi, quero orçamento") => ({ phoneNumberId: numero(e), wabaId: waba(e), id: cod("wamid.in."), contato, texto, timestamp: Date.now(), nomePerfil: "Cliente Sintético" });
    const status = (e: string, provedorId: string, tipo: "delivered" | "read" | "failed" = "delivered") => ({ phoneNumberId: numero(e), wabaId: waba(e), id: provedorId, tipo });
    const receber = (...lista: ReturnType<typeof entrada>[]) => meta.receberEventosMeta({ entradas: lista, status: [] }, { automacaoGlobal: true });
    const statusDe = (...lista: ReturnType<typeof status>[]) => meta.receberEventosMeta({ entradas: [], status: lista }, { automacaoGlobal: true });
    const conta = async (sql: string, v: unknown[] = []) => Number((await q(sql, v)).rows[0].n);
    const entradasDe = (e: string) => conta("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE empresa_id=$1 AND direcao='ENTRADA'", [e]);
    const pendentesDe = (e: string) => conta("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE empresa_id=$1 AND estado='PENDENTE'", [e]);
    const saida = async (e: string, provedorId: string, estado = "SUBMETIDA") => {
      const conversa = (await q(`INSERT INTO whatsapp_atendimento_conversas(empresa_id,ambiente,contato,ultima_entrada_em,estado) VALUES($1,'staging',$2,clock_timestamp(),'AGUARDANDO_HUMANO') RETURNING id,versao`, [e, `55619${randomBytes(4).readUInt32BE() % 100000000}`.padEnd(13, "0")])).rows[0];
      return id(`INSERT INTO whatsapp_atendimento_mensagens(conversa_id,empresa_id,ambiente,direcao,texto,estado,versao_conversa,autor_usuario_id,provedor_id) VALUES($1,$2,'staging','SAIDA','Resposta sintética',$3,$4,$5,$6) RETURNING id`, [conversa.id, e, estado, conversa.versao, autor, provedorId]);
    };
    const estadoDe = async (mensagemId: string) => (await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE id=$1", [mensagemId])).rows[0].estado as string;
    const buffer = (provedorId: string) => conta("SELECT count(*) AS n FROM whatsapp_atendimento_status WHERE provedor_id=$1", [provedorId]);
    const config = (ativo: boolean) => ({ ativo, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 20 } });

    // ——— 3c: chave true SEM a 117 ———
    chave("true");
    assert.equal(await multiempresa.modoEfetivo(cx()), "PILOTO", "3c: sem as tabelas o modo efetivo é PILOTO");
    await servico.salvarConfiguracao(sA as never, config(true));
    await assert.rejects(servico.salvarConfiguracao(sB as never, config(true)), /ATENDIMENTO_RECURSO_NAO_INCLUIDO/, "3c: B não liga no PILOTO efetivo");
    assert.deepEqual((await servico.listarAtendimento(sB as never)).conversas, [], "3c: B lê a própria tela");
    await receber(entrada(A, "5561900010001"), entrada(B, "5561900010002"));
    assert.deepEqual([await entradasDe(A), await entradasDe(B)], [1, 0], "3c: piloto grava; B confirma sem gravar");
    const dup0A = await saida(A, "wamid.DUP0"), dup0B = await saida(B, "wamid.DUP0");
    await statusDe(status(A, "wamid.DUP0", "failed"));
    assert.deepEqual([await estadoDe(dup0A), await estadoDe(dup0B), await buffer("wamid.DUP0")], ["SUBMETIDA", "SUBMETIDA", 0], "3c-col: duplicado sem a tabela de colisões: nada aplicado, nada no buffer, nenhum erro");
    await servico.limparStatusExpirados();
    const loteSem117 = await worker.processarLote(deps, { maxTarefas: 10 });
    assert.ok(loteSem117.tarefas >= 1, "3c: a piloto é processada");
    assert.ok(alvos.every((x) => x.empresa === "A" && x.piloto), "3c: só a piloto é reservada/enviada");

    // ——— 117: precheck, aplicação, postcheck, rollback, reaplicação ———
    await q(PRE);
    await q(UP);
    await q(POS);
    await assert.rejects(q(UP), /117 já \(parcialmente\) presente/, "117: reaplicação recusada");
    await q("ROLLBACK").catch(() => {});
    await assert.rejects(q(PRE), /117 já \(parcialmente\) presente/);
    await q("ROLLBACK").catch(() => {});
    await q(DOWN);
    assert.equal((await q("SELECT to_regclass('public.whatsapp_atendimento_rodizio') AS r")).rows[0].r, null, "117: down remove");
    await q(PRE);
    await q(UP);
    await q(POS);

    // ——— 6: chave ———
    for (const [valor, esperado] of [[undefined, "PILOTO"], ["false", "PILOTO"], ["TRUE", "PILOTO"], ["1", "PILOTO"], ["true", "MULTI"]] as const) {
      chave(valor);
      assert.equal(await multiempresa.modoEfetivo(cx()), esperado, `6: chave ${String(valor)}`);
    }

    // ——— 8: direito comercial (§2.3) ———
    const direito = async (e: string) => multiempresa.situacaoDireitoAtendimento(cx(), e);
    assert.deepEqual([await direito(B), await direito(C), await direito(D), await direito(E)], ["ISENCAO", "TESTE", "LEGADO", "SEM_INFORMACAO"], "8: situação na ordem fixa");
    assert.deepEqual([await multiempresa.direitoAtendimentoWhatsApp(cx(), B), await multiempresa.direitoAtendimentoWhatsApp(cx(), C), await multiempresa.direitoAtendimentoWhatsApp(cx(), D), await multiempresa.direitoAtendimentoWhatsApp(cx(), E)], [true, true, false, false], "8: D-ME-1");

    // ——— 1: recepção MULTI ———
    await servico.salvarConfiguracao(sB as never, config(true));
    // F4 (E-ME1 r2, mudança declarada): C (teste, SEM conexão) configura desligada antes de conectar, mas não liga sem C2.
    await assert.rejects(servico.salvarConfiguracao(sC as never, config(true)), /ATENDIMENTO_RECURSO_NAO_INCLUIDO/, "F4: ligar exige C2");
    await servico.salvarConfiguracao(sC as never, config(false));
    await assert.rejects(servico.salvarConfiguracao(sD as never, config(true)), /ATENDIMENTO_RECURSO_NAO_INCLUIDO/, "1: legado não liga");
    await servico.salvarConfiguracao(sD as never, config(false));
    await servico.salvarConfiguracao(sF as never, config(true));
    await receber(entrada(B, "5561900020001"), entrada(D, "5561900020002"), entrada(E, "5561900020003"));
    assert.deepEqual([await entradasDe(B), await entradasDe(D), await entradasDe(E)], [1, 0, 0], "1: B grava; D (legado) e E (sem informação) confirmam sem gravar");
    assert.equal((await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE empresa_id=$1 AND direcao='ENTRADA'", [B])).rows[0].estado, "PENDENTE", "1: B ligada → PENDENTE");
    assert.equal(await entradasDe(C), 0, "1: C sem número conectado não recebe");

    // ——— 2: tela por empresa ———
    const telaB = await servico.listarAtendimento(sB as never);
    assert.deepEqual([...new Set(telaB.conversas.map((x) => x.empresa_id))], [B], "2: B só vê B");
    assert.equal(telaB.conversas.length, await conta("SELECT count(*) AS n FROM whatsapp_atendimento_conversas WHERE empresa_id=$1", [B]), "2: todas as de B");
    assert.equal(telaB.automacaoDisponivel, true, "2: B opera");
    const conversaDeA = (await q("SELECT id, versao FROM whatsapp_atendimento_conversas WHERE empresa_id=$1 LIMIT 1", [A])).rows[0];
    await assert.rejects(servico.controlarAtendimento(sB as never, { acao: "assumir", conversaId: conversaDeA.id, versao: Number(conversaDeA.versao) }), /ATENDIMENTO_NAO_ENCONTRADO/, "2: id de A pela sessão de B");
    assert.equal((await servico.listarAtendimento(sD as never)).automacaoDisponivel, false, "2: D vê a automação indisponível");

    // ——— 4a: F revogada (conexão desconectada) depois da recepção e antes da reserva ———
    await receber(entrada(F, "5561900030001"));
    assert.equal(await pendentesDe(F), 1);
    await q(`UPDATE whatsapp_conexoes SET status='DESCONECTADA',desconectada_em=clock_timestamp(),desconectada_por_usuario_id=$2,motivo_desconexao='revogação sintética',revisao=revisao+1,atualizada_em=clock_timestamp() WHERE id=$1`, [conexoes.get(F), autor]);

    // ——— 3: rodízio com backlog de A ———
    await receber(entrada(A, "5561900040001"), entrada(A, "5561900040002"), entrada(A, "5561900040003"), entrada(A, "5561900040004"));
    const ordem: string[] = [];
    const reservaDe = async () => {
      const antes = new Map((await q("SELECT id, empresa_id FROM whatsapp_atendimento_mensagens WHERE estado='PENDENTE'")).rows.map((r) => [r.id, r.empresa_id]));
      const r = await worker.processarAtendimento(deps);
      const agora = new Set((await q("SELECT id FROM whatsapp_atendimento_mensagens WHERE estado='PENDENTE'")).rows.map((x) => x.id));
      const tratada = [...antes.keys()].find((k) => !agora.has(k));
      if (tratada) ordem.push(nomes.get(antes.get(tratada)!)!);
      return r;
    };
    await reservaDe();
    await reservaDe();
    assert.ok(ordem.slice(0, 2).includes("B"), `3: B reservada em ≤ 1 + K reservas (ordem ${ordem.join(",")})`);
    const rodizio = (await q("SELECT empresa_id, ordem FROM whatsapp_atendimento_rodizio WHERE ambiente='staging' ORDER BY ordem")).rows;
    assert.deepEqual(rodizio.map((r) => nomes.get(r.empresa_id)).sort(), ["A", "B"], "3: `ordem` gravada só para quem foi reservada");
    for (let i = 0; i < 30 && (await worker.processarAtendimento(deps)) !== "SEM_TAREFA"; i++);
    assert.equal(await pendentesDe(F), 1, "4a: F revogada não é reservada");
    assert.ok(!alvos.some((x) => x.empresa === "F"), "4a: transporte com 0 chamadas para F");
    assert.ok(alvos.some((x) => x.empresa === "B" && !x.piloto), "E: B enviada com a identidade de B");
    const grafoDeB = graph.filter((u) => u.includes(`/${numero(B)}/messages`)).length;
    assert.equal(grafoDeB, alvos.filter((x) => x.empresa === "B").length, "E: cada envio de B vai ao número de B na Graph API");
    assert.ok(graph.every((u) => u.includes(`/${numero(B)}/`)), "E: nenhuma chamada Graph a outro número");
    assert.equal(gupshup.length, alvos.filter((x) => x.empresa === "A").length, "E: só a piloto usa o Gupshup");

    // ——— 1b / 1e: identificador duplicado entre A e B ———
    const dup1A = await saida(A, "wamid.DUP1"), dup1B = await saida(B, "wamid.DUP1");
    const anomaliasAntes = multiempresa.contadorAnomaliasStatus();
    await statusDe(status(A, "wamid.DUP1", "delivered"));
    assert.deepEqual([await estadoDe(dup1A), await estadoDe(dup1B), await buffer("wamid.DUP1")], ["SUBMETIDA", "SUBMETIDA", 0], "1b: nada aplicado nem guardado");
    assert.equal(await conta("SELECT count(*) AS n FROM whatsapp_atendimento_status_colisoes WHERE provedor_id='wamid.DUP1'"), 1, "1b: marca de colisão");
    assert.ok(multiempresa.contadorAnomaliasStatus() > anomaliasAntes, "1b: contador de anomalia");
    await q("DELETE FROM whatsapp_atendimento_mensagens WHERE id=$1", [dup1A]);
    await statusDe(status(B, "wamid.DUP1", "delivered"));
    assert.equal(await estadoDe(dup1B), "SUBMETIDA", "1e: marca vigente impede a aplicação mesmo com uma saída só");

    // ——— 5c: número de A passa a outra dona; o status da saída de A continua indo para A ———
    const s5c = await saida(A, "wamid.5C");
    await statusDe(status(B, "wamid.5C", "delivered"));
    assert.deepEqual([await estadoDe(s5c), await conta("SELECT count(*) AS n FROM whatsapp_atendimento_status WHERE empresa_id=$1 AND provedor_id='wamid.5C'", [B])], ["ENTREGUE", 0], "5c: saída de A atualizada; nada em B");

    // ——— 5a: status antecipado (sem saída ainda) vai para o buffer da dona atual do número ———
    await statusDe(status(B, "wamid.ANTECIPADO", "delivered"));
    assert.equal(await conta("SELECT count(*) AS n FROM whatsapp_atendimento_status WHERE empresa_id=$1 AND provedor_id='wamid.ANTECIPADO'", [B]), 1, "5a: buffer da dona atual");

    // ——— 1g / 5d: de volta ao PILOTO, com a 117 presente ———
    chave(undefined);
    assert.equal(await multiempresa.modoEfetivo(cx()), "PILOTO");
    const dup2A = await saida(A, "wamid.DUP2"), dup2B = await saida(B, "wamid.DUP2");
    await statusDe(status(A, "wamid.DUP2", "delivered"));
    assert.deepEqual([await estadoDe(dup2A), await estadoDe(dup2B), await conta("SELECT count(*) AS n FROM whatsapp_atendimento_status_colisoes WHERE provedor_id='wamid.DUP2'")], ["SUBMETIDA", "SUBMETIDA", 1], "1g: marca gravada no PILOTO");
    const s5d = await saida(B, "wamid.5D");
    await statusDe(status(B, "wamid.5D", "read"));
    assert.equal(await estadoDe(s5d), "ENTREGUE", "5d: saída da não piloto atualizada depois do rollback para PILOTO");
    await receber(entrada(B, "5561900050001"));
    assert.equal(await entradasDe(B), 1, "PILOTO: B volta a confirmar sem gravar");

    // ——— 1f: marca vencida é apagada pela rotina ———
    await q("UPDATE whatsapp_atendimento_status_colisoes SET detectada_em = clock_timestamp() - interval '31 days' WHERE provedor_id='wamid.DUP1'");
    await servico.limparStatusExpirados();
    assert.equal(await conta("SELECT count(*) AS n FROM whatsapp_atendimento_status_colisoes WHERE provedor_id='wamid.DUP1'"), 0, "1f: marca de 31 dias apagada");
    assert.equal(await conta("SELECT count(*) AS n FROM whatsapp_atendimento_status_colisoes WHERE provedor_id='wamid.DUP2'"), 1, "1f: marca recente fica");
    await statusDe(status(B, "wamid.DUP1", "delivered"));
    assert.equal(await estadoDe(dup1B), "ENTREGUE", "1f: risco residual documentado — sem marca e com uma saída só, aplica");
  } finally {
    chave(undefined);
    await c.end();
  }
});
