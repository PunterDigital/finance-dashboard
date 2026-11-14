// Prints "true" when the diff between two commits is only a release bump
// (version lines in the files below, plus CHANGELOG.md). CI uses it to skip
// the heavy jobs on `chore(release)` PRs: the tag's release workflow builds
// and checks the packages anyway. Anything else (or any doubt) prints "false".
//
// Usage: node scripts/is-version-bump.mjs <base-sha> <head-sha>
import { execFileSync } from "node:child_process";

// file -> { line: regex every changed line must match,
//           hunk: optional regex every changed hunk must contain }
const RULES = {
  "package.json": { line: /^\s*"version": "[^"]+",?$/ },
  // Only the app's own entries (root and packages[""]), never a dependency.
  "package-lock.json": { line: /^\s*"version": "[^"]+",?$/, hunk: /"name": "finance-dashboard"/ },
};

const [base, head] = process.argv.slice(2);

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function versionOnly() {
  if (!base || !head || /^0+$/.test(base)) return false;
  // Three dots: diff from the merge base, so commits that landed on the base
  // branch after the PR was opened don't count as part of it.
  const range = `${base}...${head}`;
  const files = git("diff", "--name-only", range).split("\n").filter(Boolean);
  if (files.length === 0) return false;

  for (const file of files) {
    if (file === "CHANGELOG.md") continue;
    const rule = RULES[file];
    if (!rule) return false;
    const diff = git("diff", "--unified=1", range, "--", file);
    const changed = diff
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
      .map((l) => l.slice(1));
    if (changed.length === 0 || !changed.every((l) => rule.line.test(l))) return false;
    if (rule.hunk && !diff.split("\n@@").slice(1).every((h) => rule.hunk.test(h))) return false;
  }
  return true;
}

let result = false;
try {
  result = versionOnly();
} catch (err) {
  console.error(err.message);
}
console.log(result ? "true" : "false");
