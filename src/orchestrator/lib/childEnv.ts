/**
 * Minimal environment for child processes: the OS basics they need to run (paths, temp, locale, proxy
 * and CA settings) plus only the secrets a given child actually uses. Everything else in process.env
 * (LLM keys, OAuth paths, ...) stays in the orchestrator.
 */

const BASE_VARS = [
  // Windows essentials
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "OS",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  "TEMP", "TMP", "TMPDIR",
  // home/cache dirs some libraries resolve (pip caches, matplotlib, etc.)
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  // locale
  "LANG", "LC_ALL", "LC_CTYPE",
  // network setup the user may rely on
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  // Python interpreter basics (not secrets)
  "PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV",
] as const;

const UTF8_VARS = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" } as const;

/** Case-insensitive lookup (Windows env names are case-insensitive; Node keeps the original casing). */
function lookup(env: NodeJS.ProcessEnv, name: string): [string, string] | undefined {
  if (env[name] !== undefined) return [name, env[name] as string];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key && env[key] !== undefined ? [key, env[key] as string] : undefined;
}

export function minimalChildEnv(extraKeys: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_VARS, ...extraKeys]) {
    const found = lookup(env, name);
    if (found && found[1] !== "") out[found[0]] = found[1];
  }
  return { ...out, ...UTF8_VARS };
}
