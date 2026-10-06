'use client';
import { useCallback, useEffect, useState } from 'react';
import { adminFetch, reautenticarSessao } from '@/lib/http/admin-fetch';
import { AdminIcon } from './AdminIcon';
import styles from './perfil-empresa.module.css';

type Tipo = 'CPF' | 'CNPJ' | 'EMAIL' | 'TELEFONE' | 'ALEATORIA';
type Configuracao = { tipoChave: Tipo; chaveMascarada: string; nomeRecebedor: string; cidadeRecebedor: string; versao: number; atualizadoEm: string };
type Dados = { instalado: boolean; configuracao: Configuracao | null; podeEditar: boolean; sugestao: { nomeRecebedor: string } | null };

const TIPOS: Array<[Tipo, string, string]> = [
  ['CNPJ', 'CNPJ', '00.000.000/0000-00'],
  ['CPF', 'CPF', '000.000.000-00'],
  ['EMAIL', 'E-mail', 'financeiro@empresa.com.br'],
  ['TELEFONE', 'Celular', '(11) 99999-0000'],
  ['ALEATORIA', 'Chave aleatória', '123e4567-e89b-12d3-a456-426614174000'],
];

/**
 * Chave Pix DA PRÓPRIA EMPRESA (066) usada no Pix copia e cola / QR das parcelas das festas. O dinheiro cai direto
 * na conta da empresa; a Kidmais não recebe nem repassa. Alterar ou remover pede a senha (reautenticação).
 */
async function buscar(): Promise<{ dados: Dados } | { erro: string }> {
  try {
    const resposta = await adminFetch('/api/admin/configuracoes/pix');
    const corpo = await resposta.json();
    return corpo.ok ? { dados: corpo.data as Dados } : { erro: corpo.erro ?? 'Não foi possível carregar.' };
  } catch {
    return { erro: 'Não foi possível carregar. Verifique a conexão e tente novamente.' };
  }
}

export default function PixRecebimento() {
  const [dados, setDados] = useState<Dados | null>(null);
  const [erro, setErro] = useState('');
  const [sucesso, setSucesso] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [tipo, setTipo] = useState<Tipo>('CNPJ');
  const [chave, setChave] = useState('');
  const [nome, setNome] = useState('');
  const [cidade, setCidade] = useState('');
  const [senha, setSenha] = useState('');

  const aplicar = useCallback((r: { dados: Dados } | { erro: string }) => {
    if ('erro' in r) { setErro(r.erro); return; }
    const d = r.dados;
    setDados(d);
    setTipo(d.configuracao?.tipoChave ?? 'CNPJ');
    setChave('');
    setNome(d.configuracao?.nomeRecebedor ?? d.sugestao?.nomeRecebedor ?? '');
    setCidade(d.configuracao?.cidadeRecebedor ?? '');
  }, []);

  useEffect(() => {
    let ativo = true;
    void buscar().then((r) => { if (ativo) aplicar(r); });
    return () => { ativo = false; };
  }, [aplicar]);

  async function enviar(corpo: Record<string, unknown>, mensagem: string) {
    setOcupado(true); setErro(''); setSucesso('');
    try {
      const auth = await reautenticarSessao(senha);
      if (!auth.ok) { setErro(auth.senhaIncorreta ? 'Senha incorreta. Nada foi alterado.' : auth.erro); return; }
      const resposta = await adminFetch('/api/admin/configuracoes/pix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      const json = await resposta.json();
      if (!json.ok) { setErro(json.erro ?? 'Não foi possível salvar. Nada foi alterado.'); return; }
      setSenha('');
      setSucesso(mensagem);
      aplicar(await buscar());
    } catch {
      setErro('Não foi possível confirmar a operação. Atualize a página e confira antes de repetir.');
    } finally {
      setOcupado(false);
    }
  }

  const atual = dados?.configuracao ?? null;
  const podeEditar = Boolean(dados?.instalado && dados.podeEditar);
  const placeholder = TIPOS.find(([t]) => t === tipo)?.[2] ?? '';

  return <main className={styles.page} aria-busy={ocupado || !dados}>
    <header className={styles.header}><div className={styles.heading}><h1>Recebimento por Pix</h1></div></header>
    {!dados && !erro && <p className={styles.estado} role="status">Carregando.</p>}
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {sucesso && <p className={styles.sucesso} role="status">{sucesso}</p>}
    {dados && !dados.instalado && <p className={styles.estado}>O recebimento por Pix ainda não está disponível neste ambiente.</p>}
    {dados?.instalado && <>
      <section className={styles.card}>
        <h2 className={styles.titulo}><AdminIcon name="contact" size={12} />Como funciona</h2>
        <p className={styles.nota}>Cada parcela em aberto ganha um Pix copia e cola e um QR Code com o valor do saldo. O pagamento cai direto na conta da empresa, pela chave abaixo — a Kidmais não recebe nem repassa valores. O sistema não confirma o pagamento: confira o extrato e registre o recebimento.</p>
        {atual
          ? <p>Chave atual: <strong>{TIPOS.find(([t]) => t === atual.tipoChave)?.[1]} {atual.chaveMascarada}</strong> · recebedor <strong>{atual.nomeRecebedor}</strong> ({atual.cidadeRecebedor})</p>
          : <p>Nenhuma chave cadastrada. Sem ela, o botão Pix das parcelas avisa que falta configurar.</p>}
      </section>
      {!dados.podeEditar && <p className={styles.estado}>Somente a Gestão desta empresa altera a chave Pix.</p>}
      <fieldset className={styles.card} disabled={!podeEditar || ocupado}>
        <h2 className={styles.titulo}><AdminIcon name="contact" size={12} />{atual ? 'Trocar a chave' : 'Cadastrar a chave'}</h2>
        <div className={styles.grade}>
          <label className={styles.campo}>Tipo de chave<select aria-label="Tipo de chave" value={tipo} onChange={(e) => setTipo(e.target.value as Tipo)}>{TIPOS.map(([t, rotulo]) => <option key={t} value={t}>{rotulo}</option>)}</select></label>
          <label className={styles.campo}>Chave Pix<input aria-label="Chave Pix" placeholder={placeholder} value={chave} onChange={(e) => setChave(e.target.value)} autoComplete="off" /></label>
          <label className={styles.campo}>Nome do recebedor<input aria-label="Nome do recebedor" maxLength={60} value={nome} onChange={(e) => setNome(e.target.value)} /><small>Como aparece no banco; até 25 letras, sem acentos.</small></label>
          <label className={styles.campo}>Cidade do recebedor<input aria-label="Cidade do recebedor" maxLength={60} value={cidade} onChange={(e) => setCidade(e.target.value)} /><small>Até 15 letras.</small></label>
          <label className={styles.campo}>Sua senha<input aria-label="Sua senha" type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} /><small>A chave define para onde vai o dinheiro dos clientes; por isso pedimos a senha.</small></label>
        </div>
        <p className={styles.nota}>Use uma chave da conta da empresa. Confira com um Pix de teste de baixo valor antes de enviar aos clientes.</p>
        <div className={styles.acoes}>
          {atual && <button type="button" className={styles.secundario} disabled={!senha} onClick={() => void enviar({ acao: 'remover', versao: atual.versao, confirmar: true }, 'Chave removida. As parcelas deixam de mostrar o Pix até uma nova chave ser cadastrada.')}>Remover chave</button>}
          <button type="button" className={styles.primario} disabled={!chave.trim() || !nome.trim() || !cidade.trim() || !senha} onClick={() => void enviar({ acao: 'salvar', tipoChave: tipo, chave, nomeRecebedor: nome, cidadeRecebedor: cidade, versao: atual?.versao ?? null }, 'Chave Pix salva. Os próximos Pix das parcelas já usam esta chave.')}>{ocupado ? 'Salvando…' : 'Confirmar senha e salvar'}</button>
        </div>
      </fieldset>
    </>}
    <p><a href="/admin/configuracoes">Voltar às configurações</a></p>
  </main>;
}
