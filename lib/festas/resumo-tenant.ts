import type { DbExecutor } from "../db/contracts.ts";
import { camposBuffet, escolhasEfetivas, type EscolhaBuffet } from "./buffet.ts";
import { nomeComoDado, normalizarParaBusca } from "../integracoes/mcp/nome-exibivel.ts";

/**
 * Etapa 0b do MCP (18/11/2026): leitura de UMA festa pelo nome, presa à empresa COMPROVADA (empresaId vem sempre do
 * tenant provado a partir do token; nunca do texto pedido pelo assistente). Só leitura: nenhuma escrita, nenhum efeito.
 *
 * Mesmo predicado de tenant de `leitura-tenant.ts` (festa → contrato → fechamento da empresa → pacote da empresa) e a
 * mesma regra de acesso de `consultarFestas`: capacidade FESTA_CONSULTAR da MEMBERSHIP comprovada nesta empresa.
 * Não devolve CPF, telefone, e-mail, endereço, data de nascimento nem textos livres (descrições de pendências, títulos de
 * tarefas, escolhas de buffet): só nomes EXIBÍVEIS (aniversariante e cliente), datas, horários e CONTAGENS.
 */
export type FestaEncontrada = {
  festaId: string;
  contratoId: string;
  data: string;
  horaInicio: string;
  horaFim: string | null;
  /** Nome EXIBÍVEL (nomeComoDado) ou null: o bruto nunca sai deste módulo. */
  aniversariante: string | null;
  /** Nome EXIBÍVEL (nomeComoDado) ou null. */
  cliente: string | null;
  convidados: number;
  contratoStatus: string;
};

export type ContagemPrioridade = { critica: number; atencao: number; normal: number; comPrazoVencido: number };

export type ResumoOperacionalFesta = {
  pendenciasAbertas: ContagemPrioridade;
  tarefasPendentes: ContagemPrioridade;
  /** null = sem contrato vigente legível (buffet não avaliado). */
  buffetCamposSemDefinicao: number | null;
};

/** Capacidade de Festa da membership comprovada (056). Sem ela, nada de festa sai por este canal. */
export async function membershipPodeConsultarFestas(tx: DbExecutor, empresaId: string, membershipId: string): Promise<boolean> {
  const r = await tx.query(
    "SELECT 1 FROM festa_membership_capacidades WHERE membership_id = $1::uuid AND empresa_id = $2::uuid AND capacidade = 'FESTA_CONSULTAR' AND revogado_em IS NULL LIMIT 1",
    [membershipId, empresaId],
  );
  return r.rows.length > 0;
}

/**
 * r3 (19/11/2026): teto de festas ATIVAS da empresa (no dia, quando há data) conferidas numa busca. O SQL não filtra
 * por nome: traz as festas ativas da empresa e o JavaScript decide sobre o nome EXIBÍVEL. Assim o teto depende só do
 * tamanho da agenda da empresa, nunca do termo nem do conteúdo omitido dos nomes (a r2 filtrava no SQL pelo nome cru, e
 * bater ou não no teto revelava o que estava omitido). Também elimina a diferença de `lower()` por collation do banco.
 */
export const BUSCA_TETO_EMPRESA = 10_000;

/** Só letras, marcas, espaço, apóstrofo, ponto e hífen: o termo que tiver outra coisa não existe em nome exibível. */
const TERMO_POSSIVEL = /^[\p{L}\p{M} '’.\-]+$/u;

/** Termo na forma de comparação (`normalizarParaBusca`); null = nunca acha nada (r4: ainda passa pelo teto, para a recusa não depender do termo). */
export function termoDeBuscaPorNome(nome: string): string | null {
  const base = normalizarParaBusca(nome);
  if (!base || !TERMO_POSSIVEL.test(base)) return null;
  return base;
}

type LinhaFesta = {
  id: string; contrato_id: string; data: string; hora: string; hora_fim: string | null; aniversariante: string | null;
  cliente: string | null; convidados: number; status: string;
};

/**
 * `incompleto` = a empresa tem mais de BUSCA_TETO_EMPRESA festas ativas no recorte (todas, ou as do dia): nada é
 * conferido e quem chama recusa BUSCA_AMPLA. Depende só do tamanho da agenda, nunca do termo; `festas` vem vazio.
 */
export type BuscaFestas = { festas: FestaEncontrada[]; incompleto: boolean };

/**
 * Festas da empresa cujo nome EXIBÍVEL do aniversariante OU do cliente contém o termo (sem diferenciar maiúsculas e
 * acentos). O termo é comparado só com o que pode sair: um termo que só existe na parte omitida (contato, documento,
 * dígitos, endereço) não encontra nada, e o nome omitido nunca confirma a existência da festa. Canceladas e invalidadas
 * ficam fora. O aniversariante só conta se for do MESMO cliente do fechamento (cliente já preso à empresa). `data`
 * opcional restringe ao dia. Ordem: da mais próxima de `hoje` para a mais distante, desempate estável por id. Devolve até
 * `limite` festas (quem chama pede limite + 1 para truncar). r3: o SQL não filtra por nome (ver BUSCA_TETO_EMPRESA).
 */
export async function festasPorNome(
  tx: DbExecutor, empresaId: string, nome: string, data: string | null, hoje: string, limite: number,
  /** Só o teste PG passa outro valor (provar o teto sem criar 10 mil festas); a rota usa sempre o padrão. */
  teto: number = BUSCA_TETO_EMPRESA,
): Promise<BuscaFestas> {
  const procurado = termoDeBuscaPorNome(nome);
  // r4: o termo impossível também passa pelo teto (a recusa acima do teto é a mesma para qualquer termo).
  const r = await tx.query<LinhaFesta>(
    `SELECT festa.id::text AS id, contrato.id::text AS contrato_id, fech.data_evento::text AS data,
            fech.horario_inicio::text AS hora, fech.horario_fim::text AS hora_fim,
            aniv.nome AS aniversariante, cliente.nome_completo AS cliente,
            fech.convidados, contrato.status AS status
       FROM festas festa
       JOIN contratos contrato ON contrato.id = festa.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id AND fech.empresa_id = $1::uuid
       JOIN pacotes pac ON pac.id = fech.pacote_id AND pac.empresa_id = $1::uuid
       LEFT JOIN clientes cliente ON cliente.id = fech.cliente_id AND cliente.empresa_id = $1::uuid
       LEFT JOIN aniversariantes aniv ON aniv.id = fech.aniversariante_id AND aniv.cliente_id = cliente.id
      WHERE festa.invalidada_em IS NULL
        AND contrato.status <> 'CANCELADO'
        AND ($2::date IS NULL OR fech.data_evento = $2::date)
      ORDER BY abs(fech.data_evento - $3::date), fech.data_evento, festa.id
      LIMIT $4`,
    [empresaId, data, hoje, teto + 1],
  );
  // Decidido ANTES de conferir qualquer nome: o teto não depende do termo nem de quantas candidatas já casaram.
  if (r.rows.length > teto) return { festas: [], incompleto: true };
  if (procurado === null) return { festas: [], incompleto: false };
  const contem = (exibivel: string | null) => exibivel !== null && normalizarParaBusca(exibivel).includes(procurado);
  const festas: FestaEncontrada[] = [];
  for (const l of r.rows) {
    const aniversariante = nomeComoDado(l.aniversariante);
    const cliente = nomeComoDado(l.cliente);
    if (!contem(aniversariante) && !contem(cliente)) continue;
    festas.push({
      festaId: l.id,
      contratoId: l.contrato_id,
      data: l.data,
      horaInicio: String(l.hora ?? "").slice(0, 5),
      horaFim: l.hora_fim ? String(l.hora_fim).slice(0, 5) : null,
      aniversariante,
      cliente,
      convidados: Number(l.convidados),
      contratoStatus: l.status,
    });
    if (festas.length >= limite) break;
  }
  return { festas, incompleto: false };
}

type LinhaContagem = { tipo: "P" | "T"; prioridade: string; n: number; vencidas: number };

/**
 * Contagens operacionais de UMA festa já encontrada na empresa (o id vem de `festasPorNome`, nunca do assistente).
 * Pendência aberta = ABERTA/EM_TRATAMENTO; tarefa pendente = PENDENTE (mesmas regras do Copiloto). Prazo vencido =
 * data do prazo em Brasília anterior a `hoje`. Buffet: campos do pacote e adicionais da versão vigente sem definição
 * efetiva (operacional ou contratada), a mesma regra da tela da festa.
 */
export async function resumoOperacionalDaFesta(tx: DbExecutor, empresaId: string, festaId: string, hoje: string): Promise<ResumoOperacionalFesta> {
  // Prende a festa à empresa de novo (defesa em profundidade: o id nunca atravessa empresas).
  const dono = await tx.query<{ snapshot: unknown }>(
    `SELECT ver.snapshot
       FROM festas festa
       JOIN contratos contrato ON contrato.id = festa.contrato_id
       JOIN fechamentos fech ON fech.id = contrato.fechamento_id AND fech.empresa_id = $1::uuid
       LEFT JOIN contrato_fluxos fluxo ON fluxo.contrato_id = contrato.id
       LEFT JOIN contrato_versoes ver ON ver.id = fluxo.versao_vigente_id
      WHERE festa.id = $2::uuid AND festa.invalidada_em IS NULL`,
    [empresaId, festaId],
  );
  if (!dono.rows.length) throw Object.assign(new Error("Festa fora da empresa."), { httpStatus: 404 });
  const linhas = (await tx.query<LinhaContagem>(
    `SELECT 'P' AS tipo, prioridade, count(*)::int AS n,
            count(*) FILTER (WHERE prazo IS NOT NULL AND (prazo AT TIME ZONE 'America/Sao_Paulo')::date < $2::date)::int AS vencidas
       FROM festa_pendencias WHERE festa_id = $1::uuid AND estado IN ('ABERTA','EM_TRATAMENTO') GROUP BY prioridade
     UNION ALL
     SELECT 'T' AS tipo, prioridade, count(*)::int AS n,
            count(*) FILTER (WHERE prazo IS NOT NULL AND (prazo AT TIME ZONE 'America/Sao_Paulo')::date < $2::date)::int AS vencidas
       FROM festa_tarefas WHERE festa_id = $1::uuid AND estado = 'PENDENTE' GROUP BY prioridade`,
    [festaId, hoje],
  )).rows;
  const vazio = (): ContagemPrioridade => ({ critica: 0, atencao: 0, normal: 0, comPrazoVencido: 0 });
  const pendenciasAbertas = vazio();
  const tarefasPendentes = vazio();
  for (const l of linhas) {
    const alvo = l.tipo === "P" ? pendenciasAbertas : tarefasPendentes;
    const n = Number(l.n);
    if (l.prioridade === "CRITICA") alvo.critica += n;
    else if (l.prioridade === "ATENCAO") alvo.atencao += n;
    else alvo.normal += n;
    alvo.comPrazoVencido += Number(l.vencidas);
  }
  return { pendenciasAbertas, tarefasPendentes, buffetCamposSemDefinicao: await buffetSemDefinicao(tx, festaId, dono.rows[0].snapshot) };
}

async function buffetSemDefinicao(tx: DbExecutor, festaId: string, snapshotBruto: unknown): Promise<number | null> {
  const snapshot = snapshotBruto as { evento?: { pacote?: { codigo?: unknown } }; contratacao?: { buffet?: Partial<Record<EscolhaBuffet, string | null>>; adicionais?: Array<{ adicionalId?: unknown; quantidade?: unknown }> } } | null;
  const pacote = snapshot?.evento?.pacote?.codigo;
  if (typeof pacote !== "string") return null;
  const ids = (snapshot?.contratacao?.adicionais ?? [])
    .filter((a) => typeof a.adicionalId === "string" && Number(a.quantidade) > 0)
    .map((a) => a.adicionalId as string);
  const codigos = ids.length ? (await tx.query<{ codigo: string }>("SELECT codigo FROM adicionais WHERE id = ANY($1::uuid[])", [ids])).rows.map((r) => r.codigo) : [];
  const operacional = (await tx.query<Partial<Record<EscolhaBuffet, string | null>>>(
    "SELECT salgados, doces, bolo, bebidas, lembrancinha, empratado, bombom FROM festa_buffet WHERE festa_id = $1::uuid", [festaId],
  )).rows[0] ?? null;
  const valores = escolhasEfetivas(snapshot?.contratacao?.buffet ?? {}, operacional);
  return camposBuffet(pacote, codigos).filter((c) => !String(valores[c] ?? "").trim()).length;
}
