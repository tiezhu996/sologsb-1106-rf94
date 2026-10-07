import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import Dexie from 'dexie'

// 先按 v2 结构建库并塞旧数据，再用正式 db 打开触发 v3 迁移。
async function buildLegacyV2(): Promise<void> {
  const legacy = new Dexie('gbwoodprint-db')
  legacy.version(2).stores({
    drafts: 'id, genre, status, title, schemaRev',
    blocks: 'id, draftId, colorNo, carvedBy, state, schemaRev',
    carvers: 'id, specialty, skillLevel, name, schemaRev',
    batches: 'id, draftId, batchNo, printedAt, schemaRev',
    nodes: 'id, batchId, blockId, stage, seq, operator, schemaRev',
  })
  await legacy.table('blocks').bulkAdd([
    {
      id: 'old-block-1',
      draftId: 'old-draft',
      blockName: '墨线版',
      colorNo: 1,
      woodType: '黄杨',
      thicknessMm: 18,
      carvedBy: '齐师傅',
      state: '已刻成',
      defectNote: '旧崩口记录',
      schemaRev: 2,
    },
  ])
  await legacy.table('batches').bulkAdd([
    {
      id: 'old-batch-1',
      draftId: 'old-draft',
      batchNo: '旧批次',
      printedAt: '2026-02-02',
      paperBatch: '旧纸',
      inkNote: '旧墨',
      qty: 777,
      pieceCount: 3,
      qcNote: '旧偏差原文',
      schemaRev: 2,
    },
  ])
  await legacy.close()
}

describe('v2 -> v3 迁移', () => {
  it('旧批次只标待复核不改印数偏差；旧版片回填 rev=1', async () => {
    await buildLegacyV2()
    // 动态引入，确保建库发生在旧数据就绪之后
    const { db } = await import('../src/utils/db')
    await db.open()

    const batch = await db.batches.get('old-batch-1')
    expect(batch?.releaseStatus).toBe('待复核')
    expect(batch?.blockSnapshots).toEqual([])
    expect(batch?.releaseBasis).toContain('历史批次')
    expect(batch?.qty).toBe(777)
    expect(batch?.pieceCount).toBe(3)
    expect(batch?.qcNote).toBe('旧偏差原文')

    const block = await db.blocks.get('old-block-1')
    expect(block?.rev).toBe(1)
    expect(block?.defectNote).toBe('旧崩口记录')
    expect(block?.state).toBe('已刻成')
    expect(block?.schemaRev).toBe(3)

    db.close()
    await db.delete()
  })
})
