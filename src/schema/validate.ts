// schema/validate.ts — ajv wrapper, --json-schema arg building, safety-net validate (SPEC §7).
// schema/validate.ts —— ajv 封装、构造 --json-schema 参数、兜底校验（SPEC §7）。

import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import type { JsonSchema } from "../types.js";

// Single shared ajv instance. strict:false so unknown keywords (CLI-flavored schemas,
// 单个共享的 ajv 实例。strict:false 让未知关键字（CLI 风格的 schema、
// vendor extensions) don't crash compilation; allErrors so errorsText reports everything.
// 厂商扩展）不会让编译崩溃；allErrors 让 errorsText 报出全部错误。
const ajv = new Ajv({ allErrors: true, strict: false });

// Compiled validators cached by a stable stringify of the schema.
// 编译后的校验器以 schema 的稳定 stringify 结果为键做缓存。
const validatorCache = new Map<string, ValidateFunction>();

/** The exact JSON handed to `claude --json-schema <json>`. */
/** 传给 `claude --json-schema <json>` 的那串确切 JSON。 */
export function schemaToCliArg(schema: JsonSchema): string {
  return JSON.stringify(schema);
}

export interface ValidationResult {
  ok: boolean;
  errors?: string;
}

function getValidator(schema: JsonSchema): ValidateFunction {
  const cacheKey = JSON.stringify(schema);
  const existing = validatorCache.get(cacheKey);
  if (existing) return existing;
  const compiled = ajv.compile(schema);
  validatorCache.set(cacheKey, compiled);
  return compiled;
}

/** Re-validate a value against the schema as a safety net for the CLI's structured output. */
/** 对值再次按 schema 做校验，作为 CLI 结构化输出的兜底。 */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): ValidationResult {
  const validate = getValidator(schema);
  const valid = validate(value);
  if (valid) return { ok: true };
  const errors = ajv.errorsText(validate.errors, { separator: "; " });
  return { ok: false, errors };
}

/** SPEC §7: structured-output schema root MUST be type:"object". */
/** SPEC §7：结构化输出 schema 的根必须是 type:"object"。 */
export function assertObjectRootSchema(schema: JsonSchema): void {
  if (schema["type"] !== "object") {
    throw new Error(
      `structured-output schema root must be type:"object" (got ${JSON.stringify(
        schema["type"],
      )}); discriminated unions must be expressed flat (enum discriminant + optional fields), not a root oneOf`,
    );
  }
}
