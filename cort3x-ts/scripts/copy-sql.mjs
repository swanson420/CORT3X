// tsc only emits .js -- copy the .sql files next to their compiled modules
// so AccountabilityModule's schema.sql lookup (and the migrations) resolve
// from dist/ exactly as they do from src/.
import fs from "node:fs";
import path from "node:path";

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".sql")) {
      const dest = path.join("dist", path.relative("src", full));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(full, dest);
    }
  }
}
walk("src");
