// A separate parent watches the API's pipe. Graceful group termination lets Xvfb
// remove its socket/lock; forced termination bounds cleanup even for stuck apps.
export const DESKTOP_SUPERVISOR_SOURCE = `
const { spawn } = require('node:child_process');
process.umask(0o077);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try { process.kill(-process.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } }, 500);
}
process.on('SIGTERM', stop);
process.on('disconnect', stop);
process.stdin.resume();
process.stdin.on('end', stop);
const spec = JSON.parse(process.argv[1]);
const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env, stdio: 'ignore', shell: false });
child.once('error', stop);
child.once('exit', stop);
`;
