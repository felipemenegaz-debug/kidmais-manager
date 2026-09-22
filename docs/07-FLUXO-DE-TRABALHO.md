# 07 — Fluxo de Trabalho Oficial

## Objetivo
Padronizar como o Kidmais Manager deve ser planejado, documentado e desenvolvido, reduzindo risco de alterações indevidas em produção e evitando dependência de conhecimento informal.

## Ferramentas

### ChatGPT — conversa principal
Usar para:
- decisões de produto;
- definição de regras de negócio;
- arquitetura funcional;
- priorização;
- análise de alternativas;
- revisão de roadmap;
- definição do que deve ser documentado.

### ChatGPT Work
Usar para:
- documentação extensa;
- relatórios;
- roadmaps;
- PDFs;
- apresentações;
- materiais comerciais;
- consolidação de artefatos e documentação.

### Codex
Usar para engenharia no repositório:
- implementação de código;
- refatorações;
- migrations;
- testes;
- investigação de bugs;
- revisão de diffs;
- implementação de módulos;
- alterações técnicas com validação local.

## Regra prática
Planejar e decidir no ChatGPT.
Consolidar documentos e artefatos grandes no Work.
Implementar engenharia no Codex.

## Separação física dos projetos

### Produção / V1
```
D:\glass\KidMais Manager\kidmais-manager-github
```

### SaaS / Productização
```
D:\glass\KidMais Manager\kidmais-manager-saas
```

O desenvolvimento SaaS deve ocorrer no clone dedicado. A pasta da V1/produção deve permanecer voltada a correções, estabilização e GO.

O clone SaaS pode usar o mesmo remoto GitHub, mas deve trabalhar em branches próprias, começando por `saas/foundation`.

## Git — fluxo seguro

### Sincronizar branches remotas
```powershell
git fetch origin
```

### Abrir uma branch de trabalho existente
```powershell
git switch <nome-da-branch>
```

Exemplo:
```powershell
git switch docs/productizacao-saas
```

### Voltar para a branch principal
```powershell
git switch main
```

### Atualizar a main depois de um merge
```powershell
git pull origin main
```

## Importante
Executar `git fetch origin` apenas baixa referências e objetos do GitHub; não altera automaticamente os arquivos da branch ativa.

Executar `git switch docs/productizacao-saas` faz o diretório de trabalho local refletir essa branch.

Executar `git switch main` volta o diretório de trabalho para o conteúdo da `main`.

Se um PR ainda não foi mesclado, `git pull origin main` não trará os arquivos desse PR para a `main`.

## Processo recomendado para mudanças relevantes
1. Definir regra/objetivo.
2. Atualizar documentação quando necessário.
3. Criar branch específica.
4. Implementar e testar.
5. Abrir Pull Request.
6. Revisar diff, testes e impacto.
7. Fazer merge.
8. Atualizar `main` local com `git pull origin main`.
9. Validar staging.
10. Promover para produção conforme procedimento oficial.

## Uso de modelos e agentes
A política oficial de modelos, esforço de raciocínio, skills, agentes e subagentes está em [08 — IA, Agentes, Skills e Harness](./08-IA-AGENTES-SKILLS-HARNESS.md).

## Regra de segurança
Evitar alterações diretas na `main` para mudanças relevantes. Preferir branch + Pull Request + revisão.

Para productização SaaS, nunca desenvolver diretamente na pasta física usada como referência da V1/produção.

## Documentação
A pasta `docs/` é a fonte oficial das regras funcionais, arquitetura, roadmap e decisões registradas do Kidmais Manager.
