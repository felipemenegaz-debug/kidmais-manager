'use client';
import {
  CAMPOS_CADASTRO, CAMPOS_ENDERECO, CAMPOS_ENDERECO_EXIGIDOS, CAMPOS_IDENTIFICACAO, CAMPOS_OBRIGATORIOS, enderecoInformado, type CadastroContratual,
} from '@/lib/clientes/cadastro-contratual';
import ui from './importacao/integracao.module.css';

type Campo = keyof CadastroContratual;
const TIPO: Partial<Record<Campo, string>> = { email: 'email', whatsapp: 'tel' };
const NUMERICO: ReadonlyArray<Campo> = ['cpf', 'whatsapp', 'cep'];
const AUTOCOMPLETE: Partial<Record<Campo, string>> = {
  nomeCompleto: 'name', whatsapp: 'tel', email: 'email', cep: 'postal-code', logradouro: 'address-line1', complemento: 'address-line2',
  cidade: 'address-level2', uf: 'address-level1',
};
const DICA: Partial<Record<Campo, string>> = {
  whatsapp: 'Com DDD. É o contato usado nas confirmações do contrato.',
  uf: 'Duas letras, ex.: DF.',
};
const inclui = (lista: ReadonlyArray<Campo>, k: Campo) => lista.includes(k);

/**
 * Dados do contratante na conferência de contrato histórico. Mesmas classes dos demais campos do assistente
 * (integracao.module.css). O telefone fixo não aparece: confundia com o WhatsApp e o valor já cadastrado é preservado.
 * `invalidos` traz a mensagem por campo (do schema) para marcar o input e ligar a descrição acessível.
 */
export default function CamposCadastroContratual({ value, onChange, cpfProtegido = false, invalidos = {} }: {
  value: CadastroContratual; onChange(value: CadastroContratual): void; cpfProtegido?: boolean;
  invalidos?: Partial<Record<Campo, string>>;
}) {
  // Endereço: o bloco inteiro é opcional, mas, informado qualquer campo, logradouro/número/bairro/cidade/UF passam a ser exigidos.
  const comEndereco = enderecoInformado(value);
  const opcional = (k: Campo) => inclui(CAMPOS_OBRIGATORIOS, k) ? false : inclui(CAMPOS_ENDERECO_EXIGIDOS, k) ? !comEndereco : true;
  const campo = (k: Campo) => {
    const erro = invalidos[k];
    const dica = k === 'cpf' && cpfProtegido ? 'CPF já cadastrado no cliente; não pode ser substituído aqui.' : DICA[k];
    const descricaoId = erro || dica ? `cadastro-${k}-descricao` : undefined;
    return <label key={k} className={ui.campo}>
      <span>{CAMPOS_CADASTRO[k]}{opcional(k) ? ' (opcional)' : ''}</span>
      <input type={TIPO[k] ?? 'text'} inputMode={inclui(NUMERICO, k) ? 'numeric' : undefined} autoComplete={AUTOCOMPLETE[k]}
        maxLength={k === 'uf' ? 2 : 200} value={value[k]} disabled={k === 'cpf' && cpfProtegido}
        aria-invalid={erro ? true : undefined} aria-describedby={descricaoId}
        onChange={e => onChange({ ...value, [k]: e.target.value })} />
      {(erro || dica) && <small id={descricaoId} className={erro ? ui.campoErro : undefined}>{erro ?? dica}</small>}
    </label>;
  };
  return <fieldset className={ui.grupo}>
    <legend>Dados do contratante</legend>
    <p className={ui.ajuda}>Confira nome, CPF e WhatsApp. E-mail e endereço são opcionais; se informar o endereço, complete-o. Ao concluir, estes dados também são salvos no cadastro do cliente.</p>
    <p className={ui.subtitulo}>Identificação e contato</p>
    <div className={ui.grade}>{CAMPOS_IDENTIFICACAO.map(campo)}</div>
    <p className={ui.subtitulo}>Endereço <span>{comEndereco ? 'complete os campos marcados' : 'opcional'}</span></p>
    <div className={ui.grade}>{CAMPOS_ENDERECO.map(campo)}</div>
  </fieldset>;
}
