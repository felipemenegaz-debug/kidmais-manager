import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { DbExecutor } from '../db/contracts';
import { alertasPainel, ordenarAlertas, type Alerta } from './alertas.ts';
import { classificarPendencias, type DadosImplantacao } from './implantacao.ts';

/** Alertas acionáveis do resumo, sem banco: o SQL real roda na suíte PostgreSQL da 063 (painel-063.postgres.test.ts). */
type Linhas = { convites: unknown[]; pessoas: unknown[] };
function txFalso(linhas: Linhas) {
    const sqls: string[] = [];
    const tx = {
        async query(sql: string) {
            sqls.push(sql);
            if (sql.includes('GROUP BY e.id, e.nome')) return { rows: linhas.convites, rowCount: linhas.convites.length };
            if (sql.includes('AS sem_acesso')) return { rows: linhas.pessoas, rowCount: linhas.pessoas.length };
            throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
        },
    } as unknown as DbExecutor;
    return { tx, sqls };
}
const completo: DadosImplantacao = {
    gestoesAtivas: 1, gestoesSemAcesso: 0, responsavel: 'GESTAO_ATIVA',
    convites: { pendentes: 0, expirados: 0, naoEnviados: 0 }, perfil: { estruturaInstalada: true, existe: true, ambiguo: false, versao: 1 },
};
const pessoa = (o: Record<string, unknown>) => ({ empresa_id: 'e1', empresa: 'Buffet A', implantacao: 'CONCLUIDA', gestoes: 1, sem_acesso: 0, responsavel: 'GESTAO_ATIVA', cadastro_em: '2026-10-01 10:00:00+00', ...o });
const codigos = (r: { itens: Alerta[] }) => r.itens.map((a) => `${a.codigo}:${a.empresaId ?? '-'}`);

test('tudo em dia e e-mail configurado: nenhum alerta', async () => {
    const { tx } = txFalso({ convites: [], pessoas: [pessoa({})] });
    const r = await alertasPainel(tx, { configurado: true, motivo: null }, { pendencias: async () => classificarPendencias(completo) });
    assert.deepEqual(r, { itens: [], total: 0 });
});

test('convite nunca enviado com e-mail desligado: e-mail urgente e convite urgente com link para a seção de convites', async () => {
    const { tx } = txFalso({ convites: [{ empresa_id: 'e1', empresa: 'Buffet A', nao_enviados: 2, expirados: 1, mais_antigo: '2026-10-02 08:00:00+00' }], pessoas: [pessoa({})] });
    const r = await alertasPainel(tx, { configurado: false, motivo: 'EMAIL_PROVIDER desativado.' }, { pendencias: async () => classificarPendencias(completo) });
    assert.deepEqual(codigos(r), ['EMAIL_INDISPONIVEL:-', 'CONVITE_NAO_ENVIADO:e1', 'CONVITE_EXPIRADO:e1']);
    assert.equal(r.itens[0].severidade, 'ALTA');
    assert.match(r.itens[1].detalhe, /2 convite\(s\).*Configure o e-mail e reenvie/);
    assert.equal(r.itens[1].acao?.href, '/desenvolvedor/empresas/e1#t-convites');
    // Nenhum e-mail de convite aparece no alerta.
    assert.doesNotMatch(JSON.stringify(r), /@/);
});

test('empresa concluída sem Gestão ativa, Gestão desativada e responsável sem acesso viram alertas separados', async () => {
    const { tx } = txFalso({ convites: [], pessoas: [pessoa({ gestoes: 0, sem_acesso: 1, responsavel: 'SEM_ACESSO' })] });
    const r = await alertasPainel(tx, { configurado: true, motivo: null }, { pendencias: async () => { throw new Error('não deveria ler implantação concluída'); } });
    assert.deepEqual(codigos(r), ['SEM_GESTAO:e1', 'GESTAO_SEM_ACESSO:e1', 'RESPONSAVEL_SEM_ACESSO:e1']);
    assert.equal(r.itens[0].acao?.href, '/desenvolvedor/empresas/e1#t-usuarios');
});

test('implantação: incompleta lista o que falta (urgente sem Gestão); pronta sugere concluir; sem cadastro é próximo passo', async () => {
    const { tx } = txFalso({
        convites: [],
        pessoas: [
            pessoa({ empresa_id: 'e1', empresa: 'Buffet A', implantacao: 'AGUARDANDO_PRIMEIRO_ACESSO', gestoes: 0 }),
            pessoa({ empresa_id: 'e2', empresa: 'Buffet B', implantacao: 'EM_CONFIGURACAO' }),
            pessoa({ empresa_id: 'e3', empresa: 'Buffet C', implantacao: 'EM_CONFIGURACAO' }),
            pessoa({ empresa_id: 'e4', empresa: 'Legado', implantacao: null, responsavel: null }),
        ],
    });
    const lidas: string[] = [];
    const r = await alertasPainel(tx, { configurado: true, motivo: null }, {
        pendencias: async (_tx, id) => {
            lidas.push(id);
            if (id === 'e1') return classificarPendencias({ ...completo, gestoesAtivas: 0, perfil: { estruturaInstalada: true, existe: false, ambiguo: false, versao: 0 } });
            if (id === 'e2') return classificarPendencias({ ...completo, perfil: { estruturaInstalada: true, existe: true, ambiguo: false, versao: 0 } });
            return classificarPendencias(completo);
        },
    });
    assert.deepEqual(lidas, ['e1', 'e2', 'e3']);
    assert.deepEqual(codigos(r), ['IMPLANTACAO_INCOMPLETA:e1', 'IMPLANTACAO_INCOMPLETA:e2', 'IMPLANTACAO_PRONTA:e3', 'SEM_CADASTRO:e4']);
    assert.equal(r.itens[0].severidade, 'ALTA');
    assert.match(r.itens[0].detalhe, /responsável com acesso de gestão; perfil da empresa criado; cadastro do perfil aplicado/);
    assert.equal(r.itens[0].acao?.href, '/desenvolvedor/empresas/e1#t-convites');
    assert.equal(r.itens[1].severidade, 'MEDIA');
    assert.equal(r.itens[1].acao?.href, '/desenvolvedor/empresas/e2#t-cadastro');
});

test('ordenação estável: severidade, alertas da plataforma antes dos de empresa, o mais antigo (sem data por último), o nome', () => {
    const a = (codigo: Alerta['codigo'], severidade: Alerta['severidade'], desde: string | null, empresa: string): Alerta =>
        ({ codigo, severidade, desde, empresa, empresaId: empresa, titulo: '', detalhe: '', acao: null });
    const r = ordenarAlertas([a('SEM_CADASTRO', 'INFO', null, 'Z'), a('CONVITE_EXPIRADO', 'MEDIA', '2026-10-03', 'B'), a('CONVITE_EXPIRADO', 'MEDIA', '2026-10-01', 'C'), a('SEM_GESTAO', 'ALTA', null, 'A')]);
    assert.deepEqual(r.map((x) => x.empresa), ['A', 'C', 'B', 'Z']);
});

test('alertas só rodam dentro do resumo, depois da concessão conferida na mesma transação', () => {
    const resumo = readFileSync('lib/desenvolvedor/resumo.ts', 'utf8');
    const corpo = resumo.slice(resumo.indexOf('export async function resumoPainel('));
    assert.ok(corpo.indexOf('await exigirDesenvolvedorNaTransacao(tx, sessao);') < corpo.indexOf('await alertasPainel(tx,'));
    const alertas = readFileSync('lib/desenvolvedor/alertas.ts', 'utf8');
    assert.doesNotMatch(alertas, /withTransaction|INSERT |UPDATE |DELETE /);
});
