import * as nodeCrypto from "node:crypto";
import { randomBytes, randomUUID } from "node:crypto";
import { conectarDescartavel } from "../../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../../db/contracts.ts";
import { executarNoTenant, type SessaoParaTenant } from "../../saas/provar-tenant.ts";
import { carregarComponente } from "../../../components/admin/teste-componente.ts";
import * as credencial from "../credencial.ts";
import * as core from "./core.ts";
import * as configuracaoReal from "./configuracao.ts";
import * as prontas from "./prontas.ts";
import * as prontasLink from "./prontas-link.ts";
import * as arquivos from "./arquivos.ts";
import * as reautenticacao from "../../perfil/reautenticacao.ts";
import * as entendimento from "./walle/entendimento.ts";
import * as contextoWallE from "./walle/contexto.ts";
import * as fontesWallE from "./walle/fontes-postgres.ts";
import * as linkWallE from "./walle/link-disponibilidade.ts";
import * as resolverWallE from "./walle/resolver.ts";
import * as multiempresa from "./multiempresa.ts";
import * as mappers from "../../clientes/repositories/mappers.ts";
import * as normalizers from "../../clientes/repositories/normalizers.ts";
import * as cnpj from "../../cadastro/cnpj.ts";
import { listarContratacoes } from "../../fechamentos/contratacoes.ts";
import { cod, transporteSemRede, db as dbBase } from "./harness-postgres.ts";
import type { ConteudoSaida } from "./transporte.ts";
import type { AlvoEnvio, DependenciasWorker, PortaWallE } from "./worker.ts";

/**
 * Apoio das suítes PostgreSQL da E-ME1 r2 (multiempresa-portoes / -corridas / -rollback). Só usado por *.postgres.test.ts,
 * no cluster descartável com opt-in. Dados sintéticos; nenhuma rede (Graph e Gupshup espionados), nenhum modelo real.
 *
 * Diferenças para o harness-postgres (H-REG, que fica sem alteração):
 *  - flags MUTÁVEIS de processo: piloto (pode ser ausente: MULTI sem piloto, rollback sem piloto), K-PROC e modo regras;
 *  - GANCHO de consulta: toda consulta de serviço/worker/meta/privacidade passa por `ganchos` com a origem ('tx' = dentro
 *    de withTransaction, 'db' = db() avulso). Um gancho pode SEGURAR a consulta (barreira determinística: o teste observa
 *    o ponto e decide quando liberar) ou FALHAR uma vez (erro transitório real numa leitura de portão).
 *  - cada transação e cada db() são uma CONEXÃO PostgreSQL própria (como o pool): travas e esperas são reais.
 * As identidades (usuarios_administrativos) são criadas pelas próprias suítes (invariante F1 de lib/autenticacao).
 */
export type Origem = "tx" | "db";
export type Gancho = (sql: string, origem: Origem, valores: readonly unknown[]) => void | Promise<void>;
export const flags = { piloto: null as string | null, kproc: true, regras: true, ambiente: "staging" };
const ganchos = new Set<Gancho>();
export function comGancho(g: Gancho) { ganchos.add(g); return () => { ganchos.delete(g); }; }
// Avisos de FIM de transação (logo depois do COMMIT, antes de a conexão fechar): a medição M-r3 termina aqui.
const fimDeTransacao = new Set<(fase: { commitMs: number }) => void>();
export function aoFimDaTransacao(g: (fase: { commitMs: number }) => void) { fimDeTransacao.add(g); return () => { fimDeTransacao.delete(g); }; }
export function semGanchos() { ganchos.clear(); fimDeTransacao.clear(); }

const envolver = (exec: DbExecutor, origem: Origem): DbExecutor => ({
  async query(sql: string, v?: readonly unknown[]) {
    for (const g of [...ganchos]) await g(sql, origem, v ?? []);
    return exec.query(sql, v as unknown[]);
  },
}) as DbExecutor;
// Mesma transação de harness-postgres.ts (conexão própria, BEGIN/COMMIT/ROLLBACK), com os ganchos de consulta e o aviso
// de fim logo depois do COMMIT.
export async function withTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  const c = await conectarDescartavel({ travar: false });
  try {
    await c.query("BEGIN");
    const r = await fn(envolver(c as unknown as DbExecutor, "tx"));
    const antesDoCommit = performance.now();
    await c.query("COMMIT");
    const fase = { commitMs: performance.now() - antesDoCommit };
    for (const g of [...fimDeTransacao]) g(fase);
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}
export const db = () => envolver(dbBase() as unknown as DbExecutor, "db");

/**
 * Barreira na primeira consulta que satisfaz `casa`: a consulta fica SEGURA até `liberar()`; `chegou` resolve quando ela
 * chegou ao ponto (o teste age no intervalo). Depois de usada, a barreira se remove.
 */
export function barreira(casa: (sql: string, origem: Origem) => boolean) {
  let liberar!: () => void, sinal!: () => void;
  const solta = new Promise<void>((r) => { liberar = r; });
  const chegou = new Promise<void>((r) => { sinal = r; });
  let usada = false;
  const remover = comGancho(async (sql, origem) => {
    if (usada || !casa(sql, origem)) return;
    usada = true; remover(); sinal(); await solta;
  });
  return { chegou, liberar, remover };
}
/** Falha UMA vez (erro de leitura real, antes de executar) a primeira consulta que satisfaz `casa`. */
export function falhaUmaVez(casa: (sql: string, origem: Origem) => boolean, mensagem = "falha transitória simulada (conexão caiu)") {
  let disparou = 0;
  const remover = comGancho((sql, origem) => { if (!disparou && casa(sql, origem)) { disparou++; remover(); throw new Error(mensagem); } });
  return { disparou: () => disparou, remover };
}

const configuracao = {
  ...configuracaoReal,
  ambienteAtendimento: () => flags.ambiente,
  empresaPiloto: () => { if (!flags.piloto) throw new Error("ATENDIMENTO_EMPRESA_NAO_CONFIGURADA"); return flags.piloto; },
  atendimentoAtivo: () => flags.kproc,
  entendimentoSoRegras: () => flags.regras,
  recepcaoAtiva: () => !!flags.piloto,
  recepcaoTecnicaAtiva: () => true,
  recepcaoMetaAtiva: () => true,
  receptorDoNumero: () => true,
  contatoPermitido: (contato: string) => contato.startsWith("55619"),
  origemMidia: () => "https://midia.kidmais.example",
};

export function carregarMultiempresa() {
  const postgres = { withTransaction, db };
  const tenant = { withTenantTransaction: (s: SessaoParaTenant, e: string, w: Parameters<typeof executarNoTenant>[3]) => withTransaction((tx) => executarNoTenant(tx, s, e, w)) };
  const servico = carregarComponente("lib/whatsapp/atendimento/service.ts", {
    "../../db/postgres.ts": postgres, "../../saas/provar-tenant.ts": tenant, "./configuracao.ts": configuracao, "./core.ts": core, "./arquivos.ts": arquivos, "./walle/entendimento.ts": entendimento, "./multiempresa.ts": multiempresa,
  }).modulo as typeof import("./service.ts");
  const privacidade = carregarComponente("lib/whatsapp/atendimento/privacidade.ts", {
    "node:crypto": nodeCrypto, "../../db/postgres.ts": postgres, "../../saas/provar-tenant.ts": tenant, "../../perfil/reautenticacao.ts": reautenticacao,
    "./configuracao.ts": configuracao, "./core.ts": core, "./arquivos.ts": arquivos,
  }).modulo as typeof import("./privacidade.ts");
  const worker = carregarComponente("lib/whatsapp/atendimento/worker.ts", {
    "../../db/postgres.ts": postgres, "./configuracao.ts": configuracao, "./core.ts": core, "./service.ts": servico, "./transporte.ts": transporteSemRede, "./arquivos.ts": arquivos, "./multiempresa.ts": multiempresa,
  }).modulo as typeof import("./worker.ts");
  const meta = carregarComponente("lib/whatsapp/atendimento/meta.ts", {
    "../../db/postgres.ts": postgres, "../credencial.ts": credencial, "./configuracao.ts": configuracao, "./core.ts": core, "./service.ts": servico, "./transporte.ts": transporteSemRede, "./multiempresa.ts": multiempresa,
  }).modulo as typeof import("./meta.ts");
  const clientes = carregarComponente("lib/clientes/repositories/cliente.repository.ts", {
    "../../db/postgres": postgres, "./mappers": mappers, "./normalizers": normalizers, "../../cadastro/cnpj.ts": cnpj,
  }).modulo as typeof import("../../clientes/repositories/cliente.repository.ts");
  const biblioteca = carregarComponente("lib/whatsapp/atendimento/prontas-servico.ts", {
    "../../clientes/repositories/cliente.repository.ts": clientes, "../../fechamentos/contratacoes.ts": { listarContratacoes },
    "./configuracao.ts": configuracao, "./service.ts": servico, "./prontas.ts": prontas, "./prontas-link.ts": prontasLink, "./arquivos.ts": arquivos, "node:crypto": nodeCrypto,
  }).modulo as typeof import("./prontas-servico.ts");
  // Porta REAL do Wall-e (porta.ts), com a conexão do harness: fontes, catálogo e link de disponibilidade de produção.
  const portaWallE = carregarComponente("lib/whatsapp/atendimento/walle/porta.ts", {
    "../../../db/postgres.ts": postgres, "../../../clientes/repositories/cliente.repository": clientes, "../../../fechamentos/contratacoes.ts": { listarContratacoes },
    "../core.ts": core, "../configuracao.ts": configuracao, "../prontas-link.ts": prontasLink, "./contexto.ts": contextoWallE, "./entendimento.ts": entendimento,
    "./fontes-postgres.ts": fontesWallE, "./link-disponibilidade.ts": linkWallE, "./resolver.ts": resolverWallE,
  }).modulo as typeof import("./walle/porta.ts");
  return { servico, worker, meta, privacidade, biblioteca, portaWallE };
}

const SENHA_FIXA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
export const APP = "1622943079270352", NEGOCIO = "1591095999057604";
type Q = (sql: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Fixtures sintéticas sobre uma conexão de controle. `criarUsuario` é da suíte (só arquivos de teste inserem identidade).
 * Empresas A (piloto), B..; conexão Meta CONFIGURADA por empresa (números distintos), isenção (C4 SIM) e sessões.
 */
export function fixturesMultiempresa(q: Q, criarUsuario: (papel: string) => Promise<string>) {
  const id = async (sql: string, v: unknown[]) => (await q(sql, v)).rows[0].id as string;
  const indice = new Map<string, number>();
  const empresa = async (rotulo: string) => {
    const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id`, [cod("mr"), `Buffet sintético ${rotulo} (E-ME1 r2)`]);
    await q(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
    indice.set(e, indice.size + 1);
    return e;
  };
  const sessao = async (e: string, papel = "REPRESENTANTE_AUTORIZADO") => {
    const u = await criarUsuario(papel);
    const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [e, u, papel]);
    await q(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
    const s = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
      VALUES ($1::uuid, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4::uuid) RETURNING id`, [u, randomBytes(32).toString("hex"), randomBytes(32).toString("hex"), e]);
    return { usuario_id: u, papel, id: s, empresa_ativa_id: e, autenticado_em: new Date().toISOString() } as never as SessaoParaTenant & { usuario_id: string };
  };
  const numero = (e: string) => `31${String(indice.get(e) ?? 0).padStart(4, "0")}`.padEnd(10, "7");
  const waba = (e: string) => `21${String(indice.get(e) ?? 0).padStart(4, "0")}`.padEnd(10, "7");
  const conectar = async (e: string, autor: string) => {
    const cifra = credencial.cifrarCredencialWhatsapp(`token-sintetico-${numero(e)}`, { ambiente: "STAGING", appId: APP, businessId: NEGOCIO, wabaId: waba(e), phoneNumberId: numero(e), empresaId: e });
    return id(`WITH instante AS (SELECT clock_timestamp() AS agora)
      INSERT INTO whatsapp_conexoes(ambiente,empresa_id,meta_app_id,business_id,waba_id,phone_number_id,numero_exibicao,nome_verificado,coexistencia_confirmada,status,escopos,credencial_cifrada,credencial_iv,credencial_tag,credencial_chave_versao,token_tipo,token_expira_em,meta_validada_em,criada_por_usuario_id,sessao_referencia_id,criada_em,atualizada_em)
      SELECT 'STAGING',$1::uuid,$2,$3,$4,$5,'+55 61 90000-0000','Buffet sintético',true,'CONFIGURADA',ARRAY['whatsapp_business_messaging'],$6,$7,$8,$9,'bearer',NULL,agora,$10::uuid,$11::uuid,agora,agora FROM instante RETURNING id`,
      [e, APP, NEGOCIO, waba(e), numero(e), cifra.ciphertext, cifra.iv, cifra.tag, cifra.keyVersion, autor, randomUUID()]);
  };
  let doc = 500 + Math.floor(Math.random() * 400000);
  const isentar = async (e: string, autor: string) => {
    await q(`INSERT INTO assinatura_isencoes (empresa_id, documento_verificado, motivo, concedida_por) VALUES ($1, $2, 'Isenção sintética do harness r2', $3)`, [e, `${String(doc++).padStart(12, "0")}00`, autor]);
  };
  const desconectar = (e: string, autor: string) => q(`UPDATE whatsapp_conexoes SET status='DESCONECTADA',desconectada_em=clock_timestamp(),desconectada_por_usuario_id=$2,motivo_desconexao='revogação sintética',revisao=revisao+1,atualizada_em=clock_timestamp() WHERE empresa_id=$1 AND status='CONFIGURADA'`, [e, autor]);
  // Conexão DESCONECTADA é imutável (083): reconectar = nova conexão CONFIGURADA do mesmo número (identidade histórica preservada).
  const reconectar = (e: string, autor: string) => conectar(e, autor);
  // Plano revogado = a isenção some (C4 vira SEM_INFORMACAO); restaurar reinsere a mesma linha. Gatilhos de guarda
  // desligados SÓ nesta sessão do cluster descartável; os CHECKs continuam valendo.
  const guardadas = new Map<string, Record<string, unknown>[]>();
  const revogarIsencao = async (e: string) => {
    await q("SET session_replication_role = replica");
    try { guardadas.set(e, (await q("DELETE FROM assinatura_isencoes WHERE empresa_id=$1 RETURNING *", [e])).rows); }
    finally { await q("RESET session_replication_role"); }
  };
  const restaurarIsencao = async (e: string) => {
    await q("SET session_replication_role = replica");
    try { for (const l of guardadas.get(e) ?? []) await q("INSERT INTO assinatura_isencoes SELECT * FROM jsonb_populate_record(NULL::assinatura_isencoes, $1::jsonb)", [JSON.stringify(l)]); }
    finally { await q("RESET session_replication_role"); }
    guardadas.delete(e);
  };
  return { empresa, sessao, numero, waba, conectar, isentar, desconectar, reconectar, revogarIsencao, restaurarIsencao, SENHA_FIXA };
}

/** Transporte falso: registra empresa/ambiente/conversa/saída e devolve um identificador; nunca rede. */
export function transporteEspiao(meta: ReturnType<typeof carregarMultiempresa>["meta"]) {
  const envios: { contato: string; alvo: AlvoEnvio; texto: string | null }[] = [];
  const graph: string[] = [], gupshup: string[] = [];
  let segurar: null | { chegou: () => void; solta: Promise<string | void> } = null;
  let proximoId: (() => string) | null = null;
  const buscar = (async (url: string) => { graph.push(String(url)); return new Response(JSON.stringify({ messages: [{ id: proximoId ? proximoId() : cod("wamid.") }] }), { status: 200 }); }) as unknown as typeof fetch;
  const enviar = async (contato: string, conteudo: ConteudoSaida, alvo: AlvoEnvio) => {
    envios.push({ contato, alvo, texto: (conteudo as { texto?: string }).texto ?? null });
    if (segurar) { const s = segurar; segurar = null; s.chegou(); const forcado = await s.solta; if (typeof forcado === "string") return forcado; }
    return meta.enviarPelaEmpresa(contato, conteudo, { alvo, buscar, gupshup: async (c) => { gupshup.push(c); return cod("gs-"); } });
  };
  /** O PRÓXIMO envio fica preso DEPOIS de marcado ENVIANDO (dentro de `enviar`) até `liberar(id?)`. */
  const prenderProximo = () => {
    let liberar!: (id?: string) => void, sinal!: () => void;
    const solta = new Promise<string | void>((r) => { liberar = r; });
    const chegou = new Promise<void>((r) => { sinal = r; });
    segurar = { chegou: sinal, solta };
    return { chegou, liberar };
  };
  const fixarIds = (f: (() => string) | null) => { proximoId = f; };
  return { envios, graph, gupshup, enviar, prenderProximo, fixarIds };
}

export function depsCom(enviar: DependenciasWorker["enviar"], wallE?: PortaWallE): DependenciasWorker {
  return { interpretar: null, enviar, ...(wallE ? { wallE } : {}) };
}

/** Espera até que TODAS as consultas com os trechos estejam esperando trava (pg_stat_activity), numa conexão de controle. */
export async function esperandoTrava(q: Q, trechos: string[], oque = "espera") {
  for (let i = 0; i < 400; i++) {
    const r = (await q("SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows.map((l) => String(l.query));
    if (trechos.every((tr) => r.some((l) => l.includes(tr)))) return;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error(`${oque}: não chegou à espera de trava: ${trechos.join(" | ")}`);
}
/** Conexão extra (terceira) para segurar travas de linha/consultivas fora do código sob teste. */
export async function conexaoExtra() { return conectarDescartavel({ travar: false }); }
export { cod };
export const SENHA = SENHA_FIXA;
