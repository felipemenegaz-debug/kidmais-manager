# Pix copia e cola das parcelas das festas (etapa 1)

Etapa 1 da proposta de pagamentos das festas para as empresas contratantes: o dinheiro do cliente do buffet vai
**direto para a conta do buffet**; a Kidmais não recebe, não repassa e não confirma pagamentos.

## O que foi feito

- **Chave Pix da empresa** — Configurações → **Recebimento por Pix** (`components/admin/PixRecebimento.tsx`,
  `app/api/admin/configuracoes/pix`). Tipos: CNPJ, CPF, e-mail, celular e chave aleatória, normalizados no formato do
  DICT. Nome (até 25) e cidade (até 15) do recebedor sem acentos, como exige o BR Code.
  - Só a **Gestão desta empresa** altera ou remove, com **senha** (reautenticação de até 5 min, mesma regra do Perfil),
    controle de versão (409 se outra pessoa mudou antes) e auditoria `PIX_RECEBIMENTO_CONFIGURADO` /
    `PIX_RECEBIMENTO_REMOVIDO` com a chave **mascarada**.
  - A chave fica ligada à **empresa comprovada da sessão** (`empresa_pix_recebimento.empresa_id`), sem depender da
    associação heurística entre Perfil e empresa.
- **Pix da parcela** — botão **Pix** em Financeiro → Contas a receber e no Financeiro da Festa
  (`components/admin/PixParcela.tsx`, `GET /api/admin/financeiro/contas-receber/{parcelaId}/pix`).
  - Valor = saldo em aberto da parcela, o mesmo da lista de contas a receber (`listarRecebiveis`).
  - BR Code estático (`lib/pagamentos/pix/brcode.ts`): EMV com CRC16, txid `KM…` derivado da parcela para o buffet
    reconhecer no extrato. QR em SVG gerado no servidor e exibido como imagem.
  - Só parcelas de contrato com saldo; entrada avulsa, parcela paga, cancelada ou de outra empresa não geram Pix.
  - **A baixa continua manual**: o buffet confere o extrato e registra o recebimento como hoje.

## Migration 066 (NÃO APLICADA)

`database/migrations/20261006_066_pix_recebimento_empresa.sql` cria `empresa_pix_recebimento` (uma linha por empresa,
CHECK de formato por tipo de chave). Rollback recusa enquanto houver chave cadastrada. Prechecks, postchecks e o
inventário dos verificadores (`scripts/production/*`) foram atualizados. O número 065 está reservado pelo branch
`whatsapp/atendimento-ia-v1`.

Sem a 066 aplicada, a tela de configuração informa que o recurso não está disponível e o Pix da parcela responde 503;
nada mais muda.

## Dependência nova

`qrcode-generator` 2.0.4 (MIT, sem dependências, tipos incluídos), usada só no servidor para o SVG do QR.

## Validação

- `lib/pagamentos/pix/brcode.test.ts`: reproduz o exemplo oficial do Manual de Padrões para Iniciação do Pix do BCB
  (CRC `1D3D`), vetor do CRC16, limites, txid, chaves por tipo e máscara.
- `lib/pagamentos/pix/pix.postgres.test.ts` (PostgreSQL descartável, modelo `atual` + 066): pre/postcheck, CHECKs do
  banco, Equipe recusada, reautenticação vencida recusada, versão, auditoria mascarada, isolamento entre empresas
  (parcela e chave), valor do saldo no QR, parcela cancelada sem Pix, rollback recusado com dados — **6/6**.
- `lib/pagamentos/pix/pix-ui.test.ts` e `components/admin/contas-receber-contato.test.ts`: rotas, telas e botão Pix só na
  parcela de contrato.
- `npm run check:v1:static`: testes, lint, TypeScript e build aprovados (06/10/2026).
- **Não verificado**: leitura do QR por aplicativos de banco reais. Antes de liberar aos clientes, fazer um Pix de
  baixo valor para a chave da empresa em staging.

## Próxima etapa

"Conectar sua conta Asaas" por empresa (cobrança automática e baixa pelo aviso de pagamento), depois da integração
Asaas da assinatura (E8), reaproveitando o mesmo adaptador.
