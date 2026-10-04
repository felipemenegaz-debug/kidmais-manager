'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import {
  confirmar, confirmarRascunho, conferirFinanceiro, lerOpcoes, lerOpcoesRascunho, simularRascunho, novaChave, reautenticar, simular, simularFinanceiro,
  type OpcoesIntegracao, type SinalDuplicidade, type ResultadoIntegracao, type ResumoFinanceiro, type Simulacao, type SimulacaoFinanceira,
} from './cliente-integracao';
import {
  camposCorrigidos, conferenciaParcelas, dataBr, decisoesDoForm, errosFesta, errosPagamentos, financeiroDoFormulario, formInicial,
  FORMAS_ROTULO, novaParcela, reais, SITUACAO_CONTRATO_ROTULO, SITUACAO_FINANCEIRA_ROTULO, textoDeCentavos,
  type CampoDoc, type FormIntegracao, type ParcelaForm,
} from './integracao-form';
import styles from './importacao.module.css';
import ui from './integracao.module.css';

/**
 * "Integrar ao sistema": o contrato importado passa a participar do Core (festa, agenda, contas a receber e caixa).
 * Etapas: Festa e agenda → Pagamentos → Revisão final. A IA só sugeriu; aqui o operador confirma cada fato.
 * O resumo exibido é o calculado pelo servidor, e a confirmação exige exatamente esse resumo (hash).
 * Sucesso só é anunciado depois da resposta da integração.
 */
export type PassoIntegracao = 'festa' | 'pagamentos' | 'revisao' | 'concluida';
type Modo = 'completo' | 'financeiro';
type Carga = { tipo: 'carregando' } | { tipo: 'erro'; mensagem: string } | { tipo: 'pronto'; opcoes: OpcoesIntegracao };
type Revisao = { tipo: 'nenhuma' } | { tipo: 'calculando' } | { tipo: 'integracao'; sim: Extract<Simulacao, { integrada: false }>; chave: string } | { tipo: 'financeiro'; sim: Extract<SimulacaoFinanceira, { conferido: false }>; chave: string };

/** Caminho oficial dos pagamentos depois da integração (mesma regra da tela do contrato). */
const TEXTO_CAMINHO = {
  CONFERIR_HISTORICO: 'Os pagamentos ainda não foram conferidos.',
  PLANO_NA_VERSAO_VIGENTE: 'O contrato foi revisado depois da integração: registre os pagamentos no Financeiro do contrato (plano na versão vigente e recebimentos com a data real).',
  AGUARDAR_REVISAO: 'Há uma revisão do contrato em andamento: conclua ou cancele a revisão antes de registrar os pagamentos.',
  CONCLUIDO: 'Os pagamentos estão no Financeiro do contrato.',
} as const;

const ROTULO_SINAL: Record<SinalDuplicidade, string> = { MESMO_CLIENTE: 'mesmo cliente', MESMO_CONTATO: 'mesmo CPF ou telefone em outro cadastro', MESMO_ANIVERSARIANTE: 'mesmo aniversariante',
  MESMO_VALOR: 'mesmo valor', MESMO_DOCUMENTO: 'mesmo documento original', DATA_DO_DOCUMENTO: 'na data lida no documento', DATA_INVERTIDA: 'dia e mês trocados', DATA_PROXIMA: 'data próxima' };

const ROTULO_CAMPO: Record<CampoDoc, string> = { data: 'data', horarioInicio: 'início', horarioFim: 'término', convidados: 'convidados', valorContratado: 'valor contratado' };

export default function IntegracaoContrato({ importacaoId, modoInicial = 'completo', onPasso, onIntegrado, versaoRascunho, onOcupado }: { importacaoId: string; versaoRascunho?: number; onOcupado?(ocupado: boolean): void; modoInicial?: Modo; onPasso?(passo: PassoIntegracao): void; onIntegrado?(resultado: ResultadoIntegracao): void }) {
  const [carga, setCarga] = useState<Carga>({ tipo: 'carregando' });
  const [modo, setModo] = useState<Modo>(modoInicial);
  const [form, setForm] = useState<FormIntegracao | null>(null);
  const [passo, setPassoInterno] = useState<PassoIntegracao>(modoInicial === 'financeiro' ? 'pagamentos' : 'festa');
  const [revisao, setRevisao] = useState<Revisao>({ tipo: 'nenhuma' });
  const [erros, setErros] = useState<string[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoIntegracao | null>(null);
  const [financeiroConcluido, setFinanceiroConcluido] = useState<ResumoFinanceiro | null>(null);
  const [senha, setSenha] = useState('');

  const setPasso = useCallback((p: PassoIntegracao) => { setPassoInterno(p); onPasso?.(p); }, [onPasso]);

  const aplicar = useCallback((r: Awaited<ReturnType<typeof lerOpcoes>>) => {
    if (!r.ok) { setCarga({ tipo: 'erro', mensagem: r.mensagem }); return; }
    setCarga({ tipo: 'pronto', opcoes: r.dados });
    const f = formInicial(r.dados);
    if (versaoRascunho !== undefined && !f.situacaoFinanceira && !f.parcelas.length && !r.dados.sugestao.recebimentosDocumento?.recebimentos.length && !r.dados.sugestao.recebimentosDocumento?.pendencias.length) f.situacaoFinanceira = 'NAO_CONFERIDO';
    if (r.dados.integracao) { f.valorContratado = textoDeCentavos(r.dados.integracao.valorContratadoCentavos); f.situacaoContrato = 'VIGENTE'; }
    setForm(f);
  }, [versaoRascunho]);
  // Carga inicial: o estado só muda na resposta (sem setState síncrono no efeito).
  useEffect(() => {
    let ativo = true;
    void (versaoRascunho !== undefined ? lerOpcoesRascunho(adminFetch, importacaoId, versaoRascunho) : lerOpcoes(adminFetch, importacaoId)).then((r) => { if (ativo) aplicar(r); });
    return () => { ativo = false; };
  }, [importacaoId, aplicar, versaoRascunho]);
  const carregar = useCallback(async () => {
    setCarga({ tipo: 'carregando' });
    aplicar(await (versaoRascunho !== undefined ? lerOpcoesRascunho(adminFetch, importacaoId, versaoRascunho) : lerOpcoes(adminFetch, importacaoId)));
  }, [importacaoId, aplicar, versaoRascunho]);

  if (carga.tipo === 'carregando' || (carga.tipo === 'pronto' && !form)) return <section className={styles.painel} aria-busy="true"><h2 className={styles.titulo}>Preparando a integração</h2><p className={styles.texto}>Carregando unidades, pacotes e os dados do contrato…</p></section>;
  if (carga.tipo === 'erro') return <section className={styles.painel} role="alert"><h2 className={styles.titulo}>Não foi possível abrir a integração</h2><p className={styles.texto}>{carga.mensagem}</p><button type="button" className={styles.primario} onClick={() => void carregar()}>Tentar novamente</button></section>;
  const o = carga.opcoes;
  const f = form!;
  const atualizar = (mudar: Partial<FormIntegracao>) => { setForm({ ...f, ...mudar }); setErros([]); setErro(null); if (revisao.tipo !== 'nenhuma') setRevisao({ tipo: 'nenhuma' }); };
  const atualizarParcela = (chave: string, mudar: Partial<ParcelaForm>) => atualizar({ parcelas: f.parcelas.map((p) => p.chave === chave ? { ...p, ...mudar } : p) });

  if (!o.disponivel) return <section className={styles.painel} role="status"><h2 className={styles.titulo}>Integração ainda indisponível neste ambiente</h2><p className={styles.texto}>O contrato continua registrado como importado, com o documento original. A integração com festa, agenda e financeiro será liberada quando a atualização do banco for aplicada.</p></section>;

  if (resultado) return <Concluida resultado={resultado} />;
  if (financeiroConcluido && o.integracao) return <section className={styles.painel} role="status"><span className={styles.seloPronto}>Pagamentos conferidos</span><h2 className={styles.titulo}>Financeiro do contrato atualizado</h2><ResumoPagamentos financeiro={financeiroConcluido} /><div className={styles.acoesFinais}><Link className={styles.primario} href={`/admin/contratos?contratoId=${o.integracao.contratoId}`}>Abrir contrato</Link><Link className={styles.fantasma} href="/admin/financeiro/contas-receber">Contas a receber</Link></div></section>;

  if (o.integracao && modo === 'completo') return <section className={styles.painel} role="status">
    <span className={styles.seloPronto}>Integrado</span>
    <h2 className={styles.titulo}>Este contrato já faz parte do sistema</h2>
    <p className={styles.texto}>Festa, agenda e contrato estão no Core. {TEXTO_CAMINHO[o.integracao.caminhoFinanceiro ?? (o.integracao.financeiroPendente ? 'CONFERIR_HISTORICO' : 'CONCLUIDO')]}</p>
    <div className={styles.acoesFinais}>
      <Link className={styles.primario} href={`/admin/contratos?contratoId=${o.integracao.contratoId}`}>Abrir contrato</Link>
      {(o.integracao.caminhoFinanceiro ?? (o.integracao.financeiroPendente ? 'CONFERIR_HISTORICO' : 'CONCLUIDO')) === 'CONFERIR_HISTORICO'
        ? <button type="button" className={styles.fantasma} onClick={() => { setModo('financeiro'); setPasso('pagamentos'); }}>Conferir pagamentos</button>
        : o.integracao.caminhoFinanceiro !== 'AGUARDAR_REVISAO' && <Link className={styles.fantasma} href={`/admin/contratos?contratoId=${o.integracao.contratoId}#financeiro`}>Abrir Financeiro do contrato</Link>}
    </div>
  </section>;

  const avancarFesta = () => { const e = errosFesta(f, o.sugestao, o.estabelecimentos.length); setErros(e); if (!e.length) {
    if (versaoRascunho !== undefined && (f.situacaoFinanceira === 'PAGO' || f.situacaoFinanceira === 'NAO_CONFERIDO') && !errosPagamentos(f, o.sugestao, o.hoje).length) void revisar(f);
    else setPasso('pagamentos');
  } };

  /** `manterErro`: recálculo depois de uma recusa do servidor mantém o motivo visível. */
  async function revisar(formAtual: FormIntegracao = f, manterErro = false) {
    const e = modo === 'financeiro' ? errosPagamentos(formAtual, o.sugestao, o.hoje).filter((x) => !/valor contratado/i.test(x)) : [...errosFesta(formAtual, o.sugestao, o.estabelecimentos.length), ...errosPagamentos(formAtual, o.sugestao, o.hoje)];
    setErros(e);
    if (e.length) return;
    setRevisao({ tipo: 'calculando' }); if (!manterErro) setErro(null); setPasso('revisao');
    if (modo === 'financeiro') {
      const r = await simularFinanceiro(adminFetch, importacaoId, financeiroDoFormulario(formAtual));
      if (!r.ok) { setRevisao({ tipo: 'nenhuma' }); setErro(r.mensagem); return; }
      if (r.dados.conferido) { void carregar(); return; }
      setRevisao({ tipo: 'financeiro', sim: r.dados, chave: novaChave() });
      return;
    }
    const d = decisoesDoForm(formAtual, o.sugestao);
    const r = versaoRascunho !== undefined ? await simularRascunho(adminFetch, importacaoId, versaoRascunho, d) : await simular(adminFetch, importacaoId, d);
    if (!r.ok) { setRevisao({ tipo: 'nenhuma' }); setErro(r.mensagem); return; }
    if (r.dados.integrada) { void carregar(); return; }
    setRevisao({ tipo: 'integracao', sim: r.dados, chave: novaChave() });
  }

  async function confirmarAgora() {
    if (enviando || !senha || (revisao.tipo !== 'integracao' && revisao.tipo !== 'financeiro')) return;
    setEnviando(true); onOcupado?.(true); setErro(null);
    try {
      // Autenticação recente primeiro (mesma rota da assinatura Kidmais); a senha não fica guardada na tela.
      const auth = await reautenticar(adminFetch, senha);
      setSenha('');
      if (!auth.ok) { setErro(auth.mensagem); return; }
      if (revisao.tipo === 'financeiro') {
        const r = await conferirFinanceiro(adminFetch, importacaoId, financeiroDoFormulario(f), revisao.sim.resumoHash, revisao.chave);
        if (r.ok) { setFinanceiroConcluido(revisao.sim.resumo); setPasso('concluida'); return; }
        tratarFalha(r.codigo, r.mensagem, r.detalhes);
        return;
      }
      const r = versaoRascunho !== undefined
        ? await confirmarRascunho(adminFetch, importacaoId, versaoRascunho, decisoesDoForm(f, o.sugestao), revisao.sim.resumoHash, revisao.sim.planoHash ?? "")
        : await confirmar(adminFetch, importacaoId, decisoesDoForm(f, o.sugestao), revisao.sim.resumoHash, revisao.chave);
      if (r.ok) { setResultado(r.dados); setPasso('concluida'); onIntegrado?.(r.dados); return; }
      tratarFalha(r.codigo, r.mensagem, r.detalhes);
    } finally { setEnviando(false); onOcupado?.(false); }
  }

  function tratarFalha(codigo: string | null, mensagem: string, detalhes: Record<string, unknown> | null) {
    setErro(mensagem);
    if (codigo === 'RESUMO_DESATUALIZADO' || codigo === 'CONFLITO_AGENDA' || codigo === 'INTEGRACAO_BLOQUEADA') void revisar(f, true);
    if (codigo === 'IMPORTACAO_JA_INTEGRADA' || codigo === 'FINANCEIRO_JA_CONFERIDO') { void carregar(); setRevisao({ tipo: 'nenhuma' }); }
    if (codigo === 'IDEMPOTENCIA_CONFLITANTE') void revisar(f, true);
    if (Array.isArray(detalhes?.bloqueios)) setErros(detalhes.bloqueios.filter((b): b is string => typeof b === 'string'));
  }

  const corrigidos = camposCorrigidos(f, o.sugestao);
  const motivo = (c: CampoDoc) => corrigidos.includes(c) && <label className={ui.motivo}>
    <span>O documento diz {c === 'valorContratado' ? reais(o.sugestao.valorContratadoCentavos ?? 0) : c === 'data' ? dataBr(o.sugestao.evento.data ?? '') : String(o.sugestao.evento[c] ?? '')}. Por que o {ROTULO_CAMPO[c]} é outro? (correção de leitura)</span>
    <input value={f.motivos[c] ?? ''} maxLength={500} onChange={(e) => atualizar({ motivos: { ...f.motivos, [c]: e.target.value } })} />
  </label>;
  const conf = conferenciaParcelas(f);
  const bloqueadoPelaSituacao = f.situacaoContrato === 'CANCELADO' || f.situacaoContrato === 'NAO_COMPROVADA';

  return <div className={ui.assistente}>
    {passo === 'festa' && <section className={styles.painel} aria-labelledby="int-festa">
      <h2 id="int-festa" className={styles.titulo}>Festa e agenda</h2>
      <p className={styles.texto}>Confirme os dados operacionais. Valores diferentes do documento ficam registrados como correção de leitura; o documento original não muda.</p>
      <fieldset className={ui.grupo}>
        <legend>Situação do contrato</legend>
        <div className={ui.opcoes} role="radiogroup" aria-label="Situação do contrato">
          {(Object.keys(SITUACAO_CONTRATO_ROTULO) as Array<keyof typeof SITUACAO_CONTRATO_ROTULO>).map((s) => <label key={s} className={ui.opcao} data-marcado={f.situacaoContrato === s}>
            <input type="radio" name="situacaoContrato" checked={f.situacaoContrato === s} onChange={() => atualizar({ situacaoContrato: s })} />{SITUACAO_CONTRATO_ROTULO[s]}</label>)}
        </div>
        {bloqueadoPelaSituacao && <p className={styles.aviso}>Contrato cancelado ou não confirmado não vira festa e não ocupa agenda. Ele continua consultável como contrato importado, com o documento original.</p>}
      </fieldset>
      {!bloqueadoPelaSituacao && <>
        <div className={ui.grade}>
          <label className={ui.campo}><span>Unidade</span>
            {o.estabelecimentos.length ? <select value={f.estabelecimentoId} onChange={(e) => atualizar({ estabelecimentoId: e.target.value })}>
              <option value="">Escolha a unidade</option>
              {o.estabelecimentos.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
            </select> : <output>Unidade única desta empresa</output>}
          </label>
          <label className={ui.campo}><span>Pacote de referência no sistema</span>
            <select value={f.pacoteReferenciaId} onChange={(e) => atualizar({ pacoteReferenciaId: e.target.value })}>
              <option value="">Escolha o pacote</option>
              {o.pacotes.map((p) => <option key={p.id} value={p.id}>{p.nome}{p.ativo ? '' : ' (inativo)'}</option>)}
            </select>
            <small>Só referência operacional. Itens e valores continuam os do contrato{o.documento.pacote ? ` (“${o.documento.pacote}”)` : ''}.</small>
          </label>
          <label className={ui.campo}><span>Data da festa</span><input type="date" value={f.data} onChange={(e) => atualizar({ data: e.target.value })} /></label>
          <label className={ui.campo}><span>Início</span><input type="time" value={f.horarioInicio} onChange={(e) => atualizar({ horarioInicio: e.target.value })} /></label>
          <label className={ui.campo}><span>Término</span><input type="time" value={f.horarioFim} onChange={(e) => atualizar({ horarioFim: e.target.value })} />{!o.sugestao.evento.horarioFim && f.horarioFim && <small>Calculado pela duração do pacote no documento. Confira.</small>}</label>
          <label className={ui.campo}><span>Convidados</span><input inputMode="numeric" value={f.convidados} onChange={(e) => atualizar({ convidados: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></label>
        </div>
        {motivo('data')}{motivo('horarioInicio')}{motivo('horarioFim')}{motivo('convidados')}
        {(o.documento.aniversariante || o.documento.tema) && <p className={styles.discreto}>Do documento: {[o.documento.aniversariante && `aniversariante ${o.documento.aniversariante}`, o.documento.tema && `tema “${o.documento.tema}”`].filter(Boolean).join(' · ')}.</p>}
      </>}
      <Erros erros={erros} erro={erro} />
      <div className={styles.acoesFinais}><button type="button" className={styles.primario} disabled={bloqueadoPelaSituacao || !f.situacaoContrato} onClick={avancarFesta}>{versaoRascunho !== undefined && (f.situacaoFinanceira === 'PAGO' || f.situacaoFinanceira === 'NAO_CONFERIDO') ? 'Revisar e concluir' : 'Continuar para pagamentos'}</button></div>
    </section>}

    {passo === 'pagamentos' && <section className={styles.painel} aria-labelledby="int-pag">
      <h2 id="int-pag" className={styles.titulo}>{modo === 'financeiro' ? 'Conferir pagamentos' : 'Pagamentos'}</h2>
      {!!o.sugestao.recebimentosDocumento?.recebimentos.length && <p className={styles.aviso}>O documento traz recebimentos explícitos. Quando eles somam o valor contratado, os pagamentos são preenchidos para sua conferência. Confira valores, datas e formas antes de concluir; os vencimentos usam a data recebida como complemento operacional.</p>}
      {o.sugestao.recebimentosDocumento?.pendencias.map(p => <p key={p} className={styles.aviso}>{p}</p>)}
      <p className={styles.texto}>Registre só o que foi efetivamente recebido, com a data real e a forma. O restante entra em Contas a receber.</p>
      <div className={ui.grade}>
        <label className={ui.campo}><span>Valor contratado</span>
          {modo === 'financeiro' ? <output>R$ {f.valorContratado}</output> : <input inputMode="decimal" placeholder="0,00" value={f.valorContratado} onChange={(e) => atualizar({ valorContratado: e.target.value })} />}
        </label>
      </div>
      {modo !== 'financeiro' && motivo('valorContratado')}
      {o.sugestao.condicaoDocumento && <p className={styles.aviso}>Condição no documento: “{o.sugestao.condicaoDocumento}”. Isso descreve o que foi combinado; não comprova que algo foi pago.</p>}
      <fieldset className={ui.grupo}>
        <legend>Situação dos pagamentos</legend>
        <div className={ui.opcoes} role="radiogroup" aria-label="Situação dos pagamentos">
          {(Object.keys(SITUACAO_FINANCEIRA_ROTULO) as Array<keyof typeof SITUACAO_FINANCEIRA_ROTULO>).filter((s) => modo !== 'financeiro' || s !== 'NAO_CONFERIDO').map((s) => <label key={s} className={ui.opcao} data-marcado={f.situacaoFinanceira === s}>
            <input type="radio" name="situacaoFinanceira" checked={f.situacaoFinanceira === s} onChange={() => atualizar({ situacaoFinanceira: s })} />{SITUACAO_FINANCEIRA_ROTULO[s]}</label>)}
        </div>
      </fieldset>
      {f.situacaoFinanceira === 'NAO_CONFERIDO' && <p className={styles.aviso}>Nada entra em Contas a receber nem no Fluxo de caixa agora. O contrato fica com a pendência “Conferir pagamentos”, visível no contrato, para concluir depois.</p>}
      {f.situacaoFinanceira && f.situacaoFinanceira !== 'NAO_CONFERIDO' && <div className={ui.parcelas}>
        <table>
          <caption className={styles.oculto}>Parcelas do contrato</caption>
          <thead><tr><th scope="col">#</th><th scope="col">Valor</th><th scope="col">Vencimento</th><th scope="col">Recebida?</th><th scope="col">Recebida em</th><th scope="col">Forma</th><th scope="col">Exceção</th><th scope="col"><span className={styles.oculto}>Remover</span></th></tr></thead>
          <tbody>{f.parcelas.map((p, i) => <tr key={p.chave} data-recebida={p.recebida}>
            <td>{i + 1}</td>
            <td><input aria-label={`Valor da parcela ${i + 1}`} inputMode="decimal" placeholder="0,00" value={p.valor} onChange={(e) => atualizarParcela(p.chave, { valor: e.target.value })} /></td>
            <td><input aria-label={`Vencimento da parcela ${i + 1}`} type="date" value={p.vencimento} onChange={(e) => atualizarParcela(p.chave, { vencimento: e.target.value })} /></td>
            <td><input aria-label={`Parcela ${i + 1} foi recebida`} type="checkbox" checked={p.recebida} onChange={(e) => atualizarParcela(p.chave, { recebida: e.target.checked, ...(e.target.checked ? {} : { recebidaEm: '', forma: '' }) })} /></td>
            <td>{p.recebida && <input aria-label={`Data em que a parcela ${i + 1} foi recebida`} type="date" max={o.hoje} value={p.recebidaEm} onChange={(e) => atualizarParcela(p.chave, { recebidaEm: e.target.value })} />}</td>
            <td>{p.recebida && <select aria-label={`Forma da parcela ${i + 1}`} value={p.forma} onChange={(e) => atualizarParcela(p.chave, { forma: e.target.value as ParcelaForm['forma'] })}>
              <option value="">Forma</option>{(Object.keys(FORMAS_ROTULO) as Array<keyof typeof FORMAS_ROTULO>).map((k) => <option key={k} value={k}>{FORMAS_ROTULO[k]}</option>)}
            </select>}</td>
            <td>{f.data && p.vencimento > f.data && <label className={ui.excecao}><input type="checkbox" aria-label={`Parcela ${i + 1} vence depois da festa conforme o contrato original`} checked={p.aposFestaConfirmada} onChange={(e) => atualizarParcela(p.chave, { aposFestaConfirmada: e.target.checked })} />Vence depois da festa: consta do contrato original</label>}</td>
            <td><button type="button" className={styles.linkBotao} aria-label={`Remover parcela ${i + 1}`} onClick={() => atualizar({ parcelas: f.parcelas.filter((x) => x.chave !== p.chave) })}>Remover</button></td>
          </tr>)}</tbody>
        </table>
        <button type="button" className={styles.fantasma} disabled={f.parcelas.length >= 60} onClick={() => atualizar({ parcelas: [...f.parcelas, novaParcela()] })}>Adicionar parcela</button>
        <p className={ui.conferencia} data-confere={conf.soma === conf.total}>
          Parcelas {reais(conf.soma)} · Contratado {reais(conf.total)} · Recebido {reais(conf.recebido)} · Saldo a receber {reais(conf.saldo)}
          {conf.soma !== conf.total && <strong> — a soma precisa ser igual ao contratado</strong>}
        </p>
      </div>}
      <Erros erros={erros} erro={erro} />
      <div className={styles.acoesFinais}>
        {modo !== 'financeiro' && <button type="button" className={styles.fantasma} onClick={() => setPasso('festa')}>Voltar</button>}
        <button type="button" className={styles.primario} onClick={() => void revisar()}>Revisar e confirmar</button>
      </div>
    </section>}

    {passo === 'revisao' && <section className={styles.painel} aria-labelledby="int-rev" aria-busy={revisao.tipo === 'calculando'}>
      <h2 id="int-rev" className={styles.titulo}>Revisão final</h2>
      {revisao.tipo === 'calculando' && <p className={styles.texto}>Conferindo agenda, valores e vínculos…</p>}
      {revisao.tipo === 'integracao' && <>
        <p className={styles.texto}>Isto é o que será registrado. Nada foi gravado ainda.</p>
        <dl className={ui.resumo}>
          <div><dt>Contrato</dt><dd>{revisao.sim.resumo.contrato.cliente} · {reais(revisao.sim.resumo.contrato.valorContratadoCentavos)}<small>{revisao.sim.resumo.contrato.pacoteDocumento ?? 'Pacote do documento não informado'}{revisao.sim.resumo.contrato.pacoteReferencia ? ` · referência: ${revisao.sim.resumo.contrato.pacoteReferencia}` : ''}</small><small>{revisao.sim.resumo.contrato.conferencia}</small></dd></div>
          <div><dt>Festa</dt><dd>{dataBr(revisao.sim.resumo.festa.data)}, {revisao.sim.resumo.festa.horarioInicio}–{revisao.sim.resumo.festa.horarioFim} · {revisao.sim.resumo.festa.convidados} convidados<small>{[revisao.sim.resumo.festa.aniversariante, revisao.sim.resumo.festa.tema].filter(Boolean).join(' · ')}</small>{revisao.sim.resumo.festa.aniversarianteCadastro && <small>{revisao.sim.resumo.festa.aniversarianteCadastro === 'NOVO' ? `Aniversariante será cadastrado no cliente ${revisao.sim.resumo.contrato.cliente}.` : 'Aniversariante vinculado ao cadastro existente do cliente.'}</small>}</dd></div>
          <div><dt>Agenda</dt><dd data-ocupa={revisao.sim.resumo.agenda.ocupa}>{revisao.sim.resumo.agenda.descricao}{revisao.sim.resumo.contrato.unidade && <small>Unidade: {revisao.sim.resumo.contrato.unidade}</small>}</dd></div>
        </dl>
        <ResumoPagamentos financeiro={revisao.sim.resumo.financeiro} />
        {revisao.sim.resumo.campos.some((c) => c.origem !== 'DOCUMENTO') && <div className={ui.correcoes}>
          <h3>Diferenças em relação ao documento</h3>
          <ul>{revisao.sim.resumo.campos.filter((c) => c.origem !== 'DOCUMENTO').map((c) => <li key={c.campo}>
            <strong>{c.rotulo}:</strong> {c.efetivo} — {c.origem === 'CORRECAO_LEITURA' ? `correção de leitura (documento: ${c.documento}). ${c.motivo ?? ''}` : 'complemento (não consta no documento)'}
          </li>)}</ul>
        </div>}
        {revisao.sim.possiveisVinculos.length > 0 && <div className={styles.aviso}>
          <p>Possível duplicidade: {revisao.sim.possiveisVinculos.length === 1 ? 'há uma contratação parecida' : 'há contratações parecidas'} nesta empresa {revisao.sim.possiveisVinculos.some((v) => v.alcance === 'OUTRA_DATA') ? 'neste dia ou em outra data (a data pode ter sido lida ou corrigida de outro jeito)' : 'neste dia'}. Pode ser o mesmo contrato escaneado de novo. Confira antes de seguir; nada é unido nem descartado automaticamente.</p>
          <ul>{revisao.sim.possiveisVinculos.map((v) => <li key={v.fechamentoId}>{v.alcance === 'OUTRA_DATA' ? `${dataBr(v.data)}, ` : ''}{v.horario} · {v.status.toLowerCase()}{v.importado ? ' · contrato importado' : ''}{v.comPagamento ? ' · com pagamentos' : ''} — {v.sinais.map((s) => ROTULO_SINAL[s]).join(', ')}{v.contratoId && <> · <Link href={`/admin/contratos?contratoId=${v.contratoId}`} target="_blank">abrir</Link></>}</li>)}</ul>
          <label className={ui.declaracao}><input type="checkbox" aria-label="É outro contrato" checked={f.outroContratoConfirmado} onChange={(e) => setForm({ ...f, outroContratoConfirmado: e.target.checked })} />É outro contrato (não é o mesmo já registrado)</label>
          {f.outroContratoConfirmado && <label className={ui.motivo}><span>Por que é outro contrato? (fica registrado na auditoria)</span>
            <input aria-label="Motivo: é outro contrato" value={f.motivoOutroContrato} maxLength={500} onChange={(e) => setForm({ ...f, motivoOutroContrato: e.target.value })} /></label>}
          <button type="button" className={styles.fantasma} disabled={f.outroContratoConfirmado && f.motivoOutroContrato.trim().length < 5} onClick={() => void revisar(f)}>Registrar decisão</button>
        </div>}
        <Erros erros={revisao.sim.bloqueios} erro={erro} />
        {revisao.sim.avisos.filter((a) => !/declare a conferência/i.test(a)).length > 0 && <ul className={styles.discreto}>{revisao.sim.avisos.filter((a) => !/declare a conferência/i.test(a)).map((a) => <li key={a}>{a}</li>)}</ul>}
        <label className={ui.declaracao}><input type="checkbox" checked={f.conferenciaDeclarada} onChange={(e) => { const novo = { ...f, conferenciaDeclarada: e.target.checked }; setForm(novo); void revisar(novo); }} />{o.declaracao}</label>
      </>}
      {revisao.tipo === 'financeiro' && <>
        <p className={styles.texto}>Isto é o que entra no financeiro do contrato. Nada foi gravado ainda.</p>
        <ResumoPagamentos financeiro={revisao.sim.resumo} />
        <Erros erros={revisao.sim.bloqueios} erro={erro} />
      </>}
      {revisao.tipo === 'nenhuma' && <Erros erros={erros} erro={erro} />}
      {(revisao.tipo === 'integracao' || revisao.tipo === 'financeiro') && <label className={ui.campo}><span>Confirme sua senha para registrar</span>
        <input type="password" aria-label="Senha para confirmar" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} /></label>}
      <div className={styles.acoesFinais}>
        <button type="button" className={styles.fantasma} disabled={enviando} onClick={() => setPasso('pagamentos')}>Voltar e corrigir</button>
        <button type="button" className={styles.primario} disabled={enviando || !senha || !((revisao.tipo === 'integracao' && revisao.sim.pronto && f.conferenciaDeclarada) || (revisao.tipo === 'financeiro' && revisao.sim.pronto))} onClick={() => void confirmarAgora()}>
          {enviando ? 'Integrando…' : modo === 'financeiro' ? 'Confirmar pagamentos' : 'Confirmar integração'}
        </button>
      </div>
    </section>}
  </div>;
}

function Erros({ erros, erro }: { erros: string[]; erro: string | null }) {
  if (!erros.length && !erro) return null;
  return <div className={ui.erros} role="alert">
    {erro && <p>{erro}</p>}
    {erros.length > 0 && <ul>{erros.map((e) => <li key={e}>{e}</li>)}</ul>}
  </div>;
}

const FORMA = (f: string | null) => (f && f in FORMAS_ROTULO ? FORMAS_ROTULO[f as keyof typeof FORMAS_ROTULO] : f ?? '');

function ResumoPagamentos({ financeiro }: { financeiro: ResumoFinanceiro }) {
  if (financeiro.situacao === 'NAO_CONFERIDO') return <div className={ui.pagamentos}><h3>Pagamentos</h3><p>{reais(financeiro.contratadoCentavos)} contratados. Pagamentos não conferidos: nenhum recebimento nem conta a receber será criado agora. Fica a pendência “Conferir pagamentos”.</p></div>;
  return <div className={ui.pagamentos}>
    <h3>Pagamentos</h3>
    <p className={ui.totais}><span>Contratado <strong>{reais(financeiro.contratadoCentavos)}</strong></span><span>Recebido <strong>{reais(financeiro.recebidoCentavos)}</strong></span><span>Saldo <strong>{reais(financeiro.saldoCentavos)}</strong></span></p>
    {financeiro.recebimentos.length > 0 && <><h4>Recebimentos que entram no caixa (nas datas reais)</h4><ul>{financeiro.recebimentos.map((r) => <li key={r.numero}>Parcela {r.numero}: {reais(r.valorCentavos)} em {dataBr(r.data)} · {FORMA(r.forma)}</li>)}</ul></>}
    {financeiro.aReceber.length > 0 && <><h4>Parcelas a receber (Contas a receber)</h4><ul>{financeiro.aReceber.map((p) => <li key={p.numero} data-vencida={p.situacao === 'VENCIDA'}>Parcela {p.numero}: {reais(p.valorCentavos)}, vence {dataBr(p.vencimento)}{p.situacao === 'VENCIDA' ? ' · vencida' : ''}</li>)}</ul></>}
  </div>;
}

function Concluida({ resultado }: { resultado: ResultadoIntegracao }) {
  const contrato = `/admin/contratos?contratoId=${resultado.contratoId}`;
  const festa = resultado.festaId ? `/admin/festas/${resultado.festaId}` : '/admin/festas';
  if (resultado.reutilizado) return <section className={styles.painel} role="status">
    <span className={styles.seloPronto}>Integrado</span>
    <h2 className={styles.titulo}>Esta integração já tinha sido concluída</h2>
    <p className={styles.texto}>A confirmação repetida não criou nada novo. Abra o contrato para conferir festa, agenda e pagamentos.</p>
    <div className={styles.acoesFinais}><Link className={styles.primario} href={contrato}>Abrir contrato</Link></div>
  </section>;
  return <section className={styles.painel} role="status">
    <span className={styles.seloPronto}>Integrado</span>
    <h2 className={styles.titulo}>Contrato integrado ao sistema</h2>
    <ul className={ui.feito}>
      <li>Contrato registrado no sistema, com a conferência do contrato em papel e o documento original preservado.</li>
      <li>{resultado.agendaOcupada === false ? 'Festa registrada no Histórico (evento passado, sem ocupar agenda).' : 'Festa criada e agenda ocupada na data e horário confirmados.'}</li>
      <li>{resultado.financeiro?.pendente ? 'Pagamentos não conferidos: pendência “Conferir pagamentos” no contrato.' : `Financeiro atualizado: ${reais(resultado.financeiro?.recebidoCentavos ?? 0)} recebidos e ${reais(resultado.financeiro?.saldoCentavos ?? 0)} a receber.`}</li>
    </ul>
    <div className={styles.acoesFinais}>
      <Link className={styles.primario} href={contrato}>Abrir contrato</Link>
      <Link className={styles.fantasma} href={festa}>Abrir festa</Link>
      {!resultado.financeiro?.pendente && <Link className={styles.fantasma} href="/admin/financeiro/contas-receber">Contas a receber</Link>}
    </div>
  </section>;
}
