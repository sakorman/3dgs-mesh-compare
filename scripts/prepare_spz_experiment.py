"""Prepare an isolated SPZ/PLY viewer; default models and loader stay unchanged."""
from pathlib import Path
import os
import subprocess

root = Path(__file__).resolve().parents[1]
assert Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=root, text=True).strip()) == root
source = subprocess.check_output(['git', 'show', 'db828fa:src/viewer.ts'], cwd=root, text=True)
source = source.replace('from "./', 'from "../src/')
old = 'const bytes = await readPlyResponse(res, load.signal);'
assert source.count(old) == 1
source = source.replace(old, '''const bytes = id.endsWith("-spz")
            ? await res.arrayBuffer()
            : await readPlyResponse(res, load.signal);''')
assert source.count('fileType: SplatFileType.PLY,') == 1
source = source.replace('fileType: SplatFileType.PLY,', 'fileType: id.endsWith("-spz") ? SplatFileType.SPZ : SplatFileType.PLY,')
scratch = root / '.qa'
scratch.mkdir(exist_ok=True)
(scratch / 'spz-viewer.ts').write_text(source)
for scene in ('pipes', 'office'):
    original = root / 'public' / 'scenes' / scene / 'gaussians.ply.gz'
    link = scratch / f'{scene}-gaussians.bin'
    if not link.exists():
        os.link(original, link)
    elif not os.path.samefile(original, link):
        raise RuntimeError(f'Unexpected existing fixture: {link}')
print('Prepared isolated SPZ viewer and raw gzip links')
