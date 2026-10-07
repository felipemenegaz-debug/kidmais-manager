'use client';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import { saidaDaSessaoEmAndamento } from '@/lib/http/contexto-empresa-cliente';

/** Chamada às APIs do painel com CSRF; devolve sempre o resultado real (sucesso ou erro com mensagem do servidor). */
export type Falha = { ok: false; erro: string; codigo: string | null; detalhes: Record<string, unknown> | null; status: number };
export type Resposta<T> = { ok: true; data: T } | Falha;

export async function chamar<T>(url: string, metodo: 'GET' | 'POST' | 'PATCH' = 'GET', corpo?: unknown): Promise<Resposta<T>> {
    try {
        const res = metodo === 'GET'
            ? await fetch(url, { cache: 'no-store' })
            : await adminFetch(url, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo ?? {}) });
        if (res.status === 401 || res.redirected) {
            // Helper fora de React (mesmo padrão de admin-fetch): sessão expirada volta ao login — salvo durante a saída
            // iniciada pela própria tela (components/admin/sair.ts), que já navega; uma resposta tardia não muda o destino.
            if (!saidaDaSessaoEmAndamento()) {
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.assign(`/admin/login?voltar=${encodeURIComponent(window.location.pathname)}`);
            }
            return { ok: false, erro: 'Sua sessão terminou. Entre novamente.', codigo: 'AUTENTICACAO', detalhes: null, status: 401 };
        }
        const json = await res.json().catch(() => null) as { ok?: boolean; data?: T; erro?: string; codigo?: string; detalhes?: Record<string, unknown> } | null;
        if (res.ok && json?.ok)
            return { ok: true, data: json.data as T };
        return { ok: false, erro: json?.erro ?? `Falha na operação (HTTP ${res.status}).`, codigo: json?.codigo ?? null, detalhes: json?.detalhes ?? null, status: res.status };
    }
    catch (error) {
        return { ok: false, erro: error instanceof Error ? error.message : 'Falha de conexão. Nada foi confirmado.', codigo: 'CONEXAO', detalhes: null, status: 0 };
    }
}

/**
 * Reautenticação do diálogo: senha incorreta mantém sessão, contexto e formulário; sucesso só aceita a sessão nova
 * renovada pelo servidor para a sessão desta página (lib/http/admin-fetch.ts → reautenticarSessao).
 */
export async function confirmarSenha(senha: string): Promise<string | null> {
    const r = await reautenticarSessao(senha);
    return r.ok ? null : r.erro;
}

export function formatarData(iso: string | null | undefined, comHora = true) {
    if (!iso)
        return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return '—';
    return d.toLocaleString('pt-BR', comHora ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'short' });
}

export function formatarDocumento(doc: string | null) {
    if (!doc)
        return '—';
    if (/^\d{11}$/.test(doc))
        return doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    if (doc.length === 14)
        return doc.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, '$1.$2.$3/$4-$5');
    return doc;
}

export function formatarTelefone(tel: string | null) {
    if (!tel)
        return '—';
    const t = tel.startsWith('55') && tel.length >= 12 ? tel.slice(2) : tel;
    return t.length === 11 ? t.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3') : t.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
}

const ACOES: Record<string, string> = {
    INTERESSADA_CADASTRADA: 'Interessada cadastrada',
    INTERESSADA_ATUALIZADA: 'Interessada atualizada',
    INTERESSADA_STATUS_ALTERADO: 'Situação da interessada alterada',
    EMPRESA_PROVISIONADA: 'Contratante provisionada',
    EMPRESA_CADASTRO_ATUALIZADO: 'Cadastro da empresa atualizado',
    EMPRESA_CADASTRO_CRIADO: 'Cadastro da empresa criado',
    EMPRESA_IMPLANTACAO_ALTERADA: 'Implantação atualizada',
    EMPRESA_IMPLANTACAO_RECUSADA: 'Conclusão da implantação recusada',
    PERFIL_ESTRUTURA_CRIADA: 'Perfil da empresa criado',
    PERFIL_CONCESSAO_INICIAL: 'Concessão inicial do perfil',
    PERFIL_RASCUNHO_SALVO: 'Rascunho do perfil salvo',
    PERFIL_CADASTRO_APLICADO: 'Cadastro do perfil aplicado',
    PERFIL_REVOGADO: 'Concessão do perfil revogada',
    PERFIL_REVOGACAO_RECUSADA: 'Revogação do perfil recusada',
    PLATAFORMA_DESENVOLVEDOR_CONCEDIDO: 'Concessão de desenvolvedor criada',
    PLATAFORMA_DESENVOLVEDOR_REVOGADO: 'Concessão de desenvolvedor revogada',
    EMPRESA_SUSPENSA: 'Empresa suspensa',
    EMPRESA_REATIVADA: 'Empresa reativada',
    EMPRESA_TRANSICAO: 'Situação da empresa mudou',
    CONVITE_CRIADO: 'Convite criado',
    CONVITE_RENOVADO: 'Convite renovado',
    CONVITE_ENVIADO: 'Convite enviado',
    CONVITE_ENVIO_FALHOU: 'Convite não enviado',
    CONVITE_CANCELADO: 'Convite cancelado',
    CONVITE_ACEITO: 'Convite aceito',
    CONVITE_ACEITE_RECUSADO: 'Aceite de convite recusado',
    MEMBERSHIP_TRANSICAO: 'Vínculo mudou de situação',
    MEMBERSHIP_PAPEL_ALTERADO: 'Papel alterado',
    MEMBERSHIP_DESATIVADA: 'Vínculo desativado',
    MEMBERSHIP_REATIVADA: 'Vínculo reativado',
    MEMBERSHIP_ADICIONADA: 'Vínculo adicionado pela empresa',
    MEMBERSHIP_REMOVIDA: 'Vínculo removido pela empresa',
    ADMIN_CRIAR: 'Conta criada pela empresa',
    RECUPERACAO_SOLICITADA: 'Recuperação de senha solicitada',
    RECUPERACAO_ENVIADA: 'Recuperação de senha enviada',
    RECUPERACAO_ENVIO_FALHOU: 'Recuperação de senha não enviada',
    SENHA_REDEFINIDA: 'Senha redefinida por recuperação',
    SENHA_ALTERADA: 'Senha alterada pelo usuário',
    SENHA_TROCA_RECUSADA: 'Troca de senha recusada',
    PAINEL_ACESSO_RECUSADO: 'Acesso ao painel recusado',
    FESTA_PERFIL_APLICADO: 'Perfil de Festa aplicado',
    COMERCIAL_TESTE_ESTENDIDO: 'Teste grátis estendido',
    COMERCIAL_EXCECAO_CONCEDIDA: 'Acesso comercial excepcional concedido',
    COMERCIAL_EXCECAO_REVOGADA: 'Acesso comercial excepcional revogado',
    EXPORTACAO_DADOS: 'Dados exportados',
    REPRESENTACAO_APROVADA: 'Representação aprovada',
    REPRESENTACAO_RECUSADA: 'Representação recusada',
    REPRESENTACAO_REVOGADA: 'Representação revogada',
    PEDIDO_ACESSO_ATENDIDA: 'Pedido de acesso atendido',
    PEDIDO_ACESSO_RECUSADA: 'Pedido de acesso recusado',
    EMPRESA_CADASTRADA_PUBLICO: 'Empresa cadastrada pelo cadastro público',
    CADASTRO_CONFIRMADO: 'Conta confirmada pelo e-mail',
    COBRANCA_SINCRONIZADA: 'Cobrança sincronizada com o provedor',
    COBRANCA_INTENCAO_LIBERADA: 'Intenção de cobrança liberada manualmente',
};
export function rotuloAcao(acao: string) {
    return ACOES[acao] ?? acao.toLowerCase().replace(/_/g, ' ');
}
