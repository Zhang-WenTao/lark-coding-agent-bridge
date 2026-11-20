import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bridgeRoot,
  claudeGuardArgs,
  guestAccessInstruction,
  ownerOnlyGuard,
  restrictedChatGuard,
} from '../../../src/policy/owner-guard';

// Read-only work a guest run must be able to do, taken from real refusals
// (2026-11-13 … 11-19), and the fences around it that must hold.

const HOME = '/Users/someone';
const LC = `${HOME}/.lark-channel`;
const NOTES = `${LC}/profiles/claude/knowledge/notes`;
const WORKSPACE = `${HOME}/.lark-channel-workspaces/claude/default`;
const OPEN = `${HOME}/Desktop/coding/lark/alphaess`;
const READ_ONLY = `${HOME}/Desktop/coding/alphaess/platform_EMS3.6`;
const PROJECTS = `${HOME}/.claude/projects/-Users-someone--lark-channel-workspaces-claude-default`;
const SESSION = '022f2620-4999-4f41-9e65-7a7bd22254ee';
const CHAT = 'oc_c621c11eb11376e882a49104f08906fe';
const ROOT = bridgeRoot();

const guard = ownerOnlyGuard({
  larkChannelHome: LC,
  guestRoots: ['~/Desktop/coding/lark/alphaess'],
  guestReadOnlyRoots: ['~/Desktop/coding/alphaess/platform_EMS3.6'],
  workspace: WORKSPACE,
  home: HOME,
  root: ROOT,
  chatId: CHAT,
});

function hook(
  g: typeof guard,
  toolName: string,
  toolInput: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): { code: number | null; stderr: string } {
  const { env } = claudeGuardArgs(g);
  const res = spawnSync(process.execPath, [g.hookScript], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: WORKSPACE, ...extra }),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: res.status, stderr: res.stderr };
}
const bash = (command: string, extra?: Record<string, unknown>) => hook(guard, 'Bash', { command }, extra);
const session = { session_id: SESSION, transcript_path: `${PROJECTS}/${SESSION}.jsonl` };

describe('guest runs: knowledge notes', () => {
  it.each([
    ['a shared note by full path', `grep -n -i "锁定" ${NOTES}/global/antelope-company-members.md | head -80`],
    ['a shared layer without the trailing slash', `ls ${NOTES}/global | head -200`],
    ['the external layer', `cat ${NOTES}/global-external/antelope-dispatch-control.md`],
    ['searching the shared layers', `grep -ril "注册" ${NOTES}/global ${NOTES}/global-external ${NOTES}/external`],
    ["this chat's own notes", `ls ${NOTES}/${CHAT}/`],
    ["this chat's topic notes", `cat ${NOTES}/${CHAT}_omt_1a2b/x.md`],
  ])('reads %s', (_label, command) => {
    expect(bash(command).code).toBe(0);
  });

  it.each([
    ["the owner's layer", `cat ${NOTES}/global-owner/x.md`],
    ["another chat's notes", `cat ${NOTES}/oc_other/x.md`],
    ['the whole notes tree', `grep -ril "x" ${NOTES}`],
    ['a glob that takes in the owner layer', `grep -ril "x" ${NOTES}/global*`],
    ['the notes root after cd', `cd ${NOTES}; grep -ril "x" .`],
    ["the owner's layer after cd", `cd ${NOTES}; cat global-owner/x.md`],
  ])('refuses %s', (_label, command) => {
    expect(bash(command).code).toBe(2);
  });

  it('tells the agent how to read the notes instead', () => {
    const res = bash(`cd ${NOTES}; ls global/`);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('<notesDir>/global/');
  });

  it('reads a shared note with the Read tool, and not the owner layer', () => {
    expect(hook(guard, 'Read', { file_path: `${NOTES}/global/a.md` }).code).toBe(0);
    expect(hook(guard, 'Grep', { pattern: 'x', path: `${NOTES}/global` }).code).toBe(0);
    expect(hook(guard, 'Read', { file_path: `${NOTES}/global-owner/a.md` }).code).toBe(2);
  });
});

describe('guest runs: names that only start like a fenced path', () => {
  it.each([
    ['its own workspace', `cd ${WORKSPACE}/8473risk && rm -f t.tsv && python3 scan.py eur`],
    ['a file in its workspace', `rm -f ${WORKSPACE}/tmp_sn_times.py ${WORKSPACE}/tmp_resp.py`],
    ['listing its workspace', `ls -lt ${WORKSPACE} | head -20`],
    ['writing into its workspace', `echo x > ${WORKSPACE}/out.txt`],
  ])('allows %s', (_label, command) => {
    expect(bash(command).code).toBe(0);
  });

  it.each([
    ['a sibling of the bridge home', `cat ${LC}-backup/config.json`],
    ['the bridge config', `cat ${LC}/config.json`],
    ['the bridge logs', `ls ${LC}/profiles/claude/logs`],
  ])('still refuses %s', (_label, command) => {
    expect(bash(command).code).toBe(2);
  });
});

describe('guest runs: code and regexes are not paths', () => {
  it.each([
    ['an awk range', `cd ${OPEN}/antelope/support-hub/src/main && awk '/id="pageQuery"/,/<\\/select>/' f.xml`],
    [
      'a sed range',
      `cd ${OPEN}/antelope && sed -n '/id="selectHead"/,/<\\/select>/p' a/src/main/resources/mapper/M.xml`,
    ],
    ['a sed substitution', `cd /tmp/8473risk && sed -i '' 's/message:(a OR b\\*)/message:(a OR c*)/' scan.py`],
    ['python splitting on a slash', `echo '{}' | python3 -c 'import sys; print("a/b/c".split("/")[-3])'`],
    ['a jq default', `lark-cli im +messages-reply --as bot --message-id om_x --file ./a.html -q '.data.message_id // .'`],
  ])('allows %s', (_label, command) => {
    expect(bash(command).code).toBe(0);
  });

  it.each([
    ['find over the disk', 'find / -name "*.pem"'],
    ['ls of a quoted root', 'ls "/"'],
    ['a walker on the root before a pipe', 'ls /|head'],
    ['python opening a private file', `python3 -c 'print(open("${HOME}/.ssh/id_rsa").read())'`],
  ])('still refuses %s', (_label, command) => {
    expect(bash(command).code).toBe(2);
  });
});

describe('guest runs: writes after cd into a read-only place', () => {
  it.each([
    [
      'a temp file elsewhere',
      `cd ${READ_ONLY} && mkdir -p /tmp/8473risk && cat > /tmp/8473risk/q1.sql <<'EOF'\nSELECT 1\nEOF\nbash scripts/q.sh --file /tmp/8473risk/q1.sql`,
    ],
    ['then cd elsewhere and write', `cd ${READ_ONLY} && cd /tmp && touch x`],
    ['reading only', `cd ${READ_ONLY} && git log -3 && cat a.c`],
    // 主人 11-20：fetch 只动 .git 里的远程跟踪分支，不算写。
    ['fetching', `cd ${READ_ONLY} && git fetch -q origin dev 2>&1 | tail -2; git log -1 origin/dev`],
    ['fetching all with prune', `git -C ${READ_ONLY} fetch --all --prune --tags`],
    ['fetching by url', `cd ${READ_ONLY} && git fetch https://github.com/a/b.git dev && git fetch git@github.com:a/b.git`],
    ['remote update', `cd ${READ_ONLY} && git remote update`],
  ])('allows %s', (_label, command) => {
    expect(bash(command).code).toBe(0);
  });

  it.each([
    ['touching a file there', `cd ${READ_ONLY} && touch x`],
    ['making a directory there', `cd ${READ_ONLY} && mkdir -p sub`],
    ['copying into it', `cd ${READ_ONLY} && cp /tmp/a .`],
    ['pulling', `cd ${READ_ONLY} && git pull -q`],
    ['fetching into a local branch', `cd ${READ_ONLY} && git fetch origin dev:dev`],
    ['force-fetching a refspec', `cd ${READ_ONLY} && git fetch origin +dev`],
    ['fetching with upload-pack', `cd ${READ_ONLY} && git fetch --upload-pack='touch /tmp/x' origin`],
    ['fetching with a config override', `cd ${READ_ONLY} && git -c core.sshCommand='sh -c x' fetch`],
    ['fetching with update-head-ok', `cd ${READ_ONLY} && git fetch -u origin`],
    ['fetching with set-upstream', `cd ${READ_ONLY} && git fetch --set-upstream origin dev`],
    ['checking out', `cd ${READ_ONLY} && git fetch && git checkout dev`],
    ['redirecting into it', `cd ${READ_ONLY} && echo x > out.txt`],
    ['editing in place', `cd ${READ_ONLY} && sed -i '' 's/a/b/' a.c`],
  ])('refuses %s', (_label, command) => {
    expect(bash(command).code).toBe(2);
  });
});

describe("guest runs: the run's own tool output", () => {
  const own = `${PROJECTS}/${SESSION}/tool-results/bkik4m1hf.txt`;
  const other = `${PROJECTS}/696b2473-03fa-45c9-b7fb-62e08c1eb594/tool-results/b9rqaoqq5.txt`;

  it('reads what this session saved', () => {
    expect(bash(`grep -v "x" ${own} | head`, session).code).toBe(0);
    expect(hook(guard, 'Read', { file_path: own }, session).code).toBe(0);
  });

  it("refuses another session's output and the memory next to it", () => {
    expect(bash(`cat ${other}`, session).code).toBe(2);
    expect(hook(guard, 'Read', { file_path: other }, session).code).toBe(2);
    expect(bash(`cat ${PROJECTS}/memory/MEMORY.md`, session).code).toBe(2);
  });

  it('ignores a session id that climbs out', () => {
    const evil = { session_id: '../memory', transcript_path: `${PROJECTS}/x.jsonl` };
    expect(bash(`cat ${PROJECTS}/memory/MEMORY.md`, evil).code).toBe(2);
  });

  it('reads it in a restricted chat that fences ~/.claude', () => {
    const fenced = restrictedChatGuard(guard, { deniedCommands: [], deniedPaths: ['~/.claude'] });
    expect(hook(fenced, 'Bash', { command: `cat ${own}` }, session).code).toBe(0);
    expect(hook(fenced, 'Bash', { command: `cat ${other}` }, session).code).toBe(2);
  });
});

describe('guest runs: refusals point at what is open', () => {
  it('lists the open places when a guessed path is outside them', () => {
    const res = bash(`ls ${HOME}/Desktop/coding/lark`);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(OPEN);
    expect(res.stderr).toContain(READ_ONLY);
  });
});

describe('guest runs: owner-only commands are matched in what runs, not in what is searched', () => {
  const g = ownerOnlyGuard({
    larkChannelHome: LC,
    guestRoots: ['~/Desktop/coding/lark/alphaess'],
    workspace: WORKSPACE,
    home: HOME,
    root: ROOT,
    deniedCommands: ['\\bkubectl\\s+delete\\b', '(?i:insert\\s+into\\b)'],
  });
  const run = (command: string) => hook(g, 'Bash', { command }).code;

  it.each([
    ['a git grep for an insert', `cd ${OPEN}/antelope && git grep -n -i "insert into d_x\\|INSERT INTO d_y" | head`],
    ['a grep for a kubectl verb', `grep -rn "kubectl delete" ${OPEN}/antelope/docs`],
    ['an rg for an insert', `rg -n 'INSERT INTO d_charging_piles' ${OPEN}/antelope`],
    ['an escaped backtick in the pattern', `git grep -n -i "insert into d_x\\|INSERT INTO \\\`\\?d_x" | head`],
  ])('allows %s', (_label, command) => {
    expect(run(command)).toBe(0);
  });

  it.each([
    ['the command itself', 'kubectl delete pod x'],
    ['a write through a client', 'mysql -e "INSERT INTO t VALUES (1)"'],
    ['a command substituted into a search', 'grep -r x $(kubectl delete pod y)'],
    ['a search piped into the command', 'grep -l x f | xargs kubectl delete pod'],
    ['a backtick that runs in the pattern', 'grep -r "`kubectl delete pod y`" .'],
  ])('refuses %s', (_label, command) => {
    expect(run(command)).toBe(2);
  });
});

describe('guest runs: told where to look', () => {
  it('names the open places, read-only ones marked, and how to read notes', () => {
    const text = guestAccessInstruction(guard) ?? '';
    expect(text).toContain('可读写：~/Desktop/coding/lark/alphaess、~/.lark-channel-workspaces/claude/default');
    expect(text).toMatch(/只读[^\n]*~\/Desktop\/coding\/alphaess\/platform_EMS3\.6/);
    expect(text).toContain('<notesDir>/global <notesDir>/global-external');
  });

  it("follows a restricted chat's fences", () => {
    const chat = restrictedChatGuard(guard, {
      deniedCommands: [],
      deniedPaths: ['~/Desktop'],
      readOnlyPaths: ['~/Desktop/coding/lark/alphaess'],
    });
    expect(chat.openDirs).toEqual([
      { path: OPEN, readOnly: true },
      { path: WORKSPACE, readOnly: false },
    ]);
    const res = hook(chat, 'Bash', { command: `ls ${HOME}/.occam` });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(`${OPEN}（只读）`);
    expect(res.stderr).not.toContain(READ_ONLY);
  });

  it('has nothing to say to the owner in a restricted chat', () => {
    const owner = restrictedChatGuard(undefined, { deniedCommands: [], deniedPaths: ['~/Desktop'] }, { home: HOME });
    expect(owner.openDirs).toBeUndefined();
    expect(guestAccessInstruction(owner)).toBeUndefined();
  });
});

// Review 2026-11-20: shapes of `cd` into a read-only root that the precise
// cd tracking first missed, piped-to-shell searches, and the own tool output.
describe('guest runs: writing from inside a read-only root', () => {
  it.each([
    ['cd with stderr silenced', `cd ${READ_ONLY} 2>/dev/null && touch x`],
    ['cd with stdout silenced', `cd ${READ_ONLY} >/dev/null; touch x`],
    ['cd -P', `cd -P ${READ_ONLY} && touch x`],
    ['cd -L', `cd -L ${READ_ONLY} && touch x`],
    ['cd --', `cd -- ${READ_ONLY} && touch x`],
    ['redirect glued to the path', `cd ${READ_ONLY}>/dev/null && touch x`],
    ['pushd', `pushd ${READ_ONLY} && touch x`],
    ['a target built from a variable', `cd "$D"${READ_ONLY} && touch x`],
    ['ln with one path (link lands in cwd)', `cd ${READ_ONLY} && ln -s /tmp/evil`],
    ['cd inside a subshell', `( cd ${READ_ONLY} && touch x )`],
    ['cd inside braces', `{ cd ${READ_ONLY}; touch x; }`],
    ['cd as an if condition', `if cd ${READ_ONLY}; then touch x; fi`],
    ['builtin cd', `builtin cd ${READ_ONLY} && touch x`],
    ['command cd', `command cd ${READ_ONLY} && touch x`],
    ['git pull in a loop body', `cd ${READ_ONLY} && echo 1 | while read n; do git pull -q origin; done`],
    ['git archive -o into it', `cd ${READ_ONLY} && git archive -o out.tar HEAD`],
    ['a subshell cd elsewhere does not move the outer shell', `cd ${READ_ONLY} && (cd /tmp && ls) && touch x`],
  ])('refuses %s', (_label, command) => {
    expect(bash(command).code).toBe(2);
  });

  it.each([
    ['reading after cd with stderr silenced', `cd ${READ_ONLY} 2>/dev/null && grep -rn "foo" . | head`],
    ['writing in the workspace after cd -P', `cd -P ${WORKSPACE} && touch x`],
    ['writing after a subshell cd into it ended', `( cd ${READ_ONLY} && ls ) && touch x`],
    ['git archive to stdout in a subshell', `cd /tmp && (cd ${READ_ONLY} && git archive HEAD docs) | tar -x -C /tmp/x`],
  ])('allows %s', (_label, command) => {
    expect(bash(command).code).toBe(0);
  });
});

describe('guest runs: searches whose output is run', () => {
  const g = ownerOnlyGuard({
    larkChannelHome: LC,
    workspace: WORKSPACE,
    home: HOME,
    root: ROOT,
    deniedCommands: ['kubectl\\s+delete'],
  });
  const run = (command: string) => hook(g, 'Bash', { command });

  it('still lets a search look for the text', () => {
    expect(run(`grep -rn "kubectl delete" ${WORKSPACE}`).code).toBe(0);
  });

  it.each([
    ['piped into sh', `grep -oh 'kubectl delete pod x' ${WORKSPACE}/f | sh`],
    ['run through $()', `$(grep -oh 'kubectl delete pod' ${WORKSPACE}/f)`],
    ['$() inside double quotes around single quotes', `grep "a'$(kubectl delete pod x)'b" ${WORKSPACE}/f`],
    ['fed to xargs', `grep -oh 'kubectl delete pod x' ${WORKSPACE}/f | xargs -I{} sh -c {}`],
    ['piped into sudo -u … sh', `grep -oh 'kubectl delete pod x' ${WORKSPACE}/f | sudo -u u sh`],
    ['eval of a substitution', `eval "$(grep -oh 'kubectl delete pod x' ${WORKSPACE}/f)"`],
    ['sourced through <()', `source <(grep -oh 'kubectl delete pod x' ${WORKSPACE}/f)`],
    ['a variable holding the output run as the command', `c=$(grep -oh 'kubectl delete pod x' ${WORKSPACE}/f); $c`],
    ['bash -c of a substitution', `bash -c "$(grep -oh 'kubectl delete pod x' ${WORKSPACE}/f)"`],
  ])('refuses one %s', (_label, command) => {
    expect(run(command).code).toBe(2);
  });

  // Review 2026-11-20 (R1): ordinary searches that only mention xargs, $(),
  // source or a /source/ path must still search for the text.
  it.each([
    ['find | xargs grep', `find ${WORKSPACE} -name '*.ts' | xargs grep -n "kubectl delete"`],
    ['xargs -0 grep -l', `find ${WORKSPACE} -print0 | xargs -0 grep -l "kubectl delete"`],
    ['cd $(git rev-parse) then grep', `cd $(git rev-parse --show-toplevel) && grep -rn "kubectl delete" .`],
    ['a path named source', `grep -rn "kubectl delete" ${WORKSPACE}/docs/source`],
    ['an option named --source', `rg -n "kubectl delete" --sort path ${WORKSPACE} --source x`],
    ['source venv then grep', `source venv/bin/activate && grep -rn "kubectl delete" ${WORKSPACE}`],
    ['a pattern with | sh inside', `grep -rnE "kubectl delete|foo | sh" ${WORKSPACE}`],
    ['grep piped into wc', `grep -rn "kubectl delete" ${WORKSPACE} | wc -l`],
  ])('allows %s', (_label, command) => {
    expect(run(command).code).toBe(0);
  });
});

describe("guest runs: the run's own tool output is never writable", () => {
  const dir = `${PROJECTS}/${SESSION}/tool-results`;
  it.each([
    ['a redirect into it', `echo hi > ${dir}/a`],
    ['removing it', `rm -rf ${dir}`],
    ['a symlink placed in it', `ln -s ../../../../settings.json ${dir}/s`],
    ['writing after cd into it', `cd ${dir} && touch x`],
  ])('refuses %s', (_label, command) => {
    expect(bash(command, session).code).toBe(2);
  });

  it('still reads it', () => {
    expect(bash(`cat ${dir}/a.txt`, session).code).toBe(0);
  });
});

describe('guest runs: scripts the run wrote itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-script-'));
  const file = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const sneakyShell = file('a.sh', `#!/bin/bash\ncat ${HOME}/.ssh/id_rsa\n`);
  const sneakyNoExt = file('run', `#!/bin/sh\ntouch ${READ_ONLY}/x\n`);
  const sneakyPy = file('a.py', `print(open("${HOME}/.occam/tasks/x/out.json").read())\n`);
  const sneakyHome = file('b.py', `import os\nprint(open(os.path.expanduser("~/Documents/secret.txt")).read())\n`);
  const plainPy = file('ok.py', `import json\nprint(json.dumps({"a": 1}))\n`);
  const plainSh = file('ok.sh', `#!/bin/bash\nset -e\nls ${OPEN}\necho done > /tmp/guard-ok.txt\n`);

  it.each([
    ['a shell script reading a private file', `bash ${sneakyShell}`],
    ['the same through source', `source ${sneakyShell}`],
    ['a script run by path, shebang decides', `chmod +x ${sneakyNoExt} && ${sneakyNoExt}`],
    ['a python script naming a private path', `python3 ${sneakyPy}`],
    ['a python script reaching outside the open places', `cd ${dir} && python3 b.py`],
    ['a heredoc written then run', `cat > /tmp/z.sh <<'EOF'\ncat ${HOME}/.ssh/id_rsa\nEOF\nbash /tmp/z.sh`],
    ['a heredoc python written then run', `cat > /tmp/z.py <<'EOF'\nopen("${HOME}/.ssh/id_rsa")\nEOF\npython3 /tmp/z.py`],
  ])('refuses %s', (_label, command) => {
    expect(bash(command).code).toBe(2);
  });

  it.each([
    ['a plain python script', `python3 ${plainPy}`],
    ['a plain shell script', `bash ${plainSh}`],
    ['inline python', `python3 -c 'print(1)'`],
    ['a heredoc note next to an unrelated script', `cat > /tmp/n.md <<'EOF'\n见 ${HOME}/.ssh\nEOF\npython3 ${plainPy}`],
    ['a skill script in a read-only place (the owner wrote it)', `bash ${READ_ONLY}/scripts/q.sh sea mysql "select 1"`],
    ['a script that does not exist yet', `python3 /tmp/guard-missing-${process.pid}.py`],
  ])('allows %s', (_label, command) => {
    expect(bash(command).code).toBe(0);
  });
});

describe("guest runs: a repository's own scripts", () => {
  const base = mkdtempSync(join(tmpdir(), 'guard-repo-'));
  const run = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  run(base, 'init', '-q', '--bare', 'origin.git');
  run(base, 'clone', '-q', 'origin.git', 'work');
  const work = join(base, 'work');
  run(work, 'config', 'user.email', 't@example.com');
  run(work, 'config', 'user.name', 't');
  writeFileSync(join(work, 'check.sh'), `#!/bin/bash\ncat ${HOME}/.ssh/known_hosts | wc -l\n`);
  run(work, 'add', 'check.sh');
  run(work, 'commit', '-qm', 'x');
  run(work, 'push', '-q', 'origin', 'HEAD');

  it('runs one that matches upstream as it is', () => {
    expect(bash(`bash ${work}/check.sh`).code).toBe(0);
  });

  it('checks it again once it is edited locally', () => {
    writeFileSync(join(work, 'check.sh'), `#!/bin/bash\ncat ${HOME}/.ssh/id_rsa\n`);
    expect(bash(`bash ${work}/check.sh`).code).toBe(2);
  });
});
