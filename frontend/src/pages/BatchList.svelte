<script lang="ts">
  import { onMount } from 'svelte'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import { draftStore } from '../stores/draftStore'
  import { blockStore } from '../stores/blockStore'
  import { batchStore } from '../stores/batchStore'
  import { buildDeviationNote } from '../utils/seq'
  import { downloadJson } from '../utils/export'
  import { db } from '../utils/db'
  import { evaluatePrintGate, GateBlockedError } from '../utils/printGate'
  import type { PrintBatch } from '../types/batch'

  let batches = $state<PrintBatch[]>([])
  let showForm = $state(false)
  let draftId = $state('')
  let batchNo = $state('')
  let printedAt = $state(new Date().toISOString().slice(0, 10))
  let paperBatch = $state('')
  let inkNote = $state('')
  let qty = $state(100)
  let pieceCount = $state(4)
  let qcNote = $state('')
  let deviations = $state<Record<string, string>>({})
  let formMessage = $state('')
  let formError = $state(false)
  let submitting = $state(false)

  const selectedDraft = $derived($draftStore.find((draft) => draft.id === draftId) ?? null)
  const selectedBlocks = $derived(
    draftId ? [...$blockStore].filter((block) => block.draftId === draftId).sort((a, b) => a.colorNo - b.colorNo) : [],
  )
  // 开印闸口始终按当前版片状态重算，不看画稿标签或旧批次。
  const gate = $derived(draftId ? evaluatePrintGate(draftId, [...$blockStore]) : null)

  onMount(() => {
    void Promise.all([draftStore.load(), blockStore.load(), refreshBatches()])
  })

  async function refreshBatches(): Promise<void> {
    batches = await db.batches.toArray()
    batches.sort((a, b) => b.printedAt.localeCompare(a.printedAt) || b.batchNo.localeCompare(a.batchNo, 'zh-CN'))
  }

  function openForm(): void {
    showForm = true
    formMessage = ''
    formError = false
    if (!draftId) {
      const firstDraft = $draftStore[0]
      if (firstDraft) selectDraft(firstDraft.id)
    }
  }

  function selectDraft(nextId: string): void {
    draftId = nextId
    deviations = {}
    formMessage = ''
    formError = false
    const target = $draftStore.find((draft) => draft.id === nextId)
    if (target) batchNo = `${target.title}-${new Date().getFullYear()}-01`
  }

  function draftTitle(targetId: string): string {
    return $draftStore.find((draft) => draft.id === targetId)?.title ?? '未知画稿'
  }

  function snapshotSummary(batch: PrintBatch): string {
    if (!batch.blockSnapshots || batch.blockSnapshots.length === 0) {
      return '旧批次：登记时未留存四块版片状态与崩口记录，需人工复核后再放行。'
    }
    return batch.blockSnapshots
      .map((snapshot) => `${snapshot.blockName}·${snapshot.state}${snapshot.defectNote ? '（有崩口记录）' : ''}`)
      .join('；')
  }

  async function submitBatch(): Promise<void> {
    formError = false
    if (!draftId || !batchNo.trim() || !paperBatch.trim() || qty <= 0 || pieceCount <= 0) {
      formMessage = '请选择画稿，并补全批次号、纸张批号和印数。'
      formError = true
      return
    }
    if (!gate || !gate.ready) {
      formMessage =
        gate && gate.pendingNames.length > 0
          ? `开印被拦下：${gate.pendingNames.join('、')}尚未刻成，四块版片全部刻成或修版后才允许开印。`
          : '开印被拦下：四块版片未齐备。'
      formError = true
      return
    }

    const deviationText = buildDeviationNote(
      selectedBlocks.map((block) => ({
        blockName: block.blockName,
        deviation: deviations[block.id] ?? '',
      })),
    )

    submitting = true
    try {
      // 事务内会重新读版片并复核闸口；任一环节失败都整体回滚，不留半套状态。
      await batchStore.register({
        draftId,
        batchNo: batchNo.trim(),
        printedAt,
        paperBatch: paperBatch.trim(),
        inkNote: inkNote.trim() || '颜料与胶量待续记',
        qty: Number(qty),
        pieceCount: Number(pieceCount),
        qcNote: qcNote.trim() ? `${qcNote.trim()}；${deviationText}` : deviationText,
      })
    } catch (error) {
      await Promise.all([refreshBatches(), blockStore.load(), draftStore.load()])
      if (error instanceof GateBlockedError) {
        formMessage = `开印被拦下：${error.message}`
      } else {
        formMessage = '批次写入失败，本笔登记已整体撤销，未留下半套状态，请重试。'
      }
      formError = true
      submitting = false
      return
    }

    await Promise.all([refreshBatches(), draftStore.load()])
    submitting = false
    showForm = false
    batchNo = ''
    paperBatch = ''
    inkNote = ''
    qty = 100
    pieceCount = 4
    qcNote = ''
    deviations = {}
    formMessage = ''
  }

  async function exportArchive(): Promise<void> {
    const [drafts, blocks, carvers, nodes] = await Promise.all([
      db.drafts.toArray(),
      db.blocks.toArray(),
      db.carvers.toArray(),
      db.nodes.toArray(),
    ])
    downloadJson('木版年画工序档案.json', { exportedAt: new Date().toISOString(), drafts, blocks, batches, carvers, nodes })
  }
</script>

<svelte:head>
  <title>印制批次登记 · 木版年画刻版工序档案</title>
</svelte:head>

<div class="page-heading">
  <div>
    <p class="eyebrow">套色印制留档</p>
    <h1>印制批次登记</h1>
    <p>登记纸张、颜料与每版印次，逐版留下套色偏差；只有四块版片刻成或修版后才放行开印。</p>
  </div>
  <div class="heading-actions">
    <button class="button ghost" type="button" onclick={exportArchive}>导出 JSON</button>
    <button class="button primary" data-testid="new-batch" type="button" onclick={openForm}>新建批次</button>
  </div>
</div>

<section class="summary-strip four">
  <div><span>登记批次</span><strong data-testid="count-batch">{batches.length}</strong></div>
  <div><span>已放行批次</span><strong>{batches.filter((batch) => batch.releaseState === '已放行').length}</strong></div>
  <div><span>待复核批次</span><strong>{batches.filter((batch) => batch.releaseState === '待复核').length}</strong></div>
  <div><span>在册画稿</span><strong>{$draftStore.length}</strong></div>
</section>

{#if showForm}
  <section class="panel form-panel" data-testid="form-batch">
    <div class="panel-heading">
      <div>
        <span class="section-kicker">新印批</span>
        <h2>登记纸张与套色检查</h2>
      </div>
      <button class="text-button" type="button" onclick={() => (showForm = false)}>收起</button>
    </div>

    <div class="form-grid three">
      <label>
        <span>所属画稿</span>
        <select data-testid="field-draftId" value={draftId} onchange={(event) => selectDraft((event.currentTarget as HTMLSelectElement).value)}>
          <option value="">请选择</option>
          {#each $draftStore as draft}<option value={draft.id}>{draft.title} · {draft.genre}</option>{/each}
        </select>
      </label>
      <label>
        <span>批次号</span>
        <input data-testid="field-batchNo" bind:value={batchNo} />
      </label>
      <label>
        <span>印制日期</span>
        <input data-testid="field-printedAt" type="date" bind:value={printedAt} />
      </label>
      <label>
        <span>纸张批号</span>
        <input data-testid="field-paperBatch" bind:value={paperBatch} placeholder="如：泾县-2605" />
      </label>
      <label>
        <span>总印数</span>
        <input data-testid="field-qty" type="number" min="1" bind:value={qty} />
      </label>
      <label>
        <span>每版印次</span>
        <input data-testid="field-pieceCount" type="number" min="1" bind:value={pieceCount} />
      </label>
      <label class="wide">
        <span>颜料与胶量</span>
        <textarea data-testid="field-inkNote" rows="2" bind:value={inkNote} placeholder="分色记录颜料、胶量与稀稠"></textarea>
      </label>
    </div>

    {#if selectedDraft}
      <div class="gate-card" class:gate-ok={gate?.ready} data-testid="form-gate">
        <div>
          <strong>{gate?.ready ? '开印闸口通过' : '开印闸口未通过'}</strong>
          <p>
            四块版片完工 {gate?.finished ?? 0}/{gate?.total ?? 0}
            {#if gate && !gate.ready && gate.pendingNames.length > 0}
              ，未完工：{gate.pendingNames.join('、')}
            {/if}
            ；本批将按登记当时的版片状态与崩口记录留存依据。
          </p>
        </div>
        <span class="tag status-{gate?.ready ? 3 : 2}">{gate?.ready ? '允许开印' : '禁止开印'}</span>
      </div>

      <div class="deviation-block">
        <div class="section-title-row">
          <div>
            <span class="section-kicker">逐版检查</span>
            <h3>{selectedDraft.title}套色偏差</h3>
          </div>
          <span>{selectedBlocks.length} 块版片</span>
        </div>
        <div class="deviation-grid">
          {#each selectedBlocks as block}
            <label>
              <span>
                <b>{block.colorNo}</b>{block.blockName}
                <em class="mini-state state-{block.state}">{block.state} · v{block.stateRev}</em>
              </span>
              <input
                data-testid={`field-deviation-${block.id}`}
                value={deviations[block.id] ?? ''}
                oninput={(event) => (deviations[block.id] = (event.currentTarget as HTMLInputElement).value)}
                placeholder="如：右下角偏红线半根"
              />
            </label>
          {/each}
        </div>
      </div>
    {/if}

    <label class="stacked-field">
      <span>总检说明</span>
      <textarea data-testid="field-qcNote" rows="2" bind:value={qcNote} placeholder="走版、纸面洇墨与整体套准情况"></textarea>
    </label>

    {#if formMessage}
      <p class="form-message" class:form-error={formError} data-testid="batch-feedback">{formMessage}</p>
    {/if}
    <div class="form-actions">
      <button
        class="button primary"
        data-testid="submit-batch"
        type="button"
        disabled={submitting || !gate?.ready}
        onclick={submitBatch}
      >
        {submitting ? '登记中…' : gate?.ready ? '保存批次并放行' : '四块未齐，禁止开印'}
      </button>
      <button class="button ghost" type="button" onclick={() => (showForm = false)}>取消</button>
    </div>
  </section>
{/if}

{#if batches.length === 0}
  <EmptyBox
    title="尚无印制批次"
    message="四块版片刻成或修版后即可登记首批；新批次按当前版片状态放行。"
    actionLabel="新建批次"
    onaction={openForm}
  />
{:else}
  <section class="batch-list">
    {#each batches as batch (batch.id)}
      <article class="panel batch-item" data-testid="row-batch">
        <div class="batch-number">
          <span>{batch.printedAt.replace(/-/g, '.')}</span>
          <h2>{batch.batchNo}</h2>
          <p>{draftTitle(batch.draftId)} · {batch.paperBatch}</p>
          <span class="tag release-tag {batch.releaseState === '已放行' ? 'status-3' : 'status-1'}" data-testid={`release-${batch.id}`}>
            {batch.releaseState === '已放行' ? '已放行' : '待复核'}
          </span>
        </div>
        <div class="batch-counts">
          <div><span>总印数</span><strong>{batch.qty}</strong></div>
          <div><span>每版印次</span><strong>{batch.pieceCount}</strong></div>
        </div>
        <div class="batch-notes">
          <p><b>颜料胶量：</b>{batch.inkNote}</p>
          <p><b>套色检查：</b>{batch.qcNote}</p>
          <p class="snapshot-note" data-testid={`snapshot-${batch.id}`}><b>放行依据：</b>{snapshotSummary(batch)}</p>
        </div>
      </article>
    {/each}
  </section>
{/if}

<style>
  .gate-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-top: 1.2rem;
    padding: 0.9rem 1.1rem;
    border: 1px solid rgba(169, 52, 39, 0.4);
    border-radius: var(--radius-md);
    background: rgba(169, 52, 39, 0.06);
  }

  .gate-card.gate-ok {
    border-color: rgba(47, 118, 88, 0.45);
    background: rgba(47, 118, 88, 0.07);
  }

  .gate-card p {
    margin: 0.3rem 0 0;
    color: var(--ink-muted);
    font-size: 0.82rem;
    line-height: 1.6;
  }

  .gate-card .tag {
    flex: none;
    padding: 0.4rem 0.8rem;
  }

  .mini-state {
    margin-left: 0.35rem;
    padding: 0.1rem 0.42rem;
    border-radius: 999px;
    background: var(--paper-deep);
    font-size: 0.66rem;
    font-style: normal;
    font-weight: 800;
  }

  .form-error {
    border-left-color: var(--cinnabar);
    color: var(--cinnabar-dark);
  }

  .release-tag {
    margin-top: 0.45rem;
  }

  .snapshot-note {
    color: var(--ink-soft);
  }
</style>
