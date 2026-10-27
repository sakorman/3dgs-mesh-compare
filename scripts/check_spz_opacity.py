"""Audit SPZ3 opacity bytes against the pinned SH8 experiment inputs."""
from pathlib import Path
import gzip
import hashlib
import json
import subprocess
import numpy as np


def main():
    root = Path(__file__).resolve().parents[1]
    assert Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=root, text=True).strip()) == root
    previous = json.loads((root / 'docs/benchmarks/spz-sh8-2026-10-27.json').read_text())
    results = []
    for asset in previous['preparation']['assets']:
        scene, count = asset['scene'], asset['count']
        ply = gzip.decompress((root / f'public/scenes/{scene}/gaussians.ply.gz').read_bytes())
        assert hashlib.sha256(ply).hexdigest() == asset['plySha256']
        compressed = (root / asset['candidate']).read_bytes()
        assert hashlib.sha256(compressed).hexdigest() == asset['candidateSha256']
        raw = gzip.decompress(compressed)
        end = ply.index(b'end_header\n') + len(b'end_header\n')
        header = ply[:end].decode('ascii').splitlines()
        properties = [x.split() for x in header if x.startswith('property')]
        assert 'format binary_little_endian 1.0' in header
        assert all(x[:2] == ['property', 'float'] for x in properties)
        names = [x[-1] for x in properties]
        rows = np.frombuffer(ply[end:], dtype='<f4').reshape(count, len(names))
        alpha = (1 / (1 + np.exp(-rows[:, names.index('opacity')]))).astype('f2').astype('f4')
        # Spark GsplatArray stores sigmoid opacity as f16 before SPZ's u8 rounding.
        control = np.floor(np.clip(alpha * 255, 0, 255) + .5).astype('u1')
        actual = np.frombuffer(raw[16 + 9 * count:16 + 10 * count], dtype='u1')
        assert np.isfinite(alpha).all() and np.array_equal(control, actual)
        decoded = (actual.astype('f4') / 255).astype('f2').astype('f4')
        results.append({
            'scene': scene, 'count': count, 'plySha256': asset['plySha256'],
            'sh8Sha256': asset['candidateSha256'], 'alphaControlBytesEqual': True,
            'positiveRoundedToZero': int(np.sum((alpha > 0) & (actual == 0))),
            'sourceZero': int(np.sum(alpha == 0)),
            'maxAbsErrorVsHalf': float(np.max(abs(decoded - alpha))),
            'meanAbsErrorVsHalf': float(np.mean(abs(decoded - alpha))),
            'meanSignedError': float(np.mean(decoded - alpha)),
            'alphaMin': float(alpha.min()), 'alphaMax': float(alpha.max()),
        })
    print(json.dumps({'method': 'CPU opacity-byte audit: sigmoid f32, f16 intermediate, u8 SPZ control, f16 decoded error; not a rendered-error bound', 'numpyVersion': np.__version__, 'assets': results}, indent=2))


if __name__ == '__main__':
    main()
