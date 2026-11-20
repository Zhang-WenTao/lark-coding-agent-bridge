import { spawnSync } from 'node:child_process';
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
  ])('allows %s', (_label, command) => {
    expect(bash(command).code).toBe(0);
  });

  it.each([
    ['touching a file there', `cd ${READ_ONLY} && touch x`],
    ['making a directory there', `cd ${READ_ONLY} && mkdir -p sub`],
    ['copying into it', `cd ${READ_ONLY} && cp /tmp/a .`],
    ['pulling', `cd ${READ_ONLY} && git pull -q`],
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
  ])('refuses %s', (_label, command) => {
    expect(bash(command).code).toBe(2);
  });

  it.each([
    ['reading after cd with stderr silenced', `cd ${READ_ONLY} 2>/dev/null && grep -rn "foo" . | head`],
    ['writing in the workspace after cd -P', `cd -P ${WORKSPACE} && touch x`],
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
  ])('refuses one %s', (_label, command) => {
    expect(run(command).code).toBe(2);
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
