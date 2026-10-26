"""Build isolated SPZ3 candidates with finer SH bins; leave other bytes intact.

Quantization semantics checked against Spark 2.4.0 (MIT), rust/spark-lib/src/spz.rs:
https://github.com/sparkjsdev/spark/tree/ffe210dc0a45d0515a06c9235878108112827d61
"""
from pathlib import Path
import gzip
import hashlib
import json
import struct
import subprocess
import time
import zlib
import numpy as np


def quantize_sh(coefficients, bits):
    """Round ties away from zero before rounding to the selected byte bucket."""
    scaled = np.asarray(coefficients, dtype=np.float32) * 128
    rounded = np.copysign(np.floor(np.abs(scaled) + 0.5), scaled) + 128
    bucket = 2 ** (8 - np.asarray(bits))
    return np.clip(np.floor((rounded + bucket / 2) / bucket) * bucket, 0, 255).astype('u1')


def read_sh(ply):
    end = ply.index(b'end_header\n') + len(b'end_header\n')
    header = ply[:end].decode('ascii').splitlines()
    if 'format binary_little_endian 1.0' not in header:
        raise ValueError('Expected binary little-endian PLY')
    properties = [line.split() for line in header if line.startswith('property')]
    if not all(p[:2] == ['property', 'float'] for p in properties):
        raise ValueError('Expected float properties')
    names = [p[-1] for p in properties]
    count = int(next(line.split()[-1] for line in header if line.startswith('element vertex ')))
    rows = np.frombuffer(ply[end:], dtype='<f4').reshape(count, len(names))
    indices = [names.index(f'f_rest_{i}') for i in range(45)]
    sh = rows[:, indices].reshape(count, 3, 15).transpose(0, 2, 1).reshape(count, 45)
    if not np.isfinite(sh).all():
        raise ValueError('Non-finite SH')
    # Match the intermediate GsplatArray representation used by transcodeSpz.
    return sh.astype('f2').astype('f4')


def replace_sh(raw, sh):
    if len(raw) < 16:
        raise ValueError('Truncated SPZ header')
    magic, version, count, degree, fractional_bits, flags, reserved = struct.unpack('<IIIBBBB', raw[:16])
    if (magic, version, degree, fractional_bits, flags, reserved) != (0x5053474e, 3, 3, 12, 1, 0):
        raise ValueError('Expected non-LoD Spark SPZ3 / SH3 / 12 fractional bits')
    if sh.shape != (count, 45) or len(raw) != 16 + count * 65:
        raise ValueError('SPZ/PLY count or body length mismatch')
    offset = 16 + count * 20
    control = quantize_sh(sh, [5] * 9 + [4] * 36).tobytes()
    if raw[offset:] != control:
        raise ValueError('SH control does not reproduce every source byte')
    result = raw[:offset] + quantize_sh(sh, 8).tobytes()
    assert result[:offset] == raw[:offset]
    return result, offset


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    root = Path(__file__).resolve().parents[1]
    assert Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=root, text=True).strip()) == root
    previous = json.loads((root / 'docs/benchmarks/spz-format-2026-10-26.json').read_text())
    output = root / '.qa/spz-sh8'
    output.mkdir(exist_ok=True)
    rows = []
    for scene in ('pipes', 'office'):
        expected = next(x for x in previous['assets'] if x['scene'] == scene)
        compressed = (root / f'.qa/{scene}-candidate.spz').read_bytes()
        ply = gzip.decompress((root / f'public/scenes/{scene}/gaussians.ply.gz').read_bytes())
        assert digest(compressed) == expected['spzSha256']
        assert digest(ply) == expected['plySha256']
        raw = gzip.decompress(compressed)
        start = time.perf_counter()
        sh = read_sh(ply)
        candidate_raw, offset = replace_sh(raw, sh)
        candidate = gzip.compress(candidate_raw, compresslevel=6, mtime=0)
        preparation_ms = (time.perf_counter() - start) * 1000
        control = gzip.compress(raw, compresslevel=6, mtime=0)
        path = output / f'{scene}-sh8.spz'
        if path.exists() and path.read_bytes() != candidate:
            raise ValueError(f'Refusing to overwrite a different candidate: {path}')
        path.write_bytes(candidate)
        assert gzip.decompress(candidate) == candidate_raw
        decoded = (quantize_sh(sh, 8).astype('f4') - 128) / 128
        rows.append({
            'scene': scene, 'count': len(sh), 'shDegree': 3, 'shBits': 8,
            'candidate': path.relative_to(root).as_posix(),
            'sourceSpzSha256': digest(compressed), 'plySha256': digest(ply),
            'candidateSha256': digest(candidate), 'rawSha256': digest(candidate_raw),
            'unchangedPrefixBytes': offset, 'unchangedPrefixSha256': digest(raw[:offset]),
            'shControlByteIdentical': True, 'nonShByteIdentical': True,
            'originalSpzBytes': len(compressed), 'recompressedControlBytes': len(control),
            'candidateBytes': len(candidate), 'rawBytes': len(candidate_raw),
            'coefficients': sh.size, 'outsideByteRange': int(np.sum((sh < -1) | (sh > 127 / 128))),
            'maxShErrorVsHalf': float(np.max(np.abs(decoded - sh))),
            'preparationMs': preparation_ms,
        })
    report = {'method': 'SPZ3 SH-only 8-bit replacement; all original 5/4-bit SH bytes must match before writing',
              'zlibVersion': zlib.ZLIB_VERSION, 'gzipLevel': 6, 'gzipMtime': 0,
              'timingScope': 'One CPU sample per scene: PLY SH extraction, quantization/control check, candidate gzip; excludes file input, initial decompression and control gzip',
              'assets': rows}
    (output / 'preparation.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
