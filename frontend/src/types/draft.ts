export type DraftGenre = '门神' | '灶王' | '戏出' | '娃娃'
export type DraftStatus = '起稿' | '分版中' | '刻版中' | '可印'

export interface Draft {
  id: string
  title: string
  genre: DraftGenre
  designer: string
  sizeCm: string
  paperNote: string
  status: DraftStatus
  /**
   * 可印结论版本号：四块版片 stateRev 之和。
   * 版片状态一变即重算；null 表示该画稿从未达到过开印条件。
   */
  printReadyRev: number | null
}
