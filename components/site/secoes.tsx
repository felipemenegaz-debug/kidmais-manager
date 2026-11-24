/**
 * Seções do /conheca (servidor). Cada bloco que depende de um recurso lê o catálogo (lib/site/catalogo.ts):
 * sem evidência de LIVE em production, o bloco não aparece. Não existe selo "Em breve".
 */
import type { ReactNode } from 'react';
import { cx } from './estilos';
import { Cadastro, Contato } from './elementos';
import { comercial, confianca, filtrar, modulos, paineis, passos, perguntas, RECURSOS_SECAO_WALLE, roteiroWallE, tituloFluxo, visivel, type PainelId, type RecursoId } from '@/lib/site/catalogo';
import type { ConfiguracaoSite } from '@/lib/site/configuracao';
import { dias } from '@/lib/assinatura/texto';
import { textoFundador, type TextoFundador } from '@/lib/site/fundador';
import { AbasModulos, ChatWallE, Comparador, DemoFesta, Ficticio, PainelAtendimento, PainelConvite, PainelFechamento, PainelMarca, PainelMensagens, PainelParcelas } from './interativos';

function Cabecalho({ olho, id, titulo, texto }: { olho: string; id: string; titulo: ReactNode; texto?: ReactNode }) {
    return <div className={cx('head')} data-fundo-texto><div className={cx('eyebrow')}>{olho}</div><h2 id={id}>{titulo}</h2>{texto && <p className={cx('lead')}>{texto}</p>}</div>;
}

/** Junta "a", "a e b", "a, b e c". */
function lista(itens: string[]) { return itens.length < 2 ? itens.join('') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`; }
export function Hero({ aberto, config }: { aberto: boolean; config: ConfiguracaoSite }) {
    // A demo do topo é a história "data → pacote → contrato": sem um desses recursos, o topo vira institucional e a demo some.
    const demo = visivel(['agenda', 'festas', 'contratos']);
    const juntos = lista([visivel(['agenda']) && 'agenda', visivel(['contratos']) && 'contrato', visivel(['pix']) && 'parcelas com Pix'].filter((x): x is string => Boolean(x)));
    return <section className={cx('hero')} aria-labelledby="t-hero"><div className={cx('wrap')}>
        <div className={cx('hero-grid')}>
            <div className={cx('hero-copy')} data-fundo-proteger>
                <div className={cx('eyebrow')}>Para buffets infantis e espaços de festa</div>
                {demo ? <h1 id="t-hero">Monte uma festa agora.<br /><em>O contrato sai pronto.</em></h1> : <h1 id="t-hero">O sistema do seu<br /><em>buffet infantil.</em></h1>}
                <p className={cx('lead')}>{demo ? `Escolha a data, o pacote${visivel(['horarios']) ? ' e o horário' : ''} aqui ao lado. ` : ''}{juntos ? `No iA.Fest, você tem ${juntos} no mesmo lugar.` : 'Feito dentro de um buffet infantil, para a rotina de quem vende festas.'}</p>
                {/* Cadastro fechado: "Agendar demonstração" já leva ao mesmo canal; "Falar com a equipe" fica para quando o teste abre sozinho. */}
                <div className={cx('actions')}><Cadastro aberto={aberto} contato={config} />{(aberto || !(config.demonstracao || config.demonstracaoEmail)) && <Contato config={config} />}</div>
                <div className={cx('fineprint')}><span>{dias(comercial.testeDias)} grátis</span><span>Sem cartão</span>{visivel(['implantacao']) && <span>Implantação guiada incluída</span>}</div>
            </div>
            {demo && <div className={cx('halo')} data-fundo-proteger><div className={cx('app', 'demoCaixa')}><DemoFesta horarios={visivel(['horarios'])} pix={visivel(['pix'])} /></div></div>}
        </div>
        {visivel(['pix']) && <div className={cx('ribbon')} data-fundo-proteger><span><strong>O dinheiro das festas cai direto na sua conta.</strong> O iA.Fest não intermedia pagamentos nem fica com parte do valor.</span><a href="#confianca">0% sobre as festas →</a></div>}
    </div></section>;
}

/** Cada linha do comparador promete um recurso: some junto com ele. */
const semana: { antes: string; depois: [string, string]; recursos: RecursoId[] }[] = [
    { antes: 'Sofia sáb 15h?? confirmar c/ Carla', depois: ['Sofia', 'sáb 15h · contrato assinado'], recursos: ['agenda', 'contratos', 'assinatura_codigo'] },
    { antes: 'Miguel: contrato no Word, falta o valor', depois: ['Miguel', 'contrato enviado · aguardando assinatura'], recursos: ['contratos', 'assinatura_codigo'] },
    { antes: 'Helena 2ª parcela… pagou? ver extrato', depois: ['Helena', '2ª parcela · vence dia 20, Pix enviado'], recursos: ['pix', 'financeiro'] },
    { antes: 'dia 24 já tinha festa!!! ligar pra mãe', depois: ['Dia 24', 'ocupado, não aparece para vender'], recursos: ['agenda'] },
    { antes: 'orçamento Juliana: refazer conta do adicional', depois: ['Juliana', 'orçamento R$ 5.650,00 calculado'], recursos: ['festas', 'horarios'] },
];
export function AntesDepois() {
    const linhas = filtrar(semana);
    if (linhas.length < 2) return null;
    const antes = linhas.map(l => l.antes); const depois = linhas.map(l => l.depois);
    return <section className={cx('block')} id="antes-depois" aria-labelledby="t-dor"><div className={cx('wrap')}>
        <Cabecalho olho="Antes e depois" id="t-dor" titulo="Arraste e veja a mesma semana dos dois jeitos." />
        <div data-fundo-proteger><Comparador antes={antes} depois={depois} /><Ficticio /></div>
    </div></section>;
}

/** O vídeo do card e a legenda passam por clientes, agenda, festas e contrato: título, player e passo a passo usam esta mesma trava. */
const recursosVideoContrato: RecursoId[] = ['contratos', 'assinatura_codigo', 'agenda', 'festas', 'clientes'];
/** Vídeos piloto da central de ajuda; cada título fala de um recurso e some com ele. */
const videosAjuda: { titulo: string; recursos: RecursoId[] }[] = [
    { titulo: 'Como cadastrar e acompanhar clientes', recursos: ['clientes'] },
    { titulo: 'Como fazer o fechamento de uma festa', recursos: ['festas'] },
    { titulo: 'Do fechamento ao contrato assinado', recursos: recursosVideoContrato },
];
/** Versão em texto do vídeo "Do fechamento ao contrato assinado": as falas da legenda (.vtt), na ordem. O teste confere com o arquivo. */
const passosVideoContrato = [
    'Abra o cliente em Clientes e clique em Iniciar fechamento.',
    'Escolha o pacote e a data no calendário. Ele mostra os dias com horário livre.',
    'Defina o horário, os convidados pagantes e o aniversariante.',
    'Informe o valor combinado e a forma de pagamento.',
    'Revise o resumo e confirme. O sistema confere o preço e a disponibilidade.',
    'A contratação aparece em Festas, na aba Em contratação, com o próximo passo.',
    'Confira a condição comercial e clique em Gerar contrato.',
    'No contrato, clique em Preparar documento.',
    'Leia o PDF e confirme a revisão.',
    'Digite sua senha para assinar pelo buffet.',
    'Depois, libere o contrato para o cliente.',
    'No celular, o cliente confirma o CPF e recebe um código pelo WhatsApp.',
    'Ele lê o contrato e registra o aceite.',
    'Pronto, contrato assinado pelas duas partes.',
    'A festa entra na agenda e aparece em Festas, na aba Próximas.',
];
const conteudoPainel: Record<PainelId, { titulo: string; texto: string; largura: string; corpo: ReactNode }> = {
    atendimento: { titulo: 'Atendimento no WhatsApp com IA', texto: 'O cliente pergunta a qualquer hora. O Wall-e responde com a sua agenda e os seus preços.', largura: 'g2', corpo: <PainelAtendimento /> },
    assinatura: { titulo: 'Da data livre ao contrato assinado', texto: 'A festa fecha com o seu preço e o cliente assina no celular com um código, sem aplicativo.', largura: 'g2', corpo: <PainelFechamento paginaDoBuffet={visivel(['orcamento'])} /> },
    mensagens: { titulo: 'Mensagens automáticas até depois da festa', texto: 'Cada mensagem programada sai na hora certa, do contrato assinado ao agradecimento depois da festa.', largura: 'g2', corpo: <PainelMensagens pesquisa={visivel(['pesquisa'])} familia={visivel(['familia'])} pix={visivel(['pix'])} convite={visivel(['convite'])} clientes={visivel(['clientes'])} /> },
    convite: { titulo: 'Convite da festa com IA', texto: 'A família descreve o tema e a IA cria a arte do convite.', largura: 'g6', corpo: <PainelConvite /> },
    parcelas: { titulo: 'Parcelas e recebimentos', texto: 'Toque numa parcela para dar baixa. Dá para registrar recebimento parcial e a data real do pagamento.', largura: 'g2', corpo: <PainelParcelas /> },
    ajuda: { titulo: 'Central de ajuda', texto: 'Ajuda escrita e vídeos curtos dentro do sistema, para a equipe aprender sozinha.', largura: 'g2', corpo: <>
        {visivel(recursosVideoContrato) && <figure className={cx('capaVideo')}>
            {/* Capa leve e preload="none": o MP4 (9 MB) só é pedido ao tocar. Legenda e capa são as mesmas da central de ajuda. */}
            <video src="/ajuda/videos/do-fechamento-ao-contrato.mp4" poster="/ajuda/videos/do-fechamento-ao-contrato.jpg" preload="none" controls playsInline aria-label="Vídeo de ajuda: Do fechamento ao contrato assinado">
                <track kind="captions" src="/ajuda/videos/do-fechamento-ao-contrato.vtt" srcLang="pt-BR" label="Português" default />
            </video>
            <figcaption>Vídeo de exemplo · Do fechamento ao contrato assinado</figcaption>
            <details className={cx('passoVideo')}>
                <summary>Passo a passo em texto</summary>
                <ol>{passosVideoContrato.map(p => <li key={p}>{p}</li>)}</ol>
            </details>
        </figure>}
        <ul className={cx('lista')}>{filtrar(videosAjuda).map(v => <li key={v.titulo}>{v.titulo}</li>)}</ul>
    </> },
    marca: { titulo: 'A marca do seu buffet', texto: 'A logo e as cores do buffet nas telas do cliente e nos documentos.', largura: 'g2', corpo: <PainelMarca /> },
};
/** Cards g2 seguidos formam fileiras de 3. Quando sobra 1 card, ele ocupa a fileira; quando sobram 2, cada um ocupa metade. */
function larguraNaFileira(larguras: string[], i: number): string {
    if (larguras[i] !== 'g2') return larguras[i];
    let inicio = i; while (inicio > 0 && larguras[inicio - 1] === 'g2') inicio--;
    let fim = i; while (fim + 1 < larguras.length && larguras[fim + 1] === 'g2') fim++;
    const total = fim - inicio + 1, sobra = total % 3;
    if (!sobra || i - inicio < total - sobra) return 'g2';
    return sobra === 1 ? 'g6' : '';
}
export function Paineis() {
    const visiveis = filtrar(paineis);
    if (!visiveis.length) return null;
    return <section className={cx('block')} id="recursos" aria-labelledby="t-paineis"><div className={cx('wrap')}>
        <Cabecalho olho="Recursos" id="t-paineis" titulo="Toque e veja como funciona." texto="Simulações com dados fictícios, do jeito que aparecem para você e para o seu cliente." />
        <div className={cx('bento')}>{visiveis.map(({ id }, i) => { const p = conteudoPainel[id]; return <article key={id} className={cx('bentoItem', larguraNaFileira(visiveis.map(v => conteudoPainel[v.id].largura), i))} aria-labelledby={`painel-t-${id}`} data-painel={id}>
            <h3 id={`painel-t-${id}`}>{p.titulo}</h3><p>{p.texto}</p>{p.corpo}
        </article>; })}</div>
    </div></section>;
}

export function Modulos() {
    const visiveis = filtrar(modulos);
    if (!visiveis.length) return null;
    return <section className={cx('block')} id="modulos" aria-labelledby="t-modulos"><div className={cx('wrap')}>
        <Cabecalho olho="Por dentro do sistema" id="t-modulos" titulo="Tudo o que o buffet usa no dia a dia." />
        <div data-fundo-proteger><AbasModulos modulos={visiveis} /></div>
    </div></section>;
}

export function WallE() {
    if (!visivel(RECURSOS_SECAO_WALLE)) return null;
    return <section className={cx('block')} id="wall-e" aria-labelledby="t-walle"><div className={cx('wrap')}>
        <Cabecalho olho="Wall-e no WhatsApp" id="t-walle" titulo="Escolha a pergunta. Veja o Wall-e responder." texto="Conversa de exemplo com roteiro fixo. No seu buffet, ele responde com a sua agenda e os seus preços e chama a equipe quando precisa." />
        <div data-fundo-proteger><ChatWallE roteiro={roteiroWallE} /><Ficticio /></div>
    </div></section>;
}

export function ComoFunciona() {
    const visiveis = filtrar(passos);
    return <section className={cx('block')} id="como-funciona" aria-labelledby="t-fluxo"><div className={cx('wrap')}>
        <Cabecalho olho="Como funciona" id="t-fluxo" titulo={tituloFluxo()} />
        <ol className={cx('fluxoPassos')}>{visiveis.map(p => <li key={p.titulo} className={cx('passoCard')}><span className={cx('quem')}>{p.quem}</span><h3>{p.titulo}</h3><p>{p.texto}</p></li>)}</ol>
    </div></section>;
}

export function Confianca() {
    return <section className={cx('block')} id="confianca" aria-labelledby="t-confianca"><div className={cx('wrap')}>
        <Cabecalho olho="Confiança" id="t-confianca" titulo="Seu dinheiro, seus clientes, seus dados." />
        <div className={cx('quatro')}>{filtrar(confianca).map(c => <article key={c.titulo}><h3>{c.titulo}</h3><p>{c.texto}</p></article>)}</div>
    </div></section>;
}

export function Duvidas({ fundador = textoFundador({ fase: 'LEGADO' }) }: { config?: ConfiguracaoSite; fundador?: TextoFundador }) {
    const lista = [...filtrar(perguntas(dias(comercial.testeDias))), { pergunta: 'O que é o Plano Fundador?', resposta: fundador.faq, recursos: [] }];
    const metade = Math.ceil(lista.length / 2);
    return <section className={cx('block')} id="duvidas" aria-labelledby="t-duvidas"><div className={cx('wrap')}>
        <Cabecalho olho="Dúvidas" id="t-duvidas" titulo="Perguntas de quem está decidindo." />
        <div className={cx('faq')}>{[lista.slice(0, metade), lista.slice(metade)].map((coluna, i) => <div key={i}>{coluna.map(p => <details key={p.pergunta}><summary>{p.pergunta}</summary><p>{p.resposta}</p></details>)}</div>)}</div>
    </div></section>;
}
