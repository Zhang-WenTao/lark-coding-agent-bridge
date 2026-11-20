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
// Two keys only shape the message of a refusal, so the agent can redo a read
// the right way instead of giving up:
//   "openDirs": [{ "path": "/abs", "readOnly": true }, …] — the places a
//                guessed path outside them is pointed back to
//   "notesPattern": "regex" — the knowledge notes tree, read by sub-path only
//
// The run's own saved tool output (`~/.claude/projects/<p>/<session>/tool-results`,
// named by the hook's `session_id` and `transcript_path`) is always readable.
//
// Exit 2 with a reason on stderr blocks the call; Claude shows the reason to
// the model. String matching, not a sandbox: it stops the plain ways of doing
// it, and the agent is told the same rules in its system prompt.

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

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

// A character that can continue a path name: `/a/b` is not `/a/b-c`.
const PATH_CHAR = /[^\s'"`;|&()<>]/;
const APART = /[\s;|&()]/;
// String functions of the usual script languages and jq, called on text.
const STRING_OP =
  /\b(?:r?split|splits|join|replace(?:All)?|[lr]?strip|trim|starts?[wW]ith|ends?[wW]ith|includes|(?:last)?[iI]ndexOf|r?partition|count|r?find|r?index|remove(?:prefix|suffix)|[lr]trimstr|g?sub|test|match)\s*\(\s*$/;

/**
 * A run of slashes is the root directory only when it stands as a word of its
 * own (bare, or quoted as a whole: `ls "/"`) after a command that takes paths.
 * Glued to other text it is code or a regex — `split("/")`, awk's
 * `/a/,/<\/b>/`, sed's `s/a/b/` — and standing alone without such a command it
 * is prose or an operator ("SEA / EUR", jq's `a // b`).
 */
function isRootWord(cmd, start, end) {
  let s = start;
  let e = end;
  const quote = cmd[s - 1];
  const quoted = (quote === "'" || quote === '"') && cmd[e] === quote;
  if (quoted) {
    s--;
    e++;
    // A quoted "/" in code: text handled by a string function is no place
    // (`.split("/")`, `"/".join`); anywhere else it is an argument that may
    // well be the root (`os.walk('/')`).
    const before = cmd.slice(0, s);
    if (STRING_OP.test(before) || cmd[e] === '.') return false;
    if (/[(,=[{:]\s*$/.test(before)) return true;
  }
  const apart = (c) => c === undefined || (quoted ? /[\s;|&]/ : APART).test(c);
  if (!apart(cmd[s - 1]) || !apart(cmd[e])) return false;
  const segment = cmd.slice(0, s).split(/&&|\|\||;|\||\n/).pop() ?? '';
  return segment
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
    if (/^\/+$/.test(m[0]) && !isRootWord(cmd, m.index, m.index + m[0].length)) continue;
    out.push(isAbsolute(token) ? resolve(token) : resolve(cwd, token));
  }
  return out;
}

/**
 * Where `segment` names `rule.path` outside its allowed sub-paths: the text
 * from that mention on, or null. A longer name that only starts the same
 * (`~/.lark-channel-workspaces` for `~/.lark-channel`) is another place.
 */
function mentioned(segment, rule) {
  for (let from = 0; ; ) {
    const at = segment.indexOf(rule.path, from);
    if (at === -1) return null;
    from = at + rule.path.length;
    const next = segment[from];
    if (next !== undefined && next !== '/' && PATH_CHAR.test(next)) continue;
    const rest = segment.slice(at);
    if (!(rule.allow ?? []).some((re) => new RegExp(`^${re}`).test(rest))) return rest;
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

/**
 * `git fetch` only moves remote-tracking refs and objects under `.git`; the
 * checkout, local branches and config stay as they are (主人 11-20：fetch 不算写).
 * Not plain: a refspec with `:` or `+` (writes local branches), `--refmap`,
 * `--set-upstream` (config), `--update-head-ok`, and `--upload-pack` (runs a command).
 */
function isPlainFetch(words) {
  return !words.some(
    (w) =>
      /^--(?:upload-pack|refmap|set-upstream|update-head-ok)(?:=|$)/.test(w) ||
      /^-[a-zA-Z]*u/.test(w) ||
      (!w.startsWith('-') && (w.includes(':') || w.startsWith('+')) && !/^[a-z][\w+.-]*:\/\//.test(w) && !/^[\w.-]+@[\w.-]+:/.test(w)),
  );
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
      if (plain[0] === 'update') return isPlainFetch(words.slice(words.indexOf('update') + 1));
      return plain.length === 0 || ['get-url', 'show'].includes(plain[0]);
    case 'fetch':
      return isPlainFetch(words);
    case 'stash':
      return ['list', 'show'].includes(plain[0]);
    case 'archive':
      // Only `-o` / `--output` writes a file; otherwise it goes to stdout.
      return !words.some((w) => /^(?:-o|--output(?:=.*)?)$/.test(w) || /^-o./.test(w));
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
  if (!call) return false;
  // `git -c core.sshCommand=… fetch` runs a command: fetch only without `-c`.
  if (['fetch', 'remote'].includes(call[1]) && /\sgit\s+(?:\S+\s+)*?-c\s/.test(` ${trimmed.slice(0, trimmed.length - call[2].length)}`)) return false;
  return isGitListing(call[1], call[2]);
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

/**
 * Does a shell word run a command when expanded (`$(…)`, backticks, `<(…)`)?
 * Single-quoted text and backslash-escaped characters are literal.
 */
function runsCommand(raw) {
  // Inside double quotes `'` is an ordinary character and `$(…)` / backticks
  // still run, so quotes have to be tracked, not stripped by pattern.
  let quote = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '`' || (c === '$' && raw[i + 1] === '(')) return true;
    if (quote === '"') {
      if (c === '"') quote = '';
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '<' && raw[i + 1] === '(') return true;
  }
  return false;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish']);
// What `xargs` may run on a search's output without running the output itself.
const XARGS_READS = new Set([
  'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'wc', 'ls', 'cat', 'head', 'tail', 'file', 'stat',
  'du', 'basename', 'dirname', 'realpath', 'readlink', 'sort', 'uniq', 'jq', 'echo', 'printf', 'md5',
  'shasum', 'sha256sum', 'sha1sum', 'less', 'more', 'nl', 'od', 'xxd', 'hexdump', 'strings', 'diff',
]);
const XARGS_ARG_FLAGS = /^-[nIPLsEdJR]$/;

/** The words of a segment from its command word on (prefixes like `sudo -u x`, `env A=1` skipped). */
function commandWords(segment) {
  const words = segment.trim().replace(/^[({!\s]+/, '').split(/\s+/).filter(Boolean);
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) break;
    if (/^[A-Za-z_]\w*=/.test(w) || ['command', 'builtin', 'exec', 'nohup', 'time', 'nice'].includes(w)) {
      i++;
    } else if (w === 'sudo' || w === 'env') {
      i++;
      while (words[i]?.startsWith('-') || (w === 'env' && /^[A-Za-z_]\w*=/.test(words[i] ?? ''))) {
        if (w === 'sudo' && /^-[ugCghpUrt]$/.test(words[i])) i++;
        i++;
      }
    } else break;
  }
  return words.slice(i);
}

const base = (w) => (w ?? '').replace(/^['"]|['"]$/g, '').split('/').pop();

/**
 * Is the command's own output run (`grep -oh … f | sh`, `… | xargs sh -c`,
 * `$(grep …)` as a command, `eval "$(grep …)"`)? Then what a search "looks
 * for" may be the command itself. `cmd` has its search patterns blanked, so
 * a `|` or `sh` inside a pattern counts for nothing. A `$(…)` that is only
 * an argument (`cd $(git rev-parse …)`) runs no search output.
 */
function runsOutput(cmd) {
  const parts = cmd.split(/(\|\||&&|;|\||\n)/);
  for (let p = 0; p < parts.length; p += 2) {
    const segment = parts[p];
    const piped = parts[p - 1] === '|';
    const words = commandWords(segment);
    if (words.length === 0) continue;
    const verb = base(words[0]);
    // `$(grep …)`, `` `grep …` ``, `c=$(grep …); $c`: the command word is expanded text.
    if (/^["']?[$`]/.test(words[0])) return true;
    if (['eval', 'source', '.'].includes(verb) && runsCommand(segment)) return true;
    if (SHELLS.has(verb) && (piped || runsCommand(segment))) return true;
    if (verb === 'xargs' && piped) {
      let k = 1;
      while (words[k]?.startsWith('-')) k += XARGS_ARG_FLAGS.test(words[k]) ? 2 : 1;
      const run = base(words[k]);
      if (run && !XARGS_READS.has(run)) return true;
    }
  }
  return false;
}

/** `cmd` with the patterns of search tools blanked out (same length). */
function blankSearchPatterns(cmd) {
  let out = cmd;
  for (const w of searchPatterns(cmd)) {
    const raw = cmd.slice(w.start, w.end);
    if (runsCommand(raw)) continue;
    out = out.slice(0, w.start) + raw.replace(/[^\n]/g, ' ') + out.slice(w.end);
  }
  return out;
}

function writesInto(segment, rule) {
  const trimmed = segment.trim();
  if (isWriteVerb(trimmed)) return true;
  return new RegExp(`>{1,2}\\s*['"]?${escapeRe(rule.path)}(?![^/\\s'"\`;|&()<>])`).test(segment);
}

// Commands whose last argument is the only place they write to.
const DEST_LAST = new Set(['cp', 'rsync', 'install', 'ln', 'ditto', 'scp']);

/** The words a writing command acts on, as written (relative ones included). */
function writeArgs(trimmed) {
  const words = shellWords(trimmed).map((w) => w.text);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || words[i] === 'sudo')) i++;
  const verb = (words[i] ?? '').split('/').pop();
  const args = words.slice(i + 1).filter((w) => w && !w.startsWith('-'));
  // `ln -s /x` (one path) creates its link in the current directory.
  if (DEST_LAST.has(verb)) return args.length > 1 ? args.slice(-1) : [...args, '.'];
  return args;
}

/** The write-fenced place the shell is in when it reaches this segment, if any. */
function writeFence(here, cfg) {
  return (cfg.rules ?? []).find((rule) => rule.bash === 'write' && within(here, rule.path));
}

/** Does `trimmed`, run from inside `fence`, write into it? */
function writesFromInside(trimmed, here, fence) {
  if (RELATIVE_REDIRECT.test(trimmed)) return true;
  if (!isWriteVerb(trimmed)) return false;
  // Variables and globs may point anywhere: count them as writing here.
  return writeArgs(trimmed).some(
    (w) => /[$`*?[]/.test(w) || within(isAbsolute(w) ? resolve(w) : resolve(here, w), fence.path),
  );
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

const SEGMENTS = /&&|\|\||;|\||\n/;

/** A refusal: why, and optionally how to do the same read the open way. */
function deny(reason, hint) {
  return hint ? { reason, hint } : { reason };
}

/** What to do when the refused step was only a read in the wrong place. */
function giveUp(cfg) {
  return cfg.refusal ? `只回复用户「${cfg.refusal}」这一句，不要解释原因` : '告诉用户这部分内容不对外开放';
}

/** For a path outside every open place: where the run may look instead. */
function scopeHint(path, cfg) {
  const notes = notesHint(path, cfg);
  if (notes) return notes;
  const open = (cfg.openDirs ?? []).map((d) => `${d.path}${d.readOnly ? '（只读）' : ''}`);
  if (open.length === 0) return undefined;
  return (
    `能访问的只有这些目录：${open.join('、')}，以及技能目录和本次的附件。` +
    `要找的内容在这些目录里，就改用其中的路径重新执行；不在的话停止这一步，${giveUp(cfg)}，不要再试别的路径。`
  );
}

/** For the knowledge notes tree: read it by its open sub-paths. */
function notesHint(text, cfg) {
  if (!cfg.notesPattern || !new RegExp(`^${cfg.notesPattern}`).test(text)) return undefined;
  return (
    '知识笔记要用完整路径按子目录读：<notesDir>/global/、<notesDir>/global-external/、<notesDir>/external/ 和本会话自己的目录都能读；' +
    '不要 cd 进笔记目录根，也不要对整个笔记目录搜索，按关键词找写成 ' +
    '`grep -ril <关键词> <notesDir>/global <notesDir>/global-external <notesDir>/external`，照这个写法重新执行即可。' +
    `global-owner/ 和其他会话的笔记不对外，要读的是这些就停止这一步，${giveUp(cfg)}。`
  );
}

/** A refusal for a segment that touches an owner-only area, or null. */
function fencedArea(segment, here, cfg) {
  const trimmed = segment.trim();
  // `cd <read-only> && touch x` writes there without naming it again.
  const fence = writeFence(here, cfg);
  if (fence && writesFromInside(trimmed, here, fence)) return deny(`这条命令会改动 ${fence.path}`);
  for (const rule of cfg.rules ?? []) {
    const named = mentioned(segment, rule);
    if (named === null) continue;
    if (rule.bash === 'any') return deny(`这条命令会读取或改动 ${rule.path}`, notesHint(named, cfg));
    if (!/^cd\s/.test(trimmed) && writesInto(segment, rule)) return deny(`这条命令会改动 ${rule.path}`);
  }
  return null;
}

/** A refusal for a segment that reaches outside the open places, or null. */
function outOfScope(segment, here, cfg) {
  for (const path of commandPaths(segment, here)) {
    if (!inScope(path, cfg)) return deny(`这条命令会访问未对外开放的位置 ${path}`, scopeHint(path, cfg));
    // `<open path>/../<fenced>` names an allowed place but resolves into a fenced one.
    for (const rule of cfg.rules ?? []) {
      if (rule.bash === 'any' && fenced(path, rule)) {
        return deny(`这条命令会读取或改动 ${rule.path}`, notesHint(path, cfg));
      }
    }
  }
  return null;
}

/**
 * Where the shell is after `segment`. `cd` / `pushd` with redirections
 * (`2>/dev/null`) and options (`-P`, `-L`, `--`) still move it; a target that
 * cannot be read off the text (`cd "$X"`) is reported as `unknown`.
 */
function cdTarget(segment, here) {
  const words = segment
    .trim()
    .replace(/(?:(?<=\s)\d+|&)?>{1,2}\s*(?:&\d+|\S+)/g, ' ')
    .trim()
    .split(/\s+/);
  if (words[0] !== 'cd' && words[0] !== 'pushd') return null;
  let i = 1;
  while (i < words.length && /^-(?:-|[PLe@]+)$/.test(words[i])) {
    if (words[i++] === '--') break;
  }
  const rest = words.slice(i);
  if (rest.length === 0) return { dir: here };
  const target = rest[0].replace(/^(['"])(.*)\1$/, '$2');
  if (rest.length > 1 || /[\s'"$`*?[]/.test(target) || target === '-') return { unknown: true };
  return { dir: isAbsolute(target) ? resolve(target) : resolve(here, target) };
}

// `( cd x && … )`, `{ cd x; … }`, `if cd x; then touch y; fi`, `builtin cd x`:
// grouping and keywords in front of a command change neither where it goes
// nor what it writes.
const LEAD = /^\s*(?:[({!]\s*|(?:if|then|else|elif|do|while|until|builtin|command)\s+)+/;

function nextDir(segment, here) {
  const cd = cdTarget(segment, here);
  return cd?.dir ?? here;
}

function decideBash(command, cfg, cwd) {
  const full = normalize(String(command ?? ''), cfg.home);
  if (CONTROL.test(full)) return deny('这条命令会控制 bridge 进程（启停、重启或 launchd）');
  // What a search looks for is text: `git grep "INSERT INTO t"` and
  // `grep -r "kubectl delete" docs` run neither.
  const blanked = blankSearchPatterns(full);
  const searched = runsOutput(blanked) ? full : blanked;
  for (const re of cfg.deniedCommands ?? []) {
    if (new RegExp(re).test(searched)) return deny('这条命令属于仅限主人的操作');
  }
  const cmd = blankSearchPatterns(stripDataHeredocs(full));
  const segments = cmd.split(SEGMENTS).filter((s) => s.trim());
  // Owner-only areas first, wherever they come in the command.
  const fencedRefusal = walkSegments(segments, cwd, (segment, here) => {
    const refused = fencedArea(segment, here, cfg);
    if (refused) return { refused };
    const cd = cdTarget(segment, here);
    if (cd?.unknown) {
      // `cd "$RO"/x`: the target is not plain text. If it names a write-fenced
      // place, assume the shell is now inside it.
      const named = (cfg.rules ?? []).find((rule) => rule.bash === 'write' && mentioned(segment, rule) !== null);
      return { here: named ? named.path : here };
    }
    return { here: cd ? cd.dir : here };
  });
  if (fencedRefusal) return fencedRefusal;
  if (BARE_CD.test(cmd)) return deny('这条命令会进入主人的主目录');
  // Relative paths count from wherever the earlier `cd`s of this command left
  // the shell, so `cd a/b && ls ../..` stays in the workspace it started in.
  return walkSegments(segments, cwd, (segment, here) => {
    const refused = outOfScope(segment, here, cfg);
    return refused ? { refused } : { here: nextDir(segment, here) };
  });
}

const count = (text, c) => text.split(c).length - 1;

/**
 * Visit each segment with the directory the shell is in when it gets there.
 * `( cd x && … )` moves only its subshell: the directory before the `(` is
 * back after the `)`. `visit` returns `{ refused }` to stop, or the next `{ here }`.
 */
function walkSegments(segments, cwd, visit) {
  let here = cwd;
  const saved = [];
  for (const raw of segments) {
    const lead = raw.match(LEAD)?.[0] ?? '';
    for (let n = count(lead, '('); n > 0; n--) saved.push(here);
    const segment = raw.slice(lead.length);
    const step = visit(segment, here);
    if (step.refused) return step.refused;
    here = step.here;
    for (let n = count(segment, ')') - count(segment, '('); n > 0 && saved.length > 0; n--) here = saved.pop();
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
      if (new RegExp(re).test(text)) return deny('要写入的内容涉及受限操作');
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
    if (!inScope(path, cfg)) return deny(`访问的位置未对外开放：${path}`, scopeHint(path, cfg));
    for (const re of cfg.deniedContent ?? []) {
      if (new RegExp(re).test(path)) return deny(`访问的位置未对外开放：${path}`);
    }
    for (const rule of cfg.rules ?? []) {
      if (rule.bash === 'any' && fenced(path, rule)) {
        return deny(`访问的位置未对外开放：${rule.path}`, notesHint(path, cfg));
      }
    }
    if (WRITING_TOOLS.has(toolName)) {
      for (const rule of cfg.rules ?? []) {
        if (within(path, rule.path)) return deny(`这个位置不能改动：${rule.path}`);
      }
    }
  }
  return null;
}

/**
 * Where Claude Code saved this session's oversized tool output, from the
 * hook's own `session_id` and `transcript_path`; null when they don't name a
 * session directly under `~/.claude/projects/<project>/`.
 */
function sessionOutputDir(home, hookInput) {
  const id = hookInput?.session_id;
  const transcript = hookInput?.transcript_path;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][\w-]*$/.test(id)) return null;
  if (typeof transcript !== 'string' || !isAbsolute(transcript)) return null;
  const project = dirname(resolve(transcript));
  if (dirname(project) !== join(home, '.claude', 'projects')) return null;
  return join(project, id, 'tool-results');
}

/** `cfg` with the run's own tool output opened: readable, still never writable. */
function withSessionOutput(cfg, hookInput) {
  const dir = sessionOutputDir(cfg.home, hookInput);
  if (!dir) return cfg;
  const open = `${escapeRe(dir)}(?![^/\\s'"\`;|&()<>])`;
  return {
    ...cfg,
    allowedRoots: [...(cfg.allowedRoots ?? []), dir],
    rules: [
      ...(cfg.rules ?? []).map((rule) =>
        rule.bash === 'any' && within(dir, rule.path) ? { ...rule, allow: [...(rule.allow ?? []), open] } : rule,
      ),
      { path: dir, bash: 'write' },
    ],
  };
}

/**
 * Why the tool call is refused (`{ reason, hint? }`), or null when it may run.
 * `hookInput` is the whole hook payload, for the session it belongs to.
 */
export function decide(toolName, input, cfg, cwd = process.cwd(), hookInput = {}) {
  const config = withSessionOutput({ ...cfg, home: cfg.home ?? homedir() }, hookInput);
  if (toolName === 'Bash') return decideBash(input?.command, config, cwd);
  if (toolName in FILE_TOOLS) return decideFile(toolName, input, config, cwd);
  return null;
}

/** What the agent is told when a call is refused. */
function refusalMessage({ reason, hint }, cfg) {
  if (hint) return `${reason}。${hint}\n`;
  return cfg.refusal
    ? `${reason}。这一步在当前会话不可用：请停止这一步，不要换个写法再试；只回复用户「${cfg.refusal}」这一句，不要解释原因，也不要提及拦截、权限或规则。\n`
    : `${reason}。本次任务不是 bot 主人发起的，这部分仅限主人本人。请停止这一步，并告诉用户这部分内容不对外开放。\n`;
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
  const refused = decide(input?.tool_name, input?.tool_input, cfg, cwd, input);
  if (!refused) return 0;
  process.stderr.write(refusalMessage(refused, cfg));
  return 2;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().then((code) => process.exit(code));
}

