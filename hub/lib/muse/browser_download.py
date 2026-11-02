"""Human-only Chromium HEAD/GET. Never called by the AI tool/MCP surface."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit
from urllib.request import Request, ProxyHandler, HTTPRedirectHandler, build_opener

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('download_extras', HERE / 'extras.py')
extras = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extras)


def destinations(row):
    expected = 'https://cdn.playwright.dev/builds/cft/' + row['version'] + '/mac-arm64/chrome-mac-arm64.zip'
    if row['url'] != expected:
        raise ValueError('unknown Chromium download URL format')
    return (expected, 'https://storage.googleapis.com/chrome-for-testing-public/' + row['version'] + '/mac-arm64/chrome-mac-arm64.zip')


class FixedRedirects(HTTPRedirectHandler):
    def __init__(self, allowed):
        self.allowed = allowed

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if newurl not in self.allowed:
            raise ValueError('unapproved download redirect')
        # urllib normally turns redirected HEAD into GET. Preserve the approved verb.
        return Request(newurl, headers={'Accept-Encoding': 'identity'}, method=req.get_method())


def response_size(response):
    values = response.headers.get_all('Content-Length', [])
    if len(values) != 1 or not values[0].isascii() or not values[0].isdigit():
        raise ValueError('one exact Content-Length required')
    size = int(values[0])
    if not 0 < size <= extras.MAX_ARCHIVE_BYTES or response.headers.get('Content-Encoding', 'identity') != 'identity':
        raise ValueError('download size or encoding')
    return size


def download(taskroot, reader=input, *, opener=None):
    if not all(stream.isatty() for stream in (sys.stdin, sys.stdout, sys.stderr)):
        raise ValueError('human terminal required')
    root = Path(taskroot)
    row = extras._local_lock(root)['chromium']
    if row.get('sha256') is not None:
        raise ValueError('archive already fixed; no second download')
    urls = destinations(row)
    attempt = root / 'chromium-download'
    extras._fresh(attempt)
    archive = root / 'extras-archives' / Path(urlsplit(row['url']).path).name
    extras._fresh(archive)
    notice = '公開SHAはありません。取得後に記録したSHA-256で以後固定します。照会と取得は別承認。導入・ブラウザ起動・Facebook送信はしません。'
    if not extras._approve({'operation': 'Chromium容量照会HEADのみ', 'destinations': urls, 'max_response_body_bytes': 0, 'notice': notice}, reader):
        return {'cancelled': True, 'network_started': False}
    core = extras._core()
    attempt.mkdir(mode=0o700)  # Exclusive claim after approval; concurrent attempts stop.
    core.save(attempt / 'intent.json', json.dumps({'operation': 'HEAD', 'destinations': urls, 'started': time.time()}, sort_keys=True))
    opener = opener or build_opener(ProxyHandler({}), FixedRedirects(urls))
    with opener.open(Request(urls[0], headers={'Accept-Encoding': 'identity'}, method='HEAD'), timeout=30) as response:
        if response.status != 200 or response.geturl() not in urls:
            raise ValueError('HEAD response')
        size = response_size(response)
    core.save(attempt / 'head.json', json.dumps({'url': row['url'], 'bytes': size, 'sha256': None}, sort_keys=True))
    candidate = {key: row[key] for key in ('url', 'executable_relative_path')}
    candidate['bytes'] = size
    if not extras._approve({'operation': 'Chromiumアーカイブ1回取得GET', 'destinations': urls, 'bytes': size, 'sha256': '取得後に記録し以後固定。公開値との照合はできません。', 'notice': notice}, reader):
        return {'cancelled': True, 'head_bytes': size, 'notice': '照会記録を保持。再照会・再取得は自動で行いません。'}
    core.save(attempt / 'get-intent.json', json.dumps(candidate, sort_keys=True))
    core.private_dir(archive.parent)
    fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    digest = hashlib.sha256()
    count = 0
    start = time.monotonic()
    # Partial archive and intent remain on failure; unknown results are never retried.
    with os.fdopen(fd, 'wb') as output, opener.open(Request(urls[0], headers={'Accept-Encoding': 'identity'}, method='GET'), timeout=30) as response:
        if response.status != 200 or response.geturl() not in urls or response_size(response) != size:
            raise ValueError('GET changed size or destination')
        while True:
            chunk = response.read(min(65536, size - count + 1))
            if not chunk:
                break
            count += len(chunk)
            if count > size or time.monotonic() - start > 600:
                raise ValueError('download quota or deadline exceeded')
            output.write(chunk)
            digest.update(chunk)
        if count != size:
            raise ValueError('incomplete download')
        output.flush()
        os.fsync(output.fileno())
    candidate['sha256'] = digest.hexdigest()
    candidate_path = attempt / 'archive-candidate.json'
    core.save(candidate_path, json.dumps(candidate, sort_keys=True))
    core.save(attempt / 'receipt.json', json.dumps({'archive': str(archive), 'candidate': candidate, 'hash_basis': 'locally recorded after download; no published reference digest'}, sort_keys=True))
    return {'downloaded': True, 'candidate_json': str(candidate_path), 'bytes': size, 'sha256': candidate['sha256'], 'next_action': '本人メニュー13で固定値を確認・登録し、14で展開。実行はまだしません。'}


if __name__ == '__main__':
    try:
        print(json.dumps(download(Path(sys.argv[1])), ensure_ascii=False))
    except (Exception, KeyboardInterrupt):
        print('Chromiumの照会・取得を停止しました。部分ファイルと実行記録を保持し、原因確認前の再取得はしません。', file=sys.stderr)
        sys.exit(2)
