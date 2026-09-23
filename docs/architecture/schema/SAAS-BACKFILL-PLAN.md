# Backfill Kidmais e rollout de nulabilidade — proposta

Destino aprovado D07: **uma empresa Kidmais + um estabelecimento inicial**. IDs/códigos concretos não são inventados nesta fase. [Matriz63](SAAS-SCHEMA-63-MATRIX.md) é o plano por tabela; este documento define algoritmo, evidência, classes e gates que se aplicam a cada linha.

Atualização1C-B1: consultar [proteções e prova de migratabilidade](SAAS-MIGRATABILITY-PROOF.md) e [disposição de segurança](SAAS-LEGACY-SECURITY-DISPOSITION.md). P precede ADD COLUMN em adicionais hashados; M só altera metadados preservando todas as colunas V1. OPEN02 = DESIGN_CLOSED_EXECUTION_GATE; OPEN03 = DESIGN_CLOSED, proposto para aprovação. X é outra exceção proposta, limitada à transferência/minimização ou eliminação elegível; não se beneficia da autorização M. Nenhum SQL/ensaio executado.

## Classes e origem confiável

| Classe | Significado e condição |
| --- | --- |
| DETERMINISTIC | Raiz/catalog V1 com atribuição sustentada por D07; não derivada de nome, usuário ou valor comercial. Confirmar ausência de conflito com outras referências |
| DERIVED | Pai autoritativo já atribuído e todos os demais caminhos convergentes; ordem topológica/lotes por agregado. Não escolher um entre pais conflitantes |
| REVOKE_OR_REISSUE | Efêmero sem vínculo atual seguro: invalidar uso/reemitir em fluxo autorizado futuro; não inventar U. Prova consumida comprovada segue DERIVED e preserva conteúdo |
| MANUAL_REVIEW | Órfão, múltiplas origens, grants, evento sem origem/escopo, configuração histórica não demonstrável. Bloqueia lote/enforcement afetado até decisão e evidência |
| NOT_APPLICABLE | Identidade/pré-auth global: não recebe tenant de ownership; sessão pode exigir revogação/reemissão operacional, sem converter ownership |

Qualquer linha marcada DETERMINISTIC/DERIVED passa a MANUAL_REVIEW se o precheck encontrar ambiguidade. Classificação estática não afirma população, volume ou tempo de lock. JSON/snapshot ajuda reconciliação, mas não substitui pai tipado/decisão D07; usuário global não determina empresa/unidade histórica.

## Sequência por agregado

1. Em ambiente futuro explicitamente autorizado, inventariar contagens, PKs, órfãos, referências, estado de triggers e hashes técnicos protegidos. Produzir evidência minimizada por lote, sem PII nem hashes públicos de identificadores pessoais. Confirmar restauração/rollback e compatibilidade antes de execução.
2. Criar/mapear a única empresa/unidade inicial. Contagem da raiz autorizada e registro do mapeamento impedem execução contra outro contexto. Provisionar memberships/permissões somente por mapeamento explícito revisado; capacidades V1 não autorizam novas unidades.
3. Atribuir clientes e catálogos à E; derivar filhos CRM. Preencher E nas conexões WhatsApp somente com origem comprovada D07 e validar metadados; não copiar credenciais para fixtures. Criar associações U futuras mediante concessão explícita, não via loop sobre todas as unidades.
4. Atribuir raízes `fechamentos` e `bloqueios_agenda` à U inicial; derivar contratos/versões, adicionais/revisões/aprovações. Ciclos revisão↔aprovação e versões↔fluxo exigem lote atômico ou duas passagens de metadados com constraints planejadas; nunca escolher pai intermediário incompleto como prova final.
5. Derivar pagamentos→planos/parcelas/recebimentos e grafo015 pela gestão/contrato; conferir cada ramo/referência de crédito/devolução. Um E/U igual não basta: plano/parcela/evento/versão devem pertencer ao mesmo pagamento/contrato quando o domínio exige.
6. Derivar Festa e filhos por contrato/Festa; áreas têm [tratamento histórico](SAAS-CONFIG-PHYSICAL-DESIGN.md). Preservar criação/origem/status/assinaturas019; nenhum backfill dispara Festa automática nem tenta resolver K10.
7. Provas consumidas/referenciadas de identidade derivam do fechamento/versão exatos; preservar cliente/finalidade/FKs/bytes. E derivável de cliente não comprova U. Ativas inseguras revogam; expiradas/não consumidas sem dependência e com retenção encerrada podem receber RETENTION_DELETE aprovado; se precisam sobreviver sem U necessária, MANUAL_REVIEW. Nunca mover OTP para Core por falta de U. Revogação não atribui histórico nem autoriza purge.
8. Eventos CRM/auditoria: cliente OU recurso comprovado define E e U de origem quando operacional; Festa sem cliente continua tenant. Só evento global com produtor/semântica comprovados é candidato a HISTORICAL_CORE_EVIDENCE. G-X antecede qualquer extração: mínimo tipado torna-se autoridade após commit, original elegível é removido na mesma transação; nenhuma cópia residual E NULL. Guard003/018 exige exceção X nominal, distinta de M, aprovada e ensaiada. RETENTION_DELETE não cria cópia individual. Ambiguidade/retenção integral obrigatória bloqueia; Core nunca é destino por exclusão.
9. Reconciliar total e agregados após cada lote; repetir lote deve não produzir mudança adicional. Atribuição existente diferente falha, nunca sobrescreve. Registrar checkpoint e decisão de mapeamento separadamente de documento assinado. Contagens/hash/projeções financeiras idênticas para conteúdo protegido.

Cobertura por PK: origem antes = mantidas tenant + Core nativas mantidas + evidências globais extraídas + eliminações elegíveis + pendentes, sem sobreposição. Revogação não é destino final. G-COVERAGE exige pendentes=0 antes de S6. Igualdade de população/bytes aplica-se a M e ao histórico durável; X exige partição exata e igualdade da projeção mínima, não alegação falsa de preservação integral. WhatsApp sem E comprovada invalida tentativa ativa; terminal segue retenção/revisão, nunca Core automático. Sem posse da conexão, suspender uso/revisar; não inventar empresa nem extrair ciphertext.

## D08: proteção física do histórico

Recomendação é **colunas diretas E/U** inclusive nos41 operacionais. Contudo, triggers append-only, snapshots calculados de linha e funções013–019 podem rejeitar ou alterar metadados. Antes de executar backfill em cada família: listar funções/colunas hashadas, provar que somente E/U e referência técnica permitida mudam, que projeções históricas excluem o envelope novo quando necessário e que não há efeitos em status/valor/autoria. Reservar role de migração e caminho estreito controlado, mantendo bloqueio total ao runtime; não autorizar `DISABLE TRIGGER` geral, replicação permissiva ou rehash do conteúdo.

OPEN_1C-02 só admite sidecar nominal se essa prova falhar. A proposta de exceção precisaria: PK exatamente do registro histórico, FK obrigatória ao original, E/U NN e FKs tenant-aware; obrigação reversa de cobertura em toda criação/confirmação, atomicidade e validação de concorrência; policies que negam registro sem mapa; índices e interfaces que impeçam consulta direta não escopada; preserve hash/bytea. FK do sidecar para original sozinha não prova que todos os originais têm mapa. Nenhum sidecar foi aprovado nem usado como alternativa automática na matriz.

Snapshots/contratos/PDFs/assinaturas conservam bytes e hashes; pagamento conserva valor do snapshot; eventos/contagens/créditos não são apagados. Retirar metadado após uso pode remover a evidência de atribuição, portanto rollback usual é build compatível/forward-fix, não UPDATE para NULL.

## Nulabilidade e constraints em fases

| Fase conceitual | Estado / controle obrigatório | Saída verificável |
| --- | --- | --- |
| Expandir | E/U novas nullable onde há legado; tabelas SaaS novas nascem NN; nenhum DEFAULT implícito de tenant; apenas Kidmais | Código antigo ainda protegido por gate; nenhuma segunda empresa operacional |
| Compatibilizar | Writers novos recebem contexto explícito; readers transitórios distinguem legado Kidmais de atribuído; retirada/drenagem de writers antigos planejada | D12b comprovado para build/caminho promovido; não ocultar legado com filtro novo |
| Backfill | Checkpoints/validação de pais, D08 por família; pares E/U completos ou ambos temporariamente ausentes, nunca parcial novo | Atribuição idempotente; zero conflito/órfão; imutáveis preservados |
| Fechar escrita sem escopo | Todos os writers antigos retirados; novas linhas obrigatórias sem E/U recusadas | Nenhum novo NULL, inclusive jobs, trigger, repair e scripts operacionais |
| Validar/endurecer | FKs/CHECKs candidatos inicialmente NOT VALID onde apropriado; a validação de dados existentes é explícita; UNIQUE exige estratégia própria, não "UNIQUE NOT VALID" | Zero violações, índices válidos; substituir uniques globais somente após equivalente pronto |
| Final | E NN para60 tenant-owned; U NN para41 operacionais; U de configuração só pode ser NULL no default tipado; U de evento empresa só ausente com origem empresarial comprovada | Constraints finais e lookup por escopo; nenhuma exceção de tenantNULL ativa |
| Remover compatibilidade e provar | Reader global/fallback Kidmais removidos; policies/roles finais; T01–T16 pertinentes | G3 e D03/D10/D12c antes de G4; rollback posterior preserva tenancy |

Uma FK NOT VALID não dispensa checagem de novas mudanças relevantes; colocar E/U nullable permite linhas antigas sem FK efetiva até a reconciliação, por isso não é gate de isolamento. Validar e aplicar NOT NULL final requer estratégia de locks/varredura conforme tabela/PG18; não prometer operação instantânea. A construção de índices concorrentes e sua recuperação após falha serão desenhadas no DDL futuro, fora de transação quando exigido. [ALTER TABLE PostgreSQL18](https://www.postgresql.org/docs/18/sql-altertable.html).

## Plano de prova e rollback

Ensaios futuros ocupados e sintéticos: ciclos revisão/aprovação; assinatura/PDF; grafo015 com crédito/devolução; Festa019/formalização; OTP consumido e sem vínculo; auditoria pré-auth; área renomeada; dois tenants e unidades com códigos/CPF iguais; interrupção e reexecução de lote. Referência EMPTY_OPERATION não cobre essas provas.

Antes de metadados consumidos: estrutura aditiva vazia pode ser retirada após retirar consumidores e provar ausência de referências. Depois: preservar schema compatível e suspender writers afetados/forward-fix. Down015/016/019 tem recusas após uso e não serve como rollback de SaaS. Após segundo tenant, proibir build que ignore E/U mesmo que DDL seja tecnicamente removível. Nenhum ensaio ou rollback é executado nesta fase.
