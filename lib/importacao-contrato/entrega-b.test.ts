import assert from "node:assert/strict";
import test from "node:test";
import { ARQUIVO } from "./apoio.test.ts";
import { confirmarTudo, importacaoPj, NOVO, PJ } from "./apoio-entrega-a.test.ts";
import { extrairPorRegras } from "./extracao.ts";
import { executarImportacao, ImportacaoError } from "./motor.ts";
import { classificarMatch, montarPlano, type ResultadoMatch } from "./plano.ts";
import { dadosNormalizados, montarRevisao } from "./rascunho.ts";
import type { ExtracaoContrato } from "./modelo.ts";
import { cadastroContratualDoTipo, cadastroPayloadPjSchema, cadastroPayloadSchema, formularioCadastro } from "../clientes/cadastro-contratual.ts";

/**
 * Entrega B (112): importação de contrato com contratante pessoa jurídica. Com a 112 a PJ é liberada; a chave é o CNPJ
 * (o CPF do representante nunca é procurado nem gravado como CPF do cliente); o vínculo só vale com cliente do mesmo tipo.
 */
const CNPJ = "11222333000181";
const lida = () => confirmarTudo(montarRevisao(extrairPorRegras(PJ), PJ, ARQUIVO));
const dadosDe = (e: ExtracaoContrato) => dadosNormalizados(e.secoes.flatMap((s) => s.campos));

test("com a 112: plano PJ pronto, cliente novo PJ sem CPF e sem RG, com CNPJ e representante; CNPJ no plano", () => {
  const { extracao, revisados } = lida();
  const plano = montarPlano(extracao, revisados, NOVO, null, { pessoaJuridica: true });
  assert.deepEqual([plano.pronto, plano.tipoPessoa, plano.recusa, plano.cnpj], [true, "PJ", null, CNPJ], JSON.stringify(plano.bloqueios));
  const cliente = plano.passos.find((p) => p.tipo === "CLIENTE");
  assert.ok(cliente?.tipo === "CLIENTE" && cliente.acao === "CRIAR");
  assert.equal(cliente.dados.nomeCompleto, "Escola Pequeno Saber Ltda");
  assert.equal(cliente.dados.cpf, null, "CPF do representante nunca vira CPF do cliente");
  assert.equal(cliente.dados.rg, undefined);
  assert.deepEqual([cliente.dados.tipoPessoa, cliente.dados.cnpj, cliente.dados.representanteNome, cliente.dados.representanteCpf], ["PJ", CNPJ, "Carla Dias", "52998224725"]);
  // Sem a 112 (opção ausente ou falsa): recusa, nenhum passo de cliente PJ.
  for (const opcoes of [undefined, { pessoaJuridica: false }]) {
    const recusado = montarPlano(extracao, revisados, NOVO, null, opcoes);
    assert.deepEqual([recusado.pronto, recusado.recusa?.motivo, recusado.cnpj], [false, "MIGRACAO_PENDENTE", undefined]);
  }
});

test("PF continua igual: nenhuma chave de PJ no cliente novo nem no plano", () => {
  const paginas = ["CONTRATANTE: Paula Ramos, CPF 529.982.247-25, telefone (61) 98765-4321.\nData do evento: 10/12/2026"];
  const { extracao, revisados } = confirmarTudo(montarRevisao(extrairPorRegras(paginas), paginas, ARQUIVO));
  for (const opcoes of [undefined, { pessoaJuridica: true }]) {
    const plano = montarPlano(extracao, revisados, NOVO, null, opcoes);
    assert.equal(plano.tipoPessoa, "PF");
    assert.equal("cnpj" in plano, false);
    const cliente = plano.passos.find((p) => p.tipo === "CLIENTE");
    assert.ok(cliente?.tipo === "CLIENTE" && cliente.acao === "CRIAR");
    assert.deepEqual(Object.keys(cliente.dados).filter((k) => ["tipoPessoa", "cnpj", "representanteNome", "representanteCpf"].includes(k)), []);
  }
});

test("match: na PJ a chave é o CNPJ (CPF existente ignorado); na PF, o CPF (CNPJ existente ignorado); arquivado pede restaurar", () => {
  const dados = dadosDe(lida().extracao);
  const cpf = { clienteId: "pf", nomeCompleto: "Carla Dias" };
  const cnpj = { clienteId: "pj", nomeCompleto: "Escola Pequeno Saber Ltda" };
  const pj = classificarMatch(dados, { cpfExistente: cpf, cnpjExistente: cnpj, possiveisDuplicidades: [] }, "PJ");
  assert.deepEqual([pj.estado, pj.clienteId, pj.motivo, pj.candidatos[0].motivos], ["CLIENTE_EXISTENTE", "pj", "Cliente encontrado pelo CNPJ.", ["CNPJ_IGUAL"]]);
  assert.equal(classificarMatch(dados, { cpfExistente: cpf, cnpjExistente: null, possiveisDuplicidades: [] }, "PJ").estado, "NOVO_CLIENTE");
  const arquivado = classificarMatch(dados, { cpfExistente: null, cnpjExistente: { ...cnpj, status: "INATIVO" }, possiveisDuplicidades: [] }, "PJ");
  assert.deepEqual([arquivado.estado, arquivado.motivo], ["PRECISA_REVISAO", "O CNPJ pertence a um cliente arquivado. Restaure o cadastro antes de importar."]);
  assert.equal(classificarMatch(dados, { cpfExistente: cpf, cnpjExistente: cnpj, possiveisDuplicidades: [] }).clienteId, "pf", "sem tipo = PF de antes");
  assert.equal(classificarMatch(dados, { cpfExistente: null, cnpjExistente: cnpj, possiveisDuplicidades: [] }, "PF").estado, "NOVO_CLIENTE");
});

test("vínculo por contato: contrato PJ não vincula PF nem outra PJ (CNPJ é único); contrato PF não vincula PJ; criar continua livre", () => {
  const { extracao, revisados } = lida();
  const match = (tipoPessoa: "PF" | "PJ"): ResultadoMatch => ({ estado: "POSSIVEL_MATCH", clienteId: null, motivo: "Há cliente com o mesmo telefone.", candidatos: [{ clienteId: "c1", nome: "Outro", motivos: ["TELEFONE_IGUAL"], tipoPessoa }] });
  const vincular = { tipo: "VINCULAR" as const, clienteId: "c1" };
  const comPf = montarPlano(extracao, revisados, match("PF"), vincular, { pessoaJuridica: true });
  assert.equal(comPf.pronto, false);
  assert.ok(comPf.bloqueios.includes("O cliente escolhido é pessoa física e o contrato é de pessoa jurídica. Escolha outro cliente ou crie um novo."));
  const comPj = montarPlano(extracao, revisados, match("PJ"), vincular, { pessoaJuridica: true });
  assert.ok(comPj.bloqueios.includes("O cliente escolhido tem outro CNPJ. Para este contrato, crie um novo cliente."));
  assert.equal(comPj.passos.some((p) => p.tipo === "CLIENTE"), false);
  assert.equal(montarPlano(extracao, revisados, match("PJ"), { tipo: "CRIAR" }, { pessoaJuridica: true }).pronto, true);

  const paginas = ["CONTRATANTE: Paula Ramos, CPF 529.982.247-25, telefone (61) 98765-4321.\nData do evento: 10/12/2026"];
  const pf = confirmarTudo(montarRevisao(extrairPorRegras(paginas), paginas, ARQUIVO));
  const pfComPj = montarPlano(pf.extracao, pf.revisados, match("PJ"), vincular, { pessoaJuridica: true });
  assert.ok(pfComPj.bloqueios.includes("O cliente escolhido é pessoa jurídica e o contrato é de pessoa física. Escolha outro cliente ou crie um novo."));
  // Candidato sem tipo informado (análise antiga) = PF: o vínculo PF segue como antes.
  const semTipo: ResultadoMatch = { ...match("PF"), candidatos: [{ clienteId: "c1", nome: "Outro", motivos: ["TELEFONE_IGUAL"] }] };
  assert.equal(montarPlano(pf.extracao, pf.revisados, semTipo, vincular).pronto, true);
});

test("motor (defesa em profundidade): vínculo relido de outro tipo ou outro CNPJ recusado; criar PJ chama o cadastro com os dados da PJ", async () => {
  const importacao = importacaoPj();
  const extracao = (importacao.dados as { extracao: ExtracaoContrato }).extracao;
  const chamadas: unknown[] = [];
  const servicosCom = (gravado: { tipoPessoa: "PF" | "PJ"; cnpj: string | null }) => ({
    async cadastrarCliente(_tx: unknown, _e: string, dados: unknown) { chamadas.push(["cadastrar", dados]); return { clienteId: "novo" }; },
    async conferirCliente() { chamadas.push("conferir"); return gravado; },
    async atualizarImportacao() { chamadas.push("atualizar"); return true; },
  });
  const entrada = { empresaId: "e", usuarioId: "u", requestId: "r", importacao, agora: "2026-11-01T00:00:00Z" };
  const existente: ResultadoMatch = { estado: "CLIENTE_EXISTENTE", clienteId: "c1", motivo: "Cliente encontrado pelo CNPJ.", candidatos: [{ clienteId: "c1", nome: "Escola", motivos: ["CNPJ_IGUAL"], tipoPessoa: "PJ" }] };
  const vinculo = montarPlano(extracao, [], existente, null, { pessoaJuridica: true });
  assert.equal(vinculo.pronto, true, JSON.stringify(vinculo.bloqueios));
  for (const gravado of [{ tipoPessoa: "PF" as const, cnpj: null }, { tipoPessoa: "PJ" as const, cnpj: "99888777000161" }]) {
    chamadas.length = 0;
    const erro = await executarImportacao({} as never, { ...entrada, plano: vinculo }, servicosCom(gravado)).catch((e: unknown) => e);
    assert.ok(erro instanceof ImportacaoError);
    assert.equal(erro.code, "TIPO_PESSOA_DIVERGENTE");
    assert.deepEqual(chamadas, ["conferir"], "nada além da leitura");
  }
  chamadas.length = 0;
  assert.equal((await executarImportacao({} as never, { ...entrada, plano: vinculo }, servicosCom({ tipoPessoa: "PJ", cnpj: CNPJ }))).clienteId, "c1");

  chamadas.length = 0;
  const novo = montarPlano(extracao, [], NOVO, null, { pessoaJuridica: true });
  assert.equal((await executarImportacao({} as never, { ...entrada, plano: novo }, servicosCom({ tipoPessoa: "PJ", cnpj: CNPJ }))).clienteId, "novo");
  const [[, dados]] = chamadas as Array<[string, Record<string, unknown>]>;
  assert.deepEqual([dados.tipoPessoa, dados.cnpj, dados.cpf], ["PJ", CNPJ, null]);
  // Plano adulterado: passo CRIAR PF num plano PJ não chega ao cadastro.
  chamadas.length = 0;
  const adulterado = { ...novo, passos: novo.passos.map((p) => (p.tipo === "CLIENTE" && p.acao === "CRIAR" ? { ...p, dados: { ...p.dados, tipoPessoa: undefined } } : p)) };
  const erro = await executarImportacao({} as never, { ...entrada, plano: adulterado }, servicosCom({ tipoPessoa: "PJ", cnpj: CNPJ })).catch((e: unknown) => e);
  assert.ok(erro instanceof ImportacaoError && erro.code === "IMPORTACAO_BLOQUEADA");
  assert.deepEqual(chamadas, []);
});

test("cadastro da conferência: PJ exige CPF e RG vazios e razão social; PF continua exigindo CPF válido; schema pelo tipo do cliente", () => {
  const base = { ...formularioCadastro({ nomeCompleto: "Escola Pequeno Saber Ltda", whatsapp: "62998765432" }) };
  assert.equal(cadastroContratualDoTipo("PJ").safeParse(base).success, true);
  assert.equal(cadastroContratualDoTipo("PJ").safeParse({ ...base, cpf: "529.982.247-25" }).success, false);
  assert.equal(cadastroContratualDoTipo("PJ").safeParse({ ...base, rg: "1234567" }).success, false);
  assert.equal(cadastroContratualDoTipo("PF").safeParse(base).success, false, "PF sem CPF");
  assert.equal(cadastroContratualDoTipo(null).safeParse({ ...base, cpf: "529.982.247-25" }).success, true);
  // strict nas duas formas: nenhum campo de PJ (CNPJ, representante) entra pela conferência.
  assert.equal(cadastroPayloadPjSchema.safeParse({ ...base, cnpj: CNPJ }).success, false);
  assert.equal(cadastroPayloadSchema.safeParse({ ...base, cpf: "529.982.247-25", tipoPessoa: "PJ" }).success, false);
  const erro = cadastroContratualDoTipo("PJ").safeParse({ ...base, nomeCompleto: "Es" });
  assert.equal(!erro.success && erro.error.issues[0].message, "Informe a razão social.");
});
