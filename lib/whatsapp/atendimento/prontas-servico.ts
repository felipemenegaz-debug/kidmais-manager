import type { DbExecutor } from '../../db/contracts.ts';
import type { SessaoParaTenant } from '../../saas/provar-tenant.ts';
import { buscarClientesPorContatoExato } from '../../clientes/repositories/cliente.repository.ts';
import { listarContratacoes } from '../../fechamentos/contratacoes.ts';
import { ambienteAtendimento } from './configuracao.ts';
import { acessoAtendimento } from './service.ts';
import { comporRascunho, linkSeguro, prontaEntradaSchema, type Pronta } from './prontas.ts';
import { EXPLICACAO_SEM_LINK, resolverLinkFechamento } from './prontas-link.ts';

/**
 * Serviço da biblioteca de mensagens prontas (064). Mesma porta de acesso do atendimento: empresa comprovada pela
 * sessão e papel ADMINISTRATIVO ou REPRESENTANTE_AUTORIZADO; cadastrar e arquivar só o representante.
 * Nada aqui envia mensagem: o rascunho volta para a tela e o envio continua sendo a ação "enviar" do atendente.
 */
const COLUNAS = 'id,titulo,categoria,tipo,texto,link,atalho,versao,atualizada_em';

/** Sem a 064 a biblioteca fica indisponível, sem derrubar o atendimento; conflitos de unicidade viram mensagens claras. */
function traduzir(erro: unknown) {
  const e = erro as { code?: string; constraint?: string };
  if (e?.code === '42P01') return new Error('ATENDIMENTO_PRONTAS_INDISPONIVEL');
  if (e?.code === '23505' && e.constraint === 'whatsapp_prontas_atalho_unico') return new Error('ATENDIMENTO_PRONTA_ATALHO_EM_USO');
  if (e?.code === '23505' && e.constraint === 'whatsapp_prontas_titulo_unico') return new Error('ATENDIMENTO_PRONTA_TITULO_EM_USO');
  return erro;
}
async function comBiblioteca<T>(sessao: SessaoParaTenant, work: (tx: DbExecutor, empresa: string, papel: string, ambiente: string) => Promise<T>) {
  try { return await acessoAtendimento(sessao, (tx, empresa, papel) => work(tx, empresa, papel, ambienteAtendimento())); }
  catch (erro) { throw traduzir(erro); }
}
const representante = (papel: string) => { if (papel !== 'REPRESENTANTE_AUTORIZADO') throw new Error('ATENDIMENTO_ACESSO_NEGADO'); };

export async function listarProntas(sessao: SessaoParaTenant) {
  return comBiblioteca(sessao, async (tx, empresa, papel, ambiente) => {
    const prontas = (await tx.query<Pronta>(`SELECT ${COLUNAS} FROM whatsapp_atendimento_mensagens_prontas WHERE empresa_id=$1 AND ambiente=$2 AND ativa ORDER BY atalho NULLS LAST, categoria, titulo LIMIT 500`, [empresa, ambiente])).rows;
    const favoritas = (await tx.query<{ id: string }>('SELECT f.mensagem_pronta_id AS id FROM whatsapp_atendimento_mensagens_prontas_favoritas f JOIN whatsapp_atendimento_mensagens_prontas p ON p.id=f.mensagem_pronta_id AND p.empresa_id=f.empresa_id AND p.ambiente=f.ambiente AND p.ativa WHERE f.usuario_id=$1 AND f.empresa_id=$2 AND f.ambiente=$3', [sessao.usuario_id, empresa, ambiente])).rows.map(r => r.id);
    return { prontas: prontas.map(p => ({ ...p, versao: Number(p.versao) })), favoritas, podeGerenciar: papel === 'REPRESENTANTE_AUTORIZADO' };
  });
}

export async function salvarPronta(sessao: SessaoParaTenant, valor: unknown) {
  const p = prontaEntradaSchema.parse(valor);
  const link = p.tipo === 'LINK' ? linkSeguro(p.link ?? '') : null;
  return comBiblioteca(sessao, async (tx, empresa, papel, ambiente) => {
    representante(papel);
    if (!p.id) {
      const r = await tx.query<{ id: string }>(`INSERT INTO whatsapp_atendimento_mensagens_prontas(empresa_id,ambiente,titulo,categoria,tipo,texto,link,atalho,criada_por,atualizada_por)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`, [empresa, ambiente, p.titulo, p.categoria, p.tipo, p.texto, link, p.atalho, sessao.usuario_id]);
      return { id: r.rows[0].id };
    }
    const r = await tx.query<{ id: string }>(`UPDATE whatsapp_atendimento_mensagens_prontas SET titulo=$5,categoria=$6,tipo=$7,texto=$8,link=$9,atalho=$10,atualizada_por=$11,versao=versao+1,atualizada_em=clock_timestamp()
      WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND versao=$4 AND ativa RETURNING id`, [p.id, empresa, ambiente, p.versao ?? -1, p.titulo, p.categoria, p.tipo, p.texto, link, p.atalho, sessao.usuario_id]);
    if (!r.rows.length) throw new Error('ATENDIMENTO_PRONTA_DESATUALIZADA');
    return { id: p.id };
  });
}

export async function arquivarPronta(sessao: SessaoParaTenant, pedido: { id: string; versao: number }) {
  return comBiblioteca(sessao, async (tx, empresa, papel, ambiente) => {
    representante(papel);
    // Remoção lógica: conversas e histórico não dependem desta linha; favoritas deixam de aparecer.
    const r = await tx.query(`UPDATE whatsapp_atendimento_mensagens_prontas SET ativa=false,atalho=NULL,atualizada_por=$5,versao=versao+1,atualizada_em=clock_timestamp()
      WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND versao=$4 AND ativa RETURNING id`, [pedido.id, empresa, ambiente, pedido.versao, sessao.usuario_id]);
    if (!r.rows.length) throw new Error('ATENDIMENTO_PRONTA_DESATUALIZADA');
  });
}

export async function favoritarPronta(sessao: SessaoParaTenant, pedido: { id: string; favorita: boolean }) {
  return comBiblioteca(sessao, async (tx, empresa, _papel, ambiente) => {
    if (!pedido.favorita) {
      await tx.query('DELETE FROM whatsapp_atendimento_mensagens_prontas_favoritas WHERE usuario_id=$1 AND mensagem_pronta_id=$2 AND empresa_id=$3 AND ambiente=$4', [sessao.usuario_id, pedido.id, empresa, ambiente]);
      return;
    }
    const existe = (await tx.query('SELECT id FROM whatsapp_atendimento_mensagens_prontas WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND ativa', [pedido.id, empresa, ambiente])).rows.length;
    if (!existe) throw new Error('ATENDIMENTO_PRONTA_NAO_ENCONTRADA');
    await tx.query('INSERT INTO whatsapp_atendimento_mensagens_prontas_favoritas(usuario_id,mensagem_pronta_id,empresa_id,ambiente) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [sessao.usuario_id, pedido.id, empresa, ambiente]);
  });
}

/**
 * Rascunho para a conversa aberta: só leitura. O link individual de fechamento só é preenchido com vínculo inequívoco
 * (empresa comprovada → conversa da empresa → um único cliente da empresa com o telefone → um único contrato aguardando
 * a assinatura dele, pelo fluxo de contratações). O telefone não volta para a tela.
 */
export async function prepararRascunho(sessao: SessaoParaTenant, pedido: { conversaId: string; id: string }) {
  return comBiblioteca(sessao, async (tx, empresa, _papel, ambiente) => {
    const conversa = (await tx.query<{ contato: string }>('SELECT contato FROM whatsapp_atendimento_conversas WHERE id=$1 AND empresa_id=$2 AND ambiente=$3', [pedido.conversaId, empresa, ambiente])).rows[0];
    if (!conversa) throw new Error('ATENDIMENTO_NAO_ENCONTRADO');
    const pronta = (await tx.query<Pronta>(`SELECT ${COLUNAS} FROM whatsapp_atendimento_mensagens_prontas WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND ativa`, [pedido.id, empresa, ambiente])).rows[0];
    if (!pronta) throw new Error('ATENDIMENTO_PRONTA_NAO_ENCONTRADA');
    if (pronta.tipo !== 'LINK_FECHAMENTO_INDIVIDUAL') return { titulo: pronta.titulo, texto: comporRascunho(pronta.texto, pronta.link), linkIndividual: null, aviso: null };
    const link = await resolverLinkFechamento(empresa, conversa.contato, {
      clientesPorTelefone: telefone => buscarClientesPorContatoExato(telefone, empresa, tx),
      contratacoesDoCliente: clienteId => listarContratacoes(tx, empresa, clienteId),
      origemPublica: process.env.ADMIN_AUTH_ORIGIN,
    });
    return link.ok
      ? { titulo: pronta.titulo, texto: comporRascunho(pronta.texto, link.link), linkIndividual: 'PREENCHIDO' as const, aviso: null }
      : { titulo: pronta.titulo, texto: pronta.texto, linkIndividual: 'NAO_PREENCHIDO' as const, aviso: EXPLICACAO_SEM_LINK[link.motivo] };
  });
}
