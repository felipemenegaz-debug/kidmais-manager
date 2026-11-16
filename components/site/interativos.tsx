'use client';
/**
 * Partes interativas do /conheca. Tudo aqui é simulação com dados fictícios: nada chama a API nem grava dados.
 * Cada componente renderiza no servidor um estado completo e legível (sem JavaScript, a página continua informativa).
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import Image from 'next/image';
import { custoPorFesta, precoExibido, type Modulo, type Plano } from '@/lib/site/catalogo';
import { aplicarPausa, EVENTO_PAUSA, pausaAtual } from './pausa';
import { cx } from './estilos';

const brl = (centavos: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(centavos / 100);
const MOVIMENTO_REDUZIDO = '(prefers-reduced-motion: reduce)';
function semAnimacao() { return pausaAtual() === true || (typeof matchMedia !== 'undefined' && matchMedia(MOVIMENTO_REDUZIDO).matches); }
export function Ficticio({ texto = 'Simulação com dados fictícios.' }: { texto?: string }) {
    return <p className={cx('ficticio')}>{texto}</p>;
}

/* ---------- Pausa única da página ---------- */
function assinarMovimento(aviso: () => void) {
    const consulta = matchMedia(MOVIMENTO_REDUZIDO);
    consulta.addEventListener('change', aviso);
    return () => consulta.removeEventListener('change', aviso);
}
/** Um botão para canvas, bordas, halo, botões e pseudo-elementos. Começa pela preferência do sistema e a acompanha. */
export function PausaGlobal() {
    const reduzido = useSyncExternalStore(assinarMovimento, () => matchMedia(MOVIMENTO_REDUZIDO).matches, () => false);
    // A escolha do visitante vale enquanto a preferência do sistema não muda.
    const [escolha, setEscolha] = useState<{ pausado: boolean; preferencia: boolean } | null>(null);
    const pausado = escolha && escolha.preferencia === reduzido ? escolha.pausado : reduzido;
    useEffect(() => { aplicarPausa(pausado); }, [pausado]);
    return <button type="button" className={cx('pausaGlobal')} aria-pressed={pausado} onClick={() => setEscolha({ pausado: !pausado, preferencia: reduzido })}>
        <span aria-hidden="true">{pausado ? '▶' : '❚❚'}</span><span className={cx('pausaTexto')}>Pausar animações</span>
    </button>;
}

/* ---------- Topo: monte uma festa ---------- */
const datas = [
    { dia: 6, semana: 'sáb', livre: false }, { dia: 7, semana: 'dom', livre: true }, { dia: 13, semana: 'sáb', livre: true },
    { dia: 14, semana: 'dom', livre: false }, { dia: 20, semana: 'sáb', livre: false }, { dia: 21, semana: 'dom', livre: true }, { dia: 27, semana: 'sáb', livre: true },
];
const pacotes = [{ nome: 'Diversão', convidados: 40, centavos: 520000 }, { nome: 'Alegria', convidados: 60, centavos: 680000 }, { nome: 'Festa completa', convidados: 80, centavos: 840000 }];
const horarios = [{ id: 'nobre', nome: 'Horário nobre', hora: '15h', centavos: 0 }, { id: 'promocional', nome: 'Horário promocional', hora: '19h', centavos: -50000 }] as const;
const extras = [{ id: 'personagem', nome: 'Personagem', centavos: 45000 }, { id: 'doces', nome: 'Mesa de doces', centavos: 38000 }] as const;
const PARCELAS = 4;
/** `horarios` e `pix` vêm do catálogo (Hero, no servidor): sem o recurso, o passo ou a linha somem. */
export function DemoFesta({ horarios: comHorarios = true, pix = true }: { horarios?: boolean; pix?: boolean }) {
    const [dia, setDia] = useState(13);
    const [pacote, setPacote] = useState(1);
    const [horario, setHorario] = useState<(typeof horarios)[number]['id']>('nobre');
    const [escolhidos, setEscolhidos] = useState<string[]>(['personagem']);
    const data = datas.find(d => d.dia === dia)!;
    const p = pacotes[pacote]; const h = horarios.find(x => x.id === horario)!;
    const adicionais = comHorarios ? extras.filter(e => escolhidos.includes(e.id)) : [];
    const total = p.centavos + (comHorarios ? h.centavos : 0) + adicionais.reduce((s, e) => s + e.centavos, 0);
    const semana = data.semana === 'sáb' ? 'sábado' : 'domingo';
    const ids = useId();
    return <form className={cx('demoFesta')} aria-label="Simulação: monte uma festa" onSubmit={e => e.preventDefault()}>
        <div className={cx('passo')} role="group" aria-labelledby={`${ids}-data`}><span id={`${ids}-data`}>1. Data livre em março</span>
            <div className={cx('fila')}>{datas.map(d => <button key={d.dia} type="button" className={cx('bt')} aria-pressed={d.dia === dia} disabled={!d.livre}
                aria-label={`${d.semana} ${d.dia}${d.livre ? '' : ', ocupado'}`} onClick={() => setDia(d.dia)}>{d.semana} {d.dia}</button>)}</div>
        </div>
        <div className={cx('passo')} role="group" aria-labelledby={`${ids}-pacote`}><span id={`${ids}-pacote`}>2. Pacote</span>
            <div className={cx('fila')}>{pacotes.map((x, i) => <button key={x.nome} type="button" className={cx('bt')} aria-pressed={i === pacote} onClick={() => setPacote(i)}>{x.nome}<small>até {x.convidados} convidados · {brl(x.centavos)}</small></button>)}</div>
        </div>
        {comHorarios && <div className={cx('passo')} role="group" aria-labelledby={`${ids}-horario`}><span id={`${ids}-horario`}>3. Horário e adicionais</span>
            <div className={cx('fila')}>{horarios.map(x => <button key={x.id} type="button" className={cx('bt')} aria-pressed={x.id === horario} onClick={() => setHorario(x.id)}>{x.nome} · {x.hora}<small>{x.centavos ? `${brl(x.centavos)} na mesma data` : 'preço do pacote'}</small></button>)}
                {extras.map(x => <button key={x.id} type="button" className={cx('bt')} aria-pressed={escolhidos.includes(x.id)} onClick={() => setEscolhidos(atual => atual.includes(x.id) ? atual.filter(i => i !== x.id) : [...atual, x.id])}>{x.nome}<small>+ {brl(x.centavos)}</small></button>)}</div>
        </div>}
        <div className={cx('contrato')} aria-live="polite" aria-atomic="true">
            <h4>Prévia do contrato</h4>
            <p>Festa no dia <mark>{dia} de março ({semana})</mark>{comHorarios && <>, às <mark>{h.hora}</mark> ({h.nome.toLowerCase()})</>}, pacote <mark>{p.nome}</mark> para até <mark>{p.convidados} convidados</mark>{adicionais.length ? <>, com <mark>{adicionais.map(a => a.nome.toLowerCase()).join(' e ')}</mark></> : null}.</p>
            <div className={cx('tot')}><span>Total</span><span>{brl(total)}</span></div>
            {pix && <p className={cx('demoPix')}>{PARCELAS} parcelas de {brl(Math.round(total / PARCELAS))} no Pix copia e cola, direto na conta do buffet.</p>}
        </div>
        <Ficticio texto="Simulação com dados fictícios. No seu buffet entram os seus pacotes, os seus preços e o seu modelo de contrato." />
    </form>;
}

/* ---------- Antes e depois ---------- */
export function Comparador({ antes, depois }: { antes: string[]; depois: [string, string][] }) {
    const [posicao, setPosicao] = useState(50);
    return <div className={cx('comparador')} style={{ ['--p' as string]: `${posicao}%` }}>
        <div className={cx('antes')}><b>Antes: caderno e WhatsApp</b><ul>{antes.map(l => <li key={l}>{l}</li>)}</ul></div>
        <div className={cx('depois')}><b>Depois: iA.Fest</b><ul>{depois.map(([nome, estado]) => <li key={nome}><b>{nome}</b> · {estado}</li>)}</ul></div>
        <span className={cx('risco')} aria-hidden="true" /><span className={cx('pega')} aria-hidden="true">◀ arraste ▶</span>
        <input type="range" min={0} max={100} value={posicao} aria-label="Comparar antes e depois" aria-valuetext={`${posicao}% do jeito antigo visível`} onChange={e => setPosicao(Number(e.target.value))} />
    </div>;
}

/* ---------- Painéis ---------- */
/** Encerra na hora a simulação em andamento quando o visitante pausa as animações ou o sistema pede movimento reduzido. */
function useAoPausar(concluir: () => void) {
    const atual = useRef(concluir);
    useEffect(() => { atual.current = concluir; });
    useEffect(() => {
        const pausa = (evento: Event) => { if ((evento as CustomEvent<boolean>).detail) atual.current(); };
        const consulta = matchMedia(MOVIMENTO_REDUZIDO);
        const movimento = () => { if (consulta.matches) atual.current(); };
        window.addEventListener(EVENTO_PAUSA, pausa);
        consulta.addEventListener('change', movimento);
        return () => { window.removeEventListener(EVENTO_PAUSA, pausa); consulta.removeEventListener('change', movimento); };
    }, []);
}
const CODIGO = '482915';
/** Como em production (ContratoPublico): o código libera o contrato; a assinatura exige ler, marcar o aceite e confirmar. */
export function PainelAssinatura() {
    const [digitos, setDigitos] = useState(CODIGO.length);
    const [aceite, setAceite] = useState(false);
    const [assinado, setAssinado] = useState(false);
    const relogio = useRef<ReturnType<typeof setInterval> | null>(null);
    const ids = useId();
    function parar() { if (relogio.current) clearInterval(relogio.current); relogio.current = null; }
    useEffect(() => parar, []);
    useAoPausar(() => { if (relogio.current) { parar(); setDigitos(CODIGO.length); } });
    function simular() {
        parar(); setAceite(false); setAssinado(false);
        if (semAnimacao()) { setDigitos(CODIGO.length); return; }
        setDigitos(0);
        relogio.current = setInterval(() => setDigitos(n => {
            if (n + 1 >= CODIGO.length) parar();
            return Math.min(CODIGO.length, n + 1);
        }), 260);
    }
    const confirmado = digitos === CODIGO.length;
    return <>
        <div className={cx('codigo', confirmado ? 'ok' : '')} role="img" aria-label={`Código: ${digitos} de ${CODIGO.length} dígitos digitados`}>{CODIGO.split('').map((c, i) => <i key={i}>{i < digitos ? c : ''}</i>)}</div>
        <button type="button" className={cx('bt')} onClick={simular}>Simular o cliente digitando</button>
        {confirmado && <div className={cx('aceite')}>
            <label htmlFor={`${ids}-aceite`}><input id={`${ids}-aceite`} type="checkbox" checked={aceite} disabled={assinado} onChange={e => setAceite(e.target.checked)} /> Li o contrato e aceito os termos</label>
            <button type="button" className={cx('bt')} disabled={!aceite || assinado} onClick={() => setAssinado(true)}>Aceitar e assinar eletronicamente</button>
        </div>}
        <p role="status" className={cx('estado')}>{!confirmado ? 'Aguardando o código…' : assinado ? 'Contrato assinado eletronicamente.' : 'Código confirmado. O cliente lê o contrato, marca o aceite e assina.'}</p>
    </>;
}
export const PEDIDO_CONVITE = 'Tema astronauta, cores azul e roxo, coloque o espiral de galáxia no fundo.';
export function PainelConvite() {
    const [letras, setLetras] = useState(PEDIDO_CONVITE.length);
    const [gerando, setGerando] = useState(false);
    const relogio = useRef<ReturnType<typeof setInterval> | null>(null);
    const espera = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (relogio.current) clearInterval(relogio.current); if (espera.current) clearTimeout(espera.current); }, []);
    useAoPausar(() => { if (relogio.current || espera.current) { if (relogio.current) clearInterval(relogio.current); if (espera.current) clearTimeout(espera.current); relogio.current = null; espera.current = null; setLetras(PEDIDO_CONVITE.length); setGerando(false); } });
    function repetir() {
        if (relogio.current) clearInterval(relogio.current);
        if (espera.current) clearTimeout(espera.current);
        if (semAnimacao()) { setLetras(PEDIDO_CONVITE.length); setGerando(false); return; }
        setLetras(0); setGerando(true);
        relogio.current = setInterval(() => setLetras(n => {
            if (n + 1 >= PEDIDO_CONVITE.length) {
                if (relogio.current) clearInterval(relogio.current);
                relogio.current = null;
                espera.current = setTimeout(() => { espera.current = null; setGerando(false); }, 900);
            }
            return Math.min(PEDIDO_CONVITE.length, n + 2);
        }), 45);
    }
    return <div className={cx('convG')}>
        <div>
            <div className={cx('pedido')}><small>Pedido da família</small>{PEDIDO_CONVITE.slice(0, letras)}{letras < PEDIDO_CONVITE.length && <span className={cx('cursor')} aria-hidden="true" />}</div>
            <button type="button" className={cx('bt')} onClick={repetir}>Ver a criação de novo</button>
            <p role="status" className={cx('estado')}>{gerando ? 'Criando a arte…' : 'Arte pronta para o convite.'}</p>
            <ul className={cx('ticks')}><li>Modelos prontos, foto da criança ou arte por IA</li><li>Convidados confirmam sem criar conta</li><li>Confirmações por família, com adultos e crianças</li></ul>
        </div>
        <figure className={cx('arte', gerando ? 'gerando' : '')}>
            <Image src="/site/recursos/convites-1.webp" alt="Convite gerado por IA: Miguel, 6 anos, astronauta no espaço" width={1024} height={1536} sizes="(max-width: 860px) 90vw, 280px" />
            <figcaption>Arte criada pela IA a partir do pedido acima</figcaption>
        </figure>
    </div>;
}
const PARCELA = 141250;
const nomesParcelas = ['Entrada', '2ª parcela', '3ª parcela', '4ª parcela'];
export function PainelParcelas() {
    const [recebidas, setRecebidas] = useState([true, false, false, false]);
    const recebido = recebidas.filter(Boolean).length * PARCELA;
    return <>
        <ul className={cx('lista')}>{nomesParcelas.map((nome, i) => <li key={nome}>
            <button type="button" className={cx('bt', 'parcela')} aria-pressed={recebidas[i]} onClick={() => setRecebidas(atual => atual.map((v, j) => j === i ? !v : v))}>
                <span>{nome} · {brl(PARCELA)}</span><span className={cx('selo', recebidas[i] ? '' : 'b')}>{recebidas[i] ? 'Recebida' : 'A receber'}</span>
            </button></li>)}</ul>
        <p role="status" className={cx('estado')}>Recebido: {brl(recebido)} de {brl(PARCELA * nomesParcelas.length)}</p>
    </>;
}
const buffets = [{ nome: 'Buffet Balão Mágico', cor: '#80f5c4' }, { nome: 'Espaço Jardim Kids', cor: '#7dd3fc' }, { nome: 'Casa da Alegria', cor: '#ff9fc8' }];
export function PainelMarca() {
    const [atual, setAtual] = useState(0);
    const b = buffets[atual];
    return <>
        <div className={cx('fila')} role="group" aria-label="Escolha um buffet de exemplo">{buffets.map((x, i) => <button key={x.nome} type="button" className={cx('bt')} aria-pressed={i === atual} onClick={() => setAtual(i)}>{x.nome}</button>)}</div>
        <div className={cx('logoBuffet')} aria-live="polite"><i style={{ background: b.cor }} aria-hidden="true">{b.nome.split(' ').map(p => p[0]).slice(-2).join('')}</i><span>{b.nome}</span></div>
    </>;
}

/* ---------- Abas de módulos (padrão WAI-ARIA de abas, ativação automática) ---------- */
export function AbasModulos({ modulos }: { modulos: Modulo[] }) {
    const [ativa, setAtiva] = useState(0);
    const abas = useRef<(HTMLButtonElement | null)[]>([]);
    function teclado(evento: KeyboardEvent<HTMLButtonElement>, i: number) {
        const destino = { ArrowRight: (i + 1) % modulos.length, ArrowLeft: (i - 1 + modulos.length) % modulos.length, Home: 0, End: modulos.length - 1 }[evento.key];
        if (destino === undefined) return;
        evento.preventDefault(); setAtiva(destino); abas.current[destino]?.focus();
    }
    return <div className={cx('abasModulos')}>
        <div role="tablist" aria-label="Módulos do iA.Fest" className={cx('abasLista')}>{modulos.map((m, i) => <button key={m.id} ref={el => { abas.current[i] = el; }} type="button" role="tab" id={`aba-${m.id}`} aria-selected={i === ativa} aria-controls={`painel-${m.id}`} tabIndex={i === ativa ? 0 : -1} className={cx('bt')} onClick={() => setAtiva(i)} onKeyDown={e => teclado(e, i)}>{m.nome}</button>)}</div>
        {modulos.map((m, i) => <div key={m.id} role="tabpanel" id={`painel-${m.id}`} aria-labelledby={`aba-${m.id}`} tabIndex={0} hidden={i !== ativa} className={cx('abaPainel')}>
            <div><h3>{m.titulo}</h3><p>{m.texto}</p><ul className={cx('ticks')}>{m.itens.map(t => <li key={t}>{t}</li>)}</ul></div>
            <div className={cx('tela')} role="img" aria-label={`Tela de exemplo de ${m.nome}, com dados fictícios`}>{m.tela.map(([a, b]) => <div key={a} className={cx('ln')}><span>{a}</span><b>{b}</b></div>)}<Ficticio texto="Dados fictícios" /></div>
        </div>)}
    </div>;
}

/* ---------- Conversa de exemplo do Wall-e (roteiro fixo, sem IA na página) ---------- */
type Fala = { de: 'cliente' | 'walle' | 'sistema'; texto: string };
export function ChatWallE({ roteiro }: { roteiro: { pergunta: string; respostas: string[]; passagem?: string }[] }) {
    const [falas, setFalas] = useState<Fala[]>([{ de: 'walle', texto: 'Oi! Sou o Wall-e, do Buffet Balão Mágico. Escolha uma pergunta ao lado.' }]);
    const feitas = new Set(falas.filter(f => f.de === 'cliente').map(f => f.texto));
    function perguntar(item: (typeof roteiro)[number]) {
        setFalas(atual => [...atual, { de: 'cliente', texto: item.pergunta }, ...item.respostas.map(texto => ({ de: 'walle' as const, texto })), ...(item.passagem ? [{ de: 'sistema' as const, texto: item.passagem }] : [])]);
    }
    return <div className={cx('chatG')}>
        <div className={cx('fila', 'perguntas')} role="group" aria-label="Perguntas do cliente">{roteiro.map(item => <button key={item.pergunta} type="button" className={cx('bt')} disabled={feitas.has(item.pergunta)} onClick={() => perguntar(item)}>{item.pergunta}</button>)}
            <button type="button" className={cx('bt')} onClick={() => setFalas(atual => atual.slice(0, 1))}>Recomeçar</button></div>
        <div className={cx('chatLog')} role="log" aria-live="polite" aria-label="Conversa de exemplo">{falas.map((f, i) => <p key={i} className={cx('balao', { cliente: 'deCliente', walle: 'deWalle', sistema: 'deSistema' }[f.de])}>{f.texto}</p>)}</div>
    </div>;
}

/* ---------- Calculadora "custo por festa" (rateio só da mensalidade regular) ---------- */
export function Calculadora({ planos, publicado, adicionaisVisiveis }: { planos: Plano[]; publicado: boolean; adicionaisVisiveis: boolean }) {
    const [festas, setFestas] = useState(12);
    const [id, setId] = useState(planos.find(p => p.destaque)?.id ?? planos[0].id);
    const plano = planos.find(p => p.id === id)!;
    const ids = useId();
    return <div className={cx('calculadora')}>
        <div>
            <label htmlFor={`${ids}-festas`} className={cx('calcRotulo')}>Festas por mês no seu buffet: <b>{festas}</b></label>
            <input id={`${ids}-festas`} type="range" min={2} max={40} value={festas} onChange={e => setFestas(Number(e.target.value))} />
            <div className={cx('fila')} role="group" aria-label="Plano">{planos.map(p => <button key={p.id} type="button" className={cx('bt')} aria-pressed={p.id === id} onClick={() => setId(p.id)}>{p.nome}</button>)}</div>
        </div>
        <div aria-live="polite" aria-atomic="true">
            <div className={cx('num')}>{precoExibido(custoPorFesta(plano, festas), publicado)}</div>
            <p>por festa: rateio da mensalidade regular do plano {plano.nome} ({precoExibido(plano.mensalCentavos, publicado)} por mês, {festas} festas).{adicionaisVisiveis ? ' Adicionais ficam fora.' : ''}</p>
            <p className={cx('zero')}>Taxa do iA.Fest sobre o valor das festas: <b>R$ 0</b></p>
        </div>
    </div>;
}

/* ---------- Ciclo com o cliente: início, meio e fim (painéis da primeira fileira) ---------- */
const PERGUNTA_ATENDIMENTO = 'Oi! Tem data livre em outubro para 50 convidados?';
const RESPOSTA_ATENDIMENTO = 'Oi, tudo bem? Tenho sábado 17 às 19h e domingo 25 às 15h. O pacote Festa Completa para 50 convidados fica em R$ 5.650,00. Quer que eu separe uma das datas?';
/** Conversa de exemplo com roteiro fixo; a seção do Wall-e mais abaixo tem a versão completa. */
export function PainelAtendimento() {
    const [respondido, setRespondido] = useState(true);
    const espera = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (espera.current) clearTimeout(espera.current); }, []);
    useAoPausar(() => { if (espera.current) { clearTimeout(espera.current); espera.current = null; setRespondido(true); } });
    function simular() {
        if (espera.current) clearTimeout(espera.current);
        if (semAnimacao()) { setRespondido(true); return; }
        setRespondido(false);
        espera.current = setTimeout(() => { espera.current = null; setRespondido(true); }, 1200);
    }
    return <>
        <div className={cx('miniChat')} aria-live="polite">
            <p className={cx('balao', 'cliente')}><small>Cliente · 22:47</small>{PERGUNTA_ATENDIMENTO}</p>
            {respondido
                ? <p className={cx('balao', 'ia')}><small>Wall-e · 22:47</small>{RESPOSTA_ATENDIMENTO}</p>
                : <p className={cx('balao', 'ia', 'digitando')} aria-label="Wall-e digitando"><i /><i /><i /></p>}
        </div>
        <button type="button" className={cx('bt')} onClick={simular}>Simular a mensagem do cliente</button>
        <a className={cx('linkPainel')} href="#wall-e">Veja o Wall-e responder outras perguntas →</a>
    </>;
}

/** Meio do ciclo: a data livre vira festa com o preço do buffet e termina no contrato assinado por código. */
export function PainelFechamento({ paginaDoBuffet }: { paginaDoBuffet: boolean }) {
    return <>
        <ol className={cx('etapas')}>
            <li><span>{paginaDoBuffet ? 'O cliente escolhe a data livre na página do buffet' : 'Data livre escolhida na agenda'}</span><b>sáb 17/10 · 15h</b></li>
            <li><span>Pacote e convidados com o seu preço</span><b>Festa Completa · 50</b></li>
            <li><span>Total da festa</span><b>R$ 5.650,00</b></li>
        </ol>
        <PainelAssinatura />
    </>;
}

type MensagemCiclo = { quando: string; texto: string };
/** Um toque em "Avançar no tempo": envia a próxima mensagem (ou recomeça) e diz o que anunciar. Cada envio é anunciado, inclusive o último. */
export function avancarMensagens(enviadas: number, textos: readonly string[]): { enviadas: number; anuncio: string } {
    if (enviadas >= textos.length) return { enviadas: 0, anuncio: 'Linha do tempo reiniciada. Todas as mensagens estão programadas.' };
    return { enviadas: enviadas + 1, anuncio: `Enviada: ${textos[enviadas]}.` };
}
/** Fim do ciclo: o que sai sozinho, do contrato assinado até depois da festa. Roteiro fixo, sem envio. Cada linha só cita recurso disponível. */
export function PainelMensagens({ pesquisa, familia, pix, convite, clientes }: { pesquisa: boolean; familia: boolean; pix: boolean; convite: boolean; clientes: boolean }) {
    const mensagens: MensagemCiclo[] = [
        { quando: 'Contrato assinado', texto: 'Confirmação da festa com data, horário e pacote' },
        { quando: '5 dias antes do vencimento', texto: pix ? 'Lembrete da parcela com Pix copia e cola' : 'Lembrete da parcela' },
        { quando: 'Véspera da festa', texto: 'Horário de chegada e endereço do buffet' },
        { quando: 'Dia seguinte', texto: 'Agradecimento à família' },
        ...(pesquisa ? [{ quando: '3 dias depois', texto: 'Pesquisa de satisfação' }] : []),
        // Mesma trava do passo 8 do fluxo ("Lembra o próximo aniversário"): depende do cadastro de clientes.
        ...(clientes ? [{ quando: '1 mês antes do próximo aniversário', texto: 'Lembrete para comemorar de novo no buffet' }] : []),
    ];
    const [enviadas, setEnviadas] = useState(mensagens.length);
    const [anuncio, setAnuncio] = useState(''); // vazio na renderização inicial: nada é anunciado antes do primeiro toque
    const todas = enviadas === mensagens.length;
    return <>
        <ol className={cx('linhaTempo')}>{mensagens.map((m, i) => <li key={m.quando} className={cx(i < enviadas ? 'enviada' : '')}>
            <small>{m.quando}</small><span>{m.texto}</span><span className={cx('selo', i < enviadas ? '' : 'b')}>{i < enviadas ? 'Enviada' : 'Programada'}</span>
        </li>)}</ol>
        <button type="button" className={cx('bt')} onClick={() => { const proximo = avancarMensagens(enviadas, mensagens.map(m => m.texto)); setEnviadas(proximo.enviadas); setAnuncio(proximo.anuncio); }}>
            {todas ? 'Ver de novo desde o início' : 'Avançar no tempo'}
        </button>
        {/* O foco fica no botão: a mensagem que acabou de sair é anunciada aqui (achados do Astra r1 e r2). */}
        <p role="status" className={cx('srOnly')}>{anuncio}</p>
        {familia && <p className={cx('estado')}>A família acompanha tudo pela Área da Família: contrato, parcelas{convite ? ', convite' : ''}{pesquisa ? ' e pesquisa' : ''}.</p>}
    </>;
}
