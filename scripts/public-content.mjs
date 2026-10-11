const forbiddenPaths = [
  /(^|\/)(?:\.local|private|secrets|credentials|node_modules|\.pnpm-store)(?:\/|$)/u,
  /^docs\/design\/notion(?:\/|$)/u,
  /(^|\/)\.env(?:\..*)?$/u,
  /(?:\.(?:sqlite|db)(?:-(?:wal|shm))?|\.(?:pem|key|p12|pfx|wav|mp3|m4a|eml|mbox))$/iu,
  /(^|\/)(?:id_rsa|id_ed25519|credentials\.json|token\.json|auth\.json)$/u,
];
const rules = [
  [
    'private-notion-link',
    /https?:\/\/(?:[a-z0-9-]+\.)?notion\.(?:so|com)\/[^\s)>"']+/iu,
  ],
  ['private-tailnet-host', /\b[a-z0-9.-]+\.ts\.net\b/iu],
  [
    'personal-email',
    /\b[a-z0-9._%+-]+@(?!example\.(?:com|org|net)\b|example\.invalid\b|users\.noreply\.github\.com\b)[a-z0-9.-]+\.[a-z]{2,}\b/iu,
  ],
  ['url-credentials', /https?:\/\/[^\s/:@]+:[^\s/@]+@/iu],
];

export function inspectPublicContent(path, bytes) {
  const findings = [];
  const template = /(^|\/)\.env\.example$/u.test(path);
  if (!template && forbiddenPaths.some((pattern) => pattern.test(path)))
    findings.push('private-path');
  if (bytes.includes(0)) {
    findings.push('binary-needs-review');
    return findings;
  }
  const text = bytes.toString('utf8');
  for (const [name, pattern] of rules)
    if (pattern.test(text)) findings.push(name);
  return findings;
}
