# Kidmais Manager — CEP automático no CRM

Extrair na raiz de `kidmais-manager`.

## Alteração
O mesmo preenchimento automático por CEP já usado no Fechamento público passa a funcionar também em:

- CRM > Novo cliente
- CRM > Editar cliente

Ao informar 8 dígitos:
- consulta `/api/endereco/consultar-cep`;
- preenche Logradouro, Bairro, Cidade e UF;
- Número e Complemento continuam manuais;
- em erro/CEP não encontrado, o endereço pode ser preenchido manualmente;
- o botão Salvar fica temporariamente bloqueado enquanto a consulta está em andamento.

Nenhuma migration é necessária.

## Validação
```powershell
npx.cmd tsc -p tsconfig.json --noEmit
```
