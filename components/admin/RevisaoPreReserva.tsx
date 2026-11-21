'use client';

import { useState, type FormEvent } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { formatarMoeda } from '@/lib/contratos/documento/formatters';
import { corpoSinal, formatarInstanteSP, rotuloDestino, rotuloMotivo, type AcaoSinal, type RevisaoPreReserva as Dados } from '@/lib/pre-reserva/apresentacao-admin';
import styles from './RevisaoComercial.module.css';

export function RevisaoPreReserva({ dados, fechamentoId, atualizar }: {
  dados: Dados; fechamentoId: string; atualizar: () => Promise<Dados | undefined>;
}) {
  const [valor, setValor] = useState('');
  const [referencia, setReferencia] = useState('');
  const [divergente, setDivergente] = useState<ReturnType<typeof corpoSinal> | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [desatualizada, setDesatualizada] = useState(false);
  const [erro, setErro] = useState('');
  const [mensagem, setMensagem] = useState('');

  async function enviar(acao: AcaoSinal) {
    if (ocupado || desatualizada || (acao !== 'CONFIRMAR' && !divergente)) return;
    setOcupado(true);
    setErro('');
    setMensagem('');
    setDivergente(null);
    try {
      const corpo = acao === 'CONFIRMAR'
        ? corpoSinal(dados.sequencia, referencia, valor, acao)
        : { ...divergente!, acao };
      const resposta = await adminFetch(`/api/admin/fechamentos/${encodeURIComponent(fechamentoId)}/confirmar-sinal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
      });
      const json = await resposta.json();
      if (!resposta.ok) {
        const aviso = json.erro ?? 'Confira o valor e o identificador da transferência no extrato.';
        if (resposta.status === 409) {
          try {
            const atual = await atualizar();
            if (json.codigo === 'PIX_VALOR_DIVERGENTE' && atual?.sequencia === corpo.aceiteSequencia &&
                atual.sinalCentavos === dados.sinalCentavos && atual.sinalCentavos !== corpo.valorCentavos) {
              setDivergente(corpo);
            }
          } catch {
            setDesatualizada(true);
            throw new Error(`${aviso} Atualize a página para conferir o pedido.`);
          }
        }
        throw new Error(aviso);
      }
      setMensagem(json.data.motivo
        ? `Recebimento Pix identificado. ${rotuloMotivo(json.data.motivo)}.`
        : 'Sinal registrado.');
      setValor('');
      setReferencia('');
      try { await atualizar(); }
      catch {
        setDesatualizada(true);
        throw new Error('Atualize a página para conferir a situação do pedido.');
      }
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível registrar o sinal.');
    } finally {
      setOcupado(false);
    }
  }

  function confirmar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    void enviar('CONFIRMAR');
  }

  return <section className={styles.card} style={{ overflowWrap: 'anywhere' }}>
    <h2>Pré-reserva</h2>
    <dl>
      <dt><strong>Aceite</strong></dt>
      <dd>Aceito em {formatarInstanteSP(dados.aceitoEm)}. Sinal esperado de {formatarMoeda(dados.sinalCentavos / 100)}.</dd>
      <dd>Festa de {formatarInstanteSP(dados.inicio)} a {formatarInstanteSP(dados.fim)} (São Paulo).</dd>
      <dd>Unidade {dados.unidade ?? 'não informada'} · Salão {dados.salao ?? 'não informado'}</dd>
      <dt><strong>Garantia</strong></dt>
      <dd>{dados.garantiaAte
        ? dados.garantia === 'ATIVA'
          ? `Pré-reserva garantida até ${formatarInstanteSP(dados.garantiaAte)} (São Paulo).`
          : `${rotuloMotivo(dados.garantia ?? '')}. Validade registrada até ${formatarInstanteSP(dados.garantiaAte)} (São Paulo).`
        : 'Sem garantia ativa.'}</dd>
      <dt><strong>Destino do dinheiro</strong></dt>
      <dd>Recebedor Pix do aceite: {dados.recebedor}.</dd>
      <dd>{dados.destinos.length ? dados.destinos.map(rotuloDestino).join(' · ') : 'Aguardando confirmação do sinal.'}</dd>
    </dl>
    {erro && <p className={styles.error} role="alert">{erro}</p>}
    {mensagem && <p role="status">{mensagem}</p>}
    <form onSubmit={confirmar}>
      <label>Valor recebido (R$)
        <input inputMode="decimal" value={valor} required disabled={ocupado || desatualizada}
          onChange={(e) => { setValor(e.target.value); setDivergente(null); }} />
      </label>
      <label>Identificador da transferência no extrato (EndToEndId)
        <input value={referencia} required disabled={ocupado || desatualizada}
          onChange={(e) => { setReferencia(e.target.value); setDivergente(null); }} />
      </label>
      <div className={styles.actions}>
        <button type="submit" disabled={ocupado || desatualizada}>Confirmar sinal</button>
        {divergente && divergente.aceiteSequencia === dados.sequencia && <button type="button" disabled={ocupado || desatualizada}
          onClick={() => void enviar('REGISTRAR_DIVERGENTE_A_DEVOLVER')}>Conferi o crédito no extrato. Registrar para devolução</button>}
      </div>
    </form>
  </section>;
}
