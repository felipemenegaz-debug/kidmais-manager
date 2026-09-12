# Kidmais Manager — Ajustes finais de Identidade / CRM no Fechamento

## 1. Endereço automático por CEP
- Nova rota `POST /api/endereco/consultar-cep`.
- Consulta ViaCEP no backend.
- Ao completar 8 dígitos no campo CEP, o frontend busca e preenche:
  - logradouro;
  - bairro;
  - cidade;
  - UF.
- Número e complemento continuam manuais.
- Se o CEP não for localizado ou o serviço estiver indisponível, o fechamento não é bloqueado: o endereço pode ser preenchido manualmente.
- Funciona tanto para Cliente novo quanto para edição explícita de Cliente existente.

## 2. Recuperação cadastral
- Quando o cliente declara não ter acesso aos contatos antigos:
  - o fechamento online fica explicitamente pausado;
  - o botão global `Continuar` deixa de aparecer nessa etapa;
  - é exibido botão para falar com a Kidmais no WhatsApp;
  - nenhum dado antigo é revelado e nenhum Cliente novo é criado.

## Validação
```powershell
npx.cmd tsc -p tsconfig.json --noEmit
```

Teste direto da API de CEP, com o servidor rodando:
```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/api/endereco/consultar-cep" `
  -ContentType "application/json" `
  -Body '{"cep":"01001000"}'
```
