import { db } from './db'
import type { Block, BlockState } from '../types/block'
import type { Draft } from '../types/draft'
import type { PrintBatch } from '../types/batch'

/** 只有“已刻成”或“已修版”才算版片完工、可参与开印。 */
export function isBlockFinished(state: BlockState): boolean {
  return state === '已刻成' || state === '已修版'
}

/** 当前可印结论版本：四块版片 stateRev 之和；任一版未刻成则结论不成立。 */
export function printGateRev(blocks: Pick<Block, 'state' | 'stateRev'>[]): number | null {
  if (blocks.length === 0 || !blocks.every((block) => isBlockFinished(block.state))) return null
  return blocks.reduce((sum, block) => sum + block.stateRev, 0)
}

/** 给定画稿的开印闸口：四块齐备且全部刻成/修版才放行。 */
export interface PrintGate {
  draftId: string
  ready: boolean
  total: number
  finished: number
  /** 尚未刻成（待刻/在刻）的版片名，供页面逐块提示。 */
  pendingNames: string[]
  gateRev: number | null
}

export function evaluatePrintGate(draftId: string, blocks: Block[]): PrintGate {
  const draftBlocks = blocks
    .filter((block) => block.draftId === draftId)
    .sort((a, b) => a.colorNo - b.colorNo)
  const pending = draftBlocks.filter((block) => !isBlockFinished(block.state))
  return {
    draftId,
    ready: draftBlocks.length === 4 && pending.length === 0,
    total: draftBlocks.length,
    finished: draftBlocks.length - pending.length,
    pendingNames: pending.map((block) => block.blockName),
    gateRev: printGateRev(draftBlocks),
  }
}

/**
 * 版片状态一变，画稿的可印结论随之重算并回写。
 * 必须在持有 blocks/drafts 写锁的事务内调用。
 */
export async function refreshDraftGateInTx(draftId: string): Promise<void> {
  const draftBlocks = await db.blocks.where('draftId').equals(draftId).toArray()
  const gateRev = printGateRev(draftBlocks)
  const status: Draft['status'] = gateRev === null ? (draftBlocks.length > 0 ? '刻版中' : '起稿') : '可印'
  await db.drafts.update(draftId, { status, printReadyRev: gateRev })
}

/** 已放行批次的快照依据是否还跟当前版片对得上。旧批次无快照一律算失效。 */
export function isBatchSnapshotStale(batch: PrintBatch, blocks: Block[]): boolean {
  if (batch.releaseState !== '已放行') return false
  if (!batch.blockSnapshots || batch.blockSnapshots.length === 0) return true
  return batch.blockSnapshots.some((snapshot) => {
    const current = blocks.find((block) => block.id === snapshot.blockId)
    if (!current) return true
    return current.stateRev !== snapshot.stateRev || current.state !== snapshot.state
  })
}

/**
 * 版片状态流转的公共收尾（调用方须持有 blocks/drafts/batches 写锁）：
 * 更新版片状态并递增 stateRev → 重算画稿可印结论 → 依据失效的已放行批次标待复核。
 * 返回新的 stateRev。
 */
export async function commitBlockStateChangeInTx(
  block: Block,
  nextState: Block['state'],
  changes: Partial<Pick<Block, 'defectNote' | 'carvedBy'>> = {},
): Promise<number> {
  const nextRev = block.stateRev + 1
  await db.blocks.update(block.id, { ...changes, state: nextState, stateRev: nextRev })

  const draftBlocks = await db.blocks.where('draftId').equals(block.draftId).toArray()
  await refreshDraftGateInTx(block.draftId)

  for (const batch of await db.batches.where('draftId').equals(block.draftId).toArray()) {
    if (isBatchSnapshotStale(batch, draftBlocks)) {
      await db.batches.update(batch.id, { releaseState: '待复核' })
    }
  }
  return nextRev
}

/** 开印闸口未通过时抛出，页面据此提示而不是留下半成品批次。 */
export class GateBlockedError extends Error {
  readonly gate: PrintGate
  constructor(gate: PrintGate) {
    super(
      gate.total === 0
        ? '这张画稿还没有四块版片，暂不能开印。'
        : `还有版片未刻成（${gate.pendingNames.join('、')}），四块版片全部刻成或修版后才允许开印。`,
    )
    this.name = 'GateBlockedError'
    this.gate = gate
  }
}

/** 返修乐观并发冲突：版片已被另一个标签页先改过，后提交者不得覆盖。 */
export class RepairConflictError extends Error {
  constructor(blockName: string) {
    super(`「${blockName}」的版片状态已在别处被修改，请刷新后依据最新崩口记录重新提交返修。`)
    this.name = 'RepairConflictError'
  }
}
