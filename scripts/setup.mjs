// Creates .env from .env.example with a freshly generated ENCRYPTION_KEY.
// Never overwrites an existing .env.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  console.log(".env already exists — leaving it unchanged.");
} else {
  const example = readFileSync(".env.example", "utf8");
  writeFileSync(".env", example.replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`), { mode: 0o600 });
  console.log("Created .env with a new ENCRYPTION_KEY. Back this key up: without it, saved connections cannot be decrypted.");
}
