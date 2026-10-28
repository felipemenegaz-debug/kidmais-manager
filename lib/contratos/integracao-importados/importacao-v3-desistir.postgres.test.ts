import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, carregar, cenario, cpfValido, ctxIntegracao, decisoes, dia, executor, id, importacao, PARCIAL, poolNaTransacao, validarAgora,
  type Cenario, type Servico,
} from "../../../scripts/integracao-importados-test-support.ts";

/**
 * S-E restante (plano rev. 3 + parecer focal, critérios CA-1..CA-5) no PostgreSQL DESCARTÁVEL, pelos serviços reais:
 * - importação V3 em unidade POR_SALAO: o operador escolhe o salão; a versão conferida é V3 com o salão e a escolha estrita
 *   grava fechamentos.salao_id; festa em OUTRO salão no mesmo horário não recusa, o mesmo salão recusa (CA-1);
 * - modelos SEPARADOS: 106 (094+100, o estado de staging: limite do dia, intervalo e bloqueio) e 098 (094+098: interseção
 *   do salão combinado com os membros). Nenhum caso presume as duas regras juntas;
 * - corrida pelos SERVIÇOS diretos, duas conexões e COMMIT: B segura SÓ a trava da data (kidmais:agenda:<data>) e inativa o
 *   salão; A espera exatamente nessa trava (pg_blocking_pids + o advisory lock não concedido = o da data que B segura, não
 *   a trava de duplicidade) e, ao seguir, recusa SALAO_INDISPONIVEL sem escrever (CA-2);
 * - Human Gate do PRODUTO de ponta a ponta (rodada 3): PDF → atenderImportacao (abrir, revisar, preparar = acao.verificar +
 *   preview) → atenderOperacao (acao.executar com a porta da rota, portaImportacaoCom, e a classificação final), cada rota
 *   com a própria withTenantTransaction. CRIAR e VINCULAR: o salão deixa de servir DEPOIS da preparação (B segura a trava
 *   da data); e a recusa estrita DEPOIS de fechamento/contrato/versão gravados. A prova é a RESPOSTA (409
 *   SALAO_INDISPONIVEL), a operação não EXECUTADA e a ausência de efeitos persistidos, lida por outra conexão (CA-2/CA-4);
 * - D2: contrato importado antes da unidade usar salão continua V1 (nada fixado, troca direta);
 * - "Desistir da troca" (cancelar_revisao com esperado): igual cancela; revisão trocada por outra conexão (no modelo 098 a
 *   revisão é hash v1: trocar o salão não muda o contador), contador, estado, destino igual ao fixado → 409 sem cancelar;
 *   repetição com o mesmo motivo e autor → reutilizado; outro motivo ou autor → recusa (CA-3).
 */
let a: Client;
type Operar = (versaoId: string, input: Record<string, unknown>, token: string, ctx: Record<string, unknown>, empresa: string) => Promise<unknown>;
const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "se-v3-desistir" });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const HORA = { inicio: "14:00", fim: "18:00" };

const servico = () => carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
const core = () => carregar<typeof import("./composicao.ts")>("lib/contratos/integracao-importados/composicao.ts").coreNativo;
const modelo098 = async (db: Client) => (await db.query<{ ok: boolean }>(`SELECT to_regprocedure('public.kidmais098_salao_elegivel(uuid)') IS NOT NULL ok`)).rows[0]!.ok;

async function configurar(db: Client, c: Cenario, limite: number | null = null, intervalo = 0) {
  await db.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                  VALUES ($1::uuid, 'FIXO', 'POR_SALAO', $2, $3, $4::uuid)`, [c.empresa, limite, intervalo, c.usuario]);
}
const salao = (db: Client, c: Cenario, nome: string, ordem: number) =>
  id(db, `INSERT INTO agenda_saloes (empresa_id, nome, ordem, ativo) VALUES ($1::uuid, $2, $3, true) RETURNING id`, [c.empresa, nome, ordem]);

/** Simula e confirma pela porta real; devolve a simulação quando não está pronta (para ler o bloqueio). */
async function importarNoSalao(db: Client, c: Cenario, ev: { data: string; inicio: string; fim: string }, salaoId: string | undefined) {
  const s = servico();
  const imp = await importacao(db, c, ev);
  const d = decisoes(c, ev, PARCIAL(), null, undefined, salaoId);
  const sim = await s.simularIntegracao(executor(db), c.tenant as never, imp.id, d, dia(0));
  if (sim.integrada) throw Error("já integrada");
  if (!sim.pronto) return { sim, imp, d };
  const r = await s.confirmarIntegracao(executor(db), c.tenant as never, ctxIntegracao(c), imp.id, { decisoes: d, resumoHash: sim.resumoHash, chave: randomUUID() }, dia(0), core());
  return { sim, imp, d, r };
}

async function emTransacao<T>(corpo: () => Promise<T>, fim: "COMMIT" | "ROLLBACK" = "ROLLBACK") {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const r = await corpo();
    await a.query(fim);
    return r;
  } catch (e) {
    await a.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    restaurarAmbiente();
    restaurarPool();
  }
}

test.before(async () => {
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  a = await conectarDescartavel();
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("CA-1 (os dois modelos): V3 grava a versão 3 com o salão escolhido; outro salão no mesmo horário passa; o mesmo salão recusa; sem salão bloqueia", { timeout: 300_000 }, async () => {
  await emTransacao(async () => {
    const c = await cenario(a, 0);
    await configurar(a, c);
    const A = await salao(a, c, "Salão A", 1), B = await salao(a, c, "Salão B", 2);
    const ev = { data: dia(70), ...HORA };
    const semSalao = await importarNoSalao(a, c, ev, undefined);
    assert.ok(!semSalao.sim.integrada && semSalao.sim.bloqueios.includes("Escolha o salão da festa."), "D1: nada automático");
    const emA = await importarNoSalao(a, c, ev, A);
    assert.ok(emA.r && !emA.r.reutilizado, JSON.stringify(emA.sim));
    await validarAgora(a);
    const v = (await a.query<{ n: number; s: { schemaVersao: number; evento: { salao: { id: string; nome: string }; configuracaoAgendaId: string } }; salao: string }>(
      `SELECT cv.snapshot_schema_versao n, cv.snapshot s, f.salao_id::text salao FROM contratos k JOIN contrato_versoes cv ON cv.contrato_id = k.id JOIN fechamentos f ON f.id = k.fechamento_id WHERE k.id = $1::uuid`,
      [emA.r!.contratoId])).rows[0]!;
    assert.deepEqual([v.n, v.s.schemaVersao, v.s.evento.salao, v.salao], [3, 3, { id: A, nome: "Salão A" }, A]);
    assert.ok(v.s.evento.configuracaoAgendaId, "configuração congelada no V3");
    const exigido = carregar<typeof import("../services/salao-contrato.ts")>("lib/contratos/services/salao-contrato.ts");
    const vid = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1::uuid`, [emA.r!.contratoId])).rows[0]!.v;
    assert.deepEqual(await exigido.salaoExigidoDaFesta(executor(a), vid), { situacao: "EXIGIDO", salaoId: A }, "formalização/pagamento passam a exigir exatamente o Salão A");
    const emB = await importarNoSalao(a, c, ev, B);
    assert.ok(emB.r, `outro salão no mesmo horário passa: ${JSON.stringify(emB.sim)}`);
    const deNovoA = await importarNoSalao(a, c, ev, A);
    assert.equal(deNovoA.r, undefined);
    assert.ok(!deNovoA.sim.integrada && deNovoA.sim.bloqueios.some((b) => b.startsWith("Salão A não serve para esta festa")), JSON.stringify(deNovoA.sim));
    await validarAgora(a);
  });
});

test("CA-1 modelo 106 (094+100): bloqueio da agenda, limite de festas do dia e intervalo no mesmo salão", { timeout: 300_000 }, async (t) => {
  if (await modelo098(a)) { t.skip("modelo 098: as regras da 100 são provadas no modelo 106"); return; }
  await emTransacao(async () => {
    const c = await cenario(a, 0);
    await configurar(a, c, 1, 60);
    const A = await salao(a, c, "Salão A", 1), B = await salao(a, c, "Salão B", 2);
    const ev = { data: dia(71), ...HORA };
    assert.ok((await importarNoSalao(a, c, ev, A)).r);
    const limite = await importarNoSalao(a, c, { data: ev.data, inicio: "19:00", fim: "21:00" }, B);
    assert.ok(!limite.sim.integrada && limite.sim.bloqueios.some((b) => /limite de festas do dia/.test(b)), `limite do dia: ${JSON.stringify(limite.sim)}`);
    await a.query(`UPDATE agenda_escopo_config SET limite_festas_dia = NULL WHERE empresa_id = $1::uuid`, [c.empresa]);
    const intervalo = await importarNoSalao(a, c, { data: ev.data, inicio: "18:30", fim: "20:00" }, A);
    assert.ok(!intervalo.sim.integrada && intervalo.sim.bloqueios.some((b) => /intervalo mínimo/.test(b)), `intervalo no mesmo salão: ${JSON.stringify(intervalo.sim)}`);
    await a.query(`INSERT INTO bloqueios_agenda (empresa_id, data, dia_inteiro, ativo, motivo, criado_por_usuario_id) VALUES ($1::uuid, $2::date, true, true, 'Manutenção', $3::uuid)`, [c.empresa, dia(72), c.usuario]);
    const bloqueado = await importarNoSalao(a, c, { data: dia(72), ...HORA }, A);
    assert.ok(!bloqueado.sim.integrada && bloqueado.sim.bloqueios.includes("O horário está bloqueado na agenda. Escolha outro horário ou libere o bloqueio antes de integrar."));
  });
});

test("CA-1 modelo 098 (094+098): interseção do salão combinado com os membros nos dois sentidos", { timeout: 300_000 }, async (t) => {
  if (!(await modelo098(a))) { t.skip("modelo 106: a interseção de combinados é provada no modelo 098"); return; }
  await emTransacao(async () => {
    const c = await cenario(a, 0);
    await configurar(a, c);
    const A = await salao(a, c, "Salão A", 1), B = await salao(a, c, "Salão B", 2);
    const { criarSalaoCombinado } = carregar<typeof import("../../agenda/configuracao-unidade.ts")>("lib/agenda/configuracao-unidade.ts");
    const { id: AB } = await criarSalaoCombinado(executor(a), { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() },
      { estabelecimentoId: null, nome: "Salão inteiro", capacidadeConvidados: 200, membros: [B, A] });
    const ev = { data: dia(73), ...HORA };
    assert.ok((await importarNoSalao(a, c, ev, A)).r, "festa no membro A");
    const inteiro = await importarNoSalao(a, c, ev, AB);
    assert.ok(!inteiro.sim.integrada && inteiro.sim.bloqueios.some((b) => b.startsWith("Salão inteiro não serve")), "combinado com membro ocupado recusa");
    assert.ok((await importarNoSalao(a, c, ev, B)).r, "o outro membro, sem interseção, passa");
    const outroDia = { data: dia(74), ...HORA };
    assert.ok((await importarNoSalao(a, c, outroDia, AB)).r, "festa no combinado");
    const membro = await importarNoSalao(a, c, outroDia, B);
    assert.ok(!membro.sim.integrada && membro.sim.bloqueios.some((b) => b.startsWith("Salão B não serve")), "membro com o combinado ocupado recusa");
    await validarAgora(a);
  });
});

test("CA-2 corrida pelos serviços diretos: A espera exatamente na trava da data que B segura; depois recusa SALAO_INDISPONIVEL sem escrever", { timeout: 300_000 }, async () => {
  const b = await conectarDescartavel({ travar: false });
  const obs = await conectarDescartavel({ travar: false });
  const ev = { data: dia(75), ...HORA };
  try {
    const base = await emTransacao(async () => {
      const c = await cenario(a, 0);
      await configurar(a, c);
      const A = await salao(a, c, "Salão A", 1);
      const imp = await importacao(a, c, ev);
      return { c, A, imp };
    }, "COMMIT");
    const s = servico();
    const d = decisoes(base.c, ev, PARCIAL(), null, undefined, base.A);
    const sim = await s.simularIntegracao(executor(a), base.c.tenant as never, base.imp.id, d, dia(0));
    assert.ok(!sim.integrada && sim.pronto, JSON.stringify(sim));
    if (sim.integrada) return;
    const [pa, pb] = [(await a.query<{ p: number }>("SELECT pg_backend_pid() p")).rows[0]!.p, (await b.query<{ p: number }>("SELECT pg_backend_pid() p")).rows[0]!.p];
    // B: SÓ a trava da data (sem duplicidade nem unidade) e o salão inativado, sem COMMIT ainda.
    await b.query("BEGIN");
    const antes = new Set((await b.query<{ k: string }>(`SELECT classid || ':' || objid || ':' || objsubid k FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'`)).rows.map((r) => r.k));
    await b.query("SELECT public.kidmais_lock_datas_revisao(ARRAY[$1::date])", [ev.data]);
    const daData = (await b.query<{ k: string }>(`SELECT classid || ':' || objid || ':' || objsubid k FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'`)).rows.map((r) => r.k).filter((k) => !antes.has(k));
    assert.ok(daData.length >= 1, "a trava da data é um advisory lock");
    await b.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [base.A]);
    // A: confirmação pelo serviço direto (sem rota nem guarda de tenant) numa transação própria.
    const contagem = async () => (await obs.query<{ n: number }>(`SELECT count(*)::int n FROM contrato_importacoes WHERE importacao_id = $1::uuid`, [base.imp.id])).rows[0]!.n;
    const confirmacao = emTransacao(() => s.confirmarIntegracao(executor(a), base.c.tenant as never, ctxIntegracao(base.c), base.imp.id,
      { decisoes: d, resumoHash: sim.resumoHash, chave: randomUUID() }, dia(0), core()), "COMMIT").then(() => null, (e: unknown) => e);
    let esperou = false;
    for (let i = 0; i < 400 && !esperou; i++) {
      const r = (await obs.query<{ bloqueado: boolean; k: string | null }>(
        `SELECT $2::int = ANY (pg_blocking_pids($1::int)) bloqueado,
                (SELECT classid || ':' || objid || ':' || objsubid FROM pg_locks WHERE pid = $1::int AND NOT granted AND locktype = 'advisory' LIMIT 1) k`, [pa, pb])).rows[0]!;
      if (r.bloqueado) {
        assert.ok(r.k && daData.includes(r.k), `A espera no advisory lock da data (${daData.join(",")}), não em outro: ${r.k}`);
        esperou = true;
      } else await new Promise((fim) => setTimeout(fim, 25));
    }
    assert.ok(esperou, "espera de A por B observada");
    await b.query("COMMIT");
    const erro = await confirmacao;
    assert.equal((erro as { code?: string })?.code, "SALAO_INDISPONIVEL", msg(erro));
    assert.equal(await contagem(), 0, "nada escrito");
    assert.equal((await obs.query<{ n: number }>(`SELECT count(*)::int n FROM fechamentos WHERE empresa_id = $1::uuid`, [base.c.empresa])).rows[0]!.n, 0);
  } finally {
    await b.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(obs, false);
  }
});

/** Fotografia dos efeitos de negócio da empresa (e do cliente existente) para comparar antes × depois da confirmação do Gate. */
async function retratoGate(db: Client, empresa: string, existente: string, importacaoId: string | null) {
  return (await db.query(`SELECT
      (SELECT count(*)::int FROM clientes WHERE empresa_id = $1::uuid) clientes,
      (SELECT row_to_json(x) FROM (SELECT nome_completo, cpf, telefone, whatsapp, email, cep, logradouro, numero, bairro, cidade, uf, status, atualizado_em FROM clientes WHERE id = $2::uuid) x)::text existente,
      (SELECT row_to_json(x) FROM (SELECT status, cliente_id, versao, dados::text dados FROM ia_importacoes WHERE id = $3::uuid) x)::text importacao,
      (SELECT count(*)::int FROM fechamentos WHERE empresa_id = $1::uuid) fechamentos,
      (SELECT count(*)::int FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id WHERE f.empresa_id = $1::uuid) contratos,
      (SELECT count(*)::int FROM contrato_versoes v JOIN contratos k ON k.id = v.contrato_id JOIN fechamentos f ON f.id = k.fechamento_id WHERE f.empresa_id = $1::uuid) versoes,
      (SELECT count(*)::int FROM contrato_edicoes e JOIN contratos k ON k.id = e.contrato_id JOIN fechamentos f ON f.id = k.fechamento_id WHERE f.empresa_id = $1::uuid) edicoes,
      (SELECT count(*)::int FROM contrato_importacoes WHERE empresa_id = $1::uuid) vinculos,
      (SELECT count(*)::int FROM festas fe JOIN contratos k ON k.id = fe.contrato_id JOIN fechamentos f ON f.id = k.fechamento_id WHERE f.empresa_id = $1::uuid) festas,
      (SELECT count(*)::int FROM aniversariantes an JOIN clientes cl ON cl.id = an.cliente_id WHERE cl.empresa_id = $1::uuid) aniversariantes,
      (SELECT count(*)::int FROM pagamentos p JOIN contrato_versoes v ON v.id = p.contrato_versao_id JOIN contratos k ON k.id = v.contrato_id JOIN fechamentos f ON f.id = k.fechamento_id WHERE f.empresa_id = $1::uuid) pagamentos,
      (SELECT count(*)::int FROM eventos_historico_cliente h JOIN clientes cl ON cl.id = h.cliente_id WHERE cl.empresa_id = $1::uuid) historico,
      (SELECT count(*)::int FROM auditoria) auditoria`, [empresa, existente, importacaoId])).rows[0];
}

/** PDF sintético de contrato em papel (Helvetica, sem compressão), uma linha por Tj — o mesmo formato do apoio da feature DOCUMENT. */
function pdfContrato(paginas: string[][]) {
  const escapar = (s: string) => s.replace(/[\\()]/g, (x) => `\\${x}`);
  const objetos: string[] = [];
  const kids: number[] = [];
  paginas.forEach((linhas, i) => {
    const conteudo = linhas.map((l, k) => `BT /F1 10 Tf 1 0 0 1 50 ${750 - k * 16} Tm (${escapar(l)}) Tj ET`).join("\n");
    kids.push(4 + i * 2);
    objetos[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /Contents ${5 + i * 2} 0 R >>`;
    objetos[5 + i * 2] = `<< /Length ${Buffer.byteLength(conteudo, "latin1")} >>\nstream\n${conteudo}\nendstream`;
  });
  objetos[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objetos[2] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} /Resources << /Font << /F1 3 0 R >> >> >>`;
  objetos[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  const corpo = objetos.map((o, n) => (o ? `${n} 0 obj\n${o}\nendobj\n` : "")).join("");
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${corpo}%%EOF\n`, "latin1"));
}
const br = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const cpfFormatado = (d: string) => `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;

/**
 * O caminho do PRODUTO de ponta a ponta, com a fronteira transacional de cada rota (withTenantTransaction real):
 * envio do PDF (atenderDocumento) → importação aberta, campos revisados e "preparar" com a integração (atenderImportacao,
 * que roda acao.verificar e abre o Human Gate) → confirmação do Gate (atenderOperacao → acao.executar → Import Engine
 * + integração pela porta da rota, portaImportacaoCom, com traduzirRecusa e a classificação final da resposta).
 * O teste nunca faz rollback no lugar do produto: confere a resposta e os efeitos persistidos depois que ela volta.
 */
async function gateDoProduto(c: Cenario, cpf: string, ev: { data: string; inicio: string; fim: string }, salaoId: string, mudarEntre?: () => Promise<void>) {
  const tenantTx = carregar<typeof import("../../saas/provar-tenant.ts")>("lib/saas/provar-tenant.ts");
  const docs = carregar<typeof import("../../inteligencia/documentos/upload.ts")>("lib/inteligencia/documentos/upload.ts");
  const repoDocs = carregar<typeof import("../../importacao-contrato/repositorio-documentos.ts")>("lib/importacao-contrato/repositorio-documentos.ts");
  const revisao = carregar<typeof import("../../inteligencia/importacao/revisao.ts")>("lib/inteligencia/importacao/revisao.ts");
  const acoesMod = carregar<typeof import("../../inteligencia/acoes/modulo.ts")>("lib/inteligencia/acoes/modulo.ts");
  const operacoes = carregar<typeof import("../../inteligencia/acoes/operacoes.ts")>("lib/inteligencia/acoes/operacoes.ts");
  const acaoImp = carregar<typeof import("../../inteligencia/importacao/acao.ts")>("lib/inteligencia/importacao/acao.ts");
  const { repositorioOperacoesPostgres } = carregar<typeof import("../../ia-persistencia/operacoes.ts")>("lib/ia-persistencia/operacoes.ts");
  const rota = carregar<{ portaImportacaoCom(s: { atual(): Promise<{ usuario_id: string; autenticado_em: string }>; token(): string; userAgent(): string | null }): import("../../inteligencia/importacao/acao.ts").PortaImportacao }>(
    "app/api/admin/inteligencia/importacoes/composicao.ts");
  const sessaoId = (await a.query<{ id: string }>(`SELECT id::text FROM sessoes_administrativas WHERE usuario_id = $1::uuid ORDER BY autenticado_em DESC LIMIT 1`, [c.usuario])).rows[0]!.id;
  const sessao = { id: sessaoId, usuario_id: c.usuario, papel: "ADMINISTRATIVO" };
  const env = { INTELIGENCIA_ENABLED: "true", AI_CONTRACT_IMPORT_ENABLED: "true", CONTRACT_IMPORT_INTEGRATION_ENABLED: "true" };
  const base = {
    env, autenticar: async () => sessao, withTenantTransaction: tenantTx.withTenantTransaction, agora: () => new Date(), requestId: randomUUID,
    registrar: () => undefined, relogio: () => 0,
  };
  const porta = rota.portaImportacaoCom({ atual: async () => ({ usuario_id: c.usuario, autenticado_em: new Date().toISOString() }), token: () => c.token, userAgent: () => "se-v3-gate" });
  const gate = { repositorio: repositorioOperacoesPostgres, agora: () => new Date(), novoId: randomUUID, ttlConfirmacaoSegundos: 600 };
  const acao = acaoImp.criarAcaoImportacao(porta);
  const depsImp = { ...base, importacao: porta, gate, acao } as never;
  const corpo = (r: { status: number; corpo: unknown }) => { assert.equal(r.status, 200, JSON.stringify(r.corpo)); return (r.corpo as { data: Record<string, unknown> }).data; };
  const linhas = [
    ["Contratante: Mariana Souza Lima", `CPF ${cpfFormatado(cpf)}`, "Telefone: (11) 98765-4321", `Data do evento: ${br(ev.data)}`, `Horário: ${ev.inicio} às ${ev.fim}`, "50 convidados", "Pacote: Festa Completa tabela 2019"],
    ["Valor do pacote: R$ 8.400,00", "Adicionais: R$ 500,00", "Valor total: R$ 8.900,00", `Entrada de R$ 2.900,00 em ${br(dia(-60))}`, `Parcela 1 de R$ 6.000,00 vencimento ${br(dia(30))}`],
  ];
  const documento = corpo(await docs.atenderDocumento({ empresaSolicitada: c.empresa, lerArquivo: async () => ({ nome: "contrato.pdf", tipo: "application/pdf", bytes: pdfContrato(linhas) }) },
    { ...base, documentos: { disponivel: repoDocs.documentosDisponiveis, registrarDocumento: repoDocs.registrarDocumento, registrarExtracao: repoDocs.registrarExtracao, ultimaExtracao: repoDocs.ultimaExtracao }, roteador: null } as never)) as { documentoId: string };
  const importar = async (pedido: object) => corpo(await revisao.atenderImportacao({ lerCorpo: async () => pedido, empresaSolicitada: c.empresa }, depsImp));
  let importacao = (await importar({ acao: "abrir", documentoId: documento.documentoId })).importacao as { id: string; versao: number; extracao: { secoes: Array<{ campos: Array<{ id: string; estado: string }> }> } };
  for (const campo of importacao.extracao.secoes.flatMap((s) => s.campos).filter((x) => x.estado === "PRECISA_REVISAO")) {
    importacao = (await importar({ acao: "revisar", importacaoId: importacao.id, versao: importacao.versao, campoId: campo.id, confirmarDivergencia: true })).importacao as typeof importacao;
  }
  const integracao = {
    situacaoContrato: "VIGENTE", estabelecimentoId: null, salaoId, pacoteReferenciaId: c.pacote, aniversariante: "Lia",
    evento: { data: ev.data, horarioInicio: ev.inicio, horarioFim: ev.fim, convidados: 50 }, valorContratadoCentavos: 890000, motivos: {},
    financeiro: { situacao: "NAO_CONFERIDO" }, outroContratoConfirmado: false, motivoOutroContrato: "", conferenciaDeclarada: true,
  };
  const simulada = await importar({ acao: "simular-completa", importacaoId: importacao.id, versao: importacao.versao, integracao });
  assert.ok(simulada.simulacao, `plano da importação não ficou pronto: ${JSON.stringify(simulada.plano)}`);
  const sim = simulada.simulacao as { pronto: boolean; bloqueios: string[]; resumoHash: string; planoHash: string; resumo: { agenda: { salao?: { id: string } } } };
  assert.ok(sim.pronto, JSON.stringify(sim.bloqueios));
  assert.equal(sim.resumo.agenda.salao?.id, salaoId, "o resumo do Gate traz o salão escolhido");
  // "preparar" roda acao.verificar (simulação de novo, mesmo hash) e abre o Human Gate com o preview.
  const preparo = await importar({ acao: "preparar", importacaoId: importacao.id, versao: importacao.versao, integracao, integracaoHash: sim.resumoHash, planoHash: sim.planoHash });
  const rascunho = (preparo.gate as { tipo: string; rascunho: { operacaoId: string; versao: number; payloadHash: string; campos: Array<{ id: string; valor: string | null }> } });
  assert.equal(rascunho.tipo, "preview");
  assert.ok(rascunho.rascunho.campos.some((x) => x.id === "salao"), "a linha do salão está no registro do Gate");
  // P3-R3-1: fotografia integral da importação depois do preparar e antes do clique.
  const importacaoAntesDoClique = await linhaImportacao(a, importacao.id);
  if (mudarEntre) await mudarEntre();
  const modulo = acoesMod.criarModuloAcoes([acao], gate);
  const resposta = await operacoes.atenderOperacao({ lerCorpo: async () => ({ operacaoId: rascunho.rascunho.operacaoId, versao: rascunho.rascunho.versao, payloadHash: rascunho.rascunho.payloadHash, decisao: "confirmar" }), empresaSolicitada: c.empresa } as never,
    { ...base, acoes: modulo } as never);
  return { resposta, importacaoId: importacao.id, operacaoId: rascunho.rascunho.operacaoId, importacaoAntesDoClique };
}
/**
 * Pool global ligado à conexão `a` SEM troca de BEGIN/COMMIT/ROLLBACK: cada rota abre e encerra a PRÓPRIA transação
 * (withTenantTransaction real), como no produto; o teste nunca faz o rollback no lugar dela.
 */
function poolNaConexao(db: Client) {
  const g = globalThis as { __kidmaisPgPool?: unknown };
  const anterior = g.__kidmaisPgPool;
  g.__kidmaisPgPool = { query: (sql: string, v?: unknown[]) => db.query(sql, v), connect: async () => ({ query: (sql: string, v?: unknown[]) => db.query(sql, v), release() {} }) };
  return () => { g.__kidmaisPgPool = anterior; };
}
/** A linha INTEIRA da importação (status, versão, cliente, dados, resultado…), para comparar antes do clique × depois da resposta. */
const linhaImportacao = async (db: Client, importacaoId: string) => (await db.query<{ l: string }>(`SELECT row_to_json(i)::text l FROM ia_importacoes i WHERE i.id = $1::uuid`, [importacaoId])).rows[0]?.l ?? null;
const estadoOperacao = async (db: Client, operacaoId: string) => (await db.query<{ estado: string }>(`SELECT estado FROM ia_operacoes WHERE id = $1::uuid`, [operacaoId])).rows[0]?.estado ?? null;

test("CA-2/CA-4 Human Gate do produto (CRIAR e VINCULAR): salão deixa de servir DEPOIS da preparação, na trava da data; resposta 409 SALAO_INDISPONIVEL, operação não EXECUTADA, nada persistido", { timeout: 300_000 }, async () => {
  for (const modo of ["CRIAR", "VINCULAR"] as const) {
    const b = await conectarDescartavel({ travar: false });
    const obs = await conectarDescartavel({ travar: false });
    const restaurarPool = poolNaConexao(a);
    const restaurarAmbiente = ambienteAssinatura();
    try {
      const ev = { data: dia(modo === "CRIAR" ? 76 : 78), ...HORA };
      const cpf = cpfValido();
      // Cenário com COMMIT (B precisa ver o salão); as rotas abrem as próprias transações (withTenantTransaction).
      await a.query("BEGIN");
      const c = await cenario(a, 0);
      await configurar(a, c);
      const A = await salao(a, c, "Salão A", 1);
      // VINCULAR: cliente já cadastrado com o CPF do documento (o plano vincula). CRIAR: só um cliente alheio para o retrato.
      const existente = await id(a, `INSERT INTO clientes (nome_completo, empresa_id, telefone, whatsapp, cpf) VALUES ($3, $1::uuid, $4, $4, $2) RETURNING id`,
        [c.empresa, modo === "VINCULAR" ? cpf : cpfValido(), modo === "VINCULAR" ? "Mariana Souza Lima" : "Cliente alheio da empresa", modo === "VINCULAR" ? "11987654321" : "11911112222"]);
      await a.query("COMMIT");
      const antes = await retratoGate(obs, c.empresa, existente, null);
      const [pa, pb] = [(await a.query<{ p: number }>("SELECT pg_backend_pid() p")).rows[0]!.p, (await b.query<{ p: number }>("SELECT pg_backend_pid() p")).rows[0]!.p];
      let daData: string[] = [];
      const fluxo = gateDoProduto(c, cpf, ev, A, async () => {
        // Depois do preview: B segura SÓ a trava da data, antes do clique.
        await b.query("BEGIN");
        const antesB = new Set((await b.query<{ k: string }>(`SELECT classid || ':' || objid || ':' || objsubid k FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'`)).rows.map((r) => r.k));
        await b.query("SELECT public.kidmais_lock_datas_revisao(ARRAY[$1::date])", [ev.data]);
        daData = (await b.query<{ k: string }>(`SELECT classid || ':' || objid || ':' || objsubid k FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'`)).rows.map((r) => r.k).filter((k) => !antesB.has(k));
      });
      // A confirmação do Gate passa da preparação com o salão ativo e espera na trava da data; só então o salão deixa de servir.
      let esperou = false;
      for (let i = 0; i < 800 && !esperou; i++) {
        const r = (await obs.query<{ bloqueado: boolean; k: string | null }>(
          `SELECT $2::int = ANY (pg_blocking_pids($1::int)) bloqueado,
                  (SELECT classid || ':' || objid || ':' || objsubid FROM pg_locks WHERE pid = $1::int AND NOT granted AND locktype = 'advisory' LIMIT 1) k`, [pa, pb])).rows[0]!;
        if (r.bloqueado) { assert.ok(r.k && daData.includes(r.k), `${modo}: espera na trava da data, não em outra: ${r.k}`); esperou = true; } else await new Promise((fim) => setTimeout(fim, 25));
      }
      assert.ok(esperou, `${modo}: a confirmação esperou B na trava da data`);
      await b.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [A]);
      await b.query("COMMIT");
      const { resposta, importacaoId, operacaoId, importacaoAntesDoClique } = await fluxo;
      // A resposta é a do produto, já com a transação da rota encerrada.
      assert.equal(resposta.status, 409, JSON.stringify(resposta.corpo));
      assert.equal((resposta.corpo as { codigo?: string }).codigo, "SALAO_INDISPONIVEL", JSON.stringify(resposta.corpo));
      assert.notEqual(await estadoOperacao(obs, operacaoId), "EXECUTADA", "operação do Gate não executada");
      const depois = await retratoGate(obs, c.empresa, existente, importacaoId);
      assert.equal(JSON.parse(String(depois.importacao)).status, "EM_REVISAO", `${modo}: importação continua em revisão`);
      assert.equal(await linhaImportacao(obs, importacaoId), importacaoAntesDoClique, `${modo}: importação idêntica à de antes do clique (cliente, versão, dados, resultado)`);
      assert.deepEqual({ ...depois, importacao: null }, { ...antes, importacao: null }, `${modo}: nada persistido (cliente novo/vinculado, contrato, versão, vínculo, festa, financeiro, histórico, auditoria)`);
    } finally {
      await b.query("ROLLBACK").catch(() => undefined);
      restaurarAmbiente();
      restaurarPool();
      await encerrarDescartavel(b, false);
      await encerrarDescartavel(obs, false);
    }
  }
});

test("CA-2 Human Gate do produto: recusa estrita DEPOIS de fechamento, contrato e versão materializados (VINCULAR); resposta 409 e nada persistido", { timeout: 300_000 }, async () => {
  const obs = await conectarDescartavel({ travar: false });
  const restaurarPool = poolNaConexao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try {
    const ev = { data: dia(79), ...HORA };
    const cpf = cpfValido();
    await a.query("BEGIN");
    const c = await cenario(a, 0);
    await configurar(a, c);
    const A = await salao(a, c, "Salão A", 1), B = await salao(a, c, "Salão B", 2);
    const existente = await id(a, `INSERT INTO clientes (nome_completo, empresa_id, telefone, whatsapp, cpf) VALUES ('Mariana Souza Lima', $1::uuid, '11987654321', '11987654321', $2) RETURNING id`, [c.empresa, cpf]);
    await a.query("COMMIT");
    const materializado = { visto: false };
    const antes = await retratoGate(obs, c.empresa, existente, null);
    // Gatilho só deste teste (DDL em autocommit, logo antes do clique): quando a versão do contrato da importação é inserida
    // (fechamento e contrato já existem), o pacote passa a permitir só o Salão B. Edição, fluxo e vínculo ainda são gravados e
    // a escolha estrita do contrato recusa; o INSERT do gatilho roda dentro da transação da rota e é desfeito com ela.
    const { resposta, importacaoId, operacaoId, importacaoAntesDoClique } = await gateDoProduto(c, cpf, ev, A, async () => {
      await a.query(`CREATE OR REPLACE FUNCTION public.se_v3_restringe_pacote_${c.empresa.replace(/-/g, "")}() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          IF EXISTS (SELECT 1 FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id WHERE k.id = NEW.contrato_id AND f.empresa_id = '${c.empresa}'::uuid) THEN
            INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ('${c.pacote}'::uuid, '${B}'::uuid) ON CONFLICT DO NOTHING;
          END IF;
          RETURN NEW;
        END $f$`);
      await a.query(`CREATE TRIGGER se_v3_restringe_pacote AFTER INSERT ON contrato_versoes FOR EACH ROW
        EXECUTE FUNCTION public.se_v3_restringe_pacote_${c.empresa.replace(/-/g, "")}()`);
      materializado.visto = true;
    });
    assert.ok(materializado.visto);
    try {
      assert.equal(resposta.status, 409, JSON.stringify(resposta.corpo));
      assert.equal((resposta.corpo as { codigo?: string }).codigo, "SALAO_INDISPONIVEL", JSON.stringify(resposta.corpo));
      assert.notEqual(await estadoOperacao(obs, operacaoId), "EXECUTADA");
      const depois = await retratoGate(obs, c.empresa, existente, importacaoId);
      assert.equal(JSON.parse(String(depois.importacao)).status, "EM_REVISAO");
      assert.equal(await linhaImportacao(obs, importacaoId), importacaoAntesDoClique, "importação idêntica à de antes do clique");
      assert.deepEqual({ ...depois, importacao: null }, { ...antes, importacao: null }, "nada persistido depois dos inserts desfeitos pelo produto");
      assert.equal((await obs.query<{ n: number }>(`SELECT count(*)::int n FROM pacote_saloes WHERE pacote_id = $1::uuid`, [c.pacote])).rows[0]!.n, 0, "o efeito do gatilho também foi desfeito");
    } finally {
      await a.query(`DROP TRIGGER IF EXISTS se_v3_restringe_pacote ON contrato_versoes`).catch(() => undefined);
      await a.query(`DROP FUNCTION IF EXISTS public.se_v3_restringe_pacote_${c.empresa.replace(/-/g, "")}()`).catch(() => undefined);
    }
  } finally {
    restaurarAmbiente();
    restaurarPool();
    await encerrarDescartavel(obs, false);
  }
});

test("D2 legado V1: contrato importado ANTES da unidade usar salão continua V1 (nada fixado, troca direta)", { timeout: 300_000 }, async () => {
  await emTransacao(async () => {
    const c = await cenario(a, 0);
    await a.query(`INSERT INTO agenda_escopo_config (empresa_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
                   VALUES ($1::uuid, 'FIXO', 'POR_HORARIO', NULL, 0, $2::uuid)`, [c.empresa, c.usuario]);
    const ev = { data: dia(80), ...HORA };
    const { r } = await importarNoSalao(a, c, ev, undefined);
    assert.ok(r, "POR_HORARIO importa sem salão");
    await validarAgora(a);
    const vid = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1::uuid`, [r!.contratoId])).rows[0]!.v;
    assert.equal((await a.query<{ n: number }>(`SELECT snapshot_schema_versao n FROM contrato_versoes WHERE id = $1::uuid`, [vid])).rows[0]!.n, 1);
    // A unidade passa a usar salões depois: o contrato antigo NÃO vira V3 (D2) e não fixa salão.
    await a.query(`UPDATE agenda_escopo_config SET capacidade_tipo = 'POR_SALAO' WHERE empresa_id = $1::uuid`, [c.empresa]);
    const A = await salao(a, c, "Salão A", 1);
    const exigido = carregar<typeof import("../services/salao-contrato.ts")>("lib/contratos/services/salao-contrato.ts");
    assert.deepEqual(await exigido.salaoExigidoDaFesta(executor(a), vid), { situacao: "SEM_SALAO_FIXADO" });
    const troca = carregar<typeof import("../../agenda/troca-salao.ts")>("lib/agenda/troca-salao.ts");
    const festa = (await a.query<{ f: string }>(`SELECT fechamento_id::text f FROM contratos WHERE id = $1::uuid`, [r!.contratoId])).rows[0]!.f;
    const lido = await troca.trocarSalaoDaFesta(executor(a), { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() }, festa, A);
    assert.equal(lido?.contratoFixa, undefined, "legado V1 não fixa salão");
    assert.equal(lido?.salaoAtual?.id, A, "troca direta da 094");
    await validarAgora(a);
  });
});

/** Importação V3 no Salão A, nova versão e troca do destino para B (o contrato vigente fixa A). */
async function trocaAberta(db: Client) {
  const c = await cenario(db, 0);
  await configurar(db, c);
  const A = await salao(db, c, "Salão A", 1), B = await salao(db, c, "Salão B", 2), C = await salao(db, c, "Salão C", 3);
  const ev = { data: dia(77), ...HORA };
  const { r } = await importarNoSalao(db, c, ev, A);
  assert.ok(r);
  await validarAgora(db);
  const festa = (await db.query<{ f: string }>(`SELECT fechamento_id::text f FROM contratos WHERE id = $1::uuid`, [r!.contratoId])).rows[0]!.f;
  const adm = carregar<typeof import("../services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  const operar = adm.operarContrato as unknown as Operar;
  const vigente = (await db.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1::uuid`, [r!.contratoId])).rows[0]!.v;
  await operar(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "Troca de salão", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
  const troca = carregar<typeof import("../../agenda/troca-salao.ts")>("lib/agenda/troca-salao.ts");
  const ctx = { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID() };
  const lido = await troca.trocarSalaoDaFesta(executor(db), ctx, festa, B);
  assert.equal(lido?.contratoFixa?.id, A);
  assert.equal(lido?.trocaEmAndamento?.salao?.id, B);
  return { c, A, B, C, festa, operar, troca, ctx, lido: lido!.trocaEmAndamento! };
}
const esperadoDe = (t: { revisaoId: string; revisaoOperacional: number; estado: string; salao: { id: string } | null }) =>
  ({ revisaoId: t.revisaoId, revisaoOperacional: t.revisaoOperacional, estado: t.estado, salaoDestinoId: t.salao?.id });
const revisaoDe = async (db: Client, rid: string) => (await db.query<{ estado: string; salao: string | null; motivo: string | null }>(
  `SELECT estado, salao_id::text salao, motivo_cancelamento motivo FROM fechamento_revisoes WHERE id = $1::uuid`, [rid])).rows[0]!;

test("CA-3 Desistir da troca: esperado igual cancela (hold liberado, vigente intacto); repetição mesmo motivo/autor reutiliza; outro motivo ou autor recusa", { timeout: 300_000 }, async () => {
  await emTransacao(async () => {
    const x = await trocaAberta(a);
    const corpo = (motivo: string) => ({ acao: "cancelar_revisao", revisao: x.lido.revisaoEdicao, motivo, esperado: esperadoDe(x.lido) });
    assert.deepEqual(await x.operar(x.lido.versaoId, corpo("Cliente desistiu"), x.c.token, ctxOp(), x.c.empresa), { cancelada: true });
    await validarAgora(a);
    assert.deepEqual(await revisaoDe(a, x.lido.revisaoId), { estado: "CANCELADA", salao: x.B, motivo: "Cliente desistiu" });
    assert.equal((await a.query<{ s: string }>(`SELECT salao_id::text s FROM fechamentos WHERE id = $1::uuid`, [x.festa])).rows[0]!.s, x.A, "a festa continua no salão do contrato");
    assert.equal((await a.query<{ n: number }>(`SELECT count(*)::int n FROM kidmais094_ocupacoes($1::date, $1::date) WHERE fechamento_id = $2::uuid AND salao_id = $3::uuid`, [dia(77), x.festa, x.B])).rows[0]!.n, 0, "hold do destino liberado");
    // Repetição após timeout com o MESMO pedido (esperado antigo): reutilizado, sem 409.
    assert.deepEqual(await x.operar(x.lido.versaoId, corpo("Cliente desistiu"), x.c.token, ctxOp(), x.c.empresa), { reutilizado: true });
    await assert.rejects(x.operar(x.lido.versaoId, corpo("Outro motivo qualquer"), x.c.token, ctxOp(), x.c.empresa), /outra intenção ou autor/);
    // Autor diferente: o mesmo ramo do serviço (cancelarPreparacao) com outro usuário.
    const rs = carregar<typeof import("../../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
    const rr = carregar<typeof import("../../fechamentos/repositories/revisao.repository.ts")>("lib/fechamentos/repositories/revisao.repository.ts");
    const outro = await id(a, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Outro operador', $2, 'ADMINISTRATIVO', true) RETURNING id`, [`${randomUUID()}@example.invalid`, `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`]);
    const preparacao = (await rr.buscarRevisaoDaVersao(x.lido.versaoId, executor(a), true))!;
    await assert.rejects(rs.cancelarPreparacao(executor(a), preparacao, { usuarioId: outro } as never, "Cliente desistiu"), /outra intenção ou autor/);
    // Identidade revisão/versão preservada: esperado de outra revisão nesta versão é recusado mesmo no ramo já cancelado.
    await assert.rejects(x.operar(x.lido.versaoId, { ...corpo("Cliente desistiu"), esperado: { ...esperadoDe(x.lido), revisaoId: randomUUID() } }, x.c.token, ctxOp(), x.c.empresa), /A revisão mudou desde que você abriu a tela/);
  });
});

test("CA-3 Desistir da troca: o que mudou depois da leitura (outra conexão com COMMIT) dá 409 sem cancelar; relida, desiste", { timeout: 300_000 }, async () => {
  const b = await conectarDescartavel({ travar: false });
  try {
    const x = await emTransacao(() => trocaAberta(a), "COMMIT");
    const ler = async () => (await x.troca.lerSalaoDaFesta(executor(a), x.c.empresa, x.festa))!.trocaEmAndamento!;
    const tentar = (t: typeof x.lido, mudar: Record<string, unknown> = {}) => emTransacao(() => x.operar(t.versaoId,
      { acao: "cancelar_revisao", revisao: t.revisaoEdicao, motivo: "Cliente desistiu", esperado: { ...esperadoDe(t), ...mudar } }, x.c.token, ctxOp(), x.c.empresa), "COMMIT");
    const cancelada = async () => (await revisaoDe(b, x.lido.revisaoId)).estado === "CANCELADA";
    // Divergências diretas: contador, estado e destino igual ao fixado.
    await assert.rejects(tentar(x.lido, { revisaoOperacional: x.lido.revisaoOperacional + 1 }), /A revisão mudou/);
    await assert.rejects(tentar(x.lido, { estado: "CONGELADA" }), /A revisão mudou/);
    assert.equal(await cancelada(), false);
    // B troca o destino para C e faz COMMIT (no modelo 098 a revisão é hash v1: o contador da edição não muda).
    await b.query("BEGIN");
    await x.troca.trocarSalaoDaFesta(executor(b), x.ctx, x.festa, x.C);
    await b.query("COMMIT");
    const relida = await ler();
    assert.equal(relida.salao?.id, x.C);
    await assert.rejects(tentar(x.lido), /A revisão mudou/, "A desiste com os valores antigos (destino B)");
    assert.equal(await cancelada(), false, "revisão intacta");
    // B leva o destino de volta ao salão do contrato (A): não é mais troca.
    await b.query("BEGIN");
    await x.troca.trocarSalaoDaFesta(executor(b), x.ctx, x.festa, x.A);
    await b.query("COMMIT");
    const igual = await ler();
    assert.equal(igual.salao?.id, x.A);
    await assert.rejects(tentar(igual), /A revisão mudou/, "destino igual ao fixado não é troca (conferido no servidor)");
    assert.equal(await cancelada(), false);
    // Destino nulo nunca é aceito como troca pelo contrato da ação.
    const adm = carregar<typeof import("../services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
    assert.equal(adm.acaoContratoSchema.safeParse({ acao: "cancelar_revisao", revisao: 1, motivo: "Desistiu", esperado: { ...esperadoDe(igual), salaoDestinoId: null } }).success, false);
    // Nova conferência: troca de novo para C, relê e desiste.
    await b.query("BEGIN");
    await x.troca.trocarSalaoDaFesta(executor(b), x.ctx, x.festa, x.C);
    await b.query("COMMIT");
    await tentar(await ler());
    assert.equal(await cancelada(), true);
  } finally {
    await b.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(b, false);
  }
});
