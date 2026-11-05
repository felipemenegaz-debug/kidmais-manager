import { randomUUID } from "node:crypto";
import type { EscopoMcp } from "../mcp/config.ts";
import type { PrincipalMcp } from "../mcp/ferramentas.ts";
import {
  RETENCAO_OAUTH,
  type AcessoVerificado, type AtualizacaoGuardada, type ClienteOAuth, type CodigoGuardado, type ConcessaoResumo, type EventoSeguranca, type NovaConcessao,
  type PedidoAutorizacao, type RepositorioOAuth, type ResultadoExpurgo,
} from "./repositorio.ts";

/**
 * SOMENTE TESTE. Implementação em memória do RepositorioOAuth para os testes offline e de protocolo em loopback.
 * Nunca importada por app/ nem por composição operacional (teste estático em mcp-arquitetura.test.ts).
 * Não prova persistência nem concorrência entre processos: isso é a suíte PostgreSQL (pendente de autorização).
 */
type Concessao = NovaConcessao & { id: string; criadaEm: Date; revogadaEm: Date | null; motivo: string | null; ultimoUsoEm: Date | null; ultimaFerramentaEm: Date | null };
type Token = { id: string; concessaoId: string; tipo: "ACESSO" | "ATUALIZACAO"; escopos: readonly EscopoMcp[]; criadoEm: Date; expiraEm: Date; revogadoEm: Date | null };

export type UsuarioTeste = { ativo: boolean; papel: string; senhaAlteradaEm: Date };

export class RepositorioOAuthMemoria implements RepositorioOAuth {
  readonly clientes = new Map<string, ClienteOAuth>();
  readonly pedidos = new Map<string, PedidoAutorizacao & { consumido: boolean; consumidoEm: Date | null }>();
  readonly concessoes = new Map<string, Concessao>();
  readonly codigos = new Map<string, CodigoGuardado & { concessaoId: string }>();
  readonly tokens = new Map<string, Token>();
  readonly auditoria: Array<EventoSeguranca & { ocorridoEm?: Date }> = [];
  readonly usuarios = new Map<string, UsuarioTeste>();
  readonly empresas = new Map<string, string>();

  private readonly agora: () => Date;
  constructor(agora: () => Date = () => new Date()) {
    this.agora = agora;
  }

  async clienteEmCache(clientId: string) {
    return this.clientes.get(clientId) ?? null;
  }
  async guardarCliente(c: ClienteOAuth) {
    this.clientes.set(c.clientId, c);
  }
  async criarPedidoNoTeto(chaveHash: string, p: PedidoAutorizacao, teto: number) {
    // Síncrono entre o teste e a gravação: em processo único equivale à admissão serializada do PostgreSQL.
    const pendentes = [...this.pedidos.values()].filter((x) => x.clientId === p.clientId && !x.consumido && x.expiraEm > this.agora()).length;
    if (pendentes >= teto) return false;
    this.pedidos.set(chaveHash, { ...p, consumido: false, consumidoEm: null });
    return true;
  }
  async lerPedido(chaveHash: string) {
    const p = this.pedidos.get(chaveHash);
    return p && !p.consumido && p.expiraEm > this.agora() ? p : null;
  }
  async consumirPedido(chaveHash: string) {
    const p = await this.lerPedido(chaveHash);
    if (!p) return null;
    p.consumido = true;
    (p as { consumidoEm: Date | null }).consumidoEm = this.agora();
    return p;
  }
  async criarConcessaoComCodigo(c: NovaConcessao, codigoHash: string, expiraEm: Date, codeChallenge: string) {
    for (const x of this.concessoes.values()) {
      if (x.usuarioId === c.usuarioId && x.empresaId === c.empresaId && x.clientId === c.clientId && !x.revogadaEm) {
        x.revogadaEm = this.agora();
        x.motivo = "SUBSTITUIDA";
      }
    }
    const id = randomUUID();
    this.concessoes.set(id, { ...c, id, criadaEm: this.agora(), revogadaEm: null, motivo: null, ultimoUsoEm: null, ultimaFerramentaEm: null });
    this.codigos.set(codigoHash, {
      concessaoId: id, usuarioId: c.usuarioId, empresaId: c.empresaId, clientId: c.clientId, redirectUri: c.redirectUri, codeChallenge, escopos: c.escopos, expiraEm, usado: false,
    });
    return id;
  }
  async lerCodigo(hash: string) {
    const c = this.codigos.get(hash);
    return c ? { ...c } : null;
  }
  async consumirCodigo(hash: string) {
    const c = this.codigos.get(hash);
    if (!c || c.usado || c.expiraEm <= this.agora()) return false;
    c.usado = true;
    return true;
  }
  async salvarTokens(concessaoId: string, escopos: readonly EscopoMcp[], acesso: { hash: string; expiraEm: Date }, atualizacao: { hash: string; expiraEm: Date } | null) {
    const c = this.concessoes.get(concessaoId);
    if (!c || c.revogadaEm || escopos.length === 0 || escopos.some((e) => !c.escopos.includes(e))) throw Object.assign(new Error("concessão revogada ou escopo inválido"), { name: "invalid_grant", code: 400 });
    if ((await this.emissoesRecentes(concessaoId)) >= RETENCAO_OAUTH.emissoesPorHoraTeto) throw Object.assign(new Error("teto de emissões da concessão"), { name: "temporarily_unavailable", code: 429 });
    const agora = this.agora();
    this.tokens.set(acesso.hash, { id: randomUUID(), concessaoId, tipo: "ACESSO", escopos: [...escopos], criadoEm: agora, expiraEm: acesso.expiraEm, revogadoEm: null });
    if (atualizacao) this.tokens.set(atualizacao.hash, { id: randomUUID(), concessaoId, tipo: "ATUALIZACAO", escopos: [...escopos], criadoEm: agora, expiraEm: atualizacao.expiraEm, revogadoEm: null });
    // Mesma retenção na gravação da implementação PostgreSQL.
    // Mais recentes primeiro; empate de horário desfeito pela ordem de criação (o mais novo fica).
    const girados = [...this.tokens.entries()]
      .map(([k, t], ordem) => ({ k, t, ordem }))
      .filter(({ t }) => t.concessaoId === concessaoId && t.tipo === "ATUALIZACAO" && t.revogadoEm)
      .sort((a, b) => b.t.revogadoEm!.getTime() - a.t.revogadoEm!.getTime() || b.t.criadoEm.getTime() - a.t.criadoEm.getTime() || b.ordem - a.ordem);
    for (const { k } of girados.slice(RETENCAO_OAUTH.refreshGiradosGuardados)) this.tokens.delete(k);
    for (const [k, t] of this.tokens) {
      if (t.concessaoId !== concessaoId) continue;
      const acessoVelho = t.tipo === "ACESSO" && t.expiraEm < agora && t.criadoEm.getTime() < agora.getTime() - 3_600_000;
      const refreshVencido = t.tipo === "ATUALIZACAO" && !t.revogadoEm && t.expiraEm < agora;
      if (acessoVelho || refreshVencido) this.tokens.delete(k);
    }
  }
  async emissoesRecentes(concessaoId: string) {
    const desde = this.agora().getTime() - 3_600_000;
    return [...this.tokens.values()].filter((t) => t.concessaoId === concessaoId && t.tipo === "ACESSO" && t.criadoEm.getTime() > desde).length;
  }
  private concessaoAtiva(id: string) {
    const c = this.concessoes.get(id);
    if (!c || c.revogadaEm) return null;
    const u = this.usuarios.get(c.usuarioId);
    if (!u || !u.ativo || u.senhaAlteradaEm > c.criadaEm) return null;
    return { c, u };
  }
  async lerAtualizacao(hash: string): Promise<AtualizacaoGuardada | null> {
    const t = this.tokens.get(hash);
    // Girado continua detectável mesmo vencido (evidência guardada); não girado e vencido é só inválido.
    if (!t || t.tipo !== "ATUALIZACAO" || (!t.revogadoEm && t.expiraEm <= this.agora())) return null;
    const c = this.concessoes.get(t.concessaoId);
    if (!c) return null;
    // Token girado reapresentado com a concessão ativa ⇒ reuso (o serviço revoga). Concessão já revogada ⇒ só inválido.
    if (!this.concessaoAtiva(t.concessaoId)) return null;
    return { tokenId: t.id, concessaoId: c.id, usuarioId: c.usuarioId, empresaId: c.empresaId, clientId: c.clientId, escopos: t.escopos, expiraEm: t.expiraEm, revogado: t.revogadoEm !== null };
  }
  async revogarAtualizacao(tokenId: string) {
    for (const t of this.tokens.values()) {
      if (t.id === tokenId) {
        if (t.revogadoEm || t.expiraEm <= this.agora()) return false;
        t.revogadoEm = this.agora();
        return true;
      }
    }
    return false;
  }
  async revogarConcessao(id: string, motivo: string, porUsuarioId: string | null) {
    const c = this.concessoes.get(id);
    if (!c || c.revogadaEm || (porUsuarioId !== null && c.usuarioId !== porUsuarioId)) return false;
    c.revogadaEm = this.agora();
    c.motivo = motivo;
    for (const t of this.tokens.values()) if (t.concessaoId === id && !t.revogadoEm) t.revogadoEm = this.agora();
    return true;
  }
  async verificarAcesso(hash: string): Promise<AcessoVerificado | null> {
    const t = this.tokens.get(hash);
    if (!t || t.tipo !== "ACESSO" || t.revogadoEm || t.expiraEm <= this.agora()) return null;
    const ativa = this.concessaoAtiva(t.concessaoId);
    if (!ativa) return null;
    const { c, u } = ativa;
    const principal: PrincipalMcp = { concessaoId: c.id, usuarioId: c.usuarioId, empresaId: c.empresaId, clientId: c.clientId, escopos: t.escopos, papel: u.papel };
    return { ...principal, recurso: c.recurso, expiraEm: t.expiraEm };
  }
  async listarConcessoes(usuarioId: string): Promise<readonly ConcessaoResumo[]> {
    return [...this.concessoes.values()].filter((c) => c.usuarioId === usuarioId).map((c) => ({
      id: c.id, clientId: c.clientId, clienteNome: c.clienteNome, empresaId: c.empresaId, empresaNome: this.empresas.get(c.empresaId) ?? c.empresaId, escopos: c.escopos, criadaEm: c.criadaEm.toISOString(),
      ultimoUsoEm: c.ultimoUsoEm?.toISOString() ?? null, ultimaFerramentaEm: c.ultimaFerramentaEm?.toISOString() ?? null, revogadaEm: c.revogadaEm?.toISOString() ?? null,
    }));
  }
  async marcarUso(id: string, ferramenta: boolean) {
    const c = this.concessoes.get(id);
    if (!c) return;
    c.ultimoUsoEm = this.agora();
    if (ferramenta) c.ultimaFerramentaEm = this.agora();
  }
  async expurgarExpirados(): Promise<ResultadoExpurgo> {
    const agora = this.agora().getTime();
    const revogadaHa = (id: string, ms: number) => {
      const r = this.concessoes.get(id)?.revogadaEm;
      return r ? r.getTime() < agora - ms : false;
    };
    const r: ResultadoExpurgo = { pedidos: 0, codigos: 0, tokens: 0, concessoes: 0, auditoria: 0, lotes: 1, completo: true };
    // Mesmo critério do PostgreSQL: vencido há > 1 h OU consumido há > 1 h.
    for (const [k, p] of this.pedidos) {
      if (p.expiraEm.getTime() < agora - 3_600_000 || (p.consumidoEm !== null && p.consumidoEm.getTime() < agora - 3_600_000)) { this.pedidos.delete(k); r.pedidos += 1; }
    }
    for (const [k, c] of this.codigos) {
      if ((!c.usado && c.expiraEm.getTime() < agora - 3_600_000) || revogadaHa(c.concessaoId, 86_400_000)) { this.codigos.delete(k); r.codigos += 1; }
    }
    for (const [k, t] of this.tokens) {
      const acesso = t.tipo === "ACESSO" && t.expiraEm.getTime() < agora - 3_600_000;
      const refresh = t.tipo === "ATUALIZACAO" && !t.revogadoEm && t.expiraEm.getTime() < agora;
      if (acesso || refresh || revogadaHa(t.concessaoId, 86_400_000)) { this.tokens.delete(k); r.tokens += 1; }
    }
    // Mesmos critérios de elegibilidade da implementação PostgreSQL (RETENCAO_OAUTH).
    for (const [id] of this.concessoes) {
      const temFilhos = [...this.tokens.values()].some((t) => t.concessaoId === id) || [...this.codigos.values()].some((c) => c.concessaoId === id);
      if (!temFilhos && revogadaHa(id, RETENCAO_OAUTH.concessaoRevogadaDias * 86_400_000)) { this.concessoes.delete(id); r.concessoes += 1; }
    }
    const limiteAuditoria = agora - RETENCAO_OAUTH.auditoriaDias * 86_400_000;
    for (let i = this.auditoria.length - 1; i >= 0; i -= 1) {
      if ((this.auditoria[i].ocorridoEm?.getTime() ?? agora) < limiteAuditoria) { this.auditoria.splice(i, 1); r.auditoria += 1; }
    }
    return r;
  }
  async auditar(e: EventoSeguranca) {
    this.auditoria.push({ ...e, ocorridoEm: this.agora() });
  }
}
