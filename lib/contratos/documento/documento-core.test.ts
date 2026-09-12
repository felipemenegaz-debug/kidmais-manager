import { renderizarContratoOficialFestaCompletaV1 } from './oficial/festa-completa-v1.ts';
import assert from "node:assert/strict";
import test from "node:test";
import type { ContratoSnapshotV1 } from "../repositories";
import {
  gerarPdfDocumentoContrato,
  gerarPdfContratoOficial,
  hashPdfContrato,
  hashPdfContratoOficial,
  renderizarContratoOficial,
  renderizarDocumentoContrato,
} from "./index.ts";

const snapshot: ContratoSnapshotV1 = {
  schemaVersao: 1,
  fechamento: { id: "11111111-1111-4111-8111-111111111111", status: "AGUARDANDO_CONTRATO", origem: "CLIENTE" },
  contratante: {
    clienteId: "22222222-2222-4222-8222-222222222222",
    nomeCompleto: "João da Silva",
    cpf: "12345678909",
    rg: null,
    telefone: "61999999999",
    whatsapp: "61999999999",
    email: "joao@example.com",
    endereco: {
      cep: "70800000",
      logradouro: "SQN 000",
      numero: "10",
      complemento: "Bloco A",
      bairro: "Asa Norte",
      cidade: "Brasília",
      uf: "DF",
    },
  },
  responsavelAdicional: null,
  aniversariante: {
    id: "33333333-3333-4333-8333-333333333333",
    nome: "Maria",
    dataNascimento: "2020-05-10",
    idadeNoEvento: 6,
    temaFesta: "Ciência",
  },
  evento: {
    data: "2026-10-20",
    horarioInicio: "18:00:00",
    horarioFim: "22:00:00",
    pacote: {
      id: "44444444-4444-4444-8444-444444444444",
      codigo: "COMPLETA",
      nome: "Festa Completa",
      duracaoMinutos: 240,
    },
    convidados: 50,
    convidadosFaturados: 50,
  },
  contratacao: {
    adicionais: [
      {
        adicionalId: "55555555-5555-4555-8555-555555555555",
        nome: "Penne",
        unidadeCobranca: "VALOR_FIXO",
        quantidade: 1,
        valorUnitario: 500,
        valorTotal: 500,
        observacoes: null,
      },
    ],
    alteracoesPacote: null,
    observacoesCliente: "Mesa próxima ao brinquedão.",
    observacoesEquipe: "Não deve aparecer no PDF público.",
    buffet: {
      status: "PENDENTE",
      salgados: null,
      bebidas: null,
      doces: null,
      bolo: null,
      outros: null,
    },
  },
  comercial: {
    tabelaPreco: {
      id: "66666666-6666-4666-8666-666666666666",
      codigo: "2026",
      nome: "Tabela 2026",
    },
    categoriaHorario: "PADRAO",
    categoriaPrecoAplicada: "PADRAO",
    valorPacoteBase: 8990,
    descontoPercentual: 0,
    valorDescontoPacote: 0,
    valorPacoteAplicado: 8990,
    valorAdicionais: 500,
    valorTabela: 9490,
    valorNegociado: null,
    valorAprovado: null,
    valorFinalContrato: 9490,
    formaPagamentoPretendida: "PIX_PARCELADO",
  },
};

const snapshotHash = "a".repeat(64);

test('Resumo da contratação V2 usa a versão contratual no cabeçalho e distingue a revisão do modelo', () => {
  const documento = renderizarDocumentoContrato({ snapshot, numeroVersao: 2, snapshotHash });
  const pdf = gerarPdfDocumentoContrato(documento).toString('latin1');
  assert.match(pdf, /\(Versão 2\)/);
  assert.doesNotMatch(pdf, /Versão 1/);
  assert.match(pdf, /Modelo do resumo - revisão 1/);
  assert.match(pdf, /Versão contratual 2/);
});

const hashesHistoricosV2 = {
  ESSENCIAL: '2d256c186600e5cd8dc777edd742938c5194398c9784b7bbe3214c72fd54fd60',
  COMPLETA: '8292ac19713a45c7d94fb35a49e3474c1a809a74f9c46d090379e33daf117322',
  PREMIUM: 'e132d28516fabf7d2718ea0ab59d9787c0ac8297fd584a71de1d74b160035c51',
};
for (const codigo of ['ESSENCIAL', 'COMPLETA', 'PREMIUM'] as const) {
  test(`${codigo}: template V2 histórico conserva exatamente os bytes anteriores ao acabamento`, () => {
    const s = structuredClone(snapshot);
    s.evento.pacote.codigo = codigo;
    s.aniversariante.nome = 'Catarina';
    s.aniversariante.idadeNoEvento = 1;
    const d = renderizarContratoOficial({ snapshot: s, numeroVersao: 1, snapshotHash, templateVersao: 2 });
    assert.ok(d);
    assert.match(d.contratante[2], /Catarina, 1 anos\./);
    assert.equal(hashPdfContratoOficial(gerarPdfContratoOficial(d)), hashesHistoricosV2[codigo]);
  });
  for (const idade of [0, 1, 2, 10, null]) {
    test(`${codigo}: V3 idade ${idade}, gramática pontual e demais textos/valores/negritos preservados`, () => {
      const s = structuredClone(snapshot);
      s.evento.pacote.codigo = codigo;
      s.aniversariante.nome = 'Catarina';
      s.aniversariante.idadeNoEvento = idade;
      const input = { snapshot: s, numeroVersao: 2, snapshotHash };
      const anterior = renderizarContratoOficial({ ...input, templateVersao: 2 });
      const atual = renderizarContratoOficial(input);
      assert.ok(anterior && atual);
      assert.equal(atual.modeloCodigo, `FESTA_${codigo}_V3`);
      assert.equal(atual.templateVersao, 3);
      assert.equal(atual.contratante[2], `Aniversariante: Catarina, ${idade == null ? 'idade não informada' : `${idade} ${idade === 1 ? 'ano' : 'anos'}`}. Tema: Ciência.`);
      assert.equal(s.aniversariante.idadeNoEvento, idade);
      assert.deepEqual(atual.contratante.slice(0, 2), anterior.contratante.slice(0, 2));
      for (let i = 0; i < 18; i++) {
        if (i !== 4 && i !== 7) assert.deepEqual(atual.clausulas[i], anterior.clausulas[i]);
      }
      assert.equal(atual.clausulas[4].texto, anterior.clausulas[4].texto.replace('se houve estoque disponível', 'se houver estoque disponível'));
      assert.equal(atual.clausulas[7].texto, anterior.clausulas[7].texto.replace('O espaço do subsolo e o buffet terminará', 'O funcionamento do espaço do subsolo e do buffet terminará').replace('os parabéns será cantado', 'os parabéns serão cantados'));
      for (const campo of ['contratada', 'preambulo', 'observacoes', 'integridade', 'assinatura'] as const) assert.deepEqual(atual[campo], anterior[campo]);
      const pdf = gerarPdfContratoOficial(atual).toString('latin1');
      assert.match(pdf, /se houver estoque/);
      assert.doesNotMatch(pdf, /se houve estoque|os parabéns será cantado/);
      const bold = [...pdf.matchAll(/\/F2 9\.00 Tf \(([^)]*)\) Tj/g)].map(x => x[1]).join('');
      for (const destaque of [...atual.clausulas[0].destaques!, ...atual.clausulas[2].destaques!]) assert(bold.includes(destaque.replace(/\u00a0/g, ' ')));
    });
  }
}

for (const [codigo, nome, valor] of [
  ['ESSENCIAL', 'Festa Essencial', '110,00'],
  ['COMPLETA', 'Festa Completa', '130,00'],
  ['PREMIUM', 'Festa Premium', '150,00'],
] as const) {
  test(`${codigo}: modelo próprio, excedente oficial, cláusulas preservadas e destaques reais no PDF`, () => {
    const s = structuredClone(snapshot);
    s.evento.pacote.codigo = codigo;
    s.evento.pacote.nome = 'Nome anterior não confiável';
    const input = { snapshot: s, numeroVersao: 2, snapshotHash, templateVersao: 2 as const };
    const documento = renderizarContratoOficial({ ...input, excedenteCentavos: 1 } as typeof input);
    assert.ok(documento);
    assert.equal(documento.modeloCodigo, `FESTA_${codigo}_V2`);
    assert.equal(documento.templateVersao, 2);
    assert.equal(documento.pacoteNome, nome);
    const antigo = renderizarContratoOficialFestaCompletaV1(input);
    for (let i = 0; i < 18; i++) {
      const esperado = antigo.clausulas[i].texto
        .replace('Nome anterior não confiável', nome)
        .replace('R$ 120,00 por pessoa excedente', `R$\u00a0${valor} por pessoa excedente`);
      assert.equal(documento.clausulas[i].texto.replace(/\u00a0/g, ' '), esperado.replace(/\u00a0/g, ' '));
    }
    for (const campo of ['contratada', 'contratante', 'preambulo', 'observacoes', 'integridade', 'assinatura'] as const) {
      assert.deepEqual(documento[campo], antigo[campo]);
    }
    const pdf = gerarPdfContratoOficial(documento).toString('latin1');
    // Extrai apenas os segmentos desenhados em Helvetica-Bold (F2).
    const bold = [...pdf.matchAll(/\/F2 9\.00 Tf \(([^)]*)\) Tj/g)].map(x => x[1]).join('');
    for (const destaque of [nome, '20/10/2026', '50 pessoas', `R$ ${valor} por pessoa excedente`]) {
      assert.ok(bold.includes(destaque), `Destaque ausente: ${destaque}`);
    }
    assert.doesNotMatch(documento.clausulas[2].texto, /120,00/);
    assert.equal(s.evento.pacote.nome, 'Nome anterior não confiável');
  });
}

test('renderização histórica V1 permanece idêntica e não recebe a nova tarifa', () => {
  const input = { snapshot, numeroVersao: 1, snapshotHash, templateVersao: 1 as const };
  const antigo = renderizarContratoOficialFestaCompletaV1(input);
  const resolvido = renderizarContratoOficial(input);
  assert.ok(resolvido);
  assert.deepEqual(resolvido, antigo);
  assert.deepEqual(gerarPdfContratoOficial(resolvido), gerarPdfContratoOficial(antigo));
  // Golden obtido com renderer e PDF engine do checkpoint anterior ao ajuste.
  assert.equal(hashPdfContratoOficial(gerarPdfContratoOficial(resolvido)), '328c0cd728828d9dc4c53ba23364135143da8ab76be8c715694d04699cb3a85f');
});

test("Resumo V1 não expõe observações internas da equipe", () => {
  const documento = renderizarDocumentoContrato({
    snapshot,
    numeroVersao: 1,
    snapshotHash,
  });
  const texto = documento.linhas.map((item) => item.texto).join("\n");
  assert.equal(documento.templateVersao, 1);
  assert.equal(documento.homologadoParaProducao, true);
  assert.match(texto, /João da Silva/);
  assert.match(texto, /Festa Completa/);
  assert.match(texto, /RESUMO DA CONTRATAÇÃO/);
  assert.match(texto, /não substitui o Contrato Oficial/i);
  assert.doesNotMatch(texto, /Não deve aparecer no PDF público/);
});

test("PDF do Resumo V1 é determinístico e possui assinatura PDF válida", () => {
  const documento = renderizarDocumentoContrato({
    snapshot,
    numeroVersao: 1,
    snapshotHash,
  });
  const pdfA = gerarPdfDocumentoContrato(documento);
  const pdfB = gerarPdfDocumentoContrato(documento);
  assert.equal(pdfA.subarray(0, 8).toString("latin1"), "%PDF-1.4");
  assert.match(pdfA.toString("latin1"), /\/Subtype \/Image/);
  assert.match(pdfA.toString("latin1"), /\/Logo \d+ 0 R/);
  assert.deepEqual(pdfA, pdfB);
  assert.equal(hashPdfContrato(pdfA), hashPdfContrato(pdfB));
  assert.match(hashPdfContrato(pdfA), /^[0-9a-f]{64}$/);
});


test("Contrato Oficial Festa Completa aplica regras revisadas e não expõe observações internas", () => {
  const documento = renderizarContratoOficial({
    snapshot,
    numeroVersao: 1,
    snapshotHash,
    geradoEm: "2026-09-08T12:00:00.000Z",
  });
  assert.ok(documento);
  assert.equal(documento.modeloCodigo, "FESTA_COMPLETA_V3");
  assert.equal(documento.homologadoParaProducao, true);
  assert.equal(documento.avisoHomologacao, null);
  assert.equal(documento.clausulas.length, 18);
  assert.deepEqual(documento.clausulas.map((item) => item.numero), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.match(documento.clausulas[0].texto, /Festa Completa/);
  assert.match(documento.clausulas[1].texto, /R\$\s*9[.]490,00/);
  assert.match(documento.clausulas[2].texto, /8 \(oito\) dias corridos antes/);
  assert.match(documento.clausulas[2].texto, /contratação for concluída dentro dos 8/);
  assert.match(documento.clausulas[5].texto, /PIX parcelado/);
  assert.match(documento.clausulas[5].texto, /não constitui pagamento realizado nem quitação/);
  assert.match(documento.clausulas[6].texto, /Quando a contratação possuir parcelas/);
  assert.doesNotMatch(JSON.stringify(documento.clausulas), /R\$ 450,00/);
  assert.doesNotMatch(JSON.stringify(documento.clausulas), /CONTRATADA deverá pagar/);
  assert.match(documento.clausulas[17].texto, /foro da Comarca de Brasília-DF/);
  assert.match(documento.clausulas[17].texto, /ação judicial/);

  const formas = [
    ["PIX_AVISTA", /PIX à vista/],
    ["PIX_PARCELADO", /PIX parcelado/],
    ["CARTAO_CIELO", /Cartão \/ Cielo/],
  ] as const;
  for (const [forma, esperado] of formas) {
    const porForma = structuredClone(snapshot);
    porForma.comercial.formaPagamentoPretendida = forma;
    const renderizado = renderizarContratoOficial({
      snapshot: porForma,
      numeroVersao: 1,
      snapshotHash,
    });
    assert.ok(renderizado);
    assert.match(renderizado.clausulas[5].texto, esperado);
  }

  const textoCompleto = JSON.stringify(documento);
  assert.doesNotMatch(textoCompleto, /Não deve aparecer no PDF público/);
});

test("PDF do Contrato Oficial é determinístico e possui logo", () => {
  const documento = renderizarContratoOficial({
    snapshot,
    numeroVersao: 1,
    snapshotHash,
    geradoEm: "2026-09-08T12:00:00.000Z",
  });
  assert.ok(documento);
  const pdfA = gerarPdfContratoOficial(documento);
  const pdfB = gerarPdfContratoOficial(documento);
  assert.equal(pdfA.subarray(0, 8).toString("latin1"), "%PDF-1.4");
  assert.match(pdfA.toString("latin1"), /\/Subtype \/Image/);
  assert.deepEqual(pdfA, pdfB);
  assert.equal(hashPdfContratoOficial(pdfA), hashPdfContratoOficial(pdfB));
  assert.match(hashPdfContratoOficial(pdfA), /^[0-9a-f]{64}$/);
});

for (const [codigo, nome, modelo, excedente] of [
  ["POCKET", "Kidmais Pocket", "KIDMAIS_POCKET_V3", "190,00"],
  ["MINI_FESTA", "Mini Festa Kidmais", "MINI_FESTA_KIDMAIS_V3", "170,00"],
  ["COMPACTA", "Festa Compacta", "FESTA_COMPACTA_V3", null],
  ["ESSENCIAL", "Festa Essencial", "FESTA_ESSENCIAL_V3", "110,00"],
  ["COMPLETA", "Festa Completa", "FESTA_COMPLETA_V3", "130,00"],
  ["PREMIUM", "Festa Premium", "FESTA_PREMIUM_V3", "150,00"],
  ["PIZZA_PARTY", "Pizza Party", "PIZZA_PARTY_V3", null],
] as const) {
  test(`${codigo}: contrato usa a base jurídica existente e somente dados específicos conhecidos`, () => {
    const pacote = structuredClone(snapshot);
    pacote.evento.pacote.codigo = codigo;
    pacote.evento.pacote.nome = "Nome não confiável do formulário";
    const documento = renderizarContratoOficial({ snapshot: pacote, numeroVersao: 1, snapshotHash });
    assert.ok(documento);
    assert.equal(documento.modeloCodigo, modelo);
    assert.equal(documento.pacoteNome, nome);
    assert.match(documento.clausulas[0].texto, new RegExp(nome));
    if (excedente) {
      assert.match(documento.clausulas[2].texto.replace(/\u00a0/g, " "), new RegExp(`R\\$ ${excedente} por pessoa excedente`));
    } else {
      assert.doesNotMatch(documento.clausulas[2].texto, /R\$ 120,00 por pessoa excedente/);
      assert.doesNotMatch(documento.clausulas[2].texto, /será cobrado o valor de R\$/);
    }
  });
}

test("pacote desconhecido continua sem modelo oficial", () => {
  const semModelo = structuredClone(snapshot);
  semModelo.evento.pacote.codigo = "DESCONHECIDO";
  const documento = renderizarContratoOficial({ snapshot: semModelo, numeroVersao: 1, snapshotHash });
  assert.equal(documento, null);
});
