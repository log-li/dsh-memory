/**
 * Shared schemas for @log.li/dsh-memory.
 *
 * Split out so the config store can validate without importing the plugin
 * entry (which imports the store).
 *
 * @module @log.li/dsh-memory/schema
 */

import z from '@deepseek-ai/schemastery'

/** The user-facing settings schema: composition config is the base layer. */
export const SettingsSchema = z.object({
  enabled: z.boolean().default(true),
  memoryDir: z.string().default('~/.memory'),
  autoInject: z.boolean().default(true),
  registerSkill: z.boolean().default(true),
  registerTools: z.boolean().default(true),
  // Catalog boot entries: 'derive' injects the salience=1 hot subset (never
  // truncated), 'off' injects the literal file.
  indexBootMode: z.union([z.const('off'), z.const('derive')]).default('derive'),
  // Automemory (default ON since v0.8.0): the silent end-of-turn extraction
  // that replaced the removed digest reminder. Hot-toggleable in the panel.
  autoMemory: z.boolean().default(true),
})
