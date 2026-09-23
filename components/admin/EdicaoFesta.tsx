'use client';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { EdicaoFestaInput } from '@/lib/fechamentos/services/edicao-administrativa-schema';
import type { fontesEdicao } from '@/lib/contratos/services/administrativo.service';
import type { CatalogoAdicionais, PacoteComercialResumo, ResumoComercial } from '@/lib/comercial/services/models';
import type { DisponibilidadeDataPublica } from '@/lib/disponibilidade/services/models';
import { atalhosConvidados } from '@/lib/fechamentos/convidados';
import { calcularCondicaoComercial } from '@/lib/comercial/condicao-pagamento';
import { formatarMoeda } from '@/lib/contratos/documento/formatters';
import styles from './admin.module.css';
type Contexto = {
    somenteRevisao?: boolean;
    vinculos: {clientes:Array<{id:string;nome_completo:string}>;aniversariantes:Array<{id:string;cliente_id:string;nome:string}>;responsaveis:Array<{id:string;cliente_id:string;nome:string}>}|null;
    fonte: Awaited<ReturnType<typeof fontesEdicao>>;
    disponibilidade: DisponibilidadeDataPublica;
    pacotes: PacoteComercialResumo[];
    catalogo: CatalogoAdicionais;
    resumo: ResumoComercial | null;
    erroPreco: string | null;
    incluidos: string[];
};
export default function EdicaoFesta({ versaoId, revisao, onSave, onClose, serverError }: {
    versaoId: string;
    revisao: number;
    serverError: string;
    onSave: (body: Record<string, unknown>) => Promise<boolean>;
    onClose: () => void;
}) {
    const [ctx, setCtx] = useState<Contexto | null>(null), [form, setForm] = useState<EdicaoFestaInput | null>(null), [erro, setErro] = useState(''), [busy, setBusy] = useState(false), [calculando, setCalculando] = useState(false);
    const [comercial, setComercial] = useState(false), [forma, setForma] = useState<'PIX_AVISTA' | 'PIX_PARCELADO' | 'CARTAO_CIELO'>('CARTAO_CIELO'), [base, setBase] = useState(''), [entrada, setEntrada] = useState(''), [parcela, setParcela] = useState(''), [quantidade, setQuantidade] = useState('');
    const url = `/api/admin/contratos/versoes/${versaoId}/edicao`;
    useEffect(() => {
        let alive = true;
        adminFetch(url).then(r => r.json()).then(b => {
            if (!b.ok)
                throw Error(b.erro);
            if (!alive)
                return;
            const c = b.data as Contexto;
            setCtx(c);
            const { fechamento: f, cliente, aniversariante, adicionais, fonteHash } = c.fonte;
            setForm({ acao: 'editar_festa', revisao, fonteHash, motivo: '', pacoteId: f.pacoteId, convidados: f.convidados, dataEvento: f.dataEvento, configuracaoAgendaId: f.configuracaoAgendaId, horarioInicio: f.horarioInicio.slice(0, 5), horarioFim: f.horarioFim.slice(0, 5), adicionais, idadeAniversarianteEvento: f.idadeAniversarianteEvento, temaFesta: f.temaFesta ?? '', buffetStatus: f.buffetStatus, buffetSalgados: f.buffetSalgados ?? '', buffetBebidas: f.buffetBebidas ?? '', buffetDoces: f.buffetDoces ?? '', buffetBolo: f.buffetBolo ?? '', buffetOutros: f.buffetOutros ?? '', buffetLembrancinha: f.buffetLembrancinha ?? '', buffetEmpratado: f.buffetEmpratado ?? '', buffetBombom: f.buffetBombom ?? '', observacoesEquipe: f.observacoesEquipe ?? '',
                cliente: cliente ? { nomeCompleto: cliente.nomeCompleto, rg: cliente.rg ?? '', telefone: cliente.telefone ?? '', whatsapp: cliente.whatsapp ?? '', email: cliente.email ?? '', cep: cliente.cep ?? '', logradouro: cliente.logradouro ?? '', numero: cliente.numero ?? '', complemento: cliente.complemento ?? '', bairro: cliente.bairro ?? '', cidade: cliente.cidade ?? '', uf: cliente.uf ?? '' } : undefined,
                aniversariante: aniversariante ? { nome: aniversariante.nome, dataNascimento: aniversariante.dataNascimento } : undefined });
            setForma(f.formaPagamentoPretendida ?? 'CARTAO_CIELO');
            setBase(f.valorNegociado === null ? '' : String(f.valorAprovado ?? f.valorNegociado));
            const pix = f.condicaoPagamento?.aprovada;
            setEntrada(pix?.entradaCentavos == null ? '' : String(pix.entradaCentavos / 100));
            setParcela(pix?.parcelaCentavos == null ? '' : String(pix.parcelaCentavos / 100));
            setQuantidade(pix?.quantidadeParcelas == null ? '' : String(pix.quantidadeParcelas));
        }).catch(e => setErro(e.message));
        return () => { alive = false; };
    }, [url, revisao]);
    const consulta = form ? new URLSearchParams({ data: form.dataEvento, periodo: form.configuracaoAgendaId, pacote: form.pacoteId, convidados: String(form.convidados), adicionais: JSON.stringify(form.adicionais) }).toString() : '';
    useEffect(() => { if (!consulta)
        return; let alive = true; const timer = setTimeout(() => { setCalculando(true); adminFetch(url + '?' + consulta).then(r => r.json()).then(b => { if (!b.ok)
        throw Error(b.erro); if (alive) {
        setCtx(b.data);
        setErro('');
    } }).catch(e => { if (alive)
        setErro(e.message); }).finally(() => { if (alive)
        setCalculando(false); }); }, 300); return () => { alive = false; clearTimeout(timer); }; }, [consulta, url]);
    if (!form || !ctx)
        return <section className={styles.card}><p role="alert">{erro || 'Carregando dados para edição…'}</p><button onClick={onClose}>Fechar edição</button></section>;
    const patch = (p: Partial<EdicaoFestaInput>) => setForm({ ...form, ...p });
    const vinculos=form.vinculos??{clienteId:ctx.fonte.fechamento.clienteId??'',aniversarianteId:ctx.fonte.fechamento.aniversarianteId??'',responsavelAdicionalId:ctx.fonte.fechamento.responsavelAdicionalId};
    const pacote = ctx.pacotes.find(p => p.pacote.id === form.pacoteId)?.pacote;
    const periodo = ctx.disponibilidade.periodos.find(p => p.configuracaoId === form.configuracaoAgendaId);
    const duplicados = form.adicionais.filter(a => ctx.incluidos.includes(a.codigo));
    const preco = ctx.resumo?.valorTotalTabela;
    const moeda = (n: number | undefined) => n === undefined ? 'Aguardando cálculo' : formatarMoeda(n);
    return <section className={styles.card} id="editar-festa"><h2>Editar festa</h2><p>Atualize os dados e confira o preço. Esta edição mantém a mesma versão em elaboração e exige nova revisão do documento.</p>
  <form onSubmit={async (e) => {
            e.preventDefault();
            if (comercial && !window.confirm('Confirmo a aprovação comercial desta edição, incluindo a base negociada e a condição de pagamento informadas.'))
                return;
            setBusy(true);
            try {
                const body = { ...form, ...(comercial ? { comercial: { confirmarAprovacao: true, forma, baseNegociada: base || null, condicaoPix: forma === 'PIX_PARCELADO' ? { entrada: entrada || null, valorParcela: parcela || null, quantidadeParcelas: quantidade ? Number(quantidade) : null } : null } } : {}) };
                if (await onSave(body))
                    onClose();
            }
            finally {
                setBusy(false);
            }
        }}>
  {ctx.vinculos && <details><summary>Trocar vínculos da contratação</summary><p>A seleção prepara novos vínculos para V2. A contratação vigente será preservada até o aceite final.</p><div className={styles.grid}><label>Contratante proposto<select aria-label="Contratante proposto" value={vinculos.clienteId} onChange={e=>patch({vinculos:{clienteId:e.target.value,aniversarianteId:'',responsavelAdicionalId:null},cliente:undefined,aniversariante:undefined})}>{ctx.vinculos.clientes.map(c=><option key={c.id} value={c.id}>{c.nome_completo}</option>)}</select></label><label>Aniversariante proposto<select aria-label="Aniversariante proposto" value={vinculos.aniversarianteId} onChange={e=>patch({vinculos:{...vinculos,aniversarianteId:e.target.value},aniversariante:undefined})}><option value="">Selecione</option>{ctx.vinculos.aniversariantes.filter(a=>a.cliente_id===vinculos.clienteId).map(a=><option key={a.id} value={a.id}>{a.nome}</option>)}</select></label><label>Responsável adicional proposto<select aria-label="Responsável adicional proposto" value={vinculos.responsavelAdicionalId??''} onChange={e=>patch({vinculos:{...vinculos,responsavelAdicionalId:e.target.value||null}})}><option value="">Nenhum</option>{ctx.vinculos.responsaveis.filter(a=>a.cliente_id===vinculos.clienteId).map(a=><option key={a.id} value={a.id}>{a.nome}</option>)}</select></label></div></details>}
  <details><summary>Dados do contratante</summary><fieldset disabled={busy}><p>{ctx.somenteRevisao ? 'As correções ficam nesta revisão do contrato. O cadastro em Clientes permanece inalterado. CPF permanece protegido.' : 'As correções cadastrais também atualizam o cadastro em Clientes. CPF permanece protegido.'}</p><div className={styles.grid}>
  {form.cliente && (Object.keys(form.cliente) as Array<keyof NonNullable<EdicaoFestaInput['cliente']>>).map(k => <label key={k}>{({ nomeCompleto: 'Nome completo', rg: 'RG', telefone: 'Telefone', whatsapp: 'WhatsApp', email: 'E-mail', cep: 'CEP', logradouro: 'Logradouro', numero: 'Número', complemento: 'Complemento', bairro: 'Bairro', cidade: 'Cidade', uf: 'UF' })[k]}<input value={form.cliente![k]} type={k === 'email' ? 'email' : 'text'} onChange={e => patch({ cliente: { ...form.cliente!, [k]: e.target.value } })}/></label>)}</div></fieldset></details>
  <details><summary>Dados da festa</summary><fieldset disabled={busy}><div className={styles.grid}>
  <label>Aniversariante<input disabled={!form.aniversariante} value={form.aniversariante?.nome ?? ''} onChange={e => patch({ aniversariante: { ...form.aniversariante!, nome: e.target.value } })}/></label>
  <label>Data de nascimento<input disabled={!form.aniversariante} type="date" value={form.aniversariante?.dataNascimento ?? ''} onChange={e => patch({ aniversariante: { ...form.aniversariante!, dataNascimento: e.target.value || null } })}/></label>
  <label>Idade no evento<input type="number" min="0" max="120" value={form.idadeAniversarianteEvento ?? ''} onChange={e => patch({ idadeAniversarianteEvento: e.target.value === '' ? null : Number(e.target.value) })}/></label>
  <label>Tema<input value={form.temaFesta} onChange={e => patch({ temaFesta: e.target.value })}/></label>
  <label>Data da festa<input required type="date" value={form.dataEvento} onChange={e => patch({ dataEvento: e.target.value })}/></label>
  <label>Período<select aria-label="Período" value={form.configuracaoAgendaId} onChange={e => patch({ configuracaoAgendaId: e.target.value })}>{ctx.disponibilidade.periodos.map(p => <option key={p.configuracaoId} value={p.configuracaoId}>{p.nome}</option>)}</select></label>
  <label>Horário<select aria-label="Horário" value={form.horarioInicio + '|' + form.horarioFim} onChange={e => { const [horarioInicio, horarioFim] = e.target.value.split('|'); patch({ horarioInicio, horarioFim }); }}><option value={form.horarioInicio + '|' + form.horarioFim}>{form.horarioInicio}–{form.horarioFim} (selecionado)</option>{periodo?.horarios.map(h => <option disabled={h.status !== 'DISPONIVEL'} key={h.inicio} value={h.inicio + '|' + h.fim}>{h.inicio}–{h.fim} · {h.status}</option>)}</select></label></div><p>Disponibilidade será conferida novamente ao salvar. Consulte a situação da reserva e da proteção provisória no painel da revisão.</p></fieldset></details>
  <details open><summary>Pacote e convidados</summary><fieldset disabled={busy}><div className={styles.grid}><label>Pacote<select aria-label="Pacote" value={form.pacoteId} onChange={e => patch({ pacoteId: e.target.value, buffetStatus: 'PENDENTE', buffetSalgados: '', buffetBebidas: '', buffetDoces: '', buffetBolo: '', buffetOutros: '', buffetLembrancinha: '', buffetEmpratado: '', buffetBombom: '' })}>{ctx.pacotes.map(p => <option key={p.pacote.id} value={p.pacote.id} disabled={p.elegibilidade !== 'DISPONIVEL'}>{p.pacote.nome} · {p.elegibilidade}</option>)}</select></label>
  <label>Convidados pagantes<input required type="number" min={pacote?.convidadosMinimos ?? 1} max={pacote?.convidadosMaximos ?? 150} step="1" value={form.convidados} onChange={e => patch({ convidados: Number(e.target.value) })}/></label></div><div className={styles.actions}>{atalhosConvidados(pacote?.convidadosMinimos ?? 1, pacote?.convidadosMaximos ?? 150).map(n => <button type="button" key={n} onClick={() => patch({ convidados: n })}>{n}</button>)}</div><p>Você também pode digitar a quantidade manualmente.</p></fieldset></details>
  <details><summary>Adicionais</summary><fieldset disabled={busy}><p>Informe somente quantidades extras. A Festa Premium já inclui 4 bombons, que não devem ser cobrados novamente.</p><div className={styles.grid}>{ctx.catalogo.itens.map(a => { const selecionado = form.adicionais.find(x => x.codigo === a.codigo), incluido = ctx.incluidos.includes(a.codigo); return <div key={a.codigo}><label><input type="checkbox" checked={!!selecionado} disabled={incluido && !selecionado} onChange={e => patch({ adicionais: e.target.checked ? [...form.adicionais, { codigo: a.codigo, quantidade: 1 }] : form.adicionais.filter(x => x.codigo !== a.codigo) })}/>{a.nome}{incluido ? ' · contém item incluído' : ''}</label>{selecionado && <label>Quantidade de {a.nome}<input type="number" min={a.unidadeCobranca === "UNIDADE" ? 1 : 0.01} step={a.unidadeCobranca === "UNIDADE" ? 1 : 0.01} value={selecionado.quantidade} onChange={e => patch({ adicionais: form.adicionais.map(x => x.codigo === a.codigo ? { ...x, quantidade: Number(e.target.value) } : x) })}/></label>}</div>; })}</div>{duplicados.length > 0 && <p role="alert">Remova os adicionais já incluídos no pacote antes de salvar.</p>}</fieldset></details>
  <details><summary>Escolhas do buffet</summary><fieldset disabled={busy}><p>Preferências não geram cobrança. Ao trocar pacote, confira as escolhas e salve primeiro com buffet pendente.</p><label>Definição do buffet<select aria-label="Definição do buffet" value={form.buffetStatus} onChange={e => patch({ buffetStatus: e.target.value as 'PENDENTE' | 'DEFINIDO' })}><option value="PENDENTE">Pendente</option><option value="DEFINIDO">Definido</option></select></label><div className={styles.grid}>{(['buffetSalgados', 'buffetBebidas', 'buffetDoces', 'buffetBolo', 'buffetOutros', 'buffetLembrancinha', 'buffetEmpratado', 'buffetBombom'] as const).map((k, i) => <label key={k}>{['Salgados', 'Bebidas', 'Doces', 'Bolo', 'Outras preferências', 'Lembrancinha', 'Empratado', 'Bombom'][i]}<textarea value={form[k]} maxLength={2000} onChange={e => patch({ [k]: e.target.value })}/></label>)}</div></fieldset></details>
  <details><summary>Condições comerciais</summary><fieldset disabled={busy}><p>Valor calculado: <strong>{moeda(preco)}</strong>{calculando ? ' · recalculando…' : ''}</p><p>Valor anterior: {formatarMoeda(ctx.fonte.fechamento.valorTabela)} (base de tabela).</p>
  <label><input type="checkbox" checked={comercial} onChange={e => setComercial(e.target.checked)}/> Revisar e aprovar condição comercial nesta edição</label>
  {comercial && <><div className={styles.grid}><label>Forma de pagamento<select aria-label="Forma de pagamento" value={forma} onChange={e => setForma(e.target.value as typeof forma)}><option value="PIX_AVISTA">PIX à vista — 10%</option><option value="PIX_PARCELADO">PIX parcelado — 3%</option><option value="CARTAO_CIELO">Cartão</option></select></label><label>Base negociada (opcional)<input type="number" min="0.01" step="0.01" value={base} onChange={e => setBase(e.target.value)}/></label></div><p>Em branco, aplica a base calculada pela tabela oficial. O desconto da forma de pagamento incide depois.</p>{forma === 'PIX_PARCELADO' && <div className={styles.grid}><label>Entrada acordada<input type="number" min="0" step="0.01" value={entrada} onChange={e => setEntrada(e.target.value)}/></label><label>Valor de parcela acordado<input type="number" min="0.01" step="0.01" value={parcela} onChange={e => setParcela(e.target.value)}/></label><label>Quantidade de parcelas acordada<input type="number" min="1" step="1" value={quantidade} onChange={e => setQuantidade(e.target.value)}/></label></div>}
  {preco !== undefined && !base && <p>Valor contratual após desconto: {formatarMoeda(calcularCondicaoComercial(preco, forma).valorFinalContrato)}</p>}<p>A aprovação comercial será registrada com seu usuário. Não cria cobrança nem recebimento.</p></>}
  </fieldset></details><label>Observações da equipe<textarea maxLength={2000} value={form.observacoesEquipe} onChange={e => patch({ observacoesEquipe: e.target.value })}/></label>
  <label>Motivo da alteração administrativa<input required minLength={3} maxLength={500} value={form.motivo} onChange={e => patch({ motivo: e.target.value })}/></label>
  <p role="alert">{erro || serverError || ctx.erroPreco}</p><button disabled={busy || calculando || !!erro || !!ctx.erroPreco || duplicados.length > 0} type="submit">Salvar alteração da festa</button><button disabled={busy} type="button" onClick={onClose}>Cancelar edição</button>
  </form></section>;
}
