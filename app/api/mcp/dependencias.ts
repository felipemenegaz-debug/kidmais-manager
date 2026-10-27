import { decidirPaywall } from "@/lib/assinatura/paywall";
import { lerEstadoComercial } from "@/lib/assinatura/estado";
import { carregarCorpusAprovado } from "@/lib/conhecimento/carregar";
import type { DbExecutor } from "@/lib/db/contracts";
import { conexaoDescartavelDoPool } from "@/lib/db/postgres";
import { transacaoComPrazo, type AbrirConexao } from "@/lib/db/transacao-com-prazo";
import { CanalOcupado, Vagas } from "@/lib/integracoes/mcp/admissao";
import { agendaDoTenant } from "@/lib/festas/leitura-tenant";
import { contarRecebiveis, listarRecebiveis } from "@/lib/financeiro/servico";
import type { DependenciasFerramentasMcp } from "@/lib/integracoes/mcp/ferramentas";
import { LimitadorMcp } from "@/lib/integracoes/mcp/limites";
import { criarTransporteMcp } from "@/lib/integracoes/mcp/servidor";
import { buscaHttpsFixada } from "@/lib/integracoes/oauth/cimd";
import { LimitadorPublicoOAuth, type DependenciasRotasOAuth } from "@/lib/integracoes/oauth/rotas";
import { chaveDaOrigem, origemConfiavel } from "@/lib/http/origem-cliente";
import { concessaoVigentePostgres, criarRepositorioOAuthPostgres } from "@/lib/integracoes/oauth/postgres";
import type { RepositorioOAuth } from "@/lib/integracoes/oauth/repositorio";
import type { DependenciasConsentimento, DependenciasOAuth } from "@/lib/integracoes/oauth/servico";
import { executarNoTenant, type SessaoParaTenant, type TenantComprovado } from "@/lib/saas/provar-tenant";

/**
 * Composition root do canal MCP externo. Só serviços determinísticos: nenhum roteador de modelos, provedor, JEV,
 * planejador, copiloto ou conversa é importado aqui (teste estático em lib/integracoes/mcp/mcp-arquitetura.test.ts).
 * Persistência só PostgreSQL (105); sem schema, as rotas respondem indisponível.
 */
type GlobalMcp = typeof globalThis & { __kidmaisMcpLimitador?: LimitadorMcp; __kidmaisMcpLimitadorPublico?: LimitadorPublicoOAuth };

/**
 * Vagas de banco do CANAL INTEIRO por instância (rodada 4, achado 1): OAuth, verificação de token, ferramentas e consentimento
 * disputam no máximo VAGAS_BANCO_CANAL conexões do pool compartilhado (30). Sem vaga ⇒ CanalOcupado (503) sem pedir conexão.
 * A vaga só volta quando a obtenção da conexão TAMBÉM terminou: uma `pool.connect()` abandonada pelo prazo continua contando
 * até ser entregue (e descartada) ou falhar, então trabalho órfão nunca passa do teto.
 */
const VAGAS_BANCO_CANAL = new Vagas(12);
/** Reserva própria para a pessoa VER e DESCONECTAR as conexões: a revogação não disputa vaga com o tráfego externo. */
const VAGAS_BANCO_PESSOA = new Vagas(2);

/**
 * Transação do canal: vaga + prazo do lado da aplicação (conexão descartada ao vencer) + statement_timeout/lock_timeout no
 * servidor (rodada 3, achado 1). Nenhuma espera infinita por trava ou consulta segura o pedido nem a conexão.
 */
async function transacaoDoCanal<T>(prazoMs: number, statementMs: number, lockMs: number, work: (tx: DbExecutor) => Promise<T>, vagas: Vagas = VAGAS_BANCO_CANAL): Promise<T> {
  if (!vagas.iniciar()) throw new CanalOcupado();
  let obtencao: Promise<unknown> = Promise.resolve();
  const abrir: AbrirConexao = (registrar) => {
    const p = conexaoDescartavelDoPool(registrar);
    obtencao = p;
    return p;
  };
  try {
    return await transacaoComPrazo(abrir, prazoMs)(async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = '${statementMs}ms'`);
      await tx.query(`SET LOCAL lock_timeout = '${lockMs}ms'`);
      return work(tx);
    });
  } finally {
    obtencao.then(() => undefined, () => undefined).finally(() => vagas.terminar());
  }
}

const PRAZO_OAUTH_MS = 3000;
function transacaoOAuth<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return transacaoDoCanal(PRAZO_OAUTH_MS, 2500, 1000, work);
}
const executorOAuth: DbExecutor = {
  query: ((sql: string, valores?: readonly unknown[]) => transacaoOAuth((tx) => tx.query(sql, valores))) as DbExecutor["query"],
};

function repositorio(): RepositorioOAuth {
  return criarRepositorioOAuthPostgres(() => executorOAuth, transacaoOAuth);
}

function transacaoDaPessoa<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return transacaoDoCanal(PRAZO_OAUTH_MS, 2500, 1000, work, VAGAS_BANCO_PESSOA);
}
const executorDaPessoa: DbExecutor = {
  query: ((sql: string, valores?: readonly unknown[]) => transacaoDaPessoa((tx) => tx.query(sql, valores))) as DbExecutor["query"],
};

/** Repositório da tela da própria pessoa (listar e desconectar), com reserva de vagas separada do tráfego externo. */
export function repositorioDaPessoa(): RepositorioOAuth {
  return criarRepositorioOAuthPostgres(() => executorDaPessoa, transacaoDaPessoa);
}

/** Mesma decisão do paywall para leitura (GET): COMPLETO e SOMENTE_LEITURA leem; BLOQUEADO não. */
async function leituraComercialPermitida(tx: DbExecutor, empresaId: string) {
  const estado = await lerEstadoComercial(tx, empresaId);
  return decidirPaywall(estado.acesso, "GET", "/api/mcp").permitido;
}

export function dependenciasOAuth(): DependenciasOAuth {
  return { env: process.env, repo: repositorio(), buscarCimd: buscaHttpsFixada(), agora: () => new Date() };
}

/** Rodada 4, achado 5: o consentimento usa a transação de tenant COM prazo e vaga do canal (não a transação comum). */
export function dependenciasConsentimento(): DependenciasConsentimento {
  return { ...dependenciasOAuth(), withTenantTransaction: tenantComPrazo, leituraComercialPermitida };
}

/**
 * Revisão P2-6: transação das FERRAMENTAS com prazo real. transacaoComPrazo descarta a conexão (nunca volta ao pool) se o
 * prazo vencer em qualquer etapa (obter conexão, BEGIN, tenant, travas, leitura, COMMIT); no servidor, statement_timeout e
 * lock_timeout encerram a consulta e a espera por trava. Prazo total do pedido: LIMITES_MCP.prazoFerramentaMs (5 s).
 */
const PRAZO_TRANSACAO_FERRAMENTA_MS = 5000;
function tenantComPrazo<T>(sessao: SessaoParaTenant, empresa: string, work: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>): Promise<T> {
  return transacaoDoCanal(PRAZO_TRANSACAO_FERRAMENTA_MS, 4500, 2000, (tx) => executarNoTenant(tx, sessao, empresa, work));
}

function dependenciasFerramentas(repo: RepositorioOAuth): DependenciasFerramentasMcp {
  return {
    env: process.env,
    agora: () => new Date(),
    withTenantTransaction: tenantComPrazo,
    concessaoVigente: concessaoVigentePostgres,
    leituraComercialPermitida,
    agenda: (tx, empresaId, dia, limite) => agendaDoTenant(tx, empresaId, dia, dia, limite),
    contarRecebiveis: (tx, empresaId, teto) => contarRecebiveis(tx, empresaId, teto),
    recebiveis: (tx, empresaId, hoje) => listarRecebiveis(tx, empresaId, hoje),
    corpus: () => carregarCorpusAprovado(),
    registrar(evento) {
      repo.auditar({ evento: "FERRAMENTA", ...evento })
        .then(() => (evento.resultado === "OK" || evento.resultado === "SEM_DADOS" ? repo.marcarUso(evento.concessaoId, true) : undefined))
        .catch(() => console.error(`[Kidmais MCP] auditoria não gravada: ${evento.capacidade} ${evento.codigo}`));
    },
  };
}

export function transporteMcp() {
  const g = globalThis as GlobalMcp;
  const limitador = g.__kidmaisMcpLimitador ?? (g.__kidmaisMcpLimitador = new LimitadorMcp());
  const oauth = dependenciasOAuth();
  return criarTransporteMcp({ oauth, ferramentas: dependenciasFerramentas(oauth.repo), limitador, origem: origemDaBorda });
}

/** IP confiável da borda confirmada (nunca cabeçalho livre); null quando não comprovado. */
function origemDaBorda(request: Request) {
  const ip = origemConfiavel(request);
  return ip ? chaveDaOrigem(ip) : null;
}

/** Bordas públicas do OAuth: limitador em processo (singleton) e origem só pelo IP confiável da borda confirmada. */
export function dependenciasRotasOAuth(): DependenciasRotasOAuth {
  const g = globalThis as GlobalMcp;
  let limites = g.__kidmaisMcpLimitadorPublico;
  if (!limites) {
    const novo = new LimitadorPublicoOAuth();
    // A10: o agregado de recusas anônimas sai a cada minuto mesmo sem novo tráfego (unref: não segura o processo).
    setInterval(() => novo.descarregar(), 60_000).unref();
    limites = g.__kidmaisMcpLimitadorPublico = novo;
  }
  return {
    oauth: dependenciasOAuth(),
    limites,
    origem: origemDaBorda,
  };
}
