import { derived, get, writable } from 'svelte/store'
import type { Block, BlockState } from '../types/block'
import { db } from '../utils/db'
import {
  commitBlockStateChangeInTx,
  isBlockFinished,
  RepairConflictError,
} from '../utils/printGate'

const blockList = writable<Block[]>([])

export interface DraftBlockStats {
  total: number
  carved: number
  rate: number
}

export interface RepairInput {
  blockId: string
  /** 提交时页面所见的 stateRev，事务内不一致即判并发冲突。 */
  expectedRev: number
  operator: string
  durationMin: number
  note: string
  defectNote: string
}

const statsByDraft = derived(blockList, ($blocks) => {
  const stats: Record<string, DraftBlockStats> = {}
  for (const block of $blocks) {
    const current = stats[block.draftId] ?? { total: 0, carved: 0, rate: 0 }
    current.total += 1
    if (isBlockFinished(block.state)) current.carved += 1
    current.rate = current.total === 0 ? 0 : Math.round((current.carved / current.total) * 100)
    stats[block.draftId] = current
  }
  return stats
})

async function load(): Promise<void> {
  const records = await db.blocks.toArray()
  records.sort((a, b) => a.draftId.localeCompare(b.draftId) || a.colorNo - b.colorNo)
  blockList.set(records)
}

async function create(input: Omit<Block, 'id' | 'stateRev'>): Promise<string> {
  const id = `block-${crypto.randomUUID()}`
  await db.blocks.add({ id, ...input, stateRev: 1 })
  await load()
  return id
}

/** 仅用于不涉及状态流转的字段（如单独保存崩口文字记录）。 */
async function update(id: string, changes: Partial<Omit<Block, 'id' | 'stateRev'>>): Promise<void> {
  await db.blocks.update(id, changes)
  await load()
}

async function reorder(ordered: Array<Pick<Block, 'id' | 'colorNo'>>): Promise<void> {
  await db.transaction('rw', db.blocks, async () => {
    for (const item of ordered) {
      await db.blocks.update(item.id, { colorNo: item.colorNo })
    }
  })
  await load()
}

async function removeByDraft(draftId: string): Promise<void> {
  await db.blocks.where('draftId').equals(draftId).delete()
  await load()
}

/** 从各刻工在刻清单中摘除此版（刻工在刻数随之减少）。调用方需持有 carvers 写锁。 */
async function releaseCarversInTx(blockId: string): Promise<void> {
  const carvers = await db.carvers.toArray()
  for (const carver of carvers) {
    if (!carver.activeBlockIds.includes(blockId)) continue
    await db.carvers.update(carver.id, {
      activeBlockIds: carver.activeBlockIds.filter((id) => id !== blockId),
    })
  }
}

async function nextNodeSeq(blockId: string): Promise<number> {
  const existing = await db.nodes.where('blockId').equals(blockId).toArray()
  return existing.reduce((max, node) => Math.max(max, node.seq), 0) + 1
}

/** 标记刻成：版片状态、刻工在刻数、刻版节点与可印结论一次写定。 */
async function markCarved(blockId: string): Promise<void> {
  await db.transaction('rw', db.blocks, db.carvers, db.drafts, db.batches, db.nodes, async () => {
    const block = await db.blocks.get(blockId)
    if (!block || isBlockFinished(block.state)) return
    await commitBlockStateChangeInTx(block, '已刻成')
    await releaseCarversInTx(blockId)
    await db.nodes.add({
      id: `node-${crypto.randomUUID()}`,
      blockId: block.id,
      stage: '刻版',
      seq: await nextNodeSeq(blockId),
      operator: block.carvedBy || '当班刻工',
      startedAt: new Date().toISOString().slice(0, 16),
      durationMin: 0,
      note: '版片验线后标记刻成。',
    })
  })
  await load()
}

/** 阶段轨道回退引起的状态调整，同样递增版本并重算结论，不留下失效的“可印”。 */
async function rollbackState(blockId: string, nextState: BlockState): Promise<void> {
  await db.transaction('rw', db.blocks, db.drafts, db.batches, async () => {
    const block = await db.blocks.get(blockId)
    if (!block || block.state === nextState) return
    await commitBlockStateChangeInTx(block, nextState)
  })
  await load()
}

/**
 * 返修放行提交（崩口返修）：
 * 修版节点、版片状态（已修版 + stateRev）、崩口记录、刻工在刻数、画稿可印结论
 * 全部在一个事务内写定；stateRev 与页面所见不一致即抛冲突，整笔回滚。
 */
async function submitRepair(input: RepairInput): Promise<void> {
  await db.transaction(
    'rw',
    db.blocks,
    db.carvers,
    db.drafts,
    db.batches,
    db.nodes,
    async () => {
      const block = await db.blocks.get(input.blockId)
      if (!block) throw new RepairConflictError('该版片')
      if (block.stateRev !== input.expectedRev) throw new RepairConflictError(block.blockName)

      await commitBlockStateChangeInTx(block, '已修版', { defectNote: input.defectNote })
      await releaseCarversInTx(block.id)
      await db.nodes.add({
        id: `node-${crypto.randomUUID()}`,
        blockId: block.id,
        stage: '修版',
        seq: await nextNodeSeq(block.id),
        operator: input.operator,
        startedAt: new Date().toISOString().slice(0, 16),
        durationMin: input.durationMin,
        note: input.note,
      })
    },
  )
  await load()
}

/** 页面上当前可见的版片版本号，供返修提交做乐观并发校验。 */
function currentRev(blockId: string): number {
  return get(blockList).find((block) => block.id === blockId)?.stateRev ?? 0
}

export const blockStore = {
  subscribe: blockList.subscribe,
  statsByDraft,
  load,
  create,
  update,
  reorder,
  removeByDraft,
  markCarved,
  rollbackState,
  submitRepair,
  currentRev,
}
