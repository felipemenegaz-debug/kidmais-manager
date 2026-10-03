import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { estruturaFesta019Sql } from "../festas/estrutura-019.ts";
import {
  carregar, cenario, decisoes, dia, executor, id, importacao, instalar055, instalar061, instalar062, integrar, ler, PARCIAL, representante, validarAgora,
  type Cenario, type Evento, type Servico,
} from "../../scripts/integracao-importados-test-support.ts";
import type { EscopoAgenda } from "./escopo.ts";

/**
 * Agenda por empresa e unidade (062) no PostgreSQL REAL, etapa por etapa da publicação. ESCRITO, NÃO EXECUTADO.
 *
 * Só roda pelo `check:v1:postgres` no cluster descartável (127.0.0.1, banco kidmais_pacotes_v1_descartavel) com
 * KIDMAIS_POSTGRES_DESCARTAVEL definido; nunca em staging/produção nem no banco local `kidmais_manager`. Execução só
 * com autorização explícita do Felipe (docs/OPERACAO_AGENTES.md).
 *
 * Parte do modelo `atual` (até a 057) e aplica, com os scripts reais, 055a–d → 061 → 062. Em cada etapa prova, com o
 * CÓDIGO NOVO: módulo Festa válido (o mesmo `validarAmbienteFesta` da assinatura pública e das telas de Festa),
 * gravação de contratação, disponibilidade (admin e pública), conflito da confirmação por pagamento e se a integração
 * está disponível; e que o código ANTERIOR (fingerprint estrito da 019) deixa de validar a partir da 061.
 * Depois: isolamento por empresa, D6 = opção A (habilitação explícita e auditada da unidade: nenhuma automática, duas
 * unidades habilitadas no mesmo horário, conflito na mesma unidade, recusa da não habilitada, revogação com reservas
 * preservadas e revogação concorrente), bloqueios por alcance, concorrência entre
 * fluxo nativo e importação, remarcação histórica, rollback suave/reaplicação e repetição sem duplicar financeiro.
 */
type Disponibilidade = typeof import("./services/availability.service.ts");
type Repositorio = typeof import("./repositories/disponibilidade.repository.ts");
type Escopo = typeof import("./escopo.ts");
type UnidadesAgenda = typeof import("./unidades-agenda.ts");

test("062: agenda por empresa e unidade — compatibilidade por etapa, isolamento, bloqueios, concorrência, remarcação e rollback", { timeout: 900_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  assert.equal(process.env.DATABASE_URL, undefined, "o runner remove DATABASE_URL: só as conexões descartáveis existem");
  const a = await conectarDescartavel();
  const b = await conectarDescartavel({ travar: false });
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  try {
    const disp = carregar<Disponibilidade>("lib/disponibilidade/services/availability.service.ts");
    const repo = carregar<Repositorio>("lib/disponibilidade/repositories/disponibilidade.repository.ts");
    const escopo = carregar<Escopo>("lib/disponibilidade/escopo.ts");
    const { validarAmbienteFesta } = carregar<typeof import("../festas/ambiente.ts")>("lib/festas/ambiente.ts");
    const integracaoRepo = carregar<typeof import("../contratos/integracao-importados/repositorio.ts")>("lib/contratos/integracao-importados/repositorio.ts");
    const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
    const { coreNativo } = carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
    const ua = carregar<UnidadesAgenda>("lib/disponibilidade/unidades-agenda.ts");
    const { registrarAuditoria } = carregar<typeof import("../clientes/repositories/auditoria.repository.ts")>("lib/clientes/repositories/auditoria.repository.ts");
    const auditar = (tx: DbExecutor, registro: Parameters<typeof registrarAuditoria>[0]) => registrarAuditoria(registro, tx);
    const ctxAgenda = () => ({ requestId: randomUUID(), ip: null, userAgent: "h062" });

    const periodo = async (db: Client, c: Cenario, data: string, alvo?: EscopoAgenda) =>
      (await disp.consultarDisponibilidadeData(data, executor(db), undefined, alvo)).periodos.find((p) => p.codigo === c.agendaCodigo)!.status;
    const empresa = (c: Cenario): EscopoAgenda => ({ empresaId: c.empresa, estabelecimentoId: null });
    const festaValida = async (db: Client) => {
      await validarAmbienteFesta(executor(db));
      assert.equal((await db.query<{ valida: boolean }>(estruturaFesta019Sql)).rows[0].valida, true);
    };
    /**
     * O código ANTERIOR a esta entrega valida a Festa com o fingerprint ESTRITO da 019 (só os corpos e gatilhos da 019;
     * o mesmo SQL que gerava lib/festas/estrutura-019.ts antes da 061). É a primeira condição do postcheck da 019.
     */
    const postcheck019 = ler("database/checks/20260915_019_postcheck.sql").replaceAll("\r", "");
    const estrito019 = postcheck019.slice(postcheck019.indexOf("IF NOT (") + "IF NOT (".length, postcheck019.indexOf(") THEN RAISE EXCEPTION 'Postcheck 019: instalação divergente'"));
    assert.ok(estrito019.startsWith("WITH esperadas(nome,hash) AS (VALUES"), "fingerprint estrito da 019 extraído");
    const codigoAnteriorValidaria = async (db: Client) => (await db.query<{ valida: boolean }>(`SELECT (${estrito019}) AS valida`)).rows[0].valida === true;
    /** Contratação gravada direto (fechamento AGUARDANDO_CONTRATO) com os gatilhos do schema da etapa. */
    const bruto = async (cc: Cenario, data: string, unidade?: string | null) => id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status${unidade !== undefined ? ", estabelecimento_id" : ""})
        SELECT $1::date, '08:00', '09:00', (SELECT id FROM configuracao_agenda WHERE ativo ORDER BY ordem_exibicao LIMIT 1), $2::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO'${unidade !== undefined ? ", $4::uuid" : ""} FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $3::uuid RETURNING fechamentos.id`,
      unidade !== undefined ? [data, cc.empresa, cc.pacote, unidade] : [data, cc.empresa, cc.pacote]);
    const pendencia = (data: string, inicio: string, fim: string): Evento => ({ data, inicio, fim });
    // Subteste que falha no meio não pode deixar transação aberta (ou abortada) para o próximo.
    t.beforeEach(async () => { await a.query("ROLLBACK"); await b.query("ROLLBACK"); });
    const naoConferido = { situacao: "NAO_CONFERIDO" };
    /** Núcleo comum das etapas antes da 062: tudo funciona e a agenda continua global (como hoje). */
    const agendaGlobalComoAntes = async (rotulo: string, d: string) => {
      const c = await cenario(a, 1);
      const outra = await cenario(a, 1);
      await bruto(c, d);
      const bloqueio = await repo.criarBloqueioAgenda({ data: d, diaInteiro: true, motivo: rotulo, empresaId: c.empresa }, executor(a));
      assert.equal(bloqueio.alcance, "GLOBAL", "sem a 062 não há onde gravar a empresa: bloqueio global, como sempre");
      assert.equal(await periodo(a, outra, d, empresa(outra)), "INDISPONIVEL", "agenda continua global");
      const conflito = await repo.verificarConflitoAgendaParaConfirmacao({ fechamentoId: randomUUID(), data: d, horarioInicio: "14:00", horarioFim: "18:00" }, executor(a));
      assert.equal(conflito.bloqueioAgenda, true, "confirmação por pagamento vê o bloqueio");
      assert.deepEqual(await escopo.escopoPublico(() => executor(a), {}), escopo.ESCOPO_GLOBAL, "agenda pública: comportamento anterior");
      return c;
    };

    await t.test("etapa 0 — código novo ANTES da 061: Festa válida (conjunto 019), fechamento, pagamento e agenda como antes", async () => {
      await festaValida(a);
      assert.equal(await codigoAnteriorValidaria(a), true, "o código anterior também valida: nada mudou no banco");
      await a.query("BEGIN");
      await agendaGlobalComoAntes("Etapa 0", dia(400));
      assert.equal(await integracaoRepo.integracaoDisponivel(executor(a)), false);
      await a.query("ROLLBACK");
    });

    await instalar055(a);
    await instalar061(a);

    await t.test("etapa 1 — 061 sem 062: Festa válida (conjunto 061), código anterior inválido (503), integração indisponível", async () => {
      await festaValida(a);
      assert.equal(await codigoAnteriorValidaria(a), false, "código anterior + 061 = módulo Festa e assinatura pública indisponíveis");
      await a.query("BEGIN");
      const c = await agendaGlobalComoAntes("Etapa 1", dia(410));
      const ev = pendencia(dia(411), "14:00", "18:00");
      const imp = await importacao(a, c, ev);
      assert.equal((await s.opcoesIntegracao(executor(a), c.tenant as never, imp.id, dia(0))).disponivel, false, "sem a 062 a integração fica indisponível");
      await assert.rejects(s.simularIntegracao(executor(a), c.tenant as never, imp.id, decisoes(c, ev, naoConferido), dia(0)), (e: { code?: string }) => e.code === "INTEGRACAO_INDISPONIVEL");
      await a.query("ROLLBACK");
    });

    await instalar062(a);

    await t.test("etapa 2 — 062: Festa válida (conjunto 062), código anterior inválido, integração disponível, pública exige contexto", async () => {
      await festaValida(a);
      assert.equal(await codigoAnteriorValidaria(a), false);
      await a.query("BEGIN");
      const c = await cenario(a, 1);
      assert.equal(await integracaoRepo.integracaoDisponivel(executor(a)), true);
      await bruto(c, dia(415));
      await assert.rejects(escopo.escopoPublico(() => executor(a), {}), (e: { code?: string }) => e.code === "AGENDA_PUBLICA_NAO_CONFIGURADA",
        "sem contexto público a consulta fica indisponível — nunca a agenda de todas as empresas");
      assert.deepEqual(await escopo.escopoPublico(() => executor(a), { AGENDA_PUBLICA_EMPRESA_ID: c.empresa }), empresa(c));
      await assert.rejects(escopo.escopoPublico(() => executor(a), { AGENDA_PUBLICA_EMPRESA_ID: c.empresa, AGENDA_PUBLICA_UNIDADE_ID: c.unidade! }),
        (e: { code?: string }) => e.code === "AGENDA_PUBLICA_INDISPONIVEL", "unidade SUSPENSO não é elegível (D6)");
      await a.query("ROLLBACK");
    });

    await t.test("D6 (opção A): nenhuma habilitação automática; SUSPENSO não é permissão; só o representante habilita", async () => {
      await a.query("BEGIN");
      const c = await cenario(a, 2);
      const elegiveis = (await a.query<{ n: number }>(`SELECT count(*)::int n FROM estabelecimentos WHERE empresa_id = $1 AND kidmais062_unidade_agendavel(empresa_id, id)`, [c.empresa])).rows[0].n;
      assert.equal(elegiveis, 0, "unidades existentes (SUSPENSO) não ficam elegíveis sozinhas");
      assert.deepEqual(await integracaoRepo.estabelecimentosAtivos(executor(a), c.empresa), [], "integração não oferece unidade não habilitada");
      assert.deepEqual(await escopo.escopoDaEmpresa(executor(a), c.empresa), empresa(c), "escopo da empresa inteira");
      await a.query("SAVEPOINT u");
      await assert.rejects(bruto(c, dia(416), c.unidades[0]), /não elegível para agenda/);
      await a.query("ROLLBACK TO SAVEPOINT u");
      await assert.rejects(repo.criarBloqueioAgenda({ data: dia(416), diaInteiro: true, motivo: "x", empresaId: c.empresa, estabelecimentoId: c.unidades[0] }, executor(a)), /não elegível para agenda/);
      await a.query("ROLLBACK TO SAVEPOINT u");
      const unica = await cenario(a, 1);
      assert.equal((await a.query(`SELECT estabelecimento_id FROM fechamentos WHERE id = $1`, [await bruto(unica, dia(417))])).rows[0].estabelecimento_id, null,
        "nem a única unidade é atribuída sem habilitação");
      // ADMINISTRATIVO não habilita: o serviço recusa e o banco recusa a gravação direta.
      await assert.rejects(ua.habilitarUnidadeAgenda(executor(a), c.tenant, c.unidades[0], "Abertura da unidade", ctxAgenda(), auditar),
        (e: { code?: string }) => e.code === "PAPEL_NAO_AUTORIZADO");
      await a.query("SAVEPOINT direto");
      await assert.rejects(a.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao)
          VALUES ($1, $2, $3, 'ADMINISTRATIVO', 'Tentativa direta')`, [c.empresa, c.unidades[0], c.usuario]), /exige Representante autorizado ativo desta empresa/);
      await a.query("ROLLBACK TO SAVEPOINT direto");
      // Representante de OUTRA empresa também não.
      const outra = await cenario(a, 1);
      const repOutra = await representante(a, outra);
      await assert.rejects(a.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao)
          VALUES ($1, $2, $3, 'REPRESENTANTE_AUTORIZADO', 'Tentativa cruzada')`, [c.empresa, c.unidades[0], repOutra.usuarioId]), /exige Representante autorizado ativo desta empresa/);
      await a.query("ROLLBACK TO SAVEPOINT direto");
      await a.query("ROLLBACK");
    });

    await t.test("D6 (opção A): duas unidades habilitadas no mesmo horário; conflito na mesma unidade; unidade não habilitada recusada", async () => {
      await a.query("BEGIN");
      const c = await cenario(a, 3);
      const [u1, u2, u3] = c.unidades;
      const rep = await representante(a, c);
      const tx = executor(a);
      await ua.habilitarUnidadeAgenda(tx, rep, u1, "Abertura da unidade 1", ctxAgenda(), auditar);
      await ua.habilitarUnidadeAgenda(tx, rep, u2, "Abertura da unidade 2", ctxAgenda(), auditar);
      assert.equal((await a.query(`SELECT count(*)::int n FROM auditoria WHERE acao = 'AGENDA_UNIDADE_HABILITADA' AND entidade_id = ANY($1::uuid[]) AND usuario_id = $2`, [[u1, u2], rep.usuarioId])).rows[0].n, 2, "auditado");
      await assert.rejects(ua.habilitarUnidadeAgenda(tx, rep, u1, "De novo", ctxAgenda(), auditar), (e: { code?: string }) => e.code === "UNIDADE_JA_HABILITADA");
      await a.query("SAVEPOINT dup");
      await assert.rejects(a.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao)
          VALUES ($1, $2, $3, 'REPRESENTANTE_AUTORIZADO', 'Duplicada direta')`, [c.empresa, u1, rep.usuarioId]), /duplicate key|vigente_uk/);
      await a.query("ROLLBACK TO SAVEPOINT dup");
      assert.deepEqual((await integracaoRepo.estabelecimentosAtivos(tx, c.empresa)).map((u) => u.id).sort(), [u1, u2].sort());
      const ev = pendencia(dia(420), "14:00", "18:00");
      // Mesma empresa, mesmo horário, unidades habilitadas diferentes: as duas reservas passam pelos gatilhos.
      await integrar(s, coreNativo, a, c, (await importacao(a, c, ev)).id, decisoes(c, ev, naoConferido, u1));
      await integrar(s, coreNativo, a, c, (await importacao(a, c, ev)).id, decisoes(c, ev, naoConferido, u2));
      await validarAgora(a);
      assert.deepEqual([await periodo(a, c, ev.data, { empresaId: c.empresa, estabelecimentoId: u1 }), await periodo(a, c, ev.data, { empresaId: c.empresa, estabelecimentoId: u2 })],
        ["INDISPONIVEL", "INDISPONIVEL"]);
      // Mesma unidade: o serviço recusa; o banco recusa bloqueio sobre a reserva e remarcação para cima dela.
      await assert.rejects(integrar(s, coreNativo, a, c, (await importacao(a, c, ev)).id, decisoes(c, ev, naoConferido, u1)), /ocupado/i);
      await a.query("SAVEPOINT mesma");
      await assert.rejects(repo.criarBloqueioAgenda({ data: ev.data, horarioInicio: "15:00", horarioFim: "16:00", motivo: "Sobre a festa", empresaId: c.empresa, estabelecimentoId: u1 }, tx),
        /Bloqueio conflita com contratação vigente/);
      await a.query("ROLLBACK TO SAVEPOINT mesma");
      const g = pendencia(dia(421), "14:00", "18:00");
      const rG = await integrar(s, coreNativo, a, c, (await importacao(a, c, g)).id, decisoes(c, g, naoConferido, u1));
      await validarAgora(a);
      const fG = (await a.query(`SELECT fechamento_id FROM contratos WHERE id = $1`, [rG.contratoId])).rows[0].fechamento_id;
      await a.query("SAVEPOINT remarca");
      await a.query(`UPDATE fechamentos SET data_evento = $2::date WHERE id = $1`, [fG, ev.data]);
      await assert.rejects(validarAgora(a), /Conflito/, "o banco recusa conflito na mesma unidade mesmo sem o serviço");
      await a.query("ROLLBACK TO SAVEPOINT remarca");
      // Unidade sem habilitação: integração não a oferece, o banco recusa gravação nela.
      await assert.rejects(integrar(s, coreNativo, a, c, (await importacao(a, c, g)).id, decisoes(c, g, naoConferido, u3)), /Unidade não encontrada/);
      await assert.rejects(bruto(c, dia(422), u3), /não elegível para agenda/);
      await a.query("ROLLBACK TO SAVEPOINT remarca");
      // Unidade sem reserva no horário: livre.
      const h = pendencia(dia(423), "14:00", "18:00");
      await integrar(s, coreNativo, a, c, (await importacao(a, c, h)).id, decisoes(c, h, naoConferido, u2));
      assert.deepEqual([await periodo(a, c, h.data, { empresaId: c.empresa, estabelecimentoId: u1 }), await periodo(a, c, h.data, { empresaId: c.empresa, estabelecimentoId: u2 }), await periodo(a, c, h.data, empresa(c))],
        ["DISPONIVEL", "INDISPONIVEL", "INDISPONIVEL"]);
      await validarAgora(a);
      await a.query("ROLLBACK");
    });

    await t.test("D6 (opção A): revogação = suspensão administrativa — reservas preservadas; novas, remarcação, bloqueio e turno recusados; histórico imutável", async () => {
      await a.query("BEGIN");
      const c = await cenario(a, 2);
      const [u1] = c.unidades;
      const rep = await representante(a, c);
      const tx = executor(a);
      await ua.habilitarUnidadeAgenda(tx, rep, u1, "Abertura da unidade 1", ctxAgenda(), auditar);
      const ev = pendencia(dia(425), "14:00", "18:00");
      const f2 = pendencia(dia(426), "14:00", "18:00");
      const r1 = await integrar(s, coreNativo, a, c, (await importacao(a, c, ev)).id, decisoes(c, ev, naoConferido, u1));
      await integrar(s, coreNativo, a, c, (await importacao(a, c, f2)).id, decisoes(c, f2, naoConferido, u1));
      const bloqueioAntes = await repo.criarBloqueioAgenda({ data: dia(427), diaInteiro: true, motivo: "Manutenção", empresaId: c.empresa, estabelecimentoId: u1 }, tx);
      await validarAgora(a);
      await assert.rejects(ua.revogarUnidadeAgenda(tx, c.tenant, u1, "Reforma no salão", ctxAgenda(), auditar), (e: { code?: string }) => e.code === "PAPEL_NAO_AUTORIZADO");
      await assert.rejects(ua.revogarUnidadeAgenda(tx, rep, u1, "ab", ctxAgenda(), auditar), (e: { code?: string }) => e.code === "MOTIVO_OBRIGATORIO");
      const revogada = await ua.revogarUnidadeAgenda(tx, rep, u1, "Reforma no salão", ctxAgenda(), auditar);
      assert.equal(revogada.reservasFuturasPreservadas, 2);
      await validarAgora(a);
      const f1 = (await a.query(`SELECT f.id, f.status, f.estabelecimento_id::text u, kidmais019_ocupa(f.id) ocupa FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id WHERE k.id = $1`, [r1.contratoId])).rows[0];
      assert.deepEqual([f1.status, f1.u, f1.ocupa], ["CONFIRMADO", u1, true], "reserva preservada, na mesma unidade, ocupando");
      assert.equal(await periodo(a, c, ev.data, { empresaId: c.empresa, estabelecimentoId: u1 }), "INDISPONIVEL", "continua ocupando a unidade");
      await a.query("SAVEPOINT r");
      await assert.rejects(bruto(c, dia(428), u1), /não elegível para agenda/, "nova contratação na unidade revogada");
      await a.query("ROLLBACK TO SAVEPOINT r");
      await assert.rejects(a.query(`UPDATE fechamentos SET data_evento = $2::date WHERE id = $1`, [f1.id, dia(429)]), /alterar data ou horário exige unidade habilitada/);
      await a.query("ROLLBACK TO SAVEPOINT r");
      await assert.rejects(a.query(`UPDATE fechamentos SET horario_inicio = '15:00' WHERE id = $1`, [f1.id]), /alterar data ou horário exige unidade habilitada/);
      await a.query("ROLLBACK TO SAVEPOINT r");
      await a.query(`UPDATE fechamentos SET observacoes_equipe = 'Recado da equipe' WHERE id = $1`, [f1.id]);
      await validarAgora(a);
      await assert.rejects(repo.criarBloqueioAgenda({ data: dia(430), diaInteiro: true, motivo: "Novo", empresaId: c.empresa, estabelecimentoId: u1 }, tx), /não elegível para agenda/);
      await a.query("ROLLBACK TO SAVEPOINT r");
      assert.equal(await repo.desativarBloqueioAgendaPorId(bloqueioAntes.id, tx, { empresaId: c.empresa, estabelecimentoId: u1 }), true, "bloqueio antigo pode ser desativado");
      // Histórico imutável: nem segunda revogação, nem alteração, nem exclusão.
      const hist = (await a.query(`SELECT id, revogada_por::text por, motivo_revogacao FROM agenda_062_unidades_habilitacao WHERE estabelecimento_id = $1`, [u1])).rows;
      assert.deepEqual(hist.map((x) => [x.por, x.motivo_revogacao]), [[rep.usuarioId, "Reforma no salão"]]);
      await a.query("SAVEPOINT h");
      await assert.rejects(a.query(`UPDATE agenda_062_unidades_habilitacao SET motivo_habilitacao = 'Outro motivo' WHERE id = $1`, [hist[0].id]), /só a revogação \(uma vez\)/);
      await a.query("ROLLBACK TO SAVEPOINT h");
      await assert.rejects(a.query(`DELETE FROM agenda_062_unidades_habilitacao WHERE id = $1`, [hist[0].id]), /histórico imutável/);
      await a.query("ROLLBACK TO SAVEPOINT h");
      assert.equal((await a.query(`SELECT (dados_depois->>'reservasFuturasPreservadas')::int n FROM auditoria WHERE acao = 'AGENDA_UNIDADE_REVOGADA' AND entidade_id = $1`, [u1])).rows[0].n, 2);
      // Nova habilitação (nova linha) libera de novo a remarcação.
      await ua.habilitarUnidadeAgenda(tx, rep, u1, "Reforma concluída", ctxAgenda(), auditar);
      await a.query(`UPDATE fechamentos SET data_evento = $2::date WHERE id = $1`, [f1.id, dia(431)]);
      await validarAgora(a);
      assert.equal((await a.query(`SELECT count(*)::int n FROM agenda_062_unidades_habilitacao WHERE estabelecimento_id = $1`, [u1])).rows[0].n, 2);
      await a.query("ROLLBACK");
    });

    await t.test("D6 (opção A): unidade revogada ainda aceita correção sem mudar horário, conferência financeira e cancelamento nativos", async () => {
      await a.query("BEGIN");
      const c = await cenario(a, 1);
      const [u1] = c.unidades;
      const rep = await representante(a, c);
      const tx = executor(a);
      await ua.habilitarUnidadeAgenda(tx, rep, u1, "Abertura da unidade 1", ctxAgenda(), auditar);
      const ev1 = pendencia(dia(434), "14:00", "18:00");
      const ev2 = pendencia(dia(435), "14:00", "18:00");
      const imp1 = await importacao(a, c, ev1);
      const r1 = await integrar(s, coreNativo, a, c, imp1.id, decisoes(c, ev1, naoConferido, u1));
      const r2 = await integrar(s, coreNativo, a, c, (await importacao(a, c, ev2)).id, decisoes(c, ev2, naoConferido, u1));
      await validarAgora(a);
      await ua.revogarUnidadeAgenda(tx, rep, u1, "Suspensão administrativa", ctxAgenda(), auditar);
      await validarAgora(a);
      const fechamento = async (contratoId: string) => (await a.query(`SELECT f.id, f.status, f.tema_festa, f.estabelecimento_id::text u, kidmais019_ocupa(f.id) ocupa
          FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id WHERE k.id = $1`, [contratoId])).rows[0];
      // 1. Correção sem mudança de agenda: o serviço regrava data/horário IGUAIS junto com o campo corrigido.
      const f1 = await fechamento(r1.contratoId);
      await a.query(`UPDATE fechamentos SET tema_festa = 'Circo e palhaços', data_evento = data_evento, horario_inicio = horario_inicio, horario_fim = horario_fim WHERE id = $1`, [f1.id]);
      await validarAgora(a);
      assert.equal((await fechamento(r1.contratoId)).tema_festa, "Circo e palhaços", "correção aplicada na unidade revogada");
      // 2. Operação financeira legítima: conferência posterior dos pagamentos pelo serviço nativo (recebimento no ledger).
      const simF = await s.simularFinanceiro(tx, c.tenant as never, imp1.id, PARCIAL(), dia(0));
      if (simF.conferido) throw new Error("inesperado");
      const ctxIntegracao = { usuarioId: c.usuario, token: c.token, requestId: randomUUID(), ip: null, userAgent: "h062" };
      await s.conferirFinanceiro(tx, c.tenant as never, ctxIntegracao, imp1.id, { financeiro: PARCIAL(), resumoHash: simF.resumoHash, chave: randomUUID() }, dia(0), coreNativo as never);
      await validarAgora(a);
      assert.equal((await a.query(`SELECT count(*)::int n FROM pagamento_recebimentos rec JOIN pagamentos p ON p.id = rec.pagamento_id
          JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = $1 AND rec.status = 'CONFIRMADO'`, [r1.contratoId])).rows[0].n, 1, "recebimento registrado");
      // 3. Cancelamento nativo da contratação (Gestão com FESTA_CORRIGIR): libera o horário; a unidade segue revogada.
      await a.query(`INSERT INTO festa_membership_capacidades (empresa_id, membership_id, capacidade, concedido_por, motivo) VALUES ($1, $2, 'FESTA_CORRIGIR', $3, 'Gestão sintética')`,
        [c.empresa, rep.membershipId, rep.usuarioId]);
      const { cancelarContratacaoDaFesta } = carregar<typeof import("../contratos/services/cancelamento.service.ts")>("lib/contratos/services/cancelamento.service.ts");
      await cancelarContratacaoDaFesta(tx, r2.contratoId, { usuario_id: rep.usuarioId, nome: "Representante 062" } as never, "Cliente desistiu", randomUUID(),
        { requestId: randomUUID(), userAgent: "h062" }, { membershipId: rep.membershipId, empresaId: c.empresa, papel: rep.papelAtual });
      await validarAgora(a);
      assert.equal((await a.query(`SELECT status FROM contratos WHERE id = $1`, [r2.contratoId])).rows[0].status, "CANCELADO");
      assert.equal((await fechamento(r2.contratoId)).ocupa, false, "cancelada não ocupa mais");
      // A reserva preservada continua na unidade e ocupando; nada disso reabilitou a unidade.
      const depois = await fechamento(r1.contratoId);
      assert.deepEqual([depois.u, depois.ocupa], [u1, true]);
      await assert.rejects(bruto(c, dia(436), u1), /não elegível para agenda/);
      await a.query("ROLLBACK");
    });

    await t.test("D6 (opção A): revogação concorrente com contratação na unidade — a revogação espera; o que vem depois é recusado", async () => {
      await a.query("BEGIN");
      const c = await cenario(a, 1);
      const rep = await representante(a, c);
      await ua.habilitarUnidadeAgenda(executor(a), rep, c.unidades[0], "Abertura da unidade", ctxAgenda(), auditar);
      await a.query("COMMIT");
      await a.query("BEGIN");
      await bruto(c, dia(432), c.unidades[0]);
      await b.query("BEGIN");
      await b.query("SET LOCAL lock_timeout = '2s'");
      await assert.rejects(ua.revogarUnidadeAgenda(executor(b), rep, c.unidades[0], "Suspensão administrativa", ctxAgenda(), auditar), /lock timeout|canceling statement/i,
        "a revogação espera a contratação em andamento");
      await b.query("ROLLBACK");
      await a.query("COMMIT");
      await b.query("BEGIN");
      await ua.revogarUnidadeAgenda(executor(b), rep, c.unidades[0], "Suspensão administrativa", ctxAgenda(), auditar);
      await b.query("COMMIT");
      await a.query("BEGIN");
      await assert.rejects(bruto(c, dia(433), c.unidades[0]), /não elegível para agenda/, "depois da revogação, nova contratação é recusada");
      await a.query("ROLLBACK");
    });

    await t.test("isolamento por empresa: mesma empresa conflita; empresas diferentes no mesmo horário integram e passam pelos gatilhos", async () => {
      await a.query("BEGIN");
      const cA = await cenario(a, 1);
      const cB = await cenario(a, 1);
      const cC = await cenario(a, 1);
      const ev = pendencia(dia(430), "14:00", "18:00");
      await integrar(s, coreNativo, a, cA, (await importacao(a, cA, ev)).id, decisoes(cA, ev, naoConferido));
      await assert.rejects(integrar(s, coreNativo, a, cA, (await importacao(a, cA, ev)).id, decisoes(cA, ev, naoConferido)), /ocupado/i, "mesma empresa");
      const rB = await integrar(s, coreNativo, a, cB, (await importacao(a, cB, ev)).id, decisoes(cB, ev, naoConferido));
      await validarAgora(a);
      await a.query("SELECT public.kidmais019_validar_destino($1::uuid)", [rB.contratoId]);
      assert.deepEqual([await periodo(a, cA, ev.data, empresa(cA)), await periodo(a, cB, ev.data, empresa(cB)), await periodo(a, cC, ev.data, empresa(cC))],
        ["INDISPONIVEL", "INDISPONIVEL", "DISPONIVEL"]);
      assert.equal(await periodo(a, cC, ev.data), "INDISPONIVEL", "sem escopo (só uso interno conservador): visão global");
      await a.query("SAVEPOINT bloq");
      await assert.rejects(repo.criarBloqueioAgenda({ data: ev.data, horarioInicio: "15:00", horarioFim: "16:00", motivo: "Sobre a festa", empresaId: cA.empresa }, executor(a)),
        /Bloqueio conflita com contratação vigente/);
      await a.query("ROLLBACK TO SAVEPOINT bloq");
      await repo.criarBloqueioAgenda({ data: ev.data, horarioInicio: "15:00", horarioFim: "16:00", motivo: "Outra empresa livre", empresaId: cC.empresa }, executor(a));
      await validarAgora(a);
      await a.query("ROLLBACK");
    });

    await t.test("bloqueios: da empresa, de outra empresa e global sem dono; desativação respeita o dono", async () => {
      await a.query("BEGIN");
      const c = await cenario(a, 1);
      const cB = await cenario(a, 1);
      const tx = executor(a);
      const [d1, d2] = [dia(450), dia(451)];
      await repo.criarBloqueioAgenda({ data: d1, diaInteiro: true, motivo: "Empresa A", empresaId: c.empresa }, tx);
      const global = await id(a, `INSERT INTO bloqueios_agenda (data, dia_inteiro, motivo) VALUES ($1::date, true, 'Legado sem dono') RETURNING id`, [d2]);
      const ev = (d: string) => pendencia(d, "14:00", "18:00");
      await assert.rejects(integrar(s, coreNativo, a, c, (await importacao(a, c, ev(d1))).id, decisoes(c, ev(d1), naoConferido)), /bloqueado/i);
      await integrar(s, coreNativo, a, cB, (await importacao(a, cB, ev(d1))).id, decisoes(cB, ev(d1), naoConferido));
      await assert.rejects(integrar(s, coreNativo, a, cB, (await importacao(a, cB, ev(d2))).id, decisoes(cB, ev(d2), naoConferido)), /bloqueado/i, "sem dono = global (pendência D3)");
      await validarAgora(a);
      await assert.rejects(repo.desativarBloqueioAgendaPorId(global, tx, empresa(c)), (e: { code?: string }) => e.code === "BLOQUEIO_SEM_DONO");
      const deB = await repo.criarBloqueioAgenda({ data: dia(453), diaInteiro: true, motivo: "De B", empresaId: cB.empresa }, tx);
      assert.equal(await repo.desativarBloqueioAgendaPorId(deB.id, tx, empresa(c)), false, "outra empresa: não encontrado");
      assert.equal(await repo.desativarBloqueioAgendaPorId(deB.id, tx, empresa(cB)), true);
      await a.query("ROLLBACK");
    });

    await t.test("rollback SUAVE da 062 e reaplicação: agenda global de volta, escopo gravado preservado e reaproveitado", async () => {
      await a.query("BEGIN");
      const c = await cenario(a, 1);
      const ev = pendencia(dia(460), "14:00", "18:00");
      await integrar(s, coreNativo, a, c, (await importacao(a, c, ev)).id, decisoes(c, ev, naoConferido));
      await a.query("COMMIT");
      // Turno ativo por empresa bloqueia o rollback (entraria na agenda global de todas).
      await a.query(`INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao, empresa_id) VALUES ('TURNO_EMPRESA_062', 'Turno da empresa', '11:00', '15:00', 98, $1::uuid)`, [c.empresa]);
      await assert.rejects(a.query(ler("database/rollback/20261002_062_agenda_empresa_unidade_down.sql")), /turno ativo por empresa/);
      await a.query("ROLLBACK");
      await a.query(`UPDATE configuracao_agenda SET ativo = false WHERE codigo = 'TURNO_EMPRESA_062'`);
      await a.query(ler("database/rollback/20261002_062_agenda_empresa_unidade_down.sql"));
      const depois = (await a.query(`SELECT to_regprocedure('public.kidmais062_ocupacoes_escopo(date,date)') IS NULL sem_regras,
          (SELECT empresa_id::text FROM configuracao_agenda WHERE codigo = 'TURNO_EMPRESA_062') turno_da_empresa`)).rows[0];
      assert.deepEqual({ ...depois }, { sem_regras: true, turno_da_empresa: c.empresa }, "suave: regras removidas, escopo gravado preservado");
      await festaValida(a);
      await a.query("BEGIN");
      assert.equal(await integracaoRepo.integracaoDisponivel(executor(a)), false, "sem a 062 a integração volta a ficar indisponível");
      const outra = await cenario(a, 1);
      assert.equal(await periodo(a, outra, ev.data, empresa(outra)), "INDISPONIVEL", "agenda global de volta (conservadora)");
      await a.query("ROLLBACK");
      await assert.rejects(a.query(ler("database/checks/20261002_062_postcheck.sql")), /postcheck 062/);
      await a.query("ROLLBACK");
      await instalar062(a);
      await festaValida(a);
      await a.query("BEGIN");
      const outra2 = await cenario(a, 1);
      assert.equal(await periodo(a, outra2, ev.data, empresa(outra2)), "DISPONIVEL", "reaplicada: isolamento por empresa volta a valer");
      assert.equal(await periodo(a, c, ev.data, empresa(c)), "INDISPONIVEL");
      await a.query("ROLLBACK");
    });

    await t.test("concorrência: fluxo nativo (bloqueio) × importação na mesma empresa — o segundo espera o lock e encontra o conflito", async () => {
      await a.query("BEGIN");
      const c = await cenario(a, 1);
      const cB = await cenario(a, 1);
      const s1 = pendencia(dia(470), "14:00", "18:00");
      const s2 = pendencia(dia(471), "14:00", "18:00");
      const imp1 = await importacao(a, c, s1);
      const imp2 = await importacao(a, c, s2);
      const impB = await importacao(a, cB, s1);
      await a.query("COMMIT");
      // Importação primeiro: o bloqueio nativo espera o lock da data e depois é recusado.
      await a.query("BEGIN");
      await integrar(s, coreNativo, a, c, imp1.id, decisoes(c, s1, naoConferido));
      await b.query("BEGIN");
      await b.query("SET LOCAL lock_timeout = '2s'");
      await assert.rejects(repo.criarBloqueioAgenda({ data: s1.data, diaInteiro: true, motivo: "Concorrente", empresaId: c.empresa }, executor(b)), /lock timeout|canceling statement/i);
      await b.query("ROLLBACK");
      await a.query("COMMIT");
      await b.query("BEGIN");
      await assert.rejects(repo.criarBloqueioAgenda({ data: s1.data, diaInteiro: true, motivo: "Concorrente", empresaId: c.empresa }, executor(b)), /Bloqueio conflita com contratação vigente/);
      await b.query("ROLLBACK");
      // Bloqueio nativo primeiro: a importação espera o lock e depois encontra o bloqueio.
      await b.query("BEGIN");
      await repo.criarBloqueioAgenda({ data: s2.data, diaInteiro: true, motivo: "Primeiro", empresaId: c.empresa }, executor(b));
      await a.query("BEGIN");
      await a.query("SET LOCAL lock_timeout = '2s'");
      await assert.rejects(integrar(s, coreNativo, a, c, imp2.id, decisoes(c, s2, naoConferido)), /lock timeout|canceling statement/i);
      await a.query("ROLLBACK");
      await b.query("COMMIT");
      await a.query("BEGIN");
      await assert.rejects(integrar(s, coreNativo, a, c, imp2.id, decisoes(c, s2, naoConferido)), /bloqueado/i);
      await a.query("ROLLBACK");
      // Outra empresa na mesma data: o lock é por data (mais grosso que o recurso), então ESPERA quem segura a data;
      // depois integra sem conflito (recurso diferente). Espera, nunca erro de agenda.
      await b.query("BEGIN");
      await b.query("SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda:' || $1::text, 0))", [s1.data]);
      await a.query("BEGIN");
      await a.query("SET LOCAL lock_timeout = '2s'");
      await assert.rejects(integrar(s, coreNativo, a, cB, impB.id, decisoes(cB, s1, naoConferido)), /lock timeout|canceling statement/i);
      await a.query("ROLLBACK");
      await b.query("ROLLBACK");
      await a.query("BEGIN");
      await integrar(s, coreNativo, a, cB, impB.id, decisoes(cB, s1, naoConferido));
      await validarAgora(a);
      await a.query("COMMIT");
      // Reservas simultâneas em recursos diferentes gravadas: o rollback da 062 recusa (global as tornaria conflitantes).
      await assert.rejects(a.query(ler("database/rollback/20261002_062_agenda_empresa_unidade_down.sql")), /reservas simultâneas em recursos diferentes/);
      await a.query("ROLLBACK");
    });

    await t.test("remarcação histórica: o passado sai da detecção; remarcado, ocupa o recurso da PRÓPRIA empresa", async () => {
      await a.query("BEGIN");
      const c = await cenario(a, 1);
      const outra = await cenario(a, 1);
      const passado = pendencia(dia(-200), "14:00", "18:00");
      const pago = { situacao: "PAGO", parcelas: [{ valorCentavos: 500000, vencimento: dia(-210), recebimento: { data: dia(-209), forma: "DINHEIRO" } }] };
      const rp = await integrar(s, coreNativo, a, c, (await importacao(a, c, passado)).id, decisoes(c, passado, pago));
      const f = pendencia(dia(480), "14:00", "18:00");
      const g = pendencia(dia(481), "14:00", "18:00");
      await integrar(s, coreNativo, a, outra, (await importacao(a, outra, f)).id, decisoes(outra, f, naoConferido));
      await integrar(s, coreNativo, a, c, (await importacao(a, c, g)).id, decisoes(c, g, naoConferido));
      await validarAgora(a);
      const fp = (await a.query(`SELECT f.id, kidmais061_historico_passado(f.id) historico,
          EXISTS(SELECT 1 FROM kidmais062_ocupacoes_escopo(f.data_evento, f.data_evento) o WHERE o.fechamento_id = f.id) na_agenda
        FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id WHERE k.id = $1`, [rp.contratoId])).rows[0];
      assert.deepEqual([fp.historico, fp.na_agenda], [true, false], "passado integrado: fora da detecção");
      // Para o horário ocupado por OUTRA empresa: permitido (recurso diferente); passa a ocupar a própria empresa.
      await a.query("SAVEPOINT r1");
      await a.query(`UPDATE fechamentos SET data_evento = $2::date WHERE id = $1`, [fp.id, f.data]);
      await validarAgora(a);
      assert.equal(await periodo(a, c, f.data, empresa(c)), "INDISPONIVEL", "remarcado: ocupa a agenda da empresa");
      await a.query("ROLLBACK TO SAVEPOINT r1");
      // Para o horário ocupado pela MESMA empresa: recusado pelo banco.
      await a.query("SAVEPOINT r2");
      await a.query(`UPDATE fechamentos SET data_evento = $2::date WHERE id = $1`, [fp.id, g.data]);
      await assert.rejects(validarAgora(a), /Conflito/);
      await a.query("ROLLBACK TO SAVEPOINT r2");
      await a.query("ROLLBACK");
    });

    await t.test("rollback e repetição: falha no meio não grava nada; repetir depois do commit não duplica recebimentos", async () => {
      await a.query("BEGIN");
      const c = await cenario(a, 1);
      const ev = pendencia(dia(490), "14:00", "18:00");
      const imp = await importacao(a, c, ev);
      await a.query("SAVEPOINT falha");
      const quebrado = { ...coreNativo, registrarRecebimento: async () => { throw new Error("falha simulada no recebimento"); } };
      await assert.rejects(integrar(s, quebrado, a, c, imp.id, decisoes(c, ev, PARCIAL())), /falha simulada/);
      await a.query("ROLLBACK TO SAVEPOINT falha");
      assert.equal((await a.query(`SELECT count(*)::int n FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id])).rows[0].n, 0);
      const chave = randomUUID();
      const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, PARCIAL()), chave);
      await a.query("COMMIT");
      const contar = async (db: DbExecutor) => (await db.query<{ n: number }>(`SELECT count(*)::int n FROM pagamento_recebimentos rec JOIN pagamentos p ON p.id = rec.pagamento_id
          JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = $1 AND rec.status = 'CONFIRMADO'`, [r.contratoId])).rows[0].n;
      assert.equal(await contar(executor(a)), 1);
      // Repetição "depois do timeout" (resposta perdida): mesma chave e mesmo conteúdo com outra chave devolvem o gravado.
      await b.query("BEGIN");
      const ctx = { usuarioId: c.usuario, token: c.token, requestId: randomUUID(), ip: null, userAgent: "h062" };
      // "Mesmo conteúdo" = o mesmo resumoHash que o operador revisou (gravado no vínculo); chave nova não duplica.
      const revisado = (await b.query<{ payload_hash: string }>(`SELECT payload_hash FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id])).rows[0].payload_hash;
      for (const pedido of [{ resumoHash: "0".repeat(64), chave }, { resumoHash: revisado, chave: randomUUID() }]) {
        const rep = await s.confirmarIntegracao(executor(b), c.tenant as never, ctx, imp.id, { decisoes: decisoes(c, ev, PARCIAL()), ...pedido }, dia(0), coreNativo as never);
        assert.equal(rep.reutilizado, true);
      }
      // Conteúdo diferente (outro resumo) com outra chave: recusado, sem escrita.
      await assert.rejects(s.confirmarIntegracao(executor(b), c.tenant as never, ctx, imp.id, { decisoes: decisoes(c, ev, PARCIAL()), resumoHash: "0".repeat(64), chave: randomUUID() }, dia(0), coreNativo as never),
        (e: { code?: string }) => e.code === "IMPORTACAO_JA_INTEGRADA");
      assert.equal(await contar(executor(b)), 1, "nenhum recebimento duplicado");
      await b.query("ROLLBACK");
    });
  } finally {
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(a);
  }
});
