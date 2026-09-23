# Catálogo V1 — migrations 021–025

> Atualização 025: bombom extra R$ 4/unidade, Copo R$ 9/unidade e Bola R$ 12/unidade,
> com SKUs próprios; Pizza Party recebe extras precificados mantendo base sob consulta.
> Aplicação somente no clone. Preços, unidades e oferta dos extras foram definidos
> por autorização explícita; veja [regras, lista por pacote e evidências da 025](CATALOGO_V1_025.md).

Estado local em 23/09/2026: migrations 021–025 aplicadas **exclusivamente no clone
sanitizado `kidmais_v1_homologacao`**, PostgreSQL local loopback, porta 5432,
na branch `v1/catalogo-021a`. O postcheck 019 passou com `search_path=public`;
cada migration teve precheck, aplicação e postcheck aprovados, em ordem. A 025 foi
aplicada posteriormente, uma única vez com commit, sem editar ou reaplicar a 024.
Não foram reaplicadas 016–019. Esta execução não aplicou migrations em staging,
produção ou qualquer outro banco e não implantou serviços.

A regressão integrada de serviços/handlers passou em sete grupos. A verificação
posterior no navegador concluiu três fechamentos fictícios e edições administrativas
em desktop/celular, com rollback e preservação dos dez fechamentos anteriores.
As correções de UX e a preservação dos snapshots contratuais foram concluídas e
testadas no clone. O PDF foi visualizado por renderização independente e há links
para abrir/baixar fora do visualizador embutido; este último não foi homologado.
Persistem decisões comerciais descritas abaixo. Ver
[evidências e limites](REGRESSAO_CATALOGO_021_024.md).

## Numeração

A 017 da V1 já é `pocket_sexta`; o clone estava no estado pós-019 antes deste ensaio
e agora contém 021–025. **A ausência da 020 é deliberada**: o número foi reservado
para a Foundation SaaS de outra branch. Ela não faz parte deste PR, não foi aplicada
no clone e não é dependência das migrations 021–025. Não aplicar Foundation apenas
para preencher a numeração; uma futura integração exige revisão própria.

O verificador `scripts/production/check-migrations.mjs` reconhece por nome exato o
baseline 001–019, incluindo 006a, e somente as cinco adições 021–025. Exige todos
os arquivos, prechecks/postchecks de 013–019 e 021–025 e o postcheck de 011;
rejeita duplicações, renomeações, 020, versões futuras
e arquivos inesperados. Apenas o rollback legado conhecido 999 é excluído do
inventário de aplicação. A evidência registra a ausência deliberada da 020 e
mantém `appliedState=unknown`: inventário aprovado não comprova schema remoto nem
autoriza executar migrations. O verificador não é um executor de migrations.

## Escopo desta etapa

- Catálogo de buffet: categorias, itens, regras por pacote e escolhas com nome aplicado no fechamento.
- Adicionais: categorias administráveis relacionadas à coluna legada `adicionais.categoria` e regra pacote × adicional com ausência interpretada como indisponível.
- Cortesia: `precos_adicional.valor` passa a aceitar zero, sem alterar preços existentes.
- PDF informativo: metadados e unicidade de um documento vigente; nenhum arquivo é armazenado ou publicado nesta migration.
- A estrutura 021 não remove colunas `buffet_*` nem reescreve fechamentos históricos.
  As mudanças de preço de 024/025 usam novas tabelas comerciais, preservando as anteriores.

## Implementação concluída e ensaiada no clone

- 022 cadastra as opções de buffet e vínculos iniciais por pacote.
- 023 define inclusão, indisponibilidade e extras pagos por pacote.
- 024 cria uma nova versão da tabela comercial, copiando os preços existentes
  e aplicando taxa de rolha de R$ 190 (1–79) e R$ 290 (80–150). A vigência
  começa em `CURRENT_DATE` do banco no momento da aplicação; revisar o fuso e
  as tabelas ativas no precheck. Fechamentos antigos retêm seus snapshots.
- 025 cria outra tabela comercial: bombom extra R$ 4/unidade, sem lote mínimo;
  Copo R$ 9/unidade e Bola R$ 12/unidade em SKUs próprios. Premium inclui 4 bombons:
  o formulário recebe somente extras, sem cobrar os incluídos ou subtrair quatro novamente.
- Lembrancinhas Personalizada/Premium mantêm registros e preços históricos, mas
  ficam inativas e não são oferecidas em novos fechamentos.
- Pizza Party oferece os 31 adicionais ativos precificados nas mesmas faixas dos
  demais pacotes. O preço base continua `SOB_CONSULTA`, sem fechamento automático.
- Fechamento público e interno consultam preço e disponibilidade dos extras
  no servidor. O cálculo final recusa adicionais que não estejam marcados
  como `EXTRA` no pacote.
- O proprietário edita categorias, itens, limites por pacote e modalidades
  dos adicionais; escolhas do buffet são validadas e registradas com IDs e nomes.
- Buffet resolvido no servidor alimenta os campos persistidos e o snapshot da
  versão contratual. Criação, revisão V2 e leitura histórica V1 foram testadas:
  alterações posteriores no catálogo ou na revisão não mudam snapshots, hashes,
  documentos/provas ou bytes dos PDFs de versões antigas.
- O PDF de pacotes pode ser publicado na área administrativa e aberto pelo cliente.

## Conferência necessária antes da ativação

1. Confirmar as composições e os limites comerciais ainda pendentes abaixo,
   sem confundir quantidade de sabores, unidades incluídas e convidados pagantes.
2. Pizza Party tem limite aprovado de **20 a 100 convidados**, aplicado no cartão,
   consulta de extras, validação da API e catálogo administrativo. A oferta de extras
   depende de preço vigente para data/quantidade; a base permanece SOB_CONSULTA.
3. Ensaio no clone concluído: prechecks/postchecks, preservação dos dez fechamentos
   e fronteira 79/80 aprovados (rolha R$ 190/R$ 290). Isso não autoriza repetir as
   migrations nem substitui os gates de qualquer outro ambiente.
4. Revisar e aprovar o procedimento de execução em staging: destino e TLS
   confirmados, baseline pós-019 com `search_path=public`, backup recuperável e
   precheck → aplicação → postcheck de cada migration ausente. Não reaplicar as
   já presentes; parar em divergência ou estado parcial. Os SQLs têm BEGIN/COMMIT
   próprios: o executor deve controlar corretamente o limite transacional.
5. Após autorização específica, testar staging correto e preservação dos históricos.
   O runner `catalogo-021.integration.cjs` permanece exclusivo do clone local;
   não relaxar suas guardas para apontá-lo a staging. Nenhum teste remoto foi
   realizado nesta revisão; nenhuma promoção/deploy está autorizada por este documento.

Os prechecks e postchecks de 021–025 em `database/checks/` são somente leitura.
Comparar as contagens e a vigência antiga/nova; testes offline não substituem
o ensaio em clone autorizado.

## Composição documentada e decisões ainda necessárias

A comparação utilizou as descrições comerciais versionadas em
`components/fechamento/data.ts`, as regras de 022/023 e a documentação acima.
Não havia um PDF oficial independente versionado nesta pasta para atestar que
essas fontes são a última aprovação comercial. O PDF publicado no teste era
explicitamente fictício e serviu somente para verificar o fluxo de publicação.

| Pacote | Composição registrada e comportamento observado | Ressalva |
|---|---|---|
| Pocket | Salgados, doces e bolo; lembrancinha não inclusa na descrição | Extras unitários definidos pela 025; não inferir novos limites comerciais |
| Mini Festa | Salgados, doces, bolo e lembrancinha | Não presumir quantidade de lembrancinhas por convidado |
| Compacta | Salgados e bolo; sem categoria Doces | Valor acima da base de 40 convidados continua sujeito à confirmação da equipe |
| Essencial | Salgados, doces e bolo | Itens fixos da composição, como bebidas e acompanhamentos, não são categorias de escolhas |
| Completa | Essencial + lembrancinha, salada, penne, crepe de queijo e sorvete; penne/crepe/sorvete não aparecem como extras pagos | A UI oferece **Salada premium** como extra; confirmar se é diferente da salada incluída, sem equiparar os dois nomes por inferência |
| Premium | Completa + 4 bombons incluídos, empratado, crepe de chocolate, pastelzinho e demais itens descritos | Somente quantidade extra de bombom custa R$ 4/unidade; limite de sabores não define unidades por pessoa |
| Pizza Party | Base sob consulta; sem escolhas de buffet cadastradas; 31 adicionais ativos precificados disponíveis | Limite aprovado: 20–100 convidados; não inventar preço base nem liberar fechamento automático |

Outras pendências explícitas:

- Os limites técnicos `Doces até 16` e `Bombons até 4` coincidem com o número de
  sabores cadastrados. O comentário da 022 diz que esses limites ainda são
  configuráveis; eles não comprovam uma quantidade comercial aprovada ou unidades
  por pessoa. `Até 8 salgados`, `1 massa` e `1 recheio` são regras explícitas na 022.
- Os máximos de convidados publicados na UI não constituem, por si só, aprovação
  comercial: o cadastro original deixa `convidados_maximos` nulo quando indefinido.
  Preservar a regra automática de Compacta para 40; não atribuir preço a outras quantidades.
- `COMBO_ADULTOS`/`COMBO_LANCHINHOS` são inclusos no Premium e indisponíveis na
  Completa pela 023; a composição descritiva não define esses nomes. Exigem revisão
  comercial explícita, sem inventar equivalências.

Resolvido pela 025: quantidades inteiras positivas para extras por unidade; zero
extras significa desmarcar; preços persistidos R$ 4/R$ 9/R$ 12; SKUs Copo/Bola
mapeados no público; Personalizada/Premium suspensos. A lista completa está em
[CATALOGO_V1_025.md](CATALOGO_V1_025.md): Pocket/Mini/Compacta/Essencial/Pizza com
31 extras, Completa com 26 e Premium com 22. As evidências são do clone autorizado,
incluindo preservação dos dez fechamentos e restauração dos dados fictícios.
