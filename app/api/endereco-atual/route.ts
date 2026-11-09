import { NextResponse, type NextRequest } from 'next/server';
import { diagnosticarEndereco } from '@/lib/enderecos/diagnostico';

export const dynamic = 'force-dynamic';

/** Diagnóstico da troca de host (plano D4): sem banco, sem cookies e sem o valor de nenhuma variável. */
export function GET(request: NextRequest) {
  return NextResponse.json(diagnosticarEndereco(request.headers.get('host'), process.env), {
    headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}
