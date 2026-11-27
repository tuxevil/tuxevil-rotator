export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Keywords Gemini does not support
const GEMINI_UNSUPPORTED = new Set([
	"$schema", "$id", "$ref", "$defs", "definitions",
	"if", "then", "else", "not",
	"patternProperties", "unevaluatedProperties", "unevaluatedItems",
	"contentEncoding", "contentMediaType", "examples",
	"exclusiveMinimum", "exclusiveMaximum", "minimum", "maximum",
	"multipleOf", "minLength", "maxLength", "pattern",
	"minItems", "maxItems", "uniqueItems",
	"minProperties", "maxProperties", "propertyNames", "title", "default",
	"deprecated",
]);

// Only remove fields that Gemini's API layer truly rejects at the network level.
// We keep standard Draft 2020-12 keywords but must strip exclusiveMinimum/exclusiveMaximum
// as boolean values (Draft 4) — the API layer rejects them even for Claude-bound requests.
const CLAUDE_VIA_GEMINI_UNSUPPORTED = new Set([
	"$schema", "$id", "$ref", "$defs", "definitions",
	"if", "then", "else", "not",
	"patternProperties", "unevaluatedProperties", "unevaluatedItems",
	"contentEncoding", "contentMediaType",
	// Gemini's protobuf layer rejects these regardless of target model
	"exclusiveMinimum", "exclusiveMaximum", "propertyNames", "uniqueItems", "deprecated",
]);

/**
 * Collapse JSON Schema const-literal unions (`[{const: V}, ...]` or
 * `[{type: T, const: V}, ...]`) into a flat `enum` (+ `type` when typed).
 */
function applyConstUnionToSchema(
	variants: unknown[],
	out: Record<string, unknown>,
): boolean {
	if (variants.length === 0) return false;

	// Case 1: all items are pure {const: value} — JSON Schema way of writing an enum.
	const allPureConst = variants.every(
		(item) => isRecord(item) && Object.keys(item).length === 1 && "const" in item,
	);
	if (allPureConst) {
		out["enum"] = variants.map((item) => (item as Record<string, unknown>)["const"]);
		return true;
	}

	// Case 2: all items are {type: T, const: V} with the same type.
	// Merge into a single flat {type: T, enum: [V1, V2, ...]} — avoids
	// redundant anyOf wrappers that upstream schema validators reject.
	const allTypeConst = variants.every(
		(item) =>
			isRecord(item) &&
			Object.keys(item).length === 2 &&
			"type" in item &&
			"const" in item,
	);
	if (allTypeConst) {
		const firstType = (variants[0] as Record<string, unknown>)["type"];
		if (
			typeof firstType === "string" &&
			variants.every((item) => (item as Record<string, unknown>)["type"] === firstType)
		) {
			if (!out["type"]) out["type"] = firstType;
			out["enum"] = variants.map((item) => (item as Record<string, unknown>)["const"]);
			return true;
		}
	}

	return false;
}

/**
 * Inline union type: `type: ["number","null"]`. Gemini's proto `type`
 * field is a single enum, not repeating — an array value triggers a 400
 * ('Proto field is not repeating'). Collapse to the first non-null type
 * and lift nullability into the proto-supported `nullable` flag.
 */
function collapseInlineUnionType(
	value: unknown[],
	out: Record<string, unknown>,
): void {
	const nonNull = value.filter((t) => t !== "null");
	if (value.includes("null")) out["nullable"] = true;
	out["type"] = nonNull[0] ?? "string";
}

function sanitizeSchemaProperties(
	value: Record<string, unknown>,
	sanitize: (schema: unknown) => unknown,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		Object.defineProperty(result, k, {
			value: sanitize(v),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return result;
}

function mergePropertyMaps(
	base: Record<string, unknown> | undefined,
	incoming: Record<string, unknown>,
	overwrite = true,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	if (base) {
		for (const [k, v] of Object.entries(base)) {
			Object.defineProperty(merged, k, {
				value: v,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	for (const [k, v] of Object.entries(incoming)) {
		if (!overwrite && Object.hasOwn(merged, k)) continue;
		Object.defineProperty(merged, k, {
			value: v,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return merged;
}

function mergeSchemaFragment(
	out: Record<string, unknown>,
	fragment: Record<string, unknown>,
): void {
	for (const [k, v] of Object.entries(fragment)) {
		if (k === "properties" && isRecord(v)) {
			out["properties"] = mergePropertyMaps(
				isRecord(out["properties"]) ? out["properties"] : undefined,
				v,
			);
			continue;
		}
		if (k === "required" && Array.isArray(v)) {
			const existing = Array.isArray(out["required"]) ? out["required"] : [];
			out["required"] = [...new Set([...existing, ...v])];
			continue;
		}
		Object.defineProperty(out, k, {
			value: v,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
}

function sanitizeSchemaItems(
	value: unknown,
	sanitize: (schema: unknown) => unknown,
): unknown {
	if (Array.isArray(value)) {
		return value
			.map(sanitize)
			.find((item) => isRecord(item) && Object.keys(item).length > 0);
	}
	return sanitize(value);
}

/**
 * Gemini's Schema proto accepts only string values in `enum` (for string
 * schemas), even for Claude-bound requests. Preserve primitive type and
 * nullability when possible, and strip incompatible `enum` entries.
 */
function normalizeGeminiSchemaEnum(out: Record<string, unknown>): void {
	if (!("enum" in out)) return;

	if (!Array.isArray(out.enum) || out.enum.length === 0) {
		delete out.enum;
		return;
	}

	const hasNull = out.enum.some((value) => value === null);
	const nonNull = out.enum.filter((value) => value !== null);
	if (nonNull.length === 0) {
		delete out.enum;
		return;
	}

	if (nonNull.every((value) => typeof value === "string")) {
		if (hasNull) out.nullable = true;
		if (!out.type) out.type = "string";
		if (typeof out.type === "string" && out.type.toLowerCase() === "string") {
			if (hasNull) out.enum = nonNull;
			return;
		}
		delete out.enum;
		return;
	}

	if (!out.type) {
		if (nonNull.every((value) => typeof value === "boolean")) {
			out.type = "boolean";
		} else if (
			nonNull.every((value) => typeof value === "number" && Number.isFinite(value))
		) {
			out.type = nonNull.every((value) => Number.isInteger(value))
				? "integer"
				: "number";
		}
	}
	if (hasNull && out.type) {
		out.nullable = true;
	}
	delete out.enum;
}

/**
 * Gemini's function_declarations accept a restricted subset of JSON Schema.
 * Keywords like `const`, `$schema`, `$ref`, `$defs`, `if/then/else`, `not`,
 * `patternProperties`, etc. are not supported and will cause a 400.
 * This function recursively strips those unsupported keywords.
 */
export function sanitizeGeminiSchema(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (GEMINI_UNSUPPORTED.has(key)) continue;
		// Gemini's protobuf layer rejects vendor extensions such as
		// x-google-enum-descriptions and x-google-identifier.
		if (key.startsWith("x-")) continue;

		// `const` is not supported by Gemini's API — convert to a single-value enum
		if (key === "const") {
			out["enum"] = [value];
			continue;
		}

		if (key === "anyOf" || key === "oneOf" || key === "allOf") {
			if (Array.isArray(value) && !applyConstUnionToSchema(value, out)) {
				const cleaned = value.map(sanitizeGeminiSchema).filter(
					// Drop entries that become empty objects after sanitisation
					(v) => isRecord(v) && Object.keys(v).length > 0,
				);
				// If only one variant remains, unwrap it (Gemini prefers flat schemas)
				if (cleaned.length === 1) {
					Object.assign(out, cleaned[0]);
				} else if (cleaned.length > 1) {
					out[key] = cleaned;
				}
				// cleaned.length === 0: skip entirely
			}
			continue;
		}

		if (key === "type" && Array.isArray(value)) {
			collapseInlineUnionType(value, out);
			continue;
		}

		if (key === "properties" && isRecord(value)) {
			out[key] = sanitizeSchemaProperties(value, sanitizeGeminiSchema);
			continue;
		}

		if (key === "items") {
			const sanitizedItems = sanitizeSchemaItems(value, sanitizeGeminiSchema);
			if (sanitizedItems !== undefined) out[key] = sanitizedItems;
			continue;
		}

		out[key] = isRecord(value) ? sanitizeGeminiSchema(value) : value;
	}
	normalizeGeminiSchemaEnum(out);
	return out;
}

/**
 * Lighter sanitization for Claude models routed through Gemini's API.
 * Gemini's outer API still validates schemas before routing to Claude, so
 * we must remove fields Gemini's protobuf doesn't know about (like `const`,
 * `$ref`, etc.). However, unlike the Gemini-native sanitizer, we KEEP
 * standard JSON Schema Draft 2020-12 keywords (minimum, maximum, pattern,
 * etc.) that Claude requires and that Gemini's API does pass through.
 */
export function sanitizeClaudeViaGeminiSchema(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (CLAUDE_VIA_GEMINI_UNSUPPORTED.has(key)) continue;
		// Vendor extensions are not understood by Gemini's outer protobuf API,
		// even when the inner request targets Claude.
		if (key.startsWith("x-")) continue;

		// `const` is not supported by Gemini's API — convert to a single-value enum
		if (key === "const") {
			out["enum"] = [value];
			continue;
		}

		if (key === "anyOf" || key === "oneOf" || key === "allOf") {
			if (Array.isArray(value) && !applyConstUnionToSchema(value, out)) {
				// Sanitize all variants first.
				const cleaned = value.map(sanitizeClaudeViaGeminiSchema).filter(
					(v) => isRecord(v) && Object.keys(v).length > 0,
				) as Record<string, unknown>[];

				if (cleaned.length === 0) {
					// All variants collapsed to nothing — skip entirely.
					continue;
				}

				// Case 3: nullable pattern — anyOf/oneOf with exactly one {type:"null"}
				// variant and one or more real variants. Convert to the real variant
				// with nullable:true. This is lossless — Gemini's proto supports nullable.
				// e.g. anyOf:[{type:"string"},{type:"null"}] → {type:"string",nullable:true}
				if (key !== "allOf") {
					const nullIdx = cleaned.findIndex((v) => v.type === "null" && Object.keys(v).length === 1);
					if (nullIdx !== -1) {
						const nonNull = cleaned.filter((_, i) => i !== nullIdx);
						if (nonNull.length >= 1) {
							mergeSchemaFragment(out, nonNull[0]);
							out["nullable"] = true;
							continue;
						}
					}
				}

				// Case 4: allOf — deep merge all variants (allOf = intersection).
				// Merging properties from all variants is semantically correct.
				if (key === "allOf") {
					const merged: Record<string, unknown> = {};
					let mergedProperties: Record<string, unknown> = {};
					let mergedRequired: string[] = [];
					for (const variant of cleaned) {
						for (const [vk, vv] of Object.entries(variant)) {
							if (vk === "properties" && isRecord(vv)) {
								mergedProperties = mergePropertyMaps(mergedProperties, vv);
							} else if (vk === "required" && Array.isArray(vv)) {
								mergedRequired = [...new Set([...mergedRequired, ...vv])];
							} else {
								merged[vk] = vv;
							}
						}
					}
					if (Object.keys(mergedProperties).length > 0) merged["properties"] = mergedProperties;
					if (mergedRequired.length > 0) merged["required"] = mergedRequired;
					mergeSchemaFragment(out, merged);
					continue;
				}

				// Case 5: anyOf/oneOf where all variants are objects with properties —
				// merge all properties together, making all optional (union of shapes).
				// This is mildly lossy (accepts wider input) but doesn't reject valid inputs.
				const allObjects = cleaned.every(
					(v) => v.type === "object" && isRecord(v.properties),
				);
				if (allObjects && cleaned.length > 1) {
					let unionProperties: Record<string, unknown> = {};
					for (const variant of cleaned) {
						const props = variant.properties as Record<string, unknown>;
						unionProperties = mergePropertyMaps(unionProperties, props, false);
					}
					// Only keep required fields that exist in ALL variants
					const allRequired = cleaned.map((v) =>
						Array.isArray(v.required) ? new Set(v.required as string[]) : new Set<string>(),
					);
					const commonRequired = [...allRequired[0]].filter((r) =>
						allRequired.every((s) => s.has(r)),
					);
					const base = { ...cleaned[0] };
					base["properties"] = unionProperties;
					if (commonRequired.length > 0) {
						base["required"] = commonRequired;
					} else {
						delete base["required"];
					}
					mergeSchemaFragment(out, base);
					continue;
				}

				// Fallback: collapse to the first valid variant.
				// Gemini's Schema proto serialization corrupts complex anyOf/oneOf
				// during the round-trip to Claude, causing JSON Schema draft 2020-12
				// validation failures. Collapsing is lossy but functional — the tool
				// still works, just with a narrower accepted input type.
				mergeSchemaFragment(out, cleaned[0]);
			}
			continue;
		}

		if (key === "type" && Array.isArray(value)) {
			collapseInlineUnionType(value, out);
			continue;
		}

		if (key === "properties" && isRecord(value)) {
			const sanitizedProps = sanitizeSchemaProperties(value, sanitizeClaudeViaGeminiSchema);
			out[key] = mergePropertyMaps(
				isRecord(out[key]) ? (out[key] as Record<string, unknown>) : undefined,
				sanitizedProps,
			);
			continue;
		}

		if (key === "required" && Array.isArray(value)) {
			const existing = Array.isArray(out[key]) ? (out[key] as unknown[]) : [];
			out[key] = [...new Set([...existing, ...value])];
			continue;
		}

		if (key === "items") {
			const sanitizedItems = sanitizeSchemaItems(value, sanitizeClaudeViaGeminiSchema);
			if (sanitizedItems !== undefined) out[key] = sanitizedItems;
			continue;
		}

		out[key] = isRecord(value) ? sanitizeClaudeViaGeminiSchema(value) : value;
	}
	normalizeGeminiSchemaEnum(out);
	return out;
}
