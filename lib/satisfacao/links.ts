import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import { SatisfacaoError } from "./erros.ts";
import { estadoInstalacao111, exigirInstalacao111 } from "./instalacao.ts";

/**
 * Link de avaliação do Google (PS-3, D-PS3-1/D-PS3-2; plano rev. 2.1, B'). Subconjunto FECHADO e declarado — não é
 * "qualquer link do Google Maps": links com @, data=, api=1&query= ou ?g_st=… são recusados. A mesma função confere a
 * escrita e a saída (a página só emite o href se a URL gravada ainda passar). Links curtos (g.page, maps.app.goo.gl)
 * confiam no redirecionador do Google: o destino final NÃO é resolvido nem validado, e nada é buscado na rede.
 *
 * Ordem: string bruta (antes de qualquer parse) → autoridade literal da lista → caminho bruto pela expressão do host e
 * igual ao `pathname` do parser (qualquer normalização recusa: `/maps/../url` vira `/url`) → query em pares brutos, chaves
 * da lista, sem repetição, valores pela expressão da chave, e o `URLSearchParams` devolvendo as mesmas chaves.
 */
type Formato = { caminho: RegExp; query: Record<string, RegExp> | null; obrigatorias?: string[] };

const MAPS: Formato = {
  caminho: /^\/maps(\/[A-Za-z0-9_+,.~-]{1,120}){0,6}\/?$/,
  query: { hl: /^[a-z]{2}(-[A-Z]{2})?$/, entry: /^[a-z]{2,10}$/, g_ep: /^[A-Za-z0-9_-]{1,300}(%3D){0,2}$/ },
};
export const FORMATOS_LINK: Record<string, Formato> = {
  "search.google.com": { caminho: /^\/local\/writereview$/, query: { placeid: /^[A-Za-z0-9_-]{10,200}$/ }, obrigatorias: ["placeid"] },
  "www.google.com": MAPS,
  "google.com": MAPS,
  "maps.google.com": MAPS,
  "g.page": { caminho: /^\/(r\/)?[A-Za-z0-9_-]{2,100}(\/review)?$/, query: null },
  "maps.app.goo.gl": { caminho: /^\/[A-Za-z0-9]{8,40}$/, query: null },
};

/** Exemplos de FORMATO (sintéticos, não verificados no Google) mostrados ao usuário quando o link é recusado. */
export const EXEMPLOS_LINK = [
  "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4",
  "https://g.page/r/CabcdEFGhij123/review",
  "https://maps.app.goo.gl/AbCdEfGh12345",
  "https://www.google.com/maps/place/Buffet+Exemplo?hl=pt-BR&entry=ttu",
];
export const MENSAGEM_LINK_INVALIDO =
  "Use o link de avaliação do Google: “Pedir avaliações” do Perfil da Empresa (search.google.com/local/writereview?placeid=…), " +
  "o link curto g.page/r/…/review ou maps.app.goo.gl/…, ou o endereço www.google.com/maps/… sem @ nem data=.";

export type LinkValidado = { ok: true; url: string } | { ok: false; motivo: string };

export function validarLinkAvaliacao(bruta: unknown): LinkValidado {
  const recusa = (motivo: string): LinkValidado => ({ ok: false, motivo });
  if (typeof bruta !== "string") return recusa("TIPO");
  if (bruta.length === 0 || bruta.length > 500) return recusa("TAMANHO");
  if (!/^[\x21-\x7E]+$/.test(bruta)) return recusa("CARACTERE");
  if (/[\\@#]/.test(bruta)) return recusa("CARACTERE");
  if (!bruta.startsWith("https://")) return recusa("ESQUEMA");
  const resto = bruta.slice("https://".length);
  const fimAutoridade = resto.search(/[/?]/);
  const autoridade = fimAutoridade < 0 ? resto : resto.slice(0, fimAutoridade);
  if (!Object.prototype.hasOwnProperty.call(FORMATOS_LINK, autoridade)) return recusa("HOST");
  const formato = FORMATOS_LINK[autoridade];
  const depois = fimAutoridade < 0 ? "" : resto.slice(fimAutoridade);
  const interrogacao = depois.indexOf("?");
  const caminho = interrogacao < 0 ? depois : depois.slice(0, interrogacao);
  const query = interrogacao < 0 ? null : depois.slice(interrogacao + 1);
  if (!formato.caminho.test(caminho)) return recusa("CAMINHO");

  let url: URL;
  try { url = new URL(bruta); } catch { return recusa("PARSE"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || url.hostname !== autoridade) return recusa("AUTORIDADE");
  if (url.pathname !== caminho) return recusa("NORMALIZACAO");

  if (query === null) {
    if ((formato.obrigatorias ?? []).length > 0) return recusa("QUERY_OBRIGATORIA");
    return url.search === "" ? { ok: true, url: bruta } : recusa("QUERY");
  }
  if (formato.query === null || query === "") return recusa("QUERY");
  const vistas = new Set<string>();
  for (const par of query.split("&")) {
    const m = /^([a-z_]{1,20})=(.*)$/.exec(par);
    if (!m) return recusa("QUERY");
    const [, chave, valor] = m;
    const regra = Object.prototype.hasOwnProperty.call(formato.query, chave) ? formato.query[chave] : null;
    if (!regra) return recusa("CHAVE_DESCONHECIDA");
    if (vistas.has(chave)) return recusa("CHAVE_REPETIDA");
    if (!regra.test(valor)) return recusa("VALOR");
    vistas.add(chave);
  }
  for (const obrigatoria of formato.obrigatorias ?? []) if (!vistas.has(obrigatoria)) return recusa("QUERY_OBRIGATORIA");
  const doParser = [...url.searchParams.keys()];
  if (doParser.length !== vistas.size || doParser.some((k) => !vistas.has(k))) return recusa("QUERY");
  return { ok: true, url: bruta };
}

const GESTAO = "REPRESENTANTE_AUTORIZADO";
function exigirGestao(tenant: TenantComprovado) {
  if (tenant.papelAtual !== GESTAO) throw new SatisfacaoError("SEM_PERMISSAO", "Só a Gestão configura o link de avaliação.", 403);
}

/**
 * Link exibido na página pública (C): configuração ATUAL do par empresa/unidade do ENVIO (nunca da festa de agora nem
 * do corpo). Envio com unidade usa só o link da unidade (sem herdar o da empresa, D-PS3-1); sem unidade, o da empresa.
 * Sem a 111 íntegra, ou URL gravada que não passa mais na gramática: sem link.
 */
export async function linkDoEnvio(tx: DbExecutor, empresaId: string, unidadeId: string | null): Promise<string | null> {
  if ((await estadoInstalacao111(tx)) !== "COMPLETA") return null;
  const url = (await tx.query<{ url: string }>(
    `SELECT url FROM satisfacao_links_avaliacao WHERE empresa_id = $1::uuid AND estabelecimento_id IS NOT DISTINCT FROM $2::uuid`,
    [empresaId, unidadeId])).rows[0]?.url ?? null;
  if (url === null) return null;
  const v = validarLinkAvaliacao(url);
  if (!v.ok) {
    console.warn("[satisfacao] link de avaliação gravado recusado na saída", v.motivo);
    return null;
  }
  return v.url;
}

export type LinkConfigurado = { estabelecimentoId: string | null; url: string | null; atualizadoEm: string | null };

/** Configuração da empresa comprovada: link da empresa + um por unidade não desativada (só Gestão). */
export async function listarLinks(tx: DbExecutor, tenant: TenantComprovado) {
  exigirGestao(tenant);
  await exigirInstalacao111(tx);
  const unidades = (await tx.query<{ id: string; nome: string; status: string }>(
    `SELECT id::text, nome, status FROM estabelecimentos WHERE empresa_id = $1::uuid AND status <> 'DESATIVADO' ORDER BY nome, id`,
    [tenant.empresaComprovada])).rows;
  const links = (await tx.query<{ estabelecimento_id: string | null; url: string; atualizado_em: string }>(
    `SELECT estabelecimento_id::text, url, atualizado_em::text FROM satisfacao_links_avaliacao WHERE empresa_id = $1::uuid`,
    [tenant.empresaComprovada])).rows;
  const de = (unidade: string | null) => links.find((l) => l.estabelecimento_id === unidade) ?? null;
  const item = (unidade: string | null): LinkConfigurado => ({ estabelecimentoId: unidade, url: de(unidade)?.url ?? null, atualizadoEm: de(unidade)?.atualizado_em ?? null });
  return {
    empresa: item(null),
    unidades: unidades.map((u) => ({ ...item(u.id), nome: u.nome })),
    exemplos: EXEMPLOS_LINK,
  };
}

async function unidadeGravavel(tx: DbExecutor, empresaId: string, unidadeId: string | null) {
  if (unidadeId === null) return;
  const u = (await tx.query<{ status: string }>(`SELECT status FROM estabelecimentos WHERE id = $1::uuid AND empresa_id = $2::uuid`, [unidadeId, empresaId])).rows[0];
  if (!u) throw new SatisfacaoError("NAO_ENCONTRADO", "Unidade não encontrada.", 404);
  if (u.status === "DESATIVADO") throw new SatisfacaoError("UNIDADE_DESATIVADA", "Esta unidade está desativada.", 409);
}

async function travarLink(tx: DbExecutor, empresaId: string, unidadeId: string | null) {
  return (await tx.query<{ id: string; url: string }>(
    `/* satisfacao:travar-link */ SELECT id::text, url FROM satisfacao_links_avaliacao
      WHERE empresa_id = $1::uuid AND estabelecimento_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE`, [empresaId, unidadeId])).rows[0] ?? null;
}

async function auditarLink(tx: DbExecutor, tenant: TenantComprovado, unidadeId: string | null, acao: string, anterior: string | null, nova: string | null) {
  await tx.query(`INSERT INTO satisfacao_auditoria (empresa_id, estabelecimento_id, ator_usuario_id, acao, url_anterior, url_nova, criado_em)
    VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, clock_timestamp())`, [tenant.empresaComprovada, unidadeId, tenant.usuarioId, acao, anterior, nova]);
}

const violouUnicidade = (e: unknown) => (e as { code?: string; constraint?: string }).code === "23505" && (e as { constraint?: string }).constraint === "satisfacao_links_uk";

/**
 * Inclui ou troca o link (só Gestão; empresa e autor do tenant; a unidade do corpo só SELECIONA, conferida na empresa).
 * Linha existente travada FOR UPDATE; inclusão concorrente da mesma chave espera e cai na unicidade → 409.
 */
export async function salvarLink(tx: DbExecutor, tenant: TenantComprovado, entrada: { estabelecimentoId: string | null; url: string }) {
  exigirGestao(tenant);
  await exigirInstalacao111(tx);
  // B': a string BRUTA do corpo é validada (sem trim/normalização antes); espaço ou controle recusa.
  const v = validarLinkAvaliacao(entrada.url);
  if (!v.ok) throw new SatisfacaoError("LINK_INVALIDO", MENSAGEM_LINK_INVALIDO, 400, { motivo: v.motivo, exemplos: EXEMPLOS_LINK });
  const empresaId = tenant.empresaComprovada;
  await unidadeGravavel(tx, empresaId, entrada.estabelecimentoId);
  const atual = await travarLink(tx, empresaId, entrada.estabelecimentoId);
  if (atual) {
    if (atual.url === v.url) return { estabelecimentoId: entrada.estabelecimentoId, url: v.url, alterado: false };
    await tx.query(`UPDATE satisfacao_links_avaliacao SET url = $2, atualizado_por = $3::uuid WHERE id = $1::uuid`, [atual.id, v.url, tenant.usuarioId]);
    await auditarLink(tx, tenant, entrada.estabelecimentoId, "LINK_TROCADO", atual.url, v.url);
    return { estabelecimentoId: entrada.estabelecimentoId, url: v.url, alterado: true };
  }
  try {
    await tx.query(`INSERT INTO satisfacao_links_avaliacao (empresa_id, estabelecimento_id, url, criado_por, atualizado_por) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $4::uuid)`,
      [empresaId, entrada.estabelecimentoId, v.url, tenant.usuarioId]);
  } catch (e) {
    if (violouUnicidade(e)) throw new SatisfacaoError("CONFLITO", "O link acabou de ser salvo por outra pessoa. Atualize a página.", 409);
    throw e;
  }
  await auditarLink(tx, tenant, entrada.estabelecimentoId, "LINK_INCLUIDO", null, v.url);
  return { estabelecimentoId: entrada.estabelecimentoId, url: v.url, alterado: true };
}

export async function removerLink(tx: DbExecutor, tenant: TenantComprovado, entrada: { estabelecimentoId: string | null }) {
  exigirGestao(tenant);
  await exigirInstalacao111(tx);
  const empresaId = tenant.empresaComprovada;
  if (entrada.estabelecimentoId !== null) {
    const u = (await tx.query(`SELECT 1 FROM estabelecimentos WHERE id = $1::uuid AND empresa_id = $2::uuid`, [entrada.estabelecimentoId, empresaId])).rows[0];
    if (!u) throw new SatisfacaoError("NAO_ENCONTRADO", "Unidade não encontrada.", 404);
  }
  const atual = await travarLink(tx, empresaId, entrada.estabelecimentoId);
  if (!atual) throw new SatisfacaoError("NAO_ENCONTRADO", "Não há link configurado aqui.", 404);
  await tx.query(`DELETE FROM satisfacao_links_avaliacao WHERE id = $1::uuid`, [atual.id]);
  await auditarLink(tx, tenant, entrada.estabelecimentoId, "LINK_REMOVIDO", atual.url, null);
  return { estabelecimentoId: entrada.estabelecimentoId, removido: true };
}
