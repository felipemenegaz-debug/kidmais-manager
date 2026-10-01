'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { obterContextoFechamentoAdministrativo } from '@/lib/fechamentos/services/fechamento-administrativo.service';
import type { FechamentoAdministrativoInput } from '@/lib/fechamentos/administrativo-schema';
import { fechamentoAdministrativoSchema } from '@/lib/fechamentos/administrativo-schema';
import { erroConvidadosFechamento } from '@/lib/fechamentos/convidados';
import type { DisponibilidadeDataPublica } from '@/lib/disponibilidade/services/models';
import CalendarioDisponibilidade from '@/components/fechamento/CalendarioDisponibilidade';
import { PACOTES_FECHAMENTO_V1 } from '@/components/fechamento/data';
import { ENDPOINT_PREPARACOES, enviarPreparado, formularioPreparado, preparacaoValida, reconciliar, type Buscador, type DesfechoEnvio, type PreparacaoAplicada } from './fechamento-preparacao';
import styles from '@/components/fechamento/FechamentoWizard.module.css';

type Contexto = Awaited<ReturnType<typeof obterContextoFechamentoAdministrativo>>;
type Horario = DisponibilidadeDataPublica['periodos'][number]['horarios'][number];
type AdicionalDisponivel = {id:string;nome:string;preco:number;unidadeCobranca:string};
const inicial: FechamentoAdministrativoInput = {
    pacote: 'pocket', dataFesta: '', horarioBase: 'almoco', ajusteHorario: '0', horarioInicio: '', horarioFim: '',
    statusDisponibilidade: 'disponivel', convidadosPagantes: 20, buffetDefinicao: 'depois',
    adicionaisSelecionados: [], valorCombinado: '', aniversarianteId: '', idadeAniversariante: '',
    formaPagamento: 'pix_avista',
};
const buffet = [
    ['buffetSalgados', 'Salgados'], ['buffetBebidas', 'Bebidas'], ['buffetDoces', 'Doces'], ['buffetBolo', 'Bolo'],
    ['buffetOutros', 'Outras preferências'], ['buffetLembrancinha', 'Lembrancinha'], ['buffetEmpratado', 'Empratado'], ['buffetBombom', 'Bombom'],
] as const;

export default function FechamentoAdminWizard({ clienteId, rascunho }: { clienteId: string; rascunho?: string }) {
    const router = useRouter();
    const [contexto, setContexto] = useState<Contexto | null>(null);
    const [form, setForm] = useState(inicial);
    const [adicionaisDisponiveis,setAdicionaisDisponiveis]=useState<AdicionalDisponivel[]|null>(null);
    const [horarios, setHorarios] = useState<Horario[]>([]);
    const [erro, setErro] = useState('');
    const [enviando, setEnviando] = useState(false);
    const [resultado, setResultado] = useState<{ fechamentoId: string; status: string } | null>(null);
    const consultando = useRef(0);
    const envioEmCurso = useRef(false);
    const endpoint = `/api/admin/clientes/${encodeURIComponent(clienteId)}/fechamentos`;

    // Preparação do Kidmais (opcional): só a referência opaca; o envio oficial a confere e consome no servidor.
    const [preparacao, setPreparacao] = useState<PreparacaoAplicada | null>(null);
    const [semPreparacao, setSemPreparacao] = useState(false);
    const [erroPreparacao, setErroPreparacao] = useState(false);
    const [avisoPreparacao, setAvisoPreparacao] = useState('');
    /** Resultado incerto ainda não reconciliado: nenhuma nova criação até o servidor confirmar o que aconteceu. */
    const [incerto, setIncerto] = useState(false);

    useEffect(() => {
        let ativo = true;
        void adminFetch(endpoint).then(async response => {
            const body = await response.json();
            if (!response.ok || !body.ok) throw Error(body.erro ?? 'Não foi possível carregar o cliente.');
            if (ativo) setContexto(body.data);
        }).catch(error => { if (ativo) setErro(error instanceof Error ? error.message : 'Falha ao carregar cliente.'); });
        return () => { ativo = false; };
    }, [endpoint]);

    // Preparação do Kidmais: lida pela rota da IA (somente leitura). Indisponível ⇒ formulário vazio, como sempre.
    useEffect(() => {
        if (!rascunho) return;
        let ativo = true;
        void adminFetch(ENDPOINT_PREPARACOES, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: 'abrir', clienteId, operacaoId: rascunho }) })
            .then(async response => {
                const body = await response.json();
                const p = preparacaoValida(body?.data);
                if (!ativo) return;
                if (!response.ok || !body.ok || !p) return setAvisoPreparacao(typeof body?.erro === 'string' ? body.erro : 'A preparação do Kidmais não está disponível. Preencha o formulário normalmente.');
                if (!p.disponivel) return setAvisoPreparacao(p.motivo);
                const aplicada = formularioPreparado(inicial, p);
                setForm(aplicada.form);
                setPreparacao(aplicada);
                void selecionarData(aplicada.form.dataFesta, aplicada.form.horarioBase, aplicada.horarioDesejado);
            }).catch(() => { if (ativo) setAvisoPreparacao('A preparação do Kidmais não está disponível. Preencha o formulário normalmente.'); });
        return () => { ativo = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- uma vez por preparação; selecionarData usa só os argumentos
    }, [clienteId, rascunho]);

    useEffect(()=>{
        if(!form.dataFesta || !form.pacote || !form.convidadosPagantes)return;
        const controller=new AbortController();
        // Rota com Tenant Context: pacote, preços e adicionais da empresa comprovada pela sessão.
        const url=`/api/admin/fechamentos/adicionais?pacote=${encodeURIComponent(form.pacote)}&data=${encodeURIComponent(form.dataFesta)}&convidados=${form.convidadosPagantes}`;
        void adminFetch(url,{signal:controller.signal})
          .then(async r=>{if(!r.ok)throw Error();return r.json();})
          .then(body=>{
            const disponiveis=body.adicionais as AdicionalDisponivel[];
            setAdicionaisDisponiveis(disponiveis);
            setForm(atual=>({...atual,adicionaisSelecionados:atual.adicionaisSelecionados.filter(id=>disponiveis.some(a=>a.id===id))}));
          }).catch(()=>setAdicionaisDisponiveis(null));
        return ()=>controller.abort();
    },[form.pacote,form.dataFesta,form.convidadosPagantes]);

    function campo<K extends keyof FechamentoAdministrativoInput>(key: K, value: FechamentoAdministrativoInput[K]) {
        setForm(atual => ({ ...atual, [key]: value }));
    }
    function limparAgenda() {
        consultando.current++;
        setHorarios([]);
        setForm(atual => ({ ...atual, dataFesta: '', horarioInicio: '', horarioFim: '' }));
    }
    async function selecionarData(data: string, base: FechamentoAdministrativoInput['horarioBase'] = form.horarioBase, preferido: string | null = null) {
        const sequencia = ++consultando.current;
        setHorarios([]);
        setErro('');
        setForm(atual => ({ ...atual, dataFesta: data, horarioInicio: '', horarioFim: '' }));
        try {
            const response = await fetch(`/api/disponibilidade?data=${encodeURIComponent(data)}`, { cache: 'no-store' });
            const body = await response.json();
            if (!response.ok || !body.ok) throw Error(body.erro ?? 'Falha ao consultar disponibilidade.');
            const dia = body.data as DisponibilidadeDataPublica;
            const opcoes = dia.periodos.find(p => p.codigo === (base === 'almoco' ? 'TURNO_1' : 'TURNO_2'))?.horarios.filter(h => h.status === 'DISPONIVEL') ?? [];
            if (sequencia !== consultando.current) return;
            setHorarios(opcoes);
            // Horário citado na conversa: só pré-seleciona se estiver entre os disponíveis agora (nunca força).
            const desejado = preferido ? opcoes.find(h => h.inicio === preferido) : undefined;
            if (desejado) setForm(atual => ({ ...atual, horarioInicio: desejado.inicio, horarioFim: desejado.fim, ajusteHorario: String(desejado.ajusteMinutos) as typeof atual.ajusteHorario }));
            if (!opcoes.length) throw Error('Horário não disponível. Escolha outra data.');
        } catch (error) { if (sequencia === consultando.current) setErro(error instanceof Error ? error.message : 'Falha de disponibilidade.'); }
    }
    async function concluir(event: FormEvent) {
        event.preventDefault();
        // Incerto: só "Verificar de novo" (reconciliação) libera outra tentativa.
        if (envioEmCurso.current || resultado || incerto) return;
        envioEmCurso.current = true;
        setEnviando(true);
        setErro('');
        try {
            if(adicionaisDisponiveis===null)throw Error('Não foi possível consultar os adicionais deste pacote.');
            const pacote = PACOTES_FECHAMENTO_V1.find(p => p.id === form.pacote);
            const mensagem = erroConvidadosFechamento(form.convidadosPagantes, pacote);
            if (mensagem) throw Error(mensagem);
            const parsed = fechamentoAdministrativoSchema.safeParse(form);
            if (!parsed.success) throw Error('Confira os campos obrigatórios, horário e condição de pagamento.');
            // Com a preparação (com ou sem as conferências dela): o MESMO envio oficial pela rota da IA, sempre com a
            // operação como âncora; resultado incerto é reconciliado antes de qualquer nova tentativa.
            if (preparacao) {
                aplicarDesfecho(await enviarPreparado(adminFetch as unknown as Buscador, { clienteId, referencia: preparacao.referencia, formulario: parsed.data, semPreparacao }));
                return;
            }
            const response = await adminFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data) });
            const body = await response.json();
            if (response.status === 401) {
                router.replace('/admin/login');
                throw Error('Sessão expirada. Faça login novamente.');
            }
            if (!response.ok || !body.ok) throw Error(body.erro ?? 'Não foi possível concluir o Fechamento.');
            setResultado(body.data);
        } catch (error) { setErro(error instanceof Error ? error.message : 'Não foi possível concluir.'); }
        finally { envioEmCurso.current = false; setEnviando(false); }
    }

    function aplicarDesfecho(d: DesfechoEnvio) {
        setIncerto(d.tipo === 'INCERTO');
        if (d.tipo === 'CRIADO') return setResultado(d.data);
        if (d.tipo === 'SESSAO') { router.replace('/admin/login'); return setErro('Sessão expirada. Faça login novamente.'); }
        if (d.tipo === 'RECUSADO' && d.daPreparacao) setErroPreparacao(true);
        setErro(d.erro);
    }
    async function verificarDeNovo() {
        if (!preparacao || envioEmCurso.current) return;
        envioEmCurso.current = true; setEnviando(true);
        try { aplicarDesfecho(await reconciliar(adminFetch as unknown as Buscador, clienteId, preparacao.referencia.operacaoId)); }
        finally { envioEmCurso.current = false; setEnviando(false); }
    }

    if (!contexto) return <main><p role="status">{erro || 'Carregando cliente autorizado…'}</p></main>;
    if (contexto.redirecionadoDe) return <main><h1>Cadastro mesclado</h1><p>Confira o cadastro principal antes de iniciar: {contexto.cliente.nomeCompleto}.</p><Link href={`/admin/clientes/${contexto.cliente.id}/fechamento`}>Abrir cliente principal</Link></main>;
    if (resultado) return <main><h1>Fechamento criado</h1><p>Protocolo: {resultado.fechamentoId}</p><p>Estado: {resultado.status}</p><p>A revisão comercial, o contrato e as assinaturas continuam pelas etapas administrativas próprias.</p><Link href={`/clientes/${clienteId}?tab=eventos`}>Ver contratação no CRM</Link></main>;
    return <main style={{ maxWidth: 1000, margin: '0 auto', padding: 24 }}>
        <h1>Fechamento administrativo</h1>
        <p>Cliente: <strong>{contexto.cliente.nomeCompleto}</strong> — cadastro completo.</p>
        <p>CPF: {contexto.cliente.cpf?.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '***.$2.$3-**')}</p>
        <Link href={`/clientes/${clienteId}`}>Conferir cadastro no CRM</Link>
        {erro && <p role="alert">{erro}</p>}
        {avisoPreparacao && <p role="status">{avisoPreparacao}</p>}
        {preparacao && !semPreparacao && <section aria-label="Preparado pelo Kidmais">
            <p>Preparado pelo Kidmais. Confira, complete e conclua: nada foi gravado até você concluir.</p>
            {preparacao.pendencias.length > 0 && <ul>{preparacao.pendencias.map(p => <li key={p}>{p}</li>)}</ul>}
            {erroPreparacao && !incerto && !semPreparacao && <button type="button" onClick={() => { setSemPreparacao(true); setErroPreparacao(false); setErro(''); }}>Enviar sem a preparação do Kidmais</button>}
            {incerto && <button type="button" onClick={() => void verificarDeNovo()}>Verificar de novo</button>}
        </section>}
        <form onSubmit={concluir}>
            <fieldset disabled={enviando} style={{ border: 0, padding: 0 }}>
                <legend>Condição comercial e evento</legend>
                <label className={styles.field}>Pacote<select value={form.pacote} onChange={e => { limparAgenda(); campo('pacote', e.target.value as typeof form.pacote); }}>
                    {PACOTES_FECHAMENTO_V1.map(p => <option key={p.id} value={p.id} disabled={p.sobConsulta}>{p.nome}{p.sobConsulta ? ' — sob consulta' : ''}</option>)}
                </select></label>
                <CalendarioDisponibilidade pacote={form.pacote} horario={form.horarioBase} dataSelecionada={form.dataFesta}
                    onSelecionar={data => void selecionarData(data)} onTrocarHorario={horario => { limparAgenda(); if (horario) campo('horarioBase', horario); }} />
                <label className={styles.field}>Horário disponível<select required value={form.horarioInicio} onChange={e => {
                    const h = horarios.find(h => h.inicio === e.target.value);
                    if (h) setForm(atual => ({ ...atual, horarioInicio: h.inicio, horarioFim: h.fim, ajusteHorario: String(h.ajusteMinutos) as typeof form.ajusteHorario }));
                }}><option value="">Selecione</option>{horarios.map(h => <option key={h.inicio} value={h.inicio}>{h.inicio}–{h.fim}</option>)}</select></label>
                <label className={styles.field}>Convidados pagantes<input required type="number" min={PACOTES_FECHAMENTO_V1.find(p => p.id === form.pacote)?.minPagantes ?? 1} max={PACOTES_FECHAMENTO_V1.find(p => p.id === form.pacote)?.maxPagantes ?? 150} value={form.convidadosPagantes} onChange={e => campo('convidadosPagantes', Number(e.target.value))} /></label>
                <label className={styles.field}>Aniversariante<select required value={form.aniversarianteId} onChange={e => campo('aniversarianteId', e.target.value)}><option value="">Selecione o cadastro existente</option>{contexto.aniversariantes.map(a => <option key={a.id} value={a.id}>{a.nome}</option>)}</select></label>
                {!contexto.aniversariantes.length && <p>Cadastre o aniversariante no CRM antes de continuar.</p>}
                <label className={styles.field}>Responsável adicional (opcional)<select value={form.responsavelAdicionalId ?? ''} onChange={e => campo('responsavelAdicionalId', e.target.value || null)}><option value="">Nenhum</option>{contexto.responsaveis.map(r => <option key={r.id} value={r.id}>{r.nome}</option>)}</select></label>
                <label className={styles.field}>Idade no evento (opcional)<input type="number" min={0} max={120} value={form.idadeAniversariante} onChange={e => campo('idadeAniversariante', e.target.value === '' ? '' : Number(e.target.value))} /></label>
                <label className={styles.field}>Tema<input maxLength={200} value={form.temaFesta ?? ''} onChange={e => campo('temaFesta', e.target.value)} /></label>
                <label className={styles.field}>Buffet<select value={form.buffetDefinicao} onChange={e => campo('buffetDefinicao', e.target.value as 'agora' | 'depois')}><option value="depois">Definir depois</option><option value="agora">Definir agora</option></select></label>
                {form.buffetDefinicao === 'agora' && buffet.map(([key, label]) => <label className={styles.field} key={key}>{label}<textarea maxLength={2000} value={form[key] ?? ''} onChange={e => campo(key, e.target.value)} /></label>)}
                <fieldset><legend>Adicionais</legend>{form.pacote === 'premium' && <p>Premium inclui 4 bombons. As quantidades abaixo são somente extras, sem compra mínima.</p>}{adicionaisDisponiveis===null?<p>Selecione data, pacote e convidados para consultar os adicionais.</p>:adicionaisDisponiveis.map(a => <label key={a.id} style={{ display: 'block' }}><input type="checkbox" checked={form.adicionaisSelecionados.includes(a.id)} onChange={e => campo('adicionaisSelecionados', e.target.checked ? [...form.adicionaisSelecionados, a.id] : form.adicionaisSelecionados.filter(id => id !== a.id))} />{a.nome} · {a.preco.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}{a.unidadeCobranca === 'UNIDADE' && <> / unidade extra{form.adicionaisSelecionados.includes(a.id) && <input aria-label={`Quantidade extra de ${a.nome}`} type="number" min={1} step={1} value={form.adicionaisQuantidades?.[a.id] ?? 1} onChange={e => campo('adicionaisQuantidades', {...form.adicionaisQuantidades, [a.id]: Number(e.target.value)})}/>}</>}</label>)}</fieldset>
                <label className={styles.field}>Alterações pretendidas do pacote<textarea value={form.alteracoesPacote ?? ''} onChange={e => campo('alteracoesPacote', e.target.value)} /></label>
                <label className={styles.field}>Observações do cliente<textarea value={form.observacoesCliente ?? ''} onChange={e => campo('observacoesCliente', e.target.value)} /></label>
                <label className={styles.field}>Observações da equipe<textarea maxLength={2000} value={form.observacoesEquipe ?? ''} onChange={e => campo('observacoesEquipe', e.target.value)} /></label>
                <label className={styles.field}>Valor comercial proposto (R$)<input required inputMode="decimal" value={form.valorCombinado} onChange={e => campo('valorCombinado', e.target.value)} /></label>
                <label className={styles.field}>Forma de pagamento pretendida<select value={form.formaPagamento} onChange={e => setForm(atual => ({ ...atual, formaPagamento: e.target.value as typeof form.formaPagamento, condicaoPixPretendida: null }))}><option value="pix_avista">PIX à vista</option><option value="pix_parcelado">PIX parcelado</option><option value="cartao_cielo">Cartão Cielo</option></select></label>
                {form.formaPagamento === 'pix_parcelado' && (['entrada', 'valorParcela', 'quantidadeParcelas'] as const).map((key, i) => <label className={styles.field} key={key}>{['Entrada pretendida (R$)', 'Parcela pretendida (R$)', 'Quantidade pretendida'][i]}<input inputMode={key === 'quantidadeParcelas' ? 'numeric' : 'decimal'} value={form.condicaoPixPretendida?.[key] ?? ''} onChange={e => campo('condicaoPixPretendida', { ...form.condicaoPixPretendida, [key]: e.target.value === '' ? null : key === 'quantidadeParcelas' ? Number(e.target.value) : e.target.value.replace(',', '.') })} /></label>)}
                <p>Confira os dados antes de concluir. Os preços serão calculados pelo servidor; negociação e PIX parcelado seguem para revisão comercial quando exigido.</p>
                <button type="submit" disabled={incerto}>{enviando ? 'Concluindo…' : 'Concluir Fechamento'}</button>
            </fieldset>
        </form>
    </main>;
}
