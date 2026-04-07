/**
 * Space Service Unit Tests
 *
 * Tests for workspace/space management service.
 * Covers space creation, listing, and stats calculation.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

import {
  getAicoBotSpace,
  listSpaces,
  createSpace,
  getSpace,
  deleteSpace,
  getAllSpacePaths,
  _resetSpaceRegistry
} from '../../../src/main/services/space.service'
import { initializeApp, getSpacesDir, getTempSpacePath } from '../../../src/main/services/config.service'

describe('Space Service', () => {
  beforeEach(async () => {
    // Reset the module-level registry so each test gets a fresh load from the new testDir
    _resetSpaceRegistry()
    await initializeApp()
  })

  describe('getAicoBotSpace', () => {
    it('should return the AICO-Bot temp space', () => {
      const aicoBotSpace = getAicoBotSpace()

      expect(aicoBotSpace.id).toBe('aico-bot-temp')
      expect(aicoBotSpace.name).toBe('AICO-Bot')
      expect(aicoBotSpace.isTemp).toBe(true)
      expect(aicoBotSpace.icon).toBe('sparkles')
    })

    it('should have valid path', () => {
      const aicoBotSpace = getAicoBotSpace()

      expect(aicoBotSpace.path).toBeTruthy()
      expect(fs.existsSync(aicoBotSpace.path)).toBe(true)
    })

  })

  describe('listSpaces', () => {
    it('should return empty array when no custom spaces exist', () => {
      const spaces = listSpaces()

      expect(Array.isArray(spaces)).toBe(true)
      expect(spaces.length).toBe(0)
    })

    it('should include created spaces', async () => {
      // Create a test space
      await createSpace({
        name: 'Test Project',
        icon: 'folder'
      })

      const spaces = listSpaces()

      expect(spaces.length).toBe(1)
      expect(spaces[0].name).toBe('Test Project')
    })
  })

  describe('createSpace', () => {
    it('should create a new space in default directory', async () => {
      const space = await createSpace({
        name: 'My Project',
        icon: 'code'
      })

      expect(space.id).toBeTruthy()
      expect(space.name).toBe('My Project')
      expect(space.icon).toBe('code')
      expect(space.isTemp).toBe(false)
      expect(fs.existsSync(space.path)).toBe(true)
    })

    it('should create .aico-bot directory inside space', async () => {
      const space = await createSpace({
        name: 'Test Space',
        icon: 'folder'
      })

      const aicoBotDir = path.join(space.path, '.aico-bot')
      expect(fs.existsSync(aicoBotDir)).toBe(true)
    })

    it('should create meta.json with space info', async () => {
      const space = await createSpace({
        name: 'Meta Test',
        icon: 'star'
      })

      const metaPath = path.join(space.path, '.aico-bot', 'meta.json')
      expect(fs.existsSync(metaPath)).toBe(true)

      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      expect(meta.name).toBe('Meta Test')
      expect(meta.icon).toBe('star')
      expect(meta.id).toBe(space.id)
    })

    it('should handle custom path', async () => {
      const customPath = path.join(getTempSpacePath(), 'custom-project')
      fs.mkdirSync(customPath, { recursive: true })

      const space = await createSpace({
        name: 'Custom Path Space',
        icon: 'folder',
        customPath
      })

      // Since the refactor, spaces are stored centrally under getSpacesDir()/{id}/.
      // customPath is stored as workingDir (the agent's working directory), not space.path.
      expect(space.path).toContain(getSpacesDir())
      expect((space as any).workingDir).toBe(customPath)
      expect(fs.existsSync(path.join(space.path, '.aico-bot', 'meta.json'))).toBe(true)
    })
  })

  describe('getSpace', () => {
    it('should return space by id', async () => {
      const created = await createSpace({
        name: 'Get Test',
        icon: 'folder'
      })

      const space = getSpace(created.id)

      expect(space).toBeDefined()
      expect(space?.id).toBe(created.id)
      expect(space?.name).toBe('Get Test')
    })

    it('should return null/undefined for non-existent id', () => {
      const space = getSpace('non-existent-id')
      expect(space).toBeFalsy() // null or undefined
    })

    it('should return AICO-Bot space for aico-bot-temp id', () => {
      const space = getSpace('aico-bot-temp')

      expect(space).toBeDefined()
      expect(space?.id).toBe('aico-bot-temp')
      expect(space?.isTemp).toBe(true)
    })
  })

  describe('deleteSpace', () => {
    it('should delete space and its .aico-bot directory', async () => {
      const space = await createSpace({
        name: 'Delete Test',
        icon: 'folder'
      })

      const aicoBotDir = path.join(space.path, '.aico-bot')
      expect(fs.existsSync(aicoBotDir)).toBe(true)

      const result = deleteSpace(space.id)
      expect(result.success).toBe(true)

      // .aico-bot should be deleted, but space directory may remain (for custom paths)
      expect(fs.existsSync(aicoBotDir)).toBe(false)
    })

    it('should not allow deleting AICO-Bot temp space', async () => {
      const result = deleteSpace('aico-bot-temp')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Cannot delete temp space')
    })
  })

  describe('getAllSpacePaths', () => {
    it('should include temp space path', () => {
      const paths = getAllSpacePaths()
      const tempPath = getTempSpacePath()

      expect(paths).toContain(tempPath)
    })

    it('should include created space paths', async () => {
      const space = await createSpace({
        name: 'Path Test',
        icon: 'folder'
      })

      const paths = getAllSpacePaths()

      expect(paths).toContain(space.path)
    })
  })
})
