import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import { auditarMutacaoComercial } from "./auditoria-comercial.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";
import { exigirGestaoNoTenant } from "../saas/provar-tenant.ts";
import { lerRegrasPagamento, regrasPagamentoInstaladas, REGRAS_NEUTRAS, type RegrasPagamento } from "./regras-pagamento.ts";

/**
 * D1 do plano de descontos (16/11/2026): a Gestão do buffet configura o desconto do Pix à vista, do Pix parcelado e o
 * nome do cartão exibido ao cliente, gravados em `empresa_regras_pagamento` (077) da PRÓPRIA empresa.
 *
 *   - Sem linha gravada, o buffet vê a sugestão (5% e 2%) já preenchida, mas nada vale até salvar: a leitura das
 *     regras continua devolvendo REGRAS_NEUTRAS (0%). A sugestão nunca é gravada sozinha (D-DESC-1).
 *   - Teto de 50% por desconto (D-DESC-3), inteiro, como o domínio da 077 e de `calcularCondicaoComercial`.
 *   - Salvar só mexe nesses três campos. `desconto_dia_util` (selo da Kidmais) é preservado; linha nova nasce `false`.
 *   - Vale só para condições criadas depois: o percentual é copiado para a condição quando ela nasce
 *     (`regraNaCondicao`), e o contrato usa o copiado. Nada aqui toca fechamentos, condições ou contratos.
 *   - Histórico: a `auditoria` (quem, quando, antes e depois), na mesma transação; `motivo` da 077 diz de onde veio.
 *   - Sem a 077 no ambiente: leitura devolve `instalada: false` e gravar recusa com 503, sem escrever nada.
 */
export const TETO_DESCONTO_PERCENTUAL = 50;
export const SUGESTAO_BUFFET_NOVO = Object.freeze({ pixAvistaPercentual: 5, pixParceladoPercentual: 2, cartaoRotulo: "Cartão de crédito" });
export const ENTIDADE_REGRAS_PAGAMENTO = "EMPRESA_REGRAS_PAGAMENTO";
export const MOTIVO_TELA = "Configurações › Descontos e formas de pagamento";
const GESTAO = "Somente a Gestão do buffet pode ver e alterar os descontos e as formas de pagamento.";

export type CamposDescontos = { pixAvistaPercentual: number; pixParceladoPercentual: number; cartaoRotulo: string };
export type ItemHistoricoDescontos = { em: string; por: string | null; mudancas: string[] };
export type EstadoDescontos =
  | { instalada: false }
  | {
      instalada: true;
      /** true = a empresa já salvou (ou é a Kidmais, gravada pela 077). */
      configurada: boolean;
      /** O que vale HOJE para fechamentos novos (neutras sem linha). */
      vigente: RegrasPagamento;
      /** O que a tela mostra nos campos: o gravado, ou a sugestão quando nada foi salvo. */
      formulario: CamposDescontos;
      /** Versão otimista: `atualizado_em` da linha; null = sem linha. */
      versao: string | null;
      historico: ItemHistoricoDescontos[];
    };

type Linha = { pix_avista_percentual: number; pix_parcelado_percentual: number; cartao_rotulo: string; desconto_dia_util: boolean; versao: string };

function erro(codigo: string, mensagem: string, status: number): never {
  throw new PacoteAdminError(codigo, mensagem, status);
}

function percentual(valor: unknown, nome: string): number {
  const n = typeof valor === "string" && valor.trim() !== "" ? Number(valor.trim()) : valor;
  if (typeof n !== "number" || !Number.isFinite(n)) erro("DESCONTO_INVALIDO", `Informe o desconto do ${nome} em número (0 a ${TETO_DESCONTO_PERCENTUAL}).`, 400);
  if (!Number.isInteger(n)) erro("DESCONTO_INVALIDO", `O desconto do ${nome} precisa ser um número inteiro, sem casas decimais.`, 400);
  if (n < 0) erro("DESCONTO_INVALIDO", `O desconto do ${nome} não pode ser negativo.`, 400);
  if (n > TETO_DESCONTO_PERCENTUAL) erro("DESCONTO_ACIMA_DO_TETO", `O desconto do ${nome} passa do limite de ${TETO_DESCONTO_PERCENTUAL}%. Confira se não houve erro de digitação.`, 400);
  return n;
}

/** Validação do pedido de gravação. Campo extra é recusado (lista fechada). */
export function validarDescontos(raw: unknown): CamposDescontos & { versao: string | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) erro("DADOS_INVALIDOS", "Dados inválidos.", 400);
  const r = raw as Record<string, unknown>;
  const permitidos = new Set(["pixAvistaPercentual", "pixParceladoPercentual", "cartaoRotulo", "versao"]);
  if (Object.keys(r).some((k) => !permitidos.has(k))) erro("DADOS_INVALIDOS", "Dados inválidos.", 400);
  const pixAvistaPercentual = percentual(r.pixAvistaPercentual, "Pix à vista");
  const pixParceladoPercentual = percentual(r.pixParceladoPercentual, "Pix parcelado");
  const rotulo = typeof r.cartaoRotulo === "string" ? r.cartaoRotulo.replace(/\s+/g, " ").trim() : "";
  if (rotulo.length < 2 || rotulo.length > 40) erro("CARTAO_ROTULO_INVALIDO", "O nome do cartão precisa ter de 2 a 40 letras.", 400);
  const versao = r.versao == null ? null : typeof r.versao === "string" && r.versao.length <= 64 ? r.versao : erro("DADOS_INVALIDOS", "Dados inválidos.", 400);
  return { pixAvistaPercentual, pixParceladoPercentual, cartaoRotulo: rotulo, versao };
}

async function linhaDaEmpresa(tx: DbExecutor, empresaId: string, travar: boolean) {
  return (await tx.query<Linha>(
    `SELECT pix_avista_percentual, pix_parcelado_percentual, cartao_rotulo, desconto_dia_util, atualizado_em::text AS versao
       FROM public.empresa_regras_pagamento WHERE empresa_id = $1::uuid${travar ? " FOR UPDATE" : ""}`,
    [empresaId])).rows[0] ?? null;
}

const campos = (l: Linha): CamposDescontos => ({
  pixAvistaPercentual: Number(l.pix_avista_percentual), pixParceladoPercentual: Number(l.pix_parcelado_percentual), cartaoRotulo: l.cartao_rotulo,
});

/** Frases do histórico a partir do antes/depois gravados na auditoria. */
export function mudancasDoHistorico(antes: Partial<CamposDescontos> | null, depois: Partial<CamposDescontos>): string[] {
  // Sem "antes" (primeira gravação), a comparação parte do que valia: as regras neutras (0%, "Cartão de crédito").
  const a: Partial<CamposDescontos> = antes ?? { pixAvistaPercentual: REGRAS_NEUTRAS.pixAvistaPercentual, pixParceladoPercentual: REGRAS_NEUTRAS.pixParceladoPercentual, cartaoRotulo: REGRAS_NEUTRAS.cartaoRotulo };
  const linhas: string[] = [];
  const pct = (v: unknown) => (typeof v === "number" ? `${v}%` : "—");
  if (a.pixAvistaPercentual !== depois.pixAvistaPercentual) linhas.push(`Pix à vista: ${pct(a.pixAvistaPercentual)} → ${pct(depois.pixAvistaPercentual)}`);
  if (a.pixParceladoPercentual !== depois.pixParceladoPercentual) linhas.push(`Pix parcelado: ${pct(a.pixParceladoPercentual)} → ${pct(depois.pixParceladoPercentual)}`);
  if (a.cartaoRotulo !== depois.cartaoRotulo) linhas.push(`Nome do cartão: ${a.cartaoRotulo ?? "—"} → ${depois.cartaoRotulo ?? "—"}`);
  return linhas;
}

async function historico(tx: DbExecutor, empresaId: string): Promise<ItemHistoricoDescontos[]> {
  // A auditoria não tem coluna de empresa: o recorte é a entidade (a própria empresa) e o empresaId gravado no depois.
  const linhas = (await tx.query<{ em: string; por: string | null; antes: Partial<CamposDescontos> | null; depois: Partial<CamposDescontos> }>(
    `SELECT a.criado_em::text AS em, u.nome AS por, a.dados_antes AS antes, a.dados_depois AS depois
       FROM auditoria a LEFT JOIN usuarios_administrativos u ON u.id = a.usuario_id
      WHERE a.entidade_tipo = $1 AND a.entidade_id = $2::uuid AND a.dados_depois->>'empresaId' = $2::text
      ORDER BY a.criado_em DESC, a.id DESC LIMIT 10`,
    [ENTIDADE_REGRAS_PAGAMENTO, empresaId])).rows;
  return linhas.map((l) => ({ em: l.em, por: l.por, mudancas: mudancasDoHistorico(l.antes && Object.keys(l.antes).some((k) => k !== "empresaId") ? l.antes : null, l.depois) }));
}

export async function lerDescontosAdmin(tx: DbExecutor, tenant: TenantComprovado): Promise<EstadoDescontos> {
  exigirGestaoNoTenant(tenant, GESTAO);
  if (!await regrasPagamentoInstaladas(tx)) return { instalada: false };
  const empresaId = tenant.empresaComprovada;
  const linha = await linhaDaEmpresa(tx, empresaId, false);
  const vigente = (await lerRegrasPagamento(tx, empresaId)) ?? REGRAS_NEUTRAS;
  return {
    instalada: true,
    configurada: linha !== null,
    vigente,
    formulario: linha ? campos(linha) : { ...SUGESTAO_BUFFET_NOVO },
    versao: linha?.versao ?? null,
    historico: await historico(tx, empresaId),
  };
}

export async function salvarDescontosAdmin(tx: DbExecutor, tenant: TenantComprovado, raw: unknown, ctx: { requestId: string | null }): Promise<EstadoDescontos> {
  exigirGestaoNoTenant(tenant, GESTAO);
  const input = validarDescontos(raw);
  if (!await regrasPagamentoInstaladas(tx))
    erro("REGRAS_PAGAMENTO_INDISPONIVEL", "Os descontos por forma de pagamento ainda não estão disponíveis neste ambiente. Nada foi salvo.", 503);
  const empresaId = tenant.empresaComprovada;
  const conflito = () => erro("DESCONTOS_VERSAO", "Os descontos foram alterados por outra pessoa. Atualize a página e confira antes de salvar.", 409);
  const antes = await linhaDaEmpresa(tx, empresaId, true);
  if ((antes?.versao ?? null) !== input.versao) conflito();
  const novo: CamposDescontos = { pixAvistaPercentual: input.pixAvistaPercentual, pixParceladoPercentual: input.pixParceladoPercentual, cartaoRotulo: input.cartaoRotulo };
  const igual = antes && JSON.stringify(campos(antes)) === JSON.stringify(novo);
  if (!igual) {
    const gravada = antes
      ? (await tx.query<{ ok: number }>(
          `UPDATE public.empresa_regras_pagamento
              SET pix_avista_percentual = $2, pix_parcelado_percentual = $3, cartao_rotulo = $4, motivo = $5,
                  atualizado_em = GREATEST(clock_timestamp(), atualizado_em + interval '1 microsecond')
            WHERE empresa_id = $1::uuid AND atualizado_em::text = $6
        RETURNING 1 AS ok`,
          [empresaId, novo.pixAvistaPercentual, novo.pixParceladoPercentual, novo.cartaoRotulo, MOTIVO_TELA, antes.versao])).rows[0]
      : (await tx.query<{ ok: number }>(
          `INSERT INTO public.empresa_regras_pagamento
             (empresa_id, pix_avista_percentual, pix_parcelado_percentual, cartao_rotulo, desconto_dia_util, motivo)
           VALUES ($1::uuid, $2, $3, $4, false, $5)
           ON CONFLICT (empresa_id) DO NOTHING
        RETURNING 1 AS ok`,
          [empresaId, novo.pixAvistaPercentual, novo.pixParceladoPercentual, novo.cartaoRotulo, MOTIVO_TELA])).rows[0];
    if (!gravada) conflito();
    await auditarMutacaoComercial(tx, {
      usuarioId: tenant.usuarioId, requestId: ctx.requestId, acao: "REGRAS_PAGAMENTO_CONFIGURADAS", entidadeTipo: ENTIDADE_REGRAS_PAGAMENTO,
      entidadeId: empresaId, empresaId, antes: antes ? campos(antes) : null, depois: novo, motivo: MOTIVO_TELA,
    });
  }
  return lerDescontosAdmin(tx, tenant);
}
