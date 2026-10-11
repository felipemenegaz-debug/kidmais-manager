import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';

/**
 * Painel, pendências de cobrança: textos da exclusão sem confirmação (marcador da reconciliação e da contratação) e da
 * liberação bloqueada por ele. Não há atalho para ignorar o marcador: a liberação só aparece quando o servidor diz que é
 * liberável, e o marcador só fecha pela releitura no provedor.
 */
type Textos = { TITULO: Record<string, string>; AVISO_BLOQUEIO_REMOCAO: string; textoMotivo: (m: string | null, situacao: string) => string };
const textos = () => carregarModulo('components/desenvolvedor/PendenciasCobranca.tsx', {
    'admin/workspace.module.css': {}, 'desenvolvedor/cliente': { chamar: async () => ({ ok: true, data: [] }) },
    'desenvolvedor/Reautenticacao': { useReautenticacao: () => ({ executar: () => undefined, dialogo: null }) },
}) as unknown as Textos;

test('pendências: exclusão sem confirmação com título e motivo legíveis (sem código cru)', () => {
    const { TITULO, textoMotivo } = textos();
    assert.equal(TITULO.REMOCAO_SEM_CONFIRMACAO, 'Exclusão no provedor sem confirmação');
    assert.equal(textoMotivo('REMOCAO_SEM_CONFIRMACAO', 'PENDENTE'), 'exclusão de duplicata sem confirmação do provedor; confira no painel do Asaas (nada é excluído de novo automaticamente)');
    assert.equal(textoMotivo('REMOCAO_EM_CURSO', 'PENDENTE'), 'exclusão de duplicata enviada, resultado ainda não gravado');
    assert.equal(textoMotivo('REVISAO_HUMANA: REMOCAO_SEM_CONFIRMACAO', 'FALHOU'),
        'precisa de revisão: exclusão de duplicata sem confirmação do provedor; confira no painel do Asaas (nada é excluído de novo automaticamente)');
    assert.equal(textoMotivo('REVISAO_HUMANA: DUPLICATA_COM_PAGAMENTO', 'FALHOU'), 'precisa de revisão: duplicata com pagamento');
    assert.equal(textoMotivo('PROVEDOR_INDISPONIVEL: remover assinatura (503)', 'FALHOU'), 'PROVEDOR_INDISPONIVEL: remover assinatura (503)', 'código desconhecido segue como veio');
});

test('pendências: liberação bloqueada pelo marcador explica o motivo e não oferece atalho para ignorar', () => {
    const { AVISO_BLOQUEIO_REMOCAO } = textos();
    assert.match(AVISO_BLOQUEIO_REMOCAO, /^Liberação bloqueada: há uma exclusão de assinatura no provedor com resultado desconhecido nesta empresa\./);
    const fonte = readFileSync('components/desenvolvedor/PendenciasCobranca.tsx', 'utf8');
    assert.match(fonte, /\{p\.bloqueadaPor === 'REMOCAO_SEM_CONFIRMACAO' && <p className=\{workspace\.muted\}>\{AVISO_BLOQUEIO_REMOCAO\}<\/p>\}/);
    // O botão de liberar só existe quando o servidor marca a intenção como liberável (com marcador aberto, nunca).
    assert.equal(fonte.match(/<button/g)?.length, 3, 'só liberar, confirmar e cancelar');
    assert.match(fonte, /\{p\.liberavel && aberta !== p\.id && <div>\s*<button type="button"[^\n]*>Liberar \(não foi criada\)<\/button>/);
    assert.doesNotMatch(fonte, /<button[^\n]*(ignorar|forçar|desbloquear)/i);
    const servidor = readFileSync('lib/assinatura/liberacao-intencao.ts', 'utf8');
    assert.match(servidor, /liberavel: criacao && !r\.tem_assinatura && !bloqueio/);
});

test('rótulo legível para a auditoria da exclusão sem confirmação', () => {
    const { rotuloAcao } = carregarModulo('components/desenvolvedor/cliente.ts', {}) as unknown as { rotuloAcao: (a: string) => string };
    assert.equal(rotuloAcao('ASSINATURA_REMOCAO_SEM_CONFIRMACAO'), 'Exclusão de assinatura no provedor sem confirmação (revisão)');
    // D2: a releitura prova ausência, não autoria; o histórico da resposta ao nosso DELETE mantém o rótulo próprio.
    assert.equal(rotuloAcao('ASSINATURA_AUSENCIA_CONFIRMADA_RELEITURA'), 'Ausência da assinatura no provedor confirmada na releitura (autoria não comprovada)');
    assert.notEqual(rotuloAcao('ASSINATURA_AUSENCIA_CONFIRMADA_RELEITURA'), rotuloAcao('ASSINATURA_DUPLICADA_REMOVIDA'), 'ausência e remoção confirmada não se confundem');
});
