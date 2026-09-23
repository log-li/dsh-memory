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
  // Gate 1: don't inject anything until the session's first real user message.
  deferUntilUserSpeaks: z.boolean().default(true),
  // Gate 2: only the currently active session (most recent user message) injects.
  activeSessionOnly: z.boolean().default(true),
  // Optional automemory: extract what a finished session is worth remembering.
  // Off by default — the only path that writes the store without the model
  // deciding to.
  autoMemory: z.boolean().default(false),
  recallEnabled: z.boolean().default(true),
  recallIntervalMinMinutes: z.number().default(30),
  recallIntervalMaxMinutes: z.number().default(240),
  recallMaxPerSession: z.number().default(3),
})
