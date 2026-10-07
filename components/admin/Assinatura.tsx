'use client';
import { useEffect, useState } from 'react';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import { adminFetch } from '@/lib/http/admin-fetch';
import { dataCurta, diasAte } from './AvisoComercial';

export type DadosAssinatura = {
    instalado: boolean; cobrado: boolean; gestao: boolean; agora: string;
    acesso: { nivel: 'COMPLETO' | 'SOMENTE_LEITURA' | 'BLOQUEADO'; motivo: string; ate: string | null };
    assinatura: { situacao: string; ciclo: 'MENSAL' | 'ANUAL' | null; testeInicio: string; testeFim: string; periodoAtualFim: string | null; emAtrasoDesde: string | null; encerradaEm: string | null } | null;
    excecoes: { tipo: string; validaAte: string }[];
    precos: { MENSAL: number | null; ANUAL: number | null } | null;
};

const SITUACAO: Record<string, string> = {
    TESTE: 'Teste grátis', ATIVA: 'Assinatura ativa', EM_ATRASO: 'Pagamento pendente', CANCELADA_FIM_PERIODO: 'Cancelada (acesso até o fim do período)', ENCERRADA: 'Encerrada',
};
const NIVEL: Record<DadosAssinatura['acesso']['nivel'], string> = { COMPLETO: 'Completo', SOMENTE_LEITURA: 'Somente leitura (consulta e exportação)', BLOQUEADO: 'Suspenso até a assinatura' };
const EXCECAO: Record<string, string> = { CORTESIA: 'Cortesia', ACESSO_TEMPORARIO: 'Acesso temporário' };
export const reais = (centavos: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(centavos / 100);

export default function Assinatura({ acoes }: { acoes?: (dados: DadosAssinatura, recarregar: () => void) => React.ReactNode }) {
    const [dados, setDados] = useState<DadosAssinatura | null>(null);
    const [erro, setErro] = useState('');
    const [versao, setVersao] = useState(0);
    useEffect(() => {
        let vivo = true;
        adminFetch('/api/admin/assinatura').then(async (r) => {
            const corpo = await r.json().catch(() => null) as { ok?: boolean; data?: DadosAssinatura; erro?: string } | null;
            if (!vivo) return;
            if (r.ok && corpo?.ok && corpo.data) setDados(corpo.data);
            else setErro(corpo?.erro ?? 'Não foi possível carregar a assinatura.');
        }).catch(() => { if (vivo) setErro('Falha de conexão. Tente novamente.'); });
        return () => { vivo = false; };
    }, [versao]);
    const a = dados?.assinatura;
    return <main className={admin.page} data-assinatura-page>
        <h1>Assinatura</h1>
        {erro && <p role="alert">{erro}</p>}
        {!dados && !erro && <p className={workspace.muted} aria-live="polite">Carregando…</p>}
        {dados && !dados.cobrado && <section className={workspace.card} aria-labelledby="t-sem-cobranca" style={{ maxWidth: 720 }}>
            <h2 id="t-sem-cobranca">Sem cobrança</h2>
            <p className={workspace.muted}>Esta empresa não tem assinatura registrada no Kidmais Manager. O acesso é completo.</p>
        </section>}
        {dados && a && <section className={workspace.card} aria-labelledby="t-situacao" style={{ maxWidth: 720 }}>
            <h2 id="t-situacao">{SITUACAO[a.situacao] ?? a.situacao}</h2>
            <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, margin: 0 }}>
                <div><dt className={workspace.muted}>Acesso</dt><dd style={{ margin: 0 }}>{NIVEL[dados.acesso.nivel]}{dados.acesso.ate ? ` até ${dataCurta(dados.acesso.ate)} (${diasAte(dados.acesso.ate, dados.agora)} dia(s))` : ''}</dd></div>
                {a.situacao === 'TESTE' && <div><dt className={workspace.muted}>Teste grátis</dt><dd style={{ margin: 0 }}>{dataCurta(a.testeInicio)} a {dataCurta(a.testeFim)}</dd></div>}
                {a.ciclo && <div><dt className={workspace.muted}>Plano</dt><dd style={{ margin: 0 }}>{a.ciclo === 'MENSAL' ? 'Mensal' : 'Anual'}</dd></div>}
                {a.periodoAtualFim && <div><dt className={workspace.muted}>Período pago até</dt><dd style={{ margin: 0 }}>{dataCurta(a.periodoAtualFim)}</dd></div>}
                {a.emAtrasoDesde && <div><dt className={workspace.muted}>Pendente desde</dt><dd style={{ margin: 0 }}>{dataCurta(a.emAtrasoDesde)}</dd></div>}
                {a.encerradaEm && <div><dt className={workspace.muted}>Encerrada em</dt><dd style={{ margin: 0 }}>{dataCurta(a.encerradaEm)}</dd></div>}
            </dl>
            {dados.excecoes.length > 0 && <p>{dados.excecoes.map((e) => `${EXCECAO[e.tipo] ?? e.tipo} até ${dataCurta(e.validaAte)}`).join(' · ')}</p>}
            <h3>O que acontece depois</h3>
            <ul className={workspace.muted}>
                <li>Quando o acesso completo termina sem assinatura, a empresa entra em <strong>somente leitura</strong>: dá para consultar e exportar, mas não criar nem alterar.</li>
                <li>Depois do prazo de consulta, o acesso fica suspenso até a assinatura. <strong>Nenhum dado é apagado por vencimento.</strong></li>
                <li>Assinar a qualquer momento devolve o acesso completo, sem perda de dados.</li>
            </ul>
        </section>}
        {dados && dados.gestao && <section className={workspace.card} aria-labelledby="t-exportar" style={{ maxWidth: 720 }}>
            <h2 id="t-exportar">Exportar dados</h2>
            <p className={workspace.muted}>Arquivos CSV com os dados desta empresa. Disponível em qualquer situação da assinatura.</p>
            <p style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: 0 }}>
                <a href="/api/admin/exportacao?tipo=clientes" download>Clientes (CSV)</a>
                <a href="/api/admin/exportacao?tipo=contas-receber" download>Contas a receber (CSV)</a>
            </p>
        </section>}
        {dados && a && (acoes ? acoes(dados, () => setVersao((v) => v + 1)) : <section className={workspace.card} aria-labelledby="t-contratar" style={{ maxWidth: 720 }}>
            <h2 id="t-contratar">Contratar</h2>
            {dados.precos && (dados.precos.MENSAL || dados.precos.ANUAL)
                ? <p>{[dados.precos.MENSAL ? `${reais(dados.precos.MENSAL)} por mês` : null, dados.precos.ANUAL ? `${reais(dados.precos.ANUAL)} por ano` : null].filter(Boolean).join(' · ')}</p>
                : <p className={workspace.muted}>Os planos ainda não estão publicados neste ambiente.</p>}
            <p className={workspace.muted}>A contratação on-line ainda não está disponível. Fale com a Kidmais para assinar.</p>
        </section>)}
    </main>;
}
