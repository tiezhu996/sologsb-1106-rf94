import { writable } from 'svelte/store'
import type { PrintBatch, BatchBlockSnapshot } from '../types/batch'
import type { Block } from '../types/block'
import { db } from '../utils/db'
import { evaluatePrintGate, GateBlockedError, refreshDraftGateInTx } from '../utils/printGate'

export interface RegisterBatchInput {
  draftId: string
  batchNo: string
  printedAt: string
  paperBatch: string
  inkNote: string
  qty: number
  pieceCount: number
  qcNote: string
}

const batchList = writable<PrintBatch[]>([])

async function load(): Promise<void> {
  const records = await db.batches.toArray()
  records.sort((a, b) => b.printedAt.localeCompare(a.printedAt) || b.batchNo.localeCompare(a.batchNo, 'zh-CN'))
  batchList.set(records)
}

function snapshotOf(block: Block): BatchBlockSnapshot {
  return {
    blockId: block.id,
    blockName: block.blockName,
    colorNo: block.colorNo,
    state: block.state,
    defectNote: block.defectNote,
    stateRev: block.stateRev,
  }
}

/**
 * 新批次登记：在同一个事务里
 * 1) 重新读四块版片并按「全部刻成/修版」校验开印闸口；
 * 2) 冻结四块版片当前状态与崩口记录作为放行依据；
 * 3) 写入批次。
 * 闸口不过或写入失败都整体回滚，不留下半套状态。
 */
async function register(input: RegisterBatchInput): Promise<PrintBatch> {
  const created = await db.transaction('rw', db.batches, db.blocks, db.drafts, async () => {
    const freshBlocks = await db.blocks.toArray()
    const gate = evaluatePrintGate(input.draftId, freshBlocks)
    if (!gate.ready) throw new GateBlockedError(gate)

    const draft = await db.drafts.get(input.draftId)
    if (!draft) throw new GateBlockedError(gate)

    const draftBlocks = freshBlocks
      .filter((block) => block.draftId === input.draftId)
      .sort((a, b) => a.colorNo - b.colorNo)

    const batch: PrintBatch = {
      id: `batch-${crypto.randomUUID()}`,
      draftId: input.draftId,
      batchNo: input.batchNo,
      printedAt: input.printedAt,
      paperBatch: input.paperBatch,
      inkNote: input.inkNote,
      qty: input.qty,
      pieceCount: input.pieceCount,
      qcNote: input.qcNote,
      releaseState: '已放行',
      blockSnapshots: draftBlocks.map(snapshotOf),
      gateRev: gate.gateRev ?? undefined,
    }
    await db.batches.add(batch)

    // 登记动作不改变版片状态，仅把画稿可印结论与当前版片重新对齐一遍。
    if (draft.printReadyRev !== gate.gateRev) {
      await refreshDraftGateInTx(input.draftId)
    }
    return batch
  })
  await load()
  return created
}

export const batchStore = {
  subscribe: batchList.subscribe,
  load,
  register,
}
