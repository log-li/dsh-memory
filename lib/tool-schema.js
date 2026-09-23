/**
 * The tiny JSON-Schema subset the memory tools need, plus a validator.
 *
 * Tools registered through `ctx.tools.register()` are handed the model's raw
 * arguments; only `defineTool()` adds argument validation, and this package
 * deliberately registers plain definitions (it must not pull a copy of the
 * host's tool runtime into its own module graph — see the project spec). So
 * the validation runs here, against the same documented subset the host
 * enforces: `type`, `properties`, `required`, `additionalProperties`, `items`,
 * `enum`, `const`, `oneOf`.
 *
 * @module @log.li/dsh-memory/tool-schema
 */

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const ANNOTATIONS = ['description', 'title', 'default', 'examples']

/** Whether a value is lossless JSON (no undefined, functions, cycles). */
export function isLosslessJson(value, seen = new Set()) {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value)
  if (type !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  let ok = true
  if (Array.isArray(value)) {
    ok = value.every((item) => item !== undefined && isLosslessJson(item, seen))
  } else {
    const prototype = Object.getPrototypeOf(value)
    ok = (prototype === Object.prototype || prototype === null)
      && Object.values(value).every((item) => item !== undefined && isLosslessJson(item, seen))
  }
  seen.delete(value)
  return ok
}

/**
 * Validate one value against a schema node from the supported subset.
 * @param {object} schema JSON Schema node
 * @param {unknown} value candidate value
 * @param {string} [path] diagnostic path prefix
 * @returns {string[]} violations (empty means valid)
 */
export function validateValue(schema, value, path = 'value') {
  if (schema === undefined || schema === null || typeof schema !== 'object') return [`${path}: schema must be an object`]
  const label = path.length === 0 ? 'arguments' : path
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => validateValue(branch, value, path).length === 0)
    return matches.length === 1 ? [] : [`"${label}" must match exactly one oneOf branch (matched ${matches.length})`]
  }
  const type = schema.type
  if (type === undefined) return isLosslessJson(value) ? [] : [`"${label}" must be a lossless JSON value`]

  const violations = []
  const checkType = () => {
    switch (type) {
      case 'object':
        return value !== null && typeof value === 'object' && !Array.isArray(value)
      case 'array':
        return Array.isArray(value)
      case 'string':
        return typeof value === 'string'
      case 'boolean':
        return typeof value === 'boolean'
      case 'number':
        return typeof value === 'number' && Number.isFinite(value)
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value)
      case 'null':
        return value === null
      default:
        return false
    }
  }
  if (!checkType()) {
    violations.push(`"${label}" must be ${type === 'integer' ? 'an integer' : `a ${type}`}`)
    return violations
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) {
    violations.push(`"${label}" must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
  }
  if (Object.hasOwn(schema, 'const') && schema.const !== value) {
    violations.push(`"${label}" must be ${JSON.stringify(schema.const)}`)
  }
  if (type === 'object') {
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) violations.push(`missing required property "${path.length === 0 ? key : `${path}.${key}`}"`)
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue
      violations.push(...validateValue(child, value[key], path.length === 0 ? key : `${path}.${key}`))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (Object.hasOwn(properties, key)) continue
        violations.push(`unexpected property "${path.length === 0 ? key : `${path}.${key}`}"`)
      }
    }
  }
  if (type === 'array' && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      violations.push(...validateValue(schema.items, value[index], `${path}[${index}]`))
    }
  }
  return violations
}

/**
 * Assert that a definition's schemas stay inside the subset the host accepts.
 * Called at registration time so a malformed tool fails loudly at load instead
 * of silently rejecting the model's arguments at dispatch.
 * @param {object} schema JSON Schema node
 * @param {string} path diagnostic path
 * @returns {string[]} violations
 */
export function auditSchema(schema, path = 'schema') {
  const violations = []
  if (schema === undefined || schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return [`${path} must be a schema object`]
  }
  for (const key of Object.keys(schema)) {
    if (key === 'type' || key === 'oneOf' || key === 'properties' || key === 'required'
      || key === 'additionalProperties' || key === 'items' || key === 'enum' || key === 'const') continue
    if (!ANNOTATIONS.includes(key)) violations.push(`${path}.${key} is not a supported keyword`)
  }
  if (Array.isArray(schema.oneOf)) {
    if (schema.oneOf.length < 2) violations.push(`${path}.oneOf must have at least two branches`)
    schema.oneOf.forEach((branch, index) => violations.push(...auditSchema(branch, `${path}.oneOf[${index}]`)))
    return violations
  }
  if (schema.type === undefined) {
    violations.push(`${path}.type is required`)
    return violations
  }
  if (!SCHEMA_TYPES.includes(schema.type)) violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
  if (schema.type === 'object') {
    if (schema.required !== undefined && !Array.isArray(schema.required)) violations.push(`${path}.required must be an array`)
    if (schema.properties !== undefined) {
      if (schema.properties === null || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
        violations.push(`${path}.properties must be an object of schemas`)
      } else {
        for (const [key, child] of Object.entries(schema.properties)) violations.push(...auditSchema(child, `${path}.properties.${key}`))
      }
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) violations.push(...auditSchema(schema.items, `${path}.items`))
  return violations
}

/**
 * Wrap a raw tool definition so every dispatch validates its arguments against
 * the declared parameter schema first (the equivalent of `defineTool`'s
 * wrapper, minus the host dependency).
 *
 * @param {object} definition name / description / parameters / output / execute
 * @param {{ audit?: boolean }} [options]
 * @returns {object} a registry-ready definition
 */
export function withArgumentValidation(definition, options = {}) {
  if (options.audit !== false) {
    const violations = auditSchema(definition.parameters, `tool "${definition.name}" parameters`)
    if (violations.length > 0) throw new TypeError(violations.join('; '))
  }
  const { execute } = definition
  return {
    ...definition,
    async execute(args, exec) {
      const violations = validateValue(definition.parameters, args, '')
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return execute(args ?? {}, exec)
    },
  }
}
