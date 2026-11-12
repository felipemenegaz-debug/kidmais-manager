# B-9: alertas de fixture de homologação desativada fora do código 2 (27/10/2026)

**Estado: APROVADO pela revisão independente (27/10/2026), sem achados.** PR para staging; sem merge, deploy, credenciais no cron ou `simular`. O cron da renovação continua em `aguardando`.

**Origem:**
- Antes de pôr o cron em `simular` (passo 4), Felipe pediu a lista dos alertas da simulação global.
- A leitura, feita no Shell do web de staging em `d8306f30`, deu código 2, com 8 empresas processadas e **um único alerta**:
  - empresa `hml-pr-essencial`, "TESTE Kidmais — pagamento e renovação staging 20261010 r3 F1";
  - é uma fixture de homologação de 10/10, **desativada**;
  - o registro dela está em `REVISAO` por janela de aviso perdida desde 20/10.
- Pelo desenho do B-9, `REVISAO_EXISTENTE` é sempre alerta, então o cron sairia com código 2 a cada hora.
- Felipe escolheu a opção A em 27/10.

## O que muda

- **`scripts/assinatura-renovacao-cron.cjs`:** `separarAlertasInformativos(relatorio, linhas, ehFixture)`, aplicada por `executarCron` depois de `executarAgendada`.
  - Lê `id, codigo, nome, status` das empresas dos alertas (`SELECT … FROM empresas WHERE id = ANY($1)`), só quando há alertas.
  - **Alerta informativo:** empresa com `status = 'DESATIVADA'` **e** `ehFixtureHomologacao` (código `hml-` **e** nome "TESTE "), a mesma regra única do resto do B-9. Vai para `alertasInformativos` e continua no relatório.
  - **Continuam contando:** empresa real (desativada ou não), fixture ativa, empresa só com o código de fixture e empresa sem cadastro lido.
  - **Código:** só rebaixa **2 → 0** quando a execução é `CONCLUIDA` e **todos** os alertas são informativos. O 1 (interrupção) e as execuções não concluídas não mudam, e o código nunca sobe.
  - Relatório sem alertas: `alertasInformativos: []`.
- **Por que no código da entrada:** o painel do desenvolvedor já trata essa fixture como informativa (severidade `INFO` em `alertasRenovacao`). A entrada passa a ter a mesma leitura, sem esconder o registro.

## Validação local

- **Testes:**
  - `scripts/assinatura-renovacao-cron.test.cjs`: 2 novos, 18/18. Cobrem:
    - informativa só com fixture desativada;
    - mistura com uma real continua 2;
    - fixture ativa, real desativada, só o código e sem cadastro continuam contando;
    - 1 e execução não concluída não mudam;
    - o código nunca sobe;
    - verificação estática de que `executarCron` aplica a regra.
  - `lib/assinatura/renovacao-agendada.postgres.test.ts`: caso 9b, com banco real:
    - fixture desativada em `REVISAO` dá código 0, sem alertas e com o informativo;
    - junto de uma real em `REVISAO`, dá código 2, com a real nos alertas e a fixture nos informativos;
    - fixture ativa em `REVISAO` dá código 2.
    - O helper `empresa` aceita criar a fixture com o código e o nome desde o início, porque a migration 063 deixa a identidade imutável.
- **Mutantes** em cópia isolada: 9/9 detectados (A1–A9); o controle A0 sobreviveu.
- **PostgreSQL descartável:** `renovacao-agendada` 11/11.
- **CI local completo:** registrado no manifesto da entrega.

## Limites

- O alerta da fixture continua aparecendo no relatório e no painel do desenvolvedor. A empresa e o registro em `REVISAO` não são alterados.
- A prova em staging é a primeira execução `simular` do cron, no passo 4, que exige autorização própria.
