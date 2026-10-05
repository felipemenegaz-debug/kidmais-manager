'use client';
import { CAMPOS_CADASTRO, type CadastroContratual } from '@/lib/clientes/cadastro-contratual';

export default function CamposCadastroContratual({ value, onChange, cpfProtegido = false }: {
  value: CadastroContratual; onChange(value: CadastroContratual): void; cpfProtegido?: boolean;
}) {
  return <fieldset><legend>Dados do contratante</legend>
    <p>Confira CPF, contato, e-mail e endereço. Ao concluir, estes dados também serão salvos no cadastro do cliente.</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
      {(Object.keys(CAMPOS_CADASTRO) as Array<keyof CadastroContratual>).map(k => <label key={k}>{CAMPOS_CADASTRO[k]}
        <input style={{ display: 'block', width: '100%' }} maxLength={200} type={k === 'email' ? 'email' : 'text'} value={value[k]}
          disabled={k === 'cpf' && cpfProtegido} onChange={e => onChange({ ...value, [k]: e.target.value })} />
      </label>)}
    </div>
  </fieldset>;
}
