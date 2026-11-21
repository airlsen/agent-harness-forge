/**
 * Conservative recognizer for common read-only shell commands, not a shell sandbox.
 * Anything we cannot parse or validate falls back to an approval, never to allow.
 */

/**
 * 免确认只读命令白名单（当前为空）。
 * 当前采用 deny-list-only：classifyBashCommand 只拦截明显危险的命令，其余默认放行；
 * 此白名单保留供未来登记「免确认」命令，不影响默认行为。
 * @type {Set<string>}
 */
export const ALLOWED_SHELL_COMMANDS = new Set([]);

function tokenize(command) {
  const tokens = [];
  let word = '';
  let started = false;
  let quoted = false;
  let quote = '';
  const flush = () => {
    if (started) tokens.push({ word });
    word = '';
    started = false;
    quoted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (quote === '"' && (c === '$' || c === '`' || c === '\\')) return null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      quoted = true;
    } else if (
      c === '\n' ||
      c === '\r' ||
      c === '\\' ||
      c === '$' ||
      c === '`' ||
      c === '#' ||
      (c === '~' && !started) ||
      c === '*' ||
      c === '?' ||
      c === '[' ||
      c === ']' ||
      c === '(' ||
      c === ')' ||
      c === '{' ||
      c === '}'
    ) {
      // Expansions, escapes, comments, globbing and shell compound syntax need approval.
      return null;
    } else if (c === ' ' || c === '\t') {
      flush();
    } else if (c === '>' || c === '<') {
      // The sole automatic redirection is stderr to /dev/null, with no other redirect.
      const nullRedirect = /^>[ \t]*\/dev\/null(?=$|[ \t;|&])/.exec(command.slice(i));
      if (c === '>' && started && !quoted && word === '2' && nullRedirect) {
        word = '';
        started = false;
        i += nullRedirect[0].length - 1;
      } else return { redirect: true };
    } else if (c === ';' || c === '|' || c === '&') {
      flush();
      const pair = command.slice(i, i + 2);
      if (pair === '&&' || pair === '||') {
        tokens.push({ op: pair });
        i++;
      } else if (c === ';' || c === '|') tokens.push({ op: c });
      else return null;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) return null;
  flush();
  return { tokens };
}

function optionsOnly(args, short, long) {
  let operands = false;
  for (const arg of args) {
    if (operands) continue;
    if (arg === '--') {
      operands = true;
      continue;
    }
    if (arg.startsWith('--')) {
      if (!long.some((pattern) => pattern.test(arg))) return false;
    } else if (arg.startsWith('-') && arg !== '-') {
      if (!short.test(arg)) return false;
    }
  }
  return true;
}

function gitReadOnly(args) {
  const [sub, ...rest] = args;
  if (sub === 'branch' || sub === 'tag') {
    // A positional branch/tag name creates one unless explicitly listing.
    const separator = rest.indexOf('--');
    const options = separator < 0 ? rest : rest.slice(0, separator);
    const listing = options.some((arg) => arg === '-l' || arg === '--list');
    if (!listing && (rest.includes('--') || rest.some((arg) => !arg.startsWith('-')))) return false;
    return optionsOnly(rest, sub === 'branch' ? /^-[arvl]+$/ : /^-[ln]+$/, [
      /^--list$/,
      /^--all$/,
      /^--remotes$/,
      /^--verbose$/,
    ]);
  }
  if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && rest[0] === '-v');
  if (sub === 'version') return rest.length === 0;
  if (!['status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'ls-files', 'shortlog'].includes(sub))
    return false;
  // Do not permit options that invoke external commands, write files, or change Git config.
  return optionsOnly(rest, /^-(?:[0-9]+|[nupsvz]+)$/, [
    /^--(?:oneline|stat|shortstat|name-only|name-status|no-patch|no-color|no-ext-diff|no-textconv|cached|staged|porcelain(?:=v[12])?|short|branch|all|tags|abbrev-commit|fuller|pretty|show-toplevel|is-inside-work-tree|verify|count)$/,
    /^--(?:max-count|skip|since|until|author|grep|format|pretty|abbrev)=[^\n]*$/,
  ]);
}

function readOnly(words) {
  const [command, ...args] = words;
  if (command === 'git') return gitReadOnly(args);
  if (command === 'cd') return args.length === 1 && !args[0].startsWith('-');
  if (command === 'echo') return true;
  if (command === 'pwd') return optionsOnly(args, /^-[LP]+$/, [/^--(?:help|version)$/]);
  if (command === 'whoami') return args.length === 0;
  if (command === 'id') return optionsOnly(args, /^-[ugnr]+$/, [/^--(?:help|version)$/]);
  if (command === 'uname') return optionsOnly(args, /^-[asnrvmpio]+$/, [/^--(?:all|help|version)$/]);
  if (command === 'date') return args.every((arg) => arg === '-u' || arg === '--utc' || arg.startsWith('+'));
  if (['which', 'whereis'].includes(command)) return args.every((arg) => !arg.startsWith('-'));
  if (['ls', 'dir', 'tree', 'stat', 'file'].includes(command))
    return optionsOnly(args, /^-[aAlhRrFt1dSi]+$/, [
      /^--(?:all|almost-all|human-readable|recursive|help|version)$/,
    ]);
  if (['cat', 'head', 'tail', 'wc'].includes(command))
    return optionsOnly(args, /^-(?:[0-9]+|[nbslcwqv]+)$/, [
      /^--(?:lines|bytes)=[0-9]+$/,
      /^--(?:lines|bytes|words|chars|number|help|version)$/,
    ]);
  if (['grep', 'egrep', 'fgrep', 'rg'].includes(command))
    return optionsOnly(args, /^-(?:[0-9]+|[inrRlvwEcFHoLs]+)$/, [
      /^--(?:line-number|ignore-case|fixed-strings|files|files-with-matches|count|no-heading|hidden|glob|type|context|before-context|after-context)(?:=[^\n]*)?$/,
    ]);
  if (command === 'sed')
    return (
      args.length >= 2 &&
      args[0] === '-n' &&
      /^\d+(?:,\d+)?p$/.test(args[1]) &&
      args.slice(2).every((arg) => !arg.startsWith('-'))
    );
  if (command === 'find')
    return args.every(
      (arg) => !arg.startsWith('-') || /^-(?:name|iname|type|maxdepth|mindepth|print)$/.test(arg),
    );
  return false;
}

export function inspectReadOnlyShell(command) {
  const parsed = tokenize(command);
  if (!parsed || parsed.redirect) return { safe: false, redirect: Boolean(parsed?.redirect) };
  let words = [];
  for (const token of parsed.tokens) {
    if (token.op) {
      if (!words.length || !readOnly(words)) return { safe: false };
      words = [];
    } else words.push(token.word);
  }
  return { safe: words.length > 0 && readOnly(words) };
}
