import 'fake-indexeddb/auto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, initializeDatabase } from '../src/utils/db'
import {
  draftStatusFromBlocks,
  evaluateReadiness,
  markBlockCarved,
  reopenForRepair,
  registerPrintBatch,
  ReleaseBlockedError,
  RevisionConflictError,
  saveBlockDefect,
  submitRepair,
} from '../src/utils/printFlow'

async function resetDb(): Promise<void> {
  await db.delete()
  await db.open()
  await initializeDatabase()
}

beforeEach(async () => {
  await resetDb()
})

afterAll(() => {
  db.close()
})

describe('放行判定', () => {
  it('种子库中莲年有余四块齐备可印，门神只有两块成版不可印', async () => {
    const lianBlocks = await db.blocks.where('draftId').equals('draft-liannian-youyu').toArray()
    expect(evaluateReadiness(lianBlocks).ready).toBe(true)

    const menshenBlocks = await db.blocks.where('draftId').equals('draft-menshen-qin').toArray()
    expect(evaluateReadiness(menshenBlocks).ready).toBe(false)
    expect(draftStatusFromBlocks(menshenBlocks)).toBe('刻版中')
  })

  it('新批次保存四块版片快照（状态+崩口记录+版本依据）', async () => {
    const batch = await registerPrintBatch({
      draftId: 'draft-liannian-youyu',
      batchNo: '莲鱼-测试-01',
      printedAt: '2026-10-07',
      paperBatch: '绵竹-2610',
      inkNote: '',
      qty: 100,
      pieceCount: 4,
      qcNote: '测试偏差',
      expectedRevs: {},
    })
    expect(batch.releaseStatus).toBe('已放行')
    expect(batch.blockSnapshots).toHaveLength(4)
    for (const snapshot of batch.blockSnapshots) {
      expect(['已刻成', '已修版']).toContain(snapshot.state)
      expect(typeof snapshot.defectNote).toBe('string')
      expect(snapshot.rev).toBeGreaterThanOrEqual(1)
    }
    expect(batch.releaseBasis).toContain('四块版片均合格')
  })

  it('四块未齐时拒绝开印，不写入批次', async () => {
    const before = await db.batches.count()
    await expect(
      registerPrintBatch({
        draftId: 'draft-menshen-qin',
        batchNo: '门神-违规-01',
        printedAt: '2026-10-07',
        paperBatch: '纸',
        inkNote: '',
        qty: 10,
        pieceCount: 4,
        qcNote: '',
        expectedRevs: {},
      }),
    ).rejects.toBeInstanceOf(ReleaseBlockedError)
    expect(await db.batches.count()).toBe(before)
  })

  it('历史批次只标待复核，原印数与偏差不改写', async () => {
    const old = await db.batches.get('batch-ll-001')
    expect(old?.releaseStatus).toBe('待复核')
    expect(old?.blockSnapshots).toEqual([])
    expect(old?.qty).toBe(480)
    expect(old?.qcNote).toContain('墨线版：线条饱满')
  })
})

describe('返修事务', () => {
  it('返修提交同时追加修版节点、版片转已修版、刻工在刻数减少、画稿恢复可印', async () => {
    // 莲鱼四块都成版 -> 可印；把墨线版退回返修 -> 不可印；提交返修 -> 恢复可印
    const inkBlock = (await db.blocks.get('block-ll-01'))!
    const repairCarver = (await db.carvers.toArray()).find((c) => c.specialty === '修版')!

    await reopenForRepair({
      blockId: inkBlock.id,
      expectedRev: inkBlock.rev,
      repairCarverId: repairCarver.id,
      defectNote: '新崩口待修',
    })
    let updated = (await db.blocks.get(inkBlock.id))!
    expect(updated.state).toBe('返修中')
    expect(updated.rev).toBe(inkBlock.rev + 1)
    expect((await db.carvers.get(repairCarver.id))!.activeBlockIds).toContain(inkBlock.id)
    expect((await db.drafts.get('draft-liannian-youyu'))!.status).toBe('刻版中')
    // 返修中开印被拒
    await expect(
      registerPrintBatch({
        draftId: 'draft-liannian-youyu',
        batchNo: 'x',
        printedAt: '2026-10-07',
        paperBatch: 'p',
        inkNote: '',
        qty: 1,
        pieceCount: 4,
        qcNote: '',
        expectedRevs: {},
      }),
    ).rejects.toBeInstanceOf(ReleaseBlockedError)

    const reopenNodeCount = await db.nodes.where('blockId').equals(inkBlock.id).count()
    await submitRepair({
      blockId: inkBlock.id,
      expectedRev: updated.rev,
      repairNote: '崩口嵌木修平',
      operator: repairCarver.name,
      durationMin: 90,
    })
    updated = (await db.blocks.get(inkBlock.id))!
    expect(updated.state).toBe('已修版')
    expect(updated.defectNote).toBe('新崩口待修')
    expect((await db.carvers.get(repairCarver.id))!.activeBlockIds).not.toContain(inkBlock.id)
    expect((await db.drafts.get('draft-liannian-youyu'))!.status).toBe('可印')
    const nodes = await db.nodes.where('blockId').equals(inkBlock.id).toArray()
    expect(nodes).toHaveLength(reopenNodeCount + 1)
    const repairNode = nodes.sort((a, b) => b.seq - a.seq)[0]!
    expect(repairNode.stage).toBe('修版')
    expect(repairNode.note).toBe('崩口嵌木修平')
    expect(repairNode.durationMin).toBe(90)
  })

  it('任一写入失败时整笔回滚，不留半套状态', async () => {
    const inkBlock = (await db.blocks.get('block-ll-03'))!
    const repairCarver = (await db.carvers.toArray()).find((c) => c.specialty === '修版')!

    // 先把版片退回返修，此时它挂在修版刻工名下、画稿转为刻版中。
    await reopenForRepair({
      blockId: inkBlock.id,
      expectedRev: inkBlock.rev,
      repairCarverId: repairCarver.id,
      defectNote: '新崩口',
    })
    const repairing = (await db.blocks.get(inkBlock.id))!
    const beforeNodes = await db.nodes.where('blockId').equals(inkBlock.id).count()
    expect((await db.drafts.get('draft-liannian-youyu'))!.status).toBe('刻版中')

    // 让刻工在刻数更新这一步失败：此时修版节点已追加、版片已 put，
    // 事务必须整体回滚，不能留下「节点+状态已改、在刻数没动」的半套状态。
    const originalUpdate = db.carvers.update.bind(db.carvers)
    db.carvers.update = (() => {
      throw new Error('模拟刻工在刻数写入失败')
    }) as typeof db.carvers.update

    await expect(
      submitRepair({
        blockId: inkBlock.id,
        expectedRev: repairing.rev,
        repairNote: '应回滚',
        operator: repairCarver.name,
        durationMin: 10,
      }),
    ).rejects.toThrow('模拟刻工在刻数写入失败')
    db.carvers.update = originalUpdate

    const afterBlock = (await db.blocks.get(inkBlock.id))!
    expect(afterBlock.state).toBe('返修中')
    expect(afterBlock.rev).toBe(repairing.rev)
    expect(await db.nodes.where('blockId').equals(inkBlock.id).count()).toBe(beforeNodes)
    expect((await db.carvers.get(repairCarver.id))!.activeBlockIds).toContain(inkBlock.id)
    expect((await db.drafts.get('draft-liannian-youyu'))!.status).toBe('刻版中')
  })
})

describe('乐观锁冲突', () => {
  it('返修依据旧版本提交时看到冲突，且不覆盖前一次的版片与节点', async () => {
    const inkBlock = (await db.blocks.get('block-ll-03'))!
    const repairCarver = (await db.carvers.toArray()).find((c) => c.specialty === '修版')!

    // 标签页甲先提交：改崩口记录（rev +1）
    await saveBlockDefect({ blockId: inkBlock.id, expectedRev: inkBlock.rev, defectNote: '甲先记崩口' })
    const firstRev = inkBlock.rev + 1

    // 标签页乙仍拿旧 rev 提交返修 -> 冲突
    await expect(
      reopenForRepair({
        blockId: inkBlock.id,
        expectedRev: inkBlock.rev,
        repairCarverId: repairCarver.id,
        defectNote: '乙的返修说明',
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError)

    const after = (await db.blocks.get(inkBlock.id))!
    expect(after.rev).toBe(firstRev)
    expect(after.defectNote).toBe('甲先记崩口')
    expect(after.state).toBe('已刻成')
    expect((await db.carvers.get(repairCarver.id))!.activeBlockIds).not.toContain(inkBlock.id)

    // 乙按新版本重新提交 -> 成功
    const reopened = await reopenForRepair({
      blockId: inkBlock.id,
      expectedRev: firstRev,
      repairCarverId: repairCarver.id,
      defectNote: '乙的返修说明',
    })
    expect(reopened.state).toBe('返修中')
    expect(reopened.rev).toBe(firstRev + 1)

    // 同一返修中再用旧 rev 提交完成返修 -> 冲突，节点不被追加
    const nodeCountBefore = await db.nodes.where('blockId').equals(inkBlock.id).count()
    await expect(
      submitRepair({
        blockId: inkBlock.id,
        expectedRev: firstRev,
        repairNote: '乙旧版本完成',
        operator: repairCarver.name,
        durationMin: 5,
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError)
    expect(await db.nodes.where('blockId').equals(inkBlock.id).count()).toBe(nodeCountBefore)
  })

  it('批次登记时版片已被另一标签页改动则后提交者被拒', async () => {
    const blocks = await db.blocks.where('draftId').equals('draft-liannian-youyu').toArray()
    const staleRevs = Object.fromEntries(blocks.map((b) => [b.id, b.rev]))
    const inkBlock = blocks.find((b) => b.blockName === '墨线版')!

    await saveBlockDefect({ blockId: inkBlock.id, expectedRev: inkBlock.rev, defectNote: '他处改动' })
    const before = await db.batches.count()
    await expect(
      registerPrintBatch({
        draftId: 'draft-liannian-youyu',
        batchNo: '冲突批次',
        printedAt: '2026-10-07',
        paperBatch: 'p',
        inkNote: '',
        qty: 1,
        pieceCount: 4,
        qcNote: '',
        expectedRevs: staleRevs,
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError)
    expect(await db.batches.count()).toBe(before)
  })
})

describe('标刻成联动', () => {
  it('门神补齐刻成后画稿转可印', async () => {
    const target = (await db.blocks.where('draftId').equals('draft-menshen-qin').toArray()).sort(
      (a, b) => a.colorNo - b.colorNo,
    )
    // 01 已刻成、02 在刻、03/04 待刻
    for (const block of target.slice(1)) {
      const fresh = (await db.blocks.get(block.id))!
      await markBlockCarved({ blockId: block.id, expectedRev: fresh.rev })
    }
    expect((await db.drafts.get('draft-menshen-qin'))!.status).toBe('可印')
    // 每块都追加了刻版节点
    for (const block of target.slice(1)) {
      const nodes = await db.nodes.where('blockId').equals(block.id).toArray()
      expect(nodes.some((n) => n.stage === '刻版')).toBe(true)
    }
  })
})
