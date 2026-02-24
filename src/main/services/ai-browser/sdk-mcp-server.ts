/**
 * AI Browser SDK MCP Server
 *
 * Creates an in-process MCP server using Claude Agent SDK's
 * tool() and createSdkMcpServer() functions.
 *
 * This is the single authoritative implementation of all AI Browser tools.
 * Every tool handler is wrapped with a per-tool timeout to prevent
 * indefinite hangs when the browser becomes unresponsive.
 *
 * NOTE: The tools/ directory contains a DEAD CODE duplicate of these handlers
 * using JSON Schema format. That code is never executed — all live tool calls
 * go through this file via the SDK MCP server.
 *
 * TODO: Refactor — split this 1200+ line file into tools/ by category
 * (input.ts, navigation.ts, snapshot.ts, etc.), each using SDK tool() + Zod.
 * This file should then become a thin aggregation layer that imports and
 * re-exports. The current tools/ JSON Schema definitions and their IPC
 * plumbing (index.ts executeAIBrowserTool, ipc/ai-browser.ts handlers with
 * no renderer callers) should be deleted as part of that refactor.
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { browserContext, type BrowserContext } from './context'
import { browserViewManager } from '../browser-view.service'

// ============================================
// Constants
// ============================================

/** Default per-tool timeout (ms). Individual tools may override. */
const TOOL_TIMEOUT = 60_000
/** Default navigation wait timeout (ms). */
const NAV_TIMEOUT = 30_000

// ============================================
// Helpers
// ============================================

/** Convenience: wrap a promise with a timeout guard. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) }
    )
  })
}

/** Build a standard text content response. */
function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {})
  }
}

/** Build an image + text content response. */
function imageResult(text: string, data: string, mimeType: string) {
  return {
    content: [
      { type: 'text' as const, text },
      { type: 'image' as const, data, mimeType }
    ]
  }
}

/**
 * Determine how to fill a form element, handling combobox disambiguation.
 */
async function fillFormElement(ctx: BrowserContext, uid: string, value: string): Promise<void> {
  const element = ctx.getElementByUid(uid)

  if (element && element.role === 'combobox') {
    const hasOptions = element.children?.some(child => child.role === 'option')
    if (hasOptions) {
      try {
        await ctx.selectOption(uid, value)
        return
      } catch (e) {
        // Only fall back for "option not found" — rethrow infrastructure errors (CDP failures, etc.)
        if (!(e instanceof Error) || !e.message.includes('Could not find option')) {
          throw e
        }
        // No matching option — combobox may be editable, fall back to text input
      }
    }
    // Editable combobox (no options, or no matching option) — fill as text
    await ctx.fillElement(uid, value)
    return
  }

  await ctx.fillElement(uid, value)
}

// ============================================
// Navigation Tools (8 tools)
// ============================================

/**
 * Build all 26 AI Browser tools, closing over the provided BrowserContext.
 * This allows each MCP server instance to operate on its own context
 * (scoped activeViewId) while sharing the same browserViewManager session.
 */
function buildAllTools(ctx: BrowserContext) {

const browser_list_pages = tool(
  'browser_list_pages',
  'Get a list of pages open in the browser.',
  {},
  async () => {
    const states = browserViewManager.getAllStates()

    if (states.length === 0) {
      return textResult('No browser pages are currently open.')
    }

    const lines = ['Open browser pages:']
    states.forEach((state, index) => {
      lines.push(`[${index}] ${state.title || 'Untitled'} - ${state.url || 'about:blank'}`)
    })

    return textResult(lines.join('\n'))
  }
)

const browser_select_page = tool(
  'browser_select_page',
  'Select a page as a context for future tool calls.',
  {
    pageIdx: z.number().describe('The index of the page to select. Call browser_list_pages to get available pages.'),
    bringToFront: z.boolean().optional().describe('Whether to focus the page and bring it to the top.')
  },
  async (args) => {
    const states = browserViewManager.getAllStates()

    if (args.pageIdx < 0 || args.pageIdx >= states.length) {
      return textResult(`Invalid page index: ${args.pageIdx}. Valid range: 0-${states.length - 1}`, true)
    }

    const state = states[args.pageIdx]
    ctx.setActiveViewId(state.id)

    return textResult(`Selected page [${args.pageIdx}]: ${state.title || 'Untitled'} - ${state.url}`)
  }
)

const browser_new_page = tool(
  'browser_new_page',
  'Creates a new page',
  {
    url: z.string().describe('URL to load in a new page.'),
    timeout: z.number().int().optional().describe('Maximum wait time in milliseconds. If set to 0, the default timeout will be used.')
  },
  async (args) => {
    const timeout = (args.timeout && args.timeout > 0) ? args.timeout : NAV_TIMEOUT

    try {
      const viewId = `ai-browser-${Date.now()}`
      // Scoped (automation) contexts use the offscreen host window to isolate
      // view lifecycle from the user's mainWindow.
      await browserViewManager.create(viewId, args.url, { offscreen: ctx.isScoped })
      ctx.trackView(viewId)
      ctx.setActiveViewId(viewId)

      // Wait for navigation with timeout protection (no busy-wait)
      await ctx.waitForNavigation(timeout)

      const finalState = browserViewManager.getState(viewId)
      return textResult(`Created new page: ${finalState?.title || 'Untitled'} - ${finalState?.url || args.url}`)
    } catch (error) {
      return textResult(`Failed to create new page: ${(error as Error).message}`, true)
    }
  }
)

const browser_close_page = tool(
  'browser_close_page',
  'Closes the page by its index. The last open page cannot be closed.',
  {
    pageIdx: z.number().describe('The index of the page to close. Call list_pages to list pages.')
  },
  async (args) => {
    const states = browserViewManager.getAllStates()

    if (args.pageIdx < 0 || args.pageIdx >= states.length) {
      return textResult(`Invalid page index: ${args.pageIdx}`, true)
    }

    if (states.length === 1) {
      return textResult('The last open page cannot be closed.', true)
    }

    const state = states[args.pageIdx]
    browserViewManager.destroy(state.id)

    return textResult(`Closed page [${args.pageIdx}]: ${state.title || 'Untitled'}`)
  }
)

const browser_navigate = tool(
  'browser_navigate',
  'Navigates the currently selected page to a URL.',
  {
    type: z.enum(['url', 'back', 'forward', 'reload']).optional().describe('Navigate the page by URL, back or forward in history, or reload.'),
    url: z.string().optional().describe('Target URL (only type=url)'),
    ignoreCache: z.boolean().optional().describe('Whether to ignore cache on reload.'),
    timeout: z.number().int().optional().describe('Maximum wait time in milliseconds. If set to 0, the default timeout will be used.')
  },
  async (args) => {
    const navType = args.type || (args.url ? 'url' : undefined)
    const timeout = (args.timeout && args.timeout > 0) ? args.timeout : NAV_TIMEOUT

    if (!navType && !args.url) {
      return textResult('Either URL or a type is required.', true)
    }

    const viewId = ctx.getActiveViewId()
    if (!viewId) {
      return textResult('No active browser page. Use browser_new_page first.', true)
    }

    try {
      switch (navType) {
        case 'back':
          browserViewManager.goBack(viewId)
          await ctx.waitForNavigation(timeout)
          return textResult(`Successfully navigated back.`)
        case 'forward':
          browserViewManager.goForward(viewId)
          await ctx.waitForNavigation(timeout)
          return textResult(`Successfully navigated forward.`)
        case 'reload':
          browserViewManager.reload(viewId)
          await ctx.waitForNavigation(timeout)
          return textResult(`Successfully reloaded the page.`)
        case 'url':
        default:
          if (!args.url) {
            return textResult('A URL is required for navigation of type=url.', true)
          }
          await browserViewManager.navigate(viewId, args.url)
          await ctx.waitForNavigation(timeout)
          break
      }

      const finalState = browserViewManager.getState(viewId)
      return textResult(`Successfully navigated to ${finalState?.url || args.url}.`)
    } catch (error) {
      return textResult(`Unable to navigate in the selected page: ${(error as Error).message}.`, true)
    }
  }
)

const browser_wait_for = tool(
  'browser_wait_for',
  'Wait for the specified text to appear on the selected page.',
  {
    text: z.string().describe('Text to appear on the page'),
    timeout: z.number().int().optional().describe('Maximum wait time in milliseconds. If set to 0, the default timeout will be used.')
  },
  async (args) => {
    const timeout = (args.timeout && args.timeout > 0) ? args.timeout : NAV_TIMEOUT

    try {
      await ctx.waitForText(args.text, timeout)
      return textResult(`Element with text "${args.text}" found.`)
    } catch {
      return textResult(`Timeout waiting for text: "${args.text}"`, true)
    }
  }
)

const browser_resize = tool(
  'browser_resize',
  "Resizes the selected page's window so that the page has specified dimension",
  {
    width: z.number().describe('Page width'),
    height: z.number().describe('Page height')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    try {
      await ctx.setViewportSize(args.width, args.height)
      return textResult(`Viewport resized to: ${args.width}x${args.height}`)
    } catch (error) {
      return textResult(`Resize failed: ${(error as Error).message}`, true)
    }
  }
)

const browser_handle_dialog = tool(
  'browser_handle_dialog',
  'If a browser dialog was opened, use this command to handle it',
  {
    action: z.enum(['accept', 'dismiss']).describe('Whether to dismiss or accept the dialog'),
    promptText: z.string().optional().describe('Optional prompt text to enter into the dialog.')
  },
  async (args) => {
    const dialog = ctx.getPendingDialog()
    if (!dialog) {
      return textResult('No open dialog found', true)
    }

    try {
      await ctx.handleDialog(args.action === 'accept', args.promptText)
      return textResult(`Successfully ${args.action === 'accept' ? 'accepted' : 'dismissed'} the dialog`)
    } catch (error) {
      return textResult(`Failed to handle dialog: ${(error as Error).message}`, true)
    }
  }
)

// ============================================
// Input Tools (7 tools)
// ============================================

const browser_click = tool(
  'browser_click',
  'Clicks on the provided element',
  {
    uid: z.string().describe('The uid of an element on the page from the page content snapshot'),
    dblClick: z.boolean().optional().describe('Set to true for double clicks. Default is false.')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page. Use browser_new_page first.', true)
    }

    try {
      await withTimeout(
        ctx.clickElement(args.uid, { dblClick: args.dblClick || false }),
        TOOL_TIMEOUT,
        'browser_click'
      )
      return textResult(
        args.dblClick
          ? 'Successfully double clicked on the element'
          : 'Successfully clicked on the element'
      )
    } catch (error) {
      return textResult(`Failed to click element ${args.uid}: ${(error as Error).message}`, true)
    }
  }
)

const browser_hover = tool(
  'browser_hover',
  'Hover over the provided element',
  {
    uid: z.string().describe('The uid of an element on the page from the page content snapshot')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    try {
      await withTimeout(
        ctx.hoverElement(args.uid),
        TOOL_TIMEOUT,
        'browser_hover'
      )
      return textResult('Successfully hovered over the element')
    } catch (error) {
      return textResult(`Failed to hover element ${args.uid}: ${(error as Error).message}`, true)
    }
  }
)

const browser_fill = tool(
  'browser_fill',
  'Type text into a input, text area or select an option from a <select> element.',
  {
    uid: z.string().describe('The uid of an element on the page from the page content snapshot'),
    value: z.string().describe('The value to fill in')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    try {
      await withTimeout(
        fillFormElement(ctx, args.uid, args.value),
        TOOL_TIMEOUT,
        'browser_fill'
      )
      return textResult('Successfully filled out the element')
    } catch (error) {
      return textResult(`Failed to fill element ${args.uid}: ${(error as Error).message}`, true)
    }
  }
)

const browser_fill_form = tool(
  'browser_fill_form',
  'Fill out multiple form elements at once',
  {
    elements: z.array(z.object({
      uid: z.string().describe('The uid of the element to fill out'),
      value: z.string().describe('Value for the element')
    })).describe('Elements from snapshot to fill out.')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    const errors: string[] = []

    for (const elem of args.elements) {
      try {
        await withTimeout(
          fillFormElement(ctx, elem.uid, elem.value),
          TOOL_TIMEOUT,
          'browser_fill_form'
        )
      } catch (error) {
        errors.push(`${elem.uid}: ${(error as Error).message}`)
      }
    }

    if (errors.length > 0) {
      return textResult(
        `Partially filled out the form.\n\nErrors:\n${errors.join('\n')}`,
        errors.length === args.elements.length
      )
    }

    return textResult('Successfully filled out the form')
  }
)

const browser_drag = tool(
  'browser_drag',
  'Drag an element onto another element',
  {
    from_uid: z.string().describe('The uid of the element to drag'),
    to_uid: z.string().describe('The uid of the element to drop into')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    try {
      await withTimeout(
        ctx.dragElement(args.from_uid, args.to_uid),
        TOOL_TIMEOUT,
        'browser_drag'
      )
      return textResult('Successfully dragged an element')
    } catch (error) {
      return textResult(`Failed to drag: ${(error as Error).message}`, true)
    }
  }
)

const browser_press_key = tool(
  'browser_press_key',
  'Press a key or key combination. Use this when other input methods like fill() cannot be used (e.g., keyboard shortcuts, navigation keys, or special key combinations).',
  {
    key: z.string().describe('A key or a combination (e.g., "Enter", "Control+A", "Control++", "Control+Shift+R"). Modifiers: Control, Shift, Alt, Meta')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    try {
      await withTimeout(
        ctx.pressKey(args.key),
        TOOL_TIMEOUT,
        'browser_press_key'
      )
      return textResult(`Successfully pressed key: ${args.key}`)
    } catch (error) {
      return textResult(`Failed to press key: ${(error as Error).message}`, true)
    }
  }
)

const browser_upload_file = tool(
  'browser_upload_file',
  'Upload a file through a provided element.',
  {
    uid: z.string().describe('The uid of the file input element or an element that will open file chooser on the page from the page content snapshot'),
    filePath: z.string().describe('The local path of the file to upload')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    try {
      const element = ctx.getElementByUid(args.uid)
      if (!element) {
        throw new Error(`Element not found: ${args.uid}`)
      }

      await withTimeout(
        ctx.sendCDPCommand('DOM.setFileInputFiles', {
          backendNodeId: element.backendNodeId,
          files: [args.filePath]
        }),
        TOOL_TIMEOUT,
        'browser_upload_file'
      )

      return textResult(`File uploaded from ${args.filePath}.`)
    } catch (error) {
      return textResult(`Failed to upload file: ${(error as Error).message}`, true)
    }
  }
)

// ============================================
// Snapshot Tools (3 tools)
// ============================================

const browser_snapshot = tool(
  'browser_snapshot',
  `Take a text snapshot of the currently selected page based on the a11y tree. The snapshot lists page elements along with a unique
identifier (uid). Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot. The snapshot indicates the element selected
in the DevTools Elements panel (if any).`,
  {
    verbose: z.boolean().optional().describe('Whether to include all possible information available in the full a11y tree. Default is false.'),
    filePath: z.string().optional().describe('The absolute path, or a path relative to the current working directory, to save the snapshot to instead of attaching it to the response.')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page. Use browser_new_page first.', true)
    }

    try {
      const snapshot = await withTimeout(
        ctx.createSnapshot(args.verbose || false),
        TOOL_TIMEOUT,
        'browser_snapshot'
      )
      const formatted = snapshot.format(args.verbose || false)

      if (args.filePath) {
        const { writeFileSync } = require('fs')
        writeFileSync(args.filePath, formatted, 'utf-8')
        return textResult(`Snapshot saved to: ${args.filePath}\n\nPage: ${snapshot.title}\nURL: ${snapshot.url}\nElements: ${snapshot.idToNode.size}`)
      }

      return textResult(formatted)
    } catch (error) {
      return textResult(`Failed to take snapshot: ${(error as Error).message}`, true)
    }
  }
)

const browser_screenshot = tool(
  'browser_screenshot',
  'Take a screenshot of the page or element.',
  {
    format: z.enum(['png', 'jpeg', 'webp']).optional().describe('Type of format to save the screenshot as. Default is "png"'),
    quality: z.number().optional().describe('Compression quality for JPEG and WebP formats (0-100). Ignored for PNG format.'),
    uid: z.string().optional().describe('The uid of an element on the page from the page content snapshot. If omitted takes a pages screenshot.'),
    fullPage: z.boolean().optional().describe('If set to true takes a screenshot of the full page instead of the currently visible viewport. Incompatible with uid.'),
    filePath: z.string().optional().describe('The absolute path, or a path relative to the current working directory, to save the screenshot to instead of attaching it to the response.')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    if (args.uid && args.fullPage) {
      return textResult('Providing both "uid" and "fullPage" is not allowed.', true)
    }

    try {
      const format = args.format || 'png'
      const result = await withTimeout(
        ctx.captureScreenshot({
          format,
          quality: format === 'png' ? undefined : args.quality,
          uid: args.uid,
          fullPage: args.fullPage || false
        }),
        TOOL_TIMEOUT,
        'browser_screenshot'
      )

      let message: string
      if (args.uid) {
        message = `Took a screenshot of node with uid "${args.uid}".`
      } else if (args.fullPage) {
        message = 'Took a screenshot of the full current page.'
      } else {
        message = "Took a screenshot of the current page's viewport."
      }

      if (args.filePath) {
        const { writeFileSync } = require('fs')
        const buffer = Buffer.from(result.data, 'base64')
        writeFileSync(args.filePath, buffer)
        return textResult(`${message}\nSaved screenshot to ${args.filePath}.`)
      }

      return imageResult(message, result.data, result.mimeType)
    } catch (error) {
      return textResult(`Failed to take screenshot: ${(error as Error).message}`, true)
    }
  }
)

const browser_evaluate = tool(
  'browser_evaluate',
  `Evaluate a JavaScript function inside the currently selected page. Returns the response as JSON
so returned values have to JSON-serializable.`,
  {
    function: z.string().describe(`A JavaScript function declaration to be executed by the tool in the currently selected page.
Example without arguments: \`() => {
  return document.title
}\` or \`async () => {
  return await fetch("example.com")
}\`.
Example with arguments: \`(el) => {
  return el.innerText;
}\`
`),
    args: z.array(z.object({
      uid: z.string().describe('The uid of an element on the page from the page content snapshot')
    })).optional().describe('An optional list of arguments to pass to the function.')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    try {
      const elementArgs: unknown[] = []
      if (args.args && args.args.length > 0) {
        for (const arg of args.args) {
          const element = ctx.getElementByUid(arg.uid)
          if (!element) {
            throw new Error(`Element not found: ${arg.uid}`)
          }
          elementArgs.push(element)
        }
      }

      const result = await withTimeout(
        ctx.evaluateScript(args.function, elementArgs),
        TOOL_TIMEOUT,
        'browser_evaluate'
      )
      const resultStr = typeof result === 'object'
        ? JSON.stringify(result, null, 2)
        : String(result)

      return textResult(`Script ran on page and returned:\n\`\`\`json\n${resultStr}\n\`\`\``)
    } catch (error) {
      return textResult(`Script error: ${(error as Error).message}`, true)
    }
  }
)

// ============================================
// Network Tools (2 tools)
// ============================================

const FILTERABLE_RESOURCE_TYPES = [
  'document', 'stylesheet', 'image', 'media', 'font', 'script',
  'texttrack', 'xhr', 'fetch', 'prefetch', 'eventsource', 'websocket',
  'manifest', 'signedexchange', 'ping', 'cspviolationreport', 'preflight',
  'fedcm', 'other'
] as const

const browser_network_requests = tool(
  'browser_network_requests',
  'List all requests for the currently selected page since the last navigation.',
  {
    pageSize: z.number().int().positive().optional().describe('Maximum number of requests to return. When omitted, returns all requests.'),
    pageIdx: z.number().int().min(0).optional().describe('Page number to return (0-based). When omitted, returns the first page.'),
    resourceTypes: z.array(z.string()).optional().describe('Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests.'),
    includePreservedRequests: z.boolean().optional().describe('Set to true to return the preserved requests over the last 3 navigations.')
  },
  async (args) => {
    try {
      let requests = ctx.getNetworkRequests(args.includePreservedRequests || false)

      // Filter by resource type
      if (args.resourceTypes && args.resourceTypes.length > 0) {
        const types = new Set(args.resourceTypes.map(t => t.toLowerCase()))
        requests = requests.filter(r => types.has(r.resourceType.toLowerCase()))
      }

      const total = requests.length

      // Pagination
      const pageIdx = args.pageIdx || 0
      let pageRequests: typeof requests
      if (args.pageSize !== undefined) {
        const startIdx = pageIdx * args.pageSize
        const endIdx = Math.min(startIdx + args.pageSize, total)
        pageRequests = requests.slice(startIdx, endIdx)
      } else {
        pageRequests = requests
      }

      if (pageRequests.length === 0) {
        return textResult('No network requests captured.')
      }

      const lines: string[] = []
      if (args.pageSize !== undefined) {
        const startIdx = pageIdx * args.pageSize
        const endIdx = Math.min(startIdx + args.pageSize, total)
        lines.push(`Network Requests (${startIdx + 1}-${endIdx} of ${total}):`)
      } else {
        lines.push(`Network Requests (${total} total):`)
      }
      lines.push('')

      for (const req of pageRequests) {
        const status = req.status ? `${req.status}` : 'pending'
        const duration = req.timing?.duration ? `${req.timing.duration}ms` : '-'
        lines.push(`[reqid=${req.id}] ${req.method} ${status} ${req.resourceType}`)
        lines.push(`    URL: ${req.url.substring(0, 100)}${req.url.length > 100 ? '...' : ''}`)
        lines.push(`    Duration: ${duration}`)
        if (req.error) {
          lines.push(`    Error: ${req.error}`)
        }
        lines.push('')
      }

      if (args.pageSize !== undefined && pageIdx * args.pageSize + pageRequests.length < total) {
        lines.push(`Use pageIdx=${pageIdx + 1} to see more requests.`)
      }

      return textResult(lines.join('\n'))
    } catch (error) {
      return textResult(`Failed to get network requests: ${(error as Error).message}`, true)
    }
  }
)

const browser_network_request = tool(
  'browser_network_request',
  'Gets a network request by an optional reqid, if omitted returns the currently selected request in the DevTools Network panel.',
  {
    reqid: z.number().optional().describe('The reqid of the network request.')
  },
  async (args) => {
    try {
      let request

      if (args.reqid !== undefined) {
        request = ctx.getNetworkRequest(String(args.reqid))
      } else {
        const selectedReq = (ctx as any).getSelectedNetworkRequest?.()
        if (!selectedReq) {
          return textResult('Nothing is currently selected in the DevTools Network panel.')
        }
        request = selectedReq
      }

      if (!request) {
        return textResult(`Request not found: ${args.reqid}`, true)
      }

      const lines = [
        `# Network Request: reqid=${request.id}`,
        '',
        `## Basic Info`,
        `URL: ${request.url}`,
        `Method: ${request.method}`,
        `Resource Type: ${request.resourceType}`,
        `Status: ${request.status || 'pending'} ${request.statusText || ''}`,
        `MIME Type: ${request.mimeType || 'unknown'}`,
        ''
      ]

      if (request.timing) {
        lines.push(`## Timing`)
        lines.push(`Duration: ${request.timing.duration}ms`)
        lines.push('')
      }

      if (request.requestHeaders && Object.keys(request.requestHeaders).length > 0) {
        lines.push(`## Request Headers`)
        for (const [key, value] of Object.entries(request.requestHeaders)) {
          lines.push(`${key}: ${value}`)
        }
        lines.push('')
      }

      if (request.responseHeaders && Object.keys(request.responseHeaders).length > 0) {
        lines.push(`## Response Headers`)
        for (const [key, value] of Object.entries(request.responseHeaders)) {
          lines.push(`${key}: ${value}`)
        }
        lines.push('')
      }

      if (request.requestBody) {
        lines.push(`## Request Body`)
        lines.push('```')
        lines.push(request.requestBody.substring(0, 2000))
        if (request.requestBody.length > 2000) {
          lines.push('... (truncated)')
        }
        lines.push('```')
        lines.push('')
      }

      if (request.error) {
        lines.push(`## Error`)
        lines.push(request.error)
      }

      return textResult(lines.join('\n'))
    } catch (error) {
      return textResult(`Failed to get request details: ${(error as Error).message}`, true)
    }
  }
)

// ============================================
// Console Tools (2 tools)
// ============================================

const browser_console = tool(
  'browser_console',
  'List all console messages for the currently selected page since the last navigation.',
  {
    pageSize: z.number().int().positive().optional().describe('Maximum number of messages to return. When omitted, returns all messages.'),
    pageIdx: z.number().int().min(0).optional().describe('Page number to return (0-based). When omitted, returns the first page.'),
    types: z.array(z.string()).optional().describe('Filter messages to only return messages of the specified types. When omitted or empty, returns all messages.'),
    includePreservedMessages: z.boolean().optional().describe('Set to true to return the preserved messages over the last 3 navigations.')
  },
  async (args) => {
    try {
      let messages = ctx.getConsoleMessages(args.includePreservedMessages || false)

      // Filter by type
      if (args.types && args.types.length > 0) {
        const typeSet = new Set(args.types)
        messages = messages.filter(m => typeSet.has(m.type))
      }

      const total = messages.length

      // Pagination
      const pageIdx = args.pageIdx || 0
      let pageMessages: typeof messages
      if (args.pageSize !== undefined) {
        const startIdx = pageIdx * args.pageSize
        const endIdx = Math.min(startIdx + args.pageSize, total)
        pageMessages = messages.slice(startIdx, endIdx)
      } else {
        pageMessages = messages
      }

      if (pageMessages.length === 0) {
        return textResult('No console messages captured.')
      }

      const lines: string[] = []
      if (args.pageSize !== undefined) {
        const startIdx = pageIdx * args.pageSize
        const endIdx = Math.min(startIdx + args.pageSize, total)
        lines.push(`Console Messages (${startIdx + 1}-${endIdx} of ${total}):`)
      } else {
        lines.push(`Console Messages (${total} total):`)
      }
      lines.push('')

      for (const msg of pageMessages) {
        const time = new Date(msg.timestamp).toLocaleTimeString()
        lines.push(`[msgid=${msg.id}] ${msg.type.toUpperCase()} (${time})`)
        lines.push(`    ${msg.text.substring(0, 200)}${msg.text.length > 200 ? '...' : ''}`)
        if (msg.url) {
          lines.push(`    at ${msg.url}${msg.lineNumber !== undefined ? `:${msg.lineNumber}` : ''}`)
        }
        lines.push('')
      }

      if (args.pageSize !== undefined && pageIdx * args.pageSize + pageMessages.length < total) {
        lines.push(`Use pageIdx=${pageIdx + 1} to see more messages.`)
      }

      return textResult(lines.join('\n'))
    } catch (error) {
      return textResult(`Failed to get console messages: ${(error as Error).message}`, true)
    }
  }
)

const browser_console_message = tool(
  'browser_console_message',
  'Gets a console message by its ID. You can get all messages by calling browser_console.',
  {
    msgid: z.number().describe('The msgid of a console message on the page from the listed console messages')
  },
  async (args) => {
    try {
      const message = ctx.getConsoleMessage(String(args.msgid))

      if (!message) {
        return textResult(`Message not found: ${args.msgid}`, true)
      }

      const time = new Date(message.timestamp).toLocaleString()

      const lines = [
        `# Console Message: msgid=${message.id}`,
        '',
        `## Type: ${message.type.toUpperCase()}`,
        `Timestamp: ${time}`,
        ''
      ]

      if (message.url) {
        lines.push(`## Source`)
        lines.push(`File: ${message.url}`)
        if (message.lineNumber !== undefined) {
          lines.push(`Line: ${message.lineNumber}`)
        }
        lines.push('')
      }

      lines.push(`## Message`)
      lines.push('```')
      lines.push(message.text)
      lines.push('```')

      if (message.stackTrace) {
        lines.push('')
        lines.push(`## Stack Trace`)
        lines.push('```')
        lines.push(message.stackTrace)
        lines.push('```')
      }

      if (message.args && message.args.length > 0) {
        lines.push('')
        lines.push(`## Arguments`)
        lines.push('```json')
        lines.push(JSON.stringify(message.args, null, 2))
        lines.push('```')
      }

      return textResult(lines.join('\n'))
    } catch (error) {
      return textResult(`Failed to get message details: ${(error as Error).message}`, true)
    }
  }
)

// ============================================
// Emulation Tools (1 tool)
// ============================================

const NETWORK_CONDITIONS: Record<string, { download: number; upload: number; latency: number }> = {
  'Slow 3G': { download: 500 * 1024 / 8, upload: 500 * 1024 / 8, latency: 400 },
  'Fast 3G': { download: 1.6 * 1024 * 1024 / 8, upload: 750 * 1024 / 8, latency: 150 },
  'Regular 4G': { download: 4 * 1024 * 1024 / 8, upload: 3 * 1024 * 1024 / 8, latency: 20 },
  'DSL': { download: 2 * 1024 * 1024 / 8, upload: 1 * 1024 * 1024 / 8, latency: 5 },
  'WiFi': { download: 30 * 1024 * 1024 / 8, upload: 15 * 1024 * 1024 / 8, latency: 2 }
}

const browser_emulate = tool(
  'browser_emulate',
  'Emulates various features on the selected page.',
  {
    networkConditions: z.enum([
      'No emulation', 'Offline', 'Slow 3G', 'Fast 3G', 'Regular 4G', 'DSL', 'WiFi'
    ]).optional().describe('Throttle network. Set to "No emulation" to disable. If omitted, conditions remain unchanged.'),
    cpuThrottlingRate: z.number().min(1).max(20).optional().describe('Represents the CPU slowdown factor. Set the rate to 1 to disable throttling. If omitted, throttling remains unchanged.'),
    geolocation: z.object({
      latitude: z.number().min(-90).max(90).describe('Latitude between -90 and 90.'),
      longitude: z.number().min(-180).max(180).describe('Longitude between -180 and 180.')
    }).nullable().optional().describe('Geolocation to emulate. Set to null to clear the geolocation override.')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    const results: string[] = []

    try {
      // Network conditions
      if (args.networkConditions !== undefined) {
        if (args.networkConditions === 'No emulation') {
          await ctx.sendCDPCommand('Network.emulateNetworkConditions', {
            offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
          })
          results.push('Network: No emulation')
        } else if (args.networkConditions === 'Offline') {
          await ctx.sendCDPCommand('Network.emulateNetworkConditions', {
            offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
          })
          results.push('Network: Offline')
        } else if (args.networkConditions in NETWORK_CONDITIONS) {
          const cond = NETWORK_CONDITIONS[args.networkConditions]
          await ctx.sendCDPCommand('Network.emulateNetworkConditions', {
            offline: false, latency: cond.latency,
            downloadThroughput: cond.download, uploadThroughput: cond.upload
          })
          results.push(`Network: ${args.networkConditions}`)
        }
      }

      // CPU throttling
      if (args.cpuThrottlingRate !== undefined) {
        await ctx.sendCDPCommand('Emulation.setCPUThrottlingRate', {
          rate: args.cpuThrottlingRate
        })
        results.push(`CPU throttling: ${args.cpuThrottlingRate}x`)
      }

      // Geolocation
      if (args.geolocation !== undefined) {
        if (args.geolocation === null) {
          await ctx.sendCDPCommand('Emulation.clearGeolocationOverride')
          results.push('Geolocation: cleared')
        } else {
          await ctx.sendCDPCommand('Emulation.setGeolocationOverride', {
            latitude: args.geolocation.latitude,
            longitude: args.geolocation.longitude,
            accuracy: 100
          })
          results.push(`Geolocation: ${args.geolocation.latitude}, ${args.geolocation.longitude}`)
        }
      }

      if (results.length === 0) {
        return textResult('No emulation settings changed.')
      }

      return textResult(results.join('\n'))
    } catch (error) {
      return textResult(`Emulation failed: ${(error as Error).message}`, true)
    }
  }
)

// ============================================
// Performance Tools (3 tools)
// ============================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatTraceResults(duration: number, metrics: Record<string, number>): string {
  const lines = [
    'The performance trace has been stopped.',
    '',
    '## Trace Summary',
    `Duration: ${duration}ms`,
    '',
    '## Core Metrics'
  ]

  if (metrics.JSHeapUsedSize) lines.push(`JS Heap Used: ${formatBytes(metrics.JSHeapUsedSize)}`)
  if (metrics.JSHeapTotalSize) lines.push(`JS Heap Total: ${formatBytes(metrics.JSHeapTotalSize)}`)
  if (metrics.Nodes) lines.push(`DOM Nodes: ${metrics.Nodes}`)
  if (metrics.Documents) lines.push(`Documents: ${metrics.Documents}`)
  if (metrics.LayoutCount) lines.push(`Layout Count: ${metrics.LayoutCount}`)
  if (metrics.LayoutDuration) lines.push(`Layout Duration: ${(metrics.LayoutDuration * 1000).toFixed(2)}ms`)
  if (metrics.RecalcStyleCount) lines.push(`Recalc Style Count: ${metrics.RecalcStyleCount}`)
  if (metrics.ScriptDuration) lines.push(`Script Duration: ${(metrics.ScriptDuration * 1000).toFixed(2)}ms`)
  if (metrics.TaskDuration) lines.push(`Task Duration: ${(metrics.TaskDuration * 1000).toFixed(2)}ms`)

  lines.push('')
  lines.push('## Available Insight Sets')
  lines.push('Use browser_perf_insight with these insight sets:')
  lines.push('- insightSetId: "main", available insights: DocumentLatency, LCPBreakdown, RenderBlocking')

  return lines.join('\n')
}

const browser_perf_start = tool(
  'browser_perf_start',
  'Starts a performance trace recording on the selected page. This can be used to look for performance problems and insights to improve the performance of the page. It will also report Core Web Vital (CWV) scores for the page.',
  {
    reload: z.boolean().describe('Determines if, once tracing has started, the page should be automatically reloaded.'),
    autoStop: z.boolean().describe('Determines if the trace recording should be automatically stopped.')
  },
  async (args) => {
    const viewId = ctx.getActiveViewId()
    if (!viewId) {
      return textResult('No active browser page.', true)
    }

    if (ctx.isPerformanceTracing()) {
      return textResult(
        'Error: a performance trace is already running. Use browser_perf_stop to stop it. Only one trace can be running at any given time.',
        true
      )
    }

    try {
      if (args.reload) {
        const currentUrl = ctx.getPageUrl()
        await browserViewManager.navigate(viewId, 'about:blank')
        await new Promise(resolve => setTimeout(resolve, 500))

        await ctx.startPerformanceTrace()

        await browserViewManager.navigate(viewId, currentUrl)
        await ctx.waitForNavigation(NAV_TIMEOUT)
      } else {
        await ctx.startPerformanceTrace()
      }

      if (args.autoStop) {
        await new Promise(resolve => setTimeout(resolve, 5000))

        const { duration, metrics } = await ctx.stopPerformanceTrace()
        return textResult(formatTraceResults(duration, metrics))
      }

      return textResult('The performance trace is being recorded. Use browser_perf_stop to stop it.')
    } catch (error) {
      return textResult(`Failed to start trace: ${(error as Error).message}`, true)
    }
  }
)

const browser_perf_stop = tool(
  'browser_perf_stop',
  'Stops the active performance trace recording on the selected page.',
  {},
  async () => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    if (!ctx.isPerformanceTracing()) {
      return textResult('No performance trace is running.')
    }

    try {
      const { duration, metrics } = await ctx.stopPerformanceTrace()
      return textResult(formatTraceResults(duration, metrics))
    } catch (error) {
      return textResult(`Failed to stop trace: ${(error as Error).message}`, true)
    }
  }
)

const browser_perf_insight = tool(
  'browser_perf_insight',
  'Provides more detailed information on a specific Performance Insight of an insight set that was highlighted in the results of a trace recording.',
  {
    insightSetId: z.string().describe('The id for the specific insight set. Only use the ids given in the "Available insight sets" list.'),
    insightName: z.string().describe('The name of the Insight you want more information on. For example: "DocumentLatency" or "LCPBreakdown"')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    try {
      const metrics = await ctx.getPerformanceMetrics()

      const lines: string[] = [
        `# Performance Insight: ${args.insightName}`,
        `Insight Set: ${args.insightSetId}`,
        ''
      ]

      switch (args.insightName.toLowerCase()) {
        case 'documentlatency':
          lines.push('## Document Latency Analysis')
          lines.push(`Task Duration: ${(metrics.TaskDuration * 1000).toFixed(2)}ms`)
          lines.push(`Script Duration: ${(metrics.ScriptDuration * 1000).toFixed(2)}ms`)
          if (metrics.TaskDuration > 0.05) {
            lines.push('')
            lines.push('Long tasks detected. Consider:')
            lines.push('- Breaking up long-running JavaScript')
            lines.push('- Using requestIdleCallback for non-urgent work')
            lines.push('- Web Workers for heavy computation')
          }
          break

        case 'lcpbreakdown':
          lines.push('## LCP (Largest Contentful Paint) Breakdown')
          lines.push(`Layout Count: ${metrics.LayoutCount}`)
          lines.push(`Layout Duration: ${(metrics.LayoutDuration * 1000).toFixed(2)}ms`)
          lines.push(`Recalc Style Count: ${metrics.RecalcStyleCount}`)
          lines.push('')
          lines.push('Recommendations:')
          lines.push('- Optimize critical rendering path')
          lines.push('- Preload LCP resources')
          lines.push('- Reduce render-blocking resources')
          break

        case 'renderblocking':
          lines.push('## Render Blocking Resources')
          lines.push(`Documents: ${metrics.Documents}`)
          lines.push(`Frames: ${metrics.Frames}`)
          lines.push('')
          lines.push('Recommendations:')
          lines.push('- Use async/defer for scripts')
          lines.push('- Inline critical CSS')
          lines.push('- Preconnect to required origins')
          break

        default:
          lines.push('## General Performance Metrics')
          lines.push(`JS Heap Used: ${formatBytes(metrics.JSHeapUsedSize)}`)
          lines.push(`JS Heap Total: ${formatBytes(metrics.JSHeapTotalSize)}`)
          lines.push(`DOM Nodes: ${metrics.Nodes}`)
          lines.push(`Layout Count: ${metrics.LayoutCount}`)
          lines.push(`Script Duration: ${(metrics.ScriptDuration * 1000).toFixed(2)}ms`)
      }

      return textResult(lines.join('\n'))
    } catch (error) {
      return textResult(`Failed to analyze insight: ${(error as Error).message}`, true)
    }
  }
)

// ============================================
// Export SDK MCP Server
// ============================================

/**
 * All AI Browser tools as SDK MCP tools (26 tools)
 */
const allSdkTools = [
  // Navigation (8)
  browser_list_pages,
  browser_select_page,
  browser_new_page,
  browser_close_page,
  browser_navigate,
  browser_wait_for,
  browser_resize,
  browser_handle_dialog,
  // Input (7)
  browser_click,
  browser_hover,
  browser_fill,
  browser_fill_form,
  browser_drag,
  browser_press_key,
  browser_upload_file,
  // Snapshot (3)
  browser_snapshot,
  browser_screenshot,
  browser_evaluate,
  // Network (2)
  browser_network_requests,
  browser_network_request,
  // Console (2)
  browser_console,
  browser_console_message,
  // Emulation (1)
  browser_emulate,
  // Performance (3)
  browser_perf_start,
  browser_perf_stop,
  browser_perf_insight
]

// Return the tool list
return allSdkTools

} // end buildAllTools

/**
 * Create AI Browser SDK MCP Server.
 *
 * @param scopedContext - Optional scoped BrowserContext for isolation.
 *   When provided, all tools operate on this context's activeViewId
 *   instead of the global singleton. Use for automation runs.
 *   When omitted, uses the global singleton (interactive user use).
 */
export function createAIBrowserMcpServer(scopedContext?: BrowserContext) {
  const ctx = scopedContext ?? browserContext
  const tools = buildAllTools(ctx)
  return createSdkMcpServer({
    name: 'ai-browser',
    version: '1.0.0',
    tools
  })
}

/**
 * Get all AI Browser tool names
 */
export function getAIBrowserSdkToolNames(): string[] {
  // Build tools with default context just to extract names
  return buildAllTools(browserContext).map(t => t.name)
}
