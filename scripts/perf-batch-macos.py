"""Prepare first, then run one bounded foreground batch after the user is ready."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
ORDINARY = ROOT / 'artifacts/local-final-ordinary/Workspace.app'
DRIVER = ROOT / 'artifacts/desktop-perf/Workspace Test.app'
BASELINE = ROOT / 'artifacts/efficiency-followup/baseline/Workspace.app'
HELPER = ROOT / 'artifacts/performance/macos-resources'
SESSION_LOCK = ROOT / 'artifacts/desktop-test/session.lock'
BATCH_LOCK = ROOT / 'artifacts/performance-batches/active.lock'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def executable(app):
    return app / 'Contents/MacOS/agent-workspace'


def matching_apps():
    allowed = {str(executable(app).resolve()) for app in (ORDINARY, DRIVER, BASELINE)}
    return [int(parts[0]) for line in subprocess.check_output(
        ['/bin/ps', '-axo', 'pid=,comm='], text=True).splitlines()
        if len(parts := line.strip().split(None, 1)) == 2 and parts[1] in allowed]


def preflight():
    if sys.platform != 'darwin':
        raise RuntimeError('macOS fixture tools required')
    if SESSION_LOCK.exists() or BATCH_LOCK.exists() or matching_apps():
        raise RuntimeError('Another fixture session has an owner; finish it first')
    with socket.socket() as check:
        check.settimeout(1)
        if check.connect_ex(('127.0.0.1', 4445)) == 0:
            raise RuntimeError('Desktop driver port already has an owner')
    apps = [(ORDINARY, 'org.agentworkspace.performance'),
            (DRIVER, 'org.agentworkspace.desktop-test')]
    if BASELINE.exists():
        apps.append((BASELINE, 'org.agentworkspace.performance'))
    for app, expected in apps:
        actual = subprocess.check_output(['/usr/libexec/PlistBuddy', '-c',
            'Print :CFBundleIdentifier', str(app / 'Contents/Info.plist')], text=True).strip()
        if actual != expected or not app.resolve().is_relative_to(ROOT / 'artifacts'):
            raise RuntimeError('Refusing a non-fixture application')


def git_fixture(project, remote=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')
    def git(*args):
        subprocess.run(['/usr/bin/git', *args], cwd=project, env=env,
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    git('init', '-b', 'main')
    for key, value in [('user.name', 'Performance Fixture'),
                       ('user.email', 'fixture@example.invalid'),
                       ('commit.gpgsign', 'false'),
                       ('core.hooksPath', str(project / '.git/hooks'))]:
        git('config', key, value)
    git('add', '--all')
    git('commit', '-m', 'Fixture baseline')
    if remote:
        git('init', '--bare', str(remote))
        git('remote', 'add', 'origin', str(remote))
        git('push', '--set-upstream', 'origin', 'main')


def verify_source_snapshot(path):
    snapshot = json.loads(path.read_text())
    expected = snapshot['hashes']
    paths = {p for p in subprocess.check_output(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).decode().split('\0')
        if p and (ROOT / p).is_file()}
    if paths != set(expected) or any(digest(ROOT / p) != value for p, value in expected.items()):
        raise RuntimeError('Source inputs differ from the recorded build snapshot; rebuild before preparing')


def prepare(candidate_manifest=None, current_manifest=None):
    preflight()
    sys.path.insert(0, str(ROOT / 'tests/performance'))
    from macos_fixture_ui import ax
    if not ax.AXIsProcessTrusted():
        raise RuntimeError('Existing Accessibility permission is unavailable; no foreground run prepared')
    candidate = json.loads(candidate_manifest.read_text()) if candidate_manifest else None
    current = json.loads(current_manifest.read_text()) if current_manifest else None
    if current:
        verify_source_snapshot(ROOT / current['sourceSnapshot'])
        source = current['applicationSource']
        ordinary_hash = current['ordinaryBinarySha256']
        driver_hash = current['driverBinarySha256']
    else:
        build = json.loads((ROOT / 'artifacts/evidence/build.json').read_text())
        source = candidate['applicationSource'] if candidate else build['applicationSourceCommit']
        if subprocess.check_output(['git', 'diff', source, '--', 'src', 'src-tauri']):
            raise RuntimeError('Production source differs from the frozen build; rebuild before preparing')
        reference = json.loads((ROOT / 'artifacts/evidence/validation.json').read_text())
        ordinary_hash = (candidate['ordinaryBinarySha256'] if candidate else
                         build.get('ordinaryReference', {}).get('executableSha256', reference['nativeQuit']['binarySha256']))
        perf = json.loads((ROOT / 'artifacts/evidence/performance-ui.json').read_text())
        driver_hash = candidate['driverBinarySha256'] if candidate else perf['binarySha256']
    if digest(executable(ORDINARY)) != ordinary_hash:
        raise RuntimeError('Ordinary reference does not match its recorded build')
    if digest(executable(DRIVER)) != driver_hash:
        raise RuntimeError('Optimized driver does not match validated source')
    run = ROOT / 'artifacts/performance-batches' / datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    run.mkdir(parents=True)
    node = subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()
    subprocess.run(['cc', '-O2', '-Wall', '-Wextra', '-Werror',
        'tests/performance/macos-resources.c', '-lproc', '-o', str(HELPER)], check=True)
    content = 'export const greeting = "hello";\n' + '// ordinary cached text line\n' * 3000
    # Use the already exercised controller, but prepare fixtures now and omit
    # its extra stack diagnostic. No preparation or compilation in the run window.
    original = (ROOT / 'tests/performance/ordinary-reference-controller.py').read_text()
    controllers = {}
    cases = [(mode, mode, ORDINARY, source) for mode in ['editor-terminal', 'editor']]
    if candidate:
        prior = json.loads((BASELINE.parent / 'validation.json').read_text())
        if digest(executable(BASELINE)) != prior['nativeQuit']['binarySha256']:
            raise RuntimeError('Frozen baseline does not match its retained validation')
        baseline_source = json.loads((BASELINE.parent / 'build.json').read_text())['applicationSourceCommit']
        cases += [('baseline-' + mode, mode, BASELINE, baseline_source)
                  for mode in ['editor-terminal', 'editor']]
    for case, mode, app, case_source in cases:
        folder = run / case
        project = folder / 'project'
        project.mkdir(parents=True)
        (project / 'hello.ts').write_text(content)
        git_fixture(project)
        script = original.replace("root=Path(__file__).resolve().parents[2]", f'root=Path({str(ROOT)!r})')
        script = script.replace('ui=None', "ui=None\ndef stop_fixture(signum, _frame):\n raise InterruptedError(f'Fixture interrupted by signal {signum}')\nsignal.signal(signal.SIGTERM,stop_fixture)")
        start = script.index("mode=sys.argv[1]")
        end = script.index("data=Path.home()", start)
        script = script[:start] + f"mode={mode!r}\nrun=Path({str(folder)!r})\nproject=run/'project'\n" + script[end:]
        script = script.replace("source=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()", f'source={case_source!r}')
        start = script.index(' # Separate stack sampling')
        end = script.index(' ui.key(12,1<<20)', start)
        script = script[:start] + script[end:]
        script = script.replace("app=(root/'artifacts/local-final-ordinary/Workspace.app').resolve()",
                                f'app=Path({str(app)!r}).resolve()')
        path = folder / 'controller.py'
        path.write_text(script)
        controllers[case] = str(path)
    sandbox = run / 'combined'
    project = sandbox / 'GUI fixture 🌍'
    data = sandbox / 'app-data'
    project.mkdir(parents=True)
    data.mkdir()
    (project / 'hello.ts').write_text(content)
    (project / 'load').mkdir()
    payload = 'search_fixture_bytes\n' * 3200
    for index in range(10000):
        (project / 'load' / f'file-{index}.txt').write_text(payload)
    (project / '.gitignore').write_text('load/\n')
    remote = sandbox / 'remote.git'
    git_fixture(project, remote)
    env = {'AW_DESKTOP_PROJECT': str(project), 'AW_DESKTOP_DATA': str(data),
           'AW_APP_DATA_DIR': str(data), 'AW_DESKTOP_NODE': node,
           'AW_DESKTOP_REMOTE': str(remote), 'AW_DESKTOP_GIT': '/usr/bin/git',
           'SHELL': '/bin/sh', 'ENV': '', 'BASH_ENV': ''}
    for suffix, name in [('TUI', 'terminal-tui.mjs'), ('WRITER', 'terminal-write.mjs'),
                         ('FLOOD', 'terminal-flood.mjs')]:
        shutil.copyfile(ROOT / 'tests/fixtures' / name, sandbox / name)
        env['AW_DESKTOP_' + suffix] = str(sandbox / name)
    (data / 'settings.json').write_text(json.dumps({'version': 1, 'git': '/usr/bin/git',
        'theme': 'dark', 'fontSize': 14, 'shell': '/bin/sh', 'autoSaveIdle': False,
        'autoSaveDelay': 300, 'autoSaveOnFocusLoss': False,
        'recent': [{'id': 'fixture-untrusted', 'root': str(project),
                    'name': 'GUI fixture 🌍', 'trusted': False}]}))
    prepared_environments = {}
    if candidate or current:
        for name in ['workflow', 'stability']:
            fixture = run / name
            folder = fixture / 'GUI fixture 🌍'
            state = fixture / 'app-data'
            folder.mkdir(parents=True)
            state.mkdir()
            (folder / 'hello.ts').write_text('export const greeting = "hello";\n')
            git_fixture(folder, fixture / 'remote.git')
            fixture_env = dict(env, AW_DESKTOP_PROJECT=str(folder), AW_DESKTOP_DATA=str(state),
                               AW_APP_DATA_DIR=str(state), AW_DESKTOP_REMOTE=str(fixture / 'remote.git'))
            for suffix, filename in [('TUI', 'terminal-tui.mjs'), ('WRITER', 'terminal-write.mjs'),
                                     ('FLOOD', 'terminal-flood.mjs')]:
                shutil.copyfile(ROOT / 'tests/fixtures' / filename, fixture / filename)
                fixture_env['AW_DESKTOP_' + suffix] = str(fixture / filename)
            settings = json.loads((data / 'settings.json').read_text())
            settings['recent'][0]['root'] = str(folder)
            (state / 'settings.json').write_text(json.dumps(settings))
            prepared_environments[name] = fixture_env
    startup = (ROOT / 'scripts/perf-desktop.mjs').read_text()
    startup = startup.replace('"./evidence.mjs"', json.dumps(str(ROOT / 'scripts/evidence.mjs')))
    startup = startup.replace('resolve("artifacts/performance")', f'resolve({json.dumps(str(run / "startup-logs"))})')
    startup = startup.replace('const helper = join(output, "macos-resources");', f'const helper = {json.dumps(str(HELPER))};')
    begin = startup.index('  execFileSync("cc", [')
    end = startup.index('  for (let run = 0; run < 20; run++)', begin)
    startup = startup[:begin] + '  // Accounting helper compiled and hashed in batch preparation.\n' + startup[end:]
    (run / 'startup.mjs').write_text(startup)
    manifest = {'applicationSource': source, 'prepared': datetime.datetime.now().isoformat(),
        'node': node, 'ordinaryBinarySha256': digest(executable(ORDINARY)),
        'driverBinarySha256': digest(executable(DRIVER)), 'helperSha256': digest(HELPER),
        'helperSourceSha256': digest(ROOT / 'tests/performance/macos-resources.c'),
        'controllers': controllers, 'combinedEnvironment': env,
        'optimization': bool(candidate), 'preparedEnvironments': prepared_environments,
        'preparedInputs': {str(p): digest(p) for p in [*(Path(x) for x in controllers.values()), run / 'startup.mjs',
            *(ROOT / name for name in ['scripts/perf-batch-macos.py', 'scripts/desktop-test.mjs',
                'scripts/desktop-macos-launcher.mjs', 'scripts/perf-session-macos.mjs',
                'tests/desktop/wdio.conf.ts', 'tests/desktop/workflow.spec.ts',
                'tests/desktop/stability.spec.ts', 'tests/desktop/performance.spec.ts',
                'tests/performance/macos_fixture_ui.py'])]},
        'loadFixture': {'files': 10000, 'bytesPerFile': len(payload.encode()), 'editorBytes': len(content.encode())},
        'windowSeconds': 540, 'expectedMinutes': '6–8',
        'method': 'One serial batch, five original performance measurements. No runtime controls, builds, debug sessions or reruns. Original assertions/deadlines unchanged.'}
    if candidate:
        manifest.update(expectedMinutes='7–9', baselineBinarySha256=digest(executable(BASELINE)),
                        baselineSource=baseline_source,
                        method='One serial A/B resource comparison, unchanged 7-case GUI workflow, 100-cycle stability and combined-load latency. No startup rerun, runtime controls, builds or debugging during the window; original assertions/deadlines retained.')
    if current:
        manifest.update(sourceSnapshot=current['sourceSnapshot'],
                        sourceSnapshotSha256=digest(ROOT / current['sourceSnapshot']),
                        windowSeconds=600, expectedMinutes='7–9')
        if current.get('priorStartupReport'):
            previous = ROOT / current['priorStartupReport']
            measured = json.loads(previous.read_text())
            if (measured['binarySha256'] != ordinary_hash or
                    measured['summary']['launches'] != 20 or
                    not measured['summary']['foregroundEligible']):
                raise RuntimeError('Prior startup result does not certify this exact welcome binary')
            manifest.update(priorStartupReport=current['priorStartupReport'],
                            windowSeconds=480, expectedMinutes='4–6')
            manifest['preparedInputs'][str(previous)] = digest(previous)
    (run / 'prepared.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(str(run), flush=True)


def run_batch(path):
    preflight()
    run = path.resolve()
    if not run.is_relative_to(ROOT / 'artifacts/performance-batches'):
        raise RuntimeError('Expected this repository prepared batch')
    if (run / 'result.json').exists():
        raise RuntimeError('Prepared batch already used; prepare fresh fixtures before arranging another window')
    m = json.loads((run / 'prepared.json').read_text())
    if m.get('sourceSnapshot'):
        snapshot = ROOT / m['sourceSnapshot']
        if digest(snapshot) != m['sourceSnapshotSha256']:
            raise RuntimeError('The source snapshot changed after preparation')
        verify_source_snapshot(snapshot)
    for p, expected in [(executable(ORDINARY), m['ordinaryBinarySha256']),
                        (executable(DRIVER), m['driverBinarySha256']),
                        (HELPER, m['helperSha256']),
                        (ROOT / 'tests/performance/macos-resources.c', m['helperSourceSha256'])]:
        if digest(p) != expected:
            raise RuntimeError('A prepared input changed; prepare again before the hands-off window')
    for p, expected in m['preparedInputs'].items():
        if digest(p) != expected:
            raise RuntimeError('A prepared controller changed; prepare again')
    if m.get('optimization') and digest(executable(BASELINE)) != m['baselineBinarySha256']:
        raise RuntimeError('The frozen comparison baseline changed; prepare again')
    console = subprocess.check_output(['/usr/sbin/ioreg', '-l', '-d', '1'], text=True)
    if re.search(r'"CGSSessionScreenIsLocked"\s*=\s*Yes', console):
        raise RuntimeError('Console is locked; ask the user to prepare before running')
    fd = os.open(BATCH_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.write(fd, str(os.getpid()).encode())
    keepawake = subprocess.Popen(['/usr/bin/caffeinate', '-di', '-w', str(os.getpid())])
    started = time.monotonic()
    report = {'started': datetime.datetime.now().isoformat(), 'applicationSource': m['applicationSource'],
              'userReadiness': 'Explicit Start reply required before invoking this command',
              'windowSeconds': m['windowSeconds'], 'baselineSource': m.get('baselineSource'),
              'optimization': m.get('optimization', False), 'steps': []}
    steps = [
        ('ordinary-editor-terminal', ['python3', m['controllers']['editor-terminal']], {}, None),
        ('ordinary-editor', ['python3', m['controllers']['editor']], {}, None),
        ('stability', ['pnpm', 'test:desktop:stability'], m.get('preparedEnvironments', {}).get('stability', {}), 'artifacts/evidence/desktop/stability.json'),
        ('combined-load', ['pnpm', 'test:desktop:perf'], m['combinedEnvironment'], 'artifacts/evidence/performance-ui.json'),
        ('startup', ['node', str(run / 'startup.mjs'), str(ORDINARY)], {}, 'artifacts/evidence/performance-desktop.json')]
    if m.get('optimization'):
        steps = [
            ('ordinary-baseline-editor-terminal', ['python3', m['controllers']['baseline-editor-terminal']], {}, None),
            ('ordinary-editor-terminal', ['python3', m['controllers']['editor-terminal']], {}, None),
            ('ordinary-baseline-editor', ['python3', m['controllers']['baseline-editor']], {}, None),
            ('ordinary-editor', ['python3', m['controllers']['editor']], {}, None),
            ('workflow', ['pnpm', 'test:desktop'], m['preparedEnvironments']['workflow'], None),
            ('stability', ['pnpm', 'test:desktop:stability'], m['preparedEnvironments']['stability'], 'artifacts/evidence/desktop/stability.json'),
            ('combined-load', ['pnpm', 'test:desktop:perf'], m['combinedEnvironment'], 'artifacts/evidence/performance-ui.json')]
    elif m.get('priorStartupReport'):
        # Retry only unfinished measurements; the same binary's completed
        # startup run is retained and checksummed in the prepared inputs.
        steps = [step for step in steps if step[0] != 'startup']
        report['priorStartupReport'] = m['priorStartupReport']
    child = None
    def save():
        (run / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    def interrupted(signum, _frame):
        raise InterruptedError(f'Interrupted by signal {signum}')
    for sig in [signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, interrupted)
    try:
        for index, (name, command, extra, output) in enumerate(steps, 1):
            remaining = m['windowSeconds'] - (time.monotonic() - started)
            if remaining < 15:
                raise TimeoutError('Announced window reached; no further tests will start')
            until = time.monotonic() + 3
            while (SESSION_LOCK.exists() or matching_apps()) and time.monotonic() < until:
                time.sleep(0.1)
            if SESSION_LOCK.exists() or matching_apps():
                raise RuntimeError('Previous fixture did not cleanly finish; no surprise retry')
            print(f'START {index}/{len(steps)} {name}', flush=True)
            env = {**os.environ, 'AW_DESKTOP_PACKAGED': '1', 'AW_REQUIRE_GPU': '1',
                   'AW_PERF_SOURCE': m['applicationSource'], **extra}
            # A setup failure may not write a report. Preserve the prior report
            # separately so it can never be attributed to this run.
            if output and Path(output).exists():
                shutil.move(output, run / (name + '-previous-report.json'))
            begin = time.monotonic()
            with (run / (name + '.txt')).open('w') as log:
                child = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT,
                                         start_new_session=True)
                code = child.wait(timeout=remaining)
            row = {'name': name, 'exitCode': code, 'elapsedSeconds': time.monotonic() - begin,
                   'log': name + '.txt'}
            if output and Path(output).exists():
                shutil.copyfile(output, run / (name + '.json'))
                row['report'] = name + '.json'
            elif name.startswith('ordinary'):
                mode = name.removeprefix('ordinary-')
                original = run / mode / 'resource-report.json'
                if original.exists():
                    row['report'] = str(original.relative_to(run))
            if 'report' in row:
                measured = json.loads((run / row['report']).read_text())
                if name.startswith('ordinary'):
                    row['acceptance'] = measured.get('acceptance')
                elif name == 'combined-load':
                    row['summary'] = measured.get('summary')
                    row['acceptance'] = measured.get('idleSession', {}).get('budgets')
                elif name == 'stability':
                    row['retainedGrowth'] = measured.get('retainedGrowth')
                else:
                    row['summary'] = measured.get('summary')
                    row['limits'] = 'Welcome-only launch measurement; not working-project acceptance'
            report['steps'].append(row)
            save()
            print(f'END {index}/{len(steps)} {name} exit={code}', flush=True)
        report['hasFailingMeasurements'] = any(
            step['exitCode'] != 0 or any(value is False for value in (step.get('acceptance') or {}).values())
            for step in report['steps'])
        report['status'] = ('COMPLETED_WITH_BUDGET_FAILURES' if report['hasFailingMeasurements']
                            else ('COMPLETED; no startup certification implied' if m.get('optimization')
                                  else 'COMPLETED; startup remains a welcome-only subset'))
    except BaseException as error:
        report['status'] = 'STOPPED; no automatic reruns'
        report['failure'] = str(error)
        raise
    finally:
        if child and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        # These exact, preflight-exclusive paths are private fixture identities.
        # Never target the user's ordinary Workspace app or unrelated processes.
        for pid in matching_apps():
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        report['elapsedSeconds'] = time.monotonic() - started
        report['finished'] = datetime.datetime.now().isoformat()
        save()
        keepawake.terminate()
        keepawake.wait()
        os.close(fd)
        BATCH_LOCK.unlink()
        print('HANDS-OFF WINDOW FINISHED — the computer is free to use.', flush=True)
        print(str(run / 'result.json'), flush=True)
    return 1 if report.get('hasFailingMeasurements') else 0


if len(sys.argv) == 2 and sys.argv[1] == 'prepare':
    prepare()
elif len(sys.argv) == 4 and sys.argv[1:3] == ['prepare', '--candidate']:
    prepare(Path(sys.argv[3]))
elif len(sys.argv) == 4 and sys.argv[1:3] == ['prepare', '--current']:
    prepare(current_manifest=Path(sys.argv[3]))
elif len(sys.argv) == 3 and sys.argv[1] == 'run':
    sys.exit(run_batch(Path(sys.argv[2])))
else:
    raise SystemExit('Usage: source scripts/env.sh; python3 scripts/perf-batch-macos.py prepare [--candidate|--current <build-manifest>]|run <prepared-directory>')
