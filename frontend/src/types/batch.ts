import type { BlockName, BlockState } from './block'

/** 放行结论：新批次按当前版片状态放行，旧批次一律先挂待复核。 */
export type BatchReleaseState = '待复核' | '已放行'

/** 登记批次那一刻冻结下来的单块版片依据（状态与崩口记录）。 */
export interface BatchBlockSnapshot {
  blockId: string
  blockName: BlockName
  colorNo: number
  state: BlockState
  defectNote: string
  /** 取自当时版片的 stateRev，返修后比对用，避免把旧依据当成现况。 */
  stateRev: number
}

export interface PrintBatch {
  id: string
  draftId: string
  batchNo: string
  printedAt: string
  paperBatch: string
  inkNote: string
  qty: number
  pieceCount: number
  qcNote: string
  /** 放行结论。版本 3 之前的旧批次没有快照，统一标待复核。 */
  releaseState: BatchReleaseState
  /** 登记时四块版片的当前状态与崩口记录；旧批次缺省表示当时未留存依据。 */
  blockSnapshots?: BatchBlockSnapshot[]
  /** 登记时画稿可印结论的版本号，等于当时四块版片 stateRev 之和。 */
  gateRev?: number
}
