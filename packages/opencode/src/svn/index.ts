import { AppProcess } from "@opencode-ai/core/process"
import { Effect, Layer, Context, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"

export class SvnError extends Schema.TaggedErrorClass<SvnError>()("SvnError", {
  message: Schema.String,
  code: Schema.String,
}) {}

export class SvnNotInstalledError extends Schema.TaggedErrorClass<SvnNotInstalledError>()("SvnNotInstalledError", {
  message: Schema.String,
}) {}

export class SvnWorkingCopyError extends Schema.TaggedErrorClass<SvnWorkingCopyError>()("SvnWorkingCopyError", {
  message: Schema.String,
  path: Schema.String,
}) {}

const out = (result: { text(): string }) => result.text().trim()

export type Kind = "added" | "deleted" | "modified"

export type Base = {
  readonly name: string
  readonly ref: string
}

export type Item = {
  readonly file: string
  readonly code: string
  readonly status: Kind
}

export type Stat = {
  readonly file: string
  readonly additions: number
  readonly deletions: number
}

export type Patch = {
  readonly text: string
  readonly truncated: boolean
}

export interface PatchOptions {
  readonly context?: number
  readonly maxOutputBytes?: number
}

export interface Result {
  readonly exitCode: number
  readonly text: () => string
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly truncated: boolean
}

export interface Options {
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly maxOutputBytes?: number
  readonly stdin?: ChildProcess.CommandInput
}

export interface Info {
  readonly url?: string
  readonly revision?: string
  readonly lastCommitRevision?: string
  readonly lastCommitAuthor?: string
  readonly lastCommitDate?: string
}

const kind = (code: string): Kind => {
  if (code === "A") return "added"
  if (code === "D") return "deleted"
  if (code === "M") return "modified"
  if (code === "?") return "added"
  if (code === "!") return "deleted"
  if (code === "~") return "modified"
  if (code === "R") return "modified"
  if (code === "C") return "modified"
  return "modified"
}

export class Service extends Context.Service<Service>()("@opencode/Svn") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service

    const run = Effect.fn("Svn.run")(function* (args: string[], opts: Options) {
      const result = yield* appProcess.run(
        ChildProcess.make("svn", args, {
          cwd: opts.cwd,
          env: opts.env,
          extendEnv: true,
          stdin: opts.stdin ?? "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
        { maxOutputBytes: opts.maxOutputBytes },
      )
      return {
        exitCode: result.exitCode,
        text: () => result.stdout.toString("utf8"),
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.stdoutTruncated || result.stderrTruncated,
      } satisfies Result
    })

    const info = Effect.fn("Svn.info")(function* (cwd: string) {
      const result = yield* run(["info", "--xml"], { cwd })
      if (result.exitCode !== 0) {
        return {} satisfies Info
      }
      const xml = result.text()
      const urlMatch = /<url>(.*?)<\/url>/.exec(xml)
      const revMatch = /<entry.*?revision="(.*?)"/.exec(xml)
      const commitAuthorMatch = /<author>(.*?)<\/author>/.exec(xml)
      const commitDateMatch = /<date>(.*?)<\/date>/.exec(xml)
      return {
        url: urlMatch?.[1],
        revision: revMatch?.[1],
        lastCommitRevision: revMatch?.[1],
        lastCommitAuthor: commitAuthorMatch?.[1],
        lastCommitDate: commitDateMatch?.[1],
      } satisfies Info
    })

    const status = Effect.fn("Svn.status")(function* (cwd: string) {
      const result = yield* run(["status", "--xml", "--ignore-externals"], { cwd })
      if (result.exitCode !== 0) return []
      const xml = result.text()
      const items: Item[] = []
      const itemRegex = /<item\s+path="(.*?)"\s+props=".*?"\s+kind=".*?"\/?>/g
      const wcStatusRegex = /<wc-status\s+item="(.*?)".*?>/g
      const statusCodeRegex = /<status\s+content="(.*?)"/g
      let match
      while ((match = itemRegex.exec(xml)) !== null) {
        const file = match[1]
        const statusMatch = /<wc-status\s+item="[^"]*"\s+props="[^"]*"\s*(?:revision="[^"]*"\s*)?(?:cached="[^"]*"\s*)?(?:copy-from-rev="[^"]*"\s*)?(?:copy-from-url="[^"]*"\s*)?(?:repos-copy-type="[^"]*"\s*)?(?:tree-conflicted="[^"]*"\s*)?>(.*?)<\/wc-status>/s.exec(
          xml.substring(match.index),
        )
        let code = "M"
        if (statusMatch) {
          const statusContent = /<status>(.*?)<\/status>/s.exec(statusMatch[0])
          if (statusContent) {
            code = statusContent[1]
          }
        }
        items.push({ file, code, status: kind(code) })
      }
      return items
    })

    const diff = Effect.fn("Svn.diff")(function* (cwd: string, ref?: string) {
      const args = ref ? ["diff", "-c", ref] : ["diff"]
      const result = yield* run([...args, "--xml"], { cwd })
      if (result.exitCode !== 0) return []
      const xml = result.text()
      const items: Item[] = []
      const pathMatches = xml.matchAll(/<path\s+kind="[^"]*">(.*?)<\/path>/g)
      const statusMatches = xml.matchAll(/<status\s+(?:item="[^"]*"\s+)?props="[^"]*">\s*<[^>]+>(.*?)<\/[^>]+>\s*<\/status>/g)
      let pathMatch = pathMatches.next()
      let statusMatch = statusMatches.next()
      while (!pathMatch.done && !statusMatch.done) {
        const file = pathMatch.value?.[1] ?? ""
        const statusCode = statusMatch.value?.[1] ?? "M"
        if (file) {
          items.push({ file, code: statusCode, status: kind(statusCode) })
        }
        pathMatch = pathMatches.next()
        statusMatch = statusMatches.next()
      }
      return items
    })

    const log = Effect.fn("Svn.log")(function* (cwd: string, limit?: number) {
      const args = ["log", "--xml", "--limit", String(limit ?? 10)]
      const result = yield* run(args, { cwd })
      if (result.exitCode !== 0) return []
      const xml = result.text()
      const entries: Array<{ revision: string; author?: string; date?: string; message?: string }> = []
      const logEntryRegex = /<logentry\s+revision="(\d+)">([\s\S]*?)<\/logentry>/g
      let match
      while ((match = logEntryRegex.exec(xml)) !== null) {
        const revision = match[1]
        const body = match[2]
        const authorMatch = /<author>(.*?)<\/author>/.exec(body)
        const dateMatch = /<date>(.*?)<\/date>/.exec(body)
        const msgMatch = /<msg>([\s\S]*?)<\/msg>/.exec(body)
        entries.push({
          revision,
          author: authorMatch?.[1],
          date: dateMatch?.[1],
          message: msgMatch?.[1]?.trim(),
        })
      }
      return entries
    })

    const patch = Effect.fn("Svn.patch")(function* (cwd: string, file: string, options?: PatchOptions) {
      const result = yield* run(
        ["diff", "--xml", "--force", "--", file],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.truncated ? "" : result.text(), truncated: result.truncated } satisfies Patch
    })

    const patchAll = Effect.fn("Svn.patchAll")(function* (cwd: string, options?: PatchOptions) {
      const result = yield* run(["diff", "--xml", "--force", "--", "."], {
        cwd,
        maxOutputBytes: options?.maxOutputBytes,
      })
      return { text: result.text(), truncated: result.truncated } satisfies Patch
    })

    const applyPatch = Effect.fn("Svn.applyPatch")(function* (cwd: string, patch: string) {
      return yield* run(["patch", "--strip", "1"], { cwd, stdin: patch })
    })

    const commit = Effect.fn("Svn.commit")(function* (cwd: string, message: string) {
      const result = yield* run(["commit", "-m", message], { cwd })
      return result
    })

    const update = Effect.fn("Svn.update")(function* (cwd: string, revision?: string) {
      const args = revision ? ["update", "-r", revision] : ["update"]
      const result = yield* run(args, { cwd })
      return result
    })

    return Service.of({
      run,
      info,
      status,
      diff,
      log,
      patch,
      patchAll,
      applyPatch,
      commit,
      update,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppProcess.defaultLayer))

export * as Svn from "."