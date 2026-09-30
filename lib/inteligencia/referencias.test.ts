import assert from "node:assert/strict";
import test from "node:test";
import { criarAmbiente, EMPRESA_A, IDS, PII, type OpcoesAmbiente } from "../../scripts/ia-benchmark/ambiente.ts";
import type { AIResponse, EntidadeRef, RespostaLeitura } from "./contratos.ts";
import { atenderConversa } from "./conversa.ts";
import { detectarReferencia, resolverReferencia, type Leitor } from "./referencias.ts";

/** AI V1.1 — PR 5: Conversation Focus + Reference Resolver (dica sem autoridade; tudo revalidado no Core). */
const HOJE = "2026-09-30"; // quarta
type Turno = { texto: string; contexto?: { tela: "festa" | "cliente" | "contrato"; entidade: keyof typeof IDS } };

async function conversa(turnos: Turno[], opcoes: OpcoesAmbiente = {}) {
  const amb = criarAmbiente(opcoes);
  const obs = await amb.conversar({ id: "ref-teste", categoria: "contexto", turnos, esperado: { entendimento: "EXECUTADO" }, pr: "PR5" });
  return { obs, ultima: obs.at(-1)!, amb };
}
const dados = (r: AIResponse | null) => (r as Extract<AIResponse, { tipo: "resposta" }>).dados as RespostaLeitura;
const mensagem = (r: AIResponse | null) => (r as { mensagem: string }).mensagem;

/** Pedido direto com um foco escolhido (para adulteração / outra empresa). */
async function comFoco(texto: string, foco: unknown) {
  const amb = criarAmbiente();
  const r = await atenderConversa({ lerCorpo: async () => ({ texto, foco }), empresaSolicitada: EMPRESA_A }, amb.deps);
  return { r, amb, data: (r.corpo as { data?: AIResponse }).data ?? null, rastro: amb.rastros.at(-1)! };
}

// ---------------------------------------------------------------- detecção

test("detecção: temporais, dêiticos, pronomes e nome — alvo separado da âncora", () => {
  assert.deepEqual(detectarReferencia("Resuma a próxima festa", HOJE)?.temporal?.seletor, "PROXIMA");
  assert.deepEqual(detectarReferencia("Como foi a última festa?", HOJE)?.temporal?.seletor, "ULTIMA");
  assert.equal(detectarReferencia("Resuma a festa de amanhã", HOJE)?.temporal?.dia, "2026-10-01");
  assert.equal(detectarReferencia("Resuma a festa de depois de amanhã", HOJE)?.temporal?.dia, "2026-10-02");
  assert.equal(detectarReferencia("Resuma a festa de sábado", HOJE)?.temporal?.dia, "2026-10-03");
  assert.equal(detectarReferencia("Resuma a festa de quarta", HOJE)?.temporal?.dia, "2026-09-30", "hoje é quarta");
  assert.equal(detectarReferencia("Resuma a festa de 12/10", HOJE)?.temporal?.dia, "2026-10-12");
  assert.equal(detectarReferencia("Quem é o cliente da próxima festa?", HOJE)?.alvo, "CLIENTE");
  assert.deepEqual(detectarReferencia("Quem é o cliente dela?", HOJE), { tipo: "PRONOME", alvo: "CLIENTE", genero: "F" });
  assert.deepEqual(detectarReferencia("Abra o contrato dessa festa", HOJE), { tipo: "DEITICO", alvo: "CONTRATO", deitico: "FESTA" });
  assert.deepEqual(detectarReferencia("Abra o cadastro da Ana Oliveira", HOJE), { tipo: "NOME", alvo: "CLIENTE", nome: "Ana Oliveira" });
  assert.equal(detectarReferencia("Quantos pacotes temos?", HOJE), null);
});

// ---------------------------------------------------------------- temporal

test("temporal: próxima, última, amanhã e dia da semana resolvem pela leitura do Core (proximas_festas)", async () => {
  for (const [texto, festa] of [["Resuma a próxima festa", "FESTA_MARIA"], ["Como foi a última festa?", "FESTA_JULIA"], ["Resuma a festa de amanhã", "FESTA_MARIA"], ["Resuma a festa de sábado", "FESTA_PEDRO"]] as const) {
    const { ultima } = await conversa([{ texto }]);
    assert.equal(ultima.resposta?.tipo, "resposta", texto);
    assert.equal(dados(ultima.resposta).entidades?.[0].id, IDS[festa], texto);
    assert.deepEqual(ultima.rastro?.referencias.map((r) => [r.tipo, r.origem, r.resultado]), [["TEMPORAL", "TEMPORAL", "RESOLVIDA"]], texto);
  }
});

test("temporal: zero resultados ⇒ resposta honesta (sem inventar); múltiplos/empate ⇒ opções, nunca escolhe", async () => {
  const { ultima } = await conversa([{ texto: "Resuma a festa de domingo" }]);
  assert.equal(ultima.resposta?.tipo, "nao_suportado");
  assert.match(mensagem(ultima.resposta), /^Não encontrei a festa de domingo \(04\/10\) registrada\.$/);
  assert.equal(ultima.rastro?.referencias[0].resultado, "NAO_ENCONTRADA");

  const festa = (id: string, rotulo: string): EntidadeRef => ({ tipo: "FESTA", id, rotulo, tela: "festa" });
  const dia: Leitor = async () => ({ capacidade: "proximas_festas", estado: "informativo", resumo: "", fatos: [], itens: [], evidencias: [], referencia: { hoje: HOJE, geradoEm: "", fontes: [] }, entidades: [festa(IDS.FESTA_MARIA, "Festa de Maria — 03/10/2026 às 16:00"), festa(IDS.FESTA_PEDRO, "Festa de João — 03/10/2026 às 18:00")] });
  const r = await resolverReferencia(detectarReferencia("Resuma a festa de sábado", HOJE)!, { contexto: null, foco: null, hoje: HOJE, ler: dia });
  assert.deepEqual([r.resultado, r.candidatos.length, r.entidade], ["AMBIGUA", 2, null]);
  const empate: Leitor = async () => ({ ...(await dia("", {})), entidades: [festa(IDS.FESTA_MARIA, "Festa de Maria — 03/10/2026 às 16:00"), festa(IDS.FESTA_PEDRO, "Festa de João — 03/10/2026 às 16:00")] });
  assert.equal((await resolverReferencia(detectarReferencia("Resuma a próxima festa", HOJE)!, { contexto: null, foco: null, hoje: HOJE, ler: empate })).resultado, "AMBIGUA", "mesma data e hora ⇒ ambíguo");
});

// ---------------------------------------------------------------- pronomes e relações do Core

test("'ela' após festa ⇒ FESTA→CLIENTE pela relação do Core; 'dele' após cliente ⇒ navegação; foco segue a conversa", async () => {
  const { obs } = await conversa([{ texto: "Qual é a próxima festa?" }, { texto: "Quem é o cliente dela?" }, { texto: "Abra o cadastro dele" }]);
  const [lista, cliente, abrir] = obs;
  assert.deepEqual(lista.resposta?.foco?.entidades.map((e) => e.tipo), ["FESTA"]);
  assert.equal(lista.resposta?.foco?.principal, 0);
  assert.equal(dados(cliente.resposta).entidades?.[0].id, IDS.CLIENTE_ANA);
  assert.deepEqual(cliente.rastro?.referencias.map((r) => [r.tipo, r.alvo, r.origem, r.resultado]), [["PRONOME", "CLIENTE", "RELACAO_CORE", "RESOLVIDA"]]);
  assert.deepEqual(cliente.resposta?.foco?.entidades.map((e) => e.tipo), ["CLIENTE", "FESTA"], "cliente principal + festa relacionada");
  assert.equal(abrir.resposta?.tipo, "navegacao");
  assert.equal((abrir.resposta as { destino: string }).destino, `/clientes/${IDS.CLIENTE_ANA}`);
});

test("relações: FESTA→CONTRATO ('abra o contrato dela') e CONTRATO→FESTA ('abra a festa dele')", async () => {
  const contrato = await conversa([{ texto: "Resuma a festa de sábado" }, { texto: "Abra o contrato dela" }]);
  assert.equal((contrato.ultima.resposta as { destino: string }).destino, `/admin/contratos?contratoId=${IDS.CONTRATO_PEDRO}`);
  const festa = await conversa([{ texto: "Resuma este contrato", contexto: { tela: "contrato", entidade: "CONTRATO_MARIA" } }, { texto: "Abra a festa dele" }]);
  assert.equal(festa.ultima.resposta?.tipo, "navegacao");
  assert.equal((festa.ultima.resposta as { destino: string }).destino, `/admin/festas/${IDS.FESTA_MARIA}`);
  assert.equal(festa.ultima.rastro?.referencias[0].origem, "RELACAO_CORE");
});

test("'essa festa' com a tela aberta usa a entidade da tela (prioridade 1)", async () => {
  const { ultima } = await conversa([{ texto: "Qual é a próxima festa?" }, { texto: "Abra o contrato dessa festa", contexto: { tela: "festa", entidade: "FESTA_PEDRO" } }]);
  assert.equal((ultima.resposta as { destino: string }).destino, `/admin/contratos?contratoId=${IDS.CONTRATO_PEDRO}`, "a tela vence o foco");
  assert.equal(ultima.rastro?.referencias[0].origem, "RELACAO_CORE");
});

test("ambiguidade: duas entidades compatíveis no foco sem principal ⇒ opções, não escolhe", async () => {
  const { data, rastro } = await comFoco("Quem é o cliente dela?", { entidades: [{ tipo: "FESTA", id: IDS.FESTA_MARIA }, { tipo: "FESTA", id: IDS.FESTA_PEDRO }] });
  assert.equal(data?.entendimento, "AMBIGUO");
  assert.match(mensagem(data), /^Encontrei 2 festas:\n1\. Festa de Ana Oliveira — 01\/10\/2026 às 14:00\n2\. Festa de Carla Souza — 03\/10\/2026 às 14:00\nQual delas\?$/);
  assert.deepEqual([rastro.referencias[0].resultado, rastro.referencias[0].candidatos], ["AMBIGUA", 2]);
  const lista = await conversa([{ texto: "Quais as próximas festas?" }, { texto: "Abra o contrato dessa festa" }]);
  assert.equal(lista.obs[0].resposta?.foco?.principal, null, "lista não tem principal");
  assert.equal(lista.ultima.resposta?.entendimento, "AMBIGUO");
});

// ---------------------------------------------------------------- foco: dica sem autoridade

test("foco adulterado é recusado pelo schema (rótulo, empresa, tipo desconhecido, id inválido, mais de 5)", async () => {
  const f = (entidades: unknown, extra: object = {}) => ({ entidades, ...extra });
  for (const foco of [
    f([{ tipo: "FESTA", id: IDS.FESTA_MARIA, rotulo: "qualquer" }]),
    f([{ tipo: "FESTA", id: IDS.FESTA_MARIA }], { empresaId: EMPRESA_A }),
    f([{ tipo: "EMPRESA", id: IDS.FESTA_MARIA }]),
    f([{ tipo: "FESTA", id: "../../x" }]),
    f(Array.from({ length: 6 }, () => ({ tipo: "FESTA", id: IDS.FESTA_MARIA }))),
    f([{ tipo: "FESTA", id: IDS.FESTA_MARIA }], { principal: 9 }),
  ]) {
    const { r } = await comFoco("Quem é o cliente dela?", foco);
    assert.equal(r.status, 400, JSON.stringify(foco));
  }
});

test("foco de outra empresa ou inexistente ⇒ NEGADA, descartado do foco; nada lido de fora do tenant", async () => {
  for (const id of [IDS.FESTA_B, "12121212-1212-4212-8212-121212121212"]) {
    const { data, rastro, amb } = await comFoco("Quem é o cliente dela?", { entidades: [{ tipo: "FESTA", id }], principal: 0 });
    assert.equal(data?.entendimento, "NEGADO_POLITICA", id);
    assert.equal(rastro.referencias[0].resultado, "NEGADA");
    assert.equal(data?.foco?.entidades.some((e) => e.id === id) ?? false, false, "descartado do foco devolvido");
    assert.deepEqual(amb.violacoes.crossTenant, []);
    assert.doesNotMatch(JSON.stringify(data), /ZZ-EMPRESA-B/);
  }
});

test("sem bypass de Policy: referência resolvida por leitura de nível agenda não abre resumo/navegação sem FESTA_CONSULTAR", async () => {
  for (const texto of ["Resuma a festa de sábado", "Abra a próxima festa"]) {
    const { ultima, amb } = await conversa([{ texto }], { semCapacidadeFesta: true });
    assert.equal(ultima.status, 403, texto);
    assert.equal(ultima.resposta, null);
    assert.deepEqual([amb.violacoes.mutacoes, amb.violacoes.operacoesExecutadas], [[], 0]);
  }
});

test("trace de referências: só códigos e contagens — nenhum nome, rótulo, CPF ou id", async () => {
  const { obs } = await conversa([{ texto: "Qual é a próxima festa?" }, { texto: "Quem é o cliente dela?" }, { texto: "Abra o cadastro dele" }]);
  for (const o of obs) {
    const referencias = JSON.stringify(o.rastro?.referencias);
    for (const proibido of [...PII, "Ana Oliveira", "Festa de", IDS.FESTA_MARIA, IDS.CLIENTE_ANA]) assert.equal(referencias.includes(proibido), false, proibido);
    const trace = JSON.stringify(o.rastro);
    for (const proibido of [...PII, "Ana Oliveira"]) assert.equal(trace.includes(proibido), false, proibido);
  }
});
