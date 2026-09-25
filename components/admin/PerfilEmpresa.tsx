'use client';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { campoExigidoNaAplicacao, contatoExigidoNaAplicacao, type CadastroPerfil } from '@/lib/perfil/cadastro';
import { aplicarConsultaCep, cepCompleto, type PedidoCep } from '@/lib/perfil/consulta-cep';
import { agruparComparacao, aposAplicar, aposCarga, aposConflito, aposDigitacao, aposOperacao, cadastrosIguais, confirmarRevisao, devePreencherNaRetentativa, estadoFluxoInicial, identidadeDoConflito, linhasAntesDepois, pedidoRascunho, podeAplicar, resolverCarregamento, revisaoAindaConfere, type CapacidadesTela, type EstadoFluxo } from '@/lib/perfil/tela-cadastro';
import styles from './perfil-empresa.module.css';

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
        <button type="button" aria-expanded={aberto} aria-controls={id} onClick={() => setAberto((valor) => !valor)}>Ajuda</button>
        {aberto && <span id={id} role="note" className={styles.nota}>{texto}</span>}
    </span>;
}

function Rotulo({ texto, campo, mesmoEndereco, ajuda }: { texto: string; campo?: string; mesmoEndereco: boolean; ajuda?: string }) {
    const exigido = campo ? campoExigidoNaAplicacao(campo, mesmoEndereco) : false;
    return <span className={styles.rotulo}>{texto}{exigido && <abbr className={styles.asterisco}>*</abbr>}{ajuda && <Ajuda texto={ajuda} />}</span>;
}

function dataLegivel(valor: string) {
    const data = new Date(valor);
    if (Number.isNaN(data.getTime()))
        return valor;
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(data);
}

export default function PerfilEmpresa() {
    const [carregando, setCarregando] = useState(true);
    const [ocupado, setOcupado] = useState(false);
    const [semPermissao, setSemPermissao] = useState(false);
    const [dados, setDados] = useState<Resposta | null>(null);
    const [fluxo, setFluxo] = useState<EstadoFluxo>(estadoFluxoInicial);
    const [identidadeConflito, setIdentidadeConflito] = useState<{ numero: number | null; edicao: number | null; versaoBase: number } | null>(null);
    const [erro, setErro] = useState('');
    const [sucesso, setSucesso] = useState('');
    const [motivo, setMotivo] = useState('');
    const [senha, setSenha] = useState('');
    const [cepStatus, setCepStatus] = useState<{ sede: string; unidade: string }>({ sede: '', unidade: '' });
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
                return;
            }
            if (!corpo.ok)
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
            if (vigente.cep.replace(/\D/g, '') === cep)
                setCepStatus((estado) => ({ ...estado, [alvo]: 'Logradouro, bairro, cidade e UF foram consultados. Número e complemento continuam manuais.' }));
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
                const auth = await adminFetch('/api/admin/autenticacao', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ acao: 'reautenticar', senha }),
                });
                if (!auth.ok)
                    throw new Error('Não foi possível confirmar a senha. Tente novamente.');
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

    return <main className={styles.page} aria-busy={ocupado || carregando}>
        <Link href="/admin/configuracoes">Voltar às configurações</Link>
        <h1 className={styles.titulo}>Perfil da empresa</h1>
        <p>Uma empresa e a unidade atual.</p>
        {carregando && <p className={styles.estado} role="status">Carregando perfil.</p>}
        {ocupado && <p className={styles.estado} role="status">Operação em andamento.</p>}
        {!carregando && semPermissao && <p className={styles.estado} role="alert">Sem concessão ativa para consultar o perfil.</p>}
        {!carregando && !semPermissao && dados && !dados.estruturaInstalada && <p className={styles.estado}>A estrutura do perfil ainda não está instalada. Nenhum acesso foi concedido.</p>}
        {!carregando && !semPermissao && dados?.estruturaInstalada && dados.vazio && <p className={styles.estado}>Ainda não há empresa provisionada. O formulário não cria a primeira empresa.</p>}
        {erro && <p className={styles.erro} role="alert">{erro}</p>}
        {erro && <button type="button" onClick={() => void carregar(devePreencherNaRetentativa(fluxoRef.current))}>Tentar novamente</button>}
        {!carregando && !semPermissao && dados?.contexto && <form onSubmit={(evento) => { evento.preventDefault(); }}>
            <p>Empresa {dados.contexto.codigoEmpresa} · Unidade {dados.contexto.codigoUnidade} · versão {dados.contexto.versao}</p>
            {dados.contexto.rascunho && <p>Há alterações em rascunho.</p>}
            {sujo && <p>Há alterações ainda não salvas. Salve o rascunho antes de aplicar.</p>}
            {sucesso && <p className={styles.sucesso} role="status">{sucesso}</p>}
            {conflito && <p>Os dados digitados foram mantidos. Aplicar fica bloqueado até você assumir a revisão atual e confirmar de novo o conteúdo.</p>}
            {conflito && <button type="button" onClick={() => void resolver()} disabled={!identidadeConflito || ocupado}>Carregar a versão publicada e manter o texto digitado</button>}
            <p className={styles.leitura}>O rascunho pode ficar incompleto. O asterisco marca só o que a aplicação exige. {contatoExigidoNaAplicacao() ? 'Telefone ou WhatsApp basta como contato.' : ''}</p>
            <fieldset disabled={!podeEditar}>
                <h2 className={styles.titulo}>Identificação</h2>
                <div className={styles.grade}>
                    <label className={styles.campo}><Rotulo texto="Nome que os clientes veem" campo="nomeComercial" mesmoEndereco={mesmo} ajuda="Nome usado na operação. A razão social fica no documento." /><input value={form.nomeComercial} onChange={(evento) => atualizar({ nomeComercial: evento.target.value })} /></label>
                    <label className={styles.campo}><Rotulo texto="Razão social" campo="razaoSocial" mesmoEndereco={mesmo} ajuda="Nome jurídico exigido para aplicar o cadastro." /><input value={form.razaoSocial} onChange={(evento) => atualizar({ razaoSocial: evento.target.value })} /></label>
                    <label className={styles.campo}><Rotulo texto="CNPJ" campo="cnpj" mesmoEndereco={mesmo} ajuda="Pode ficar vazio no rascunho. Na aplicação precisa ser um CNPJ válido." /><input value={form.cnpj} inputMode="text" autoComplete="off" onChange={(evento) => atualizar({ cnpj: evento.target.value })} /></label>
                </div>
                <h2 className={styles.titulo}>Endereço da sede</h2>
                <div className={styles.grade}>
                    <label className={styles.campo}><Rotulo texto="CEP" campo="sede.cep" mesmoEndereco={mesmo} ajuda="Com 8 dígitos, a consulta preenche logradouro, bairro, cidade e UF. Número e complemento não são preenchidos." /><input value={sede.cep} inputMode="numeric" autoComplete="postal-code" onChange={(evento) => void consultarCep('sede', evento.target.value)} /></label>
                    {cepStatus.sede && <p className={styles.estado} role="status">{cepStatus.sede}</p>}
                    <label className={styles.campo}><Rotulo texto="Logradouro" campo="sede.logradouro" mesmoEndereco={mesmo} /><input value={sede.logradouro} onChange={(evento) => atualizar({ sede: { ...sede, logradouro: evento.target.value } })} /></label>
                    <label className={styles.campo}><Rotulo texto="Número" campo="sede.numero" mesmoEndereco={mesmo} ajuda="Obrigatório para aplicar, salvo se marcar Sem número." /><input value={sede.numero} disabled={sede.semNumero || !podeEditar} onChange={(evento) => atualizar({ sede: { ...sede, numero: evento.target.value } })} /></label>
                    <label className={styles.marca}><input type="checkbox" checked={sede.semNumero} onChange={(evento) => atualizar({ sede: { ...sede, semNumero: evento.target.checked, numero: evento.target.checked ? '' : sede.numero } })} /><span>Sem número</span></label>
                    <label className={styles.campo}><Rotulo texto="Complemento" mesmoEndereco={mesmo} ajuda="Opcional. A consulta de CEP nunca preenche este campo." /><input value={sede.complemento} onChange={(evento) => atualizar({ sede: { ...sede, complemento: evento.target.value } })} /></label>
                    <label className={styles.campo}><Rotulo texto="Bairro" campo="sede.bairro" mesmoEndereco={mesmo} /><input value={sede.bairro} onChange={(evento) => atualizar({ sede: { ...sede, bairro: evento.target.value } })} /></label>
                    <label className={styles.campo}><Rotulo texto="Cidade" campo="sede.cidade" mesmoEndereco={mesmo} /><input value={sede.cidade} onChange={(evento) => atualizar({ sede: { ...sede, cidade: evento.target.value } })} /></label>
                    <label className={styles.campo}><Rotulo texto="UF" campo="sede.uf" mesmoEndereco={mesmo} /><input value={sede.uf} maxLength={2} onChange={(evento) => atualizar({ sede: { ...sede, uf: evento.target.value } })} /></label>
                </div>
                <h2 className={styles.titulo}>Unidade e local da festa</h2>
                <label className={styles.marca}><input type="checkbox" checked={form.mesmoEnderecoSede} onChange={(evento) => atualizar({ mesmoEnderecoSede: evento.target.checked })} /><span>Mesmo endereço da sede</span></label>
                <div className={styles.grade}>
                    <label className={styles.campo}><Rotulo texto="Nome da unidade" campo="unidadeNome" mesmoEndereco={mesmo} /><input value={form.unidadeNome} onChange={(evento) => atualizar({ unidadeNome: evento.target.value })} /></label>
                    {!form.mesmoEnderecoSede && <>
                        <label className={styles.campo}><Rotulo texto="CEP do evento" campo="unidade.cep" mesmoEndereco={mesmo} ajuda="A consulta segue a mesma regra da sede e não altera número nem complemento." /><input value={unidade.cep} inputMode="numeric" autoComplete="postal-code" onChange={(evento) => void consultarCep('unidade', evento.target.value)} /></label>
                        {cepStatus.unidade && <p className={styles.estado} role="status">{cepStatus.unidade}</p>}
                        <label className={styles.campo}><Rotulo texto="Logradouro do evento" campo="unidade.logradouro" mesmoEndereco={mesmo} /><input value={unidade.logradouro} onChange={(evento) => atualizar({ unidade: { ...unidade, logradouro: evento.target.value } })} /></label>
                        <label className={styles.campo}><Rotulo texto="Número do evento" campo="unidade.numero" mesmoEndereco={mesmo} /><input value={unidade.numero} disabled={unidade.semNumero || !podeEditar} onChange={(evento) => atualizar({ unidade: { ...unidade, numero: evento.target.value } })} /></label>
                        <label className={styles.marca}><input type="checkbox" checked={unidade.semNumero} onChange={(evento) => atualizar({ unidade: { ...unidade, semNumero: evento.target.checked, numero: evento.target.checked ? '' : unidade.numero } })} /><span>Sem número no evento</span></label>
                        <label className={styles.campo}><Rotulo texto="Complemento da unidade" mesmoEndereco={mesmo} /><input value={unidade.complemento} onChange={(evento) => atualizar({ unidade: { ...unidade, complemento: evento.target.value } })} /></label>
                        <label className={styles.campo}><Rotulo texto="Bairro" campo="unidade.bairro" mesmoEndereco={mesmo} /><input value={unidade.bairro} onChange={(evento) => atualizar({ unidade: { ...unidade, bairro: evento.target.value } })} /></label>
                        <label className={styles.campo}><Rotulo texto="Cidade" campo="unidade.cidade" mesmoEndereco={mesmo} /><input value={unidade.cidade} onChange={(evento) => atualizar({ unidade: { ...unidade, cidade: evento.target.value } })} /></label>
                        <label className={styles.campo}><Rotulo texto="UF" campo="unidade.uf" mesmoEndereco={mesmo} /><input value={unidade.uf} maxLength={2} onChange={(evento) => atualizar({ unidade: { ...unidade, uf: evento.target.value } })} /></label>
                    </>}
                    <label className={styles.campo}><Rotulo texto="Referência de chegada" mesmoEndereco={mesmo} ajuda="Opcional. Ajuda quem chega ao local da festa." /><input value={form.referenciaChegada} onChange={(evento) => atualizar({ referenciaChegada: evento.target.value })} /></label>
                </div>
                <h2 className={styles.titulo}>Contatos</h2>
                <p className={styles.leitura}>{contatoExigidoNaAplicacao() ? 'Para aplicar, informe telefone ou WhatsApp. Os dois não são obrigatórios ao mesmo tempo.' : ''}</p>
                <div className={styles.grade}>
                    <label className={styles.campo}><Rotulo texto="Telefone" mesmoEndereco={mesmo} ajuda="Válido para o contato se tiver pelo menos 10 dígitos." /><input value={form.telefone} onChange={(evento) => atualizar({ telefone: evento.target.value })} /></label>
                    <label className={styles.campo}><Rotulo texto="WhatsApp" mesmoEndereco={mesmo} ajuda="Substitui o telefone na aplicação quando estiver preenchido." /><input value={form.whatsapp} onChange={(evento) => atualizar({ whatsapp: evento.target.value })} /></label>
                    <label className={styles.campo}><Rotulo texto="E-mail comercial" mesmoEndereco={mesmo} /><input value={form.emailComercial} onChange={(evento) => atualizar({ emailComercial: evento.target.value })} /></label>
                    <label className={styles.campo}><Rotulo texto="Site" mesmoEndereco={mesmo} /><input value={form.site} onChange={(evento) => atualizar({ site: evento.target.value })} /></label>
                    <label className={styles.campo}><Rotulo texto="Instagram" mesmoEndereco={mesmo} /><input value={form.instagram} onChange={(evento) => atualizar({ instagram: evento.target.value })} /></label>
                </div>
            </fieldset>
            <p>Marca, logo e PDF público não fazem parte desta tela.</p>
            {podeEditar && <div className={styles.acoes}>
                <button type="button" onClick={() => void salvar()} disabled={ocupado}>Salvar rascunho</button>
            </div>}
            {podeAplicarCapacidade && <section className={styles.revisao} aria-labelledby="revisar-aplicar">
                <h2 id="revisar-aplicar" className={styles.titulo}>Revisar e aplicar</h2>
                <p className={styles.leitura}>Aplicar grava o cadastro desta empresa. Esta etapa não altera contratos, PDFs nem documentos já emitidos.</p>
                {sujo && <p role="status">Salve o rascunho antes de aplicar. O que está só no formulário não entra na aplicação.</p>}
                <section>
                    <h3>Comparação</h3>
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
                    <label className={styles.marca}><input type="checkbox" checked={confirmado && revisaoAindaConfere(fluxo)} onChange={(evento) => publicar(confirmarRevisao(fluxoRef.current, evento.target.checked))} /><span>Confirmo o antes e o depois do rascunho salvo</span></label>
                </section>
                <div className={styles.acoes}>
                    <button type="button" onClick={() => void aplicar()} disabled={!aplicarLiberado}>Revisar e aplicar</button>
                </div>
            </section>}
            <section className={styles.historico}>
                <h2 className={styles.titulo}>Histórico</h2>
                {(dados.historico ?? []).length === 0 && <p>Nenhuma revisão registrada.</p>}
                <ul>{(dados.historico ?? []).map((item) => <li key={item.numero}>
                    Revisão {item.numero}: {item.estado === 'APLICADA' ? 'aplicada' : 'rascunho'}.
                    Editado por {item.editorNome} em {dataLegivel(item.editadoEm)}.
                    {item.aplicadoEm ? ` Aplicado por ${item.aplicadorNome ?? 'responsável não identificado'} em ${dataLegivel(item.aplicadoEm)}.` : ''}
                    {item.motivo ? ` Motivo: ${item.motivo}.` : ''}
                </li>)}</ul>
            </section>
        </form>}
    </main>;
}
