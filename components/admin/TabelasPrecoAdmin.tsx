'use client';

import { useState, type FormEvent } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './admin.module.css';

export default function TabelasPrecoAdmin() {
  const [empresaId, setEmpresaId] = useState('');
  const [tabelaId, setTabelaId] = useState('');
  const [valor, setValor] = useState('');
  const [sobConsulta, setSobConsulta] = useState(false);
  const [resultado, setResultado] = useState('');
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);

  async function enviar(event: FormEvent, corpo: Record<string, unknown>) {
    event.preventDefault();
    setCarregando(true);
    setErro('');
    setResultado('');
    try {
      const response = await adminFetch('/api/admin/configuracoes/tabelas-preco', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      const body = await response.json();
      if (!response.ok || body.ok === false) throw new Error(body.erro || 'Não foi possível concluir.');
      if (body.data?.tipo) setResultado(body.data.tipo === 'PRECO' ? `${body.data.centavos} centavos` : body.data.tipo);
      else setResultado(body.data ? `Tabela ${body.data}` : 'Publicação registrada. Fechamentos antigos não foram recalculados.');
      if (typeof body.data === 'string') setTabelaId(body.data);
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao salvar.');
    } finally {
      setCarregando(false);
    }
  }

  return (
    <main className={styles.page}>
      <h1>Tabelas de preços</h1>
      <p>Uma tabela nova guarda o preço futuro. O PDF de pacotes continua separado e não bloqueia esta publicação.</p>
      <p role="alert">{erro}</p>
      <p role="status">{resultado}</p>
      <form onSubmit={(event) => void enviar(event, { acao: 'simular', valor: valor.trim() ? valor.trim() : null, sobConsulta })}>
        <label htmlFor="valor">Valor em reais<input id="valor" value={valor} onChange={(event) => setValor(event.target.value)} placeholder="10.50" /></label>
        <label htmlFor="consulta"><input id="consulta" type="checkbox" checked={sobConsulta} onChange={(event) => setSobConsulta(event.target.checked)} />Sob consulta</label>
        <button type="submit" disabled={carregando}>Simular</button>
      </form>
      <form onSubmit={(event) => void enviar(event, {
        acao: 'criar', empresaId, codigo: 'TABELA_NOVA', nome: 'Tabela nova', vigenciaInicio: '2026-10-01', vigenciaFim: null,
      })}>
        <label htmlFor="empresa">Empresa<input id="empresa" value={empresaId} onChange={(event) => setEmpresaId(event.target.value)} required /></label>
        <button type="submit" disabled={carregando}>Criar vigência</button>
      </form>
      <form onSubmit={(event) => { if (window.confirm('Publicar esta tabela? Fechamentos já gravados não serão recalculados.')) void enviar(event, { acao: 'publicar', empresaId, tabelaId }); else event.preventDefault(); }}>
        <label htmlFor="tabela">Tabela<input id="tabela" value={tabelaId} onChange={(event) => setTabelaId(event.target.value)} required /></label>
        <button type="submit" disabled={carregando}>Publicar</button>
      </form>
    </main>
  );
}
