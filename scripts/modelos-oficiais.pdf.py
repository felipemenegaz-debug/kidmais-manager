"""QA dos PDFs de teste: texto, fontes reais, margens, integridade e renderização."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pdfplumber

root = Path('.tmp/modelos-oficiais')
cases = json.loads((root / 'resultados.json').read_text(encoding='utf-8'))
assert len(cases) == 6
poppler = shutil.which('pdftoppm')
if not poppler:
    raise RuntimeError('pdftoppm precisa estar disponível para a inspeção visual.')
results = []
for case in cases:
    file = Path(case['path'])
    assert hashlib.sha256(file.read_bytes()).hexdigest() == case['pdfHash']
    with pdfplumber.open(file) as pdf:
        assert len(pdf.pages) == 3
        all_text = '\n'.join(p.extract_text() for p in pdf.pages)
        normalized = ' '.join(all_text.split())
        assert ('1 ano.' if case['versao'] == 1 else '2 anos.') in normalized
        assert '1 anos.' not in normalized
        assert 'se houver estoque disponível' in normalized
        assert 'O funcionamento do espaço do subsolo e do buffet terminará 30 minutos antes' in normalized
        assert 'os parabéns serão cantados' in normalized
        assert '45 (quarenta e cinco) minutos' in normalized
        assert 'se houve estoque disponível' not in normalized
        for n in range(1, 19):
            assert f'Cláusula {n}ª' in all_text
        assert case['modelo'] in all_text
        first = pdf.pages[0]
        words = first.extract_words(extra_attrs=['fontname'])
        bold = ' '.join(w['text'] for w in words if 'Bold' in w['fontname'])
        name = {'ESSENCIAL': 'Festa Essencial', 'COMPLETA': 'Festa Completa', 'PREMIUM': 'Festa Premium'}[case['codigo']]
        assert name in bold
        assert '50 pessoas' in bold
        assert f"R$ {case['tarifa']},00 por pessoa excedente" in bold
        date = file.name.split('-')[1:4]
        assert '/'.join(reversed(date)) in bold
        for page in pdf.pages:
            assert all(40 <= c['x0'] <= c['x1'] <= 560 and 15 <= c['top'] <= c['bottom'] <= 815 for c in page.chars)
    prefix = root / (file.stem + '-pagina')
    render = subprocess.run([poppler, '-scale-to', '1100', '-png', str(file), str(prefix)], capture_output=True)
    assert render.returncode == 0, render.stderr.decode(errors='replace')
    assert len(list(root.glob(prefix.name + '-*.png'))) == 3
    results.append({**case, 'paginas': 3, 'negrito': True, 'margens': True, 'hash': True})
(root / 'qualidade-pdf.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
print('PASSOU: 6 documentos, 18 páginas; modelos, negrito, cláusulas, margens e hashes.')
