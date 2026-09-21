'use client';
import { useRef, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { condicaoDoPlano, erroCondicaoComercial, planoExplicito, pretensaoInicial, enviarPlanoInicial, type ContextoCriacao, type PedidoInicial, type SugestaoInicial } from './criacao-financeira';
import type { PlanoPagamentoInput } from '@/lib/pagamentos/services/models';
import styles from './financeiro.module.css';

const moeda = (valor: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor);
type Revisao = { plano: PlanoPagamentoInput; pedido: PedidoInicial; sugestao?: SugestaoInicial };
export default function CriarPlanoFinanceiro({ contexto, onCreated }: { contexto: ContextoCriacao | null; onCreated: () => Promise<void> }) {
  const condicao = condicaoDoPlano(contexto?.forma ?? '');
  const meio = condicao?.meio ?? 'PIX';
  const [aberto, setAberto] = useState(false);
  const [modalidadeCartao, setModalidade] = useState<'AVISTA' | 'PARCELADO'>('AVISTA');
  const modalidade = condicao?.meio === 'CARTAO' ? modalidadeCartao : condicao?.modalidades[0] ?? 'AVISTA';
  const [linhas, setLinhas] = useState([{ valor: '', vencimento: '' }]);
  const [entrada, setEntrada] = useState(''), [quantidade, setQuantidade] = useState(''), [pretendido, setPretendido] = useState('');
  const [revisao, setRevisao] = useState<Revisao | null>(null), [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false), [criado, setCriado] = useState(false);
  const trava = useRef(false), chaves = useRef(new Map<string, string>());
  const automatico = meio === 'PIX' && modalidade === 'PARCELADO';
  function mudar(work: () => void) { work(); setRevisao(null); setErro(''); }
  async function executar(work: () => Promise<void>) {
    if (trava.current) return;
    trava.current = true; setBusy(true); setErro('');
    try { await work(); } catch (e) { setErro(e instanceof Error ? e.message : 'Operação não concluída.'); }
    finally { trava.current = false; setBusy(false); }
  }
  async function enviar(pedido: PedidoInicial) {
    const identidade = JSON.stringify([contexto, pedido]);
    let chave = chaves.current.get(identidade);
    if (!chave) { chave = crypto.randomUUID(); chaves.current.set(identidade, chave); }
    return enviarPlanoInicial(adminFetch, contexto!, pedido, chave);
  }
  async function conferir() {
    if (!contexto) return;
    if (automatico) {
      const pedido = pretensaoInicial(entrada, quantidade, pretendido);
      const result = await enviar(pedido);
      if (!result.sugestao) throw Error('A API não retornou uma sugestão. Atualize o painel.');
      setRevisao({ plano: result.sugestao.plano, pedido, sugestao: result.sugestao });
    } else {
      const plano = planoExplicito(contexto, meio, modalidade, linhas);
      setRevisao({ plano, pedido: plano });
    }
  }
  async function confirmar() {
    if (!revisao) return;
    const pedido = revisao.sugestao ? { ...revisao.pedido, confirmacao: {
      dataReferencia: revisao.sugestao.dataReferencia, hash: revisao.sugestao.hash,
    } } : revisao.pedido;
    const result = await enviar(pedido);
    if (!result.criado) { setRevisao(null); throw Error('Confira uma nova sugestão antes de confirmar.'); }
    setCriado(true); window.location.hash = 'financeiro'; await onCreated();
  }
  return <section className={styles.panel} aria-label="Criar plano financeiro">
    <h2>Financeiro da contratação</h2>
    {erro && <p role="alert" className={styles.error}>{erro}</p>}
    {criado ? <><p role="status">Plano criado. Nenhum recebimento foi registrado.</p><button disabled={busy} onClick={() => executar(onCreated)}>Carregar posição financeira</button></> : <>
      <p>Nenhum plano financeiro foi criado para esta contratação.</p>
      {!contexto ? <p>É necessário concluir as assinaturas da versão vigente para criar o plano financeiro.</p> : !condicao ? <p role="alert">{erroCondicaoComercial}</p> : <>
        <p>Versão vigente: <strong>V{contexto.numeroVersao}</strong> · Valor contratual vigente: <strong>{moeda(contexto.valor)}</strong> · Data da Festa: {contexto.dataFesta.split('-').reverse().join('/')}</p>
        {!aberto ? <button onClick={() => setAberto(true)}>Criar plano financeiro</button> : <form onSubmit={e => { e.preventDefault(); void executar(conferir); }}>
          <fieldset disabled={busy} className={styles.wizard}><legend>Condição financeira</legend>
            <label>Meio de pagamento<input readOnly value={meio === 'PIX' ? 'PIX' : 'Cartão'}/></label>
            <label>Modalidade{meio === 'CARTAO' ? <select value={modalidade} onChange={e => mudar(() => { setModalidade(e.target.value as typeof modalidade); setLinhas([{ valor: '', vencimento: '' }]); })}><option value="AVISTA">À vista</option><option value="PARCELADO">Parcelado</option></select> : <input readOnly value={modalidade === 'AVISTA' ? 'À vista' : 'Parcelado'}/>}</label>
            <p>A forma de pagamento foi definida no contrato assinado. Para alterá-la, é necessário criar uma nova revisão contratual.</p>
            <p>O valor vigente já incorpora a condição comercial. Nenhum desconto será reaplicado e criar o plano não significa receber o pagamento.</p>
            {meio === 'CARTAO' && <p>Parcelamento na operadora não cria parcelas contratuais automaticamente. Use À vista para uma cobrança integral e depois Registrar recebimento → CARTAO. Parcelado controla obrigações próprias da Kidmais, de 2 a 60 parcelas.</p>}
            {automatico ? <>
              {contexto.forma !== 'PIX_PARCELADO' ? <p role="alert">A sugestão automática exige PIX parcelado na versão contratual vigente. A condição comercial só pode ser alterada pelo fluxo de revisão contratual.</p> : <>
                <p>PIX parcelado: desconto comercial de 3% já incorporado ao contrato. Informe a condição pretendida ou deixe os campos vazios para a sugestão automática.</p>
                <label>Entrada pretendida (R$)<input inputMode="decimal" value={entrada} onChange={e => mudar(() => setEntrada(e.target.value))}/></label>
                <label>Quantidade desejada de parcelas do saldo<input inputMode="numeric" value={quantidade} onChange={e => mudar(() => setQuantidade(e.target.value))}/></label>
                <label>Valor pretendido por parcela (R$)<input inputMode="decimal" value={pretendido} onChange={e => mudar(() => setPretendido(e.target.value))}/></label>
              </>}
            </> : <><h3>Parcelas propostas</h3>{linhas.map((linha, i) => <div className={styles.item} key={i}>
              <label>Valor da parcela {i + 1} (R$)<input inputMode="decimal" readOnly={modalidade === 'AVISTA'} value={modalidade === 'AVISTA' ? contexto.valor.toFixed(2).replace('.', ',') : linha.valor} onChange={e => mudar(() => setLinhas(linhas.map((l, n) => n === i ? { ...l, valor: e.target.value } : l)))}/></label>
              <label>Vencimento da parcela {i + 1}<input type="date" required max={contexto.dataFesta} value={linha.vencimento} onChange={e => mudar(() => setLinhas(linhas.map((l, n) => n === i ? { ...l, vencimento: e.target.value } : l)))}/></label>
              {modalidade === 'PARCELADO' && <button type="button" disabled={linhas.length <= 1} onClick={() => mudar(() => setLinhas(linhas.filter((_, n) => n !== i)))}>Remover parcela {i + 1}</button>}
            </div>)}{modalidade === 'PARCELADO' && <button type="button" disabled={linhas.length >= 60} onClick={() => mudar(() => setLinhas([...linhas, { valor: '', vencimento: '' }]))}>Adicionar parcela</button>}</>}
            <button type="submit" disabled={busy || (automatico && contexto.forma !== 'PIX_PARCELADO')}>{automatico ? 'Solicitar sugestão' : 'Conferir plano'}</button>
            <button type="button" onClick={() => { setAberto(false); setRevisao(null); }}>Cancelar</button>
          </fieldset>
        </form>}
        {aberto && revisao && <section aria-label="Resumo do plano financeiro">
          <h3>{revisao.sugestao ? 'Sugestão de parcelamento' : 'Resumo do plano financeiro'}</h3>
          {revisao.sugestao?.contraproposta && <p role="status">Contraproposta: {revisao.sugestao.motivo} Máximo viável: {revisao.sugestao.quantidadeMaxima} parcelas do saldo. Valor mínimo aproximado: {moeda(revisao.sugestao.valorMinimoPorParcela)}. Confira antes de aceitar.</p>}
          <p>Valor contratual: {moeda(contexto.valor)} · Meio: {meio === 'PIX' ? 'PIX' : 'Cartão'} · Modalidade do plano: {revisao.plano.modalidade === 'AVISTA' ? 'À vista' : 'Parcelado'}</p>
          {revisao.sugestao && <p>Valor final: {moeda(revisao.sugestao.valorFinal)} · Entrada: {moeda(revisao.sugestao.entrada)} · Saldo parcelado: {moeda(revisao.sugestao.saldoParcelado)}</p>}
          <p>{revisao.plano.parcelas.length} parcela(s), incluindo entrada quando houver.</p>
          <table><thead><tr><th>Parcela</th><th>Valor</th><th>Vencimento</th></tr></thead><tbody>{revisao.plano.parcelas.map((p, i) => <tr key={i}><td>{i + 1}</td><td>{moeda(p.valor)}</td><td>{p.vencimento.split('-').reverse().join('/')}</td></tr>)}</tbody></table>
          <p>Total do plano: <strong>{moeda(revisao.plano.parcelas.reduce((s, p) => s + Math.round(p.valor * 100), 0) / 100)}</strong></p>
          <p>A confirmação registra somente o plano. Use Registrar recebimento após uma transação real.</p>
          <button disabled={busy} onClick={() => executar(confirmar)}>Confirmar plano financeiro</button>
        </section>}
      </>}
    </>}
  </section>;
}
