import assert from "node:assert/strict";
import test from "node:test";
import { criarAmbiente, IDS } from "../../scripts/ia-benchmark/ambiente.ts";
import type { AIResponse } from "./contratos.ts";
import { ferramentaRegistrada } from "./ferramentas.ts";
import { interpretarDeterministico } from "./intencao.ts";
import { manifestoLeitura } from "./registro-ferramentas.ts";
import { TELAS, TELAS_NAVEGACAO, destinoSeguro, montarDestino } from "./rotas-navegacao.ts";

/** AI V1.1 — PR 3: navegação interna segura (lista fechada, id só validado, sem Human Gate, sem escrita). */
const ID = "44444444-4444-4444-8444-000000000001";

test("rotas: toda tela da lista monta destino seguro; entidade exige UUID; lista recusa id", () => {
  for (const tela of TELAS) {
    const t = TELAS_NAVEGACAO[tela] as { entidade?: string };
    const destino = t.entidade ? montarDestino(tela, ID) : montarDestino(tela);
    assert.equal(destinoSeguro(destino), true, `${tela}: ${destino}`);
    if (t.entidade) {
      assert.throws(() => montarDestino(tela), /DESTINO_INVALIDO/, tela);
      for (const ruim of ["../../etc/passwd", "javascript:alert(1)", `${ID}/../x`, `${ID}?x=1`, "", "https://evil.example"]) assert.throws(() => montarDestino(tela, ruim), /DESTINO_INVALIDO/, `${tela} ${ruim}`);
    } else {
      assert.throws(() => montarDestino(tela, ID), /DESTINO_INVALIDO/, tela);
    }
  }
});

test("rotas: esquemas, host, path traversal, barra invertida e query fora do padrão são recusados", () => {
  for (const ruim of [
    "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "https://evil.example/admin/dashboard", "//evil.example",
    "/admin/../etc/passwd", "/admin/festas/../../x", "/admin\\dashboard", `/admin/contratos?contratoId=${ID}&empresaId=${ID}`, "/admin/festas/1", "/admin/usuarios",
    " /admin/dashboard", "/admin/dashboard ", "/admin/dashboard#x", "/admin/dashboard?x=1", 42, null, `/clientes/${ID}`.repeat(10),
  ]) assert.equal(destinoSeguro(ruim), false, String(ruim));
});

test("registro: navegação é READ no gateway (Policy + Tenant Context), domínio NAVEGACAO, entrada estrita sem autoridade", () => {
  for (const capacidade of ["abrir_tela", "abrir_festa"]) {
    const f = ferramentaRegistrada(capacidade)!;
    const m = manifestoLeitura(f)!;
    assert.deepEqual([m.classe, m.dominio, m.executor, m.idempotencia], ["READ", "NAVEGACAO", "GATEWAY", "LEITURA_SEM_EFEITO"], capacidade);
    for (const chave of ["empresaId", "tenantId", "estabelecimentoId", "unidadeId", "usuarioId", "destino", "url"]) {
      assert.equal(f.entrada.safeParse({ tela: "clientes", id: ID, [chave]: "x" }).success, false, `${capacidade} aceita ${chave}`);
    }
  }
  assert.equal(ferramentaRegistrada("abrir_tela")!.entrada.safeParse({ tela: "https://evil.example" }).success, false);
});

const intencao = (texto: string, contexto: Parameters<typeof interpretarDeterministico>[1] = null) => interpretarDeterministico(texto, contexto);

test("intenção: só comando explícito navega; consulta não navega; destino só da lista", () => {
  assert.deepEqual(intencao("Abra a tela de contas a receber"), { tipo: "leitura", capacidade: "abrir_tela", parametros: { tela: "contas_receber" }, origem: "INTENCAO_DETERMINISTICA" });
  assert.deepEqual(intencao("Vá para a agenda"), { tipo: "leitura", capacidade: "abrir_tela", parametros: { tela: "agenda" }, origem: "INTENCAO_DETERMINISTICA" });
  assert.deepEqual(intencao("Leve-me para a tela de pacotes"), { tipo: "leitura", capacidade: "abrir_tela", parametros: { tela: "pacotes" }, origem: "INTENCAO_DETERMINISTICA" });
  assert.deepEqual(intencao("vá para pagamentos"), { tipo: "leitura", capacidade: "abrir_tela", parametros: { tela: "contas_receber" }, origem: "INTENCAO_DETERMINISTICA" });
  assert.deepEqual(intencao("abra os contratos"), { tipo: "leitura", capacidade: "abrir_tela", parametros: { tela: "contratos" }, origem: "INTENCAO_DETERMINISTICA" });
  // Consulta continua consulta (sem navegar).
  for (const consulta of ["Quais pagamentos estão atrasados?", "Mostre as festas de amanhã", "Quanto temos a receber?", "Resuma este contrato"]) {
    const i = intencao(consulta);
    assert.ok(!(i.tipo === "leitura" && i.capacidade.startsWith("abrir_")), consulta);
  }
  // Nada de URL, esquema ou tela fora da lista vindo do texto.
  for (const texto of ["Abra https://evil.example", "vá para javascript:alert(1)", "abra /admin/usuarios", "abra o arquivo file:///etc/passwd"]) assert.equal(intencao(texto).tipo === "leitura", false, texto);
});

test("intenção: entidade só com o id da TELA aberta; sem ele não escolhe (ambíguo / referência não resolvida)", () => {
  const naTela = { tela: "cliente" as const, entidadeId: IDS.CLIENTE_ANA };
  assert.deepEqual(intencao("Abra o fechamento deste cliente", naTela), { tipo: "leitura", capacidade: "abrir_tela", parametros: { tela: "fechamento", id: IDS.CLIENTE_ANA }, origem: "INTENCAO_DETERMINISTICA" });
  assert.deepEqual(intencao("abra esta festa", { tela: "festa", entidadeId: IDS.FESTA_MARIA }), { tipo: "leitura", capacidade: "abrir_festa", parametros: { id: IDS.FESTA_MARIA }, origem: "INTENCAO_DETERMINISTICA" });
  assert.deepEqual(intencao("Abra o contrato"), { tipo: "navegacao_sem_destino", recurso: "CONTRATO", motivo: "AMBIGUO" });
  assert.deepEqual(intencao("abra o contrato da próxima festa"), { tipo: "navegacao_sem_destino", recurso: "CONTRATO", motivo: "REFERENCIA_NAO_RESOLVIDA" });
  // Id no TEXTO nunca é usado como destino (nem de outra empresa).
  assert.deepEqual(intencao(`abra o cliente ${IDS.CLIENTE_B}`), { tipo: "navegacao_sem_destino", recurso: "CLIENTE", motivo: "REFERENCIA_NAO_RESOLVIDA" });
  // Tela de outra entidade não serve de id ("este contrato" na tela de cliente).
  assert.deepEqual(intencao("abra este contrato", naTela), { tipo: "navegacao_sem_destino", recurso: "CONTRATO", motivo: "AMBIGUO" });
});

async function perguntar(texto: string, contexto?: { tela: "festa" | "cliente" | "contrato"; entidade: keyof typeof IDS }) {
  const amb = criarAmbiente();
  const [o] = await amb.conversar({ id: "nav-teste", categoria: "navegacao", turnos: [{ texto, ...(contexto ? { contexto } : {}) }], esperado: { entendimento: "EXECUTADO" }, pr: "V1" });
  return { ...o, amb };
}

test("conversa: comando explícito com destino único ⇒ resposta de navegação (sem Human Gate, sem escrita) e trace sem URL", async () => {
  const r = await perguntar("Abra a tela de contas a receber");
  const resposta = r.resposta as Extract<AIResponse, { tipo: "navegacao" }>;
  assert.equal(resposta.tipo, "navegacao");
  assert.equal(resposta.destino, "/admin/financeiro/contas-receber");
  assert.equal(resposta.entendimento, "EXECUTADO");
  assert.equal(resposta.objetivo, "ABRIR:FINANCEIRO");
  assert.deepEqual(r.rastro?.navegacao, { recurso: "FINANCEIRO", tela: "contas_receber", resultado: "NAVEGADO", motivo: null });
  assert.equal(r.rastro?.humanGate, null);
  assert.deepEqual(r.rastro?.ferramentasExecutadas, ["kidmais.navegacao.abrir"]);
  assert.equal(JSON.stringify(r.rastro).includes("/admin/financeiro"), false, "o trace guarda a tela, não a URL");
  assert.deepEqual([r.amb.violacoes.mutacoes, r.amb.violacoes.operacoesExecutadas], [[], 0]);
});

test("conversa: entidade da tela aberta é conferida no tenant; de outra empresa ⇒ negado (fail-closed), sem destino", async () => {
  const propria = await perguntar("Abra o fechamento deste cliente", { tela: "cliente", entidade: "CLIENTE_ANA" });
  assert.equal(propria.resposta?.tipo, "navegacao");
  assert.equal((propria.resposta as { destino: string }).destino, `/admin/clientes/${IDS.CLIENTE_ANA}/fechamento`);

  const outra = await perguntar("Abra o fechamento deste cliente", { tela: "cliente", entidade: "CLIENTE_B" });
  assert.equal(outra.status, 404);
  assert.equal(outra.resposta, null);
  assert.deepEqual(outra.rastro?.navegacao, { recurso: "FECHAMENTO", tela: "fechamento", resultado: "NEGADO", motivo: null });
  assert.equal(outra.rastro?.entendimento, "NEGADO_POLITICA");

  const festaB = await perguntar("abra esta festa", { tela: "festa", entidade: "FESTA_B" });
  assert.equal(festaB.status, 404);
  assert.equal(festaB.rastro?.navegacao?.resultado, "NEGADO");
});

test("conversa: sem destino único ⇒ não navega; diz o que entendeu e registra o motivo", async () => {
  const ambiguo = await perguntar("Abra o contrato");
  assert.equal(ambiguo.resposta?.tipo, "nao_suportado");
  assert.equal(ambiguo.resposta?.entendimento, "AMBIGUO");
  assert.match((ambiguo.resposta as { mensagem: string }).mensagem, /^Entendi que você quer abrir o contrato, mas não sei qual\./);
  assert.deepEqual(ambiguo.rastro?.navegacao, { recurso: "CONTRATO", tela: null, resultado: "AMBIGUO", motivo: "AMBIGUO" });

  // Referência que o resolver (PR 5) ainda não resolve: contrato citado por nome de pessoa.
  const referencia = await perguntar("abra o contrato da Ana");
  assert.equal(referencia.resposta?.entendimento, "CAPACIDADE_INDISPONIVEL");
  assert.equal(referencia.rastro?.navegacao?.resultado, "SEM_DESTINO");
});
