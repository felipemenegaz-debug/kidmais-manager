import type { DbExecutor } from '../db/contracts.ts';
import { escolherSalaoParaEmissao, escopoPorSalao } from '../agenda/salao-festa.ts';
import { travarConfiguracaoAgenda } from '../agenda/trava-configuracao.ts';
import { recursoIncluido } from '../assinatura/recursos-plano.ts';
import { lerEstadoComercial } from '../assinatura/estado.ts';
import { CondicaoPagamentoError, type CondicaoPagamento } from '../comercial/condicao-pagamento.ts';
import { PacoteAdminError } from '../comercial/pacotes-admin.ts';
import { valorFinalContrato } from '../contratos/services/snapshot-core.ts';
import { adquirirLockConfirmacaoAgenda, verificarConflitoAgendaParaConfirmacao } from '../disponibilidade/repositories/disponibilidade.repository.ts';
import { normalizarChavePix, textoBrCode, type TipoChavePix } from '../pagamentos/pix/brcode.ts';
import { pixInstalado, recebedorDoPerfil } from '../pagamentos/pix/recebimento.ts';
import { exigirSessaoMeuPedido, type SessaoMeuPedido } from './acesso-pedido.ts';
import { auditarMovimentoPreReserva } from './auditoria.ts';
import {
  assinaturaDaOferta, avaliarOferta, destinoDoAceiteConfere, montarPixDoAceite, apresentarAceite, apresentarSituacao,
  retratoDoRecebedor, sinalJaConferido,
  type AceiteDoPedido, type RecebedorDaOferta, type SituacaoDoSinal,
} from './apresentacao-familia.ts';
import { desistirDaGarantia } from './desistencia.ts';
import { TERMOS_PRE_RESERVA, VERSAO_TERMOS_PRE_RESERVA } from './termos.ts';

export async function exigirSchemaMeuPedido(tx: DbExecutor) {
  const { rows: [r] } = await tx.query<{ instalada: boolean }>(`SELECT
    to_regclass('public.pre_reserva_configuracoes') IS NOT NULL
    AND to_regclass('public.pre_reserva_aceites') IS NOT NULL
    AND to_regclass('public.pre_reserva_recebimentos') IS NOT NULL
    AND to_regclass('public.pre_reserva_situacoes') IS NOT NULL
    AND to_regprocedure('public.pre_reserva_exigir_configuracao()') IS NOT NULL
    AND EXISTS (SELECT FROM pg_trigger WHERE tgrelid=to_regclass('public.pre_reserva_aceites')
      AND tgname='a131_config_antes_do_aceite' AND tgenabled IN ('O','A')) AS instalada`);
  if (!r?.instalada) throw new PacoteAdminError('PRE_RESERVA_INDISPONIVEL', 'Meu pedido está indisponível no momento.', 503);
}

type Pedido = {
  id: string;
  status: string;
  data: string;
  inicio: string;
  fim: string;
  inicioEvento: string;
  fimEvento: string;
  estabelecimentoId: string | null;
  unidadeNome: string | null;
  salaoId: string | null;
  salaoNome: string | null;
  valorAprovado: string | null;
  valorTabela: string;
  condicaoPagamento: CondicaoPagamento | null;
};

async function lerPedidosDoTitular(tx: DbExecutor, sessao: SessaoMeuPedido, pedido: string | null, trava?: 'UPDATE' | 'SHARE') {
  const { rows } = await tx.query<Pedido>(`SELECT f.id, f.status, f.data_evento::text AS data,
    f.horario_inicio::text AS inicio, f.horario_fim::text AS fim,
    to_char((f.data_evento + f.horario_inicio) AT TIME ZONE 'America/Sao_Paulo' AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "inicioEvento",
    to_char((f.data_evento + f.horario_fim) AT TIME ZONE 'America/Sao_Paulo' AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "fimEvento",
    f.estabelecimento_id AS "estabelecimentoId", u.nome AS "unidadeNome", s.id AS "salaoId", s.nome AS "salaoNome",
    f.valor_aprovado AS "valorAprovado", f.valor_tabela AS "valorTabela", f.condicao_pagamento AS "condicaoPagamento"
    FROM fechamentos f
    LEFT JOIN estabelecimentos u ON (u.empresa_id,u.id)=(f.empresa_id,f.estabelecimento_id)
    LEFT JOIN agenda_saloes s ON (s.empresa_id,s.id)=(f.empresa_id,coalesce(f.salao_id,f.salao_preferido_id))
    WHERE f.empresa_id=$1 AND f.cliente_id=$2 AND ($3::uuid IS NULL OR f.id=$3)
    ORDER BY f.iniciado_em DESC, f.id${trava ? ` FOR ${trava} OF f` : ''}`, [sessao.empresaId, sessao.clienteId, pedido]);
  return rows;
}

async function lerPedidoDoTitular(tx: DbExecutor, sessao: SessaoMeuPedido, pedido: string, trava?: 'UPDATE' | 'SHARE') {
  const [alvo] = await lerPedidosDoTitular(tx, sessao, pedido, trava);
  exigirSessaoMeuPedido(sessao, sessao.empresaId);
  if (!alvo) throw new PacoteAdminError('PEDIDO_INDISPONIVEL', 'Pedido não encontrado.', 404);
  return alvo;
}

const CAMPOS_ACEITE = `sequencia, sinal_centavos AS "sinalCentavos", preco_aceito_centavos::text AS "precoCentavos",
  estabelecimento_id AS "estabelecimentoId", salao_id AS "salaoId",
  to_char(inicio_evento AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "inicioEvento",
  to_char(fim_evento AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "fimEvento",
  recebedor, chave_pix AS chave, termos_versao AS "termosVersao",
  termos_aceitos AS "termosAceitos", aceito_em AS "aceitoEm"`;

async function lerAceiteESinais(tx: DbExecutor, sessao: SessaoMeuPedido, pedido: string) {
  const params = [sessao.empresaId, sessao.clienteId, pedido];
  const { rows: [aceite] } = await tx.query<AceiteDoPedido>(`SELECT ${CAMPOS_ACEITE},
    (SELECT s.nome FROM agenda_saloes s WHERE (s.empresa_id,s.id)=(a.empresa_id,a.salao_id)) AS "salaoNome"
    FROM pre_reserva_aceites a
    WHERE empresa_id=$1 AND cliente_id=$2 AND fechamento_id=$3 ORDER BY sequencia DESC LIMIT 1`, params);
  const { rows: sinais } = await tx.query<SituacaoDoSinal>(`SELECT s.garantia, s.garantia_ate AS "garantiaAte",
    s.dinheiro, s.valor_centavos::text AS "valorCentavos", s.devolver_desde AS "devolverDesde",
    r.aceite_sequencia AS "aceiteSequencia", r.motivo_sem_garantia AS "motivoSemGarantia"
    FROM pre_reserva_situacoes s JOIN pre_reserva_recebimentos r USING (empresa_id,end_to_end_id)
    JOIN fechamentos f ON (f.empresa_id,f.id)=(s.empresa_id,s.fechamento_id)
    WHERE f.empresa_id=$1 AND f.cliente_id=$2 AND f.id=$3 ORDER BY r.confirmado_em, r.end_to_end_id`, params);
  return { aceite: aceite ?? null, sinais };
}

async function configuracaoDaOferta(tx: DbExecutor, empresaId: string, travar: boolean) {
  const { rows: [piloto] } = await tx.query<{ habilitada: boolean; sinalCentavos: number }>(
    `SELECT habilitada, sinal_centavos AS "sinalCentavos" FROM pre_reserva_configuracoes WHERE empresa_id=$1${travar ? ' FOR SHARE' : ''}`,
    [empresaId]);
  const habilitada = piloto?.habilitada ?? false;
  const orcamentoOnline = habilitada && await recursoIncluido(tx, empresaId, 'ORCAMENTO_ONLINE');
  const escritaPermitida = orcamentoOnline && (await lerEstadoComercial(tx, empresaId)).acesso.nivel === 'COMPLETO';
  let recebedor: RecebedorDaOferta | null = null;
  if (escritaPermitida && await pixInstalado(tx)) {
    const { rows: [config] } = await tx.query<{ tipo: TipoChavePix; chave: string; nome: string; cidade: string }>(
      `SELECT tipo_chave AS tipo, chave, nome_recebedor AS nome, cidade_recebedor AS cidade
       FROM empresa_pix_recebimento WHERE empresa_id=$1${travar ? ' FOR SHARE' : ''}`, [empresaId]);
    if (config && normalizarChavePix(config.tipo, config.chave)?.chave === config.chave) {
      const perfil = await recebedorDoPerfil(tx, empresaId);
      const nome = perfil.nome || textoBrCode(config.nome, 25);
      const cidade = perfil.cidade || textoBrCode(config.cidade, 15);
      if (nome && cidade) recebedor = { nome, cidade, chave: config.chave };
    }
  }
  return { habilitada, orcamentoOnline, escritaPermitida, recebedor, sinalConfigurado: piloto?.sinalCentavos ?? 0 };
}

function fotografiaDoAceite(a: Omit<AceiteDoPedido, 'sequencia' | 'aceitoEm'>) {
  return [a.estabelecimentoId, a.salaoId, a.inicioEvento, a.fimEvento, a.precoCentavos, a.sinalCentavos,
    a.recebedor, a.chave, a.termosVersao, a.termosAceitos];
}

function precoAceitoDoPedido(pedido: Pedido) {
  try {
    return Math.round(valorFinalContrato({
      valorAprovado: pedido.valorAprovado === null ? null : Number(pedido.valorAprovado),
      valorTabela: Number(pedido.valorTabela), condicaoPagamento: pedido.condicaoPagamento,
    }) * 100);
  } catch (error) {
    if (error instanceof CondicaoPagamentoError) return NaN;
    throw error;
  }
}

async function prepararOferta(tx: DbExecutor, sessao: SessaoMeuPedido, pedido: Pedido, aceite: AceiteDoPedido | null, sinais: SituacaoDoSinal[],
  config: Awaited<ReturnType<typeof configuracaoDaOferta>>, pepper: string, travar: boolean) {
  const { empresaId } = sessao;
  const precoCentavos = precoAceitoDoPedido(pedido);
  const resultado = avaliarOferta({
    ...config, precoCentavos, status: pedido.status, temGarantia: sinais.some(s => s.garantiaAte !== null),
    agora: new Date(), inicioEvento: pedido.inicioEvento,
  });
  if (resultado.motivo) return { disponivel: false, motivo: resultado.motivo } as const;
  if (travar) {
    await adquirirLockConfirmacaoAgenda(pedido.data, tx);
    if (pedido.estabelecimentoId) await tx.query('SELECT kidmais062_travar_habilitacao($1::uuid)', [pedido.estabelecimentoId]);
  }
  const sala = await escolherSalaoParaEmissao(tx, pedido.id);
  const salao = sala.porSalao ? sala.salao : null;
  const conflito = await verificarConflitoAgendaParaConfirmacao({
    fechamentoId: pedido.id, data: pedido.data, horarioInicio: pedido.inicio, horarioFim: pedido.fim, salaoDoAceite: salao?.id ?? null,
  }, tx);
  const { rows: [agenda] } = await tx.query<{ livre: boolean; agora: Date }>(
    `SELECT ($2::uuid IS NULL OR kidmais062_unidade_agendavel($1,$2)) AND NOT kidmais019_ocupa($3) AS livre,
      clock_timestamp() AS agora`, [empresaId, pedido.estabelecimentoId, pedido.id]);
  if ((sala.porSalao && !salao) || conflito.bloqueioAgenda || conflito.fechamentoConfirmado || !agenda.livre)
    return { disponivel: false, motivo: 'HORARIO_INDISPONIVEL' } as const;
  const atualizado = avaliarOferta({
    ...config, precoCentavos, status: pedido.status, temGarantia: false, agora: agenda.agora, inicioEvento: pedido.inicioEvento,
  });
  if (atualizado.motivo) return { disponivel: false, motivo: atualizado.motivo } as const;

  const { sinalCentavos, recebedor } = atualizado;
  const retrato = {
    estabelecimentoId: pedido.estabelecimentoId, salaoId: salao?.id ?? null, inicioEvento: pedido.inicioEvento, fimEvento: pedido.fimEvento,
    precoCentavos: String(precoCentavos), sinalCentavos, recebedor: retratoDoRecebedor(recebedor), chave: recebedor.chave,
    termosVersao: VERSAO_TERMOS_PRE_RESERVA, termosAceitos: TERMOS_PRE_RESERVA,
  };
  const sequencia = aceite?.sequencia ?? 0;
  const assinatura = (a: typeof retrato, base: number) =>
    assinaturaDaOferta(pepper, [empresaId, sessao.clienteId, pedido.id, base, ...fotografiaDoAceite(a)]);
  const versaoOferta = assinatura(retrato, sequencia);
  const mesmoAceite = aceite && assinatura(aceite, sequencia) === versaoOferta ? aceite : null;
  if (mesmoAceite && sinalJaConferido(mesmoAceite, sinais))
    return { disponivel: false, motivo: 'PIX_NAO_PENDENTE' } as const;
  const oferta = {
    disponivel: true, sinalCentavos, recebedor: { nome: recebedor.nome, cidade: recebedor.cidade },
    versaoOferta, termos: { versao: VERSAO_TERMOS_PRE_RESERVA, texto: TERMOS_PRE_RESERVA },
    salao: salao && { id: salao.id, nome: salao.nome },
  } as const;
  // Só o POST que gerou o aceite vigente pode ser repetido com a sequência imediatamente anterior.
  const versaoRepeticao = mesmoAceite ? assinatura(retrato, sequencia - 1) : null;
  return { disponivel: true, oferta, retrato, mesmoAceite, versaoRepeticao } as const;
}

async function destinoMudou(tx: DbExecutor, empresaId: string, pedido: Pedido, aceite: AceiteDoPedido | null) {
  if (pedido.status !== 'AGUARDANDO_CONTRATO' || !aceite) return false;
  const porSalao = await escopoPorSalao(tx, empresaId, pedido.estabelecimentoId);
  return !destinoDoAceiteConfere(pedido, aceite, porSalao);
}

export async function listarMeuPedido(tx: DbExecutor, empresaId: string, acesso: SessaoMeuPedido, pepper: string) {
  const sessao = exigirSessaoMeuPedido(acesso, empresaId);
  await travarConfiguracaoAgenda(tx, empresaId, { modo: 'COMPARTILHADA', linha: 'SO_LEITURA' });
  const pedidos = await lerPedidosDoTitular(tx, sessao, null);
  const config = await configuracaoDaOferta(tx, empresaId, false);
  const saida = [];
  for (const pedido of pedidos) {
    const { aceite, sinais } = await lerAceiteESinais(tx, sessao, pedido.id);
    const atual = await prepararOferta(tx, sessao, pedido, aceite, sinais, config, pepper, false);
    const preReserva = apresentarSituacao(pedido.status, aceite, sinais, await destinoMudou(tx, empresaId, pedido, aceite));
    saida.push({
      id: pedido.id, protocolo: 'KM-' + pedido.id.slice(0, 8).toUpperCase(), status: pedido.status,
      data: pedido.data, inicio: pedido.inicio, fim: pedido.fim, unidade: pedido.unidadeNome,
      salao: pedido.salaoNome ?? (preReserva.garantia?.situacao === 'ATIVA' ? aceite?.salaoNome ?? null
        : atual.disponivel ? atual.oferta.salao?.nome ?? null : null),
      oferta: atual.disponivel ? atual.oferta : atual,
      preReserva,
    });
  }
  exigirSessaoMeuPedido(sessao, empresaId);
  return saida;
}

export async function aceitarOfertaMeuPedido(tx: DbExecutor, empresaId: string, acesso: SessaoMeuPedido,
  pedidoId: string, dados: { termosVersao: string; versaoOferta: string }, pepper: string) {
  const sessao = exigirSessaoMeuPedido(acesso, empresaId);
  // Mesma ordem da conferência: empresa, configuração de agenda, fechamento, data.
  // A trava compartilhada da linha também serializa a aceitação com mudanças comerciais.
  await tx.query('SELECT 1 FROM empresas WHERE id=$1 FOR SHARE', [empresaId]);
  await travarConfiguracaoAgenda(tx, empresaId, { modo: 'COMPARTILHADA', linha: 'JA_TRAVADA' });
  const pedido = await lerPedidoDoTitular(tx, sessao, pedidoId, 'UPDATE');
  if (dados.termosVersao !== VERSAO_TERMOS_PRE_RESERVA)
    throw new PacoteAdminError('TERMOS_DESATUALIZADOS', 'Leia a versão atual dos termos antes de aceitar.', 409);
  const { aceite, sinais } = await lerAceiteESinais(tx, sessao, pedidoId);
  const config = await configuracaoDaOferta(tx, empresaId, true);
  const atual = await prepararOferta(tx, sessao, pedido, aceite, sinais, config, pepper, true);
  exigirSessaoMeuPedido(sessao, empresaId);
  if (!atual.disponivel)
    throw new PacoteAdminError(atual.motivo, 'A oferta de pré-reserva não está disponível para este pedido.', 409);
  if (atual.oferta.versaoOferta !== dados.versaoOferta && atual.versaoRepeticao !== dados.versaoOferta)
    throw new PacoteAdminError('OFERTA_DESATUALIZADA', 'Confira a oferta atual antes de aceitar.', 409);
  if (atual.mesmoAceite) return apresentarAceite(atual.mesmoAceite);

  const { rows: [novo] } = await tx.query<AceiteDoPedido>(`INSERT INTO pre_reserva_aceites
    (empresa_id,fechamento_id,cliente_id,estabelecimento_id,salao_id,inicio_evento,fim_evento,preco_aceito_centavos,
     sinal_centavos,recebedor,chave_pix,termos_versao,termos_aceitos)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${CAMPOS_ACEITE}`,
    [empresaId, pedidoId, sessao.clienteId, ...fotografiaDoAceite(atual.retrato)]);
  await auditarMovimentoPreReserva(tx, sessao, 'PRE_RESERVA_ACEITE', empresaId, pedidoId, String(novo.sequencia), novo.aceitoEm);
  return apresentarAceite({ ...novo, salaoNome: atual.oferta.salao?.nome });
}

export async function pixMeuPedido(tx: DbExecutor, empresaId: string, acesso: SessaoMeuPedido, pedidoId: string) {
  const sessao = exigirSessaoMeuPedido(acesso, empresaId);
  await travarConfiguracaoAgenda(tx, empresaId, { modo: 'COMPARTILHADA', linha: 'SO_LEITURA' });
  const pedido = await lerPedidoDoTitular(tx, sessao, pedidoId, 'SHARE');
  const { aceite, sinais } = await lerAceiteESinais(tx, sessao, pedidoId);
  exigirSessaoMeuPedido(sessao, empresaId);
  if (!aceite) throw new PacoteAdminError('ACEITE_NECESSARIO', 'Aceite a oferta antes de acessar o Pix.', 409);
  if (pedido.status !== 'AGUARDANDO_CONTRATO' || sinais.some(s => s.garantiaAte !== null))
    throw new PacoteAdminError('PIX_NAO_PENDENTE', 'O Pix desse aceite já foi conferido ou o pedido mudou de situação.', 409);
  if (await destinoMudou(tx, empresaId, pedido, aceite))
    throw new PacoteAdminError('DESTINO_MUDOU', 'Confira o novo horário ou local e aceite a oferta atual para acessar o Pix.', 409);
  if (sinalJaConferido(aceite, sinais))
    throw new PacoteAdminError('PIX_NAO_PENDENTE', 'O Pix desse aceite já foi conferido.', 409);
  exigirSessaoMeuPedido(sessao, empresaId);
  const pix = montarPixDoAceite(pedidoId, aceite);
  if (!pix) throw new PacoteAdminError('PIX_INDISPONIVEL', 'O Pix desse aceite está indisponível.', 409);
  return { ...pix, aceiteSequencia: aceite.sequencia };
}

export async function desistirMeuPedido(tx: DbExecutor, empresaId: string, acesso: SessaoMeuPedido, pedidoId: string) {
  await desistirDaGarantia(tx, empresaId, pedidoId, acesso);
  const pedido = await lerPedidoDoTitular(tx, acesso, pedidoId);
  const { aceite, sinais } = await lerAceiteESinais(tx, acesso, pedidoId);
  return { status: pedido.status, preReserva: apresentarSituacao(pedido.status, aceite, sinais,
    await destinoMudou(tx, empresaId, pedido, aceite)) };
}
