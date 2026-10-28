from pathlib import Path
import sys,subprocess,os,json,re,time,signal,hashlib
root=Path(__file__).resolve().parents[2];os.chdir(root)
sys.path.insert(0,str(root/'tests/performance'))
from macos_fixture_ui import FixtureUi,NoControl
app=(root/'artifacts/local-final-ordinary/Workspace.app').resolve()
source=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
assert not subprocess.check_output(['/usr/bin/lsappinfo','find','bundleID=org.agentworkspace.performance'],text=True).strip()
mode=sys.argv[1] if len(sys.argv)>1 else 'editor-terminal'
assert mode in ['editor','editor-terminal']
run=root/('artifacts/local-final-ordinary-profile-'+mode);run.mkdir(exist_ok=False)
project=run/'project';project.mkdir()
(project/'hello.ts').write_text('export const greeting = "hello";\n'+'// ordinary cached text line\n'*3000)
assert (project/'hello.ts').stat().st_size<=100*1024
subprocess.run(['/usr/bin/git','init','-b','main',str(project)],stdout=subprocess.DEVNULL,check=True)
for key,value in [('user.name','Reference fixture'),('user.email','fixture@example.invalid'),('commit.gpgsign','false')]:
 subprocess.run(['/usr/bin/git','-C',str(project),'config',key,value],check=True)
subprocess.run(['/usr/bin/git','-C',str(project),'add','hello.ts'],check=True)
subprocess.run(['/usr/bin/git','-C',str(project),'commit','-m','Reference baseline'],stdout=subprocess.DEVNULL,check=True)
data=Path.home()/'Library/Application Support/org.agentworkspace.performance'; data.mkdir(exist_ok=True)
paths=[data/'settings.json',data/'settings.bak']; backups={p:p.read_bytes() if p.exists() else None for p in paths}
settings=json.loads(backups[paths[0]]) if backups[paths[0]] else {'version':2,'git':'/usr/bin/git','theme':'dark','fontSize':14,'recent':[]}
settings.update(shell='/bin/sh',shellArgs=[],autoSaveIdle=False,autoSaveOnFocusLoss=False)
ui=None

def wait(check,label):
 end=time.monotonic()+15
 while time.monotonic()<end:
  if check():return
  time.sleep(.1)
 raise RuntimeError('Timed out '+label)

def press(label):
 def attempt():
  try:ui.press(label);return True
  except NoControl:return False
 wait(attempt,label)

try:
 paths[0].write_text(json.dumps(settings));paths[0].chmod(0o600)
 stderr=run/'launch.stderr';stderr.write_text('')
 subprocess.run(['/usr/bin/open','-n','-a',str(app),'--stderr',str(stderr),'--stdout',str(run/'launch.stdout'),'--env','ENV=','--env','BASH_ENV=','--args',str(project)],check=True)
 wait(lambda:re.search(r'startup_ready_ms=.*?pid=(\d+)',stderr.read_text()),'painted startup')
 pid=int(re.search(r'startup_ready_ms=.*?pid=(\d+)',stderr.read_text())[1]);ui=FixtureUi(pid)
 wait(lambda:ui.has('Open requested folder'),'folder offer');press('Open folder')
 press('Trust folder');wait(lambda:ui.has('Trust this folder'),'trust question');press('Trust folder')
 press('Quick open Double Shift');wait(lambda:ui.has('File name'),'query')
 ui.focus('File name');ui.key(0,text='hello.ts');wait(lambda:ui.field_equals('File name','hello.ts'),'query ack');press('Search')
 wait(lambda:ui.has('hello.ts:1'),'result');ui.focus('Search results');ui.key(36)
 wait(lambda:ui.has('Editor content'),'editor')
 if mode=='editor-terminal':
  press('New terminal');wait(lambda:ui.has('Terminal input'),'terminal')
 ui.focus('Editor content')
 result=subprocess.run(['node','scripts/perf-session-macos.mjs',str(pid),source,'hello.ts',mode])
 (run/'profile-exit.json').write_text(json.dumps({'exitCode':result.returncode,'source':source,'fixtureBytes':(project/'hello.ts').stat().st_size,'pid':pid})+'\n')
 (run/'resource-report.json').write_bytes((root/'artifacts/evidence/performance-session.json').read_bytes())
 # Separate stack sampling begins only after the timed idle reference completes.
 members=json.loads(subprocess.check_output([str(root/'artifacts/performance/macos-resources'),str(pid)]))['members']
 for member in members:
  command=subprocess.check_output(['/bin/ps','-p',str(member['pid']),'-o','comm='],text=True).strip()
  if 'com.apple.WebKit.WebContent' in command:
   subprocess.run(['/usr/bin/sample',str(member['pid']),'3','-file',str(run/'webcontent-idle.sample')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
 ui.key(12,1<<20)
 if mode=='editor-terminal':
  wait(lambda:ui.has('Terminate terminals and quit'),'terminal quit');press('Terminate and quit')
 wait(lambda:not ui.alive(),'safe quit')
finally:
 if ui and ui.alive():
  # Only our isolated unchanged reference process, no user jobs.
  os.kill(ui.pid,signal.SIGTERM)
 for p,content in backups.items():
  if content is None:p.unlink(missing_ok=True)
  else:p.write_bytes(content);p.chmod(0o600)
