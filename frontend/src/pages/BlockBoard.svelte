<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { get } from 'svelte/store'
  import { link, params } from 'svelte-spa-router'
  import ColorSwatch from '../components/common/ColorSwatch.svelte'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import SeqInput from '../components/common/SeqInput.svelte'
  import StageRail from '../components/common/StageRail.svelte'
  import { blockStore } from '../stores/blockStore'
  import { carverStore } from '../stores/carverStore'
  import { draftStore } from '../stores/draftStore'
  import { useBlockOrder } from '../hooks/useBlockOrder'
  import { useCarverLoad } from '../hooks/useCarverLoad'
  import { validateColorSequence } from '../utils/seq'
  import {
    markBlockCarved,
    reopenForRepair,
    submitRepair as submitRepairFlow,
    saveBlockDefect,
    ReleaseBlockedError,
    RevisionConflictError,
  } from '../utils/printFlow'
import type { Block } from '../types/block'
  import type { ProcessStage } from '../types/node'

  const draftId = $derived($params?.id ?? '')
  const {
    blocks: orderedBlocks,
    carvedRate: blockCarvedRate,
    reorder: reorderBlocks,
    setDraft: setBlockDraft,
  } = useBlockOrder(draftId)
  const { activeCount: selectedActiveCount, averageDuration: selectedAverageDuration, refresh: refreshCarverLoad } = useCarverLoad('')

  let sequenceDraft = $state<Record<string, number>>({})
  let defectDraft = $state<Record<string, string>>({})
  let selectedCarverId = $state('')
  let notice = $state('')
  let lastSync = $state('刚刚')
  let busyBlockId = $state('')
  let repairDraft = $state<Record<string, { operator: string; durationMin: number; note: string; carverId: string }>>({})
  let conflictBlockId = $state('')

  const draft = $derived($draftStore.find((item) => item.id === draftId) ?? null)

  onMount(() => {
    void Promise.all([draftStore.load(), blockStore.load(), carverStore.load()])
    // 另一标签页提交后，本页重新可见时先重取，避免按旧版本覆盖。
    document.addEventListener('visibilitychange', resyncWhenVisible)
    window.addEventListener('focus', resyncAll)
    return () => {
      document.removeEventListener('visibilitychange', resyncWhenVisible)
      window.removeEventListener('focus', resyncAll)
    }
  })

  function resyncWhenVisible(): void {
    if (document.visibilityState === 'visible') void resyncAll()
  }

  async function resyncAll(): Promise<void> {
    await Promise.all([draftStore.load(), blockStore.load(), carverStore.load()])
  }

  $effect(() => {
    setBlockDraft(draftId)
  })

  $effect(() => {
    for (const block of $orderedBlocks) {
      if (sequenceDraft[block.id] === undefined) sequenceDraft[block.id] = block.colorNo
      if (defectDraft[block.id] === undefined) defectDraft[block.id] = block.defectNote
    }
  })

  $effect(() => {
    const firstCarver = $carverStore[0]
    if (!selectedCarverId && firstCarver) {
      selectedCarverId = firstCarver.id
      void refreshCarverLoad(firstCarver.id)
    }
  })

  // 返修表单默认指派「修版」专长刻工
  $effect(() => {
    const repairCarver = $carverStore.find((item) => item.specialty === '修版') ?? $carverStore[0]
    for (const block of $orderedBlocks) {
      if (block.state !== '返修中') continue
      if (!repairDraft[block.id]) {
        repairDraft[block.id] = {
          operator: repairCarver?.name ?? '秦木生',
          durationMin: 60,
          note: block.defectNote,
          carverId: repairCarver?.id ?? '',
        }
      }
    }
  })

  function blockStateStage(state: Block['state']): number {
    if (state === '返修中') return 4
    if (state === '待刻' || state === '在刻') return 3
    return 4
  }

  function occupiedNumbers(exceptId: string): number[] {
    return $orderedBlocks.filter((block) => block.id !== exceptId).map((block) => block.colorNo)
  }

  async function assignCarver(block: Block, carverName: string): Promise<void> {
    const carver = $carverStore.find((item) => item.name === carverName)
    if (!carver) return
    await carverStore.assignBlock(block, carver.id)
    await blockStore.load()
    lastSync = `已把${block.blockName}指派给刻工`
  }

  async function markCarved(block: Block): Promise<void> {
    busyBlockId = block.id
    conflictBlockId = ''
    try {
      // 节点、版片状态、刻工在刻数与画稿可印结论同一事务提交，失败整笔回滚。
      await markBlockCarved({ blockId: block.id, expectedRev: block.rev })
    } catch (error) {
      await handleFlowError(block, error)
      return
    } finally {
      busyBlockId = ''
    }
    await resyncAll()
    lastSync = `${block.blockName}已标记刻成`
  }

  // 崩口返修退回：版片转「返修中」，修版刻工在刻数 +1，画稿可印结论立即失效重算。
  async function startRepair(block: Block): Promise<void> {
    const repairCarver = $carverStore.find((item) => item.specialty === '修版') ?? $carverStore[0]
    if (!repairCarver) {
      notice = '请先登记一名修版刻工。'
      return
    }
    busyBlockId = block.id
    conflictBlockId = ''
    try {
      await reopenForRepair({
        blockId: block.id,
        expectedRev: block.rev,
        repairCarverId: repairCarver.id,
        defectNote: defectDraft[block.id] ?? block.defectNote,
      })
    } catch (error) {
      await handleFlowError(block, error)
      return
    } finally {
      busyBlockId = ''
    }
    await resyncAll()
    lastSync = `${block.blockName}已退回返修`
  }

  // 返修提交：追加修版节点、版片转「已修版」、刻工在刻数 -1、重算可印结论。
  async function completeRepair(block: Block): Promise<void> {
    const form = repairDraft[block.id]
    if (!form) return
    if (!form.operator.trim()) {
      notice = '请填写修版操作人。'
      conflictBlockId = block.id
      return
    }
    busyBlockId = block.id
    conflictBlockId = ''
    try {
      await submitRepairFlow({
        blockId: block.id,
        expectedRev: block.rev,
        repairNote: form.note.trim() || '崩口返修完成，验版合格。',
        operator: form.operator.trim(),
        durationMin: Math.max(0, Number(form.durationMin) || 0),
      })
    } catch (error) {
      await handleFlowError(block, error)
      return
    } finally {
      busyBlockId = ''
    }
    await resyncAll()
    lastSync = `${block.blockName}返修验版完成`
  }

  // 写入失败：事务已恢复原状；重读后向后提交者亮冲突提示，不覆盖前一次记录。
  async function handleFlowError(block: Block, error: unknown): Promise<void> {
    await resyncAll()
    conflictBlockId = block.id
    if (error instanceof RevisionConflictError) {
      notice = `提交冲突：${block.blockName}已被另一处提交先行修改，本次操作未生效，请核对最新记录后重试。`
    } else if (error instanceof ReleaseBlockedError) {
      notice = error.message
    } else {
      notice = `${block.blockName}写入失败，状态已恢复原状，请重试。`
    }
  }

  async function saveSequence(block: Block): Promise<void> {
    const next = sequenceDraft[block.id] ?? block.colorNo
    const check = validateColorSequence([...occupiedNumbers(block.id), next])
    if (!check.valid) {
      notice = check.duplicates.length
        ? `色序 ${check.duplicates.join('、')} 已占用，请调换后再存。`
        : `当前色序有跳号，缺少 ${check.gaps.join('、')}。`
      return
    }

    await blockStore.update(block.id, { colorNo: next, rev: block.rev + 1 })
    notice = `${block.blockName}色序已改为 ${next}`
    lastSync = '套色序号已存档'
    await tick()
  }

  async function moveBlock(block: Block, direction: -1 | 1): Promise<void> {
    const ordered = [...$orderedBlocks]
    const index = ordered.findIndex((item) => item.id === block.id)
    const target = ordered[index + direction]
    if (index < 0 || !target) return

    const moved = [...ordered]
    moved[index] = target
    moved[index + direction] = block
    await reorderBlocks(moved.map((item, itemIndex) => ({ id: item.id, colorNo: itemIndex + 1 })))
    moved.forEach((item, itemIndex) => {
      sequenceDraft[item.id] = itemIndex + 1
    })
    lastSync = `${block.blockName}已${direction < 0 ? '前移' : '后移'}`
  }

  async function saveDefect(block: Block): Promise<void> {
    busyBlockId = block.id
    conflictBlockId = ''
    try {
      await saveBlockDefect({
        blockId: block.id,
        expectedRev: block.rev,
        defectNote: defectDraft[block.id] ?? '',
      })
    } catch (error) {
      await handleFlowError(block, error)
      return
    } finally {
      busyBlockId = ''
    }
    await blockStore.load()
    lastSync = `${block.blockName}崩口记录已更新`
  }

  async function returnToStage(_index: number, stage: ProcessStage): Promise<void> {
    const block = $orderedBlocks[0]
    if (!block) return
    if (stage === '刻版' || stage === '修版') {
      const nextState = stage === '修版' ? '已修版' : '在刻'
      await blockStore.update(block.id, { state: nextState, rev: block.rev + 1 })
      // 版片状态一变，画稿可印结论失效重算
      const currentBlocks = get(blockStore).filter((item) => item.draftId === draftId)
      const ready = currentBlocks.every((item) => item.state === '已刻成' || item.state === '已修版')
      await draftStore.update(draftId, { status: ready ? '可印' : '刻版中' })
      lastSync = `已将首块版片阶段调至${stage}`
    }
  }

  function chooseCarver(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement
    selectedCarverId = select.value
    void refreshCarverLoad(select.value)
  }
</script>

<svelte:head>
  <title>版片编排台 · 木版年画刻版工序档案</title>
</svelte:head>

{#if !draft}
  <div class="page-heading">
    <div><p class="eyebrow">画稿与分版</p><h1>版片编排台</h1><p>正在读取画稿与版片档案。</p></div>
  </div>
  <EmptyBox title="未找到这张画稿" message="画稿可能尚未载入或档案编号有误。" />
  <a class="button secondary" use:link href="/drafts">返回画稿总览</a>
{:else}
  <div class="page-heading">
    <div>
      <p class="eyebrow">{draft.genre} · {draft.designer}</p>
      <h1>{draft.title}版片编排台</h1>
      <p>{draft.sizeCm} · 按套色序号依次刻制，先墨线后套色。</p>
    </div>
    <a class="button ghost" use:link href="/drafts">返回画稿总览</a>
  </div>

  <section class="summary-strip four">
    <div><span>版片总数</span><strong>{$orderedBlocks.length}</strong></div>
    <div><span>刻成率</span><strong>{$blockCarvedRate}%</strong></div>
    <div><span>在刻版片</span><strong>{$orderedBlocks.filter((block) => block.state === '在刻').length}</strong></div>
    <div><span>返修中</span><strong data-testid="count-repairing">{$orderedBlocks.filter((block) => block.state === '返修中').length}</strong></div>
  </section>

  {#if notice}
    <p class="notice banner" data-testid="board-notice">{notice}</p>
  {/if}

  <div class="workbench-grid">
    <section class="panel table-panel wide-panel">
      <div class="panel-heading">
        <div>
          <span class="section-kicker">套色序列</span>
          <h2>版片刻制编排</h2>
        </div>
        <span class="sync-note">{lastSync}</span>
      </div>

      {#if $orderedBlocks.length === 0}
        <EmptyBox title="尚未分版" message="先回画稿总览建立画稿，系统会生成四块基础版片。" />
      {:else}
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>色序</th>
                <th>版片</th>
                <th>木料 / 版厚</th>
                <th>刻工指派</th>
                <th>状态</th>
                <th>崩口与修补</th>
              </tr>
            </thead>
            <tbody>
              {#each $orderedBlocks as block, blockIndex (block.id)}
                <tr data-testid="row-block">
                  <td class="sequence-cell">
                    {#if sequenceDraft[block.id] !== undefined}
                      <SeqInput
                        bind:value={sequenceDraft[block.id]}
                        existing={occupiedNumbers(block.id)}
                        label="序号"
                        testid={`field-colorNo-${block.id}`}
                      />
                    {/if}
                    <button class="mini-button" type="button" onclick={() => saveSequence(block)}>存序号</button>
                    <div class="order-buttons">
                      <button type="button" disabled={blockIndex === 0} onclick={() => moveBlock(block, -1)}>上移</button>
                      <button type="button" disabled={blockIndex === $orderedBlocks.length - 1} onclick={() => moveBlock(block, 1)}>下移</button>
                    </div>
                  </td>
                  <td>
                    <ColorSwatch colorNo={block.colorNo} blockName={block.blockName} />
                  </td>
                  <td>
                    <strong>{block.woodType}</strong>
                    <small>{block.thicknessMm} mm</small>
                  </td>
                  <td>
                    <select
                      data-testid={`field-carvedBy-${block.id}`}
                      value={block.carvedBy}
                      onchange={(event) => assignCarver(block, (event.currentTarget as HTMLSelectElement).value)}
                    >
                      <option value="">待指派</option>
                      {#each $carverStore as carver}
                        <option value={carver.name}>{carver.name} · {carver.specialty}</option>
                      {/each}
                    </select>
                  </td>
                  <td>
                    <span class="tag state-{block.state}" data-testid={`state-${block.id}`}>{block.state}</span>
                    <small class="rev-mark">v{block.rev}</small>
                    <div class="state-actions">
                      {#if block.state === '待刻' || block.state === '在刻'}
                        <button
                          class="mini-button strong"
                          type="button"
                          disabled={busyBlockId === block.id}
                          data-testid={`mark-carved-${block.id}`}
                          onclick={() => markCarved(block)}
                        >标刻成</button>
                      {/if}
                      {#if block.state === '已刻成' || block.state === '已修版'}
                        <button
                          class="mini-button warn"
                          type="button"
                          disabled={busyBlockId === block.id}
                          data-testid={`start-repair-${block.id}`}
                          onclick={() => startRepair(block)}
                        >崩口返修</button>
                      {/if}
                    </div>
                    {#if conflictBlockId === block.id}
                      <p class="conflict-tip" data-testid={`conflict-${block.id}`}>与另一处提交冲突，请核对上方最新状态后重试。</p>
                    {/if}
                  </td>
                  <td>
                    <textarea
                      data-testid={`field-defectNote-${block.id}`}
                      rows="2"
                      bind:value={defectDraft[block.id]}
                      placeholder="崩口、补线或嵌木说明"
                    ></textarea>
                    <button class="mini-button" type="button" disabled={busyBlockId === block.id} onclick={() => saveDefect(block)}>存记录</button>
                    {#if block.state === '返修中' && repairDraft[block.id]}
                      <div class="repair-form" data-testid={`repair-form-${block.id}`}>
                        <label>
                          <span>修版人</span>
                          <input
                            data-testid={`repair-operator-${block.id}`}
                            bind:value={repairDraft[block.id]!.operator}
                            placeholder="修版刻工"
                          />
                        </label>
                        <label>
                          <span>耗时（分）</span>
                          <input
                            type="number"
                            min="0"
                            data-testid={`repair-duration-${block.id}`}
                            bind:value={repairDraft[block.id]!.durationMin}
                          />
                        </label>
                        <label class="wide">
                          <span>修版记录</span>
                          <textarea
                            rows="2"
                            data-testid={`repair-note-${block.id}`}
                            bind:value={repairDraft[block.id]!.note}
                            placeholder="嵌补、压平与试印情况"
                          ></textarea>
                        </label>
                        <button
                          class="mini-button strong"
                          type="button"
                          disabled={busyBlockId === block.id}
                          data-testid={`complete-repair-${block.id}`}
                          onclick={() => completeRepair(block)}
                        >{busyBlockId === block.id ? '提交中…' : '提交返修放行'}</button>
                      </div>
                    {/if}
                  </td>
                </tr>
                <tr class="stage-row">
                  <td colspan="6">
                    <StageRail
                      activeIndex={blockStateStage(block.state)}
                      completedCount={
                        block.state === '已刻成' || block.state === '已修版'
                          ? 5
                          : block.state === '返修中'
                            ? 4
                            : block.state === '在刻'
                              ? 3
                              : 1
                      }
                      compact={true}
                      onselect={block.id === $orderedBlocks[0]?.id ? returnToStage : undefined}
                    />
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <aside class="panel side-panel">
      <div class="panel-heading">
        <div>
          <span class="section-kicker">当班安排</span>
          <h2>刻工负荷</h2>
        </div>
      </div>
      <label class="stacked-field">
        <span>选择刻工</span>
        <select value={selectedCarverId} onchange={chooseCarver}>
          {#each $carverStore as carver}<option value={carver.id}>{carver.name} · {carver.skillLevel}</option>{/each}
        </select>
      </label>
      <div class="load-card">
        <span>当前在刻</span>
        <strong>{$selectedActiveCount}</strong>
        <small>版片</small>
      </div>
      <div class="load-card muted">
        <span>节点平均耗时</span>
        <strong>{$selectedAverageDuration}</strong>
        <small>分钟</small>
      </div>
      {#if notice}<p class="notice">{notice}</p>{/if}
      <a class="button secondary full" use:link href="/carvers">查看刻工档与分布</a>
    </aside>
  </div>
{/if}

<style>
  .rev-mark {
    color: var(--ink-muted);
    font-size: 0.72rem;
  }

  .state-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.35rem;
  }

  .mini-button.warn {
    color: var(--cinnabar);
    border-color: rgba(174, 52, 39, 0.5);
  }

  .state-返修中 {
    color: var(--cinnabar);
    background: #fde8e2;
    border: 1px solid #e7b4a6;
  }

  .repair-form {
    margin-top: 0.5rem;
    padding: 0.6rem;
    border: 1px dashed rgba(174, 52, 39, 0.55);
    border-radius: 8px;
    background: #fdf6f4;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.45rem;
  }

  .repair-form .wide {
    grid-column: 1 / -1;
  }

  .repair-form label {
    display: grid;
    gap: 0.2rem;
    font-size: 0.78rem;
  }

  .conflict-tip {
    margin: 0.35rem 0 0;
    color: var(--cinnabar);
    font-size: 0.76rem;
    font-weight: 650;
  }

  .notice.banner {
    margin: 0.6rem 0;
    padding: 0.55rem 0.8rem;
    border-radius: 8px;
    background: #fbeed3;
    color: #8a5a16;
    border: 1px solid #e4c78e;
  }
</style>
