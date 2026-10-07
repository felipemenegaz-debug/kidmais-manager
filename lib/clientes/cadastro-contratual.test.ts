import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPOS_CADASTRO, CAMPOS_ENDERECO, CAMPOS_IDENTIFICACAO, CAMPOS_OBRIGATORIOS, cadastroContratualSchema, contratanteSnapshot,
  enderecoDoCadastro, formularioCadastro, type CadastroContratual,
} from './cadastro-contratual.ts';

/** Cadastro contratual da conferência histórica: nome, CPF e contato obrigatórios; e-mail e endereço opcionais (endereço completo ou vazio). */
const minimo = (): CadastroContratual => formularioCadastro({ nomeCompleto: 'Ana Souza', cpf: '529.982.247-25', whatsapp: '(11) 99999-0000' });
const endereco = { cep: '01001-000', logradouro: 'Rua Teste', numero: '1', complemento: '', bairro: 'Centro', cidade: 'São Paulo', uf: 'sp' };
const caminhos = (c: object) => { const r = cadastroContratualSchema.safeParse(c); return r.success ? [] : r.error.issues.map(i => i.path.join('.')); };

test('a tela exibe identificação/contato e endereço; o telefone fixo fica fora da tela mas dentro do cadastro', () => {
  const exibidos = [...CAMPOS_IDENTIFICACAO, ...CAMPOS_ENDERECO];
  assert.deepEqual([...exibidos, 'telefone'].sort(), Object.keys(CAMPOS_CADASTRO).sort());
  assert.ok(!exibidos.includes('telefone' as never));
  assert.deepEqual([...CAMPOS_OBRIGATORIOS], ['nomeCompleto', 'cpf', 'whatsapp']);
  assert.equal(formularioCadastro({ telefone: '1133334444' }).telefone, '1133334444', 'telefone do CRM preservado no formulário');
});

test('mínimo aceito: nome, CPF e WhatsApp; e-mail e endereço vazios', () => {
  const r = cadastroContratualSchema.parse(minimo());
  assert.equal(r.cpf, '52998224725');
  assert.equal(r.whatsapp, '11999990000');
  assert.equal(r.email, '');
  assert.equal(r.cep, '');
});

test('contato: WhatsApp ou telefone já cadastrado; sem nenhum, recusa apontando o WhatsApp', () => {
  assert.deepEqual(caminhos({ ...minimo(), whatsapp: '', telefone: '1133334444' }), [], 'telefone do CRM conta como contato');
  assert.deepEqual(caminhos({ ...minimo(), whatsapp: '' }), ['whatsapp']);
  assert.deepEqual(caminhos({ ...minimo(), whatsapp: '123' }), ['whatsapp'], 'WhatsApp curto é inválido');
});

test('CPF e nome continuam obrigatórios; chave desconhecida é recusada (strict)', () => {
  assert.deepEqual(caminhos({ ...minimo(), cpf: '' }), ['cpf']);
  assert.deepEqual(caminhos({ ...minimo(), cpf: '11111111111' }), ['cpf']);
  assert.deepEqual(caminhos({ ...minimo(), nomeCompleto: 'Al' }), ['nomeCompleto']);
  assert.ok(caminhos({ ...minimo(), extra: 'x' }).length > 0);
});

test('e-mail opcional, mas válido e normalizado quando informado', () => {
  assert.equal(cadastroContratualSchema.parse({ ...minimo(), email: ' Ana@Example.com ' }).email, 'ana@example.com');
  assert.deepEqual(caminhos({ ...minimo(), email: 'ana@' }), ['email']);
});

test('endereço: completo (CEP opcional) ou vazio; parcial é recusado', () => {
  assert.deepEqual(caminhos({ ...minimo(), ...endereco }), []);
  const semCep = cadastroContratualSchema.parse({ ...minimo(), ...endereco, cep: '' });
  assert.equal(semCep.uf, 'SP');
  assert.equal(semCep.cep, '');
  assert.deepEqual(caminhos({ ...minimo(), cidade: 'Brasília' }), ['logradouro'], 'só a cidade: pede o restante ou deixar em branco');
  assert.deepEqual(caminhos({ ...minimo(), ...endereco, uf: 'Bras' }), ['uf']);
  assert.deepEqual(caminhos({ ...minimo(), ...endereco, cep: '123' }), ['cep']);
});

test('snapshot do contratante: e-mail e endereço vazios viram null; endereço completo mantém os campos e CEP nulo quando ausente', () => {
  const vazio = contratanteSnapshot({ ...minimo(), id: 'c1' });
  assert.equal(vazio.email, null);
  assert.equal(vazio.endereco, null);
  assert.equal(vazio.telefone, null);
  assert.equal(vazio.whatsapp, '(11) 99999-0000');
  const completo = contratanteSnapshot({ ...minimo(), ...endereco, cep: '', email: 'ana@example.com', id: 'c1' });
  assert.deepEqual(completo.endereco, { cep: null, logradouro: 'Rua Teste', numero: '1', complemento: null, bairro: 'Centro', cidade: 'São Paulo', uf: 'sp' });
  assert.equal(completo.email, 'ana@example.com');
  assert.equal(enderecoDoCadastro({ ...formularioCadastro(), complemento: 'Bloco A' })?.logradouro, '', 'informado (ainda que parcial) nunca vira null: o schema é quem recusa');
});

test('payload sem a chave telefone é aceito; o telefone do CRM entra pelo cadastro mesclado e conta como contato', () => {
  const { telefone: _t, ...semTelefone } = minimo();
  void _t;
  assert.deepEqual(caminhos(semTelefone), [], 'telefone é opcional no payload');
  assert.deepEqual(caminhos({ ...semTelefone, whatsapp: '' }), ['whatsapp'], 'sem WhatsApp e sem telefone no payload: recusa');
  // Servidor: mescla o CRM (telefone já gravado) com o payload (sem telefone) antes de validar.
  const mesclado = formularioCadastro({ ...{ telefone: '1133334444', nomeCompleto: 'Ana Souza', cpf: '52998224725' }, ...{ ...semTelefone, whatsapp: '' } });
  assert.equal(mesclado.telefone, '1133334444');
  assert.deepEqual(caminhos(mesclado), []);
});

test('schema do payload (rota HTTP) não decide o contato: isso fica para o cadastro mesclado com o CRM', async () => {
  const { cadastroPayloadSchema } = await import('./cadastro-contratual.ts');
  const { telefone: _t, ...semTelefone } = minimo();
  void _t;
  assert.equal(cadastroPayloadSchema.safeParse({ ...semTelefone, whatsapp: '' }).success, true, 'payload sem contato passa na rota; o servidor valida o mesclado');
  assert.equal(cadastroPayloadSchema.safeParse({ ...semTelefone, cpf: '' }).success, false, 'CPF continua obrigatório já no payload');
  assert.equal(cadastroPayloadSchema.safeParse({ ...semTelefone, cidade: 'Brasília' }).success, false, 'endereço parcial recusado já no payload');
  assert.equal(cadastroContratualSchema.safeParse({ ...semTelefone, whatsapp: '' }).success, false, 'cadastro completo sem contato: recusa');
});
