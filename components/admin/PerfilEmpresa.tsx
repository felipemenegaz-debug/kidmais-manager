'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { CadastroPerfil } from '@/lib/perfil/cadastro';
import { aposAplicar, aposCarga, aposConflito, aposDigitacao, aposOperacao, cadastrosIguais, confirmarRevisao, devePreencherNaRetentativa, estadoFluxoInicial, identidadeDoConflito, linhasAntesDepois, pedidoRascunho, podeAplicar, resolverCarregamento, revisaoAindaConfere, type CapacidadesTela, type EstadoFluxo } from '@/lib/perfil/tela-cadastro';
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
            <fieldset disabled={!podeEditar}>
                <h2 className={styles.titulo}>Identificação</h2>
                <div className={styles.grade}>
                    <label className={styles.campo}>Nome que os clientes veem<input value={form.nomeComercial} onChange={(evento) => atualizar({ nomeComercial: evento.target.value })} /></label>
                    <label className={styles.campo}>Razão social<input value={form.razaoSocial} onChange={(evento) => atualizar({ razaoSocial: evento.target.value })} /></label>
                    <label className={styles.campo}>CNPJ<input value={form.cnpj} inputMode="text" autoComplete="off" onChange={(evento) => atualizar({ cnpj: evento.target.value })} /></label>
                </div>
                <h2 className={styles.titulo}>Endereço da sede</h2>
                <div className={styles.grade}>
                    <label className={styles.campo}>CEP<input value={sede.cep} onChange={(evento) => atualizar({ sede: { ...sede, cep: evento.target.value } })} /></label>
                    <label className={styles.campo}>Logradouro<input value={sede.logradouro} onChange={(evento) => atualizar({ sede: { ...sede, logradouro: evento.target.value } })} /></label>
                    <label className={styles.campo}>Número<input value={sede.numero} disabled={sede.semNumero || !podeEditar} onChange={(evento) => atualizar({ sede: { ...sede, numero: evento.target.value } })} /></label>
                    <label className={styles.campo}><span>Sem número</span><input type="checkbox" checked={sede.semNumero} onChange={(evento) => atualizar({ sede: { ...sede, semNumero: evento.target.checked, numero: evento.target.checked ? '' : sede.numero } })} /></label>
                    <label className={styles.campo}>Complemento<input value={sede.complemento} onChange={(evento) => atualizar({ sede: { ...sede, complemento: evento.target.value } })} /></label>
                    <label className={styles.campo}>Bairro<input value={sede.bairro} onChange={(evento) => atualizar({ sede: { ...sede, bairro: evento.target.value } })} /></label>
                    <label className={styles.campo}>Cidade<input value={sede.cidade} onChange={(evento) => atualizar({ sede: { ...sede, cidade: evento.target.value } })} /></label>
                    <label className={styles.campo}>UF<input value={sede.uf} maxLength={2} onChange={(evento) => atualizar({ sede: { ...sede, uf: evento.target.value } })} /></label>
                </div>
                <h2 className={styles.titulo}>Unidade e local da festa</h2>
                <label className={styles.campo}><span>Mesmo endereço da sede</span><input type="checkbox" checked={form.mesmoEnderecoSede} onChange={(evento) => atualizar({ mesmoEnderecoSede: evento.target.checked })} /></label>
                <div className={styles.grade}>
                    <label className={styles.campo}>Nome da unidade<input value={form.unidadeNome} onChange={(evento) => atualizar({ unidadeNome: evento.target.value })} /></label>
                    {!form.mesmoEnderecoSede && <>
                        <label className={styles.campo}>CEP do evento<input value={unidade.cep} onChange={(evento) => atualizar({ unidade: { ...unidade, cep: evento.target.value } })} /></label>
                        <label className={styles.campo}>Logradouro do evento<input value={unidade.logradouro} onChange={(evento) => atualizar({ unidade: { ...unidade, logradouro: evento.target.value } })} /></label>
                        <label className={styles.campo}>Número do evento<input value={unidade.numero} disabled={unidade.semNumero || !podeEditar} onChange={(evento) => atualizar({ unidade: { ...unidade, numero: evento.target.value } })} /></label>
                        <label className={styles.campo}><span>Sem número no evento</span><input type="checkbox" checked={unidade.semNumero} onChange={(evento) => atualizar({ unidade: { ...unidade, semNumero: evento.target.checked, numero: evento.target.checked ? '' : unidade.numero } })} /></label>
                        <label className={styles.campo}>Complemento da unidade<input value={unidade.complemento} onChange={(evento) => atualizar({ unidade: { ...unidade, complemento: evento.target.value } })} /></label>
                        <label className={styles.campo}>Bairro<input value={unidade.bairro} onChange={(evento) => atualizar({ unidade: { ...unidade, bairro: evento.target.value } })} /></label>
                        <label className={styles.campo}>Cidade<input value={unidade.cidade} onChange={(evento) => atualizar({ unidade: { ...unidade, cidade: evento.target.value } })} /></label>
                        <label className={styles.campo}>UF<input value={unidade.uf} maxLength={2} onChange={(evento) => atualizar({ unidade: { ...unidade, uf: evento.target.value } })} /></label>
                    </>}
                    <label className={styles.campo}>Referência de chegada<input value={form.referenciaChegada} onChange={(evento) => atualizar({ referenciaChegada: evento.target.value })} /></label>
                </div>
                <h2 className={styles.titulo}>Contatos</h2>
                <div className={styles.grade}>
                    <label className={styles.campo}>Telefone<input value={form.telefone} onChange={(evento) => atualizar({ telefone: evento.target.value })} /></label>
                    <label className={styles.campo}>WhatsApp<input value={form.whatsapp} onChange={(evento) => atualizar({ whatsapp: evento.target.value })} /></label>
                    <label className={styles.campo}>E-mail comercial<input value={form.emailComercial} onChange={(evento) => atualizar({ emailComercial: evento.target.value })} /></label>
                    <label className={styles.campo}>Site<input value={form.site} onChange={(evento) => atualizar({ site: evento.target.value })} /></label>
                    <label className={styles.campo}>Instagram<input value={form.instagram} onChange={(evento) => atualizar({ instagram: evento.target.value })} /></label>
                </div>
            </fieldset>
            <p>Marca, logo e PDF público não fazem parte desta tela.</p>
            {podeEditar && <div className={styles.acoes}>
                <button type="button" onClick={() => void salvar()} disabled={ocupado}>Salvar rascunho</button>
            </div>}
            {podeAplicarCapacidade && <>
                <h2 className={styles.titulo}>Revisar e aplicar</h2>
                <p>Aplicar grava o cadastro desta empresa. Esta etapa não altera contratos, PDFs nem documentos já emitidos.</p>
                {sujo && <p role="status">Salve o rascunho antes de aplicar. O que está só no formulário não entra na aplicação.</p>}
                <div className={styles.comparacao}>
                    {comparacao.map((linha) => <p key={linha.rotulo}><strong>{linha.rotulo}</strong>: {linha.antes || '—'} → {linha.depois || '—'}</p>)}
                </div>
                <label className={styles.campo}>Motivo<textarea value={motivo} onChange={(evento) => { setMotivo(evento.target.value); publicar(confirmarRevisao(fluxoRef.current, false)); }} /></label>
                <label className={styles.campo}>Senha, se a sessão tiver mais de 5 minutos<input type="password" value={senha} autoComplete="current-password" onChange={(evento) => setSenha(evento.target.value)} /></label>
                <label className={styles.campo}><span>Confirmo o antes e o depois do rascunho salvo</span><input type="checkbox" checked={confirmado && revisaoAindaConfere(fluxo)} onChange={(evento) => publicar(confirmarRevisao(fluxoRef.current, evento.target.checked))} /></label>
                <div className={styles.acoes}>
                    <button type="button" onClick={() => void aplicar()} disabled={!aplicarLiberado}>Revisar e aplicar</button>
                </div>
            </>}
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
