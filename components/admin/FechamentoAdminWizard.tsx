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
import styles from './revisao-fechamento.module.css';

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
    const [revisando, setRevisando] = useState(false);
    const [tentouRevisar, setTentouRevisar] = useState(false);
    const revisaoRef = useRef<HTMLDivElement>(null);
    const edicaoRef = useRef<HTMLFieldSetElement>(null);
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
        setTentouRevisar(true);
        if (pendencias.length) {
            setErro('Confira os campos pendentes antes de continuar.');
            if (revisando) setRevisando(false);
            requestAnimationFrame(() => edicaoRef.current?.closest('form')?.querySelector<HTMLElement>('[aria-invalid=true]')?.focus());
            return;
        }
        if (!revisando) {
            setErro('');
            setRevisando(true);
            requestAnimationFrame(() => { revisaoRef.current?.focus(); revisaoRef.current?.scrollIntoView({ block: 'start' }); });
            return;
        }
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

    const validacao = fechamentoAdministrativoSchema.safeParse(form);
    const errosCampos: Record<string, string> = {};
    if (!validacao.success) for (const falha of validacao.error.issues) {
        const nome = String(falha.path[0]);
        errosCampos[nome] = nome === 'aniversarianteId' ? 'Selecione um aniversariante cadastrado.' : nome === 'horarioInicio' || nome === 'horarioFim' ? 'Selecione um horário disponível.' : nome === 'dataFesta' ? 'Selecione a data completa no calendário.' : nome === 'valorCombinado' ? 'Informe o valor comercial proposto.' : 'Confira este campo.';
    }
    const pacoteAtual = PACOTES_FECHAMENTO_V1.find(p => p.id === form.pacote);
    const convidadosErro = erroConvidadosFechamento(form.convidadosPagantes, pacoteAtual);
    if (convidadosErro) errosCampos.convidadosPagantes = convidadosErro;
    const pendencias = [...new Set(Object.values(errosCampos)), ...(adicionaisDisponiveis === null ? ['Aguardando consulta dos adicionais.'] : [])];
    const nomeAniversariante = contexto?.aniversariantes.find(a => a.id === form.aniversarianteId)?.nome;
    const pagamentoNome = form.formaPagamento === 'pix_avista' ? 'PIX à vista' : form.formaPagamento === 'pix_parcelado' ? 'PIX parcelado' : 'Cartão Cielo';
    function erroCampo(campo: string) { return tentouRevisar && errosCampos[campo] ? <small id={`pendencia-${campo}`} className={styles.error}>{errosCampos[campo]}</small> : null; }
    function acessibilidade(campo: string) {
        const rotulos: Record<string, string> = { horarioInicio: 'Horário disponível', convidadosPagantes: 'Convidados pagantes', aniversarianteId: 'Aniversariante', responsavelAdicionalId: 'Responsável adicional (opcional)', idadeAniversariante: 'Idade no evento (opcional)', temaFesta: 'Tema', buffetDefinicao: 'Buffet', valorCombinado: 'Valor comercial proposto (R$)', formaPagamento: 'Forma de pagamento pretendida' };
        return { 'aria-label': rotulos[campo], 'aria-invalid': tentouRevisar && Boolean(errosCampos[campo]), 'aria-describedby': tentouRevisar && errosCampos[campo] ? `pendencia-${campo}` : undefined };
    }
    const resumo = <dl>
        <div><dt>Cliente</dt><dd>{contexto?.cliente.nomeCompleto}</dd></div>
        <div><dt>Festa</dt><dd>{nomeAniversariante || 'Aniversariante pendente'}{form.idadeAniversariante !== '' ? ` · ${form.idadeAniversariante} ano(s)` : ''}</dd></div>
        <div><dt>Data e horário</dt><dd>{form.dataFesta ? form.dataFesta.split('-').reverse().join('/') : 'Data pendente'} · {form.horarioInicio ? `${form.horarioInicio}–${form.horarioFim}` : 'Horário pendente'}</dd></div>
        <div><dt>Pacote e convidados</dt><dd>{pacoteAtual?.nome} · {form.convidadosPagantes} convidados pagantes</dd></div>
        <div><dt>Tema</dt><dd>{form.temaFesta?.trim() || 'Não informado'}</dd></div>
        <div><dt>Pagamento pretendido</dt><dd>{pagamentoNome}</dd></div>
    </dl>;
    if (!contexto) return <main className={styles.page}><p role={erro ? 'alert' : 'status'}>{erro || 'Carregando cliente autorizado…'}</p></main>;
    if (contexto.redirecionadoDe) return <main><h1>Cadastro mesclado</h1><p>Confira o cadastro principal antes de iniciar: {contexto.cliente.nomeCompleto}.</p><Link href={`/admin/clientes/${contexto.cliente.id}/fechamento`}>Abrir cliente principal</Link></main>;
    if (resultado) return <main className={styles.page}><h1>Fechamento criado</h1><p>Protocolo: {resultado.fechamentoId}</p><p>Estado: {resultado.status}</p><p>A revisão comercial, o contrato e as assinaturas continuam pelas etapas administrativas próprias.</p><div className={styles.actions}><Link href={`/admin/fechamentos/${encodeURIComponent(resultado.fechamentoId)}/revisao`}>Revisar condição e gerar contrato</Link><Link href={`/clientes/${clienteId}?tab=eventos`}>Ver contratação no CRM</Link></div></main>;
    return <main className={styles.page}>
        <h1>{revisando ? 'Revise antes de criar' : 'Preparar contratação'}</h1><p className={styles.intro}>Confira cliente, festa e pagamento. O contrato segue pelo fluxo comercial existente.</p>
        <section className={styles.card}><h2>Cliente</h2><p>Cliente: <strong>{contexto.cliente.nomeCompleto}</strong> — cadastro completo.</p>
        <p>CPF: {contexto.cliente.cpf?.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '***.$2.$3-**')}</p>
        <Link href={`/clientes/${clienteId}`}>Conferir cadastro no CRM</Link></section>
        {erro && <p role="alert">{erro}</p>}
        {avisoPreparacao && <p role="status">{avisoPreparacao}</p>}
        {preparacao && !semPreparacao && <section className={styles.card} aria-label="Preparado pelo Kidmais">
            <p>Preparado pelo Kidmais. Confira, complete e conclua: nada foi gravado até você concluir.</p>
            {preparacao.pendencias.length > 0 && <ul>{preparacao.pendencias.map(p => <li key={p}>{p}</li>)}</ul>}
            {erroPreparacao && !incerto && !semPreparacao && <button type="button" onClick={() => { setSemPreparacao(true); setErroPreparacao(false); setErro(''); }}>Enviar sem a preparação do Kidmais</button>}
            {incerto && <button type="button" onClick={() => void verificarDeNovo()}>Verificar de novo</button>}
        </section>}
        <div className={styles.layout}><form noValidate onSubmit={concluir}>
            <fieldset ref={edicaoRef} hidden={revisando} disabled={enviando} className={styles.card}>
                <legend>Festa</legend>
                <label>Pacote<select aria-label="Pacote" value={form.pacote} onChange={e => { limparAgenda(); campo('pacote', e.target.value as typeof form.pacote); }}>
                    {PACOTES_FECHAMENTO_V1.map(p => <option key={p.id} value={p.id} disabled={p.sobConsulta}>{p.nome}{p.sobConsulta ? ' — sob consulta' : ''}</option>)}
                </select></label>
                {erroCampo('dataFesta')}<CalendarioDisponibilidade pacote={form.pacote} horario={form.horarioBase} dataSelecionada={form.dataFesta}
                    onSelecionar={data => void selecionarData(data)} onTrocarHorario={horario => { limparAgenda(); if (horario) campo('horarioBase', horario); }} />
                <label >Horário disponível<select {...acessibilidade('horarioInicio')} required value={form.horarioInicio} onChange={e => {
                    const h = horarios.find(h => h.inicio === e.target.value);
                    if (h) setForm(atual => ({ ...atual, horarioInicio: h.inicio, horarioFim: h.fim, ajusteHorario: String(h.ajusteMinutos) as typeof form.ajusteHorario }));
                }}><option value="">Selecione</option>{horarios.map(h => <option key={h.inicio} value={h.inicio}>{h.inicio}–{h.fim}</option>)}</select>{erroCampo('horarioInicio')}</label>
                <label >Convidados pagantes<input {...acessibilidade('convidadosPagantes')} required type="number" min={PACOTES_FECHAMENTO_V1.find(p => p.id === form.pacote)?.minPagantes ?? 1} max={PACOTES_FECHAMENTO_V1.find(p => p.id === form.pacote)?.maxPagantes ?? 150} value={form.convidadosPagantes} onChange={e => campo('convidadosPagantes', Number(e.target.value))} />{erroCampo('convidadosPagantes')}</label>
                <label >Aniversariante<select {...acessibilidade('aniversarianteId')} required value={form.aniversarianteId} onChange={e => campo('aniversarianteId', e.target.value)}><option value="">Selecione o cadastro existente</option>{contexto.aniversariantes.map(a => <option key={a.id} value={a.id}>{a.nome}</option>)}</select>{erroCampo('aniversarianteId')}</label>
                {!contexto.aniversariantes.length && <p>Cadastre o aniversariante no CRM antes de continuar.</p>}
                <label >Responsável adicional (opcional)<select {...acessibilidade('responsavelAdicionalId')} value={form.responsavelAdicionalId ?? ''} onChange={e => campo('responsavelAdicionalId', e.target.value || null)}><option value="">Nenhum</option>{contexto.responsaveis.map(r => <option key={r.id} value={r.id}>{r.nome}</option>)}</select>{erroCampo('responsavelAdicionalId')}</label>
                <label >Idade no evento (opcional)<input {...acessibilidade('idadeAniversariante')} type="number" min={0} max={120} value={form.idadeAniversariante} onChange={e => campo('idadeAniversariante', e.target.value === '' ? '' : Number(e.target.value))} />{erroCampo('idadeAniversariante')}</label>
                <label >Tema<input {...acessibilidade('temaFesta')} maxLength={200} value={form.temaFesta ?? ''} onChange={e => campo('temaFesta', e.target.value)} />{erroCampo('temaFesta')}</label>
                <label >Buffet<select {...acessibilidade('buffetDefinicao')} value={form.buffetDefinicao} onChange={e => campo('buffetDefinicao', e.target.value as 'agora' | 'depois')}><option value="depois">Definir depois</option><option value="agora">Definir agora</option></select>{erroCampo('buffetDefinicao')}</label>
                {form.buffetDefinicao === 'agora' && buffet.map(([key, label]) => <label  key={key}>{label}<textarea maxLength={2000} value={form[key] ?? ''} onChange={e => campo(key, e.target.value)} /></label>)}
                <fieldset><legend>Adicionais</legend>{form.pacote === 'premium' && <p>Premium inclui 4 bombons. As quantidades abaixo são somente extras, sem compra mínima.</p>}{adicionaisDisponiveis===null?<p>Selecione data, pacote e convidados para consultar os adicionais.</p>:adicionaisDisponiveis.map(a => <label key={a.id} style={{ display: 'block' }}><input type="checkbox" checked={form.adicionaisSelecionados.includes(a.id)} onChange={e => campo('adicionaisSelecionados', e.target.checked ? [...form.adicionaisSelecionados, a.id] : form.adicionaisSelecionados.filter(id => id !== a.id))} />{a.nome} · {a.preco.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}{a.unidadeCobranca === 'UNIDADE' && <> / unidade extra{form.adicionaisSelecionados.includes(a.id) && <input aria-label={`Quantidade extra de ${a.nome}`} type="number" min={1} step={1} value={form.adicionaisQuantidades?.[a.id] ?? 1} onChange={e => campo('adicionaisQuantidades', {...form.adicionaisQuantidades, [a.id]: Number(e.target.value)})}/>}</>}</label>)}</fieldset>
                <label >Alterações pretendidas do pacote<textarea value={form.alteracoesPacote ?? ''} onChange={e => campo('alteracoesPacote', e.target.value)} /></label>
                <label >Observações do cliente<textarea value={form.observacoesCliente ?? ''} onChange={e => campo('observacoesCliente', e.target.value)} /></label>
                <label >Observações da equipe<textarea maxLength={2000} value={form.observacoesEquipe ?? ''} onChange={e => campo('observacoesEquipe', e.target.value)} /></label>
                </fieldset><fieldset hidden={revisando} disabled={enviando} className={styles.card}><legend>Condições comerciais e pagamento</legend>
                <label >Valor comercial proposto (R$)<input {...acessibilidade('valorCombinado')} required inputMode="decimal" value={form.valorCombinado} onChange={e => campo('valorCombinado', e.target.value)} />{erroCampo('valorCombinado')}</label>
                <label >Forma de pagamento pretendida<select {...acessibilidade('formaPagamento')} value={form.formaPagamento} onChange={e => setForm(atual => ({ ...atual, formaPagamento: e.target.value as typeof form.formaPagamento, condicaoPixPretendida: null }))}><option value="pix_avista">PIX à vista</option><option value="pix_parcelado">PIX parcelado</option><option value="cartao_cielo">Cartão Cielo</option></select>{erroCampo('formaPagamento')}</label>
                {form.formaPagamento === 'pix_parcelado' && (['entrada', 'valorParcela', 'quantidadeParcelas'] as const).map((key, i) => <label key={key}>{['Entrada pretendida (R$)', 'Parcela pretendida (R$)', 'Quantidade pretendida'][i]}<input {...acessibilidade('condicaoPixPretendida')} inputMode={key === 'quantidadeParcelas' ? 'numeric' : 'decimal'} value={form.condicaoPixPretendida?.[key] ?? ''} onChange={e => campo('condicaoPixPretendida', { ...form.condicaoPixPretendida, [key]: e.target.value === '' ? null : key === 'quantidadeParcelas' ? Number(e.target.value) : e.target.value.replace(',', '.') })} /></label>)}{erroCampo('condicaoPixPretendida')}
                <p>Confira os dados antes de concluir. Os preços serão calculados pelo servidor; negociação e PIX parcelado seguem para revisão comercial quando exigido.</p>
            </fieldset>
            <div ref={revisaoRef} tabIndex={-1} hidden={!revisando} className={styles.review}>
                <section className={styles.card}><h2>Cliente e festa</h2>{resumo}</section>
                <section className={styles.card}><h2>Condições comerciais e pagamento</h2><p>Valor comercial proposto: <strong>R$ {form.valorCombinado}</strong></p><p>{pagamentoNome}</p>{form.formaPagamento === 'pix_parcelado' && <p>Entrada pretendida: {form.condicaoPixPretendida?.entrada ?? 'Não informada'} · Parcela pretendida: {form.condicaoPixPretendida?.valorParcela ?? 'Não informada'} · Quantidade: {form.condicaoPixPretendida?.quantidadeParcelas ?? 'Não informada'}</p>}<p>Preço oficial e disponibilidade são validados pelo servidor ao criar o fechamento.</p></section>
                <section className={styles.card}><h2>Detalhes da contratação</h2><p>Buffet: {form.buffetDefinicao === 'agora' ? 'Definido nesta proposta' : 'Definir depois'}</p>{form.buffetDefinicao === 'agora' && buffet.map(([key, label]) => form[key] ? <p key={key}>{label}: {form[key]}</p> : null)}<p>Adicionais: {form.adicionaisSelecionados.length ? form.adicionaisSelecionados.map(id => { const a = adicionaisDisponiveis?.find(a => a.id === id); return `${a?.nome ?? id}${a?.unidadeCobranca === 'UNIDADE' ? ` × ${form.adicionaisQuantidades?.[id] ?? 1}` : ''}`; }).join(', ') : 'Nenhum'}</p><p>Responsável adicional: {contexto.responsaveis.find(r => r.id === form.responsavelAdicionalId)?.nome ?? 'Nenhum'}</p>{form.alteracoesPacote && <p>Alterações do pacote: {form.alteracoesPacote}</p>}{form.observacoesCliente && <p>Observações do cliente: {form.observacoesCliente}</p>}{form.observacoesEquipe && <p>Observações da equipe: {form.observacoesEquipe}</p>}</section>
            </div>
            <div className={styles.actions}>{revisando && <button type="button" disabled={enviando} onClick={() => { setRevisando(false); requestAnimationFrame(() => edicaoRef.current?.querySelector<HTMLElement>('select, input')?.focus()); }}>Voltar e corrigir</button>}<button type="submit" disabled={enviando || incerto}>{enviando ? 'Criando fechamento…' : revisando ? 'Confirmar e criar fechamento' : 'Revisar contratação'}</button></div>
        </form><aside className={styles.summary} aria-label="Resumo atualizado"><h2>Resumo da contratação</h2>{resumo}<hr/><p>Valor comercial proposto</p><strong>{form.valorCombinado ? `R$ ${form.valorCombinado}` : 'Valor pendente'}</strong><p>Preço oficial calculado pelo servidor ao concluir.</p>{pendencias.length > 0 && <div className={styles.pending}><strong>Antes de continuar</strong><ul>{pendencias.map(item => <li key={item}>{item}</li>)}</ul></div>}<p>Criar o fechamento inicia a contratação. Revisão comercial, geração do contrato e assinaturas seguem nas etapas próprias.</p></aside></div>
    </main>;
}
