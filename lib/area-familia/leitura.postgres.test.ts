import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, dia, executor, id, poolNaTransacao, validarAgora,
  type Cenario,
} from "../../scripts/integracao-importados-test-support.ts";
import { travarConfiguracaoAgenda } from "../agenda/trava-configuracao.ts";

/**
 * Área "Minha festa" F2 (telas de leitura, sem migration) no PostgreSQL DESCARTÁVEL, modelo 123. Festa real (contrato
 * gerado, assinado pelo buffet e pelo cliente). Cobre: o que o contratante e o segundo responsável leem (iguais), só as
 * parcelas DESTE contrato (outra festa da mesma empresa não aparece), Pix só de parcela do contrato da sessão, sessão
 * que não alcança mais a festa (cancelado, invalidada, outra empresa), documentos pela sessão (contrato, resumo,
 * comprovantes da versão vigente; comprovante de outro contrato recusado), contrato em papel e limite por sessão.
 * Cada teste termina em ROLLBACK.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
let a: Client;
let com123 = false;
let com124 = false;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
const MODELO = {
  titulo: "Contrato", contratada: { nome: "Buffet Teste Ltda", documento: "12.345.678/0001-90", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
  preambulo: [], observacoes: [], cidadeAssinatura: "Cidade Teste",
  clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} das {{festa.inicio}} às {{festa.fim}} ({{festa.pacote}}), {{festa.convidados}} convidados, {{valor.total}}, {{pagamento.condicao}}. {{contratante.tipo_documento}} {{contratante.documento}}." }],
};

const acesso = () => carregar<typeof import("./acesso.ts")>("lib/area-familia/acesso.ts");
const admin = () => carregar<typeof import("./admin.ts")>("lib/area-familia/admin.ts");
const leitura = () => carregar<typeof import("./leitura.ts")>("lib/area-familia/leitura.ts");
const limites = () => carregar<typeof import("./limites.ts")>("lib/area-familia/limites.ts");
const pix = () => carregar<typeof import("../pagamentos/pix/recebimento.ts")>("lib/pagamentos/pix/recebimento.ts");

async function emTx(corpo: () => Promise<void>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try { await corpo(); } finally { await a.query("ROLLBACK"); nativos.clear(); restaurarAmbiente(); restaurarPool(); }
}
const pepper = () => process.env.IDENTIDADE_OTP_PEPPER as string;
const HOJE = dia(0);

const nativos = new Map<string, Awaited<ReturnType<typeof catalogoNativo>>>();
type PapelDoCliente = { dataDeclarada: string; observacao: string; copia: Buffer };
type Festa = { c: Cenario; festaId: string; contratoId: string; versaoId: string; codigo: string; cpf: string; ctx: { empresaId: string; usuarioId: string } };

/** Empresa ATIVA com catálogo, cliente PF completo, contrato assinado pelos dois lados: a festa nasce na formalização. */
async function festa(diasAteFesta = 130, c?: Cenario, clientePapel?: PapelDoCliente): Promise<Festa> {
  c ??= await cenario(a, 0);
  let nativo = nativos.get(c.empresa);
  if (!nativo) {
    nativo = await catalogoNativo(a, c);
    nativos.set(c.empresa, nativo);
    await travarConfiguracaoAgenda(executor(a), c.empresa, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
  }
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por)
                 SELECT $1::uuid, 1, $2::jsonb, $3, $4::uuid WHERE NOT EXISTS (SELECT 1 FROM modelos_contrato_empresa WHERE empresa_id = $1::uuid)`,
    [c.empresa, JSON.stringify(MODELO), "a".repeat(64), c.usuario]);
  const cpf = cpfValido();
  const clienteId = await id(a,
    `INSERT INTO clientes (nome_completo, cpf, empresa_id, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
     VALUES ('Maria Contratante Silva', $1, $2::uuid, $3, '11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP') RETURNING id`,
    [cpf, c.empresa, `${randomUUID()}@example.invalid`]);
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Ana Maria Sintética') RETURNING id`, [clienteId]);
  const fechamento = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 30, 30, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO'
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
    [dia(diasAteFesta), nativo.turno, c.empresa, c.pacote, clienteId, aniversariante]);
  const contratos = carregar<typeof import("../contratos/services/contrato.service.ts")>("lib/contratos/services/contrato.service.ts");
  const gerado = await contratos.gerarContrato({ fechamentoId: fechamento } as never, { usuarioId: c.usuario, origem: "SISTEMA", executor: executor(a) } as never) as { contrato: { id: string }; versao: { id: string } };
  const adm = carregar<typeof import("../contratos/services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
  await congelarEAssinarKidmais(a, adm.operarContrato as unknown as Operar, gerado.versao.id, c.empresa, c.token, nativo.tokenRepresentante);
  if (clientePapel) {
    // 124: a Gestão registra pelo serviço real que o cliente assinou o papel (com observação e cópia, que não podem vazar).
    await validarAgora(a);
    const papel = carregar<typeof import("../contratos/services/assinatura-papel-cliente.service.ts")>("lib/contratos/services/assinatura-papel-cliente.service.ts");
    await papel.registrarAssinaturaPapelCliente(gerado.versao.id,
      { chaveIdempotencia: randomUUID(), dataDeclarada: clientePapel.dataDeclarada, observacao: clientePapel.observacao },
      { bytes: clientePapel.copia, tipo: "application/pdf" }, nativo.tokenRepresentante, { requestId: randomUUID(), ip: null, userAgent: "pg-area-familia" }, c.empresa);
    await validarAgora(a);
  } else {
    await assinarComoCliente(gerado.contrato.id, cpf);
  }
  const festaId = (await a.query<{ id: string }>("SELECT id::text AS id FROM festas WHERE contrato_id = $1::uuid", [gerado.contrato.id])).rows[0]?.id;
  assert.ok(festaId, "a festa nasce na formalização");
  const versaoId = (await a.query<{ v: string }>("SELECT versao_vigente_id::text AS v FROM contrato_fluxos WHERE contrato_id = $1::uuid", [gerado.contrato.id])).rows[0].v;
  const codigo = (await a.query<{ codigo: string }>("SELECT codigo FROM empresas WHERE id = $1::uuid", [c.empresa])).rows[0].codigo;
  return { c, festaId, contratoId: gerado.contrato.id, versaoId, codigo, cpf, ctx: { empresaId: c.empresa, usuarioId: c.usuario } };
}

/**
 * Parcelas sintéticas DESTE contrato (pagamento da versão vigente): uma vencida, uma em aberto (10 dias), uma futura
 * (90 dias) e uma paga. Se a geração já criou o pagamento, reaproveita; senão cria. Devolve os ids na ordem.
 */
async function parcelas(f: Festa) {
  let pagamento = (await a.query<{ id: string }>("SELECT pag.id::text AS id FROM pagamentos pag WHERE pag.contrato_versao_id = $1::uuid", [f.versaoId])).rows[0]?.id;
  pagamento ??= await id(a, "INSERT INTO pagamentos (contrato_versao_id, valor_total_contratado) VALUES ($1::uuid, 4000) RETURNING id", [f.versaoId]);
  await a.query("UPDATE pagamento_planos SET numero_versao = numero_versao + 100 WHERE pagamento_id = $1::uuid", [pagamento]);
  const plano = await id(a, "INSERT INTO pagamento_planos (pagamento_id, numero_versao, meio_pagamento, modalidade, quantidade_parcelas) VALUES ($1::uuid, 1, 'PIX', 'PARCELADO', 4) RETURNING id", [pagamento]);
  const ids: string[] = [];
  for (const [numero, vence] of [[1, -5], [2, 10], [3, 90], [4, -20]] as const) {
    ids.push(await id(a, "INSERT INTO pagamento_parcelas (plano_id, numero, valor_previsto, vencimento, confirma_reserva) VALUES ($1::uuid, $2, 1000, $3::date, false) RETURNING id", [plano, numero, dia(vence)]));
  }
  return { pagamento, plano, ids };
}

/** Sessão sintética como lerSessao devolveria (a F1 já prova a entrada; aqui só o que a leitura recebe). */
async function entrarComo(f: Festa, papel: "CONTRATANTE" | "SEGUNDO_RESPONSAVEL", documento: string | null) {
  const link = await admin().gerarLinkArea(executor(a), f.ctx, f.festaId, papel);
  let codigo = "";
  const deps = { pepper: pepper(), enviarOtp: async (x: { codigo: string }) => { codigo = x.codigo; } };
  const inicio = await acesso().iniciarEntrada(executor(a), deps as never, { empresaCodigo: f.codigo, token: link.caminho.split("#")[1], documento }) as { ok: boolean; validacaoId: string };
  assert.equal(inicio.ok, true);
  const r = await acesso().confirmarEntrada(executor(a), { pepper: pepper() }, { empresaCodigo: f.codigo, validacaoId: inicio.validacaoId, codigo, lembrar: false, aparelho: null }) as { ok: boolean; token: string };
  assert.equal(r.ok, true);
  await validarAgora(a);
  const s = await acesso().lerSessao(executor(a), f.codigo, r.token);
  assert.ok(s);
  return s;
}

async function chavePix(empresaId: string, usuarioId: string) {
  await a.query("INSERT INTO empresa_pix_recebimento (empresa_id, tipo_chave, chave, nome_recebedor, cidade_recebedor, atualizado_por) VALUES ($1::uuid, 'EMAIL', 'pix@buffet.example', 'Buffet Teste', 'Sao Paulo', $2::uuid)", [empresaId, usuarioId]);
}

test.before(async () => {
  if (!opt()) return;
  process.env.FESTA_ENABLED = "true";
  a = await conectarDescartavel();
  com123 = (await a.query("SELECT to_regclass('public.festa_pessoas') IS NOT NULL AS ok")).rows[0].ok;
  com124 = (await a.query("SELECT to_regclass('public.contrato_assinaturas_papel') IS NOT NULL AS ok")).rows[0].ok;
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("F2: contratante e segundo responsável leem o mesmo — festa, só as parcelas deste contrato, documentos; nada de CPF nem contato", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa(40);
    const outra = await festa(60, f.c); // outra festa da MESMA empresa
    const minhas = await parcelas(f);
    const delas = await parcelas(outra);
    const contratante = await entrarComo(f, "CONTRATANTE", f.cpf);
    const cpf2 = cpfValido();
    await admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "João Segundo", whatsapp: "(21) 98888-7777", documento: cpf2 }, pepper());
    const segundo = await entrarComo(f, "SEGUNDO_RESPONSAVEL", cpf2);
    assert.equal(segundo.papel, "SEGUNDO_RESPONSAVEL");

    const d1 = await leitura().lerMinhaFesta(executor(a), contratante, HOJE);
    const d2 = await leitura().lerMinhaFesta(executor(a), segundo, HOJE);
    assert.ok(d1 && d2);
    // F3 (125): só o papel e o bloco do segundo responsável (gestão de pessoas, só do contratante) diferem.
    assert.equal(d1.papel, "CONTRATANTE");
    assert.equal(d2.papel, "SEGUNDO_RESPONSAVEL");
    assert.equal(d2.acoes.segundo, undefined, "o segundo responsável não gere pessoas");
    const semPapel = (d: typeof d1) => ({ ...d, papel: null, acoes: { ...d.acoes, segundo: undefined } });
    assert.deepEqual(semPapel(d2), semPapel(d1), "segundo responsável vê o mesmo que o contratante");
    const com125 = (await a.query("SELECT to_regclass('public.festa_pendencias_familia') IS NOT NULL AS ok")).rows[0].ok;
    assert.equal(d1.acoes.disponivel, com125, "sem a 125, a leitura segue sem ações");
    if (com125) assert.equal(d1.acoes.segundo?.nome, "João Segundo");
    assert.equal(d1.festa.data, dia(40));
    assert.equal(d1.festa.diasAteFesta, 40);
    assert.equal(d1.festa.convidados, 30);
    assert.equal(d1.festa.horarioInicio, "10:00");
    assert.ok(d1.festa.aniversariante.startsWith("Ana — "), "só o primeiro nome do aniversariante");
    assert.equal(d1.assinadoEmPapel, false);
    assert.equal(d1.assinadoPeloClienteEmPapel, null, "assinatura eletrônica (OTP): sem o texto do papel do cliente");

    const ids = d1.pagamentos.parcelas.map((p) => p.id);
    for (const p of minhas.ids) assert.ok(ids.includes(p), "parcela do contrato aparece");
    for (const p of delas.ids) assert.ok(!ids.includes(p), "parcela de OUTRA festa da mesma empresa não aparece");
    const porId = new Map(d1.pagamentos.parcelas.map((p) => [p.id, p]));
    assert.equal(porId.get(minhas.ids[0])?.estado, "VENCIDA");
    assert.equal(porId.get(minhas.ids[1])?.estado, "EM_ABERTO");
    assert.equal(porId.get(minhas.ids[2])?.estado, "FUTURA");
    assert.equal(porId.get(minhas.ids[1])?.pix, true);
    assert.ok(d1.pagamentos.proxima, "há próxima parcela");

    const tipos = d1.documentos.map((d) => d.tipo);
    assert.deepEqual(tipos.slice(0, 2), ["contrato", "resumo"]);
    assert.ok(tipos.filter((x) => x === "comprovante").length >= 1, "comprovante da assinatura eletrônica");

    const texto = JSON.stringify(d1);
    for (const proibido of [f.cpf, cpf2, "11999998888", "21988887777", "Rua Sintética", "example.invalid", "Maria Contratante", "Maria Sintética"]) {
      assert.ok(!texto.includes(proibido), `não expõe ${proibido}`);
    }
  });
});

test("F2: Pix só de parcela do contrato da sessão; outra festa, outra empresa, sem chave, Pix desligado e id inválido recusam", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa(40);
    const irma = await festa(60, f.c);
    const estranha = await festa(70);
    const minhas = await parcelas(f);
    const daIrma = await parcelas(irma);
    const daEstranha = await parcelas(estranha);
    const p = pix();
    assert.deepEqual(await p.pixDaParcelaDoContrato(executor(a), f.c.empresa, f.contratoId, minhas.ids[1], HOJE), { ok: false, motivo: "PIX_NAO_CONFIGURADO" });
    await chavePix(f.c.empresa, f.c.usuario);
    const ok = await p.pixDaParcelaDoContrato(executor(a), f.c.empresa, f.contratoId, minhas.ids[1].toUpperCase(), HOJE);
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.valorCentavos, 100000);
    assert.equal(ok.parcela.numero, 2);
    assert.match(ok.copiaECola, /^000201/);
    assert.match(ok.qrSvg, /^<svg/);
    assert.ok(!JSON.stringify(ok.recebedor).includes("pix@buffet.example"), "fora do BR Code, a chave só mascarada");
    assert.ok(!("txid" in ok) && !("cliente" in ok.parcela), "devolve só o mínimo");
    const NAO = { ok: false, motivo: "PARCELA_NAO_ENCONTRADA" };
    assert.deepEqual(await p.pixDaParcelaDoContrato(executor(a), f.c.empresa, f.contratoId, daIrma.ids[1], HOJE), NAO, "parcela de outra festa da mesma empresa");
    assert.deepEqual(await p.pixDaParcelaDoContrato(executor(a), f.c.empresa, f.contratoId, daEstranha.ids[1], HOJE), NAO, "parcela de outra empresa");
    assert.deepEqual(await p.pixDaParcelaDoContrato(executor(a), f.c.empresa, f.contratoId, "nao-e-uuid", HOJE), NAO);
    assert.deepEqual(await p.pixDaParcelaDoContrato(executor(a), f.c.empresa, f.contratoId, randomUUID(), HOJE), NAO);
    // Empresa estranha com chave própria não alcança a parcela de f pelo contrato de f.
    await chavePix(estranha.c.empresa, estranha.c.usuario);
    assert.deepEqual(await p.pixDaParcelaDoContrato(executor(a), estranha.c.empresa, f.contratoId, minhas.ids[1], HOJE), NAO, "outra empresa com o contrato de f");
    // Pix desligado (sem a tabela da 066) recusa antes de procurar a parcela.
    await a.query("SAVEPOINT semPix");
    await a.query("ALTER TABLE empresa_pix_recebimento RENAME TO empresa_pix_recebimento_off");
    assert.deepEqual(await p.pixDaParcelaDoContrato(executor(a), f.c.empresa, f.contratoId, minhas.ids[1], HOJE), { ok: false, motivo: "PIX_INDISPONIVEL" });
    await a.query("ROLLBACK TO SAVEPOINT semPix");
  });
});

test("F2: sessão que não alcança mais a festa lê nada — contrato cancelado, festa invalidada, festa ou empresa de outra", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa(40);
    const s = await entrarComo(f, "CONTRATANTE", f.cpf);
    const l = leitura();
    assert.ok(await l.contratoDaSessao(executor(a), s));
    const outra = await festa(50);
    assert.equal(await l.contratoDaSessao(executor(a), { ...s, empresaId: outra.c.empresa }), null, "festa de f com a empresa de outra: nada");
    assert.equal(await l.lerMinhaFesta(executor(a), { ...s, festaId: outra.festaId }, HOJE), null, "festa de outra empresa com a empresa de f: nada");
    assert.deepEqual(await l.adquirirDocumentoFamilia(executor(a), { ...s, empresaId: outra.c.empresa }, { tipo: "resumo" }), { ok: false, motivo: "NAO_ENCONTRADO" });
    // Contrato cancelado e festa invalidada (mesma escrita da suíte da F1): a leitura some, Pix e documentos também.
    await a.query("SAVEPOINT inv");
    // O banco não deixa invalidar festa de contrato assinado (019): sem gatilhos, só para provar a defesa da leitura.
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query("UPDATE festas SET invalidada_em = clock_timestamp(), invalidada_por = $2::uuid, motivo_invalidacao = 'teste da área' WHERE id = $1::uuid", [f.festaId, f.ctx.usuarioId]);
    await a.query("SET LOCAL session_replication_role = origin");
    assert.equal(await l.lerMinhaFesta(executor(a), s, HOJE), null, "festa invalidada");
    assert.deepEqual(await l.adquirirDocumentoFamilia(executor(a), s, { tipo: "resumo" }), { ok: false, motivo: "NAO_ENCONTRADO" });
    await a.query("ROLLBACK TO SAVEPOINT inv");
    await a.query("SAVEPOINT canc");
    await a.query("UPDATE contratos SET status = 'CANCELADO', cancelado_em = now() WHERE id = $1::uuid", [f.contratoId]);
    assert.equal(await l.contratoDaSessao(executor(a), s), null, "contrato cancelado");
    await a.query("ROLLBACK TO SAVEPOINT canc");
    assert.ok(await l.contratoDaSessao(executor(a), s), "depois do rollback, volta a ler");
    // Versão vigente que não está ASSINADA (sem gatilhos, só para provar a defesa da leitura).
    await a.query("SAVEPOINT ver");
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query("UPDATE contrato_versoes SET status = 'CANCELADA' WHERE id = $1::uuid", [f.versaoId]);
    await a.query("SET LOCAL session_replication_role = origin");
    assert.equal(await l.contratoDaSessao(executor(a), s), null, "vigente não assinada");
    await a.query("ROLLBACK TO SAVEPOINT ver");
  });
});

test("F2: documentos pela sessão — contrato, resumo e comprovante da versão vigente; comprovante de outro contrato recusado; papel sem PDF oficial", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa(40);
    const g = await festa(60, f.c);
    const s = await entrarComo(f, "CONTRATANTE", f.cpf);
    const l = leitura();
    for (const tipo of ["contrato", "resumo"] as const) {
      const r = await l.adquirirDocumentoFamilia(executor(a), s, { tipo });
      assert.equal(r.ok, true, `${tipo}: ${JSON.stringify(r).slice(0, 200)}`);
      if (!r.ok) continue;
      const m = l.materializarDocumentoFamilia(r);
      assert.equal(m.pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    }
    const meus = await l.comprovantesDaVersao(executor(a), f.versaoId);
    const deles = await l.comprovantesDaVersao(executor(a), g.versaoId);
    assert.ok(meus.length >= 1 && deles.length >= 1);
    const c = await l.adquirirDocumentoFamilia(executor(a), s, { tipo: "comprovante", id: meus[0].id });
    assert.equal(c.ok, true);
    if (c.ok) assert.equal(l.materializarDocumentoFamilia(c).pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.deepEqual(await l.adquirirDocumentoFamilia(executor(a), s, { tipo: "comprovante", id: deles[0].id }), { ok: false, motivo: "NAO_ENCONTRADO" }, "comprovante de outro contrato da mesma empresa");
    assert.deepEqual(await l.adquirirDocumentoFamilia(executor(a), s, { tipo: "comprovante", id: randomUUID() }), { ok: false, motivo: "NAO_ENCONTRADO" });

    // Contrato em papel: sem contrato oficial nem comprovante; o resumo segue.
    await a.query("SAVEPOINT papel");
    // Só no descartável (superusuário): sem gatilhos para marcar a versão assinada como papel.
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query("UPDATE contrato_versoes SET aceite_metodo = 'CONFERENCIA_PAPEL' WHERE id = $1::uuid", [f.versaoId]);
    await a.query("SET LOCAL session_replication_role = origin");
    const d = await l.lerMinhaFesta(executor(a), s, HOJE);
    assert.ok(d);
    assert.equal(d.assinadoEmPapel, true);
    assert.equal(d.assinadoPeloClienteEmPapel, null, "conferência importada não é o papel do cliente (124)");
    assert.deepEqual(d.documentos.map((x) => x.tipo), ["resumo"]);
    assert.deepEqual(await l.adquirirDocumentoFamilia(executor(a), s, { tipo: "contrato" }), { ok: false, motivo: "NAO_ENCONTRADO" });
    assert.deepEqual(await l.adquirirDocumentoFamilia(executor(a), s, { tipo: "comprovante", id: meus[0].id }), { ok: false, motivo: "NAO_ENCONTRADO" });
    assert.equal((await l.adquirirDocumentoFamilia(executor(a), s, { tipo: "resumo" })).ok, true);
    await a.query("ROLLBACK TO SAVEPOINT papel");
  });
});

test("124 na área: cliente assinou em papel — mesmo texto e fonte do link público, documento e comprovante do buffet, sem a cópia", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  const publico = carregar<typeof import("../contratos/services/contrato-publico.service.ts")>("lib/contratos/services/contrato-publico.service.ts");
  const papelTxt = carregar<typeof import("../contratos/assinatura-papel.ts")>("lib/contratos/assinatura-papel.ts");
  await emTx(async () => {
    if (!com124) {
      // Sem a 124: a fonte compartilhada não cita a tabela nem com o método PAPEL_CLIENTE (nada de 42P01) e devolve null.
      await a.query("SAVEPOINT sem124");
      assert.equal(await publico.assinaturaPapelClientePublica({ id: randomUUID(), aceiteMetodo: "PAPEL_CLIENTE" }, executor(a)), null);
      assert.equal((await a.query("SELECT 1 AS ok")).rows[0].ok, 1, "transação segue viva (a tabela não foi citada)");
      await a.query("ROLLBACK TO SAVEPOINT sem124");
      return;
    }
    const hoje = (await a.query<{ d: string }>("SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS d")).rows[0].d;
    const copia = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(`copia sintetica ${randomUUID()}\n%%EOF\n`)]);
    const shaCopia = createHash("sha256").update(copia).digest("hex");
    const observacao = `Nota interna da Gestão ${randomUUID()}`;
    const f = await festa(40, undefined, { dataDeclarada: hoje, observacao, copia });
    const metodo = (await a.query<{ m: string }>("SELECT aceite_metodo AS m FROM contrato_versoes WHERE id = $1::uuid", [f.versaoId])).rows[0].m;
    assert.equal(metodo, "PAPEL_CLIENTE");
    const s = await entrarComo(f, "CONTRATANTE", f.cpf);
    const l = leitura();
    const d = await l.lerMinhaFesta(executor(a), s, HOJE);
    assert.ok(d);

    // Mesmo texto e mesma fonte do link público.
    const doLink = await publico.assinaturaPapelClientePublica({ id: f.versaoId, aceiteMetodo: "PAPEL_CLIENTE" }, executor(a));
    assert.deepEqual(doLink, { data: hoje });
    assert.equal(d.assinadoPeloClienteEmPapel, papelTxt.textoClienteAssinouEmPapel(hoje));
    assert.equal(d.assinadoPeloClienteEmPapel, `Assinado pelo cliente em papel em ${hoje.slice(8, 10)}/${hoje.slice(5, 7)}/${hoje.slice(0, 4)}.`);
    assert.equal(d.assinadoEmPapel, false, "não é a conferência importada: nada de esconder documentos");

    // Documento e comprovante do buffet continuam; não há comprovante do cliente.
    assert.deepEqual(d.documentos.map((x) => x.tipo).filter((x) => x !== "comprovante"), ["contrato", "resumo"]);
    const comprovantes = d.documentos.filter((x) => x.tipo === "comprovante");
    assert.ok(comprovantes.length >= 1, "comprovante do buffet");
    assert.ok(comprovantes.every((x) => x.titulo === "Comprovante da assinatura do buffet"));
    for (const pedido of [{ tipo: "contrato" as const }, { tipo: "resumo" as const }, ...comprovantes.map((x) => ({ tipo: "comprovante" as const, id: x.tipo === "comprovante" ? x.id : "" }))]) {
      const r = await l.adquirirDocumentoFamilia(executor(a), s, pedido);
      assert.equal(r.ok, true, `${pedido.tipo}: ${JSON.stringify(r).slice(0, 200)}`);
      if (r.ok) assert.equal(l.materializarDocumentoFamilia(r).pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    }

    // A cópia anexada nunca chega à família: nem os bytes, nem o sha, nem a observação, nem quem registrou.
    const serial = JSON.stringify(d);
    for (const proibido of [shaCopia, observacao, copia.toString("base64"), copia.toString("latin1").slice(9, 40), "application/pdf"]) {
      assert.ok(!serial.includes(proibido), `não expõe: ${proibido.slice(0, 30)}`);
    }
    const reg = (await a.query<{ id: string; autor: string; membership: string; tamanho: number; chave: string; payload: string }>(
      `SELECT id::text AS id, registrado_por_usuario_id::text AS autor, membership_id::text AS membership, arquivo_tamanho AS tamanho,
              chave_idempotencia::text AS chave, payload_hash AS payload
         FROM contrato_assinaturas_papel WHERE contrato_versao_id = $1::uuid`, [f.versaoId])).rows[0];
    const idPapel = reg.id;
    assert.equal(reg.tamanho, copia.length, "o registro tem cópia (a prova abaixo não é vazia)");
    for (const [nome, valor] of [["id do registro", idPapel], ["autor", reg.autor], ["membership", reg.membership], ["chave", reg.chave], ["payload", reg.payload]] as const) {
      assert.ok(!serial.includes(valor), `não expõe ${nome}`);
    }
    // Bytes em qualquer forma: JSON de Buffer ({type:"Buffer",data:[...]}), lista de bytes e hex.
    assert.ok(!serial.includes('"Buffer"'), "nenhum Buffer serializado");
    assert.ok(!serial.includes([...copia.subarray(0, 16)].join(",")), "nem a lista de bytes da cópia");
    assert.ok(!serial.includes(copia.toString("hex").slice(0, 32)), "nem os bytes em hex");
    // Estrutural: nenhum campo com nome de metadado da cópia, nenhum valor binário, e o tamanho não aparece como valor.
    const chavesProibidas = /arquivo|tamanho|sha|observa|registrad|membership|autor|bytes|copia|payload|idempot/i;
    const visitar = (v: unknown, caminho: string): void => {
      if (v === null || typeof v !== "object") {
        assert.ok(v !== reg.tamanho, `tamanho da cópia como valor em ${caminho}`);
        return;
      }
      assert.ok(!Buffer.isBuffer(v) && !(v instanceof Uint8Array), `valor binário em ${caminho}`);
      for (const [k, filho] of Object.entries(v)) {
        assert.ok(!chavesProibidas.test(k), `campo proibido ${caminho}.${k}`);
        visitar(filho, `${caminho}.${k}`);
      }
    };
    visitar(d, "festa");
    assert.deepEqual(await l.adquirirDocumentoFamilia(executor(a), s, { tipo: "comprovante", id: idPapel }), { ok: false, motivo: "NAO_ENCONTRADO" }, "o id do registro do papel não abre como comprovante");

    // O segundo responsável lê o mesmo texto.
    const cpf2 = cpfValido();
    await admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "João Segundo", whatsapp: "(21) 98888-7777", documento: cpf2 }, pepper());
    const d2 = await l.lerMinhaFesta(executor(a), await entrarComo(f, "SEGUNDO_RESPONSAVEL", cpf2), HOJE);
    assert.equal(d2?.assinadoPeloClienteEmPapel, d.assinadoPeloClienteEmPapel);
  });
});

test("F2: limite de leitura por sessão conta no banco por sessão, separa sessões e não grava o id em claro", { skip: !opt(), timeout: 120_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const L = limites();
    const regra = { nome: "teste:leitura", limite: 2, janelaSegundos: 3600 };
    const s1 = randomUUID();
    const s2 = randomUUID();
    assert.equal(await L.consumirLimiteDaSessao(executor(a), regra, s1, pepper()), null);
    assert.equal(await L.consumirLimiteDaSessao(executor(a), regra, s1, pepper()), null);
    const espera = await L.consumirLimiteDaSessao(executor(a), regra, s1, pepper());
    assert.ok(typeof espera === "number" && espera > 0, "terceira leitura passa do limite");
    assert.equal(await L.consumirLimiteDaSessao(executor(a), regra, s2, pepper()), null, "outra sessão tem contador próprio");
    const chaves = (await a.query("SELECT chave FROM limites_contadores")).rows.map((r) => String(r.chave));
    assert.ok(chaves.every((k) => !k.includes(s1) && !k.includes(s2)));
    assert.equal(L.LIMITES.AREA_LEITURA_SESSAO.limite, 120);
  });
});
