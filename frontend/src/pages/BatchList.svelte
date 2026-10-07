<script lang="ts">
  import { onMount } from 'svelte'
  import EmptyBox from '../components/common/EmptyBox.svelte'
  import { draftStore } from '../stores/draftStore'
  import { blockStore } from '../stores/blockStore'
  import { carverStore } from '../stores/carverStore'
  import { buildDeviationNote } from '../utils/seq'
  import { downloadJson } from '../utils/export'
  import { db } from '../utils/db'
  import {
    evaluateReadiness,
    registerPrintBatch,
    ReleaseBlockedError,
    RevisionConflictError,
  } from '../utils/printFlow'
  import { subscribeArchiveChanges } from '../utils/crossTab'
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
  let messageTone = $state<'warn' | 'info'>('warn')
  let submitting = $state(false)

  const selectedDraft = $derived($draftStore.find((draft) => draft.id === draftId) ?? null)
  const selectedBlocks = $derived(
    draftId ? [...$blockStore].filter((block) => block.draftId === draftId).sort((a, b) => a.colorNo - b.colorNo) : [],
  )
  // 放行结论始终按当前版片状态重算
  const readiness = $derived(evaluateReadiness(selectedBlocks))

  onMount(() => {
    void Promise.all([draftStore.load(), blockStore.load(), carverStore.load(), refreshBatches()])
    return subscribeArchiveChanges(() => {
      void Promise.all([blockStore.load(), refreshBatches()])
    })
  })

  async function refreshBatches(): Promise<void> {
    const records = await db.batches.toArray()
    records.sort((a, b) => b.printedAt.localeCompare(a.printedAt) || b.batchNo.localeCompare(a.batchNo, 'zh-CN'))
    batches = records
  }

  function openForm(): void {
    showForm = true
    formMessage = ''
    // 打表即取当前版片状态，放行结论不依据本标签页缓存
    void blockStore.load()
    if (!draftId) {
      const firstDraft = $draftStore[0]
      if (firstDraft) selectDraft(firstDraft.id)
    }
  }

  function selectDraft(nextId: string): void {
    draftId = nextId
    deviations = {}
    formMessage = ''
    const target = $draftStore.find((draft) => draft.id === nextId)
    if (target) batchNo = `${target.title}-${new Date().getFullYear()}-01`
  }

  function draftTitle(targetId: string): string {
    return $draftStore.find((draft) => draft.id === targetId)?.title ?? '未知画稿'
  }

  async function submitBatch(): Promise<void> {
    if (!draftId || !batchNo.trim() || !paperBatch.trim() || qty <= 0 || pieceCount <= 0) {
      messageTone = 'warn'
      formMessage = '请选择画稿，并补全批次号、纸张批号和印数。'
      return
    }
    if (!readiness.ready) {
      messageTone = 'warn'
      formMessage = `暂不能开印：${readiness.reasons.join('；')}`
      return
    }

    const deviationText = buildDeviationNote(
      selectedBlocks.map((block) => ({
        blockName: block.blockName,
        deviation: deviations[block.id] ?? '',
      })),
    )
    const mergedQcNote = qcNote.trim() ? `${qcNote.trim()}；${deviationText}` : deviationText
    // 表单依据的版片版本随提交带上，供事务内拦截后提交者
    const expectedRevs = Object.fromEntries(selectedBlocks.map((block) => [block.id, block.rev]))

    submitting = true
    try {
      await registerPrintBatch({
        draftId,
        batchNo: batchNo.trim(),
        printedAt,
        paperBatch: paperBatch.trim(),
        inkNote: inkNote.trim() || '颜料与胶量待续记',
        qty: Number(qty),
        pieceCount: Number(pieceCount),
        qcNote: mergedQcNote,
        expectedRevs,
      })
    } catch (error) {
      // 写入失败：事务已回滚，不留下半套状态；重读版片与批次后给出冲突/拦截提示。
      await Promise.all([blockStore.load(), refreshBatches()])
      submitting = false
      if (error instanceof RevisionConflictError) {
        messageTone = 'warn'
        formMessage = `版片档案冲突，本批次未保存：${error.message}`
      } else if (error instanceof ReleaseBlockedError) {
        messageTone = 'warn'
        formMessage = `放行未通过，本批次未保存：${error.message}`
      } else {
        messageTone = 'warn'
        formMessage = '批次保存失败，版片与批次档案均未改动，请重试。'
      }
      return
    }

    await refreshBatches()
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
    <p>登记纸张、颜料与每版印次，逐版留下套色偏差。</p>
  </div>
  <div class="heading-actions">
    <button class="button ghost" type="button" onclick={exportArchive}>导出 JSON</button>
    <button class="button primary" data-testid="new-batch" type="button" onclick={openForm}>新建批次</button>
  </div>
</div>

<section class="summary-strip four">
  <div><span>登记批次</span><strong data-testid="count-batch">{batches.length}</strong></div>
  <div><span>累计印数</span><strong>{batches.reduce((sum, batch) => sum + batch.qty, 0)}</strong></div>
  <div><span>覆盖画稿</span><strong>{new Set(batches.map((batch) => batch.draftId)).size}</strong></div>
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
      <div class="release-gate" class:blocked={!readiness.ready} data-testid="release-gate">
        <div class="section-title-row">
          <div>
            <span class="section-kicker">开印放行</span>
            <h3>{selectedDraft.title}当前版片状态</h3>
          </div>
          <span class="tag {readiness.ready ? 'tag-pass' : 'tag-block'}">{readiness.ready ? '可放行开印' : '禁止开印'}</span>
        </div>
        <ul class="basis-list">
          {#each readiness.blocks as block}
            <li class:blocked={!(block.state === '已刻成' || block.state === '已修版')}>
              <b>{block.colorNo}{block.blockName}</b>
              <span>{block.state} · v{block.rev}</span>
              <em>{block.defectNote || '无崩口记录'}</em>
            </li>
          {/each}
        </ul>
        {#if !readiness.ready}
          <p class="gate-reasons" data-testid="release-reasons">{readiness.reasons.join('；')}</p>
        {/if}
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
              <span><b>{block.colorNo}</b>{block.blockName}</span>
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

    {#if formMessage}<p class="form-message {messageTone === 'info' ? 'info' : ''}" data-testid="batch-form-message">{formMessage}</p>{/if}
    <div class="form-actions">
      <button class="button primary" data-testid="submit-batch" type="button" disabled={submitting || !readiness.ready} onclick={submitBatch}>
        {submitting ? '正在放行…' : '保存批次并放行开印'}
      </button>
      <button class="button ghost" type="button" onclick={() => (showForm = false)}>取消</button>
    </div>
  </section>
{/if}

{#if batches.length === 0}
  <EmptyBox
    title="尚无印制批次"
    message="版片刻成后即可逐版试印，登记纸张与套色偏差。"
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
          <span class="tag {batch.releaseStatus === '已放行' ? 'tag-pass' : 'tag-review'}" data-testid={`release-${batch.id}`}>
            {batch.releaseStatus}
          </span>
        </div>
        <div class="batch-counts">
          <div><span>总印数</span><strong>{batch.qty}</strong></div>
          <div><span>每版印次</span><strong>{batch.pieceCount}</strong></div>
        </div>
        <div class="batch-notes">
          <p><b>颜料胶量：</b>{batch.inkNote}</p>
          <p><b>套色检查：</b>{batch.qcNote}</p>
          <p class="release-basis"><b>放行依据：</b>{batch.releaseBasis}</p>
          {#if batch.releaseStatus === '已放行' && batch.blockSnapshots.length > 0}
            <ul class="snapshot-list">
              {#each batch.blockSnapshots as snapshot}
                <li>
                  <b>{snapshot.colorNo}{snapshot.blockName}</b>
                  <span>{snapshot.state} · v{snapshot.rev}</span>
                  <em>{snapshot.defectNote || '无崩口记录'}</em>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </article>
    {/each}
  </section>
{/if}

<style>
  .release-gate {
    border: 1px solid var(--line);
    border-left: 4px solid var(--jade);
    border-radius: 10px;
    padding: 0.9rem 1rem;
    margin: 0.4rem 0 1rem;
    background: #f4faf5;
  }

  .release-gate.blocked {
    border-left-color: var(--cinnabar);
    background: #fdf4f1;
  }

  .basis-list,
  .snapshot-list {
    list-style: none;
    margin: 0.6rem 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    gap: 0.5rem;
  }

  .basis-list li,
  .snapshot-list li {
    display: grid;
    gap: 0.15rem;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    font-size: 0.82rem;
  }

  .basis-list li.blocked {
    border-color: rgba(174, 52, 39, 0.45);
    background: #fdeeea;
  }

  .basis-list em,
  .snapshot-list em {
    color: var(--ink-muted);
    font-style: normal;
    font-size: 0.78rem;
  }

  .gate-reasons {
    margin: 0.6rem 0 0;
    color: var(--cinnabar);
    font-weight: 650;
    font-size: 0.86rem;
  }

  .tag-pass {
    color: #1f6b45;
    background: #ddf2e5;
    border: 1px solid #9bd4b2;
  }

  .tag-block {
    color: var(--cinnabar);
    background: #fde8e2;
    border: 1px solid #e7b4a6;
  }

  .tag-review {
    color: #8a5a16;
    background: #fbeed3;
    border: 1px solid #e4c78e;
  }

  .release-basis {
    color: var(--ink-muted);
    font-size: 0.82rem;
  }

  .snapshot-list {
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    margin-top: 0.4rem;
  }

  .form-message.info {
    color: #1f6b45;
  }
</style>
