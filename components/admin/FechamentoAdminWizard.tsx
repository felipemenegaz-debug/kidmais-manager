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
import styles from '@/components/fechamento/FechamentoWizard.module.css';

type Contexto = Awaited<ReturnType<typeof obterContextoFechamentoAdministrativo>>;
type Horario = DisponibilidadeDataPublica['periodos'][number]['horarios'][number];
type AdicionalDisponivel = {id:string;nome:string;preco:number};
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

export default function FechamentoAdminWizard({ clienteId }: { clienteId: string }) {
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

    useEffect(() => {
        let ativo = true;
        void adminFetch(endpoint).then(async response => {
            const body = await response.json();
            if (!response.ok || !body.ok) throw Error(body.erro ?? 'Não foi possível carregar o cliente.');
            if (ativo) setContexto(body.data);
        }).catch(error => { if (ativo) setErro(error instanceof Error ? error.message : 'Falha ao carregar cliente.'); });
        return () => { ativo = false; };
    }, [endpoint]);

    useEffect(()=>{
        if(!form.dataFesta || !form.pacote || !form.convidadosPagantes)return;
        const controller=new AbortController();
        const url=`/api/fechamentos/adicionais?pacote=${encodeURIComponent(form.pacote)}&data=${encodeURIComponent(form.dataFesta)}&convidados=${form.convidadosPagantes}`;
        void fetch(url,{signal:controller.signal,cache:'no-store'})
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
    async function selecionarData(data: string) {
        const sequencia = ++consultando.current;
        setHorarios([]);
        setErro('');
        setForm(atual => ({ ...atual, dataFesta: data, horarioInicio: '', horarioFim: '' }));
        try {
            const response = await fetch(`/api/disponibilidade?data=${encodeURIComponent(data)}`, { cache: 'no-store' });
            const body = await response.json();
            if (!response.ok || !body.ok) throw Error(body.erro ?? 'Falha ao consultar disponibilidade.');
            const dia = body.data as DisponibilidadeDataPublica;
            const opcoes = dia.periodos.find(p => p.codigo === (form.horarioBase === 'almoco' ? 'TURNO_1' : 'TURNO_2'))?.horarios.filter(h => h.status === 'DISPONIVEL') ?? [];
            if (sequencia !== consultando.current) return;
            setHorarios(opcoes);
            if (!opcoes.length) throw Error('Horário não disponível. Escolha outra data.');
        } catch (error) { if (sequencia === consultando.current) setErro(error instanceof Error ? error.message : 'Falha de disponibilidade.'); }
    }
    async function concluir(event: FormEvent) {
        event.preventDefault();
        if (envioEmCurso.current || resultado) return;
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

    if (!contexto) return <main><p role="status">{erro || 'Carregando cliente autorizado…'}</p></main>;
    if (contexto.redirecionadoDe) return <main><h1>Cadastro mesclado</h1><p>Confira o cadastro principal antes de iniciar: {contexto.cliente.nomeCompleto}.</p><Link href={`/admin/clientes/${contexto.cliente.id}/fechamento`}>Abrir cliente principal</Link></main>;
    if (resultado) return <main><h1>Fechamento criado</h1><p>Protocolo: {resultado.fechamentoId}</p><p>Estado: {resultado.status}</p><p>A revisão comercial, o contrato e as assinaturas continuam pelas etapas administrativas próprias.</p><Link href={`/clientes/${clienteId}?tab=eventos`}>Ver contratação no CRM</Link></main>;
    return <main style={{ maxWidth: 1000, margin: '0 auto', padding: 24 }}>
        <h1>Fechamento administrativo</h1>
        <p>Cliente: <strong>{contexto.cliente.nomeCompleto}</strong> — cadastro completo.</p>
        <p>CPF: {contexto.cliente.cpf?.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '***.$2.$3-**')}</p>
        <Link href={`/clientes/${clienteId}`}>Conferir cadastro no CRM</Link>
        {erro && <p role="alert">{erro}</p>}
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
                <label className={styles.field}>Convidados pagantes<input required type="number" min={1} max={150} value={form.convidadosPagantes} onChange={e => campo('convidadosPagantes', Number(e.target.value))} /></label>
                <label className={styles.field}>Aniversariante<select required value={form.aniversarianteId} onChange={e => campo('aniversarianteId', e.target.value)}><option value="">Selecione o cadastro existente</option>{contexto.aniversariantes.map(a => <option key={a.id} value={a.id}>{a.nome}</option>)}</select></label>
                {!contexto.aniversariantes.length && <p>Cadastre o aniversariante no CRM antes de continuar.</p>}
                <label className={styles.field}>Responsável adicional (opcional)<select value={form.responsavelAdicionalId ?? ''} onChange={e => campo('responsavelAdicionalId', e.target.value || null)}><option value="">Nenhum</option>{contexto.responsaveis.map(r => <option key={r.id} value={r.id}>{r.nome}</option>)}</select></label>
                <label className={styles.field}>Idade no evento (opcional)<input type="number" min={0} max={120} value={form.idadeAniversariante} onChange={e => campo('idadeAniversariante', e.target.value === '' ? '' : Number(e.target.value))} /></label>
                <label className={styles.field}>Tema<input maxLength={200} value={form.temaFesta ?? ''} onChange={e => campo('temaFesta', e.target.value)} /></label>
                <label className={styles.field}>Buffet<select value={form.buffetDefinicao} onChange={e => campo('buffetDefinicao', e.target.value as 'agora' | 'depois')}><option value="depois">Definir depois</option><option value="agora">Definir agora</option></select></label>
                {form.buffetDefinicao === 'agora' && buffet.map(([key, label]) => <label className={styles.field} key={key}>{label}<textarea maxLength={2000} value={form[key] ?? ''} onChange={e => campo(key, e.target.value)} /></label>)}
                <fieldset><legend>Adicionais</legend>{adicionaisDisponiveis===null?<p>Selecione data, pacote e convidados para consultar os adicionais.</p>:adicionaisDisponiveis.map(a => <label key={a.id} style={{ display: 'block' }}><input type="checkbox" checked={form.adicionaisSelecionados.includes(a.id)} onChange={e => campo('adicionaisSelecionados', e.target.checked ? [...form.adicionaisSelecionados, a.id] : form.adicionaisSelecionados.filter(id => id !== a.id))} />{a.nome} · {a.preco.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</label>)}</fieldset>
                <label className={styles.field}>Alterações pretendidas do pacote<textarea value={form.alteracoesPacote ?? ''} onChange={e => campo('alteracoesPacote', e.target.value)} /></label>
                <label className={styles.field}>Observações do cliente<textarea value={form.observacoesCliente ?? ''} onChange={e => campo('observacoesCliente', e.target.value)} /></label>
                <label className={styles.field}>Observações da equipe<textarea maxLength={2000} value={form.observacoesEquipe ?? ''} onChange={e => campo('observacoesEquipe', e.target.value)} /></label>
                <label className={styles.field}>Valor comercial proposto (R$)<input required inputMode="decimal" value={form.valorCombinado} onChange={e => campo('valorCombinado', e.target.value)} /></label>
                <label className={styles.field}>Forma de pagamento pretendida<select value={form.formaPagamento} onChange={e => setForm(atual => ({ ...atual, formaPagamento: e.target.value as typeof form.formaPagamento, condicaoPixPretendida: null }))}><option value="pix_avista">PIX à vista</option><option value="pix_parcelado">PIX parcelado</option><option value="cartao_cielo">Cartão Cielo</option></select></label>
                {form.formaPagamento === 'pix_parcelado' && (['entrada', 'valorParcela', 'quantidadeParcelas'] as const).map((key, i) => <label className={styles.field} key={key}>{['Entrada pretendida (R$)', 'Parcela pretendida (R$)', 'Quantidade pretendida'][i]}<input inputMode={key === 'quantidadeParcelas' ? 'numeric' : 'decimal'} value={form.condicaoPixPretendida?.[key] ?? ''} onChange={e => campo('condicaoPixPretendida', { ...form.condicaoPixPretendida, [key]: e.target.value === '' ? null : key === 'quantidadeParcelas' ? Number(e.target.value) : e.target.value.replace(',', '.') })} /></label>)}
                <p>Confira os dados antes de concluir. Os preços serão calculados pelo servidor; negociação e PIX parcelado seguem para revisão comercial quando exigido.</p>
                <button type="submit">{enviando ? 'Concluindo…' : 'Concluir Fechamento'}</button>
            </fieldset>
        </form>
    </main>;
}
