/**
 * git-ai plugin for OpenCode
 *
 * This plugin integrates git-ai with OpenCode to track AI-generated code.
 * It uses the tool.execute.before and tool.execute.after events to create
 * checkpoints that mark code changes as human or AI-authored.
 *
 * Installation:
 *   - Automatically installed by `git-ai install-hooks`
 *   - Or manually copy to ~/.config/opencode/plugins/git-ai.ts (global)
 *   - Or to .opencode/plugins/git-ai.ts (project-local)
 *
 * Requirements:
 *   - git-ai must be installed (path is injected at install time)
 *
 * @see https://github.com/git-ai-project/git-ai
 * @see https://opencode.ai/docs/plugins/
 */

import type { Plugin } from "@opencode-ai/plugin"
import { spawn } from "child_process"
import { dirname, isAbsolute, join } from "path"

// Absolute path to git-ai binary, replaced at install time by `git-ai install-hooks`
const GIT_AI_BIN = "__GIT_AI_BINARY_PATH__"

// Tools that modify files and should be tracked
const FILE_EDIT_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "multiedit",
  "apply_patch",
  "applypatch",
])

const APPLY_PATCH_FILE_PREFIXES = [
  "*** Update File: ",
  "*** Add File: ",
  "*** Delete File: ",
  "*** Move to: ",
]

const isEditTool = (toolName: string): boolean => FILE_EDIT_TOOLS.has(toolName.toLowerCase())

const isBashTool = (toolName: string): boolean => {
  const name = toolName.toLowerCase()
  return name === "bash" || name === "shell"
}

const normalizePath = (rawPath: string, cwd?: string): string | null => {
  const trimmed = rawPath.trim().replace(/^['"]|['"]$/g, "")
  if (!trimmed) {
    return null
  }

  const withoutScheme = trimmed
    .replace(/^file:\/\/localhost/, "")
    .replace(/^file:\/\//, "")

  const isWindowsAbs = /^[a-zA-Z]:[\\/]/.test(withoutScheme)
  if (isAbsolute(withoutScheme) || isWindowsAbs) {
    return withoutScheme
  }

  // Use provided cwd, or fall back to process.cwd() for relative paths
  const resolvedCwd = cwd || process.cwd()
  return join(resolvedCwd, withoutScheme)
}

const collectApplyPatchPaths = (raw: string, out: Set<string>): void => {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    for (const prefix of APPLY_PATCH_FILE_PREFIXES) {
      if (trimmed.startsWith(prefix)) {
        const path = trimmed.slice(prefix.length).trim().replace(/^['"]|['"]$/g, "")
        if (path) {
          out.add(path)
        }
      }
    }
  }
}

const collectToolPaths = (value: unknown, out: Set<string>): void => {
  if (typeof value === "string") {
    if (value.startsWith("file://")) {
      out.add(value)
    }
    collectApplyPatchPaths(value, out)
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolPaths(item, out)
    }
    return
  }

  if (!value || typeof value !== "object") {
    return
  }

  for (const [key, val] of Object.entries(value)) {
    const keyLower = key.toLowerCase()
    const isSinglePathKey = keyLower === "file_path" || keyLower === "filepath" || keyLower === "path" || keyLower === "fspath"
    const isMultiPathKey = keyLower === "files" || keyLower === "filepaths" || keyLower === "file_paths"

    if (isSinglePathKey && typeof val === "string") {
      out.add(val)
    } else if (isMultiPathKey) {
      if (typeof val === "string") {
        out.add(val)
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string") {
            out.add(item)
          }
        }
      }
    }

    collectToolPaths(val, out)
  }
}

const extractFilePaths = (args: unknown, cwd?: string): string[] => {
  const rawPaths = new Set<string>()
  collectToolPaths(args, rawPaths)

  const normalizedPaths = new Set<string>()
  for (const rawPath of rawPaths) {
    const normalized = normalizePath(rawPath, cwd)
    if (normalized) {
      normalizedPaths.add(normalized)
    }
  }

  return [...normalizedPaths]
}

type ToolHookInput = {
  tool?: unknown
  sessionID?: unknown
  callID?: unknown
  args?: unknown
  metadata?: unknown
  cwd?: unknown
  workdir?: unknown
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

const hookString = (value: unknown): string => typeof value === "string" ? value : ""

const debugEnabled = (): boolean => {
  const value = process.env.GIT_AI_OPENCODE_DEBUG ?? process.env.GIT_AI_DEBUG
  return value === "1" || value?.toLowerCase() === "true"
}

const debugLog = (message: string, error?: unknown): void => {
  if (!debugEnabled()) {
    return
  }

  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : error === undefined
      ? ""
      : String(error)
  console.error(`[git-ai opencode] ${message}${detail ? `: ${detail}` : ""}`)
}

const runCommand = (
  command: string,
  args: string[],
  options: { cwd?: string; input?: string } = {},
): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, output?: { stdout: string; stderr: string }): void => {
      if (settled) {
        return
      }

      settled = true
      if (error) {
        reject(error)
      } else if (output) {
        resolve(output)
      }
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.stdin.on("error", () => {
      // The child may exit before stdin is fully written; close/error handling below reports failures.
    })
    child.on("error", finish)
    child.on("close", (code) => {
      const output = {
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      }
      if (code === 0) {
        finish(null, output)
        return
      }

      finish(new Error(`${command} ${args.join(" ")} exited with ${code}: ${output.stderr}`))
    })

    if (options.input !== undefined) {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }
  })
}

export const GitAiPlugin: Plugin = async (ctx) => {
  const { worktree, directory } = ctx
  const defaultCwd = worktree || directory || process.cwd()

  // Track pending calls by callID so we can reference them in the after hook
  const pendingCalls = new Map<string, { repoDir: string; sessionID: string; toolInput: unknown }>()

  // Helper to find git repo root from a file path
  const findGitRepo = async (pathHint: string): Promise<string | null> => {
    const candidateDirs: string[] = []
    let candidate = pathHint
    while (candidate && !candidateDirs.includes(candidate)) {
      candidateDirs.push(candidate)
      const parent = dirname(candidate)
      if (parent === candidate) {
        break
      }
      candidate = parent
    }

    for (const dir of candidateDirs) {
      try {
        const result = await runCommand("git", ["-C", dir, "rev-parse", "--show-toplevel"])
        const repoRoot = result.stdout.trim()
        if (repoRoot) {
          return repoRoot
        }
      } catch (error) {
        debugLog(`git repo lookup failed from ${dir}`, error)
        // try next candidate
      }
    }

    return null
  }

  const resolveCwd = (cwd?: string): string => {
    if (!cwd) {
      return defaultCwd
    }

    return normalizePath(cwd, defaultCwd) || defaultCwd
  }

  const resolveRepoDir = async (filePaths: string[], cwd?: string): Promise<string | null> => {
    for (const filePath of filePaths) {
      const repo = await findGitRepo(filePath)
      if (repo) {
        return repo
      }
    }

    if (cwd) {
      const fromCwd = await findGitRepo(cwd)
      if (fromCwd) {
        return fromCwd
      }
    }

    const fromDefaultCwd = await findGitRepo(defaultCwd)
    if (fromDefaultCwd) {
      return fromDefaultCwd
    }

    const fromProcessCwd = await findGitRepo(process.cwd())
    if (fromProcessCwd) {
      return fromProcessCwd
    }

    return null
  }

  const extractMetadataFilePaths = (metadata: unknown): string[] => {
    if (!metadata || typeof metadata !== "object") {
      return []
    }

    const files = (metadata as { files?: unknown }).files
    if (!Array.isArray(files)) {
      return []
    }

    const paths = new Set<string>()
    for (const file of files) {
      if (!file || typeof file !== "object") {
        continue
      }

      const filePath = (file as { filePath?: unknown; path?: unknown }).filePath ?? (file as { path?: unknown }).path
      if (typeof filePath === "string") {
        const normalized = normalizePath(filePath, defaultCwd)
        if (normalized) {
          paths.add(normalized)
        }
      }
    }

    return [...paths]
  }

  const withMetadataFilePaths = (toolInput: unknown, filePaths: string[]): unknown => {
    if (filePaths.length === 0) {
      return toolInput
    }

    if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
      return {
        ...toolInput,
        file_paths: filePaths,
      }
    }

    return {
      input: toolInput,
      file_paths: filePaths,
    }
  }

  const extractToolCwd = (inputCwd: unknown, args: Record<string, unknown> | undefined): string | undefined => {
    if (typeof args?.workdir === "string") return args.workdir
    if (typeof args?.cwd === "string") return args.cwd
    if (typeof inputCwd === "string") return inputCwd
    return undefined
  }

  return {
    "tool.execute.before": async (input: ToolHookInput, output?: { args?: unknown }) => {
      try {
        const toolName = hookString(input.tool)
        const callID = hookString(input.callID)
        const sessionID = hookString(input.sessionID)
        const toolInput = output?.args ?? input.args
        const toolCwd = resolveCwd(extractToolCwd(input.cwd ?? input.workdir, asRecord(toolInput)))

        if (isEditTool(toolName)) {
          const filePaths = extractFilePaths(toolInput, toolCwd)
          const repoDir = await resolveRepoDir(filePaths, toolCwd)
          if (!repoDir) {
            return
          }

          pendingCalls.set(callID, { repoDir, sessionID, toolInput })

          const hookInput = JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: sessionID,
            tool_use_id: callID,
            cwd: repoDir,
            tool_name: toolName,
            tool_input: toolInput,
          })
          await runCommand(GIT_AI_BIN, ["checkpoint", "opencode", "--hook-input", "stdin"], { input: hookInput })

        } else if (isBashTool(toolName)) {
          const repoDir = await resolveRepoDir([], toolCwd)
          if (!repoDir) {
            return
          }

          pendingCalls.set(callID, { repoDir, sessionID, toolInput })

          const hookInput = JSON.stringify({
            hook_event_name: "PreToolUse",
            session_id: sessionID,
            tool_use_id: callID,
            cwd: repoDir,
            tool_name: toolName,
            tool_input: toolInput,
          })
          await runCommand(GIT_AI_BIN, ["checkpoint", "opencode", "--hook-input", "stdin"], { input: hookInput })
        }
      } catch (error) {
        debugLog("pre-tool checkpoint failed", error)
        // Checkpoint failures are non-critical — never propagate to the host
      }
    },

    "tool.execute.after": async (input: ToolHookInput, output?: { metadata?: unknown }) => {
      try {
        const toolName = hookString(input.tool)
        if (!isEditTool(toolName) && !isBashTool(toolName)) {
          return
        }

        const callID = hookString(input.callID)
        const callInfo = pendingCalls.get(callID)
        pendingCalls.delete(callID)

        const metadataFilePaths = extractMetadataFilePaths(output?.metadata ?? input.metadata)
        const toolInput = callInfo?.toolInput ?? withMetadataFilePaths(input.args, metadataFilePaths)
        const sessionID = callInfo?.sessionID ?? hookString(input.sessionID)
        const toolCwd = resolveCwd(extractToolCwd(input.cwd ?? input.workdir, asRecord(input.args)))
        const repoDir = callInfo?.repoDir ?? await resolveRepoDir(extractFilePaths(toolInput, toolCwd), toolCwd)
        if (!repoDir) {
          return
        }

        const hookInput = JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: sessionID,
          tool_use_id: callID,
          cwd: repoDir,
          tool_name: toolName,
          tool_input: toolInput,
        })
        await runCommand(GIT_AI_BIN, ["checkpoint", "opencode", "--hook-input", "stdin"], { input: hookInput })
      } catch (error) {
        debugLog("post-tool checkpoint failed", error)
        // Checkpoint failures are non-critical — never propagate to the host
      }
    },
  }
}

export default GitAiPlugin
