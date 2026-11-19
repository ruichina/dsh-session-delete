/**
 * Host half of the session-delete bundle: permanently removes stored Sessions.
 *
 * The operation is implemented once, here, and reached by two callers:
 * - the Web GUI's row menu / hover action, over one authenticated exact route
 *   on the shared `/api` channel (`ctx.connection.fetch.register`), and
 * - the `session_delete` agent tool.
 *
 * The `/api` RPC interceptor is single-owner — the API Gateway holds it — so a
 * plugin claims an exact Fetch route beside the Gateway instead.
 *
 * Deletion order is deliberate: the stored log goes first, because it is the
 * irreversible part; only then is the Session removed from the workspace
 * registry, so a refused or failed file removal leaves the sidebar unchanged.
 */
import { readdir, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Exact route owned on the shared `/api` channel. */
const ROUTE_PATH = '/api/session-delete/delete'
/** One Session id as the Host mints it: a path-safe single segment. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** One stored log file of any format generation (`session.v4.jsonl.zstd`, `session.jsonl`, …). */
const SESSION_LOG_FILE_PATTERN = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/
/** Upper bound for one request, so a stray call cannot walk the whole history. */
const MAX_SESSIONS_PER_REQUEST = 50

/** Stable failure reasons the Client localizes. */
const REASON_BUSY = 'busy'
const REASON_LOCKED = 'locked'
const REASON_NOT_FOUND = 'not-found'

/**
 * Register the Host half.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  const deleteSessions = createSessionDeleter(ctx)

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => {
      const dispose = connectionCtx.connection.fetch.register({
        path: ROUTE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let payload
          try {
            payload = await request.json()
          } catch {
            return jsonResponse({ ok: false, error: 'request body is not JSON' }, 400)
          }
          let sessionIds
          try {
            sessionIds = readSessionIds(payload)
          } catch (error) {
            return jsonResponse({ ok: false, error: messageOf(error) }, 400)
          }
          try {
            const value = await deleteSessions(sessionIds, request.signal)
            return jsonResponse({ ok: true, ...value }, 200)
          } catch (error) {
            return jsonResponse({ ok: false, error: messageOf(error) }, 500)
          }
        },
      })
      return () => { void dispose() }
    }, 'session-delete: /api route')
  })

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(
      () => toolCtx.tools.register(createDeleteTool(deleteSessions)),
      'session-delete: session_delete tool',
    )
  })
}

/**
 * @param value - JSON body to send.
 * @param status - HTTP status.
 * @returns the Fetch response.
 */
function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Build the one deletion operation both callers share.
 * @param ctx - Host plugin context owning the services the operation reads.
 * @returns the operation: one result entry per requested Session.
 */
function createSessionDeleter(ctx) {
  return async function deleteSessions(sessionIds, signal) {
    const deleted = []
    const failed = []
    for (const sessionId of sessionIds) {
      signal?.throwIfAborted()
      try {
        const refusal = await deleteOne(ctx, sessionId, signal)
        if (refusal === null) deleted.push(sessionId)
        else failed.push({ sessionId, reason: refusal })
      } catch (error) {
        failed.push({ sessionId, reason: messageOf(error) })
      }
    }
    return { deleted, failed }
  }
}

/**
 * Delete one stored Session and its trace in the workspace registry.
 * @param ctx - Host plugin context.
 * @param sessionId - the Session to remove.
 * @param signal - caller cancellation.
 * @returns a failure reason, or null when the Session is gone.
 */
async function deleteOne(ctx, sessionId, signal) {
  // "In use" means running work, not a live Agent: an Agent stays registered
  // for as long as its owner keeps the Session open, including Sessions the
  // user merely looked at earlier. The same waterfall the archive path uses
  // reports a real running turn, subagent, job, or schedule.
  const activity = await runningActivity(ctx, sessionId)
  if (activity.length > 0) return REASON_BUSY

  const registry = ctx.get('workspaceRegistry')
  // Gate a live but idle Agent before removing its log: an archived Session
  // cannot start another model step, so nothing appends to a removed file.
  let archived = false
  if (registry !== undefined) {
    try {
      await registry.archiveSession(sessionId)
      archived = true
    } catch {
      // Best effort — an already-archived or unregistered Session just skips it.
    }
  }

  const persistence = ctx.get('sessionPersistence')
  const snapshot = persistence === undefined ? undefined : await persistence.stat(sessionId, { signal })
  const logPath = snapshot === undefined ? undefined : snapshot.location?.path
  let removedLog = false
  if (typeof logPath === 'string' && logPath.length > 0) {
    try {
      removedLog = await removeLog(logPath, sessionId)
    } catch (error) {
      await restoreArchive(registry, sessionId, archived)
      if (isLockError(error)) return REASON_LOCKED
      throw error
    }
  }

  // Removes the archive flag this call set, plus any pin and workspace account.
  const registryResult = await detachFromRegistry(ctx, sessionId)
  if (typeof registryResult === 'string') return registryResult
  if (!removedLog && registryResult !== true) {
    await restoreArchive(registry, sessionId, archived)
    return REASON_NOT_FOUND
  }
  return null
}

/**
 * Drop a temporary archive flag after a failed removal.
 * @param registry - the workspace registry, when present.
 * @param sessionId - the Session to restore.
 * @param archived - whether this call archived it.
 */
async function restoreArchive(registry, sessionId, archived) {
  if (!archived || registry === undefined) return
  try {
    await registry.unarchiveSession(sessionId)
  } catch {
    // Restoring visibility is best effort; the failure is already reported.
  }
}

/**
 * @param error - a filesystem failure.
 * @returns whether the target is still held by another handle.
 */
function isLockError(error) {
  return error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'EACCES'
}

/**
 * Ask the composed providers what still runs for one Session.
 * @param ctx - Host plugin context.
 * @param sessionId - the Session about to be removed.
 * @returns the reported activity families; empty when nothing runs or no provider answers.
 */
async function runningActivity(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') return []
  try {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, async () => [])
    return Array.isArray(activity) ? activity : []
  } catch {
    // The guard must never be the reason a requested deletion fails; the live
    // Agent check above already covers the common case.
    return []
  }
}

/**
 * Remove one Session's stored log (every format generation beside it), its
 * projection-cache record, and its now-empty Session directory.
 * @param logPath - absolute path of the stored Session log selected for the Session.
 * @param sessionId - the Session the log belongs to.
 * @returns true when a log file was removed.
 */
async function removeLog(logPath, sessionId) {
  const directory = dirname(logPath)
  const directoryName = basename(directory)
  let removed = false

  if (directoryName === sessionId || directoryName === `session-${sessionId}`) {
    // The Session owns this directory outright: a later format generation
    // beside the selected file would otherwise resurrect the Session.
    try {
      await rm(directory, { recursive: true })
      removed = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw fsFailure('cannot remove', directory, error)
    }
  } else {
    let entries = []
    try {
      entries = await readdir(directory)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw fsFailure('cannot read', directory, error)
    }
    for (const entry of entries) {
      if (!SESSION_LOG_FILE_PATTERN.test(entry)) continue
      const target = join(directory, entry)
      try {
        await rm(target)
        removed = true
      } catch (error) {
        if (error?.code !== 'ENOENT') throw fsFailure('cannot remove', target, error)
      }
    }
    try {
      await rmdir(directory)
    } catch {
      // A directory still holding a lock file or other entries stays.
    }
  }

  const cachePath = projectionCachePath(logPath, sessionId)
  if (cachePath !== undefined) {
    try {
      await rm(cachePath, { force: true })
    } catch {
      // The cache is a derived read model; leaving it behind never blocks.
    }
  }
  return removed
}

/**
 * Locate the persisted projection-cache record that belongs to one log.
 * @param logPath - absolute Session log path inside the data home.
 * @param sessionId - the Session the log belongs to.
 * @returns the cache record path, or undefined when the data home is unknown.
 */
function projectionCachePath(logPath, sessionId) {
  let directory = dirname(logPath)
  for (let depth = 0; depth < 6; depth += 1) {
    if (basename(directory) === 'sessions') {
      return join(dirname(directory), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const home = process.env.DSH_HOME
  if (home === undefined || home.length === 0) return undefined
  return join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
}

/**
 * Remove a Session from every workspace account, the archive set, and the pin set.
 * @param ctx - Host plugin context.
 * @param sessionId - the Session to remove.
 * @returns true when an account changed, false when nothing referenced it, or a failure reason.
 */
async function detachFromRegistry(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return false
  try {
    await registry.unarchiveSession(sessionId)
    await registry.unpinSession(sessionId)
  } catch (error) {
    return `workspace cleanup failed: ${messageOf(error)}`
  }
  let changed = false
  for (const workspace of registry.list()) {
    const accounts = workspace.sessionIds ?? []
    if (!accounts.includes(sessionId)) continue
    try {
      await workspace.detachSession(sessionId)
      changed = true
    } catch (error) {
      return `workspace cleanup failed: ${messageOf(error)}`
    }
  }
  return changed
}

/**
 * @param deleteSessions - the shared deletion operation.
 * @returns the `session_delete` tool definition.
 */
function createDeleteTool(deleteSessions) {
  return {
    name: 'session_delete',
    description: 'Permanently delete stored sessions and their chat logs from this computer. A session that is running work (a reply, a subagent, a job, or a schedule) is not deleted; stop or archive it first.',
    parameters: {
      type: 'object',
      properties: {
        sessionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Session ids to delete.',
        },
      },
      required: ['sessionIds'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          deleted: { type: 'array', items: { type: 'string' } },
          failed: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sessionId: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['sessionId', 'reason'],
              additionalProperties: false,
            },
          },
        },
        required: ['deleted', 'failed'],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = [`Deleted ${value.deleted.length} session(s).`]
        if (value.failed.length > 0) {
          const details = value.failed.map(entry => `${entry.sessionId} (${entry.reason})`).join(', ')
          lines.push(`Not deleted ${value.failed.length}: ${details}`)
        }
        return [{ type: 'text', text: lines.join(' ') }]
      },
    },
    async execute(args, exec) {
      return deleteSessions(readSessionIds(args), exec.signal)
    },
  }
}

/**
 * Validate the wire payload before any filesystem work.
 * @param payload - untrusted request payload.
 * @returns distinct, validated Session ids.
 */
function readSessionIds(payload) {
  const input = payload !== null && typeof payload === 'object' ? payload : {}
  const raw = Array.isArray(input.sessionIds)
    ? input.sessionIds
    : typeof input.sessionId === 'string' ? [input.sessionId] : []
  if (raw.length === 0) throw new Error('sessionIds must contain at least one session id')
  if (raw.length > MAX_SESSIONS_PER_REQUEST) {
    throw new Error(`at most ${String(MAX_SESSIONS_PER_REQUEST)} sessions can be deleted in one request`)
  }
  const sessionIds = []
  for (const value of raw) {
    if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
      throw new Error(`invalid session id: ${String(value)}`)
    }
    if (!sessionIds.includes(value)) sessionIds.push(value)
  }
  return sessionIds
}

/**
 * Wrap a filesystem failure so its errno survives for the caller's classification.
 * @param action - what failed, for the message.
 * @param target - the path involved.
 * @param error - the underlying failure.
 * @returns the wrapped error.
 */
function fsFailure(action, target, error) {
  const wrapped = new Error(`${action} ${target}: ${messageOf(error)}`)
  wrapped.code = error?.code
  return wrapped
}

/**
 * @param error - any thrown value.
 * @returns its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
