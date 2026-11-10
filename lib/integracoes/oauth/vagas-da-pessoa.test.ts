import assert from "node:assert/strict";
import test from "node:test";
import { carregarModulo } from "../../acessos/teste-carregador.ts";
import * as transacaoComPrazoReal from "../../db/transacao-com-prazo.ts";
import type { ConexaoDescartavel } from "../../db/transacao-com-prazo.ts";
import type { DbExecutor } from "../../db/contracts.ts";
import { identidadeOuNulo } from "./identidade-sessao.ts";

/**
 * 9º parecer, P2: leituras opcionais de identidade presas não podem impedir Desconectar. Usa a composição REAL
 * (app/api/mcp/dependencias.ts: Vagas, transacaoDoCanal, transacaoComPrazo e repositório PostgreSQL) com um pool falso:
 * consultas de identidade nunca respondem; a revogação responde na hora. Nenhum banco é usado.
 */
const SESSAO = { usuario_id: "00000000-0000-4000-8000-000000000001", nome: "Pessoa Sintética", papel: "ADMINISTRATIVO", empresa_ativa_id: null };
const CONCESSAO = "00000000-0000-4000-8000-0000000000c1";

type Dependencias = {
  transacaoDaIdentidade: <T>(w: (tx: DbExecutor) => Promise<T>) => Promise<T>;
  transacaoDaPessoa: <T>(w: (tx: DbExecutor) => Promise<T>) => Promise<T>;
  repositorioDaPessoa: () => { revogarConcessao: (id: string, motivo: string, usuario: string) => Promise<boolean> };
};

function composicao() {
  const revogacoes: string[] = [];
  const conexao = (): ConexaoDescartavel => ({
    query: (async (sql: string) => {
      const s = sql.trim();
      if (/^(BEGIN|SET|COMMIT|ROLLBACK)/i.test(s)) return { rows: [], rowCount: 0 };
      if (/^UPDATE mcp_oauth_concessoes/.test(s)) { revogacoes.push(s); return { rows: [{ "?column?": 1 }], rowCount: 1 }; }
      if (/^(UPDATE mcp_oauth_tokens|INSERT INTO mcp_auditoria)/.test(s)) return { rows: [], rowCount: 1 };
      // Qualquer outra consulta é a da identidade (contexto da sessão, e-mail): nunca responde.
      return new Promise(() => undefined);
    }) as ConexaoDescartavel["query"],
    liberar: () => undefined,
    descartar: () => undefined,
  });
  const vazio = {};
  const dubles: Record<string, unknown> = {
    "lib/db/postgres": { conexaoDescartavelDoPool: async (registrar?: (c: ConexaoDescartavel) => void) => { const c = conexao(); registrar?.(c); return c; } },
    "lib/assinatura/paywall": vazio, "lib/assinatura/estado": vazio, "lib/conhecimento/carregar": vazio,
    "lib/festas/leitura-tenant": vazio, "lib/financeiro/servico": vazio, "lib/integracoes/mcp/limites": { LimitadorMcp: class {} },
    "lib/integracoes/mcp/servidor": vazio, "lib/integracoes/oauth/cimd": vazio, "lib/integracoes/oauth/rotas": { LimitadorPublicoOAuth: class {} },
    // Módulo REAL (o carregador transpila com JSX e não aceita os genéricos dele): mesmo prazo e descarte da produção.
    "lib/db/transacao-com-prazo": transacaoComPrazoReal,
    "lib/http/origem-cliente": vazio, "lib/saas/provar-tenant": vazio,
  };
  const dep = carregarModulo("app/api/mcp/dependencias.ts", dubles) as unknown as Dependencias;
  return { dep, revogacoes };
}

test("duas leituras de identidade presas: Desconectar continua atendido", async () => {
  const { dep, revogacoes } = composicao();
  const presas = [identidadeOuNulo(dep.transacaoDaIdentidade, SESSAO), identidadeOuNulo(dep.transacaoDaIdentidade, SESSAO)];
  const ok = await dep.repositorioDaPessoa().revogarConcessao(CONCESSAO, "USUARIO", SESSAO.usuario_id);
  assert.equal(ok, true);
  assert.equal(revogacoes.length, 1);
  // A segunda identidade não achou vaga e saiu nula na hora; a primeira sai nula quando vence o prazo curto.
  assert.deepEqual(await Promise.all(presas), [null, null]);
});

test("identidade presa enquanto a pessoa lista e revoga: as duas vagas da pessoa seguem livres", async () => {
  const { dep } = composicao();
  const presa = identidadeOuNulo(dep.transacaoDaIdentidade, SESSAO);
  const [a, b] = await Promise.all([
    dep.repositorioDaPessoa().revogarConcessao(CONCESSAO, "USUARIO", SESSAO.usuario_id),
    dep.transacaoDaPessoa(async () => "lista"),
  ]);
  assert.deepEqual([a, b], [true, "lista"]);
  assert.equal(await presa, null);
});
