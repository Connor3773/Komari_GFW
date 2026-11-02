import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const problems = [];
const forbiddenPath = /(^|\/)(\.local|\.cache|data|node_modules|dist|test-results|playwright-report)(\/|$)|(^|\/)(\.env(?:\..*)?|komari\.local\.json|state-[01]\.json)$|\.(?:db(?:-shm|-wal)?|sqlite3?|pem|key|log)$/i;
const secrets = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@[^\s]+/,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/,
];
for (const path of paths) {
  if (forbiddenPath.test(path)) { problems.push(`${path}: private/runtime file must not be tracked`); continue; }
  if (/\.(png|jpe?g|gif|ico|woff2?)$/i.test(path)) continue;
  const content = readFileSync(path, "utf8");
  for (const [index, pattern] of secrets.entries()) if (pattern.test(content)) problems.push(`${path}: potential credential pattern ${index + 1}`);
}
if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
else console.log(`Public-readiness scan passed for ${paths.length} tracked files. Manual review and history review are still required.`);
