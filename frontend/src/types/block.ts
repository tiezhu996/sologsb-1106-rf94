export type BlockName = '墨线版' | '黄版' | '红版' | '绿版'
export type WoodType = '梨木' | '黄杨'
export type BlockState = '待刻' | '在刻' | '已刻成' | '已修版'

export interface Block {
  id: string
  draftId: string
  blockName: BlockName
  colorNo: number
  woodType: WoodType
  thicknessMm: number
  carvedBy: string
  state: BlockState
  defectNote: string
  /**
   * 版片状态版本号：每次状态流转（开刻、刻成、返修放行）递增。
   * 修版提交时做乐观并发校验，两个标签页同时返修时后提交者会收到冲突提示。
   */
  stateRev: number
}
