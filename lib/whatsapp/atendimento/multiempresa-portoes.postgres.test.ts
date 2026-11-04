import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { MENSAGEM_ENCAMINHAMENTO, type Interpretacao } from "./core.ts";
import * as configuracaoReal from "./configuracao.ts";
import * as multiempresa from "./multiempresa.ts";
import { adiado, noPrazo } from "./harness-postgres.ts";
import { barreira, carregarMultiempresa, cod, comGancho, falhaUmaVez, fixturesMultiempresa, flags, semGanchos, SENHA, type Origem } from "./harness-multiempresa.ts";
import type { AlvoEnvio, DependenciasWorker } from "./worker.ts";

/**
 * E-ME1 r2 — portões nos pontos reais do worker, transitórios reais, status e escopos (§2.2, §2.4, §5, §7, §8) no PostgreSQL
 * DESCARTÁVEL (modelo 112; a 117 é aplicada pela suíte). B é a empresa não piloto (isenta, conectada, ligada). Revogações
 * feitas por SQL numa conexão de controle enquanto o worker está SEGURO numa barreira (gancho de consulta) no ponto exato.
 *
 *  3c      chave true SEM a 117: B lê (tela e biblioteca), não configura (nem desligada) e não escreve na biblioteca;
 *  3c-rod  só a tabela do rodízio ausente: PILOTO efetivo (B não grava), status com marca de colisão normal, rotinas normais;
 *  6b      piloto sem configuração e com ativo=false, nos dois modos: entrada PROCESSADA para a equipe; C4 da piloto NUNCA
 *          consultado (nenhuma consulta comercial com o id da piloto);
 *  4a      C1 (empresa), C2 (conexão), C3 (configuração), C4 (plano) e K-PROC revogados em cada ponto: P1 antes da reserva
 *          (fica PENDENTE), P2 antes do modelo (barreira no portão: entrada CANCELADA, modelo 0), P3 ao persistir (barreira
 *          DENTRO do modelo: CANCELADA, nenhuma saída), P4 antes do marco ENVIANDO (barreira na transação do marco: saída
 *          CANCELADA); transporte com 0 chamadas em todos;
 *  F6      fallback: revogação durante o modelo que termina em ERRO → nada criado (entrada CANCELADA, conversa intacta);
 *  4b      revogação DEPOIS de ENVIANDO (dentro de `enviar`): o transporte é chamado uma vez com a identidade de B e o
 *          resultado é registrado (SUBMETIDA);
 *  7       falha transitória real (uma vez) em C1, C2, C3 e C4 antes do modelo, em C3 na persistência e em C1 no marco: a
 *          tarefa volta a PENDENTE (iniciada_em nula), nenhuma saída, conversa intacta; o ciclo seguinte conclui. Na reserva:
 *          B pulada, A atendida. Na recepção: erro (5xx) sem gravar; o reenvio grava;
 *  8b      schema comercial ausente: recepção de B falha (transitório) e a fila de B fica intacta; a piloto segue;
 *  5a      status antecipado: POST de B preso, callback chega (buffer da dona), POST liberado → aplicado pelo worker
 *          (ENTREGUE; e FALHOU com a equipe chamada);
 *  5b      status depois do retorno, e duplicado: aplicado uma vez, estado final estável;
 *  F2      callback com a conexão de B DESCONECTADA aplica à saída existente; depois do rollback SEM piloto, idem; a
 *          recepção técnica real não exige piloto;
 *  §7b     (r3) revogação com grupo CRUZADO: irmã SUBMETIDA de A (outra empresa) ou de outra conversa de B não bloqueia B
 *          de revogar o próprio arquivo; a revogação cancela só as irmãs da MESMA conversa de B; controle positivo: irmã
 *          SUBMETIDA na mesma conversa de B continua dando ATENDIMENTO_GRUPO_PARCIAL.
 *  §7      referência de grupo CRUZADA (saída de B com origem_grupo_id de A): a falha de A cancela só a irmã de A; a saída de
 *          B sai normalmente.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const UP = ler("database/migrations/20261104_117_atendimento_multiempresa.sql");
const POS = ler("database/checks/20261104_117_postcheck.sql");
const SEGREDO = Buffer.alloc(32, 7).toString("base64");
Object.assign(process.env, { WHATSAPP_CREDENTIAL_ENCRYPTION_KEY: SEGREDO, WHATSAPP_CREDENTIAL_KEY_VERSION: "1", META_GRAPH_API_VERSION: "v23.0" });
const CHAVE = "WHATSAPP_ATENDIMENTO_MULTIEMPRESA";
const chave = (v: string | undefined) => { if (v === undefined) delete process.env[CHAVE]; else process.env[CHAVE] = v; };
const EMPRESA_SQL = "SELECT id FROM empresas WHERE id=$1 AND status='ATIVA' FOR SHARE";
const C2_SQL = "SELECT 1 FROM whatsapp_conexoes WHERE ambiente=$1 AND empresa_id=$2 AND status='CONFIGURADA'";
const C3_SQL = "SELECT configuracao FROM whatsapp_atendimento_config WHERE empresa_id=$1 AND ambiente=$2";
const C4_SQL = "FROM assinatura_isencoes WHERE empresa_id";
const PLANO: Interpretacao = { intencao: "INTERESSE", perguntaId: null, data: null, convidados: null } as Interpretacao;

test("E-ME1 r2: portões nos pontos do worker, transitórios, status e escopos", { timeout: 900_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") {
    t.skip("opt-in ausente: harness PostgreSQL não executado");
    return;
  }
  const c = await conectarDescartavel();
  const q = (sql: string, v: unknown[] = []) => c.query(sql, v);
  try {
    assert.equal((await q("SELECT to_regclass('public.whatsapp_atendimento_rodizio') AS r")).rows[0].r, null, "modelo sem a 117");
    const criarUsuario = async (papel: string) => (await q(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness portões', $2, $3, true) RETURNING id`, [`${cod("u")}@example.test`, SENHA, papel])).rows[0].id as string;
    const f = fixturesMultiempresa(q, criarUsuario);
    const A = await f.empresa("A piloto"), B = await f.empresa("B");
    flags.piloto = A; flags.kproc = true; flags.regras = true;
    const sA = await f.sessao(A), sB = await f.sessao(B);
    const autor = sA.usuario_id;
    for (const e of [A, B]) await f.conectar(e, autor);
    await f.isentar(B, autor);
    const { servico, worker, meta, biblioteca, privacidade } = carregarMultiempresa();
    const config = (ativo: boolean) => ({ ativo, nome: "Buffet sintético", perguntas: [], limites: { respostasPor24h: 50 } });
    const conta = async (sql: string, v: unknown[] = []) => Number((await q(sql, v)).rows[0].n);
    const estadoDe = async (id: string) => (await q("SELECT estado FROM whatsapp_atendimento_mensagens WHERE id=$1", [id])).rows[0].estado as string;
    let seq = 10;
    const contato = () => `556191${String(seq++).padStart(7, "0")}`;
    const entrada = (e: string, ct: string, texto = "Oi, quero orçamento") => ({ phoneNumberId: f.numero(e), wabaId: f.waba(e), id: cod("wamid.in."), contato: ct, texto, timestamp: Date.now(), nomePerfil: "Cliente Sintético" });
    const receber = (...l: ReturnType<typeof entrada>[]) => meta.receberEventosMeta({ entradas: l, status: [] }, { automacaoGlobal: true });
    const statusDe = (e: string, id: string, tipo: "delivered" | "failed" = "delivered") => meta.receberEventosMeta({ entradas: [], status: [{ phoneNumberId: f.numero(e), wabaId: f.waba(e), id, tipo }] }, { automacaoGlobal: true });
    const entradaDe = async (e: string, ct: string) => (await q("SELECT m.id, m.estado, m.iniciada_em, c.id AS conversa, c.versao, c.estado AS cestado FROM whatsapp_atendimento_mensagens m JOIN whatsapp_atendimento_conversas c ON c.id=m.conversa_id WHERE m.empresa_id=$1 AND c.contato=$2 AND m.direcao='ENTRADA' ORDER BY m.criada_em DESC LIMIT 1", [e, ct])).rows[0];
    const saidasDaConversa = (conv: string) => conta("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE conversa_id=$1 AND direcao='SAIDA'", [conv]);
    const semPendentes = () => q("UPDATE whatsapp_atendimento_mensagens SET estado='CANCELADA' WHERE estado IN ('PENDENTE','PROCESSANDO')");
    const saidaPronta = async (e: string, extra: { grupo?: string; ordem?: number; estado?: string; provedor?: string } = {}) => {
      const conv = (await q("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, estado, ultima_entrada_em) VALUES ($1, 'staging', $2, 'AGUARDANDO_HUMANO', clock_timestamp()) RETURNING id", [e, contato()])).rows[0].id as string;
      const id = (await q(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, origem_grupo_id, ordem, provedor_id)
        VALUES ($1, $2, 'staging', 'SAIDA', $3, $4, 0, $5, $6, $7) RETURNING id`, [conv, e, MENSAGEM_ENCAMINHAMENTO, extra.estado ?? "PENDENTE", extra.grupo ?? null, extra.ordem ?? 0, extra.provedor ?? null])).rows[0].id as string;
      return { conv, id };
    };

    // Transporte e modelo espiões.
    const envios: AlvoEnvio[] = [];
    let preso: null | { chegou: ReturnType<typeof adiado<void>>; solta: ReturnType<typeof adiado<void>> } = null;
    let idFixo: string | null = null;
    let modelo: null | (() => Promise<Interpretacao>) = null;
    let chamadasModelo = 0;
    const deps: DependenciasWorker = {
      interpretar: async () => { chamadasModelo++; return modelo ? modelo() : PLANO; },
      enviar: async (_c, _conteudo, alvo) => { envios.push(alvo); if (preso) { const p = preso; preso = null; p.chegou.liberar(); await p.solta.p; } return idFixo ?? cod("wamid."); },
    };
    const prenderEnvio = () => { const p = { chegou: adiado<void>(), solta: adiado<void>() }; preso = p; return { chegou: p.chegou.p, liberar: () => p.solta.liberar() }; };
    const lote = (n = 1) => worker.processarLote(deps, { maxTarefas: n });

    // ——— 3c: chave true SEM a 117 ———
    chave("true");
    await servico.salvarConfiguracao(sA as never, config(true));
    assert.ok(Array.isArray((await servico.listarAtendimento(sB as never)).conversas), "3c: B lê a própria tela");
    assert.ok(Array.isArray((await biblioteca.listarProntas(sB as never)).prontas), "3c: B lê a própria biblioteca");
    await assert.rejects(servico.salvarConfiguracao(sB as never, config(false)), /ATENDIMENTO_RECURSO_NAO_INCLUIDO/, "3c: B não configura nem DESLIGADA");
    const pronta = { categoria: "Comercial", link: null, atalho: null, titulo: "Preços de B", tipo: "TEXTO", texto: "Material de B", estado: "PUBLICADA", envioAutomatico: true, finalidade: "PRECOS" };
    await assert.rejects(biblioteca.salvarPronta(sB as never, pronta as never), /ATENDIMENTO_RECURSO_NAO_INCLUIDO/, "3c: B não escreve na biblioteca");
    assert.equal(await conta("SELECT count(*) AS n FROM whatsapp_atendimento_config WHERE empresa_id=$1", [B]), 0, "3c: nada gravado de B");

    // ——— 117 aplicada ———
    await q(UP); await q(POS);
    await servico.salvarConfiguracao(sB as never, config(true));

    // ——— 3c-rod: só o rodízio ausente ———
    await q("ALTER TABLE whatsapp_atendimento_rodizio RENAME TO whatsapp_atendimento_rodizio_fora_r2");
    {
      const tx = { query: (s: string, v?: readonly unknown[]) => c.query(s, v ? [...v] : []) } as never;
      assert.equal(await multiempresa.modoEfetivo(tx), "PILOTO", "3c-rod: PILOTO efetivo");
      const ct = contato();
      await receber(entrada(B, ct));
      assert.equal(await conta("SELECT count(*) AS n FROM whatsapp_atendimento_mensagens WHERE empresa_id=$1 AND direcao='ENTRADA'", [B]), 0, "3c-rod: B confirma sem gravar");
      const X = cod("wamid.rod.");
      const sa = await saidaPronta(A, { estado: "SUBMETIDA", provedor: X }), sb = await saidaPronta(B, { estado: "SUBMETIDA", provedor: X });
      await statusDe(A, X);
      assert.deepEqual([await estadoDe(sa.id), await estadoDe(sb.id), await conta("SELECT count(*) AS n FROM whatsapp_atendimento_status_colisoes WHERE provedor_id=$1", [X])], ["SUBMETIDA", "SUBMETIDA", 1], "3c-rod: colisão com marca normal");
      await servico.limparStatusExpirados();
    }
    await q("ALTER TABLE whatsapp_atendimento_rodizio_fora_r2 RENAME TO whatsapp_atendimento_rodizio");

    // ——— 6b: piloto sem configuração e com ativo=false, nos dois modos; C4 da piloto nunca consultado ———
    {
      const consultasComerciaisDaPiloto: string[] = [];
      const parar = comGancho((sql, _o, v) => { if (/assinatura_|empresa_assinaturas/.test(sql) && v.some((x) => String(x).toLowerCase() === A.toLowerCase())) consultasComerciaisDaPiloto.push(sql); });
      const configA = (await q("SELECT configuracao FROM whatsapp_atendimento_config WHERE empresa_id=$1", [A])).rows[0].configuracao;
      for (const modo of ["true", undefined]) {
        chave(modo);
        await q("DELETE FROM whatsapp_atendimento_config WHERE empresa_id=$1", [A]);
        const ct1 = contato();
        await receber(entrada(A, ct1));
        assert.equal((await entradaDe(A, ct1)).estado, "PROCESSADA", `6b (${modo ?? "ausente"}): piloto sem configuração → equipe`);
        await q("INSERT INTO whatsapp_atendimento_config (empresa_id, ambiente, configuracao) VALUES ($1, 'staging', $2::jsonb)", [A, JSON.stringify({ ...configA, ativo: false })]);
        const ct2 = contato();
        await receber(entrada(A, ct2));
        assert.equal((await entradaDe(A, ct2)).estado, "PROCESSADA", `6b (${modo ?? "ausente"}): piloto desligada → equipe`);
        await lote(2);
      }
      parar();
      assert.deepEqual(consultasComerciaisDaPiloto, [], "6b: nenhuma consulta comercial (C4) com o id da piloto");
      await q("UPDATE whatsapp_atendimento_config SET configuracao=$2::jsonb WHERE empresa_id=$1", [A, JSON.stringify(configA)]);
    }
    chave("true");
    await semPendentes();

    // ——— 4a: revogações em cada ponto ———
    type Revogacao = { nome: string; revogar: () => Promise<unknown>; restaurar: () => Promise<unknown> };
    const configAtiva = (ativo: boolean) => q("UPDATE whatsapp_atendimento_config SET configuracao=jsonb_set(configuracao,'{ativo}',$2::jsonb) WHERE empresa_id=$1", [B, JSON.stringify(ativo)]);
    const revogacoes: Revogacao[] = [
      { nome: "C1 empresa", revogar: () => q("UPDATE empresas SET status='SUSPENSA' WHERE id=$1", [B]), restaurar: () => q("UPDATE empresas SET status='ATIVA' WHERE id=$1", [B]) },
      { nome: "C2 conexão", revogar: () => f.desconectar(B, autor), restaurar: () => f.reconectar(B, autor) },
      { nome: "C3 configuração", revogar: () => configAtiva(false), restaurar: () => configAtiva(true) },
      { nome: "C4 plano", revogar: () => f.revogarIsencao(B), restaurar: () => f.restaurarIsencao(B) },
      { nome: "K-PROC", revogar: async () => { flags.kproc = false; }, restaurar: async () => { flags.kproc = true; } },
    ];
    // Barreira armada só DEPOIS da reserva da mensagem (a consulta igual da reserva não é o ponto).
    const depoisDaReserva = (mensagemId: string, casa: (sql: string, o: Origem) => boolean) => {
      let reservada = false;
      const parar = comGancho((sql, _o, v) => { if (sql.startsWith("UPDATE whatsapp_atendimento_mensagens SET estado=$2,iniciada_em=clock_timestamp() WHERE id=$1") && !sql.includes("AND estado") && v[0] === mensagemId) reservada = true; });
      const b = barreira((sql, o) => reservada && casa(sql, o));
      return { ...b, remover: () => { parar(); b.remover(); } };
    };
    flags.regras = false;
    for (const r of revogacoes) {
      // P1 — antes da reserva (K-PROC desligado: o processador nem roda; a fila fica intacta).
      {
        const ct = contato(); await receber(entrada(B, ct)); const e0 = await entradaDe(B, ct);
        assert.equal(e0.estado, "PENDENTE");
        const [n0, m0] = [envios.length, chamadasModelo];
        await r.revogar();
        await lote(2);
        assert.equal((await entradaDe(B, ct)).estado, "PENDENTE", `4a P1 ${r.nome}: nada reservado, fila preservada`);
        assert.deepEqual([envios.length - n0, chamadasModelo - m0], [0, 0], `4a P1 ${r.nome}: transporte e modelo com 0 chamadas`);
        await r.restaurar(); await semPendentes();
      }
      // P2 — antes do modelo (barreira no portão: leitura avulsa C1 da empresa).
      {
        const ct = contato(); await receber(entrada(B, ct)); const e0 = await entradaDe(B, ct);
        const [n0, m0] = [envios.length, chamadasModelo];
        const b = depoisDaReserva(e0.id, (sql, o) => o === "db" && sql === EMPRESA_SQL);
        const w = lote(1);
        await noPrazo(b.chegou, 15_000, `4a P2 ${r.nome}: chegou ao portão antes do modelo`);
        await r.revogar(); b.liberar(); await noPrazo(w, 15_000, "4a P2"); b.remover();
        const e1 = await entradaDe(B, ct);
        assert.equal(e1.estado, "CANCELADA", `4a P2 ${r.nome}: entrada cancelada pelo portão`);
        assert.deepEqual([chamadasModelo - m0, envios.length - n0, await saidasDaConversa(e1.conversa)], [0, 0, 0], `4a P2 ${r.nome}: modelo 0, transporte 0, nenhuma saída`);
        await r.restaurar(); await semPendentes();
      }
      // P3 — ao persistir (barreira DENTRO do modelo).
      {
        const ct = contato(); await receber(entrada(B, ct));
        const [n0] = [envios.length];
        const dentro = adiado<void>(), solta = adiado<void>();
        modelo = async () => { dentro.liberar(); await solta.p; return PLANO; };
        const w = lote(1);
        await noPrazo(dentro.p, 15_000, `4a P3 ${r.nome}: dentro do modelo`);
        await r.revogar(); solta.liberar(); await noPrazo(w, 15_000, "4a P3"); modelo = null;
        const e1 = await entradaDe(B, ct);
        assert.equal(e1.estado, "CANCELADA", `4a P3 ${r.nome}: persistência recusada`);
        assert.deepEqual([envios.length - n0, await saidasDaConversa(e1.conversa)], [0, 0], `4a P3 ${r.nome}: nenhuma saída, transporte 0`);
        await r.restaurar(); await semPendentes();
      }
      // P4 — antes do marco ENVIANDO (barreira na 1ª consulta da transação do marco).
      {
        const s = await saidaPronta(B);
        const n0 = envios.length;
        const b = depoisDaReserva(s.id, (sql, o) => o === "tx" && sql === EMPRESA_SQL);
        const w = lote(1);
        await noPrazo(b.chegou, 15_000, `4a P4 ${r.nome}: chegou ao marco`);
        await r.revogar(); b.liberar(); await noPrazo(w, 15_000, "4a P4"); b.remover();
        assert.equal(await estadoDe(s.id), "CANCELADA", `4a P4 ${r.nome}: saída cancelada antes do marco`);
        assert.equal(envios.length - n0, 0, `4a P4 ${r.nome}: transporte 0`);
        await r.restaurar(); await semPendentes();
      }
    }

    // ——— F6: revogação durante o modelo que termina em ERRO (fallback) ———
    for (const r of [revogacoes[1], revogacoes[3]]) {
      const ct = contato(); await receber(entrada(B, ct)); const e0 = await entradaDe(B, ct);
      const dentro = adiado<void>(), solta = adiado<void>();
      modelo = async () => { dentro.liberar(); await solta.p; throw new Error("modelo indisponível (sintético)"); };
      const w = lote(1);
      await noPrazo(dentro.p, 15_000, "F6");
      await r.revogar(); solta.liberar(); await noPrazo(w, 15_000, "F6"); modelo = null;
      const e1 = await entradaDe(B, ct);
      assert.equal(e1.estado, "CANCELADA", `F6 ${r.nome}: o fallback recusa pelo portão completo`);
      assert.deepEqual([await saidasDaConversa(e1.conversa), Number(e1.versao), e1.cestado], [0, Number(e0.versao), e0.cestado], `F6 ${r.nome}: nenhuma resposta fixa, conversa intacta`);
      await r.restaurar(); await semPendentes();
    }

    // ——— 4b: revogação depois de ENVIANDO ———
    {
      const s = await saidaPronta(B);
      const n0 = envios.length;
      const p = prenderEnvio();
      const w = lote(1);
      await noPrazo(p.chegou, 15_000, "4b: dentro do transporte");
      assert.equal(await estadoDe(s.id), "ENVIANDO");
      for (const r of revogacoes.slice(1, 4)) await r.revogar();
      p.liberar(); await noPrazo(w, 15_000, "4b");
      assert.equal(envios.length - n0, 1, "4b: transporte chamado uma vez");
      assert.deepEqual([envios.at(-1)!.empresaId, envios.at(-1)!.saidaId, envios.at(-1)!.ambiente, envios.at(-1)!.piloto], [B, s.id, "staging", false], "4b: com a identidade de B");
      assert.equal(await estadoDe(s.id), "SUBMETIDA", "4b: resultado registrado");
      for (const r of revogacoes.slice(1, 4)) await r.restaurar();
      await semPendentes();
    }

    // ——— 7: transitórios reais ———
    const transitorios: [string, (sql: string, o: Origem) => boolean][] = [
      ["C1 antes do modelo", (s, o) => o === "db" && s === EMPRESA_SQL],
      ["C2 antes do modelo", (s, o) => o === "db" && s === C2_SQL],
      ["C3 antes do modelo", (s, o) => o === "db" && s.startsWith(C3_SQL) && !s.includes("FOR SHARE")],
      ["C4 antes do modelo", (s, o) => o === "db" && s.includes(C4_SQL)],
      ["C3 na persistência", (s, o) => o === "tx" && s.startsWith(C3_SQL) && s.includes("FOR SHARE")],
    ];
    for (const [nome, casa] of transitorios) {
      const ct = contato(); await receber(entrada(B, ct)); const e0 = await entradaDe(B, ct);
      const m0 = chamadasModelo;
      let armado = false;
      const pararArme = comGancho((sql, _o, v) => { if (sql.startsWith("UPDATE whatsapp_atendimento_mensagens SET estado=$2,iniciada_em=clock_timestamp() WHERE id=$1") && v[0] === e0.id) armado = true; });
      const falha = falhaUmaVez((s, o) => armado && casa(s, o));
      const r1 = await lote(1);
      pararArme(); falha.remover();
      assert.equal(falha.disparou(), 1, `7 ${nome}: a falha foi injetada`);
      const e1 = await entradaDe(B, ct);
      assert.deepEqual([e1.estado, e1.iniciada_em, await saidasDaConversa(e1.conversa), Number(e1.versao), e1.cestado], ["PENDENTE", null, 0, Number(e0.versao), e0.cestado], `7 ${nome}: devolvida à fila, sem saída, conversa intacta (lote ${r1.estado})`);
      if (nome.includes("antes do modelo")) assert.equal(chamadasModelo, m0, `7 ${nome}: modelo não chamado`);
      await lote(1);
      assert.equal((await entradaDe(B, ct)).estado, "PROCESSADA", `7 ${nome}: o ciclo seguinte conclui`);
      await semPendentes();
    }
    {
      // C1 no marco ENVIANDO: a transação do marco é desfeita, a saída volta à fila.
      const s = await saidaPronta(B);
      let armado = false;
      const pararArme = comGancho((sql, _o, v) => { if (sql.startsWith("UPDATE whatsapp_atendimento_mensagens SET estado=$2,iniciada_em=clock_timestamp() WHERE id=$1") && v[0] === s.id) armado = true; });
      const falha = falhaUmaVez((sql, o) => armado && o === "tx" && sql === EMPRESA_SQL);
      const n0 = envios.length;
      await lote(1); pararArme(); falha.remover();
      assert.deepEqual([falha.disparou(), await estadoDe(s.id), envios.length - n0], [1, "PENDENTE", 0], "7 C1 no marco: de volta à fila, nada enviado");
      await lote(1);
      assert.equal(await estadoDe(s.id), "SUBMETIDA", "7 C1 no marco: o ciclo seguinte envia");
      await semPendentes();
    }
    {
      // Na reserva: leitura de C2 de B falha uma vez → B fica para o próximo ciclo; A (piloto) é atendida.
      const sb = await saidaPronta(B), sa = await saidaPronta(A);
      await q("DELETE FROM whatsapp_atendimento_rodizio"); await q("INSERT INTO whatsapp_atendimento_rodizio (empresa_id, ambiente, ordem) VALUES ($1,'staging',1),($2,'staging',2)", [B, A]);
      const falha = falhaUmaVez((sql, o) => o === "tx" && sql === C2_SQL);
      await lote(1); falha.remover();
      assert.deepEqual([falha.disparou(), await estadoDe(sb.id), await estadoDe(sa.id)], [1, "PENDENTE", "SUBMETIDA"], "7 reserva: B pulada (transitória), A atendida");
      await lote(1);
      assert.equal(await estadoDe(sb.id), "SUBMETIDA", "7 reserva: B no ciclo seguinte");
    }
    {
      // Na recepção: C4 falha uma vez → erro (5xx) sem gravar; reenvio grava.
      const ct = contato(); const ev = entrada(B, ct);
      const falha = falhaUmaVez((sql) => sql.includes(C4_SQL));
      await assert.rejects(receber(ev), "7 recepção: erro para o provedor reenviar");
      falha.remover();
      assert.equal(await entradaDe(B, ct), undefined, "7 recepção: nada gravado");
      await receber(ev);
      assert.equal((await entradaDe(B, ct)).estado, "PENDENTE", "7 recepção: o reenvio grava");
      await semPendentes();
    }

    // ——— 8b: schema comercial ausente ———
    {
      const sb = await saidaPronta(B), sa = await saidaPronta(A);
      await q("ALTER TABLE assinatura_isencoes RENAME TO assinatura_isencoes_fora_r2");
      try {
        const ct = contato();
        await assert.rejects(receber(entrada(B, ct)), "8b: recepção de B falha (transitório), nunca SIM nem NÃO");
        assert.equal(await entradaDe(B, ct), undefined);
        await lote(2);
        assert.deepEqual([await estadoDe(sb.id), await estadoDe(sa.id)], ["PENDENTE", "SUBMETIDA"], "8b: fila de B intacta; a piloto segue");
      } finally {
        await q("ALTER TABLE assinatura_isencoes_fora_r2 RENAME TO assinatura_isencoes");
      }
      await semPendentes();
    }
    flags.regras = true;

    // ——— 5a: status antecipado com o POST preso ———
    for (const tipo of ["delivered", "failed"] as const) {
      const X = cod("wamid.5a.");
      const s = await saidaPronta(B);
      idFixo = X;
      const p = prenderEnvio();
      const w = lote(1);
      await noPrazo(p.chegou, 15_000, "5a: POST preso");
      await statusDe(B, X, tipo);
      assert.equal(await conta("SELECT count(*) AS n FROM whatsapp_atendimento_status WHERE empresa_id=$1 AND provedor_id=$2", [B, X]), 1, `5a ${tipo}: buffer da dona atual (B)`);
      assert.equal(await estadoDe(s.id), "ENVIANDO", `5a ${tipo}: nada aplicado antes do retorno`);
      p.liberar(); await noPrazo(w, 15_000, "5a");
      idFixo = null;
      assert.equal(await estadoDe(s.id), tipo === "delivered" ? "ENTREGUE" : "FALHOU", `5a ${tipo}: aplicado pelo worker no retorno do POST`);
      assert.equal(await conta("SELECT count(*) AS n FROM whatsapp_atendimento_status WHERE provedor_id=$1", [X]), 0, `5a ${tipo}: buffer consumido`);
    }
    // ——— 5b: depois do retorno e duplicado ———
    {
      const X = cod("wamid.5b.");
      const s = await saidaPronta(B, { estado: "SUBMETIDA", provedor: X });
      await statusDe(B, X); await statusDe(B, X);
      assert.deepEqual([await estadoDe(s.id), await conta("SELECT count(*) AS n FROM whatsapp_atendimento_status WHERE provedor_id=$1", [X])], ["ENTREGUE", 0], "5b: aplicado uma vez; o duplicado não muda");
    }
    // ——— F2: conexão desconectada; rollback sem piloto ———
    {
      const X = cod("wamid.f2.");
      const s = await saidaPronta(B, { estado: "SUBMETIDA", provedor: X });
      await f.desconectar(B, autor);
      await statusDe(B, X);
      assert.equal(await estadoDe(s.id), "ENTREGUE", "F2: status da saída existente aplicado com a conexão DESCONECTADA");
      await f.reconectar(B, autor);
      const Y = cod("wamid.f2b.");
      const s2 = await saidaPronta(B, { estado: "SUBMETIDA", provedor: Y });
      chave(undefined); flags.piloto = null;
      await statusDe(B, Y);
      assert.equal(await estadoDe(s2.id), "ENTREGUE", "F2: depois do rollback SEM piloto o status continua aplicado");
      const ct = contato();
      await receber(entrada(B, ct), entrada(A, contato()));
      assert.equal(await entradaDe(B, ct), undefined, "F2: sem piloto no PILOTO, nenhuma entrada gravada");
      const env = { WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED: "true", WHATSAPP_ATENDIMENTO_RECEPTOR: "staging", KIDMAIS_DEPLOY_ENV: "staging" } as unknown as NodeJS.ProcessEnv;
      assert.equal(configuracaoReal.recepcaoAtiva(env), false, "F2: recepção de ENTRADAS exige piloto");
      assert.equal(configuracaoReal.recepcaoTecnicaAtiva(env), configuracaoReal.receptorDoNumero(env), "F2: recepção técnica (status) não exige piloto");
      flags.piloto = A; chave("true");
    }

    // ——— §7b (r3): revogação com referência de grupo cruzada ———
    {
      await semPendentes();
      const sB7 = await f.sessao(B);
      const arq = await biblioteca.salvarArquivo(sB7 as never, { nome: "tabela-7b.pdf", bytes: Buffer.from("%PDF-1.4\n% tabela sintética 7b\n%%EOF\n"), tipoEsperado: "DOCUMENTO" });
      const convA = (await q("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, estado, ultima_entrada_em) VALUES ($1, 'staging', $2, 'AGUARDANDO_HUMANO', clock_timestamp()) RETURNING id", [A, contato()])).rows[0].id as string;
      const grupo = (await q("INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, externa_id) VALUES ($1, $2, 'staging', 'ENTRADA', 'oi', 'PROCESSADA', 0, $3) RETURNING id", [convA, A, cod("ext.")])).rows[0].id as string;
      const prontaDoc = (await biblioteca.salvarPronta(sB7 as never, { ...pronta, titulo: "Tabela 7b", tipo: "DOCUMENTO", texto: "Tabela de B", arquivoId: arq.id } as never)).id as string;
      const saida = async (conv: string, e: string, estado: string, ordem: number, arquivo?: string) => (await q(`INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, origem_grupo_id, ordem, provedor_id, midia_tipo, midia_arquivo_id, midia_nome, midia_pronta_id, midia_pronta_versao)
        VALUES ($1,$2,'staging','SAIDA',$3,$4,0,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [conv, e, MENSAGEM_ENCAMINHAMENTO, estado, grupo, ordem, estado === "PENDENTE" ? null : cod("wamid.7b."), arquivo ? "DOCUMENTO" : null, arquivo ?? null, arquivo ? "tabela-7b.pdf" : null, arquivo ? prontaDoc : null, arquivo ? 0 : null])).rows[0].id as string;
      const aSubmetida = await saida(convA, A, "SUBMETIDA", 1);
      const aPendente = await saida(convA, A, "PENDENTE", 2);
      const bx = await saidaPronta(B, { grupo, ordem: 3 });
      const bArquivo = await saida(bx.conv, B, "PENDENTE", 4, arq.id);
      const outraB = await saidaPronta(B, { grupo, ordem: 5, estado: "SUBMETIDA", provedor: cod("wamid.7b.") });
      const outraBPendente = await saida(outraB.conv, B, "PENDENTE", 6);
      // Controle positivo: irmã SUBMETIDA na MESMA conversa de B bloqueia (o escopo não desligou a regra B2).
      const mesmaB = await saida(bx.conv, B, "SUBMETIDA", 7);
      await assert.rejects(privacidade.revogarArquivo(sB7 as never, { arquivoId: arq.id }), /ATENDIMENTO_GRUPO_PARCIAL/, "§7b controle: irmã enviada na mesma conversa de B bloqueia");
      await q("DELETE FROM whatsapp_atendimento_mensagens WHERE id=$1", [mesmaB]);
      await privacidade.revogarArquivo(sB7 as never, { arquivoId: arq.id });
      assert.equal((await q("SELECT revogado_em IS NOT NULL AS r FROM whatsapp_atendimento_arquivos WHERE id=$1", [arq.id])).rows[0].r, true, "§7b: B revoga o próprio arquivo apesar da irmã SUBMETIDA de A e da de outra conversa de B");
      assert.deepEqual([await estadoDe(bArquivo), await estadoDe(bx.id)], ["CANCELADA", "CANCELADA"], "§7b: a saída do arquivo e a irmã da mesma conversa de B são canceladas");
      assert.deepEqual([await estadoDe(aSubmetida), await estadoDe(aPendente), await estadoDe(outraB.id), await estadoDe(outraBPendente)], ["SUBMETIDA", "PENDENTE", "SUBMETIDA", "PENDENTE"], "§7b: nada de A nem de outra conversa de B é tocado");
      await semPendentes();
    }

    // ——— §7: referência de grupo cruzada ———
    {
      const convA = (await q("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, estado, ultima_entrada_em) VALUES ($1, 'staging', $2, 'AGUARDANDO_HUMANO', clock_timestamp()) RETURNING id", [A, contato()])).rows[0].id as string;
      const grupo = (await q("INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, externa_id) VALUES ($1, $2, 'staging', 'ENTRADA', 'oi', 'PROCESSADA', 0, $3) RETURNING id", [convA, A, cod("ext.")])).rows[0].id as string;
      const P = cod("wamid.g7.");
      const s1 = (await q("INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, origem_grupo_id, ordem, provedor_id) VALUES ($1,$2,'staging','SAIDA',$3,'SUBMETIDA',0,$4,1,$5) RETURNING id", [convA, A, MENSAGEM_ENCAMINHAMENTO, grupo, P])).rows[0].id as string;
      const s2 = (await q("INSERT INTO whatsapp_atendimento_mensagens (conversa_id, empresa_id, ambiente, direcao, texto, estado, versao_conversa, origem_grupo_id, ordem) VALUES ($1,$2,'staging','SAIDA',$3,'PENDENTE',0,$4,2) RETURNING id", [convA, A, MENSAGEM_ENCAMINHAMENTO, grupo])).rows[0].id as string;
      const sB = await saidaPronta(B, { grupo, ordem: 3 });
      await statusDe(A, P, "failed");
      assert.deepEqual([await estadoDe(s1), await estadoDe(s2), await estadoDe(sB.id)], ["FALHOU", "CANCELADA", "PENDENTE"], "§7: a falha de A cancela só a irmã de A");
      const n0 = envios.length;
      await lote(2);
      assert.equal(await estadoDe(sB.id), "SUBMETIDA", "§7: a saída de B não é recusada pelo grupo de A (envio do marco com escopo)");
      assert.ok(envios.slice(n0).some((x) => x.saidaId === sB.id && x.empresaId === B), "§7: transporte com a identidade de B");
    }
  } finally {
    semGanchos();
    chave(undefined);
    await c.end();
  }
});
