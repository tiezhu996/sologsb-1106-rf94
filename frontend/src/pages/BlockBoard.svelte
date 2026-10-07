<script lang="ts">
  import { onMount, tick } from 'svelte'
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
  import { evaluatePrintGate, RepairConflictError } from '../utils/printGate'
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
  let noticeKind = $state<'info' | 'error'>('info')
  let lastSync = $state('刚刚')
  let repairOpen = $state<Record<string, boolean>>({})
  let repairOperator = $state<Record<string, string>>({})
  let repairDuration = $state<Record<string, number>>({})
  let repairNote = $state<Record<string, string>>({})
  let repairBusy = $state<Record<string, boolean>>({})

  const draft = $derived($draftStore.find((item) => item.id === draftId) ?? null)
  // 开印闸口始终按当前版片状态重算，不采信画稿上一次留下的“可印”字样。
  const gate = $derived(evaluatePrintGate(draftId, [...$blockStore]))

  onMount(() => {
    void Promise.all([draftStore.load(), blockStore.load(), carverStore.load()])
  })

  $effect(() => {
    setBlockDraft(draftId)
  })

  $effect(() => {
    for (const block of $orderedBlocks) {
      if (sequenceDraft[block.id] === undefined) sequenceDraft[block.id] = block.colorNo
      if (defectDraft[block.id] === undefined) defectDraft[block.id] = block.defectNote
      if (repairOperator[block.id] === undefined) repairOperator[block.id] = block.carvedBy
      if (repairDuration[block.id] === undefined) repairDuration[block.id] = 60
    }
  })

  $effect(() => {
    const firstCarver = $carverStore[0]
    if (!selectedCarverId && firstCarver) {
      selectedCarverId = firstCarver.id
      void refreshCarverLoad(firstCarver.id)
    }
  })

  function showNotice(message: string, kind: 'info' | 'error' = 'info'): void {
    notice = message
    noticeKind = kind
  }

  function blockStateStage(state: Block['state']): number {
    if (state === '待刻' || state === '在刻') return 3
    return 4
  }

  function occupiedNumbers(exceptId: string): number[] {
    return $orderedBlocks.filter((block) => block.id !== exceptId).map((block) => block.colorNo)
  }

  async function refreshAllStores(): Promise<void> {
    await Promise.all([blockStore.load(), carverStore.load(), draftStore.load()])
  }

  async function assignCarver(block: Block, carverName: string): Promise<void> {
    const carver = $carverStore.find((item) => item.name === carverName)
    if (!carver) return
    await carverStore.assignBlock(block, carver.id)
    await refreshAllStores()
    lastSync = `已把${block.blockName}指派给刻工`
  }

  async function markCarved(block: Block): Promise<void> {
    await blockStore.markCarved(block.id)
    await refreshAllStores()
    lastSync = `${block.blockName}已标记刻成`
    showNotice(`${block.blockName}已刻成，刻版节点已追加，可印结论按当前版片重算。`)
  }

  async function saveSequence(block: Block): Promise<void> {
    const next = sequenceDraft[block.id] ?? block.colorNo
    const check = validateColorSequence([...occupiedNumbers(block.id), next])
    if (!check.valid) {
      showNotice(
        check.duplicates.length
          ? `色序 ${check.duplicates.join('、')} 已占用，请调换后再存。`
          : `当前色序有跳号，缺少 ${check.gaps.join('、')}。`,
        'error',
      )
      return
    }

    await blockStore.update(block.id, { colorNo: next })
    showNotice(`${block.blockName}色序已改为 ${next}`)
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
    await blockStore.update(block.id, { defectNote: defectDraft[block.id] ?? '' })
    lastSync = `${block.blockName}崩口记录已更新`
    showNotice(`${block.blockName}崩口记录已存档；正式返修请走“返修放行”。`)
  }

  function toggleRepair(block: Block): void {
    repairOpen[block.id] = !repairOpen[block.id]
    if (repairOpen[block.id]) {
      repairOperator[block.id] = block.carvedBy
      repairDuration[block.id] = repairDuration[block.id] ?? 60
      repairNote[block.id] = repairNote[block.id] ?? ''
      showNotice('')
    }
  }

  async function submitRepair(block: Block): Promise<void> {
    const operator = (repairOperator[block.id] ?? '').trim()
    const note = (repairNote[block.id] ?? '').trim()
    if (!operator) {
      showNotice(`请填写${block.blockName}的修版操作人。`, 'error')
      return
    }
    if (!note) {
      showNotice(`请补记${block.blockName}的崩口位置与修法。`, 'error')
      return
    }

    repairBusy[block.id] = true
    try {
      // expectedRev 取当前档案所见版本；另一标签页先提交时事务内会判冲突并整体回滚。
      await blockStore.submitRepair({
        blockId: block.id,
        expectedRev: block.stateRev,
        operator,
        durationMin: Math.max(0, Number(repairDuration[block.id] ?? 0)),
        note,
        defectNote: (defectDraft[block.id] ?? block.defectNote).trim(),
      })
    } catch (error) {
      await refreshAllStores()
      if (error instanceof RepairConflictError) {
        showNotice(`返修被拦下：${error.message}`, 'error')
      } else {
        showNotice('返修写入失败，版片、节点与刻工在刻数已恢复原状，未留下半套状态。', 'error')
      }
      repairBusy[block.id] = false
      return
    }

    await refreshAllStores()
    repairBusy[block.id] = false
    repairOpen[block.id] = false
    repairNote[block.id] = ''
    lastSync = `${block.blockName}返修放行`
    showNotice(`${block.blockName}已修版放行：修版节点、崩口记录与刻工在刻数一并写定，可印结论已重算。`)
  }

  async function returnToStage(_index: number, stage: ProcessStage): Promise<void> {
    const block = $orderedBlocks[0]
    if (!block) return
    if (stage === '刻版') {
      await blockStore.rollbackState(block.id, '在刻')
      await refreshAllStores()
      lastSync = `已将首块版片阶段调至${stage}`
    } else if (stage === '修版') {
      await blockStore.rollbackState(block.id, '已修版')
      await refreshAllStores()
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

  <section class="panel gate-panel" class:gate-closed={!gate.ready} data-testid="print-gate">
    <div>
      <span class="section-kicker">开印闸口</span>
      <h2>{gate.ready ? '四块版片齐备，可放行开印' : '版片未齐，暂不得开印'}</h2>
      {#if gate.ready}
        <p>墨线、黄、红、绿四块版片均已刻成或已修版，新批次登记将按当前状态（结论版次 {gate.gateRev}）放行。</p>
      {:else}
        <p>
          已完工 {gate.finished}/{gate.total} 块
          {#if gate.pendingNames.length > 0}；待完工：{gate.pendingNames.join('、')}{/if}
          。版片状态一变，画稿可印结论立即失效重算。
        </p>
      {/if}
    </div>
    <span class="tag status-{gate.ready ? 3 : 2}" data-testid="print-gate-state">{gate.ready ? '可印' : '不可印'}</span>
  </section>

  <section class="summary-strip four">
    <div><span>版片总数</span><strong>{$orderedBlocks.length}</strong></div>
    <div><span>刻成率</span><strong>{$blockCarvedRate}%</strong></div>
    <div><span>在刻版片</span><strong>{$orderedBlocks.filter((block) => block.state === '在刻').length}</strong></div>
    <div><span>需修版片</span><strong>{$orderedBlocks.filter((block) => block.defectNote).length}</strong></div>
  </section>

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
                    <span class="tag state-{block.state}">{block.state}</span>
                    <small class="rev-note">版次 v{block.stateRev}</small>
                    {#if block.state !== '已刻成' && block.state !== '已修版'}
                      <button class="mini-button strong" type="button" onclick={() => markCarved(block)}>标刻成</button>
                    {/if}
                    <button
                      class="mini-button"
                      type="button"
                      data-testid={`open-repair-${block.id}`}
                      onclick={() => toggleRepair(block)}
                    >
                      {repairOpen[block.id] ? '收起返修' : '返修放行'}
                    </button>
                  </td>
                  <td>
                    <textarea
                      data-testid={`field-defectNote-${block.id}`}
                      rows="2"
                      bind:value={defectDraft[block.id]}
                      placeholder="崩口、补线或嵌木说明"
                    ></textarea>
                    <button class="mini-button" type="button" onclick={() => saveDefect(block)}>存记录</button>
                  </td>
                </tr>
                {#if repairOpen[block.id]}
                  <tr class="repair-row" data-testid={`repair-panel-${block.id}`}>
                    <td colspan="6">
                      <div class="repair-grid">
                        <label>
                          <span>修版操作人</span>
                          <input data-testid={`field-repair-operator-${block.id}`} bind:value={repairOperator[block.id]} placeholder="负责返修的刻工" />
                        </label>
                        <label>
                          <span>修版耗时（分钟）</span>
                          <input data-testid={`field-repair-duration-${block.id}`} type="number" min="0" bind:value={repairDuration[block.id]} />
                        </label>
                        <label class="wide">
                          <span>崩口位置与修法</span>
                          <textarea
                            data-testid={`field-repair-note-${block.id}`}
                            rows="2"
                            bind:value={repairNote[block.id]}
                            placeholder="如：甲胄外侧崩口长约半寸，嵌梨木后顺线修平"
                          ></textarea>
                        </label>
                      </div>
                      <div class="repair-actions">
                        <button
                          class="button primary"
                          type="button"
                          data-testid={`submit-repair-${block.id}`}
                          disabled={repairBusy[block.id]}
                          onclick={() => submitRepair(block)}
                        >
                          {repairBusy[block.id] ? '提交中…' : `提交返修并放行${block.blockName}`}
                        </button>
                        <span class="rev-note">按当前版次 v{block.stateRev} 校验；别处先改过会提示冲突</span>
                      </div>
                    </td>
                  </tr>
                {/if}
                <tr class="stage-row">
                  <td colspan="6">
                    <StageRail
                      activeIndex={blockStateStage(block.state)}
                      completedCount={block.state === '已刻成' || block.state === '已修版' ? 5 : block.state === '在刻' ? 3 : 1}
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
          {#each $carverStore as carver}<option value={carver.id}>{carver.name} · {carver.specialty}</option>{/each}
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
      {#if notice}
        <p class="notice" class:notice-error={noticeKind === 'error'} data-testid="repair-feedback" data-kind={noticeKind}>{notice}</p>
      {/if}
      <a class="button secondary full" use:link href="/carvers">查看刻工档与分布</a>
    </aside>
  </div>
{/if}

<style>
  .gate-panel {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.2rem;
    margin-bottom: 1.5rem;
    border-color: rgba(47, 118, 88, 0.45);
    background:
      radial-gradient(circle at 0 0, rgba(47, 118, 88, 0.08), transparent 12rem),
      rgba(255, 250, 240, 0.96);
  }

  .gate-panel.gate-closed {
    border-color: rgba(169, 52, 39, 0.4);
    background:
      radial-gradient(circle at 0 0, rgba(169, 52, 39, 0.07), transparent 12rem),
      rgba(255, 250, 240, 0.96);
  }

  .gate-panel h2 {
    margin: 0.25rem 0;
  }

  .gate-panel p {
    margin: 0;
    color: var(--ink-muted);
    font-size: 0.84rem;
    line-height: 1.6;
  }

  .gate-panel .tag {
    flex: none;
    padding: 0.4rem 0.8rem;
  }

  .rev-note {
    display: block;
    margin-top: 0.32rem;
    color: var(--ink-muted);
    font-size: 0.7rem;
  }

  .repair-row td {
    background: var(--paper-deep);
    padding: 0.9rem 1.1rem;
  }

  .repair-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.8rem;
  }

  .repair-grid label {
    display: grid;
    gap: 0.35rem;
  }

  .repair-grid span {
    color: var(--ink-soft);
    font-size: 0.78rem;
    font-weight: 800;
  }

  .repair-actions {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    margin-top: 0.8rem;
  }

  .notice-error {
    border-left-color: var(--cinnabar);
  }
</style>
