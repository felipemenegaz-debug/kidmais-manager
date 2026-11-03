/**
 * Enfileiramento e envio dos avisos da assinatura (087), no mesmo padrão do aviso Fundador (renovacao-fundador.ts):
 *   - a intenção é gravada (PENDENTE) antes de qualquer rede; o conteúdo e a chave idempotente são imutáveis;
 *   - antes do 1º envio o aviso é REVALIDADO: empresa ativa, assinatura, pessoa ainda na Gestão com o mesmo e-mail e o
 *     evento ainda vigente (já pagou? trial estendido?) — senão DESCARTADO, sem e-mail;
 *   - ENVIANDO é gravado antes da chamada ao provedor; resposta com id ⇒ ENVIADO; falha ⇒ continua ENVIANDO e a próxima
 *     execução repete com a MESMA chave (o Resend deduplica por 24 h). Passadas 23 h da 1ª tentativa ⇒ INCERTO, sem
 *     retentativa cega.
 * Cada passo do repositório é uma transação curta própria; nenhuma transação fica aberta durante o envio.
 * Simulação: nada é gravado nem enviado; o relatório diz o que aconteceria.
 */
import { randomUUID } from 'node:crypto';
import type { EnviarEmail, MensagemEmail } from '../acessos/email.ts';
import type { AssinaturaGravada, ExcecaoGravada, PrazosAcesso } from './acesso.ts';
import { JANELA_RETENTATIVA_MS, LIMITE_DESTINATARIOS, marcosDevidos, motivoObsoleto, type MarcoAviso, type TipoAviso } from './avisos.ts';
import { mensagemAviso } from './avisos-mensagens.ts';

export type EstadoAviso = 'PENDENTE' | 'ENVIANDO' | 'ENVIADO' | 'INCERTO' | 'DESCARTADO' | 'DEVOLVIDO';
export type Destinatario = { id: string; email: string };
export type ContextoAviso = {
    empresaId: string; empresa: string; empresaAtiva: boolean;
    /** null = sem assinatura ou isenta (lerEstadoComercial). */
    assinatura: AssinaturaGravada | null; excecoes: ExcecaoGravada[];
    /** Relógio do banco (ISO). */
    agora: string;
    gestao: Destinatario[];
};
export type NovoAviso = { id: string; empresaId: string; tipo: TipoAviso; marco: string; destinatarioId: string; mensagem: MensagemEmail };
export type AvisoGravado = NovoAviso & {
    estado: EstadoAviso; tentadoEm: string | null; enviadoEm: string | null; idExterno: string | null; ultimoErro: string | null; criadoEm: string;
};
export type AlteracaoAviso = { estado: EstadoAviso; erro?: string | null; tentativa?: boolean; envioId?: string };
export type RepositorioAvisos = {
    instalado(): Promise<boolean>;
    empresas(): Promise<string[]>;
    contexto(empresaId: string): Promise<ContextoAviso | null>;
    /** true = inserido agora; false = o mesmo (empresa, tipo, marco, pessoa) já existia. */
    enfileirar(aviso: NovoAviso): Promise<boolean>;
    pendentes(limite: number, empresaId?: string): Promise<string[]>;
    ler(id: string): Promise<{ aviso: AvisoGravado; contexto: ContextoAviso | null } | null>;
    marcar(id: string, alteracao: AlteracaoAviso): Promise<void>;
};
export type DepsAvisos = {
    repositorio: RepositorioAvisos; enviar: EnviarEmail; origem: string; prazos: PrazosAcesso; simular: boolean;
    /** Relógio real (janela de 23 h, comparada com tentado_em gravado pelo banco). Padrão: Date.now. */
    relogio?: () => number;
    gerarId?: () => string;
};

export const LIMITE_ENVIOS_POR_EXECUCAO = 500;

/** Uma mensagem por pessoa ativa da Gestão (até LIMITE_DESTINATARIOS), para cada marco. */
export function novosAvisos(c: ContextoAviso, marcos: readonly MarcoAviso[], origem: string, prazos: PrazosAcesso, gerarId: () => string = randomUUID): NovoAviso[] {
    const saida: NovoAviso[] = [];
    for (const m of marcos)
        for (const d of c.gestao.slice(0, LIMITE_DESTINATARIOS)) {
            const id = gerarId();
            saida.push({ id, empresaId: c.empresaId, tipo: m.tipo, marco: m.marco, destinatarioId: d.id,
                mensagem: mensagemAviso({ id, marco: m, empresa: c.empresa, para: d.email, origem, prazos }) });
        }
    return saida;
}

export const contextoElegivel = (c: ContextoAviso | null): c is ContextoAviso & { assinatura: AssinaturaGravada } => !!c && c.empresaAtiva && c.assinatura !== null;

/** Avisos por tempo devidos agora para a empresa. Devolve quantos foram criados e quantos já existiam. */
export async function enfileirarAvisosDaEmpresa(empresaId: string, deps: DepsAvisos) {
    const c = await deps.repositorio.contexto(empresaId);
    if (!contextoElegivel(c))
        return { criados: 0, existentes: 0 };
    const marcos = marcosDevidos(c.assinatura, c.excecoes, Date.parse(c.agora), deps.prazos);
    const novos = novosAvisos(c, marcos, deps.origem, deps.prazos, deps.gerarId);
    if (deps.simular)
        return { criados: novos.length, existentes: 0 };
    let criados = 0;
    for (const n of novos)
        if (await deps.repositorio.enfileirar(n)) criados++;
    return { criados, existentes: novos.length - criados };
}

export type ResultadoAviso = 'NAO_ENCONTRADO' | 'JA_CONCLUIDO' | 'DESCARTADO' | 'INCERTO' | 'ENVIARIA' | 'ENVIADO' | 'ENVIO_FALHOU';

/** Motivo para não enviar um aviso PENDENTE, ou null. */
export function motivoDescarte(aviso: AvisoGravado, c: ContextoAviso | null, prazos: PrazosAcesso): string | null {
    if (!c || !c.empresaAtiva)
        return 'EMPRESA_INATIVA';
    const pessoa = c.gestao.find((d) => d.id === aviso.destinatarioId);
    if (!pessoa || pessoa.email !== aviso.mensagem.para)
        return 'DESTINATARIO_ALTERADO';
    return motivoObsoleto(aviso, c.assinatura, c.excecoes, Date.parse(c.agora), prazos);
}

export async function enviarAviso(id: string, deps: DepsAvisos): Promise<ResultadoAviso> {
    const repo = deps.repositorio;
    const lido = await repo.ler(id);
    if (!lido)
        return 'NAO_ENCONTRADO';
    const { aviso, contexto } = lido;
    if (aviso.estado !== 'PENDENTE' && aviso.estado !== 'ENVIANDO')
        return 'JA_CONCLUIDO';
    const marcar = async (a: AlteracaoAviso) => { if (!deps.simular) await repo.marcar(id, a); };
    if (aviso.estado === 'PENDENTE') {
        const motivo = motivoDescarte(aviso, contexto, deps.prazos);
        if (motivo) {
            await marcar({ estado: 'DESCARTADO', erro: motivo });
            return 'DESCARTADO';
        }
    }
    else if (aviso.tentadoEm && (deps.relogio ?? Date.now)() - Date.parse(aviso.tentadoEm) >= JANELA_RETENTATIVA_MS) {
        await marcar({ estado: 'INCERTO', erro: 'ENVIO_INCERTO_FORA_JANELA' });
        return 'INCERTO';
    }
    if (deps.simular)
        return 'ENVIARIA';
    await marcar({ estado: 'ENVIANDO', tentativa: true, erro: null });
    let envioId: string;
    try {
        const envio = await deps.enviar(aviso.mensagem);
        if (!envio.idExterno?.trim() || !/^[A-Za-z0-9._:-]{1,120}$/.test(envio.idExterno))
            throw new Error('Envio sem identificador.');
        envioId = envio.idExterno;
    }
    catch {
        await marcar({ estado: 'ENVIANDO', erro: 'ENVIO_FALHOU' });
        return 'ENVIO_FALHOU';
    }
    await marcar({ estado: 'ENVIADO', envioId, erro: null });
    return 'ENVIADO';
}

/** Envia os pendentes (todos ou de uma empresa). Erro num aviso não interrompe os outros. */
export async function enviarPendentes(deps: DepsAvisos, empresaId?: string) {
    const resultados: Record<string, number> = {};
    for (const id of await deps.repositorio.pendentes(LIMITE_ENVIOS_POR_EXECUCAO, empresaId)) {
        let r: string;
        try { r = await enviarAviso(id, deps); }
        catch { r = 'ERRO_REPROCESSAVEL'; }
        resultados[r] = (resultados[r] ?? 0) + 1;
    }
    return resultados;
}

/** Ciclo do job diário: enfileira os avisos por tempo de todas as empresas e envia os pendentes. */
export async function executarAvisos(deps: DepsAvisos) {
    if (!await deps.repositorio.instalado())
        return { instalado: false as const };
    const enfileiramento = { empresas: 0, criados: 0, existentes: 0, erros: 0 };
    for (const empresaId of await deps.repositorio.empresas()) {
        enfileiramento.empresas++;
        try {
            const r = await enfileirarAvisosDaEmpresa(empresaId, deps);
            enfileiramento.criados += r.criados;
            enfileiramento.existentes += r.existentes;
        }
        catch { enfileiramento.erros++; }
    }
    return { instalado: true as const, enfileiramento, envios: await enviarPendentes(deps) };
}

/** Resultados que exigem atenção humana no relatório do job (saída 2). */
export const exigeAtencao = (relatorio: Awaited<ReturnType<typeof executarAvisos>>) => relatorio.instalado
    && (relatorio.enfileiramento.erros > 0 || Object.keys(relatorio.envios).some((k) => k === 'INCERTO' || k === 'ENVIO_FALHOU' || k.startsWith('ERRO')));
