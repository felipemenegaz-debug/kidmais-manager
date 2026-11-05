import type { DbExecutor } from "../../db/contracts.ts";
import { escopoValido, type EscopoMcp } from "../mcp/config.ts";
import type { PrincipalMcp } from "../mcp/ferramentas.ts";
import {
  RETENCAO_OAUTH,
  type AcessoVerificado, type AtualizacaoGuardada, type ClienteOAuth, type CodigoGuardado, type ConcessaoResumo, type EventoSeguranca, type NovaConcessao,
  type PedidoAutorizacao, type RepositorioOAuth, type ResultadoExpurgo,
} from "./repositorio.ts";

/**
 * RepositorioOAuth sobre PostgreSQL (migration 105). Única implementação operacional.
 * - Expiração comparada com clock_timestamp() do banco (mesmo relógio para todas as instâncias).
 * - Consumo de pedido/código e giro de refresh por UPDATE ... WHERE <ainda válido> RETURNING (um só vencedor).
 * - Schema ausente (42P01/42703) ⇒ SchemaMcpAusente: a rota responde indisponível; nunca cria DDL em request.
 * - ORDEM ÚNICA DE TRAVAS (rodada 3, achado 2): cliente → concessão → tokens/códigos. Toda transação que mexe em concessão
 *   e em tokens trava a CONCESSÃO primeiro; comandos que só tocam tokens são de uma instrução (sem segunda trava depois).
 * - Expurgo nunca espera linha travada (FOR UPDATE … SKIP LOCKED) e cada lote é uma transação curta.
 * - Prazos: a composição (app/api/mcp/dependencias.ts) dá a TODA transação/consulta deste repositório prazo do lado da
 *   aplicação (conexão descartada) e statement_timeout/lock_timeout no servidor.
 */
export class SchemaMcpAusente extends Error {
  constructor() {
    super("Persistência do canal MCP não instalada (migration 105).");
    this.name = "SchemaMcpAusente";
  }
}

type Transacao = <T>(work: (tx: DbExecutor) => Promise<T>) => Promise<T>;

function escopos(valor: unknown): EscopoMcp[] {
  return Array.isArray(valor) ? valor.filter((v): v is EscopoMcp => typeof v === "string" && escopoValido(v)) : [];
}

async function protegido<T>(trabalho: () => Promise<T>): Promise<T> {
  try {
    return await trabalho();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : null;
    if (code === "42P01" || code === "42703" || code === "42883") throw new SchemaMcpAusente();
    throw error;
  }
}

const ATIVA = `c.revogada_em IS NULL AND u.ativo AND u.senha_alterada_em <= c.criada_em`;

export function criarRepositorioOAuthPostgres(executor: () => DbExecutor, transacao: Transacao): RepositorioOAuth {
  const q = <R extends object>(sql: string, valores: readonly unknown[] = []) => protegido(() => executor().query<R>(sql, valores));
  return {
    async clienteEmCache(clientId) {
      const r = await q<{ nome: string; redirect_uris: string[]; valido_ate: Date }>(
        `SELECT nome, redirect_uris, valido_ate FROM mcp_oauth_clientes WHERE client_id = $1`, [clientId]);
      const l = r.rows[0];
      return l ? { clientId, nome: l.nome, redirectUris: l.redirect_uris, validoAte: new Date(l.valido_ate) } : null;
    },
    async guardarCliente(c: ClienteOAuth) {
      await q(`INSERT INTO mcp_oauth_clientes (client_id, nome, redirect_uris, valido_ate) VALUES ($1, $2, $3::text[], $4)
               ON CONFLICT (client_id) DO UPDATE SET nome = EXCLUDED.nome, redirect_uris = EXCLUDED.redirect_uris,
               valido_ate = EXCLUDED.valido_ate, atualizado_em = clock_timestamp()`, [c.clientId, c.nome, c.redirectUris, c.validoAte]);
    },
    async criarPedidoNoTeto(chaveHash, p: PedidoAutorizacao, teto) {
      return protegido(() => transacao(async (tx) => {
        // Admissão serializada POR CLIENTE (rodada 2, achado 2): FOR NO KEY UPDATE na linha do cliente segura as admissões
        // concorrentes de qualquer conexão/instância até o COMMIT, sem bloquear as checagens de FK (KEY SHARE) das outras tabelas.
        const cliente = await tx.query(`SELECT 1 FROM mcp_oauth_clientes WHERE client_id = $1 FOR NO KEY UPDATE`, [p.clientId]);
        if ((cliente.rowCount ?? 0) !== 1) throw new Error("cliente OAuth não registrado");
        const n = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT 1 FROM mcp_oauth_pedidos
          WHERE client_id = $1 AND consumido_em IS NULL AND expira_em > clock_timestamp() LIMIT $2) s`, [p.clientId, teto]);
        if ((n.rows[0]?.n ?? 0) >= teto) return false;
        await tx.query(`INSERT INTO mcp_oauth_pedidos (chave_hash, client_id, cliente_nome, redirect_uri, state, code_challenge, escopos, recurso, expira_em)
                         VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9)`,
        [chaveHash, p.clientId, p.clienteNome, p.redirectUri, p.state, p.codeChallenge, p.escopos, p.recurso, p.expiraEm]);
        return true;
      }));
    },
    async lerPedido(chaveHash) {
      const r = await q<LinhaPedido>(`SELECT ${COLUNAS_PEDIDO} FROM mcp_oauth_pedidos WHERE chave_hash = $1 AND consumido_em IS NULL AND expira_em > clock_timestamp()`, [chaveHash]);
      return r.rows[0] ? pedido(r.rows[0]) : null;
    },
    async consumirPedido(chaveHash) {
      const r = await q<LinhaPedido>(`UPDATE mcp_oauth_pedidos SET consumido_em = clock_timestamp()
                                       WHERE chave_hash = $1 AND consumido_em IS NULL AND expira_em > clock_timestamp()
                                       RETURNING ${COLUNAS_PEDIDO}`, [chaveHash]);
      return r.rows[0] ? pedido(r.rows[0]) : null;
    },
    async criarConcessaoComCodigo(c: NovaConcessao, codigoHash, expiraEm, codeChallenge) {
      return protegido(() => transacao(async (tx) => {
        // Concessão ANTES dos tokens (mesma ordem de salvarTokens/revogarConcessao): sem ciclo de espera.
        await tx.query(`SELECT id FROM mcp_oauth_concessoes WHERE revogada_em IS NULL AND usuario_id = $1 AND empresa_id = $2 AND client_id = $3
                         ORDER BY id FOR NO KEY UPDATE`, [c.usuarioId, c.empresaId, c.clientId]);
        await tx.query(`UPDATE mcp_oauth_tokens t SET revogado_em = clock_timestamp() FROM mcp_oauth_concessoes c
                         WHERE t.concessao_id = c.id AND t.revogado_em IS NULL AND c.revogada_em IS NULL
                           AND c.usuario_id = $1 AND c.empresa_id = $2 AND c.client_id = $3`, [c.usuarioId, c.empresaId, c.clientId]);
        await tx.query(`UPDATE mcp_oauth_concessoes SET revogada_em = clock_timestamp(), motivo_revogacao = 'SUBSTITUIDA'
                         WHERE revogada_em IS NULL AND usuario_id = $1 AND empresa_id = $2 AND client_id = $3`, [c.usuarioId, c.empresaId, c.clientId]);
        const nova = await tx.query<{ id: string }>(
          `INSERT INTO mcp_oauth_concessoes (usuario_id, empresa_id, client_id, cliente_nome, redirect_uri, escopos, recurso)
           VALUES ($1, $2, $3, $4, $5, $6::text[], $7) RETURNING id::text`,
          [c.usuarioId, c.empresaId, c.clientId, c.clienteNome, c.redirectUri, c.escopos, c.recurso]);
        const id = nova.rows[0].id;
        await tx.query(`INSERT INTO mcp_oauth_codigos (codigo_hash, concessao_id, redirect_uri, code_challenge, expira_em) VALUES ($1, $2, $3, $4, $5)`,
          [codigoHash, id, c.redirectUri, codeChallenge, expiraEm]);
        return id;
      }));
    },
    async lerCodigo(codigoHash): Promise<CodigoGuardado | null> {
      const r = await q<{ concessao_id: string; usuario_id: string; empresa_id: string; client_id: string; redirect_uri: string; code_challenge: string; escopos: string[]; expira_em: Date; usado: boolean }>(
        `SELECT k.concessao_id::text, c.usuario_id::text, c.empresa_id::text, c.client_id, k.redirect_uri, k.code_challenge, c.escopos,
                k.expira_em, (k.usado_em IS NOT NULL) AS usado
           FROM mcp_oauth_codigos k JOIN mcp_oauth_concessoes c ON c.id = k.concessao_id
           JOIN usuarios_administrativos u ON u.id = c.usuario_id
          WHERE k.codigo_hash = $1 AND (k.usado_em IS NOT NULL OR (${ATIVA}))`, [codigoHash]);
      const l = r.rows[0];
      return l ? {
        concessaoId: l.concessao_id, usuarioId: l.usuario_id, empresaId: l.empresa_id, clientId: l.client_id, redirectUri: l.redirect_uri,
        codeChallenge: l.code_challenge, escopos: escopos(l.escopos), expiraEm: new Date(l.expira_em), usado: l.usado,
      } : null;
    },
    async consumirCodigo(codigoHash) {
      const r = await q(`UPDATE mcp_oauth_codigos SET usado_em = clock_timestamp()
                          WHERE codigo_hash = $1 AND usado_em IS NULL AND expira_em > clock_timestamp() RETURNING 1`, [codigoHash]);
      return (r.rowCount ?? 0) === 1;
    },
    async salvarTokens(concessaoId, escoposToken, acesso, atualizacao) {
      await protegido(() => transacao(async (tx) => {
        // Só grava se a concessão continua ativa (revogação concorrente vence) e o escopo cabe nela (nunca amplia).
        // FOR NO KEY UPDATE serializa as emissões da MESMA concessão: o teto duro abaixo é exato entre conexões.
        const ok = await tx.query(`SELECT 1 FROM mcp_oauth_concessoes WHERE id = $1 AND revogada_em IS NULL AND $2::text[] <@ escopos FOR NO KEY UPDATE`, [concessaoId, escoposToken]);
        if ((ok.rowCount ?? 0) !== 1 || escoposToken.length === 0) throw Object.assign(new Error("concessão revogada ou escopo inválido"), { name: "invalid_grant", code: 400 });
        const recentes = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_oauth_tokens
          WHERE concessao_id = $1 AND tipo = 'ACESSO' AND criado_em > clock_timestamp() - interval '1 hour'`, [concessaoId]);
        if ((recentes.rows[0]?.n ?? 0) >= RETENCAO_OAUTH.emissoesPorHoraTeto) throw Object.assign(new Error("teto de emissões da concessão"), { name: "temporarily_unavailable", code: 429 });
        await tx.query(`INSERT INTO mcp_oauth_tokens (concessao_id, tipo, token_hash, escopos, expira_em) VALUES ($1, 'ACESSO', $2, $3::text[], $4)`, [concessaoId, acesso.hash, escoposToken, acesso.expiraEm]);
        if (atualizacao) await tx.query(`INSERT INTO mcp_oauth_tokens (concessao_id, tipo, token_hash, escopos, expira_em) VALUES ($1, 'ATUALIZACAO', $2, $3::text[], $4)`, [concessaoId, atualizacao.hash, escoposToken, atualizacao.expiraEm]);
        // Armazenamento limitado NA GRAVAÇÃO (rodada 2, achado 3): só os últimos N refresh girados (evidência de reuso);
        // acessos vencidos fora da janela de contagem e refresh vencidos nunca girados saem na mesma transação.
        await tx.query(`DELETE FROM mcp_oauth_tokens WHERE id IN (SELECT id FROM mcp_oauth_tokens
          WHERE concessao_id = $1 AND tipo = 'ATUALIZACAO' AND revogado_em IS NOT NULL ORDER BY revogado_em DESC, criado_em DESC, id DESC OFFSET $2)`, [concessaoId, RETENCAO_OAUTH.refreshGiradosGuardados]);
        await tx.query(`DELETE FROM mcp_oauth_tokens WHERE concessao_id = $1 AND (
          (tipo = 'ACESSO' AND expira_em < clock_timestamp() AND criado_em < clock_timestamp() - interval '1 hour')
          OR (tipo = 'ATUALIZACAO' AND revogado_em IS NULL AND expira_em < clock_timestamp()))`, [concessaoId]);
      }));
    },
    async lerAtualizacao(hash): Promise<AtualizacaoGuardada | null> {
      const r = await q<{ id: string; concessao_id: string; usuario_id: string; empresa_id: string; client_id: string; escopos: string[]; expira_em: Date; revogado: boolean }>(
        `SELECT t.id::text, c.id::text AS concessao_id, c.usuario_id::text, c.empresa_id::text, c.client_id, t.escopos, t.expira_em,
                (t.revogado_em IS NOT NULL) AS revogado
           FROM mcp_oauth_tokens t JOIN mcp_oauth_concessoes c ON c.id = t.concessao_id JOIN usuarios_administrativos u ON u.id = c.usuario_id
          WHERE t.token_hash = $1 AND t.tipo = 'ATUALIZACAO' AND (t.revogado_em IS NOT NULL OR t.expira_em > clock_timestamp()) AND ${ATIVA}`, [hash]);
      const l = r.rows[0];
      return l ? { tokenId: l.id, concessaoId: l.concessao_id, usuarioId: l.usuario_id, empresaId: l.empresa_id, clientId: l.client_id, escopos: escopos(l.escopos), expiraEm: new Date(l.expira_em), revogado: l.revogado } : null;
    },
    async emissoesRecentes(concessaoId) {
      const r = await q<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT 1 FROM mcp_oauth_tokens
        WHERE concessao_id = $1 AND tipo = 'ACESSO' AND criado_em > clock_timestamp() - interval '1 hour' LIMIT $2) s`, [concessaoId, RETENCAO_OAUTH.emissoesPorHoraTeto]);
      return r.rows[0]?.n ?? 0;
    },
    async revogarAtualizacao(tokenId) {
      const r = await q(`UPDATE mcp_oauth_tokens SET revogado_em = clock_timestamp()
                          WHERE id = $1 AND tipo = 'ATUALIZACAO' AND revogado_em IS NULL AND expira_em > clock_timestamp() RETURNING 1`, [tokenId]);
      return (r.rowCount ?? 0) === 1;
    },
    async revogarConcessao(concessaoId, motivo, porUsuarioId) {
      return protegido(() => transacao(async (tx) => {
        const r = await tx.query(`UPDATE mcp_oauth_concessoes SET revogada_em = clock_timestamp(), motivo_revogacao = $2, revogada_por = $3
                                   WHERE id = $1 AND revogada_em IS NULL AND ($3::uuid IS NULL OR usuario_id = $3::uuid) RETURNING 1`,
        [concessaoId, motivo, porUsuarioId]);
        if ((r.rowCount ?? 0) !== 1) return false;
        await tx.query(`UPDATE mcp_oauth_tokens SET revogado_em = clock_timestamp() WHERE concessao_id = $1 AND revogado_em IS NULL`, [concessaoId]);
        await tx.query(`INSERT INTO mcp_auditoria (evento, resultado, codigo, concessao_id, usuario_id) VALUES ('REVOGACAO', 'OK', $1, $2, $3)`,
          [motivo, concessaoId, porUsuarioId]);
        return true;
      }));
    },
    async verificarAcesso(hash): Promise<AcessoVerificado | null> {
      const r = await q<{ concessao_id: string; usuario_id: string; empresa_id: string; client_id: string; escopos: string[]; papel: string; recurso: string; expira_em: Date }>(
        `SELECT c.id::text AS concessao_id, c.usuario_id::text, c.empresa_id::text, c.client_id, t.escopos, u.papel, c.recurso, t.expira_em
           FROM mcp_oauth_tokens t JOIN mcp_oauth_concessoes c ON c.id = t.concessao_id JOIN usuarios_administrativos u ON u.id = c.usuario_id
          WHERE t.token_hash = $1 AND t.tipo = 'ACESSO' AND t.revogado_em IS NULL AND t.expira_em > clock_timestamp() AND ${ATIVA}`, [hash]);
      const l = r.rows[0];
      if (!l) return null;
      const principal: PrincipalMcp = { concessaoId: l.concessao_id, usuarioId: l.usuario_id, empresaId: l.empresa_id, clientId: l.client_id, escopos: escopos(l.escopos), papel: l.papel };
      return { ...principal, recurso: l.recurso, expiraEm: new Date(l.expira_em) };
    },
    async listarConcessoes(usuarioId): Promise<readonly ConcessaoResumo[]> {
      const r = await q<{ id: string; client_id: string; cliente_nome: string; empresa_id: string; empresa_nome: string; escopos: string[]; criada_em: string; ultimo_uso_em: string | null; ultima_ferramenta_em: string | null; revogada_em: string | null }>(
        `SELECT c.id::text, c.client_id, c.cliente_nome, c.empresa_id::text, e.nome AS empresa_nome, c.escopos, c.criada_em::text, c.ultimo_uso_em::text,
                c.ultima_ferramenta_em::text, c.revogada_em::text
           FROM mcp_oauth_concessoes c JOIN empresas e ON e.id = c.empresa_id
          WHERE c.usuario_id = $1 ORDER BY (c.revogada_em IS NULL) DESC, c.criada_em DESC LIMIT 50`, [usuarioId]);
      return r.rows.map((l) => ({
        id: l.id, clientId: l.client_id, clienteNome: l.cliente_nome, empresaId: l.empresa_id, empresaNome: l.empresa_nome, escopos: escopos(l.escopos), criadaEm: l.criada_em,
        ultimoUsoEm: l.ultimo_uso_em, ultimaFerramentaEm: l.ultima_ferramenta_em, revogadaEm: l.revogada_em,
      }));
    },
    async marcarUso(concessaoId, ferramenta) {
      await q(`UPDATE mcp_oauth_concessoes SET ultimo_uso_em = clock_timestamp(),
                 ultima_ferramenta_em = CASE WHEN $2 THEN clock_timestamp() ELSE ultima_ferramenta_em END
               WHERE id = $1 AND revogada_em IS NULL`, [concessaoId, ferramenta]);
    },
    async expurgarExpirados(): Promise<ResultadoExpurgo> {
      const R = RETENCAO_OAUTH;
      const inicio = Date.now();
      const total: ResultadoExpurgo = { pedidos: 0, codigos: 0, tokens: 0, concessoes: 0, auditoria: 0, lotes: 0, completo: false };
      // Drena em lotes curtos (DELETE por ctid) até esgotar ou atingir o orçamento. Ordem respeita as FKs (códigos e tokens
      // antes da concessão). Evidência de reuso de concessão ATIVA fica: código usado e refresh girados guardados.
      const etapas: ReadonlyArray<readonly [Exclude<keyof ResultadoExpurgo, "lotes" | "completo">, string]> = [
        ["pedidos", `DELETE FROM mcp_oauth_pedidos WHERE ctid IN (SELECT ctid FROM mcp_oauth_pedidos
          WHERE expira_em < clock_timestamp() - interval '1 hour' OR consumido_em < clock_timestamp() - interval '1 hour' LIMIT ${R.loteExpurgo} FOR UPDATE SKIP LOCKED)`],
        ["codigos", `DELETE FROM mcp_oauth_codigos WHERE ctid IN (SELECT k.ctid FROM mcp_oauth_codigos k JOIN mcp_oauth_concessoes c ON c.id = k.concessao_id
          WHERE (k.usado_em IS NULL AND k.expira_em < clock_timestamp() - interval '1 hour')
             OR c.revogada_em < clock_timestamp() - interval '1 day' LIMIT ${R.loteExpurgo} FOR UPDATE OF k SKIP LOCKED)`],
        ["tokens", `DELETE FROM mcp_oauth_tokens WHERE ctid IN (SELECT t.ctid FROM mcp_oauth_tokens t JOIN mcp_oauth_concessoes c ON c.id = t.concessao_id
          WHERE (t.tipo = 'ACESSO' AND t.expira_em < clock_timestamp() - interval '1 hour')
             OR (t.tipo = 'ATUALIZACAO' AND t.revogado_em IS NULL AND t.expira_em < clock_timestamp())
             OR c.revogada_em < clock_timestamp() - interval '1 day' LIMIT ${R.loteExpurgo} FOR UPDATE OF t SKIP LOCKED)`],
        ["concessoes", `DELETE FROM mcp_oauth_concessoes WHERE ctid IN (SELECT c.ctid FROM mcp_oauth_concessoes c
          WHERE c.revogada_em < clock_timestamp() - interval '${R.concessaoRevogadaDias} days'
            AND NOT EXISTS (SELECT 1 FROM mcp_oauth_codigos k WHERE k.concessao_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM mcp_oauth_tokens t WHERE t.concessao_id = c.id) LIMIT ${R.loteExpurgo} FOR UPDATE OF c SKIP LOCKED)`],
        ["auditoria", `DELETE FROM mcp_auditoria WHERE ctid IN (SELECT ctid FROM mcp_auditoria
          WHERE ocorrido_em < clock_timestamp() - interval '${R.auditoriaDias} days' LIMIT ${R.loteExpurgo} FOR UPDATE SKIP LOCKED)`],
      ];
      for (const [nome, sql] of etapas) {
        for (;;) {
          if (total.lotes >= R.lotesPorExpurgo || Date.now() - inicio > R.orcamentoExpurgoMs) return total;
          const n = (await q(sql)).rowCount ?? 0;
          total.lotes += 1;
          total[nome] += n;
          if (n < R.loteExpurgo) break;
        }
      }
      total.completo = true;
      return total;
    },
    async auditar(e: EventoSeguranca) {
      await q(`INSERT INTO mcp_auditoria (evento, resultado, codigo, concessao_id, usuario_id, empresa_id, client_id, capacidade, itens, duracao_ms)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [e.evento, e.resultado, e.codigo, e.concessaoId ?? null, e.usuarioId ?? null, e.empresaId ?? null, e.clientId ?? null, e.capacidade ?? null, e.itens ?? null, e.duracaoMs ?? null]);
    },
  };
}

/** Dentro da transação de tenant da ferramenta: concessão ainda ativa, mesma pessoa e empresa; FOR SHARE até o commit. */
export async function concessaoVigentePostgres(tx: DbExecutor, principal: PrincipalMcp): Promise<boolean> {
  const r = await protegido(() => tx.query(
    `SELECT 1 FROM mcp_oauth_concessoes WHERE id = $1 AND usuario_id = $2 AND empresa_id = $3 AND revogada_em IS NULL FOR SHARE`,
    [principal.concessaoId, principal.usuarioId, principal.empresaId]));
  return (r.rowCount ?? 0) === 1;
}

type LinhaPedido = { client_id: string; cliente_nome: string; redirect_uri: string; state: string | null; code_challenge: string; escopos: string[]; recurso: string; expira_em: Date };
const COLUNAS_PEDIDO = `client_id, cliente_nome, redirect_uri, state, code_challenge, escopos, recurso, expira_em`;
function pedido(l: LinhaPedido): PedidoAutorizacao {
  return { clientId: l.client_id, clienteNome: l.cliente_nome, redirectUri: l.redirect_uri, state: l.state, codeChallenge: l.code_challenge, escopos: escopos(l.escopos), recurso: l.recurso, expiraEm: new Date(l.expira_em) };
}
