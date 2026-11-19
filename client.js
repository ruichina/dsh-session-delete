/**
 * Client half of the session-delete bundle.
 *
 * Contributes three surfaces to the existing sidebar:
 * - a "Delete session" row in the Session menu (`sidebar.workspaces.session.menu.item`),
 *   which is where a right-click on a Session row lands,
 * - a trash hover action on the row itself (`sidebar.workspaces.session.row.action`),
 * - the confirmation dialog and its success notice (`shell.overlay`).
 *
 * The Host performs the deletion; this module only asks, then shows what the
 * Host reported.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace this bundle registers. */
    const NS = 'sessionDelete'
    /** Exact route owned by the Host half on the shared `/api` channel. */
    const ROUTE_PATH = 'api/session-delete/delete'
    /** Failure reasons the Host returns as stable codes. */
    const REASON_ACTIVE = 'active'
    const REASON_BUSY = 'busy'
    const REASON_NOT_FOUND = 'not-found'
    /** Local marker for "the Host route is not mounted" (HTTP 404). */
    const NOT_READY = 'not-registered'
    /** How long the success notice stays on screen. */
    const NOTICE_MS = 2400
    /**
     * Delay between the success notice and the reload that repaints the
     * sidebar. The reload is what removes a stale row: deleting a Session's log
     * emits no Session event, so the Client's own session-list cache keeps the
     * id and would otherwise show it under "Ungrouped".
     */
    const RELOAD_DELAY_MS = 600
    /** Focusable descendants a Tab cycle walks inside the dialog. */
    const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

    /**
     * The browser module table's `react-dom`, when this page provides it.
     * @returns the module, or undefined.
     */
    function readReactDOM() {
      try {
        return require('react-dom')
      } catch {
        return undefined
      }
    }
    const ReactDOM = readReactDOM()

    const DICT = {
      en: {
        'menu.delete': 'Delete session…',
        'action.delete': 'Delete session',
        'dialog.title': 'Delete this session?',
        'dialog.body': 'The chat log of “{title}” is deleted from this computer. This cannot be undone.',
        'dialog.untitled': 'Untitled session',
        'dialog.cancel': 'Cancel',
        'dialog.confirm': 'Delete',
        'dialog.pending': 'Deleting…',
        'dialog.done': 'Session deleted',
        'dialog.active': 'This session is in use right now. Switch to another session, then delete it.',
        'dialog.busy': 'This session still has running work. Archive it first to stop that work, then delete it.',
        'dialog.notFound': 'This session is already gone — it may have been deleted.',
        'dialog.failed': 'Deletion failed: {message}',
        'dialog.transport': 'Lost the connection to DSH: {message}',
        'dialog.notReady': 'The delete endpoint is not available (HTTP 404). Check that the plugin is enabled, then reload the page.',
      },
      zh: {
        'menu.delete': '删除会话…',
        'action.delete': '删除会话',
        'dialog.title': '要删除这个会话吗？',
        'dialog.body': '“{title}”的聊天记录会从这台电脑上删除，且无法恢复。',
        'dialog.untitled': '未命名会话',
        'dialog.cancel': '取消',
        'dialog.confirm': '删除',
        'dialog.pending': '正在删除…',
        'dialog.done': '会话已删除',
        'dialog.active': '这个会话正在使用中。请先切换到其他会话，再删除它。',
        'dialog.busy': '这个会话还有正在运行的任务。请先归档它（会停止这些任务），再删除。',
        'dialog.notFound': '这个会话已经不在了，可能已被删除。',
        'dialog.failed': '删除失败：{message}',
        'dialog.transport': '与 DSH 的连接中断：{message}',
        'dialog.notReady': '删除接口未就绪（HTTP 404）。请确认插件已启用，并重新加载页面。',
      },
    }

    const CSS = `
.dsd-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.dsd-menu-item:hover,
.dsd-menu-item:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}
.dsd-menu-item > svg {
  flex: none;
  color: var(--dsw-alias-menu-icon, var(--dsw-alias-label-secondary));
}
.dsd-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: -4px;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsd-icon-button:hover {
  color: var(--dsw-alias-label-primary);
}
.dsd-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  pointer-events: auto;
  background: var(--dsw-alias-bg-mask-1);
}
.dsd-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-sizing: border-box;
  width: min(380px, 100%);
  padding: 24px;
  border-radius: var(--dsw-radius-panel, 16px);
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent, none);
  color: var(--dsw-alias-label-primary);
}
.dsd-title {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
}
.dsd-body {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 14px;
  line-height: 22px;
}
.dsd-error {
  margin: 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
}
.dsd-status {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.dsd-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.dsd-button {
  min-width: 64px;
  padding: 6px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.dsd-button:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}
.dsd-button[disabled] {
  opacity: 0.5;
  cursor: default;
  background: transparent;
}
.dsd-button-danger {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.dsd-button-danger:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
}
.dsd-notice {
  position: fixed;
  left: 50%;
  bottom: 32px;
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-prominent, none);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  transform: translateX(-50%);
  pointer-events: none;
}
.dsd-notice > svg {
  flex: none;
  color: var(--dsw-alias-state-success-primary);
}
`

    /** One trash glyph, drawn for row size. */
    function TrashGlyph({ size }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, focusable: false,
      }, h('g', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M3.2 4.4h9.6' }),
        h('path', { d: 'M6.2 4.4V3.1c0-.4.3-.7.7-.7h2.2c.4 0 .7.3.7.7v1.3' }),
        h('path', { d: 'M4.5 4.4l.4 8.6c0 .5.4.9.9.9h4.4c.5 0 .9-.4.9-.9l.4-8.6' }),
        h('path', { d: 'M6.6 6.8v5.2M9.4 6.8v5.2' }),
      ))
    }

    /**
     * Render into the page body so the dialog sits above every portalled
     * surface (menus, tooltips, the narrow-window drawer) instead of being
     * capped by the frame overlay layer's own stacking context.
     * @param node - the element to place.
     * @returns the portalled element, or the node itself without `react-dom`.
     */
    function portal(node) {
      if (typeof document === 'undefined') return node
      if (ReactDOM === undefined || typeof ReactDOM.createPortal !== 'function') return node
      return ReactDOM.createPortal(node, document.body)
    }

    /**
     * A minimal observable value store, created once per activation.
     * @returns the store handle.
     */
    function createStore() {
      let value = null
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (Object.is(value, next)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /**
     * Re-render when an observable changes.
     * @param subscribe - subscribes a listener.
     * @param getSnapshot - reads the current value.
     * @returns the current value.
     */
    function useValue(subscribe, getSnapshot) {
      const [value, setValue] = React.useState(getSnapshot)
      React.useEffect(() => {
        const read = () => { setValue(getSnapshot()) }
        read()
        return subscribe(read)
      }, [subscribe, getSnapshot])
      return value
    }

    /**
     * @param text - template with `{name}` placeholders.
     * @param params - placeholder values.
     * @returns the filled text.
     */
    function interpolate(text, params) {
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match))
    }

    /**
     * Build the translate function over the locale service, with a local fallback.
     * The service is read on demand because activation order between Client
     * modules is not guaranteed.
     * @param getLocale - reads the Client locale service, when present.
     * @returns translate(key, params).
     */
    function createTranslate(getLocale) {
      let cachedLocale
      let bound
      return (key, params) => {
        const locale = getLocale()
        if (locale !== cachedLocale) {
          cachedLocale = locale
          bound = locale !== undefined && typeof locale.bind === 'function' ? locale.bind(NS) : undefined
        }
        if (bound !== undefined) {
          try {
            const text = bound(key, params)
            if (typeof text === 'string' && text.length > 0 && text !== key) return text
          } catch {
            // A dictionary the service cannot resolve falls back to the local table.
          }
        }
        return interpolate(DICT.en[key] ?? key, params)
      }
    }

    /**
     * @param getLocale - reads the Client locale service, when present.
     * @returns a hook that re-renders the caller on locale changes.
     */
    function createLocaleRevisionHook(getLocale) {
      const subscribe = (listener) => {
        const locale = getLocale()
        return locale !== undefined && typeof locale.subscribe === 'function' ? locale.subscribe(listener) : () => {}
      }
      const getSnapshot = () => {
        const locale = getLocale()
        return locale !== undefined && typeof locale.getSnapshot === 'function' ? locale.getSnapshot().revision : 0
      }
      return () => useValue(subscribe, getSnapshot)
    }

    /**
     * Ask the Host to delete Sessions over its exact `/api` route.
     * @param sessionIds - Sessions to delete.
     * @returns the Host's per-Session outcome.
     */
    async function requestDeletion(sessionIds) {
      const response = await fetch(ROUTE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionIds }),
        credentials: 'same-origin',
      })
      if (response.status === 404) {
        const error = new Error(`HTTP 404`)
        error.code = NOT_READY
        throw error
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok) {
        const reason = payload !== null && typeof payload === 'object' && typeof payload.error === 'string'
          ? payload.error
          : `HTTP ${String(response.status)}`
        throw new Error(reason)
      }
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
        throw new Error('unexpected host response')
      }
      return normalizeOutcome(payload)
    }

    /**
     * @param value - untrusted Host value.
     * @returns the outcome shape this module renders.
     */
    function normalizeOutcome(value) {
      const input = value !== null && typeof value === 'object' ? value : {}
      return {
        deleted: Array.isArray(input.deleted) ? input.deleted.filter(entry => typeof entry === 'string') : [],
        failed: Array.isArray(input.failed)
          ? input.failed
            .filter(entry => entry !== null && typeof entry === 'object')
            .map(entry => ({ sessionId: String(entry.sessionId ?? ''), reason: String(entry.reason ?? '') }))
          : [],
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const getLocale = () => ctx.get('locale')
        const pending = createStore()
        const t = createTranslate(getLocale)
        const useLocaleRevision = createLocaleRevisionHook(getLocale)

        const registerDictionaries = (localeService) => () => {
          const disposers = [
            localeService.register(NS, 'en', DICT.en),
            localeService.register(NS, 'zh', DICT.zh),
          ]
          return () => {
            for (const dispose of disposers) {
              try {
                dispose?.()
              } catch {
                // Disposal is best effort; the Client runtime removes leftovers.
              }
            }
          }
        }
        if (typeof ctx.inject === 'function') {
          ctx.inject(['locale'], (localeCtx) => {
            const localeService = localeCtx.get('locale')
            if (localeService === undefined) return
            localeCtx.effect(registerDictionaries(localeService), 'session-delete: dictionaries')
          })
        } else {
          const localeService = ctx.get('locale')
          if (localeService !== undefined && typeof localeService.register === 'function') {
            ctx.effect(registerDictionaries(localeService), 'session-delete: dictionaries')
          }
        }

        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', '@local/dsh-session-delete')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'session-delete: styles')

        /**
         * @param reason - a stable Host failure reason or a raw error message.
         * @returns the localized explanation.
         */
        function reasonText(reason) {
          switch (reason) {
            case REASON_ACTIVE: return t('dialog.active')
            case REASON_BUSY: return t('dialog.busy')
            case REASON_NOT_FOUND: return t('dialog.notFound')
            default: return t('dialog.failed', { message: reason })
          }
        }

        /** One Session menu row; a right-click on the row opens this menu. */
        function SessionDeleteMenuItem(props) {
          const { sessionId, useMenuOpenState } = props
          const displayTitle = typeof props.displayTitle === 'string' ? props.displayTitle : ''
          useLocaleRevision()
          const menuOpenState = typeof useMenuOpenState === 'function' ? useMenuOpenState() : undefined
          const setMenuOpen = typeof menuOpenState?.[1] === 'function' ? menuOpenState[1] : () => {}
          const label = t('menu.delete')
          return h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'dsd-menu-item',
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              setMenuOpen(false)
              pending.set({ sessionId, displayTitle })
            },
          }, h(TrashGlyph, { size: 14 }), h('span', null, label))
        }

        /** The same ask, as a hover action on the row itself. */
        function SessionDeleteRowAction(props) {
          const { sessionId } = props
          const displayTitle = typeof props.displayTitle === 'string' ? props.displayTitle : ''
          useLocaleRevision()
          const label = t('action.delete')
          return h('button', {
            type: 'button',
            className: 'dsd-icon-button',
            'aria-label': label,
            title: label,
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              pending.set({ sessionId, displayTitle })
            },
          }, h(TrashGlyph, { size: 14 }))
        }

        /** The confirmation dialog, then the outcome notice; one request at a time. */
        function SessionDeleteDialog() {
          const request = useValue(pending.subscribe, pending.get)
          useLocaleRevision()
          if (request === null) return null
          const title = request.displayTitle.length > 0 ? request.displayTitle : t('dialog.untitled')
          if (request.done === true) {
            return portal(h(DeletedNotice, { key: `${request.sessionId}:done`, title }))
          }
          return portal(h(DeleteDialogForm, { key: request.sessionId, request, title }))
        }

        /** The transient success notice; announces the outcome, then repaints the list. */
        function DeletedNotice({ title }) {
          React.useEffect(() => {
            const clearTimer = setTimeout(() => { pending.set(null) }, NOTICE_MS)
            const page = globalThis.location
            const reloadTimer = typeof page?.reload === 'function'
              ? setTimeout(() => { page.reload() }, RELOAD_DELAY_MS)
              : undefined
            return () => {
              clearTimeout(clearTimer)
              if (reloadTimer !== undefined) clearTimeout(reloadTimer)
            }
          }, [])
          return h('div', { className: 'dsd-notice', role: 'status' },
            h(TrashGlyph, { size: 13 }),
            h('span', null, t('dialog.done', { title })),
          )
        }

        /** One request's dialog: in-flight and error state die with it. */
        function DeleteDialogForm({ request, title }) {
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState(null)
          const [blocked, setBlocked] = React.useState(false)
          const busyRef = React.useRef(false)
          const cancelRef = React.useRef(null)
          const dialogRef = React.useRef(null)
          useLocaleRevision()

          const close = React.useCallback(() => {
            if (busyRef.current) return
            pending.set(null)
          }, [])

          // Restore the sidebar's focus when the dialog leaves, and place focus
          // on the safe action once the closing menu has restored its own.
          React.useEffect(() => {
            const previous = document.activeElement
            const frame = typeof requestAnimationFrame === 'function'
              ? requestAnimationFrame(() => { cancelRef.current?.focus() })
              : undefined
            if (frame === undefined) cancelRef.current?.focus()
            return () => {
              if (frame !== undefined) cancelAnimationFrame(frame)
              if (previous !== null && typeof previous.focus === 'function' && previous.isConnected) previous.focus()
            }
          }, [])

          React.useEffect(() => {
            const onKeyDown = (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                close()
                return
              }
              if (event.key !== 'Tab') return
              const dialog = dialogRef.current
              if (dialog === null) return
              const items = [...dialog.querySelectorAll(FOCUSABLE)]
              if (items.length === 0) {
                event.preventDefault()
                return
              }
              const first = items[0]
              const last = items[items.length - 1]
              const active = document.activeElement
              if (!dialog.contains(active)) {
                event.preventDefault()
                first.focus()
                return
              }
              if (event.shiftKey && active === first) {
                event.preventDefault()
                last.focus()
              } else if (!event.shiftKey && active === last) {
                event.preventDefault()
                first.focus()
              }
            }
            document.addEventListener('keydown', onKeyDown, true)
            return () => { document.removeEventListener('keydown', onKeyDown, true) }
          }, [close])

          const confirm = async () => {
            if (busyRef.current) return
            busyRef.current = true
            setBusy(true)
            setError(null)
            try {
              const outcome = await requestDeletion([request.sessionId])
              const failure = outcome.failed.find(entry => entry.sessionId === request.sessionId)
              busyRef.current = false
              setBusy(false)
              if (failure === undefined) {
                pending.set({ sessionId: request.sessionId, displayTitle: request.displayTitle, done: true })
                return
              }
              setError(reasonText(failure.reason))
              if (failure.reason === REASON_ACTIVE) setBlocked(true)
            } catch (reason) {
              busyRef.current = false
              setBusy(false)
              setError(reason?.code === NOT_READY
                ? t('dialog.notReady')
                : t('dialog.transport', { message: reason instanceof Error ? reason.message : String(reason) }))
            }
          }

          return h('div', {
            className: 'dsd-backdrop',
            onMouseDown: (event) => { if (event.target === event.currentTarget) close() },
          }, h('div', {
            className: 'dsd-dialog',
            ref: dialogRef,
            role: 'dialog',
            'aria-modal': true,
            'aria-labelledby': 'dsd-session-delete-title',
            'aria-describedby': 'dsd-session-delete-body',
          },
          h('h2', { className: 'dsd-title', id: 'dsd-session-delete-title' }, t('dialog.title')),
          h('p', { className: 'dsd-body', id: 'dsd-session-delete-body' }, t('dialog.body', { title })),
          error === null ? null : h('p', { className: 'dsd-error', role: 'alert' }, error),
          busy ? h('p', { className: 'dsd-status', role: 'status' }, t('dialog.pending')) : null,
          h('div', { className: 'dsd-footer' },
            h('button', {
              type: 'button',
              ref: cancelRef,
              className: 'dsd-button',
              disabled: busy,
              onClick: close,
            }, t('dialog.cancel')),
            h('button', {
              type: 'button',
              className: 'dsd-button dsd-button-danger',
              disabled: busy || blocked,
              onClick: () => { void confirm() },
            }, t('dialog.confirm')),
          )))
        }

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'session-delete.menu', order: 700 },
          SessionDeleteMenuItem,
        ))

        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register(
          { name: 'sidebar.workspaces.session.row.action', id: 'session-delete.row-action', order: 300 },
          SessionDeleteRowAction,
        ))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'session-delete.dialog' },
          SessionDeleteDialog,
        ))
      },
    }
  },
})
