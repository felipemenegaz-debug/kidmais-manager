import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transacaoComPrazo, type ConexaoDescartavel } from "../../db/transacao-com-prazo.ts";
import type { DbExecutor } from "../../db/contracts.ts";
import { categoriaDaFalhaDeLeitura, conexoesDaPessoa } from "./conexoes.ts";
import { identidadeOuNulo } from "./identidade-sessao.ts";
import { criarRepositorioOAuthPostgres } from "./postgres.ts";
import type { RepositorioOAuth } from "./repositorio.ts";

const SESSAO = { usuario_id: "u1", nome: "Pessoa Sintética", papel: "ADMINISTRATIVO", empresa_ativa_id: null };

test("consulta da identidade que não responde: vence o prazo, descarta a conexão e devolve nulo", async () => {
  let descartada = false;
  const conexao: ConexaoDescartavel = {
    query: (async (sql: string) => {
      if (/^(BEGIN|SET)/i.test(sql.trim())) return { rows: [], rowCount: 0 };
      return new Promise(() => undefined);
    }) as ConexaoDescartavel["query"],
    liberar: () => undefined,
    descartar: () => { descartada = true; },
  };
  const inicio = Date.now();
  const r = await identidadeOuNulo(transacaoComPrazo(async (registrar) => { registrar(conexao); return conexao; }, 80), SESSAO);
  assert.equal(r, null);
  assert.equal(descartada, true, "cancelamento efetivo: a conexão presa não volta ao pool");
  assert.ok(Date.now() - inicio < 2000);
});

test("falha na leitura da identidade também devolve nulo", async () => {
  const aviso = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(await identidadeOuNulo(async () => { throw new Error("canal ocupado"); }, SESSAO), null);
  } finally {
    console.warn = aviso;
  }
});

test("identidade nula registra só a categoria: vaga ocupada e prazo vencido ficam distinguíveis, sem mensagem nem dado", async () => {
  const aviso = console.warn;
  const linhas: string[] = [];
  console.warn = (m: string) => { linhas.push(m); };
  try {
    const erro = (name: string) => Object.assign(new Error("SELECT email FROM usuarios_administrativos WHERE id = 'u1'"), { name });
    await identidadeOuNulo(async () => { throw erro("CanalOcupado"); }, SESSAO);
    await identidadeOuNulo(async () => { throw erro("PrazoDaTransacaoVencido"); }, SESSAO);
  } finally {
    console.warn = aviso;
  }
  assert.deepEqual(linhas, ["[Kidmais MCP] identidade indisponível: VAGA_OCUPADA", "[Kidmais MCP] identidade indisponível: PRAZO_DA_APLICACAO"]);
});

test("consulta de falhas sem resposta: vence o prazo, descarta a conexão e a lista sai sem depender dela", async () => {
  let descartada = false;
  const conexao: ConexaoDescartavel = {
    query: (async (sql: string) => {
      if (/^(BEGIN|SET)/i.test(sql.trim())) return { rows: [], rowCount: 0 };
      return new Promise(() => undefined);
    }) as ConexaoDescartavel["query"],
    liberar: () => undefined,
    descartar: () => { descartada = true; },
  };
  const tx = transacaoComPrazo(async (registrar) => { registrar(conexao); return conexao; }, 80);
  const executor = { query: ((sql: string, valores?: readonly unknown[]) => tx((t) => t.query(sql, valores))) as DbExecutor["query"] };
  const leitor = criarRepositorioOAuthPostgres(() => executor, tx);
  const lista = { lerUltimasFalhas: leitor.lerUltimasFalhas, async listarConcessoes() {
    return [{ id: "c1", clientId: "x", clienteNome: "X", empresaId: "e1", empresaNome: "E", escopos: [], criadaEm: "2026-11-05T16:00:00Z", ultimoUsoEm: null, ultimaFerramentaEm: null, revogadaEm: null, evidencias: { motivoRevogacao: null, credencialInvalida: false, codigoUsado: true, codigoPendente: false, tokenVigente: true } }];
  } } as unknown as RepositorioOAuth;
  const aviso = console.warn;
  console.warn = () => undefined;
  try {
    const inicio = Date.now();
    const tela = await conexoesDaPessoa({}, lista, "u1");
    assert.equal(tela.falhasDisponiveis, false);
    assert.equal(tela.conexoes.length, 1);
    assert.equal(descartada, true);
    assert.ok(Date.now() - inicio < 2000);
  } finally {
    console.warn = aviso;
  }
});

test("categoria do log é fechada: distingue prazos e nunca repassa mensagem, código ou nome desconhecidos", () => {
  const erro = (props: Record<string, unknown>) => Object.assign(new Error("SELECT segredo FROM x WHERE id = 'u1'"), props);
  assert.equal(categoriaDaFalhaDeLeitura(erro({ name: "PrazoDaTransacaoVencido" })), "PRAZO_DA_APLICACAO");
  assert.equal(categoriaDaFalhaDeLeitura(erro({ name: "CanalOcupado" })), "VAGA_OCUPADA");
  assert.equal(categoriaDaFalhaDeLeitura(erro({ name: "SchemaMcpAusente" })), "SCHEMA_AUSENTE");
  assert.equal(categoriaDaFalhaDeLeitura(erro({ code: "57014" })), "CONSULTA_CANCELADA");
  assert.equal(categoriaDaFalhaDeLeitura(erro({ code: "55P03" })), "TRAVA_INDISPONIVEL");
  for (const x of [erro({ code: "23505" }), erro({ name: "segredo" }), erro({}), "texto", null, undefined]) assert.equal(categoriaDaFalhaDeLeitura(x), "OUTRA");
});

test("a rota usa o leitor de falhas com prazo e vaga próprios", () => {
  const rota = readFileSync(new URL("../../../app/api/admin/mcp/conexoes/route.ts", import.meta.url), "utf8");
  assert.match(rota, /conexoesDaPessoa\(process\.env, repositorioDaPessoa\(\), sessao\.usuario_id, leitorDeFalhasDaPessoa\(\)\)/);
  const dep = readFileSync(new URL("../../../app/api/mcp/dependencias.ts", import.meta.url), "utf8");
  assert.match(dep, /transacaoDoCanal\(1500, 1200, 500, [^;]*VAGAS_BANCO_FALHAS\)/);
  assert.match(dep, /const VAGAS_BANCO_FALHAS = new Vagas\(1\)/);
});

test("a lista essencial não lê a auditoria", () => {
  const sql = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  const trecho = sql.slice(sql.indexOf("async listarConcessoes("), sql.indexOf("async lerUltimasFalhas("));
  assert.doesNotMatch(trecho, /FROM mcp_auditoria|JOIN mcp_auditoria/);
});

test("a rota lista primeiro e lê a identidade só pela transação com prazo e vaga próprias", () => {
  const rota = readFileSync(new URL("../../../app/api/admin/mcp/conexoes/route.ts", import.meta.url), "utf8");
  assert.match(rota, /identidadeOuNulo\(transacaoDaIdentidade, sessao\)/);
  assert.doesNotMatch(rota, /\bdb\(\)/);
  assert.ok(rota.indexOf("conexoesDaPessoa(process.env") < rota.indexOf("identidadeOuNulo(transacaoDaIdentidade"));
  const dep = readFileSync(new URL("../../../app/api/mcp/dependencias.ts", import.meta.url), "utf8");
  assert.match(dep, /const VAGAS_BANCO_IDENTIDADE = new Vagas\(1\)/);
  assert.match(dep, /transacaoDoCanal\(1500, 1200, 500, work, VAGAS_BANCO_IDENTIDADE\)/);
});

test("12º parecer, P2: a rota informa se a ajuda carrega, pelo mesmo leitor do corpus que a execução usa", () => {
  const rota = readFileSync(new URL("../../../app/api/admin/mcp/conexoes/route.ts", import.meta.url), "utf8");
  assert.ok(rota.includes("{ ...estado, ajudaDisponivel: ajudaDisponivel(), identidade:"));
  const dep = readFileSync(new URL("../../../app/api/mcp/dependencias.ts", import.meta.url), "utf8");
  assert.ok(dep.includes("return carregarCorpusAprovado() !== null;"));
  assert.ok(dep.includes("corpus: () => carregarCorpusAprovado(),"));
});

test("11º parecer, P2: a lista diz por conexão se a pergunta pronta passaria pelas portas de ambiente", async () => {
  const E1 = "00000000-0000-4000-8000-0000000000e1";
  const E2 = "00000000-0000-4000-8000-0000000000e2";
  const concessao = (id: string, empresaId: string) => ({ id, clientId: "x", clienteNome: "X", empresaId, empresaNome: "E", escopos: ["conhecimento:read"], criadaEm: "2026-11-05T16:00:00Z", ultimoUsoEm: null, ultimaFerramentaEm: null, revogadaEm: null, evidencias: { motivoRevogacao: null, credencialInvalida: false, codigoUsado: true, codigoPendente: false, tokenVigente: true } });
  const repo = { lerUltimasFalhas: async () => new Map(), listarConcessoes: async () => [concessao("c1", E1), concessao("c2", E2)] } as unknown as RepositorioOAuth;
  const base = { MCP_ENABLED: "true", MCP_TENANT_ALLOWLIST: E1 + "," + E2, MCP_PUBLIC_URL: "http://127.0.0.1:9/api/mcp", MCP_REF_SECRET: "r".repeat(40), INTELIGENCIA_ENABLED: "true", AI_READ_ENABLED: "true", NODE_ENV: "test" };
  const liberada = async (env: Record<string, string | undefined>) => (await conexoesDaPessoa(env, repo, "u1")).conexoes.map((c) => [c.empresaNoPiloto, c.consultaDaAjudaLiberada]);
  assert.deepEqual(await liberada(base), [[true, true], [true, true]]);
  assert.deepEqual(await liberada({ ...base, AI_READ_ENABLED: "false" }), [[true, false], [true, false]]);
  assert.deepEqual(await liberada({ ...base, MCP_TENANT_ALLOWLIST: E1 }), [[true, true], [false, false]]);
  assert.deepEqual(await liberada({ ...base, AI_TENANT_ALLOWLIST: E1 }), [[true, true], [true, false]]);
});
