"""Real native menu termination in an ordinary, isolated performance bundle."""
import datetime
import hashlib
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import time

if sys.platform != 'darwin' or len(sys.argv) != 2:
    raise SystemExit('Usage on macOS: python3 scripts/test-native-quit-macos.py artifacts/<isolated>/Workspace.app')

repo = pathlib.Path(__file__).resolve().parents[1]
os.chdir(repo)
sys.path.insert(0, str(repo / 'tests/performance'))
from macos_fixture_ui import FixtureUi, NoControl

app = pathlib.Path(sys.argv[1]).resolve()
executable = app / 'Contents/MacOS/agent-workspace'
identifier = subprocess.check_output([
    '/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleIdentifier', str(app / 'Contents/Info.plist')
], text=True).strip()
assert identifier == 'org.agentworkspace.performance' and app.is_relative_to(repo / 'artifacts')
assert not subprocess.check_output(['/usr/bin/lsappinfo', 'find', 'bundleID=org.agentworkspace.performance'], text=True).strip(), 'Another isolated performance application is already running'
assert not any(str(executable) == line.strip().split(None, 1)[-1] for line in subprocess.check_output(
    ['/bin/ps', '-axo', 'pid=,comm='], text=True).splitlines())
run = repo / 'artifacts/native-quit' / str(time.time_ns())
run.mkdir(parents=True, exist_ok=True)
project = run / 'project'
project.mkdir()
file = project / 'file.txt'
file.write_text('original fixture text\n')
canary = 'NATIVE_QUIT_GUARD_' + str(time.time_ns())
data = pathlib.Path.home() / 'Library/Application Support/org.agentworkspace.performance'
data.mkdir(parents=True, exist_ok=True, mode=0o700)
settings_path = data / 'settings.json'
original_settings = settings_path.read_bytes() if settings_path.exists() else None
backup_path = data / 'settings.bak'
original_backup = backup_path.read_bytes() if backup_path.exists() else None
settings = json.loads(original_settings) if original_settings else {
    'version': 2, 'git': '/usr/bin/git', 'theme': 'dark', 'fontSize': 14, 'recent': []}
settings.update(shell='/bin/sh', shellArgs=[], autoSaveIdle=False, autoSaveOnFocusLoss=False)
lock = repo / 'artifacts/desktop-test/session.lock'
fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.write(fd, str(os.getpid()).encode())
report = {'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'binarySha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
          'profile': 'ordinary no-driver bundle; real AX actions and targeted native Command+Q',
          'limits': 'Synthetic OS events, not physical keyboard/IME certification', 'checks': []}
ui = None


def save():
    (run / 'result.json').write_text(json.dumps(report, indent=2) + '\n')


def wait_for(predicate, description, seconds=15):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.1)
    raise RuntimeError('Timed out: ' + description)


def press(name):
    def attempt():
        try:
            ui.press(name)
            return True
        except NoControl:
            return False  # no mutation was attempted
    wait_for(attempt, 'control ' + name)


def launch(number):
    stderr = run / f'launch-{number}.stderr'
    stdout = run / f'launch-{number}.stdout'
    stderr.write_text('')
    subprocess.run(['/usr/bin/open', '-n', '-a', str(app), '--stdout', str(stdout),
                    '--stderr', str(stderr), '--env', 'ENV=', '--env', 'BASH_ENV=',
                    '--args', str(project)], check=True)
    pid = None
    def started():
        nonlocal pid
        match = re.search(r'startup_ready_ms=.*?pid=(\d+)', stderr.read_text())
        if match:
            pid = int(match[1])
        return pid is not None
    wait_for(started, 'painted startup')
    result = FixtureUi(pid)
    wait_for(lambda: result.has('Open requested folder'), 'native folder offer')
    return result


def live_shells():
    sample = json.loads(subprocess.check_output([
        str(repo / 'artifacts/performance/macos-resources'), str(ui.pid)]))
    return [member['pid'] for member in sample['members'] if subprocess.check_output(
        ['/bin/ps', '-p', str(member['pid']), '-o', 'comm='], text=True).strip() == '/bin/sh']


def quit_request():
    ui.key(12, 1 << 20)


try:
    settings_path.write_text(json.dumps(settings))
    settings_path.chmod(0o600)
    ui = launch(1)
    press('Open folder')
    press('Trust folder')
    wait_for(lambda: ui.has('Trust this folder'), 'trust decision')
    quit_request()
    time.sleep(0.5)
    assert ui.alive() and ui.has('Trust this folder'), 'Quit must wait behind trust, without dismissing it'
    report['checks'].append('native quit leaves the pending trust decision intact')
    press('Trust folder')
    wait_for(lambda: not ui.alive(), 'queued safe quit after trust')
    ui = launch(2)
    press('Open folder')
    # Open the file through the public Quick open UI and keyboard list selection.
    press('Quick open ⌘P')
    wait_for(lambda: ui.has('File name'), 'quick-open field')
    ui.focus('File name')
    ui.key(0, text='file.txt')
    wait_for(lambda: ui.field_equals('File name', 'file.txt'), 'filename query acknowledgement')
    press('Search')
    wait_for(lambda: ui.has('file.txt:1'), 'quick-open result')
    ui.focus('Search results')
    ui.key(36)
    wait_for(lambda: ui.has('Editor content'), 'real editor')
    press('New terminal')
    wait_for(lambda: len(live_shells()) == 1, 'live owned shell')
    shells = live_shells()
    ui.focus('Editor content')
    ui.key(0, text=canary)
    def acknowledged():
        return any(canary in p.read_text() for p in data.glob('recovery-*.json'))
    wait_for(acknowledged, 'durable editor checkpoint')
    assert file.read_text() == 'original fixture text\n'
    # Quit always attempts the checked save, independent of idle/focus toggles.
    # A real parent-directory denial exercises the unresolved-work decision.
    project.chmod(0o500)
    quit_request()
    wait_for(lambda: ui.has('Unsaved changes before quitting'), 'dirty quit guard')
    quit_request()
    time.sleep(0.4)
    assert ui.has('Unsaved changes before quitting')
    press('Cancel')
    assert ui.alive() and live_shells() == shells
    report['checks'].append('dirty and repeated native quit cancel without stopping the shell')
    quit_request()
    wait_for(lambda: ui.has('Unsaved changes before quitting'), 'second dirty quit guard')
    press('Save all and quit')
    wait_for(lambda: ui.has('Terminate terminals and quit'), 'owned-job quit guard')
    press('Cancel')
    assert ui.alive() and live_shells() == shells
    assert file.read_text() == 'original fixture text\n'
    report['checks'].append('terminal cancellation preserves both the unsaved buffer and the live shell')
    project.chmod(0o700)
    quit_request()
    wait_for(lambda: ui.has('Unsaved changes before quitting'), 'confirmed dirty quit guard')
    press('Save all and quit')
    press('Terminate and quit')
    wait_for(lambda: not ui.alive(), 'acknowledged safe application exit')
    assert file.read_text() == canary + 'original fixture text\n'
    for pid in shells:
        assert subprocess.run(['/bin/ps', '-p', str(pid)], capture_output=True).returncode != 0
    report['checks'].append('confirmed quit saves the exact edit and terminates owned PTYs before exit')
    ui = launch(3)
    press('Open folder')
    wait_for(lambda: ui.has('Editor content'), 'restored saved document')
    assert live_shells() == [], 'Restart must not launch/replay terminal sessions'
    quit_request()
    wait_for(lambda: not ui.alive(), 'clean native quit')
    report['checks'].append('restart restores the saved editor and starts no shell or command')
    report['status'] = 'PASS'
except Exception as error:
    report['status'] = 'FAIL'
    report['failure'] = str(error)
    if ui and ui.alive():
        report['uiAtFailure'] = ui.describe()
    raise
finally:
    project.chmod(0o700)
    save()
    if ui and ui.alive():
        # Only this verified isolated fixture is terminated after a failed test.
        os.kill(ui.pid, signal.SIGTERM)
        time.sleep(0.5)
        if ui.alive():
            os.kill(ui.pid, signal.SIGKILL)
    if settings_path.exists():
        (run / 'settings-after.json').write_bytes(settings_path.read_bytes())
    if original_settings is not None:
        settings_path.write_bytes(original_settings)
    else:
        settings_path.unlink(missing_ok=True)
    if original_backup is not None:
        backup_path.write_bytes(original_backup)
    else:
        backup_path.unlink(missing_ok=True)
    os.close(fd)
    lock.unlink()
print(json.dumps({'status': report['status'], 'checks': report['checks'], 'report': str(run / 'result.json')}, indent=2))
