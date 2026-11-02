"""Download pinned public model artifacts; never execute remote model code."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request

REPOS = {
    'whisper': ('ggerganov/whisper.cpp', '5359861c739e955e79d9a303bcbc70fb988958b1'),
    'sherpa': ('csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
               '98590b7ed6443e77b714204da2757d75e1a642f4'),
    'transformers': ('onnx-community/whisper-base', '1846881b6b3a3024392c1eea3ad983695bc23925'),
}


def fetch(root):
    jobs = []
    records = []
    for label, (repo, revision) in REPOS.items():
        with urllib.request.urlopen(f'https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true', timeout=60) as response:
            metadata = json.load(response)
        folder = root / label
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'source-metadata.json').write_text(json.dumps(metadata, indent=2))
        for entry in metadata['siblings']:
            name = entry['rfilename']
            selected = name in ('README.md', 'LICENSE')
            if label == 'whisper':
                selected |= name in ('ggml-base.bin', 'ggml-small.bin', 'ggml-large-v3-turbo-q5_0.bin')
            elif label == 'sherpa':
                selected |= name in ('tokens.txt', 'bpe.vocab') or (name.endswith('.onnx') and name.startswith(('encoder-', 'decoder-', 'joiner-')))
            else:
                selected |= '/' not in name and name.endswith(('.json', '.txt'))
                selected |= name in ('onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx')
            if selected:
                jobs.append((folder, repo, revision, entry))

    def download(job):
        folder, repo, revision, entry = job
        name = entry['rfilename']
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        expected = entry.get('lfs', {}).get('sha256')
        if not path.exists():
            url = f'https://huggingface.co/{repo}/resolve/{revision}/{name}'
            temporary = path.with_suffix(path.suffix + '.part')
            with urllib.request.urlopen(url, timeout=120) as response, temporary.open('wb') as out:
                while chunk := response.read(1024 * 1024):
                    out.write(chunk)
            temporary.replace(path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if expected and digest != expected:
            raise ValueError(f'Checksum mismatch: {path}')
        print(f'Verified {folder.name}/{name}: {path.stat().st_size}', flush=True)
        return {'path': str(path.relative_to(root)), 'repo': repo, 'revision': revision,
                'bytes': path.stat().st_size, 'sha256': digest, 'upstream_sha256': expected}

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        records = list(pool.map(download, jobs))
    (root / 'manifest.json').write_text(json.dumps(records, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    fetch(parser.parse_args().root)
