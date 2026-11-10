'use client';
import { useEffect, useRef, useState } from 'react';
import admin from '@/components/admin/admin.module.css';
import workspace from '@/components/admin/workspace.module.css';
import estilos from '@/components/admin/conexoes-assistentes.module.css';
import { EXEMPLOS_POR_ESCOPO, GUIAS, GUIA_CONFERIDO_EM, LISTA_ASSISTENTES, ORDEM_ESCOPOS, ORIENTACOES, PERGUNTA_PRIMEIRA_CONSULTA, ROTULO_ESCOPO } from '@/components/admin/conexoes-assistentes-guia';
import { avisosDaVista, criarControladorDeConexoes, vistaInicial, type ControladorDeConexoes, type VistaConexoes } from '@/components/admin/conexoes-leitura';
import { adminFetch } from '@/lib/http/admin-fetch';
import { assistenteDoCliente, conexaoDoCartao, explicarFalha, formatarDataHora, SITUACAO_NAO_CONFIRMADA, situacaoDaConexao, type AssistenteId, type ConexaoComEvidencias, type Situacao } from '@/lib/integracoes/oauth/situacao-conexao';

/**
 * Assistentes conectados (canal MCP, docs/MCP_ASSINATURAS_V1.md). Tudo o que esta tela afirma vem dos registros da própria
 * pessoa no iA.Fest: "autorizada" (OAuth concluído) é diferente de "consulta recebida" (chamada autenticada real do
 * assistente). Nenhum botão aqui marca como conectado, instala plugin, testa o assistente ou fala com o fabricante.
 */
export type Conexao = ConexaoComEvidencias & {
    id: string; clienteNome: string; empresaNome: string; escopos: readonly string[]; ultimoUsoEm: string | null; empresaNoPiloto: boolean;
    /** Do servidor: a busca na ajuda passaria agora pelas portas de ambiente (canal, flags e piloto da empresa). */
    consultaDaAjudaLiberada: boolean;
};
export type Identidade = {
    usuario: { nome: string; email: string | null }; empresaAtual: { id: string; nome: string } | null;
    empresas: ReadonlyArray<{ id: string; nome: string }>; selecaoNecessaria: boolean; empresaNoPiloto: boolean;
};
export type Estado = {
    canal: { ativo: boolean; urlServidor: string | null }; identidade: Identidade | null; conexoes: Conexao[]; falhasDisponiveis: boolean;
    /** Do servidor: a ajuda e documentação aprovada carrega agora. Ausente conta como indisponível. */
    ajudaDisponivel?: boolean;
};

function CopiarTexto({ texto, rotulo, marca }: { texto: string; rotulo: string; marca: string }) {
    const [resultado, setResultado] = useState<'' | 'ok' | 'falha'>('');
    const copiar = async () => {
        try {
            await navigator.clipboard.writeText(texto);
            setResultado('ok');
        } catch {
            setResultado('falha');
        }
    };
    return <span className={estilos.copiar}>
        <button type="button" onClick={() => void copiar()} data-copiar={marca}>{resultado === 'ok' ? 'Copiado' : rotulo}</button>
        <span role="status" className={workspace.muted}>{resultado === 'falha' ? 'Não foi possível copiar. Selecione o texto e copie manualmente.' : ''}</span>
    </span>;
}

function SeloSituacao({ situacao }: { situacao: Situacao }) {
    return <span className={estilos.selo} data-situacao={situacao.codigo}>{situacao.titulo}</span>;
}

function BlocoIdentidade({ identidade }: { identidade: Identidade | null }) {
    if (!identidade) return <p className={workspace.muted}>Não foi possível confirmar o usuário e a empresa agora. Atualize a situação antes de continuar.</p>;
    return <dl className={estilos.identidade} data-identidade>
        <div><dt>Usuário do iA.Fest</dt><dd data-usuario>{identidade.usuario.nome}{identidade.usuario.email ? ` · ${identidade.usuario.email}` : ''}</dd></div>
        <div><dt>Empresa ativa</dt><dd data-empresa-ativa>{identidade.empresaAtual?.nome ?? 'Nenhuma selecionada'}</dd></div>
    </dl>;
}

/** Cartão do assistente: sem identidade confirmada, nenhuma conexão é atribuída e nenhuma situação é afirmada. */
export function cartaoDaTela(estado: Estado, assistente: AssistenteId) {
    if (!estado.identidade) return { conexao: null, ativa: null, situacao: SITUACAO_NAO_CONFIRMADA, outrasEmpresas: [] as Conexao[] };
    return conexaoDoCartao(estado.conexoes, assistente, estado.identidade.empresaAtual?.id ?? null);
}

/**
 * O guia só avança para a primeira consulta com conexão utilizável pela situação calculada (9º parecer, P3): concessão não
 * revogada sem credencial vigente é "Precisa reconectar" e não libera o passo.
 */
export function podeIrParaPrimeiraConsulta(situacao: Situacao): boolean {
    return situacao.codigo === 'AUTORIZADA_SEM_CONSULTA' || situacao.codigo === 'CONSULTA_OK';
}

/** Permissão que a pergunta pronta da primeira consulta usa (kidmais_buscar_conhecimento exige conhecimento:read). */
export const ESCOPO_DA_PRIMEIRA_CONSULTA = 'conhecimento:read';

/**
 * Por que a pergunta pronta ainda não pode ser feita, ou null quando pode (10º parecer, P2). Vale ao avançar do passo 4 E ao
 * mostrar o passo 5. Ordem: canal ligado, situação calculada, piloto, portas de ambiente da busca (flags, listas e segredo
 * das referências, do servidor), ajuda e documentação carregando agora (12º parecer) e a permissão que a pergunta usa.
 */
export function bloqueioDaPrimeiraConsulta(cartao: { ativa: Conexao | null; situacao: Situacao }, canalAtivo: boolean, nomeAssistente: string, ajudaDisponivel: boolean): string | null {
    if (!canalAtivo) return 'As consultas por assistentes estão desligadas neste ambiente. A primeira consulta fica disponível quando elas forem ligadas.';
    if (!podeIrParaPrimeiraConsulta(cartao.situacao) || !cartao.ativa) {
        return cartao.situacao.codigo === 'PRECISA_RECONECTAR'
            ? `Esta conexão precisa ser refeita antes da primeira consulta: inicie a conexão de novo no ${nomeAssistente} e autorize outra vez.`
            : `Autorize a conexão no ${nomeAssistente} antes da primeira consulta.`;
    }
    if (!cartao.ativa.empresaNoPiloto)
        return 'Esta empresa não está no piloto agora, então as consultas são recusadas. A pergunta pronta volta a ficar disponível quando a empresa voltar ao piloto. Não é preciso reconectar.';
    if (!cartao.ativa.consultaDaAjudaLiberada)
        return 'As consultas por assistentes estão desligadas para esta empresa neste ambiente. A pergunta pronta fica disponível quando elas forem ligadas. Não é preciso reconectar.';
    if (!ajudaDisponivel)
        return 'A ajuda e documentação do iA.Fest está indisponível agora neste ambiente, então a pergunta pronta ficaria sem resposta. Tente de novo mais tarde. Não é preciso reconectar.';
    if (!cartao.ativa.escopos.includes(ESCOPO_DA_PRIMEIRA_CONSULTA))
        return 'A pergunta pronta usa a ajuda e documentação, e esta conexão não tem essa permissão. Para usá-la, reconecte pelo assistente e marque as permissões que deseja manter e "Consultar ajuda e documentação": a nova autorização substitui a anterior.';
    return null;
}

const PASSOS = ['Escolher assistente', 'Conferir conta e empresa', 'Configurar no assistente', 'Autorizar permissões', 'Fazer a primeira consulta'];

/** Passo sugerido a partir dos registros. Nunca marca concluído por clique: autorizar e consultar dependem da evidência. */
export function passoSugerido(situacao: Situacao): number {
    if (situacao.codigo === 'AUTORIZADA_SEM_CONSULTA' || situacao.codigo === 'CONSULTA_OK') return 5;
    return 2;
}

export function GuiaConexao({ assistente, estado, passo, irPara, fechar, atualizar, atualizando }: {
    assistente: AssistenteId; estado: Estado; passo: number; irPara: (p: number) => void; fechar: () => void; atualizar: () => void; atualizando: boolean;
}) {
    const guia = GUIAS[assistente];
    const identidade = estado.identidade;
    const cartao = cartaoDaTela(estado, assistente);
    const podeSeguir = Boolean(identidade?.empresaAtual && identidade.empresaNoPiloto);
    const bloqueio = bloqueioDaPrimeiraConsulta(cartao, estado.canal.ativo, guia.nome, estado.ajudaDisponivel === true);
    const botaoAtualizar = <button type="button" onClick={atualizar} disabled={atualizando} data-atualizar>{atualizando ? 'Atualizando…' : 'Atualizar situação'}</button>;
    return <section className={workspace.card} aria-labelledby="t-guia" data-guia={assistente}>
        <div className={estilos.guiaTopo}>
            <h2 id="t-guia">Conectar {guia.nome}</h2>
            <button type="button" onClick={fechar} data-fechar-guia>Fechar guia</button>
        </div>
        <ol className={estilos.passos} aria-label="Etapas da conexão">
            {PASSOS.map((nome, i) => {
                const numero = i + 1;
                return <li key={nome} aria-current={numero === passo ? 'step' : undefined} data-feito={numero < passo}>
                    <span aria-hidden="true">{numero}</span>{nome}
                </li>;
            })}
        </ol>

        {passo === 2 && <div data-passo="2">
            <h3>Confira a conta e a empresa</h3>
            <BlocoIdentidade identidade={identidade} />
            <p>A autorização fica com este usuário e vale só para esta empresa. Ela não passa sozinha para outro usuário ou empresa.</p>
            <p className={workspace.muted}>O e-mail da sua conta do {guia.nome} não precisa ser igual ao do iA.Fest. O que define a conexão é o usuário que estiver neste navegador na hora de autorizar.</p>
            {identidade?.selecaoNecessaria && <p role="alert" data-escolher-empresa>Escolha a empresa no menu da conta antes de continuar.</p>}
            {identidade?.empresaAtual && !identidade.empresaNoPiloto && <p role="alert" data-fora-do-piloto>Esta empresa ainda não participa do piloto de conexões com assistentes. Se você tem outra empresa, troque no menu da conta.</p>}
            {identidade && identidade.empresas.length > 1 && <p className={workspace.muted}>Para conectar outra empresa, troque a empresa ativa no menu da conta antes de autorizar.</p>}
            <div className={workspace.actions}><button type="button" disabled={!podeSeguir} onClick={() => irPara(3)} data-continuar>Está certo, continuar</button></div>
        </div>}

        {passo === 3 && <div data-passo="3">
            <h3>Adicione o iA.Fest no {guia.nome}</h3>
            <p className={workspace.muted}>Essa configuração é feita no {guia.nome}, não aqui. {guia.resumo}</p>
            {estado.canal.urlServidor
                ? <div className={estilos.endereco}><code data-url-servidor>{estado.canal.urlServidor}</code><CopiarTexto texto={estado.canal.urlServidor} rotulo="Copiar endereço" marca="endereco" /></div>
                : <p role="alert" data-canal="desligado">As consultas por assistentes estão desligadas neste ambiente, então não há endereço para copiar agora.</p>}
            <ol className={estilos.lista}>{guia.configurar.map((p) => <li key={p}>{p}</li>)}</ol>
            <ul className={`${estilos.lista} ${workspace.muted}`}>{guia.avisos.map((a) => <li key={a}>{a}</li>)}</ul>
            <div className={workspace.actions}>
                {guia.links.map((l) => <a key={l.url} className={estilos.linkBotao} href={l.url} target="_blank" rel="noopener noreferrer" data-link-oficial>{l.rotulo}</a>)}
            </div>
            <p className={workspace.muted}>Passos conferidos na ajuda oficial em {GUIA_CONFERIDO_EM}. Os nomes dos menus podem mudar; se estiver diferente, siga a ajuda oficial.</p>
            <div className={workspace.actions}>
                <button type="button" onClick={() => irPara(2)}>Voltar</button>
                <button type="button" onClick={() => irPara(4)} data-continuar>Já adicionei, continuar</button>
            </div>
        </div>}

        {passo === 4 && <div data-passo="4">
            <h3>Autorize as permissões</h3>
            <p>Inicie a conexão no {guia.nome}. Ele abrirá a tela de autorização do iA.Fest. Confira o usuário e a empresa, marque só o que deseja liberar e clique em Permitir.</p>
            <ul className={estilos.lista}>{ORDEM_ESCOPOS.map((e) => <li key={e}>{ROTULO_ESCOPO[e]}</li>)}</ul>
            <p className={workspace.muted}>Tudo é somente leitura. Para começar, basta a ajuda e documentação.</p>
            <SituacaoAgora situacao={cartao.situacao} />
            {cartao.ativa && bloqueio && <p className={workspace.muted} data-bloqueio-consulta>{bloqueio}</p>}
            {!cartao.ativa && <p className={workspace.muted} data-outro-usuario>Se você autorizou e nada apareceu, a autorização pode ter sido dada com outro usuário ou empresa: ela só aparece para quem autorizou.</p>}
            <div className={workspace.actions}>
                <button type="button" onClick={() => irPara(3)}>Voltar</button>
                {botaoAtualizar}
                <button type="button" onClick={() => irPara(5)} disabled={bloqueio !== null} data-continuar>Continuar para a primeira consulta</button>
            </div>
        </div>}

        {passo === 5 && bloqueio && <div data-passo="5" data-consulta-bloqueada>
            <h3>Faça a primeira consulta no {guia.nome}</h3>
            <p role="alert" data-bloqueio-consulta>{bloqueio}</p>
            <SituacaoAgora situacao={cartao.situacao} />
            {cartao.situacao.codigo === 'CONSULTA_OK' && <p data-consulta-confirmada>Funcionou: o iA.Fest recebeu uma chamada autenticada do {guia.nome} nesta conexão.</p>}
            <div className={workspace.actions}>
                <button type="button" onClick={() => irPara(4)}>Voltar</button>
                {botaoAtualizar}
            </div>
        </div>}

        {passo === 5 && !bloqueio && <div data-passo="5">
            <h3>Faça a primeira consulta no {guia.nome}</h3>
            <p>{guia.habilitarNaConversa} Depois, envie esta pergunta:</p>
            <blockquote className={estilos.pergunta} data-pergunta>{PERGUNTA_PRIMEIRA_CONSULTA}</blockquote>
            <CopiarTexto texto={PERGUNTA_PRIMEIRA_CONSULTA} rotulo="Copiar pergunta" marca="pergunta" />
            <p className={workspace.muted}>Se o assistente pedir aprovação, confira que é a busca na ajuda do iA.Fest. Esta pergunta não usa dados da empresa.</p>
            <SituacaoAgora situacao={cartao.situacao} />
            {cartao.situacao.codigo === 'CONSULTA_OK'
                ? <p data-consulta-confirmada>Funcionou: o iA.Fest recebeu uma chamada autenticada do {guia.nome} nesta conexão.</p>
                : <p className={workspace.muted} data-aguardando-consulta>A confirmação só aparece depois que o {guia.nome} fizer a consulta. Esta página não faz nenhum teste por conta própria.</p>}
            <div className={workspace.actions}>
                <button type="button" onClick={() => irPara(4)}>Voltar</button>
                {botaoAtualizar}
            </div>
        </div>}
    </section>;
}

function SituacaoAgora({ situacao }: { situacao: Situacao }) {
    return <p className={estilos.situacaoAgora} data-situacao-agora={situacao.codigo}>
        <SeloSituacao situacao={situacao} /> <span>{situacao.detalhe}</span>
        {situacao.causa && <><br /><span data-causa>{situacao.causa}</span></>}
    </p>;
}

function CartoesAssistentes({ estado, escolher, escolhido }: { estado: Estado; escolher: (a: AssistenteId, s: Situacao) => void; escolhido: AssistenteId | null }) {
    return <div className={estilos.cartoes}>
        {LISTA_ASSISTENTES.map((id) => {
            const guia = GUIAS[id];
            const cartao = cartaoDaTela(estado, id);
            const conectado = cartao.ativa !== null;
            return <article key={id} className={estilos.cartao} data-cartao={id} data-escolhido={escolhido === id}>
                <h3>{guia.nome}</h3>
                <p><SeloSituacao situacao={cartao.situacao} /></p>
                <p className={workspace.muted}>{cartao.situacao.detalhe}</p>
                {cartao.outrasEmpresas.length > 0 && <p className={workspace.muted} data-outras-empresas>Também conectado em: {cartao.outrasEmpresas.map((c) => c.empresaNome).join(', ')}.</p>}
                <button type="button" onClick={() => escolher(id, cartao.situacao)} data-escolher={id}>{conectado ? 'Ver etapas' : cartao.conexao ? 'Conectar de novo' : 'Configurar'}</button>
            </article>;
        })}
    </div>;
}

export function ItemConexao({ conexao, revogar, ocupado, emEspera = [] }: { conexao: Conexao; revogar: (id: string) => void; ocupado: string | null; emEspera?: readonly string[] }) {
    const situacao = situacaoDaConexao(conexao);
    const falha = explicarFalha(conexao.evidencias.ultimaFalha);
    const exemplos = ORDEM_ESCOPOS.filter((e) => conexao.escopos.includes(e)).flatMap((e) => EXEMPLOS_POR_ESCOPO[e] ?? []);
    const falta = ORDEM_ESCOPOS.filter((e) => !conexao.escopos.includes(e));
    return <article className={estilos.conexao} data-conexao={conexao.id} data-situacao={situacao.codigo}>
        <h3>{conexao.clienteNome} · <span data-empresa-conexao>{conexao.empresaNome}</span></h3>
        <p><SeloSituacao situacao={situacao} /> <span className={workspace.muted}>{situacao.detalhe}</span></p>
        {situacao.causa && <p className={estilos.comprovado} data-causa-comprovada><strong>O que o iA.Fest registrou:</strong> {situacao.causa} Para voltar, reconecte pelo próprio assistente.</p>}
        {!situacao.causa && falha && <p className={estilos.comprovado} data-falha-comprovada><strong>O que o iA.Fest registrou em {formatarDataHora(conexao.evidencias.ultimaFalha?.em ?? null)}:</strong> {falha.titulo} {falha.acao}</p>}
        {!conexao.empresaNoPiloto && <p className={estilos.comprovado} data-empresa-fora-piloto><strong>O que o iA.Fest registrou:</strong> esta empresa não está no piloto agora, então as consultas são recusadas. Não é preciso reconectar.</p>}
        <p className={estilos.rotulo}>Permissões concedidas</p>
        <ul className={estilos.lista}>{ORDEM_ESCOPOS.filter((e) => conexao.escopos.includes(e)).map((e) => <li key={e} data-escopo-concedido={e}>{ROTULO_ESCOPO[e]}</li>)}</ul>
        {falta.length > 0 && <p className={workspace.muted} data-escopo-faltando>Não concedidas: {falta.map((e) => ROTULO_ESCOPO[e]).join('; ')}. Para liberar, reconecte pelo assistente e marque as permissões que deseja manter e as que deseja adicionar: a nova autorização substitui a anterior.</p>}
        {exemplos.length > 0 && <details className={estilos.detalhes}>
            <summary>Exemplos de perguntas</summary>
            <ul className={estilos.lista}>{exemplos.map((x) => <li key={x} data-exemplo>{x}</li>)}</ul>
        </details>}
        <button type="button" className={workspace.danger} disabled={ocupado !== null || emEspera.includes(conexao.id)} onClick={() => revogar(conexao.id)} data-revogar={conexao.id}>
            {ocupado === conexao.id ? 'Desconectando…' : emEspera.includes(conexao.id) ? 'Aguardando confirmação' : 'Desconectar'}
        </button>
    </article>;
}

export function ListaConexoes({ estado, revogar, ocupado, emEspera = [] }: { estado: Estado; revogar: (id: string) => void; ocupado: string | null; emEspera?: readonly string[] }) {
    const ativas = estado.conexoes.filter((c) => !c.revogadaEm);
    const antigas = estado.conexoes.filter((c) => c.revogadaEm);
    return <section className={workspace.card} aria-labelledby="t-conexoes" data-conexoes={ativas.length}>
        <h2 id="t-conexoes">Suas conexões</h2>
        {!estado.canal.ativo && <p data-canal="desligado">As consultas por assistentes estão desligadas neste ambiente. Conexões autorizadas antes continuam listadas abaixo e podem ser desconectadas.</p>}
        {ativas.length === 0 && <p className={workspace.muted}>Nenhum assistente conectado à sua conta.</p>}
        {!estado.falhasDisponiveis && ativas.length > 0 && <p role="status" className={estilos.comprovado} data-falhas-indisponiveis>Não foi possível ler agora as falhas registradas, então esta página pode não mostrar uma falha recente. A situação de cada conexão e o botão Desconectar continuam valendo. Atualizar situação tenta de novo.</p>}
        {ativas.map((c) => <ItemConexao key={c.id} conexao={c} revogar={revogar} ocupado={ocupado} emEspera={emEspera} />)}
        {antigas.length > 0 && <details className={estilos.detalhes}>
            <summary>Conexões encerradas ({antigas.length})</summary>
            <ul className={estilos.lista}>{antigas.map((c) => {
                const s = situacaoDaConexao(c);
                return <li key={c.id} data-encerrada={s.codigo}>{c.clienteNome} · {c.empresaNome} · {s.titulo}: {s.detalhe}{s.causa ? ` ${s.causa}` : ''}</li>;
            })}</ul>
        </details>}
        <p className={workspace.muted}>Desconectar impede novas consultas imediatamente. O que já foi mostrado no histórico do assistente continua lá e segue as regras do fabricante.</p>
        <p className={workspace.muted}>Ficar sem uso não desconecta. Esta página mostra o que o iA.Fest registrou: não testa o assistente nem garante que ele esteja habilitado em cada conversa.</p>
    </section>;
}

export function AjudaRecuperacao() {
    return <section className={workspace.card} aria-labelledby="t-ajuda-conexao" data-recuperacao>
        <h2 id="t-ajuda-conexao">Algo não funcionou?</h2>
        <p className={workspace.muted}>O que o iA.Fest comprovou aparece em cada conexão, em Suas conexões. As sugestões abaixo partem do que você vê no assistente e podem não ser a causa. Comece pela primeira que se aplica; apagar e recriar o conector não costuma ser o primeiro passo.</p>
        {ORIENTACOES.map((o) => <details key={o.id} className={estilos.detalhes} data-orientacao={o.id}>
            <summary>{o.sintoma}</summary>
            <p><strong>Como conferir:</strong> {o.comoConfirmar}</p>
            <p><strong>Sugestão:</strong> {o.oQueFazer}</p>
        </details>)}
        <p className={workspace.muted}>O iA.Fest nunca pede a senha, o login ou a chave da sua assinatura do assistente.</p>
    </section>;
}

export function TelaConexoes({ estado, revogar, ocupado, emEspera = [], atualizar, atualizando, assistenteInicial = null, passoInicial = 2 }: {
    estado: Estado; revogar: (id: string) => void; ocupado: string | null; emEspera?: readonly string[]; atualizar: () => void; atualizando: boolean; assistenteInicial?: AssistenteId | null; passoInicial?: number;
}) {
    const [assistente, setAssistente] = useState<AssistenteId | null>(assistenteInicial);
    const [passo, setPasso] = useState(passoInicial);
    const escolher = (id: AssistenteId, situacao: Situacao) => { setAssistente(id); setPasso(passoSugerido(situacao)); };
    const outros = estado.conexoes.some((c) => assistenteDoCliente(c.clientId) === null && !c.revogadaEm);
    return <>
        <section className={workspace.card} aria-labelledby="t-assistentes" data-assistentes>
            <div className={estilos.guiaTopo}>
                <h2 id="t-assistentes">Escolha o assistente</h2>
                <button type="button" onClick={atualizar} disabled={atualizando} data-atualizar-topo>{atualizando ? 'Atualizando…' : 'Atualizar situação'}</button>
            </div>
            <BlocoIdentidade identidade={estado.identidade} />
            <CartoesAssistentes estado={estado} escolher={escolher} escolhido={assistente} />
            {outros && <p className={workspace.muted}>Outras conexões aparecem em Suas conexões.</p>}
            <p className={workspace.muted}>O Gemini ainda não faz parte deste piloto.</p>
        </section>
        {assistente && <GuiaConexao assistente={assistente} estado={estado} passo={passo} irPara={setPasso} fechar={() => setAssistente(null)} atualizar={atualizar} atualizando={atualizando} />}
        <ListaConexoes estado={estado} revogar={revogar} ocupado={ocupado} emEspera={emEspera} />
        <AjudaRecuperacao />
    </>;
}

/** Sem lista recebida, o erro da leitura vem com um botão: quem fica na aba não precisa recarregar a página. */
export function CorpoConexoes({ vista, revogar, atualizar }: { vista: VistaConexoes<Estado>; revogar: (id: string) => void; atualizar: () => void }) {
    if (vista.estado) return <TelaConexoes estado={vista.estado} revogar={revogar} ocupado={vista.ocupado} emEspera={vista.emEspera} atualizar={atualizar} atualizando={vista.atualizando} />;
    if (!avisosDaVista(vista)) return <p className={workspace.muted}>Carregando…</p>;
    return <p><button type="button" onClick={atualizar} disabled={vista.atualizando} data-tentar-de-novo>{vista.atualizando ? 'Atualizando…' : 'Tentar de novo'}</button></p>;
}

export default function ConexoesAssistentes() {
    const [vista, setVista] = useState(() => vistaInicial<Estado>());
    // Leitura e Desconectar ficam em conexoes-leitura.ts: uma leitura por vez, com prazo, cancelada ao sair da tela.
    const controlador = useRef<ControladorDeConexoes | null>(null);
    useEffect(() => {
        const c = criarControladorDeConexoes<Estado>({ buscar: adminFetch, publicar: setVista });
        controlador.current = c;
        c.iniciar();
        // Quem volta da aba do assistente vê a situação atual sem precisar clicar. Só relê o que já está registrado.
        const aoVoltar = () => c.aoFocar();
        window.addEventListener('focus', aoVoltar);
        return () => {
            c.encerrar();
            controlador.current = null;
            window.removeEventListener('focus', aoVoltar);
        };
    }, []);
    const avisos = avisosDaVista(vista);
    return <main className={admin.page} data-conexoes-ia>
        <h1>Assistentes conectados</h1>
        <p className={workspace.muted} style={{ maxWidth: 760 }}>Converse com o ChatGPT ou o Claude da sua própria assinatura sobre a documentação do iA.Fest e, se você permitir, o resumo da agenda e dos recebíveis. O assistente só consulta: não envia mensagens, não altera cadastros e não vê nomes de clientes nem dados de crianças.</p>
        <p role="alert">{avisos}</p>
        <CorpoConexoes vista={vista} revogar={(id) => void controlador.current?.revogar(id)} atualizar={() => controlador.current?.atualizar()} />
    </main>;
}
