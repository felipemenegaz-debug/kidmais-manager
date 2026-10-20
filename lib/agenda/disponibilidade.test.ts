import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG_VAZIA, regraDaEmpresa, regraPadraoPacote, statusDataPacote, statusLabel, type RegraPacoteEmpresa } from "./disponibilidade.ts";

test("Pocket permite sexta-feira somente das 11h às 15h", () => {
  assert.equal(regraPadraoPacote("pocket", "2026-09-18", "almoco"), "disponivel");
  assert.equal(regraPadraoPacote("pocket", "2026-09-18", "noite"), "indisponivel");
  assert.equal(regraPadraoPacote("pocket", "2026-09-19", "almoco"), "indisponivel");
});

test("Pizza Party permanece sob consulta", () => {
  assert.equal(regraPadraoPacote("pizza_party_scienza", "2026-09-18", "almoco"), "consulta");
});

// ---- Disponibilidade por empresa (/b/<código>): a configuração da própria empresa, nunca a regra fixa da Kidmais.

const SABADO = "2026-11-14"; // dia ISO 6
const QUARTA = "2026-11-18";
const SEXTA = "2026-11-13";
const DOMINGO = "2026-11-15"; // dia ISO 7 (getUTCDay 0)
const todosOsDias = (estado: RegraPacoteEmpresa["estado"] = "DISPONIVEL"): RegraPacoteEmpresa[] =>
  [1, 2, 3, 4, 5, 6, 7].flatMap((dia) => (["almoco", "noite"] as const).map((horario) => ({ dia, horario, estado, vigenciaInicio: "2026-01-01", vigenciaFim: null })));

test("caso encontrado: POCKET do Profissional configurado para todos os dias fica disponível no sábado", () => {
  const profissional = todosOsDias();
  assert.deepEqual(statusDataPacote(CONFIG_VAZIA, "pocket", SABADO, "almoco", profissional), { status: "disponivel", origem: "regra" });
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pocket", SABADO, "noite", profissional).status, "disponivel");
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pocket", SEXTA, "noite", profissional).status, "disponivel", "sexta à noite também, se a empresa liberou");
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pocket", DOMINGO, "almoco", profissional).status, "disponivel", "domingo = dia ISO 7");
  // O mesmo pedido no endereço atual da Kidmais continua com a regra legada.
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pocket", SABADO, "almoco").status, "indisponivel");
});

test("empresa: só o que ela configurou — dia/período sem regra é indisponível, com motivo do buffet (sem texto da Kidmais)", () => {
  const soQuartaAlmoco: RegraPacoteEmpresa[] = [{ dia: 3, horario: "almoco", estado: "DISPONIVEL", vigenciaInicio: "2026-01-01", vigenciaFim: null }];
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pocket", QUARTA, "almoco", soQuartaAlmoco).status, "disponivel");
  const noite = statusDataPacote(CONFIG_VAZIA, "pocket", QUARTA, "noite", soQuartaAlmoco);
  assert.equal(noite.status, "indisponivel");
  assert.match(noite.motivo ?? "", /configuração do buffet/);
  assert.doesNotMatch(noite.motivo ?? "", /Kidmais/);
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pocket", SABADO, "almoco", soQuartaAlmoco).status, "indisponivel");
  // Sem regra nenhuma (empresa ainda não configurou ou pacote que ela não oferece): nada disponível pela regra.
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pocket", QUARTA, "almoco", []).status, "indisponivel");
  // INDISPONIVEL e SOB_CONSULTA da empresa.
  assert.equal(regraDaEmpresa(todosOsDias("INDISPONIVEL"), QUARTA, "almoco"), "indisponivel");
  const consulta = statusDataPacote(CONFIG_VAZIA, "pocket", QUARTA, "almoco", todosOsDias("SOB_CONSULTA"));
  assert.equal(consulta.status, "consulta");
  assert.doesNotMatch(consulta.motivo ?? "", /Kidmais|Scienza/);
});

test("empresa: nenhuma regra fixa da Kidmais pelo código (Mini, Compacta, Pizza Party, tradicionais)", () => {
  const nada: RegraPacoteEmpresa[] = [];
  const tudo = todosOsDias();
  // Compacta sábado à noite: Kidmais recusa; empresa que liberou = disponível, sem o motivo da Festa Compacta.
  assert.equal(statusDataPacote(CONFIG_VAZIA, "compacta", SABADO, "noite").status, "indisponivel");
  const compacta = statusDataPacote(CONFIG_VAZIA, "compacta", SABADO, "noite", tudo);
  assert.deepEqual(compacta, { status: "disponivel", origem: "regra" });
  // Mini sexta à noite.
  assert.equal(statusDataPacote(CONFIG_VAZIA, "mini", SEXTA, "noite").status, "indisponivel");
  assert.equal(statusDataPacote(CONFIG_VAZIA, "mini", SEXTA, "noite", tudo).status, "disponivel");
  // Pizza Party: na Kidmais é sempre consulta (Scienza); na empresa vale o que ela configurou.
  assert.equal(statusDataPacote(CONFIG_VAZIA, "pizza_party_scienza", QUARTA, "almoco", tudo).status, "disponivel");
  // Tradicionais: na Kidmais sempre disponíveis; na empresa, sem regra configurada, não.
  assert.equal(statusDataPacote(CONFIG_VAZIA, "completa", QUARTA, "almoco").status, "disponivel");
  assert.equal(statusDataPacote(CONFIG_VAZIA, "completa", QUARTA, "almoco", nada).status, "indisponivel");
});

test("empresa: vigência escolhida como no servidor (maior início vigente na data; expirada e futura ignoradas)", () => {
  const regras: RegraPacoteEmpresa[] = [
    { dia: 6, horario: "almoco", estado: "DISPONIVEL", vigenciaInicio: "2026-01-01", vigenciaFim: null },
    { dia: 6, horario: "almoco", estado: "INDISPONIVEL", vigenciaInicio: "2026-11-01", vigenciaFim: "2026-11-30" },
    { dia: 6, horario: "almoco", estado: "SOB_CONSULTA", vigenciaInicio: "2027-01-01", vigenciaFim: null },
  ];
  assert.equal(regraDaEmpresa(regras, "2026-10-31", "almoco"), "disponivel");
  assert.equal(regraDaEmpresa(regras, SABADO, "almoco"), "indisponivel", "a regra mais recente vigente prevalece");
  assert.equal(regraDaEmpresa(regras, "2026-12-05", "almoco"), "disponivel", "expirada volta à anterior");
  assert.equal(regraDaEmpresa(regras, "2027-01-02", "almoco"), "consulta", "futura só a partir do início");
});

test("agenda e decisões por data continuam acima da regra da empresa", () => {
  const ocupada = { ...CONFIG_VAZIA, agenda: [{ data: SABADO, horario: "almoco" as const, status: "ocupado" as const }] };
  assert.equal(statusDataPacote(ocupada, "pocket", SABADO, "almoco", todosOsDias()).status, "indisponivel");
});

test("regressão do legado (endereço atual da Kidmais): mesmas respostas de antes, com e sem null", () => {
  const casos: Array<[Parameters<typeof regraPadraoPacote>[0], string, "almoco" | "noite", string]> = [
    ["pocket", "2026-11-16", "almoco", "disponivel"], ["pocket", "2026-11-19", "noite", "disponivel"],
    ["pocket", SEXTA, "almoco", "disponivel"], ["pocket", SEXTA, "noite", "indisponivel"],
    ["pocket", SABADO, "almoco", "indisponivel"], ["pocket", DOMINGO, "noite", "indisponivel"],
    ["mini", QUARTA, "noite", "disponivel"], ["mini", SEXTA, "noite", "indisponivel"], ["mini", SABADO, "almoco", "indisponivel"],
    ["compacta", SABADO, "almoco", "disponivel"], ["compacta", SABADO, "noite", "indisponivel"], ["compacta", DOMINGO, "noite", "disponivel"],
    ["essencial", SABADO, "noite", "disponivel"], ["completa", DOMINGO, "almoco", "disponivel"], ["premium", SEXTA, "noite", "disponivel"],
    ["pizza_party_scienza", QUARTA, "almoco", "consulta"],
  ];
  for (const [pacote, data, horario, esperado] of casos) {
    assert.equal(statusDataPacote(CONFIG_VAZIA, pacote, data, horario).status, esperado, `${pacote} ${data} ${horario}`);
    assert.deepEqual(statusDataPacote(CONFIG_VAZIA, pacote, data, horario, null), statusDataPacote(CONFIG_VAZIA, pacote, data, horario));
    assert.equal(regraPadraoPacote(pacote, data, horario), esperado);
  }
  assert.match(statusDataPacote(CONFIG_VAZIA, "compacta", SABADO, "noite").motivo ?? "", /Festa Compacta/);
  assert.match(statusDataPacote(CONFIG_VAZIA, "pizza_party_scienza", QUARTA, "almoco").motivo ?? "", /Kidmais\/Scienza/);
});

test("rótulo de consulta: Kidmais no endereço atual; o buffet em /b/<código>", () => {
  assert.equal(statusLabel("consulta"), "Consultar Kidmais");
  assert.equal(statusLabel("consulta", false), "Consultar o buffet");
  assert.equal(statusLabel("disponivel", false), "Disponível");
});
