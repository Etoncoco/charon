// Isolated browser fixtures: live Codex transport is tested separately on a VPS.
import Database from 'better-sqlite3';

export async function smokeAsyncQuestions({ page, open, dbPath, assertAsync }) {
  const db = new Database(dbPath);
  const sid = 'smoke-async-questions';
  const now = Math.floor(Date.now() / 1000);
  const vpsId = db.prepare('SELECT vps_id FROM claude_sessions LIMIT 1').get().vps_id;
  db.prepare(`INSERT INTO claude_sessions (id,vps_id,cwd,name,status,kind,permission_mode)
    VALUES (?,?,?,'async question smoke','active','codex','read-only')`).run(sid, vpsId, '/tmp');
  const questions = [{ question: 'Which colour?', options: [{ label: 'Orange' }, { label: 'Purple' }] },
    { question: 'Anything else?', options: [] }];
  const insert = db.prepare(`INSERT INTO claude_session_messages (session_id,role,content,created_at,ts_ms)
    VALUES (?,?,?,?,?)`);
  const form = (id, at) => {
    db.prepare(`INSERT INTO claude_pending_questions (id,session_id,kind,payload,status,created_at)
      VALUES (?,?,'async_question',?,'pending',?)`).run(id, sid, JSON.stringify(questions), at);
    insert.run(sid, 'async_question', JSON.stringify({ id, questions }), at, at * 1000);
  };
  form('smoke-old-question', now - 1000);
  for (let i = 0; i < 205; i++) insert.run(sid, 'assistant', `Independent work ${i}`, now - 900 + i, (now - 900 + i) * 1000);
  form('smoke-new-question', now - 500);
  let attempts = 0;
  let failNext = true;
  const errors = [];
  const onError = (e) => errors.push(e.message);
  page.on('pageerror', onError);
  await page.route(`**/api/claude/sessions/${sid}/question`, async (route) => {
    attempts++;
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated delivery failure' }) });
      return;
    }
    const { id, answers } = route.request().postDataJSON();
    db.prepare('UPDATE claude_pending_questions SET status=?,answers=?,responded_at=? WHERE id=? AND session_id=?')
      .run(answers ? 'answered' : 'cancelled', JSON.stringify(answers), now, id, sid);
    insert.run(sid, 'event', JSON.stringify({ type: 'interaction_resolved', kind: 'question', id,
      outcome: answers ? 'answered' : 'cancelled', answers }), now, Date.now());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  try {
    await open(`/?session=${sid}`);
    const newForm = page.locator('[data-question-id="smoke-new-question"]');
    const oldForm = page.locator('[data-question-id="smoke-old-question"]');
    const shortcut = page.getByRole('button', { name: /Pending questions/ });
    await assertAsync('ASYNC: transcript form leaves composer usable and remains pending after reload', async () => {
      await newForm.waitFor();
      await page.locator('.claude-input-bar textarea').waitFor();
      if (await page.locator('.claude-pending-zone').count()) throw new Error('async form replaced composer');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await newForm.waitFor();
      await shortcut.waitFor();
      if (!((await shortcut.innerText()).includes('2'))) throw new Error('pending count lost');
    });
    await assertAsync('ASYNC: shortcut loads older pages, scrolls and focuses oldest unanswered form', async () => {
      if (await oldForm.count()) throw new Error('old form should be outside initial history page');
      await shortcut.click();
      await oldForm.waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-question-id') === 'smoke-old-question');
      const visible = await oldForm.evaluate((el) => {
        const box = el.getBoundingClientRect(), chat = el.closest('.claude-chat').getBoundingClientRect();
        return box.top >= chat.top && box.top < chat.bottom;
      });
      if (!visible) throw new Error('shortcut did not reveal form');
    });
    await assertAsync('ASYNC: free answer overrides choices; failed validation retains form and selections', async () => {
      const submit = oldForm.getByRole('button', { name: 'validate answers' });
      if (!(await submit.isDisabled())) throw new Error('incomplete form enabled');
      await oldForm.getByRole('button', { name: 'Orange', exact: false }).click();
      await oldForm.locator('textarea').nth(0).fill('Custom orange, with a comma');
      await oldForm.locator('textarea').nth(1).fill('Keep working independently');
      await submit.click();
      await oldForm.getByRole('alert').waitFor();
      if ((await oldForm.locator('textarea').first().inputValue()) !== 'Custom orange, with a comma') throw new Error('draft lost');
      if (await oldForm.locator('.is-resolved').count()) throw new Error('failed response marked resolved');
      await submit.click();
      await oldForm.locator('.uq-state').filter({ hasText: 'answered' }).waitFor();
      if (!(await oldForm.innerText()).includes('Custom orange, with a comma')) throw new Error('answer missing');
      if (attempts !== 2) throw new Error('unexpected validation count');
    });
    await assertAsync('ASYNC: mobile choices validate once, retain answers and remove pending shortcut', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await shortcut.click();
      await newForm.getByRole('button', { name: 'Purple', exact: false }).click();
      await newForm.locator('textarea').nth(1).fill('Mobile answer');
      await newForm.getByRole('button', { name: 'validate answers' }).click();
      await newForm.locator('.uq-state').filter({ hasText: 'answered' }).waitFor();
      await shortcut.waitFor({ state: 'detached' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await newForm.locator('.uq-state').filter({ hasText: 'answered' }).waitFor();
      if (await newForm.locator('button').count()) throw new Error('resolved form still editable');
      if (!(await newForm.innerText()).includes('Mobile answer')) throw new Error('answer lost on reload');
    });
    await assertAsync('ASYNC: resolved forms hydrate across history pages without browser exceptions', async () => {
      // Reload may paint the already-paginated browser cache immediately.
      if (!(await oldForm.count())) {
        await page.locator('.claude-chat').evaluate((el) => { el.scrollTop = -el.scrollHeight; });
      }
      await oldForm.locator('.uq-state').filter({ hasText: 'answered' }).waitFor();
      if (!(await oldForm.innerText()).includes('Custom orange, with a comma')) throw new Error('old answer not hydrated');
      if (errors.length) throw new Error(errors.join('; '));
    });
  } finally {
    page.off('pageerror', onError);
    await page.unroute(`**/api/claude/sessions/${sid}/question`);
    db.close();
  }
}
