'use client';
import { useState } from 'react';
import { calcularTotalPagamento, numeroParaMoeda } from '@/components/fechamento/calculos';
import { EstadoCarga, enviarMarketing, useMarketing } from '@/components/admin/marketing/comum';
import { REGRAS_NEUTRAS, type RegrasPagamento } from '@/lib/comercial/regras-pagamento';
import { rotuloDescontoPix } from '@/lib/fechamentos/marca-publica';
import type { CamposDescontos, EstadoDescontos } from '@/lib/comercial/regras-pagamento-admin';
import styles from './descontos-pagamento.module.css';

const URL_API = '/api/admin/configuracoes/descontos';
const TETO = 50;
/** Valor de exemplo das previas: só ilustra a conta, não é preço de nenhum pacote. */
const EXEMPLO = 5000;

type Rascunho = { pixAvista: string; pixParcelado: string; cartao: string };
const rascunhoDe = (c: CamposDescontos): Rascunho => ({ pixAvista: String(c.pixAvistaPercentual), pixParcelado: String(c.pixParceladoPercentual), cartao: c.cartaoRotulo });

/** Mesmas regras do servidor (lib/comercial/regras-pagamento-admin.ts); o servidor continua sendo quem decide. */
function conferir(r: Rascunho): { campos: CamposDescontos | null; erros: Partial<Record<keyof Rascunho, string>> } {
  const erros: Partial<Record<keyof Rascunho, string>> = {};
  const pct = (v: string, nome: string, chave: keyof Rascunho) => {
    const t = v.trim();
    const n = Number(t);
    if (t === '' || !Number.isFinite(n)) erros[chave] = `Informe o desconto do ${nome} (0 a ${TETO}).`;
    else if (!Number.isInteger(n)) erros[chave] = `Use número inteiro, sem casas decimais.`;
    else if (n < 0) erros[chave] = `O desconto não pode ser negativo.`;
    else if (n > TETO) erros[chave] = `Passa do limite de ${TETO}%. Confira se não houve erro de digitação.`;
    return n;
  };
  const pixAvistaPercentual = pct(r.pixAvista, 'Pix à vista', 'pixAvista');
  const pixParceladoPercentual = pct(r.pixParcelado, 'Pix parcelado', 'pixParcelado');
  const cartaoRotulo = r.cartao.replace(/\s+/g, ' ').trim();
  if (cartaoRotulo.length < 2 || cartaoRotulo.length > 40) erros.cartao = 'O nome do cartão precisa ter de 2 a 40 letras.';
  return { campos: Object.keys(erros).length ? null : { pixAvistaPercentual, pixParceladoPercentual, cartaoRotulo }, erros };
}

const dataHora = (iso: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(iso));

export default function DescontosPagamentoConfiguracao() {
  const { dados, falha, carregando, recarregar, setDados } = useMarketing<EstadoDescontos>(URL_API);
  // Fora do formulário: salvar muda a versão e recria o formulário, e o aviso de resultado precisa continuar na tela.
  const [aviso, setAviso] = useState<Aviso | null>(null);
  return <main className={styles.pagina} data-admin-workspace>
    <header className={styles.topo}>
      <h1>Descontos e formas de pagamento</h1>
      <p>O que o cliente vê ao escolher como pagar: o desconto do Pix e o nome do cartão. Vale para fechamentos novos.</p>
    </header>
    <EstadoCarga carregando={carregando && !dados} falha={falha} aoTentar={recarregar} />
    {dados && !dados.instalada && <section className={styles.cartao} role="status">
      <h2>Ainda não disponível neste ambiente</h2>
      <p className={styles.muted}>Os descontos por forma de pagamento dependem de uma atualização do sistema que ainda não foi instalada aqui. Nada pode ser salvo por enquanto.</p>
    </section>}
    {dados && dados.instalada && <Formulario key={dados.versao ?? 'sem-linha'} estado={dados} aoSalvar={setDados} aviso={aviso} setAviso={setAviso} />}
  </main>;
}

type Aviso = { tipo: 'ok' | 'erro'; texto: string };

function Formulario({ estado, aoSalvar, aviso, setAviso }: { estado: Extract<EstadoDescontos, { instalada: true }>; aoSalvar: (e: EstadoDescontos) => void; aviso: Aviso | null; setAviso: (a: Aviso | null) => void }) {
  const [rascunho, setRascunho] = useState<Rascunho>(() => rascunhoDe(estado.formulario));
  const [enviando, setEnviando] = useState(false);
  const { campos, erros } = conferir(rascunho);
  const previa: RegrasPagamento = campos ? { ...REGRAS_NEUTRAS, ...campos } : estado.vigente;

  async function salvar() {
    if (!campos || enviando) return;
    setEnviando(true);
    setAviso(null);
    try {
      const novo = await enviarMarketing<EstadoDescontos>(URL_API, { ...campos, versao: estado.versao });
      aoSalvar(novo);
      setAviso({ tipo: 'ok', texto: 'Salvo. Vale para os próximos fechamentos; os já feitos não mudam.' });
    } catch (e) {
      setAviso({ tipo: 'erro', texto: e instanceof Error ? e.message : 'Não foi possível salvar.' });
    } finally {
      setEnviando(false);
    }
  }

  const campo = (chave: keyof Rascunho, rotulo: string, tipo: 'pct' | 'texto') => <label className={styles.campo} htmlFor={`desc-${chave}`}>
    {rotulo}
    <input id={`desc-${chave}`} {...(tipo === 'pct' ? { type: 'number', inputMode: 'numeric', min: 0, max: TETO, step: 1 } : { type: 'text', maxLength: 40 })}
      // Travado durante o envio: o formulário é recriado ao salvar e descartaria o que fosse digitado (Astra r1, P3).
      readOnly={enviando} value={rascunho[chave]} aria-invalid={erros[chave] ? true : undefined} aria-describedby={erros[chave] ? `desc-${chave}-erro` : undefined}
      onChange={(e) => { setRascunho((r) => ({ ...r, [chave]: e.target.value })); setAviso(null); }} />
    {erros[chave] && <span className={styles.erroCampo} id={`desc-${chave}-erro`}>{erros[chave]}</span>}
  </label>;

  return <>
    {!estado.configurada && <p className={styles.alerta} role="note">
      <b>Ainda não salvo.</b> Hoje seus clientes veem <b>0% de desconto</b> no Pix. Os campos já trazem uma sugestão (5% no Pix à vista e 2% no Pix parcelado), mas ela só passa a valer depois de você salvar.
    </p>}
    <div className={styles.dois}>
      <section className={styles.cartao} aria-labelledby="desc-t1">
        <h2 id="desc-t1">1. Descontos por forma de pagamento</h2>
        <form onSubmit={(e) => { e.preventDefault(); void salvar(); }} noValidate aria-busy={enviando}>
          <div className={styles.campos}>
            {campo('pixAvista', 'Pix à vista (%)', 'pct')}
            {campo('pixParcelado', 'Pix parcelado (%)', 'pct')}
            {campo('cartao', 'Nome do cartão para o cliente', 'texto')}
          </div>
          <p className={styles.muted}>O limite é {TETO}% por desconto. O cartão não tem desconto automático.</p>
          <div className={styles.acoes}>
            <button type="submit" className={styles.primario} disabled={!campos || enviando}>{enviando ? 'Salvando…' : 'Salvar formas de pagamento'}</button>
            <small>Vale para fechamentos novos. Os já feitos não mudam.</small>
          </div>
          <div aria-live="polite">{aviso && <p className={aviso.tipo === 'ok' ? styles.ok : styles.erro} role={aviso.tipo === 'erro' ? 'alert' : undefined}>{aviso.texto}</p>}</div>
        </form>
      </section>
      <section className={styles.cartao} aria-labelledby="desc-t2">
        <h2 id="desc-t2">2. Como o cliente vê</h2>
        <p className={styles.muted}>Exemplo com uma festa de <b>{numeroParaMoeda(EXEMPLO)}</b>{campos ? '' : ' (com o que está valendo hoje, até corrigir os campos)'}.</p>
        <ul className={styles.formas}>
          <Forma titulo="Pix à vista" sub={rotuloDescontoPix(previa.pixAvistaPercentual)} total={calcularTotalPagamento(EXEMPLO, 'pix_avista', previa).total} />
          <Forma titulo="Pix parcelado" sub={rotuloDescontoPix(previa.pixParceladoPercentual)} total={calcularTotalPagamento(EXEMPLO, 'pix_parcelado', previa).total} />
          <Forma titulo="Cartão" sub={previa.cartaoRotulo} total={calcularTotalPagamento(EXEMPLO, 'cartao_cielo', previa).total} />
        </ul>
      </section>
    </div>
    <SomaDescontos regras={previa} />
    {/* Futura seção "Desconto por dia" (D3): entra aqui, entre a soma e o histórico, nesta mesma página. Não implementada na D1. */}
    <section className={styles.cartao} aria-labelledby="desc-t4">
      <h2 id="desc-t4">4. Histórico</h2>
      {estado.historico.length === 0 ? <p className={styles.muted}>Nenhuma alteração feita por esta tela ainda.</p>
        : <ul className={styles.lista}>{estado.historico.map((h, i) => <li key={`${h.em}-${i}`}>
            <span>{dataHora(h.em)} · {h.por ?? 'Sistema'}</span>
            <span>{h.mudancas.length ? h.mudancas.join(' · ') : 'Salvo sem mudança'}</span>
          </li>)}</ul>}
    </section>
  </>;
}

function Forma({ titulo, sub, total }: { titulo: string; sub: string; total: number }) {
  return <li className={styles.forma}><strong>{titulo}</strong><span>{sub}</span><b>{numeroParaMoeda(total)}</b></li>;
}

/** Ordem fixa: desconto do dia sobre o pacote, depois o da forma de pagamento sobre o total. O dia ainda não existe (D3). */
function SomaDescontos({ regras }: { regras: RegrasPagamento }) {
  const descontoDia = 0;
  const posDia = EXEMPLO - descontoDia;
  const pix = calcularTotalPagamento(posDia, 'pix_avista', regras);
  return <section className={styles.cartao} aria-labelledby="desc-t3">
    <h2 id="desc-t3">3. Como os descontos se somam</h2>
    <p className={styles.muted}>Primeiro entra o desconto do dia da semana sobre o pacote. Depois, o desconto da forma de pagamento sobre o total. O cliente vê cada linha separada. Exemplo com Pix à vista:</p>
    <ul className={styles.lista}>
      <li><span>Pacote</span><span>{numeroParaMoeda(EXEMPLO)}</span></li>
      <li><span>Desconto do dia da semana <small>(ainda não configurável)</small></span><span>{numeroParaMoeda(0)}</span></li>
      <li><span>Total da festa</span><span>{numeroParaMoeda(posDia)}</span></li>
      <li><span>Desconto do Pix à vista ({regras.pixAvistaPercentual}% sobre o total)</span><span>− {numeroParaMoeda(pix.valorDesconto)}</span></li>
      <li className={styles.total}><span>Cliente paga</span><span>{numeroParaMoeda(pix.total)}</span></li>
    </ul>
  </section>;
}
