import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, cenario, congelarEAssinarKidmais, cpfValido, dia, executor, id, poolNaTransacao, validarAgora,
  type Cenario,
} from "../../scripts/integracao-importados-test-support.ts";
import { travarConfiguracaoAgenda } from "../agenda/trava-configuracao.ts";

/**
 * Área "Minha festa" F3 (125, ações) no PostgreSQL DESCARTÁVEL, modelo 125 (e 123: sem a 125 nada é gravado). Festa
 * real (contrato assinado pelos dois lados). Cobre: "Já paguei" só de parcela do contrato da sessão, um aviso pendente
 * por parcela, tratamento no painel; pendência do cliente visível com texto próprio, "feito" pela família, devolução
 * pela equipe, pendência operacional, oculta ou encerrada fora; contratante convida, gera link e remove o segundo (o
 * segundo não); autoria nos eventos; travas do banco contra festa cruzada, autor errado e autoria da remoção trocada;
 * down recusado com dados. Cada teste termina em ROLLBACK, menos o de concorrência (fixtures confirmadas, três conexões
 * reais em READ COMMITTED): revogação x ação com a festa travada antes da sessão.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
let a: Client;
let b: Client;
let gestao: Client;
let obs: Client;
let com123 = false;
type Operar = Parameters<typeof congelarEAssinarKidmais>[1];
const MODELO = {
  titulo: "Contrato", contratada: { nome: "Buffet Teste Ltda", documento: "12.345.678/0001-90", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
  preambulo: [], observacoes: [], cidadeAssinatura: "Cidade Teste",
  clausulas: [{ titulo: "Objeto", texto: "Festa em {{festa.data}} das {{festa.inicio}} às {{festa.fim}} ({{festa.pacote}}), {{festa.convidados}} convidados, {{valor.total}}, {{pagamento.condicao}}. {{contratante.tipo_documento}} {{contratante.documento}}." }],
};

const acesso = () => carregar<typeof import("./acesso.ts")>("lib/area-familia/acesso.ts");
const admin = () => carregar<typeof import("./admin.ts")>("lib/area-familia/admin.ts");

async function emTx(corpo: () => Promise<void>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try { await corpo(); } finally { await a.query("ROLLBACK"); nativos.clear(); restaurarAmbiente(); restaurarPool(); }
}
const pepper = () => process.env.IDENTIDADE_OTP_PEPPER as string;
const HOJE = dia(0);

const nativos = new Map<string, Awaited<ReturnType<typeof catalogoNativo>>>();
type Festa = { c: Cenario; festaId: string; contratoId: string; versaoId: string; codigo: string; cpf: string; ctx: { empresaId: string; usuarioId: string } };

/** Empresa ATIVA com catálogo, cliente PF completo, contrato assinado pelos dois lados: a festa nasce na formalização. */
async function festa(diasAteFesta = 130, c?: Cenario): Promise<Festa> {
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
  await assinarComoCliente(gerado.contrato.id, cpf);
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
  return { ...s, token: r.token };
}

test.before(async () => {
  if (!opt()) return;
  process.env.FESTA_ENABLED = "true";
  a = await conectarDescartavel();
  b = await conectarDescartavel({ travar: false });
  gestao = await conectarDescartavel({ travar: false });
  obs = await conectarDescartavel({ travar: false });
  com123 = (await a.query("SELECT to_regclass('public.festa_pessoas') IS NOT NULL AS ok")).rows[0].ok;
});
test.after(async () => { for (const c of [a, b, gestao, obs]) if (c) await encerrarDescartavel(c); });

const acoes = () => carregar<typeof import("./acoes.ts")>("lib/area-familia/acoes.ts");
const com125 = async () => (await a.query("SELECT to_regclass('public.festa_pendencias_familia') IS NOT NULL AS ok")).rows[0].ok as boolean;
type Sessao = Awaited<ReturnType<typeof entrarComo>>;
const agir = async (s: Sessao, acao: Parameters<ReturnType<typeof acoes>["executarAcaoFamilia"]>[2]) =>
  acoes().executarAcaoFamilia(executor(a), s, acao, { pepper: pepper(), hoje: HOJE });
async function pendencia(f: Festa, natureza: "CLIENTE" | "OPERACIONAL", descricao = "Enviar a lista de convidados") {
  return id(a, `INSERT INTO festa_pendencias (festa_id, natureza, descricao, prioridade, prazo, criado_por)
                VALUES ($1::uuid, $2, $3, 'NORMAL', now() + interval '10 days', $4::uuid) RETURNING id`, [f.festaId, natureza, descricao, f.ctx.usuarioId]);
}
async function recusaSql(sql: string, params: unknown[], re: RegExp, rotulo: string) {
  await a.query("SAVEPOINT trava");
  await assert.rejects(a.query(sql, params.length ? params : undefined), (e) => re.test((e as Error).message), rotulo);
  await a.query("ROLLBACK TO SAVEPOINT trava");
}
async function eventos(f: Festa, tipo: string) {
  return (await a.query<{ autor_pessoa_id: string | null; autor_usuario_id: string | null; pessoa_id: string | null; motivo: string | null }>(
    `SELECT autor_pessoa_id::text AS autor_pessoa_id, autor_usuario_id::text AS autor_usuario_id, pessoa_id::text AS pessoa_id, motivo
       FROM area_familia_eventos WHERE festa_id = $1::uuid AND tipo = $2 ORDER BY criado_em`, [f.festaId, tipo])).rows;
}

test("F3: \"Já paguei\" — só parcela do contrato da sessão, um aviso pendente por vez, painel confere; autoria da pessoa", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123 || !(await com125())) return t.skip("modelo sem a 125");
  await emTx(async () => {
    const f = await festa(40);
    const outra = await festa(60, f.c);
    const minhas = await parcelas(f);
    const delas = await parcelas(outra);
    const s = await entrarComo(f, "CONTRATANTE", f.cpf);

    assert.deepEqual(await agir(s, { acao: "AVISAR_PAGAMENTO", parcela: delas.ids[1] }), { ok: false, motivo: "NAO_ENCONTRADO" }, "parcela de outra festa");
    assert.deepEqual(await agir(s, { acao: "AVISAR_PAGAMENTO", parcela: randomUUID() }), { ok: false, motivo: "NAO_ENCONTRADO" });
    assert.deepEqual(await agir(s, { acao: "AVISAR_PAGAMENTO", parcela: minhas.ids[1], observacao: "x".repeat(281) }), { ok: false, motivo: "DADOS_INVALIDOS" });
    assert.deepEqual(await agir(s, { acao: "AVISAR_PAGAMENTO", parcela: minhas.ids[1], observacao: "  Pix às 10h  " }), { ok: true, acao: "AVISAR_PAGAMENTO", parcela: 2 });
    assert.deepEqual(await agir(s, { acao: "AVISAR_PAGAMENTO", parcela: minhas.ids[1] }), { ok: false, motivo: "AVISO_JA_ENVIADO" }, "um aviso pendente por parcela");

    const lida = await acoes().lerAcoesDaFamilia(executor(a), s);
    assert.deepEqual(lida.parcelasAvisadas, [minhas.ids[1]]);
    const ev = await eventos(f, "AVISO_PAGAMENTO");
    assert.equal(ev.length, 1);
    assert.equal(ev[0].autor_pessoa_id, s.pessoaId, "autoria: a pessoa da sessão");
    assert.equal(ev[0].autor_usuario_id, null);
    assert.equal(ev[0].motivo, null, "nada de valor, CPF ou observação no evento");

    const resumo = await admin().resumoAreaFamilia(executor(a), f.ctx, f.festaId);
    assert.equal(resumo.acoes.avisos.length, 1);
    const aviso = resumo.acoes.avisos[0];
    assert.equal(aviso.observacao, "Pix às 10h");
    assert.equal(aviso.papel, "CONTRATANTE");
    assert.equal(aviso.parcela, 2);
    assert.ok(aviso.saldoCentavos > 0);
    // Outra empresa não trata o aviso.
    const estranha = await festa(70);
    await assert.rejects(admin().tratarAvisoPagamento(executor(a), estranha.ctx, f.festaId, aviso.id, "CONFERIDO"));
    await admin().tratarAvisoPagamento(executor(a), f.ctx, f.festaId, aviso.id, "CONFERIDO");
    await assert.rejects(admin().tratarAvisoPagamento(executor(a), f.ctx, f.festaId, aviso.id, "DESCARTADO"), "já tratado");
    assert.equal((await admin().resumoAreaFamilia(executor(a), f.ctx, f.festaId)).acoes.avisos.length, 0);
    assert.equal((await eventos(f, "AVISO_PAGAMENTO_TRATADO"))[0]?.autor_usuario_id, f.ctx.usuarioId, "autoria: o usuário do painel");
    // Depois de tratado, a família pode avisar de novo; o aviso não mexe na parcela.
    assert.equal((await agir(s, { acao: "AVISAR_PAGAMENTO", parcela: minhas.ids[1] })).ok, true);
    assert.equal((await a.query("SELECT count(*)::int AS n FROM pagamento_parcelas WHERE id = $1::uuid AND valor_previsto = 1000", [minhas.ids[1]])).rows[0].n, 1);

    // Travas do banco: parcela de outra festa, número errado, apagar, mudar o que a família escreveu.
    await recusaSql(`INSERT INTO area_familia_avisos_pagamento (festa_id, empresa_id, pessoa_id, parcela_id, parcela_numero, saldo_centavos)
                     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, 100000)`, [f.festaId, f.ctx.empresaId, s.pessoaId, delas.ids[1]], /parcela fora do contrato/, "festa cruzada");
    await recusaSql(`INSERT INTO area_familia_avisos_pagamento (festa_id, empresa_id, pessoa_id, parcela_id, parcela_numero, saldo_centavos)
                     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 9, 100000)`, [f.festaId, f.ctx.empresaId, s.pessoaId, minhas.ids[2]], /número da parcela/, "número errado");
    await recusaSql("DELETE FROM area_familia_avisos_pagamento WHERE festa_id = $1::uuid", [f.festaId], /não é apagado/, "apagar");
    await recusaSql("UPDATE area_familia_avisos_pagamento SET observacao = 'outra' WHERE festa_id = $1::uuid AND estado = 'PENDENTE'", [f.festaId], /só o tratamento muda/, "editar");
  });
});

test("F3: pendência do cliente — visível com texto próprio, feito pela família, devolvida pela equipe; operacional, oculta e encerrada fora", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123 || !(await com125())) return t.skip("modelo sem a 125");
  await emTx(async () => {
    const f = await festa(40);
    const contratante = await entrarComo(f, "CONTRATANTE", f.cpf);
    const cpf2 = cpfValido();
    await admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "João Segundo", whatsapp: "(21) 98888-7777", documento: cpf2 }, pepper());
    const segundo = await entrarComo(f, "SEGUNDO_RESPONSAVEL", cpf2);
    const cliente = await pendencia(f, "CLIENTE", "Descrição interna: cliente atrasou a lista");
    const oculta = await pendencia(f, "CLIENTE");
    const operacional = await pendencia(f, "OPERACIONAL");

    assert.deepEqual((await acoes().lerAcoesDaFamilia(executor(a), contratante)).pendencias, [], "nada aparece sem a equipe liberar");
    await assert.rejects(admin().configurarPendenciaFamilia(executor(a), f.ctx, f.festaId, operacional, { visivel: true, texto: "x" }), /Só pendência do cliente/);
    await assert.rejects(admin().configurarPendenciaFamilia(executor(a), f.ctx, f.festaId, cliente, { visivel: true, texto: "   " }), /Escreva o texto/);
    await admin().configurarPendenciaFamilia(executor(a), f.ctx, f.festaId, cliente, { visivel: true, texto: "Enviar a lista de convidados" });
    await admin().configurarPendenciaFamilia(executor(a), f.ctx, f.festaId, oculta, { visivel: false, texto: "Escolher o tema" });

    const vista = (await acoes().lerAcoesDaFamilia(executor(a), segundo)).pendencias;
    assert.equal(vista.length, 1);
    assert.equal(vista[0].texto, "Enviar a lista de convidados", "a família vê o texto para ela, nunca a descrição interna");
    assert.equal(vista[0].prazo, dia(10));
    assert.ok(!JSON.stringify(vista).includes("Descrição interna"));

    assert.deepEqual(await agir(segundo, { acao: "PENDENCIA_FEITA", pendencia: oculta }), { ok: false, motivo: "NAO_ENCONTRADO" }, "oculta");
    assert.deepEqual(await agir(segundo, { acao: "PENDENCIA_FEITA", pendencia: operacional }), { ok: false, motivo: "NAO_ENCONTRADO" }, "operacional");
    assert.deepEqual(await agir(segundo, { acao: "PENDENCIA_FEITA", pendencia: cliente }), { ok: true, acao: "PENDENCIA_FEITA" }, "o segundo também marca");
    assert.deepEqual(await agir(contratante, { acao: "PENDENCIA_FEITA", pendencia: cliente }), { ok: false, motivo: "PENDENCIA_JA_FEITA" });
    assert.equal((await a.query("SELECT estado FROM festa_pendencias WHERE id = $1::uuid", [cliente])).rows[0].estado, "ABERTA", "o feito da família não fecha a pendência interna");
    let painel = (await admin().resumoAreaFamilia(executor(a), f.ctx, f.festaId)).acoes.pendencias.find((p) => p.id === cliente);
    assert.equal(painel?.familia?.feitaPor, "SEGUNDO_RESPONSAVEL");
    assert.equal((await eventos(f, "PENDENCIA_FEITA"))[0]?.autor_pessoa_id, segundo.pessoaId);

    await admin().devolverPendenciaFamilia(executor(a), f.ctx, f.festaId, cliente);
    await assert.rejects(admin().devolverPendenciaFamilia(executor(a), f.ctx, f.festaId, cliente), "devolver o que não está feito");
    const devolvida = (await acoes().lerAcoesDaFamilia(executor(a), contratante)).pendencias[0];
    assert.equal(devolvida.feita, false);
    assert.equal(devolvida.devolvida, true);
    assert.equal((await agir(contratante, { acao: "PENDENCIA_FEITA", pendencia: cliente })).ok, true, "marca de novo depois da devolução");
    painel = (await admin().resumoAreaFamilia(executor(a), f.ctx, f.festaId)).acoes.pendencias.find((p) => p.id === cliente);
    assert.equal(painel?.familia?.devolvidaEm, null, "um feito novo limpa a devolução");
    assert.equal((await eventos(f, "PENDENCIA_DEVOLVIDA"))[0]?.autor_usuario_id, f.ctx.usuarioId);

    // Encerrada pela equipe: some da família e não aceita mais "feito".
    await admin().devolverPendenciaFamilia(executor(a), f.ctx, f.festaId, cliente);
    await a.query("UPDATE festa_pendencias SET estado = 'RESOLVIDA' WHERE id = $1::uuid", [cliente]);
    assert.deepEqual((await acoes().lerAcoesDaFamilia(executor(a), contratante)).pendencias, []);
    assert.deepEqual(await agir(contratante, { acao: "PENDENCIA_FEITA", pendencia: cliente }), { ok: false, motivo: "PENDENCIA_INDISPONIVEL" });

    // Travas do banco: operacional, apagar, feito por pessoa de outra festa.
    const outra = await festa(60, f.c);
    const deOutra = await entrarComo(outra, "CONTRATANTE", outra.cpf);
    await recusaSql(`INSERT INTO festa_pendencias_familia (pendencia_id, festa_id, empresa_id, visivel, texto, atualizado_por_usuario_id)
                     VALUES ($1::uuid, $2::uuid, $3::uuid, true, 'x', $4::uuid)`, [operacional, f.festaId, f.ctx.empresaId, f.ctx.usuarioId], /só pendência do cliente/, "operacional");
    await recusaSql("DELETE FROM festa_pendencias_familia WHERE pendencia_id = $1::uuid", [oculta], /não é apagada/, "apagar");
    await a.query("UPDATE festa_pendencias_familia SET visivel = true WHERE pendencia_id = $1::uuid", [oculta]);
    await recusaSql("UPDATE festa_pendencias_familia SET feito_em = now(), feito_por_pessoa_id = $2::uuid WHERE pendencia_id = $1::uuid", [oculta, deOutra.pessoaId],
      /foreign key|só pessoa ativa/, "pessoa de outra festa");
  });
});

test("F3: contratante convida, gera link e remove o segundo; o segundo não; eventos com autoria; travas do banco", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123 || !(await com125())) return t.skip("modelo sem a 125");
  await emTx(async () => {
    const f = await festa(40);
    const contratante = await entrarComo(f, "CONTRATANTE", f.cpf);
    assert.deepEqual(await agir(contratante, { acao: "REMOVER_SEGUNDO" }), { ok: false, motivo: "SEGUNDO_AUSENTE" });
    assert.deepEqual(await agir(contratante, { acao: "LINK_SEGUNDO" }), { ok: false, motivo: "SEGUNDO_AUSENTE" });
    assert.deepEqual(await agir(contratante, { acao: "CONVIDAR_SEGUNDO", nome: "João", whatsapp: "123" }), { ok: false, motivo: "DADOS_INVALIDOS" });
    assert.deepEqual(await agir(contratante, { acao: "CONVIDAR_SEGUNDO", nome: "João", whatsapp: "21988887777", documento: "123" }), { ok: false, motivo: "DADOS_INVALIDOS" });
    const cpf2 = cpfValido();
    const convite = await agir(contratante, { acao: "CONVIDAR_SEGUNDO", nome: "  João Segundo ", whatsapp: "(21) 98888-7777", documento: cpf2 });
    assert.ok(convite.ok && convite.acao === "CONVIDAR_SEGUNDO" && convite.caminho.includes("#"), "convite devolve o link uma vez");
    assert.deepEqual(await agir(contratante, { acao: "CONVIDAR_SEGUNDO", nome: "Outro", whatsapp: "21977776666" }), { ok: false, motivo: "SEGUNDO_JA_CADASTRADO" });

    const resumo = await admin().resumoAreaFamilia(executor(a), f.ctx, f.festaId);
    assert.equal(resumo.acoes.segundoPelaFamilia, true);
    const segundoId = resumo.pessoas.find((p) => p.papel === "SEGUNDO_RESPONSAVEL")?.id as string;
    assert.ok(segundoId);
    const lida = await acoes().lerAcoesDaFamilia(executor(a), contratante);
    assert.equal(lida.segundo?.nome, "João Segundo");
    assert.equal(lida.segundo?.criadoPelaFamilia, true);
    // O id do link ativo identifica o link: a tela só mostra o link gerado enquanto ele for o ativo (visita.ts).
    const linkDoConvite = convite.ok && convite.acao === "CONVIDAR_SEGUNDO" ? convite.linkId : null;
    assert.match(String(linkDoConvite), /^[0-9a-f-]{36}$/);
    assert.equal(lida.segundo?.linkId, linkDoConvite, "a leitura devolve o id do link ativo");
    assert.ok(!JSON.stringify(lida).includes(cpf2) && !JSON.stringify(lida).includes("98888-7777"), "nada de CPF nem WhatsApp completo");
    const cadastro = await eventos(f, "PESSOA_CADASTRADA");
    assert.equal(cadastro.at(-1)?.autor_pessoa_id, contratante.pessoaId);
    assert.equal(cadastro.at(-1)?.pessoa_id, segundoId);
    assert.equal((await eventos(f, "LINK_GERADO")).at(-1)?.autor_pessoa_id, contratante.pessoaId);

    // O segundo entra (link gerado pelo painel no helper) e não gere pessoas.
    const novoLink = await agir(contratante, { acao: "LINK_SEGUNDO" });
    assert.ok(novoLink.ok && novoLink.acao === "LINK_SEGUNDO" && novoLink.linkId !== linkDoConvite, "link novo, id novo");
    const idNovo = novoLink.ok && novoLink.acao === "LINK_SEGUNDO" ? novoLink.linkId : null;
    assert.equal((await acoes().lerAcoesDaFamilia(executor(a), contratante)).segundo?.linkId, idNovo, "o anterior deixou de ser o ativo");
    const segundo = await entrarComo(f, "SEGUNDO_RESPONSAVEL", cpf2);
    const aposPainel = (await acoes().lerAcoesDaFamilia(executor(a), contratante)).segundo?.linkId;
    assert.ok(aposPainel && aposPainel !== idNovo, "link gerado pelo painel troca o id ativo (o da tela some)");
    assert.equal((await acoes().lerAcoesDaFamilia(executor(a), segundo)).segundo, undefined);
    for (const acao of [{ acao: "LINK_SEGUNDO" }, { acao: "REMOVER_SEGUNDO" }, { acao: "CONVIDAR_SEGUNDO", nome: "X", whatsapp: "21977776666" }] as const) {
      assert.deepEqual(await agir(segundo, acao), { ok: false, motivo: "SO_CONTRATANTE" }, acao.acao);
    }

    // Travas do banco: o segundo não remove a si mesmo; contratante de outra festa não remove nem assina evento daqui.
    const outra = await festa(60, f.c);
    const deOutra = await entrarComo(outra, "CONTRATANTE", outra.cpf);
    await recusaSql("UPDATE festa_pessoas SET removido_em = now(), removido_por_pessoa_id = $2::uuid WHERE id = $1::uuid", [segundoId, segundo.pessoaId],
      /só o contratante da mesma festa remove/, "segundo se remove");
    await recusaSql("UPDATE festa_pessoas SET removido_em = now(), removido_por_pessoa_id = $2::uuid WHERE id = $1::uuid", [segundoId, deOutra.pessoaId],
      /só o contratante da mesma festa remove/, "contratante de outra festa");
    await recusaSql(`INSERT INTO area_familia_eventos (festa_id, empresa_id, pessoa_id, autor_pessoa_id, tipo) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'AVISO_FIXO')`,
      [f.festaId, f.ctx.empresaId, segundoId, deOutra.pessoaId], /autor do evento é de outra festa/, "autor de outra festa");

    // Remover: sai da festa e as sessões dele terminam (com o token real do segundo: entra antes, recusado depois).
    assert.equal((await acesso().lerSessao(executor(a), f.codigo, segundo.token))?.pessoaId, segundoId, "antes da remoção o segundo entra");
    assert.deepEqual(await agir(contratante, { acao: "REMOVER_SEGUNDO" }), { ok: true, acao: "REMOVER_SEGUNDO" });
    assert.equal((await eventos(f, "PESSOA_REMOVIDA")).at(-1)?.autor_pessoa_id, contratante.pessoaId);
    assert.equal((await acoes().lerAcoesDaFamilia(executor(a), contratante)).segundo, null);
    assert.equal(await acesso().lerSessao(executor(a), f.codigo, segundo.token), null, "depois da remoção o mesmo token é recusado");
    assert.equal(await acesso().lerSessao(executor(a), f.codigo, contratante.token).then((x) => x?.pessoaId), contratante.pessoaId, "o contratante segue");

    // Autoria da remoção registrada não muda: nem para outra pessoa (desta ou de outra festa), nem para usuário, nem apagada.
    for (const [sql, params, rotulo] of [
      ["UPDATE festa_pessoas SET removido_por_pessoa_id = $2::uuid WHERE id = $1::uuid", [segundoId, deOutra.pessoaId], "para contratante de outra festa"],
      ["UPDATE festa_pessoas SET removido_por_pessoa_id = $2::uuid WHERE id = $1::uuid", [segundoId, segundoId], "para o próprio removido"],
      ["UPDATE festa_pessoas SET removido_por_pessoa_id = NULL, removido_por_usuario_id = $2::uuid WHERE id = $1::uuid", [segundoId, f.ctx.usuarioId], "para usuário da equipe"],
      ["UPDATE festa_pessoas SET removido_por_pessoa_id = NULL WHERE id = $1::uuid", [segundoId], "apagada"],
    ] as const) {
      await recusaSql(sql, [...params], /autoria da remoção registrada não muda/, `autoria trocada ${rotulo}`);
    }
    const autoria = (await a.query<{ p: string | null; u: string | null }>(
      "SELECT removido_por_pessoa_id::text AS p, removido_por_usuario_id::text AS u FROM festa_pessoas WHERE id = $1::uuid", [segundoId])).rows[0];
    assert.deepEqual(autoria, { p: contratante.pessoaId, u: null });
  });
});

test("F3: aviso fixo da empresa; down recusado com dados; sem a 125 nada é gravado e a leitura segue", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123) return t.skip("modelo sem a 123");
  await emTx(async () => {
    const f = await festa(40);
    const s = await entrarComo(f, "CONTRATANTE", f.cpf);
    if (!(await com125())) {
      assert.equal(await acoes().acoesInstaladas(executor(a)), false);
      assert.deepEqual(await acoes().lerAcoesDaFamilia(executor(a), s), acoes().SEM_ACOES);
      assert.equal((await admin().resumoAreaFamilia(executor(a), f.ctx, f.festaId)).acoes.disponivel, false);
      await assert.rejects(admin().salvarAvisoFixo(executor(a), f.ctx, f.festaId, "Oi"), /125/);
      return;
    }
    await assert.rejects(admin().salvarAvisoFixo(executor(a), f.ctx, f.festaId, "x".repeat(501)));
    await admin().salvarAvisoFixo(executor(a), f.ctx, f.festaId, "  Chegue 30 minutos antes.  ");
    assert.equal((await acoes().lerAcoesDaFamilia(executor(a), s)).avisoFixo, "Chegue 30 minutos antes.");
    const irma = await festa(60, f.c);
    const daIrma = await entrarComo(irma, "CONTRATANTE", irma.cpf);
    assert.equal((await acoes().lerAcoesDaFamilia(executor(a), daIrma)).avisoFixo, "Chegue 30 minutos antes.", "vale para todas as festas da empresa");
    const estranha = await festa(70);
    const deFora = await entrarComo(estranha, "CONTRATANTE", estranha.cpf);
    assert.equal((await acoes().lerAcoesDaFamilia(executor(a), deFora)).avisoFixo, null, "outra empresa não vê");
    await admin().salvarAvisoFixo(executor(a), f.ctx, f.festaId, null);
    assert.equal((await acoes().lerAcoesDaFamilia(executor(a), s)).avisoFixo, null);
    const fixos = await eventos(f, "AVISO_FIXO");
    assert.ok(fixos.length >= 2 && fixos.every((e) => e.autor_usuario_id === f.ctx.usuarioId));

    const down = readFileSync("database/rollback/20261115_125_area_familia_acoes_down.sql", "utf8").replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");
    await recusaSql(down, [], /rollback recusado; as ações da área já foram usadas/, "down com dados");
  });
});

/**
 * Fixtures CONFIRMADAS (as outras conexões precisam enxergar): mesmo ambiente do emTx, mas termina em COMMIT. O pepper
 * do ambiente é sorteado a cada chamada; aqui fica o mesmo entre as chamadas do teste, para o documento do segundo
 * cadastrado numa conferir na entrada seguinte.
 */
let pepperFixo: string | undefined;
async function confirmado<T>(corpo: () => Promise<T>): Promise<T> {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  if (pepperFixo) process.env.IDENTIDADE_OTP_PEPPER = pepperFixo; else pepperFixo = pepper();
  try {
    const r = await corpo();
    await a.query("COMMIT");
    return r;
  } catch (e) {
    await a.query("ROLLBACK");
    throw e;
  } finally { nativos.clear(); restaurarAmbiente(); restaurarPool(); }
}
const pid = async (c: Client) => Number((await c.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0].p);
/** Espera (no observador) até `alvo` estar bloqueado por `por`. */
async function esperaPor(alvo: number, por: number) {
  for (let i = 0; i < 400; i++) {
    const bloqueadores = (await obs.query<{ b: number[] }>("SELECT pg_blocking_pids($1) AS b", [alvo])).rows[0].b.map(Number);
    if (bloqueadores.includes(por)) return;
    await new Promise((fim) => setTimeout(fim, 25));
  }
  throw new Error(`pid ${alvo} não ficou esperando ${por}`);
}

test("F3: concorrência — festa travada antes da sessão; revogação confirmada na espera recusa a ação; revogação que chega depois espera o COMMIT", { skip: !opt(), timeout: 600_000 }, async (t) => {
  if (!com123 || !(await com125())) return t.skip("modelo sem a 125");
  const { f, ps, cpf2 } = await confirmado(async () => {
    const f = await festa(40);
    const cpf2 = cpfValido();
    await admin().cadastrarSegundo(executor(a), f.ctx, f.festaId, { nome: "João Segundo", whatsapp: "(21) 98888-7777", documento: cpf2 }, pepper());
    const ps: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await pendencia(f, "CLIENTE");
      await admin().configurarPendenciaFamilia(executor(a), f.ctx, f.festaId, p, { visivel: true, texto: `Item ${i + 1}` });
      ps.push(p);
    }
    return { f, ps, cpf2 };
  });
  const deps = { pepper: pepperFixo as string, hoje: HOJE };
  // Cada pessoa pede no máximo 3 códigos por hora: as entradas se dividem entre contratante e segundo responsável.
  let entradas = 0;
  const entrar = () => confirmado(() => (entradas++ < 3 ? entrarComo(f, "CONTRATANTE", f.cpf) : entrarComo(f, "SEGUNDO_RESPONSAVEL", cpf2)));
  const feita = async (p: string) => (await obs.query<{ f: boolean }>(
    "SELECT feito_em IS NOT NULL AS f FROM festa_pendencias_familia WHERE pendencia_id = $1::uuid", [p])).rows[0].f;
  const [pidB, pidGestao] = [await pid(b), await pid(gestao)];

  // (a) Painel primeiro: "desconectar todos" trava a festa e derruba as sessões; a ação espera na festa e, depois do
  // COMMIT do painel, a releitura presa recusa. Nada gravado.
  const s1 = await entrar();
  await gestao.query("BEGIN");
  await gestao.query("SELECT 1 FROM festas WHERE id = $1::uuid FOR UPDATE", [f.festaId]);
  await b.query("BEGIN");
  const acaoA = acoes().agirComSessao(executor(b), f.codigo, s1.token, s1, { acao: "PENDENCIA_FEITA", pendencia: ps[0] }, deps);
  await esperaPor(pidB, pidGestao);
  await gestao.query("SELECT kidmais_123_derrubar_sessoes($1::uuid, NULL, 'BUFFET_DESCONECTOU')", [f.festaId]);
  await gestao.query("COMMIT");
  assert.equal(await acaoA, "SESSAO", "sessão revogada durante a espera: ação recusada");
  await b.query("COMMIT");
  assert.equal(await feita(ps[0]), false, "nada gravado");

  // Duas formas de revogar sem travar a festa antes: "sair" (real: atualiza a sessão e grava o evento, que pela chave
  // estrangeira também prende a festa) e a revogação direta da linha, sem evento (prova a trava da própria sessão, a
  // segunda proteção: sem ela, uma revogação que não passasse pela festa não esperaria a ação).
  const revogacoes: [string, (s: Sessao) => Promise<unknown>][] = [
    ["sair", (s) => acesso().sair(executor(gestao), s)],
    ["direta", (s) => gestao.query("UPDATE area_familia_sessoes SET revogada_em = clock_timestamp(), motivo_revogacao = 'SAIR' WHERE id = $1::uuid AND revogada_em IS NULL", [s.sessaoId])],
  ];

  // (b) Revogação já em curso: a ação trava a festa (ou espera nela), vê a sessão ainda aberta ou espera a linha dela e,
  // depois do COMMIT da revogação, a releitura presa recusa. Nada gravado.
  for (const [i, [nome, revogar]] of revogacoes.entries()) {
    const s = await entrar();
    await gestao.query("BEGIN");
    await revogar(s);
    await b.query("BEGIN");
    const acao = acoes().agirComSessao(executor(b), f.codigo, s.token, s, { acao: "PENDENCIA_FEITA", pendencia: ps[1 + i] }, deps);
    await esperaPor(pidB, pidGestao);
    await gestao.query("COMMIT");
    assert.equal(await acao, "SESSAO", `${nome}: revogação confirmada na espera, ação recusada`);
    await b.query("COMMIT");
    assert.equal(await feita(ps[1 + i]), false, `${nome}: nada gravado`);
  }

  // (c) Ação primeiro: a sessão fica presa até o COMMIT; a revogação espera; depois, a sessão termina.
  for (const [i, [nome, revogar]] of revogacoes.entries()) {
    const s = await entrar();
    await b.query("BEGIN");
    assert.deepEqual(await acoes().agirComSessao(executor(b), f.codigo, s.token, s, { acao: "PENDENCIA_FEITA", pendencia: ps[3 + i] }, deps),
      { ok: true, acao: "PENDENCIA_FEITA" }, nome);
    await gestao.query("BEGIN");
    const saida = revogar(s);
    await esperaPor(pidGestao, pidB);
    await b.query("COMMIT");
    await saida;
    await gestao.query("COMMIT");
    assert.equal(await feita(ps[3 + i]), true, `${nome}: a ação que chegou primeiro foi gravada inteira`);
    assert.equal(await acesso().lerSessao(executor(obs), f.codigo, s.token), null, `${nome}: e a sessão terminou depois dela`);
  }
});
