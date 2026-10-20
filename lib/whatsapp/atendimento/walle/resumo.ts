import type { DbExecutor } from '../../../db/contracts.ts';
import type { SessaoParaTenant } from '../../../saas/provar-tenant.ts';
import { ambienteAtendimento } from '../configuracao.ts';
import { acessoAtendimento, tem082 } from '../service.ts';
import { lerContexto } from './contexto.ts';
import { NOME_MOTIVO, type MotivoPassagem, type Passagem, type TipoIntencao } from './tipos.ts';
import { ambienteDoLink, linkDisponibilidadePublica } from './link-disponibilidade.ts';
import { listarConfiguracoesAgendaAtivas } from '../../../disponibilidade/repositories/disponibilidade.repository.ts';
import { escopoDaConsulta } from './fontes-postgres.ts';

/**
 * Resumo da conversa para a equipe (painel lateral): o que o cliente informou ao Wall-e (memória da 082), com os nomes
 * lidos dos cadastros da EMPRESA, os materiais já enviados e a passagem. Só leitura; nada aqui vai ao cliente.
 */
export const NOME_ASSUNTO: Record<TipoIntencao, string> = {
  PRECOS: 'Preços', LOCALIZACAO: 'Endereço', DISPONIBILIDADE: 'Datas', PACOTES: 'Pacotes', CARDAPIO: 'Buffet e cardápio', DECORACAO: 'Decoração',
  CONTRATO: 'Condições do contrato', CONTRATO_PROPRIO: 'Contrato particular', CONTRATAR: 'Quer contratar', CONFIRMACAO: 'Confirmação', DUVIDA: 'Dúvidas',
  HUMANO: 'Pediu atendente', NEGOCIACAO: 'Negociação', SAUDACAO: 'Saudação', OUTRO: 'Outro', PARAR: 'Pediu para parar',
  EXTERNO: 'Item ou fornecedor de fora',
};
export type ResumoConversa = {
  interesse: string[]; data: string | null; horario: string | null; convidados: number | null; pacote: string | null; unidade: string | null; tema: string | null;
  enviados: { titulo: string; versao: number }[]; correcoes: number;
  passagem: (Omit<Passagem, 'motivos'> & { motivoTexto: string; motivosTexto: string[] }) | null;
};
const hora = (h: string) => { const [hh, mm] = h.slice(0, 5).split(':'); return mm === '00' ? `${Number(hh)}h` : `${Number(hh)}h${mm}`; };

export async function resumoDaConversa(tx: DbExecutor, empresa: string, ambiente: string, conversaId: string): Promise<ResumoConversa | null> {
  const linha = (await tx.query<{ contexto: unknown; passagem: Passagem | null }>('SELECT contexto,passagem FROM whatsapp_atendimento_conversas WHERE id=$1 AND empresa_id=$2 AND ambiente=$3', [conversaId, empresa, ambiente])).rows[0];
  if (!linha) return null;
  const c = lerContexto(linha.contexto);
  // Revisão final (M2): o turno vem do MESMO escopo que o Wall-e usa com o cliente (empresa e, quando houver agenda
  // própria, a unidade da conversa; o nível mais específico vence). Nunca o turno de mesmo código de outra empresa.
  const turno = c.turno ? (await listarConfiguracoesAgendaAtivas(tx, (await escopoDaConsulta(tx, empresa, c.unidade ?? null)).escopo)).find((t) => t.codigo === c.turno) ?? null : null;
  const pacote = c.pacote ? (await tx.query<{ nome: string }>('SELECT nome FROM pacotes WHERE empresa_id=$1 AND codigo=$2 AND vigente LIMIT 1', [empresa, c.pacote])).rows[0] : null;
  const unidade = c.unidade ? (await tx.query<{ nome: string }>('SELECT nome FROM estabelecimentos WHERE empresa_id=$1 AND id=$2', [empresa, c.unidade])).rows[0] : null;
  const ids = [...new Set((c.enviados ?? []).map((x) => x.prontaId))];
  const titulos = ids.length ? new Map((await tx.query<{ id: string; titulo: string }>('SELECT id,titulo FROM whatsapp_atendimento_mensagens_prontas WHERE empresa_id=$1 AND ambiente=$2 AND id=ANY($3::uuid[])', [empresa, ambiente, ids])).rows.map((p) => [p.id, p.titulo])) : new Map<string, string>();
  const enviados = [...new Map((c.enviados ?? []).map((x) => [x.prontaId, x])).values()].map((x) => ({ titulo: titulos.get(x.prontaId) ?? 'Material removido da biblioteca', versao: x.versao }));
  const p = linha.passagem;
  return {
    interesse: (c.assuntos ?? []).map((a) => NOME_ASSUNTO[a]),
    data: c.data ?? null, horario: turno ? `${turno.nome} (${hora(turno.horarioInicioPadrao)} às ${hora(turno.horarioFimPadrao)})` : null,
    convidados: c.convidados ?? null, pacote: pacote?.nome ?? null, unidade: unidade?.nome ?? null, tema: c.tema ?? null,
    enviados, correcoes: (c.correcoes ?? []).length,
    passagem: p && p.motivo ? { ...p, motivoTexto: NOME_MOTIVO[p.motivo as MotivoPassagem] ?? p.motivo, motivosTexto: (p.motivos ?? [p.motivo]).map((m) => NOME_MOTIVO[m as MotivoPassagem] ?? m) } : null,
  };
}

/** Para a tela: a 082 está aplicada (Wall-e, biblioteca completa) e o resumo da conversa aberta. */
export async function estadoWallE(sessao: SessaoParaTenant, conversaId: string | null) {
  return acessoAtendimento(sessao, async (tx, empresa) => {
    // Rodada 40: o link público de disponibilidade desta empresa (o mesmo que o Wall-e envia), para a Configuração.
    const linkPublico = linkDisponibilidadePublica(empresa, ambienteDoLink());
    if (!(await tem082(tx))) return { disponivel: false, conversaId, resumo: null, linkPublico };
    return { disponivel: true, conversaId, resumo: conversaId ? await resumoDaConversa(tx, empresa, ambienteAtendimento(), conversaId) : null, linkPublico };
  });
}
