import { randomUUID } from 'node:crypto';
import type { MensagemEmail, EnviarEmail } from '../acessos/email.ts';
import { cicloDoProvedor, type AssinaturaProvedor, type CobrancaProvedor, type ProvedorRenovacao } from './asaas.ts';
import type { Ciclo } from './configuracao.ts';

export const AVISO_FUNDADOR_DIAS = 30;
export type EstadoRenovacao = 'PENDENTE' | 'AVISANDO' | 'AVISADA' | 'APLICANDO' | 'REGULAR' | 'REVISAO' | 'CANCELADA';
export type RegistroRenovacao = {
    id: string; empresaId: string; contratacaoId: string; destinatarioId: string; primeiroVencimento: string;
    primeiraDataRegular: string; mensagem: MensagemEmail; estado: EstadoRenovacao;
    avisoTentadoEm: string | null; avisoEnviadoEm: string | null; precoAplicadoEm: string | null; ultimoErro: string | null;
};
export type ContextoRenovacao = {
    empresaId: string; contratacaoId: string; situacao: string; empresaAtiva: boolean; isenta: boolean;
    assinaturaId: string; clienteId: string; ciclo: Ciclo; plano: string; valorFinal: number; valorRegular: number;
    beneficioFim: string; primeiroPagamentoId: string; destinatarioId: string; email: string; destinatarioValido: boolean;
    registro: RegistroRenovacao | null;
};
export type AlteracaoRenovacao = { estado: EstadoRenovacao; erro?: string | null; tentativa?: boolean; envioId?: string; regular?: boolean };
export type RepositorioRenovacao = {
    ler(empresaId: string): Promise<ContextoRenovacao | null>;
    criar(registro: RegistroRenovacao): Promise<RegistroRenovacao>;
    marcar(empresaId: string, id: string, alteracao: AlteracaoRenovacao): Promise<void>;
};
export type DepsRenovacao = {
    repositorio: RepositorioRenovacao; provedor: ProvedorRenovacao; enviar: EnviarEmail; origem: string;
    agora: () => Date; simular: boolean;
    travar: <T>(empresaId: string, trabalho: () => Promise<T>) => Promise<T>;
};

export function dataValida(data: string | null | undefined): data is string {
    return typeof data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data) && Number.isFinite(Date.parse(data))
        && new Date(data).toISOString().slice(0,10) === data;
}
export function diaBrasil(data: Date) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(data); }
export function diasAntes(data: string, dias = AVISO_FUNDADOR_DIAS) {
    if (!dataValida(data)) throw new Error('Data de renovação inválida.');
    return new Date(Date.parse(data) - dias * 86400000).toISOString().slice(0,10);
}
/** Preserva o dia âncora (31/jan → 28/fev → 31/mar), sem desvio acumulado. */
function mesesDepois(data: string, meses: number) {
    const [ano, mes, dia] = data.split('-').map(Number);
    const alvo = new Date(Date.UTC(ano, mes - 1 + meses, 1));
    const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
    alvo.setUTCDate(Math.min(dia, ultimo)); return alvo.toISOString().slice(0,10);
}
export function primeiraRenovacaoRegular(primeiroVencimento: string, beneficioFim: string, ciclo: Ciclo) {
    const fim = beneficioFim.slice(0,10);
    if (!dataValida(primeiroVencimento) || !dataValida(fim)) throw new Error('Vigência inválida.');
    if (ciclo === 'ANUAL') return mesesDepois(primeiroVencimento, 12);
    for (let meses = 1; meses <= 120; meses++) {
        const candidata = mesesDepois(primeiroVencimento, meses);
        if (candidata >= fim) return candidata;
    }
    throw new Error('Vigência fora da faixa suportada.');
}
const reais = (n: number) => (n / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const escapar = (s: string) => s.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]!));
export function mensagemRenovacao(c: ContextoRenovacao, id: string, data: string, origem: string): MensagemEmail {
    const u = new URL(origem);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))) throw new Error('Origem de aviso inválida.');
    const link = `${u.origin}/admin/assinatura`;
    const texto = `Seu benefício Fundador do Kidmais Manager está terminando. A partir do vencimento ${data.split('-').reverse().join('/')}, o plano ${c.plano} renova por ${reais(c.valorRegular)} por ${c.ciclo === 'ANUAL' ? 'ano' : 'mês'}, em lugar de ${reais(c.valorFinal)}.\n\nVocê pode acompanhar a assinatura ou cancelar a renovação antes desse vencimento em ${link}. O cancelamento preserva o acesso até o fim do período pago.`;
    return { para: c.email, assunto: 'Kidmais Manager: renovação após o benefício Fundador', texto,
        html: `<p>${escapar(texto).replace(/\n\n/g,'</p><p>')}</p>`, idempotencia: `kidmais-renovacao/${id}` };
}
function identidade(c: ContextoRenovacao, s: AssinaturaProvedor | null) {
    return s && s.id === c.assinaturaId && s.externalReference === c.empresaId && s.customer === c.clienteId && cicloDoProvedor(s.cycle) === c.ciclo;
}
function identidadePagamento(c: ContextoRenovacao, p: CobrancaProvedor | null) {
    return p && p.assinaturaId === c.assinaturaId && p.clienteId === c.clienteId && dataValida(p.dueDate);
}
const vigente = (c: ContextoRenovacao) => !c.isenta && c.empresaAtiva && ['ATIVA','EM_ATRASO'].includes(c.situacao);

/** Chamador serializa pela mesma trava da contratação. Intenções são commitadas antes da rede. */
export async function processarRenovacao(empresaId: string, deps: DepsRenovacao) {
    return deps.travar(empresaId, async () => {
        const repo = deps.repositorio, p = deps.provedor;
        let c = await repo.ler(empresaId);
        if (!c) return 'SEM_FUNDADOR';
        let r = c.registro;
        const marcar = async (a: AlteracaoRenovacao) => { if (!deps.simular && r) await repo.marcar(empresaId, r.id, a); };
        if (!vigente(c)) {
            if (r?.estado === 'REVISAO') return 'REVISAO_NECESSARIA';
            await marcar({ estado: 'CANCELADA' }); return 'CANCELADA';
        }
        if (r?.estado === 'CANCELADA') return 'CANCELADA';
        const hoje = diaBrasil(deps.agora());
        if (r?.estado === 'PENDENTE' && hoje < diasAntes(r.primeiraDataRegular)) return 'AGUARDANDO_AVISO';
        let s = await p.obterAssinatura(c.assinaturaId);
        if (!identidade(c,s)) { await marcar({ estado: 'REVISAO', erro: 'IDENTIDADE_DIVERGENTE' }); return 'IDENTIDADE_DIVERGENTE'; }
        if (s!.deleted || s!.status !== 'ACTIVE') {
            if (!s!.deleted && r?.estado === 'REVISAO') return r.ultimoErro ?? 'REVISAO_NECESSARIA';
            await marcar({ estado: 'CANCELADA' }); return 'CANCELADA';
        }
        if (!r) {
            const primeiro = await p.obterCobranca(c.primeiroPagamentoId);
            if (!identidadePagamento(c,primeiro) || primeiro!.deleted || !['RECEIVED','CONFIRMED'].includes(primeiro!.status)
                || primeiro!.valorCentavos !== c.valorFinal) {
                if (!deps.simular && dataValida(s!.nextDueDate) && s!.nextDueDate >= c.beneficioFim.slice(0,10)
                    && hoje >= diasAntes(c.beneficioFim.slice(0,10))) await p.suspenderGeracao(c.assinaturaId);
                return 'PRIMEIRO_PAGAMENTO_DIVERGENTE';
            }
            const data = primeiraRenovacaoRegular(primeiro!.dueDate, c.beneficioFim, c.ciclo), id = randomUUID();
            r = { id, empresaId, contratacaoId: c.contratacaoId, destinatarioId: c.destinatarioId, primeiroVencimento: primeiro!.dueDate,
                primeiraDataRegular: data, mensagem: mensagemRenovacao(c,id,data,deps.origem), estado: 'PENDENTE',
                avisoTentadoEm: null, avisoEnviadoEm: null, precoAplicadoEm: null, ultimoErro: null };
            if (!deps.simular) r = await repo.criar(r);
        }
        const revisao = async (erro: string) => {
            await marcar({ estado: 'REVISAO', erro });
            // Evita gerar desconto indefinidamente quando a janela de aviso foi perdida.
            // Não reativa, não apaga cobrança existente, não encurta acesso já pago.
            s = await p.obterAssinatura(c!.assinaturaId);
            if (identidade(c!,s) && !s!.deleted && s!.status === 'ACTIVE'
                && ((dataValida(s!.nextDueDate) && s!.nextDueDate >= r!.primeiraDataRegular)
                    || ['PRECO_PROVEDOR_DIVERGENTE','PROXIMO_VENCIMENTO_INVALIDO'].includes(erro)) && !deps.simular)
                await p.suspenderGeracao(c!.assinaturaId);
            return erro;
        };
        if (r.estado === 'REVISAO') return revisao(r.ultimoErro ?? 'REVISAO_NECESSARIA');
        const limiteAviso = diasAntes(r.primeiraDataRegular);
        if (!r.avisoEnviadoEm) {
            if (hoje < limiteAviso) return 'AGUARDANDO_AVISO';
            if (hoje > limiteAviso) return revisao('JANELA_AVISO_PERDIDA');
            if (!c.destinatarioValido || c.destinatarioId !== r.destinatarioId || c.email !== r.mensagem.para)
                return revisao('DESTINATARIO_ALTERADO');
            if (r.avisoTentadoEm && deps.agora().getTime() - Date.parse(r.avisoTentadoEm) >= 23 * 3600000)
                return revisao('ENVIO_INCERTO_FORA_JANELA');
            if (deps.simular) return 'ENVIARIA_AVISO';
            await marcar({ estado: 'AVISANDO', tentativa: true, erro: null });
            // Payload e chave imutáveis; após 23 h não há retry cego (retenção Resend: 24 h).
            try {
                const envio = await deps.enviar(r.mensagem);
                if (!envio.idExterno?.trim() || envio.idExterno.length > 120) throw new Error('Envio sem identificador.');
                await marcar({ estado: 'AVISADA', envioId: envio.idExterno, erro: null });
            } catch {
                await marcar({ estado: 'AVISANDO', erro: 'ENVIO_INCERTO' }); return 'ENVIO_INCERTO';
            }
            c = await repo.ler(empresaId);
            if (!c || !vigente(c)) return 'CANCELADA';
            r = c.registro!;
        }
        if (!r.avisoEnviadoEm || diaBrasil(new Date(r.avisoEnviadoEm)) > limiteAviso) return revisao('AVISO_FORA_PRAZO');
        // Reconsulta após envio e antes de qualquer aumento. Somente valor: nunca status ACTIVE.
        s = await p.obterAssinatura(c.assinaturaId);
        if (!identidade(c,s)) return revisao('IDENTIDADE_DIVERGENTE');
        if (s!.deleted || s!.status !== 'ACTIVE') { await marcar({ estado: 'CANCELADA' }); return 'CANCELADA'; }
        if (!dataValida(s!.nextDueDate)) return revisao('PROXIMO_VENCIMENTO_INVALIDO');
        if (s!.nextDueDate < r.primeiraDataRegular)
            return s!.valorCentavos === c.valorFinal ? 'AGUARDANDO_ULTIMA_PARCELA' : revisao('PRECO_PROVEDOR_DIVERGENTE');
        const pagamentos = await p.listarCobrancasDaAssinatura(c.assinaturaId);
        const futuras = pagamentos.filter(x => !x.deleted && x.dueDate >= r!.primeiraDataRegular);
        for (const x of futuras) {
            if (!identidadePagamento(c,x) || ![c.valorFinal,c.valorRegular].includes(x.valorCentavos ?? -1)) return revisao('COBRANCA_DIVERGENTE');
            if (x.valorCentavos !== c.valorRegular && !['PENDING','OVERDUE'].includes(x.status)) return revisao('COBRANCA_JA_PROCESSADA');
        }
        if (![c.valorFinal,c.valorRegular].includes(s!.valorCentavos ?? -1)) return revisao('PRECO_PROVEDOR_DIVERGENTE');
        if (deps.simular) return s!.valorCentavos === c.valorRegular && futuras.every(x => x.valorCentavos === c!.valorRegular) ? 'REGULAR' : 'ATUALIZARIA_PRECO';
        if (r.estado !== 'REGULAR') await marcar({ estado: 'APLICANDO', erro: null });
        // Retry após resposta perdida relê o valor, então só repete se ainda necessário.
        if (s!.valorCentavos !== c.valorRegular) await p.atualizarValorAssinatura(c.assinaturaId,c.valorRegular);
        for (const x of futuras) {
            const atual = await p.obterCobranca(x.id);
            if (!identidadePagamento(c,atual) || atual!.deleted || atual!.dueDate !== x.dueDate) return revisao('COBRANCA_ALTERADA');
            if (atual!.valorCentavos === c.valorRegular) continue;
            if (atual!.valorCentavos !== c.valorFinal || !['PENDING','OVERDUE'].includes(atual!.status)) return revisao('COBRANCA_JA_PROCESSADA');
            await p.atualizarValorCobranca(atual!,c.valorRegular);
        }
        const confirmacao = await p.obterAssinatura(c.assinaturaId);
        const parcelas = await p.listarCobrancasDaAssinatura(c.assinaturaId);
        if (!identidade(c,confirmacao) || confirmacao!.deleted || confirmacao!.status !== 'ACTIVE') { await marcar({ estado: 'CANCELADA' }); return 'CANCELADA'; }
        if (confirmacao!.valorCentavos !== c.valorRegular || parcelas.some(x => !x.deleted && x.dueDate >= r!.primeiraDataRegular
            && (!identidadePagamento(c!,x) || x.valorCentavos !== c!.valorRegular))) return 'AGUARDANDO_CONFIRMACAO_PRECO';
        await marcar({ estado: 'REGULAR', regular: true, erro: null }); return 'REGULAR';
    });
}
