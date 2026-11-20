import type { DbExecutor } from "../db/contracts.ts";

/**
 * Marca de saída das campanhas por telefone/e-mail (migration 127, guarda dos clientes fase 1a, 19/11/2026).
 *
 * O DPA 2026-11-17 (seção campanhas) promete guardar a saída pelo telefone ou e-mail e a data, e conferir quando a mesma
 * pessoa volta por recadastro ou importação. O banco grava as marcas sozinho (gatilhos da 127: descadastro, contato novo
 * de cliente descadastrado, nao_contatar do atendimento); este módulo só LÊ.
 *
 * Regras de leitura:
 *   - vale a marca VIVA (encerrada_em nulo) da mesma empresa;
 *   - telefone comparado pelo destino normalizado (normalizarDestino = kidmais086_destino); e-mail por normalizarEmail
 *     (= kidmais127_email);
 *   - sem a 127 instalada não há marca nenhuma: devolve lista vazia (a 127 sobe antes do código que depende dela, e o
 *     descadastro por cliente da 086 continua valendo do mesmo jeito);
 *   - erro de consulta SOBE (falha fechada): nunca vira "sem marca".
 * A marca bloqueia só CAMPANHA (decisão G2): a pesquisa de satisfação segue as regras próprias (descadastro, saída das
 * pesquisas e PARAR).
 */

export type TipoSaida = "TELEFONE" | "EMAIL";
export type SaidaContato = { tipo: TipoSaida; valor: string; saiuEm: string; origem: string };

/**
 * Telefone canônico: a MESMA regra de normalizarDestino (lib/marketing/automacoes/preferencias.ts) e de kidmais086_destino.
 * Cópia de propósito (preferencias.ts importa este módulo; o teste confere que as duas dão o mesmo resultado).
 */
export function normalizarTelefone(valor: string | null | undefined): string | null {
  const d = (valor ?? "").replace(/\D/g, "");
  if (/^\d{10,11}$/.test(d)) return `55${d}`;
  return /^\d{12,15}$/.test(d) ? d : null;
}

/** E-mail canônico: minúsculas, sem espaços nas pontas; uma @ com algo dos dois lados; até 320 caracteres. */
export function normalizarEmail(valor: string | null | undefined): string | null {
  const e = (valor ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(e) && e.length <= 320 ? e : null;
}

async function saidasInstaladas(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.marketing_saidas_contato') IS NOT NULL AS ok`);
  if (typeof r.rows[0]?.ok !== "boolean") throw new Error("catálogo da marca de saída ilegível");
  return r.rows[0].ok;
}

type Linha = { tipo: TipoSaida; valor: string; saiu_em: string; origem: string };
const mapear = (r: Linha[]): SaidaContato[] => r.map((l) => ({ tipo: l.tipo, valor: l.valor, saiuEm: l.saiu_em, origem: l.origem }));

/**
 * Marcas vivas que alcançam o cadastro ATUAL do cliente (WhatsApp, telefone e e-mail), mais um telefone extra opcional
 * (o número informado no formulário do site). Cliente de outra empresa não alcança nada.
 */
export async function saidasDoCliente(tx: DbExecutor, empresaId: string, clienteId: string, telefoneExtra: string | null = null): Promise<SaidaContato[]> {
  if (!(await saidasInstaladas(tx))) return [];
  const r = await tx.query<Linha>(
    `/* guarda:saidas-do-cliente */
     SELECT s.tipo, s.valor, s.saiu_em::text AS saiu_em, s.origem
       FROM marketing_saidas_contato s
       JOIN clientes c ON c.id = $2::uuid AND c.empresa_id = $1::uuid
      WHERE s.empresa_id = $1::uuid AND s.encerrada_em IS NULL
        AND ((s.tipo = 'TELEFONE' AND (s.valor IN (kidmais086_destino(c.whatsapp), kidmais086_destino(c.telefone)) OR s.valor = $3))
          OR (s.tipo = 'EMAIL' AND s.valor = kidmais127_email(c.email)))
      ORDER BY s.saiu_em, s.tipo, s.valor`,
    [empresaId, clienteId, normalizarTelefone(telefoneExtra)]);
  return mapear(r.rows);
}

/**
 * Marcas vivas para contatos soltos (antes de salvar um cadastro ou numa linha de importação). Só aviso: não bloqueia
 * o cadastro; quem bloqueia o envio é a elegibilidade.
 */
export async function saidasDosContatos(tx: DbExecutor, empresaId: string, contatos: { telefones?: (string | null | undefined)[]; emails?: (string | null | undefined)[] }): Promise<SaidaContato[]> {
  const telefones = [...new Set((contatos.telefones ?? []).map(normalizarTelefone).filter((v): v is string => Boolean(v)))];
  const emails = [...new Set((contatos.emails ?? []).map(normalizarEmail).filter((v): v is string => Boolean(v)))];
  if (telefones.length === 0 && emails.length === 0) return [];
  if (!(await saidasInstaladas(tx))) return [];
  const r = await tx.query<Linha>(
    `/* guarda:saidas-dos-contatos */
     SELECT tipo, valor, saiu_em::text AS saiu_em, origem FROM marketing_saidas_contato
      WHERE empresa_id = $1::uuid AND encerrada_em IS NULL
        AND ((tipo = 'TELEFONE' AND valor = ANY ($2::text[])) OR (tipo = 'EMAIL' AND valor = ANY ($3::text[])))
      ORDER BY saiu_em, tipo, valor`,
    [empresaId, telefones, emails]);
  return mapear(r.rows);
}

/** Aviso em linguagem simples: "este telefone pediu para sair em 19/11/2026". Data no fuso de São Paulo. */
export function avisoDeSaida(s: SaidaContato): string {
  const d = new Date(s.saiuEm.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  const data = Number.isNaN(d.getTime()) ? s.saiuEm.slice(0, 10) : new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(d);
  return `${s.tipo === "EMAIL" ? "Este e-mail" : "Este telefone"} pediu para sair das campanhas em ${data}.`;
}
