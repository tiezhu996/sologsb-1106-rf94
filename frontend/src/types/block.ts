export type BlockName = '墨线版' | '黄版' | '红版' | '绿版'
export type WoodType = '梨木' | '黄杨'
// 「返修中」= 崩口已返修、尚未验版，期间画稿不得开印
export type BlockState = '待刻' | '在刻' | '已刻成' | '返修中' | '已修版'

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
  /** 乐观锁版本：任何一次返修/改状态/崩口记录写入都会自增 */
  rev: number
}
