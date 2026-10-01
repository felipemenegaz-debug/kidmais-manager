import assert from "node:assert/strict";
import test from "node:test";
import { criarRevisaoPacoteAdmin } from "../../comercial/pacotes-admin.ts";
import type { DbExecutor, DbQueryResult } from "../../db/contracts.ts";
import { executarNoTenant, type SessaoParaTenant } from "../../saas/provar-tenant.ts";
import type { AIResponse, RascunhoPublico } from "../contratos.ts";
import { atenderConversa, type DependenciasConversa } from "../conversa.ts";
import { criarRepositorioOperacoesEmMemoria } from "./memoria.ts";
import { criarModuloAcoes } from "./modulo.ts";
import { atenderOperacao } from "./operacoes.ts";
import { criarAcoesPacote, type PacoteDominio, type PortaPacotes } from "./pacotes.ts";

/**
 * A2 (H3): editar descrição de pacote USADO e INATIVO pelo Human Gate não pode ativá-lo.
 * Roda o serviço de domínio REAL (`criarRevisaoPacoteAdmin` e o SQL dele) sobre um executor que guarda
 * o estado das linhas de `pacotes`, como o banco guardaria.
 */
const EMPRESA = "11111111-1111-4111-8111-111111111111";
const USUARIO = "aaaaaaaa-0000-4000-8000-000000000001";
const MEMBERSHIP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORIGEM = "22222222-2222-4222-8222-222222222222";
const NOVA = "33333333-3333-4333-8333-333333333333";

type Linha = { id: string; empresa_id: string; codigo: string; nome: string; descricao: string | null; duracao_minutos: number | null; convidados_minimos: number | null; convidados_maximos: number | null; ativo: boolean; vigente: boolean; arquivado_em: string | null; revisao_anterior_id: string | null; utilizado: boolean };

function banco(ativoOrigem: boolean) {
  const linhas = new Map<string, Linha>([[ORIGEM, { id: ORIGEM, empresa_id: EMPRESA, codigo: "COMPLETA", nome: "Festa Completa", descricao: null, duracao_minutos: 240, convidados_minimos: 30, convidados_maximos: 80, ativo: ativoOrigem, vigente: true, arquivado_em: null, revisao_anterior_id: null, utilizado: true }]]);
  const sqls: string[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []): Promise<DbQueryResult<Row>> {
      sqls.push(sql);
      const r = (rows: object[], rowCount = rows.length) => ({ rows: rows as Row[], rowCount });
      // Tenant Context.
      if (sql.includes("m.status AS membership")) return r(values[0] === MEMBERSHIP ? [{ membership: "ATIVA" }] : []);
      if (sql.includes("SELECT DISTINCT m.empresa_id")) return r([{ id: EMPRESA }]);
      if (sql.includes("FROM memberships m") && sql.includes("JOIN empresas")) return r([{ id: MEMBERSHIP, empresa_id: EMPRESA, papel: "REPRESENTANTE_AUTORIZADO" }]);
      if (sql.includes("SELECT status FROM empresas")) return r([{ status: "ATIVA" }]);
      if (sql.includes("FROM empresas")) return r([{ id: values[0] }]);
      if (sql.includes("SELECT ativo")) return r([{ ativo: true }]);
      if (sql.includes("FROM usuarios_administrativos")) return r([{ id: values[0] }]);
      // Serviço de pacotes (SQL real de pacotes-admin.ts).
      if (sql.includes("AS utilizado") && sql.includes("WHERE p.id = $1::uuid")) {
        const l = linhas.get(String(values[0]));
        return r(l && l.empresa_id === values[1] ? [l] : []);
      }
      if (sql.startsWith("INSERT INTO pacotes")) {
        assert.match(sql, /\$9::boolean, false, \$8::uuid/);
        linhas.set(NOVA, { id: NOVA, empresa_id: String(values[0]), codigo: String(values[1]), nome: String(values[2]), descricao: values[3] as string | null, duracao_minutos: values[4] as number | null, convidados_minimos: values[5] as number | null, convidados_maximos: values[6] as number | null, ativo: values[8] as boolean, vigente: false, arquivado_em: null, revisao_anterior_id: String(values[7]), utilizado: false });
        return r([{ id: NOVA }]);
      }
      if (sql.startsWith("UPDATE pacotes SET vigente = false")) { linhas.get(String(values[0]))!.vigente = false; return r([{ id: values[0] }]); }
      if (sql.startsWith("UPDATE pacotes SET vigente = true")) { linhas.get(String(values[0]))!.vigente = true; return r([{ id: values[0] }]); }
      if (sql.startsWith("UPDATE pacotes")) throw new Error(`UPDATE inesperado em pacotes: ${sql.slice(0, 80)}`);
      if (sql.includes("to_regclass")) return r([{ ok: false }]);
      if (sql.includes("count(*)::int AS n")) return r([{ n: 1 }]);
      if (sql.includes("FROM tabelas_preco")) return r([]);
      if (sql.startsWith("INSERT INTO pacote_") || sql.startsWith("INSERT INTO regras_") || sql.startsWith("INSERT INTO auditoria")) return r([], 1);
      throw new Error(`consulta inesperada: ${sql.slice(0, 80)}`);
    },
  };
  return { tx, linhas, sqls };
}

const ctx = { empresaId: EMPRESA, usuarioId: USUARIO, requestId: "req-1", motivo: "PACOTE_EDITADO" };

test("domínio real: com preservarSituacao a revisão de pacote inativo nasce inativa; o padrão da tela continua ativo", async () => {
  const ia = banco(false);
  const nova = await criarRevisaoPacoteAdmin(ia.tx, ORIGEM, { nome: "Festa Completa", descricao: "Nova", duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 80 }, ctx, { preservarSituacao: true });
  assert.equal(nova.ativo, false);
  assert.equal(ia.linhas.get(NOVA)!.ativo, false);
  assert.equal(ia.sqls.some((s) => /SET ativo/.test(s)), false, "nenhum UPDATE de situação");

  const tela = banco(false);
  const daTela = await criarRevisaoPacoteAdmin(tela.tx, ORIGEM, { nome: "Festa Completa", descricao: "Nova", duracaoMinutos: 240 }, ctx);
  assert.equal(daTela.ativo, true, "comportamento da tela preservado");
});

function mapear(l: Linha): PacoteDominio {
  return { id: l.id, nome: l.nome, descricao: l.descricao, duracaoMinutos: l.duracao_minutos, convidadosMinimos: l.convidados_minimos, convidadosMaximos: l.convidados_maximos, ativo: l.ativo, vigente: l.vigente, arquivadoEm: l.arquivado_em, utilizado: l.utilizado };
}

function ambiente(preservar: boolean) {
  const b = banco(false);
  const porta: PortaPacotes = {
    async listar() { return [...b.linhas.values()].map(mapear); },
    async painel(_tx, _e, id) { const l = b.linhas.get(id); return l ? { pacote: mapear(l), disponibilidade: [], categorias: [], faixas: { editavel: true, faixas: [], aviso: null }, itens: [] } : null; },
    criar: async () => { throw new Error("não usado"); },
    editarNaoUtilizado: async () => { throw new Error("pacote usado nunca passa por aqui"); },
    // Igual à composição de produção (operacoes/composicao.ts); `preservar=false` simula a regressão.
    revisar: async (tx, id, dados, c) => mapear(await criarRevisaoPacoteAdmin(tx, id, dados, c, preservar ? { preservarSituacao: true } : undefined) as unknown as Linha),
    gravarFaixas: async () => { throw new Error("não usado"); },
    alterarSituacao: async () => { throw new Error("nenhuma mudança de situação é pedida"); },
  };
  let n = 0;
  const repositorio = criarRepositorioOperacoesEmMemoria();
  const modulo = criarModuloAcoes(criarAcoesPacote(porta), { repositorio, agora: () => new Date("2026-09-28T15:00:00Z"), novoId: () => `${String(++n).padStart(8, "0")}-0000-4000-8000-000000000000`, ttlConfirmacaoSegundos: 600 });
  const deps: DependenciasConversa = {
    env: { INTELIGENCIA_ENABLED: "true", AI_READ_ENABLED: "true", AI_ADMIN_ACTIONS_ENABLED: "true" },
    autenticar: async () => ({ usuario_id: USUARIO, papel: "REPRESENTANTE_AUTORIZADO" }) as SessaoParaTenant,
    withTenantTransaction: (s, e, w) => executarNoTenant(b.tx, s, e, w),
    agora: () => new Date("2026-09-28T15:00:00Z"),
    requestId: () => `req-${++n}`,
    registrar: () => {},
    relogio: () => 0,
    portas: { festas: null, clientes: null },
    acoes: modulo,
    roteador: null,
  };
  return { b, deps, modulo };
}

test("Human Gate: descrição de pacote usado e inativo — preview mostra a situação e ela continua inativa", async () => {
  const a = ambiente(true);
  const r = await atenderConversa({ lerCorpo: async () => ({ texto: "Edite o pacote Festa Completa, descrição: Nova descrição" }), empresaSolicitada: EMPRESA }, a.deps);
  const resposta = (r.corpo as { data: AIResponse }).data;
  assert.equal(resposta.tipo, "preview", JSON.stringify(r.corpo));
  const preview = (resposta as { rascunho: RascunhoPublico }).rascunho;
  const linhas = Object.fromEntries(preview.campos.map((c) => [c.id, c.valor]));
  assert.equal(linhas.situacao, "Desativado (não muda)");
  const confirmado = await atenderOperacao({ lerCorpo: async () => ({ operacaoId: preview.operacaoId, versao: preview.versao, payloadHash: preview.payloadHash, decisao: "confirmar" }), empresaSolicitada: EMPRESA }, { ...a.deps, acoes: a.modulo });
  assert.equal(confirmado.status, 200, JSON.stringify(confirmado.corpo));
  const vigente = [...a.b.linhas.values()].find((l) => l.vigente)!;
  assert.equal(vigente.id, NOVA);
  assert.equal(vigente.descricao, "Nova descrição");
  assert.equal(vigente.ativo, false, "nenhuma ativação invisível");
});

test("Human Gate: se o domínio ativasse o pacote, a confirmação é recusada (efeito fora do preview)", async () => {
  const a = ambiente(false);
  const r = await atenderConversa({ lerCorpo: async () => ({ texto: "Edite o pacote Festa Completa, descrição: Nova descrição" }), empresaSolicitada: EMPRESA }, a.deps);
  const preview = ((r.corpo as { data: AIResponse }).data as { rascunho: RascunhoPublico }).rascunho;
  const confirmado = await atenderOperacao({ lerCorpo: async () => ({ operacaoId: preview.operacaoId, versao: preview.versao, payloadHash: preview.payloadHash, decisao: "confirmar" }), empresaSolicitada: EMPRESA }, { ...a.deps, acoes: a.modulo });
  assert.equal(confirmado.status, 409);
  assert.equal((confirmado.corpo as { codigo: string }).codigo, "EFEITO_NAO_PREVISTO");
});
