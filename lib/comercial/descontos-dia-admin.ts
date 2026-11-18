import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import { exigirGestaoNoTenant } from "../saas/provar-tenant.ts";
import { empresaDonaDaConfigLegada } from "../disponibilidade/config-legada.ts";
import { auditarMutacaoComercial } from "./auditoria-comercial.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";
import { CODIGO_DESCONTO_DIA, rotuloDias, TETO_DESCONTO_DIA, tituloDescontoDia } from "./descontos-dia.ts";

/**
 * D3 do plano de descontos (18/11/2026): a Gestão do buffet configura UMA regra de desconto por dia da semana
 * (dias, percentual de 1 a 50, pacotes — todos por padrão — e a data a partir da qual vale), na mesma página da D1.
 *
 *   - Grava em `regras_desconto_pacote` (006), a tabela que a cotação do servidor já aplica: uma linha por pacote e
 *     dia, código `CODIGO_DESCONTO_DIA`, sem horário (vale para todos), prioridade 100. Sem migration.
 *   - Vigência pela DATA DA FESTA, como o resto do catálogo: "vale para festas a partir de" `inicio` (hoje ou depois,
 *     no fuso de São Paulo). A regra anterior é encerrada no dia anterior (`vigencia_fim`); regra que começaria depois
 *     é desativada (`ativo = false`). Nenhuma linha é apagada: fechamentos e revisões apontam para elas (FK RESTRICT).
 *   - Fechamentos já feitos guardam percentual e valores; revisões que não mudam pacote, data e horário mantêm o
 *     percentual gravado (`manterDescontoDoDia`, em lib/fechamentos/revisao-preco.ts). Nada aqui escreve em fechamento, condição ou contrato.
 *   - Percentual 0 = desligar a partir da data. Salvar igual ao que já vale não escreve nada.
 *   - Concorrência: trava consultiva por empresa + versão otimista (maior `atualizado_em` e quantidade das linhas).
 *   - Histórico pela `auditoria` (quem, quando, antes e depois), na mesma transação.
 *   - Kidmais continua pelo caminho atual (regras próprias da 006 e selo de segunda a quinta): a tela só mostra.
 */
export const ENTIDADE_DESCONTO_DIA = "EMPRESA_DESCONTO_DIA";
export const MOTIVO_TELA_DIA = "Configurações › Descontos e formas de pagamento › Desconto por dia da semana";
const GESTAO = "Somente a Gestão do buffet pode ver e alterar o desconto por dia da semana.";
const PRIORIDADE = 100;
const TRAVA_EXCLUSIVA = "SELECT pg_advisory_xact_lock(hashtextextended('descontos-dia:' || $1::text, 0))";
const TRAVA_COMPARTILHADA = "SELECT pg_advisory_xact_lock_shared(hashtextextended('descontos-dia:' || $1::text, 0))";
/** Até quando a data de início pode ir: dois anos, para evitar erro de digitação no ano. */
const MAX_DIAS_A_FRENTE = 730;

export type RegraDia = { dias: number[]; percentual: number; pacoteIds: string[]; inicio: string; fim: string | null };
export type PacoteOpcao = { id: string; codigo: string; nome: string };
export type ItemHistoricoDia = { em: string; por: string | null; texto: string };
export type EstadoDescontoDia =
  | { disponivel: false; motivo: "KIDMAIS" }
  | {
      disponivel: true;
      hoje: string;
      pacotes: PacoteOpcao[];
      /** A regra que vale para festas de hoje (pode já ter fim marcado, quando há outra agendada). */
      vigente: RegraDia | null;
      /** A última regra que começa depois de hoje (a que fica valendo), se houver. Agendamentos intermediários ficam no histórico. */
      agendada: RegraDia | null;
      /** Outras regras de dia da semana ativas nos pacotes (não criadas por esta tela). Continuam valendo. */
      outrasRegras: number;
      versao: string;
      historico: ItemHistoricoDia[];
    };
export type PedidoDescontoDia = { dias: number[]; percentual: number; pacoteIds: string[]; inicio: string; versao: string };

function erro(codigo: string, mensagem: string, status: number): never {
  throw new PacoteAdminError(codigo, mensagem, status);
}

/** AAAA-MM-DD que existe no calendário (Date.parse normaliza 2027-02-30 para 02/03; aqui isso é recusado). */
export function dataDeCalendario(iso: string): boolean {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validação do pedido (sem banco). Campo extra é recusado (lista fechada). */
export function validarDescontoDia(raw: unknown): PedidoDescontoDia {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) erro("DADOS_INVALIDOS", "Dados inválidos.", 400);
  const r = raw as Record<string, unknown>;
  const permitidos = new Set(["dias", "percentual", "pacoteIds", "inicio", "versao"]);
  if (Object.keys(r).some((k) => !permitidos.has(k))) erro("DADOS_INVALIDOS", "Dados inválidos.", 400);
  const n = typeof r.percentual === "string" && r.percentual.trim() !== "" ? Number(r.percentual.trim()) : r.percentual;
  if (typeof n !== "number" || !Number.isFinite(n)) erro("DESCONTO_INVALIDO", `Informe o desconto em número (0 a ${TETO_DESCONTO_DIA}).`, 400);
  if (!Number.isInteger(n)) erro("DESCONTO_INVALIDO", "O desconto precisa ser um número inteiro, sem casas decimais.", 400);
  if (n < 0) erro("DESCONTO_INVALIDO", "O desconto não pode ser negativo.", 400);
  if (n > TETO_DESCONTO_DIA) erro("DESCONTO_ACIMA_DO_TETO", `O desconto passa do limite de ${TETO_DESCONTO_DIA}%. Confira se não houve erro de digitação.`, 400);
  if (!Array.isArray(r.dias) || r.dias.length > 7 || r.dias.some((d) => !Number.isInteger(d) || (d as number) < 1 || (d as number) > 7))
    erro("DADOS_INVALIDOS", "Dados inválidos.", 400);
  const dias = [...new Set(r.dias as number[])].sort((a, b) => a - b);
  if (!Array.isArray(r.pacoteIds) || r.pacoteIds.length > 200 || r.pacoteIds.some((p) => typeof p !== "string" || !UUID.test(p)))
    erro("DADOS_INVALIDOS", "Dados inválidos.", 400);
  const pacoteIds = [...new Set((r.pacoteIds as string[]).map((p) => p.toLowerCase()))].sort();
  if (typeof r.inicio !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.inicio) || !dataDeCalendario(r.inicio))
    erro("INICIO_INVALIDO", "Informe a data a partir da qual o desconto vale.", 400);
  if (typeof r.versao !== "string" || r.versao.length > 80) erro("DADOS_INVALIDOS", "Dados inválidos.", 400);
  if (n > 0 && dias.length === 0) erro("DIAS_OBRIGATORIOS", "Escolha pelo menos um dia da semana.", 400);
  if (n > 0 && pacoteIds.length === 0) erro("PACOTES_OBRIGATORIOS", "Escolha pelo menos um pacote.", 400);
  // Desligar (0%) não guarda dias nem pacotes.
  return n === 0
    ? { dias: [], percentual: 0, pacoteIds: [], inicio: r.inicio, versao: r.versao }
    : { dias, percentual: n, pacoteIds, inicio: r.inicio, versao: r.versao };
}

/** `vigente`: revisão atual do pacote (032). Revisões antigas guardam cópia das regras; são encerradas junto, mas não aparecem. */
type LinhaRegra = { id: string; pacote_id: string; dia: number; percentual: string; titulo: string | null; inicio: string; fim: string | null; ativo: boolean; vigente: boolean };

async function ehKidmais(tx: DbExecutor, empresaId: string) {
  const codigo = (await tx.query<{ codigo: string }>("SELECT codigo FROM public.empresas WHERE id = $1::uuid", [empresaId])).rows[0]?.codigo;
  return codigo === "kidmais" || (await empresaDonaDaConfigLegada(tx)) === empresaId;
}

async function hojeSaoPaulo(tx: DbExecutor) {
  return (await tx.query<{ d: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0]!.d;
}

async function pacotesAtivos(tx: DbExecutor, empresaId: string): Promise<PacoteOpcao[]> {
  return (await tx.query<PacoteOpcao>(
    `SELECT id::text AS id, codigo, nome FROM public.pacotes WHERE empresa_id = $1::uuid AND ativo AND vigente ORDER BY ordem_exibicao, nome, id`,
    [empresaId])).rows;
}

async function versaoAtual(tx: DbExecutor, empresaId: string) {
  return (await tx.query<{ v: string }>(
    `SELECT coalesce(max(r.atualizado_em)::text, '-') || '|' || count(*)::text AS v
       FROM public.regras_desconto_pacote r JOIN public.pacotes p ON p.id = r.pacote_id
      WHERE p.empresa_id = $1::uuid AND r.codigo = $2`,
    [empresaId, CODIGO_DESCONTO_DIA])).rows[0]!.v;
}

/** Linhas desta tela (ativas ou não) dos pacotes da empresa. */
async function linhasDaTela(tx: DbExecutor, empresaId: string, travar: boolean): Promise<LinhaRegra[]> {
  return (await tx.query<LinhaRegra>(
    `SELECT r.id::text AS id, r.pacote_id::text AS pacote_id, r.dia_semana AS dia, r.percentual::text AS percentual, r.titulo,
            r.vigencia_inicio::text AS inicio, r.vigencia_fim::text AS fim, r.ativo, (p.ativo AND p.vigente) AS vigente
       FROM public.regras_desconto_pacote r JOIN public.pacotes p ON p.id = r.pacote_id
      WHERE p.empresa_id = $1::uuid AND r.codigo = $2 AND r.configuracao_agenda_id IS NULL
      ORDER BY r.vigencia_inicio, r.pacote_id, r.dia_semana${travar ? " FOR UPDATE OF r" : ""}`,
    [empresaId, CODIGO_DESCONTO_DIA])).rows;
}

/** Agrupa as linhas ativas em regras (mesmo início e fim). */
export function agruparRegras(linhas: readonly Pick<LinhaRegra, "pacote_id" | "dia" | "percentual" | "inicio" | "fim" | "ativo">[]): RegraDia[] {
  const grupos = new Map<string, RegraDia>();
  for (const l of linhas) {
    if (!l.ativo) continue;
    const chave = `${l.inicio}|${l.fim ?? ""}`;
    const g = grupos.get(chave) ?? { dias: [], percentual: 0, pacoteIds: [], inicio: l.inicio, fim: l.fim };
    if (!g.dias.includes(Number(l.dia))) g.dias.push(Number(l.dia));
    if (!g.pacoteIds.includes(l.pacote_id)) g.pacoteIds.push(l.pacote_id);
    g.percentual = Math.max(g.percentual, Number(l.percentual));
    grupos.set(chave, g);
  }
  return [...grupos.values()].map((g) => ({ ...g, dias: g.dias.sort((a, b) => a - b), pacoteIds: g.pacoteIds.sort() }))
    .sort((a, b) => (a.inicio < b.inicio ? -1 : a.inicio > b.inicio ? 1 : 0));
}

const dataBr = (iso: string) => iso.split("-").reverse().join("/");

/** Frase do histórico a partir do "depois" gravado na auditoria. */
export function textoDoHistorico(depois: { percentual?: number; dias?: number[]; inicio?: string; pacotes?: number; todosPacotes?: boolean }): string {
  const desde = depois.inicio ? ` para festas a partir de ${dataBr(depois.inicio)}` : "";
  if (!depois.percentual) return `Desconto por dia desligado${desde}`;
  const pacotes = depois.todosPacotes ? "todos os pacotes" : depois.pacotes === 1 ? "1 pacote" : `${depois.pacotes ?? 0} pacotes`;
  return `${depois.percentual}% ${rotuloDias(depois.dias ?? [])} · ${pacotes}${desde}`;
}

async function historico(tx: DbExecutor, empresaId: string): Promise<ItemHistoricoDia[]> {
  const linhas = (await tx.query<{ em: string; por: string | null; depois: Parameters<typeof textoDoHistorico>[0] }>(
    `SELECT a.criado_em::text AS em, u.nome AS por, a.dados_depois AS depois
       FROM auditoria a LEFT JOIN usuarios_administrativos u ON u.id = a.usuario_id
      WHERE a.entidade_tipo = $1 AND a.entidade_id = $2::uuid AND a.dados_depois->>'empresaId' = $2::text
      ORDER BY a.criado_em DESC, a.id DESC LIMIT 10`,
    [ENTIDADE_DESCONTO_DIA, empresaId])).rows;
  return linhas.map((l) => ({ em: l.em, por: l.por, texto: textoDoHistorico(l.depois) }));
}

async function outrasRegrasAtivas(tx: DbExecutor, empresaId: string, hoje: string) {
  return Number((await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM public.regras_desconto_pacote r JOIN public.pacotes p ON p.id = r.pacote_id
      WHERE p.empresa_id = $1::uuid AND p.ativo AND p.vigente AND r.ativo
        AND (r.codigo <> $2 OR r.configuracao_agenda_id IS NOT NULL)
        AND (r.vigencia_fim IS NULL OR r.vigencia_fim >= $3::date)`,
    [empresaId, CODIGO_DESCONTO_DIA, hoje])).rows[0]!.n);
}

export async function lerDescontoDiaAdmin(tx: DbExecutor, tenant: TenantComprovado): Promise<EstadoDescontoDia> {
  exigirGestaoNoTenant(tenant, GESTAO);
  const empresaId = tenant.empresaComprovada;
  if (await ehKidmais(tx, empresaId)) return { disponivel: false, motivo: "KIDMAIS" };
  // Leitura consistente com a gravação: a trava compartilhada espera um salvamento em andamento (que segura a trava
  // exclusiva até o commit), e a versão é lida ANTES das linhas. Se algo mudar entre as duas, a versão é a antiga e o
  // próximo salvamento recebe 409 — nunca dados antigos com versão nova.
  await tx.query(TRAVA_COMPARTILHADA, [empresaId]);
  const versao = await versaoAtual(tx, empresaId);
  const hoje = await hojeSaoPaulo(tx);
  const regras = agruparRegras((await linhasDaTela(tx, empresaId, false)).filter((l) => l.vigente && (l.fim === null || l.fim >= hoje)));
  return {
    disponivel: true,
    hoje,
    pacotes: await pacotesAtivos(tx, empresaId),
    vigente: [...regras].reverse().find((r) => r.inicio <= hoje) ?? null,
    agendada: [...regras].reverse().find((r) => r.inicio > hoje) ?? null,
    outrasRegras: await outrasRegrasAtivas(tx, empresaId, hoje),
    versao,
    historico: await historico(tx, empresaId),
  };
}

/** Conjunto (pacote|dia|percentual) que vale para festas na data `d`, e se há algo começando depois. */
function efeitoEm(linhas: readonly LinhaRegra[], d: string) {
  const ativas = linhas.filter((l) => l.ativo && l.vigente);
  const cobrem = ativas.filter((l) => l.inicio <= d && (l.fim === null || l.fim >= d));
  return {
    chaves: cobrem.map((l) => `${l.pacote_id}|${Number(l.dia)}|${Number(l.percentual)}`).sort(),
    temFim: cobrem.some((l) => l.fim !== null),
    depois: ativas.some((l) => l.inicio > d),
  };
}

async function regraUsada(tx: DbExecutor, id: string) {
  return (await tx.query<{ usada: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.fechamentos WHERE regra_desconto_pacote_id = $1::uuid)
         OR EXISTS (SELECT 1 FROM public.fechamento_revisoes WHERE regra_desconto_pacote_id = $1::uuid)
         OR EXISTS (SELECT 1 FROM public.fechamento_pacote_snapshots WHERE regra_desconto_pacote_id = $1::uuid) AS usada`,
    [id])).rows[0]!.usada;
}

export async function salvarDescontoDiaAdmin(tx: DbExecutor, tenant: TenantComprovado, raw: unknown, ctx: { requestId: string | null }): Promise<EstadoDescontoDia> {
  exigirGestaoNoTenant(tenant, GESTAO);
  const pedido = validarDescontoDia(raw);
  const empresaId = tenant.empresaComprovada;
  if (await ehKidmais(tx, empresaId))
    erro("DESCONTO_DIA_KIDMAIS", "A Kidmais continua com as regras de desconto atuais. Nada foi salvo.", 409);
  await tx.query(TRAVA_EXCLUSIVA, [empresaId]);
  const hoje = await hojeSaoPaulo(tx);
  if (pedido.inicio < hoje) erro("INICIO_NO_PASSADO", "A data de início não pode ser antes de hoje. Festas de datas passadas não mudam.", 400);
  const limite = new Date(Date.parse(`${hoje}T00:00:00Z`) + MAX_DIAS_A_FRENTE * 86_400_000).toISOString().slice(0, 10);
  if (pedido.inicio > limite) erro("INICIO_DISTANTE", "A data de início está muito longe (mais de dois anos). Confira o ano.", 400);
  const linhas = await linhasDaTela(tx, empresaId, true);
  if ((await versaoAtual(tx, empresaId)) !== pedido.versao)
    erro("DESCONTO_DIA_VERSAO", "O desconto por dia foi alterado por outra pessoa. Atualize a página e confira antes de salvar.", 409);
  const pacotes = await pacotesAtivos(tx, empresaId);
  const validos = new Set(pacotes.map((p) => p.id));
  if (pedido.pacoteIds.some((id) => !validos.has(id))) erro("PACOTE_INVALIDO", "Um dos pacotes escolhidos não existe mais. Atualize a página.", 400);

  const desejado = pedido.pacoteIds.flatMap((p) => pedido.dias.map((d) => `${p}|${d}|${pedido.percentual}`)).sort();
  const atual = efeitoEm(linhas, pedido.inicio);
  const regrasAntes = agruparRegras(linhas.filter((l) => l.vigente && (l.fim === null || l.fim >= hoje)));
  if (JSON.stringify(atual.chaves) === JSON.stringify(desejado) && !atual.temFim && !atual.depois)
    return lerDescontoDiaAdmin(tx, tenant);

  // 0) Antes de escrever: uma linha que começa na MESMA data e já foi usada por festa não pode mudar de percentual nem
  //    de texto, nem sair da regra (o fechamento e a cópia do pacote leem o título por ela). Vale para todas as linhas
  //    dessa data, não só para os pares pedidos agora. Recusa sem ter gravado nada.
  const titulo = tituloDescontoDia(pedido.percentual, pedido.dias);
  const pedidas = new Set(pedido.pacoteIds.flatMap((p) => pedido.dias.map((d) => `${p}|${d}`)));
  const mesmas = new Map<string, LinhaRegra & { usada: boolean }>();
  for (const l of linhas) {
    if (l.inicio !== pedido.inicio) continue;
    const chave = `${l.pacote_id}|${Number(l.dia)}`;
    const pedida = pedidas.has(chave);
    if (!pedida && !l.ativo) continue;
    const usada = await regraUsada(tx, l.id);
    const mantida = pedida && Number(l.percentual) === pedido.percentual && l.titulo === titulo;
    if (usada && !mantida)
      erro("DESCONTO_DIA_INICIO_USADO", `Já existe festa fechada com o desconto que começa em ${dataBr(pedido.inicio)}. Para mudar esse desconto, escolha outra data de início (a partir do dia seguinte). Nada foi salvo.`, 409);
    if (pedida) mesmas.set(chave, { ...l, usada });
  }
  // 1) Regra anterior termina no dia antes do novo início; 2) regra que começaria a partir dele sai de cena.
  await tx.query(
    `UPDATE public.regras_desconto_pacote SET vigencia_fim = $2::date - 1
      WHERE id = ANY($1::uuid[]) AND ativo AND vigencia_inicio < $2::date AND (vigencia_fim IS NULL OR vigencia_fim >= $2::date)`,
    [linhas.map((l) => l.id), pedido.inicio]);
  await tx.query(
    `UPDATE public.regras_desconto_pacote SET ativo = false WHERE id = ANY($1::uuid[]) AND ativo AND vigencia_inicio >= $2::date`,
    [linhas.map((l) => l.id), pedido.inicio]);
  // 3) Linhas novas. A chave única (pacote, dia, horário, código, início) pode já existir com o mesmo início:
  //    reaproveita a linha se nenhum fechamento a usa (ou se o percentual não muda); senão recusa sem gravar nada.
  for (const pacoteId of pedido.pacoteIds) for (const dia of pedido.dias) {
    const mesma = mesmas.get(`${pacoteId}|${dia}`);
    if (mesma) {
      const usada = mesma.usada;
      // Linha já usada por festa: percentual e título já são os pedidos (checado acima); só volta a valer.
      if (usada) await tx.query(`UPDATE public.regras_desconto_pacote SET ativo = true, vigencia_fim = NULL WHERE id = $1::uuid`, [mesma.id]);
      else await tx.query(
        `UPDATE public.regras_desconto_pacote SET percentual = $2, titulo = $3, ativo = true, vigencia_fim = NULL, observacoes = $4 WHERE id = $1::uuid`,
        [mesma.id, pedido.percentual, titulo, MOTIVO_TELA_DIA]);
    } else {
      await tx.query(
        `INSERT INTO public.regras_desconto_pacote
           (pacote_id, dia_semana, configuracao_agenda_id, percentual, base_calculo, codigo, titulo, prioridade, vigencia_inicio, vigencia_fim, ativo, observacoes)
         VALUES ($1::uuid, $2, NULL, $3, 'PACOTE', $4, $5, $6, $7::date, NULL, true, $8)`,
        [pacoteId, dia, pedido.percentual, CODIGO_DESCONTO_DIA, titulo, PRIORIDADE, pedido.inicio, MOTIVO_TELA_DIA]);
    }
  }
  await auditarMutacaoComercial(tx, {
    usuarioId: tenant.usuarioId, requestId: ctx.requestId, acao: "DESCONTO_DIA_CONFIGURADO", entidadeTipo: ENTIDADE_DESCONTO_DIA,
    entidadeId: empresaId, empresaId,
    antes: { regras: regrasAntes },
    depois: { percentual: pedido.percentual, dias: pedido.dias, pacoteIds: pedido.pacoteIds, pacotes: pedido.pacoteIds.length, todosPacotes: pedido.pacoteIds.length > 0 && pedido.pacoteIds.length === pacotes.length, inicio: pedido.inicio },
    motivo: MOTIVO_TELA_DIA,
  });
  return lerDescontoDiaAdmin(tx, tenant);
}
