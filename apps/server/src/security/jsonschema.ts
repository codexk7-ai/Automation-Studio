import * as Ajv2020Module from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

// ajv ships CommonJS; resolve the constructor under both ESM interop shapes.
type AjvInstance = { compile(schema: object): ValidateFunction };
const mod = Ajv2020Module as unknown as { default?: unknown };
const AjvCtor = ((mod.default as { default?: unknown })?.default ?? mod.default ?? Ajv2020Module) as new (opts: object) => AjvInstance;

// JSON Schema 2020-12 (what MCP tool schemas declare); draft-07 schemas share the common keywords.
const ajv = new AjvCtor({ allErrors: true, strict: false, validateFormats: false });
const cache = new Map<string, ValidateFunction>();

/**
 * Validates untrusted data (model output, tool arguments) against a JSON
 * schema. Schemas themselves may come from external MCP servers, so compile
 * errors are reported as validation failures rather than thrown.
 */
export function validateJson(schema: Record<string, unknown>, data: unknown): { valid: boolean; errors: string[] } {
  const { $schema: _ignored, ...rest } = schema;
  const key = JSON.stringify(rest);
  if (key.length > 200_000) return { valid: false, errors: ["Schema is too large."] };
  let validate = cache.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(rest);
    } catch (err) {
      return { valid: false, errors: [`Invalid schema: ${(err as Error).message}`] };
    }
    if (cache.size > 500) cache.clear();
    cache.set(key, validate);
  }
  const valid = validate(data) as boolean;
  return { valid, errors: valid ? [] : (validate.errors ?? []).slice(0, 20).map((e: ErrorObject) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`) };
}
