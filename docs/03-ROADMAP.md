# 03 — Roadmap interno do Kidmais Manager

## Horizonte
Roadmap interno 2026–2028. Datas são metas e podem mudar conforme validação técnica e comercial.

## Fase 0 — GO Kidmais V1
Prazo: imediato / curto prazo.
Objetivo: estabilizar produção e validar OTP real via WhatsApp/Gupshup.
Marco: Kidmais operando diariamente no sistema.

## Fase 1 — Fundação SaaS / Multiempresa
Prazo estimado: 4–7 semanas.
Entregas:
- entidade Empresa/Tenant;
- código único de empresa;
- isolamento entre tenants;
- escopo de dados;
- base de autorização multiempresa.
Marco: Empresa A e Empresa B operam sem acesso cruzado.

## Fase 2 — Multiestabelecimento + Configurações
Prazo: 4–6 semanas.
Entregas:
- múltiplas unidades;
- escopo por estabelecimento;
- herança de configuração;
- duplicação de unidade/configuração;
- identidade e regras por unidade.
Marco: uma empresa opera duas unidades independentes.

## Fase 3 — Pacotes, Buffet e Regras configuráveis
Prazo: 5–8 semanas.
Entregas:
- pacotes;
- categorias de buffet;
- itens;
- quantidades e limites;
- adicionais;
- horários e regras comerciais.
Marco: cliente adapta a operação sem alterar código.

## Fase 4 — Contratos + Financeiro configuráveis
Prazo: 4–6 semanas.
Entregas:
- modelos por pacote/unidade;
- variáveis;
- condições de pagamento;
- regras de entrada e parcelamento;
- preservação de versões assinadas.

## Fase 5 — Onboarding self-service
Prazo: 3–5 semanas.
Entregas:
- assistente inicial;
- templates;
- checklist de ativação;
- publicação da operação.
Marco: segunda empresa configura e entra em uso sem intervenção de desenvolvimento.

## Fase 6 — Billing / Planos SaaS
Prazo: 3–5 semanas.
Entregas:
- planos;
- limites;
- trial;
- cobrança;
- upgrade/downgrade;
- add-ons;
- painel da plataforma.

## Fase 7 — Beta comercial
Prazo: 6–8 semanas, parcialmente em paralelo.
Objetivo: 5–10 empresas externas.
Marco: 10 empresas pagantes.

## Fase 8 — Produção, Estoque e Compras
Prazo: 8–12 semanas.
Entregas:
- produção por festa;
- fichas técnicas;
- consumo previsto;
- estoque;
- compras;
- fornecedores;
- custo real.

## Fase 9 — BI e Rentabilidade
Prazo: 5–8 semanas.
Entregas:
- faturamento;
- ticket;
- ocupação;
- conversão;
- inadimplência;
- margem;
- comparação entre unidades.

## Fase 10 — Automação e IA
Prazo: contínuo; primeiros módulos 6–10 semanas.
Entregas:
- atendimento;
- follow-up;
- cobrança;
- pré-festa;
- pós-venda;
- consultas operacionais;
- assistentes baseados em dados estruturados.

## Fase 11 — Enterprise readiness
Horizonte: contínuo, 6–12 meses.
Possíveis entregas:
- SSO;
- SCIM;
- SLA;
- status page;
- auditoria avançada;
- APIs públicas;
- white-label;
- integrações avançadas.

## Trilhas permanentes
A — Produto
B — Plataforma
C — Segurança
D — Reliability
E — Developer Experience
F — Customer Success
G — SaaS Operations
H — Data & AI

## Marcos comerciais
1. Segunda empresa: usa sem mudança específica de código.
2. 10 empresas: onboarding não depende do desenvolvedor.
3. 50 empresas: suporte, cobrança, monitoramento e operação padronizados.

## Regra de divulgação
A versão comercial do roadmap deve mostrar disponibilidade, desenvolvimento e planejamento em linguagem de benefício. Não deve expor detalhes sensíveis de segurança, migrations, dívida técnica ou compromissos excessivamente precisos de data.
