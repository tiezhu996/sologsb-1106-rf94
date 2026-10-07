import type { BlockName, BlockState } from './block'

/** 放行结论：已放行（按登记当时版片快照）/ 待复核（历史批次没有登记依据） */
export type BatchReleaseStatus = '已放行' | '待复核'

/** 开印时四块版片逐块存档的依据 */
export interface BatchBlockSnapshot {
  blockId: string
  blockName: BlockName
  colorNo: number
  state: BlockState
  defectNote: string
  /** 快照所依据的版片版本号，事后可与版片当前版本比对 */
  rev: number
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
  /** 放行状态；旧批次迁移为「待复核」，不改印数与偏差 */
  releaseStatus: BatchReleaseStatus
  /** 放行时刻四块版片的状态与崩口记录；待复核批次为空 */
  blockSnapshots: BatchBlockSnapshot[]
  /** 放行判定文字，供「印制批次看不出当时依据」时回看 */
  releaseBasis: string
}
