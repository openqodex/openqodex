// A config file OpenQodex writes for a scanner, so the scanner never loads
// one from the repo. Some tools let a repo config run code (rubocop's
// `require`, oxlint's JavaScript plugins) or write files (brakeman's output
// files); a builtin scanner never gets that from the code under review.
// The file lives in a temp folder outside the repo, under the run's
// `tempRoot` (scratch.ts), and is removed after use.

import fs from "node:fs/promises";
import path from "node:path";

export async function withOwnedConfig<T>(
  tempRoot: string,
  fileName: string,
  content: string,
  use: (configPath: string, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(tempRoot, "openqodex-config-"));
  try {
    const configPath = path.join(dir, fileName);
    await fs.writeFile(configPath, content);
    return await use(configPath, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
