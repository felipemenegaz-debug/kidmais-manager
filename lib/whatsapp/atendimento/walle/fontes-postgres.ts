import type { DbExecutor } from '../../../db/contracts.ts';
import { listarPacotesAdmin } from '../../../comercial/pacotes-admin.ts';
import { ARQUIVO_DISPONIVEL_SQL } from '../arquivos.ts';
import { calcularResumoComercial } from '../../../comercial/services/pricing.service.ts';
import { lerPrecosCorrentes } from '../../../comercial/pacote-precos.ts';
import { agendaPorEscopoInstalada, unidadesDaEmpresa, type EscopoAgenda } from '../../../disponibilidade/escopo.ts';
import { listarConfiguracoesAgendaAtivas } from '../../../disponibilidade/repositories/disponibilidade.repository.ts';
import { consultarDisponibilidadePeriodo } from '../../../disponibilidade/services/availability.service.ts';
import type { ConfiguracaoAtendimento } from '../core.ts';
import type { Finalidade } from '../prontas.ts';
import type { FontesWallE, PeriodoAgenda, PrecoAdicional, PrecoCalculado, ProntaAutorizada } from './resolver.ts';
import type { Catalogos, EscopoAgendaConsultado } from './tipos.ts';

/**
 * Fontes oficiais do Wall-e, sempre da EMPRESA da conversa (vinda do servidor, nunca do texto do cliente) e lidas na
 * hora: biblioteca PUBLICADA com envio automático autorizado, pacotes vigentes, composição do buffet e adicionais,
 * preço pela tabela vigente (serviço comercial), agenda real pelo serviço de disponibilidade (escopo da 062) e o link
 * protegido do contrato (CPF + código). Só leitura: nada aqui reserva data, cria cobrança ou altera cadastro.
 */
const somarDias = (iso: string, dias: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);

/** Unidades da empresa (não desativadas) para entender o cliente; as de agenda própria vêm da regra da 062. */
async function unidades(ex: DbExecutor, empresaId: string) {
  const r = await ex.query<{ id: string; nome: string }>("SELECT id::text AS id, nome FROM estabelecimentos WHERE empresa_id=$1::uuid AND status<>'DESATIVADO' ORDER BY nome, id", [empresaId]);
  return r.rows;
}
async function unidadesAgenda(ex: DbExecutor, empresaId: string) {
  return (await agendaPorEscopoInstalada(ex)) ? (await unidadesDaEmpresa(ex, empresaId)).map((u) => u.id) : [];
}
/**
 * Escopo da consulta e o que ele É, para a resposta não atribuir à unidade o que veio de outra agenda:
 *  - sem a 062: agenda única da instalação (GERAL);
 *  - unidade pedida com agenda própria (habilitada): a unidade (UNIDADE);
 *  - unidade pedida SEM agenda própria: a empresa inteira, todas as unidades (EMPRESA) — nunca a de outra unidade;
 *  - sem unidade pedida: a única unidade com agenda, se houver só uma; senão a empresa inteira.
 */
export async function escopoDaConsulta(ex: DbExecutor, empresaId: string, unidade: string | null): Promise<{ escopo: EscopoAgenda; consultado: EscopoAgendaConsultado }> {
  if (!(await agendaPorEscopoInstalada(ex))) return { escopo: { empresaId, estabelecimentoId: null }, consultado: { tipo: 'GERAL' } };
  const agenda = (await unidadesDaEmpresa(ex, empresaId)).map((u) => u.id);
  const alvo = unidade ? (agenda.includes(unidade) ? unidade : null) : agenda.length === 1 ? agenda[0] : null;
  return alvo ? { escopo: { empresaId, estabelecimentoId: alvo }, consultado: { tipo: 'UNIDADE', unidadeId: alvo } } : { escopo: { empresaId, estabelecimentoId: null }, consultado: { tipo: 'EMPRESA' } };
}
async function escopo(ex: DbExecutor, empresaId: string, unidade: string | null): Promise<EscopoAgenda> {
  return (await escopoDaConsulta(ex, empresaId, unidade)).escopo;
}
async function pacotesVigentes(ex: DbExecutor, empresaId: string) {
  return (await listarPacotesAdmin(ex, empresaId)).filter((p) => p.ativo && p.vigente && !p.arquivadoEm);
}

/** Nomes dos itens do buffet dos pacotes vigentes da empresa (mesma regra da composição), para reconhecer "tem coxinha?". */
async function itensBuffet(ex: DbExecutor, pacoteIds: string[]) {
  if (!pacoteIds.length) return [];
  const r = await ex.query<{ nome: string }>(
    `SELECT DISTINCT i.nome
       FROM pacote_buffet_categorias r
       JOIN buffet_categorias c ON c.id=r.categoria_id AND c.ativo
       JOIN buffet_itens i ON i.categoria_id=c.id AND i.ativo
            AND (r.modo_itens='TODOS_ATIVOS' OR EXISTS (SELECT 1 FROM pacote_buffet_itens x WHERE x.pacote_id=r.pacote_id AND x.categoria_id=c.id AND x.item_id=i.id))
      WHERE r.pacote_id = ANY($1::uuid[]) AND r.ativo
      ORDER BY i.nome LIMIT 300`, [pacoteIds]);
  return r.rows.map((x) => x.nome);
}

export async function catalogosWallE(ex: DbExecutor, empresaId: string, config: ConfiguracaoAtendimento, hoje: string): Promise<Catalogos> {
  const [pacotes, lista, agenda] = [await pacotesVigentes(ex, empresaId), await unidades(ex, empresaId), await unidadesAgenda(ex, empresaId)];
  const turnos = await listarConfiguracoesAgendaAtivas(ex, { empresaId, estabelecimentoId: agenda.length === 1 ? agenda[0] : null });
  const itens = await itensBuffet(ex, pacotes.map((p) => p.id));
  return {
    pacotes: pacotes.map((p) => ({ codigo: p.codigo, nome: p.nome })),
    unidades: lista,
    unidadesAgenda: agenda,
    turnos: turnos.map((t) => ({ codigo: t.codigo, nome: t.nome, inicio: t.horarioInicioPadrao.slice(0, 5), fim: t.horarioFimPadrao.slice(0, 5) })),
    // A resposta publicada também serve para reconhecer a pergunta pelas regras (não vai ao modelo).
    perguntas: config.perguntas.map((p) => ({ id: p.id, pergunta: p.pergunta, resposta: p.resposta })),
    itensBuffet: itens,
    hoje,
  };
}

const ERRO_PRECO: Record<string, Extract<PrecoCalculado, { erro: string }>['erro']> = {
  DADOS_INVALIDOS: 'ACIMA_CAPACIDADE', PACOTE_INDISPONIVEL: 'INDISPONIVEL', PACOTE_SOB_CONSULTA: 'SOB_CONSULTA',
};

/** `linkContratoProprio`: porta do link protegido (resolverLinkFechamento com os repositórios reais), montada por quem chama. */
export function fontesPostgres(ex: DbExecutor, alvo: { empresaId: string; ambiente: string; hoje: string; linkContratoProprio: () => Promise<string | null>; linkDisponibilidade?: string | null }): FontesWallE {
  const { empresaId, ambiente } = alvo;
  const periodos = (d: Awaited<ReturnType<typeof consultarDisponibilidadePeriodo>>[number]): PeriodoAgenda[] =>
    d.periodos.map((p) => ({ codigo: p.codigo, nome: p.nome, inicio: p.horarioInicioPadrao, fim: p.horarioFimPadrao, disponivel: p.status === 'DISPONIVEL' }));
  return {
    async prontasAutorizadas(finalidade: Finalidade) {
      const r = await ex.query<{ id: string; versao: string; titulo: string; tipo: ProntaAutorizada['tipo']; texto: string; link: string | null; midia_url: string | null; arquivo_id: string | null; arquivo_nome: string | null; finalidade: Finalidade; pacote_codigo: string | null; estabelecimento_id: string | null }>(
        `SELECT p.id, p.versao, p.titulo, p.tipo, p.texto, p.link, p.midia_url, p.arquivo_id, a.nome AS arquivo_nome, p.finalidade, p.pacote_codigo, p.estabelecimento_id::text AS estabelecimento_id
           FROM whatsapp_atendimento_mensagens_prontas p
           LEFT JOIN whatsapp_atendimento_arquivos a ON a.id=p.arquivo_id AND a.empresa_id=p.empresa_id AND a.ambiente=p.ambiente
          WHERE p.empresa_id=$1 AND p.ambiente=$2 AND p.finalidade=$3 AND p.estado='PUBLICADA' AND p.ativa AND p.envio_automatico
            -- M3 (12/10): com arquivo próprio, só se ele ainda pode ser servido e enviado (não revogado, não vencido).
            AND (p.arquivo_id IS NULL OR (a.id IS NOT NULL AND ${ARQUIVO_DISPONIVEL_SQL}))
            AND p.tipo IN ('TEXTO','LINK','IMAGEM','VIDEO','DOCUMENTO')
          ORDER BY CASE p.tipo WHEN 'TEXTO' THEN 0 WHEN 'LINK' THEN 1 WHEN 'DOCUMENTO' THEN 2 ELSE 3 END, p.titulo, p.id LIMIT 20`, [empresaId, ambiente, finalidade]);
      return r.rows.map((p) => ({ id: p.id, versao: Number(p.versao), titulo: p.titulo, tipo: p.tipo, texto: p.texto, link: p.link, midiaUrl: p.midia_url, arquivoId: p.arquivo_id, arquivoNome: p.arquivo_nome, finalidade: p.finalidade, pacoteCodigo: p.pacote_codigo, unidadeId: p.estabelecimento_id }));
    },
    async pacotes() {
      return (await pacotesVigentes(ex, empresaId)).map((p) => ({ id: p.id, codigo: p.codigo, nome: p.nome, descricao: p.descricao, duracaoMinutos: p.duracaoMinutos, convidadosMinimos: p.convidadosMinimos, convidadosMaximos: p.convidadosMaximos }));
    },
    async composicao(codigo: string) {
      const pacote = (await pacotesVigentes(ex, empresaId)).find((p) => p.codigo === codigo);
      if (!pacote) return null;
      // Mesma regra do formulário do cliente (escolhas-buffet.service): categoria ativa, item ativo, todos ou só os selecionados.
      const buffet = await ex.query<{ categoria: string; escolhas_min: number; escolhas_max: number; itens: string[] | null }>(
        `SELECT c.nome AS categoria, r.escolhas_min, r.escolhas_max,
                array_agg(i.nome ORDER BY i.ordem_exibicao, i.nome) FILTER (WHERE i.id IS NOT NULL) AS itens
           FROM pacote_buffet_categorias r
           JOIN buffet_categorias c ON c.id=r.categoria_id AND c.ativo
           LEFT JOIN buffet_itens i ON i.categoria_id=c.id AND i.ativo
                AND (r.modo_itens='TODOS_ATIVOS' OR EXISTS (SELECT 1 FROM pacote_buffet_itens x WHERE x.pacote_id=r.pacote_id AND x.categoria_id=c.id AND x.item_id=i.id))
          WHERE r.pacote_id=$1::uuid AND r.ativo
          GROUP BY c.id, c.nome, c.ordem_exibicao, r.escolhas_min, r.escolhas_max
          ORDER BY c.ordem_exibicao, c.nome`, [pacote.id]);
      const adicionais = await ex.query<{ id: string; nome: string; categoria: string; modalidade: 'INCLUSO' | 'EXTRA' }>(
        `SELECT a.id::text AS id, a.nome, a.categoria, pa.modalidade
           FROM pacote_adicionais pa JOIN adicionais a ON a.id=pa.adicional_id
          WHERE pa.pacote_id=$1::uuid AND pa.ativo AND a.ativo AND pa.modalidade IN ('INCLUSO','EXTRA') AND (a.empresa_id IS NULL OR a.empresa_id=$2::uuid)
          ORDER BY a.ordem_exibicao, a.nome`, [pacote.id, empresaId]);
      return {
        categorias: buffet.rows.map((c) => ({ nome: c.categoria, escolhasMin: Number(c.escolhas_min), escolhasMax: Number(c.escolhas_max), itens: c.itens ?? [] })),
        inclusos: adicionais.rows.filter((a) => a.modalidade === 'INCLUSO').map((a) => ({ id: a.id, nome: a.nome, categoria: a.categoria })),
        extras: adicionais.rows.filter((a) => a.modalidade === 'EXTRA').map((a) => ({ id: a.id, nome: a.nome, categoria: a.categoria })),
      };
    },
    /**
     * Teste manual de 12/10/2026: preço do adicional na tabela VIGENTE da empresa (precos_adicional, a mesma leitura da tela
     * de preços). Sem linha: SEM_PRECO (nada é suposto). Faixas por número de convidados: sem o número, PRECISA_CONVIDADOS;
     * com ele e sem faixa que o contenha, SEM_PRECO.
     */
    async precoAdicional(adicionalId, convidados): Promise<PrecoAdicional> {
      const correntes = await lerPrecosCorrentes(ex, empresaId);
      const faixas = correntes.adicionais.filter((a) => a.adicionalId === adicionalId);
      if (!faixas.length) return { erro: 'SEM_PRECO' };
      const unidade = (await ex.query<{ unidade_cobranca: string }>('SELECT unidade_cobranca FROM adicionais WHERE id=$1::uuid AND (empresa_id IS NULL OR empresa_id=$2::uuid)', [adicionalId, empresaId])).rows[0]?.unidade_cobranca ?? null;
      const unica = faixas.length === 1 && faixas[0].min <= 1 && faixas[0].max === null;
      if (!unica && convidados == null) return { erro: 'PRECISA_CONVIDADOS' };
      const faixa = unica ? faixas[0] : faixas.find((f) => f.min <= convidados! && (f.max === null || convidados! <= f.max));
      if (!faixa) return { erro: 'SEM_PRECO' };
      return { valor: faixa.valor, unidade, faixa: unica ? null : { min: faixa.min, max: faixa.max }, tabela: correntes.tabelaId };
    },
    async preco(codigo, data, turno, convidados): Promise<PrecoCalculado> {
      const pacote = (await pacotesVigentes(ex, empresaId)).find((p) => p.codigo === codigo);
      const config = (await listarConfiguracoesAgendaAtivas(ex, await escopo(ex, empresaId, null))).find((c) => c.codigo === turno);
      if (!pacote || !config) return { erro: 'FALHA' };
      if (pacote.convidadosMaximos !== null && convidados > pacote.convidadosMaximos) return { erro: 'ACIMA_CAPACIDADE', maximo: pacote.convidadosMaximos };
      try {
        const r = await calcularResumoComercial({ data, configuracaoAgendaId: config.id, pacoteId: pacote.id, convidados, empresaId, adicionais: [], empresaEsperada: empresaId }, ex);
        return {
          valor: r.valorTabelaPacoteAplicado, convidadosFaturados: r.pacote.convidadosFaturados, minimoAplicado: r.pacote.minimoFaturavelAplicado,
          desconto: r.pacote.desconto.aplicado ? { percentual: r.pacote.desconto.percentual, titulo: r.pacote.desconto.titulo } : null,
          tabela: { id: r.pacote.tabelaPreco.id, codigo: r.pacote.tabelaPreco.codigo, nome: r.pacote.tabelaPreco.nome },
        };
      } catch (erro) {
        const codigoErro = (erro as { code?: string }).code ?? '';
        return { erro: ERRO_PRECO[codigoErro] ?? 'FALHA', maximo: pacote.convidadosMaximos };
      }
    },
    async disponibilidade(data, unidade) {
      const { escopo: e, consultado } = await escopoDaConsulta(ex, empresaId, unidade);
      const [dia] = await consultarDisponibilidadePeriodo(data, data, ex, undefined, e);
      return { periodos: periodos(dia), escopo: consultado };
    },
    async alternativas(data, unidade, turno, quantas) {
      const inicio = data > alvo.hoje ? (somarDias(data, -7) > alvo.hoje ? somarDias(data, -7) : alvo.hoje) : alvo.hoje;
      const dias = await consultarDisponibilidadePeriodo(inicio, somarDias(data, 28), ex, undefined, await escopo(ex, empresaId, unidade));
      const distancia = (d: string) => Math.abs(Date.parse(d) - Date.parse(data));
      return dias.filter((d) => d.data !== data).map((d) => ({ data: d.data, periodos: periodos(d).filter((p) => p.disponivel && (!turno || p.codigo === turno)) }))
        .filter((d) => d.periodos.length).sort((a, b) => distancia(a.data) - distancia(b.data) || a.data.localeCompare(b.data)).slice(0, quantas)
        .sort((a, b) => a.data.localeCompare(b.data));
    },
    linkContratoProprio: alvo.linkContratoProprio,
    linkDisponibilidade: () => alvo.linkDisponibilidade ?? null,
  };
}
