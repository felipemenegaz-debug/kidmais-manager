import type { DbExecutor } from '../db/contracts';
import type { ClienteAsaas } from '../assinatura/asaas.ts';
import { marcadoresDeRemocao } from '../assinatura/reconciliacao-contratacao.ts';
import { erroAcesso, violacaoUnica } from '../acessos/erros.ts';
import { documentoFiscalValido, mascararDocumento } from '../acessos/validacao.ts';
import { continuidadeInstalada, continuidadeLigada, cpfDisponivel, documentoVigente, documentoVinculado, exigirNomeCivil, MENSAGEM_CPF_INDISPONIVEL,
    travarDocumento } from '../assinatura/documento-contratante.ts';

/**
 * Continuidade assistida do documento da contratante (D5 de 22/10/2026; parecer jurídico de apoio, §8). Só o atendimento,
 * pelo painel do desenvolvedor (concessão, senha recente, motivo), registra:
 *  - RETIFICACAO: documento do mesmo tipo digitado errado;
 *  - MESMA_TITULARIDADE: a mesma operação formalizada de CPF para CNPJ (empresário individual/MEI, aditivo);
 *  - CESSAO: CPF para CNPJ de sociedade (cessão de posição contratual, com concordância das partes).
 * Exige o instrumento assinado (identificação/versão) e as evidências do vínculo, conferidos fora do sistema. Não reescreve
 * os snapshots (documento do teste e do Fundador): preço, ciclo, benefício e datas originais seguem os registros; a linha
 * guarda um retrato deles. O documento VIGENTE passa a ser o novo (ficha, checkout, Perfil, concessão nova).
 * Sempre nasce PENDENTE_PROVEDOR (contratação e oferta bloqueadas) até o atendimento registrar a conferência do provedor:
 * cliente atualizado pelo procedimento do provedor/contador, ou ausência de cliente conferida por referência no provedor
 * (revisão de 22/10/2026, P2-1: vínculo local vazio não prova que não exista cliente remoto).
 * Exclusão mútua com o checkout: disputa a MESMA trava de contratação (kidmais:contratacao) sem esperar; com contratação
 * em curso, recusa (CONTRATACAO_EM_ANDAMENTO). Aplicação IMEDIATA: data efetiva futura é recusada (P2-3).
 */
export type TipoContinuidade = 'RETIFICACAO' | 'MESMA_TITULARIDADE' | 'CESSAO';
type Ambiente = Record<string, string | undefined>;
const ISO = (coluna: string) => `to_char((${coluna}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

async function exigirDisponivel(tx: DbExecutor, env: Ambiente) {
    if (!continuidadeLigada(env) || !await continuidadeInstalada(tx))
        throw erroAcesso('CONTINUIDADE_INDISPONIVEL', 'A continuidade de documento ainda não está disponível neste ambiente.', 503);
}

/** Mesma trava do checkout e da renovação (travaPorEmpresa), sem espera; mantida até o fim desta transação. */
async function exigirSemContratacao(tx: DbExecutor, empresaId: string) {
    const livre = (await tx.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('kidmais:contratacao'), hashtext($1)) AS ok", [empresaId])).rows[0]?.ok === true;
    if (!livre)
        throw erroAcesso('CONTRATACAO_EM_ANDAMENTO', 'Há uma contratação ou renovação desta empresa em andamento. Aguarde alguns segundos e tente de novo.', 409);
}

export async function registrarContinuidade(tx: DbExecutor, input: {
    empresaId: string; usuarioId: string; tipo: TipoContinuidade; documentoNovo: string; nomeNovo: string; instrumento: string; evidencias: string; dataEfetiva: string;
}, env: Ambiente = process.env) {
    await exigirDisponivel(tx, env);
    await exigirSemContratacao(tx, input.empresaId);
    const hoje = (await tx.query<{ ok: boolean | null }>("SELECT $1::date <= (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date AS ok", [input.dataEfetiva])).rows[0]?.ok;
    if (hoje !== true)
        throw erroAcesso('DADOS_INVALIDOS', 'A continuidade vale a partir do registro: registre na data efetiva do instrumento (data futura não é aceita).', 400, { campo: 'dataEfetiva' });
    const linha = (await tx.query<{ documento_teste: string | null }>(
        'SELECT documento_teste FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE', [input.empresaId])).rows[0];
    if (!linha?.documento_teste)
        throw erroAcesso('CONFLITO', 'Esta empresa ainda não tem teste nem assinatura: corrija o documento direto na ficha.', 409);
    const vigente = await documentoVigente(tx, input.empresaId, linha.documento_teste);
    if (vigente.pendente)
        throw erroAcesso('CONTINUIDADE_PENDENTE', 'Já há uma continuidade aguardando a conferência do provedor. Conclua-a antes de registrar outra.', 409);
    const anterior = vigente.documento!;
    const novo = documentoFiscalValido(input.documentoNovo);
    if (!novo)
        throw erroAcesso('DADOS_INVALIDOS', 'CPF ou CNPJ novo inválido.', 400, { campo: 'documentoNovo' });
    if (novo.numero === anterior)
        throw erroAcesso('DADOS_INVALIDOS', 'O documento novo é igual ao vigente.', 400, { campo: 'documentoNovo' });
    const mesmoTipo = novo.numero.length === anterior.length;
    if (input.tipo === 'RETIFICACAO' ? !mesmoTipo : !(anterior.length === 11 && novo.tipo === 'CNPJ'))
        throw erroAcesso('DADOS_INVALIDOS', input.tipo === 'RETIFICACAO'
            ? 'Retificação corrige um documento do mesmo tipo. Para CPF → CNPJ, use formalização da mesma titularidade ou cessão.'
            : 'Formalização e cessão valem só de CPF para CNPJ.', 400, { campo: 'tipo' });
    if (novo.tipo === 'CPF' && !await cpfDisponivel(tx, env))
        throw erroAcesso('CPF_INDISPONIVEL', MENSAGEM_CPF_INDISPONIVEL, 409, { campo: 'documentoNovo' });
    exigirNomeCivil(novo.numero, input.nomeNovo);
    await travarDocumento(tx, novo.numero);
    // Qualquer vínculo, inclusive desta empresa (teste, Fundador ou cadeia): um documento não volta a ser "novo".
    if (await documentoVinculado(tx, novo.numero))
        throw erroAcesso('DUPLICIDADE', 'Este documento já está registrado para uma contratante. Confira o vínculo antes de continuar.', 409, { campo: 'documentoNovo' });
    if (!(await tx.query('SELECT 1 FROM plataforma_empresas_cadastro WHERE empresa_id = $1::uuid FOR UPDATE', [input.empresaId])).rows.length)
        throw erroAcesso('CONFLITO', 'A empresa não tem cadastro administrativo: crie a ficha antes da continuidade.', 409);
    // Retrato das condições preservadas (sem documentos): assinatura, concessões Fundador e contratações.
    const condicoes = (await tx.query<{ c: Record<string, unknown> }>(`SELECT jsonb_build_object(
            'assinatura', (SELECT to_jsonb(a) - 'documento_teste' FROM empresa_assinaturas a WHERE a.empresa_id = $1::uuid),
            'fundador', coalesce((SELECT jsonb_agg(to_jsonb(f) - 'documento_beneficiario') FROM assinatura_fundadores f WHERE f.empresa_id = $1::uuid), '[]'::jsonb),
            'contratacoes', coalesce((SELECT jsonb_agg(to_jsonb(o)) FROM assinatura_contratacoes o WHERE o.empresa_id = $1::uuid), '[]'::jsonb),
            'retratoEm', ${ISO('clock_timestamp()')}) AS c`, [input.empresaId])).rows[0].c;
    let id: string;
    try {
        id = (await tx.query<{ id: string }>(`INSERT INTO empresa_documento_continuidades
            (empresa_id, tipo, documento_anterior, documento_novo, nome_novo, instrumento, evidencias, data_efetiva, condicoes, situacao, registrada_por)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::date, $9::jsonb, 'PENDENTE_PROVEDOR', $10::uuid) RETURNING id`,
            [input.empresaId, input.tipo, anterior, novo.numero, input.nomeNovo.trim(), input.instrumento.trim(), input.evidencias.trim(), input.dataEfetiva,
                JSON.stringify(condicoes), input.usuarioId])).rows[0].id;
        await tx.query('UPDATE plataforma_empresas_cadastro SET documento_fiscal = $2, nome_empresarial = $3, atualizado_por = $4 WHERE empresa_id = $1::uuid',
            [input.empresaId, novo.numero, input.nomeNovo.trim(), input.usuarioId]);
    }
    catch (error) {
        if (violacaoUnica(error, 'empresa_doc_continuidades_documento_uk') || violacaoUnica(error, 'kidmais_063_cad_documento_uk'))
            throw erroAcesso('DUPLICIDADE', 'Este documento já está registrado para uma contratante. Confira o vínculo antes de continuar.', 409, { campo: 'documentoNovo' });
        throw error;
    }
    return { continuidadeId: id, tipo: input.tipo, situacao: 'PENDENTE_PROVEDOR' as const, documentoAnterior: anterior, documentoNovo: novo.numero };
}

/** Registra a conferência do cliente no provedor (feita pelo procedimento do provedor/contador) e libera a contratação. */
export async function concluirContinuidade(tx: DbExecutor, input: { empresaId: string; continuidadeId: string; nota: string; usuarioId: string }, env: Ambiente = process.env) {
    await exigirDisponivel(tx, env);
    await exigirSemContratacao(tx, input.empresaId);
    const r = (await tx.query<{ id: string; documento_novo: string }>(`UPDATE empresa_documento_continuidades
        SET situacao = 'CONCLUIDA', provedor_conferido_em = clock_timestamp(), provedor_conferido_por = $3::uuid, provedor_nota = $4
        WHERE id = $1::uuid AND empresa_id = $2::uuid AND situacao = 'PENDENTE_PROVEDOR' RETURNING id, documento_novo`,
        [input.continuidadeId, input.empresaId, input.usuarioId, input.nota.trim()])).rows[0];
    if (!r)
        throw erroAcesso('CONFLITO', 'Não há continuidade pendente com este identificador nesta empresa.', 409);
    return { continuidadeId: r.id, documentoNovo: r.documento_novo };
}

export type ProvedorRecuperacao = Pick<ClienteAsaas, 'obterAssinatura' | 'listarAssinaturasPorReferencia' | 'buscarClientePorReferencia'>;

/**
 * Recuperação assistida do vínculo (revisão 6e9d09f, P2-N3): assinatura criada no provedor sem vínculo local, com a
 * continuidade de documento já CONCLUÍDA, quando a reconciliação automática não adota (CONTINUIDADE_DOCUMENTO) e o
 * checkout não retoma (oferta vencida). O atendimento informa o id da assinatura conferida; o sistema confere de novo:
 * trava de contratação livre; empresa sem vínculo; última continuidade concluída; assinatura ativa, da empresa, a única
 * ativa da referência, sem remoção incerta; cliente dela achado por referência com o CPF/CNPJ VIGENTE (presente e igual);
 * cliente já vinculado, se houver, igual. Só então grava o vínculo (sem POST nem DELETE no provedor). NÃO consulta a
 * validade atual da oferta: o pagamento segue a sincronização normal (D1/D3) — feito dentro da validade original
 * confirma; tardio ou sem data vai para reconciliação (FUNDADOR_OFERTA_EXPIRADA), sem cobrança complementar.
 */
export async function recuperarVinculo(tx: DbExecutor, input: { empresaId: string; assinaturaId: string }, provedor: ProvedorRecuperacao, env: Ambiente = process.env) {
    await exigirDisponivel(tx, env);
    await exigirSemContratacao(tx, input.empresaId);
    const linha = (await tx.query<{ situacao: string; provedor_cliente_id: string | null; provedor_assinatura_id: string | null; documento_teste: string | null }>(
        'SELECT situacao, provedor_cliente_id, provedor_assinatura_id, documento_teste FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE', [input.empresaId])).rows[0];
    if (!linha)
        throw erroAcesso('CONFLITO', 'Esta empresa não tem cobrança registrada.', 409);
    if (linha.provedor_assinatura_id)
        throw erroAcesso('CONFLITO', 'A empresa já tem assinatura vinculada; a recuperação vale só para assinatura sem vínculo.', 409);
    const temContinuidade = (await tx.query('SELECT 1 FROM empresa_documento_continuidades WHERE empresa_id = $1::uuid LIMIT 1', [input.empresaId])).rows.length > 0;
    const vigente = await documentoVigente(tx, input.empresaId, linha.documento_teste);
    if (!temContinuidade)
        throw erroAcesso('CONFLITO', 'Sem continuidade de documento, a reconciliação automática cuida do vínculo.', 409);
    if (vigente.pendente)
        throw erroAcesso('CONTINUIDADE_PENDENTE', 'Conclua a continuidade (conferência do provedor) antes de recuperar o vínculo.', 409);
    const ativa = (s: { status: string; deleted: boolean } | null) => Boolean(s && !s.deleted && s.status === 'ACTIVE');
    const s = await provedor.obterAssinatura(input.assinaturaId);
    if (!s || !ativa(s) || s.externalReference !== input.empresaId || !s.customer)
        throw erroAcesso('CONFLITO', 'A assinatura informada não está ativa no provedor para esta empresa.', 409);
    const ativas = (await provedor.listarAssinaturasPorReferencia(input.empresaId)).filter(ativa);
    if (ativas.some((x) => x.id !== s.id))
        throw erroAcesso('CONFLITO', 'Há mais de uma assinatura ativa desta empresa no provedor: resolva as duplicatas antes.', 409);
    if ((await marcadoresDeRemocao(tx, input.empresaId)).some((m) => m.assinatura_provedor_id === s.id))
        throw erroAcesso('CONFLITO', 'Há exclusão sem confirmação para esta assinatura: a reconciliação decide primeiro.', 409);
    if (linha.provedor_cliente_id && linha.provedor_cliente_id !== s.customer)
        throw erroAcesso('CONFLITO', 'A assinatura é de outro cliente no provedor.', 409);
    const cliente = await provedor.buscarClientePorReferencia(input.empresaId);
    if (!cliente || cliente.id !== s.customer || !cliente.cpfCnpj || cliente.cpfCnpj !== vigente.documento)
        throw erroAcesso('DOCUMENTO_DIVERGENTE', 'O cliente da assinatura no provedor não tem o CPF ou CNPJ vigente: atualize o cliente e confira antes de recuperar.', 409);
    await tx.query(
        `UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = COALESCE(provedor_cliente_id, $2), provedor_assinatura_id = $3,
                provedor_situacao = $4 WHERE empresa_id = $1::uuid`, [input.empresaId, s.customer, s.id, s.status.slice(0, 40)]);
    return { assinaturaId: s.id, clienteId: s.customer };
}

/** Lista para a ficha (documentos mascarados). Vazia sem a 091. */
export async function continuidadesDaEmpresa(tx: DbExecutor, empresaId: string) {
    if (!await continuidadeInstalada(tx)) return [];
    const linhas = (await tx.query<{ id: string; tipo: TipoContinuidade; situacao: string; documento_anterior: string; documento_novo: string; nome_novo: string; instrumento: string;
        data_efetiva: string; registrada_em: string; registrada_por: string | null; provedor_conferido_em: string | null; provedor_nota: string | null }>(
        `SELECT c.id, c.tipo, c.situacao, c.documento_anterior, c.documento_novo, c.nome_novo, c.instrumento, c.data_efetiva::text AS data_efetiva,
                ${ISO('c.registrada_em')} AS registrada_em, u.nome AS registrada_por, ${ISO('c.provedor_conferido_em')} AS provedor_conferido_em, c.provedor_nota
           FROM empresa_documento_continuidades c LEFT JOIN usuarios_administrativos u ON u.id = c.registrada_por
          WHERE c.empresa_id = $1::uuid ORDER BY c.registrada_em DESC LIMIT 20`, [empresaId])).rows;
    return linhas.map((c) => ({
        id: c.id, tipo: c.tipo, situacao: c.situacao, documentoAnterior: mascararDocumento(c.documento_anterior), documentoNovo: mascararDocumento(c.documento_novo),
        nomeNovo: c.nome_novo, instrumento: c.instrumento, dataEfetiva: c.data_efetiva, registradaEm: c.registrada_em, registradaPor: c.registrada_por,
        provedorConferidoEm: c.provedor_conferido_em, provedorNota: c.provedor_nota,
    }));
}
