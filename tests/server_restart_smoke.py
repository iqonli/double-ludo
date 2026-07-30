import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = 18768
BASE = f'http://127.0.0.1:{PORT}'
CONFIG = {
    'mode': 'classic',
    'playerAColors': ['red', 'yellow'],
    'protectedColors': [],
    'launchValues': [5, 6],
    'tripleSixPenalty': True,
    'firstPlayer': 'A',
}


def request(path, body=None, raw=None):
    if raw is not None:
        data = raw
    elif body is not None:
        data = json.dumps(body).encode('utf-8')
    else:
        data = None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST' if data is not None else 'GET',
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            payload = response.read()
            return response.status, json.loads(payload.decode('utf-8')) if payload else None
    except urllib.error.HTTPError as error:
        payload = error.read()
        return error.code, json.loads(payload.decode('utf-8')) if payload else None


def start_server(data_dir):
    env = os.environ.copy()
    env['PORT'] = str(PORT)
    env['DATA_DIR'] = str(data_dir)
    process = subprocess.Popen(
        ['node', 'server.js'], cwd=ROOT, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    deadline = time.time() + 8
    while time.time() < deadline:
        try:
            if request('/api/info')[0] == 200:
                return process
        except Exception:
            pass
        time.sleep(0.1)
    process.terminate()
    raise RuntimeError('服务器启动超时')


def stop_server(process):
    process.terminate()
    try:
        return process.communicate(timeout=5)[0]
    except subprocess.TimeoutExpired:
        process.kill()
        return process.communicate()[0]


def main():
    result = {'ok': False, 'checks': {}, 'logs': []}
    with tempfile.TemporaryDirectory(prefix='double-flight-restart-') as temp:
        first = start_server(temp)
        status, opened = request('/api/admin/open', {})
        assert status == 200
        old_codes = opened['codes']
        _, login = request('/api/login', {'code': old_codes['A']})
        _, login_b = request('/api/login', {'code': old_codes['B']})
        token = login['sessionToken']
        request('/api/lobby-ready', {'sessionToken': login_b['sessionToken'], 'ready': True})
        _, started = request('/api/start-game', {'sessionToken': token, 'config': CONFIG})
        _, moved = request('/api/action', {
            'sessionToken': token,
            'clientActionId': 'restart-smoke-roll',
            'expectedVersion': started['version'],
            'expectedStateHash': started['stateHash'],
            'actionCode': 0,
        })
        saved_hash = moved['stateHash']
        chat_status, chat_payload = request('/api/chat', {
            'sessionToken': token,
            'content': '异常重启后仍应保留\n第二行',
        })
        assert chat_status == 200
        saved_chat_version = chat_payload['chatVersion']

        bad_status, bad_payload = request('/api/login', raw=b'{bad json')
        info_status, _ = request('/api/info')
        result['checks']['malformedJsonHandled'] = bad_status == 400 and bad_payload['error'] == 'INVALID_JSON' and info_status == 200
        result['logs'].append(stop_server(first))

        autosave = Path(temp) / 'autosave.json'
        result['checks']['autosaveWritten'] = autosave.exists() and autosave.stat().st_size > 100

        second = start_server(temp)
        _, restored = request('/api/admin/status')
        result['checks']['gameRestored'] = restored['roomStatus'] == 'playing' and restored['stateHash'] == saved_hash
        result['checks']['chatRestored'] = restored['chatVersion'] == saved_chat_version and restored['chatCount'] == 1
        result['checks']['sessionsNotRestored'] = restored['connected'] == {'A': False, 'B': False}
        result['checks']['newFiveDigitCodes'] = (
            restored['codes']['A'].isdigit() and len(restored['codes']['A']) == 5
            and restored['codes']['B'].isdigit() and len(restored['codes']['B']) == 5
            and restored['codes']['A'] != restored['codes']['B']
            and (restored['codes']['A'] != old_codes['A'] or restored['codes']['B'] != old_codes['B'])
        )
        result['logs'].append(stop_server(second))

    result['ok'] = all(result['checks'].values())
    out = ROOT / 'tests/server-restart-smoke.json'
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['ok'] else 1)


if __name__ == '__main__':
    main()
