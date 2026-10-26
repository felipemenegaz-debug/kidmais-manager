'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ROTA_AJUDA } from '@/lib/suporte/rota';
import workspace from '@/components/admin/workspace.module.css';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import Assinatura, { reais, type DadosAssinatura } from './Assinatura';
import { dataCurta } from './AvisoComercial';
import type { PlanoComercialId } from '@/lib/assinatura/planos-comerciais';
import { EncerramentoComDevolucao } from './AssinaturaEncerramento';
import { ArrependimentoLegal } from './ArrependimentoLegal';
import { AVISO_VAGAS_EM_CONFIRMACAO, REGRA_RESERVA, regraReservaDaFase, SINTESE_SEM_FUNDADOR, textoPagueAte, textoReservaVencida,
    NOTA_COMPROVANTE_BENEFICIO, textoBeneficioFundador } from '@/lib/assinatura/textos-fundador';
import { linhaContratante } from '@/lib/assinatura/comprovante-texto';

/**
 * Ações de cobrança da tela Assinatura (E8, Asaas sandbox). Só a Gestão contrata ou cancela; a Equipe vê a situação.
 * Assinar devolve a página hospedada de pagamento do provedor. Voltar dela não libera nada: o acesso muda só quando o
 * pagamento é confirmado pelo provedor (webhook + reconsulta no servidor).
 */
type Pagamento = { urlPagamento: string | null; vencimento: string | null; ciclo: 'MENSAL' | 'ANUAL'; reaproveitada: boolean; fundadorValidoAte?: string | null };
const novaChave = () => globalThis.crypto?.randomUUID?.() ?? '';
export const MENSAGEM_PROCESSANDO = 'Processando: o acesso é liberado quando o pagamento for confirmado.';

async function postar<T>(url: string, corpo: unknown): Promise<{ ok: true; data: T } | { ok: false; erro: string; codigo: string | null }> {
    try {
        const r = await adminFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
        const j = await r.json().catch(() => null) as { ok?: boolean; data?: T; erro?: string; codigo?: string } | null;
        return r.ok && j?.ok ? { ok: true, data: j.data as T } : { ok: false, erro: j?.erro ?? `Não foi possível concluir (HTTP ${r.status}).`, codigo: j?.codigo ?? null };
    }
    catch {
        return { ok: false, erro: 'Falha de conexão. Confira a situação antes de repetir.', codigo: null };
    }
}

export function AcoesCobranca({ dados, recarregar }: { dados: DadosAssinatura; recarregar: () => void }) {
    const [ocupado, setOcupado] = useState(false);
    const [erro, setErro] = useState('');
    const [pagamento, setPagamento] = useState<Pagamento | null>(null);
    const [cancelando, setCancelando] = useState(false);
    const [senha, setSenha] = useState('');
    const [motivo, setMotivo] = useState('');
    const [aviso, setAviso] = useState('');
    const [chaveCancelamento, setChaveCancelamento] = useState('');
    const [garantia, setGarantia] = useState<{ valorCentavos: number } | null>(null);
    const [cicloPlano, setCicloPlano] = useState<'MENSAL' | 'ANUAL'>('MENSAL');
    // Grupo B: síntese antes de confirmar (Decreto 7.962/2013; parecer de apoio §2). O pedido só sai em "Confirmar".
    const [sintese, setSintese] = useState<{ ciclo: 'MENSAL' | 'ANUAL'; plano: PlanoComercialId; nome: string; valor: number; regular: number } | null>(null);
    const a = dados.assinatura;
    if (!a)
        return null;
    const precos = dados.precos;
    const cobranca = dados.cobranca;
    const ativaNoProvedor = Boolean(cobranca?.vinculada && cobranca.provedorSituacao === 'ACTIVE');
    const pagando = a.situacao === 'ATIVA' || a.situacao === 'EM_ATRASO';
    const pendenteDeConfirmacao = ativaNoProvedor && !pagando;

    async function assinar(ciclo: 'MENSAL' | 'ANUAL', plano?: PlanoComercialId, valorEsperadoCentavos?: number) {
        setOcupado(true); setErro(''); setAviso('');
        const documentos = dados.contratacao ? Object.fromEntries(dados.contratacao.documentos.map((d) => [d.documento, { versao: d.versao, hash: d.hash }])) : undefined;
        const r = await postar<Pagamento>('/api/admin/assinatura/checkout', { ciclo, ...(plano ? { plano, valorEsperadoCentavos, versao: dados.ofertas?.versao, documentos } : {}) });
        setOcupado(false);
        if (!r.ok) {
            setErro(r.erro);
            // Documentos atualizados enquanto a síntese estava aberta: recarrega para mostrar as versões novas.
            if (r.codigo === 'DOCUMENTOS_ATUALIZADOS') { setSintese(null); recarregar(); }
            return;
        }
        setPagamento(r.data);
        setSintese(null);
        if (!r.data.urlPagamento)
            setAviso(a?.situacao === 'ATIVA' ? 'Sua assinatura está em dia: não há cobrança em aberto.' : 'A cobrança está sendo gerada pelo provedor. Atualize em instantes.');
    }

    async function cancelar() {
        setOcupado(true); setErro('');
        try {
            const auth = await reautenticarSessao(senha);
            if (!auth.ok) { setErro(auth.senhaIncorreta ? 'Senha incorreta. Nada foi alterado.' : auth.erro); return; }
            const r = await postar<{ situacao: string; protocolo: string | null }>('/api/admin/assinatura/cancelamento', { confirmar: true, motivo: motivo.trim(), chave: chaveCancelamento });
            // P2-2: depois de qualquer falha (inclusive o 503 sem confirmação do provedor), a próxima confirmação é uma
            // tentativa NOVA, com chave nova; a mesma chave nunca serve de "confirmação" de um pedido não concluído.
            if (!r.ok) { setErro(r.erro); setChaveCancelamento(novaChave()); return; }
            setCancelando(false);
            // Confirmação imediata com protocolo (089). Sem a 089 no ambiente, o protocolo vem nulo e a mensagem é a de antes.
            const protocolo = r.data.protocolo ? ` Protocolo: ${r.data.protocolo}.` : '';
            setAviso(r.data.situacao === 'CANCELADA_FIM_PERIODO' ? `Assinatura cancelada.${protocolo} O acesso continua até ${a?.periodoAtualFim ? dataCurta(a.periodoAtualFim) : 'o fim do período pago'}.` : `Cancelamento registrado.${protocolo}`);
            recarregar();
        }
        finally {
            setSenha('');
            setOcupado(false);
        }
    }

    /** P3-9: durante a garantia, o formulário de cancelar indica o arrependimento integral (opções calculadas no servidor). */
    async function verGarantia() {
        setGarantia(null);
        try {
            const r = await adminFetch('/api/admin/assinatura/devolucao?opcoes=1');
            const j = await r.json().catch(() => null) as { ok?: boolean; data?: { opcoes?: { arrependimento?: { disponivel?: boolean; valorCentavos?: number } } | null } } | null;
            const o = j?.ok ? j.data?.opcoes?.arrependimento : null;
            if (o?.disponivel && typeof o.valorCentavos === 'number') setGarantia({ valorCentavos: o.valorCentavos });
        }
        catch { /* sem aviso: o formulário continua válido */ }
    }

    const titulo = pagando ? 'Sua assinatura' : 'Contratar';
    return <><section className={workspace.card} aria-labelledby="t-contratar" style={{ maxWidth: 720 }} data-assinatura-acoes>
        <h2 id="t-contratar">{titulo}</h2>
        {erro && <p role="alert">{erro}</p>}
        {aviso && <p role="status">{aviso}</p>}
        {dados.ofertas?.planoAtual && <p>Plano contratado: {dados.ofertas.planoAtual}.</p>}
        {dados.gestao && dados.fundador && textoBeneficioFundador(dados.fundador) && <div role="status" data-beneficio-fundador={dados.fundador.situacao}>
            <p>{textoBeneficioFundador(dados.fundador)}</p>
            <p className={workspace.muted}>{NOTA_COMPROVANTE_BENEFICIO}</p>
        </div>}
        {dados.gestao && dados.renovacao && dados.renovacao.estado !== 'CANCELADA' && <div role="status" data-aviso-renovacao>
            {dados.renovacao.estado === 'REVISAO'
                ? <p>A renovação após o Fundador precisa de revisão pelo atendimento. Confira a situação antes de pagar uma nova cobrança.</p>
                : <p>Após o Fundador, a partir de {dados.renovacao.dataRegular.split('-').reverse().join('/')}, o valor será {reais(dados.renovacao.valorRegular)}/{dados.renovacao.ciclo === 'ANUAL' ? 'ano' : 'mês'}.
                    {dados.renovacao.avisoEnviado ? ' O aviso de renovação foi enviado por e-mail à Gestão que contratou.' : ' O aviso será enviado por e-mail com pelo menos 30 dias de antecedência.'}
                    {' '}Você pode cancelar antes da renovação, preservando o período já pago.</p>}
        </div>}
        {!dados.gestao && <p className={workspace.muted}>Somente a Gestão desta empresa contrata ou cancela a assinatura.</p>}
        {dados.gestao && !cobranca?.disponivel && <>
            {precos && (precos.MENSAL || precos.ANUAL) && <p>{[precos.MENSAL ? `${reais(precos.MENSAL)} por mês` : null, precos.ANUAL ? `${reais(precos.ANUAL)} por ano` : null].filter(Boolean).join(' · ')}</p>}
            <p className={workspace.muted}>A contratação on-line ainda não está disponível neste ambiente. <Link href={ROTA_AJUDA}>Fale com a Kidmais</Link> para assinar.</p>
        </>}
        {dados.gestao && cobranca?.disponivel && pagamento?.urlPagamento && <div data-pagamento-aberto>
            <p>{pagamento.reaproveitada ? 'Há um pagamento em aberto desta assinatura.' : 'Assinatura criada.'}{pagamento.vencimento ? ` Vencimento: ${pagamento.vencimento.split('-').reverse().join('/')}.` : ''} Pague pela página segura do provedor (Pix, boleto ou cartão).</p>
            <p style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: 0 }}>
                <a href={pagamento.urlPagamento} target="_blank" rel="noopener noreferrer">Abrir página de pagamento</a>
                <Link href="/admin/assinatura/retorno">Já paguei — acompanhar confirmação</Link>
            </p>
            {(pagamento.fundadorValidoAte ?? (dados.ofertas?.pendente?.fundadorValidoAte && !dados.ofertas.pendente.fundadorValidoAte.vencida ? dados.ofertas.pendente.fundadorValidoAte.dia : null))
                && <p role="status" data-fundador-validade-link>{textoPagueAte(pagamento.fundadorValidoAte ?? dados.ofertas!.pendente!.fundadorValidoAte!.dia)}</p>}
            <p className={workspace.muted}>{MENSAGEM_PROCESSANDO}</p>
        </div>}
        {dados.gestao && (dados.contratacao?.comprovante || pagamento?.urlPagamento) && <p data-link-comprovante><Link href="/admin/assinatura/comprovante">Ver comprovante da contratação</Link></p>}
        {dados.gestao && cobranca?.disponivel && dados.ofertas?.habilitado && !pagamento?.urlPagamento && <div>
            <p>Escolha o plano para continuar após o teste. O acesso pago depende da confirmação do pagamento.</p>
            {dados.ofertas.fundador && <p>Fundador: 40% de desconto por 12 meses. Depois, renovação pelo preço normal, com aviso prévio.</p>}
            {dados.ofertas.fundador && dados.ofertas.campanha?.fase === 'JANELA' && <p>Condição válida para quem assinar {dados.ofertas.campanha.prazo.texto}. {REGRA_RESERVA}</p>}
            {dados.ofertas.pendente?.fundadorValidoAte && (dados.ofertas.pendente.fundadorValidoAte.vencida
                ? <p role="alert" data-fundador-vencido>{textoReservaVencida(dados.ofertas.pendente.fundadorValidoAte.dia)}</p>
                : <p role="status" data-fundador-validade>{textoPagueAte(dados.ofertas.pendente.fundadorValidoAte.dia)}</p>)}
            {dados.ofertas.fundador && dados.ofertas.campanha?.fase === 'POS_JANELA' && <p>Restam {dados.ofertas.campanha.vagasRestantes} vagas Fundador (indicativo). A vaga fica reservada ao assinar e o benefício é confirmado com o primeiro pagamento.</p>}
            {sintese && <div role="region" aria-label="Confira sua contratação" data-sintese>
                <h3>Confira sua contratação</h3>
                <ul>
                    <li>Prestadora: {dados.contratacao?.fornecedora ?? '—'}.</li>
                    <li>Contratante: {dados.contratacao ? linhaContratante(dados.contratacao.contratante) : '—'}.</li>
                    <li>Plano {sintese.nome}, {sintese.ciclo === 'ANUAL' ? 'anual (pagamento único, valor de 10 mensalidades)' : 'mensal'}: {reais(sintese.valor)}/{sintese.ciclo === 'ANUAL' ? 'ano' : 'mês'}{sintese.ciclo === 'ANUAL' ? `, total do ano ${reais(sintese.valor)}` : ''}.</li>
                    {!dados.ofertas.fundador && dados.ofertas.aguardandoVaga && <li data-sintese-sem-fundador>{SINTESE_SEM_FUNDADOR}</li>}
                    {dados.ofertas.fundador && <li>Condição Fundador: 40% de desconto por 12 meses sobre {reais(sintese.regular)}/{sintese.ciclo === 'ANUAL' ? 'ano' : 'mês'}; depois, o preço vigente do plano, com aviso de pelo menos 30 dias. {regraReservaDaFase(dados.ofertas.campanha?.fase)}</li>}
                    <li>Renovação: a assinatura renova ao fim de cada ciclo, no mesmo plano e ciclo, até você cancelar.</li>
                    <li>Cancelamento e devolução: <Link href="/termos#cancelamento" target="_blank">Termos de uso, seção “Cancelamento e devolução”</Link>. Seus direitos legais permanecem preservados.</li>
                    <li>Documentos: {(dados.contratacao?.documentos ?? []).map((d, i) => <span key={d.documento}>{i ? ' · ' : ''}<Link href={d.rota} target="_blank">{d.titulo} (versão {d.versao})</Link></span>)}.</li>
                </ul>
                <p className={workspace.muted}>Você pode voltar e corrigir a escolha antes de confirmar. Ao confirmar, a oferta é registrada e o comprovante fica disponível aqui.</p>
                <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <button type="button" disabled={ocupado} onClick={() => void assinar(sintese.ciclo, sintese.plano, sintese.valor)}>{ocupado ? 'Abrindo…' : 'Confirmar contratação'}</button>
                    <button type="button" disabled={ocupado} onClick={() => setSintese(null)}>Voltar</button>
                </p>
            </div>}
            {sintese ? null : <>
                {dados.ofertas.aguardandoVaga && <p role="status" data-vagas-em-confirmacao>{AVISO_VAGAS_EM_CONFIRMACAO}</p>}
                <label>Ciclo <select value={cicloPlano} onChange={e => setCicloPlano(e.target.value as 'MENSAL' | 'ANUAL')} disabled={ocupado || Boolean(dados.ofertas.pendente)}>
                    <option value="MENSAL">Mensal</option><option value="ANUAL">Anual — pagamento único, valor de 10 mensalidades</option>
                </select></label>
                {dados.ofertas.pendente ? <p><button type="button" disabled={ocupado} onClick={() => {
                    const p = dados.ofertas!.pendente!; void assinar(p.ciclo,p.plano,p.valorCentavos);
                }}>{ocupado ? 'Abrindo…' : `Retomar ${dados.ofertas.pendente.plano} — ${reais(dados.ofertas.pendente.valorCentavos)}`}</button></p> :
                dados.ofertas.planos.map(p => <p key={p.id}><button type="button" disabled={ocupado} onClick={() => setSintese({ ciclo: cicloPlano, plano: p.id, nome: p.nome,
                    valor: cicloPlano === 'ANUAL' ? p.anual : p.mensal, regular: cicloPlano === 'ANUAL' ? p.anualRegular : p.mensalRegular })}>
                    {ocupado ? 'Abrindo…' : `Assinar ${p.nome} — ${reais(cicloPlano === 'ANUAL' ? p.anual : p.mensal)}/${cicloPlano === 'ANUAL' ? 'ano' : 'mês'}`}
                </button>{dados.ofertas?.fundador && <small style={{ display: 'block' }}>
                    Após 12 meses: {reais(cicloPlano === 'ANUAL' ? p.anualRegular : p.mensalRegular)}/{cicloPlano === 'ANUAL' ? 'ano' : 'mês'}, com aviso prévio.
                </small>}</p>)}
            </>}
        </div>}
        {dados.gestao && cobranca?.disponivel && dados.ofertas?.bloqueio && !pagamento?.urlPagamento && <p role="status">{dados.ofertas.bloqueio.mensagem}</p>}
        {dados.gestao && cobranca?.disponivel && !dados.ofertas?.habilitado && !pagamento?.urlPagamento && <>
            {(a.situacao === 'EM_ATRASO' || pendenteDeConfirmacao) && a.ciclo
                ? <p><button type="button" disabled={ocupado} onClick={() => void assinar(a.ciclo as 'MENSAL' | 'ANUAL')}>{ocupado ? 'Abrindo…' : 'Continuar pagamento'}</button></p>
                : !ativaNoProvedor && !dados.ofertas?.planoAtual && <>
                    {precos && (precos.MENSAL || precos.ANUAL)
                        ? <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: 0 }}>
                            {precos.MENSAL && <button type="button" disabled={ocupado} onClick={() => void assinar('MENSAL')}>Assinar mensal — {reais(precos.MENSAL)}/mês</button>}
                            {precos.ANUAL && <button type="button" disabled={ocupado} onClick={() => void assinar('ANUAL')}>Assinar anual — {reais(precos.ANUAL)}/ano</button>}
                        </p>
                        : <p className={workspace.muted}>Os planos ainda não estão publicados neste ambiente.</p>}
                </>}
            {a.situacao === 'ATIVA' && ativaNoProvedor && <p className={workspace.muted}>Renovação automática pelo provedor. Cada cobrança chega pela página de pagamento do provedor.</p>}
            {!ativaNoProvedor && dados.ofertas?.planoAtual && <p>A assinatura mantém seu histórico. Para recontratar ou mudar de plano, <Link href={ROTA_AJUDA}>fale com o atendimento</Link>.</p>}
        </>}
        {dados.gestao && cobranca?.disponivel && pagando && ativaNoProvedor && !cancelando && <p>
            <button type="button" className="danger" disabled={ocupado} onClick={() => { setCancelando(true); setChaveCancelamento(novaChave()); setErro(''); setAviso(''); void verGarantia(); }}>Cancelar ao fim do período…</button>
        </p>}
        {cancelando && <form onSubmit={(e) => { e.preventDefault(); if (senha) void cancelar(); }} data-cancelamento>
            <p>Sem multa. A renovação é cancelada e o acesso completo continua até {a.periodoAtualFim ? dataCurta(a.periodoAtualFim) : 'o fim do período pago'}. Depois disso a empresa fica em somente leitura por 60 dias, com exportação. Cobranças em aberto são removidas; nada é apagado. Você recebe um protocolo na hora.</p>
            {garantia && <p role="note" data-aviso-garantia><strong>Você está nos 7 dias da primeira ativação paga.</strong> Em vez de cancelar só a renovação, você pode desistir com devolução integral de {reais(garantia.valorCentavos)} na seção “Cancelamento e devolução”, logo abaixo.</p>}
            <label>Motivo (opcional)<input value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} /></label>
            <label>Sua senha<input type="password" autoComplete="current-password" value={senha} disabled={ocupado} onChange={(e) => setSenha(e.target.value)} required /></label>
            <p style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <button type="submit" className="danger" disabled={ocupado || !senha}>{ocupado ? 'Cancelando…' : 'Confirmar cancelamento'}</button>
                <button type="button" disabled={ocupado} onClick={() => { setCancelando(false); setSenha(''); }}>Voltar</button>
            </p>
        </form>}
    </section>
    <EncerramentoComDevolucao dados={dados} recarregar={recarregar} />
    <ArrependimentoLegal dados={dados} />

    <section className={workspace.card} aria-labelledby="t-creditos-link" style={{ maxWidth: 720 }} data-creditos-link>
        <h2 id="t-creditos-link">Créditos de IA</h2>
        <p className={workspace.muted}>Créditos de convite e do WhatsApp.AI são comprados à parte da assinatura, com pedidos, devoluções e extrato próprios.</p>
        <p><Link href="/admin/configuracoes/creditos">Ver créditos de IA</Link></p>
    </section></>;
}

/** Tela Assinatura com as ações de cobrança (componente cliente: a página de servidor não passa funções). */
export default function AssinaturaComAcoes() {
    return <Assinatura acoes={(dados, recarregar) => <AcoesCobranca dados={dados} recarregar={recarregar} />} />;
}
