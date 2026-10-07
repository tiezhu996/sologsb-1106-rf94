/**
 * 跨标签页变更广播：A 标签页提交返修/批次后，B 标签页据此重取档案，
 * 保证后提交一方在提交前看到最新版片版本。不可用时静默降级（仍有乐观锁兜底）。
 */
const CHANNEL_NAME = 'gbwoodprint-db-changes'
const STORAGE_KEY = 'gbwoodprint-db-change-tick'

export type ArchiveTable = 'drafts' | 'blocks' | 'carvers' | 'batches' | 'nodes'

export interface ArchiveChange {
  table: ArchiveTable
  at: number
}

type ChangeListener = (change: ArchiveChange) => void

let channel: BroadcastChannel | null = null
const listeners = new Set<ChangeListener>()

function broadcastToListeners(change: ArchiveChange): void {
  for (const listener of listeners) {
    try {
      listener(change)
    } catch {
      // 单个监听者出错不影响其它标签页同步
    }
  }
}

function ensureChannel(): BroadcastChannel | null {
  if (channel !== null) return channel
  if (typeof BroadcastChannel === 'undefined') {
    channel = null
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key !== STORAGE_KEY || !event.newValue) return
        broadcastToListeners({ table: 'blocks', at: Number(event.newValue) || Date.now() })
      })
    }
    return null
  }
  channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (event: MessageEvent<ArchiveChange>) => {
    if (event.data && typeof event.data === 'object') broadcastToListeners(event.data)
  }
  return channel
}

/** 本标签页完成一笔写入后调用，通知其它标签页重取 */
export function notifyArchiveChange(table: ArchiveTable): void {
  const change: ArchiveChange = { table, at: Date.now() }
  const active = ensureChannel()
  if (active) {
    active.postMessage(change)
  } else if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, String(change.at))
  }
}

/** 订阅其它标签页的写入通知；返回退订函数 */
export function subscribeArchiveChanges(listener: ChangeListener): () => void {
  ensureChannel()
  listeners.add(listener)
  return () => listeners.delete(listener)
}
