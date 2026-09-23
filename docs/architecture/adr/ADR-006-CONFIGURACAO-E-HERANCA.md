# ADR-006 — Configuração e herança

## Status

ACCEPTED — SaaS/ADR-006, D04 aprovada na 1B-C1. Precedência e preservação da identidade histórica fechadas; representação física será detalhada na 1C, não decidida por este documento.

## Contexto

[Configurações](../../modulos/CONFIGURACOES.md), [Buffet](../../modulos/BUFFET.md) e [Pagamentos](../../modulos/PAGAMENTOS.md) descrevem regras específicas que devem variar por unidade. A V1 mantém catálogos globais e também configurações em código/arquivos.

## Problema

Resolver o valor efetivo de modo determinístico sem permitir que editar um padrão mude retroativamente contratos, preços aceitos ou políticas de segurança.

## Drivers

Rastreabilidade; precedência simples; independência de unidades; integridade referencial; preservação de snapshots assinados; regras Core não configuráveis.

## Decisão

Resolução aprovada: partir do default da empresa e aplicar o override autorizado da unidade, com precedência do override nos campos permitidos. Ausência significa herdar; null só é valor se o domínio o aceitar, nunca marcador ambíguo. Estados HERDAR/DEFINIR/LIMPAR são semânticas a representar na 1C, não colunas já escolhidas. Sem configuração necessária válida, falhar explicitamente; não buscar configuração de outra empresa. Defaults de produto só podem existir se explicitamente previstos e versionados, nunca como cópia mutável da Kidmais. Não fazer merge profundo genérico de JSON. Resolver origem/identidade/versão/vigência junto com o valor e publicar conjuntos relacionados consistentemente.

Alterar preço, pacote, área, agenda ou regra não pode reinterpretar silenciosamente fechamentos, contratos, pagamentos ou festas históricos. Desenhar referência à configuração efetivamente utilizada, com identidade/versionamento quando necessário. Isso inclui área usada em tarefa/pendência de Festa, não somente preço/PDF. Remover ou trocar override não muda o significado de referências anteriores. A 1C decidirá materialização, vínculos efetivos ou outra representação íntegra; nenhuma dessas opções está aprovada como schema definitivo aqui.

## Alternativas consideradas

Cópia integral para cada unidade simplifica leitura mas perde herança. Merge JSON arbitrário dificulta validação, nulidade e rollback. Referências diretas a catálogo global Kidmais impedem personalização segura. Recomenda-se resolver herança no serviço de domínio a partir de dados tipados, mantendo opção de materialização versionada.

## Consequências positivas

Origem efetiva explicável; alteração independente por unidade; histórico de configuração preservado.

## Consequências negativas/trade-offs

Versionar configurações cria mais registros e regras de publicação. Cache depende de empresa, unidade, versão e visibilidade; invalidar sem trocar silenciosamente a versão de uma operação existente.

## Invariantes

I03/I09. Default é sempre da mesma empresa. Invariantes de matemática, autenticação, integridade, isolamento e imutabilidade não podem ser sobrescritas por configuração.

## Implicações de segurança

Administrador de unidade só edita overrides autorizados; alterar padrão da empresa exige permissão correspondente. Não herdar credenciais, grants, memberships ou bypass de segurança por este mecanismo. Templates publicados de produto são cópias/versões explícitas, não relações mutáveis cruzando tenants.

## Implicações para migrations

A 1C definirá estrutura default/override, chaves, referências efetivas e escopo obrigatório dentro de D04. Default sem unidade continua pertencendo a uma empresa; estabelecimento_id NULL não é catálogo global. Operação pode usar default aplicável da própria empresa sem exigir unidade artificial nesse default; a integridade do vínculo efetivo deve ser demonstrada. Preservar IDs V1 referenciados quando seguro e não atualizar snapshots assinados para acomodar novos IDs. D12a inventaria valores fora das 63 tabelas antes de declarar configuração totalmente coberta.

## Implicações para testes

T13/T14: herdar, sobrescrever, remover override, null permitido/proibido, vigências concorrentes, default ausente, pacote de outra empresa, mudança após assinatura, cache por unidade e restauração de versão. Testar área de A1 versus A2, override após criação da tarefa/pendência e retirada/reativação da área sem reinterpretar histórico.

## Rollout

Catalogar chaves e invariantes → importar padrões Kidmais → comparar resolução V1 → habilitar overrides em unidade piloto → versionar publicações; nenhuma alteração automática dos documentos existentes.

## Critérios de aceite

Mesmos inputs e versões resolvem mesmo resultado; origem auditável; casos sem default falham explicitamente; uma unidade não muda outra sem publicação de padrão autorizada.

## Questões em aberto

D04 fechada como direção. Tabelas separadas/escopo discriminado/materialização e publicação atômica são alternativas de implementação para a 1C, sujeitas às invariantes acima. D12a CLOSED no [mapa de autoridade](../SAAS-CONFIG-AUTHORITY-MAP.md), incluindo fontes fora do banco, conflitos e lacunas de preservação. Resolver cada conflito na implementação/paridade D12b não autoriza mudar regra de negócio sem aprovação. Não confundir detalhe físico delegado à 1C com nova aprovação de semântica de produto.
