/**
 * Unit Tests: apps/spec — YAML Parsing
 *
 * Tests the YAML parsing and normalization layer (parse.ts).
 * Covers: valid YAML, invalid YAML, field aliasing, shorthand expansion.
 */

import { describe, it, expect } from 'vitest'
import { parseAppSpec, AppSpecParseError } from '../../../../src/main/apps/spec'

describe('parseAppSpec - YAML parsing', () => {
  it('should parse valid YAML into an object', () => {
    const yaml = `
name: Test App
version: "1.0"
author: tester
description: A test app
type: skill
system_prompt: Do something
`
    const result = parseAppSpec(yaml)
    expect(result).toEqual({
      name: 'Test App',
      version: '1.0',
      author: 'tester',
      description: 'A test app',
      type: 'skill',
      system_prompt: 'Do something'
    })
  })

  it('should throw AppSpecParseError on malformed YAML', () => {
    const badYaml = `
name: Test App
  bad indent: oops
    this: is broken
`
    expect(() => parseAppSpec(badYaml)).toThrow(AppSpecParseError)
  })

  it('should throw AppSpecParseError on empty string', () => {
    expect(() => parseAppSpec('')).toThrow(AppSpecParseError)
  })

  it('should throw AppSpecParseError on scalar YAML', () => {
    expect(() => parseAppSpec('just a string')).toThrow(AppSpecParseError)
  })

  it('should throw AppSpecParseError on array YAML', () => {
    expect(() => parseAppSpec('- item1\n- item2')).toThrow(AppSpecParseError)
  })
})

describe('parseAppSpec - field normalization', () => {
  it('should normalize "inputs" to "config_schema"', () => {
    const yaml = `
name: Test
version: "1.0"
author: tester
description: test
type: automation
system_prompt: test
inputs:
  - key: url
    label: URL
    type: url
`
    const result = parseAppSpec(yaml) as Record<string, unknown>
    expect(result.config_schema).toBeDefined()
    expect(result.inputs).toBeUndefined()
    expect((result.config_schema as Array<unknown>)[0]).toEqual({
      key: 'url',
      label: 'URL',
      type: 'url'
    })
  })

  it('should not overwrite explicit config_schema with inputs', () => {
    const yaml = `
name: Test
version: "1.0"
author: tester
description: test
type: automation
system_prompt: test
config_schema:
  - key: real
    label: Real
    type: text
inputs:
  - key: alias
    label: Alias
    type: text
`
    const result = parseAppSpec(yaml) as Record<string, unknown>
    expect((result.config_schema as Array<Record<string, unknown>>)[0].key).toBe('real')
  })

  it('should normalize flat "required_mcps" to "requires.mcps"', () => {
    const yaml = `
name: Test
version: "1.0"
author: tester
description: test
type: automation
system_prompt: test
required_mcps:
  - id: ai-browser
    reason: For web access
`
    const result = parseAppSpec(yaml) as Record<string, unknown>
    expect(result.required_mcps).toBeUndefined()
    const requires = result.requires as Record<string, unknown>
    expect(requires.mcps).toEqual([{ id: 'ai-browser', reason: 'For web access' }])
  })

  it('should normalize string-array required_mcps to objects', () => {
    const yaml = `
name: Test
version: "1.0"
author: tester
description: test
type: automation
system_prompt: test
required_mcps:
  - ai-browser
  - postgres
`
    const result = parseAppSpec(yaml) as Record<string, unknown>
    const requires = result.requires as Record<string, unknown>
    expect(requires.mcps).toEqual([
      { id: 'ai-browser' },
      { id: 'postgres' }
    ])
  })

  it('should normalize flat "required_skills" to "requires.skills"', () => {
    const yaml = `
name: Test
version: "1.0"
author: tester
description: test
type: automation
system_prompt: test
required_skills:
  - price-analysis
`
    const result = parseAppSpec(yaml) as Record<string, unknown>
    expect(result.required_skills).toBeUndefined()
    const requires = result.requires as Record<string, unknown>
    expect(requires.skills).toEqual(['price-analysis'])
  })

  it('should normalize requires.mcp to requires.mcps', () => {
    const yaml = `
name: Test
version: "1.0"
author: tester
description: test
type: automation
system_prompt: test
requires:
  mcp:
    - ai-browser
`
    const result = parseAppSpec(yaml) as Record<string, unknown>
    const requires = result.requires as Record<string, unknown>
    expect(requires.mcps).toEqual([{ id: 'ai-browser' }])
    expect(requires.mcp).toBeUndefined()
  })

  it('should normalize subscription shorthand (type at top level)', () => {
    const yaml = `
name: Test
version: "1.0"
author: tester
description: test
type: automation
system_prompt: test
subscriptions:
  - type: schedule
    config:
      every: "30m"
`
    const result = parseAppSpec(yaml) as Record<string, unknown>
    const subs = result.subscriptions as Array<Record<string, unknown>>
    expect(subs[0].source).toEqual({
      type: 'schedule',
      config: { every: '30m' }
    })
  })

  it('should normalize subscription "input" to "config_key"', () => {
    const yaml = `
name: Test
version: "1.0"
author: tester
description: test
type: automation
system_prompt: test
subscriptions:
  - type: webpage
    config:
      watch: price-element
    input: product_url
`
    const result = parseAppSpec(yaml) as Record<string, unknown>
    const subs = result.subscriptions as Array<Record<string, unknown>>
    expect(subs[0]).toHaveProperty('config_key', 'product_url')
  })
})
