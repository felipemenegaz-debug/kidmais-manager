import type { DbExecutor } from "../db/contracts.ts";
import type { Dia } from "./marcos.ts";
import { lerMarcosDoCliente } from "./marcos.ts";
import { itensDoCliente, MEDIDAS, montarLote, type Excecao, type Lote, type Medida, type Prazo, type TipoLote } from "./plano-lote.ts";

/**
 * Guarda fase 3 (20/11/2026): SIMULAÇÃO do lote mensal de anonimização. Só leitura e só contagens: nenhum nome, contato,
 * documento ou id de cliente sai daqui. Exige transação READ ONLY (recusa antes de ler qualquer cliente).
 *
 * Empresa apta = aceite dos Termos de uso com versão 2026-11-17 ou posterior (o DPA integra os Termos e é aceito junto,
 * lib/cadastro/documentos-legais.ts). Reaceite por documento assinado não tem tabela: empresa sem aceite no sistema sai
 * como não apta, com as contagens só para informação.
 * Cliente MESCLADO conta pelo principal (lerMarcosDoCliente já soma o grupo). Valor em aberto = pagamento do contrato
 * de qualquer cliente do grupo em AGUARDANDO_PAGAMENTO ou PARCIALMENTE_PAGO. A marca de disputa só nasce na fase 4:
 * aqui ela é sempre ausente (disputaMedida: false).
 */
export const VERSAO_TERMOS_MINIMA = "2026-11-17";
const STATUS_EM_ABERTO = ["AGUARDANDO_PAGAMENTO", "PARCIALMENTE_PAGO"];
const PRAZOS: readonly Prazo[] = ["CONTRATO", "CAMPANHAS", "INTERESSADO"];
const EXCECOES: readonly Excecao[] = ["VALOR_EM_ABERTO", "DISPUTA"];

export type ResumoEmpresa = {
  empresaId: string;
  apto: boolean;
  aceiteVersao: string | null;
  clientes: number;
  clientesAlcancados: number;
  itens: number;
  porMedida: Record<Medida, number>;
  porPrazo: Record<Prazo, number>;
  comExcecao: Record<Excecao, number>;
  porExecucao: Record<Dia, Record<Medida, number>>;
};
export type Simulacao = {
  lote: Lote;
  disputaMedida: false;
  empresas: ResumoEmpresa[];
  /** Só empresas aptas. */
  totais: { empresasAptas: number; empresasNaoAptas: number; clientesAlcancados: number; porMedida: Record<Medida, number>; comExcecao: Record<Excecao, number> };
};
export type OpcoesSimulacao = { aviso: Dia; tipo?: TipoLote; empresaId?: string };

const zeros = <K extends string>(ks: readonly K[]) => Object.fromEntries(ks.map((k) => [k, 0])) as Record<K, number>;

export async function simularLote(tx: DbExecutor, opcoes: OpcoesSimulacao): Promise<Simulacao> {
  const lote = montarLote(opcoes.tipo ?? "PRIMEIRA", opcoes.aviso);
  const ro = (await tx.query<{ ro: string }>(`/* guarda:simulacao-somente-leitura */ SELECT current_setting('transaction_read_only') AS ro`)).rows[0]?.ro;
  if (ro !== "on") throw new Error("a simulação da guarda só roda em transação READ ONLY");

  const empresas = (await tx.query<{ id: string; versao: string | null }>(
    `/* guarda:simulacao-empresas */
     SELECT e.id::text,
            (SELECT max(a.versao) FROM aceites_documentos_legais a
              WHERE a.empresa_id = e.id AND a.documento = 'TERMOS_USO' AND left(a.versao, 10) >= $2) AS versao
       FROM empresas e WHERE ($1::uuid IS NULL OR e.id = $1::uuid) ORDER BY e.id`,
    [opcoes.empresaId ?? null, VERSAO_TERMOS_MINIMA])).rows;

  const resumo: ResumoEmpresa[] = [];
  for (const e of empresas) {
    const clientes = (await tx.query<{ id: string }>(
      `/* guarda:simulacao-clientes */ SELECT id::text FROM clientes WHERE empresa_id = $1::uuid AND status IS DISTINCT FROM 'MESCLADO' ORDER BY id`,
      [e.id])).rows;
    const abertos = new Set((await tx.query<{ id: string }>(
      `/* guarda:simulacao-em-aberto */
       SELECT DISTINCT COALESCE(CASE WHEN c.status = 'MESCLADO' THEN c.cliente_principal_id END, c.id)::text AS id
         FROM pagamentos pg JOIN contrato_versoes v ON v.id = pg.contrato_versao_id
         JOIN contratos k ON k.id = v.contrato_id JOIN fechamentos f ON f.id = k.fechamento_id
         JOIN clientes c ON c.id = f.cliente_id
        WHERE c.empresa_id = $1::uuid AND pg.status = ANY($2::text[])`, [e.id, STATUS_EM_ABERTO])).rows.map((r) => r.id));
    const r: ResumoEmpresa = {
      empresaId: e.id, apto: e.versao !== null, aceiteVersao: e.versao, clientes: clientes.length, clientesAlcancados: 0, itens: 0,
      porMedida: zeros(MEDIDAS), porPrazo: zeros(PRAZOS), comExcecao: zeros(EXCECOES), porExecucao: {},
    };
    for (const c of clientes) {
      const m = await lerMarcosDoCliente(tx, e.id, c.id);
      if (!m) continue;
      const itens = itensDoCliente(m, lote, { valorEmAberto: abertos.has(c.id), disputa: false });
      if (itens.length === 0) continue;
      r.clientesAlcancados++;
      for (const i of itens) {
        r.itens++; r.porMedida[i.medida]++; r.porPrazo[i.prazo]++;
        for (const x of i.excecoes) r.comExcecao[x]++;
        (r.porExecucao[i.execucao] ??= zeros(MEDIDAS))[i.medida]++;
      }
    }
    r.porExecucao = Object.fromEntries(Object.entries(r.porExecucao).sort(([a], [b]) => (a < b ? -1 : 1)));
    resumo.push(r);
  }
  const aptas = resumo.filter((r) => r.apto);
  const totais = {
    empresasAptas: aptas.length, empresasNaoAptas: resumo.length - aptas.length,
    clientesAlcancados: aptas.reduce((s, r) => s + r.clientesAlcancados, 0),
    porMedida: zeros(MEDIDAS), comExcecao: zeros(EXCECOES),
  };
  for (const r of aptas) {
    for (const k of MEDIDAS) totais.porMedida[k] += r.porMedida[k];
    for (const k of EXCECOES) totais.comExcecao[k] += r.comExcecao[k];
  }
  return { lote, disputaMedida: false, empresas: resumo, totais };
}

/** Rascunho do aviso à empresa (texto, sem dados pessoais: só datas e contagens do lote). */
export function rascunhoDoAviso(r: ResumoEmpresa, lote: Lote): string {
  const dia = (d: Dia) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const linhas = [
    `Aviso de fim de prazo dos dados dos seus clientes (enviado em ${dia(lote.aviso)})`,
    "",
    "Pelo Acordo de Tratamento de Dados que você aceitou com os Termos de uso do iA.Fest, os dados dos clientes ficam guardados só pelo prazo de cada finalidade. Neste lote:",
  ];
  const datas = Object.entries(r.porExecucao);
  if (datas.length === 0) linhas.push("", "Nenhum cliente da sua empresa chega ao fim do prazo neste lote. Não é preciso fazer nada.");
  for (const [d, n] of datas) {
    const partes: string[] = [];
    if (n.ANONIMIZAR_TUDO) partes.push(`${n.ANONIMIZAR_TUDO} cliente(s) terão todos os dados anonimizados`);
    if (n.ELIMINAR_SO_CONTRATO) partes.push(`${n.ELIMINAR_SO_CONTRATO} cliente(s) terão contrato, PDFs e pagamentos eliminados (o contato fica)`);
    if (n.PARAR_CAMPANHA) partes.push(`${n.PARAR_CAMPANHA} cliente(s) sairão das campanhas e do atendimento (o contrato fica)`);
    linhas.push("", `Em ${dia(d)}: ${partes.join("; ")}.`);
  }
  if (r.comExcecao.VALOR_EM_ABERTO) linhas.push("", `${r.comExcecao.VALOR_EM_ABERTO} desses cliente(s) têm valor em aberto: contrato, pagamentos e dados de identificação ficam até o fim da cobrança.`);
  if (datas.length) linhas.push("",
    "Se algum desses clientes estiver em disputa (cobrança judicial, reclamação ou processo), informe no painel antes da data [tela da fase 4]: contrato, pagamentos e identificação ficam até o fim da disputa.",
    "A lista dos clientes alcançados fica no painel [tela da fase 4]. Este aviso não traz dados dos clientes.");
  return linhas.join("\n");
}
