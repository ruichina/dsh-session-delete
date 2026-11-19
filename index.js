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
 *
 * A Session that the Host once resumed stays live in this process until it
 * exits, and the Session list the Client pulls always includes live Sessions —
 * even after their stored log is gone. A plugin cannot dispose another owner's
 * live Session, so a fresh baseline would list the residue again with no
 * Workspace account, and the sidebar would show it in its "Ungrouped" bucket.
 * A deletion therefore waits out the last Client reference through the public
 * `sessions.retainInfo` observation (a retained Session keeps being listed),
 * then disposes the Host Agent — which detaches the Session, removes it from
 * every list, and persists its buffered events; only then does the removal
 * touch the files. If the wait fails or times out, the id stays in the
 * registry-global archive set as a tombstone that hides the residue, and
 * `pruneTombstones` drops the tombstone at the next Host start.
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
/** How long one deletion waits for the last Client reference to leave. */
const RELEASE_WAIT_MS = 15_000

/** Stable failure reasons the Client localizes. */
const REASON_BUSY = 'busy'
const REASON_LOCKED = 'locked'
const REASON_NOT_FOUND = 'not-found'
const REASON_RETAINED = 'retained'

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

  ctx.inject(['workspaceRegistry', 'sessionPersistence'], (cleanupCtx) => {
    cleanupCtx.effect(() => {
      void pruneTombstones(cleanupCtx)
      return () => {}
    }, 'session-delete: tombstone cleanup')
  })
}

/**
 * Drop archive tombstones this process no longer needs.
 *
 * A deletion leaves its id archived so the live residue stays hidden. The
 * archive set is durable, so without cleanup the ids outlive the residue. Only
 * an id that no Workspace owns, that no Agent holds live, and that has no
 * stored log can be a tombstone — anything else is a Session the user archived
 * on purpose, which stays accounted by its Workspace and keeps its log.
 * @param ctx - Host plugin context carrying the registry and persistence.
 */
async function pruneTombstones(ctx) {
  const registry = ctx.get('workspaceRegistry')
  const persistence = ctx.get('sessionPersistence')
  if (registry === undefined || persistence === undefined) return
  let archived
  try {
    archived = [...registry.archivedSessionIds]
  } catch {
    return
  }
  if (archived.length === 0) return
  const accounted = new Set()
  try {
    for (const workspace of registry.list()) {
      for (const sessionId of workspace.sessionIds ?? []) accounted.add(sessionId)
    }
  } catch {
    return
  }
  const sessions = ctx.get('sessions')
  for (const sessionId of archived) {
    if (accounted.has(sessionId) || sessions?.get?.(sessionId) !== undefined) continue
    let snapshot
    try {
      snapshot = await persistence.stat(sessionId, {})
    } catch {
      continue
    }
    if (snapshot !== undefined) continue
    try {
      await registry.unarchiveSession(sessionId)
    } catch {
      // Best effort — an unchanged tombstone stays hidden and is retried next start.
    }
  }
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

  // A Client reference keeps even a log-less live Session in the Host's list,
  // so the residue would be re-listed after the files are gone. Wait out the
  // last reference through the public observation, then dispose the Host Agent
  // — that detaches the Session and flushes its buffered events before removal.
  const released = await releaseClientReferences(ctx, sessionId, signal)
  let disposedAgent = false
  if (released) {
    disposedAgent = await disposeHostAgent(ctx, sessionId)
  } else {
    // The wait timed out or broke: hide the residue with an archive tombstone
    // instead of deleting underneath a Client still using the Session.
    const registry = ctx.get('workspaceRegistry')
    await leaveTombstone(registry, sessionId, true)
    return REASON_RETAINED
  }

  const registry = ctx.get('workspaceRegistry')
  // Gate a live but idle Agent before removing its log: an archived Session
  // cannot start another model step, so nothing appends to a removed file. An
  // Agent this call already disposed needs no gate.
  let archived = false
  if (!disposedAgent && registry !== undefined) {
    try {
      await registry.archiveSession(sessionId)
      archived = true
    } catch {
      // Best effort — an already-archived or unregistered Session just skips it.
    }
  }

  // A live Session may still hold its log in memory: `stat` then reports no
  // physical location, so the removal would silently do nothing and the row
  // would come back as "Ungrouped" once the log materialized. Flush first.
  const sessions = ctx.get('sessions')
  const liveSession = sessions === undefined ? undefined : sessions.get?.(sessionId)
  if (liveSession !== undefined && typeof sessions.flush === 'function') {
    try {
      await sessions.flush(liveSession)
    } catch {
      // Best effort — a Session that cannot flush is reported by removeLog.
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

  // The log is gone, so the Session can never come back; its account, pin,
  // and any earlier archive flag are only residue now.
  const registryResult = await detachFromRegistry(ctx, sessionId)
  if (typeof registryResult === 'string') return registryResult

  // A Session that stayed live despite the release — or a disposal that left
  // it attached — would be re-listed with no Workspace account; leave the
  // archive tombstone so no grouping surface shows it as "Ungrouped".
  const stillLive = liveSession !== undefined || sessions?.get?.(sessionId) !== undefined
  await leaveTombstone(registry, sessionId, stillLive)

  return !removedLog && registryResult !== true ? REASON_NOT_FOUND : null
}

/**
 * Wait until no Client page retains one Session.
 *
 * `sessions.retainInfo` counts references per consumer source; a retained
 * Session is listed by `session.list` even without a stored log. The returned
 * source has stable identity, so subscribing once is safe across generations.
 * @param ctx - Host plugin context.
 * @param sessionId - the Session about to be removed.
 * @param signal - caller cancellation.
 * @returns whether the count reached zero (or was already zero).
 */
async function releaseClientReferences(ctx, sessionId, signal) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || typeof sessions.retainInfo !== 'function') return true
  let info
  try {
    info = sessions.retainInfo(sessionId)
  } catch {
    return true
  }
  if (info === undefined || typeof info.subscribe !== 'function') return true
  const read = () => {
    try {
      return info.getSnapshot?.().referenceCount ?? 0
    } catch {
      return 0
    }
  }
  if (read() === 0) return true
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe = () => {}
    const finish = (value) => {
      if (settled) return
      settled = true
      unsubscribe()
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => { finish(false) }
    const timer = setTimeout(() => { finish(false) }, RELEASE_WAIT_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      unsubscribe = info.subscribe(() => { if (read() === 0) finish(true) }) ?? (() => {})
    } catch {
      finish(false)
      return
    }
    if (read() === 0) finish(true)
  })
}

/**
 * Dispose the Host Agent owning one Session, when this process runs one.
 *
 * The agent-loop teardown stops the loop, drains buffered events into durable
 * storage, closes the writer, and detaches the Session from the store — so the
 * removed log is final and the Session leaves every list.
 * @param ctx - Host plugin context.
 * @param sessionId - the Session whose Agent may run here.
 * @returns whether an Agent lived here and was torn down.
 */
async function disposeHostAgent(ctx, sessionId) {
  const agents = ctx.get('agents')
  const agent = agents?.get?.(sessionId)
  if (agent === undefined) return false
  const handle = agents?.handlesOf?.(agent)
  if (handle === undefined || typeof handle.dispose !== 'function') return false
  try {
    await handle.dispose()
  } catch {
    // Teardown failures are collected by the handle; the removal proceeds and
    // reports what the filesystem says.
  }
  return true
}

/**
 * Re-archive a still-live Session after its log is gone. The archive set hides
 * the residue from every grouping surface until the Host restarts and drops it.
 * @param registry - the workspace registry, when present.
 * @param sessionId - the Session whose log was removed.
 * @param stillLive - whether the Host still holds the Session live.
 */
async function leaveTombstone(registry, sessionId, stillLive) {
  if (!stillLive || registry === undefined) return
  try {
    if (!registry.archivedSessionIds.includes(sessionId)) {
      await registry.archiveSession(sessionId)
    }
  } catch {
    // A missing tombstone only risks the residue row; never fail the deletion.
  }
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
 * Remove a Session from every workspace account, its pin, and any archive flag
 * that hid the row before the deletion.
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
