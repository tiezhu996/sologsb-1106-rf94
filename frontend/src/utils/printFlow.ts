import { db } from './db'
import { notifyArchiveChange } from './crossTab'
import type { Block, BlockState } from '../types/block'
import type { DraftStatus } from '../types/draft'
import type { BatchBlockSnapshot, PrintBatch } from '../types/batch'

/** 一套四块：墨线、黄、红、绿 */
export const REQUIRED_BLOCK_COUNT = 4
/** 只有这两种状态视为开印合格 */
const PRINT_READY_STATES: ReadonlySet<BlockState> = new Set(['已刻成', '已修版'])

export function isPrintReadyState(state: BlockState): boolean {
  return PRINT_READY_STATES.has(state)
}

/** 后提交的一方看到的冲突错误：不得覆盖前一次的版片和节点记录 */
export class RevisionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RevisionConflictError'
  }
}

/** 放行条件不满足：四块不齐 / 仍有未刻成未修版的版片 */
export class ReleaseBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseBlockedError'
  }
}

export interface ReleaseReadiness {
  ready: boolean
  blocks: Block[]
  notReady: Block[]
  reasons: string[]
}

/** 按当前版片状态重算画稿可否开印 */
export function evaluateReadiness(blocks: Block[]): ReleaseReadiness {
  const ordered = [...blocks].sort((a, b) => a.colorNo - b.colorNo)
  const reasons: string[] = []
  if (ordered.length !== REQUIRED_BLOCK_COUNT) {
    reasons.push(`当前只有 ${ordered.length} 块版片，需凑齐 ${REQUIRED_BLOCK_COUNT} 块才能开印`)
  }
  const notReady = ordered.filter((block) => !isPrintReadyState(block.state))
  for (const block of notReady) {
    reasons.push(`${block.colorNo}${block.blockName}当前为「${block.state}」，须刻成或返修验版后方可开印`)
  }
  return { ready: reasons.length === 0, blocks: ordered, notReady, reasons }
}

/** 版片状态一变，画稿可印结论就失效重算 */
export function draftStatusFromBlocks(blocks: Block[]): DraftStatus {
  return evaluateReadiness(blocks).ready ? '可印' : '刻版中'
}

/** 在事务内重读版片并校验乐观锁版本；版本已变则整笔事务中止 */
async function requireRevisions(txBlocks: Map<string, number>): Promise<Block[]> {
  const blocks: Block[] = []
  for (const [blockId, expectedRev] of txBlocks) {
    const block = await db.blocks.get(blockId)
    if (!block) throw new ReleaseBlockedError(`版片 ${blockId} 已不存在，请刷新后重试。`)
    if (block.rev !== expectedRev) {
      throw new RevisionConflictError(
        `${block.colorNo}${block.blockName}的档案刚被另一处提交改过（当前版本 ${block.rev}），请刷新核对后再提交。`,
      )
    }
    blocks.push(block)
  }
  return blocks.sort((a, b) => a.colorNo - b.colorNo)
}

async function nextNodeSeq(blockId: string): Promise<number> {
  const existing = await db.nodes.where('blockId').equals(blockId).toArray()
  return existing.reduce((max, node) => Math.max(max, node.seq), 0) + 1
}

/** 从该刻工的在刻清单中去掉版片（返修完成后不再计入在刻数） */
async function removeFromAllCarvers(blockId: string): Promise<void> {
  const carvers = await db.carvers.toArray()
  for (const carver of carvers) {
    if (!carver.activeBlockIds.includes(blockId)) continue
    await db.carvers.update(carver.id, {
      activeBlockIds: carver.activeBlockIds.filter((id) => id !== blockId),
    })
  }
}

/** 把版片加入指定修版刻工的在刻清单（同时从其他刻工处移除） */
async function assignToCarver(blockId: string, carverId: string): Promise<void> {
  const carvers = await db.carvers.toArray()
  for (const carver of carvers) {
    const without = carver.activeBlockIds.filter((id) => id !== blockId)
    if (carver.id === carverId && !without.includes(blockId)) without.push(blockId)
    if (without.length !== carver.activeBlockIds.length) {
      await db.carvers.update(carver.id, { activeBlockIds: without })
    }
  }
}

export interface RegisterBatchInput {
  draftId: string
  batchNo: string
  printedAt: string
  paperBatch: string
  inkNote: string
  qty: number
  pieceCount: number
  qcNote: string
  /** 表单打开时所见的版片版本，用于拦截两个标签页的后提交者 */
  expectedRevs: Record<string, number>
}

/**
 * 新批次放行：登记时保存四块版片的当前状态和崩口记录，
 * 只有四块版片都已刻成或已修版才允许开印。整个判定与写入在同一事务内完成。
 */
export async function registerPrintBatch(input: RegisterBatchInput): Promise<PrintBatch> {
  const id = `batch-${crypto.randomUUID()}`
  return db.transaction(
    'rw',
    db.batches,
    db.blocks,
    db.drafts,
    db.nodes,
    db.carvers,
    async (): Promise<PrintBatch> => {
      const expected = new Map(Object.entries(input.expectedRevs))
      // 事务内重读：另一标签页若先提交，版本对不上，本批次直接拒绝。
      const checked = expected.size > 0 ? await requireRevisions(expected) : []
      const blocks =
        checked.length > 0
          ? checked
          : (await db.blocks.where('draftId').equals(input.draftId).toArray()).sort((a, b) => a.colorNo - b.colorNo)

      const readiness = evaluateReadiness(blocks)
      if (!readiness.ready) throw new ReleaseBlockedError(readiness.reasons.join('；'))

      const blockSnapshots: BatchBlockSnapshot[] = blocks.map((block) => ({
        blockId: block.id,
        blockName: block.blockName,
        colorNo: block.colorNo,
        state: block.state,
        defectNote: block.defectNote,
        rev: block.rev,
      }))
      const releaseBasis = `开印时四块版片均合格：${blockSnapshots
        .map((snapshot) => `${snapshot.colorNo}${snapshot.blockName}=${snapshot.state}(v${snapshot.rev})`)
        .join('、')}；崩口记录随档保存。`

      const batch: PrintBatch = {
        id,
        draftId: input.draftId,
        batchNo: input.batchNo,
        printedAt: input.printedAt,
        paperBatch: input.paperBatch,
        inkNote: input.inkNote,
        qty: input.qty,
        pieceCount: input.pieceCount,
        qcNote: input.qcNote,
        releaseStatus: '已放行',
        blockSnapshots,
        releaseBasis,
      }
      await db.batches.add(batch)
      return batch
    },
  ).then((saved) => {
    notifyArchiveChange('batches')
    return saved
  })
}

export interface RepairSubmissionInput {
  blockId: string
  /** 提交时所依据的版片版本；与库中不一致则报冲突，不覆盖前一次返修记录 */
  expectedRev: number
  repairNote: string
  operator: string
  durationMin: number
}

/**
 * 返修提交：一笔事务内追加修版节点、更新版片状态为「已修版」、
 * 同步刻工在刻数，并重算画稿可印结论。任一写入失败整笔回滚，不留半套状态。
 */
export async function submitRepair(input: RepairSubmissionInput): Promise<Block> {
  return db.transaction('rw', db.blocks, db.nodes, db.carvers, db.drafts, async (): Promise<Block> => {
    const [block] = await requireRevisions(new Map([[input.blockId, input.expectedRev]]))
    const nextRev = block.rev + 1
    const now = new Date().toISOString().slice(0, 16)

    await db.nodes.add({
      id: `node-${crypto.randomUUID()}`,
      blockId: block.id,
      stage: '修版',
      seq: await nextNodeSeq(block.id),
      operator: input.operator,
      startedAt: now,
      durationMin: Math.max(0, Math.floor(input.durationMin)),
      note: input.repairNote,
    })
    const updated: Block = { ...block, state: '已修版', rev: nextRev }
    await db.blocks.put(updated)
    await removeFromAllCarvers(block.id)

    const draftBlocks = await db.blocks.where('draftId').equals(block.draftId).toArray()
    await db.drafts.update(block.draftId, { status: draftStatusFromBlocks(draftBlocks) })
    return updated
  }).then((saved) => {
    notifyArchiveChange('blocks')
    return saved
  })
}

/** 崩口返修退回：版片改「返修中」，挂到修版刻工名下，立即重算可印结论 */
export async function reopenForRepair(input: {
  blockId: string
  expectedRev: number
  repairCarverId: string
  defectNote: string
}): Promise<Block> {
  return db.transaction('rw', db.blocks, db.carvers, db.drafts, db.nodes, async (): Promise<Block> => {
    const [block] = await requireRevisions(new Map([[input.blockId, input.expectedRev]]))
    if (block.state !== '已刻成' && block.state !== '已修版') {
      throw new ReleaseBlockedError(`「${block.state}」状态的版片不需要退回返修。`)
    }
    const updated: Block = {
      ...block,
      state: '返修中',
      defectNote: input.defectNote,
      rev: block.rev + 1,
    }
    await db.blocks.put(updated)
    await assignToCarver(block.id, input.repairCarverId)
    await db.nodes.add({
      id: `node-${crypto.randomUUID()}`,
      blockId: block.id,
      stage: '修版',
      seq: await nextNodeSeq(block.id),
      operator: '印制管事',
      startedAt: new Date().toISOString().slice(0, 16),
      durationMin: 0,
      note: '崩口退回返修，等待修版刻工验版。',
    })
    const draftBlocks = await db.blocks.where('draftId').equals(block.draftId).toArray()
    await db.drafts.update(block.draftId, { status: draftStatusFromBlocks(draftBlocks) })
    return updated
  }).then((saved) => {
    notifyArchiveChange('blocks')
    return saved
  })
}

/** 标记刻成：节点、版片状态、刻工在刻数与画稿可印结论一并提交，失败整笔回滚 */
export async function markBlockCarved(input: {
  blockId: string
  expectedRev: number
}): Promise<Block> {
  return db.transaction('rw', db.blocks, db.nodes, db.carvers, db.drafts, async (): Promise<Block> => {
    const [block] = await requireRevisions(new Map([[input.blockId, input.expectedRev]]))
    if (block.state === '已刻成' || block.state === '已修版') {
      throw new ReleaseBlockedError(`${block.colorNo}${block.blockName}已是「${block.state}」，无需重复标刻成。`)
    }
    const updated: Block = { ...block, state: '已刻成', rev: block.rev + 1 }
    await db.nodes.add({
      id: `node-${crypto.randomUUID()}`,
      blockId: block.id,
      stage: '刻版',
      seq: await nextNodeSeq(block.id),
      operator: block.carvedBy || '当班刻工',
      startedAt: new Date().toISOString().slice(0, 16),
      durationMin: 0,
      note: '版片验线后标记刻成。',
    })
    await db.blocks.put(updated)
    await removeFromAllCarvers(block.id)
    const draftBlocks = await db.blocks.where('draftId').equals(block.draftId).toArray()
    await db.drafts.update(block.draftId, { status: draftStatusFromBlocks(draftBlocks) })
    return updated
  }).then((saved) => {
    notifyArchiveChange('blocks')
    return saved
  })
}

/** 崩口记录保存也走版本校验并自增版本，状态随之变化的页面会自动重取 */
export async function saveBlockDefect(input: {
  blockId: string
  expectedRev: number
  defectNote: string
}): Promise<Block> {
  return db.transaction('rw', db.blocks, async (): Promise<Block> => {
    const [block] = await requireRevisions(new Map([[input.blockId, input.expectedRev]]))
    const updated: Block = { ...block, defectNote: input.defectNote, rev: block.rev + 1 }
    await db.blocks.put(updated)
    return updated
  }).then((saved) => {
    notifyArchiveChange('blocks')
    return saved
  })
}
