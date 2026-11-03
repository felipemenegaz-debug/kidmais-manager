import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import {
  ambienteAssinatura, carregar, catalogoNativo, cenario, cpfValido, dia, executor, id, poolNaTransacao, type Cenario,
} from "../../scripts/integracao-importados-test-support.ts";

/**
 * Entrega B (112) — fechamento com contratante PJ (plano R2-2) no PostgreSQL DESCARTÁVEL. Modelo 112:
 * - público: PJ já cadastrada comprovada pelo CNPJ fecha a festa; RG do formulário ignorado; CNPJ de outra PJ ou CPF no
 *   lugar do CNPJ → DOCUMENTO_DIVERGENTE_DA_IDENTIDADE; CNPJ já cadastrado como cliente novo → CNPJ_EXISTENTE_REQUER_VALIDACAO;
 * - público: empresa nova (decisão de Felipe 01/11) nasce PJ com razão social, CNPJ e representante, sem CPF/RG; o
 *   mesmo CNPJ noutra empresa é independente; CPF de representante inválido recusado sem gravar;
 * - modelo da empresa que qualifica o contratante como PF: o contexto do fechamento admin lista os trechos e o envio,
 *   o fechamento público e a aprovação da revisão comercial recusam com MODELO_INCOMPATIVEL_PJ, sem gravar; PF segue.
 * Modelo 109 (código novo sem a 112): CNPJ no fechamento público → PJ_INDISPONIVEL/MIGRACAO_PENDENTE; PF segue igual.
 * Cada teste termina em ROLLBACK.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
let a: Client;
let com112 = false;
const CNPJ = "11222333000181";
const OUTRO_CNPJ = "12ABC34501DE35";
const conteudo = (qualificacao: string) => ({
  titulo: "Contrato", contratada: { nome: "Buffet PJ Ltda", documento: "12.345.678/0001-90", endereco: "Rua Teste, 2", representante: "Pessoa Teste" },
  preambulo: [], observacoes: [], cidadeAssinatura: "Cidade Teste",
  clausulas: [{ titulo: "Objeto", texto: `Festa em {{festa.data}} ({{festa.pacote}}), {{valor.total}}, {{pagamento.condicao}}. ${qualificacao}` }],
});
const COMPATIVEL = conteudo("{{contratante.tipo_documento}} {{contratante.documento}}.");
const LEGADO_PF = conteudo("Contratante inscrito no CPF sob o nº {{contratante.cpf}}.");

async function emTx(corpo: () => Promise<void>) {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  const restaurarAmbiente = ambienteAssinatura();
  try { await corpo(); } finally { await a.query("ROLLBACK"); restaurarAmbiente(); restaurarPool(); }
}
async function recusa<T>(p: () => Promise<T>, codigo: string) {
  await a.query("SAVEPOINT recusa");
  await assert.rejects(p(), (e: { code?: string }) => { assert.equal(e.code, codigo); return true; });
  await a.query("ROLLBACK TO SAVEPOINT recusa");
}
const endereco = `'11999998888', '11999998888', '01001000', 'Rua Sintética', '1', 'Centro', 'São Paulo', 'SP'`;
const clientePj = (c: Cenario, cnpj: string) => id(a,
  `INSERT INTO clientes (nome_completo, razao_social, tipo_pessoa, cnpj, representante_nome, representante_cpf, empresa_id, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
   VALUES ('Escola Um Ltda', 'Escola Um Ltda', 'PJ', $1, 'Ana Representante', $2, $3::uuid, $4, ${endereco}) RETURNING id`, [cnpj, cpfValido(), c.empresa, `${randomUUID()}@example.invalid`]);
const clientePf = (c: Cenario, cpf: string) => id(a,
  `INSERT INTO clientes (nome_completo, cpf, empresa_id, email, telefone, whatsapp, cep, logradouro, numero, bairro, cidade, uf)
   VALUES ('Pessoa Física Sintética', $1, $2::uuid, $3, ${endereco}) RETURNING id`, [cpf, c.empresa, `${randomUUID()}@example.invalid`]);
const aniversariante = (clienteId: string) => id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante') RETURNING id`, [clienteId]);
async function publicarModelo(c: Cenario, modelo: object, versao: number) {
  await a.query(`UPDATE modelos_contrato_empresa SET situacao = 'SUBSTITUIDO', substituido_em = now() WHERE empresa_id = $1::uuid AND situacao = 'ATIVO'`, [c.empresa]);
  await a.query(`INSERT INTO modelos_contrato_empresa (empresa_id, versao, conteudo, conteudo_sha256, aprovado_por) VALUES ($1::uuid, $2, $3::jsonb, $4, $5::uuid)`,
    [c.empresa, versao, JSON.stringify(modelo), String(versao).repeat(64).slice(0, 64), c.usuario]);
}
async function empresa() {
  const c = await cenario(a, 0);
  const nativo = await catalogoNativo(a, c);
  await publicarModelo(c, COMPATIVEL, 1);
  return { c, nativo };
}

type Publico = typeof import("./services/fechamento-publico.service.ts");
type Admin = typeof import("./services/fechamento-administrativo.service.ts");
type Revisao = typeof import("./services/revisao-comercial.service.ts");
const servicos = () => ({
  publico: carregar<Publico>("lib/fechamentos/services/fechamento-publico.service.ts"),
  admin: carregar<Admin>("lib/fechamentos/services/fechamento-administrativo.service.ts"),
  revisao: carregar<Revisao>("lib/fechamentos/services/revisao-comercial.service.ts"),
  identidade: carregar<typeof import("../identidade/services/index.ts")>("lib/identidade/services/index.ts"),
});

/** Prova de identidade do fechamento público pelo documento (CPF ou CNPJ), com o código capturado do emissor sintético. */
async function prova(c: Cenario, documento: string) {
  let codigo = "";
  const servico = servicos().identidade.criarIdentityServiceComAmbiente((async (x: { codigo: string }) => { codigo = x.codigo; }) as never);
  const desafio = await servico.iniciarDesafio({ cpf: documento, canal: "WHATSAPP", escopo: { empresaId: c.empresa, incluirLegadoSemEmpresa: false } } as never, executor(a));
  return (await servico.confirmarCodigo({ validacaoId: desafio.validacaoId, codigo }, executor(a))).provaToken;
}

type DadosCliente = { nomeCompleto: string; cpf: string; cnpj?: string | null; rg?: string | null; nomeFantasia?: string | null; representanteNome?: string | null; representanteCpf?: string | null };
function entradaPublica(c: Cenario, turno: string, data: string, cliente: DadosCliente, identidade: object, valorProposto = 100) {
  return {
    dataEvento: data, horarioInicio: "10:00", horarioFim: "22:00", configuracaoAgendaId: turno, pacoteId: c.pacote,
    convidados: 30, adicionais: [], valorProposto, formaPagamentoPretendida: "PIX_AVISTA", buffetStatus: "PENDENTE", empresaEsperada: c.empresa,
    identidade,
    cliente: { ...cliente, telefone: "11999998888", whatsapp: "11999998888", email: `${randomUUID()}@example.invalid`,
      cep: "01001000", logradouro: "Rua Sintética", numero: "1", complemento: null, bairro: "Centro", cidade: "São Paulo", uf: "SP" },
    aniversariante: { nome: "Aniversariante PJ", temaPadrao: null },
    cpfSemRevelarCadastro: true,
  } as never;
}
const contexto = (c: Cenario) => ({ token: c.token, requestId: randomUUID(), userAgent: null, empresaSolicitada: c.empresa });
const entradaAdmin = (turno: string, data: string, aniversarianteId: string) => ({
  pacote: "completa", dataFesta: data, configuracaoId: turno, horarioInicio: "10:00", horarioFim: "22:00", ajusteHorario: "0",
  statusDisponibilidade: "disponivel", convidadosPagantes: 30, buffetDefinicao: "depois", adicionaisSelecionados: [],
  valorCombinado: "100,00", formaPagamento: "pix_avista", aniversarianteId, idadeAniversariante: 6,
});
const fechamentosDo = async (clienteId: string) => Number((await a.query(`SELECT count(*)::int AS n FROM fechamentos WHERE cliente_id = $1::uuid`, [clienteId])).rows[0].n);

test.before(async () => {
  if (!opt()) return;
  process.env.FESTA_ENABLED = "true";
  a = await conectarDescartavel();
  com112 = (await a.query("SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.clientes'::regclass AND attname = 'tipo_pessoa' AND NOT attisdropped) AS ok")).rows[0].ok;
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("112: fechamento público de PJ já cadastrada comprovada pelo CNPJ; documento divergente e CNPJ já cadastrado como novo recusados", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com112) return t.skip("modelo sem a 112");
  await emTx(async () => {
    const { c, nativo } = await empresa();
    const pj = await clientePj(c, CNPJ);
    const { publico } = servicos();
    const token = await prova(c, "11.222.333/0001-81");
    const existente = { tipo: "CLIENTE_EXISTENTE", provaToken: token, atualizarCadastro: true };
    // Documento que não é o da identidade comprovada: nada gravado, a prova continua válida.
    await recusa(() => publico.criarFechamentoPublicoComIdentidade(entradaPublica(c, nativo.turno, dia(140), { nomeCompleto: "Escola Um Ltda", cpf: "", cnpj: OUTRO_CNPJ }, existente), executor(a)), "DOCUMENTO_DIVERGENTE_DA_IDENTIDADE");
    await recusa(() => publico.criarFechamentoPublicoComIdentidade(entradaPublica(c, nativo.turno, dia(140), { nomeCompleto: "Escola Um Ltda", cpf: cpfValido() }, existente), executor(a)), "DOCUMENTO_DIVERGENTE_DA_IDENTIDADE");
    // CNPJ desta empresa como cliente novo: pede a validação, como o CPF; nada gravado.
    await recusa(() => publico.criarFechamentoPublicoComIdentidade(entradaPublica(c, nativo.turno, dia(140), { nomeCompleto: "Escola Um Ltda", cpf: "", cnpj: CNPJ }, { tipo: "NOVO_CLIENTE" }), executor(a)), "CNPJ_EXISTENTE_REQUER_VALIDACAO");
    assert.equal(await fechamentosDo(pj), 0);

    const criado = await publico.criarFechamentoPublicoComIdentidade(entradaPublica(c, nativo.turno, dia(140),
      { nomeCompleto: "Escola Um Educação Ltda", cpf: "", cnpj: "11.222.333/0001-81", rg: "123456" }, existente), executor(a));
    assert.equal(criado.fechamento.clienteId, pj);
    assert.equal(criado.cliente.novo, false);
    assert.equal(criado.cliente.cadastroAtualizado, true);
    const gravado = (await a.query(`SELECT tipo_pessoa, cnpj, cpf, rg, nome_completo, razao_social FROM clientes WHERE id = $1::uuid`, [pj])).rows[0];
    assert.equal(gravado.tipo_pessoa, "PJ");
    assert.equal(gravado.cnpj, CNPJ);
    assert.equal(gravado.cpf, null);
    assert.equal(gravado.rg, null, "RG do formulário ignorado na PJ");
    assert.equal(gravado.nome_completo, "Escola Um Educação Ltda");
  });
});

test("112: fechamento público cadastra empresa (PJ) nova; mesmo CNPJ noutra empresa é independente; representante inválido recusado", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com112) return t.skip("modelo sem a 112");
  await emTx(async () => {
    const { c, nativo } = await empresa();
    const { publico } = servicos();
    const rep = cpfValido();
    await recusa(() => publico.criarFechamentoPublicoComIdentidade(entradaPublica(c, nativo.turno, dia(146),
      { nomeCompleto: "Colégio Novo Ltda", cpf: "", cnpj: OUTRO_CNPJ, representanteNome: "Ana", representanteCpf: "11111111112" }, { tipo: "NOVO_CLIENTE" }), executor(a)), "DADOS_INVALIDOS");
    assert.equal(Number((await a.query(`SELECT count(*)::int AS n FROM clientes WHERE empresa_id = $1::uuid AND cnpj = $2`, [c.empresa, OUTRO_CNPJ])).rows[0].n), 0);

    const criado = await publico.criarFechamentoPublicoComIdentidade(entradaPublica(c, nativo.turno, dia(146),
      { nomeCompleto: "Colégio Novo Ltda", cpf: "", cnpj: "12.abc.345/01de-35", rg: "999", nomeFantasia: "Colégio Novo", representanteNome: "Ana Representante", representanteCpf: rep },
      { tipo: "NOVO_CLIENTE" }), executor(a));
    assert.equal(criado.cliente.novo, true);
    assert.equal(criado.cliente.cadastroCompletoParaContrato, true);
    const g = (await a.query(`SELECT tipo_pessoa, cnpj, cpf, rg, nome_completo, razao_social, nome_fantasia, representante_nome, representante_cpf FROM clientes WHERE id = $1::uuid`,
      [criado.fechamento.clienteId])).rows[0];
    assert.deepEqual(g, { tipo_pessoa: "PJ", cnpj: OUTRO_CNPJ, cpf: null, rg: null, nome_completo: "Colégio Novo Ltda", razao_social: "Colégio Novo Ltda",
      nome_fantasia: "Colégio Novo", representante_nome: "Ana Representante", representante_cpf: rep });
    const historico = (await a.query(`SELECT metadata ->> 'tipoPessoa' AS t FROM eventos_historico_cliente WHERE cliente_id = $1::uuid AND tipo_evento = 'CADASTRO_CRIADO'`, [criado.fechamento.clienteId])).rows;
    assert.deepEqual(historico.map((r) => r.t), ["PJ"]);
    // Segunda vez, mesmo CNPJ como cliente novo: pede validação.
    await recusa(() => publico.criarFechamentoPublicoComIdentidade(entradaPublica(c, nativo.turno, dia(147), { nomeCompleto: "Colégio Novo Ltda", cpf: "", cnpj: OUTRO_CNPJ }, { tipo: "NOVO_CLIENTE" }), executor(a)), "CNPJ_EXISTENTE_REQUER_VALIDACAO");
    // Outra empresa: o CNPJ é único por empresa; nasce outro cadastro, sem revelar o primeiro.
    const { c: outra, nativo: nativoOutra } = await empresa();
    const daOutra = await publico.criarFechamentoPublicoComIdentidade(entradaPublica(outra, nativoOutra.turno, dia(148), { nomeCompleto: "Colégio Novo Filial Ltda", cpf: "", cnpj: OUTRO_CNPJ }, { tipo: "NOVO_CLIENTE" }), executor(a));
    assert.notEqual(daOutra.fechamento.clienteId, criado.fechamento.clienteId);
  });
});

test("112: modelo que qualifica o contratante como PF recusa o fechamento de PJ (admin, público e revisão comercial); PF segue", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (!com112) return t.skip("modelo sem a 112");
  await emTx(async () => {
    const { c, nativo } = await empresa();
    const { publico, admin, revisao } = servicos();
    const pj = await clientePj(c, CNPJ);
    const anivPj = await aniversariante(pj);
    const pf = await clientePf(c, cpfValido());
    const anivPf = await aniversariante(pf);

    // Modelo compatível: contexto sem bloqueio; fechamento público PJ com negociação (vai para a revisão comercial).
    assert.deepEqual((await admin.obterContextoFechamentoAdministrativo(pj, contexto(c))).modeloIncompativelPj, []);
    const negociado = await publico.criarFechamentoPublicoComIdentidade(entradaPublica(c, nativo.turno, dia(141),
      { nomeCompleto: "Escola Um Ltda", cpf: "", cnpj: CNPJ }, { tipo: "CLIENTE_EXISTENTE", provaToken: await prova(c, CNPJ), atualizarCadastro: false }, 90), executor(a));
    assert.equal(negociado.fechamento.status, "AGUARDANDO_APROVACAO");
    const pendente = (await a.query(`SELECT id::text AS id FROM aprovacoes_negociacao WHERE fechamento_id = $1::uuid AND status = 'PENDENTE'`, [negociado.fechamento.id])).rows[0].id;

    await publicarModelo(c, LEGADO_PF, 2);
    const contextoPj = await admin.obterContextoFechamentoAdministrativo(pj, contexto(c));
    assert.ok(contextoPj.modeloIncompativelPj.length > 0, "a revisão do fechamento mostra os trechos");
    assert.deepEqual((await admin.obterContextoFechamentoAdministrativo(pf, contexto(c))).modeloIncompativelPj, [], "PF: nada");

    await recusa(() => admin.criarFechamentoAdministrativo(pj, entradaAdmin(nativo.turno, dia(142), anivPj), contexto(c)), "MODELO_INCOMPATIVEL_PJ");
    const segundaProva = await prova(c, CNPJ);
    await recusa(() => publico.criarFechamentoPublicoComIdentidade(entradaPublica(c, nativo.turno, dia(143),
      { nomeCompleto: "Escola Um Ltda", cpf: "", cnpj: CNPJ }, { tipo: "CLIENTE_EXISTENTE", provaToken: segundaProva, atualizarCadastro: false }), executor(a)), "MODELO_INCOMPATIVEL_PJ");
    await recusa(() => revisao.revisarComercial(negociado.fechamento.id, c.empresa, { solicitacaoId: pendente, decisao: "APROVAR", valorBaseAprovado: 90, motivo: "Aprovado" },
      { usuarioId: c.usuario, origem: "FECHAMENTO_ADMIN" }, executor(a)), "MODELO_INCOMPATIVEL_PJ");
    assert.equal(await fechamentosDo(pj), 1, "nenhum fechamento novo da PJ");
    // Recusar continua possível (não leva ao contrato).
    const recusada = await revisao.revisarComercial(negociado.fechamento.id, c.empresa, { solicitacaoId: pendente, decisao: "RECUSAR", motivo: "Sem acordo" },
      { usuarioId: c.usuario, origem: "FECHAMENTO_ADMIN" }, executor(a));
    assert.equal(recusada.reutilizada, false);

    // PF com o mesmo modelo legado: fechamento administrativo normal.
    const pfCriado = await admin.criarFechamentoAdministrativo(pf, entradaAdmin(nativo.turno, dia(144), anivPf), contexto(c));
    assert.ok(pfCriado.fechamentoId);
  });
});

test("sem a 112: CNPJ no fechamento público → PJ_INDISPONIVEL/MIGRACAO_PENDENTE; PF comprovado pelo CPF segue", { skip: !opt(), timeout: 300_000 }, async (t) => {
  if (com112) return t.skip("modelo com a 112");
  await emTx(async () => {
    const { c, nativo } = await empresa();
    const { publico, admin } = servicos();
    const cpf = cpfValido();
    const pf = await clientePf(c, cpf);
    await a.query("SAVEPOINT recusa");
    await assert.rejects(publico.criarFechamentoPublicoComIdentidade(entradaPublica(c, nativo.turno, dia(145), { nomeCompleto: "Empresa Ltda", cpf: "", cnpj: CNPJ }, { tipo: "NOVO_CLIENTE" }), executor(a)),
      (e: { code?: string; details?: { motivo?: string } }) => { assert.equal(e.code, "PJ_INDISPONIVEL"); assert.equal(e.details?.motivo, "MIGRACAO_PENDENTE"); return true; });
    await a.query("ROLLBACK TO SAVEPOINT recusa");
    const criado = await publico.criarFechamentoPublicoComIdentidade(entradaPublica(c, nativo.turno, dia(145), { nomeCompleto: "Pessoa Física Sintética", cpf, rg: "123" },
      { tipo: "CLIENTE_EXISTENTE", provaToken: await prova(c, cpf), atualizarCadastro: true }), executor(a));
    assert.equal(criado.fechamento.clienteId, pf);
    assert.equal((await a.query(`SELECT rg FROM clientes WHERE id = $1::uuid`, [pf])).rows[0].rg, "123", "PF: RG gravado como antes");
    assert.deepEqual((await admin.obterContextoFechamentoAdministrativo(pf, contexto(c))).modeloIncompativelPj, []);
  });
});
