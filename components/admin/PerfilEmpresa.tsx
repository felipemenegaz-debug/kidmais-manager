'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { CadastroPerfil } from '@/lib/perfil/cadastro';
import { cadastroVazio } from '@/lib/perfil/cadastro';
import { aposOperacao, cadastrosIguais, linhasAntesDepois, podeAplicar, recarregarDepoisDeAplicar, type CapacidadesTela } from '@/lib/perfil/tela-cadastro';
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
    const [form, setForm] = useState<CadastroPerfil>(cadastroVazio());
    const [salvo, setSalvo] = useState<CadastroPerfil>(cadastroVazio());
    const [numero, setNumero] = useState<number | null>(null);
    const [edicao, setEdicao] = useState<number | null>(null);
    const [versaoBase, setVersaoBase] = useState(0);
    const [erro, setErro] = useState('');
    const [conflito, setConflito] = useState(false);
    const [sucesso, setSucesso] = useState('');
    const [motivo, setMotivo] = useState('');
    const [senha, setSenha] = useState('');
    const [confirmado, setConfirmado] = useState(false);
    const cargaTicket = useRef(0);
    const operacaoTicket = useRef(0);
    const bloqueio = useRef(false);
    const formRef = useRef(form);
    const digitou = useRef(false);
    const sujo = !cadastrosIguais(form, salvo);
    const capacidades = dados?.capacidades;
    const podeEditar = Boolean(capacidades?.PERFIL_EDITAR_RASCUNHO);
    const podeAplicarCapacidade = Boolean(capacidades?.PERFIL_APLICAR);

    const aplicarCorpo = useCallback((corpo: Resposta, substituirForm: boolean) => {
        setDados(corpo);
        const rascunho = corpo.contexto?.rascunho ?? null;
        setNumero(rascunho?.numero ?? null);
        setEdicao(rascunho?.edicao ?? null);
        setVersaoBase(rascunho?.versaoBase ?? corpo.contexto?.versao ?? 0);
        if (substituirForm && corpo.contexto && !digitou.current) {
            const proximo = rascunho?.conteudo ?? corpo.contexto.cadastro;
            formRef.current = proximo;
            setForm(proximo);
            setSalvo(proximo);
        }
    }, []);

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
        digitou.current = true;
        setForm((atual) => {
            const proximo = { ...atual, ...parcial };
            formRef.current = proximo;
            return proximo;
        });
        setSucesso('');
        setConfirmado(false);
    }

    async function salvar() {
        if (bloqueio.current || !podeEditar)
            return;
        bloqueio.current = true;
        const meu = ++operacaoTicket.current;
        const enviado = formRef.current;
        setOcupado(true);
        setErro('');
        setConflito(false);
        setSucesso('');
        try {
            const resposta = await adminFetch('/api/admin/configuracoes/perfil-empresa', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ acao: 'salvar-rascunho', numero, edicao, versaoBase, cadastro: enviado }),
            });
            const corpo = await resposta.json();
            const efeito = aposOperacao({
                formAtual: formRef.current,
                enviado,
                ok: Boolean(corpo.ok) && corpo.codigo !== 'PERFIL_CONFLITO',
                tardio: meu !== operacaoTicket.current,
            });
            if (!efeito.atualizarSalvo || !efeito.salvo) {
                if (meu !== operacaoTicket.current)
                    return;
                setConflito(corpo.codigo === 'PERFIL_CONFLITO' || resposta.status === 409);
                setErro(corpo.erro ?? 'Não foi possível salvar o rascunho. Tente novamente.');
                return;
            }
            setNumero(corpo.data.numero);
            setEdicao(corpo.data.edicao);
            setVersaoBase(corpo.data.versaoBase);
            setSalvo(efeito.salvo);
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
        }))
            return;
        if (numero == null || edicao == null)
            return;
        bloqueio.current = true;
        const meu = ++operacaoTicket.current;
        const enviado = salvo;
        setOcupado(true);
        setErro('');
        setConflito(false);
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
                setConflito(corpo.codigo === 'PERFIL_CONFLITO' || resposta.status === 409);
                setErro(corpo.erro ?? 'Não foi possível aplicar o cadastro. Tente novamente.');
                return;
            }
            setSucesso('Cadastro aplicado. Contratos e PDFs existentes não foram alterados.');
            setMotivo('');
            setSenha('');
            setConfirmado(false);
            const modo = recarregarDepoisDeAplicar(formRef.current, enviado);
            if (modo === 'substituir')
                digitou.current = false;
            await carregar(modo === 'substituir');
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
    const aplicarLiberado = podeAplicar({
        sujo, ocupado, numero, edicao, motivo, permitir: podeAplicarCapacidade, confirmado,
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
        {erro && <button type="button" onClick={() => void carregar(false)}>Tentar novamente</button>}
        {!carregando && !semPermissao && dados?.contexto && <form onSubmit={(evento) => { evento.preventDefault(); }}>
            <p>Empresa {dados.contexto.codigoEmpresa} · Unidade {dados.contexto.codigoUnidade} · versão {dados.contexto.versao}</p>
            {dados.contexto.rascunho && <p>Há alterações em rascunho.</p>}
            {sujo && <p>Há alterações ainda não salvas. Salve o rascunho antes de aplicar.</p>}
            {sucesso && <p className={styles.sucesso} role="status">{sucesso}</p>}
            {conflito && <p>Os dados digitados foram mantidos. Atualize a página só se quiser descartá-los.</p>}
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
                <label className={styles.campo}>Motivo<textarea value={motivo} onChange={(evento) => { setMotivo(evento.target.value); setConfirmado(false); }} /></label>
                <label className={styles.campo}>Senha, se a sessão tiver mais de 5 minutos<input type="password" value={senha} autoComplete="current-password" onChange={(evento) => setSenha(evento.target.value)} /></label>
                <label className={styles.campo}><span>Confirmo o antes e o depois do rascunho salvo</span><input type="checkbox" checked={confirmado} onChange={(evento) => setConfirmado(evento.target.checked)} /></label>
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
