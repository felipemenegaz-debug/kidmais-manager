import type { Metadata } from 'next';
import Link from 'next/link';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import { fonteAdmin } from '@/components/admin/fonte';
import tokens from '@/components/admin/tokens.module.css';
import { duracaoTesteDias, precoDoCiclo } from '@/lib/assinatura/configuracao';
import { situacaoCadastro } from '@/lib/cadastro/publico';

export const metadata: Metadata = { title: 'Planos — Kidmais Manager', description: 'Gestão de buffet infantil: clientes, contratos, festas, agenda e financeiro.' };
export const dynamic = 'force-dynamic';

const reais = (centavos: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(centavos / 100);

/**
 * Página comercial pública. Preço e duração do teste vêm só da configuração (nada inventado): sem preço configurado a
 * página diz "a definir". O botão de cadastro só aparece com o cadastro público aberto.
 */
export default function Planos() {
    let mensal: number | null = null, anual: number | null = null, testeDias: number | null = null;
    try {
        mensal = precoDoCiclo('MENSAL');
        anual = precoDoCiclo('ANUAL');
        testeDias = duracaoTesteDias();
    }
    catch {
        // Configuração inválida: mostra "a definir".
    }
    const aberto = situacaoCadastro().ativo;
    const recursos = ['Clientes e aniversariantes', 'Contratos com assinatura do cliente', 'Festas, tarefas e equipe', 'Agenda e disponibilidade', 'Contas a receber e a pagar', 'Pix copia e cola nas parcelas', 'Acesso para a equipe com papéis por empresa', 'Exportação dos seus dados a qualquer momento'];
    return <div className={`${fonteAdmin.variable} ${tokens.tema}`} style={{ minHeight: '100svh' }}>
        <main className={admin.page} style={{ maxWidth: 960, margin: '0 auto' }} data-planos>
            <p className={workspace.muted} style={{ textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 800, fontSize: 12 }}>Kidmais Manager</p>
            <h1>A gestão do seu buffet infantil em um só lugar</h1>
            <p>Do primeiro contato com o cliente ao fechamento financeiro da festa.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginTop: 24 }}>
                <section className={workspace.card} aria-labelledby="t-plano">
                    <h2 id="t-plano">Plano Kidmais</h2>
                    <p>Um plano por empresa (uma unidade), com tudo incluído.</p>
                    <p style={{ fontSize: 22, fontWeight: 800, margin: '8px 0' }}>
                        {mensal ? `${reais(mensal)}/mês` : 'Preço a definir'}
                    </p>
                    {anual && <p className={workspace.muted}>ou {reais(anual)}/ano</p>}
                    <p>{testeDias ? `${testeDias} dias grátis` : 'Teste grátis'}, sem cartão e sem cobrança automática.</p>
                    {aberto ? <Link href="/cadastro" style={{ display: 'inline-block', marginTop: 8, fontWeight: 800 }}>Começar o teste grátis</Link>
                        : <p className={workspace.muted}>O cadastro on-line abre em breve. Fale com a Kidmais para começar.</p>}
                </section>
                <section className={workspace.card} aria-labelledby="t-inclui">
                    <h2 id="t-inclui">O que está incluído</h2>
                    <ul>{recursos.map((r) => <li key={r}>{r}</li>)}</ul>
                </section>
            </div>
            <section className={workspace.card} style={{ marginTop: 16 }} aria-labelledby="t-teste">
                <h2 id="t-teste">Como funciona o teste</h2>
                <ul>
                    <li>Você cria a conta, confirma o e-mail e cadastra a empresa pelo CNPJ.</li>
                    <li>Durante o teste, tudo funciona. Nada é cobrado automaticamente.</li>
                    <li>Se não assinar, a empresa passa a somente leitura e depois fica suspensa. Seus dados não são apagados por vencimento e podem ser exportados.</li>
                </ul>
            </section>
            <p style={{ marginTop: 24 }}><Link href="/termos">Termos de uso</Link> · <Link href="/privacidade">Privacidade</Link> · <Link href="/admin/login">Entrar</Link></p>
        </main>
    </div>;
}
