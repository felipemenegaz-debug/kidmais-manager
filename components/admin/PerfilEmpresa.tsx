'use client';
/* eslint-disable @next/next/no-img-element -- Prévias de imagens locais/data URLs, sem otimização remota. */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import { campoExigidoNaAplicacao, contatoExigidoNaAplicacao, type CadastroPerfil } from '@/lib/perfil/cadastro';
import { aplicarConsultaCep, cepCompleto, type PedidoCep } from '@/lib/perfil/consulta-cep';
import { agruparComparacao, aposAplicar, aposCarga, aposConflito, aposDigitacao, aposOperacao, cadastrosIguais, confirmarRevisao, devePreencherNaRetentativa, estadoFluxoInicial, identidadeDoConflito, linhasAntesDepois, pedidoRascunho, podeAplicar, resolverCarregamento, revisaoAindaConfere, type CapacidadesTela, type EstadoFluxo } from '@/lib/perfil/tela-cadastro';
import { AdminIcon } from './AdminIcon';
import styles from './perfil-empresa.module.css';
import { erroArquivoLogo, LOGO_MAX_UPLOAD_MB } from '@/lib/perfil/logo-limites';

type Historico = {
    numero: number;
    estado: string;
    motivo: string | null;
    versaoBase: number;
    editorNome: string;
    editadoEm: string;
    aplicadorNome: string | null;
    aplicadoEm: string | null;
};
type Rascunho = { numero: number; edicao: number; versaoBase: number; conteudo: CadastroPerfil };
type Resposta = {
    estruturaInstalada: boolean;
    vazio: boolean;
    /** Empresa provisionada pelo painel do desenvolvedor, ainda sem Perfil: a Gestão pode criá-lo aqui. */
    perfilAusente?: boolean;
    podeCriar?: boolean;
    empresa?: { codigo: string | null; nome: string | null } | null;
    contexto: {
        codigoEmpresa: string;
        codigoUnidade: string;
        versao: number;
        cadastro: CadastroPerfil;
        rascunho: Rascunho | null;
    } | null;
    historico: Historico[];
    capacidades: CapacidadesTela | null;
};

function Ajuda({ texto }: { texto: string }) {
    const id = useId();
    const [aberto, setAberto] = useState(false);
    return <span className={styles.ajuda}>
        <button type="button" aria-label="Ajuda sobre o campo" aria-expanded={aberto} aria-controls={id} onClick={() => setAberto((valor) => !valor)} onKeyDown={(evento) => { if (evento.key === 'Escape' && aberto) { evento.preventDefault(); setAberto(false); } }} onBlur={() => setAberto(false)}><span aria-hidden="true">?</span></button>
        {aberto && <span id={id} role="note" className={styles.nota}>{texto}</span>}
    </span>;
}

// Nome acessível do campo: inclui a exigência na aplicação, já que o asterisco visual fica oculto para leitores de tela.
function nomeAcessivel(texto: string, campo: string, mesmoEndereco: boolean) {
    return campoExigidoNaAplicacao(campo, mesmoEndereco) ? `${texto} (obrigatório ao aplicar)` : texto;
}

function Rotulo({ texto, campo, mesmoEndereco, ajuda }: { texto: string; campo?: string; mesmoEndereco: boolean; ajuda?: string }) {
    const exigido = campo ? campoExigidoNaAplicacao(campo, mesmoEndereco) : false;
    // O asterisco é só visual; leitores de tela recebem o texto "obrigatório ao aplicar".
    return <span className={styles.rotulo}>{texto}{exigido && <><span className={styles.asterisco} aria-hidden="true">*</span><span className={styles.srOnly}> (obrigatório ao aplicar)</span></>}{ajuda && <Ajuda texto={ajuda} />}</span>;
}

const ROTULO_CAPACIDADE: Record<string, string> = {
    PERFIL_CONSULTAR: 'consultar',
    PERFIL_EDITAR_RASCUNHO: 'editar o rascunho',
    PERFIL_APLICAR: 'aplicar o cadastro',
    PERFIL_ADMINISTRAR_CONCESSOES: 'administrar as concessões',
};
function rotuloCapacidade(capacidade: string) {
    return ROTULO_CAPACIDADE[capacidade] ?? capacidade.toLowerCase();
}

function dataLegivel(valor: string) {
    const data = new Date(valor);
    if (Number.isNaN(data.getTime()))
        return valor;
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(data);
}

export default function PerfilEmpresa() {
    const revisaoRef = useRef<HTMLDialogElement>(null);
    const [carregando, setCarregando] = useState(true);
    const [ocupado, setOcupado] = useState(false);
    const [semPermissao, setSemPermissao] = useState(false);
    const [acessoMensagem, setAcessoMensagem] = useState('');
    const [dados, setDados] = useState<Resposta | null>(null);
    const [fluxo, setFluxo] = useState<EstadoFluxo>(estadoFluxoInicial);
    const [identidadeConflito, setIdentidadeConflito] = useState<{ numero: number | null; edicao: number | null; versaoBase: number } | null>(null);
    const [erro, setErro] = useState('');
    const [sucesso, setSucesso] = useState('');
    const [motivo, setMotivo] = useState('');
    const [senha, setSenha] = useState('');
    const [logoErro, setLogoErro] = useState('');
    const [logoPreparada, setLogoPreparada] = useState('');
    const [preparandoLogo, setPreparandoLogo] = useState(false);
    const [cepStatus, setCepStatus] = useState<{ sede: string; unidade: string }>({ sede: '', unidade: '' });
    const [senhaCriacao, setSenhaCriacao] = useState('');
    const [pedirSenhaCriacao, setPedirSenhaCriacao] = useState(false);
    // Perfil existente sem administrador elegível: resposta mínima do servidor (403) que permite à Gestão assumir a administração.
    const [concessaoInicial, setConcessaoInicial] = useState<{ elegivel: boolean; motivo: string | null; capacidadesFaltantes: string[] } | null>(null);
    const [empresaSemAcesso, setEmpresaSemAcesso] = useState<{ codigo: string | null; nome: string | null } | null>(null);
    const [confirmarConcessao, setConfirmarConcessao] = useState(false);
    const cepTicket = useRef({ sede: 0, unidade: 0 });
    const cargaTicket = useRef(0);
    const operacaoTicket = useRef(0);
    const bloqueio = useRef(false);
    const fluxoRef = useRef(fluxo);
    const formRef = useRef(fluxo.form);
    const { form, salvo, numero, edicao, versaoBase, confirmado, conflito } = fluxo;
    const sujo = !cadastrosIguais(form, salvo);
    const capacidades = dados?.capacidades;
    const podeEditar = Boolean(capacidades?.PERFIL_EDITAR_RASCUNHO);
    const podeAplicarCapacidade = Boolean(capacidades?.PERFIL_APLICAR);

    const publicar = useCallback((proximo: EstadoFluxo) => {
        fluxoRef.current = proximo;
        formRef.current = proximo.form;
        setFluxo(proximo);
    }, []);

    const aplicarCorpo = useCallback((corpo: Resposta, substituirForm: boolean) => {
        setDados(corpo);
        const proximo = aposCarga(fluxoRef.current, {
            contexto: corpo.contexto
                ? {
                    versao: corpo.contexto.versao,
                    cadastro: corpo.contexto.cadastro,
                    rascunho: corpo.contexto.rascunho,
                }
                : null,
        }, substituirForm || devePreencherNaRetentativa(fluxoRef.current));
        publicar(proximo);
    }, [publicar]);

    const carregar = useCallback(async (substituirForm: boolean) => {
        const meu = ++cargaTicket.current;
        setCarregando(true);
        setErro('');
        setSemPermissao(false);
        try {
            const resposta = await adminFetch('/api/admin/configuracoes/perfil-empresa');
            const corpo = await resposta.json();
            if (meu !== cargaTicket.current)
                return;
            if (resposta.status === 403) {
                setSemPermissao(true);
                setAcessoMensagem(corpo.codigo === 'PERFIL_SEM_CONCESSAO' ? (corpo.erro || 'Sem concessão ativa para consultar o perfil.') : (corpo.erro || 'A API negou o acesso ao perfil.'));
                const detalhes = (corpo.detalhes ?? null) as { concessaoInicial?: { elegivel: boolean; motivo: string | null; capacidadesFaltantes: string[] }; empresa?: { codigo: string | null; nome: string | null } } | null;
                setConcessaoInicial(corpo.codigo === 'PERFIL_SEM_CONCESSAO' && detalhes?.concessaoInicial ? detalhes.concessaoInicial : null);
                setEmpresaSemAcesso(detalhes?.empresa ?? null);
                return;
            }
            setConcessaoInicial(null);
            setEmpresaSemAcesso(null);
            if (!resposta.ok || !corpo.ok)
                throw new Error(corpo.erro ?? 'Não foi possível carregar o perfil.');
            aplicarCorpo(corpo.data, substituirForm);
        } catch (error) {
            if (meu !== cargaTicket.current)
                return;
            setErro(error instanceof Error ? error.message : 'Não foi possível falar com o servidor. Tente novamente.');
        } finally {
            if (meu === cargaTicket.current)
                setCarregando(false);
        }
    }, [aplicarCorpo]);

    useEffect(() => {
        let ativo = true;
        void (async () => {
            await Promise.resolve();
            if (ativo)
                await carregar(true);
        })();
        return () => { ativo = false; };
    }, [carregar]);

    function atualizar(parcial: Partial<CadastroPerfil>) {
        const proximoForm = { ...formRef.current, ...parcial };
        publicar(aposDigitacao(fluxoRef.current, proximoForm));
        setSucesso('');
    }

    /**
     * Duas operações da Gestão sobre a estrutura do Perfil, ambas revalidadas no servidor dentro da transação:
     *   - `criar-perfil`: empresa nova sem Perfil — cria perfil, uma unidade e as capacidades para quem criou;
     *   - `concessao-inicial`: Perfil existente sem administrador elegível — a Gestão assume a administração.
     * O servidor exige Gestão nesta empresa e senha confirmada há no máximo 5 minutos; passado o prazo, pede a senha
     * aqui (renovação comprovada) e repete a operação uma única vez. Nada é copiado de outra empresa.
     */
    async function estruturarPerfil(acao: 'criar-perfil' | 'concessao-inicial') {
        if (bloqueio.current)
            return;
        if (acao === 'concessao-inicial' && !confirmarConcessao)
            return;
        bloqueio.current = true;
        setOcupado(true);
        setErro('');
        setSucesso('');
        const nadaFeito = acao === 'criar-perfil' ? 'Nada foi criado.' : 'Nenhuma capacidade foi concedida.';
        try {
            if (pedirSenhaCriacao) {
                const auth = await reautenticarSessao(senhaCriacao);
                if (!auth.ok)
                    throw new Error(auth.senhaIncorreta ? `Senha incorreta. ${nadaFeito}` : auth.erro);
            }
            const resposta = await adminFetch('/api/admin/configuracoes/perfil-empresa', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ acao, confirmar: true }),
            });
            const corpo = await resposta.json() as { ok?: boolean; erro?: string; codigo?: string; data?: { criado: boolean; motivo: string; capacidadesConcedidas?: string[] } };
            if (!resposta.ok || !corpo.ok) {
                if (corpo.codigo === 'PERFIL_REAUTENTICACAO') {
                    setPedirSenhaCriacao(true);
                    setErro(acao === 'criar-perfil' ? 'Confirme sua senha para criar o perfil da empresa.' : 'Confirme sua senha para assumir a administração do perfil.');
                    return;
                }
                throw new Error(corpo.erro ?? (acao === 'criar-perfil' ? 'Não foi possível criar o perfil.' : 'Não foi possível assumir a administração do perfil.'));
            }
            setSenhaCriacao('');
            setPedirSenhaCriacao(false);
            setConfirmarConcessao(false);
            setSucesso(corpo.data?.criado
                ? 'Perfil criado. Preencha os dados, salve o rascunho e aplique o cadastro.'
                : corpo.data?.motivo === 'CONCESSAO_INICIAL'
                    ? `Administração do perfil assumida: ${(corpo.data.capacidadesConcedidas ?? []).length} capacidade(s) concedida(s) a esta conta.`
                    : 'O perfil já existia e esta conta já tinha acesso.');
            await carregar(true);
            window.dispatchEvent(new Event('kidmais-logo-aplicada'));
        } catch (error) {
            setErro(error instanceof Error ? error.message : (acao === 'criar-perfil' ? 'Não foi possível criar o perfil.' : 'Não foi possível assumir a administração do perfil.'));
        } finally {
            bloqueio.current = false;
            setOcupado(false);
        }
    }
    const criarPerfil = () => estruturarPerfil('criar-perfil');

    async function selecionarLogo(arquivo?: File) {
        if (!arquivo || bloqueio.current || !podeEditar) return;
        setLogoErro('');
        setLogoPreparada('');
        const erroArquivo = erroArquivoLogo(arquivo);
        if (erroArquivo) { setLogoErro(erroArquivo); return; }
        bloqueio.current = true; setOcupado(true); setPreparandoLogo(true);
        try {
            const envio = new FormData(); envio.append('arquivo', arquivo);
            const resposta = await adminFetch('/api/admin/configuracoes/perfil-empresa/logo', {method:'POST',body:envio});
            const corpo = await resposta.json();
            if (!resposta.ok || !corpo.ok) throw new Error(corpo.erro ?? 'Não foi possível preparar a logo.');
            atualizar({logoDataUrl:corpo.data.logoDataUrl});
            setLogoPreparada(`${arquivo.name}: prévia pronta. Salve o rascunho e revise para aplicar.`);
        } catch(error) { setLogoErro(error instanceof Error ? error.message : 'Não foi possível preparar a logo.'); }
        finally { bloqueio.current = false; setOcupado(false); setPreparandoLogo(false); }
    }

    async function consultarCep(alvo: 'sede' | 'unidade', valor: string) {
        const atual = formRef.current[alvo];
        atualizar({ [alvo]: { ...atual, cep: valor } });
        const cep = cepCompleto(valor);
        const ticket = ++cepTicket.current[alvo];
        if (!cep) {
            setCepStatus((estado) => ({ ...estado, [alvo]: '' }));
            return;
        }
        const pedido: PedidoCep = {
            cep,
            logradouro: atual.logradouro,
            bairro: atual.bairro,
            cidade: atual.cidade,
            uf: atual.uf,
        };
        setCepStatus((estado) => ({ ...estado, [alvo]: 'Consultando CEP.' }));
        try {
            const resposta = await adminFetch('/api/endereco/consultar-cep', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cep }),
            });
            const corpo = await resposta.json() as { ok?: boolean; codigo?: string; logradouro?: string; bairro?: string; cidade?: string; uf?: string; cep?: string };
            if (ticket !== cepTicket.current[alvo])
                return;
            const vigente = formRef.current[alvo];
            if (!corpo.ok) {
                const mensagem = corpo.codigo === 'CEP_NAO_ENCONTRADO'
                    ? 'CEP não encontrado. Preencha o endereço manualmente.'
                    : 'Consulta de CEP indisponível. Preencha o endereço manualmente.';
                setCepStatus((estado) => ({ ...estado, [alvo]: mensagem }));
                return;
            }
            const preenchido = aplicarConsultaCep(vigente, pedido, {
                cep: corpo.cep || cep,
                logradouro: corpo.logradouro ?? '',
                bairro: corpo.bairro ?? '',
                cidade: corpo.cidade ?? '',
                uf: corpo.uf ?? '',
            });
            if (preenchido !== vigente)
                atualizar({ [alvo]: preenchido });
            // Nunca substituir em silêncio: se a consulta trocou algo que já estava preenchido, dizer o quê.
            const substituidos = (['logradouro', 'bairro', 'cidade', 'uf'] as const)
                .filter((campo) => vigente[campo].trim() !== '' && vigente[campo].trim().toLocaleUpperCase('pt-BR') !== preenchido[campo].trim().toLocaleUpperCase('pt-BR'))
                .map((campo) => campo === 'uf' ? 'UF' : campo);
            if (vigente.cep.replace(/\D/g, '') === cep)
                setCepStatus((estado) => ({ ...estado, [alvo]: substituidos.length
                    ? `O CEP atualizou ${substituidos.join(', ')}; o valor anterior foi substituído. Confira antes de salvar. Número e complemento continuam manuais.`
                    : 'Logradouro, bairro, cidade e UF foram consultados. Número e complemento continuam manuais.' }));
        } catch {
            if (ticket !== cepTicket.current[alvo])
                return;
            setCepStatus((estado) => ({ ...estado, [alvo]: 'Consulta de CEP indisponível. Preencha o endereço manualmente.' }));
        }
    }

    async function salvar() {
        if (bloqueio.current || !podeEditar)
            return;
        bloqueio.current = true;
        const meu = ++operacaoTicket.current;
        const enviado = formRef.current;
        const pedido = pedidoRascunho({ ...fluxoRef.current, form: enviado });
        setOcupado(true);
        setErro('');
        setSucesso('');
        try {
            const resposta = await adminFetch('/api/admin/configuracoes/perfil-empresa', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pedido),
            });
            const corpo = await resposta.json();
            const tardio = meu !== operacaoTicket.current;
            const conflitoResposta = corpo.codigo === 'PERFIL_CONFLITO' || resposta.status === 409;
            const efeito = aposOperacao({
                formAtual: formRef.current,
                enviado,
                ok: Boolean(corpo.ok) && !conflitoResposta,
                tardio,
            });
            if (!efeito.atualizarSalvo || !efeito.salvo) {
                if (tardio)
                    return;
                if (conflitoResposta) {
                    publicar(aposConflito(fluxoRef.current, formRef.current));
                    setIdentidadeConflito(identidadeDoConflito(corpo.detalhes));
                }
                setErro(corpo.erro ?? 'Não foi possível salvar o rascunho. Tente novamente.');
                return;
            }
            publicar({
                ...fluxoRef.current,
                form: efeito.form,
                salvo: efeito.salvo,
                numero: corpo.data.numero,
                edicao: corpo.data.edicao,
                versaoBase: corpo.data.versaoBase,
                conflito: false,
                confirmado: false,
                conteudoConfirmado: null,
            });
            setIdentidadeConflito(null);
            setSucesso('Rascunho salvo.');
        } catch (error) {
            if (meu !== operacaoTicket.current)
                return;
            setErro(error instanceof Error ? error.message : 'Não foi possível falar com o servidor. Tente novamente.');
        } finally {
            if (meu === operacaoTicket.current) {
                bloqueio.current = false;
                setOcupado(false);
            }
        }
    }

    async function aplicar() {
        if (bloqueio.current || !podeAplicar({
            sujo, ocupado, numero, edicao, motivo, permitir: podeAplicarCapacidade, confirmado,
            conflito, confirmacaoConfere: revisaoAindaConfere(fluxoRef.current),
        }))
            return;
        if (numero == null || edicao == null)
            return;
        bloqueio.current = true;
        const meu = ++operacaoTicket.current;
        const enviado = fluxoRef.current.salvo;
        setOcupado(true);
        setErro('');
        try {
            if (senha) {
                // Renovação comprovada: senha incorreta mantém sessão, rascunho e formulário; sucesso segue para aplicar
                // na mesma página, uma única vez.
                const auth = await reautenticarSessao(senha);
                if (!auth.ok)
                    throw new Error(auth.senhaIncorreta ? 'Senha incorreta. O rascunho foi preservado.' : auth.erro);
            }
            const resposta = await adminFetch('/api/admin/configuracoes/perfil-empresa', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ acao: 'aplicar', numero, edicao, versaoBase, confirmar: true, motivo }),
            });
            const corpo = await resposta.json();
            if (meu !== operacaoTicket.current)
                return;
            if (!corpo.ok) {
                if (corpo.codigo === 'PERFIL_CONFLITO' || resposta.status === 409) {
                    publicar(aposConflito(fluxoRef.current, formRef.current));
                    setIdentidadeConflito(identidadeDoConflito(corpo.detalhes));
                }
                setErro(corpo.erro ?? 'Não foi possível aplicar o cadastro. Tente novamente.');
                return;
            }
            setSucesso('Cadastro aplicado. Contratos e PDFs existentes não foram alterados.');
            setMotivo('');
            setSenha('');
            const proximo = aposAplicar(fluxoRef.current, {
                formAtual: formRef.current,
                enviado,
                versaoAplicada: Number(corpo.data.versao),
            });
            publicar(proximo);
            await carregar(!proximo.digitou);
            window.dispatchEvent(new Event('kidmais-logo-aplicada'));
        } catch (error) {
            if (meu !== operacaoTicket.current)
                return;
            setErro(error instanceof Error ? error.message : 'Não foi possível falar com o servidor. Tente novamente.');
        } finally {
            if (meu === operacaoTicket.current) {
                bloqueio.current = false;
                setOcupado(false);
            }
        }
    }

    const sede = form.sede;
    const unidade = form.unidade;
    const comparacao = dados?.contexto ? linhasAntesDepois(dados.contexto.cadastro, salvo) : [];
    const grupos = agruparComparacao(comparacao);
    const mesmo = form.mesmoEnderecoSede;
    async function resolver() {
        if (!identidadeConflito || bloqueio.current)
            return;
        bloqueio.current = true;
        setOcupado(true);
        setErro('');
        try {
            const resposta = await adminFetch('/api/admin/configuracoes/perfil-empresa');
            const corpo = await resposta.json();
            const contexto = corpo.data?.contexto;
            if (!corpo.ok || !contexto)
                throw new Error(corpo.erro ?? 'Não foi possível carregar a revisão atual.');
            setDados(corpo.data);
            publicar(resolverCarregamento(fluxoRef.current, {
                contexto: {
                    versao: contexto.versao,
                    cadastro: contexto.cadastro,
                    rascunho: contexto.rascunho,
                },
            }));
            setIdentidadeConflito(null);
        } catch (error) {
            setErro(error instanceof Error ? error.message : 'Não foi possível carregar a revisão atual.');
        } finally {
            bloqueio.current = false;
            setOcupado(false);
        }
    }

    const aplicarLiberado = podeAplicar({
        sujo, ocupado, numero, edicao, motivo, permitir: podeAplicarCapacidade, confirmado,
        conflito, confirmacaoConfere: revisaoAindaConfere(fluxo),
    });

    return <main className={styles.page} data-profile-page aria-busy={ocupado || carregando}>
        <header className={styles.header}>
            <div className={styles.heading}><h1>Perfil da Empresa</h1><div className={styles.unidadeAtual}><span>Unidade atual</span><strong>{form.unidadeNome || dados?.contexto?.codigoUnidade || '—'}</strong></div>{dados?.contexto && <span className={styles.badge} data-draft={Boolean(dados.contexto.rascunho || sujo)}>{dados.contexto.rascunho || sujo ? 'Rascunho' : 'Publicado'}</span>}</div>
            <div className={styles.headerRight}>
                <div className={styles.acoes}>{podeEditar && <button className={styles.secundario} type="button" onClick={() => void salvar()} disabled={ocupado || carregando || semPermissao}>Salvar rascunho</button>}
                {podeAplicarCapacidade && <button className={styles.primario} type="button" onClick={() => revisaoRef.current?.showModal()} disabled={ocupado || carregando || semPermissao}>Revisar e aplicar</button>}</div>
            </div>
        </header>
        {carregando && <p className={styles.estado} role="status">Carregando perfil.</p>}
        {ocupado && <p className={styles.estado} role="status">Operação em andamento.</p>}
        {!carregando && semPermissao && <section className={styles.acesso} aria-labelledby="perfil-acesso"><h2 id="perfil-acesso">Acesso negado</h2><p role="alert">{acessoMensagem}</p><p>A resposta do servidor não permite abrir este perfil.</p>
            {concessaoInicial?.elegivel && <div data-concessao-inicial>
                <h3>Assumir a administração do perfil</h3>
                <p>O perfil de {empresaSemAcesso?.nome ?? 'esta empresa'} existe, mas nenhuma conta com Gestão ativa administra as concessões dele. Como Gestão desta empresa, você pode assumir a administração: esta conta recebe as capacidades que faltam ({concessaoInicial.capacidadesFaltantes.map(rotuloCapacidade).join(', ')}). Nenhum dado do cadastro é mostrado antes disso.</p>
                <label className={styles.confirmacao}><input type="checkbox" checked={confirmarConcessao} onChange={(evento) => setConfirmarConcessao(evento.target.checked)} /><span>Confirmo que quero assumir a administração do perfil desta empresa</span></label>
                {pedirSenhaCriacao && <label className={styles.campo}>Senha da sua conta<input type="password" value={senhaCriacao} autoComplete="current-password" onChange={(evento) => setSenhaCriacao(evento.target.value)} /></label>}
                <div><button type="button" className={styles.primario} disabled={ocupado || !confirmarConcessao || (pedirSenhaCriacao && !senhaCriacao)} onClick={() => void estruturarPerfil('concessao-inicial')}>{ocupado ? 'Assumindo…' : pedirSenhaCriacao ? 'Confirmar senha e assumir a administração' : 'Assumir a administração do perfil'}</button></div>
            </div>}
            {concessaoInicial && !concessaoInicial.elegivel && concessaoInicial.motivo === 'ADMINISTRADOR_EXISTENTE' && <p>Outra conta administra as concessões deste perfil. Peça a ela a concessão de acesso.</p>}
            <div><a href="/admin/configuracoes">Voltar às configurações</a><button type="button" onClick={() => void carregar(devePreencherNaRetentativa(fluxoRef.current))}>Tentar novamente</button></div></section>}
        {!carregando && !semPermissao && dados && !dados.estruturaInstalada && <p className={styles.estado}>A estrutura do perfil ainda não está instalada. Nenhum acesso foi concedido.</p>}
        {!carregando && !semPermissao && dados?.estruturaInstalada && dados.vazio && !dados.perfilAusente && <p className={styles.estado}>Ainda não há empresa provisionada. O formulário não cria a primeira empresa.</p>}
        {!carregando && !semPermissao && dados?.estruturaInstalada && dados.perfilAusente && <section className={styles.acesso} aria-labelledby="perfil-criar" data-perfil-ausente>
            <h2 id="perfil-criar">Perfil ainda não criado</h2>
            <p>{dados.empresa?.nome ?? 'Esta empresa'}{dados.empresa?.codigo ? ` (código ${dados.empresa.codigo})` : ''} ainda não tem o Perfil da empresa: nome comercial, razão social, CNPJ, endereço da unidade e contatos usados nos documentos.</p>
            {dados.podeCriar ? <>
                <p>Ao criar o perfil, esta conta recebe as capacidades de consultar, editar, aplicar e administrar as concessões do perfil desta empresa. Nenhum dado de outra empresa é copiado; só o nome da empresa é pré-preenchido.</p>
                {pedirSenhaCriacao && <label className={styles.campo}>Senha da sua conta<input type="password" value={senhaCriacao} autoComplete="current-password" onChange={(evento) => setSenhaCriacao(evento.target.value)} /></label>}
                <div><button type="button" className={styles.primario} disabled={ocupado || (pedirSenhaCriacao && !senhaCriacao)} onClick={() => void criarPerfil()}>{ocupado ? 'Criando…' : pedirSenhaCriacao ? 'Confirmar senha e criar perfil' : 'Criar perfil da empresa'}</button></div>
            </> : <p>Somente a Gestão desta empresa cria o perfil. Peça à Gestão para abrir Configurações → Perfil da empresa.</p>}
        </section>}
        {erro && <p className={styles.erro} role="alert">{erro}</p>}
        {erro && <button type="button" onClick={() => void carregar(devePreencherNaRetentativa(fluxoRef.current))}>Tentar novamente</button>}
        {!carregando && !semPermissao && dados?.contexto && <form className={styles.conteudo} onSubmit={(evento) => { evento.preventDefault(); }}>

            {sujo && <p>Há alterações ainda não salvas. Salve o rascunho antes de aplicar.</p>}
            {sucesso && <p className={styles.sucesso} role="status">{sucesso}</p>}
            {conflito && <p>Os dados digitados foram mantidos. Aplicar fica bloqueado até você assumir a revisão atual e confirmar de novo o conteúdo.</p>}
            {conflito && <button type="button" onClick={() => void resolver()} disabled={!identidadeConflito || ocupado}>Carregar a versão publicada e manter o texto digitado</button>}
            <div className={styles.etapas} aria-label="Etapas da atualização"><span>1. Editar dados</span><span>2. Salvar rascunho</span><span>3. Revisar e aplicar</span></div>
            <div className={styles.layout}>
            <div className={styles.principal}>
            <fieldset className={styles.card} disabled={!podeEditar}>
                <h2 className={styles.titulo}><AdminIcon name="profile" size={12} />Identificação</h2>
                <div className={styles.grade + ' ' + styles.identificacao}>
                    <label className={styles.campo}><Rotulo texto="Nome comercial" campo="nomeComercial" mesmoEndereco={mesmo} ajuda="Nome usado na operação. A razão social fica no documento." /><input aria-label={nomeAcessivel("Nome comercial", "nomeComercial", mesmo)} value={form.nomeComercial} placeholder="Nome que seus clientes veem" onChange={(evento) => atualizar({ nomeComercial: evento.target.value })} /></label>
                    <label className={styles.campo}><Rotulo texto="Razão social" campo="razaoSocial" mesmoEndereco={mesmo} ajuda="Nome jurídico exigido para aplicar o cadastro." /><input aria-label={nomeAcessivel("Razão social", "razaoSocial", mesmo)} value={form.razaoSocial} placeholder="Nome utilizado nos documentos" onChange={(evento) => atualizar({ razaoSocial: evento.target.value })} /></label>
                    <label className={styles.campo}><Rotulo texto="CNPJ" campo="cnpj" mesmoEndereco={mesmo} ajuda="Pode ficar vazio no rascunho. Na aplicação precisa ser um CNPJ válido." /><input aria-label={nomeAcessivel("CNPJ", "cnpj", mesmo)} value={form.cnpj} placeholder="ID Fiscal" inputMode="text" autoComplete="off" onChange={(evento) => atualizar({ cnpj: evento.target.value })} /><small>Aceita formatos numéricos ou alfanuméricos.</small></label>
                    <label className={styles.campo}><span className={styles.rotulo}>Código da empresa</span><input readOnly value={dados.contexto.codigoEmpresa} /></label>
                </div>
            </fieldset>
            <fieldset className={styles.card} disabled={!podeEditar}>
                <h2 className={styles.titulo}><AdminIcon name="location" size={12} />Endereços</h2>
                <h3 className={styles.subtitulo}>Endereço da sede</h3>
                <div className={styles.grade + ' ' + styles.endereco}>
                    <label className={styles.campo + ' ' + styles.cep}><Rotulo texto="CEP" campo="sede.cep" mesmoEndereco={mesmo} ajuda="Com 8 dígitos, a consulta preenche logradouro, bairro, cidade e UF. Número e complemento não são preenchidos." /><input aria-label={nomeAcessivel("CEP", "sede.cep", mesmo)} placeholder="CEP" value={sede.cep} inputMode="numeric" autoComplete="postal-code" onChange={(evento) => void consultarCep('sede', evento.target.value)} /></label>
                    {cepStatus.sede && <p className={styles.estado} role="status">{cepStatus.sede}</p>}
                    <label className={styles.campo + ' ' + styles.logradouro}><Rotulo texto="Logradouro" campo="sede.logradouro" mesmoEndereco={mesmo} /><input aria-label={nomeAcessivel("Logradouro", "sede.logradouro", mesmo)} placeholder="Logradouro" value={sede.logradouro} onChange={(evento) => atualizar({ sede: { ...sede, logradouro: evento.target.value } })} /></label>
                    <div className={styles.numeroGrupo}><label className={`${styles.campo} ${styles.numero}`}><Rotulo texto="Nº" campo="sede.numero" mesmoEndereco={mesmo} /><input aria-label={nomeAcessivel("Nº", "sede.numero", mesmo)} placeholder="123" value={sede.numero} disabled={sede.semNumero || !podeEditar} onChange={(evento) => atualizar({ sede: { ...sede, numero: evento.target.value } })} /></label>
                    <label className={styles.semNumero} title="Sem número"><input type="checkbox" aria-label="Sem número" checked={sede.semNumero} onChange={(evento) => atualizar({ sede: { ...sede, semNumero: evento.target.checked, numero: evento.target.checked ? '' : sede.numero } })} /><span aria-hidden="true">S/N</span></label></div>
                    <label className={styles.campo + ' ' + styles.complemento}><Rotulo texto="Complemento" mesmoEndereco={mesmo} ajuda="Opcional. A consulta de CEP nunca preenche este campo." /><input aria-label="Complemento" placeholder="Opcional" value={sede.complemento} onChange={(evento) => atualizar({ sede: { ...sede, complemento: evento.target.value } })} /></label>
                    <label className={styles.campo + ' ' + styles.bairro}><Rotulo texto="Bairro" campo="sede.bairro" mesmoEndereco={mesmo} /><input aria-label={nomeAcessivel("Bairro", "sede.bairro", mesmo)} placeholder="Bairro" value={sede.bairro} onChange={(evento) => atualizar({ sede: { ...sede, bairro: evento.target.value } })} /></label>
                    <label className={styles.campo + ' ' + styles.cidade}><Rotulo texto="Cidade" campo="sede.cidade" mesmoEndereco={mesmo} /><input aria-label={nomeAcessivel("Cidade", "sede.cidade", mesmo)} placeholder="Cidade" value={sede.cidade} onChange={(evento) => atualizar({ sede: { ...sede, cidade: evento.target.value } })} /></label>
                    <label className={styles.campo + ' ' + styles.uf}><Rotulo texto="UF" campo="sede.uf" mesmoEndereco={mesmo} /><input aria-label={nomeAcessivel("UF", "sede.uf", mesmo)} placeholder="UF" value={sede.uf} maxLength={2} onChange={(evento) => atualizar({ sede: { ...sede, uf: evento.target.value } })} /></label>
                </div>
                <div className={styles.localFesta}><h3 className={styles.subtitulo}>Local da festa</h3>
                <label className={styles.marca}><input type="checkbox" checked={form.mesmoEnderecoSede} onChange={(evento) => atualizar({ mesmoEnderecoSede: evento.target.checked })} /><span>Mesmo endereço da sede</span></label>
                </div>
                {form.mesmoEnderecoSede && <p className={styles.heranca}>O local da festa herda automaticamente o endereço da sede cadastrado acima.</p>}
                <details className={styles.detalhesLocal} open={!form.mesmoEnderecoSede || undefined}><summary>Detalhes da unidade e referência de chegada</summary>
                <div className={styles.grade}>
                    <label className={styles.campo}><Rotulo texto="Nome da unidade" campo="unidadeNome" mesmoEndereco={mesmo} /><input aria-label={nomeAcessivel("Nome da unidade", "unidadeNome", mesmo)} value={form.unidadeNome} onChange={(evento) => atualizar({ unidadeNome: evento.target.value })} /></label>
                    {!form.mesmoEnderecoSede && <>
                        <label className={styles.campo}><Rotulo texto="CEP do evento" campo="unidade.cep" mesmoEndereco={mesmo} ajuda="A consulta segue a mesma regra da sede e não altera número nem complemento." /><input aria-label={nomeAcessivel("CEP do evento", "unidade.cep", mesmo)} value={unidade.cep} inputMode="numeric" autoComplete="postal-code" onChange={(evento) => void consultarCep('unidade', evento.target.value)} /></label>
                        {cepStatus.unidade && <p className={styles.estado} role="status">{cepStatus.unidade}</p>}
                        <label className={styles.campo}><Rotulo texto="Logradouro do evento" campo="unidade.logradouro" mesmoEndereco={mesmo} /><input aria-label={nomeAcessivel("Logradouro do evento", "unidade.logradouro", mesmo)} value={unidade.logradouro} onChange={(evento) => atualizar({ unidade: { ...unidade, logradouro: evento.target.value } })} /></label>
                        <label className={styles.campo}><Rotulo texto="Número do evento" campo="unidade.numero" mesmoEndereco={mesmo} /><input aria-label={nomeAcessivel("Número do evento", "unidade.numero", mesmo)} value={unidade.numero} disabled={unidade.semNumero || !podeEditar} onChange={(evento) => atualizar({ unidade: { ...unidade, numero: evento.target.value } })} /></label>
                        <label className={styles.semNumero}><input type="checkbox" checked={unidade.semNumero} onChange={(evento) => atualizar({ unidade: { ...unidade, semNumero: evento.target.checked, numero: evento.target.checked ? '' : unidade.numero } })} /><span>Sem número no evento</span></label>
                        <label className={styles.campo}><Rotulo texto="Complemento da unidade" mesmoEndereco={mesmo} /><input aria-label="Complemento da unidade" value={unidade.complemento} onChange={(evento) => atualizar({ unidade: { ...unidade, complemento: evento.target.value } })} /></label>
                        <label className={styles.campo}><Rotulo texto="Bairro" campo="unidade.bairro" mesmoEndereco={mesmo} /><input aria-label={nomeAcessivel("Bairro", "unidade.bairro", mesmo)} value={unidade.bairro} onChange={(evento) => atualizar({ unidade: { ...unidade, bairro: evento.target.value } })} /></label>
                        <label className={styles.campo}><Rotulo texto="Cidade" campo="unidade.cidade" mesmoEndereco={mesmo} /><input aria-label={nomeAcessivel("Cidade", "unidade.cidade", mesmo)} value={unidade.cidade} onChange={(evento) => atualizar({ unidade: { ...unidade, cidade: evento.target.value } })} /></label>
                        <label className={styles.campo}><Rotulo texto="UF" campo="unidade.uf" mesmoEndereco={mesmo} /><input aria-label={nomeAcessivel("UF", "unidade.uf", mesmo)} value={unidade.uf} maxLength={2} onChange={(evento) => atualizar({ unidade: { ...unidade, uf: evento.target.value } })} /></label>
                    </>}
                    <label className={styles.campo}><Rotulo texto="Referência de chegada" mesmoEndereco={mesmo} ajuda="Opcional. Ajuda quem chega ao local da festa." /><input aria-label="Referência de chegada" value={form.referenciaChegada} onChange={(evento) => atualizar({ referenciaChegada: evento.target.value })} /></label>
                </div>
                </details>
            </fieldset>
            <fieldset className={styles.card} disabled={!podeEditar}>
                <h2 className={styles.titulo}><AdminIcon name="contact" size={12} />Contatos</h2>
                <div className={`${styles.grade} ${styles.contatos}`}>
                    <label className={styles.campo}><Rotulo texto="Telefone" mesmoEndereco={mesmo} ajuda="Válido para o contato se tiver pelo menos 10 dígitos." /><input aria-label="Telefone" placeholder="Telefone" value={form.telefone} onChange={(evento) => atualizar({ telefone: evento.target.value })} /></label>
                    <label className={styles.campo}><Rotulo texto="WhatsApp" mesmoEndereco={mesmo} ajuda="Substitui o telefone na aplicação quando estiver preenchido." /><input aria-label="WhatsApp" placeholder="WhatsApp" value={form.whatsapp} onChange={(evento) => atualizar({ whatsapp: evento.target.value })} /></label>
                    <label className={styles.campo}><Rotulo texto="E-mail comercial" mesmoEndereco={mesmo} /><input aria-label="E-mail comercial" placeholder="E-mail comercial" value={form.emailComercial} onChange={(evento) => atualizar({ emailComercial: evento.target.value })} /></label>
                    <label className={styles.campo}><Rotulo texto="Site" mesmoEndereco={mesmo} /><input aria-label="Site" placeholder="Site (opcional)" value={form.site} onChange={(evento) => atualizar({ site: evento.target.value })} /></label>
                    <label className={styles.campo}><Rotulo texto="Instagram" mesmoEndereco={mesmo} /><input aria-label="Instagram" placeholder="Instagram (opcional)" value={form.instagram} onChange={(evento) => atualizar({ instagram: evento.target.value })} /></label>
                </div>
                <p className={styles.avisoContato}>Estes campos são destinados à exibição pública e documentos. Eles não alteram o login dos usuários nem a recuperação de senha. {contatoExigidoNaAplicacao() ? 'Para aplicar, informe telefone ou WhatsApp.' : ''}</p>
            </fieldset>
            <p className={styles.regraCampos}>O rascunho pode ficar incompleto. O asterisco indica o que é exigido ao aplicar.</p>
            </div>
            <aside className={styles.lateral} aria-label="Marca e histórico">
                <details className={styles.card} open><summary>Marca e logo</summary>
                    <h2 className={styles.titulo}><AdminIcon name="palette" size={12} />Marca</h2>
                    <div className={styles.marcaBloco}><h3>Logo atual</h3><div className={styles.logoBox}>{dados.contexto?.cadastro.logoDataUrl ? <img src={dados.contexto.cadastro.logoDataUrl} alt="Logo atual da empresa" /> : <span>Nenhuma logo aplicada</span>}</div></div>
                    <div className={styles.marcaBloco}><h3>Nova logo — prévia</h3><div className={styles.logoBox}>{form.logoDataUrl ? <img src={form.logoDataUrl} alt="Prévia da logo do rascunho" /> : <span>Selecione uma imagem</span>}</div>
                        <label className={styles.logoUpload} aria-busy={preparandoLogo}>Selecionar logo<input type="file" accept="image/png,image/jpeg,image/webp" disabled={!podeEditar || ocupado} onChange={e=>{void selecionarLogo(e.target.files?.[0]);e.target.value='';}} /></label>
                        {form.logoDataUrl && <button type="button" className={styles.secundario} disabled={!podeEditar || ocupado} onClick={()=>{setLogoErro('');setLogoPreparada('');atualizar({logoDataUrl:null});}}>Remover logo do rascunho</button>}
                        {preparandoLogo && <p role="status">Preparando logo…</p>}
                        {logoErro && <p role="alert">{logoErro}</p>}
                        {logoPreparada && <p role="status">{logoPreparada}</p>}
                        <p className={styles.marcaNota}>PNG, JPEG ou WebP · até {LOGO_MAX_UPLOAD_MB} MB. A imagem é reduzida automaticamente, mantendo a transparência.</p>
                    </div>
                    <div className={styles.previa}><h3>Prévia no menu</h3><div className={styles.marcaMenu}>{form.logoDataUrl ? <img src={form.logoDataUrl} alt="Prévia da logo no menu" /> : <span>Logo da empresa</span>}<span>Admin</span></div><p>A logo do menu muda após aplicar o rascunho.</p></div>
                </details>
            <section className={`${styles.card} ${styles.historico}`}>
                <h2 className={styles.titulo}><AdminIcon name="history" size={12} />Histórico</h2>
                {(dados.historico ?? []).length === 0 && <div className={styles.historicoVazio}><AdminIcon name="history" size={24} /><p>Nenhuma revisão registrada.</p></div>}
                <ul>{(dados.historico ?? []).map((item) => <li key={item.numero}>
                    Revisão {item.numero}: {item.estado === 'APLICADA' ? 'aplicada' : 'rascunho'}.
                    Editado por {item.editorNome} em {dataLegivel(item.editadoEm)}.
                    {item.aplicadoEm ? ` Aplicado por ${item.aplicadorNome ?? 'responsável não identificado'} em ${dataLegivel(item.aplicadoEm)}.` : ''}
                    {item.motivo ? ` Motivo: ${item.motivo}.` : ''}
                </li>)}</ul>
            </section>
            </aside>
            </div>

            {podeAplicarCapacidade && <dialog ref={revisaoRef} className={styles.dialogo} aria-labelledby="revisar-aplicar"><div className={styles.revisao}>
                <button type="button" className={styles.fechar} onClick={() => revisaoRef.current?.close()} aria-label="Fechar revisão">×</button>
                <h2 id="revisar-aplicar" className={styles.titulo}>Revisar e aplicar</h2>
                {erro && <p className={styles.erro} role="alert">{erro}</p>}
                {sucesso && <p className={styles.sucesso} role="status">{sucesso}</p>}
                {conflito && <p role="alert">Feche a revisão para carregar a versão publicada e manter o texto digitado.</p>}
                <p className={styles.leitura}>Aplicar grava o cadastro desta empresa. Esta etapa não altera contratos, PDFs nem documentos já emitidos.</p>
                {sujo && <p role="status">Salve o rascunho antes de aplicar. O que está só no formulário não entra na aplicação.</p>}
                <section>
                    <h3>Comparação</h3>
                    {(dados.contexto?.cadastro.logoDataUrl ?? null) !== (salvo.logoDataUrl ?? null) && <div className={styles.logoComparacao}><div><p>Logo atual</p>{dados.contexto?.cadastro.logoDataUrl ? <img src={dados.contexto.cadastro.logoDataUrl} alt="Logo aplicada antes da revisão" /> : <span>Sem logo</span>}</div><div><p>Logo do rascunho salvo</p>{salvo.logoDataUrl ? <img src={salvo.logoDataUrl} alt="Logo salva para aplicar" /> : <span>Sem logo</span>}</div></div>}
                    {grupos.length === 0 && <p>Nenhuma diferença entre o publicado e o rascunho salvo.</p>}
                    {grupos.map((grupo) => <div key={grupo.titulo} className={styles.comparacao}>
                        <h4>{grupo.titulo}</h4>
                        {grupo.linhas.map((linha) => <p key={linha.rotulo}><strong>{linha.rotulo}</strong>: {linha.antes || '—'} → {linha.depois || '—'}</p>)}
                    </div>)}
                </section>
                <section>
                    <h3>Motivo</h3>
                    <label className={styles.campo}>Motivo da aplicação<textarea value={motivo} onChange={(evento) => { setMotivo(evento.target.value); publicar(confirmarRevisao(fluxoRef.current, false)); }} /></label>
                </section>
                <section>
                    <h3>Reautenticação</h3>
                    <label className={styles.campo}>Senha, se a sessão tiver mais de 5 minutos<input type="password" value={senha} autoComplete="current-password" onChange={(evento) => setSenha(evento.target.value)} /></label>
                </section>
                <section>
                    <h3>Confirmação</h3>
                    <label className={styles.confirmacao}><input type="checkbox" checked={confirmado && revisaoAindaConfere(fluxo)} onChange={(evento) => publicar(confirmarRevisao(fluxoRef.current, evento.target.checked))} /><span>Confirmo o antes e o depois do rascunho salvo</span></label>
                </section>
                <div className={styles.acoes}>
                    <button type="button" onClick={() => void aplicar()} className={styles.primario} disabled={!aplicarLiberado}>Confirmar e aplicar</button>
                </div>
            </div></dialog>}

        </form>}
    </main>;
}
