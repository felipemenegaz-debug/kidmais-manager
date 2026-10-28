import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CAMPOS_CONTRATO, CAMPOS_IDENTIFICACAO, CAMPOS_OBRIGATORIOS, REGRA_OBRIGATORIOS } from "./campos.ts";
import { conteudoModeloSchema, diagnosticoModelo, opcionaisNaoUsados, problemasDoConteudo, usadosNasClausulas, type ConteudoModelo } from "./conteudo.ts";
import {
  aplicarContratada, comporContratada, conferidaDe, contratadaEfetiva, formatarCnpjContratada, formatarEnderecoSede, type PerfilSede,
} from "./contratada.ts";
import { adicionarClausula, alterarTexto, comIds, cursorValido, destinoDoInserir, inserirCampo, moverClausula, removerClausula, semIds, trocarPorCampo, type ConteudoTela } from "./edicao.ts";
import { SNAPSHOT_EXEMPLO } from "./exemplo.ts";
import { renderizarModeloEmpresa } from "./renderizar.ts";
import { acaoModeloSchema, corpoPatchModeloSchema } from "./rota-schemas.ts";
import { sha256Texto } from "./sha256.ts";
import { detectarValoresFixos, versaoEstrutura, versaoTexto, type ClausulaTela } from "./valores-fixos.ts";

/** Plano "revisão do modelo de contrato v3" (rev. 10, 28/10/2026): regras da fase 1 e funções puras da fase 2. */
const D1: ConteudoModelo = {
  titulo: "Contrato de Prestação de Serviços de Festa",
  contratada: { nome: "Buffet Alegria Ltda", documento: "12.345.678/0001-95", endereco: "Rua das Flores, 100 - Goiânia/GO", representante: "João Souza, sócio" },
  preambulo: ["As partes acima têm, entre si, justo e contratado o seguinte."],
  clausulas: [
    { titulo: "Objeto", texto: "Festa {{festa.pacote}} no dia {{festa.data}}, das {{festa.inicio}} às {{festa.fim}}, para {{festa.convidados}} convidados." },
    { titulo: "Valor", texto: "O valor total é de {{valor.total}}. Condição: {{pagamento.condicao}}." },
    { titulo: "Foro", texto: "Fica eleito o foro de Goiânia/GO." },
  ],
  observacoes: [],
  cidadeAssinatura: "Goiânia/GO",
};

const sem = (chave: string, c: ConteudoModelo = D1): ConteudoModelo => ({
  ...c, clausulas: c.clausulas.map((x) => ({ ...x, texto: x.texto.replaceAll(`{{${chave}}}`, "X") })),
});

test("D1: os 7 obrigatórios nas cláusulas; nome e CPF fora da regra, mas o bloco fixo continua com eles no PDF", () => {
  assert.deepEqual([...CAMPOS_OBRIGATORIOS], ["festa.data", "festa.inicio", "festa.fim", "festa.pacote", "festa.convidados", "valor.total", "pagamento.condicao"]);
  assert.equal(REGRA_OBRIGATORIOS, "D1-20261028");
  for (const c of CAMPOS_IDENTIFICACAO) assert.ok(CAMPOS_CONTRATO.some((x) => x.chave === c), c);
  assert.deepEqual(problemasDoConteudo(D1), []);
  assert.doesNotMatch(JSON.stringify(D1.clausulas), /contratante\./, "sem nome/CPF nas cláusulas");
  const doc = renderizarModeloEmpresa({ id: "11111111-2222-4333-8444-555555555555", versao: 1, conteudo: D1 }, { snapshot: SNAPSHOT_EXEMPLO, numeroVersao: 1, snapshotHash: "a".repeat(64), geradoEm: "2026-10-07T12:00:00Z" });
  assert.match(doc.contratante[0], /CONTRATANTE: Maria da Silva \(exemplo\), CPF 123\.456\.789-09/);
  assert.equal(doc.assinatura[2], "CONTRATANTE: Maria da Silva (exemplo)");
  assert.deepEqual(diagnosticoModelo(D1), {
    incluidos: 7, total: 7,
    itens: [
      { chave: "festa.data", rotulo: "Data da festa", clausulas: [1] }, { chave: "festa.inicio", rotulo: "Horário de início", clausulas: [1] },
      { chave: "festa.fim", rotulo: "Horário de término", clausulas: [1] }, { chave: "festa.pacote", rotulo: "Pacote contratado", clausulas: [1] },
      { chave: "festa.convidados", rotulo: "Convidados contratados", clausulas: [1] }, { chave: "valor.total", rotulo: "Valor total do contrato", clausulas: [2] },
      { chave: "pagamento.condicao", rotulo: "Condição de pagamento", clausulas: [2] },
    ],
  });
});

test("D1: cada um dos 7 ausente recusa sozinho, com o rótulo (sem {{chave}})", () => {
  for (const chave of CAMPOS_OBRIGATORIOS) {
    const p = problemasDoConteudo(sem(chave));
    const rotulo = CAMPOS_CONTRATO.find((c) => c.chave === chave)!.rotulo;
    assert.deepEqual(p, [`Falta nas cláusulas: ${rotulo}.`], chave);
    assert.doesNotMatch(p[0], /\{\{/);
    assert.equal(diagnosticoModelo(sem(chave)).incluidos, 6, chave);
  }
});

test("D1: campo só no título geral, no preâmbulo ou nas observações não conta; no título da cláusula conta", () => {
  const fora = sem("pagamento.condicao");
  for (const onde of [{ titulo: "Contrato {{pagamento.condicao}}" }, { preambulo: ["{{pagamento.condicao}}"] }, { observacoes: ["{{pagamento.condicao}}"] }]) {
    const c = { ...fora, ...onde };
    assert.ok(problemasDoConteudo(c).includes("Falta nas cláusulas: Condição de pagamento."), JSON.stringify(onde));
    assert.equal(usadosNasClausulas(c).has("pagamento.condicao"), false);
  }
  const noTitulo = { ...fora, clausulas: [...fora.clausulas, { titulo: "Pagamento: {{pagamento.condicao}}", texto: "Conforme acima." }] };
  assert.deepEqual(problemasDoConteudo(noTitulo), []);
  assert.deepEqual(diagnosticoModelo(noTitulo).itens.at(-1)!.clausulas, [4]);
});

test("D1: 7 de 7 não basta: campo desconhecido ou mal fechado em qualquer texto continua bloqueando", () => {
  assert.ok(problemasDoConteudo({ ...D1, observacoes: ["{{cliente.senha}}"] }).some((p) => p.includes("{{cliente.senha}} não existe")));
  assert.ok(problemasDoConteudo({ ...D1, preambulo: ["Veja {{festa.data"] }).some((p) => p.includes("sem fechamento")));
  const comObservacao: ConteudoModelo = { ...D1, observacoes: ["{{cliente.senha}}"] };
  assert.equal(diagnosticoModelo(comObservacao).incluidos, 7);
});

test("opcionais não usados: determinístico, só cláusulas, sem os obrigatórios", () => {
  const o = opcionaisNaoUsados(D1).map((x) => x.chave);
  assert.ok(!o.some((c) => (CAMPOS_OBRIGATORIOS as readonly string[]).includes(c)));
  assert.ok(o.includes("aniversariante.tema") && o.includes("festa.salao"));
  assert.ok(opcionaisNaoUsados({ clausulas: [{ titulo: null, texto: "Tema {{aniversariante.tema}}" }] }).every((x) => x.chave !== "aniversariante.tema"));
  assert.deepEqual(opcionaisNaoUsados(D1), opcionaisNaoUsados(structuredClone(D1)));
});

// ── Contratada efetiva ─────────────────────────────────────────────────────
const PERFIL: PerfilSede = {
  versao: 12, razao_social: "  Buffet Alegria Festas Ltda ", cnpj: "11222333000181",
  sede_cep: "74000000", sede_logradouro: "Rua das Palmeiras", sede_numero: "100", sede_sem_numero: false, sede_complemento: "Sala 2",
  sede_bairro: "Centro", sede_cidade: "Goiânia", sede_uf: "go",
};

test("contratada: perfil completo vem do perfil (sede), com máscara e representante do modelo", () => {
  const c = comporContratada(PERFIL, D1);
  assert.equal(c.estado, "PERFIL");
  assert.equal(c.perfilVersao, 12);
  assert.deepEqual(c.valores, { nome: "Buffet Alegria Festas Ltda", documento: "11.222.333/0001-81", endereco: "Rua das Palmeiras, 100, Sala 2, Centro, Goiânia/GO, CEP 74000-000", representante: "João Souza, sócio" });
  assert.equal(formatarCnpjContratada("12ABC34501DE35"), "12.ABC.345/01DE-35", "alfanumérico");
  assert.equal(formatarEnderecoSede({ ...PERFIL, sede_numero: "", sede_sem_numero: true, sede_complemento: null }), "Rua das Palmeiras, s/n, Centro, Goiânia/GO, CEP 74000-000");
  assert.equal(comporContratada({ ...PERFIL, sede_numero: null, sede_sem_numero: true }, D1).estado, "PERFIL", "semNumero com número vazio");
  const final = aplicarContratada(D1, c);
  assert.deepEqual(final.contratadaOrigem, { origem: "PERFIL", perfilVersao: 12 });
  assert.doesNotThrow(() => conteudoModeloSchema.parse(final));
  const doc = renderizarModeloEmpresa({ id: "11111111-2222-4333-8444-555555555555", versao: 1, conteudo: final }, { snapshot: SNAPSHOT_EXEMPLO, numeroVersao: 1, snapshotHash: "a".repeat(64), geradoEm: "2026-10-07T12:00:00Z" });
  assert.equal(doc.contratada[0], "CONTRATADA: Buffet Alegria Festas Ltda, inscrita sob o nº 11.222.333/0001-81, com sede em Rua das Palmeiras, 100, Sala 2, Centro, Goiânia/GO, CEP 74000-000.");
  assert.doesNotMatch(JSON.stringify(doc), /contratadaOrigem|PERFIL/, "o renderizador ignora a origem");
});

test("contratada: cada item faltando → bloco INTEIRO do modelo (D4), sem misturar; sem perfil → modelo", () => {
  const casos: Array<[Partial<PerfilSede>, string]> = [
    [{ razao_social: "  " }, "razão social"], [{ cnpj: null }, "CNPJ"], [{ cnpj: "11222333000182" }, "CNPJ"],
    [{ sede_logradouro: null }, "logradouro da sede"], [{ sede_numero: " ", sede_sem_numero: false }, "número da sede"],
    [{ sede_bairro: "" }, "bairro da sede"], [{ sede_cidade: null }, "cidade da sede"], [{ sede_uf: "G" }, "UF da sede"],
    [{ sede_cep: "7400000" }, "CEP da sede"], [{ sede_cep: null }, "CEP da sede"],
  ];
  for (const [mudanca, falta] of casos) {
    const c = comporContratada({ ...PERFIL, ...mudanca }, D1);
    assert.equal(c.estado, "MODELO_INCOMPLETO", falta);
    assert.deepEqual(c.faltando, [falta]);
    assert.deepEqual(c.valores, D1.contratada, "bloco do modelo inteiro");
  }
  const s = comporContratada(null, D1);
  assert.equal(s.estado, "MODELO_SEM_PERFIL");
  assert.deepEqual(s.valores, D1.contratada);
  assert.equal(s.perfilVersao, null);
});

test("contratada: impressão muda com o perfil (versão ou dados), não com o texto do modelo (coberto pela versão do rascunho)", () => {
  const base = comporContratada(PERFIL, D1).sha256;
  assert.notEqual(comporContratada({ ...PERFIL, versao: 13 }, D1).sha256, base);
  assert.notEqual(comporContratada({ ...PERFIL, sede_bairro: "Setor Oeste" }, D1).sha256, base);
  assert.equal(comporContratada(PERFIL, { contratada: { ...D1.contratada, representante: "Outra" } }).sha256, base);
  assert.notEqual(comporContratada({ ...PERFIL, sede_cep: null }, D1).sha256, comporContratada({ ...PERFIL, sede_bairro: null }, D1).sha256);
  assert.deepEqual(conferidaDe(comporContratada(PERFIL, D1)), { origem: "PERFIL", perfilVersao: 12, sha256: base });
});

test("contratada: endereço de ~450 caracteres cabe no schema de 500; 501 não", () => {
  const longo = { ...PERFIL, sede_logradouro: "L".repeat(200), sede_complemento: "C".repeat(100), sede_bairro: "B".repeat(80), sede_cidade: "D".repeat(30) };
  const c = comporContratada(longo, D1);
  assert.ok(c.valores!.endereco.length > 430 && c.valores!.endereco.length <= 500, String(c.valores!.endereco.length));
  assert.doesNotThrow(() => conteudoModeloSchema.parse(aplicarContratada(D1, c)));
  assert.throws(() => conteudoModeloSchema.parse({ ...D1, contratada: { ...D1.contratada, endereco: "x".repeat(501) } }));
  assert.doesNotThrow(() => conteudoModeloSchema.parse({ ...D1, contratada: { ...D1.contratada, endereco: "x".repeat(300) } }), "legados ≤ 300");
});

test("contratada: contratadaOrigem é opcional e estrita; legados sem o campo seguem válidos", () => {
  assert.doesNotThrow(() => conteudoModeloSchema.parse(D1));
  for (const origem of [{ origem: "PERFIL", perfilVersao: 12 }, { origem: "MODELO_SEM_PERFIL", perfilVersao: null }]) {
    const r = conteudoModeloSchema.safeParse({ ...D1, contratadaOrigem: origem });
    assert.equal(r.success, true, JSON.stringify(origem));
    assert.deepEqual(r.data?.contratadaOrigem, origem);
  }
  assert.throws(() => conteudoModeloSchema.parse({ ...D1, contratadaOrigem: { origem: "ERRO", perfilVersao: null } }));
  assert.throws(() => conteudoModeloSchema.parse({ ...D1, contratadaOrigem: { origem: "PERFIL", perfilVersao: 1, extra: 1 } }));
});

type Consulta = { text: string; values?: readonly unknown[] };
function txFalso(respostas: (q: Consulta) => { rows: unknown[] } | Error) {
  const log: string[] = [];
  return {
    log,
    tx: { async query<Row extends object>(text: string, values?: readonly unknown[]) {
      log.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
      const r = respostas({ text, values });
      if (r instanceof Error) throw r;
      return { rows: r.rows as Row[], rowCount: r.rows.length };
    } },
  };
}

test("contratada (leitura): perfil da empresa comprovada; ambíguo ou falha → ERRO sem fallback, com savepoint", async () => {
  const ok = txFalso((q) => (/candidatos=1/.test(q.text) ? { rows: [{ id: "p1" }] } : /FROM public\.perfil_empresas WHERE id/.test(q.text) ? { rows: [PERFIL] } : { rows: [] }));
  const c = await contratadaEfetiva(ok.tx, "e1", D1);
  assert.equal(c.estado, "PERFIL");
  assert.deepEqual(ok.log, ["SAVEPOINT modelo_contrato_contratada", "SELECT p.id::text AS", "SELECT versao, razao_social,", "RELEASE SAVEPOINT modelo_contrato_contratada"]);
  const sql = readFileSync("lib/contratos/modelo-empresa/contratada.ts", "utf8");
  assert.doesNotMatch(sql, /perfil_empresa_revisoes|perfil_unidades/, "nunca o rascunho do perfil nem o salão");
  const ambiguo = txFalso((q) => (/candidatos=1/.test(q.text) ? { rows: [{ id: "p1" }, { id: "p2" }] } : { rows: [] }));
  const e = await contratadaEfetiva(ambiguo.tx, "e1", D1);
  assert.equal(e.estado, "ERRO");
  assert.equal(e.valores, null);
  assert.ok(ambiguo.log.includes("ROLLBACK TO SAVEPOINT"));
  const falha = txFalso((q) => (/candidatos=1/.test(q.text) ? new Error("relation does not exist") : { rows: [] }));
  assert.equal((await contratadaEfetiva(falha.tx, "e1", D1)).estado, "ERRO");
  const nenhum = txFalso(() => ({ rows: [] }));
  assert.equal((await contratadaEfetiva(nenhum.tx, "e1", D1)).estado, "MODELO_SEM_PERFIL");
  assert.throws(() => aplicarContratada(D1, e), /erro não é publicada/);
});

test("publicação: recompõe depois da trava, recusa ERRO e divergência, valida o conteúdo final e audita origem/sha/regra", () => {
  const fonte = readFileSync("lib/contratos/modelo-empresa/servico.ts", "utf8");
  const pub = fonte.slice(fonte.indexOf("export async function publicarModeloContrato"));
  const ordem = ["pg_advisory_xact_lock", "contratadaEfetiva(tx, ctx.empresaId, conteudo)", "PERFIL_INDISPONIVEL", "CONTRATADA_MUDOU", "conteudoModeloSchema.parse(aplicarContratada", "previaModeloContrato(final)", "JSON.stringify(final)", "INSERT INTO modelos_contrato_empresa"];
  let ultimo = -1;
  for (const marca of ordem) { const i = pub.indexOf(marca); assert.ok(i > ultimo, marca); ultimo = i; }
  assert.match(pub, /contratada: \{ origem: efetiva\.origem, perfilVersao: efetiva\.perfilVersao \}, conteudoSha256,/);
  assert.match(pub, /obrigatorios: CAMPOS_OBRIGATORIOS\.length, regraObrigatorios: REGRA_OBRIGATORIOS/);
  assert.match(pub, /efetiva\.origem !== conferida\.origem \|\| efetiva\.perfilVersao !== conferida\.perfilVersao \|\| efetiva\.sha256 !== conferida\.sha256/);
});

test("rota: envioId só dentro de revisao (UUID, opcional); fora ou inválido → recusado; publicar exige a contratada conferida", () => {
  const base = { versao: 3, revisao: { conteudo: D1, avisos: [] } };
  const id = "8c5f1d2e-3a4b-4c6d-8e9f-0a1b2c3d4e5f";
  const comEnvio = corpoPatchModeloSchema.safeParse({ ...base, revisao: { ...base.revisao, envioId: id } });
  assert.equal(comEnvio.success, true, "envioId UUID dentro de revisao");
  assert.equal(comEnvio.data?.revisao.envioId, id);
  assert.equal(corpoPatchModeloSchema.parse(base).revisao.envioId, undefined, "cliente antigo");
  assert.throws(() => corpoPatchModeloSchema.parse({ ...base, revisao: { ...base.revisao, envioId: "abc" } }));
  assert.throws(() => corpoPatchModeloSchema.parse({ ...base, envioId: id }), "fora de revisao");
  const conferida = { origem: "PERFIL", perfilVersao: 12, sha256: "a".repeat(64) };
  assert.equal(acaoModeloSchema.safeParse({ acao: "publicar", versao: 2, revisadoPorPessoa: true, contratadaConferida: conferida }).success, true);
  assert.throws(() => acaoModeloSchema.parse({ acao: "publicar", versao: 2, revisadoPorPessoa: true }));
  assert.throws(() => acaoModeloSchema.parse({ acao: "publicar", versao: 2, revisadoPorPessoa: true, contratadaConferida: { ...conferida, origem: "ERRO" } }));
  const rota = readFileSync("app/api/admin/configuracoes/modelo-contrato/[id]/route.ts", "utf8");
  assert.match(rota, /corpoPatchModeloSchema\.parse\(await request\.json\(\)\)/);
  assert.match(rota, /acaoModeloSchema\.parse\(await request\.json\(\)\)/);
  assert.match(rota, /if \(!comGestao\(tenant\) \|\| !data\.revisao \|\| data\.situacao !== "RASCUNHO"\) return null;/, "sem Gestão: contratadaEfetiva null");
  assert.match(rota, /if \(!comGestao\(tenant\)\) return \{ conteudo: pedido\.conteudo, conferida: null \};/, "prévia sem Gestão: bloco do modelo");
  assert.match(rota, /semPerfil: !previa\.conferida/);
  const painel = readFileSync("app/api/admin/configuracoes/modelo-contrato/route.ts", "utf8");
  assert.match(painel, /const atual = gestao && dados\.ativo \?/, "perfilVersaoAtual só para Gestão");
  const servico = readFileSync("lib/contratos/modelo-empresa/servico.ts", "utf8");
  assert.match(servico, /JSON\.stringify\(\{ conteudo, avisos: revisao\.avisos, \.\.\.\(revisao\.envioId \? \{ envioId: revisao\.envioId \} : \{\}\) \}\)/);
});

// ── Valores fixos ─────────────────────────────────────────────────────────────
const cl = (texto: string, id = "c1", titulo: string | null = null): ClausulaTela => ({ id, titulo, texto });
const achar = (texto: string) => detectarValoresFixos([cl(texto)]);

test("valores fixos: verdadeiros positivos com o trecho delimitado (R$ incluído, 'convidados' fica, par de horários junto)", () => {
  const t = "A festa será realizada em 28/10/2026, das 17:00 às 21:00, para 60 convidados do pacote. O valor total da contratação é de R$ 1.400,00 à vista";
  const a = achar(t);
  assert.deepEqual(a.map((x) => [x.campo, x.trecho, x.sugerir]), [
    ["festa.data", "28/10/2026", true], ["festa.horario", "das 17:00 às 21:00", true], ["festa.convidados", "60", true], ["valor.total", "R$ 1.400,00", true],
  ]);
  for (const x of a) assert.equal(t.slice(x.inicio, x.fim), x.trecho);
  assert.equal(a[2].depois.startsWith(" convidados"), true);
  assert.equal(a[1].substituto, "das {{festa.inicio}} às {{festa.fim}}");
  assert.deepEqual(a[1].campos, ["festa.inicio", "festa.fim"]);
  assert.equal(a[0].antes, "A festa será realizada em ");
  assert.ok(a.every((x) => x.antes.length <= 40 && x.depois.length <= 40));
  assert.equal(a[0].versaoTexto, versaoTexto(t));
  assert.equal(a[0].versaoEstrutura, versaoEstrutura([cl(t)]));
});

test("valores fixos: variantes aceitas (h, espaços, quebra de linha, repetições)", () => {
  assert.equal(achar("Festa das 17h às 21h.")[0]?.trecho, "das 17h às 21h");
  assert.equal(achar("Evento das 9:30\nàs 13:30.")[0]?.trecho, "das 9:30\nàs 13:30");
  const rep = achar("Festa em 01/11/2026 e festa de novo em 02/11/2026.");
  assert.deepEqual(rep.map((x) => x.trecho), ["01/11/2026", "02/11/2026"]);
  assert.equal(achar("O valor total do contrato: R$ 10000,00")[0]?.trecho, "R$ 10000,00");
});

test("valores fixos: falsos positivos só tracejam (sem sugestão)", () => {
  const casos: Array<[string, string]> = [
    ["O pagamento da festa vence em 28/10/2026.", "festa.data"],
    ["A montagem da festa será das 08:00 às 10:00.", "festa.horario"],
    ["O pacote da festa permite 10 convidados adicionais.", "festa.convidados"],
    ["Festa com tolerância de 5 convidados a mais.", "festa.convidados"],
    ["O valor total da multa da festa será de R$ 1.234,56", "valor.total"],
    ["O valor total das parcelas do contrato de R$ 1.234,56", "valor.total"],
    ["O valor total dos adicionais: R$ 300,00 do pacote", "valor.total"],
    ["O valor total com taxas do contrato: R$ 300,00", "valor.total"],
    ["O valor total dos excedentes do evento: R$ 300,00", "valor.total"],
    ["Contrato em 28/10/2026.", "festa.data"],
  ];
  for (const [t, campo] of casos) {
    const a = achar(t).filter((x) => x.campo === campo);
    assert.equal(a.length, 1, t);
    assert.equal(a[0].sugerir, false, t);
  }
});

test("valores fixos: fora do padrão nem traceja (data inválida, R$ longe ou depois de ponto)", () => {
  assert.equal(achar("Festa em 28/02/2026.").length, 1, "controle: a data válida vizinha é detectada");
  assert.equal(achar("Festa em 31/02/2026.").length, 0);
  assert.equal(achar("Festa em 10/13/2026.").length, 0);
  assert.equal(achar("O valor total, considerando todos os itens e serviços da festa, é R$ 1.000,00").filter((x) => x.campo === "valor.total").length, 0, "mais de 30 caracteres");
  assert.equal(achar("O valor total da festa. Pagamento R$ 1.000,00").filter((x) => x.campo === "valor.total").length, 0, "ponto entre os dois");
  assert.equal(achar("Festa das 25:00 às 26:00.").length, 0);
  assert.equal(detectarValoresFixos([cl("{{festa.data}} das {{festa.inicio}} às {{festa.fim}}")]).length, 0);
});

// ── Edição (pura) ─────────────────────────────────────────────────────────────
let n = 0;
const novoId = () => `id${++n}`;
const tela = (): ConteudoTela => comIds({ ...D1, clausulas: [{ titulo: "Objeto", texto: "Festa em 28/10/2026 no salão." }, { titulo: null, texto: "Valor." }] }, novoId);

test("edição: inserir no cursor e no fim; cursor antigo é recusado", () => {
  const c = tela();
  const [a, b] = c.clausulas;
  const cursor = { idClausula: a.id, inicio: 5, fim: 5, versaoTexto: versaoTexto(a.texto) };
  const r = inserirCampo(c, { tipo: "cursor", cursor }, "festa.pacote");
  assert.ok(r.ok);
  assert.equal(r.conteudo.clausulas[0].texto, "Festa{{festa.pacote}} em 28/10/2026 no salão.");
  assert.equal(r.cursor!.inicio, 5 + "{{festa.pacote}}".length);
  assert.equal(cursorValido(r.conteudo, cursor), false, "o texto mudou: cursor antigo inválido");
  assert.equal(inserirCampo(r.conteudo, { tipo: "cursor", cursor }, "festa.data").ok, false);
  const fim = inserirCampo(c, { tipo: "fim", idClausula: b.id }, "pagamento.condicao");
  assert.ok(fim.ok);
  assert.equal(fim.conteudo.clausulas[1].texto, "Valor. {{pagamento.condicao}}");
  assert.equal(inserirCampo(c, { tipo: "fim", idClausula: "sumiu" }, "festa.data").ok, false);
  const removida = removerClausula(c, a.id);
  assert.ok(removida.ok);
  assert.equal(cursorValido(removida.conteudo, cursor), false, "cláusula removida invalida o cursor");
});

test("edição: trocar por campo recusa texto mudado, cláusula reordenada e mesmo trecho em outra cláusula", () => {
  const c = tela();
  const [s] = detectarValoresFixos(c.clausulas);
  const ok = trocarPorCampo(c, s);
  assert.ok(ok.ok);
  assert.equal(ok.conteudo.clausulas[0].texto, "Festa em {{festa.data}} no salão.");
  const editado = alterarTexto(c, s.idClausula, "texto", "Festa em 28/10/2026 no salão!");
  assert.ok(editado.ok);
  assert.equal(trocarPorCampo(editado.conteudo, s).ok, false, "versaoTexto");
  const movido = moverClausula(c, s.idClausula, 1);
  assert.ok(movido.ok);
  const r = trocarPorCampo(movido.conteudo, s);
  assert.equal(r.ok, false, "versaoEstrutura");
  assert.match((r as { motivo: string }).motivo, /mudaram de lugar/);
  const desfeito = moverClausula(movido.conteudo, s.idClausula, -1);
  assert.ok(desfeito.ok);
  assert.ok(trocarPorCampo(desfeito.conteudo, s).ok, "de volta ao lugar, mesma estrutura");
  const outra: ConteudoTela = { ...c, clausulas: [c.clausulas[0], { ...c.clausulas[1], texto: c.clausulas[0].texto }] };
  const s2 = detectarValoresFixos(outra.clausulas)[1];
  assert.equal(s2.numero, 2);
  assert.equal(trocarPorCampo(outra, { ...s2, idClausula: outra.clausulas[0].id }).ok, false, "mesmo trecho em outra cláusula");
});

test("edição: mover, remover (nunca a última), adicionar e alternar preservam título, preâmbulo, observações e cidade; ids não vão ao servidor", () => {
  const c = { ...tela(), observacoes: ["Obs."] };
  const ids = c.clausulas.map((x) => x.id);
  const m = moverClausula(c, ids[0], 1);
  assert.ok(m.ok);
  assert.deepEqual(m.conteudo.clausulas.map((x) => x.id), [ids[1], ids[0]]);
  assert.equal(moverClausula(c, ids[0], -1).ok, false);
  const add = adicionarClausula(c, novoId);
  assert.ok(add.ok);
  assert.equal(add.conteudo.clausulas.length, 3);
  const so = { ...c, clausulas: [c.clausulas[0]] };
  assert.equal(removerClausula(so, ids[0]).ok, false);
  const t = alterarTexto(c, ids[1], "titulo", "");
  assert.ok(t.ok);
  assert.equal(t.conteudo.clausulas[1].titulo, null);
  for (const r of [m, add, t]) {
    assert.ok(r.ok);
    assert.equal(r.conteudo.titulo, c.titulo);
    assert.deepEqual(r.conteudo.preambulo, c.preambulo);
    assert.deepEqual(r.conteudo.observacoes, ["Obs."]);
    assert.equal(r.conteudo.cidadeAssinatura, c.cidadeAssinatura);
  }
  const servidor = semIds(c);
  assert.doesNotMatch(JSON.stringify(servidor), /"id"/);
  assert.doesNotThrow(() => conteudoModeloSchema.parse(servidor));
});

test("sha256 puro (tela) igual ao node:crypto", () => {
  for (const t of ["", "abc", "Festa ação {{festa.data}}", "x".repeat(55), "y".repeat(56), "z".repeat(1000)]) {
    assert.equal(sha256Texto(t), createHash("sha256").update(t).digest("hex"));
  }
});

test("edição: destino do Inserir só com seleção da cláusula EM EDIÇÃO (revisão Astra P2-3)", () => {
  const c = tela();
  const [a, b] = c.clausulas;
  const cursor = { idClausula: a.id, inicio: 0, fim: 5, versaoTexto: versaoTexto(a.texto) };
  assert.deepEqual(destinoDoInserir(c, cursor, a.id), { tipo: "cursor", cursor });
  assert.equal(destinoDoInserir(c, cursor, null), null, "fora da edição (Concluir) a seleção antiga não vale");
  assert.equal(destinoDoInserir(c, cursor, b.id), null, "edição passou para outra cláusula");
  assert.equal(destinoDoInserir(c, null, a.id), null, "editando sem seleção");
  const mudou = alterarTexto(c, a.id, "texto", "Outro texto");
  assert.ok(mudou.ok);
  assert.equal(destinoDoInserir(mudou.conteudo, cursor, a.id), null, "texto mudou");
});
