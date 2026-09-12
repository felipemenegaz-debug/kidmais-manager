# Correção — preços PADRÃO/NOBRE no Fechamento

Corrige a prévia comercial do Fechamento para usar as duas matrizes persistidas nas migrations 006/006a:

- PADRÃO: combinações regulares;
- NOBRE: sábado TURNO_2 e domingo TURNO_1.

O problema observado era a UI usar uma tabela de referência antiga/híbrida. Em Festa Completa com 50 convidados, por exemplo, a UI podia enviar R$ 8.990 em um horário NOBRE cujo PricingService calculava R$ 9.290. O backend então classificava corretamente a diferença como negociação e criava `AGUARDANDO_APROVACAO`.

Arquivos alterados:
- `components/fechamento/data.ts`
- `components/fechamento/calculos.ts`
- `components/fechamento/FechamentoWizard.tsx`

Não há migration e não há alteração de dados existentes.
