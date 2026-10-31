import assert from "node:assert/strict";
import test from "node:test";
import { ARQUIVO, PAGINAS, campos } from "./apoio.test.ts";
import { extracaoSchema, extrairPorRegras, SCHEMA_VERSAO, VAZIO } from "./extracao.ts";
import { casarComModelo, referenciaDoModeloPublicado } from "./modelo-referencia.ts";
import { executarImportacao, ImportacaoError } from "./motor.ts";
import { CNPJ_CONTRATADA, confirmarTudo, importacaoPj, NOVO, PF, PJ, SEM_ENDERECO } from "./apoio-entrega-a.test.ts";
import { classificarMatch, montarPlano, MENSAGEM_PJ_INDISPONIVEL } from "./plano.ts";
import { aplicarRevisao, completarRevisao, conflitosDeIdentidade, dadosNormalizados, decomporEndereco, montarRevisao } from "./rascunho.ts";
import type { ExtracaoContrato } from "./modelo.ts";
import { validarCep, validarCnpj, validarTipoPessoa, validarUf } from "./validadores.ts";

/**
 * Entrega A (plano rev. 2.1): CPF ou CNPJ, endereço, modelo publicado da empresa como referência e recusa de PJ antes de
 * qualquer gravação. Contratos de modelos diferentes do KidMais: outra empresa PF, outra empresa PJ e sem endereço.
 */
test("validadores v2: CNPJ numérico e alfanumérico, tipo de pessoa, CEP e UF", () => {
  assert.deepEqual(validarCnpj("11.222.333/0001-81"), { ok: true, valor: "11.222.333/0001-81" });
  assert.deepEqual(validarCnpj("12ABC34501DE35"), { ok: true, valor: "12.ABC.345/01DE-35" });
  assert.equal(validarCnpj("11.222.333/0001-82").ok, false, "DV errado");
  assert.equal(validarCnpj("00.000.000/0000-00").ok, false, "raiz placeholder");
  assert.equal(validarCnpj("529.982.247-25").ok, false, "CPF não é CNPJ");
  assert.deepEqual(validarTipoPessoa("PJ"), { ok: true, valor: "Pessoa jurídica" });
  assert.deepEqual(validarTipoPessoa("pessoa física"), { ok: true, valor: "Pessoa física" });
  assert.equal(validarTipoPessoa("empresa").ok, false);
  assert.deepEqual(validarCep("70000000"), { ok: true, valor: "70000-000" });
  assert.equal(validarCep("7000-000").ok, false);
  assert.deepEqual(validarUf("df"), { ok: true, valor: "DF" });
  assert.equal(validarUf("XX").ok, false);
});

test("schema v2: contratada e campos novos obrigatórios no JSON do provedor; extração sem eles é recusada", () => {
  assert.equal(SCHEMA_VERSAO, 2);
  const lida = extrairPorRegras(PF);
  assert.ok(extracaoSchema.safeParse(lida).success);
  const semContratada: Partial<typeof lida> = { ...lida };
  delete semContratada.contratada;
  assert.equal(extracaoSchema.safeParse(semContratada).success, false);
});

test("outra empresa PF: nome, CPF, RG, contatos e endereço; documento da contratada nunca vira o do cliente", () => {
  const revisao = montarRevisao(extrairPorRegras(PF), PF, ARQUIVO, { documentoContratada: CNPJ_CONTRATADA });
  const c = campos(revisao);
  assert.equal(revisao.versaoLeitura, 2);
  assert.equal(c["contratante.tipoPessoa"].valor, "Pessoa física");
  assert.equal(c["contratante.cpf"].normalizado, "529.982.247-25");
  assert.equal(c["contratante.cnpj"].valor, null, "CNPJ da contratada não entra no contratante");
  assert.equal(c["contratante.rg"].valor, "1.234.567");
  assert.equal(c["contratante.email"].valor, "paula@example.com");
  assert.equal(c["contratante.cep"].normalizado, "70000-000");
  assert.equal(c["contratante.endereco"].estado, "ENCONTRADO");
  // Partes sugeridas a partir do texto: cada uma pede confirmação (nunca entra calada).
  for (const [id, valor] of [["logradouro", "Rua das Acácias"], ["numero", "120"], ["complemento", "apto 302"], ["bairro", "Asa Sul"], ["cidade", "Brasília"], ["uf", "DF"]]) {
    assert.equal(c[`contratante.${id}`].valor, valor, id);
    assert.equal(c[`contratante.${id}`].estado, "PRECISA_REVISAO", id);
  }
  const confirmado = confirmarTudo(revisao);
  const plano = montarPlano(confirmado.extracao, confirmado.revisados, NOVO, null);
  assert.equal(plano.pronto, true, JSON.stringify(plano.bloqueios));
  assert.equal(plano.tipoPessoa, "PF");
  const cliente = plano.passos[0];
  assert.ok(cliente.tipo === "CLIENTE" && cliente.acao === "CRIAR");
  if (cliente.tipo === "CLIENTE" && cliente.acao === "CRIAR") {
    assert.deepEqual({ rg: cliente.dados.rg, cep: cliente.dados.cep, logradouro: cliente.dados.logradouro, numero: cliente.dados.numero, bairro: cliente.dados.bairro, cidade: cliente.dados.cidade, uf: cliente.dados.uf },
      { rg: "1.234.567", cep: "70000-000", logradouro: "Rua das Acácias", numero: "120", bairro: "Asa Sul", cidade: "Brasília", uf: "DF" });
  }
});

test("documento da contratada lido como CPF/CNPJ do cliente fica bloqueado (corrigir ou remover)", () => {
  const paginas = [`CONTRATANTE: Paula Ramos, CNPJ ${CNPJ_CONTRATADA}, telefone (61) 98765-4321.`];
  const c = campos(montarRevisao(extrairPorRegras(paginas), paginas, ARQUIVO, { documentoContratada: CNPJ_CONTRATADA }));
  assert.equal(c["contratante.cnpj"].validacao, "INVALIDO");
  assert.match(c["contratante.cnpj"].motivo ?? "", /documento da contratada/);
  assert.notEqual(c["contratante.tipoPessoa"].valor, "Pessoa jurídica", "documento bloqueado não define o tipo de pessoa");
});

test("outra empresa PJ: CNPJ do contratante, representante separado; plano recusa PJ antes de qualquer cadastro", () => {
  const revisao = montarRevisao(extrairPorRegras(PJ), PJ, ARQUIVO, { documentoContratada: CNPJ_CONTRATADA });
  const c = campos(revisao);
  assert.equal(c["contratante.tipoPessoa"].valor, "Pessoa jurídica");
  assert.equal(c["contratante.cnpj"].normalizado, "11.222.333/0001-81");
  assert.equal(c["contratante.cpf"].valor, null, "CPF do representante nunca vira CPF do contratante");
  assert.equal(c["contratante.representanteNome"].valor, "Carla Dias");
  assert.equal(c["contratante.representanteCpf"].normalizado, "529.982.247-25");
  const confirmado = confirmarTudo(revisao);
  const plano = montarPlano(confirmado.extracao, confirmado.revisados, NOVO, null);
  assert.equal(plano.pronto, false);
  assert.deepEqual(plano.recusa, { codigo: "PJ_INDISPONIVEL", motivo: "ENTREGA_A", mensagem: MENSAGEM_PJ_INDISPONIVEL });
  assert.equal(plano.bloqueios[0], MENSAGEM_PJ_INDISPONIVEL);
  // A identidade do cliente é o CNPJ: a busca de duplicidade nunca usa o CPF do representante.
  assert.equal(dadosNormalizados(confirmado.extracao.secoes.flatMap((s) => s.campos)).contratante.cpf, null);
});

const passo = (r: ReturnType<typeof aplicarRevisao>) => { assert.ok(!("erro" in r), JSON.stringify(r)); return r as Exclude<typeof r, { erro: string }>; };

test("rodada 2, P1-2: PF escolhido com CNPJ válido é impeditivo; confirmar divergência não libera; remover o CNPJ libera", () => {
  const paginas = ["CONTRATANTE: Paula Ramos, CNPJ 11.222.333/0001-81, telefone (61) 98765-4321.\nData do evento: 10/12/2026"];
  const lida = confirmarTudo(montarRevisao(extrairPorRegras(paginas), paginas, ARQUIVO));
  const pf = passo(aplicarRevisao(lida.extracao, lida.revisados, { campoId: "contratante.tipoPessoa", valor: "PF" }));
  const c = campos(pf.extracao);
  for (const id of ["contratante.tipoPessoa", "contratante.cnpj"]) {
    assert.equal(c[id].validacao, "AMBIGUO", id);
    assert.match(c[id].motivo ?? "", /Há CNPJ no contratante/, id);
    assert.ok("erro" in aplicarRevisao(pf.extracao, pf.revisados, { campoId: id, confirmarDivergencia: true }), `${id}: divergência de identidade não se confirma`);
    assert.ok("erro" in aplicarRevisao(pf.extracao, pf.revisados, { campoId: id }), `${id}: leitura não se confirma`);
  }
  const plano = montarPlano(pf.extracao, pf.revisados, NOVO, null);
  assert.deepEqual([plano.pronto, plano.tipoPessoa, plano.recusa], [false, "PF", null]);
  assert.ok(plano.bloqueios.includes("Identidade do contratante: Há CNPJ no contratante, mas o tipo está como pessoa física. Escolha o tipo certo ou remova o CNPJ."), JSON.stringify(plano.bloqueios));
  const semCnpj = passo(aplicarRevisao(pf.extracao, pf.revisados, { campoId: "contratante.cnpj", valor: "" }));
  assert.equal(montarPlano(semCnpj.extracao, semCnpj.revisados, NOVO, null).pronto, true);

  // PJ escolhido num contrato com CPF e sem CNPJ: nunca vira PF; o CPF fica recusado e o plano recusa PJ.
  const pj = passo(aplicarRevisao(confirmarTudo(montarRevisao(extrairPorRegras(PF), PF, ARQUIVO)).extracao, [], { campoId: "contratante.tipoPessoa", valor: "PJ" }));
  assert.equal(campos(pj.extracao)["contratante.cpf"].validacao, "AMBIGUO");
  const planoPj = montarPlano(pj.extracao, pj.revisados, NOVO, null);
  assert.deepEqual([planoPj.pronto, planoPj.tipoPessoa, planoPj.recusa?.codigo], [false, "PJ", "PJ_INDISPONIVEL"]);
  assert.deepEqual(conflitosDeIdentidade({ tipoPessoa: "PF", cpf: "529.982.247-25", cnpj: null, representanteCpf: "529.982.247-25" }).map((x) => x.ids), [["contratante.cpf", "contratante.representanteCpf"]]);
});

/** Revisão gravada antes da leitura v2: sem tipo de pessoa, CNPJ, RG, representante, e-mail nem seção de endereço. */
function revisaoV1(): ExtracaoContrato {
  const v2 = montarRevisao(extrairPorRegras(PAGINAS), PAGINAS, ARQUIVO);
  const ids = new Set(["contratante.tipoPessoa", "contratante.cnpj", "contratante.rg", "contratante.representanteNome", "contratante.representanteCpf", "contratante.email"]);
  return { ...v2, versaoLeitura: undefined, secoes: v2.secoes.filter((s) => s.id !== "endereco").map((s) => ({ ...s, campos: s.campos.filter((c) => !ids.has(c.id)) })) };
}

test("rodada 2, P1-1: revisão v1 retomada com PJ e CNPJ é recusada; CNPJ sem escolha pede o tipo; sem nada continua PF", () => {
  const completa = confirmarTudo(completarRevisao(revisaoV1()));
  const planoDe = (r: { extracao: ExtracaoContrato; revisados: string[] }) => montarPlano(r.extracao, r.revisados, NOVO, null);
  assert.deepEqual([planoDe(completa).tipoPessoa, planoDe(completa).recusa], ["PF", null]);

  const pj = passo(aplicarRevisao(completa.extracao, completa.revisados, { campoId: "contratante.tipoPessoa", valor: "PJ" }));
  const comCnpj = passo(aplicarRevisao(pj.extracao, pj.revisados, { campoId: "contratante.cnpj", valor: "11.222.333/0001-81" }));
  const recusado = planoDe(comCnpj);
  assert.deepEqual([recusado.pronto, recusado.tipoPessoa, recusado.recusa?.codigo, recusado.recusa?.motivo], [false, "PJ", "PJ_INDISPONIVEL", "ENTREGA_A"]);

  const soCnpj = planoDe(passo(aplicarRevisao(completa.extracao, completa.revisados, { campoId: "contratante.cnpj", valor: "11.222.333/0001-81" })));
  assert.deepEqual([soCnpj.pronto, soCnpj.tipoPessoa, soCnpj.recusa], [false, null, null]);
  assert.ok(soCnpj.bloqueios.includes("Confirme se o contratante é pessoa física ou jurídica."));
});

test("rodada 2, P1-3: CPF do representante no campo do contratante (saída válida da IA) pede confirmação e não define PF", () => {
  const lida = extrairPorRegras(PJ);
  lida.contratante.cpf = lida.contratante.representanteCpf;
  lida.contratante.cnpj = VAZIO; lida.contratante.representanteCpf = VAZIO; lida.contratante.representanteNome = VAZIO;
  assert.ok(extracaoSchema.safeParse(lida).success, "a saída simulada passa no schema do provedor");
  const revisao = montarRevisao(lida, PJ, ARQUIVO, { documentoContratada: CNPJ_CONTRATADA });
  const c = campos(revisao);
  assert.equal(c["contratante.cpf"].estado, "PRECISA_REVISAO");
  assert.match(c["contratante.cpf"].motivo ?? "", /junto do representante/);
  assert.equal(c["contratante.tipoPessoa"].valor, null, "documento não comprovado não define o tipo");
  const confirmado = confirmarTudo(revisao);
  const plano = montarPlano(confirmado.extracao, confirmado.revisados, NOVO, null);
  assert.deepEqual([plano.pronto, plano.tipoPessoa], [false, null]);

  // Sem rótulo de parte antes do documento: papel não comprovado; pede confirmação e o tipo fica para o operador.
  const solto = ["Paula Ramos, CPF 529.982.247-25, telefone (61) 98765-4321.\nData do evento: 10/12/2026"];
  const semRotulo = extrairPorRegras(solto);
  semRotulo.contratante.cpf = { valor: "529.982.247-25", pagina: 1, trecho: "Paula Ramos, CPF 529.982.247-25" };
  const s = campos(montarRevisao(semRotulo, solto, ARQUIVO));
  assert.equal(s["contratante.cpf"].evidencia?.conferida, true);
  assert.match(s["contratante.cpf"].motivo ?? "", /Não foi possível comprovar/);
  assert.equal(s["contratante.tipoPessoa"].valor, null);
});

test("rodada 2, P2-4: dois CPFs na qualificação do contratante ficam ambíguos; o operador digita o certo e escolhe o tipo", () => {
  // Rodada 4: "e seu cônjuge João Ramos" troca o titular e encerra a qualificação — o CPF dele não disputa com o dela.
  const comConjuge = ["CONTRATANTE: Paula Ramos, CPF 529.982.247-25, e seu cônjuge João Ramos, CPF 111.444.777-35, telefone (61) 98765-4321.\nData do evento: 10/12/2026"];
  const daContratante = campos(montarRevisao(extrairPorRegras(comConjuge), comConjuge, ARQUIVO));
  assert.deepEqual([daContratante["contratante.cpf"].normalizado, daContratante["contratante.cpf"].validacao], ["529.982.247-25", "VALIDO"]);
  // Dois CPFs sem titular que os separe: ambíguo.
  const paginas = ["CONTRATANTE: Paula Ramos e João Ramos, CPF 529.982.247-25 e CPF 111.444.777-35, telefone (61) 98765-4321.\nData do evento: 10/12/2026"];
  const revisao = montarRevisao(extrairPorRegras(paginas), paginas, ARQUIVO);
  const c = campos(revisao);
  assert.equal(c["contratante.cpf"].validacao, "AMBIGUO");
  assert.match(c["contratante.cpf"].motivo ?? "", /mais de um CPF .*529\.982\.247-25 e 111\.444\.777-35/);
  assert.equal(c["contratante.tipoPessoa"].valor, null);
  assert.equal(dadosNormalizados(revisao.secoes.flatMap((s) => s.campos)).contratante.cpf, null, "duplicidade nunca busca por CPF ambíguo");
  assert.ok("erro" in aplicarRevisao(revisao, [], { campoId: "contratante.cpf" }));
  const escolhido = passo(aplicarRevisao(revisao, [], { campoId: "contratante.cpf", valor: "111.444.777-35" }));
  const tipo = passo(aplicarRevisao(escolhido.extracao, escolhido.revisados, { campoId: "contratante.tipoPessoa", valor: "PF" }));
  const final = confirmarTudo(tipo.extracao);
  const plano = montarPlano(final.extracao, final.revisados, NOVO, null);
  assert.equal(plano.pronto, true, JSON.stringify(plano.bloqueios));
  const cliente = plano.passos[0];
  assert.ok(cliente.tipo === "CLIENTE" && cliente.acao === "CRIAR" && cliente.dados.cpf === "111.444.777-35");
});

test("rodada 2, P2-5: referência do modelo publicado só com cláusulas; título, preâmbulo e observações fora; dado literal vira [dado]", () => {
  const conteudo = {
    titulo: "Contrato SENTINELA-TITULO", preambulo: ["Preâmbulo SENTINELA-PREAMBULO 999.888.777-66"], observacoes: ["SENTINELA-OBS"],
    contratada: { nome: "Buffet Alegria", documento: CNPJ_CONTRATADA },
    clausulas: [
      { titulo: "Das partes", texto: "CONTRATANTE: {{contratante.nome}}, CPF {{contratante.cpf}}, residente em {{contratante.endereco}}." },
      { titulo: null, texto: "Dúvidas: maria@example.com, (61) 99999-1234, CPF 529.982.247-25, CNPJ 11.222.333/0001-81 ou 12.ABC.345/01DE-35, CEP 70000-000. Valor de R$ 5.000,00 em 10/12/2026." },
    ],
  };
  const ref = referenciaDoModeloPublicado({ id: "m1", versao: 4, conteudo });
  assert.deepEqual(ref, {
    modelo: { id: "m1", versao: 4, textos: [
      "Das partes", "CONTRATANTE: {{contratante.nome}}, CPF {{contratante.cpf}}, residente em {{contratante.endereco}}.",
      "Dúvidas: [dado], [dado], CPF [dado], CNPJ [dado] ou [dado], CEP [dado]. Valor de R$ 5.000,00 em 10/12/2026.",
    ] },
    documentoContratada: CNPJ_CONTRATADA,
  });
  assert.equal(/SENTINELA|999\.888/.test(JSON.stringify(ref.modelo)), false);
});

test("contrato sem endereço: só alerta (D-IMP-3); endereço parcial bloqueia; 'Deixar sem endereço' libera", () => {
  const sem = confirmarTudo(montarRevisao(extrairPorRegras(SEM_ENDERECO), SEM_ENDERECO, ARQUIVO));
  const planoSem = montarPlano(sem.extracao, sem.revisados, NOVO, null);
  assert.equal(planoSem.pronto, true, JSON.stringify(planoSem.bloqueios));
  assert.ok(planoSem.avisos.some((a) => /Endereço do contratante não localizado/.test(a)));

  const parcial = aplicarRevisao(sem.extracao, sem.revisados, { campoId: "contratante.cidade", valor: "Brasília" });
  assert.ok(!("erro" in parcial));
  if ("erro" in parcial) return;
  const planoParcial = montarPlano(parcial.extracao, parcial.revisados, NOVO, null);
  assert.equal(planoParcial.pronto, false);
  assert.ok(planoParcial.bloqueios.some((b) => /^Endereço incompleto: falta logradouro, número, bairro, UF\./.test(b)), JSON.stringify(planoParcial.bloqueios));

  const limpo = aplicarRevisao(parcial.extracao, parcial.revisados, { campoId: "contratante.endereco", limparEndereco: true });
  assert.ok(!("erro" in limpo));
  if ("erro" in limpo) return;
  assert.equal(montarPlano(limpo.extracao, limpo.revisados, NOVO, null).pronto, true);
  assert.equal(campos(limpo.extracao)["contratante.cidade"].valor, null);
});

test("decomposição do endereço só com formato inequívoco", () => {
  assert.deepEqual(decomporEndereco("Av. Central, 500, Centro, Goiânia/GO"), { logradouro: "Av. Central", numero: "500", complemento: null, bairro: "Centro", cidade: "Goiânia", uf: "GO" });
  assert.deepEqual(decomporEndereco("Rua A, nº 12, casa 2, Vila B, Recife - PE, CEP 50000-000")?.numero, "12");
  assert.equal(decomporEndereco("Rua A, Vila B, Recife/PE"), null, "sem número logo depois do logradouro");
  assert.equal(decomporEndereco("Rua A, 12, Recife/PE"), null, "sem bairro");
  assert.equal(decomporEndereco("Rua A, 12, Centro, Recife/XX"), null, "UF inválida");
});

test("revisão v1 (antes do CNPJ/endereço): continua PF e ganha os campos novos vazios, sem reler o documento", () => {
  const v2 = montarRevisao(extrairPorRegras(PAGINAS), PAGINAS, ARQUIVO);
  const ids = new Set(["contratante.tipoPessoa", "contratante.cnpj", "contratante.rg", "contratante.representanteNome", "contratante.representanteCpf", "contratante.email"]);
  const v1: ExtracaoContrato = { ...v2, versaoLeitura: undefined, secoes: v2.secoes.filter((s) => s.id !== "endereco").map((s) => ({ ...s, campos: s.campos.filter((c) => !ids.has(c.id)) })) };
  const completa = completarRevisao(v1);
  const c = campos(completa);
  assert.equal(c["contratante.cep"].estado, "NAO_ENCONTRADO");
  assert.match(c["contratante.cep"].motivo ?? "", /Não lido nesta versão/);
  assert.equal(c["contratante.cpf"].valor, campos(v2)["contratante.cpf"].valor, "dados já revisados preservados");
  assert.deepEqual(completarRevisao(completa), completa, "idempotente");
  const plano = montarPlano(completa, [], classificarMatch(dadosNormalizados(completa.secoes.flatMap((s) => s.campos)), { cpfExistente: null, possiveisDuplicidades: [] }), null);
  assert.equal(plano.tipoPessoa, "PF");
  assert.equal(plano.recusa, null);
});

test("modelo publicado da empresa: acha valores pelo contexto das cláusulas; janela ambígua é ignorada", () => {
  const modelo = { id: "m1", versao: 3, textos: [
    "A festa será realizada no dia {{festa.data}}, sem prorrogação.",
    "O pacote contratado para a festa é {{festa.pacote}}, conforme a tabela vigente.",
    "Com início da festa às {{festa.inicio}} e término às {{festa.fim}}, sem prorrogação.",
    "O valor total do contrato é de {{valor.total}}, pago conforme a cláusula seguinte.",
    "Fica eleito o foro {{contratante.nome}} da comarca.",
  ] };
  const paginas = ["A festa será realizada no dia 05/03/2027, sem prorrogação.\nO pacote contratado para a festa é Super Festa, conforme a tabela vigente.\nCom início da festa às 15:00 e término às 19:00, sem prorrogação.\nO valor total do contrato é de R$ 6.200,00, pago conforme a cláusula seguinte."];
  const achados = casarComModelo(paginas, modelo);
  assert.equal(achados["evento.data"]?.valor, "05/03/2027");
  assert.equal(achados["evento.horario"]?.valor, "15:00 às 19:00");
  assert.equal(achados["pacote.nome"]?.valor, "Super Festa");
  assert.equal(achados["valores.total"]?.valor, "R$ 6.200,00");
  for (const a of Object.values(achados)) assert.ok(paginas[0].includes((a.trecho ?? "").split(" ").slice(0, 3).join(" ")), "trecho vem do contrato importado");
  const repetido = [paginas[0] + "\n" + paginas[0]];
  assert.equal(casarComModelo(repetido, modelo)["evento.data"], undefined, "janela que aparece duas vezes não vale");
});

test("motor (defesa em profundidade): plano PJ ou sem tipo de pessoa nunca cadastra nem vincula cliente", async () => {
  const importacao = importacaoPj();
  const extracao = (importacao.dados as { extracao: ExtracaoContrato }).extracao;
  const plano = montarPlano(extracao, [], NOVO, null);
  const chamadas: string[] = [];
  const servicos = {
    async cadastrarCliente() { chamadas.push("cadastrar"); return { clienteId: "c" }; },
    async conferirCliente() { chamadas.push("conferir"); },
    async atualizarImportacao() { chamadas.push("atualizar"); return true; },
  };
  const entrada = { empresaId: "e", usuarioId: "u", requestId: "r", importacao, agora: "2026-10-31T00:00:00Z" };
  for (const p of [{ ...plano, pronto: true }, { ...plano, pronto: true, recusa: null, tipoPessoa: null }]) {
    const erro = await executarImportacao({} as never, { ...entrada, plano: p }, servicos).catch((e: unknown) => e);
    assert.ok(erro instanceof ImportacaoError);
    assert.equal(erro.code, "PJ_INDISPONIVEL");
  }
  assert.deepEqual(chamadas, []);
});

test("rodada 3, P1: \"Representante do contratante\" é cabeçalho de representante; testemunha e documento fora da qualificação não comprovam", () => {
  const simular = (paginas: string[], cpf: string, trecho: string) => {
    const lida = extrairPorRegras(paginas);
    lida.contratante.cpf = { valor: cpf, pagina: 1, trecho };
    lida.contratante.cnpj = VAZIO; lida.contratante.representanteCpf = VAZIO; lida.contratante.representanteNome = VAZIO;
    assert.ok(extracaoSchema.safeParse(lida).success);
    return montarRevisao(lida, paginas, ARQUIVO);
  };
  const empresa = ["CONTRATANTE: Empresa Exemplo Ltda, CNPJ 11.222.333/0001-81. Representante do contratante: Paula Ramos, CPF 529.982.247-25, telefone (61) 98765-4321.\nData do evento: 10/12/2026"];
  const revisao = simular(empresa, "529.982.247-25", "Paula Ramos, CPF 529.982.247-25");
  const c = campos(revisao);
  assert.match(c["contratante.cpf"].motivo ?? "", /junto do representante/);
  assert.equal(c["contratante.tipoPessoa"].valor, null);
  const confirmado = confirmarTudo(revisao);
  const plano = montarPlano(confirmado.extracao, confirmado.revisados, NOVO, null);
  assert.deepEqual([plano.pronto, plano.tipoPessoa], [false, null], JSON.stringify(plano.bloqueios));

  const comTestemunha = ["CONTRATANTE: Paula Ramos, CPF 529.982.247-25, telefone (61) 98765-4321.\nData do evento: 10/12/2026\nTESTEMUNHA: João Ramos, CPF 111.444.777-35."];
  const daTestemunha = campos(simular(comTestemunha, "111.444.777-35", "João Ramos, CPF 111.444.777-35"));
  assert.match(daTestemunha["contratante.cpf"].motivo ?? "", /junto do representante ou de outra parte/);
  assert.equal(daTestemunha["contratante.tipoPessoa"].valor, null);

  const depoisDaQualificacao = ["CONTRATANTE: Paula Ramos, telefone (61) 98765-4321.\nData do evento: 10/12/2026\nCPF 529.982.247-25"];
  const fora = campos(simular(depoisDaQualificacao, "529.982.247-25", "CPF 529.982.247-25"));
  assert.match(fora["contratante.cpf"].motivo ?? "", /Não foi possível comprovar/);
  assert.equal(fora["contratante.tipoPessoa"].valor, null);
});

test("rodada 3, P2: CPF de testemunha depois da qualificação não torna ambíguo o CPF do contratante", () => {
  const paginas = ["CONTRATANTE: Paula Ramos, CPF 529.982.247-25, telefone (61) 98765-4321.\nData do evento: 10/12/2026\nTESTEMUNHA: João Ramos, CPF 111.444.777-35."];
  const revisao = montarRevisao(extrairPorRegras(paginas), paginas, ARQUIVO);
  const c = campos(revisao);
  assert.equal(c["contratante.cpf"].normalizado, "529.982.247-25");
  assert.notEqual(c["contratante.cpf"].validacao, "AMBIGUO");
  assert.equal(c["contratante.tipoPessoa"].valor, "Pessoa física");
  assert.equal(dadosNormalizados(revisao.secoes.flatMap((s) => s.campos)).contratante.cpf, "529.982.247-25");
  // Testemunha na mesma linha, depois de ponto: o cabeçalho encerra a qualificação também.
  const naLinha = ["CONTRATANTE: Paula Ramos, CPF 529.982.247-25. Testemunha: João Ramos, CPF 111.444.777-35.\nData do evento: 10/12/2026"];
  assert.notEqual(campos(montarRevisao(extrairPorRegras(naLinha), naLinha, ARQUIVO))["contratante.cpf"].validacao, "AMBIGUO");
});

test("rodada 3, P2: CNPJ alfanumérico sem máscara também vira [dado]; palavra comum não", () => {
  const conteudo = { contratada: { documento: CNPJ_CONTRATADA }, clausulas: [{ titulo: null, texto: "CNPJ 12ABC34501DE35 e 12.ABC.345/01DE-35 e 11222333000181; responsabilidade12 segue." }] };
  assert.deepEqual(referenciaDoModeloPublicado({ id: "m1", versao: 1, conteudo }).modelo.textos, ["CNPJ [dado] e [dado] e [dado]; responsabilidade12 segue."]);
});

test("rodada 4, P1: documento com titular terceiro no rótulo (\"CPF da testemunha:\", \"Documento do fiador:\") não é do contratante nem define PF", () => {
  const simular = (paginas: string[], cpf: string, trecho: string) => {
    const lida = extrairPorRegras(paginas);
    lida.contratante.cpf = { valor: cpf, pagina: 1, trecho };
    lida.contratante.cnpj = VAZIO; lida.contratante.representanteCpf = VAZIO; lida.contratante.representanteNome = VAZIO;
    assert.ok(extracaoSchema.safeParse(lida).success);
    return montarRevisao(lida, paginas, ARQUIVO);
  };
  for (const rotulo of ["CPF da testemunha", "Documento do fiador", "CPF do cônjuge", "CPF do representante"]) {
    const paginas = [`CONTRATANTE: Empresa Exemplo Ltda, CNPJ 11.222.333/0001-81\n${rotulo}: 529.982.247-25, telefone (61) 98765-4321.`];
    const revisao = simular(paginas, "529.982.247-25", `${rotulo}: 529.982.247-25`);
    const c = campos(revisao);
    // Rodada 5, P3: rótulo de outro papel encerra a qualificação ⇒ titularidade incerta (sem afirmar outra parte).
    assert.match(c["contratante.cpf"].motivo ?? "", /Não foi possível comprovar/, rotulo);
    assert.equal(c["contratante.tipoPessoa"].valor, null, rotulo);
    const confirmado = confirmarTudo(revisao);
    const plano = montarPlano(confirmado.extracao, confirmado.revisados, NOVO, null);
    assert.deepEqual([plano.pronto, plano.tipoPessoa], [false, null], `${rotulo}: ${JSON.stringify(plano.bloqueios)}`);
  }
});

test("rodada 4, P2: qualificação distribuída em linhas (Nome:, CPF:, Endereço:) comprova o CPF; rótulo de terceiro ou de outro assunto encerra o bloco", () => {
  const simular = (paginas: string[], cpf: string, trecho: string) => {
    const lida = extrairPorRegras(paginas);
    lida.contratante.cpf = { valor: cpf, pagina: 1, trecho };
    lida.contratante.cnpj = VAZIO; lida.contratante.representanteCpf = VAZIO; lida.contratante.representanteNome = VAZIO;
    return montarRevisao(lida, paginas, ARQUIVO);
  };
  for (const paginas of [
    ["CONTRATANTE:\nNome: Paula Ramos\nCPF: 529.982.247-25"],
    ["CONTRATANTE:\nNome completo: Paula Ramos\nEstado civil: casada\nCPF do contratante: 529.982.247-25\nEndereço: Rua A, 10\nData do evento: 10/12/2026\nCPF da testemunha: 111.444.777-35"],
  ]) {
    const trecho = paginas[0].split(/\n/).find((l) => l.includes("529.982.247-25"))!;
    const c = campos(simular(paginas, "529.982.247-25", trecho));
    assert.equal(c["contratante.cpf"].motivo ?? null, null, paginas[0]);
    assert.notEqual(c["contratante.cpf"].validacao, "AMBIGUO");
    assert.equal(c["contratante.tipoPessoa"].valor, "Pessoa física", paginas[0]);
  }
  // O rótulo de terceiro encerra a qualificação: o CPF dele não torna ambíguo o do contratante.
  const comTerceiro = ["CONTRATANTE:\nNome: Paula Ramos\nCPF: 529.982.247-25\nCPF da testemunha: 111.444.777-35"];
  assert.notEqual(campos(simular(comTerceiro, "529.982.247-25", "CPF: 529.982.247-25"))["contratante.cpf"].validacao, "AMBIGUO");
});

/** Fluxo completo da revisão do Astra (rodada 4): IA põe o CPF em contratante.cpf, CNPJ vazio; confirmarTudo; plano NOVO. */
function fluxoComCpfDaIa(texto: string, nomeLido?: string) {
  const cpf = "529.982.247-25";
  const paginas = [texto + ", telefone (61) 98765-4321.\n" + SEM_ENDERECO[0].split("\n").slice(1).join("\n")];
  const lida = extrairPorRegras(paginas);
  const nome = nomeLido ?? (texto.includes("Paula Ramos") ? "Paula Ramos" : "Empresa Exemplo Ltda");
  lida.contratante.nome = { valor: nome, pagina: 1, trecho: nome };
  lida.contratante.cpf = { valor: cpf, pagina: 1, trecho: cpf };
  lida.contratante.cnpj = VAZIO; lida.contratante.representanteCpf = VAZIO; lida.contratante.representanteNome = VAZIO;
  assert.ok(extracaoSchema.safeParse(lida).success);
  const revisao = montarRevisao(lida, paginas, ARQUIVO);
  const c = campos(revisao);
  const confirmado = confirmarTudo(revisao);
  const plano = montarPlano(confirmado.extracao, confirmado.revisados, NOVO, null);
  return { motivo: c["contratante.cpf"].motivo ?? null, tipo: c["contratante.tipoPessoa"].valor, pronto: plano.pronto };
}

test("rodada 4, P1: titular de outra pessoa vale por toda a qualificação (vírgula, linha, parênteses, tabela, colunas), com ou sem CNPJ no texto", () => {
  const cpf = "529.982.247-25";
  for (const empresa of ["CONTRATANTE: Empresa Exemplo Ltda, CNPJ 11.222.333/0001-81", "CONTRATANTE: Empresa Exemplo Ltda", "CONTRATANTE: Marcos Lima"]) {
    for (const resto of [
      `, testemunha Paula Ramos, CPF ${cpf}`,
      `\nNome da testemunha Paula Ramos\nCPF: ${cpf}`,
      `\nFiadora: Paula Ramos\nCPF: ${cpf}`,
      `, testemunha Paula Ramos (CPF ${cpf})`,
      `, testemunha Paula Ramos (brasileira, CPF ${cpf})`,
      `\nC.P.F. da testemunha: ${cpf}`,
      `\nCPF da testemunha — ${cpf}`,
      `\nCPF da 1ª testemunha: ${cpf}`,
      `\n| Testemunha | CPF |\n| Paula Ramos | ${cpf} |`,
      `\nNome da testemunha\tCPF\nPaula Ramos\t${cpf}`,
      `, cônjuge Paula Ramos, CPF ${cpf}`,
      `, avalista Paula Ramos, CPF ${cpf}`,
      `, neste ato representada por Paula Ramos, brasileira, CPF ${cpf}`,
      `, marido Paulo Ramos, CPF ${cpf}`,
      `\nPaula Ramos, CPF ${cpf}, na qualidade de fiadora`,
      `\n| Nome | Função | CPF |\n| Paula Ramos | sócia | ${cpf} |`,
      `\n| Assinatura | CPF |\n| Paula Ramos | ${cpf} |`,
    ]) {
      const r = fluxoComCpfDaIa(empresa + resto);
      assert.deepEqual([r.tipo, r.pronto], [null, false], `${empresa}${resto}: ${JSON.stringify(r)}`);
      assert.ok(r.motivo, `${empresa}${resto}`);
      // Rodada 5, P3: sem empresa no cabeçalho, só a palavra do papel prova a troca ⇒ incerto; "Fiadora:" é cabeçalho de outra parte.
      if (empresa.endsWith("Lima")) assert.match(r.motivo ?? "", resto.includes("Fiadora:") ? /outra parte/ : /Não foi possível comprovar/, `${empresa}${resto}`);
    }
  }
  // Sem palavra de papel: o CNPJ antes do CPF na mesma qualificação basta para o CPF não ser do contratante.
  assert.equal(fluxoComCpfDaIa(`CONTRATANTE: Empresa Exemplo Ltda, CNPJ 11.222.333/0001-81, Paula Ramos, CPF ${cpf}`).pronto, false);
});

test("rodada 4, P2: descrição da própria contratante (sócia da, cônjuge de, casada com, profissão) não troca o titular", () => {
  const cpf = "529.982.247-25";
  for (const texto of [
    // Rodada 11: relação que nomeia outra pessoa deixa a titularidade incerta (ver "rodada 10, mudança deliberada").
    `CONTRATANTE: Paula Ramos, sócia de empresa, CPF ${cpf}`,
    `CONTRATANTE: Paula Ramos, brasileira, administradora de empresas, casada, CPF ${cpf}`,
    `CONTRATANTE:\nNome: Paula Ramos\nCPF/CNPJ do contratante: ${cpf}`,
    // "Nome do aniversariante:" não é dado da contratante (rótulo conferido inteiro): o CPF dele não disputa com o dela.
    `CONTRATANTE:\nNome: Paula Ramos\nCPF: ${cpf}\nNome do aniversariante: Lucas Ramos\nCPF do aniversariante: 111.444.777-35`,
    `CONTRATANTE:\n| Nome | CPF/CNPJ |\n| Paula Ramos | ${cpf} |`,
  ]) {
    const r = fluxoComCpfDaIa(texto);
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${texto}: ${JSON.stringify(r)}`);
  }
  // Pares negativos: o mesmo papel sem "de/da" é outra pessoa.
  for (const texto of [`CONTRATANTE: Paula Ramos, sócia Joana Lima, CPF ${cpf}`, `CONTRATANTE: Paula Ramos, cônjuge: João Ramos, CPF ${cpf}`]) {
    assert.match(fluxoComCpfDaIa(texto).motivo ?? "", /Não foi possível comprovar/, texto);
  }
});

test("rodada 5, P1-A: sinônimos, abreviação e Unicode decomposto do papel; empresa no cabeçalho sem CNPJ — sem PF automático", () => {
  const cpf = "529.982.247-25";
  const papeis = ["mandatária", "preposta", "responsável legal", "diretora", "administradora", "sócia-administradora", "representante", "outorgada", "rep. legal", "cônjuge"];
  for (const papel of papeis) for (const forma of [`por sua ${papel} Paula Ramos`, `${papel} Paula Ramos`]) {
    // Cabeçalho de pessoa física: só a palavra do papel decide (camada independente da marca de empresa e do CNPJ).
    const r = fluxoComCpfDaIa(`CONTRATANTE: Marcos Lima, ${forma}, CPF ${cpf}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${forma}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, forma);
  }
  // Empresa no nome da parte, sem CNPJ e sem papel: o CPF que vem depois não é comprovadamente do contratante.
  for (const parte of ["Empresa Exemplo Ltda", "Associação de Pais Alegria", "Buffet Exemplo ME", "Exemplo Festas S/A"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${parte}, Paula Ramos, CPF ${cpf}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], parte);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, parte);
  }
  // CNPJ válido (sem máscara) antes do CPF: evidência de outra pessoa.
  assert.match(fluxoComCpfDaIa(`CONTRATANTE: Empresa Exemplo Ltda, CNPJ 11222333000181, Paula Ramos, CPF ${cpf}`).motivo ?? "", /outra parte/);
});

test("rodada 5, P1-B: papel depois do CPF (aposto, parênteses, célula da linha) deixa a titularidade incerta; mudança explícita de pessoa não", () => {
  const cpf = "529.982.247-25";
  for (const resto of [
    `, Paula Ramos, CPF ${cpf}, testemunha`,
    `, Paula Ramos, CPF ${cpf}, como testemunha`,
    `, Paula Ramos, CPF ${cpf} (testemunha)`,
    `, Paula Ramos, CPF ${cpf}, representante legal da empresa`,
    `\n| Nome | CPF |\n| Paula Ramos | ${cpf} | testemunha`,
    `\n| Nome | CPF |\n| Paula Ramos | ${cpf} (testemunha) |`,
    `\n| Nome | CPF | Profissão |\n| Paula Ramos | ${cpf} | representante legal |`,
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Marcos Lima${resto}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${resto}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, resto);
  }
  // Mudança explícita de pessoa depois do CPF: a qualificação da contratante termina ali; o CPF dela vale e o outro não disputa.
  for (const texto of [
    `CONTRATANTE: Paula Ramos, CPF ${cpf}, e seu cônjuge João Ramos, CPF 111.444.777-35`,
    `CONTRATANTE: Paula Ramos, CPF ${cpf}, testemunha João Lima, CPF 111.444.777-35`,
  ]) {
    const r = fluxoComCpfDaIa(texto);
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${texto}: ${JSON.stringify(r)}`);
  }
});

test("rodada 5, P3 e controles PF: profissão ambígua pede confirmação com mensagem de titularidade incerta; descrições da contratante seguem PF", () => {
  const cpf = "529.982.247-25";
  for (const profissao of ["representante comercial", "procuradora do Estado"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, ${profissao}, CPF ${cpf}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], profissao);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, profissao);
    assert.doesNotMatch(r.motivo ?? "", /outra parte/, profissao);
  }
  for (const texto of [
    `CONTRATANTE: Paula Ramos, médica, CPF ${cpf}`,
    `CONTRATANTE: Paula Ramos, administradora de empresas, CPF ${cpf}`,
    // Rodada 11: relação que nomeia outra pessoa deixa a titularidade incerta (ver "rodada 10, mudança deliberada").
    `CONTRATANTE: Paula Ramos, funcionária pública, CPF ${cpf}`,
    `CONTRATANTE: Dra. Paula Ramos, CPF ${cpf}`,
    // Fim de frase encerra a qualificação: "CONTRATADA" na prosa seguinte não é aposto do CPF.
    `CONTRATANTE: Paula Ramos, CPF ${cpf}. A CONTRATADA prestará os serviços contratados`,
  ]) {
    const r = fluxoComCpfDaIa(texto);
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${texto}: ${JSON.stringify(r)}`);
  }
});

test("rodada 6, P1-A: aposto depois do CPF só vira outra pessoa com nome diferente E documento próprio", () => {
  const cpf = "529.982.247-25";
  for (const cauda of ["testemunha Paula Ramos", "(testemunha Paula Ramos)", "como testemunha Paula Ramos", "testemunha Legal", "testemunha Joana Lima", "e sua testemunha Joana Lima", "como testemunha, CPF 111.444.777-35"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${cauda}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${cauda}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, cauda);
  }
  // Mesmo nome com documento depois continua sendo o próprio titular (não abre outra pessoa).
  assert.equal(fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, testemunha Paula Ramos, CPF 111.444.777-35`).pronto, false);
  for (const cauda of ["testemunha João Lima, CPF 111.444.777-35", "e seu cônjuge João, CPF 111.444.777-35", "e seu cônjuge JOÃO, CPF 111.444.777-35"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${cauda}`);
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${cauda}: ${JSON.stringify(r)}`);
  }
});

test("rodada 6, P1-B: ponto final não encerra a qualificação; só fim estrutural (cabeçalho com ':' ou em linha nova, frase sobre a outra parte)", () => {
  const cpf = "529.982.247-25";
  for (const cauda of [". Na qualidade de testemunha", ". Atua como testemunha", ". Testemunha do contrato"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}${cauda}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${cauda}: ${JSON.stringify(r)}`);
  }
  for (const texto of [
    `CONTRATANTE: Paula Ramos, CPF ${cpf}. A CONTRATADA prestará os serviços`,
    `CONTRATANTE: Paula Ramos, CPF ${cpf}. Testemunha: João Lima, CPF 111.444.777-35`,
    `CONTRATANTE: Prof. Paula Ramos, CPF ${cpf}`,
    // Cabeçalho em linha nova logo depois de um ponto (".\nCláusula 1") encerra; "contratada" da cláusula não é aposto do CPF.
    `CONTRATANTE: Paula Ramos, CPF ${cpf}.\nCláusula 1 - a festa contratada será realizada no salão`,
  ]) {
    const r = fluxoComCpfDaIa(texto);
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${texto}: ${JSON.stringify(r)}`);
  }
});

test("rodada 6, P1-C: o documento se liga a exatamente um sujeito; razão social inteira (sem apagar 'de Festas Aurora Ltda') nunca é PF", () => {
  const cpf = "529.982.247-25";
  for (const parte of ["Casa de Festas Aurora Ltda", "Acme LLC", "Acme MEI", "Acme S/A", "Acme S. A.", "Clube Recreativo Aurora", "Hospital Santa Clara", "Paula Ramos"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${parte}, Paula Ramos, CPF ${cpf}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${parte}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, parte);
  }
  // Um só sujeito, mas pessoa jurídica pelo nome inteiro.
  for (const parte of ["Casa de Festas Aurora Ltda", "Hospital Santa Clara", "Acme MEI"]) {
    assert.equal(fluxoComCpfDaIa(`CONTRATANTE: ${parte}, CPF ${cpf}`).pronto, false, parte);
  }
  assert.equal(fluxoComCpfDaIa(`CONTRATANTE: Casa de Festas Aurora Ltda, Paula Ramos, CPF ${cpf}, como testemunha Paula Ramos`).pronto, false);
  // Tabela com um só sujeito, mas coluna que não é de qualificação: titularidade incerta.
  assert.equal(fluxoComCpfDaIa(`CONTRATANTE:\n| Assinatura | CPF |\n| Paula Ramos | ${cpf} |`).pronto, false);
  // Nenhum sujeito nomeado antes do documento: titular não identificado.
  assert.equal(fluxoComCpfDaIa(`CONTRATANTE: portadora do CPF ${cpf}`).pronto, false);
  // Controles: descrição com nome próprio depois de "da/com" e endereço antes do CPF não são outro sujeito.
  for (const texto of [
    // Rodada 11: relação que nomeia outra pessoa deixa a titularidade incerta (ver "rodada 10, mudança deliberada").
    // Rodada 12: endereço antes do documento deixa a titularidade incerta (ver "rodada 11, mudança deliberada").
    `CONTRATANTE: Paula Ramos, CPF ${cpf}, residente na Rua das Flores, 10, Bairro Centro, Brasília/DF`,
  ]) {
    const r = fluxoComCpfDaIa(texto);
    assert.deepEqual([r.motivo, r.tipo], [null, "Pessoa física"], `${texto}: ${JSON.stringify(r)}`);
  }
});

test("rodada 7, P1-A: fragmento não reconhecido antes do documento (minúscula, uma palavra, empresa) deixa a titularidade incerta", () => {
  const cpf = "529.982.247-25";
  for (const antes of ["empresa Estrela Dourada, Paula Ramos", "ACME, Paula Ramos", "Paula Ramos, joão lima", "Paula Ramos, João", "Paula Ramos, JOÃO LIMA", "empresa da Família Lima, Paula Ramos", "Paula Ramos e João Lima", "Paula Ramos, Paula Ramos"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes}, CPF ${cpf}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${antes}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, antes);
  }
  // Cada camada isolada: empresa como o próprio nome lido; papel sem preposição antes do CPF; aposto de outro papel
  // depois do CPF; nenhum nome antes do CPF; "Nome:" de outra pessoa na mesma linha do endereço rotulado.
  for (const parte of ["Casa de Festas Aurora Ltda", "Acme LLC", "Acme MEI", "Clube Recreativo Aurora", "Hospital Santa Clara", "Aurora Eventos ME"]) {
    assert.equal(fluxoComCpfDaIa(`CONTRATANTE: ${parte}, CPF ${cpf}`, parte).pronto, false, parte);
  }
  for (const texto of [`CONTRATANTE: Paula Ramos, gerente, CPF ${cpf}`, `CONTRATANTE: Paula Ramos, CPF ${cpf}, mandatária Paula Ramos`, `CONTRATANTE: Paula Ramos, CPF ${cpf}, rep. Paula Ramos`, `CONTRATANTE: portadora do CPF ${cpf}`, `CONTRATANTE: Paula Ramos; Endereço: Rua Azul, 10; Nome: João Lima; CPF: ${cpf}`]) {
    const r = fluxoComCpfDaIa(texto, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${texto}: ${JSON.stringify(r)}`);
  }
  // Rótulo do próprio documento colado ao nome (contrato KidMais: "Maria Teste de CPF: …") não é outro fragmento.
  assert.deepEqual(Object.values(fluxoComCpfDaIa(`CONTRATANTE: Maria Teste de CPF: ${cpf}`, "Maria Teste")), [null, "Pessoa física", true]);
  // Nome lido com dois titulares ("Paula Ramos e João Lima"): não comprova um contratante só.
  assert.equal(fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos e João Lima, CPF ${cpf}`, "Paula Ramos e João Lima").pronto, false);
  // Nome seguido de descrição sem vírgula: a marca de empresa da descrição não conta e o titular é só "Paula Ramos".
  for (const texto of [`CONTRATANTE: Paula Ramos brasileira portadora do CPF ${cpf}`, `CONTRATANTE: Paula Ramos funcionária pública, CPF ${cpf}`, `CONTRATANTE: Paula Ramos casada, CPF ${cpf}, e seu cônjuge João Ramos, CPF 111.444.777-35`]) {
    const r = fluxoComCpfDaIa(texto);
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${texto}: ${JSON.stringify(r)}`);
  }
  // Controles (P3): o nome lido em qualquer caixa, com tratamento, seguido de atributos reconhecidos.
  for (const [antes, nome] of [["paula ramos", "Paula Ramos"], ["PAULA RAMOS", "Paula Ramos"], ["Paula", "Paula"], ["Prof. Paula Ramos", "Paula Ramos"], ["Paula Ramos, Brasileira, Casada", "Paula Ramos"], ["Paula Ramos, Brasileira e casada", "Paula Ramos"], ["Paula Ramos, brasileira, empresária, maior e capaz", "Paula Ramos"], ["Paula Ramos casada", "Paula Ramos"]]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes}, CPF ${cpf}`, nome);
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${antes}: ${JSON.stringify(r)}`);
  }
});

test("rodada 7, P1-B: endereço é um segmento delimitado e não esconde outro nome", () => {
  const cpf = "529.982.247-25";
  for (const texto of [
    `CONTRATANTE: Paula Ramos\nEndereço: Rua Azul, 10\nNome: João Lima\nCPF: ${cpf}`,
    `CONTRATANTE: Paula Ramos, residente na Rua Azul, 10, João Lima, CPF ${cpf}`,
    `CONTRATANTE: Aurora Digital, com sede na Rua Azul, Paula Ramos, CPF ${cpf}`,
    `CONTRATANTE: Paula Ramos, residente na Rua Azul, 10, Centro, Vila Nova, Brasília/DF, CPF ${cpf}`,
  ]) {
    const r = fluxoComCpfDaIa(texto);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${texto}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, texto);
  }
  // Controles: endereço por extenso que termina em UF ou CEP, e endereço rotulado na própria linha.
  for (const texto of [
    // Rodada 12: endereço antes do documento deixa a titularidade incerta (ver "rodada 11, mudança deliberada").
    `CONTRATANTE: Paula Ramos, CPF ${cpf}, residente na Rua Azul, 10, apto 302, CEP 70000-000`,
    `CONTRATANTE:\nNome: Paula Ramos\nCPF: ${cpf}\nEndereço: Rua Azul, 10, Centro`,
  ]) {
    const r = fluxoComCpfDaIa(texto);
    assert.deepEqual([r.motivo, r.tipo], [null, "Pessoa física"], `${texto}: ${JSON.stringify(r)}`);
  }
});

test("rodada 7, P1-C: outra pessoa depois do documento só com documento próprio, diferente e ligado ao nome dela", () => {
  const cpf = "529.982.247-25";
  for (const depois of [
    `testemunha João Lima, CPF ${cpf}`,
    `e seu cônjuge João, CPF ${cpf}`,
    `testemunha João Lima sem documento. Documento de Paula Ramos: CPF ${cpf}`,
    "testemunha João Lima sem documento. Documento de Paula Ramos: CPF 111.444.777-35",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${depois}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${depois}: ${JSON.stringify(r)}`);
  }
  for (const depois of ["testemunha João Lima, CPF 111.444.777-35", "e seu cônjuge JOÃO, brasileiro, inscrito no CPF sob o nº 111.444.777-35", "testemunha João Lima, CPF 11.222.333/0001-81"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${depois}`);
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${depois}: ${JSON.stringify(r)}`);
  }
});

test("rodada 8, P1-A: atributo validado por inteiro; o documento de quem foi nomeado numa descrição não vira do titular", () => {
  const cpf = "529.982.247-25";
  for (const antes of [
    "Paula Ramos, casada com João Lima portador do",
    "Paula Ramos, casada com João Lima, portador do",
    "Paula Ramos, casada com João Lima que comparece nesta ocasião em nome próprio e está inscrito no",
    "Paula Ramos, casada com João Lima. João Lima possui",
    "Paula Ramos, nascido João Lima,",
    "Paula Ramos, telefone de João Lima. João Lima possui",
    "Paula Ramos, telefone de João Lima,",
    "Paula Ramos, RG de João Lima,",
    "Paula Ramos, funcionária da Empresa Exemplo Ltda, inscrita no",
    // Camadas isoladas: outra frase com atributo válido; complemento com prosa; documento dentro do complemento.
    "Paula Ramos, casada com João Lima. Brasileiro,",
    "Paula Ramos, filha de João Lima que assina este contrato,",
    "Paula Ramos, casada com João Lima RG 1.234.567,",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${antes}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, antes);
  }
  // Documento próprio forjado com o documento de uma terceira pessoa.
  for (const depois of [
    "testemunha João Lima, casado com Carla Dias portadora do CPF 111.444.777-35",
    "testemunha João Lima, casado com Carla Dias, portadora do CPF 111.444.777-35",
    "testemunha João Lima, telefone de Carla Dias. Carla Dias possui CPF 111.444.777-35",
    "testemunha João Lima, RG de Carla Dias. Carla Dias possui CPF 111.444.777-35",
    "testemunha João Lima, casado com Carla Dias. Brasileira, CPF 111.444.777-35",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${depois}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${depois}: ${JSON.stringify(r)}`);
  }
  // Controles PF: atributos e contatos completos.
  for (const antes of [
    // Rodada 11: relação que nomeia outra pessoa deixa a titularidade incerta (ver "rodada 10, mudança deliberada").
    "Paula Ramos, casada sob o regime de comunhão parcial de bens,",
    "Paula Ramos, natural de Brasília DF,",
    "Paula Ramos, portadora do RG 1.234.567 SSP/DF,",
    "Paula Ramos, telefone (61) 98765-4321,",
    "Paula Ramos, brasileira, desempregada,",
    "Paula Ramos, brasileira, inscrita no",
    "Paula Ramos portadora do",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${antes}: ${JSON.stringify(r)}`);
  }
  for (const depois of ["testemunha João Lima, brasileiro, CPF 111.444.777-35", "testemunha João Lima, portador do CPF 111.444.777-35"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${depois}`);
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${depois}: ${JSON.stringify(r)}`);
  }
});

test("rodada 8, P1-B: rótulo e endereço validam o valor e a fronteira; outra frase na qualificação deixa incerto", () => {
  const cpf = "529.982.247-25";
  for (const texto of [
    `CONTRATANTE: Paula Ramos\nProfissão: João Lima\nCPF: ${cpf}`,
    `CONTRATANTE: Paula Ramos\nNacionalidade: João Lima\nCPF: ${cpf}`,
    `CONTRATANTE: Paula Ramos\nEstado civil: João Lima\nCPF: ${cpf}`,
    `CONTRATANTE: Paula Ramos\nProfissão: médico. João Lima é inscrito no CPF ${cpf}`,
    `CONTRATANTE: Paula Ramos\nEndereço: Rua Azul, 10. João Lima é inscrito no CPF ${cpf}`,
    `CONTRATANTE: Paula Ramos\nBairro: João Lima é inscrito no\nCPF: ${cpf}`,
    `CONTRATANTE:\n| Nome: Paula Ramos | Profissão: João Lima | CPF: ${cpf} |`,
    `CONTRATANTE: Paula Ramos, residente na Rua Azul, 10, João Lima portador do, Brasília DF, CPF ${cpf}`,
    `CONTRATANTE: Paula Ramos, residente na Rua Azul, 10, João Lima Portador do, Brasília DF, CPF ${cpf}`,
  ]) {
    const r = fluxoComCpfDaIa(texto, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${texto}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, texto);
  }
  // Controles: rótulos com valores do próprio formato; endereço com logradouro, número, complemento, bairro e UF.
  for (const texto of [
    `CONTRATANTE: Paula Ramos\nProfissão: engenheira civil\nNacionalidade: brasileira\nEstado civil: casada\nCPF: ${cpf}`,
    // Rodada 12: endereço antes do documento deixa a titularidade incerta (ver "rodada 11, mudança deliberada").
    `CONTRATANTE: Paula Ramos, CPF ${cpf}, residente e domiciliada na Rua Azul, nº 10, apto 302, Centro, Brasília/DF`,
    `CONTRATANTE: Prof. Paula Ramos, CPF ${cpf}`,
    `CONTRATANTE: Paula Ramos ${cpf}`,
  ]) {
    const r = fluxoComCpfDaIa(texto, "Paula Ramos");
    assert.deepEqual([r.motivo, r.tipo], [null, "Pessoa física"], `${texto}: ${JSON.stringify(r)}`);
  }
});

test("rodada 9, P1-A: depois de uma relação que nomeia outra pessoa, só \"CPF\" sozinho segue o titular", () => {
  const cpf = "529.982.247-25";
  for (const antes of [
    "Paula Ramos, casada com João Lima, brasileiro, portador do",
    "Paula Ramos, casada com João Lima, brasileiro inscrito no",
    "Paula Ramos, casada com João Lima (brasileiro), titular do",
    "Paula Ramos, casada com João Lima, Profissão: médico, portador do",
    "Paula Ramos, casada com João Lima, nacionalidade: brasileiro, portador do",
    "Paula Ramos, casada com João Lima, profissão: aposentado, inscrito no",
    "Paula Ramos, casada com João Lima, nascido em 01/01/1990, portador do",
    "Paula Ramos, casada com João Lima, RG 1.234.567 SSP/DF, portador do",
    "Paula Ramos, casada com João Lima, telefone (61) 98765-4321, portador do",
    "Paula Ramos, filha de João Lima, aposentado, inscrito no",
    "Paula Ramos, Estado civil: casada com João Lima, portador do",
    "Paula Ramos, Profissão: cuidadora de João Lima, portador do",
    // Camadas isoladas: atributo simples sem rótulo relacional; relação como valor de campo rotulado antes de "CPF" sozinho;
    // relação no meio do fragmento (nome colado); a relação deliberada da rodada 4 seguida de profissão.
    "Paula Ramos, casada com João Lima, brasileiro,",
    "Paula Ramos, Estado civil: casada com João Lima,",
    "Paula Ramos cônjuge de João Ramos, administradora de empresas,",
    "Paula Ramos, brasileira, casada com João Ramos, administradora de empresas,",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${antes}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, antes);
  }
  // Documento próprio de outra pessoa forjado com o documento de quem ela nomeou.
  for (const depois of [
    "testemunha João Lima, casado com Carla Dias, brasileira, portadora do CPF 111.444.777-35",
    "testemunha João Lima, casado com Carla Dias, brasileira inscrita no CPF 111.444.777-35",
    "testemunha João Lima, casado com Carla Dias, RG 1.234.567 SSP/DF, portadora do CPF 111.444.777-35",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${depois}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${depois}: ${JSON.stringify(r)}`);
  }
  // Controles PF: "CPF" sozinho depois da relação (controle do Astra); relação sem nome; lugar de nascimento; ordem natural.
  for (const antes of [
    // Rodada 11: relação que nomeia outra pessoa deixa a titularidade incerta (ver "rodada 10, mudança deliberada").
    "Paula Ramos, casada pelo regime de separação total de bens,",
    "Paula Ramos, natural de Brasília DF, brasileira, portadora do",
    "Paula Ramos, brasileira, administradora de empresas, casada,",
    "Paula Ramos, Estado civil: casada, Profissão: médica, portadora do",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${antes}: ${JSON.stringify(r)}`);
  }
});

test("rodada 9, P1-B: prosa capitalizada não passa por nome, complemento ou endereço", () => {
  const cpf = "529.982.247-25";
  for (const antes of [
    "Paula Ramos, casada com João Lima Possui,",
    "Paula Ramos, casada com João Lima Tem,",
    "Paula Ramos, casada com João Lima Titular,",
    "Paula Ramos, casada com João Lima Sr. Possui,",
    "Paula Ramos, casada com João Lima Possui O,",
    "Paula Ramos, casada com João Lima Sr. Ele Possui,",
    "Paula Ramos, casada com João Lima Jr. Ele Possui O,",
    "Paula Ramos, casada com João Lima Que Possui O,",
    "Paula Ramos, residente na Rua Azul, 10, João Lima Possui, Brasília DF,",
    "Paula Ramos, Endereço: Rua Azul, 10, João Lima CPF.,",
    "Paula Ramos, Endereço: Rua Azul, 10, João Lima Inscrito.,",
    "Paula Ramos, Endereço: Rua Azul, 10, João Lima Jr. Ele Possui O,",
    // Camadas isoladas: complemento longo demais (> 8 palavras) e pontuação colada à palavra de documento.
    "Paula Ramos, casada com João Lima Lima Lima Lima Lima Lima Lima Lima,",
    "Paula Ramos, casada com João Lima, Possui:,",
  ]) {
    const texto = `CONTRATANTE: ${antes} CPF ${cpf}`;
    const r = fluxoComCpfDaIa(texto, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${antes}: ${JSON.stringify(r)}`);
  }
  for (const depois of ["testemunha João Lima, casado com Carla Dias Possui, CPF 111.444.777-35"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${depois}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${depois}: ${JSON.stringify(r)}`);
  }
  // Controles: abreviação de tratamento e iniciais não abrem outra frase.
  for (const antes of [
    "Dra. Paula Ramos, brasileira, portadora do RG 1.234.567 SSP/DF,",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.motivo, r.tipo], [null, "Pessoa física"], `${antes}: ${JSON.stringify(r)}`);
  }
});

test("rodada 9, P3: qualificações PF comuns ficam PF", () => {
  const cpf = "529.982.247-25";
  for (const qualificacao of [
    "advogada, OAB/DF 12345",
    "advogada, inscrita na OAB/SP sob o nº 123.456",
    "professora de educação infantil",
    "trabalhadora autônoma",
    "microempreendedora individual",
    "engenheira de produção",
    "professora universitária",
    "estudante de medicina",
    "bacharel em direito",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, brasileira, solteira, ${qualificacao}, CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${qualificacao}: ${JSON.stringify(r)}`);
  }
  // "OAB de João Lima" não é contato: só o formato da inscrição.
  const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, OAB de João Lima, CPF ${cpf}`, "Paula Ramos");
  assert.deepEqual([r.tipo, r.pronto], [null, false], JSON.stringify(r));
});

test("rodada 10, mudança deliberada: relação que nomeia outra pessoa ou entidade deixa a titularidade incerta, mesmo com \"CPF\" sozinho", () => {
  const cpf = "529.982.247-25";
  for (const antes of [
    "Paula Ramos, casada com João Lima,",
    "Paula Ramos, casada com João Lima, CPF/MF nº",
    "Paula Ramos cônjuge de João Ramos,",
    "Paula Ramos, esposa de João Ramos,",
    "Paula Ramos, filha de João Lima e Ana Lima,",
    "Paula Ramos, sócia da Empresa Exemplo,",
    "Paula Ramos, funcionária da Empresa Exemplo Ltda,",
    "Paula Ramos, responsável legal pelo menor Lucas Ramos,",
    "Paula Ramos, brasileira, administradora de empresas, casada com João Ramos,",
    "Paula Ramos, Brasileira e casada com João Lima,",
    "Paula Ramos, casada com o Sr. João Lima,",
  ]) {
    const texto = `CONTRATANTE: ${antes} ${antes.endsWith("nº") ? "" : "CPF "}${cpf}`;
    const r = fluxoComCpfDaIa(texto, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${antes}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, antes);
  }
  // Documento próprio de outra pessoa que nomeia uma terceira: não prova nada e não corta a qualificação.
  const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, testemunha João Lima, casado com Carla Dias, CPF 111.444.777-35`);
  assert.deepEqual([r.tipo, r.pronto], [null, false], JSON.stringify(r));
  // Pares em minúsculas: sem maiúscula no complemento, a descrição é conferida pelo vocabulário fechado.
  for (const antes of ["Paula Ramos, casada sob o regime de comunhão parcial de bens,", "Paula Ramos, técnica de enfermagem,", "Paula Ramos, sócia de empresa,"]) {
    const ok = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([ok.motivo, ok.tipo, ok.pronto], [null, "Pessoa física", true], `${antes}: ${JSON.stringify(ok)}`);
  }
});

test("rodada 10, P1-A e P1-B: lugar só por estrutura positiva; relação e oração fora do léxico ficam incertas", () => {
  const cpf = "529.982.247-25";
  for (const antes of [
    // P1-A: relação fora do léxico como campo de endereço.
    "Paula Ramos, Bairro: Irmã de João Lima, brasileiro, portador do",
    "Paula Ramos, Bairro: Sobrinha de João Lima, brasileiro, portador do",
    "Paula Ramos, Complemento: Irmã de João Lima, brasileiro, portador do",
    "Paula Ramos, residente na Rua Azul, 10, Irmã de João Lima, Brasília DF, brasileiro, portador do",
    // P1-B: oração capitalizada fora da lista de bloqueio.
    "Paula Ramos, casada com João Lima Apresenta O,",
    "Paula Ramos, casada com João Lima Informa Seu,",
    "Paula Ramos, casada com João Lima Declara Seu,",
    "Paula Ramos, casada com João Lima Exibe O,",
    "Paula Ramos, Endereço: Rua Azul, 10, João Lima Apresenta O,",
    "Paula Ramos, Bairro: João Lima Informa Seu,",
    "Paula Ramos, natural de João Lima Apresenta O,",
    "Paula Ramos, natural de João Lima, brasileiro, portador do",
    "Paula Ramos, nascida em João Lima, brasileiro, portador do",
    // Camadas isoladas: nome livre de duas palavras como bairro, cidade e UF; residência sem logradouro nem topônimo;
    // sigla sem número não é quadra; tipo de lugar com nomes demais.
    "Paula Ramos, Bairro: João Lima,",
    "Paula Ramos, Cidade: João Lima,",
    "Paula Ramos, UF: João Lima,",
    "Paula Ramos, residente em João Lima Apresenta O,",
    "Paula Ramos, residente na JOÃO LIMA, Brasília DF,",
    "Paula Ramos, residente na LIMA SILVA, Brasília DF,",
    "Paula Ramos, Endereço: João Lima Apresenta O,",
    "Paula Ramos, residente na Rua Azul, 10, João Lima Apresenta DF,",
    "Paula Ramos, Endereço: Rua Azul, 10, Bairro João Lima Informa Seu,",
    "Paula Ramos, Bairro: Vila João Lima Informa,",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${antes}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, antes);
  }
  for (const depois of ["testemunha João Lima, casado com Carla Dias Apresenta O, CPF 111.444.777-35", "testemunha João Lima, natural de Carla Dias Apresenta O, CPF 111.444.777-35"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${depois}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${depois}: ${JSON.stringify(r)}`);
  }
  // Controles PF: lugar de nascimento em topônimo; testemunha com atributo simples (endereço antes do documento: rodada 12).
  for (const texto of [
    `CONTRATANTE: Paula Ramos, natural de Belo Horizonte/MG, CPF ${cpf}`,
    `CONTRATANTE: Paula Ramos, CPF ${cpf}, testemunha João Lima, brasileiro, CPF 111.444.777-35`,
  ]) {
    const r = fluxoComCpfDaIa(texto, "Paula Ramos");
    assert.deepEqual([r.motivo, r.tipo], [null, "Pessoa física"], `${texto}: ${JSON.stringify(r)}`);
  }
});

test("rodada 11, camadas isoladas: cada regra antiga ainda tem um caso que só ela pega", () => {
  const cpf = "529.982.247-25";
  for (const antes of [
    // Endereço por extenso com bairro livre e sem UF/CEP no fim.
    "Paula Ramos, residente na Rua Azul, 10, Centro,",
    // Complemento em minúsculas fora do vocabulário (sem maiúscula, a sombra não age).
    "Paula Ramos, casada com joão lima apresenta o,",
    // Outra frase dentro de um atributo que, sem o ponto, seria reconhecido.
    "Paula Ramos, natural de São Paulo. Casada,",
    // Palavra de documento no logradouro; logradouro longo demais; início de endereço sem logradouro nem topônimo.
    "Paula Ramos, residente na Rua João Lima Possui, 10, Brasília DF,",
    "Paula Ramos, residente na Rua João Lima Lima Lima Lima Lima Lima Lima Lima, 10, Brasília DF,",
    "Paula Ramos, com endereço na João Lima Apresenta O,",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${antes}: ${JSON.stringify(r)}`);
  }
  // Documento próprio da testemunha: fragmento não reconhecido ou outra frase na ligação não provam que o CPF é dela.
  for (const depois of ["testemunha João Lima, Apresenta O, CPF 111.444.777-35", "testemunha João Lima, natural de São Paulo. Casado, CPF 111.444.777-35"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${depois}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${depois}: ${JSON.stringify(r)}`);
  }
  // Controles dos mesmos formatos sem o defeito.
  for (const texto of [
    `CONTRATANTE: Paula Ramos, CPF ${cpf}, residente na Rua Azul, 10, Centro, Brasília/DF`,
    `CONTRATANTE: Paula Ramos, natural de São Paulo, casada, CPF ${cpf}`,
    `CONTRATANTE: Paula Ramos, CPF ${cpf}, testemunha João Lima, natural de São Paulo, casado, CPF 111.444.777-35`,
  ]) {
    const r = fluxoComCpfDaIa(texto, "Paula Ramos");
    assert.deepEqual([r.motivo, r.tipo], [null, "Pessoa física"], `${texto}: ${JSON.stringify(r)}`);
  }
});

test("rodada 11, mudança deliberada: endereço antes do documento deixa a titularidade incerta; documento antes do endereço segue PF", () => {
  const cpf = "529.982.247-25";
  for (const texto of [
    `CONTRATANTE: Paula Ramos, residente na Rua Azul, 10, Centro, Brasília/DF, CPF ${cpf}`,
    `CONTRATANTE: Paula Ramos, residente e domiciliada na Rua Azul, nº 10, apto 302, Centro, Brasília/DF, inscrita no CPF ${cpf}`,
    `CONTRATANTE: Paula Ramos, residente em Brasília/DF, CPF ${cpf}`,
    `CONTRATANTE: Paula Ramos, com endereço na Rua Azul, 10, Brasília DF, CPF ${cpf}`,
    `CONTRATANTE:\nNome: Paula Ramos\nEndereço: Rua Azul, 10, Centro\nCPF: ${cpf}`,
    `CONTRATANTE: Paula Ramos\nBairro: Asa Norte\nCidade: Brasília\nUF: DF\nCPF: ${cpf}`,
    `CONTRATANTE: Paula Ramos\nComplemento: Apto 302\nCPF: ${cpf}`,
    `CONTRATANTE: Paula Ramos\nNúmero: 10\nCPF: ${cpf}`,
    `CONTRATANTE:\n| Nome | Endereço | CPF |\n| Paula Ramos | Rua Azul, 10 | ${cpf} |`,
  ]) {
    const r = fluxoComCpfDaIa(texto, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${texto}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, texto);
  }
  for (const texto of [
    `CONTRATANTE: Paula Ramos, CPF ${cpf}, residente na Rua João Lima Apresenta O, 10, Centro, Brasília/DF`,
    `CONTRATANTE:\nNome: Paula Ramos\nCPF: ${cpf}\nEndereço: Rua Azul, 10\nBairro: Asa Norte`,
    `CONTRATANTE: Paula Ramos, brasileira, casada, empresária, portadora do RG 1.234.567 SSP/DF, inscrita no CPF ${cpf}, residente e domiciliada na Rua Azul, nº 10, Brasília/DF`,
    `CONTRATANTE: Paula Ramos, CEP 70000-000, CPF ${cpf}`,
  ]) {
    const r = fluxoComCpfDaIa(texto, "Paula Ramos");
    assert.deepEqual([r.motivo, r.tipo], [null, "Pessoa física"], `${texto}: ${JSON.stringify(r)}`);
  }
});

test("rodada 11, P1-A e P1-B: oração em lugar e relação sem maiúscula ficam incertas, também na prova de documento próprio", () => {
  const cpf = "529.982.247-25";
  for (const antes of [
    // P1-A: oração capitalizada em lugar e logradouro.
    "Paula Ramos, Bairro: Vila João Informa,",
    "Paula Ramos, Cidade: Vila João Informa, brasileiro, portador do",
    "Paula Ramos, Complemento: Vila João Informa, brasileiro, portador do",
    "Paula Ramos, UF: Vila João Informa, brasileiro, portador do",
    "Paula Ramos, Endereço: Rua João Lima Apresenta O, 10,",
    "Paula Ramos, residente na Rua João Lima Apresenta O, 10, Brasília DF,",
    "Paula Ramos, natural de Rua João Lima Apresenta O,",
    "Paula Ramos, natural de Vila João Informa, brasileira, portadora do",
    "Paula Ramos, nascida em São João Apresenta, brasileira, portadora do",
    // P1-B: relação sem maiúscula que introduz outra pessoa.
    "Paula Ramos, casada com o médico, brasileiro, portador do",
    "Paula Ramos, casada com o professor,",
    "Paula Ramos, filha de médico,",
    "Paula Ramos, responsável pelo menor,",
    "Paula Ramos, casada com a,",
    "Paula Ramos casada com o médico,",
    // Pares em maiúscula.
    "Paula Ramos, casada com o Médico,",
    "Paula Ramos, casada com O Médico,",
    // Topônimo estrito: dois nomes sem tipo de lugar no começo (custo declarado).
    "Paula Ramos, natural de Juiz de Fora,",
    "Paula Ramos, natural de Bela Vista,",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${antes}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, antes);
  }
  // Documento próprio de terceiro: o documento de quem foi descrito, ou depois de um endereço, não prova nada.
  for (const depois of [
    "testemunha João Lima, nascido em Rua João Lima Apresenta O, CPF 111.444.777-35",
    "testemunha João Lima, casado com a professora, portadora do CPF 111.444.777-35",
    "testemunha João Lima, casado com a médica, CPF 111.444.777-35",
    "testemunha João Lima, residente na Rua Azul, 10, CPF 111.444.777-35",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${depois}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${depois}: ${JSON.stringify(r)}`);
  }
  // Controles PF: descrições sem pessoa; lugar de nascimento em topônimo estrito; testemunha com atributos simples.
  for (const antes of [
    "Paula Ramos, casada sob o regime de comunhão parcial de bens,",
    "Paula Ramos, casada em regime de separação total de bens,",
    "Paula Ramos, técnica de enfermagem,",
    "Paula Ramos, administradora de empresas,",
    "Paula Ramos, sócia de empresa,",
    "Paula Ramos, estudante de medicina,",
    "Paula Ramos, maior de idade,",
    "Paula Ramos, natural de São Paulo/SP,",
    "Paula Ramos, natural de Rio de Janeiro,",
    "Paula Ramos, natural de Rio Grande do Sul,",
    "Paula Ramos, natural de Mato Grosso do Sul,",
    "Paula Ramos, nascida em Belo Horizonte - MG,",
    "Paula Ramos, natural de Brasília DF,",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${antes}: ${JSON.stringify(r)}`);
  }
  for (const depois of ["testemunha João Lima, brasileiro, CPF 111.444.777-35", "testemunha João Lima, natural de São Paulo, casado, CPF 111.444.777-35"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${depois}`);
    assert.deepEqual([r.motivo, r.tipo, r.pronto], [null, "Pessoa física", true], `${depois}: ${JSON.stringify(r)}`);
  }
});

test("rodada 12, camadas isoladas: relação, vocabulário do complemento e topônimo estrito", () => {
  const cpf = "529.982.247-25";
  for (const antes of [
    // "com" sempre aponta para outra pessoa; relação pessoal mesmo com complemento do vocabulário.
    "Paula Ramos, casada com a empresa,",
    "Paula Ramos, cônjuge em regime de comunhão parcial de bens,",
    // Complemento só com artigo; profissão e "menor" fora do vocabulário; complemento longo demais.
    "Paula Ramos, sócia de o,",
    "Paula Ramos, sócia do médico,",
    "Paula Ramos, sócia do menor,",
    "Paula Ramos, técnica de enfermagem de enfermagem de enfermagem de enfermagem de enfermagem,",
    // Palavra de documento no topônimo; terceiro nome sem tipo nem qualificador.
    "Paula Ramos, natural de Vila Inscrito,",
    "Paula Ramos, natural de São João Apresenta,",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${antes}: ${JSON.stringify(r)}`);
  }
  // Residência na prova de documento próprio: endereço, não atributo, mesmo com complemento do vocabulário.
  const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, testemunha João Lima, residente no lar, CPF 111.444.777-35`);
  assert.deepEqual([r.tipo, r.pronto], [null, false], JSON.stringify(r));
  // Controles: entidade em minúsculas e escola no complemento.
  for (const antes of ["Paula Ramos, sócia da empresa,", "Paula Ramos, professora de escola,"]) {
    const ok = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([ok.motivo, ok.tipo, ok.pronto], [null, "Pessoa física", true], `${antes}: ${JSON.stringify(ok)}`);
  }
});

test("rodada 12, camadas isoladas: outra frase, relação no meio do fragmento e pontuação colada", () => {
  const cpf = "529.982.247-25";
  // Outra frase dentro de um atributo que, sem o ponto, seria reconhecido; relação colada ao nome.
  for (const antes of ["Paula Ramos, natural de Rio Grande. Norte,", "Paula Ramos casada com a empresa,"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${antes}: ${JSON.stringify(r)}`);
  }
  const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, testemunha João Lima, natural de Rio Grande. Norte, CPF 111.444.777-35`);
  assert.deepEqual([r.tipo, r.pronto], [null, false], JSON.stringify(r));
  // Controles: os mesmos atributos sem a outra frase; pontuação colada ao topônimo.
  for (const antes of ["Paula Ramos, natural de Rio Grande do Norte,", "Paula Ramos, natural de Brasília.,"]) {
    const ok = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([ok.motivo, ok.tipo, ok.pronto], [null, "Pessoa física", true], `${antes}: ${JSON.stringify(ok)}`);
  }
});

test("rodada 12, P1: nascimento só é lugar com conector locativo; filiação e companhia introduzem outra pessoa", () => {
  const cpf = "529.982.247-25";
  for (const antes of [
    "Paula Ramos, nascida com João, brasileiro, portador do",
    "Paula Ramos, nascida de Maria, brasileira, portadora do",
    "Paula Ramos, nascida da Maria,",
    "Paula Ramos, nascida do João,",
    "Paula Ramos, nascida com Maria,",
    "Paula Ramos, nascida com JOÃO,",
    "Paula Ramos, nascida pela Maria,",
    "Paula Ramos, nascida sob o Brasília,",
    // Conector trocado entre as cabeças: "natural em" e "nascida de" não são as formas locativas.
    "Paula Ramos, natural em Brasília,",
    "Paula Ramos, natural com João,",
    "Paula Ramos casada, nascida de Maria,",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${antes}: ${JSON.stringify(r)}`);
    assert.match(r.motivo ?? "", /Não foi possível comprovar/, antes);
  }
  for (const depois of [
    "testemunha João Lima, nascido de Maria, brasileira, portadora do CPF 111.444.777-35",
    "testemunha João Lima, nascido com Maria, CPF 111.444.777-35",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, ${depois}`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${depois}: ${JSON.stringify(r)}`);
  }
  // Controles: conectores locativos de cada cabeça.
  for (const antes of [
    "Paula Ramos, nascida em Brasília,",
    "Paula Ramos, nascida em São Paulo,",
    "Paula Ramos, nascido no Rio de Janeiro,",
    "Paula Ramos, nascida na Bahia,",
    "Paula Ramos, natural do Rio de Janeiro,",
    "Paula Ramos, natural da Bahia,",
    "Paula Ramos, brasileira, natural de Brasília DF, casada,",
  ]) {
    const ok = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([ok.motivo, ok.tipo, ok.pronto], [null, "Pessoa física", true], `${antes}: ${JSON.stringify(ok)}`);
  }
  const ok = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, testemunha João Lima, nascido em Brasília, CPF 111.444.777-35`);
  assert.deepEqual([ok.motivo, ok.tipo, ok.pronto], [null, "Pessoa física", true], JSON.stringify(ok));
});

test("rodada 12, limites: topônimo de três nomes só com qualificadores; rótulo de endereço vazio também é endereço antes do documento", () => {
  const cpf = "529.982.247-25";
  for (const antes of [
    "Paula Ramos, natural de Rio Grande Declara,",
    "Paula Ramos, natural de Rio Grande Declara.,",
    "Paula Ramos, natural de Vila Nova Informa,",
    "Paula Ramos, natural de Nossa Senhora Informa,",
    "Paula Ramos, natural de Rio Grande do Declara,",
    "Paula Ramos, natural de Rio Grande e Médico,",
    "Paula Ramos, natural de Rio Grande: Sul,",
    // Custo declarado: três nomes sem dois qualificadores.
    "Paula Ramos, natural de Nossa Senhora Aparecida,",
    // Rótulo de endereço sem valor, sozinho ou com o valor em outra célula.
    "Paula Ramos, Bairro,",
    "Paula Ramos, UF,",
    "Paula Ramos, Bairro:,",
    "Paula Ramos, Número | 10,",
    // Residência colada ao nome (sem vírgula) também é endereço, não descrição.
    "Paula Ramos residente no lar,",
  ]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: ${antes} brasileira, portadora do CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${antes}: ${JSON.stringify(r)}`);
  }
  for (const meio of ["natural de Rio Grande Declara", "natural de Rio Grande: João", "natural de Rio Grande: do Sul", "casado com a empresa", "Bairro:", "Bairro", "Número | 10"]) {
    const r = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, testemunha João Lima, ${meio}, brasileira, portadora do CPF 111.444.777-35`);
    assert.deepEqual([r.tipo, r.pronto], [null, false], `${meio}: ${JSON.stringify(r)}`);
  }
  // Controles: tipo + dois qualificadores; documento antes do rótulo de endereço.
  for (const antes of ["Paula Ramos, natural de Rio Grande do Sul,", "Paula Ramos, natural de Mato Grosso do Sul,", "Paula Ramos, natural de Rio Grande do Norte - RN,"]) {
    const ok = fluxoComCpfDaIa(`CONTRATANTE: ${antes} CPF ${cpf}`, "Paula Ramos");
    assert.deepEqual([ok.motivo, ok.tipo, ok.pronto], [null, "Pessoa física", true], `${antes}: ${JSON.stringify(ok)}`);
  }
  const ok = fluxoComCpfDaIa(`CONTRATANTE: Paula Ramos, CPF ${cpf}, Bairro: Asa Norte, testemunha João Lima, natural de Rio Grande do Sul, CPF 111.444.777-35`);
  assert.deepEqual([ok.motivo, ok.tipo, ok.pronto], [null, "Pessoa física", true], JSON.stringify(ok));
});
