#!/usr/bin/env node
// Claude Code PreToolUse hook that lark-channel-bridge installs on runs started
// by someone other than the bot owner. Two fences:
//
// 1. Owner-only areas (`rules`): the bridge CLI and launchd, the bridge's
//    source and private data, and writes into the agent's own instructions,
//    memory and skills.
// 2. File scope: inside the owner's home, only `allowedRoots` (the projects
//    opened to others, the run's workspace, skills, attachments) may be read
//    or written. Everything else under home is the owner's alone; paths
//    outside home (system dirs, /tmp) are not fenced. Read-only projects
//    (`access.guestReadOnlyRoots`) are allowed roots that also carry a
//    `write` rule: readable, but nothing may write into them.
//
// Config arrives in LARK_CHANNEL_GUARD as JSON:
//   { "home": "/Users/x",
//     "rules": [{ "path": "/abs", "bash": "any" | "write", "allow": ["regex"] }],
//     "allowedRoots": ["/abs", …], "allowPatterns": ["regex", …],
//     "deniedCommands": ["regex", …] }
// `deniedCommands` are owner-only commands of this deployment (GitHub CLI,
// Jira writes, device control …), from `access.guestDeniedCommands`.
//
// A restricted chat (`access.restrictedChats`) adds its own commands and
// paths for every run there, the owner's included, plus two keys:
//   "deniedContent": ["regex", …]  — also refused in what file tools write
//                                     and in the paths they touch
//   "refusal": "…"                  — the only answer to give when refused
//
// Exit 2 with a reason on stderr blocks the call; Claude shows the reason to
// the model. String matching, not a sandbox: it stops the plain ways of doing
// it, and the agent is told the same rules in its system prompt.

import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

const CONTROL = /\blark-channel-bridge\b|\blaunchctl\b|bridge-restart-when-idle|bridge_watchdog/;
const WRITE_VERB =
  /^(?:sudo\s+)?(?:\w+=\S*\s+)*(?:cp|mv|rm|rmdir|ln|chmod|chown|touch|mkdir|install|truncate|rsync|unlink|tee|patch|git|dd)\b/;
// Git subcommands that only read the repository, so read-only projects
// (`access.guestReadOnlyRoots`) can still be browsed with git.
const GIT_PREFIX =
  /^(?:sudo\s+)?(?:\w+=\S*\s+)*git\s+(?:(?:-C|-c)\s+\S+\s+|--no-pager\s+|--(?:git-dir|work-tree)=\S+\s+)*/;
const GIT_READ = new RegExp(
  `${GIT_PREFIX.source}(?:log|show|diff|grep|blame|ls-files|ls-tree|cat-file|rev-parse|rev-list|describe|shortlog|merge-base|name-rev|status|count-objects|for-each-ref|show-ref|ls-remote|check-ignore|whatchanged|cherry|version)(?![\\w-])`,
);
// Subcommands that also have writing forms: only their listing forms read.
const GIT_CALL = new RegExp(`${GIT_PREFIX.source}([\\w-]+)(.*)$`);
const IN_PLACE = /\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i/;
const RELATIVE_REDIRECT = /(?:^|[^<>&\d])>{1,2}\s*(?!\/|&|\$|~)\S/;
const BARE_CD = /(?:^|[;&|]\s*)cd\s*(?:$|[;&|])/;
const FILE_TOOLS = {
  Read: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path', 'pattern'],
  Grep: ['path', 'glob'],
};
const WRITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(command, home) {
  return command
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .replace(/(^|[\s'"=:(])~(?=\/|$|\s)/g, `$1${home}`);
}

function within(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Is `path` (absolute, resolved) open to a run the owner didn't start? */
function inScope(path, cfg) {
  const home = cfg.home;
  // Outside home: system dirs, /tmp, mounted volumes — not the owner's files.
  // Home itself and its ancestors ("/", "/Users") would expose all of it.
  if (!within(path, home) && !within(home, path)) return true;
  if ((cfg.allowedRoots ?? []).some((root) => within(path, root))) return true;
  return (cfg.allowPatterns ?? []).some((re) => new RegExp(`^${re}`).test(path));
}

// Commands that walk or read whatever path they are given: a bare `/` after
// one of these really means the whole disk (`find / -name`, `grep -r x /`).
const PATH_WALKER =
  /^(?:find|ls|du|tree|cd|pushd|cat|less|more|head|tail|grep|egrep|fgrep|rg|ag|ack|fd|locate|mdfind|tar|zip|rsync|scp|cp|mv|rm|chmod|chown|stat|file|open|xargs|wc|strings|sort|diff)$/;

/**
 * A run of slashes standing alone between spaces — "SEA / EUR" in report text,
 * jq's `a // b` — is prose or an operator, not the root directory, unless a
 * command that takes paths comes earlier in the same shell segment.
 */
function isLoneSlash(cmd, start, end) {
  const before = start === 0 ? ' ' : cmd[start - 1];
  const after = end >= cmd.length ? ' ' : cmd[end];
  if (!/\s/.test(before) || !/\s/.test(after)) return false;
  const segment = cmd.slice(0, start).split(/&&|\|\||;|\||\n/).pop() ?? '';
  return !segment
    .split(/\s+/)
    .map((w) => w.replace(/^[\s'"`({[$]+/, '').split('/').pop() ?? '')
    .some((w) => PATH_WALKER.test(w));
}

/** Path-like words of a shell command, resolved against `cwd`. */
function commandPaths(cmd, cwd) {
  const out = [];
  for (const m of cmd.matchAll(/[^\s;|&<>()'"`=,]+/g)) {
    const token = m[0].replace(/^[{[]+|[}\],:]+$/g, '');
    if (!token || /^[a-z][a-z0-9+.-]*:\/\//i.test(token)) continue;
    if (!(token.startsWith('/') || token.startsWith('.') || token.includes('/'))) continue;
    if (token.startsWith('-')) continue;
    if (/^\/+$/.test(m[0]) && isLoneSlash(cmd, m.index, m.index + m[0].length)) continue;
    out.push(isAbsolute(token) ? resolve(token) : resolve(cwd, token));
  }
  return out;
}

/** Does `segment` mention `rule.path` outside its allowed sub-paths? */
function mentions(segment, rule) {
  let from = 0;
  for (;;) {
    const at = segment.indexOf(rule.path, from);
    if (at === -1) return false;
    const rest = segment.slice(at);
    const allowed = (rule.allow ?? []).some((re) => new RegExp(`^${re}`).test(rest));
    if (!allowed) return true;
    from = at + rule.path.length;
  }
}

const BRANCH_WRITE_LONG = new Set([
  '--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream',
  '--edit-description', '--track', '--no-track', '--create-reflog', '--recurse-submodules',
]);
const TAG_WRITE_LONG = new Set([
  '--annotate', '--sign', '--local-user', '--force', '--delete', '--message', '--file', '--edit', '--create-reflog',
]);
const LISTING_FILTERS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at']);
const LISTING_VALUES = new Set([...LISTING_FILTERS, '--sort', '--format', '--column', '--color']);

/**
 * `git branch` / `git tag` read only when they list: no writing flag, and no
 * name unless a listing flag (`--list`, `--contains` …) makes it a pattern.
 */
function isRefListing(words, writeLong, writeShort) {
  let listing = false;
  let names = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('--')) {
      const name = w.split('=')[0];
      if (writeLong.has(name)) return false;
      if (name === '--list' || LISTING_FILTERS.has(name)) listing = true;
      if (LISTING_VALUES.has(name) && !w.includes('=')) i++;
    } else if (/^-[a-zA-Z]/.test(w)) {
      if (writeShort.test(w.slice(1))) return false;
      if (w.slice(1).includes('l')) listing = true;
    } else {
      names++;
    }
  }
  return names === 0 || listing;
}

/** Read-only forms of git subcommands that can also write. */
function isGitListing(sub, rest) {
  const words = rest
    .trim()
    .split(/\s+/)
    .filter((w) => w && !/^\d*[<>]/.test(w));
  const plain = words.filter((w) => !w.startsWith('-'));
  switch (sub) {
    case 'remote':
      return plain.length === 0 || ['get-url', 'show'].includes(plain[0]);
    case 'stash':
      return ['list', 'show'].includes(plain[0]);
    case 'worktree':
      return plain[0] === 'list';
    case 'submodule':
      return plain.length === 0 || plain[0] === 'status';
    case 'reflog':
      return !['expire', 'delete', 'drop'].includes(plain[0]);
    case 'config': {
      const writing = words.some((w) =>
        /^(?:--(?:unset|unset-all|add|replace-all|edit|rename-section|remove-section)|-e)$/.test(w),
      );
      const reading =
        ['get', 'list'].includes(plain[0]) ||
        words.some((w) => /^(?:--(?:get|get-all|get-regexp|get-urlmatch|list)|-l)$/.test(w));
      return reading && !writing && !['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(plain[0]);
    }
    case 'branch':
      return isRefListing(words, BRANCH_WRITE_LONG, /[dDmMcCfut]/);
    case 'tag':
      return isRefListing(words, TAG_WRITE_LONG, /[asufdmFe]/);
    default:
      return false;
  }
}

function isGitRead(trimmed) {
  if (GIT_READ.test(trimmed)) return true;
  const call = trimmed.match(GIT_CALL);
  return Boolean(call) && isGitListing(call[1], call[2]);
}

function isWriteVerb(trimmed) {
  return (WRITE_VERB.test(trimmed) && !isGitRead(trimmed)) || IN_PLACE.test(trimmed);
}

// What a search tool is looking for is text, not a place: `grep -n "a\|/Users"`
// names no path, and its `|` must not split the command either. The pattern
// word of grep-like tools is blanked before paths are looked for; a word that
// runs a command (`$(…)`, backticks, `<(…)`) is never blanked.
const SEARCH_TOOLS = {
  grep: { short: 'efmABCdD', long: ['--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--directories', '--devices', '--label', '--binary-files'] },
  rg: { short: 'efgtTmABCMjrEd', long: ['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--after-context', '--before-context', '--context', '--max-columns', '--threads', '--replace', '--encoding', '--max-depth', '--max-filesize', '--sort', '--sortr', '--color', '--colors', '--pre', '--pre-glob', '--type-add', '--path-separator', '--ignore-file'] },
  ag: { short: 'GABCmgp', long: ['--ignore', '--ignore-dir', '--depth', '--file-search-regex', '--context', '--after', '--before', '--max-count', '--path-to-ignore', '--pager'] },
  ack: { short: 'ABCm', long: ['--type', '--ignore-dir', '--ignore-file', '--match', '--output', '--max-count', '--context', '--after-context', '--before-context'] },
  'git grep': { short: 'efABCm', long: ['--regexp', '--file', '--max-depth', '--threads', '--max-count', '--context', '--after-context', '--before-context'] },
};
const SEARCH_ALIASES = { egrep: 'grep', fgrep: 'grep', zgrep: 'grep', ggrep: 'grep' };
const PATTERN_LONG = new Set(['--regexp', '--match']);
const PATTERN_FILE_LONG = new Set(['--file']);
const COMMAND_PREFIX = new Set(['sudo', 'command', 'nice', 'time', 'nohup', 'exec', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{']);
const XARGS_VALUE = 'IinPLsdEJRS';

/** Shell words of `cmd` with their spans, plus where each command starts. */
function shellWords(cmd) {
  const words = [];
  let word = null;
  let starts = true;
  let redirect = false;
  const end = (at) => {
    if (word) {
      word.end = at;
      if (redirect) redirect = false;
      else words.push(word);
    }
    word = null;
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" || ch === '"') {
      word ??= { start: i, text: '', first: starts && ((starts = false), true) };
      const close = ch === "'" ? cmd.indexOf("'", i + 1) : closingDoubleQuote(cmd, i + 1);
      const stop = close === -1 ? cmd.length : close;
      word.text += cmd.slice(i + 1, stop).replace(/\\(["\\$`])/g, ch === '"' ? '$1' : '\\$1');
      word.raw = true;
      i = stop;
      continue;
    }
    if (ch === '\\' && i + 1 < cmd.length && cmd[i + 1] !== '\n') {
      word ??= { start: i, text: '', first: starts && ((starts = false), true) };
      word.text += cmd[i + 1];
      i++;
      continue;
    }
    if (/\s/.test(ch) || '|&;()<>'.includes(ch)) {
      end(i);
      if ((ch === '>' || ch === '<') && cmd[i + 1] !== '(') {
        // `2>/dev/null`, `>&2`, `< in.txt`: the target is not an argument.
        const last = words[words.length - 1];
        if (last && last.end === i && /^\d+$/.test(last.text)) words.pop();
        while (cmd[i + 1] === ch) i++;
        if (cmd[i + 1] === '&') {
          i++;
          while (/[\d-]/.test(cmd[i + 1] ?? '')) i++;
        } else {
          redirect = true;
        }
        continue;
      }
      if (ch !== ' ' && ch !== '\t') starts = true;
      continue;
    }
    word ??= { start: i, text: '', first: starts && ((starts = false), true) };
    word.text += ch;
  }
  end(cmd.length);
  return words;
}

function closingDoubleQuote(cmd, from) {
  for (let i = from; i < cmd.length; i++) {
    if (cmd[i] === '\\') i++;
    else if (cmd[i] === '"') return i;
  }
  return -1;
}

/** The words of `cmd` that are the pattern of a search tool. */
function searchPatterns(cmd) {
  const words = shellWords(cmd);
  const patterns = [];
  for (let i = 0; i < words.length; i++) {
    if (!words[i].first) continue;
    let j = i;
    // Commands are made of the words up to the next command start.
    let stop = j + 1;
    while (stop < words.length && !words[stop].first) stop++;
    while (j < stop && (/^[A-Za-z_]\w*=/.test(words[j].text) || COMMAND_PREFIX.has(words[j].text))) j++;
    if (words[j]?.text === 'xargs') {
      j++;
      while (j < stop && words[j].text.startsWith('-')) {
        const w = words[j].text;
        j += w.length === 2 && XARGS_VALUE.includes(w[1]) ? 2 : 1;
      }
    }
    if (j >= stop) continue;
    let tool = words[j].text.split('/').pop();
    tool = SEARCH_ALIASES[tool] ?? tool;
    if (tool === 'git') {
      j++;
      while (j < stop && /^(?:-C|-c)$/.test(words[j].text)) j += 2;
      while (j < stop && /^--(?:no-pager|git-dir=|work-tree=)/.test(words[j].text)) j++;
      if (words[j]?.text !== 'grep') continue;
      tool = 'git grep';
    }
    const spec = SEARCH_TOOLS[tool];
    if (!spec) continue;
    patterns.push(...patternWords(words.slice(j + 1, stop), spec));
  }
  return patterns;
}

function patternWords(args, spec) {
  const explicit = [];
  let fromFile = false;
  const positional = [];
  let options = true;
  for (let k = 0; k < args.length; k++) {
    const w = args[k].text;
    if (options && w === '--') {
      options = false;
    } else if (options && w.startsWith('--')) {
      const [name] = w.split('=');
      const inline = w.includes('=');
      if (PATTERN_LONG.has(name)) {
        if (inline) explicit.push(args[k]);
        else if (args[k + 1]) explicit.push(args[++k]);
      } else if (PATTERN_FILE_LONG.has(name)) {
        fromFile = true;
        if (!inline) k++;
      } else if (spec.long.includes(name) && !inline) {
        k++;
      }
    } else if (options && /^-[^-]/.test(w)) {
      for (let c = 1; c < w.length; c++) {
        if (!spec.short.includes(w[c])) continue;
        const attached = c + 1 < w.length;
        if (w[c] === 'e') {
          if (attached) explicit.push(args[k]);
          else if (args[k + 1]) explicit.push(args[++k]);
        } else {
          if (w[c] === 'f') fromFile = true;
          if (!attached) k++;
        }
        break;
      }
    } else {
      positional.push(args[k]);
    }
  }
  const found = explicit.length > 0 || fromFile ? explicit : positional.slice(0, 1);
  return found;
}

/** `cmd` with the patterns of search tools blanked out (same length). */
function blankSearchPatterns(cmd) {
  let out = cmd;
  for (const w of searchPatterns(cmd)) {
    const raw = cmd.slice(w.start, w.end);
    if (/\$\(|`|<\(/.test(raw)) continue;
    out = out.slice(0, w.start) + raw.replace(/[^\n]/g, ' ') + out.slice(w.end);
  }
  return out;
}

function writesInto(segment, rule) {
  const trimmed = segment.trim();
  if (isWriteVerb(trimmed)) return true;
  return new RegExp(`>{1,2}\\s*['"]?${escapeRe(rule.path)}`).test(segment);
}

// `cat > notes.md <<'EOF' … EOF` only writes its body to a file: the quoted
// delimiter turns off expansion and nothing runs it, so prose such as
// "SEA / EUR" in there is not a path. Bodies fed to anything else
// (`bash <<'EOF'`, `cat <<'EOF' | sh`) or left unquoted (`$(…)` expands) stay checked.
const HEREDOC = /^([^\n]*<<-?[ \t]*(['"])([A-Za-z_][\w-]*)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*$/gm;

function isDataSink(header) {
  const segment = header.split(/&&|\|\||;/).find((s) => s.includes('<<')) ?? '';
  return /^\s*(?:cat|tee)\b/.test(segment) && !segment.includes('|');
}

function stripDataHeredocs(cmd) {
  return cmd.replace(HEREDOC, (whole, header) => (isDataSink(header) ? header : whole));
}

function decideBash(command, cfg, cwd) {
  const full = normalize(String(command ?? ''), cfg.home);
  if (CONTROL.test(full)) return '这条命令会控制 bridge 进程（启停、重启或 launchd）';
  for (const re of cfg.deniedCommands ?? []) {
    if (new RegExp(re).test(full)) return '这条命令属于仅限主人的操作';
  }
  const cmd = blankSearchPatterns(stripDataHeredocs(full));
  let cdInto = null;
  for (const segment of cmd.split(/&&|\|\||;|\||\n/)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    // `cd <protected> && echo x > file` writes there without naming it again.
    if (cdInto && (isWriteVerb(trimmed) || RELATIVE_REDIRECT.test(trimmed))) {
      return `这条命令会改动 ${cdInto.path}`;
    }
    for (const rule of cfg.rules ?? []) {
      if (!mentions(segment, rule)) continue;
      if (rule.bash === 'any') return `这条命令会读取或改动 ${rule.path}`;
      if (/^cd\s/.test(trimmed)) cdInto = rule;
      else if (writesInto(segment, rule)) return `这条命令会改动 ${rule.path}`;
    }
  }
  if (BARE_CD.test(cmd)) return '这条命令会进入主人的主目录';
  // Relative paths count from wherever the earlier `cd`s of this command left
  // the shell, so `cd a/b && ls ../..` stays in the workspace it started in.
  let here = cwd;
  for (const segment of cmd.split(/&&|\|\||;|\||\n/)) {
    for (const path of commandPaths(segment, here)) {
      if (!inScope(path, cfg)) return `这条命令会访问未对外开放的位置 ${path}`;
      // `<open path>/../<fenced>` names an allowed place but resolves into a fenced one.
      for (const rule of cfg.rules ?? []) {
        if (rule.bash === 'any' && fenced(path, rule)) return `这条命令会读取或改动 ${rule.path}`;
      }
    }
    const cd = segment.trim().match(/^cd\s+(['"]?)([^\s'"$`]+)\1$/);
    if (cd) here = isAbsolute(cd[2]) ? resolve(cd[2]) : resolve(here, cd[2]);
  }
  return null;
}

/** Is `path` inside `rule.path` and not one of its allowed sub-paths? */
function fenced(path, rule) {
  if (!within(path, rule.path)) return false;
  return !(rule.allow ?? []).some((re) => new RegExp(`^${re}`).test(path));
}

/** The text a file tool is about to write. */
function writtenText(input) {
  const parts = [input?.content, input?.new_string, input?.new_source];
  for (const edit of Array.isArray(input?.edits) ? input.edits : []) parts.push(edit?.new_string);
  return parts.filter((p) => typeof p === 'string').join('\n');
}

function decideFile(toolName, input, cfg, cwd) {
  if (WRITING_TOOLS.has(toolName) && (cfg.deniedContent ?? []).length > 0) {
    const text = writtenText(input);
    for (const re of cfg.deniedContent) {
      if (new RegExp(re).test(text)) return '要写入的内容涉及受限操作';
    }
  }
  for (const key of FILE_TOOLS[toolName] ?? []) {
    const value = input?.[key];
    if (typeof value !== 'string' || !value) continue;
    const expanded = normalize(value, cfg.home);
    // A glob pattern is only a location when it is absolute.
    if (key === 'pattern' || key === 'glob') {
      if (!isAbsolute(expanded)) continue;
    }
    const path = resolve(cwd, expanded);
    if (!inScope(path, cfg)) return `访问的位置未对外开放：${path}`;
    for (const re of cfg.deniedContent ?? []) {
      if (new RegExp(re).test(path)) return `访问的位置未对外开放：${path}`;
    }
    for (const rule of cfg.rules ?? []) {
      if (rule.bash === 'any' && fenced(path, rule)) return `访问的位置未对外开放：${rule.path}`;
    }
    if (WRITING_TOOLS.has(toolName)) {
      for (const rule of cfg.rules ?? []) {
        if (within(path, rule.path)) return `这个位置不能改动：${rule.path}`;
      }
    }
  }
  return null;
}

/** Why the tool call is refused, or null when it may run. */
export function decide(toolName, input, cfg, cwd = process.cwd()) {
  const config = { ...cfg, home: cfg.home ?? homedir() };
  if (toolName === 'Bash') return decideBash(input?.command, config, cwd);
  if (toolName in FILE_TOOLS) return decideFile(toolName, input, config, cwd);
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return 0;
  }
  let cfg = {};
  try {
    cfg = JSON.parse(process.env.LARK_CHANNEL_GUARD ?? '{}');
  } catch {
    cfg = {};
  }
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const reason = decide(input?.tool_name, input?.tool_input, cfg, cwd);
  if (!reason) return 0;
  process.stderr.write(
    cfg.refusal
      ? `${reason}。这一步在当前会话不可用：请停止这一步，不要换个写法再试；只回复用户「${cfg.refusal}」这一句，不要解释原因，也不要提及拦截、权限或规则。\n`
      : `${reason}。本次任务不是 bot 主人发起的，这部分仅限主人本人。请停止这一步，并告诉用户这部分内容不对外开放。\n`,
  );
  return 2;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().then((code) => process.exit(code));
}

