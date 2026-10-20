import { linkAcesso } from '../../contratos/acesso-publico/liberacao.ts';

// Só no servidor (usa o construtor de link autorizado do contrato).
/**
 * Formas do mesmo telefone para procurar o cadastro: o WhatsApp chega com DDI (55...), o CRM costuma guardar sem.
 * Sem heurística do nono dígito (decisão pendente): só "com 55" e "sem 55".
 */
export function variantesTelefone(contato: string) {
  const d = contato.replace(/\D/g, '');
  const v = new Set([d]);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) v.add(d.slice(2));
  return [...v].filter(x => x.length >= 10);
}

export type MotivoSemLink = 'SEM_CLIENTE' | 'CLIENTES_AMBIGUOS' | 'SEM_CONTRATO_LIBERADO' | 'CONTRATOS_AMBIGUOS' | 'ORIGEM_NAO_SEGURA';
export const EXPLICACAO_SEM_LINK: Record<MotivoSemLink, string> = {
  SEM_CLIENTE: 'Nenhum cliente desta empresa tem este telefone. O link individual não foi preenchido.',
  CLIENTES_AMBIGUOS: 'Mais de um cliente desta empresa tem este telefone. O link individual não foi preenchido; confira o cadastro.',
  SEM_CONTRATO_LIBERADO: 'O cliente não tem contrato aguardando a assinatura dele. O link individual não foi preenchido.',
  CONTRATOS_AMBIGUOS: 'O cliente tem mais de um contrato aguardando assinatura. O link individual não foi preenchido; envie pela tela do contrato.',
  ORIGEM_NAO_SEGURA: 'Este ambiente não tem origem https configurada para links de cliente. O link individual não foi preenchido.',
};
export type PortasLinkFechamento = {
  /** Clientes da EMPRESA com o telefone exato (consulta já filtrada por empresa e sem mesclados). */
  clientesPorTelefone: (telefone: string) => Promise<readonly { id: string; empresaId: string | null }[]>;
  /** Contratações da EMPRESA para o cliente, com o acesso público só quando o contrato aguarda o cliente. */
  contratacoesDoCliente: (clienteId: string) => Promise<readonly { contratoId: string | null; acessoPublico: string | null }[]>;
  origemPublica: string | undefined;
};

/** Link individual de fechamento, só com vínculo inequívoco empresa → conversa (telefone) → cliente → contrato. */
export async function resolverLinkFechamento(empresaId: string, contato: string, portas: PortasLinkFechamento): Promise<{ ok: true; link: string } | { ok: false; motivo: MotivoSemLink }> {
  const clientes = new Map<string, { id: string; empresaId: string | null }>();
  for (const telefone of variantesTelefone(contato)) for (const c of await portas.clientesPorTelefone(telefone)) if (c.empresaId === empresaId) clientes.set(c.id, c);
  if (clientes.size === 0) return { ok: false, motivo: 'SEM_CLIENTE' };
  if (clientes.size > 1) return { ok: false, motivo: 'CLIENTES_AMBIGUOS' };
  const [cliente] = clientes.values();
  const contratos = new Set((await portas.contratacoesDoCliente(cliente.id)).filter(c => c.acessoPublico && c.contratoId).map(c => c.contratoId as string));
  if (contratos.size === 0) return { ok: false, motivo: 'SEM_CONTRATO_LIBERADO' };
  if (contratos.size > 1) return { ok: false, motivo: 'CONTRATOS_AMBIGUOS' };
  const [contratoId] = contratos;
  if (!origemHttps(portas.origemPublica)) return { ok: false, motivo: 'ORIGEM_NAO_SEGURA' };
  try { return { ok: true, link: linkAcesso(portas.origemPublica as string, contratoId) }; }
  catch { return { ok: false, motivo: 'SEM_CONTRATO_LIBERADO' }; }
}
function origemHttps(valor: string | undefined) {
  try { const u = new URL(valor ?? ''); return u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash; } catch { return false; }
}
